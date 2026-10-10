import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, currentDecision, gameProblem } from './rules.mjs';
import { createDeck, GOODS, DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION } from './content/definitions.mjs';
import { definition, emptyGoods, goodsCount, refreshTemporary } from './model.mjs';
import { implementedCharacterCodes, characterProblem } from './effects.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32)];
const ctx = { now: 1000, randomInt: limit => limit - 1 };
const goods = entries => ({ ...emptyGoods(), ...entries });
function fixture(code, { playerIds = ids, ruleVersion = DIGITAL_RULE_VERSION } = {}) {
  const state = createGame(playerIds, { ...ctx, matchId: 'c'.repeat(32), actionLimit: 10, goodsPerType: 6, firstPlayerId: playerIds[0], ruleVersion });
  state.deck = [...state.deck, ...state.players.flatMap(owner => owner.hand)].sort();
  state.players.forEach(owner => { owner.hand = []; });
  state.stage = 'use'; state.drawStarted = true;
  const f = { state, owner: state.players[0], peer: state.players[1], params: {} };
  f.take = target => {
    const index = state.deck.findIndex(id => definition(id).sourceCode === target);
    assert.ok(index >= 0, `missing fixture ${target}`); return state.deck.splice(index, 1)[0];
  };
  f.hand = (owner, target) => { const card = f.take(target); owner.hand.push(card); return card; };
  f.tool = (owner, target, exhausted = true) => {
    const cardId = f.take(target); owner.tools.push({ cardId, exhausted }); return cardId;
  };
  f.stock = (owner, entries) => {
    for (const [id, count] of Object.entries(entries)) { state.bankGoods[id] -= count; owner.goods[id] += count; }
    refreshTemporary(owner);
  };
  f.cardId = f.hand(f.owner, code);
  switch (code) {
    case 'C05': f.hand(f.owner, 'G01'); f.stock(f.owner, { 'salt-iron': 3 }); break;
    case 'C06': f.stock(f.owner, { firearms: 3, 'salt-iron': 1 }); break;
    case 'C11': state.discard.push(f.take('T01')); break;
    case 'C13': f.stock(f.owner, { firearms: 1 }); break;
    case 'M01': f.stock(f.peer, { firearms: 1 }); f.params = { goodsId: 'firearms' }; break;
    case 'M02': f.hand(f.owner, 'G01'); f.hand(f.peer, 'G02'); break;
    case 'M03': f.tool(f.owner, 'T01'); f.tool(f.owner, 'T02'); f.tool(f.peer, 'T05'); break;
    case 'M05': f.stock(f.owner, { firearms: 3 }); f.stock(f.peer, { imports: 2 }); break;
    case 'M06': f.tool(f.owner, 'T01'); f.tool(f.owner, 'T02'); f.tool(f.peer, 'T05'); break;
    case 'M07': f.hand(f.peer, 'G01'); break;
    case 'M08': f.params = { toolCardId: f.tool(f.peer, 'T05') }; break;
  }
  return f;
}
function action(state, type, fields = {}, actorId = currentDecision(state)?.actorId ?? state.turnPlayerId, context = ctx) {
  const decision = currentDecision(state);
  return applyGameAction(state, actorId, { type, matchId: state.matchId, turnId: state.turnId,
    ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}), ...fields }, context);
}
function accept(state, type, fields = {}, actorId, context) {
  const next = action(state, type, fields, actorId, context);
  assert.equal(next.ok, true, `${type}: ${next.code ?? ''} ${next.error ?? ''}`);
  assert.equal(gameProblem(next.state), null); conserved(next.state); return next.state;
}
function conserved(state) {
  const cards = [...state.deck, ...state.discard, ...state.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])];
  assert.equal(cards.length, 110); assert.equal(new Set(cards).size, 110);
  assert.deepEqual([...cards].sort(), createDeck().map(card => card.id).sort());
  for (const { id } of GOODS) assert.equal(state.bankGoods[id] + state.players.reduce((sum, owner) => sum + owner.goods[id], 0)
    + (state.pending?.goods[id] ?? 0), 6);
}
function start(f) { return accept(f.state, 'play-character', { cardId: f.cardId, params: f.params }); }
function settle(initial) {
  let state = initial, steps = 0;
  while (state.pending) {
    assert.ok(++steps <= 120, 'character must finish in bounded material steps');
    if (state.pending.response) state = accept(state, 'decline-response');
    else if (state.pending.choice) state = accept(state, 'choose-effect', { selection: state.pending.choice.defaultSelection });
    else if (state.pending.kind === 'auction') state = accept(state, 'pass-bid');
    else assert.fail(`effect stalled: ${state.pending.code} ${state.pending.stage}`);
  }
  return state;
}
function rejected(state, type, fields = {}, actorId) {
  const before = structuredClone(state), result = action(state, type, fields, actorId);
  assert.equal(result.ok, false); assert.deepEqual(state, before);
}

test('all 21 character definitions have their own engine coverage, including the two response-only cards', () => {
  assert.equal(implementedCharacterCodes.length, 21); assert.equal(new Set(implementedCharacterCodes).size, 21);
});

for (const code of implementedCharacterCodes.filter(code => !['C04', 'C07'].includes(code))) {
  test(`${code}: legal activation and all deterministic choices finish with conserved materials and one action`, () => {
    const f = fixture(code);
    assert.equal(gameProblem(f.state), null); assert.equal(characterProblem(f.state, f.owner.id, f.cardId, f.params), null);
    const result = settle(start(f));
    assert.equal(result.actionsUsed, 1); assert.equal(result.turnPlayerId, f.owner.id);
    assert.ok(result.discard.includes(f.cardId));
  });
  test(`${code}: wrong phase refuses without taking a card, action, payment or target`, () => {
    const f = fixture(code); f.state.stage = 'draw'; f.state.drawStarted = false;
    rejected(f.state, 'play-character', { cardId: f.cardId, params: f.params });
  });
}

for (const code of ['C04', 'C07']) test(`${code}: response card cannot be played as a normal action`, () => {
  const f = fixture(code); rejected(f.state, 'play-character', { cardId: f.cardId, params: {} });
});

test('C04 / C05: a free merchant takes only the goods subcard, after a three-good sale with two book layers', () => {
  const f = fixture('C05'), merchant = f.hand(f.peer, 'C04'); f.state.bookLayers = 2; f.state.actionsUsed = 2;
  let state = start(f); const tradeCardId = state.pending.choice.defaultSelection.cardId;
  state = accept(state, 'choose-effect', { selection: { cardId: tradeCardId } });
  state = accept(state, 'choose-effect', { selection: { goods: goods({ 'salt-iron': 3 }) } });
  assert.equal(state.players[0].silver, 34); assert.equal(state.pending.response.kind, 'merchant');
  const responseState = structuredClone(state);
  state = accept(state, 'respond', { cardId: merchant });
  assert.equal(state.players[0].silver, 34); assert.equal(state.players[0].goods['salt-iron'], 0);
  assert.ok(state.players[1].hand.includes(tradeCardId)); assert.ok(state.discard.includes(f.cardId));
  assert.ok(state.discard.includes(merchant)); assert.equal(state.actionsUsed, 3);
  rejected(state, 'respond', { cardId: merchant }, ids[1]);
  rejected(responseState, 'respond', { cardId: f.cardId }, ids[0]);
});

for (const code of implementedCharacterCodes.filter(code => code.startsWith('M'))) {
  test(`${code} / C07: counter precedes every hidden draw, public pool, transfer and cost`, () => {
    const f = fixture(code), counter = f.hand(f.peer, 'C07'), before = structuredClone(f.state);
    let state = start(f);
    assert.equal(state.pending.response.kind, 'counter'); assert.deepEqual(state.pending.poolCards, []);
    assert.equal(goodsCount(state.pending.goods), 0); assert.equal(state.pending.choice, null);
    assert.deepEqual(state.deck, before.deck); assert.deepEqual(state.discard, before.discard);
    assert.deepEqual(state.players[1], before.players[1]);
    state = accept(state, 'respond', { cardId: counter });
    assert.equal(state.pending, null); assert.equal(state.actionsUsed, 1);
    assert.deepEqual(state.discard.slice(-2), [f.cardId, counter]);
    assert.deepEqual(state.players[0].hand, before.players[0].hand.filter(id => id !== f.cardId));
    assert.deepEqual(state.players[1].hand, before.players[1].hand.filter(id => id !== counter));
    for (let index = 0; index < 2; index++) {
      assert.equal(state.players[index].silver, before.players[index].silver);
      assert.deepEqual(state.players[index].goods, before.players[index].goods);
      assert.deepEqual(state.players[index].tools, before.players[index].tools);
    }
  });
}

test('C02: the saved private batch survives restore and unchosen cards return in original relative order', () => {
  const f = fixture('C02'); let state = start(f);
  const pool = [...state.pending.poolCards], originalRemainder = [...state.deck];
  assert.equal(pool.length, 6); assert.equal(state.pending.choice.visibility, 'private');
  state = JSON.parse(JSON.stringify(state));
  rejected(state, 'choose-effect', { selection: { cardId: state.deck[0] } });
  state = accept(state, 'choose-effect', { selection: { cardId: pool[2] } });
  assert.deepEqual(state.deck, [...pool.filter(id => id !== pool[2]), ...originalRemainder]);
  assert.deepEqual(state.players[0].hand, [pool[2]]);
});

test('C01: the receiving opponent makes their own goods choice after the owner privately draws', () => {
  const f = fixture('C01'); let state = start(f);
  state = accept(state, 'choose-effect', { selection: { branch: 'draw' } });
  assert.equal(state.players[0].hand.length, 2); assert.equal(state.pending.choice.actorId, ids[1]);
  rejected(state, 'choose-effect', { selection: { goodsId: 'salt-iron' } }, ids[0]);
  state = accept(state, 'choose-effect', { selection: { goodsId: 'salt-iron' } });
  assert.equal(state.players[1].goods['salt-iron'], 2); assert.equal(state.pending, null);
});

test('C05: G19 is never a three-good subcard and declining merchant discards subcard before outer character', () => {
  const f = fixture('C05'), old = f.owner.hand.find(id => definition(id).sourceCode === 'G01');
  f.owner.hand.splice(f.owner.hand.indexOf(old), 1); f.state.deck.push(old); f.hand(f.owner, 'G19');
  rejected(f.state, 'play-character', { cardId: f.cardId });
  f.hand(f.owner, 'G01'); let state = start(f);
  rejected(state, 'choose-effect', { selection: { cardId: f.owner.hand.find(id => definition(id).sourceCode === 'G19') } });
  const tradeCard = state.pending.choice.defaultSelection.cardId;
  state = settle(state); assert.deepEqual(state.discard.slice(-2), [tradeCard, f.cardId]);
});

test('C06: the whole chosen type is exchanged and an already occupied temporary slot is not charged again', () => {
  const f = fixture('C06'); f.stock(f.owner, { imports: 2 });
  let state = start(f);
  rejected(state, 'choose-effect', { selection: { fromGoodsId: 'firearms', toGoodsId: 'firearms' } });
  state = accept(state, 'choose-effect', { selection: { fromGoodsId: 'firearms', toGoodsId: 'curios' } });
  assert.equal(state.players[0].goods.firearms, 0); assert.equal(state.players[0].goods.curios, 3);
  assert.equal(state.players[0].silver, 20); assert.equal(state.players[0].temporaryOccupied, true);
});

test('C08: the opponent privately chooses exactly the excess cards, and may not discard duplicates', () => {
  const f = fixture('C08'); for (const code of ['G01', 'G02', 'G03', 'G04', 'G05']) f.hand(f.peer, code);
  let state = start(f); state = accept(state, 'choose-effect', { selection: { branch: 'discard' } });
  assert.equal(state.pending.choice.actorId, ids[1]); assert.equal(state.pending.choice.visibility, 'private');
  const first = state.players[1].hand[0];
  rejected(state, 'choose-effect', { selection: { cardIds: [first, first] } });
  const dropped = [state.players[1].hand[3], state.players[1].hand[0]];
  state = accept(state, 'choose-effect', { selection: { cardIds: dropped } });
  assert.equal(state.players[1].hand.length, 3); assert.deepEqual(state.discard.slice(-3), [...dropped].sort().concat(f.cardId));
});

test('C09 and C12: fixed public auction lots are persisted and the source is discarded after both pass', () => {
  for (const code of ['C09', 'C12']) {
    const f = fixture(code); let state = start(f);
    if (code === 'C09') state = accept(state, 'choose-effect', { selection: { goods: goods({ firearms: 1, imports: 1 }) } });
    assert.equal(state.pending.kind, 'auction');
    const pool = [...state.pending.poolCards]; state = JSON.parse(JSON.stringify(state));
    state = accept(state, 'pass-bid'); state = accept(state, 'pass-bid');
    assert.equal(state.players[0].silver, 20); assert.equal(state.players[1].silver, 20);
    assert.deepEqual(state.discard.slice(-(pool.length + 1)), [...pool, f.cardId]);
    if (code === 'C09') assert.equal(state.bankGoods.firearms, 6);
  }
});

test('C10: fixed two-silver cost is paid once and not refunded when unaffordable temporary goods are discarded', () => {
  const f = fixture('C10'); f.owner.silver = 2; f.stock(f.owner, { firearms: 5 });
  let state = start(f); assert.equal(state.players[0].silver, 0);
  state = JSON.parse(JSON.stringify(state));
  state = accept(state, 'choose-effect', { selection: { goodsId: 'imports' } });
  assert.equal(state.pending.choice.kind, 'retain-goods'); assert.equal(state.players[0].silver, 0);
  state = accept(state, 'choose-effect', { selection: state.pending.choice.defaultSelection });
  assert.equal(state.players[0].silver, 0); assert.equal(state.players[0].goods.firearms, 5);
  assert.equal(state.bankGoods.imports, 6);
});

test('C11: a tool can be recovered from anywhere in the discard pile without being installed', () => {
  const f = fixture('C11'), bottom = f.state.discard[0]; f.state.discard.push(f.take('G01'), f.take('T05'));
  let state = start(f); state = accept(state, 'choose-effect', { selection: { cardId: bottom } });
  assert.ok(state.players[0].hand.includes(bottom)); assert.equal(state.players[0].tools.length, 0);
});

test('C13: fixed proceeds ignore book layers and release a temporary slot without a refund', () => {
  const f = fixture('C13'); f.stock(f.owner, { imports: 5 }); f.state.bookLayers = 2; f.state.actionsUsed = 2;
  let state = start(f); rejected(state, 'choose-effect', { selection: { goods: emptyGoods() } });
  state = accept(state, 'choose-effect', { selection: { goods: goods({ firearms: 1, imports: 2 }) } });
  assert.equal(state.players[0].silver, 26); assert.equal(state.players[0].temporaryOccupied, false);
});

test('M02: the last action waits for counter and the entire alternating draft before ending the turn', () => {
  const f = fixture('M02'); f.hand(f.owner, 'G03'); f.hand(f.peer, 'G04'); f.hand(f.peer, 'G05'); f.state.actionLimit = 1;
  let state = start(f); assert.equal(state.turnPlayerId, ids[0]); assert.equal(state.pending.response.kind, 'counter');
  state = accept(state, 'decline-response'); assert.equal(state.pending.poolCards.length, 5);
  assert.equal(state.lastPublicEvents.some(event => event.type === 'cards-revealed'), true);
  state = accept(state, 'choose-effect', { selection: state.pending.choice.defaultSelection });
  state = JSON.parse(JSON.stringify(state)); assert.equal(state.pending.poolCards.length, 4);
  state = settle(state); assert.equal(state.players[0].hand.length, 3); assert.equal(state.players[1].hand.length, 2);
  assert.equal(state.turnPlayerId, ids[1]); assert.equal(state.turnNumber, 2);
});

test('M03: each player keeps a tool independently with the old exhaustion flag', () => {
  const f = fixture('M03'); const second = f.tool(f.peer, 'T04', false);
  let state = start(f); state = accept(state, 'decline-response');
  state = accept(state, 'choose-effect', { selection: { cardId: state.players[0].tools[0].cardId } });
  state = accept(state, 'choose-effect', { selection: { cardId: second } });
  assert.equal(state.players[0].tools[0].exhausted, true); assert.equal(state.players[1].tools[0].exhausted, false);
});

test('M04: the opponent cannot choose an unaffordable tribute and draws are private', () => {
  const f = fixture('M04'); f.peer.silver = 1;
  let state = start(f); state = accept(state, 'decline-response');
  assert.deepEqual(state.pending.choice.options, [{ branch: 'draw' }]);
  rejected(state, 'choose-effect', { selection: { branch: 'pay' } });
  state = accept(state, 'choose-effect', { selection: { branch: 'draw' } });
  assert.equal(state.players[1].silver, 1); assert.equal(state.players[0].hand.length, 2);
  assert.ok(state.lastPublicEvents.every(event => !event.cardIds));
});

test('M05: paid temporary spaces remain paid across the full public redistribution', () => {
  const f = fixture('M05'); f.stock(f.owner, { firearms: 3 }); f.stock(f.peer, { imports: 4 });
  f.owner.silver = 0; f.peer.silver = 0;
  let state = start(f); state = accept(state, 'decline-response');
  assert.equal(goodsCount(state.pending.goods), 12); assert.equal(state.players[0].temporaryOccupied, false);
  state = settle(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(state.players.map(owner => goodsCount(owner.goods)), [6, 6]);
  assert.deepEqual(state.players.map(owner => owner.silver), [0, 0]);
  assert.ok(state.players.every(owner => owner.temporaryOccupied));
});

test('M06: identical tool copies remain distinct and all received tools stand upright', () => {
  const f = fixture('M06'); f.tool(f.peer, 'T01'); f.tool(f.owner, 'T03');
  const oldIds = f.state.players.flatMap(owner => owner.tools.map(tool => tool.cardId)).sort();
  const state = settle(start(f));
  assert.deepEqual(state.players.map(owner => owner.tools.length), [3, 2]);
  assert.deepEqual(state.players.flatMap(owner => owner.tools.map(tool => tool.cardId)).sort(), oldIds);
  assert.ok(state.players.every(owner => owner.tools.every(tool => !tool.exhausted)));
});

test('M07: one blind draw is fixed before return choice and may be returned after serialization without rerolling', () => {
  const f = fixture('M07'); f.hand(f.peer, 'G02'); const peerBefore = [...f.peer.hand];
  let state = start(f), draws = 0;
  state = accept(state, 'decline-response', {}, undefined, { ...ctx, randomInt: limit => { draws++; return limit - 1; } });
  assert.equal(draws, 1); const taken = state.players[0].hand[0]; assert.equal(taken, peerBefore.at(-1));
  state = JSON.parse(JSON.stringify(state));
  state = accept(state, 'choose-effect', { selection: { cardId: taken } }, undefined,
    { ...ctx, randomInt: () => { throw new Error('must not reroll'); } });
  assert.deepEqual(state.players[1].hand, peerBefore); assert.deepEqual(state.players[0].hand, []);
});

test('M08: T07 is only removed; T08 cannot sacrifice the removed target or outer character', () => {
  for (const toolCode of ['T07', 'T08']) {
    const f = fixture('M08'), old = f.peer.tools.pop().cardId; f.state.deck.push(old);
    const target = f.tool(f.peer, toolCode); f.params.toolCardId = target;
    let state = start(f); state = accept(state, 'decline-response');
    assert.deepEqual(state.pending.choice.options, [{ borrow: false }]);
    rejected(state, 'choose-effect', { selection: { borrow: true } });
    state = accept(state, 'choose-effect', { selection: { borrow: false } });
    assert.deepEqual(state.discard.slice(-2), [target, f.cardId]); assert.equal(state.players[0].silver, 20);
  }
});

test('M08: borrowing T08 pays with an owned card, costs no second action and preserves the outer source', () => {
  const f = fixture('M08'), old = f.peer.tools.pop().cardId; f.state.deck.push(old);
  const target = f.tool(f.peer, 'T08'), payment = f.hand(f.owner, 'G01'); f.params.toolCardId = target;
  let state = start(f); state = accept(state, 'decline-response');
  state = accept(state, 'choose-effect', { selection: { borrow: true } });
  assert.equal(state.pending.kind, 'tool'); assert.deepEqual(state.pending.sourceCards, [f.cardId]);
  rejected(state, 'choose-effect', { selection: { payment: { zone: 'tool', cardId: target } } });
  state = accept(state, 'choose-effect', { selection: { payment: { zone: 'hand', cardId: payment } } });
  assert.equal(state.players[0].silver, 22); assert.equal(state.actionsUsed, 1);
  assert.deepEqual(state.discard.slice(-3), [target, payment, f.cardId]);
});

test('M08 / T04: an already discarded borrowed target may be reshuffled into the saved two-card private pool', () => {
  const f = fixture('M08'), old = f.peer.tools.pop().cardId; f.state.deck.push(old);
  const target = f.tool(f.peer, 'T04'); f.params.toolCardId = target;
  f.peer.hand.push(...f.state.deck.splice(1));
  let state = start(f); state = accept(state, 'decline-response');
  assert.equal(state.deck.length, 1); assert.deepEqual(state.discard, [target]);
  state = accept(state, 'choose-effect', { selection: { borrow: true } });
  assert.ok(state.pending.poolCards.includes(target)); assert.equal(state.discard.includes(target), false);
  state = JSON.parse(JSON.stringify(state));
  state = accept(state, 'choose-effect', { selection: { cardId: target } });
  assert.ok(state.players[0].hand.includes(target)); assert.equal(state.pending, null);
  assert.deepEqual(state.discard, [f.cardId]);
});

for (const toolCode of ['T01', 'T04']) test(`M08 / ${toolCode}: reshuffling may leave the borrowed target in the hidden deck during a choice`, () => {
  const f = fixture('M08'), old = f.peer.tools.pop().cardId; f.state.deck.push(old);
  const target = f.tool(f.peer, toolCode); f.params.toolCardId = target;
  f.state.discard.push(f.take('G01'), f.take('G02')); f.peer.hand.push(...f.state.deck.splice(0));
  let state = start(f); state = accept(state, 'decline-response');
  assert.equal(state.deck.length, 0); assert.equal(state.discard.at(-1), target);
  state = accept(state, 'choose-effect', { selection: { borrow: true } });
  assert.ok(state.deck.includes(target)); assert.equal(state.discard.includes(target), false);
  assert.equal(state.pending.poolCards.includes(target), false);
  state = settle(JSON.parse(JSON.stringify(state)));
  assert.ok(state.deck.includes(target)); assert.equal(state.pending, null);
});

for (const code of ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T08', 'T09', 'T10']) {
  test(`M08 / ${code}: borrowed effect completes through its actual tool choices without installation or a second action`, () => {
    const f = fixture('M08'), old = f.peer.tools.pop().cardId; f.state.deck.push(old);
    const target = f.tool(f.peer, code); f.params.toolCardId = target;
    f.hand(f.owner, 'G01'); f.hand(f.owner, 'G02');
    f.stock(f.owner, { firearms: 1 }); f.stock(f.peer, { imports: 1 });
    let state = start(f); state = accept(state, 'decline-response');
    assert.deepEqual(state.pending.choice.options, [{ borrow: true }, { borrow: false }]);
    state = accept(state, 'choose-effect', { selection: { borrow: true } });
    if (state.pending) {
      assert.equal(state.pending.kind, 'tool'); assert.equal(state.pending.code, code);
      assert.equal(state.pending.data.borrowed, true); assert.deepEqual(state.pending.sourceCards, [f.cardId]);
      state = JSON.parse(JSON.stringify(state));
    }
    state = settle(state);
    assert.equal(state.actionsUsed, 1); assert.equal(state.players[0].tools.length, 0); assert.equal(state.players[1].tools.length, 0);
    assert.ok(state.discard.includes(target)); assert.ok(state.discard.includes(f.cardId));
  });
}

const impossibleTargets = {
  C02(f) { f.peer.hand.push(...f.state.deck.splice(0)); },
  C05(f) { f.state.bankGoods['salt-iron']++; f.owner.goods['salt-iron']--; },
  C06(f) { for (const { id } of GOODS) { f.state.bankGoods[id] += f.owner.goods[id]; f.owner.goods[id] = 0; } },
  C08(f) { for (const code of ['G01', 'G02', 'G03', 'G04', 'G05']) f.hand(f.owner, code); },
  C09(f) { f.owner.silver = 0; f.peer.silver = 0; },
  C10(f) { f.owner.silver = 1; },
  C11(f) { f.state.deck.push(...f.state.discard.splice(0)); },
  C12(f) { f.owner.hand.push(...f.state.deck.splice(2)); },
  C13(f) { f.state.bankGoods.firearms++; f.owner.goods.firearms--; },
  M01(f) { f.params.goodsId = 'imports'; },
  M02(f) { f.state.deck.push(...f.peer.hand.splice(0)); f.state.deck.push(...f.owner.hand.splice(1)); },
  M03(f) { f.state.deck.push(f.owner.tools.pop().cardId); },
  M04(f) { f.peer.silver = 1; f.owner.hand.push(...f.state.deck.splice(0)); },
  M05(f) { for (const owner of f.state.players) for (const { id } of GOODS) { f.state.bankGoods[id] += owner.goods[id]; owner.goods[id] = 0; } },
  M06(f) { for (const owner of f.state.players) f.state.deck.push(...owner.tools.splice(0).map(tool => tool.cardId)); },
  M07(f) { f.state.deck.push(...f.peer.hand.splice(0)); },
  M08(f) { f.params.toolCardId = f.cardId; },
};
for (const [code, makeImpossible] of Object.entries(impossibleTargets)) {
  test(`${code}: missing resources or legal targets reject before paying the action`, () => {
    const f = fixture(code); makeImpossible(f);
    assert.equal(gameProblem(f.state), null); assert.equal(typeof characterProblem(f.state, f.owner.id, f.cardId, f.params), 'string');
    rejected(f.state, 'play-character', { cardId: f.cardId, params: f.params });
  });
}

test('C13: an almost-full integer ledger permits only the safe subset of a multi-good sale', () => {
  const f = fixture('C13'); f.stock(f.owner, { imports: 2 }); f.owner.silver = Number.MAX_SAFE_INTEGER - 3;
  let state = start(f); assert.equal(state.pending.choice.options[0].maximum, 1);
  rejected(state, 'choose-effect', { selection: { goods: goods({ imports: 2 }) } });
  state = accept(state, 'choose-effect', { selection: { goods: goods({ firearms: 1 }) } });
  assert.equal(state.players[0].silver, Number.MAX_SAFE_INTEGER - 1);
});

const initialStep = (kind, selection) => ({ kind, selection });
const initialFixtures = {
  C01: () => [initialStep('benefit-branch', { branch: 'goods' }), initialStep('benefit-good', { goodsId: 'imports' })],
  C05: f => [initialStep('trade-card', { cardId: f.owner.hand.find(id => definition(id).category === 'goods') }),
    initialStep('sell-goods', { goods: goods({ 'salt-iron': 3 }) })],
  C06: () => [initialStep('exchange', { fromGoodsId: 'firearms', toGoodsId: 'imports' })],
  C08: () => [initialStep('hand-branch', { branch: 'draw' })],
  C09: () => [initialStep('auction-goods', { goods: goods({ firearms: 1, imports: 1 }) })],
  C10: () => [initialStep('artisan-good', { goodsId: 'imports' })],
  C11: f => [initialStep('recover-tool', { cardId: `discard:${f.state.revision}:0` })],
  C13: () => [initialStep('sell-stock', { goods: goods({ firearms: 1 }) })],
};
for (const [code, selections] of Object.entries(initialFixtures)) {
  test(`${code}: known owner materials join one atomic activation without saving future choices`, () => {
    const f = fixture(code), before = structuredClone(f.state);
    const initial = accept(f.state, 'play-character', { cardId: f.cardId, params: { initialChoices: selections(f) } });
    assert.equal(initial.revision, before.revision + 1); assert.equal(initial.actionsUsed, 1);
    assert.deepEqual(f.state, before);
    assert.equal(JSON.stringify(initial).includes('initialChoices'), false);
    if (code === 'C05') assert.equal(initial.pending.response.kind, 'merchant');
    if (code === 'C09') assert.equal(initial.pending.stage, 'bidding');
    assert.equal(settle(initial).actionsUsed, 1);
  });
}
test('all eight initial-choice contracts preserve the materials and outcome of the old separate owner choices', () => {
  for (const [code, selections] of Object.entries(initialFixtures)) {
    const f = fixture(code), steps = selections(f);
    const atomic = settle(accept(f.state, 'play-character', { cardId: f.cardId, params: { initialChoices: steps } }));
    let legacy = start(f);
    for (const step of steps) legacy = accept(legacy, 'choose-effect', { selection: code === 'C11' ? { cardId: f.state.discard[0] } : step.selection });
    legacy = settle(legacy);
    for (const field of ['players','deck','discard','bankGoods','bookLayers','actionsUsed','availableStalls','purchasedStalls']) {
      assert.deepEqual(atomic[field], legacy[field], `${code} ${field}`);
    }
  }
});
test('C01: a multiplayer initial choice binds the selected peer and leaves unrelated private hands intact', () => {
  const f = fixture('C01', { playerIds: [...ids,'d'.repeat(32)], ruleVersion: MULTIPLAYER_RULE_VERSION });
  f.hand(f.state.players[2], 'G19');
  const state = accept(f.state, 'play-character', { cardId: f.cardId,
    params: { targetId: f.peer.id, initialChoices: [initialStep('benefit-branch', { branch: 'draw' })] } });
  assert.equal(state.pending.choice.actorId, f.peer.id); assert.deepEqual(state.players[2], f.state.players[2]);
  rejected(f.state, 'play-character', { cardId: f.cardId,
    params: { targetId: f.owner.id, initialChoices: initialFixtures.C01(f) } });
});
test('C01: a preselected draw stops at the opponent goods choice; owner goods requires both known steps', () => {
  const f = fixture('C01');
  const state = accept(f.state, 'play-character', { cardId: f.cardId,
    params: { initialChoices: [initialStep('benefit-branch', { branch: 'draw' })] } });
  assert.equal(state.players[0].hand.length, 2); assert.equal(state.pending.choice.actorId, f.peer.id);
  assert.equal(state.pending.choice.kind, 'benefit-good');
  rejected(f.state, 'play-character', { cardId: f.cardId,
    params: { initialChoices: [initialStep('benefit-branch', { branch: 'goods' })] } });
});
test('C01: the legacy zero-stock goods branch can still grant only the peer draw without a fabricated goods selection', () => {
  const playerIds = ['a','b','c','d','e','f'].map(value => value.repeat(32));
  const initial = createGame(playerIds, { ...ctx, matchId: 'c'.repeat(32), actionLimit: 10, goodsPerType: 6 });
  initial.deck.push(...initial.players.flatMap(owner => owner.hand)); initial.players.forEach(owner => { owner.hand = []; });
  const cardIndex = initial.deck.findIndex(id => definition(id).sourceCode === 'C01'), cardId = initial.deck.splice(cardIndex, 1)[0];
  initial.players[0].hand.push(cardId); initial.stage = 'use'; initial.drawStarted = true;
  for (let index = 0; index < GOODS.length; index++) {
    initial.players[index].goods[GOODS[index].id] = 6; initial.players[index].temporaryOccupied = true;
    initial.players[index].silver = 18; initial.bankGoods[GOODS[index].id] = 0;
  }
  const state = accept(initial, 'play-character', { cardId,
    params: { targetId: playerIds[1], initialChoices: [initialStep('benefit-branch', { branch: 'goods' })] } });
  assert.equal(state.pending, null); assert.equal(state.players[0].hand.length, 0); assert.equal(state.players[1].hand.length, 2);
});
test('C08: the owner chooses discard, but the opponent selects their own private cards after activation', () => {
  const f = fixture('C08'); for (const code of ['G01','G02','G03','G04']) f.hand(f.peer, code);
  const state = accept(f.state, 'play-character', { cardId: f.cardId,
    params: { initialChoices: [initialStep('hand-branch', { branch: 'discard' })] } });
  assert.equal(state.pending.choice.kind, 'discard-hand'); assert.equal(state.pending.choice.actorId, f.peer.id);
  assert.deepEqual(state.players[1].hand, f.peer.hand);
});
test('C10: receipt remains the paid retention obligation, and restored old pending choices still settle once', () => {
  const f = fixture('C10'); f.owner.silver = 2; f.stock(f.owner, { firearms: 5 });
  const state = accept(f.state, 'play-character', { cardId: f.cardId, params: { initialChoices: initialFixtures.C10(f) } });
  assert.equal(state.players[0].silver, 0); assert.equal(state.pending.choice.kind, 'retain-goods');
  const restored = JSON.parse(JSON.stringify(state)), result = settle(restored);
  assert.equal(result.players[0].silver, 0); assert.equal(result.actionsUsed, 1); assert.equal(goodsCount(result.players[0].goods), 5);
});
const invalidInitial = {
  C01: [initialStep('benefit-branch', { branch: 'other' })],
  C05: [initialStep('trade-card', { cardId: 'yousei.g01#01' }), initialStep('sell-goods', { goods: emptyGoods() })],
  C06: [initialStep('exchange', { fromGoodsId: 'firearms', toGoodsId: 'firearms' })],
  C08: [initialStep('hand-branch', { branch: 'other' })],
  C09: [initialStep('auction-goods', { goods: goods({ firearms: 1 }) })],
  C10: [initialStep('artisan-good', { goodsId: 'unknown' })],
  C11: [initialStep('recover-tool', { cardId: 'yousei.c11#01' })],
  C13: [initialStep('sell-stock', { goods: emptyGoods() })],
};
for (const [code, initialChoices] of Object.entries(invalidInitial)) test(`${code}: invalid atomic materials leave the original fees, zones and randomness untouched`, () => {
  const f = fixture(code), before = structuredClone(f.state); let randomCalls = 0;
  const result = action(f.state, 'play-character', { cardId: f.cardId, params: { initialChoices } }, f.owner.id,
    { now: ctx.now, randomInt: limit => { randomCalls++; return limit - 1; } });
  assert.equal(result.ok, false); assert.deepEqual(f.state, before); assert.equal(randomCalls, 0);
});
for (const code of ['C02','C03','C12',...implementedCharacterCodes.filter(code => code.startsWith('M'))]) {
  test(`${code}: secret, response and future choices cannot be injected into activation`, () => {
    const f = fixture(code); rejected(f.state, 'play-character', { cardId: f.cardId,
      params: { ...f.params, initialChoices: [initialStep('take-card', { cardId: f.state.deck[0] })] } });
  });
}
test('initial choice envelope rejects wrong order, incomplete pairs, extra steps and extra selection fields', () => {
  const f = fixture('C05'), valid = initialFixtures.C05(f);
  for (const initialChoices of [null, [], valid.slice(0, 1), [...valid, valid[0]], [...valid].reverse(),
    [{ ...valid[0], extra: true }, valid[1]], [{ ...valid[0], selection: { ...valid[0].selection, extra: true } }, valid[1]]]) {
    rejected(f.state, 'play-character', { cardId: f.cardId, params: { initialChoices } });
  }
});
test('a stale public discard reference rejects the entire activation before fees', () => {
  const f = fixture('C11'); rejected(f.state, 'play-character', { cardId: f.cardId,
    params: { initialChoices: [initialStep('recover-tool', { cardId: 'discard:99:0' })] } });
});

function borrowFixture(code, options) {
  const f = fixture('M08', options), original = f.peer.tools.pop(); f.state.deck.push(original.cardId);
  f.params = { toolCardId: f.tool(f.peer, code), ...(f.state.version === 2 ? { targetId: f.peer.id } : {}) };
  const payment = f.hand(f.owner, 'G01'); f.hand(f.owner, 'G02');
  f.stock(f.owner, { firearms: 1 }); f.stock(f.peer, { imports: 1 });
  const params = { T01: { kind: 'silver' }, T02: { ownGoodId: 'firearms', otherGoodId: 'imports' },
    T03: { cardIds: [payment] }, T04: {}, T05: {}, T06: { goodId: 'firearms' },
    T08: { payment: { zone: 'hand', cardId: payment } }, T09: { goodId: 'imports' },
    T10: { goodId: 'imports', payment: { zone: 'hand', cardId: payment } } }[code];
  const state = accept(start(f), 'decline-response');
  return { f, state, params };
}
for (const code of ['T01','T02','T03','T04','T05','T06','T08','T09','T10']) {
  test(`M08 / ${code}: known borrowed materials settle in one choice without another action`, () => {
    const { f, state, params } = borrowFixture(code), before = structuredClone(state);
    const result = accept(state, 'choose-effect', { selection: { borrow: true, params } });
    assert.equal(result.actionsUsed, 1); assert.equal(result.revision, before.revision + 1); assert.deepEqual(state, before);
    if (code === 'T04') assert.equal(result.pending.choice.kind, 'tool-two-cards');
    else assert.equal(result.pending, null);
    assert.equal(settle(result).actionsUsed, 1); assert.ok(settle(result).discard.includes(f.cardId));
  });
}
test('M08 / T02: borrowed multiplayer target and both goods are one input; old empty params keeps the saved target step', () => {
  const { f, state, params } = borrowFixture('T02', { playerIds: [...ids,'d'.repeat(32)], ruleVersion: MULTIPLAYER_RULE_VERSION });
  // This target is chosen after removal; its public goods are still available.
  const selectedTarget = state.players[2]; state.bankGoods.beasts--; selectedTarget.goods.beasts++;
  const result = accept(state, 'choose-effect', { selection: { borrow: true,
    params: { ...params, targetId: selectedTarget.id, otherGoodId: 'beasts' } } });
  assert.equal(result.pending, null); assert.equal(result.players[0].goods.beasts, 1); assert.equal(result.players[2].goods.firearms, 1);
  assert.equal(result.players[1].goods.imports, 1); assert.equal(result.actionsUsed, 1);
  const legacy = accept(state, 'choose-effect', { selection: { borrow: true, params: {} } });
  assert.equal(legacy.pending.choice.kind, 'borrowed-target'); assert.equal(gameProblem(JSON.parse(JSON.stringify(legacy))), null);
  assert.equal(settle(legacy).actionsUsed, 1); assert.ok(result.discard.includes(f.cardId));
});
test('M08 / T04: selecting the borrowed target cannot preselect the two future private cards', () => {
  const { state } = borrowFixture('T04', { playerIds: [...ids,'d'.repeat(32)], ruleVersion: MULTIPLAYER_RULE_VERSION });
  const result = accept(state, 'choose-effect', { selection: { borrow: true, params: { targetId: state.players[2].id } } });
  assert.equal(result.pending.choice.kind, 'tool-two-cards'); assert.equal(result.pending.data.borrowedTargetId, state.players[2].id);
  rejected(state, 'choose-effect', { selection: { borrow: true, params: { targetId: state.players[2].id, cardId: state.deck[0] } } });
});
test('borrowed invalid, incomplete and opponent payments reject without refunding or advancing the existing character obligation', () => {
  const { state } = borrowFixture('T10');
  for (const params of [{ goodId: 'imports' }, { goodId: 'imports', payment: { zone: 'tool', cardId: state.pending.data.toolCardId } },
    { goodId: 'imports', payment: { zone: 'hand', cardId: state.pending.sourceCards[0] } }, { goodId: 'imports', payment: { zone: 'bank', cardId: state.deck[0] } },
    { goodId: 'imports', payment: { zone: 'hand', cardId: state.players[0].hand[0] }, extra: true }]) {
    rejected(state, 'choose-effect', { selection: { borrow: true, params } });
  }
  assert.equal(state.actionsUsed, 1); assert.equal(state.pending.choice.kind, 'borrow-tool');
  rejected(state, 'choose-effect', { selection: { borrow: false, params: { goodId: 'imports' } } });
  const declined = accept(state, 'choose-effect', { selection: { borrow: false } });
  assert.equal(declined.pending, null); assert.equal(declined.actionsUsed, 1);
});
test('T01: invalid preselected acquisition fees refuse before the ordinary or borrowed search consumes randomness', () => {
  const { f, state } = borrowFixture('T01');
  const ownTool = f.tool(f.owner, 'T01', false), foreignCard = f.hand(f.peer, 'G03');
  f.state.discard.push(...f.state.deck.splice(0));
  const borrowing = structuredClone(state); borrowing.discard.push(...borrowing.deck.splice(0));
  borrowing.players[0].silver = 0;
  const inputs = [{ kind: 'card', cardId: foreignCard }, { kind: 'card', cardId: ownTool }, { kind: 'unknown' }];
  for (const params of inputs) {
    for (const [source, type, body] of [[f.state, 'activate-tool', { cardId: ownTool, params }],
      [borrowing, 'choose-effect', { selection: { borrow: true, params } }]]) {
      const before = structuredClone(source); let calls = 0;
      const result = action(source, type, body, f.owner.id, { now: ctx.now, randomInt: limit => { calls++; return limit - 1; } });
      assert.equal(result.ok, false); assert.equal(calls, 0); assert.deepEqual(source, before);
    }
  }
  const before = structuredClone(borrowing); let calls = 0;
  const noMoney = action(borrowing, 'choose-effect', { selection: { borrow: true, params: { kind: 'silver' } } }, f.owner.id,
    { now: ctx.now, randomInt: limit => { calls++; return limit - 1; } });
  assert.equal(noMoney.ok, false); assert.equal(calls, 0); assert.deepEqual(borrowing, before);
  const legacy = accept(borrowing, 'choose-effect', { selection: { borrow: true, params: {} } });
  assert.equal(legacy.pending.choice.kind, 'tool-search-payment'); assert.equal(legacy.actionsUsed, 1);
});
