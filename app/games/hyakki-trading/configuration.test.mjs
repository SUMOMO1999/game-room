import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, currentDecision, gameProblem } from './rules.mjs';
import { emptyGoods } from './model.mjs';
import { privateView, spectatorView } from './view.mjs';
import { createHyakkiAdapter } from '../../../server/games/hyakki-trading/adapter.mjs';
import { validateHyakkiPublicEvent } from '../../../server/games/hyakki-trading/event-store.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32)], ctx = { now: 1000, randomInt: limit => limit - 1 };
const fresh = options => createGame(ids, { ...ctx, matchId: 'c'.repeat(32), ...options });
function command(state, type, fields = {}) {
  const decision = currentDecision(state);
  const result = applyGameAction(state, decision?.actorId ?? state.turnPlayerId, { type, ...fields,
    matchId: state.matchId, turnId: state.turnId,
    ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}) }, ctx);
  assert.equal(result.ok, true, result.error); return result.state;
}

test('new games freeze five actions and eight goods by default, with independently bounded options', () => {
  const initial = fresh(); assert.equal(initial.actionLimit, 5); assert.equal(initial.goodsPerType, 8);
  for (const goodsPerType of [4, 6, 8, 20]) for (const actionLimit of [1, 5, 10]) {
    const state = fresh({ actionLimit, goodsPerType });
    assert.equal(gameProblem(state), null); assert.deepEqual(Object.values(state.bankGoods), Array(6).fill(goodsPerType));
    assert.equal(privateView(state, ids[0]).goodsPerType, goodsPerType);
    assert.equal(spectatorView(state).goodsPerType, goodsPerType);
    assert.equal(command(state, 'end-turn').goodsPerType, goodsPerType);
  }
  for (const value of [0, 3, 21, 4.5, '8', null, NaN, Infinity]) assert.throws(() => fresh({ goodsPerType: value }), /开局参数/);
  for (const value of [0, 11, 1.5, '5', null]) assert.throws(() => fresh({ actionLimit: value }), /开局参数/);
});

test('legacy missing stock setting stays six through projection, pending actions and serialization', () => {
  const legacy = fresh({ actionLimit: 7, goodsPerType: 6 }); delete legacy.goodsPerType;
  const before = JSON.stringify(legacy);
  assert.equal(gameProblem(legacy), null); assert.equal(spectatorView(legacy).goodsPerType, 6);
  assert.equal(JSON.stringify(legacy), before);
  const restored = JSON.parse(before), pending = command(restored, 'peek'), next = command(pending, 'keep-peek');
  for (const state of [pending, next]) {
    assert.equal(Object.hasOwn(state, 'goodsPerType'), false); assert.equal(state.actionLimit, 7);
    assert.equal(gameProblem(state), null); assert.deepEqual(Object.values(state.bankGoods), Array(6).fill(6));
  }
  const removed = fresh(); delete removed.goodsPerType; assert.match(gameProblem(removed), /守恒6/);
  for (const value of [undefined, null, 3, 21, '8', 8.5]) {
    const corrupt = fresh(); corrupt.goodsPerType = value; assert.ok(gameProblem(corrupt));
  }
  for (const mutate of [state => { state.bankGoods.firearms++; }, state => { state.extra = 8; },
    state => { state.goodsPerType = 7; }, state => { state.version = 2; }]) {
    const corrupt = fresh(); mutate(corrupt); assert.ok(gameProblem(corrupt));
  }
});

test('goods above six move and sell through real effects without weakening per-type conservation', () => {
  let state = fresh({ goodsPerType: 20 });
  const all = [...state.deck, ...state.players.flatMap(owner => owner.hand)], cardId = 'yousei.c13#01';
  state.players.forEach(owner => { owner.hand = []; }); state.players[0].hand = [cardId]; state.deck = all.filter(id => id !== cardId);
  Object.assign(state.players[0], { goods: { ...emptyGoods(), firearms: 8 }, stallCount: 1 });
  state.bankGoods.firearms -= 8; state.availableStalls = 4; state.purchasedStalls = 1;
  assert.equal(gameProblem(state), null);
  state = command(state, 'finish-draw'); state = command(state, 'play-character', { cardId });
  assert.equal(state.pending.choice.options[0].maximum, 8);
  state = command(state, 'choose-effect', { selection: { goods: { ...emptyGoods(), firearms: 8 } } });
  assert.equal(state.players[0].silver, 36); assert.equal(state.bankGoods.firearms, 20); assert.equal(gameProblem(state), null);
  const event = { type: 'trade-sold', actorSeatId: ids[0], cardId: 'yousei.g01', goods: [{ id: 'firearms', count: 20 }], silver: 40 };
  assert.deepEqual(validateHyakkiPublicEvent(event), event);
  assert.throws(() => validateHyakkiPublicEvent({ ...event, goods: [{ id: 'firearms', count: 21 }] }), /局内历史/);
  state.lastPublicEvents = [event]; assert.equal(gameProblem(state), null);
  const legacy = fresh({ goodsPerType: 6 }); delete legacy.goodsPerType; legacy.lastPublicEvents = [event];
  assert.match(gameProblem(legacy), /公开事件/);
});

test('adapter config preserves old omitted settings, rejects malformed values and writes schema13', () => {
  const adapter = createHyakkiAdapter(), modern = adapter.roomDefaults(), legacy = { hyakkiConfig: { actionLimit: 7 } };
  assert.deepEqual(modern.hyakkiConfig, { actionLimit: 5, goodsPerType: 8 });
  assert.deepEqual(adapter.configure(modern, { hyakkiConfig: { actionLimit: 4 } }).updates.hyakkiConfig, { actionLimit: 4, goodsPerType: 8 });
  assert.deepEqual(adapter.configure(legacy, { hyakkiConfig: { actionLimit: 4 } }).updates.hyakkiConfig, { actionLimit: 4, goodsPerType: 6 });
  assert.equal(adapter.roomView(legacy).hyakkiConfig.goodsPerType, 6); assert.equal(Object.hasOwn(legacy.hyakkiConfig, 'goodsPerType'), false);
  for (const goodsPerType of [4, 8, 20]) assert.deepEqual(adapter.configure(modern, { hyakkiConfig: { actionLimit: 5, goodsPerType } }).updates.hyakkiConfig, { actionLimit: 5, goodsPerType });
  for (const config of [{ actionLimit: 5, goodsPerType: null }, { actionLimit: 5, goodsPerType: undefined },
    { actionLimit: 5, goodsPerType: 21 }, { actionLimit: 5, goodsPerType: '8' }, { goodsPerType: 8 },
    { actionLimit: 5, goodsPerType: 8, extra: true }]) assert.equal(adapter.configure(modern, { hyakkiConfig: config }).problem.code, 'INVALID_CONFIG');
  const envelope = { schemaVersion: 12, gameType: 'hyakki-trading', turnClock: null, hyakkiConfig: legacy.hyakkiConfig, game: null };
  assert.equal(adapter.snapshotSchema(), 13); assert.equal(adapter.snapshotProblem(envelope), false);
  assert.equal(adapter.snapshotProblem({ ...envelope, hyakkiConfig: modern.hyakkiConfig }), true);
  assert.equal(adapter.snapshotProblem({ ...envelope, schemaVersion: 13, hyakkiConfig: modern.hyakkiConfig }), false);
});
