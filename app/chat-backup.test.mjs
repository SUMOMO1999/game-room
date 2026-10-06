import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, SQLiteAdapter, identityKey, recordKey } from '../server/storage.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createRoomChat, CHAT_RETENTION_MS } from '../server/chat.mjs';
import { backupStore, verifyBackup, restoreStore, LEGACY_RECOVERY_SCOPES, RECOVERY_SCOPES } from '../server/backup.mjs';

const user = identityKey('urn:synthetic-chat-backup', 'member');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'game-chat-backup-'));
  const sourcePath = join(directory, 'source.sqlite'), backupPath = join(directory, 'backup.sqlite'), restoredPath = join(directory, 'restored.sqlite');
  const key = randomBytes(32); let time = 10000; const now = () => time;
  const storage = new EncryptedStore(new SQLiteAdapter(sourcePath, { now }), key, now);
  const rooms = createDurableRoomStore({ storage, now, pollIntervalMs: 0 });
  const chat = createRoomChat({ storage, rooms, now, pollIntervalMs: 0 });
  const extra = [];
  t.after(async () => { await chat.close(); await rooms.close(); storage.close(); for (const entry of extra) { await entry.chat.close(); await entry.rooms.close(); entry.storage.close(); } await rm(directory, { recursive: true, force: true }); });
  const room = await rooms.createRoom(user, '合成昵称', 'backup-host');
  function restored() {
    const storage = new EncryptedStore(new SQLiteAdapter(restoredPath, { now }), key, now);
    const rooms = createDurableRoomStore({ storage, now, pollIntervalMs: 0 });
    const chat = createRoomChat({ storage, rooms, now, pollIntervalMs: 0 });
    const entry = { storage, rooms, chat }; extra.push(entry); return entry;
  }
  async function createBackup() { return backupStore({ sourcePath, destinationPath: backupPath, key, now }); }
  function restore() { return restoreStore({ sourcePath: backupPath, destinationPath: restoredPath, key, offline: true }); }
  return { directory, sourcePath, backupPath, restoredPath, key, now, storage, rooms, chat, room, restored, createBackup, restore, advance: (ms) => { time += ms; } };
}

test('signed encrypted business backup includes chat, excludes sessions/PKCE/presence, and restores original ACK', async (t) => {
  const f = await fixture(t);
  const original = await f.chat.send(f.room.roomCode, user, { text: '合成私人聊天正文', requestId: 'saved-message' });
  await f.storage.put('sessions', 'synthetic-cookie', { accessToken: 'excluded-chat-backup-token' }, f.now() + 60000);
  await f.storage.put('transactions', 'synthetic-pkce', { verifier: 'excluded-chat-backup-verifier' }, f.now() + 60000);
  await f.storage.put('room-presence', f.room.view.roomId, { online: true }, f.now() + 60000);
  const report = await f.createBackup();
  assert.equal(report.excludedRecords, 3); assert.ok(report.scopes.includes('room-chat')); assert.equal(report.authSessionsIncluded, false);
  const verified = verifyBackup({ sourcePath: f.backupPath, key: f.key });
  assert.equal(verified.chatIncluded, true); assert.ok(verified.rows.some((row) => row.key.startsWith('room-chat:')));
  const bytes = await readFile(f.backupPath);
  for (const text of ['合成私人聊天正文', user, 'excluded-chat-backup-token', 'excluded-chat-backup-verifier']) assert.equal(bytes.includes(Buffer.from(text)), false);
  const result = f.restore(); assert.equal(result.chatIncluded, true); assert.equal(result.authSessionsRestored, false);
  const recovered = f.restored();
  const history = await recovered.chat.get(f.room.roomCode, user);
  assert.equal(history.messages[0].messageId, original.message.messageId);
  assert.equal(history.messages[0].expiresAt, original.message.expiresAt);
  const duplicate = await recovered.chat.send(f.room.roomCode, user, { text: '合成私人聊天正文', requestId: 'saved-message' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.message.chatSequence, original.message.chatSequence);
  assert.equal(await recovered.storage.read('sessions', 'synthetic-cookie'), null);
  assert.equal(await recovered.storage.read('transactions', 'synthetic-pkce'), null);
  assert.equal(await recovered.storage.read('room-presence', f.room.view.roomId), null);
});

test('restoring after chat expiry does not extend message lifetime, reset sequence, or renew room activity', async (t) => {
  const f = await fixture(t);
  const message = await f.chat.send(f.room.roomCode, user, { text: '原期限', requestId: 'ttl-message' });
  // Only actual business actions extend the normal 8h room TTL; chat keeps its own original 24h expiration.
  for (let index = 0; index < 3; index++) {
    f.advance(7 * 3600000);
    const view = await f.rooms.getView(f.room.roomCode, user);
    await f.rooms.action(f.room.roomCode, user, { type: 'ready', ready: index % 2 === 0,
      requestId: `keep-game-active-${index}`, expectedRevision: view.revision });
  }
  const activeAt = (await f.storage.read('rooms', f.room.view.roomId)).value.snapshot.lastActiveAt;
  assert.equal(message.message.expiresAt, 10000 + CHAT_RETENTION_MS);
  await f.createBackup();
  f.advance(3 * 3600000 + 1);
  f.restore();
  const recovered = f.restored();
  const history = await recovered.chat.get(f.room.roomCode, user);
  assert.deepEqual(history.messages, []); assert.equal(history.latestSequence, 1);
  await recovered.chat.sweep();
  const saved = await recovered.storage.read('room-chat', f.room.view.roomId);
  assert.deepEqual(saved.value.messages, []); assert.deepEqual(saved.value.requests, {});
  assert.equal((await recovered.storage.read('rooms', f.room.view.roomId)).value.snapshot.lastActiveAt, activeAt);
  const next = await recovered.chat.send(f.room.roomCode, user, { text: '到期后新发送', requestId: 'ttl-message' });
  assert.equal(next.message.chatSequence, 2); assert.notEqual(next.message.messageId, message.message.messageId);
  f.advance(5 * 3600000);
  await assert.rejects(recovered.chat.get(f.room.roomCode, user), (error) => error.code === 'ROOM_NOT_FOUND');
});

test('old signed v1 backup without chat remains recoverable and explicitly reports no chat history', async (t) => {
  const f = await fixture(t); await f.createBackup();
  const db = new DatabaseSync(f.backupPath);
  const encoded = JSON.parse(db.prepare('SELECT value FROM game_metadata WHERE name=?').get('backup-manifest').value);
  const { signature, ...manifest } = encoded;
  manifest.scopes = LEGACY_RECOVERY_SCOPES;
  const signed = { ...manifest, signature: createHmac('sha256', f.key).update('game-room-backup:v1\0').update(JSON.stringify(manifest)).digest('hex') };
  db.prepare('UPDATE game_metadata SET value=? WHERE name=?').run(JSON.stringify(signed), 'backup-manifest'); db.close();
  assert.equal(verifyBackup({ sourcePath: f.backupPath, key: f.key }).chatIncluded, false);
  assert.equal(f.restore().chatIncluded, false);
  const recovered = f.restored(); assert.deepEqual((await recovered.chat.get(f.room.roomCode, user)).messages, []);
});

test('chat schema/room identity damage and unsigned manifest changes invalidate backup recovery', async (t) => {
  const f = await fixture(t);
  await f.chat.send(f.room.roomCode, user, { text: '完整性', requestId: 'integrity' });
  await f.createBackup();
  const db = new DatabaseSync(f.backupPath);
  const manifest = JSON.parse(db.prepare('SELECT value FROM game_metadata WHERE name=?').get('backup-manifest').value);
  manifest.scopes = LEGACY_RECOVERY_SCOPES;
  db.prepare('UPDATE game_metadata SET value=? WHERE name=?').run(JSON.stringify(manifest), 'backup-manifest'); db.close();
  assert.throws(() => f.restore(), /manifest verification/);
  const source = await f.storage.read('room-chat', f.room.view.roomId);
  source.value.roomId = randomBytes(16).toString('hex');
  await f.storage.replaceCAS('room-chat', f.room.view.roomId, source.version, source.value);
  await assert.rejects(backupStore({ sourcePath: f.sourcePath, destinationPath: join(f.directory, 'invalid-chat.sqlite'), key: f.key, now: f.now }), /Chat room identity mismatch/);
});

test('even a signed legacy manifest cannot smuggle a new chat namespace into its older declared scopes', async (t) => {
  const f = await fixture(t);
  await f.chat.send(f.room.roomCode, user, { text: '范围检查', requestId: 'scope' }); await f.createBackup();
  const db = new DatabaseSync(f.backupPath);
  const { signature, ...manifest } = JSON.parse(db.prepare('SELECT value FROM game_metadata WHERE name=?').get('backup-manifest').value);
  manifest.scopes = LEGACY_RECOVERY_SCOPES;
  const signed = { ...manifest, signature: createHmac('sha256', f.key).update('game-room-backup:v1\0').update(JSON.stringify(manifest)).digest('hex') };
  db.prepare('UPDATE game_metadata SET value=? WHERE name=?').run(JSON.stringify(signed), 'backup-manifest'); db.close();
  assert.throws(() => verifyBackup({ sourcePath: f.backupPath, key: f.key }), /manifest verification/);
  assert.ok(RECOVERY_SCOPES.includes('room-chat'));
});
