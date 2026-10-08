import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { IdentityFailure } from '../server/auth.mjs';
import { SHARED_ISSUER } from '../server/config.mjs';
import { createIdentityCheckContext } from '../server/identity-check-context.mjs';
import { IdentityBatchClient } from '../server/identity-batch-client.mjs';
import { IDENTITY_BATCH_ENDPOINT, readIdentityBatchBody } from '../server/identity-batch-wire.mjs';

const BASE = 1790000000000;
const keys = generateKeyPairSync('ed25519');
// Local candidate: 5ms is the maximum collection window. A complete sixteen
// currently live/unblocked refs may send early only with an available transport
// and envelope; probes never release unknown owners or replace wire fences.
const identity = (extra = {}) => ({ issuer: SHARED_ISSUER, sub: 'parallel-fictional-player',
  clientId: '27oe1fs5shskll808e733lqm65', authTime: BASE / 1000 - 20,
  expiresAt: BASE + 3600000, accessToken: 'parallel-fictional-token', ...extra });
const policy = who => ({ version: 1, revokedBefore: 0, issuer: who.issuer, sub: who.sub,
  clientId: who.clientId, authTime: who.authTime });
const flush = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe(promise) {
  const outcome = { settled: false, value: undefined, error: undefined };
  outcome.promise = promise.then(value => { outcome.settled = true; outcome.value = value; },
    error => { outcome.settled = true; outcome.error = error; });
  return outcome;
}
function clock() {
  let wall = BASE, monotonic = 0, sequence = 0;
  const timers = new Map();
  const scheduler = {
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { at: monotonic + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  function advance(ms, runTimers = true) {
    const until = monotonic + ms;
    if (runTimers) for (;;) {
      const next = [...timers].filter(([, entry]) => entry.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      wall += Math.max(0, next[1].at - monotonic); monotonic = Math.max(monotonic, next[1].at);
      timers.delete(next[0]); next[1].callback();
    }
    wall += until - monotonic; monotonic = until;
  }
  const fireAtDelay = delay => {
    const matches = [...timers].filter(([, entry]) => entry.at === monotonic + delay);
    assert.equal(matches.length, 1, 'one real scheduled callback must have the requested deadline');
    timers.delete(matches[0][0]); matches[0][1].callback();
  };
  return { now: () => wall, monotonicNow: () => monotonic, scheduler, advance, fireAtDelay, count: () => timers.size };
}
function verifyWire(url, options) {
  assert.equal(url, IDENTITY_BATCH_ENDPOINT);
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Accept, 'application/json');
  assert.equal(options.headers['Accept-Encoding'], 'identity');
  assert.equal(options.headers['Content-Digest'],
    `sha-256=:${createHash('sha256').update(options.body).digest('base64')}:`);
  const parameters = options.headers['Signature-Input'].slice('agora='.length);
  const base = ['"@method": POST', '"@scheme": https', '"@authority": agora.sumomoli.com',
    '"@path": /api/identity/batch', `"content-digest": ${options.headers['Content-Digest']}`,
    '"content-type": application/json', '"x-agora-audience": agora.identity.batch.v1',
    `"@signature-params": ${parameters}`].join('\n');
  assert.equal(verify(null, Buffer.from(base), keys.publicKey,
    Buffer.from(options.headers.Signature.slice('agora=:'.length, -1), 'base64')), true);
}
function fixture(extra = {}) {
  const time = clock(), calls = [], identities = new Map();
  const client = new IdentityBatchClient({ enabled: true, keyId: 'parallel-test-v1', privateKey: keys.privateKey,
    fetcher(url, options) {
      verifyWire(url, options);
      const operation = deferred();
      calls.push({ options, request: JSON.parse(options.body), operation });
      return operation.promise;
    }, now: time.now, monotonicNow: time.monotonicNow, scheduler: time.scheduler, ...extra });
  const check = (who = identity(), options = {}) => {
    identities.set(who.accessToken, who);
    return observe(client.check(who, options));
  };
  const context = options => createIdentityCheckContext({ now: time.now, monotonicNow: time.monotonicNow,
    scheduler: time.scheduler, ...options });
  const response = (index, changes = value => value) => Response.json(changes({ version: 1,
    batchRef: calls[index].request.batchRef, entries: calls[index].request.entries.map(entry => ({ ref: entry.ref,
      status: 200, policy: policy(identities.get(entry.accessToken)) })) }));
  const settle = async (index, value = response(index)) => {
    calls[index].operation.resolve(value); await flush();
  };
  const collect = async () => { time.advance(5); await flush(); };
  const drained = () => {
    assert.deepEqual(client.occupancy, { queuedEntries: 0, logicalWaiters: 0, residentEnvelopes: 0,
      activeTransports: 0, residentBytes: 0, tombstones: 0 });
    assert.equal(time.count(), 0);
  };
  return { time, calls, client, check, context, response, settle, collect, drained };
}
function failed(outcome, status = 503) {
  assert.equal(outcome.settled, true);
  assert.ok(outcome.error instanceof IdentityFailure);
  assert.equal(outcome.error.status, status);
}
function responseBody(body, headers = { 'content-type': 'application/json' }) {
  return { status: 200, ok: true, redirected: false, headers: new Headers(headers), body };
}

test('sixteen live queued refs send before the collector clock advances; fifteen retain the full maximum window', async () => {
  const full = fixture(), fullChecks = Array.from({ length: 16 }, () => full.check());
  assert.equal(full.calls.length, 1); assert.equal(full.calls[0].request.entries.length, 16);
  assert.equal(new Set(full.calls[0].request.entries.map(entry => entry.ref)).size, 16);
  assert.ok(full.calls[0].request.entries.every(entry => entry.triggeredAtMs === BASE));
  await full.settle(0); await Promise.all(fullChecks.map(value => value.promise)); full.drained();
  const partial = fixture(), checks = Array.from({ length: 15 }, () => partial.check());
  assert.equal(partial.calls.length, 0); partial.time.advance(4); await flush(); assert.equal(partial.calls.length, 0);
  partial.time.advance(1); assert.equal(partial.calls.length, 1); assert.equal(partial.calls[0].request.entries.length, 15);
  await partial.settle(0); await Promise.all(checks.map(value => value.promise)); partial.drained();
});

test('native Node timer fires the partial collector and cancels it when the sixteenth live ref arrives', async () => {
  for (const size of [15, 16]) {
    const timers = new Set(), collectionFires = [], calls = [], now = Date.now();
    const who = identity({ authTime: Math.floor(now / 1000) - 20, expiresAt: now + 3600000 });
    const scheduler = {
      setTimeout(callback, ms) {
        const id = setTimeout(() => { timers.delete(id); if (ms === 5) collectionFires.push(ms); callback(); }, ms);
        timers.add(id); return id;
      },
      clearTimeout(id) { clearTimeout(id); timers.delete(id); },
    };
    const client = new IdentityBatchClient({ enabled: true, keyId: 'native-full-batch-test', privateKey: keys.privateKey,
      scheduler, fetcher(url, options) {
        verifyWire(url, options); const request = JSON.parse(options.body); calls.push(request);
        return Promise.resolve(Response.json({ version: 1, batchRef: request.batchRef,
          entries: request.entries.map(entry => ({ ref: entry.ref, status: 200, policy: policy(who) })) }));
      } });
    try {
      const checks = Array.from({ length: size }, () => client.check(who));
      assert.equal(calls.length, size === 16 ? 1 : 0); assert.equal(collectionFires.length, 0);
      await Promise.all(checks); await delay(25);
      assert.equal(calls.length, 1); assert.equal(calls[0].entries.length, size);
      assert.equal(collectionFires.length, size === 16 ? 0 : 1);
      assert.equal(timers.size, 0); assert.equal(client.occupancy.residentBytes, 0);
    } finally { client.close(); for (const id of timers) clearTimeout(id); }
  }
});

test('a partial late caller keeps its own trigger without restarting the five-millisecond collection window', async () => {
  const f = fixture(), first = f.check();
  f.time.advance(4); assert.equal(f.calls.length, 0);
  const later = f.check(); assert.equal(f.calls.length, 0);
  f.time.advance(1); assert.equal(f.calls.length, 1);
  const entries = f.calls[0].request.entries;
  assert.equal(entries.length, 2); assert.notEqual(entries[0].ref, entries[1].ref);
  assert.deepEqual(entries.map(entry => [entry.triggeredAtMs, entry.queueUntilMs, entry.deadlineMs]),
    [[BASE, BASE + 4000, BASE + 8000], [BASE + 4, BASE + 4004, BASE + 8004]]);
  await f.settle(0); await Promise.all([first.promise, later.promise]);
  assert.deepEqual(first.value, policy(identity())); assert.deepEqual(later.value, policy(identity())); f.drained();
});

test('restricting at four milliseconds signs the remaining original six-millisecond deadline rather than resetting it', async () => {
  const f = fixture(), context = f.context(), who = identity({ expiresAt: BASE + 1000 });
  const pending = f.check(who, { context });
  f.time.advance(4); context.restrict(6); assert.equal(f.calls.length, 0);
  f.time.advance(1); assert.equal(f.calls.length, 1);
  const entry = f.calls[0].request.entries[0];
  assert.equal(entry.triggeredAtMs, BASE); assert.equal(entry.queueUntilMs, BASE + 6); assert.equal(entry.deadlineMs, BASE + 6);
  assert.equal(context.remainingMs(), 1); await f.settle(0); await pending.promise;
  assert.deepEqual(pending.value, policy(who)); assert.equal(context.isLive(), true);
  context.dispose(); f.drained();
});

test('JWT expiry during collection rejects only its unsent ref and does not extend the live ref or reset collection', async () => {
  const f = fixture(), expired = f.check(identity({ expiresAt: BASE + 4, accessToken: 'expires-in-collection' }));
  const who = identity({ accessToken: 'live-in-collection' }), live = f.check(who);
  // Its original queue bound is also JWT expiry; that earlier registered timer
  // preserves the existing unavailable result instead of changing auth policy.
  f.time.advance(4); await expired.promise; failed(expired, 503);
  assert.equal(f.calls.length, 0); assert.equal(f.client.occupancy.logicalWaiters, 1); assert.equal(f.client.occupancy.tombstones, 0);
  f.time.advance(1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.entries.length, 1);
  assert.deepEqual(f.calls[0].request.entries[0], { ref: f.calls[0].request.entries[0].ref,
    accessToken: who.accessToken, triggeredAtMs: BASE, queueUntilMs: BASE + 4000, deadlineMs: BASE + 8000 });
  await f.settle(0); await live.promise; assert.deepEqual(live.value, policy(who)); f.drained();
});

test('five-millisecond collection distinguishes queued cancellation from sent read and cancel settlement', async () => {
  const f = fixture(), queuedAbort = new AbortController(), sentAbort = new AbortController();
  const queued = f.check(identity(), { signal: queuedAbort.signal });
  f.time.advance(4); assert.equal(f.calls.length, 0); queuedAbort.abort(); await queued.promise; failed(queued);
  assert.equal(f.client.occupancy.logicalWaiters, 0); assert.equal(f.client.occupancy.residentBytes, 0);
  const sent = f.check(identity(), { signal: sentAbort.signal }); f.time.advance(1); assert.equal(f.calls.length, 1);
  const entry = f.calls[0].request.entries[0];
  assert.equal(entry.triggeredAtMs, BASE + 4); assert.equal(entry.deadlineMs, BASE + 8004);
  const read = deferred(), cancel = deferred(); let cancels = 0, releases = 0;
  await f.settle(0, responseBody({ getReader: () => ({ read: () => read.promise,
    cancel() { cancels++; return cancel.promise; }, releaseLock() { releases++; } }) }));
  sentAbort.abort(); await sent.promise; failed(sent); await flush();
  const bytes = f.client.occupancy.residentBytes; assert.ok(bytes > 0); assert.equal(cancels, 1);
  const replacement = f.check(); await f.collect(); assert.equal(f.calls.length, 1);
  cancel.resolve(); await flush(); assert.equal(f.calls.length, 1); assert.equal(releases, 0);
  assert.equal(f.client.occupancy.activeTransports, 1); assert.ok(f.client.occupancy.residentBytes >= bytes);
  assert.equal(f.client.occupancy.tombstones, 1);
  read.resolve({ done: true }); await flush(); assert.equal(releases, 1); assert.equal(f.calls.length, 2);
  await f.settle(1); await replacement.promise; assert.deepEqual(replacement.value, policy(identity())); f.drained();
});

test('the sixteenth ready ref clears the old timer and sends current shortened original deadlines', async () => {
  const f = fixture(), context = f.context();
  const first = f.check(identity(), { context });
  const rest = Array.from({ length: 14 }, () => f.check());
  f.time.advance(4); context.restrict(500);
  const last = f.check(); assert.equal(f.calls.length, 1);
  const entries = f.calls[0].request.entries;
  assert.equal(entries.length, 16); assert.equal(entries[0].triggeredAtMs, BASE);
  assert.equal(entries[0].queueUntilMs, BASE + 500); assert.equal(entries[0].deadlineMs, BASE + 500);
  assert.equal(entries[15].triggeredAtMs, BASE + 4);
  assert.equal(entries[15].queueUntilMs, BASE + 4004); assert.equal(entries[15].deadlineMs, BASE + 8004);
  await f.settle(0); await Promise.all([first.promise, ...rest.map(value => value.promise), last.promise]);
  context.dispose(); f.time.advance(1); await flush(); assert.equal(f.calls.length, 1); f.drained();
});

test('an unknown owner does not count as the sixteenth ready ref or let its queued replacement bypass collection', async () => {
  const f = fixture(), abort = new AbortController();
  const old = f.check(identity(), { signal: abort.signal }); await f.collect(); abort.abort(); await old.promise;
  const blocked = f.check();
  const ready = Array.from({ length: 15 }, (_, index) => f.check(identity({ sub: `ready-${index}`, accessToken: `ready-token-${index}` })));
  assert.equal(f.calls.length, 1); assert.equal(f.client.occupancy.queuedEntries, 16);
  f.time.advance(4); await flush(); assert.equal(f.calls.length, 1);
  f.time.advance(1); await flush(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].request.entries.length, 15); assert.equal(f.client.occupancy.queuedEntries, 1);
  await f.settle(1); await Promise.all(ready.map(value => value.promise));
  await f.settle(0); assert.equal(f.calls.length, 3); await f.settle(2);
  assert.deepEqual(blocked.value, policy(identity())); f.drained();
});

test('unknown blocked refs may be skipped to form a complete independent ready batch without replacing them', async () => {
  const f = fixture(), abort = new AbortController();
  const old = f.check(identity(), { signal: abort.signal }); await f.collect(); abort.abort(); await old.promise;
  const blocked = f.check();
  const ready = Array.from({ length: 16 }, (_, index) => f.check(identity({ sub: `full-ready-${index}`, accessToken: `full-ready-token-${index}` })));
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].request.entries.length, 16);
  assert.equal(f.client.occupancy.queuedEntries, 1); assert.equal(f.client.occupancy.tombstones, 1);
  assert.ok(f.calls[1].request.entries.every(entry => entry.accessToken !== identity().accessToken));
  await f.settle(1); await Promise.all(ready.map(value => value.promise));
  await f.settle(0); await f.settle(2); assert.equal(blocked.error, undefined); f.drained();
});

test('four actual transports stop full batches without spinning or borrowing an unknown slot', async () => {
  const f = fixture(), active = [];
  for (let index = 0; index < 4; index++) { active.push(f.check()); await f.collect(); }
  const waiting = Array.from({ length: 16 }, () => f.check());
  assert.equal(f.calls.length, 4); assert.equal(f.client.occupancy.queuedEntries, 16);
  f.time.advance(100); await flush(); assert.equal(f.calls.length, 4); assert.equal(f.client.occupancy.activeTransports, 4);
  await f.settle(0); assert.equal(f.calls.length, 5); assert.equal(f.calls[4].request.entries.length, 16);
  assert.equal(f.client.occupancy.activeTransports, 4);
  for (const index of [1, 2, 3, 4]) await f.settle(index);
  await Promise.all([...active, ...waiting].map(value => value.promise)); f.drained();
});

test('cleanup entries cannot trigger a full replacement batch even while their callers are live', async () => {
  const f = fixture(), cancellation = deferred();
  const old = f.check(); await f.collect();
  await f.settle(0, responseBody({ cancel: () => cancellation.promise }, { 'content-type': 'text/html' }));
  assert.equal(old.settled, false);
  const waiting = Array.from({ length: 16 }, () => f.check());
  assert.equal(f.calls.length, 1); assert.equal(f.client.occupancy.queuedEntries, 16);
  f.time.advance(4); await flush(); assert.equal(f.calls.length, 1);
  f.time.advance(1); await flush(); assert.equal(f.calls.length, 1);
  cancellation.resolve(); await flush(); failed(old); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].request.entries.length, 16); await f.settle(1);
  await Promise.all(waiting.map(value => value.promise)); f.drained();
});

test('expired or canceled queued refs do not make a partial live batch ready before the maximum window', async () => {
  const f = fixture(), short = f.context({ timeoutMs: 2 }), abort = new AbortController();
  const expired = f.check(identity({ accessToken: 'short-context-token' }), { context: short });
  f.time.advance(2, false); assert.equal(short.isLive(), false); assert.equal(expired.settled, false);
  const canceled = f.check(identity({ accessToken: 'canceled-token' }), { signal: abort.signal });
  abort.abort(); await canceled.promise; failed(canceled);
  const live = Array.from({ length: 15 }, () => f.check());
  assert.equal(f.calls.length, 0); f.time.advance(2); await flush(); failed(expired);
  assert.equal(f.calls.length, 0); f.time.advance(1); await flush(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.entries.length, 15);
  await f.settle(0); await Promise.all(live.map(value => value.promise)); short.dispose(); f.drained();
});

test('early full-batch scheduling keeps byte admission and envelope slots conservative', async () => {
  const byteLimited = fixture({ limits: { residentBytes: 100000 } });
  const refused = Array.from({ length: 16 }, () => byteLimited.check()); await flush();
  refused.forEach(value => failed(value)); assert.equal(byteLimited.calls.length, 0); byteLimited.drained();
  const f = fixture({ limits: { envelopes: 1 } }), active = f.check(); await f.collect();
  const queued = Array.from({ length: 16 }, () => f.check()); assert.equal(f.calls.length, 1);
  f.time.advance(5); await flush(); assert.equal(f.calls.length, 1);
  await f.settle(0); assert.equal(f.calls.length, 2); await f.settle(1);
  await Promise.all([active.promise, ...queued.map(value => value.promise)]); f.drained();
});

test('healthy sent exact keys run independently before the older response, with fresh refs and original bounds', async () => {
  const f = fixture();
  const first = f.check(); await f.collect();
  const second = f.check(); await f.collect();
  assert.equal(f.calls.length, 2); assert.equal(f.client.occupancy.activeTransports, 2);
  const [a, b] = f.calls.map(call => call.request);
  assert.notEqual(a.batchRef, b.batchRef); assert.notEqual(a.entries[0].ref, b.entries[0].ref);
  assert.equal(a.entries[0].triggeredAtMs, BASE); assert.equal(b.entries[0].triggeredAtMs, BASE + 5);
  assert.equal(a.entries[0].deadlineMs, BASE + 8000); assert.equal(b.entries[0].deadlineMs, BASE + 8005);
  await f.settle(1); assert.deepEqual(second.value, policy(identity())); assert.equal(first.settled, false);
  const third = f.check(); await f.collect(); assert.equal(f.calls.length, 3);
  assert.notEqual(f.calls[2].request.entries[0].ref, b.entries[0].ref);
  await f.settle(0); await f.settle(2);
  assert.deepEqual(first.value, policy(identity())); assert.deepEqual(third.value, policy(identity())); f.drained();
});

test('each parallel response still binds its exact identity and cannot borrow an older successful policy', async () => {
  const f = fixture();
  const a = f.check(); await f.collect();
  const b = f.check(); await f.collect();
  await f.settle(1, f.response(1, value => ({ ...value, entries: value.entries.map(entry => ({ ...entry,
    policy: { ...entry.policy, sub: 'different-fictional-player' } })) })));
  failed(b, 401); assert.equal(a.settled, false);
  await f.settle(0); assert.deepEqual(a.value, policy(identity())); f.drained();
});

test('a healthy sibling settlement does not refund another canceled same-key owner', async () => {
  const f = fixture(), abort = new AbortController();
  const a = f.check(identity(), { signal: abort.signal }); await f.collect();
  const b = f.check(); await f.collect();
  abort.abort(); await a.promise; failed(a);
  const replacement = f.check(); await f.collect();
  assert.equal(f.calls.length, 2); assert.equal(f.client.occupancy.queuedEntries, 1);
  await f.settle(1); assert.deepEqual(b.value, policy(identity()));
  assert.equal(f.calls.length, 2); assert.equal(f.client.occupancy.tombstones, 1);
  await f.settle(0); assert.equal(f.calls.length, 3); assert.equal(replacement.settled, false);
  await f.settle(2); assert.deepEqual(replacement.value, policy(identity())); f.drained();
});

for (const order of [[0, 1], [1, 0]]) test(`two unknown same-key owners release only after both actual settlements: ${order.join('-')}`, async () => {
  const f = fixture(), controllers = [new AbortController(), new AbortController()];
  const a = f.check(identity(), { signal: controllers[0].signal }); await f.collect();
  const b = f.check(identity(), { signal: controllers[1].signal }); await f.collect();
  controllers.forEach(value => value.abort()); await Promise.all([a.promise, b.promise]); failed(a); failed(b);
  const c = f.check(); await f.collect(); assert.equal(f.calls.length, 2);
  assert.equal(f.client.occupancy.tombstones, 2);
  await f.settle(order[0]); assert.equal(f.calls.length, 2); assert.equal(f.client.occupancy.tombstones, 1);
  await f.settle(order[1]); assert.equal(f.calls.length, 3); assert.equal(f.client.occupancy.tombstones, 0);
  await f.settle(2); assert.deepEqual(c.value, policy(identity())); f.drained();
});

test('one canceled duplicate in an envelope blocks replacements until its surviving ref and transport settle', async () => {
  const f = fixture(), abort = new AbortController();
  const canceled = f.check(identity(), { signal: abort.signal }), survivor = f.check();
  await f.collect(); assert.equal(f.calls[0].request.entries.length, 2);
  assert.notEqual(f.calls[0].request.entries[0].ref, f.calls[0].request.entries[1].ref);
  abort.abort(); await canceled.promise; failed(canceled);
  assert.equal(f.calls[0].options.signal.aborted, false);
  const replacement = f.check(); await f.collect(); assert.equal(f.calls.length, 1);
  await f.settle(0); assert.deepEqual(survivor.value, policy(identity())); assert.equal(f.calls.length, 2);
  await f.settle(1); assert.deepEqual(replacement.value, policy(identity())); f.drained();
});

test('unknown fetch holds only its exact six-field identity/token key and permits other independently bound keys', async () => {
  const f = fixture(), abort = new AbortController(), original = identity();
  const a = f.check(original, { signal: abort.signal }); await f.collect();
  abort.abort(); await a.promise;
  const blocked = f.check(original);
  const variants = [identity({ accessToken: 'other-token' }), identity({ authTime: original.authTime - 1,
    accessToken: 'earlier-auth-token' }), identity({ expiresAt: original.expiresAt + 1000, accessToken: 'later-expiry-token' })];
  const allowed = variants.map(who => f.check(who)); await f.collect();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].request.entries.length, 3);
  assert.equal(f.client.occupancy.queuedEntries, 1);
  await f.settle(1); allowed.forEach((value, index) => assert.deepEqual(value.value, policy(variants[index])));
  assert.equal(blocked.settled, false); await f.settle(0); assert.equal(f.calls.length, 3);
  await f.settle(2); assert.deepEqual(blocked.value, policy(original)); f.drained();
});

test('the same exact token with different verified auth time or millisecond expiry retains separate ownership', async () => {
  const f = fixture(), abort = new AbortController(), original = identity();
  const old = f.check(original, { signal: abort.signal }); await f.collect(); abort.abort(); await old.promise;
  const blocked = f.check(original);
  const variants = [identity({ authTime: original.authTime - 1 }), identity({ expiresAt: original.expiresAt + 1000 })];
  const checks = [];
  for (const who of variants) { checks.push(f.check(who)); await f.collect(); }
  assert.equal(f.calls.length, 3); assert.equal(f.client.occupancy.queuedEntries, 1);
  for (let index = 0; index < variants.length; index++) {
    await f.settle(index + 1, f.response(index + 1, value => ({ ...value,
      entries: value.entries.map(entry => ({ ...entry, policy: policy(variants[index]) })) })));
    assert.deepEqual(checks[index].value, policy(variants[index]));
  }
  await f.settle(0); assert.equal(f.calls.length, 4);
  await f.settle(3, f.response(3, value => ({ ...value,
    entries: value.entries.map(entry => ({ ...entry, policy: policy(original) })) })));
  assert.deepEqual(blocked.value, policy(original)); f.drained();
});

test('bad response headers synchronously quarantine every envelope key through the actual late body cancel', async () => {
  const f = fixture(), cancel = deferred(); let cancelCalls = 0;
  const first = f.check(), otherIdentity = identity({ sub: 'second-player', accessToken: 'second-token' });
  const second = f.check(otherIdentity); await f.collect();
  await f.settle(0, responseBody({ cancel() { cancelCalls++; return cancel.promise; } }, { 'content-type': 'text/html' }));
  assert.equal(cancelCalls, 1); assert.equal(first.settled, false); assert.equal(second.settled, false);
  const bytes = f.client.occupancy.residentBytes;
  const blocked = [f.check(), f.check(otherIdentity)];
  const unrelatedIdentity = identity({ sub: 'third-player', accessToken: 'third-token' });
  const unrelated = f.check(unrelatedIdentity); await f.collect();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].request.entries.length, 1);
  await f.settle(1); assert.deepEqual(unrelated.value, policy(unrelatedIdentity));
  assert.ok(f.client.occupancy.residentBytes >= bytes); assert.equal(f.client.occupancy.activeTransports, 1);
  cancel.resolve(); await flush(); failed(first); failed(second);
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].request.entries.length, 2);
  await f.settle(2); blocked.forEach(value => assert.equal(value.error, undefined)); f.drained();
});

test('machine top-level authentication error quarantines its key through failed late cancel and remains service failure', async () => {
  const f = fixture(), cancel = deferred(); let calls = 0;
  const a = f.check(); await f.collect();
  await f.settle(0, { status: 401, ok: false, redirected: false,
    body: { cancel() { calls++; return cancel.promise; } } });
  assert.equal(calls, 1); assert.equal(a.settled, false);
  const replacement = f.check(); await f.collect(); assert.equal(f.calls.length, 1);
  cancel.reject(new Error('synthetic late cancel rejection')); await flush(); failed(a, 503);
  assert.equal(f.calls.length, 2); await f.settle(1);
  assert.deepEqual(replacement.value, policy(identity())); f.drained();
});

for (const chunk of [Buffer.alloc(32769), 'wrong-byte-chunk']) test(`invalid body ${typeof chunk === 'string' ? 'chunk type' : 'byte budget'} keeps exact-key ownership while reader cancel is pending`, async () => {
  const f = fixture(), canceled = deferred(); let cancelCalls = 0, releases = 0;
  const a = f.check(); await f.collect();
  const reader = { read: async () => ({ done: false, value: chunk }), cancel() { cancelCalls++; return canceled.promise; },
    releaseLock() { releases++; } };
  await f.settle(0, responseBody({ getReader: () => reader }));
  assert.equal(cancelCalls, 1); assert.equal(releases, 0); assert.equal(a.settled, false);
  const replacement = f.check(); await f.collect(); assert.equal(f.calls.length, 1);
  assert.equal(f.client.occupancy.activeTransports, 1);
  canceled.resolve(); await flush(); failed(a); assert.equal(releases, 1); assert.equal(f.calls.length, 2);
  await f.settle(1); assert.deepEqual(replacement.value, policy(identity())); f.drained();
});

test('a reader rejection marks failure cleanup before a noncooperative cancellation settles', async () => {
  const f = fixture(), cancel = deferred(); let cancelCalls = 0;
  const a = f.check(); await f.collect();
  await f.settle(0, responseBody({ getReader: () => ({
    read: async () => { throw new Error('synthetic read failure'); },
    cancel() { cancelCalls++; return cancel.promise; }, releaseLock() {},
  }) }));
  assert.equal(cancelCalls, 1); assert.equal(a.settled, false);
  const replacement = f.check(); await f.collect(); assert.equal(f.calls.length, 1);
  cancel.resolve(); await flush(); failed(a); assert.equal(f.calls.length, 2);
  await f.settle(1); assert.deepEqual(replacement.value, policy(identity())); f.drained();
});

for (const cancelFails of [false, true]) test(`noncooperative read and ${cancelFails ? 'rejected' : 'resolved'} cancel must both settle before refund`, async () => {
  const f = fixture(), abort = new AbortController(), read = deferred(), cancel = deferred();
  let cancelCalls = 0, releases = 0;
  const a = f.check(identity(), { signal: abort.signal }); await f.collect();
  await f.settle(0, responseBody({ getReader: () => ({ read: () => read.promise,
    cancel() { cancelCalls++; return cancel.promise; }, releaseLock() { releases++; } }) }));
  abort.abort(); await a.promise; failed(a); await flush();
  assert.equal(cancelCalls, 1); const bytes = f.client.occupancy.residentBytes;
  const replacement = f.check(); await f.collect(); assert.equal(f.calls.length, 1);
  if (cancelFails) cancel.reject(new Error('synthetic cancellation failure')); else cancel.resolve();
  await flush(); assert.equal(releases, 0); assert.equal(f.client.occupancy.activeTransports, 1);
  assert.ok(f.client.occupancy.residentBytes >= bytes); assert.equal(f.calls.length, 1);
  read.resolve({ done: true }); await flush(); assert.equal(releases, 1); assert.equal(f.calls.length, 2);
  await f.settle(1); assert.deepEqual(replacement.value, policy(identity())); f.drained();
});

test('queued cancel never owns a sent key; shortened contexts and timer-delayed expiry never permit replacement work', async () => {
  const f = fixture(), oldContext = f.context();
  const first = f.check(identity(), { context: oldContext }); await f.collect();
  oldContext.restrict(80); f.time.advance(75, false);
  const queuedAbort = new AbortController(), queued = f.check(identity(), { signal: queuedAbort.signal });
  await f.collect(); assert.equal(f.calls.length, 1); queuedAbort.abort(); await queued.promise; failed(queued);
  await first.promise; failed(first); assert.equal(f.client.occupancy.queuedEntries, 0);
  const replacement = f.check(); await f.collect(); assert.equal(f.calls.length, 1);
  await f.settle(0); assert.equal(f.calls.length, 2); await f.settle(1);
  oldContext.dispose(); assert.deepEqual(replacement.value, policy(identity())); f.drained();
});

test('an expired context is unknown even before its abort timer has been delivered', async () => {
  const f = fixture(), context = f.context({ timeoutMs: 100 });
  const old = f.check(identity(), { context }); await f.collect();
  f.time.advance(100, false);
  assert.equal(context.isLive(), false); assert.equal(context.signal.aborted, false); assert.equal(old.settled, false);
  const blocked = f.check();
  const who = identity({ sub: 'other-live-player', accessToken: 'other-live-token' }), other = f.check(who);
  // Deliver the collector while the older expired timer remains undelivered.
  // This exercises the original context clock, not entry.done or an abort stub.
  f.time.fireAtDelay(5); await flush();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].request.entries[0].accessToken, who.accessToken);
  assert.equal(f.client.occupancy.queuedEntries, 1); assert.equal(old.settled, false);
  f.time.advance(0); await old.promise; failed(old);
  await f.settle(1); assert.deepEqual(other.value, policy(who));
  await f.settle(0); assert.equal(f.calls.length, 3); await f.settle(2);
  context.dispose(); assert.deepEqual(blocked.value, policy(identity())); f.drained();
});

test('healthy exact-key parallelism still stops at four transport workers and sixteen refs per envelope', async () => {
  const f = fixture(), checks = [];
  for (let index = 0; index < 4; index++) { checks.push(f.check()); await f.collect(); }
  assert.equal(f.client.occupancy.activeTransports, 4); assert.equal(f.calls.length, 4);
  for (let index = 0; index < 33; index++) checks.push(f.check());
  await f.collect(); assert.equal(f.calls.length, 4); assert.equal(f.client.occupancy.queuedEntries, 33);
  await f.settle(2); assert.equal(f.calls.length, 5); assert.equal(f.calls[4].request.entries.length, 16);
  await f.settle(0); assert.equal(f.calls.length, 6); assert.equal(f.calls[5].request.entries.length, 16);
  await f.settle(1); assert.equal(f.calls.length, 7); assert.equal(f.calls[6].request.entries.length, 1);
  assert.ok(f.calls.every(call => call.request.entries.length <= 16));
  for (const index of [3, 4, 5, 6]) await f.settle(index);
  await Promise.all(checks.map(value => value.promise)); checks.forEach(value => assert.equal(value.error, undefined)); f.drained();
});

test('parallel live entries retain logical, queued, and resident-byte admission limits', async () => {
  for (const limits of [{ logicalWaiters: 2 }, { residentBytes: 540000 }]) {
    const f = fixture({ limits });
    const first = f.check(); await f.collect();
    const second = f.check(); await f.collect();
    // The byte budget can fit one real envelope, but cannot fit a second; a
    // logical budget can fit two envelopes and refuses the third logical ref.
    if (limits.residentBytes) { failed(second); assert.equal(f.calls.length, 1); }
    else assert.equal(f.calls.length, 2);
    const third = f.check(); await flush();
    if (limits.logicalWaiters) failed(third);
    else { await f.collect(); failed(third); }
    assert.ok(f.client.occupancy.residentBytes <= (limits.residentBytes ?? 8 * 1024 * 1024));
    for (let index = 0; index < f.calls.length; index++) await f.settle(index);
    await first.promise; f.drained();
  }
  const f = fixture({ limits: { transports: 1, queuedEntries: 2 } });
  const active = f.check(); await f.collect();
  const queued = [f.check(), f.check()], rejected = f.check(); await rejected.promise; failed(rejected);
  assert.equal(f.client.occupancy.queuedEntries, 2);
  await f.settle(0); await f.collect(); await f.settle(1);
  await Promise.all([active.promise, ...queued.map(value => value.promise)]); f.drained();
});

test('closing several parallel unknown owners rejects all callers and retains each transport until its own settlement', async () => {
  const f = fixture(), checks = [];
  for (let index = 0; index < 3; index++) { checks.push(f.check()); await f.collect(); }
  f.client.close(); await Promise.all(checks.map(value => value.promise)); checks.forEach(value => failed(value));
  assert.equal(f.client.occupancy.activeTransports, 3); assert.equal(f.client.occupancy.tombstones, 3);
  const afterClose = f.check(); await afterClose.promise; failed(afterClose);
  for (const [remaining, index] of [[2, 1], [1, 0], [0, 2]]) {
    await f.settle(index); assert.equal(f.client.occupancy.activeTransports, remaining);
  }
  f.drained();
});

test('wire default and optional notification return identical successful bytes without signaling cleanup', async () => {
  const bytes = Buffer.from('{"synthetic":"bounded"}'); let notified = 0;
  const plain = await readIdentityBatchBody(new Response(bytes, { headers: { 'content-type': 'application/json' } }));
  const hooked = await readIdentityBatchBody(new Response(bytes, { headers: { 'content-type': 'application/json' } }),
    { onCleanup: () => { notified++; } });
  assert.deepEqual(plain, bytes); assert.deepEqual(hooked, plain); assert.equal(notified, 0);
});

for (const thrown of [new Error('synthetic hook failure'), undefined]) test(`cleanup notification failure (${thrown ? 'Error' : 'undefined'}) cannot prevent cancellation or allow output`, async () => {
  const read = deferred(), cancel = deferred(), controller = new AbortController(); let cancelCalls = 0, released = 0;
  const result = observe(readIdentityBatchBody(responseBody({ getReader: () => ({ read: () => read.promise,
    cancel() { cancelCalls++; return cancel.promise; }, releaseLock() { released++; } }) }),
  { signal: controller.signal, onCleanup() { throw thrown; } }));
  controller.abort(); await flush(); assert.equal(cancelCalls, 1); assert.equal(result.settled, false);
  cancel.resolve(); await flush(); assert.equal(result.settled, false); assert.equal(released, 0);
  read.resolve({ done: true }); await result.promise;
  assert.equal(result.settled, true); assert.equal(result.value, undefined); assert.equal(result.error, thrown);
  assert.equal(released, 1);
});

test('bad-header notification runs before body cancel and a throwing notification still waits for actual cleanup', async () => {
  const cancel = deferred(), order = [], failure = new Error('synthetic header notification failure');
  const result = observe(readIdentityBatchBody(responseBody({ cancel() { order.push('cancel'); return cancel.promise; } },
    { 'content-type': 'text/html' }), { onCleanup() { order.push('notify'); throw failure; } }));
  assert.deepEqual(order, ['notify', 'cancel']); assert.equal(result.settled, false);
  cancel.resolve(); await result.promise; assert.equal(result.error, failure); assert.equal(result.value, undefined);
});

test('an asynchronous cleanup notification is rejected without unhandled failure or early real-cancel refund', async () => {
  const cancel = deferred(); let canceled = 0;
  const result = observe(readIdentityBatchBody(responseBody({ cancel() { canceled++; return cancel.promise; } },
    { 'content-type': 'text/html' }), { onCleanup: async () => { throw new Error('synthetic async hook failure'); } }));
  await flush(); assert.equal(canceled, 1); assert.equal(result.settled, false);
  cancel.resolve(); await result.promise;
  assert.ok(result.error instanceof TypeError); assert.match(result.error.message, /synchronous/);
  assert.equal(result.value, undefined);
});
