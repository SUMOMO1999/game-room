import { createHash, timingSafeEqual } from 'node:crypto';
import { CognitoProvider, MockProvider, IdentityFailure, withIdentityDeadline } from './auth.mjs';
import { opaqueId, identityKey } from './storage.mjs';
import { entryFor, entryPath, entryReturnTo, recordMatchesEntry, requestContext } from './entry-context.mjs';
import { createIdentityCheckContext, identityCheckContextFor } from './identity-check-context.mjs';
import { OutputGuardConflict, SessionOutputConflict } from './room-output-fence.mjs';
import { SessionRenewal } from './session-renewal.mjs';

export function requestHeader(request, name) {
  const value = request.headers?.get ? request.headers.get(name) : request.headers?.[name.toLowerCase()];
  return typeof value === 'string' ? value : '';
}
export function requestCookie(request, name) {
  const cookies = requestHeader(request, 'cookie').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (cookies.length !== 1) return null;
  const value = cookies[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
const equalSecret = (first, second) => typeof first === 'string' && typeof second === 'string' && Buffer.byteLength(first) === Buffer.byteLength(second) && timingSafeEqual(Buffer.from(first), Buffer.from(second));
const identityFields = (session) => ({ issuer: session.issuer, sub: session.sub, accessToken: session.accessToken,
  authTime: session.authTime, clientId: session.clientId, expiresAt: session.expiresAt });
const authorizationLineage = session => createHash('sha256').update(JSON.stringify(Object.fromEntries(
  Object.keys(session).filter(field => !['idleUntil', 'lastIdentityCheck', 'refreshLease', 'refreshRetryAfter'].includes(field)).sort()
    .map(field => [field, session[field]])))).digest('hex');

function assertOutputSessionRecord(session, record, now) {
  if (!record || record.value.phase !== 'active') throw new IdentityFailure();
  if (record.value.userKey !== session.userKey || record.value.issuer !== session.issuer
    || record.value.sub !== session.sub) throw new IdentityFailure();
  if (record.value.expiresAt <= now || record.value.idleUntil <= now) throw new IdentityFailure();
  if (record.value.sessionVersion === 2 && record.value.sessionExpiresAt <= now) throw new IdentityFailure();
  if (!equalSecret(session.authorizationLineage, authorizationLineage(record.value))) throw new IdentityFailure(503);
  if (record.version !== session.authorizationVersion) throw new SessionOutputConflict();
}

export class SessionService {
  constructor(settings, { store, provider, now = () => Date.now(), authorizationTimeoutMs = 10000 } = {}) {
    if (!store) throw new Error('SessionService requires server-side storage');
    this.settings = settings; this.store = store; this.now = now; this.listeners = new Set();
    if (!Number.isInteger(authorizationTimeoutMs) || authorizationTimeoutMs <= 0 || authorizationTimeoutMs > 10000) throw new TypeError('Invalid identity deadline');
    this.authorizationTimeoutMs = authorizationTimeoutMs;
    this.provider = provider || (settings.mode === 'cognito' ? new CognitoProvider(settings, { now }) : settings.mode === 'mock' ? new MockProvider(settings, { now }) : null);
    this.renewal = new SessionRenewal({ store, provider: this.provider, settings, now,
      invalidateCurrent: (id, record) => this.invalidateCurrent(id, record) });
  }
  get loginReady() { return Boolean(this.provider && ['cognito', 'mock'].includes(this.settings.mode)); }
  get usesBatchIdentity() { return this.provider?.usesBatchIdentity === true; }
  subscribeInvalidation(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(sessionId, session, status) { for (const listener of this.listeners) { try { listener({ sessionId, userKey: session?.userKey, status }); } catch {} } }
  cookie(name, value, seconds, request) {
    const entry = entryFor(request, this.settings);
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}${entry.secureCookies ? '; Secure' : ''}`;
  }
  clearSessionCookie(request) { return this.cookie(entryFor(request, this.settings).cookieName, '', 0, request); }
  clearTransactionCookie(request) { return this.cookie(entryFor(request, this.settings).transactionCookieName, '', 0, request); }
  checkOrigin(request) {
    if (requestHeader(request, 'origin') !== entryFor(request, this.settings).origin) throw new IdentityFailure(403, 'invalid_origin');
  }
  checkWrite(request, session) {
    this.checkOrigin(request);
    if (!session || !equalSecret(requestHeader(request, 'x-csrf-token'), session.csrf)) throw new IdentityFailure(403, 'invalid_csrf');
    return true;
  }
  async invalidate(id, session, status = 401) {
    await this.store.remove('sessions', id);
    this.notify(id, session, status);
  }
  async invalidateCurrent(id, record, status = 401) {
    // A policy/expiry result belongs to the version that was checked. A newer
    // touch may have renewed idle while this authorization waited online.
    if (!await this.store.remove('sessions', id, record.version)) return false;
    this.notify(id, record.value, status);
    return true;
  }
  checkedIdentity(identity, user) {
    if (!user || user.sub !== identity.sub) throw new IdentityFailure();
    if (this.settings.mode !== 'cognito') return identity;
    if (identity.issuer !== this.settings.issuer || user.issuer !== identity.issuer || user.clientId !== this.settings.clientId
        || !Number.isSafeInteger(user.authTime) || user.authTime < 0 || user.authTime > Math.floor(this.now() / 1000)
        || identity.authTime !== undefined && identity.authTime !== user.authTime
        || identity.clientId !== undefined && identity.clientId !== user.clientId
        || !Number.isFinite(user.expiresAt) || user.expiresAt <= this.now()) throw new IdentityFailure();
    return { ...identity, authTime: user.authTime, clientId: user.clientId, expiresAt: Math.min(identity.expiresAt, user.expiresAt) };
  }
  async authorize(request, { fresh = false, touch = true, entryProbe = false, resume = false, expectedIdentity, context, signal } = {}) {
    context ??= identityCheckContextFor(request);
    const ownedContext = this.usesBatchIdentity && !context
      ? createIdentityCheckContext({ timeoutMs: Math.min(8000, this.authorizationTimeoutMs), now: this.now, signal }) : null;
    try { return await withIdentityDeadline((deadline) => this.authorizeWithin(request, { fresh, touch, entryProbe, resume, expectedIdentity }, deadline),
      { timeoutMs: this.authorizationTimeoutMs, now: this.now, signal, context: context || ownedContext }); }
    catch (error) {
      if (error instanceof IdentityFailure && error.status === 503) this.notify(requestCookie(request, entryFor(request, this.settings).cookieName), null, 503);
      throw error;
    }
    finally { ownedContext?.dispose(); }
  }
  async entryStatus(request) {
    // This navigation marker never replaces the persisted game identity key or
    // authorizes a user supplied identity. Only the current entry's session can.
    const session = await this.authorize(request, { fresh: true, touch: false, entryProbe: true });
    return { identityFingerprint: createHash('sha256').update(session.issuer + '\0' + session.sub).digest('hex') };
  }
  async resume(request, url) {
    if (requestHeader(request, 'sec-fetch-site') === 'cross-site') throw new IdentityFailure(403, 'invalid_origin');
    if (requestHeader(request, 'authorization') || [...url.searchParams.keys()].some(key => !['expectedIdentity', 'returnTo'].includes(key))
        || url.searchParams.getAll('expectedIdentity').length !== 1 || url.searchParams.getAll('returnTo').length > 1
        || !/^[a-f0-9]{64}$/.test(url.searchParams.get('expectedIdentity') || '')) throw new IdentityFailure(400, 'invalid_entry_request');
    const entry = entryFor(request, this.settings), returnTo = entryReturnTo(url.searchParams.get('returnTo'), entry);
    let current;
    try {
      const session = await this.authorize(request, { fresh: true, touch: false, entryProbe: true,
        resume: true, expectedIdentity: url.searchParams.get('expectedIdentity') });
      current = { identityFingerprint: createHash('sha256').update(session.issuer + '\0' + session.sub).digest('hex') };
    }
    catch (error) {
      // A cold entry still uses the original OAuth route. Resume itself must not
      // create a transaction, clear cookies, or silently replay a login.
      if (!(error instanceof IdentityFailure) || error.status !== 401) throw error;
      return { status: 303, headers: { 'cache-control': 'no-store', location: entryPath(entry, '/auth/login') + '?returnTo=' + encodeURIComponent(returnTo) }, body: null };
    }
    if (!equalSecret(current.identityFingerprint, url.searchParams.get('expectedIdentity'))) throw new IdentityFailure(409, 'entry_identity_changed');
    return { status: 303, headers: { 'cache-control': 'no-store', location: entryPath(entry, returnTo) }, body: null };
  }
  async authorizeWithin(request, { fresh, touch, entryProbe = false, resume = false, expectedIdentity }, deadline) {
    if (!this.loginReady) throw new IdentityFailure(503, 'login_not_configured');
    const id = requestCookie(request, entryFor(request, this.settings).cookieName);
    if (!id) throw new IdentityFailure();
    for (let attempt = 0; attempt < 6; attempt++) {
      let record = await deadline.wait(() => this.store.read('sessions', id));
      if (!record) { this.notify(id, null, 401); throw new IdentityFailure(); }
      let session = record.value; const now = this.now();
      if (!recordMatchesEntry(session, entryFor(request, this.settings)) || session.phase !== 'active') throw new IdentityFailure();
      const persistent = this.renewal.persistent(session);
      if (persistent) {
        if (!this.renewal.valid(session) || this.renewal.cutoff(session) <= now) {
          if (await deadline.wait(() => this.invalidateCurrent(id, record))) throw new IdentityFailure();
          continue;
        }
        // Dormant credentials can identify an entry, but an existing stream or
        // readonly private request cannot revive its short business window.
        if (session.idleUntil <= now && !touch && !entryProbe) throw new IdentityFailure();
        try { record = await this.renewal.ready(id, record, deadline); }
        catch (error) {
          if (error instanceof IdentityFailure && error.status === 401
              && !await deadline.wait(() => this.invalidateCurrent(id, record))) continue;
          throw error instanceof IdentityFailure ? error : new IdentityFailure(503);
        }
        if (!record) continue;
        session = record.value;
        if (!recordMatchesEntry(session, entryFor(request, this.settings)) || session.phase !== 'active') throw new IdentityFailure();
      } else if (session.expiresAt <= now || session.idleUntil <= now) {
        if (await deadline.wait(() => this.invalidateCurrent(id, record))) throw new IdentityFailure();
        continue;
      }
      const before = { expiresAt: session.expiresAt, authTime: session.authTime, clientId: session.clientId };
      {
        try {
          const user = await deadline.wait(() => this.provider.check(identityFields(session),
            { signal: deadline.signal, context: deadline.triggeredAtMs === undefined ? undefined : deadline }));
          const verified = this.checkedIdentity(identityFields(session), user);
          if (session.userKey !== identityKey(session.issuer, session.sub)) throw new IdentityFailure();
          session.expiresAt = persistent ? Math.min(verified.expiresAt, this.renewal.cutoff(session)) : verified.expiresAt;
          if (this.settings.mode === 'cognito') { session.authTime = verified.authTime; session.clientId = verified.clientId; }
        } catch (error) {
          const status = error instanceof IdentityFailure && error.status === 401 ? 401 : 503;
          if (status === 401 && !await deadline.wait(() => this.invalidateCurrent(id, record))) continue;
          throw new IdentityFailure(status);
        }
        // The online call may complete after either expiry or a concurrent logout.
        if (session.expiresAt <= this.now() || !persistent && session.idleUntil <= this.now()) {
          if (await deadline.wait(() => this.invalidateCurrent(id, record))) throw new IdentityFailure();
          continue;
        }
        session.lastIdentityCheck = this.now();
      }
      if (expectedIdentity !== undefined && !equalSecret(expectedIdentity,
        createHash('sha256').update(session.issuer + '\0' + session.sub).digest('hex'))) throw new IdentityFailure(409, 'entry_identity_changed');
      session.idleUntil = Math.min(session.expiresAt, session.idleUntil);
      const upgrade = session.expiresAt !== before.expiresAt || session.authTime !== before.authTime || session.clientId !== before.clientId;
      // Frequent drawing/guess requests still perform a fresh online check.
      // Only idle-renewal writes are coalesced, avoiding unrelated session CAS
      // changes forcing every recipient to redo an in-flight policy check.
      const touchWindow = Math.min(30000, this.settings.idleMs / 10);
      const renewIdle = (touch || persistent && resume) && (!this.usesBatchIdentity
        || Math.min(session.expiresAt, this.now() + this.settings.idleMs) - session.idleUntil >= touchWindow);
      if (!renewIdle && !upgrade) {
        // Read-only output/watchdog checks do not contend on an otherwise unchanged session.
        const current = await deadline.wait(() => this.store.read('sessions', id));
        if (!current) { this.notify(id, session, 401); throw new IdentityFailure(); }
        if (current.version !== record.version) continue; // A changed session must acquire a new policy check.
        deadline.assert();
        if (session.expiresAt <= this.now() || session.idleUntil <= this.now() && !(persistent && entryProbe)) {
          // The fresh check can cross the short idle deadline. Stop this output
          // without deleting the longer retained credential needed for resume.
          if (persistent && session.expiresAt > this.now() && this.renewal.cutoff(session) > this.now()) throw new IdentityFailure();
          if (await deadline.wait(() => this.invalidateCurrent(id, record))) throw new IdentityFailure();
          continue;
        }
        return this.publicSession(id, session, record.version);
      }
      if (renewIdle) session.idleUntil = Math.min(session.expiresAt, this.now() + this.settings.idleMs);
      if (await deadline.wait(() => this.writeSession(id, record, session, deadline))) {
        // The successful CAS has a new version. Re-read on a late expiry instead
        // of deleting a concurrently renewed record with this older snapshot.
        if (session.expiresAt <= this.now() || session.idleUntil <= this.now()) continue;
        if (this.usesBatchIdentity || persistent) {
          const saved = await deadline.wait(() => this.store.read('sessions', id));
          if (!saved) throw new IdentityFailure();
          // A post-CAS read supplies the version for this one output's final
          // fence. Any concurrent modification requires another fresh check.
          if (JSON.stringify(saved.value) !== JSON.stringify(session)) continue;
          return this.publicSession(id, session, saved.version);
        }
        return this.publicSession(id, session);
      }
      // CAS failure never authorizes a stale result: reread the live record and recheck online.
      fresh = true;
    }
    throw new IdentityFailure(503);
  }
  publicSession(id, session, version) {
    const value = { id, userKey: session.userKey, csrf: session.csrf, issuer: session.issuer, sub: session.sub,
      expiresAt: session.expiresAt, idleUntil: session.idleUntil, lastIdentityCheck: session.lastIdentityCheck };
    if (version !== undefined) Object.defineProperties(value, {
      authorizationVersion: { value: version },
      authorizationLineage: { value: authorizationLineage(session) },
    });
    return value;
  }
  async assertCurrent(session, { context, guards = [] } = {}) {
    context?.assert();
    const read = () => this.store.read('sessions', session.id);
    const record = context ? await context.wait(read) : await read();
    assertOutputSessionRecord(session, record, this.now());
    const verify = () => this.store.verifyGuards({ guards: [
      { scope: 'sessions', id: session.id, expectedVersion: session.authorizationVersion }, ...guards,
    ], validUntil: Math.min(context?.validUntil ?? Number.MAX_SAFE_INTEGER, record.value.expiresAt, record.value.idleUntil) });
    const valid = context ? await context.wait(verify) : await verify();
    if (valid === false) {
      // The initial session SELECT is outside the atomic multi-owner check.
      // Classify a completed rejection against a new readonly session snapshot:
      // a benign renewal needs fresh identity, not a wasted room-only retry.
      // This read never grants output or creates another recovery budget.
      const current = context ? await context.wait(read) : await read();
      assertOutputSessionRecord(session, current, this.now());
      throw new OutputGuardConflict();
    }
    if (valid !== true) throw new IdentityFailure(503);
    context?.assert();
  }
  async writeSession(id, record, value, deadline) {
    deadline.assert();
    const expiresAt = this.renewal.persistent(value) ? this.renewal.cutoff(value)
      : Math.min(value.expiresAt ?? record.expiresAt, value.idleUntil ?? record.expiresAt);
    if (this.store.guardedCAS) return this.store.guardedCAS('sessions', id, record.version, value, expiresAt,
      { scope: 'sessions', id, version: record.version, validUntil: deadline.validUntil });
    if (this.settings.mode === 'cognito') throw new IdentityFailure(503);
    return this.store.replaceCAS('sessions', id, record.version, value, expiresAt);
  }
  async state(request) {
    const common = { mode: this.settings.mode, loginReady: this.loginReady };
    if (!requestCookie(request, entryFor(request, this.settings).cookieName)) return { ...common, authenticated: false };
    try {
      const session = await this.authorize(request);
      return { ...common, authenticated: true, userKey: session.userKey, csrf: session.csrf, expiresAt: session.expiresAt, idleUntil: session.idleUntil };
    } catch (error) {
      if (error.status === 401) return { ...common, authenticated: false };
      throw error;
    }
  }
  async cancelTransaction(id, entry) {
    // Keep the cancellation marker until expiry: deleting an in-flight transaction would lose its logout fence.
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await this.store.read('transactions', id);
      if (!record) return;
      const transaction = record.value;
      if (entry && !recordMatchesEntry(transaction, entry)) throw new IdentityFailure(401, 'invalid_entry');
      if (transaction.phase !== 'cancelled') {
        transaction.phase = 'cancelled';
        if (!await this.store.replaceCAS('transactions', id, record.version, transaction, record.expiresAt)) continue;
      }
      if (transaction.candidateSessionId) await this.invalidate(transaction.candidateSessionId, null);
      return;
    }
    throw new IdentityFailure(503);
  }
  async begin(request, url) {
    if (!this.loginReady) throw new IdentityFailure(503, 'login_not_configured');
    const previous = requestCookie(request, entryFor(request, this.settings).transactionCookieName);
    if (previous) await this.cancelTransaction(previous, entryFor(request, this.settings));
    const returnTo = entryReturnTo(url.searchParams.getAll('returnTo').length === 1 ? url.searchParams.get('returnTo') : '/', entryFor(request, this.settings));
    const entry = entryFor(request, this.settings), currentId = requestCookie(request, entry.cookieName);
    const current = currentId ? await this.store.get('sessions', currentId) : null;
    const identityAnchor = current && recordMatchesEntry(current, entry) && current.phase === 'active'
      && (this.renewal.persistent(current) ? this.renewal.valid(current) && this.renewal.cutoff(current) > this.now()
        : current.expiresAt > this.now() && current.idleUntil > this.now())
      && current.userKey === identityKey(current.issuer, current.sub)
      ? { userKey: current.userKey, issuer: current.issuer, sub: current.sub } : null;
    const { url: location, transaction } = await this.provider.begin(returnTo, { entry: entryFor(request, this.settings) });
    const id = opaqueId(); const expiresAt = this.now() + this.settings.transactionMs;
    if (!await this.store.putIfAbsent('transactions', id, { ...transaction, identityAnchor, entryKey: entryFor(request, this.settings).key, phase: 'pending', returnTo, createdAt: this.now(), expiresAt }, expiresAt)) throw new IdentityFailure(503);
    return { status: 303, headers: { location: String(location), 'set-cookie': [this.cookie(entryFor(request, this.settings).transactionCookieName, id, this.settings.transactionMs / 1000, request)], 'cache-control': 'no-store' }, body: null };
  }
  async callback(request, url) {
    const confirmed = {};
    try { return await withIdentityDeadline((deadline) => this.callbackWithin(request, url, deadline, confirmed), { timeoutMs: this.authorizationTimeoutMs, now: this.now }); }
    catch (error) { if (confirmed.returnTo) error.returnTo = confirmed.returnTo; throw error; }
  }
  async assertAccountContinuation(request, userKey, deadline, transaction) {
    // An existing current-entry login has priority. Joining another URL must
    // not silently select a different identity; switching requires project logout.
    // The transaction keeps its begin-time identity through same-account cookie
    // rotation or expiry; a new begin after expiry may select a new account.
    const anchor = transaction?.identityAnchor;
    if (anchor && (anchor.userKey !== identityKey(anchor.issuer, anchor.sub) || anchor.userKey !== userKey)) throw new IdentityFailure(409, 'account_switch_requires_logout');
    const entry = entryFor(request, this.settings), id = requestCookie(request, entry.cookieName);
    if (!id) return;
    const current = await deadline.wait(() => this.store.get('sessions', id));
    if (current && recordMatchesEntry(current, entry) && current.phase === 'active'
        && (this.renewal.persistent(current) ? this.renewal.valid(current) && this.renewal.cutoff(current) > this.now()
          : current.expiresAt > this.now() && current.idleUntil > this.now())
        && current.userKey !== userKey) throw new IdentityFailure(409, 'account_switch_requires_logout');
  }
  async callbackWithin(request, url, deadline, confirmed) {
    const headers = { 'cache-control': 'no-store', 'set-cookie': [this.clearTransactionCookie(request)] };
    const transactionId = requestCookie(request, entryFor(request, this.settings).transactionCookieName);
    const record = transactionId ? await deadline.wait(() => this.store.read('transactions', transactionId)) : null;
    if (!this.loginReady || !record || !recordMatchesEntry(record.value, entryFor(request, this.settings)) || record.value.phase !== 'pending') throw new IdentityFailure(401, 'invalid_callback');
    const transaction = record.value; const id = opaqueId();
    let session, confirmedReturnTo;
    // Reserve before publishing its ID to the transaction. A cancelled/deleted candidate is never recreated.
    if (!await deadline.wait(() => this.store.putIfAbsent('sessions', id, { phase: 'pending', entryKey: entryFor(request, this.settings).key, transactionId }, record.expiresAt))) throw new IdentityFailure(503);
    try {
      const candidate = await deadline.wait(() => this.store.read('sessions', id));
      transaction.phase = 'verifying'; transaction.candidateSessionId = id;
      // Claiming is one-use CAS, but the record remains cancellable while external verification is in flight.
      if (!candidate || !await deadline.wait(() => this.store.replaceCAS('transactions', transactionId, record.version, transaction, record.expiresAt))) throw new IdentityFailure(401, 'invalid_callback');
      const claimed = await deadline.wait(() => this.store.read('transactions', transactionId));
      if (!claimed || claimed.value.phase !== 'verifying' || claimed.value.candidateSessionId !== id || url.origin !== entryFor(request, this.settings).origin || url.pathname !== entryPath(entryFor(request, this.settings), '/auth/callback') || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error') || !equalSecret(url.searchParams.get('state'), transaction.state)) throw new IdentityFailure(401, 'invalid_callback');
      confirmedReturnTo = entryReturnTo(transaction.returnTo, entryFor(request, this.settings));
      confirmed.returnTo = confirmedReturnTo;
      let identity = await deadline.wait(() => this.provider.complete(url, transaction, { signal: deadline.signal }));
      if (transaction.expiresAt <= this.now()) throw new IdentityFailure(401, 'invalid_callback');
      if (typeof identity.issuer !== 'string' || !identity.issuer || typeof identity.sub !== 'string' || !identity.sub || !Number.isFinite(identity.expiresAt) || identity.expiresAt <= this.now() || typeof identity.accessToken !== 'string' || !identity.accessToken) throw new IdentityFailure();
      // Even injected providers must prove callback validity online before a local session is issued.
      const user = await deadline.wait(() => this.provider.check(identity, { signal: deadline.signal }));
      identity = this.checkedIdentity(identity, user);
      if (transaction.expiresAt <= this.now()) throw new IdentityFailure(401, 'invalid_callback');
      if (identity.expiresAt <= this.now() || (this.settings.mode === 'cognito' && identity.issuer !== this.settings.issuer)) throw new IdentityFailure();
      const verifiedUserKey = identityKey(identity.issuer, identity.sub);
      await this.assertAccountContinuation(request, verifiedUserKey, deadline, transaction);
      const now = this.now();
      const persistent = this.settings.sessionRefreshEnabled && this.settings.mode === 'cognito';
      const sessionExpiresAt = persistent ? Math.min(identity.refreshExpiresAt, now + this.settings.sessionMaxDays * 86_400_000) : null;
      if (persistent && (!Number.isSafeInteger(identity.refreshIssuedAt) || identity.refreshIssuedAt > now
          || !Number.isSafeInteger(sessionExpiresAt) || sessionExpiresAt <= now
          || typeof identity.refreshToken !== 'string' || !identity.refreshToken || identity.refreshToken.length > 8192)) throw new IdentityFailure(503);
      const expiresAt = Math.min(identity.expiresAt, persistent ? sessionExpiresAt : now + this.settings.absoluteMs);
      const idleUntil = Math.min(expiresAt, now + this.settings.idleMs);
      session = { phase: 'active', entryKey: entryFor(request, this.settings).key, userKey: verifiedUserKey, issuer: identity.issuer, sub: identity.sub, accessToken: identity.accessToken,
        ...(this.settings.mode === 'cognito' ? { authTime: identity.authTime, clientId: identity.clientId } : {}),
        ...(persistent ? { sessionVersion: 2, sessionExpiresAt, refreshIssuedAt: identity.refreshIssuedAt,
          refreshExpiresAt: identity.refreshExpiresAt, refreshToken: identity.refreshToken } : {}),
        csrf: opaqueId(), createdAt: now, expiresAt, idleUntil, lastIdentityCheck: now };
      if (persistent && !this.renewal.valid(session)) throw new IdentityFailure(503);
      const final = { ...claimed.value, phase: 'completed' };
      if (!await deadline.wait(() => this.store.replaceCAS('transactions', transactionId, claimed.version, final, claimed.expiresAt))) throw new IdentityFailure(401, 'invalid_callback');
      // Logout and activation compete on this same reserved record. CAS cannot reinsert a deleted candidate.
      await this.assertAccountContinuation(request, verifiedUserKey, deadline, transaction);
      if (!await deadline.wait(() => this.writeSession(id, candidate, session, deadline))) throw new IdentityFailure(401, 'invalid_callback');
      const oldId = requestCookie(request, entryFor(request, this.settings).cookieName);
      if (oldId) { const old = await deadline.wait(() => this.store.get('sessions', oldId)); if (old && recordMatchesEntry(old, entryFor(request, this.settings))) await deadline.wait(() => this.invalidate(oldId, old)); }
      const activeTransaction = await deadline.wait(() => this.store.read('transactions', transactionId));
      const activeSession = await deadline.wait(() => this.store.get('sessions', id));
      if (!activeTransaction || activeTransaction.value.phase !== 'completed' || activeTransaction.value.candidateSessionId !== id || !activeSession || !recordMatchesEntry(activeSession, entryFor(request, this.settings)) || transaction.expiresAt <= this.now() || identity.expiresAt <= this.now()) throw new IdentityFailure(401, 'invalid_callback');
      headers['set-cookie'].push(this.cookie(entryFor(request, this.settings).cookieName, id, ((persistent ? sessionExpiresAt : expiresAt) - now) / 1000, request));
      headers.location = entryPath(entryFor(request, this.settings), entryReturnTo(transaction.returnTo, entryFor(request, this.settings)));
      return { status: 303, headers, body: null };
    } catch (error) { await this.invalidate(id, session); if (confirmedReturnTo) error.returnTo = confirmedReturnTo; throw error; }
  }
  async logout(request) {
    this.checkOrigin(request);
    const id = requestCookie(request, entryFor(request, this.settings).cookieName);
    const session = id ? await this.store.get('sessions', id) : null;
    if (session && !recordMatchesEntry(session, entryFor(request, this.settings))) throw new IdentityFailure(401, 'invalid_entry');
    if (session) this.checkWrite(request, session);
    // Project logout succeeds even if the external identity service is unavailable.
    if (id) await this.invalidate(id, session);
    const transactionId = requestCookie(request, entryFor(request, this.settings).transactionCookieName);
    if (transactionId) await this.cancelTransaction(transactionId, entryFor(request, this.settings));
    return { status: 200, headers: { 'set-cookie': [this.clearSessionCookie(request), this.clearTransactionCookie(request)], 'cache-control': 'no-store' }, body: { ok: true, loggedOut: true, returnTo: entryFor(request, this.settings).basePath, postLogoutUri: entryFor(request, this.settings).basePath } };
  }
  async route(request) {
    const url = new URL(request.url, entryFor(request, this.settings).origin); const method = request.method || 'GET';
    const routePath = requestContext(request)?.logicalPath || url.pathname;
    if (!['/auth/login', '/auth/callback', '/auth/logout', '/auth/resume'].includes(routePath)) return null;
    try {
      if (routePath === '/auth/login' && method === 'GET') return await this.begin(request, url);
      if (routePath === '/auth/callback' && method === 'GET') return await this.callback(request, url);
      if (routePath === '/auth/logout' && method === 'POST') return await this.logout(request);
      if (routePath === '/auth/resume' && method === 'GET') return await this.resume(request, url);
      return { status: 405, headers: { allow: routePath === '/auth/logout' ? 'POST' : 'GET', 'cache-control': 'no-store' }, body: { error: 'method_not_allowed' } };
    } catch (error) {
      const status = error instanceof IdentityFailure ? error.status : 503;
      const headers = { 'cache-control': 'no-store' };
      if (routePath === '/auth/callback') headers['set-cookie'] = [this.clearTransactionCookie(request)];
      // A failed old request cannot know whether the browser already received
      // a newer session Cookie. Only explicit logout clears that Cookie.
      if (status === 401 && routePath !== '/auth/callback') headers['set-cookie'] = [this.clearTransactionCookie(request)];
      return { status, headers, body: { error: error instanceof IdentityFailure ? error.code : 'identity_unavailable',
        ...(routePath === '/auth/callback' && error.returnTo ? { returnTo: entryReturnTo(error.returnTo, entryFor(request, this.settings)) } : {}) } };
    }
  }
}
