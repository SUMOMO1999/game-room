import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { CognitoProvider, IdentityFailure } from '../server/auth.mjs';
import { IdentityBatchClient } from '../server/identity-batch-client.mjs';
import { IDENTITY_BATCH_ENDPOINT } from '../server/identity-batch-wire.mjs';
import { createIdentityCheckContext } from '../server/identity-check-context.mjs';
import { readSettings, SHARED_ISSUER } from '../server/config.mjs';
import { SessionService } from '../server/session-service.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey, opaqueId } from '../server/storage.mjs';

// All keys, accounts, tokens, sessions and SQLite rows in this file are synthetic.
// Only the fixed batch endpoint is simulated. CognitoProvider, jose verification,
// batch signing/projection and conditional encrypted storage are real modules.
const accessKeys = await generateKeyPair('RS256');
const accessJwk = { ...await exportJWK(accessKeys.publicKey), kid: 'batch-runtime-jwt' };
const jwks = createLocalJWKSet({ keys: [accessJwk] });
const callerKeys = generateKeyPairSync('ed25519');
const CALLER = 'local-runtime-v1';
const COMPONENTS = '("@method" "@scheme" "@authority" "@path" "content-digest" "content-type" "x-agora-audience")';
const failed = status => error => error instanceof IdentityFailure && error.status === status;
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
async function settled(predicate) {
  const end = performance.now() + 1000;
  while (!predicate()) {
    assert.ok(performance.now() < end, 'local asynchronous work did not settle');
    await nextTurn();
  }
}
const response = (batch, entries) => Response.json({ version: 1, batchRef: batch.batchRef, entries });

function verifyEnvelope(options, nowMs, seenNonces) {
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Accept-Encoding', 'Content-Digest', 'Content-Type',
    'Signature', 'Signature-Input', 'X-Agora-Audience']);
  assert.equal(options.headers.Accept, 'application/json'); assert.equal(options.headers['Accept-Encoding'], 'identity');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['X-Agora-Audience'], 'agora.identity.batch.v1');
  assert.ok(Buffer.isBuffer(options.body) && options.body.length <= 147456);
  const actualDigest = `sha-256=:${createHash('sha256').update(options.body).digest('base64')}:`;
  assert.equal(options.headers['Content-Digest'], actualDigest);
  const signatureInput = options.headers['Signature-Input'];
  assert.ok(signatureInput.startsWith(`agora=${COMPONENTS};`));
  const parameters = signatureInput.slice('agora='.length);
  const values = /^;created=(\d+);expires=(\d+);nonce="([A-Za-z0-9_-]{43})";keyid="local-runtime-v1";alg="ed25519"$/.exec(
    parameters.slice(COMPONENTS.length));
  assert.ok(values, 'only the fixed RFC 9421 profile is accepted');
  const [, createdText, expiresText, nonce] = values, created = Number(createdText), expires = Number(expiresText);
  assert.ok(created <= Math.floor(nowMs / 1000) && expires > created && expires - created <= 10 && nowMs < expires * 1000);
  const signatureText = /^agora=:([A-Za-z0-9+/]+={0,2}):$/.exec(options.headers.Signature);
  assert.ok(signatureText);
  const base = ['"@method": POST', '"@scheme": https', '"@authority": agora.sumomoli.com',
    '"@path": /api/identity/batch', `"content-digest": ${actualDigest}`, '"content-type": application/json',
    '"x-agora-audience": agora.identity.batch.v1', `"@signature-params": ${parameters}`].join('\n');
  assert.equal(verify(null, Buffer.from(base), callerKeys.publicKey, Buffer.from(signatureText[1], 'base64')), true);
  assert.ok(!seenNonces.has(nonce), 'a fresh request cannot reuse an envelope nonce'); seenNonces.add(nonce);
  const batch = JSON.parse(options.body.toString('utf8'));
  assert.deepEqual(Object.keys(batch), ['version', 'batchRef', 'entries']);
  assert.equal(batch.version, 1); assert.equal(batch.batchRef, nonce);
  assert.ok(batch.entries.length >= 1 && batch.entries.length <= 16);
  assert.equal(new Set(batch.entries.map(entry => entry.ref)).size, batch.entries.length);
  assert.ok(batch.entries.every(entry => Number.isSafeInteger(entry.triggeredAtMs)
    && Number.isSafeInteger(entry.queueUntilMs) && Number.isSafeInteger(entry.deadlineMs)
    && entry.triggeredAtMs <= entry.queueUntilMs && entry.queueUntilMs <= entry.deadlineMs
    && entry.queueUntilMs - entry.triggeredAtMs <= 4000 && entry.deadlineMs - entry.triggeredAtMs <= 8000));
  assert.deepEqual(Buffer.from(JSON.stringify({ version: 1, batchRef: batch.batchRef,
    entries: batch.entries.map(entry => ({ ref: entry.ref, accessToken: entry.accessToken,
      triggeredAtMs: entry.triggeredAtMs, queueUntilMs: entry.queueUntilMs, deadlineMs: entry.deadlineMs })) })), options.body);
  return batch;
}

async function fixture(t, { providerOptions = {}, serviceOptions = {} } = {}) {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'batchtestclient1234' });
  const now = () => Date.now();
  const state = { envelopes: [], onlineStarts: 0, machineStatus: 200, items: new Map(), cutoff: 0,
    handler: null, transportError: null, seenNonces: new Set() };
  const fetcher = async (url, options) => {
    assert.equal(url, IDENTITY_BATCH_ENDPOINT, 'the integration has no other network path');
    const batch = verifyEnvelope(options, now(), state.seenNonces);
    state.envelopes.push({ batch, signal: options.signal });
    if (state.transportError) throw state.transportError;
    if (state.machineStatus !== 200) return new Response('{}', { status: state.machineStatus });
    const entries = [];
    for (const item of batch.entries) {
      state.onlineStarts++;
      const { payload } = await jwtVerify(item.accessToken, jwks,
        { issuer: settings.issuer, algorithms: ['RS256'], currentDate: new Date(now()) });
      const status = state.items.get(payload.sub) ?? 200;
      entries.push(status === 200 ? { ref: item.ref, status, policy: { version: 1, revokedBefore: state.cutoff,
        issuer: payload.iss, sub: payload.sub, clientId: payload.client_id, authTime: payload.auth_time } } : { ref: item.ref, status });
    }
    return state.handler ? state.handler({ batch, entries }) : response(batch, entries);
  };
  const batchClient = new IdentityBatchClient({ enabled: true, keyId: CALLER, privateKey: callerKeys.privateKey, fetcher, now });
  const adapter = new SQLiteAdapter(':memory:', { now });
  const store = new EncryptedStore(adapter, randomBytes(32), now);
  const provider = new CognitoProvider(settings, { policyClient: batchClient, jwks, now,
    fetcher: async () => { assert.fail('Cognito remote requests are not permitted in this fixture'); }, ...providerOptions });
  const sessions = new SessionService(settings, { store, provider, now, ...serviceOptions });
  const events = [];
  sessions.subscribeInvalidation(event => events.push(event));
  const signToken = (claims, key = accessKeys.privateKey, kid = accessJwk.kid) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid }).sign(key);
  const claimsFor = (sub, change = {}) => {
    const issued = Math.floor(now() / 1000);
    return { iss: settings.issuer, sub, client_id: settings.clientId, iat: issued,
      auth_time: issued - 60, exp: issued + 3600, scope: 'openid', token_use: 'access', ...change };
  };
  async function member(sub, { claims: overrides = {}, token, expiresAt } = {}) {
    const claims = claimsFor(sub, overrides), accessToken = token ?? await signToken(claims), id = opaqueId();
    const value = { phase: 'active', issuer: settings.issuer, sub, userKey: identityKey(settings.issuer, sub),
      accessToken, authTime: claims.auth_time, clientId: settings.clientId, csrf: opaqueId(), createdAt: now(),
      expiresAt: expiresAt ?? Math.floor(now() / 1000 + 3600) * 1000,
      idleUntil: now() + settings.idleMs, lastIdentityCheck: now() - 1000 };
    await store.put('sessions', id, value, value.idleUntil);
    return { id, claims, value, request: new Request(`${settings.origin}/api/state`,
      { headers: { cookie: `${settings.cookieName}=${id}` } }) };
  }
  t.after(() => { batchClient.close(); store.close(); });
  return { settings, now, state, batchClient, adapter, store, provider, sessions, events, signToken, claimsFor, member };
}

test('real signed JWTs and SQLite sessions share a batch but keep independent fresh refs and hidden token/version fields', async t => {
  const f = await fixture(t), member = await f.member('same-member');
  const before = await f.store.read('sessions', member.id);
  const sessions = await Promise.all([f.sessions.authorize(member.request, { touch: false, fresh: false }),
    f.sessions.authorize(member.request, { touch: false, fresh: false })]);
  assert.equal(f.state.envelopes.length, 1); assert.equal(f.state.envelopes[0].batch.entries.length, 2);
  assert.equal(f.state.onlineStarts, 2, 'two logical refs do not become one provider work unit');
  const firstRefs = f.state.envelopes[0].batch.entries.map(entry => entry.ref);
  assert.notEqual(firstRefs[0], firstRefs[1]);
  assert.ok(sessions.every(value => value.userKey === member.value.userKey));
  for (const session of sessions) {
    assert.equal(session.authorizationVersion, before.version);
    assert.equal(JSON.stringify(session).includes('authorizationVersion'), false);
    assert.equal(JSON.stringify(session).includes(member.value.accessToken), false);
  }
  const next = await f.sessions.authorize(member.request, { touch: false, fresh: false });
  assert.equal(next.userKey, member.value.userKey); assert.equal(f.state.envelopes.length, 2);
  assert.equal(f.state.onlineStarts, 3); assert.ok(!firstRefs.includes(f.state.envelopes[1].batch.entries[0].ref));
  assert.equal((await f.store.read('sessions', member.id)).version, before.version);
  const rows = f.adapter.db.prepare('SELECT payload FROM game_records').all();
  assert.ok(rows.every(row => !row.payload.includes(member.value.accessToken) && !row.payload.includes('same-member')));
  const checked = await f.provider.verifyAccess(member.value.accessToken);
  assert.equal(checked.expiresAt, member.claims.exp * 1000, 'Cognito JWT seconds convert explicitly to snapshot milliseconds');
});

test('invalid RS256 JWTs never reach the batch endpoint, including expiry, key, issuer, client, purpose and identity mismatch', async t => {
  const f = await fixture(t), good = await f.member('good-member');
  const base = f.claimsFor(good.value.sub), expected = { ...good.value };
  for (const change of [{ exp: Math.floor(f.now() / 1000) - 1 }, { iss: 'https://other.example' },
    { client_id: 'foreignclient1234' }, { token_use: 'id' }, { scope: 'profile' }, { sub: 'wrong-member' },
    { auth_time: base.iat + 1 }]) {
    await assert.rejects(f.provider.check({ ...expected, accessToken: await f.signToken({ ...base, ...change }) }), failed(401));
  }
  const foreign = await generateKeyPair('RS256');
  await assert.rejects(f.provider.check({ ...expected, accessToken: await f.signToken(base, foreign.privateKey) }), failed(401));
  await assert.rejects(f.provider.check({ ...expected, accessToken: await f.signToken(base, accessKeys.privateKey, 'unknown-key') }), failed(401));
  assert.equal(f.state.envelopes.length, 0); assert.equal(f.state.onlineStarts, 0);
  assert.ok(await f.store.read('sessions', good.id));
});

test('machine 401/403 and upstream 503 preserve encrypted sessions, business rows and stable seat identity', async t => {
  const f = await fixture(t), member = await f.member('kept-member');
  await f.store.put('rooms', 'kept-room', { seat: 'stable-seat', userKey: member.value.userKey, hand: ['kept-card'] });
  const before = await f.store.read('sessions', member.id), room = await f.store.read('rooms', 'kept-room');
  for (const status of [401, 403, 503]) {
    f.state.machineStatus = status;
    await assert.rejects(f.sessions.authorize(member.request, { touch: false }), failed(503));
    assert.equal((await f.store.read('sessions', member.id)).version, before.version);
    assert.equal((await f.store.read('rooms', 'kept-room')).version, room.version);
    assert.equal(f.events.at(-1).status, 503); assert.equal(f.events.at(-1).sessionId, member.id);
  }
  assert.equal(f.state.onlineStarts, 0, 'simulated machine rejection precedes online token work');
  f.state.machineStatus = 200;
  assert.equal((await f.sessions.authorize(member.request, { touch: false })).userKey, member.value.userKey);
  assert.equal(f.state.envelopes.length, 4, 'the client does not automatically retry failed envelopes');
});

test('valid per-item 401 removes only the checked session version and leaves another member and the game intact', async t => {
  const f = await fixture(t), first = await f.member('revoked-member'), second = await f.member('live-member');
  await f.store.put('rooms', 'two-seats', { seats: [first.value.userKey, second.value.userKey], hands: [['a'], ['b']] });
  const roomBefore = await f.store.read('rooms', 'two-seats'), secondBefore = await f.store.read('sessions', second.id);
  f.state.items.set(first.value.sub, 401);
  const denied = f.sessions.authorize(first.request, { touch: false }); const deniedCheck = assert.rejects(denied, failed(401));
  const permitted = f.sessions.authorize(second.request, { touch: false });
  await deniedCheck; const session = await permitted;
  assert.equal(session.userKey, second.value.userKey);
  assert.equal(await f.store.read('sessions', first.id), null);
  assert.equal((await f.store.read('sessions', second.id)).version, secondBefore.version);
  assert.equal((await f.store.read('rooms', 'two-seats')).version, roomBefore.version);
  assert.deepEqual(f.events.filter(event => event.status === 401).map(event => event.sessionId), [first.id]);
});

test('a valid per-item 503 preserves its own session while another receiver is authorized independently', async t => {
  const f = await fixture(t), paused = await f.member('paused-member'), live = await f.member('running-member');
  const before = await f.store.read('sessions', paused.id); f.state.items.set(paused.value.sub, 503);
  const unavailable = assert.rejects(f.sessions.authorize(paused.request, { touch: false }), failed(503));
  const permitted = f.sessions.authorize(live.request, { touch: false });
  await unavailable; assert.equal((await permitted).userKey, live.value.userKey);
  assert.equal((await f.store.read('sessions', paused.id)).version, before.version);
  assert.equal(f.events.filter(event => event.status === 401).length, 0);
});

test('a delayed old per-item 401 cannot delete a newly authenticated session saved through the same stable identity', async t => {
  const f = await fixture(t), member = await f.member('renewed-member'), entered = deferred(), release = deferred();
  const old = await f.store.read('sessions', member.id), newerClaims = { ...member.claims, auth_time: member.claims.auth_time + 1 };
  const newerToken = await f.signToken(newerClaims);
  await f.store.put('rooms', 'stable-game', { seat: 'same-seat', userKey: member.value.userKey, canvasSequence: 17 });
  const roomBefore = await f.store.read('rooms', 'stable-game');
  f.state.handler = async ({ batch, entries }) => {
    if (f.state.envelopes.length !== 1) return response(batch, entries);
    entered.resolve(); await release.promise;
    return response(batch, entries.map(entry => ({ ref: entry.ref, status: 401 })));
  };
  const pending = f.sessions.authorize(member.request, { touch: false }); await entered.promise;
  const renewed = { ...old.value, accessToken: newerToken, authTime: newerClaims.auth_time, csrf: opaqueId() };
  assert.equal(await f.store.replaceCAS('sessions', member.id, old.version, renewed, old.expiresAt), true);
  const renewedVersion = (await f.store.read('sessions', member.id)).version;
  release.resolve(); const session = await pending;
  assert.equal(session.userKey, member.value.userKey); assert.equal(session.csrf, renewed.csrf);
  assert.equal(session.authorizationVersion, renewedVersion);
  assert.equal((await f.store.get('sessions', member.id)).accessToken, newerToken);
  assert.equal((await f.store.read('rooms', 'stable-game')).version, roomBefore.version);
  assert.equal(f.events.filter(event => event.status === 401).length, 0);
  assert.equal(f.state.envelopes.length, 2, 'SessionService reacquires fresh policy for the new session version');
  assert.notEqual(f.state.envelopes[0].batch.entries[0].ref, f.state.envelopes[1].batch.entries[0].ref);
});

test('a session CAS during a successful policy response requires a new fresh JWT/batch gate before returning', async t => {
  const f = await fixture(t), member = await f.member('changed-session'), entered = deferred(), release = deferred();
  const before = await f.store.read('sessions', member.id);
  f.state.handler = async ({ batch, entries }) => {
    if (f.state.envelopes.length === 1) { entered.resolve(); await release.promise; }
    return response(batch, entries);
  };
  const pending = f.sessions.authorize(member.request, { touch: false }); await entered.promise;
  const replacement = { ...before.value, csrf: opaqueId() };
  assert.equal(await f.store.replaceCAS('sessions', member.id, before.version, replacement, before.expiresAt), true);
  release.resolve(); const session = await pending;
  assert.equal(session.csrf, replacement.csrf);
  assert.equal(f.state.envelopes.length, 2); assert.equal(f.state.onlineStarts, 2);
  await f.sessions.assertCurrent(session);
});

test('member/room guards are checked atomically after genuine authorization and cannot grant a removed seat', async t => {
  const f = await fixture(t), member = await f.member('guarded-member');
  const context = createIdentityCheckContext(); t.after(() => context.dispose());
  await f.store.put('room-members', 'seat', { userKey: member.value.userKey, seated: true });
  const guard = await f.store.read('room-members', 'seat');
  const session = await f.sessions.authorize(member.request, { touch: false, context });
  const read = f.store.read.bind(f.store); let changed = false;
  f.store.read = async (...args) => {
    const record = await read(...args);
    if (!changed && args[0] === 'sessions') {
      changed = true;
      assert.equal(await f.store.replaceCAS('room-members', 'seat', guard.version,
        { userKey: member.value.userKey, seated: false }), true);
    }
    return record;
  };
  await assert.rejects(f.sessions.assertCurrent(session, { context,
    guards: [{ scope: 'room-members', id: 'seat', expectedVersion: guard.version }] }), failed(503));
  assert.ok(await f.store.read('sessions', member.id));
  assert.equal((await f.store.get('room-members', 'seat')).seated, false);
  assert.equal(f.state.envelopes.length, 1);
});

test('reordered batch responses cannot lend another identity policy or private session to the wrong member', async t => {
  const f = await fixture(t), first = await f.member('first-member'), second = await f.member('second-member');
  f.state.handler = async ({ batch, entries }) => response(batch, entries.map(entry =>
    entry.policy.sub === first.value.sub ? { ...entry, policy: { ...entry.policy, sub: second.value.sub } } : entry).toReversed());
  const denied = assert.rejects(f.sessions.authorize(first.request, { touch: false }), failed(401));
  const permitted = f.sessions.authorize(second.request, { touch: false });
  await denied; assert.equal((await permitted).userKey, second.value.userKey);
  assert.equal(await f.store.get('sessions', first.id), null); assert.ok(await f.store.get('sessions', second.id));
  assert.equal(f.events.filter(event => event.status === 401).length, 1);
});

test('late real JWKS acquisition is fenced by the original short provider budget and never starts a batch', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { providerOptions: { checkTimeoutMs: 80, jwks: async (...args) => {
    entered.resolve(); await release.promise; return jwks(...args);
  } } });
  const member = await f.member('late-jwks-member'), before = await f.store.read('sessions', member.id);
  const pending = f.sessions.authorize(member.request, { touch: false }); const rejected = assert.rejects(pending, failed(503));
  await entered.promise; await rejected;
  assert.equal(f.state.envelopes.length, 0); assert.equal((await f.store.read('sessions', member.id)).version, before.version);
  release.resolve(); await nextTurn(); await nextTurn();
  assert.equal(f.state.envelopes.length, 0); assert.equal(f.batchClient.occupancy.residentBytes, 0);
});

test('session deadline during an unknown batch response preserves game data and transport ownership until actual settlement', async t => {
  const f = await fixture(t, { serviceOptions: { authorizationTimeoutMs: 200 } });
  const member = await f.member('unknown-response-member'), entered = deferred(), release = deferred();
  await f.store.put('rooms', 'unknown-game', { userKey: member.value.userKey, canvasSequence: 21 });
  const before = await f.store.read('sessions', member.id), roomBefore = await f.store.read('rooms', 'unknown-game');
  f.state.handler = async ({ batch, entries }) => { entered.resolve(); await release.promise; return response(batch, entries); };
  const pending = f.sessions.authorize(member.request, { touch: false }); const rejected = assert.rejects(pending, failed(503));
  await entered.promise; await rejected;
  assert.equal(f.batchClient.occupancy.activeTransports, 1); assert.equal(f.batchClient.occupancy.tombstones, 1);
  assert.equal(f.state.envelopes[0].signal.aborted, true);
  assert.equal((await f.store.read('sessions', member.id)).version, before.version);
  assert.equal((await f.store.read('rooms', 'unknown-game')).version, roomBefore.version);
  release.resolve(); await settled(() => f.batchClient.occupancy.activeTransports === 0);
  assert.equal(f.batchClient.occupancy.residentBytes, 0);
  assert.equal((await f.store.read('sessions', member.id)).version, before.version);
  assert.equal(f.state.envelopes.length, 1, 'a timed-out batch is not replayed');
});
