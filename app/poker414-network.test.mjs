import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings } from '../server/config.mjs';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { MockProvider } from '../server/auth.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { createPoker414Adapter } from '../server/games/poker414-2/adapter.mjs';
import { SCORE_SCOPES } from '../server/game-scores.mjs';
import { createGameRegistry } from './game-registry.mjs';
import { getCard } from './games/poker414-2/cards.mjs';

// Actual loopback HTTP/SSE, SessionService, production room adapter and encrypted
// SQLite. Only the upstream identity and game clock/random source are synthetic.
// This checks correctness, not real-device transport or central SSO capacity.
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), '414-network-'));
  let time = Date.now(); const now = () => time;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const storage = new EncryptedStore(new SQLiteAdapter(join(folder, 'game.sqlite'), { now }), randomBytes(32), now);
  const provider = new MockProvider(settings, { now });
  provider.complete = async () => ({ issuer: 'urn:414-network', sub: provider.member,
    accessToken: 'synthetic-network-private-token', expiresAt: now() + 3600000 });
  provider.check = async identity => ({ sub: identity.sub });
  const runtime = createRuntime(settings, { storage, provider, now,
    roomOptions: { gameRegistry: createGameRegistry([createPoker414Adapter()]), pollIntervalMs: 0, serverRandomInt: () => 0 },
    chatOptions: { pollIntervalMs: 0 } });
  const server = createUnifiedServer(runtime), streams = [];
  t.after(async () => {
    for (const stream of streams) await stream.close();
    server.closeAllConnections(); await server.shutdown();
    await rm(folder, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  settings.origin = base; settings.callback = base + '/auth/callback'; settings.postLogout = base + '/';
  async function request(path, member = {}, body) {
    const response = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(8000),
      method: body === undefined ? 'GET' : 'POST', headers: {
        ...(member.cookie ? { cookie: member.cookie } : {}),
        ...(body === undefined ? {} : { origin: base, 'x-csrf-token': member.csrf, 'content-type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  }
  async function login(sub) {
    provider.member = sub;
    const start = await request('/auth/login'), redirect = new URL(start.headers.get('location'));
    const completed = await request(redirect.pathname + redirect.search, { cookie: start.headers.getSetCookie()[0].split(';')[0] });
    assert.equal(completed.status, 303, completed.text);
    const cookie = completed.headers.getSetCookie().find(value => value.startsWith(settings.cookieName + '=')).split(';')[0];
    const state = await request('/api/state', { cookie }); assert.equal(state.status, 200, state.text);
    return { sub, cookie, csrf: state.body.csrf, userKey: state.body.userKey };
  }
  async function view(code, member) {
    const response = await request(`/api/rooms/${code}`, member); assert.equal(response.status, 200, response.text); return response.body.view;
  }
  function input(view, type, extra = {}) {
    return { type, expectedRevision: view.revision, requestId: randomUUID(),
      ...(['play', 'pass', 'hook', 'fork'].includes(type) ? { matchId: view.matchId, roundId: view.game.roundId,
        targetId: view.game.target?.id ?? null,
        ...(['hook', 'fork'].includes(type) ? { windowId: view.game.responseWindow?.id } : {}) } : {}), ...extra };
  }
  async function action(code, member, current, type, extra = {}) {
    const body = input(current, type, extra), response = await request(`/api/rooms/${code}/actions`, member, body);
    assert.equal(response.status, 200, response.text); return { ...response.body, input: body };
  }
  async function listen(code, member) {
    const cancellation = new AbortController();
    const response = await fetch(`${base}/api/rooms/${code}/events`, { headers: { cookie: member.cookie }, signal: cancellation.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder(), packets = [], waiters = new Set();
    let buffer = '', readError = null;
    const reading = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
            if (!event || !data) continue;
            const packet = { event, data: JSON.parse(data) }; packets.push(packet);
            for (const wake of [...waiters]) wake(packet);
          }
        }
      } catch (error) { if (!cancellation.signal.aborted) throw error; }
    })();
    reading.catch(error => { readError = error; });
    const stream = { packets,
      wait(predicate) {
        const existing = packets.find(predicate); if (existing) return Promise.resolve(existing);
        if (readError) return Promise.reject(readError);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waiters.delete(wake); reject(readError ?? new Error('Expected SSE state did not arrive')); }, 5000);
          const wake = packet => { if (predicate(packet)) { clearTimeout(timer); waiters.delete(wake); resolve(packet); } };
          waiters.add(wake);
        });
      },
      async close() { cancellation.abort(); await reader.cancel().catch(() => {}); await reading.catch(() => {}); },
    };
    streams.push(stream); return stream;
  }
  async function room(playerCount, spectatorCount) {
    const members = [];
    for (let index = 0; index < playerCount + spectatorCount; index++) members.push(await login(`member-${index}`));
    const created = await request('/api/rooms', members[0], { name: '同名伙伴', gameType: 'poker414-2', requestId: randomUUID() });
    assert.equal(created.status, 201, created.text); const code = created.body.roomCode;
    members[0].seat = created.body.view.selfId;
    for (let index = 1; index < members.length; index++) {
      const joined = await request(`/api/rooms/${code}/join`, members[index], { name: '同名伙伴', requestId: randomUUID(),
        ...(index >= playerCount ? { role: 'spectator' } : {}) });
      assert.equal(joined.status, 201, joined.text); members[index].seat = joined.body.view.selfId;
    }
    const players = members.slice(0, playerCount), spectators = members.slice(playerCount);
    const connected = [];
    // Sequential handshakes keep the room's unchanged bounded CAS policy; this
    // suite races game actions deliberately, not 16 synthetic account startups.
    for (const member of members) connected.push(await listen(code, member));
    return { code, roomId: created.body.view.roomId, members, players, spectators, streams: connected };
  }
  async function start(room) {
    let current = await view(room.code, room.players[0]);
    for (const member of room.players) current = (await action(room.code, member, current, 'ready', { ready: true })).view;
    current = (await action(room.code, room.players[0], current, 'start')).view;
    return current;
  }
  return { runtime, storage, request, login, view, input, action, listen, room, start, advance: ms => { time += ms; } };
}

function assertProjection(view, members, spectator) {
  const serialized = JSON.stringify(view);
  for (const secret of ['userKey', 'issuer', 'csrf', 'synthetic-network-private-token', '"deck"', ...members.map(member => member.userKey)]) {
    assert.equal(serialized.includes(secret), false, `private field ${secret} must not be exposed`);
  }
  const hands = view.game.players.filter(player => Object.hasOwn(player, 'hand'));
  assert.equal(hands.length, spectator ? view.game.players.length : 1);
  if (!spectator) assert.equal(hands[0].id, view.selfId);
}

test('414 real SQLite HTTP/SSE completes a three-player match and archives one zero-sum settlement', async t => {
  const f = await fixture(t), room = await f.room(3, 1);
  await f.start(room); f.advance(3000); await f.runtime.rooms.sweep();
  let current = await f.view(room.code, room.spectators[0]);
  const hands = new Map(current.game.players.map(player => [player.id, [...player.hand]]));
  const winner = current.game.turnPlayerId, matchId = current.matchId;
  assert.notDeepEqual(current.game.seatOrder, room.players.map(member => member.seat));
  let count = 0;
  while (current.phase === 'playing' && count++ < 108) {
    const actor = room.players.find(member => member.seat === current.game.turnPlayerId);
    const type = current.game.target ? 'pass' : 'play';
    const extra = type === 'play' ? { cardIds: [hands.get(actor.seat).shift()] } : {};
    current = (await f.action(room.code, actor, current, type, extra)).view;
  }
  assert.equal(current.phase, 'finished'); assert.equal(current.game.result.winnerId, winner);
  assert.equal(current.game.result.reason, 'emptied-hand');
  assert.equal(current.game.players.find(player => player.id === winner).handCount, 0);
  const terminal = await Promise.all(room.streams.map(stream => stream.wait(packet => packet.event === 'view' && packet.data.phase === 'finished')));
  for (let index = 0; index < terminal.length; index++) assertProjection(terminal[index].data, room.members, index === 3);
  const result = current.game.result.deltas, sum = result.reduce((total, entry) => total + entry.points, 0);
  assert.equal(sum, 0); assert.ok(result.find(entry => entry.playerId === winner).points > 0);
  for (const member of room.players) {
    const history = await f.request('/api/history', member); assert.equal(history.status, 200, history.text);
    assert.equal(history.body.items.length, 1); assert.equal(history.body.items[0].matchId, matchId);
    const points = result.find(entry => entry.playerId === member.seat).points;
    assert.equal(history.body.items[0].self.score, points); assert.equal(history.body.items[0].self.balanceAfter, points);
  }
  const scores = await f.request(`/api/rooms/${room.code}/scores`, room.spectators[0]); assert.equal(scores.status, 200, scores.text);
  assert.equal(scores.body.settlement.matchId, matchId);
  assert.deepEqual(scores.body.settlement.deltas, scores.body.settlement.balancesAfter.map(entry => ({ playerId: entry.playerId, delta: entry.total })));
  assert.equal((await f.storage.scan(SCORE_SCOPES.ledger)).length, 1);
  assert.equal((await f.request('/api/history', room.spectators[0])).body.items.length, 0);
});

test('414 eight players and eight spectators receive role-correct partial/full deals within unchanged room limits', async t => {
  const f = await fixture(t), room = await f.room(8, 8), outsider = await f.login('extra-member');
  const extraPlayer = await f.request(`/api/rooms/${room.code}/join`, outsider, { name: '同名伙伴', requestId: randomUUID() });
  assert.equal(extraPlayer.status, 409); assert.equal(extraPlayer.body.code, 'ROOM_FULL');
  const extraWatcher = await f.request(`/api/rooms/${room.code}/join`, outsider, { name: '同名伙伴', role: 'spectator', requestId: randomUUID() });
  assert.equal(extraWatcher.status, 409); assert.equal(extraWatcher.body.code, 'SPECTATOR_FULL');
  // SSE headers precede the subscription limit: refusal is a terminal event,
  // not an HTTP status change after headers have already been sent.
  const overflow = await f.listen(room.code, room.players[0]);
  const refused = await overflow.wait(packet => packet.event === 'closed');
  assert.equal(refused.data.status, 429); assert.match(refused.data.error, /房间连接已满/);
  assert.equal(overflow.packets.some(packet => packet.event === 'view'), false);
  const denied = await f.request(`/api/rooms/${room.code}`, outsider); assert.equal(denied.status, 403);
  await f.start(room); f.advance(500); await f.runtime.rooms.sweep();
  const partial = await f.view(room.code, room.spectators[0]);
  assert.equal(partial.game.deckCount, 90); assert.equal(partial.game.players.flatMap(player => player.hand).length, 18);
  assertProjection(partial, room.members, true);
  f.advance(2500); await f.runtime.rooms.sweep();
  const packets = await Promise.all(room.streams.map(stream => stream.wait(packet => packet.event === 'view' && packet.data.game?.stage === 'playing')));
  const publicHands = packets[8].data.game.players.flatMap(player => player.hand);
  assert.equal(new Set(publicHands).size, 108); assert.equal(publicHands.length, 108);
  for (let index = 0; index < packets.length; index++) {
    const view = packets[index].data; assertProjection(view, room.members, index >= 8);
    assert.equal(view.players.length, 8); assert.equal(view.spectators.length, 8);
    assert.equal(view.game.players.reduce((total, player) => total + player.handCount, 0), 108);
    if (index < 8) {
      const own = view.game.players.find(player => player.id === room.players[index].seat).hand;
      for (const foreign of publicHands.filter(id => !own.includes(id))) assert.equal(JSON.stringify(view).includes(`"${foreign}"`), false);
    }
  }
  const watch = packets[8].data, forged = await f.request(`/api/rooms/${room.code}/actions`, room.spectators[0], f.input(watch, 'pass'));
  assert.equal(forged.status, 403); assert.equal(forged.body.code, 'SPECTATOR_READ_ONLY');
  assert.equal((await f.storage.scan(SCORE_SCOPES.ledger)).length, 0);
});

test('414 a fresh device session reclaims its stable seat and hand; a same-name different identity cannot', async t => {
  const f = await fixture(t), room = await f.room(3, 1);
  await f.start(room); f.advance(3000); await f.runtime.rooms.sweep();
  const before = await f.view(room.code, room.players[0]), hand = before.game.players.find(player => player.id === before.selfId).hand;
  await room.streams[0].close();
  const replacement = await f.login(room.players[0].sub);
  assert.notEqual(replacement.cookie, room.players[0].cookie); assert.equal(replacement.userKey, room.players[0].userKey);
  const joined = await f.request(`/api/rooms/${room.code}/join`, replacement, { name: '新设备上的昵称', requestId: randomUUID() });
  assert.equal(joined.status, 201, joined.text);
  assert.equal(joined.body.view.selfId, before.selfId); assert.equal(joined.body.view.selfRole, 'player');
  assert.equal(joined.body.view.matchId, before.matchId);
  assert.deepEqual(joined.body.view.game.players.find(player => player.id === before.selfId).hand, hand);
  const stream = await f.listen(room.code, replacement), packet = await stream.wait(event => event.event === 'view' && event.data.game?.stage === 'playing');
  assertProjection(packet.data, room.members, false); assert.equal(packet.data.selfId, before.selfId);
  const outsider = await f.login('same-name-new-identity');
  assert.equal((await f.request(`/api/rooms/${room.code}`, outsider)).status, 403);
  const observer = await f.request(`/api/rooms/${room.code}/join`, outsider, { name: '同名伙伴', role: 'player', requestId: randomUUID() });
  assert.equal(observer.status, 201); assert.equal(observer.body.view.selfRole, 'spectator');
  assert.notEqual(observer.body.view.selfId, before.selfId);
  assert.deepEqual(observer.body.view.game.players.map(player => player.id).sort(), room.players.map(member => member.seat).sort());
  assert.equal((await f.storage.scan(SCORE_SCOPES.ledger)).length, 0);
});

test('414 simultaneous HTTP fork requests commit one target, preserve loser cards and replay the winner once', async t => {
  const f = await fixture(t), room = await f.room(3, 1);
  await f.start(room); f.advance(3000); await f.runtime.rooms.sweep();
  const before = await f.view(room.code, room.spectators[0]), owner = before.game.players.find(player => player.id === before.game.turnPlayerId);
  const rivals = before.game.players.filter(player => player.id !== owner.id);
  const single = owner.hand.find(id => getCard(id).rank <= 15 && rivals.every(player => player.hand.filter(card => getCard(card).rank === getCard(id).rank).length >= 2));
  assert.ok(single);
  const member = id => room.players.find(candidate => candidate.seat === id);
  const played = await f.action(room.code, member(owner.id), before, 'play', { cardIds: [single] });
  const bodies = rivals.map(() => f.input(played.view, 'fork'));
  const replies = await Promise.all(rivals.map((player, index) => f.request(`/api/rooms/${room.code}/actions`, member(player.id), bodies[index])));
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  const accepted = replies.findIndex(reply => reply.status === 200), rejected = 1 - accepted;
  const after = await f.view(room.code, room.spectators[0]);
  assert.equal(after.game.target.cardIds.length, 3); assert.equal(after.game.target.ownerId, rivals[accepted].id);
  for (let index = 0; index < rivals.length; index++) {
    const actual = after.game.players.find(player => player.id === rivals[index].id).hand;
    assert.equal(actual.length, rivals[index].hand.length - (index === accepted ? 2 : 0));
    if (index === rejected) assert.deepEqual(actual, rivals[index].hand);
  }
  const replay = await f.request(`/api/rooms/${room.code}/actions`, member(rivals[accepted].id), bodies[accepted]);
  assert.equal(replay.status, 200); assert.equal(replay.body.view.game.revision, after.game.revision);
  assert.equal(replay.body.view.game.moves.filter(move => move.type === 'fork').length, 1);
  const packet = await room.streams[3].wait(event => event.event === 'view' && event.data.game?.target?.id === after.game.target.id);
  assert.equal(packet.data.game.target.ownerId, rivals[accepted].id);
});
