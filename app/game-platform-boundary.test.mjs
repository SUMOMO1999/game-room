import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRoomStore } from './rooms.mjs';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { publicFields, problem } from '../server/games/adapter-contract.mjs';
import { createMatchHistory, validateMatchSummary } from '../server/match-history.mjs';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';

const users = ['a', 'b', 'c'].map(value => value.repeat(64));
let sequence = 0;
function fixture({ gameType = 'rummikub', ruleVersion, clock = 0, gameRegistry = defaultGameRegistry } = {}) {
  let at = 100000;
  const now = () => at;
  const store = createRoomStore({ now, turnTimeoutMs: clock, gameRegistry,
    gameOptions: { firstTurnIndex: 0, randomInt: max => max - 1, ...(ruleVersion ? { ruleVersion } : {}) } });
  const host = store.createTrustedRoom(users[0], '甲', { code: '123456', roomId: 'd'.repeat(32), gameType });
  store.joinTrustedRoom(host.roomCode, users[1], '乙');
  const view = (index = 0) => store.getTrustedView(host.roomCode, users[index]);
  const act = (index, type, fields = {}) => store.trustedAction(host.roomCode, users[index],
    { type, requestId: `boundary-${++sequence}`, expectedRevision: view(index).revision, ...fields });
  const start = () => { act(0, 'ready', { ready: true }); act(1, 'ready', { ready: true }); act(0, 'start'); };
  return { store, host, view, act, start, now, set: value => { at = value; } };
}

// Deliberately has no deck, pool, rack, joker, chess cell or hand-points fields.
function syntheticAdapter(calls = []) {
  const gameType = 'synthetic-choice';
  const visible = game => ({ version: 1, ruleVersion: game.ruleVersion, status: game.status,
    revision: game.revision, round: game.round, turnIndex: game.turnIndex,
    turnPlayerId: game.players[game.turnIndex].id,
    players: game.players.map(({ id, name }) => ({ id, name })), result: game.result,
    secretChoice: 'must-be-filtered', hiddenAnswer: game.hiddenAnswer });
  const advance = game => { const next = structuredClone(game); next.round++; next.revision++; next.turnIndex = 1 - next.turnIndex; return next; };
  return {
    gameType, minPlayers: 2, maxPlayers: 2, ruleVersions: ['synthetic-choice-v1'],
    actionTypes: ['choose', 'solve'], configurationFields: ['roundLimit'],
    createGame(players, options) { calls.push(['create', options]); return { players: players.map((player, index) => ({ ...player, privateChoice: `private-${index}` })),
      ruleVersion: 'synthetic-choice-v1', status: 'playing', revision: 0, round: 1, turnIndex: 0, result: null, hiddenAnswer: 'secret-answer' }; },
    actionFields: type => type === 'choose' ? ['choice'] : type === 'solve' ? [] : null,
    validateAction: action => action.type === 'choose' && !Number.isSafeInteger(action.choice)
      ? problem(400, 'INVALID_ACTION', '请选择整数。') : null,
    applyGameAction(game, playerId, action) {
      calls.push(['action', action.type]);
      if (game.players[game.turnIndex].id !== playerId) return { ok: false, error: '不是你的回合。' };
      const state = advance(game);
      if (action.type === 'solve') { state.status = 'finished'; state.result = { reason: 'solved', outcomes: Object.fromEntries(state.players.map(player => [player.id, player.id === playerId ? 'win' : 'loss'])) }; }
      return { ok: true, state };
    },
    privateView: (game, playerId) => ({ ...publicFields(visible(game), ['version', 'ruleVersion', 'status', 'revision', 'round', 'turnIndex', 'turnPlayerId', 'players', 'result'], gameType),
      playerId, secretChoice: game.players.find(player => player.id === playerId).privateChoice }),
    spectatorView: game => publicFields(visible(game), ['version', 'ruleVersion', 'status', 'revision', 'round', 'turnIndex', 'turnPlayerId', 'players', 'result'], gameType),
    stateProblem: game => game.ruleVersion !== 'synthetic-choice-v1' || !['playing', 'finished'].includes(game.status) ? 'invalid synthetic game' : null,
    configurationSupportProblem: () => null,
    configure: (room, input) => Number.isSafeInteger(input.roundLimit) && input.roundLimit > 0
      ? { updates: { roundLimit: input.roundLimit } } : { problem: problem(400, 'INVALID_SETTING', '设置无效。') },
    roomView: room => ({ roundLimit: room.roundLimit ?? null }),
    gameOptions: (room, options) => ({ ...options, roundLimit: room.roundLimit }),
    playerSummary: () => ({}),
    playerResult: (result, playerId) => ({ outcome: result?.outcomes[playerId] ?? 'unscored', remainingPoints: null }),
    describeAction: ({ player }) => `${player.name}完成一次选择。`,
    supportsTimeout: () => true,
    applyTimeout(game) { calls.push(['timeout']); return { ok: true, state: advance(game) }; },
    describeTimeout: (game, player) => `${player.name}选择到时，交给下一位。`,
    snapshotSchema: room => Object.hasOwn(room, 'turnClock') ? 7 : 4,
    snapshotProblem: data => ![4, 7].includes(data.schemaVersion),
    roomStateProblem: data => data.jokerConfig !== undefined ? 'unexpected foreign setting' : null,
    historyPlayerProblem: (status, player) => player.remainingPoints !== null || (status === 'completed' ? !['win', 'loss'].includes(player.outcome) : player.outcome !== 'unscored'),
    historyOutcomeProblem: (wins, draws) => wins !== 1 || draws !== 0,
  };
}

test('a third engine supplies its own settings, actions, timeout and outcomes without Rummikub or military defaults', async t => {
  const calls = [], adapter = syntheticAdapter(calls), gameRegistry = createGameRegistry([adapter]);
  const f = fixture({ gameType: adapter.gameType, clock: 1000, gameRegistry });
  t.after(() => f.store.close());
  assert.equal(Object.hasOwn(f.view(), 'jokerConfig'), false);
  f.act(0, 'configure', { roundLimit: 3 }); assert.equal(f.view().roundLimit, 3);
  assert.throws(() => f.act(0, 'configure', { jokerConfig: {} }), error => error.code === 'INVALID_ACTION');
  f.start();
  assert.equal(calls[0][1].roundLimit, 3); assert.equal(Object.hasOwn(calls[0][1], 'jokerConfig'), false);
  f.store.joinTrustedRoom(f.host.roomCode, users[2], '观众');
  const observer = f.view(2), player = f.view();
  assert.equal(player.game.secretChoice, 'private-0');
  for (const field of ['jokerConfig', 'rackCount', 'opened']) assert.equal(Object.hasOwn(player.players[0], field), false);
  for (const secret of ['secret-answer', 'private-0', 'private-1', 'must-be-filtered']) assert.equal(JSON.stringify(observer).includes(secret), false);
  assert.throws(() => f.act(2, 'choose', { choice: 1 }), error => error.code === 'SPECTATOR_READ_ONLY');
  assert.throws(() => f.act(0, 'choose', { choice: '1' }), error => error.code === 'INVALID_ACTION');
  assert.throws(() => f.act(0, 'draw'), error => error.code === 'INVALID_ACTION');
  const first = f.store.exportSnapshot(f.host.roomCode); f.set(first.turnClock.deadlineAt);
  assert.equal(f.store.applyTurnTimeout(f.host.roomCode, first.turnClock), true);
  assert.equal(f.store.applyTurnTimeout(f.host.roomCode, first.turnClock), false);
  assert.deepEqual(calls.filter(call => call[0] === 'action'), []);
  assert.equal(calls.filter(call => call[0] === 'timeout').length, 1);
  assert.match(f.view().activity.at(-1).text, /选择到时/);
  assert.equal(/摸牌|牌池/.test(f.view().activity.at(-1).text), false);
  const saved = f.store.exportSnapshot(f.host.roomCode), recovered = createRoomStore({ now: f.now, gameRegistry });
  t.after(() => recovered.close()); recovered.importSnapshot(saved);
  assert.deepEqual(recovered.getTrustedView(f.host.roomCode, users[0]).game, f.view().game);
  f.act(1, 'solve');
  const summary = f.store.exportSnapshot(f.host.roomCode).pendingRecords[0];
  assert.equal(summary.players.length, 2); assert.equal(summary.players.some(entry => entry.userKey === users[2]), false);
  assert.ok(summary.players.every(entry => entry.remainingPoints === null));
  validateMatchSummary(summary, { gameRegistry });
  assert.throws(() => validateMatchSummary(summary));
  assert.throws(() => validateMatchSummary({ ...summary, players: summary.players.map(entry => ({ ...entry, remainingPoints: 0 })) }, { gameRegistry }));
  const storage = new EncryptedStore(new MemoryAdapter({ now: f.now }), randomBytes(32), f.now);
  t.after(() => storage.close());
  const history = createMatchHistory({ storage, now: f.now, gameRegistry });
  await history.archive(summary); await history.archive(summary);
  const item = (await history.get(users[1])).items[0];
  assert.deepEqual(item.self, { outcome: 'win', remainingPoints: null });
  assert.equal((await storage.scan('game-history')).length, 1);
  for (const secret of ['private-0', 'private-1', 'secret-answer', 'jokerConfig', 'rack']) assert.equal(JSON.stringify(item).includes(secret), false);
});

test('incomplete new adapters fail registration rather than inherit another game policy', () => {
  for (const missing of ['applyTimeout', 'playerResult', 'spectatorView', 'snapshotProblem', 'validateAction']) {
    const adapter = syntheticAdapter(); delete adapter[missing];
    assert.throws(() => createGameRegistry([adapter]), /适配器不完整/);
  }
});

test('all historical room schemas 1 through 8 round-trip original versions, seats and public secrecy', t => {
  const definitions = [
    { schema: 1, ruleVersion: 'friends-v1', expectedWrite: 2 },
    { schema: 2, ruleVersion: 'friends-v2', expectedWrite: 2 },
    { schema: 3, gameType: 'army-flip', ruleVersion: 'army-flip-v1' },
    { schema: 4, ruleVersion: 'friends-v2', observer: true },
    { schema: 5, gameType: 'army-flip', ruleVersion: 'army-flip-v2' },
    { schema: 6, gameType: 'army-flip', ruleVersion: 'army-flip-v3' },
    { schema: 7, ruleVersion: 'friends-v2', clock: 1000 },
    { schema: 8, ruleVersion: 'friends-v4', configure: true, clock: 1000 },
  ];
  for (const definition of definitions) {
    const f = fixture(definition); t.after(() => f.store.close());
    if (definition.observer) f.store.joinTrustedRoom(f.host.roomCode, users[2], '观众', { role: 'spectator' });
    if (definition.configure) f.act(0, 'configure', { jokerConfig: { normal: 2, mirror: 0, colorChange: 0, double: 0 } });
    f.start();
    const originalView = f.view(), snapshot = f.store.exportSnapshot(f.host.roomCode);
    if (definition.schema === 1) snapshot.schemaVersion = 1;
    assert.equal(snapshot.schemaVersion, definition.schema);
    const restored = createRoomStore({ now: f.now }); t.after(() => restored.close()); restored.importSnapshot(snapshot);
    const view = restored.getTrustedView(f.host.roomCode, users[0]);
    assert.deepEqual(view, originalView); assert.equal(view.game.ruleVersion, definition.ruleVersion);
    assert.equal(restored.exportSnapshot(f.host.roomCode).schemaVersion, definition.expectedWrite ?? definition.schema);
    if (definition.observer) {
      const publicView = restored.getTrustedView(f.host.roomCode, users[2]);
      assert.equal(publicView.selfRole, 'spectator'); assert.equal(Object.hasOwn(publicView.game, 'rack'), false);
    }
    const corrupt = structuredClone(snapshot); corrupt.game.ruleVersion = 'foreign-rule';
    assert.throws(() => restored.importSnapshot(corrupt), error => error.code === 'INVALID_SNAPSHOT');
    assert.deepEqual(restored.getTrustedView(f.host.roomCode, users[0]), view);
  }
});
