import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readSettings } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { SessionService } from '../server/session-service.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';

const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const chatPackets = response => response.res.frames.filter(frame => frame.startsWith('event: chat\n'))
  .map(frame => JSON.parse(frame.split('\ndata: ')[1].split('\n\n')[0]));
async function waitForChat(response) {
  const until = Date.now() + 1500;
  while (!chatPackets(response).length) {
    if (response.res.writableEnded || Date.now() >= until) assert.fail(`No chat packet: ${response.res.frames.join('')}`);
    await nextTurn();
  }
  await nextTurn();
  return chatPackets(response);
}
async function closeResponse(response) {
  response.res.destroyed = true; response.res.emit('close'); await response.finished;
}

// Real BFF, sessions, rooms, chat and encrypted storage. Only online identity
// and the HTTP sink are synthetic; there are no sockets or capacity claims.
async function fixture(t, { sqlite, batch = true }) {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(':memory:') : new MemoryAdapter(), randomBytes(32));
  const issuer = 'urn:synthetic-chat-authority', checks = [], responses = [];
  let freshHook = null;
  const provider = { usesBatchIdentity: batch, async check(identity, options) {
    const finished = deferred(), check = { sub: identity.sub, context: options.context, settled: false, finished: finished.promise };
    checks.push(check);
    try {
      options.context?.assert(); await freshHook?.(identity, options); options.context?.assert(); return { ...identity };
    } finally { check.settled = true; finished.resolve(); }
  } };
  const sessions = new SessionService(settings, { store: storage, provider, authorizationTimeoutMs: 2000 });
  const runtime = createRuntime(settings, { storage, sessions,
    roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  const server = createUnifiedServer(runtime);
  t.after(async () => {
    for (const response of responses) await closeResponse(response);
    await server.shutdown(); await Promise.all(checks.map(check => check.finished));
    assert.ok(checks.every(check => check.settled), 'the synthetic identity prerequisites must actually settle');
  });
  async function member(sub, name = '同名伙伴') {
    const id = opaqueId(), csrf = opaqueId(), userKey = identityKey(issuer, sub), now = Date.now();
    await storage.put('sessions', id, { phase: 'active', issuer, sub, userKey, csrf,
      accessToken: `synthetic-chat-${sub}`, expiresAt: now + 3600000, idleUntil: now + settings.idleMs }, now + settings.idleMs);
    return { id, csrf, userKey, sub, name };
  }
  const host = await member('fictional-host');
  function request(code, user = host) {
    const req = Readable.from([]); Object.assign(req, { method: 'GET', url: `/api/rooms/${code}/events`,
      headers: { host: new URL(settings.origin).host, cookie: `${settings.cookieName}=${user.id}` },
      socket: { remoteAddress: '127.0.0.1' } });
    const res = new EventEmitter(), finished = deferred();
    Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false, writableLength: 0, frames: [] });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
    res.flushHeaders = () => {};
    res.write = value => { res.frames.push(String(value)); return true; };
    res.end = () => { res.writableEnded = true; finished.resolve(); };
    const response = { req, res, finished: finished.promise }; responses.push(response);
    server.emit('request', req, res); return response;
  }
  async function room() {
    const result = await runtime.rooms.createRoom(host.userKey, host.name, randomUUID());
    const guest = await member('fictional-guest');
    await runtime.rooms.joinRoom(result.roomCode, guest.userKey, guest.name, randomUUID());
    return { ...result, guest };
  }
  function holdChatFresh(text) {
    const entered = deferred(), prepared = deferred(), release = deferred();
    const prepare = runtime.chat.preparePacket.bind(runtime.chat), subscribe = runtime.chat.subscribe.bind(runtime.chat);
    let enqueued = false, held = false, context, initialPacket, preparedPacket;
    runtime.chat.subscribe = (code, userKey, onChat, onEnd) => subscribe(code, userKey, packet => {
      const matches = packet.messages.some(message => message.text === text);
      onChat(packet); // Real publication enters this connection's SSE queue.
      if (matches && !enqueued) { enqueued = true; initialPacket = packet; }
    }, onEnd);
    runtime.chat.preparePacket = async (...args) => {
      const packet = await prepare(...args);
      if (!preparedPacket && args[2].messages.some(message => message.text === text)) {
        preparedPacket = packet; prepared.resolve();
      }
      return packet;
    };
    freshHook = async (identity, options) => {
      const ownChecks = checks.filter(check => check.sub === host.sub);
      if (identity.sub !== host.sub || held || ownChecks.length !== 3) return;
      assert.equal(enqueued, true, 'the actual initial chat packet must already be in this SSE queue');
      assert.ok(initialPacket.messages.some(message => message.text === text));
      assert.equal(ownChecks[0].settled, true, 'handshake fresh must have completed');
      assert.equal(ownChecks[1].settled, true, 'the preceding view fresh must have completed');
      assert.ok(responses.some(response => response.res.frames.some(frame => frame.startsWith('event: view\n'))),
        'this chat job only checks identity after the actual preceding view was delivered');
      assert.notEqual(options.context, ownChecks[0].context); assert.notEqual(options.context, ownChecks[1].context);
      held = true; context = options.context; entered.resolve(); await release.promise;
    };
    return { entered, prepared, release, get context() { return context; }, get preparedPacket() { return preparedPacket; } };
  }
  return { runtime, storage, sessions, checks, host, member, request, room, holdChatFresh };
}

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  for (const change of ['leave', 'room-rebind']) {
    test(`${adapter}: chat fresh cannot release an old packet after ${change}`, { timeout: 4000 }, async t => {
      const f = await fixture(t, { sqlite }), room = await f.room(), secret = '原房间受围栏保护的正文';
      await f.runtime.chat.send(room.roomCode, f.host.userKey, { requestId: 'original-room-message', text: secret });
      const held = f.holdChatFresh(secret), response = f.request(room.roomCode);
      try {
        await Promise.all([held.entered.promise, held.prepared.promise]);
        if (change === 'leave') {
          const view = await f.runtime.rooms.getView(room.roomCode, f.host.userKey);
          await f.runtime.rooms.action(room.roomCode, f.host.userKey,
            { type: 'leave', requestId: randomUUID(), expectedRevision: view.revision });
          const other = await f.runtime.rooms.createRoom(f.host.userKey, f.host.name, randomUUID());
          await f.runtime.chat.send(other.roomCode, f.host.userKey, { requestId: 'new-room-message', text: '新房间独立正文' });
        } else {
          // A valid replacement row at the same resolved code must still fail
          // the stream's original room ID fence, even for the same member.
          const other = await f.runtime.rooms.createRoom(f.host.userKey, f.host.name, randomUUID());
          await f.runtime.chat.send(other.roomCode, f.host.userKey, { requestId: 'replacement-message', text: '替换房间独立正文' });
          const row = await f.storage.read('rooms', other.view.roomId); row.value.snapshot.code = room.roomCode;
          assert.equal(await f.storage.replaceCAS('rooms', other.view.roomId, row.version, row.value, row.expiresAt), true);
          const invite = await f.storage.read('room-invites', room.roomCode); invite.value.roomId = other.view.roomId;
          assert.equal(await f.storage.replaceCAS('room-invites', room.roomCode, invite.version, invite.value, invite.expiresAt), true);
        }
        held.release.resolve(); await response.finished; await nextTurn();
        assert.deepEqual(chatPackets(response), []);
        assert.equal(response.res.frames.join('').includes(secret), false);
        assert.equal(response.res.frames.join('').includes('独立正文'), false);
        assert.ok(response.res.frames.some(frame => frame.startsWith('event: closed') && frame.includes('"status":404')));
        assert.equal(f.checks.filter(check => check.context === held.context).length, 1);
        assert.ok(await f.storage.read('sessions', f.host.id));
      } finally { held.release.resolve(); await closeResponse(response); }
    });
  }

  test(`${adapter}: same-name subjects receive only their own request IDs in ordered chat`, { timeout: 4000 }, async t => {
    const f = await fixture(t, { sqlite }), room = await f.room();
    const a = await f.runtime.chat.send(room.roomCode, f.host.userKey, { requestId: 'host-private-id', text: '第一条合成聊天' });
    const b = await f.runtime.chat.send(room.roomCode, room.guest.userKey, { requestId: 'guest-private-id', text: '第二条合成聊天' });
    const host = f.request(room.roomCode), guest = f.request(room.roomCode, room.guest);
    try {
      const [hostPackets, guestPackets] = await Promise.all([waitForChat(host), waitForChat(guest)]);
      for (const [packet, own, foreign] of [[hostPackets[0], a, b], [guestPackets[0], b, a]]) {
        assert.deepEqual(packet.messages.map(message => message.messageId), [a.message.messageId, b.message.messageId]);
        assert.deepEqual(packet.messages.map(message => message.chatSequence), [1, 2]);
        assert.deepEqual(packet.messages.map(message => message.name), ['同名伙伴', '同名伙伴']);
        const ownMessage = packet.messages.find(message => message.messageId === own.message.messageId);
        const foreignMessage = packet.messages.find(message => message.messageId === foreign.message.messageId);
        assert.equal(ownMessage.requestId, own.message.requestId); assert.equal('requestId' in foreignMessage, false);
        assert.equal(packet.messages.some(message => 'authorUserKey' in message), false);
      }
      assert.notEqual(a.message.playerId, b.message.playerId);
      assert.ok(f.checks.some(check => check.sub === f.host.sub));
      assert.ok(f.checks.some(check => check.sub === room.guest.sub));
    } finally { await closeResponse(host); await closeResponse(guest); }
  });

  test(`${adapter}: independent chat preparation clips expired content and refilters after a retained message expires during held fresh`, { timeout: 4000 }, async t => {
    const f = await fixture(t, { sqlite }), room = await f.room();
    const sent = [];
    for (const [requestId, text] of [['expired-before-preparation', '预过滤前过期正文'],
      ['expires-during-fresh', '鲜度等待期间过期正文'], ['still-retained', '仍有效的正文']]) {
      sent.push(await f.runtime.chat.send(room.roomCode, f.host.userKey, { requestId, text }));
    }
    async function expire(messageId, at) {
      const saved = await f.storage.read('room-chat', room.view.roomId);
      const message = saved.value.messages.find(value => value.messageId === messageId);
      message.expiresAt = at; message.sentAt = Math.min(message.sentAt, at - 1);
      for (const request of Object.values(saved.value.requests)) if (request.message.messageId === messageId) {
        request.expiresAt = at; request.message.expiresAt = at; request.message.sentAt = message.sentAt;
      }
      assert.equal(await f.storage.replaceCAS('room-chat', room.view.roomId, saved.version, saved.value, saved.expiresAt), true);
    }
    const prepare = f.runtime.chat.preparePacket.bind(f.runtime.chat); let clipped = false;
    f.runtime.chat.preparePacket = async (...args) => {
      if (!clipped && args[2].messages.some(message => message.messageId === sent[0].message.messageId)) {
        clipped = true; await expire(sent[0].message.messageId, Date.now() - 1);
      }
      return prepare(...args);
    };
    const held = f.holdChatFresh(sent[1].message.text), response = f.request(room.roomCode);
    try {
      await Promise.all([held.entered.promise, held.prepared.promise]);
      assert.equal(clipped, true);
      assert.deepEqual(held.preparedPacket.messages.map(message => message.messageId), [sent[1].message.messageId, sent[2].message.messageId],
        'the independent actual preparation completed while fresh is held, with the first expiry already clipped');
      const expiry = Date.now() + 20; await expire(sent[1].message.messageId, expiry);
      await new Promise(resolve => setTimeout(resolve, 40)); assert.ok(Date.now() >= expiry);
      held.release.resolve(); const packets = await waitForChat(response);
      assert.equal(clipped, true); assert.equal(packets.length, 1);
      assert.deepEqual(packets[0].messages.map(message => message.messageId), [sent[2].message.messageId]);
      assert.equal(packets[0].messages[0].requestId, 'still-retained');
      assert.equal(packets[0].oldestSequence, 3); assert.equal(packets[0].latestSequence, 3);
      assert.equal(packets[0].historyTruncated, true);
      assert.equal(response.res.frames.join('').includes('过期正文'), false);
      assert.equal(f.checks.filter(check => check.context === held.context).length, 1);
      assert.equal((await f.storage.read('room-chat', room.view.roomId)).value.sequence, 3, 'filtering never repeats chat writes');
    } finally { held.release.resolve(); await closeResponse(response); }
  });

  test(`${adapter}: a second completed room guard conflict closes chat without a third preparation or fresh`, { timeout: 4000 }, async t => {
    const f = await fixture(t, { sqlite }), room = await f.room(), secret = '二次守卫冲突禁止释放的正文';
    await f.runtime.chat.send(room.roomCode, f.host.userKey, { requestId: 'two-output-conflicts', text: secret });
    const prepare = f.runtime.chat.preparePacket.bind(f.runtime.chat), verify = f.storage.verifyGuards.bind(f.storage);
    let armed = false, outputGuards = 0, eventContext;
    f.runtime.chat.preparePacket = async (...args) => {
      const packet = await prepare(...args); if (args[2].messages.some(message => message.text === secret)) armed = true;
      return packet;
    };
    const assertCurrent = f.sessions.assertCurrent.bind(f.sessions);
    f.sessions.assertCurrent = (session, options) => { if (armed) eventContext ??= options.context; return assertCurrent(session, options); };
    f.storage.verifyGuards = async input => {
      if (armed) {
        outputGuards++;
        const row = await f.storage.read('rooms', room.view.roomId); row.value.snapshot.lastActiveAt++;
        assert.equal(await f.storage.replaceCAS('rooms', room.view.roomId, row.version, row.value, row.expiresAt), true);
      }
      return verify(input);
    };
    const response = f.request(room.roomCode);
    try {
      await response.finished; await nextTurn();
      assert.equal(outputGuards, 2); assert.deepEqual(chatPackets(response), []);
      assert.equal(response.res.frames.join('').includes(secret), false);
      assert.ok(response.res.frames.some(frame => frame.startsWith('event: closed') && frame.includes('"status":503')));
      assert.equal(f.checks.filter(check => check.context === eventContext).length, 1);
      const saved = (await f.storage.read('room-chat', room.view.roomId)).value;
      assert.equal(saved.sequence, 1); assert.equal(Object.keys(saved.requests).length, 1);
      assert.ok(await f.storage.read('sessions', f.host.id));
    } finally { await closeResponse(response); }
  });

  test(`${adapter}: legacy chat keeps its full-view path and existing preparation point`, { timeout: 4000 }, async t => {
    const f = await fixture(t, { sqlite, batch: false }), room = await f.room();
    const sent = await f.runtime.chat.send(room.roomCode, f.host.userKey, { requestId: 'legacy-own-id', text: '旧路径合成正文' });
    f.runtime.rooms.getGameContext = async () => { throw new Error('Legacy stream must not use batch context'); };
    const prepare = f.runtime.chat.preparePacket.bind(f.runtime.chat); let preparations = 0;
    f.runtime.chat.preparePacket = async (...args) => { preparations++; return prepare(...args); };
    const response = f.request(room.roomCode);
    try {
      const packets = await waitForChat(response);
      assert.equal(packets.length, 1); assert.equal(preparations, 1);
      assert.equal(packets[0].messages[0].messageId, sent.message.messageId);
      assert.equal(packets[0].messages[0].requestId, 'legacy-own-id');
      assert.equal(response.res.frames.some(frame => frame.startsWith('event: closed')), false);
    } finally { await closeResponse(response); }
  });
}
