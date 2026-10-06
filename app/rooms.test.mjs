import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRoomStore, RoomError, ROOM_CAPACITY } from './rooms.mjs';
import { createServer } from './server.mjs';
import { createDeck } from './rules.mjs';

const gameOptions = { firstTurnIndex: 0, randomInt: (max) => max - 1 };
let requestSequence = 0;
function perform(store, seat, type, extra = {}) {
  return store.action(seat.roomCode, seat.token, {
    type, requestId: `request-${++requestSequence}`,
    expectedRevision: store.getView(seat.roomCode, seat.token).revision, ...extra,
  });
}
function runningRoom(options = {}, count = 2) {
  const store = createRoomStore({ gameOptions, ...options });
  const seats = [store.createRoom('甲')];
  for (let i = 1; i < count; i += 1) seats.push(store.joinRoom(seats[0].roomCode, `朋友${i}`));
  for (const seat of seats) perform(store, seat, 'ready', { ready: true });
  perform(store, seats[0], 'start');
  return { store, seats };
}
function expectCode(code) { return (error) => error instanceof RoomError && error.code === code; }

function jokerSnapshot(store, code, ruleVersion) {
  const snapshot = store.exportSnapshot(code);
  const deck = createDeck();
  const known = new Map(deck.map(tile => [tile.id, tile]));
  const board = [['red-6-a', 'joker-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a']];
  const racks = [['red-7-a', 'black-2-a'], ['blue-1-a']];
  const used = new Set([...board.flat(), ...racks.flat()]);
  const game = snapshot.game;
  game.ruleVersion = ruleVersion;
  game.board = board.map(meld => meld.map(id => structuredClone(known.get(id))));
  game.players.forEach((player, index) => {
    player.rack = racks[index].map(id => structuredClone(known.get(id)));
    player.opened = true;
  });
  game.pool = deck.filter(tile => !used.has(tile.id));
  return JSON.parse(JSON.stringify(snapshot));
}

test('room snapshots restore each rule version unchanged and refuse client version overrides', () => {
  for (const ruleVersion of ['friends-v1', 'friends-v2']) {
    const { store, seats: [a] } = runningRoom();
    const snapshot = jokerSnapshot(store, a.roomCode, ruleVersion);
    const restored = createRoomStore({ gameOptions });
    restored.importSnapshot(snapshot);
    assert.equal(restored.getView(a.roomCode, a.token).game.ruleVersion, ruleVersion);
    assert.equal(restored.exportSnapshot(a.roomCode).schemaVersion, 2);
    assert.throws(() => perform(restored, a, 'submit', {
      ruleVersion: 'friends-v2', boardIds: [], rackIds: [],
    }), expectCode('INVALID_ACTION'));
    const rearranged = { boardIds: [['red-6-a', 'red-7-a', 'red-8-a'],
      ['blue-10-a', 'blue-11-a', 'blue-12-a', 'joker-a']], rackIds: ['black-2-a'] };
    if (ruleVersion === 'friends-v1') {
      assert.throws(() => perform(restored, a, 'submit', rearranged), expectCode('INVALID_GAME_ACTION'));
      assert.deepEqual(restored.exportSnapshot(a.roomCode).game, snapshot.game);
      assert.equal(perform(restored, a, 'draw').view.game.ruleVersion, ruleVersion);
    } else {
      const result = perform(restored, a, 'submit', rearranged).view;
      assert.equal(result.game.ruleVersion, ruleVersion);
      assert.equal(result.game.board[1].at(-1).id, 'joker-a');
      assert.notEqual(result.game.turnPlayerId, a.playerId);
    }
    const nextSnapshot = JSON.parse(JSON.stringify(restored.exportSnapshot(a.roomCode)));
    const recoveredAgain = createRoomStore({ gameOptions });
    recoveredAgain.importSnapshot(nextSnapshot);
    assert.equal(recoveredAgain.getView(a.roomCode, a.token).game.ruleVersion, ruleVersion);
    assert.deepEqual(recoveredAgain.exportSnapshot(a.roomCode).game, nextSnapshot.game);
    recoveredAgain.close(); restored.close(); store.close();
  }
});

test('room snapshot import rejects unknown game rules before replacing a valid room', () => {
  const { store, seats: [a] } = runningRoom();
  const original = store.exportSnapshot(a.roomCode);
  const bad = structuredClone(original);
  bad.game.ruleVersion = 'friends-v99';
  assert.throws(() => store.importSnapshot(bad), expectCode('INVALID_SNAPSHOT'));
  assert.deepEqual(store.exportSnapshot(a.roomCode), original);
  store.close();
});

test('rooms issue independent strong seat credentials; names are bounded text', () => {
  const store = createRoomStore();
  const a = store.createRoom('  小甲  ');
  const b = store.joinRoom(a.roomCode, '<朋友>');
  assert.match(a.roomCode, /^\d{6}$/);
  assert.equal(Buffer.from(a.token, 'base64url').length, 32);
  assert.notEqual(a.playerId, b.playerId);
  assert.notEqual(a.token, b.token);
  assert.equal(a.view.players[0].name, '小甲');
  assert.equal(b.view.players[1].name, '<朋友>');
  assert.throws(() => store.createRoom(''), expectCode('INVALID_NAME'));
  assert.throws(() => store.createRoom('甲'.repeat(17)), expectCode('INVALID_NAME'));
  assert.throws(() => store.createRoom('甲\n乙'), expectCode('INVALID_NAME'));
  assert.throws(() => store.getView(a.roomCode, undefined), expectCode('INVALID_TOKEN'));
  assert.throws(() => store.getView(a.roomCode, 'x'.repeat(43)), expectCode('INVALID_TOKEN'));
});

test('seven seats maximum; eighth rejected; five-player game automatically has 159 tiles', () => {
  assert.equal(ROOM_CAPACITY, 7);
  const store = createRoomStore({ gameOptions });
  const host = store.createRoom('房主');
  const seats = [host];
  for (let i = 1; i < 7; i += 1) seats.push(store.joinRoom(host.roomCode, `玩家${i}`));
  assert.equal(store.getView(host.roomCode, host.token).players.length, 7);
  assert.throws(() => store.joinRoom(host.roomCode, '第八人'), expectCode('ROOM_FULL'));
  for (const seat of seats) perform(store, seat, 'ready', { ready: true });
  assert.throws(() => perform(store, seats[1], 'start'), expectCode('HOST_REQUIRED'));
  assert.throws(() => perform(store, host, 'start', { deckCopies: 2 }), expectCode('INVALID_ACTION'));
  const seven = perform(store, host, 'start').view.game;
  assert.equal(seven.poolCount + seven.players.reduce((sum, player) => sum + player.rackCount, 0), 159);
  const { store: fiveStore, seats: fiveSeats } = runningRoom({}, 5);
  const five = fiveStore.getView(fiveSeats[0].roomCode, fiveSeats[0].token).game;
  assert.equal(five.poolCount, 89);
});

test('only host starts, with all players ready and at least two seats', () => {
  const store = createRoomStore({ gameOptions });
  const a = store.createRoom('甲');
  perform(store, a, 'ready', { ready: true });
  assert.throws(() => perform(store, a, 'start'), expectCode('NOT_READY'));
  const b = store.joinRoom(a.roomCode, '乙');
  assert.throws(() => perform(store, b, 'start'), expectCode('HOST_REQUIRED'));
  assert.throws(() => perform(store, a, 'start'), expectCode('NOT_READY'));
  perform(store, b, 'ready', { ready: true });
  assert.equal(perform(store, a, 'start').view.phase, 'playing');
  const spectator=store.joinRoom(a.roomCode,'迟到');assert.equal(spectator.view.selfRole,'spectator');assert.equal(spectator.view.players.length,2);
  assert.ok(!('rack' in spectator.view.game));
  assert.deepEqual(perform(store, b, 'leave'), { view: null, left: true });
  assert.equal(store.getView(a.roomCode, a.token).phase, 'aborted');
});

test('private room projections never include tokens, pool or another rack; refresh keeps seat', () => {
  const { store, seats: [a, b] } = runningRoom();
  const av = store.getView(a.roomCode, a.token);
  const bv = store.getView(b.roomCode, b.token);
  assert.equal(av.selfId, a.playerId);
  assert.equal(bv.selfId, b.playerId);
  assert.equal(av.game.rack.length, 14);
  assert.equal(bv.game.rack.length, 14);
  assert.equal(av.game.poolCount, 78);
  assert.equal(av.game.turnPlayerId, a.playerId);
  assert.ok(av.game.players.every((player) => !('rack' in player)));
  assert.ok(!('pool' in av.game));
  const serialized = JSON.stringify(av);
  assert.ok(!serialized.includes(a.token) && !serialized.includes(b.token));
  assert.ok(bv.game.rack.every((tile) => !serialized.includes(`\"${tile.id}\"`)));
  av.game.rack.length = 0;
  av.players[0].name = 'mutated';
  assert.equal(store.getView(a.roomCode, a.token).game.rack.length, 14);
  assert.equal(store.getView(a.roomCode, a.token).players[0].name, '甲');
});

test('wrong turn and stale revision cannot mutate; request replay is bound to player and payload', () => {
  const { store, seats: [a, b] } = runningRoom();
  const revision = store.getView(a.roomCode, a.token).revision;
  const input = { type: 'draw', requestId: 'same-request', expectedRevision: revision };
  assert.throws(() => store.action(b.roomCode, b.token, input), expectCode('INVALID_GAME_ACTION'));
  const first = store.action(a.roomCode, a.token, input).view;
  assert.equal(first.revision, revision + 1);
  assert.equal(first.game.rack.length, 15);
  const replay = store.action(a.roomCode, a.token, { ...input }).view;
  assert.equal(replay.revision, first.revision);
  assert.equal(replay.game.poolCount, first.game.poolCount);
  assert.throws(() => store.action(a.roomCode, a.token, { ...input, type: 'pass' }), expectCode('REQUEST_ID_REUSED'));
  assert.throws(() => store.action(b.roomCode, b.token, { ...input, requestId: 'stale' }), expectCode('REVISION_CONFLICT'));
  const second = perform(store, b, 'draw').view;
  assert.equal(second.game.rack.length, 15);
  assert.equal(second.revision, revision + 2);
  // Replay returns a fresh private view, without executing the old draw again.
  assert.equal(store.action(a.roomCode, a.token, input).view.revision, second.revision);
});

test('SSE subscribers get their own rack; disconnection preserves seat and turn without changing revision', () => {
  const { store, seats: [a, b] } = runningRoom();
  const aEvents = [], bEvents = [];
  const unsubscribeA = store.subscribe(a.roomCode, a.token, (view) => aEvents.push(view));
  const unsubscribeB = store.subscribe(b.roomCode, b.token, (view) => bEvents.push(view));
  const revision = aEvents.at(-1).revision;
  assert.equal(aEvents.at(-1).game.playerId, a.playerId);
  assert.equal(bEvents.at(-1).game.playerId, b.playerId);
  assert.ok(aEvents.at(-1).players.every((player) => player.connected));
  unsubscribeA();
  const after = bEvents.at(-1);
  assert.equal(after.players.find((player) => player.id === a.playerId).connected, false);
  assert.equal(after.revision, revision);
  assert.equal(after.game.turnPlayerId, a.playerId);
  assert.equal(after.players.length, 2);
  const refreshed = store.getView(a.roomCode, a.token);
  assert.equal(refreshed.game.rack.length, 14);
  unsubscribeB();
});

test('leaving waiting room transfers host, revokes seat and removes an empty room', () => {
  const store = createRoomStore();
  const a = store.createRoom('甲');
  const b = store.joinRoom(a.roomCode, '乙');
  assert.deepEqual(perform(store, a, 'leave'), { view: null, left: true });
  assert.throws(() => store.getView(a.roomCode, a.token), expectCode('INVALID_TOKEN'));
  assert.equal(store.getView(b.roomCode, b.token).hostId, b.playerId);
  perform(store, b, 'leave');
  assert.throws(() => store.getView(b.roomCode, b.token), expectCode('ROOM_NOT_FOUND'));
});

test('host rematch returns finished game to waiting and clears all ready flags', () => {
  const { store, seats: [a, b] } = runningRoom();
  const seats = [a, b];
  assert.throws(() => perform(store, a, 'rematch'), expectCode('GAME_NOT_FINISHED'));
  let current = store.getView(a.roomCode, a.token);
  while (current.game.poolCount > 0) {
    const seat = seats.find((entry) => entry.playerId === current.game.turnPlayerId);
    current = perform(store, seat, 'draw').view;
  }
  for (let i = 0; i < seats.length; i += 1) {
    const seat = seats.find((entry) => entry.playerId === current.game.turnPlayerId);
    current = perform(store, seat, 'pass').view;
  }
  assert.equal(current.phase, 'finished');
  assert.throws(() => perform(store, b, 'rematch'), expectCode('HOST_REQUIRED'));
  const view = perform(store, a, 'rematch').view;
  assert.equal(view.phase, 'waiting');
  assert.equal(view.game, null);
  assert.ok(view.players.every((player) => !player.ready));
  assert.throws(() => perform(store, a, 'start'), expectCode('NOT_READY'));
});

test('inactive TTL closes subscribers and reclaims room capacity', () => {
  let time = 0;
  const store = createRoomStore({ now: () => time, ttlMs: 100, maxRooms: 1 });
  const a = store.createRoom('甲');
  const ended = [];
  store.subscribe(a.roomCode, a.token, () => {}, (message) => ended.push(message));
  assert.throws(() => store.createRoom('乙'), expectCode('ROOM_LIMIT'));
  time = 101;
  store.sweep();
  assert.equal(ended.length, 1);
  assert.throws(() => store.getView(a.roomCode, a.token), expectCode('ROOM_NOT_FOUND'));
  assert.ok(store.createRoom('新房').roomCode);
});

async function serverFixture(t) {
  const server = createServer({ store: createRoomStore({ gameOptions }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  async function request(url, { method = 'GET', token, body, headers: extra = {} } = {}) {
    const response = await fetch(base + url, { method, headers: {
      ...(method === 'POST' ? { Origin: base, 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra,
    }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { response, body: await response.json() };
  }
  return { server, base, request };
}

test('HTTP confirms exact leave retries after the last seat has closed its room', async (t) => {
  const { request } = await serverFixture(t);
  const { body: seat } = await request('/api/rooms', { method: 'POST', body: { name: '验收' } });
  const path = `/api/rooms/${seat.roomCode}/actions`;
  const body = { type: 'leave', requestId: 'last-seat-exit', expectedRevision: seat.view.revision };
  for (let retry = 0; retry < 2; retry++) {
    const response = await request(path, { method: 'POST', token: seat.token, body });
    assert.equal(response.response.status, 200);
    assert.deepEqual(response.body, { view: null, left: true });
  }
  assert.equal((await request(path, { method: 'POST', token: seat.token, body: { ...body, expectedRevision: 123 } })).response.status, 409);
  assert.equal((await request(path, { method: 'POST', token: 'x'.repeat(43), body })).response.status, 404);
  assert.equal((await request(`/api/rooms/${seat.roomCode}`, { token: seat.token })).response.status, 404);
});

test('HTTP loopback integration: token headers, CAS and static model denial', async (t) => {
  const { request } = await serverFixture(t);
  const { response, body: a } = await request('/api/rooms', { method: 'POST', body: { name: '甲' } });
  assert.equal(response.status, 201);
  const { body: b } = await request(`/api/rooms/${a.roomCode}/join`, { method: 'POST', body: { name: '乙' } });
  assert.equal((await request(`/api/rooms/${a.roomCode}`)).response.status, 401);
  assert.equal((await request(`/api/rooms/${a.roomCode}?token=${a.token}`)).response.status, 400);
  assert.equal((await request(`/api/rooms/${a.roomCode}`, { token: b.token })).body.view.selfId, b.playerId);
  for (const file of ['rooms.mjs', 'multiplayer-rules.mjs', 'rooms.test.mjs', 'server.mjs', '../project.md']) {
    assert.equal((await request(`/${file}`)).response.status, 404);
  }
  const ready = { type: 'ready', ready: true, requestId: 'http-ready', expectedRevision: b.view.revision };
  const result = await request(`/api/rooms/${a.roomCode}/actions`, { method: 'POST', token: a.token, body: ready });
  assert.equal(result.response.status, 200);
  const conflict = await request(`/api/rooms/${a.roomCode}/actions`, { method: 'POST', token: b.token,
    body: { ...ready, requestId: 'http-stale' } });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, 'REVISION_CONFLICT');
});

test('HTTP rejects foreign origin, DNS-rebinding host, malformed JSON and oversize body', async (t) => {
  const { request, base } = await serverFixture(t);
  const invalidOrigin = await request('/api/rooms', { method: 'POST', body: { name: '甲' },
    headers: { Origin: 'https://evil.example' } });
  assert.equal(invalidOrigin.response.status, 403);
  // Node fetch supplies its own Host; a raw request verifies the actual wire header.
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/rooms', { method: 'POST', headers: {
      Host: 'evil.example:4177', Origin: base, 'Content-Type': 'application/json',
    } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify({ name: '甲' }));
  });
  assert.equal(badHost, 403);
  assert.equal((await request('/api/rooms', { method: 'POST', body: '{invalid' })).response.status, 400);
  assert.equal((await request('/api/rooms', { method: 'POST', body: 'x'.repeat(32769) })).response.status, 413);
});

test('HTTP also bounds streamed bodies and sends a meaningful 413', async (t) => {
  const { base } = await serverFixture(t);
  const result = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/rooms', { method: 'POST', headers: { Origin: base,
      'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write('x'.repeat(20000));
    req.end('x'.repeat(20000));
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.code, 'BODY_TOO_LARGE');
});

test('HTTP SSE stream authenticates privately and disconnect clears presence', async (t) => {
  const { request, base } = await serverFixture(t);
  const { body: a } = await request('/api/rooms', { method: 'POST', body: { name: '甲' } });
  assert.equal((await request(`/api/rooms/${a.roomCode}/events`)).response.status, 401);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/rooms/${a.roomCode}/events`, {
    headers: { Authorization: `Bearer ${a.token}` }, signal: controller.signal,
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body.getReader();
  const { value } = await reader.read();
  const event = new TextDecoder().decode(value);
  assert.ok(event.startsWith('event: view\n'));
  const view = JSON.parse(event.split('\ndata: ')[1].split('\n\n')[0]);
  assert.equal(view.selfId, a.playerId);
  assert.equal(view.players[0].connected, true);
  assert.ok(!event.includes(a.token));
  controller.abort();
  await reader.cancel().catch(() => {});
  // Close processing is asynchronous; the seat itself remains immediately available.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const latest = (await request(`/api/rooms/${a.roomCode}`, { token: a.token })).body.view;
    if (!latest.players[0].connected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('SSE presence did not clear after disconnect');
});
