import test from 'node:test';
import assert from 'node:assert/strict';
import { createParksDraft, parksCommand, parksStageProfiles, createParksDisplayClock } from './game-ui-model.mjs';
import { fitGameStage } from '../../platform/game-stage-fit.mjs';

const action = { type: 'move-hiker', fields: { matchId: 'match-a', windowId: 'window-a', opportunityId: null, hikerId: 'hiker-a', position: 3 }, cost: { actualCost: {} }, result: '获得阳光' };
const room = () => ({ roomId: 'room-a', selfId: 'a', selfRole: 'player', phase: 'playing',
  game: { matchId: 'match-a', window: { id: 'window-a', responsibleSeatId: 'a' }, opportunities: [], legalActions: [structuredClone(action)] } });

test('selection, amendment and cancellation neither submit nor mutate authoritative objects', () => {
  const view = room(), before = structuredClone(view), draft = createParksDraft();
  assert.equal(draft.select(action, view), true);
  const copy = draft.current(); copy.fields.position = 7;
  assert.equal(draft.current().fields.position, 3);
  draft.cancel(); assert.equal(draft.current(), null); assert.deepEqual(view, before);
});
test('new seat, match, phase or decision drops private local draft', () => {
  for (const change of [value => value.selfId = 'b', value => value.selfRole = 'spectator',
    value => value.phase = 'paused', value => value.game.matchId = 'match-b', value => value.game.window.id = 'window-b']) {
    const view = room(), draft = createParksDraft(); draft.select(action, view); change(view);
    assert.equal(draft.sync(view), null);
  }
});
test('alternative payment is chosen only from the current authoritative quote and survives local redraw', () => {
  const view=room(),draft=createParksDraft(),zero={mountain:0,forest:0,sun:0,water:0,wildlife:0};
  view.game.legalActions[0].fields.payment={...zero,sun:1};
  view.game.legalActions[0].cost.paymentOptions=[{...zero,sun:1},{...zero,wildlife:1}];
  view.game.legalActions[0].cost.paymentQuotes=[{payment:{...zero,sun:1},result:{resources:{...zero,wildlife:0}}},{payment:{...zero,wildlife:1},result:{resources:{...zero,wildlife:1}}}];
  draft.select(view.game.legalActions[0],view);
  assert.equal(draft.choosePayment({...zero,wildlife:1}),true);
  assert.equal(draft.sync(view).fields.payment.wildlife,1);
  assert.equal(draft.current().result.resources.wildlife,1);
  assert.equal(draft.choosePayment({...zero,water:2}),false);
  assert.equal(draft.current().fields.payment.wildlife,1);
  assert.equal(view.game.legalActions[0].fields.payment.sun,1);
  assert.equal(draft.isSelected(view.game.legalActions[0]), true);
  assert.equal(draft.isSelected({...view.game.legalActions[0],fields:{...view.game.legalActions[0].fields,position:4}}), false);
});

test('display clock advances without SSE, never extends on replay and stops in practice or pause', () => {
  const clock=createParksDisplayClock(),game={matchId:'a',window:{id:'w',remainingMs:30000,paused:false}};
  clock.update(game,100);assert.equal(clock.read(1100),29000);
  clock.update(game,1100);assert.equal(clock.read(2100),28000);
  clock.update({...game,window:{...game.window,remainingMs:28000,paused:true}},2100);
  assert.equal(clock.read(100000),28000);
  clock.update({...game,practice:true},100000);assert.equal(clock.read(100100),null);
  clock.clear();assert.equal(clock.read(200000),null);
});
test('same-window removal or changed quote invalidates selected intent', () => {
  const view = room(), draft = createParksDraft(); draft.select(action, view);
  view.game.legalActions[0].cost = { actualCost: {sun:1} }; assert.equal(draft.sync(view), null);
  draft.select(view.game.legalActions[0], view);
  view.game.legalActions[0].fields.position = 4; assert.equal(draft.sync(view), null);
  draft.select(view.game.legalActions[0], view); view.game.legalActions[0].disabledReason = '资源已用完';
  assert.equal(draft.sync(view), null);
});
test('old fences cannot silently acquire new authority', () => {
  const game = room().game;
  assert.throws(() => parksCommand(game, action.type, { ...action.fields, windowId: 'window-old' }), /过期/);
  assert.throws(() => parksCommand(game, action.type, { ...action.fields, matchId: 'old-match' }), /过期/);
  assert.throws(() => parksCommand(game, action.type, { ...action.fields, opportunityId: 'closed-op' }), /处理完/);
  assert.deepEqual(parksCommand(game, action.type, action.fields), action.fields.type ? action.fields : { ...action.fields, type: action.type });
});
test('supported compositions fit common proportions and short desktop without uncontrolled reflow', () => {
  for (const [width, height] of [[1024,768],[1280,1024],[1440,960],[1440,900],[1280,720],[1920,1080],[2560,1080],[3440,1440],[3840,1080],[1280,589]]) {
    const fit = fitGameStage({ width, height, profiles: parksStageProfiles({width,height}), minScale:.85, inputMode:'fine' });
    assert.equal(fit.unsupported, false, `${width}×${height}`);
    assert(fit.width * fit.scale <= width + 1); assert(fit.height * fit.scale <= height + 1);
  }
  const phone = fitGameStage({width:844,height:360,profiles:parksStageProfiles({width:844,height:360}),inputMode:'coarse'});
  assert.equal(phone.scale, 1); assert.equal(phone.profile, 'mobile-landscape');
});
