import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './games/draw-and-guess/rules.mjs';
import { normalizeDrawAndGuessGuess } from './games/draw-and-guess/matcher.mjs';

const matchId='f'.repeat(32), ids=n=>Array.from({length:n},(_,i)=>String(i+1).repeat(32));
const words=n=>Array.from({length:n},(_,i)=>({id:`dg-word-${i+1}`,answer:`词${i+1}`,aliases:[`别名${i+1}`],
  category:'daily',categoryName:'日常',difficulty:'easy',language:'zh',packId:'dg-test',packVersion:'1',
  definitionVersion:1,source:'原创测试',status:'reviewed',hintLength:[...`词${i+1}`].length,tags:[],drawingCue:'仅管理可见'}));
const create=(n=2,settings={rounds:2,drawingSeconds:120},first=0)=>core.createGame(ids(n),
  {settings,firstPlayerIndex:first,frozenCandidates:words(n*settings.rounds*3),matchId,now:1000});
const checked=r=>{assert.equal(r.ok,true,r.error);assert.equal(core.gameProblem(r.state),null);return r.state;};
const choose=(g,at=g.stageClock.startedAt)=>checked(core.applyChoose(g,g.turnPlayerId,
  {turnId:g.turnId,candidateId:core.candidatesForTurn(g)[0].id},at));
const guess=(g,id,at,text=core.selectedWord(g).answer)=>core.applyGuess(g,id,{turnId:g.turnId,text},at);
const timeout=(g,extra={})=>checked(core.applyTimeout(g,{now:g.stageClock.deadlineAt,expectedTurnId:g.turnId,expectedStage:g.stage,candidateIndex:1,...extra}));
test('warmed frozen text never approves changed game metadata or a different field bound',()=>{
  const game=create();assert.equal(core.gameProblem(game),null);
  for(const change of [
    g=>{g.frozenCandidates[0].hintLength++;},g=>{g.frozenCandidates[0].status='draft';},
    g=>{g.frozenCandidates[0].id=g.frozenCandidates[1].id;},
    g=>{g.frozenCandidates[0].aliases=[g.frozenCandidates[1].answer];},
    g=>{g.players[0].score=1;},g=>{g.stageClock.deadlineAt++;},
    g=>{g.frozenCandidates[0].answer=new String(g.frozenCandidates[0].answer);},
    g=>{g.frozenCandidates[0].answer='\u200d';},g=>{g.frozenCandidates[0].answer='A\u030a';},
  ]) {const changed=structuredClone(game);change(changed);assert.notEqual(core.gameProblem(changed),null);}
  const longSource='字'.repeat(33),sourceGame=structuredClone(game);
  sourceGame.frozenCandidates[0].source=longSource;assert.equal(core.gameProblem(sourceGame),null);
  sourceGame.frozenCandidates[0].answer=longSource;sourceGame.frozenCandidates[0].hintLength=33;
  assert.notEqual(core.gameProblem(sourceGame),null,'a permitted source cannot warm an oversized answer');
  assert.equal(core.gameProblem(game),null);
});
test('frozen word validation keeps its result after bounded text cache churn',()=>{
  const original=create();assert.equal(core.gameProblem(original),null);
  for(let batch=0;batch<50;batch++) {
    const entries=words(12).map((word,index)=>({...word,answer:`新增${batch}词${index}`,aliases:[],
      hintLength:[...`新增${batch}词${index}`].length,source:`自写来源${batch}条${index}`}));
    assert.equal(core.freezeCandidates(entries).length,12);
  }
  assert.equal(core.gameProblem(original),null);
  const invalid=structuredClone(original);invalid.frozenCandidates[0].source='\u2800';
  assert.notEqual(core.gameProblem(invalid),null);assert.equal(core.gameProblem(original),null);
});
function complete(count,first=0,allCorrect=true) {
  let g=create(count,{rounds:2,drawingSeconds:120},first);
  const order=[];
  while(g.status==='playing') {
    if(g.stage==='choosing') {order.push(g.turnPlayerId);g=choose(g);}
    if(g.stage==='drawing') {
      if(allCorrect) for(const p of g.players.filter(p=>p.id!==g.turnPlayerId)) g=checked(guess(g,p.id,g.stageClock.startedAt+30000));
      else g=timeout(g);
    }
    if(g.stage==='reveal') g=timeout(g);
  }
  return {g,order};
}

test('defaults, bounded trusted inputs, immutable complete frozen candidate definitions',()=>{
  const g=create();assert.equal(core.gameProblem(g),null);assert.deepEqual(g.settings,core.DEFAULT_SETTINGS);
  assert.equal(g.frozenCandidates.length,12);assert.equal(g.frozenCandidates[0].drawingCue,undefined);
  const input=words(12),before=structuredClone(input);
  const game=core.createGame(ids(2),{frozenCandidates:input,matchId,now:1000});input[0].aliases.push('后改');
  assert.equal(game.frozenCandidates[0].aliases.length,1);assert.equal(before[0].aliases.length,1);
  for(const settings of [{rounds:0,drawingSeconds:120},{rounds:6,drawingSeconds:120},{rounds:2,drawingSeconds:29},{rounds:2,drawingSeconds:601}]) assert.throws(()=>create(2,settings));
  for(const n of [1,9]) assert.throws(()=>create(n));
  assert.throws(()=>core.createGame([ids(2)[0],ids(2)[0]],{frozenCandidates:words(12),matchId,now:1000}));
  assert.throws(()=>core.createGame(ids(2),{frozenCandidates:words(11),matchId,now:1000}));
  assert.throws(()=>core.createGame(ids(2),{frozenCandidates:words(12),matchId:'client',now:1000}));
  const duplicate=words(12);duplicate[1].aliases=[duplicate[0].answer];assert.throws(()=>core.freezeCandidates(duplicate),/歧义/);
  assert.equal(create(8,{rounds:5,drawingSeconds:600}).frozenCandidates.length,120);
});

test('full 2-player and 8-player matches preserve first player, rounds, exact scores and tied ranks',()=>{
  for(const count of [2,8]) for(const first of [0,count-1]) {
    const {g,order}=complete(count,first);assert.equal(g.status,'finished');assert.equal(g.stage,'finished');
    assert.equal(g.turnResults.length,count*2);assert.equal(g.stageClock,null);
    assert.deepEqual(order,Array.from({length:count*2},(_,i)=>ids(count)[(first+i)%count]));
    const expected=2*(count-1)*(175+25);
    assert.deepEqual(g.players.map(p=>p.score),Array(count).fill(expected));
    assert.deepEqual(g.result.winnerIds,ids(count));assert.equal(g.result.tie,true);
    assert.deepEqual(g.result.scores.map(p=>p.rank),Array(count).fill(1));
    assert.equal(Object.hasOwn(g.result.scores[0],'remainingPoints'),false);
    assert.equal(core.gameProblem(JSON.parse(JSON.stringify(g))),null);
  }
});

test('all zero completion has no fake winner and ranking uses 1,1,3 ties',()=>{
  const {g}=complete(2,0,false);assert.equal(g.result.reason,'no-guesses');assert.deepEqual(g.result.winnerIds,[]);
  assert.deepEqual(g.result.scores.map(p=>p.rank),[null,null]);assert.equal(g.result.tie,false);
  assert.deepEqual(core.resultFor({players:[{id:'a',score:10},{id:'b',score:10},{id:'c',score:2}]}).scores.map(p=>p.rank),[1,1,3]);
});

test('select only current three, only drawer, no mutation and timeout selection does not refresh candidates',()=>{
  const g=create(),before=structuredClone(g),current=core.candidatesForTurn(g);
  for(const [actor,candidateId] of [[ids(2)[1],current[0].id],[g.turnPlayerId,g.frozenCandidates[3].id]]) {
    assert.equal(core.applyChoose(g,actor,{turnId:g.turnId,candidateId},1100).ok,false);assert.deepEqual(g,before);
  }
  assert.equal(core.applyChoose(g,g.turnPlayerId,{turnId:'dg-turn-2',candidateId:current[0].id},1100).ok,false);
  assert.equal(core.applyChoose(g,g.turnPlayerId,{turnId:g.turnId,candidateId:current[0].id},g.stageClock.deadlineAt).ok,false);
  assert.equal(core.applyTimeout(g,{now:g.stageClock.deadlineAt,candidateIndex:3}).ok,false);
  const chosen=timeout(g);assert.equal(chosen.selectedWordId,current[1].id);assert.deepEqual(chosen.frozenCandidates,g.frozenCandidates);
  assert.equal(core.applyTimeout(chosen,{now:chosen.stageClock.deadlineAt,expectedStage:'choosing',expectedTurnId:g.turnId,candidateIndex:2}).ok,false);
});

test('exact aliases, private wrong feedback, guessed player and illegal roles never double score',()=>{
  let g=choose(create(3));const before=structuredClone(g),word=core.selectedWord(g);
  for(const id of [g.turnPlayerId,'outsider']) assert.equal(guess(g,id,1100).ok,false);
  for(const text of ['词','ci1','这是'+word.answer]) {
    const result=guess(g,ids(3)[1],1100,text);assert.equal(result.ok,true);assert.equal(result.guessResult.correct,false);
  }
  for(const text of ['<script>','词\n1','']) assert.equal(guess(g,ids(3)[1],1100,text).ok,false);
  const wrong=guess(g,ids(3)[1],1100,'不是');assert.equal(wrong.ok,true);assert.deepEqual(wrong.guessResult,{correct:false,points:0});
  assert.deepEqual(wrong.state,g);assert.deepEqual(g,before);
  const correct=guess(g,ids(3)[1],31000,`（ ${word.aliases[0]}！）`);g=checked(correct);
  assert.equal(correct.guessResult.points,175);assert.equal(g.players[0].score,25);assert.equal(g.players[1].score,175);
  assert.equal(guess(g,ids(3)[1],32000).ok,false);assert.equal(g.currentGuesses.length,1);
  assert.equal(JSON.stringify(g).includes('不是'),false);
  assert.equal(normalizeDrawAndGuessGuess('「ＡＢＣ１２！」'),'abc12');
});

test('simultaneous guesses judged against latest state enter reveal once; deadline equality never scores',()=>{
  let g=choose(create(3)),at=g.stageClock.startedAt+60000;
  g=checked(guess(g,ids(3)[1],at));assert.equal(g.stage,'drawing');
  g=checked(guess(g,ids(3)[2],at));assert.equal(g.stage,'reveal');assert.equal(g.turnResults.length,1);
  assert.equal(g.players[0].score,50);assert.deepEqual(g.players.slice(1).map(p=>p.score),[150,150]);
  assert.equal(guess(g,ids(3)[2],at).ok,false);
  assert.equal(core.applyTimeout(g,{now:at,expectedStage:'drawing',expectedTurnId:g.turnId}).ok,false);
  const drawing=choose(create()),deadline=drawing.stageClock.deadlineAt;
  assert.equal(guess(drawing,ids(2)[1],deadline).ok,false);
  const late=timeout(drawing);assert.equal(late.stage,'reveal');assert.deepEqual(late.players.map(p=>p.score),[0,0]);
  assert.equal(core.applyTimeout(late,{now:deadline,expectedStage:'drawing',expectedTurnId:late.turnId}).ok,false);
});

test('pause every phase preserves selected word, remaining time, and original scoring denominator',()=>{
  for(const stage of ['choosing','drawing','reveal']) {
    let g=create();if(stage!=='choosing')g=choose(g);if(stage==='reveal')g=timeout(g);
    const saved=structuredClone(g),at=g.stageClock.startedAt+1000;
    const paused=checked(core.pauseGame(g,at));assert.equal(paused.stageClock.deadlineAt,null);assert.equal(paused.stageClock.pausedAt,at);
    assert.equal(core.applyTimeout(paused,{now:at+999999,candidateIndex:0}).ok,false);
    assert.equal(core.pauseGame(paused,at+1).ok,false);
    const resumed=checked(core.resumeGame(paused,at+999999));
    assert.equal(resumed.selectedWordId,saved.selectedWordId);assert.deepEqual(resumed.frozenCandidates,saved.frozenCandidates);
    assert.equal(resumed.stageClock.remainingMs,saved.stageClock.remainingMs-1000);
    assert.equal(resumed.stageClock.durationMs,saved.stageClock.durationMs);
  }
  let g=choose(create());g=checked(core.pauseGame(g,81000));g=checked(core.resumeGame(g,1000000));
  const r=guess(g,ids(2)[1],1000000);assert.equal(r.guessResult.points,133);checked(r);
});

test('corrupt restored state fails closed: fields, score, clocks, future ID, incomplete/full guessed stage and result',()=>{
  const drawing=choose(create(3)),finished=complete(2).g;
  const changes=[g=>{g.extra='secret';},g=>{g.players[1].score=200;},g=>{g.stageClock.deadlineAt++;},
    g=>{g.turnId='dg-turn-2';},g=>{g.frozenCandidates[0].aliases.push(g.frozenCandidates[1].answer);},
    g=>{g.frozenCandidates[0].source='\u2800';},g=>{g.lastAction.turnId='dg-turn-40';},g=>{g.lastAction.points=100;}];
  for(const change of changes){const g=structuredClone(drawing);change(g);assert.ok(core.gameProblem(g));}
  const result=structuredClone(finished);result.result.scores[0].score++;assert.ok(core.gameProblem(result));
  const reordered=JSON.parse(JSON.stringify(drawing));reordered.frozenCandidates[0]=Object.fromEntries(Object.entries(reordered.frozenCandidates[0]).reverse());
  assert.equal(core.gameProblem(reordered),null);
  const bad=structuredClone(drawing);Object.defineProperty(bad,'stage',{get:()=>{throw new Error('must not read accessor');},enumerable:true});
  assert.doesNotThrow(()=>core.gameProblem(bad));assert.ok(core.gameProblem(bad));
});

test('largest 8-player 5-round match remains bounded and every score tops out at 7875',()=>{
  let g=create(8,{rounds:5,drawingSeconds:30},7);
  while(g.status==='playing') {
    if(g.stage==='choosing')g=choose(g);
    if(g.stage==='drawing')for(const p of g.players.filter(p=>p.id!==g.turnPlayerId))g=checked(guess(g,p.id,g.stageClock.startedAt));
    if(g.stage==='reveal')g=timeout(g);
  }
  assert.equal(g.frozenCandidates.length,120);assert.equal(g.turnResults.length,40);
  assert.deepEqual(g.players.map(p=>p.score),Array(8).fill(7875));assert.equal(core.gameProblem(g),null);
});

test('hostile sparse arrays, foreign fields and counter overflow never mutate valid play',()=>{
  const pool=words(12);delete pool[1];assert.throws(()=>core.freezeCandidates(pool));
  const extra=words(12);extra.untrusted='x';assert.throws(()=>core.freezeCandidates(extra));
  for(const change of [g=>{g.frozenCandidates[0].admin=true;},g=>{g.currentGuesses.hidden='x';},
    g=>{g.stageClock.remainingMs=0;},g=>{g.revision=Number.MAX_SAFE_INTEGER;},g=>{g.players[0].score=8001;}]) {
    const g=create();
    change(g);assert.ok(core.gameProblem(g));
  }
  const g=choose(create());g.revision=Number.MAX_SAFE_INTEGER-2;assert.equal(core.gameProblem(g),null);
  const before=structuredClone(g);assert.equal(core.pauseGame(g,1100).ok,false);assert.equal(guess(g,ids(2)[1],1100).ok,false);assert.deepEqual(g,before);
});
