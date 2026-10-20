/** Version-dispatching adapter for frozen legacy, configurable base and expansion games. */
import { randomInt } from 'node:crypto';
import * as core from '../../../app/games/hyakki-trading/configured/rules.mjs';
import { privateView, spectatorView } from '../../../app/games/hyakki-trading/configured/view.mjs';
import { gameProblem, plainObject, exactFields, integer, seatId, validCopy } from '../../../app/games/hyakki-trading/configured/validation.mjs';
import { PLAYER_COUNT_CONTENT_VERSION, materialProfile, materialProfileFor } from '../../../app/games/hyakki-trading/configured/material.mjs';
import { recommendedGoodsPerType } from '../../../app/games/hyakki-trading/content/player-count-profile.mjs';
import { currentDecision } from '../../../app/games/hyakki-trading/decision.mjs';
import { goodsPerTypeOf } from '../../../app/games/hyakki-trading/configured/model.mjs';
import { transitionHyakkiLifecycle, hyakkiCommonActionProblem, changeHyakkiPause,
  hyakkiGameClock, hyakkiRetentionDeadline } from '../../../app/games/hyakki-trading/lifecycle.mjs';
import { problem } from '../adapter-contract.mjs';
import {isOpeningHistoryGame} from './opening-history.mjs';
import {createHyakkiOpeningContractAdapter} from './opening-contract-adapter.mjs';
import {waitingConfiguration,updateWaitingConfiguration} from '../../../app/games/hyakki-trading/opening-configuration.mjs';
import {CONFIGURABLE_RULE_VERSION} from '../../../app/games/hyakki-trading/content/expansion-one.mjs';
import {createHyakkiAdapter} from './adapter.mjs';
import {isConfiguredBase,baseToLegacy,wrapBase,baseGameProblem,createConfiguredBase,baseAction,baseTimeout,basePrivateView,baseSpectatorView} from '../../../app/games/hyakki-trading/configured/base.mjs';

const gameType = 'hyakki-trading';
const clone = value => structuredClone(value);
const fences = ['matchId', 'turnId', 'effectId', 'decisionId'];
const actionExtras = Object.freeze({ peek: ['inspect'], 'keep-peek': [], 'discard-peek': [], 'finish-draw': [], 'end-turn': [],
  buy: ['cardId','materials'], sell: ['cardId','materials'], 'use-role':['params'], 'buy-stall': ['cardId'], 'play-character': ['cardId', 'params'],
  'install-tool': ['cardId', 'replaceCardId'], 'activate-tool': ['cardId', 'params'], respond: ['cardId'],
  'decline-response': [], 'choose-effect': ['selection'], bid: ['amount'], 'pass-bid': [] });
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/\p{Cc}/u.test(value);
const modeOf = config => config.goodsSupplyMode ?? 'custom';
const waitingCount = room => Math.max(2, room.players?.length ?? 2);
const effectiveGoods = room => modeOf(room.hyakkiConfig) === 'recommended'
  ? recommendedGoodsPerType(room.game?.players.length ?? waitingCount(room)) : goodsPerTypeOf(room.hyakkiConfig);
const reference = (value, profile) => validCopy(value, profile) || typeof value === 'string' && /^(?:tool-[0-5]|discard|pool|source):\d+:\d+$/u.test(value);
const jsonInput = (value, profile, depth = 0) => depth < 7 && (value === null || typeof value === 'boolean' || integer(value)
  || typeof value === 'string' && value.length <= 180 && (!validCopy(value) || validCopy(value, profile))
  || Array.isArray(value) && value.length <= profile.deckSize && value.every(item => jsonInput(item, profile, depth + 1))
  || plainObject(value) && Object.keys(value).length <= 12 && Object.entries(value).every(([key, item]) => /^[A-Za-z][A-Za-z0-9-]{0,40}$/u.test(key) && jsonInput(item, profile, depth + 1)));
// The transport parser does not own a match. The second validation at apply
// uses its frozen profile; a legacy match never accepts the larger material set.
function actionProblem(action, profile = materialProfile(PLAYER_COUNT_CONTENT_VERSION, 6)) {
  if (!plainObject(action) || !Object.hasOwn(actionExtras, action.type)) return problem(400, 'INVALID_ACTION', '幽街操作无效。');
  const allowed = ['type', 'requestId', 'expectedRevision', ...fences, ...actionExtras[action.type]];
  if (Object.keys(action).some(key => !allowed.includes(key)) || !seatId(action.matchId) || !/^turn-[1-9]\d*$/u.test(action.turnId ?? '')
      || typeof action.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(action.requestId) || !integer(action.expectedRevision)
      || (action.effectId !== undefined && !token(action.effectId)) || (action.decisionId !== undefined && !token(action.decisionId))) {
    return problem(400, 'INVALID_ACTION', '操作需要当前对局、回合与有效请求编号。');
  }
  if(action.inspect!==undefined&&typeof action.inspect!=='boolean'||action.materials!==undefined&&(!plainObject(action.materials)||!jsonInput(action.materials,profile)))return problem(400,'INVALID_ACTION','具体货物或摸牌选项无效。');
  if (actionExtras[action.type].includes('cardId') && !reference(action.cardId, profile)
      || action.replaceCardId !== undefined && !reference(action.replaceCardId, profile)
      || action.params !== undefined && (!plainObject(action.params) || !jsonInput(action.params, profile))
      || action.type === 'choose-effect' && !jsonInput(action.selection, profile)
      || action.type === 'bid' && !integer(action.amount, 1)) return problem(400, 'INVALID_ACTION', '请选择合法的牌、目标或金额。');
  if (Object.hasOwn(action.params ?? {}, 'initialChoices') && (action.type !== 'play-character'
      || !Array.isArray(action.params.initialChoices) || action.params.initialChoices.length < 1 || action.params.initialChoices.length > 2
      || action.params.initialChoices.some(step => !exactFields(step, ['kind', 'selection'])
        || !token(step.kind) || !plainObject(step.selection)))) return problem(400, 'INVALID_ACTION', '人物预选步骤无效。');
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
  if(!hasRoles||room.gameType!==gameType||JSON.stringify(waitingConfiguration(room.hyakkiConfig,{playerCount:room.game?.players.length??Math.max(2,room.players.length)}))!==JSON.stringify(room.hyakkiConfig))return '幽街房间设置无效。';
  if (!room.game) return room.phase !== 'waiting' || room.turnClock !== null
    || effectiveGoods(room) !== goodsPerTypeOf(room.hyakkiConfig) ? '等待房间状态无效。' : null;
  const issue = gameProblem(room.game); if (issue) return issue;
  const game = room.game, ids = game.players.map(player => player.id);
  if (game.matchId !== room.matchId || room.matchStartedAt !== game.lifecycle.startedAt || game.actionLimit !== room.hyakkiConfig.actionLimit
      || goodsPerTypeOf(game) !== goodsPerTypeOf(room.hyakkiConfig) || effectiveGoods(room) !== goodsPerTypeOf(game)
      || !Array.isArray(room.matchParticipants) || room.matchParticipants.length !== ids.length
      || new Set(room.matchParticipants.map(entry => entry.userKey)).size !== ids.length
      || room.matchParticipants.some((entry, index) => !exactFields(entry, ['playerId', 'name', 'userKey']) || entry.playerId !== ids[index]
        || !/^[a-f0-9]{64}$/u.test(entry.userKey ?? '') || typeof entry.name !== 'string' || !entry.name.length)
      || new Set(room.matchParticipants.map(entry => entry.playerId)).size !== ids.length
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

function createOrdinaryConfiguredAdapter() {
  return Object.freeze({ actionTypes: Object.freeze(Object.keys(actionExtras)),
    actionFields: type => Object.hasOwn(actionExtras, type) ? [...fences, ...actionExtras[type]] : null,
    validateAction: action => Object.hasOwn(actionExtras, action?.type) ? actionProblem(action) : null,
    applyGameAction(game, actorId, action, context) {
      const invalid = actionProblem(action, materialProfileFor(game)); if (invalid) return fail(invalid);
      try { return core.applyGameAction(game, actorId, domainAction(action), { now: context.now, randomInt: context.serverRandomInt ?? randomInt }); }
      catch (error) { if (error.name === 'RuleError') return { ok: false, error: error.message, code: error.code }; throw error; }
    },
    privateView, spectatorView, stateProblem: gameProblem, gameEndedAt: game => game.result.settledAt,
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

const configured=game=>game?.version===3&&game.ruleVersion===CONFIGURABLE_RULE_VERSION&&!isOpeningHistoryGame(game);
/** One registry slot routes each match by its frozen rule and material versions. */
export function createConfiguredHyakkiAdapter(){
  const ordinary=createOrdinaryConfiguredAdapter(),opening=createHyakkiOpeningContractAdapter({initializeGame:core.fromOpening}),legacy=createHyakkiAdapter();
  const oldRoom=room=>({...room,game:baseToLegacy(room.game),hyakkiConfig:{actionLimit:room.hyakkiConfig.actionLimit,
    goodsPerType:room.hyakkiConfig.goodsPerType,goodsSupplyMode:room.hyakkiConfig.goodsSupplyMode}});
  const wrapped=(result,game)=>result.ok&&result.state?{...result,state:wrapBase(result.state,game.configuration)}:result;
  return Object.freeze({...opening,
    actionTypes:Object.freeze([...new Set([...opening.actionTypes,...ordinary.actionTypes])]),
    actionFields:type=>['confirm-role','cancel-opening'].includes(type)?opening.actionFields(type):ordinary.actionFields(type),
    validateAction(action){
      if(['confirm-role','cancel-opening'].includes(action?.type))return opening.validateAction(action);
      const issue=ordinary.validateAction(action);
      // Transport lacks a match. Accept either frozen catalog here; apply is
      // always validated again against the actual original/expansion profile.
      return issue&&legacy.actionTypes.includes(action?.type)&&legacy.validateAction(action)===null?null:issue;
    },
    gameOptions(room,options){
      if(room.hyakkiConfig.packId!=='base')return opening.gameOptions(room,options);
      const source=options.serverRandomInt??randomInt,index=source(room.players.length);
      if(!integer(index,0,room.players.length-1))throw new TypeError('服务端首家随机结果无效。');
      return {baseConfiguration:room.hyakkiConfig,matchId:options.matchId,now:options.now,randomInt:source,
        firstPlayerId:room.players[index].id,presence:options.presence};
    },
    createGame:(players,options)=>options.baseConfiguration?createConfiguredBase(players.map(p=>p.id),
      {...options,configuration:options.baseConfiguration}):opening.createGame(players,options),
    configure(room,action){
      if(!Object.hasOwn(room.hyakkiConfig,'packId')&&!Object.hasOwn(action.hyakkiConfig??{},'packId')&&!Object.hasOwn(action.hyakkiConfig??{},'closingTarget'))return legacy.configure(room,action);
      try{return {updates:{hyakkiConfig:updateWaitingConfiguration(room.hyakkiConfig,action.hyakkiConfig,Math.max(2,room.players.length)).configuration}};}
      catch(error){if(error instanceof RangeError)return {problem:problem(400,'INVALID_CONFIG',error.message)};throw error;}
    },
    applyGameAction(game,actor,action,context){
      if(!isConfiguredBase(game))return configured(game)?ordinary.applyGameAction(game,actor,action,context):opening.applyGameAction(game,actor,action,context);
      const issue=legacy.validateAction(action);return issue?fail(issue):baseAction(game,actor,domainAction(action),{now:context.now,randomInt:context.serverRandomInt??randomInt});
    },
    privateView:(game,...args)=>isConfiguredBase(game)?basePrivateView(game,...args):configured(game)?ordinary.privateView(game,...args):opening.privateView(game,...args),
    spectatorView:(game,...args)=>isConfiguredBase(game)?baseSpectatorView(game,...args):configured(game)?ordinary.spectatorView(game,...args):opening.spectatorView(game,...args),
    stateProblem:game=>isConfiguredBase(game)?baseGameProblem(game):configured(game)?ordinary.stateProblem(game):opening.stateProblem(game),
    roomStateProblem:(room,...args)=>isConfiguredBase(room.game)?baseGameProblem(room.game)||legacy.roomStateProblem(oldRoom(room),...args)
      :configured(room.game)?ordinary.roomStateProblem(room,...args):opening.roomStateProblem(room,...args),
    roomView:room=>configured(room.game)?{hyakkiConfig:clone(room.hyakkiConfig),exitPolicy:room.game.players.length===2?'resign':'cancel'}:opening.roomView(room),
    gameClock:game=>configured(game)?ordinary.gameClock(game):opening.gameClock(game),
    supportsTimeout:game=>isConfiguredBase(game)?legacy.supportsTimeout(baseToLegacy(game)):configured(game)?ordinary.supportsTimeout(game):opening.supportsTimeout(game),
    applyTimeout:(game,actor,context)=>isConfiguredBase(game)?baseTimeout(game,actor,{now:context.now,randomInt:context.serverRandomInt??randomInt})
      :configured(game)?ordinary.applyTimeout(game,actor,context):opening.applyTimeout(game,actor,context),
    commonActionProblem:(room,...args)=>configured(room.game)?ordinary.commonActionProblem(room,...args):opening.commonActionProblem(room,...args),
    onPhaseChanged:(game,...args)=>isConfiguredBase(game)?wrapped(legacy.onPhaseChanged(baseToLegacy(game),...args),game)
      :configured(game)?ordinary.onPhaseChanged(game,...args):opening.onPhaseChanged(game,...args),
    lifecycleTransition:(game,...args)=>isConfiguredBase(game)?wrapped(legacy.lifecycleTransition(baseToLegacy(game),...args),game)
      :configured(game)?ordinary.lifecycleTransition(game,...args):opening.lifecycleTransition(game,...args),
    actionDeadline:(room,...args)=>configured(room.game)?ordinary.actionDeadline(room,...args):opening.actionDeadline(room,...args),
    roomRetentionDeadline:game=>configured(game)?ordinary.roomRetentionDeadline(game):opening.roomRetentionDeadline(game),
  });
}
