import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readSettings } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter, identityKey } from '../server/storage.mjs';
import { MockProvider, IdentityFailure } from '../server/auth.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { createMatchHistory } from '../server/match-history.mjs';

async function fixture(t) {
  let time = 10000; const now = () => time;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(new MemoryAdapter({ now }), randomBytes(32), now);
  const provider = new MockProvider(settings, { now }); provider.member = 'a'; provider.status = 200;
  provider.complete = async () => ({ issuer: 'urn:synthetic-history-http', sub: provider.member, accessToken: 'synthetic-server-only-history-token', expiresAt: now() + 3600000 });
  provider.check = async (identity) => { if (provider.status !== 200) throw new IdentityFailure(provider.status); return { sub: identity.sub }; };
  const runtime = createRuntime(settings, { storage, provider, now, roomOptions: { pollIntervalMs: 0 } });
  const history = createMatchHistory({ storage, now }), server = createUnifiedServer({ ...runtime, history });
  t.after(() => server.shutdown()); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`; settings.origin = base; settings.callback = `${base}/auth/callback`; settings.postLogout = `${base}/`;
  async function request(path, { cookie, method = 'GET', headers = {} } = {}) {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    const text = await response.text(); return { status: response.status, response, body: text ? JSON.parse(text) : null };
  }
  async function login(member) {
    provider.member = member; const start = await request('/auth/login'); assert.equal(start.status, 303);
    const location = new URL(start.response.headers.get('location'));
    const callback = await request(location.pathname + location.search, { cookie: start.response.headers.getSetCookie()[0].split(';')[0] }); assert.equal(callback.status, 303);
    return { cookie: callback.response.headers.getSetCookie().find((item) => item.startsWith(settings.cookieName + '=')).split(';')[0] };
  }
  function sample(number = 1) {
    const key = (member) => identityKey('urn:synthetic-history-http', member), id = (n) => n.toString(16).padStart(32, '0');
    return { matchId: id(number), roomId: id(500), roomCode: '456789', game: 'rummikub', ruleVersion: 'friends-v2', startedAt: 1000, endedAt: now(), status: 'completed', reason: 'cleared-rack', players: [
      { userKey: key('a'), seatId: id(90), nickname: '同名', outcome: 'win', remainingPoints: 0 },
      { userKey: key('b'), seatId: id(91), nickname: '同名', outcome: 'loss', remainingPoints: 15 }] };
  }
  return { request, login, archive: (number) => history.archive(sample(number)), sample, history, provider, runtime, advance: (ms) => { time += ms; } };
}

test('history GET requires trusted current session, ignores nickname equality and never exposes identity or hands', async (t) => {
  const f = await fixture(t); await f.archive(); const a = await f.login('a'), b = await f.login('b'), outsider = await f.login('outsider');
  assert.equal((await f.request('/api/history')).status, 401);
  assert.equal((await f.request('/api/history', a)).body.stats.wins, 1);
  assert.equal((await f.request('/api/history', b)).body.stats.losses, 1);
  assert.deepEqual((await f.request('/api/history', outsider)).body.items, []);
  const packet = JSON.stringify((await f.request('/api/history', a)).body);
  for (const secret of ['userKey', 'issuer', 'seatId', 'csrf', 'accessToken', 'synthetic-server-only-history-token', '"rack"']) assert.equal(packet.includes(secret), false);
  assert.equal((await f.request('/api/history?userKey=pretend', a)).status, 400);
  assert.equal((await f.request('/api/history', { ...a, headers: { Authorization: 'Bearer fake' } })).status, 400);
  assert.equal((await f.request('/api/history', { ...a, headers: { Origin: 'https://different.example' } })).status, 403);
  assert.equal((await f.request('/api/history', { ...a, method: 'POST' })).status, 405);
});

test('history rechecks identity after storage reads, with provider outages and expiry remaining explicit', async (t) => {
  const f = await fixture(t); await f.archive(); const a = await f.login('a');
  f.provider.status = 503; assert.equal((await f.request('/api/history', a)).status, 503);
  f.provider.status = 200; assert.equal((await f.request('/api/history', a)).body.stats.completed, 1);
  const original = f.runtime.storage.read.bind(f.runtime.storage); let invalidated = false;
  f.runtime.storage.read = async (...args) => { const result = await original(...args); if (args[0] === 'game-history' && !invalidated) { invalidated = true; f.advance(3600001); } return result; };
  const expired = await f.request('/api/history', a); assert.equal(expired.status, 401); assert.equal(expired.body.items, undefined);
});

test('history cursor is not portable to a different logged-in player and query limits are enforced', async (t) => {
  const f = await fixture(t); for (let index = 1; index <= 4; index++) await f.archive(index);
  const a = await f.login('a'), b = await f.login('b');
  const first = await f.request('/api/history?limit=2', a); assert.equal(first.status, 200); assert.equal(first.body.items.length, 2);
  assert.equal(first.body.stats.completed, 4);
  assert.equal((await f.request('/api/history?limit=2&cursor=' + first.body.nextCursor, b)).status, 400);
  assert.equal((await f.request('/api/history?limit=31', a)).status, 400);
  assert.equal((await f.request('/api/history?limit=2&limit=3', a)).status, 400);
});

test('history output waits for committed outbox recovery and remains unavailable while archival fails', async (t) => {
  const f = await fixture(t), a = await f.login('a'), summary = f.sample();
  f.runtime.rooms.setHistory({ archive: async () => { throw new Error('synthetic archival interruption'); } });
  await f.runtime.storage.put('rooms', summary.roomId, { snapshot: null, pendingRecords: [summary], deletedAt: summary.endedAt });
  const failed = await f.request('/api/history', a); assert.equal(failed.status, 503); assert.equal(failed.body.items, undefined);
  assert.equal((await f.runtime.storage.read('rooms', summary.roomId)).value.pendingRecords.length, 1);
  f.runtime.rooms.setHistory(f.history);
  const repaired = await f.request('/api/history', a); assert.equal(repaired.status, 200); assert.equal(repaired.body.stats.wins, 1);
  assert.equal((await f.runtime.storage.read('rooms', summary.roomId)).value.pendingRecords.length, 0);
});

test('a project logout racing history storage reads cannot receive a private packet afterward', async (t) => {
  const f = await fixture(t), a = await f.login('a'); await f.archive();
  const state = await f.request('/api/state', a), origin = new URL(state.response.url).origin;
  const original = f.runtime.storage.read.bind(f.runtime.storage); let loggedOut = false;
  f.runtime.storage.read = async (...args) => {
    const result = await original(...args);
    if (args[0] === 'game-history' && !loggedOut) {
      loggedOut = true;
      const logout = await f.request('/auth/logout', { ...a, method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': state.body.csrf } });
      assert.equal(logout.status, 200);
    }
    return result;
  };
  const result = await f.request('/api/history', a); assert.equal(result.status, 401); assert.equal(result.body.items, undefined);
});
