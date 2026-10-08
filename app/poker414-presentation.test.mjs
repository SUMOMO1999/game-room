import test from 'node:test';
import assert from 'node:assert/strict';
import { getCard, makeDeck } from './games/poker414-2/cards.mjs';
import { classifyPattern } from './games/poker414-2/patterns.mjs';
import { toPoker414View, poker414Selection, poker414PatternLabel } from './games/poker414-2/presentation.mjs';
import { createRoomStore } from './rooms.mjs';
import { createGameRegistry } from './game-registry.mjs';
import { createPoker414Adapter } from '../server/games/poker414-2/adapter.mjs';

const card = (rank, suit = 'spades', copy = 0) => getCard(`p414-2-${suit}-${rank}-${copy}`);
const player = (id, name, hand = []) => ({ id, name, ready: true, connected: true, handCount: hand.length, hand: hand.map(card => card.id) });
function projection() {
  const players = [player('a', '阿甲', [card(5), card(5, 'hearts'), card(10)]), player('b', '阿乙', [card(9)]), player('c', '阿丙', [card(11)])];
  return { gameType: 'poker414-2', roomCode: '414000', roomId: 'r', revision: 7, matchId: 'm', selfId: 'a', selfRole: 'player', phase: 'playing', hostId: 'a',
    players, spectators: [], matchPlayers: [], serverTime: 1000, game: { stage: 'playing', players, actionOrder: ['a', 'c', 'b'], seatOrder: ['a', 'b', 'c'],
      turnPlayerId: 'a', firstPlayerId: 'c', roundId: 1, moves: [], target: null, responseWindow: null, eventSeq: 0, result: null } };
}
const scores = room => ({ accountGroup: '4a4', roomId: room.roomId, roomRevision: room.revision, matchId: room.matchId, readAt: 1001,
  players: room.players.map((player, index) => ({ playerId: player.id, total: 100 + index })), settlement: null });

test('414 mapper consumes real room projections without exposing another player hand or undealt cards', t => {
  let at = 1000;
  const store = createRoomStore({ now: () => at, gameRegistry: createGameRegistry([createPoker414Adapter()]), serverRandomInt: max => max - 1 });
  t.after(() => store.close());
  const keys = ['a', 'b', 'c', 'd'].map(key => key.repeat(64));
  store.createTrustedRoom(keys[0], '甲', { gameType: 'poker414-2', code: '414000', roomId: 'a'.repeat(32) });
  for (const index of [1, 2]) store.joinTrustedRoom('414000', keys[index], `伙伴${index}`);
  let seq = 0;
  const act = (index, type, fields = {}) => store.trustedAction('414000', keys[index], { type, ...fields, requestId: `presentation-${++seq}`, expectedRevision: store.getTrustedView('414000', keys[index]).revision });
  for (const index of [0, 1, 2]) act(index, 'ready', { ready: true }); act(0, 'start');
  store.joinTrustedRoom('414000', keys[3], '观众');
  const original = store.exportSnapshot('414000'); at = original.turnClock.deadlineAt; store.applyTurnTimeout('414000', original.turnClock);
  const raw = store.getTrustedView('414000', keys[0]), own = toPoker414View(raw), observer = toPoker414View(store.getTrustedView('414000', keys[3]));
  assert.equal(own.phase, 'dealing'); assert.equal(observer.phase, 'dealing');
  assert.equal(own.players.filter(player => player.hand.length).length, 1); assert.equal(observer.players.flatMap(player => player.hand).length, 18);
  for (const id of store.exportSnapshot('414000').game.deck.slice(18)) assert.equal(JSON.stringify(observer).includes(id), false);
  assert.equal(own.canStart, false); assert.equal(own.canReady, false); assert.equal(poker414Selection(own).canPlay, false);
});

test('role defense, true cyclic order and immutable input survive mapper normalization', () => {
  const room = projection(), before = structuredClone(room), view = toPoker414View(room);
  assert.deepEqual(view.actionOrder, ['c', 'b', 'a']); assert.deepEqual(view.hand.map(card => card.rank), [5, 5, 10]);
  assert.deepEqual(view.players.slice(1).map(player => player.hand), [[], []]); assert.deepEqual(room, before);
  const observer = toPoker414View({ ...room, selfId: 'spectator', selfRole: 'spectator' });
  assert.deepEqual(observer.actionOrder, ['a', 'c', 'b']); assert.equal(observer.hand.length, 0); assert.equal(observer.players.flatMap(player => player.hand).length, 5);
  assert.equal(poker414Selection(observer).canPlay, false); assert.equal(poker414Selection(observer).canFork, false);
});

test('public hook/fork chain renders each physical card once while target remains separately inspectable', () => {
  const room = projection(), ids = makeDeck().filter(card => card.rank === 6).map(card => card.id);
  room.game.moves = [{ rootId: 'chain', playerId: 'a', cardIds: ids.slice(0, 2) }, { rootId: 'chain', playerId: 'b', cardIds: ids.slice(2, 3) },
    { rootId: 'chain', playerId: 'c', cardIds: ids.slice(3, 5) }, { rootId: 'chain', playerId: 'a', cardIds: ids.slice(5, 6) }, { rootId: 'chain', playerId: 'c', cardIds: ids.slice(6) }];
  room.game.target = { id: 't', ownerId: 'c', cardIds: ids, pattern: classifyPattern(ids) };
  const view = toPoker414View(room);
  assert.equal(view.publicGroups.length, 1); assert.deepEqual(view.publicGroups[0].cards.map(card => card.id), ids);
  assert.match(view.publicGroups[0].label, /阿丙.*8张6炸弹/); assert.equal(view.target.cards.length, 8);
});

test('result uses actual saved participant and frozen settlement total; scope/version mismatches stay unconfirmed', () => {
  const room = projection(); room.phase = 'aborted'; room.players = room.players.filter(player => player.id !== 'b');
  room.resultParticipants = [{ playerId: 'b', name: '离席的原名' }];
  room.game.result = { reason: 'voluntary-leave', responsiblePlayerId: 'b', settlementVersion: 'v1', deltas: [{ playerId: 'a', points: 5 }, { playerId: 'b', points: -10 }, { playerId: 'c', points: 5 }] };
  const packet = scores(room); packet.settlement = { matchId: 'm', settlementVersion: 'v1', balancesAfter: ['a', 'b', 'c'].map(playerId => ({ playerId, total: 40 })) };
  let view = toPoker414View(room, { scorePacket: packet });
  assert.match(view.resultTitle, /离席的原名/); assert.equal(view.scoreConfirmed, true); assert.deepEqual(view.resultRows.map(row => row.balanceAfter), [40,40,40]);
  assert.equal(view.players[0].total, 100); assert.match(view.leaveDescription, /不扣分/);
  for (const replacement of [{ accountGroup: 'other' }, { roomId: 'other' }, { matchId: 'other' }, { roomRevision: 999 }, { settlement: { ...packet.settlement, settlementVersion: 'wrong' } }]) {
    view = toPoker414View(room, { scorePacket: { ...packet, ...replacement } }); assert.equal(view.scoreConfirmed, false); assert.ok(view.resultRows.every(row => row.balanceAfter === null));
  }
});

test('waiting permissions cover owner, spectators, capacity, readiness and recovery locks', () => {
  const room = projection(); room.phase = 'waiting'; room.game = null;
  const view = toPoker414View(room); assert.equal(view.canStart, true); assert.equal(view.canChangeRole, false); assert.equal(view.transferCandidates.length, 2);
  const friend = toPoker414View({ ...room, selfId: 'b' }); assert.equal(friend.canStart, false); assert.equal(friend.canReady, true); assert.equal(friend.canChangeRole, true);
  assert.equal(toPoker414View({ ...room, selfId: 'b', spectators: Array(8).fill({ id: 'x' }) }).canChangeRole, false);
  for (const options of [{ pending: true }, { connection: 'offline' }, { canAct: false }]) {
    const locked = toPoker414View(room, options); assert.equal(locked.canStart, false); assert.equal(locked.canReady, false); assert.equal(locked.canChangeRole, false);
  }
  room.lastMatchResult = { matchId: 'old', reason: 'server-recovery' };
  assert.match(toPoker414View(room).cancellationNote, /服务恢复/); assert.equal(toPoker414View(room).resultRows.length, 0);
});

test('selection validates actual own physical cards, comparison and multiple legal options without choosing one', () => {
  const view = toPoker414View(projection()), pair = view.hand.slice(0, 2).map(card => card.id);
  assert.equal(poker414Selection(view, pair).canPlay, true); assert.equal(poker414Selection(view).uniqueChoice, null);
  assert.equal(poker414Selection(view, [pair[0], pair[0]]).canPlay, false); assert.equal(poker414Selection(view, [card(9).id]).canPlay, false);
  assert.equal(poker414Selection(view).canPass, false);
  const target = { pattern: classifyPattern([card(9).id]), cards: [card(9)] };
  const following = { ...view, target };
  assert.equal(poker414Selection(following, pair).canPlay, false); assert.equal(poker414Selection(following).canPass, true);
  assert.deepEqual(poker414Selection(following).uniqueChoice, [card(10).id]);
  assert.equal(poker414Selection({ ...following, pending: true }, [card(10).id]).canPlay, false);
});

test('response uses owned rank count and target owner with a strict deadline, independently of ordinary turn', () => {
  const view = toPoker414View(projection()); view.turnPlayerId = 'c'; view.targetOwnerId = 'b'; view.response = { id: 'w', action: 'fork', rank: 5, deadlineAt: 2000 };
  assert.equal(poker414Selection(view, [], { now: 1999 }).canFork, true);
  assert.equal(poker414Selection(view, [], { now: 2000 }).canFork, false);
  assert.equal(poker414Selection({ ...view, targetOwnerId: view.selfId }, [], { now: 1000 }).canFork, false);
  assert.equal(poker414Selection({ ...view, hand: [card(5)] }, [], { now: 1000 }).canFork, false);
  assert.equal(poker414Selection({ ...view, hand: [card(5)], response: { ...view.response, action: 'hook' } }, [], { now: 1000 }).canHook, true);
  assert.equal(poker414Selection({ ...view, response: { ...view.response, rank: 17 } }, [], { now: 1000 }).canFork, false);
});

test('all special labels use rule rank values and distinguish rocket grades', () => {
  assert.equal(poker414PatternLabel(classifyPattern([card(4, 'hearts').id, card(4, 'hearts', 1).id, card(14, 'hearts').id])), '纯红桃火箭');
  assert.equal(poker414PatternLabel(classifyPattern([card(16, 'joker').id, card(17, 'joker').id])), '大小王炸弹');
});
