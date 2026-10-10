import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, applyTimeout, currentDecision, gameProblem } from './rules.mjs';
import { definition, emptyGoods, goodsCount, refreshTemporary } from './model.mjs';
import { privateView, spectatorView } from './view.mjs';
import { GOODS } from './content/definitions.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32)], ctx = { now: 1000, randomInt: bound => bound - 1 };
function fixture() {
  const state = createGame(ids, { ...ctx, matchId: 'd'.repeat(32), actionLimit: 10, firstPlayerId: ids[0] });
  state.deck.push(...state.players.flatMap(owner => owner.hand)); state.deck.sort();
  state.players.forEach(owner => { owner.hand = []; }); state.stage = 'use'; state.drawStarted = true;
  const f = { state, owner: state.players[0], peer: state.players[1] };
  f.take = code => { const index = state.deck.findIndex(id => definition(id).sourceCode === code); assert.ok(index >= 0); return state.deck.splice(index, 1)[0]; };
  f.hand = (owner, code) => { const id = f.take(code); owner.hand.push(id); return id; };
  f.tool = (owner, code) => { const id = f.take(code); owner.tools.push({ cardId: id, exhausted: false }); return id; };
  f.stock = (owner, vector) => { for (const [id, count] of Object.entries(vector)) { state.bankGoods[id] -= count; owner.goods[id] += count; } refreshTemporary(owner); };
  return f;
}
function valid(state) {
  assert.equal(gameProblem(state), null);
  const cards = [...state.deck, ...state.discard, ...state.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])];
  assert.equal(cards.length, 110); assert.equal(new Set(cards).size, 110);
  for (const { id } of GOODS) assert.equal(state.bankGoods[id] + state.players.reduce((sum, owner) => sum + owner.goods[id], 0) + (state.pending?.goods[id] ?? 0), 6);
}
function command(state, type, fields = {}, context = ctx) {
  const decision = currentDecision(state);
  const result = applyGameAction(state, decision?.actorId ?? state.turnPlayerId, { type, ...fields,
    matchId: state.matchId, turnId: state.turnId,
    ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}) }, context);
  assert.equal(result.ok, true, `${type}: ${result.code ?? ''} ${result.error ?? ''}`); valid(result.state); return result.state;
}
function defaults(initial) {
  let state = initial;
  for (let step = 0; state.pending && step < 120; step++) {
    if (state.pending.response) state = command(state, 'decline-response');
    else if (state.pending.choice) state = command(state, 'choose-effect', { selection: state.pending.choice.defaultSelection });
    else if (state.pending.kind === 'auction') state = command(state, 'pass-bid');
    else assert.fail('unhandled decision');
  }
  assert.equal(state.pending, null); return state;
}
function timeout(state) {
  const clock = state.timing.decision ?? state.timing.active;
  const result = applyTimeout(state, clock.actorId, { ...ctx, now: clock.deadlineAt });
  assert.equal(result.ok, true, `${result.code ?? ''} ${result.error ?? ''}`); valid(result.state); return result.state;
}

for (let number = 1; number <= 10; number++) {
  const code = `T${String(number).padStart(2, '0')}`;
  test(`${code}: real activation, choices, privacy, clock and exhausted rejection pass the full engine validator`, () => {
    const f = fixture(); f.hand(f.owner, 'G01'); f.hand(f.owner, 'G02');
    f.stock(f.owner, { firearms: 1 }); f.stock(f.peer, { imports: 1 });
    let state, cardId, expectedActions;
    if (code === 'T07') {
      cardId = f.tool(f.owner, code); f.state.discard.push(f.take('G03'));
      f.state.stage = 'draw'; f.state.drawStarted = false; state = f.state; expectedActions = 1;
    } else {
      cardId = f.hand(f.owner, code); state = command(f.state, 'install-tool', { cardId }); expectedActions = 2;
    }
    const deadline = state.timing.active.deadlineAt;
    state = command(state, 'activate-tool', { cardId });
    assert.equal(state.actionsUsed, expectedActions); assert.equal(state.timing.decision, null);
    assert.equal(state.timing.active.deadlineAt, deadline);
    if (state.pending) {
      const restored = JSON.parse(JSON.stringify(state)); valid(restored);
      assert.deepEqual(currentDecision(restored), currentDecision(state)); state = restored;
      if (code === 'T04') {
        assert.equal(privateView(state, ids[0]).pending.privatePool.length, 2);
        for (const view of [privateView(state, ids[1]), spectatorView(state)]) {
          assert.equal(view.pending.privatePool, undefined); assert.equal(view.pending.choice.options, undefined);
          for (const id of state.pending.poolCards) assert.equal(JSON.stringify(view).includes(id), false);
        }
      }
      state = defaults(state);
    }
    assert.equal(state.players[0].tools.find(tool => tool.cardId === cardId).exhausted, true);
    assert.equal(state.actionsUsed, expectedActions); assert.equal(state.timing.active.deadlineAt, deadline);
    if (code === 'T07') { assert.equal(state.stage, 'draw'); assert.equal(state.drawStarted, false); }
    const before = structuredClone(state), result = applyGameAction(state, ids[0], { type: 'activate-tool', cardId,
      matchId: state.matchId, turnId: state.turnId }, ctx);
    assert.equal(result.ok, false); assert.deepEqual(state, before);
  });
}

test('M02: alternating timeout decisions preserve the pool and finish after both clocks have expired once', () => {
  const f = fixture(), character = f.hand(f.owner, 'M02');
  for (const code of ['G01', 'G02']) f.hand(f.owner, code);
  for (const code of ['G03', 'G04', 'G05']) f.hand(f.peer, code);
  let state = command(f.state, 'play-character', { cardId: character });
  assert.equal(state.timing.decision.actorId, ids[1]);
  state = timeout(state); // Counter defaults to decline; owner selects from the fixed pool.
  assert.equal(state.pending.poolCards.length, 5); assert.equal(state.timing.decision, null);
  state = timeout(state); // Owner's main clock expires; opponent receives their own 60 seconds.
  assert.equal(state.timing.active.remainingMs, 0); assert.equal(state.timing.decision.actorId, ids[1]);
  let steps = 0;
  while (state.turnPlayerId === ids[0]) { assert.ok(++steps < 8); state = timeout(JSON.parse(JSON.stringify(state))); }
  assert.deepEqual(state.players.map(owner => owner.hand.length), [3, 2]);
  assert.deepEqual(state.players.map(owner => owner.silver), [20, 20]); assert.equal(state.pending, null);
  assert.equal(state.turnNumber, 2);
});

test('C10: active timeout completes the paid goods choice and retention without paying twice or rewarding the turn', () => {
  const f = fixture(), cardId = f.hand(f.owner, 'C10'); f.owner.silver = 2; f.stock(f.owner, { firearms: 5 });
  let state = command(f.state, 'play-character', { cardId });
  assert.equal(state.players[0].silver, 0); state = timeout(JSON.parse(JSON.stringify(state)));
  assert.equal(state.pending, null); assert.equal(state.turnPlayerId, ids[1]); assert.equal(state.players[0].silver, 0);
  assert.equal(goodsCount(state.players[0].goods), 5); assert.equal(state.players[0].temporaryOccupied, false);
});

test('M08 / T08: active timeout accepts legal borrowing and pays its saved owner-card choice exactly once', () => {
  const f = fixture(), cardId = f.hand(f.owner, 'M08'), payment = f.hand(f.owner, 'G01'), target = f.tool(f.peer, 'T08');
  let state = command(f.state, 'play-character', { cardId, params: { toolCardId: target } });
  state = command(state, 'decline-response'); state = timeout(state);
  assert.equal(state.pending, null); assert.equal(state.turnPlayerId, ids[1]); assert.equal(state.players[0].silver, 22);
  assert.deepEqual(state.discard.slice(-3), [target, payment, cardId]);
});

test('C01: an active timeout still grants the opponent their own timed goods choice and ends with no bonus', () => {
  const f = fixture(), cardId = f.hand(f.owner, 'C01');
  let state = command(f.state, 'play-character', { cardId }); state = timeout(state);
  assert.equal(state.players[0].hand.length, 2); assert.equal(state.timing.active.remainingMs, 0);
  assert.equal(state.pending.choice.actorId, ids[1]); assert.equal(state.timing.decision.remainingMs, 60000);
  state = timeout(state); assert.equal(state.pending, null); assert.equal(state.turnPlayerId, ids[1]);
  assert.equal(goodsCount(state.players[1].goods), 2); assert.deepEqual(state.players.map(owner => owner.silver), [20, 20]);
});

test('C09: active-timeout pass followed by opponent-timeout pass returns the fixed lot and ends once', () => {
  const f = fixture(), cardId = f.hand(f.owner, 'C09');
  let state = command(f.state, 'play-character', { cardId });
  state = command(state, 'choose-effect', { selection: { goods: { ...emptyGoods(), firearms: 1, imports: 1 } } });
  state = timeout(state); assert.equal(state.pending.data.auction.currentBidderId, ids[1]);
  state = timeout(state); assert.equal(state.pending, null); assert.equal(state.turnNumber, 2);
  assert.equal(state.bankGoods.firearms, 6); assert.equal(state.bankGoods.imports, 6);
  assert.deepEqual(state.players.map(owner => owner.silver), [20, 20]);
});
