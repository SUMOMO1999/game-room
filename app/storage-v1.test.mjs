import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryAdapter, SQLiteAdapter, EncryptedStore, recordKey, identityKey } from '../server/storage.mjs';

test('encrypted records bind scope and hashed key, reject tampering, and honor expiry', async () => {
  let now = 1000;
  const adapter = new MemoryAdapter({ now: () => now }); const store = new EncryptedStore(adapter, randomBytes(32), () => now);
  await store.put('sessions', 'unguessable-cookie', { accessToken: 'secret-token', nested: [1] }, 2000);
  const raw = await adapter.get(recordKey('sessions', 'unguessable-cookie'));
  assert.equal(raw.payload.includes('secret-token'), false);
  assert.equal([...adapter.records.keys()][0].includes('unguessable-cookie'), false);
  await adapter.put(recordKey('sessions', 'other-cookie'), raw);
  assert.equal(await store.get('sessions', 'other-cookie'), null);
  await adapter.put(recordKey('profiles', 'unguessable-cookie'), raw);
  assert.equal(await store.get('profiles', 'unguessable-cookie'), null);
  assert.equal((await store.get('sessions', 'unguessable-cookie')).accessToken, 'secret-token');
  raw.payload = `${raw.payload.slice(0, -5)}AAAAA`;
  assert.equal(await store.get('sessions', 'unguessable-cookie'), null);
  await store.put('sessions', 'expired', { a: true }, 2000); now = 2000;
  assert.equal(await store.get('sessions', 'expired'), null);
});

test('identity key uses an unambiguous issuer-sub pair', () => {
  assert.notEqual(identityKey('https://issuer/a', 'same'), identityKey('https://issuer/b', 'same'));
  assert.notEqual(identityKey('a\0b', 'c'), identityKey('a', 'b\0c'));
  assert.match(identityKey('issuer', 'user'), /^[a-f0-9]{64}$/);
});

async function exerciseAtomic(store) {
  const expiresAt = Date.now() + 100000;
  const results = await Promise.all(Array.from({ length: 8 }, (_, count) => store.putIfAbsent('seats', 'member', { count }, expiresAt)));
  assert.equal(results.filter(Boolean).length, 1);
  const first = await store.read('seats', 'member'); const second = await store.read('seats', 'member');
  assert.equal(await store.replaceCAS('seats', 'member', first.version, { count: 9 }, expiresAt), true);
  assert.equal(await store.replaceCAS('seats', 'member', second.version, { count: 10 }, expiresAt), false);
  assert.equal((await store.get('seats', 'member')).count, 9);
  const current = await store.get('seats', 'member'); current.count = 11;
  assert.equal(await store.replace('seats', 'member', current, expiresAt), true);
  const old = await store.read('seats', 'member');
  await store.remove('seats', 'member');
  assert.equal(await store.replaceCAS('seats', 'member', old.version, { count: 12 }, expiresAt), false);
  await store.put('transactions', 'one-use', { state: 'random' }, expiresAt);
  const consumed = await Promise.all(Array.from({ length: 8 }, () => store.take('transactions', 'one-use')));
  assert.equal(consumed.filter(Boolean).length, 1);
}

test('memory adapter provides one winner for insert, CAS, and transaction consumption', async () => {
  const store = new EncryptedStore(new MemoryAdapter()); await exerciseAtomic(store);
});

async function exerciseExpiryCleanup(store, now, setTime) {
  await store.put('sessions', 'expired-cookie', { accessToken: 'synthetic-expired-token' }, 2000);
  const old = await store.read('sessions', 'expired-cookie');
  await store.put('transactions', 'expired-login', { verifier: 'synthetic-expired-verifier' }, 1500);
  await store.put('room-presence', 'expired-presence', { online: true }, 1100);
  await store.put('sessions', 'live-cookie', { accessToken: 'synthetic-live-token' }, 5000);
  await store.put('room-invites', '123456', { roomId: 'never-reused', retired: true });
  setTime(2000);
  assert.equal(await store.get('sessions', 'expired-cookie'), null);
  assert.equal(store.adapter.purgeExpired(), 3);
  assert.equal(await store.adapter.get(recordKey('sessions', 'expired-cookie')), undefined);
  assert.equal(await store.adapter.get(recordKey('transactions', 'expired-login')), undefined);
  assert.equal(await store.adapter.get(recordKey('room-presence', 'expired-presence')), undefined);
  assert.equal(await store.replaceCAS('sessions', 'expired-cookie', old.version, old.value, now() + 1000), false);
  assert.equal((await store.get('sessions', 'live-cookie')).accessToken, 'synthetic-live-token');
  assert.equal((await store.get('room-invites', '123456')).retired, true);
  assert.equal(store.adapter.purgeExpired(now()), 0);
  assert.throws(() => store.adapter.purgeExpired(Infinity), /finite time/);
}

test('memory expiration cleanup removes only elapsed records and cannot revive an expired cookie', async () => {
  let time = 1000;
  const now = () => time;
  const store = new EncryptedStore(new MemoryAdapter({ now }), randomBytes(32), now);
  await exerciseExpiryCleanup(store, now, (value) => { time = value; });
});

test('SQLite expiration cleanup preserves live sessions, permanent tombstones and the stable-key guard', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'game-room-expiry-test-'));
  const path = join(folder, 'test.sqlite'), key = randomBytes(32);
  let time = 1000, store;
  const now = () => time;
  try {
    store = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
    const metadata = store.adapter.db.prepare('SELECT name,value FROM game_metadata ORDER BY name').all();
    await exerciseExpiryCleanup(store, now, (value) => { time = value; });
    assert.deepEqual(store.adapter.db.prepare('SELECT name,value FROM game_metadata ORDER BY name').all(), metadata);
    assert.equal(store.adapter.db.prepare('SELECT count(*) AS n FROM game_records').get().n, 2);
    store.close(); store = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
    assert.equal(await store.get('sessions', 'expired-cookie'), null);
    assert.equal((await store.get('sessions', 'live-cookie')).accessToken, 'synthetic-live-token');
    assert.equal((await store.get('room-invites', '123456')).retired, true);
    assert.throws(() => new EncryptedStore(new SQLiteAdapter(path, { now }), randomBytes(32), now), /refusing to start/);
  } finally { store?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('SQLite preserves encrypted records across restart and supports independent-instance CAS', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'game-room-sqlite-test-')); const path = join(folder, 'game.sqlite'); const key = randomBytes(32);
  let first; let second;
  try {
    first = new EncryptedStore(new SQLiteAdapter(path), key); await exerciseAtomic(first);
    await first.put('room-invites', '123456', { roomId: 'never-reused', retired: true });
    await first.put('sessions', 'browser-cookie', { accessToken: 'secret-token-persisted' }, Date.now() + 100000);
    first.close(); first = new EncryptedStore(new SQLiteAdapter(path), key);
    assert.equal((await first.get('room-invites', '123456')).retired, true);
    assert.equal((await first.get('sessions', 'browser-cookie')).accessToken, 'secret-token-persisted');
    second = new EncryptedStore(new SQLiteAdapter(path), key);
    const before = await first.read('sessions', 'browser-cookie'); await second.remove('sessions', 'browser-cookie');
    assert.equal(await first.replaceCAS('sessions', 'browser-cookie', before.version, before.value, before.expiresAt), false);
    await first.put('rooms', '123456', { privateHand: [13, 12, 11] });
    const a = await first.read('rooms', '123456'); const b = await second.read('rooms', '123456');
    assert.equal(await first.replaceCAS('rooms', '123456', a.version, { privateHand: [1] }), true);
    assert.equal(await second.replaceCAS('rooms', '123456', b.version, { privateHand: [2] }), false);
    assert.equal(await second.remove('rooms', '123456', b.version), false);
    first.close(); first = null; second.close(); second = null;
    const bytes = await readFile(path); assert.equal(bytes.includes(Buffer.from('secret-token-persisted')), false); assert.equal(bytes.includes(Buffer.from('browser-cookie')), false);
  } finally { first?.close(); second?.close(); await rm(folder, { recursive: true, force: true }); }
});
