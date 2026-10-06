/**
 * Server-only Rummikub model with versioned friend-room rules.
 * Provisional rules: no timer/penalty; initial turn cannot alter the old table;
 * friends-v1 keeps submitted joker melds locked; friends-v2 permits legal
 * end-of-turn rearrangement. An empty pool permits voluntary passes.
 */
import { randomInt as secureRandomInt } from 'node:crypto';
import { createDeck, createPracticeState, evaluateDraft, normalizeMeld, validateMeld, normalizeJokerConfig, jokerCountOf } from './rules.mjs';

const sample = createPracticeState();
const BASE_DECK = [...sample.rack, ...sample.pool, ...sample.board.flat()];
const BASE_IDS = new Set(BASE_DECK.map((tile) => tile.id));
const deckOptions = (game) => ({ copies: game.copies, jokerCount: game.jokerCount,
  ...(game.jokerConfig === undefined ? {} : { jokerConfig: game.jokerConfig }), ruleVersion: game.ruleVersion });
const meldOptions = (game) => ({ ...deckOptions(game), maxJokers: game.jokerCount });

function gameDeck(config) {
  const configured = createDeck(config);
  const configuredIds = new Set(configured.map(({ id }) => id));
  return [...BASE_DECK.filter(({ id }) => configuredIds.has(id)), ...configured.filter((tile) => !BASE_IDS.has(tile.id))].map(copyTile);
}

function copyTile(tile) {
  return tile.joker
    ? { id: tile.id, color: tile.color, value: tile.value, joker: true,
      ...(tile.jokerType === undefined ? {} : { jokerType: tile.jokerType }) }
    : { id: tile.id, color: tile.color, value: tile.value };
}

function copyResult(result) {
  if (!result) return null;
  return {
    reason: result.reason,
    winnerIds: [...result.winnerIds],
    scores: result.scores.map(({ playerId, name, points }) => ({ playerId, name, points })),
    tie: result.tie,
  };
}

// Public positions describe each board meld in the same order. A null board or
// individual position uses automatic layout. Old snapshots have no field and
// remain valid. Neither IDs outside the public board nor hidden metadata belong
// in this presentation field.
function positionsProblem(positions, meldCount) {
  if (positions === undefined || positions === null) return null;
  if (!Array.isArray(positions) || positions.length !== meldCount
      || Reflect.ownKeys(positions).some((key) => key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= positions.length))
      || Object.keys(positions).length !== positions.length) return '桌面位置必须逐组对应公开组合。';
  for (const point of positions) {
    if (point === null) continue;
    if (!point || typeof point !== 'object' || Array.isArray(point)
        || Reflect.ownKeys(point).length !== 2 || !Object.hasOwn(point, 'x') || !Object.hasOwn(point, 'y')
        || !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return '桌面位置只能包含0至1的有限x/y坐标。';
  }
  return null;
}

function copyPositions(positions) {
  return positions === undefined || positions === null ? null
    : positions.map((point) => point === null ? null : { x: point.x === 0 ? 0 : point.x, y: point.y === 0 ? 0 : point.y });
}

function actionPositionsProblem(action, meldCount) {
  if (Object.hasOwn(action, 'boardPositions') && action.boardPositions === undefined) return '桌面位置格式无效。';
  return positionsProblem(action.boardPositions, meldCount);
}

const meldIdentity = (meld) => meld.map((tile) => typeof tile === 'string' ? tile : tile.id).sort().join('|');

function inheritPositions(game, board) {
  if (game.boardPositions === undefined || game.boardPositions === null) return null;
  const previous = new Map(game.board.map((meld, index) => [meldIdentity(meld), game.boardPositions[index]]));
  const positions = board.map((meld) => previous.get(meldIdentity(meld)) ?? null);
  return positions.some((point) => point !== null) ? copyPositions(positions) : null;
}

function copyGame(game) {
  return {
    version: 1,
    board: game.board.map((meld) => meld.map(copyTile)),
    boardPositions: copyPositions(game.boardPositions),
    pool: game.pool.map(copyTile),
    players: game.players.map(({ id, name, rack, opened }) => ({ id, name, rack: rack.map(copyTile), opened })),
    turnIndex: game.turnIndex,
    round: game.round,
    status: game.status,
    winnerId: game.winnerId,
    result: copyResult(game.result),
    revision: game.revision,
    consecutivePasses: game.consecutivePasses,
    ruleVersion: game.ruleVersion,
    copies: game.copies,
    jokerCount: game.jokerCount,
    ...(game.jokerConfig === undefined ? {} : { jokerConfig: normalizeJokerConfig(game.jokerConfig) }),
    tileCount: game.tileCount,
    deckCopies: game.copies,
    deckSize: game.tileCount,
  };
}

function playersProblem(players, withRacks = false) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 7) {
    return '拉密需要2至7位玩家。';
  }
  const ids = new Set();
  for (const player of players) {
    if (!player || typeof player.id !== 'string' || !player.id || player.id.length > 128
        || typeof player.name !== 'string' || !player.name.trim() || player.name.length > 32) {
      return '玩家需要有效的身份和1至32字的名字。';
    }
    if (ids.has(player.id)) return '玩家身份不能重复。';
    ids.add(player.id);
    if (withRacks && (!Array.isArray(player.rack) || typeof player.opened !== 'boolean')) {
      return '玩家手牌状态无效。';
    }
  }
  return null;
}

export function gameProblem(game) {
  if (!game || game.version !== 1 || !['friends-v1', 'friends-v2', 'friends-v3', 'friends-v4'].includes(game.ruleVersion)
      || !Array.isArray(game.pool) || !Array.isArray(game.board)
      || !game.board.every(Array.isArray)) return '对局状态无效。';
  const layoutProblem = positionsProblem(game.boardPositions, game.board.length);
  if (layoutProblem) return layoutProblem;
  const playerProblem = playersProblem(game.players, true);
  if (playerProblem) return playerProblem;
  try {
    if (['friends-v3', 'friends-v4'].includes(game.ruleVersion) && (game.jokerConfig === undefined || jokerCountOf(game.jokerConfig) !== game.jokerCount)
        || !['friends-v3', 'friends-v4'].includes(game.ruleVersion) && game.jokerConfig !== undefined) return '鬼牌设置与本局规则版本不一致。';
  } catch { return '鬼牌设置无效。'; }
  let deck;
  try {
    deck = createDeck(deckOptions(game));
  } catch {
    return '对局牌组配置无效。';
  }
  if (game.copies === undefined || game.jokerCount === undefined || game.tileCount !== deck.length
      || game.deckCopies !== game.copies || game.deckSize !== game.tileCount) return '对局牌组配置无效。';
  const deckIds = new Set(deck.map((tile) => tile.id));
  const canonical = new Map(deck.map((tile) => [tile.id, tile]));
  if (!Number.isSafeInteger(game.turnIndex) || game.turnIndex < 0 || game.turnIndex >= game.players.length
      || !Number.isSafeInteger(game.round) || game.round < 1 || game.round >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(game.revision) || game.revision < 0 || game.revision >= Number.MAX_SAFE_INTEGER
      || !Number.isInteger(game.consecutivePasses) || game.consecutivePasses < 0
      || game.consecutivePasses > game.players.length
      || !['playing', 'finished'].includes(game.status)) return '对局回合状态无效。';

  const tiles = [...game.pool, ...game.board.flat(), ...game.players.flatMap((player) => player.rack)];
  if (tiles.length !== deck.length) return `对局必须保持${deck.length}张牌，不能丢失或增加牌。`;
  const ids = new Set();
  for (const tile of tiles) {
    if (!tile || typeof tile.id !== 'string') return '牌的身份无效。';
    if (ids.has(tile.id)) return '同一张牌不能重复使用。';
    ids.add(tile.id);
    const original = canonical.get(tile.id);
    if (!deckIds.has(tile.id) || !original || original.color !== tile.color || original.value !== tile.value
        || original.joker !== tile.joker || original.jokerType !== tile.jokerType) return '牌的身份、颜色、数字或鬼牌类型不能改变。';
  }
  for (const meld of game.board) {
    const result = validateMeld(meld, meldOptions(game));
    if (!result.valid) return `已提交桌面无效：${result.reason}`;
  }
  if (game.status === 'playing') {
    if (game.winnerId !== null || game.result !== null
        || game.consecutivePasses >= game.players.length
        || game.players.some((player) => !player.rack.length)) return '进行中的对局状态无效。';
  } else {
    const playerIds = new Set(game.players.map((player) => player.id));
    const result = game.result;
    if (!result || !['rack-empty', 'blocked'].includes(result.reason)
        || !Array.isArray(result.winnerIds) || !result.winnerIds.length
        || result.winnerIds.some((id) => !playerIds.has(id))
        || new Set(result.winnerIds).size !== result.winnerIds.length
        || !Array.isArray(result.scores) || result.scores.length !== game.players.length
        || result.scores.some((score) => !score || !playerIds.has(score.playerId)
          || typeof score.name !== 'string' || !Number.isSafeInteger(score.points) || score.points < 0)
        || new Set(result.scores.map((score) => score.playerId)).size !== game.players.length
        || result.tie !== (result.winnerIds.length > 1)
        || game.winnerId !== (result.winnerIds.length === 1 ? result.winnerIds[0] : null)) {
      return '结束结果无效。';
    }
  }
  return null;
}

/**
 * Returns full private server state; never send this object to a browser.
 * options.randomInt(max) is a deterministic test seam; default is node:crypto.
 * The first player is random unless options.firstTurnIndex is explicitly set.
 */
export function createGame(players, options = {}) {
  const problem = playersProblem(players);
  if (problem) throw new Error(problem);
  if (!options || typeof options !== 'object') throw new Error('对局选项无效。');
  const randomInt = options.randomInt ?? secureRandomInt;
  if (typeof randomInt !== 'function') throw new Error('洗牌随机源无效。');
  const nextRandom = (maximum) => {
    const value = randomInt(maximum);
    if (!Number.isInteger(value) || value < 0 || value >= maximum) throw new Error('洗牌随机源返回了无效数值。');
    return value;
  };
  const copies = options.copies ?? (players.length > 4 ? 3 : 2);
  const jokerConfig = options.jokerConfig === undefined ? undefined : normalizeJokerConfig(options.jokerConfig);
  const jokerCount = jokerConfig === undefined ? options.jokerCount ?? copies : jokerCountOf(jokerConfig);
  if (jokerConfig !== undefined && options.jokerCount !== undefined && options.jokerCount !== jokerCount) throw new Error('鬼牌总数必须与设置一致。');
  const ruleVersion = options.ruleVersion ?? (jokerConfig === undefined ? 'friends-v2' : 'friends-v4');
  if (!['friends-v1', 'friends-v2', 'friends-v3', 'friends-v4'].includes(ruleVersion)
      || ['friends-v3', 'friends-v4'].includes(ruleVersion) !== (jokerConfig !== undefined)) throw new Error('鬼牌设置与本局规则版本不一致。');
  const deck = gameDeck({ copies, jokerCount, ...(jokerConfig === undefined ? {} : { jokerConfig }) });
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const target = nextRandom(index + 1);
    [deck[index], deck[target]] = [deck[target], deck[index]];
  }
  const firstTurnIndex = options.firstTurnIndex ?? nextRandom(players.length);
  if (!Number.isInteger(firstTurnIndex) || firstTurnIndex < 0 || firstTurnIndex >= players.length) {
    throw new Error('首位玩家无效。');
  }
  return {
    version: 1,
    board: [],
    boardPositions: null,
    pool: deck.slice(players.length * 14),
    players: players.map(({ id, name }, index) => ({
      id,
      name: name.trim(),
      rack: deck.slice(index * 14, (index + 1) * 14),
      opened: false,
    })),
    turnIndex: firstTurnIndex,
    round: 1,
    status: 'playing',
    winnerId: null,
    result: null,
    revision: 0,
    consecutivePasses: 0,
    ruleVersion,
    copies,
    jokerCount,
    ...(jokerConfig === undefined ? {} : { jokerConfig }),
    tileCount: deck.length,
    deckCopies: copies,
    deckSize: deck.length,
  };
}

function fail(error) {
  return { ok: false, error };
}

function scoresFor(game) {
  return game.players.map((player) => ({
    playerId: player.id,
    name: player.name,
    points: player.rack.reduce((sum, tile) => sum + (tile.joker ? 30 : tile.value), 0),
  }));
}

function finish(game, reason, winnerIds) {
  game.status = 'finished';
  game.winnerId = winnerIds.length === 1 ? winnerIds[0] : null;
  game.result = { reason, winnerIds, scores: scoresFor(game), tie: winnerIds.length > 1 };
}

function finishTurn(game) {
  game.revision += 1;
  game.round += 1;
  if (game.status === 'playing') game.turnIndex = (game.turnIndex + 1) % game.players.length;
  return { ok: true, state: game };
}

function submissionProblem(action, game) {
  const isId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 128;
  if (!Array.isArray(action.boardIds) || action.boardIds.length > 106
      || !action.boardIds.every((meld) => Array.isArray(meld) && meld.length <= (['friends-v3', 'friends-v4'].includes(game.ruleVersion) ? 27 : 13) && meld.every(isId))
      || !Array.isArray(action.rackIds) || action.rackIds.length > game.tileCount || !action.rackIds.every(isId)) {
    return '提交只能包含桌面牌ID组合和剩余手牌ID。';
  }
  const layoutProblem = actionPositionsProblem(action, action.boardIds.length);
  if (layoutProblem) return layoutProblem;
  return null;
}

function submit(game, playerIndex, action) {
  const problem = submissionProblem(action, game);
  if (problem) return fail(problem);
  const player = game.players[playerIndex];
  const canonical = new Map(createDeck(deckOptions(game)).map((tile) => [tile.id, tile]));
  const ownIds = new Set(player.rack.map((tile) => tile.id));
  const available = new Set([...ownIds, ...game.board.flat().map((tile) => tile.id)]);
  const seen = new Set();
  for (const id of [...action.rackIds, ...action.boardIds.flat()]) {
    if (!available.has(id)) return fail('只能使用自己的手牌与公开桌面牌。');
    if (seen.has(id)) return fail('同一张牌不能重复使用。');
    seen.add(id);
  }
  if (seen.size !== available.size) return fail('提交不能丢失手牌或桌面牌。');
  if (action.rackIds.some((id) => !ownIds.has(id))) return fail('桌面牌不能取回手牌。');

  // Other racks are appended to an unchanged hidden pool solely for the shared
  // complete-deck validator. The client never supplies or sees this hidden array.
  const hiddenPool = [
    ...game.pool,
    ...game.players.filter((_, index) => index !== playerIndex).flatMap((other) => other.rack),
  ];
  const committed = {
    version: 1, ruleVersion: game.ruleVersion, board: game.board, rack: player.rack, pool: hiddenPool,
    ...(game.jokerConfig === undefined ? {} : { jokerConfig: game.jokerConfig }),
    opened: player.opened, round: game.round,
  };
  const draft = {
    ...committed,
    board: action.boardIds.map((meld) => meld.map((id) => copyTile(canonical.get(id)))),
    rack: action.rackIds.map((id) => copyTile(canonical.get(id))),
  };
  const evaluation = evaluateDraft(committed, draft, deckOptions(game));
  if (!evaluation.valid) return fail(evaluation.reason);

  const next = copyGame(game);
  next.board = draft.board.map((meld) => normalizeMeld(meld, meldOptions(game)));
  next.boardPositions = Object.hasOwn(action, 'boardPositions')
    ? copyPositions(action.boardPositions) : inheritPositions(game, next.board);
  next.players[playerIndex].rack = draft.rack;
  next.players[playerIndex].opened = true;
  next.consecutivePasses = 0;
  if (!draft.rack.length) finish(next, 'rack-empty', [player.id]);
  return finishTurn(next);
}

/** Actions carry IDs only. Server-owned card identities and hidden racks prevail. */
export function applyGameAction(game, playerId, action) {
  const problem = gameProblem(game);
  if (problem) return fail(problem);
  if (game.status !== 'playing') return fail('本局已经结束。');
  const playerIndex = game.players.findIndex((player) => player.id === playerId);
  if (playerIndex === -1) return fail('你不在这局游戏中。');
  if (playerIndex !== game.turnIndex) return fail('还没轮到你，请等待朋友完成回合。');
  if (!action || typeof action !== 'object' || !['submit', 'draw', 'pass'].includes(action.type)) {
    return fail('不支持这个对局操作。');
  }
  if (action.type === 'submit') return submit(game, playerIndex, action);
  const layoutProblem = actionPositionsProblem(action, game.board.length);
  if (layoutProblem) return fail(layoutProblem);
  if (action.type === 'draw') {
    if (!game.pool.length) return fail('牌池已空，可以出牌或跳过回合。');
    const next = copyGame(game);
    if (Object.hasOwn(action, 'boardPositions')) next.boardPositions = copyPositions(action.boardPositions);
    next.players[playerIndex].rack.push(next.pool.shift());
    next.consecutivePasses = 0;
    return finishTurn(next);
  }
  if (game.pool.length) return fail('牌池还有牌，不能跳过；可以出牌或摸牌。');
  const next = copyGame(game);
  if (Object.hasOwn(action, 'boardPositions')) next.boardPositions = copyPositions(action.boardPositions);
  next.consecutivePasses += 1;
  if (next.consecutivePasses === next.players.length) {
    const scores = scoresFor(next);
    const minimum = Math.min(...scores.map((score) => score.points));
    finish(next, 'blocked', scores.filter((score) => score.points === minimum).map((score) => score.playerId));
  }
  return finishTurn(next);
}

/** Public game facts only: no pool IDs, any rack, or arbitrary fields. */
export function spectatorView(game) {
  const problem = gameProblem(game);
  if (problem) throw new Error(problem);
  return {
    version: 1,
    ruleVersion: game.ruleVersion,
    board: game.board.map((meld) => meld.map(copyTile)),
    boardPositions: copyPositions(game.boardPositions),
    poolCount: game.pool.length,
    players: game.players.map(({ id, name, rack, opened }) => ({ id, name, rackCount: rack.length, opened })),
    turnIndex: game.turnIndex,
    turnPlayerId: game.players[game.turnIndex].id,
    round: game.round,
    status: game.status,
    winnerId: game.winnerId,
    result: copyResult(game.result),
    revision: game.revision,
    consecutivePasses: game.consecutivePasses,
    copies: game.copies,
    jokerCount: game.jokerCount,
    ...(game.jokerConfig === undefined ? {} : { jokerConfig: normalizeJokerConfig(game.jokerConfig) }),
    tileCount: game.tileCount,
    deckCopies: game.copies,
    deckSize: game.tileCount,
  };
}

/** An explicit allow-list projection: only this player's own rack is added. */
export function privateView(game, playerId) {
  const view = spectatorView(game);
  const player = game.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error('你不在这局游戏中。');
  return { ...view, playerId, rack: player.rack.map(copyTile), opened: player.opened };
}
