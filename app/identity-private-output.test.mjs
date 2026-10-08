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
import { createCanvasHttp } from '../server/games/draw-and-guess/canvas-http.mjs';
import { CANVAS_SCOPE } from '../server/games/draw-and-guess/canvas-service.mjs';
import { identityCheckContextFor } from '../server/identity-check-context.mjs';
import { createRequestId } from '../server/content/draw-and-guess-wordbank.mjs';
import { canonicalWordbankRequestFingerprint } from './games/draw-and-guess/request-intent.mjs';

const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function committedChatFixture(t, sqlite) {
  const f = await fixture(t, { sqlite });
  const room = await f.runtime.rooms.createRoom(f.userKey, '聊天回执伙伴', randomUUID());
  const observed = { sends: 0, commits: 0, broadcasts: [], receipt: null };
  const send = f.runtime.chat.send.bind(f.runtime.chat), cas = f.storage.guardedCAS.bind(f.storage);
  f.runtime.chat.send = async (...args) => {
    observed.sends++;
    observed.receipt = await send(...args);
    return observed.receipt;
  };
  f.storage.guardedCAS = async (...args) => {
    const committed = await cas(...args);
    if (args[0] === 'room-chat' && committed) observed.commits++;
    return committed;
  };
  const unsubscribe = await f.runtime.chat.subscribe(room.roomCode, f.userKey, packet => {
    if (packet.messages.length) observed.broadcasts.push(packet);
  });
  t.after(unsubscribe);
  async function assertCommittedOnce() {
    const saved = (await f.storage.read('room-chat', room.view.roomId)).value;
    assert.equal(observed.sends, 1); assert.equal(observed.commits, 1);
    assert.equal(saved.sequence, 1); assert.equal(saved.messages.length, 1);
    assert.equal(Object.keys(saved.requests).length, 1); assert.equal(saved.rates.room.length, 1);
    assert.equal(observed.broadcasts.length, 1);
    assert.equal(observed.broadcasts[0].messages[0].messageId, saved.messages[0].messageId);
    assert.equal(observed.receipt.message.messageId, saved.messages[0].messageId);
  }
  return { ...f, room, observed, assertCommittedOnce };
}

function conflictCommittedChatRoom(f, count) {
  const verify = f.storage.verifyGuards.bind(f.storage), evidence = [];
  f.storage.verifyGuards = async input => {
    if (evidence.length < count && input.guards.some(guard => guard.scope === 'rooms' && guard.id === f.room.view.roomId)) {
      await f.assertCommittedOnce();
      const row = await f.storage.read('rooms', f.room.view.roomId);
      row.value.snapshot.lastActiveAt++;
      assert.equal(await f.storage.replaceCAS('rooms', f.room.view.roomId, row.version, row.value, row.expiresAt), true);
      const valid = await verify(input);
      evidence.push(valid);
      assert.equal(valid, false, 'the original atomic guard actually rejects the committed room CAS');
      return valid;
    }
    return verify(input);
  };
  return evidence;
}

// Real BFF, session, domain and storage modules; only the online provider and
// HTTP socket are synthetic. These cases do not prove batch-wire integration.
async function fixture(t, { sqlite = false, timeoutMs = 1000, roomOptions = {} } = {}) {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(':memory:') : new MemoryAdapter(), randomBytes(32));
  const issuer = 'urn:game-room:synthetic-private-output', sub = 'fictional-member';
  const userKey = identityKey(issuer, sub), id = opaqueId(), csrf = opaqueId(), now = Date.now();
  await storage.put('sessions', id, { phase: 'active', issuer, sub, userKey, csrf,
    accessToken: 'synthetic-server-only', expiresAt: now + 3600000, idleUntil: now + settings.idleMs }, now + settings.idleMs);
  const checks = [];
  const sessions = new SessionService(settings, { store: storage, authorizationTimeoutMs: timeoutMs,
    provider: { usesBatchIdentity: true, async check(identity, options) {
      checks.push(options.context); options.context.assert(); return { ...identity };
    } } });
  const requests = [], authorize = sessions.authorize.bind(sessions);
  sessions.authorize = (request, options) => { requests.push(request); return authorize(request, options); };
  const runtime = createRuntime(settings, { storage, sessions, drawingEnabled: true,
    roomOptions: { pollIntervalMs: 0, ...roomOptions }, chatOptions: { pollIntervalMs: 0 } });
  await runtime.wordbankReady; await runtime.canvases.ready;
  const server = createUnifiedServer(runtime);
  t.after(() => server.shutdown());
  function request(path, body, inputStream) {
    const req = inputStream || Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = body === undefined ? 'GET' : 'POST'; req.url = path;
    req.headers = { host: new URL(settings.origin).host, cookie: `${settings.cookieName}=${id}`,
      ...(body === undefined ? {} : { origin: settings.origin, 'content-type': 'application/json', 'x-csrf-token': csrf }) };
    req.socket = { remoteAddress: '127.0.0.1' };
    const finished = deferred(), res = new EventEmitter();
    Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false, writableLength: 0, frames: [] });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
    res.flushHeaders = () => {};
    res.write = value => { res.frames.push(String(value)); return true; };
    res.end = value => { res.body = value ? JSON.parse(String(value)) : null; res.writableEnded = true; finished.resolve(); };
    server.emit('request', req, res);
    return { req, res, finished: finished.promise };
  }
  async function privatePack() {
    const actor = { userKey, member: true, displayName: '伙伴' };
    const created = await runtime.wordbanks.create(actor, { requestId: createRequestId(), name: '独审合成私库', visibility: 'private' });
    await runtime.wordbanks.change(actor, created.packId, { requestId: createRequestId(), expectedDraftRevision: 0,
      operations: [{ type: 'word.add', id: 'private-word', answer: '蒲公英', category: 'custom', difficulty: 'easy' }] });
    return { actor, packId: created.packId };
  }
  return { settings, storage, sessions, runtime, server, request, privatePack, checks, requests, id, userKey };
}

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  test(`${adapter}: batch POST chat recovers one completed room conflict without replaying its message`, { timeout: 3000 }, async t => {
    const f = await committedChatFixture(t, sqlite), evidence = conflictCommittedChatRoom(f, 1);
    const response = f.request(`/api/rooms/${f.room.roomCode}/chat`, { requestId: 'one-confirmed-chat', text: '已确认聊天回执' });
    await response.finished;
    await f.assertCommittedOnce(); assert.deepEqual(evidence, [false]);
    assert.equal(response.res.status, 200);
    assert.deepEqual(response.res.body, f.observed.receipt);
    assert.equal(Object.hasOwn(response.res.body, 'view'), false);
    assert.equal(f.checks.length, 2); assert.equal(f.checks[0], f.checks[1]);
    assert.equal(identityCheckContextFor(f.requests[0]), undefined);
  });

  test(`${adapter}: batch POST chat refuses a second completed room conflict and keeps exactly one committed message`, { timeout: 3000 }, async t => {
    const f = await committedChatFixture(t, sqlite), evidence = conflictCommittedChatRoom(f, 2);
    const response = f.request(`/api/rooms/${f.room.roomCode}/chat`, { requestId: 'twice-fenced-chat', text: '二次冲突不能重发' });
    await response.finished;
    await f.assertCommittedOnce(); assert.deepEqual(evidence, [false, false]);
    assert.equal(response.res.status, 503); assert.equal(response.res.body.code, 'identity_unavailable');
    assert.equal(Object.hasOwn(response.res.body, 'message'), false);
    assert.equal(f.checks.length, 2); assert.equal(f.checks[0], f.checks[1]);
  });

  test(`${adapter}: batch POST chat does not transfer its committed acknowledgement to a newer same-subject login`, { timeout: 3000 }, async t => {
    const f = await committedChatFixture(t, sqlite), send = f.runtime.chat.send.bind(f.runtime.chat);
    f.runtime.chat.send = async (...args) => {
      const receipt = await send(...args), session = await f.storage.read('sessions', f.id);
      session.value.accessToken = 'synthetic-new-login-token';
      assert.equal(await f.storage.replaceCAS('sessions', f.id, session.version, session.value, session.expiresAt), true);
      return receipt;
    };
    const response = f.request(`/api/rooms/${f.room.roomCode}/chat`, { requestId: 'original-login-chat', text: '原登录已提交的正文' });
    await response.finished; await f.assertCommittedOnce();
    assert.equal(response.res.status, 503); assert.equal(response.res.body.code, 'identity_unavailable');
    assert.equal(Object.hasOwn(response.res.body, 'message'), false);
    assert.equal(f.checks.length, 2); assert.equal(f.checks[0], f.checks[1]);
  });
}

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  test(`${adapter}: a rejected wordbank receipt survives logout while its private error details are suppressed`, async t => {
    const f = await fixture(t, { sqlite }), { actor, packId } = await f.privatePack();
    const cas = f.storage.compareAndSwapMany.bind(f.storage); let invalidated = false;
    f.storage.compareAndSwapMany = async transaction => {
      const committed = await cas(transaction);
      if (committed && !invalidated && transaction.changes.some(change => change.value?.receipts?.some(receipt => receipt.status === 'rejected'))) {
        invalidated = true;
        assert.equal(await f.sessions.invalidateCurrent(f.id, await f.storage.read('sessions', f.id)), true);
      }
      return committed;
    };
    const input = { requestId: createRequestId(), expectedDraftRevision: 1,
      operations: [{ type: 'category.status', id: 'custom', status: 'disabled', confirmedAffectedCount: 0 }] };
    const response = f.request(`/api/wordbanks/${packId}/changes`, input);
    await response.finished; await nextTurn();
    assert.equal(invalidated, true); assert.equal(response.res.status, 401);
    assert.equal('details' in response.res.body, false);
    assert.equal(await f.storage.read('sessions', f.id), null);
    const receipt = await f.runtime.wordbanks.queryRequest(actor, { requestId: input.requestId,
      fingerprint: await canonicalWordbankRequestFingerprint('change', packId, input) });
    assert.equal(receipt.status, 'rejected'); assert.equal(receipt.error.code, 'IMPACT_CONFIRMATION');
    assert.equal(receipt.error.details.affected, 1);
    const pack = await f.runtime.wordbanks.get(actor, packId);
    assert.equal(pack.draftRevision, 1); assert.equal(pack.draft.categories[0].status, 'active');
    assert.equal(identityCheckContextFor(f.requests[0]), undefined);
  });

  test(`${adapter}: a renewed session cannot receive a private wordbank response prepared under its old version`, async t => {
    const f = await fixture(t, { sqlite }), { packId } = await f.privatePack();
    const assertCurrent = f.sessions.assertCurrent.bind(f.sessions), read = f.storage.read.bind(f.storage);
    let armed = false, renewed = false;
    f.sessions.assertCurrent = (...args) => { armed = true; return assertCurrent(...args); };
    f.storage.read = async (...args) => {
      const record = await read(...args);
      if (armed && !renewed && args[0] === 'sessions') {
        renewed = true;
        assert.equal(await f.storage.replaceCAS('sessions', f.id, record.version,
          { ...record.value, csrf: opaqueId() }, record.expiresAt), true);
      }
      return record;
    };
    const response = f.request(`/api/wordbanks/${packId}`);
    await response.finished; await nextTurn();
    assert.equal(renewed, true); assert.equal(response.res.status, 503);
    assert.equal(JSON.stringify(response.res.body).includes('蒲公英'), false);
    assert.ok(await read('sessions', f.id), 'availability failure must preserve the renewed session');
    assert.equal(identityCheckContextFor(f.requests[0]), undefined);
  });

  test(`${adapter}: an expired wordbank body reader cannot start a new write after logout`, async t => {
    const f = await fixture(t, { sqlite }), { actor, packId } = await f.privatePack();
    const input = { requestId: createRequestId(), expectedDraftRevision: 1,
      operations: [{ type: 'word.add', id: 'late-word', answer: '海豚', category: 'custom', difficulty: 'easy' }] };
    const reading = deferred(), release = deferred(), inputCompleted = deferred();
    const inputStream = Readable.from((async function* () {
      reading.resolve(); await release.promise;
      yield Buffer.from(JSON.stringify(input)); inputCompleted.resolve();
    })());
    const response = f.request(`/api/wordbanks/${packId}/changes`, input, inputStream);
    try {
      await reading.promise;
      const context = identityCheckContextFor(f.requests[0]);
      context.restrict(Math.ceil(1000 - context.remainingMs()) + 40);
      await response.finished; await nextTurn();
      assert.equal(response.res.status, 503);
      assert.equal(await f.sessions.invalidateCurrent(f.id, await f.storage.read('sessions', f.id)), true);
      release.resolve(); await inputCompleted.promise; await nextTurn();
      const pack = await f.runtime.wordbanks.get(actor, packId);
      assert.equal(pack.draftRevision, 1); assert.equal(pack.draft.words.length, 1);
      const receipt = await f.runtime.wordbanks.queryRequest(actor, { requestId: input.requestId,
        fingerprint: await canonicalWordbankRequestFingerprint('change', packId, input) });
      assert.equal(receipt.status, 'unknown', 'no intent was started before the original deadline');
      assert.equal(identityCheckContextFor(f.requests[0]), undefined);
    } finally { release.resolve(); await inputCompleted.promise; }
  });
}

test('SSE setup expires, unbinds its request context and closes a subscription only after that subscription really returns', async t => {
  const f = await fixture(t);
  const room = await f.runtime.rooms.createRoom(f.userKey, '伙伴', randomUUID());
  const subscribed = deferred(), release = deferred(), actuallyClosed = deferred();
  const subscribe = f.runtime.rooms.subscribe; let unsubscribeCalls = 0;
  f.runtime.rooms.subscribe = async (...args) => {
    const unsubscribe = await subscribe(...args);
    subscribed.resolve(); await release.promise;
    return async () => { unsubscribeCalls++; await unsubscribe(); actuallyClosed.resolve(); };
  };
  const response = f.request(`/api/rooms/${room.roomCode}/events`);
  try {
    await subscribed.promise;
    const context = identityCheckContextFor(f.requests[0]);
    // Shorten the existing trigger only after the controlled setup is pending;
    // the initial real storage work is not required to win a tiny wall-clock race.
    context.restrict(Math.ceil(1000 - context.remainingMs()) + 40);
    await response.finished; await nextTurn();
    assert.equal(response.res.status, 200, 'SSE headers were already sent');
    assert.ok(response.res.frames.some(frame => frame.startsWith('event: closed') && frame.includes('"status":503')));
    assert.equal(identityCheckContextFor(f.requests[0]), undefined);
    assert.equal(unsubscribeCalls, 0, 'ending the waiter cannot claim that the underlying subscription returned');
    const before = await f.storage.read('room-presence', room.view.roomId);
    assert.equal(Object.values(before.value.connections).flatMap(connections => Object.keys(connections)).length, 1);
    const framesAtClose = response.res.frames.length;
    release.resolve(); await actuallyClosed.promise; await nextTurn();
    assert.equal(unsubscribeCalls, 1);
    const after = await f.storage.read('room-presence', room.view.roomId);
    assert.equal(Object.values(after.value.connections).flatMap(connections => Object.keys(connections)).length, 0);
    assert.equal(response.res.frames.length, framesAtClose, 'late setup cannot send private data after EOF');
    assert.ok(await f.storage.read('sessions', f.id));
  } finally {
    release.resolve(); await actuallyClosed.promise;
    response.res.destroyed = true; response.res.emit('close');
  }
});

test('an already aborted canvas request starts no identity or domain work and removes its listeners', async t => {
  const f = await fixture(t); let reads = 0;
  const route = createCanvasHttp({ sessions: f.sessions, rooms: f.runtime.rooms,
    canvases: { read: async () => { reads++; }, invalidateAuthorization() {} }, limit() {}, reply() {}, readJson: async () => ({}) });
  const req = new EventEmitter(), res = new EventEmitter();
  Object.assign(req, { method: 'GET', aborted: true });
  Object.assign(res, { destroyed: true, writableEnded: false });
  await assert.rejects(route({ req, res, url: new URL('/api/rooms/123456/canvas', f.settings.origin),
    webRequest: new Request(f.settings.origin, { headers: { cookie: `${f.settings.cookieName}=${f.id}` } }) }), error => error.status === 503);
  assert.equal(f.checks.length, 0); assert.equal(reads, 0);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
  assert.ok(await f.storage.read('sessions', f.id));
});

test('non-canvas SSE keeps the full projected room binding even when its storage context resolves the original room', { timeout: 3000 }, async t => {
  const f = await fixture(t), room = await f.runtime.rooms.createRoom(f.userKey, '伙伴', randomUUID());
  const original = f.runtime.rooms.getGameContext;
  f.runtime.rooms.getGameContext = async (...args) => {
    const result = await original(...args);
    // Simulate a mismatched projection after asynchronous authorization. The
    // resolved row ID must not replace the older full-view binding fence.
    if (result.view) result.view.roomId = 'f'.repeat(32);
    return result;
  };
  const response = f.request(`/api/rooms/${room.roomCode}/events`);
  try {
    await response.finished;
    assert.ok(response.res.frames.some(frame => frame.startsWith('event: closed') && frame.includes('"status":404')));
    assert.equal(response.res.frames.some(frame => frame.startsWith('event: view')), false);
    assert.ok(await f.storage.read('sessions', f.id), 'a project room mismatch does not invalidate the shared account');
  } finally {
    response.res.destroyed = true; response.res.emit('close');
  }
});

test('actual BFF canvas append acknowledges one committed batch after a concurrent wrong-guess room receipt', { timeout: 5000 }, async t => {
  const f=await fixture(t,{sqlite:true,roomOptions:{serverRandomInt:()=>0}});
  const room=await f.runtime.rooms.createRoom(f.userKey,'画者',randomUUID(),'draw-and-guess');
  const other=identityKey('urn:game-room:synthetic-private-output','fictional-other');
  await f.runtime.rooms.joinRoom(room.roomCode,other,'猜者',randomUUID());
  const act=async(user,type,fields={})=>{
    const view=await f.runtime.rooms.getView(room.roomCode,user);
    return f.runtime.rooms.action(room.roomCode,user,{type,requestId:randomUUID(),expectedRevision:view.revision,...fields});
  };
  await act(f.userKey,'ready',{ready:true});await act(other,'ready',{ready:true});await act(f.userKey,'start');
  const view=await f.runtime.rooms.getView(room.roomCode,f.userKey);
  await act(f.userKey,'choose',{matchId:view.matchId,turnId:view.game.turnId,candidateId:view.game.candidates[0].id});
  const canvas=await f.runtime.canvases.read(room.roomCode,f.userKey),deviceId='bff-single-commit';
  const acquire=f.request(`/api/rooms/${room.roomCode}/canvas/acquire`,{deviceId,canvasId:canvas.canvasId,bootId:canvas.bootId});
  await acquire.finished;assert.equal(acquire.res.status,200);
  const lease=acquire.res.body,verify=f.storage.verifyGuards.bind(f.storage),append=f.runtime.canvases.append.bind(f.runtime.canvases);
  let injected=0,guards=0,writes=0;
  f.storage.verifyGuards=async input=>{
    guards++;
    if(!injected && input.guards.some(guard=>guard.scope==='rooms')) {
      injected++;
      await act(other,'guess',{matchId:view.matchId,turnId:view.game.turnId,text:'不可能匹配的合成答案'});
    }
    return verify(input);
  };
  f.runtime.canvases.append=(...args)=>{writes++;return append(...args);};f.checks.length=0;
  const response=f.request(`/api/rooms/${room.roomCode}/canvas/append`,{deviceId,canvasId:lease.canvasId,bootId:lease.bootId,
    leaseGeneration:lease.leaseGeneration,clearGeneration:lease.clearGeneration,expectedSequence:lease.sequence,requestId:'single-confirmed-batch',
    operations:[{strokeId:'one-stroke',tool:'pen',color:'#182a33',width:4,points:[[.1,.2],[.2,.3]]}]});
  await response.finished;
  assert.equal(response.res.status,200);assert.equal(response.res.body.ack.sequence,1);
  assert.equal(injected,1);assert.equal(guards,2);assert.equal(writes,1);assert.equal(f.checks.length,2,'readonly recheck never starts another fresh request');
  assert.equal(f.checks[0],f.checks[1],'both original fresh checks retain the same trigger');
  const saved=await f.runtime.canvases.read(room.roomCode,f.userKey);
  assert.equal(saved.sequence,1);assert.deepEqual(saved.strokes[0].points,[[.1,.2],[.2,.3]]);
});

test('actual non-canvas SSE rechecks a changed room once and sends the latest view exactly once', { timeout: 3000 }, async t => {
  const f=await fixture(t,{sqlite:true}),room=await f.runtime.rooms.createRoom(f.userKey,'伙伴',randomUUID());
  const verify=f.storage.verifyGuards.bind(f.storage),assertCurrent=f.sessions.assertCurrent.bind(f.sessions);
  let injected=0,guards=0,guardsAtView=0,eventContext;
  f.sessions.assertCurrent=(session,options)=>{eventContext??=options.context;return assertCurrent(session,options);};
  f.storage.verifyGuards=async input=>{
    guards++;
    if(!injected && input.guards.some(guard=>guard.scope==='rooms')) {
      injected++;
      const record=await f.storage.read('rooms',room.view.roomId);
      record.value.snapshot.lastActiveAt++;
      assert.equal(await f.storage.replaceCAS('rooms',room.view.roomId,record.version,record.value),true);
    }
    return verify(input);
  };
  const response=f.request(`/api/rooms/${room.roomCode}/events`);
  const write=response.res.write;
  response.res.write=frame=>{if(frame.startsWith('event: view'))guardsAtView=guards;return write(frame);};
  try {
    const end=Date.now()+1500;
    while(!response.res.frames.some(frame=>frame.startsWith('event: view'))) {
      if(Date.now()>=end)assert.fail('latest SSE view was not delivered after readonly recheck');
      await nextTurn();
    }
    await nextTurn();
    assert.equal(injected,1);assert.equal(guardsAtView,2);
    assert.equal(f.checks.filter(context=>context===eventContext).length,1,'the same event performs its one fresh check');
    assert.equal(response.res.frames.filter(frame=>frame.startsWith('event: view')).length,1);
    assert.equal(response.res.frames.some(frame=>frame.startsWith('event: closed')),false);
    assert.equal(response.res.writableEnded,false);
  } finally {
    response.res.destroyed=true;response.res.emit('close');await response.finished;
  }
});

test('SSE owns a returned subscription even when close races the setup wait result', async t => {
  const f = await fixture(t), room = await f.runtime.rooms.createRoom(f.userKey, '伙伴', randomUUID());
  const subscribe = f.runtime.rooms.subscribe, actuallyClosed = deferred();
  let actualUnsubscribe, unsubscribeCalls = 0, response;
  f.runtime.rooms.subscribe = async (...args) => {
    actualUnsubscribe = await subscribe(...args);
    // The subscription has really been installed. Closing in the continuation
    // between acquisition and the outer wait exposes an ownership handoff gap.
    queueMicrotask(() => queueMicrotask(() => {
      response.res.destroyed = true; response.res.emit('close');
    }));
    return async () => { unsubscribeCalls++; await actualUnsubscribe(); actuallyClosed.resolve(); };
  };
  response = f.request(`/api/rooms/${room.roomCode}/events`);
  try {
    await response.finished; await nextTurn();
    assert.equal(unsubscribeCalls, 1, 'the acquired subscription cannot be lost by a rejected setup waiter');
    await actuallyClosed.promise;
    const presence = await f.storage.read('room-presence', room.view.roomId);
    assert.equal(Object.values(presence.value.connections).flatMap(connections => Object.keys(connections)).length, 0);
    assert.equal(identityCheckContextFor(f.requests[0]), undefined);
  } finally {
    response.res.destroyed = true; response.res.emit('close');
    await actualUnsubscribe?.();
  }
});

async function startedRoom(f, gameType) {
  const room = await f.runtime.rooms.createRoom(f.userKey, '合成成员', randomUUID(), gameType);
  const other = identityKey('urn:game-room:synthetic-private-output', 'fictional-second-member');
  await f.runtime.rooms.joinRoom(room.roomCode, other, '合成伙伴', randomUUID());
  const act = async (user, type, fields = {}) => {
    const view = await f.runtime.rooms.getView(room.roomCode, user);
    return f.runtime.rooms.action(room.roomCode, user, { type, requestId: randomUUID(), expectedRevision: view.revision, ...fields });
  };
  await act(f.userKey, 'ready', { ready: true }); await act(other, 'ready', { ready: true }); await act(f.userKey, 'start');
  return { room, other, act };
}

async function waitForFrame(response, type) {
  const deadline = Date.now() + 1500;
  while (!response.res.frames.some(frame => frame.startsWith(`event: ${type}\n`))) {
    if (response.res.writableEnded || Date.now() >= deadline) assert.fail(`${type} was not delivered: ${response.res.frames.join('')}`);
    await nextTurn();
  }
  await nextTurn();
  return response.res.frames.filter(frame => frame.startsWith(`event: ${type}\n`))
    .map(frame => JSON.parse(frame.split('\ndata: ')[1].split('\n\n')[0]));
}

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  for (const stop of ['cancellation', 'deadline']) {
    test(`${adapter}: a final canvas ${stop} microtask suppresses the acknowledgement without repeating the confirmed mutation`, { timeout: 5000 }, async t => {
      const f = await fixture(t, { sqlite, roomOptions: { serverRandomInt: () => 0 } });
      const { room, act } = await startedRoom(f, 'draw-and-guess');
      const view = await f.runtime.rooms.getView(room.roomCode, f.userKey);
      await act(f.userKey, 'choose', { matchId: view.matchId, turnId: view.game.turnId, candidateId: view.game.candidates[0].id });
      const canvas = await f.runtime.canvases.read(room.roomCode, f.userKey), deviceId = 'final-output-fence';
      const acquire = f.request(`/api/rooms/${room.roomCode}/canvas/acquire`, { deviceId, canvasId: canvas.canvasId, bootId: canvas.bootId });
      await acquire.finished; assert.equal(acquire.res.status, 200);
      const lease = acquire.res.body, append = f.runtime.canvases.append.bind(f.runtime.canvases);
      const assertCurrent = f.sessions.assertCurrent.bind(f.sessions);
      let writes = 0, completedGuards = 0, stopped = false, response;
      f.runtime.canvases.append = (...args) => { writes++; return append(...args); };
      f.sessions.assertCurrent = async (session, options) => {
        await assertCurrent(session, options); completedGuards++;
        queueMicrotask(() => {
          stopped = true;
          if (stop === 'cancellation') response.req.emit('aborted');
          else {
            // Restrict the original trigger after its completed output guard;
            // never construct another deadline or assert transport completion.
            try { options.context.restrict(1); } catch (error) { assert.equal(error.status, 503); }
          }
        });
        if (stop === 'deadline') await new Promise(resolve => setTimeout(resolve, 5));
      };
      f.checks.length = 0;
      response = f.request(`/api/rooms/${room.roomCode}/canvas/append`, { deviceId, canvasId: lease.canvasId, bootId: lease.bootId,
        leaseGeneration: lease.leaseGeneration, clearGeneration: lease.clearGeneration, expectedSequence: lease.sequence,
        requestId: 'confirmed-before-final-cancel', operations: [{ strokeId: 'confirmed-stroke', tool: 'pen', color: '#182a33',
          width: 4, points: [[.1, .2], [.2, .3]] }] });
      await response.finished; await nextTurn();
      assert.equal(stopped, true); assert.equal(completedGuards, 1); assert.equal(response.res.status, 503);
      assert.equal('ack' in response.res.body, false); assert.equal(JSON.stringify(response.res.body).includes('confirmed-stroke'), false);
      assert.equal(writes, 1); assert.equal(f.checks.length, 2); assert.equal(f.checks[0], f.checks[1]);
      const saved = (await f.storage.read(CANVAS_SCOPE, lease.canvasId)).value;
      assert.equal(saved.sequence, 1); assert.equal(Object.keys(saved.requests).length, 1);
      assert.deepEqual(saved.strokes[0].points, [[.1, .2], [.2, .3]]);
      assert.ok(await f.storage.read('sessions', f.id), 'a cancelled response cannot delete the current session');
    });
  }

  for (const stop of ['cancellation', 'deadline']) {
    test(`${adapter}: the final SSE ${stop} microtask cannot release a committed private chat packet`, { timeout: 5000 }, async t => {
      const f = await fixture(t, { sqlite }), room = await f.runtime.rooms.createRoom(f.userKey, '伙伴', randomUUID());
      const secret = '末端失效不能释放的合成聊天正文';
      await f.runtime.chat.send(room.roomCode, f.userKey, { requestId: 'committed-before-final-fence', text: secret });
      const preparePacket = f.runtime.chat.preparePacket.bind(f.runtime.chat), assertCurrent = f.sessions.assertCurrent.bind(f.sessions);
      let armed = false, completedGuards = 0, eventContext, response;
      f.runtime.chat.preparePacket = async (...args) => {
        const packet = await preparePacket(...args);
        if (packet.messages.some(message => message.text === secret)) armed = true;
        return packet;
      };
      f.sessions.assertCurrent = async (session, options) => {
        await assertCurrent(session, options);
        if (!armed) return;
        completedGuards++; eventContext = options.context;
        queueMicrotask(() => {
          if (stop === 'cancellation') { response.res.destroyed = true; response.res.emit('close'); }
          else { try { options.context.restrict(1); } catch (error) { assert.equal(error.status, 503); } }
        });
        if (stop === 'deadline') await new Promise(resolve => setTimeout(resolve, 5));
      };
      response = f.request(`/api/rooms/${room.roomCode}/events`);
      try {
        await response.finished; await nextTurn();
        assert.equal(completedGuards, 1);
        assert.equal(response.res.frames.some(frame => frame.startsWith('event: chat')), false);
        assert.equal(response.res.frames.join('').includes(secret), false);
        if (stop === 'deadline') assert.ok(response.res.frames.some(frame => frame.startsWith('event: closed') && frame.includes('"status":503')));
        assert.equal(f.checks.filter(context => context === eventContext).length, 1);
        const retained = (await f.storage.read('room-chat', room.view.roomId)).value;
        assert.equal(retained.sequence, 1); assert.equal(Object.keys(retained.requests).length, 1);
        assert.equal(retained.messages.length, 1); assert.equal(retained.messages[0].text, secret);
        assert.ok(await f.storage.read('sessions', f.id));
      } finally { response.res.destroyed = true; response.res.emit('close'); await response.finished; }
    });
  }

  test(`${adapter}: shared SSE chat reprepares current retention after one completed room conflict`, { timeout: 5000 }, async t => {
    const f = await fixture(t, { sqlite }), room = await f.runtime.rooms.createRoom(f.userKey, '伙伴', randomUUID());
    const secret = '只允许仍保留的合成聊天正文';
    const message = await f.runtime.chat.send(room.roomCode, f.userKey, { requestId: 'retention-output-fence', text: secret });
    const preparePacket = f.runtime.chat.preparePacket.bind(f.runtime.chat), verify = f.storage.verifyGuards.bind(f.storage);
    const assertCurrent = f.sessions.assertCurrent.bind(f.sessions);
    let armed = false, preparations = 0, injected = 0, outputGuards = 0, eventContext;
    f.runtime.chat.preparePacket = async (...args) => {
      const value = await preparePacket(...args);
      if (args[2].messages.some(item => item.messageId === message.message.messageId)) { preparations++; armed = true; }
      return value;
    };
    f.sessions.assertCurrent = (session, options) => { if (armed) eventContext ??= options.context; return assertCurrent(session, options); };
    f.storage.verifyGuards = async input => {
      if (armed) {
        outputGuards++;
        if (!injected++) {
          const previous = await f.storage.read('rooms', room.view.roomId); previous.value.snapshot.lastActiveAt++;
          assert.equal(await f.storage.replaceCAS('rooms', room.view.roomId, previous.version, previous.value), true);
          // Model a real retention sweep between the first prepared packet and
          // its gate. The original committed chat receipt remains available.
          const chat = await f.storage.read('room-chat', room.view.roomId);
          chat.value.messages = []; chat.value.discardedThrough = chat.value.sequence;
          assert.equal(await f.storage.replaceCAS('room-chat', room.view.roomId, chat.version, chat.value), true);
        }
      }
      return verify(input);
    };
    const response = f.request(`/api/rooms/${room.roomCode}/events`);
    try {
      const packets = await waitForFrame(response, 'chat');
      assert.equal(preparations, 3, 'prefilter and both output attempts each recheck original retention'); assert.equal(outputGuards, 2);
      assert.equal(packets.length, 1); assert.deepEqual(packets[0].messages, []); assert.equal(packets[0].historyTruncated, true);
      assert.equal(response.res.frames.join('').includes(secret), false);
      assert.equal(f.checks.filter(context => context === eventContext).length, 1);
      assert.equal(response.res.frames.some(frame => frame.startsWith('event: closed')), false);
      assert.equal(Object.keys((await f.storage.read('room-chat', room.view.roomId)).value.requests).length, 1);
    } finally { response.res.destroyed = true; response.res.emit('close'); await response.finished; }
  });

  test(`${adapter}: shared SSE preview marks its signature only after current delivery`, { timeout: 5000 }, async t => {
    const f = await fixture(t, { sqlite, roomOptions: { gameOptions: { firstTurnIndex: 1, randomInt: max => max - 1 } } });
    const { room, other } = await startedRoom(f, 'rummikub'), owner = await f.runtime.rooms.getView(room.roomCode, other);
    assert.equal(owner.selfId, owner.game.turnPlayerId, 'the stream member is the actual non-turn observer');
    const body = { previewId: 'confirmed-preview-source', sequence: 1, matchId: owner.matchId, gameRevision: owner.game.revision,
      boardIds: [...owner.game.board.map(group => group.map(tile => tile.id)), [owner.game.rack[0].id]] };
    const permit = f.runtime.preview.reserve(room.roomCode), prepared = f.runtime.preview.prepare(owner, body, 'synthetic-owner-session');
    assert.equal(f.runtime.preview.commit(prepared, owner, permit).accepted, true);
    const packet = f.runtime.preview.packet.bind(f.runtime.preview), subscribe = f.runtime.preview.subscribe.bind(f.runtime.preview);
    const verify = f.storage.verifyGuards.bind(f.storage), assertCurrent = f.sessions.assertCurrent.bind(f.sessions);
    let armed = false, preparations = 0, outputGuards = 0, injected = false, notify, eventContext;
    f.runtime.preview.subscribe = (view, session, send) => { notify = send; return subscribe(view, session, send); };
    f.runtime.preview.packet = (view, options) => {
      const value = packet(view, options);
      if (options?.forStream) { preparations++; armed = true; }
      return value;
    };
    f.sessions.assertCurrent = (session, options) => { if (armed) eventContext ??= options.context; return assertCurrent(session, options); };
    f.storage.verifyGuards = async input => {
      if (armed) {
        outputGuards++;
        if (!injected) {
          injected = true;
          const previous = await f.storage.read('rooms', room.view.roomId); previous.value.snapshot.lastActiveAt++;
          assert.equal(await f.storage.replaceCAS('rooms', room.view.roomId, previous.version, previous.value), true);
        }
      }
      return verify(input);
    };
    const response = f.request(`/api/rooms/${room.roomCode}/events?preview=1`);
    try {
      const packets = await waitForFrame(response, 'preview');
      assert.equal(injected, true); assert.equal(preparations, 2); assert.equal(outputGuards, 2);
      assert.equal(packets.length, 1); assert.equal(packets[0].previewId, body.previewId);
      assert.deepEqual(packets[0].preview.board.flat().map(tile => tile.id), [owner.game.rack[0].id]);
      assert.equal(f.checks.filter(context => context === eventContext).length, 1);
      // Repeated source notifications remain real per-event identity checks,
      // but a packet already delivered may then be suppressed by its signature.
      notify(); await nextTurn(); await nextTurn();
      assert.equal(response.res.frames.filter(frame => frame.startsWith('event: preview')).length, 1);
      assert.equal(response.res.frames.some(frame => frame.startsWith('event: closed')), false);
    } finally { response.res.destroyed = true; response.res.emit('close'); await response.finished; }
  });
}
