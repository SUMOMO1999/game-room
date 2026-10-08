import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasLab, createExperimentServer, deterministicTrace, runIdentityBurstProbe, LIMITS } from '../tools/draw-and-guess-step0/transport-experiment.mjs';
import { EncryptedStore, SQLiteAdapter, recordKey } from '../server/storage.mjs';

const operation=(points=3)=>({strokeId:'stroke-1',tool:'pen',color:'#245c7c',width:4,points:deterministicTrace(0,points)});
const base={deviceId:'device-a',leaseGeneration:1,clearGeneration:0,expectedSequence:0,requestId:'first',operations:[operation()]};
async function labFixture(t,options={}) {const lab=await createCanvasLab(options);t.after(()=>lab.close());await lab.acquire('drawer',{deviceId:'device-a'});return lab;}
const rejectsCode=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('Step 0 SQLite WAL commit precedes ack; exact replay does not append twice',async t=>{
  const lab=await labFixture(t),result=await lab.edit('drawer',base),inspect=lab.inspect();
  assert.equal(result.ack.persisted,true);assert.equal(result.ack.sequence,1);
  const other=new EncryptedStore(new SQLiteAdapter(inspect.path),inspect.storage.key);
  try {const stored=await other.read('lab-draw-canvas','lab-room');assert.equal(stored.value.sequence,1);assert.equal(stored.value.strokes[0].points.length,3);} finally {other.close();}
  assert.equal((await lab.edit('drawer',base)).duplicate,true);assert.equal((await lab.read()).pointCount,3);
  assert.equal(lab.metrics().journalMode,'wal');
});

test('sequence gaps and changed request fingerprints do not mutate persisted canvas',async t=>{
  const lab=await labFixture(t);await rejectsCode(lab.edit('drawer',{...base,expectedSequence:1}),'LAB_SEQUENCE_GAP');
  await lab.edit('drawer',base);await rejectsCode(lab.edit('drawer',{...base,operations:[operation(4)]}),'LAB_REQUEST_REUSED');
  assert.equal((await lab.read()).pointCount,3);
});

test('clear fences delayed old batches; replay may only return the historical receipt',async t=>{
  const lab=await labFixture(t);await lab.edit('drawer',base);
  await lab.edit('drawer',{...base,requestId:'clear',expectedSequence:1},'clear');
  await rejectsCode(lab.edit('drawer',{...base,requestId:'late',expectedSequence:2}),'LAB_STALE_CLEAR');
  assert.equal((await lab.edit('drawer',base)).duplicate,true);
  assert.equal((await lab.read()).pointCount,0);assert.equal((await lab.read()).clearGeneration,1);
});

test('undo/redo are committed mutations; a new stroke removes redo history',async t=>{
  const lab=await labFixture(t);await lab.edit('drawer',base);
  await lab.edit('drawer',{...base,requestId:'undo',expectedSequence:1},'undo');assert.equal((await lab.read()).pointCount,0);
  await lab.edit('drawer',{...base,requestId:'redo',expectedSequence:2},'redo');assert.equal((await lab.read()).pointCount,3);
  await lab.edit('drawer',{...base,requestId:'undo-2',expectedSequence:3},'undo');
  await lab.edit('drawer',{...base,requestId:'fresh',expectedSequence:4,operations:[{...operation(),strokeId:'fresh-stroke'}]});
  await lab.edit('drawer',{...base,requestId:'redo-2',expectedSequence:5},'redo');assert.equal((await lab.read()).strokes.length,1);
});

test('device takeover rotates a persistent generation and rejects old device',async t=>{
  const lab=await labFixture(t);const acquired=await lab.acquire('drawer',{deviceId:'device-b'});assert.equal(acquired.leaseGeneration,2);
  await rejectsCode(lab.edit('drawer',base),'LAB_STALE_WRITER');
  await lab.edit('drawer',{...base,deviceId:'device-b',leaseGeneration:2});assert.equal((await lab.read()).pointCount,3);
});

test('restart recovers confirmed strokes but invalidates every old ephemeral writer lease',async t=>{
  const lab=await labFixture(t);await lab.edit('drawer',base);await lab.restart();
  assert.equal((await lab.read()).pointCount,3);
  await rejectsCode(lab.edit('drawer',{...base,requestId:'after-restart',expectedSequence:1}),'LAB_STALE_WRITER');
  const acquired=await lab.acquire('drawer',{deviceId:'device-a'});assert.equal(acquired.leaseGeneration,2);
  await lab.edit('drawer',{...base,leaseGeneration:2,requestId:'confirmed-after-restart',expectedSequence:1});
  assert.equal((await lab.read()).pointCount,6);
});

test('stage deadline equality, pause and reveal each prohibit old drawing writes',async t=>{
  let now=1800000000000;const lab=await labFixture(t,{now:()=>now,stageDurationMs:1000});
  now+=1000;await rejectsCode(lab.edit('drawer',base),'LAB_STAGE_CLOSED');
  now-=500;await lab.control({room:{paused:true}});await rejectsCode(lab.edit('drawer',base),'LAB_STAGE_CLOSED');
  await lab.control({room:{paused:false,stage:'reveal'}});await rejectsCode(lab.edit('drawer',base),'LAB_STAGE_CLOSED');
  assert.equal((await lab.read()).pointCount,0);
});

for(const [name,scope,id] of [['room','lab-draw-room','lab-room'],['presence','lab-draw-presence','drawer'],['writer','lab-draw-lease','lab-room'],['canvas','lab-draw-canvas','lab-room']]) {
  test(`SQLite transaction rejects ${name} version changed through a second connection after preparation`,async t=>{
    let conflict=false;const lab=await labFixture(t,{beforeTransaction:({storage,adapter})=>{
      if(!conflict)return;conflict=false;
      const second=new SQLiteAdapter(adapter.path);
      try {second.db.prepare('UPDATE game_records SET revision=? WHERE key=?').run('another-transaction',recordKey(scope,id));} finally {second.close();}
    }});
    conflict=true;await rejectsCode(lab.edit('drawer',base),'LAB_TRANSACTION_CONFLICT');
    assert.equal((await lab.read()).pointCount,0);assert.equal(lab.metrics().conflicts,1);
  });
}

test('transaction rolls back all canvas and lease writes if deadline crosses before COMMIT',async t=>{
  let now=1800000000000,expire=false;const lab=await labFixture(t,{now:()=>now,stageDurationMs:1000,beforeCommit:()=>{if(expire)now+=1000;}});
  expire=true;await rejectsCode(lab.edit('drawer',base),'LAB_TRANSACTION_CONFLICT');
  const saved=await lab.inspect().storage.read('lab-draw-canvas','lab-room');assert.equal(saved.value.sequence,0);assert.equal(saved.value.strokes.length,0);
});

test('bounded input rejects 257 points, malformed coordinates, and non-drawer writes',async t=>{
  const lab=await labFixture(t);
  await rejectsCode(lab.edit('drawer',{...base,operations:[operation(LIMITS.batchPoints+1)]}),'LAB_BATCH_LIMIT');
  await rejectsCode(lab.edit('drawer',{...base,operations:[{...operation(),points:[[2,0]]}]}),'LAB_BAD_OPERATION');
  await rejectsCode(lab.edit('guesser-1',base),'LAB_DRAWER_REQUIRED');assert.equal((await lab.read()).pointCount,0);
});

test('consistent isolated SQLite copy recovers confirmed state with key; not production backup compatibility',async t=>{
  const lab=await labFixture(t);await lab.edit('drawer',base);const backup=await lab.backup();
  assert.equal(backup.sequence,1);assert.equal(backup.pointCount,3);assert.ok(backup.bytes>0);
});

test('real HTTP/SSE delivers delta only after durable commit and checks every private delivery',async t=>{
  const system=await createExperimentServer({watchdogMs:0}),controller=new AbortController();
  t.after(async()=>{controller.abort();await system.close();});
  const post=async(path,body,user='drawer')=>{const response=await fetch(`${system.origin}/lab/${path}?labUser=${user}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  const response=await fetch(`${system.origin}/lab/events?labUser=spectator-1`,{signal:controller.signal}),reader=response.body.getReader();
  let carry='';const next=async type=>{const until=Date.now()+3000;while(Date.now()<until){let index;while((index=carry.indexOf('\n\n'))!==-1){const frame=carry.slice(0,index);carry=carry.slice(index+2);if(frame.startsWith(`event: ${type}\n`))return JSON.parse(frame.slice(frame.indexOf('data: ')+6));}const value=await reader.read();assert.equal(value.done,false);carry+=new TextDecoder().decode(value.value);}throw new Error('Timed out waiting for SSE');};
  const initial=await next('snapshot');assert.equal(initial.pointCount,0);assert.equal(initial.prototype,true);
  const acquired=await post('acquire',{deviceId:'device-a'}),replacement=await next('canvas');
  assert.equal(acquired.value.bootId,initial.bootId);assert.equal(replacement.bootId,initial.bootId);
  const ack=await post('append',base);assert.equal(ack.status,200);
  const delta=await next('canvas');assert.equal(delta.kind,'append');assert.equal(delta.operations[0].points.length,3);
  const snapshot=await system.lab.read();assert.equal(snapshot.sequence,delta.sequence);
  assert.equal(snapshot.bootId,initial.bootId);assert.equal(delta.bootId,initial.bootId);assert.equal(ack.value.ack.bootId,initial.bootId);
  assert.equal(system.lab.metrics().identityByPurpose['sse-delivery'],4);
  assert.equal(system.lab.metrics().identityByPurpose['http-pre'],3);
  assert.equal(system.lab.metrics().identityByPurpose['http-output'],2);
  const duplicate=await post('append',base);assert.equal(duplicate.value.duplicate,true);assert.equal(duplicate.value.ack.bootId,initial.bootId);
  assert.equal((await post('append',{...base,requestId:'illegal'},'spectator-1')).status,403);
});

test('HTTP rate limits retain 120/user/minute and 240/IP/minute; synthetic identity is not cached',async t=>{
  const system=await createExperimentServer({watchdogMs:0});t.after(()=>system.close());
  for(let i=0;i<120;i++){const response=await fetch(`${system.origin}/lab/read?labUser=drawer`);assert.equal(response.status,200);await response.arrayBuffer();}
  let response=await fetch(`${system.origin}/lab/read?labUser=drawer`);assert.equal(response.status,429);await response.arrayBuffer();
  for(let i=0;i<120;i++){response=await fetch(`${system.origin}/lab/read?labUser=guesser-1`);assert.equal(response.status,i===119?429:200);await response.arrayBuffer();}
  assert.equal(system.lab.metrics().identityChecks,478);
});

test('bounded SSE queue closes slow consumers instead of retaining an unbounded private packet backlog',async t=>{
  const system=await createExperimentServer({watchdogMs:0,identityDelayMs:2,queueEvents:2}),controller=new AbortController();
  t.after(async()=>{controller.abort();await system.close();});
  const response=await fetch(`${system.origin}/lab/events?labUser=guesser-1`,{signal:controller.signal});
  const reader=response.body.getReader();await reader.read();await new Promise(resolve=>setTimeout(resolve,8));
  await Promise.all(Array.from({length:6},(_,sequence)=>system.lab.publish('canvas',{kind:'append',sequence,operations:[]})));
  assert.ok(system.lab.metrics().backpressureDisconnects>=1);
});

test('fresh synthetic revocation rejects private HTTP output and never exposes a canvas response',async t=>{
  const system=await createExperimentServer({watchdogMs:0});t.after(()=>system.close());
  await system.lab.control({revoke:'guesser-1'});
  const response=await fetch(`${system.origin}/lab/read?labUser=guesser-1`);assert.equal(response.status,401);
  const value=await response.json();assert.equal('strokes' in value,false);
});

test('large committed snapshot emits bounded recovery hint; an authenticated read restores complete points',async t=>{
  const system=await createExperimentServer({watchdogMs:0,eventMode:'snapshot',queueBytes:1024}),controller=new AbortController();
  t.after(async()=>{controller.abort();await system.close();});
  const response=await fetch(`${system.origin}/lab/events?labUser=spectator-1`,{signal:controller.signal}),reader=response.body.getReader();
  await reader.read();await system.lab.acquire('drawer',{deviceId:'device-a'});
  await system.lab.edit('drawer',{...base,operations:[operation(128)]});
  let carry='';for(let i=0;i<4&&!carry.includes('event: recovery');i++){const value=await reader.read();assert.equal(value.done,false);carry+=new TextDecoder().decode(value.value);}
  assert.match(carry,/event: recovery/);assert.equal(system.lab.metrics().backpressureDisconnects,0);assert.ok(system.lab.metrics().maxQueuedBytes<=1024);
  const recoveryFrame=carry.split('\n\n').find(frame=>frame.startsWith('event: recovery'));
  const hint=JSON.parse(recoveryFrame.slice(recoveryFrame.indexOf('data: ')+6));
  const recovered=await fetch(`${system.origin}/lab/read?labUser=spectator-1`),snapshot=await recovered.json();
  assert.equal(snapshot.pointCount,128);assert.equal(hint.bootId,snapshot.bootId);assert.equal(snapshot.bootId,system.lab.inspect().bootId);
});

test('401 after a committed mutation is an unknown result requiring read-only reconciliation',async t=>{
  let revoke=false,system;system=await createExperimentServer({watchdogMs:0,beforeCommit:()=>{if(revoke)void system.lab.control({revoke:'drawer'});}});
  t.after(()=>system.close());await system.lab.acquire('drawer',{deviceId:'device-a'});revoke=true;
  const response=await fetch(`${system.origin}/lab/append?labUser=drawer`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(base)});
  assert.equal(response.status,401);assert.equal((await response.json()).error,'LAB_IDENTITY_REJECTED');
  const read=await fetch(`${system.origin}/lab/read?labUser=guesser-1`);assert.equal((await read.json()).pointCount,3);
});

test('unchanged E3 client keeps exact-token in-flight merging but cannot serve a 16-person burst under 500ms',async()=>{
  const probe=await runIdentityBurstProbe();assert.equal(probe.logicalChecks,32);assert.equal(probe.ok+probe.unavailable,32);
  assert.ok(probe.actualSyntheticUpstreamSends>16);assert.ok(probe.authorizationP95Ms>500);assert.equal(probe.positiveSuccessCache,false);
});

test('actual SQLite writer lock fails closed without ack or partial canvas update',async t=>{
  const lab=await labFixture(t),inspect=lab.inspect(),second=new SQLiteAdapter(inspect.path);
  inspect.adapter.db.exec('PRAGMA busy_timeout=1');second.db.exec('BEGIN IMMEDIATE');
  try {await assert.rejects(lab.edit('drawer',base),/locked/);}
  finally {second.db.exec('ROLLBACK');second.close();}
  assert.equal((await lab.read()).pointCount,0);assert.equal((await lab.read()).sequence,0);
});

test('laboratory instance bootId is a UUID stable across adapter restart while private writer boot rotates',async t=>{
  const lab=await labFixture(t),before=await lab.read(),privateWriterBoot=lab.inspect().boot;
  assert.match(before.bootId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const appended=await lab.edit('drawer',base);assert.equal(appended.ack.bootId,before.bootId);
  await lab.restart();const after=await lab.read();assert.equal(after.bootId,before.bootId);assert.equal(after.pointCount,3);
  assert.notEqual(lab.inspect().boot,privateWriterBoot);
  const acquired=await lab.acquire('drawer',{deviceId:'device-a'});assert.equal(acquired.bootId,before.bootId);
});

test('new laboratory creation gets a different bootId even when fresh sequence/lease/clear are lower',async t=>{
  const previous=await labFixture(t);await previous.edit('drawer',base);
  const oldSnapshot=await previous.read(),fresh=await createCanvasLab();t.after(()=>fresh.close());
  const newSnapshot=await fresh.read();assert.notEqual(newSnapshot.bootId,oldSnapshot.bootId);
  assert.equal(oldSnapshot.sequence,1);assert.equal(newSnapshot.sequence,0);
  assert.equal(newSnapshot.leaseGeneration,0);assert.equal(newSnapshot.clearGeneration,0);
  const acquired=await fresh.acquire('drawer',{deviceId:'device-a'});assert.equal(acquired.bootId,newSnapshot.bootId);
});
