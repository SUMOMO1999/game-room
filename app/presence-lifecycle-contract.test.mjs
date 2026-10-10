import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameRegistry } from './game-registry.mjs';
import { createRoomStore } from './rooms.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { requireAdapter } from '../server/games/adapter-contract.mjs';

// A third implementation: a public counter with a timed decision, no hands or
// cards, short absence cancellation and its own pause/resume policy.
function responseAdapter() {
  function finish(state, reason, winnerId = null) {
    return { ok: true, state: { ...state, status: winnerId ? 'finished' : 'aborted',
      result: { reason, winnerId } }, roomPhase: winnerId ? 'finished' : 'aborted',
      terminal: true, status: winnerId ? 'completed' : 'aborted' };
  }
  function hold(state, kind, since, deadline) {
    state.held = { kind, since, deadline };
    state.clock.remainingMs = Math.max(0, state.clock.deadlineAt - since);
    state.clock.deadlineAt = null; state.clock.paused = true;
  }
  function resume(state, now) {
    state.held = null; state.clock.deadlineAt = now + state.clock.remainingMs; state.clock.paused = false;
  }
  return {
    gameType: 'response-probe', minPlayers: 2, maxPlayers: 2, ruleVersions: ['response-probe-v1'],
    actionTypes: ['increment'], configurationFields: [], usesPresenceLifecycle: true,
    createGame: (players, { now, presence }) => ({ ruleVersion: 'response-probe-v1', players, status: 'playing', round: 1,
      turnIndex: 0, counter: 0, held: null, checkpoint: (presence?.seats ?? []).map(({ playerId, lastSeenAt, leaseExpiresAt }) => ({ playerId, lastSeenAt, leaseExpiresAt })), result: null,
      clock: { deadlineAt: now + 100, remainingMs: 100, paused: false } }),
    gameOptions: (_room, options) => options, roomDefaults: () => ({}), playersChanged() {},
    actionFields: type => type === 'increment' ? [] : null, validateAction: () => null,
    configurationSupportProblem: () => null, configure: () => ({ updates: {} }), roomView: () => ({}),
    privateView: state => structuredClone(state), spectatorView: state => structuredClone(state),
    playerSummary: () => ({}), describeAction: () => '公开计数增加。',
    playerResult: (result, playerId) => ({ outcome: !result?.winnerId ? 'unscored' : result.winnerId === playerId ? 'win' : 'loss', remainingPoints: null }),
    historyPlayerProblem: () => null, historyOutcomeProblem: () => null,
    stateProblem: state => state.ruleVersion !== 'response-probe-v1' || !Number.isSafeInteger(state.counter) ? 'bad probe' : null,
    snapshotSchema: () => 8, snapshotProblem: data => data.schemaVersion !== 8,
    roomStateProblem: room => room.game && room.turnClock && (room.turnClock.version !== 4
      || room.turnClock.paused !== room.game.clock.paused) ? 'bad probe clock' : null,
    gameStatusForRoomPhase: phase => ['finished', 'aborted'].includes(phase) ? phase : 'playing',
    turnTimeoutMs: () => 0, supportsTimeout: () => true,
    gameClock: state => ['finished', 'aborted'].includes(state.status) ? null : ({ clockVersion: 4, kind: 'decision', id: 'public-choice',
      ...state.clock, label: '公开计数选择', privateCandidate: 'must-not-copy' }),
    applyGameAction: state => ({ ok: true, state: { ...state, counter: state.counter + 1 } }),
    applyTimeout: state => ({ ok: true, state: { ...state, counter: state.counter + 10,
      clock: { ...state.clock, deadlineAt: state.clock.deadlineAt + 100 } } }), describeTimeout: () => '选择到期。',
    roomRetentionDeadline: state => state.held?.deadline ?? null,
    commonActionProblem: (room, _id, action, { presence }) => ['pause', 'resume'].includes(action.type)
      && (presence?.seats.some(seat => !seat.connected) || room.game.held?.kind === 'capacity')
      ? { status: 409, code: 'PROBE_HELD', message: '当前不可继续。' } : null,
    onPhaseChanged(state, phase, now) {
      const next = structuredClone(state);
      if (phase === 'paused' && !next.held) hold(next, 'manual', now, now + 5000);
      if (phase === 'playing' && next.held?.kind === 'manual') resume(next, now);
      return { ok: true, state: next };
    },
    lifecycleTransition(state, { reason, playerId, now, presence }) {
      if (reason === 'voluntary-leave') return finish(state, 'resigned', state.players.find(player => player.id !== playerId).id);
      if (reason === 'room-expired') return finish(state, 'expired');
      const next = structuredClone(state), beforeHeld = JSON.stringify(state.held);
      const seats = presence?.seats ?? [];
      next.checkpoint = state.players.map(({ id }) => {
        const seat = seats.find(seat => seat.playerId === id), saved = state.checkpoint.find(seat => seat.playerId === id);
        return seat?.leaseExpiresAt !== null && seat?.leaseExpiresAt !== undefined
          ? { playerId: id, lastSeenAt: seat.lastSeenAt, leaseExpiresAt: seat.leaseExpiresAt } : saved ?? { playerId: id, lastSeenAt: now, leaseExpiresAt: now };
      });
      if (next.held?.deadline !== null && next.held?.deadline !== undefined && now >= next.held.deadline) return finish(next, `${next.held.kind}-expired`);
      if (reason === 'capacity' && !next.held) hold(next, 'capacity', now, null);
      else if (reason === 'capacity-cleared' && next.held?.kind === 'capacity') resume(next, now);
      else if (!['manual', 'capacity'].includes(next.held?.kind)) {
        const absent = seats.filter(seat => !seat.connected);
        if (absent.length && !next.held) {
          const since = Math.min(...absent.map(seat => seat.absenceSinceAt
            ?? next.checkpoint.find(saved => saved.playerId === seat.playerId).leaseExpiresAt));
          hold(next, 'absence', since, since + 500);
          if (now >= next.held.deadline) return finish(next, 'absence-expired');
        } else if (!absent.length && next.held && seats.length === state.players.length) resume(next, now);
      }
      return { ok: true, state: next, roomPhase: next.held ? 'paused' : 'playing', terminal: false,
        changed: JSON.stringify(next) !== JSON.stringify(state), checkpointOnly: beforeHeld === JSON.stringify(next.held) };
    },
  };
}

const users = ['a'.repeat(64), 'b'.repeat(64)];
let sequence = 0;
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'presence-contract-')), key = randomBytes(32), opened = [];
  let time = 1000;
  const registry = createGameRegistry([responseAdapter()]);
  function open() {
    const storage = new EncryptedStore(new SQLiteAdapter(join(directory, 'rooms.sqlite'), { now: () => time }), key, () => time);
    const rooms = createDurableRoomStore({ storage, now: () => time, gameRegistry: registry, pollIntervalMs: 0,
      presenceTtlMs: 50, ttlMs: 1000, pausedTtlMs: 200, ...extra });
    const instance = { storage, rooms }; opened.push(instance); return instance;
  }
  const first = open();
  t.after(async () => { for (const entry of opened) { await entry.rooms.close(); entry.storage.close(); } await rm(directory, { recursive: true }); });
  const act = async (rooms, code, index, type, fields = {}) => rooms.action(code, users[index], {
    type, requestId: `presence-${++sequence}`, expectedRevision: (await rooms.getView(code, users[index])).revision, ...fields,
  });
  async function start() {
    const host = await first.rooms.createRoom(users[0], '甲', `create-${++sequence}`, 'response-probe');
    await first.rooms.joinRoom(host.roomCode, users[1], '乙', `join-${++sequence}`);
    const disconnect = [];
    for (let index = 0; index < 2; index++) disconnect.push(await first.rooms.subscribe(host.roomCode, users[index], () => {}));
    for (let index = 0; index < 2; index++) await act(first.rooms, host.roomCode, index, 'ready', { ready: true });
    await act(first.rooms, host.roomCode, 0, 'start');
    return { view: await first.rooms.getView(host.roomCode, users[0]), disconnect };
  }
  return { ...first, open, act, start, registry, now: () => time, advance: delta => { time += delta; } };
}

test('optional contracts reject invalid policy shapes and retain a credential-free paused clock', () => {
  assert.throws(() => requireAdapter({ ...responseAdapter(), usesPresenceLifecycle: 'yes' }), TypeError);
  const rooms = createRoomStore({ gameRegistry: createGameRegistry([responseAdapter()]), now: () => 1000 });
  const a = rooms.createTrustedRoom(users[0], '甲', { code: '345678', roomId: 'c'.repeat(32), gameType: 'response-probe' });
  rooms.joinTrustedRoom(a.roomCode, users[1], '乙');
  const action = (index, type, fields = {}) => rooms.trustedAction(a.roomCode, users[index], { type, requestId: `memory-${++sequence}`,
    expectedRevision: rooms.getTrustedView(a.roomCode, users[index]).revision, ...fields });
  action(0, 'ready', { ready: true }); action(1, 'ready', { ready: true });
  const started = action(0, 'start').view;
  const presence = { observedAt: 1000, seats: started.players.map(player => ({ playerId: player.id, connected: false,
    lastSeenAt: 1000, leaseExpiresAt: 1000, absenceSinceAt: 1000 })) };
  assert.equal(rooms.applyLifecycle(a.roomCode, { matchId: started.matchId, reason: 'presence', presence }), true);
  const saved = rooms.exportSnapshot(a.roomCode);
  assert.equal(saved.phase, 'paused'); assert.equal(saved.pendingRecords.length, 0); assert.equal(saved.matchEndedAt, undefined);
  assert.deepEqual(saved.turnClock, { version: 4, kind: 'decision', id: 'public-choice', deadlineAt: null,
    remainingMs: 100, paused: true, label: '公开计数选择', matchId: started.matchId });
  const restored = createRoomStore({ gameRegistry: createGameRegistry([responseAdapter()]), now: () => 1000 });
  restored.importSnapshot(saved); assert.equal(restored.getTrustedView(a.roomCode, users[0]).phase, 'paused');
});

test('SQLite: one remaining device keeps a seat online; final disconnect freezes and reconnect preserves remaining time', async t => {
  const f = await fixture(t), { view, disconnect } = await f.start();
  const other = await f.rooms.subscribe(view.roomCode, users[0], () => {});
  f.advance(10); await disconnect[0]();
  assert.equal((await f.rooms.getView(view.roomCode, users[1])).phase, 'playing');
  f.advance(10); await other();
  const held = await f.rooms.getView(view.roomCode, users[1]);
  assert.equal(held.phase, 'paused'); assert.equal(held.game.held.since, 1020); assert.equal(held.game.clock.remainingMs, 80);
  assert.equal(held.game.held.deadline, 1520); assert.equal((await f.storage.read('rooms', view.roomId)).value.snapshot.pendingRecords.length, 0);
  f.advance(10); await f.rooms.subscribe(view.roomCode, users[0], () => {});
  const resumed = await f.rooms.getView(view.roomCode, users[0]);
  assert.equal(resumed.phase, 'playing'); assert.equal(resumed.game.clock.deadlineAt, 1110);
});

test('SQLite: start saves lease evidence and heartbeat checkpoints do not renew activity or business TTL', async t => {
  const f = await fixture(t), { view } = await f.start();
  const initial = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(initial.game.checkpoint.length, 2); assert.ok(initial.game.checkpoint.every(seat => seat.leaseExpiresAt === 1050));
  f.advance(10); await f.rooms.sweep();
  const next = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.ok(next.game.checkpoint.every(seat => seat.leaseExpiresAt === 1060));
  assert.equal(next.lastActiveAt, initial.lastActiveAt); assert.deepEqual(next.activity, initial.activity);
  assert.ok(next.revision > initial.revision); assert.equal((await f.rooms.getView(view.roomCode, users[0])).expiresAt, view.expiresAt);
});

test('SQLite: late disconnect callbacks preserve the expired lease as the absence origin', async t => {
  const f = await fixture(t), { view, disconnect } = await f.start();
  f.advance(60); await disconnect[0](); await disconnect[1]();
  const held = await f.rooms.getView(view.roomCode, users[0]);
  assert.equal(held.game.held.since, 1050); assert.equal(held.game.held.deadline, 1550);
});

test('SQLite: lease checkpoint between pause votes preserves the first participant consent', async t => {
  const f = await fixture(t), { view } = await f.start();
  const proposed = (await f.act(f.rooms, view.roomCode, 0, 'pause')).view;
  assert.equal(proposed.pause.agreedIds.length, 1);
  f.advance(10); await f.rooms.sweep();
  const refreshed = await f.rooms.getView(view.roomCode, users[1]);
  assert.deepEqual(refreshed.pause.agreedIds, proposed.pause.agreedIds);
  assert.equal((await f.act(f.rooms, view.roomCode, 1, 'pause')).view.phase, 'paused');
});

test('SQLite: missing presence on recovery uses saved lease deadline and cannot run an overdue economic timeout', async t => {
  const f = await fixture(t), { view } = await f.start();
  await f.storage.remove('room-presence', view.roomId);
  f.advance(180);
  const recovered = f.open(); await recovered.rooms.ready;
  const held = await recovered.rooms.getView(view.roomCode, users[0]);
  assert.equal(held.phase, 'paused'); assert.equal(held.game.held.since, 1050);
  assert.equal(held.game.held.deadline, 1550); assert.equal(held.game.counter, 0);
  await recovered.rooms.sweep(); assert.equal((await recovered.rooms.getView(view.roomCode, users[0])).game.counter, 0);
  f.advance(370); await recovered.rooms.sweep();
  const ended = (await recovered.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(ended.phase, 'aborted'); assert.equal(ended.pendingRecords.length, 1);
  assert.equal(ended.pendingRecords[0].reason, 'absence-expired');
  assert.ok(ended.pendingRecords[0].players.every(player => player.outcome === 'unscored'));
});

test('SQLite: manual pause outlives common TTL and offline recovery does not replace its deadline', async t => {
  const f = await fixture(t), { view, disconnect } = await f.start();
  await f.act(f.rooms, view.roomCode, 0, 'pause'); await f.act(f.rooms, view.roomCode, 1, 'pause');
  await disconnect[0](); await disconnect[1]();
  f.advance(2000); const recovered = f.open(); await recovered.rooms.ready;
  const held = await recovered.rooms.getView(view.roomCode, users[0]);
  assert.equal(held.phase, 'paused'); assert.equal(held.expiresAt, 6000); assert.equal(held.game.held.kind, 'manual');
  assert.equal(held.game.held.deadline, 6000); assert.equal(held.game.counter, 0);
  f.advance(3000); await recovered.rooms.sweep();
  const terminal = (await recovered.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(terminal.phase, 'aborted'); assert.equal(terminal.pendingRecords[0].reason, 'manual-expired');
});

test('SQLite: lease expiry at the economic commit fences the action and forces suspension', async t => {
  const f = await fixture(t), { view } = await f.start();
  const original = f.storage.guardedCAS.bind(f.storage); let raced = false;
  f.storage.guardedCAS = async (...args) => {
    if (!raced && args[3]?.snapshot?.game?.counter === 1) { raced = true; f.advance(50); }
    return original(...args);
  };
  await assert.rejects(f.act(f.rooms, view.roomCode, 0, 'increment'), error => ['REVISION_CONFLICT', 'GAME_PAUSED'].includes(error.code));
  const held = await f.rooms.getView(view.roomCode, users[0]);
  assert.equal(raced, true); assert.equal(held.phase, 'paused'); assert.equal(held.game.counter, 0); assert.equal(held.game.held.since, 1050);
});

test('SQLite: two devices cannot both commit one revision, and disconnect racing timeout prevents its economy', async t => {
  const f = await fixture(t, { presenceTtlMs: 200 }), { view, disconnect } = await f.start(), peer = f.open();
  await peer.rooms.ready;
  const current = await f.rooms.getView(view.roomCode, users[0]);
  const inputs = [0, 1].map(index => ({ type: 'increment', requestId: `competing-${index}`, expectedRevision: current.revision }));
  const results = await Promise.allSettled([f.rooms.action(view.roomCode, users[0], inputs[0]), peer.rooms.action(view.roomCode, users[0], inputs[1])]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.rooms.getView(view.roomCode, users[0])).game.counter, 1);
  const original = f.storage.guardedCAS.bind(f.storage); let raced = false;
  f.storage.guardedCAS = async (...args) => {
    if (!raced && args[3]?.snapshot?.game?.counter === 11) { raced = true; await disconnect[1](); }
    return original(...args);
  };
  f.advance(100); await f.rooms.sweep();
  const held = await f.rooms.getView(view.roomCode, users[0]);
  assert.equal(raced, true); assert.equal(held.phase, 'paused'); assert.equal(held.game.counter, 1);
});

test('SQLite: non-score resignation archives win/loss once and keeps frozen participants', async t => {
  const f = await fixture(t), { view } = await f.start();
  await f.act(f.rooms, view.roomCode, 0, 'leave');
  const record = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(record.phase, 'finished'); assert.equal(record.pendingRecords.length, 1);
  assert.equal(record.pendingRecords[0].status, 'completed'); assert.equal(record.pendingRecords[0].reason, 'resigned');
  assert.deepEqual(record.pendingRecords[0].players.map(player => player.outcome), ['loss', 'win']);
  assert.equal(record.matchParticipants.length, 2); assert.equal(record.players.length, 1);
  assert.equal(record.pendingRecords[0].deltas, undefined);
});

test('SQLite: capacity rejection commits only one reserved suspension from the previous state', async t => {
  let suspensions = 0;
  const preparer = { scopes: ['probe-events'], prepare: async ({ previous, next }) => {
    if (next.snapshot?.game?.counter > (previous.snapshot?.game?.counter ?? 0)) {
      const error = new Error('history full'); error.status = 503; error.code = 'GAME_HISTORY_CAPACITY'; throw error;
    }
    if (next.snapshot?.game?.held?.kind === 'capacity' && previous.snapshot?.game?.held?.kind !== 'capacity') suspensions++;
    return { changes: [], guards: [] };
  } };
  const f = await fixture(t, { transitionPreparers: new Map([['response-probe', preparer]]) }), { view } = await f.start();
  await assert.rejects(f.act(f.rooms, view.roomCode, 0, 'increment'), { code: 'GAME_HISTORY_CAPACITY' });
  assert.equal((await f.rooms.getView(view.roomCode, users[0])).game.counter, 0);
  assert.equal((await f.rooms.getView(view.roomCode, users[0])).game.held.kind, 'capacity');
  await assert.rejects(f.act(f.rooms, view.roomCode, 0, 'increment'), { code: 'GAME_PAUSED' });
  await f.rooms.sweep(); assert.equal(suspensions, 1);
  await assert.rejects(f.act(f.rooms, view.roomCode, 0, 'resume'), { code: 'PROBE_HELD' });
  await assert.rejects(f.rooms.applyLifecycle(view.roomCode, { matchId: view.matchId, reason: 'presence' }), { code: 'INVALID_LIFECYCLE' });
  assert.equal(await f.rooms.applyLifecycle(view.roomCode, { matchId: view.matchId, reason: 'capacity-cleared' }), true);
  assert.equal((await f.rooms.getView(view.roomCode, users[0])).phase, 'playing');
});

test('SQLite: lifecycle capacity fallback uses the saved state and rechecks presence with a one-attempt budget', async t => {
  const reasons = [], preparations = [], adapter = responseAdapter();
  const lifecycleTransition = adapter.lifecycleTransition;
  adapter.lifecycleTransition = (state, options) => {
    reasons.push(options.reason);
    return lifecycleTransition(state, options);
  };
  const preparer = { scopes: ['probe-events'], prepare: async ({ previous, next }) => {
    const kind = next.snapshot?.game?.held?.kind;
    if (kind) preparations.push({ before: previous.snapshot.game.held, kind });
    if (kind === 'absence') throw Object.assign(new Error('history full'), { status: 503, code: 'GAME_HISTORY_CAPACITY' });
    return { changes: [], guards: [] };
  } };
  const f = await fixture(t, { maxCasAttempts: 1, gameRegistry: createGameRegistry([adapter]),
    transitionPreparers: new Map([['response-probe', preparer]]) }), { view, disconnect } = await f.start();
  reasons.length = 0;
  f.advance(10); await disconnect[0]();
  assert.deepEqual(reasons, ['presence', 'capacity', 'presence']);
  assert.deepEqual(preparations, [{ before: null, kind: 'absence' }, { before: null, kind: 'capacity' }]);
  const held = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(held.phase, 'paused'); assert.equal(held.game.counter, 0);
  assert.equal(held.game.held.kind, 'capacity'); assert.equal(held.game.clock.remainingMs, 90);
  assert.equal(held.pendingRecords.length, 0);
  await f.rooms.getView(view.roomCode, users[0]); await f.rooms.sweep();
  assert.equal(preparations.filter(entry => entry.kind === 'capacity' && entry.before === null).length, 1);
});

test('SQLite: a lifecycle reserve failure propagates once without recursively attempting another suspension', async t => {
  const failure = Object.assign(new Error('reserve unavailable'), { status: 503, code: 'GAME_HISTORY_CAPACITY' });
  let armed = false;
  const kinds = [], preparer = { scopes: ['probe-events'], prepare: async ({ next }) => {
    if (armed && next.snapshot?.game?.held) { kinds.push(next.snapshot.game.held.kind); throw failure; }
    return { changes: [], guards: [] };
  } };
  const f = await fixture(t, { transitionPreparers: new Map([['response-probe', preparer]]) }), { view, disconnect } = await f.start();
  const before = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  armed = true;
  try { await assert.rejects(disconnect[0](), error => error === failure); }
  finally { armed = false; }
  assert.deepEqual(kinds, ['absence', 'capacity']);
  assert.deepEqual((await f.storage.read('rooms', view.roomId)).value.snapshot, before);
});

test('SQLite: conflicting capacity fallback commits stop at the configured lifecycle CAS budget', async t => {
  let armed = false, normalAttempts = 0, reserveAttempts = 0;
  const preparer = { scopes: ['probe-events'], prepare: async ({ next }) => {
    if (armed && next.snapshot?.game?.held?.kind === 'absence') {
      normalAttempts++;
      throw Object.assign(new Error('history full'), { status: 503, code: 'GAME_HISTORY_CAPACITY' });
    }
    return { changes: [], guards: [] };
  } };
  const f = await fixture(t, { maxCasAttempts: 2, transitionPreparers: new Map([['response-probe', preparer]]) }),
    { view, disconnect } = await f.start();
  const before = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  const original = f.storage.compareAndSwapMany.bind(f.storage);
  f.storage.compareAndSwapMany = async input => {
    if (armed && input.changes.some(change => change.scope === 'rooms' && change.value.snapshot?.game?.held?.kind === 'capacity')) {
      reserveAttempts++; return false;
    }
    return original(input);
  };
  armed = true;
  try { await assert.rejects(disconnect[0](), { code: 'STORE_BUSY' }); }
  finally { armed = false; f.storage.compareAndSwapMany = original; }
  assert.equal(normalAttempts, 2); assert.equal(reserveAttempts, 2);
  assert.deepEqual((await f.storage.read('rooms', view.roomId)).value.snapshot, before);
});

test('SQLite: failed subscription checkpoint retires its listener and removes the newly issued lease', async t => {
  const f = await fixture(t), { view } = await f.start();
  const original = f.storage.guardedCAS.bind(f.storage); let failOnce = true, ended = 0;
  f.storage.guardedCAS = async (...args) => {
    if (failOnce) { failOnce = false; throw new Error('checkpoint unavailable'); }
    return original(...args);
  };
  f.advance(1);
  await assert.rejects(f.rooms.subscribe(view.roomCode, users[0], () => {}, () => ended++), /checkpoint unavailable/);
  assert.equal(ended, 1);
  const record = (await f.storage.read('room-presence', view.roomId)).value;
  assert.equal(Object.values(record.connections).reduce((count, connections) => count + Object.keys(connections).length, 0), 2);
  await f.rooms.sweep(); assert.equal(ended, 1);
});

test('SQLite: graceful close persists confirmed absence before transport leases are discarded on restore', async t => {
  const f = await fixture(t), { view } = await f.start();
  f.advance(10); await f.rooms.close();
  const saved = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(saved.game.held.since, 1010); assert.equal(saved.game.held.deadline, 1510);
  await f.storage.remove('room-presence', view.roomId); f.advance(100);
  const restored = f.open(); await restored.rooms.ready;
  assert.equal((await restored.rooms.getView(view.roomCode, users[0])).game.held.deadline, 1510);
});

test('a third unscored domain supplies its own terminal timestamp without a score summary', () => {
  let at = 1000;
  const adapter = { ...responseAdapter(), gameEndedAt: state => state.closedAt,
    applyGameAction: (state, actorId, _action, context) => ({ ok: true,
      state: { ...state, status: 'finished', closedAt: context.now, result: { reason: 'counter-closed', winnerId: actorId } } }) };
  assert.equal(adapter.matchSummary, undefined); assert.equal(adapter.accountingPolicy, undefined);
  const registry = createGameRegistry([adapter]), rooms = createRoomStore({ gameRegistry: registry, now: () => ++at });
  const host = rooms.createTrustedRoom(users[0], '甲', { code: '345678', roomId: 'c'.repeat(32), gameType: 'response-probe' });
  rooms.joinTrustedRoom(host.roomCode, users[1], '乙');
  let id = 0;
  const action = (user, type, extra = {}) => rooms.trustedAction(host.roomCode, user,
    { type, requestId: `domain-end-${++id}`, expectedRevision: rooms.getTrustedView(host.roomCode, user).revision, ...extra });
  try {
    for (const user of users) action(user, 'ready', { ready: true });
    action(users[0], 'start'); action(users[0], 'increment');
    const snapshot = rooms.exportSnapshot(host.roomCode);
    assert.equal(snapshot.phase, 'finished'); assert.ok(at > snapshot.game.closedAt);
    assert.equal(snapshot.matchEndedAt, snapshot.game.closedAt);
    assert.equal(snapshot.pendingRecords[0].endedAt, snapshot.game.closedAt);
    const restored = createRoomStore({ gameRegistry: registry, now: () => ++at });
    try { restored.importSnapshot(snapshot); assert.equal(restored.getTrustedView(host.roomCode, users[0]).phase, 'finished'); }
    finally { restored.close(); }
  } finally { rooms.close(); }
});
