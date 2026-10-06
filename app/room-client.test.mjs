import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient, api, rememberMembership, loadMembership, recentSeats } from './room-client.mjs';
import { accountState, accountGeneration, loadAccount, onAccountChange, logoutAccount, loginHref, reportAuthFailure } from './account-client.mjs';

const CODE = '123456';
const TOKEN = 'test-seat-token-that-never-goes-in-a-url';
function view(revision, extra = {}) {
  return { roomCode: CODE, selfId: 'self', hostId: 'self', phase: 'playing', revision,
    players: [{ id: 'self', name: '朋友', ready: true, connected: true }],
    game: { playerId: 'self', rack: [{ id: 'red-1-a', color: 'red', value: 1 }],
      board: [], poolCount: 78, turnPlayerId: 'self', round: revision }, ...extra };
}
function fixture(hooks = {}) {
  const views = [], connections = [], errors = [];
  const client = new RoomClient(CODE, { playerId: 'self', token: TOKEN }, {
    onView: (value) => { views.push(value); hooks.onView?.(value); },
    onConnection: (value) => { connections.push(value); hooks.onConnection?.(value); },
    onError: (error) => { errors.push(error); hooks.onError?.(error); },
  });
  return { client, views, connections, errors };
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function packet(type, data, newline = '\n', multiline = false) {
  const serialized = JSON.stringify(data, null, multiline ? 2 : 0);
  return `event: ${type}${newline}${serialized.split('\n').map((line) => `data: ${line}`).join(newline)}${newline}${newline}`;
}
function streamResponse(text, chunkSize = 3) {
  // Byte chunks split Chinese characters as well as event names and separators.
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
    }
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

 test('lost committed action response reads the latest revision without replaying a business write', async (t) => {
  const { client, views } = fixture();
  client.receive(view(7));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (calls.length === 1) {
      // The server committed; its SSE update arrived before the HTTP response was lost.
      client.receive(view(8));
      throw new TypeError('response lost');
    }
    return jsonResponse({ view: view(8) });
  });
  await assert.rejects(client.action('submit', { boardIds: [['red-1-a']], rackIds: ['blue-2-a'] }), /操作结果未确认/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `/api/rooms/${CODE}/actions`);
  assert.equal(calls[1].url, `/api/rooms/${CODE}`);
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].body.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.body, undefined);
  assert.equal(calls[0].body.expectedRevision, 7);
  assert.deepEqual(calls[0].body.boardIds, [['red-1-a']]);
  assert.deepEqual(calls[0].body.rackIds, ['blue-2-a']);
  assert.equal(views.at(-1).revision, 8);
});

test('a conflicting action refreshes the private view without replaying the write', async (t) => {
  const { client } = fixture();
  client.receive(view(10));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return jsonResponse({ error: '房间已更新。' }, 409);
    assert.equal(options.method, 'GET');
    return jsonResponse({ view: view(12) });
  });
  await assert.rejects(client.action('draw'), (error) => error.status === 409);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].options.body).expectedRevision, 10);
  assert.equal(calls[1].url, `/api/rooms/${CODE}`);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(client.view.revision, 12);
});

test('SSE handles split UTF-8, multiline data and private identity while ignoring older revisions', async (t) => {
  const { client, views } = fixture();
  const content = ': heartbeat\n\n'
    + packet('view', view(2), '\n', true)
    + packet('view', view(99, { selfId: 'another-player' }))
    + packet('view', view(98, { roomCode: '999999' }))
    + packet('view', view(1))
    + packet('view', view(3))
    + packet('closed', { error: '房间已回收。' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `/api/rooms/${CODE}/events`);
    assert.ok(!url.includes(TOKEN));
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    return streamResponse(content, 3);
  });
  await assert.rejects(client.readStream(new AbortController()), (error) => error.status === 404);
  assert.deepEqual(views.map((value) => value.revision), [2, 3]);
  assert.ok(views.every((value) => value.selfId === 'self' && value.game.playerId === 'self'));
  assert.equal(views[0].players[0].name, '朋友');
  assert.equal(client.view.game.rack[0].id, 'red-1-a');
});

test('SSE CRLF separators remain valid when carriage-return and line-feed arrive in separate chunks', async (t) => {
  const { client, views } = fixture();
  const content = packet('view', view(4), '\r\n', true)
    + packet('closed', { error: '房间已关闭。' }, '\r\n');
  t.mock.method(globalThis, 'fetch', async () => streamResponse(content, 1));
  await assert.rejects(client.readStream(new AbortController()), (error) => error.status === 404);
  assert.deepEqual(views.map((value) => value.revision), [4]);
});

test('closed SSE event reports 404, stays offline and does not schedule reconnect', async (t) => {
  let settle;
  const observed = new Promise((resolve) => { settle = resolve; });
  const { client, connections, errors } = fixture({ onError: (error) => settle(error) });
  let fetchCount = 0;
  let retries = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return streamResponse(packet('view', view(5)) + packet('closed', { error: '你已离开房间。' }), 7);
  });
  // If it incorrectly schedules a retry, settle immediately so the assertion fails without a wait.
  t.mock.method(globalThis, 'setTimeout', (_callback, delay) => {
    if (delay === 2000) { retries += 1; settle(new Error('unexpected reconnect')); }
    return 0;
  });
  t.after(() => client.stop());
  client.connect();
  const error = await observed;
  assert.equal(error.status, 404);
  assert.equal(error.message, '你已离开房间。');
  assert.deepEqual(connections, ['connecting', 'online', 'offline']);
  assert.equal(errors.length, 1);
  assert.equal(fetchCount, 1);
  assert.equal(retries, 0);
  assert.equal(client.retryTimer, null);
});

const USER = 'a'.repeat(64);
const AUTH = { mode: 'mock', loginReady: true, authenticated: true, userKey: USER, csrf: 'synthetic-csrf-value',
  profile: { userKey: USER, nickname: '棋牌称呼', createdAt: 1, updatedAt: 1 },
  recentRooms: [{ roomCode: CODE, playerId: 'self', name: '棋牌称呼', phase: 'playing', at: 1 }] };
async function authenticated(t, extra = {}) {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ ...AUTH, ...extra }));
  await loadAccount();
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function locationFixture(t, hostname) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'location', previous) : delete globalThis.location);
}

test('unified requests use own-domain cookies and CSRF, omit bearer credentials, and keep membership out of browser storage', async (t) => {
  await authenticated(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return jsonResponse({ view: view(1) }); });
  await api(`/api/rooms/${CODE}`, { token: TOKEN });
  await api(`/api/rooms/${CODE}/actions`, { method: 'POST', token: TOKEN, body: { type: 'draw' } });
  assert.ok(calls.every((call) => call.options.credentials === 'same-origin' && call.options.cache === 'no-store'));
  assert.ok(calls.every((call) => !('Authorization' in call.options.headers) && !call.url.includes(TOKEN)));
  assert.equal(calls[1].options.headers['X-CSRF-Token'], AUTH.csrf);
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].options.body, '{"type":"draw"}');
  // There are no storage globals in Node: unified recovery must not require either of them.
  const remembered = rememberMembership({ roomCode: CODE, playerId: 'self', token: TOKEN }, '棋牌称呼');
  assert.ok(!('token' in remembered));
  assert.ok(!('token' in loadMembership(CODE)));
  assert.deepEqual(recentSeats().map((entry) => entry.roomCode), [CODE]);
});

test('only a loopback 404 may fall back to the old anonymous local server', async (t) => {
  locationFixture(t, 'game.sumomoli.com');
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'missing' }, 404));
  await assert.rejects(loadAccount(), (error) => error.status === 503);
  assert.notEqual(accountState().mode, 'legacy');
  assert.equal(accountState().authenticated, false);
  globalThis.location.hostname = '127.0.0.1';
  const state = await loadAccount();
  assert.equal(state.mode, 'legacy');
  assert.equal(state.authenticated, false);
});

test('a late account response cannot restore a session after project logout', async (t) => {
  await authenticated(t);
  const pending = deferred();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/state') return pending.promise;
    assert.equal(url, '/auth/logout'); return jsonResponse({ ok: true });
  });
  const loading = loadAccount();
  const before = accountGeneration();
  await logoutAccount();
  assert.ok(accountGeneration() > before);
  pending.resolve(jsonResponse(AUTH));
  await loading;
  assert.equal(accountState().authenticated, false);
  assert.equal(accountState().userKey, null);
  assert.equal(accountState().csrf, null);
  assert.equal(accountState().profile, null);
  assert.deepEqual(accountState().recentRooms, []);
  const logout = calls.find((call) => call.url === '/auth/logout');
  assert.equal(logout.options.credentials, 'same-origin');
  assert.equal(logout.options.method, 'POST');
  assert.equal(logout.options.headers['X-CSRF-Token'], AUTH.csrf);
  assert.ok(!('Authorization' in logout.options.headers));
});

test('account refresh during pending logout cannot restore the still-valid old cookie identity', async (t) => {
  await authenticated(t);
  const pending = deferred();
  let stateReads = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/auth/logout') return pending.promise;
    stateReads += 1; return jsonResponse(AUTH);
  });
  const loggingOut = logoutAccount();
  const during = await loadAccount();
  assert.equal(during.authenticated, false);
  assert.equal(during.profile, null);
  assert.deepEqual(during.recentRooms, []);
  assert.equal(stateReads, 0);
  pending.resolve(jsonResponse({ ok: true }));
  await loggingOut;
  assert.equal(accountState().authenticated, false);
  assert.equal(accountState().userKey, null);
  assert.equal(accountState().csrf, null);
  assert.equal(accountState().profile, null);
  assert.deepEqual(accountState().recentRooms, []);
});

test('failed pending logout unlocks explicit account recovery while keeping failure status until fresh verification', async (t) => {
  await authenticated(t);
  const pending = deferred(); let stateReads = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/auth/logout') return pending.promise;
    stateReads += 1; return jsonResponse(AUTH);
  });
  const loggingOut = logoutAccount();
  await loadAccount();
  assert.equal(stateReads, 0);
  pending.reject(new TypeError('synthetic unavailable logout'));
  await assert.rejects(loggingOut, (error) => error.status === 503);
  assert.equal(accountState().failureStatus, 503);
  assert.equal(accountState().authenticated, false);
  await loadAccount();
  assert.equal(stateReads, 1);
  assert.equal(accountState().authenticated, true);
  assert.equal(accountState().failureStatus, null);
});

test('logout fences a pending refresh even when a transport ignores its abort signal', async (t) => {
  await authenticated(t);
  const { client, views, errors } = fixture();
  t.after(() => client.stop());
  const pending = deferred(); let refreshSignal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/auth/logout') return jsonResponse({ ok: true });
    refreshSignal = options.signal; return pending.promise;
  });
  const refreshing = client.refresh();
  await logoutAccount();
  assert.equal(refreshSignal.aborted, true);
  pending.resolve(jsonResponse({ view: view(90) }));
  await assert.rejects(refreshing, (error) => error.name === 'AbortError');
  assert.deepEqual(views, []);
  assert.equal(client.view, null);
  assert.equal(client.stopped, true);
  assert.equal(errors[0].status, 401);
});

test('logout fences a pending action response and clears the in-memory private view', async (t) => {
  await authenticated(t);
  const { client, views } = fixture();
  t.after(() => client.stop());
  client.receive(view(10));
  const pending = deferred();
  t.mock.method(globalThis, 'fetch', async (url) => url === '/auth/logout' ? jsonResponse({ ok: true }) : pending.promise);
  const acting = client.action('draw');
  await logoutAccount();
  pending.resolve(jsonResponse({ view: view(11) }));
  await assert.rejects(acting, (error) => error.name === 'AbortError');
  assert.deepEqual(views.map((entry) => entry.revision), [10]);
  assert.equal(client.view, null);
});

test('a lost action response after logout never schedules another action attempt', async (t) => {
  await authenticated(t);
  const { client } = fixture();
  client.receive(view(10));
  const pending = deferred(); let actions = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/auth/logout') return jsonResponse({ ok: true });
    actions += 1; return pending.promise;
  });
  const acting = client.action('draw');
  await logoutAccount(); pending.reject(new TypeError('synthetic lost response'));
  await assert.rejects(acting, (error) => error.name === 'AbortError');
  assert.equal(actions, 1);
});

test('logout fences delayed SSE fetch completion and prevents a stopped client from reconnecting', async (t) => {
  await authenticated(t);
  const { client, views, connections } = fixture();
  const pending = deferred(); let streams = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/auth/logout') return jsonResponse({ ok: true });
    streams += 1; return pending.promise;
  });
  const streaming = client.readStream(new AbortController());
  await logoutAccount();
  pending.resolve(streamResponse(packet('view', view(90))));
  await assert.rejects(streaming, (error) => error.name === 'AbortError');
  client.connect();
  assert.equal(streams, 1);
  assert.deepEqual(views, []);
  assert.deepEqual(connections, ['offline']);
});

test('unified closed SSE preserves 401/503 and stops private data without automatic reconnect', async (t) => {
  for (const status of [401, 503]) {
    await authenticated(t);
    const settled = deferred();
    const { client, errors } = fixture({ onError: (error) => settled.resolve(error) });
    let retries = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(options.credentials, 'same-origin');
      assert.ok(!('Authorization' in options.headers));
      return streamResponse(packet('view', view(5)) + packet('closed', { status, error: 'synthetic identity failure' }), 7);
    });
    t.mock.method(globalThis, 'setTimeout', (_callback, delay) => {
      if (delay === 2000) { retries += 1; settled.resolve(new Error('unexpected retry')); }
      return 0;
    });
    client.connect();
    const error = await settled.promise;
    assert.equal(error.status, status);
    assert.equal(errors.length, 1);
    assert.equal(retries, 0);
    assert.equal(client.view, null);
    assert.equal(accountState().authenticated, false);
    assert.equal(accountState().failureStatus, status);
    assert.equal(client.retryTimer, null);
    client.stop();
  }
});

test('unified HTTP identity failures clear account and stop the old client; renewal rotates its generation', async (t) => {
  await authenticated(t);
  const { client, errors } = fixture();
  client.receive(view(1));
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'temporarily unverifiable' }, 503));
  await assert.rejects(client.refresh(), (error) => error.status === 503);
  assert.equal(client.stopped, true);
  assert.equal(client.view, null);
  assert.equal(errors[0].status, 503);
  await authenticated(t);
  const renewed = fixture().client;
  const epoch = accountGeneration();
  await authenticated(t, { csrf: 'rotated-csrf' });
  assert.ok(accountGeneration() > epoch);
  assert.equal(renewed.stopped, true);
  assert.equal(accountState().authenticated, true);
});

test('same-identity recovery after 503 preserves the draft but never revives a delayed private response or old SSE client', async (t) => {
  await authenticated(t);
  const key = `game-room.private-draft.${USER}.room-id.self`;
  const data = new Map([[key, JSON.stringify({ revision: 1, rackIds: ['red-1-a'], boardIds: [] })]]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return data.size; }, key: index => [...data.keys()][index],
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'sessionStorage', descriptor) : delete globalThis.sessionStorage);
  const { client, views } = fixture(); client.receive(view(1));
  const pending = deferred();
  t.mock.method(globalThis, 'fetch', async () => pending.promise);
  const refreshing = client.refresh();
  reportAuthFailure({ status: 503 });
  assert.equal(client.stopped, true); assert.equal(client.view, null);
  assert.ok(data.has(key));
  await authenticated(t, { csrf: 'fresh-verified-csrf' });
  assert.equal(accountState().authenticated, true);
  assert.ok(data.has(key));
  pending.resolve(jsonResponse({ view: view(999) }));
  await assert.rejects(refreshing, error => error.name === 'AbortError');
  client.connect();
  assert.deepEqual(views.map(value => value.revision), [1]);
  assert.equal(client.view, null); assert.equal(client.stopped, true);
});

test('logout failure is reported as failure while late private replies remain fenced', async (t) => {
  await authenticated(t);
  const notices = []; const unsubscribe = onAccountChange((state) => notices.push(state));
  t.after(unsubscribe);
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'synthetic logout unavailable' }, 503));
  await assert.rejects(logoutAccount(), (error) => error.status === 503);
  assert.equal(accountState().authenticated, false);
  assert.equal(accountState().failureStatus, 503);
  assert.ok(notices.every((entry) => !entry.authenticated));
});

test('logout network failure remains unverifiable instead of claiming the server session was cleared', async (t) => {
  await authenticated(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('synthetic network failure'); });
  await assert.rejects(logoutAccount(), (error) => error.status === 503 && error.message.includes('暂未完成'));
  assert.equal(accountState().authenticated, false);
  assert.equal(accountState().failureStatus, 503);
});

test('account invalidation clears only this account private drafts and keeps unrelated storage', async (t) => {
  await authenticated(t);
  const current = `game-room.private-draft.${USER}.room-id.self`;
  const otherUser = `game-room.private-draft.${'b'.repeat(64)}.room-id.friend`;
  const data = new Map([[current, 'private tile IDs'], [otherUser, 'other account'], ['friends-game-room.practice', 'practice']]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return data.size; }, key: (index) => [...data.keys()][index], removeItem: (key) => data.delete(key),
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete globalThis.sessionStorage);
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ ok: true }));
  await logoutAccount();
  assert.equal(data.has(current), false);
  assert.equal(data.has(otherUser), true);
  assert.equal(data.has('friends-game-room.practice'), true);
});

test('stable profile updates notify the page without cancelling active room operations', async (t) => {
  await authenticated(t);
  const { client } = fixture();
  t.after(() => client.stop());
  client.receive(view(1));
  const epoch = accountGeneration();
  await authenticated(t, { profile: { ...AUTH.profile, nickname: '新棋牌昵称' } });
  assert.equal(accountGeneration(), epoch);
  assert.equal(client.stopped, false);
  assert.equal(client.view.revision, 1);
  assert.equal(accountState().profile.nickname, '新棋牌昵称');
});

test('non-JSON protected failures preserve auth failure status and do not retry with bearer credentials', async (t) => {
  await authenticated(t);
  const { client, errors } = fixture();
  client.receive(view(1));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; return new Response('<unavailable>', { status: 503 }); });
  await assert.rejects(client.action('draw'), (error) => error.status === 503);
  assert.equal(requests, 1);
  assert.equal(errors[0].status, 503);
  assert.equal(client.view, null);
});

test('JSON null identity failures preserve 503 for private actions, SSE and project logout', async (t) => {
  await authenticated(t);
  let actions = 0;
  const actionFixture = fixture(); actionFixture.client.receive(view(1));
  t.mock.method(globalThis, 'fetch', async () => { actions += 1; return jsonResponse(null, 503); });
  await assert.rejects(actionFixture.client.action('draw'), (error) => error.status === 503);
  assert.equal(actions, 1);
  assert.equal(actionFixture.errors[0].status, 503);
  assert.equal(actionFixture.client.view, null);

  await authenticated(t);
  const streamFixture = fixture();
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(null, 503));
  await assert.rejects(streamFixture.client.readStream(new AbortController()), (error) => error.status === 503);
  assert.equal(streamFixture.errors[0].status, 503);
  assert.equal(accountState().failureStatus, 503);

  await authenticated(t);
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(null, 503));
  await assert.rejects(logoutAccount(), (error) => error.status === 503);
  assert.equal(accountState().authenticated, false);
  assert.equal(accountState().failureStatus, 503);
});

test('successful logout broadcasts a credential-free notice; another tab clears its own account and private drafts', async (t) => {
  const descriptors = new Map(['window', 'BroadcastChannel', 'sessionStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let channel;
  class SyntheticChannel {
    constructor(name) { this.name = name; this.messages = []; channel = this; }
    postMessage(value) { this.messages.push(value); }
    unref() {}
  }
  const data = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: SyntheticChannel });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return data.size; }, key: (index) => [...data.keys()][index], removeItem: (key) => data.delete(key),
  } });
  t.after(() => {
    for (const [key, descriptor] of descriptors) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const otherTab = await import('./account-client.mjs?synthetic-broadcast-test');
  t.mock.method(globalThis, 'fetch', async (url) => jsonResponse(url === '/auth/logout' ? { ok: true } : AUTH));
  await otherTab.loadAccount();
  await otherTab.logoutAccount();
  assert.deepEqual(channel.messages, [{ type: 'logout' }]);
  await otherTab.loadAccount();
  const draft = `game-room.private-draft.${USER}.synthetic-room.self`;
  data.set(draft, 'private tile IDs');
  const epoch = otherTab.accountGeneration();
  channel.onmessage({ data: { type: 'logout' } });
  assert.ok(otherTab.accountGeneration() > epoch);
  assert.equal(otherTab.accountState().authenticated, false);
  assert.equal(otherTab.accountState().profile, null);
  assert.equal(data.has(draft), false);
});

test('login helper keeps only approved local invitation destinations', () => {
  assert.equal(loginHref(`/room.html?code=${CODE}`), '/auth/login?returnTo=%2Froom.html%3Fcode%3D123456');
  assert.equal(loginHref('https://evil.example'), '/auth/login?returnTo=%2F');
  assert.equal(loginHref('//evil.example'), '/auth/login?returnTo=%2F');
  assert.equal(loginHref('/?room=123456&extra=bad'), '/auth/login?returnTo=%2F');
});
