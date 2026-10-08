/** Pure two-deck 414 card patterns. Never reads another player's hand. */
import { getCard } from './cards.mjs';

const SUIT_ORDER = ['spades', 'hearts', 'clubs', 'diamonds', 'joker'];
const KINDS = ['single', 'pair', 'pair-small-jokers', 'pair-large-jokers',
  'straight', 'pair-straight', 'bomb', 'mixed-joker-bomb', 'rocket'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export function cardsProblem(cardIds, maximum = 36) {
  if (!Array.isArray(cardIds) || Object.getPrototypeOf(cardIds) !== Array.prototype || cardIds.length > maximum
      || Reflect.ownKeys(cardIds).length !== cardIds.length + 1
      || !Array.from({ length: cardIds.length }, (_, index) => index).every(index => Object.hasOwn(cardIds, index)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(cardIds, index), 'value'))) return '牌实体列表无效或重复。';
  if (new Set(cardIds).size !== cardIds.length) return '牌实体列表无效或重复。';
  for (const id of cardIds) {
    if (typeof id !== 'string') return '牌实体编号无效。';
    try { getCard(id); } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return '牌实体不存在。';
    }
  }
  return null;
}

export function compareCardIds(left, right) {
  const a = getCard(left), b = getCard(right);
  return a.rank - b.rank || SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit)
    || a.copyId - b.copyId;
}

function descriptor(kind, count, rank, rocketTier = 0) { return { kind, count, rank, rocketTier }; }

export function patternProblem(pattern) {
  if (!plain(pattern) || Reflect.ownKeys(pattern).length !== 4
      || !['kind', 'count', 'rank', 'rocketTier'].every(key => Object.hasOwn(pattern, key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(pattern, key), 'value'))
      || !KINDS.includes(pattern.kind) || !integer(pattern.count, 1, 24)
      || !integer(pattern.rank, 3, 17) || !integer(pattern.rocketTier, 0, 3)) return '牌型无效。';
  const { kind, count, rank, rocketTier } = pattern;
  if (kind === 'rocket') return count === 3 && rank === 4 && rocketTier >= 1 ? null : '火箭等级无效。';
  if (rocketTier !== 0) return '非火箭不能有花色等级。';
  if (kind === 'single') return count === 1 ? null : '单牌张数无效。';
  if (kind === 'pair') return count === 2 && rank <= 15 ? null : '对牌无效。';
  if (kind === 'pair-small-jokers') return count === 2 && rank === 16 ? null : '小王对无效。';
  if (kind === 'pair-large-jokers') return count === 2 && rank === 17 ? null : '大王对无效。';
  if (kind === 'mixed-joker-bomb') return count === 2 && rank === 17 ? null : '王炸无效。';
  if (kind === 'bomb') return count >= 3 && count <= 8 && rank <= 15 ? null : '炸弹无效。';
  const length = kind === 'pair-straight' ? count / 2 : count;
  return integer(length, 3, 12) && rank + length - 1 <= 14 ? null : '连续牌型无效。';
}

/** Invalid card entities or undefined card forms are not legal patterns. */
export function classifyPattern(cardIds) {
  if (cardsProblem(cardIds, 24) || cardIds.length === 0) return null;
  const cards = cardIds.map(getCard), count = cards.length;
  const ranks = new Map();
  for (const card of cards) ranks.set(card.rank, (ranks.get(card.rank) || 0) + 1);
  const ascending = [...ranks.keys()].sort((a, b) => a - b), rank = ascending[0];
  if (count === 1) return descriptor('single', 1, rank);
  if (count === 2 && ranks.size === 1) return descriptor(rank === 16 ? 'pair-small-jokers'
    : rank === 17 ? 'pair-large-jokers' : 'pair', 2, rank);
  if (count === 2 && ranks.has(16) && ranks.has(17)) return descriptor('mixed-joker-bomb', 2, 17);
  if (count === 3 && ranks.get(4) === 2 && ranks.get(14) === 1) {
    const pure = cards.every(card => card.suit === cards[0].suit);
    return descriptor('rocket', 3, 4, !pure ? 1 : cards[0].suit === 'hearts' ? 3 : 2);
  }
  if (ranks.size === 1 && rank <= 15 && count >= 3 && count <= 8) return descriptor('bomb', count, rank);
  if (ascending.length >= 3 && ascending.at(-1) <= 14
      && ascending.every((value, index) => value === rank + index)) {
    if ([...ranks.values()].every(value => value === 1)) return descriptor('straight', count, rank);
    if ([...ranks.values()].every(value => value === 2)) return descriptor('pair-straight', count, rank);
  }
  return null;
}

const specialStrength = pattern => pattern.kind === 'rocket' ? 3 : pattern.kind === 'mixed-joker-bomb'
  ? 2 : pattern.kind === 'bomb' ? 1 : 0;
const comparisonKind = pattern => pattern.kind.startsWith('pair-') && pattern.kind !== 'pair-straight'
  ? 'pair' : pattern.kind;

export function beatsPattern(candidate, target) {
  if (patternProblem(candidate) || (target !== null && patternProblem(target))) return false;
  if (target === null) return true;
  const a = specialStrength(candidate), b = specialStrength(target);
  if (a !== b) return a > b;
  if (a === 3) return candidate.rocketTier > target.rocketTier;
  if (a === 2) return false;
  if (a === 1) return candidate.count > target.count
    || (candidate.count === target.count && candidate.rank > target.rank);
  return comparisonKind(candidate) === comparisonKind(target) && candidate.count === target.count
    && candidate.rank > target.rank;
}

export function patternKey(pattern) {
  if (patternProblem(pattern)) throw new TypeError('牌型无效。');
  return `${pattern.kind}:${pattern.count}:${pattern.rank}:${pattern.rocketTier}`;
}

/**
 * One stable physical choice per rank/count/rocket grade. At most 3–A intervals,
 * rank counts and 28 four-pairs × 8 aces; never a 2^hand-size subset search.
 */
export function enumerateLegalPlays(handIds, target = null) {
  const problem = cardsProblem(handIds);
  if (problem || (target !== null && patternProblem(target))) throw new TypeError(problem || '目标牌型无效。');
  const sorted = [...handIds].sort(compareCardIds), ranks = new Map();
  for (const id of sorted) {
    const rank = getCard(id).rank;
    if (!ranks.has(rank)) ranks.set(rank, []);
    ranks.get(rank).push(id);
  }
  const choices = new Map();
  function add(cardIds) {
    const pattern = classifyPattern(cardIds);
    if (pattern && beatsPattern(pattern, target) && !choices.has(patternKey(pattern))) {
      choices.set(patternKey(pattern), { cardIds: [...cardIds], pattern });
    }
  }
  for (const [rank, ids] of ranks) {
    add(ids.slice(0, 1));
    if (ids.length >= 2) add(ids.slice(0, 2));
    if (rank <= 15) for (let count = 3; count <= ids.length; count += 1) add(ids.slice(0, count));
  }
  if (ranks.has(16) && ranks.has(17)) add([ranks.get(16)[0], ranks.get(17)[0]]);
  for (const multiplicity of [1, 2]) {
    for (let start = 3; start <= 12; start += 1) {
      const ids = [];
      for (let end = start; end <= 14 && (ranks.get(end)?.length || 0) >= multiplicity; end += 1) {
        ids.push(...ranks.get(end).slice(0, multiplicity));
        if (end - start >= 2) add(ids);
      }
    }
  }
  const fours = ranks.get(4) || [], aces = ranks.get(14) || [];
  for (let first = 0; first < fours.length; first += 1) {
    for (let second = first + 1; second < fours.length; second += 1) {
      for (const ace of aces) add([fours[first], fours[second], ace]);
    }
  }
  return [...choices.values()];
}

export function chooseResponseCards(handIds, rank, action) {
  const problem = cardsProblem(handIds);
  if (problem || !integer(rank, 3, 15) || !['hook', 'fork'].includes(action)) {
    throw new TypeError(problem || '勾叉条件无效。');
  }
  const amount = action === 'hook' ? 1 : 2;
  const matches = handIds.filter(id => getCard(id).rank === rank).sort(compareCardIds);
  return matches.length < amount ? null : matches.slice(0, amount);
}

export function remainingPenalty(handIds) {
  const problem = cardsProblem(handIds);
  if (problem) throw new TypeError(problem);
  const counts = new Map();
  for (const id of handIds) counts.set(getCard(id).rank, (counts.get(getCard(id).rank) || 0) + 1);
  const rockets = Math.min(Math.floor((counts.get(4) || 0) / 2), counts.get(14) || 0);
  const jokerBombs = Math.min(counts.get(16) || 0, counts.get(17) || 0);
  return { points: 10 * rockets + 5 * jokerBombs + handIds.length - 3 * rockets - 2 * jokerBombs,
    rockets, jokerBombs };
}
