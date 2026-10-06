import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { IdentityFailure } from '../server/auth.mjs';
import { IdentityPolicyClient, IDENTITY_POLICY_ENDPOINT, IDENTITY_POLICY_ISSUER } from '../server/identity-policy-client.mjs';

const BASE = 1790000000000;
const identity = (extra = {}) => ({ issuer: IDENTITY_POLICY_ISSUER, sub: 'fictional-game-member',
  clientId: '27oe1fs5shskll808e733lqm65', authTime: BASE / 1000 - 20,
  accessToken: 'fictional-game-access-token', ...extra });
const policy = (who = identity(), extra = {}) => ({ version: 1, revokedBefore: 0, issuer: who.issuer,
  sub: who.sub, clientId: who.clientId, authTime: who.authTime, ...extra });
const failure = status => error => error instanceof IdentityFailure && error.status === status
  && !error.message.includes('access-token');
const microtasks = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
function clock() {
  let time = BASE, sequence = 0;
  const timers = new Map();
  const scheduler = {
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  function advance(milliseconds, delayed = false) {
    const until = time + milliseconds;
    if (delayed) time = until;
    for (;;) {
      const next = [...timers].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      timers.delete(next[0]); if (!delayed) time = next[1].at; next[1].callback();
    }
    time = until;
  }
  return { scheduler, now: () => time, advance, count: () => timers.size };
}
function fixture(fetcher) {
  const time = clock();
  return { time, adapter: new IdentityPolicyClient({ fetcher, now: time.now, scheduler: time.scheduler }) };
}

test('fixed server transport sends only the own Bearer token and empty body, with no positive cache', async () => {
  const calls = [];
  const { adapter, time } = fixture(async (url, options) => { calls.push({ url, options }); return Response.json(policy()); });
  assert.deepEqual(await adapter.check(identity()), policy());
  const { url, options } = calls[0];
  assert.equal(url, IDENTITY_POLICY_ENDPOINT); assert.equal(new URL(url).search, '');
  assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
  assert.equal(options.headers.Authorization, `Bearer ${identity().accessToken}`);
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.ok(!Object.keys(options.headers).some(key => ['origin', 'cookie'].includes(key.toLowerCase())));
  assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
  const second = adapter.check(identity()); assert.equal(calls.length, 1);
  time.advance(250); await second; assert.equal(calls.length, 2); assert.equal(time.count(), 0);
  assert.throws(() => { adapter.endpoint = 'https://other.example/'; }, TypeError);
  for (const endpoint of ['http://agora.sumomoli.com/api/identity/check', 'https://other.example/', `${IDENTITY_POLICY_ENDPOINT}?sub=x`, `${IDENTITY_POLICY_ENDPOINT}/`]) {
    assert.throws(() => new IdentityPolicyClient({ endpoint }), TypeError);
  }
});

test('invalid or future verified snapshots are rejected before any upstream call', async () => {
  let calls = 0; const { adapter } = fixture(async () => { calls++; return Response.json(policy()); });
  for (const who of [null, {}, identity({ issuer: 'https://other.example' }), identity({ sub: '' }), identity({ sub: 'a\nother' }),
    identity({ clientId: 'wrong!' }), identity({ authTime: undefined }), identity({ authTime: '123' }), identity({ authTime: -1 }),
    identity({ authTime: BASE / 1000 + 1 }), identity({ accessToken: '' }), identity({ accessToken: 'token\nheader' }),
    identity({ expiresAt: BASE }), identity({ expiresAt: 'future' })]) await assert.rejects(adapter.check(who), failure(401));
  assert.equal(calls, 0);
});

test('cutoff zero permits authTime zero; positive cutoffs require strictly newer authentication', async () => {
  const zero = identity({ authTime: 0 });
  assert.equal((await fixture(async () => Response.json(policy(zero))).adapter.check(zero)).authTime, 0);
  const who = identity();
  for (const revokedBefore of [1, who.authTime, who.authTime + 1]) {
    const expected = revokedBefore === 1 ? zero : who;
    await assert.rejects(fixture(async () => Response.json(policy(expected, { revokedBefore }))).adapter.check(expected), failure(401));
  }
  assert.equal((await fixture(async () => Response.json(policy(who, { revokedBefore: who.authTime - 1 }))).adapter.check(who)).authTime, who.authTime);
});

test('well-formed response identities must match the exact caller snapshot', async () => {
  for (const extra of [{ issuer: 'https://other.example' }, { sub: 'someone-else' }, { clientId: '15ieknek25quijgqdqcd8rfmom' }, { authTime: BASE / 1000 - 19 }]) {
    await assert.rejects(fixture(async () => Response.json(policy(identity(), extra))).adapter.check(identity()), failure(401));
  }
});

test('malformed policy JSON and non-401 failures are always unavailable', async () => {
  for (const value of [null, [], {}, policy(identity(), { version: 2 }), policy(identity(), { revokedBefore: -1 }),
    policy(identity(), { revokedBefore: '0' }), policy(identity(), { authTime: 1.5 }), policy(identity(), { sub: null }),
    policy(identity(), { clientId: 'invalid!' }), { ...policy(), accessToken: 'must-never-echo' }]) {
    await assert.rejects(fixture(async () => Response.json(value)).adapter.check(identity()), failure(503));
  }
  for (const status of [204, 301, 302, 400, 403, 404, 429, 500, 503]) {
    await assert.rejects(fixture(async () => new Response(null, { status })).adapter.check(identity()), failure(503));
  }
  await assert.rejects(fixture(async () => new Response(null, { status: 401 })).adapter.check(identity()), failure(401));
  for (const fetcher of [async () => new Response('invalid JSON', { status: 200 }),
    async () => { throw new Error('fictional-game-access-token transport detail'); },
    async () => ({ status: 200, ok: true, redirected: true, json: async () => policy() })]) {
    await assert.rejects(fixture(fetcher).adapter.check(identity()), failure(503));
  }
});

test('only identical identity and token snapshots share an in-flight promise', async () => {
  const responses = [], tokens = [];
  const { adapter, time } = fixture((_url, options) => { const reply = deferred(); responses.push(reply); tokens.push(options.headers.Authorization); return reply.promise; });
  const first = adapter.check(identity()); const duplicate = adapter.check(identity());
  assert.equal(first, duplicate); assert.equal(responses.length, 1);
  const otherToken = adapter.check(identity({ accessToken: 'other-fictional-token' }));
  assert.notEqual(first, otherToken); time.advance(250); assert.equal(responses.length, 2);
  const other = identity({ sub: 'another-member', accessToken: 'other-fictional-token' });
  const otherMember = adapter.check(other); time.advance(250); assert.equal(responses.length, 3);
  responses[1].resolve(Response.json(policy())); await otherToken;
  responses[2].resolve(Response.json(policy(other))); await otherMember;
  responses[0].resolve(Response.json(policy())); await first;
  assert.deepEqual(tokens, [`Bearer ${identity().accessToken}`, 'Bearer other-fictional-token', 'Bearer other-fictional-token']);
  assert.equal(time.count(), 0);
});

test('caller mutation cannot change a queued identity, token or accepted response', async () => {
  const calls = []; const original = identity(); const changed = identity({ sub: 'original-second', accessToken: 'second-token' });
  const { adapter, time } = fixture(async (_url, options) => { calls.push(options.headers.Authorization); return Response.json(policy(calls.length === 1 ? original : identity({ sub: 'original-second', accessToken: 'second-token' }))); });
  await adapter.check(original); const pending = adapter.check(changed);
  changed.sub = 'switched-member'; changed.authTime = BASE / 1000; changed.accessToken = 'switched-token';
  time.advance(250); assert.equal((await pending).sub, 'original-second'); assert.equal(calls[1], 'Bearer second-token');
});

test('seven members with fourteen independent tokens finish a burst in 3.25 seconds without merging tokens', async () => {
  const times = []; const { adapter, time } = fixture(async (_url, options) => {
    const index = Number(options.headers.Authorization.split('device-')[1]);
    times.push(time.now()); return Response.json(policy(identity({ sub: `member-${Math.floor(index / 2)}` })));
  });
  const checks = Array.from({ length: 14 }, (_, index) => adapter.check(identity({
    sub: `member-${Math.floor(index / 2)}`, accessToken: `device-${index}`,
  })));
  const settled = Promise.all(checks); time.advance(3250); await settled;
  assert.equal(times.length, 14); assert.deepEqual(times.map(value => value - BASE), Array.from({ length: 14 }, (_, index) => index * 250));
  assert.equal(time.count(), 0);
});

test('a twenty-identity overload sends at least 250ms apart and honestly rejects waits over four seconds', async () => {
  const times = []; const { adapter, time } = fixture(async (_url, options) => {
    times.push(time.now()); const index = Number(options.headers.Authorization.split('burst-')[1]);
    return Response.json(policy(identity({ sub: `burst-${index}`, accessToken: `burst-${index}` })));
  });
  const checks = Array.from({ length: 20 }, (_, index) => adapter.check(identity({ sub: `burst-${index}`, accessToken: `burst-${index}` })));
  const settled = Promise.allSettled(checks); time.advance(4000); await microtasks(); const results = await settled;
  assert.deepEqual(times.map(value => value - BASE), Array.from({ length: 16 }, (_, index) => index * 250));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 16);
  assert.ok(results.filter(value => value.status === 'rejected').every(value => failure(503)(value.reason)));
  assert.equal(time.count(), 0);
});

test('delayed event-loop wakeups never bunch expired scheduled send slots together', async () => {
  const sent = []; const { adapter, time } = fixture(async (_url, options) => {
    sent.push(time.now()); return Response.json(policy(identity({ sub: options.headers.Authorization.slice(7) })));
  });
  const first = adapter.check(identity({ sub: 'first-token', accessToken: 'first-token' }));
  const second = adapter.check(identity({ sub: 'second-token', accessToken: 'second-token' }));
  const third = adapter.check(identity({ sub: 'third-token', accessToken: 'third-token' }));
  time.advance(1000, true); assert.deepEqual(sent.map(value => value - BASE), [0, 1000]);
  time.advance(249); assert.equal(sent.length, 2); time.advance(1);
  await Promise.all([first, second, third]); assert.deepEqual(sent.map(value => value - BASE), [0, 1000, 1250]);
});

test('the total eight-second deadline includes queue and ignores transport that never observes abort', async () => {
  const signals = []; const { adapter, time } = fixture((_url, options) => { signals.push(options.signal); return new Promise(() => {}); });
  const first = adapter.check(identity()); const second = adapter.check(identity({ accessToken: 'another-token' }));
  const rejected = Promise.all([assert.rejects(first, failure(503)), assert.rejects(second, failure(503))]);
  time.advance(250); assert.equal(signals.length, 2);
  time.advance(7750); await rejected; assert.ok(signals.every(signal => signal.aborted)); assert.equal(time.count(), 0);
});

test('a stuck JSON parse times out, and its late completion cannot remove or authorize a newer same-key check', async () => {
  const oldJson = deferred(), newerReply = deferred(); let calls = 0;
  const { adapter, time } = fixture(async () => ++calls === 1
    ? { status: 200, ok: true, redirected: false, json: () => oldJson.promise } : newerReply.promise);
  const old = adapter.check(identity()); const failed = assert.rejects(old, failure(503)); await microtasks();
  time.advance(8000); await failed; const newer = adapter.check(identity()); assert.equal(calls, 2);
  oldJson.resolve(policy()); await microtasks();
  assert.equal(adapter.check(identity()), newer, 'late old cleanup must preserve the new in-flight slot'); assert.equal(calls, 2);
  newerReply.resolve(Response.json(policy())); assert.deepEqual(await newer, policy()); assert.equal(time.count(), 0);
});

test('an access token expiring in the queue is never sent, and expiry during JSON cannot authorize', async () => {
  let calls = 0; const { adapter, time } = fixture(async () => { calls++; return Response.json(policy()); });
  await adapter.check(identity()); const queued = adapter.check(identity({ expiresAt: BASE + 200 }));
  const rejected = assert.rejects(queued, failure(401)); time.advance(250); await rejected; assert.equal(calls, 1);
  const json = deferred(); const late = fixture(async () => ({ status: 200, ok: true, json: () => json.promise }));
  const checking = late.adapter.check(identity({ expiresAt: BASE + 1000 })); const expired = assert.rejects(checking, failure(401));
  await microtasks(); late.time.advance(1000); json.resolve(policy()); await expired; assert.equal(late.time.count(), 0);
});

test('an already exhausted outer deadline never starts a new central request', async () => {
  let calls = 0; const { adapter, time } = fixture(async () => { calls++; return Response.json(policy()); });
  const controller = new AbortController(); controller.abort(new Error('outer deadline'));
  await assert.rejects(adapter.check(identity(), { signal: controller.signal }), failure(503));
  assert.equal(calls, 0); assert.equal(time.count(), 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an outer abort cancels queued work before it sends and removes its event listener', async () => {
  let calls = 0; const { adapter, time } = fixture(async () => { calls++; return Response.json(policy()); });
  await adapter.check(identity()); const controller = new AbortController();
  const queued = adapter.check(identity({ accessToken: 'queued-token' }), { signal: controller.signal });
  const failed = assert.rejects(queued, failure(503)); assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  time.advance(100); controller.abort(); await failed; time.advance(500);
  assert.equal(calls, 1); assert.equal(time.count(), 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a one-second remaining outer budget bounds ignored-abort fetch and stuck JSON parsing', async () => {
  for (const parse of [false, true]) {
    const reply = deferred(); let ownSignal;
    const { adapter, time } = fixture((_url, options) => {
      ownSignal = options.signal;
      return parse ? Promise.resolve({ status: 200, ok: true, json: () => reply.promise }) : reply.promise;
    });
    const controller = new AbortController(), checking = adapter.check(identity(), { signal: controller.signal });
    const failed = assert.rejects(checking, failure(503)); await microtasks();
    time.scheduler.setTimeout(() => controller.abort(), 1000); time.advance(1000); await failed;
    assert.equal(ownSignal.aborted, true); assert.equal(time.count(), 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    reply.resolve(parse ? policy() : Response.json(policy())); await microtasks();
  }
});

test('any deduplicated caller abort cancels the shared check and cleans every participating signal', async () => {
  const response = deferred(); let calls = 0, ownSignal;
  const { adapter, time } = fixture((_url, options) => { calls++; ownSignal = options.signal; return response.promise; });
  const firstSignal = new AbortController(), secondSignal = new AbortController();
  const first = adapter.check(identity(), { signal: firstSignal.signal });
  const second = adapter.check(identity(), { signal: secondSignal.signal });
  assert.equal(first, second); assert.equal(calls, 1);
  const failed = assert.rejects(first, failure(503)); secondSignal.abort(); await failed;
  assert.equal(ownSignal.aborted, true); assert.equal(time.count(), 0);
  for (const controller of [firstSignal, secondSignal]) assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  response.resolve(Response.json(policy())); await microtasks();
});

test('completed or timed-out outer listeners cannot cancel a newer same-key check', async () => {
  for (const timeout of [false, true]) {
    const oldReply = deferred(), newReply = deferred(); let calls = 0;
    const { adapter, time } = fixture(() => ++calls === 1 ? oldReply.promise : newReply.promise);
    const oldSignal = new AbortController(), newSignal = new AbortController();
    const old = adapter.check(identity(), { signal: oldSignal.signal });
    if (timeout) { const failed = assert.rejects(old, failure(503)); time.advance(8000); await failed; }
    else { oldReply.resolve(Response.json(policy())); await old; time.advance(250); }
    assert.equal(getEventListeners(oldSignal.signal, 'abort').length, 0);
    const newer = adapter.check(identity(), { signal: newSignal.signal }); assert.equal(calls, 2);
    oldSignal.abort(); oldReply.resolve(Response.json(policy())); await microtasks();
    assert.equal(adapter.check(identity()), newer); assert.equal(getEventListeners(newSignal.signal, 'abort').length, 1);
    newReply.resolve(Response.json(policy())); await newer;
    assert.equal(getEventListeners(newSignal.signal, 'abort').length, 0); assert.equal(time.count(), 0);
  }
});
