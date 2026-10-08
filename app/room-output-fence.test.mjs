import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore } from './rooms.mjs';
import { readSettings } from '../server/config.mjs';
import { IdentityFailure } from '../server/auth.mjs';
import { SessionService } from '../server/session-service.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { createIdentityCheckContext } from '../server/identity-check-context.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createCanvasService, CANVAS_SCOPE } from '../server/games/draw-and-guess/canvas-service.mjs';
import { OutputGuardConflict, SessionOutputConflict, prepareCurrentRoomOutput } from '../server/room-output-fence.mjs';

// Real adapters, encrypted storage, sessions and committed canvas operations.
// The online provider and the output sink are synthetic; these cases do not
// replace real HTTP/SSE batch integration or browser latency measurement.
const users = ['drawer', 'guesser', 'observer'].map(sub => identityKey('urn:output-fence-test', sub));
const words = Array.from({ length: 12 }, (_, index) => ({ id: `fence-word-${index + 1}`, answer: `密词${index + 1}`,
  aliases: [], category: 'daily', categoryName: '日常', difficulty: 'easy', language: 'zh', packId: 'fence-pack',
  packVersion: '1', definitionVersion: 1, source: '原创测试', status: 'reviewed', hintLength: [...`密词${index + 1}`].length,
  tags: [], drawingCue: '仅维护的提示' }));
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const ordinaryUnavailable = error => error instanceof IdentityFailure && error.status === 503 && !(error instanceof OutputGuardConflict);

async function fixture(t, kind) {
  let time = 1000, monotonic = 0, checks = 0, actionNumber = 0;
  const now = () => time, folder = mkdtempSync(join(tmpdir(), 'room-output-fence-')), path = join(folder, 'records.sqlite');
  const key = randomBytes(32), stores = [], canvases = [], contexts = [], code = '123456', roomId = randomBytes(16).toString('hex');
  function open() {
    const storage = new EncryptedStore(kind === 'SQLite' ? new SQLiteAdapter(path, { now }) : new MemoryAdapter({ now }), key, now);
    stores.push(storage); return storage;
  }
  const storage = open(), settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), id = opaqueId(), csrf = opaqueId();
  await storage.put('sessions', id, { phase: 'active', issuer: 'urn:output-fence-test', sub: 'drawer', userKey: users[0], csrf,
    accessToken: 'synthetic-only', expiresAt: time + 3600000, idleUntil: time + settings.idleMs, lastIdentityCheck: time }, time + settings.idleMs);
  const sessions = new SessionService(settings, { store: storage, now, provider: { usesBatchIdentity: true,
    async check(identity) { checks++; return { ...identity }; } } });
  const request = new Request(settings.origin, { headers: { cookie: `${settings.cookieName}=${id}` } });
  const builder = createRoomStore({ now, turnTimeoutMs: 1800000, serverRandomInt: () => 0,
    gameOptions: { firstTurnIndex: 0, frozenCandidates: words } });
  builder.createTrustedRoom(users[0], '合成画者', { code, roomId, gameType: 'draw-and-guess' });
  builder.joinTrustedRoom(code, users[1], '合成猜者'); builder.joinTrustedRoom(code, users[2], '合成观众', { role: 'spectator' });
  function initialAction(user, type, fields = {}) {
    const view = builder.getTrustedView(code, user);
    return builder.trustedAction(code, user, { type, requestId: `initial-${++actionNumber}`, expectedRevision: view.revision, ...fields });
  }
  initialAction(users[0], 'configure', { drawConfig: { rounds: 2, drawingSeconds: 120,
    contentSelection: { packId: 'fence-pack', version: 1, categoryIds: ['daily'], difficulties: ['easy'] } } });
  initialAction(users[0], 'ready', { ready: true }); initialAction(users[1], 'ready', { ready: true }); initialAction(users[0], 'start');
  const choosing = builder.getTrustedView(code, users[0]); assert.ok(choosing.game.candidates);
  const selectedAnswer = choosing.game.candidates[0].answer;
  initialAction(users[0], 'choose', { matchId: choosing.matchId, turnId: choosing.game.turnId, candidateId: choosing.game.candidates[0].id });
  await storage.put('room-invites', code, { roomId }); await storage.put('rooms', roomId, { snapshot: builder.exportSnapshot(code), joins: {} });
  await storage.put('room-registry', 'active', { [roomId]: { code, reservedAt: time } });
  await storage.put('room-presence', roomId, { schemaVersion: 2, connections: {}, lastSeen: {} });
  const rooms = createDurableRoomStore({ storage, now, pollIntervalMs: 0 });
  function canvasService() { const value = createCanvasService({ storage, rooms, now }); canvases.push(value); return value; }
  let canvas = canvasService(); await canvas.ready;
  function context(signal) { const value = createIdentityCheckContext({ now, monotonicNow: () => monotonic, signal }); contexts.push(value); return value; }
  async function authorize(owned) { return sessions.authorize(request, { context: owned, fresh: true, touch: false }); }
  async function action(user, type, fields = {}) {
    const view = await rooms.getView(code, user);
    return rooms.action(code, user, { type, requestId: `action-${++actionNumber}`, expectedRevision: view.revision, ...fields });
  }
  async function wrongGuess() {
    const ctx = await rooms.getGameContext(code, users[1], { includeView: false });
    const result = await action(users[1], 'guess', { matchId: ctx.matchId, turnId: ctx.turnId, text: '错误合成猜测' });
    assert.equal(result.guessResult.correct, false);
  }
  async function append() {
    const before = await canvas.read(code, users[0]), lease = await canvas.acquire(code, users[0], {
      deviceId: 'synthetic-device', canvasId: before.canvasId, bootId: before.bootId }, { authorizationId: id });
    const operations = [{ strokeId: 'synthetic-stroke', tool: 'pen', color: '#245c7c', width: 4, points: [[0.1, 0.2], [0.2, 0.3]] }];
    const result = await canvas.append(code, users[0], { requestId: randomUUID(), deviceId: 'synthetic-device', canvasId: lease.canvasId,
      bootId: lease.bootId, leaseGeneration: lease.leaseGeneration, clearGeneration: 0, expectedSequence: 0, operations }, { authorizationId: id });
    return { result, packet: { kind: 'append', bootId: lease.bootId, canvasId: lease.canvasId, roomId,
      matchId: before.matchId, turnId: before.turnId, sequence: result.ack.sequence, clearGeneration: 0,
      leaseGeneration: lease.leaseGeneration, operations, pointCount: 2 } };
  }
  function preparer(packet, attempts) {
    return async attempt => {
      attempts.push(attempt);
      const current = await rooms.getGameContext(code, users[0], { includeView: false });
      if (current.gameType !== 'draw-and-guess' || current.roomId !== packet.roomId || canvas.bootId !== packet.bootId
        || current.matchId !== packet.matchId || current.turnId !== packet.turnId) return null;
      return { packet, current, guards: [current.roomGuard, current.presenceGuard] };
    };
  }
  function injectAtGate(change) {
    const verify = storage.verifyGuards.bind(storage); let calls = 0;
    storage.verifyGuards = async input => { await change(calls++, input); return verify(input); };
    return () => calls;
  }
  async function editSession(change) {
    const previous = await storage.read('sessions', id);
    assert.equal(await storage.replaceCAS('sessions', id, previous.version, change(previous.value), previous.expiresAt), true);
  }
  t.after(async () => {
    for (const owned of contexts) owned.dispose();
    for (const value of canvases) await value.close();
    await rooms.close(); builder.close();
    for (const value of stores) value.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return { storage, sessions, rooms, code, roomId, context, authorize, append, preparer, injectAtGate, editSession, action, wrongGuess, open,
    get checks() { return checks; },
    advance(milliseconds) { time += milliseconds; monotonic += milliseconds; },
    async approachNextTurn() {
      const ctx = await rooms.getGameContext(code, users[1], { includeView: false });
      await action(users[1], 'guess', { matchId: ctx.matchId, turnId: ctx.turnId, text: selectedAnswer });
      const deadline = (await storage.read('rooms', roomId)).value.snapshot.turnClock.deadlineAt;
      const elapsed = deadline - 1 - time; time += elapsed; monotonic += elapsed;
    },
    async nextTurn() {
      time++; monotonic++;
      await rooms.sweep();
    },
    async replaceGame() {
      const other = createRoomStore({ now });
      try {
        other.createTrustedRoom(users[0], '合成画者', { code, roomId, gameType: 'rummikub' });
        const saved = await storage.read('rooms', roomId);
        assert.equal(await storage.replaceCAS('rooms', roomId, saved.version, { ...saved.value, snapshot: other.exportSnapshot(code) }), true);
      } finally { other.close(); }
    },
    async reboot() { canvas = canvasService(); await canvas.ready; },
  };
}

for (const kind of ['Memory', 'SQLite']) {
  test(`${kind}: a renewed session receives a new check under the original context and preserves its committed canvas`, async t => {
    const f = await fixture(t, kind), { packet } = await f.append(), owned = f.context(), session = await f.authorize(owned);
    const attempts = [], originalDeadline = owned.deadlineMs, prepare = f.preparer(packet, attempts);
    const prepared = await prepareCurrentRoomOutput({ sessions: f.sessions, session, context: owned,
      prepare: async attempt => {
        const value = await prepare(attempt);
        if (attempt === 0) await f.editSession(value => ({ ...value, idleUntil: value.idleUntil + 1 }));
        return value;
      }, refreshSession: () => f.authorize(owned) });
    assert.equal(prepared.packet, packet); assert.deepEqual(attempts, [0, 1]); assert.equal(f.checks, 2);
    assert.equal(owned.deadlineMs, originalDeadline); assert.equal((await f.storage.read(CANVAS_SCOPE, packet.canvasId)).value.sequence, 1);
  });

  test(`${kind}: a second renewal consumes no third output attempt or fresh check`, async t => {
    const f = await fixture(t, kind), { packet } = await f.append(), owned = f.context(), session = await f.authorize(owned);
    const attempts = [], prepare = f.preparer(packet, attempts);
    await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session, context: owned,
      prepare: async attempt => {
        const value = await prepare(attempt);
        await f.editSession(value => ({ ...value, idleUntil: value.idleUntil + 1 })); return value;
      }, refreshSession: () => f.authorize(owned) }), SessionOutputConflict);
    assert.deepEqual(attempts, [0, 1]); assert.equal(f.checks, 2);
  });

  for (const field of ['id', 'userKey', 'issuer', 'sub']) {
    test(`${kind}: refresh changing the original ${field} cannot receive a prepared packet`, async t => {
      const f = await fixture(t, kind), { packet } = await f.append(), owned = f.context(), session = await f.authorize(owned);
      const attempts = [], prepare = f.preparer(packet, attempts);
      await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session, context: owned,
        prepare: async attempt => {
          const value = await prepare(attempt);
          await f.editSession(value => ({ ...value, idleUntil: value.idleUntil + 1 })); return value;
        }, refreshSession: async () => ({ ...await f.authorize(owned), [field]: `other-${field}` }) }), error => error.status === 401);
      assert.deepEqual(attempts, [0]); assert.equal(f.checks, 2);
    });
  }

  test(`${kind}: an actual incorrect-guess receipt only reprepares the confirmed HTTP acknowledgement once`, async t => {
    const f = await fixture(t, kind), owned = f.context();
    await f.authorize(owned); const { result, packet } = await f.append(), after = await f.authorize(owned), attempts = [];
    const calls = f.injectAtGate(async index => { if (index === 0) await f.wrongGuess(); });
    const prepared = await prepareCurrentRoomOutput({ sessions: f.sessions, session: after, context: owned, prepare: f.preparer(packet, attempts) });
    const replies = []; if (prepared) replies.push(result);
    assert.deepEqual(attempts, [0, 1]); assert.equal(calls(), 2); assert.equal(f.checks, 2);
    assert.equal(replies.length, 1); assert.equal(replies[0].ack.persisted, true);
    const saved = (await f.storage.read(CANVAS_SCOPE, packet.canvasId)).value;
    assert.equal(saved.sequence, 1); assert.equal(saved.strokes[0].points.length, 2); assert.equal(Object.keys(saved.requests).length, 1);
  });

  test(`${kind}: a presence-only update preserves one confirmed SSE packet and one fresh check`, async t => {
    const f = await fixture(t, kind), { packet } = await f.append(), owned = f.context(), authorized = await f.authorize(owned), attempts = [];
    const calls = f.injectAtGate(async index => {
      if (index !== 0) return;
      const previous = await f.storage.read('room-presence', f.roomId);
      assert.equal(await f.storage.replaceCAS('room-presence', f.roomId, previous.version, {
        ...previous.value, connections: { syntheticSeat: { connection: 9000 } } }), true);
    });
    const prepared = await prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned, prepare: f.preparer(packet, attempts) });
    const frames = []; if (prepared) frames.push(JSON.stringify(prepared.packet));
    assert.deepEqual(attempts, [0, 1]); assert.equal(calls(), 2); assert.equal(f.checks, 1);
    assert.deepEqual(frames, [JSON.stringify(packet)]);
    assert.equal((await f.storage.read(CANVAS_SCOPE, packet.canvasId)).value.sequence, 1);
  });

  for (const change of ['leave', 'next turn', 'boot', 'game type']) {
    test(`${kind}: a conflict followed by ${change} cannot emit the old committed packet`, async t => {
      const f = await fixture(t, kind), { packet } = await f.append();
      // Begin this event one millisecond before the actual reveal deadline, so
      // the old turn changes while its original eight-second context is live.
      if (change === 'next turn') await f.approachNextTurn();
      const owned = f.context(), authorized = await f.authorize(owned), attempts = [];
      f.injectAtGate(async index => {
        if (index !== 0) return;
        if (change === 'leave') await f.action(users[0], 'leave');
        else if (change === 'next turn') await f.nextTurn();
        else { await f.wrongGuess(); if (change === 'boot') await f.reboot(); else await f.replaceGame(); }
      });
      const pending = prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned, prepare: f.preparer(packet, attempts) });
      if (change === 'leave') await assert.rejects(pending, error => error.status === 403 && error.code === 'SEAT_REQUIRED');
      else assert.equal(await pending, null);
      assert.deepEqual(attempts, [0, 1]); assert.equal(f.checks, 1);
      assert.equal((await f.storage.read(CANVAS_SCOPE, packet.canvasId)).value.sequence, 1);
    });
  }

  for (const field of ['csrf', 'accessToken', 'entryKey']) {
    test(`${kind}: ${field} renewed during the initial gate never rebases old output to the new session`, async t => {
      const f = await fixture(t, kind), { packet } = await f.append(), owned = f.context(), authorized = await f.authorize(owned), attempts = [];
      const calls = f.injectAtGate(async index => { if (index === 0) await f.editSession(value => ({ ...value, [field]: `changed-${field}` })); });
      await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned, prepare: f.preparer(packet, attempts) }), ordinaryUnavailable);
      assert.deepEqual(attempts, [0]); assert.equal(calls(), 1, 'post-atomic classification rejects a changed login before another preparation');
      assert.equal(f.checks, 1); assert.equal((await f.storage.read('sessions', authorized.id)).value[field], `changed-${field}`);
      assert.equal((await f.storage.read(CANVAS_SCOPE, packet.canvasId)).value.sequence, 1);
    });
  }

  test(`${kind}: a second completed guard conflict is final and does not commit or prepare a third time`, async t => {
    const f = await fixture(t, kind), { packet } = await f.append(), owned = f.context(), authorized = await f.authorize(owned), attempts = [];
    const calls = f.injectAtGate(() => f.wrongGuess());
    await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned, prepare: f.preparer(packet, attempts) }), OutputGuardConflict);
    assert.deepEqual(attempts, [0, 1]); assert.equal(calls(), 2); assert.equal(f.checks, 1);
    assert.equal((await f.storage.read(CANVAS_SCOPE, packet.canvasId)).value.sequence, 1);
  });

  for (const stop of ['deadline', 'cancel']) {
    test(`${kind}: ${stop} during the first gate cannot start fresh read preparation`, async t => {
      const f = await fixture(t, kind), { packet } = await f.append(), cancellation = new AbortController(), owned = f.context(cancellation.signal);
      const authorized = await f.authorize(owned), attempts = [];
      const calls = f.injectAtGate(async () => { await f.wrongGuess(); if (stop === 'deadline') f.advance(8000); else cancellation.abort(); });
      await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned, prepare: f.preparer(packet, attempts) }), ordinaryUnavailable);
      assert.deepEqual(attempts, [0]); assert.equal(calls(), 1); assert.equal(f.checks, 1);
      assert.equal((await f.storage.read(CANVAS_SCOPE, packet.canvasId)).value.sequence, 1);
    });
  }

  test(`${kind}: a storage fault is propagated once and never treated as a completed false guard`, async t => {
    const f = await fixture(t, kind), { packet } = await f.append(), owned = f.context(), authorized = await f.authorize(owned), attempts = [];
    let calls = 0; const failure = new Error('synthetic storage unavailable');
    f.storage.verifyGuards = async () => { calls++; throw failure; };
    await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned, prepare: f.preparer(packet, attempts) }), error => error === failure);
    assert.deepEqual(attempts, [0]); assert.equal(calls, 1); assert.equal(f.checks, 1);
  });
}

test('an actual SQLite writer lock is not retried and leaves the committed canvas intact', async t => {
  const f = await fixture(t, 'SQLite'), { packet } = await f.append(), other = f.open(), owned = f.context();
  const authorized = await f.authorize(owned), attempts = [];
  other.adapter.db.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned, prepare: f.preparer(packet, attempts) }),
      error => !(error instanceof OutputGuardConflict) && /locked/.test(error.message));
  } finally { other.adapter.db.exec('ROLLBACK'); }
  assert.deepEqual(attempts, [0]); assert.equal(f.checks, 1);
  assert.equal((await f.storage.read(CANVAS_SCOPE, packet.canvasId)).value.sequence, 1);
});

test('cancelling a prepared output does not claim that its still-running preparation finished', async t => {
  const f = await fixture(t, 'Memory'), { packet } = await f.append(), cancellation = new AbortController(), owned = f.context(cancellation.signal);
  const authorized = await f.authorize(owned), entered = deferred(), release = deferred(); let finished = false, attempts = 0;
  const pending = prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned, prepare: async () => {
    attempts++; entered.resolve(); await release.promise; finished = true;
    const current = await f.rooms.getGameContext(f.code, users[0], { includeView: false });
    return { packet, guards: [current.roomGuard, current.presenceGuard] };
  } });
  const rejected = assert.rejects(pending, ordinaryUnavailable);
  await entered.promise; cancellation.abort(); await rejected;
  assert.equal(finished, false); assert.equal(attempts, 1);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, true); assert.equal(attempts, 1); assert.equal(f.checks, 1);
});

test('a prepare error, a missing room guard, and an invalid verifier result cannot become a read-only retry', async t => {
  const f = await fixture(t, 'Memory'), owned = f.context(), authorized = await f.authorize(owned);
  let attempts = 0;
  await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned,
    prepare: async () => { attempts++; throw new OutputGuardConflict(); } }), OutputGuardConflict);
  assert.equal(attempts, 1);
  for (const prepared of [{}, { guards: [] }]) await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned,
    prepare: async () => prepared }), TypeError);
  const current = await f.rooms.getGameContext(f.code, users[0], { includeView: false });
  f.storage.verifyGuards = async () => undefined; attempts = 0;
  await assert.rejects(prepareCurrentRoomOutput({ sessions: f.sessions, session: authorized, context: owned, prepare: async () => {
    attempts++; return { guards: [current.roomGuard, current.presenceGuard] };
  } }), ordinaryUnavailable);
  assert.equal(attempts, 1); assert.equal(f.checks, 1);
});
