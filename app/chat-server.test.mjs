import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createRoomChat, chatQuery, validateChatText } from '../server/chat.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { readSettings } from '../server/config.mjs';
import { MockProvider, IdentityFailure } from '../server/auth.mjs';
import { prepareProduction, startProduction } from '../server/production.mjs';

const users = Array.from({ length: 8 }, (_, index) => identityKey('urn:synthetic-chat-test', `member-${index}`));
const errorCode = (code) => (error) => error.code === code;
async function fixture(t, { chatOptions = {}, roomOptions = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'game-chat-test-'));
  const path = join(directory, 'live.sqlite'), key = randomBytes(32);
  let time = 10000;
  const now = () => time, opened = [];
  function open() {
    const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
    const rooms = createDurableRoomStore({ storage, now, pollIntervalMs: 0, ...roomOptions });
    const chat = createRoomChat({ storage, rooms, now, pollIntervalMs: 0, ...chatOptions });
    const entry = { storage, rooms, chat }; opened.push(entry); return entry;
  }
  async function close(entry) { if (entry.closed) return; await entry.chat.close(); await entry.rooms.close(); entry.storage.close(); entry.closed = true; }
  t.after(async () => { for (const entry of opened) await close(entry); await rm(directory, { recursive: true, force: true }); });
  const entry = open();
  const a = await entry.rooms.createRoom(users[0], '同名', 'host');
  const b = await entry.rooms.joinRoom(a.roomCode, users[1], '同名', 'guest');
  async function action(user, type, extra = {}) {
    const view = await entry.rooms.getView(a.roomCode, user);
    return entry.rooms.action(a.roomCode, user, { type, requestId: randomUUID(), expectedRevision: view.revision, ...extra });
  }
  return { ...entry, entry, a, b, open, close, action, now, advance: (ms) => { time += ms; } };
}

test('trusted members chat independently of host or turn; names are server snapshots and output is pure text', async (t) => {
  const f = await fixture(t);
  const first = await f.chat.send(f.a.roomCode, users[1], { text: '<b>朋友</b> 😀\n第二行', requestId: 'first' });
  assert.equal(first.message.playerId, f.b.playerId);
  assert.equal(first.message.name, '同名');
  assert.equal(first.message.text, '<b>朋友</b> 😀\n第二行');
  await f.rooms.setProfile(users[1], '棋牌新名字');
  const second = await f.chat.send(f.a.roomCode, users[1], { text: '改名后', requestId: 'second' });
  assert.equal(second.message.name, '棋牌新名字');
  await f.action(users[0], 'ready', { ready: true }); await f.action(users[1], 'ready', { ready: true }); await f.action(users[0], 'start');
  const before = await f.rooms.getView(f.a.roomCode, users[0]);
  const other = users.find((user) => [users[0], users[1]].includes(user) && before.game.turnPlayerId !== (user === users[0] ? f.a.playerId : f.b.playerId));
  await f.chat.send(f.a.roomCode, other, { text: '不是我的回合也能聊天', requestId: 'not-turn' });
  assert.deepEqual(await f.rooms.getView(f.a.roomCode, users[0]), before);
  const guestHistory = await f.chat.get(f.a.roomCode, users[1]);
  assert.equal(guestHistory.messages[0].name, '同名');
  assert.equal(guestHistory.messages[0].requestId, 'first');
  const hostHistory = await f.chat.get(f.a.roomCode, users[0]);
  assert.equal(hostHistory.messages[0].requestId, undefined);
  for (const secret of ['authorUserKey', users[0], users[1], 'accessToken', 'csrf', 'token']) assert.ok(!JSON.stringify(hostHistory).includes(secret));
  await assert.rejects(f.chat.get(f.a.roomCode, users[2]), errorCode('SEAT_REQUIRED'));
  await assert.rejects(f.chat.send(f.a.roomCode, users[2], { text: '同名管理员', requestId: 'outside' }), errorCode('SEAT_REQUIRED'));
});

test('server text validation rejects invalid encoding, controls, blank and overflow; malformed attempts also consume rate quota', async (t) => {
  const f = await fixture(t);
  for (const text of ['', ' \n ', '\u0000', '\t', '\ud800', 'a'.repeat(501), '1\n2\n3\n4']) {
    await assert.rejects(f.chat.send(f.a.roomCode, users[0], { text, requestId: randomUUID() }), errorCode('INVALID_CHAT_TEXT'));
    f.advance(11000);
  }
  assert.equal(validateChatText('朋友\r\n🙂'), '朋友\n🙂');
  assert.equal([...validateChatText('🙂'.repeat(500))].length, 500);
  await assert.rejects(f.chat.send(f.a.roomCode, users[0], { text: '伪造作者', requestId: 'forge', playerId: f.b.playerId }), errorCode('INVALID_CHAT_REQUEST'));
  f.advance(61000);
  for (let index = 0; index < 5; index++) await assert.rejects(f.chat.send(f.a.roomCode, users[0], { text: '', requestId: 'invalid-retry' }), errorCode('INVALID_CHAT_TEXT'));
  await assert.rejects(f.chat.send(f.a.roomCode, users[0], { text: '有效但太快', requestId: 'valid-after-invalid' }), (error) => error.code === 'CHAT_RATE_LIMIT' && error.retryAfter === 10);
});

test('concurrent SQLite devices assign one sequence and id for a retried request; conflicts do not append messages', async (t) => {
  const f = await fixture(t), other = f.open();
  const input = { text: '一次发送', requestId: 'same-request' };
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? f.chat : other.chat).send(f.a.roomCode, users[0], input)));
  assert.ok(results.every((result) => result.message.messageId === results[0].message.messageId && result.message.chatSequence === 1));
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  await assert.rejects(other.chat.send(f.a.roomCode, users[0], { ...input, text: '不同正文' }), errorCode('CHAT_REQUEST_ID_REUSED'));
  const second = await other.chat.send(f.a.roomCode, users[1], input);
  assert.equal(second.message.chatSequence, 2);
  assert.notEqual(second.message.messageId, results[0].message.messageId);
  assert.equal((await f.chat.get(f.a.roomCode, users[0])).messages.length, 2);
});

test('rolling sender limits distinguish 5/10 seconds and 20/minute, with duplicates outside the charge', async (t) => {
  const f = await fixture(t);
  let last;
  for (let burst = 0; burst < 4; burst++) {
    for (let index = 0; index < 5; index++) last = await f.chat.send(f.a.roomCode, users[0], { text: '消息', requestId: `burst-${burst}-${index}` });
    if (burst < 3) f.advance(10000);
  }
  f.advance(10000);
  const duplicate = await f.chat.send(f.a.roomCode, users[0], { text: '消息', requestId: 'burst-3-4' });
  assert.equal(duplicate.message.messageId, last.message.messageId);
  await assert.rejects(f.chat.send(f.a.roomCode, users[0], { text: '第21条', requestId: 'minute-full' }), (error) => error.code === 'CHAT_RATE_LIMIT' && error.retryAfter === 20);
  f.advance(20000);
  assert.equal((await f.chat.send(f.a.roomCode, users[0], { text: '恢复发送', requestId: 'after-limit' })).message.chatSequence, 21);
});

test('room-wide 120/minute quota applies across different trusted seats', async (t) => {
  const f = await fixture(t);
  for (let index = 2; index < 7; index++) await f.rooms.joinRoom(f.a.roomCode, users[index], '朋友', `member-${index}`);
  let accepted = 0, rejected = 0;
  for (let burst = 0; burst < 4; burst++) {
    for (let user = 0; user < 7; user++) for (let index = 0; index < 5; index++) {
      try { await f.chat.send(f.a.roomCode, users[user], { text: '房间消息', requestId: `room-${burst}-${user}-${index}` }); accepted++; }
      catch (error) { assert.equal(error.code, 'CHAT_RATE_LIMIT'); assert.ok(error.retryAfter > 0); rejected++; }
    }
    if (burst < 3) f.advance(10000);
  }
  assert.equal(accepted, 120); assert.equal(rejected, 20);
});

test('pagination, 500/24h retention and dedupe metadata do not restore truncated history or reuse sequence', async (t) => {
  const f = await fixture(t, { chatOptions: { maxMessages: 3, retentionMs: 100 } });
  const sent = [];
  for (let index = 1; index <= 5; index++) sent.push(await f.chat.send(f.a.roomCode, users[0], { text: `消息${index}`, requestId: `message-${index}` }));
  const page = await f.chat.get(f.a.roomCode, users[0], { after: 0, limit: 2 });
  assert.deepEqual(page.messages.map((message) => message.chatSequence), [3, 4]);
  assert.equal(page.oldestSequence, 3); assert.equal(page.latestSequence, 5); assert.equal(page.hasMore, true); assert.equal(page.historyTruncated, true);
  assert.deepEqual((await f.chat.get(f.a.roomCode, users[0], { before: 5, limit: 1 })).messages.map((message) => message.chatSequence), [4]);
  const retry = await f.chat.send(f.a.roomCode, users[0], { text: '消息1', requestId: 'message-1' });
  assert.equal(retry.message.messageId, sent[0].message.messageId); assert.equal(retry.retained, false);
  assert.equal((await f.chat.get(f.a.roomCode, users[0])).messages.length, 3);
  const saved = await f.storage.read('room-chat', f.a.view.roomId);
  assert.ok(Object.values(saved.value.requests).every((request) => !('text' in request.message)));
  f.advance(101); await f.chat.sweep();
  const empty = await f.chat.get(f.a.roomCode, users[0]); assert.deepEqual(empty.messages, []); assert.equal(empty.latestSequence, 5);
  f.advance(10000);
  const reused = await f.chat.send(f.a.roomCode, users[0], { text: '新消息', requestId: 'message-1' });
  assert.equal(reused.message.chatSequence, 6); assert.notEqual(reused.message.messageId, sent[0].message.messageId);
});

test('daily dedupe capacity returns a room business 429, keeps valid duplicate ACK and frees only at original expiration', async (t) => {
  const f = await fixture(t, { chatOptions: { maxRequests: 2, retentionMs: 100 } });
  await f.chat.send(f.a.roomCode, users[0], { text: '一', requestId: 'one' });
  await f.chat.send(f.a.roomCode, users[0], { text: '二', requestId: 'two' });
  await assert.rejects(f.chat.send(f.a.roomCode, users[0], { text: '三', requestId: 'three' }), (error) => error.code === 'CHAT_DAILY_LIMIT' && error.status === 429 && error.retryAfter === 1);
  assert.equal((await f.chat.send(f.a.roomCode, users[0], { text: '一', requestId: 'one' })).duplicate, true);
  f.advance(101);
  assert.equal((await f.chat.send(f.a.roomCode, users[0], { text: '三', requestId: 'three' })).message.chatSequence, 3);
});

test('chat activity and reads never change game revision or extend the room business TTL', async (t) => {
  const f = await fixture(t, { roomOptions: { ttlMs: 100 } });
  const before = await f.rooms.getView(f.a.roomCode, users[0]);
  f.advance(90);
  await f.chat.send(f.a.roomCode, users[0], { text: '快过期也不续命', requestId: 'near-expiry' });
  await f.chat.get(f.a.roomCode, users[0]); await f.chat.sweep();
  assert.equal((await f.rooms.getView(f.a.roomCode, users[0])).revision, before.revision);
  f.advance(10);
  await assert.rejects(f.chat.get(f.a.roomCode, users[0]), errorCode('ROOM_NOT_FOUND'));
  await assert.rejects(f.chat.send(f.a.roomCode, users[0], { text: '不能复活房间', requestId: 'expired' }), errorCode('ROOM_NOT_FOUND'));
});

test('guarded chat CAS fences an intervening member leave and TTL expiration before commit', async (t) => {
  const f = await fixture(t);
  const original = f.storage.guardedCAS.bind(f.storage); let left = false;
  f.storage.guardedCAS = async (...args) => { if (!left) { left = true; await f.action(users[1], 'leave'); } return original(...args); };
  await assert.rejects(f.chat.send(f.a.roomCode, users[1], { text: '离席竞态', requestId: 'leave-race' }), errorCode('SEAT_REQUIRED'));
  assert.deepEqual((await f.chat.get(f.a.roomCode, users[0])).messages, []);
  assert.equal(await f.storage.read('room-chat', f.a.view.roomId), null);
  const ttl = await fixture(t, { roomOptions: { ttlMs: 100 } });
  const ttlOriginal = ttl.storage.guardedCAS.bind(ttl.storage); let expired = false;
  ttl.storage.guardedCAS = async (...args) => { if (!expired) { expired = true; ttl.advance(100); } return ttlOriginal(...args); };
  await assert.rejects(ttl.chat.send(ttl.a.roomCode, users[0], { text: '期限竞态', requestId: 'ttl-race' }), errorCode('ROOM_NOT_FOUND'));
  assert.equal(await ttl.storage.read('room-chat', ttl.a.view.roomId), null);
});

test('guarded adapter CAS is atomic in Memory and SQLite and cannot revive a missing or changed prerequisite', async (t) => {
  const f = await fixture(t);
  for (const storage of [f.storage, new EncryptedStore(new MemoryAdapter({ now: f.now }), randomBytes(32), f.now)]) {
    await storage.put('guard-test', 'room', { room: true });
    const guard = await storage.read('guard-test', 'room');
    const condition = { scope: 'guard-test', id: 'room', version: guard.version, validUntil: f.now() + 100 };
    const answers = await Promise.all([storage.guardedCAS('guard-test', 'chat', null, { count: 1 }, Number.MAX_SAFE_INTEGER, condition), storage.guardedCAS('guard-test', 'chat', null, { count: 2 }, Number.MAX_SAFE_INTEGER, condition)]);
    assert.equal(answers.filter(Boolean).length, 1);
    const chat = await storage.read('guard-test', 'chat');
    await storage.remove('guard-test', 'room');
    assert.equal(await storage.guardedCAS('guard-test', 'chat', chat.version, { count: 99 }, Number.MAX_SAFE_INTEGER, condition), false);
    assert.notEqual((await storage.read('guard-test', 'chat')).value.count, 99);
    if (storage !== f.storage) storage.close();
  }
});

test('SQLite guarded CAS samples room expiry after acquiring the transaction lock', async (t) => {
  const f = await fixture(t, { roomOptions: { ttlMs: 100 } });
  const db = f.storage.adapter.db, exec = db.exec.bind(db);
  let crossedDeadline = false;
  t.mock.method(db, 'exec', (sql) => {
    const result = exec(sql);
    if (sql === 'BEGIN IMMEDIATE' && !crossedDeadline) { crossedDeadline = true; f.advance(100); }
    return result;
  });
  await assert.rejects(f.chat.send(f.a.roomCode, users[0], { text: '等待写锁后已过期', requestId: 'lock-wait-expiry' }), errorCode('ROOM_NOT_FOUND'));
  assert.equal(crossedDeadline, true);
  assert.equal(await f.storage.read('room-chat', f.a.view.roomId), null);
});

test('queued chat packets omit bodies clipped or expired before delivery and recheck the seat', async (t) => {
  const f = await fixture(t, { chatOptions: { maxMessages: 3, retentionMs: 100 } });
  await f.chat.send(f.a.roomCode, users[0], { text: '将被截断的正文', requestId: 'queued-old' });
  const queued = await f.chat.get(f.a.roomCode, users[1]);
  for (let index = 0; index < 3; index++) await f.chat.send(f.a.roomCode, users[0], { text: `保留正文${index}`, requestId: `queued-${index}` });
  const clipped = await f.chat.preparePacket(f.a.roomCode, users[1], queued);
  assert.deepEqual(clipped.messages, []); assert.equal(clipped.oldestSequence, 2); assert.equal(clipped.historyTruncated, true);
  const pending = await f.chat.get(f.a.roomCode, users[1]);
  f.advance(101);
  const expired = await f.chat.preparePacket(f.a.roomCode, users[1], pending);
  assert.deepEqual(expired.messages, []); assert.equal(expired.oldestSequence, null); assert.equal(expired.latestSequence, 4);
  assert.equal(expired.historyTruncated, true);
  await f.action(users[1], 'leave');
  await assert.rejects(f.chat.preparePacket(f.a.roomCode, users[1], pending), errorCode('SEAT_REQUIRED'));
});

test('chat persists across restart; independent realtime payloads recover and stop for former members', async (t) => {
  const f = await fixture(t), second = f.open();
  const aEvents = [], bEvents = [], ended = [];
  const stopA = await f.chat.subscribe(f.a.roomCode, users[0], (event) => aEvents.push(event));
  const stopB = await second.chat.subscribe(f.a.roomCode, users[1], (event) => bEvents.push(event), (...args) => ended.push(args));
  const sent = await f.chat.send(f.a.roomCode, users[0], { text: '实时消息', requestId: 'realtime' });
  await second.chat.sweep();
  assert.equal(aEvents.at(-1).messages[0].requestId, 'realtime');
  assert.equal(bEvents.at(-1).messages[0].requestId, undefined);
  assert.equal(bEvents.at(-1).messages[0].messageId, sent.message.messageId);
  stopA(); await f.close(f.entry);
  const reopened = f.open(); assert.equal((await reopened.chat.get(f.a.roomCode, users[0])).messages[0].messageId, sent.message.messageId);
  const view = await reopened.rooms.getView(f.a.roomCode, users[1]);
  await reopened.rooms.action(f.a.roomCode, users[1], { type: 'leave', requestId: 'realtime-leave', expectedRevision: view.revision });
  await second.chat.sweep(); assert.equal(ended[0][1], 403); stopB();
});

test('chat cursor parsing rejects ambiguous, unsafe, out of bounds or foreign fields', () => {
  for (const query of ['before=1&after=0', 'limit=101', 'limit=0', 'after=-1', 'after=9007199254740992', 'before=0', 'after=1&after=2', 'userKey=secret', 'after=NaN']) {
    assert.throws(() => chatQuery(new URLSearchParams(query)), errorCode('INVALID_CHAT_CURSOR'));
  }
  assert.deepEqual(chatQuery(new URLSearchParams('after=0&limit=100')), { after: 0, limit: 100 });
});

async function httpFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'game-chat-http-'));
  let time = Date.now(); const now = () => time;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(new SQLiteAdapter(join(directory, 'http.sqlite'), { now }), randomBytes(32), now);
  const provider = new MockProvider(settings, { now }); provider.status = 200; provider.checks = 0;
  provider.complete = async () => ({ issuer: 'urn:synthetic-chat-http', sub: provider.member, accessToken: 'server-only-synthetic-chat-token', expiresAt: now() + 3600000 });
  provider.check = async (identity) => { provider.checks++; if (provider.status !== 200) throw new IdentityFailure(provider.status); return { sub: identity.sub }; };
  const runtime = createRuntime(settings, { storage, provider, now, roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  const server = createUnifiedServer({ ...runtime, watchdogMs: 20 });
  t.after(async () => { if (server.listening) await server.shutdown(); else { await runtime.chat.close(); await runtime.rooms.close(); storage.close(); } await rm(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`; settings.origin = base; settings.callback = base + '/auth/callback'; settings.postLogout = base + '/';
  async function request(url, { method = 'GET', cookie, csrf, body, headers = {} } = {}) {
    const response = await fetch(base + url, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: base } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); return { response, body: text ? JSON.parse(text) : null };
  }
  async function login(member) {
    provider.member = member;
    const start = await request('/auth/login');
    const tx = start.response.headers.getSetCookie()[0].split(';')[0];
    const url = new URL(start.response.headers.get('location'));
    const callback = await request(url.pathname + url.search, { cookie: tx });
    const cookie = callback.response.headers.getSetCookie().find((value) => value.startsWith(settings.cookieName + '=')).split(';')[0];
    const { body } = await request('/api/state', { cookie }); return { cookie, csrf: body.csrf, userKey: body.userKey };
  }
  const member = await login('member');
  const created = await request('/api/rooms', { method: 'POST', ...member, body: { name: '同名', requestId: 'http-host' } });
  return { base, request, login, member, room: created.body, provider, runtime, advance: (ms) => { time += ms; } };
}

test('HTTP chat retains same BFF identity, Origin/CSRF/fresh writes, strict cursors, and independent SSE events', async (t) => {
  const f = await httpFixture(t), path = `/api/rooms/${f.room.roomCode}/chat`;
  assert.equal((await f.request(path)).response.status, 401);
  const outsider = await f.login('outside'); assert.equal((await f.request(path, outsider)).response.status, 403);
  assert.equal((await f.request(path, { method: 'POST', cookie: f.member.cookie, body: { text: '缺CSRF', requestId: 'csrf' } })).response.status, 403);
  assert.equal((await f.request(path, { method: 'POST', ...f.member, body: { text: '外域', requestId: 'origin' }, headers: { Origin: 'https://evil.example' } })).response.status, 403);
  const checks = f.provider.checks;
  const posted = await f.request(path, { method: 'POST', ...f.member, body: { text: 'HTTP消息', requestId: 'http-message' } });
  assert.equal(posted.response.status, 200); assert.equal(posted.body.message.playerId, f.room.playerId); assert.ok(f.provider.checks > checks);
  assert.equal((await f.request(path + '?after=0&limit=100', f.member)).body.messages[0].messageId, posted.body.message.messageId);
  assert.equal((await f.request(path + '?after=1&after=2', f.member)).response.status, 400);
  assert.equal((await f.request(path, { method: 'POST', ...f.member, body: { text: '伪造', requestId: 'forged', name: '房主' } })).response.status, 400);
  f.provider.status = 503;
  assert.equal((await f.request(path, { method: 'POST', ...f.member, body: { text: '不能暂放行', requestId: 'outage' } })).response.status, 503);
  f.provider.status = 200;
  const response = await fetch(`${f.base}/api/rooms/${f.room.roomCode}/events`, { headers: { Cookie: f.member.cookie } });
  const reader = response.body.getReader(); let received = '';
  while (!received.includes('event: chat')) { const part = await reader.read(); assert.equal(part.done, false); received += new TextDecoder().decode(part.value); }
  assert.match(received, /event: view/); assert.match(received, /"text":"HTTP消息"/);
  assert.equal(received.includes('server-only-synthetic-chat-token'), false);
  const logout = await f.request('/auth/logout', { method: 'POST', ...f.member }); assert.equal(logout.response.status, 200);
  while (!received.includes('event: closed')) { const part = await reader.read(); if (part.done) break; received += new TextDecoder().decode(part.value); }
  assert.match(received, /"status":401/); await reader.cancel();
});

test('HTTP chat rejects malformed UTF-8 before decoding it into replacement text', async (t) => {
  const f = await httpFixture(t);
  const body = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","requestId":"invalid-utf8"}')]);
  const response = await fetch(`${f.base}/api/rooms/${f.room.roomCode}/chat`, { method: 'POST', body,
    headers: { Cookie: f.member.cookie, Origin: f.base, 'X-CSRF-Token': f.member.csrf, 'Content-Type': 'application/json' } });
  assert.equal(response.status, 400); assert.equal((await response.json()).code, 'INVALID_JSON');
  assert.deepEqual((await f.request(`/api/rooms/${f.room.roomCode}/chat`, f.member)).body.messages, []);
});

async function productionFailureFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'game-chat-production-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intervals = [], cleanup = [];
  const set = globalThis.setInterval, clear = globalThis.clearInterval, close = SQLiteAdapter.prototype.close;
  t.mock.method(globalThis, 'setInterval', (...args) => { const timer = set(...args); intervals.push(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', (timer) => { cleanup.push(intervals.indexOf(timer)); return clear(timer); });
  t.mock.method(SQLiteAdapter.prototype, 'close', function () { cleanup.push('storage'); return close.call(this); });
  return { intervals, cleanup, env: { NODE_ENV: 'production', GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'ownclient12345678',
    GAME_ROOM_STORE_PATH: join(directory, 'failed.sqlite'), GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') } };
}

test('production readiness failure cancels chat and room polling before closing SQLite', async (t) => {
  const f = await productionFailureFixture(t);
  const get = SQLiteAdapter.prototype.get;
  t.mock.method(SQLiteAdapter.prototype, 'get', async function (key) {
    if (key === 'health-check') throw new Error('synthetic readiness failure');
    return get.call(this, key);
  });
  await assert.rejects(prepareProduction(f.env), /synthetic readiness failure/);
  assert.equal(f.intervals.length, 3); assert.ok(f.intervals.every((timer) => timer._destroyed));
  // The room timer is created first; chat must stop before its room prerequisite and database.
  assert.deepEqual(f.cleanup, [2, 1, 0, 'storage']);
});

test('production listen failure also disposes server sweep and closes chat before its dependencies', async (t) => {
  const f = await productionFailureFixture(t);
  t.mock.method(http.Server.prototype, 'listen', () => { throw Object.assign(new Error('synthetic occupied port'), { code: 'EADDRINUSE' }); });
  await assert.rejects(startProduction(f.env), (error) => error.code === 'EADDRINUSE');
  assert.equal(f.intervals.length, 4); assert.ok(f.intervals.every((timer) => timer._destroyed));
  assert.deepEqual(f.cleanup, [3, 2, 1, 0, 'storage']);
});
