import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parksCues } from './presentation.mjs';
import { actionOutcome, quoteCost } from './game-ui.mjs';
const view = extra => ({ matchId: 'a', revision: 1, season: { index: 0 }, window: {}, players: [], lastPublicEvents: [], ...extra });
test('reconnects, unrelated matches and replayed baseline never repeat cues', () => {
  assert.deepEqual(parksCues(null, view(), 'self', 'player'), []);
  assert.deepEqual(parksCues(view(), view(), 'self', 'player'), []);
  assert.deepEqual(parksCues(view(), view({matchId:'b',revision:2}), 'self', 'player'), []);
});
test('real die and Teddy transitions receive distinct cues, capped to one per view', () => {
  const die={id:'event:1',type:'die-rolled'};
  assert.deepEqual(parksCues(view(),view({revision:2,lastPublicEvents:[die]}),'self','player'),['roll']);
  assert.deepEqual(parksCues(view({lastPublicEvents:[die]}),view({revision:2,lastPublicEvents:[die]}),'self','player'),['placement']);
  assert.deepEqual(parksCues(view(),view({revision:2,lastPublicEvents:[{id:'event:2',type:'teddy-card-revealed'}]}),'self','player'),['draw']);
});
test('destination preview displays authoritative fire/weather distinction before committing', () => {
  const action={type:'move-hiker',fields:{position:2,arrivalMode:'normal'},result:{campfireUsed:true,weather:'sun',siteId:'site.forest'}};
  assert.match(actionOutcome(action),/消耗营火/); assert.match(actionOutcome(action),/阳光/); assert.match(actionOutcome(action),/森林/);
  const camping={...action,fields:{position:2,arrivalMode:'camping'},result:{campfireUsed:false,weather:null,arrivalMode:'camping'}};
  assert.match(actionOutcome(camping),/不消耗营火/); assert.match(actionOutcome(camping),/不领取地点天气/); assert.doesNotMatch(actionOutcome(camping),/阳光/);
});
test('passion preview includes exact goal, ability and scoring branch before choice', () => {
  const outcome=actionOutcome({type:'choose-starting-passion',fields:{targetId:'passion.rock-climbing'},result:{goalText:'目标',abilityText:'能力效果',scoringText:'每两枚1分'}});
  assert.match(outcome,/目标/);assert.match(outcome,/能力效果/);assert.match(outcome,/每两枚1分/);
});
test('first-arrival preview and camping photo charges match the supplied rules quote', () => {
  assert.match(actionOutcome({type:'move-hiker',fields:{position:10},result:{firstArrivalReward:'photo'}}),/野生动物1/);
  assert.match(actionOutcome({type:'move-hiker',fields:{position:10},result:{firstArrivalReward:'gear'}}),/阳光1/);
  const cost={printedCost:{kind:'photo',amount:1},actualCost:{kind:'photo',amount:1},remainingPhotos:2};
  assert.match(quoteCost({fields:{},cost}),/1张照片/);assert.match(quoteCost({fields:{},cost}),/付后2张照片/);
  assert.doesNotMatch(quoteCost({fields:{},cost}),/免费/);
});
