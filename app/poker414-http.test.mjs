import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { readSettings } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';
import { MockProvider } from '../server/auth.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { getCard } from './games/poker414-2/cards.mjs';

// These are real HTTP, SessionService, encrypted storage, room and SSE paths.
// Only the upstream identity provider is synthetic; this is not real SSO evidence.
async function fixture(t, { enabled = true } = {}) {
  let at = Date.now(); const now = () => at;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_POKER414_ENABLED: enabled ? '1' : '0' });
  const storage = new EncryptedStore(new MemoryAdapter({ now }), randomBytes(32), now);
  const provider = new MockProvider(settings, { now });
  provider.complete = async () => ({ issuer: 'urn:414-room-http', sub: provider.member,
    accessToken: 'synthetic-private-room-token', expiresAt: now() + 3600000 });
  provider.check = async identity => ({ sub: identity.sub });
  const runtime = createRuntime(settings, { storage, provider, now,
    roomOptions: { pollIntervalMs: 0, serverRandomInt: max => max - 1 },
    chatOptions: { pollIntervalMs: 0 } });
  const server = createUnifiedServer(runtime), streams = [];
  t.after(async () => { for (const stream of streams) await stream.close(); server.closeAllConnections(); await server.shutdown(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  settings.origin = base; settings.callback = `${base}/auth/callback`; settings.postLogout = `${base}/`;
  async function request(path, member = {}, body) {
    const response = await fetch(base + path, { redirect: 'manual', method: body === undefined ? 'GET' : 'POST',
      headers: { ...(member.cookie ? { Cookie: member.cookie } : {}),
        ...(body === undefined ? {} : { Origin: base, 'X-CSRF-Token': member.csrf ?? '', 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, text };
  }
  async function login(sub) {
    provider.member = sub;
    const start = await request('/auth/login'), destination = new URL(start.headers.get('location'));
    const callback = await request(destination.pathname + destination.search, { cookie: start.headers.getSetCookie()[0].split(';')[0] });
    assert.equal(callback.status, 303);
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith(`${settings.cookieName}=`)).split(';')[0];
    const state = await request('/api/state', { cookie }); assert.equal(state.status, 200);
    return { cookie, csrf: state.body.csrf, state: state.body };
  }
  async function listen(code, member) {
    const cancellation = new AbortController();
    const response = await fetch(`${base}/api/rooms/${code}/events`, { headers: { Cookie: member.cookie }, signal: cancellation.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder(), packets = [], waiters = new Set(); let buffer = '';
    const reading = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
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
    // Observe the read immediately; a failed stream must not create an unhandled rejection.
    let readError = null; reading.catch(error => { readError = error; });
    const stream = { packets,
      wait(predicate) {
        const existing = packets.find(predicate); if (existing) return Promise.resolve(existing);
        if (readError) return Promise.reject(readError);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { waiters.delete(wake); reject(readError ?? new Error('SSE packet was not received within 3 seconds')); }, 3000);
          const wake = packet => { if (predicate(packet)) { clearTimeout(timeout); waiters.delete(wake); resolve(packet); } };
          waiters.add(wake);
        });
      },
      async close() { cancellation.abort(); await reader.cancel().catch(() => {}); await reading.catch(() => {}); },
    };
    streams.push(stream); return stream;
  }
  const view = async (code, member) => { const response = await request(`/api/rooms/${code}`, member); assert.equal(response.status, 200, response.text); return response.body.view; };
  async function action(code, member, type, extra = {}) {
    const current = await view(code, member);
    const body = { type, requestId: randomUUID(), expectedRevision: current.revision,
      ...(['play', 'pass', 'hook', 'fork'].includes(type) ? { matchId: current.matchId, roundId: current.game.roundId,
        targetId: current.game.target?.id ?? null, ...(['hook', 'fork'].includes(type) ? { windowId: current.game.responseWindow?.id } : {}) } : {}), ...extra };
    const response = await request(`/api/rooms/${code}/actions`, member, body);
    assert.equal(response.status, 200, response.text); return { ...response.body, input: body };
  }
  return { runtime, request, login, listen, view, action, advance: ms => { at += ms; } };
}

test('default runtime advertises 414 as closed and rejects a forged create while retaining old games', async t => {
  const f = await fixture(t, { enabled: false }), member = await f.login('a');
  assert.equal(member.state.poker414Enabled, false);
  const denied = await f.request('/api/rooms', member, { name: '伙伴', gameType: 'poker414-2', requestId: randomUUID() });
  assert.equal(denied.status, 400); assert.equal(denied.body.code, 'INVALID_GAME_TYPE');
  const old = await f.request('/api/rooms', member, { name: '伙伴', gameType: 'rummikub', requestId: randomUUID() });
  assert.equal(old.status, 201); assert.equal(old.body.view.gameType, 'rummikub');
});

test('enabled HTTP/SSE preserves private hands, reverse order, response intents, spectators and once-only departure settlement', async t => {
  const f = await fixture(t), members = [];
  for (const name of ['a', 'b', 'c', 'observer']) members.push(await f.login(name));
  assert.equal(members[0].state.poker414Enabled, true);
  const created = await f.request('/api/rooms', members[0], { name: '同名', gameType: 'poker414-2', requestId: randomUUID() });
  assert.equal(created.status, 201, created.text); const code = created.body.roomCode;
  for (const [index, member] of members.entries()) {
    if (index) assert.equal((await f.request(`/api/rooms/${code}/join`, member,
      { name: '同名', requestId: randomUUID(), ...(index === 3 ? { role: 'spectator' } : {}) })).status, 201);
    member.seat = (await f.view(code, member)).selfId;
  }
  const streams = await Promise.all(members.map(member => f.listen(code, member)));
  await Promise.all(streams.map(stream => stream.wait(packet => packet.event === 'view' && packet.data.phase === 'waiting')));
  for (const member of members.slice(0, 3)) await f.action(code, member, 'ready', { ready: true });
  const start = await f.action(code, members[0], 'start'); assert.equal(start.view.game.stage, 'dealing');
  const partialTime = start.view.turnClock.deadlineAt - start.view.serverTime;
  f.advance(partialTime); await f.runtime.rooms.sweep();
  const partial = await f.view(code, members[3]); assert.equal(partial.game.deckCount, 90);
  assert.equal(partial.game.players.flatMap(player => player.hand).length, 18);
  assert.equal('deck' in partial.game, false);
  f.advance(3000); await f.runtime.rooms.sweep(); const observerView = await f.view(code, members[3]);
  assert.equal(observerView.game.stage, 'playing'); assert.equal(observerView.turnClock, null);
  assert.equal(observerView.game.players.flatMap(player => player.hand).length, 108);
  const packets = await Promise.all(streams.map(stream => stream.wait(packet => packet.event === 'view' && packet.data.game?.stage === 'playing')));
  for (let index = 0; index < 3; index++) {
    const view = packets[index].data, packet = JSON.stringify(view);
    assert.equal(view.game.players.filter(player => Object.hasOwn(player, 'hand')).length, 1);
    assert.equal(view.game.players.find(player => player.hand).id, members[index].seat);
    for (const foreign of observerView.game.players.filter(player => player.id !== members[index].seat).flatMap(player => player.hand)) assert.equal(packet.includes(`"${foreign}"`), false);
    for (const secret of ['userKey', 'issuer', 'csrf', 'synthetic-private-room-token', '"deck"']) assert.equal(packet.includes(secret), false);
  }
  assert.equal(packets[3].data.selfRole, 'spectator');
  const seats = observerView.game.seatOrder;
  assert.deepEqual(observerView.game.actionOrder, [seats[0], ...seats.slice(1).reverse()]);
  const owner = observerView.game.players.find(player => player.id === observerView.game.turnPlayerId);
  const single = owner.hand.find(id => getCard(id).rank <= 15 && observerView.game.players.filter(player => player.id !== owner.id)
    .every(player => player.hand.filter(card => getCard(card).rank === getCard(id).rank).length >= 2));
  assert.ok(single);
  const ownerMember = members.find(member => member.seat === owner.id);
  const played = await f.action(code, ownerMember, 'play', { cardIds: [single] });
  const playedPacket = await streams[3].wait(packet => packet.event === 'view' && packet.data.game?.target?.id === played.view.game.target.id);
  assert.equal(playedPacket.data.game.target.cardIds.length, 1); assert.equal(playedPacket.data.turnClock.kind, 'response');
  const responder = members.slice(0, 3).find(member => member !== ownerMember);
  const fork = await f.action(code, responder, 'fork'); assert.equal(fork.view.game.target.cardIds.length, 3);
  const replay = await f.request(`/api/rooms/${code}/actions`, responder, fork.input);
  assert.equal(replay.status, 200); assert.equal(replay.body.view.game.revision, fork.view.game.revision);
  const observerAttempt = await f.request(`/api/rooms/${code}/actions`, members[3],
    { ...fork.input, requestId: randomUUID(), expectedRevision: fork.view.revision });
  assert.equal(observerAttempt.status, 403); assert.equal(observerAttempt.body.code, 'SPECTATOR_READ_ONLY');
  const before = (await f.view(code, responder)).game;
  const watchingLeft = await f.action(code, members[3], 'leave'); assert.equal(watchingLeft.left, true);
  assert.deepEqual((await f.view(code, responder)).game, before);
  await streams[3].close();
  const leaving = await f.action(code, ownerMember, 'leave'); assert.equal(leaving.left, true);
  const survivor = members.slice(0, 3).find(member => member !== ownerMember);
  const terminal = await f.view(code, survivor); assert.equal(terminal.phase, 'aborted');
  const closing = await streams[members.indexOf(survivor)].wait(packet => packet.event === 'view' && packet.data.phase === 'aborted');
  assert.equal(closing.data.game.result.reason, 'voluntary-leave');
  const duplicate = await f.request(`/api/rooms/${code}/actions`, ownerMember, leaving.input); assert.equal(duplicate.status, 200);
  const history = await f.request('/api/history', ownerMember); assert.equal(history.body.items.length, 1);
  assert.equal(history.body.items[0].self.score, -10); assert.equal(history.body.items[0].self.balanceAfter, -10);
  assert.equal((await f.request('/api/history', members[3])).body.items.length, 0);
});
