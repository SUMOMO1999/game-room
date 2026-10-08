import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore, RoomError } from './rooms.mjs';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey, recordKey } from '../server/storage.mjs';
import { createCanvasService } from '../server/games/draw-and-guess/canvas-service.mjs';

// Synthetic identities and words; snapshots are produced and validated by the
// real game adapters. The subject reads/decrypts a real SQLite database on every
// call, while counters wrap existing adapter methods without replacing rules.
const users = ['owner', 'guest', 'spectator', 'outsider'].map(sub => identityKey('urn:room-authority-test', sub));
const failure = code => error => error instanceof RoomError && error.code === code;
const narrowFields = ['roomId', 'seatId', 'role', 'gameType', 'roomRecord', 'roomGuard', 'presenceGuard', 'invitationGuard',
  'matchId', 'turnId', 'phase', 'roomPhase', 'drawerSeatId', 'deadline', 'paused', 'expiresAt'].sort();
const words = Array.from({ length: 12 }, (_, index) => ({ id: `authority-word-${index + 1}`, answer: `密词${index + 1}`,
  aliases: [`别名${index + 1}`], category: 'daily', categoryName: '日常', difficulty: 'easy', language: 'zh',
  packId: 'authority-pack', packVersion: '1', definitionVersion: 1, source: '原创测试', status: 'reviewed',
  hintLength: [...`密词${index + 1}`].length, tags: [], drawingCue: '不可投影的提示' }));
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }

function fixture(t, options = {}) {
  let time = 1000, nextCode = 120000, sequence = 0;
  const now = () => time, key = randomBytes(32), folder = mkdtempSync(join(tmpdir(), 'room-authority-'));
  const path = join(folder, 'rooms.sqlite'), stores = [], subjects = [], builders = [];
  const counts = { imports: 0, private: 0, spectator: 0, reads: new Map() }, control = { presenceGate: null, privateFailure: false };
  const registry = createGameRegistry(['rummikub', 'army-flip', 'flying-chess', 'draw-and-guess'].map(type => {
    const adapter = defaultGameRegistry.gameAdapter(type);
    return { ...adapter,
      snapshotProblem(...args) { counts.imports++; return adapter.snapshotProblem(...args); },
      privateView(...args) { counts.private++; if (control.privateFailure) throw new Error('synthetic private projection unavailable'); return adapter.privateView(...args); },
      spectatorView(...args) { counts.spectator++; return adapter.spectatorView(...args); },
    };
  }));
  function open() {
    const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now); stores.push(storage); return storage;
  }
  const storage = open();
  const monitored = new Proxy(storage, { get(target, field) {
    if (field === 'read') return async (scope, id) => {
      counts.reads.set(scope, (counts.reads.get(scope) ?? 0) + 1);
      const record = await target.read(scope, id), gate = scope === 'room-presence' ? control.presenceGate : null;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      return record;
    };
    const value = target[field]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  function subject(backing = monitored) {
    const rooms = createDurableRoomStore({ storage: backing, now, pollIntervalMs: 0, gameRegistry: registry, ...options });
    subjects.push(rooms); return rooms;
  }
  const rooms = subject();
  const builderOptions = { now, turnTimeoutMs: 30 * 60 * 1000, serverRandomInt: () => 0,
    gameOptions: { firstTurnIndex: 0, randomInt: max => max - 1, frozenCandidates: words }, ...options };
  async function seed({ gameType = 'draw-and-guess', playing = true, spectators = true } = {}) {
    const code = String(nextCode++), roomId = randomBytes(16).toString('hex');
    const builder = createRoomStore(builderOptions); builders.push(builder);
    builder.createTrustedRoom(users[0], '只有完整视图可见的昵称', { code, roomId, gameType });
    if (playing || spectators) builder.joinTrustedRoom(code, users[1], '猜者昵称');
    if (spectators) builder.joinTrustedRoom(code, users[2], '观众昵称', { role: 'spectator' });
    function act(userKey, type, fields = {}) {
      const view = builder.getTrustedView(code, userKey);
      return builder.trustedAction(code, userKey, { type, requestId: `authority-action-${++sequence}`,
        expectedRevision: view.revision, ...fields });
    }
    if (gameType === 'draw-and-guess') act(users[0], 'configure', { drawConfig: { rounds: 2, drawingSeconds: 120,
      contentSelection: { packId: 'authority-pack', version: 1, categoryIds: ['daily'], difficulties: ['easy'] } } });
    if (playing) {
      act(users[0], 'ready', { ready: true }); act(users[1], 'ready', { ready: true }); act(users[0], 'start');
    }
    await storage.put('room-invites', code, { roomId });
    await storage.put('rooms', roomId, { snapshot: builder.exportSnapshot(code), joins: {} });
    async function save() {
      const before = await storage.read('rooms', roomId);
      assert.equal(await storage.replaceCAS('rooms', roomId, before.version,
        { ...before.value, snapshot: builder.exportSnapshot(code) }), true);
      return storage.read('rooms', roomId);
    }
    return { code, roomId, builder, act, save };
  }
  async function edit(room, change, backing = storage) {
    const before = await backing.read('rooms', room.roomId); change(before.value.snapshot);
    assert.equal(await backing.replaceCAS('rooms', room.roomId, before.version, before.value), true);
    return backing.read('rooms', room.roomId);
  }
  t.after(async () => {
    control.presenceGate?.release.resolve();
    for (const value of subjects) await value.close();
    for (const value of builders) value.close();
    for (const value of stores) value.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return { storage, rooms, counts, control, subject, open, seed, edit, now, setTime(value) { time = value; },
    reset() { counts.imports = counts.private = counts.spectator = 0; counts.reads.clear(); } };
}

test('default full context keeps its original view contract and the narrow context contains authority only', async t => {
  const f = fixture(t), room = await f.seed();
  const before = await f.storage.read('rooms', room.roomId);
  const invitation = await f.storage.read('room-invites', room.code);
  for (const user of users.slice(0, 3)) {
    const full = await f.rooms.getGameContext(room.code, user), explicit = await f.rooms.getGameContext(room.code, user, { includeView: true });
    assert.deepEqual(explicit, full); assert.ok(full.view); assert.equal(Object.hasOwn(full, 'gameType'), false);
    const narrow = await f.rooms.getGameContext(room.code, user, { includeView: false });
    const { view, ...authority } = full;
    assert.deepEqual(narrow, { ...authority, gameType: 'draw-and-guess' });
    assert.deepEqual(Object.keys(narrow).sort(), narrowFields);
    assert.deepEqual(narrow.invitationGuard, { scope: 'room-invites', id: room.code, expectedVersion: invitation.version });
    for (const word of words) assert.equal(JSON.stringify(narrow).includes(word.answer), false);
    for (const field of ['view', 'game', 'members', 'players', 'nickname', 'requests', 'candidates', 'word', 'answer']) {
      assert.equal(Object.hasOwn(narrow, field), false);
    }
    assert.equal(JSON.stringify(narrow).includes('昵称'), false);
  }
  assert.deepEqual(await f.storage.read('rooms', room.roomId), before, 'context reads never renew or rewrite a saved room');
  await assert.rejects(f.rooms.getGameContext(room.code, users[3], { includeView: false }), failure('SEAT_REQUIRED'));
  await assert.rejects(f.rooms.getGameContext(room.code, { userKey: users[0] }, { includeView: false }), failure('INVALID_IDENTITY'));
});

test('the same storage version imports once but every narrow call reads/decrypts room and presence with fresh guards', async t => {
  const f = fixture(t), room = await f.seed(); f.reset();
  const first = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.equal(f.counts.imports, 1); assert.equal(f.counts.private, 1, 'cache miss still checks the real private projection');
  for (let index = 0; index < 12; index++) await f.rooms.getGameContext(room.code, users[index % 3], { includeView: false });
  assert.equal(f.counts.imports, 1); assert.equal(f.counts.private, 1); assert.equal(f.counts.spectator, 0);
  assert.equal(f.counts.reads.get('rooms'), 13); assert.equal(f.counts.reads.get('room-presence'), 13);
  first.roomGuard.expectedVersion = 'caller-mutated'; first.presenceGuard.id = 'caller-mutated'; first.matchId = 'caller-mutated';
  const fresh = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.notEqual(fresh.roomGuard.expectedVersion, first.roomGuard.expectedVersion);
  assert.equal(fresh.presenceGuard.id, room.roomId); assert.equal(fresh.matchId, room.builder.exportSnapshot(room.code).matchId);
  await f.rooms.getGameContext(room.code, users[0]); assert.equal(f.counts.imports, 2);
  assert.equal(f.counts.private, 3, 'full view still validates import and separately projects the actor');
  const oldPresence = fresh.presenceGuard;
  await f.storage.put('room-presence', room.roomId, { schemaVersion: 2, connections: {}, lastSeen: {} });
  const current = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.equal(f.counts.imports, 2); assert.notEqual(current.presenceGuard.expectedVersion, oldPresence.expectedVersion);
  assert.equal(await f.storage.verifyGuards({ guards: [oldPresence] }), false);
});

test('real SQLite second connection changing role and leaving invalidates the cached seat without an identity allowance cache', async t => {
  const f = fixture(t), room = await f.seed({ playing: false }), otherStorage = f.open();
  const other = createDurableRoomStore({ storage: otherStorage, now: f.now, pollIntervalMs: 0 }); t.after(() => other.close());
  const first = await f.rooms.getGameContext(room.code, users[1], { includeView: false });
  const act = async type => {
    const view = await other.getView(room.code, users[1]);
    return other.action(room.code, users[1], { type, requestId: `other-${type}`, expectedRevision: view.revision,
      ...(type === 'set-role' ? { role: 'spectator' } : {}) });
  };
  await act('set-role');
  const changed = await f.rooms.getGameContext(room.code, users[1], { includeView: false });
  assert.equal(changed.seatId, first.seatId); assert.equal(changed.role, 'spectator');
  assert.notEqual(changed.roomRecord.version, first.roomRecord.version);
  assert.equal(await f.storage.verifyGuards({ guards: [first.roomGuard] }), false);
  await act('leave'); await assert.rejects(f.rooms.getGameContext(room.code, users[1], { includeView: false }), failure('SEAT_REQUIRED'));
  const owner = await f.rooms.getGameContext(room.code, users[0], { includeView: false }); assert.equal(owner.role, 'player');
  await other.joinRoom(room.code, users[1], '重新入座', 'other-new-seat', 'player');
  const returned = await f.rooms.getGameContext(room.code, users[1], { includeView: false });
  assert.equal(returned.role, 'player'); assert.notEqual(returned.seatId, first.seatId);
});

test('equal business revision with a new encrypted storage version revalidates and fences the old CAS guard', async t => {
  const f = fixture(t), room = await f.seed(); f.reset();
  const first = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  const before = await f.storage.read('rooms', room.roomId), other = f.open();
  const changed = await f.edit(room, snapshot => { snapshot.lastActiveAt += 10; }, other);
  assert.equal(changed.value.snapshot.revision, before.value.snapshot.revision);
  assert.notEqual(changed.version, before.version);
  const current = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.equal(f.counts.imports, 2); assert.equal(current.expiresAt, first.expiresAt + 10);
  assert.equal(await f.storage.verifyGuards({ guards: [first.roomGuard, first.presenceGuard], validUntil: first.expiresAt }), false);
  assert.equal(await f.storage.verifyGuards({ guards: [current.roomGuard, current.presenceGuard], validUntil: current.expiresAt }), true);
});

test('presence await crossing effective room TTL fails both full and narrow paths, including the paused TTL', async t => {
  const f = fixture(t, { ttlMs: 100, pausedTtlMs: 1000 }), room = await f.seed();
  for (const paused of [false, true]) {
    f.setTime(1000);
    if (paused) { room.act(users[0], 'pause'); room.act(users[1], 'pause'); await room.save(); }
    const record = await f.storage.read('rooms', room.roomId), end = record.value.snapshot.lastActiveAt + (paused ? 1000 : 100);
    for (const includeView of [true, false]) {
      f.setTime(end - 1);
      const gate = { entered: deferred(), release: deferred() }; f.control.presenceGate = gate;
      const pending = f.rooms.getGameContext(room.code, users[0], { includeView });
      const rejected = assert.rejects(pending, failure('ROOM_NOT_FOUND'));
      await gate.entered.promise; f.setTime(end); gate.release.resolve(); await rejected; f.control.presenceGate = null;
    }
    assert.deepEqual(await f.storage.read('rooms', room.roomId), record, 'read-only TTL fence does not persist a synthesized snapshot');
  }
});

test('elapsed drawing deadline remains readable, while actual canvas writes and stale room guards fail closed', async t => {
  const f = fixture(t), room = await f.seed(), chosen = room.builder.getTrustedView(room.code, users[0]);
  room.act(users[0], 'choose', { matchId: chosen.matchId, turnId: chosen.game.turnId, candidateId: chosen.game.candidates[0].id });
  await room.save();
  const before = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  f.setTime(before.deadline);
  const elapsed = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.equal(elapsed.phase, 'drawing'); assert.equal(elapsed.deadline, f.now());
  const canvas = createCanvasService({ storage: f.storage, rooms: f.rooms, now: f.now }); t.after(() => canvas.close());
  const value = await canvas.read(room.code, users[0]); assert.equal(value.stage, 'drawing');
  await assert.rejects(canvas.acquire(room.code, users[0], { deviceId: 'synthetic-device', canvasId: value.canvasId, bootId: value.bootId }),
    error => error.code === 'CANVAS_STAGE_CLOSED');
  assert.equal(await f.storage.compareAndSwapMany({ changes: [{ scope: 'authority-test', id: 'late', expectedVersion: null, value: { saved: true } }],
    guards: [elapsed.roomGuard, elapsed.presenceGuard], validUntil: elapsed.deadline }), false);
  assert.equal(await f.storage.read('authority-test', 'late'), null);
});

test('pause, resume and the next actual question replace authority metadata without leaking candidates', async t => {
  const f = fixture(t), room = await f.seed();
  const choosing = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  f.setTime(f.now() + 1000); room.act(users[0], 'pause'); room.act(users[1], 'pause'); await room.save();
  const paused = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.equal(paused.paused, true); assert.equal(paused.roomPhase, 'paused'); assert.equal(paused.deadline, null);
  assert.ok(paused.expiresAt > choosing.expiresAt);
  f.setTime(f.now() + 30000); room.act(users[1], 'resume'); await room.save();
  const resumed = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.equal(resumed.paused, false); assert.equal(resumed.deadline, f.now() + 14000);
  const full = room.builder.getTrustedView(room.code, users[0]);
  room.act(users[0], 'choose', { matchId: full.matchId, turnId: full.game.turnId, candidateId: full.game.candidates[0].id }); await room.save();
  const drawing = await f.rooms.getGameContext(room.code, users[1], { includeView: false }); assert.equal(drawing.phase, 'drawing');
  room.act(users[1], 'guess', { matchId: full.matchId, turnId: full.game.turnId, text: full.game.candidates[0].answer }); await room.save();
  const reveal = await f.rooms.getGameContext(room.code, users[2], { includeView: false }); assert.equal(reveal.phase, 'reveal');
  f.setTime(reveal.deadline); assert.equal(room.builder.applyTurnTimeout(room.code, room.builder.exportSnapshot(room.code).turnClock), true); await room.save();
  const next = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.notEqual(next.turnId, choosing.turnId); assert.notEqual(next.drawerSeatId, choosing.drawerSeatId); assert.equal(next.phase, 'choosing');
  assert.deepEqual(Object.keys(next).sort(), narrowFields);
  assert.deepEqual(next.invitationGuard, { scope: 'room-invites', id: room.code,
    expectedVersion: (await f.storage.read('room-invites', room.code)).version });
});

test('malformed replacement, private projection failure, absence and broken ciphertext never reuse a previous valid cache', async t => {
  const f = fixture(t), room = await f.seed(); await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  const valid = (await f.storage.read('rooms', room.roomId)).value;
  for (const change of [snapshot => { snapshot.schemaVersion = 999; }, snapshot => { snapshot.players[1].userKey = users[0]; },
    snapshot => { snapshot.players[0].requests = [['malformed']]; }, snapshot => { snapshot.game.stageClock.deadlineAt++; },
    snapshot => { snapshot.code = '654321'; }, snapshot => { snapshot.roomId = 'f'.repeat(32); },
    snapshot => { delete snapshot.roomId; }]) {
    await f.storage.put('rooms', room.roomId, structuredClone(valid)); await f.edit(room, change);
    await assert.rejects(f.rooms.getGameContext(room.code, users[0], { includeView: false }), failure('INVALID_SNAPSHOT'));
  }
  await f.storage.put('rooms', room.roomId, valid); await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  f.control.privateFailure = true; await f.storage.put('rooms', room.roomId, valid);
  await assert.rejects(f.rooms.getGameContext(room.code, users[0], { includeView: false }), failure('INVALID_SNAPSHOT'));
  f.control.privateFailure = false; await f.storage.put('rooms', room.roomId, valid);
  await f.rooms.getGameContext(room.code, users[0], { includeView: false }); const imports = f.counts.imports;
  const id = recordKey('rooms', room.roomId), encoded = await f.storage.adapter.get(id);
  await f.storage.adapter.put(id, { ...encoded, payload: 'AA' });
  await assert.rejects(f.rooms.getGameContext(room.code, users[0], { includeView: false }), failure('ROOM_NOT_FOUND'));
  await f.storage.adapter.put(id, encoded); await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.equal(f.counts.imports, imports + 1, 'restoring an identical version after corruption must validate again');
  await f.storage.remove('rooms', room.roomId); await assert.rejects(f.rooms.getGameContext(room.code, users[0], { includeView: false }), failure('ROOM_NOT_FOUND'));
});

test('legacy default full projection stays compatible while narrow metadata never invents old match identity', async t => {
  const f = fixture(t), room = await f.seed({ gameType: 'rummikub', spectators: false });
  await f.edit(room, snapshot => {
    snapshot.schemaVersion = 2; delete snapshot.gameType; delete snapshot.spectators; delete snapshot.turnClock;
    delete snapshot.matchId; delete snapshot.matchStartedAt; delete snapshot.matchParticipants; delete snapshot.roomId;
  });
  await f.storage.put('room-presence', room.roomId, { schemaVersion: 2, connections: {}, lastSeen: {} });
  const full = await f.rooms.getGameContext(room.code, users[0]);
  assert.ok(full.view.game.rack.length); assert.equal(full.matchId, null); assert.match(full.view.matchId, /^[a-f0-9]{32}$/);
  const narrow = await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.equal(narrow.matchId, null); assert.equal(narrow.gameType, 'rummikub');
  const presence = await f.storage.read('room-presence', room.roomId);
  assert.equal(narrow.presenceGuard.id, room.roomId); assert.equal(narrow.presenceGuard.expectedVersion, presence.version);
  assert.equal((await f.storage.read('rooms', room.roomId)).value.snapshot.matchId, undefined);
  const army = await f.seed({ gameType: 'army-flip', playing: false, spectators: false });
  await f.edit(army, snapshot => { snapshot.schemaVersion = 3; delete snapshot.spectators; delete snapshot.turnClock; });
  const armyContext = await f.rooms.getGameContext(army.code, users[0], { includeView: false });
  assert.equal(armyContext.gameType, 'army-flip'); assert.equal(armyContext.matchId, null);
});

test('a warm room cache cannot authorize an alias invitation or wrong snapshot binding', async t => {
  const f = fixture(t), room = await f.seed();
  await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  await f.storage.put('room-invites', '654321', { roomId: room.roomId });
  await assert.rejects(f.rooms.getGameContext('654321', users[0], { includeView: false }), failure('INVALID_SNAPSHOT'));
  assert.equal((await f.rooms.getGameContext(room.code, users[0], { includeView: false })).roomId, room.roomId);
});

test('all existing game adapters retain their full context authority contract through the opt-in narrow path', async t => {
  const f = fixture(t);
  for (const gameType of ['rummikub', 'army-flip', 'flying-chess', 'draw-and-guess']) {
    const room = await f.seed({ gameType });
    const { view, ...full } = await f.rooms.getGameContext(room.code, users[0]);
    assert.equal(view.gameType, gameType);
    assert.deepEqual(await f.rooms.getGameContext(room.code, users[0], { includeView: false }), { ...full, gameType });
  }
});

test('close while a cached context waits for presence never returns authority from the closed store', async t => {
  const f = fixture(t), room = await f.seed();
  await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  const gate = { entered: deferred(), release: deferred() }; f.control.presenceGate = gate;
  const pending = f.rooms.getGameContext(room.code, users[0], { includeView: false });
  const rejected = assert.rejects(pending, failure('STORE_CLOSED'));
  await gate.entered.promise; await f.rooms.close(); gate.release.resolve(); await rejected; f.control.presenceGate = null;
});

test('authority validation cache is LRU-bounded to sixty-four rooms, isolated per store, and unusable after close', async t => {
  const f = fixture(t), rooms = [];
  for (let index = 0; index < 65; index++) rooms.push(await f.seed({ gameType: 'rummikub', playing: false, spectators: false }));
  f.reset();
  for (const room of rooms.slice(0, 64)) await f.rooms.getGameContext(room.code, users[0], { includeView: false });
  assert.equal(f.counts.imports, 64);
  await f.rooms.getGameContext(rooms[0].code, users[0], { includeView: false });
  await f.rooms.getGameContext(rooms[64].code, users[0], { includeView: false }); assert.equal(f.counts.imports, 65);
  await f.rooms.getGameContext(rooms[0].code, users[0], { includeView: false }); assert.equal(f.counts.imports, 65);
  await f.rooms.getGameContext(rooms[1].code, users[0], { includeView: false }); assert.equal(f.counts.imports, 66, 'least recently used room was evicted');
  const separate = f.subject(f.open()); await separate.getGameContext(rooms[0].code, users[0], { includeView: false });
  assert.equal(f.counts.imports, 67, 'another store validates the identical storage version independently');
  await f.rooms.close(); await assert.rejects(f.rooms.getGameContext(rooms[0].code, users[0], { includeView: false }), failure('STORE_CLOSED'));
  const fresh = f.subject(); await fresh.getGameContext(rooms[0].code, users[0], { includeView: false }); assert.equal(f.counts.imports, 68);
});
