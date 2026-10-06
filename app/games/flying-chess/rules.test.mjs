import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_TYPE, RULE_VERSION, STATE_VERSION, createGame, applyRoll, applyMove,
  applyTimeout, gameProblem, validateGame } from './rules.mjs';
import { ART_VERSION, BOARD_VERSION } from './board.mjs';
import { legalPlaneIds, previewMove } from './routes.mjs';
import { PLANE_COMPLETION_DICE, PLANE_COMPLETION_PROGRESS, completeFirstPlayerScript } from './fixtures/full-game.mjs';

const ids = ['member-a', 'member-b', 'member-c', 'member-d'];
const create = (count = 2, firstPlayerIndex = 0) => createGame(ids.slice(0, count), { firstPlayerIndex });
const copy = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function successful(result) {
  assert.equal(result.ok, true, result.error);
  assert.equal(gameProblem(result.state), null);
  assert.equal(validateGame(result.state), true);
  return result.state;
}
function roll(game, die, playerId = game.turnPlayerId) { return successful(applyRoll(game, playerId, die)); }
function move(game, planeId) { return successful(applyMove(game, game.turnPlayerId, { rollId: game.rollId, planeId })); }
function syntheticPending(count, currentIndex, die, changes) {
  const game = roll(create(count, currentIndex), 6);
  // Isolated middle-game positions need prior movement capacity. These generous
  // counters are a fixture, not a claim that a complete history was replayed.
  game.revision = 200; game.rollId = 120; game.round = count * 10 + 1;
  game.lastAction.rollId = game.rollId; game.lastAction.round = game.round;
  for (const plane of game.planes) plane.progress = changes[plane.id] ?? -2;
  game.die = die;
  game.legalPlaneIds = legalPlaneIds(game.planes, game.players[currentIndex].side, die);
  game.lastAction.die = die; game.lastAction.legalPlaneIds = [...game.legalPlaneIds];
  assert.equal(gameProblem(game), null);
  return game;
}

for (const [count, sides] of [[2, ['red', 'yellow']], [3, ['red', 'blue', 'yellow']], [4, ['red', 'blue', 'yellow', 'green']]]) {
  for (let first = 0; first < count; first += 1) {
    test(`${count} players, first ${first}: explicit side order and all entities remain fixed`, () => {
      const playerIds = ids.slice(0, count), options = { firstPlayerIndex: first };
      const game = createGame(freeze(playerIds), freeze(options));
      assert.equal(game.version, STATE_VERSION);
      assert.equal(game.gameType, GAME_TYPE);
      assert.equal(game.ruleVersion, RULE_VERSION);
      assert.equal(game.boardVersion, BOARD_VERSION);
      assert.equal(game.artVersion, ART_VERSION);
      assert.deepEqual(game.players.map(player => player.side), sides);
      assert.equal(game.turnIndex, first); assert.equal(game.turnPlayerId, ids[first]);
      assert.equal(game.stage, 'await-roll'); assert.equal(game.round, 1);
      assert.equal(game.rollId, 0); assert.equal(game.revision, 0);
      assert.equal(game.planes.length, count * 4);
      assert.equal(game.planes.every(plane => plane.progress === -2), true);
      assert.equal(gameProblem(game), null);
      assert.equal(game.planes.some(plane => !sides.includes(plane.side)), false);
    });

    test(`${count} players, first ${first}: full fixed dice script wins with no invented ranks or hand scores`, () => {
      let game = create(count, first), rolls = 0, moves = 0, passes = 0;
      const side = game.players[first].side, initialEntities = game.planes.map(({ id, side, number }) => ({ id, side, number }));
      const observed = Array.from({ length: 4 }, () => []);
      for (const step of completeFirstPlayerScript(ids.slice(0, count), first)) {
        assert.equal(game.turnPlayerId, step.playerId);
        const beforeRoll = game, before = copy(game), currentRound = game.round;
        freeze(beforeRoll);
        game = roll(game, step.die); rolls += 1;
        assert.deepEqual(beforeRoll, before);
        if (step.number === null) {
          passes += 1;
          assert.equal(game.stage, 'await-roll'); assert.equal(game.lastAction.outcome, 'no-move');
          assert.equal(game.lastAction.die, 1); assert.equal(game.die, null);
          assert.equal(game.round, currentRound + 1);
          continue;
        }
        assert.equal(game.stage, 'await-move');
        assert.equal(game.round, currentRound); assert.equal(game.lastAction.die, step.die);
        const planeId = `${side}-${step.number}`, beforeMove = game, snapshot = copy(game);
        freeze(beforeMove); game = move(beforeMove, planeId); moves += 1;
        assert.deepEqual(beforeMove, snapshot);
        observed[step.number - 1].push(game.planes.find(plane => plane.id === planeId).progress);
        assert.equal(game.round, currentRound + (step.die === 6 ? 0 : 1));
      }
      assert.deepEqual(observed, Array.from({ length: 4 }, () => [...PLANE_COMPLETION_PROGRESS]));
      assert.equal(moves, 28); assert.equal(passes, 20 * (count - 1));
      assert.equal(rolls, moves + passes); assert.equal(game.rollId, rolls);
      assert.equal(game.revision, rolls + moves); assert.equal(game.round, 1 + 20 * count);
      assert.equal(game.status, 'finished'); assert.equal(game.stage, 'finished');
      assert.equal(game.lastAction.die, 6); assert.equal(game.lastAction.outcome, 'finished');
      assert.equal(game.die, null); assert.deepEqual(game.legalPlaneIds, []);
      assert.deepEqual(game.result, { reason: 'all-planes-finished', winnerIds: [ids[first]], tie: false,
        completedCounts: ids.slice(0, count).map((playerId, index) => ({ playerId, completed: index === first ? 4 : 0 })) });
      assert.deepEqual(game.planes.map(({ id, side, number }) => ({ id, side, number })), initialEntities);
      assert.equal(Object.hasOwn(game.result, 'scores'), false);
      assert.equal(Object.hasOwn(game.result, 'ranks'), false);
      assert.equal(applyRoll(game, game.turnPlayerId, 6).ok, false);
      assert.equal(applyMove(game, game.turnPlayerId, { rollId: game.rollId, planeId: `${side}-4` }).ok, false);
      assert.equal(applyTimeout(game).ok, false);
      const restored = JSON.parse(JSON.stringify(game));
      assert.equal(gameProblem(restored), null);
    });
  }
}

test('creation rejects ambiguous first player, invalid membership and injected options', () => {
  for (const options of [undefined, null, {}, [], { firstPlayerIndex: -1 }, { firstPlayerIndex: 2 },
    { firstPlayerIndex: 0.5 }, { firstPlayerIndex: '0' }, { firstPlayerIndex: 0, randomInt: () => 0 }]) {
    assert.throws(() => createGame(ids.slice(0, 2), options), /先手/);
  }
  for (const playerIds of [null, [], ['only'], ids.concat('extra'), [ids[0], ids[0]], [ids[0], ''],
    [ids[0], ' '.repeat(2)], [ids[0], 'x'.repeat(65)], [ids[0], 'bad\u0000id'], [ids[0], { id: ids[1], name: 'same-name' }]]) {
    assert.throws(() => createGame(playerIds, { firstPlayerIndex: 0 }));
  }
});

test('a die enters a saved pending stage once; selecting and previewing cannot consume it', () => {
  const initial = freeze(create()), before = copy(initial);
  const pending = roll(initial, 6);
  assert.deepEqual(initial, before);
  assert.equal(pending.rollId, 1); assert.equal(pending.revision, 1);
  assert.equal(pending.round, 1); assert.equal(pending.turnPlayerId, ids[0]);
  assert.equal(pending.die, 6); assert.equal(pending.stage, 'await-move');
  assert.deepEqual(pending.legalPlaneIds, ['red-1', 'red-2', 'red-3', 'red-4']);
  const snapshot = copy(pending), route = previewMove(pending.planes, 'red-3', 6);
  assert.equal(route.to, -1); assert.deepEqual(pending, snapshot);
  assert.equal(Object.hasOwn(pending, 'selection'), false);
  assert.equal(Object.hasOwn(pending, 'preview'), false);
  assert.equal(applyRoll(pending, ids[0], 6).ok, false);
  const launched = move(freeze(pending), 'red-3');
  assert.equal(launched.planes.find(plane => plane.id === 'red-3').progress, -1);
  assert.equal(launched.rollId, 1); assert.equal(launched.revision, 2);
  assert.equal(launched.round, 1); assert.equal(launched.stage, 'await-roll');
  assert.equal(launched.lastAction.outcome, 'six-again');
  assert.equal(applyMove(launched, ids[0], { rollId: 1, planeId: 'red-2' }).ok, false);
});

test('each die 1–5 records inability to launch and advances exactly one turn', () => {
  for (const die of [1, 2, 3, 4, 5]) {
    const initial = freeze(create(3, 2)), next = roll(initial, die);
    assert.equal(next.rollId, 1); assert.equal(next.revision, 1); assert.equal(next.round, 2);
    assert.equal(next.turnIndex, 0); assert.equal(next.turnPlayerId, ids[0]);
    assert.equal(next.stage, 'await-roll'); assert.equal(next.die, null);
    assert.deepEqual(next.legalPlaneIds, []);
    assert.deepEqual(next.lastAction, { type: 'roll', playerId: ids[2], round: 1, rollId: 1, die,
      legalPlaneIds: [], outcome: 'no-move', nextPlayerId: ids[0] });
    assert.equal(next.planes.every(plane => plane.progress === -2), true);
  }
});

test('three or more sixes preserve one turn and do not penalize earlier launched planes', () => {
  let game = create();
  for (let number = 1; number <= 4; number += 1) {
    game = move(roll(game, 6), `red-${number}`);
    assert.equal(game.turnPlayerId, ids[0]); assert.equal(game.round, 1);
    assert.equal(game.rollId, number); assert.equal(game.revision, number * 2);
    assert.equal(game.planes.filter(plane => plane.side === 'red' && plane.progress === -1).length, number);
  }
  game = move(roll(game, 6), 'red-1');
  assert.equal(game.planes.find(plane => plane.id === 'red-1').progress, 9);
  assert.deepEqual(game.planes.filter(plane => plane.side === 'red').map(plane => plane.progress), [9, -1, -1, -1]);
  assert.equal(game.round, 1); assert.equal(game.lastAction.outcome, 'six-again');
});

test('a later die refuses an earlier rollId and cannot move another owner or completed plane', () => {
  let game = move(roll(create(), 6), 'red-1');
  game = roll(game, 6); const before = copy(freeze(game));
  for (const action of [{ rollId: 1, planeId: 'red-1' }, { rollId: 2, planeId: 'yellow-1' },
    { rollId: 2, planeId: 'unknown' }, { rollId: 2, planeId: 'red-1', route: {} }, null]) {
    const result = applyMove(game, ids[0], action);
    assert.equal(result.ok, false); assert.equal(Object.hasOwn(result, 'state'), false);
    assert.deepEqual(game, before);
  }
  assert.equal(applyMove(game, ids[1], { rollId: 2, planeId: 'red-1' }).ok, false);
  assert.equal(applyMove(game, 'observer', { rollId: 2, planeId: 'red-1' }).ok, false);
});

test('invalid dice, wrong turns, nonmembers and stage mismatches fail without changing state', () => {
  const game = freeze(create()), snapshot = copy(game);
  for (const die of [0, 7, 2.5, '6', null, undefined, NaN, Infinity]) assert.equal(applyRoll(game, ids[0], die).ok, false);
  assert.equal(applyRoll(game, ids[1], 6).ok, false);
  assert.equal(applyRoll(game, 'not-a-member', 6).ok, false);
  assert.equal(applyMove(game, ids[0], { rollId: 1, planeId: 'red-1' }).ok, false);
  assert.deepEqual(game, snapshot);
});

for (const [sideIndex, side] of ['red', 'blue', 'yellow', 'green'].entries()) {
  test(`${side}: turn core shares jump-then-fly route and captures each actual landing`, () => {
    const sides = ['red', 'blue', 'yellow', 'green'];
    const enemies = [1, 2, 3].map(offset => sides[(sideIndex + offset) % 4]);
    const game = syntheticPending(4, sideIndex, 2, { [`${side}-1`]: 11,
      [`${enemies[0]}-1`]: 0, [`${enemies[1]}-1`]: 43, [`${enemies[2]}-1`]: 42,
      [`${enemies[1]}-2`]: 52 });
    const snapshot = copy(freeze(game)), next = move(game, `${side}-1`);
    assert.deepEqual(game, snapshot);
    assert.deepEqual(next.lastAction.route.segments.map(segment => segment.kind), ['walk', 'jump', 'fly']);
    assert.deepEqual(next.lastAction.route.landings.map(landing => landing.progress), [13, 17, 29]);
    assert.deepEqual(next.lastAction.route.capturedIds, enemies.map(enemy => `${enemy}-1`));
    assert.equal(next.planes.find(plane => plane.id === `${enemies[1]}-2`).progress, 52);
    assert.equal(next.turnPlayerId, ids[(sideIndex + 1) % 4]); assert.equal(next.round, game.round + 1);
    assert.equal(next.revision, game.revision + 1); assert.equal(next.rollId, game.rollId);
  });

  test(`${side}: direct fly then jump remains distinct, with completion and bounce safe at home`, () => {
    const fly = move(syntheticPending(4, sideIndex, 2, { [`${side}-1`]: 15 }), `${side}-1`);
    assert.deepEqual(fly.lastAction.route.segments.map(segment => segment.kind), ['walk', 'fly', 'jump']);
    assert.equal(fly.lastAction.route.to, 33);
    const exact = move(syntheticPending(4, sideIndex, 2, { [`${side}-1`]: 53 }), `${side}-1`);
    assert.equal(exact.lastAction.route.finished, true); assert.equal(exact.status, 'playing');
    const bounced = move(syntheticPending(4, sideIndex, 4, { [`${side}-1`]: 53 }), `${side}-1`);
    assert.equal(bounced.lastAction.route.to, 53); assert.equal(bounced.lastAction.route.finished, false);
    assert.deepEqual(bounced.lastAction.route.segments.map(segment => segment.kind), ['walk', 'bounce']);
  });
}

test('a four-plane own stack offers all four choices; an enemy stack is captured together only on landing', () => {
  const stacked = syntheticPending(4, 0, 2, { 'red-1': 6, 'red-2': 6, 'red-3': 6, 'red-4': 6,
    'blue-1': 47, 'blue-2': 47, 'blue-3': 47, 'blue-4': 47, 'yellow-1': 33 });
  assert.deepEqual(stacked.legalPlaneIds, ['red-1', 'red-2', 'red-3', 'red-4']);
  const next = move(stacked, 'red-3');
  assert.deepEqual(next.planes.filter(plane => plane.side === 'red').map(plane => plane.progress), [6, 6, 8, 6]);
  assert.equal(next.lastAction.route.capturedIds.length, 4);
  assert.equal(next.planes.find(plane => plane.id === 'yellow-1').progress, 33);
});

test('non-six still moves an active plane while all other planes remain in hangar', () => {
  const game = syntheticPending(2, 0, 5, { 'red-2': -1 }), next = move(game, 'red-2');
  assert.equal(next.planes.find(plane => plane.id === 'red-2').progress, 4);
  assert.equal(next.lastAction.outcome, 'next-turn');
  assert.equal(next.turnIndex, 1); assert.equal(next.round, game.round + 1);
});

test('last plane finishing on six ends before reward; completed planes never become legal', () => {
  const game = syntheticPending(2, 0, 6, { 'red-1': 55, 'red-2': 55, 'red-3': 55, 'red-4': 49 });
  assert.deepEqual(game.legalPlaneIds, ['red-4']);
  assert.equal(applyMove(game, ids[0], { rollId: game.rollId, planeId: 'red-3' }).ok, false);
  const next = move(game, 'red-4');
  assert.equal(next.status, 'finished'); assert.equal(next.round, game.round);
  assert.equal(next.lastAction.outcome, 'finished'); assert.equal(next.turnPlayerId, ids[0]);
  assert.deepEqual(next.result.winnerIds, [ids[0]]);
});

test('timeout before roll switches only one player without inventing a die', () => {
  const initial = freeze(create(4, 2)), snapshot = copy(initial);
  const next = successful(applyTimeout(initial));
  assert.deepEqual(initial, snapshot); assert.equal(next.round, 2);
  assert.equal(next.turnPlayerId, ids[3]); assert.equal(next.rollId, 0);
  assert.equal(next.revision, 1); assert.equal(next.die, null);
  assert.deepEqual(next.planes, initial.planes);
  assert.deepEqual(next.lastAction, { type: 'timeout', playerId: ids[2], round: 1, rollId: 0,
    fromStage: 'await-roll', discardedDie: null, nextPlayerId: ids[3] });
});

test('timeout after a bonus roll discards pending die, retains confirmed launch, and cannot consume stale die', () => {
  const launched = move(roll(create(), 6), 'red-1');
  const pending = roll(launched, 5), snapshot = copy(freeze(pending));
  const next = successful(applyTimeout(pending));
  assert.deepEqual(pending, snapshot); assert.equal(next.round, 2);
  assert.equal(next.rollId, 2); assert.equal(next.revision, 4);
  assert.equal(next.planes.find(plane => plane.id === 'red-1').progress, -1);
  assert.equal(next.lastAction.fromStage, 'await-move'); assert.equal(next.lastAction.discardedDie, 5);
  assert.equal(next.stage, 'await-roll'); assert.deepEqual(next.legalPlaneIds, []);
  assert.equal(next.turnPlayerId, ids[1]);
  const returned = roll(next, 1), fresh = roll(returned, 6);
  assert.equal(fresh.rollId, 4);
  assert.equal(applyMove(fresh, ids[0], { rollId: 2, planeId: 'red-1' }).ok, false);
});

test('serialized await-roll, pending die, six reward, timeout and finished states preserve their exact phase', () => {
  const initial = create(3, 1), pending = roll(initial, 6), launched = move(pending, 'blue-2');
  const pendingAgain = roll(launched, 2), timedOut = successful(applyTimeout(pendingAgain));
  for (const game of [initial, pending, launched, pendingAgain, timedOut]) {
    const restored = JSON.parse(JSON.stringify(game));
    assert.deepEqual(restored, game); assert.equal(gameProblem(restored), null);
  }
  assert.equal(pendingAgain.die, 2); assert.equal(pendingAgain.rollId, 2);
  assert.deepEqual(pendingAgain.legalPlaneIds, ['blue-2']);
});

test('state validation rejects versions, material corruption, reshuffling, hidden data and enemy co-occupancy', () => {
  const game = roll(create(4), 6);
  const corruptions = [
    state => { state.version = 9; }, state => { state.gameType = 'rummikub'; },
    state => { state.ruleVersion = 'flying-chess-friends-v2'; }, state => { state.boardVersion = 'other'; },
    state => { state.artVersion = 'unknown'; }, state => { state.players[0].id = state.players[1].id; },
    state => { state.players[0].name = 'same-display-name'; }, state => { state.players[0].side = 'green'; },
    state => { state.players.reverse(); }, state => { state.planes.pop(); },
    state => { state.planes.push(copy(state.planes[0])); }, state => { state.planes[0].number = 2; },
    state => { state.planes[0].id = 'other-plane'; }, state => { state.planes[0].side = 'blue'; },
    state => { state.planes[0].progress = 56; }, state => { state.planes[0].progress = -3; },
    state => { state.planes[0].progress = 4.5; }, state => { state.planes[0].progress = '4'; },
    state => { state.planes[0].progress = 1; }, state => { state.planes[0].progress = 17; },
    state => { state.planes[0].progress = 21; },
    state => { state.planes[0].secret = 'identity-token'; }, state => { state.planes.reverse(); },
    state => { state.planes[0].progress = 4; state.planes[4].progress = 43; },
    state => { state.selection = 'red-1'; }, state => { state.futureDice = [6, 6]; },
    state => { state.players.secret = 'token'; }, state => { state.planes.secret = 'token'; },
    state => { delete state.planes[0]; }, state => { Object.setPrototypeOf(state.planes, { secret: 'token' }); },
  ];
  for (const corrupt of corruptions) {
    const state = copy(game); corrupt(state); assert.notEqual(gameProblem(state), null);
    assert.equal(validateGame(state), false); assert.equal(applyRoll(state, ids[0], 6).ok, false);
    assert.equal(applyMove(state, ids[0], { rollId: 1, planeId: 'red-1' }).ok, false);
    assert.equal(applyTimeout(state).ok, false);
  }
});

test('state validation rejects invalid counters, actor, stage and pending dice consistency', () => {
  const game = roll(create(), 6);
  const corruptions = [
    state => { state.firstPlayerIndex = 2; }, state => { state.firstPlayerIndex = 0.5; },
    state => { state.turnIndex = 1; state.turnPlayerId = ids[1]; }, state => { state.turnPlayerId = 'unknown'; },
    state => { state.round = 0; }, state => { state.round = 1.5; }, state => { state.revision = -1; },
    state => { state.rollId = 2; }, state => { state.rollId = 0; }, state => { state.stage = 'rolling'; },
    state => { state.status = 'paused'; }, state => { state.stage = 'await-roll'; },
    state => { state.die = null; }, state => { state.die = 0; }, state => { state.die = 7; },
    state => { state.legalPlaneIds = []; }, state => { state.legalPlaneIds.push('yellow-1'); },
    state => { state.legalPlaneIds[0] = 'red-2'; }, state => { state.lastAction = null; },
    state => { state.lastAction.playerId = ids[1]; }, state => { state.lastAction.round = 2; },
    state => { state.lastAction.rollId = 0; }, state => { state.lastAction.die = 5; },
    state => { state.lastAction.outcome = 'no-move'; }, state => { state.lastAction.token = 'hidden'; },
    state => { state.result = { winnerIds: [ids[0]] }; },
  ];
  for (const corrupt of corruptions) {
    const state = copy(game); corrupt(state); assert.notEqual(gameProblem(state), null);
  }
  for (const state of [null, undefined, [], {}, { ruleVersion: RULE_VERSION }, 'game']) {
    assert.equal(validateGame(state), false); assert.equal(typeof gameProblem(state), 'string');
  }
});

test('last action stores only an exact bounded route and rejects tampering or inconsistent capture results', () => {
  const game = move(syntheticPending(4, 0, 2, { 'red-1': 11, 'blue-1': 0, 'yellow-1': 43, 'green-1': 42 }), 'red-1');
  const corruptions = [
    state => { state.lastAction.route.identity = 'secret'; },
    state => { state.lastAction.route.description = 'x'.repeat(257); },
    state => { state.lastAction.route.to = 33; }, state => { state.lastAction.route.side = 'yellow'; },
    state => { state.lastAction.route.from = 55; }, state => { state.lastAction.route.segments[0].steps.push(15); },
    state => { state.lastAction.route.segments[0].extra = true; },
    state => { state.lastAction.route.segments = Array.from({ length: 4 }, () => state.lastAction.route.segments[0]); },
    state => { state.lastAction.route.landings[0].capturedIds.push('red-2'); },
    state => { state.lastAction.route.landings[0].capturedIds.push('blue-1'); },
    state => { state.lastAction.route.capturedIds = []; },
    state => { state.planes.find(plane => plane.id === 'blue-1').progress = 1; },
    state => { state.lastAction.outcome = 'six-again'; }, state => { state.lastAction.nextPlayerId = ids[0]; },
  ];
  for (const corrupt of corruptions) { const state = copy(game); corrupt(state); assert.notEqual(gameProblem(state), null); }
});

test('finished validation requires exactly one true four-plane winner, no pending die, and matching counts', () => {
  const finished = move(syntheticPending(2, 0, 6, { 'red-1': 55, 'red-2': 55, 'red-3': 55, 'red-4': 49 }), 'red-4');
  const corruptions = [
    state => { state.status = 'playing'; state.stage = 'await-roll'; state.result = null; },
    state => { state.result.winnerIds = [ids[1]]; }, state => { state.result.winnerIds = [ids[0], ids[1]]; },
    state => { state.result.tie = true; }, state => { state.result.reason = 'resigned'; },
    state => { state.result.completedCounts[0].completed = 3; }, state => { state.result.scores = [0, 0]; },
    state => { state.planes.find(plane => plane.id === 'red-1').progress = 54; },
    state => { state.planes.filter(plane => plane.side === 'yellow').forEach(plane => { plane.progress = 55; }); },
    state => { state.die = 6; }, state => { state.legalPlaneIds = ['red-4']; },
    state => { state.lastAction.outcome = 'six-again'; }, state => { state.lastAction.route.finished = false; },
  ];
  for (const corrupt of corruptions) { const state = copy(finished); corrupt(state); assert.notEqual(gameProblem(state), null); }
});

test('counter limits reject a transition instead of producing unsafe serialized integers', () => {
  const game = create();
  game.revision = Number.MAX_SAFE_INTEGER - 1;
  game.round = Number.MAX_SAFE_INTEGER - 1;
  game.turnIndex = (game.round - 1) % 2; game.turnPlayerId = ids[game.turnIndex];
  game.lastAction = { type: 'timeout', playerId: ids[1 - game.turnIndex], round: game.round - 1,
    rollId: 0, fromStage: 'await-roll', discardedDie: null, nextPlayerId: game.turnPlayerId };
  assert.equal(gameProblem(game), null);
  const snapshot = copy(freeze(game));
  assert.equal(applyRoll(game, game.turnPlayerId, 6).ok, false);
  assert.equal(applyTimeout(game).ok, false); assert.deepEqual(game, snapshot);
});

test('fixed script is a local fixture rather than a random source or persisted selection', () => {
  assert.deepEqual(PLANE_COMPLETION_DICE, [6, 5, 5, 4, 4, 4, 6]);
  const script = completeFirstPlayerScript(ids.slice(0, 2), 0);
  assert.equal(script.length, 48);
  assert.equal(script.filter(step => step.number === null).length, 20);
  assert.equal(Object.hasOwn(create(), 'randomInt'), false);
});

test('serialization key order does not change the meaning of a valid saved route', () => {
  const game = move(syntheticPending(4, 0, 2, { 'red-1': 11, 'blue-1': 0, 'yellow-1': 43, 'green-1': 42 }), 'red-1');
  function reverseKeys(value) {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  }
  const reordered = reverseKeys(game);
  assert.equal(gameProblem(reordered), null);
  assert.equal(gameProblem(JSON.parse(JSON.stringify(reordered))), null);
});

test('timeout records cannot invent a pending die when no plane could have moved', () => {
  const game = successful(applyTimeout(create()));
  game.lastAction.fromStage = 'await-move'; game.lastAction.discardedDie = 1;
  game.lastAction.rollId = 1; game.rollId = 1;
  assert.notEqual(gameProblem(game), null);
});

test('plain state fields and dense arrays exclude invisible inherited fields, accessors and symbols', () => {
  const state = create(), inherited = Object.assign(Object.create({ token: 'hidden' }), state);
  assert.notEqual(gameProblem(inherited), null);
  const accessor = create(); Object.defineProperty(accessor, 'rollId', { get: () => 0, enumerable: true });
  assert.notEqual(gameProblem(accessor), null);
  const symbols = create(); symbols.players[Symbol('secret')] = 'token';
  assert.notEqual(gameProblem(symbols), null);
  const sparse = create(); delete sparse.players[0];
  assert.notEqual(gameProblem(sparse), null);
});

test('mixed deterministic games preserve invariants through captures, serialized recovery and timeouts', () => {
  let actionCount = 0, captures = 0, bounces = 0;
  for (const count of [2, 3, 4]) {
    let game = create(count, count - 1), seed = 34561 + count;
    const nextNumber = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let index = 1; index <= 4000 && game.status === 'playing'; index += 1) {
      const before = copy(freeze(game));
      let result;
      if (index % 97 === 0) result = applyTimeout(game);
      else if (game.stage === 'await-roll') result = applyRoll(game, game.turnPlayerId, nextNumber() % 6 + 1);
      else result = applyMove(game, game.turnPlayerId,
        { rollId: game.rollId, planeId: game.legalPlaneIds[nextNumber() % game.legalPlaneIds.length] });
      const next = successful(result);
      assert.deepEqual(game, before);
      assert.equal(next.revision, game.revision + 1);
      if (next.lastAction.type === 'move') {
        captures += next.lastAction.route.capturedIds.length;
        bounces += Number(next.lastAction.route.segments.some(segment => segment.kind === 'bounce'));
      }
      game = index % 23 === 0 ? JSON.parse(JSON.stringify(next)) : next;
      assert.equal(gameProblem(game), null); actionCount += 1;
    }
    assert.equal(game.status, 'finished', `fixed mixed sequence for ${count} players should finish`);
    assert.equal(game.result.winnerIds.length, 1);
  }
  assert.ok(actionCount > 200); assert.ok(captures > 0); assert.ok(bounces > 0);
});

test('a roll-only history cannot invent a moved or completed plane even with matching legal lists', () => {
  for (const progress of [-1, 4, 53, 55]) {
    const state = roll(create(), 6);
    state.planes.find(plane => plane.id === 'red-1').progress = progress;
    state.legalPlaneIds = legalPlaneIds(state.planes, 'red', 6);
    state.lastAction.legalPlaneIds = [...state.legalPlaneIds];
    assert.match(gameProblem(state), /尚未移动/);
    assert.equal(validateGame(state), false);
    assert.equal(applyMove(state, ids[0], { rollId: state.rollId, planeId: 'red-2' }).ok, false);
    assert.equal(applyTimeout(state).ok, false);
  }
  let multipleRolls = create();
  for (const die of [1, 2, 3, 4]) multipleRolls = roll(multipleRolls, die);
  assert.equal(multipleRolls.revision, multipleRolls.rollId);
  multipleRolls.planes.find(plane => plane.side !== multipleRolls.players.find(player => player.id === multipleRolls.lastAction.playerId).side).progress = 53;
  assert.match(gameProblem(multipleRolls), /尚未移动/);
});

test('zero rolls allow timeout-only history but cannot have any plane outside hangar', () => {
  let state = create(3, 1);
  for (let index = 0; index < 6; index += 1) state = successful(applyTimeout(state));
  assert.equal(state.rollId, 0); assert.equal(state.revision, 6);
  assert.equal(gameProblem(state), null);
  for (const progress of [-1, 4, 53, 55]) {
    const damaged = copy(state); damaged.planes[0].progress = progress;
    assert.match(gameProblem(damaged), /尚未移动/);
    assert.equal(applyRoll(damaged, damaged.turnPlayerId, 6).ok, false);
    assert.equal(applyTimeout(damaged).ok, false);
  }
  const firstTimeout = successful(applyTimeout(create()));
  firstTimeout.planes[0].progress = 53;
  assert.match(gameProblem(firstTimeout), /尚未移动/);
});
