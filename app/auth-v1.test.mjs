import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, errors as joseErrors } from 'jose';
import * as oidc from 'openid-client';
import { readSettings, safeReturnTo, SHARED_ISSUER, FORBIDDEN_CLIENT_IDS } from '../server/config.mjs';
import { CognitoProvider, IdentityFailure } from '../server/auth.mjs';
import { EncryptedStore, MemoryAdapter, opaqueId } from '../server/storage.mjs';
import { SessionService } from '../server/session-service.mjs';

const createRequest = (path, cookie = '', headers = {}, method = 'GET') => new Request(`http://127.0.0.1:4177${path}`, { method, headers: { cookie, ...headers } });
const cookieValue = (response, name) => response.headers['set-cookie'].find((value) => value.startsWith(`${name}=`)).split(';')[0];
function fixture({ provider: custom } = {}) {
  let clock = Date.UTC(2026, 9, 4);
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const store = new EncryptedStore(new MemoryAdapter({ now: () => clock }), randomBytes(32), () => clock);
  const provider = custom || {
    checks: 0, status: 200,
    async begin(returnTo) { const state = opaqueId(); return { url: `https://synthetic.example/authorize?state=${state}`, transaction: { state, nonce: opaqueId(), codeVerifier: opaqueId(), returnTo } }; },
    async complete(url, transaction) { assert.equal(url.searchParams.get('state'), transaction.state); return { issuer: 'urn:synthetic', sub: 'member-one', accessToken: 'server-only-token', expiresAt: clock + 3600000 }; },
    async check(identity) { this.checks++; if (this.status !== 200) throw new IdentityFailure(this.status); return { sub: identity.sub }; },
  };
  const service = new SessionService(settings, { store, provider, now: () => clock });
  return { settings, store, provider, service, tick: (ms) => { clock += ms; }, now: () => clock };
}
async function login(f, returnTo = '/') {
  const start = await f.service.route(createRequest(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`)); assert.equal(start.status, 303);
  const state = new URL(start.headers.location).searchParams.get('state');
  const transactionCookie = cookieValue(start, f.settings.transactionCookieName);
  const callbackRequest = createRequest(`/auth/callback?state=${state}&code=synthetic`, transactionCookie);
  const callback = await f.service.route(callbackRequest); assert.equal(callback.status, 303);
  return { cookie: cookieValue(callback, f.settings.cookieName), callback, callbackRequest, transactionCookie, state };
}

test('production requires dedicated client, secure identity, durable path and stable encryption key', () => {
  const base = { NODE_ENV: 'production', GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'ownclient12345678', GAME_ROOM_STORE_PATH: '/tmp/game.sqlite', GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') };
  assert.throws(() => readSettings({ ...base, GAME_ROOM_CLIENT_ID: '' }), /dedicated/);
  const settings = readSettings(base); assert.equal(settings.origin, 'https://game.sumomoli.com'); assert.equal(settings.callback, 'https://game.sumomoli.com/auth/callback'); assert.equal(settings.cookieName, '__Host-game-room-session');
  for (const clientId of FORBIDDEN_CLIENT_IDS) assert.throws(() => readSettings({ ...base, GAME_ROOM_CLIENT_ID: clientId }), /own client/);
  for (const mode of ['legacy', 'mock', 'disabled']) assert.throws(() => readSettings({ ...base, GAME_ROOM_AUTH_MODE: mode }), /HTTPS Cognito/);
  assert.throws(() => readSettings({ ...base, GAME_ROOM_ORIGIN: 'http://game.sumomoli.com' }));
  assert.throws(() => readSettings({ ...base, GAME_ROOM_STORE_KEY: '' }));
  assert.throws(() => readSettings({ ...base, GAME_ROOM_STORE_PATH: 'relative.sqlite' }));
  assert.throws(() => readSettings({ ...base, GAME_ROOM_AUTH_DOMAIN: 'https://evil.example' }));
  assert.throws(() => readSettings({ GAME_ROOM_AUTH_MODE: 'legacy', GAME_ROOM_HOST: '0.0.0.0' }));
  assert.throws(() => readSettings({ GAME_ROOM_READ_CACHE_SECONDS: '61' }));
  assert.equal(readSettings({}).mode, 'legacy');
});

test('returnTo permits only exact local invitation routes and rejects encoded or duplicate escape', () => {
  const origin = 'https://game.sumomoli.com';
  for (const path of ['/', '/?room=123456', '/room.html?code=000000', '/army.html?code=001234']) assert.equal(safeReturnTo(path, origin), path);
  for (const path of ['https://evil.example/', '//evil.example', '/\\evil.example', '/?room=123456&room=654321', '/?room=%31%32%33%34%35%36', '/?room=123456%2526evil=1', '/room.html?code=123456&role=host', '/army.html?code=123456&side=red', '/army.html?code=123456#fake', '/army.html?code=%31%32%33%34%35%36', '/?room=12345', '/\n', '/auth/callback', '/?room=123456#evil']) assert.equal(safeReturnTo(path, origin), '/');
});

test('Cognito authorization requests only openid and binds PKCE S256, state, nonce and exact callback', async () => {
  const provider = new CognitoProvider({ issuer: SHARED_ISSUER, authDomain: 'https://sumomo-agora.auth.ap-northeast-1.amazoncognito.com', clientId: 'ownclient12345678', callback: 'https://game.sumomoli.com/auth/callback' });
  const start = await provider.begin('/?room=123456'); const url = new URL(start.url);
  assert.equal(url.searchParams.get('scope'), 'openid'); assert.equal(url.searchParams.get('redirect_uri'), 'https://game.sumomoli.com/auth/callback'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), start.transaction.state); assert.equal(url.searchParams.get('nonce'), start.transaction.nonce); assert.notEqual(url.searchParams.get('code_challenge'), start.transaction.codeVerifier);
});

test('independently signed JWTs enforce issuer, client, nonce, purpose, sub, time and scope', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256'); const jwk = await exportJWK(publicKey); jwk.kid = 'test-key';
  const seconds = Math.floor(Date.now() / 1000);
  const provider = new CognitoProvider({ issuer: SHARED_ISSUER, authDomain: 'https://sumomo-agora.auth.ap-northeast-1.amazoncognito.com', clientId: 'ownclient12345678' }, { jwks: createLocalJWKSet({ keys: [jwk] }) });
  const idClaims = { iss: SHARED_ISSUER, aud: 'ownclient12345678', sub: 'synthetic-sub', exp: seconds + 3600, iat: seconds, nonce: 'nonce-test', token_use: 'id' };
  const accessClaims = { iss: SHARED_ISSUER, sub: 'synthetic-sub', client_id: 'ownclient12345678', exp: seconds + 1800, iat: seconds, auth_time: seconds, scope: 'openid', token_use: 'access' };
  const sign = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
  const tokens = async (id = idClaims, access = accessClaims) => ({ id_token: await sign(id), access_token: await sign(access), token_type: 'Bearer' });
  assert.equal((await provider.verifyTokens(await tokens(), 'nonce-test')).expiresAt, (seconds + 1800) * 1000);
  for (const override of [{ aud: '15ieknek25quijgqdqcd8rfmom' }, { aud: ['ownclient12345678', '15ieknek25quijgqdqcd8rfmom'] }, { nonce: 'wrong' }, { token_use: 'access' }, { iss: 'https://other.example' }, { exp: seconds - 1 }, { iat: seconds + 1000 }]) await assert.rejects(provider.verifyTokens(await tokens({ ...idClaims, ...override }), 'nonce-test'), (e) => e.status === 401);
  for (const override of [{ client_id: '27ol1sbgk8g9c4deeqvjcifs77' }, { sub: 'other' }, { token_use: 'id' }, { scope: 'profile' }, { exp: seconds - 1 }]) await assert.rejects(provider.verifyTokens(await tokens(idClaims, { ...accessClaims, ...override }), 'nonce-test'), (e) => e.status === 401);
  const foreign = await generateKeyPair('RS256'); const forged = await new SignJWT(idClaims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(foreign.privateKey);
  await assert.rejects(provider.verifyTokens({ ...(await tokens()), id_token: forged }, 'nonce-test'), (e) => e.status === 401);
  await assert.rejects(provider.verifyTokens({ ...(await tokens()), id_token: {} }, 'nonce-test'), (e) => e.status === 401);
});

test('isolated authorization-code exchange transmits its own client and original PKCE verifier', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256'); const jwk = await exportJWK(publicKey); jwk.kid = 'grant-key';
  const settings = { issuer: SHARED_ISSUER, authDomain: 'https://synthetic-token.example', clientId: 'ownclient12345678', callback: 'https://game.sumomoli.com/auth/callback' };
  const provider = new CognitoProvider(settings, { jwks: createLocalJWKSet({ keys: [jwk] }) });
  const start = await provider.begin('/'); let exchange;
  const now = Math.floor(Date.now() / 1000);
  const sign = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'grant-key' }).sign(privateKey);
  const id = await sign({ iss: SHARED_ISSUER, aud: settings.clientId, sub: 'test-member', iat: now, exp: now + 3600, nonce: start.transaction.nonce, token_use: 'id' });
  const access = await sign({ iss: SHARED_ISSUER, client_id: settings.clientId, sub: 'test-member', iat: now, auth_time: now, exp: now + 1800, scope: 'openid', token_use: 'access' });
  provider.config[oidc.customFetch] = async (url, options) => { exchange = { url: String(url), body: new URLSearchParams(options.body) }; return new Response(JSON.stringify({ id_token: id, access_token: access, token_type: 'Bearer', expires_in: 1800 }), { headers: { 'content-type': 'application/json' } }); };
  const callback = new URL(settings.callback); callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('state', start.transaction.state);
  const identity = await provider.complete(callback, start.transaction);
  assert.equal(identity.sub, 'test-member'); assert.equal(exchange.url, 'https://synthetic-token.example/oauth2/token');
  assert.equal(exchange.body.get('client_id'), settings.clientId); assert.equal(exchange.body.get('code_verifier'), start.transaction.codeVerifier); assert.equal(exchange.body.get('redirect_uri'), settings.callback); assert.equal(exchange.body.get('grant_type'), 'authorization_code');
  const otherState = new URL(callback); otherState.searchParams.set('state', 'wrong');
  await assert.rejects(provider.complete(otherState, start.transaction), (e) => e.status === 401);
  provider.config[oidc.customFetch] = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  await assert.rejects(provider.complete(callback, start.transaction), (e) => e.status === 503);
});

test('JWKS acquisition HTTP, JSON and network failures return 503 while unknown signing keys stay 401', async () => {
  const { privateKey } = await generateKeyPair('RS256'); const now = Math.floor(Date.now() / 1000);
  const settings = { issuer: SHARED_ISSUER, authDomain: 'https://synthetic.example', clientId: 'ownclient12345678' };
  const id = await new SignJWT({ iss: SHARED_ISSUER, aud: settings.clientId, sub: 'synthetic', iat: now, exp: now + 3600, nonce: 'test-nonce', token_use: 'id' }).setProtectedHeader({ alg: 'RS256', kid: 'missing' }).sign(privateKey);
  const tokens = { id_token: id, access_token: id, token_type: 'Bearer' };
  for (const error of [new joseErrors.JOSEError('Expected HTTP 200; upstream returned 500'), new SyntaxError('Invalid remote JSON'), new TypeError('Network unavailable'), new joseErrors.JWKSTimeout(), new joseErrors.JWKSInvalid('Invalid remote key schema')]) {
    const provider = new CognitoProvider(settings, { jwks: async () => { throw error; } });
    await assert.rejects(provider.verifyTokens(tokens, 'test-nonce'), (e) => e.status === 503);
  }
  const unknownKey = new CognitoProvider(settings, { jwks: async () => { throw new joseErrors.JWKSNoMatchingKey(); } });
  await assert.rejects(unknownKey.verifyTokens(tokens, 'test-nonce'), (e) => e.status === 401);
});

test('central policy distinguishes invalid identity from transport, schema, throttling and server faults after real JWT validation', async () => {
  const base = { issuer: SHARED_ISSUER, authDomain: 'https://synthetic.example', clientId: 'ownclient12345678' };
  const { publicKey, privateKey } = await generateKeyPair('RS256'); const jwk = await exportJWK(publicKey); jwk.kid = 'policy-key';
  const seconds = Math.floor(Date.now() / 1000), jwks = createLocalJWKSet({ keys: [jwk] });
  const accessToken = await new SignJWT({ iss: SHARED_ISSUER, sub: 'a', client_id: base.clientId, iat: seconds, auth_time: seconds, exp: seconds + 1800, scope: 'openid', token_use: 'access' }).setProtectedHeader({ alg: 'RS256', kid: 'policy-key' }).sign(privateKey);
  const identity = { issuer: SHARED_ISSUER, sub: 'a', accessToken };
  for (const status of [401]) await assert.rejects(new CognitoProvider(base, { jwks, fetcher: async () => new Response('{}', { status }) }).check(identity), (e) => e.status === 401);
  for (const status of [403, 429, 500, 502]) await assert.rejects(new CognitoProvider(base, { jwks, fetcher: async () => new Response('{}', { status }) }).check(identity), (e) => e.status === 503);
  for (const body of ['not-json', '{}', '[]']) await assert.rejects(new CognitoProvider(base, { jwks, fetcher: async () => new Response(body) }).check(identity), (e) => e.status === 503);
  await assert.rejects(new CognitoProvider(base, { jwks, fetcher: async () => { throw new Error('network'); } }).check(identity), (e) => e.status === 503);
  await assert.rejects(new CognitoProvider(base, { jwks, fetcher: async () => Response.json({ version: 1, revokedBefore: 0, issuer: SHARED_ISSUER, sub: 'other', clientId: base.clientId, authTime: seconds }) }).check(identity), (e) => e.status === 401);
});

test('login transaction is bound to browser, consumed once, and returns to an invitation without tokens', async () => {
  const f = fixture(); const logged = await login(f, '/room.html?code=123456');
  assert.equal(logged.callback.headers.location, '/room.html?code=123456');
  assert.equal(JSON.stringify(logged.callback).includes('server-only-token'), false);
  const replay = await f.service.route(logged.callbackRequest); assert.equal(replay.status, 401);
  const state = await f.service.state(createRequest('/api/state', logged.cookie)); assert.equal(state.authenticated, true); assert.ok(state.csrf); assert.equal(state.email, undefined); assert.equal(state.name, undefined);
  const second = await f.service.route(createRequest('/auth/login')); const secondState = new URL(second.headers.location).searchParams.get('state');
  assert.equal((await f.service.route(createRequest(`/auth/callback?state=${secondState}&code=synthetic`))).status, 401);
  f.tick(300001);
  assert.equal((await f.service.route(createRequest(`/auth/callback?state=${secondState}&code=synthetic`, cookieValue(second, f.settings.transactionCookieName)))).status, 401);
});

test('mismatched state and duplicate callback state cannot yield a session and burn that transaction', async () => {
  const f = fixture(); const start = await f.service.route(createRequest('/auth/login')); const cookie = cookieValue(start, f.settings.transactionCookieName); const state = new URL(start.headers.location).searchParams.get('state');
  assert.equal((await f.service.route(createRequest('/auth/callback?state=wrong&code=synthetic', cookie))).status, 401);
  assert.equal((await f.service.route(createRequest(`/auth/callback?state=${state}&code=synthetic`, cookie))).status, 401);
  const again = await f.service.route(createRequest('/auth/login')); const anotherState = new URL(again.headers.location).searchParams.get('state');
  assert.equal((await f.service.route(createRequest(`/auth/callback?state=${anotherState}&state=${anotherState}&code=synthetic`, cookieValue(again, f.settings.transactionCookieName)))).status, 401);
});

test('host-only secure production cookies use a separate development name and require exact Origin plus CSRF', async () => {
  const f = fixture(); const logged = await login(f); const session = await f.service.authorize(createRequest('/api/rooms', logged.cookie));
  const production = new SessionService({ ...f.settings, secureCookies: true, cookieName: '__Host-game-room-session' }, { store: f.store, provider: f.provider });
  const cookie = production.cookie('__Host-game-room-session', opaqueId(), 3600);
  for (const attribute of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure']) assert.ok(cookie.includes(attribute)); assert.equal(cookie.includes('Domain='), false);
  assert.throws(() => f.service.checkWrite(createRequest('/', logged.cookie, { origin: 'https://agora.sumomoli.com', 'x-csrf-token': session.csrf }, 'POST'), session), (e) => e.status === 403);
  assert.throws(() => f.service.checkWrite(createRequest('/', logged.cookie, { origin: f.settings.origin, 'x-csrf-token': 'bad' }, 'POST'), session), (e) => e.status === 403);
  assert.equal(f.service.checkWrite(createRequest('/', logged.cookie, { origin: f.settings.origin, 'x-csrf-token': session.csrf }, 'POST'), session), true);
});

test('every read and write checks identity anew; 503 never falls back to an earlier success', async () => {
  const f = fixture(); const logged = await login(f); const request = createRequest('/api/rooms', logged.cookie); const checks = f.provider.checks;
  await f.service.authorize(request); assert.equal(f.provider.checks, checks + 1);
  f.tick(59999); await f.service.authorize(request); assert.equal(f.provider.checks, checks + 2);
  f.tick(1); await f.service.authorize(request); assert.equal(f.provider.checks, checks + 3);
  await f.service.authorize(request, { fresh: true }); assert.equal(f.provider.checks, checks + 4);
  const events = []; f.service.subscribeInvalidation((event) => events.push(event)); f.provider.status = 503;
  await assert.rejects(f.service.authorize(request, { fresh: true }), (e) => e.status === 503);
  await assert.rejects(f.service.authorize(request), (e) => e.status === 503); assert.equal(events.at(-1).status, 503);
  f.provider.status = 200; await f.service.authorize(request); f.provider.status = 401;
  await assert.rejects(f.service.authorize(request, { fresh: true }), (e) => e.status === 401);
  assert.equal((await f.service.state(request)).authenticated, false);
});

test('project logout removes only its session and rejects delayed verification without resurrection', async () => {
  const f = fixture(); const logged = await login(f); const request = createRequest('/api/rooms', logged.cookie); const session = await f.service.authorize(request);
  await f.store.put('game-profiles', session.userKey, { nickname: 'kept' }); await f.store.put('rooms', '123456', { hand: [1, 2, 3] });
  let release; let entered; const entry = new Promise((resolve) => { entered = resolve; });
  f.provider.check = async (identity) => { entered(); await new Promise((resolve) => { release = resolve; }); return { sub: identity.sub }; };
  const delayed = f.service.authorize(request, { fresh: true }); await entry;
  const logout = await f.service.route(createRequest('/auth/logout', logged.cookie, { origin: f.settings.origin, 'x-csrf-token': session.csrf }, 'POST'));
  assert.equal(logout.status, 200); assert.equal(logout.body.postLogoutUri, '/'); release();
  await assert.rejects(delayed, (e) => e.status === 401);
  assert.equal(await f.store.get('sessions', session.id), null);
  assert.equal((await f.store.get('game-profiles', session.userKey)).nickname, 'kept'); assert.deepEqual((await f.store.get('rooms', '123456')).hand, [1, 2, 3]);
});

for (const phase of ['complete', 'check']) test(`project logout cancels an in-flight callback during ${phase} without issuing a new session cookie`, async () => {
  const f = fixture(); const start = await f.service.route(createRequest('/auth/login')); const transactionCookie = cookieValue(start, f.settings.transactionCookieName);
  const state = new URL(start.headers.location).searchParams.get('state');
  let release; let entered; const entry = new Promise((resolve) => { entered = resolve; }); const original = f.provider[phase].bind(f.provider);
  f.provider[phase] = async (...args) => { entered(); await new Promise((resolve) => { release = resolve; }); return original(...args); };
  const delayed = f.service.route(createRequest(`/auth/callback?state=${state}&code=synthetic`, transactionCookie)); await entry;
  const transactionId = transactionCookie.split('=')[1]; const verifying = await f.store.get('transactions', transactionId); const candidateId = verifying.candidateSessionId;
  assert.equal((await f.store.get('sessions', candidateId)).phase, 'pending');
  await assert.rejects(f.service.authorize(createRequest('/api/rooms', `${f.settings.cookieName}=${candidateId}`)), (e) => e.status === 401);
  const logout = await f.service.route(createRequest('/auth/logout', transactionCookie, { origin: f.settings.origin }, 'POST')); assert.equal(logout.status, 200);
  assert.equal((await f.store.get('transactions', transactionId)).phase, 'cancelled'); release();
  const callback = await delayed; assert.equal(callback.status, 401);
  assert.equal(callback.headers['set-cookie'].some((value) => value.startsWith(`${f.settings.cookieName}=`) && !value.startsWith(`${f.settings.cookieName}=;`)), false);
  assert.equal(await f.store.get('sessions', candidateId), null);
});

test('logout after transaction completion defeats the reserved-session activation CAS', async () => {
  const f = fixture(); const start = await f.service.route(createRequest('/auth/login')); const transactionCookie = cookieValue(start, f.settings.transactionCookieName);
  const state = new URL(start.headers.location).searchParams.get('state');
  let release; let entered; const entry = new Promise((resolve) => { entered = resolve; }); const original = f.store.guardedCAS.bind(f.store);
  f.store.guardedCAS = async (scope, id, revision, value, expiresAt, guard) => {
    if (scope === 'sessions' && value.phase === 'active') { entered(); await new Promise((resolve) => { release = resolve; }); }
    return original(scope, id, revision, value, expiresAt, guard);
  };
  const delayed = f.service.route(createRequest(`/auth/callback?state=${state}&code=synthetic`, transactionCookie)); await entry;
  const transaction = await f.store.get('transactions', transactionCookie.split('=')[1]); assert.equal(transaction.phase, 'completed');
  const logout = await f.service.route(createRequest('/auth/logout', transactionCookie, { origin: f.settings.origin }, 'POST')); assert.equal(logout.status, 200);
  release(); const callback = await delayed; assert.equal(callback.status, 401);
  assert.equal(await f.store.get('sessions', transaction.candidateSessionId), null);
  assert.equal(callback.headers['set-cookie'].some((value) => value.startsWith(`${f.settings.cookieName}=`) && !value.startsWith(`${f.settings.cookieName}=;`)), false);
});

for (const phase of ['complete', 'check']) test(`a callback exceeding its five-minute transaction while waiting for ${phase} is rejected`, async () => {
  const f = fixture(); const start = await f.service.route(createRequest('/auth/login')); const transactionCookie = cookieValue(start, f.settings.transactionCookieName);
  const state = new URL(start.headers.location).searchParams.get('state'); const original = f.provider[phase].bind(f.provider);
  f.provider[phase] = async (...args) => { const result = await original(...args); f.tick(300001); return result; };
  const callback = await f.service.route(createRequest(`/auth/callback?state=${state}&code=synthetic`, transactionCookie)); assert.equal(callback.status, 401);
  assert.equal(callback.headers['set-cookie'].some((value) => value.startsWith(`${f.settings.cookieName}=`) && !value.startsWith(`${f.settings.cookieName}=;`)), false);
  assert.equal([...f.store.adapter.records.keys()].some((value) => value.startsWith('sessions:')), false);
});

test('absolute and idle expiration stop a session without changing a game record', async () => {
  const f = fixture(); const logged = await login(f); const request = createRequest('/api/rooms', logged.cookie);
  await f.store.put('rooms', '123456', { turn: 'member-one' }); f.tick(1800000);
  await assert.rejects(f.service.authorize(request), (e) => e.status === 401);
  assert.equal((await f.store.get('rooms', '123456')).turn, 'member-one');
  const another = fixture(); const second = await login(another); const next = createRequest('/api/rooms', second.cookie);
  for (let i = 0; i < 3; i++) { another.tick(1000000); await another.service.authorize(next); }
  another.tick(600000); await assert.rejects(another.service.authorize(next), (e) => e.status === 401);
});

test('SSE checks do not renew idle time and late online success cannot pass expired token limits', async () => {
  const f = fixture(); const logged = await login(f); const request = createRequest('/api/rooms', logged.cookie); const first = await f.service.authorize(request, { touch: false });
  for (let i = 0; i < 5; i++) { f.tick(300000); const current = await f.service.authorize(request, { touch: false }); assert.equal(current.idleUntil, first.idleUntil); }
  f.tick(300000); await assert.rejects(f.service.authorize(request, { touch: false }), (e) => e.status === 401);
  const second = fixture(); const next = await login(second); const nextRequest = createRequest('/api/rooms', next.cookie);
  second.provider.check = async (identity) => { second.tick(3600000); return { sub: identity.sub }; };
  await assert.rejects(second.service.authorize(nextRequest, { fresh: true }), (e) => e.status === 401);
});

test('new login rotates the project session and duplicate cookie values never select an identity', async () => {
  const f = fixture(); const first = await login(f); const initial = await f.service.authorize(createRequest('/api/rooms', first.cookie));
  const start = await f.service.route(createRequest('/auth/login', first.cookie)); const state = new URL(start.headers.location).searchParams.get('state');
  const callback = await f.service.route(createRequest(`/auth/callback?state=${state}&code=synthetic`, `${first.cookie}; ${cookieValue(start, f.settings.transactionCookieName)}`));
  assert.equal(callback.status, 303); assert.notEqual(cookieValue(callback, f.settings.cookieName), first.cookie); assert.equal(await f.store.get('sessions', initial.id), null);
  await assert.rejects(f.service.authorize(createRequest('/api/rooms', `${cookieValue(callback, f.settings.cookieName)}; ${first.cookie}`)), (e) => e.status === 401);
});
