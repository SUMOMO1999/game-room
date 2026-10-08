import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { IdentityFailure } from '../server/auth.mjs';
import { SHARED_ISSUER } from '../server/config.mjs';
import { createIdentityCheckContext } from '../server/identity-check-context.mjs';
import { IdentityBatchClient } from '../server/identity-batch-client.mjs';
import { IDENTITY_BATCH_ENDPOINT, identityBatchRef, encodeIdentityBatch, decodeIdentityBatchResponse,
  signIdentityBatch, readIdentityBatchBody } from '../server/identity-batch-wire.mjs';

const BASE = 1790000000000;
const keys = generateKeyPairSync('ed25519');
const identity = (extra = {}) => ({ issuer: SHARED_ISSUER, sub: 'fictional-player',
  clientId: '27oe1fs5shskll808e733lqm65', authTime: BASE / 1000 - 20,
  expiresAt: BASE + 3600000, accessToken: 'fictional-access-token', ...extra });
const policy = (expected = identity(), extra = {}) => ({ version: 1, revokedBefore: 0,
  issuer: expected.issuer, sub: expected.sub, clientId: expected.clientId, authTime: expected.authTime, ...extra });
const failed = status => error => error instanceof IdentityFailure && error.status === status
  && !error.message.includes('fictional');
const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let wall = BASE, monotonic = 0, sequence = 0;
  const timers = new Map();
  const scheduler = {
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { at: monotonic + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  function advance(ms) {
    const until = monotonic + ms;
    for (;;) {
      const next = [...timers].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      wall += next[1].at - monotonic; monotonic = next[1].at;
      timers.delete(next[0]); next[1].callback();
    }
    wall += until - monotonic; monotonic = until;
  }
  return { now: () => wall, monotonicNow: () => monotonic, scheduler, advance,
    moveWall: ms => { wall += ms; }, count: () => timers.size };
}
function responseFor(options, expected = () => identity(), change = value => value) {
  const request = JSON.parse(options.body.toString('utf8'));
  return Response.json(change({ version: 1, batchRef: request.batchRef,
    entries: request.entries.map(entry => ({ ref: entry.ref, status: 200, policy: policy(expected(entry)) })) }));
}
function fixture(fetcher, extra = {}) {
  const time = clock(), calls = [];
  const client = new IdentityBatchClient({ enabled: true, keyId: 'game-test-v1', privateKey: keys.privateKey,
    fetcher: (url, options) => { calls.push({ url, options }); return fetcher(url, options); },
    now: time.now, monotonicNow: time.monotonicNow, scheduler: time.scheduler, ...extra });
  const context = options => createIdentityCheckContext({ now: time.now, monotonicNow: time.monotonicNow,
    scheduler: time.scheduler, ...options });
  return { client, calls, time, context };
}

test('batch is opt-in and requires an explicit Ed25519 caller and fixed endpoint', async () => {
  await assert.rejects(new IdentityBatchClient().check(identity()), failed(503));
  for (const options of [{ enabled: true }, { enabled: true, fetcher: fetch, keyId: 'bad key' },
    { enabled: true, fetcher: fetch, keyId: 'test', privateKey: keys.publicKey },
    { endpoint: `${IDENTITY_BATCH_ENDPOINT}?other=true` }, { endpoint: 'https://example.com/' },
    { limits: { transports: 5 } }, { limits: { queuedEntries: 0 } }, { limits: { unknown: 1 } }]) {
    assert.throws(() => new IdentityBatchClient(options), TypeError);
  }
  const { client } = fixture(async () => { throw new Error('unused'); });
  assert.equal(client.usesBatchIdentity, true);
  assert.throws(() => { client.enabled = false; }, TypeError);
});

test('adapter-1 key identifiers use lower ASCII letter first and at most sixty-four bytes', () => {
  for (const keyId of ['a', 'caller.v1-key_2', `a${'z'.repeat(63)}`]) {
    const { client } = fixture(async () => { throw new Error('unused'); }, { keyId });
    assert.equal(client.keyId, keyId); client.close();
  }
  for (const keyId of ['A', '1caller', '-caller', 'é', 'a/b', 'a b', `a${'z'.repeat(64)}`]) {
    assert.throws(() => fixture(async () => { throw new Error('unused'); }, { keyId }), TypeError);
    assert.throws(() => signIdentityBatch({ body: Buffer.from('{}'), batchRef: identityBatchRef(), keyId,
      privateKey: keys.privateKey, created: BASE / 1000, expires: BASE / 1000 + 8 }));
  }
});

test('one drawer fanout of sixteen independently bound receivers sends one signed envelope without waiting for its maximum window', async () => {
  const expected = new Map(Array.from({ length: 16 }, (_, index) => {
    const who = identity({ sub: `receiver-${index}`, accessToken: `token-${index}` }); return [who.accessToken, who];
  }));
  const { client, calls, time } = fixture(async (_url, options) => responseFor(options, entry => expected.get(entry.accessToken)));
  const checks = [...expected.values()].map(who => client.check(who));
  const results = Promise.all(checks);
  assert.equal(calls.length, 1); const policies = await results;
  time.advance(20);
  assert.equal(calls.length, 1); assert.equal(policies.length, 16);
  assert.equal(new Set(policies.map(value => value.sub)).size, 16);
  const { url, options } = calls[0], request = JSON.parse(options.body);
  assert.equal(url, IDENTITY_BATCH_ENDPOINT); assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
  assert.equal(options.headers.Accept, 'application/json'); assert.equal(options.headers['Accept-Encoding'], 'identity');
  assert.equal(request.entries.length, 16); assert.equal(new Set(request.entries.map(entry => entry.ref)).size, 16);
  assert.ok(request.entries.every(entry => entry.triggeredAtMs === BASE && entry.queueUntilMs === BASE + 4000
    && entry.deadlineMs === BASE + 8000));
  assert.deepEqual(Object.keys(request.entries[0]), ['ref', 'accessToken', 'triggeredAtMs', 'queueUntilMs', 'deadlineMs']);
  assert.ok(!Object.keys(options.headers).some(name => ['authorization', 'cookie', 'origin', 'content-encoding'].includes(name.toLowerCase())));
  const signatureInput = options.headers['Signature-Input'], parameters = signatureInput.slice('agora='.length);
  assert.ok(parameters.includes(`nonce="${request.batchRef}"`));
  assert.equal(options.headers['Content-Digest'], `sha-256=:${createHash('sha256').update(options.body).digest('base64')}:`);
  const base = ['"@method": POST', '"@scheme": https', '"@authority": agora.sumomoli.com',
    '"@path": /api/identity/batch', `"content-digest": ${options.headers['Content-Digest']}`,
    '"content-type": application/json', '"x-agora-audience": agora.identity.batch.v1',
    `"@signature-params": ${parameters}`].join('\n');
  const signature = Buffer.from(options.headers.Signature.slice('agora=:'.length, -1), 'base64');
  assert.equal(verify(null, Buffer.from(base), keys.publicKey, signature), true);
  assert.equal(verify(null, Buffer.from(`${base}changed`), keys.publicKey, signature), false);
  assert.equal(client.occupancy.residentBytes, 0); assert.equal(time.count(), 0);
});

test('identical unfinished snapshots keep independent refs and weight; completed success is never reused', async () => {
  const pending = deferred();
  const { client, calls, time } = fixture((_url, options) => calls.length === 1 ? pending.promise : Promise.resolve(responseFor(options)));
  const first = client.check(identity()), second = client.check(identity());
  assert.notEqual(first, second); const result = Promise.all([first, second]);
  time.advance(20); assert.equal(calls.length, 1);
  const entries = JSON.parse(calls[0].options.body).entries;
  assert.equal(entries.length, 2); assert.notEqual(entries[0].ref, entries[1].ref);
  pending.resolve(responseFor(calls[0].options)); await result;
  const third = client.check(identity()); time.advance(20); await third;
  assert.equal(calls.length, 2); assert.equal(JSON.parse(calls[1].options.body).entries.length, 1);
});

test('caller mutation after enqueue cannot change a wire token or policy binding', async () => {
  const expected = identity(), mutable = { ...expected };
  const { client, time, calls } = fixture(async (_url, options) => responseFor(options, () => expected));
  const pending = client.check(mutable);
  mutable.sub = 'changed-player'; mutable.accessToken = 'changed-token'; mutable.authTime++;
  time.advance(20); assert.deepEqual(await pending, policy(expected));
  assert.equal(JSON.parse(calls[0].options.body).entries[0].accessToken, expected.accessToken);
});

test('verified identity and JWT expiry input is in milliseconds and invalid snapshots do no upstream work', async () => {
  const { client, calls } = fixture(async () => { throw new Error('never called'); });
  for (const who of [null, {}, identity({ issuer: 'https://foreign.example' }), identity({ sub: '' }),
    identity({ sub: 'a\nother' }), identity({ clientId: 'bad!' }), identity({ authTime: BASE / 1000 + 1 }),
    identity({ authTime: -1 }), identity({ expiresAt: BASE / 1000 + 3600 }), identity({ expiresAt: BASE }),
    identity({ expiresAt: undefined }), identity({ accessToken: '' }), identity({ accessToken: 'a'.repeat(8193) }),
    identity({ accessToken: 'token header' })]) await assert.rejects(client.check(who), failed(401));
  assert.equal(calls.length, 0);
});

test('original context timestamps and shorter expiry survive collection without restarting the budget', async () => {
  const { client, calls, time, context } = fixture(async (_url, options) => responseFor(options));
  const original = context({ timeoutMs: 1000, queueMs: 700 });
  time.advance(300);
  const pending = client.check(identity({ expiresAt: BASE + 800 }), { context: original });
  time.advance(20); await pending;
  assert.deepEqual(JSON.parse(calls[0].options.body).entries[0], {
    ref: JSON.parse(calls[0].options.body).entries[0].ref, accessToken: 'fictional-access-token',
    triggeredAtMs: BASE, queueUntilMs: BASE + 700, deadlineMs: BASE + 800,
  });
  assert.equal(original.isLive(), true); original.dispose(); assert.equal(time.count(), 0);
});

test('restricting context during collection signs the shorter original deadline without mistaking it for JWT ageing', async () => {
  const { client, calls, time, context } = fixture(async (_url, options) => responseFor(options));
  const original = context();
  const pending = client.check(identity({ expiresAt: BASE + 4000 }), { context: original });
  time.advance(4); original.restrict(500); time.advance(1);
  assert.deepEqual(await pending, policy());
  const wire = JSON.parse(calls[0].options.body).entries[0];
  assert.equal(wire.triggeredAtMs, BASE); assert.equal(wire.queueUntilMs, BASE + 500); assert.equal(wire.deadlineMs, BASE + 500);
  assert.equal(original.isLive(), true); original.dispose(); assert.equal(time.count(), 0);
});

test('restricting an already-sent check rejects at its new bound and keeps unknown transport resources', async () => {
  const upstream = deferred();
  const { client, calls, time, context } = fixture(() => upstream.promise);
  const original = context();
  const pending = client.check(identity({ expiresAt: BASE + 4000 }), { context: original });
  const rejected = assert.rejects(pending, failed(503));
  time.advance(20); const occupied = client.occupancy.residentBytes;
  time.advance(80); original.restrict(500); time.advance(400); await rejected;
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(client.occupancy.activeTransports, 1); assert.equal(client.occupancy.residentBytes, occupied);
  upstream.resolve(responseFor(calls[0].options)); await flush();
  assert.equal(client.occupancy.residentBytes, 0); original.dispose(); assert.equal(time.count(), 0);
});

test('a shorter bound in one receiver preserves the surviving receiver and original ref set', async () => {
  const upstream = deferred();
  const { client, calls, time, context } = fixture(() => upstream.promise);
  const shorter = context(), survivorContext = context();
  const cancelled = client.check(identity({ expiresAt: BASE + 3000 }), { context: shorter });
  const rejected = assert.rejects(cancelled, failed(503));
  const survivor = client.check(identity(), { context: survivorContext });
  time.advance(20); shorter.restrict(100); time.advance(80); await rejected;
  assert.equal(calls[0].options.signal.aborted, false); assert.equal(client.occupancy.tombstones, 1);
  upstream.resolve(responseFor(calls[0].options)); assert.deepEqual(await survivor, policy());
  shorter.dispose(); survivorContext.dispose(); assert.equal(time.count(), 0);
});

test('a restricted queued check expires at the context deadline even behind unknown transport work', async () => {
  const upstream = deferred();
  const { client, calls, time, context } = fixture(() => upstream.promise, { limits: { transports: 1 } });
  const blocking = client.check(identity()); const blockingRejected = assert.rejects(blocking, failed(503));
  time.advance(20);
  const queuedContext = context(), queued = client.check(identity({ accessToken: 'queued-token' }), { context: queuedContext });
  const queuedRejected = assert.rejects(queued, failed(503));
  queuedContext.restrict(100); time.advance(100); await queuedRejected;
  assert.equal(calls.length, 1); assert.equal(client.occupancy.queuedEntries, 0);
  client.close(); await blockingRejected;
  upstream.resolve(responseFor(calls[0].options)); await flush(); queuedContext.dispose();
  assert.equal(client.occupancy.residentBytes, 0); assert.equal(time.count(), 0);
});

test('one receiver failing the pre-send fence cannot log out another receiver in its envelope', async () => {
  const { client, calls, time, context } = fixture(async (_url, options) => responseFor(options));
  const original = context(); let assertions = 0;
  const failingFence = Object.freeze({ ...original, assert() {
    if (++assertions === 3) throw new IdentityFailure(401);
    original.assert();
  } });
  const denied = client.check(identity(), { context: failingFence }); const rejected = assert.rejects(denied, failed(401));
  const survivor = client.check(identity()); time.advance(20);
  await rejected; assert.deepEqual(await survivor, policy()); assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).entries.length, 2);
  assert.equal(client.occupancy.residentBytes, 0); original.dispose(); assert.equal(time.count(), 0);
});

test('unknown fetch retains all workers, bytes and tombstones after every caller deadline', async () => {
  const upstream = deferred();
  const { client, calls, time } = fixture(() => upstream.promise, { limits: { transports: 1 } });
  const pending = client.check(identity()); const rejection = assert.rejects(pending, failed(503));
  time.advance(20); const occupied = client.occupancy.residentBytes;
  time.advance(7980); await rejection;
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(client.occupancy.activeTransports, 1); assert.equal(client.occupancy.tombstones, 1);
  assert.equal(client.occupancy.residentBytes, occupied);
  const next = client.check(identity({ sub: 'next', accessToken: 'next-token' }));
  const queueRejection = assert.rejects(next, failed(503));
  time.advance(4000); await queueRejection; assert.equal(calls.length, 1);
  upstream.resolve(responseFor(calls[0].options)); await flush();
  assert.equal(client.occupancy.activeTransports, 0); assert.equal(client.occupancy.residentBytes, 0);
});

test('an unsettled exact-token check blocks its replacement while other identities can continue', async () => {
  const upstream = deferred();
  const { client, calls, time } = fixture((_url, options) => calls.length === 1 ? upstream.promise : Promise.resolve(responseFor(options)),
    { limits: { transports: 2 } });
  const first = client.check(identity()); const firstRejected = assert.rejects(first, failed(503));
  time.advance(8000); await firstRejected;
  const replacement = client.check(identity()); const replacementRejected = assert.rejects(replacement, failed(503));
  const other = identity({ sub: 'other-player', accessToken: 'other-token' });
  // The response intentionally mismatches the other identity. That still proves
  // it got a transport without borrowing or restarting the unknown old work.
  const independent = client.check(other); const independentRejected = assert.rejects(independent, failed(401));
  time.advance(20); await independentRejected; assert.equal(calls.length, 2);
  time.advance(3980); await replacementRejected; assert.equal(calls.length, 2);
  upstream.resolve(responseFor(calls[0].options)); await flush(); assert.equal(client.occupancy.residentBytes, 0);
});

test('one cancelled receiver is independent, keeps its ref tombstone and cannot receive a late success', async () => {
  const upstream = deferred(), controller = new AbortController();
  const { client, calls, time } = fixture(() => upstream.promise);
  const cancelled = client.check(identity(), { signal: controller.signal });
  const rejected = assert.rejects(cancelled, failed(503));
  const survivor = client.check(identity()); time.advance(20);
  controller.abort(); await rejected;
  assert.equal(calls[0].options.signal.aborted, false); assert.equal(client.occupancy.tombstones, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  upstream.resolve(responseFor(calls[0].options)); assert.deepEqual(await survivor, policy());
  assert.equal(client.occupancy.logicalWaiters, 0); assert.equal(client.occupancy.tombstones, 0);
});

test('an external cancellation before collection releases only that queued check and removes its listeners', async () => {
  const controller = new AbortController();
  const { client, calls, time, context } = fixture(async (_url, options) => responseFor(options));
  const original = context();
  const cancelled = client.check(identity(), { context: original, signal: controller.signal });
  const rejected = assert.rejects(cancelled, failed(503));
  const survivor = client.check(identity()); controller.abort(); await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(original.isLive(), true); time.advance(20); await survivor;
  assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].options.body).entries.length, 1);
  original.dispose(); assert.equal(time.count(), 0);
});

test('a response that omits a cancelled ref rejects every remaining receiver', async () => {
  const upstream = deferred(), controller = new AbortController();
  const { client, calls, time } = fixture(() => upstream.promise);
  const cancelled = client.check(identity(), { signal: controller.signal }); const cancelledRejection = assert.rejects(cancelled, failed(503));
  const survivor = client.check(identity()); const survivorRejection = assert.rejects(survivor, failed(503));
  time.advance(20); controller.abort(); await cancelledRejection;
  upstream.resolve(responseFor(calls[0].options, undefined, value => ({ ...value, entries: value.entries.slice(1) })));
  await survivorRejection; assert.equal(client.occupancy.residentBytes, 0);
});

test('machine HTTP errors including 401 and 403 are unavailable and never user logout or retried', async () => {
  for (const status of [204, 301, 302, 400, 401, 403, 409, 413, 429, 500, 503]) {
    const { client, calls, time } = fixture(async () => new Response(null, { status }));
    const pending = client.check(identity()); const rejected = assert.rejects(pending, failed(503));
    time.advance(20); await rejected; time.advance(8000);
    assert.equal(calls.length, 1); assert.equal(client.occupancy.residentBytes, 0);
  }
});

test('valid per-item 401 affects only its receiver while per-item 503 pauses only its receiver', async () => {
  const statuses = [200, 401, 503];
  const { client, time } = fixture(async (_url, options) => responseFor(options, undefined, value => ({ ...value,
    entries: value.entries.map((entry, index) => statuses[index] === 200 ? entry : { ref: entry.ref, status: statuses[index] }),
  })));
  const successful = client.check(identity()), denied = client.check(identity()), paused = client.check(identity());
  const deniedRejected = assert.rejects(denied, failed(401)), pausedRejected = assert.rejects(paused, failed(503));
  time.advance(20); assert.deepEqual(await successful, policy()); await deniedRejected; await pausedRejected;
});

test('legacy authTime zero and no cutoff remain valid; positive cutoffs reject that old identity', async () => {
  const who = identity({ authTime: 0 });
  const permitted = fixture(async (_url, options) => responseFor(options, () => who));
  const pending = permitted.client.check(who); permitted.time.advance(20);
  assert.equal((await pending).authTime, 0);
  const denied = fixture(async (_url, options) => responseFor(options, () => who,
    value => ({ ...value, entries: value.entries.map(entry => ({ ...entry, policy: { ...entry.policy, revokedBefore: 1 } })) })));
  const rejected = assert.rejects(denied.client.check(who), failed(401)); denied.time.advance(20); await rejected;
});

test('all response structure is validated before even the first valid item is released', async () => {
  const mutations = [
    value => ({ ...value, entries: value.entries.slice(0, 1) }),
    value => ({ ...value, entries: [value.entries[0], value.entries[0]] }),
    value => ({ ...value, entries: [value.entries[0], { ...value.entries[1], ref: identityBatchRef() }] }),
    value => ({ ...value, batchRef: identityBatchRef() }),
    value => ({ ...value, entries: [value.entries[0], { ...value.entries[1], status: 202 }] }),
    value => ({ ...value, entries: [value.entries[0], { ...value.entries[1], extra: 'unexpected' }] }),
    value => ({ ...value, entries: [value.entries[0], { ...value.entries[1], policy: { ...policy(), version: 2 } }] }),
    value => ({ ...value, entries: [value.entries[0], { ...value.entries[1], policy: { ...policy(), accessToken: 'secret' } }] }),
  ];
  for (const mutation of mutations) {
    const { client, time } = fixture(async (_url, options) => responseFor(options, undefined, mutation));
    let successful = 0;
    const checks = [client.check(identity()), client.check(identity())].map(promise => promise.then(() => { successful++; }, error => {
      assert.ok(failed(503)(error));
    }));
    time.advance(20); await Promise.all(checks); assert.equal(successful, 0);
  }
});

test('valid policies bind exact issuer, subject, client, authTime and cutoff; response order is irrelevant', async () => {
  for (const change of [{ issuer: 'https://other.example' }, { sub: 'other' }, { clientId: 'otherclient123' },
    { authTime: identity().authTime + 1 }, { revokedBefore: identity().authTime }]) {
    const { client, time } = fixture(async (_url, options) => responseFor(options, undefined, value => ({ ...value,
      entries: value.entries.map(entry => ({ ...entry, policy: { ...entry.policy, ...change } })),
    })));
    const pending = client.check(identity()); const rejected = assert.rejects(pending, failed(401));
    time.advance(20); await rejected;
  }
  const second = identity({ sub: 'second', accessToken: 'second-token' });
  const { client, time } = fixture(async (_url, options) => responseFor(options,
    entry => entry.accessToken === second.accessToken ? second : identity(), value => ({ ...value, entries: value.entries.toReversed() })));
  const first = client.check(identity()), next = client.check(second); time.advance(20);
  assert.equal((await first).sub, identity().sub); assert.equal((await next).sub, second.sub);
});

test('no token leaks from upstream errors and redirects are refused', async () => {
  for (const fetcher of [async () => { throw new Error('fictional-access-token'); }, async (_url, options) => {
    const response = responseFor(options); Object.defineProperty(response, 'redirected', { value: true }); return response;
  }]) {
    const { client, time } = fixture(fetcher);
    const pending = client.check(identity()); const rejected = assert.rejects(pending, failed(503));
    time.advance(20); await rejected;
  }
});

test('queued limits and conservative byte reservations reject overload before transport', async () => {
  const { client, time, calls } = fixture(async (_url, options) => responseFor(options), { limits: { queuedEntries: 2, logicalWaiters: 2 } });
  const first = client.check(identity()), second = client.check(identity());
  await assert.rejects(client.check(identity()), failed(503)); time.advance(20); await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  const small = fixture(async (_url, options) => responseFor(options), { limits: { residentBytes: 4096 } });
  await assert.rejects(small.client.check(identity()), failed(503)); assert.equal(small.calls.length, 0);
  const envelopeBudget = fixture(async (_url, options) => responseFor(options), { limits: { residentBytes: 10000 } });
  const rejected = assert.rejects(envelopeBudget.client.check(identity()), failed(503));
  envelopeBudget.time.advance(20); await rejected; assert.equal(envelopeBudget.calls.length, 0);
  assert.equal(envelopeBudget.client.occupancy.residentBytes, 0);
});

test('more than sixteen checks split into bounded envelopes without increasing transport concurrency', async () => {
  const replies = [];
  const { client, calls, time } = fixture((_url, options) => {
    const reply = deferred(); replies.push({ ...reply, options }); return reply.promise;
  }, { limits: { transports: 1 } });
  const checks = Array.from({ length: 33 }, (_, index) => client.check(identity({ accessToken: `token-${index}` })));
  const all = Promise.all(checks); time.advance(20);
  assert.equal(calls.length, 1); assert.equal(client.occupancy.activeTransports, 1);
  replies[0].resolve(responseFor(replies[0].options)); await flush();
  assert.equal(calls.length, 2); assert.equal(client.occupancy.activeTransports, 1);
  replies[1].resolve(responseFor(replies[1].options)); await flush();
  assert.equal(calls.length, 3); replies[2].resolve(responseFor(replies[2].options)); await all;
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body).entries.length), [16, 16, 1]);
  assert.equal(client.occupancy.activeTransports, 0); assert.equal(time.count(), 0);
});

test('JWT expires during transport and cannot be extended by moving the wall clock backward', async () => {
  const upstream = deferred();
  const { client, calls, time } = fixture(() => upstream.promise);
  const pending = client.check(identity({ expiresAt: BASE + 100 })); const rejected = assert.rejects(pending, failed(401));
  time.advance(20); time.moveWall(-60000); time.advance(80); await rejected;
  assert.equal(client.occupancy.activeTransports, 1);
  upstream.resolve(responseFor(calls[0].options)); await flush(); assert.equal(client.occupancy.residentBytes, 0);
});

test('stalled response reads are cancelled, and unknown cancellation keeps occupancy until actual settlement', async () => {
  const read = deferred(), cancel = deferred(); let cancelled = 0;
  const body = { getReader: () => ({ read: () => read.promise, cancel: () => { cancelled++; return cancel.promise; }, releaseLock() {} }) };
  const response = { status: 200, ok: true, redirected: false,
    headers: new Headers({ 'Content-Type': 'application/json' }), body };
  const { client, time } = fixture(async () => response);
  const pending = client.check(identity()); const rejected = assert.rejects(pending, failed(503));
  time.advance(20); await flush(); time.advance(7980); await rejected; await flush();
  assert.equal(cancelled, 1); assert.equal(client.occupancy.activeTransports, 1);
  read.resolve({ done: true }); await flush(); assert.equal(client.occupancy.activeTransports, 1);
  cancel.resolve(); await flush(); assert.equal(client.occupancy.activeTransports, 0);
});

test('a failed cancellation still releases the reader lock only after the read and cancellation actually settle', async () => {
  const read = deferred(), cancellation = deferred(); let released = 0;
  const response = { status: 200, ok: true, redirected: false, headers: new Headers({ 'Content-Type': 'application/json' }),
    body: { getReader: () => ({ read: () => read.promise, cancel: () => cancellation.promise,
      releaseLock() { released++; } }) } };
  const { client, time } = fixture(async () => response);
  const pending = client.check(identity()); const rejected = assert.rejects(pending, failed(503));
  time.advance(20); await flush(); time.advance(7980); await rejected; await flush();
  assert.equal(released, 0); read.resolve({ done: true }); await flush();
  assert.equal(released, 0); assert.equal(client.occupancy.activeTransports, 1);
  cancellation.reject(new Error('fictional cancellation failure')); await flush();
  assert.equal(released, 1); assert.equal(client.occupancy.activeTransports, 0);
  assert.equal(client.occupancy.residentBytes, 0);
});

test('close cancels callers and refuses new calls but leaves unknown transport accounting intact', async () => {
  const upstream = deferred(); const { client, calls, time } = fixture(() => upstream.promise);
  const pending = client.check(identity()); const rejected = assert.rejects(pending, failed(503));
  time.advance(20); client.close(); client.close(); await rejected;
  await assert.rejects(client.check(identity()), failed(503));
  assert.equal(client.occupancy.activeTransports, 1);
  upstream.resolve(responseFor(calls[0].options)); await flush();
  assert.equal(client.occupancy.residentBytes, 0); assert.equal(time.count(), 0);
});

test('wire rejects duplicate and escaped duplicate keys, deep nesting, UTF-8 faults and extra response fields', () => {
  const batchRef = identityBatchRef(), ref = identityBatchRef(), refs = new Set([ref]);
  const valid = JSON.stringify({ version: 1, batchRef, entries: [{ ref, status: 200, policy: policy() }] });
  assert.equal(decodeIdentityBatchResponse(Buffer.from(valid), batchRef, refs).get(ref).policy.sub, identity().sub);
  for (const text of [valid.replace('"version":1', '"version":1,"version":1'),
    valid.replace('"status":200', '"status":200,"st\\u0061tus":200'),
    valid.replace('"version":1', '"hidden":[[[[[[[0]]]]]]],"version":1'), valid.replace('"version":1', '"extra":0,"version":1')]) {
    assert.throws(() => decodeIdentityBatchResponse(Buffer.from(text), batchRef, refs));
  }
  assert.throws(() => decodeIdentityBatchResponse(Buffer.from([0xff]), batchRef, refs));
  assert.throws(() => decodeIdentityBatchResponse(Buffer.alloc(32769), batchRef, refs));
});

test('bounded streaming response rejects oversized, compressed, non-JSON and misleading content lengths', async () => {
  for (const response of [new Response('a'.repeat(32769), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '32769' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '3' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '-1' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } }),
    new Response('{}', { headers: { 'Content-Type': 'text/html' } })]) await assert.rejects(readIdentityBatchBody(response));
  const body = new ReadableStream({ start(controller) {
    for (const value of Buffer.from('{}')) controller.enqueue(Uint8Array.of(value)); controller.close();
  } });
  assert.equal((await readIdentityBatchBody(new Response(body, { headers: { 'Content-Type': 'application/json' } }))).toString(), '{}');
});

test('empty chunks and excessive shallow response nodes cannot grow unbounded reader or parser overhead', async () => {
  let reads = 0, cancelled = 0;
  const response = { headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: new Uint8Array(0) }; },
    cancel: async () => { cancelled++; }, releaseLock() {},
  }) } };
  await assert.rejects(readIdentityBatchBody(response));
  assert.equal(reads, 32769); assert.equal(cancelled, 1);
  const batchRef = identityBatchRef(), ref = identityBatchRef();
  const text = JSON.stringify({ version: 1, batchRef, entries: Array.from({ length: 300 }, () => ({})) });
  assert.throws(() => decodeIdentityBatchResponse(Buffer.from(text), batchRef, new Set([ref])));
});

test('wire encoding preserves compact fixed key order and refuses oversized tokens and invalid deadline windows', () => {
  const ref = identityBatchRef(), batchRef = identityBatchRef();
  const entry = { ref, accessToken: 'token', triggeredAtMs: BASE, queueUntilMs: BASE + 4000, deadlineMs: BASE + 8000 };
  const body = encodeIdentityBatch({ batchRef, entries: [entry] });
  assert.equal(body.toString(), JSON.stringify({ version: 1, batchRef, entries: [entry] }));
  for (const extra of [{ accessToken: 'a'.repeat(8193) }, { queueUntilMs: BASE + 4001 }, { deadlineMs: BASE + 8001 },
    { triggeredAtMs: BASE + 5000 }, { ref: 'bad-ref' }, { unrelated: true }]) {
    assert.throws(() => encodeIdentityBatch({ batchRef, entries: [{ ...entry, ...extra }] }));
  }
  assert.throws(() => signIdentityBatch({ body, batchRef, privateKey: keys.privateKey, keyId: 'bad"key', created: 1, expires: 2 }));
  assert.throws(() => signIdentityBatch({ body, batchRef, privateKey: keys.privateKey, keyId: 'key', created: 1, expires: 12 }));
});
