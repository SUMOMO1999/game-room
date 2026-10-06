import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, privateView, spectatorView, gameProblem } from './multiplayer-rules.mjs';

const people = [
  { id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' },
  { id: 'chen', name: 'Chen' }, { id: 'dana', name: 'Dana' },
  { id: 'ellie', name: 'Ellie' }, { id: 'fang', name: 'Fang' },
  { id: 'gina', name: 'Gina' },
];
const tenIds = ['red-10-a', 'blue-10-a', 'black-10-a'];
const fourIds = ['blue-4-a', 'black-4-a', 'orange-4-a'];
const allTiles = (game) => [...game.board.flat(), ...game.pool, ...game.players.flatMap((player) => player.rack)];
const allIds = (game) => allTiles(game).map((tile) => tile.id).sort();

function teachingGame(count = 2, options = {}) {
  // Choosing the last shuffle index preserves the teaching-hand deck order.
  // Production uses the default crypto source, never this test source.
  return createGame(people.slice(0, count), { randomInt: (maximum) => maximum - 1, firstTurnIndex: 0, ...options });
}

function actionFor(game, playerId, newMelds) {
  const played = new Set(newMelds.flat());
  return {
    type: 'submit',
    boardIds: [...game.board.map((meld) => meld.map((tile) => tile.id)), ...newMelds.map((meld) => [...meld])],
    rackIds: game.players.find((player) => player.id === playerId).rack.filter((tile) => !played.has(tile.id)).map((tile) => tile.id),
  };
}

function success(game, playerId, action) {
  const original = structuredClone(game);
  const result = applyGameAction(game, playerId, action);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(game, original, 'successful actions must leave the previous snapshot intact');
  assert.deepEqual(allIds(result.state), allIds(game), 'all configured physical tile IDs survive each turn');
  assert.equal(result.state.revision, game.revision + 1);
  assert.equal(result.state.round, game.round + 1);
  return result.state;
}

function failure(game, playerId, action, message) {
  const original = structuredClone(game);
  const result = applyGameAction(game, playerId, action);
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  if (message) assert.match(result.error, message);
  assert.equal('state' in result, false);
  assert.deepEqual(game, original, 'rejected actions must be atomic');
  return result;
}

function fixture({ racks, board = [], opened = racks.map(() => true), emptyPool = false, copies, jokerCount, jokerConfig, ruleVersion = 'friends-v2' }) {
  const game = teachingGame(racks.length, { copies, jokerCount, jokerConfig });
  game.ruleVersion = ruleVersion;
  const byId = new Map(allTiles(game).map((tile) => [tile.id, tile]));
  const used = new Set();
  const take = (id) => {
    assert.ok(byId.has(id), `unknown fixture tile ${id}`);
    assert.equal(used.has(id), false, `fixture reused tile ${id}`);
    used.add(id);
    return structuredClone(byId.get(id));
  };
  game.players.forEach((player, index) => {
    player.rack = racks[index].map(take);
    player.opened = opened[index];
  });
  game.board = board.map((meld) => meld.map(take));
  const remaining = [...byId.values()].filter((tile) => !used.has(tile.id)).map((tile) => structuredClone(tile));
  game.pool = emptyPool ? [] : remaining;
  if (emptyPool) game.players.at(-1).rack.push(...remaining);
  assert.equal(allTiles(game).length, game.tileCount);
  return game;
}

function balancedEmptyPool() {
  const game = teachingGame();
  const deck = allTiles(game);
  game.pool = [];
  game.players[0].rack = deck.filter((tile) => tile.id.endsWith('-a'));
  game.players[1].rack = deck.filter((tile) => tile.id.endsWith('-b'));
  return game;
}

test('production creation deals 14 each for 2–7 players with the confirmed two/three-copy thresholds', () => {
  for (const count of [2, 3, 4, 5, 6, 7]) {
    const game = createGame(people.slice(0, count));
    const copies = count > 4 ? 3 : 2;
    const tileCount = copies === 3 ? 159 : 106;
    assert.equal(game.board.length, 0);
    assert.equal(game.players.length, count);
    assert.ok(game.players.every((player) => player.rack.length === 14 && !player.opened));
    assert.equal(game.pool.length, tileCount - count * 14);
    assert.equal(new Set(allIds(game)).size, tileCount);
    assert.equal(allTiles(game).filter((tile) => tile.joker).length, copies);
    assert.equal(game.copies, copies);
    assert.equal(game.jokerCount, copies);
    assert.equal(game.tileCount, tileCount);
    assert.equal(game.deckCopies, copies);
    assert.equal(game.deckSize, tileCount);
    assert.ok(game.turnIndex >= 0 && game.turnIndex < count);
    assert.equal(game.revision, 0);
    assert.equal(game.round, 1);
    assert.equal(game.status, 'playing');
    assert.equal(game.winnerId, null);
    assert.equal(game.result, null);
    assert.equal(game.ruleVersion, 'friends-v2');
  }
});

test('the injectable Fisher–Yates source is bounded, reproducible, and also chooses the starter', () => {
  const calls = [];
  const game = createGame(people.slice(0, 3), { randomInt: (maximum) => { calls.push(maximum); return maximum - 1; } });
  assert.deepEqual(calls, [...Array.from({ length: 105 }, (_, index) => 106 - index), 3]);
  assert.equal(game.turnIndex, 2);
  assert.deepEqual(game.players[0].rack.slice(0, 3).map((tile) => tile.id), tenIds);
  assert.deepEqual(teachingGame(), teachingGame());
  assert.throws(() => createGame(people.slice(0, 2), { randomInt: (maximum) => maximum }), /随机源/);
  assert.throws(() => createGame(people.slice(0, 2), { firstTurnIndex: 2 }), /首位/);
  assert.throws(() => createGame(people.slice(0, 2), { randomInt: 'bad' }), /随机源/);
});

test('creation rejects unsupported player counts, duplicate identities, and invalid names', () => {
  assert.throws(() => createGame(people.slice(0, 1)), /2至7/);
  assert.throws(() => createGame([...people, { id: 'eighth', name: 'Eighth' }]), /2至7/);
  assert.throws(() => createGame([people[0], people[0]]), /重复/);
  assert.throws(() => createGame([people[0], { id: 'bob', name: ' ' }]), /名字/);
  assert.throws(() => createGame([people[0], { id: 'bob', name: 'x'.repeat(33) }]), /名字/);
});

test('a genuine three-player sequence opens, draws twice, then submits a second meld', () => {
  let game = teachingGame(3);
  const originalBobRack = structuredClone(game.players[1].rack);
  const originalChenRack = structuredClone(game.players[2].rack);
  game = success(game, 'alice', actionFor(game, 'alice', [tenIds]));
  assert.equal(game.players[0].rack.length, 11);
  assert.equal(game.players[0].opened, true);
  assert.equal(game.players[1].opened, false);
  assert.equal(privateView(game, 'alice').turnPlayerId, 'bob');
  assert.deepEqual(game.players[1].rack, originalBobRack);
  assert.deepEqual(game.players[2].rack, originalChenRack);
  const bobDraw = game.pool[0].id;
  game = success(game, 'bob', { type: 'draw' });
  assert.equal(game.players[1].rack.at(-1).id, bobDraw);
  assert.equal(game.players[1].rack.length, 15);
  const chenDraw = game.pool[0].id;
  game = success(game, 'chen', { type: 'draw' });
  assert.equal(game.players[2].rack.at(-1).id, chenDraw);
  assert.equal(privateView(game, 'alice').turnPlayerId, 'alice');
  game = success(game, 'alice', actionFor(game, 'alice', [fourIds]));
  assert.equal(game.board.length, 2);
  assert.equal(game.players[0].rack.length, 8);
  assert.equal(game.round, 5);
  assert.equal(game.revision, 4);
  assert.equal(game.pool.length, 62);
});

test('only the current room member can act, and turns wrap through all four players', () => {
  let game = teachingGame(4);
  failure(game, 'bob', { type: 'draw' }, /没轮到/);
  failure(game, 'stranger', { type: 'draw' }, /不在/);
  failure(game, 'alice', { type: 'unsupported' }, /不支持/);
  failure(game, 'alice', null, /不支持/);
  failure(game, 'alice', { type: 'pass' }, /还有牌/);
  for (const player of people.slice(0, 4)) {
    assert.equal(privateView(game, player.id).turnPlayerId, player.id);
    game = success(game, player.id, { type: 'draw' });
  }
  assert.equal(game.turnIndex, 0);
  assert.ok(game.players.every((player) => player.rack.length === 15));
});

test('each player must independently open with 30, including exact joker substitution points', () => {
  let game = teachingGame();
  failure(game, 'alice', actionFor(game, 'alice', [fourIds]), /30/);
  game = success(game, 'alice', actionFor(game, 'alice', [['red-10-a', 'blue-10-a', 'joker-a']]));
  assert.equal(game.players[0].opened, true);
  assert.equal(privateView(game, 'bob').opened, false);

  const runGame = fixture({ racks: [['red-10-a', 'red-11-a', 'joker-a', 'black-2-a'], ['blue-1-a']], opened: [false, false] });
  const after = success(runGame, 'alice', actionFor(runGame, 'alice', [['red-10-a', 'red-11-a', 'joker-a']]));
  assert.equal(after.players[0].opened, true, '10/11/joker represents 10/11/12 = 33');
});

test('an opening player cannot manipulate the existing public table in that same turn', () => {
  const game = fixture({
    racks: [[...tenIds, 'red-4-a', 'black-2-a'], ['blue-1-a']],
    board: [['red-1-a', 'red-2-a', 'red-3-a']], opened: [false, false],
  });
  const action = actionFor(game, 'alice', [tenIds]);
  action.boardIds[0].push('red-4-a');
  action.rackIds = action.rackIds.filter((id) => id !== 'red-4-a');
  failure(game, 'alice', action, /首次开局/);
});

test('an opened player can legally split the public run while adding their own cards', () => {
  const game = fixture({
    racks: [['blue-6-a', 'blue-10-b', 'blue-11-b', 'black-2-a'], ['orange-1-a']],
    board: [['blue-7-a', 'blue-8-a', 'blue-9-a']],
  });
  const action = {
    type: 'submit',
    boardIds: [['blue-6-a', 'blue-7-a', 'blue-8-a'], ['blue-9-a', 'blue-10-b', 'blue-11-b']],
    rackIds: ['black-2-a'],
  };
  const after = success(game, 'alice', action);
  assert.equal(after.board.length, 2);
  assert.equal(after.players[0].rack.length, 1);
  assert.equal(after.turnIndex, 1);
});

test('ID-only submissions cannot steal opponent or pool cards, duplicate cards, or discard cards', () => {
  const game = teachingGame();
  const valid = actionFor(game, 'alice', [tenIds]);
  const stolenOpponent = structuredClone(valid);
  stolenOpponent.boardIds[0][0] = game.players[1].rack[0].id;
  failure(game, 'alice', stolenOpponent, /自己的手牌/);
  const stolenPool = structuredClone(valid);
  stolenPool.boardIds[0][0] = game.pool[0].id;
  failure(game, 'alice', stolenPool, /自己的手牌/);
  const duplicate = structuredClone(valid);
  duplicate.rackIds.push(tenIds[0]);
  failure(game, 'alice', duplicate, /重复/);
  const discarded = structuredClone(valid);
  discarded.rackIds.pop();
  failure(game, 'alice', discarded, /不能丢失/);
  const forged = structuredClone(valid);
  forged.boardIds[0][0] = { id: tenIds[0], value: 13, color: 'orange' };
  failure(game, 'alice', forged, /只能包含/);
});

test('client-supplied values, colors, opened flags, and hidden fields cannot override canonical state', () => {
  const game = teachingGame();
  const action = {
    ...actionFor(game, 'alice', [tenIds]),
    value: 13, color: 'orange', opened: true,
    players: [], pool: [], round: 1000, revision: 1000,
  };
  const after = success(game, 'alice', action);
  assert.deepEqual(after.board[0].map((tile) => tile.value), [10, 10, 10]);
  assert.deepEqual(after.board[0].map((tile) => tile.color), ['red', 'blue', 'black']);
  assert.equal(after.players.length, 2);
  assert.equal(after.pool.length, game.pool.length);
  assert.equal(after.round, 2);
  assert.equal(after.revision, 1);
});

test('public table cards cannot be taken back into the rack, even while preserving every ID', () => {
  const game = fixture({
    racks: [tenIds, ['blue-1-a']], board: [['red-1-a', 'red-2-a', 'red-3-a']],
  });
  failure(game, 'alice', {
    type: 'submit',
    boardIds: [['red-2-a', 'red-3-a'], tenIds],
    rackIds: ['red-1-a'],
  }, /不能取回/);
});

test('invalid sets and table-only rearrangement reject atomically without advancing the turn', () => {
  const game = teachingGame();
  failure(game, 'alice', actionFor(game, 'alice', [['red-6-a', 'red-8-a', 'black-13-a']]), /需要/);
  const opened = fixture({ racks: [['black-2-a'], ['blue-1-a']], board: [tenIds] });
  failure(opened, 'alice', {
    type: 'submit', boardIds: [tenIds.toReversed()], rackIds: ['black-2-a'],
  }, /至少需要/);
});

test('submitted joker melds remain locked against extension and otherwise legal retrieval', () => {
  const extension = fixture({
    ruleVersion: 'friends-v1',
    racks: [['red-8-a', 'black-2-a'], ['blue-1-a']],
    board: [['red-6-a', 'red-7-a', 'joker-a']],
  });
  failure(extension, 'alice', {
    type: 'submit', boardIds: [['red-6-a', 'red-7-a', 'red-8-a', 'joker-a']], rackIds: ['black-2-a'],
  }, /锁定/);
  const retrieval = fixture({
    ruleVersion: 'friends-v1',
    racks: [['red-6-a', 'red-7-a', 'red-8-a', 'black-2-a'], ['blue-1-a']],
    board: [[...fourIds, 'joker-a']],
  });
  failure(retrieval, 'alice', {
    type: 'submit', boardIds: [fourIds, ['red-6-a', 'red-7-a', 'red-8-a', 'joker-a']], rackIds: ['black-2-a'],
  }, /锁定/);
  const wholeMove = actionFor(retrieval, 'alice', [['red-6-a', 'red-7-a', 'red-8-a']]);
  wholeMove.boardIds.reverse();
  assert.equal(applyGameAction(retrieval, 'alice', wholeMove).ok, true);
});

test('playing the last rack tile wins immediately and later actions are refused', () => {
  const game = fixture({
    racks: [['red-4-a'], ['blue-1-a', 'black-2-a']],
    board: [['red-1-a', 'red-2-a', 'red-3-a']],
  });
  const after = success(game, 'alice', {
    type: 'submit', boardIds: [['red-1-a', 'red-2-a', 'red-3-a', 'red-4-a']], rackIds: [],
  });
  assert.equal(after.status, 'finished');
  assert.equal(after.winnerId, 'alice');
  assert.deepEqual(after.result, {
    reason: 'rack-empty', winnerIds: ['alice'],
    scores: [{ playerId: 'alice', name: 'Alice', points: 0 }, { playerId: 'bob', name: 'Bob', points: 3 }],
    tie: false,
  });
  assert.equal(after.turnIndex, 0);
  failure(after, 'bob', { type: 'draw' }, /已经结束/);
  assert.equal(privateView(after, 'bob').result.winnerIds[0], 'alice');
});

test('drawing uses only server pool, preserves the table, and ends the current turn', () => {
  const game = teachingGame();
  const firstPoolTile = structuredClone(game.pool[0]);
  const after = success(game, 'alice', {
    type: 'draw', boardIds: [tenIds], rackIds: [], value: 13,
  });
  assert.deepEqual(after.board, game.board);
  assert.equal(after.players[0].rack.length, 15);
  assert.deepEqual(after.players[0].rack.at(-1), firstPoolTile);
  assert.equal(after.players[0].opened, false);
  assert.deepEqual(after.players[1].rack, game.players[1].rack);
  failure(after, 'alice', actionFor(after, 'alice', [tenIds]), /没轮到/);
});

test('empty pool blocks drawing, then consecutive passes settle a shared minimum with joker penalty 30', () => {
  let game = balancedEmptyPool();
  assert.equal(game.players[0].rack.length, 53);
  assert.equal(game.players[1].rack.length, 53);
  failure(game, 'alice', { type: 'draw' }, /牌池已空/);
  game = success(game, 'alice', { type: 'pass' });
  assert.equal(game.status, 'playing');
  assert.equal(game.consecutivePasses, 1);
  game = success(game, 'bob', { type: 'pass' });
  assert.equal(game.status, 'finished');
  assert.equal(game.consecutivePasses, 2);
  assert.equal(game.winnerId, null);
  assert.deepEqual(game.result.winnerIds, ['alice', 'bob']);
  assert.equal(game.result.tie, true);
  assert.deepEqual(game.result.scores.map((score) => score.points), [394, 394]);
});

test('blocked settlement chooses the sole lowest hand score when scores differ', () => {
  let game = balancedEmptyPool();
  const index = game.players[0].rack.findIndex((tile) => tile.id === 'black-13-a');
  game.players[1].rack.push(game.players[0].rack.splice(index, 1)[0]);
  game = success(game, 'alice', { type: 'pass' });
  game = success(game, 'bob', { type: 'pass' });
  assert.equal(game.winnerId, 'alice');
  assert.equal(game.result.tie, false);
  assert.deepEqual(game.result.scores.map((score) => score.points), [381, 407]);
});

test('four players require four consecutive empty-pool passes, not two', () => {
  let game = teachingGame(4);
  const deck = allTiles(game);
  game.pool = [];
  game.players.forEach((player, index) => { player.rack = deck.filter((_, tileIndex) => tileIndex % 4 === index); });
  for (let index = 0; index < 4; index += 1) {
    game = success(game, people[index].id, { type: 'pass' });
    assert.equal(game.consecutivePasses, index + 1);
    assert.equal(game.status, index === 3 ? 'finished' : 'playing');
  }
});

test('a legal submission after a pass resets the consecutive-pass counter', () => {
  let game = fixture({ racks: [[...tenIds, 'orange-1-a'], ['black-1-a']], emptyPool: true, opened: [false, false] });
  game = success(game, 'alice', { type: 'pass' });
  assert.equal(game.consecutivePasses, 1);
  game = success(game, 'bob', actionFor(game, 'bob', [['blue-12-a', 'black-12-a', 'orange-12-a']]));
  assert.equal(game.consecutivePasses, 0);
  game = success(game, 'alice', { type: 'pass' });
  assert.equal(game.status, 'playing');
  assert.equal(game.consecutivePasses, 1);
  game = success(game, 'bob', { type: 'pass' });
  assert.equal(game.status, 'finished');
});

test('private views expose only own rack, public board, counts, and public metadata', () => {
  const game = teachingGame(3);
  game.debugHiddenPool = game.pool;
  game.players[1].internalSecret = 'not-for-clients';
  for (const player of game.players) {
    const view = privateView(game, player.id);
    assert.equal(view.playerId, player.id);
    assert.equal(view.opened, player.opened);
    assert.equal(view.poolCount, game.pool.length);
    assert.equal(view.turnPlayerId, 'alice');
    assert.deepEqual(view.rack, player.rack);
    assert.ok(view.players.every((other) => !('rack' in other) && other.rackCount === 14));
    assert.equal('pool' in view, false);
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes('not-for-clients'), false);
    assert.equal(serialized.includes('debugHiddenPool'), false);
    for (const hiddenTile of [...game.pool, ...game.players.filter((other) => other.id !== player.id).flatMap((other) => other.rack)]) {
      assert.equal(serialized.includes(JSON.stringify(hiddenTile.id)), false, `view leaked ${hiddenTile.id}`);
    }
    view.rack[0].value = 13;
    view.players[0].name = 'changed';
    assert.notEqual(game.players[0].name, 'changed');
    assert.deepEqual(privateView(game, player.id).rack, player.rack);
  }
  assert.throws(() => privateView(game, 'stranger'), /不在/);
});

test('corrupt server snapshots fail closed instead of silently losing cards', () => {
  const game = teachingGame();
  const lost = structuredClone(game);
  lost.pool.pop();
  failure(lost, 'alice', { type: 'draw' }, /106/);
  const duplicate = structuredClone(game);
  duplicate.pool[0] = { ...duplicate.pool[1] };
  failure(duplicate, 'alice', { type: 'draw' }, /重复/);
  const changed = structuredClone(game);
  changed.players[0].rack[0].value = 13;
  failure(changed, 'alice', { type: 'draw' }, /不能改变/);
  assert.throws(() => privateView(changed, 'alice'), /不能改变/);
});

test('three-copy rooms contain every distinct c-copy and use the confirmed pool sizes', () => {
  assert.equal(teachingGame(4).pool.length, 50);
  assert.equal(teachingGame(5).pool.length, 89);
  const game = teachingGame(7);
  assert.equal(game.pool.length, 61);
  assert.equal(allTiles(game).length, 159);
  assert.ok(allTiles(game).some((tile) => tile.id === 'red-13-c'));
  assert.ok(allTiles(game).some((tile) => tile.id === 'joker-c'));
  for (const color of ['red', 'blue', 'black', 'orange']) {
    for (let value = 1; value <= 13; value += 1) {
      assert.equal(allTiles(game).filter((tile) => !tile.joker && tile.color === color && tile.value === value).length, 3);
    }
  }
  const view = privateView(game, 'alice');
  assert.equal(view.copies, 3);
  assert.equal(view.jokerCount, 3);
  assert.equal(view.tileCount, 159);
  assert.equal(view.deckCopies, 3);
  assert.equal(view.deckSize, 159);
});

test('seven real turns conserve all 159 cards and hidden c-copy pool cards cannot be stolen', () => {
  let game = teachingGame(7);
  const stolenPool = actionFor(game, 'alice', [tenIds]);
  stolenPool.boardIds[0][0] = 'red-13-c';
  failure(game, 'alice', stolenPool, /自己的手牌/);
  const stolenOther = actionFor(game, 'alice', [tenIds]);
  stolenOther.boardIds[0][0] = game.players[6].rack[0].id;
  failure(game, 'alice', stolenOther, /自己的手牌/);
  for (const player of people) game = success(game, player.id, { type: 'draw' });
  assert.equal(game.turnIndex, 0);
  assert.equal(game.pool.length, 54);
  assert.equal(game.revision, 7);
  assert.ok(game.players.every((player) => player.rack.length === 15));
  assert.equal(allTiles(game).length, 159);
  const view = privateView(game, 'alice');
  const serialized = JSON.stringify(view);
  for (const hidden of [...game.pool, ...game.players.slice(1).flatMap((player) => player.rack)]) {
    assert.equal(serialized.includes(JSON.stringify(hidden.id)), false);
  }
  const lost = structuredClone(game);
  lost.pool.pop();
  failure(lost, 'alice', { type: 'draw' }, /159/);
});

test('a five-player c-copy opening supports three jokers but rejects all-joker melds and later retrieval', () => {
  let game = fixture({
    ruleVersion: 'friends-v1',
    racks: [
      ['red-13-c', 'joker-a', 'joker-b', 'joker-c', 'red-10-c', 'blue-10-c'],
      ['red-1-a'], ['red-1-b'], ['red-1-c'], ['blue-1-a'],
    ],
    opened: [false, false, false, false, false],
  });
  failure(game, 'alice', actionFor(game, 'alice', [['joker-a', 'joker-b', 'joker-c']]), /普通牌/);
  game = success(game, 'alice', actionFor(game, 'alice', [['red-13-c', 'joker-a', 'joker-b', 'joker-c']]));
  assert.equal(game.tileCount, 159);
  assert.equal(game.players[0].opened, true);
  assert.equal(game.board[0].length, 4);
  for (const person of people.slice(1, 5)) game = success(game, person.id, { type: 'draw' });
  failure(game, 'alice', {
    type: 'submit',
    boardIds: [['red-13-c', 'joker-a', 'joker-b'], ['red-10-c', 'blue-10-c', 'joker-c']],
    rackIds: [],
  }, /锁定/);
});

test('test-only explicit deck overrides validate card counts without altering normal player thresholds', () => {
  const three = teachingGame(2, { copies: 3, jokerCount: 3 });
  assert.equal(three.tileCount, 159);
  assert.equal(three.pool.length, 131);
  const fourJokers = teachingGame(2, { copies: 2, jokerCount: 4 });
  assert.equal(fourJokers.tileCount, 108);
  assert.equal(allTiles(fourJokers).filter((tile) => tile.joker).length, 4);
  assert.throws(() => teachingGame(2, { copies: 4 }), /2或3/);
  assert.throws(() => teachingGame(2, { jokerCount: 5 }), /鬼牌/);
  assert.equal(teachingGame(2).tileCount, 106);
  assert.equal(teachingGame(5).tileCount, 159);
});

test('seven players must all pass an empty three-copy pool before blocked settlement', () => {
  let game = teachingGame(7);
  const deck = allTiles(game);
  game.pool = [];
  game.players.forEach((player, index) => { player.rack = deck.filter((_, tileIndex) => tileIndex % 7 === index); });
  for (let index = 0; index < 7; index += 1) {
    game = success(game, people[index].id, { type: 'pass' });
    assert.equal(game.status, index === 6 ? 'finished' : 'playing');
    assert.equal(game.consecutivePasses, index + 1);
  }
  assert.equal(game.result.reason, 'blocked');
  assert.equal(game.result.scores.length, 7);
});

test('the server saves unordered 6/7/9/8 submissions and legacy table runs in ascending order', () => {
  const game = fixture({
    racks: [['red-6-a', 'red-7-a', 'red-9-a', 'red-8-a', 'black-2-a'], ['orange-1-a']],
    board: [['blue-9-a', 'blue-7-a', 'blue-8-a']], opened: [false, false],
  });
  const action = actionFor(game, 'alice', [['red-6-a', 'red-7-a', 'red-9-a', 'red-8-a']]);
  const original = structuredClone(action);
  const after = success(game, 'alice', action);
  assert.deepEqual(after.board[0].map((item) => item.value), [7, 8, 9]);
  assert.deepEqual(after.board[1].map((item) => item.value), [6, 7, 8, 9]);
  assert.deepEqual(action, original, 'client ID arrays must not be modified');
  assert.equal(after.players[0].opened, true);
  assert.deepEqual(privateView(after, 'bob').board[1].map((item) => item.value), [6, 7, 8, 9]);
});

test('server joker-run normalization keeps exact represented order and physical ownership', () => {
  const game = fixture({
    racks: [['red-9-a', 'joker-a', 'red-6-a', 'red-8-a', 'black-2-a'], ['orange-1-a']],
    opened: [false, false],
  });
  const after = success(game, 'alice', actionFor(game, 'alice', [['red-9-a', 'joker-a', 'red-6-a', 'red-8-a']]));
  assert.deepEqual(after.board[0].map((item) => item.id), ['red-6-a', 'joker-a', 'red-8-a', 'red-9-a']);
  assert.equal(after.board[0][1].value, 1);
  assert.deepEqual(after.players[1].rack, game.players[1].rack);
  assert.deepEqual(after.pool, game.pool);
});

test('five-player submissions normalize three-joker c-copy runs using the configured joker limit', () => {
  const game = fixture({
    racks: [
      ['joker-b', 'joker-c', 'red-10-c', 'joker-a', 'black-2-c'],
      ['red-1-a'], ['red-1-b'], ['red-1-c'], ['blue-1-a'],
    ],
    opened: [false, false, false, false, false],
  });
  const after = success(game, 'alice', actionFor(game, 'alice', [['joker-b', 'joker-c', 'red-10-c', 'joker-a']]));
  assert.deepEqual(after.board[0].map((item) => item.id), ['red-10-c', 'joker-b', 'joker-c', 'joker-a']);
  assert.equal(after.tileCount, 159);
  assert.equal(after.players[0].rack.length, 1);
  assert.deepEqual(after.pool, game.pool);
});

test('friends-v2 replaces a table joker and reuses it in an existing meld with one hand tile', () => {
  const game = fixture({
    racks: [['red-7-a', 'black-2-a'], ['blue-1-a']],
    board: [['red-6-a', 'joker-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a']],
  });
  const next = success(game, 'alice', { type: 'submit',
    boardIds: [['red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a', 'joker-a']],
    rackIds: ['black-2-a'],
  });
  assert.equal(next.ruleVersion, 'friends-v2');
  assert.equal(next.turnIndex, 1);
  assert.equal(next.players[0].rack.length, 1);
  assert.equal(next.board[1].at(-1).id, 'joker-a');
  assert.equal(next.board[1].at(-1).value, 1);
  assert.equal(privateView(next, 'alice').ruleVersion, 'friends-v2');
});

test('friends-v2 permits joker extension, splitting and reuse without a matching replacement', () => {
  const extension = fixture({ racks: [['red-9-a', 'black-2-a'], ['blue-1-a']],
    board: [['red-6-a', 'joker-a', 'red-8-a']],
  });
  success(extension, 'alice', { type: 'submit',
    boardIds: [['red-6-a', 'joker-a', 'red-8-a', 'red-9-a']], rackIds: ['black-2-a'],
  });
  const splitting = fixture({ racks: [['red-7-a', 'black-2-a'], ['blue-1-a']],
    board: [['red-1-a', 'joker-a', 'red-3-a', 'red-4-a', 'red-5-a', 'red-6-a']],
  });
  success(splitting, 'alice', { type: 'submit',
    boardIds: [['red-1-a', 'joker-a', 'red-3-a'], ['red-4-a', 'red-5-a', 'red-6-a', 'red-7-a']], rackIds: ['black-2-a'],
  });
  const regrouping = fixture({ racks: [['red-6-a', 'red-7-a', 'red-8-a', 'black-2-a'], ['blue-1-a']],
    board: [[...fourIds, 'joker-a']],
  });
  const after = success(regrouping, 'alice', { type: 'submit',
    boardIds: [fourIds, ['red-6-a', 'red-7-a', 'red-8-a', 'joker-a']], rackIds: ['black-2-a'],
  });
  assert.equal(after.board[0].length, 3, 'the old group remains legal without an exact replacement');
});

test('friends-v2 rejects a loose or returned joker and a table-only turn atomically', () => {
  const game = fixture({ racks: [['red-7-a', 'black-2-a'], ['blue-1-a']],
    board: [['red-6-a', 'joker-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a']],
  });
  failure(game, 'alice', { type: 'submit',
    boardIds: [['red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a']],
    rackIds: ['black-2-a', 'joker-a'],
  }, /不能取回手牌/);
  failure(game, 'alice', { type: 'submit',
    boardIds: [['red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a'], ['joker-a']],
    rackIds: ['black-2-a'],
  }, /至少需要3张/);
  failure(game, 'alice', { type: 'submit', boardIds: game.board.toReversed().map(meld => meld.map(item => item.id)),
    rackIds: game.players[0].rack.map(item => item.id),
  }, /至少需要出一张手牌/);
});

test('friends-v2 first opening cannot rearrange existing joker melds despite 30 new points', () => {
  const game = fixture({ opened: [false, true],
    racks: [['red-7-a', 'red-10-a', 'blue-10-b', 'black-10-a', 'black-2-a'], ['blue-1-a']],
    board: [['red-6-a', 'joker-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a']],
  });
  failure(game, 'alice', { type: 'submit',
    boardIds: [['red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a', 'joker-a'],
      ['red-10-a', 'blue-10-b', 'black-10-a']], rackIds: ['black-2-a'],
  }, /首次开局/);
});

test('five-player friends-v2 rearranges multiple public jokers while all 159 tile IDs survive', () => {
  const game = fixture({
    racks: [['red-7-c', 'blue-12-c', 'black-2-c', 'joker-c'], ['red-1-a'], ['red-1-b'], ['red-1-c'], ['blue-1-a']],
    board: [['red-6-c', 'joker-a', 'red-8-c'], ['blue-10-c', 'blue-11-c', 'joker-b']],
  });
  const next = success(game, 'alice', { type: 'submit',
    boardIds: [['red-6-c', 'red-7-c', 'red-8-c'], ['blue-10-c', 'blue-11-c', 'blue-12-c', 'joker-a', 'joker-b']],
    rackIds: ['black-2-c', 'joker-c'],
  });
  assert.equal(allTiles(next).length, 159);
  assert.equal(new Set(allIds(next)).size, 159);
  assert.deepEqual(next.players[0].rack.map(item => item.id), ['black-2-c', 'joker-c']);
  const serialized = JSON.stringify(privateView(next, 'alice'));
  for (const hidden of [...next.pool, ...next.players.slice(1).flatMap(player => player.rack)]) {
    assert.equal(serialized.includes(`"${hidden.id}"`), false);
  }
});

test('joker rearrangement cannot introduce another player or pool tile', () => {
  const game = fixture({ racks: [['red-7-a', 'black-2-a'], ['blue-13-a']],
    board: [['red-6-a', 'joker-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a']],
  });
  const base = { type: 'submit',
    boardIds: [['red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a', 'joker-a']],
    rackIds: ['black-2-a'],
  };
  const steal = structuredClone(base);
  steal.boardIds[1].push('blue-13-a');
  failure(game, 'alice', steal, /只能使用自己的手牌与公开桌面牌/);
  const fromPool = structuredClone(base);
  fromPool.boardIds[0].push('red-9-a');
  failure(game, 'alice', fromPool, /只能使用自己的手牌与公开桌面牌/);
});

test('a client-declared rule version cannot upgrade old games or downgrade new ones', () => {
  const old = fixture({ ruleVersion: 'friends-v1', racks: [['red-9-a', 'black-2-a'], ['blue-1-a']],
    board: [['red-6-a', 'joker-a', 'red-8-a']],
  });
  const action = { type: 'submit', ruleVersion: 'friends-v2',
    boardIds: [['red-6-a', 'joker-a', 'red-8-a', 'red-9-a']], rackIds: ['black-2-a'],
  };
  failure(old, 'alice', action, /锁定/);
  const drawn = success(old, 'alice', { type: 'draw', ruleVersion: 'friends-v2' });
  assert.equal(drawn.ruleVersion, 'friends-v1', 'copying after any old-game action must retain its version');
  const current = structuredClone(old);
  current.ruleVersion = 'friends-v2';
  const next = success(current, 'alice', { ...action, ruleVersion: 'friends-v1' });
  assert.equal(next.ruleVersion, 'friends-v2');
  const unsupported = structuredClone(current);
  unsupported.ruleVersion = 'friends-v99';
  failure(unsupported, 'alice', { type: 'draw' }, /对局状态无效/);
});

test('submitted normalized board positions commit atomically with cards and are detached across player views', () => {
  const game = teachingGame(), positions = [{ x: 0, y: 1 }];
  const action = { ...actionFor(game, 'alice', [tenIds]), boardPositions: positions };
  const next = success(game, 'alice', action);
  assert.deepEqual(next.boardPositions, [{ x: 0, y: 1 }]);
  assert.equal(game.boardPositions, null);
  positions[0].x = .9;
  const alice = privateView(next, 'alice'), bob = privateView(next, 'bob');
  assert.deepEqual(alice.boardPositions, [{ x: 0, y: 1 }]);
  assert.deepEqual(bob.boardPositions, alice.boardPositions);
  alice.boardPositions[0].y = .3; alice.board[0][0].value = 99;
  assert.deepEqual(next.boardPositions, [{ x: 0, y: 1 }]);
  assert.equal(bob.board[0][0].value, 10);
  assert.equal(gameProblem(next), null);
});

test('old clients retain exact physical meld locations when reordering while new melds use automatic layout', () => {
  const game = fixture({ racks: [[...tenIds, 'black-2-a'], ['red-1-a']],
    board: [['red-4-a', 'red-5-a', 'red-6-a'], fourIds] });
  game.boardPositions = [{ x: .15, y: .25 }, { x: .75, y: .85 }];
  const next = success(game, 'alice', { type: 'submit',
    boardIds: [fourIds.toReversed(), ['red-6-a', 'red-4-a', 'red-5-a'], tenIds], rackIds: ['black-2-a'] });
  assert.deepEqual(next.boardPositions, [{ x: .75, y: .85 }, { x: .15, y: .25 }, null]);
  assert.deepEqual(next.board[1].map(({ id }) => id), ['red-4-a', 'red-5-a', 'red-6-a']);
  const changed = fixture({ racks: [['red-7-a', 'black-2-a'], ['red-1-a']], board: [['red-4-a', 'red-5-a', 'red-6-a']] });
  changed.boardPositions = [{ x: .2, y: .4 }];
  const extended = success(changed, 'alice', { type: 'submit',
    boardIds: [['red-4-a', 'red-5-a', 'red-6-a', 'red-7-a']], rackIds: ['black-2-a'] });
  assert.equal(extended.boardPositions, null, 'changed physical group does not silently inherit an unrelated position');
});

test('legacy clients omitting layout on draw and empty-pool pass preserve detached official positions', () => {
  const game = fixture({ racks: [['red-7-a', 'black-2-a'], ['red-1-a']], board: [['red-4-a', 'red-5-a', 'red-6-a']] });
  game.boardPositions = [{ x: .2, y: .4 }];
  const drawn = success(game, 'alice', { type: 'draw' });
  assert.deepEqual(drawn.boardPositions, game.boardPositions);
  drawn.boardPositions[0].x = .8;
  assert.equal(game.boardPositions[0].x, .2);
  const empty = fixture({ racks: [['red-7-a', 'black-2-a'], ['red-1-a']], board: [['red-4-a', 'red-5-a', 'red-6-a']], emptyPool: true });
  empty.boardPositions = [{ x: .2, y: .4 }];
  const passed = success(empty, 'alice', { type: 'pass' });
  assert.deepEqual(passed.boardPositions, empty.boardPositions);
});

test('draw and pass save current public geometry with the same frozen v1, v2 and v3 card rules', () => {
  for (const ruleVersion of ['friends-v1', 'friends-v2', 'friends-v3']) {
    const jokerConfig = ruleVersion === 'friends-v3' ? { normal: 2, mirror: 1, colorChange: 0, double: 0 } : undefined;
    const game = fixture({ racks: [['red-7-a', 'black-2-a'], ['red-1-a']], board: [['red-4-a', 'red-5-a', 'red-6-a']], ruleVersion, jokerConfig });
    game.boardPositions = [{ x: .2, y: .4 }];
    const positions = [{ x: .9, y: .1 }], firstPoolTile = game.pool[0].id;
    const drawn = success(game, 'alice', { type: 'draw', boardPositions: positions });
    assert.deepEqual(drawn.boardPositions, positions); assert.equal(drawn.players[0].rack.at(-1).id, firstPoolTile);
    assert.equal(drawn.pool.length, game.pool.length - 1); assert.deepEqual(drawn.board, game.board);
    assert.equal(drawn.ruleVersion, ruleVersion); assert.deepEqual(drawn.jokerConfig, game.jokerConfig);
    positions[0].x = .6; assert.equal(drawn.boardPositions[0].x, .9);
    const empty = fixture({ racks: [['red-7-a', 'black-2-a'], ['red-1-a']], board: [['red-4-a', 'red-5-a', 'red-6-a']], emptyPool: true, ruleVersion, jokerConfig });
    empty.boardPositions = [{ x: .2, y: .4 }];
    const passed = success(empty, 'alice', { type: 'pass', boardPositions: null });
    assert.equal(passed.boardPositions, null); assert.deepEqual(passed.board, empty.board);
    assert.deepEqual(passed.players.map(player => player.rack), empty.players.map(player => player.rack));
    assert.equal(passed.ruleVersion, ruleVersion); assert.deepEqual(passed.jokerConfig, empty.jokerConfig);
  }
});

test('invalid draw and pass geometry cannot consume a tile, advance a turn, leak metadata or grant another player a move', () => {
  const make = emptyPool => fixture({ racks: [['red-7-a', 'black-2-a'], ['red-1-a']], board: [['red-4-a', 'red-5-a', 'red-6-a']], emptyPool });
  const sparse = new Array(1), extended = [{ x: .2, y: .3 }]; extended.secret = 'hidden';
  const symbol = { x: .2, y: .3 }; symbol[Symbol('private')] = 'hidden';
  const invalid = [undefined, {}, [], [{ x: .2, y: .3 }, null], sparse, extended,
    [{ x: NaN, y: .3 }], [{ x: Infinity, y: .3 }], [{ x: -.1, y: .3 }], [{ x: .2, y: 1.01 }],
    [{ x: '.2', y: .3 }], [{ x: .2 }], [{ x: .2, y: .3, rack: ['red-7-a'] }], [symbol]];
  for (const type of ['draw', 'pass']) {
    const game = make(type === 'pass'); game.boardPositions = [{ x: .1, y: .2 }];
    for (const boardPositions of invalid) failure(game, 'alice', { type, boardPositions }, /位置|坐标/);
    const action = { type, boardPositions: [{ x: .9, y: .8 }] };
    failure(game, 'bob', action, /没轮到/); failure(game, 'spectator', action, /不在/);
  }
});

test('the last empty-pool pass saves its final public layout together with blocked settlement', () => {
  const game = fixture({ racks: [['red-7-a', 'black-2-a'], ['red-1-a']], board: [['red-4-a', 'red-5-a', 'red-6-a']], emptyPool: true });
  const once = success(game, 'alice', { type: 'pass', boardPositions: [{ x: .4, y: .5 }] });
  assert.equal(once.status, 'playing');
  const finished = success(once, 'bob', { type: 'pass', boardPositions: [{ x: 1, y: 0 }] });
  assert.equal(finished.status, 'finished'); assert.equal(finished.result.reason, 'blocked');
  assert.deepEqual(finished.boardPositions, [{ x: 1, y: 0 }]); assert.deepEqual(finished.board, game.board);
  assert.deepEqual(spectatorView(finished).boardPositions, finished.boardPositions);
});

test('legacy snapshots without positions read as automatic layout and explicit null clears old positions on a valid turn', () => {
  const legacy = teachingGame(); delete legacy.boardPositions;
  assert.equal(gameProblem(legacy), null);
  assert.equal(privateView(legacy, 'alice').boardPositions, null);
  assert.equal(spectatorView(legacy).boardPositions, null);
  assert.equal(success(legacy, 'alice', { type: 'draw' }).boardPositions, null);
  const game = fixture({ racks: [[...tenIds, 'black-2-a'], ['red-1-a']], board: [fourIds] });
  game.boardPositions = [{ x: .2, y: .4 }];
  const next = success(game, 'alice', { ...actionFor(game, 'alice', [tenIds]), boardPositions: null });
  assert.equal(next.boardPositions, null);
  const mixed = success(game, 'alice', { ...actionFor(game, 'alice', [tenIds]), boardPositions: [null, { x: .4, y: .7 }] });
  assert.deepEqual(mixed.boardPositions, [null, { x: .4, y: .7 }]);
});

test('layout submission rejects wrong group counts, sparse arrays, nonfinite coordinates and arbitrary hidden metadata atomically', () => {
  const game = teachingGame(), action = actionFor(game, 'alice', [tenIds]);
  const sparse = new Array(1), extended = [{ x: .2, y: .3 }]; extended.extra = 'secret';
  const symbol = { x: .2, y: .3 }; symbol[Symbol('private')] = 'secret';
  const invalid = [undefined, {}, [], [{ x: .2, y: .3 }, { x: .1, y: .1 }], sparse, extended,
    [{ x: NaN, y: .3 }], [{ x: Infinity, y: .3 }], [{ x: -.1, y: .3 }], [{ x: .2, y: 1.01 }],
    [{ x: '.2', y: .3 }], [{ x: .2 }], [{ x: .2, y: .3, id: 'joker-a' }], [symbol],
    [Object.create({ x: .2, y: .3 })]];
  for (const boardPositions of invalid) failure(game, 'alice', { ...action, boardPositions }, /位置|坐标/);
  const malformedCards = { ...action, rackIds: action.rackIds.slice(1), boardPositions: [{ x: .2, y: .3 }] };
  failure(game, 'alice', malformedCards, /丢失/);
  assert.equal(game.boardPositions, null);
});

test('restored official layouts are strictly validated and cannot carry private properties or wrong group associations', () => {
  const base = fixture({ racks: [['red-7-a', 'black-2-a'], ['red-1-a']], board: [['red-4-a', 'red-5-a', 'red-6-a']] });
  for (const positions of [{ 'joker-a': { x: .2, y: .3 } }, [], [{ x: .2, y: .3, rack: ['joker-a'] }], [{ x: 2, y: .3 }]]) {
    const game = structuredClone(base); game.boardPositions = positions;
    assert.match(gameProblem(game), /位置|坐标/);
    assert.throws(() => privateView(game, 'alice'), /位置|坐标/);
    assert.throws(() => spectatorView(game), /位置|坐标/);
    failure(game, 'alice', { type: 'draw' }, /位置|坐标/);
  }
});

test('spectator Rummikub projection contains only public cards and counts, never either player rack or pool identities', () => {
  const game = fixture({ racks: [['red-7-a', 'black-2-a'], ['red-1-a']], board: [['red-4-a', 'red-5-a', 'red-6-a']] });
  game.boardPositions = [{ x: .2, y: .4 }]; game.arbitrarySecret = 'secret';
  const view = spectatorView(game);
  for (const field of ['rack', 'pool', 'playerId', 'opened', 'arbitrarySecret']) assert.equal(Object.hasOwn(view, field), false);
  assert.ok(view.players.every((player) => !Object.hasOwn(player, 'rack') && typeof player.rackCount === 'number'));
  const text = JSON.stringify(view);
  for (const tile of [...game.pool, ...game.players.flatMap(({ rack }) => rack)]) assert.equal(text.includes(`"${tile.id}"`), false);
  const before = structuredClone(game); view.boardPositions[0].x = .9; view.board[0][0].value = 99; view.players[0].name = 'changed';
  assert.deepEqual(game, before);
});
