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
import { CANVAS_SCOPE } from '../server/games/draw-and-guess/canvas-service.mjs';

const signing = generateKeyPairSync('ed25519');
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const packets = (response, type) => response.res.frames.filter(frame => frame.startsWith(`event: ${type}\n`))
  .map(frame => JSON.parse(frame.split('\ndata: ')[1].split('\n\n')[0]));
async function until(predicate, message) {
  const end = performance.now() + 2000;
  while (!predicate()) { assert.ok(performance.now() < end, message); await nextTurn(); }
}

// Real BFF, rules, session CAS, encrypted adapters, output fences and batch
// collector/signatures. The central reply and HTTP sink are synthetic; this is
// not a Cognito JWT, public endpoint, capacity or browser-performance test.
async function fixture(t, sqlite) {
  let time = Date.now(); const now = () => time;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(':memory:', { now }) : new MemoryAdapter({ now }), randomBytes(32), now);
  const sub = 'synthetic-renewal-host', userKey = identityKey(SHARED_ISSUER, sub), id = opaqueId(), csrf = opaqueId();
  const checks = [], wire = [], identities = new Map(), control = { nextStatus: null, afterPolicy: null, responseStatuses: [] };
  const client = new IdentityBatchClient({ enabled: true, keyId: 'synthetic-renewal-test', privateKey: signing.privateKey, now,
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
      const status = control.nextStatus ?? 200; control.nextStatus = null;
      control.responseStatuses.push(status);
      const response = Response.json({ version: 1, batchRef: request.batchRef,
        entries: request.entries.map(entry => {
          const identity = identities.get(entry.accessToken);
          if (status !== 200) return { ref: entry.ref, status };
          return { ref: entry.ref, status, policy: { version: 1, revokedBefore: 0,
            issuer: identity.issuer, sub: identity.sub, clientId: identity.clientId, authTime: identity.authTime } };
        }) });
      const held = control.heldReply; control.heldReply = null;
      if (held) { held.entered.resolve(); return held.release.promise.then(() => response); }
      return Promise.resolve(response);
    } });
  const sessions = new SessionService(settings, { store: storage, now, provider: { usesBatchIdentity: true,
    async check(identity, options) {
      options.context.assert(); identities.set(identity.accessToken, identity);
      checks.push({ context: options.context, identity: { ...identity } });
      const policy = await client.check(identity, options);
      await control.afterPolicy?.(identity, options.context);
      return { ...identity, ...policy };
    } } });
  await storage.put('sessions', id, { phase: 'active', issuer: SHARED_ISSUER, sub, userKey, csrf,
    accessToken: 'synthetic-renewal-token', clientId: '27oe1fs5shskll808e733lqm65', authTime: Math.floor(time / 1000) - 20,
    expiresAt: time + 3600000, idleUntil: time + settings.idleMs - 60000 }, time + settings.idleMs);
  const runtime = createRuntime(settings, { storage, sessions, drawingEnabled: true, now,
    roomOptions: { pollIntervalMs: 0, serverRandomInt: () => 0 }, chatOptions: { pollIntervalMs: 0 } });
  await runtime.wordbankReady; await runtime.canvases.ready;
  const server = createUnifiedServer(runtime), responses = [];
  t.after(async () => {
    for (const response of responses) { response.res.destroyed = true; response.res.emit('close'); }
    await Promise.allSettled(responses.map(response => response.finished));
    await server.shutdown(); client.close();
    assert.equal(client.occupancy.activeTransports, 0); assert.equal(client.occupancy.logicalWaiters, 0);
  });
  function request(path, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: path,
      headers: { host: new URL(settings.origin).host, cookie: `${settings.cookieName}=${id}`,
        ...(body === undefined ? {} : { origin: settings.origin, 'content-type': 'application/json', 'x-csrf-token': csrf }) },
      socket: { remoteAddress: '127.0.0.1' } });
    const res = new EventEmitter(), finished = deferred();
    Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false, writableLength: 0, frames: [] });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
    res.flushHeaders = () => {}; res.write = value => { res.frames.push(String(value)); return true; };
    res.end = value => { res.body = value ? JSON.parse(String(value)) : null; res.writableEnded = true; finished.resolve(); };
    server.emit('request', req, res); const response = { req, res, finished: finished.promise }; responses.push(response); return response;
  }
  async function room(drawing = false) {
    const room = await runtime.rooms.createRoom(userKey, '合成续期画者', randomUUID(), drawing ? 'draw-and-guess' : 'rummikub');
    if (!drawing) return room;
    const guest = identityKey(SHARED_ISSUER, 'synthetic-renewal-guesser');
    await runtime.rooms.joinRoom(room.roomCode, guest, '合成猜者', randomUUID());
    const act = async (actor, type, fields = {}) => {
      const view = await runtime.rooms.getView(room.roomCode, actor);
      return runtime.rooms.action(room.roomCode, actor, { type, requestId: randomUUID(), expectedRevision: view.revision, ...fields });
    };
    await act(userKey, 'ready', { ready: true }); await act(guest, 'ready', { ready: true }); await act(userKey, 'start');
    const view = await runtime.rooms.getView(room.roomCode, userKey);
    await act(userKey, 'choose', { matchId: view.matchId, turnId: view.game.turnId, candidateId: view.game.candidates[0].id });
    return room;
  }
  async function editSession(change) {
    const before = await storage.read('sessions', id), value = { ...before.value }; change(value);
    assert.equal(await storage.replaceCAS('sessions', id, before.version, value, before.expiresAt), true);
    const after = await storage.read('sessions', id); assert.notEqual(after.version, before.version); return { before, after };
  }
  async function canvasInput(room) {
    const canvas = await runtime.canvases.read(room.roomCode, userKey), deviceId = 'synthetic-renewal-device';
    const acquired = request(`/api/rooms/${room.roomCode}/canvas/acquire`, { deviceId, canvasId: canvas.canvasId, bootId: canvas.bootId });
    await acquired.finished; assert.equal(acquired.res.status, 200); const lease = acquired.res.body;
    return { lease, body: { deviceId, canvasId: lease.canvasId, bootId: lease.bootId, leaseGeneration: lease.leaseGeneration,
      clearGeneration: lease.clearGeneration, expectedSequence: lease.sequence, requestId: 'renewal-append-once',
      operations: [{ strokeId: 'renewal-stroke', tool: 'pen', color: '#182a33', width: 4, points: [[.1, .2], [.2, .3]] }] } };
  }
  return { storage, sessions, runtime, client, id, userKey, checks, wire, control, request, room, editSession, canvasInput,
    now, setTime: value => { time = value; } };
}

async function closedStream(response, expectedStatus) {
  await response.finished; await nextTurn();
  assert.deepEqual(packets(response, 'view'), []);
  assert.deepEqual(packets(response, 'chat'), []);
  assert.deepEqual(packets(response, 'canvas'), []);
  assert.equal(packets(response, 'closed').at(-1)?.status, expectedStatus);
}
const checksFor = (f, gate) => f.checks.filter(check => check.context === gate.context);
async function committedOnce(f, lease, writes) {
  const saved = (await f.storage.read(CANVAS_SCOPE, lease.canvasId)).value;
  assert.equal(writes(), 1); assert.equal(saved.sequence, 1); assert.equal(saved.strokes.length, 1);
  assert.equal(Object.keys(saved.requests).length, 1); return saved;
}

// The mutation is at the existing final verifier call, after assertCurrent's
// session read, and before the real Memory/SQLite multi-record validation.
// No verifier result is substituted. Only this session's idle field is changed.
function renewAtAtomicGuard(f) {
  const assertCurrent = f.sessions.assertCurrent.bind(f.sessions);
  const verifyGuards = f.storage.verifyGuards.bind(f.storage);
  let context, attempts = 0, mutations = 0;
  const results = [], lineages = [];
  f.sessions.assertCurrent = async (session, options) => {
    context ??= options.context; if (options.context === context) attempts++;
    return assertCurrent(session, options);
  };
  f.storage.verifyGuards = async input => {
    const sessionGuard = input.guards.find(guard => guard.scope === 'sessions' && guard.id === f.id);
    if (sessionGuard && !mutations++) {
      const before = await f.storage.read('sessions', f.id);
      assert.equal(sessionGuard.expectedVersion, before.version, 'the initial local session-version check really passed');
      const changed = await f.editSession(value => { value.idleUntil += 1000; });
      assert.deepEqual({ ...changed.after.value, idleUntil: changed.before.value.idleUntil }, changed.before.value);
      const beforeLineage = f.sessions.publicSession(f.id, changed.before.value, changed.before.version).authorizationLineage;
      const afterLineage = f.sessions.publicSession(f.id, changed.after.value, changed.after.version).authorizationLineage;
      assert.equal(beforeLineage, afterLineage); lineages.push(beforeLineage, afterLineage);
    }
    const actual = await verifyGuards(input); results.push(actual); return actual;
  };
  return { results, lineages, get context() { return context; }, get attempts() { return attempts; } };
}

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  test(`${adapter}: idle CAS between session read and real atomic guard recovers one SSE output with an independent fresh`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), gate = renewAtAtomicGuard(f);
    const response = f.request(`/api/rooms/${room.roomCode}/events`);
    await until(() => response.res.writableEnded || packets(response, 'view').length, 'SSE atomic output did not settle');
    assert.equal(gate.results[0], false, 'the original real atomic validator rejected the changed session revision');
    assert.equal(gate.lineages.length, 2);
    assert.deepEqual(packets(response, 'closed'), [], 'a single idle-only atomic session conflict must recover rather than close 503');
    assert.equal(packets(response, 'view').length, 1); assert.equal(gate.attempts, 2);
    const online = checksFor(f, gate); assert.equal(online.length, 2);
    assert.ok(online.every(check => check.context === gate.context));
    assert.equal(gate.context.deadlineMs - gate.context.triggeredAtMs, 8000);
    const entries = f.wire.flatMap(batch => batch.entries).filter(entry => entry.triggeredAtMs === gate.context.triggeredAtMs);
    assert.ok(entries.length >= 2); assert.equal(new Set(entries.map(entry => entry.ref)).size, entries.length);
    assert.ok(await f.storage.read('sessions', f.id));
  });

  test(`${adapter}: idle CAS between session read and real atomic guard recovers the already committed canvas acknowledgement without replay`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(true), { lease, body } = await f.canvasInput(room);
    const append = f.runtime.canvases.append.bind(f.runtime.canvases); let writes = 0;
    f.runtime.canvases.append = (...args) => { writes++; return append(...args); };
    f.checks.length = 0; f.wire.length = 0; const gate = renewAtAtomicGuard(f);
    const response = f.request(`/api/rooms/${room.roomCode}/canvas/append`, body); await response.finished;
    await committedOnce(f, lease, () => writes);
    assert.equal(gate.results[0], false, 'the original atomic validator, not a stub, rejected the session CAS');
    assert.equal(gate.lineages.length, 2);
    assert.equal(response.res.status, 200, 'one idle-only atomic conflict must not suppress a committed acknowledgement');
    assert.equal(response.res.body.ack.sequence, 1); assert.equal(gate.attempts, 2);
    assert.equal(f.checks.length, 3); assert.ok(f.checks.every(check => check.context === gate.context));
    const entries = f.wire.flatMap(batch => batch.entries);
    assert.equal(entries.length, 3); assert.equal(new Set(entries.map(entry => entry.ref)).size, 3);
    assert.ok(entries.every(entry => entry.triggeredAtMs === gate.context.triggeredAtMs && entry.deadlineMs === gate.context.deadlineMs));
    assert.equal(gate.context.deadlineMs - gate.context.triggeredAtMs, 8000);
    assert.ok(await f.storage.read('sessions', f.id));
  });
}

function atomicWindow(f, inject, afterResult) {
  const actualAssertion = f.sessions.assertCurrent.bind(f.sessions), verify = f.storage.verifyGuards.bind(f.storage);
  let context, attempts = 0, calls = 0; const results = [], bindings = [];
  f.sessions.assertCurrent = async (session, options) => {
    context ??= options.context;
    if (options.context === context) {
      attempts++; bindings.push({ id: session.id, userKey: session.userKey, issuer: session.issuer,
        sub: session.sub, lineage: session.authorizationLineage });
    }
    return actualAssertion(session, options);
  };
  f.storage.verifyGuards = async input => {
    const index = calls++;
    const saved = await f.storage.read('sessions', f.id);
    const guard = input.guards.find(value => value.scope === 'sessions' && value.id === f.id);
    assert.equal(guard.expectedVersion, saved.version, 'mutation is after the session snapshot passed its initial version check');
    await inject(index, input, context);
    const result = await verify(input); results.push(result);
    return afterResult ? afterResult(result, index, context) : result;
  };
  return { results, bindings, get context() { return context; }, get attempts() { return attempts; } };
}

async function consumer(f, canvas) {
  const room = await f.room(canvas); let lease, body, writes = 0;
  if (canvas) {
    ({ lease, body } = await f.canvasInput(room));
    const append = f.runtime.canvases.append.bind(f.runtime.canvases);
    f.runtime.canvases.append = (...args) => { writes++; return append(...args); };
  }
  f.checks.length = 0; f.wire.length = 0;
  return { room, canvas, lease,
    start: () => f.request(`/api/rooms/${room.roomCode}/${canvas ? 'canvas/append' : 'events'}`, body),
    committed: () => canvas ? committedOnce(f, lease, () => writes) : Promise.resolve(),
    async refused(response, status) {
      if (canvas) { await response.finished; assert.equal(response.res.status, status); assert.equal('ack' in response.res.body, false); }
      else await closedStream(response, status);
      await this.committed();
    } };
}

async function changeRoom(f, room) {
  const row = await f.storage.read('rooms', room.view.roomId); row.value.snapshot.lastActiveAt++;
  assert.equal(await f.storage.replaceCAS('rooms', room.view.roomId, row.version, row.value, row.expiresAt), true);
}

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  for (const canvas of [false, true]) {
    const output = canvas ? 'committed canvas HTTP' : 'SSE';
    for (const change of ['csrf', 'accessToken', 'subject', 'expiry', 'delete']) {
      test(`${adapter}: atomic ${change} changes refuse ${output} with no recovery grant or domain replay`, { timeout: 4000 }, async t => {
        const f = await fixture(t, sqlite), sink = await consumer(f, canvas);
        const gate = atomicWindow(f, async index => {
          if (index) return;
          if (change === 'delete') assert.equal(await f.storage.remove('sessions', f.id), true);
          else await f.editSession(value => {
            if (change === 'subject') value.sub = 'different-atomic-subject';
            else if (change === 'expiry') value.expiresAt = f.now() - 1;
            else value[change] = `different-atomic-${change}`;
          });
        });
        const response = sink.start(); await sink.refused(response, ['csrf', 'accessToken'].includes(change) ? 503 : 401);
        assert.equal(gate.results[0], false); assert.equal(gate.attempts, 1);
        assert.equal(checksFor(f, gate).length, canvas ? 2 : 1);
      });
    }

    for (const status of [401, 503]) {
      test(`${adapter}: atomic idle renewal followed by central ${status} refuses ${output} without a second recovery`, { timeout: 4000 }, async t => {
        const f = await fixture(t, sqlite), sink = await consumer(f, canvas);
        const gate = atomicWindow(f, async index => {
          if (index) return;
          await f.editSession(value => { value.idleUntil += 1000; }); f.control.nextStatus = status;
        });
        const response = sink.start(); await sink.refused(response, status);
        assert.deepEqual(gate.results, [false]); assert.equal(gate.attempts, 1);
        assert.equal(checksFor(f, gate).length, canvas ? 3 : 2);
        assert.equal(Boolean(await f.storage.read('sessions', f.id)), status === 503);
      });
    }
  }

  test(`${adapter}: a same-session atomic room guard conflict rereads current room authority without another fresh`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), sink = await consumer(f, false);
    const gate = atomicWindow(f, index => index === 0 ? changeRoom(f, sink.room) : undefined);
    const response = sink.start(); await until(() => response.res.writableEnded || packets(response, 'view').length, 'room-only output did not settle');
    assert.deepEqual(packets(response, 'closed'), []); assert.equal(packets(response, 'view').length, 1);
    assert.deepEqual(gate.results.slice(0, 2), [false, true]); assert.equal(gate.attempts, 2);
    assert.equal(checksFor(f, gate).length, 1); assert.deepEqual(gate.bindings[0], gate.bindings[1]);
  });

  for (const sequence of ['session-session', 'session-room', 'room-session']) {
    test(`${adapter}: atomic ${sequence} conflicts share one total recovery and cannot prepare a third SSE output`, { timeout: 4000 }, async t => {
      const f = await fixture(t, sqlite), sink = await consumer(f, false), owners = sequence.split('-');
      const gate = atomicWindow(f, async index => {
        assert.ok(index < 2, 'no third atomic output validation may start');
        if (owners[index] === 'room') await changeRoom(f, sink.room);
        else await f.editSession(value => { value.idleUntil += 1000; });
      });
      const response = sink.start(); await sink.refused(response, 503);
      assert.deepEqual(gate.results, [false, false]); assert.equal(gate.attempts, 2);
      assert.equal(checksFor(f, gate).length, owners[0] === 'session' ? 2 : 1);
      assert.deepEqual(gate.bindings[0], gate.bindings[1]);
      assert.ok(await f.storage.read('sessions', f.id));
    });
  }

  for (const fault of ['unknown validator', 'validator exception', 'busy classification read', 'unknown classification read']) {
    test(`${adapter}: ${fault} after the atomic window cannot acquire a recovery policy`, { timeout: 4000 }, async t => {
      const f = await fixture(t, sqlite), sink = await consumer(f, true), read = f.storage.read.bind(f.storage);
      let afterFalse = false, classificationReads = 0;
      f.storage.read = (...args) => {
        if (afterFalse && args[0] === 'sessions' && args[1] === f.id) {
          classificationReads++;
          if (fault.includes('classification read')) {
            const failure = new Error(fault.startsWith('busy') ? 'synthetic database is locked' : 'synthetic read result unknown');
            if (fault.startsWith('busy')) failure.code = 'SQLITE_BUSY';
            throw failure;
          }
        }
        return read(...args);
      };
      const gate = atomicWindow(f, index => index === 0 ? f.editSession(value => { value.idleUntil += 1000; }) : undefined,
        result => {
          assert.equal(result, false); afterFalse = true;
          if (fault === 'unknown validator') return undefined;
          if (fault === 'validator exception') throw new Error('synthetic validator failed after an unknown result');
          return result;
        });
      const response = sink.start(); await sink.refused(response, 503);
      assert.equal(gate.attempts, 1); assert.equal(checksFor(f, gate).length, 2);
      assert.equal(classificationReads, fault.includes('classification read') ? 1 : 0);
    });
  }

  for (const stop of ['cancel', 'deadline']) {
    test(`${adapter}: ${stop} during the actual post-false session read suppresses the committed ack without pretending that read settled`, { timeout: 4000 }, async t => {
      const f = await fixture(t, sqlite), sink = await consumer(f, true), read = f.storage.read.bind(f.storage);
      const entered = deferred(), release = deferred(); let afterFalse = false, intercepted = false, finished = false;
      f.storage.read = async (...args) => {
        const value = await read(...args);
        if (afterFalse && !intercepted && args[0] === 'sessions' && args[1] === f.id) {
          intercepted = true; entered.resolve(); await release.promise; finished = true;
        }
        return value;
      };
      const gate = atomicWindow(f, index => index === 0 ? f.editSession(value => { value.idleUntil += 1000; }) : undefined,
        result => { afterFalse = true; return result; });
      const response = sink.start();
      try {
        await entered.promise;
        if (stop === 'cancel') response.req.emit('aborted');
        else gate.context.restrict(Math.min(8000, Math.ceil(8000 - gate.context.remainingMs()) + 5));
        await sink.refused(response, 503);
        assert.equal(finished, false); assert.equal(gate.attempts, 1); assert.equal(checksFor(f, gate).length, 2);
        assert.equal(gate.context.signal.aborted, true);
      } finally { release.resolve(); await nextTurn(); }
      assert.equal(finished, true); await sink.committed();
    });
  }

  test(`${adapter}: cancelling a recovery with a noncooperative batch fetch keeps its exact owner until actual settlement`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), sink = await consumer(f, true), entered = deferred(), release = deferred();
    const gate = atomicWindow(f, async index => {
      if (index) return;
      await f.editSession(value => { value.idleUntil += 1000; }); f.control.heldReply = { entered, release };
    });
    const response = sink.start();
    try {
      await entered.promise; response.req.emit('aborted'); await sink.refused(response, 503);
      assert.equal(gate.attempts, 1); assert.equal(checksFor(f, gate).length, 3);
      assert.equal(f.client.occupancy.activeTransports, 1); assert.equal(f.client.occupancy.tombstones, 1);
      assert.ok(f.client.occupancy.residentBytes > 0);
    } finally { release.resolve(); }
    await until(() => f.client.occupancy.activeTransports === 0, 'the actual deferred batch fetch did not settle');
    assert.equal(f.client.occupancy.logicalWaiters, 0); await sink.committed();
  });
}
