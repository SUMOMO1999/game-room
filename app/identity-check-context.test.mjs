import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIdentityCheckContext } from '../server/identity-check-context.mjs';
import { withIdentityDeadline } from '../server/auth.mjs';
import { SessionService } from '../server/session-service.mjs';
import { readSettings } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter, identityKey, opaqueId } from '../server/storage.mjs';

const unavailable = error => error.status === 503;
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };

test('an original monotonic budget survives wall-clock movement and nested authorization', async () => {
  let wall = 1_000_000, monotonic = 100;
  const context = createIdentityCheckContext({ now: () => wall, monotonicNow: () => monotonic });
  try {
    monotonic += 3500; wall -= 100_000;
    const result = await withIdentityDeadline(async inner => {
      assert.equal(inner, context);
      assert.equal(inner.triggeredAtMs, 1_000_000);
      assert.equal(inner.queueUntilMs, 1_004_000);
      assert.equal(inner.remainingMs(), 4500);
      return inner.wait(() => 7);
    }, { context });
    assert.equal(result, 7);
    monotonic += 4500;
    await assert.rejects(context.wait(() => assert.fail('expired work started')), unavailable);
  } finally { context.dispose(); }
});

test('cancellation fences late success without claiming that the external work stopped', async () => {
  const cancellation = new AbortController(), completion = deferred();
  const context = createIdentityCheckContext({ signal: cancellation.signal });
  let ended = false;
  const external = completion.promise.then(() => { ended = true; return 'private'; });
  const waiting = context.wait(external);
  cancellation.abort();
  await assert.rejects(waiting, unavailable);
  assert.equal(ended, false);
  completion.resolve(); await external;
  assert.equal(ended, true);
  assert.equal(context.isLive(), false);
  context.dispose(); context.dispose();
});

test('disposing the owner rejects outstanding waiters and blocks newly scheduled work', async () => {
  const context = createIdentityCheckContext(), external = deferred();
  const waiting = context.wait(external.promise);
  context.dispose();
  await assert.rejects(waiting, unavailable);
  await assert.rejects(context.wait(() => assert.fail('disposed context started work')), unavailable);
  external.resolve();
});

test('invalid clocks, durations and signals cannot create an authorization context', () => {
  for (const options of [{ timeoutMs: 8001 }, { queueMs: 4001 }, { now: () => NaN },
    { now: () => 1.5 }, { monotonicNow: () => Infinity }, { signal: {} }]) {
    assert.throws(() => createIdentityCheckContext(options), TypeError);
  }
});

test('a shorter nested budget restricts the original trigger, and cannot subsequently be enlarged', async () => {
  let monotonic = 0;
  const context = createIdentityCheckContext({ now: () => 1_000_000, monotonicNow: () => monotonic });
  try {
    monotonic = 8;
    await withIdentityDeadline(inner => { assert.equal(inner.remainingMs(), 2); return 'allowed'; }, { context, timeoutMs: 10 });
    assert.equal(context.deadlineMs, 1_000_010);
    assert.equal(context.queueUntilMs, 1_000_010);
    monotonic = 10;
    await assert.rejects(withIdentityDeadline(() => 'late', { context, timeoutMs: 8000 }), unavailable);
  } finally { context.dispose(); }
});

async function sessionFixture(t) {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const store = new EncryptedStore(new MemoryAdapter(), randomBytes(32));
  const now = Date.now(), id = opaqueId();
  const saved = { phase: 'active', issuer: 'urn:game-room:synthetic', sub: 'context-member',
    userKey: identityKey('urn:game-room:synthetic', 'context-member'), csrf: opaqueId(),
    accessToken: 'synthetic-context-only', expiresAt: now + 60000, idleUntil: now + 60000 };
  await store.put('sessions', id, saved, saved.expiresAt);
  const seen = [];
  const provider = { usesBatchIdentity: true, async check(identity, options) {
    seen.push(options.context); options.context.assert(); return { ...identity };
  } };
  const sessions = new SessionService(settings, { store, provider });
  const request = new Request(settings.origin, { headers: { cookie: `${settings.cookieName}=${id}` } });
  t.after(() => store.close());
  return { settings, store, id, provider, sessions, request, seen };
}

test('batch drawing requests coalesce idle renewal writes while every request still obtains fresh identity', async t => {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const base = Date.now(); let time = base, checks = 0;
  const store = new EncryptedStore(new MemoryAdapter({ now: () => time }), randomBytes(32), () => time);
  t.after(() => store.close());
  const id = opaqueId(), issuer = 'urn:game-room:synthetic-idle', sub = 'idle-member';
  const session = { phase: 'active', issuer, sub, userKey: identityKey(issuer, sub), csrf: opaqueId(),
    accessToken: 'synthetic-only', expiresAt: base + 3600000, idleUntil: base + settings.idleMs };
  await store.put('sessions', id, session, session.idleUntil);
  const sessions = new SessionService(settings, { store, now: () => time, provider: {
    usesBatchIdentity: true, async check(identity) { checks++; return { ...identity }; },
  } });
  const request = new Request(settings.origin, { headers: { cookie: `${settings.cookieName}=${id}` } });
  const before = await store.read('sessions', id);
  for (const elapsed of [0, 500, 1000, 15000, 29999]) {
    time = base + elapsed;
    const authorized = await sessions.authorize(request);
    await sessions.assertCurrent(authorized);
    assert.equal(authorized.authorizationVersion, before.version);
    assert.equal(authorized.idleUntil, session.idleUntil);
  }
  assert.equal(checks, 5);
  assert.equal((await store.read('sessions', id)).version, before.version);
  time = base + 30000;
  const renewed = await sessions.authorize(request);
  assert.equal(checks, 6);
  assert.equal(renewed.idleUntil, time + settings.idleMs);
  assert.notEqual(renewed.authorizationVersion, before.version);
  await sessions.assertCurrent(renewed);
});

test('SessionService passes one caller-owned context through fresh checks and keeps its version private', async t => {
  const f = await sessionFixture(t), context = createIdentityCheckContext();
  try {
    const first = await f.sessions.authorize(f.request, { context });
    await f.sessions.assertCurrent(first, { context });
    const next = await f.sessions.authorize(f.request, { context, touch: false });
    assert.deepEqual(f.seen, [context, context]);
    assert.equal(context.isLive(), true);
    assert.equal(typeof next.authorizationVersion, 'string');
    assert.equal(JSON.stringify(next).includes('authorizationVersion'), false);
    assert.equal(JSON.stringify(next).includes('synthetic-context-only'), false);
  } finally { context.dispose(); }
});

test('a late output cannot borrow the authorization of a renewed session or logged-out session', async t => {
  const f = await sessionFixture(t), context = createIdentityCheckContext();
  try {
    const authorized = await f.sessions.authorize(f.request, { context, touch: false });
    const record = await f.store.read('sessions', f.id);
    await f.store.replaceCAS('sessions', f.id, record.version, { ...record.value, csrf: opaqueId() }, record.expiresAt);
    await assert.rejects(f.sessions.assertCurrent(authorized, { context }), unavailable);
    assert.ok(await f.store.read('sessions', f.id), 'availability failure cannot log out a renewed session');
    await f.store.remove('sessions', f.id);
    await assert.rejects(f.sessions.assertCurrent(authorized, { context }), error => error.status === 401);
  } finally { context.dispose(); }
});

test('room membership changed during the last session read suppresses output without changing the account', async t => {
  const f = await sessionFixture(t), context = createIdentityCheckContext();
  try {
    await f.store.put('synthetic-membership', 'room', { seated: true });
    const member = await f.store.read('synthetic-membership', 'room');
    const session = await f.sessions.authorize(f.request, { context, touch: false });
    const read = f.store.read.bind(f.store);
    let changed = false;
    f.store.read = async (...args) => {
      const result = await read(...args);
      if (!changed && args[0] === 'sessions') {
        changed = true;
        await f.store.replaceCAS('synthetic-membership', 'room', member.version, { seated: false });
      }
      return result;
    };
    await assert.rejects(f.sessions.assertCurrent(session, { context,
      guards: [{ scope: 'synthetic-membership', id: 'room', expectedVersion: member.version }] }), unavailable);
    assert.ok(await f.store.read('sessions', f.id));
  } finally { context.dispose(); }
});

test('the caller context cannot extend a shorter SessionService timeout', async t => {
  const f = await sessionFixture(t), context = createIdentityCheckContext();
  f.sessions.authorizationTimeoutMs = 10;
  const completion = deferred();
  f.provider.check = async () => completion.promise;
  try {
    await assert.rejects(f.sessions.authorize(f.request, { context }), unavailable);
    assert.equal(context.deadlineMs - context.triggeredAtMs, 10);
    assert.ok(await f.store.read('sessions', f.id));
  } finally { completion.resolve({ sub: 'context-member' }); context.dispose(); }
});
