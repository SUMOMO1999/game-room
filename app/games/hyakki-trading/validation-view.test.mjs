import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction } from './rules.mjs';
import { currentDecision } from './decision.mjs';
import { gameProblem } from './validation.mjs';
import { privateView, spectatorView } from './view.mjs';
import { definition, emptyGoods } from './model.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32)], matchId = 'c'.repeat(32);
function fresh() { return createGame(ids, { matchId, now: 1000, randomInt: max => max - 1, actionLimit: 10, goodsPerType: 6 }); }
function run(game, type, extra = {}, actorId = currentDecision(game)?.actorId ?? game.turnPlayerId) {
  const decision = currentDecision(game);
  const result = applyGameAction(game, actorId, { type, matchId: game.matchId, turnId: game.turnId,
    ...(game.pending ? { effectId: game.pending.id, decisionId: decision.id } : {}), ...extra }, { now: game.committedAt + 1, randomInt: max => max - 1 });
  assert.equal(result.ok, true, result.error); assert.equal(gameProblem(result.state), null); return result.state;
}
function take(game, code, ownerId = game.turnPlayerId) {
  const zones = [game.deck, game.discard, ...game.players.map(player => player.hand)];
  const source = zones.find(zone => zone.some(id => definition(id).sourceCode === code));
  assert.ok(source, code); const index = source.findIndex(id => definition(id).sourceCode === code), [id] = source.splice(index, 1);
  game.players.find(player => player.id === ownerId).hand.push(id); return id;
}
function installed(game, code, ownerId = game.turnPlayerId) {
  const cardId = take(game, code, ownerId), owner = game.players.find(player => player.id === ownerId);
  owner.hand.splice(owner.hand.indexOf(cardId), 1); owner.tools.push({ cardId, exhausted: false }); return cardId;
}
function useStage(game) { return run(run(game, 'peek'), 'keep-peek'); }
function assertNoCopies(value) { assert.doesNotMatch(JSON.stringify(value), /yousei\.[a-z0-9_-]+#\d{2}/u); }

test('real opening validates 110 unique card zones, six stocks and five board ownership', () => {
  const state = fresh(); assert.equal(gameProblem(state), null);
  const cases = [
    value => { value.deck[0] = value.players[0].hand[0]; },
    value => { value.deck.pop(); },
    value => { value.deck.push('yousei.g01#99'); },
    value => { value.players[0].goods.firearms = 1; },
    value => { value.bankGoods.firearms = 5; },
    value => { value.purchasedStalls = 1; value.availableStalls = 4; },
    value => { value.players[0].silver = -1; },
    value => { value.players[0].silver = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.players[0].temporaryOccupied = true; },
  ];
  for (const corrupt of cases) { const copy = structuredClone(state); corrupt(copy); assert.notEqual(gameProblem(copy), null); }
});

test('unknown versions, extra fields and private material in public events fail closed', () => {
  const state = fresh();
  const cases = [
    value => { value.version = 2; }, value => { value.ruleVersion = 'latest'; }, value => { value.contentVersion = 'latest'; },
    value => { value.seed = 3; }, value => { value.players[0].secret = 'x'; }, value => { value.bankGoods.secret = 1; },
    value => { value.lifecycle.sessionId = 'x'; }, value => { value.timing.active.hidden = 'x'; },
    value => { value.turnId = 'turn-9'; }, value => { value.timing.active.actorId = ids.find(id => id !== value.turnPlayerId); },
    value => { value.lastPublicEvents = [{ type: 'draw-peeked', actorSeatId: value.turnPlayerId, cardId: value.deck[0] }]; },
  ];
  for (const corrupt of cases) { const copy = structuredClone(state); corrupt(copy); assert.notEqual(gameProblem(copy), null); }
  assert.notEqual(gameProblem(null), null); assert.notEqual(gameProblem({}), null);
});

test('ordinary peek exposes the saved face only to its owner and never the undealt order', () => {
  const state = run(fresh(), 'peek'), ownerId = state.turnPlayerId, peerId = ids.find(id => id !== ownerId);
  const owner = privateView(state, ownerId), peer = privateView(state, peerId), publicView = spectatorView(state);
  assert.equal(owner.pending.privatePool[0].cardId, state.pending.poolCards[0]);
  assert.equal(peer.pending.privatePool, undefined); assert.equal(publicView.pending.privatePool, undefined);
  assert.equal(owner.pending.decisionId, currentDecision(state).id);
  assert.equal(owner.deck, undefined); assert.equal(peer.deck, undefined); assert.equal(publicView.deck, undefined);
  assertNoCopies(publicView);
  assert.equal(peer.players.find(player => player.id === ownerId).hand, undefined);
  assert.throws(() => privateView(state, 'd'.repeat(32)), /参赛者/);
  owner.pending.privatePool[0].cardId = 'changed'; assert.notEqual(state.pending.poolCards[0], 'changed');
});

test('private character and two-card tool candidate sets never reach the other seat', () => {
  for (const [kind, code] of [['character', 'C02'], ['tool', 'T04']]) {
    let state = useStage(fresh());
    const cardId = kind === 'character' ? take(state, code) : installed(state, code);
    state = run(state, kind === 'character' ? 'play-character' : 'activate-tool', { cardId });
    const actorId = currentDecision(state).actorId, own = privateView(state, actorId), peer = privateView(state, ids.find(id => id !== actorId));
    assert.ok(own.pending.choice.options.length); assert.deepEqual(own.pending.choice.defaultSelection, state.pending.choice.defaultSelection);
    assert.equal(peer.pending.choice.options, undefined); assert.equal(peer.pending.choice.defaultSelection, undefined);
    assert.equal(peer.pending.privatePool, undefined); assertNoCopies(spectatorView(state));
    for (const edit of [
      copy => { copy.pending.choice.defaultSelection = { cardId: copy.deck[0] }; },
      copy => { copy.pending.data.unknown = true; },
      copy => { copy.pending.choice.secret = copy.deck[0]; },
      copy => { copy.pending.choice.kind = 'execute-anything'; },
    ]) { const copy = structuredClone(state); edit(copy); assert.notEqual(gameProblem(copy), null); }
  }
});

test('counter window precedes public hand pooling and public references expire per revision', () => {
  let state = useStage(fresh()); const cardId = take(state, 'M02');
  const originalHands = state.players.map(player => [...player.hand]);
  state = run(state, 'play-character', { cardId });
  assert.equal(state.pending.response.kind, 'counter'); assert.equal(state.pending.poolCards.length, 0);
  const during = spectatorView(state); assert.equal(during.pending.poolCount, 0); assertNoCopies(during);
  assert.ok(state.players[1].hand.length); assert.ok(originalHands.flat().length);
  state = run(state, 'decline-response');
  const publicView = spectatorView(state), owner = privateView(state, currentDecision(state).actorId);
  assert.equal(publicView.pending.pool.length, state.pending.poolCards.length);
  assert.ok(publicView.pending.pool.every(card => card.definitionId && /^pool:\d+:\d+$/u.test(card.ref)));
  assertNoCopies(publicView); assert.ok(owner.pending.choice.options.length);
  assertNoCopies(owner.pending.choice);
  const before = publicView.pending.pool[0].ref;
  state = run(state, 'choose-effect', { selection: owner.pending.choice.defaultSelection });
  assert.ok(spectatorView(state).pending.pool.every(card => card.ref !== before));
});

test('public installed tools have opaque revision references while owners retain operation IDs', () => {
  const state = fresh(), ownerId = state.players[0].id, toolId = installed(state, 'T08', ownerId);
  const own = privateView(state, ownerId), peer = privateView(state, state.players[1].id), publicView = spectatorView(state);
  assert.equal(own.players[0].tools[0].cardId, toolId);
  assert.equal(peer.players[0].tools[0].cardId, undefined);
  assert.equal(publicView.players[0].tools[0].ref, `tool-0:${state.revision}:0`); assertNoCopies(publicView);
});

test('goods retention pending remains conserved and rejects a foreign selection actor', () => {
  let state = useStage(fresh()), owner = state.players.find(player => player.id === state.turnPlayerId);
  owner.goods = { ...emptyGoods(), firearms: 5 }; state.bankGoods.firearms = 1;
  const cardId = take(state, 'C10'); state = run(state, 'play-character', { cardId });
  state = run(state, 'choose-effect', { selection: { goodsId: 'imports' } });
  assert.equal(state.pending.choice.kind, 'retain-goods'); assert.equal(gameProblem(state), null);
  const corrupt = structuredClone(state); corrupt.pending.receipt.actorId = ids.find(id => id !== owner.id);
  assert.notEqual(gameProblem(corrupt), null);
});

test('numeric-leading seat identities remain valid in M05 temporary-payment bookkeeping', () => {
  const numeric = ['1'.repeat(32), '2'.repeat(32)];
  let state = createGame(numeric, { matchId, now: 1000, randomInt: max => max - 1, actionLimit: 10, goodsPerType: 6 });
  state = useStage(state);
  state.players[0].goods.firearms = 6; state.players[0].temporaryOccupied = true; state.bankGoods.firearms = 0;
  const cardId = take(state, 'M05'); state = run(state, 'play-character', { cardId }); state = run(state, 'decline-response');
  assert.equal(state.pending.data.tempPaid[numeric[0]], true); assert.equal(gameProblem(state), null);
  const corrupt = structuredClone(state); corrupt.pending.data.tempPaid.other = true;
  assert.notEqual(gameProblem(corrupt), null);
});
