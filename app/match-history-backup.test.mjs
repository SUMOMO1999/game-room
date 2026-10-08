import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createMatchHistory, HISTORY_RETENTION_MS } from '../server/match-history.mjs';
import { backupStore, verifyBackup, restoreStore, LEGACY_RECOVERY_SCOPES, CHAT_RECOVERY_SCOPES, HISTORY_RECOVERY_SCOPES, DRAWING_RECOVERY_SCOPES, RECOVERY_SCOPES } from '../server/backup.mjs';

const a = identityKey('urn:synthetic-history-backup', 'a'), b = identityKey('urn:synthetic-history-backup', 'b');
const id = (number) => number.toString(16).padStart(32, '0');
const summary = () => ({ matchId: id(1), roomId: id(2), roomCode: '234567', game: 'rummikub', ruleVersion: 'friends-v2',
  startedAt: 1000, endedAt: 10000, status: 'completed', reason: 'cleared-rack', players: [
    { userKey: a, seatId: id(3), nickname: '备份甲', outcome: 'win', remainingPoints: 0 },
    { userKey: b, seatId: id(4), nickname: '备份乙', outcome: 'loss', remainingPoints: 12 }] });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'game-history-backup-')), key = randomBytes(32);
  const sourcePath = join(directory, 'source.sqlite'), backupPath = join(directory, 'backup.sqlite'), restoredPath = join(directory, 'restored.sqlite');
  let time = 10000; const now = () => time, opened = [];
  function open(path = sourcePath) { const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now); opened.push(storage); return { storage, history: createMatchHistory({ storage, now }) }; }
  const source = open();
  t.after(async () => { for (const storage of opened) storage.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, key, sourcePath, backupPath, restoredPath, now, ...source, open,
    backup: () => backupStore({ sourcePath, destinationPath: backupPath, key, now }),
    restore: () => restoreStore({ sourcePath: backupPath, destinationPath: restoredPath, key, offline: true }),
    advance: (ms) => { time += ms; } };
}

test('signed encrypted history backup restores once with the exact retention deadline and no sessions or identity leakage', async (t) => {
  const f = await fixture(t); await f.history.archive(summary());
  await f.storage.put('sessions', 'old-cookie', { token: 'excluded-history-session' }, f.now() + 1000);
  const before = await f.storage.read('game-history', id(1));
  const report = await f.backup(); assert.equal(report.excludedRecords, 1); assert.deepEqual(report.scopes, RECOVERY_SCOPES);
  assert.equal(report.recordCount, 3); assert.equal(verifyBackup({ sourcePath: f.backupPath, key: f.key }).historyIncluded, true);
  const bytes = await readFile(f.backupPath);
  for (const text of [a, b, '备份甲', '备份乙', 'excluded-history-session']) assert.equal(bytes.includes(Buffer.from(text)), false);
  assert.equal(f.restore().historyIncluded, true); const recovered = f.open(f.restoredPath);
  await recovered.history.archive(summary()); await recovered.history.archive(summary());
  assert.equal((await recovered.history.get(a)).stats.wins, 1);
  assert.equal((await recovered.storage.read('game-history', id(1))).expiresAt, before.expiresAt);
  assert.equal(await recovered.storage.read('sessions', 'old-cookie'), null);
});

test('an archived-result outbox survives backup and can be replayed after restore without an extra win', async (t) => {
  const f = await fixture(t); await f.history.archive(summary());
  await f.storage.put('rooms', id(2), { snapshot: null, deletedAt: f.now(), reason: 'empty', pendingRecords: [summary()] });
  await f.backup(); f.restore(); const recovered = f.open(f.restoredPath);
  const pending = (await recovered.storage.read('rooms', id(2))).value.pendingRecords;
  for (const item of pending) await recovered.history.archive(item);
  assert.equal((await recovered.history.get(a)).stats.completed, 1);
  assert.equal((await recovered.storage.scan('game-history')).length, 1);
});

test('restoring an expired result or outbox never renews history or returns stale stats', async (t) => {
  const f = await fixture(t); await f.history.archive(summary());
  await f.storage.put('rooms', id(2), { snapshot: null, pendingRecords: [summary()] });
  await f.backup(); f.advance(HISTORY_RETENTION_MS); f.restore(); const recovered = f.open(f.restoredPath);
  assert.equal((await recovered.history.get(a)).stats.completed, 0);
  assert.equal((await recovered.history.archive(summary())).expired, true);
  assert.equal(await recovered.storage.read('game-history', id(1)), null);
});

for (const scopes of [LEGACY_RECOVERY_SCOPES, CHAT_RECOVERY_SCOPES]) test(`signed legacy ${scopes.length}-scope backups remain valid and declare history absent`, async (t) => {
  const f = await fixture(t); await f.storage.put('game-profiles', a, { userKey: a, nickname: '原资料' }); await f.backup();
  const db = new DatabaseSync(f.backupPath);
  const { signature, ...manifest } = JSON.parse(db.prepare('SELECT value FROM game_metadata WHERE name=?').get('backup-manifest').value);
  manifest.scopes = scopes;
  const signed = { ...manifest, signature: createHmac('sha256', f.key).update('game-room-backup:v1\0').update(JSON.stringify(manifest)).digest('hex') };
  db.prepare('UPDATE game_metadata SET value=? WHERE name=?').run(JSON.stringify(signed), 'backup-manifest'); db.close();
  assert.equal(verifyBackup({ sourcePath: f.backupPath, key: f.key }).historyIncluded, false);
  assert.equal(f.restore().historyIncluded, false); assert.deepEqual((await f.open(f.restoredPath).history.get(a)).items, []);
});

for (const scopes of [LEGACY_RECOVERY_SCOPES, CHAT_RECOVERY_SCOPES, HISTORY_RECOVERY_SCOPES, DRAWING_RECOVERY_SCOPES])
test(`legacy ${scopes.length}-scope recovery explicitly excludes permanent scores and cannot overwrite an existing store`, async t => {
  const f = await fixture(t); await f.storage.put('game-profiles', a, { userKey: a, nickname: '原资料' }); await f.backup();
  const db = new DatabaseSync(f.backupPath);
  const { signature, ...manifest } = JSON.parse(db.prepare('SELECT value FROM game_metadata WHERE name=?').get('backup-manifest').value);
  manifest.scopes = scopes;
  db.prepare('UPDATE game_metadata SET value=? WHERE name=?').run(JSON.stringify({ ...manifest,
    signature: createHmac('sha256', f.key).update('game-room-backup:v1\0').update(JSON.stringify(manifest)).digest('hex') }), 'backup-manifest'); db.close();
  assert.equal(verifyBackup({ sourcePath: f.backupPath, key: f.key }).scoresIncluded, false);
  assert.equal(f.restore().scoresIncluded, false);
  assert.throws(() => restoreStore({ sourcePath: f.backupPath, destinationPath: f.sourcePath, key: f.key, offline: true }), /Destination already exists/);
  assert.deepEqual((await f.storage.read('game-profiles', a)).value, { userKey: a, nickname: '原资料' });
});

test('a signed old manifest cannot smuggle result scopes; invalid result or index retention fails before publishing a backup', async (t) => {
  const f = await fixture(t); await f.history.archive(summary()); await f.backup();
  const db = new DatabaseSync(f.backupPath);
  const { signature, ...manifest } = JSON.parse(db.prepare('SELECT value FROM game_metadata WHERE name=?').get('backup-manifest').value);
  manifest.scopes = CHAT_RECOVERY_SCOPES;
  db.prepare('UPDATE game_metadata SET value=? WHERE name=?').run(JSON.stringify({ ...manifest,
    signature: createHmac('sha256', f.key).update('game-room-backup:v1\0').update(JSON.stringify(manifest)).digest('hex') }), 'backup-manifest'); db.close();
  assert.throws(() => verifyBackup({ sourcePath: f.backupPath, key: f.key }), /manifest verification/);
  const original = await f.storage.read('game-history', id(1));
  await f.storage.replaceCAS('game-history', id(1), original.version, original.value, original.expiresAt + 1);
  await assert.rejects(backupStore({ sourcePath: f.sourcePath, destinationPath: join(f.directory, 'wrong-retention.sqlite'), key: f.key, now: f.now }), /History identity or retention mismatch/);
});
