import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter } from '../server/storage.mjs';
import { MockProvider, IdentityFailure } from '../server/auth.mjs';
import { readSettings } from '../server/config.mjs';
import { createGameRegistry } from './game-registry.mjs';
import { createPoker414Adapter } from '../server/games/poker414-2/adapter.mjs';
import { createRummikubAdapter } from '../server/games/rummikub/adapter.mjs';
import { SCORE_SCOPES } from '../server/game-scores.mjs';

// Actual SessionService, rooms, encrypted storage, score service and HTTP server.
// Provider responses are synthetic; these tests do not certify central SSO.
async function fixture(t, { sqlite = false, batch = false } = {}) {
  const folder = mkdtempSync(join(tmpdir(), '414-scores-http-'));
  let time = Date.now(), identityHook = null; const now = () => time;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(join(folder, 'db.sqlite'), { now }) : new MemoryAdapter({ now }), randomBytes(32), now);
  const provider = new MockProvider(settings, { now }), checks = [];
  if (batch) provider.usesBatchIdentity = true;
  provider.complete = async () => ({ issuer: 'urn:414-score-http', sub: provider.member, accessToken: 'synthetic-private-only', expiresAt: now() + 3600000 });
  provider.check = async identity => { checks.push(identity.sub); if (identityHook) await identityHook(checks.length, identity); return { sub: identity.sub }; };
  const registry = createGameRegistry([createRummikubAdapter(), createPoker414Adapter()]);
  const runtime = createRuntime(settings, { storage, provider, now, roomOptions: { gameRegistry: registry, pollIntervalMs: 0, serverRandomInt: max => max - 1 }, chatOptions: { pollIntervalMs: 0 } });
  const server = createUnifiedServer(runtime);
  t.after(async () => { server.closeAllConnections(); await server.shutdown(); rmSync(folder, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  settings.origin = base; settings.callback = base + '/auth/callback'; settings.postLogout = base + '/';
  async function request(path, member = {}, body, extra = {}) {
    const method = extra.method ?? (body === undefined ? 'GET' : 'POST');
    const response = await fetch(base + path, { method, redirect: 'manual', headers: {
      ...(member.cookie ? { cookie: member.cookie } : {}), ...(method !== 'GET' ? { origin: base, 'x-csrf-token': member.csrf ?? '' } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra.headers,
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null, text, headers: response.headers };
  }
  async function login(sub) {
    provider.member = sub;
    const start = await request('/auth/login'), callback = new URL(start.headers.get('location'));
    const completed = await request(callback.pathname + callback.search, { cookie: start.headers.getSetCookie()[0].split(';')[0] });
    assert.equal(completed.status, 303);
    const cookie = completed.headers.getSetCookie().find(value => value.startsWith(settings.cookieName + '=')).split(';')[0];
    const state = await request('/api/state', { cookie }); assert.equal(state.body.authenticated, true);
    return { sub, cookie, csrf: state.body.csrf, userKey: state.body.userKey, sessionId: cookie.split('=')[1] };
  }
  async function room() {
    const members = await Promise.all(['a', 'b', 'c', 'watcher', 'outsider'].map(async name => ({ name })));
    // The mock provider selects one login subject at a time, just as a real browser callback does.
    for (const member of members) Object.assign(member, await login(member.name));
    const created = await request('/api/rooms', members[0], { name: '同名', gameType: 'poker414-2', requestId: randomUUID() });
    assert.equal(created.status, 201, created.text);
    const code = created.body.roomCode;
    for (let index = 1; index < 4; index++) assert.equal((await request(`/api/rooms/${code}/join`, members[index],
      { name: '同名', requestId: randomUUID(), ...(index === 3 ? { role: 'spectator' } : {}) })).status, 201);
    return { code, members, roomId: created.body.view.roomId, path: `/api/rooms/${code}/scores` };
  }
  async function action(room, member, type, extra = {}) {
    const view = (await request(`/api/rooms/${room.code}`, member)).body.view;
    const result = await request(`/api/rooms/${room.code}/actions`, member,
      { type, requestId: randomUUID(), expectedRevision: view.revision, ...extra });
    assert.equal(result.status, 200, result.text); return result.body;
  }
  async function start(room) {
    for (const member of room.members.slice(0, 3)) await action(room, member, 'ready', { ready: true });
    return action(room, room.members[0], 'start');
  }
  return { runtime, storage, server, settings, provider, checks, request, login, room, action, start,
    hook: value => { identityHook = value; }, advance: value => { time += value; } };
}

for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'Memory'}: mounted scores read is authenticated, room scoped, permanent and contains no account keys`, async t => {
  const f = await fixture(t, { sqlite }), room = await f.room(), before = f.checks.length;
  const waiting = await f.request(room.path, room.members[0]);
  assert.equal(waiting.status, 200, waiting.text); assert.equal(f.checks.length - before, 2);
  assert.equal(waiting.headers.get('cache-control'), 'no-store'); assert.equal(waiting.body.roomId, room.roomId);
  assert.deepEqual(waiting.body.players.map(player => player.total), [0, 0, 0]);
  assert.equal(waiting.body.matchId, null); assert.equal(waiting.body.settlement, null);
  assert.equal((await f.storage.scan(SCORE_SCOPES.balances)).length, 0, 'verified zero must not create a balance');
  const watcherView = (await f.request(`/api/rooms/${room.code}`, room.members[3])).body.view;
  const watcher = await f.request(room.path, room.members[3]); assert.equal(watcher.status, 200);
  assert.equal(watcher.body.players.some(player => player.playerId === watcherView.selfId), false);
  assert.equal((await f.request(room.path)).status, 401);
  assert.equal((await f.request(room.path, room.members[4])).status, 403);
  for (const forbidden of ['userKey', 'synthetic-private-only', 'csrf', 'hand', 'urn:414', ...room.members.map(member => member.userKey)]) assert.equal(waiting.text.includes(forbidden), false);
  const started = await f.start(room), matchId = started.view.matchId;
  await f.action(room, room.members[0], 'leave');
  const terminal = await f.request(room.path, room.members[1]); assert.equal(terminal.status, 200, terminal.text);
  assert.equal(terminal.body.settlement.matchId, matchId); assert.equal(terminal.body.settlement.reason, 'voluntary-leave');
  assert.deepEqual(terminal.body.settlement.balancesAfter.map(item => item.total), [-10, 5, 5]);
  assert.deepEqual(terminal.body.players.map(item => item.total), [5, 5]);
  assert.equal((await f.request(room.path, room.members[0])).status, 403);
  assert.deepEqual((await f.request(room.path + '?matchId=' + matchId, room.members[3])).body.settlement, terminal.body.settlement);
  assert.equal((await f.request('/api/history', room.members[1])).body.items[0].self.balanceAfter, 5);
  assert.equal((await f.request('/api/state', room.members[1])).body.poker414Enabled, true);
});

test('scores reject writes, credentials, invalid or duplicate match queries and unsupported old games', async t => {
  const f = await fixture(t), room = await f.room(), member = room.members[0];
  for (const query of ['?userKey=' + member.userKey, '?matchId=no', '?matchId=' + 'a'.repeat(32) + '&matchId=' + 'b'.repeat(32), '?x=1']) assert.equal((await f.request(room.path + query, member)).status, 400);
  const write = await f.request(room.path, member, {}); assert.equal(write.status, 405); assert.equal(write.headers.get('allow'), 'GET');
  assert.equal((await f.request(room.path + '/unknown', member)).status, 404);
  const old = await f.request('/api/rooms', member, { name: '旧玩法', gameType: 'rummikub', requestId: randomUUID() });
  const unsupported = await f.request(`/api/rooms/${old.body.roomCode}/scores`, member);
  assert.equal(unsupported.status, 400); assert.equal(unsupported.body.code, 'SCORE_UNSUPPORTED');
});

for (const status of [401, 503]) test(`a fresh ${status} during score preparation suppresses all private totals`, async t => {
  const f = await fixture(t, { batch: true }), room = await f.room(), target = f.checks.length + 2;
  f.hook(call => { if (call === target) throw new IdentityFailure(status); });
  const failed = await f.request(room.path, room.members[0]); assert.equal(failed.status, status);
  assert.equal('players' in failed.body, false); assert.equal('settlement' in failed.body, false);
});

test('membership changed during fresh identity checking is revalidated before score output', async t => {
  const f = await fixture(t, { batch: true }), room = await f.room(), member = room.members[1], target = f.checks.length + 2;
  f.hook(async call => {
    if (call !== target) return;
    const view = await f.runtime.rooms.getView(room.code, member.userKey);
    await f.runtime.rooms.action(room.code, member.userKey, { type: 'leave', expectedRevision: view.revision, requestId: randomUUID() });
  });
  const failed = await f.request(room.path, member); assert.equal(failed.status, 403); assert.equal('players' in failed.body, false);
});

test('final atomic output fence rejects logout and never emits already prepared balances', async t => {
  const f = await fixture(t, { batch: true }), room = await f.room(), member = room.members[0];
  const verify = f.storage.verifyGuards.bind(f.storage); let injected = false;
  f.storage.verifyGuards = async transaction => {
    if (!injected && transaction.guards.some(guard => guard.scope === SCORE_SCOPES.balances)) {
      injected = true; await f.storage.remove('sessions', member.sessionId);
    }
    return verify(transaction);
  };
  const failed = await f.request(room.path, member); assert.equal(injected, true); assert.equal(failed.status, 401);
  assert.equal('players' in failed.body, false);
});

test('final room membership fence can reprepare once but cannot expose totals after leaving', async t => {
  const f = await fixture(t, { batch: true }), room = await f.room(), member = room.members[1];
  const verify = f.storage.verifyGuards.bind(f.storage); let injected = false;
  f.storage.verifyGuards = async transaction => {
    if (!injected && transaction.guards.some(guard => guard.scope === SCORE_SCOPES.balances)) {
      injected = true;
      const view = await f.runtime.rooms.getView(room.code, member.userKey);
      await f.runtime.rooms.action(room.code, member.userKey, { type: 'leave', expectedRevision: view.revision, requestId: randomUUID() });
    }
    return verify(transaction);
  };
  const failed = await f.request(room.path, member); assert.equal(injected, true); assert.equal(failed.status, 403); assert.equal('players' in failed.body, false);
});

test('a match id from a different room cannot query its ledger through current room membership', async t => {
  const f = await fixture(t), first = await f.room(), started = await f.start(first), outsider = first.members[4];
  await f.action(first, first.members[0], 'leave');
  const other = await f.request('/api/rooms', outsider, { name: '另一个房间', gameType: 'poker414-2', requestId: randomUUID() });
  const result = await f.request(`/api/rooms/${other.body.roomCode}/scores?matchId=${started.view.matchId}`, outsider);
  assert.equal(result.status, 404); assert.equal(result.body.code, 'SCORE_MATCH_NOT_FOUND'); assert.equal('settlement' in result.body, false);
});

test('another room changes balances at delivery: score guards reprepare once without repeating a write or identity check', async t => {
  const f = await fixture(t, { batch: true }), first = await f.room(), second = await f.room();
  await f.start(second);
  const verify = f.storage.verifyGuards.bind(f.storage); let scoreChecks = 0, injected = false;
  f.storage.verifyGuards = async transaction => {
    if (transaction.guards.some(guard => guard.scope === SCORE_SCOPES.balances)) {
      scoreChecks++;
      if (!injected) {
        injected = true; const view = await f.runtime.rooms.getView(second.code, second.members[0].userKey);
        await f.runtime.rooms.action(second.code, second.members[0].userKey, { type: 'leave', requestId: randomUUID(), expectedRevision: view.revision });
      }
    }
    return verify(transaction);
  };
  const before = f.checks.length, result = await f.request(first.path, first.members[1]);
  assert.equal(result.status, 200, result.text); assert.equal(scoreChecks, 2); assert.equal(f.checks.length - before, 2);
  assert.deepEqual(result.body.players.map(player => player.total), [-10, 5, 5]);
  assert.equal((await f.storage.scan(SCORE_SCOPES.ledger)).length, 1);
});

test('later matches change current totals but keep the earlier settlement balance and reason immutable', async t => {
  const f = await fixture(t), first = await f.room(), second = await f.room();
  const started = await f.start(first); await f.action(first, first.members[0], 'leave');
  const original = await f.request(first.path, first.members[1]);
  await f.start(second); await f.action(second, second.members[1], 'leave');
  const current = await f.request(first.path + '?matchId=' + started.view.matchId, first.members[1]);
  assert.equal(current.status, 200, current.text);
  assert.deepEqual(current.body.players.map(player => player.total), [-5, 10]);
  assert.deepEqual(current.body.settlement, original.body.settlement);
  assert.deepEqual(current.body.settlement.balancesAfter.map(player => player.total), [-10, 5, 5]);
});

test('system cancellation keeps its match id for waiting-room reconciliation; rematch hides older room ledgers', async t => {
  const f = await fixture(t), room = await f.room(), started = await f.start(room);
  f.advance(120000); await f.runtime.rooms.sweep();
  const cancelled = await f.request(room.path, room.members[0]);
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.body.matchId, started.view.matchId);
  assert.equal(cancelled.body.settlement.reason, 'disconnected');
  assert.deepEqual(cancelled.body.settlement.deltas.map(item => item.delta), [0, 0, 0]);
  await f.start(room);
  const old = await f.request(room.path + '?matchId=' + started.view.matchId, room.members[3]);
  assert.equal(old.status, 404); assert.equal('settlement' in old.body, false);
  const unknown = await f.request(room.path + '?matchId=' + 'e'.repeat(32), room.members[0]);
  assert.equal(unknown.status, 404);
});
