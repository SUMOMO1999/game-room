import { IdentityFailure } from './auth.mjs';
import { opaqueId, identityKey } from './storage.mjs';

const DAY_MS = 86_400_000;
const REFRESH_MARGIN_MS = 30_000;
const RETRY_MS = 30_000;
const bindingFields = ['entryKey', 'userKey', 'issuer', 'sub', 'clientId', 'authTime', 'csrf', 'createdAt',
  'sessionVersion', 'sessionExpiresAt', 'refreshIssuedAt', 'refreshExpiresAt', 'refreshToken', 'accessToken'];
const sameBinding = (first, second) => bindingFields.every(field => first[field] === second[field]);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value);

// The existing encrypted session owns credentials, the fixed retention limit and
// its CAS lease. The local promise only lets this host's contenders wait safely.
export class SessionRenewal {
  constructor({ store, provider, settings, now, invalidateCurrent }) {
    Object.assign(this, { store, provider, settings, now, invalidateCurrent });
    this.inFlight = new Map();
  }
  persistent(value) { return value?.sessionVersion === 2; }
  cutoff(value) { return Math.min(value.sessionExpiresAt, value.refreshExpiresAt, value.createdAt + this.settings.sessionMaxDays * DAY_MS); }
  valid(value) {
    return value?.phase === 'active' && this.settings.mode === 'cognito'
      && value.issuer === this.settings.issuer && value.clientId === this.settings.clientId
      && value.userKey === identityKey(value.issuer, value.sub)
      && Number.isSafeInteger(value.createdAt) && value.createdAt <= this.now()
      && Number.isSafeInteger(value.refreshIssuedAt) && value.refreshIssuedAt <= value.createdAt
      && Number.isSafeInteger(value.refreshExpiresAt) && value.refreshExpiresAt > value.refreshIssuedAt
      && value.refreshExpiresAt <= value.refreshIssuedAt + 30 * DAY_MS
      && Number.isSafeInteger(value.sessionExpiresAt) && value.sessionExpiresAt > value.createdAt
      && value.sessionExpiresAt <= value.refreshExpiresAt && value.sessionExpiresAt <= value.createdAt + 30 * DAY_MS
      && Number.isFinite(value.expiresAt) && Number.isFinite(value.idleUntil)
      && value.expiresAt <= value.sessionExpiresAt && token(value.refreshToken)
      && typeof value.accessToken === 'string' && value.accessToken.length > 0 && value.accessToken.length <= 16384;
  }
  async ready(id, record, deadline) {
    const value = record.value;
    if (!this.valid(value) || this.cutoff(value) <= this.now()) throw new IdentityFailure();
    if (!this.settings.sessionRefreshEnabled) {
      if (value.expiresAt <= this.now()) throw new IdentityFailure();
      return record;
    }
    if (value.expiresAt > this.now() + REFRESH_MARGIN_MS) return record;
    const pending = this.inFlight.get(id);
    if (pending) { await deadline.wait(pending); return deadline.wait(() => this.store.read('sessions', id)); }
    if (value.refreshLease?.until > this.now() || value.refreshRetryAfter > this.now()) throw new IdentityFailure(503);
    const owner = opaqueId(), until = Math.min(deadline.validUntil, this.cutoff(value));
    const claimed = { ...value, refreshLease: { owner, until }, refreshRetryAfter: this.now() + RETRY_MS };
    const saved = await deadline.wait(() => this.store.guardedCAS('sessions', id, record.version, claimed, this.cutoff(value),
      { scope: 'sessions', id, version: record.version, validUntil: deadline.validUntil }));
    if (!saved) return null;
    const operation = this.exchange(id, claimed, owner, deadline);
    this.inFlight.set(id, operation);
    operation.catch(() => {});
    try { return await deadline.wait(operation); }
    finally { if (this.inFlight.get(id) === operation) this.inFlight.delete(id); }
  }
  async exchange(id, claimed, owner, deadline) {
    try {
      if (typeof this.provider.refresh !== 'function') throw new IdentityFailure(503);
      const renewed = await deadline.wait(() => this.provider.refresh(claimed, { signal: deadline.signal }));
      if (!renewed || ['issuer', 'sub', 'clientId', 'authTime'].some(field => renewed[field] !== claimed[field])
          || typeof renewed.accessToken !== 'string' || !renewed.accessToken || renewed.accessToken.length > 16384
          || !Number.isFinite(renewed.expiresAt) || renewed.expiresAt <= this.now()) throw new IdentityFailure();
      if (renewed.refreshToken !== undefined && !token(renewed.refreshToken)) throw new IdentityFailure(503);
      // Expired access is not presented as a failed refresh credential. Only the
      // fully verified new token is submitted to the original fresh policy path.
      const checked = await deadline.wait(() => this.provider.check(renewed, { signal: deadline.signal,
        context: deadline.triggeredAtMs === undefined ? undefined : deadline }));
      if (!checked || ['issuer', 'sub', 'clientId', 'authTime'].some(field => checked[field] !== claimed[field])
          || !Number.isFinite(checked.expiresAt) || checked.expiresAt <= this.now()) throw new IdentityFailure();
      const current = await deadline.wait(() => this.store.read('sessions', id));
      if (!current || current.value.phase !== 'active' || !sameBinding(current.value, claimed)) throw new IdentityFailure();
      if (current.value.refreshLease?.owner !== owner || current.value.refreshLease.until <= this.now()) throw new IdentityFailure(503);
      const next = { ...current.value, accessToken: renewed.accessToken,
        expiresAt: Math.min(renewed.expiresAt, checked.expiresAt, this.cutoff(claimed)), lastIdentityCheck: this.now(),
        ...(renewed.refreshToken === undefined ? {} : { refreshToken: renewed.refreshToken }) };
      delete next.refreshLease; delete next.refreshRetryAfter;
      if (!await deadline.wait(() => this.store.guardedCAS('sessions', id, current.version, next, this.cutoff(next),
        { scope: 'sessions', id, version: current.version, validUntil: Math.min(deadline.validUntil, claimed.refreshLease.until) }))) throw new IdentityFailure(503);
      const committed = await deadline.wait(() => this.store.read('sessions', id));
      if (!committed || !sameBinding(committed.value, next) || committed.value.expiresAt <= this.now()) throw new IdentityFailure();
      return committed; // SessionService performs another fresh policy/output check after commit.
    } catch (failure) {
      // These cleanup writes retain the original deadline. A cancelled request
      // cannot update a session after logout or extend a credential lease.
      deadline.assert();
      const current = await deadline.wait(() => this.store.read('sessions', id));
      if (current && sameBinding(current.value, claimed) && current.value.refreshLease?.owner === owner) {
        if (failure instanceof IdentityFailure && failure.status === 401) {
          await deadline.wait(() => this.invalidateCurrent(id, current));
        } else {
          const held = { ...current.value }; delete held.refreshLease;
          await deadline.wait(() => this.store.guardedCAS('sessions', id, current.version, held, this.cutoff(held),
            { scope: 'sessions', id, version: current.version, validUntil: deadline.validUntil }));
        }
      }
      throw failure instanceof IdentityFailure ? failure : new IdentityFailure(503);
    }
  }
}
