import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRoomStore } from './rooms.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createRoomChat } from '../server/chat.mjs';
import { createCanvasService, CANVAS_SCOPE } from '../server/games/draw-and-guess/canvas-service.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { SessionService } from '../server/session-service.mjs';
import { readSettings } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey, opaqueId } from '../server/storage.mjs';

// All rules, room/context getters, chat/canvas services, final atomic guards and
// HTTP/SSE consumers are real. The identity provider and its users are synthetic;
// no provider capacity, public network or real account is exercised.
const issuer = 'urn:invitation-output-test';
const users = ['owner', 'guest', 'observer'].map(sub => identityKey(issuer, sub));
const words = Array.from({ length: 12 }, (_, index) => ({ id: `invite-word-${index + 1}`, answer: `私有画词${index + 1}`,
  aliases: [], category: 'daily', categoryName: '日常', difficulty: 'easy', language: 'zh', packId: 'invite-pack',
  packVersion: '1', definitionVersion: 1, source: '原创测试', status: 'reviewed', hintLength: [...`私有画词${index + 1}`].length,
  tags: [], drawingCue: '只在服务器保存的提示' }));
const stroke = { strokeId: 'invite-stroke', tool: 'pen', color: '#245c7c', width: 4, points: [[.1, .2], [.2, .3]] };
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
async function until(predicate, message) {
  const end = performance.now() + 2000;
  while (!predicate()) { assert.ok(performance.now() < end, message); await delay(2); }
}

async function fixture(t, kind, gameType = 'draw-and-guess', { http = false } = {}) {
  let time = Date.now(), checks = 0, actionNumber = 0;
  const now = () => time, folder = mkdtempSync(join(tmpdir(), 'room-invitation-output-'));
  const storage = new EncryptedStore(kind === 'SQLite' ? new SQLiteAdapter(join(folder, 'records.sqlite'), { now }) : new MemoryAdapter({ now }), randomBytes(32), now);
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), streams = [], checksContexts = [], builders = [];
  let server, base, rooms, chat, canvases;
  t.after(async () => {
    for (const stream of streams) stream.controller.abort();
    await Promise.allSettled(streams.map(stream => stream.pump));
    try {
      if (server) { server.closeAllConnections(); await server.shutdown(); }
      else { chat?.close(); await canvases?.close(); await rooms?.close(); storage.close(); }
    } finally {
      for (const builder of builders) builder.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
  const id = opaqueId(), csrf = opaqueId(), code = '345678';
  await storage.put('sessions', id, { phase: 'active', issuer, sub: 'owner', userKey: users[0], csrf,
    accessToken: 'synthetic-invitation-only', expiresAt: time + 3600000, idleUntil: time + settings.idleMs,
    lastIdentityCheck: time }, time + settings.idleMs);
  const sessions = new SessionService(settings, { store: storage, now, provider: { usesBatchIdentity: true,
    async check(identity, { context } = {}) { context?.assert(); checks++; checksContexts.push(context); return { ...identity }; } } });
  const roomOptions = { now, ttlMs: 600000, turnTimeoutMs: 1800000, serverRandomInt: () => 0,
    gameOptions: { firstTurnIndex: 0, frozenCandidates: words, randomInt: maximum => maximum - 1 } };
  function build(type, name) {
    const roomId = randomBytes(16).toString('hex'), builder = createRoomStore(roomOptions); builders.push(builder);
    builder.createTrustedRoom(users[0], name, { code, roomId, gameType: type });
    builder.joinTrustedRoom(code, users[1], '合成伙伴'); builder.joinTrustedRoom(code, users[2], '合成观众', { role: 'spectator' });
    function act(user, action, fields = {}) {
      const view = builder.getTrustedView(code, user);
      return builder.trustedAction(code, user, { type: action, requestId: `invite-action-${++actionNumber}`, expectedRevision: view.revision, ...fields });
    }
    if (type === 'draw-and-guess') act(users[0], 'configure', { drawConfig: { rounds: 2, drawingSeconds: 120,
      contentSelection: { packId: 'invite-pack', version: 1, categoryIds: ['daily'], difficulties: ['easy'] } } });
    act(users[0], 'ready', { ready: true }); act(users[1], 'ready', { ready: true }); act(users[0], 'start');
    if (type === 'draw-and-guess') {
      const view = builder.getTrustedView(code, users[0]);
      act(users[0], 'choose', { matchId: view.matchId, turnId: view.game.turnId, candidateId: view.game.candidates[0].id });
    }
    return { roomId, builder, snapshot: builder.exportSnapshot(code) };
  }
  const old = build(gameType, '原房私有名字'), replacement = build(gameType, '新房私有名字');
  for (const room of [old, replacement]) {
    await storage.put('rooms', room.roomId, { snapshot: room.snapshot, joins: {} });
    await storage.put('room-presence', room.roomId, { schemaVersion: 2, connections: {}, lastSeen: {} });
  }
  await storage.put('room-invites', code, { roomId: old.roomId });
  rooms = createDurableRoomStore({ storage, ...roomOptions, pollIntervalMs: 0 });
  chat = createRoomChat({ storage, rooms, now, pollIntervalMs: 0 });
  canvases = createCanvasService({ storage, rooms, now }); await canvases.ready;
  if (http) {
    server = createUnifiedServer({ settings, sessions, storage, rooms, chat, canvases, drawingEnabled: true,
      watchdogMs: 60000, heartbeatMs: 60000 });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    settings.origin = base; settings.callback = `${base}/auth/callback`; settings.postLogout = `${base}/`;
  }
  async function switchInvite(change) {
    const before = await storage.read('room-invites', code);
    const value = change === 'new room' ? { roomId: replacement.roomId } : change === 'retired'
      ? { roomId: old.roomId, retired: true } : { ...before.value };
    assert.equal(await storage.replaceCAS('room-invites', code, before.version, value), true);
    return { before, after: await storage.read('room-invites', code) };
  }
  const atomicEvidence = [];
  function armFinalGate(change, repeat = false) {
    const verify = storage.verifyGuards.bind(storage); let gates = 0;
    storage.verifyGuards = async input => {
      if (gates++ === 0 || repeat) {
        const unchanged = await Promise.all([storage.read('rooms', old.roomId), storage.read('room-presence', old.roomId), storage.read('sessions', id)]);
        const mapping = await switchInvite(change);
        const after = await Promise.all([storage.read('rooms', old.roomId), storage.read('room-presence', old.roomId), storage.read('sessions', id)]);
        assert.deepEqual(after, unchanged, 'late mapping switch leaves original room, presence and session records exactly unchanged');
        atomicEvidence.push({ sameRoomPresenceSession: true, inviteVersionChanged: mapping.before.version !== mapping.after.version });
      }
      return verify(input); // The real original adapter performs the final check.
    };
    return () => gates;
  }
  async function request(path, body) {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Cookie: `${settings.cookieName}=${id}`, ...(body === undefined ? {} : { Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null, text };
  }
  async function openStream() {
    const controller = new AbortController(), response = await fetch(`${base}/api/rooms/${code}/events`, {
      headers: { Cookie: `${settings.cookieName}=${id}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    const stream = { controller, events: [], done: false, error: null }; streams.push(stream);
    stream.pump = (async () => {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          pending += decoder.decode(part.value, { stream: true });
          for (let end; (end = pending.indexOf('\n\n')) !== -1;) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            const type = /^event: ([^\n]+)/m.exec(frame)?.[1], data = /^data: (.*)$/m.exec(frame)?.[1];
            if (type && data) stream.events.push({ type, data: JSON.parse(data) });
          }
        }
      } catch (error) { if (error.name !== 'AbortError') stream.error = error; }
      finally { stream.done = true; reader.releaseLock(); }
    })();
    await until(() => stream.events.some(event => event.type === 'view') && stream.events.some(event => event.type === 'chat')
      && (gameType !== 'draw-and-guess' || stream.events.some(event => event.type === 'canvas')), 'initial actual SSE frames were not delivered');
    return stream;
  }
  async function acquire() {
    const value = await canvases.read(code, users[0]);
    return canvases.acquire(code, users[0], { deviceId: 'invite-device', canvasId: value.canvasId, bootId: value.bootId }, { authorizationId: id });
  }
  const appendBody = lease => ({ deviceId: 'invite-device', canvasId: lease.canvasId, bootId: lease.bootId,
    leaseGeneration: lease.leaseGeneration, clearGeneration: lease.clearGeneration, expectedSequence: 0,
    requestId: 'invite-append', operations: [stroke] });
  return { storage, sessions, rooms, chat, canvases, code, old, replacement, id, now, checksContexts, switchInvite,
    armFinalGate, atomicEvidence, request, openStream, acquire, appendBody, get checks() { return checks; } };
}

for (const kind of ['Memory', 'SQLite']) {
  test(`${kind}: actual full and narrow getters expose the invitation revision they originally read`, async t => {
    const f = await fixture(t, kind), invitation = await f.storage.read('room-invites', f.code);
    for (const includeView of [true, false]) {
      const current = await f.rooms.getGameContext(f.code, users[0], { includeView });
      assert.deepEqual(current.invitationGuard, { scope: 'room-invites', id: f.code, expectedVersion: invitation.version });
      assert.equal(current.roomId, f.old.roomId); assert.equal(Object.hasOwn(current, 'view'), includeView);
    }
  });

  test(`${kind}: invitation guard remains the original read revision while an actual presence await allows the mapping to change`, async t => {
    const f = await fixture(t, kind), invitation = await f.storage.read('room-invites', f.code);
    const entered = deferred(), release = deferred(), read = f.storage.read.bind(f.storage);
    let waiting = true;
    f.storage.read = async (scope, id) => {
      const value = await read(scope, id);
      if (waiting && scope === 'room-presence') { waiting = false; entered.resolve(); await release.promise; }
      return value;
    };
    const pending = f.rooms.getGameContext(f.code, users[0], { includeView: false });
    let current;
    try { await entered.promise; await f.switchInvite('new room'); }
    finally { release.resolve(); current = await pending; f.storage.read = read; }
    assert.deepEqual(current.invitationGuard, { scope: 'room-invites', id: f.code, expectedVersion: invitation.version });
    assert.equal(current.roomId, f.old.roomId);
    assert.equal(await f.storage.verifyGuards({ guards: [current.roomGuard, current.presenceGuard, current.invitationGuard], validUntil: current.expiresAt }), false);
  });

  for (const gameType of ['draw-and-guess', 'rummikub', 'flying-chess']) {
    test(`${kind}: real ${gameType} HTTP private output suppresses a mapping switch just before the actual final verifier`, async t => {
      const f = await fixture(t, kind, gameType, { http: true });
      assert.equal((await f.request(`/api/rooms/${f.code}`)).status, 200);
      const beforeChecks = f.checks, gates = f.armFinalGate('new room');
      const result = await f.request(`/api/rooms/${f.code}`);
      assert.equal(result.status, 503); assert.equal(result.text.includes('原房私有名字'), false);
      assert.equal(Object.hasOwn(result.body, 'view'), false); assert.equal(gates(), 1); assert.equal(f.checks - beforeChecks, 2);
      assert.deepEqual(f.atomicEvidence, [{ sameRoomPresenceSession: true, inviteVersionChanged: true }]);
    });
  }

  test(`${kind}: ordinary private HTTP safely rejects same-mapping invitation revision changes without replaying its flow`, async t => {
    const f = await fixture(t, kind, 'flying-chess', { http: true }), gates = f.armFinalGate('same mapping');
    const result = await f.request(`/api/rooms/${f.code}`);
    assert.equal(result.status, 503); assert.equal(gates(), 1); assert.equal(Object.hasOwn(result.body, 'view'), false);
  });

  for (const change of ['new room', 'retired']) {
    test(`${kind}: a real canvas transaction rejects ${change} before its original atomic commit`, async t => {
      const f = await fixture(t, kind), lease = await f.acquire(), before = await f.storage.read(CANVAS_SCOPE, lease.canvasId);
      const original = f.storage.compareAndSwapMany.bind(f.storage); let switched = false;
      f.storage.compareAndSwapMany = async input => {
        if (!switched && input.changes.some(item => item.scope === CANVAS_SCOPE && item.value?.kind === 'canvas' && item.value.sequence === 1)) {
          switched = true;
          const invitation = await f.storage.read('room-invites', f.code);
          assert.ok(input.guards.some(guard => guard.scope === 'room-invites' && guard.id === f.code && guard.expectedVersion === invitation.version));
          await f.switchInvite(change);
        }
        return original(input);
      };
      try {
        await assert.rejects(f.canvases.append(f.code, users[0], f.appendBody(lease), { authorizationId: f.id }), error => [403, 404, 409, 503].includes(error.status));
      } finally { f.storage.compareAndSwapMany = original; }
      assert.equal(switched, true);
      assert.deepEqual(await f.storage.read(CANVAS_SCOPE, lease.canvasId), before, 'the original persisted canvas is untouched by a failed guarded append');
    });

    test(`${kind}: committed canvas HTTP ${change} suppresses acknowledgement but preserves exactly one persisted append`, async t => {
      const f = await fixture(t, kind, 'draw-and-guess', { http: true }), lease = await f.acquire();
      const beforeChecks = f.checks, gates = f.armFinalGate(change);
      const result = await f.request(`/api/rooms/${f.code}/canvas/append`, f.appendBody(lease));
      assert.ok([404, 409, 503].includes(result.status)); assert.equal(Object.hasOwn(result.body, 'ack'), false);
      const saved = (await f.storage.read(CANVAS_SCOPE, lease.canvasId)).value;
      assert.equal(saved.sequence, 1); assert.equal(saved.strokes[0].points.length, 2); assert.equal(Object.keys(saved.requests).length, 1);
      assert.equal(gates(), 1); assert.equal(f.checks - beforeChecks, 2);
      assert.deepEqual(f.atomicEvidence, [{ sameRoomPresenceSession: true, inviteVersionChanged: true }]);
    });
  }

  for (const repeat of [false, true]) {
    test(`${kind}: canvas HTTP same-mapping conflict ${repeat ? 'fails at its second fence' : 'rechecks once successfully'} with unchanged fresh count`, async t => {
      const f = await fixture(t, kind, 'draw-and-guess', { http: true }), lease = await f.acquire();
      const beforeChecks = f.checks, gates = f.armFinalGate('same mapping', repeat);
      const result = await f.request(`/api/rooms/${f.code}/canvas/append`, f.appendBody(lease));
      assert.equal(result.status, repeat ? 503 : 200); assert.equal(gates(), 2); assert.equal(f.checks - beforeChecks, 2);
      assert.equal(Object.hasOwn(result.body, 'ack'), !repeat);
      assert.equal(f.checksContexts[beforeChecks], f.checksContexts[beforeChecks + 1], 'the readonly recheck shares the original HTTP context rather than opening another deadline');
      assert.equal(f.checksContexts[beforeChecks].deadlineMs - f.checksContexts[beforeChecks].triggeredAtMs, 8000);
      const saved = (await f.storage.read(CANVAS_SCOPE, lease.canvasId)).value;
      assert.equal(saved.sequence, 1); assert.equal(Object.keys(saved.requests).length, 1);
      assert.equal(f.atomicEvidence.length, repeat ? 2 : 1);
    });
  }

  for (const type of ['chat', 'view', 'canvas']) {
    for (const change of ['new room', 'retired']) {
      test(`${kind}: actual SSE ${type} ${change} at final verification cannot emit the original private packet`, async t => {
        const f = await fixture(t, kind, 'draw-and-guess', { http: true });
        const lease = type === 'canvas' ? await f.acquire() : null;
        const stream = await f.openStream(), offset = stream.events.length, beforeChecks = f.checks, gates = f.armFinalGate(change);
        if (type === 'chat') await f.chat.send(f.code, users[0], { text: '只属于原房的新消息', requestId: 'late-chat' });
        else if (type === 'view') {
          const view = await f.rooms.getView(f.code, users[1]);
          await f.rooms.action(f.code, users[1], { type: 'guess', requestId: 'late-view', expectedRevision: view.revision,
            matchId: view.matchId, turnId: view.game.turnId, text: '合成未猜中的消息' });
        } else await f.canvases.append(f.code, users[0], f.appendBody(lease), { authorizationId: f.id });
        await until(() => stream.done, 'stream did not close after invitation changed');
        const emitted = stream.events.slice(offset);
        assert.equal(emitted.filter(event => event.type === type).length, 0);
        assert.ok(emitted.some(event => event.type === 'closed' && [404, 503].includes(event.data.status)));
        assert.equal(stream.error, null); assert.equal(gates(), 1); assert.equal(f.checks - beforeChecks, 1);
        assert.deepEqual(f.atomicEvidence, [{ sameRoomPresenceSession: true, inviteVersionChanged: true }]);
      });
    }
  }

  test(`${kind}: actual SSE chat same mapping reprepares once and delivers its message exactly once`, async t => {
    const f = await fixture(t, kind, 'draw-and-guess', { http: true }), stream = await f.openStream();
    const offset = stream.events.length, beforeChecks = f.checks, gates = f.armFinalGate('same mapping');
    const sent = await f.chat.send(f.code, users[0], { text: '同一房间仍可读', requestId: 'same-chat' });
    await until(() => stream.events.slice(offset).some(event => event.type === 'chat' && event.data.messages.some(message => message.messageId === sent.message.messageId)), 'reprepared chat message was not delivered');
    assert.equal(stream.events.slice(offset).filter(event => event.type === 'chat').length, 1);
    assert.equal(stream.done, false); assert.equal(gates(), 2); assert.equal(f.checks - beforeChecks, 1);
  });
}
