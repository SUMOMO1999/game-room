import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { readSettings } from '../server/config.mjs';
import { closeRuntime } from '../server/production.mjs';
import { createWordbankRequestId } from '../server/content/draw-and-guess-wordbank.mjs';
import { createDrawAndGuessAdapter } from '../server/games/draw-and-guess/adapter.mjs';
import * as core from './games/draw-and-guess/rules.mjs';

const users=['a','b','c'].map(c=>c.repeat(64));
const code=expected=>error=>error.code===expected;
const words=n=>Array.from({length:n},(_,i)=>({id:`dg-count-${i+1}`,answer:`词${i+1}`,aliases:[],category:'daily',categoryName:'日常',
  difficulty:'easy',language:'zh',packId:'dg-test',packVersion:'1',definitionVersion:1,source:'原创测试',status:'reviewed',
  hintLength:[...`词${i+1}`].length,tags:[]}));
async function fixture(t) {
  let time=1791330000000;
  const now=()=>time,storage=new EncryptedStore(new MemoryAdapter({now}),randomBytes(32),now);
  const runtime=createRuntime(readSettings({GAME_ROOM_AUTH_MODE:'mock'}),{storage,now,drawingEnabled:true,
    roomOptions:{pollIntervalMs:0,serverRandomInt:()=>0},chatOptions:{pollIntervalMs:0}});
  t.after(()=>closeRuntime(runtime));await runtime.wordbankReady;await runtime.canvases.ready;
  const first=await runtime.rooms.createRoom(users[0],'画者','count-create','draw-and-guess'),roomCode=first.roomCode;
  await runtime.rooms.joinRoom(roomCode,users[1],'猜者','count-join');
  await runtime.rooms.joinRoom(roomCode,users[2],'观众','count-watch','spectator');
  const view=(user=users[0])=>runtime.rooms.getView(roomCode,user);
  const action=async(user,type,extra={})=>runtime.rooms.action(roomCode,user,{type,requestId:randomBytes(16).toString('hex'),expectedRevision:(await view(user)).revision,...extra});
  const snapshot=async()=>structuredClone((await storage.get('rooms',first.view.roomId)).snapshot);
  const ready=async()=>{for(const user of users.slice(0,2))await action(user,'ready',{ready:true});};
  return {...runtime,view,action,snapshot,ready,roomCode,now,setTime:value=>{time=value;}};
}

test('candidate counts 2/5/10 freeze complete distinct turns, allow last choice, and bound automatic selection',()=>{
  const adapter=createDrawAndGuessAdapter();
  for(const count of [2,5,10]) {
    const game=core.createGame(['drawer','guesser'],{settings:{rounds:1,candidateCount:count},matchId:'f'.repeat(32),now:1000,
      frozenCandidates:words(2*count)});
    assert.equal(core.gameProblem(game),null);assert.equal(core.candidatesForTurn(game).length,count);
    assert.equal(core.candidatesForTurn(game,2).length,count);
    assert.equal(new Set(game.frozenCandidates.map(word=>word.id)).size,count*2);
    const before=structuredClone(game),last=core.candidatesForTurn(game).at(-1);
    const chosen=core.applyChoose(game,'drawer',{turnId:game.turnId,candidateId:last.id},1001);
    assert.equal(chosen.ok,true);assert.equal(chosen.state.selectedWordId,last.id);assert.deepEqual(game,before);
    const timed=adapter.applyTimeout(game,'drawer',{now:game.stageClock.deadlineAt,serverRandomInt:maximum=>{assert.equal(maximum,count);return maximum-1;}});
    assert.equal(timed.ok,true);assert.equal(timed.state.selectedWordId,last.id);assert.deepEqual(timed.state.frozenCandidates,game.frozenCandidates);
    assert.equal(core.applyTimeout(game,{now:game.stageClock.deadlineAt,candidateIndex:count}).ok,false);
  }
  for(const candidateCount of [0,1,11,2.5,'5',null,undefined])assert.throws(()=>core.normalizeSettings({candidateCount}),/候选词/);
  assert.equal(core.normalizeSettings().candidateCount,3);
  const maximum=core.createGame(Array.from({length:8},(_,i)=>`player-${i}`),{settings:{rounds:5,candidateCount:10},
    matchId:'e'.repeat(32),now:1000,frozenCandidates:words(400)});
  assert.equal(core.gameProblem(maximum),null);assert.equal(core.candidatesForTurn(maximum,40).length,10);
});

test('real waiting configure retains host/stage/revision gates and five private candidates across later turns',async t=>{
  const f=await fixture(t);await f.ready();
  const initial=await f.view(),drawConfig={...initial.drawConfig,candidateCount:5};
  for(const user of users.slice(1))await assert.rejects(f.action(user,'configure',{drawConfig}),code('HOST_REQUIRED'));
  for(const candidateCount of [1,11,2.5,'5',null])await assert.rejects(f.action(users[0],'configure',{drawConfig:{...drawConfig,candidateCount}}),code('INVALID_CONFIG'));
  const before=await f.view(),body={type:'configure',expectedRevision:before.revision,drawConfig};
  const racing=await Promise.allSettled([5,6].map(candidateCount=>f.rooms.action(f.roomCode,users[0],{...body,
    requestId:`count-race-${candidateCount}`,drawConfig:{...drawConfig,candidateCount}})));
  assert.equal(racing.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(racing.find(result=>result.status==='rejected').reason.code,'REVISION_CONFLICT');
  assert.equal((await f.view()).players.every(player=>!player.ready),true);
  await assert.rejects(f.rooms.action(f.roomCode,users[0],{...body,requestId:'count-stale'}),code('REVISION_CONFLICT'));
  await f.action(users[0],'configure',{drawConfig});assert.equal((await f.snapshot()).drawConfig.candidateCount,5);
  await f.ready();const started=await f.action(users[0],'start');
  const saved=await f.snapshot(),frozen=structuredClone(saved.game.frozenCandidates);
  assert.equal(saved.schemaVersion,19);assert.equal(frozen.length,20);assert.equal(new Set(frozen.map(word=>word.id)).size,20);
  const matchId=started.view.matchId;
  await assert.rejects(f.action(users[0],'configure',{drawConfig:{...drawConfig,candidateCount:6}}),code('ROOM_LOCKED'));
  for(let turn=0;turn<4;turn++) {
    const publicView=await f.view(),drawerUser=publicView.game.turnPlayerId===publicView.players[0].id?users[0]:users[1],
      guesserUser=drawerUser===users[0]?users[1]:users[0];
    const drawer=await f.view(drawerUser),expected=frozen.slice(turn*5,(turn+1)*5);
    assert.deepEqual(drawer.game.candidates.map(word=>word.id),expected.map(word=>word.id));
    assert.deepEqual((await f.view(drawerUser)).game.candidates,drawer.game.candidates,'refresh cannot draw another candidate set');
    for(const user of [guesserUser,users[2]]) {
      const projected=await f.view(user);assert.equal(projected.game.candidates,undefined);assert.equal(projected.game.frozenCandidates,undefined);
      for(const word of frozen)assert.equal(JSON.stringify(projected).includes(`\"${word.answer}\"`),false);
    }
    const picked=drawer.game.candidates.at(-1),body={type:'choose',requestId:`count-choose-${turn}`,expectedRevision:drawer.revision,
      matchId,turnId:drawer.game.turnId,candidateId:picked.id};
    await f.rooms.action(f.roomCode,drawerUser,body);await f.rooms.action(f.roomCode,drawerUser,body);
    assert.equal((await f.view(drawerUser)).game.word.answer,picked.answer);
    await f.action(guesserUser,'guess',{matchId,turnId:drawer.game.turnId,text:picked.answer});
    const revealed=await f.view();f.setTime(revealed.turnClock.deadlineAt);await f.rooms.sweep();
    assert.deepEqual((await f.snapshot()).game.frozenCandidates,frozen);
  }
  assert.equal((await f.view()).phase,'finished');
  await f.action(users[0],'rematch');assert.equal((await f.view()).drawConfig.candidateCount,5);
});

test('real published small pool rejects five candidates and rejects a full match without changing config or starting',async t=>{
  const f=await fixture(t),actor={userKey:users[0],member:true},requestId=()=>createWordbankRequestId(f.now());
  const {packId}=await f.wordbanks.create(actor,{requestId:requestId(),name:'候选数量测试',visibility:'private'});
  const change=async operations=>{const current=await f.wordbanks.get(actor,packId);return f.wordbanks.change(actor,packId,
    {requestId:requestId(),expectedDraftRevision:current.draftRevision,operations});};
  const publish=async()=>{const current=await f.wordbanks.get(actor,packId),preview=await f.wordbanks.preview(actor,packId,
    {expectedDraftRevision:current.draftRevision,expectedPublishedHead:current.publishedHead});return f.wordbanks.publish(actor,packId,
    {requestId:requestId(),expectedDraftRevision:current.draftRevision,expectedPublishedHead:current.publishedHead,previewHash:preview.previewHash});};
  const add=index=>({type:'word.add',id:`count-small-${index}`,answer:`小词${index}`,category:'custom',difficulty:'easy',aliases:[],tags:[]});
  await change([0,1,2,3].map(add));await publish();
  const drawConfig={...(await f.view()).drawConfig,rounds:1,candidateCount:5,contentSelection:{packId,version:1,categoryIds:['custom'],difficulties:['easy']}};
  await assert.rejects(f.action(users[0],'configure',{drawConfig}),error=>error.code==='WORD_POOL_SMALL'&&/5/.test(error.message)&&/4/.test(error.message));
  assert.equal((await f.view()).drawConfig.candidateCount,3);
  await change([add(4)]);await publish();drawConfig.contentSelection.version=2;
  await f.action(users[0],'configure',{drawConfig});await f.ready();
  await assert.rejects(f.action(users[0],'start'),error=>error.code==='WORD_POOL_SMALL'&&/10/.test(error.message)&&/5/.test(error.message));
  const current=await f.snapshot();assert.equal(current.phase,'waiting');assert.equal(current.game,null);assert.equal(current.drawConfig.candidateCount,5);
});

test('fresh process imports real schema10/17 waiting and selected paused snapshots with missing count as three',async t=>{
  const f=await fixture(t),waiting=await f.snapshot();await f.ready();await f.action(users[0],'start');
  let view=await f.view();const picked=view.game.candidates[2];
  await f.action(users[0],'choose',{matchId:view.matchId,turnId:view.game.turnId,candidateId:picked.id});
  f.setTime(f.now()+1000);await f.action(users[0],'pause');await f.action(users[1],'pause');
  const paused=await f.snapshot(),snapshots=[];
  for(const schemaVersion of [10,17])for(const original of [waiting,paused]) {
    const saved=structuredClone(original);saved.schemaVersion=schemaVersion;delete saved.drawConfig.candidateCount;
    if(saved.game) {delete saved.game.settings.candidateCount;if(schemaVersion===10)delete saved.game.guessAttempts;}
    snapshots.push(saved);
  }
  const child=`import {readFileSync} from 'node:fs';import {createRoomStore} from './app/rooms.mjs';
    const {snapshots,now,users}=JSON.parse(readFileSync(0,'utf8'));
    const results=snapshots.map(snapshot=>{const rooms=createRoomStore({now:()=>now});rooms.importSnapshot(snapshot);
      const views=users.map(user=>rooms.getTrustedView(snapshot.code,user));const saved=rooms.exportSnapshot(snapshot.code);rooms.close();return {views,saved};});
    process.stdout.write(JSON.stringify(results));`;
  const restored=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',child],{cwd:process.cwd(),encoding:'utf8',
    input:JSON.stringify({snapshots,now:f.now(),users})}));
  for(const [index,result]of restored.entries()) {
    const original=snapshots[index];assert.equal(result.views[0].drawConfig.candidateCount,3);
    assert.deepEqual(result.saved.drawConfig,original.drawConfig);assert.deepEqual(result.saved.game,original.game);
    if(original.game) {
      assert.equal(result.views[0].game.settings.candidateCount,3);assert.equal(result.views[0].game.word.answer,picked.answer);
      assert.equal(result.views[1].game.word,undefined);assert.equal(result.views[2].game.word,undefined);
      assert.deepEqual(result.saved.turnClock,original.turnClock);assert.deepEqual(result.saved.game.frozenCandidates,paused.game.frozenCandidates);
    }
  }
});
