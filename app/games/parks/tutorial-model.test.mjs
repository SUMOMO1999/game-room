import test from 'node:test';
import assert from 'node:assert/strict';
import { LESSONS, createTutorialLesson, tutorialProgress, tutorialTrace, tutorialActionGuidance } from './tutorial-model.mjs';
import { createParksPractice, parksPracticeView, practiceProblem, applyParksPracticeAction, advanceParksPractice, PRACTICE_SELF, randomStream } from './practice-engine.mjs';
import { applyGameAction, applySystemStep, nextSystemStep, stateProblem } from './rules/index.mjs';
import { createParksDraft } from './game-ui-model.mjs';
import { actionOutcome } from './game-ui.mjs';
import { CANTEEN_TOKENS, getDefinition } from './content/catalog.mjs';
import { privateView } from './view.mjs';
import { chooseParksPracticeAction } from './practice-bot.mjs';

const matchId = 'a'.repeat(32);
const make = id => createTutorialLesson(id, { requestId: () => matchId });
const self = view => view.players.find(owner => owner.id === PRACTICE_SELF);
const legalFields = view => view.legalActions.filter(value => !value.disabledReason).map(value => value.fields);

test('fixed curriculum has eight basic lessons and four original-box topics, with explicit rehearsal differences', () => {
  assert.equal(LESSONS.length, 12); assert.equal(LESSONS.filter(value => !value.topic).length, 8);
  assert.equal(new Set(LESSONS.map(value => value.id)).size, 12);
  assert.ok(Object.isFrozen(LESSONS) && LESSONS.every(value => Object.isFrozen(value) && Object.isFrozen(value.configuration)));
  for (const value of LESSONS) {
    assert.equal(value.seed, 1); assert.ok(value.title && value.goal && value.instruction && value.normalDifference.includes('合法预演'));
  }
  assert.equal(LESSONS.find(value => value.id === 'teddy-order').configuration.mode, 'solo');
  assert.match(LESSONS.find(value => value.id === 'teddy-order').normalDifference, /双人Teddy只有一个颜色组/);
});

for (const info of LESSONS) test(`fixed lesson ${info.id} starts at its real legal gate and naturally reaches its goal`, () => {
  let saved = make(info.id), progress = tutorialProgress(parksPracticeView(saved), info.id);
  assert.equal(practiceProblem(saved), null); assert.equal(stateProblem(saved.game), null);
  assert.equal(progress.complete, false); assert.ok(progress.suggestedAction, 'fixed scene must contain the claimed playable goal');
  assert.equal(progress.guidance.complete, false); assert.equal(progress.guidance.lessonId, info.id);
  assert.equal(progress.guidance.goal, info.goal); assert.ok(progress.guidance.heading && progress.guidance.instruction);
  assert.deepEqual(progress.guidance.suggestedAction, progress.suggestedAction);
  assert.deepEqual(saved.game.configuration, info.configuration);
  assert.equal(saved.game.revision, tutorialTrace(info.id).length);
  let actions = 0;
  for (; actions < 160 && !progress.complete; actions += 1) {
    const view = parksPracticeView(saved);
    assert.ok(legalFields(view).some(value => JSON.stringify(value) === JSON.stringify(progress.suggestedAction)), 'hint must come from current participant projection');
    const before = JSON.stringify(saved), action = applyParksPracticeAction(saved, progress.suggestedAction);
    assert.equal(action.ok, true, action.error); assert.equal(JSON.stringify(saved), before, 'preview saved remains immutable');
    saved = action.saved; assert.equal(practiceProblem(saved), null);
    progress = tutorialProgress(parksPracticeView(saved), info.id);
    if (!progress.complete) {
      const automated = advanceParksPractice(saved); assert.equal(automated.ok, true, automated.error); saved = automated.saved;
      assert.equal(practiceProblem(saved), null); progress = tutorialProgress(parksPracticeView(saved), info.id);
    }
  }
  assert.equal(progress.complete, true, `${info.id} did not complete within ${actions} player actions`);
  assert.equal(progress.suggestedAction, null);
  assert.equal(progress.guidance.complete, true); assert.equal(progress.guidance.heading, '本课完成');
  assert.ok(progress.guidance.outcome.text && progress.guidance.instruction && progress.guidance.continuation && progress.guidance.nextLabel);
  assert.doesNotMatch(JSON.stringify(progress.guidance), /undefined|第0行/);
  const restored = parksPracticeView(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(tutorialProgress(restored, info.id, { completedPreviously: true }).guidance, progress.guidance,
    'restoring the same lawful saved lesson retains its visible result and next step');
  if (['season-score', 'solo-rating'].includes(info.id)) {
    assert.equal(saved.game.result.reason, 'three-seasons-complete'); assert.equal(saved.game.seasonIndex, 2);
    assert.equal(progress.detail.score, saved.game.result.scores.find(value => value.playerId === PRACTICE_SELF).score);
    assert.deepEqual(progress.detail.breakdown, saved.game.result.scores.find(value => value.playerId === PRACTICE_SELF).breakdown);
  }
  if (info.id === 'solo-rating') { assert.deepEqual(progress.detail.ratingThresholds, [30, 35, 40, 45, 50]); assert.equal(progress.detail.difficulty, 0); }
});

test('first lesson guides the actual destination, cancellation changes nothing, and weather receipt becomes explicit completion', () => {
  let saved = make('movement-weather');
  const view = parksPracticeView(saved), progress = tutorialProgress(view, 'movement-weather'), draft = createParksDraft();
  const action = view.legalActions.find(value => JSON.stringify(value.fields) === JSON.stringify(progress.suggestedAction));
  const original = JSON.stringify(saved);
  assert.equal(action.type, 'move-hiker'); assert.ok(action.result.weather);
  assert.match(progress.guidance.heading, new RegExp(`第${action.fields.position}站`));
  assert.match(progress.guidance.instruction, /点亮起的地点/);
  const room = { roomId: saved.matchId, selfId: PRACTICE_SELF, selfRole: 'player', phase: 'playing', game: view };
  assert.equal(draft.select(action, room), true); draft.cancel();
  assert.equal(JSON.stringify(saved), original); assert.deepEqual(tutorialProgress(view, 'movement-weather').guidance, progress.guidance);
  const moved = applyParksPracticeAction(saved, action.fields); assert.equal(moved.ok, true); saved = moved.saved;
  const afterMove = parksPracticeView(saved), weatherStep = tutorialProgress(afterMove, 'movement-weather');
  assert.equal(weatherStep.complete, false); assert.equal(weatherStep.guidance.heading, '领取刚到站的天气');
  assert.match(weatherStep.guidance.instruction, /来自地点上的天气标记/);
  const received = applyParksPracticeAction(saved, weatherStep.suggestedAction); assert.equal(received.ok, true); saved = received.saved;
  const complete = tutorialProgress(parksPracticeView(saved), 'movement-weather');
  assert.equal(complete.complete, true); assert.match(complete.guidance.outcome.text, /天气已领取/);
  assert.equal(complete.guidance.outcome.resources[action.result.weather], 1);
  assert.match(complete.guidance.continuation, /后续地点行动仍待处理/);
  assert.equal(complete.guidance.suggestedAction, null);
});

test('switching a teaching source describes its actual action while retaining the lesson goal', () => {
  const saved = make('fill-canteen'), view = parksPracticeView(saved), before = JSON.stringify(saved);
  const target = tutorialProgress(view, 'fill-canteen');
  const other = view.legalActions.find(action => action.fields.action === 'reserve' && action.opportunityId !== target.suggestedAction.opportunityId);
  assert.ok(other, 'this real location offers a park source alongside new water');
  const guide = tutorialActionGuidance(view, 'fill-canteen', other.fields);
  assert.equal(guide.heading, other.label); assert.equal(guide.goal, target.guidance.goal);
  assert.match(guide.instruction, /本课目标在“分配新水”中/);
  assert.doesNotMatch(guide.instruction, /点亮起的水壶/);
  assert.equal(tutorialActionGuidance(view, 'fill-canteen', { ...other.fields, targetId: 'park.missing' }), null);
  assert.equal(JSON.stringify(saved), before, 'source guidance has no game or saved-state effect');
});

test('filling a row quotes the existing canteen effects rather than inventing new canteens', () => {
  const view = parksPracticeView(make('fill-canteen')), fields = tutorialProgress(view, 'fill-canteen').suggestedAction;
  const action = view.legalActions.find(value => JSON.stringify(value.fields) === JSON.stringify(fields));
  assert.equal(action.type, 'allocate-water'); assert.ok(action.result.canteenIds.length);
  const quote = actionOutcome(action);
  for (const id of action.result.canteenIds) {
    const token = CANTEEN_TOKENS.find(value => value.id === id), definition = getDefinition(token.definitionId);
    assert.ok(quote.includes(definition.shortText), `quote must show the actual ${definition.id} effect`);
  }
  assert.doesNotMatch(quote, /获得\d+枚水壶/);
  assert.match(actionOutcome({ type: 'take-canteen', result: { canteenIds: [CANTEEN_TOKENS[0].id] } }), /获得1枚水壶/);
});

test('campfire teaching allows actual card effects to relight it during the season', () => {
  const info = LESSONS.find(value => value.id === 'occupied-campfire');
  assert.match(info.instruction, /卡牌效果可重新点燃/);
  const guide = tutorialProgress(parksPracticeView(make(info.id)), info.id, { completedPreviously: true }).guidance;
  assert.match(guide.instruction, /卡牌效果也可重新点燃/);
  assert.doesNotMatch(guide.instruction, /本季不能/);
});

test('a real paid visit cannot substitute for the reserve lesson goal', () => {
  const initial = parksPracticeView(make('reserve-park'));
  assert.equal(initial.legalActions.some(action => action.fields.action === 'visit'), false,
    'the initial reserve rehearsal has insufficient resources for a legal visit');
  const info = LESSONS.find(value => value.id === 'reserve-park');
  let saved = createParksPractice({ configuration: info.configuration, playerCount: info.playerCount, seed: info.seed, requestId: () => 'c'.repeat(32) });
  let visit = null;
  // Reach a genuine alternative through resource locations, without adding
  // cards, resources or teaching flags to the domain state.
  for (let index = 0; index < 160; index += 1) {
    const view = parksPracticeView(saved);
    visit = view.legalActions.find(action => action.fields.action === 'visit');
    if (visit) break;
    const step = nextSystemStep(saved.game), actorId = saved.game.decisionWindow.responsibleSeatId;
    const actorView = privateView(saved.game, actorId, { now: saved.logicalNow });
    let intent = step ?? chooseParksPracticeAction(actorView);
    if (!step && actorId === PRACTICE_SELF) {
      const move = actorView.legalActions.filter(action => action.type === 'move-hiker'
        && (['site.mountain', 'site.forest', 'site.sun', 'site.water'].includes(action.result.siteId)
          || action.fields.position === 10 && action.fields.endSlot === 'parks')).sort((a, b) => a.fields.position - b.fields.position)[0];
      const collect = actorView.legalActions.find(action => action.result?.resources && !action.cost);
      const water = actorView.legalActions.find(action => action.type === 'allocate-water' && action.fields.rowIndex === null);
      intent = collect?.fields || water?.fields || move?.fields || intent;
      assert.notEqual(intent.action, 'reserve', 'this route must not pre-complete the reservation goal');
    }
    const rng = randomStream(saved.rngState), now = saved.logicalNow + 1, context = { now, serverRandomInt: limit => rng.randomInt(limit) };
    const result = step ? applySystemStep(saved.game, intent, context) : applyGameAction(saved.game, actorId, intent, context);
    assert.equal(result.ok, true, result.error); saved = { ...saved, game: result.state, logicalNow: now, rngState: rng.state };
  }
  assert.ok(visit, 'legal resource gathering must reach a paid visit');
  assert.equal(tutorialProgress(parksPracticeView(saved), 'reserve-park').complete, false);
  const visited = applyParksPracticeAction(saved, visit.fields); assert.equal(visited.ok, true);
  const view = parksPracticeView(visited.saved);
  assert.equal(self(view).reserved.length, 0); assert.equal(self(view).visited.length, 1);
  assert.ok(view.lastPublicEvents.some(event => event.type === 'park-visited' && event.actorId === PRACTICE_SELF));
  assert.equal(tutorialProgress(view, 'reserve-park').complete, false,
    'a real park-visited event and score do not establish a reservation');
});

test('buying real gear quotes its trigger before its conditional effect', () => {
  const view = parksPracticeView(make('buy-gear'));
  const raincoat = view.legalActions.find(action => action.fields.action === 'buy-gear' && action.result.nameZh === '雨具');
  assert.ok(raincoat.result.triggerText && raincoat.result.effectText);
  const quote = actionOutcome(raincoat);
  assert.ok(quote.includes(`触发条件：${raincoat.result.triggerText}；触发后：${raincoat.result.effectText}`));
  assert.doesNotMatch(quote, /立即获得|购买后获得/);
  const faceDown = view.legalActions.find(action => action.fields.action === 'buy-gear' && action.fields.targetId === 'deck-top');
  assert.ok(faceDown.result.effectText && !faceDown.result.triggerText);
  assert.ok(actionOutcome(faceDown).includes(faceDown.result.effectText));
  assert.doesNotMatch(actionOutcome(faceDown), /触发条件：|触发后：/);
});

test('a complete fixed prelude can be independently replayed using only its real commands and RNG continuation', () => {
  const info = LESSONS.find(value => value.id === 'season-score'), prepared = make(info.id);
  let replay = createParksPractice({ configuration: info.configuration, playerCount: info.playerCount, seed: info.seed, requestId: () => matchId });
  const trace = tutorialTrace(info.id);
  for (const entry of trace) {
    const rng = randomStream(replay.rngState), now = replay.logicalNow + 1, context = { now, serverRandomInt: limit => rng.randomInt(limit) };
    assert.equal(entry.beforeRevision, replay.game.revision);
    const result = entry.kind === 'system' ? applySystemStep(replay.game, entry.intent, context) : applyGameAction(replay.game, entry.actorId, entry.intent, context);
    assert.equal(result.ok, true, result.error); assert.equal(entry.afterRevision, result.state.revision);
    replay = { ...replay, game: result.state, logicalNow: now, rngState: rng.state };
    assert.equal(practiceProblem(replay), null);
  }
  assert.deepEqual(replay, prepared);
  trace[0].intent.type = 'not-a-command'; assert.notEqual(tutorialTrace(info.id)[0].intent.type, 'not-a-command');
});

test('moving alone does not complete weather; the real weather resource event does', () => {
  const saved = make('movement-weather'), move = tutorialProgress(parksPracticeView(saved), 'movement-weather').suggestedAction;
  const moved = applyParksPracticeAction(saved, move); assert.equal(moved.ok, true);
  const afterMove = parksPracticeView(moved.saved), progress = tutorialProgress(afterMove, 'movement-weather');
  assert.equal(progress.complete, false); assert.equal(progress.suggestedAction.type, 'use-opportunity');
  assert.ok(afterMove.opportunities.find(value => value.id === progress.suggestedAction.opportunityId).sourceId.startsWith('weather.'));
  const claimed = applyParksPracticeAction(moved.saved, progress.suggestedAction); assert.equal(claimed.ok, true);
  assert.equal(tutorialProgress(parksPracticeView(claimed.saved), 'movement-weather').complete, true);
});

test('Teddy order uses two different real draws and moves both groups before completion', () => {
  const saved = make('teddy-order'), initial = parksPracticeView(saved), choices = initial.legalActions.filter(value => value.type === 'choose-teddy');
  assert.equal(choices.length, 2);
  const chosen = applyParksPracticeAction(saved, choices[1].fields); assert.equal(chosen.ok, true);
  assert.equal(tutorialProgress(parksPracticeView(chosen.saved), 'teddy-order').complete, false, 'choosing first color has not moved either group');
  const moved = advanceParksPractice(chosen.saved); assert.equal(moved.ok, true);
  assert.equal(tutorialProgress(parksPracticeView(moved.saved), 'teddy-order').complete, true);
  assert.equal(moved.saved.game.teddy.discard.length, saved.game.teddy.discard.length + 1, 'first card was already revealed; only second draw occurs after choice');
  for (const groupId of ['teddy.amber', 'teddy.blue']) assert.ok(parksPracticeView(moved.saved).hikers.some(value => value.groupId === groupId && value.position > 0));
});

test('volunteer scene offers only an already reserved park with real extra project costs, not invented bonus points', () => {
  const view = parksPracticeView(make('volunteer-projects')), progress = tutorialProgress(view, 'volunteer-projects');
  assert.equal(view.projects.length, 4);
  assert.ok(self(view).reserved.includes(progress.suggestedAction.targetId));
  const quote = view.legalActions.find(value => JSON.stringify(value.fields) === JSON.stringify(progress.suggestedAction));
  assert.equal(quote.cost.extraCost.forest + quote.cost.extraCost.mountain, 1);
  assert.ok(view.legalActions.filter(value => value.fields.action === 'visit').every(value => self(view).reserved.includes(value.fields.targetId)));
});

test('redo keeps the same fixed scene while giving it a fresh match scope; unknown lessons and other modes stay inert', () => {
  const first = make('buy-gear'), second = createTutorialLesson('buy-gear', { requestId: () => 'b'.repeat(32) });
  assert.notEqual(first.matchId, second.matchId); assert.equal(first.game.revision, second.game.revision);
  assert.deepEqual(parksPracticeView(first).markets, parksPracticeView(second).markets); assert.deepEqual(self(parksPracticeView(first)).resources, self(parksPracticeView(second)).resources);
  assert.throws(() => createTutorialLesson('missing'), /课程不存在/); assert.throws(() => tutorialProgress(parksPracticeView(first), 'missing'), /课程不存在/);
  const other = parksPracticeView(make('solo-rating')), inert = tutorialProgress(other, 'buy-gear');
  assert.equal(inert.complete, false); assert.equal(inert.suggestedAction, null);
});
