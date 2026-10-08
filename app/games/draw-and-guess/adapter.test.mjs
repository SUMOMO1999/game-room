import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDrawAndGuessAdapter, drawConfigProblem } from '../../../server/games/draw-and-guess/adapter.mjs';
import { requireAdapter } from '../../../server/games/adapter-contract.mjs';
import * as core from './rules.mjs';

const adapter=createDrawAndGuessAdapter(),matchId='f'.repeat(32),ids=n=>Array.from({length:n},(_,i)=>(i+1).toString(16).repeat(32));
const people=n=>ids(n).map((id,i)=>({id,name:`玩家${i+1}`,ready:true,userKey:(i+1).toString(16).repeat(64)}));
const words=n=>Array.from({length:n},(_,i)=>({id:`dg-word-${i+1}`,answer:`秘密${i+1}`,aliases:[`认可${i+1}`],category:'daily',categoryName:'日常',
  difficulty:'easy',language:'zh',packId:'dg-test',packVersion:'1',definitionVersion:1,source:'原创测试',status:'reviewed',
  hintLength:[...`秘密${i+1}`].length,tags:[],drawingCue:'不入游戏'}));
const config=()=>({rounds:2,drawingSeconds:120,contentSelection:{packId:'dg-test',version:1,categoryIds:['daily'],difficulties:['easy']}});
const waiting=(n=2)=>({schemaVersion:10,gameType:core.GAME_TYPE,phase:'waiting',players:people(n),spectators:[],hostId:ids(n)[0],game:null,drawConfig:config(),turnClock:null});
const create=(n=2)=>adapter.createGame(people(n),{settings:{rounds:2,drawingSeconds:120},frozenCandidates:words(n*6),matchId,now:1000,firstPlayerIndex:0});
const checked=r=>{assert.equal(r.ok,true,r.error);assert.equal(core.gameProblem(r.state),null);return r.state;};
const choose=(g,now=g.stageClock.startedAt)=>checked(adapter.applyGameAction(g,g.turnPlayerId,
  {type:'choose',matchId:g.matchId,turnId:g.turnId,candidateId:core.candidatesForTurn(g)[0].id},{now}));
const clock=game=>{const {key,...value}=adapter.gameClock(game);return value===null?null:{version:2,...value,stageKey:key,
  firstPlayerId:game.players[game.firstPlayerIndex].id,matchId:game.matchId,round:game.round,playerId:game.turnPlayerId};};
const snapshot=(phase='playing')=>{
  const room=waiting();room.game=choose(create());room.phase=phase;room.matchId=matchId;room.matchStartedAt=1000;
  room.matchParticipants=room.players.map(({id,name,userKey})=>({playerId:id,name,userKey}));
  if(phase==='paused')room.game=checked(adapter.onPhaseChanged(room.game,'paused',1100));
  room.turnClock=clock(room.game);
  if(phase==='aborted'){room.turnClock=null;room.matchEndedAt=1200;room.abortedResult={reason:'player-left',winnerIds:[],scores:[],tie:false,aborted:true};}
  return room;
};
const containsSecret=(view,game)=>game.frozenCandidates.some(word=>JSON.stringify(view).includes(word.answer)
  || JSON.stringify(view).includes(word.aliases[0])||JSON.stringify(view).includes(`"${word.id}"`));

test('complete isolated server adapter contract, phase clock v2 seam and native results',()=>{
  assert.equal(requireAdapter(adapter),adapter);assert.equal(Object.isFrozen(adapter),true);
  assert.deepEqual(adapter.actionTypes,['choose','guess']);assert.deepEqual(adapter.concurrentActionTypes,['guess']);
  assert.deepEqual(adapter.configurationFields,['drawConfig']);assert.equal(adapter.snapshotSchema(),10);
  assert.deepEqual(adapter.roomDefaults(),{drawConfig:{rounds:2,drawingSeconds:120,contentSelection:null},turnClock:null});
  assert.equal(drawConfigProblem(adapter.roomDefaults().drawConfig),null);
  assert.ok(drawConfigProblem(adapter.roomDefaults().drawConfig,{allowUnselected:false}));
  const g=create(),c=adapter.gameClock(g);assert.equal(c.key,`${matchId}:dg-turn-1:choosing`);assert.equal(c.durationMs,15000);
  const d=choose(g);assert.equal(adapter.gameClock(d).key,`${matchId}:dg-turn-1:drawing`);assert.equal(adapter.gameClock(d).durationMs,120000);
  assert.equal(adapter.gameClock(d).deadlineAt,121000);
  assert.deepEqual(adapter.playerResult(null,ids(2)[0]),{outcome:'unscored',score:null,rank:null});
});

test('server gameOptions validates full frozen pool before one bounded first-player sample',()=>{
  let samples=0;const room=waiting(8),pool=words(48),opts={now:1000,matchId,frozenCandidates:pool,
    firstPlayerIndex:0,seed:'client',random:()=>{throw new Error('legacy');},serverRandomInt:max=>{samples++;assert.equal(max,8);return 7;}};
  const selected=adapter.gameOptions(room,opts);assert.equal(selected.firstPlayerIndex,7);assert.equal(samples,1);
  assert.equal(adapter.createGame(room.players,selected).turnPlayerId,ids(8)[7]);assert.equal(Object.hasOwn(selected,'seed'),false);
  for(const change of [r=>r.phase='playing',r=>r.players.pop(),r=>r.drawConfig.contentSelection.version=2]) {
    const value=structuredClone(room);change(value);const before=structuredClone(value);
    assert.throws(()=>adapter.gameOptions(value,opts));assert.deepEqual(value,before);
  }
  assert.equal(samples,1);
  for(const source of [null,()=>-1,()=>8,()=>.5,()=>{throw new Error('private');}])assert.throws(()=>adapter.gameOptions(room,{...opts,serverRandomInt:source}),/服务端随机/);
});

test('exact action and configuration boundaries reject candidate injection, stale match and wrong stage',()=>{
  const g=create(),action={type:'choose',matchId,turnId:g.turnId,candidateId:g.frozenCandidates[0].id};
  assert.equal(adapter.validateAction(action),null);assert.equal(adapter.validateAction({type:'ready',ready:true}),null);
  for(const extra of [{frozenCandidates:words(12)},{answer:'秘密1'},{die:6},{seed:'client'}])assert.ok(adapter.validateAction({...action,...extra}));
  assert.equal(adapter.applyGameAction(g,g.turnPlayerId,{...action,matchId:'a'.repeat(32)},{now:1100}).ok,false);
  assert.equal(adapter.applyGameAction(g,g.turnPlayerId,action,{now:1100,phase:'paused'}).ok,false);
  assert.equal(adapter.applyGameAction(g,ids(2)[1],action,{now:1100}).ok,false);
  const d=choose(g);assert.equal(adapter.applyGameAction(d,ids(2)[1],{type:'guess',matchId,turnId:'dg-turn-2',text:'秘密1'},{now:1100}).ok,false);
  const changed=adapter.configure(waiting(),{type:'configure',drawConfig:config()});assert.deepEqual(changed,{updates:{drawConfig:config()}});
  for(const invalid of [{...config(),frozenCandidates:words(12)},{...config(),drawingSeconds:29},{...config(),contentSelection:{...config().contentSelection,version:0}},
    {...config(),contentSelection:{...config().contentSelection,categoryIds:[]}}, {...config(),contentSelection:{...config().contentSelection,categoryIds:Array(1)}},
    {...config(),contentSelection:{...config().contentSelection,difficulties:['easy','easy']}}])assert.ok(adapter.configure(waiting(),{drawConfig:invalid}).problem);
});

test('white-list private/public projection never exposes future candidates, internal word IDs or wrong input',()=>{
  const g=create(3),observer=adapter.spectatorView(g,{now:1000}),guesser=adapter.privateView(g,ids(3)[1],{now:1000});
  assert.equal(containsSecret(observer,g),false);assert.equal(containsSecret(guesser,g),false);
  const drawer=adapter.privateView(g,g.turnPlayerId,{now:1000});assert.equal(drawer.candidates.length,3);assert.equal(drawer.canChoose,true);
  assert.equal(JSON.stringify(drawer).includes(g.frozenCandidates[3].answer),false);assert.equal(drawer.frozenCandidates,undefined);
  assert.throws(()=>adapter.privateView(g,'outsider',{now:1000}),/参赛/);
  const d=choose(g),dv=adapter.privateView(d,d.turnPlayerId,{now:1000}),gv=adapter.privateView(d,ids(3)[1],{now:1000});
  assert.equal(dv.word.answer,'秘密1');assert.deepEqual(dv.word.aliases,['认可1']);assert.equal(dv.word.id,undefined);
  assert.equal(containsSecret(gv,d),false);assert.equal(gv.hint.hintLength,3);assert.equal(gv.canGuess,true);assert.equal(gv.canDraw,false);
  const sv=adapter.spectatorView(d,{now:1000});assert.equal(sv.canGuess,false);assert.equal(sv.canDraw,false);assert.equal(containsSecret(sv,d),false);
  const paused=adapter.privateView(d,d.turnPlayerId,{now:1000,phase:'paused'});assert.equal(paused.canDraw,false);
  const expired=adapter.privateView(d,ids(3)[1],{now:d.stageClock.deadlineAt});assert.equal(expired.canGuess,false);
  drawer.candidates[0].answer='改动';assert.equal(g.frozenCandidates[0].answer,'秘密1');
  let reveal=checked(adapter.applyTimeout(d,d.turnPlayerId,{now:d.stageClock.deadlineAt}));
  const rv=adapter.spectatorView(reveal,{now:reveal.stageClock.startedAt});assert.equal(rv.word.answer,'秘密1');
  assert.equal(JSON.stringify(rv).includes('秘密2'),false);assert.equal(JSON.stringify(rv).includes('秘密4'),false);
  assert.equal(JSON.stringify(rv).includes('dg-word-1'),false);assert.equal(rv.selectedWordId,undefined);assert.equal(rv.turnResults,undefined);
});

test('wrong guesses remain private and only accepted correct guess produces announcement',()=>{
  const g=choose(create(3)),wrong=adapter.applyGameAction(g,ids(3)[1],{type:'guess',matchId,turnId:g.turnId,text:'私人猜错'}, {now:1100});
  assert.equal(wrong.ok,true);assert.equal(wrong.guessResult.correct,false);
  assert.equal(adapter.describeAction({action:{type:'guess'},player:{id:ids(3)[1],name:'乙'},afterGame:wrong.state,guessResult:wrong.guessResult}),null);
  assert.equal(JSON.stringify(adapter.spectatorView(wrong.state,{now:1100})).includes('私人猜错'),false);
  const yes=adapter.applyGameAction(g,ids(3)[1],{type:'guess',matchId,turnId:g.turnId,text:'认可1'},{now:31000});checked(yes);
  assert.equal(adapter.describeAction({action:{type:'guess'},player:{id:ids(3)[1],name:'乙'},afterGame:yes.state,guessResult:yes.guessResult}),'乙猜中了，加175分。');
  assert.equal(adapter.spectatorView(yes.state,{now:31000}).lastAction.playerId,ids(3)[1]);
  assert.equal(adapter.privateView(yes.state,ids(3)[1],{now:31000}).canGuess,false);
});

test('ordinary chat does not bypass private guessed answer or accepted aliases; revealed chat resumes',()=>{
  const g=choose(create(3));for(const text of ['秘密1','我猜「秘 密１！」','前文\n认可1\n后文'])assert.equal(adapter.chatProblem(g,text).code,'ANSWER_IN_CHAT');
  assert.equal(adapter.chatProblem(g,'大家加油\n继续画'),null);assert.equal(adapter.chatProblem(g,'<img>').code,'INVALID_CHAT');
  const reveal=checked(adapter.applyTimeout(g,g.turnPlayerId,{now:g.stageClock.deadlineAt}));assert.equal(adapter.chatProblem(reveal,'秘密1'),null);
  assert.equal(adapter.chatProblem(create(3),'秘密1'),null);
});

test('timeout samples only expired choosing and phase hook freezes original game deadline',()=>{
  const g=create();let samples=0;const source=max=>{assert.equal(max,3);samples++;return 2;};
  assert.equal(adapter.applyTimeout(g,g.turnPlayerId,{now:15999,serverRandomInt:source}).ok,false);assert.equal(samples,0);
  const drawing=checked(adapter.applyTimeout(g,g.turnPlayerId,{now:16000,serverRandomInt:source}));assert.equal(samples,1);
  assert.equal(drawing.selectedWordId,g.frozenCandidates[2].id);const paused=checked(adapter.onPhaseChanged(drawing,'paused',17000));
  assert.equal(adapter.applyTimeout(paused,paused.turnPlayerId,{now:999999,serverRandomInt:source}).ok,false);assert.equal(samples,1);
  const resumed=checked(adapter.onPhaseChanged(paused,'playing',900000));assert.equal(resumed.stageClock.deadlineAt,1019000);
  const revealed=checked(adapter.applyTimeout(resumed,resumed.turnPlayerId,{now:resumed.stageClock.deadlineAt,serverRandomInt:source}));assert.equal(samples,1);
  const next=checked(adapter.applyTimeout(revealed,revealed.turnPlayerId,{now:revealed.stageClock.deadlineAt,serverRandomInt:source}));assert.equal(samples,1);assert.equal(next.turnId,'dg-turn-2');
});

test('schema10 strict state restore covers waiting/playing/paused/aborted and rejects aliasing seats/clock/private config drift',()=>{
  assert.equal(adapter.roomStateProblem(waiting(),true),null);
  for(const phase of ['playing','paused','aborted'])assert.equal(adapter.roomStateProblem(snapshot(phase),true),null,phase);
  assert.equal(adapter.snapshotProblem(waiting()),false);assert.equal(adapter.snapshotProblem({...waiting(),schemaVersion:9}),true);
  const changes=[r=>r.turnClock.stageKey='old',r=>r.turnClock.remainingMs++,r=>r.matchId='a'.repeat(32),
    r=>r.players.reverse(),r=>r.matchParticipants[0].name='伪装',r=>r.drawConfig.contentSelection.version=2,
    r=>r.players[1].userKey=r.players[0].userKey,r=>r.phase='paused'];
  for(const change of changes){const room=snapshot();change(room);assert.ok(adapter.roomStateProblem(room,true));}
  assert.ok(adapter.roomStateProblem({...waiting(),jokerConfig:{}},true));assert.ok(adapter.roomStateProblem(waiting(),false));
});

test('finished room restores original stable seats and only exposes last revealed word plus native scores',()=>{
  let game=create();while(game.status==='playing') {
    if(game.stage==='choosing')game=choose(game);
    if(game.stage==='drawing') {
      const guesser=game.players.find(p=>p.id!==game.turnPlayerId);
      game=checked(adapter.applyGameAction(game,guesser.id,{type:'guess',matchId,turnId:game.turnId,text:core.selectedWord(game).answer},{now:game.stageClock.startedAt+1000}));
    }
    if(game.stage==='reveal')game=checked(adapter.applyTimeout(game,game.turnPlayerId,{now:game.stageClock.deadlineAt}));
  }
  const room=snapshot();room.game=game;room.phase='finished';room.turnClock=null;room.matchEndedAt=1000000;
  assert.equal(adapter.gameClock(game),null);assert.equal(adapter.roomStateProblem(JSON.parse(JSON.stringify(room)),true),null);
  const view=adapter.spectatorView(game,{now:1000000});assert.equal(view.word.answer,'秘密10');assert.equal(view.canGuess,false);
  assert.equal(JSON.stringify(view).includes('秘密1"'),false);assert.equal(view.result.scores.every(p=>p.rank===1),true);
  assert.equal(view.result.scores.some(p=>Object.hasOwn(p,'remainingPoints')),false);
  room.players.pop();assert.equal(adapter.roomStateProblem(room,true),null);
  room.players[0].userKey='a'.repeat(64);assert.ok(adapter.roomStateProblem(room,true));
});

test('native score/rank archive explicitly distinguishes tied/no-guesses/aborted; public code imports no server answers',()=>{
  const result=core.resultFor({players:[{id:'a',score:200},{id:'b',score:200},{id:'c',score:25}]});
  assert.deepEqual(adapter.playerResult(result,'a'),{outcome:'draw',score:200,rank:1});
  assert.deepEqual(adapter.playerResult(result,'c'),{outcome:'loss',score:25,rank:3});
  assert.equal(adapter.historyPlayerProblem('completed',{outcome:'draw',score:200,rank:1}),false);
  assert.equal(adapter.historyPlayerProblem('completed',{outcome:'unscored',score:0,rank:null}),false);
  assert.equal(adapter.historyPlayerProblem('aborted',{outcome:'unscored',score:null,rank:null}),false);
  assert.equal(adapter.historyPlayerProblem('completed',{outcome:'draw',score:200,rank:1,remainingPoints:200}),true);
  assert.equal(adapter.historyOutcomeProblem(0,0,8),false);assert.equal(adapter.historyOutcomeProblem(0,2,8),false);
  for(const file of ['rules.mjs','matcher.mjs']) {
    const source=readFileSync(new URL(file,import.meta.url),'utf8');assert.doesNotMatch(source,/from ['"].*(?:server|seed|wordbank)/u);
    assert.doesNotMatch(source,/\b(?:document|localStorage|Date\.now|randomInt)\b/u);
  }
});
