import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter } from '../server/storage.mjs';

for (const [name, adapter] of [['memory', now => new MemoryAdapter({ now })], ['sqlite', now => new SQLiteAdapter(':memory:', { now })]]) {
  test(`${name}: one output guard decision checks all owners without writes or expiry renewal`, async t => {
    let time = 1000;
    const store = new EncryptedStore(adapter(() => time), randomBytes(32), () => time);
    t.after(() => store.close());
    const owners = ['synthetic-account', 'synthetic-membership', 'synthetic-inventory'];
    for (const scope of owners) await store.put(scope, 'same-id', { scope, value: 1 }, 2000);
    const records = await Promise.all(owners.map(scope => store.read(scope, 'same-id')));
    const guards = owners.map((scope, index) => ({ scope, id: 'same-id', expectedVersion: records[index].version }));
    assert.equal(await store.verifyGuards({ guards, validUntil: 1900 }), true);
    assert.deepEqual(await Promise.all(owners.map(scope => store.read(scope, 'same-id'))), records);
    await store.replaceCAS(owners[2], 'same-id', records[2].version, { value: 2 }, 2000);
    assert.equal(await store.verifyGuards({ guards, validUntil: 1900 }), false);
    time = 2000;
    assert.equal(await store.verifyGuards({ guards, validUntil: 2000 }), false);
    assert.equal(await store.verifyGuards({ guards: [{ scope: 'synthetic-missing', id: 'absent', expectedVersion: null }], validUntil: 2001 }), true);
    await assert.rejects(store.compareAndSwapMany({ changes: [], guards }), TypeError);
  });
  test(`${name}: malformed or conflicting guards reject before any private output decision`, async t => {
    const store = new EncryptedStore(adapter(), randomBytes(32));
    t.after(() => store.close());
    for (const guards of [[], [{ scope: 'bad/scope', id: 'x', expectedVersion: null }],
      [{ scope: 'ok', id: 'x', expectedVersion: 'invalid' }],
      [{ scope: 'ok', id: 'x', expectedVersion: null, value: 'not-a-write' }]]) {
      await assert.rejects(store.verifyGuards({ guards }), TypeError);
    }
  });
}

test('SQLite output guards fail promptly on another connection lock and restore its ordinary write timeout', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'output-guard-lock-'));
  const first = new SQLiteAdapter(join(folder, 'guards.sqlite'));
  const second = new SQLiteAdapter(join(folder, 'guards.sqlite'));
  const store = new EncryptedStore(second, randomBytes(32));
  let locked = false;
  t.after(() => { if (locked) first.db.exec('ROLLBACK'); first.close(); store.close(); rmSync(folder, { recursive: true, force: true }); });
  first.db.exec('BEGIN IMMEDIATE'); locked = true;
  const started = performance.now();
  await assert.rejects(store.verifyGuards({ guards: [{ scope: 'synthetic', id: 'absent', expectedVersion: null }] }), /locked/);
  assert.ok(performance.now() - started < 250, 'guard waited for the ordinary five-second write timeout');
  assert.equal(second.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  first.db.exec('ROLLBACK'); locked = false;
  assert.equal(await store.verifyGuards({ guards: [{ scope: 'synthetic', id: 'absent', expectedVersion: null }] }), true);
  assert.equal(second.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
});
