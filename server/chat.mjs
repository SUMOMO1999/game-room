import { createHash, randomBytes } from 'node:crypto';
import { RoomError } from '../app/rooms.mjs';

export const CHAT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const CHAT_MAX_MESSAGES = 500;
export const CHAT_MAX_REQUESTS = 4096;
const FOREVER = Number.MAX_SAFE_INTEGER;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, code, message, extra) => { throw Object.assign(new RoomError(status, code, message), extra); };
export function validateChatText(value) {
  if (typeof value !== 'string') fail(400, 'INVALID_CHAT_TEXT', '消息需要是文字。');
  const text = value.replace(/\r\n/g, '\n').normalize('NFC');
  if (!text.trim() || [...text].length > 500 || Buffer.byteLength(text, 'utf8') > 2048
      || text.split('\n').length > 3 || /\p{Cs}|[\p{Cc}&&[^\n]]/v.test(text)) {
    fail(400, 'INVALID_CHAT_TEXT', '消息最多500个字、2048字节和3行，不能只有空白或包含控制字符。');
  }
  return text;
}
export function chatQuery(searchParams) {
  const values = {};
  for (const name of searchParams.keys()) {
    if (!['before', 'after', 'limit'].includes(name) || searchParams.getAll(name).length !== 1
        || !/^(?:0|[1-9]\d*)$/.test(searchParams.get(name))) fail(400, 'INVALID_CHAT_CURSOR', '聊天分页参数无效。');
    values[name] = Number(searchParams.get(name));
  }
  return checkedQuery(values);
}
function checkedQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)
      || Object.keys(query).some((key) => !['before', 'after', 'limit'].includes(key))) fail(400, 'INVALID_CHAT_CURSOR', '聊天分页参数无效。');
  const { before, after, limit = 100 } = query;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || before !== undefined && after !== undefined
      || before !== undefined && (!Number.isSafeInteger(before) || before < 1)
      || after !== undefined && (!Number.isSafeInteger(after) || after < 0)) fail(400, 'INVALID_CHAT_CURSOR', '聊天分页参数无效。');
  return { limit, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
}
function blank(roomId) { return { schemaVersion: 1, roomId, sequence: 0, discardedThrough: 0, messages: [], requests: {}, rates: { room: [], users: {} } }; }
function prune(record, now, maximum = CHAT_MAX_MESSAGES) {
  const kept = record.messages.filter((message) => message.expiresAt > now).slice(-maximum);
  const keptIds = new Set(kept.map((message) => message.messageId));
  for (const message of record.messages) if (!keptIds.has(message.messageId)) record.discardedThrough = Math.max(record.discardedThrough, message.chatSequence);
  record.messages = kept;
  for (const [key, request] of Object.entries(record.requests)) if (request.expiresAt <= now) delete record.requests[key];
  record.rates.room = record.rates.room.filter((at) => at > now - 60000).slice(-121);
  for (const [user, attempts] of Object.entries(record.rates.users)) {
    const keptAttempts = attempts.filter((at) => at > now - 60000).slice(-21);
    if (keptAttempts.length) record.rates.users[user] = keptAttempts;
    else delete record.rates.users[user];
  }
  return record;
}
function publicMessage(message, userKey) {
  const { authorUserKey, requestId, ...value } = message;
  return { ...value, ...(authorUserKey === userKey ? { requestId } : {}) };
}
function history(record, userKey, query) {
  let candidates = record.messages;
  if (query.before !== undefined) candidates = candidates.filter((message) => message.chatSequence < query.before);
  if (query.after !== undefined) candidates = candidates.filter((message) => message.chatSequence > query.after);
  const selected = query.after !== undefined ? candidates.slice(0, query.limit) : candidates.slice(-query.limit);
  return { roomId: record.roomId, messages: selected.map((message) => publicMessage(message, userKey)),
    oldestSequence: record.messages[0]?.chatSequence ?? null, latestSequence: record.sequence,
    hasMore: candidates.length > query.limit,
    historyTruncated: query.after === undefined ? record.discardedThrough > 0 : record.discardedThrough > query.after };
}
function retryWait(attempts, maximum, window, now) {
  const recent = attempts.filter((at) => at > now - window);
  return recent.length >= maximum ? Math.max(1, Math.ceil((recent[recent.length - maximum] + window - now) / 1000)) : 0;
}
export function validateChatSnapshot(value) {
  if (value?.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(value.roomId ?? '')
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isSafeInteger(value.discardedThrough)
      || value.discardedThrough < 0 || value.discardedThrough > value.sequence || !Array.isArray(value.messages)
      || value.messages.length > CHAT_MAX_MESSAGES || !value.requests || typeof value.requests !== 'object' || Array.isArray(value.requests)
      || Object.keys(value.requests).length > CHAT_MAX_REQUESTS || !value.rates || !Array.isArray(value.rates.room)
      || value.rates.room.length > 121 || !value.rates.users || typeof value.rates.users !== 'object' || Array.isArray(value.rates.users)) throw new Error('Invalid chat snapshot');
  const checkMessage = (message, content) => {
    if (!/^[a-f0-9]{32}$/.test(message?.messageId ?? '') || !/^[a-f0-9]{32}$/.test(message.playerId ?? '')
        || typeof message.name !== 'string' || !message.name.trim() || [...message.name].length > 16 || /\p{Cc}/u.test(message.name)
        || !Number.isSafeInteger(message.chatSequence) || message.chatSequence < 1 || message.chatSequence > value.sequence
        || !Number.isFinite(message.sentAt) || !Number.isFinite(message.expiresAt) || message.expiresAt <= message.sentAt
        || message.expiresAt > message.sentAt + CHAT_RETENTION_MS) throw new Error('Invalid chat message');
    if (content && (!/^[a-f0-9]{64}$/.test(message.authorUserKey ?? '')
        || !/^[A-Za-z0-9_-]{1,128}$/.test(message.requestId ?? '') || validateChatText(message.text) !== message.text)) throw new Error('Invalid chat message');
  };
  let previous = 0;
  for (const message of value.messages) { checkMessage(message, true); if (message.chatSequence <= previous) throw new Error('Invalid chat order'); previous = message.chatSequence; }
  for (const [key, request] of Object.entries(value.requests)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(request.fingerprint ?? '') || request.expiresAt !== request.message?.expiresAt
        || 'text' in request.message) throw new Error('Invalid chat request');
    checkMessage(request.message, false);
  }
  if (value.rates.room.some((at) => !Number.isFinite(at)) || Object.keys(value.rates.users).length > 1024
      || Object.entries(value.rates.users).some(([user, attempts]) => !/^[a-f0-9]{64}$/.test(user) || !Array.isArray(attempts)
        || attempts.length > 21 || attempts.some((at) => !Number.isFinite(at)))) throw new Error('Invalid chat rate record');
  return value;
}

export function createRoomChat({ storage, rooms, now = Date.now, pollIntervalMs = 1000, maxCasAttempts = 100,
  retentionMs = CHAT_RETENTION_MS, maxMessages = CHAT_MAX_MESSAGES, maxRequests = CHAT_MAX_REQUESTS } = {}) {
  if (!storage?.guardedCAS || !rooms?.getChatMember || !(retentionMs > 0 && retentionMs <= CHAT_RETENTION_MS)
      || !(maxMessages > 0 && maxMessages <= CHAT_MAX_MESSAGES) || !(maxRequests > 0 && maxRequests <= CHAT_MAX_REQUESTS)) throw new Error('Chat requires trusted rooms and atomic encrypted storage.');
  const listeners = new Set(); let closed = false, flight = Promise.resolve();
  async function load(roomId) {
    const saved = await storage.read('room-chat', roomId);
    const value = saved ? validateChatSnapshot(saved.value) : blank(roomId);
    return { value: prune(value, now(), maxMessages), version: saved?.version ?? null };
  }
  async function get(code, userKey, query = {}) {
    query = checkedQuery(query);
    const member = await rooms.getChatMember(code, userKey);
    const { value } = await load(member.roomId);
    // Membership may have changed while storage was being read. Never return to a former member.
    const current = await rooms.getChatMember(code, userKey);
    if (current.roomId !== member.roomId || current.playerId !== member.playerId) fail(403, 'SEAT_REQUIRED', '请先加入这个房间。');
    return history(value, userKey, query);
  }
  async function preparePacket(code, userKey, packet) {
    const member = await rooms.getChatMember(code, userKey);
    if (member.roomId !== packet.roomId) fail(403, 'SEAT_REQUIRED', '请先加入这个房间。');
    const { value } = await load(member.roomId);
    const current = await rooms.getChatMember(code, userKey);
    if (current.roomId !== member.roomId || current.playerId !== member.playerId) fail(403, 'SEAT_REQUIRED', '请先加入这个房间。');
    const retained = new Set(value.messages.filter((message) => message.expiresAt > now()).map((message) => message.messageId));
    const messages = packet.messages.filter((message) => retained.has(message.messageId) && message.expiresAt > now());
    return { ...packet, messages, oldestSequence: value.messages.find((message) => message.expiresAt > now())?.chatSequence ?? null,
      historyTruncated: packet.historyTruncated || messages.length !== packet.messages.length };
  }
  async function send(code, userKey, input) {
    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      const member = await rooms.getChatMember(code, userKey);
      const { value, version } = await load(member.roomId);
      let text, validationError;
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['text', 'requestId'].includes(key))
            || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId ?? '')) fail(400, 'INVALID_CHAT_REQUEST', '消息只需要文字和有效请求编号。');
        text = validateChatText(input.text);
      } catch (error) { validationError = error; }
      const id = !validationError ? hash(`${userKey}\0${input.requestId}`) : null;
      const fingerprint = !validationError ? hash(text) : null;
      const previous = id ? value.requests[id] : null;
      if (previous?.fingerprint === fingerprint) {
        await rooms.getChatMember(code, userKey);
        return { roomId: member.roomId, message: { ...previous.message, text, requestId: input.requestId }, duplicate: true,
          retained: value.messages.some((message) => message.messageId === previous.message.messageId) };
      }
      const time = now(), userAttempts = value.rates.users[userKey] ?? [];
      const retryAfter = Math.max(retryWait(userAttempts, 5, 10000, time), retryWait(userAttempts, 20, 60000, time), retryWait(value.rates.room, 120, 60000, time));
      value.rates.room.push(time); value.rates.room = value.rates.room.slice(-121);
      if (userKey in value.rates.users || Object.keys(value.rates.users).length < 1024) value.rates.users[userKey] = [...userAttempts, time].slice(-21);
      let error = retryAfter ? Object.assign(new RoomError(429, 'CHAT_RATE_LIMIT', '消息发送太快，请稍后再试。'), { retryAfter }) : validationError;
      if (!error && typeof member.chatProblem === 'function') {
        const blocked = member.chatProblem(text);
        if (blocked) error = new RoomError(blocked.status, blocked.code, blocked.message);
      }
      if (!error && previous) error = new RoomError(409, 'CHAT_REQUEST_ID_REUSED', '同一消息编号不能发送不同文字。');
      if (!error && Object.keys(value.requests).length >= maxRequests) {
        const earliest = Math.min(...Object.values(value.requests).map((request) => request.expiresAt));
        error = Object.assign(new RoomError(429, 'CHAT_DAILY_LIMIT', '本房消息已达到保留限额，请稍后发送。'), { retryAfter: Math.max(1, Math.ceil((earliest - time) / 1000)) });
      }
      let message;
      if (!error) {
        if (value.sequence >= Number.MAX_SAFE_INTEGER) fail(503, 'CHAT_SEQUENCE_LIMIT', '本房聊天暂时无法继续发送。');
        message = { messageId: randomBytes(16).toString('hex'), chatSequence: ++value.sequence,
          playerId: member.playerId, name: member.name, authorUserKey: userKey, requestId: input.requestId,
          text, sentAt: time, expiresAt: time + retentionMs };
        value.messages.push(message);
        const { text: ignoredText, authorUserKey, requestId, ...metadata } = message;
        value.requests[id] = { fingerprint, message: metadata, expiresAt: message.expiresAt };
        prune(value, time, maxMessages);
      }
      if (!(await storage.guardedCAS('room-chat', member.roomId, version, value, FOREVER, member.guard))) continue;
      if (error) throw error;
      await rooms.getChatMember(code, userKey);
      await publish();
      return { roomId: member.roomId, message: publicMessage(message, userKey), duplicate: false, retained: true };
    }
    fail(503, 'CHAT_BUSY', '聊天正在同步，请稍后重试。');
  }
  function end(listener, error) {
    if (!listener.active) return; listener.active = false; listeners.delete(listener);
    try { listener.onEnd?.(error.message, error.status ?? 503); } catch {}
  }
  async function deliverOnce(listener) {
    if (!listener.active) return;
    try {
      let packet = await get(listener.code, listener.userKey, listener.cursor === null ? {} : { after: listener.cursor });
      while (listener.active) {
        const signature = JSON.stringify(packet);
        if (signature !== listener.signature) {
          listener.signature = signature;
          listener.onChat(packet);
        }
        listener.cursor = packet.messages.at(-1)?.chatSequence ?? Math.max(listener.cursor ?? 0, packet.latestSequence);
        if (!packet.hasMore || !packet.messages.length) break;
        packet = await get(listener.code, listener.userKey, { after: listener.cursor });
      }
    } catch (error) { end(listener, error instanceof RoomError ? error : new RoomError(503, 'CHAT_UNAVAILABLE', '聊天暂时无法同步。')); }
  }
  async function deliver(listener) {
    if (listener.delivering) { listener.again = true; return listener.delivering; }
    listener.delivering = (async () => {
      do { listener.again = false; await deliverOnce(listener); } while (listener.active && listener.again);
    })();
    try { await listener.delivering; } finally { listener.delivering = null; }
  }
  async function publish() { for (const listener of [...listeners]) await deliver(listener); }
  async function subscribe(code, userKey, onChat, onEnd) {
    if (closed) fail(503, 'CHAT_CLOSED', '聊天服务正在重启。');
    await rooms.getChatMember(code, userKey);
    const listener = { code, userKey, onChat, onEnd, cursor: null, signature: null, active: true };
    listeners.add(listener); await deliver(listener);
    return () => { listener.active = false; listeners.delete(listener); };
  }
  async function sweep() {
    if (closed) return;
    for (const record of await storage.scan('room-chat')) {
      const previous = JSON.stringify(record.value);
      const value = prune(validateChatSnapshot(record.value), now(), maxMessages);
      if (JSON.stringify(value) !== previous) await storage.replaceCAS('room-chat', value.roomId, record.version, value, FOREVER);
    }
    await publish();
  }
  let polling = false;
  const timer = pollIntervalMs > 0 ? setInterval(() => {
    if (closed || polling) return; polling = true;
    flight = publish().catch(() => {}).finally(() => { polling = false; });
  }, pollIntervalMs) : null;
  timer?.unref();
  async function close() {
    closed = true; if (timer) clearInterval(timer);
    const closing = [...listeners];
    for (const listener of closing) end(listener, new RoomError(503, 'CHAT_CLOSED', '服务正在重启。'));
    await flight;
    await Promise.allSettled(closing.map((listener) => listener.delivering).filter(Boolean));
  }
  return { get, send, preparePacket, subscribe, sweep, close };
}
