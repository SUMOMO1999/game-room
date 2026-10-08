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
    playersChanged: () => {}, roomDefaults: () => ({}), turnTimeoutMs: value => value,
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
  for (const missing of ['applyTimeout', 'playerResult', 'spectatorView', 'snapshotProblem', 'validateAction', 'playersChanged', 'roomDefaults', 'turnTimeoutMs']) {
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

test('corrupt historical game-type and rule-version mixtures retain the original early snapshot error', t => {
  const definitions = [
    { gameType: 'rummikub', ruleVersion: 'friends-v4', clock: 1000,
      wrongType: 'army-flip', schemas: [3, 4, 7], configure: true },
    { gameType: 'army-flip', ruleVersion: 'army-flip-v2', wrongType: 'rummikub', schemas: [1, 2, 4, 7] },
    { gameType: 'army-flip', ruleVersion: 'army-flip-v3', wrongType: 'rummikub', schemas: [1, 2, 4] },
  ];
  for (const definition of definitions) {
    const f = fixture(definition); t.after(() => f.store.close());
    if (definition.configure) f.act(0, 'configure', { jokerConfig: { normal: 2, mirror: 0, colorChange: 0, double: 0 } });
    f.start();
    const original = f.store.exportSnapshot(f.host.roomCode);
    for (const schema of definition.schemas) {
      const corrupt = structuredClone(original);
      corrupt.schemaVersion = schema; corrupt.gameType = definition.wrongType;
      if (schema < 4) delete corrupt.spectators; else corrupt.spectators = [];
      if (schema === 7) corrupt.turnClock ??= null; else delete corrupt.turnClock;
      assert.throws(() => f.store.importSnapshot(corrupt), error => error.status === 500
        && error.code === 'INVALID_SNAPSHOT' && error.message === '房间保存内容无效。',
      `${definition.ruleVersion} with ${definition.wrongType} schema ${schema}`);
      assert.deepEqual(f.store.exportSnapshot(f.host.roomCode), original, 'bad imports must not replace the original room');
    }
  }
});

test('an unrelated no-card engine gains dynamic clocks, non-current responses and its own lifecycle result explicitly', t => {
  const base = syntheticAdapter();
  const adapter = { ...base, actionTypes: ['choose', 'respond'], concurrentActionTypes: ['respond'],
    actionFields: type => type === 'choose' ? ['choice'] : type === 'respond' ? ['windowId'] : null,
    createGame(players, options) { return { ...base.createGame(players, options), window: null, respondedBy: null }; },
    privateView(game, playerId) { return { ...base.privateView(game, playerId), respondedBy: game.respondedBy }; },
    roomDefaults: () => ({ turnClock: null }), turnTimeoutMs: () => 0,
    commonActionProblem: (room, playerId, action) => action.type === 'pause' ? problem(409, 'NO_PAUSE', '此游戏不提供暂停。') : null,
    gameClock: game => game.window ? { kind: 'answer', id: game.window.id, deadlineAt: game.window.deadlineAt } : null,
    actionDeadline: (room, action) => action.type === 'respond' ? room.game.window?.deadlineAt ?? null : null,
    actionConcurrencyProblem(room, playerId, action) {
      return !room.game.window || action.windowId !== room.game.window.id || playerId === room.game.players[room.game.turnIndex].id
        ? problem(409, 'STALE_QUESTION', '本题已改变。') : null;
    },
    applyGameAction(game, playerId, action, { now }) {
      const state = structuredClone(game);
      if (action.type === 'choose') {
        if (game.players[game.turnIndex].id !== playerId) return { ok: false, error: '当前不能提问。' };
        state.window = { id: `question-${game.revision}`, deadlineAt: now + 1000 };
      } else {
        if (!game.window || game.window.id !== action.windowId || game.players[game.turnIndex].id === playerId) return { ok: false, error: '当前不能回答。' };
        state.window = null; state.respondedBy = playerId;
      }
      state.revision++; return { ok: true, state };
    },
    applyTimeout(game) { return { ok: true, state: { ...structuredClone(game), window: null, revision: game.revision + 1 } }; },
    describeTimeout: () => '回答机会结束，提问者继续。',
    lifecycleTransition(game, { reason }) { return { ok: true, state: { ...structuredClone(game), status: 'finished', window: null,
      result: { reason, outcomes: {}, unfinishedChoicePreserved: true } }, roomPhase: 'finished', returnToWaiting: false }; },
  };
  const f = fixture({ gameType: adapter.gameType, gameRegistry: createGameRegistry([adapter]) }); t.after(() => f.store.close()); f.start();
  assert.equal(f.view().turnClock, null); assert.throws(() => f.act(0, 'pause'), error => error.code === 'NO_PAUSE');
  f.act(0, 'choose', { choice: 1 }); const clock = f.view().turnClock;
  assert.equal(clock.version, 3); assert.equal(clock.kind, 'answer');
  const intent = { type: 'respond', requestId: 'different-engine-response', expectedRevision: f.view(1).revision, windowId: clock.id };
  f.store.joinTrustedRoom(f.host.roomCode, users[2], '观众');
  f.store.trustedAction(f.host.roomCode, users[1], intent);
  assert.equal(f.view().game.respondedBy, f.view(1).selfId); assert.equal(f.view().turnClock, null);
  f.act(0, 'choose', { choice: 2 }); const second = f.view().turnClock; f.set(second.deadlineAt);
  assert.equal(f.store.applyTurnTimeout(f.host.roomCode, second), true);
  assert.equal(f.view().game.turnIndex, 0); assert.equal(f.view().turnClock, null);
  assert.equal(f.store.applyLifecycle(f.host.roomCode, { matchId: f.view().matchId, reason: 'server-recovery' }), true);
  assert.equal(f.view().phase, 'finished'); assert.equal(f.view().game.result.unfinishedChoicePreserved, true);
  assert.equal(JSON.stringify(f.view()).includes('remainingPoints'), false);
});

test('malformed optional clock, lifecycle and retry policies fail registration', () => {
  for (const fields of [{ gameClock: true }, { lifecycleTransition: true }, { recoverOnStartup: true },
    { businessCasAttempts: 0 }, { disconnectTimeoutMs: 120000 }, { clockAdvanceActionTypes: ['choose'] },
    { maxSnapshotBytes: -1 }, { accountingPolicy: { accountGroup: 'a', scoringVersion: 'v1' } }]) {
    assert.throws(() => createGameRegistry([{ ...syntheticAdapter(), ...fields }]), /适配器不完整/);
  }
});
