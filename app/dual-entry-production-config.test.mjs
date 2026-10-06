import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { readSettings, SHARED_ISSUER, FORBIDDEN_CLIENT_IDS, PRODUCTION_GAME_CLIENT_ID } from '../server/config.mjs';
import { startProduction } from '../server/production.mjs';
import { makeEntries } from '../server/entry-context.mjs';
import { CognitoProvider, MockProvider } from '../server/auth.mjs';
import { IDENTITY_POLICY_ENDPOINT } from '../server/identity-policy-client.mjs';

const base = () => ({ NODE_ENV: 'production', GAME_ROOM_AUTH_MODE: 'cognito',
  GAME_ROOM_CLIENT_ID: PRODUCTION_GAME_CLIENT_ID, GAME_ROOM_STORE_PATH: '/tmp/synthetic-dual-entry.sqlite',
  GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') });
const enabled = () => ({ ...base(), GAME_ROOM_AGORA_ENTRY_ENABLED: '1' });

test('production configuration retains the original entry by default and explicit zero', () => {
  for (const flag of [undefined, '0']) {
    const env = base(); if (flag !== undefined) env.GAME_ROOM_AGORA_ENTRY_ENABLED = flag;
    const settings = readSettings(env);
    assert.equal(settings.agoraEntryEnabled, false);
    assert.deepEqual(settings.entries, [{ id: 'direct', origin: 'https://game.sumomoli.com', basePath: '/' }]);
    assert.equal(settings.callback, 'https://game.sumomoli.com/auth/callback');
    assert.equal(settings.postLogout, 'https://game.sumomoli.com/');
    assert.equal(settings.cookieName, '__Host-game-room-session');
    assert.ok(Object.isFrozen(settings.entries)); assert.ok(Object.isFrozen(settings.entries[0]));
  }
});

test('explicit production opt-in freezes two exact entries with distinct secure cookies and full callbacks', () => {
  const settings = readSettings(enabled()), entries = makeEntries(settings, settings.entries);
  assert.equal(settings.agoraEntryEnabled, true);
  assert.deepEqual(settings.entries.map(({ id, origin, basePath }) => ({ id, origin, basePath })), [
    { id: 'direct', origin: 'https://game.sumomoli.com', basePath: '/' },
    { id: 'agora', origin: 'https://agora.sumomoli.com', basePath: '/game/' },
  ]);
  assert.equal(entries[0].callback, 'https://game.sumomoli.com/auth/callback');
  assert.equal(entries[1].callback, 'https://agora.sumomoli.com/game/auth/callback');
  assert.equal(entries[1].postLogout, 'https://agora.sumomoli.com/game/');
  assert.equal(entries[1].cookieName, '__Host-game-room-agora-session');
  assert.equal(entries[1].transactionCookieName, '__Host-game-room-agora-transaction');
  for (const entry of entries) assert.equal(entry.secureCookies, true);
  assert.throws(() => settings.entries.push({ id: 'other' }), TypeError);
  assert.throws(() => { settings.entries[1].origin = 'https://untrusted.invalid'; }, TypeError);
});

test('entry opt-in refuses ambiguous values instead of treating arbitrary text as truthy', () => {
  for (const value of ['', 'true', 'false', 'yes', '01', '1 ', 1, true, null]) {
    assert.throws(() => readSettings({ ...base(), GAME_ROOM_AGORA_ENTRY_ENABLED: value }), /explicit 0 or 1/);
  }
});

test('fixed production opt-in cannot enable local, mock, legacy or disabled identity', () => {
  assert.throws(() => readSettings({ ...enabled(), NODE_ENV: 'development' }), /production-only/);
  for (const mode of ['mock', 'legacy', 'disabled']) {
    assert.throws(() => readSettings({ ...enabled(), GAME_ROOM_AUTH_MODE: mode }), /HTTPS Cognito/);
  }
  assert.throws(() => new MockProvider(readSettings(enabled())), /local-only/);
});

test('opt-in refuses alternate production origins, insecure URLs, paths and credentials', () => {
  for (const origin of ['https://untrusted.invalid', 'https://agora.sumomoli.com',
    'https://game.sumomoli.com:9443', 'http://game.sumomoli.com',
    'https://game.sumomoli.com/game/', 'https://game.sumomoli.com/?returnTo=other',
    'https://user:secret@game.sumomoli.com']) {
    assert.throws(() => readSettings({ ...enabled(), GAME_ROOM_ORIGIN: origin }));
  }
});

test('opt-in requires the existing dedicated game client and cannot borrow or invent another client', () => {
  for (const clientId of ['', 'ownclient12345678', ...FORBIDDEN_CLIENT_IDS]) {
    assert.throws(() => readSettings({ ...enabled(), GAME_ROOM_CLIENT_ID: clientId }));
  }
  // Existing single-entry synthetic production fixtures retain their original contract.
  assert.equal(readSettings({ ...base(), GAME_ROOM_CLIENT_ID: 'ownclient12345678' }).clientId, 'ownclient12345678');
});

test('opt-in retains protected storage, exact issuer/auth-domain, loopback and session limits', () => {
  for (const overrides of [
    { GAME_ROOM_STORE_KEY: '' }, { GAME_ROOM_STORE_KEY: 'short' },
    { GAME_ROOM_STORE_PATH: '' }, { GAME_ROOM_STORE_PATH: 'relative.sqlite' },
    { GAME_ROOM_HOST: '0.0.0.0' }, { GAME_ROOM_ISSUER: 'https://untrusted.invalid/pool' },
    { GAME_ROOM_AUTH_DOMAIN: 'https://untrusted.invalid' },
    { GAME_ROOM_SESSION_ABSOLUTE_SECONDS: '3601' }, { GAME_ROOM_SESSION_IDLE_SECONDS: '1801' },
  ]) assert.throws(() => readSettings({ ...enabled(), ...overrides }));
  const settings = readSettings(enabled()), provider = new CognitoProvider(settings);
  assert.equal(provider.policyClient.endpoint, IDENTITY_POLICY_ENDPOINT);
  assert.equal(settings.issuer, SHARED_ISSUER);
  assert.equal(settings.absoluteMs, 3_600_000); assert.equal(settings.idleMs, 1_800_000);
  assert.equal(settings.transactionMs, 300_000);
});

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}
async function fixture(t, optIn) {
  const directory = mkdtempSync(join(tmpdir(), 'game-production-dual-entry-'));
  let runtime;
  t.after(async () => { try { await runtime?.server.shutdown(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const env = { ...base(), GAME_ROOM_PORT: String(await freePort()),
    GAME_ROOM_STORE_PATH: join(directory, 'synthetic.sqlite'),
    ...(optIn ? { GAME_ROOM_AGORA_ENTRY_ENABLED: '1' } : {}) };
  runtime = await startProduction(env);
  assert.ok(runtime.sessions.provider instanceof CognitoProvider);
  assert.equal(runtime.sessions.provider.policyClient.endpoint, IDENTITY_POLICY_ENDPOINT);
  assert.equal(runtime.sessions.store, runtime.storage);
  const checks = [], provider = runtime.sessions.provider;
  // These two fixture hooks avoid contacting Cognito or using any real identity.
  // Actual OAuth begin, entry binding, CAS, SQLite and HTTP remain production code.
  provider.complete = async (url, transaction) => {
    assert.equal(url.searchParams.get('state'), transaction.state);
    assert.equal(url.searchParams.get('code'), 'synthetic-only');
    return { issuer: SHARED_ISSUER, sub: 'synthetic-production-dual-member',
      clientId: PRODUCTION_GAME_CLIENT_ID, accessToken: 'synthetic-local-only',
      authTime: Math.floor(Date.now() / 1000), expiresAt: Date.now() + 3_600_000 };
  };
  provider.check = async identity => { checks.push(identity.sub); return { ...identity, policy: { valid: true } }; };
  async function request(entry, pathname, { method = 'GET', headers = {}, body } = {}) {
    const host = entry === 'agora' ? 'agora.sumomoli.com' : 'game.sumomoli.com';
    const prefix = entry === 'agora' ? '/game' : '';
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: '127.0.0.1', port: runtime.server.address().port,
        path: prefix + pathname, method, headers: { Host: host, ...headers } }, incoming => {
        let text = ''; incoming.on('data', chunk => { text += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers,
          body: text, json: () => JSON.parse(text) }));
      }); outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function login(entry, returnTo = '/') {
    const begin = await request(entry, '/auth/login?returnTo=' + encodeURIComponent(returnTo));
    assert.equal(begin.status, 303);
    const authorization = new URL(begin.headers.location);
    assert.equal(authorization.origin, 'https://sumomo-agora.auth.ap-northeast-1.amazoncognito.com');
    assert.equal(authorization.searchParams.get('client_id'), PRODUCTION_GAME_CLIENT_ID);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('scope'), 'openid');
    assert.ok(authorization.searchParams.get('code_challenge')); assert.ok(authorization.searchParams.get('nonce'));
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    const prefix = entry === 'agora' ? '/game' : '';
    assert.equal(callback.href, entry === 'agora' ? 'https://agora.sumomoli.com/game/auth/callback' : 'https://game.sumomoli.com/auth/callback');
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    callback.searchParams.set('code', 'synthetic-only');
    const transactionCookie = begin.headers['set-cookie'][0].split(';')[0];
    const complete = await request(entry, callback.pathname.slice(prefix.length) + callback.search, { headers: { Cookie: transactionCookie } });
    assert.equal(complete.status, 303);
    const cookieName = entry === 'agora' ? '__Host-game-room-agora-session' : '__Host-game-room-session';
    const setCookie = complete.headers['set-cookie'].find(value => value.startsWith(cookieName + '='));
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(setCookie.includes(flag));
    assert.ok(!setCookie.includes('Domain='));
    const cookie = setCookie.split(';')[0];
    const state = (await request(entry, '/api/state', { headers: { Cookie: cookie } })).json();
    assert.equal(state.authenticated, true);
    return { cookie, state, complete, writeHeaders: { Cookie: cookie, Origin: entry === 'agora' ? 'https://agora.sumomoli.com' : 'https://game.sumomoli.com',
      'X-CSRF-Token': state.csrf, 'Content-Type': 'application/json' } };
  }
  return { runtime, checks, request, login };
}

test('real default production startup serves only the original Host and rejects forwarded mount opt-in', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.request('direct', '/healthz')).status, 200);
  assert.equal((await f.request('agora', '/healthz')).status, 403);
  assert.equal((await f.request('agora', '/', { headers: { 'X-Forwarded-Host': 'game.sumomoli.com' } })).status, 403);
  const a = await f.login('direct'); assert.equal(a.complete.headers.location, '/');
});

test('real opt-in startup exposes one persistent room runtime across both entries with independent sessions', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.request('direct', '/healthz')).status, 200);
  assert.equal((await f.request('agora', '/healthz')).status, 200);
  const direct = await f.login('direct'), mounted = await f.login('agora', '/game/room.html?code=123456');
  assert.equal(mounted.complete.headers.location, '/game/room.html?code=123456');
  assert.equal(direct.state.userKey, mounted.state.userKey); assert.notEqual(direct.cookie, mounted.cookie);
  const created = await f.request('direct', '/api/rooms', { method: 'POST', headers: direct.writeHeaders,
    body: { name: '隔离双入口成员', requestId: randomUUID() } });
  assert.equal(created.status, 201); const room = created.json();
  const restored = await f.request('agora', '/api/rooms/' + room.roomCode, { headers: { Cookie: mounted.cookie } });
  assert.equal(restored.status, 200);
  assert.equal(restored.json().view.roomId, room.view.roomId); assert.equal(restored.json().view.selfId, room.playerId);
  const wrongOrigin = await f.request('agora', '/api/profile', { method: 'PUT', headers: { ...mounted.writeHeaders, Origin: 'https://game.sumomoli.com' }, body: { nickname: '拒绝跨入口' } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await f.request('agora', '/auth/logout', { method: 'POST', headers: mounted.writeHeaders })).status, 200);
  assert.equal((await f.request('agora', '/api/state', { headers: { Cookie: mounted.cookie } })).json().authenticated, false);
  assert.equal((await f.request('direct', '/api/state', { headers: { Cookie: direct.cookie } })).json().authenticated, true);
  assert.ok(f.checks.length > 4, 'callback and private responses still perform identity checks');
  assert.equal((await f.runtime.storage.adapter.entries('rooms')).length, 1);
  assert.equal((await f.runtime.storage.adapter.entries('game-profiles')).length, 1);
});
