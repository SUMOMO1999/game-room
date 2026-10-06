import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlyingChessAdapter } from '../../../server/games/flying-chess/adapter.mjs';
import { requireAdapter } from '../../../server/games/adapter-contract.mjs';
import * as core from './rules.mjs';
import { previewMove } from './routes.mjs';
import { completeFirstPlayerScript } from './fixtures/full-game.mjs';

const adapter = createFlyingChessAdapter();
const seatIds = ['a', 'b', 'c', 'd'].map(character => character.repeat(32));
const people = count => seatIds.slice(0, count).map((id, index) => ({ id, name: ['甲', '乙', '丙', '丁'][index],
  ready: true, userKey: ['1', '2', '3', '4'][index].repeat(64), requests: [] }));
const waiting = (count = 2) => ({ schemaVersion: 9, gameType: 'flying-chess', phase: 'waiting',
  players: people(count), spectators: [], hostId: seatIds[0], game: null, turnClock: null });
const create = (count = 2, first = 0) => adapter.createGame(people(count), { firstPlayerIndex: first });
const checked = result => { assert.equal(result.ok, true, result.error); assert.equal(core.gameProblem(result.state), null); return result.state; };
const roll = (game, die, actor = game.turnPlayerId) => checked(adapter.applyGameAction(game, actor,
  { type: 'roll' }, { serverRandomInt: maximum => { assert.equal(maximum, 6); return die - 1; } }));
const move = (game, planeId, actor = game.turnPlayerId) => checked(adapter.applyGameAction(game, actor,
  { type: 'move', rollId: game.rollId, planeId }, { serverRandomInt: () => { throw new Error('moves must never roll'); } }));

function finish(count = 2, first = 0) {
  let game = create(count, first);
  const side = game.players[first].side;
  for (const step of completeFirstPlayerScript(seatIds.slice(0, count), first)) {
    game = roll(game, step.die, step.playerId);
    if (step.number !== null) game = move(game, `${side}-${step.number}`, step.playerId);
  }
  return game;
}

function snapshot(phase = 'playing', count = 2) {
  const room = waiting(count), game = phase === 'finished' ? finish(count) : roll(create(count), 6);
  room.phase = phase; room.game = game;
  room.matchId = 'f'.repeat(32); room.matchStartedAt = 1000;
  room.matchParticipants = room.players.map(({ id, name, userKey }) => ({ playerId: id, name, userKey }));
  room.turnClock = { version: 1, durationMs: 1_800_000, remainingMs: 1_800_000, startedAt: 1000,
    deadlineAt: 1_801_000, pausedAt: null, firstPlayerId: seatIds[0], matchId: room.matchId,
    round: game.round, playerId: game.turnPlayerId };
  if (phase === 'paused') { room.turnClock.pausedAt = 1100; room.turnClock.deadlineAt = null; room.turnClock.remainingMs = 1_799_900; }
  if (['finished', 'aborted'].includes(phase)) { room.matchEndedAt = 2000; room.turnClock = null; }
  if (phase === 'aborted') room.abortedResult = { reason: 'player-left', winnerIds: [], scores: [], tie: false, aborted: true };
  return room;
}

test('server adapter satisfies every platform policy with explicit action intents and schema9 defaults', () => {
  assert.equal(requireAdapter(adapter), adapter); assert.equal(Object.isFrozen(adapter), true);
  assert.equal(adapter.gameType, 'flying-chess'); assert.equal(adapter.minPlayers, 2); assert.equal(adapter.maxPlayers, 4);
  assert.deepEqual(adapter.ruleVersions, ['flying-chess-friends-v1']);
  assert.deepEqual(adapter.actionTypes, ['roll', 'move']); assert.equal(adapter.usesActionIntents, true);
  assert.deepEqual(adapter.actionFields('roll'), []); assert.deepEqual(adapter.actionFields('move'), ['rollId', 'planeId']);
  assert.equal(adapter.actionFields('draw'), null); assert.deepEqual(adapter.configurationFields, []);
  assert.deepEqual(adapter.roomDefaults(), { turnClock: null });
  const defaults = adapter.roomDefaults(); defaults.turnClock = 'changed';
  assert.deepEqual(adapter.roomDefaults(), { turnClock: null });
  assert.equal(adapter.turnTimeoutMs(0), 1_800_000); assert.equal(adapter.turnTimeoutMs(5000), 5000);
});

test('production first player comes only from one trusted bounded sample, not legacy/client options', () => {
  for (const count of [2, 3, 4]) {
    let samples = 0;
    const room = waiting(count), snapshot = structuredClone(room);
    const options = adapter.gameOptions(room, { firstPlayerIndex: 0, seed: 'client-seed', die: 6,
      randomInt: () => { throw new Error('must not call legacy random'); },
      serverRandomInt: maximum => { samples += 1; assert.equal(maximum, count); return count - 1; } });
    assert.deepEqual(options, { firstPlayerIndex: count - 1 }); assert.equal(samples, 1);
    assert.deepEqual(room, snapshot);
    const game = adapter.createGame(room.players, options);
    assert.equal(game.turnPlayerId, seatIds[count - 1]);
    for (const field of ['seed', 'serverRandomInt', 'randomInt', 'name', 'userKey']) assert.equal(Object.hasOwn(game, field), false);
    assert.equal(game.die, null, 'the supplied client die must not enter the initial state');
    assert.equal(game.players.every(player => Object.keys(player).length === 2), true);
  }
});

test('invalid start membership, phase or server sample rejects without mutation or client randomness', () => {
  let samples = 0;
  const trusted = { serverRandomInt: () => { samples += 1; return 0; } };
  for (const change of [room => { room.phase = 'playing'; }, room => { room.gameType = 'rummikub'; },
    room => { room.game = create(); }, room => { room.players.pop(); },
    room => { room.players[1].id = room.players[0].id; }]) {
    const room = waiting(); change(room); const before = structuredClone(room);
    assert.throws(() => adapter.gameOptions(room, trusted)); assert.deepEqual(room, before);
  }
  assert.equal(samples, 0);
  for (const source of [null, 4, () => -1, () => 2, () => 0.5, () => '0', () => { throw new Error('secret internal failure'); }]) {
    assert.throws(() => adapter.gameOptions(waiting(), { serverRandomInt: source }), /服务端随机/);
  }
});

test('default server cryptographic sampling produces a valid first index and die', () => {
  const room = waiting(4), options = adapter.gameOptions(room), game = adapter.createGame(room.players, options);
  assert.ok(Number.isInteger(options.firstPlayerIndex) && options.firstPlayerIndex >= 0 && options.firstPlayerIndex < 4);
  const next = checked(adapter.applyGameAction(game, game.turnPlayerId, { type: 'roll' }));
  assert.ok(next.lastAction.die >= 1 && next.lastAction.die <= 6);
});

for (const count of [2, 3, 4]) for (let first = 0; first < count; first += 1) {
  test(`${count} players, first ${first}: trusted fixed dice complete through real server adapter`, () => {
    let sampled = 0;
    const room = waiting(count), options = adapter.gameOptions(room, { serverRandomInt: max => { assert.equal(max, count); sampled += 1; return first; } });
    let game = adapter.createGame(room.players, options);
    const side = game.players[first].side;
    for (const step of completeFirstPlayerScript(seatIds.slice(0, count), first)) {
      const before = structuredClone(game), next = checked(adapter.applyGameAction(game, step.playerId,
        { type: 'roll', requestId: `roll-${game.rollId + 1}`, expectedRevision: game.revision },
        { serverRandomInt: max => { assert.equal(max, 6); sampled += 1; return step.die - 1; } }));
      assert.deepEqual(game, before); game = next;
      if (step.number !== null) game = move(game, `${side}-${step.number}`);
    }
    assert.equal(sampled, 1 + game.rollId); assert.equal(game.status, 'finished');
    assert.deepEqual(game.result.winnerIds, [seatIds[first]]);
    assert.equal(adapter.stateProblem(game), null);
    for (const id of seatIds.slice(0, count)) assert.deepEqual(adapter.playerResult(game.result, id),
      { outcome: id === seatIds[first] ? 'win' : 'loss', remainingPoints: null });
  });
}

test('wrong actor, corrupt game, stale stage and finished game never sample the trusted die', () => {
  let sampled = 0;
  const context = { serverRandomInt: () => { sampled += 1; return 5; } }, initial = create();
  const pending = roll(initial, 6), finished = finish();
  const corrupted = structuredClone(initial); corrupted.futureDice = [6];
  for (const [game, actor] of [[initial, 'viewer'], [initial, seatIds[1]], [pending, seatIds[0]],
    [finished, seatIds[0]], [corrupted, seatIds[0]]]) {
    const before = structuredClone(game), result = adapter.applyGameAction(game, actor, { type: 'roll' }, context);
    assert.equal(result.ok, false); assert.deepEqual(game, before);
  }
  assert.equal(sampled, 0);
});

test('safe integer exhaustion rejects a roll before random sampling', () => {
  const game = create(); game.revision = Number.MAX_SAFE_INTEGER - 1; game.round = Number.MAX_SAFE_INTEGER - 1;
  game.turnIndex = (game.round - 1) % 2; game.turnPlayerId = seatIds[game.turnIndex];
  game.lastAction = { type: 'timeout', playerId: seatIds[1 - game.turnIndex], round: game.round - 1,
    rollId: 0, fromStage: 'await-roll', discardedDie: null, nextPlayerId: game.turnPlayerId };
  assert.equal(core.gameProblem(game), null);
  let samples = 0;
  assert.equal(adapter.applyGameAction(game, game.turnPlayerId, { type: 'roll' },
    { serverRandomInt: () => { samples += 1; return 0; } }).ok, false);
  assert.equal(samples, 0);
});

test('HTTP roll fields cannot choose die, seed, random function or a game-timeout operation', () => {
  const initial = create(); let sampled = 0;
  const context = { serverRandomInt: () => { sampled += 1; return 5; } };
  for (const field of ['die', 'seed', 'randomInt', 'serverRandomInt', 'firstPlayerIndex', 'planeId', 'rollId']) {
    const action = { type: 'roll', [field]: 6 }, problem = adapter.validateAction(action);
    assert.equal(problem.status, 400); assert.equal(problem.code, 'INVALID_ACTION');
    assert.equal(adapter.applyGameAction(initial, seatIds[0], action, context).ok, false);
  }
  assert.equal(adapter.actionFields('timeout'), null);
  assert.equal(adapter.applyGameAction(initial, seatIds[0], { type: 'timeout' }, context).ok, false);
  assert.equal(sampled, 0); assert.equal(initial.rollId, 0);
});

test('only trusted bounded integer die sources are accepted and failures do not advance', () => {
  const initial = create(), before = structuredClone(initial);
  for (const source of [null, false, () => -1, () => 6, () => 2.5, () => '5', () => Promise.resolve(5),
    () => { throw new Error('private provider detail'); }]) {
    const result = adapter.applyGameAction(initial, seatIds[0], { type: 'roll' }, { serverRandomInt: source });
    assert.equal(result.ok, false); assert.match(result.error, /服务端随机/);
    assert.equal(result.error.includes('private provider detail'), false); assert.deepEqual(initial, before);
  }
});

test('move has strict payload, current roll ownership and no random sampling', () => {
  const game = roll(create(), 6);
  for (const action of [{ type: 'move', rollId: '1', planeId: 'red-1' }, { type: 'move', rollId: 0, planeId: 'red-1' },
    { type: 'move', rollId: 1, planeId: 'red-5' }, { type: 'move', rollId: 1, planeId: 'red-1', die: 6 },
    { type: 'move', rollId: 1 }, null]) assert.equal(adapter.validateAction(action)?.code, 'INVALID_ACTION');
  assert.equal(adapter.validateAction({ type: 'ready', ready: true, requestId: 'shared', expectedRevision: 0 }), null);
  assert.equal(adapter.applyGameAction(game, seatIds[0], { type: 'move', rollId: 1, planeId: 'yellow-1' }).ok, false);
  assert.equal(adapter.applyGameAction(game, seatIds[1], { type: 'move', rollId: 1, planeId: 'red-1' }).ok, false);
  const launched = move(game, 'red-2'), pending = roll(launched, 5);
  assert.equal(adapter.applyGameAction(pending, seatIds[0], { type: 'move', rollId: 1, planeId: 'red-2' }).ok, false);
  assert.equal(pending.rollId, 2); assert.equal(pending.planes.find(plane => plane.id === 'red-2').progress, -1);
});

test('current player gets bounded actionable routes while opponents and observers receive no permissions', () => {
  const game = roll(create(4), 6), current = adapter.privateView(game, seatIds[0]);
  assert.equal(current.playerId, seatIds[0]); assert.equal(current.canRoll, false);
  assert.deepEqual(current.legalPlaneIds, ['red-1', 'red-2', 'red-3', 'red-4']);
  assert.deepEqual(current.legalMoves, game.legalPlaneIds.map(id => previewMove(game.planes, id, 6)));
  for (const view of [adapter.privateView(game, seatIds[1]), adapter.spectatorView(game)]) {
    assert.equal(view.canRoll, false); assert.deepEqual(view.legalPlaneIds, []); assert.deepEqual(view.legalMoves, []);
    assert.deepEqual(view.lastAction.legalPlaneIds, []);
    assert.deepEqual(view.planes, game.planes); assert.equal(view.die, 6); assert.equal(view.stage, 'await-move');
    assert.equal(Object.hasOwn(view, 'rack'), false); assert.equal(Object.hasOwn(view, 'pool'), false);
  }
  const spectator = adapter.spectatorView(game); assert.equal(Object.hasOwn(spectator, 'playerId'), false);
  assert.throws(() => adapter.privateView(game, 'outsider'), /不是本局/);
  current.planes[0].progress = 55; current.players[0].side = 'green'; current.legalMoves[0].segments[0].steps[0] = 55;
  assert.equal(game.planes[0].progress, -2); assert.equal(game.players[0].side, 'red');
  assert.equal(previewMove(game.planes, 'red-1', 6).to, -1);
});

test('projection phase context disables all executable fields without changing core status or positions', () => {
  for (const game of [create(), roll(create(), 6)]) for (const phase of ['paused', 'aborted', 'waiting', 'finished']) {
    const before = structuredClone(game), view = adapter.privateView(game, seatIds[0], { phase });
    assert.equal(view.canRoll, false); assert.deepEqual(view.legalPlaneIds, []); assert.deepEqual(view.legalMoves, []);
    assert.equal(view.status, 'playing'); assert.deepEqual(game, before);
  }
  assert.equal(adapter.privateView(create(), seatIds[0]).canRoll, true);
  assert.equal(adapter.privateView(finish(), seatIds[0]).canRoll, false);
});

test('corrupt or identity-polluted core state is rejected before any projection', () => {
  const game = create(); game.accessToken = 'must-not-leak';
  assert.notEqual(adapter.stateProblem(game), null);
  assert.throws(() => adapter.privateView(game, seatIds[0])); assert.throws(() => adapter.spectatorView(game));
});

test('waiting side assignments follow core allocation and no side cache or first player is saved', () => {
  const expectations = { 1: ['red'], 2: ['red', 'yellow'], 3: ['red', 'blue', 'yellow'], 4: ['red', 'blue', 'yellow', 'green'] };
  for (const count of [1, 2, 3, 4]) {
    const room = waiting(count), before = structuredClone(room), view = adapter.roomView(room);
    assert.deepEqual(view, { sideAssignments: seatIds.slice(0, count).map((playerId, index) => ({ playerId, side: expectations[count][index] })) });
    assert.deepEqual(room, before); assert.equal(room.game, null); assert.equal(Object.hasOwn(room, 'firstPlayerIndex'), false);
  }
  const room = snapshot('aborted'); room.players = room.players.slice(1);
  assert.deepEqual(adapter.roomView(room).sideAssignments, [{ playerId: seatIds[0], side: 'red' }, { playerId: seatIds[1], side: 'yellow' }]);
});

test('playersChanged clears all waiting readiness only, without rewriting game or spectator state', () => {
  const room = waiting(3); room.spectators.push({ id: 's'.repeat(32), name: '看客', ready: false });
  const beforeSpectators = structuredClone(room.spectators);
  adapter.playersChanged(room); assert.equal(room.players.every(player => player.ready === false), true);
  assert.deepEqual(room.spectators, beforeSpectators); assert.equal(room.game, null);
  const playing = snapshot(), before = structuredClone(playing);
  adapter.playersChanged(playing); assert.deepEqual(playing, before);
});

test('room settings are explicitly unsupported and no poker/army configuration is forwarded', () => {
  assert.deepEqual(adapter.configurationSupportProblem(), { status: 400, code: 'CONFIG_UNSUPPORTED', message: '飞行棋首版没有可更改的游戏设置。' });
  assert.deepEqual(adapter.configure(waiting(), { jokerConfig: {} }), { problem: adapter.configurationSupportProblem() });
  const room = waiting(2); room.jokerConfig = {};
  assert.match(adapter.roomStateProblem(room, true), /设置/);
  for (const field of ['assignment', 'copies', 'jokerCount', 'boardPositions']) {
    const modified = waiting(2); modified[field] = null; assert.notEqual(adapter.roomStateProblem(modified, true), null);
  }
});

test('schema9 alone is accepted with explicit flying type, supported rule and waiting clock slot', () => {
  assert.equal(adapter.snapshotSchema(waiting()), 9);
  assert.equal(adapter.snapshotProblem(waiting()), false); assert.equal(adapter.snapshotProblem(snapshot()), false);
  for (const change of [room => { room.schemaVersion = 8; }, room => { room.gameType = 'army-flip'; },
    room => { delete room.turnClock; }, room => { room.turnClock = {}; }]) {
    const room = waiting(); change(room); assert.equal(adapter.snapshotProblem(room), true);
  }
  const wrongRule = snapshot(); wrongRule.game.ruleVersion = 'army-flip-v3';
  assert.equal(adapter.snapshotProblem(wrongRule), true);
});

test('all five schema9 lifecycle phases preserve valid member mapping and original participants', () => {
  for (const count of [2, 3, 4]) {
    assert.equal(adapter.roomStateProblem(waiting(count), true), null);
    for (const phase of ['playing', 'paused', 'finished', 'aborted']) {
      const room = snapshot(phase, count), before = structuredClone(room);
      assert.equal(adapter.roomStateProblem(room, true), null, phase); assert.deepEqual(room, before);
      assert.equal(adapter.roomStateProblem(JSON.parse(JSON.stringify(room)), true), null);
    }
  }
  assert.equal(adapter.roomStateProblem(waiting(1), true), null);
  for (const phase of ['finished', 'aborted']) {
    const room = snapshot(phase, 4); room.players = [room.players[1], room.players[3]];
    room.hostId = room.players[0].id;
    assert.equal(adapter.roomStateProblem(room, true), null);
  }
});

test('waiting rejects game leftovers, partial type/roles and previously started match metadata', () => {
  const corruptions = [room => { room.game = create(); }, room => { room.phase = 'unknown'; },
    room => { room.matchId = 'f'.repeat(32); }, room => { room.matchParticipants = []; },
    room => { room.matchEndedAt = 1000; }, room => { room.gameType = 'rummikub'; },
    room => { delete room.spectators; }, room => { room.spectators.push(room.players[0]); }];
  for (const change of corruptions) { const room = waiting(); change(room); assert.notEqual(adapter.roomStateProblem(room, true), null); }
  assert.notEqual(adapter.roomStateProblem(waiting(), false), null);
});

test('started room roster and participants cannot swap ownership, names, users, order or spectators', () => {
  const corruptions = [room => { room.players.reverse(); }, room => { room.players.pop(); },
    room => { room.players[0].id = 'stranger'; }, room => { room.spectators.push(room.players[0]); },
    room => { room.matchParticipants.reverse(); }, room => { room.matchParticipants.pop(); },
    room => { room.matchParticipants[0].name = '同名认领'; }, room => { room.matchParticipants[0].userKey = '9'.repeat(64); },
    room => { room.matchParticipants[0].playerId = room.matchParticipants[1].playerId; },
    room => { room.matchParticipants[0].accessToken = 'private'; },
    room => { delete room.matchId; }, room => { room.matchStartedAt = null; },
    room => { room.matchEndedAt = 2000; }, room => { room.game.status = 'finished'; }];
  for (const phase of ['playing', 'paused']) for (const change of corruptions) {
    const room = snapshot(phase); change(room); assert.notEqual(adapter.roomStateProblem(room, true), null, `${phase}: ${change}`);
  }
  const anonymous = snapshot();
  for (const member of anonymous.players) delete member.userKey;
  for (const member of anonymous.matchParticipants) delete member.userKey;
  assert.equal(adapter.roomStateProblem(anonymous, true), null);
});

test('finished/aborted can retain departed participants but cannot add or reorder replacement players', () => {
  for (const phase of ['finished', 'aborted']) {
    const room = snapshot(phase, 3); room.players = room.players.slice(1);
    assert.equal(adapter.roomStateProblem(room, true), null);
    const extra = structuredClone(room); extra.players.push({ ...people(4)[3] });
    assert.notEqual(adapter.roomStateProblem(extra, true), null);
    const swapped = structuredClone(room); swapped.players.reverse(); assert.notEqual(adapter.roomStateProblem(swapped, true), null);
    const terminalClock = structuredClone(room); terminalClock.turnClock = {}; assert.notEqual(adapter.roomStateProblem(terminalClock, true), null);
    const noEnd = structuredClone(room); delete noEnd.matchEndedAt; assert.notEqual(adapter.roomStateProblem(noEnd, true), null);
  }
});

test('departed participant identity keys remain unique in finished and aborted match history', () => {
  for (const phase of ['finished', 'aborted']) {
    const room = snapshot(phase, 4);
    room.players = room.players.slice(2);
    room.hostId = room.players[0].id;
    assert.equal(adapter.roomStateProblem(room, true), null);
    room.matchParticipants[1].userKey = room.matchParticipants[0].userKey;
    assert.notEqual(adapter.roomStateProblem(room, true), null, `${phase}: duplicate departed account seats`);
  }
  const mixed = snapshot('finished', 4);
  delete mixed.players[0].userKey;
  delete mixed.matchParticipants[0].userKey;
  assert.equal(adapter.roomStateProblem(mixed, true), null, 'legacy anonymous identities need no synthetic keys');
});

test('aborted room has no scored result, and non-aborted rooms cannot keep an abort result', () => {
  for (const change of [room => { room.abortedResult.winnerIds = [seatIds[0]]; },
    room => { room.abortedResult.scores = [{ points: 0 }]; }, room => { room.abortedResult.tie = true; },
    room => { room.abortedResult.aborted = false; }, room => { room.abortedResult.token = 'secret'; },
    room => { room.matchEndedAt = 500; }]) {
    const room = snapshot('aborted'); change(room); assert.notEqual(adapter.roomStateProblem(room, true), null);
  }
  const playing = snapshot(); playing.abortedResult = snapshot('aborted').abortedResult;
  assert.notEqual(adapter.roomStateProblem(playing, true), null);
});

test('player summary is side and native completion only; no hand counts or points', () => {
  assert.deepEqual(adapter.playerSummary(null, seatIds[0]), {});
  const game = finish(3), view = adapter.privateView(game, seatIds[0]);
  assert.deepEqual(adapter.playerSummary(view, seatIds[0]), { side: 'red', completedCount: 4 });
  assert.deepEqual(adapter.playerSummary(view, seatIds[1]), { side: 'blue', completedCount: 0 });
  assert.deepEqual(adapter.playerSummary(view, 'spectator'), {});
  assert.deepEqual(adapter.playerResult(null, seatIds[0]), { outcome: 'unscored', remainingPoints: null });
});

test('history permits exactly one winner and only win/loss, with aborted players unscored', () => {
  for (const count of [2, 3, 4]) assert.equal(adapter.historyOutcomeProblem(1, 0, count), false);
  for (const [wins, draws, count] of [[0, 0, 2], [2, 0, 3], [1, 1, 4], [1, 0, 1], [1, 0, 5]]) {
    assert.equal(adapter.historyOutcomeProblem(wins, draws, count), true);
  }
  for (const outcome of ['win', 'loss']) assert.equal(adapter.historyPlayerProblem('completed', { outcome, remainingPoints: null }), false);
  for (const outcome of ['draw', 'unscored']) assert.equal(adapter.historyPlayerProblem('completed', { outcome, remainingPoints: null }), true);
  assert.equal(adapter.historyPlayerProblem('completed', { outcome: 'win', remainingPoints: 0 }), true);
  assert.equal(adapter.historyPlayerProblem('aborted', { outcome: 'unscored', remainingPoints: null }), false);
  assert.equal(adapter.historyPlayerProblem('aborted', { outcome: 'loss', remainingPoints: null }), true);
});

test('timeout is server-only, checks the fenced actor, retains confirmed planes and discards only pending die', () => {
  const launched = move(roll(create(), 6), 'red-1'), pending = roll(launched, 5), before = structuredClone(pending);
  assert.equal(adapter.supportsTimeout(pending), true);
  assert.equal(adapter.applyTimeout(pending, seatIds[1]).ok, false);
  const next = checked(adapter.applyTimeout(pending, seatIds[0]));
  assert.deepEqual(pending, before); assert.equal(next.die, null); assert.equal(next.round, 2);
  assert.equal(next.planes.find(plane => plane.id === 'red-1').progress, -1);
  assert.equal(next.lastAction.discardedDie, 5);
  assert.match(adapter.describeTimeout(pending, people(2)[0]), /放弃尚未使用的5点骰子/);
  assert.match(adapter.describeTimeout(create(), people(2)[0]), /换下一位/);
});

test('activity describes saved die and full confirmed route with native counts', () => {
  const initial = create(), rolled = roll(initial, 6), moved = move(rolled, 'red-1'), unable = roll(create(), 2);
  assert.match(adapter.describeAction({ action: { type: 'roll' }, player: people(2)[0], afterGame: rolled }), /掷出6点/);
  assert.match(adapter.describeAction({ action: { type: 'roll' }, player: people(2)[0], afterGame: unable }), /无法起飞/);
  const text = adapter.describeAction({ action: { type: 'move' }, player: people(2)[0], afterGame: moved });
  assert.match(text, /六点起飞/); assert.match(text, /起飞点/); assert.ok(text.length <= 160);
});
