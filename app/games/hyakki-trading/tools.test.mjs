import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, GOODS } from './content/definitions.mjs';
import { definition, emptyGoods, moveGoods, createPending, removeCard } from './model.mjs';
import { toolProblem, startTool, continueTool, chooseTool, implementedToolCodes } from './tools.mjs';
import { validateHyakkiPublicEvent } from '../../../server/games/hyakki-trading/event-store.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32)], ctx = { now: 1000, randomInt: max => max - 1 };
function fixture() {
  return { matchId: 'c'.repeat(32), revision: 1, turnNumber: 1, turnPlayerId: ids[0], stage: 'use', drawStarted: false,
    actionsUsed: 0, pending: null, lastPublicEvents: [], deck: createDeck().map(card => card.id), discard: [],
    bankGoods: Object.fromEntries(GOODS.map(good => [good.id, 6])),
    players: ids.map(id => ({ id, hand: [], tools: [], goods: emptyGoods(), silver: 20, stallCount: 0, temporaryOccupied: false })) };
}
function take(state, code) {
  const cardId = state.deck.find(card => definition(card).sourceCode === code);
  assert.ok(cardId); removeCard(state.deck, cardId); return cardId;
}
function hand(state, code, index = 0) { const id = take(state, code); state.players[index].hand.push(id); return id; }
function install(state, code, index = 0) { const id = take(state, code); state.players[index].tools.push({ cardId: id, exhausted: false }); return id; }
function stock(state, index, vector) {
  moveGoods(state.bankGoods, state.players[index].goods, { ...emptyGoods(), ...vector });
  state.players[index].temporaryOccupied = Object.values(state.players[index].goods).reduce((a, b) => a + b, 0) > 5;
}
function top(state, codes) { const cards = codes.map(code => take(state, code)); state.deck.unshift(...cards); return cards; }
function activate(state, id, params = {}) {
  assert.equal(toolProblem(state, ids[0], id, params), null);
  state.players[0].tools.find(tool => tool.cardId === id).exhausted = true; state.actionsUsed++;
  startTool(state, id, params, ctx); conserved(state);
}
function conserved(state) {
  const cards = [...state.deck, ...state.discard, ...state.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])];
  assert.equal(cards.length, 110); assert.equal(new Set(cards).size, 110);
  for (const good of GOODS) assert.equal(state.bankGoods[good.id] + state.players.reduce((sum, owner) => sum + owner.goods[good.id], 0)
    + (state.pending?.goods[good.id] ?? 0), 6);
  for (const owner of state.players) assert(Number.isSafeInteger(owner.silver) && owner.silver >= 0);
  state.lastPublicEvents.forEach(validateHyakkiPublicEvent);
}

test('T01 reveals a finite search, fixes its hit and pays only after choosing', () => {
  const state = fixture(), tool = install(state, 'T01'), payment = hand(state, 'C03');
  const [miss, hit, later] = top(state, ['C02', 'G01', 'C01']);
  activate(state, tool);
  assert.deepEqual(state.pending.poolCards, [hit]); assert.equal(state.discard.at(-1), miss);
  assert.equal(state.players[0].silver, 20); assert.deepEqual(state.lastPublicEvents[0].cardIds, ['yousei.c02', 'yousei.g01']);
  const recovered = structuredClone(state); continueTool(recovered, ctx); assert.deepEqual(recovered, state);
  assert.throws(() => chooseTool(structuredClone(state), { kind: 'card', cardId: hit }, ctx));
  chooseTool(state, { kind: 'card', cardId: payment }, ctx);
  assert(state.players[0].hand.includes(hit)); assert.equal(state.deck[0], later); assert.equal(state.discard.at(-1), payment);
  assert.equal(state.pending, null); assert.equal(state.actionsUsed, 1); conserved(state);
});

test('T01 no-goods search exhausts eligible material once without the acquisition fee', () => {
  const state = fixture(), tool = install(state, 'T01');
  state.players[1].hand = state.deck.splice(0).filter(card => definition(card).category === 'goods');
  const used = new Set([tool, ...state.players[1].hand]);
  state.deck = createDeck().map(card => card.id).filter(card => !used.has(card));
  const inspected = state.deck.length;
  activate(state, tool);
  assert.equal(state.pending, null); assert.equal(state.deck.length, 0); assert.equal(state.discard.length, inspected);
  assert.equal(state.players[0].silver, 20); assert.equal(state.actionsUsed, 1); conserved(state);
});

test('T02 equal exchange preserves already occupied temporary positions and accepts same type', () => {
  const state = fixture(), tool = install(state, 'T02');
  stock(state, 0, { firearms: 3, imports: 3 }); stock(state, 1, { curios: 3, beasts: 3 });
  activate(state, tool); chooseTool(state, { ownGoodId: 'firearms', otherGoodId: 'curios' }, ctx);
  assert.equal(state.players[0].goods.curios, 1); assert.equal(state.players[1].goods.firearms, 1);
  assert.deepEqual(state.players.map(owner => owner.silver), [20, 20]);
  assert(state.players.every(owner => owner.temporaryOccupied)); conserved(state);
  state.players[0].tools[0].exhausted = false;
  activate(state, tool); const before = structuredClone(state.players.map(owner => owner.goods));
  chooseTool(state, { ownGoodId: 'firearms', otherGoodId: 'firearms' }, ctx);
  assert.deepEqual(state.players.map(owner => owner.goods), before); conserved(state);
});

test('T03 pays one or two hand cards before a possible reshuffle, including drawing them back', () => {
  const state = fixture(), tool = install(state, 'T03'), a = hand(state, 'C01'), b = hand(state, 'C02');
  state.players[1].hand.push(...state.deck.splice(0));
  activate(state, tool);
  assert.throws(() => chooseTool(structuredClone(state), { cardIds: [a, a] }, ctx));
  chooseTool(state, { cardIds: [b, a] }, ctx);
  assert.deepEqual([...state.players[0].hand].sort(), [a, b].sort()); assert.equal(state.discard.length, 0);
  assert.equal(state.actionsUsed, 1); conserved(state);
});

test('T04 retains the original two private candidates and transfers exactly one each', () => {
  const state = fixture(), tool = install(state, 'T04'), pair = top(state, ['C01', 'C02']);
  activate(state, tool); assert.equal(state.pending.choice.visibility, 'private');
  const recovered = structuredClone(state); continueTool(recovered, ctx); assert.deepEqual(recovered.pending.poolCards, pair);
  chooseTool(recovered, { cardId: pair[1] }, ctx);
  assert.deepEqual(recovered.players.map(owner => owner.hand), [[pair[1]], [pair[0]]]);
  assert.equal(recovered.pending, null); conserved(recovered);
  const insufficient = fixture(), otherTool = install(insufficient, 'T04');
  insufficient.players[1].hand.push(...insufficient.deck.splice(1));
  assert.match(toolProblem(insufficient, ids[0], otherTool), /2张/);
});

test('T05 charges exactly one silver and draws once without a normal peek decision', () => {
  const state = fixture(), tool = install(state, 'T05'), [card] = top(state, ['C01']);
  activate(state, tool); assert.deepEqual(state.players[0].hand, [card]); assert.equal(state.players[0].silver, 19);
  assert.equal(state.pending, null); assert.equal(state.players[0].tools[0].exhausted, true); conserved(state);
  state.players[0].tools[0].exhausted = false; state.players[0].silver = 0;
  assert.match(toolProblem(state, ids[0], tool), /1两/);
});

test('T06 returns an actual owned good and clears the temporary position without refund', () => {
  const state = fixture(), tool = install(state, 'T06'); stock(state, 0, { firearms: 6 });
  activate(state, tool); chooseTool(state, { goodId: 'firearms' }, ctx);
  assert.equal(state.players[0].goods.firearms, 5); assert.equal(state.bankGoods.firearms, 1);
  assert.equal(state.players[0].temporaryOccupied, false); assert.equal(state.players[0].silver, 20);
  assert.equal(state.players[0].hand.length, 1); conserved(state);
});

test('T07 swaps only the saved discard top before the first peek, and cannot be borrowed', () => {
  const state = fixture(), tool = install(state, 'T07'), ours = hand(state, 'C01'), theirs = take(state, 'C02');
  state.discard.push(theirs); state.stage = 'draw'; activate(state, tool); chooseTool(state, { cardId: ours }, ctx);
  assert.deepEqual(state.players[0].hand, [theirs]); assert.equal(state.discard.at(-1), ours);
  assert.equal(state.stage, 'draw'); assert.equal(state.drawStarted, false); conserved(state);
  state.players[0].tools[0].exhausted = false; state.drawStarted = true;
  assert.match(toolProblem(state, ids[0], tool), /第一次/);
  assert.match(toolProblem(state, ids[0], tool, {}, { borrowed: true }), /不能借用/);
});

test('T08 can sacrifice itself or an already exhausted own tool, but never an opponent card', () => {
  for (const self of [true, false]) {
    const state = fixture(), tool = install(state, 'T08'), other = install(state, 'T05');
    state.players[0].tools[1].exhausted = true;
    const foreign = install(state, 'T01', 1); activate(state, tool);
    assert.throws(() => chooseTool(structuredClone(state), { payment: { zone: 'tool', cardId: foreign } }, ctx));
    chooseTool(state, { payment: { zone: 'tool', cardId: self ? tool : other } }, ctx);
    assert.equal(state.players[0].silver, 22); assert(!state.players[0].tools.some(entry => entry.cardId === (self ? tool : other)));
    if (!self) assert.equal(state.players[0].tools.find(entry => entry.cardId === tool).exhausted, true);
    conserved(state);
  }
});

test('T09 validates purchase plus temporary fee before activation and gives exactly one good', () => {
  const state = fixture(), tool = install(state, 'T09'); stock(state, 0, { firearms: 5 }); state.players[0].silver = 3;
  const before = structuredClone(state); assert.match(toolProblem(state, ids[0], tool), /位置/); assert.deepEqual(state, before);
  state.players[0].silver = 4; activate(state, tool); chooseTool(state, { goodId: 'imports' }, ctx);
  assert.equal(state.players[0].silver, 0); assert.equal(state.players[0].goods.imports, 1);
  assert.equal(state.players[0].temporaryOccupied, true); conserved(state);
});

test('T10 pays own hand or itself, and cannot use character-style stock dropping', () => {
  const state = fixture(), tool = install(state, 'T10'), payment = hand(state, 'C01');
  activate(state, tool); chooseTool(state, { goodId: 'firearms', payment: { zone: 'hand', cardId: payment } }, ctx);
  assert.equal(state.players[0].goods.firearms, 1); assert.equal(state.discard.at(-1), payment); conserved(state);
  state.players[0].tools[0].exhausted = false; stock(state, 0, { imports: 5 });
  assert.match(toolProblem(state, ids[0], tool), /位置/);
  const other = fixture(), ownTool = install(other, 'T10'); activate(other, ownTool);
  chooseTool(other, { goodId: 'imports', payment: { zone: 'tool', cardId: ownTool } }, ctx);
  assert.equal(other.players[0].tools.length, 0); assert.equal(other.players[0].goods.imports, 1); conserved(other);
});

test('borrowed effects keep M08 outside payment and discard it last, with no extra action', () => {
  const state = fixture(), source = take(state, 'M08'), target = install(state, 'T08', 1), payment = hand(state, 'C01');
  state.players[1].tools = []; state.discard.push(target); state.actionsUsed = 1;
  createPending(state, { kind: 'character', ownerId: ids[0], code: 'M08', sourceCards: [source] });
  assert.equal(toolProblem(state, ids[0], target, {}, { borrowed: true }), null);
  startTool(state, target, {}, ctx, { borrowed: true });
  assert.deepEqual(state.pending.sourceCards, [source]); assert.equal(state.pending.data.borrowed, true);
  for (const forbidden of [source, target]) assert.throws(() => chooseTool(structuredClone(state), { payment: { zone: 'hand', cardId: forbidden } }, ctx));
  chooseTool(state, { payment: { zone: 'hand', cardId: payment } }, ctx);
  assert.deepEqual(state.discard.slice(-3), [target, payment, source]); assert.equal(state.actionsUsed, 1);
  assert.equal(state.players[0].silver, 22); conserved(state);
});

test('borrowed T08 and T10 with no own payment are unavailable and do not modify the character', () => {
  for (const code of ['T08', 'T10']) {
    const state = fixture(), source = take(state, 'M08'), target = take(state, code); state.discard.push(target);
    createPending(state, { kind: 'character', ownerId: ids[0], code: 'M08', sourceCards: [source] });
    const before = structuredClone(state); assert.notEqual(toolProblem(state, ids[0], target, {}, { borrowed: true }), null);
    assert.deepEqual(state, before); conserved(state);
  }
  assert.equal(implementedToolCodes.length, 10);
});
