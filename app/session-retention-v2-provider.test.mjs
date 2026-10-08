import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import * as oidc from 'openid-client';
import { CognitoProvider, IdentityFailure } from '../server/auth.mjs';
import { readSettings, SHARED_ISSUER } from '../server/config.mjs';

const keys = await generateKeyPair('RS256'), jwk = await exportJWK(keys.publicKey);
jwk.kid = 'retention-v2-isolated';
const jwks = createLocalJWKSet({ keys: [jwk] });
const failure = status => error => error instanceof IdentityFailure && error.status === status;
const env = { GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'retentionfixture1234', GAME_ROOM_SESSION_REFRESH_ENABLED: '1' };

async function fixture({ idChange = {}, accessChange = {}, response, refreshToken } = {}) {
  const settings = readSettings(env), clock = Math.floor(Date.now() / 1000) * 1000, seconds = clock / 1000;
  const session = { issuer: SHARED_ISSUER, clientId: settings.clientId, sub: 'fictional-retained-member',
    authTime: seconds - 86400, refreshToken: 'fictional-refresh-private' };
  const sign = payload => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(keys.privateKey);
  const common = { iss: SHARED_ISSUER, sub: session.sub, iat: seconds, exp: seconds + 3600, auth_time: session.authTime };
  const tokens = { token_type: 'Bearer', access_token: await sign({ ...common, token_use: 'access', client_id: settings.clientId, scope: 'openid', ...accessChange }),
    id_token: await sign({ ...common, token_use: 'id', aud: settings.clientId, ...idChange }),
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }) };
  let calls = 0;
  const provider = new CognitoProvider(settings, { now: () => clock, jwks,
    fetcher: async () => { assert.fail('Refresh should use its request-owned configured fetch'); },
    policyClient: { check: async () => { assert.fail('Provider refresh does not authorize business before SessionService policy checks'); } } });
  provider.config[oidc.customFetch] = async (url, options) => {
    calls++;
    assert.equal(String(url), settings.authDomain + '/oauth2/token');
    assert.equal(options.signal instanceof AbortSignal, true);
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('client_id'), settings.clientId);
    assert.equal(body.get('refresh_token'), session.refreshToken);
    return response ? response(options) : Response.json(tokens);
  };
  return { settings, provider, session, clock, seconds, calls: () => calls, tokens };
}

test('retention is opt-in, bounded and leaves legacy lifetime and existing identity interval unchanged', () => {
  const old = readSettings({ GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: env.GAME_ROOM_CLIENT_ID });
  assert.equal(old.sessionRefreshEnabled, false); assert.equal(old.absoluteMs, 3600000); assert.equal(old.idleMs, 1800000);
  assert.equal(old.identityCheckIntervalMs, 250);
  for (const invalid of ['', 'true', ' 1', '2']) assert.throws(() => readSettings({ ...env, GAME_ROOM_SESSION_REFRESH_ENABLED: invalid }));
  for (const invalid of ['0', '31', '1.5', ' 30', '030']) assert.throws(() => readSettings({ ...env, GAME_ROOM_SESSION_MAX_DAYS: invalid }));
  assert.throws(() => readSettings({ ...env, GAME_ROOM_AUTH_MODE: 'mock' }));
  assert.equal(readSettings({ ...env, GAME_ROOM_SESSION_MAX_DAYS: '1', GAME_ROOM_IDENTITY_CHECK_INTERVAL_MS: '125' }).identityCheckIntervalMs, 125);
});

test('refresh verifies signed own ID/access without a new nonce and retains original auth_time with optional rotation', async () => {
  const f = await fixture({ refreshToken: 'fictional-rotated-refresh' }), value = await f.provider.refresh(f.session);
  assert.equal(value.authTime, f.session.authTime); assert.equal(value.sub, f.session.sub);
  assert.equal(value.clientId, f.settings.clientId); assert.equal(value.refreshToken, 'fictional-rotated-refresh');
  assert.equal(value.expiresAt, f.clock + 3600000); assert.equal(f.calls(), 1);
});

test('refresh rejects changed subject, original authentication time, client and token purpose', async t => {
  for (const changes of [ { idChange: { sub: 'other-member' } }, { accessChange: { sub: 'other-member' } },
    { idChange: { auth_time: 1 } }, { accessChange: { auth_time: 1 } },
    { accessChange: { client_id: 'foreignclient1234' } }, { accessChange: { token_use: 'id' } } ]) {
    await t.test(JSON.stringify(changes), async () => { const f = await fixture(changes); await assert.rejects(f.provider.refresh(f.session), failure(401)); });
  }
});

test('refresh classifies only explicit invalid_grant as revoked; unknown network, throttling and malformed responses stay 503', async t => {
  for (const [name, status, response] of [
    ['invalid_grant', 401, () => Response.json({ error: 'invalid_grant' }, { status: 400 })],
    ['throttle', 503, () => Response.json({ error: 'temporarily_unavailable' }, { status: 429 })],
    ['network', 503, () => { throw new TypeError('fictional network unavailable'); }],
    ['malformed', 503, () => Response.json({ token_type: 'Bearer' })],
  ]) await t.test(name, async () => {
    const f = await fixture({ response }); await assert.rejects(f.provider.refresh(f.session), failure(status));
    assert.equal(f.calls(), 1, 'Unknown grant outcomes must not be replayed');
  });
});

test('refresh cancellation reaches the real grant fetch and cannot produce a late accepted token', async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture({ response: options => new Promise((resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }) });
  const controller = new AbortController(), pending = f.provider.refresh(f.session, { signal: controller.signal });
  await entered; controller.abort(); await assert.rejects(pending, failure(503)); assert.equal(f.calls(), 1);
});
