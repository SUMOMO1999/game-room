/** Browser-safe, bounded special-joker semantics for the versioned friends-v3 / friends-v4 rules. */
export const JOKER_TYPES = Object.freeze(['normal', 'mirror', 'color-change', 'double']);
export const JOKER_CONFIG_KEYS = Object.freeze(['normal', 'mirror', 'colorChange', 'double']);
const TYPE_KEYS = Object.freeze({ normal: 'normal', mirror: 'mirror', 'color-change': 'colorChange', double: 'double' });
const COLORS = ['red', 'blue', 'black', 'orange'];
export const JOKER_LIMITS = Object.freeze({ perType: 8, total: 24, mirrorsPerMeld: 1 });

export function normalizeJokerConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Reflect.ownKeys(value).length !== JOKER_CONFIG_KEYS.length
      || JOKER_CONFIG_KEYS.some((key) => !Object.hasOwn(value, key)
        || !Number.isInteger(value[key]) || value[key] < 0 || value[key] > JOKER_LIMITS.perType)) {
    throw new TypeError('四种鬼牌都需要0至8张的整数设置。');
  }
  const result = Object.fromEntries(JOKER_CONFIG_KEYS.map((key) => [key, value[key]]));
  if (Object.values(result).reduce((sum, count) => sum + count, 0) > JOKER_LIMITS.total) {
    throw new TypeError('鬼牌总数最多24张。');
  }
  return result;
}

export function defaultJokerConfig(copies = 2) {
  if (![2, 3].includes(copies)) throw new TypeError('数字牌需要两副或三副。');
  return { normal: copies, mirror: 0, colorChange: 0, double: 0 };
}
export function jokerCountOf(config) {
  return Object.values(normalizeJokerConfig(config)).reduce((sum, count) => sum + count, 0);
}
export function configuredJokers(config) {
  const normalized = normalizeJokerConfig(config);
  return JOKER_TYPES.flatMap((jokerType) => Array.from({ length: normalized[TYPE_KEYS[jokerType]] }, (_, index) =>
    ({ id: `joker-${jokerType}-${index + 1}`, color: 'red', value: 1, joker: true, jokerType })));
}

const kindOf = (tile) => tile.joker ? tile.jokerType ?? 'normal' : 'number';
const bad = (reason) => ({ valid: false, type: null, points: 0, reason, values: new Map() });
function good(type, tiles, values) {
  return { valid: true, type, points: [...values.values()].reduce((sum, value) => sum + value, 0),
    reason: '', values, ordered: [...tiles] };
}
const stable = (tiles) => [...tiles].sort((a, b) => a.id.localeCompare(b.id));

function ordinaryGroup(tiles) {
  if (tiles.some((tile) => kindOf(tile) === 'color-change')) return null;
  const regular = tiles.filter((tile) => !tile.joker), value = regular[0]?.value;
  if (!regular.length || regular.some((tile) => tile.value !== value)
      || new Set(regular.map((tile) => tile.color)).size !== regular.length) return null;
  const span = tiles.reduce((sum, tile) => sum + (kindOf(tile) === 'double' ? 2 : 1), 0);
  if (span > 4) return null;
  return good('group', tiles, new Map(tiles.map((tile) => [tile.id, value * (kindOf(tile) === 'double' ? 2 : 1)])));
}

/** Counts, not physical-joker permutations: at most 13 number slots × four colours. */
function ordinaryRun(tiles) {
  const regular = tiles.filter((tile) => !tile.joker);
  const byNumber = new Map(regular.map((tile) => [tile.value, tile]));
  if (byNumber.size !== regular.length || !regular.length) return null;
  const ghosts = Object.fromEntries(['normal', 'color-change', 'double'].map((kind) =>
    [kind, stable(tiles.filter((tile) => kindOf(tile) === kind))]));
  const span = tiles.length + ghosts.double.length;
  if (span > 13) return null;
  for (let start = 14 - span; start >= 1; start -= 1) {
    if (regular.some((tile) => tile.value < start || tile.value >= start + span)) continue;
    const memo = new Map();
    function solve(offset, n, c, d, color) {
      if (offset === span) return n === ghosts.normal.length && c === ghosts['color-change'].length && d === ghosts.double.length ? [] : null;
      const key = `${offset}:${n}:${c}:${d}:${color}`;
      if (memo.has(key)) return memo.get(key);
      const value = start + offset, actual = byNumber.get(value);
      let answer = null;
      if (actual) {
        if (actual.color === color) {
          const tail = solve(offset + 1, n, c, d, color);
          if (tail) answer = [{ tile: actual, points: value }, ...tail];
        }
      } else {
        if (n < ghosts.normal.length) {
          const tail = solve(offset + 1, n + 1, c, d, color);
          if (tail) answer = [{ tile: ghosts.normal[n], points: value }, ...tail];
        }
        if (!answer && d < ghosts.double.length && offset + 1 < span && !byNumber.has(value + 1)) {
          const tail = solve(offset + 2, n, c, d + 1, color);
          if (tail) answer = [{ tile: ghosts.double[d], points: value * 2 + 1 }, ...tail];
        }
        if (!answer && c < ghosts['color-change'].length) {
          for (const after of COLORS) if (after !== color) {
            const tail = solve(offset + 1, n, c + 1, d, after);
            if (tail) { answer = [{ tile: ghosts['color-change'][c], points: value }, ...tail]; break; }
          }
        }
      }
      memo.set(key, answer); return answer;
    }
    for (const color of COLORS) {
      const result = solve(0, 0, 0, 0, color);
      if (result) return good('run', result.map(({ tile }) => tile), new Map(result.map(({ tile, points }) => [tile.id, points])));
    }
  }
  return null;
}

function slotsFor(tiles) {
  return tiles.flatMap((tile) => Array.from({ length: kindOf(tile) === 'double' ? 2 : 1 },
    (_, part) => ({ tile, kind: kindOf(tile), part })));
}
function mirrorGroup(tiles, mirror, left, right, numericMirror) {
  const a = slotsFor(left), b = slotsFor(right);
  if (!a.length || a.length !== b.length || a.length > 4
      || [...a, ...b].some(({ kind }) => kind === 'color-change')) return null;
  const regular = tiles.filter((tile) => !tile.joker), value = regular[0]?.value;
  if (!regular.length || regular.some((tile) => tile.value !== value)) return null;
  let masks = new Set([0]);
  for (let index = 0; index < a.length; index += 1) {
    const next = new Set();
    for (const mask of masks) for (let color = 0; color < COLORS.length; color += 1) {
      if (mask & (1 << color) || [a[index], b[index]].some(({ tile, kind }) => kind === 'number' && tile.color !== COLORS[color])) continue;
      next.add(mask | (1 << color));
    }
    if (!next.size) return null;
    masks = next;
  }
  return good('group', tiles, new Map(tiles.map((tile) => [tile.id, tile.id === mirror.id ? (numericMirror ? value : 0) : value * (kindOf(tile) === 'double' ? 2 : 1)])));
}

/** Reflection keeps the mirror's physical centre and compares expanded number/color slots. */
function mirrorRun(tiles, mirror, left, right, numericMirror) {
  const a = slotsFor(left), b = slotsFor(right);
  if (!a.length || a.length !== b.length || a.length > 13) return null;
  const span = a.length;
  const solutions = [];
  for (const direction of [1, -1]) {
    for (let start = direction === 1 ? 14 - span : 13; start >= (direction === 1 ? 1 : span); start -= 1) {
      if ([a, b].some((side) => side.some(({ tile, kind }, index) => kind === 'number' && tile.value !== start + direction * index))) continue;
      let states = new Set(COLORS.flatMap((color) => COLORS.map((other) => `${color}:${other}`)));
      for (let index = 0; index < span && states.size; index += 1) {
        const next = new Set(), first = a[index], second = b[index];
        for (const state of states) {
          const [leftColor, rightColor] = state.split(':');
          if (first.kind === 'number' && first.tile.color !== leftColor || second.kind === 'number' && second.tile.color !== rightColor
              || first.kind !== 'color-change' && second.kind !== 'color-change' && leftColor !== rightColor) continue;
          const followingLeft = first.kind === 'color-change' ? COLORS.filter((color) => color !== leftColor) : [leftColor];
          const followingRight = second.kind === 'color-change' ? COLORS.filter((color) => color !== rightColor) : [rightColor];
          for (const l of followingLeft) for (const r of followingRight) next.add(`${l}:${r}`);
        }
        states = next;
      }
      if (!states.size) continue;
      // Count the single virtual slot nearest the axis, never a neighbouring double tile's summed value.
      const axisValue = start + direction * (span - 1);
      const values = new Map([[mirror.id, numericMirror ? axisValue : 0]]);
      for (const side of [a, b]) side.forEach(({ tile }, index) => values.set(tile.id, (values.get(tile.id) ?? 0) + start + direction * index));
      // v4 retains the physical axis so normalization cannot change its represented value.
      const ordered = numericMirror || direction === 1 ? tiles : [...left.toReversed(), mirror, ...right];
      solutions.push(good('run', ordered, values));
      break;
    }
  }
  return solutions.sort((first, second) => second.points - first.points)[0] ?? null;
}

export function analyzeTwistMeld(tiles, { ruleVersion } = {}) {
  const numericMirror = ruleVersion === 'friends-v4';
  const mirrors = tiles.filter((tile) => kindOf(tile) === 'mirror');
  if (mirrors.length > 1) return bad('每组最多使用一张镜像鬼牌。');
  let candidates;
  if (mirrors.length) {
    const mirror = mirrors[0], index = tiles.findIndex(({ id }) => id === mirror.id);
    const left = tiles.slice(0, index), right = tiles.slice(index + 1).toReversed();
    if (!left.length || !right.length) return bad('镜像鬼牌两边都需要对应的牌。');
    candidates = [mirrorGroup(tiles, mirror, left, right, numericMirror), mirrorRun(tiles, mirror, left, right, numericMirror)];
  } else candidates = [ordinaryGroup(tiles), ordinaryRun(tiles)];
  const valid = candidates.filter(Boolean).sort((a, b) => b.points - a.points);
  return valid[0] ?? bad('特殊鬼牌组合需符合双重两格、变色边界或镜像两侧对应规则。');
}
