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
      return Promise.resolve(Response.json({ version: 1, batchRef: request.batchRef,
        entries: request.entries.map(entry => {
          const identity = identities.get(entry.accessToken);
          if (status !== 200) return { ref: entry.ref, status };
          return { ref: entry.ref, status, policy: { version: 1, revokedBefore: 0,
            issuer: identity.issuer, sub: identity.sub, clientId: identity.clientId, authTime: identity.authTime } };
        }) }));
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
  function renewAtOutput() {
    const assertCurrent = sessions.assertCurrent.bind(sessions); let injected = 0, context;
    sessions.assertCurrent = async (session, options) => {
      context ??= options.context;
      if (!injected++) {
        const { before, after } = await editSession(value => { value.idleUntil += 1000; });
        assert.deepEqual({ ...after.value, idleUntil: before.value.idleUntil }, before.value,
          'renewal changes only idle and storage version, not identity or credentials');
      }
      return assertCurrent(session, options);
    };
    return { get context() { return context; }, get attempts() { return injected; } };
  }
  async function canvasInput(room) {
    const canvas = await runtime.canvases.read(room.roomCode, userKey), deviceId = 'synthetic-renewal-device';
    const acquired = request(`/api/rooms/${room.roomCode}/canvas/acquire`, { deviceId, canvasId: canvas.canvasId, bootId: canvas.bootId });
    await acquired.finished; assert.equal(acquired.res.status, 200); const lease = acquired.res.body;
    return { lease, body: { deviceId, canvasId: lease.canvasId, bootId: lease.bootId, leaseGeneration: lease.leaseGeneration,
      clearGeneration: lease.clearGeneration, expectedSequence: lease.sequence, requestId: 'renewal-append-once',
      operations: [{ strokeId: 'renewal-stroke', tool: 'pen', color: '#182a33', width: 4, points: [[.1, .2], [.2, .3]] }] } };
  }
  return { storage, sessions, runtime, client, id, userKey, checks, wire, control, request, room, editSession, renewAtOutput, canvasInput,
    now, setTime: value => { time = value; } };
}

function observeOutput(f, inject) {
  const actual = f.sessions.assertCurrent.bind(f.sessions); let attempts = 0, context;
  f.sessions.assertCurrent = async (session, options) => {
    context ??= options.context;
    await inject({ attempt: attempts++, session, context: options.context });
    return actual(session, options);
  };
  return { get attempts() { return attempts; }, get context() { return context; } };
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

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  test(`${adapter}: actual SSE recovers one idle-only session renewal with an independent fresh on its original context`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), gate = f.renewAtOutput();
    const response = f.request(`/api/rooms/${room.roomCode}/events`);
    await until(() => response.res.writableEnded || packets(response, 'view').length, 'SSE did not settle its first output');
    assert.deepEqual(packets(response, 'closed'), [], 'a valid concurrent renewal must not close the game connection');
    assert.equal(packets(response, 'view').length, 1); assert.equal(gate.attempts, 2);
    assert.equal(f.checks.filter(check => check.context === gate.context).length, 2);
    assert.equal(gate.context.deadlineMs - gate.context.triggeredAtMs, 8000);
    const refs = f.wire.flatMap(batch => batch.entries.map(entry => entry.ref)); assert.equal(new Set(refs).size, refs.length);
    assert.ok(await f.storage.read('sessions', f.id));
  });

  test(`${adapter}: committed canvas HTTP recovers one idle-only renewal without appending a second time`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(true), { lease, body } = await f.canvasInput(room);
    const append = f.runtime.canvases.append.bind(f.runtime.canvases); let writes = 0;
    f.runtime.canvases.append = (...args) => { writes++; return append(...args); };
    f.checks.length = 0; f.wire.length = 0; const gate = f.renewAtOutput();
    const response = f.request(`/api/rooms/${room.roomCode}/canvas/append`, body); await response.finished;
    const saved = (await f.storage.read(CANVAS_SCOPE, lease.canvasId)).value;
    assert.equal(writes, 1); assert.equal(saved.sequence, 1); assert.equal(saved.strokes.length, 1); assert.equal(Object.keys(saved.requests).length, 1);
    assert.equal(response.res.status, 200); assert.equal(response.res.body.ack.sequence, 1); assert.equal(gate.attempts, 2);
    assert.equal(f.checks.length, 3); assert.ok(f.checks.every(check => check.context === gate.context));
    assert.equal(gate.context.deadlineMs - gate.context.triggeredAtMs, 8000);
    const entries = f.wire.flatMap(batch => batch.entries);
    assert.equal(entries.length, 3); assert.equal(new Set(entries.map(entry => entry.ref)).size, 3);
    assert.ok(entries.every(entry => entry.triggeredAtMs === gate.context.triggeredAtMs && entry.deadlineMs === gate.context.deadlineMs));
    assert.ok(await f.storage.read('sessions', f.id));
  });

  test(`${adapter}: a second SSE session version change refuses a third attempt or another fresh`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room();
    const gate = observeOutput(f, () => f.editSession(value => { value.idleUntil += 1000; }));
    const response = f.request(`/api/rooms/${room.roomCode}/events`); await closedStream(response, 503);
    assert.equal(gate.attempts, 2); assert.equal(checksFor(f, gate).length, 2);
    assert.ok(await f.storage.read('sessions', f.id));
  });

  test(`${adapter}: a second canvas session version change preserves one commit but suppresses its acknowledgement`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(true), { lease, body } = await f.canvasInput(room);
    const append = f.runtime.canvases.append.bind(f.runtime.canvases); let writes = 0;
    f.runtime.canvases.append = (...args) => { writes++; return append(...args); }; f.checks.length = 0;
    const gate = observeOutput(f, () => f.editSession(value => { value.idleUntil += 1000; }));
    const response = f.request(`/api/rooms/${room.roomCode}/canvas/append`, body); await response.finished;
    assert.equal(response.res.status, 503); assert.equal('ack' in response.res.body, false);
    assert.equal(gate.attempts, 2); assert.equal(f.checks.length, 3); assert.ok(f.checks.every(check => check.context === gate.context));
    await committedOnce(f, lease, () => writes); assert.ok(await f.storage.read('sessions', f.id));
  });

  test(`${adapter}: a different subject cannot inherit the original SSE output or renewal callback`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room();
    const gate = observeOutput(f, ({ attempt }) => attempt === 0 && f.editSession(value => {
      value.sub = 'another-synthetic-subject'; value.userKey = identityKey(value.issuer, value.sub);
      value.accessToken = 'another-synthetic-subject-token';
    }));
    const response = f.request(`/api/rooms/${room.roomCode}/events`); await closedStream(response, 401);
    assert.equal(gate.attempts, 1); assert.equal(checksFor(f, gate).length, 1);
    assert.equal((await f.storage.read('sessions', f.id)).value.sub, 'another-synthetic-subject');
  });

  for (const field of ['accessToken', 'csrf']) {
    test(`${adapter}: same-subject ${field} re-login changes cannot be mistaken for an idle renewal`, { timeout: 4000 }, async t => {
      const f = await fixture(t, sqlite), room = await f.room();
      const gate = observeOutput(f, ({ attempt }) => attempt === 0 && f.editSession(value => { value[field] = `changed-synthetic-${field}`; }));
      const response = f.request(`/api/rooms/${room.roomCode}/events`); await closedStream(response, 503);
      assert.equal(gate.attempts, 1); assert.equal(checksFor(f, gate).length, 1);
      assert.equal((await f.storage.read('sessions', f.id)).value[field], `changed-synthetic-${field}`);
    });
  }

  test(`${adapter}: same-subject re-login while the independent recovery policy settles cannot inherit the original output`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), gate = f.renewAtOutput(); let changed = false;
    f.control.afterPolicy = async (_identity, context) => {
      if (!changed && context === gate.context && checksFor(f, gate).length === 2) {
        changed = true; await f.editSession(value => { value.accessToken = 're-login-during-recovery'; });
      }
    };
    const response = f.request(`/api/rooms/${room.roomCode}/events`); await closedStream(response, 503);
    assert.equal(changed, true); assert.equal(gate.attempts, 1);
    assert.equal(checksFor(f, gate).length, 3, 'the actual authorize loop checks the new snapshot independently, but cannot rebase the old output');
    assert.equal((await f.storage.read('sessions', f.id)).value.accessToken, 're-login-during-recovery');
    const refs = f.wire.flatMap(batch => batch.entries.map(entry => entry.ref)); assert.equal(new Set(refs).size, refs.length);
  });

  test(`${adapter}: logout after fresh releases no SSE output and never starts recovery`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room();
    const gate = observeOutput(f, async ({ attempt }) => {
      if (!attempt) assert.equal(await f.sessions.invalidateCurrent(f.id, await f.storage.read('sessions', f.id)), true);
    });
    const response = f.request(`/api/rooms/${room.roomCode}/events`); await closedStream(response, 401);
    assert.equal(gate.attempts, 1); assert.equal(checksFor(f, gate).length, 1); assert.equal(await f.storage.read('sessions', f.id), null);
  });

  test(`${adapter}: a now-expired active session is not an idle-renewal conflict and releases no old SSE packet`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room();
    const gate = observeOutput(f, ({ attempt }) => attempt === 0 && f.editSession(value => { value.expiresAt = f.now() - 1; }));
    const response = f.request(`/api/rooms/${room.roomCode}/events`); await closedStream(response, 401);
    assert.equal(gate.attempts, 1); assert.equal(checksFor(f, gate).length, 1);
  });

  for (const status of [401, 503]) {
    test(`${adapter}: recovery central item ${status} remains a failure with no borrowed successful policy`, { timeout: 4000 }, async t => {
      const f = await fixture(t, sqlite), room = await f.room();
      const gate = observeOutput(f, async ({ attempt }) => {
        if (!attempt) { await f.editSession(value => { value.idleUntil += 1000; }); f.control.nextStatus = status; }
      });
      const response = f.request(`/api/rooms/${room.roomCode}/events`); await closedStream(response, status);
      assert.equal(gate.attempts, 1); assert.equal(checksFor(f, gate).length, 2);
      assert.equal(Boolean(await f.storage.read('sessions', f.id)), status === 503, 'only a real single-item 401 removes the current session');
    });
  }

  test(`${adapter}: room conflict and later session renewal share one recovery budget without another fresh`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), verifyGuards = f.storage.verifyGuards.bind(f.storage); let verified = 0;
    f.storage.verifyGuards = async input => {
      if (!verified++) {
        const row = await f.storage.read('rooms', room.view.roomId); row.value.snapshot.lastActiveAt++;
        assert.equal(await f.storage.replaceCAS('rooms', room.view.roomId, row.version, row.value, row.expiresAt), true);
      }
      return verifyGuards(input);
    };
    const gate = observeOutput(f, ({ attempt }) => attempt === 1 && f.editSession(value => { value.idleUntil += 1000; }));
    const response = f.request(`/api/rooms/${room.roomCode}/events`); await closedStream(response, 503);
    assert.equal(gate.attempts, 2); assert.equal(verified, 1); assert.equal(checksFor(f, gate).length, 1);
  });

  test(`${adapter}: session renewal and later room conflict cannot open a third output preparation`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), verifyGuards = f.storage.verifyGuards.bind(f.storage); let verified = 0;
    f.storage.verifyGuards = async input => {
      verified++; const row = await f.storage.read('rooms', room.view.roomId); row.value.snapshot.lastActiveAt++;
      assert.equal(await f.storage.replaceCAS('rooms', room.view.roomId, row.version, row.value, row.expiresAt), true); return verifyGuards(input);
    };
    const gate = f.renewAtOutput(), response = f.request(`/api/rooms/${room.roomCode}/events`); await closedStream(response, 503);
    assert.equal(gate.attempts, 2); assert.equal(verified, 1); assert.equal(checksFor(f, gate).length, 2);
  });

  test(`${adapter}: original deadline expiry during independent recovery closes the SSE instead of creating a new budget`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), release = deferred(); let shortened;
    const gate = observeOutput(f, async ({ attempt, context }) => {
      if (!attempt) {
        await f.editSession(value => { value.idleUntil += 1000; });
        context.restrict(Math.ceil(8000 - context.remainingMs()) + 20); shortened = context.deadlineMs;
      }
    });
    f.control.afterPolicy = async (_identity, context) => {
      if (context === gate.context && checksFor(f, gate).length === 2) await release.promise;
    };
    const response = f.request(`/api/rooms/${room.roomCode}/events`);
    try {
      await closedStream(response, 503);
      assert.equal(gate.attempts, 1); assert.ok(gate.context.signal.aborted);
      assert.equal(gate.context.deadlineMs, shortened); assert.ok(shortened - gate.context.triggeredAtMs < 8000);
      assert.ok(checksFor(f, gate).length <= 2); assert.ok(await f.storage.read('sessions', f.id));
    } finally { release.resolve(); await nextTurn(); }
  });

  test(`${adapter}: an aborted committed canvas request cannot recover or repeat its append`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(true), { lease, body } = await f.canvasInput(room);
    const append = f.runtime.canvases.append.bind(f.runtime.canvases); let writes = 0, response;
    f.runtime.canvases.append = (...args) => { writes++; return append(...args); }; f.checks.length = 0;
    const gate = observeOutput(f, async ({ attempt }) => {
      if (!attempt) { await f.editSession(value => { value.idleUntil += 1000; }); response.req.emit('aborted'); }
    });
    response = f.request(`/api/rooms/${room.roomCode}/canvas/append`, body); await response.finished;
    assert.equal(response.res.status, 503); assert.equal('ack' in response.res.body, false);
    assert.equal(gate.attempts, 1); assert.equal(f.checks.length, 2); assert.ok(f.checks.every(check => check.context === gate.context));
    await committedOnce(f, lease, () => writes); assert.ok(await f.storage.read('sessions', f.id));
  });

  test(`${adapter}: ordinary private HTTP does not opt into the SSE or committed-canvas session recovery`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(), gate = f.renewAtOutput(); f.checks.length = 0;
    const response = f.request(`/api/rooms/${room.roomCode}`); await response.finished;
    assert.equal(response.res.status, 503); assert.equal('view' in response.res.body, false);
    assert.equal(gate.attempts, 1); assert.equal(f.checks.length, 2); assert.ok(f.checks.every(check => check.context === gate.context));
    assert.ok(await f.storage.read('sessions', f.id));
  });

  test(`${adapter}: initial login baseline rejects same-session re-login during an actual canvas commit`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(true), { lease, body } = await f.canvasInput(room);
    const append = f.runtime.canvases.append.bind(f.runtime.canvases); let writes = 0, changed;
    f.runtime.canvases.append = async (...args) => {
      writes++; const committed = await append(...args);
      changed = await f.editSession(value => { value.accessToken = 're-login-between-commit-and-second-fresh'; });
      return committed;
    };
    f.checks.length = 0; f.wire.length = 0; f.control.responseStatuses.length = 0;
    const response = f.request(`/api/rooms/${room.roomCode}/canvas/append`, body); await response.finished;
    await committedOnce(f, lease, () => writes);
    assert.deepEqual({ ...changed.after.value, accessToken: changed.before.value.accessToken }, changed.before.value);
    assert.deepEqual(f.control.responseStatuses, [200, 200], 'both real signed batch checks succeed for the same subject');
    assert.equal(f.checks.length, 2); assert.equal(f.checks[0].context, f.checks[1].context);
    assert.notEqual(f.checks[0].identity.accessToken, f.checks[1].identity.accessToken);
    const entries = f.wire.flatMap(batch => batch.entries);
    assert.equal(entries.length, 2); assert.notEqual(entries[0].ref, entries[1].ref);
    assert.equal(entries[0].triggeredAtMs, entries[1].triggeredAtMs); assert.equal(entries[0].deadlineMs, entries[1].deadlineMs);
    assert.equal(response.res.status, 503, 'the second successful policy cannot replace the request initial login baseline');
    assert.equal('ack' in response.res.body, false); assert.ok(await f.storage.read('sessions', f.id));
  });

  test(`${adapter}: initial login baseline rejects a new canvas packet on a connection whose same-session CSRF changed`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), room = await f.room(true), { lease, body } = await f.canvasInput(room);
    const response = f.request(`/api/rooms/${room.roomCode}/events`);
    await until(() => packets(response, 'view').length && packets(response, 'chat').length
      && packets(response, 'canvas').some(packet => packet.sequence === 0), 'initial SSE packets were not fully delivered');
    assert.deepEqual(packets(response, 'closed'), []);
    const changed = await f.editSession(value => { value.csrf = 're-login-after-connection-baseline'; });
    assert.deepEqual({ ...changed.after.value, csrf: changed.before.value.csrf }, changed.before.value);
    f.checks.length = 0; f.wire.length = 0; f.control.responseStatuses.length = 0;
    const committed = await f.runtime.canvases.append(room.roomCode, f.userKey, body, { authorizationId: f.id });
    assert.equal(committed.ack.sequence, 1);
    await until(() => response.res.writableEnded || packets(response, 'canvas').some(packet => packet.sequence === 1),
      'the actual newly published canvas packet did not settle');
    assert.deepEqual(f.control.responseStatuses, [200], 'the new event actually receives an independent successful signed policy');
    assert.equal(f.checks.length, 1); assert.equal(f.wire.flatMap(batch => batch.entries).length, 1);
    const saved = (await f.storage.read(CANVAS_SCOPE, lease.canvasId)).value;
    assert.equal(saved.sequence, 1); assert.equal(Object.keys(saved.requests).length, 1);
    assert.deepEqual(packets(response, 'canvas').filter(packet => packet.sequence > 0), [], 'old connection cannot receive the new canvas under the later login baseline');
    assert.equal(packets(response, 'closed').at(-1)?.status, 503); assert.ok(await f.storage.read('sessions', f.id));
  });
}
