import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, GOODS } from './content/definitions.mjs';
import { definition, emptyGoods, moveGoods, createPending, removeCard, resolveReceipt } from './model.mjs';
import { beginAuction, bid, passBid, continueAuction } from './auction.mjs';
import { validateHyakkiPublicEvent } from '../../../server/games/hyakki-trading/event-store.mjs';
const ids = ['a'.repeat(32), 'b'.repeat(32)], ctx = { now: 1000, randomInt: max => max - 1 };
function fixture(kind) {
  const state = { matchId: 'c'.repeat(32), revision: 1, turnNumber: 1, turnPlayerId: ids[0], actionsUsed: 1,
    pending: null, lastPublicEvents: [], deck: createDeck().map(card => card.id), discard: [],
    bankGoods: Object.fromEntries(GOODS.map(good => [good.id, 6])),
    players: ids.map(id => ({ id, hand: [], tools: [], goods: emptyGoods(), silver: 20, stallCount: 0, temporaryOccupied: false })) };
  const source = state.deck.find(card => definition(card).sourceCode === (kind === 'cards' ? 'C12' : 'C09'));
  removeCard(state.deck, source); createPending(state, { kind: 'character', ownerId: ids[0], code: kind === 'cards' ? 'C12' : 'C09', sourceCards: [source] });
  if (kind === 'cards') state.pending.poolCards.push(...state.deck.splice(0, 3));
  else moveGoods(state.bankGoods, state.pending.goods, { ...emptyGoods(), firearms: 1, imports: 1 });
  beginAuction(state, { ownerId: ids[0], kind }, ctx); conserved(state); return state;
}
function conserved(state) {
  const cards = [...state.deck, ...state.discard, ...state.players.flatMap(owner => owner.hand),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])];
  assert.equal(cards.length, 110); assert.equal(new Set(cards).size, 110);
  for (const good of GOODS) assert.equal(state.bankGoods[good.id] + state.players.reduce((sum, owner) => sum + owner.goods[good.id], 0)
    + (state.pending?.goods[good.id] ?? 0), 6);
  state.lastPublicEvents.forEach(validateHyakkiPublicEvent);
}

test('cards auction starts at owner and pays once for all three saved cards', () => {
  const state = fixture('cards'), lot = [...state.pending.poolCards], source = state.pending.sourceCards[0];
  assert.equal(state.pending.data.auction.currentBidderId, ids[0]);
  bid(state, ids[0], 1, ctx); bid(state, ids[1], 2, ctx); bid(state, ids[0], 3, ctx);
  assert.deepEqual(state.players.map(owner => owner.silver), [20, 20]);
  const recovered = structuredClone(state); continueAuction(recovered, ctx); assert.deepEqual(recovered, state);
  passBid(recovered, ids[1], ctx);
  assert.equal(recovered.pending, null); assert.deepEqual(recovered.players[0].hand, lot);
  assert.deepEqual(recovered.players.map(owner => owner.silver), [17, 20]); assert.equal(recovered.discard.at(-1), source);
  assert.equal(recovered.actionsUsed, 1); conserved(recovered);
});

test('both initial passes return goods or discard the complete card lot in original order', () => {
  for (const kind of ['cards', 'goods']) {
    const state = fixture(kind), lot = [...state.pending.poolCards], source = state.pending.sourceCards[0];
    passBid(state, ids[0], ctx); assert(state.pending); passBid(state, ids[1], ctx);
    assert.equal(state.pending, null); assert.deepEqual(state.players.map(owner => owner.silver), [20, 20]);
    if (kind === 'cards') assert.deepEqual(state.discard.slice(-4), [...lot, source]);
    else assert(GOODS.every(good => state.bankGoods[good.id] === 6));
    conserved(state);
  }
});

test('owner may pass first and opponent wins immediately on their first legal bid', () => {
  const state = fixture('cards'), lot = [...state.pending.poolCards];
  passBid(state, ids[0], ctx); bid(state, ids[1], 1, ctx);
  assert.equal(state.pending, null); assert.deepEqual(state.players[1].hand, lot); assert.equal(state.players[1].silver, 19); conserved(state);
});

test('wrong actor, non-integer, unaffordable or non-increasing bids leave the auction unchanged', () => {
  const state = fixture('cards');
  for (const [actor, value] of [[ids[1], 1], [ids[0], 0], [ids[0], 1.5], [ids[0], 21], [ids[0], Number.MAX_SAFE_INTEGER + 1]]) {
    const before = structuredClone(state); assert.throws(() => bid(state, actor, value, ctx)); assert.deepEqual(state, before);
  }
  bid(state, ids[0], 5, ctx);
  for (const value of [4, 5]) { const before = structuredClone(state); assert.throws(() => bid(state, ids[1], value, ctx)); assert.deepEqual(state, before); }
  conserved(state);
});

test('goods winner may bid their whole balance and retain ordinary capacity by dropping old goods', () => {
  const state = fixture('goods');
  moveGoods(state.bankGoods, state.players[0].goods, { ...emptyGoods(), curios: 5 }); state.players[0].silver = 2;
  bid(state, ids[0], 2, ctx); passBid(state, ids[1], ctx);
  assert.equal(state.players[0].silver, 0); assert.equal(state.pending.stage, 'delivering');
  assert.equal(state.pending.receipt.actorId, ids[0]); const original = structuredClone(state);
  continueAuction(state, ctx); assert.deepEqual(state, original);
  resolveReceipt(state, { ...emptyGoods(), curios: 3, firearms: 1, imports: 1 }); continueAuction(state, ctx);
  assert.equal(state.pending, null); assert.equal(state.players[0].goods.curios, 3); assert.equal(state.players[0].goods.imports, 1);
  assert.equal(state.players[0].silver, 0); assert.equal(state.players[0].temporaryOccupied, false); conserved(state);
});

test('goods auction charges a new temporary position once after the winning payment', () => {
  const state = fixture('goods'); moveGoods(state.bankGoods, state.players[1].goods, { ...emptyGoods(), curios: 4 });
  bid(state, ids[0], 1, ctx); bid(state, ids[1], 2, ctx); passBid(state, ids[0], ctx);
  assert.equal(state.pending, null); assert.equal(state.players[1].silver, 16);
  assert.equal(state.players[1].temporaryOccupied, true); conserved(state);
});
