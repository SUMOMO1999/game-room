import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createRoomChat } from '../server/chat.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
import { verifyLiveStore, RECOVERY_SCOPES } from '../server/backup.mjs';
import { prepareProduction } from '../server/production.mjs';

const users = [identityKey('urn:synthetic-live-preflight', 'a'), identityKey('urn:synthetic-live-preflight', 'b')];
const SELECT = 'SELECT key,revision,expires_ms,version,payload FROM game_records ORDER BY key';
async function fixture(t, productionClock = false) {
  const directory = await mkdtemp(join(tmpdir(), 'game-live-preflight-')), sourcePath = join(directory, 'live.sqlite');
  const key = randomBytes(32), now = () => productionClock ? Date.now() : 10000;
  const storage = new EncryptedStore(new SQLiteAdapter(sourcePath, { now }), key, now);
  const rooms = createDurableRoomStore({ storage, now, pollIntervalMs: 0, gameOptions: { firstTurnIndex: 0, randomInt: (max) => max - 1 } });
  const chat = createRoomChat({ storage, rooms, now, pollIntervalMs: 0 }); const history = createMatchHistory({ storage, now });
  rooms.setHistory(history); let sequence = 0;
  t.after(async () => { await chat.close(); await rooms.close(); storage.close(); await rm(directory, { recursive: true, force: true }); });
  const host = await rooms.createRoom(users[0], '预检甲', 'live-host');
  await rooms.joinRoom(host.roomCode, users[1], '预检乙', 'live-guest');
  async function action(userKey, type, extra = {}) {
    const view = await rooms.getView(host.roomCode, userKey);
    return rooms.action(host.roomCode, userKey, { type, expectedRevision: view.revision, requestId: `preflight-action-${++sequence}`, ...extra });
  }
  async function capture() {
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    return { rows: storage.adapter.db.prepare(SELECT).all(), metadata: storage.adapter.db.prepare('SELECT name,value FROM game_metadata ORDER BY name').all(),
      mainHash: sha(await readFile(sourcePath)), walHash: sha(await readFile(sourcePath + '-wal')), files: await readdir(directory) };
  }
  return { directory, sourcePath, key, now, storage, rooms, chat, history, host, action, capture };
}

test('live validation reads legacy schema1 without migrating snapshots, renewing timestamps or writing files', async (t) => {
  const f = await fixture(t); const saved = await f.storage.read('rooms', f.host.view.roomId);
  const old = { schemaVersion: 1 };
  for (const key of ['code', 'roomId', 'hostId', 'phase', 'revision', 'players', 'game', 'lastActiveAt']) old[key] = saved.value.snapshot[key];
  await f.storage.replaceCAS('rooms', f.host.view.roomId, saved.version, { ...saved.value, snapshot: old });
  const before = await f.capture(), result = verifyLiveStore({ sourcePath: f.sourcePath, key: f.key });
  assert.equal(result.recordCount, before.rows.length); assert.equal(result.scopes.length, 6);
  assert.deepEqual(await f.capture(), before);
  const afterward = (await f.storage.read('rooms', f.host.view.roomId)).value.snapshot;
  assert.equal(afterward.schemaVersion, 1); assert.equal(afterward.matchId, undefined);
});

test('live validation accepts paused schema2 and all nine business scopes plus encrypted ephemeral rows, exposing only counts', async (t) => {
  const f = await fixture(t);
  await f.action(users[0], 'ready', { ready: true }); await f.action(users[1], 'ready', { ready: true }); await f.action(users[0], 'start');
  await f.action(users[0], 'pause', { agree: true }); await f.action(users[1], 'pause', { agree: true });
  assert.equal((await f.rooms.getView(f.host.roomCode, users[0])).phase, 'paused');
  await f.chat.send(f.host.roomCode, users[0], { text: '合成只读预检聊天', requestId: 'preflight-chat' });
  const saved = (await f.storage.read('rooms', f.host.view.roomId)).value.snapshot;
  await f.history.archive({ matchId: '9'.repeat(32), roomId: saved.roomId, roomCode: saved.code, game: 'rummikub', ruleVersion: 'friends-v2',
    startedAt: 1000, endedAt: f.now(), status: 'completed', reason: 'rack-empty', players: saved.players.map((player, index) => ({
      userKey: player.userKey, seatId: player.id, nickname: player.name, outcome: index ? 'loss' : 'win', remainingPoints: index ? 8 : 0 })) });
  await f.storage.put('sessions', 'synthetic-cookie', { accessToken: 'synthetic-live-secret' }, 20000);
  await f.storage.put('transactions', 'synthetic-pkce', { verifier: 'synthetic-live-verifier' }, 20000);
  const before = await f.capture(), result = verifyLiveStore({ sourcePath: f.sourcePath, key: f.key });
  assert.ok(RECOVERY_SCOPES.every((scope) => result.scopes.includes(scope))); assert.equal(result.counts['game-history'], 1);
  assert.equal(result.counts['history-index'], 2); assert.equal(result.counts.sessions, 1); assert.equal(result.counts.transactions, 1);
  for (const text of [...users, '合成只读预检聊天', 'synthetic-live-secret', 'synthetic-live-verifier', 'payload']) assert.equal(JSON.stringify(result).includes(text), false);
  assert.deepEqual(await f.capture(), before);
});

test('live validation refuses wrong key, unknown scopes and invalid room snapshots without altering any existing record', async (t) => {
  const f = await fixture(t); let before = await f.capture();
  assert.throws(() => verifyLiveStore({ sourcePath: f.sourcePath, key: randomBytes(32) }), /key mismatch/); assert.deepEqual(await f.capture(), before);
  await f.storage.put('unknown-business', 'synthetic', { private: 'unreviewed' }); before = await f.capture();
  assert.throws(() => verifyLiveStore({ sourcePath: f.sourcePath, key: f.key }), /Unrecognized recovery scope/); assert.deepEqual(await f.capture(), before);
  await f.storage.remove('unknown-business', 'synthetic'); const current = await f.storage.read('rooms', f.host.view.roomId);
  current.value.snapshot.phase = 'playing'; current.value.snapshot.game = null;
  await f.storage.replaceCAS('rooms', f.host.view.roomId, current.version, current.value); before = await f.capture();
  assert.throws(() => verifyLiveStore({ sourcePath: f.sourcePath, key: f.key }), /生命周期|保存内容/); assert.deepEqual(await f.capture(), before);
});

test('live validation refuses symlink and relative database paths rather than opening them', async (t) => {
  const f = await fixture(t), link = join(f.directory, 'linked.sqlite'); await symlink(f.sourcePath, link);
  const before = await f.capture();
  assert.throws(() => verifyLiveStore({ sourcePath: link, key: f.key }), /owned regular/);
  assert.throws(() => verifyLiveStore({ sourcePath: 'live.sqlite', key: f.key }), /absolute/);
  assert.deepEqual(await f.capture(), before);
});

test('production preparation rejects damaged business state before serving and leaves the SQLite business rows intact', async (t) => {
  const f = await fixture(t, true);
  await f.storage.put('unreviewed-scope', 'synthetic', { broken: true });
  const before = await f.capture();
  await assert.rejects(prepareProduction({ NODE_ENV: 'production', GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'ownclient12345678',
    GAME_ROOM_STORE_PATH: f.sourcePath, GAME_ROOM_STORE_KEY: f.key.toString('base64url') }), /Unrecognized recovery scope/);
  assert.deepEqual(await f.capture(), before);
  const independent = new DatabaseSync(f.sourcePath, { readOnly: true });
  try { assert.deepEqual(independent.prepare(SELECT).all(), before.rows); } finally { independent.close(); }
});
