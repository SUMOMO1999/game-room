import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, SQLiteAdapter, MemoryAdapter, identityKey, recordKey } from '../server/storage.mjs';
import { backupStore, restoreStore, verifyBackup, RECOVERY_SCOPES } from '../server/backup.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'game-backup-test-'));
  const path = join(directory, 'live.sqlite'), backup = join(directory, 'backup.sqlite'), restored = join(directory, 'restored.sqlite');
  const key = randomBytes(32), now = () => 10000;
  const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
  const opened = [storage];
  t.after(() => { for (const store of opened) try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, backup, restored, key, now, storage, opened };
}
const member = identityKey('https://synthetic.example/pool', 'member');
const other = identityKey('https://synthetic.example/pool', 'other');
async function profile(f) { await f.storage.put('game-profiles', member, { userKey: member, nickname: '合成昵称', createdAt: 10000 }); }

test('stable key guard rejects a wrong key even for an empty established database', async (t) => {
  const f = fixture(t);
  assert.throws(() => new EncryptedStore(new SQLiteAdapter(f.path), randomBytes(32)), /refusing to start/);
  assert.equal(f.storage.adapter.db.prepare('SELECT count(*) AS n FROM game_records').get().n, 0);
  await profile(f);
  const reopened = new EncryptedStore(new SQLiteAdapter(f.path), f.key, f.now); f.opened.push(reopened);
  assert.equal((await reopened.get('game-profiles', member)).nickname, '合成昵称');
});

test('legacy database adopts its guard only after every existing ciphertext decrypts', async (t) => {
  const f = fixture(t);
  const legacy = join(f.directory, 'legacy.sqlite');
  const encoder = new EncryptedStore(new MemoryAdapter(), f.key, f.now);
  const value = encoder.encode('game-profiles', member, { userKey: member, nickname: '旧昵称' }, Number.MAX_SAFE_INTEGER);
  const adapter = new SQLiteAdapter(legacy); await adapter.put(recordKey('game-profiles', member), value); adapter.close();
  assert.throws(() => new EncryptedStore(new SQLiteAdapter(legacy), randomBytes(32), f.now), /refusing to start/);
  const recovered = new EncryptedStore(new SQLiteAdapter(legacy), f.key, f.now); f.opened.push(recovered);
  assert.equal((await recovered.get('game-profiles', member)).nickname, '旧昵称');
});

test('database and WAL files use owner-only permissions; symlink databases are refused', (t) => {
  const f = fixture(t);
  for (const path of [f.path, `${f.path}-wal`, `${f.path}-shm`]) if (existsSync(path)) assert.equal(statSync(path).mode & 0o777, 0o600);
  const linked = join(f.directory, 'linked.sqlite'); symlinkSync(f.path, linked);
  assert.throws(() => new SQLiteAdapter(linked), /owned regular file/);
});

test('online backup captures committed WAL data and delivers only encrypted business namespaces', async (t) => {
  const f = fixture(t);
  f.storage.adapter.db.exec('PRAGMA wal_autocheckpoint=0');
  await profile(f);
  await f.storage.put('sessions', 'old-cookie', { accessToken: 'synthetic-private-token' }, 20000);
  await f.storage.put('transactions', 'old-login', { verifier: 'synthetic-private-verifier' }, 20000);
  await f.storage.put('room-presence', 'room', { active: true }, 20000);
  const report = await backupStore({ sourcePath: f.path, destinationPath: f.backup, key: f.key, now: f.now });
  assert.equal(report.excludedRecords, 3); assert.equal(report.recordCount, 1); assert.equal(report.authSessionsIncluded, false);
  assert.equal(statSync(f.backup).mode & 0o777, 0o600);
  const verified = verifyBackup({ sourcePath: f.backup, key: f.key });
  assert.equal(verified.rows.length, 1); assert.ok(verified.rows.every((row) => RECOVERY_SCOPES.includes(row.key.split(':')[0])));
  const bytes = readFileSync(f.backup);
  for (const text of ['合成昵称', member, 'synthetic-private-token', 'synthetic-private-verifier', 'sessions:', 'transactions:', 'room-presence:']) assert.equal(bytes.includes(Buffer.from(text)), false);
  const result = restoreStore({ sourcePath: f.backup, destinationPath: f.restored, key: f.key, offline: true });
  assert.equal(result.authSessionsRestored, false);
  const recovered = new EncryptedStore(new SQLiteAdapter(f.restored), f.key, f.now); f.opened.push(recovered);
  assert.equal((await recovered.get('game-profiles', member)).nickname, '合成昵称');
  assert.equal(await recovered.get('sessions', 'old-cookie'), null);
  assert.equal(await recovered.get('transactions', 'old-login'), null);
});

test('backup and offline restore refuse source/target reuse or existing files without altering them', async (t) => {
  const f = fixture(t); await profile(f);
  await assert.rejects(backupStore({ sourcePath: f.path, destinationPath: f.path, key: f.key }), /different absolute/);
  writeFileSync(f.backup, 'preserve-existing');
  await assert.rejects(backupStore({ sourcePath: f.path, destinationPath: f.backup, key: f.key }), /already exists/);
  assert.equal(readFileSync(f.backup, 'utf8'), 'preserve-existing');
  assert.throws(() => restoreStore({ sourcePath: f.path, destinationPath: f.restored, key: f.key }), /offline confirmation/);
  assert.equal(existsSync(f.restored), false);
});

test('wrong key, ciphertext damage, and deleted records invalidate recovery before any target is published', async (t) => {
  const f = fixture(t); await profile(f);
  await assert.rejects(backupStore({ sourcePath: f.path, destinationPath: f.backup, key: randomBytes(32) }), /key mismatch/);
  assert.equal(existsSync(f.backup), false);
  await backupStore({ sourcePath: f.path, destinationPath: f.backup, key: f.key });
  assert.throws(() => restoreStore({ sourcePath: f.backup, destinationPath: f.restored, key: randomBytes(32), offline: true }), /key mismatch/);
  const db = new DatabaseSync(f.backup);
  db.exec('DELETE FROM game_records'); db.close();
  assert.throws(() => restoreStore({ sourcePath: f.backup, destinationPath: f.restored, key: f.key, offline: true }), /manifest verification/);
  assert.equal(existsSync(f.restored), false);
  f.storage.adapter.db.exec("UPDATE game_records SET payload='AAAA'");
  await assert.rejects(backupStore({ sourcePath: f.path, destinationPath: join(f.directory, 'damaged.sqlite'), key: f.key }), /Invalid encrypted/);
  assert.throws(() => new EncryptedStore(new SQLiteAdapter(f.path), f.key), /refusing to start/);
});

test('corrupt SQLite and unknown namespaces fail recovery rather than silently omitting data', async (t) => {
  const f = fixture(t);
  await f.storage.put('new-unreviewed-scope', 'value', { secret: true });
  await assert.rejects(backupStore({ sourcePath: f.path, destinationPath: f.backup, key: f.key }), /Unrecognized recovery scope/);
  const corrupt = join(f.directory, 'corrupt.sqlite'); writeFileSync(corrupt, 'broken-sqlite-file');
  assert.throws(() => restoreStore({ sourcePath: corrupt, destinationPath: f.restored, key: f.key, offline: true }));
  assert.equal(existsSync(f.restored), false);
});

test('backup/verify/restore command line uses an owner-only key file and never emits credentials', async (t) => {
  const f = fixture(t); await profile(f);
  const keyPath = join(f.directory, 'server.key');
  writeFileSync(keyPath, f.key.toString('base64url'), { mode: 0o600 });
  const env = { ...process.env, GAME_ROOM_STORE_KEY: '', GAME_ROOM_STORE_KEY_FILE: keyPath, GAME_ROOM_STORE_PATH: f.path };
  function run(script, args) {
    const output = spawnSync(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname, ...args], { env, encoding: 'utf8' });
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout.includes(f.key.toString('base64url')), false);
    return JSON.parse(output.stdout);
  }
  assert.equal(run('store-backup.mjs', [f.backup]).recordCount, 1);
  assert.equal(run('store-backup.mjs', ['--verify', f.backup]).verified, true);
  assert.equal(run('store-restore.mjs', [f.backup, f.restored, '--offline']).authSessionsRestored, false);
});

test('restored running game preserves host, issuer-sub seats, private hands, turn and TTL', async (t) => {
  const f = fixture(t);
  const options = { storage: f.storage, now: f.now, pollIntervalMs: 0, gameOptions: { firstTurnIndex: 0, randomInt: (max) => max - 1 } };
  const live = createDurableRoomStore(options); t.after(() => live.close());
  const host = await live.createRoom(member, '同名', 'backup-create');
  const guest = await live.joinRoom(host.roomCode, other, '同名', 'backup-join');
  let request = 0;
  async function action(userKey, type, extra = {}) {
    const view = await live.getView(host.roomCode, userKey);
    return live.action(host.roomCode, userKey, { type, requestId: `backup-action-${++request}`, expectedRevision: view.revision, ...extra });
  }
  await action(member, 'ready', { ready: true }); await action(other, 'ready', { ready: true }); await action(member, 'start');
  const beforeHost = await live.getView(host.roomCode, member), beforeGuest = await live.getView(host.roomCode, other);
  await backupStore({ sourcePath: f.path, destinationPath: f.backup, key: f.key, now: f.now });
  await live.close();
  restoreStore({ sourcePath: f.backup, destinationPath: f.restored, key: f.key, offline: true });
  const recovered = new EncryptedStore(new SQLiteAdapter(f.restored), f.key, f.now); f.opened.push(recovered);
  let time = f.now();
  const restored = createDurableRoomStore({ ...options, storage: recovered, now: () => time }); t.after(() => restored.close());
  assert.deepEqual(await restored.getView(host.roomCode, member), beforeHost);
  assert.deepEqual(await restored.getView(host.roomCode, other), beforeGuest);
  assert.equal(beforeHost.hostId, host.playerId); assert.equal(beforeGuest.selfId, guest.playerId);
  await assert.rejects(restored.getView(host.roomCode, identityKey('https://different-issuer.example', 'member')), (error) => error.code === 'SEAT_REQUIRED');
  assert.equal((await restored.recentRooms(member))[0].playerId, host.playerId);
  time += 8 * 60 * 60 * 1000;
  await assert.rejects(restored.getView(host.roomCode, member), (error) => error.code === 'ROOM_NOT_FOUND');
});
