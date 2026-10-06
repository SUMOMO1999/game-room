import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { readSettings, SHARED_ISSUER } from '../server/config.mjs';
import { CognitoProvider, IdentityFailure } from '../server/auth.mjs';
import { EncryptedStore, MemoryAdapter, opaqueId, identityKey } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { makeEntries } from '../server/entry-context.mjs';

const fingerprint = sub => createHash('sha256').update(SHARED_ISSUER + '\0' + sub).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const keys = generateKeyPair('RS256').then(async pair => {
  const jwk = await exportJWK(pair.publicKey); jwk.kid = 'entry-resume-isolated-rsa';
  return { ...pair, jwks: createLocalJWKSet({ keys: [jwk] }) };
});

// Only opaque encrypted local sessions are seeded. Every request still executes
// the original SessionService and CognitoProvider RSA/token/policy checks.
// No remote keys, OAuth exchange, shared cookie, or real account are involved.
async function fixture(t, { watchdogMs = 5000 } = {}) {
  let clock = Math.floor(Date.now() / 1000) * 1000;
  const now = () => clock, key = await keys;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_ORIGIN: 'http://127.0.0.1:39071' });
  Object.assign(settings, { mode: 'cognito', issuer: SHARED_ISSUER, clientId: 'isolatedentryclient12345678', authDomain: 'https://synthetic-oauth.invalid' });
  const definitions = [{ id: 'direct', origin: settings.origin, basePath: '/' },
    { id: 'agora', origin: 'http://127.0.0.1:39072', basePath: '/game/' }];
  const entries = makeEntries(settings, definitions), adapter = new MemoryAdapter({ now });
  const storage = new EncryptedStore(adapter, randomBytes(32), now);
  const policy = { checks: [], statuses: new Map(), beforeCheck: null, async check(identity) {
    this.checks.push(identity.sub);
    await this.beforeCheck?.(identity, this.checks.length);
    const status = this.statuses.get(identity.sub) ?? 200;
    if (status !== 200) throw new IdentityFailure(status);
    return { version: 1, revokedBefore: 0, issuer: identity.issuer, sub: identity.sub,
      clientId: identity.clientId, authTime: identity.authTime };
  } };
  const provider = new CognitoProvider(settings, { now, jwks: key.jwks, policyClient: policy,
    fetcher: async () => { throw new Error('Entry checks must never access a remote provider'); } });
  let oauthBegins = 0;
  const originalBegin = provider.begin.bind(provider);
  provider.begin = async (...args) => { oauthBegins++; return originalBegin(...args); };
  const runtime = createRuntime(settings, { storage, provider, now, roomOptions: { pollIntervalMs: 0 } });
  const server = createUnifiedServer({ ...runtime, entries: definitions, watchdogMs, heartbeatMs: 100 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.shutdown());

  async function identity(sub) {
    const seconds = Math.floor(now() / 1000), expiresAt = (seconds + 3600) * 1000;
    const accessToken = await new SignJWT({ iss: SHARED_ISSUER, sub, client_id: settings.clientId,
      iat: seconds, auth_time: seconds, exp: seconds + 3600, scope: 'openid', token_use: 'access' })
      .setProtectedHeader({ alg: 'RS256', kid: 'entry-resume-isolated-rsa' }).sign(key.privateKey);
    return { issuer: SHARED_ISSUER, sub, accessToken, clientId: settings.clientId, authTime: seconds, expiresAt };
  }
  async function seed(entryId, sub) {
    const entry = entries.find(value => value.id === entryId), id = opaqueId(), verified = await identity(sub);
    const record = { ...verified, phase: 'active', entryKey: entry.key, userKey: identityKey(SHARED_ISSUER, sub),
      csrf: opaqueId(), createdAt: now(), lastIdentityCheck: now(), idleUntil: now() + settings.idleMs };
    await storage.put('sessions', id, record, Math.min(record.expiresAt, record.idleUntil));
    return { id, entryId, cookie: `${entry.cookieName}=${id}`, csrf: record.csrf, userKey: record.userKey, sub };
  }
  async function request(entryId, logicalPath, { method = 'GET', cookie, csrf, body, headers = {}, signal } = {}) {
    const entry = entries.find(value => value.id === entryId), prefix = entry.basePath === '/' ? '' : entry.basePath.slice(0, -1);
    const requestHeaders = { Host: new URL(entry.origin).host, ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'GET' || method === 'HEAD' ? {} : { Origin: entry.origin }),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers };
    return new Promise((resolve, reject) => {
      const outgoing = http.request(base + prefix + logicalPath, { method, headers: requestHeaders, signal }, incoming => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        resolve(new Response(method === 'HEAD' ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: responseHeaders }));
      });
      outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function json(entryId, path, options) {
    const response = await request(entryId, path, options), text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  }
  return { entries, settings, storage, adapter, policy, provider, runtime, request, json, seed, identity,
    now, advance: ms => { clock += ms; }, oauthBegins: () => oauthBegins };
}

function safeHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}
function resumePath(sub, returnTo = '/') {
  return '/auth/resume?expectedIdentity=' + fingerprint(sub) + '&returnTo=' + encodeURIComponent(returnTo);
}
function snapshot(f, ignoredScopes = []) {
  return [...f.adapter.records].filter(([id]) => !ignoredScopes.some(scope => id.startsWith(scope + ':')))
    .map(([id, value]) => [id, { ...value }]);
}
async function createPlayingRoom(f, a, b) {
  const created = await f.json(a.entryId, '/api/rooms', { ...a, method: 'POST', body: { name: '同名朋友', requestId: randomUUID() } });
  assert.equal(created.response.status, 201);
  const code = created.body.roomCode;
  const joined = await f.json(b.entryId, `/api/rooms/${code}/join`, { ...b, method: 'POST', body: { name: '同名朋友', requestId: randomUUID() } });
  assert.equal(joined.response.status, 201);
  for (const [member, type] of [[a, 'ready'], [b, 'ready'], [a, 'start']]) {
    const current = (await f.json(member.entryId, `/api/rooms/${code}`, member)).body.view;
    const acted = await f.json(member.entryId, `/api/rooms/${code}/actions`, { ...member, method: 'POST', body: {
      type, ...(type === 'ready' ? { ready: true } : {}), expectedRevision: current.revision, requestId: randomUUID() } });
    assert.equal(acted.response.status, 200);
  }
  const own = (await f.json(a.entryId, `/api/rooms/${code}`, a)).body.view;
  const other = (await f.json(b.entryId, `/api/rooms/${code}`, b)).body.view;
  assert.equal(own.phase, 'playing'); assert.equal(own.game.rack.length, 14);
  assert.equal(own.game.rack.some(tile => other.game.rack.some(candidate => candidate.id === tile.id)), false);
  return { code, own, other };
}
async function openStream(t, f, member, code) {
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await f.request(member.entryId, `/api/rooms/${code}/events`, { ...member, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffered = '';
  async function until(predicate) {
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      while (!predicate(buffered)) {
        const chunk = await reader.read(); if (chunk.done) break; buffered += decoder.decode(chunk.value);
      }
      assert.ok(predicate(buffered), 'Expected SSE event before closure'); return buffered;
    } finally { clearTimeout(timer); }
  }
  await until(text => text.includes('event: view'));
  return { until, text: () => buffered, close: () => controller.abort() };
}

test('entry status proves the current entry identity with fresh RSA/policy checks and no session, profile or room mutation', async t => {
  const f = await fixture(t), direct = await f.seed('direct', 'member-a'), mounted = await f.seed('agora', 'member-a');
  f.advance(60000);
  f.runtime.rooms.ensureProfile = async () => { throw new Error('Entry status must not create a profile'); };
  f.runtime.rooms.recentRooms = async () => { throw new Error('Entry status must not enumerate rooms'); };
  const before = snapshot(f), beforeChecks = f.policy.checks.length;
  for (const member of [direct, mounted, direct]) {
    const result = await f.json(member.entryId, '/api/entry-status', member);
    assert.equal(result.response.status, 200); safeHeaders(result.response);
    assert.deepEqual(result.body, { identityFingerprint: fingerprint('member-a') });
    assert.notEqual(result.body.identityFingerprint, member.userKey, 'The browser marker never replaces the existing stable userKey');
    assert.equal(result.response.headers.get('set-cookie'), null);
  }
  assert.equal(f.policy.checks.length - beforeChecks, 3, 'Every entry check acquires a fresh policy result');
  assert.deepEqual(snapshot(f), before, 'Entry checks do not renew idle time or write any business record');
  assert.equal(f.oauthBegins(), 0);
});

test('same-identity resume returns to the current-entry lobby or invitation without OAuth, renewal or business writes', async t => {
  const f = await fixture(t), direct = await f.seed('direct', 'member-a'), mounted = await f.seed('agora', 'member-a');
  const before = snapshot(f);
  for (const [member, returnTo, location] of [
    [direct, '/', '/'], [direct, '/room.html?code=123456', '/room.html?code=123456'],
    [mounted, '/room.html?code=123456', '/game/room.html?code=123456'],
    [mounted, '/game/army.html?code=123456', '/game/army.html?code=123456'],
    [mounted, 'https://evil.invalid/room.html?code=123456', '/game/'],
    [mounted, '/game/game/room.html?code=123456', '/game/'],
    [mounted, '/room.html?code=123456&code=654321', '/game/'],
  ]) {
    const result = await f.json(member.entryId, resumePath(member.sub, returnTo), member);
    assert.equal(result.response.status, 303); assert.equal(result.response.headers.get('location'), location);
    assert.equal(result.body, null); assert.equal(result.response.headers.get('set-cookie'), null); safeHeaders(result.response);
  }
  assert.equal(f.oauthBegins(), 0); assert.deepEqual(snapshot(f), before);
});

test('changed entry identity returns 409 while the active game, stable seat, private hands and SSE stay usable', async t => {
  const f = await fixture(t), a = await f.seed('agora', 'member-a'), b = await f.seed('direct', 'member-b');
  const room = await createPlayingRoom(f, a, b), channel = await openStream(t, f, a, room.code);
  const result = await f.json('agora', resumePath('member-b', '/room.html?code=' + room.code), a);
  assert.equal(result.response.status, 409); assert.equal(result.body.error, 'entry_identity_changed');
  assert.equal(result.response.headers.get('location'), null); assert.equal(result.response.headers.get('set-cookie'), null); safeHeaders(result.response);
  assert.ok(await f.storage.get('sessions', a.id)); assert.equal(f.oauthBegins(), 0);
  const own = (await f.json('agora', `/api/rooms/${room.code}`, a)).body.view;
  const other = (await f.json('direct', `/api/rooms/${room.code}`, b)).body.view;
  assert.equal(own.selfId, room.own.selfId); assert.deepEqual(own.game, room.own.game); assert.deepEqual(other.game, room.other.game);
  const sent = await f.json('direct', `/api/rooms/${room.code}/chat`, { ...b, method: 'POST', body: { text: '冲突后仍然在线', requestId: randomUUID() } });
  assert.equal(sent.response.status, 200);
  await channel.until(text => text.includes('冲突后仍然在线')); assert.equal(channel.text().includes('event: closed'), false);
  channel.close();
});

test('missing, rejected and expired own sessions go only to explicit entry login and never treat a fingerprint as credentials', async t => {
  for (const cause of ['missing', 'rejected', 'expired']) await t.test(cause, async subtest => {
    const f = await fixture(subtest), member = cause === 'missing' ? {} : await f.seed('agora', 'member-a');
    if (cause === 'rejected') f.policy.statuses.set('member-a', 401);
    if (cause === 'expired') f.advance(f.settings.idleMs + 1);
    const denied = await f.json('agora', '/api/entry-status', member);
    assert.equal(denied.response.status, 401); assert.equal(denied.body.identityFingerprint, undefined); safeHeaders(denied.response);
    assert.equal(denied.response.headers.get('set-cookie'), null);
    const resumed = await f.json('agora', resumePath('member-a', '/room.html?code=123456'), member);
    assert.equal(resumed.response.status, 303); safeHeaders(resumed.response);
    assert.equal(resumed.response.headers.get('set-cookie'), null);
    const location = new URL(resumed.response.headers.get('location'), f.entries[1].origin);
    assert.equal(location.pathname, '/game/auth/login'); assert.equal(location.searchParams.get('returnTo'), '/room.html?code=123456');
    assert.equal(f.oauthBegins(), 0); assert.equal((await f.storage.scan('transactions')).length, 0);
    assert.equal((await f.storage.scan('profiles')).length, 0); assert.equal((await f.storage.scan('rooms')).length, 0);
    // The existing explicit login remains the sole route that begins OAuth.
    const start = await f.json('agora', location.pathname.slice('/game'.length) + location.search);
    assert.equal(start.response.status, 303); assert.equal(new URL(start.response.headers.get('location')).origin, f.settings.authDomain);
    assert.equal(f.oauthBegins(), 1); assert.equal((await f.storage.scan('transactions')).length, 1);
  });
});

test('unavailable identity checks return 503 without OAuth or deletion, pause the old private stream, and recover the same hand', async t => {
  const f = await fixture(t), a = await f.seed('agora', 'member-a'), b = await f.seed('direct', 'member-b');
  const room = await createPlayingRoom(f, a, b), channel = await openStream(t, f, a, room.code);
  // Closing a private stream legitimately removes its online-presence marker.
  // The session, game, memberships, profile and all other records must survive.
  const before = snapshot(f, ['room-presence']); f.policy.statuses.set('member-a', 503);
  for (const route of ['/api/entry-status', resumePath('member-a', '/room.html?code=' + room.code)]) {
    const result = await f.json('agora', route, a); assert.equal(result.response.status, 503); safeHeaders(result.response);
    assert.equal(result.response.headers.get('location'), null); assert.equal(result.response.headers.get('set-cookie'), null);
    assert.equal(result.body.identityFingerprint, undefined); assert.equal(result.body.view, undefined);
  }
  await channel.until(text => text.includes('event: closed') && text.includes('"status":503'));
  assert.equal(f.oauthBegins(), 0); assert.deepEqual(snapshot(f, ['room-presence']), before, '503 preserves original sessions and all encrypted game records');
  f.policy.statuses.delete('member-a');
  assert.equal((await f.json('agora', '/api/entry-status', a)).body.identityFingerprint, fingerprint('member-a'));
  const restored = (await f.json('agora', `/api/rooms/${room.code}`, a)).body.view;
  assert.equal(restored.selfId, room.own.selfId); assert.deepEqual(restored.game, room.own.game);
  assert.deepEqual((await f.json('direct', `/api/rooms/${room.code}`, b)).body.view.game, room.other.game);
  channel.close();
});

test('own entry cookies cannot be borrowed across hosts, and forged markers never bypass fresh token or policy validation', async t => {
  const f = await fixture(t), a = await f.seed('direct', 'member-a');
  const borrowed = a.cookie.replace(f.entries[0].cookieName, f.entries[1].cookieName);
  assert.equal((await f.json('agora', '/api/entry-status', { cookie: borrowed })).response.status, 401);
  const resumed = await f.json('agora', resumePath('member-a'), { cookie: borrowed });
  assert.equal(resumed.response.status, 303); assert.match(resumed.response.headers.get('location'), /^\/game\/auth\/login\?/);
  assert.ok(await f.storage.get('sessions', a.id), 'A wrong-entry probe must not revoke the original-entry session');
  assert.equal((await f.json('direct', '/api/entry-status', a)).body.identityFingerprint, fingerprint('member-a'));
  const record = await f.storage.read('sessions', a.id);
  await f.storage.replaceCAS('sessions', a.id, record.version, { ...record.value, accessToken: 'forged-token' }, record.expiresAt);
  assert.equal((await f.json('direct', resumePath('member-a'), a)).response.status, 303);
  assert.equal(await f.storage.get('sessions', a.id), null, 'The marker cannot make an invalid signed access token valid');
  assert.equal(f.oauthBegins(), 0);
});

test('strict resume input, fixed hosts, origin and fetch metadata reject ambiguity or cross-site use before authorization', async t => {
  const f = await fixture(t), a = await f.seed('agora', 'member-a'), marker = fingerprint('member-a');
  const malformed = [
    '/auth/resume', '/auth/resume?expectedIdentity=', '/auth/resume?expectedIdentity=' + marker.toUpperCase(),
    '/auth/resume?expectedIdentity=' + marker.slice(1), '/auth/resume?expectedIdentity=' + marker + '&expectedIdentity=' + marker,
    resumePath('member-a') + '&returnTo=%2F', resumePath('member-a') + '&unexpected=1',
  ];
  const beforeChecks = f.policy.checks.length, before = snapshot(f);
  for (const route of malformed) {
    const result = await f.json('agora', route, a); assert.equal(result.response.status, 400, route); safeHeaders(result.response);
    assert.equal(result.response.headers.get('location'), null); assert.equal(result.response.headers.get('set-cookie'), null);
  }
  for (const route of ['/api/entry-status?unexpected=1', '/api/entry-status?expectedIdentity=' + marker]) {
    const result = await f.json('agora', route, a); assert.equal(result.response.status, 400); safeHeaders(result.response);
    assert.equal(result.body.identityFingerprint, undefined); assert.equal(result.response.headers.get('set-cookie'), null);
  }
  for (const route of ['/api/entry-status', resumePath('member-a')]) {
    const credential = await f.json('agora', route, { ...a, headers: { Authorization: 'Bearer synthetic-not-a-credential' } });
    assert.equal(credential.response.status, 400); safeHeaders(credential.response);
    assert.equal(credential.response.headers.get('location'), null); assert.equal(credential.response.headers.get('set-cookie'), null);
    for (const method of ['POST', 'HEAD']) {
      const result = await f.json('agora', route, { ...a, method }); assert.equal(result.response.status, 405);
      assert.equal(result.response.headers.get('allow'), 'GET'); safeHeaders(result.response);
    }
    for (const headers of [{ Host: 'evil.invalid' }, { Origin: 'https://evil.invalid' },
      { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' }]) {
      const result = await f.json('agora', route, { ...a, headers }); assert.equal(result.response.status, 403); safeHeaders(result.response);
      assert.equal(result.response.headers.get('location'), null);
    }
  }
  assert.equal(f.policy.checks.length, beforeChecks); assert.deepEqual(snapshot(f), before); assert.equal(f.oauthBegins(), 0);
  const permitted = await f.json('agora', resumePath('member-a'), { ...a, headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' } });
  assert.equal(permitted.response.status, 303); assert.equal(permitted.response.headers.get('location'), '/game/');
});

test('entry status and resume fence concurrent project logout or expiry while the fresh policy result is in flight', async t => {
  for (const route of ['status', 'resume']) for (const cause of ['logout', 'expiry']) await t.test(route + ': ' + cause, async subtest => {
    const f = await fixture(subtest), a = await f.seed('agora', 'member-a'), entered = deferred(), release = deferred();
    f.policy.beforeCheck = async () => { entered.resolve(); await release.promise; };
    const pending = f.json('agora', route === 'status' ? '/api/entry-status' : resumePath('member-a', '/room.html?code=123456'), a);
    await entered.promise;
    if (cause === 'logout') {
      const logout = await f.json('agora', '/auth/logout', { ...a, method: 'POST' }); assert.equal(logout.response.status, 200);
    } else f.advance(f.settings.idleMs + 1);
    release.resolve(); const result = await pending;
    assert.equal(result.response.status, route === 'status' ? 401 : 303);
    assert.equal(result.body?.identityFingerprint, undefined);
    if (route === 'resume') assert.match(result.response.headers.get('location'), /^\/game\/auth\/login\?/);
    assert.equal(f.oauthBegins(), 0); assert.equal(await f.storage.get('sessions', a.id), null);
    assert.equal((await f.storage.scan('profiles')).length, 0); assert.equal((await f.storage.scan('rooms')).length, 0);
  });
});

test('a session identity changed during online checking must be reread and reverified before status output or resume', async t => {
  for (const route of ['status', 'resume']) await t.test(route, async subtest => {
    const f = await fixture(subtest), a = await f.seed('agora', 'member-a'), entered = deferred(), release = deferred();
    f.policy.beforeCheck = async (_identity, count) => { if (count === 1) { entered.resolve(); await release.promise; } };
    const pending = f.json('agora', route === 'status' ? '/api/entry-status' : resumePath('member-a'), a);
    await entered.promise;
    const record = await f.storage.read('sessions', a.id), replacement = await f.identity('member-b');
    assert.equal(await f.storage.replaceCAS('sessions', a.id, record.version,
      { ...record.value, ...replacement, userKey: identityKey(SHARED_ISSUER, 'member-b') }, record.expiresAt), true);
    release.resolve(); const result = await pending;
    if (route === 'status') { assert.equal(result.response.status, 200); assert.deepEqual(result.body, { identityFingerprint: fingerprint('member-b') }); }
    else { assert.equal(result.response.status, 409); assert.equal(result.body.error, 'entry_identity_changed'); assert.equal(result.response.headers.get('location'), null); }
    assert.deepEqual(f.policy.checks, ['member-a', 'member-b']);
    assert.equal(result.response.headers.get('set-cookie'), null); assert.equal(f.oauthBegins(), 0);
    assert.equal((await f.storage.get('sessions', a.id)).sub, 'member-b');
  });
});

test('the original authorization deadline returns 503 on both entry routes without deleting or renewing the session', async t => {
  for (const route of ['status', 'resume']) await t.test(route, async subtest => {
    const f = await fixture(subtest), a = await f.seed('agora', 'member-a'), entered = deferred(), release = deferred();
    f.runtime.sessions.authorizationTimeoutMs = 30;
    subtest.after(() => release.resolve());
    // Deliberately ignore cancellation here to prove a late policy result can
    // never authorize, create OAuth work, or mutate the existing session.
    f.policy.beforeCheck = async () => { entered.resolve(); await release.promise; };
    const before = snapshot(f);
    const pending = f.json('agora', route === 'status' ? '/api/entry-status' : resumePath('member-a'), a);
    await entered.promise; const result = await pending;
    assert.equal(result.response.status, 503); assert.equal(result.body.error, 'identity_unavailable'); safeHeaders(result.response);
    assert.equal(result.response.headers.get('location'), null); assert.equal(result.response.headers.get('set-cookie'), null);
    assert.equal(f.oauthBegins(), 0); assert.deepEqual(snapshot(f), before);
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(snapshot(f), before, 'A released late policy result cannot mutate the session after the 503');
    f.policy.beforeCheck = null; f.runtime.sessions.authorizationTimeoutMs = 10000;
    const restored = await f.json('agora', '/api/entry-status', a);
    assert.equal(restored.response.status, 200); assert.equal(restored.body.identityFingerprint, fingerprint('member-a'));
  });
});

test('entry status may upgrade required legacy authentication metadata but never migrates the identity, idle deadline, seat or hand', async t => {
  const f = await fixture(t), a = await f.seed('agora', 'member-a'), b = await f.seed('direct', 'member-b');
  const room = await createPlayingRoom(f, a, b), original = await f.storage.read('sessions', a.id);
  const legacy = { ...original.value }; delete legacy.authTime; delete legacy.clientId;
  assert.equal(await f.storage.replaceCAS('sessions', a.id, original.version, legacy, original.expiresAt), true);
  const before = await f.storage.read('sessions', a.id), businessBefore = snapshot(f, ['sessions']);
  f.advance(60000);
  const result = await f.json('agora', '/api/entry-status', a);
  assert.equal(result.response.status, 200); safeHeaders(result.response);
  assert.deepEqual(result.body, { identityFingerprint: fingerprint('member-a') });
  assert.equal(result.response.headers.get('set-cookie'), null); assert.equal(f.oauthBegins(), 0);
  const after = await f.storage.read('sessions', a.id);
  assert.notEqual(after.version, before.version, 'Required metadata is upgraded through the existing CAS');
  assert.equal(after.value.authTime, original.value.authTime); assert.equal(after.value.clientId, f.settings.clientId);
  for (const name of ['userKey', 'issuer', 'sub', 'entryKey', 'csrf', 'createdAt', 'expiresAt', 'idleUntil']) {
    assert.equal(after.value[name], before.value[name], name + ' stays stable');
  }
  assert.equal(after.expiresAt, before.expiresAt); assert.deepEqual(snapshot(f, ['sessions']), businessBefore);
  const own = (await f.json('agora', `/api/rooms/${room.code}`, a)).body.view;
  const other = (await f.json('direct', `/api/rooms/${room.code}`, b)).body.view;
  assert.equal(own.selfId, room.own.selfId); assert.deepEqual(own.game, room.own.game); assert.deepEqual(other.game, room.other.game);
});
