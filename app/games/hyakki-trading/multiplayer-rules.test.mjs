import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, applyTimeout, currentDecision, gameProblem } from './rules.mjs';
import { DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION, createDeck, GOODS } from './content/definitions.mjs';
import { definition, resolvePublicCardRef, goodsPerTypeOf } from './model.mjs';
import { privateView, spectatorView } from './view.mjs';
import { changeHyakkiPause } from './lifecycle.mjs';

const ids = Array.from({ length: 6 }, (_, index) => String(index + 1).repeat(32));
const context = { now: 1000, randomInt: limit => limit - 1 };
const fresh = (count = 6, options = {}) => createGame(ids.slice(0, count), { ...context, matchId: 'a'.repeat(32), ...options });
function command(state, type, fields = {}, now = 1000, actorId = currentDecision(state)?.actorId ?? state.turnPlayerId) {
  const decision = currentDecision(state);
  return applyGameAction(state, actorId, { type, matchId: state.matchId, turnId: state.turnId, expectedRevision: state.revision,
    ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}), ...fields }, { ...context, now });
}
function accept(state, type, fields, now, actorId) {
  const result = command(state, type, fields, now, actorId);
  assert.equal(result.ok, true, `${type}: ${result.error}`); conserved(result.state); return result.state;
}
function conserved(state) {
  assert.equal(gameProblem(state), null);
  const cards = [...state.deck, ...state.discard, ...state.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])];
  assert.deepEqual([...cards].sort(), createDeck().map(card => card.id).sort());
  for (const good of GOODS) assert.equal(state.bankGoods[good.id] + state.players.reduce((sum, owner) => sum + owner.goods[good.id], 0)
    + (state.pending?.goods[good.id] ?? 0), goodsPerTypeOf(state));
  assert.equal(state.availableStalls + state.players.reduce((sum, owner) => sum + owner.stallCount, 0), 5);
}
function give(state, index, code) {
  const all = [...state.deck, ...state.players.flatMap(owner => owner.hand)];
  const cardId = all.find(id => definition(id).sourceCode === code);
  state.deck = state.deck.filter(id => id !== cardId);
  state.players.forEach(owner => { owner.hand = owner.hand.filter(id => id !== cardId); });
  state.players[index].hand.push(cardId); return cardId;
}
function trading() {
  const state = fresh(); state.stage = 'use'; state.drawStarted = true;
  return { state, cardId: give(state, 0, 'G01') };
}
test('every 2–6 player opening conserves one deck and rotates from every possible first seat', () => {
  for (let count = 2; count <= 6; count++) for (let first = 0; first < count; first++) {
    let state = fresh(count, { firstPlayerId: ids[first], actionLimit: 1 }); conserved(state);
    assert.equal(state.version, 2); assert.equal(state.ruleVersion, MULTIPLAYER_RULE_VERSION);
    assert.equal(state.deck.length, 110 - count * 5);
    assert.ok(state.players.every(owner => owner.hand.length === 5 && owner.silver === 20));
    for (let offset = 0; offset < count * 2; offset++) {
      assert.equal(state.turnPlayerId, ids[(first + offset) % count]);
      state = accept(accept(state, 'peek'), 'keep-peek');
    }
    assert.equal(state.round, 3); assert.equal(state.turnPlayerId, ids[first]);
  }
});
test('only 2–6 distinct seats and known rule versions can create a game', () => {
  for (const list of [[], [ids[0]], [...ids, '7'.repeat(32)], [ids[0], ids[0]]])
    assert.throws(() => createGame(list, { ...context, matchId: 'a'.repeat(32) }));
  assert.throws(() => fresh(3, { ruleVersion: DIGITAL_RULE_VERSION }));
  assert.throws(() => fresh(2, { ruleVersion: 'future' }));
});
test('first peek remains mandatory for every new multiplayer turn', () => {
  let state = fresh(6, { actionLimit: 1 });
  for (let index = 0; index < 6; index++) {
    const before = structuredClone(state);
    for (const type of ['finish-draw', 'end-turn']) assert.equal(command(state, type).code, 'FIRST_PEEK_REQUIRED');
    assert.deepEqual(state, before); state = accept(accept(state, 'peek'), 'discard-peek');
  }
});
test('closing completes only the unfinished seats of the frozen first-player round', () => {
  for (let count = 2; count <= 6; count++) for (let first = 0; first < count; first++) for (let trigger = 0; trigger < count; trigger++) {
    let state = fresh(count, { firstPlayerId: ids[first] });
    for (let offset = 0; offset < count; offset++) {
      state.stage = 'use'; state.drawStarted = true; state.actionsUsed = 4;
      if (offset === trigger) state.players.find(owner => owner.id === state.turnPlayerId).silver = 60;
      state = accept(state, 'end-turn');
      assert.equal(state.status, offset === count - 1 ? 'finished' : 'playing');
    }
    assert.deepEqual(state.result.winnerIds, [ids[(first + trigger) % count]]);
    assert.equal(state.result.wealth.length, count);
  }
});
test('tie breaks inside the wealth leaders, including a rotated first seat', () => {
  for (const first of [0, 3]) {
    let state = fresh(6, { firstPlayerId: ids[first] });
    state.players.find(owner => owner.id === ids[first]).silver = 60;
    state.players.find(owner => owner.id === ids[(first + 1) % 6]).silver = 60;
    for (let offset = 0; offset < 6; offset++) {
      state.stage = 'use'; state.drawStarted = true; state.actionsUsed = 4; state = accept(state, 'end-turn');
    }
    assert.deepEqual(state.result.winnerIds, [ids[(first + 1) % 6]]);
  }
});
test('merchant response visits every seat with one 60-second budget and stale commands fail', () => {
  const f = trading(); let state = accept(f.state, 'buy', { cardId: f.cardId });
  const deadline = state.timing.decision.deadlineAt, originalDecision = currentDecision(state);
  for (let index = 1; index < 6; index++) {
    assert.equal(currentDecision(state).actorId, ids[index]); assert.equal(state.timing.decision.deadlineAt, deadline);
    if (index > 1) {
      const stale = applyGameAction(state, ids[1], { type: 'decline-response', matchId: state.matchId, turnId: state.turnId,
        effectId: state.pending.id, decisionId: originalDecision.id }, { ...context, now: 1000 + index * 1000 });
      assert.equal(stale.ok, false); assert.equal(stale.code, 'STALE_ACTION');
    }
    state = accept(state, 'decline-response', {}, 1000 + index * 1000);
  }
  assert.equal(state.pending, null); assert.equal(state.timing.decision, null);
  assert.equal(state.discard.filter(id => id === f.cardId).length, 1);
});
test('first actual merchant claimant takes one card and closes later response seats', () => {
  const f = trading(), merchant = give(f.state, 3, 'C04');
  let state = accept(f.state, 'buy', { cardId: f.cardId });
  state = accept(state, 'decline-response'); state = accept(state, 'decline-response');
  state = accept(state, 'respond', { cardId: merchant });
  assert.equal(state.pending, null); assert.ok(state.players[3].hand.includes(f.cardId));
  assert.equal(state.discard.filter(id => id === merchant).length, 1);
  assert.equal(state.players.flatMap(owner => owner.hand).filter(id => id === f.cardId).length, 1);
});
test('merchant expiry closes all remaining seats in one accepted timeout', () => {
  const f = trading(); let state = accept(f.state, 'buy', { cardId: f.cardId });
  state = accept(state, 'decline-response', {}, 11_000);
  const result = applyTimeout(state, ids[2], { ...context, now: 61_000 });
  assert.equal(result.ok, true, result.error); state = result.state; conserved(state);
  assert.equal(state.pending, null); assert.equal(state.timing.decision, null);
});
test('merchant pause and restore conserve total response time instead of renewing for next seat', () => {
  const f = trading(); let state = accept(f.state, 'buy', { cardId: f.cardId });
  const presence = now => ({ observedAt: now, seats: ids.map(playerId => ({ playerId, connected: true,
    lastSeenAt: now, leaseExpiresAt: now + 10_000, absenceSinceAt: null })) });
  const paused = changeHyakkiPause(state, 'paused', 11_000, { presence: presence(11_000) });
  assert.equal(paused.ok, true); state = paused.state; assert.equal(state.timing.decision.remainingMs, 50_000);
  state = changeHyakkiPause(state, 'playing', 100_000, { presence: presence(100_000) }).state;
  assert.equal(state.timing.decision.deadlineAt, 150_000);
  state = accept(state, 'decline-response', {}, 110_000);
  assert.equal(state.timing.decision.actorId, ids[2]); assert.equal(state.timing.decision.deadlineAt, 150_000);
});
test('six-seat projections expose one own hand and actual public tool references only', () => {
  const state = fresh(), tool = give(state, 5, 'T01');
  state.players[5].hand.splice(state.players[5].hand.indexOf(tool), 1); state.players[5].tools.push({ cardId: tool, exhausted: false });
  conserved(state);
  for (const selfId of ids) {
    const view = privateView(state, selfId);
    assert.equal(view.players.filter(owner => owner.hand).length, 1);
    assert.equal(view.players.find(owner => owner.hand).id, selfId);
    assert.equal(Object.hasOwn(view, 'deck'), false);
  }
  const observer = spectatorView(state); assert.ok(observer.players.every(owner => !Object.hasOwn(owner, 'hand')));
  const ref = observer.players[5].tools[0].ref; assert.equal(resolvePublicCardRef(state, ref), tool);
  assert.throws(() => resolvePublicCardRef(fresh(2), ref), /目标不存在/);
  assert.throws(() => resolvePublicCardRef(state, ref.replace(':0:', ':1:')), /已改变/);
});
test('v1 two-player saves keep their exact version and never reinterpret as v2', () => {
  let state = fresh(2, { ruleVersion: DIGITAL_RULE_VERSION, goodsPerType: 6 }); delete state.goodsPerType;
  assert.equal(state.version, 1); assert.equal(gameProblem(state), null);
  state = accept(accept(JSON.parse(JSON.stringify(state)), 'peek'), 'keep-peek');
  assert.equal(state.ruleVersion, DIGITAL_RULE_VERSION); assert.equal(state.version, 1);
  const mismatched = structuredClone(state); mismatched.version = 2; assert.ok(gameProblem(mismatched));
  const missingNewConfiguration = fresh(); delete missingNewConfiguration.goodsPerType; assert.ok(gameProblem(missingNewConfiguration));
});
test('corrupt target, merchant order and wider public tool references are rejected without mutation', () => {
  const f = trading(), state = accept(f.state, 'buy', { cardId: f.cardId });
  for (const mutate of [value => { value.pending.response.remainingIds.reverse(); }, value => { value.pending.response.actorId = ids[0]; },
    value => { value.pending.response.remainingMs = 60_001; }, value => { value.players[5].id = ids[0]; },
    value => { value.turnIndex = 6; }, value => { value.players.push(structuredClone(value.players[0])); }]) {
    const copy = structuredClone(state); mutate(copy); assert.ok(gameProblem(copy));
  }
});
