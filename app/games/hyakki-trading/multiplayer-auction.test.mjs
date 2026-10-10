import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, GOODS } from './content/definitions.mjs';
import { definition, emptyGoods, moveGoods, createPending, removeCard } from './model.mjs';
import { beginAuction, bid, passBid, continueAuction } from './auction.mjs';

const ids = Array.from({ length: 6 }, (_, index) => (index + 1).toString(16).padStart(32, '0'));
const ctx = { now: 1000 };
function fixture(kind, count = 6, ownerIndex = 0) {
  const state = { ruleVersion: 'yousei-digital-v2', matchId: 'c'.repeat(32), revision: 1, turnNumber: 1,
    turnPlayerId: ids[ownerIndex], actionsUsed: 1, pending: null, lastPublicEvents: [], deck: createDeck().map(card => card.id), discard: [],
    bankGoods: Object.fromEntries(GOODS.map(good => [good.id, 8])), players: ids.slice(0, count).map(id => ({
      id, hand: [], tools: [], goods: emptyGoods(), silver: 20, stallCount: 0, temporaryOccupied: false })) };
  const source = state.deck.find(id => definition(id).sourceCode === (kind === 'cards' ? 'C12' : 'C09'));
  removeCard(state.deck, source); createPending(state, { kind: 'character', ownerId: state.turnPlayerId,
    code: kind === 'cards' ? 'C12' : 'C09', sourceCards: [source] });
  if (kind === 'cards') state.pending.poolCards.push(...state.deck.splice(0, 3));
  else moveGoods(state.bankGoods, state.pending.goods, { ...emptyGoods(), firearms: 1, imports: 1 });
  beginAuction(state, { ownerId: state.turnPlayerId, kind }, ctx); return state;
}
function conserved(state) {
  const cards = [...state.deck, ...state.discard, ...state.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])];
  assert.deepEqual([...cards].sort(), createDeck().map(card => card.id).sort()); assert.equal(new Set(cards).size, 110);
  for (const good of GOODS) assert.equal(state.bankGoods[good.id] + state.players.reduce((sum, owner) => sum + owner.goods[good.id], 0)
    + (state.pending?.goods[good.id] ?? 0), 8);
}

test('six-player bidding does not settle after one pass and skips the highest bidder on the next cycle', () => {
  const state = fixture('cards'), lot = [...state.pending.poolCards];
  bid(state, ids[0], 1, ctx); passBid(state, ids[1], ctx);
  assert.equal(state.pending.stage, 'bidding'); assert.equal(state.pending.data.auction.currentBidderId, ids[2]);
  bid(state, ids[2], 2, ctx); passBid(state, ids[3], ctx); bid(state, ids[4], 3, ctx); passBid(state, ids[5], ctx);
  assert.equal(state.pending.data.auction.currentBidderId, ids[0]); passBid(state, ids[0], ctx);
  assert.equal(state.pending.data.auction.currentBidderId, ids[2]);
  const saved = structuredClone(state); continueAuction(saved, ctx); assert.deepEqual(saved, state);
  passBid(saved, ids[2], ctx);
  assert.equal(saved.pending, null); assert.deepEqual(saved.players[4].hand, lot);
  assert.deepEqual(saved.players.map(owner => owner.silver), [20, 20, 20, 20, 17, 20]); conserved(saved);
});

for (let count = 2; count <= 6; count++) for (const kind of ['goods', 'cards']) {
  test(`${count} players: full initial pass rotation releases the complete ${kind} lot once`, () => {
    const ownerIndex = count - 1, state = fixture(kind, count, ownerIndex), lot = [...state.pending.poolCards], source = state.pending.sourceCards[0];
    for (let step = 0; step < count; step++) {
      const actor = ids[(ownerIndex + step) % count]; assert.equal(state.pending.data.auction.currentBidderId, actor);
      passBid(state, actor, ctx); if (step < count - 1) assert.equal(state.pending.stage, 'bidding');
    }
    assert.equal(state.pending, null); assert(state.players.every(owner => owner.silver === 20));
    if (kind === 'cards') assert.deepEqual(state.discard.slice(-4), [...lot, source]);
    else assert(GOODS.every(good => state.bankGoods[good.id] === 8)); conserved(state);
  });
}

test('last remaining bidder wins immediately after a legal opening bid when all five others already passed', () => {
  const state = fixture('cards'), lot = [...state.pending.poolCards];
  for (let index = 0; index < 5; index++) passBid(state, ids[index], ctx);
  bid(state, ids[5], 7, ctx); assert.equal(state.pending, null); assert.deepEqual(state.players[5].hand, lot);
  assert.equal(state.players[5].silver, 13); conserved(state);
});

test('a passed bidder cannot return and every rejected bid preserves the entire ledger and lot', () => {
  const state = fixture('cards'); passBid(state, ids[0], ctx); bid(state, ids[1], 2, ctx);
  for (const [actor, amount] of [[ids[0], 3], [ids[2], 2], [ids[2], 1.5], [ids[2], 21]]) {
    const before = structuredClone(state); assert.throws(() => bid(state, actor, amount, ctx)); assert.deepEqual(state, before);
  }
  conserved(state);
});
