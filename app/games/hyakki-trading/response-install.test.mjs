import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, applyTimeout, currentDecision, gameProblem } from './rules.mjs';
import { definition, legalResponseCards } from './model.mjs';
import { privateView, spectatorView } from './view.mjs';
import { DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION } from './content/definitions.mjs';
import { cardDraftCost } from './card-draft.mjs';

const ids = Array.from({ length: 6 }, (_, index) => String(index + 1).repeat(32));
const ctx = { now: 1000, randomInt: limit => limit - 1 };
function fixture(count = 2, ruleVersion = MULTIPLAYER_RULE_VERSION) {
  const state = createGame(ids.slice(0, count), { ...ctx, matchId: 'a'.repeat(32), ruleVersion });
  state.deck.push(...state.players.flatMap(owner => owner.hand));
  state.players.forEach(owner => { owner.hand = []; });
  state.stage = 'use'; state.drawStarted = true;
  return state;
}
function give(state, index, code) {
  const position = state.deck.findIndex(id => definition(id).sourceCode === code);
  assert(position >= 0); const [id] = state.deck.splice(position, 1); state.players[index].hand.push(id); return id;
}
function stock(state, index, code, count = 1) { state.bankGoods[code] -= count; state.players[index].goods[code] += count; }
function command(state, type, fields = {}, now = 1000, actorId = currentDecision(state)?.actorId ?? state.turnPlayerId) {
  const decision = currentDecision(state);
  return applyGameAction(state, actorId, { type, matchId: state.matchId, turnId: state.turnId, expectedRevision: state.revision,
    ...(decision ? { effectId: state.pending.id, decisionId: decision.id } : {}), ...fields }, { ...ctx, now });
}
function accept(state, type, fields, now, actorId) {
  const result = command(state, type, fields, now, actorId); assert.equal(result.ok, true, result.error);
  assert.equal(gameProblem(result.state), null); return result.state;
}
function install(state, index, code) {
  const id = give(state, index, code); state.players[index].hand.pop(); state.players[index].tools.push({ cardId: id, exhausted: false }); return id;
}

for (let index = 1; index <= 10; index++) test(`T${String(index).padStart(2, '0')}: installation is free and preserves the current turn clock`, () => {
  const state = fixture(), cardId = give(state, 0, `T${String(index).padStart(2, '0')}`); state.actionsUsed = 4;
  const view = privateView(state, ids[0]), detail = { card: view.players[0].hand[0], tool: false };
  assert.match(cardDraftCost(view, ids[0], detail), /安装不耗行动/);
  assert.match(cardDraftCost(view, ids[0], detail, [], { short: true }), /安装0行动/);
  const after = accept(state, 'install-tool', { cardId }, 1200);
  assert.equal(after.actionsUsed, 4); assert.equal(after.turnId, state.turnId);
  assert.deepEqual(after.timing, state.timing); assert.equal(after.players[0].silver, 20);
  assert.deepEqual(after.players[0].tools, [{ cardId, exhausted: false }]);
  assert.deepEqual(state.players[0].hand, [cardId]);
});

test('replacement is free, invalid replacements are atomic, and installation cannot bypass the first peek', () => {
  let state = fixture();
  const old = ['T01', 'T02', 'T03'].map(code => install(state, 0, code)), next = give(state, 0, 'T05'); state.actionsUsed = 3;
  for (const fields of [{ cardId: next }, { cardId: next, replaceCardId: state.deck[0] }]) {
    const before = structuredClone(state); assert.equal(command(state, 'install-tool', fields).ok, false); assert.deepEqual(state, before);
  }
  const result = accept(state, 'install-tool', { cardId: next, replaceCardId: old[1] });
  assert.equal(result.actionsUsed, 3); assert.deepEqual(result.discard, [old[1]]);
  assert.deepEqual(result.players[0].tools.map(tool => tool.cardId), [old[0], old[2], next]);
  state.stage = 'draw'; state.drawStarted = false;
  assert.equal(command(state, 'install-tool', { cardId: next, replaceCardId: old[1] }).ok, false);
  assert.equal(state.actionsUsed, 3);
  state.stage = 'use'; state.drawStarted = true; state.actionsUsed = state.actionLimit;
  const expired = structuredClone(state);
  assert.equal(command(state, 'install-tool', { cardId: next, replaceCardId: old[1] }).ok, false);
  assert.deepEqual(state, expired, 'free installation cannot extend a completed turn');
});

test('actual activation still costs one action plus its card fee and the last action ends only after the effect', () => {
  let state = fixture(), tool = give(state, 0, 'T05'); state.actionsUsed = 4;
  state = accept(state, 'install-tool', { cardId: tool });
  const nextCard = state.deck[0]; state = accept(state, 'activate-tool', { cardId: tool });
  assert.equal(state.turnNumber, 2); assert.equal(state.players[0].silver, 19);
  assert(state.players[0].hand.includes(nextCard)); assert.equal(state.players[0].tools[0].exhausted, false);
});

for (const ruleVersion of [DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION]) test(`${ruleVersion}: no merchant reply completes the trade immediately without response events or a clock pause`, () => {
  let state = fixture(2, ruleVersion); const goods = give(state, 0, 'G01'); give(state, 1, 'C07');
  const deadline = state.timing.active.deadlineAt; state = accept(state, 'buy', { cardId: goods }, 1400);
  assert.equal(state.pending, null); assert.equal(state.timing.decision, null); assert.equal(state.timing.active.deadlineAt, deadline);
  assert.equal(state.actionsUsed, 1); assert.equal(state.players[0].silver, 17); assert.equal(state.players[0].goods.firearms, 3);
  assert.deepEqual(state.discard, [goods]); assert.deepEqual(state.lastPublicEvents.map(event => event.type), ['trade-bought']);
});

test('only the affected target can counter: matching cards in another seat or the deck do not open a response', () => {
  let state = fixture(4); const monitor = give(state, 0, 'M01'); give(state, 1, 'C07'); give(state, 2, 'C04'); stock(state, 2, 'imports');
  state = accept(state, 'play-character', { cardId: monitor, params: { targetId: ids[2], goodsId: 'imports' } });
  assert.equal(state.pending, null); assert.equal(state.players[0].goods.imports, 1); assert.equal(state.players[2].goods.imports, 0);
  assert.equal(state.timing.decision, null); assert(!state.lastPublicEvents.some(event => event.type.startsWith('response')));
});

test('a legal free response remains available at the last action with zero silver and a full goods area', () => {
  let state = fixture(); const monitor = give(state, 0, 'M01'), counter = give(state, 1, 'C07');
  state.actionsUsed = 4; state.players[1].silver = 0; stock(state, 1, 'imports', 5);
  state = accept(state, 'play-character', { cardId: monitor, params: { targetId: ids[1], goodsId: 'imports' } });
  assert.equal(state.actionsUsed, 5); assert.deepEqual(legalResponseCards(state), [counter]);
  assert.deepEqual(privateView(state, ids[1]).pending.response.cards.map(card => card.cardId), [counter]);
  assert.equal(spectatorView(state).pending.response.cards, undefined);
  state = accept(state, 'respond', { cardId: counter });
  assert.equal(state.turnNumber, 2); assert.equal(state.players[1].silver, 0); assert.equal(state.players[1].goods.imports, 5);
  assert.deepEqual(state.discard, [monitor, counter]);
});

test('merchant skips consecutive empty seats, stops at each actual holder, and preserves a single deadline', () => {
  let state = fixture(6); const goods = give(state, 0, 'G01'); give(state, 3, 'C04'); const last = give(state, 5, 'C04');
  give(state, 1, 'C07'); give(state, 2, 'C03');
  state = accept(state, 'buy', { cardId: goods }, 1200);
  assert.equal(state.pending.response.actorId, ids[3]); assert.deepEqual(state.pending.response.remainingIds, ids.slice(3));
  const deadline = state.timing.decision.deadlineAt;
  state = accept(JSON.parse(JSON.stringify(state)), 'decline-response', {}, 6200);
  assert.equal(state.pending.response.actorId, ids[5]); assert.deepEqual(state.pending.response.remainingIds, [ids[5]]);
  assert.equal(state.timing.decision.deadlineAt, deadline); assert.equal(state.pending.response.remainingMs, 55_000);
  const saved = structuredClone(state); assert.equal(command(state, 'respond', { cardId: last }, deadline).code, 'ACTION_EXPIRED');
  assert.deepEqual(state, saved);
  const timed = applyTimeout(state, ids[5], { ...ctx, now: deadline }); assert(timed.ok); assert.equal(timed.state.pending, null);
  assert(timed.state.players[5].hand.includes(last)); assert(timed.state.discard.includes(goods));
});

test('an old no-card response save remains valid and resolves without refunding prior actions or renewing time', () => {
  let state = fixture(); const monitor = give(state, 0, 'M01'), counter = give(state, 1, 'C07'); stock(state, 1, 'imports');
  state.actionsUsed = 2;
  state = accept(state, 'play-character', { cardId: monitor, params: { targetId: ids[1], goodsId: 'imports' } }, 1200);
  // Represents the old always-open window schema, including its already-paid action.
  state.players[1].hand.splice(state.players[1].hand.indexOf(counter), 1); state.deck.push(counter);
  const restored = JSON.parse(JSON.stringify(state)), before = structuredClone(restored);
  assert.equal(gameProblem(restored), null); assert.deepEqual(privateView(restored, ids[1]).pending.response.cards, []);
  assert.deepEqual(restored, before);
  const after = accept(restored, 'decline-response', {}, 2200);
  assert.equal(after.actionsUsed, 3); assert.equal(after.pending, null); assert.equal(after.players[0].goods.imports, 1);
  assert.equal(after.timing.active.deadlineAt, 2200 + before.timing.active.remainingMs);
});

test('an already-paid old tool choice restores at its saved cost and does not charge or refund again', () => {
  let state = fixture(), tool = install(state, 0, 'T02'); stock(state, 0, 'firearms'); stock(state, 1, 'imports');
  state.actionsUsed = 1; // Historical installation had already consumed this action.
  state = accept(state, 'activate-tool', { cardId: tool, params: { targetId: ids[1] } });
  assert.equal(state.actionsUsed, 2); assert.equal(state.pending.choice.kind, 'tool-exchange');
  const after = accept(JSON.parse(JSON.stringify(state)), 'choose-effect', { selection: { ownGoodId: 'firearms', otherGoodId: 'imports' } });
  assert.equal(after.actionsUsed, 2); assert.equal(after.pending, null); assert.equal(after.players[0].goods.imports, 1);
});

test('an old merchant window on an empty seat retains its saved deadline and skips later empty seats after decline', () => {
  let state = fixture(6); const goods = give(state, 0, 'G01'), first = give(state, 1, 'C04'), later = give(state, 4, 'C04');
  state = accept(state, 'buy', { cardId: goods }, 1200);
  state.players[1].hand.splice(state.players[1].hand.indexOf(first), 1); state.deck.push(first);
  state = JSON.parse(JSON.stringify(state)); const deadline = state.timing.decision.deadlineAt;
  assert.equal(gameProblem(state), null); assert.deepEqual(legalResponseCards(state), []);
  state = accept(state, 'decline-response', {}, 2200);
  assert.equal(state.pending.response.actorId, ids[4]); assert.deepEqual(state.pending.response.remainingIds, ids.slice(4));
  assert.equal(state.timing.decision.deadlineAt, deadline); assert.equal(state.actionsUsed, 1);
  state = accept(state, 'respond', { cardId: later }, 3200);
  assert.equal(state.pending, null); assert(state.players[4].hand.includes(goods));
  assert.equal(state.players[0].silver, 17); assert.equal(state.players[0].goods.firearms, 3);
});
