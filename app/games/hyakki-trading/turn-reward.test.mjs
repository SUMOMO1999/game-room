import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, applyTimeout, currentDecision, gameProblem } from './rules.mjs';
import { privateView } from './view.mjs';
import { idleRewardThreshold, qualifiesForIdleReward } from './model.mjs';
import { DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION } from './content/definitions.mjs';
import { chooseHyakkiPracticeAction } from './practice-bot.mjs';
import { createHyakkiAdapter } from '../../../server/games/hyakki-trading/adapter.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32)];
const context = { now: 1000, randomInt: limit => limit - 1 };
const adapter = createHyakkiAdapter();
const fresh = (actionLimit, options = {}) => createGame(ids, {
  ...context, matchId: 'c'.repeat(32), actionLimit, ...options,
});
function apply(state, type) {
  const decision = currentDecision(state);
  const result = adapter.applyGameAction(state, decision?.actorId ?? state.turnPlayerId, {
    type, requestId: `reward-${state.revision}`, expectedRevision: state.revision,
    matchId: state.matchId, turnId: state.turnId,
    ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}),
  }, { now: context.now, serverRandomInt: context.randomInt });
  assert.equal(result.ok, true, result.error);
  assert.equal(gameProblem(result.state), null);
  return result.state;
}
function spendPeeks(state, amount) {
  for (let index = 0; index < amount; index++) state = apply(apply(state, 'peek'), 'discard-peek');
  return state;
}

test('configured reward is one silver through the adapter at or below rounded half, never on exhaustion', () => {
  assert.deepEqual(Array.from({ length: 10 }, (_, index) => idleRewardThreshold(index + 1)), [1,1,2,2,3,3,4,4,5,5]);
  for (let actionLimit = 1; actionLimit <= 10; actionLimit++) {
    for (let actionsUsed = 1; actionsUsed <= actionLimit; actionsUsed++) {
      let state = spendPeeks(fresh(actionLimit), actionsUsed);
      const exhausted = actionsUsed === actionLimit;
      const reward = !exhausted && actionsUsed <= Math.round(actionLimit / 2) ? 1 : 0;
      if (!exhausted) {
        assert.equal(qualifiesForIdleReward(privateView(state, ids[0])), Boolean(reward));
        const before = JSON.stringify(state);
        const restored = JSON.parse(before);
        state = apply(restored, 'end-turn');
        assert.equal(JSON.stringify(restored), before, 'authority must not mutate its input snapshot');
      }
      assert.equal(state.turnNumber, 2, `${actionLimit} steps / ${actionsUsed} used`);
      assert.deepEqual(state.players.map(owner => owner.silver), [20 + reward, 20], `${actionLimit} steps / ${actionsUsed} used`);
      assert.equal(state.actionLimit, actionLimit);
    }
  }
});

test('zero-action turns retain first-peek protection and existing exemptions use the same new formula', () => {
  for (let actionLimit = 1; actionLimit <= 10; actionLimit++) {
    const initial = fresh(actionLimit), before = structuredClone(initial);
    const blocked = applyGameAction(initial, ids[0], {
      type: 'end-turn', matchId: initial.matchId, turnId: initial.turnId,
    }, context);
    assert.equal(blocked.code, 'FIRST_PEEK_REQUIRED');
    assert.deepEqual(initial, before);
    const oldUse = structuredClone(initial); oldUse.stage = 'use';
    assert.equal(apply(oldUse, 'end-turn').players[0].silver, 21, 'a permitted old zero-action turn follows the formula');
    const empty = structuredClone(initial); empty.players[0].hand.push(...empty.deck.splice(0));
    assert.equal(apply(empty, 'end-turn').players[0].silver, 21, 'a genuinely empty draw/discard pool still permits ending');
  }
});

test('automatic timeout never pays even when the used count meets the voluntary threshold', () => {
  for (let actionLimit = 1; actionLimit <= 10; actionLimit++) {
    const state = actionLimit === 1 ? fresh(actionLimit) : spendPeeks(fresh(actionLimit), 1);
    const result = applyTimeout(state, ids[0], { ...context, now: state.timing.active.deadlineAt });
    assert.equal(result.ok, true, result.error);
    assert.equal(gameProblem(result.state), null);
    assert.equal(result.state.turnNumber, 2);
    assert.deepEqual(result.state.players.map(owner => owner.silver), [20, 20]);
  }
});

test('old and new saved rule versions compute the changed reward from their existing action limit', () => {
  const changes = [
    { actionLimit: 2, used: 1, oldReward: 0, reward: 1 },
    { actionLimit: 3, used: 2, oldReward: 0, reward: 1 },
    { actionLimit: 5, used: 3, oldReward: 1, reward: 1 },
    { actionLimit: 6, used: 4, oldReward: 1, reward: 0 },
    { actionLimit: 10, used: 5, oldReward: 1, reward: 1 },
    { actionLimit: 10, used: 6, oldReward: 1, reward: 0 },
  ];
  for (const ruleVersion of [DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION]) {
    for (const { actionLimit, used, oldReward, reward } of changes) {
      const initial = spendPeeks(fresh(actionLimit, { ruleVersion }), used);
      assert.equal(Number(actionLimit - used >= 2), oldReward, 'explicit comparison against the previous predicate');
      const restored = JSON.parse(JSON.stringify(initial)), next = apply(restored, 'end-turn');
      assert.equal(next.players[0].silver - initial.players[0].silver, reward);
      assert.equal(next.players[1].silver, initial.players[1].silver);
      assert.equal(next.ruleVersion, ruleVersion);
      assert.equal(next.actionLimit, actionLimit);
      assert.deepEqual(Object.keys(next).sort(), Object.keys(initial).sort(), 'no migration or new persistent field');
    }
  }
});

test('practice early-ending preference follows the same changed threshold as authoritative silver', () => {
  // This stable match/turn samples the bot's existing occasional early-end preference.
  for (const { actionLimit, used, expected } of [
    { actionLimit: 2, used: 1, expected: 'end-turn' },
    { actionLimit: 3, used: 2, expected: 'end-turn' },
    { actionLimit: 5, used: 3, expected: 'end-turn' },
    { actionLimit: 6, used: 4, expected: 'buy' },
    { actionLimit: 10, used: 5, expected: 'end-turn' },
    { actionLimit: 10, used: 6, expected: 'buy' },
  ]) {
    const state = fresh(actionLimit, { matchId: '00000000000000000000000000000031' });
    const goodsCard = 'yousei.g01#01';
    state.deck.push(...state.players.flatMap(owner => owner.hand));
    state.players.forEach(owner => { owner.hand = []; });
    state.deck.splice(state.deck.indexOf(goodsCard), 1); state.players[0].hand.push(goodsCard);
    state.stage = 'use'; state.drawStarted = true; state.actionsUsed = used;
    assert.equal(gameProblem(state), null);
    const action = chooseHyakkiPracticeAction(privateView(state, ids[0]), ids[0], { now: context.now });
    assert.equal(action.type, expected, `${actionLimit} steps / ${used} used`);
    const result = applyGameAction(state, ids[0], action, context);
    assert.equal(result.ok, true, result.error);
    if (expected === 'end-turn') assert.equal(result.state.players[0].silver - state.players[0].silver, 1);
  }
});
