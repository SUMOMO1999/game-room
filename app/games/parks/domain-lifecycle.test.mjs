import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame,stateProblem,privateView,spectatorView,applyGameAction,nextSystemStep,applySystemStep,pauseGame,resumeGame,applyTimeout,abortGame,normalizeConfiguration,validateActionShape } from './engine.mjs';
import { fixture,give,card,passion,op,action,commit,settleEffects,fullMatch,player,zeroResources } from './test-support/fixtures.mjs';
import { createOpportunity,openWindow,RESOURCE_KEYS } from './rules/model.mjs';
import { finalResult,seasonWinners } from './rules/scoring.mjs';
import { createParksPractice,decodeParksPractice,encodeParksPractice,advanceParksPractice,applyParksPracticeAction,parksPracticeView,randomStream,PRACTICE_SELF } from './practice-engine.mjs';
import { chooseParksPracticeAction } from './practice-bot.mjs';

const countModes=[['standard',2],['standard',3],['standard',4],['standard',5],['teddy',2],['solo',1]];
test('60 supported configurations initialize, freeze, restore, and never leak candidate/deck/boards',()=>{
 let number=0;
 for(const [mode,count] of countModes)for(const camping of [false,true])for(let volunteerCount=0;volunteerCount<=4;volunteerCount++){
  const rng=randomStream(100+number),config={mode,camping,volunteerCount,passionChoice:number%2?'random':'choose'};
  const s=createGame(Array.from({length:count},(_,i)=>`p${i+1}`),{matchId:`m${number++}`,now:10,serverRandomInt:n=>rng.randomInt(n),configuration:config});
  assert.deepEqual(s.configuration,config);const restored=JSON.parse(JSON.stringify(s));assert.equal(stateProblem(restored),null);
  const self=privateView(restored,'p1'),other=privateView(restored,'p2'),spectator=spectatorView(restored);
  for(const view of [self,other,spectator]){assert.equal(view.decks,undefined);assert.equal(view.randomCursor,undefined);assert.equal(view.contentDigest,undefined);assert.equal(view.camping.seasonBoards,undefined);assert.ok(view.players.every(p=>p.passionCandidates===undefined));}
  assert.deepEqual(spectator.selfCandidates,[]);assert.deepEqual(spectator.legalActions,[]);
  if(config.passionChoice==='choose')assert.equal(self.selfCandidates.length,2);else assert.equal(self.selfCandidates.length,0);
  self.players[0].resources.sun=99;assert.notEqual(restored.players[0].resources.sun,99);
  assert.equal(s.controllers.filter(c=>c.kind==='teddy').length,mode==='standard'?0:1);
 }
 assert.equal(number,60);
 assert.throws(()=>normalizeConfiguration({mode:'two-teddy'}));assert.throws(()=>normalizeConfiguration({volunteerCount:5}));
});
test('all 192 ordered camping entity/face draws initialize and restore without duplicate physical tile',()=>{
 const found=new Set();for(let seed=1;seed<=2000&&found.size<192;seed++){
  const rng=randomStream(seed),s=createGame(['a','b'],{matchId:`board${seed}`,now:0,configuration:{mode:'standard',camping:true},serverRandomInt:n=>rng.randomInt(n)});
  assert.equal(stateProblem(JSON.parse(JSON.stringify(s))),null);assert.equal(new Set(s.camping.seasonBoards.map(b=>b.tileId)).size,3);found.add(JSON.stringify(s.camping.seasonBoards));
 }
 assert.equal(found.size,192);
});
for(const [index,[mode,count]] of countModes.entries())test(`complete three seasons and resume each saved command: ${mode} ${count}`,()=>{
 const {state,commands,types}=fullMatch({mode,camping:index%2===0,volunteerCount:4,passionChoice:'choose'},{count,seed:901+index});
 assert.ok(commands>100&&commands<1000);assert.equal(state.seasonIndex,2);assert.equal(state.result.scores.length,count);assert.ok(types.has('season-next-award'));
 if(mode!=='standard')assert.ok(types.has('teddy-draw'));if(mode==='solo'){assert.deepEqual(state.result.winnerIds,[]);assert.equal(state.result.scores[0].difficulty,4);}
});
test('strict match/window/opportunity fences and exact field validation reject stale/extra without mutation',()=>{
 const s=fixture();op(s,[{kind:'photo'}]);give(s,{sun:1});const intent=action(s,c=>c.fields.action==='take-photo'),before=JSON.stringify(s);
 for(const forged of [{...intent,matchId:'old'},{...intent,windowId:'old'},{...intent,opportunityId:'old'},{...intent,ignored:true},{...intent,payment:{...intent.payment,sun:999}}, {...intent,action:'visit'}]){
  const result=applyGameAction(s,'a',forged,{now:1});assert.equal(result.ok,false);assert.equal(JSON.stringify(s),before);
 }
 assert.equal(applyGameAction(s,'b',intent,{now:1}).ok,false);
 const next=commit(s,intent);assert.equal(applyGameAction(next,'a',intent,{now:2}).ok,false);
 assert.ok(validateActionShape({...intent,constructor:'bad'}));
});
test('deadline pause preserves chosen material, responsibility and stable window; resume grants fresh timeout window',()=>{
 let s=fixture();op(s,[{kind:'photo'}]);give(s,{sun:1});const id=s.decisionWindow.id,raw=JSON.stringify(s.opportunities),expired=s.decisionWindow.deadlineAt;
 assert.equal(applyGameAction(s,'a',action(s,c=>c.fields.action==='take-photo'),{now:expired}).ok,false);
 let result=applyTimeout(s,{windowId:id,now:expired});assert.equal(result.ok,true);assert.equal(result.roomPhase,'paused');s=result.state;
 assert.equal(s.status,'playing');assert.equal(s.decisionWindow.responsibleSeatId,'a');assert.equal(JSON.stringify(s.opportunities),raw);assert.equal(nextSystemStep(s),null);assert.deepEqual(privateView(s,'a').legalActions,[]);
 result=resumeGame(JSON.parse(JSON.stringify(s)),{now:expired+100});assert.equal(result.ok,true);s=result.state;assert.equal(s.decisionWindow.id,id);assert.equal(s.decisionWindow.deadlineAt,expired+100+1800000);
 result=pauseGame(s,{now:expired+110,cause:'vote'});assert.equal(result.ok,true);result=resumeGame(result.state,{now:expired+200});assert.equal(result.state.decisionWindow.remainingMs,1799990);
});
test('abort is unscored, retains ownership, and cannot emit a later pending die',()=>{
 const s=fixture();op(s,[{kind:'die'}]);const step=nextSystemStep(s);assert.ok(step);
 const result=abortGame(s,{now:1,reason:'member-left'});assert.equal(result.ok,true);assert.equal(result.state.result.aborted,true);assert.deepEqual(result.state.result.scores,[]);assert.equal(nextSystemStep(result.state),null);assert.equal(applySystemStep(result.state,step,{now:2,serverRandomInt:()=>0}).ok,false);
});
test('resource/card corruption and cyclic opportunities fail recovery validation',()=>{
 const s=fixture();const mutations=[v=>v.bankResources.water++,v=>v.decks.parks[0]=v.decks.parks[1],v=>v.players[0].canteenRows[0].tokens.push(v.players[1].canteenRows[0].tokens[0]),v=>v.controllers.push({id:'z',kind:'human'}),v=>v.configuration.mode='solo',v=>v.seasons[2]=v.seasons[0],v=>v.players[0].passionBranch='ability'];
 for(const mutate of mutations){const forged=structuredClone(s);mutate(forged);assert.ok(stateProblem(forged));}
 op(s,[{kind:'photo'}]);const value=s.opportunities[0];value.parentId=value.id;assert.ok(stateProblem(s));
});
test('stable system step only rolls once, survives JSON restore and uses actual supplied face',()=>{
 let s=fixture();op(s,[{kind:'die'}]);const step=nextSystemStep(s);assert.deepEqual(nextSystemStep(JSON.parse(JSON.stringify(s))),step);let calls=0;
 const result=applySystemStep(s,step,{now:1,serverRandomInt:n=>{calls++;assert.equal(n,6);return 3;}});assert.equal(result.ok,true);assert.equal(calls,1);assert.equal(result.state.lastDie.face,'water');
 assert.equal(applySystemStep(result.state,step,{now:2,serverRandomInt:()=>{calls++;return 0;}}).ok,false);assert.equal(calls,1);
 assert.equal(result.state.opportunities.filter(o=>o.kind==='new-water'&&o.status==='open').length,2);assert.equal(player(result.state,'a').resources.water,0);
 const expired=applySystemStep(s,step,{now:s.decisionWindow.deadlineAt,serverRandomInt:()=>{calls++;return 0;}});assert.equal(expired.ok,false);assert.equal(expired.errorCode,'WINDOW_EXPIRED');assert.equal(calls,1);
});
test('practice save/restore preserves hidden RNG and exactly repeats the next random result; <=16 bounded auto steps',()=>{
 let saved=createParksPractice({configuration:{mode:'solo',camping:true,volunteerCount:4,passionChoice:'choose'},seed:8,requestId:()=> 'a'.repeat(32)});
 assert.equal(decodeParksPractice(encodeParksPractice(saved)).rngState,saved.rngState);assert.equal(decodeParksPractice('{bad'),null);
 const chosen=parksPracticeView(saved).legalActions[0].fields;const original=JSON.stringify(saved);const result=applyParksPracticeAction(saved,chosen);assert.equal(result.ok,true);assert.equal(JSON.stringify(saved),original);saved=result.saved;
 const restored=decodeParksPractice(encodeParksPractice(saved));assert.deepEqual(advanceParksPractice(saved),advanceParksPractice(restored));assert.ok(advanceParksPractice(saved).steps<=16);
 const other=structuredClone(saved);other.game.players[0].id='other';assert.equal(decodeParksPractice(JSON.stringify(other)),null);assert.throws(()=>createParksPractice({playerCount:0}));
});
test('local practice thinking time has no forced deadline and exposes no countdown',()=>{
 const saved=createParksPractice({configuration:{passionChoice:'choose'},seed:3,requestId:()=> 'b'.repeat(32)}),before=JSON.stringify(saved);
 for(let count=0;count<1000;count++){const result=advanceParksPractice(saved,{elapsedMs:2000});assert.equal(result.ok,true);assert.equal(result.saved.logicalNow,saved.logicalNow);assert.equal(result.steps,0);}
 assert.equal(JSON.stringify(saved),before);const view=parksPracticeView(saved);assert.equal(view.practice,true);assert.equal(view.window.deadlineAt,null);assert.equal(view.window.remainingMs,null);assert.ok(view.legalActions.length);
 assert.throws(()=>randomStream(0));assert.equal(applyTimeout(saved.game,null).errorCode,'INVALID_CONTEXT');
});
test('photo ranking ties skip places and tie-break uses visited count; solo omits ranking bonus',()=>{
 const rng=randomStream(1),s=createGame(['a','b','c'],{matchId:'score',now:0,serverRandomInt:n=>rng.randomInt(n),configuration:{mode:'standard'}});
 s.players[0].photos=5;s.players[1].photos=5;s.players[2].photos=3;const rows=finalResult(s,1).scores;assert.deepEqual(rows.map(r=>r.photoRank),[1,1,3]);assert.deepEqual(rows.map(r=>r.breakdown.photoRanking),[4,4,0]);
 s.players.forEach(p=>p.photos=0);assert.deepEqual(finalResult(s,2).scores.map(r=>r.breakdown.photoRanking),[0,0,0]);
 const solo=fixture({mode:'solo'});player(solo,'a').photos=35;const result=finalResult(solo,3);assert.equal(result.scores[0].breakdown.photoRanking,0);assert.equal(result.scores[0].soloRank,'Trekker');
});
