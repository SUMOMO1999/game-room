import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readSettings } from '../server/config.mjs';
import { createHyakkiHttpFixture as fixture } from './test-support/hyakki-http-fixture.mjs';

async function started(t) {
  const f = await fixture(t), members = [];
  for (const sub of ['a', 'b', 'observer', 'outsider']) members.push(await f.login(sub));
  const created = await f.request('/api/rooms', members[0], { name: '同名', gameType: 'hyakki-trading', requestId: randomUUID() });
  assert.equal(created.status, 201, created.text); const code = created.body.roomCode;
  for (const [index, member] of members.slice(0, 3).entries()) {
    if (index) assert.equal((await f.request(`/api/rooms/${code}/join`, member,
      { name: '同名', requestId: randomUUID(), ...(index === 2 ? { role: 'spectator' } : {}) })).status, 201);
    member.seat = (await f.view(code, member)).selfId;
  }
  const streams = await Promise.all(members.slice(0, 3).map(member => f.listen(code, member)));
  await f.action(code, members[0], 'configure', { hyakkiConfig: { actionLimit: 3 } });
  for (const member of members.slice(0, 2)) await f.action(code, member, 'ready', { ready: true });
  const start = await f.action(code, members[0], 'start');
  return { ...f, members, streams, code, matchId: start.view.matchId,
    owner: members.find(member => member.seat === start.view.game.turnPlayerId),
    historyPath: `/api/hyakki/matches/${start.view.matchId}/events` };
}

test('Hyakki creation requires explicit unified-account capability while its adapter remains readable', async t => {
  assert.throws(() => readSettings({ GAME_ROOM_AUTH_MODE: 'legacy', GAME_ROOM_HYAKKI_ENABLED: '1' }), /unified/);
  assert.throws(() => readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_HYAKKI_ENABLED: 'yes' }), /explicit/);
  const f = await fixture(t, { enabled: false }), member = await f.login('a');
  assert.equal(member.state.hyakkiEnabled, false);
  assert.equal(f.runtime.gameRegistry.knownTypes().includes('hyakki-trading'), true);
  const denied = await f.request('/api/rooms', member, { name: '伙伴', gameType: 'hyakki-trading', requestId: randomUUID() });
  assert.equal(denied.status, 400); assert.equal(denied.body.code, 'INVALID_GAME_TYPE');
  assert.equal((await f.request('/api/rooms', member, { name: '伙伴', gameType: 'rummikub', requestId: randomUUID() })).status, 201);
});

test('real HTTP and three SSE streams isolate hands and peek, fence competing devices, and record one event group', async t => {
  const f = await started(t), { members, owner, code, streams } = f;
  assert.equal(owner.state.hyakkiEnabled, true);
  const opening = await Promise.all(streams.map(stream => stream.wait(packet => packet.event === 'view' && packet.data.game?.status === 'playing')));
  for (let i = 0; i < 3; i++) {
    const hands = opening[i].data.game.players.filter(player => Object.hasOwn(player, 'hand'));
    assert.equal(hands.length, i === 2 ? 0 : 1);
    if (i < 2) assert.equal(hands[0].id, members[i].seat);
  }
  const view = await f.view(code, owner), intent = { type: 'peek', requestId: randomUUID(), expectedRevision: view.revision,
    matchId: view.matchId, turnId: view.game.turnId };
  const [first, second] = await Promise.all([f.request(`/api/rooms/${code}/actions`, owner, intent),
    f.request(`/api/rooms/${code}/actions`, owner, { ...intent, requestId: randomUUID() })]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const accepted = first.status === 200 ? first : second;
  const packets = await Promise.all(streams.map(stream => stream.wait(packet => packet.event === 'view' && packet.data.game?.pending?.kind === 'peek')));
  const ownPacket = packets[members.indexOf(owner)].data.game, pool = ownPacket.pending.privatePool;
  assert.equal(pool.length, 1); assert.equal(ownPacket.actionsUsed, 1);
  for (let i = 0; i < 3; i++) if (members[i] !== owner) {
    const encoded = JSON.stringify(packets[i].data);
    assert.equal(packets[i].data.game.pending.privatePool, undefined);
    assert.equal(encoded.includes(pool[0].cardId), false);
    assert.equal(encoded.includes('"deck"'), false);
    assert.equal(encoded.includes('userKey'), false);
  }
  const denied = await f.request(`/api/rooms/${code}/actions`, members[2], { ...intent, requestId: randomUUID(), expectedRevision: accepted.body.view.revision });
  assert.equal(denied.status, 403);
  const saved = await f.runtime.storage.read('rooms', accepted.body.view.roomId);
  const rows = await f.runtime.storage.scan('hyakki-events');
  assert.equal(rows.length, saved.value.snapshot.game.publicEventSequence);
  assert.equal(rows.filter(row => row.value.events.some(event => event.type === 'draw-peeked')).length, 1);
  await f.action(code, owner, 'keep-peek');
});

test('public history permits original participants and only current room observers, with bounded pages and no private material', async t => {
  const f = await started(t), { members, owner, code, historyPath } = f;
  await f.action(code, owner, 'peek');
  assert.equal((await f.request(historyPath)).status, 401);
  assert.equal((await f.request(historyPath, members[3])).status, 403);
  assert.equal((await f.request(`${historyPath}?roomCode=${code}`, members[3])).status, 403);
  assert.equal((await f.request(historyPath, members[2])).status, 403);
  const page = await f.request(`${historyPath}?roomCode=${code}&limit=1`, members[2]);
  assert.equal(page.status, 200, page.text); assert.equal(page.body.groups.length, 1); assert.equal(page.body.hasMore, true);
  const later = await f.request(`${historyPath}?after=${page.body.nextAfter}`, owner);
  assert.equal(later.status, 200); assert.equal(later.body.groups[0].events[0].type, 'draw-peeked');
  for (const forbidden of ['userKey', 'participants', 'fingerprint', 'commitId', 'guards', 'poolCards', 'deck', 'synthetic-private-room-token'])
    assert.equal(later.text.includes(forbidden), false, forbidden);
  for (const query of ['limit=51', 'limit=0', 'after=-1', 'after=1&after=2', 'userKey=fake', 'roomCode=123'])
    assert.equal((await f.request(`${historyPath}?${query}`, owner)).status, 400, query);
  assert.equal((await f.request(historyPath, owner, {})).status, 405);
  await f.action(code, owner, 'leave');
  const archived = await f.request(historyPath, owner);
  assert.equal(archived.status, 200, archived.text); assert.equal(archived.body.groups.at(-1).events.at(-1).type, 'match-ended');
  const survivor = members.slice(0, 2).find(member => member !== owner);
  assert.equal((await f.request('/api/history', survivor)).body.items[0].self.wealth, 20);
  await f.action(code, members[2], 'leave');
  assert.equal((await f.request(`${historyPath}?roomCode=${code}`, members[2])).status, 403);
  assert.equal((await f.request(historyPath, owner)).status, 200);
});

test('public history output rechecks observer membership and session after asynchronous storage reads', async t => {
  const f = await started(t), { members, code, historyPath } = f;
  let triggered = false;
  f.hooks.afterPage = async () => { if (triggered) return; triggered = true; await f.action(code, members[2], 'leave'); };
  assert.equal((await f.request(`${historyPath}?roomCode=${code}`, members[2])).status, 403);
  f.hooks.afterPage = () => { f.advance(3600001); f.hooks.afterPage = null; };
  const expired = await f.request(historyPath, members[0]);
  assert.equal(expired.status, 401); assert.equal(expired.body.groups, undefined);
});
