import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings } from '../server/config.mjs';
import { IdentityFailure } from '../server/auth.mjs';
import { SessionService } from '../server/session-service.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { backupStore, verifyBackup } from '../server/backup.mjs';

const BASE = Date.UTC(2026, 9, 8), DAY = 86400000, HOUR = 3600000;
const fail = status => error => error instanceof IdentityFailure && error.status === status;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const fingerprint = session => createHash('sha256').update(session.issuer + '\0' + session.sub).digest('hex');

// Synthetic provider grants, real encrypted records/CAS and controllable time.
// A retained login never stands in for a fresh private-operation permission.
async function fixture({ version = 2, adapter, key = randomBytes(32) } = {}) {
  let time = BASE;
  const now = () => time;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'retentiontestclient1234',
    GAME_ROOM_SESSION_REFRESH_ENABLED: '1', GAME_ROOM_SESSION_MAX_DAYS: '30' });
  adapter ||= new MemoryAdapter({ now });
  const store = new EncryptedStore(adapter, key, now), id = opaqueId();
  const saved = { phase: 'active', issuer: settings.issuer, sub: 'retained-member-a',
    userKey: identityKey(settings.issuer, 'retained-member-a'), clientId: settings.clientId,
    authTime: Math.floor(BASE / 1000) - 120, csrf: opaqueId(), createdAt: BASE,
    accessToken: 'server-only-old-access', expiresAt: BASE + HOUR, idleUntil: BASE + 1800000,
    lastIdentityCheck: BASE,
    ...(version === 2 ? { sessionVersion: 2, sessionExpiresAt: BASE + 30 * DAY, refreshIssuedAt: BASE,
      refreshExpiresAt: BASE + 30 * DAY, refreshToken: 'server-only-refresh-secret' } : {}) };
  await store.put('sessions', id, saved, saved.sessionExpiresAt ?? saved.idleUntil);
  const business = { userKey: saved.userKey, seatId: 'stable-seat', matchId: 'kept-match', rack: ['private-tile'] };
  await store.put('rooms', 'kept-business', business);
  const provider = { checks: [], refreshes: [], checkStatus: 200, refreshStatus: 200,
    async check(identity) { this.checks.push({ ...identity }); if (this.checkStatus !== 200) throw new IdentityFailure(this.checkStatus);
      assert.ok(identity.expiresAt > now(), 'expired access must not reach central policy before refresh'); return { ...identity }; },
    async refresh(identity, options) { this.refreshes.push({ identity: { ...identity }, signal: options.signal });
      if (this.refreshStatus !== 200) throw new IdentityFailure(this.refreshStatus);
      return { issuer: identity.issuer, sub: identity.sub, clientId: identity.clientId, authTime: identity.authTime,
        accessToken: 'server-only-new-access', expiresAt: now() + HOUR }; },
    async begin(returnTo, { entry }) { const state = opaqueId(), url = new URL(entry.callback);
      url.searchParams.set('code', 'synthetic'); url.searchParams.set('state', state);
      return { url, transaction: { state, nonce: opaqueId(), codeVerifier: opaqueId(), returnTo } }; },
    async complete() { return { issuer: saved.issuer, sub: saved.sub, clientId: saved.clientId, authTime: saved.authTime,
      accessToken: 'server-only-login-access', expiresAt: now() + HOUR, refreshToken: 'server-only-login-refresh',
      refreshIssuedAt: now(), refreshExpiresAt: now() + 30 * DAY }; } };
  const service = new SessionService(settings, { store, provider, now });
  const request = (path = '/api/state', extra = {}) => new Request(settings.origin + path,
    { ...extra, headers: { cookie: `${settings.cookieName}=${id}`, ...extra.headers } });
  return { settings, store, adapter, key, saved, business, id, provider, service, request, now,
    advance(ms) { time += ms; } };
}

test('v2 callback stores only its own encrypted refresh and fixed 30-day TTL/Cookie with short private expiry', async () => {
  const f = await fixture();
  const begin = await f.service.route(f.request('/auth/login?returnTo=%2Froom.html%3Fcode%3D123456'));
  assert.equal(begin.status, 303);
  const transactionCookie = begin.headers['set-cookie'].find(value => value.startsWith(f.settings.transactionCookieName + '='));
  const completed = await f.service.route(new Request(begin.headers.location, { headers: { cookie: transactionCookie.split(';')[0] } }));
  assert.equal(completed.status, 303); assert.equal(completed.headers.location, '/room.html?code=123456');
  const cookie = completed.headers['set-cookie'].find(value => value.startsWith(f.settings.cookieName + '='));
  assert.match(cookie, /Max-Age=2592000\b/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  const id = cookie.split(';')[0].split('=')[1], record = await f.store.read('sessions', id);
  assert.equal(record.value.sessionVersion, 2); assert.equal(record.expiresAt, BASE + 30 * DAY);
  assert.equal(record.value.sessionExpiresAt, record.expiresAt); assert.equal(record.value.expiresAt, BASE + HOUR);
  assert.equal(record.value.idleUntil, BASE + 1800000); assert.equal(record.value.authTime, f.saved.authTime);
  assert.equal(record.value.refreshToken, 'server-only-login-refresh');
  const encoded = JSON.stringify([...f.adapter.records.values()]);
  assert.ok(!encoded.includes('server-only-login-refresh')); assert.ok(!encoded.includes('server-only-login-access'));
  assert.ok(!JSON.stringify(completed).includes('server-only-'));
});

test('v1 sessions keep their original idle and absolute lifetime and cannot be upgraded by a probe', async () => {
  const f = await fixture({ version: 1 }); f.advance(60000);
  await f.service.entryStatus(f.request('/api/entry-status'));
  const current = await f.store.get('sessions', f.id);
  assert.equal(current.sessionVersion, undefined); assert.equal(current.refreshToken, undefined);
  assert.equal(current.expiresAt, f.saved.expiresAt); assert.equal(current.idleUntil, f.saved.idleUntil);
  f.advance(1800000); await assert.rejects(f.service.entryStatus(f.request('/api/entry-status')), fail(401));
  assert.equal(await f.store.get('sessions', f.id), null); assert.equal(f.provider.refreshes.length, 0);
  assert.deepEqual(await f.store.get('rooms', 'kept-business'), f.business);
});

test('dormant probe refreshes expired own access, preserves auth_time and idle, returns only identity fingerprint', async () => {
  const f = await fixture(); f.advance(2 * HOUR);
  const result = await f.service.entryStatus(f.request('/api/entry-status'));
  assert.deepEqual(result, { identityFingerprint: fingerprint(f.saved) });
  const record = await f.store.read('sessions', f.id);
  assert.equal(f.provider.refreshes.length, 1); assert.ok(f.provider.checks.length >= 1);
  assert.ok(f.provider.checks.every(identity => identity.accessToken === 'server-only-new-access'));
  assert.equal(record.value.authTime, f.saved.authTime); assert.equal(record.value.userKey, f.saved.userKey);
  assert.equal(record.value.csrf, f.saved.csrf); assert.equal(record.value.idleUntil, f.saved.idleUntil);
  assert.equal(record.expiresAt, f.saved.sessionExpiresAt); assert.equal(record.value.sessionExpiresAt, f.saved.sessionExpiresAt);
  assert.deepEqual(await f.store.get('rooms', 'kept-business'), f.business);
  assert.ok(!JSON.stringify(result).includes('server-only-'));
});

test('background checks cannot activate dormant retained sessions; matching resume and active access can', async () => {
  const f = await fixture(); f.advance(2 * HOUR);
  await assert.rejects(f.service.authorize(f.request(), { touch: false }), fail(401));
  assert.ok(await f.store.get('sessions', f.id));
  const mismatched = await f.service.route(f.request('/auth/resume?expectedIdentity=' + 'a'.repeat(64)));
  assert.equal(mismatched.status, 409); assert.equal((await f.store.get('sessions', f.id)).idleUntil, f.saved.idleUntil);
  const resumed = await f.service.route(f.request('/auth/resume?expectedIdentity=' + fingerprint(f.saved) + '&returnTo=%2Froom.html%3Fcode%3D123456'));
  assert.equal(resumed.status, 303); assert.equal(resumed.headers.location, '/room.html?code=123456');
  const current = await f.store.get('sessions', f.id);
  assert.equal(current.idleUntil, f.now() + f.settings.idleMs); assert.equal(current.sessionExpiresAt, f.saved.sessionExpiresAt);
  f.advance(60000); const active = await f.service.authorize(f.request());
  assert.ok(active.idleUntil > current.idleUntil); assert.equal(active.expiresAt, current.expiresAt);
  assert.ok(!JSON.stringify(active).includes('server-only-'));
});

test('concurrent retained-entry probes share one refresh grant and all receive fresh-policy identity', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), original = f.provider.refresh.bind(f.provider);
  f.advance(2 * HOUR);
  f.provider.refresh = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const probes = Array.from({ length: 4 }, () => f.service.entryStatus(f.request('/api/entry-status')));
  await entered.promise; release.resolve();
  const results = await Promise.all(probes);
  assert.ok(results.every(value => value.identityFingerprint === fingerprint(f.saved)));
  assert.equal(f.provider.refreshes.length, 1); assert.ok(f.provider.checks.length >= results.length);
  assert.equal((await f.store.get('sessions', f.id)).idleUntil, f.saved.idleUntil);
});

test('logout while refresh is pending wins its CAS and a late successful grant cannot recreate the session', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), original = f.provider.refresh.bind(f.provider);
  f.advance(2 * HOUR);
  f.provider.refresh = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const pending = f.service.entryStatus(f.request('/api/entry-status'));
  const rejected = assert.rejects(pending, fail(401)); await entered.promise;
  const logout = await f.service.route(f.request('/auth/logout', { method: 'POST',
    headers: { origin: f.settings.origin, 'x-csrf-token': f.saved.csrf } }));
  assert.equal(logout.status, 200); release.resolve(); await rejected;
  assert.equal(await f.store.get('sessions', f.id), null);
  assert.deepEqual(await f.store.get('rooms', 'kept-business'), f.business);
});

test('late refresh denial for the prior login cannot delete or clear a newer account session', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); f.advance(2 * HOUR);
  f.provider.refresh = async () => { entered.resolve(); await release.promise; throw new IdentityFailure(401); };
  const pending = f.service.route(f.request('/auth/resume?expectedIdentity=' + fingerprint(f.saved)));
  await entered.promise;
  await f.service.logout(f.request('/auth/logout', { method: 'POST',
    headers: { origin: f.settings.origin, 'x-csrf-token': f.saved.csrf } }));
  const newId = opaqueId(), newer = { ...f.saved, sub: 'retained-member-b',
    userKey: identityKey(f.saved.issuer, 'retained-member-b'), accessToken: 'new-account-token', expiresAt: f.now() + HOUR,
    idleUntil: f.now() + 1800000, refreshToken: 'new-account-refresh' };
  await f.store.put('sessions', newId, newer, newer.sessionExpiresAt); release.resolve();
  const result = await pending;
  assert.ok([401, 303].includes(result.status));
  assert.ok(!(result.headers['set-cookie'] || []).some(value => value.startsWith(f.settings.cookieName + '=')));
  assert.deepEqual(await f.store.get('sessions', newId), newer); assert.equal(await f.store.get('sessions', f.id), null);
});

test('refresh and post-refresh policy 503 preserve own credentials and business while granting no private result', async () => {
  for (const source of ['refresh', 'policy']) {
    const f = await fixture(); f.advance(2 * HOUR);
    if (source === 'refresh') f.provider.refreshStatus = 503; else f.provider.checkStatus = 503;
    await assert.rejects(f.service.entryStatus(f.request('/api/entry-status')), fail(503));
    const current = await f.store.get('sessions', f.id);
    assert.ok(current); assert.equal(current.refreshToken, f.saved.refreshToken);
    assert.equal(current.accessToken, f.saved.accessToken); assert.equal(current.idleUntil, f.saved.idleUntil);
    assert.equal(current.sessionExpiresAt, f.saved.sessionExpiresAt);
    assert.deepEqual(await f.store.get('rooms', 'kept-business'), f.business);
  }
});

test('post-commit policy 503 keeps already verified renewed credentials but releases no private result', async () => {
  const f = await fixture(); f.advance(2 * HOUR); let checks = 0;
  f.provider.check = async identity => {
    f.provider.checks.push({ ...identity });
    if (++checks === 2) throw new IdentityFailure(503);
    return { ...identity };
  };
  await assert.rejects(f.service.authorize(f.request(), { touch: true }), fail(503));
  assert.equal(checks, 2, 'the refresh precommit policy passed, but the operation fresh policy failed');
  const retained = await f.store.read('sessions', f.id);
  assert.ok(retained); assert.equal(retained.value.accessToken, 'server-only-new-access');
  assert.equal(retained.value.refreshToken, f.saved.refreshToken);
  assert.equal(retained.value.authTime, f.saved.authTime); assert.equal(retained.value.idleUntil, f.saved.idleUntil);
  assert.equal(retained.expiresAt, f.saved.sessionExpiresAt); assert.equal(retained.value.sessionExpiresAt, f.saved.sessionExpiresAt);
  assert.deepEqual(await f.store.get('rooms', 'kept-business'), f.business);
});

test('readonly policy crossing idle denies this output but preserves v2 retention for later entry and resume', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  const before = { ...f.saved, idleUntil: f.now() + 1000 };
  await f.store.put('sessions', f.id, before, before.sessionExpiresAt);
  let checks = 0;
  f.provider.check = async identity => {
    f.provider.checks.push({ ...identity });
    if (++checks === 1) { entered.resolve(); await release.promise; }
    return { ...identity };
  };
  const pending = f.service.authorize(f.request(), { touch: false });
  const rejected = assert.rejects(pending, fail(401));
  await entered.promise; f.advance(1001); release.resolve(); await rejected;
  const retained = await f.store.read('sessions', f.id);
  assert.ok(retained); assert.deepEqual(retained.value, before); assert.equal(retained.expiresAt, before.sessionExpiresAt);
  assert.deepEqual(await f.store.get('rooms', 'kept-business'), f.business);
  assert.deepEqual(await f.service.entryStatus(f.request('/api/entry-status')), { identityFingerprint: fingerprint(before) });
  assert.equal((await f.store.get('sessions', f.id)).idleUntil, before.idleUntil);
  const result = await f.service.route(f.request('/auth/resume?expectedIdentity=' + fingerprint(before)));
  assert.equal(result.status, 303); assert.equal((await f.store.get('sessions', f.id)).idleUntil, f.now() + f.settings.idleMs);
});

test('refresh identity change or post-refresh policy 401 rejects and invalidates only this project session', async () => {
  for (const source of ['issuer', 'sub', 'clientId', 'authTime', 'policy']) {
    const f = await fixture(); f.advance(2 * HOUR);
    if (source === 'policy') f.provider.checkStatus = 401;
    else { const original = f.provider.refresh.bind(f.provider); f.provider.refresh = async (...args) => {
      const result = await original(...args); return { ...result, [source]: source === 'authTime' ? result.authTime + 1 : 'foreign-value' }; }; }
    await assert.rejects(f.service.entryStatus(f.request('/api/entry-status')), fail(401));
    assert.equal(await f.store.get('sessions', f.id), null);
    assert.deepEqual(await f.store.get('rooms', 'kept-business'), f.business);
  }
});

test('refresh rotation is saved atomically without changing fixed retention or exposing credentials publicly', async () => {
  const f = await fixture(), original = f.provider.refresh.bind(f.provider); f.advance(2 * HOUR);
  f.provider.refresh = async (...args) => ({ ...await original(...args), refreshToken: 'server-only-rotated-refresh' });
  const result = await f.service.entryStatus(f.request('/api/entry-status')), current = await f.store.get('sessions', f.id);
  assert.equal(current.refreshToken, 'server-only-rotated-refresh'); assert.equal(current.sessionExpiresAt, f.saved.sessionExpiresAt);
  assert.equal(current.refreshExpiresAt, f.saved.refreshExpiresAt); assert.ok(!JSON.stringify(result).includes('server-only-'));
});

test('fixed retention expires at its original deadline even when probes and active checks succeeded', async () => {
  const f = await fixture(); f.advance(29 * DAY); await f.service.entryStatus(f.request('/api/entry-status'));
  await f.service.authorize(f.request());
  assert.equal((await f.store.read('sessions', f.id)).expiresAt, f.saved.sessionExpiresAt);
  const grants = f.provider.refreshes.length; f.advance(DAY);
  await assert.rejects(f.service.entryStatus(f.request('/api/entry-status')), fail(401));
  assert.equal(f.provider.refreshes.length, grants); assert.equal(await f.store.get('sessions', f.id), null);
});

test('an aborted refresh cannot install its late tokens or revive dormant business activity', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), original = f.provider.refresh.bind(f.provider);
  f.advance(2 * HOUR); const controller = new AbortController();
  f.provider.refresh = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const pending = f.service.authorize(f.request(), { touch: true, signal: controller.signal });
  const rejected = assert.rejects(pending, fail(503)); await entered.promise; controller.abort(); await rejected;
  release.resolve(); for (let index = 0; index < 20; index++) await Promise.resolve();
  const current = await f.store.get('sessions', f.id);
  assert.ok(current); assert.equal(current.accessToken, f.saved.accessToken); assert.equal(current.idleUntil, f.saved.idleUntil);
});

test('retained refresh credentials remain encrypted in the original SQLite and are absent from business backups', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'game-retention-v2-')), sourcePath = join(directory, 'original.sqlite'),
    destinationPath = join(directory, 'business.sqlite'), key = randomBytes(32);
  const adapter = new SQLiteAdapter(sourcePath, { now: () => BASE });
  t.after(() => { adapter.close(); rmSync(directory, { recursive: true, force: true }); });
  const f = await fixture({ adapter, key });
  // The service's arbitrary synthetic room is not a valid recovery snapshot.
  await f.store.remove('rooms', 'kept-business');
  await f.store.put('game-profiles', f.saved.userKey, { userKey: f.saved.userKey, name: '原昵称' });
  const manifest = await backupStore({ sourcePath, destinationPath, key, now: f.now });
  assert.equal(manifest.authSessionsIncluded, false); assert.equal(manifest.excludedRecords, 1);
  const verified = verifyBackup({ sourcePath: destinationPath, key });
  assert.equal(verified.rows.length, 1); assert.ok(verified.rows.every(row => row.key.startsWith('game-profiles:')));
  assert.equal((await f.store.get('sessions', f.id)).refreshToken, f.saved.refreshToken);
  assert.ok(!JSON.stringify(adapter.db.prepare('SELECT payload FROM game_records').all()).includes(f.saved.refreshToken));
});
