import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
import { backupStore, restoreStore, verifyLiveStore } from '../server/backup.mjs';
import { defaultJokerConfig } from './rules.mjs';

const users = [identityKey('urn:synthetic-history-durable', 'a'), identityKey('urn:synthetic-history-durable', 'b')];
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'game-history-durable-')), path = join(directory, 'test.sqlite'), key = randomBytes(32);
  let time = 10000, sequence = 0; const now = () => time, opened = [];
  function open(storePath = path) {
    const storage = new EncryptedStore(new SQLiteAdapter(storePath, { now }), key, now);
    const rooms = createDurableRoomStore({ storage, now, pollIntervalMs: 0, gameOptions: { firstTurnIndex: 0, randomInt: (max) => max - 1 }, ...overrides });
    const history = createMatchHistory({ storage, now }); rooms.setHistory(history);
    const entry = { storage, rooms, history }; opened.push(entry); return entry;
  }
  t.after(async () => { for (const entry of opened) { await entry.rooms.close(); entry.storage.close(); } await rm(directory, { recursive: true, force: true }); });
  async function action(rooms, code, userKey, type, extra = {}) {
    const view = await rooms.getView(code, userKey);
    return rooms.action(code, userKey, { type, requestId: `history-action-${++sequence}`, expectedRevision: view.revision, ...extra });
  }
  async function start(entry, { jokerConfig } = {}) {
    const host = await entry.rooms.createRoom(users[0], '同名', `history-create-${++sequence}`);
    await entry.rooms.joinRoom(host.roomCode, users[1], '同名', `history-join-${++sequence}`);
    if (jokerConfig) await action(entry.rooms, host.roomCode, users[0], 'configure', { jokerConfig });
    await action(entry.rooms, host.roomCode, users[0], 'ready', { ready: true });
    await action(entry.rooms, host.roomCode, users[1], 'ready', { ready: true });
    await action(entry.rooms, host.roomCode, users[0], 'start'); return host;
  }
  async function complete(entry, host) {
    for (let index = 0; index < 110; index++) {
      const view = await entry.rooms.getView(host.roomCode, users[0]); if (view.phase === 'finished') return view;
      const userKey = view.game.turnPlayerId === host.playerId ? users[0] : users[1];
      await action(entry.rooms, host.roomCode, userKey, view.game.poolCount ? 'draw' : 'pass');
    }
    assert.fail('Synthetic match did not complete within one deck and final passes');
  }
  return { directory, path, key, now, open, action, start, complete, advance: (ms) => { time += ms; } };
}

test('a real configured friends-v4 completion and outbox survive validation, backup and archival recovery once', async t => {
  const f = await fixture(t), source = f.open(), host = await f.start(source, { jokerConfig: defaultJokerConfig(2) });
  assert.equal((await source.rooms.getView(host.roomCode, users[0])).game.ruleVersion, 'friends-v4');
  source.rooms.setHistory({ archive: async () => { throw new Error('synthetic archival pause'); } });
  const finished = await f.complete(source, host);
  assert.equal(finished.phase, 'finished');
  const before = (await source.storage.read('rooms', host.view.roomId)).value.snapshot;
  assert.equal(before.pendingRecords.length, 1);
  assert.equal(before.pendingRecords[0].ruleVersion, 'friends-v4');
  assert.doesNotThrow(() => verifyLiveStore({ sourcePath: f.path, key: f.key }));
  const backup = join(f.directory, 'configured-v4-backup.sqlite'), restoredPath = join(f.directory, 'configured-v4-restored.sqlite');
  await backupStore({ sourcePath: f.path, destinationPath: backup, key: f.key, now: f.now });
  restoreStore({ sourcePath: backup, destinationPath: restoredPath, key: f.key, offline: true });
  const recovered = f.open(restoredPath);
  await recovered.rooms.flushPendingRecords(); await recovered.rooms.flushPendingRecords();
  const record = await recovered.history.get(users[0]);
  assert.equal(record.stats.completed, 1); assert.equal(record.items.length, 1);
  assert.equal(record.items[0].ruleVersion, 'friends-v4');
  assert.equal(record.items[0].self.remainingPoints, finished.game.result.scores.find(s => s.playerId === host.playerId).points);
  assert.deepEqual((await recovered.storage.read('rooms', host.view.roomId)).value.snapshot.pendingRecords, []);
  assert.deepEqual((await source.storage.read('rooms', host.view.roomId)).value.snapshot.pendingRecords, before.pendingRecords);
});

test('normal durable completion archives native scores once; leaving the result screen and rematching do not add a win', async (t) => {
  const f = await fixture(t), entry = f.open(), host = await f.start(entry);
  const initial = (await entry.storage.read('rooms', host.view.roomId)).value.snapshot;
  assert.match(initial.matchId, /^[a-f0-9]{32}$/); assert.equal(initial.matchStartedAt, f.now());
  const finished = await f.complete(entry, host);
  const packet = await entry.history.get(users[0]); assert.equal(packet.stats.completed, 1); assert.equal(packet.items[0].matchId, initial.matchId);
  assert.equal(packet.items[0].self.remainingPoints, finished.game.result.scores.find((score) => score.playerId === host.playerId).points);
  assert.deepEqual((await entry.storage.read('rooms', host.view.roomId)).value.snapshot.pendingRecords, []);
  await entry.rooms.flushPendingRecords(); await f.action(entry.rooms, host.roomCode, users[0], 'rematch');
  assert.equal((await entry.history.get(users[0])).stats.completed, 1);
  await f.action(entry.rooms, host.roomCode, users[0], 'ready', { ready: true }); await f.action(entry.rooms, host.roomCode, users[1], 'ready', { ready: true });
  await f.action(entry.rooms, host.roomCode, users[0], 'start');
  assert.notEqual((await entry.storage.read('rooms', host.view.roomId)).value.snapshot.matchId, initial.matchId);
});

test('active departure records one unscored end for original participants, while the former player loses room access', async (t) => {
  const f = await fixture(t), entry = f.open(), host = await f.start(entry);
  await f.action(entry.rooms, host.roomCode, users[0], 'leave');
  await assert.rejects(entry.rooms.getView(host.roomCode, users[0]), (error) => error.code === 'SEAT_REQUIRED');
  const first = await entry.history.get(users[0]), second = await entry.history.get(users[1]);
  assert.equal(first.items[0].status, 'aborted'); assert.equal(first.items[0].reason, 'player-left');
  assert.equal(first.stats.completed, 0); assert.equal(first.stats.losses, 0); assert.equal(first.stats.aborted, 1);
  assert.equal(second.items[0].players.length, 2);
  await f.action(entry.rooms, host.roomCode, users[1], 'leave');
  await entry.rooms.flushPendingRecords(); assert.equal((await entry.history.get(users[0])).items.length, 1);
  assert.equal((await entry.storage.scan('game-history')).length, 1);
});

test('failed archival keeps completion outbox in the same committed room, and a restored service repairs it exactly once', async (t) => {
  const f = await fixture(t), entry = f.open(), host = await f.start(entry);
  entry.rooms.setHistory({ archive: async () => { throw new Error('synthetic history outage'); } });
  const finished = await f.complete(entry, host); assert.equal(finished.phase, 'finished');
  const saved = (await entry.storage.read('rooms', host.view.roomId)).value.snapshot;
  assert.equal(saved.pendingRecords.length, 1); assert.equal(saved.pendingRecords[0].matchId, saved.matchId);
  assert.equal((await entry.history.get(users[0])).stats.completed, 0);
  const backup = join(f.directory, 'outbox.sqlite'), restoredPath = join(f.directory, 'restored.sqlite');
  await backupStore({ sourcePath: f.path, destinationPath: backup, key: f.key, now: f.now });
  restoreStore({ sourcePath: backup, destinationPath: restoredPath, key: f.key, offline: true });
  const restarted = f.open(restoredPath); await restarted.rooms.flushPendingRecords(); await restarted.rooms.flushPendingRecords();
  assert.equal((await restarted.history.get(users[0])).stats.completed, 1);
  assert.deepEqual((await restarted.storage.read('rooms', host.view.roomId)).value.snapshot.pendingRecords, []);
  assert.equal((await restarted.storage.scan('game-history')).length, 1);
});

test('expired running room retains original participants as an unscored end, with no win or loss', async (t) => {
  const f = await fixture(t, { ttlMs: 100 }), entry = f.open(), host = await f.start(entry);
  f.advance(101); await entry.rooms.sweep();
  const records = await entry.history.get(users[0]); assert.equal(records.stats.aborted, 1); assert.equal(records.stats.completed, 0);
  assert.equal(records.items[0].reason, 'expired');
  await assert.rejects(entry.rooms.getView(host.roomCode, users[0]), (error) => error.code === 'ROOM_NOT_FOUND');
});
