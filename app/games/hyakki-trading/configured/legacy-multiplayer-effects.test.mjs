// Adapted old-card scenarios on the expansion material; original frozen tests are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, currentDecision, gameProblem } from './test-support/legacy-rules.mjs';
import { CONTENT_VERSION, PLAYER_COUNT_CONTENT_VERSION, createDeck, GOODS } from './material.mjs';
import { definition, emptyGoods, refreshTemporary } from './model.mjs';
import { characterProblem } from './effects.mjs';
import { toolProblem } from './tools.mjs';
import { privateView, spectatorView } from './view.mjs';

const ids = Array.from({ length: 6 }, (_, index) => (index + 1).toString(16).padStart(32, '0'));
const targetIndex = 4, ctx = { now: 1000, randomInt: limit => limit - 1 };
const others = [1, 2, 3, 5];
function fixture(code, contentVersion = CONTENT_VERSION) {
  // Old multiplayer effects must remain playable with their frozen 110 cards.
  const state = createGame(ids, { ...ctx, contentVersion, matchId: 'c'.repeat(32), actionLimit: 10, goodsPerType: 20, firstPlayerId: ids[0] });
  state.deck.push(...state.players.flatMap(owner => owner.hand)); state.deck.sort();
  state.players.forEach(owner => { owner.hand = []; }); state.stage = 'use'; state.drawStarted = true;state.turnUsage.firstPeekOffered=true;
  const f = { state, owner: state.players[0], target: state.players[targetIndex], params: { targetId: ids[targetIndex] } };
  f.take = code => {
    const index = state.deck.findIndex(id => definition(id).sourceCode === code); assert(index >= 0, `missing ${code}`);
    return state.deck.splice(index, 1)[0];
  };
  f.hand = (owner, code) => { const id = f.take(code); owner.hand.push(id); return id; };
  f.tool = (owner, code, exhausted = true) => { const cardId = f.take(code); owner.tools.push({ cardId, exhausted }); return cardId; };
  f.stock = (owner, entries) => {
    for (const [id, count] of Object.entries(entries)) { state.bankGoods[id] -= count; owner.goods[id] += count; }
    refreshTemporary(owner);
  };
  f.cardId = f.hand(f.owner, code);
  switch (code) {
    case 'C08': for (const c of ['G01', 'G02', 'G03', 'G04', 'G05']) f.hand(f.target, c); break;
    case 'M01': f.stock(f.target, { firearms: 1 }); f.params.goodsId = 'firearms'; break;
    case 'M02': f.hand(f.owner, 'G01'); f.hand(f.target, 'G02'); break;
    case 'M03': f.tool(f.owner, 'T01'); f.tool(f.owner, 'T02'); f.tool(f.target, 'T05'); break;
    case 'M05': f.stock(f.owner, { firearms: 3 }); f.stock(f.target, { imports: 3 }); break;
    case 'M06': f.tool(f.owner, 'T01'); f.tool(f.target, 'T02'); break;
    case 'M07': f.hand(f.target, 'G01'); break;
    case 'M08': f.params.toolCardId = f.tool(f.target, 'T05'); break;
  }
  for (const index of others) {
    const owner = state.players[index]; owner.hand.push(state.deck.shift()); f.stock(owner, { curios: 1 });
    const tool = state.deck.findIndex(id => definition(id).category === 'tool' && !['T01', 'T02', 'T04', 'T05'].includes(definition(id).sourceCode));
    owner.tools.push({ cardId: state.deck.splice(tool, 1)[0], exhausted: true });
  }
  return f;
}
function accept(state, type, fields = {}, actorId = currentDecision(state)?.actorId ?? state.turnPlayerId) {
  const decision = currentDecision(state), result = applyGameAction(state, actorId, { type, matchId: state.matchId, turnId: state.turnId,
    ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}), ...fields }, ctx);
  assert.equal(result.ok, true, `${type}: ${result.code} ${result.error}`); assert.equal(gameProblem(result.state), null);
  conserved(result.state); return result.state;
}
function conserved(state) {
  const cards = [...state.deck, ...state.discard, ...state.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])];
  assert.deepEqual([...cards].sort(), createDeck({ contentVersion: state.contentVersion, playerCount: 6 }).map(card => card.id).sort());
  assert.equal(new Set(cards).size, 180+45*(state.players.length-2));
  for (const good of GOODS) assert.equal(state.bankGoods[good.id] + state.players.reduce((sum, owner) => sum + owner.goods[good.id], 0)
    + (state.pending?.goods[good.id] ?? 0), 20);
}
const unaffected = state => others.map(index => structuredClone(state.players[index]));
function start(f) { return accept(f.state, 'play-character', { cardId: f.cardId, params: f.params }); }
function settle(state) {
  let count = 0;
  while (state.pending) {
    assert(++count <= 220);
    if (state.pending.response) state = accept(state, 'decline-response');
    else state = accept(state, 'choose-effect', { selection: state.pending.choice.defaultSelection });
  }
  return state;
}

for (const contentVersion of [CONTENT_VERSION, PLAYER_COUNT_CONTENT_VERSION]) for (const code of ['C01', 'C08', 'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08']) {
  test(`${contentVersion} ${code}: six-player effect changes only the selected pair and conserves all material`, () => {
    const f = fixture(code, contentVersion), before = unaffected(f.state);
    assert.equal(characterProblem(f.state, ids[0], f.cardId, f.params), null);
    const state = settle(start(f)); assert.deepEqual(unaffected(state), before); assert.equal(state.actionsUsed, 1);
  });
  test(`${contentVersion} ${code}: three-plus player activation requires a valid other participant before charging`, () => {
    const f = fixture(code, contentVersion);
    for (const targetId of [undefined, ids[0], 'f'.repeat(32)]) {
      const params = { ...f.params }; if (targetId === undefined) delete params.targetId; else params.targetId = targetId;
      assert.notEqual(characterProblem(f.state, ids[0], f.cardId, params), null);
      const before = structuredClone(f.state), result = applyGameAction(f.state, ids[0], {
        type: 'play-character', cardId: f.cardId, params, matchId: f.state.matchId, turnId: f.state.turnId }, ctx);
      assert.equal(result.ok, false); assert.deepEqual(f.state, before);
    }
  });
}

test('C08 discard branch is chosen by the selected target and leaves all other private hands unchanged', () => {
  const f = fixture('C08'), before = unaffected(f.state);
  let state = start(f); state = accept(state, 'choose-effect', { selection: { branch: 'discard' } });
  assert.equal(currentDecision(state).actorId, ids[targetIndex]);
  state = settle(state); assert.equal(state.players[targetIndex].hand.length, 3); assert.deepEqual(unaffected(state), before);
});

test('M03 cannot activate just because an unrelated seat has multiple tools', () => {
  const f = fixture('M03');
  f.owner.hand.push(...f.owner.tools.splice(0).map(tool => tool.cardId));
  const unrelated = f.state.players[1], extra = f.take('T04'); unrelated.tools.push({ cardId: extra, exhausted: false });
  assert.notEqual(characterProblem(f.state, ids[0], f.cardId, f.params), null); conserved(f.state);
});

test('M05 pair distribution preserves paid temporary occupancy and leaves third-party stock out of its pool', () => {
  const f = fixture('M05'); f.stock(f.owner, { firearms: 3 }); f.owner.silver = 0;
  const before = unaffected(f.state);
  let state = start(f); if (state.pending?.response) state = accept(state, 'decline-response');
  assert.deepEqual(Object.keys(state.pending.data.tempPaid).sort(), [ids[0], ids[targetIndex]].sort());
  assert.equal(Object.values(state.pending.goods).reduce((sum, n) => sum + n, 0), 9);
  state = settle(state); assert.equal(state.players[0].silver, 0); assert.deepEqual(unaffected(state), before);
});

test('M08 can dismantle one participant tool then borrow T04 with a different recipient and private candidates', () => {
  const f = fixture('M08');
  const original = f.params.toolCardId;
  f.target.tools = []; f.state.deck.push(original); f.params.toolCardId = f.tool(f.target, 'T04');
  const before = structuredClone(f.state.players[1]);
  let state = start(f); if (state.pending?.response) state = accept(state, 'decline-response');
  assert.equal(state.pending.data.targetId, ids[targetIndex]);
  state = accept(state, 'choose-effect', { selection: { borrow: true } });
  assert.equal(state.pending.choice.kind, 'borrowed-target'); assert.equal(state.pending.choice.visibility, 'public');
  assert(state.pending.choice.options.some(option => option.targetId === ids[1]));
  assert(!state.pending.choice.options.some(option => option.targetId === ids[0]));
  state = accept(state, 'choose-effect', { selection: { targetId: ids[1] } });
  assert.equal(state.pending.data.targetId, ids[targetIndex]); assert.equal(state.pending.data.borrowedTargetId, ids[1]);
  const cards = [...state.pending.poolCards]; assert.equal(cards.length, 2);
  assert.equal(privateView(state, ids[0]).pending.privatePool.length, 2);
  assert.equal(privateView(state, ids[1]).pending.privatePool, undefined); assert.equal(spectatorView(state).pending.privatePool, undefined);
  const selected = state.pending.choice.defaultSelection.cardId;
  state = accept(state, 'choose-effect', { selection: { cardId: selected } });
  assert(state.players[0].hand.includes(selected)); assert(state.players[1].hand.includes(cards.find(id => id !== selected)));
  assert.equal(state.players[1].hand.length, before.hand.length + 1); assert.equal(state.actionsUsed, 1);
  assert(state.discard.includes(f.params.toolCardId)); assert(state.discard.includes(f.cardId));
});

for (const code of ['T02', 'T04']) test(`${code}: target-only parameters open a material choice instead of submitting an empty selection`, () => {
  const f = fixture('M01'); f.owner.hand.push(f.state.deck.pop());
  const cardId = f.tool(f.owner, code, false); f.stock(f.owner, { imports: 1 });
  assert.equal(toolProblem(f.state, ids[0], cardId, { targetId: ids[targetIndex] }), null);
  const before = unaffected(f.state);
  let state = accept(f.state, 'activate-tool', { cardId, params: { targetId: ids[targetIndex] } });
  assert.equal(state.pending.data.targetId, ids[targetIndex]); assert.equal(state.pending.kind, 'tool');
  state = settle(state); assert.deepEqual(unaffected(state), before);
});

for (const contentVersion of [CONTENT_VERSION, PLAYER_COUNT_CONTENT_VERSION]) for (const code of ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08']) {
  test(`${contentVersion} ${code}: only the selected target may counter before any random draw or material transfer`, () => {
    const f = fixture(code, contentVersion), counter = f.hand(f.target, 'C07'), before = structuredClone(f.state);
    let state = start(f); assert.equal(currentDecision(state).actorId, ids[targetIndex]);
    assert.deepEqual(state.deck, before.deck); assert.deepEqual(state.discard, before.discard);
    assert.deepEqual(state.players[targetIndex], before.players[targetIndex]); assert.deepEqual(unaffected(state), unaffected(before));
    assert.deepEqual(state.pending.poolCards, []); assert.deepEqual(state.pending.goods, emptyGoods());
    const decision = currentDecision(state), wrong = applyGameAction(state, ids[1], { type: 'decline-response',
      matchId: state.matchId, turnId: state.turnId, effectId: state.pending.id, decisionId: decision.id }, ctx);
    assert.equal(wrong.ok, false);
    state = accept(state, 'respond', { cardId: counter }); assert.equal(state.pending, null); assert.equal(state.actionsUsed, 1);
    assert.deepEqual(state.discard.slice(-2), [f.cardId, counter]); assert.deepEqual(unaffected(state), unaffected(before));
  });
}

test('M08 borrowed T02 exchanges goods with a third participant without transferring the original target stock', () => {
  const f = fixture('M08'), original = f.params.toolCardId;
  f.target.tools = []; f.state.deck.push(original); f.params.toolCardId = f.tool(f.target, 'T02');
  f.stock(f.owner, { imports: 1 }); f.stock(f.target, { firearms: 1 });
  let state = start(f); if (state.pending?.response) state = accept(state, 'decline-response');
  state = accept(state, 'choose-effect', { selection: { borrow: true } });
  state = accept(state, 'choose-effect', { selection: { targetId: ids[1] } });
  assert.equal(state.pending.data.targetId, ids[targetIndex]); assert.equal(state.pending.data.borrowedTargetId, ids[1]);
  state = accept(state, 'choose-effect', { selection: { ownGoodId: 'imports', otherGoodId: 'curios' } });
  assert.equal(state.players[0].goods.curios, 1); assert.equal(state.players[1].goods.imports, 1);
  assert.equal(state.players[targetIndex].goods.firearms, 1); assert.equal(state.actionsUsed, 1);
});

test('borrowed T04 can be reshuffled into its own saved candidate pool and then retained exactly once', () => {
  const f = fixture('M08'), original = f.params.toolCardId;
  f.target.tools = []; f.state.deck.push(original); f.params.toolCardId = f.tool(f.target, 'T04');
  f.state.players[2].hand.push(...f.state.deck.splice(0)); f.state.discard.push(f.state.players[2].hand.pop());
  let state = start(f); if (state.pending?.response) state = accept(state, 'decline-response');
  state = accept(state, 'choose-effect', { selection: { borrow: true } });
  state = accept(state, 'choose-effect', { selection: { targetId: ids[1] } });
  assert(state.pending.poolCards.includes(f.params.toolCardId)); assert.equal(state.deck.length, 0); assert.equal(state.discard.length, 0);
  const recovered = structuredClone(state); assert.equal(gameProblem(recovered), null);
  state = accept(recovered, 'choose-effect', { selection: { cardId: f.params.toolCardId } });
  assert(state.players[0].hand.includes(f.params.toolCardId)); assert.equal(state.discard.at(-1), f.cardId); assert.equal(state.actionsUsed, 1);
});

test('C05 goods subtrade skips seats without a merchant and transfers only the goods source card', () => {
  const f = fixture('C05'); f.params = {}; const tradeCardId = f.hand(f.owner, 'G01'); f.stock(f.owner, { firearms: 3 });
  const merchant = f.hand(f.state.players[3], 'C04');
  let state = start(f); state = accept(state, 'choose-effect', { selection: { cardId: tradeCardId } });
  state = accept(state, 'choose-effect', { selection: { goods: { ...emptyGoods(), firearms: 3 } } });
  assert.equal(state.players[0].silver, 30); assert.equal(state.pending.response.actorId, ids[3]);
  assert.deepEqual(state.pending.response.remainingIds, ids.slice(3));
  assert.equal(state.pending.response.actorId, ids[3]); state = accept(state, 'respond', { cardId: merchant });
  assert(state.players[3].hand.includes(tradeCardId)); assert(state.discard.includes(f.cardId)); assert(state.discard.includes(merchant));
  assert.equal(state.players[0].silver, 30); assert.equal(state.players[0].goods.firearms, 0); assert.equal(state.actionsUsed, 1);
});
