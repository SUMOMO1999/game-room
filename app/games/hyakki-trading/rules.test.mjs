import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, applyTimeout, currentDecision, gameProblem } from './rules.mjs';
import { definition, emptyGoods } from './model.mjs';
import { TURN_MS, RESPONSE_MS } from './lifecycle.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32)], ctx = { now: 1000, randomInt: n => n - 1 };
const copy = (code, index = 1) => `yousei.${code.toLowerCase()}#${String(index).padStart(2, '0')}`;
const fresh = options => createGame(ids, { ...ctx, matchId: 'c'.repeat(32), ...options });
function command(state, type, fields = {}, actor = currentDecision(state)?.actorId ?? state.turnPlayerId, context = ctx) {
  const decision = currentDecision(state);
  return applyGameAction(state, actor, { type, matchId: state.matchId, turnId: state.turnId,
    ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}), ...fields }, context);
}
function accept(state, type, fields, actor, context) {
  const result = command(state, type, fields, actor, context);
  assert.equal(result.ok, true, `${type}: ${result.code} ${result.error}`); assert.equal(gameProblem(result.state), null); return result.state;
}
function arrangeHands(state, hands) {
  const all = [...state.deck, ...state.players.flatMap(owner => owner.hand)];
  state.players.forEach((owner, index) => { owner.hand = hands[index]; });
  const taken = new Set(hands.flat()); state.deck = all.filter(id => !taken.has(id)); return state;
}
function defaultStep(state) {
  if (state.pending.response) return accept(state, 'decline-response');
  if (state.pending.choice) return accept(state, 'choose-effect', { selection: state.pending.choice.defaultSelection });
  if (state.pending.kind === 'auction') return accept(state, 'pass-bid');
  throw new Error('unknown pending fixture');
}
function settle(state) { for (let i = 0; state.pending && i < 120; i++) state = defaultStep(state); assert.equal(state.pending, null); return state; }

test('draws are sequential: three discarded, fourth kept costs four, then no more peeking', () => {
  let state = fresh(); const initial = state.players[0].hand.length;
  for (let i = 0; i < 3; i++) { state = accept(state, 'peek'); assert.equal(command(state, 'peek').ok, false); state = accept(state, 'discard-peek'); }
  state = accept(state, 'peek'); state = accept(state, 'keep-peek');
  assert.equal(state.actionsUsed, 4); assert.equal(state.stage, 'use'); assert.equal(state.players[0].hand.length, initial + 1);
  assert.equal(command(state, 'peek').ok, false);
});
test('limits one and ten are enforced, and exhausted draw waits for keep/discard before switching', () => {
  for (const actionLimit of [1, 10]) {
    let state = fresh({ actionLimit });
    for (let i = 0; i < actionLimit; i++) { state = accept(state, 'peek'); assert.equal(state.turnNumber, 1); state = accept(state, 'discard-peek'); }
    assert.equal(state.turnNumber, 2); assert.equal(state.players[0].silver, 20); assert.equal(state.actionsUsed, 0);
  }
});
test('illegal transaction leaves all zones unchanged; sixth slot charged once and released on sale', () => {
  let state = arrangeHands(fresh(), [[copy('g19', 1), copy('g19', 2)], []]); state = accept(state, 'finish-draw');
  const invalid = structuredClone(state); invalid.players[0].silver = 11;
  const before = structuredClone(invalid); assert.equal(command(invalid, 'buy', { cardId: copy('g19') }).ok, false); assert.deepEqual(invalid, before);
  state = accept(state, 'buy', { cardId: copy('g19') }); assert.equal(state.players[0].silver, 8);
  assert.equal(state.players[0].temporaryOccupied, true); state = settle(state);
  state = settle(accept(state, 'sell', { cardId: copy('g19', 2) }));
  assert.equal(state.players[0].silver, 26); assert.equal(state.players[0].temporaryOccupied, false);
  assert.deepEqual(state.players[0].goods, emptyGoods());
});
test('global stall price is six then three, with five finite permits/boards', () => {
  let state = arrangeHands(fresh({ actionLimit: 10 }), [Array.from({ length: 5 }, (_, i) => copy('stall-permit', i + 1)), []]);
  state = accept(state, 'finish-draw');
  for (let i = 1; i <= 5; i++) state = accept(state, 'buy-stall', { cardId: copy('stall-permit', i) });
  assert.equal(state.players[0].silver, 2); assert.equal(state.availableStalls, 0); assert.equal(state.players[0].stallCount, 5);
});
test('last-step trade stays pending through merchant response; response freezes and resumes actual time', () => {
  let state = arrangeHands(fresh({ actionLimit: 1 }), [[copy('g01')], [copy('c04')]]);
  state = accept(state, 'finish-draw', {}, undefined, { ...ctx, now: 1100 });
  state = accept(state, 'buy', { cardId: copy('g01') }, undefined, { ...ctx, now: 1500 });
  assert.equal(state.turnNumber, 1); assert.equal(state.timing.active.remainingMs, TURN_MS - 500);
  assert.equal(state.timing.active.deadlineAt, null); assert.equal(state.timing.decision.deadlineAt, 1500 + RESPONSE_MS);
  state = accept(state, 'respond', { cardId: copy('c04') }, undefined, { ...ctx, now: 2000 });
  assert.equal(state.turnNumber, 2); assert.ok(state.players[1].hand.includes(copy('g01'))); assert.equal(state.players[0].silver, 17);
});
test('turn timeout keeps an already peeked card and awards no idle silver', () => {
  let state = accept(fresh(), 'peek'); const candidate = state.pending.poolCards[0], until = state.timing.active.deadlineAt;
  const result = applyTimeout(state, ids[0], { ...ctx, now: until });
  assert.equal(result.ok, true, result.error); state = result.state;
  assert.ok(state.players[0].hand.includes(candidate)); assert.equal(state.turnNumber, 2); assert.equal(state.players[0].silver, 20);
  assert.equal(gameProblem(state), null); assert.equal(applyTimeout(state, ids[0], { ...ctx, now: until }).ok, false);
});
test('opponent timeout declines once and resumes remaining active time instead of restarting thirty minutes', () => {
  let state = arrangeHands(fresh(), [[copy('g01')], []]); state = accept(state, 'finish-draw');
  state = accept(state, 'buy', { cardId: copy('g01') }, undefined, { ...ctx, now: 5000 });
  const due = state.timing.decision.deadlineAt, remaining = state.timing.active.remainingMs;
  const result = applyTimeout(state, ids[1], { ...ctx, now: due }); assert.equal(result.ok, true, result.error); state = result.state;
  assert.equal(state.pending, null); assert.equal(state.turnNumber, 1); assert.equal(state.timing.active.deadlineAt, due + remaining);
  assert.equal(state.players[0].silver, 17);
});
test('stale match, turn, decision and spectator commands cannot mutate material', () => {
  const state = accept(fresh(), 'peek'), before = structuredClone(state), decision = currentDecision(state);
  for (const changes of [{ matchId: 'd'.repeat(32) }, { turnId: 'turn-2' }, { effectId: 'old' }, { decisionId: 'old' }]) {
    assert.equal(applyGameAction(state, ids[0], { type: 'keep-peek', matchId: state.matchId, turnId: state.turnId,
      effectId: state.pending.id, decisionId: decision.id, ...changes }, ctx).ok, false);
  }
  assert.equal(command(state, 'keep-peek', {}, 'f'.repeat(32)).ok, false); assert.deepEqual(state, before);
});
test('sixty silver is checked at turn end; first player grants one final turn, ties favour final actor', () => {
  let state = fresh(); state.players.forEach(owner => { owner.silver = 59; });
  state = accept(state, 'end-turn'); assert.equal(state.status, 'playing'); assert.equal(state.closing.finalPlayerId, ids[1]);
  state = accept(state, 'end-turn'); assert.equal(state.status, 'finished'); assert.deepEqual(state.result.winnerIds, [ids[1]]);
  assert.deepEqual(state.result.wealth.map(owner => owner.silver), [60, 60]);
  let second = fresh(); second = accept(second, 'end-turn'); second.players[1].silver = 59;
  second = accept(second, 'end-turn'); assert.equal(second.status, 'finished'); assert.deepEqual(second.result.winnerIds, [ids[1]]);
});

test('crossing sixty during a card effect and spending back below it does not trigger premature closing', () => {
  let state = arrangeHands(fresh(), [[copy('c13'), copy('g01')], []]);
  state.players[0].silver = 58; state.players[0].goods.firearms = 1; state.bankGoods.firearms--;
  state = accept(state, 'finish-draw'); state = settle(accept(state, 'play-character', { cardId: copy('c13') }));
  assert.equal(state.players[0].silver, 60); assert.equal(state.status, 'playing'); assert.equal(state.closing, null);
  state = settle(accept(state, 'buy', { cardId: copy('g01') })); state = accept(state, 'end-turn');
  assert.equal(state.players[0].silver, 58); assert.equal(state.status, 'playing'); assert.equal(state.closing, null);
});

test('the documented sixteen-turn ledger runs through the real engine to 64:59 with all material conserved', () => {
  let state = arrangeHands(fresh({ goodsPerType: 6 }), [[copy('t05'), copy('stall-permit'), copy('g03'), copy('g03', 2), copy('g04')],
    [copy('g19', 3), copy('g19', 4), copy('g01'), copy('g01', 2), copy('stall-permit', 2)]]);
  const order = [copy('m08'), copy('g04', 2), copy('g09'), copy('g09', 2), copy('g02'), copy('g17'), copy('g02', 2),
    copy('g17', 2), copy('g05'), copy('g18'), copy('g18', 2), copy('g05', 2), copy('g06'), copy('g06', 2), copy('g07'), copy('g19'), copy('g19', 2), copy('g07', 2)];
  state.deck = [...order, ...state.deck.filter(id => !order.includes(id)).sort()]; assert.equal(gameProblem(state), null);
  let accepted = 0;
  const go = (type, fields) => { state = accept(state, type, fields); accepted++;
    while (state.pending && state.pending.kind !== 'peek') { state = defaultStep(state); accepted++; } };
  const keep = () => { go('peek'); go('keep-peek'); };
  const trade = (buy, code, index = 1) => go(buy ? 'buy' : 'sell', { cardId: copy(code, index) });
  const tool = () => go('activate-tool', { cardId: copy('t05') });
  const balances = [[19,20],[19,27],[21,27],[21,32],[29,32],[29,29],[37,29],[37,41],[45,41],[45,38],[51,38],[51,50],[57,50],[57,46],[64,46],[64,59]];
  const turns = [
    () => { go('peek'); go('discard-peek'); keep(); go('install-tool', { cardId: copy('t05') }); tool(); },
    () => { go('finish-draw'); trade(true,'g19',3); trade(false,'g19',4); },
    () => { go('finish-draw'); go('buy-stall',{cardId:copy('stall-permit')}); trade(true,'g03'); trade(false,'g03',2); },
    () => { go('finish-draw'); go('buy-stall',{cardId:copy('stall-permit',2)}); trade(true,'g01'); trade(false,'g01',2); },
    () => { keep(); trade(true,'g04'); trade(false,'g04',2); },
    () => { keep(); trade(true,'g02'); },
    () => { keep(); trade(true,'g09'); trade(false,'g09',2); },
    () => { keep(); trade(false,'g02',2); },
    () => { keep(); trade(true,'g17'); trade(false,'g17',2); },
    () => { keep(); trade(true,'g05'); },
    () => { keep(); tool(); trade(true,'g18'); trade(false,'g18',2); },
    () => { keep(); trade(false,'g05',2); },
    () => { keep(); tool(); trade(true,'g06'); trade(false,'g06',2); },
    () => { keep(); trade(true,'g07'); },
    () => { keep(); tool(); trade(true,'g19'); trade(false,'g19',2); },
    () => { keep(); trade(false,'g07',2); },
  ];
  turns.forEach((turn,index) => { turn(); go('end-turn'); assert.deepEqual(state.players.map(owner=>owner.silver),balances[index]); });
  assert.equal(state.status,'finished'); assert.deepEqual(state.result.winnerIds,[ids[0]]);
  assert.equal(state.deck.length,82); assert.equal(state.discard.length,27); assert.equal(state.players[0].tools.length,1);
  assert.equal(state.players.flatMap(owner=>owner.hand).length,0); assert.equal(state.availableStalls,3);
  assert.deepEqual(Object.values(state.bankGoods),[6,6,6,6,6,6]); assert.equal(accepted,102);
});
