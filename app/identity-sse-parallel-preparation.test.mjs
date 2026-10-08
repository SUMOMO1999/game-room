import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readSettings, SHARED_ISSUER } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { SessionService } from '../server/session-service.mjs';
import { IdentityBatchClient } from '../server/identity-batch-client.mjs';
import { IDENTITY_BATCH_ENDPOINT } from '../server/identity-batch-wire.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { RoomError } from './rooms.mjs';

const signing = generateKeyPairSync('ed25519');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const packets = (response, type) => response.res.frames.filter(frame => frame.startsWith(`event: ${type}\n`))
  .map(frame => JSON.parse(frame.split('\ndata: ')[1].split('\n\n')[0]));
async function until(predicate, message) {
  const end = performance.now() + 2000;
  while (!predicate()) { assert.ok(performance.now() < end, message); await nextTurn(); }
}
function noPrivateFrames(response) {
  for (const type of ['view', 'chat', 'preview', 'canvas']) assert.deepEqual(packets(response, type), []);
}
async function closed(response, status) {
  await response.finished; await nextTurn(); noPrivateFrames(response);
  assert.equal(packets(response, 'closed').at(-1)?.status, status);
}

// Actual encrypted adapters, SessionService, BFF SSE queue, room authority and
// signed batch consumer. The central response and HTTP sink are synthetic;
// this is not JWT, public endpoint, browser or capacity evidence.
async function fixture(t, sqlite, { batch = true } = {}) {
  let time = Date.now(); const now = () => time;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(':memory:', { now }) : new MemoryAdapter({ now }), randomBytes(32), now);
  const sub = 'synthetic-parallel-host', userKey = identityKey(SHARED_ISSUER, sub), id = opaqueId(), csrf = opaqueId();
  const checks = [], authorizations = [], wire = [], identities = new Map();
  const control = { fetch: null, afterPolicy: null, onAuthorized: null };
  const client = new IdentityBatchClient({ enabled: true, keyId: 'synthetic-sse-parallel', privateKey: signing.privateKey, now,
    fetcher(url, options) {
      assert.equal(url, IDENTITY_BATCH_ENDPOINT);
      const parameters = options.headers['Signature-Input'].slice('agora='.length);
      const base = ['"@method": POST', '"@scheme": https', '"@authority": agora.sumomoli.com',
        '"@path": /api/identity/batch', `"content-digest": ${options.headers['Content-Digest']}`,
        '"content-type": application/json', '"x-agora-audience": agora.identity.batch.v1',
        `"@signature-params": ${parameters}`].join('\n');
      assert.equal(verify(null, Buffer.from(base), signing.publicKey,
        Buffer.from(options.headers.Signature.slice('agora=:'.length, -1), 'base64')), true);
      const request = JSON.parse(options.body); wire.push(request);
      const reply = () => Response.json({ version: 1, batchRef: request.batchRef,
        entries: request.entries.map(entry => {
          const identity = identities.get(entry.accessToken);
          return { ref: entry.ref, status: 200, policy: { version: 1, revokedBefore: 0,
            issuer: identity.issuer, sub: identity.sub, clientId: identity.clientId, authTime: identity.authTime } };
        }) });
      return control.fetch ? control.fetch(request, options, reply) : Promise.resolve(reply());
    } });
  const sessions = new SessionService(settings, { store: storage, now, provider: { usesBatchIdentity: batch,
    async check(identity, options) {
      options.context?.assert(); identities.set(identity.accessToken, identity);
      checks.push({ context: options.context, identity: { ...identity } });
      const policy = await client.check(identity, options);
      await control.afterPolicy?.(identity, options.context);
      return { ...identity, ...policy };
    } } });
  const authorize = sessions.authorize.bind(sessions);
  sessions.authorize = async (request, options) => {
    const current = await authorize(request, options);
    authorizations.push({ current, context: options?.context });
    control.onAuthorized?.(current, options); return current;
  };
  await storage.put('sessions', id, { phase: 'active', issuer: SHARED_ISSUER, sub, userKey, csrf,
    accessToken: 'synthetic-parallel-token', clientId: '27oe1fs5shskll808e733lqm65', authTime: Math.floor(time / 1000) - 20,
    expiresAt: time + 3600000, idleUntil: time + settings.idleMs }, time + settings.idleMs);
  const runtime = createRuntime(settings, { storage, sessions, now,
    roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  const server = createUnifiedServer(runtime), responses = [];
  t.after(async () => {
    for (const response of responses) { response.res.destroyed = true; response.res.emit('close'); }
    await Promise.allSettled(responses.map(response => response.finished));
    await server.shutdown(); client.close();
    assert.equal(client.occupancy.activeTransports, 0); assert.equal(client.occupancy.logicalWaiters, 0);
  });
  function request(code) {
    const req = Readable.from([]);
    Object.assign(req, { method: 'GET', url: `/api/rooms/${code}/events`,
      headers: { host: new URL(settings.origin).host, cookie: `${settings.cookieName}=${id}` },
      socket: { remoteAddress: '127.0.0.1' } });
    const res = new EventEmitter(), finished = deferred();
    Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false, writableLength: 0, frames: [] });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
    res.flushHeaders = () => {}; res.write = value => { res.frames.push(String(value)); return true; };
    res.end = () => { res.writableEnded = true; finished.resolve(); };
    server.emit('request', req, res);
    const response = { req, res, finished: finished.promise }; responses.push(response); return response;
  }
  async function room() {
    const result = await runtime.rooms.createRoom(userKey, '合成并行画者', randomUUID());
    const guest = identityKey(SHARED_ISSUER, 'synthetic-parallel-guest');
    await runtime.rooms.joinRoom(result.roomCode, guest, '合成猜者', randomUUID());
    return { ...result, guest };
  }
  function holdPreRead() {
    const entered = deferred(), release = deferred(), actual = runtime.rooms.getGameContext.bind(runtime.rooms);
    let held = false;
    runtime.rooms.getGameContext = async (...args) => {
      const current = await actual(...args);
      if (!held && args[2]?.includeView === false) {
        held = true; entered.resolve(); await release.promise;
      }
      return current;
    };
    return { entered, release };
  }
  async function editSession(change) {
    const before = await storage.read('sessions', id), value = { ...before.value }; change(value);
    assert.equal(await storage.replaceCAS('sessions', id, before.version, value, before.expiresAt), true);
    const after = await storage.read('sessions', id); assert.notEqual(after.version, before.version); return after;
  }
  function holdFreshResult() {
    const entered = deferred(), release = deferred(); let context, held = false;
    control.afterPolicy = async (_identity, current) => {
      if (!held && checks.length === 2) { held = true; context = current; entered.resolve(); await release.promise; }
    };
    return { entered, release, get context() { return context; } };
  }
  function holdFetch() {
    const entered = deferred(), release = deferred(); let options;
    control.fetch = async (_request, current, reply) => {
      if (wire.length !== 2) return reply();
      options = current; entered.resolve(); await release.promise; return reply();
    };
    return { entered, release, get options() { return options; } };
  }
  return { storage, sessions, runtime, client, id, userKey, checks, authorizations, wire, control, request, room,
    holdPreRead, holdFreshResult, holdFetch, editSession,
    now, setTime: value => { time = value; } };
}

async function mutate(f, room, change) {
  if (change === 're-login') return f.editSession(value => { value.csrf = 'new-synthetic-login-csrf'; });
  else if (change === 'expiry') return f.editSession(value => { value.expiresAt = f.now() - 1; });
  else if (change === 'leave') {
    const view = await f.runtime.rooms.getView(room.roomCode, f.userKey);
    await f.runtime.rooms.action(room.roomCode, f.userKey, { type: 'leave', requestId: randomUUID(), expectedRevision: view.revision });
  } else if (change === 'invite') {
    const replacement = await f.runtime.rooms.createRoom(f.userKey, '替换房间', randomUUID());
    const row = await f.storage.read('rooms', replacement.view.roomId); row.value.snapshot.code = room.roomCode;
    assert.equal(await f.storage.replaceCAS('rooms', replacement.view.roomId, row.version, row.value, row.expiresAt), true);
    const invitation = await f.storage.read('room-invites', room.roomCode); invitation.value.roomId = replacement.view.roomId;
    assert.equal(await f.storage.replaceCAS('room-invites', room.roomCode, invitation.version, invitation.value, invitation.expiresAt), true);
  } else throw new Error(`Unrecognized synthetic mutation ${change}`);
}

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  test(`${adapter}: fresh starts independently while this SSE event's room pre-read is held`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), held = f.holdPreRead(), response = f.request(room.roomCode);
    try {
      await held.entered.promise;
      // Yield actual I/O turns, not a mocked scheduler or a delayed successful
      // reply. A serial await cannot invoke the real provider before release.
      await nextTurn(); await nextTurn();
      assert.equal(packets(response, 'view').length, 0, 'both independent prerequisites are still required');
      assert.equal(f.checks.filter(check => check.context !== f.checks[0].context).length, 1,
        'the event fresh, independently of handshake fresh, must start before the held room pre-read completes');
    } finally { held.release.resolve(); }
  });

  test(`${adapter}: both independent prerequisites must finish before one real view is sent`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), read = f.holdPreRead(), fresh = f.holdFetch();
    const response = f.request(room.roomCode);
    try {
      await Promise.all([read.entered.promise, fresh.entered.promise]); noPrivateFrames(response);
      assert.equal(f.client.occupancy.activeTransports, 1); assert.equal(f.checks.length, 2);
      fresh.release.resolve(); await until(() => f.authorizations.length === 2, 'event fresh did not actually complete');
      noPrivateFrames(response); assert.equal(f.client.occupancy.activeTransports, 0);
      read.release.resolve(); await until(() => packets(response, 'view').length === 1, 'jointly successful prerequisites did not emit a view');
      assert.deepEqual(packets(response, 'closed'), []);
      const entries = f.wire.flatMap(batch => batch.entries);
      assert.equal(new Set(entries.map(entry => entry.ref)).size, entries.length);
      const event = entries[1]; assert.equal(event.deadlineMs - event.triggeredAtMs, 8000);
      assert.equal(event.queueUntilMs - event.triggeredAtMs, 4000);
    } finally { read.release.resolve(); fresh.release.resolve(); }
  });

  for (const side of ['pre-read', 'fresh']) for (const change of ['re-login', 'leave', 'invite', 'expiry']) {
    test(`${adapter}: completed opposite prerequisite cannot release an old view after ${change} while ${side} is held`, { timeout: 4000 }, async t => {
      const f = await fixture(t, sqlite), room = await f.room();
      let preReads = 0;
      const read = f.runtime.rooms.getGameContext.bind(f.runtime.rooms);
      f.runtime.rooms.getGameContext = async (...args) => { const current = await read(...args); preReads++; return current; };
      const held = side === 'pre-read' ? f.holdPreRead() : f.holdFreshResult();
      const response = f.request(room.roomCode);
      try {
        await held.entered.promise;
        if (side === 'pre-read') await until(() => f.authorizations.length === 2, 'independent fresh did not complete while pre-read was held');
        else await until(() => preReads === 1, 'room pre-read did not complete while fresh was held');
        noPrivateFrames(response); const changed = await mutate(f, room, change); held.release.resolve();
        await closed(response, change === 'expiry' ? 401 : change === 're-login' ? 503 : 404);
        if (change === 're-login') assert.equal((await f.storage.read('sessions', f.id)).value.csrf, 'new-synthetic-login-csrf');
        if (change === 'expiry') {
          const saved = await f.storage.read('sessions', f.id);
          if (side === 'fresh') assert.equal(saved, null, 'authorize independently invalidates its actual expired record');
          else {
            assert.equal(saved.version, changed.version, 'the final readonly fence must not delete or rewrite the newly expired row');
            assert.equal(saved.value.expiresAt, f.now() - 1);
          }
        }
        const eventChecks = f.checks.filter(check => check.context !== f.checks[0].context);
        assert.ok(eventChecks.length >= 1); assert.ok(eventChecks.every(check => check.context === eventChecks[0].context));
      } finally { held.release.resolve(); }
    });
  }

  for (const change of ['cancel', 'deadline']) {
    test(`${adapter}: ${change} while preparation is held does not restart the event context or send a frame`, { timeout: 4000 }, async t => {
      const f = await fixture(t, sqlite), room = await f.room(), held = f.holdPreRead(), response = f.request(room.roomCode);
      try {
        await held.entered.promise; await until(() => f.authorizations.length === 2, 'fresh did not independently complete');
        const context = f.checks[1].context, originalTrigger = context.triggeredAtMs;
        assert.equal(context.deadlineMs - originalTrigger, 8000);
        if (change === 'cancel') { response.res.destroyed = true; response.res.emit('close'); }
        else assert.throws(() => context.restrict(1), error => error.status === 503);
        await response.finished; held.release.resolve(); await nextTurn();
        noPrivateFrames(response); assert.equal(context.isLive(), false);
        assert.equal(context.triggeredAtMs, originalTrigger); assert.equal(f.checks.length, 2);
        if (change === 'deadline') assert.equal(packets(response, 'closed').at(-1)?.status, 503);
      } finally { held.release.resolve(); }
    });
  }

  test(`${adapter}: a rejected preparation cancels its caller but retains a noncooperative fetch and exact ref until actual settlement`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), read = f.holdPreRead(), fresh = f.holdFetch();
    const response = f.request(room.roomCode);
    try {
      await Promise.all([read.entered.promise, fresh.entered.promise]);
      const before = f.client.occupancy, ref = f.wire[1].entries[0].ref;
      read.release.reject(new RoomError(503, 'SYNTHETIC_READ_FAILED', '合成读取失败'));
      await closed(response, 503);
      assert.equal(fresh.options.signal.aborted, true); assert.equal(f.client.occupancy.activeTransports, 1);
      assert.equal(f.client.occupancy.tombstones, 1); assert.equal(f.client.occupancy.logicalWaiters, 1);
      assert.equal(f.client.occupancy.residentBytes, before.residentBytes); assert.equal(f.wire[1].entries[0].ref, ref);
      fresh.release.resolve(); await until(() => f.client.occupancy.activeTransports === 0, 'actual fetch settlement did not release its owned transport');
      assert.equal(f.client.occupancy.logicalWaiters, 0); assert.equal(f.client.occupancy.tombstones, 0);
      assert.equal(f.wire.length, 2, 'no replacement fresh or automatic retry was sent'); noPrivateFrames(response);
    } finally { read.release.resolve(); fresh.release.resolve(); }
  });

  test(`${adapter}: a rejected preparation cannot refund a pending body reader after only its cancel settles`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), read = f.holdPreRead();
    const bodyRead = deferred(), readStarted = deferred(), bodyCancel = deferred(), cancelStarted = deferred();
    let cancelCalls = 0, releases = 0;
    f.control.fetch = (_request, _options, reply) => f.wire.length !== 2 ? Promise.resolve(reply()) : Promise.resolve({
      status: 200, ok: true, redirected: false, headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({ read() { readStarted.resolve(); return bodyRead.promise; },
        cancel() { cancelCalls++; cancelStarted.resolve(); return bodyCancel.promise; }, releaseLock() { releases++; } }) },
    });
    const response = f.request(room.roomCode);
    try {
      await Promise.all([read.entered.promise, readStarted.promise]); const bytes = f.client.occupancy.residentBytes;
      read.release.reject(new RoomError(503, 'SYNTHETIC_READ_FAILED', '合成读取失败'));
      await closed(response, 503); await cancelStarted.promise;
      assert.equal(cancelCalls, 1); assert.equal(f.client.occupancy.tombstones, 1); assert.equal(releases, 0);
      bodyCancel.resolve(); await nextTurn(); await nextTurn();
      assert.equal(f.client.occupancy.activeTransports, 1); assert.equal(f.client.occupancy.residentBytes, bytes);
      assert.equal(releases, 0, 'cancel completion cannot masquerade as read completion');
      bodyRead.resolve({ done: true }); await until(() => f.client.occupancy.activeTransports === 0, 'actual read completion did not release its transport');
      assert.equal(releases, 1); assert.equal(f.client.occupancy.logicalWaiters, 0); assert.equal(f.wire.length, 2);
    } finally { read.release.resolve(); bodyCancel.resolve(); bodyRead.resolve({ done: true }); }
  });

  test(`${adapter}: fresh failure closes the connection while preparation is unknown and observes a late preparation rejection`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), read = f.holdPreRead(), fetched = deferred();
    f.control.fetch = async (request, _options, reply) => {
      if (f.wire.length !== 2) return reply(); fetched.resolve();
      return Response.json({ version: 1, batchRef: request.batchRef, entries: request.entries.map(entry => ({ ref: entry.ref, status: 503 })) });
    };
    const response = f.request(room.roomCode);
    try {
      await Promise.all([read.entered.promise, fetched.promise]); await closed(response, 503);
      assert.equal(f.client.occupancy.activeTransports, 0); assert.ok(await f.storage.read('sessions', f.id));
      read.release.reject(new RoomError(503, 'SYNTHETIC_LATE_READ_FAILED', '迟到合成读取失败'));
      await nextTurn(); await nextTurn(); noPrivateFrames(response); assert.equal(f.wire.length, 2);
    } finally { read.release.resolve(); }
  });

  test(`${adapter}: queued chat does not start a fresh before the held view reaches completion`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room();
    await f.runtime.chat.send(room.roomCode, f.userKey, { requestId: 'queued-chat', text: '顺序合成消息' });
    const chatSubscribe = f.runtime.chat.subscribe.bind(f.runtime.chat), enqueued = deferred(); let queuedAt;
    f.runtime.chat.subscribe = (code, userKey, onChat, onEnd) => chatSubscribe(code, userKey, packet => {
      queuedAt = f.now(); onChat(packet); enqueued.resolve();
    }, onEnd);
    const read = f.holdPreRead(), response = f.request(room.roomCode);
    try {
      await Promise.all([read.entered.promise, enqueued.promise]);
      await until(() => f.authorizations.length === 2, 'first event fresh did not complete');
      // The real chat publisher delivered its packet into the same SSE queue;
      // the first job is still blocked at its own independent prerequisite.
      await nextTurn(); await nextTurn(); assert.equal(f.checks.length, 2); noPrivateFrames(response);
      f.setTime(f.now() + 50);
      read.release.resolve(); await until(() => packets(response, 'chat').length === 1, 'queued chat did not run after the view');
      assert.equal(packets(response, 'view').length, 1); assert.equal(f.checks.length, 3);
      assert.notEqual(f.checks[2].context, f.checks[1].context);
      assert.equal(f.checks[2].context.triggeredAtMs, queuedAt, 'backlog time belongs to the original enqueue budget');
      assert.equal(f.checks[2].context.deadlineMs - f.checks[2].context.triggeredAtMs, 8000);
      assert.equal(packets(response, 'chat')[0].messages[0].text, '顺序合成消息');
      assert.equal(response.res.frames.findIndex(frame => frame.startsWith('event: view\n'))
        < response.res.frames.findIndex(frame => frame.startsWith('event: chat\n')), true);
    } finally { read.release.resolve(); }
  });

  test(`${adapter}: legacy SSE retains serial room preparation before its event fresh`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite, { batch: false }), room = await f.room();
    let viewFreshChecks;
    f.control.onAuthorized = () => { if (f.authorizations.length === 2) viewFreshChecks = f.checks.length; };
    const actual = f.runtime.rooms.getView.bind(f.runtime.rooms), entered = deferred(), release = deferred(); let calls = 0;
    f.runtime.rooms.getView = async (...args) => {
      const current = await actual(...args); if (++calls === 2) { entered.resolve(); await release.promise; } return current;
    };
    const response = f.request(room.roomCode);
    try {
      await entered.promise; await nextTurn(); await nextTurn(); noPrivateFrames(response);
      assert.equal(f.checks.length, 1, 'legacy event fresh still follows its prepared room view');
      assert.ok(f.checks.every(check => check.context === undefined));
      release.resolve(); await until(() => packets(response, 'view').length === 1, 'legacy view did not follow successful serial fresh');
      assert.equal(viewFreshChecks, 2, 'only the handshake and this view fresh have run when the actual view authorization completes');
      assert.deepEqual(packets(response, 'closed'), []);
    } finally { release.resolve(); }
  });
}
