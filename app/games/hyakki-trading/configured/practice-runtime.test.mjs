import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredPracticeRuntime as runtime,decodeConfiguredPractice,encodeConfiguredPractice} from './practice-runtime.mjs';
import {PRACTICE_SELF,createHyakkiPracticeSession} from '../practice-engine.mjs';
import {randomStream} from '../practice-session.mjs';
import {openingGame} from '../opening-game.mjs';
const fresh=(n=2,seed=9,packId='six-trades-v1')=>runtime.fresh({playerCount:n,packId,closingTarget:30,actionLimit:5,seed,requestId:()=>seed.toString(16).padStart(32,'0')});
function step(saved){
  const actor=runtime.actor(saved.game),view=runtime.privateView(saved.game,actor),command=runtime.chooseAction(view,actor,{now:saved.logicalNow,allowPaused:true});
  assert.ok(command,JSON.stringify({stage:view.stage,pending:view.pending,actor}));
  const random=randomStream(saved.rngState),now=saved.logicalNow+1;
  const result=runtime.applyGameAction(saved.game,actor,command,{now,randomInt:random.randomInt});
  assert.equal(result.ok,true,JSON.stringify({command,error:result.error,pending:saved.game.pending}));
  return runtime.transition(saved,result.state,random.state,now);
}
test('private selection saves exactly, bots confirm without revealing candidates, one public opening only',()=>{
  let saved=fresh(6),first=runtime.privateView(saved.game,PRACTICE_SELF);
  assert.equal(first.opening.self.candidates.length,3);assert.equal(first.players.some(p=>'roleId'in p),false);
  for(let i=0;i<5;i++){saved=step(saved);assert.equal(saved.journal.groups.length,0);assert.ok(decodeConfiguredPractice(encodeConfiguredPractice(saved)));}
  saved=step(saved);assert.equal(openingGame(saved.game),false);assert.equal(saved.journal.groups.length,1);
  assert.equal(saved.game.deck.length,333);assert.equal(saved.game.players.length,6);
  assert.deepEqual(decodeConfiguredPractice(encodeConfiguredPractice(saved)),saved);
});
for(const n of [2,4,6])for(const seed of [2,9,17])test(`complete seeded expansion practice n=${n} seed=${seed} with lawful private-view decisions`,()=>{
  let saved=fresh(n,seed),steps=0;
  while(saved.game.status==='playing'&&steps++<6500){saved=step(saved);if(steps%100===0)assert.ok(decodeConfiguredPractice(encodeConfiguredPractice(saved)),`restore ${steps}`);}
  assert.equal(saved.game.status,'finished',`did not finish in ${steps} steps`);
  assert.ok(saved.journal.groups.length>20);assert.deepEqual(decodeConfiguredPractice(encodeConfiguredPractice(saved)),saved);
});
test('unchecked expansion preserves six-goods rules and configurable threshold in saved practice',()=>{
  const saved=fresh(4,5,'base');assert.equal(Object.keys(saved.game.bankGoods).length,6);
  assert.equal(saved.game.deck.length,158);assert.equal(saved.game.configuration.closingTarget,30);
  assert.ok(decodeConfiguredPractice(encodeConfiguredPractice(saved)));
});
test('actual shared session restores selection and logical paused time, then confirms human choice',async()=>{
  let raw=null;const storage={getItem:()=>raw,setItem:(_key,value)=>{raw=value;}};
  let wall=0;const options={packId:'six-trades-v1',seed:5,storage,withLock:fn=>fn(),now:()=>wall,requestId:()=> 'b'.repeat(32),setTimer:()=>1,clearTimer:()=>{}};
  let session=await createHyakkiPracticeSession(options);const view=session.snapshot().game;
  assert.equal(view.stage,'role-selection');await session.destroy();wall=999999;
  session=await createHyakkiPracticeSession(options);assert.equal(session.snapshot().logicalNow,0);
  await session.action('confirm-role',{openingId:view.matchId,candidateId:view.opening.self.candidateId,roleId:view.opening.self.candidates[2]});
  assert.equal(session.snapshot().game.opening.self.confirmedRoleId,view.opening.self.candidates[2]);
  await session.destroy();assert.ok(decodeConfiguredPractice(raw));
});
