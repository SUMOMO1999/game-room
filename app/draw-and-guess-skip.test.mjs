import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { readSettings } from '../server/config.mjs';
import { closeRuntime } from '../server/production.mjs';
import { createDrawAndGuessAdapter } from '../server/games/draw-and-guess/adapter.mjs';
import * as core from './games/draw-and-guess/rules.mjs';
const users=['a','b','c','d'].map(c=>c.repeat(64)),code=expected=>error=>error.code===expected;
const words=n=>Array.from({length:n},(_,i)=>({id:`dg-skip-${i}`,answer:`词${i}`,aliases:[],category:'daily',categoryName:'日常',
  difficulty:'easy',language:'zh',packId:'dg-test',packVersion:'1',definitionVersion:1,source:'原创测试',status:'reviewed',hintLength:[...`词${i}`].length,tags:[]}));

test('skip is a current drawer decision during drawing, preserves scoring and creates a normal timed reveal',()=>{
  const adapter=createDrawAndGuessAdapter(),matchId='f'.repeat(32);
  let game=core.createGame(['drawer','peer','other'],{settings:{rounds:1,candidateCount:5},frozenCandidates:words(15),matchId,now:1000});
  const action={type:'skip',matchId,turnId:game.turnId};assert.equal(adapter.validateAction(action),null);
  for(const extra of [{candidateId:'dg-skip-0'},{text:'答案'},{reason:'timeout'},{frozenCandidates:words(15)}])assert.ok(adapter.validateAction({...action,...extra}));
  assert.equal(core.applySkip(game,'drawer',{turnId:game.turnId},1001).ok,false);
  game=core.applyChoose(game,'drawer',{turnId:game.turnId,candidateId:'dg-skip-4'},1001).state;
  game=core.applyGuess(game,'peer',{turnId:game.turnId,text:'错了'},1002).state;
  game=core.applyGuess(game,'other',{turnId:game.turnId,text:'词4'},1101).state;
  const before=structuredClone(game);
  for(const who of ['peer','other','outsider'])assert.equal(core.applySkip(game,who,{turnId:game.turnId},1102).code,'DRAWER_REQUIRED');
  assert.equal(core.applySkip(game,'drawer',{turnId:'dg-turn-2'},1102).ok,false);
  assert.equal(core.applySkip(game,'drawer',{turnId:game.turnId},game.stageClock.deadlineAt).ok,false);
  const skipped=adapter.applyGameAction(game,'drawer',action,{now:1102});assert.equal(skipped.ok,true);assert.deepEqual(game,before);
  assert.equal(core.gameProblem(skipped.state),null);assert.equal(skipped.state.stage,'reveal');assert.equal(skipped.state.turnResults[0].reason,'skipped');
  assert.deepEqual(skipped.state.players,before.players);assert.deepEqual(skipped.state.currentGuesses,before.currentGuesses);
  assert.deepEqual(skipped.state.guessAttempts,before.guessAttempts);assert.deepEqual(skipped.state.frozenCandidates,before.frozenCandidates);
  assert.equal(skipped.state.selectedWordId,before.selectedWordId);assert.equal(skipped.state.stageClock.deadlineAt,1102+core.REVEAL_MS);
  assert.equal(core.applySkip(skipped.state,'drawer',{turnId:game.turnId},1103).ok,false);
  const next=core.applyTimeout(skipped.state,{now:skipped.state.stageClock.deadlineAt});assert.equal(next.ok,true);
  assert.equal(next.state.stage,'choosing');assert.equal(next.state.turnNumber,2);assert.equal(core.candidatesForTurn(next.state).length,5);
  assert.deepEqual(next.state.frozenCandidates,before.frozenCandidates);
  const paused=core.pauseGame(game,1102).state;assert.equal(core.applySkip(paused,'drawer',{turnId:game.turnId},1103).ok,false);
});

test('a fully skipped match finishes with zero points and no fabricated winner',()=>{
  let game=core.createGame(['a','b'],{settings:{rounds:1,candidateCount:2},frozenCandidates:words(4),matchId:'e'.repeat(32),now:1000});
  while(game.status==='playing') {
    if(game.stage==='choosing')game=core.applyChoose(game,game.turnPlayerId,{turnId:game.turnId,candidateId:core.candidatesForTurn(game)[0].id},game.stageClock.startedAt).state;
    if(game.stage==='drawing')game=core.applySkip(game,game.turnPlayerId,{turnId:game.turnId},game.stageClock.startedAt).state;
    if(game.stage==='reveal')game=core.applyTimeout(game,{now:game.stageClock.deadlineAt}).state;
    assert.equal(core.gameProblem(game),null);
  }
  assert.deepEqual(game.players.map(player=>player.score),[0,0]);assert.deepEqual(game.result.winnerIds,[]);
  assert.equal(game.result.reason,'no-guesses');assert.deepEqual(game.turnResults.map(turn=>turn.reason),['skipped','skipped']);
});

async function fixture(t,sqlite) {
  let time=1791330000000;const now=()=>time,folder=mkdtempSync(join(tmpdir(),'drawing-skip-'));
  const storage=new EncryptedStore(sqlite?new SQLiteAdapter(join(folder,'records.sqlite'),{now}):new MemoryAdapter({now}),randomBytes(32),now);
  const runtime=createRuntime(readSettings({GAME_ROOM_AUTH_MODE:'mock'}),{storage,now,drawingEnabled:true,
    roomOptions:{pollIntervalMs:0,serverRandomInt:()=>0},chatOptions:{pollIntervalMs:0}});
  t.after(async()=>{await closeRuntime(runtime);rmSync(folder,{recursive:true,force:true});});await runtime.wordbankReady;await runtime.canvases.ready;
  const first=await runtime.rooms.createRoom(users[0],'房主画者','skip-create','draw-and-guess'),roomCode=first.roomCode;
  await runtime.rooms.joinRoom(roomCode,users[1],'猜者甲','skip-join-a');await runtime.rooms.joinRoom(roomCode,users[2],'猜者乙','skip-join-b');
  await runtime.rooms.joinRoom(roomCode,users[3],'观众','skip-watch','spectator');
  const view=(user=users[0])=>runtime.rooms.getView(roomCode,user);
  const action=async(user,type,extra={})=>runtime.rooms.action(roomCode,user,{type,requestId:randomBytes(16).toString('hex'),expectedRevision:(await view(user)).revision,...extra});
  const snapshot=async()=>structuredClone((await storage.get('rooms',first.view.roomId)).snapshot);
  await action(users[0],'configure',{drawConfig:{...(await view()).drawConfig,rounds:1,candidateCount:5}});
  for(const user of users.slice(0,3))await action(user,'ready',{ready:true});await action(users[0],'start');
  return {...runtime,view,action,snapshot,roomCode,now,setTime:value=>{time=value;}};
}

for(const sqlite of [false,true])test(`${sqlite?'SQLite':'Memory'}: skip receipt, authority, partial scores, late canvas commit and next turn stay isolated`,async t=>{
  const f=await fixture(t,sqlite);let view=await f.view(),turnId=view.game.turnId,matchId=view.matchId;
  assert.equal(view.game.canSkip,false);
  await assert.rejects(f.action(users[0],'skip',{matchId,turnId}),code('INVALID_GAME_ACTION'));
  const picked=view.game.candidates[4];await f.action(users[0],'choose',{matchId,turnId,candidateId:picked.id});
  for(const [index,user]of users.entries())assert.equal((await f.view(user)).game.canSkip,index===0);
  await f.action(users[1],'guess',{matchId,turnId,text:'只给自己看的错误'});await f.action(users[2],'guess',{matchId,turnId,text:picked.answer});
  for(const user of users.slice(1))await assert.rejects(f.action(user,'skip',{matchId,turnId}),error=>error.status===403||error.code==='DRAWER_REQUIRED');
  for(const user of users.slice(0,3))await f.action(user,'pause');
  assert.equal((await f.view()).game.canSkip,false);await assert.rejects(f.action(users[0],'skip',{matchId,turnId}),code('GAME_PAUSED'));
  await f.action(users[1],'resume');
  const paper=await f.canvases.read(f.roomCode,users[0]),auth={authorizationId:'skip-session'},lease=await f.canvases.acquire(f.roomCode,users[0],
    {deviceId:'skip-device',canvasId:paper.canvasId,bootId:paper.bootId},auth);
  const body={deviceId:'skip-device',canvasId:lease.canvasId,bootId:lease.bootId,leaseGeneration:lease.leaseGeneration,clearGeneration:0,expectedSequence:0,
    requestId:'skip-first-ink',operations:[{strokeId:'skip-stroke',tool:'pen',color:'#245c7c',width:4,points:[[.1,.2],[.2,.3]]}]};
  await f.canvases.append(f.roomCode,users[0],body,auth);
  const before=await f.snapshot(),frozen=structuredClone(before.game.frozenCandidates),scores=structuredClone(before.game.players);
  view=await f.view();const skip={type:'skip',requestId:'explicit-drawer-skip',expectedRevision:view.revision,matchId,turnId};
  await assert.rejects(f.rooms.action(f.roomCode,users[0],{...skip,requestId:'stale-skip',expectedRevision:view.revision-1}),code('REVISION_CONFLICT'));
  const originalTransaction=f.storage.compareAndSwapMany.bind(f.storage);let armed=true;
  f.storage.compareAndSwapMany=async transaction=>{
    if(armed&&transaction.changes.some(change=>change.scope==='draw-canvases'&&change.value?.kind==='canvas')) {
      armed=false;await f.rooms.action(f.roomCode,users[0],skip);
    }
    return originalTransaction(transaction);
  };
  // A definite concurrent commit is rechecked against the newest room stage.
  try {await assert.rejects(f.canvases.append(f.roomCode,users[0],{...body,requestId:'late-ink',expectedSequence:1},auth),code('CANVAS_STAGE_CLOSED'));}
  finally {f.storage.compareAndSwapMany=originalTransaction;}
  await assert.rejects(f.canvases.append(f.roomCode,users[0],{...body,requestId:'after-skip-ink',expectedSequence:1},auth),code('CANVAS_STAGE_CLOSED'));
  assert.equal(armed,false);const skipped=await f.snapshot();assert.equal(skipped.schemaVersion,19);
  assert.equal(skipped.game.stage,'reveal');assert.equal(skipped.game.turnResults[0].reason,'skipped');assert.equal(skipped.game.turnNumber,1);
  assert.deepEqual(skipped.game.players,scores);assert.deepEqual(skipped.game.frozenCandidates,frozen);
  assert.deepEqual(skipped.game.guessAttempts,before.game.guessAttempts);assert.equal(skipped.game.selectedWordId,before.game.selectedWordId);
  const afterPaper=await f.canvases.read(f.roomCode,users[0]);assert.equal(afterPaper.sequence,1);assert.equal(afterPaper.pointCount,2);
  const duplicate=await f.rooms.action(f.roomCode,users[0],skip);assert.equal(duplicate.view.game.stage,'reveal');assert.equal((await f.snapshot()).game.turnResults.length,1);
  for(const user of users) {
    const revealed=await f.view(user);assert.equal(revealed.game.canSkip,false);assert.equal(revealed.game.word.answer,picked.answer);
    assert.equal(revealed.game.turnResult.guesses.some(item=>item.attempts.some(attempt=>attempt.text==='只给自己看的错误')),true);
  }
  const child=`import {readFileSync}from'node:fs';import{createRoomStore}from'./app/rooms.mjs';
    const{snapshot,user,now}=JSON.parse(readFileSync(0,'utf8'));const rooms=createRoomStore({now:()=>now});rooms.importSnapshot(snapshot);
    const view=rooms.getTrustedView(snapshot.code,user);process.stdout.write(JSON.stringify({view,snapshot:rooms.exportSnapshot(snapshot.code)}));rooms.close();`;
  const restored=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',child],{cwd:process.cwd(),encoding:'utf8',
    input:JSON.stringify({snapshot:skipped,user:users[0],now:f.now()})}));
  assert.deepEqual(restored.snapshot,skipped);assert.equal(restored.view.game.turnResult.reason,'skipped');
  f.setTime((await f.view()).turnClock.deadlineAt);await f.rooms.sweep();
  const replay=await f.rooms.action(f.roomCode,users[0],skip);assert.equal(replay.view.game.turnNumber,2);assert.equal(replay.view.game.stage,'choosing');
  assert.equal((await f.snapshot()).game.turnResults.length,1);
  view=await f.view(users[1]);await f.action(users[1],'choose',{matchId,turnId:view.game.turnId,candidateId:view.game.candidates[0].id});
  await assert.rejects(f.action(users[0],'skip',{matchId,turnId:view.game.turnId}),code('DRAWER_REQUIRED'));
  for(let index=1;index<3;index++) {
    view=await f.view(users[index]);
    if(view.game.stage==='choosing')await f.action(users[index],'choose',{matchId,turnId:view.game.turnId,candidateId:view.game.candidates[0].id});
    await f.action(users[index],'skip',{matchId,turnId:view.game.turnId});f.setTime((await f.view()).turnClock.deadlineAt);await f.rooms.sweep();
  }
  assert.equal((await f.view()).phase,'finished');assert.deepEqual((await f.snapshot()).game.players,scores);
  await assert.rejects(f.action(users[2],'skip',{matchId,turnId:'dg-turn-3'}),code('GAME_NOT_PLAYING'));
});
