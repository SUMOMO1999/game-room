import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, linkSync, rmSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { decryptStoredRecord, encryptionKeyId, recordKey } from './storage.mjs';
import { createRoomStore } from '../app/rooms.mjs';
import { validateChatSnapshot } from './chat.mjs';
import { validateMatchSummary, validateHistoryRecord, validateHistoryIndex } from './match-history.mjs';

// Explicit recovery boundary. Session/token/PKCE/presence records never enter the delivered artifact.
export const LEGACY_RECOVERY_SCOPES = Object.freeze(['game-profiles', 'room-invites', 'rooms', 'room-memberships', 'room-registry', 'room-requests']);
export const CHAT_RECOVERY_SCOPES = Object.freeze([...LEGACY_RECOVERY_SCOPES, 'room-chat']);
export const RECOVERY_SCOPES = Object.freeze([...CHAT_RECOVERY_SCOPES, 'game-history', 'history-index']);
const EPHEMERAL_SCOPES = new Set(['sessions', 'transactions', 'room-presence']);
const SELECT = 'SELECT key,revision,expires_ms AS expiresAt,version AS v,payload FROM game_records ORDER BY key';
const SCHEMA = 'CREATE TABLE game_records (key TEXT PRIMARY KEY,revision TEXT NOT NULL,expires_ms REAL NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE game_metadata (name TEXT PRIMARY KEY,value TEXT NOT NULL);';
const scopeOf = (row) => row.key.split(':')[0];
const digestRows = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const sign = (key, value) => createHmac('sha256', key).update('game-room-backup:v1\0').update(JSON.stringify(value)).digest('hex');

function checkSource(source) {
  if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('Use an absolute source path');
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Source must be an owned regular database file');
}
function exists(path) { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function paths(source, destination) {
  if (typeof source !== 'string' || typeof destination !== 'string' || !isAbsolute(source) || !isAbsolute(destination) || resolve(source) === resolve(destination)) throw new Error('Use different absolute source and destination paths');
  checkSource(source);
  if (exists(destination) || exists(`${destination}-wal`) || exists(`${destination}-shm`)) throw new Error('Destination already exists; refusing to overwrite');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
}
function checkedRows(db, key, { artifact = false } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Recovery requires the existing 32-byte encryption key');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('Database integrity check failed');
  const saved = db.prepare('SELECT value FROM game_metadata WHERE name=?').get('key-id');
  if (saved?.value !== encryptionKeyId(key)) throw new Error('Backup encryption key mismatch');
  const rows = db.prepare(SELECT).all();
  for (const row of rows) {
    if (!/^[A-Za-z0-9-]+:[a-f0-9]{64}$/.test(row.key) || typeof row.revision !== 'string') throw new Error('Invalid backup record');
    const scope = scopeOf(row);
    if (!RECOVERY_SCOPES.includes(scope) && (!EPHEMERAL_SCOPES.has(scope) || artifact)) throw new Error('Unrecognized recovery scope');
    const value = decryptStoredRecord(key, row.key, row);
    if (scope === 'game-profiles' && (!/^[a-f0-9]{64}$/.test(value.userKey ?? '') || recordKey(scope, value.userKey) !== row.key)) throw new Error('Profile identity mismatch');
    if (scope === 'rooms' && value.snapshot) {
      if (!/^[a-f0-9]{32}$/.test(value.snapshot.roomId ?? '') || recordKey(scope, value.snapshot.roomId) !== row.key) throw new Error('Room identity mismatch');
      createRoomStore().importSnapshot(value.snapshot);
    }
    if (scope === 'room-requests' && value.snapshot) {
      if (value.kind !== 'create' || value.status !== 'pending' || value.snapshot.phase !== 'waiting'
          || value.snapshot.code !== value.code || value.snapshot.roomId !== value.roomId) throw new Error('Pending room identity mismatch');
      createRoomStore().importSnapshot(value.snapshot);
    }
    if (scope === 'rooms') {
      for (const summary of [...(value.snapshot?.pendingRecords ?? []), ...(value.pendingRecords ?? [])]) {
        validateMatchSummary(summary);
        if (recordKey(scope, summary.roomId) !== row.key) throw new Error('Pending match room identity mismatch');
      }
    }
    if (scope === 'room-chat') {
      validateChatSnapshot(value);
      if (recordKey(scope, value.roomId) !== row.key) throw new Error('Chat room identity mismatch');
    }
    if (scope === 'game-history') {
      validateHistoryRecord(value);
      if (recordKey(scope, value.summary.matchId) !== row.key || row.expiresAt !== value.summary.endedAt + 180 * 86400000) throw new Error('History identity or retention mismatch');
    }
    if (scope === 'history-index') {
      validateHistoryIndex(value);
      if (recordKey(scope, value.userKey) !== row.key || !value.entries.length
          || row.expiresAt !== Math.max(...value.entries.map((entry) => entry.endedAt + 180 * 86400000))) throw new Error('History index identity or retention mismatch');
    }
  }
  return rows;
}
function writeDatabase(path, rows, metadata) {
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA); db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO game_records(key,revision,expires_ms,version,payload) VALUES (?,?,?,?,?)');
    for (const row of rows) insert.run(row.key, row.revision, row.expiresAt, row.v, row.payload);
    const meta = db.prepare('INSERT INTO game_metadata(name,value) VALUES (?,?)');
    for (const [name, value] of Object.entries(metadata)) meta.run(name, value);
    db.exec('COMMIT');
  } finally { db.close(); }
  chmodSync(path, 0o600);
}
function publish(path, destination) {
  // Hard-link publication is atomic and cannot replace an existing file.
  linkSync(path, destination); chmodSync(destination, 0o600);
}
function openRead(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF'); return db; }
  catch (error) { db.close(); throw error; }
}

/** Read-only consistent validation before a candidate may serve the existing business database. */
export function verifyLiveStore({ sourcePath, key } = {}) {
  checkSource(sourcePath);
  const db = openRead(sourcePath);
  try {
    db.exec('BEGIN');
    const rows = checkedRows(db, key, { artifact: false });
    const counts = {};
    for (const row of rows) counts[scopeOf(row)] = (counts[scopeOf(row)] ?? 0) + 1;
    return { recordCount: rows.length, scopes: Object.keys(counts).sort(), counts };
  } finally {
    try { db.exec('ROLLBACK'); } finally { db.close(); }
  }
}

/** SQLite online backup API captures committed WAL data without copying a changing main file. */
export async function backupStore({ sourcePath, destinationPath, key, now = Date.now } = {}) {
  paths(sourcePath, destinationPath);
  const temporary = mkdtempSync(join(dirname(destinationPath), '.game-backup-'));
  let source, snapshot;
  try {
    source = openRead(sourcePath);
    const snapshotPath = join(temporary, 'snapshot.sqlite');
    await backup(source, snapshotPath);
    source.close(); source = null;
    chmodSync(snapshotPath, 0o600);
    snapshot = openRead(snapshotPath);
    const allRows = checkedRows(snapshot, key);
    const rows = allRows.filter((row) => RECOVERY_SCOPES.includes(scopeOf(row)));
    const manifest = { format: 1, keyId: encryptionKeyId(key), createdAt: now(), recordCount: rows.length,
      scopes: RECOVERY_SCOPES, digest: digestRows(rows), authSessionsIncluded: false };
    const signed = { ...manifest, signature: sign(key, manifest) };
    snapshot.close(); snapshot = null;
    const path = join(temporary, 'business.sqlite');
    writeDatabase(path, rows, { 'key-id': manifest.keyId, 'backup-manifest': JSON.stringify(signed) });
    const output = openRead(path);
    try { checkedRows(output, key, { artifact: true }); } finally { output.close(); }
    publish(path, destinationPath);
    return { ...manifest, path: destinationPath, excludedRecords: allRows.length - rows.length };
  } finally {
    source?.close(); snapshot?.close();
    rmSync(temporary, { recursive: true, force: true }); // Only this call's private, newly-created workspace.
  }
}

export function verifyBackup({ sourcePath, key } = {}) {
  checkSource(sourcePath);
  const db = openRead(sourcePath);
  try {
    const rows = checkedRows(db, key, { artifact: true });
    const encoded = db.prepare('SELECT value FROM game_metadata WHERE name=?').get('backup-manifest')?.value;
    const parsed = JSON.parse(encoded ?? 'null');
    if (!parsed || typeof parsed !== 'object') throw new Error('Backup manifest missing');
    const { signature, ...manifest } = parsed;
    const expected = sign(key, manifest);
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)
      || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      || manifest.format !== 1 || manifest.keyId !== encryptionKeyId(key)
      || manifest.recordCount !== rows.length || manifest.digest !== digestRows(rows)
      || manifest.authSessionsIncluded !== false
      || ![RECOVERY_SCOPES, CHAT_RECOVERY_SCOPES, LEGACY_RECOVERY_SCOPES].some((scopes) => JSON.stringify(manifest.scopes) === JSON.stringify(scopes))
      || rows.some((row) => !manifest.scopes.includes(scopeOf(row)))) throw new Error('Backup manifest verification failed');
    return { manifest, rows, chatIncluded: manifest.scopes.includes('room-chat'), historyIncluded: manifest.scopes.includes('game-history') && manifest.scopes.includes('history-index') };
  } finally { db.close(); }
}

/** Creates a fresh database only. The operator stops the BFF and switches its configured path afterwards. */
export function restoreStore({ sourcePath, destinationPath, key, offline = false } = {}) {
  if (offline !== true) throw new Error('Restore requires explicit offline confirmation');
  paths(sourcePath, destinationPath);
  const { manifest, rows, chatIncluded, historyIncluded } = verifyBackup({ sourcePath, key });
  const temporary = mkdtempSync(join(dirname(destinationPath), '.game-restore-'));
  try {
    const path = join(temporary, 'restored.sqlite');
    // Do not retain a backup manifest that normal runtime writes would invalidate.
    writeDatabase(path, rows, { 'key-id': manifest.keyId });
    publish(path, destinationPath);
    return { path: destinationPath, recordCount: rows.length, keyId: manifest.keyId,
      backupCreatedAt: manifest.createdAt, authSessionsRestored: false, chatIncluded, historyIncluded };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
