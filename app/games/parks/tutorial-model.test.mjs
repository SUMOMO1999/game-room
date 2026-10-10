import test from 'node:test';
import assert from 'node:assert/strict';
import { LESSONS, createTutorialLesson, tutorialProgress, tutorialTrace } from './tutorial-model.mjs';
import { createParksPractice, parksPracticeView, practiceProblem, applyParksPracticeAction, advanceParksPractice, PRACTICE_SELF, randomStream } from './practice-engine.mjs';
import { applyGameAction, applySystemStep, stateProblem } from './rules/index.mjs';

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
  if (['season-score', 'solo-rating'].includes(info.id)) {
    assert.equal(saved.game.result.reason, 'three-seasons-complete'); assert.equal(saved.game.seasonIndex, 2);
    assert.equal(progress.detail.score, saved.game.result.scores.find(value => value.playerId === PRACTICE_SELF).score);
    assert.deepEqual(progress.detail.breakdown, saved.game.result.scores.find(value => value.playerId === PRACTICE_SELF).breakdown);
  }
  if (info.id === 'solo-rating') { assert.deepEqual(progress.detail.ratingThresholds, [30, 35, 40, 45, 50]); assert.equal(progress.detail.difficulty, 0); }
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
