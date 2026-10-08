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

const BASE = 1790000000000;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const ordinary = status => error => error instanceof IdentityFailure && error.status === status
  && !(error instanceof SessionOutputConflict) && !(error instanceof OutputGuardConflict);
const observe = promise => {
  const value = { settled: false };
  value.finished = promise.then(result => { value.result = result; value.settled = true; },
    error => { value.error = error; value.settled = true; });
  return value;
};

// Real encrypted storage, authorization and atomic guard verification. Only
// online policy and explicitly unknown/faulting storage interfaces are synthetic.
// Each output-classification call is forbidden from creating any authorization,
// projection or storage mutation; the external actor alone can perform CAS.
async function fixture(t, kind) {
  let monotonic = 0, checks = 0;
  const now = () => BASE, directory = mkdtempSync(join(tmpdir(), 'session-atomic-classification-'));
  const path = join(directory, 'owned.sqlite'), key = randomBytes(32), stores = [];
  const open = () => {
    const value = new EncryptedStore(kind === 'SQLite' ? new SQLiteAdapter(path, { now }) : new MemoryAdapter({ now }), key, now);
    stores.push(value); return value;
  };
  const store = open(), id = opaqueId(), settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const saved = { phase: 'active', issuer: 'urn:synthetic-atomic-classifier', sub: 'synthetic-member',
    userKey: identityKey('urn:synthetic-atomic-classifier', 'synthetic-member'), csrf: opaqueId(),
    accessToken: 'synthetic-atomic-classifier-token', expiresAt: BASE + 60000, idleUntil: BASE + 40000,
    lastIdentityCheck: BASE, clientId: 'synthetic-atomic-client', authTime: BASE / 1000 - 10, createdAt: BASE - 1 };
  await store.put('sessions', id, saved, BASE + 90000);
  await store.put('rooms', 'synthetic-guard', { marker: 1 }, BASE + 90000);
  const sessions = new SessionService(settings, { store, now, provider: { usesBatchIdentity: true,
    async check(identity) { checks++; return { ...identity }; } } });
  const controller = new AbortController();
  const context = createIdentityCheckContext({ now, monotonicNow: () => monotonic, signal: controller.signal });
  const request = new Request(settings.origin + '/api/state', { headers: { cookie: `${settings.cookieName}=${id}` } });
  const session = await sessions.authorize(request, { fresh: true, touch: false, context });
  const rawRead = store.read.bind(store), rawReplace = store.replaceCAS.bind(store), rawRemove = store.remove.bind(store);
  const rawVerify = store.verifyGuards.bind(store), rawPublic = sessions.publicSession.bind(sessions);
  const original = await rawRead('sessions', id), guard = await rawRead('rooms', 'synthetic-guard');
  const effects = { reads: 0, verifies: 0, writes: 0, authorize: 0, projection: 0 }, readFlights = [];
  let postRead = null, beforeVerify = null;
  store.read = async (scope, owner) => {
    if (scope !== 'sessions' || owner !== id) return rawRead(scope, owner);
    const finished = deferred(); readFlights.push(finished.promise);
    try { effects.reads++; return effects.reads === 2 && postRead ? await postRead() : await rawRead(scope, owner); }
    finally { finished.resolve(); }
  };
  store.verifyGuards = async input => { effects.verifies++; await beforeVerify?.(); return rawVerify(input); };
  for (const name of ['put', 'putIfAbsent', 'replace', 'replaceCAS', 'guardedCAS', 'compareAndSwapMany', 'remove', 'take']) {
    store[name] = () => { effects.writes++; assert.fail(`classification must not mutate storage via ${name}`); };
  }
  sessions.authorize = () => { effects.authorize++; assert.fail('classification must not authorize a replacement session'); };
  sessions.publicSession = () => { effects.projection++; assert.fail('classification must not project or return the post-read record'); };
  t.after(async () => {
    context.dispose(); await Promise.all(readFlights);
    assert.equal(effects.writes, 0); assert.equal(effects.authorize, 0); assert.equal(effects.projection, 0);
    assert.equal(checks, 1, 'only the initial actual authorization may check online identity');
    for (const value of stores) value.close(); rmSync(directory, { recursive: true, force: true });
  });
  async function edit(change) {
    const before = await rawRead('sessions', id), value = { ...before.value }; change(value);
    assert.equal(await rawReplace('sessions', id, before.version, value, before.expiresAt), true);
    const after = await rawRead('sessions', id); assert.notEqual(after.version, before.version); return after;
  }
  async function changeGuard() {
    assert.equal(await rawReplace('rooms', 'synthetic-guard', guard.version, { marker: 2 }, guard.expiresAt), true);
  }
  const output = (guards = []) => sessions.assertCurrent(session, { context, guards });
  const externalGuard = { scope: 'rooms', id: 'synthetic-guard', expectedVersion: guard.version };
  return { store, sessions, context, controller, effects, original, session, id, output, edit, changeGuard, externalGuard, rawRead, rawRemove,
    rawVerify, rawPublic, open, get checks() { return checks; },
    setBeforeVerify: operation => { beforeVerify = operation; }, setPostRead: operation => { postRead = operation; },
    advance: ms => { monotonic += ms; } };
}

for (const kind of ['Memory', 'SQLite']) {
  test(`${kind}: actual idle CAS after the initial read yields typed session conflict only after real atomic false`, async t => {
    const f = await fixture(t, kind); let renewed, actual;
    f.setBeforeVerify(async () => { renewed = await f.edit(value => { value.idleUntil += 1000; value.lastIdentityCheck++; }); });
    f.store.verifyGuards = async input => {
      f.effects.verifies++; renewed = await f.edit(value => { value.idleUntil += 1000; value.lastIdentityCheck++; });
      actual = await f.rawVerify(input); return actual;
    };
    await assert.rejects(f.output(), error => error instanceof SessionOutputConflict && error.status === 503);
    assert.equal(actual, false); assert.equal(f.effects.reads, 2); assert.equal(f.effects.verifies, 1);
    assert.equal(f.rawPublic(f.id, renewed.value, renewed.version).authorizationLineage, f.session.authorizationLineage);
    assert.equal((await f.rawRead('sessions', f.id)).version, renewed.version);
    assert.equal(f.context.deadlineMs - f.context.triggeredAtMs, 8000);
  });

  test(`${kind}: actual CSRF login CAS before atomic false remains ordinary 503`, async t => {
    const f = await fixture(t, kind); let changed, actual;
    f.store.verifyGuards = async input => {
      f.effects.verifies++; changed = await f.edit(value => { value.csrf = 'synthetic-new-login'; });
      actual = await f.rawVerify(input); return actual;
    };
    await assert.rejects(f.output(), ordinary(503)); assert.equal(actual, false); assert.equal(f.effects.reads, 2);
    assert.notEqual(f.rawPublic(f.id, changed.value, changed.version).authorizationLineage, f.session.authorizationLineage);
    assert.equal((await f.rawRead('sessions', f.id)).version, changed.version);
  });

  for (const change of ['subject', 'missing', 'expiry']) {
    test(`${kind}: real ${change} mutation between read and atomic false refuses as 401 before conflict classification`, async t => {
      const f = await fixture(t, kind); let current, actual;
      f.store.verifyGuards = async input => {
        f.effects.verifies++;
        if (change === 'missing') assert.equal(await f.rawRemove('sessions', f.id, f.original.version), true);
        else current = await f.edit(value => {
          if (change === 'subject') { value.sub = 'synthetic-other-member'; value.userKey = identityKey(value.issuer, value.sub); }
          else value.expiresAt = BASE;
        });
        actual = await f.rawVerify(input); return actual;
      };
      await assert.rejects(f.output(), ordinary(401)); assert.equal(actual, false); assert.equal(f.effects.reads, 2);
      const saved = await f.rawRead('sessions', f.id);
      if (change === 'missing') assert.equal(saved, null);
      else assert.equal(saved.version, current.version, 'classification itself cannot delete a changed or expired session');
    });
  }

  test(`${kind}: same session version plus a real external owner guard failure stays OutputGuardConflict`, async t => {
    const f = await fixture(t, kind); await f.changeGuard(); let actual;
    f.store.verifyGuards = async input => { f.effects.verifies++; actual = await f.rawVerify(input); return actual; };
    await assert.rejects(f.output([f.externalGuard]), error => error instanceof OutputGuardConflict && error.status === 503);
    assert.equal(actual, false); assert.equal(f.effects.reads, 2); assert.equal(f.effects.verifies, 1);
    assert.equal((await f.rawRead('sessions', f.id)).version, f.session.authorizationVersion);
  });

  test(`${kind}: undefined or thrown verification, and actual SQLite busy where applicable, never enter post-read classification`, async t => {
    for (const mode of ['undefined', 'throw', ...(kind === 'SQLite' ? ['busy'] : [])]) {
      const f = await fixture(t, kind), failure = new Error('synthetic atomic I/O failure'); let actualError, peer;
      f.store.verifyGuards = async input => {
        f.effects.verifies++;
        if (mode === 'undefined') return undefined;
        if (mode === 'throw') throw failure;
        try { return await f.rawVerify(input); } catch (error) { actualError = error; throw error; }
      };
      if (mode === 'busy') { peer = f.open(); peer.adapter.db.exec('BEGIN IMMEDIATE'); }
      try {
        await assert.rejects(f.output(), mode === 'undefined' ? ordinary(503)
          : error => error === (mode === 'throw' ? failure : actualError) && !(error instanceof SessionOutputConflict));
        if (mode === 'busy') assert.match(actualError.message, /locked|busy/i);
        assert.equal(f.effects.reads, 1); assert.equal(f.effects.verifies, 1);
      } finally { if (peer) peer.adapter.db.exec('ROLLBACK'); }
    }
  });

  test(`${kind}: a genuinely pending post-false read cannot classify or authorize before its eventual failure`, async t => {
    const f = await fixture(t, kind); await f.changeGuard();
    const entered = deferred(), release = deferred(), settled = deferred(), failure = new Error('synthetic post-read I/O failure');
    f.setPostRead(async () => {
      entered.resolve(); try { await release.promise; throw failure; } finally { settled.resolve(); }
    });
    const result = observe(f.output([f.externalGuard]));
    try {
      await entered.promise; await nextTurn(); assert.equal(result.settled, false); assert.equal(f.effects.reads, 2);
      assert.equal(f.effects.verifies, 1); assert.equal(f.checks, 1);
      release.resolve(); await result.finished; await settled.promise;
      assert.equal(result.error, failure); assert.equal(result.result, undefined);
      assert.equal(result.error instanceof SessionOutputConflict, false);
    } finally { release.resolve(); }
  });

  test(`${kind}: cancellation or the original deadline during unknown post-read never becomes typed recovery and does not claim read settlement`, async t => {
    for (const mode of ['cancel', 'deadline']) {
      const f = await fixture(t, kind); await f.changeGuard();
      const entered = deferred(), release = deferred(); let readSettled = false;
      f.setPostRead(async () => { entered.resolve(); try { await release.promise; return f.rawRead('sessions', f.id); } finally { readSettled = true; } });
      const trigger = f.context.triggeredAtMs, deadline = f.context.deadlineMs, result = observe(f.output([f.externalGuard]));
      try {
        await entered.promise;
        if (mode === 'cancel') f.controller.abort();
        else { f.advance(8000); assert.throws(() => f.context.assert(), ordinary(503)); }
        await result.finished; assert.ok(ordinary(503)(result.error)); assert.equal(result.result, undefined);
        assert.equal(readSettled, false, 'the cancelled caller cannot announce completion of its actual unknown read');
        assert.equal(f.effects.reads, 2); assert.equal(f.effects.verifies, 1); assert.equal(f.checks, 1);
        assert.equal(f.context.triggeredAtMs, trigger); assert.equal(f.context.deadlineMs, deadline);
        release.resolve(); await nextTurn(); assert.equal(readSettled, true); assert.equal(result.result, undefined);
      } finally { release.resolve(); }
    }
  });
}
