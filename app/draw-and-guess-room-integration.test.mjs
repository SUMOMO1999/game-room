import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { readSettings } from '../server/config.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
const identities=['a','b','c'].map(c=>c.repeat(64));
async function fixture(t,{enabled=true}={}) {
  let time=1791330000000;
  const now=()=>time,storage=new EncryptedStore(new MemoryAdapter({now}),randomBytes(32),now);
  const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock',GAME_ROOM_PORT:'4361',GAME_ROOM_STORE_KEY:storage.key.toString('base64url')});
  const runtime=createRuntime(settings,{storage,now,drawingEnabled:enabled,roomOptions:{pollIntervalMs:0,serverRandomInt:()=>0}});
  t.after(async()=>{await runtime.canvases?.close();await runtime.chat.close();await runtime.rooms.close();storage.close();});
  await runtime.wordbankReady;
  const history=createMatchHistory({storage,now});runtime.rooms.setHistory(history);
  return {...runtime,history,now,setTime:value=>{time=value;}};
}
async function waiting(t) {
  const f=await fixture(t),first=await f.rooms.createRoom(identities[0],'画者','create-draw','draw-and-guess');
  const code=first.roomCode;
  await f.rooms.joinRoom(code,identities[1],'猜者','join-draw');
  await f.rooms.joinRoom(code,identities[2],'观众','join-watch','spectator');
  const act=async(user,type,fields={})=>{const view=await f.rooms.getView(code,user);return f.rooms.action(code,user,{type,requestId:randomBytes(16).toString('hex'),expectedRevision:view.revision,...fields});};
  for(const id of identities.slice(0,2))await act(id,'ready',{ready:true});
  await act(identities[0],'start');
  return {...f,code,act};
}
test('closed rollout gate refuses drawing rooms without creating wordbank scopes or affecting old games',async t=>{
  const f=await fixture(t,{enabled:false});
  await assert.rejects(f.rooms.createRoom(identities[0],'伙伴','closed-drawing','draw-and-guess'),{code:'DRAWING_PREPARING'});
  assert.equal((await f.storage.scan('wordbank-packs')).length,0);
  assert.equal((await f.rooms.createRoom(identities[0],'伙伴','old-game')).view.gameType,'rummikub');
});
test('content GC reads current long-lived waiting room expiry without extending or touching the room',async t=>{
  const f=await fixture(t),first=await f.rooms.createRoom(identities[0],'长等伙伴','long-wait','draw-and-guess');
  const id=first.view.roomId;
  for(let n=0;n<25;n++) {
    f.setTime(f.now()+7*60*60*1000);
    const view=await f.rooms.getView(first.roomCode,identities[0]);
    await f.rooms.action(first.roomCode,identities[0],{type:'ready',ready:n%2===0,expectedRevision:view.revision,requestId:`long-ready-${n}`});
  }
  const before=await f.storage.read('rooms',id),selection=before.value.snapshot.drawConfig.contentSelection;
  const ref=await f.rooms.getContentReference({...selection,referenceId:`room-${id}`});
  assert.equal(ref.guard.expectedVersion,before.version);assert.equal(ref.expiresAt,before.value.snapshot.lastActiveAt+8*60*60*1000);
  assert.deepEqual(await f.storage.read('rooms',id),before);
  assert.equal(await f.rooms.getContentReference({...selection,version:2,referenceId:`room-${id}`}),null);
});
test('durable room freezes selected release and keeps candidates, wrong guesses and receipts private',async t=>{
  const f=await waiting(t),a=await f.rooms.getView(f.code,identities[0]),b=await f.rooms.getView(f.code,identities[1]);
  assert.equal(a.drawConfig.contentSelection.version,1);assert.equal(a.game.canChoose,true);
  assert.equal(a.game.candidates.length,3);assert.equal(b.game.candidates,undefined);
  assert.equal(b.game.frozenCandidates,undefined);assert.equal(a.turnClock.version,2);
  const answer=a.game.candidates[0].answer;
  await f.act(identities[0],'choose',{matchId:a.matchId,turnId:a.game.turnId,candidateId:a.game.candidates[0].id});
  let view=await f.rooms.getView(f.code,identities[1]);
  const body={type:'guess',requestId:'wrong-one',expectedRevision:view.revision,matchId:view.matchId,turnId:view.game.turnId,text:'此题错误答案'};
  const wrong=await f.rooms.action(f.code,identities[1],body);
  assert.deepEqual(wrong.guessResult,{correct:false,points:0});
  assert.deepEqual(wrong.view.actionReceipts.find(r=>r.requestId==='wrong-one').guessResult,wrong.guessResult);
  assert.equal((await f.rooms.getView(f.code,identities[0])).actionReceipts.some(r=>r.requestId==='wrong-one'),false);
  assert.equal(JSON.stringify((await f.rooms.getView(f.code,identities[2])).activity).includes('此题错误答案'),false);
  await assert.rejects(f.chat.send(f.code,identities[2],{requestId:'answer-chat',text:`答案是${answer}`}),{code:'ANSWER_IN_CHAT'});
  assert.equal(JSON.stringify((await f.storage.scan('room-chat')).map(r=>r.value.messages)).includes(answer),false);
  const right=await f.act(identities[1],'guess',{matchId:view.matchId,turnId:view.game.turnId,text:answer});
  assert.equal(right.guessResult.correct,true);assert.equal(right.view.game.stage,'reveal');
  assert.deepEqual((await f.rooms.action(f.code,identities[1],body)).guessResult,{correct:false,points:0});
  const record=(await f.storage.scan('rooms'))[0].value.snapshot;
  assert.equal(record.schemaVersion,10);assert.equal(record.game.frozenCandidates.length,12);
  assert.equal(JSON.stringify(record).includes('此题错误答案'),false);
});
test('staged room clocks pause without reset and complete durable ranked history without secret words',async t=>{
  const f=await waiting(t);
  let view=await f.rooms.getView(f.code,identities[0]);
  f.setTime(f.now()+3000);await f.act(identities[0],'pause');await f.act(identities[1],'pause');
  view=await f.rooms.getView(f.code,identities[0]);assert.equal(view.phase,'paused');assert.equal(view.turnClock.remainingMs,12000);
  f.setTime(f.now()+60000);await f.act(identities[1],'resume');
  view=await f.rooms.getView(f.code,identities[0]);assert.equal(view.turnClock.deadlineAt,f.now()+12000);
  const secretWords=[];
  for(let turn=0;turn<4;turn++) {
    const probe=await f.rooms.getView(f.code,identities[0]);
    const drawer=probe.game.turnPlayerId,drawerKey=probe.players.findIndex(p=>p.id===drawer)===0?identities[0]:identities[1];
    const guessKey=drawerKey===identities[0]?identities[1]:identities[0];
    const choosing=await f.rooms.getView(f.code,drawerKey),choice=choosing.game.candidates[0];secretWords.push(choice.answer);
    await f.act(drawerKey,'choose',{matchId:choosing.matchId,turnId:choosing.game.turnId,candidateId:choice.id});
    await f.act(guessKey,'guess',{matchId:choosing.matchId,turnId:choosing.game.turnId,text:choice.answer});
    const revealing=await f.rooms.getView(f.code,drawerKey);f.setTime(revealing.turnClock.deadlineAt);await f.rooms.sweep();
  }
  view=await f.rooms.getView(f.code,identities[0]);assert.equal(view.phase,'finished');assert.equal(view.turnClock,null);
  await f.rooms.flushPendingRecords();const record=(await f.history.get(identities[0])).items[0];
  assert.equal(record.game,'draw-and-guess');assert.equal(record.self.score,450);assert.equal(record.self.rank,1);
  for(const word of secretWords)assert.equal(JSON.stringify(record).includes(word),false);
  assert.equal((await f.storage.scan('game-history'))[0].value.schemaVersion,2);
  const actor={userKey:identities[0],member:true},base=await f.wordbanks.get(actor,'dg-base');
  await f.wordbanks.change(actor,'dg-base',{requestId:`${f.now().toString(36)}-retire-after-match`,expectedDraftRevision:base.draftRevision,
    operations:[{type:'pack.status',retired:true,confirmed:true}]});
  const rematch=await f.act(identities[0],'rematch');
  assert.equal(rematch.view.phase,'waiting');assert.equal(rematch.view.drawConfig.contentSelection,null);
  assert.equal((await f.storage.scan('game-history'))[0].value.summary.matchId,record.matchId);
});
