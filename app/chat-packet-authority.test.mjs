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
const seatRequired = error => error.status === 403 && error.code === 'SEAT_REQUIRED';
const chatPackets = response => response.res.frames.filter(frame => frame.startsWith('event: chat\n'))
  .map(frame => JSON.parse(frame.split('\ndata: ')[1].split('\n\n')[0]));

// Actual BFF, sessions, rooms, chat and encrypted adapters. Only identity and
// the HTTP sink are synthetic. Gates hold a completed real storage read.
async function fixture(t, sqlite, chatNow) {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(':memory:') : new MemoryAdapter(), randomBytes(32));
  const issuer = 'urn:synthetic-chat-packet-authority', checks = [];
  const provider = { usesBatchIdentity: true, async check(identity, options) {
    options.context.assert(); checks.push({ sub: identity.sub, context: options.context }); return { ...identity };
  } };
  const sessions = new SessionService(settings, { store: storage, provider, authorizationTimeoutMs: 2000 });
  const runtime = createRuntime(settings, { storage, sessions, roomOptions: { pollIntervalMs: 0 },
    chatOptions: { pollIntervalMs: 0, ...(chatNow ? { now: chatNow } : {}) } });
  const server = createUnifiedServer(runtime); t.after(() => server.shutdown());
  async function member(sub) {
    const id = opaqueId(), csrf = opaqueId(), userKey = identityKey(issuer, sub), now = Date.now();
    await storage.put('sessions', id, { phase: 'active', issuer, sub, userKey, csrf,
      accessToken: `synthetic-${sub}`, expiresAt: now + 3600000, idleUntil: now + settings.idleMs }, now + settings.idleMs);
    return { id, userKey, name: '同名合成伙伴' };
  }
  const host = await member('host'), guest = await member('guest');
  const room = await runtime.rooms.createRoom(host.userKey, host.name, randomUUID());
  await runtime.rooms.joinRoom(room.roomCode, guest.userKey, guest.name, randomUUID());
  function request() {
    const req = Readable.from([]); Object.assign(req, { method: 'GET', url: `/api/rooms/${room.roomCode}/events`,
      headers: { host: new URL(settings.origin).host, cookie: `${settings.cookieName}=${host.id}` }, socket: { remoteAddress: '127.0.0.1' } });
    const res = new EventEmitter(), finished = deferred();
    Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false, writableLength: 0, frames: [] });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
    res.flushHeaders = () => {}; res.write = value => { res.frames.push(String(value)); return true; };
    res.end = () => { res.writableEnded = true; finished.resolve(); };
    server.emit('request', req, res); return { req, res, finished: finished.promise };
  }
  return { runtime, storage, sessions, checks, host, guest, room, request };
}

function holdChatRead(f, when = () => true) {
  const read = f.storage.read.bind(f.storage), entered = deferred(), release = deferred();
  let held = false;
  f.storage.read = async (...args) => {
    const saved = await read(...args);
    if (!held && when() && args[0] === 'room-chat' && args[1] === f.room.view.roomId) {
      held = true; entered.resolve(); await release.promise;
    }
    return saved;
  };
  return { read, entered: entered.promise, release: () => release.resolve() };
}

async function replaceInvite(f, other, read) {
  const original = await read('rooms', f.room.view.roomId), presence = await read('room-presence', f.room.view.roomId);
  const replacement = await read('rooms', other.view.roomId); replacement.value.snapshot.code = f.room.roomCode;
  assert.equal(await f.storage.replaceCAS('rooms', other.view.roomId, replacement.version, replacement.value, replacement.expiresAt), true);
  const invite = await read('room-invites', f.room.roomCode); invite.value.roomId = other.view.roomId;
  assert.equal(await f.storage.replaceCAS('room-invites', f.room.roomCode, invite.version, invite.value, invite.expiresAt), true);
  assert.equal((await read('rooms', f.room.view.roomId)).version, original.version);
  assert.equal((await read('room-presence', f.room.view.roomId))?.version, presence?.version,
    'old room and presence guards cannot detect this mapping-only change');
}

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  test(`${adapter}: preparePacket rejects invitation rebinding during its actual chat read`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite);
    await f.runtime.chat.send(f.room.roomCode, f.host.userKey, { requestId: 'old-room', text: '旧房间正文' });
    const packet = await f.runtime.chat.get(f.room.roomCode, f.host.userKey);
    const other = await f.runtime.rooms.createRoom(f.host.userKey, f.host.name, randomUUID()), gate = holdChatRead(f);
    const operation = f.runtime.chat.preparePacket(f.room.roomCode, f.host.userKey, packet);
    const rejected = assert.rejects(operation, seatRequired);
    try {
      await gate.entered; await replaceInvite(f, other, gate.read); gate.release(); await rejected;
      assert.equal((await gate.read('room-chat', f.room.view.roomId)).value.sequence, 1, 'no message or mapping write is retried');
    } finally { gate.release(); }
  });

  test(`${adapter}: preparePacket rejects a current member who obtained a new seat during its chat read`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite);
    await f.runtime.chat.send(f.room.roomCode, f.guest.userKey, { requestId: 'old-seat', text: '旧座位正文' });
    const packet = await f.runtime.chat.get(f.room.roomCode, f.guest.userKey);
    const oldMember = await f.runtime.rooms.getChatMember(f.room.roomCode, f.guest.userKey), gate = holdChatRead(f);
    const operation = f.runtime.chat.preparePacket(f.room.roomCode, f.guest.userKey, packet);
    const rejected = assert.rejects(operation, seatRequired);
    try {
      await gate.entered;
      const view = await f.runtime.rooms.getView(f.room.roomCode, f.guest.userKey);
      await f.runtime.rooms.action(f.room.roomCode, f.guest.userKey,
        { type: 'leave', requestId: randomUUID(), expectedRevision: view.revision });
      await f.runtime.rooms.joinRoom(f.room.roomCode, f.guest.userKey, f.guest.name, randomUUID());
      const current = await f.runtime.rooms.getChatMember(f.room.roomCode, f.guest.userKey);
      assert.equal(current.roomId, oldMember.roomId); assert.notEqual(current.playerId, oldMember.playerId);
      gate.release(); await rejected;
      const freshPacket = await f.runtime.chat.get(f.room.roomCode, f.guest.userKey);
      assert.equal((await f.runtime.chat.preparePacket(f.room.roomCode, f.guest.userKey, freshPacket)).messages.length, 1);
    } finally { gate.release(); }
  });

  test(`${adapter}: a stable seat retains ordered request-isolated chat and clips messages expiring during the read`, { timeout: 4000 }, async t => {
    let time = Date.now(); const f = await fixture(t, sqlite, () => time);
    const expiring = await f.runtime.chat.send(f.room.roomCode, f.host.userKey, { requestId: 'own-request', text: '会到期的正文' });
    const live = await f.runtime.chat.send(f.room.roomCode, f.guest.userKey, { requestId: 'foreign-request', text: '保留的正文' });
    const saved = await f.storage.read('room-chat', f.room.view.roomId), expiry = time + 10;
    const message = saved.value.messages.find(value => value.messageId === expiring.message.messageId); message.expiresAt = expiry;
    for (const request of Object.values(saved.value.requests)) if (request.message.messageId === message.messageId) {
      request.expiresAt = expiry; request.message.expiresAt = expiry;
    }
    assert.equal(await f.storage.replaceCAS('room-chat', f.room.view.roomId, saved.version, saved.value, saved.expiresAt), true);
    const persisted = await f.storage.read('room-chat', f.room.view.roomId);
    const packet = await f.runtime.chat.get(f.room.roomCode, f.host.userKey);
    assert.deepEqual(packet.messages.map(value => value.chatSequence), [1, 2]);
    assert.equal(packet.messages[0].requestId, 'own-request'); assert.equal('requestId' in packet.messages[1], false);
    const before = await f.runtime.rooms.getChatMember(f.room.roomCode, f.host.userKey), gate = holdChatRead(f);
    const operation = f.runtime.chat.preparePacket(f.room.roomCode, f.host.userKey, packet);
    try {
      await gate.entered; time = expiry; gate.release(); const result = await operation;
      assert.deepEqual(result.messages.map(value => value.messageId), [live.message.messageId]);
      assert.equal('requestId' in result.messages[0], false); assert.equal(result.oldestSequence, 2); assert.equal(result.latestSequence, 2);
      assert.equal(result.historyTruncated, true);
      assert.deepEqual(await f.runtime.rooms.getChatMember(f.room.roomCode, f.host.userKey), before);
      assert.deepEqual(await gate.read('room-chat', f.room.view.roomId), persisted,
        'preparing an output does not persist its retention pruning');
    } finally { gate.release(); }
  });

  test(`${adapter}: actual BFF rejects invitation rebinding during its post-fresh chat read`, { timeout: 4000 }, async t => {
    const f = await fixture(t, sqlite), secret = '禁止跨映射释放的旧正文';
    await f.runtime.chat.send(f.room.roomCode, f.host.userKey, { requestId: 'original-private-id', text: secret });
    const other = await f.runtime.rooms.createRoom(f.host.userKey, f.host.name, randomUUID());
    const prepare = f.runtime.chat.preparePacket.bind(f.runtime.chat); let selectedPrepares = 0, postFresh = false, outputContext;
    f.runtime.chat.preparePacket = async (...args) => {
      const selected = args[2].messages.some(message => message.text === secret);
      if (selected) selectedPrepares++;
      postFresh = selected && selectedPrepares === 2;
      try { return await prepare(...args); } finally { postFresh = false; }
    };
    const gate = holdChatRead(f, () => postFresh), response = f.request();
    try {
      await gate.entered; outputContext = f.checks.at(-1).context;
      assert.ok(outputContext.isLive()); await replaceInvite(f, other, gate.read);
      gate.release(); await response.finished; await nextTurn();
      assert.equal(selectedPrepares, 2); assert.deepEqual(chatPackets(response), []);
      assert.equal(response.res.frames.join('').includes(secret), false);
      assert.ok(response.res.frames.some(frame => frame.startsWith('event: closed') && frame.includes('"status":404')));
      assert.equal(f.checks.filter(check => check.context === outputContext).length, 1, 'one original fresh check, no retry or new context');
      assert.ok(await gate.read('sessions', f.host.id));
      assert.equal((await gate.read('room-chat', f.room.view.roomId)).value.sequence, 1);
    } finally { gate.release(); response.res.destroyed = true; response.res.emit('close'); await response.finished; }
  });
}
