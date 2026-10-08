import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RoomError } from './rooms.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, recordKey } from '../server/storage.mjs';
import { CANVAS_SCOPE, CANVAS_QUOTA_ID, createCanvasService, canvasIdFor, validateCanvasRecord, validateCanvasCollection } from '../server/games/draw-and-guess/canvas-service.mjs';

const roomId='a'.repeat(32),matchId='b'.repeat(32),drawer='c'.repeat(32),guesser='d'.repeat(32),spectator='e'.repeat(32);
const owner='1'.repeat(64),guest='2'.repeat(64),viewer='3'.repeat(64),auth={authorizationId:'session-a'};
const reject=(promise,code)=>assert.rejects(promise,error=>error.code===code);
const deferred=()=>{let resolve;const promise=new Promise(accept=>{resolve=accept;});return {promise,resolve};};
const stroke=(n=3,strokeId='stroke-1')=>({strokeId,tool:'pen',color:'#245c7c',width:4,points:Array.from({length:n},(_,i)=>[(i%101)/100,(i%97)/100])});
const body=(lease,extra={})=>({deviceId:'device-a',canvasId:lease.canvasId,bootId:lease.bootId,leaseGeneration:lease.leaseGeneration,clearGeneration:0,expectedSequence:0,requestId:'first',operations:[stroke()],...extra});
async function acquire(canvas,code,userKey,input,trusted=auth) {const snapshot=await canvas.read(code,userKey);return canvas.acquire(code,userKey,{...input,canvasId:snapshot.canvasId,bootId:snapshot.bootId},trusted);}
function trustedRooms(store,now) {
  return {async getGameContext(code,userKey) {
    const id=code==='654321'?'f'.repeat(32):roomId,record=await store.read('rooms',id),presence=await store.read('room-presence',id);
    const snapshot=record?.value.snapshot,member=presence?.value.members[userKey];
    if(!snapshot)throw new RoomError(404,'ROOM_NOT_FOUND','失效');
    if(!member)throw new RoomError(403,'ROOM_MEMBER_REQUIRED','已离开');
    const game=snapshot.game;
    return {roomId:id,seatId:member.seatId,role:member.role,roomRecord:{version:record.version,expiresAt:record.expiresAt},
      roomGuard:{scope:'rooms',id,expectedVersion:record.version},presenceGuard:{scope:'room-presence',id,expectedVersion:presence.version,validUntil:snapshot.expiresAt},
      matchId:snapshot.matchId??null,turnId:game?.turnId??null,phase:game?.stage??snapshot.phase,roomPhase:snapshot.phase,
      drawerSeatId:game?.turnPlayerId??null,deadline:game?.stageClock?.deadlineAt??null,paused:snapshot.phase==='paused',expiresAt:snapshot.expiresAt};
  }};
}
async function fixture(t,kind='SQLite',options={}) {
  let time=1000;const now=()=>time,key=randomBytes(32),folder=mkdtempSync(join(tmpdir(),'canvas-service-')),path=join(folder,'records.sqlite');
  const stores=[],services=[];
  function open() {const store=new EncryptedStore(kind==='SQLite'?new SQLiteAdapter(path,{now}):new MemoryAdapter({now}),key,now);stores.push(store);return store;}
  const storage=open(),rooms=trustedRooms(storage,now);
  async function addRoom(id=roomId) {
    await storage.put('rooms',id,{snapshot:{roomId:id,matchId,phase:'playing',game:{turnId:'dg-turn-1',stage:'drawing',turnPlayerId:drawer,stageClock:{deadlineAt:601000}},
      lastActiveAt:1000,expiresAt:10001000,privateAnswer:'不可发出',frozenCandidates:['不可发出']}});
    await storage.put('room-presence',id,{members:{[owner]:{seatId:drawer,role:'player'},[guest]:{seatId:guesser,role:'player'},[viewer]:{seatId:spectator,role:'spectator'}}});
  }
  await addRoom();
  function service(store=storage,extra={}) {const value=createCanvasService({storage:store,rooms:trustedRooms(store,now),now,...options,...extra});services.push(value);return value;}
  const canvas=service();
  t.after(async()=>{for(const value of services)await value.close();for(const value of stores)try{value.close();}catch{}rmSync(folder,{recursive:true,force:true});});
  async function editRoom(change,id=roomId) {const record=await storage.read('rooms',id);change(record.value.snapshot);await storage.replaceCAS('rooms',id,record.version,record.value);}
  async function seed(value) {
    validateCanvasRecord(value);await storage.put(CANVAS_SCOPE,value.canvasId,value);
    const entries={};for(const record of await storage.scan(CANVAS_SCOPE))if(record.value.kind==='canvas')entries[record.value.canvasId]={roomId:record.value.roomId,matchId:record.value.matchId,turnId:record.value.turnId,bytes:Buffer.byteLength(JSON.stringify(record.value))};
    await storage.put(CANVAS_SCOPE,CANVAS_QUOTA_ID,{schemaVersion:1,kind:'quota',entries,totalBytes:Object.values(entries).reduce((n,e)=>n+e.bytes,0)});
  }
  return {storage,canvas,rooms,now,key,path,open,service,addRoom,editRoom,seed,setTime(value){time=value;}};
}

for(const kind of ['Memory','SQLite']) {
  test(`${kind}: quota await keeps the validated canvas private from caller input and earlier loaded records`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    await f.canvas.append('123456',owner,body(lease),auth);
    const prior=await f.canvas.read('123456',owner),input=body(lease,{requestId:'private-next',expectedSequence:1,operations:[stroke(2)]});
    const expectedPoints=[...structuredClone(prior.strokes[0].points),...structuredClone(input.operations[0].points)];
    const read=f.storage.read.bind(f.storage),entered=deferred(),release=deferred();let loaded,armed=true;
    f.storage.read=async(scope,id)=>{
      const record=await read(scope,id);
      if(armed&&scope===CANVAS_SCOPE&&id===lease.canvasId)loaded=record;
      if(armed&&scope===CANVAS_SCOPE&&id===CANVAS_QUOTA_ID){armed=false;entered.resolve();await release.promise;}
      return record;
    };
    const work=f.canvas.append('123456',owner,input,auth);
    try {
      await entered.promise;assert.ok(loaded);
      input.operations[0].points[0][0]=2;loaded.value.strokes[0].points[0][0]=2;prior.strokes[0].points[0][0]=2;
      release.resolve();const receipt=await work;
      assert.equal(receipt.ack.persisted,true);assert.equal(receipt.ack.sequence,2);
      const saved=await f.storage.get(CANVAS_SCOPE,lease.canvasId);
      assert.deepEqual(saved.strokes[0].points,expectedPoints);validateCanvasRecord(saved);
      const quota=await f.storage.get(CANVAS_SCOPE,CANVAS_QUOTA_ID);
      assert.equal(quota.entries[lease.canvasId].bytes,Buffer.byteLength(JSON.stringify(saved)));
      validateCanvasCollection((await f.storage.scan(CANVAS_SCOPE)).map(record=>record.value));
    } finally {release.resolve();await work.catch(()=>{});f.storage.read=read;}
  });

  test(`${kind}: durable commit precedes public ack and each watcher delivery`,async t=>{
    const f=await fixture(t,kind),events=[];
    await f.canvas.watch('123456',guest,async packet=>{
      events.push(packet);if(packet.kind==='append')assert.equal((await f.storage.get(CANVAS_SCOPE,packet.canvasId)).sequence,packet.sequence);
    });
    const lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),receipt=await f.canvas.append('123456',owner,body(lease),auth);
    assert.equal(receipt.ack.persisted,true);assert.equal(receipt.ack.bootId,lease.bootId);assert.equal(receipt.ack.leaseValidUntil,16000);
    assert.equal((await f.canvas.read('123456',viewer)).pointCount,3);assert.equal(events.at(-1).kind,'append');
    assert.equal(JSON.stringify(events).includes('不可发出'),false);assert.equal((await f.storage.get('rooms',roomId)).snapshot.lastActiveAt,1000);
    validateCanvasCollection((await f.storage.scan(CANVAS_SCOPE)).map(record=>record.value));
  });

  test(`${kind}: sequence, exact request replay, changed fingerprint and clear fence are durable`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),first=body(lease);
    await reject(f.canvas.append('123456',owner,{...first,expectedSequence:1},auth),'CANVAS_SEQUENCE_GAP');
    await f.canvas.append('123456',owner,first,auth);assert.equal((await f.canvas.append('123456',owner,first,auth)).duplicate,true);
    await reject(f.canvas.append('123456',owner,{...first,operations:[stroke(4)]},auth),'CANVAS_REQUEST_REUSED');
    const {operations,...clear}=body(lease,{requestId:'clear',expectedSequence:1});await f.canvas.clear('123456',owner,clear,auth);
    await reject(f.canvas.append('123456',owner,body(lease,{requestId:'late',expectedSequence:2}),auth),'CANVAS_STALE_CLEAR');
    assert.equal((await f.canvas.append('123456',owner,first,auth)).ack.sequence,1);
    const state=await f.canvas.read('123456',owner);assert.equal(state.pointCount,0);assert.equal(state.sequence,2);assert.equal(state.clearGeneration,1);
  });

  test(`${kind}: same stroke chunk ids undo as a whole and new work clears redo`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    await f.canvas.append('123456',owner,body(lease),auth);
    await f.canvas.append('123456',owner,body(lease,{requestId:'second',expectedSequence:1}),auth);
    const command=(requestId,expectedSequence)=>{const {operations,...value}=body(lease,{requestId,expectedSequence});return value;};
    await f.canvas.undo('123456',owner,command('undo',2),auth);assert.equal((await f.canvas.read('123456',owner)).pointCount,0);
    await f.canvas.redo('123456',owner,command('redo',3),auth);assert.equal((await f.canvas.read('123456',owner)).pointCount,6);
    await f.canvas.undo('123456',owner,command('undo-2',4),auth);
    await f.canvas.append('123456',owner,body(lease,{requestId:'fresh',expectedSequence:5,operations:[stroke(1,'new-stroke')]}),auth);
    await f.canvas.redo('123456',owner,command('redo-2',6),auth);assert.equal((await f.canvas.read('123456',owner)).pointCount,1);
  });

  test(`${kind}: device, session, expiration and explicit actor invalidation fence old writers`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    await reject(f.canvas.append('123456',owner,body(lease),{authorizationId:'new-session'}),'CANVAS_STALE_WRITER');
    const newer=await acquire(f.canvas,'123456',owner,{deviceId:'device-b'},auth);assert.equal(newer.leaseGeneration,2);
    await reject(f.canvas.append('123456',owner,body(lease),auth),'CANVAS_STALE_WRITER');
    f.setTime(16000);await reject(f.canvas.append('123456',owner,body(newer,{deviceId:'device-b'}),auth),'CANVAS_STALE_WRITER');
    f.setTime(17000);const fresh=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);f.canvas.invalidateActor(owner);
    await reject(f.canvas.append('123456',owner,body(fresh),auth),'CANVAS_STALE_WRITER');assert.equal((await f.canvas.read('123456',owner)).pointCount,0);
    const sessionLease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);f.canvas.invalidateAuthorization(auth.authorizationId);
    await reject(f.canvas.append('123456',owner,body(sessionLease),auth),'CANVAS_STALE_WRITER');
  });

  test(`${kind}: authorization, drawing deadline equality, pause, reveal and waiting have no canvas write`,async t=>{
    const f=await fixture(t,kind);
    await reject(acquire(f.canvas,'123456',guest,{deviceId:'device-a'},auth),'CANVAS_DRAWER_REQUIRED');
    await reject(acquire(f.canvas,'123456',viewer,{deviceId:'device-a'},auth),'CANVAS_DRAWER_REQUIRED');
    f.setTime(601000);await reject(acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),'CANVAS_STAGE_CLOSED');f.setTime(1000);
    for(const phase of ['paused','finished','aborted']) {await f.editRoom(s=>{s.phase=phase;});await reject(acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),'CANVAS_STAGE_CLOSED');}
    await f.editRoom(s=>{s.phase='playing';s.game.stage='reveal';});await reject(acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),'CANVAS_STAGE_CLOSED');
    await f.editRoom(s=>{s.phase='idle';s.matchId=null;s.game=null;});const idle=await f.canvas.read('123456',owner);
    assert.equal(idle.canvasId,null);assert.equal(idle.pointCount,0);assert.equal((await f.storage.scan(CANVAS_SCOPE)).length,1);
  });

  test(`${kind}: absent presence, room and canvas revisions fence commit together`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),original=f.storage.compareAndSwapMany.bind(f.storage);
    for(const scope of ['rooms','room-presence',CANVAS_SCOPE]) {
      let once=true;f.storage.compareAndSwapMany=async transaction=>{
        if(once) {once=false;const id=scope===CANVAS_SCOPE?lease.canvasId:roomId,record=await f.storage.read(scope,id);
          await f.storage.replaceCAS(scope,id,record.version,record.value);}
        return original(transaction);
      };
      await reject(f.canvas.append('123456',owner,body(lease,{requestId:`conflict-${scope}`}),auth),'CANVAS_CONFLICT');
      assert.equal((await f.canvas.read('123456',owner)).pointCount,0);
    }
    f.storage.compareAndSwapMany=original;
  });

  test(`${kind}: deadline crossed during adapter transaction preserves both canvas and quota`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),original=f.storage.adapter.compareAndSwapMany.bind(f.storage.adapter);
    f.storage.adapter.compareAndSwapMany=(transaction,clock)=>{f.setTime(601000);return original(transaction,clock);};
    await reject(f.canvas.append('123456',owner,body(lease),auth),'CANVAS_CONFLICT');
    assert.equal((await f.storage.get(CANVAS_SCOPE,lease.canvasId)).sequence,0);validateCanvasCollection((await f.storage.scan(CANVAS_SCOPE)).map(record=>record.value));
  });

  test(`${kind}: persistent receipt history is bounded and evicted unknown requests cannot append`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),first=body(lease,{operations:[stroke(1)]});
    await f.canvas.append('123456',owner,first,auth);
    for(let i=1;i<=128;i++)await f.canvas.append('123456',owner,body(lease,{requestId:`request-${i}`,expectedSequence:i,operations:[stroke(1)]}),auth);
    const saved=await f.storage.get(CANVAS_SCOPE,lease.canvasId);assert.equal(Object.keys(saved.requests).length,128);
    await reject(f.canvas.append('123456',owner,first,auth),'CANVAS_SEQUENCE_GAP');assert.equal(saved.strokes[0].points.length,129);
  });

  test(`${kind}: malformed batches and the single-stroke cap reject before durable growth`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    for(const operations of [{},[{...stroke(),points:[[NaN,.5]]}],[{...stroke(),tool:'image'}],[{...stroke(),userKey:owner}]])
      await assert.rejects(f.canvas.append('123456',owner,body(lease,{operations}),auth),error=>error.status===400);
    await reject(f.canvas.append('123456',owner,body(lease,{operations:[stroke(257)]}),auth),'CANVAS_BATCH_TOO_LARGE');
    await reject(f.canvas.append('123456',owner,body(lease,{operations:Array.from({length:17},(_,i)=>stroke(1,`stroke-${i}`))}),auth),'CANVAS_BATCH_TOO_LARGE');
    for(let i=0;i<16;i++)await f.canvas.append('123456',owner,body(lease,{requestId:`chunk-${i}`,expectedSequence:i,operations:[stroke(256)]}),auth);
    await reject(f.canvas.append('123456',owner,body(lease,{requestId:'over',expectedSequence:16,operations:[stroke(1)]}),auth),'CANVAS_LIMIT');
    assert.equal((await f.canvas.read('123456',owner)).pointCount,4096);
  });
}

test('SQLite: a second connection observes committed canvas before append delivery',async t=>{
  const f=await fixture(t),second=f.open(),events=[];await f.canvas.watch('123456',viewer,async packet=>{
    if(packet.kind==='append')events.push((await second.get(CANVAS_SCOPE,packet.canvasId)).sequence);
  });const lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);await f.canvas.append('123456',owner,body(lease),auth);
  assert.deepEqual(events,[1]);assert.equal(second.adapter.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
});

test('old turn and old boot requests cannot collide with a new canvas lease having the same numeric generations',async t=>{
  const f=await fixture(t),old=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
  await f.editRoom(snapshot=>{snapshot.game.turnId='dg-turn-2';});const fresh=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
  assert.equal(old.leaseGeneration,fresh.leaseGeneration);assert.notEqual(old.canvasId,fresh.canvasId);
  await reject(f.canvas.acquire('123456',owner,{deviceId:'device-a',canvasId:old.canvasId,bootId:old.bootId},auth),'CANVAS_TURN_CHANGED');
  await reject(f.canvas.acquire('123456',owner,{deviceId:'device-a',canvasId:fresh.canvasId,bootId:'00000000-0000-0000-0000-000000000000'},auth),'CANVAS_STALE_WRITER');
  await reject(f.canvas.acquire('123456',owner,{deviceId:'device-a'},auth),'INVALID_CANVAS_REQUEST');
  await reject(f.canvas.append('123456',owner,body(old),auth),'CANVAS_TURN_CHANGED');
  await reject(f.canvas.append('123456',owner,body(fresh,{bootId:'0'.repeat(8)+'-0000-0000-0000-'+'0'.repeat(12)}),auth),'CANVAS_STALE_WRITER');
  await f.canvas.append('123456',owner,body(fresh),auth);assert.equal((await f.canvas.read('123456',owner)).pointCount,3);
});

test('SQLite: new Node process with the same key recovers confirmed points and refuses every old writer',async t=>{
  const f=await fixture(t),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);await f.canvas.append('123456',owner,body(lease),auth);
  const script=`import {EncryptedStore,SQLiteAdapter} from './server/storage.mjs';import {createCanvasService} from './server/games/draw-and-guess/canvas-service.mjs';import {RoomError} from './app/rooms.mjs';const roomId='${roomId}';
    const storage=new EncryptedStore(new SQLiteAdapter(process.env.CANVAS_TEST_PATH),Buffer.from(process.env.CANVAS_TEST_KEY,'hex'),()=>1000);
    const ctxRooms=(${trustedRooms.toString()})(storage,()=>1000),service=createCanvasService({storage,rooms:ctxRooms,now:()=>1000});
    const state=await service.read('123456','${owner}');let rejected=false;
    try{await service.append('123456','${owner}',${JSON.stringify(body(lease,{requestId:'old-process',expectedSequence:1}))},${JSON.stringify(auth)});}catch(error){rejected=error.code==='CANVAS_STALE_WRITER';}
    const acquired=await service.acquire('123456','${owner}',{deviceId:'device-a',canvasId:state.canvasId,bootId:state.bootId},${JSON.stringify(auth)});
    console.log(JSON.stringify({points:state.pointCount,oldRejected:rejected,bootId:state.bootId,generation:acquired.leaseGeneration}));await service.close();storage.close();`;
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,CANVAS_TEST_PATH:f.path,CANVAS_TEST_KEY:f.key.toString('hex')},encoding:'utf8'}));
  assert.equal(result.points,3);assert.equal(result.oldRejected,true);assert.notEqual(result.bootId,lease.bootId);assert.equal(result.generation,2);
  await reject(f.canvas.append('123456',owner,body(lease,{requestId:'old-parent',expectedSequence:1}),auth),'CANVAS_STALE_WRITER');
});

test('SQLite: shared global quota admits one complete winner across independent services and connections',async t=>{
  const f=await fixture(t,'SQLite',{maxCanvases:1});await f.addRoom('f'.repeat(32));const other=f.service(f.open());
  const outcomes=await Promise.allSettled([acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),acquire(other,'654321',owner,{deviceId:'device-b'},auth)]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  const records=await f.storage.scan(CANVAS_SCOPE);validateCanvasCollection(records.map(record=>record.value));assert.equal(records.length,2);
});

test('global byte budget does not leave a new canvas when capacity rejects',async t=>{
  const f=await fixture(t,'SQLite',{maxTotalBytes:1});await reject(acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),'CANVAS_CAPACITY');
  const quota=await f.storage.get(CANVAS_SCOPE,CANVAS_QUOTA_ID);assert.equal(quota.totalBytes,0);assert.equal((await f.storage.scan(CANVAS_SCOPE)).length,1);
});

test('per-canvas point, stroke and byte caps include redo history and preserve readable state',async t=>{
  const f=await fixture(t),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),base=await f.storage.get(CANVAS_SCOPE,lease.canvasId);
  for(const type of ['points','strokes','bytes']) {
    const value=structuredClone(base);
    if(type==='points')value.strokes=Array.from({length:13},(_,i)=>stroke(i===12?848:4096,`stroke-${i}`));
    if(type==='strokes')value.strokes=Array.from({length:1500},(_,i)=>stroke(1,`stroke-${i}`));
    if(type==='bytes') {
      const points=Array.from({length:4096},()=>[0.0000012345678901234567,0.000009876543210987654]);
      value.strokes=Array.from({length:10},(_,i)=>({...stroke(1,`stroke-${i}`),points:structuredClone(points)}));
      value.strokes.push({...stroke(1,'last-stroke'),points:structuredClone(points.slice(0,110))});
      validateCanvasRecord(value);await f.seed(value);
      await reject(f.canvas.append('123456',owner,body(lease,{requestId:'limit-bytes',operations:[{...stroke(1,'last-stroke'),points:points.slice(0,256)}]}),auth),'CANVAS_LIMIT');
      assert.equal((await f.canvas.read('123456',owner)).pointCount,41070);continue;
    }
    await f.seed(value);await reject(f.canvas.append('123456',owner,body(lease,{requestId:`limit-${type}`,operations:[stroke(1,'new-stroke')]}),auth),'CANVAS_LIMIT');
    assert.equal((await f.canvas.read('123456',owner)).strokes.length,value.strokes.length);
  }
});

test('quota rebuild is guarded; corrupted quota references fail closed',async t=>{
  const f=await fixture(t),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);await f.canvas.append('123456',owner,body(lease),auth);
  await f.canvas.close();const quota=await f.storage.read(CANVAS_SCOPE,CANVAS_QUOTA_ID);await f.storage.remove(CANVAS_SCOPE,CANVAS_QUOTA_ID,quota.version);
  const restored=f.service();assert.equal((await restored.read('123456',owner)).pointCount,3);validateCanvasCollection((await f.storage.scan(CANVAS_SCOPE)).map(record=>record.value));
  await restored.close();await f.storage.put(CANVAS_SCOPE,CANVAS_QUOTA_ID,{schemaVersion:1,kind:'quota',entries:{},totalBytes:0});
  const corrupt=f.service();await reject(corrupt.read('123456',owner),'CANVAS_INVALID');await assert.rejects(corrupt.ready,/quota references/);
});

test('large initial and replacement events use small recovery hints; leaving drops queued delivery',async t=>{
  const f=await fixture(t,'SQLite',{maxEventBytes:300}),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),events=[],ends=[];
  await f.canvas.watch('123456',viewer,packet=>events.push(packet),(message,status)=>ends.push(status));
  assert.equal(events[0].kind,'recovery');assert.equal(events[0].requiresRead,true);assert.equal(events[0].bootId,lease.bootId);
  const presence=await f.storage.read('room-presence',roomId);delete presence.value.members[viewer];await f.storage.replaceCAS('room-presence',roomId,presence.version,presence.value);
  await f.canvas.append('123456',owner,body(lease),auth);assert.equal(events.length,1);assert.deepEqual(ends,[403]);
});

test('serialized subscription has an initial snapshot before any local append delta',async t=>{
  const f=await fixture(t),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),events=[];
  await Promise.all([f.canvas.watch('123456',viewer,packet=>events.push(packet)),f.canvas.append('123456',owner,body(lease),auth)]);
  assert.deepEqual(events.map(packet=>[packet.kind,packet.sequence]),[['snapshot',0],['append',1]]);
});

test('event and write queue budgets end slow delivery and reject excessive pending work',async t=>{
  const f=await fixture(t,'SQLite',{maxQueuedOutputBytes:1,maxQueuedWrites:1}),ends=[];
  await f.canvas.watch('123456',viewer,()=>assert.fail('should close before private delivery'),(_message,status)=>ends.push(status));assert.deepEqual(ends,[503]);
  const original=f.rooms.getGameContext;let release;const blocker=new Promise(resolve=>{release=resolve;});
  const rooms={async getGameContext(...args){await blocker;return original(...args);}},service=createCanvasService({storage:f.storage,rooms,now:f.now,maxQueuedWrites:1});
  t.after(()=>service.close());const pending=service.acquire('123456',owner,{deviceId:'device-a',canvasId:canvasIdFor(roomId,matchId,'dg-turn-1'),bootId:service.bootId},auth);
  await reject(service.acquire('123456',owner,{deviceId:'device-b',canvasId:canvasIdFor(roomId,matchId,'dg-turn-1'),bootId:service.bootId},auth),'CANVAS_BUSY');release();await pending;
});

test('room owner lifecycle preserves paused current canvas then sweep atomically frees retired canvas quota',async t=>{
  const f=await fixture(t),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);await f.canvas.append('123456',owner,body(lease),auth);
  await f.editRoom(s=>{s.phase='paused';s.game.stageClock.deadlineAt=null;});f.setTime(20000000);await f.canvas.sweep();assert.equal((await f.storage.get(CANVAS_SCOPE,lease.canvasId)).sequence,1);
  const room=await f.storage.read('rooms',roomId);await f.storage.remove('rooms',roomId,room.version);await f.canvas.sweep();
  assert.equal(await f.storage.get(CANVAS_SCOPE,lease.canvasId),null);assert.equal((await f.storage.get(CANVAS_SCOPE,CANVAS_QUOTA_ID)).totalBytes,0);
});

test('damaged ciphertext never masquerades as an empty canvas',async t=>{
  const f=await fixture(t),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),raw=await f.storage.adapter.get(recordKey(CANVAS_SCOPE,lease.canvasId));
  await f.storage.adapter.put(recordKey(CANVAS_SCOPE,lease.canvasId),{...raw,payload:'corrupt'});await reject(f.canvas.read('123456',owner),'CANVAS_INVALID');
});

test('canvas geometry persists across process service recovery and preserves older 4:3 records',async t=>{
  const f=await fixture(t),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
  assert.deepEqual((await f.canvas.read('123456',owner)).geometry,{width:1024,height:576});
  await f.canvas.append('123456',owner,body(lease),auth);
  const restored=f.service(f.open());
  assert.deepEqual((await restored.read('123456',viewer)).geometry,{width:1024,height:576});
  const old=await f.storage.get(CANVAS_SCOPE,lease.canvasId);delete old.geometry;
  await f.seed(old);
  const legacy=f.service(f.open());
  const view=await legacy.read('123456',viewer);
  assert.deepEqual(view.geometry,{width:1024,height:768});
  assert.deepEqual(view.strokes[0].points,stroke().points);
  assert.throws(()=>validateCanvasRecord({...old,geometry:{width:2048,height:576}}),/Invalid draw canvas/);
});
