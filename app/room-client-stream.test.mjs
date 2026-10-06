import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from './room-client.mjs';
import { accountState, accountGeneration, loadAccount, logoutAccount } from './account-client.mjs';

const CODE = '123456', USER = 'a'.repeat(64);
const AUTH = { mode: 'mock', loginReady: true, authenticated: true, userKey: USER, csrf: 'synthetic-csrf',
  profile: { nickname: '合成玩家' }, recentRooms: [] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const packet = (revision, extra = {}) => `event: view\ndata: ${JSON.stringify({ roomCode: CODE, roomId: 'synthetic-room', selfId: 'self', revision, ...extra })}\n\n`;
const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };

function clock(t) {
  let now = 0, serial = 0; const pending = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const id = ++serial; pending.set(id, { at: now + delay, callback }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => pending.delete(id));
  return { pending, tick(ms) { now += ms;
    for (const [id, item] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (item.at <= now && pending.has(id)) { pending.delete(id); item.callback(); }
    }
  } };
}
function source({ cancelPending = false } = {}) {
  let controller, cancellations = 0;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() {
    cancellations++;
    if (cancelPending) return new Promise(() => {});
  } });
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    push(text) { controller.enqueue(new TextEncoder().encode(text)); },
    get cancellations() { return cancellations; }, body };
}
async function fixture(t, options = {}) {
  t.mock.method(globalThis, 'fetch', async () => json(AUTH)); await loadAccount();
  const timers = clock(t), sources = [], calls = [], views = [], connections = [], errors = [];
  const client = new RoomClient(CODE, { playerId: 'self' }, {
    onView(value) { views.push(value); }, onConnection(value) { connections.push(value); }, onError(error) { errors.push(error); },
  });
  t.after(() => client.stop());
  t.mock.method(globalThis, 'fetch', async (url, fetchOptions = {}) => {
    calls.push({ url, options: fetchOptions });
    if (url === '/api/state') return json(AUTH);
    if (url === '/auth/logout') return json({ ok: true });
    assert.equal(url, `/api/rooms/${CODE}/events`);
    const stream = source(options); stream.signal = fetchOptions.signal; sources.push(stream);
    stream.push(packet(sources.length)); return stream.response;
  });
  client.connect(); await settle();
  return { client, timers, sources, calls, views, connections, errors };
}

test('a frozen authenticated SSE is cancelled at 60 seconds and reopens read-only after the existing two-second delay', async t => {
  const f = await fixture(t), epoch = accountGeneration();
  assert.equal(f.connections.at(-1), 'online'); assert.equal(f.client.view.revision, 1);
  // Fresh same-identity polling cannot prove the original stream is receiving bytes.
  for (let index = 0; index < 3; index++) { f.timers.tick(15000); await loadAccount(); await settle(); }
  assert.equal(f.sources.length, 1); assert.equal(f.sources[0].signal.aborted, false);
  f.timers.tick(14999); await settle(); assert.equal(f.connections.at(-1), 'online');
  f.timers.tick(1); await settle();
  assert.equal(f.connections.at(-1), 'offline'); assert.equal(f.sources[0].signal.aborted, true);
  assert.equal(f.sources[0].cancellations, 1); assert.equal(f.sources[0].body.locked, false);
  assert.equal(f.errors.length, 0); assert.equal(accountGeneration(), epoch); assert.equal(accountState().authenticated, true);
  f.timers.tick(1999); await settle(); assert.equal(f.sources.length, 1);
  f.timers.tick(1); await settle(); assert.equal(f.sources.length, 2);
  assert.equal(f.connections.at(-1), 'online'); assert.equal(f.client.view.revision, 2);
  assert.ok(f.calls.every(call => !['POST', 'PUT', 'DELETE'].includes(call.options.method)));
  assert.ok(f.calls.filter(call => call.url.endsWith('/events')).every(call => call.options.credentials === 'same-origin' && !call.options.headers.Authorization));
});

test('server pings and fragmented UTF-8 private events renew only the current stream deadline', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 6; index++) {
    f.timers.tick(20000); f.sources[0].push(': ping\n\n'); await settle();
  }
  assert.equal(f.sources.length, 1); assert.equal(f.connections.at(-1), 'online');
  f.timers.tick(59000); f.sources[0].push('event: view\ndata: '); await settle();
  f.timers.tick(59000); f.sources[0].push(JSON.stringify({ roomCode: CODE, roomId: 'synthetic-room', selfId: 'self', revision: 8, name: '牌友' }) + '\n\n'); await settle();
  assert.equal(f.client.view.revision, 8); assert.equal(f.sources.length, 1);
  f.timers.tick(59999); await settle(); assert.equal(f.connections.at(-1), 'online');
  f.timers.tick(1); await settle(); assert.equal(f.connections.at(-1), 'offline');
});

test('a hanging stream-source cancellation cannot block reconnect scheduling', async t => {
  const f = await fixture(t, { cancelPending: true });
  f.timers.tick(60000); await settle();
  assert.equal(f.sources[0].cancellations, 1); assert.equal(f.sources[0].signal.aborted, true);
  assert.equal(f.connections.at(-1), 'offline');
  f.timers.tick(2000); await settle(); assert.equal(f.sources.length, 2);
});

test('empty byte chunks cannot keep a silent stream marked online', async t => {
  const f = await fixture(t); f.timers.tick(55000);
  f.sources[0].push(''); await settle();
  f.timers.tick(5000); await settle();
  assert.equal(f.connections.at(-1), 'offline'); assert.equal(f.sources[0].cancellations, 1);
});

test('a transport that ignores abort and cancellation cannot apply a delayed old read after the replacement stream', async t => {
  const f = await fixture(t); f.client.stop(); await settle();
  let resolveOldRead, reads = 0, cancelled = 0, released = 0, signal;
  const oldReader = { read() {
    if (++reads === 1) return Promise.resolve({ value: new TextEncoder().encode(packet(10)), done: false });
    return new Promise(resolve => { resolveOldRead = resolve; });
  }, cancel() { cancelled++; return Promise.resolve(); }, releaseLock() { released++; } };
  const views = [], connections = [];
  const client = new RoomClient(CODE, { playerId: 'self' }, {
    onView(value) { views.push(value); }, onConnection(value) { connections.push(value); }, onError() {},
  });
  t.after(() => client.stop());
  let streams = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (++streams === 1) { signal = options.signal; return { ok: true, body: { getReader() { return oldReader; } } }; }
    const current = source(); current.push(packet(11)); return current.response;
  });
  client.connect(); await settle(); assert.equal(client.view.revision, 10);
  f.timers.tick(60000); await settle(); assert.equal(signal.aborted, true);
  assert.equal(cancelled, 1); assert.equal(released, 1);
  f.timers.tick(2000); await settle(); assert.equal(client.view.revision, 11);
  resolveOldRead({ value: new TextEncoder().encode(packet(999)), done: false }); await settle();
  assert.deepEqual(views.map(value => value.revision), [10, 11]); assert.equal(connections.at(-1), 'online');
  assert.equal(streams, 2); assert.equal(f.timers.pending.size, 1);
});

test('background stop aborts a frozen reader and removes its deadline without reconnecting or retaining the lock', async t => {
  const f = await fixture(t); f.client.stop(); await settle();
  assert.equal(f.sources[0].signal.aborted, true); assert.equal(f.sources[0].cancellations, 1);
  assert.equal(f.sources[0].body.locked, false); assert.equal(f.timers.pending.size, 0);
  const states = f.connections.length; f.timers.tick(120000); await settle();
  assert.equal(f.sources.length, 1); assert.equal(f.connections.length, states);
});

test('replacing the current stream cancels its frozen reader and only the new stream can receive later packets', async t => {
  const f = await fixture(t); f.client.connect(); await settle();
  assert.equal(f.sources.length, 2); assert.equal(f.sources[0].cancellations, 1);
  assert.equal(f.client.view.revision, 2); assert.equal(f.sources[0].body.locked, false);
  f.timers.tick(20000); f.sources[1].push(packet(3)); await settle();
  assert.equal(f.client.view.revision, 3); f.timers.tick(40000); await settle();
  assert.equal(f.connections.at(-1), 'online'); assert.equal(f.sources.length, 2);
  assert.equal(f.timers.pending.size, 1);
});

test('logout while a frozen reader waits removes the old private view and every stream timer', async t => {
  const f = await fixture(t); await logoutAccount(); await settle();
  assert.equal(f.client.stopped, true); assert.equal(f.client.view, null);
  assert.equal(f.sources[0].signal.aborted, true); assert.equal(f.sources[0].cancellations, 1);
  assert.equal(f.sources[0].body.locked, false); assert.equal(f.timers.pending.size, 0);
  assert.equal(f.errors.at(-1).status, 401); assert.equal(accountState().authenticated, false);
  f.timers.tick(120000); await settle(); assert.equal(f.sources.length, 1);
});

test('identity failures on the replacement SSE still clear private state and never schedule another retry', async t => {
  for (const status of [401, 503]) {
    const f = await fixture(t); f.timers.tick(60000); await settle();
    t.mock.method(globalThis, 'fetch', async () => json({ error: 'synthetic identity failure' }, status));
    f.timers.tick(2000); await settle();
    assert.equal(f.client.view, null); assert.equal(f.client.stopped, true); assert.equal(f.errors.at(-1).status, status);
    assert.equal(f.timers.pending.size, 0); assert.equal(accountState().authenticated, false);
    assert.equal(accountState().failureStatus, status);
  }
});
