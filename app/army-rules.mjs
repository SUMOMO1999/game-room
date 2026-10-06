/** Server only. Never publish this module or a full game snapshot to browsers. */
import { randomInt as secureRandomInt } from 'node:crypto';
import { BOARD_CELLS, PIECE_COUNTS, PIECE_LABELS, RANKS, ARMY_HOME_BASES, getCell,
  isCellId, roadNeighbors, railNeighbors } from './army-board.mjs';

const SIDES = ['red', 'black'];
const ASSIGNMENTS = ['two-flips', 'first-flip'];
const ACTIONS = ['flip', 'move', 'resign', 'offer-draw', 'accept-draw', 'decline-draw'];
const STATE_KEYS = ['version', 'gameType', 'ruleVersion', 'assignment', 'players', 'board',
  'captured', 'turnIndex', 'round', 'revision', 'status', 'winnerId', 'result',
  'drawOfferByPlayerId', 'lastAction'];
const CANONICAL = new Map(SIDES.flatMap((side) => Object.entries(PIECE_COUNTS)
  .flatMap(([kind, count]) => Array.from({ length: count }, (_, index) => {
    const id = `${side}-${kind}-${index + 1}`;
    return [id, Object.freeze({ id, side, kind })];
  }))));
const fail = (error) => ({ ok: false, error });
const opposite = (side) => side === 'red' ? 'black' : 'red';
const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
const copy = (value) => structuredClone(value);
const movable = (piece) => piece && piece.revealed && piece.kind !== 'mine' && piece.kind !== 'flag';
const cells = (game) => new Map(game.board.map((entry) => [entry.cellId, entry.piece]));
const knownCount = (game) => game.captured.length + game.board.filter(({ piece }) => piece?.revealed).length;

function playersProblem(players, state = false) {
  if (!Array.isArray(players) || players.length !== 2) return '翻棋军棋需要两位玩家。';
  const ids = new Set();
  for (const player of players) {
    if (!player || typeof player.id !== 'string' || !player.id || player.id.length > 128
        || typeof player.name !== 'string' || !player.name.trim() || player.name.length > 32) {
      return '玩家需要有效身份和1至32字的名字。';
    }
    if (ids.has(player.id)) return '玩家身份不能重复。';
    ids.add(player.id);
    if (state && (!exactKeys(player, ['id', 'name', 'side', 'lastFlipSide'])
        || ![null, ...SIDES].includes(player.side) || ![null, ...SIDES].includes(player.lastFlipSide))) {
      return '玩家阵营状态无效。';
    }
  }
  if (state && !(players.every(({ side }) => side === null)
      || (SIDES.includes(players[0].side) && players[1].side === opposite(players[0].side)))) {
    return '双方阵营必须同时确定且相反。';
  }
  return null;
}

function flagAvailable(game, side) {
  return !game.board.some(({ piece }) => piece?.side === side && piece.kind === 'mine');
}
function canLand(game, source, destination, position) {
  const target = position.get(destination);
  if (!target) return true;
  if (!target.revealed || target.side === source.side || getCell(destination).terrain === 'camp') return false;
  if (target.kind === 'flag') return flagAvailable(game, target.side);
  if (target.kind === 'mine') return source.kind === 'engineer' || source.kind === 'bomb';
  return true; // Sending a smaller piece into a larger one is permitted in this room variant.
}

function destinations(game, from, position) {
  const piece = position.get(from);
  if (!movable(piece)) return [];
  const result = new Set();
  for (const to of roadNeighbors(from)) if (canLand(game, piece, to, position)) result.add(to);
  if (piece.kind === 'engineer') {
    const visited = new Set([from]), queue = [from];
    for (let index = 0; index < queue.length; index += 1) {
      for (const to of railNeighbors(queue[index])) {
        if (visited.has(to)) continue;
        visited.add(to);
        if (canLand(game, piece, to, position)) result.add(to);
        if (!position.get(to)) queue.push(to); // Occupied endpoints never permit passage.
      }
    }
  } else {
    const origin = getCell(from);
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let previous = from, row = origin.row + dr, column = origin.column + dc;
      while (row >= 0 && row < 12 && column >= 0 && column < 5) {
        const to = `r${row}c${column}`;
        if (!railNeighbors(previous).includes(to)) break;
        if (canLand(game, piece, to, position)) result.add(to);
        if (position.get(to)) break;
        previous = to; row += dr; column += dc;
      }
    }
  }
  return [...result];
}
function legalMovesFor(game, side) {
  if (!side) return [];
  const position = cells(game);
  return game.board.flatMap(({ cellId, piece }) => piece?.side === side && movable(piece)
    ? destinations(game, cellId, position).map((to) => ({ from: cellId, to })) : []);
}
function hiddenCells(game) { return game.board.filter(({ piece }) => piece && !piece.revealed).map(({ cellId }) => cellId); }

function lastActionProblem(game) {
  const action = game.lastAction;
  if (action === null) return game.revision === 0 ? null : '缺少最后动作。';
  if (!action || !ACTIONS.includes(action.type) || !game.players.some(({ id }) => id === action.playerId)) return '最后动作无效。';
  if (action.type === 'flip') {
    if (!exactKeys(action, ['type', 'playerId', 'cellId', 'side', 'kind']) || !isCellId(action.cellId)
        || !SIDES.includes(action.side) || !Object.hasOwn(PIECE_COUNTS, action.kind)) return '翻棋动作无效。';
    const piece = game.board.find(({ cellId }) => cellId === action.cellId).piece;
    if (!piece?.revealed || piece.side !== action.side || piece.kind !== action.kind) return '翻棋结果与棋盘不符。';
  } else if (action.type === 'move') {
    if (!exactKeys(action, ['type', 'playerId', 'from', 'to', 'outcome'])
        || !isCellId(action.from) || !isCellId(action.to) || action.from === action.to
        || !['move', 'capture', 'attacker-lost', 'mutual', 'flag'].includes(action.outcome)) return '走棋动作无效。';
    if (game.board.find(({ cellId }) => cellId === action.from).piece !== null) return '走棋起点未清空。';
  } else if (!exactKeys(action, ['type', 'playerId'])) return '动作记录格式无效。';
  if (['flip', 'move'].includes(action.type)
      && game.players[game.turnIndex].id === action.playerId) return '行棋后必须换手。';
  if (action.type === 'move' && game.players[0].side === null) return '未定阵营不能走棋。';
  if (action.type === 'offer-draw' && game.drawOfferByPlayerId !== action.playerId) return '求和请求与动作不符。';
  if (action.type !== 'offer-draw' && game.drawOfferByPlayerId !== null) return '旧求和请求必须清除。';
  if (action.type === 'resign' && (game.status !== 'finished' || game.result?.reason !== 'resigned')) return '认输必须结束对局。';
  if (action.type === 'accept-draw' && (game.status !== 'finished' || game.result?.reason !== 'draw-agreed')) return '同意求和必须结束对局。';
  return game.revision > 0 ? null : '动作修订号无效。';
}

/** Validates a persisted full state without trusting its outcome or piece attributes. */
function gameProblemV1(game) {
  if (!exactKeys(game, STATE_KEYS) || game.version !== 1 || game.gameType !== 'army-flip'
      || game.ruleVersion !== 'army-flip-v1' || !ASSIGNMENTS.includes(game.assignment)) return '翻棋对局版本无效。';
  const playerProblem = playersProblem(game.players, true);
  if (playerProblem) return playerProblem;
  if (!Array.isArray(game.board) || game.board.length !== 60 || !Array.isArray(game.captured)) return '棋盘或阵亡状态无效。';
  if (!Number.isSafeInteger(game.turnIndex) || game.turnIndex < 0 || game.turnIndex > 1
      || !Number.isSafeInteger(game.round) || game.round < 1 || game.round >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(game.revision) || game.revision < game.round - 1 || game.revision >= Number.MAX_SAFE_INTEGER
      || !['playing', 'finished'].includes(game.status)
      || !(game.drawOfferByPlayerId === null || game.players.some(({ id }) => id === game.drawOfferByPlayerId))) {
    return '回合、求和或对局状态无效。';
  }
  const ids = new Set();
  function checkPiece(piece, captured = false) {
    if (!exactKeys(piece, ['id', 'side', 'kind', 'revealed']) || typeof piece.revealed !== 'boolean'
        || (captured && !piece.revealed)) return '棋子字段无效。';
    const canonical = CANONICAL.get(piece.id);
    if (!canonical || canonical.side !== piece.side || canonical.kind !== piece.kind || ids.has(piece.id)) return '棋子身份、阵营或兵种无效。';
    ids.add(piece.id);
    return null;
  }
  for (let index = 0; index < game.board.length; index += 1) {
    const entry = game.board[index], cell = BOARD_CELLS[index];
    if (!exactKeys(entry, ['cellId', 'piece']) || entry.cellId !== cell.cellId) return '棋位重复、缺失或顺序无效。';
    if (entry.piece !== null) {
      const problem = checkPiece(entry.piece);
      if (problem) return problem;
      if (cell.terrain === 'camp' && (!entry.piece.revealed || !movable(entry.piece))) return '行营不能含暗子、地雷或军旗。';
    }
  }
  for (const piece of game.captured) { const problem = checkPiece(piece, true); if (problem) return problem; }
  if (ids.size !== 50) return '必须保持50枚实体棋子，不能增减或重复。';
  if (knownCount(game) > game.round - 1) return '翻棋数量超过已行动回合。';
  const assigned = game.players[0].side !== null;
  if (assigned && knownCount(game) < (game.assignment === 'first-flip' ? 1 : 3)) return '阵营缺少足够翻棋记录。';
  if (assigned && game.assignment === 'two-flips' && game.players.some(({ lastFlipSide }) => lastFlipSide === null)) return '连翻阵营缺少双方翻棋记录。';
  if (!assigned && (game.captured.length || game.board.some(({ cellId, piece }) => piece && getCell(cellId).terrain === 'camp'))) return '未定阵营不能交战或占营。';
  if (game.revision === 0 && (game.round !== 1 || assigned || knownCount(game) || game.drawOfferByPlayerId !== null
      || game.players.some(({ lastFlipSide }) => lastFlipSide !== null))) return '初始状态无效。';
  const actionProblem = lastActionProblem(game);
  if (actionProblem) return actionProblem;
  const capturedFlags = game.captured.filter(({ kind }) => kind === 'flag');
  if (game.status === 'playing') {
    if (game.result !== null || game.winnerId !== null || capturedFlags.length) return '进行中不能已有胜负或军旗阵亡。';
    if (!assigned && !hiddenCells(game).length) return '未定阵营且暗子已翻完必须和棋。';
    if (assigned && !hiddenCells(game).length && !legalMovesFor(game, game.players[game.turnIndex].side).length) return '无合法动作的局面必须结束。';
    return null;
  }
  const result = game.result;
  if (!exactKeys(result, ['reason', 'winnerIds', 'scores', 'tie'])
      || !['flag-captured', 'blocked', 'resigned', 'draw-agreed', 'assignment-exhausted'].includes(result.reason)
      || !Array.isArray(result.winnerIds) || !Array.isArray(result.scores) || result.scores.length !== 2
      || game.drawOfferByPlayerId !== null) return '终局结果格式无效。';
  for (let index = 0; index < 2; index += 1) {
    const score = result.scores[index], player = game.players[index];
    if (!exactKeys(score, ['playerId', 'name', 'points']) || score.playerId !== player.id
        || score.name !== player.name || score.points !== null) return '军棋结算不能伪造玩家或手牌分。';
  }
  if (result.reason === 'draw-agreed' || result.reason === 'assignment-exhausted') {
    if (result.tie !== true || result.winnerIds.length || game.winnerId !== null
        || capturedFlags.length) return '和局结果无效。';
    if (result.reason === 'draw-agreed' && game.lastAction?.type !== 'accept-draw') return '同意求和记录无效。';
    if (result.reason === 'assignment-exhausted' && (assigned || game.assignment !== 'two-flips'
        || hiddenCells(game).length || game.captured.length || game.lastAction?.type !== 'flip')) return '分色耗尽和局条件无效。';
  } else {
    if (result.tie !== false || result.winnerIds.length !== 1 || game.winnerId !== result.winnerIds[0]
        || !game.players.some(({ id }) => id === game.winnerId)) return '胜方身份无效。';
    if (result.reason === 'resigned') {
      if (game.lastAction?.type !== 'resign' || game.lastAction.playerId === game.winnerId || capturedFlags.length) return '认输结果无效。';
    } else if (result.reason === 'flag-captured') {
      const winner = game.players.find(({ id }) => id === game.winnerId);
      if (!assigned || capturedFlags.length !== 1 || capturedFlags[0].side !== opposite(winner.side)
          || !flagAvailable(game, capturedFlags[0].side) || game.lastAction?.type !== 'move'
          || game.lastAction.outcome !== 'flag' || game.lastAction.playerId !== winner.id) return '夺旗条件无效。';
    } else if (!assigned || capturedFlags.length || hiddenCells(game).length
        || game.players[game.turnIndex].id === game.winnerId
        || legalMovesFor(game, game.players[game.turnIndex].side).length
        || !['flip', 'move'].includes(game.lastAction?.type)
        || game.lastAction.playerId !== game.winnerId) return '困毙结果无效。';
  }
  return null;
}

function createGameV1(players, options = {}) {
  const problem = playersProblem(players);
  if (problem) throw new Error(problem);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('对局选项无效。');
  const assignment = options.assignment ?? 'two-flips';
  if (!ASSIGNMENTS.includes(assignment)) throw new Error('阵营确定方式无效。');
  const randomInt = options.randomInt === undefined ? secureRandomInt : options.randomInt;
  if (typeof randomInt !== 'function') throw new Error('洗棋随机源无效。');
  const random = (maximum) => {
    const value = randomInt(maximum);
    if (!Number.isInteger(value) || value < 0 || value >= maximum) throw new Error('洗棋随机源返回值无效。');
    return value;
  };
  const deck = [...CANONICAL.values()].map((piece) => ({ ...piece, revealed: false }));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const target = random(index + 1); [deck[index], deck[target]] = [deck[target], deck[index]];
  }
  const turnIndex = options.firstTurnIndex ?? random(2);
  if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex > 1) throw new Error('首位玩家无效。');
  let next = 0;
  return { version: 1, gameType: 'army-flip', ruleVersion: 'army-flip-v1', assignment,
    players: players.map(({ id, name }) => ({ id, name: name.trim(), side: null, lastFlipSide: null })),
    board: BOARD_CELLS.map(({ cellId, terrain }) => ({ cellId, piece: terrain === 'camp' ? null : deck[next++] })),
    captured: [], turnIndex, round: 1, revision: 0, status: 'playing', winnerId: null,
    result: null, drawOfferByPlayerId: null, lastAction: null };
}

function finish(game, reason, winnerId = null) {
  game.status = 'finished'; game.winnerId = winnerId; game.drawOfferByPlayerId = null;
  game.result = { reason, winnerIds: winnerId ? [winnerId] : [],
    scores: game.players.map(({ id, name }) => ({ playerId: id, name, points: null })),
    tie: reason === 'draw-agreed' || reason === 'assignment-exhausted' };
}

function applyGameActionV1(game, playerId, action) {
  const problem = gameProblemV1(game);
  if (problem) return fail(problem);
  const playerIndex = game.players.findIndex(({ id }) => id === playerId);
  if (playerIndex < 0) return fail('你不在这局游戏中。');
  if (game.status !== 'playing') return fail('本局已经结束。');
  if (!action || typeof action !== 'object' || !ACTIONS.includes(action.type)) return fail('不支持的军棋动作。');
  const actionKeys = action.type === 'flip' ? ['type', 'cellId'] : action.type === 'move' ? ['type', 'from', 'to'] : ['type'];
  if (!exactKeys(action, actionKeys)) return fail('军棋动作参数无效。');
  if (game.revision >= Number.MAX_SAFE_INTEGER - 1 || game.round >= Number.MAX_SAFE_INTEGER - 1) return fail('对局计数已达上限。');
  if (['flip', 'move'].includes(action.type) && playerIndex !== game.turnIndex) return fail('还没轮到你。');
  const next = copy(game), player = next.players[playerIndex];
  next.revision += 1;
  if (action.type === 'resign') {
    next.lastAction = { type: 'resign', playerId }; finish(next, 'resigned', next.players[1 - playerIndex].id);
    return { ok: true, state: next };
  }
  if (action.type === 'offer-draw') {
    if (next.drawOfferByPlayerId !== null) return fail('已有求和请求，请先处理。');
    next.drawOfferByPlayerId = playerId; next.lastAction = { type: action.type, playerId };
    return { ok: true, state: next };
  }
  if (action.type === 'accept-draw' || action.type === 'decline-draw') {
    if (next.drawOfferByPlayerId === null || next.drawOfferByPlayerId === playerId) return fail('只能回应对方的求和请求。');
    next.drawOfferByPlayerId = null; next.lastAction = { type: action.type, playerId };
    if (action.type === 'accept-draw') finish(next, 'draw-agreed');
    return { ok: true, state: next };
  }
  if (action.type === 'flip') {
    if (!isCellId(action.cellId)) return fail('翻棋位置无效。');
    const entry = next.board.find(({ cellId }) => cellId === action.cellId), piece = entry.piece;
    if (!piece || piece.revealed) return fail('这里没有可翻开的暗子。');
    piece.revealed = true;
    if (player.side === null && (next.assignment === 'first-flip' || player.lastFlipSide === piece.side)) {
      player.side = piece.side; next.players[1 - playerIndex].side = opposite(piece.side);
    }
    player.lastFlipSide = piece.side;
    next.lastAction = { type: 'flip', playerId, cellId: action.cellId, side: piece.side, kind: piece.kind };
  } else {
    if (player.side === null) return fail('阵营尚未确定，请先翻棋。');
    if (!isCellId(action.from) || !isCellId(action.to) || action.from === action.to) return fail('走棋位置无效。');
    const source = next.board.find(({ cellId }) => cellId === action.from), target = next.board.find(({ cellId }) => cellId === action.to);
    if (!source.piece?.revealed || source.piece.side !== player.side || !movable(source.piece)) return fail('只能移动己方已翻开的可动棋子。');
    if (!destinations(next, action.from, cells(next)).includes(action.to)) return fail('不能这样走棋或攻击。');
    const attacker = source.piece, defender = target.piece;
    source.piece = null;
    let outcome = 'move';
    if (!defender) target.piece = attacker;
    else if (defender.kind === 'flag') {
      next.captured.push(defender);
      if (attacker.kind === 'bomb') { next.captured.push(attacker); target.piece = null; }
      else target.piece = attacker;
      outcome = 'flag'; finish(next, 'flag-captured', playerId);
    } else if (attacker.kind === 'bomb' || defender.kind === 'bomb' || RANKS[attacker.kind] === RANKS[defender.kind]) {
      next.captured.push(attacker, defender); target.piece = null; outcome = 'mutual';
    } else if (defender.kind === 'mine' || RANKS[attacker.kind] > RANKS[defender.kind]) {
      next.captured.push(defender); target.piece = attacker; outcome = 'capture';
    } else { next.captured.push(attacker); outcome = 'attacker-lost'; }
    next.lastAction = { type: 'move', playerId, from: action.from, to: action.to, outcome };
  }
  next.drawOfferByPlayerId = null;
  next.round += 1; next.turnIndex = 1 - next.turnIndex;
  if (next.status === 'playing' && next.players[0].side === null && !hiddenCells(next).length) {
    finish(next, 'assignment-exhausted');
  } else if (next.status === 'playing' && next.players[0].side !== null && !hiddenCells(next).length
      && !legalMovesFor(next, next.players[next.turnIndex].side).length) {
    finish(next, 'blocked', playerId);
  }
  const resultProblem = gameProblemV1(next);
  if (resultProblem) return fail(resultProblem);
  return { ok: true, state: next };
}

function privateViewV1(game, playerId) {
  const problem = gameProblemV1(game);
  if (problem) throw new Error(problem);
  const player = game.players.find(({ id }) => id === playerId);
  if (!player) throw new Error('你不在这局游戏中。');
  const yourTurn = game.status === 'playing' && game.players[game.turnIndex].id === playerId;
  const visiblePiece = (piece) => ({ hidden: false, id: piece.id, side: piece.side,
    kind: piece.kind, label: PIECE_LABELS[piece.kind] });
  return { version: 1, gameType: game.gameType, ruleVersion: game.ruleVersion, assignment: game.assignment,
    playerId, players: copy(game.players), board: game.board.map(({ cellId, piece }) => ({ cellId,
      piece: !piece ? null : !piece.revealed ? { hidden: true } : visiblePiece(piece) })),
    capturedPieces: game.captured.map(visiblePiece),
    turnIndex: game.turnIndex, turnPlayerId: game.players[game.turnIndex].id,
    round: game.round, revision: game.revision, status: game.status,
    winnerId: game.winnerId, result: copy(game.result), drawOfferByPlayerId: game.drawOfferByPlayerId,
    lastAction: copy(game.lastAction), legalFlips: yourTurn ? hiddenCells(game) : [],
    legalMoves: yourTurn ? legalMovesFor(game, player.side) : [] };
}

// Version 2 is a separate state machine. Saved v1 games never inherit its rules.
const V2_ACTIONS = [...ACTIONS, 'pickup'];
const V2_STATE_KEYS = [...STATE_KEYS, 'flagTokens'];
const V2_MOVE_OUTCOMES = ['move', 'capture', 'attacker-lost', 'mutual',
  'flag-pickup', 'friendly-reveal', 'protected-flag', 'ineligible-flag'];
const V2_FLAG_EVENTS = ['drop', 'pickup', 'returned', 'delivered'];
const home = (side, id) => ARMY_HOME_BASES[side]?.includes(id) === true;
const cargo = (game, id) => game.flagTokens.find((token) => token.carrierId === id);
const knownCountV2 = (game) => knownCount(game) + game.flagTokens.length;
// All deaths are public and the initial counts are fixed. These decisions must
// not inspect any unrevealed board piece's attributes.
function minesClearedV2(game, side) {
  return game.captured.filter((piece) => piece.side === side && piece.kind === 'mine').length === PIECE_COUNTS.mine;
}
function carrierKindV2(game, side) {
  const remaining = (kind) => PIECE_COUNTS[kind]
    - game.captured.filter((piece) => piece.side === side && piece.kind === kind).length;
  if (remaining('engineer') > 0) return 'engineer';
  return Object.keys(RANKS).sort((a, b) => RANKS[a] - RANKS[b])
    .find((kind) => remaining(kind) > 0) ?? null;
}
function canCarryV2(game, piece, { empty = true } = {}) {
  return Boolean(movable(piece) && piece.kind === carrierKindV2(game, piece.side)
    && (!empty || !cargo(game, piece.id)));
}
// v3 adds a public-count fallback; unrevealed surviving engineers and lower
// ranks still count. It never inspects an unknown piece to offer a legal move.
function canSacrificeDemineV3(game, piece) {
  return game.ruleVersion === 'army-flip-v3' && movable(piece)
    && piece.kind !== 'engineer' && Object.hasOwn(RANKS, piece.kind)
    && piece.kind === carrierKindV2(game, piece.side);
}
function canLandV2(game, source, destination, position) {
  const target = position.get(destination);
  if (!target) return true;
  if (getCell(destination).terrain === 'camp') return false;
  // Trying a dark endpoint must be identical for every hidden identity. It is
  // revealed and resolved only after a confirmed action consumes the turn.
  if (!target.revealed) return true;
  if (target.side === source.side) return false;
  if (target.kind === 'flag') return minesClearedV2(game, target.side) && canCarryV2(game, source);
  if (target.kind === 'mine') return source.kind === 'engineer' || source.kind === 'bomb'
    || canSacrificeDemineV3(game, source);
  return true;
}
function destinationsV2(game, from, position) {
  const piece = position.get(from);
  if (!movable(piece)) return [];
  const result = new Set();
  for (const to of roadNeighbors(from)) if (canLandV2(game, piece, to, position)) result.add(to);
  if (piece.kind === 'engineer') {
    const visited = new Set([from]), queue = [from];
    for (let index = 0; index < queue.length; index += 1) {
      for (const to of railNeighbors(queue[index])) {
        if (visited.has(to)) continue;
        visited.add(to);
        if (canLandV2(game, piece, to, position)) result.add(to);
        if (!position.get(to)) queue.push(to);
      }
    }
  } else {
    const origin = getCell(from);
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let previous = from, row = origin.row + dr, column = origin.column + dc;
      while (row >= 0 && row < 12 && column >= 0 && column < 5) {
        const to = `r${row}c${column}`;
        if (!railNeighbors(previous).includes(to)) break;
        if (canLandV2(game, piece, to, position)) result.add(to);
        if (position.get(to)) break;
        previous = to; row += dr; column += dc;
      }
    }
  }
  return [...result];
}
function legalMovesV2(game, side) {
  if (!side) return [];
  const position = cells(game);
  return game.board.flatMap(({ cellId, piece }) => piece?.side === side && movable(piece)
    ? destinationsV2(game, cellId, position).map((to) => ({ from: cellId, to })) : []);
}
function pickableTokensV2(game, piece, cellId) {
  if (!canCarryV2(game, piece)) return [];
  return game.flagTokens.filter((token) => token.carrierId === null && token.cellId === cellId
    // An already returned home flag is resting, not immediately picked again.
    && !(token.piece.side === piece.side && home(piece.side, cellId)))
    .sort((a, b) => Number(a.piece.side === piece.side) - Number(b.piece.side === piece.side));
}
function legalPickupsV2(game, side) {
  if (!side) return [];
  return game.board.flatMap(({ cellId, piece }) => piece?.side === side
    ? pickableTokensV2(game, piece, cellId).map((token) => ({ cellId, flagSide: token.piece.side })) : []);
}

function lastActionProblemV2(game) {
  const action = game.lastAction;
  if (action === null) return game.revision === 0 ? null : '缺少最后动作。';
  if (!action || !(V2_ACTIONS.includes(action.type) || game.ruleVersion === 'army-flip-v3' && action.type === 'timeout') || !game.players.some(({ id }) => id === action.playerId)) return '最后动作无效。';
  const actor = game.players.find(({ id }) => id === action.playerId);
  if (action.type === 'flip') {
    if (!exactKeys(action, ['type', 'playerId', 'cellId', 'side', 'kind']) || !isCellId(action.cellId)
        || !SIDES.includes(action.side) || !Object.hasOwn(PIECE_COUNTS, action.kind)) return '翻棋动作无效。';
    const piece = game.board.find(({ cellId }) => cellId === action.cellId).piece;
    if (!piece?.revealed || piece.side !== action.side || piece.kind !== action.kind) return '翻棋结果与棋盘不符。';
  } else if (action.type === 'move' || action.type === 'pickup') {
    if (actor.side === null) return '未定阵营不能走棋或拾旗。';
    if (!Array.isArray(action.flagEvents) || action.flagEvents.length > 4) return '旗事件无效。';
    if (action.type === 'move') {
      if (!exactKeys(action, ['type', 'playerId', 'from', 'to', 'outcome', 'flagEvents'])
          || !isCellId(action.from) || !isCellId(action.to) || action.from === action.to
          || !(V2_MOVE_OUTCOMES.includes(action.outcome)
            || game.ruleVersion === 'army-flip-v3' && action.outcome === 'mine-sacrifice')) return '走棋动作无效。';
      const from = game.board.find(({ cellId }) => cellId === action.from).piece;
      const to = game.board.find(({ cellId }) => cellId === action.to).piece;
      if (['friendly-reveal', 'protected-flag', 'ineligible-flag'].includes(action.outcome)) {
        if (!movable(from) || from.side !== actor.side || !to?.revealed || action.flagEvents.length) return '只翻不移的遭遇结果无效。';
        if (action.outcome === 'friendly-reveal' ? to.side !== actor.side
          : to.kind !== 'flag' || to.side === actor.side) return '暗子遭遇结果与棋盘不符。';
        if (action.outcome === 'protected-flag' && minesClearedV2(game, to.side)) return '护旗阻挡结果无效。';
        if (action.outcome === 'ineligible-flag' && (!minesClearedV2(game, to.side) || canCarryV2(game, from))) return '运旗资格阻挡结果无效。';
      } else if (from !== null) return '走棋起点未清空。';
      if (game.ruleVersion === 'army-flip-v3') {
        const deaths = game.captured.slice(action.outcome === 'mine-sacrifice' || action.outcome === 'mutual' ? -2 : -1);
        if (action.outcome === 'mine-sacrifice') {
          const [attacker, defender] = deaths;
          const before = { ...game, captured: game.captured.slice(0, -2) };
          if (to !== null || attacker?.side !== actor.side || defender?.side !== opposite(actor.side)
              || defender?.kind !== 'mine' || !canSacrificeDemineV3(before, attacker)) return '牺牲排雷结果无效。';
        } else if (action.outcome === 'mutual') {
          const [attacker, defender] = deaths;
          if (to !== null || attacker?.side !== actor.side || defender?.side !== opposite(actor.side)
              || !(attacker.kind === 'bomb' || defender.kind === 'bomb'
                || Object.hasOwn(RANKS, attacker.kind) && Object.hasOwn(RANKS, defender.kind)
                  && RANKS[attacker.kind] === RANKS[defender.kind])) return '同归结果无效。';
        } else if (action.outcome === 'capture') {
          const [defender] = deaths;
          if (!movable(to) || to.side !== actor.side || defender?.side !== opposite(actor.side)
              || !(defender.kind === 'mine' ? to.kind === 'engineer'
                : Object.hasOwn(RANKS, defender.kind) && RANKS[to.kind] > RANKS[defender.kind])) return '吃子结果无效。';
        } else if (action.outcome === 'attacker-lost') {
          const [attacker] = deaths;
          const before = { ...game, captured: game.captured.slice(0, -1) };
          if (attacker?.side !== actor.side || !to?.revealed || to.side !== opposite(actor.side)
              || !(to.kind === 'mine' ? attacker.kind !== 'engineer' && attacker.kind !== 'bomb'
                && !canSacrificeDemineV3(before, attacker)
                : Object.hasOwn(RANKS, to.kind) && RANKS[attacker.kind] < RANKS[to.kind])) return '攻子阵亡结果无效。';
        } else if (['move', 'flag-pickup'].includes(action.outcome)
            && (!movable(to) || to.side !== actor.side)) return '移动结果无效。';
      }
    } else if (!exactKeys(action, ['type', 'playerId', 'cellId', 'flagSide', 'flagEvents'])
        || !isCellId(action.cellId) || !SIDES.includes(action.flagSide)
        || !action.flagEvents.some((event) => event?.type === 'pickup' && event.side === action.flagSide)) return '拾旗动作无效。';
    const eventIds = new Set();
    for (const event of action.flagEvents) {
      if (!exactKeys(event, ['type', 'side', 'cellId', 'carrierId']) || !V2_FLAG_EVENTS.includes(event.type)
          || !SIDES.includes(event.side) || !isCellId(event.cellId)
          || event.cellId !== (action.type === 'move' ? action.to : action.cellId)
          || !CANONICAL.has(event.carrierId) || !Object.hasOwn(RANKS, CANONICAL.get(event.carrierId).kind)
          || eventIds.has(`${event.type}:${event.side}`)) return '旗事件字段无效。';
      eventIds.add(`${event.type}:${event.side}`);
      const token = game.flagTokens.find(({ piece }) => piece.side === event.side);
      const carrier = game.board.find(({ piece }) => piece?.id === event.carrierId);
      if (!token) return '旗事件缺少实体军旗。';
      const tokenCell = token.carrierId === null ? token.cellId
        : game.board.find(({ piece }) => piece?.id === token.carrierId)?.cellId;
      if (tokenCell !== event.cellId) return '旗事件结果位置与实体军旗不符。';
      if (event.type === 'drop') {
        if (!game.captured.some((piece) => piece.id === event.carrierId)) return '掉旗者必须已阵亡。';
      } else if (!carrier || carrier.cellId !== event.cellId || carrier.piece.side !== actor.side
          || !canCarryV2(game, carrier.piece, { empty: false })) return '旗事件携棋位置或资格无效。';
      if (event.type === 'pickup' && token.carrierId !== event.carrierId
          && !action.flagEvents.some((other) => other?.side === event.side && ['returned', 'delivered'].includes(other.type))) return '拾旗结果与携棋不符。';
      if (event.type === 'returned' && (event.side !== actor.side || !home(actor.side, event.cellId)
          || token.carrierId !== null || token.cellId !== event.cellId)) return '归位军旗无效。';
      if (event.type === 'delivered' && (event.side === actor.side || !home(actor.side, event.cellId)
          || token.carrierId !== null || token.cellId !== event.cellId)) return '运旗抵达结果无效。';
    }
  } else if (!exactKeys(action, ['type', 'playerId'])) return '动作记录格式无效。';
  if (['flip', 'move', 'pickup', 'timeout'].includes(action.type) && game.players[game.turnIndex].id === action.playerId) return '行动后必须换手。';
  if (action.type === 'offer-draw' && game.drawOfferByPlayerId !== action.playerId) return '求和请求与动作不符。';
  if (action.type !== 'offer-draw' && game.drawOfferByPlayerId !== null) return '旧求和请求必须清除。';
  if (action.type === 'resign' && (game.status !== 'finished' || game.result?.reason !== 'resigned')) return '认输必须结束对局。';
  if (action.type === 'accept-draw' && (game.status !== 'finished' || game.result?.reason !== 'draw-agreed')) return '同意求和必须结束对局。';
  return game.revision > 0 ? null : '动作修订号无效。';
}

function gameProblemV2(game) {
  if (!exactKeys(game, V2_STATE_KEYS) || game.gameType !== 'army-flip'
      || !({ 'army-flip-v2': 2, 'army-flip-v3': 3 }[game.ruleVersion] === game.version)
      || ![2, 3].includes(game.version) || !ASSIGNMENTS.includes(game.assignment)) return '翻棋对局版本无效。';
  const playerProblem = playersProblem(game.players, true);
  if (playerProblem) return playerProblem;
  if (!Array.isArray(game.board) || game.board.length !== 60 || !Array.isArray(game.captured)
      || !Array.isArray(game.flagTokens) || game.flagTokens.length > 2) return '棋盘、阵亡或运旗状态无效。';
  if (!Number.isSafeInteger(game.turnIndex) || game.turnIndex < 0 || game.turnIndex > 1
      || !Number.isSafeInteger(game.round) || game.round < 1 || game.round >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(game.revision) || game.revision < game.round - 1 || game.revision >= Number.MAX_SAFE_INTEGER
      || !['playing', 'finished'].includes(game.status)
      || !(game.drawOfferByPlayerId === null || game.players.some(({ id }) => id === game.drawOfferByPlayerId))) return '回合、求和或对局状态无效。';
  const ids = new Set();
  function checkPiece(piece, revealed = false) {
    if (!exactKeys(piece, ['id', 'side', 'kind', 'revealed']) || typeof piece.revealed !== 'boolean'
        || revealed && !piece.revealed) return '棋子字段无效。';
    const canonical = CANONICAL.get(piece.id);
    if (!canonical || canonical.side !== piece.side || canonical.kind !== piece.kind || ids.has(piece.id)) return '棋子身份、阵营或兵种无效。';
    ids.add(piece.id); return null;
  }
  for (let index = 0; index < game.board.length; index += 1) {
    const entry = game.board[index], cell = BOARD_CELLS[index];
    if (!exactKeys(entry, ['cellId', 'piece']) || entry.cellId !== cell.cellId) return '棋位重复、缺失或顺序无效。';
    if (entry.piece !== null) {
      const problem = checkPiece(entry.piece); if (problem) return problem;
      if (cell.terrain === 'camp' && (!entry.piece.revealed || !movable(entry.piece))) return '行营不能含暗子、地雷或军旗。';
    }
  }
  for (const piece of game.captured) {
    const problem = checkPiece(piece, true); if (problem) return problem;
    if (piece.kind === 'flag') return 'v2军旗只能在棋盘、地面或携棋上，不能阵亡。';
  }
  const carriers = new Set();
  for (const token of game.flagTokens) {
    if (!exactKeys(token, ['piece', 'carrierId', 'cellId']) || token.piece?.kind !== 'flag'
        || !((token.carrierId === null && isCellId(token.cellId))
          || typeof token.carrierId === 'string' && token.cellId === null)) return '军旗位置格式无效。';
    const problem = checkPiece(token.piece, true); if (problem) return problem;
    if (!minesClearedV2(game, token.piece.side)) return '运旗前必须清除该方三枚地雷。';
    if (token.carrierId !== null) {
      const carrier = game.board.find((entry) => entry.piece?.id === token.carrierId), piece = carrier?.piece;
      if (!piece || carriers.has(token.carrierId) || !canCarryV2(game, piece, { empty: false })) return '携旗棋子不存在、重复或没有资格。';
      if (home(piece.side, carrier.cellId)) return '携旗抵达本方基地后必须归位或结束。';
      carriers.add(token.carrierId);
    }
  }
  if (ids.size !== 50) return '必须保持50枚实体棋子，不能增减或重复。';
  if (knownCountV2(game) > game.round - 1) return '翻棋数量超过已行动回合。';
  const assigned = game.players[0].side !== null;
  if (assigned && knownCountV2(game) < (game.assignment === 'first-flip' ? 1 : 3)) return '阵营缺少足够翻棋记录。';
  if (assigned && game.assignment === 'two-flips' && game.players.some(({ lastFlipSide }) => lastFlipSide === null)) return '连翻阵营缺少双方翻棋记录。';
  if (!assigned && (game.captured.length || game.flagTokens.length
      || game.board.some(({ cellId, piece }) => piece && getCell(cellId).terrain === 'camp'))) return '未定阵营不能交战、运旗或占营。';
  if (game.revision === 0 && (game.round !== 1 || assigned || knownCountV2(game) || game.drawOfferByPlayerId !== null
      || game.players.some(({ lastFlipSide }) => lastFlipSide !== null))) return '初始状态无效。';
  const actionProblem = lastActionProblemV2(game); if (actionProblem) return actionProblem;
  const delivery = game.lastAction?.flagEvents?.find((event) => event.type === 'delivered');
  const noAction = (side) => !legalMovesV2(game, side).length && !legalPickupsV2(game, side).length;
  if (game.status === 'playing') {
    if (game.result !== null || game.winnerId !== null || delivery) return '进行中不能已有胜负或交付敌旗。';
    if (!assigned && !hiddenCells(game).length) return '未定阵营且暗子已翻完必须和棋。';
    if (assigned && !hiddenCells(game).length && noAction(game.players[game.turnIndex].side)) return '无合法动作的局面必须结束。';
    return null;
  }
  const result = game.result;
  if (!exactKeys(result, ['reason', 'winnerIds', 'scores', 'tie'])
      || !['flag-delivered', 'blocked', 'resigned', 'draw-agreed', 'assignment-exhausted'].includes(result.reason)
      || !Array.isArray(result.winnerIds) || !Array.isArray(result.scores) || result.scores.length !== 2
      || game.drawOfferByPlayerId !== null) return '终局结果格式无效。';
  for (let index = 0; index < 2; index += 1) {
    const score = result.scores[index], player = game.players[index];
    if (!exactKeys(score, ['playerId', 'name', 'points']) || score.playerId !== player.id
        || score.name !== player.name || score.points !== null) return '军棋结算不能伪造玩家或手牌分。';
  }
  if (['draw-agreed', 'assignment-exhausted'].includes(result.reason)) {
    if (result.tie !== true || result.winnerIds.length || game.winnerId !== null || delivery) return '和局结果无效。';
    if (result.reason === 'draw-agreed' && game.lastAction?.type !== 'accept-draw') return '同意求和记录无效。';
    if (result.reason === 'assignment-exhausted' && (assigned || game.assignment !== 'two-flips'
        || hiddenCells(game).length || game.captured.length || game.flagTokens.length || game.lastAction?.type !== 'flip')) return '分色耗尽和局条件无效。';
  } else {
    if (result.tie !== false || result.winnerIds.length !== 1 || game.winnerId !== result.winnerIds[0]
        || !game.players.some(({ id }) => id === game.winnerId)) return '胜方身份无效。';
    if (result.reason === 'resigned') {
      if (game.lastAction?.type !== 'resign' || game.lastAction.playerId === game.winnerId || delivery) return '认输结果无效。';
    } else if (result.reason === 'flag-delivered') {
      const winner = game.players.find(({ id }) => id === game.winnerId);
      if (!assigned || !delivery || delivery.side !== opposite(winner.side)
          || !home(winner.side, delivery.cellId) || game.lastAction.playerId !== winner.id
          || !['move', 'pickup'].includes(game.lastAction.type)) return '军旗须运回本方大本营才获胜。';
    } else if (delivery || !assigned || hiddenCells(game).length || game.players[game.turnIndex].id === game.winnerId
        || !noAction(game.players[game.turnIndex].side) || !['flip', 'move', 'pickup', ...(game.ruleVersion === 'army-flip-v3' ? ['timeout'] : [])].includes(game.lastAction?.type)
        || game.lastAction.playerId !== game.winnerId) return '困毙结果无效。';
  }
  return null;
}

function createGameV2(players, options) {
  const ruleVersion = options.ruleVersion ?? 'army-flip-v3';
  return { ...createGameV1(players, options), version: ruleVersion === 'army-flip-v3' ? 3 : 2,
    ruleVersion, flagTokens: [] };
}
function flagEvent(type, token, cellId, carrierId) {
  return { type, side: token.piece.side, cellId, carrierId };
}
function dropCargoV2(game, deadIds, cellId, events) {
  for (const token of game.flagTokens) if (deadIds.includes(token.carrierId)) {
    const carrierId = token.carrierId;
    token.carrierId = null; token.cellId = cellId;
    events.push(flagEvent('drop', token, cellId, carrierId));
  }
}
function takeTokenV2(token, piece, cellId, events) {
  token.carrierId = piece.id; token.cellId = null;
  events.push(flagEvent('pickup', token, cellId, piece.id));
}
function settleBaseV2(game, piece, cellId, playerId, events) {
  const token = cargo(game, piece.id);
  if (!token || !home(piece.side, cellId)) return;
  token.carrierId = null; token.cellId = cellId;
  if (token.piece.side === piece.side) events.push(flagEvent('returned', token, cellId, piece.id));
  else { events.push(flagEvent('delivered', token, cellId, piece.id)); finish(game, 'flag-delivered', playerId); }
}
function applyGameActionV2(game, playerId, action) {
  const problem = gameProblemV2(game); if (problem) return fail(problem);
  const playerIndex = game.players.findIndex(({ id }) => id === playerId);
  if (playerIndex < 0) return fail('你不在这局游戏中。');
  if (game.status !== 'playing') return fail('本局已经结束。');
  if (!action || typeof action !== 'object' || !V2_ACTIONS.includes(action.type)) return fail('不支持的军棋动作。');
  const keys = action.type === 'flip' ? ['type', 'cellId'] : action.type === 'move' ? ['type', 'from', 'to']
    : action.type === 'pickup' ? ['type', 'cellId', 'flagSide'] : ['type'];
  if (!exactKeys(action, keys)) return fail('军棋动作参数无效。');
  if (game.revision >= Number.MAX_SAFE_INTEGER - 1 || game.round >= Number.MAX_SAFE_INTEGER - 1) return fail('对局计数已达上限。');
  if (['flip', 'move', 'pickup'].includes(action.type) && playerIndex !== game.turnIndex) return fail('还没轮到你。');
  const next = copy(game), player = next.players[playerIndex]; next.revision += 1;
  if (action.type === 'resign') {
    next.lastAction = { type: 'resign', playerId }; finish(next, 'resigned', next.players[1 - playerIndex].id);
    return { ok: true, state: next };
  }
  if (action.type === 'offer-draw') {
    if (next.drawOfferByPlayerId !== null) return fail('已有求和请求，请先处理。');
    next.drawOfferByPlayerId = playerId; next.lastAction = { type: action.type, playerId }; return { ok: true, state: next };
  }
  if (action.type === 'accept-draw' || action.type === 'decline-draw') {
    if (next.drawOfferByPlayerId === null || next.drawOfferByPlayerId === playerId) return fail('只能回应对方的求和请求。');
    next.drawOfferByPlayerId = null; next.lastAction = { type: action.type, playerId };
    if (action.type === 'accept-draw') finish(next, 'draw-agreed');
    return { ok: true, state: next };
  }
  if (action.type === 'flip') {
    if (!isCellId(action.cellId)) return fail('翻棋位置无效。');
    const piece = next.board.find(({ cellId }) => cellId === action.cellId).piece;
    if (!piece || piece.revealed) return fail('这里没有可翻开的暗子。');
    piece.revealed = true;
    if (player.side === null && (next.assignment === 'first-flip' || player.lastFlipSide === piece.side)) {
      player.side = piece.side; next.players[1 - playerIndex].side = opposite(piece.side);
    }
    player.lastFlipSide = piece.side;
    next.lastAction = { type: 'flip', playerId, cellId: action.cellId, side: piece.side, kind: piece.kind };
  } else if (action.type === 'pickup') {
    if (player.side === null) return fail('阵营尚未确定，请先翻棋。');
    if (!isCellId(action.cellId) || !SIDES.includes(action.flagSide)) return fail('拾旗位置或颜色无效。');
    const piece = next.board.find(({ cellId }) => cellId === action.cellId).piece;
    if (!piece?.revealed || piece.side !== player.side) return fail('只能用自己所在位置的明子拾旗。');
    const token = pickableTokensV2(next, piece, action.cellId).find(({ piece: flag }) => flag.side === action.flagSide);
    if (!token) return fail('这里没有这枚可拾取的军旗，或棋子没有运旗资格。');
    const events = []; takeTokenV2(token, piece, action.cellId, events);
    settleBaseV2(next, piece, action.cellId, playerId, events);
    next.lastAction = { type: 'pickup', playerId, cellId: action.cellId, flagSide: action.flagSide, flagEvents: events };
  } else {
    if (player.side === null) return fail('阵营尚未确定，请先翻棋。');
    if (!isCellId(action.from) || !isCellId(action.to) || action.from === action.to) return fail('走棋位置无效。');
    const source = next.board.find(({ cellId }) => cellId === action.from), target = next.board.find(({ cellId }) => cellId === action.to);
    if (!source.piece?.revealed || source.piece.side !== player.side || !movable(source.piece)) return fail('只能移动己方已翻开的可动棋子。');
    if (!destinationsV2(next, action.from, cells(next)).includes(action.to)) return fail('不能这样走棋或攻击。');
    const attacker = source.piece, defender = target.piece, events = [];
    if (defender && !defender.revealed) defender.revealed = true;
    let outcome;
    if (defender?.side === attacker.side) outcome = 'friendly-reveal';
    else if (defender?.kind === 'flag' && !minesClearedV2(next, defender.side)) outcome = 'protected-flag';
    else if (defender?.kind === 'flag' && !canCarryV2(next, attacker)) outcome = 'ineligible-flag';
    else {
      source.piece = null; outcome = 'move';
      if (!defender) target.piece = attacker;
      else if (defender.kind === 'flag') {
        const token = { piece: defender, carrierId: null, cellId: action.to };
        next.flagTokens.push(token); target.piece = attacker;
        takeTokenV2(token, attacker, action.to, events); outcome = 'flag-pickup';
      } else if (attacker.kind === 'bomb' || defender.kind === 'bomb'
          || Object.hasOwn(RANKS, defender.kind) && RANKS[attacker.kind] === RANKS[defender.kind]) {
        next.captured.push(attacker, defender); target.piece = null; outcome = 'mutual';
        dropCargoV2(next, [attacker.id, defender.id], action.to, events);
      } else if (defender.kind === 'mine' && canSacrificeDemineV3(next, attacker)) {
        next.captured.push(attacker, defender); target.piece = null; outcome = 'mine-sacrifice';
        dropCargoV2(next, [attacker.id, defender.id], action.to, events);
      } else if (defender.kind === 'mine' && attacker.kind !== 'engineer') {
        next.captured.push(attacker); outcome = 'attacker-lost'; dropCargoV2(next, [attacker.id], action.to, events);
      } else if (defender.kind === 'mine' || RANKS[attacker.kind] > RANKS[defender.kind]) {
        next.captured.push(defender); target.piece = attacker; outcome = 'capture';
        dropCargoV2(next, [defender.id], action.to, events);
      } else {
        next.captured.push(attacker); outcome = 'attacker-lost'; dropCargoV2(next, [attacker.id], action.to, events);
      }
      // A ground marker does not block roads/rails. Only an arriving survivor
      // picks it up; an unmoved defender can explicitly pick up next turn.
      if (target.piece?.id === attacker.id) {
        const token = pickableTokensV2(next, attacker, action.to)[0];
        if (token) takeTokenV2(token, attacker, action.to, events);
        settleBaseV2(next, attacker, action.to, playerId, events);
      }
    }
    next.lastAction = { type: 'move', playerId, from: action.from, to: action.to, outcome, flagEvents: events };
  }
  next.drawOfferByPlayerId = null; next.round += 1; next.turnIndex = 1 - next.turnIndex;
  if (next.status === 'playing' && next.players[0].side === null && !hiddenCells(next).length) finish(next, 'assignment-exhausted');
  else if (next.status === 'playing' && next.players[0].side !== null && !hiddenCells(next).length
      && !legalMovesV2(next, next.players[next.turnIndex].side).length
      && !legalPickupsV2(next, next.players[next.turnIndex].side).length) finish(next, 'blocked', playerId);
  const resultProblem = gameProblemV2(next); return resultProblem ? fail(resultProblem) : { ok: true, state: next };
}
function privateViewV2(game, playerId) {
  const problem = gameProblemV2(game); if (problem) throw new Error(problem);
  const player = game.players.find(({ id }) => id === playerId); if (!player) throw new Error('你不在这局游戏中。');
  const yourTurn = game.status === 'playing' && game.players[game.turnIndex].id === playerId;
  const visiblePiece = (piece) => ({ hidden: false, id: piece.id, side: piece.side, kind: piece.kind, label: PIECE_LABELS[piece.kind] });
  return { version: game.version, gameType: game.gameType, ruleVersion: game.ruleVersion, assignment: game.assignment,
    playerId, players: copy(game.players), board: game.board.map(({ cellId, piece }) => ({ cellId,
      piece: !piece ? null : !piece.revealed ? { hidden: true } : visiblePiece(piece) })),
    capturedPieces: game.captured.map(visiblePiece),
    flagTokens: game.flagTokens.map(({ piece, carrierId, cellId }) => ({ side: piece.side, carrierId, cellId })),
    turnIndex: game.turnIndex, turnPlayerId: game.players[game.turnIndex].id, round: game.round, revision: game.revision,
    status: game.status, winnerId: game.winnerId, result: copy(game.result), drawOfferByPlayerId: game.drawOfferByPlayerId,
    lastAction: copy(game.lastAction), legalFlips: yourTurn ? hiddenCells(game) : [],
    legalMoves: yourTurn ? legalMovesV2(game, player.side) : [], legalPickups: yourTurn ? legalPickupsV2(game, player.side) : [] };
}

export function gameProblem(game) {
  if (game?.ruleVersion === 'army-flip-v1') return gameProblemV1(game);
  if (['army-flip-v2', 'army-flip-v3'].includes(game?.ruleVersion)) return gameProblemV2(game);
  return '翻棋对局版本无效。';
}
export function createGame(players, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('对局选项无效。');
  const ruleVersion = options.ruleVersion ?? 'army-flip-v3';
  if (!['army-flip-v1', 'army-flip-v2', 'army-flip-v3'].includes(ruleVersion)) throw new Error('翻棋对局版本无效。');
  return ruleVersion === 'army-flip-v1' ? createGameV1(players, options) : createGameV2(players, options);
}
// Server-only timer entry point: intentionally absent from applyGameAction/actionFields.
export function applyTimeout(game, playerId) {
  const problem = gameProblemV2(game);
  if (game?.ruleVersion !== 'army-flip-v3' || problem) return fail(problem || '旧局没有自动跳过。');
  if (game.status !== 'playing' || game.players[game.turnIndex].id !== playerId) return fail('回合已经改变。');
  if (game.revision >= Number.MAX_SAFE_INTEGER - 1 || game.round >= Number.MAX_SAFE_INTEGER - 1) return fail('对局计数已达上限。');
  const next = copy(game);
  next.revision += 1; next.round += 1; next.turnIndex = 1 - next.turnIndex;
  next.drawOfferByPlayerId = null; next.lastAction = { type: 'timeout', playerId };
  if (next.players[0].side !== null && !hiddenCells(next).length
      && !legalMovesV2(next, next.players[next.turnIndex].side).length
      && !legalPickupsV2(next, next.players[next.turnIndex].side).length) finish(next, 'blocked', playerId);
  const after = gameProblemV2(next);
  return after ? fail(after) : { ok: true, state: next };
}

export function applyGameAction(game, playerId, action) {
  return game?.ruleVersion === 'army-flip-v1' ? applyGameActionV1(game, playerId, action)
    : ['army-flip-v2', 'army-flip-v3'].includes(game?.ruleVersion) ? applyGameActionV2(game, playerId, action) : fail('翻棋对局版本无效。');
}
export function privateView(game, playerId) {
  if (game?.ruleVersion === 'army-flip-v1') return privateViewV1(game, playerId);
  if (['army-flip-v2', 'army-flip-v3'].includes(game?.ruleVersion)) return privateViewV2(game, playerId);
  throw new Error('翻棋对局版本无效。');
}
