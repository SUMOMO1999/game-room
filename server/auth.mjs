import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { opaqueId } from './storage.mjs';
import { IdentityPolicyClient } from './identity-policy-client.mjs';
import { SHARED_ISSUER } from './config.mjs';
import { createIdentityCheckContext } from './identity-check-context.mjs';

const validSubject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const validSeconds = (value) => Number.isSafeInteger(value) && value >= 0;
const validRefreshToken = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value);

export class IdentityFailure extends Error {
  constructor(status = 401, code = status === 503 ? 'identity_unavailable' : 'login_required') { super(code); this.status = status; this.code = code; }
}

// One deadline covers every await and retry. A late external response cannot continue an authorization.
export async function withIdentityDeadline(task, { timeoutMs = 10000, signal: parentSignal, now = Date.now, context } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000) throw new TypeError('Invalid identity deadline');
  if (context) {
    if (typeof context.assert !== 'function' || typeof context.wait !== 'function'
      || typeof context.restrict !== 'function' || !context.signal || parentSignal?.aborted) throw new IdentityFailure(503);
    // The caller owns this context. Nested JWT/policy checks cannot dispose it
    // or reset its original collection, queue and total deadlines.
    context.restrict(timeoutMs);
    return context.wait(() => task(context));
  }
  const controller = new AbortController(), signal = controller.signal;
  const validUntil = now() + timeoutMs;
  const started = performance.now();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let rejectDeadline;
  const expired = new Promise((_, reject) => { rejectDeadline = reject; });
  expired.catch(() => {}); // An already-cancelled parent can reject before the first race is attached.
  const onAbort = () => rejectDeadline(new IdentityFailure(503));
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const assert = () => { if (signal.aborted || performance.now() - started >= timeoutMs) { abort(); throw new IdentityFailure(503); } };
  const wait = (operation) => {
    assert();
    return Promise.race([typeof operation === 'function' ? operation() : operation, expired]).then((value) => { assert(); return value; });
  };
  try { assert(); return await wait(Promise.resolve().then(() => task({ signal, assert, wait, validUntil }))); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); parentSignal?.removeEventListener('abort', abort); }
}

export class CognitoProvider {
  constructor(settings, { config, jwks, fetcher = fetch, now = () => Date.now(), policyClient, checkTimeoutMs = 10000 } = {}) {
    if (settings.issuer !== SHARED_ISSUER) throw new TypeError('Unexpected shared identity issuer');
    if (!Number.isInteger(checkTimeoutMs) || checkTimeoutMs <= 0 || checkTimeoutMs > 10000) throw new TypeError('Invalid identity deadline');
    this.settings = settings; this.now = now;
    this.config = config || new oidc.Configuration({ issuer: settings.issuer, authorization_endpoint: `${settings.authDomain}/oauth2/authorize`, token_endpoint: `${settings.authDomain}/oauth2/token`, userinfo_endpoint: `${settings.authDomain}/oauth2/userInfo`, jwks_uri: `${settings.issuer}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'] }, settings.clientId, { id_token_signed_response_alg: 'RS256' }, oidc.None());
    const keyResolver = jwks || createRemoteJWKSet(new URL(`${settings.issuer}/.well-known/jwks.json`), { timeoutDuration: 8000, cooldownDuration: 30000 });
    // Errors while acquiring/parsing keys are availability failures, not proof that this account is invalid.
    this.jwks = typeof keyResolver === 'function' ? async (...args) => {
      try { return await keyResolver(...args); }
      catch (error) {
        if (['ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'].includes(error.code)) throw error;
        throw new IdentityFailure(503);
      }
    } : keyResolver;
    this.fetcher = fetcher; this.config.timeout = 8;
    this.policyClient = policyClient || new IdentityPolicyClient({ fetcher, now, intervalMs: settings.identityCheckIntervalMs });
    this.checkTimeoutMs = checkTimeoutMs;
  }
  get usesBatchIdentity() { return this.policyClient.usesBatchIdentity === true; }
  async begin(returnTo, { entry } = {}) {
    const codeVerifier = oidc.randomPKCECodeVerifier(); const state = oidc.randomState(); const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(this.config, { redirect_uri: entry?.callback || this.settings.callback, scope: 'openid', response_type: 'code', code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: 'S256', state, nonce });
    return { url, transaction: { codeVerifier, state, nonce, returnTo } };
  }
  async verifyTokens(tokens, nonce, { signal } = {}) {
    return withIdentityDeadline(async (deadline) => {
      try {
        if (typeof tokens.id_token !== 'string' || !tokens.id_token || typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer') throw new IdentityFailure();
        const options = { issuer: this.settings.issuer, algorithms: ['RS256'], currentDate: new Date(this.now()) };
        const { payload: id } = await deadline.wait(jwtVerify(tokens.id_token, this.jwks, { ...options, audience: this.settings.clientId, requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'token_use'] }));
        const access = await deadline.wait(this.verifyAccess(tokens.access_token, { signal: deadline.signal }));
        const currentSeconds = Math.floor(this.now() / 1000);
        if (!validSeconds(id.exp) || !validSeconds(id.iat) || id.iat > currentSeconds + 60 || id.exp <= id.iat || id.exp <= currentSeconds) throw new IdentityFailure();
        if (id.aud !== this.settings.clientId || id.token_use !== 'id' || id.sub !== access.sub || id.nonce !== nonce || !validSubject(id.sub)) throw new IdentityFailure();
        return { ...access, expiresAt: Math.min(id.exp * 1000, access.expiresAt) };
      } catch (error) {
        if (error instanceof IdentityFailure) throw error;
        if (error.code === 'ERR_JWKS_TIMEOUT' || error instanceof TypeError) throw new IdentityFailure(503);
        throw new IdentityFailure();
      }
    }, { timeoutMs: this.checkTimeoutMs, signal });
  }
  async verifyAccess(accessToken, { signal, context } = {}) {
    return withIdentityDeadline(async (deadline) => {
      try {
        if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 16384 || /[\x00-\x20\x7f]/.test(accessToken)) throw new IdentityFailure();
        const { payload } = await deadline.wait(jwtVerify(accessToken, this.jwks, { issuer: this.settings.issuer, algorithms: ['RS256'],
          currentDate: new Date(this.now()), requiredClaims: ['exp', 'iat', 'sub', 'client_id', 'token_use', 'auth_time'] }));
        const currentSeconds = Math.floor(this.now() / 1000);
        if (!validSeconds(payload.exp) || payload.exp > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
            || !validSeconds(payload.iat) || payload.iat > currentSeconds + 60 || payload.exp <= payload.iat || payload.exp <= currentSeconds
            || !validSeconds(payload.auth_time) || payload.auth_time > currentSeconds || payload.auth_time > payload.iat
            || !validSubject(payload.sub) || payload.token_use !== 'access' || payload.client_id !== this.settings.clientId
            || typeof payload.scope !== 'string' || !payload.scope.split(' ').includes('openid')) throw new IdentityFailure();
        return { issuer: payload.iss, sub: payload.sub, clientId: payload.client_id, authTime: payload.auth_time,
          accessToken, expiresAt: payload.exp * 1000 };
      } catch (error) {
        if (error instanceof IdentityFailure) throw error;
        if (error.code === 'ERR_JWKS_TIMEOUT' || error instanceof TypeError) throw new IdentityFailure(503);
        throw new IdentityFailure();
      }
    }, { timeoutMs: this.checkTimeoutMs, signal, context });
  }
  async complete(url, transaction, { signal } = {}) {
    return withIdentityDeadline(async (deadline) => {
      const refreshIssuedAt = this.now();
      let tokens;
      try { tokens = await deadline.wait(oidc.authorizationCodeGrant(this.config, url, { pkceCodeVerifier: transaction.codeVerifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true })); }
      catch (error) {
        if (error instanceof IdentityFailure) throw error;
        const unavailable = error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name) || ['OAUTH_TIMEOUT', 'OAUTH_ABORT', 'OAUTH_RESPONSE_IS_NOT_CONFORM', 'OAUTH_RESPONSE_IS_NOT_JSON', 'OAUTH_PARSE_ERROR'].includes(error.code) || error.status >= 429;
        throw new IdentityFailure(unavailable ? 503 : 401);
      }
      const identity = await deadline.wait(this.verifyTokens(tokens, transaction.nonce, { signal: deadline.signal }));
      if (!this.settings.sessionRefreshEnabled) return identity;
      if (!validRefreshToken(tokens.refresh_token)) throw new IdentityFailure(503);
      return { ...identity, refreshToken: tokens.refresh_token, refreshIssuedAt,
        refreshExpiresAt: refreshIssuedAt + this.settings.sessionMaxDays * 86_400_000 };
    }, { timeoutMs: this.checkTimeoutMs, signal });
  }
  async refresh(session, { signal, context } = {}) {
    if (session?.issuer !== this.settings.issuer || session.clientId !== this.settings.clientId
        || !validSubject(session.sub) || !validRefreshToken(session.refreshToken)) throw new IdentityFailure();
    return withIdentityDeadline(async deadline => {
      let tokens;
      const config = new oidc.Configuration(this.config.serverMetadata(), this.settings.clientId, this.config.clientMetadata(), oidc.None());
      config.timeout = this.config.timeout;
      const fetcher = this.config[oidc.customFetch] || this.fetcher;
      config[oidc.customFetch] = (url, options) => fetcher(url, { ...options, redirect: 'error',
        signal: options?.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal });
      try { tokens = await deadline.wait(oidc.refreshTokenGrant(config, session.refreshToken)); }
      catch (error) {
        if (error instanceof IdentityFailure) throw error;
        const rejected = error.error === 'invalid_grant' && error.status === 400
          || error.code === 'OAUTH_JWT_CLAIM_COMPARISON_FAILED';
        throw new IdentityFailure(rejected ? 401 : 503);
      }
      if (typeof tokens.id_token !== 'string' || !tokens.id_token || typeof tokens.access_token !== 'string'
          || tokens.token_type?.toLowerCase() !== 'bearer') throw new IdentityFailure(503);
      let id;
      try { ({ payload: id } = await deadline.wait(jwtVerify(tokens.id_token, this.jwks, {
        issuer: this.settings.issuer, audience: this.settings.clientId, algorithms: ['RS256'],
        currentDate: new Date(this.now()), requiredClaims: ['exp', 'iat', 'sub', 'auth_time', 'token_use'],
      }))); }
      catch (error) {
        if (error instanceof IdentityFailure) throw error;
        if (error.code === 'ERR_JWKS_TIMEOUT' || error instanceof TypeError) throw new IdentityFailure(503);
        throw new IdentityFailure();
      }
      const access = await deadline.wait(this.verifyAccess(tokens.access_token, { signal: deadline.signal }));
      const seconds = Math.floor(this.now() / 1000);
      if (!validSeconds(id.exp) || !validSeconds(id.iat) || id.iat > seconds + 60 || id.exp <= id.iat
          || id.exp <= seconds || id.exp > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
          || id.token_use !== 'id' || id.sub !== session.sub || access.sub !== session.sub
          || id.auth_time !== session.authTime || access.authTime !== session.authTime) throw new IdentityFailure();
      if (tokens.refresh_token !== undefined && !validRefreshToken(tokens.refresh_token)) throw new IdentityFailure(503);
      return { ...access, authTime: session.authTime, expiresAt: Math.min(id.exp * 1000, access.expiresAt),
        ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }) };
    }, { timeoutMs: this.checkTimeoutMs, signal, context });
  }
  async check(identity, { signal, context } = {}) {
    const ownedContext = this.usesBatchIdentity && !context
      ? createIdentityCheckContext({ timeoutMs: Math.min(8000, this.checkTimeoutMs), now: this.now, signal }) : null;
    try { return await withIdentityDeadline(async (deadline) => {
      const expected = identity && { issuer: identity.issuer, sub: identity.sub, accessToken: identity.accessToken,
        authTime: identity.authTime, clientId: identity.clientId, expiresAt: identity.expiresAt };
      if (!expected || expected.issuer !== this.settings.issuer || !validSubject(expected.sub)) throw new IdentityFailure();
      const verified = await deadline.wait(() => this.verifyAccess(expected.accessToken,
        { signal: deadline.signal, context: context || ownedContext }));
      if (verified.issuer !== expected.issuer || verified.sub !== expected.sub
          || expected.authTime !== undefined && expected.authTime !== verified.authTime
          || expected.clientId !== undefined && expected.clientId !== verified.clientId
          || expected.expiresAt !== undefined && (!Number.isFinite(expected.expiresAt) || expected.expiresAt <= this.now())) throw new IdentityFailure();
      const policy = await deadline.wait(() => this.policyClient.check(verified,
        { signal: deadline.signal, context: context || ownedContext }));
      if (verified.expiresAt <= this.now() || expected.expiresAt !== undefined && expected.expiresAt <= this.now()) throw new IdentityFailure();
      return { ...verified, policy };
    }, { timeoutMs: this.checkTimeoutMs, signal, context: context || ownedContext }); }
    finally { ownedContext?.dispose(); }
  }
}

export class MockProvider {
  constructor(settings, { now = () => Date.now() } = {}) {
    if (settings.production || settings.mode !== 'mock') throw new Error('Synthetic identity is local-only');
    this.settings = settings; this.now = now;
  }
  async begin(returnTo, { entry } = {}) {
    const state = opaqueId(); const nonce = opaqueId();
    const url = new URL(entry?.callback || this.settings.callback); url.searchParams.set('code', 'synthetic'); url.searchParams.set('state', state);
    return { url, transaction: { state, nonce, codeVerifier: opaqueId(), returnTo } };
  }
  async complete(url, transaction) {
    if (url.searchParams.get('code') !== 'synthetic' || url.searchParams.get('state') !== transaction.state) throw new IdentityFailure();
    return { issuer: 'urn:game-room:synthetic', sub: this.settings.mockSub, accessToken: 'synthetic-local-only', expiresAt: this.now() + this.settings.absoluteMs, lastIdentityCheck: this.now() };
  }
  async check(identity) { return { sub: identity.sub }; }
}
