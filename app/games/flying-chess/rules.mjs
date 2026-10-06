/**
 * Public deterministic flying-chess rules, shared by local practice and a future
 * server adapter. The caller supplies an already chosen first player and die.
 * This module cannot authenticate, roll randomly, pause, measure deadlines or
 * persist. The adapter must authorize before rolling and use its room clock/CAS
 * to ensure that a timeout advances the current round at most once.
 */
import { ART_VERSION, BOARD_VERSION, SIDES, ringIndex } from './board.mjs';
import { legalPlaneIds, previewMove, applyPreview } from './routes.mjs';

export const GAME_TYPE = 'flying-chess';
export const RULE_VERSION = 'flying-chess-friends-v1';
export const STATE_VERSION = 1;

const STATE_KEYS = ['version', 'gameType', 'ruleVersion', 'boardVersion', 'artVersion',
  'players', 'planes', 'firstPlayerIndex', 'turnIndex', 'turnPlayerId', 'round',
  'revision', 'status', 'stage', 'rollId', 'die', 'legalPlaneIds', 'lastAction', 'result'];
const ROUTE_KEYS = ['planeId', 'side', 'die', 'from', 'to', 'segments', 'landings',
  'capturedIds', 'finished', 'description'];
const SIDE_ORDERS = Object.freeze({ 2: ['red', 'yellow'], 3: ['red', 'blue', 'yellow'],
  4: SIDES.map(side => side.id) });
const sideIndex = new Map(SIDES.map(side => [side.id, side.index]));
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exactArray = (value, minimum, maximum) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && value.length >= minimum && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, index) => index).every(index => Object.hasOwn(value, index)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, index), 'value'));
const same = (left, right) => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left), rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
};
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const counter = (value, minimum = 0) => integer(value, minimum, Number.MAX_SAFE_INTEGER - 1);
const validDie = die => integer(die, 1, 6);
const progress = value => integer(value, -2, 55);
const fail = error => ({ ok: false, error });
const clone = value => structuredClone(value);

// A saved position is an actual final landing, not merely a coordinate in range.
// Reuse the movement rules to enumerate reachable positions; p1, p17 and p21 are
// traversed but cannot survive the mandatory jump/flight as confirmed positions.
const reachableBySide = new Map(SIDES.map(({ id: side }) => {
  const seen = new Set([-2]), queue = [-2], planeId = `${side}-1`;
  for (let index = 0; index < queue.length; index += 1) {
    for (let die = 1; die <= 6; die += 1) {
      const route = previewMove([{ id: planeId, side, number: 1, progress: queue[index] }], planeId, die);
      if (route && !seen.has(route.to)) { seen.add(route.to); queue.push(route.to); }
    }
  }
  return [side, seen];
}));

function playerIdsProblem(playerIds) {
  if (!exactArray(playerIds, 2, 4)) return '飞行棋需要2～4位玩家。';
  if (playerIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 64 || /[\u0000-\u001f\u007f]/u.test(id))
      || new Set(playerIds).size !== playerIds.length) return '玩家身份必须唯一、非空且不超过64字。';
  return null;
}

function completedCounts(game) {
  return game.players.map(player => ({ playerId: player.id,
    completed: game.planes.filter(plane => plane.side === player.side && plane.progress === 55).length }));
}

function positionsProblem(planes) {
  const occupied = new Map();
  for (const plane of planes) {
    if (!reachableBySide.get(plane.side)?.has(plane.progress)) return '飞机棋位不可达。';
    if (plane.progress >= 0 && plane.progress <= 49) {
      const cell = ringIndex(plane.side, plane.progress);
      if (occupied.has(cell) && occupied.get(cell) !== plane.side) return '保存棋位不能存在敌我同格。';
      occupied.set(cell, plane.side);
    }
  }
  return null;
}

function routeProblem(game, action) {
  const route = action.route;
  if (!exactKeys(route, ROUTE_KEYS) || !game.planes.some(plane => plane.id === route.planeId)
      || route.side !== game.players.find(player => player.id === action.playerId).side
      || route.die !== action.die || !progress(route.from) || route.from === 55
      || !integer(route.to, -1, 55) || typeof route.finished !== 'boolean'
      || route.finished !== (route.to === 55) || typeof route.description !== 'string'
      || route.description.length > 256 || !exactArray(route.segments, 1, 3)
      || !exactArray(route.landings, 1, 3) || !exactArray(route.capturedIds, 0, 12)
      || new Set(route.capturedIds).size !== route.capturedIds.length) {
    return '最近移动路线格式无效。';
  }
  for (const segment of route.segments) {
    if (!exactKeys(segment, ['kind', 'from', 'to', 'steps'])
        || !['launch', 'walk', 'jump', 'fly', 'bounce'].includes(segment.kind)
        || !progress(segment.from) || !integer(segment.to, -1, 55) || !exactArray(segment.steps, 1, 6)
        || segment.steps.some(step => !integer(step, -1, 55))) return '最近移动分段无效。';
  }
  const captures = new Set(), before = game.planes.map(plane => ({ ...plane }));
  for (const landing of route.landings) {
    if (!exactKeys(landing, ['progress', 'capturedIds']) || !integer(landing.progress, -1, 55)
        || !exactArray(landing.capturedIds, 0, 12)) return '最近移动落点无效。';
    for (const id of landing.capturedIds) {
      const enemy = before.find(plane => plane.id === id);
      if (!enemy || enemy.side === route.side || enemy.progress !== -2 || captures.has(id)
          || landing.progress < 0 || landing.progress > 49) return '最近返库飞机无效。';
      const oldProgress = (ringIndex(route.side, landing.progress) - sideIndex.get(enemy.side) * 13 + 52) % 52;
      if (oldProgress > 49) return '最近返库位置无效。';
      enemy.progress = oldProgress;
      captures.add(id);
    }
  }
  if (!same([...captures], route.capturedIds)) return '最近返库列表与落点不符。';
  const moved = before.find(plane => plane.id === route.planeId);
  if (moved.side !== route.side || moved.progress !== route.to) return '最近移动与当前棋位不符。';
  moved.progress = route.from;
  const beforeProblem = positionsProblem(before);
  if (beforeProblem) return '最近移动之前的棋位无效。';
  const expected = previewMove(before, route.planeId, action.die);
  if (!expected || !same(expected, route)) return '最近移动路线与规则不符。';
  if (!same(applyPreview(before, expected), game.planes)) return '最近移动结果与棋盘不符。';
  return null;
}

function lastActionProblem(game) {
  const action = game.lastAction;
  if (action === null) {
    return game.revision === 0 && game.rollId === 0 && game.round === 1
      && game.status === 'playing' && game.stage === 'await-roll'
      && game.planes.every(plane => plane.progress === -2) ? null : '初始状态或最后动作无效。';
  }
  if (game.revision === 0 || !action || !['roll', 'move', 'timeout'].includes(action.type)
      || !game.players.some(player => player.id === action.playerId) || !counter(action.round, 1)
      || !counter(action.rollId) || action.rollId !== game.rollId
      || action.nextPlayerId !== game.turnPlayerId) return '最后动作身份或计数无效。';
  const actorIndex = game.players.findIndex(player => player.id === action.playerId);
  if (actorIndex !== (game.firstPlayerIndex + (action.round - 1) % game.players.length) % game.players.length) {
    return '最后动作不属于该回合玩家。';
  }
  const sameTurn = () => game.round === action.round && game.turnIndex === actorIndex;
  const changedTurn = () => game.round === action.round + 1 && game.turnIndex === (actorIndex + 1) % game.players.length;
  if (action.type === 'roll') {
    if (!exactKeys(action, ['type', 'playerId', 'round', 'rollId', 'die', 'legalPlaneIds', 'outcome', 'nextPlayerId'])
        || action.rollId < 1 || !validDie(action.die) || !exactArray(action.legalPlaneIds, 0, 4)
        || game.status !== 'playing') return '最后掷骰格式无效。';
    const legal = legalPlaneIds(game.planes, game.players[actorIndex].side, action.die);
    if (!same(action.legalPlaneIds, legal)) return '掷骰记录的合法飞机无效。';
    if (action.outcome === 'await-move') {
      if (!legal.length || !sameTurn() || game.stage !== 'await-move' || game.die !== action.die) return '掷骰待选状态无效。';
    } else if (action.outcome === 'no-move') {
      if (legal.length || action.die === 6 || !changedTurn() || game.stage !== 'await-roll') return '无法行动必须保存骰面并换手。';
    } else return '掷骰结果无效。';
  } else if (action.type === 'move') {
    if (!exactKeys(action, ['type', 'playerId', 'round', 'rollId', 'die', 'route', 'outcome', 'nextPlayerId'])
        || action.rollId < 1 || !validDie(action.die) || game.revision <= game.rollId) return '最后移动格式无效。';
    const problem = routeProblem(game, action);
    if (problem) return problem;
    if (action.outcome === 'finished') {
      if (!sameTurn() || game.status !== 'finished' || game.stage !== 'finished') return '完成动作必须结束对局。';
    } else if (action.outcome === 'six-again') {
      if (action.die !== 6 || !sameTurn() || game.status !== 'playing' || game.stage !== 'await-roll') return '六点再掷必须保留原回合。';
    } else if (action.outcome === 'next-turn') {
      if (action.die === 6 || !changedTurn() || game.status !== 'playing' || game.stage !== 'await-roll') return '非六移动必须换手。';
    } else return '移动结果无效。';
  } else {
    if (!exactKeys(action, ['type', 'playerId', 'round', 'rollId', 'fromStage', 'discardedDie', 'nextPlayerId'])
        || game.revision <= game.rollId || !['await-roll', 'await-move'].includes(action.fromStage)
        || (action.fromStage === 'await-roll' ? action.discardedDie !== null
          : !validDie(action.discardedDie) || action.rollId < 1)
        || (action.fromStage === 'await-move'
          && !legalPlaneIds(game.planes, game.players[actorIndex].side, action.discardedDie).length)
        || !changedTurn() || game.status !== 'playing' || game.stage !== 'await-roll') return '超时必须弃未用骰并换手。';
  }
  return null;
}

function inspectGame(game) {
  if (!exactKeys(game, STATE_KEYS) || game.version !== STATE_VERSION || game.gameType !== GAME_TYPE
      || game.ruleVersion !== RULE_VERSION || game.boardVersion !== BOARD_VERSION || game.artVersion !== ART_VERSION) {
    return '飞行棋对局版本或字段无效。';
  }
  if (!exactArray(game.players, 2, 4)) return '参赛玩家无效。';
  const idsProblem = playerIdsProblem(game.players.map(player => player?.id));
  if (idsProblem) return idsProblem;
  const sides = SIDE_ORDERS[game.players.length];
  if (game.players.some((player, index) => !exactKeys(player, ['id', 'side']) || player.side !== sides[index])) {
    return '参赛阵营和轮序必须保持固定。';
  }
  if (!exactArray(game.planes, game.players.length * 4, game.players.length * 4)) return '飞机总数无效。';
  for (let index = 0; index < game.planes.length; index += 1) {
    const plane = game.planes[index], side = sides[Math.floor(index / 4)], number = index % 4 + 1;
    if (!exactKeys(plane, ['id', 'side', 'number', 'progress']) || plane.id !== `${side}-${number}`
        || plane.side !== side || plane.number !== number || !progress(plane.progress)
        || !reachableBySide.get(side).has(plane.progress)) return '飞机身份、归属或棋位无效。';
  }
  const positionProblem = positionsProblem(game.planes);
  if (positionProblem) return positionProblem;
  if (!integer(game.firstPlayerIndex, 0, game.players.length - 1)
      || !integer(game.turnIndex, 0, game.players.length - 1) || !counter(game.round, 1)
      || !counter(game.revision) || !counter(game.rollId) || game.rollId > game.revision
      || game.revision < game.round - 1 || game.turnPlayerId !== game.players[game.turnIndex].id
      || game.turnIndex !== (game.firstPlayerIndex + (game.round - 1) % game.players.length) % game.players.length) {
    return '回合、行动者或骰子计数无效。';
  }
  // No roll means only timeouts could have happened. Equal revision/roll counts
  // mean every saved action was a roll. Neither history can have moved a plane.
  if ((game.rollId === 0 || game.revision === game.rollId)
      && game.planes.some(plane => plane.progress !== -2)) return '尚未移动的对局必须保持全部飞机在机库。';
  if (!['playing', 'finished'].includes(game.status) || !['await-roll', 'await-move', 'finished'].includes(game.stage)
      || !exactArray(game.legalPlaneIds, 0, 4)) return '对局阶段无效。';
  if (game.stage === 'await-move') {
    if (game.status !== 'playing' || !validDie(game.die) || game.rollId < 1
        || !game.legalPlaneIds.length || !same(game.legalPlaneIds, legalPlaneIds(game.planes, game.players[game.turnIndex].side, game.die))
        || game.lastAction?.type !== 'roll') return '待选骰面或合法飞机无效。';
  } else if (game.die !== null || game.legalPlaneIds.length) return '非待选阶段不能留未用骰面或合法列表。';
  const counts = completedCounts(game), winners = counts.filter(entry => entry.completed === 4);
  if (game.status === 'playing') {
    if (game.stage === 'finished' || game.result !== null || winners.length) return '进行中不能已有四机完成或结果。';
  } else {
    const result = game.result;
    if (game.stage !== 'finished' || !exactKeys(result, ['reason', 'winnerIds', 'tie', 'completedCounts'])
        || result.reason !== 'all-planes-finished' || result.tie !== false || !exactArray(result.winnerIds, 1, 1)
        || !exactArray(result.completedCounts, game.players.length, game.players.length)
        || winners.length !== 1 || result.winnerIds[0] !== winners[0].playerId
        || result.winnerIds[0] !== game.turnPlayerId || !same(result.completedCounts, counts)
        || game.lastAction?.type !== 'move' || game.lastAction.playerId !== result.winnerIds[0]
        || game.lastAction.route?.to !== 55 || game.lastAction.route?.finished !== true) return '终局赢家、完成数量或结果无效。';
  }
  return lastActionProblem(game);
}

/** Returns a bounded diagnostic for a serialized state; never guesses repairs. */
export function gameProblem(game) {
  try { return inspectGame(game); } catch { return '飞行棋存档结构无效。'; }
}

export function validateGame(game) { return gameProblem(game) === null; }

/** First player is explicit: production randomness belongs to server assembly. */
export function createGame(playerIds, options) {
  const problem = playerIdsProblem(playerIds);
  if (problem) throw new Error(problem);
  if (!exactKeys(options, ['firstPlayerIndex']) || !integer(options.firstPlayerIndex, 0, playerIds.length - 1)) {
    throw new Error('必须明确提供有效的先手玩家序号。');
  }
  const players = playerIds.map((id, index) => ({ id, side: SIDE_ORDERS[playerIds.length][index] }));
  return {
    version: STATE_VERSION, gameType: GAME_TYPE, ruleVersion: RULE_VERSION,
    boardVersion: BOARD_VERSION, artVersion: ART_VERSION, players,
    planes: players.flatMap(player => Array.from({ length: 4 }, (_, index) => ({ id: `${player.side}-${index + 1}`,
      side: player.side, number: index + 1, progress: -2 }))),
    firstPlayerIndex: options.firstPlayerIndex, turnIndex: options.firstPlayerIndex,
    turnPlayerId: playerIds[options.firstPlayerIndex], round: 1, revision: 0,
    status: 'playing', stage: 'await-roll', rollId: 0, die: null,
    legalPlaneIds: [], lastAction: null, result: null,
  };
}

function actionProblem(game, playerId, stage) {
  const problem = gameProblem(game);
  if (problem) return problem;
  if (!game.players.some(player => player.id === playerId)) return '你不是本局参赛玩家。';
  if (game.status !== 'playing') return '对局已经结束。';
  if (game.turnPlayerId !== playerId) return '现在不是你的回合。';
  if (stage && game.stage !== stage) return stage === 'await-roll' ? '本次骰子尚未使用，不能再次掷骰。' : '请先掷骰再选择飞机。';
  if (game.revision >= Number.MAX_SAFE_INTEGER - 1 || game.round >= Number.MAX_SAFE_INTEGER - 1
      || game.rollId >= Number.MAX_SAFE_INTEGER - 1) return '对局计数已达上限。';
  return null;
}

function advanceTurn(game) {
  game.round += 1;
  game.turnIndex = (game.turnIndex + 1) % game.players.length;
  game.turnPlayerId = game.players[game.turnIndex].id;
  game.stage = 'await-roll'; game.die = null; game.legalPlaneIds = [];
}

function validatedResult(state) {
  const problem = gameProblem(state);
  return problem ? fail(problem) : { ok: true, state };
}

/** The die is supplied only by a trusted server or an explicitly local practice. */
export function applyRoll(game, playerId, die) {
  const problem = actionProblem(game, playerId, 'await-roll');
  if (problem) return fail(problem);
  if (!validDie(die)) return fail('骰面必须是1～6的整数。');
  const next = clone(game), round = next.round;
  next.revision += 1; next.rollId += 1;
  const legal = legalPlaneIds(next.planes, next.players[next.turnIndex].side, die);
  if (legal.length) {
    next.stage = 'await-move'; next.die = die; next.legalPlaneIds = [...legal];
  } else advanceTurn(next);
  next.lastAction = { type: 'roll', playerId, round, rollId: next.rollId, die,
    legalPlaneIds: [...legal], outcome: legal.length ? 'await-move' : 'no-move', nextPlayerId: next.turnPlayerId };
  return validatedResult(next);
}

/** A saved die is consumed once, even when another device sends an old rollId. */
export function applyMove(game, playerId, action) {
  const problem = actionProblem(game, playerId, 'await-move');
  if (problem) return fail(problem);
  if (!exactKeys(action, ['rollId', 'planeId']) || !counter(action.rollId, 1) || action.rollId !== game.rollId) {
    return fail('骰子已失效，请按当前骰面重新选择。');
  }
  if (typeof action.planeId !== 'string' || !game.legalPlaneIds.includes(action.planeId)) return fail('请选择自己可行动的一架飞机。');
  const next = clone(game), die = next.die, round = next.round;
  const route = previewMove(next.planes, action.planeId, die);
  next.planes = applyPreview(next.planes, route);
  next.revision += 1; next.die = null; next.legalPlaneIds = [];
  const counts = completedCounts(next), winner = counts.find(entry => entry.completed === 4);
  let outcome;
  if (winner) {
    next.status = 'finished'; next.stage = 'finished';
    next.result = { reason: 'all-planes-finished', winnerIds: [winner.playerId], tie: false, completedCounts: counts };
    outcome = 'finished';
  } else if (die === 6) {
    next.stage = 'await-roll'; outcome = 'six-again';
  } else {
    advanceTurn(next); outcome = 'next-turn';
  }
  next.lastAction = { type: 'move', playerId, round, rollId: next.rollId, die, route,
    outcome, nextPlayerId: next.turnPlayerId };
  return validatedResult(next);
}

/** No clock guessing or auto-roll: the authorized outer timer discards this die. */
export function applyTimeout(game) {
  const problem = actionProblem(game, game?.turnPlayerId);
  if (problem) return fail(problem);
  const next = clone(game), playerId = next.turnPlayerId, round = next.round;
  const fromStage = next.stage, discardedDie = next.die;
  next.revision += 1; advanceTurn(next);
  next.lastAction = { type: 'timeout', playerId, round, rollId: next.rollId,
    fromStage, discardedDie, nextPlayerId: next.turnPlayerId };
  return validatedResult(next);
}
