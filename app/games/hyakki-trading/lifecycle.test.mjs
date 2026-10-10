import test from 'node:test';
import assert from 'node:assert/strict';
import { createHyakkiTiming, openHyakkiDecision, closeHyakkiDecision, transitionHyakkiLifecycle,
  changeHyakkiPause, hyakkiCommonActionProblem, hyakkiGameClock, hyakkiRetentionDeadline, TURN_MS, ABSENCE_MS, PAUSE_MS } from './lifecycle.mjs';
import { turnClockDisplay, roomExitExplanation } from '../../platform/room-presentation.mjs';
import { createRoomClock } from '../../platform/room-clock.mjs';
const ids = ['a', 'b'];
const online = now => ({ observedAt: now, seats: ids.map(playerId => ({ playerId, connected: true, lastSeenAt: now,
  leaseExpiresAt: now + 1000, absenceSinceAt: null })) });
const start = (at = 1000) => ({ players: ids.map(id => ({ id })), turnPlayerId: 'a', status: 'playing', result: null,
  ...createHyakkiTiming(ids, 'a', at, online(at)) });
const step = (game, now, presence, reason = 'presence') => transitionHyakkiLifecycle(game, { now, presence, reason });

test('other player response freezes active time; an interruption freezes response too and resumes each remaining value', () => {
  let game = openHyakkiDecision(start(), { id: 'choice-1', actorId: 'b', label: '对方回应', now: 2000 }).state;
  assert.equal(game.timing.active.remainingMs, TURN_MS - 1000);
  game = step(game, 2000, online(2000)).state;
  const absent = online(3000); absent.seats[1] = { ...absent.seats[1], connected: false, absenceSinceAt: 2500 };
  game = step(game, 3000, absent).state;
  assert.equal(game.lifecycle.absence.deadlineAt, 2500 + ABSENCE_MS);
  assert.equal(game.timing.decision.remainingMs, 59500);
  assert.equal(game.timing.active.remainingMs, TURN_MS - 1000);
  const restored = step(game, 100000, online(100000)).state;
  assert.equal(restored.timing.decision.deadlineAt, 159500);
  assert.equal(restored.timing.active.deadlineAt, null);
  const closed = closeHyakkiDecision(restored, 110000).state;
  assert.equal(closed.timing.active.deadlineAt, 110000 + TURN_MS - 1000);
  assert.equal(game.timing.decision.deadlineAt, null, 'pure transitions do not change an earlier saved state');
});
test('missing transport after a crash derives deadline from saved evidence, never grants a fresh half-hour', () => {
  const game = start(), late = step(game, 100000, { observedAt: 100000, seats: [] }, 'server-recovery');
  assert.equal(late.state.lifecycle.absence.startedAt, 2000);
  assert.equal(late.state.lifecycle.absence.deadlineAt, 2000 + ABSENCE_MS);
  assert.equal(late.state.timing.active.remainingMs, TURN_MS - 1000);
  const repeated = step(late.state, 110000, undefined, 'server-recovery');
  assert.equal(repeated.changed, false);
  const expired = step(late.state, 2000 + ABSENCE_MS, online(2000 + ABSENCE_MS));
  assert.equal(expired.status, 'aborted'); assert.deepEqual(expired.state.result.winnerIds, []);
});
test('manual pause keeps original seven-day deadline; absence before pause cannot be laundered', () => {
  const game = start(), paused = changeHyakkiPause(game, 'paused', 1100, { presence: online(1100) }).state;
  const restored = step(paused, 100000, undefined, 'server-recovery').state;
  assert.equal(restored.lifecycle.absence, null);
  assert.equal(hyakkiRetentionDeadline(restored), 1100 + PAUSE_MS);
  assert.equal(changeHyakkiPause(restored, 'playing', 100000).ok, false);
  const resumed = changeHyakkiPause(restored, 'playing', 100000, { presence: online(100000) }).state;
  assert.equal(resumed.timing.active.deadlineAt, 100000 + TURN_MS - 100);
  const absent = step(game, 4000).state;
  assert.ok(hyakkiCommonActionProblem(absent, { type: 'pause' }, { now: 4100, presence: online(4100) }));
  const end = step(restored, 1100 + PAUSE_MS);
  assert.equal(end.state.result.reason, 'room-expired');
});
test('capacity and absence holds cannot clear one another; resignation records opponent without changing money', () => {
  const source = { ...start(), silver: [18, 20], pending: { paid: true, candidate: 'private' } };
  let game = step(source, 2000, online(2000), 'capacity').state;
  game = step(game, 4000).state;
  assert.ok(game.lifecycle.capacity); assert.ok(game.lifecycle.absence);
  game = step(game, 5000, undefined, 'capacity-cleared').state;
  assert.equal(hyakkiGameClock(game).paused, true);
  const resigned = transitionHyakkiLifecycle(game, { reason: 'voluntary-leave', playerId: 'a', now: 6000 });
  assert.equal(resigned.status, 'completed'); assert.deepEqual(resigned.state.result.winnerIds, ['b']);
  assert.deepEqual(resigned.state.silver, source.silver); assert.deepEqual(resigned.state.pending, source.pending);
});
test('checkpoint only heartbeats do not change game clocks or emit a business transition', () => {
  const game = start(), refreshed = step(game, 1200, online(1200));
  assert.equal(refreshed.checkpointOnly, true); assert.deepEqual(refreshed.state.timing, game.timing);
  assert.equal(step(refreshed.state, 1200, online(1200)).changed, false);
  assert.equal(openHyakkiDecision(game, { id: 'own', actorId: 'a', label: '自己选牌', now: 1200 }).ok, false);
});
test('v4 actual clock controller pauses without expiry and resumes decision labels without legacy game branches', () => {
  let at = 0, expired = 0, interval, cleared = 0;
  const game = openHyakkiDecision(start(), { id: 'choice-1', actorId: 'b', label: '选择拍品', now: 2000 }).state;
  const view = game => ({ phase: hyakkiGameClock(game).paused ? 'paused' : 'playing', gameType: 'hyakki-trading', serverTime: 2000,
    turnClock: { version: 4, ...hyakkiGameClock(game) } });
  const clock = createRoomClock({ now: () => at, onExpire: () => expired++, setInterval: fn => { interval = fn; return 1; }, clearInterval: () => cleared++ });
  clock.receive(view(game)); at = 1000; interval(); assert.equal(clock.display().time, '00:59');
  const paused = step(game, 3000, online(3000), 'capacity').state;
  clock.receive(view(paused)); at = 500000; clock.render();
  assert.equal(clock.display().time, '00:59'); assert.equal(expired, 0); assert.equal(cleared, 1);
  assert.match(clock.display().label, /选择拍品已暂停/);
  const resumed = step(paused, 10000, online(10000), 'capacity-cleared').state;
  clock.receive({ ...view(resumed), serverTime: 10000 }); at += 59000; clock.render(); clock.render();
  assert.equal(expired, 1); assert.doesNotMatch(clock.display().label, /勾叉|换人/); clock.destroy();
  assert.equal(turnClockDisplay({ ...view(game), turnClock: { ...view(game).turnClock, deadlineAt: null } }).visible, false);
  assert.match(roomExitExplanation('playing', 'resign'), /认输/);
  assert.match(roomExitExplanation('playing'), /不计输赢/);
});
