import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, chmodSync, lstatSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const recordRevision = Symbol('encrypted record revision');
export const opaqueId = () => randomBytes(32).toString('base64url');
export const identityKey = (issuer, sub) => createHash('sha256').update(JSON.stringify([issuer, sub])).digest('hex');
export const recordKey = (scope, id) => `${scope}:${createHash('sha256').update(String(id)).digest('hex')}`;
const live = (record, now) => record && record.expiresAt > now;
export const encryptionKeyId = (key) => createHash('sha256').update('game-room-storage-key:v1\0').update(key).digest('hex');

export const MAX_TRANSACTION_RECORDS = 64;
export const MAX_TRANSACTION_BYTES = 32 * 1024 * 1024;
const transactionScope = /^[a-z][a-z0-9-]{0,63}$/;
const transactionRevision = /^[A-Za-z0-9_-]{43}$/;
const transactionKey = /^[a-z][a-z0-9-]{0,63}:[a-f0-9]{64}$/;
const transactionError = () => new TypeError('Invalid atomic storage transaction');
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function checkedFields(value, fields) {
  if (!plainObject(value) || Object.keys(value).some(field => !fields.includes(field))) throw transactionError();
}
function transactionClock(now) {
  const current = now();
  if (!Number.isFinite(current)) throw new TypeError('Atomic storage requires a finite clock');
  return current;
}
const expectedRecord = (record, version, time) => version === null
  ? !live(record, time) : live(record, time) && record.revision === version;
function checkedAtomic({ changes, guards, validUntil }, { readOnly = false } = {}) {
  if (!Array.isArray(changes) || (readOnly ? changes.length !== 0 : !changes.length) || changes.length > MAX_TRANSACTION_RECORDS
      || !Array.isArray(guards) || readOnly && !guards.length || guards.length > MAX_TRANSACTION_RECORDS || !Number.isFinite(validUntil)) throw transactionError();
  const prerequisites = new Map(), changed = new Set(); let bytes = 0;
  for (const item of [...guards, ...changes]) {
    if (typeof item?.key !== 'string' || !transactionKey.test(item.key) || !(item.expectedVersion === null
        || typeof item.expectedVersion === 'string' && transactionRevision.test(item.expectedVersion))
        || item.validUntil !== undefined && !Number.isFinite(item.validUntil)) throw transactionError();
    const previous = prerequisites.get(item.key);
    if (previous && previous.expectedVersion !== item.expectedVersion) throw transactionError();
    prerequisites.set(item.key, { key: item.key, expectedVersion: item.expectedVersion,
      validUntil: Math.min(validUntil, item.validUntil ?? validUntil, previous?.validUntil ?? validUntil) });
  }
  for (const change of changes) {
    if (changed.has(change.key)) throw transactionError(); changed.add(change.key);
    if (change.record !== null) {
      const record = change.record;
      if (record?.v !== 1 || typeof record.revision !== 'string' || !transactionRevision.test(record.revision) || !Number.isFinite(record.expiresAt)
          || record.revision === change.expectedVersion || typeof record.payload !== 'string' || !/^[A-Za-z0-9_-]+$/.test(record.payload)) throw transactionError();
      bytes += Buffer.byteLength(record.payload);
    }
  }
  if (prerequisites.size > MAX_TRANSACTION_RECORDS || bytes > MAX_TRANSACTION_BYTES) throw transactionError();
  return [...prerequisites.values()];
}
function atomicConditions(prerequisites, originals, changes, time) {
  return prerequisites.every(item => time < item.validUntil && expectedRecord(originals.get(item.key), item.expectedVersion, time))
    && changes.every(change => change.record === null || change.record.expiresAt > time);
}

// Unlike application reads, startup and recovery must distinguish damaged data from absent data.
export function decryptStoredRecord(key, storageKey, record) {
  if (record?.v !== 1 || !Number.isFinite(record.expiresAt) || !/^[A-Za-z0-9_-]+$/.test(record.payload ?? '')) throw new Error('Invalid encrypted record');
  const bytes = Buffer.from(record.payload, 'base64url');
  if (bytes.length <= 28) throw new Error('Invalid encrypted record');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(storageKey)); decipher.setAuthTag(bytes.subarray(12, 28));
  const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid encrypted value');
  return value;
}

export function secureDatabaseFile(path) {
  if (!existsSync(path)) { const descriptor = openSync(path, 'wx', 0o600); closeSync(descriptor); }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Database must be an owned regular file');
  chmodSync(path, 0o600);
}

export class MemoryAdapter {
  constructor({ capacity = 10000, now = () => Date.now() } = {}) { this.records = new Map(); this.capacity = capacity; this.now = now; }
  async get(key) { return this.records.get(key); }
  purge(now = this.now()) {
    if (!Number.isFinite(now)) throw new Error('Expiration cleanup requires a finite time');
    let removed = 0;
    for (const [key, value] of this.records) if (value.expiresAt <= now) { this.records.delete(key); removed++; }
    return removed;
  }
  purgeExpired(now = this.now()) { return this.purge(now); }
  async entries(scope) { return [...this.records].filter(([key]) => key.startsWith(`${scope}:`)).map(([key, record]) => ({ key, ...record })); }
  async put(key, record) { this.purge(); if (!this.records.has(key) && this.records.size >= this.capacity) throw new Error('Local store capacity reached'); this.records.set(key, record); }
  async putIfAbsent(key, record, now = this.now()) {
    if (live(this.records.get(key), now)) return false;
    await this.put(key, record); return true;
  }
  async take(key) { const record = this.records.get(key); this.records.delete(key); return record; }
  async remove(key, expected) {
    if (expected && this.records.get(key)?.revision !== expected) return false;
    return this.records.delete(key);
  }
  async replace(key, record, expected, now = this.now()) {
    const current = this.records.get(key);
    if (!live(current, now) || current.revision !== expected) return false;
    this.records.set(key, record); return true;
  }
  async guardedCAS(key, record, expected, guard, now = this.now()) {
    now = typeof now === 'function' ? now() : now;
    const prerequisite = this.records.get(guard.key), current = this.records.get(key);
    if (!live(prerequisite, now) || prerequisite.revision !== guard.version || guard.validUntil <= now
        || (expected === null ? live(current, now) : !live(current, now) || current.revision !== expected)) return false;
    this.purge(now);
    if (!this.records.has(key) && this.records.size >= this.capacity) throw new Error('Local store capacity reached');
    // No await between the condition and mutation: this is atomic within the MemoryAdapter process.
    this.records.set(key, record); return true;
  }
  async compareAndSwapMany(transaction, now = this.now) {
    if (typeof now !== 'function') throw transactionError();
    const prerequisites = checkedAtomic(transaction), time = transactionClock(now);
    const originals = new Map(prerequisites.map(item => [item.key, this.records.get(item.key)]));
    if (!atomicConditions(prerequisites, originals, transaction.changes, time)) return false;
    const commitTime = transactionClock(now);
    // Recheck the actual map before applying; no await or mutation occurs before
    // all prerequisites, expirations and the resulting capacity are satisfied.
    const current = new Map(prerequisites.map(item => [item.key, this.records.get(item.key)]));
    if (!atomicConditions(prerequisites, current, transaction.changes, commitTime)) return false;
    const next = new Map([...this.records].filter(([, record]) => live(record, commitTime)));
    for (const change of transaction.changes) {
      if (change.record === null) next.delete(change.key); else next.set(change.key, change.record);
    }
    if (next.size > this.capacity) throw new Error('Local store capacity reached');
    if (!atomicConditions(prerequisites, new Map(prerequisites.map(item => [item.key, this.records.get(item.key)])), transaction.changes, transactionClock(now))) return false;
    this.records = next; return true;
  }
  async verifyGuards(transaction, now = this.now) {
    if (typeof now !== 'function') throw transactionError();
    const prerequisites = checkedAtomic(transaction, { readOnly: true });
    const matches = () => {
      const time = transactionClock(now);
      const current = new Map(prerequisites.map(item => [item.key, this.records.get(item.key)]));
      return atomicConditions(prerequisites, current, [], time);
    };
    return matches() && matches();
  }
  close() {}
}

// One host / shared local file only. Multi-host cloud storage needs a separate reviewed adapter.
export class SQLiteAdapter {
  constructor(path, { now = () => Date.now() } = {}) {
    if (!path || typeof path !== 'string') throw new Error('SQLite requires a file path');
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); secureDatabaseFile(path); }
    // Validate existing sidecars before SQLite opens them, including dangling symbolic links.
    if (path !== ':memory:') for (const suffix of ['-wal', '-shm']) {
      try { lstatSync(`${path}${suffix}`); secureDatabaseFile(`${path}${suffix}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.db = new DatabaseSync(path); this.path = path; this.now = now;
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS game_records (key TEXT PRIMARY KEY, revision TEXT NOT NULL, expires_ms REAL NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL);');
      if (path !== ':memory:') for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) secureDatabaseFile(`${path}${suffix}`);
    } catch (error) { this.db.close(); throw error; }
    this.select = this.db.prepare('SELECT revision, expires_ms AS expiresAt, version AS v, payload FROM game_records WHERE key=?');
    this.write = this.db.prepare('INSERT INTO game_records (key,revision,expires_ms,version,payload) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,expires_ms=excluded.expires_ms,version=excluded.version,payload=excluded.payload');
    this.absent = this.db.prepare('INSERT INTO game_records (key,revision,expires_ms,version,payload) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,expires_ms=excluded.expires_ms,version=excluded.version,payload=excluded.payload WHERE game_records.expires_ms<=?');
    this.replaceStatement = this.db.prepare('UPDATE game_records SET revision=?,expires_ms=?,version=?,payload=? WHERE key=? AND revision=? AND expires_ms>?');
    this.takeStatement = this.db.prepare('DELETE FROM game_records WHERE key=? RETURNING revision,expires_ms AS expiresAt,version AS v,payload');
    this.deleteStatement = this.db.prepare('DELETE FROM game_records WHERE key=?');
    this.deleteRevision = this.db.prepare('DELETE FROM game_records WHERE key=? AND revision=?');
  }
  bindKey(key) {
    try {
      this.db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS game_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);');
      const saved = this.db.prepare('SELECT value FROM game_metadata WHERE name=?').get('key-id');
      const expected = encryptionKeyId(key);
      if (saved && saved.value !== expected) throw new Error('Storage encryption key mismatch');
      // Legacy stores receive a guard only after every existing ciphertext is proven readable.
      for (const row of this.db.prepare('SELECT key,version AS v,expires_ms AS expiresAt,payload FROM game_records').iterate()) decryptStoredRecord(key, row.key, row);
      if (!saved) this.db.prepare('INSERT INTO game_metadata(name,value) VALUES (?,?)').run('key-id', expected);
      this.db.exec('COMMIT');
      this.keyId = expected;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* Failed setup may not have begun a transaction. */ }
      this.close();
      throw new Error('Stored data or encryption key could not be verified; refusing to start');
    }
  }
  async get(key) { return this.select.get(key); }
  async put(key, record) { this.write.run(key, record.revision, record.expiresAt, record.v, record.payload); }
  async putIfAbsent(key, record, now = this.now()) { return this.absent.run(key, record.revision, record.expiresAt, record.v, record.payload, now).changes === 1; }
  async take(key) { return this.takeStatement.get(key); }
  async remove(key, expected) { return (expected ? this.deleteRevision.run(key, expected) : this.deleteStatement.run(key)).changes === 1; }
  async replace(key, record, expected, now = this.now()) { return this.replaceStatement.run(record.revision, record.expiresAt, record.v, record.payload, key, expected, now).changes === 1; }
  async guardedCAS(key, record, expected, guard, now = this.now()) {
    // Keep this transaction synchronous and short. It fences a chat write against a simultaneous room leave or expiration.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentTime = typeof now === 'function' ? now : () => now;
      now = currentTime();
      const prerequisite = this.select.get(guard.key), current = this.select.get(key);
      if (!live(prerequisite, now) || prerequisite.revision !== guard.version || guard.validUntil <= now
          || (expected === null ? live(current, now) : !live(current, now) || current.revision !== expected)) {
        this.db.exec('ROLLBACK'); return false;
      }
      const changed = expected === null
        ? this.absent.run(key, record.revision, record.expiresAt, record.v, record.payload, now).changes === 1
        : this.replaceStatement.run(record.revision, record.expiresAt, record.v, record.payload, key, expected, now).changes === 1;
      if (currentTime() >= guard.validUntil) { this.db.exec('ROLLBACK'); return false; }
      this.db.exec('COMMIT'); return changed;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  async compareAndSwapMany(transaction, now = this.now) {
    if (typeof now !== 'function') throw transactionError();
    const prerequisites = checkedAtomic(transaction);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const time = transactionClock(now);
      const originals = new Map(prerequisites.map(item => [item.key, this.select.get(item.key)]));
      if (!atomicConditions(prerequisites, originals, transaction.changes, time)) { this.db.exec('ROLLBACK'); return false; }
      for (const change of transaction.changes) {
        if (change.record === null) this.deleteStatement.run(change.key);
        else this.write.run(change.key, change.record.revision, change.record.expiresAt, change.record.v, change.record.payload);
      }
      const commitTime = transactionClock(now);
      // BEGIN IMMEDIATE excludes other writers. Original records must still be
      // alive at commit, including overwritten/deleted prerequisites. Recheck
      // unchanged guards and exact proposed rows to catch transactional side
      // effects; a failed COMMIT throws, never reports a successful ack.
      const changed = new Map(transaction.changes.map(change => [change.key, change.record]));
      if (!atomicConditions(prerequisites, originals, transaction.changes, commitTime)
          || prerequisites.some(item => {
            const row = this.select.get(item.key);
            if (!changed.has(item.key)) return !expectedRecord(row, item.expectedVersion, commitTime);
            const proposed = changed.get(item.key);
            return proposed === null ? Boolean(row) : !row || row.revision !== proposed.revision || row.expiresAt !== proposed.expiresAt
              || row.v !== proposed.v || row.payload !== proposed.payload;
          })) { this.db.exec('ROLLBACK'); return false; }
      if (!atomicConditions(prerequisites, originals, transaction.changes, transactionClock(now))) { this.db.exec('ROLLBACK'); return false; }
      this.db.exec('COMMIT'); return true;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  async verifyGuards(transaction, now = this.now) {
    if (typeof now !== 'function') throw transactionError();
    const prerequisites = checkedAtomic(transaction, { readOnly: true });
    // Fail fast on a concurrent writer: this synchronous SQLite call cannot
    // otherwise be interrupted by the original monotonic authorization timer.
    const busyTimeout = this.db.prepare('PRAGMA busy_timeout').get().timeout;
    this.db.exec('PRAGMA busy_timeout=0');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const matches = () => {
        const time = transactionClock(now);
        const current = new Map(prerequisites.map(item => [item.key, this.select.get(item.key)]));
        return atomicConditions(prerequisites, current, [], time);
      };
      if (!matches() || !matches()) { this.db.exec('ROLLBACK'); return false; }
      this.db.exec('COMMIT'); return true;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
    finally { this.db.exec(`PRAGMA busy_timeout=${busyTimeout}`); }
  }
  purgeExpired(now = this.now()) {
    if (!Number.isFinite(now)) throw new Error('Expiration cleanup requires a finite time');
    return this.db.prepare('DELETE FROM game_records WHERE expires_ms<=?').run(now).changes;
  }
  async entries(scope) { return this.db.prepare('SELECT key,revision,expires_ms AS expiresAt,version AS v,payload FROM game_records WHERE key LIKE ?').all(`${scope}:%`); }
  close() { this.db.close(); }
}

export class EncryptedStore {
  constructor(adapter, key = randomBytes(32), now = () => Date.now()) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Expected a 32-byte encryption key');
    this.adapter = adapter; this.key = key; this.now = now;
    this.adapter.bindKey?.(key);
  }
  encode(scope, id, value, expiresAt) {
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('Record requires a future expiration');
    const key = recordKey(scope, id); const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(key));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { v: 1, revision: opaqueId(), expiresAt, payload: Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url') };
  }
  decode(scope, id, record) {
    if (!record || record.v !== 1 || record.expiresAt <= this.now()) return null;
    try {
      const value = decryptStoredRecord(this.key, recordKey(scope, id), record);
      Object.defineProperty(value, recordRevision, { value: record.revision, configurable: true });
      return value;
    } catch { return null; }
  }
  withRevision(original, value) { if (original?.[recordRevision]) Object.defineProperty(value, recordRevision, { value: original[recordRevision], configurable: true }); return value; }
  async get(scope, id) { return this.decode(scope, id, await this.adapter.get(recordKey(scope, id))); }
  async read(scope, id) { const record = await this.adapter.get(recordKey(scope, id)); const value = this.decode(scope, id, record); return value ? { value, version: record.revision, expiresAt: record.expiresAt } : null; }
  async scan(scope) {
    if (!/^[a-z][a-z0-9-]*$/.test(scope) || !this.adapter.entries) throw new Error('Storage scope scan is unsupported');
    return (await this.adapter.entries(scope)).filter((record) => record.expiresAt > this.now()).map((record) => ({
      value: decryptStoredRecord(this.key, record.key, record), version: record.revision, expiresAt: record.expiresAt,
    }));
  }
  async put(scope, id, value, expiresAt = Number.MAX_SAFE_INTEGER) { await this.adapter.put(recordKey(scope, id), this.encode(scope, id, value, expiresAt)); }
  async putIfAbsent(scope, id, value, expiresAt = Number.MAX_SAFE_INTEGER) { return this.adapter.putIfAbsent(recordKey(scope, id), this.encode(scope, id, value, expiresAt), this.now()); }
  async replace(scope, id, value, expiresAt = Number.MAX_SAFE_INTEGER) { return value?.[recordRevision] ? this.replaceCAS(scope, id, value[recordRevision], value, expiresAt) : false; }
  async replaceCAS(scope, id, version, value, expiresAt = Number.MAX_SAFE_INTEGER) { return this.adapter.replace(recordKey(scope, id), this.encode(scope, id, value, expiresAt), version, this.now()); }
  async guardedCAS(scope, id, version, value, expiresAt, guard) {
    if (!guard || typeof guard.scope !== 'string' || typeof guard.id !== 'string'
        || typeof guard.version !== 'string' || !Number.isFinite(guard.validUntil)
        || !(version === null || typeof version === 'string') || !this.adapter.guardedCAS) throw new Error('Atomic guarded storage is required');
    return this.adapter.guardedCAS(recordKey(scope, id), this.encode(scope, id, value, expiresAt), version,
      { key: recordKey(guard.scope, guard.id), version: guard.version, validUntil: guard.validUntil }, this.now);
  }
  async compareAndSwapMany(input) {
    checkedFields(input, ['changes', 'guards', 'validUntil']);
    const { changes, guards = [], validUntil = Number.MAX_SAFE_INTEGER } = input;
    if (!Array.isArray(changes) || !changes.length || changes.length > MAX_TRANSACTION_RECORDS
        || !Array.isArray(guards) || guards.length > MAX_TRANSACTION_RECORDS || !Number.isFinite(validUntil)
        || typeof this.now !== 'function' || !this.adapter.compareAndSwapMany) throw transactionError();
    const checked = (item, fields) => {
      checkedFields(item, fields);
      if (typeof item.scope !== 'string' || !transactionScope.test(item.scope) || typeof item.id !== 'string' || !item.id || Buffer.byteLength(item.id) > 1024
          || /\p{Cc}|\p{Cs}/u.test(item.id) || !(item.expectedVersion === null
            || typeof item.expectedVersion === 'string' && transactionRevision.test(item.expectedVersion)))
        throw transactionError();
      return { key: recordKey(item.scope, item.id), expectedVersion: item.expectedVersion };
    };
    const encodedChanges = changes.map(change => {
      const prepared = checked(change, ['scope', 'id', 'expectedVersion', 'value', 'expiresAt']);
      if (change.value === null) {
        if (change.expiresAt !== undefined) throw transactionError();
        return { ...prepared, record: null };
      }
      if (!plainObject(change.value)) throw transactionError();
      if (change.expiresAt !== undefined && !Number.isFinite(change.expiresAt)) throw transactionError();
      return { ...prepared, record: this.encode(change.scope, change.id, change.value,
        change.expiresAt === undefined ? Number.MAX_SAFE_INTEGER : change.expiresAt) };
    });
    const encodedGuards = guards.map(item => {
      const prepared = checked(item, ['scope', 'id', 'expectedVersion', 'validUntil']);
      if (item.validUntil !== undefined && !Number.isFinite(item.validUntil)) throw transactionError();
      return { ...prepared, ...(item.validUntil !== undefined ? { validUntil: item.validUntil } : {}) };
    });
    // This validates duplicate/overlapping keys and byte bounds before any
    // adapter opens a transaction. Business scope allowlists remain upstream.
    const transaction = { changes: encodedChanges, guards: encodedGuards, validUntil };
    checkedAtomic(transaction);
    return this.adapter.compareAndSwapMany(transaction, this.now);
  }
  async verifyGuards(input) {
    checkedFields(input, ['guards', 'validUntil']);
    const { guards, validUntil = Number.MAX_SAFE_INTEGER } = input;
    if (!Array.isArray(guards) || !guards.length || guards.length > MAX_TRANSACTION_RECORDS
      || !Number.isFinite(validUntil) || typeof this.adapter.verifyGuards !== 'function') throw transactionError();
    const encoded = guards.map(item => {
      checkedFields(item, ['scope', 'id', 'expectedVersion', 'validUntil']);
      if (typeof item.scope !== 'string' || !transactionScope.test(item.scope) || typeof item.id !== 'string'
        || !item.id || Buffer.byteLength(item.id) > 1024 || /\p{Cc}|\p{Cs}/u.test(item.id)
        || !(item.expectedVersion === null || typeof item.expectedVersion === 'string' && transactionRevision.test(item.expectedVersion))
        || item.validUntil !== undefined && !Number.isFinite(item.validUntil)) throw transactionError();
      return { key: recordKey(item.scope, item.id), expectedVersion: item.expectedVersion,
        ...(item.validUntil !== undefined ? { validUntil: item.validUntil } : {}) };
    });
    const transaction = { changes: [], guards: encoded, validUntil };
    checkedAtomic(transaction, { readOnly: true });
    return this.adapter.verifyGuards(transaction, this.now);
  }
  async take(scope, id) { return this.decode(scope, id, await this.adapter.take(recordKey(scope, id))); }
  async remove(scope, id, version) { return this.adapter.remove(recordKey(scope, id), version); }
  close() { this.adapter.close?.(); }
}
