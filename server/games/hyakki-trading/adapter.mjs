/** Real domain adapter, deliberately opt-in until the full product gate passes. */
import { randomInt } from 'node:crypto';
import * as core from '../../../app/games/hyakki-trading/rules.mjs';
import { privateView, spectatorView } from '../../../app/games/hyakki-trading/view.mjs';
import { gameProblem, plainObject, exactFields, integer, seatId, validCopy } from '../../../app/games/hyakki-trading/validation.mjs';
import { DIGITAL_RULE_VERSION } from '../../../app/games/hyakki-trading/content/definitions.mjs';
import { currentDecision } from '../../../app/games/hyakki-trading/decision.mjs';
import { DEFAULT_ACTION_LIMIT, DEFAULT_GOODS_PER_TYPE, goodsPerTypeOf,
  validActionLimit, validGoodsPerType } from '../../../app/games/hyakki-trading/model.mjs';
import { transitionHyakkiLifecycle, hyakkiCommonActionProblem, changeHyakkiPause,
  hyakkiGameClock, hyakkiRetentionDeadline } from '../../../app/games/hyakki-trading/lifecycle.mjs';
import { problem } from '../adapter-contract.mjs';
import { createHyakkiEventStore } from './event-store.mjs';

const gameType = 'hyakki-trading';
const clone = value => structuredClone(value);
const fences = ['matchId', 'turnId', 'effectId', 'decisionId'];
const actionExtras = Object.freeze({ peek: [], 'keep-peek': [], 'discard-peek': [], 'finish-draw': [], 'end-turn': [],
  buy: ['cardId'], sell: ['cardId'], 'buy-stall': ['cardId'], 'play-character': ['cardId', 'params'],
  'install-tool': ['cardId', 'replaceCardId'], 'activate-tool': ['cardId', 'params'], respond: ['cardId'],
  'decline-response': [], 'choose-effect': ['selection'], bid: ['amount'], 'pass-bid': [] });
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/\p{Cc}/u.test(value);
const validConfiguration = value => (exactFields(value, ['actionLimit']) || exactFields(value, ['actionLimit', 'goodsPerType']))
  && validActionLimit(value.actionLimit) && validGoodsPerType(goodsPerTypeOf(value));
const reference = value => validCopy(value) || typeof value === 'string' && /^(?:tool-[01]|discard|pool|source):\d+:\d+$/u.test(value);
const jsonInput = (value, depth = 0) => depth < 7 && (value === null || typeof value === 'boolean' || integer(value)
  || typeof value === 'string' && value.length <= 180 || Array.isArray(value) && value.length <= 110 && value.every(item => jsonInput(item, depth + 1))
  || plainObject(value) && Object.keys(value).length <= 12 && Object.entries(value).every(([key, item]) => /^[A-Za-z][A-Za-z0-9-]{0,40}$/u.test(key) && jsonInput(item, depth + 1)));
function actionProblem(action) {
  if (!plainObject(action) || !Object.hasOwn(actionExtras, action.type)) return problem(400, 'INVALID_ACTION', '幽街操作无效。');
  const allowed = ['type', 'requestId', 'expectedRevision', ...fences, ...actionExtras[action.type]];
  if (Object.keys(action).some(key => !allowed.includes(key)) || !seatId(action.matchId) || !/^turn-[1-9]\d*$/u.test(action.turnId ?? '')
      || typeof action.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(action.requestId) || !integer(action.expectedRevision)
      || (action.effectId !== undefined && !token(action.effectId)) || (action.decisionId !== undefined && !token(action.decisionId))) {
    return problem(400, 'INVALID_ACTION', '操作需要当前对局、回合与有效请求编号。');
  }
  if (actionExtras[action.type].includes('cardId') && !reference(action.cardId)
      || action.replaceCardId !== undefined && !reference(action.replaceCardId)
      || action.params !== undefined && (!plainObject(action.params) || !jsonInput(action.params))
      || action.type === 'choose-effect' && !jsonInput(action.selection)
      || action.type === 'bid' && !integer(action.amount, 1)) return problem(400, 'INVALID_ACTION', '请选择合法的牌、目标或金额。');
  return null;
}
function domainAction(action) {
  const value = clone(action);
  // Room revisions include membership/readiness/presence; the engine has its
  // own game revision. The platform already guards expectedRevision at CAS.
  delete value.expectedRevision;
  delete value.requestId;
  return value;
}
const fail = issue => ({ ok: false, error: issue.message, code: issue.code });
function record(state, events, now) {
  state.revision++; state.publicEventSequence++; state.lastPublicEvents = events; state.committedAt = now;
  if (state.timing.decision) state.timing.decision.id = currentDecision(state)?.id ?? state.timing.decision.id;
}
function wealth(state) { return state.players.map(player => ({ playerId: player.id, silver: player.silver })); }
function lifecycle(game, context) {
  const change = transitionHyakkiLifecycle(game, context);
  if (!change.ok || !change.changed || change.checkpointOnly) return change;
  if (change.terminal) {
    change.state.result.wealth = wealth(change.state);
    if (change.state.pending?.data.auction) change.state.pending.data.auction.released = true;
  }
  if (!change.terminal && game.lifecycle.capacity && change.state.lifecycle.capacity) return change;
  const events = change.terminal ? [{ type: 'match-ended', reason: change.state.result.reason, winnerSeatId: change.state.result.winnerIds[0] ?? null }]
    : change.state.lifecycle.capacity && !game.lifecycle.capacity ? [{ type: 'suspended', reason: 'capacity' }]
      : change.roomPhase === 'playing' || game.lifecycle.capacity && !change.state.lifecycle.capacity ? [{ type: 'resumed' }]
        : [{ type: 'suspended', reason: context.reason === 'server-recovery' ? 'server-recovery' : 'disconnected' }];
  record(change.state, events, context.now);
  const issue = gameProblem(change.state);
  return issue ? { ok: false, error: issue, code: 'INVALID_GAME_STATE' } : change;
}
function roomStateProblem(room, hasRoles) {
  if (!hasRoles || room.gameType !== gameType || !validConfiguration(room.hyakkiConfig)) return '幽街房间设置无效。';
  if (!room.game) return room.phase !== 'waiting' || room.turnClock !== null ? '等待房间状态无效。' : null;
  const issue = gameProblem(room.game); if (issue) return issue;
  const game = room.game, ids = game.players.map(player => player.id);
  if (game.matchId !== room.matchId || room.matchStartedAt !== game.lifecycle.startedAt || game.actionLimit !== room.hyakkiConfig.actionLimit
      || goodsPerTypeOf(game) !== goodsPerTypeOf(room.hyakkiConfig)
      || !Array.isArray(room.matchParticipants) || room.matchParticipants.length !== 2
      || new Set(room.matchParticipants.map(entry => entry.userKey)).size !== 2
      || room.matchParticipants.some(entry => !exactFields(entry, ['playerId', 'name', 'userKey']) || !ids.includes(entry.playerId)
        || !/^[a-f0-9]{64}$/u.test(entry.userKey ?? '') || typeof entry.name !== 'string' || !entry.name.length)
      || new Set(room.matchParticipants.map(entry => entry.playerId)).size !== 2
      || room.players.some(player => { const frozen = room.matchParticipants.find(entry => entry.playerId === player.id);
        return !frozen || frozen.userKey !== player.userKey || frozen.name !== player.name; })
      || room.spectators.some(player => ids.includes(player.id))) return '冻结参赛者与房间不一致。';
  const clock = hyakkiGameClock(game);
  const expected = clock ? { version: 4, kind: clock.kind, id: clock.id, deadlineAt: clock.deadlineAt,
    remainingMs: clock.remainingMs, paused: clock.paused, label: clock.label, matchId: room.matchId } : null;
  if (expected ? !exactFields(room.turnClock, Object.keys(expected)) || Object.keys(expected).some(key => expected[key] !== room.turnClock[key]) : room.turnClock !== null) return '房间与游戏时钟不一致。';
  if (game.status === 'playing' ? !['playing', 'paused'].includes(room.phase) || clock.paused !== (room.phase === 'paused')
      : room.phase !== game.status || room.matchEndedAt !== game.result.settledAt) return '房间和终局阶段不一致。';
  return null;
}

export function createHyakkiAdapter({ maxSnapshotBytes = 256 * 1024 } = {}) {
  return Object.freeze({ gameType, minPlayers: 2, maxPlayers: 2, ruleVersions: Object.freeze([DIGITAL_RULE_VERSION]),
    actionTypes: Object.freeze(Object.keys(actionExtras)), configurationFields: Object.freeze(['hyakkiConfig']),
    usesActionIntents: true, usesPresenceLifecycle: true, maxSnapshotBytes, historyPlayerFields: Object.freeze(['wealth']),
    actionFields: type => Object.hasOwn(actionExtras, type) ? [...fences, ...actionExtras[type]] : null,
    validateAction: action => Object.hasOwn(actionExtras, action?.type) ? actionProblem(action) : null,
    createGame: (players, options) => core.createGame(players.map(player => player.id), options),
    gameOptions(room, options) {
      const source = options.serverRandomInt ?? randomInt, first = source(2);
      if (!integer(first, 0, 1)) throw new TypeError('服务端随机结果无效。');
      return { matchId: options.matchId, actionLimit: room.hyakkiConfig.actionLimit, goodsPerType: goodsPerTypeOf(room.hyakkiConfig), firstPlayerId: room.players[first].id,
        now: options.now, presence: options.presence, randomInt: source };
    },
    applyGameAction(game, actorId, action, context) {
      const invalid = actionProblem(action); if (invalid) return fail(invalid);
      try { return core.applyGameAction(game, actorId, domainAction(action), { now: context.now, randomInt: context.serverRandomInt ?? randomInt }); }
      catch (error) { if (error.name === 'RuleError') return { ok: false, error: error.message, code: error.code }; throw error; }
    },
    privateView, spectatorView, stateProblem: gameProblem, gameEndedAt: game => game.result.settledAt,
    roomDefaults: () => ({ turnClock: null, hyakkiConfig: { actionLimit: DEFAULT_ACTION_LIMIT, goodsPerType: DEFAULT_GOODS_PER_TYPE } }),
    playersChanged(room) { if (room.phase === 'waiting') for (const player of room.players) player.ready = false; },
    configurationSupportProblem: () => null,
    configure(room, action) {
      if (!validConfiguration(action.hyakkiConfig)) return { problem: problem(400, 'INVALID_CONFIG', '每回合行动上限须为1～10步，每类货物须为4～20件。') };
      const config = action.hyakkiConfig;
      return { updates: { hyakkiConfig: { actionLimit: config.actionLimit,
        goodsPerType: Object.hasOwn(config, 'goodsPerType') ? config.goodsPerType : goodsPerTypeOf(room.hyakkiConfig) } } };
    },
    roomView: room => ({ hyakkiConfig: { ...clone(room.hyakkiConfig), goodsPerType: goodsPerTypeOf(room.hyakkiConfig) }, exitPolicy: 'resign' }),
    playerSummary: (view, playerId) => ({ handCount: view?.players.find(player => player.id === playerId)?.handCount ?? 0 }),
    playerResult(result, playerId) { return { outcome: result?.aborted ? 'unscored'
      : result?.winnerIds?.includes(playerId) ? 'win' : result ? 'loss' : 'unscored', remainingPoints: null,
      wealth: result?.wealth?.find(entry => entry.playerId === playerId)?.silver ?? null }; },
    historyPlayerProblem: (status, player) => player.remainingPoints !== null || !integer(player.wealth)
      || (status === 'aborted' ? player.outcome !== 'unscored' : !['win', 'loss'].includes(player.outcome)),
    historyOutcomeProblem: (wins, draws, count) => count !== 2 || wins !== 1 || draws !== 0,
    historySummaryProblem(summary) {
      if (summary.status === 'aborted') return !['absence-expired', 'room-expired', 'cancelled'].includes(summary.reason);
      if (!['normal-close', 'voluntary-leave'].includes(summary.reason)) return true;
      if (summary.reason === 'normal-close') {
        const winner = summary.players.find(player => player.outcome === 'win');
        return !winner || summary.players.some(player => player.wealth > winner.wealth);
      }
      return false;
    },
    snapshotSchema: () => 13,
    snapshotProblem: data => ![12, 13].includes(data?.schemaVersion) || data.gameType !== gameType || !Object.hasOwn(data, 'turnClock')
      || data.schemaVersion === 12 && (Object.hasOwn(data.hyakkiConfig ?? {}, 'goodsPerType') || Object.hasOwn(data.game ?? {}, 'goodsPerType'))
      || Buffer.byteLength(JSON.stringify(data), 'utf8') > maxSnapshotBytes,
    roomStateProblem, gameStatusForRoomPhase: phase => ['finished', 'aborted'].includes(phase) ? phase : 'playing',
    turnTimeoutMs: () => 0, gameClock: hyakkiGameClock, roomRetentionDeadline: hyakkiRetentionDeadline,
    commonActionProblem(room, _id, action, context) { const issue = hyakkiCommonActionProblem(room.game, action, context);
      return issue ? problem(409, 'GAME_HELD', issue) : null; },
    onPhaseChanged(game, phase, now, context) {
      const change = changeHyakkiPause(game, phase, now, context);
      if (change.ok && JSON.stringify(change.state) !== JSON.stringify(game)) record(change.state, [{ type: phase === 'paused' ? 'paused' : 'resumed' }], now);
      return change;
    },
    lifecycleTransition: lifecycle,
    actionDeadline(room, action) {
      if (!room.game || room.game.status !== 'playing') return null;
      const life = room.game.lifecycle;
      const dates = [life.manual?.deadlineAt, life.absence?.deadlineAt,
        Object.hasOwn(actionExtras, action.type) ? hyakkiGameClock(room.game)?.deadlineAt : null].filter(Number.isSafeInteger);
      return dates.length ? Math.min(...dates) : null;
    },
    supportsTimeout: game => gameProblem(game) === null && hyakkiGameClock(game) !== null,
    applyTimeout: (game, actorId, context = {}) => core.applyTimeout(game, actorId ?? (game.timing.decision ?? game.timing.active).actorId, { now: context.now ?? hyakkiGameClock(game)?.deadlineAt,
      randomInt: context.serverRandomInt ?? randomInt }),
    describeAction: ({ player }) => `${player.name}完成了操作。`, describeTimeout: () => '已按本步骤的默认选择完成超时处理。',
  });
}

/** Trusted material/event projector; never accepts caller-provided write sets. */
export function createHyakkiTransitionPreparers(storage, { now = Date.now, capacityBytes } = {}) {
  const store = createHyakkiEventStore({ storage, now, ...(capacityBytes === undefined ? {} : { capacityBytes }) });
  return new Map([[gameType, store.transitionPreparer(({ previous, next }) => {
    const room = next?.snapshot, before = previous?.snapshot;
    if (!room?.game) {
      const ended = next?.pendingRecords?.find(summary => summary.matchId === before?.matchId);
      if (!before?.game || before.game.status !== 'playing' || !ended) return null;
      return { match: { roomId: before.roomId, matchId: before.matchId, ruleVersion: before.game.ruleVersion,
        contentVersion: before.game.contentVersion, startedAt: before.matchStartedAt,
        participants: before.matchParticipants.map(player => ({ seatId: player.playerId, userKey: player.userKey })) },
        sequence: before.game.publicEventSequence + 1, commitId: `${before.matchId}-${before.game.publicEventSequence + 1}`,
        committedAt: ended.endedAt, mode: 'terminal', events: [{ type: 'match-ended', reason: ended.reason,
          winnerSeatId: ended.players.find(player => player.outcome === 'win')?.seatId ?? null }] };
    }
    if (room.game.publicEventSequence === before?.game?.publicEventSequence && room.matchId === before?.matchId) return null;
    const game = room.game;
    return { match: { roomId: room.roomId, matchId: room.matchId, ruleVersion: game.ruleVersion, contentVersion: game.contentVersion,
      startedAt: room.matchStartedAt, participants: room.matchParticipants.map(player => ({ seatId: player.playerId, userKey: player.userKey })) },
      sequence: game.publicEventSequence, commitId: `${room.matchId}-${game.publicEventSequence}`, committedAt: game.committedAt,
      mode: ['finished', 'aborted'].includes(game.status) ? 'terminal' : game.lifecycle.capacity && !before?.game?.lifecycle.capacity ? 'capacity'
        : !game.lifecycle.capacity && before?.game?.lifecycle.capacity ? 'resume' : 'normal', events: game.lastPublicEvents };
  })]]);
}
