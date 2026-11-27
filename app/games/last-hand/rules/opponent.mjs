import { items } from './catalog.mjs';
import { bestSelection } from './poker.mjs';
import { remaining } from './effects.mjs';
import { battleRelics } from './table.mjs';

// The opponent receives exactly the public table and its own seat's private view.
function variation(v, salt = '') {
  let h = 2166136261;
  for (const ch of [v.matchId, v.epoch, v.self, salt].join('/')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
function potential(hand, p, card) {
  const e = bestSelection([...hand, card], p.relics, false, null, p.scoringVersion || 1).points;
  const near = hand.filter((c) => Math.abs(c.rank - card.rank) <= 2 && c.rank !== card.rank).length;
  const suited = hand.filter((c) => c.suit === card.suit).length;
  return e + near * 6 + suited * suited * 3 + card.rank * 0.9;
}
function forBuild(v, p) {
  const choices = [];
  const active = battleRelics(p);
  let bestBefore;
  const score = (hand, effects) =>
    bestSelection(hand, effects, p.vow, p.guard, v.scoringVersion || 1, v.scoreOnly);
  const current = () => (bestBefore ??= score(p.hand, active));
  const cards = p.hand,
    low = [...cards].sort((a, b) => a.rank - b.rank)[0],
    fav = [...cards].sort((a, b) => b.rank - a.rank)[0];
  for (const itemId of new Set([...p.relics, ...p.tools])) {
    if (remaining(p, itemId) <= 0) continue;
    const item = items[itemId],
      id = item.effect || itemId;
    const aim = (card, extra = {}) =>
      choices.push({ type: 'effect', item: itemId, card: card?.id, ...extra });
    if (item.duration === 'battle') {
      if ((id === 'life' || id === 'barrier') && p.hp <= 2) aim();
      else if (['fist', 'pick', 'glass'].includes(id)) {
        if (current().type >= 3 && (id !== 'glass' || p.hp > 1)) aim();
      } else if (score(cards, [...active, id]).points > current().points) aim();
      continue;
    }
    if (id === 'heal' && p.hp < p.maxHp) aim();
    if (id === 'adrenaline') aim();
    if (id === 'clone') {
      const other =
        ['once-makeAce', 'heal', 'needle', 'ruler', 'peek', 'insure', 'mask', 'echo'].find((x) =>
          p.tools.includes(x),
        ) || p.tools.find((x) => x !== 'clone');
      if (other) aim(null, { other });
    }
    if (
      id.startsWith('recycle') &&
      p.replacementsAvailable !== false &&
      (!p.used.recycle || p.hand.length < 8)
    ) {
      const planned = current(),
        unhelpful = cards
          .filter((c) => !planned.counted.includes(c.id) && c.id !== p.guard)
          .sort((a, b) => a.rank - b.rank);
      if (planned.type < 4 && unhelpful.length) aim(unhelpful[0]);
    }
    if (id === 'duplicate' && p.hand.length < 12) aim(fav);
    if (id === 'makeAce' && (v.scoringVersion >= 2 ? p.hand.length < 12 : low.rank !== 14))
      aim(low);
    if (id === 'lastStand' && p.hp === 1 && !p.guard) aim();
    if (id === 'echo' && !p.echo) aim();
    if (id === 'guardPin' && !p.vow && !p.guard) {
      const chosen = current().ids;
      const left = cards.find((c) => c.rank >= 8 && !chosen.includes(c.id));
      if (left) aim(left);
    }
    if (
      [
        'morph',
        'walker',
        'hunter',
        'mask',
        'tweak',
        'chameleon',
        'red',
        'black',
        'shifter',
        'needle',
        'ruler',
      ].includes(id)
    ) {
      const base = current().points;
      let bestMove = null,
        points = base;
      for (const a of cards) {
        let options = [];
        if (['morph', 'mask', 'walker', 'hunter', 'tweak'].includes(id)) {
          if (id === 'tweak') options = [a.rank - 1, a.rank + 1].filter((n) => n >= 2 && n <= 14);
          else if (
            (id === 'walker' && a.rank <= 10) ||
            (['morph', 'mask'].includes(id) && [11, 12, 13].includes(a.rank))
          )
            options = [11, 12, 13].filter((n) => n !== a.rank);
          else if (id === 'hunter' && [11, 12, 13].includes(a.rank))
            options = [2, 3, 4, 5, 6, 7, 8, 9, 10];
          options = options.map((rank) => ({ rank }));
        } else if (['red', 'black', 'shifter'].includes(id))
          options = (
            id === 'shifter' ? ['s', 'h', 'c', 'd'] : id === 'red' ? ['h', 'd'] : ['s', 'c']
          )
            .filter((s) => s !== a.suit)
            .map((suit) => ({ suit }));
        else
          options = cards
            .filter(
              (b) =>
                b.id !== a.id &&
                (id === 'chameleon'
                  ? b.suit !== a.suit
                  : id === 'needle'
                    ? b.rank === a.rank && a.rank > 2 && a.rank < 14
                    : Math.abs(a.rank - b.rank) === 1 && a.suit !== b.suit),
            )
            .map((b) => ({ second: b.id }));
        for (const edit of options) {
          const other = cards.find((c) => c.id === edit.second);
          const changed = cards.map((c) =>
            c === a
              ? {
                  ...c,
                  rank: edit.rank ?? (id === 'needle' ? a.rank + 1 : a.rank),
                  suit: edit.suit ?? (id === 'ruler' || id === 'chameleon' ? other.suit : a.suit),
                }
              : c === other && id === 'needle'
                ? { ...c, rank: c.rank - 1 }
                : c === other && id === 'ruler'
                  ? { ...c, suit: a.suit }
                  : c,
          );
          const n = score(changed, active).points;
          if (n > points) {
            points = n;
            bestMove = { type: 'effect', item: itemId, card: a.id, ...edit };
          }
        }
      }
      if (bestMove) choices.push(bestMove);
    }
  }
  return choices[0] || { type: 'submit', ids: current().ids };
}
import { botEvent } from './interactions.mjs';
export function opponent(v, { timeout = false } = {}) {
  const p = v.own,
    self = v.players.find((x) => x.id === v.self),
    rand = variation(v);
  if (v.phase === 'interact') return botEvent(v, rand);
  if (v.phase === 'growth') {
    if (v.growth.canLedger) return { type: 'ledger' };
    if (
      !timeout &&
      !v.growth.simultaneous &&
      p.tools.includes('lantern') &&
      !v.growth.personal &&
      v.growth.order.length > 1 &&
      !v.growth.passed.some((id) => v.growth.order.slice(0, 2).includes(id)) &&
      rand < 0.32
    )
      return { type: 'light' };
    const options = [...v.growth.offers, ...(v.growth.personal ? [v.growth.personal] : [])].filter(
      (id) => items[id].kind === 'tool' || !p.relics.includes(id),
    );
    const lean =
      self.style === '争牌'
        ? ['ledger', 'insure', 'tail', 'rebate', 'reserve', 'dealer']
        : self.style === '构筑'
          ? ['trinity', 'duplicate', 'recycle2', 'makeAce', 'chameleon', 'needle']
          : ['life', 'bucket', 'charm', 'fist', 'guardPin', 'heal'];
    const sorted = options
      .map((id) => ({
        id,
        v: items[id].tier * 0.18 + variation(v, id) + (lean.includes(id) ? 0.85 : 0),
      }))
      .sort((a, b) => b.v - a.v);
    return { type: 'pick', item: sorted[0]?.id ?? null };
  }
  if (v.phase === 'auction') {
    const lots = v.market
      .map((c) => ({ c, score: potential(p.hand, p, c) + variation(v, c.id) * 16 }))
      .sort((a, b) => b.score - a.score);
    const card = lots[0].c.id,
      need = lots.length > 1 ? lots[0].score - lots[1].score : 0,
      total = p.silver + p.bank;
    if (rand < 0.14 && p.silver >= 2)
      return { type: 'seal', kind: 'blind', item: p.tools.includes('peek') ? 'peek' : null };
    if (rand < (self.style === '稳健' ? 0.36 : 0.21) || (!total && !p.gold))
      return {
        type: 'seal',
        kind: 'pass',
        card,
        item: p.tools.includes('reserve') ? 'reserve' : null,
      };
    const gold = p.gold > 0 && ((need > 70 && rand > 0.5) || total === 0) ? 1 : 0;
    const silver = Math.min(
      total,
      Math.max(
        gold ? 0 : 1,
        Math.round(
          (total / (7 - v.batch)) * (self.style === '争牌' ? 1.45 : 0.85) * (0.4 + rand) +
            Math.min(need, 60) / 18,
        ),
      ),
    );
    return {
      type: 'seal',
      kind: 'bid',
      card,
      silver,
      gold,
      item:
        gold && p.tools.includes('insure')
          ? 'insure'
          : !gold && p.tools.includes('tail')
            ? 'tail'
            : null,
    };
  }
  if (v.phase === 'peek') {
    const choices = [...p.peek].sort((a, b) => potential(p.hand, p, b) - potential(p.hand, p, a));
    return { type: 'peek', card: choices[0].id };
  }
  if (v.phase === 'build')
    return timeout
      ? {
          type: 'submit',
          ids: bestSelection(p.hand, battleRelics(p), p.vow, p.guard, v.scoringVersion || 1, v.scoreOnly).ids,
        }
      : forBuild(v, p);
  if (v.phase === 'attack') {
    const t = v.players
      .filter((x) => v.targets.includes(x.id))
      .sort((a, b) =>
        v.settings.mode === 'survival'
          ? a.hp - b.hp || b.score - a.score
          : b.score - a.score || a.hp - b.hp,
      );
    return { type: 'attack', target: t[0].id };
  }
  throw new Error('当前阶段无需电脑操作');
}
