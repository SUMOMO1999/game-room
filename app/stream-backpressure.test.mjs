import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { readSettings } from '../server/config.mjs';
import { MockProvider, IdentityFailure } from '../server/auth.mjs';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 3; ++i) await new Promise(resolve => setImmediate(resolve)); };

// Real local HTTP/SSE and production session/room/chat services, with synthetic
// identities and memory-only data. No AWS, central account or production DB.
async function fixture(t) {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const provider = new MockProvider(settings); provider.status = 200; provider.block = null;
  provider.complete = async () => ({ issuer: 'urn:stream-fixture', sub: 'fictional-stream-player',
    accessToken: 'synthetic-stream-only', expiresAt: Date.now() + 3600000 });
  provider.check = async identity => {
    await provider.block?.promise;
    if (provider.status !== 200) throw new IdentityFailure(provider.status);
    return { sub: identity.sub };
  };
  const storage = new EncryptedStore(new MemoryAdapter(), randomBytes(32));
  const runtime = createRuntime(settings, { storage, provider, roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  const server = createUnifiedServer(runtime);
  let bufferedBytes = null;
  server.on('request', (request, response) => {
    // Deterministic outbound boundary injection on a real response; this does
    // not claim to reproduce a physical network's throughput or kernel buffer.
    if (request.url.includes('/events')) Object.defineProperty(response, 'writableLength', {
      configurable: true, get: () => bufferedBytes ?? response.socket?.writableLength ?? 0,
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  settings.origin = origin; settings.callback = origin + '/auth/callback';
  t.after(async () => { provider.block?.resolve(); await server.shutdown(); });
  async function request(path, { cookie, csrf, method = 'GET', body } = {}) {
    const response = await fetch(origin + path, { method, redirect: 'manual', headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: origin }),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); return { response, body: text ? JSON.parse(text) : null };
  }
  const login = await request('/auth/login');
  const transaction = login.response.headers.getSetCookie()[0].split(';')[0];
  const callbackURL = new URL(login.response.headers.get('location'));
  const callback = await request(callbackURL.pathname + callbackURL.search, { cookie: transaction });
  assert.equal(callback.response.status, 303);
  const cookie = callback.response.headers.getSetCookie().find(value => value.startsWith(settings.cookieName + '=')).split(';')[0];
  const account = (await request('/api/state', { cookie })).body;
  const auth = { cookie, csrf: account.csrf };
  const created = await request('/api/rooms', { ...auth, method: 'POST', body: { name: '合成朋友', requestId: randomUUID() } });
  assert.equal(created.response.status, 201);
  const code = created.body.roomCode, userKey = account.userKey, room = created.body;
  async function ready(value) {
    const current = await runtime.rooms.getView(code, userKey);
    return runtime.rooms.action(code, userKey, { type: 'ready', ready: value, requestId: randomUUID(), expectedRevision: current.revision });
  }
  return { runtime, provider, request, auth, account, code, userKey, room, ready,
    setBufferedBytes(value) { bufferedBytes = value; },
    async stream() {
      const controller = new AbortController(); t.after(() => controller.abort());
      const response = await fetch(origin + `/api/rooms/${code}/events`, { headers: { Cookie: cookie }, signal: controller.signal });
      assert.equal(response.status, 200); const reader = response.body.getReader(); let text = '', ended = false;
      async function readUntil(predicate) {
        const deadline = setTimeout(() => controller.abort(), 3000);
        try {
          while (!predicate(text, ended)) {
            const chunk = await reader.read();
            if (chunk.done) { ended = true; break; }
            text += new TextDecoder().decode(chunk.value);
          }
          assert.ok(predicate(text, ended), text); return text;
        } finally { clearTimeout(deadline); }
      }
      await readUntil(value => value.includes('event: view') && value.includes('event: chat')); await settle();
      return { reader, readUntil, text: () => text, ended: () => ended };
    },
  };
}

test('ordered chat backlog ends only its slow stream by EOF, retaining account, stable seat and committed messages', async t => {
  const f = await fixture(t), stream = await f.stream(), invalidations = [];
  const unsubscribe = f.runtime.sessions.subscribeInvalidation(event => invalidations.push(event)); t.after(unsubscribe);
  const initial = stream.text(); f.provider.block = deferred();
  for (let i = 0; i < 5; ++i) await f.runtime.chat.send(f.code, f.userKey, { text: `合成消息${i}`, requestId: randomUUID() });
  const text = await stream.readUntil((_, ended) => ended);
  assert.equal(text, initial); assert.ok(!text.includes('event: closed')); assert.deepEqual(invalidations, []);
  f.provider.block.resolve(); f.provider.block = null; await settle();
  assert.equal((await f.request('/api/state', f.auth)).body.userKey, f.account.userKey);
  assert.equal((await f.request(`/api/rooms/${f.code}`, f.auth)).body.view.selfId, f.room.playerId);
  assert.equal((await f.request(`/api/rooms/${f.code}/chat`, f.auth)).body.messages.length, 5);
  const restored = await f.stream(); assert.equal(restored.ended(), false); await restored.reader.cancel();
});

test('the outbound byte limit closes transport without an identity failure or deleting the room', async t => {
  const f = await fixture(t), stream = await f.stream(), initial = stream.text();
  f.setBufferedBytes(524289); await f.ready(true);
  const text = await stream.readUntil((_, ended) => ended);
  assert.equal(text, initial); assert.ok(!text.includes('event: closed'));
  f.setBufferedBytes(null);
  const state = (await f.request('/api/state', f.auth)).body; assert.equal(state.authenticated, true);
  const view = (await f.request(`/api/rooms/${f.code}`, f.auth)).body.view;
  assert.equal(view.selfId, f.room.playerId); assert.equal(view.players[0].ready, true);
});

test('high-frequency committed views collapse to the latest state while a slow fresh identity check is pending', async t => {
  const f = await fixture(t), stream = await f.stream(), initial = stream.text();
  f.provider.block = deferred();
  for (let i = 0; i < 40; ++i) await f.ready(i % 2 === 0);
  const latest = await f.runtime.rooms.getView(f.code, f.userKey);
  f.provider.block.resolve(); f.provider.block = null;
  const text = await stream.readUntil(value => value.slice(initial.length).includes(`"revision":${latest.revision}`));
  assert.ok(!text.includes('event: closed')); assert.equal(stream.ended(), false);
  const packets = text.slice(initial.length).split('\n\n').filter(value => value.startsWith('event: view'));
  assert.ok(packets.length <= 2); await stream.reader.cancel();
});

test('fresh identity 401 and 503 still emit authoritative closed events and never become transport recovery', async t => {
  for (const status of [401, 503]) {
    const f = await fixture(t), stream = await f.stream(), initial = stream.text();
    f.provider.status = status; await f.ready(true);
    const text = await stream.readUntil((_, ended) => ended);
    assert.match(text.slice(initial.length), new RegExp(`event: closed\\ndata: .*"status":${status}`));
    assert.ok(!text.slice(initial.length).includes('event: view'));
  }
});
