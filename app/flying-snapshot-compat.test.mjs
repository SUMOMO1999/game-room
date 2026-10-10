import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotHasRoles, snapshotGameType, snapshotFormatProblem, serializeRoomSnapshot } from '../server/room-snapshot-compat.mjs';
import { createRummikubAdapter } from '../server/games/rummikub/adapter.mjs';
import { createArmyFlipAdapter } from '../server/games/army-flip/adapter.mjs';
import { createFlyingChessAdapter } from '../server/games/flying-chess/adapter.mjs';
import { createRoomStore } from './rooms.mjs';
import { createGameRegistry } from './game-registry.mjs';
import { completeFirstPlayerScript } from './games/flying-chess/fixtures/full-game.mjs';
import { CURRENT_DATA_COMPATIBILITY, compareReleaseCompatibility } from '../scripts/release-compatibility.mjs';

const syntheticFlyingAdapter = Object.freeze({ gameType: 'flying-chess', snapshotSchema: () => 9, snapshotProblem: () => false });
const waiting = () => ({ schemaVersion: 9, gameType: 'flying-chess', spectators: [], turnClock: null, game: null });
const copy = value => structuredClone(value);
const users = ['a', 'b', 'c'].map(value => value.repeat(64));
const actualFlying = createFlyingChessAdapter();
const gameRegistry = createGameRegistry([createRummikubAdapter(), createArmyFlipAdapter(), actualFlying]);

// Produce snapshots through actual trusted room actions: no handcrafted core
// positions, injected client dice, or invented lifecycle counters.
function actualFixture(t) {
  let at = 100000, sequence = 0, randomCalls = 0;
  const dice = [], now = () => at;
  const serverRandomInt = maximum => {
    randomCalls++;
    if (maximum === 2) return 1;
    assert.equal(maximum, 6); assert.ok(dice.length, 'fixture must declare each server die');
    return dice.shift() - 1;
  };
  const store = createRoomStore({ now, turnTimeoutMs: 60000, gameRegistry, serverRandomInt });
  t.after(() => store.close());
  const host = store.createTrustedRoom(users[0], '甲', { code: '123456', roomId: 'd'.repeat(32), gameType: 'flying-chess' });
  store.joinTrustedRoom(host.roomCode, users[1], '乙');
  store.joinTrustedRoom(host.roomCode, users[2], '观众', { role: 'spectator' });
  const snapshot = () => store.exportSnapshot(host.roomCode);
  const view = (index = 0) => store.getTrustedView(host.roomCode, users[index]);
  const act = (index, type, fields = {}) => store.trustedAction(host.roomCode, users[index],
    { type, requestId: `flying-save-${++sequence}`, expectedRevision: view(index).revision, ...fields });
  const start = () => { act(0, 'ready', { ready: true }); act(1, 'ready', { ready: true }); act(0, 'start'); };
  const roll = die => { dice.push(die); return act(snapshot().game.turnIndex, 'roll'); };
  const restored = data => {
    const result = createRoomStore({ now, gameRegistry, serverRandomInt: () => { throw new Error('restore must not reroll'); } });
    t.after(() => result.close()); result.importSnapshot(copy(data)); return result;
  };
  return { store, host, snapshot, view, act, start, roll, restored, set: value => { at = value; }, randomCalls: () => randomCalls };
}

function assertInvalidKeepsRoom(f, snapshot, mutate, label) {
  const original = f.snapshot(), corrupt = copy(snapshot); mutate(corrupt);
  assert.throws(() => f.store.importSnapshot(corrupt), error => error.status === 500 && error.code === 'INVALID_SNAPSHOT', label);
  assert.deepEqual(f.snapshot(), original, `${label}: failed import must keep prior seats, clock and game`);
}

test('schema9 has roles, explicit flying type and a mandatory clock slot even in waiting', () => {
  const data = waiting();
  assert.equal(snapshotHasRoles(data), true);
  assert.equal(snapshotGameType(data), 'flying-chess');
  assert.equal(snapshotFormatProblem(data, syntheticFlyingAdapter), false);
  const missingClock = copy(data); delete missingClock.turnClock;
  assert.equal(snapshotFormatProblem(missingClock, syntheticFlyingAdapter), true);
  for (const spectators of [undefined, null, {}, '[]']) {
    assert.equal(snapshotFormatProblem({ ...data, spectators }, syntheticFlyingAdapter), true);
  }
});

test('schema9 clock contents remain delegated to the platform while the envelope accepts its explicit slot', () => {
  const clock = { version: 1, durationMs: 1800000, remainingMs: 1800000, startedAt: 1000, deadlineAt: 1801000,
    pausedAt: null, firstPlayerId: 'first', matchId: 'match', round: 1, playerId: 'first' };
  assert.equal(snapshotFormatProblem({ ...waiting(), turnClock: clock }, syntheticFlyingAdapter), false);
  assert.equal(snapshotFormatProblem({ ...waiting(), turnClock: null }, syntheticFlyingAdapter), false);
});

test('schema9 is never reused for rummikub or army even if an adapter would otherwise accept it', () => {
  for (const gameType of ['rummikub', 'army-flip', 'unknown', undefined]) {
    const data = { ...waiting(), gameType };
    assert.equal(snapshotFormatProblem(data, { ...syntheticFlyingAdapter, gameType, snapshotProblem: () => false }), true);
  }
  assert.equal(snapshotFormatProblem(waiting(), { ...syntheticFlyingAdapter, gameType: 'rummikub' }), true);
});

test('flying-chess is refused in every historical schema without consulting its adapter', () => {
  for (let schemaVersion = 1; schemaVersion <= 8; schemaVersion++) {
    let calls = 0;
    const adapter = { ...syntheticFlyingAdapter, snapshotProblem() { calls++; return false; } };
    assert.equal(snapshotFormatProblem({ ...waiting(), schemaVersion }, adapter), true);
    assert.equal(calls, 0);
  }
});

test('historical corrupt rule guards still run before game-specific dispatch for schema9 too', () => {
  for (const ruleVersion of ['friends-v4', 'army-flip-v2', 'army-flip-v3']) {
    let calls = 0;
    const adapter = { ...syntheticFlyingAdapter, snapshotProblem() { calls++; return false; } };
    assert.equal(snapshotFormatProblem({ ...waiting(), game: { ruleVersion } }, adapter), true);
    assert.equal(calls, 0);
  }
});

test('invalid, unsupported or cross-game schema9 snapshots cannot bypass adapter diagnostics', () => {
  let calls = 0;
  const adapter = { ...syntheticFlyingAdapter, snapshotProblem() { calls++; return true; } };
  assert.equal(snapshotFormatProblem(waiting(), adapter), true); assert.equal(calls, 1);
  for (const schemaVersion of [0, 10, '9', 9.5, undefined]) {
    assert.equal(snapshotFormatProblem({ ...waiting(), schemaVersion }, syntheticFlyingAdapter), true);
  }
});

test('all historical schema1–8 envelope variants keep their prior adapter and clock rules', () => {
  const rummikub = createRummikubAdapter(), army = createArmyFlipAdapter();
  const definitions = [
    { schemaVersion: 1, adapter: rummikub, game: { ruleVersion: 'friends-v1' } },
    { schemaVersion: 2, adapter: rummikub, game: { ruleVersion: 'friends-v2' } },
    { schemaVersion: 3, adapter: army, gameType: 'army-flip', game: { ruleVersion: 'army-flip-v1' } },
    { schemaVersion: 4, adapter: rummikub, gameType: 'rummikub', spectators: [], game: { ruleVersion: 'friends-v3' } },
    { schemaVersion: 4, adapter: army, gameType: 'army-flip', spectators: [], game: { ruleVersion: 'army-flip-v1' } },
    { schemaVersion: 5, adapter: army, gameType: 'army-flip', spectators: [], game: { ruleVersion: 'army-flip-v2' } },
    { schemaVersion: 6, adapter: army, gameType: 'army-flip', spectators: [], game: { ruleVersion: 'army-flip-v3' } },
    { schemaVersion: 7, adapter: rummikub, gameType: 'rummikub', spectators: [], turnClock: null, game: { ruleVersion: 'friends-v2' } },
    { schemaVersion: 7, adapter: army, gameType: 'army-flip', spectators: [], turnClock: null, game: { ruleVersion: 'army-flip-v3' } },
    { schemaVersion: 8, adapter: rummikub, gameType: 'rummikub', spectators: [], game: { ruleVersion: 'friends-v4' } },
    { schemaVersion: 8, adapter: rummikub, gameType: 'rummikub', spectators: [], turnClock: null, game: { ruleVersion: 'friends-v4' } },
  ];
  for (const { adapter, ...data } of definitions) assert.equal(snapshotFormatProblem(data, adapter), false, `schema${data.schemaVersion} ${adapter.gameType}`);
});

test('schema9 serializer preserves spectators and request receipts without leaking listeners or mutating Maps', () => {
  const players = [{ id: 'member-a', requests: new Map([['r1', { value: 'a' }]]) }], spectators = [{ id: 'observer', requests: new Map([['s1', { value: 'b' }]]) }];
  const room = { gameType: 'flying-chess', rolesEnabled: true, listeners: new Map([['stream', () => {}]]),
    players, spectators, code: '123456', phase: 'waiting', game: null, turnClock: null };
  const result = serializeRoomSnapshot(room, syntheticFlyingAdapter);
  assert.equal(result.schemaVersion, 9); assert.equal(result.gameType, 'flying-chess');
  assert.deepEqual(result.players[0].requests, [['r1', { value: 'a' }]]);
  assert.deepEqual(result.spectators[0].requests, [['s1', { value: 'b' }]]);
  assert.equal(Object.hasOwn(result, 'listeners'), false); assert.equal(Object.hasOwn(result, 'rolesEnabled'), false);
  assert.equal(players[0].requests instanceof Map, true); assert.equal(spectators[0].requests instanceof Map, true);
  result.players[0].requests[0][1].value = 'changed'; assert.equal(players[0].requests.get('r1').value, 'a');
  assert.equal(snapshotFormatProblem(result, syntheticFlyingAdapter), false);
});

test('current candidate reads legacy schema12 and writes schema13 with eighteen scopes while retaining schema8/9 nine-scope releases', () => {
  assert.deepEqual(CURRENT_DATA_COMPATIBILITY.roomSnapshots.read, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(CURRENT_DATA_COMPATIBILITY.roomSnapshots.write, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]);
  const historicalScopes = ['game-profiles', 'room-invites', 'rooms', 'room-memberships', 'room-registry', 'room-requests', 'room-chat', 'game-history', 'history-index'];
  assert.deepEqual(CURRENT_DATA_COMPATIBILITY.backupScopes.read,
    [...historicalScopes, 'wordbank-packs', 'wordbank-releases', 'wordbank-index', 'draw-canvases', 'game-score-ledger', 'game-score-balances', 'game-score-meta', 'hyakki-events', 'hyakki-event-meta']);
  assert.deepEqual(CURRENT_DATA_COMPATIBILITY.backupScopes.write, CURRENT_DATA_COMPATIBILITY.backupScopes.read);
  const manifest = (id, compatibility) => ({ format: 1, project: 'game-room', releaseId: id.repeat(20), containsSecrets: false,
    containsUserData: false, identityPolicy: 'agora-account-security-v1', dataCompatibility: compatibility });
  for (const lastSchema of [8, 9]) {
    const old = copy(CURRENT_DATA_COMPATIBILITY);
    old.roomSnapshots = { read: Array.from({ length: lastSchema }, (_, index) => index + 1), write: Array.from({ length: lastSchema - 1 }, (_, index) => index + 2) };
    old.backupScopes = { read: [...historicalScopes], write: [...historicalScopes] };
    assert.deepEqual(compareReleaseCompatibility(manifest('a', CURRENT_DATA_COMPATIBILITY), manifest('b', old)),
      { forwardCompatible: true, rollbackCompatible: false, initial: false, priorLegacy: false });
    assert.deepEqual(compareReleaseCompatibility(manifest('b', old), manifest('a', CURRENT_DATA_COMPATIBILITY)),
      { forwardCompatible: false, rollbackCompatible: true, initial: false, priorLegacy: false });
  }
});

test('actual schema9 waiting and started rooms round-trip stable seats, spectators and first-player clock', t => {
  const f = actualFixture(t), waiting = f.snapshot();
  assert.equal(waiting.schemaVersion, 9); assert.equal(waiting.game, null); assert.equal(waiting.turnClock, null);
  assert.equal(waiting.spectators.length, 1);
  assert.equal(snapshotFormatProblem(waiting, actualFlying), false);
  assert.equal(actualFlying.roomStateProblem(waiting, true), null);
  const restoredWaiting = f.restored(waiting);
  assert.deepEqual(restoredWaiting.exportSnapshot(f.host.roomCode), waiting);
  f.start();
  const started = f.snapshot(), restored = f.restored(started);
  assert.equal(started.game.firstPlayerIndex, 1); assert.equal(started.game.stage, 'await-roll');
  assert.equal(started.turnClock.firstPlayerId, started.game.players[1].id);
  assert.equal(started.turnClock.playerId, started.game.turnPlayerId);
  assert.deepEqual(started.matchParticipants.map(member => member.playerId), started.game.players.map(member => member.id));
  assert.deepEqual(restored.exportSnapshot(f.host.roomCode), started);
  assert.deepEqual(restored.getTrustedView(f.host.roomCode, users[1]), f.view(1));
  const observer = restored.getTrustedView(f.host.roomCode, users[2]);
  assert.equal(observer.selfRole, 'spectator'); assert.equal(observer.game.canRoll, false);
  assert.deepEqual(observer.game.legalPlaneIds, []); assert.deepEqual(observer.game.legalMoves, []);
  assert.equal(f.randomCalls(), 1, 'only start chooses the initial player; restore is deterministic');
});

test('actual saved pending roll and paused roll retain die, rollId, route permissions and remaining deadline', t => {
  const f = actualFixture(t); f.start(); f.roll(6);
  assert.throws(() => f.act(0, 'roll'), error => error.status === 409 && error.code === 'INVALID_GAME_ACTION', 'a failed intent produces a real error receipt');
  const pending = f.snapshot(), restored = f.restored(pending);
  assert.equal(pending.game.stage, 'await-move'); assert.equal(pending.game.die, 6); assert.equal(pending.game.rollId, 1);
  assert.deepEqual(restored.exportSnapshot(f.host.roomCode), pending);
  assert.equal(restored.getTrustedView(f.host.roomCode, users[1]).game.legalPlaneIds.length, 4);
  assert.deepEqual(restored.getTrustedView(f.host.roomCode, users[0]).game.legalPlaneIds, []);
  assert.deepEqual(restored.getTrustedView(f.host.roomCode, users[2]).game.legalMoves, []);
  assert.ok(pending.players[0].requests.some(([, receipt]) => receipt.error));
  f.set(112000); f.act(0, 'pause'); f.act(1, 'pause');
  const paused = f.snapshot(), pausedRestore = f.restored(paused);
  assert.equal(paused.phase, 'paused'); assert.deepEqual(paused.game, pending.game);
  assert.equal(paused.turnClock.remainingMs, 48000); assert.equal(paused.turnClock.deadlineAt, null);
  assert.deepEqual(pausedRestore.exportSnapshot(f.host.roomCode), paused);
  assert.deepEqual(pausedRestore.getTrustedView(f.host.roomCode, users[1]).game.legalPlaneIds, []);
  f.set(500000);
  pausedRestore.trustedAction(f.host.roomCode, users[1], { type: 'resume', requestId: 'restore-resume', expectedRevision: paused.revision });
  const resumed = pausedRestore.exportSnapshot(f.host.roomCode);
  assert.equal(resumed.turnClock.remainingMs, 48000); assert.equal(resumed.turnClock.deadlineAt, 548000);
  assert.deepEqual(resumed.game, pending.game); assert.deepEqual(f.restored(resumed).exportSnapshot(f.host.roomCode), resumed);
  assert.equal(f.randomCalls(), 2, 'pending/paused/resumed imports never choose a new first player or die');
});

function actualFinished(f) {
  f.start();
  const started = f.snapshot();
  for (const step of completeFirstPlayerScript(started.game.players.map(player => player.id), started.game.firstPlayerIndex)) {
    const before = f.snapshot();
    assert.equal(before.game.turnPlayerId, step.playerId);
    f.roll(step.die);
    const after = f.snapshot();
    if (after.game.stage === 'await-move') f.act(after.game.turnIndex, 'move', {
      rollId: after.game.rollId, planeId: `${after.game.players[after.game.turnIndex].side}-${step.number}`,
    });
  }
  return f.snapshot();
}

test('actual completed schema9 game and unscored aborted game round-trip without terminal clocks or invented wins', t => {
  const f = actualFixture(t), finished = actualFinished(f), restored = f.restored(finished);
  assert.equal(finished.phase, 'finished'); assert.equal(finished.game.status, 'finished');
  assert.equal(finished.game.stage, 'finished'); assert.equal(finished.turnClock, null);
  assert.equal(finished.game.planes.filter(plane => plane.progress === 55).length, 4);
  assert.deepEqual(finished.game.result.winnerIds, [finished.game.players[1].id]);
  assert.deepEqual(restored.exportSnapshot(f.host.roomCode), finished);
  assert.equal(restored.getTrustedView(f.host.roomCode, users[1]).game.canRoll, false);
  assert.equal(finished.pendingRecords.length, 1);
  const active = actualFixture(t); active.start(); active.roll(6); active.act(0, 'leave');
  const aborted = active.snapshot();
  assert.equal(aborted.phase, 'aborted'); assert.equal(aborted.game.status, 'playing'); assert.equal(aborted.turnClock, null);
  assert.equal(aborted.players.length, 1); assert.equal(aborted.matchParticipants.length, 2);
  assert.deepEqual(aborted.abortedResult, { reason: 'player-left', winnerIds: [], scores: [], tie: false, aborted: true });
  assert.deepEqual(active.restored(aborted).exportSnapshot(active.host.roomCode), aborted);
  assert.equal(aborted.pendingRecords[0].status, 'aborted');
  assert.ok(aborted.pendingRecords[0].players.every(player => player.outcome === 'unscored' && player.remainingPoints === null));
});

test('actual schema9 refuses core, roster, clock, phase and cross-game tampering before replacing a live room', t => {
  const f = actualFixture(t), waiting = f.snapshot(); f.start(); f.roll(6);
  const pending = f.snapshot(); f.set(112000); f.act(0, 'pause'); f.act(1, 'pause'); const paused = f.snapshot();
  const cases = [
    ['missing required clock', pending, data => { delete data.turnClock; }],
    ['unknown rule', pending, data => { data.game.ruleVersion = 'foreign-rule'; }],
    ['unknown board', pending, data => { data.game.boardVersion = 'foreign-board'; }],
    ['unknown art', pending, data => { data.game.artVersion = 'foreign-art'; }],
    ['missing pending die', pending, data => { data.game.die = null; }],
    ['illegal plane position', pending, data => { data.game.planes[0].progress = 999; }],
    ['forged no-move history', pending, data => { data.game.planes[0].progress = 55; }],
    ['reordered seats', pending, data => { data.players.reverse(); }],
    ['reordered original participants', pending, data => { data.matchParticipants.reverse(); }],
    ['participant identity takeover', pending, data => { data.matchParticipants[0].userKey = 'f'.repeat(64); }],
    ['participant name takeover', pending, data => { data.matchParticipants[0].name = '冒名'; }],
    ['extra participant field', pending, data => { data.matchParticipants[0].admin = true; }],
    ['spectator is a original player', pending, data => { data.spectators[0].id = data.game.players[0].id; }],
    ['rummikub setting', pending, data => { data.jokerConfig = { normal: 2 }; }],
    ['clock first-player mismatch', pending, data => { data.turnClock.firstPlayerId = data.game.players[0].id; }],
    ['clock current-player mismatch', pending, data => { data.turnClock.playerId = data.game.players[0].id; }],
    ['clock match mismatch', pending, data => { data.turnClock.matchId = 'e'.repeat(32); }],
    ['clock round mismatch', pending, data => { data.turnClock.round++; }],
    ['playing clock stopped', pending, data => { data.turnClock.deadlineAt = null; }],
    ['playing clock paused', pending, data => { data.turnClock.pausedAt = 112000; }],
    ['wrong duration sum', pending, data => { data.turnClock.deadlineAt++; }],
    ['extra clock field', pending, data => { data.turnClock.extra = true; }],
    ['paused clock deadline remains active', paused, data => { data.turnClock.deadlineAt = 160000; }],
    ['paused clock lacks pause time', paused, data => { data.turnClock.pausedAt = null; }],
    ['phase transition without clock transition', pending, data => { data.phase = 'paused'; }],
    ['waiting keeps finished identifier', waiting, data => { data.matchId = 'e'.repeat(32); }],
    ['waiting has active clock', waiting, data => { data.turnClock = copy(pending.turnClock); }],
    ['active keeps end timestamp', pending, data => { data.matchEndedAt = 120000; }],
    ['cross game schema9', pending, data => { data.gameType = 'rummikub'; }],
  ];
  for (const [label, snapshot, mutate] of cases) assertInvalidKeepsRoom(f, snapshot, mutate, label);
  for (let schemaVersion = 1; schemaVersion <= 8; schemaVersion++) {
    assertInvalidKeepsRoom(f, pending, data => { data.schemaVersion = schemaVersion; }, `flying saved as old schema${schemaVersion}`);
  }
});

test('actual schema9 request receipts preserve valid outcomes and reject duplicate, malformed or foreign data', t => {
  const f = actualFixture(t); f.start(); f.roll(6);
  assert.throws(() => f.act(0, 'roll'), error => error.status === 409 && error.code === 'INVALID_GAME_ACTION');
  const pending = f.snapshot(), receipt = pending.players[0].requests[0];
  assert.match(receipt[1].fingerprint, /^[a-f0-9]{64}$/); assert.deepEqual(f.restored(pending).exportSnapshot(f.host.roomCode), pending);
  const cases = [
    ['duplicate id', data => { data.players[0].requests.push(copy(data.players[0].requests[0])); }],
    ['malformed tuple', data => { data.players[0].requests[0] = [receipt[0]]; }],
    ['invalid id', data => { data.players[0].requests[0][0] = 'bad request'; }],
    ['missing fingerprint', data => { delete data.players[0].requests[0][1].fingerprint; }],
    ['bad fingerprint', data => { data.players[0].requests[0][1].fingerprint = 'wrong'; }],
    ['receipt payload leak', data => { data.players[0].requests[0][1].privateState = data.game; }],
    ['error shape', data => { data.players[0].requests[0][1].error = [400, 'CODE']; }],
    ['error status', data => { data.players[0].requests[0][1].error = [200, 'CODE', 'message']; }],
    ['error code type', data => { data.players[0].requests[0][1].error = [400, {}, 'message']; }],
    ['observer invalid receipt', data => { data.spectators[0].requests = [['bad', { fingerprint: 'wrong' }]]; }],
  ];
  for (const [label, mutate] of cases) assertInvalidKeepsRoom(f, pending, mutate, label);
});

test('actual terminal schema9 rejects live deadlines, missing closure and forged aborted settlement', t => {
  const completed = actualFixture(t), finished = actualFinished(completed);
  for (const [label, mutate] of [
    ['finished active clock', data => { data.turnClock = {}; }],
    ['finished missing end time', data => { delete data.matchEndedAt; }],
    ['finished end before start', data => { data.matchEndedAt = data.matchStartedAt - 1; }],
    ['finished spectator takes old seat', data => { data.spectators[0].id = data.game.players[0].id; }],
  ]) assertInvalidKeepsRoom(completed, finished, mutate, label);
  const f = actualFixture(t); f.start(); f.act(0, 'leave'); const aborted = f.snapshot();
  for (const [label, mutate] of [
    ['aborted fake winner', data => { data.abortedResult.winnerIds = [data.game.players[1].id]; }],
    ['aborted fake score', data => { data.abortedResult.scores = [{ playerId: data.game.players[1].id, points: 1 }]; }],
    ['aborted fake draw', data => { data.abortedResult.tie = true; }],
    ['aborted extra outcome field', data => { data.abortedResult.outcome = 'win'; }],
    ['aborted missing original participant', data => { data.matchParticipants.shift(); }],
    ['aborted missing end time', data => { delete data.matchEndedAt; }],
  ]) assertInvalidKeepsRoom(f, aborted, mutate, label);
});
