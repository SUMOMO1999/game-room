/** Browser-safe, bounded presentation assistance. Authoritative rules stay in rules.mjs. */
import { COLORS, validateMeld, normalizeMeld, evaluateDraft, JOKER_TYPES, jokerCountOf } from './rules.mjs';

const RULES = new Set(['practice-v1', 'practice-v2', 'friends-v1', 'friends-v2', 'friends-v3', 'friends-v4']);
const MAX_CANDIDATES = 128;
const BEAM_WIDTH = 20;
const BEAM_DEPTH = 12;
const copyTile = (tile) => ({ ...tile });

/** Preserve physical tiles when extracting the middle of an ordered run.
 * Short fragments are allowed as a draft, never as a committed legal meld. */
export function splitRunAfterExtraction(original,removedIds,options={}) {
  if(!Array.isArray(original) || validateMeld(original,options).type!=='run')return [original.filter(tile=>!removedIds.includes(tile.id))].filter(group=>group.length);
  const removed=new Set(removedIds),segments=[];let current=[];
  for(const tile of normalizeMeld(original,options)) {
    if(removed.has(tile.id)){if(current.length)segments.push(current);current=[];}
    else current.push(tile);
  }
  if(current.length)segments.push(current);
  return segments;
}
const stableKey = (tiles) => tiles.map(({ id }) => id).sort().join('\0');
function tilesProblem(tiles) {
  if (!Array.isArray(tiles) || tiles.length > 180) return '手牌格式无效。';
  const ids = new Set();
  for (const tile of tiles) {
    if (!tile || typeof tile.id !== 'string' || !tile.id || ids.has(tile.id)
        || !COLORS.includes(tile.color) || !Number.isInteger(tile.value) || tile.value < 1 || tile.value > 13
        || tile.joker !== undefined && tile.joker !== true
        || tile.jokerType !== undefined && (!tile.joker || !JOKER_TYPES.includes(tile.jokerType))) return '牌的实体身份、颜色或数字无效。';
    ids.add(tile.id);
  }
  return null;
}
function settings(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('整理选项无效。');
  const twist = ['friends-v3', 'friends-v4'].includes(options.ruleVersion) || options.jokerConfig !== undefined;
  const maxJokers = options.maxJokers ?? options.jokerCount ?? (options.jokerConfig === undefined ? 2 : jokerCountOf(options.jokerConfig));
  if (!Number.isInteger(maxJokers) || maxJokers < 0 || maxJokers > (twist ? 24 : 4)) throw new TypeError('鬼牌数量配置无效。');
  if (options.jokerConfig !== undefined && jokerCountOf(options.jokerConfig) !== maxJokers) throw new TypeError('鬼牌数量与配置不一致。');
  if (options.ruleVersion !== undefined && !RULES.has(options.ruleVersion)) throw new TypeError('规则版本无效。');
  const mode = options.mode ?? 'color';
  if (!['color', 'number'].includes(mode)) throw new TypeError('整理方式无效。');
  const opened = options.opened ?? true;
  if (typeof opened !== 'boolean') throw new TypeError('开局标记无效。');
  return { maxJokers, mode, opened, ...(options.ruleVersion === undefined ? {} : { ruleVersion: options.ruleVersion }),
    ...(options.jokerConfig === undefined ? {} : { jokerConfig: options.jokerConfig }) };
}
function combinations(items, count) {
  const result = [];
  function choose(start, chosen) {
    if (chosen.length === count) { result.push([...chosen]); return; }
    for (let index = start; index <= items.length - (count - chosen.length); index += 1) {
      chosen.push(items[index]); choose(index + 1, chosen); chosen.pop();
    }
  }
  choose(0, []); return result;
}
const preferredType = (mode) => mode === 'number' ? 'group' : 'run';
function compareCandidates(a, b, config) {
  return Number(!config.opened && b.points >= 30) - Number(!config.opened && a.points >= 30)
    || b.tiles.length - a.tiles.length || a.jokers - b.jokers
    || Number(b.type === preferredType(config.mode)) - Number(a.type === preferredType(config.mode))
    || b.points - a.points || a.key.localeCompare(b.key);
}

/** Enumerate short finite runs and color subsets, with at most three physical copies per number. */
function candidatesFor(rack, config, indices) {
  const byColor = new Map(COLORS.map((color) => [color, new Map()]));
  const byValue = new Map();
  const jokers = [], special = { mirror: [], 'color-change': [], double: [] };
  for (const tile of rack) {
    if (tile.joker) {
      if (!tile.jokerType || tile.jokerType === 'normal') jokers.push(tile);
      else special[tile.jokerType].push(tile);
      continue;
    }
    const colorMap = byColor.get(tile.color);
    if (!colorMap.has(tile.value)) colorMap.set(tile.value, []);
    colorMap.get(tile.value).push(tile);
    if (!byValue.has(tile.value)) byValue.set(tile.value, new Map());
    const valueMap = byValue.get(tile.value);
    if (!valueMap.has(tile.color)) valueMap.set(tile.color, []);
    valueMap.get(tile.color).push(tile);
  }
  const availableJokers = jokers.slice(0, 4), found = new Map();
  const jokerChoices = new Map(Array.from({ length: Math.min(config.maxJokers, availableJokers.length) + 1 },
    (_, count) => [count, combinations(availableJokers, count)]));
  function add(tiles) {
    const key = stableKey(tiles);
    if (found.has(key)) return;
    const result = validateMeld(tiles, config);
    if (!result.valid) return;
    const ordered = normalizeMeld(tiles, config);
    found.set(key, { tiles: ordered, type: result.type, points: result.points,
      jokers: ordered.filter((tile) => tile.joker).length, key,
      mask: ordered.reduce((mask, tile) => mask | (1n << BigInt(indices.get(tile.id))), 0n) });
  }
  for (const colorMap of byColor.values()) {
    for (let start = 1; start <= 11; start += 1) {
      for (let end = start + 2; end <= 13; end += 1) {
        const available = [], missing = [];
        for (let value = start; value <= end; value += 1) {
          if (colorMap.has(value)) available.push(colorMap.get(value)); else missing.push(value);
        }
        if (!available.length || !jokerChoices.has(missing.length)) continue;
        const layers = Math.min(3, Math.max(...available.map((tiles) => tiles.length)));
        for (let layer = 0; layer < layers; layer += 1) {
          const regular = available.map((tiles) => tiles[Math.min(layer, tiles.length - 1)]);
          for (const chosen of jokerChoices.get(missing.length)) add([...regular, ...chosen]);
        }
      }
    }
  }
  for (const colorMap of byValue.values()) {
    const colors = COLORS.filter((color) => colorMap.has(color));
    for (let count = 1; count <= colors.length; count += 1) {
      for (const colorChoice of combinations(colors, count)) {
        const available = colorChoice.map((color) => colorMap.get(color));
        const layers = Math.min(3, Math.max(...available.map((tiles) => tiles.length)));
        for (let layer = 0; layer < layers; layer += 1) {
          const regular = available.map((tiles) => tiles[Math.min(layer, tiles.length - 1)]);
          for (let jokerCount = Math.max(0, 3 - count); jokerCount <= 4 - count; jokerCount += 1) {
            for (const chosen of jokerChoices.get(jokerCount) ?? []) add([...regular, ...chosen]);
          }
        }
      }
    }
  }
  // Each special family has its own finite proposal budget, independent from
  // the beam bound. Suggestions intentionally skip complicated mixed-joker
  // arrangements rather than attempting a factorial best-play solver.
  function doubleSuggestions() {
    let budget = 256;
    for (const colorMap of byColor.values()) for (let start = 1; start <= 11; start += 1) for (let end = start + 2; end <= 13; end += 1) {
      const regular = [], missing = [];
      for (let value = start; value <= end; value += 1) {
        if (colorMap.has(value)) regular.push(colorMap.get(value)[0]); else missing.push(value);
      }
      if (!regular.length) continue;
      for (let doubles = 1; doubles <= Math.min(2, special.double.length); doubles += 1) {
        const normals = missing.length - doubles * 2;
        if (normals < 0 || !jokerChoices.has(normals) || regular.length + normals + doubles < 3) continue;
        for (const chosen of jokerChoices.get(normals)) { if (!budget--) return; add([...regular, ...special.double.slice(0, doubles), ...chosen]); }
      }
    }
    for (const colorMap of byValue.values()) {
      const colors = COLORS.filter((color) => colorMap.has(color));
      for (const count of [1, 2]) for (const selected of combinations(colors, count)) {
        for (const ghost of special.double.slice(0, 2)) for (const chosen of jokerChoices.get(count === 1 ? 1 : 0) ?? []) {
          if (!budget--) return; add([...selected.map((color) => colorMap.get(color)[0]), ghost, ...chosen]);
        }
      }
    }
  }
  function colorSuggestions() {
    let budget = 256;
    for (const ghost of special['color-change'].slice(0, 2)) for (let length = 3; length <= 6; length += 1) {
      for (let start = 1; start <= 14 - length; start += 1) for (let pivot = start; pivot < start + length; pivot += 1) {
        for (const before of COLORS) for (const after of COLORS) if (before !== after) {
          const group = [];
          for (let value = start; value < start + length; value += 1) {
            const actual = value === pivot ? ghost : byColor.get(value < pivot ? before : after).get(value)?.[0];
            if (!actual) break;
            group.push(actual);
          }
          if (group.length === length) { if (!budget--) return; add(group); }
        }
      }
    }
  }
  function mirrorSuggestions() {
    let budget = 256;
    for (const ghost of special.mirror.slice(0, 2)) {
      for (const colorMap of byColor.values()) for (let start = 1; start <= 13; start += 1) for (let end = start; end <= 13; end += 1) {
        const first = [], second = [];
        for (let value = start; value <= end; value += 1) {
          const pair = colorMap.get(value); if (!pair || pair.length < 2) break;
          first.push(pair[0]); second.push(pair[1]);
        }
        if (first.length === end - start + 1) { if (!budget--) return; add([...first, ghost, ...second.toReversed()]); }
      }
      for (const colorMap of byValue.values()) {
        const colors = COLORS.filter((color) => (colorMap.get(color)?.length ?? 0) >= 2);
        for (let count = 1; count <= colors.length; count += 1) for (const selected of combinations(colors, count)) {
          if (!budget--) return; add([...selected.map((color) => colorMap.get(color)[0]), ghost, ...selected.toReversed().map((color) => colorMap.get(color)[1])]);
        }
      }
    }
  }
  if (special.double.length) doubleSuggestions();
  if (special['color-change'].length) colorSuggestions();
  if (special.mirror.length) mirrorSuggestions();
  return [...found.values()].sort((a, b) => compareCandidates(a, b, config));
}

function comparePlans(a, b, config) {
  return Number(!config.opened && b.points >= 30) - Number(!config.opened && a.points >= 30)
    || b.count - a.count || a.jokers - b.jokers || b.preferred - a.preferred
    || b.points - a.points || a.key.localeCompare(b.key);
}
function addMeld(plan, candidate, config) {
  const melds = [...plan.melds, candidate];
  return { mask: plan.mask | candidate.mask, melds,
    count: plan.count + candidate.tiles.length, points: plan.points + candidate.points,
    jokers: plan.jokers + candidate.jokers,
    preferred: plan.preferred + (candidate.type === preferredType(config.mode) ? candidate.tiles.length : 0),
    key: melds.map(({ key }) => key).sort().join('\u0001') };
}

/**
 * Explicit cosmetic sorting only: never observes state or saves an order.
 * Search is bounded (128 candidates × 20 beam positions × 12 rounds), followed
 * by a deterministic greedy pass. canOpen means this identified plan reaches
 * 30, not a proof that no other opening exists. Existing table jokers are never
 * consulted or rearranged: every suggested tile comes solely from this rack.
 */
export function sortPlayableRack(rack, options = {}) {
  const problem = tilesProblem(rack);
  if (problem) throw new TypeError(problem);
  const config = settings(options), indices = new Map(rack.map((tile, index) => [tile.id, index]));
  const empty = { mask: 0n, melds: [], count: 0, points: 0, jokers: 0, preferred: 0, key: '' };
  const candidates = candidatesFor(rack, config, indices).slice(0, MAX_CANDIDATES);
  let beam = [empty], best = empty;
  for (let depth = 0; depth < Math.min(BEAM_DEPTH, Math.floor(rack.length / 3)); depth += 1) {
    const unique = new Map();
    for (const plan of beam) for (const candidate of candidates) {
      if (plan.mask & candidate.mask) continue;
      const next = addMeld(plan, candidate, config), previous = unique.get(next.mask);
      if (!previous || comparePlans(next, previous, config) < 0) unique.set(next.mask, next);
    }
    if (!unique.size) break;
    beam = [...unique.values()].sort((a, b) => comparePlans(a, b, config)).slice(0, BEAM_WIDTH);
    if (comparePlans(beam[0], best, config) < 0) best = beam[0];
  }
  let remaining = rack.filter((tile) => !(best.mask & (1n << BigInt(indices.get(tile.id)))));
  // Re-enumeration lets the second/third physical copy join a new group after
  // overlap choices. Each iteration removes at least three tiles, so it stops.
  while (remaining.length >= 3) {
    const candidate = candidatesFor(remaining, config, indices)[0];
    if (!candidate) break;
    best = addMeld(best, candidate, config);
    remaining = remaining.filter((tile) => !(candidate.mask & (1n << BigInt(indices.get(tile.id)))));
  }
  const melds = [...best.melds].sort((a, b) => compareCandidates(a, b, config));
  const leftovers = [...remaining].sort((a, b) => Number(Boolean(a.joker)) - Number(Boolean(b.joker))
    || (config.mode === 'color' ? COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || a.value - b.value
      : a.value - b.value || COLORS.indexOf(a.color) - COLORS.indexOf(b.color))
    || a.id.localeCompare(b.id));
  const ordered = [...melds.flatMap(({ tiles }) => tiles), ...leftovers];
  return { rack: ordered.map(copyTile), orderIds: ordered.map(({ id }) => id),
    melds: melds.map(({ tiles, type, points }) => ({ tiles: tiles.map(copyTile), type, points })),
    points: best.points, canOpen: best.points >= 30, unmatchedIds: leftovers.map(({ id }) => id),
    searchLimited: true };
}

function validatedSplit(meld, melds, options, metadata = {}) {
  const hasContext = ['committed', 'draft', 'meldIndex'].some((key) => Object.hasOwn(options, key));
  let evaluation = null;
  if (hasContext) {
    const { committed, draft, meldIndex } = options;
    if (!committed || !draft || !Array.isArray(draft.board) || !Number.isInteger(meldIndex)
        || meldIndex < 0 || meldIndex >= draft.board.length
        || !Array.isArray(draft.board[meldIndex]) || tilesProblem(draft.board[meldIndex])
        || stableKey(draft.board[meldIndex]) !== stableKey(meld)) return null;
    const board = draft.board.flatMap((tiles, index) => index === meldIndex ? melds : [tiles]);
    try { evaluation = evaluateDraft(committed, { ...draft, board }, options); } catch { return null; }
    if (!evaluation.valid) return null;
  }
  return { melds: melds.map((tiles) => tiles.map(copyTile)), ...metadata,
    evaluation, requiresDraftValidation: !hasContext };
}

/** Respect the physical joker drop: a cosmetic normalization which moves a
 * newly inserted joker to a distant endpoint is not that requested layout.
 * Every proposed contiguous segment is still judged by the canonical rules.
 * Keep the search finite; complex mixtures remain an editable manual draft. */
function jokerInsertionSplit(meld, options, config) {
  if (meld.length > 54 || !Array.isArray(options.insertedIds) || !options.insertedIds.length
      || new Set(options.insertedIds).size !== options.insertedIds.length
      || options.insertedIds.some(id => !meld.some(tile => tile.id === id))
      || !['committed', 'draft', 'meldIndex'].every(key => Object.hasOwn(options, key))) return null;
  const inserted = new Set(options.insertedIds), jokers = meld.filter(tile => tile.joker && inserted.has(tile.id));
  if (!jokers.length) return null;
  const whole = validateMeld(meld, config), normalized = normalizeMeld(meld, config);
  if (whole.valid && jokers.every(tile => normalized.findIndex(item => item.id === tile.id)
      === meld.findIndex(item => item.id === tile.id))) return null;
  const drop = Number.isInteger(options.dropIndex) && options.dropIndex >= 0 && options.dropIndex < meld.length
    ? options.dropIndex : meld.findIndex(tile => tile.id === jokers[0].id);
  const cache = new Map();
  function segment(from, to) {
    const key = `${from}:${to}`;
    if (!cache.has(key)) {
      const tiles = meld.slice(from, to), result = validateMeld(tiles, config);
      cache.set(key, result.valid ? normalizeMeld(tiles, config) : null);
    }
    return cache.get(key);
  }
  for (let count = 2; count <= Math.min(4, Math.floor(meld.length / 3)); count += 1) {
    const plans = [];
    function visit(from, groups, cuts, displacement) {
      if (plans.length >= MAX_CANDIDATES) return;
      const remaining = count - groups.length;
      if (remaining === 1) {
        const tiles = segment(from, meld.length); if (!tiles) return;
        const all = [...groups, tiles], order = all.flat(), movement = jokers.reduce((sum, tile) =>
          sum + Math.abs(order.findIndex(item => item.id === tile.id) - meld.findIndex(item => item.id === tile.id)), 0);
        plans.push({ melds: all, cuts, movement, distance: displacement }); return;
      }
      const ends = Array.from({ length: Math.max(0, meld.length - remaining * 3 - from + 1) }, (_, index) => from + 3 + index)
        .sort((a, b) => Math.min(Math.abs(a - drop), Math.abs(a - drop - jokers.length))
          - Math.min(Math.abs(b - drop), Math.abs(b - drop - jokers.length)) || a - b);
      for (const to of ends) {
        const tiles = segment(from, to); if (!tiles) continue;
        const distance = Math.min(Math.abs(to - drop), Math.abs(to - drop - jokers.length));
        visit(to, [...groups, tiles], [...cuts, to], displacement + distance);
        if (plans.length >= MAX_CANDIDATES) break;
      }
    }
    visit(0, [], [], 0);
    plans.sort((a, b) => a.movement - b.movement || a.distance - b.distance || a.cuts.join(':').localeCompare(b.cuts.join(':')));
    for (const plan of plans) {
      const result = validatedSplit(meld, plan.melds, options, { insertedIds: [...options.insertedIds], cuts: plan.cuts });
      if (result) return result;
    }
  }
  return null;
}

/**
 * Conservative duplicate-pivot repair (e.g. 4,5,6,6,7,8 → 456 + 678), or a
 * complete legal partition near an explicitly inserted joker's drop point.
 * With committed/draft/meldIndex, the replacement must also pass evaluateDraft
 * using the complete unchanged deck/pool and original opening/joker-lock rules.
 * Without that context this is only a geometric proposal, not play permission.
 */
export function autoSplitDuplicateRun(meld, options = {}) {
  if (tilesProblem(meld) || meld.length < 6) return null;
  let config;
  try { config = settings(options); } catch { return null; }
  if (meld.some((tile) => tile.joker)) return jokerInsertionSplit(meld, options, config);
  if (!meld.every((tile) => tile.color === meld[0].color)) return null;
  const byValue = new Map();
  for (const tile of meld) {
    if (!byValue.has(tile.value)) byValue.set(tile.value, []);
    byValue.get(tile.value).push(tile);
  }
  const duplicates = [...byValue.entries()].filter(([, tiles]) => tiles.length > 1);
  if (duplicates.length !== 1 || duplicates[0][1].length !== 2) return null;
  const pivotValue = duplicates[0][0], values = [...byValue.keys()].sort((a, b) => a - b);
  if (values.some((value, index) => index && value !== values[index - 1] + 1)) return null;
  const left = values.filter((value) => value <= pivotValue).map((value) => byValue.get(value)[0]);
  const right = values.filter((value) => value >= pivotValue).map((value) => byValue.get(value)[value === pivotValue ? 1 : 0]);
  if (![left, right].every((tiles) => validateMeld(tiles, config).valid)) return null;
  const melds = [left, right].map((tiles) => normalizeMeld(tiles, config));
  return validatedSplit(meld, melds, options, { pivotValue });
}
