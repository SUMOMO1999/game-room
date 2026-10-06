/** Server assembly only. Never expose this module or its random source to HTTP. */
import { randomInt as secureRandomInt } from 'node:crypto';
import * as core from '../../../app/games/flying-chess/rules.mjs';
import { SIDES } from '../../../app/games/flying-chess/board.mjs';
import { previewMove } from '../../../app/games/flying-chess/routes.mjs';
import { problem, publicFields } from '../adapter-contract.mjs';

const gameType = core.GAME_TYPE;
const ruleVersions = Object.freeze([core.RULE_VERSION]);
const actions = Object.freeze({ roll: Object.freeze([]), move: Object.freeze(['rollId', 'planeId']) });
const fields = ['version', 'ruleVersion', 'boardVersion', 'artVersion', 'players', 'planes',
  'firstPlayerIndex', 'turnIndex', 'turnPlayerId', 'round', 'revision', 'status', 'stage',
  'rollId', 'die', 'lastAction', 'result'];
const otherGameFields = ['jokerConfig', 'jokerCount', 'copies', 'deckCopies', 'deckSize', 'tileCount',
  'boardPositions', 'assignment'];
const idProblem = id => typeof id !== 'string' || !id.trim() || id.length > 64 || /[\u0000-\u001f\u007f]/u.test(id);
const memberIdsProblem = players => !Array.isArray(players) || players.length < 1 || players.length > 4
  || players.some(player => !player || idProblem(player.id)) || new Set(players.map(player => player.id)).size !== players.length;
const nameProblem = name => typeof name !== 'string' || name !== name.normalize('NFC').trim()
  || [...name].length < 1 || [...name].length > 16 || /\p{Cc}/u.test(name);
const fail = error => ({ ok: false, error });
const unsupportedConfig = () => problem(400, 'CONFIG_UNSUPPORTED', '飞行棋首版没有可更改的游戏设置。');
const dataObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matchingIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);

function randomIndex(source, maximum) {
  if (source === undefined) source = secureRandomInt;
  if (typeof source !== 'function') throw new Error('服务端随机源无效。');
  let index;
  try { index = source(maximum); } catch { throw new Error('服务端随机暂时不可用。'); }
  if (!Number.isSafeInteger(index) || index < 0 || index >= maximum) throw new Error('服务端随机结果无效。');
  return index;
}

function checkProjection(game) {
  const error = core.gameProblem(game);
  if (error) throw new Error(error);
}

function projection(game, playerId, observer, context = {}) {
  checkProjection(game);
  if (!observer && !game.players.some(player => player.id === playerId)) throw new Error('你不是本局参赛玩家。');
  const acting = !observer && (context?.phase ?? 'playing') === 'playing'
    && game.status === 'playing' && game.turnPlayerId === playerId;
  const legal = acting && game.stage === 'await-move' ? [...game.legalPlaneIds] : [];
  const view = publicFields(game, fields, gameType, { ...(observer ? {} : { playerId }),
    canRoll: acting && game.stage === 'await-roll', legalPlaneIds: legal,
    legalMoves: legal.map(planeId => previewMove(game.planes, planeId, game.die)) });
  // A historical roll is a saved public event, not an executable permission list.
  if (view.lastAction?.type === 'roll') view.lastAction.legalPlaneIds = [];
  return view;
}

function assignments(room) {
  if (room.game) return room.game.players.map(({ id, side }) => ({ playerId: id, side }));
  if (memberIdsProblem(room.players)) throw new Error('飞行棋等待席位无效。');
  if (room.players.length === 1) return [{ playerId: room.players[0].id, side: SIDES[0].id }];
  // Derive waiting colours from the same rule allocation. This temporary value
  // is not a started game, saved first player, or a random operation.
  return core.createGame(room.players.map(({ id }) => id), { firstPlayerIndex: 0 }).players
    .map(({ id, side }) => ({ playerId: id, side }));
}

function rollProblem(game, actor) {
  const error = core.gameProblem(game);
  if (error) return error;
  if (!game.players.some(player => player.id === actor)) return '你不是本局参赛玩家。';
  if (game.status !== 'playing') return '对局已经结束。';
  if (game.turnPlayerId !== actor) return '现在不是你的回合。';
  if (game.stage !== 'await-roll') return '本次骰子尚未使用，不能再次掷骰。';
  if (['revision', 'round', 'rollId'].some(field => game[field] >= Number.MAX_SAFE_INTEGER - 1)) return '对局计数已达上限。';
  return null;
}

function actionProblem(action) {
  if (!dataObject(action) || !Object.hasOwn(actions, action.type)) return problem(400, 'INVALID_ACTION', '飞行棋操作格式无效。');
  const allowed = ['type', 'requestId', 'expectedRevision', ...actions[action.type]];
  if (Reflect.ownKeys(action).some(key => !allowed.includes(key))) return problem(400, 'INVALID_ACTION', '该操作包含不适用的字段。');
  if (action.type === 'move' && (!Number.isSafeInteger(action.rollId) || action.rollId < 1
      || action.rollId >= Number.MAX_SAFE_INTEGER || typeof action.planeId !== 'string'
      || !/^(?:red|blue|yellow|green)-[1-4]$/u.test(action.planeId))) {
    return problem(400, 'INVALID_ACTION', '移动需要有效的骰子编号和飞机编号。');
  }
  return null;
}

function roomStateProblem(data, hasRoles) {
  if (!dataObject(data) || data.gameType !== gameType || !hasRoles || memberIdsProblem(data.players)
      || !Array.isArray(data.spectators) || data.spectators.length > 8
      || data.spectators.some(member => !member || idProblem(member.id))
      || new Set([...data.players, ...data.spectators].map(member => member.id)).size !== data.players.length + data.spectators.length
      || otherGameFields.some(field => Object.hasOwn(data, field))
      || !Object.hasOwn(data, 'turnClock') || !['waiting', 'playing', 'paused', 'finished', 'aborted'].includes(data.phase)) {
    return '飞行棋房间类型、成员或设置无效。';
  }
  if (data.phase === 'waiting') {
    if (data.game !== null || data.turnClock !== null
        || ['matchId', 'matchStartedAt', 'matchEndedAt', 'matchParticipants', 'abortedResult'].some(field => Object.hasOwn(data, field))) {
      return '等待房间不能保留已开局状态。';
    }
    return null;
  }
  const error = core.gameProblem(data.game);
  if (error) return error;
  if (data.game.status !== (data.phase === 'finished' ? 'finished' : 'playing')) return '房间阶段与飞行棋状态不符。';
  const gameIds = data.game.players.map(({ id }) => id), roomIds = data.players.map(({ id }) => id);
  if (['playing', 'paused'].includes(data.phase) ? !matchingIds(roomIds, gameIds)
    : !matchingIds(roomIds, gameIds.filter(id => roomIds.includes(id)))) return '开局阵营和席位不能替换或重排。';
  if (data.spectators.some(member => gameIds.includes(member.id))) return '观众不能占用本局参赛身份。';
  if (typeof data.matchId !== 'string' || !/^[a-f0-9]{32}$/u.test(data.matchId)
      || !Number.isSafeInteger(data.matchStartedAt) || data.matchStartedAt < 0
      || !Array.isArray(data.matchParticipants) || data.matchParticipants.length !== gameIds.length
      || !matchingIds(data.matchParticipants.map(member => member?.playerId), gameIds)
      || data.matchParticipants.some(member => !dataObject(member)
        || Reflect.ownKeys(member).some(field => !['playerId', 'name', 'userKey'].includes(field))
        || nameProblem(member.name) || Object.hasOwn(member, 'userKey') && !/^[a-f0-9]{64}$/u.test(member.userKey))
      || new Set(data.matchParticipants.filter(member => Object.hasOwn(member, 'userKey')).map(member => member.userKey)).size
        !== data.matchParticipants.filter(member => Object.hasOwn(member, 'userKey')).length) {
    return '本局参赛名单或比赛标识无效。';
  }
  for (const member of data.players) {
    const participant = data.matchParticipants.find(entry => entry.playerId === member.id);
    if (participant.name !== member.name || participant.userKey !== member.userKey) return '比赛参与者与原席位归属不一致。';
  }
  const terminal = ['finished', 'aborted'].includes(data.phase);
  if (terminal ? !Number.isSafeInteger(data.matchEndedAt) || data.matchEndedAt < data.matchStartedAt || data.turnClock !== null
    : Object.hasOwn(data, 'matchEndedAt') || !dataObject(data.turnClock)) return '比赛结束时间或回合时钟不符。';
  if (!terminal && data.turnClock.firstPlayerId !== data.game.players[data.game.firstPlayerIndex].id) return '回合时钟与本局原首位不符。';
  if (data.phase === 'aborted') {
    const result = data.abortedResult;
    if (!dataObject(result) || Reflect.ownKeys(result).length !== 5
        || !['reason', 'winnerIds', 'scores', 'tie', 'aborted'].every(field => Object.hasOwn(result, field))
        || typeof result.reason !== 'string' || !result.reason || result.reason.length > 80
        || result.aborted !== true || result.tie !== false || !Array.isArray(result.winnerIds)
        || result.winnerIds.length || !Array.isArray(result.scores) || result.scores.length) return '中止对局不能保存输赢。';
  } else if (Object.hasOwn(data, 'abortedResult')) return '非中止对局不能有中止结果。';
  return null;
}

export function createFlyingChessAdapter() {
  return Object.freeze({ gameType, minPlayers: 2, maxPlayers: 4, ruleVersions,
    usesActionIntents: true, actionTypes: Object.freeze(Object.keys(actions)), configurationFields: Object.freeze([]),
    createGame(players, options) {
      if (!Array.isArray(players)) throw new Error('飞行棋参赛名单无效。');
      return core.createGame(players.map(player => player?.id), options);
    },
    privateView: (game, playerId, context) => projection(game, playerId, false, context),
    spectatorView: (game, context) => projection(game, null, true, context),
    stateProblem: core.gameProblem,
    actionFields: type => Object.hasOwn(actions, type) ? actions[type] : null,
    validateAction(action) {
      // Shared room actions are validated by the platform, not this game policy.
      return dataObject(action) && !Object.hasOwn(actions, action.type) ? null : actionProblem(action);
    },
    applyGameAction(game, playerId, action, context = {}) {
      const invalid = actionProblem(action);
      if (invalid) return fail(invalid.message);
      if (action.type === 'move') return core.applyMove(game, playerId, { rollId: action.rollId, planeId: action.planeId });
      const error = rollProblem(game, playerId);
      if (error) return fail(error);
      let die;
      try { die = randomIndex(context?.serverRandomInt, 6) + 1; }
      catch (randomError) { return fail(randomError.message); }
      return core.applyRoll(game, playerId, die);
    },
    configurationSupportProblem: unsupportedConfig,
    configure: () => ({ problem: unsupportedConfig() }),
    roomView: room => ({ sideAssignments: assignments(room) }),
    gameOptions(room, options = {}) {
      if (!room || room.gameType !== gameType || room.phase !== 'waiting' || room.game !== null || memberIdsProblem(room.players)
          || room.players.length < 2) throw new Error('请先准备有效的飞行棋等待房间。');
      core.createGame(room.players.map(({ id }) => id), { firstPlayerIndex: 0 });
      return { firstPlayerIndex: randomIndex(options?.serverRandomInt, room.players.length) };
    },
    roomDefaults: () => ({ turnClock: null }),
    turnTimeoutMs: milliseconds => milliseconds || 30 * 60 * 1000,
    playersChanged(room) {
      if (room.phase === 'waiting') for (const member of room.players) member.ready = false;
    },
    playerSummary(view, playerId) {
      const player = view?.players?.find(entry => entry.id === playerId);
      return player ? { side: player.side, completedCount: view.planes.filter(plane => plane.side === player.side && plane.progress === 55).length } : {};
    },
    playerResult: (result, playerId) => ({ outcome: !result ? 'unscored' : result.winnerIds.includes(playerId) ? 'win' : 'loss', remainingPoints: null }),
    describeAction({ action, player, afterGame }) {
      const saved = afterGame?.lastAction;
      if (action.type === 'roll') return `${player.name}掷出${saved?.die ?? afterGame?.die}点${saved?.outcome === 'no-move' ? '，无法起飞，换下一位。' : '，请选择一架飞机。'}`;
      if (action.type === 'move') return `${player.name}确认移动。${saved?.route?.description ?? ''}`;
      return null;
    },
    supportsTimeout: game => core.gameProblem(game) === null && game.ruleVersion === core.RULE_VERSION,
    applyTimeout(game, playerId) {
      if (game?.turnPlayerId !== playerId) return fail('回合已经改变。');
      return core.applyTimeout(game);
    },
    describeTimeout: (game, player) => `${player.name}本回合时间已到${game.stage === 'await-move' ? `，放弃尚未使用的${game.die}点骰子` : ''}，换下一位。`,
    snapshotSchema: () => 9,
    snapshotProblem: data => data?.schemaVersion !== 9 || data.gameType !== gameType
      || !Object.hasOwn(data, 'turnClock') || data.phase === 'waiting' && data.turnClock !== null
      || data.game !== null && data.game?.ruleVersion !== core.RULE_VERSION,
    roomStateProblem,
    historyPlayerProblem: (status, player) => player.remainingPoints !== null
      || (status === 'completed' ? !['win', 'loss'].includes(player.outcome) : player.outcome !== 'unscored'),
    historyOutcomeProblem: (wins, draws, count) => !Number.isSafeInteger(count) || count < 2 || count > 4 || wins !== 1 || draws !== 0,
  });
}
