import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IdentityFailure } from '../server/auth.mjs';
import { readSettings, SHARED_ISSUER } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { SessionService } from '../server/session-service.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { makeEntries } from '../server/entry-context.mjs';

const BASE = 1790000000000;
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const denied = status => error => error instanceof IdentityFailure && error.status === status;

async function fixture({ shortIdle = false, mounted = false } = {}) {
  let time = BASE;
  const now = () => time;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'syntheticclient1234',
    ...(shortIdle ? { GAME_ROOM_SESSION_IDLE_SECONDS: '1' } : {}) });
  const definitions = mounted ? [{ id: 'direct', origin: settings.origin, basePath: '/' },
    { id: 'agora', origin: 'http://localhost:4177', basePath: '/game/' }] : undefined;
  const entry = makeEntries(settings, definitions).at(-1);
  const storage = new EncryptedStore(new MemoryAdapter({ now }), randomBytes(32), now);
  const id = opaqueId();
  const saved = { phase: 'active', entryKey: entry.key, issuer: SHARED_ISSUER, sub: 'synthetic-race-member',
    userKey: identityKey(SHARED_ISSUER, 'synthetic-race-member'), accessToken: 'synthetic-old-token',
    authTime: Math.floor(BASE / 1000) - 10, clientId: settings.clientId, csrf: opaqueId(), createdAt: BASE,
    expiresAt: BASE + 3600000, idleUntil: BASE + 1000, lastIdentityCheck: BASE };
  await storage.put('sessions', id, saved, saved.idleUntil);
  const provider = {
    async check(identity) { return { ...identity }; },
    async begin(returnTo, { entry }) {
      const state = opaqueId(), url = new URL(entry.callback);
      url.searchParams.set('code', 'synthetic'); url.searchParams.set('state', state);
      return { url, transaction: { state, nonce: opaqueId(), codeVerifier: opaqueId(), returnTo } };
    },
    async complete() { return { issuer: saved.issuer, sub: saved.sub, clientId: saved.clientId,
      authTime: saved.authTime, accessToken: 'synthetic-new-token', expiresAt: BASE + 3600000 }; },
  };
  const sessions = new SessionService(settings, { store: storage, provider, now });
  const request = new Request(`${settings.origin}/api/state`, { headers: { cookie: `${settings.cookieName}=${id}` } });
  return { settings, definitions, entry, storage, sessions, provider, saved, id, request, advance(ms) { time += ms; } };
}

test('a delayed idle snapshot rereads a concurrent renewal instead of deleting the current session', async () => {
  const f = await fixture(), first = deferred(), entered = deferred(), events = []; let checks = 0;
  f.sessions.subscribeInvalidation(event => events.push(event));
  f.provider.check = async identity => { if (++checks === 1) { entered.resolve(); await first.promise; } return { ...identity }; };
  const waiting = f.sessions.authorize(f.request, { touch: false });
  await entered.promise; f.advance(500);
  await f.sessions.authorize(f.request, { touch: true });
  const renewed = await f.storage.get('sessions', f.id);
  f.advance(600); first.resolve();
  const result = await waiting;
  assert.equal(result.userKey, f.saved.userKey); assert.equal(result.idleUntil, renewed.idleUntil);
  assert.equal(checks, 3, 'a changed version requires a new online policy check');
  assert.deepEqual(events, []); assert.deepEqual(await f.storage.get('sessions', f.id), renewed);
});

test('an expired result after a successful touch CAS rereads another renewal without deleting it', async () => {
  const f = await fixture({ shortIdle: true }), written = deferred(), release = deferred(), events = [];
  const original = f.storage.guardedCAS.bind(f.storage); let writes = 0;
  f.sessions.subscribeInvalidation(event => events.push(event));
  f.storage.guardedCAS = async (...args) => {
    const result = await original(...args);
    if (++writes === 1) { written.resolve(); await release.promise; }
    return result;
  };
  const waiting = f.sessions.authorize(f.request);
  await written.promise; f.advance(500); await f.sessions.authorize(f.request);
  f.advance(600); release.resolve(); const result = await waiting;
  assert.ok(result.idleUntil > BASE + 1100); assert.deepEqual(events, []);
  assert.equal((await f.storage.get('sessions', f.id)).idleUntil, result.idleUntil);
});

test('a policy 401 on an old version rechecks and still invalidates a currently revoked session', async () => {
  const f = await fixture(), first = deferred(), entered = deferred(), events = []; let checks = 0;
  f.sessions.subscribeInvalidation(event => events.push(event));
  f.provider.check = async identity => {
    if (++checks === 1) { entered.resolve(); await first.promise; throw new IdentityFailure(); }
    if (checks > 2) throw new IdentityFailure();
    return { ...identity };
  };
  const waiting = f.sessions.authorize(f.request, { touch: false });
  const rejected = assert.rejects(waiting, denied(401));
  await entered.promise; f.advance(500); await f.sessions.authorize(f.request); first.resolve(); await rejected;
  assert.equal(checks, 3); assert.equal(await f.storage.get('sessions', f.id), null);
  assert.equal(events.length, 1); assert.equal(events[0].status, 401);
});

test('true idle and absolute expiry remain unauthorized without reviving the expired record', async () => {
  for (const absolute of [false, true]) {
    const f = await fixture();
    if (absolute) {
      const saved = { ...f.saved, expiresAt: BASE + 1000, idleUntil: BASE + 1000 };
      await f.storage.put('sessions', f.id, saved, saved.expiresAt);
    }
    f.advance(1000); await assert.rejects(f.sessions.authorize(f.request), denied(401));
    assert.equal(await f.storage.get('sessions', f.id), null);
  }
});

test('four same-version concurrent touches resolve within four attempts without identity invalidation', async () => {
  const f = await fixture(), events = []; let checks = 0;
  f.sessions.subscribeInvalidation(event => events.push(event));
  f.provider.check = async identity => { checks++; return { ...identity }; };
  const results = await Promise.all(Array.from({ length: 4 }, () => f.sessions.authorize(f.request)));
  assert.ok(results.every(result => result.userKey === f.saved.userKey && result.csrf === f.saved.csrf));
  assert.equal(checks, 10, 'the four contenders take 1 + 2 + 3 + 4 fresh attempts');
  assert.deepEqual(events, []); assert.ok(await f.storage.get('sessions', f.id));
});

test('concurrent 401 checks never authorize while 503 checks retain the session and grant no private result', async () => {
  for (const status of [401, 503]) {
    const f = await fixture();
    f.provider.check = async () => { throw new IdentityFailure(status); };
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => f.sessions.authorize(f.request, { touch: false })));
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.status === status));
    const current = await f.storage.get('sessions', f.id);
    if (status === 401) assert.equal(current, null); else assert.deepEqual(current, f.saved);
  }
});

function dispatch(server, entry, path, cookies) {
  return new Promise(resolve => {
    const req = { url: path, method: 'GET', headers: { host: entry.host, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
      rawHeaders: [], socket: { remoteAddress: '127.0.0.1' } };
    const res = { destroyed: false, writableEnded: false, headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(body) { this.writableEnded = true; this.body = body ? JSON.parse(body) : null; resolve(this); } };
    server.emit('request', req, res);
  });
}
function applyCookies(cookies, headers) {
  const values = headers['set-cookie'] || [];
  for (const value of typeof values === 'string' ? [values] : values) {
    const pair = value.split(';')[0], equal = pair.indexOf('='), name = pair.slice(0, equal);
    if (/\bMax-Age=0\b/.test(value)) cookies.delete(name); else cookies.set(name, pair.slice(equal + 1));
  }
}

for (const mounted of [false, true]) for (const endpoint of ['state', 'room']) {
  test(`a late ${endpoint} response preserves a newly issued ${mounted ? 'mounted' : 'direct'} login Cookie`, async t => {
    const f = await fixture({ mounted }), oldCheck = deferred(), entered = deferred();
    f.provider.check = async identity => {
      if (identity.accessToken === f.saved.accessToken) { entered.resolve(); await oldCheck.promise; }
      return { ...identity };
    };
    const rooms = { async ensureProfile() { return {}; }, async recentRooms() { return []; }, async close() {} };
    const server = createUnifiedServer({ settings: f.settings, entries: f.definitions, storage: f.storage, sessions: f.sessions, rooms });
    t.after(() => server.shutdown());
    const cookies = new Map([[f.entry.cookieName, f.id]]), base = f.entry.basePath === '/' ? '' : '/game';
    const waiting = dispatch(server, f.entry, base + (endpoint === 'state' ? '/api/state' : '/api/rooms/123456'), cookies);
    await entered.promise;
    const begin = await dispatch(server, f.entry, base + '/auth/login', cookies);
    assert.equal(begin.status, 303); applyCookies(cookies, begin.headers);
    const callbackUrl = new URL(begin.headers.location);
    const completed = await dispatch(server, f.entry, callbackUrl.pathname + callbackUrl.search, cookies);
    assert.equal(completed.status, 303); applyCookies(cookies, completed.headers);
    const freshId = cookies.get(f.entry.cookieName);
    assert.notEqual(freshId, f.id); assert.ok(await f.storage.get('sessions', freshId));
    oldCheck.resolve(); const late = await waiting; applyCookies(cookies, late.headers);
    if (endpoint === 'state') { assert.equal(late.status, 200); assert.equal(late.body.authenticated, false); }
    else assert.equal(late.status, 401);
    assert.equal(late.headers['set-cookie'], undefined);
    assert.equal(cookies.get(f.entry.cookieName), freshId);
    const current = await dispatch(server, f.entry, base + '/api/state', cookies);
    assert.equal(current.status, 200); assert.equal(current.body.authenticated, true);
    assert.equal(current.body.userKey, f.saved.userKey); assert.equal(await f.storage.get('sessions', f.id), null);
  });
}

test('stale authentication failures do not clear a newer session Cookie, while explicit logout still clears it', async () => {
  const f = await fixture();
  for (const route of ['/auth/callback?state=stale&code=synthetic', '/auth/resume?expectedIdentity=' + 'a'.repeat(64)]) {
    const request = new Request(f.settings.origin + route, { headers: { cookie: `${f.settings.cookieName}=${opaqueId()}` } });
    const response = await f.sessions.route(request);
    const cookies = response.headers['set-cookie'] || [];
    assert.ok(cookies.every(value => !value.startsWith(f.settings.cookieName + '=')));
  }
  const logout = await f.sessions.route(new Request(f.settings.origin + '/auth/logout', { method: 'POST',
    headers: { origin: f.settings.origin, cookie: `${f.settings.cookieName}=${f.id}`, 'x-csrf-token': f.saved.csrf } }));
  assert.equal(logout.status, 200); assert.equal(await f.storage.get('sessions', f.id), null);
  assert.ok(logout.headers['set-cookie'].some(value => value.startsWith(f.settings.cookieName + '=;') && value.includes('Max-Age=0')));
});

test('a live SSE receives immediate 401 or 503 invalidation, with only 401 removing its session', async t => {
  for (const status of [401, 503]) {
    const f = await fixture(), started = deferred(), ended = deferred();
    const view = { roomCode: '123456', roomId: 'synthetic-room', selfId: 'self', revision: 1, phase: 'waiting' };
    const rooms = { async getView() { return view; }, async subscribe(_code, _user, send) { send(view); return () => {}; }, async close() {} };
    const server = createUnifiedServer({ settings: f.settings, storage: f.storage, sessions: f.sessions, rooms });
    t.after(() => server.shutdown());
    const req = { url: '/api/rooms/123456/events', method: 'GET', headers: { host: new URL(f.settings.origin).host, cookie: `${f.settings.cookieName}=${f.id}` },
      rawHeaders: [], socket: { remoteAddress: '127.0.0.1' } };
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, headersSent: false, writableLength: 0, packets: [],
      writeHead(code, headers) { this.status = code; this.headers = headers; this.headersSent = true; started.resolve(); },
      flushHeaders() {}, write(packet) { this.packets.push(packet); return true; },
      end() { this.writableEnded = true; ended.resolve(); } });
    server.emit('request', req, res); await started.promise;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(res.status, 200); assert.equal(res.writableEnded, false);
    f.provider.check = async () => { throw new IdentityFailure(status); };
    await assert.rejects(f.sessions.authorize(f.request, { touch: false }), denied(status)); await ended.promise;
    const closed = res.packets.filter(packet => packet.startsWith('event: closed'));
    assert.equal(closed.length, 1); assert.match(closed[0], new RegExp(`"status":${status}`));
    const current = await f.storage.get('sessions', f.id);
    if (status === 401) assert.equal(current, null); else assert.ok(current);
  }
});
