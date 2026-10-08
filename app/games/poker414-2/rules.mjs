/**
 * Authoritative pure 414 state machine. Its caller owns authentication, request
 * receipts, CAS, presence and score persistence. Time and randomness are inputs;
 * nothing in this module can schedule, broadcast, store, or authenticate.
 */
import { makeDeck, getCard } from './cards.mjs';
import { cardsProblem, compareCardIds, classifyPattern, beatsPattern, chooseResponseCards,
  remainingPenalty, patternProblem } from './patterns.mjs';

export const GAME_TYPE = 'poker414-2';
export const RULE_VERSION = 'poker414-2-v2';
export const SCORING_VERSION = 'poker414-2-score-v1';
export const STATE_VERSION = 1;
export const RESPONSE_MS = 5000;
export const DISCONNECT_MS = 120000;

const STATE_KEYS = ['version', 'gameType', 'ruleVersion', 'scoringVersion', 'matchId', 'revision',
  'eventSeq', 'createdAt', 'updatedAt', 'players', 'seatOrder', 'actionOrder', 'firstDealerId',
  'deck', 'dealCursor', 'dealBatchSize', 'dealIntervalMs', 'stage', 'status', 'firstPlayerId',
  'firstHeart3', 'roundId', 'turnPlayerId', 'target', 'passedPlayerIds', 'responseWindow',
  'playedIds', 'moves', 'notices', 'result'];
const TARGET_KEYS = ['id', 'ownerId', 'cardIds', 'pattern', 'source', 'rootId', 'sourceTargetId'];
const MOVE_KEYS = ['eventId', 'type', 'playerId', 'cardIds', 'targetId', 'rootId', 'sourceTargetId', 'roundId', 'at'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER - 1000000) => Number.isSafeInteger(value) && value >= min && value <= max;
const idValid = value => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exactArray = (value, min, max) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && value.length >= min && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, index) => index).every(index => Object.hasOwn(value, index)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, index), 'value'));
const failure = (state, code, error) => ({ ok: false, state, code, error });
const success = (state, changed = true) => ({ ok: true, state, changed });
const nextPlayer = (game, playerId) => game.actionOrder[(game.actionOrder.indexOf(playerId) + 1) % game.actionOrder.length];
const active = game => game.status === 'playing';

function shuffle(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const value = random();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) throw new TypeError('随机源必须返回0至1之间的数。');
    const target = Math.floor(value * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

/** Creates a locked match before the first deal batch. IDs are stable seats, never display names. */
export function createGame({ players, matchId, random, now, dealBatchSize = 18, dealIntervalMs = 500, ...extra }) {
  if (Object.keys(extra).length || !exactArray(players, 3, 8) || players.some(id => !idValid(id))
      || new Set(players).size !== players.length || !idValid(matchId) || typeof random !== 'function'
      || !integer(now) || !integer(dealBatchSize, 1, 108) || !integer(dealIntervalMs, 1, 10000)) {
    throw new TypeError('开局需要3～8个唯一席位、对局编号、服务端时间和随机源。');
  }
  const seatOrder = shuffle(players, random), actionOrder = [seatOrder[0], ...seatOrder.slice(1).reverse()];
  const dealerRandom = random();
  if (typeof dealerRandom !== 'number' || !Number.isFinite(dealerRandom) || dealerRandom < 0 || dealerRandom >= 1) throw new TypeError('首摸者随机源无效。');
  return { version: STATE_VERSION, gameType: GAME_TYPE, ruleVersion: RULE_VERSION, scoringVersion: SCORING_VERSION,
    matchId, revision: 0, eventSeq: 0, createdAt: now, updatedAt: now,
    players: seatOrder.map(id => ({ id, hand: [] })), seatOrder, actionOrder,
    firstDealerId: actionOrder[Math.floor(dealerRandom * players.length)],
    deck: shuffle(makeDeck().map(card => card.id), random), dealCursor: 0, dealBatchSize, dealIntervalMs,
    stage: 'dealing', status: 'playing', firstPlayerId: null, firstHeart3: null,
    roundId: 1, turnPlayerId: null, target: null, passedPlayerIds: [], responseWindow: null,
    playedIds: [], moves: [], notices: [], result: null };
}

function expectedOwner(game, dealIndex) {
  return game.actionOrder[(game.actionOrder.indexOf(game.firstDealerId) + dealIndex) % game.actionOrder.length];
}

function expectedResponse(target) {
  if (!target || target.pattern.rank > 15) return null;
  if (target.source === 'play') {
    if (target.pattern.kind === 'single') return 'fork';
    if (target.pattern.kind === 'pair') return 'hook';
    return null;
  }
  const action = target.source === 'fork' ? 'hook' : 'fork';
  return target.cardIds.length + (action === 'hook' ? 1 : 2) <= 8 ? action : null;
}

function appendNotice(game, type, playerId, at) {
  game.eventSeq += 1;
  const eventId = `${game.matchId}:e${game.eventSeq}`;
  game.notices.push({ eventId, type, playerId, at });
  if (game.notices.length > 1024) game.notices.shift();
  return eventId;
}

function setWindow(game, now) {
  const action = expectedResponse(game.target);
  game.responseWindow = action ? { id: `${game.target.id}:response`, targetId: game.target.id,
    action, rank: game.target.pattern.rank, deadlineAt: now + RESPONSE_MS } : null;
}

function newRound(game, playerId) {
  game.roundId += 1;
  game.turnPlayerId = playerId;
  game.target = null;
  game.passedPlayerIds = [];
  game.responseWindow = null;
}

function settlement(game, reason, winnerId, responsiblePlayerId, now) {
  const penalties = game.players.map(player => remainingPenalty(player.hand).points);
  const total = penalties.reduce((sum, value) => sum + value, 0);
  return { accountGroup: '4a4', gameType: GAME_TYPE, ruleVersion: RULE_VERSION,
    scoringVersion: SCORING_VERSION, matchId: game.matchId, settlementVersion: 0,
    reason, winnerId, responsiblePlayerId, settledAt: now,
    deltas: game.players.map((player, index) => ({ playerId: player.id,
      points: reason === 'emptied-hand' ? player.id === winnerId ? total : -penalties[index]
        : reason === 'voluntary-leave' ? player.id === responsiblePlayerId ? -5 * (game.players.length - 1) : 5 : 0 })) };
}

function finish(game, winnerId, now) {
  game.status = 'finished'; game.stage = 'finished'; game.turnPlayerId = null;
  game.responseWindow = null; game.passedPlayerIds = [];
  game.result = settlement(game, 'emptied-hand', winnerId, null, now);
}

function finishChange(game, now) { game.revision += 1; game.updatedAt = now; return success(game); }

/** Explicit server deadline; response expiry never ends an ordinary player turn. */
export function gameClock(game) {
  if (!active(game)) return null;
  if (game.stage === 'dealing') return { kind: 'deal', id: `${game.matchId}:deal:${game.dealCursor}`,
    deadlineAt: game.createdAt + (Math.floor(game.dealCursor / game.dealBatchSize) + 1) * game.dealIntervalMs };
  if (game.responseWindow) return { kind: 'response', id: game.responseWindow.id, deadlineAt: game.responseWindow.deadlineAt };
  return null;
}

function inputProblem(game, options) {
  const problem = gameProblem(game);
  if (problem) return failure(game, 'INVALID_STATE', problem);
  if (!exactKeys(options, ['now']) || !integer(options.now) || options.now < game.updatedAt) {
    return failure(game, 'INVALID_TIME', '服务端时间无效。');
  }
  return null;
}

export function advanceGame(game, options) {
  const problem = inputProblem(game, options);
  if (problem) return problem;
  const { now } = options, clock = gameClock(game);
  if (!clock || now < clock.deadlineAt) return success(game, false);
  const state = structuredClone(game);
  if (clock.kind === 'response') {
    state.responseWindow = null;
    appendNotice(state, 'response-expired', null, now);
    return finishChange(state, now);
  }
  const end = Math.min(108, Math.floor((now - state.createdAt) / state.dealIntervalMs) * state.dealBatchSize);
  for (let index = state.dealCursor; index < end; index += 1) {
    const id = state.deck[index], owner = expectedOwner(state, index);
    state.players.find(player => player.id === owner).hand.push(id);
    const card = getCard(id);
    if (!state.firstHeart3 && card.suit === 'hearts' && card.rank === 3) {
      state.firstHeart3 = { cardId: id, dealIndex: index, playerId: owner };
      state.firstPlayerId = owner;
    }
  }
  state.dealCursor = end;
  for (const player of state.players) player.hand.sort(compareCardIds);
  if (end === 108) { state.stage = 'playing'; state.turnPlayerId = state.firstPlayerId; }
  appendNotice(state, end === 108 ? 'deal-complete' : 'deal-batch', null, now);
  return finishChange(state, now);
}

function actionShapeProblem(action) {
  const common = ['type', 'playerId', 'matchId', 'roundId', 'targetId'];
  const keys = action?.type === 'play' ? [...common, 'cardIds']
    : ['hook', 'fork'].includes(action?.type) ? [...common, 'windowId'] : common;
  if (!exactKeys(action, keys) || !['play', 'pass', 'hook', 'fork'].includes(action.type)
      || !idValid(action.playerId) || !idValid(action.matchId) || !integer(action.roundId, 1)
      || (action.targetId !== null && typeof action.targetId !== 'string')
      || (['hook', 'fork'].includes(action.type) && typeof action.windowId !== 'string')) return '行动字段无效。';
  if (action.type === 'play' && (cardsProblem(action.cardIds, 24) || !action.cardIds.length)) return '出牌实体无效。';
  return null;
}

function recordPlay(state, actor, cardIds, type, now) {
  const prior = state.target;
  state.eventSeq += 1;
  const eventId = `${state.matchId}:e${state.eventSeq}`, targetId = `${eventId}:target`;
  const rootId = type === 'play' ? targetId : prior.rootId;
  const sourceTargetId = type === 'play' ? null : prior.id;
  state.moves.push({ eventId, type, playerId: actor.id, cardIds: [...cardIds], targetId, rootId,
    sourceTargetId, roundId: state.roundId, at: now });
  actor.hand = actor.hand.filter(id => !cardIds.includes(id));
  state.playedIds.push(...cardIds);
  const combined = type === 'play' ? [...cardIds] : [...prior.cardIds, ...cardIds];
  state.target = { id: targetId, ownerId: actor.id, cardIds: combined, pattern: classifyPattern(combined),
    source: type, rootId, sourceTargetId };
  state.passedPlayerIds = [];
  if (!actor.hand.length) finish(state, actor.id, now);
  else if (type === 'play' && state.target.pattern.rocketTier === 3) newRound(state, actor.id);
  else { state.turnPlayerId = nextPlayer(state, actor.id); setWindow(state, now); }
}

/** Business preconditions remain mandatory even if an adapter allows CAS retries for hook/fork. */
export function applyAction(game, action, options) {
  const problem = inputProblem(game, options);
  if (problem) return problem;
  const shapeProblem = actionShapeProblem(action);
  if (shapeProblem) return failure(game, 'INVALID_ACTION', shapeProblem);
  if (!active(game) || game.stage !== 'playing') return failure(game, 'NOT_PLAYING', '当前不能出牌。');
  const player = game.players.find(candidate => candidate.id === action.playerId);
  if (!player) return failure(game, 'NOT_PLAYER', '观众不能出牌。');
  if (action.matchId !== game.matchId || action.roundId !== game.roundId
      || action.targetId !== (game.target?.id || null)) return failure(game, 'STALE_TARGET', '目标已改变，请查看最新牌局。');
  const { now } = options;
  if (action.type === 'play' || action.type === 'pass') {
    if (game.turnPlayerId !== player.id) return failure(game, 'NOT_YOUR_TURN', '还没轮到你出牌。');
  }
  if (action.type === 'pass') {
    if (!game.target) return failure(game, 'MUST_LEAD', '本轮领出不能不出。');
    const state = structuredClone(game);
    if (state.responseWindow && now >= state.responseWindow.deadlineAt) state.responseWindow = null;
    state.passedPlayerIds.push(player.id);
    appendNotice(state, 'pass', player.id, now);
    if (state.passedPlayerIds.length === state.players.length - 1) newRound(state, state.target.ownerId);
    else state.turnPlayerId = nextPlayer(state, player.id);
    return finishChange(state, now);
  }
  if (action.type === 'play') {
    if (action.cardIds.some(id => !player.hand.includes(id))) return failure(game, 'NOT_YOUR_CARD', '只能出自己的手牌。');
    const pattern = classifyPattern(action.cardIds);
    if (!pattern) return failure(game, 'INVALID_PATTERN', '这些牌不能组成合法牌型。');
    if (!beatsPattern(pattern, game.target?.pattern || null)) return failure(game, 'NOT_STRONGER', '不能压过当前牌。');
    const state = structuredClone(game);
    recordPlay(state, state.players.find(candidate => candidate.id === player.id), action.cardIds, 'play', now);
    return finishChange(state, now);
  }
  const window = game.responseWindow;
  if (!window || now >= window.deadlineAt) return failure(game, 'RESPONSE_EXPIRED', '机会已结束。');
  if (action.windowId !== window.id || action.type !== window.action) return failure(game, 'STALE_WINDOW', '勾叉机会已改变。');
  if (player.id === game.target.ownerId) return failure(game, 'OWN_TARGET', '不能接自己的牌。');
  const ids = chooseResponseCards(player.hand, window.rank, action.type);
  if (!ids) return failure(game, 'INSUFFICIENT_CARDS', '没有足够的同点数手牌。');
  const state = structuredClone(game);
  recordPlay(state, state.players.find(candidate => candidate.id === player.id), ids, action.type, now);
  return finishChange(state, now);
}

/** Voluntary leave is server-authorized by the room, and must commit with its score transaction. */
export function abortGame(game, playerId, options) {
  const problem = inputProblem(game, options);
  if (problem) return problem;
  if (!active(game)) return failure(game, 'ALREADY_ENDED', '对局已经结束。');
  if (!game.players.some(player => player.id === playerId)) return failure(game, 'NOT_PLAYER', '观众退出不影响牌局。');
  const state = structuredClone(game);
  state.status = 'aborted'; state.stage = 'aborted'; state.turnPlayerId = null;
  state.responseWindow = null; state.passedPlayerIds = [];
  state.result = settlement(state, 'voluntary-leave', null, playerId, options.now);
  appendNotice(state, 'voluntary-leave', playerId, options.now);
  return finishChange(state, options.now);
}

/** Only a server lifecycle call can use this function; it accepts no client-declared elapsed time. */
export function cancelGame(game, reason, options) {
  const problem = inputProblem(game, options);
  if (problem) return problem;
  if (!['disconnected', 'server-recovery', 'room-expired'].includes(reason)) return failure(game, 'INVALID_REASON', '取消原因无效。');
  if (!active(game)) return success(game, false);
  const state = structuredClone(game);
  state.status = 'cancelled'; state.stage = 'cancelled'; state.turnPlayerId = null;
  state.responseWindow = null; state.passedPlayerIds = [];
  state.result = settlement(state, reason, null, null, options.now);
  appendNotice(state, reason, null, options.now);
  return finishChange(state, options.now);
}

/** This boolean alone is not authorization: the room must guard all-connection presence versions. */
export function disconnectExpired({ lastSeenAt, now, hasLiveConnection }) {
  if (!integer(lastSeenAt) || !integer(now) || now < lastSeenAt || typeof hasLiveConnection !== 'boolean') throw new TypeError('失联状态无效。');
  return !hasLiveConnection && now - lastSeenAt >= DISCONNECT_MS;
}

export function restoreGame(snapshot, options) {
  const problem = inputProblem(snapshot, options);
  if (problem) return problem;
  return active(snapshot) ? cancelGame(snapshot, 'server-recovery', options) : success(structuredClone(snapshot), false);
}

/** No deck, future deal order, timestamps about private picks, or non-public IDs leave this boundary. */
export function projectGame(game, { playerId = null, role }) {
  const problem = gameProblem(game);
  if (problem) throw new TypeError(problem);
  if (!['player', 'spectator'].includes(role) || (role === 'player' && !game.players.some(player => player.id === playerId))) {
    throw new TypeError('读取牌局需要有效成员角色。');
  }
  return structuredClone({ version: game.version, gameType: GAME_TYPE, ruleVersion: RULE_VERSION,
    matchId: game.matchId, revision: game.revision, eventSeq: game.eventSeq,
    stage: game.stage, status: game.status, seatOrder: game.seatOrder, actionOrder: game.actionOrder,
    players: game.players.map(player => ({ id: player.id, handCount: player.hand.length,
      ...(role === 'spectator' || player.id === playerId ? { hand: player.hand } : {}) })),
    deckCount: 108 - game.dealCursor, firstPlayerId: game.firstPlayerId, roundId: game.roundId,
    turnPlayerId: game.turnPlayerId, nextPlayerId: game.turnPlayerId ? nextPlayer(game, game.turnPlayerId) : null,
    target: game.target, passedPlayerIds: game.passedPlayerIds, responseWindow: game.responseWindow,
    playedIds: game.playedIds, moves: game.moves, notices: game.notices, result: game.result });
}

function movesProblem(game, owners) {
  const targets = new Map(), flattened = [], eventIds = new Set();
  let previous = null;
  for (const move of game.moves) {
    if (!exactKeys(move, MOVE_KEYS) || !['play', 'hook', 'fork'].includes(move.type)
        || !game.seatOrder.includes(move.playerId) || cardsProblem(move.cardIds, 24) || !move.cardIds.length
        || !integer(move.roundId, 1, game.roundId) || !integer(move.at, game.createdAt, game.updatedAt)
        || typeof move.eventId !== 'string' || eventIds.has(move.eventId)
        || move.targetId !== `${move.eventId}:target` || targets.has(move.targetId)
        || move.cardIds.some(id => owners.get(id) !== move.playerId)
        || (previous && (move.at < previous.at || move.roundId < previous.roundId))) return '公开行动记录无效。';
    eventIds.add(move.eventId); flattened.push(...move.cardIds);
    let ids = move.cardIds;
    if (move.type === 'play') {
      if (move.rootId !== move.targetId || move.sourceTargetId !== null || !classifyPattern(ids)
          || (previous && previous.roundId === move.roundId
            && !beatsPattern(classifyPattern(ids), targets.get(previous.targetId).pattern))) return '直接出牌记录无效。';
    } else {
      const prior = targets.get(move.sourceTargetId);
      if (!prior || prior.ownerId === move.playerId || expectedResponse(prior) !== move.type
          || move.sourceTargetId !== previous?.targetId || move.roundId !== previous.roundId
          || move.at >= previous.at + RESPONSE_MS
          || move.cardIds.length !== (move.type === 'hook' ? 1 : 2)
          || move.cardIds.some(id => getCard(id).rank !== prior.pattern.rank)
          || move.rootId !== prior.rootId) return '勾叉来源或实体无效。';
      ids = [...prior.cardIds, ...move.cardIds];
    }
    targets.set(move.targetId, { id: move.targetId, ownerId: move.playerId, cardIds: ids,
      pattern: classifyPattern(ids), source: move.type, rootId: move.rootId, sourceTargetId: move.sourceTargetId });
    previous = move;
  }
  if (!same(flattened, game.playedIds)) return '公牌实体与行动记录不一致。';
  if (game.target !== null && (!exactKeys(game.target, TARGET_KEYS)
      || game.target.id !== game.moves.at(-1)?.targetId
      || !same(targets.get(game.target.id), game.target))) return '当前目标与公开行动不一致。';
  return null;
}

function inspectGame(game) {
  if (!exactKeys(game, STATE_KEYS) || game.version !== STATE_VERSION || game.gameType !== GAME_TYPE
      || game.ruleVersion !== RULE_VERSION || game.scoringVersion !== SCORING_VERSION || !idValid(game.matchId)) return '414存档版本或字段无效。';
  if (!integer(game.revision) || !integer(game.eventSeq) || !integer(game.createdAt)
      || !integer(game.updatedAt, game.createdAt) || !integer(game.roundId, 1)
      || !integer(game.dealCursor, 0, 108) || !integer(game.dealBatchSize, 1, 108)
      || !integer(game.dealIntervalMs, 1, 10000)) return '414计数或时间无效。';
  if (!exactArray(game.players, 3, 8) || game.players.some(player => !exactKeys(player, ['id', 'hand'])
      || !idValid(player.id) || cardsProblem(player.hand)) || new Set(game.players.map(player => player.id)).size !== game.players.length) return '参赛席位或手牌无效。';
  const playerIds = game.players.map(player => player.id);
  if (!same(game.seatOrder, playerIds) || !same(game.actionOrder, [playerIds[0], ...playerIds.slice(1).reverse()])
      || !playerIds.includes(game.firstDealerId)) return '固定座位或逆时针轮序无效。';
  if (!exactArray(game.deck, 108, 108) || cardsProblem(game.deck, 108)
      || !exactArray(game.playedIds, 0, 108) || cardsProblem(game.playedIds, 108)
      || !exactArray(game.moves, 0, 108) || !exactArray(game.notices, 0, 1024)
      || !exactArray(game.passedPlayerIds, 0, game.players.length - 1)
      || new Set(game.passedPlayerIds).size !== game.passedPlayerIds.length
      || game.passedPlayerIds.some(id => !playerIds.includes(id))) return '牌库、公牌或事件范围无效。';
  const actualIds = [...game.deck.slice(game.dealCursor), ...game.players.flatMap(player => player.hand), ...game.playedIds];
  if (actualIds.length !== 108 || new Set(actualIds).size !== 108) return '108张牌必须守恒且区域互斥。';
  const owners = new Map(game.deck.slice(0, game.dealCursor).map((id, index) => [id, expectedOwner(game, index)]));
  if (game.players.some(player => player.hand.some(id => owners.get(id) !== player.id)
      || !same(player.hand, [...player.hand].sort(compareCardIds)))) return '手牌必须属于原发牌席位并稳定排序。';
  const firstIndex = game.deck.findIndex(id => getCard(id).suit === 'hearts' && getCard(id).rank === 3);
  const first = firstIndex < game.dealCursor ? { cardId: game.deck[firstIndex], dealIndex: firstIndex, playerId: expectedOwner(game, firstIndex) } : null;
  if (!same(game.firstHeart3, first) || game.firstPlayerId !== (first?.playerId || null)) return '首张红桃3的正式归属无效。';
  const movementProblem = movesProblem(game, owners);
  if (movementProblem) return movementProblem;
  const eventIds = new Set(game.moves.map(move => move.eventId));
  for (const notice of game.notices) {
    if (!exactKeys(notice, ['eventId', 'type', 'playerId', 'at'])
        || !['deal-batch', 'deal-complete', 'response-expired', 'pass', 'voluntary-leave', 'disconnected', 'server-recovery', 'room-expired'].includes(notice.type)
        || (notice.playerId !== null && !playerIds.includes(notice.playerId))
        || !integer(notice.at, game.createdAt, game.updatedAt) || typeof notice.eventId !== 'string'
        || eventIds.has(notice.eventId)) return '系统事件无效。';
    eventIds.add(notice.eventId);
  }
  for (const eventId of eventIds) {
    const prefix = `${game.matchId}:e`, value = Number(eventId.slice(prefix.length));
    if (!eventId.startsWith(prefix) || !integer(value, 1, game.eventSeq) || String(value) !== eventId.slice(prefix.length)) return '事件编号无效。';
  }
  if (game.target && patternProblem(game.target.pattern)) return '目标牌型无效。';
  if (game.responseWindow !== null) {
    const window = game.responseWindow, expected = expectedResponse(game.target);
    if (!exactKeys(window, ['id', 'targetId', 'action', 'rank', 'deadlineAt']) || !expected
        || window.id !== `${game.target.id}:response` || window.targetId !== game.target.id
        || window.action !== expected || window.rank !== game.target.pattern.rank
        || window.deadlineAt !== game.moves.at(-1).at + RESPONSE_MS) return '勾叉窗口无效。';
  }
  if (active(game)) {
    if (game.result !== null || !['dealing', 'playing'].includes(game.stage)) return '进行中阶段无效。';
    if (game.stage === 'dealing') {
      if (game.dealCursor >= 108 || game.turnPlayerId !== null || game.target !== null
          || game.moves.length || game.responseWindow !== null || game.passedPlayerIds.length) return '发牌阶段不能行动。';
    } else if (game.dealCursor !== 108 || !playerIds.includes(game.turnPlayerId)
        || game.players.some(player => player.hand.length === 0)) return '出牌阶段或行动者无效。';
    if (!game.target && (game.passedPlayerIds.length || game.responseWindow)) return '领出阶段不能有旧目标响应。';
    if (game.target && game.passedPlayerIds.includes(game.target.ownerId)) return '当前目标拥有者不能已不出。';
    if (game.target) {
      const ownerIndex = game.actionOrder.indexOf(game.target.ownerId);
      const expectedPassed = Array.from({ length: game.passedPlayerIds.length }, (_, index) =>
        game.actionOrder[(ownerIndex + index + 1) % game.players.length]);
      const expectedTurn = game.actionOrder[(ownerIndex + game.passedPlayerIds.length + 1) % game.players.length];
      if (!same(game.passedPlayerIds, expectedPassed) || game.turnPlayerId !== expectedTurn) return '不出记录与当前逆时针行动者不符。';
    } else if (game.stage === 'playing') {
      const previousMove = game.moves.at(-1);
      const expectedLeader = previousMove?.playerId || game.firstPlayerId;
      const expectedRound = previousMove ? previousMove.roundId + 1 : 1;
      if (game.turnPlayerId !== expectedLeader || game.roundId !== expectedRound) return '领出者或新轮编号与正式牌局不符。';
    }
  } else {
    if (!['finished', 'aborted', 'cancelled'].includes(game.status) || game.stage !== game.status
        || game.turnPlayerId !== null || game.responseWindow !== null || game.passedPlayerIds.length
        || !exactKeys(game.result, ['accountGroup', 'gameType', 'ruleVersion', 'scoringVersion', 'matchId',
          'settlementVersion', 'reason', 'winnerId', 'responsiblePlayerId', 'settledAt', 'deltas'])) return '终局结构无效。';
    const { reason, winnerId, responsiblePlayerId, settledAt } = game.result;
    if (!integer(settledAt, game.createdAt, game.updatedAt)) return '结算时间无效。';
    if (game.status === 'finished') {
      if (reason !== 'emptied-hand' || !playerIds.includes(winnerId) || responsiblePlayerId !== null
          || game.players.find(player => player.id === winnerId).hand.length !== 0
          || game.players.some(player => player.id !== winnerId && player.hand.length === 0)
          || game.target?.ownerId !== winnerId) return '正常胜负无效。';
    } else if (game.status === 'aborted') {
      if (reason !== 'voluntary-leave' || !playerIds.includes(responsiblePlayerId) || winnerId !== null) return '主动中止归属无效。';
    } else if (!['disconnected', 'server-recovery', 'room-expired'].includes(reason)
        || winnerId !== null || responsiblePlayerId !== null) return '系统取消原因无效。';
    if (!same(game.result, settlement(game, reason, winnerId, responsiblePlayerId, settledAt))) return '终局分数与牌局不一致。';
  }
  return null;
}

export function gameProblem(game) {
  try { return inspectGame(game); } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return '414存档结构无效。';
    throw error;
  }
}

export function validateGame(game) { return gameProblem(game) === null; }
