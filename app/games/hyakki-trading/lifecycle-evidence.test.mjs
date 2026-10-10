import test from 'node:test';
import assert from 'node:assert/strict';
import { createHyakkiTiming, transitionHyakkiLifecycle, hyakkiCommonActionProblem, hyakkiTimingProblem } from './lifecycle.mjs';

const ids = ['a', 'b'];
const presence = (observedAt, leaseExpiresAt = observedAt + 10000) => ({ observedAt,
  seats: ids.map(playerId => ({ playerId, connected: true, lastSeenAt: observedAt, leaseExpiresAt, absenceSinceAt: null })) });
const game = () => ({ players: ids.map(id => ({ id })), turnPlayerId: 'a', status: 'playing', result: null,
  ...createHyakkiTiming(ids, 'a', 1000, presence(1000)) });

test('trusted presence remains valid across a millisecond between its read and lifecycle evaluation', () => {
  const source = game();
  const changed = transitionHyakkiLifecycle(source, { reason: 'presence', now: 1002, presence: presence(1001) });
  assert.equal(changed.ok, true); assert.equal(changed.roomPhase, 'playing');
  assert.equal(changed.state.lifecycle.absence, null);
  assert.equal(hyakkiCommonActionProblem(source, { type: 'pause' }, { now: 1002, presence: presence(1001) }), null);
});

test('start persists the actual trusted lease rather than replacing slightly older evidence with start time', () => {
  const timing = createHyakkiTiming(ids, 'a', 1002, presence(1001, 11001));
  assert.ok(timing.lifecycle.checkpoints.every(seat => seat.lastSeenAt === 1001 && seat.leaseExpiresAt === 11001));
});

test('older presence evidence cannot keep an expired lease online', () => {
  const source = game();
  const changed = transitionHyakkiLifecycle(source, { reason: 'presence', now: 11000, presence: presence(1000, 11000) });
  assert.equal(changed.roomPhase, 'paused');
  assert.equal(changed.state.lifecycle.absence.startedAt, 11000);
});

test('a delayed transport close cannot renew a lease or corrupt a saved checkpoint', () => {
  const source = game(), now = 3601000;
  const lateClose = { observedAt: now, seats: ids.map(playerId => ({ playerId,
    connected: false, lastSeenAt: now, leaseExpiresAt: 11000, absenceSinceAt: 11000 })) };
  const changed = transitionHyakkiLifecycle(source, { reason: 'disconnected', now, presence: lateClose });
  assert.equal(changed.ok, true); assert.equal(changed.roomPhase, 'aborted');
  assert.equal(changed.state.lifecycle.absence.startedAt, 11000);
  assert.equal(changed.state.lifecycle.absence.deadlineAt, 1811000);
  assert.equal(hyakkiTimingProblem(changed.state), null);
});
