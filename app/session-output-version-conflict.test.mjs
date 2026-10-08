import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityFailure } from '../server/auth.mjs';
import { readSettings } from '../server/config.mjs';
import { createIdentityCheckContext } from '../server/identity-check-context.mjs';
import { SessionService } from '../server/session-service.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { OutputGuardConflict, SessionOutputConflict } from '../server/room-output-fence.mjs';

// Storage, authorize and the final session fence are real. Only the upstream
// online identity response and deliberately stalled/faulting I/O are synthetic.
const BASE = 1790000000000;
const ordinary = status => error => error instanceof IdentityFailure && error.status === status
  && !(error instanceof SessionOutputConflict) && !(error instanceof OutputGuardConflict);
const deferred = () => {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
};

async function fixture(t, kind) {
  let wall = BASE, monotonic = 0, checks = 0;
  const now = () => wall, directory = mkdtempSync(join(tmpdir(), 'session-output-version-'));
  const path = join(directory, 'sessions.sqlite'), key = randomBytes(32), stores = [], contexts = [];
  const open = () => {
    const store = new EncryptedStore(kind === 'SQLite' ? new SQLiteAdapter(path, { now }) : new MemoryAdapter({ now }), key, now);
    stores.push(store); return store;
  };
  const store = open(), settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), id = opaqueId();
  const saved = { phase: 'active', issuer: 'urn:session-output-fixture', sub: 'synthetic-member',
    userKey: identityKey('urn:session-output-fixture', 'synthetic-member'), csrf: opaqueId(),
    accessToken: 'synthetic-session-token', expiresAt: BASE + 60000, idleUntil: BASE + 40000,
    lastIdentityCheck: BASE, clientId: 'syntheticclient1234', authTime: BASE / 1000 - 10,
    createdAt: BASE - 1, transactionId: 'synthetic-activation', securityExtension: { mode: 'original' } };
  // Keep this backing row longer than its business expiry so the expiry-field
  // check is exercised separately from an expired/missing adapter record.
  await store.put('sessions', id, saved, BASE + 90000);
  const sessions = new SessionService(settings, { store, now, provider: { usesBatchIdentity: true,
    async check(identity) { checks++; return { ...identity }; } } });
  const events = []; sessions.subscribeInvalidation(event => events.push(event));
  const request = new Request(settings.origin + '/api/state', { headers: { cookie: `${settings.cookieName}=${id}` } });
  const context = signal => {
    const value = createIdentityCheckContext({ now, monotonicNow: () => monotonic, signal });
    contexts.push(value); return value;
  };
  const edit = async change => {
    const before = await store.read('sessions', id);
    assert.equal(await store.replaceCAS('sessions', id, before.version, change(before.value), before.expiresAt), true);
    return store.read('sessions', id);
  };
  t.after(() => {
    for (const owned of contexts) owned.dispose();
    for (const value of stores) value.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, sessions, id, context, edit, open, events,
    authorize: owned => sessions.authorize(request, { fresh: true, touch: false, context: owned }),
    advance(ms) { wall += ms; monotonic += ms; },
    get checks() { return checks; } };
}

for (const kind of ['Memory', 'SQLite']) {
  test(`${kind}: an unchanged freshly authorized version passes its real atomic fence without another online check`, async t => {
    const f = await fixture(t, kind), owned = f.context(), authorized = await f.authorize(owned);
    const before = await f.store.read('sessions', f.id);
    assert.equal(authorized.authorizationVersion, before.version);
    assert.equal(Object.keys(authorized).includes('authorizationVersion'), false);
    assert.match(authorized.authorizationLineage, /^[a-f0-9]{64}$/);
    assert.equal(Object.keys(authorized).includes('authorizationLineage'), false);
    assert.equal(JSON.stringify(authorized).includes('authorizationLineage'), false);
    assert.equal(JSON.stringify(authorized).includes('synthetic-session-token'), false);
    assert.equal(await f.sessions.assertCurrent(authorized, { context: owned }), undefined);
    assert.equal((await f.store.read('sessions', f.id)).version, before.version);
    assert.equal(f.checks, 1); assert.deepEqual(f.events, []);
  });

  test(`${kind}: a committed activity renewal classifies the old output as a typed 503 and preserves the new session`, async t => {
    const f = await fixture(t, kind), owned = f.context(), authorized = await f.authorize(owned);
    const renewed = await f.edit(value => ({ ...value, idleUntil: value.idleUntil + 1000, lastIdentityCheck: BASE + 1 }));
    assert.notEqual(renewed.version, authorized.authorizationVersion);
    await assert.rejects(f.sessions.assertCurrent(authorized, { context: owned }), error => {
      assert.ok(error instanceof SessionOutputConflict); assert.ok(error instanceof IdentityFailure);
      assert.equal(error instanceof OutputGuardConflict, false); assert.equal(error.status, 503);
      assert.equal(error.code, 'identity_unavailable'); assert.equal(error.message.includes('synthetic-session-token'), false);
      return true;
    });
    assert.equal((await f.store.read('sessions', f.id)).version, renewed.version);
    assert.equal(f.checks, 1); assert.deepEqual(f.events, []);
  });

  for (const field of ['csrf', 'accessToken', 'entryKey', 'clientId', 'authTime', 'createdAt', 'transactionId', 'securityExtension']) {
    test(`${kind}: changing ${field} is an ordinary 503, never an activity-renewal conflict`, async t => {
      const f = await fixture(t, kind), owned = f.context(), authorized = await f.authorize(owned);
      const changed = field === 'authTime' || field === 'createdAt' ? BASE / 1000 - 9
        : field === 'securityExtension' ? { mode: 'changed' } : `changed-${field}`;
      const renewed = await f.edit(value => ({ ...value, [field]: changed }));
      await assert.rejects(f.sessions.assertCurrent(authorized, { context: owned }), ordinary(503));
      const current = await f.store.read('sessions', f.id);
      assert.equal(current.version, renewed.version); assert.deepEqual(current.value[field], changed);
      assert.equal(authorized.authorizationVersion === renewed.version, false);
      assert.equal(f.checks, 1); assert.deepEqual(f.events, []);
    });
  }

  test(`${kind}: a missing session remains 401 rather than a recoverable version conflict`, async t => {
    const f = await fixture(t, kind), authorized = await f.authorize(f.context());
    assert.equal(await f.store.remove('sessions', f.id), true);
    await assert.rejects(f.sessions.assertCurrent(authorized), ordinary(401));
    assert.equal(await f.store.read('sessions', f.id), null); assert.equal(f.checks, 1);
  });

  test(`${kind}: an inactive new version remains 401 before the version comparison`, async t => {
    const f = await fixture(t, kind), authorized = await f.authorize(f.context());
    const current = await f.edit(value => ({ ...value, phase: 'pending' }));
    await assert.rejects(f.sessions.assertCurrent(authorized), ordinary(401));
    assert.equal((await f.store.read('sessions', f.id)).version, current.version);
  });

  test(`${kind}: same-version receiver identity mismatches remain 401 for each binding field`, async t => {
    const f = await fixture(t, kind), authorized = await f.authorize(f.context());
    for (const field of ['userKey', 'issuer', 'sub']) {
      const original = authorized[field]; authorized[field] = `other-${field}`;
      await assert.rejects(f.sessions.assertCurrent(authorized), ordinary(401));
      authorized[field] = original;
    }
    assert.equal((await f.store.read('sessions', f.id)).version, authorized.authorizationVersion);
    assert.equal(f.checks, 1); assert.deepEqual(f.events, []);
  });

  test(`${kind}: changed stored identity is rejected as 401 before classifying its new version`, async t => {
    const f = await fixture(t, kind), authorized = await f.authorize(f.context());
    for (const field of ['userKey', 'issuer', 'sub']) {
      const original = (await f.store.read('sessions', f.id)).value[field];
      await f.edit(value => ({ ...value, [field]: `other-${field}` }));
      await assert.rejects(f.sessions.assertCurrent(authorized), ordinary(401));
      await f.edit(value => ({ ...value, [field]: original }));
    }
    assert.equal(f.checks, 1); assert.deepEqual(f.events, []);
  });

  test(`${kind}: changed stored expiry is rejected as 401 before classifying its new version`, async t => {
    const f = await fixture(t, kind), authorized = await f.authorize(f.context());
    await f.edit(value => ({ ...value, idleUntil: BASE }));
    await assert.rejects(f.sessions.assertCurrent(authorized), ordinary(401));
    await f.edit(value => ({ ...value, idleUntil: BASE + 40000, expiresAt: BASE }));
    await assert.rejects(f.sessions.assertCurrent(authorized), ordinary(401));
    assert.equal(f.checks, 1); assert.deepEqual(f.events, []);
  });

  test(`${kind}: top-level saved field order cannot turn an activity-only version into a new activation lineage`, async t => {
    const f = await fixture(t, kind), owned = f.context(), authorized = await f.authorize(owned);
    await f.edit(value => Object.fromEntries(Object.entries(value).reverse()));
    await assert.rejects(f.sessions.assertCurrent(authorized, { context: owned }), SessionOutputConflict);
    const refreshed = await f.authorize(owned);
    assert.equal(refreshed.authorizationLineage, authorized.authorizationLineage);
    assert.notEqual(refreshed.authorizationVersion, authorized.authorizationVersion);
    assert.equal(await f.sessions.assertCurrent(refreshed, { context: owned }), undefined);
    assert.equal(f.checks, 2);
  });

  test(`${kind}: adding or deleting an unknown saved security field cannot become an activity renewal`, async t => {
    const f = await fixture(t, kind), owned = f.context(), authorized = await f.authorize(owned);
    await f.edit(value => ({ ...value, futureSecurityRule: ['new-binding'] }));
    await assert.rejects(f.sessions.assertCurrent(authorized, { context: owned }), ordinary(503));
    const refreshed = await f.authorize(owned);
    assert.notEqual(refreshed.authorizationLineage, authorized.authorizationLineage);
    await f.edit(value => { delete value.futureSecurityRule; return value; });
    await assert.rejects(f.sessions.assertCurrent(refreshed, { context: owned }), ordinary(503));
  });

  test(`${kind}: missing or mismatched hidden lineage fails closed even for the same stored version`, async t => {
    const f = await fixture(t, kind), owned = f.context(), authorized = await f.authorize(owned);
    const missing = { ...authorized }, mismatched = { ...authorized };
    Object.defineProperty(missing, 'authorizationVersion', { value: authorized.authorizationVersion });
    Object.defineProperties(mismatched, { authorizationVersion: { value: authorized.authorizationVersion },
      authorizationLineage: { value: '0'.repeat(64) } });
    await assert.rejects(f.sessions.assertCurrent(missing, { context: owned }), ordinary(503));
    await assert.rejects(f.sessions.assertCurrent(mismatched, { context: owned }), ordinary(503));
    await f.edit(value => ({ ...value, idleUntil: value.idleUntil + 1000 }));
    await assert.rejects(f.sessions.assertCurrent(missing, { context: owned }), ordinary(503));
    await assert.rejects(f.sessions.assertCurrent(mismatched, { context: owned }), ordinary(503));
  });

  for (const [label, elapsed] of [['idle', 40000], ['absolute', 60000]]) {
    test(`${kind}: same-version ${label} expiry remains 401 while the encrypted row is still retained`, async t => {
      const f = await fixture(t, kind), authorized = await f.authorize(f.context()); f.advance(elapsed);
      assert.ok(await f.store.read('sessions', f.id));
      await assert.rejects(f.sessions.assertCurrent(authorized), ordinary(401));
      assert.equal((await f.store.read('sessions', f.id)).version, authorized.authorizationVersion);
    });
  }

  test(`${kind}: backing-record expiry remains a missing-session 401`, async t => {
    const f = await fixture(t, kind), authorized = await f.authorize(f.context()); f.advance(90000);
    assert.equal(await f.store.read('sessions', f.id), null);
    await assert.rejects(f.sessions.assertCurrent(authorized), ordinary(401));
  });

  test(`${kind}: a completed false external guard is still OutputGuardConflict, not SessionOutputConflict`, async t => {
    const f = await fixture(t, kind), owned = f.context(), authorized = await f.authorize(owned);
    await assert.rejects(f.sessions.assertCurrent(authorized, { context: owned,
      guards: [{ scope: 'room-presence', id: 'absent-presence', expectedVersion: opaqueId() }] }), error =>
      error instanceof OutputGuardConflict && !(error instanceof SessionOutputConflict) && error.status === 503);
    assert.equal((await f.store.read('sessions', f.id)).version, authorized.authorizationVersion);
  });

  test(`${kind}: an unknown guard result stays ordinary 503 and a thrown storage fault keeps its original error`, async t => {
    const f = await fixture(t, kind), owned = f.context(), authorized = await f.authorize(owned);
    f.store.verifyGuards = async () => undefined;
    await assert.rejects(f.sessions.assertCurrent(authorized, { context: owned }), ordinary(503));
    const failure = new Error('synthetic unavailable storage'); f.store.verifyGuards = async () => { throw failure; };
    await assert.rejects(f.sessions.assertCurrent(authorized, { context: owned }), error => error === failure);
    assert.equal((await f.store.read('sessions', f.id)).version, authorized.authorizationVersion);
    assert.equal(f.checks, 1); assert.deepEqual(f.events, []);
  });

  for (const stop of ['cancel', 'deadline']) {
    test(`${kind}: ${stop} while the real session read waits does not become a version conflict or claim read completion`, async t => {
      const f = await fixture(t, kind), cancellation = new AbortController(), owned = f.context(cancellation.signal);
      const authorized = await f.authorize(owned), read = f.store.read.bind(f.store), entered = deferred(), release = deferred();
      let finished = false, guards = 0;
      const verify = f.store.verifyGuards.bind(f.store);
      f.store.verifyGuards = input => { guards++; return verify(input); };
      f.store.read = async (...args) => { const value = await read(...args); entered.resolve(); await release.promise; finished = true; return value; };
      const rejected = assert.rejects(f.sessions.assertCurrent(authorized, { context: owned }), ordinary(503));
      await entered.promise;
      if (stop === 'cancel') { cancellation.abort(); await rejected; assert.equal(finished, false); }
      else f.advance(8000);
      release.resolve(); await rejected; await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished, true); assert.equal(guards, 0); assert.equal(f.checks, 1);
      assert.equal((await read('sessions', f.id)).version, authorized.authorizationVersion);
    });
  }

  test(`${kind}: already cancelled or expired original contexts start neither session reads nor final guards`, async t => {
    const f = await fixture(t, kind), authorized = await f.authorize(f.context()), read = f.store.read.bind(f.store);
    let reads = 0; f.store.read = (...args) => { reads++; return read(...args); };
    const cancellation = new AbortController(), cancelled = f.context(cancellation.signal); cancellation.abort();
    await assert.rejects(f.sessions.assertCurrent(authorized, { context: cancelled }), ordinary(503));
    const expired = f.context(); f.advance(8000);
    await assert.rejects(f.sessions.assertCurrent(authorized, { context: expired }), ordinary(503));
    assert.equal(reads, 0); assert.equal(f.checks, 1);
  });
}

test('SQLite: a real competing writer lock remains an unretried storage fault and keeps the session version', async t => {
  const f = await fixture(t, 'SQLite'), owned = f.context(), authorized = await f.authorize(owned), other = f.open();
  other.adapter.db.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(f.sessions.assertCurrent(authorized, { context: owned }), error =>
      !(error instanceof SessionOutputConflict) && !(error instanceof OutputGuardConflict) && /locked/.test(error.message));
  } finally { other.adapter.db.exec('ROLLBACK'); }
  assert.equal((await f.store.read('sessions', f.id)).version, authorized.authorizationVersion);
  assert.equal(f.checks, 1); assert.deepEqual(f.events, []);
});
