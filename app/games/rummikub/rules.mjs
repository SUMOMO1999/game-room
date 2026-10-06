/**
 * Shared Rummikub validation and local teaching fixtures. Rule metadata keeps
 * older saved games on their original joker restrictions.
 */
import { JOKER_TYPES, configuredJokers, normalizeJokerConfig, jokerCountOf, analyzeTwistMeld } from './jokers.mjs';
export { JOKER_TYPES, JOKER_CONFIG_KEYS, JOKER_LIMITS, normalizeJokerConfig, defaultJokerConfig, jokerCountOf } from './jokers.mjs';

export const COLORS = Object.freeze(['red', 'blue', 'black', 'orange']);
const RULE_VERSIONS = new Set(['practice-v1', 'practice-v2', 'friends-v1', 'friends-v2', 'friends-v3', 'friends-v4']);

/** Old practice saves had no rule metadata and retain the original rules. */
export function ruleVersionOf(state) {
  return state?.ruleVersion === undefined ? 'practice-v1' : state.ruleVersion;
}

/** v2 checks the complete legal table at commit, including rearranged jokers. */
export function canRearrangeJokers(state) {
  return ['practice-v2', 'friends-v2', 'friends-v3', 'friends-v4'].includes(ruleVersionOf(state));
}

export function createDeck(options = {}) {
  const { copies = 2, jokerCount = 2, jokerConfig } = options;
  const configured = jokerConfig === undefined ? null : normalizeJokerConfig(jokerConfig);
  if (![2, 3].includes(copies) || !configured && ![2, 3, 4].includes(jokerCount)) {
    throw new Error('牌组只支持2或3副数字牌，以及2至4张鬼牌。');
  }
  if (configured && Object.hasOwn(options, 'jokerCount') && jokerCount !== jokerCountOf(configured)) {
    throw new Error('鬼牌总数必须与四种设置一致。');
  }
  const tiles = [];
  for (const color of COLORS) {
    for (const copy of ['a', 'b', 'c'].slice(0, copies)) {
      for (let value = 1; value <= 13; value += 1) {
        tiles.push({ id: `${color}-${value}-${copy}`, color, value });
      }
    }
  }
  // A joker's color/value are placeholders, never its represented value.
  if (configured) return [...tiles, ...configuredJokers(configured)];
  for (const copy of ['a', 'b', 'c', 'd'].slice(0, jokerCount)) {
    tiles.push({ id: `joker-${copy}`, color: 'red', value: 1, joker: true });
  }
  return tiles;
}

const DECK = createDeck();
const DECK_BY_ID = new Map(DECK.map((tile) => [tile.id, tile]));

function copyTile(tile) {
  return tile.joker
    ? { id: tile.id, color: tile.color, value: tile.value, joker: true,
      ...(tile.jokerType === undefined ? {} : { jokerType: tile.jokerType }) }
    : { id: tile.id, color: tile.color, value: tile.value };
}

function copyState(state) {
  return {
    version: 1,
    ...(state.ruleVersion === undefined ? {} : { ruleVersion: state.ruleVersion }),
    ...(state.jokerConfig === undefined ? {} : { jokerConfig: normalizeJokerConfig(state.jokerConfig) }),
    rack: state.rack.map(copyTile),
    pool: state.pool.map(copyTile),
    board: state.board.map((meld) => meld.map(copyTile)),
    opened: state.opened,
    round: state.round,
  };
}

function tileProblem(tile) {
  if (!tile || typeof tile !== 'object' || typeof tile.id !== 'string' || !tile.id) {
    return '每张牌都需要唯一的 ID。';
  }
  if (!COLORS.includes(tile.color) || !Number.isInteger(tile.value)
      || tile.value < 1 || tile.value > 13) {
    return '牌的颜色或数字无效。';
  }
  if (tile.joker !== undefined && tile.joker !== true) {
    return '鬼牌标记无效。';
  }
  if (tile.jokerType !== undefined && (!tile.joker || !JOKER_TYPES.includes(tile.jokerType))) return '鬼牌类型无效。';
  return null;
}

function invalidMeld(reason) {
  return { valid: false, type: null, points: 0, reason, values: new Map() };
}

/** Meld order is cosmetic; ambiguous joker assignments take the highest points. */
function analyzeMeld(tiles, options = {}) {
  if (options.ruleVersion !== undefined && !RULE_VERSIONS.has(options.ruleVersion)) return invalidMeld('规则版本无效。');
  // Subtypes may infer Twist for standalone tools, but cannot upgrade an
  // explicitly frozen legacy game or reinterpret its physical joker cards.
  if (options.ruleVersion !== undefined && !['friends-v3', 'friends-v4'].includes(options.ruleVersion)
      && (options.jokerConfig !== undefined || Array.isArray(tiles) && tiles.some((tile) => tile?.jokerType !== undefined))) {
    return invalidMeld('本局旧版规则不支持特殊鬼牌。');
  }
  const twist = ['friends-v3', 'friends-v4'].includes(options.ruleVersion) || options.jokerConfig !== undefined
    || Array.isArray(tiles) && tiles.some((tile) => tile?.jokerType !== undefined);
  let maxJokers, configured;
  try {
    configured = options.jokerConfig === undefined ? null : normalizeJokerConfig(options.jokerConfig);
    maxJokers = options.maxJokers ?? (configured === null ? 2 : Object.values(configured).reduce((sum, count) => sum + count, 0));
  }
  catch { return invalidMeld('鬼牌数量配置无效。'); }
  if (!Number.isInteger(maxJokers) || maxJokers < 0 || maxJokers > (twist ? 24 : 4)) {
    return invalidMeld('鬼牌数量配置无效。');
  }
  if (!Array.isArray(tiles) || tiles.length < 3) {
    return invalidMeld('每组至少需要3张牌。');
  }
  if (tiles.length > (twist ? 27 : 13)) return invalidMeld(twist ? '特殊组合最多27张实体牌。' : '一组最多只能有13张牌。');

  const ids = new Set();
  for (const tile of tiles) {
    const problem = tileProblem(tile);
    if (problem) return invalidMeld(problem);
    if (ids.has(tile.id)) return invalidMeld('同一张牌不能重复使用。');
    ids.add(tile.id);
  }

  const regular = tiles.filter((tile) => !tile.joker);
  const jokers = tiles.filter((tile) => tile.joker);
  if (jokers.length > maxJokers || regular.length === 0) {
    return invalidMeld(`一组最多使用${maxJokers}张鬼牌，并且需要普通牌。`);
  }
  if (configured !== null) {
    const keys = { normal: 'normal', mirror: 'mirror', 'color-change': 'colorChange', double: 'double' };
    for (const type of JOKER_TYPES) {
      if (jokers.filter((tile) => (tile.jokerType ?? 'normal') === type).length > configured[keys[type]]) return invalidMeld('组合中的鬼牌类型数量超出本局设置。');
    }
  }
  if (twist) return analyzeTwistMeld(tiles, options);

  const candidates = [];
  const sameNumber = regular.every((tile) => tile.value === regular[0].value);
  const distinctColors = new Set(regular.map((tile) => tile.color)).size === regular.length;
  if (tiles.length <= 4 && sameNumber && distinctColors) {
    const value = regular[0].value;
    candidates.push({
      valid: true,
      type: 'group',
      points: value * tiles.length,
      reason: '',
      values: new Map(tiles.map((tile) => [tile.id, value])),
    });
  }

  const sameColor = regular.every((tile) => tile.color === regular[0].color);
  const regularValues = new Set(regular.map((tile) => tile.value));
  if (sameColor && regularValues.size === regular.length) {
    const minimum = Math.min(...regularValues);
    const maximum = Math.max(...regularValues);
    const firstStart = Math.max(1, maximum - tiles.length + 1);
    const lastStart = Math.min(minimum, 14 - tiles.length);
    if (firstStart <= lastStart) {
      // A later range scores higher. All values stay between 1 and 13.
      const start = lastStart;
      const missing = [];
      const values = new Map(regular.map((tile) => [tile.id, tile.value]));
      for (let value = start; value < start + tiles.length; value += 1) {
        if (!regularValues.has(value)) missing.push(value);
      }
      jokers.forEach((tile, index) => values.set(tile.id, missing[index]));
      candidates.push({
        valid: true,
        type: 'run',
        points: (start + start + tiles.length - 1) * tiles.length / 2,
        reason: '',
        values,
      });
    }
  }

  if (candidates.length) {
    // Array#sort is stable: equal scores preserve the group candidate first.
    return candidates.sort((left, right) => right.points - left.points)[0];
  }
  if (sameNumber) {
    return invalidMeld(distinctColors
      ? '同数组合只能由3或4张不同颜色的牌组成。'
      : '同数组合的颜色不能重复。');
  }
  if (sameColor) {
    return invalidMeld('顺子必须数字连续，且不能从13循环到1。');
  }
  return invalidMeld('需要同数不同色的组牌，或同色连续的顺子。');
}

export function validateMeld(tiles, options = {}) {
  const { valid, type, points, reason } = analyzeMeld(tiles, options);
  return { valid, type, points, reason };
}

/**
 * Return a new array with valid runs in represented-value order, including
 * jokers. Groups and unfinished/invalid drafts retain their visual order.
 * Physical tile objects, IDs and joker placeholder fields are never changed.
 */
export function normalizeMeld(tiles, options = {}) {
  if (!Array.isArray(tiles)) return [];
  const result = analyzeMeld(tiles, options);
  if (result.valid && result.ordered) return [...result.ordered];
  const ordered = [...tiles];
  if (result.valid && result.type === 'run') {
    ordered.sort((first, second) => result.values.get(first.id) - result.values.get(second.id));
  }
  return ordered;
}

/** Fixed teaching hand and table, with an ordered remaining pool. */
export function createPracticeState() {
  const boardIds = [
    ['red-1-a', 'red-2-a', 'red-3-a'],
    ['blue-7-a', 'blue-8-a', 'blue-9-a'],
    ['red-11-a', 'blue-11-a', 'black-11-a'],
  ];
  const rackIds = [
    'red-10-a', 'blue-10-a', 'black-10-a',
    'red-6-a', 'red-7-a', 'red-8-a',
    'blue-4-a', 'black-4-a', 'orange-4-a',
    'joker-a', 'orange-2-a', 'orange-6-a', 'black-13-a', 'blue-1-a',
  ];
  return practiceState(boardIds, rackIds, false);
}

/** Replace the red 7 joker, then reuse it in the existing blue run. */
export function createJokerPracticeState() {
  return practiceState([
    ['red-6-a', 'joker-a', 'red-8-a'],
    ['blue-10-a', 'blue-11-a', 'blue-12-a'],
  ], [
    'red-7-a', 'blue-9-a', 'red-10-a', 'blue-10-b', 'black-10-a',
    'red-9-a', 'black-4-a', 'orange-4-a', 'joker-b', 'orange-2-a',
    'orange-6-a', 'black-13-a', 'blue-1-a', 'red-1-a',
  ], true);
}

function practiceState(boardIds, rackIds, opened) {
  const used = new Set([...boardIds.flat(), ...rackIds]);
  return {
    version: 1,
    ruleVersion: 'practice-v2',
    rack: rackIds.map((id) => copyTile(DECK_BY_ID.get(id))),
    pool: DECK.filter((tile) => !used.has(tile.id)).map(copyTile),
    board: boardIds.map((ids) => ids.map((id) => copyTile(DECK_BY_ID.get(id)))),
    opened,
    round: 1,
  };
}

export function stateProblem(state, checkBoard = false, options = {}) {
  const configured = options.jokerConfig ?? state?.jokerConfig;
  const resolved = configured === undefined ? options : { ...options, jokerConfig: configured };
  let deck;
  try {
    deck = createDeck(resolved);
  } catch {
    return '规则牌组配置无效。';
  }
  const deckById = new Map(deck.map((tile) => [tile.id, tile]));
  if (!state || state.version !== 1 || !Array.isArray(state.rack)
      || !Array.isArray(state.pool) || !Array.isArray(state.board)
      || !state.board.every(Array.isArray) || typeof state.opened !== 'boolean'
      || !Number.isSafeInteger(state.round) || state.round < 1) {
    return '练习状态格式无效，请重新开始。';
  }
  if (!RULE_VERSIONS.has(ruleVersionOf(state))) return '规则版本无效，请重新开始。';
  if (['friends-v3', 'friends-v4'].includes(ruleVersionOf(state)) && (configured === undefined || state.jokerConfig === undefined)
      || !['friends-v3', 'friends-v4'].includes(ruleVersionOf(state)) && configured !== undefined) return '鬼牌设置与本局规则版本不一致。';
  if (state.jokerConfig !== undefined) {
    try { if (JSON.stringify(normalizeJokerConfig(state.jokerConfig)) !== JSON.stringify(normalizeJokerConfig(configured))) return '草稿不能改变鬼牌设置。'; }
    catch { return '鬼牌设置无效。'; }
  }
  const tiles = [...state.rack, ...state.pool, ...state.board.flat()];
  if (tiles.length !== deck.length) return `牌数必须保持${deck.length}张，不能增加或丢失牌。`;
  const ids = new Set();
  for (const tile of tiles) {
    const problem = tileProblem(tile);
    if (problem) return problem;
    if (ids.has(tile.id)) return '同一张牌不能重复使用。';
    ids.add(tile.id);
    const original = deckById.get(tile.id);
    if (!original || original.color !== tile.color || original.value !== tile.value
        || Boolean(original.joker) !== Boolean(tile.joker) || original.jokerType !== tile.jokerType) {
      return '牌的 ID、颜色、数字或鬼牌身份不能改变。';
    }
  }
  if (checkBoard) {
    for (const meld of state.board) {
      const result = validateMeld(meld, { ...resolved, ruleVersion: ruleVersionOf(state), maxJokers: configured === undefined ? options.jokerCount ?? 2 : jokerCountOf(configured) });
      if (!result.valid) return `已提交桌面无效：${result.reason}`;
    }
  }
  return null;
}

function meldKey(meld) {
  return JSON.stringify(meld.map((tile) => tile.id).sort());
}

function samePool(first, second) {
  return first.length === second.length
    && first.every((tile, index) => tile.id === second[index].id);
}

function invalidDraft(reason) {
  return { valid: false, reason, points: 0, playedIds: [] };
}

/** Validate against the configured complete physical deck. Never mutates. */
export function evaluateDraft(committedState, draftState, options = {}) {
  const configured = options.jokerConfig ?? committedState?.jokerConfig;
  if (configured !== undefined) options = { ...options, jokerConfig: configured };
  const committedProblem = stateProblem(committedState, true, options);
  if (committedProblem) return invalidDraft(committedProblem);
  const draftProblem = stateProblem(draftState, false, options);
  if (draftProblem) return invalidDraft(draftProblem);
  if (draftState.opened !== committedState.opened || draftState.round !== committedState.round) {
    return invalidDraft('草稿不能改变开局标记或回合数。');
  }
  if (ruleVersionOf(draftState) !== ruleVersionOf(committedState)) {
    return invalidDraft('草稿不能改变本局规则版本。');
  }
  if (!samePool(committedState.pool, draftState.pool)) {
    return invalidDraft('出牌草稿不能改变牌池，请通过摸牌结束回合。');
  }

  const rackIds = new Set(committedState.rack.map((tile) => tile.id));
  if (draftState.rack.some((tile) => !rackIds.has(tile.id))) {
    return invalidDraft('桌面牌不能取回手牌。');
  }
  const remaining = new Set(draftState.rack.map((tile) => tile.id));
  const playedIds = committedState.rack.filter((tile) => !remaining.has(tile.id)).map((tile) => tile.id);
  if (!playedIds.length) return invalidDraft('本回合至少需要出一张手牌。');

  const draftKeys = new Set(draftState.board.map(meldKey));
  if (!committedState.opened
      && committedState.board.some((meld) => !draftKeys.has(meldKey(meld)))) {
    return invalidDraft('首次开局只能使用自己的手牌，不能改动原有桌面组合。');
  }
  if (committedState.opened && !canRearrangeJokers(committedState) && committedState.board.some((meld) =>
    meld.some((tile) => tile.joker) && !draftKeys.has(meldKey(meld)))) {
    return invalidDraft('本局沿用旧版规则，已提交的鬼牌组合锁定，可以整组移动，但不能拆分或接牌。');
  }

  const played = new Set(playedIds);
  let points = 0;
  for (const meld of draftState.board) {
    const result = analyzeMeld(meld, { ...options, ruleVersion: ruleVersionOf(committedState), maxJokers: configured === undefined ? options.jokerCount ?? 2 : jokerCountOf(configured) });
    if (!result.valid) return invalidDraft(result.reason);
    for (const tile of meld) {
      if (played.has(tile.id)) points += result.values.get(tile.id);
    }
  }
  if (!committedState.opened && points < 30) {
    return { valid: false, reason: `首次开局至少需要30点，当前是${points}点。`, points, playedIds };
  }
  return { valid: true, reason: '', points, playedIds };
}

/** Return {ok:true,state} or {ok:false,error}; failures leave both inputs intact. */
export function commitDraft(committedState, draftState, options = {}) {
  const result = evaluateDraft(committedState, draftState, options);
  if (!result.valid) return { ok: false, error: result.reason };
  const state = copyState(draftState);
  const configured = options.jokerConfig ?? committedState?.jokerConfig;
  state.board = state.board.map((meld) => normalizeMeld(meld, { ...options, ruleVersion: ruleVersionOf(state), maxJokers: configured === undefined ? options.jokerCount ?? 2 : jokerCountOf(configured) }));
  state.opened = true;
  state.round += 1;
  return { ok: true, state };
}

/** Draw from the committed state, discarding UI draft edits. Ends this practice turn. */
export function drawTile(committedState, options = {}) {
  const problem = stateProblem(committedState, true, options);
  if (problem) return { ok: false, error: problem };
  if (!committedState.rack.length) return { ok: false, error: '手牌已全部出完，本次练习结束。' };
  if (!committedState.pool.length) return { ok: false, error: '牌池已空，本次练习结束。' };
  const state = copyState(committedState);
  state.rack.push(state.pool.shift());
  state.round += 1;
  return { ok: true, state };
}

/** Sorting is cosmetic and keeps IDs stable. Jokers appear at the end. */
export function sortRack(rack) {
  return rack.map(copyTile).sort((first, second) =>
    Number(Boolean(first.joker)) - Number(Boolean(second.joker))
    || COLORS.indexOf(first.color) - COLORS.indexOf(second.color)
    || first.value - second.value
    || first.id.localeCompare(second.id));
}
