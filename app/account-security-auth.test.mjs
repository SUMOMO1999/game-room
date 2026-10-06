import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, jwtVerify } from 'jose';
import { CognitoProvider, IdentityFailure, withIdentityDeadline } from '../server/auth.mjs';
import { IdentityPolicyClient } from '../server/identity-policy-client.mjs';
import { readSettings, SHARED_ISSUER } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { SessionService } from '../server/session-service.mjs';

const pair = await generateKeyPair('RS256'), jwk = await exportJWK(pair.publicKey); jwk.kid = 'e3-fictional-key';
const jwks = createLocalJWKSet({ keys: [jwk] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = status => error => error instanceof IdentityFailure && error.status === status;
const settings = () => readSettings({ GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'ownclient12345678' });
const request = (f, path = '/api/state', cookie = '', method = 'GET', headers = {}) => new Request(`${f.settings.origin}${path}`, { method, headers: { cookie, ...headers } });
const cookie = (response, name) => response.headers['set-cookie'].find(value => value.startsWith(`${name}=`)).split(';')[0];

async function fixture(extra = {}) {
  let offset = 0; const now = () => Date.now() + offset, own = settings(), issued = Math.floor(now() / 1000);
  const claims = { iss: SHARED_ISSUER, sub: 'fictional-e3-member', client_id: own.clientId, iat: issued,
    exp: issued + 3600, auth_time: issued - 60, scope: 'openid', token_use: 'access' };
  const sign = (payload, key = pair.privateKey) => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(key);
  const token = await sign(claims), state = { status: 200, cutoff: 0, calls: [], handler: null };
  const fetcher = async (url, options) => {
    state.calls.push({ url, options });
    if (state.handler) return state.handler(url, options);
    if (state.status !== 200) return new Response('{}', { status: state.status });
    const { payload } = await jwtVerify(options.headers.Authorization.slice(7), jwks, { issuer: SHARED_ISSUER, algorithms: ['RS256'], currentDate: new Date(now()) });
    return Response.json({ version: 1, revokedBefore: state.cutoff, issuer: payload.iss, sub: payload.sub,
      clientId: payload.client_id, authTime: payload.auth_time });
  };
  const storage = new EncryptedStore(new MemoryAdapter({ now }), randomBytes(32), now);
  const provider = new CognitoProvider(own, { jwks, fetcher, now, ...extra.providerOptions });
  const service = new SessionService(own, { store: storage, provider, now, ...extra.serviceOptions });
  provider.complete = async (_url, transaction) => provider.verifyTokens({ access_token: token,
    id_token: await sign({ iss: SHARED_ISSUER, sub: claims.sub, aud: own.clientId, iat: issued, exp: issued + 3600,
      token_use: 'id', nonce: transaction.nonce }), token_type: 'Bearer' }, transaction.nonce);
  const id = opaqueId(), userKey = identityKey(SHARED_ISSUER, claims.sub);
  const saved = { phase: 'active', issuer: SHARED_ISSUER, sub: claims.sub, userKey, accessToken: token,
    authTime: claims.auth_time, clientId: own.clientId, csrf: opaqueId(), createdAt: now() - 10000,
    expiresAt: claims.exp * 1000, idleUntil: now() + 1800000, lastIdentityCheck: now() - 1000 };
  await storage.put('sessions', id, saved, saved.idleUntil);
  return { settings: own, now, advance: ms => { offset += ms; }, claims, sign, token, state, storage, provider, service,
    id, userKey, saved, cookie: `${own.cookieName}=${id}` };
}

test('access identity must be verified before any central request, including signed auth_time invariants', async () => {
  const f = await fixture();
  const identity = { issuer: SHARED_ISSUER, sub: f.claims.sub, accessToken: f.token };
  const verified = await f.provider.check(identity);
  assert.equal(verified.authTime, f.claims.auth_time); assert.equal(verified.clientId, f.settings.clientId);
  assert.equal(f.state.calls.length, 1);
  for (const change of [{ auth_time: undefined }, { auth_time: -1 }, { auth_time: '1' }, { auth_time: 1.5 },
    { auth_time: Math.floor(f.now() / 1000) + 1 }, { iat: f.claims.auth_time - 1 }, { client_id: 'foreignclient1234' },
    { token_use: 'id' }, { scope: 'profile' }, { iss: 'https://other.example' }, { sub: 'other' }, { exp: f.claims.iat - 1 }]) {
    const invalid = await f.sign({ ...f.claims, ...change });
    await assert.rejects(f.provider.check({ ...identity, accessToken: invalid }), failure(401));
  }
  const foreign = await generateKeyPair('RS256');
  await assert.rejects(f.provider.check({ ...identity, accessToken: await f.sign(f.claims, foreign.privateKey) }), failure(401));
  await assert.rejects(f.provider.check({ ...identity, authTime: f.claims.auth_time + 1 }), failure(401));
  await assert.rejects(f.provider.check({ ...identity, clientId: 'foreignclient1234' }), failure(401));
  assert.equal(f.state.calls.length, 1, 'unverified or mismatched claims never reach the central API');
});

test('old sessions upgrade only from their signed access token without changing identity or business seat', async () => {
  const f = await fixture(), old = { ...f.saved }; delete old.authTime; delete old.clientId;
  await f.storage.put('sessions', f.id, old, old.idleUntil);
  await f.storage.put('rooms', 'preserved-seat', { userKey: f.userKey, seatId: 'same-seat', rack: ['synthetic-private-card'] });
  const result = await f.service.authorize(request(f, '/api/state', f.cookie), { fresh: false, touch: false });
  const stored = await f.storage.get('sessions', f.id);
  assert.equal(stored.authTime, f.claims.auth_time); assert.equal(stored.clientId, f.settings.clientId);
  assert.equal(stored.userKey, f.userKey); assert.equal(result.userKey, f.userKey); assert.equal(stored.csrf, old.csrf);
  assert.deepEqual(await f.storage.get('rooms', 'preserved-seat'), { userKey: f.userKey, seatId: 'same-seat', rack: ['synthetic-private-card'] });
  assert.ok(!JSON.stringify(result).includes(f.token));
});

test('fresh false still checks policy anew; 503 preserves sessions and games, cutoff equality gives 401 invalidation', async () => {
  const f = await fixture(), events = []; f.service.subscribeInvalidation(event => events.push(event));
  await f.storage.put('rooms', 'kept', { hand: ['kept'], owner: f.userKey });
  await f.service.authorize(request(f, '/api/state', f.cookie), { fresh: false, touch: false });
  f.state.status = 503;
  await assert.rejects(f.service.authorize(request(f, '/api/state', f.cookie), { fresh: false, touch: false }), failure(503));
  assert.ok(await f.storage.get('sessions', f.id)); assert.equal(events.at(-1).status, 503);
  f.state.status = 200; f.state.cutoff = f.claims.auth_time;
  await assert.rejects(f.service.authorize(request(f, '/api/state', f.cookie), { fresh: false, touch: false }), failure(401));
  assert.equal(await f.storage.get('sessions', f.id), null); assert.equal(events.at(-1).status, 401);
  assert.deepEqual(await f.storage.get('rooms', 'kept'), { hand: ['kept'], owner: f.userKey });
  assert.equal(f.state.calls.length, 3);
});

test('simultaneous exact-token read-only gates share only pending central checks and avoid session write contention', async () => {
  const f = await fixture(); let release, entered; const entry = new Promise(resolve => { entered = resolve; });
  f.state.handler = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const pending = Array.from({ length: 14 }, () => f.service.authorize(request(f, '/api/state', f.cookie), { touch: false }));
  await entry; await sleep(5); assert.equal(f.state.calls.length, 1);
  release(Response.json({ version: 1, revokedBefore: 0, issuer: SHARED_ISSUER, sub: f.claims.sub,
    clientId: f.settings.clientId, authTime: f.claims.auth_time }));
  const results = await Promise.all(pending); assert.ok(results.every(result => result.userKey === f.userKey));
  f.state.handler = null;
  await f.service.authorize(request(f, '/api/state', f.cookie), { touch: false }); assert.equal(f.state.calls.length, 2);
});

test('different real signed tokens for the same subject cannot borrow the new authentication cutoff result', async () => {
  const f = await fixture(), newer = { ...f.claims, auth_time: f.claims.auth_time + 1 }, newToken = await f.sign(newer);
  const waiting = [];
  f.state.handler = (_url, options) => new Promise(resolve => waiting.push({ options, resolve }));
  const old = f.provider.check({ issuer: SHARED_ISSUER, sub: f.claims.sub, accessToken: f.token });
  const current = f.provider.check({ issuer: SHARED_ISSUER, sub: f.claims.sub, accessToken: newToken });
  while (waiting.length < 2) await sleep(10);
  for (const item of waiting) {
    const accessToken = item.options.headers.Authorization.slice(7), authTime = accessToken === f.token ? f.claims.auth_time : newer.auth_time;
    item.resolve(Response.json({ version: 1, revokedBefore: f.claims.auth_time, issuer: SHARED_ISSUER,
      sub: f.claims.sub, clientId: f.settings.clientId, authTime }));
  }
  await assert.rejects(old, failure(401)); assert.equal((await current).authTime, newer.auth_time);
});

test('Cognito check deadline includes cold JWKS and central parsing, and late keys cannot start a request', async () => {
  const f = await fixture(); let release;
  const lateKeys = new CognitoProvider(f.settings, { now: f.now, checkTimeoutMs: 20,
    jwks: (...args) => new Promise(resolve => { release = () => resolve(jwks(...args)); }),
    fetcher: async () => { assert.fail('late JWKS must never proceed to central'); } });
  await assert.rejects(lateKeys.check({ issuer: SHARED_ISSUER, sub: f.claims.sub, accessToken: f.token }), failure(503));
  release(); await sleep(5);
  let sent;
  const whole = new CognitoProvider(f.settings, { now: f.now, checkTimeoutMs: 35,
    jwks: async (...args) => { await sleep(20); return jwks(...args); }, fetcher: async (_url, options) => {
      sent = options; return { status: 200, ok: true, json: async () => { await sleep(30); return {}; } };
    } });
  const start = performance.now(); await assert.rejects(whole.check({ issuer: SHARED_ISSUER, sub: f.claims.sub, accessToken: f.token }), failure(503));
  assert.ok(performance.now() - start < 90); assert.equal(sent.signal.aborted, true);
  assert.throws(() => new CognitoProvider(f.settings, { checkTimeoutMs: 10001 }), TypeError);
  let clock = f.now(), calls = 0;
  const expiresDuringKeys = new CognitoProvider(f.settings, { now: () => clock,
    jwks: async (...args) => { clock += 3600001; return jwks(...args); }, fetcher: async () => { calls++; return Response.json({}); } });
  await assert.rejects(expiresDuringKeys.check({ issuer: SHARED_ISSUER, sub: f.claims.sub, accessToken: f.token }), failure(401));
  assert.equal(calls, 0, 'token expiration while acquiring keys is caught before central transmission');
});

test('authorize uses one budget across retries and a late guarded CAS cannot change the saved session', async () => {
  const f = await fixture({ serviceOptions: { authorizationTimeoutMs: 30 } }), original = f.storage.guardedCAS.bind(f.storage);
  let release, entered; const entry = new Promise(resolve => { entered = resolve; }); let lateResult;
  f.storage.guardedCAS = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); lateResult = await original(...args); return lateResult; };
  const pending = f.service.authorize(request(f, '/api/state', f.cookie)); await entry;
  await assert.rejects(pending, failure(503)); release(); await sleep(5);
  assert.equal(lateResult, false); assert.deepEqual(await f.storage.get('sessions', f.id), f.saved);
  const retry = await fixture({ serviceOptions: { authorizationTimeoutMs: 35 } }); let checks = 0;
  retry.provider.check = async identity => { checks++; await sleep(12); return { ...identity }; };
  retry.storage.guardedCAS = async () => { await sleep(10); return false; };
  const start = performance.now(); await assert.rejects(retry.service.authorize(request(retry, '/api/state', retry.cookie)), failure(503));
  assert.ok(performance.now() - start < 90); assert.ok(checks <= 3);
  assert.ok(await retry.storage.get('sessions', retry.id));
});

test('event-loop delay past the deadline cannot return a previously resolved identity', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(withIdentityDeadline(() => assert.fail('already cancelled work must not start'), { signal: cancelled.signal }), failure(503));
  await assert.rejects(withIdentityDeadline(async deadline => {
    await deadline.wait(() => Promise.resolve());
    const end = performance.now() + 20; while (performance.now() < end) { /* Synthetic blocked loop. */ }
    return 'must not authorize';
  }, { timeoutMs: 10 }), failure(503));
});

test('central rejection during callback keeps confirmed invitation and the old session without issuing a candidate cookie', async () => {
  const f = await fixture(); f.state.status = 503;
  const begun = await f.service.route(request(f, '/auth/login?returnTo=' + encodeURIComponent('/room.html?code=123456'), f.cookie));
  const state = new URL(begun.headers.location).searchParams.get('state'), txCookie = cookie(begun, f.settings.transactionCookieName);
  const response = await f.service.route(request(f, `/auth/callback?state=${state}&code=fictional`, `${f.cookie}; ${txCookie}`));
  assert.equal(response.status, 503); assert.equal(response.body.returnTo, '/room.html?code=123456');
  assert.ok(await f.storage.get('sessions', f.id));
  assert.ok(response.headers['set-cookie'].every(value => !value.startsWith(`${f.settings.cookieName}=`)));
  f.state.status = 401;
  const next = await f.service.route(request(f, '/auth/login?returnTo=' + encodeURIComponent('/?room=654321')));
  const nextState = new URL(next.headers.location).searchParams.get('state');
  const denied = await f.service.route(request(f, `/auth/callback?state=${nextState}&code=fictional`, cookie(next, f.settings.transactionCookieName)));
  assert.equal(denied.status, 401); assert.equal(denied.body.returnTo, '/?room=654321');
});

test('project logout defeats a callback waiting on the real signed token central check', async () => {
  const f = await fixture(); let release, entered; const entry = new Promise(resolve => { entered = resolve; });
  f.state.handler = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const begun = await f.service.route(request(f, '/auth/login?returnTo=' + encodeURIComponent('/?room=123456')));
  const state = new URL(begun.headers.location).searchParams.get('state'), txCookie = cookie(begun, f.settings.transactionCookieName);
  const pending = f.service.route(request(f, `/auth/callback?state=${state}&code=fictional`, txCookie)); await entry;
  const txId = txCookie.split('=')[1], candidate = (await f.storage.get('transactions', txId)).candidateSessionId;
  await f.service.logout(request(f, '/auth/logout', txCookie, 'POST', { Origin: f.settings.origin }));
  release(Response.json({ version: 1, revokedBefore: 0, issuer: SHARED_ISSUER, sub: f.claims.sub,
    clientId: f.settings.clientId, authTime: f.claims.auth_time }));
  const response = await pending; assert.equal(response.status, 401); assert.equal(response.body.returnTo, '/?room=123456');
  assert.equal(await f.storage.get('sessions', candidate), null);
  assert.ok(response.headers['set-cookie'].every(value => !value.startsWith(`${f.settings.cookieName}=`) || value.includes('Max-Age=0')));
});
