import { damageByHand, handTypes, handScores, scoringVersion } from './catalog.mjs';

export function combinations(values, count) {
  const result = [];
  function visit(start, prefix) {
    if (prefix.length === count) {
      result.push(prefix);
      return;
    }
    for (let i = start; i <= values.length - count + prefix.length; i++)
      visit(i + 1, [...prefix, values[i]]);
  }
  visit(0, []);
  return result;
}
export function compareKey(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta) return delta;
  }
  return 0;
}
function straight(cards, allowed) {
  const n = cards.length,
    ranks = [...new Set(cards.map((c) => c.rank))];
  if (ranks.length !== n) return 0;
  const span = n - 1 + (allowed.has('gap') ? 1 : 0);
  const sequences = [ranks, ranks.map((v) => (v === 14 ? 1 : v))];
  if (allowed.has('loop'))
    for (let cut = 3; cut <= 14; cut++) sequences.push(ranks.map((v) => (v < cut ? v + 13 : v)));
  let best = 0;
  for (const seq of sequences) {
    const hi = Math.max(...seq);
    if (hi - Math.min(...seq) <= span) best = Math.max(best, hi > 14 ? hi - 13 : hi);
  }
  return best;
}
export function evaluate(cards, owned = [], vow = false, version = scoringVersion) {
  const set = new Set(owned),
    best = { type: 0, key: [], counted: [], points: 0, damage: 0, label: '尚未组牌', lines: [] };
  if (!cards.length) return best;
  const ranks = new Map();
  for (const c of cards) {
    if (!ranks.has(c.rank)) ranks.set(c.rank, []);
    ranks.get(c.rank).push(c);
  }
  const groups = [...ranks.values()].sort((a, b) => b.length - a.length || b[0].rank - a[0].rank);
  function candidate(type, used, key) {
    const usedIds = new Set(used.map((c) => c.id));
    key = [
      ...key,
      ...cards
        .filter((c) => !usedIds.has(c.id))
        .map((c) => c.rank)
        .sort((a, b) => b - a),
    ];
    const scale =
      type === 2 && set.has('mirror') ? 5 : type === 4 && set.has('straightBoost') ? 8 : type;
    let sum = 0,
      plain = 0;
    for (const c of used) {
      let p = c.rank;
      plain += p;
      if (c.rank === 14 && set.has('ace')) p *= 6;
      if (c.rank <= 10 && c.rank % 2 === 0 && set.has('even')) p *= 4;
      if ([3, 5, 7, 9].includes(c.rank) && set.has('odd')) p *= 5;
      if (c.rank >= 11 && c.rank <= 13 && set.has('royal')) p *= 4;
      if (cards.every((v) => v.rank <= 10) && set.has('underdog')) p *= 3;
      sum += p;
    }
    const [base, multiplier] = version >= 2 ? handScores[scale] : [(scale + 1) * 100, 1];
    let points = base + sum;
    const lines = [
      ['牌型底分', base],
      ['计分牌点数', plain],
    ];
    if (sum !== plain) lines.push(['单牌增益', sum - plain]);
    if (multiplier > 1) {
      lines.push(['牌型倍率 ×' + multiplier, points * (multiplier - 1)]);
      points *= multiplier;
    }
    if (vow) {
      const v = Math.floor(points / 4);
      points += v;
      lines.push(['背水徽', v]);
    }
    if (set.has('prism') && new Set(used.map((c) => c.suit)).size === 4) {
      lines.push(['四色棱镜', points]);
      points *= 2;
    }
    if (set.has('bucket')) {
      points += 500;
      lines.push(['计分桶', 500]);
    }
    if (set.has('scoreBoost')) {
      const bonus = Math.floor(points / 2);
      lines.push(['分数增幅 ×1.5', bonus]);
      points += bonus;
    }
    // Identify the actual poker hand first. Score modifiers cannot turn high card into a flush.
    if (
      !best.counted.length ||
      type > best.type ||
      (type === best.type &&
        (points > best.points || (points === best.points && compareKey(key, best.key) > 0)))
    ) {
      Object.assign(best, {
        type,
        key,
        counted: used.map((c) => c.id),
        points,
        damage: damageByHand[type],
        label: handTypes[type],
        lines,
      });
    }
  }
  const byRank = [...cards].sort((a, b) => b.rank - a.rank);
  candidate(0, [byRank[0]], [byRank[0].rank]);
  for (const group of groups) {
    const k = group[0].rank;
    if (group.length >= 2) candidate(1, group.slice(0, 2), [k]);
    if (group.length >= 3) candidate(3, group.slice(0, 3), [k]);
    if (group.length >= 4) candidate(7, group.slice(0, 4), [k]);
    if (group.length >= 5) candidate(10, group.slice(0, 5), [k]);
  }
  for (const [a, b] of combinations(
    groups.filter((g) => g.length >= 2),
    2,
  )) {
    candidate(
      2,
      [...a.slice(0, 2), ...b.slice(0, 2)],
      [a[0].rank, b[0].rank].sort((x, y) => y - x),
    );
    if (a.length >= 3) candidate(6, [...a.slice(0, 3), ...b.slice(0, 2)], [a[0].rank, b[0].rank]);
    if (b.length >= 3) candidate(6, [...b.slice(0, 3), ...a.slice(0, 2)], [b[0].rank, a[0].rank]);
  }
  function flushKey(c) {
    if (set.has('darkFusion') && ['s', 'c'].includes(c.suit)) return 'black';
    if (set.has('redFusion') && ['d', 'h'].includes(c.suit)) return 'red';
    return c.suit;
  }
  for (const len of set.has('trinity') ? [5, 3] : [5]) {
    for (const group of combinations(cards, len)) {
      const flush = group.every((c) => flushKey(c) === flushKey(group[0]));
      const high = straight(group, set);
      const highCards = group.map((c) => c.rank).sort((a, b) => b - a);
      if (len === 5 && flush) candidate(5, group, highCards);
      if (high)
        candidate(
          flush ? (len === 5 && highCards.join(',') === '14,13,12,11,10' ? 9 : 8) : 4,
          group,
          [high],
        );
    }
  }
  return best;
}
export function bestSelection(
  hand,
  items = [],
  vow = false,
  guard = null,
  version = scoringVersion,
  scoreOnly = false,
) {
  const possible = hand.filter((c) => c.id !== guard);
  let top = null;
  for (let n = 1; n <= Math.min(5, possible.length); n++) {
    for (const group of combinations(possible, n)) {
      const e = evaluate(group, items, vow, version),
        ids = group.map((c) => c.id);
      const priority = [e.points];
      if (!scoreOnly) {
        const def = blockValue(hand.filter((c) => !ids.includes(c.id)), guard, vow);
        priority.push(def.pair + def.pin);
      }
      priority.push(e.type, ...e.key);
      if (!top || compareKey(priority, top.priority) > 0) top = { ...e, ids, priority };
    }
  }
  return top || { ...evaluate([]), ids: [] };
}
export function blockValue(backup, guard, vow) {
  if (vow) return { pair: 0, pin: 0 };
  const other = backup.filter((c) => c.id !== guard);
  return {
    pair: Number(new Set(other.map((c) => c.rank)).size < other.length),
    pin: Number(backup.some((c) => c.id === guard && c.rank >= 8)),
  };
}
