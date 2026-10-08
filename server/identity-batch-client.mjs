import { createHash, createPrivateKey, KeyObject } from 'node:crypto';
import { IdentityFailure } from './auth.mjs';
import { SHARED_ISSUER } from './config.mjs';
import { createIdentityCheckContext } from './identity-check-context.mjs';
import { IDENTITY_BATCH_ENDPOINT, IDENTITY_BATCH_LIMITS, identityBatchRef, identityBatchTokenValid, identityBatchKeyIdValid,
  encodeIdentityBatch, signIdentityBatch, decodeIdentityBatchResponse, readIdentityBatchBody,
  cancelIdentityBatchBody } from './identity-batch-wire.mjs';

const DEFAULT_LIMITS = Object.freeze({ transports: 4, envelopes: 32, queuedEntries: 128,
  logicalWaiters: 256, residentBytes: 8 * 1024 * 1024 });
const COLLECT_WINDOW_MS = 5;
const identityFields = ['issuer', 'sub', 'clientId', 'authTime'];
const digest = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => new IdentityFailure(503);
const schedulerValid = value => typeof value?.setTimeout === 'function' && typeof value?.clearTimeout === 'function';
const validSignal = value => value === undefined || typeof value?.aborted === 'boolean'
  && typeof value.addEventListener === 'function' && typeof value.removeEventListener === 'function';

function validatedIdentity(identity, nowMs) {
  const expected = identity && { issuer: identity.issuer, sub: identity.sub, clientId: identity.clientId,
    authTime: identity.authTime, expiresAt: identity.expiresAt, accessToken: identity.accessToken };
  if (!expected || expected.issuer !== SHARED_ISSUER || typeof expected.sub !== 'string'
    || !/^[\x20-\x7e]{1,128}$/.test(expected.sub) || typeof expected.clientId !== 'string'
    || !/^[a-z0-9]{8,128}$/.test(expected.clientId) || !Number.isSafeInteger(expected.authTime)
    || expected.authTime < 0 || expected.authTime > Math.floor(nowMs / 1000)
    || !identityBatchTokenValid(expected.accessToken) || !Number.isSafeInteger(expected.expiresAt)
    || expected.expiresAt <= nowMs) throw new IdentityFailure(401);
  return Object.freeze(expected);
}

function validateContext(context) {
  if (!context || !['triggeredAtMs', 'queueUntilMs', 'deadlineMs'].every(field => Number.isSafeInteger(context[field]))
    || context.triggeredAtMs < 0 || context.triggeredAtMs > context.queueUntilMs
    || context.queueUntilMs > context.deadlineMs || context.queueUntilMs - context.triggeredAtMs > 4000
    || context.deadlineMs - context.triggeredAtMs > 8000 || !validSignal(context.signal)
    || !context.signal || !['assert', 'remainingMs', 'isLive', 'dispose'].every(field => typeof context[field] === 'function')) {
    throw unavailable();
  }
  context.assert();
}

// A project-scoped collector, not a permissions cache or central admission
// coordinator. Every logical check keeps its own random ref and work unit.
// Duplicate snapshots in one envelope may share unfinished central work; a
// later caller never borrows the success of an already-sent ref.
export class IdentityBatchClient {
  #queued = [];
  #entries = new Set();
  #batches = new Set();
  #keyOwners = new Map();
  #bytes = 0;
  #collectTimer = null;
  #collectDue = false;
  #closed = false;
  #scheduler;

  constructor({ enabled = false, endpoint = IDENTITY_BATCH_ENDPOINT, fetcher, keyId, privateKey,
    now = Date.now, monotonicNow = () => performance.now(), scheduler = { setTimeout, clearTimeout },
    limits = {} } = {}) {
    if (endpoint !== IDENTITY_BATCH_ENDPOINT || typeof enabled !== 'boolean' || typeof now !== 'function'
      || typeof monotonicNow !== 'function' || !schedulerValid(scheduler)) throw new TypeError('Invalid identity batch configuration');
    const resourceLimits = { ...DEFAULT_LIMITS, ...limits };
    if (Object.keys(limits).some(field => !Object.hasOwn(DEFAULT_LIMITS, field))
      || Object.entries(resourceLimits).some(([field, value]) => !Number.isSafeInteger(value)
        || value < 1 || value > DEFAULT_LIMITS[field])) throw new TypeError('Invalid identity batch limits');
    let signingKey;
    if (enabled) {
      if (typeof fetcher !== 'function' || !identityBatchKeyIdValid(keyId)) {
        throw new TypeError('Identity batch requires an explicit caller and transport');
      }
      try { signingKey = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey); }
      catch { throw new TypeError('Invalid identity batch signing key'); }
      if (signingKey.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Invalid identity batch signing key');
    }
    this.enabled = enabled; this.endpoint = IDENTITY_BATCH_ENDPOINT; this.fetcher = fetcher;
    this.keyId = keyId; this.privateKey = signingKey; this.now = now; this.monotonicNow = monotonicNow;
    this.limits = Object.freeze(resourceLimits); this.usesBatchIdentity = true;
    this.#scheduler = { setTimeout: scheduler.setTimeout.bind(scheduler), clearTimeout: scheduler.clearTimeout.bind(scheduler) };
    Object.freeze(this);
  }

  get occupancy() {
    return Object.freeze({ queuedEntries: this.#queued.length, logicalWaiters: this.#entries.size,
      residentEnvelopes: this.#batches.size, activeTransports: this.#batches.size, residentBytes: this.#bytes,
      tombstones: [...this.#entries].filter(entry => entry.done && entry.batch).length });
  }

  check(identity, { signal, context } = {}) {
    let expected, ownedContext = false, current;
    try {
      if (!this.enabled || this.#closed || !validSignal(signal) || signal?.aborted) throw unavailable();
      current = this.now();
      if (!Number.isSafeInteger(current) || current < 0) throw unavailable();
      expected = validatedIdentity(identity, current);
      if (!context) {
        context = createIdentityCheckContext({ now: this.now, monotonicNow: this.monotonicNow,
          signal, scheduler: this.#scheduler });
        ownedContext = true;
      }
      validateContext(context);
      const bytes = expected.accessToken.length * 2 + 4096;
      if (this.#queued.length >= this.limits.queuedEntries || this.#entries.size >= this.limits.logicalWaiters
        || this.#bytes + bytes > this.limits.residentBytes) throw unavailable();
      const key = digest(JSON.stringify([...identityFields.map(field => expected[field]), expected.expiresAt,
        digest(expected.accessToken)]));
      const entry = { ref: identityBatchRef(), expected, key, context, ownedContext, bytes, done: false, batch: null,
        contextElapsedAtEnqueue: context.deadlineMs - context.triggeredAtMs - context.remainingMs(),
        expiryRemainingAtEnqueue: expected.expiresAt - current,
        queueTimer: null, expiryTimer: null, abortListeners: [] };
      const deadlineMs = Math.min(context.deadlineMs, expected.expiresAt);
      entry.wire = Object.freeze({ ref: entry.ref, accessToken: expected.accessToken, triggeredAtMs: context.triggeredAtMs,
        queueUntilMs: Math.min(context.queueUntilMs, deadlineMs), deadlineMs });
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      this.#entries.add(entry); this.#bytes += bytes; this.#queued.push(entry);
      for (const watched of new Set([context.signal, signal].filter(Boolean))) {
        const abort = () => this.#cancel(entry);
        watched.addEventListener('abort', abort, { once: true });
        entry.abortListeners.push([watched, abort]);
      }
      if (context.signal.aborted || signal?.aborted) this.#cancel(entry);
      else {
        const elapsed = context.deadlineMs - context.triggeredAtMs - context.remainingMs();
        const queueRemaining = Math.max(0, entry.wire.queueUntilMs - context.triggeredAtMs - elapsed);
        entry.queueTimer = this.#scheduler.setTimeout(() => this.#cancel(entry), queueRemaining);
        if (entry.expiryRemainingAtEnqueue < context.remainingMs()) {
          entry.expiryTimer = this.#scheduler.setTimeout(() => this.#cancel(entry, 401), entry.expiryRemainingAtEnqueue);
        }
        this.#schedule();
      }
      return entry.promise;
    } catch (error) {
      if (ownedContext) context.dispose();
      return Promise.reject(error instanceof IdentityFailure ? error : unavailable());
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#scheduler.clearTimeout(this.#collectTimer); this.#collectTimer = null;
    for (const entry of this.#entries) this.#cancel(entry);
    for (const batch of this.#batches) batch.controller.abort();
  }

  #assertEntry(entry) {
    if (entry.done) throw unavailable();
    entry.context.assert();
    // restrict() shortens budget and remaining together. Their difference is
    // actual monotonic elapsed time; shrinking a budget is not JWT ageing.
    const contextElapsed = entry.context.deadlineMs - entry.context.triggeredAtMs - entry.context.remainingMs();
    const elapsed = contextElapsed - entry.contextElapsedAtEnqueue;
    if (elapsed >= entry.expiryRemainingAtEnqueue) throw new IdentityFailure(401);
  }

  #currentWire(entry) {
    this.#assertEntry(entry);
    const deadlineMs = Math.min(entry.context.deadlineMs, entry.expected.expiresAt);
    return Object.freeze({ ref: entry.ref, accessToken: entry.expected.accessToken,
      triggeredAtMs: entry.context.triggeredAtMs, queueUntilMs: Math.min(entry.context.queueUntilMs, deadlineMs), deadlineMs });
  }

  #releaseEntry(entry) {
    if (!this.#entries.delete(entry)) return;
    const owners = this.#keyOwners.get(entry.key);
    if (owners) {
      owners.delete(entry);
      if (!owners.size) this.#keyOwners.delete(entry.key);
    }
    this.#bytes -= entry.bytes;
    // Neither tokens nor caller snapshots remain in a cache after settlement.
    entry.expected = null; entry.wire = null;
  }

  #finish(entry, result, error) {
    if (entry.done) return;
    entry.done = true;
    this.#scheduler.clearTimeout(entry.queueTimer); this.#scheduler.clearTimeout(entry.expiryTimer);
    for (const [signal, abort] of entry.abortListeners) signal.removeEventListener('abort', abort);
    entry.abortListeners = [];
    if (entry.ownedContext) entry.context.dispose();
    if (error) entry.reject(error instanceof IdentityFailure ? error : unavailable());
    else entry.resolve(result);
    if (!entry.batch) {
      const index = this.#queued.indexOf(entry);
      if (index >= 0) this.#queued.splice(index, 1);
      this.#releaseEntry(entry);
    }
  }

  #cancel(entry, status = 503) {
    this.#finish(entry, undefined, new IdentityFailure(status));
    if (entry.batch && entry.batch.entries.every(item => item.done)) entry.batch.controller.abort();
    this.#schedule();
  }

  #schedule() {
    if (this.#closed || !this.#queued.length) return;
    if (this.#collectDue) { this.#pump(); return; }
    // Five milliseconds is the maximum collection window. Only a complete
    // batch of presently live, unblocked entries can bypass its remaining wait.
    if (this.#hasReadyFullBatch()) {
      this.#scheduler.clearTimeout(this.#collectTimer); this.#collectTimer = null;
      this.#collectDue = true; this.#pump(); return;
    }
    if (this.#collectTimer !== null) return;
    this.#collectTimer = this.#scheduler.setTimeout(() => {
      this.#collectTimer = null; this.#collectDue = true; this.#pump();
    }, COLLECT_WINDOW_MS);
  }

  #hasReadyFullBatch() {
    if (this.#queued.length < IDENTITY_BATCH_LIMITS.entries || this.#batches.size >= this.limits.transports
      || this.#batches.size >= this.limits.envelopes) return false;
    let ready = 0;
    for (const entry of this.#queued) {
      try {
        if (entry.done || !entry.context.isLive() || this.#keyBlocked(entry.key)) continue;
        const contextElapsed = entry.context.deadlineMs - entry.context.triggeredAtMs - entry.context.remainingMs();
        const elapsed = contextElapsed - entry.contextElapsedAtEnqueue;
        const queueUntilMs = Math.min(entry.context.queueUntilMs, entry.context.deadlineMs, entry.expected.expiresAt);
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= entry.expiryRemainingAtEnqueue
          || queueUntilMs - entry.context.triggeredAtMs - contextElapsed <= 0) continue;
        if (++ready === IDENTITY_BATCH_LIMITS.entries) return true;
      } catch { /* A failed probe cannot make an entry ready; pump owns its fence. */ }
    }
    return false;
  }

  #keyBlocked(key) {
    const owners = this.#keyOwners.get(key);
    if (!owners) return false;
    for (const entry of owners) {
      if (entry.done || entry.batch.cleanup || !entry.context.isLive()) return true;
      const elapsed = entry.context.deadlineMs - entry.context.triggeredAtMs - entry.context.remainingMs()
        - entry.contextElapsedAtEnqueue;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= entry.expiryRemainingAtEnqueue) return true;
    }
    return false;
  }

  #pump() {
    if (this.#closed || !this.#collectDue) return;
    while (this.#batches.size < this.limits.transports && this.#batches.size < this.limits.envelopes) {
      const entries = [];
      for (const entry of [...this.#queued]) {
        try { entry.wire = this.#currentWire(entry); }
        catch (error) { this.#finish(entry, undefined, error); continue; }
        // Healthy checks use independent refs in parallel. Any unknown owner
        // of this exact identity/token key still prevents replacement work.
        if (this.#keyBlocked(entry.key)) continue;
        entries.push(entry);
        if (entries.length === IDENTITY_BATCH_LIMITS.entries) break;
      }
      if (!entries.length) break;
      const batch = { batchRef: identityBatchRef(), entries, controller: new AbortController(), bytes: 0, cleanup: false };
      try {
        // Selection projects current shortened bounds after collection, never
        // the old enqueue-time deadline. Construction failures are batch 503;
        // they cannot turn one failed item into logout for unrelated receivers.
        batch.body = encodeIdentityBatch({ batchRef: batch.batchRef, entries: entries.map(entry => entry.wire) });
        // Reserve raw response, decoded UTF-16 text, parsed policies and fixed
        // reader buffer before acquiring a transport. This is a conservative
        // local budget, not the central provider/admission resource ledger.
        batch.bytes = batch.body.length + IDENTITY_BATCH_LIMITS.responseBytes * 8 + 8192;
        if (this.#bytes + batch.bytes > this.limits.residentBytes) throw unavailable();
      } catch {
        for (const entry of entries) this.#finish(entry, undefined, unavailable());
        continue;
      }
      for (const entry of entries) {
        this.#queued.splice(this.#queued.indexOf(entry), 1);
        entry.batch = batch;
        this.#scheduler.clearTimeout(entry.queueTimer);
        // Sending does not reset the original central queue deadline. Only
        // central pipeline admission can enforce that remaining wire boundary.
        let owners = this.#keyOwners.get(entry.key);
        if (!owners) { owners = new Set(); this.#keyOwners.set(entry.key, owners); }
        owners.add(entry);
      }
      this.#batches.add(batch); this.#bytes += batch.bytes;
      void this.#run(batch);
    }
    if (!this.#queued.length) this.#collectDue = false;
  }

  async #request(batch) {
    for (const entry of batch.entries) {
      try { this.#assertEntry(entry); }
      catch (error) { this.#cancel(entry, error instanceof IdentityFailure ? error.status : 503); }
    }
    const current = this.now(), created = Math.floor(current / 1000);
    if (!Number.isSafeInteger(current) || current < 0 || batch.controller.signal.aborted) throw unavailable();
    const remaining = Math.max(...batch.entries.filter(entry => !entry.done).map(entry => entry.context.remainingMs()));
    if (!Number.isFinite(remaining) || remaining <= 0) throw unavailable();
    const expires = Math.min(created + 10, Math.ceil((current + remaining) / 1000));
    const headers = signIdentityBatch({ body: batch.body, batchRef: batch.batchRef, keyId: this.keyId,
      privateKey: this.privateKey, created, expires });
    let response;
    try {
      response = await this.fetcher(this.endpoint, { method: 'POST', headers, body: batch.body,
        redirect: 'error', credentials: 'omit', cache: 'no-store', signal: batch.controller.signal });
    } catch { throw unavailable(); }
    if (response?.status !== 200 || response?.ok !== true || response?.redirected === true
      || batch.controller.signal.aborted) {
      batch.cleanup = true;
      await cancelIdentityBatchBody(response);
      throw unavailable();
    }
    const body = await readIdentityBatchBody(response, { signal: batch.controller.signal,
      onCleanup: () => { batch.cleanup = true; } });
    if (batch.controller.signal.aborted) throw unavailable();
    // Tombstones remain in the expected set until the entire transport settles.
    return decodeIdentityBatchResponse(body, batch.batchRef, new Set(batch.entries.map(entry => entry.ref)));
  }

  async #run(batch) {
    let result, failure;
    try { result = await this.#request(batch); }
    catch { failure = unavailable(); }
    for (const entry of batch.entries) {
      if (entry.done) continue;
      try {
        this.#assertEntry(entry);
        if (failure) throw failure;
        const item = result.get(entry.ref);
        if (item.status !== 200) throw new IdentityFailure(item.status);
        if (identityFields.some(field => item.policy[field] !== entry.expected[field])
          || item.policy.revokedBefore !== 0 && item.policy.authTime <= item.policy.revokedBefore) throw new IdentityFailure(401);
        this.#finish(entry, item.policy);
      } catch (error) { this.#finish(entry, undefined, error); }
    }
    // This is the actual fetch/body settlement, never the caller's timeout.
    for (const entry of batch.entries) {
      this.#releaseEntry(entry);
    }
    this.#bytes -= batch.bytes; this.#batches.delete(batch);
    batch.body = null; batch.entries = [];
    this.#schedule();
  }
}
