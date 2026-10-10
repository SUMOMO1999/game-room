import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { readSettings } from '../../server/config.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter } from '../../server/storage.mjs';
import { MockProvider } from '../../server/auth.mjs';
import { createRuntime } from '../../server/runtime.mjs';
import { createUnifiedServer } from '../../server/unified-http.mjs';


// These are real HTTP, SessionService, encrypted storage, room and SSE paths.
// Only the upstream identity provider is synthetic; this is not real SSO evidence.
export async function createHyakkiHttpFixture(t, { enabled = true, storagePath = null, wallClock = false } = {}) {
  let at = Date.now(); const origin = at, now = () => wallClock ? Date.now() + at - origin : at;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_HYAKKI_ENABLED: enabled ? '1' : '0' });
  const storage = new EncryptedStore(storagePath ? new SQLiteAdapter(storagePath, { now }) : new MemoryAdapter({ now }), randomBytes(32), now);
  const provider = new MockProvider(settings, { now });
  provider.complete = async () => ({ issuer: 'urn:hyakki-room-http', sub: provider.member,
    accessToken: 'synthetic-private-room-token', expiresAt: now() + 3600000 });
  const metrics = { identityChecks: 0, requests: 0, requestBytes: 0, responseBytes: 0, latencies: [] };
  provider.check = async identity => { metrics.identityChecks++; if (provider.unavailable) throw Object.assign(new Error('synthetic unavailable'), { status: 503 }); return { sub: identity.sub }; };
  const runtime = createRuntime(settings, { storage, provider, now,
    roomOptions: { pollIntervalMs: wallClock ? 1000 : 0, serverRandomInt: max => max - 1 },
    chatOptions: { pollIntervalMs: 0 } });
  const events = runtime.hyakkiEvents, hooks = {};
  runtime.hyakkiEvents = { ...events, async readPage(input) { const result = await events.readPage(input); await hooks.afterPage?.(); return result; } };
  const server = createUnifiedServer(runtime), streams = [];
  t.after(async () => { for (const stream of streams) await stream.close(); server.closeAllConnections(); await server.shutdown(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  settings.origin = base; settings.callback = `${base}/auth/callback`; settings.postLogout = `${base}/`;
  async function request(path, member = {}, body) {
    const started = performance.now(); metrics.requests++; metrics.requestBytes += body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body));
    const response = await fetch(base + path, { redirect: 'manual', method: body === undefined ? 'GET' : 'POST',
      headers: { ...(member.cookie ? { Cookie: member.cookie } : {}),
        ...(body === undefined ? {} : { Origin: base, 'X-CSRF-Token': member.csrf ?? '', 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); metrics.responseBytes += Buffer.byteLength(text); metrics.latencies.push(performance.now() - started);
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, text };
  }
  async function login(sub) {
    provider.member = sub;
    const start = await request('/auth/login'), destination = new URL(start.headers.get('location'));
    const callback = await request(destination.pathname + destination.search, { cookie: start.headers.getSetCookie()[0].split(';')[0] });
    assert.equal(callback.status, 303);
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith(`${settings.cookieName}=`)).split(';')[0];
    const state = await request('/api/state', { cookie }); assert.equal(state.status, 200);
    return { cookie, csrf: state.body.csrf, state: state.body };
  }
  async function listen(code, member) {
    const cancellation = new AbortController();
    const response = await fetch(`${base}/api/rooms/${code}/events`, { headers: { Cookie: member.cookie }, signal: cancellation.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder(), packets = [], waiters = new Set(); let buffer = '', bytes = 0;
    const reading = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
            if (!event || !data) continue;
            const packet = { event, data: JSON.parse(data) }; packets.push(packet);
            for (const wake of [...waiters]) wake(packet);
          }
        }
      } catch (error) { if (!cancellation.signal.aborted) throw error; }
    })();
    // Observe the read immediately; a failed stream must not create an unhandled rejection.
    let readError = null; reading.catch(error => { readError = error; });
    const stream = { packets, get bytes() { return bytes; },
      wait(predicate) {
        const existing = packets.find(predicate); if (existing) return Promise.resolve(existing);
        if (readError) return Promise.reject(readError);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { waiters.delete(wake); reject(readError ?? new Error('SSE packet was not received within 3 seconds')); }, 3000);
          const wake = packet => { if (predicate(packet)) { clearTimeout(timeout); waiters.delete(wake); resolve(packet); } };
          waiters.add(wake);
        });
      },
      async close() { cancellation.abort(); await reader.cancel().catch(() => {}); await reading.catch(() => {}); },
    };
    streams.push(stream); return stream;
  }
  const view = async (code, member) => { const response = await request(`/api/rooms/${code}`, member); assert.equal(response.status, 200, response.text); return response.body.view; };
  async function action(code, member, type, extra = {}) {
    const current = await view(code, member);
    const body = { type, requestId: randomUUID(), expectedRevision: current.revision,
      ...(current.game && !['ready', 'start', 'configure', 'pause', 'resume', 'leave', 'reset'].includes(type) ? { matchId: current.matchId, turnId: current.game.turnId,
        ...(current.game.pending ? { effectId: current.game.pending.id, decisionId: current.game.pending.decisionId } : {}) } : {}), ...extra };
    const response = await request(`/api/rooms/${code}/actions`, member, body);
    assert.equal(response.status, 200, response.text); return { ...response.body, input: body };
  }
  return { metrics, base, streams, runtime, request, login, listen, view, action, hooks, provider, advance: ms => { at += ms; } };
}
