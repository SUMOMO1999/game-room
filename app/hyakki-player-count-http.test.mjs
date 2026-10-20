import { legacyHyakkiRegistry } from './test-support/hyakki-legacy-registry.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHyakkiHttpFixture } from './test-support/hyakki-http-fixture.mjs';
import { PLAYER_COUNT_CONTENT_VERSION } from './games/hyakki-trading/content/definitions.mjs';
import { historyPacketProblem } from './games/hyakki-trading/room-controller.mjs';

for (const [count, total, boards] of [[2,110,5],[3,144,7],[4,178,9],[5,212,11],[6,246,13]]) {
  test(`${count} seats: real current HTTP/SSE freezes recommended supply and exact new material`, async t => {
    const f = await createHyakkiHttpFixture(t, { gameRegistry: legacyHyakkiRegistry }), members = [];
    for (let index = 0; index < count; index++) members.push(await f.login(`count-${count}-${index}`));
    const created = await f.request('/api/rooms', members[0], { name: '甲', gameType: 'hyakki-trading', requestId: randomUUID() });
    assert.equal(created.status, 201, created.text); const code = created.body.roomCode;
    for (let index = 1; index < count; index++) {
      const joined = await f.request(`/api/rooms/${code}/join`, members[index], { name: `玩家${index+1}`, requestId: randomUUID() });
      assert.equal(joined.status, 201, joined.text);
    }
    for (const member of members) { member.seat = (await f.view(code, member)).selfId; await f.listen(code, member); }
    assert.equal((await f.view(code, members[0])).hyakkiConfig.goodsPerType, 3 * count);
    await f.action(code, members[0], 'configure', { hyakkiConfig: { actionLimit: 5, goodsPerType: 17, goodsSupplyMode: 'custom' } });
    assert.equal((await f.view(code, members[0])).hyakkiConfig.goodsPerType, 17);
    await f.action(code, members[0], 'configure', { hyakkiConfig: { actionLimit: 5, goodsPerType: 17, goodsSupplyMode: 'recommended' } });
    for (const member of members) await f.action(code, member, 'ready', { ready: true });
    const { view } = await f.action(code, members[0], 'start');
    assert.equal(view.game.contentVersion, PLAYER_COUNT_CONTENT_VERSION); assert.equal(view.game.goodsPerType, 3 * count);
    assert.equal(view.game.deckCount, total - count * 5); assert.equal(view.game.availableStalls, boards);
    const owner = members.find(member => member.seat === view.game.turnPlayerId);
    const peek = await f.action(code, owner, 'peek'); assert.equal(peek.view.game.pending.privatePool.length, 1);
    const other = members.find(member => member !== owner); assert.equal((await f.view(code, other)).game.pending.privatePool, undefined);
    await f.action(code, owner, 'keep-peek');
    const current = await f.view(code, owner), history = await f.request(`/api/hyakki/matches/${view.matchId}/events`, owner);
    assert.equal(history.status, 200, history.text); assert.equal(historyPacketProblem(history.body, current), null);
    for (const group of history.body.groups) {
      assert.equal(group.schemaVersion, 3); assert.equal(group.contentVersion, PLAYER_COUNT_CONTENT_VERSION); assert.equal(group.playerCount, count);
    }
    const record = await f.runtime.storage.read('rooms', view.roomId);
    assert.equal(record.value.snapshot.schemaVersion, 21);
    assert.equal(new Set([...record.value.snapshot.game.deck, ...record.value.snapshot.game.players.flatMap(player => player.hand)]).size, total);
    t.diagnostic(JSON.stringify({ playerCount: count, exactMaterial: total, recommendedStock: 3 * count, sharedBoards: boards,
      publicGroupSchema: 3, privatePeek: true, streams: count, requests: f.metrics.requests }));
  });
}
