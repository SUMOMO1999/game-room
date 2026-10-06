import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RoomChatModel, chatTextProblem } from './room-chat.mjs';
import { RoomClient, api } from './room-client.mjs';
import { loadAccount } from './account-client.mjs';
import { validateChatText } from '../server/chat.mjs';

const ROOM = 'synthetic-room-id';
const SELF = 'seat-self';
const NOW = 1_000_000;
const IDENTITY = { roomId: ROOM, roomCode: '123456', playerId: SELF, userKey: 'a'.repeat(64) };
function message(sequence, fields = {}) {
  return { messageId: `message-${sequence}`, chatSequence: sequence, playerId: 'seat-other', name: '朋友',
    text: `消息 ${sequence}`, sentAt: NOW, expiresAt: NOW + 86_400_000, ...fields };
}
function page(messages, fields = {}) {
  return { roomId: ROOM, messages, oldestSequence: messages[0]?.chatSequence || null,
    latestSequence: messages.at(-1)?.chatSequence || 0, hasMore: false, historyTruncated: false, ...fields };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides = {}) {
  let generation = 1; const updates = [], failures = [], sends = [], histories = [], notifications = [], confirmations = [];
  const transport = {
    async chatHistory(options = {}) { histories.push(options); return page([]); },
    async sendChat(body) { sends.push({ ...body }); return { roomId: ROOM, message: message(1, { playerId: SELF, requestId: body.requestId, text: body.text }) }; },
    ...overrides,
  };
  let nextId = 1;
  const model = new RoomChatModel({ onChange: (state) => updates.push(state), onUnavailable: (error) => failures.push(error), onNotify:messages=>notifications.push(messages),onSent:messages=>confirmations.push(messages),
    getGeneration: () => generation, now: () => NOW, requestId: () => `synthetic-request-${nextId++}` });
  model.bind(transport, IDENTITY);
  return { model, transport, updates, failures, sends, histories, notifications, confirmations, changeAccount: () => { ++generation; } };
}

test('own confirmation waits for the trusted reply and is emitted once in either SSE/POST order, even before initial history', async () => {
  for (const first of ['SSE', 'POST']) {
    const reply = deferred(), sent = [];
    const f = fixture({ sendChat(body) { sent.push(body); return reply.promise; } });
    f.model.online = true; f.model.setDraft('自己确认的消息'); const sending = f.model.send();
    assert.equal(f.confirmations.length, 0); assert.equal(f.model.snapshot().messages.length, 0);
    const ack = message(1, { playerId: SELF, text: sent[0].text, requestId: sent[0].requestId });
    if (first === 'SSE') f.model.receive(page([ack]));
    reply.resolve({ roomId: ROOM, message: ack }); await sending;
    if (first === 'POST') f.model.receive(page([ack]));
    assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0][0].text, '自己确认的消息');
    assert.equal(f.notifications.length, 0); assert.equal(f.model.snapshot().unread, 0);
    assert.equal(f.model.snapshot().messages.length, 1); assert.equal(f.model.snapshot().outbox.length, 0);
  }
});

test('history recovery, failed sends and discarded duplicate acknowledgements never replay an own confirmation', async () => {
  const reply = deferred(), sent = [];
  const f = fixture({ sendChat(body) { sent.push(body); return reply.promise; } });
  f.model.online = true; f.model.setDraft('待确认'); const sending = f.model.send();
  const ack = message(1, { playerId: SELF, text: sent[0].text, requestId: sent[0].requestId });
  f.model.receive(page([ack]), { history: true }); reply.resolve({ roomId: ROOM, message: ack }); await sending;
  assert.equal(f.confirmations.length, 0); assert.equal(f.model.snapshot().outbox.length, 0);
  f.model.receive(page([ack])); assert.equal(f.confirmations.length, 0);
  f.transport.sendChat = async () => { throw new TypeError('发送未确认'); };
  f.model.setDraft('失败消息'); await f.model.send();
  assert.equal(f.confirmations.length, 0); assert.equal(f.model.snapshot().outbox[0].status, 'failed');
  const pending = f.model.snapshot().outbox[0];
  f.model.receive(page([message(2, { playerId: SELF, text: pending.text, requestId: pending.requestId })]), { history: true });
  assert.equal(f.confirmations.length, 0);
  f.transport.sendChat = async body => ({ roomId: ROOM, retained: false, message: message(3, { playerId: SELF, text: body.text, requestId: body.requestId }) });
  f.model.setDraft('旧消息确认'); await f.model.send();
  assert.equal(f.confirmations.length, 0); assert.deepEqual(f.model.snapshot().messages.map(item=>item.messageId), ['message-2']);
});

test('a POST confirmation must match the current room, author, request id and immutable body', async () => {
  for (const changed of [{ roomId: 'other-room' }, { playerId: 'other-seat' }, { requestId: 'other-request' }, { text: '别的内容' }]) {
    const f = fixture({ async sendChat(body) {
      return { roomId: changed.roomId || ROOM, message: message(1, { playerId: SELF, text: body.text, requestId: body.requestId, ...changed }) };
    } });
    f.model.online = true; f.model.setDraft('原消息'); await f.model.send();
    assert.equal(f.confirmations.length, 0); assert.equal(f.model.snapshot().messages.length, 0);
    assert.equal(f.model.snapshot().outbox[0].status, 'failed');
  }
});
test('a same-seat SSE with the right request id and wrong body cannot settle or preview a local send',async()=>{
  const reply=deferred(),sent=[];const f=fixture({sendChat(body){sent.push(body);return reply.promise;}});
  f.model.online=true;f.model.setDraft('不可变原文');const sending=f.model.send();
  const fields={playerId:SELF,requestId:sent[0].requestId};
  f.model.receive(page([message(1,{...fields,text:'错配原文'})]));
  assert.equal(f.model.snapshot().outbox[0].status,'sending');assert.equal(f.model.snapshot().messages.length,0);assert.equal(f.confirmations.length,0);
  const ack=message(1,{...fields,text:sent[0].text});f.model.receive(page([ack]));reply.resolve({roomId:ROOM,message:ack});await sending;
  assert.equal(f.model.snapshot().outbox.length,0);assert.equal(f.confirmations.length,1);assert.equal(f.confirmations[0][0].text,'不可变原文');
});
test('new sends canonicalize NFC and CRLF like the real server; normalized ACKs and retries retain one id and leave the next draft raw',async()=>{
  for(const first of ['SSE','POST']) {
    const sent=[],raw='  cafe\u0301、か\u3099\r\n下一行  ',canonical=validateChatText(raw.trim());let calls=0;
    const f=fixture({async sendChat(body){
      sent.push({...body});if(++calls===1)throw new TypeError('首次结果丢失');
      const ack=message(1,{playerId:SELF,requestId:body.requestId,text:validateChatText(body.text)});
      if(first==='SSE')f.model.receive(page([ack]));return{roomId:ROOM,message:ack};
    }});
    f.model.online=true;f.model.setDraft(raw);assert.equal(f.model.snapshot().draft,raw);await f.model.send();
    const pending=f.model.snapshot().outbox[0];assert.equal(pending.text,canonical);assert.equal(pending.status,'failed');
    const nextDraft='下一句 e\u0301、は\u3099';f.model.setDraft(nextDraft);await f.model.send(pending.requestId);
    if(first==='POST')f.model.receive(page([message(1,{playerId:SELF,requestId:pending.requestId,text:canonical})]));
    assert.deepEqual(sent[0],sent[1]);assert.equal(sent[0].text,canonical);assert.equal(f.model.snapshot().outbox.length,0);
    assert.equal(f.model.snapshot().messages[0].text,canonical);assert.equal(f.confirmations.length,1);assert.equal(f.model.snapshot().draft,nextDraft);
    assert.equal(f.notifications.length,0);assert.equal(f.model.snapshot().unread,0);
  }
});

test('chat validates text limits without breaking composed emoji or allowing controls and malformed Unicode', () => {
  assert.equal(chatTextProblem('🧑🏽‍🤝‍🧑🏻 来玩\n第二行\n第三行'), null);
  assert.equal(chatTextProblem('😀'.repeat(500)), null);
  assert.match(chatTextProblem('😀'.repeat(501)), /500/);
  assert.ok(chatTextProblem('一\n二\n三\n四'));
  assert.ok(chatTextProblem(' \n '));
  assert.ok(chatTextProblem('消息\t不能带制表符'));
  assert.ok(chatTextProblem('\uD800'));
  assert.equal(chatTextProblem('<script>alert(1)</script> https://example.invalid/'), null);
  const composed='か\u3099'.repeat(500);assert.equal(chatTextProblem(composed),null);assert.equal([...validateChatText(composed)].length,500);
  assert.ok(chatTextProblem('か\u3099'.repeat(501)));assert.throws(()=>validateChatText('か\u3099'.repeat(501)));
  assert.equal(chatTextProblem('第一行\r\n第二行\r\n第三行'),null);assert.equal(chatTextProblem('第一行\r第二行')!==null,true);
});

test('room chat entry belongs to the persistent header, outside the in-game hidden topbar', async () => {
  const html = await readFile(new URL('./room.html', import.meta.url), 'utf8');
  const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
  assert.ok(header?.includes('id="chat-toggle"'));
  assert.ok(header.includes('id="chat-unread"'));
  assert.equal((html.match(/id="chat-toggle"/g) || []).length, 1);
  const topbar = html.match(/<div class="room-topbar">[\s\S]*?<\/div>/)?.[0];
  assert.ok(topbar && !topbar.includes('id="chat-toggle"'));
});

test('lost response retries the original message body and requestId; SSE and HTTP cannot duplicate a confirmed message', async () => {
  let calls = 0; const sent = [];
  const { model } = fixture({ async sendChat(body) {
    sent.push({ ...body }); if (++calls === 1) throw new TypeError('网络已断开，发送结果未确认。');
    const ack = message(1, { text: body.text, playerId: SELF, requestId: body.requestId });
    model.receive(page([ack])); return { roomId: ROOM, message: ack, duplicate: true };
  } });
  model.online = true; model.setDraft('今晚好牌！'); await model.send();
  const pending = model.snapshot().outbox[0]; assert.equal(pending.status, 'failed');
  model.setDraft('这一句还在写'); await model.send(pending.requestId);
  assert.deepEqual(sent[0], sent[1]); assert.equal(model.snapshot().messages.length, 1);
  assert.equal(model.snapshot().outbox.length, 0); assert.equal(model.snapshot().draft, '这一句还在写');
});

test('same-seat SSE acknowledgement wins over a subsequently lost HTTP response', async () => {
  const reply = deferred(); const { model, sends } = fixture({ sendChat(body) { sends.push(body); return reply.promise; } });
  model.online = true; model.setDraft('开局吧'); const sending = model.send();
  const ack = message(1, { playerId: SELF, text: sends[0].text, requestId: sends[0].requestId });
  model.receive(page([ack])); reply.reject(new TypeError('HTTP response lost')); await sending;
  assert.equal(model.snapshot().outbox.length, 0); assert.equal(model.snapshot().notice, '已发送');
  assert.deepEqual(model.snapshot().messages.map((item) => item.messageId), ['message-1']);
});

test('same body and same nickname from another seat cannot acknowledge my pending message', async () => {
  const reply = deferred(); const { model, sends } = fixture({ sendChat(body) { sends.push(body); return reply.promise; } });
  model.online = true; model.setDraft('一样的话'); const sending = model.send();
  model.receive(page([message(1, { text: '一样的话', requestId: sends[0].requestId })]));
  assert.equal(model.snapshot().outbox[0].status, 'sending');
  assert.ok(!('requestId' in model.snapshot().messages[0]));
  reply.reject(new TypeError('lost')); await sending;
  assert.equal(model.snapshot().outbox[0].status, 'failed');
});

test('a late send from a former account or room cannot reveal text or overwrite the new identity', async () => {
  const reply = deferred(); const { model, transport, changeAccount, confirmations } = fixture({ sendChat: () => reply.promise });
  model.online = true; model.setDraft('原账号私有草稿'); const sending = model.send();
  changeAccount(); model.clear(); model.bind(transport, { ...IDENTITY, userKey: 'b'.repeat(64), playerId: 'second-seat' });
  model.setDraft('新账号草稿'); reply.resolve({ roomId: ROOM, message: message(1, { playerId: SELF, text: '原账号私有草稿' }) }); await sending;
  assert.equal(model.snapshot().messages.length, 0); assert.equal(model.snapshot().outbox.length, 0);
  assert.equal(confirmations.length, 0);
  assert.equal(model.snapshot().draft, '新账号草稿');
  assert.equal(model.receive(page([message(2)]), {}), true);
  assert.equal(model.receive(page([message(3)], { roomId: 'different-room' })), false);
});

test('late history cannot repopulate a cleared private drawer after logout', async () => {
  const reply = deferred(); const { model, changeAccount } = fixture({ chatHistory: () => reply.promise });
  const loading = model.sync(); await Promise.resolve();
  changeAccount(); model.clear(); reply.resolve(page([message(1, { text: '不应再次显示的消息' })])); await loading;
  assert.equal(model.snapshot().available, false); assert.equal(model.snapshot().messages.length, 0);
  assert.equal(model.snapshot().draft, '');
});

test('503 clears all private display and restores only same-account same-room same-seat tab-local drafts and pending ids', async () => {
  let fail = true;
  const { model, transport, failures } = fixture({ async sendChat() { if (fail) throw Object.assign(new Error('身份暂时不可用'), { status: 503 }); } });
  model.online = true; model.setDraft('待确认消息');
  model.receive(page([message(1)]));
  const sending = model.send(); model.setDraft('正在写的下一条'); await sending;
  assert.equal(failures[0].status, 503); assert.equal(model.snapshot().available, false);
  assert.equal(model.snapshot().messages.length, 0); assert.equal(model.snapshot().outbox.length, 0); assert.equal(model.snapshot().draft, '');
  model.bind(transport, IDENTITY); assert.equal(model.snapshot().draft, '正在写的下一条');
  assert.equal(model.snapshot().outbox[0].requestId, 'synthetic-request-1'); assert.equal(model.snapshot().outbox[0].status, 'failed');
  model.clear({ preserveDraft: true }); model.bind(transport, { ...IDENTITY, playerId: 'different-seat' });
  assert.equal(model.snapshot().draft, ''); assert.equal(model.snapshot().outbox.length, 0);
  fail = false;
});

test('401 and explicit logout discard a previously retained 503 draft instead of restoring it later', async () => {
  const { model, transport } = fixture({ async sendChat() { throw Object.assign(new Error('已过期'), { status: 401 }); } });
  model.setDraft('稍后恢复'); model.clear({ preserveDraft: true }); model.clear(); model.bind(transport, IDENTITY);
  assert.equal(model.snapshot().draft, '');
  model.online = true; model.setDraft('到期期间的消息'); await model.send(); model.bind(transport, IDENTITY);
  assert.equal(model.snapshot().draft, ''); assert.equal(model.snapshot().outbox.length, 0);
});

test('before pagination preserves chronological order, never counts old messages as unread and leaves the reader above latest', async () => {
  const historyCalls = [];
  const { model } = fixture({ async chatHistory(options) { historyCalls.push(options); return page([message(1), message(2)], { latestSequence: 4, oldestSequence: 1 }); } });
  model.receive(page([message(3), message(4)], { oldestSequence: 1, hasMore: true }));
  model.setOpen(true); await model.older();
  assert.deepEqual(historyCalls, [{ before: 3 }]);
  assert.deepEqual(model.snapshot().messages.map((item) => item.chatSequence), [1, 2, 3, 4]);
  assert.equal(model.snapshot().unread, 0); assert.equal(model.snapshot().atLatest, false);
  model.receive(page([message(5)], { oldestSequence: 1 }));
  assert.equal(model.snapshot().unread, 1); assert.equal(model.snapshot().atLatest, false);
  model.jumpLatest(); assert.equal(model.snapshot().unread, 0);
});

test('closed drawer counts each new foreign message once while suppressing initial history and own acknowledgements', () => {
  const { model } = fixture(); model.receive(page([message(1)]));
  model.receive(page([message(2)], { oldestSequence: 1 })); model.receive(page([message(2)], { oldestSequence: 1 }));
  model.receive(page([message(3, { playerId: SELF })], { oldestSequence: 1 }));
  assert.equal(model.snapshot().unread, 1); model.setOpen(true); assert.equal(model.snapshot().unread, 0);
  model.receive(page([message(4)], { oldestSequence: 1 })); assert.equal(model.snapshot().unread, 0);
  model.setAtLatest(false); model.receive(page([message(5)], { oldestSequence: 1 })); assert.equal(model.snapshot().unread, 1);
});

test('reconnect asks after the confirmed cursor even when no new latest sequence was advertised', async () => {
  const calls = []; const { model } = fixture({ async chatHistory(options) { calls.push(options); return page([message(2)], { oldestSequence: 1 }); } });
  model.receive(page([message(1)])); model.setConnection('online'); await model.historyTask;
  assert.deepEqual(calls, [{ after: 1 }]); assert.equal(model.snapshot().messages.length, 2);
  assert.equal(model.snapshot().unread, 1); assert.equal(model.syncSequence, 2);
});

test('out-of-order SSE fills a missing sequence from its predecessor cursor instead of skipping the gap', async () => {
  const calls = [];
  const { model } = fixture({ async chatHistory(options) { calls.push(options); return page([message(2), message(3)], { oldestSequence: 1 }); } });
  model.receive(page([message(1)])); model.online = true;
  model.receive(page([message(3)], { oldestSequence: 1 })); await model.historyTask;
  assert.deepEqual(calls, [{ after: 1 }]);
  assert.deepEqual(model.snapshot().messages.map((item) => item.chatSequence), [1, 2, 3]);
  assert.equal(model.syncSequence, 3); assert.equal(model.snapshot().unread, 2);
});

test('new SSE arriving during a history response is fetched even if that response advertised no more pages', async () => {
  const reply = deferred(); const calls = [];
  const { model } = fixture({ async chatHistory(options) {
    calls.push(options); if (calls.length === 1) return reply.promise;
    return page([message(3), message(4)], { oldestSequence: 1 });
  } });
  model.receive(page([message(1)])); const catchingUp = model.sync(); await Promise.resolve();
  model.receive(page([message(4)], { oldestSequence: 1 }));
  reply.resolve(page([message(2)], { oldestSequence: 1, hasMore: false })); await catchingUp;
  assert.deepEqual(calls, [{ after: 1 }, { after: 2 }]);
  assert.deepEqual(model.snapshot().messages.map((entry) => entry.chatSequence), [1, 2, 3, 4]);
});

test('expired, truncated and server-discarded duplicate acknowledgements do not revive old messages', async () => {
  const { model } = fixture({ async sendChat(body) { return { roomId: ROOM, duplicate: true, retained: false,
    message: message(1, { playerId: SELF, text: body.text, requestId: body.requestId }) }; } });
  model.receive(page([message(1), message(2)]));
  model.receive(page([message(4)], { oldestSequence: 4, historyTruncated: true }));
  assert.deepEqual(model.snapshot().messages.map((item) => item.chatSequence), [4]);
  model.receive(page([message(5, { expiresAt: NOW - 1 })], { oldestSequence: 4 }));
  assert.equal(model.snapshot().messages.length, 1); assert.equal(model.snapshot().historyTruncated, true);
  model.online = true; model.setDraft('原消息'); await model.send();
  assert.deepEqual(model.snapshot().messages.map((item) => item.chatSequence), [4]);
  assert.equal(model.snapshot().outbox.length, 0); assert.match(model.snapshot().notice, /超出/);
});

test('rate limiting keeps the original pending request retryable and reports a bounded wait', async () => {
  const { model, failures } = fixture({ async sendChat() { throw Object.assign(new Error('slow down'), { status: 429, retryAfter: 8 }); } });
  model.online = true; model.setDraft('不要丢掉这一句'); await model.send();
  assert.equal(failures.length, 0); assert.equal(model.snapshot().available, true);
  assert.equal(model.snapshot().outbox[0].requestId, 'synthetic-request-1'); assert.match(model.snapshot().outbox[0].error, /8 秒/);
});

const AUTH = { mode: 'mock', authenticated: true, loginReady: true, userKey: 'a'.repeat(64), csrf: 'synthetic-csrf', profile: null, recentRooms: [] };
function response(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }
function event(type, data) { return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; }
function stream(text) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 997) controller.enqueue(bytes.slice(i, i + 997));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
test('same private SSE dispatches a 100-message UTF-8 chat page independently from game view and filters other rooms', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(AUTH)); await loadAccount();
  const views = [], chats = [];
  const client = new RoomClient('123456', { playerId: SELF, token: 'ignored-legacy-token' }, {
    onView: (value) => views.push(value), onChat: (value) => chats.push(value), onConnection() {}, onError() {},
  }); t.after(() => client.stop());
  const view = { roomCode: '123456', roomId: ROOM, selfId: SELF, revision: 1, game: { rack: [{ id: 'private-tile' }] } };
  const largePage = page(Array.from({ length: 100 }, (_, index) => message(index + 1, { text: '😀'.repeat(500) })));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/rooms/123456/events'); assert.equal(options.credentials, 'same-origin'); assert.ok(!options.headers.Authorization);
    return stream(event('view', view) + event('chat', page([message(101)], { roomId: 'another-room' }))
      + event('chat', largePage) + event('closed', { status: 404 }));
  });
  await assert.rejects(client.readStream(new AbortController()), (error) => error.status === 404);
  assert.equal(views.length, 1); assert.equal(chats.length, 1); assert.equal(chats[0].messages.length, 100);
  assert.equal(chats[0].messages[99].text, '😀'.repeat(500)); assert.equal(client.view.revision, 1);
  assert.equal(client.view.game.rack[0].id, 'private-tile');
});

test('chat requests use the original room client cookie, CSRF and fixed requestId without touching game revision', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(AUTH)); await loadAccount();
  const client = new RoomClient('123456', { playerId: SELF }, { onView() {}, onConnection() {}, onError() {} }); t.after(() => client.stop());
  client.receive({ roomId: ROOM, roomCode: '123456', selfId: SELF, revision: 7 });
  const calls = []; t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return response(page([message(1)])); });
  await client.chatHistory({ before: 7 }); await client.sendChat({ text: '消息', requestId: 'same-request-id' });
  assert.equal(calls[0].url, '/api/rooms/123456/chat?limit=100&before=7'); assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.headers['X-CSRF-Token'], AUTH.csrf); assert.equal(calls[1].options.credentials, 'same-origin');
  assert.ok(!calls[1].options.headers.Authorization);
  assert.deepEqual(JSON.parse(calls[1].options.body), { text: '消息', requestId: 'same-request-id' }); assert.equal(client.view.revision, 7);
});

test('malformed retry hints cannot become negative, infinite or unbounded UI waits', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(AUTH)); await loadAccount();
  for (const [value, expected] of [[9, 9], [-2, null], ['Infinity', null], [999999, null], [1.5, 2]]) {
    t.mock.method(globalThis, 'fetch', async () => response({ error: '稍后', retryAfter: value }, 429));
    await assert.rejects(api('/api/rooms/123456/chat', { method: 'POST', body: {} }), (error) => error.status === 429 && error.retryAfter === expected);
  }
});

test('live foreign messages alert once; initial history, recovery pages, own sends, offline and duplicate packets never alert',()=>{
  const f=fixture();f.model.online=true;f.model.receive(page([message(1)]));assert.equal(f.notifications.length,0);
  f.model.receive(page([message(2)],{oldestSequence:1}));assert.equal(f.notifications.length,1);assert.equal(f.notifications[0][0].messageId,'message-2');
  f.model.receive(page([message(2)],{oldestSequence:1}));f.model.receive(page([message(3,{playerId:SELF})],{oldestSequence:1}));assert.equal(f.notifications.length,1);
  f.model.receive(page([message(4)],{oldestSequence:1}),{history:true,countUnread:true});assert.equal(f.notifications.length,1);
  f.model.online=false;f.model.receive(page([message(5)],{oldestSequence:1}));assert.equal(f.notifications.length,1);
  f.changeAccount();assert.equal(f.model.receive(page([message(6)],{oldestSequence:1})),false);assert.equal(f.notifications.length,1);
  f.model.clear();f.model.bind(f.transport,IDENTITY);f.model.online=true;f.model.receive(page([message(6)],{oldestSequence:1}));assert.equal(f.notifications.length,1);
});
