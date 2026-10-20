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

const command=(lease,state,requestId)=>({deviceId:'device-a',canvasId:state.canvasId,bootId:state.bootId,
  leaseGeneration:lease.leaseGeneration,clearGeneration:state.clearGeneration,expectedSequence:state.sequence,requestId});
const recovery=(state,requestId)=>({...command(state,state,requestId),recoverWriter:true});
const byteLength=value=>Buffer.byteLength(JSON.stringify(value));
function fillToBytes(value,budget) {
  const point=[0.0000012345678901234567,0.000009876543210987654];
  value.strokes=[{...stroke(1,'s'),points:[]}];
  const pointBytes=JSON.stringify(point).length+1,count=Math.floor((budget-byteLength(value)-1)/pointBytes);
  value.strokes[0].points=Array.from({length:count},()=>point);
  const remaining=budget-byteLength(value);assert.ok(remaining>=0&&remaining<128);
  value.strokes[0].strokeId+='x'.repeat(remaining);assert.equal(byteLength(value),budget);validateCanvasRecord(value);return value;
}
for(const kind of ['Memory','SQLite']) {
  test(`${kind}: recovery clear retains writer, sequence, clear, boot, turn and membership fences`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    await f.canvas.append('123456',owner,body(lease),auth);const state=await f.canvas.read('123456',owner),input=recovery(state,'guard-clear');
    for(const recoverWriter of [false,null,'true'])await reject(f.canvas.clear('123456',owner,{...input,recoverWriter},auth),'INVALID_CANVAS_BODY');
    await reject(f.canvas.append('123456',owner,{...input,operations:[stroke()]},auth),'INVALID_CANVAS_BODY');
    for(const userKey of [guest,viewer])await reject(f.canvas.clear('123456',userKey,input,auth),'CANVAS_DRAWER_REQUIRED');
    await reject(f.canvas.clear('123456',owner,{...input,leaseGeneration:0},auth),'CANVAS_STALE_WRITER');
    await reject(f.canvas.clear('123456',owner,{...input,clearGeneration:1},auth),'CANVAS_STALE_CLEAR');
    await reject(f.canvas.clear('123456',owner,{...input,expectedSequence:0},auth),'CANVAS_SEQUENCE_GAP');
    await reject(f.canvas.clear('123456',owner,{...input,bootId:'00000000-0000-0000-0000-000000000000'},auth),'CANVAS_STALE_WRITER');
    await reject(f.canvas.clear('123456',owner,{...input,canvasId:'f'.repeat(64)},auth),'CANVAS_TURN_CHANGED');
    for(const phase of ['paused','finished','aborted']) {
      await f.editRoom(s=>{s.phase=phase;});await reject(f.canvas.clear('123456',owner,input,auth),'CANVAS_STAGE_CLOSED');
    }
    await f.editRoom(s=>{s.phase='playing';s.game.stage='reveal';});await reject(f.canvas.clear('123456',owner,input,auth),'CANVAS_STAGE_CLOSED');
    await f.editRoom(s=>{s.game.stage='drawing';});f.setTime(601000);await reject(f.canvas.clear('123456',owner,input,auth),'CANVAS_STAGE_CLOSED');
    assert.equal((await f.canvas.read('123456',owner)).pointCount,3);
  });

  test(`${kind}: recovery receipt is exact, session-bound and cannot clear later ink or a newer writer`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    await f.canvas.append('123456',owner,body(lease),auth);f.canvas.invalidateAuthorization(auth.authorizationId);
    const state=await f.canvas.read('123456',owner),input=recovery(state,'clear-once');
    const first=await f.canvas.clear('123456',owner,input,auth);assert.equal(first.duplicate,false);assert.equal(first.ack.leaseGeneration,2);
    let current=await f.canvas.read('123456',owner);
    await f.canvas.append('123456',owner,{...command(first.ack,current,'later-ink'),operations:[stroke(2,'fresh')]},auth);
    const second=await f.canvas.clear('123456',owner,input,auth);assert.equal(second.duplicate,true);assert.equal(second.ack.sequence,2);
    assert.equal((await f.canvas.read('123456',owner)).pointCount,2);
    await reject(f.canvas.clear('123456',owner,{...input,expectedSequence:3},auth),'CANVAS_REQUEST_REUSED');
    await reject(f.canvas.clear('123456',owner,input,{authorizationId:'new-session'}),'CANVAS_REQUEST_REUSED');
    await acquire(f.canvas,'123456',owner,{deviceId:'other-device'},auth);
    await reject(f.canvas.clear('123456',owner,input,auth),'CANVAS_STALE_WRITER');
    current=await f.canvas.read('123456',owner);
    const outcomes=await Promise.allSettled(['race-a','race-b'].map(id=>f.canvas.clear('123456',owner,recovery(current,id),auth)));
    assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(outcome=>outcome.status==='rejected'&&outcome.reason.code==='CANVAS_STALE_WRITER').length,1);
    assert.equal((await f.canvas.read('123456',owner)).clearGeneration,2);
  });

  test(`${kind}: atomic recovery CAS conflict installs no writer and changes no canvas or quota`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    await f.canvas.append('123456',owner,body(lease),auth);const state=await f.canvas.read('123456',owner);
    const original=f.storage.compareAndSwapMany.bind(f.storage);
    for(const scope of ['rooms','room-presence',CANVAS_SCOPE]) {
      const before=await f.storage.scan(CANVAS_SCOPE);let once=true;
      f.storage.compareAndSwapMany=async transaction=>{if(once){once=false;const id=scope===CANVAS_SCOPE?state.canvasId:roomId,record=await f.storage.read(scope,id);
        await f.storage.replaceCAS(scope,id,record.version,record.value);}return original(transaction);};
      await reject(f.canvas.clear('123456',owner,recovery(state,'cas-clear-'+scope),auth),'CANVAS_CONFLICT');
      const after=await f.storage.scan(CANVAS_SCOPE);
      assert.deepEqual(after.map(record=>record.value),before.map(record=>record.value));f.storage.compareAndSwapMany=original;
    }
    const before=await f.storage.scan(CANVAS_SCOPE),adapterCAS=f.storage.adapter.compareAndSwapMany.bind(f.storage.adapter);
    f.storage.adapter.compareAndSwapMany=(transaction,clock)=>{f.setTime(601000);return adapterCAS(transaction,clock);};
    await reject(f.canvas.clear('123456',owner,recovery(state,'cross-deadline'),auth),'CANVAS_CONFLICT');
    assert.deepEqual(await f.storage.scan(CANVAS_SCOPE),before);f.storage.adapter.compareAndSwapMany=adapterCAS;f.setTime(1000);
    // The prior writer was not revoked by the failed takeover.
    await f.canvas.append('123456',owner,{...command(lease,state,'prior-still-valid'),operations:[stroke(1)]},auth);
    assert.equal((await f.canvas.read('123456',owner)).pointCount,4);
  });

  test(`${kind}: point cap rejects only append; explicit atomic clear recovers an expired writer at point cap without replay`,async t=>{
    const f=await fixture(t,kind);let lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    const value=await f.storage.get(CANVAS_SCOPE,lease.canvasId);value.strokes=[stroke(50000)];await f.seed(value);
    await reject(f.canvas.append('123456',owner,body(lease,{operations:[stroke(1)]}),auth),'CANVAS_LIMIT');
    let state=await f.canvas.read('123456',owner);assert.equal(state.pointCount,50000);assert.equal(state.sequence,0);
    f.setTime(16000);const recovered=await f.canvas.clear('123456',owner,recovery(state,'clear-full'),auth);lease=recovered.ack;
    state=await f.canvas.read('123456',owner);assert.equal(state.pointCount,0);assert.equal(state.clearGeneration,1);
    await f.canvas.append('123456',owner,{...command(lease,state,'after-clear'),operations:[stroke(2)]},auth);
    f.setTime(31000);state=await f.canvas.read('123456',owner);
    await reject(f.canvas.clear('123456',owner,command(lease,state,'expired-clear'),auth),'CANVAS_STALE_WRITER');
    const next=await f.canvas.clear('123456',owner,recovery(state,'renewed-clear'),auth);assert.equal(next.ack.leaseGeneration,3);
    assert.equal((await f.canvas.read('123456',owner)).pointCount,0);
  });

  test(`${kind}: unknown committed outcome is read once, not replayed; atomic clear recovers without replay`,async t=>{
    const f=await fixture(t,kind);let lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    const original=f.storage.compareAndSwapMany.bind(f.storage);let once=true;
    f.storage.compareAndSwapMany=async input=>{const result=await original(input);if(once){once=false;throw new Error('Synthetic transport loss after committed CAS');}return result;};
    await assert.rejects(f.canvas.append('123456',owner,body(lease),auth),/transport loss/);
    let state=await f.canvas.read('123456',owner);assert.equal(state.pointCount,3);assert.equal(state.sequence,1);
    f.storage.compareAndSwapMany=original;f.setTime(16000);
    await reject(f.canvas.append('123456',owner,body(lease),auth),'CANVAS_STALE_WRITER');
    await f.canvas.clear('123456',owner,recovery(state,'clear-unknown'),auth);
    state=await f.canvas.read('123456',owner);assert.equal(state.pointCount,0);assert.equal(state.sequence,2);
  });

  test(`${kind}: 429 busy and transient503 release write queue and accept a later explicit clear`,async t=>{
    const f=await fixture(t,kind),lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    const original=f.storage.compareAndSwapMany.bind(f.storage),entered=deferred(),release=deferred();let once=true;
    f.storage.compareAndSwapMany=async input=>{if(once){once=false;entered.resolve();await release.promise;throw new RoomError(503,'SYNTHETIC_STORAGE_BUSY','synthetic temporary error');}return original(input);};
    const busy=f.service(f.storage,{maxQueuedWrites:1});await busy.ready;
    const pending=acquire(busy,'123456',owner,{deviceId:'device-a'},auth);await entered.promise;
    try {await reject(acquire(busy,'123456',owner,{deviceId:'device-b'},auth),'CANVAS_BUSY');}
    finally {release.resolve();}
    await reject(pending,'SYNTHETIC_STORAGE_BUSY');f.storage.compareAndSwapMany=original;
    const state=await busy.read('123456',owner);await busy.clear('123456',owner,recovery(state,'clear-after-busy'),auth);
    assert.equal((await busy.read('123456',owner)).sequence,1);
  });

  test(`${kind}: atomic clear recovers byte-exact2MiB canvas and expired lease without a separate acquire`,async t=>{
    const f=await fixture(t,kind);let lease;
    for(let i=0;i<9;i++)lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    const value=await f.storage.get(CANVAS_SCOPE,lease.canvasId),budget=2*1024*1024;
    fillToBytes(value,budget);await f.seed(value);
    f.setTime(16000);const state=await f.canvas.read('123456',owner);
    await reject(f.canvas.clear('123456',owner,command(lease,state,'expired-full-clear'),auth),'CANVAS_STALE_WRITER');
    await reject(acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),'CANVAS_LIMIT');
    assert.equal((await f.canvas.read('123456',owner)).leaseGeneration,9);assert.equal(byteLength(await f.storage.get(CANVAS_SCOPE,lease.canvasId)),budget);
    const result=await f.canvas.clear('123456',owner,recovery(state,'atomic-full-clear'),auth);
    assert.equal(result.ack.leaseGeneration,10);assert.equal(result.ack.sequence,1);assert.equal(result.ack.persisted,true);
    const cleared=await f.canvas.read('123456',owner);assert.equal(cleared.pointCount,0);assert.equal(cleared.clearGeneration,1);
    await f.canvas.append('123456',owner,{...command(result.ack,cleared,'after-full-clear'),operations:[stroke(2)]},auth);
    assert.equal((await f.canvas.read('123456',owner)).pointCount,2);
  });

  test(`${kind}: atomic clear recovers an expired writer at exactly full global byte quota`,async t=>{
    const f=await fixture(t,kind);let lease;
    for(let i=0;i<9;i++)lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    await f.canvas.append('123456',owner,body(lease,{operations:[stroke(256)]}),auth);
    const quota=await f.storage.get(CANVAS_SCOPE,CANVAS_QUOTA_ID),small=f.service(f.storage,{maxTotalBytes:quota.totalBytes});await small.ready;
    f.setTime(16000);assert.equal((await small.read('123456',owner)).pointCount,256);
    await reject(acquire(small,'123456',owner,{deviceId:'device-a'},auth),'CANVAS_CAPACITY');
    const state=await small.read('123456',owner),result=await small.clear('123456',owner,recovery(state,'free-quota'),auth);
    assert.equal(result.ack.leaseGeneration,10);assert.equal((await small.read('123456',owner)).pointCount,0);
    assert.ok((await f.storage.get(CANVAS_SCOPE,CANVAS_QUOTA_ID)).totalBytes<quota.totalBytes);
  });

  test(`${kind}: atomic clear escapes default16MiB quota with9 valid canvases and preserves other confirmed images`,async t=>{
    const f=await fixture(t,kind);let lease;
    for(let i=0;i<9;i++)lease=await acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth);
    await f.canvas.append('123456',owner,body(lease,{operations:[stroke(256)]}),auth);
    const current=await f.storage.get(CANVAS_SCOPE,lease.canvasId),each=2*1024*1024;
    for(let i=1;i<=8;i++) {
      const value=structuredClone(current);value.roomId=String(i).repeat(32);value.canvasId=canvasIdFor(value.roomId,value.matchId,value.turnId);value.requests={};
      fillToBytes(value,i===8?each-byteLength(current):each);await f.addRoom(value.roomId);await f.seed(value);
    }
    const quota=await f.storage.get(CANVAS_SCOPE,CANVAS_QUOTA_ID);assert.equal(quota.totalBytes,16*1024*1024);assert.equal(Object.keys(quota.entries).length,9);
    f.setTime(16000);const state=await f.canvas.read('123456',owner);assert.equal(state.pointCount,256);
    await reject(f.canvas.clear('123456',owner,command(lease,state,'expired-global-clear'),auth),'CANVAS_STALE_WRITER');
    await reject(acquire(f.canvas,'123456',owner,{deviceId:'device-a'},auth),'CANVAS_CAPACITY');
    validateCanvasCollection((await f.storage.scan(CANVAS_SCOPE)).map(record=>record.value));
    const before=(await f.storage.scan(CANVAS_SCOPE)).filter(record=>record.value.kind==='canvas'&&record.value.canvasId!==state.canvasId);
    const result=await f.canvas.clear('123456',owner,recovery(state,'current-global-clear'),auth);assert.equal(result.ack.leaseGeneration,10);
    assert.deepEqual((await f.storage.scan(CANVAS_SCOPE)).filter(record=>record.value.kind==='canvas'&&record.value.canvasId!==state.canvasId),before);
    validateCanvasCollection((await f.storage.scan(CANVAS_SCOPE)).map(record=>record.value));
  });
}

