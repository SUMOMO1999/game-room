/** Private server policy. The browser receives role projections, never the undealt deck. */
import { randomInt } from 'node:crypto';
import * as core from '../../../app/games/poker414-2/rules.mjs';
import { getCard } from '../../../app/games/poker414-2/cards.mjs';
import { problem } from '../adapter-contract.mjs';

const gameType = core.GAME_TYPE;
const fields = Object.freeze({
  play: Object.freeze(['matchId', 'roundId', 'targetId', 'cardIds']),
  pass: Object.freeze(['matchId', 'roundId', 'targetId']),
  hook: Object.freeze(['matchId', 'roundId', 'targetId', 'windowId']),
  fork: Object.freeze(['matchId', 'roundId', 'targetId', 'windowId']),
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER - 1000000) => Number.isSafeInteger(value) && value >= min && value <= max;
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
const userKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const validName = value => typeof value === 'string' && value === value.normalize('NFC').trim()
  && [...value].length >= 1 && [...value].length <= 16 && !/\p{Cc}/u.test(value);
const sameIds = (left, right) => left.length === right.length && new Set(left).size === left.length
  && left.every(value => right.includes(value));
const actionError = message => problem(400, 'INVALID_ACTION', message);
const failed = issue => ({ ok: false, error: issue.message, code: issue.code });

function actionProblem(action) {
  if (!object(action) || !Object.hasOwn(fields, action.type)) return actionError('414操作无效。');
  if (!exact(action, ['type', 'requestId', 'expectedRevision', ...fields[action.type]])
      || !id(action.matchId) || !integer(action.roundId, 1)
      || !(action.targetId === null || typeof action.targetId === 'string' && action.targetId.length <= 160)) {
    return actionError('操作需要当前对局、轮次和目标。');
  }
  if (['hook', 'fork'].includes(action.type)
      && (typeof action.windowId !== 'string' || !action.windowId.length || action.windowId.length > 180)) return actionError('请提交当前勾叉窗口。');
  if (action.type === 'play') {
    if (!Array.isArray(action.cardIds) || action.cardIds.length < 1 || action.cardIds.length > 24
        || new Set(action.cardIds).size !== action.cardIds.length) return actionError('请选择1～24张不同实体牌。');
    try { for (const cardId of action.cardIds) getCard(cardId); } catch { return actionError('牌实体无效。'); }
  }
  return null;
}

function coreAction(playerId, action) {
  return { type: action.type, playerId, ...Object.fromEntries(fields[action.type].map(key => [key, action[key]])) };
}

function concurrencyProblem(room, playerId, action, { now }) {
  const invalid = actionProblem(action); if (invalid) return invalid;
  if (action.expectedRevision > room.revision) return problem(409, 'REVISION_CONFLICT', '房间版本尚未达到请求版本。');
  if (room.phase !== 'playing') return problem(409, 'GAME_NOT_PLAYING', '当前不能出牌。');
  // A CAS retry re-evaluates exactly this immutable intent. It cannot select a
  // replacement target/window or turn a stale fork into a fresh opportunity.
  const checked = core.applyAction(room.game, coreAction(playerId, action), { now });
  return checked.ok ? null : problem(409, checked.code, checked.error);
}

function roomStateProblem(room, hasRoles) {
  if (!object(room) || room.gameType !== gameType || !hasRoles || !Array.isArray(room.players)
      || room.players.length > 8 || !Array.isArray(room.spectators) || room.spectators.length > 8
      || !id(room.roomId) || !Object.hasOwn(room, 'turnClock') || room.pauseVote != null || room.phase === 'paused'
      || [...room.players, ...room.spectators].some(player => !object(player) || !id(player.id)
        || !userKey(player.userKey) || !validName(player.name) || typeof player.ready !== 'boolean')
      || ['jokerConfig', 'jokerCount', 'copies', 'deckCopies', 'deckSize', 'tileCount', 'boardPositions', 'assignment', 'drawConfig']
        .some(key => Object.hasOwn(room, key))) return '414房间、角色或共通设置无效。';
  if (room.lastMatchResult !== undefined) {
    const value = room.lastMatchResult;
    if (!exact(value, ['matchId', 'reason', 'result']) || !id(value.matchId)
        || !['disconnected', 'server-recovery', 'room-expired'].includes(value.reason)
        || !exact(value.result, ['accountGroup', 'gameType', 'ruleVersion', 'scoringVersion', 'matchId', 'settlementVersion',
          'reason', 'winnerId', 'responsiblePlayerId', 'settledAt', 'deltas'])
        || value.result.matchId !== value.matchId || value.result.reason !== value.reason
        || value.result.accountGroup !== '4a4' || value.result.gameType !== gameType || value.result.ruleVersion !== core.RULE_VERSION
        || value.result.scoringVersion !== core.SCORING_VERSION || value.result.settlementVersion !== 0
        || value.result.winnerId !== null || value.result.responsiblePlayerId !== null || !integer(value.result.settledAt)
        || !Array.isArray(value.result.deltas) || value.result.deltas.length < 3 || value.result.deltas.length > 8
        || new Set(value.result.deltas.map(delta => delta?.playerId)).size !== value.result.deltas.length
        || value.result.deltas.some(delta => !exact(delta, ['playerId', 'points']) || !id(delta.playerId) || delta.points !== 0)) return '最近取消结果无效。';
  }
  if (room.phase === 'waiting') return room.game !== null || room.turnClock !== null
    || ['matchId', 'matchStartedAt', 'matchEndedAt', 'matchParticipants', 'abortedResult', 'clockAdvance'].some(key => Object.hasOwn(room, key))
    ? '等待房间不能保留进行中的对局。' : null;
  const invalid = core.gameProblem(room.game); if (invalid) return invalid;
  const game = room.game, gameIds = game.players.map(player => player.id), memberIds = room.players.map(player => player.id);
  if (game.matchId !== room.matchId || !id(room.matchId) || !integer(room.matchStartedAt)
      || game.createdAt !== room.matchStartedAt || !['playing', 'finished', 'aborted'].includes(room.phase)
      || game.status !== (room.phase === 'playing' ? 'playing' : room.phase)
      || !Array.isArray(room.matchParticipants) || !sameIds(room.matchParticipants.map(player => player?.playerId), gameIds)
      || room.matchParticipants.some(player => !exact(player, ['playerId', 'name', 'userKey']) || !id(player.playerId)
        || !userKey(player.userKey) || !validName(player.name))
      || new Set(room.matchParticipants.map(player => player.userKey)).size !== gameIds.length
      || (room.phase === 'playing' ? !sameIds(memberIds, gameIds) : memberIds.some(value => !gameIds.includes(value)))
      || room.players.some(player => { const saved = room.matchParticipants.find(entry => entry.playerId === player.id);
        return !saved || saved.userKey !== player.userKey || saved.name !== player.name; })
      || room.spectators.some(player => gameIds.includes(player.id))) return '固定参赛者、账号或阶段不一致。';
  if (room.phase === 'playing' ? Object.hasOwn(room, 'matchEndedAt')
    : !integer(room.matchEndedAt, room.matchStartedAt) || game.result.settledAt !== room.matchEndedAt) return '结束时间无效。';
  const clock = core.gameClock(game);
  const expected = clock ? { version: 3, ...clock, matchId: game.matchId } : null;
  if (expected === null ? room.turnClock !== null : !exact(room.turnClock, Object.keys(expected))
      || Object.keys(expected).some(key => room.turnClock[key] !== expected[key])) return '房间时钟与发牌／勾叉阶段不符。';
  if (Object.hasOwn(room, 'abortedResult')) return '414终局应保存规则确认的原结果。';
  if (room.clockAdvance !== undefined) {
    const value = room.clockAdvance;
    if (!exact(value, ['fromRevision', 'toRevision', 'clockId', 'kind', 'matchId'])
        || !integer(value.fromRevision) || value.toRevision !== value.fromRevision + 1 || value.toRevision > room.revision
        || value.matchId !== room.matchId || typeof value.clockId !== 'string'
        || !['deal', 'response'].includes(value.kind)) return '阶段推进记录无效。';
  }
  return null;
}

export function createPoker414Adapter() {
  return Object.freeze({ gameType, minPlayers: 3, maxPlayers: 8, ruleVersions: Object.freeze([core.RULE_VERSION]),
    accountingPolicy: Object.freeze({ accountGroup: '4a4', scoringVersion: core.SCORING_VERSION }),
    businessCasAttempts: 3, disconnectTimeoutMs: core.DISCONNECT_MS, recoverOnStartup: true, maxSnapshotBytes: 512 * 1024,
    historySchemaVersion: 3, historyPlayerFields: Object.freeze(['score', 'balanceAfter']), usesActionIntents: true,
    historySummaryFields: Object.freeze(['accountGroup', 'scoringVersion', 'settlementVersion', 'deltas']),
    historySummaryProblem(summary) {
      if (summary.accountGroup !== '4a4' || summary.scoringVersion !== core.SCORING_VERSION || summary.settlementVersion !== 0
          || !Array.isArray(summary.deltas) || summary.deltas.length !== summary.players.length
          || new Set(summary.deltas.map(delta => delta?.userKey)).size !== summary.players.length
          || summary.deltas.some(delta => !exact(delta, ['userKey', 'delta']) || !userKey(delta.userKey)
            || !integer(delta.delta, -10000, 10000) || summary.players.find(player => player.userKey === delta.userKey)?.score !== delta.delta)
          || summary.deltas.reduce((total, delta) => total + delta.delta, 0) !== 0
          || summary.players.some(player => !Number.isSafeInteger(player.balanceAfter))) return '414积分摘要与固定参与者不符。';
      const values = summary.players.map(player => player.score);
      if (summary.reason === 'emptied-hand') return summary.status !== 'completed' ? '正常结算状态无效。' : null;
      if (summary.status !== 'aborted') return '中止结算状态无效。';
      if (summary.reason === 'voluntary-leave') return values.filter(value => value === -5 * (values.length - 1)).length !== 1
        || values.filter(value => value === 5).length !== values.length - 1 ? '离席赔分无效。' : null;
      return !['disconnected', 'server-recovery', 'room-expired'].includes(summary.reason) || values.some(value => value !== 0)
        ? '取消结算必须零分。' : null;
    },
    actionTypes: Object.freeze(Object.keys(fields)), concurrentActionTypes: Object.freeze(['hook', 'fork']),
    clockAdvanceActionTypes: Object.freeze(['play', 'pass']), configurationFields: Object.freeze([]),
    actionFields: type => Object.hasOwn(fields, type) ? fields[type] : null,
    validateAction: action => Object.hasOwn(fields, action.type) ? actionProblem(action) : null,
    createGame(players, options) { return core.createGame({ players: players.map(player => player.id), ...options }); },
    gameOptions(room, options) {
      if (room.players.some(player => !userKey(player.userKey))) throw new Error('414需要每位玩家使用自己的账号加入。');
      const source = options.serverRandomInt ?? randomInt;
      return { matchId: options.matchId, now: options.now, random: () => {
        const value = source(0x100000000);
        if (!integer(value, 0, 0xffffffff)) throw new Error('服务端随机源无效。');
        return value / 0x100000000;
      } };
    },
    applyGameAction(game, playerId, action, context) {
      const invalid = actionProblem(action); if (invalid) return failed(invalid);
      return core.applyAction(game, coreAction(playerId, action), { now: context.now });
    },
    actionConcurrencyProblem: concurrencyProblem,
    actionDeadline: (room, action) => ['hook', 'fork'].includes(action.type) ? room.game?.responseWindow?.deadlineAt ?? null : null,
    commonActionProblem(room, playerId, action) {
      if (['pause', 'resume'].includes(action.type)) return problem(409, 'PAUSE_UNSUPPORTED', '414普通回合不限时，不提供暂停。');
      if (action.type === 'configure') return problem(409, 'CONFIGURATION_UNSUPPORTED', '两副牌414使用固定规则。');
      return null;
    },
    lifecycleTransition(game, { reason, playerId, now }) {
      const result = reason === 'voluntary-leave' ? core.abortGame(game, playerId, { now }) : core.cancelGame(game, reason, { now });
      return result.ok ? { ...result, roomPhase: 'aborted', returnToWaiting: reason !== 'voluntary-leave' } : result;
    },
    gameStatusForRoomPhase: phase => phase === 'aborted' ? 'aborted' : phase === 'finished' ? 'finished' : 'playing',
    matchSummary(game) {
      const invalid = core.gameProblem(game); if (invalid || !game.result) throw new Error(invalid ?? '未完成的对局不能计分。');
      const { accountGroup, scoringVersion, settlementVersion, deltas } = game.result;
      return { accountGroup, scoringVersion, settlementVersion, deltas: structuredClone(deltas) };
    },
    privateView: (game, playerId) => core.projectGame(game, { playerId, role: 'player' }),
    spectatorView: game => core.projectGame(game, { role: 'spectator' }), stateProblem: core.gameProblem,
    roomDefaults: () => ({ rolesEnabled: true, spectators: [], turnClock: null }),
    roomView: room => ({ commonActions: { pause: false, retainSeatOnReturn: false },
      resultParticipants: (room.matchParticipants ?? []).map(({ playerId, name }) => ({ playerId, name })),
      ...(room.lastMatchResult ? { lastMatchResult: structuredClone(room.lastMatchResult) } : {}) }),
    playersChanged(room) { if (room.phase === 'waiting') for (const player of room.players) player.ready = false; },
    configurationSupportProblem: () => problem(409, 'CONFIGURATION_UNSUPPORTED', '两副牌414使用固定规则。'),
    configure: () => ({ problem: problem(409, 'CONFIGURATION_UNSUPPORTED', '两副牌414使用固定规则。') }),
    playerSummary(view, playerId) { const player = view?.players?.find(entry => entry.id === playerId);
      return player ? { handCount: player.handCount } : {}; },
    playerResult(result, playerId) {
      const score = result?.deltas.find(delta => delta.playerId === playerId)?.points ?? null;
      return { outcome: result?.reason === 'emptied-hand' ? result.winnerId === playerId ? 'win' : 'loss' : 'unscored', score };
    },
    describeAction: ({ action, player }) => `${player.name}${({ play: '出了牌。', pass: '选择不出。', hook: '勾了一张。', fork: '叉了两张。' })[action.type] ?? '完成操作。'}`,
    turnTimeoutMs: () => 0, gameClock: core.gameClock,
    supportsTimeout: game => core.gameProblem(game) === null && core.gameClock(game) !== null,
    applyTimeout: (game, playerId, context) => core.advanceGame(game, { now: context.now }),
    describeTimeout: game => game.stage === 'dealing' ? '已确认下一批发牌。' : '勾叉机会已结束，普通回合继续。',
    snapshotSchema: () => 11,
    snapshotProblem: data => data?.schemaVersion !== 11 || data.gameType !== gameType
      || !Object.hasOwn(data, 'turnClock') || Buffer.byteLength(JSON.stringify(data), 'utf8') > 512 * 1024,
    roomStateProblem,
    historyPlayerProblem: (status, player) => Object.hasOwn(player, 'remainingPoints')
      || !integer(player.score, -10000, 10000) || player.balanceAfter !== undefined && !Number.isSafeInteger(player.balanceAfter)
      || (status === 'aborted' ? player.outcome !== 'unscored'
        : !['win', 'loss'].includes(player.outcome) || (player.outcome === 'loss' ? player.score > 0 : player.score < 0)),
    historyOutcomeProblem: (wins, draws, count) => count < 3 || count > 8 || wins !== 1 || draws !== 0,
  });
}
