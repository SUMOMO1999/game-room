import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore, RoomError, DEFAULT_TURN_TIMEOUT_MS } from './rooms.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { orderedRoomPlayers, turnClockDisplay } from './game-presentation.mjs';

test('explicit reverse action order and opportunity clocks do not inherit physical seats or turn expiry', () => {
  const view={gameType:'poker414-2',phase:'playing',serverTime:1000,players:['a','b','c'].map(id=>({id})),game:{
    players:['a','b','c'].map(id=>({id})),actionOrder:['a','c','b'],firstPlayerId:'c',turnPlayerId:'b'},turnClock:{kind:'response',deadlineAt:6000}};
  const ordered=orderedRoomPlayers(view);
  assert.deepEqual(ordered.map(player=>player.id),['c','b','a']);
  assert.equal(ordered.find(player=>player.isCurrent).id,'b');assert.equal(ordered.find(player=>player.isNext).id,'a');
  assert.match(turnClockDisplay(view).label,/勾叉机会剩余 00:05/);
  assert.doesNotMatch(turnClockDisplay(view,5000).action,/换人/);
  assert.match(turnClockDisplay({...view,turnClock:{kind:'deal',deadlineAt:1500}}).label,/下一批发牌/);
  assert.equal(turnClockDisplay({...view,turnClock:null}).visible,false);
});
import { applyGameAction, applyTimeout, gameProblem, createGame } from './army-rules.mjs';
import { gameAdapter } from './game-registry.mjs';
import { compareReleaseCompatibility, CURRENT_DATA_COMPATIBILITY } from '../scripts/release-compatibility.mjs';
const opts = { firstTurnIndex: 0, randomInt: max => max - 1 };
const expectCode = code => error => error instanceof RoomError && error.code === code;
let seq = 0;
function pure({gameType='rummikub',count=2,firstTurnIndex=0,clockMs=60000,version}={}) {
  let at=100000;
  const store=createRoomStore({now:()=>at,turnTimeoutMs:clockMs,gameOptions:{...opts,firstTurnIndex,...(version?{ruleVersion:version}:{})}});
  const seats=[store.createRoom('同名',{gameType})];
  for(let i=1;i<count;i++)seats.push(store.joinRoom(seats[0].roomCode,'同名'));
  const view=seat=>store.getView(seat.roomCode,seat.token);
  const act=(seat,type,fields={})=>store.action(seat.roomCode,seat.token,{type,requestId:`clock-${++seq}`,expectedRevision:view(seat).revision,...fields});
  for(const seat of seats)act(seat,'ready',{ready:true});act(seats[0],'start');
  return {store,seats,view,act,set:value=>at=value,now:()=>at};
}

test('new room clock persists authoritative fence and all four players see the same stable cycle',()=>{
  const f=pure({count:4,firstTurnIndex:2}),a=f.seats[0],initial=f.view(a),clock=initial.turnClock;
  assert.equal(clock.firstPlayerId,f.seats[2].playerId);assert.equal(clock.deadlineAt,160000);
  const expected=[2,3,0,1].map(i=>f.seats[i].playerId);
  for(const seat of f.seats)assert.deepEqual(orderedRoomPlayers(f.view(seat)).map(p=>p.id),expected);
  const before=f.store.exportSnapshot(a.roomCode);f.set(110000);
  f.act(f.seats[2],'draw');
  const after=f.view(a);assert.equal(after.turnClock.firstPlayerId,clock.firstPlayerId);
  assert.deepEqual(orderedRoomPlayers(after).map(p=>p.id),expected);
  assert.equal(orderedRoomPlayers(after).find(p=>p.isNext).id,f.seats[0].playerId);
  assert.equal(after.turnClock.deadlineAt,170000);assert.equal(after.turnClock.round,before.game.round+1);
  const restored=createRoomStore({now:f.now});restored.importSnapshot(f.store.exportSnapshot(a.roomCode));
  assert.deepEqual(restored.getView(a.roomCode,a.token).turnClock,after.turnClock);
});

test('views, host handoff, incomplete pause votes and spectator joins never extend a turn',()=>{
  const f=pure(),a=f.seats[0],clock=f.view(a).turnClock;f.set(120000);
  const observer=f.store.joinRoom(a.roomCode,'观众',{role:'spectator'});
  assert.deepEqual(f.view(observer).turnClock,clock);f.act(a,'pause');f.act(a,'transferHost',{playerId:f.seats[1].playerId});
  assert.deepEqual(f.view(a).turnClock,clock);assert.equal(f.view(a).serverTime,120000);
  assert.throws(()=>f.act(observer,'draw'),expectCode('SPECTATOR_READ_ONLY'));
});

test('pause freezes remaining time over restart, resumes with one timestamp and terminal exit stops it',()=>{
  const f=pure(),a=f.seats[0];f.set(115000);f.act(a,'pause');f.act(f.seats[1],'pause');
  const saved=f.store.exportSnapshot(a.roomCode);assert.equal(saved.turnClock.remainingMs,45000);assert.equal(saved.turnClock.deadlineAt,null);
  f.set(400000);assert.equal(f.store.applyTurnTimeout(a.roomCode,saved.turnClock),false);
  let at=500000;const restored=createRoomStore({now:()=>at++,turnTimeoutMs:60000});restored.importSnapshot(saved);
  restored.action(a.roomCode,a.token,{type:'resume',requestId:'resume-once',expectedRevision:saved.revision});
  const resumed=restored.exportSnapshot(a.roomCode);assert.equal(resumed.turnClock.deadlineAt,resumed.turnClock.startedAt+45000);
  createRoomStore().importSnapshot(resumed);
  const result=restored.action(a.roomCode,a.token,{type:'leave',requestId:'exit-once',expectedRevision:resumed.revision});assert.equal(result.left,true);
  assert.equal(restored.getView(a.roomCode,f.seats[1].token).turnClock,null);
});

test('late human draw is rejected; fenced timer draws exactly once and retains the formal table',()=>{
  const f=pure(),a=f.seats[0],before=f.store.exportSnapshot(a.roomCode),clock=before.turnClock;f.set(clock.deadlineAt);
  assert.throws(()=>f.act(a,'draw'),expectCode('TURN_TIMEOUT'));
  assert.equal(f.store.applyTurnTimeout(a.roomCode,{...clock,round:clock.round+1}),false);
  assert.equal(f.store.applyTurnTimeout(a.roomCode,clock),true);assert.equal(f.store.applyTurnTimeout(a.roomCode,clock),false);
  const after=f.store.exportSnapshot(a.roomCode);assert.equal(after.game.players[0].rack.length,before.game.players[0].rack.length+1);
  assert.equal(after.game.pool.length,before.game.pool.length-1);assert.deepEqual(after.game.board,before.game.board);
  assert.equal(after.lastActiveAt,before.lastActiveAt);assert.match(after.activity.at(-1).text,/自动摸牌/);
  assert.equal(after.turnClock.deadlineAt,clock.deadlineAt+60000);
});

test('empty pool timeout uses existing consecutive pass settlement and ends the clock',()=>{
  const f=pure(),a=f.seats[0],snapshot=f.store.exportSnapshot(a.roomCode);
  snapshot.game.players[0].rack.push(...snapshot.game.pool);snapshot.game.pool=[];f.store.importSnapshot(snapshot);
  f.set(snapshot.turnClock.deadlineAt);assert.equal(f.store.applyTurnTimeout(a.roomCode,snapshot.turnClock),true);
  const first=f.store.exportSnapshot(a.roomCode);assert.equal(first.game.consecutivePasses,1);
  f.set(first.turnClock.deadlineAt);assert.equal(f.store.applyTurnTimeout(a.roomCode,first.turnClock),true);
  const last=f.view(a);assert.equal(last.phase,'finished');assert.equal(last.game.result.reason,'blocked');assert.equal(last.turnClock,null);
});

test('military timer entry point only accepts v3; HTTP-style timeout remains invalid and keeps all 50 pieces',()=>{
  const f=pure({gameType:'army-flip'}),a=f.seats[0],before=f.store.exportSnapshot(a.roomCode);f.set(before.turnClock.deadlineAt);
  assert.equal(gameAdapter('army-flip').actionFields('timeout'),null);
  assert.throws(()=>f.act(a,'timeout'),expectCode('INVALID_ACTION'));
  assert.equal(applyGameAction(before.game,a.playerId,{type:'timeout'}).ok,false);
  assert.equal(f.store.applyTurnTimeout(a.roomCode,before.turnClock),true);
  const after=f.store.exportSnapshot(a.roomCode);assert.equal(after.game.lastAction.type,'timeout');assert.equal(after.game.round,before.game.round+1);
  assert.equal(gameProblem(after.game),null);assert.deepEqual(after.game.board,before.game.board);assert.deepEqual(after.game.captured,before.game.captured);
  assert.deepEqual(after.game.flagTokens,before.game.flagTokens);
  for(const version of ['army-flip-v1','army-flip-v2']) {
    const old=pure({gameType:'army-flip',version});assert.equal(old.view(old.seats[0]).turnClock,undefined);
    assert.equal(applyTimeout(old.store.exportSnapshot(old.seats[0].roomCode).game,old.seats[0].playerId).ok,false);
  }
});

test('old snapshots remain clockless while new schema7 rejects tampered deadlines, hidden fields and actor fences',()=>{
  for(const gameType of ['rummikub','army-flip']) {
    const old=pure({gameType,clockMs:0}),a=old.seats[0],snapshot=old.store.exportSnapshot(a.roomCode);
    const fresh=createRoomStore({now:old.now,turnTimeoutMs:DEFAULT_TURN_TIMEOUT_MS});fresh.importSnapshot(snapshot);
    assert.deepEqual(fresh.exportSnapshot(a.roomCode).game,snapshot.game);assert.equal(fresh.getView(a.roomCode,a.token).turnClock,undefined);
  }
  const f=pure(),s=f.store.exportSnapshot(f.seats[0].roomCode);assert.equal(s.schemaVersion,7);
  for(const change of [c=>c.deadlineAt++,c=>c.playerId='0'.repeat(32),c=>c.round++,c=>c.userKey='secret',c=>c.firstPlayerId='0'.repeat(32)]) {
    const bad=structuredClone(s);change(bad.turnClock);assert.throws(()=>createRoomStore().importSnapshot(bad),expectCode('INVALID_SNAPSHOT'));
  }
  const manifest=(id,cap)=>({format:1,project:'game-room',releaseId:id.repeat(20),containsSecrets:false,containsUserData:false,dataCompatibility:cap});
  const prior=structuredClone(CURRENT_DATA_COMPATIBILITY);prior.roomSnapshots={read:[1,2,3,4,5,6],write:[2,3,4,5,6]};
  const guard=compareReleaseCompatibility(manifest('a',CURRENT_DATA_COMPATIBILITY),manifest('b',prior));assert.equal(guard.forwardCompatible,true);assert.equal(guard.rollbackCompatible,false);
});

test('monotonic UI clock ignores local wall clock, freezes paused and waits for authoritative zero transition',()=>{
  const f=pure(),view=f.view(f.seats[0]);assert.equal(turnClockDisplay(view,20000).time,'00:40');
  assert.equal(turnClockDisplay(view,61000).action,'正在换人');assert.equal(turnClockDisplay(view,61000).expired,true);
  f.set(120000);f.act(f.seats[0],'pause');f.act(f.seats[1],'pause');const paused=f.view(f.seats[0]);
  assert.equal(turnClockDisplay(paused,500000).time,'00:40');assert.equal(turnClockDisplay(paused,500000).action,'已暂停');
  assert.equal(turnClockDisplay({...view,phase:'finished'},60000).visible,false);
});

async function durable(t,{interval=0}={}) {
  const dir=await mkdtemp(join(tmpdir(),'game-clock-cas-')),key=randomBytes(32),path=join(dir,'room.sqlite');let at=100000;const now=()=>at;
  const opened=[];
  const open=()=>{const storage=new EncryptedStore(new SQLiteAdapter(path,{now}),key,now),rooms=createDurableRoomStore({storage,now,turnTimeoutMs:60000,gameOptions:opts,pollIntervalMs:interval});const entry={storage,rooms};opened.push(entry);return entry;};
  const close=async e=>{if(!e.closed){await e.rooms.close();e.storage.close();e.closed=true;}};
  t.after(async()=>{for(const e of opened)await close(e);await rm(dir,{recursive:true,force:true});});
  const users=[0,1,2].map(i=>identityKey('urn:clock-test',String(i)));const a=open();
  const created=await a.rooms.createRoom(users[0],'同名','create-clock');const code=created.roomCode;
  await a.rooms.joinRoom(code,users[1],'同名','join-clock');
  const act=async(rooms,user,type,fields={})=>rooms.action(code,user,{type,requestId:`cas-${++seq}`,expectedRevision:(await rooms.getView(code,user)).revision,...fields});
  for(const user of users.slice(0,2))await act(a.rooms,user,'ready',{ready:true});await act(a.rooms,users[0],'start');
  return {a,users,code,open,close,act,set:value=>at=value,now};
}

test('two real SQLite connections race late draw and background expiry: one card, one revision, same seats',async t=>{
  const f=await durable(t),b=f.open(),before=await f.a.rooms.getView(f.code,f.users[0]);f.set(before.turnClock.deadlineAt);
  const action={type:'draw',requestId:'late-two-devices',expectedRevision:before.revision};
  const results=await Promise.allSettled([f.a.rooms.sweep(),b.rooms.sweep(),f.a.rooms.action(f.code,f.users[0],action),b.rooms.action(f.code,f.users[0],action)]);
  assert.equal(results.filter(r=>r.status==='rejected').length,2);for(const r of results.filter(r=>r.status==='rejected'))assert.equal(r.reason.code,'REVISION_CONFLICT');
  const after=await b.rooms.getView(f.code,f.users[0]);assert.equal(after.game.round,before.game.round+1);assert.equal(after.game.poolCount,before.game.poolCount-1);
  assert.equal(after.game.rack.length,before.game.rack.length+1);assert.equal(after.revision,before.revision+1);assert.equal(after.selfId,before.selfId);
  const other=await b.rooms.getView(f.code,f.users[1]);assert.deepEqual(other.turnClock,after.turnClock);assert.notDeepEqual(other.game.rack,after.game.rack);
});

test('process restart hours after deadline advances only one missed turn and saves a new full deadline',async t=>{
  const f=await durable(t),before=await f.a.rooms.getView(f.code,f.users[0]);await f.close(f.a);f.set(before.turnClock.deadlineAt+3600000);
  const b=f.open();await b.rooms.sweep();const after=await b.rooms.getView(f.code,f.users[0]);assert.equal(after.game.round,before.game.round+1);assert.equal(after.turnClock.deadlineAt,f.now()+60000);
  await b.rooms.sweep();assert.equal((await b.rooms.getView(f.code,f.users[0])).game.round,after.game.round);
});

test('background clock works with zero listeners; stream poll does not publish changing serverTime alone',async t=>{
  const f=await durable(t,{interval:5}),before=await f.a.rooms.getView(f.code,f.users[0]);f.set(before.turnClock.deadlineAt);
  await new Promise(resolve=>setTimeout(resolve,40));const after=await f.a.rooms.getView(f.code,f.users[0]);assert.equal(after.game.round,before.game.round+1);
  const packets=[];const unsub=await f.a.rooms.subscribe(f.code,f.users[0],v=>packets.push(v));assert.equal(packets.length,1);
  f.set(f.now()+1000);await f.a.rooms.sweep();assert.equal(packets.length,1,'server timestamp must not trigger private stream/identity checks');
  await unsub();
});
