import {
  active,
  shuffle,
  phase,
  draw,
  has,
  person,
  takeTool,
  random,
  demand,
  note,
} from './table.mjs';
import { cardName } from './catalog.mjs';
export function openAuction(g, now) {
  g.batch++;
  g.market = active(g).map(() => draw(g));
  g.award = null;
  for (const p of active(g)) {
    p.pending = null;
    p.two = null;
    p.autoPass = false;
  }
  phase(g, 'auction', now);
}
export function seal(g, p, m) {
  demand(!p.pending, '已经封标');
  const kind = m.kind;
  demand(['bid', 'pass', 'blind'].includes(kind), '请选择拿牌方式');
  const silver = m.silver ?? 0,
    gold = m.gold ?? 0;
  demand(
    [silver, gold].every((n) => Number.isSafeInteger(n) && n >= 0),
    '筹码数无效',
  );
  demand(kind === 'bid' || silver + gold === 0, '过牌或盲抽不能附带出价');
  if (kind === 'bid') {
    demand(
      g.market.some((c) => c.id === m.card),
      '请选择一张明牌',
    );
    demand(
      silver + gold > 0 && silver <= p.silver + p.bank && gold <= p.gold,
      '筹码不足或出价为零',
    );
  }
  if (kind === 'blind') demand(p.silver >= 2, '盲抽需要 2 银');
  if (m.item) {
    demand(p.tools.includes(m.item), '没有这件道具');
    const allowed =
      (m.item === 'tail' && kind === 'bid' && gold === 0) ||
      (m.item === 'insure' && kind === 'bid' && gold > 0) ||
      (m.item === 'reserve' && kind === 'pass' && g.market.some((c) => c.id === m.card)) ||
      (m.item === 'peek' && kind === 'blind');
    demand(allowed, '道具与拿牌方式不符');
  }
  p.pending = {
    kind,
    card: kind === 'bid' || m.item === 'reserve' ? m.card : null,
    silver,
    gold,
    item: m.item || null,
  };
  g.ready.push(p.id);
}
function highest(g, ranked, rolls) {
  let tied = ranked;
  const sides = g.scoringVersion >= 2 ? 20 : 6;
  while (tied.length > 1) {
    const dice = tied.map((p) => ({ id: p.id, die: 1 + Math.floor(random(g) * sides) }));
    rolls.push(dice);
    const high = Math.max(...dice.map((d) => d.die));
    tied = tied.filter((p, i) => dice[i].die === high);
  }
  return tied[0];
}
export function resolveAuction(g, now) {
  const ps = active(g),
    remaining = [...g.market],
    held = new Map(),
    won = new Set(),
    lots = [],
    rewards = [];
  const entries = ps.map((p) => ({ id: p.id, ...p.pending }));
  for (const p of ps) {
    const m = p.pending;
    if (m.item) takeTool(p, m.item);
    if (m.kind === 'bid') {
      p.gold -= m.gold;
      const bankSpent = Math.min(p.bank, m.silver);
      p.bank -= bankSpent;
      p.silver -= m.silver - bankSpent;
    }
    if (m.kind === 'blind') p.silver -= 2;
    p.silver += p.bank;
    p.bank = 0;
  }
  for (const c of g.market) {
    const bids = ps
      .filter((p) => p.pending.kind === 'bid' && p.pending.card === c.id)
      .sort((a, b) => b.pending.gold - a.pending.gold || b.pending.silver - a.pending.silver);
    if (!bids.length) continue;
    const first = bids[0].pending,
      tied = bids.filter((p) => p.pending.gold === first.gold && p.pending.silver === first.silver),
      rolls = [];
    const winner = highest(g, tied, rolls);
    held.set(winner.id, c);
    won.add(winner.id);
    remaining.splice(remaining.indexOf(c), 1);
    if (bids.length > 1) winner.flags.bid = true;
    if (rolls.length) winner.flags.tiebreak = true;
    if (
      first.gold === 0 &&
      first.silver === 1 &&
      bids.length === 1 &&
      has(winner, 'ledger') &&
      !winner.used.ledger
    ) {
      winner.ledger = true;
      winner.used.ledger = 1;
      rewards.push({ id: winner.id, text: '偏门账本 · 私人选物' });
    }
    for (const p of bids.filter((x) => x !== winner)) {
      if (
        p.pending.item === 'tail' &&
        tied.length === 1 &&
        first.gold === 0 &&
        p.pending.silver + 1 === first.silver
      ) {
        const value = Math.min(2, p.pending.silver);
        p.silver += value;
        rewards.push({ id: p.id, text: '尾标券 +' + value + ' 银' });
      }
      if (p.pending.item === 'insure') {
        p.silver += 3;
        rewards.push({ id: p.id, text: '赌注保险 +3 银' });
      }
    }
    lots.push({ card: c.id, winner: winner.id, rolls });
  }
  // Resolve competing reservations without exposing any sealed intent before every seat has acted.
  for (const p of shuffle(
    g,
    ps.filter((p) => p.pending.item === 'reserve'),
  )) {
    const i = remaining.findIndex((c) => c.id === p.pending.card);
    if (i >= 0) {
      const c = remaining.splice(i, 1)[0];
      held.set(p.id, c);
      p.reserved.push(c.id);
      rewards.push({ id: p.id, text: '留座成功' });
    }
  }
  const randomLeft = shuffle(g, remaining);
  for (const p of shuffle(
    g,
    ps.filter((p) => p.pending.kind !== 'blind' && !held.has(p.id)),
  ))
    held.set(p.id, randomLeft.pop());
  g.discard.push(...randomLeft);
  for (const p of ps) {
    const m = p.pending;
    if (m.kind === 'blind' && m.item === 'peek') {
      const first = draw(g),
        needed = ps.slice(ps.indexOf(p) + 1).filter((q) => q.pending.kind === 'blind').length;
      if (g.deck.length + g.discard.filter((c) => !c.copy).length > needed)
        p.two = [first, draw(g)];
      else p.hand.push(first);
      continue;
    }
    const c = held.get(p.id) || draw(g);
    p.hand.push(c);
    if (
      m.kind === 'pass' &&
      !p.autoPass &&
      has(p, 'escrow') &&
      !p.used.escrow &&
      p.silver >= 2 &&
      g.batch < 4
    ) {
      p.bank = 2;
      p.silver -= 2;
      p.used.escrow = 1;
      rewards.push({ id: p.id, text: '压住 2 银供下批使用' });
    }
  }
  const received = ps.map((p) => ({
    id: p.id,
    card: p.pending.kind === 'blind' ? null : held.get(p.id)?.id,
    blind: p.pending.kind === 'blind',
  }));
  g.award = { batch: g.batch, entries, lots, rewards, received, market: [...g.market] };
  g.lastAward = g.award;
  for (const x of lots) {
    const c = g.market.find((c) => c.id === x.card);
    note(
      g,
      person(g, x.winner).name +
        ' 竞得 ' +
        cardName(c) +
        (x.rolls.length
          ? ' · 掷骰 ' +
            x.rolls
              .at(-1)
              .map((d) => d.die)
              .join('/')
          : ''),
    );
  }
  for (const e of rewards) note(g, person(g, e.id).name + ' · ' + e.text);
  for (const p of ps) p.pending = null;
  phase(g, ps.some((p) => p.two) ? 'peek' : 'award', now);
}
export function pickPeek(g, p, m, now) {
  demand(
    p.two?.some((c) => c.id === m.card),
    '请选择这次摸到的一张牌',
  );
  const c = p.two.find((c) => c.id === m.card);
  p.hand.push(c);
  g.discard.push(...p.two.filter((x) => x !== c));
  p.two = null;
  g.ready.push(p.id);
  if (!active(g).some((p) => p.two)) phase(g, 'award', now);
}
