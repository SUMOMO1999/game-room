import { createHash } from 'node:crypto';
import { IdentityFailure } from './auth.mjs';

export const IDENTITY_POLICY_ENDPOINT = 'https://agora.sumomoli.com/api/identity/check';
export const IDENTITY_POLICY_ISSUER = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_HvamEWPsq';
const FIELDS = ['version', 'revokedBefore', 'issuer', 'sub', 'clientId', 'authTime'];
const DEFAULT_INTERVAL_MS = 250;
const QUEUE_MS = 4000;
const DEADLINE_MS = 8000;
const seconds = value => Number.isSafeInteger(value) && value >= 0;
const subject = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const clientId = value => typeof value === 'string' && /^[a-z0-9]{8,128}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');

// Server-only: callers supply the identity of an access token they have already
// verified. Only overlapping checks share work; a completed check is never cached.
export class IdentityPolicyClient {
  #inflight = new Map();
  #queue = [];
  #lastSent = -Infinity;
  #pumpTimer = null;
  #scheduler;

  constructor({ endpoint = IDENTITY_POLICY_ENDPOINT, fetcher = fetch, now = () => Date.now(), intervalMs = DEFAULT_INTERVAL_MS,
    scheduler = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout } } = {}) {
    if (endpoint !== IDENTITY_POLICY_ENDPOINT || ![125, DEFAULT_INTERVAL_MS].includes(intervalMs)
      || typeof fetcher !== 'function' || typeof now !== 'function'
      || typeof scheduler?.setTimeout !== 'function' || typeof scheduler?.clearTimeout !== 'function') {
      throw new TypeError('Invalid identity policy client configuration');
    }
    this.endpoint = IDENTITY_POLICY_ENDPOINT;
    this.fetcher = fetcher;
    this.now = now;
    this.intervalMs = intervalMs;
    this.#scheduler = { setTimeout: scheduler.setTimeout.bind(scheduler), clearTimeout: scheduler.clearTimeout.bind(scheduler) };
    Object.freeze(this);
  }

  check(identity, { signal } = {}) {
    let expected, current;
    try {
      current = this.now();
      if (!Number.isFinite(current)) throw new IdentityFailure(503);
      if (signal !== undefined && (typeof signal?.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'
        || signal.aborted)) throw new IdentityFailure(503);
      expected = identity && { issuer: identity.issuer, sub: identity.sub, clientId: identity.clientId,
        authTime: identity.authTime, accessToken: identity.accessToken, expiresAt: identity.expiresAt };
      if (!expected || expected.issuer !== IDENTITY_POLICY_ISSUER || !subject(expected.sub) || !clientId(expected.clientId)
        || !seconds(expected.authTime) || expected.authTime > Math.floor(current / 1000)
        || typeof expected.accessToken !== 'string' || !expected.accessToken || expected.accessToken.length > 16384
        || /[\x00-\x20\x7f]/.test(expected.accessToken)
        || expected.expiresAt !== undefined && (!Number.isSafeInteger(expected.expiresAt) || expected.expiresAt <= current)) {
        throw new IdentityFailure(401);
      }
    } catch (error) { return Promise.reject(error instanceof IdentityFailure ? error : new IdentityFailure(503)); }

    // The token never occurs in a cache key, URL, result or error. Expiry is also
    // bound to the snapshot, so differing caller lifetimes cannot borrow a check.
    const key = digest(JSON.stringify([expected.issuer, expected.sub, expected.clientId, expected.authTime,
      expected.expiresAt ?? null, digest(expected.accessToken)]));
    const existing = this.#inflight.get(key);
    if (existing) { this.#watch(existing, signal); return existing.promise; }
    const entry = { key, expected, queuedUntil: current + QUEUE_MS, deadline: current + DEADLINE_MS,
      controller: new AbortController(), external: new Map(), settled: false, totalTimer: null, queueTimer: null };
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    entry.timeout = new Promise((_, reject) => { entry.rejectTimeout = reject; });
    // A queued check can expire before it starts the race; consume that rejection.
    entry.timeout.catch(() => {});
    this.#inflight.set(key, entry);
    this.#watch(entry, signal);
    if (entry.settled) return entry.promise;
    entry.totalTimer = this.#scheduler.setTimeout(() => this.#expire(entry), DEADLINE_MS);
    entry.queueTimer = this.#scheduler.setTimeout(() => this.#expire(entry), QUEUE_MS);
    this.#queue.push(entry);
    this.#pump();
    return entry.promise;
  }

  #watch(entry, signal) {
    if (!signal || entry.external.has(signal) || entry.settled) return;
    // Conservative shared cancellation: any participating caller's outer deadline
    // cancels the one in-flight check, so no caller can outlive that authorization.
    const abort = () => this.#expire(entry);
    entry.external.set(signal, abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) this.#expire(entry);
  }

  #finish(entry, result, error) {
    if (entry.settled) return;
    entry.settled = true;
    this.#scheduler.clearTimeout(entry.totalTimer);
    this.#scheduler.clearTimeout(entry.queueTimer);
    for (const [signal, abort] of entry.external) signal.removeEventListener('abort', abort);
    entry.external.clear();
    if (error) entry.controller.abort();
    // A late transport cannot remove a newer same-key check after timeout.
    if (this.#inflight.get(entry.key)?.promise === entry.promise) this.#inflight.delete(entry.key);
    if (error) entry.reject(error instanceof IdentityFailure ? error : new IdentityFailure(503));
    else entry.resolve(result);
  }

  #expire(entry) {
    if (entry.settled) return;
    const error = new IdentityFailure(503);
    entry.rejectTimeout(error);
    this.#finish(entry, undefined, error);
    this.#pump();
  }

  #pump() {
    this.#scheduler.clearTimeout(this.#pumpTimer);
    this.#pumpTimer = null;
    while (this.#queue.length) {
      const entry = this.#queue[0];
      if (entry.settled) { this.#queue.shift(); continue; }
      const current = this.now();
      if (current >= entry.queuedUntil || current >= entry.deadline) {
        this.#queue.shift(); this.#finish(entry, undefined, new IdentityFailure(503)); continue;
      }
      if (entry.expected.expiresAt !== undefined && entry.expected.expiresAt <= current) {
        this.#queue.shift(); this.#finish(entry, undefined, new IdentityFailure(401)); continue;
      }
      const wait = this.#lastSent + this.intervalMs - current;
      if (wait > 0) {
        this.#pumpTimer = this.#scheduler.setTimeout(() => this.#pump(), wait);
        return;
      }
      this.#queue.shift();
      this.#scheduler.clearTimeout(entry.queueTimer);
      this.#lastSent = current;
      Promise.race([this.#request(entry), entry.timeout]).then(
        result => this.#finish(entry, result), error => this.#finish(entry, undefined, error));
    }
  }

  #assertLive(entry) {
    if (entry.settled || entry.controller.signal.aborted || this.now() >= entry.deadline
      || [...entry.external.keys()].some(signal => signal.aborted)) throw new IdentityFailure(503);
    if (entry.expected.expiresAt !== undefined && entry.expected.expiresAt <= this.now()) throw new IdentityFailure(401);
  }

  async #request(entry) {
    const expected = entry.expected;
    let response;
    try {
      response = await this.fetcher(this.endpoint, { method: 'POST',
        headers: { Authorization: `Bearer ${expected.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: entry.controller.signal });
    } catch { throw new IdentityFailure(503); }
    this.#assertLive(entry);
    if (response?.status === 401) throw new IdentityFailure(401);
    if (response?.status !== 200 || response.ok !== true || response.redirected === true) throw new IdentityFailure(503);
    let policy;
    try { policy = await response.json(); } catch { throw new IdentityFailure(503); }
    this.#assertLive(entry);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(policy, field))
      || policy.version !== 1 || !seconds(policy.revokedBefore) || !seconds(policy.authTime)
      || typeof policy.issuer !== 'string' || !subject(policy.sub) || !clientId(policy.clientId)) throw new IdentityFailure(503);
    if (policy.issuer !== expected.issuer || policy.sub !== expected.sub || policy.clientId !== expected.clientId
      || policy.authTime !== expected.authTime || policy.revokedBefore !== 0 && policy.authTime <= policy.revokedBefore) {
      throw new IdentityFailure(401);
    }
    return Object.freeze(Object.fromEntries(FIELDS.map(field => [field, policy[field]])));
  }
}
