import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readSettings, SHARED_ISSUER } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter, identityKey, opaqueId } from '../server/storage.mjs';
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
const ink = response => packets(response, 'canvas');
const messages = response => packets(response, 'chat').flatMap(packet => packet.messages);
async function until(predicate, message) {
  const end = performance.now() + 2500;
  while (!predicate()) { assert.ok(performance.now() < end, message); await nextTurn(); }
}

// Real encrypted adapters, room/chat authority, SessionService, signed batch
// client and BFF. Only central replies, HTTP sink and canvas publication are
// synthetic. Publishing here makes no canvas durability/browser/capacity claim.
async function fixture(t) {
  let time = Date.now(); const now = () => time;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(new MemoryAdapter({ now }), randomBytes(32), now);
  const sub = 'synthetic-ink-lane-host', userKey = identityKey(SHARED_ISSUER, sub), id = opaqueId();
  const checks = [], authorizations = [], identities = new Map(), control = { fetch: null, afterPolicy: null };
  const client = new IdentityBatchClient({ enabled: true, keyId: 'synthetic-ink-lane', privateKey: signing.privateKey, now,
    fetcher(url, options) {
      assert.equal(url, IDENTITY_BATCH_ENDPOINT);
      const parameters = options.headers['Signature-Input'].slice('agora='.length);
      const base = ['"@method": POST', '"@scheme": https', '"@authority": agora.sumomoli.com',
        '"@path": /api/identity/batch', `"content-digest": ${options.headers['Content-Digest']}`,
        '"content-type": application/json', '"x-agora-audience": agora.identity.batch.v1',
        `"@signature-params": ${parameters}`].join('\n');
      assert.equal(verify(null, Buffer.from(base), signing.publicKey,
        Buffer.from(options.headers.Signature.slice('agora=:'.length, -1), 'base64')), true);
      const request = JSON.parse(options.body);
      const reply = (status = 200) => Response.json({ version: 1, batchRef: request.batchRef,
        entries: request.entries.map(entry => {
          const identity = identities.get(entry.accessToken);
          return { ref: entry.ref, status, ...(status === 200 ? { policy: { version: 1, revokedBefore: 0,
            issuer: identity.issuer, sub: identity.sub, clientId: identity.clientId, authTime: identity.authTime } } : {}) };
        }) });
      return control.fetch ? control.fetch(request, options, reply) : Promise.resolve(reply());
    } });
  const sessions = new SessionService(settings, { store: storage, now, provider: { usesBatchIdentity: true,
    async check(identity, options) {
      options.context.assert(); identities.set(identity.accessToken, identity);
      const evidence = { context: options.context, identity: { ...identity } }; checks.push(evidence);
      const policy = await client.check(identity, options);
      await control.afterPolicy?.(evidence);
      return { ...identity, ...policy };
    } } });
  const authorize = sessions.authorize.bind(sessions);
  sessions.authorize = async (...args) => {
    const current = await authorize(...args); authorizations.push({ current, context: args[1]?.context }); return current;
  };
  await storage.put('sessions', id, { phase: 'active', issuer: SHARED_ISSUER, sub, userKey, csrf: opaqueId(),
    accessToken: 'synthetic-ink-lane-token', clientId: '27oe1fs5shskll808e733lqm65', authTime: Math.floor(time / 1000) - 20,
    expiresAt: time + 3600000, idleUntil: time + settings.idleMs }, time + settings.idleMs);
  const subscriptions = new Set(), responses = [];
  const scope = { matchId: randomUUID().replaceAll('-', ''), turnId: 'dg-turn-1' };
  const canvases = { bootId: randomUUID(), async read() { throw new Error('Unused synthetic canvas HTTP read'); }, async watch(_code, _userKey, send) {
    subscriptions.add(send); return () => subscriptions.delete(send);
  }, invalidateActor() {}, invalidateAuthorization() {}, async sweep() {}, async close() { subscriptions.clear(); } };
  const runtime = createRuntime(settings, { storage, sessions, canvases, drawingEnabled: true, now,
    roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  await runtime.wordbankReady;
  const room = await runtime.rooms.createRoom(userKey, '分路合成画者', randomUUID());
  await runtime.rooms.joinRoom(room.roomCode, identityKey(SHARED_ISSUER, 'synthetic-ink-lane-guest'), '合成猜者', randomUUID());
  // Actual room/presence/invitation records and their atomic guards remain
  // authoritative. This decoration supplies only the synthetic canvas turn.
  const decorate = view => ({ ...view, gameType: 'draw-and-guess', matchId: scope.matchId,
    game: { ...view.game, turnId: scope.turnId } });
  const actualView = runtime.rooms.getView.bind(runtime.rooms), actualContext = runtime.rooms.getGameContext.bind(runtime.rooms);
  runtime.rooms.getView = async (...args) => decorate(await actualView(...args));
  runtime.rooms.getGameContext = async (...args) => {
    const current = await actualContext(...args);
    return { ...current, gameType: 'draw-and-guess', matchId: scope.matchId, turnId: scope.turnId,
      ...(current.view ? { view: decorate(current.view) } : {}) };
  };
  const server = createUnifiedServer(runtime);
  t.after(async () => {
    for (const response of responses) { response.res.destroyed = true; response.res.emit('close'); }
    await Promise.allSettled(responses.map(response => response.finished));
    await server.shutdown(); client.close();
    assert.equal(client.occupancy.activeTransports, 0); assert.equal(client.occupancy.logicalWaiters, 0);
  });
  function request() {
    const req = Readable.from([]);
    Object.assign(req, { method: 'GET', url: `/api/rooms/${room.roomCode}/events`,
      headers: { host: new URL(settings.origin).host, cookie: `${settings.cookieName}=${id}` }, socket: { remoteAddress: '127.0.0.1' } });
    const res = new EventEmitter(), finished = deferred();
    Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false, writableLength: 0, frames: [] });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
    res.flushHeaders = () => {}; res.write = value => { res.frames.push(String(value)); return true; };
    res.end = () => { res.writableEnded = true; finished.resolve(); };
    server.emit('request', req, res);
    const response = { req, res, finished: finished.promise }; responses.push(response); return response;
  }
  async function open() {
    const expected = subscriptions.size + 1, response = request();
    await until(() => subscriptions.size === expected && packets(response, 'view').length === 1 && packets(response, 'chat').length === 1,
      'real initial view/chat preparations and canvas subscription did not settle');
    await nextTurn(); return response;
  }
  function publish(sequence, extra = {}) {
    const packet = { kind: 'append', bootId: canvases.bootId, canvasId: 'c'.repeat(64), roomId: room.view.roomId,
      matchId: scope.matchId, turnId: scope.turnId, sequence, clearGeneration: 0, leaseGeneration: 1, operations: [], ...extra };
    for (const send of [...subscriptions]) send(packet);
  }
  function holdView() {
    const entered = deferred(), release = deferred(), read = runtime.rooms.getGameContext.bind(runtime.rooms); let held = false;
    runtime.rooms.getGameContext = async (...args) => {
      const current = await read(...args);
      if (!held && args[2]?.includeView === false) { held = true; entered.resolve(); await release.promise; }
      return current;
    };
    return { entered, release };
  }
  function holdChat(sequence = 1) {
    const entered = deferred(), release = deferred(), prepare = runtime.chat.preparePacket.bind(runtime.chat); let held = false;
    runtime.chat.preparePacket = async (...args) => {
      const current = await prepare(...args);
      if (!held && args[2].messages.some(message => message.chatSequence === sequence)) {
        held = true; entered.resolve(); await release.promise;
      }
      return current;
    };
    return { entered, release };
  }
  function holdFresh() {
    const entered = deferred(), release = deferred(); let held = false;
    control.afterPolicy = async () => {
      if (!held) { held = true; entered.resolve(); await release.promise; }
    };
    return { entered, release };
  }
  function holdFetch() {
    const entered = deferred(), release = deferred(), held = [];
    control.fetch = async (request, options, reply) => {
      held.push({ request, options }); entered.resolve(); return reply(await release.promise);
    };
    return { entered, release, held };
  }
  const sendChat = sequence => runtime.chat.send(room.roomCode, userKey, { requestId: `lane-chat-${sequence}`, text: `合成消息${sequence}` });
  return { client, scope, canvases, subscriptions,
    checks, authorizations, control, request, open, publish, holdView, holdChat, holdFresh, holdFetch,
    sendChat, now, setTime: value => { time = value; } };
}

for (const ordinary of ['view', 'chat']) test(`canvas clear/lease packets stay fresh and ordered while real ${ordinary} preparation is held`, { timeout: 5000 }, async t => {
    const f = await fixture(t);
    let response, held, baseline;
    if (ordinary === 'view') {
      held = f.holdView(); response = f.request(); await held.entered.promise;
      await until(() => f.subscriptions.size === 1 && f.authorizations.length === 2, 'initial event fresh did not finish independently');
      baseline = f.checks.length;
    } else {
      response = await f.open(); baseline = f.checks.length;
      held = f.holdChat(); await f.sendChat(1); await held.entered.promise;
      await until(() => f.authorizations.length === baseline + 1, 'held chat fresh did not actually finish');
      baseline = f.checks.length; await f.sendChat(2);
    }
    try {
      f.publish(1, { kind: 'replace', clearGeneration: 1, strokes: [], pointCount: 0 });
      f.publish(2, { clearGeneration: 1, leaseGeneration: 2 });
      await until(() => ink(response).length === 2, 'unrelated ordinary preparation blocked committed ink');
      assert.deepEqual(ink(response).map(packet => [packet.sequence, packet.clearGeneration, packet.leaseGeneration]), [[1, 1, 1], [2, 1, 2]]);
      assert.equal(f.checks.length, baseline + 2, 'each canvas packet requires its own fresh; queued ordinary chat cannot overtake');
      assert.notEqual(f.checks.at(-1).context, f.checks.at(-2).context);
      assert.ok(f.checks.slice(baseline).every(check => check.context.deadlineMs - check.context.triggeredAtMs === 8000));
      assert.deepEqual(messages(response), []);
      if (ordinary === 'view') assert.deepEqual(packets(response, 'view'), []);
      const queuedAt = f.now(); f.setTime(queuedAt + 50); held.release.resolve();
      if (ordinary === 'chat') {
        await until(() => messages(response).length === 2, 'ordinary chat did not drain after its own head completed');
        assert.deepEqual(messages(response).map(message => message.chatSequence), [1, 2]);
        assert.equal(f.checks.at(-1).context.triggeredAtMs, queuedAt, 'queued chat retains its original enqueue budget');
      } else await until(() => packets(response, 'view').length === 1, 'held ordinary view did not finish');
      assert.deepEqual(packets(response, 'closed'), []);
    } finally { held.release.resolve(); }
  });

for (const reason of ['close', 'deadline']) test(`canvas ${reason} cancels its held fresh and preserves the original queued budget`, { timeout: 5000 }, async t => {
  const f = await fixture(t), response = await f.open(), held = f.holdFetch(), baseline = f.checks.length;
  try {
    const queuedAt = f.now(); f.publish(1); f.publish(2); await held.entered.promise;
    const context = f.checks.at(-1).context, entry = held.held[0].request.entries[0];
    assert.equal(entry.triggeredAtMs, queuedAt); assert.equal(entry.deadlineMs - queuedAt, 8000);
    assert.equal(entry.queueUntilMs - queuedAt, 4000);
    const bytes = f.client.occupancy.residentBytes;
    if (reason === 'close') { response.res.destroyed = true; response.res.emit('close'); }
    else {
      await until(() => context.remainingMs() < 7998, 'original event monotonic clock did not advance');
      assert.throws(() => context.restrict(1), error => error.status === 503);
    }
    await response.finished;
    assert.equal(held.held[0].options.signal.aborted, true);
    assert.equal(f.client.occupancy.activeTransports, 1); assert.equal(f.client.occupancy.tombstones, 1);
    assert.equal(f.client.occupancy.residentBytes, bytes); assert.equal(context.isLive(), false);
    f.setTime(queuedAt + 50); held.release.resolve(200);
    await until(() => f.client.occupancy.activeTransports === 0, 'noncooperative fetch was refunded before actual settlement');
    assert.deepEqual(ink(response), []); assert.equal(f.checks.length, baseline + 1);
    assert.equal(context.triggeredAtMs, queuedAt); assert.equal(held.held.length, 1);
    if (reason === 'deadline') assert.equal(packets(response, 'closed').at(-1)?.status, 503);
  } finally { held.release.resolve(200); }
});

test('held old turn and boot canvas packets are suppressed while a subsequent current packet remains deliverable', { timeout: 5000 }, async t => {
  const f = await fixture(t), response = await f.open();
  for (const change of ['turn', 'boot']) {
    const held = f.holdFresh(), first = change === 'turn' ? 1 : 4;
    try {
      f.publish(first); await held.entered.promise; f.publish(first + 1);
      if (change === 'turn') f.scope.turnId = 'dg-turn-2'; else f.canvases.bootId = randomUUID();
      held.release.resolve(); f.control.afterPolicy = null; f.publish(first + 2);
      await until(() => ink(response).some(packet => packet.sequence === first + 2), 'new scope packet did not follow dropped old packets');
      assert.ok(!ink(response).some(packet => packet.sequence === first || packet.sequence === first + 1));
      const current = ink(response).at(-1);
      assert.equal(current.turnId, f.scope.turnId); assert.equal(current.bootId, f.canvases.bootId);
      assert.deepEqual(packets(response, 'closed'), []);
    } finally { held.release.resolve(); f.control.afterPolicy = null; }
  }
});

for (const failed of ['ordinary', 'canvas']) test(`${failed} lane failure suppresses the opposite lane's late successful preparation`, { timeout: 5000 }, async t => {
  const f = await fixture(t), response = await f.open(), chat = f.holdChat();
  let canvas;
  try {
    await f.sendChat(1); await chat.entered.promise;
    // Set the hold after the ordinary fresh has settled so it belongs to ink.
    await until(() => f.authorizations.length === f.checks.length, 'ordinary event fresh did not finish');
    canvas = f.holdFetch(); f.publish(1); await canvas.entered.promise; f.publish(2);
    if (failed === 'ordinary') chat.release.reject(new RoomError(503, 'SYNTHETIC_CHAT_FAILED', '合成聊天准备失败'));
    else canvas.release.resolve(503);
    await response.finished;
    if (failed === 'ordinary') {
      assert.equal(canvas.held[0].options.signal.aborted, true);
      assert.equal(f.client.occupancy.activeTransports, 1, 'late canvas transport remains owned after ordinary failure');
      canvas.release.resolve(200);
    } else chat.release.resolve();
    await until(() => f.client.occupancy.activeTransports === 0, 'late opposite transport did not settle');
    await nextTurn(); assert.deepEqual(ink(response), []); assert.deepEqual(messages(response), []);
    assert.equal(packets(response, 'closed').filter(packet => packet.status === 503).length, 1);
  } finally { chat.release.resolve(); canvas?.release.resolve(200); }
});

test('four-message admission is shared by ordinary and canvas lanes rather than granted once per lane', { timeout: 5000 }, async t => {
  const f = await fixture(t), response = await f.open(), chat = f.holdChat(); let canvas;
  try {
    await f.sendChat(1); await chat.entered.promise;
    await until(() => f.authorizations.length === f.checks.length, 'ordinary event fresh did not finish');
    canvas = f.holdFresh(); f.publish(1); await canvas.entered.promise;
    f.publish(2); await f.sendChat(2); // Two ordinary plus two ink messages: exactly four.
    assert.equal(response.res.writableEnded, false);
    f.publish(3); await response.finished;
    assert.deepEqual(packets(response, 'closed'), [], 'shared admission overflow is transport EOF');
    chat.release.resolve(); canvas.release.resolve(); await nextTurn();
    assert.deepEqual(ink(response), []); assert.deepEqual(messages(response), []);
  } finally { chat.release.resolve(); canvas?.release.resolve(); }
});
