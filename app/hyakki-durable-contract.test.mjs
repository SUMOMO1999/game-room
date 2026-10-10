import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createGameRegistry } from './game-registry.mjs';
import { createHyakkiContractAdapter, createHyakkiContractPreparers } from './games/hyakki-trading/test-support/contract-adapter.mjs';
import { createHyakkiEventStore, HYAKKI_EVENT_FINISH_RESERVE_BYTES } from '../server/games/hyakki-trading/event-store.mjs';
import { backupStore, restoreStore, verifyLiveStore } from '../server/backup.mjs';
import { ABSENCE_MS, PAUSE_MS } from './games/hyakki-trading/lifecycle.mjs';
const users = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
let sequence = 0;
async function fixture(t, { capacityBytes, maxSnapshotBytes, roomOptions = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hyakki-s1-')), key = randomBytes(32), path = join(directory, 'source.sqlite'), opened = [];
  let at = 10000;
  const now = () => at, gameRegistry = createGameRegistry([createHyakkiContractAdapter({ maxSnapshotBytes })]);
  function open() {
    const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
    const rooms = createDurableRoomStore({ storage, now, gameRegistry, pollIntervalMs: 0, presenceTtlMs: 1000,
      transitionPreparers: createHyakkiContractPreparers(storage, { now, capacityBytes }), ...roomOptions });
    const item = { storage, rooms }; opened.push(item); return item;
  }
  const first = open();
  t.after(async () => { for (const item of opened) { await item.rooms.close(); item.storage.close(); } await rm(directory, { recursive: true, force: true }); });
  const act = async (rooms, code, index, type, extra = {}) => rooms.action(code, users[index], { type,
    requestId: `hyakki-s1-${++sequence}`, expectedRevision: (await rooms.getView(code, users[index])).revision, ...extra });
  async function start() {
    const host = await first.rooms.createRoom(users[0], '甲', `create-${++sequence}`, 'hyakki-trading');
    await first.rooms.joinRoom(host.roomCode, users[1], '乙', `join-${++sequence}`);
    const disconnect = [];
    for (const user of users.slice(0, 2)) disconnect.push(await first.rooms.subscribe(host.roomCode, user, () => {}));
    for (let index = 0; index < 2; index++) await act(first.rooms, host.roomCode, index, 'ready', { ready: true });
    return { view: (await act(first.rooms, host.roomCode, 0, 'start')).view, disconnect };
  }
  return { ...first, directory, key, path, now, gameRegistry, act, start, open, advance: ms => { at += ms; } };
}

test('real non-point room commits exactly one event under device races, private candidate remains owner-only', async t => {
  const f = await fixture(t), { view } = await f.start(), peer = f.open();
  const input = { type: 'probe-response', requestId: 'same-device-intent', expectedRevision: view.revision };
  const replies = await Promise.all([f.rooms.action(view.roomCode, users[0], input), peer.rooms.action(view.roomCode, users[0], input)]);
  assert.equal(replies.length, 2);
  const record = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(record.game.players[0].silver, 18); assert.equal(record.game.publicEventSequence, 2);
  assert.equal((await f.storage.scan('hyakki-events')).length, 2);
  const own = await f.rooms.getView(view.roomCode, users[1]), other = await f.rooms.getView(view.roomCode, users[0]);
  assert.ok(own.game.pending.candidate); assert.equal(other.game.pending.candidate, undefined);
  const spectator = await f.rooms.joinRoom(view.roomCode, users[2], '观众', 'observe', 'spectator');
  assert.equal(spectator.view.game.pending.candidate, undefined); assert.equal(spectator.view.game.hand, undefined);
  const page = await createHyakkiEventStore({ storage: f.storage, now: f.now }).readPage({ matchId: view.matchId });
  assert.doesNotMatch(JSON.stringify(page.page), /candidate|userKey|hand|#01/);
  const intent = { type: 'probe-resolve', expectedRevision: (await f.rooms.getView(view.roomCode, users[1])).revision };
  const results = await Promise.allSettled(['resolve-a', 'resolve-b'].map((requestId, index) =>
    [f.rooms, peer.rooms][index].action(view.roomCode, users[1], { ...intent, requestId })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const after = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(after.game.players[1].hand.length, 6); assert.equal(after.game.publicEventSequence, 3);
  assert.equal(after.game.players[0].silver, 18);
});

test('capacity rejects the original action then uses bounded suspension and terminal reserves without creating points', async t => {
  const capacityBytes = HYAKKI_EVENT_FINISH_RESERVE_BYTES + 5000;
  const f = await fixture(t, { capacityBytes }), { view, disconnect } = await f.start();
  let rejected = false, before;
  for (let attempt = 0; attempt < 50; attempt++) {
    before = (await f.storage.read('rooms', view.roomId)).value.snapshot;
    try { await f.act(f.rooms, view.roomCode, 0, 'probe-step'); }
    catch (error) { assert.equal(error.code, 'GAME_HISTORY_CAPACITY'); rejected = true; break; }
  }
  assert.equal(rejected, true);
  let saved = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(saved.phase, 'paused'); assert.equal(saved.game.lifecycle.capacity, true);
  assert.equal(saved.game.publicEventSequence, before.game.publicEventSequence + 1);
  assert.deepEqual(saved.game.players, before.game.players);
  await disconnect[1](); // absence must still persist even when public normal budget is full
  saved = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.ok(saved.game.lifecycle.absence);
  await assert.rejects(f.rooms.applyLifecycle(view.roomCode, { matchId: view.matchId, reason: 'capacity-cleared' }), { code: 'GAME_HISTORY_CAPACITY' });
  await f.act(f.rooms, view.roomCode, 0, 'leave');
  saved = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(saved.phase, 'finished'); assert.deepEqual(saved.game.result.winnerIds, [view.players[1].id]);
  assert.deepEqual(saved.pendingRecords[0].players.map(player => player.outcome), ['loss', 'win']);
  assert.equal((await f.storage.read('hyakki-event-meta', 'quota')).value.reservedBytes, 0);
  assert.equal((await f.storage.scan('game-score-ledger')).length, 0);
});

test('manual pause survives short generic retention and recovery retains paid response and original clocks', async t => {
  const f = await fixture(t), { view } = await f.start();
  await f.act(f.rooms, view.roomCode, 0, 'probe-response'); f.advance(100);
  await f.act(f.rooms, view.roomCode, 0, 'pause'); await f.act(f.rooms, view.roomCode, 1, 'pause');
  const paused = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(paused.game.lifecycle.manual.deadlineAt, f.now() + PAUSE_MS);
  await f.rooms.close(); f.advance(24 * 60 * 60 * 1000);
  const recovered = f.open(), restored = await recovered.rooms.getView(view.roomCode, users[1]);
  assert.equal(restored.phase, 'paused');
  const saved = (await recovered.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(saved.game.lifecycle.manual.deadlineAt, paused.game.lifecycle.manual.deadlineAt);
  assert.deepEqual(saved.game.pending, paused.game.pending); assert.deepEqual(saved.game.timing, paused.game.timing);
});

test('first capacity failure during absence reconciliation still persists suspension at the actual lease expiry', async t => {
  const f = await fixture(t, { capacityBytes: HYAKKI_EVENT_FINISH_RESERVE_BYTES + 1600 }), { view } = await f.start();
  f.advance(5000);
  const restored = f.open(); await restored.rooms.ready;
  const saved = (await restored.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(saved.phase, 'paused'); assert.equal(saved.game.lifecycle.capacity, true);
  assert.equal(saved.game.lifecycle.absence.startedAt, 11000);
  assert.equal(saved.game.timing.active.remainingMs, 30 * 60 * 1000 - 1000);
  assert.equal(saved.game.publicEventSequence, 2);
  assert.equal((await restored.storage.read('hyakki-event-meta', `match:${view.matchId}`)).value.phase, 'capacity-suspended');
});

test('generic TTL atomically stores terminal history and releases reserve when a capacity-held room becomes a tombstone', async t => {
  const f = await fixture(t, { capacityBytes: HYAKKI_EVENT_FINISH_RESERVE_BYTES + 2000,
    roomOptions: { pausedTtlMs: 1000, presenceTtlMs: 100000 } }), { view } = await f.start();
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await f.act(f.rooms, view.roomCode, 0, 'probe-step'); }
    catch (error) { assert.equal(error.code, 'GAME_HISTORY_CAPACITY'); break; }
  }
  const held = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  assert.equal(held.game.lifecycle.capacity, true); assert.equal(held.game.lifecycle.absence, null);
  f.advance(2000);
  await assert.rejects(f.rooms.getView(view.roomCode, users[0]), { code: 'ROOM_NOT_FOUND' });
  const tombstone = (await f.storage.read('rooms', view.roomId)).value;
  assert.equal(tombstone.snapshot, null); assert.equal(tombstone.pendingRecords[0].reason, 'room-expired');
  const head = (await f.storage.read('hyakki-event-meta', `match:${view.matchId}`)).value;
  assert.equal(head.phase, 'terminal'); assert.equal(head.sequence, held.game.publicEventSequence + 1);
  assert.equal((await f.storage.read('hyakki-event-meta', 'quota')).value.reservedBytes, 0);
  assert.doesNotThrow(() => verifyLiveStore({ sourcePath: f.path, key: f.key, gameRegistry: f.gameRegistry, now: f.now }));
});

test('non-point maximum snapshot bound rejects start without creating event or changing waiting room', async t => {
  const f = await fixture(t, { maxSnapshotBytes: 4000 });
  await assert.rejects(f.start(), { code: 'ROOM_STATE_LIMIT' });
  const records = await f.storage.scan('rooms'); assert.equal(records[0].value.snapshot.phase, 'waiting');
  assert.equal((await f.storage.scan('hyakki-events')).length, 0);
});

test('all 110 cards in one private hand and eight observers stay bounded and hidden through the actual projection path', async t => {
  const f = await fixture(t), { view } = await f.start();
  const saved = await f.storage.read('rooms', view.roomId), game = saved.value.snapshot.game;
  // Deliberately extreme synthetic material distribution, not a legal game move.
  game.players[0].hand.push(...game.deck, ...game.players[1].hand);
  game.deck = []; game.players[1].hand = [];
  assert.equal(await f.storage.replaceCAS('rooms', view.roomId, saved.version, saved.value), true);
  for (let index = 0; index < 8; index++) {
    const user = (index + 100).toString(16).padStart(64, '0');
    const observer = await f.rooms.joinRoom(view.roomCode, user, `观众${index}`, `dense-observer-${index}`, 'spectator');
    assert.equal(observer.view.game.hand, undefined);
    assert.doesNotMatch(JSON.stringify(observer.view.game), /definitionId|#01/);
  }
  const own = await f.act(f.rooms, view.roomCode, 0, 'probe-step');
  assert.equal(own.view.game.hand.length, 110);
  const snapshot = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot)), privateViewBytes = Buffer.byteLength(JSON.stringify(own.view));
  assert.ok(snapshotBytes < 256 * 1024); assert.ok(privateViewBytes < 256 * 1024);
  t.diagnostic(JSON.stringify({ denseSnapshotBytes: snapshotBytes, densePrivateViewBytes: privateViewBytes, cards: 110, observers: 8 }));
});

function child(mode, path, keyPath, at, code) {
  const proc = fork(new URL('../scripts/hyakki-recovery-child.mjs', import.meta.url), [mode, path, keyPath, String(at), code ?? ''],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; proc.stderr.on('data', chunk => { errors += chunk; });
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`Recovery child timed out: ${errors}`)); }, 15000);
    proc.once('message', result => { clearTimeout(timer); result.error ? reject(new Error(result.error)) : resolve(result); });
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('exit', code => { if (code) { clearTimeout(timer); reject(new Error(`Recovery child exited ${code}: ${errors}`)); } });
  });
  return { proc, message };
}
test('SIGKILL then encrypted backup to a new path and process preserves candidate, paid cost and original absence deadline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hyakki-crash-')), key = randomBytes(32), keyPath = join(directory, 'synthetic.key');
  const source = join(directory, 'source.sqlite'), backup = join(directory, 'backup.sqlite'), restoredPath = join(directory, 'restored.sqlite');
  const processes = [];
  t.after(async () => { for (const proc of processes) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); });
  await writeFile(keyPath, key, { mode: 0o600 });
  const producer = child('create', source, keyPath, 10000); processes.push(producer.proc);
  const original = await producer.message; const stopped = once(producer.proc, 'exit'); producer.proc.kill('SIGKILL'); await stopped;
  const gameRegistry = createGameRegistry([createHyakkiContractAdapter()]);
  await backupStore({ sourcePath: source, destinationPath: backup, key, now: () => 200000, gameRegistry });
  restoreStore({ sourcePath: backup, destinationPath: restoredPath, key, offline: true, now: () => 200000, gameRegistry });
  const fresh = child('recover', restoredPath, keyPath, 200000, original.roomCode); processes.push(fresh.proc);
  const recovered = await fresh.message;
  assert.equal(recovered.sessions, 0); assert.equal(recovered.presence, 0);
  assert.equal(recovered.snapshot.phase, 'paused');
  assert.deepEqual(recovered.snapshot.game.pending, original.snapshot.game.pending);
  assert.deepEqual(recovered.snapshot.game.players, original.snapshot.game.players);
  assert.equal(recovered.snapshot.game.lifecycle.absence.deadlineAt, 11000 + ABSENCE_MS);
  assert.equal(recovered.snapshot.game.timing.decision.remainingMs, 59000);
  const freshExit = once(fresh.proc, 'exit'); await freshExit;
  const again = child('recover', restoredPath, keyPath, 400000, original.roomCode); processes.push(again.proc);
  const repeated = await again.message;
  assert.equal(repeated.snapshot.game.lifecycle.absence.deadlineAt, recovered.snapshot.game.lifecycle.absence.deadlineAt);
  assert.deepEqual(repeated.snapshot.game.timing, recovered.snapshot.game.timing);
  await once(again.proc, 'exit');
});
