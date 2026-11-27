import { items, activeAims, worksInPointsMatch } from './catalog.mjs';
import { demand, draw, takeTool, has, battleRelics } from './table.mjs';

const recycle = { recycle1: 2, recycle2: 3, recycle3: 4 };
export function remaining(p, id) {
  if (id === 'adrenaline' && p.adrenaline) return 0;
  if (items[id]?.duration === 'battle' && battleRelics(p).includes(items[id].effect)) return 0;
  if (items[id]?.kind === 'tool') return p.tools.filter((x) => x === id).length;
  if (!has(p, id)) return 0;
  if (recycle[id]) return Math.max(0, recycle[id] - (p.used.recycle || 0));
  return Math.max(0, 1 - (p.used[id] || 0));
}
export function useEffect(g, p, m) {
  const item = Object.hasOwn(items, m.item) && items[m.item];
  demand(item && activeAims.has(item.aim) && remaining(p, item.id) > 0, '这个能力目前不能使用');
  demand(!g.scoreOnly || worksInPointsMatch(item), '这件物品用于生存赛');
  demand(!p.choice, '这手牌已经提交');
  const id = item.effect || item.id;
  if (item.duration === 'battle') {
    (p.boosts ??= []).push(id);
    takeTool(p, item.id);
    return;
  }
  const a = p.hand.find((c) => c.id === m.card),
    b = p.hand.find((c) => c.id === m.second);
  const rank = m.rank,
    suit = m.suit;
  if (!['self', 'tool', 'vow'].includes(item.aim)) demand(a, '请选择自己的手牌');
  switch (id) {
    case 'recycle1':
    case 'recycle2':
    case 'recycle3': {
      const i = p.hand.indexOf(a);
      const fresh = draw(g);
      g.recycled ??= [];
      g.recycled.push(a);
      p.hand[i] = fresh;
      if (a.id === p.guard) p.guard = null;
      if (item.kind === 'relic') p.used.recycle = (p.used.recycle || 0) + 1;
      break;
    }
    case 'chameleon':
      demand(b && b !== a && b.suit !== a.suit, '再点一张其他花色的手牌');
      a.suit = b.suit;
      break;
    case 'black':
    case 'red':
    case 'shifter':
      demand(
        (id === 'shifter' ? ['s', 'h', 'c', 'd'] : id === 'red' ? ['h', 'd'] : ['s', 'c']).includes(
          suit,
        ) && suit !== a.suit,
        '请选择一个不同的合法花色',
      );
      a.suit = suit;
      break;
    case 'morph':
    case 'mask':
      demand(
        [11, 12, 13].includes(a.rank) && [11, 12, 13].includes(rank) && rank !== a.rank,
        '请选择不同的人头点数',
      );
      a.rank = rank;
      break;
    case 'hunter':
      demand(
        [11, 12, 13].includes(a.rank) && Number.isInteger(rank) && rank >= 2 && rank <= 10,
        '需要人头牌和 2～10 的新点数',
      );
      a.rank = rank;
      break;
    case 'walker':
      demand(a.rank <= 10 && [11, 12, 13].includes(rank), '请选择数字牌和人头点数');
      a.rank = rank;
      break;
    case 'tweak':
      demand(
        Number.isInteger(rank) && Math.abs(rank - a.rank) === 1 && rank >= 2 && rank <= 14,
        '只能升降一个点数',
      );
      a.rank = rank;
      break;
    case 'duplicate':
      demand(p.hand.length < 12, '手牌已满');
      p.hand.push({ ...a, id: 'copy' + ++g.copySeq, copy: true });
      break;
    case 'makeAce':
      if (g.scoringVersion >= 2) {
        demand(p.hand.length < 12, '手牌已满');
        p.hand.push({ ...a, rank: 14, id: 'copy' + ++g.copySeq, copy: true });
      } else demand(a.rank !== 14, '这张已经是 A');
      a.rank = 14;
      break;
    case 'clone':
      demand(
        m.other !== 'clone' && p.tools.includes(m.other) && items[m.other]?.kind === 'tool',
        '请选择另一件道具',
      );
      p.tools.push(m.other);
      break;
    case 'heal':
      demand(p.hp < p.maxHp, '生命已满');
      p.hp = Math.min(p.maxHp, p.hp + (g.scoringVersion >= 2 ? 1 : 2));
      break;
    case 'adrenaline':
      p.adrenaline = true;
      break;
    case 'ruler':
      demand(
        b && Math.abs(a.rank - b.rank) === 1 && a.suit !== b.suit,
        '请选择相邻点数、不同花色的两张牌',
      );
      [a.suit, b.suit] = [b.suit, a.suit];
      break;
    case 'needle':
      demand(
        b && a !== b && a.rank === b.rank && a.rank > 2 && a.rank < 14,
        '请选择同点的两张 3～K',
      );
      a.rank++;
      b.rank--;
      break;
    case 'guardPin':
      demand(a.rank >= 8 && !p.vow, '需要一张 8 或更大的备牌');
      p.guard = a.id;
      break;
    case 'echo':
      demand(!p.echo, '本战已系回声扣');
      p.echo = true;
      break;
    case 'lastStand':
      demand(p.hp === 1 && !p.guard, '须剩 1 血且没有暗扣');
      p.vow = true;
      break;
    default:
      throw new Error('当前不能发动该能力');
  }
  // A later transformation can invalidate a previously pinned defensive card.
  if (p.guard && !p.hand.some((c) => c.id === p.guard && c.rank >= 8)) p.guard = null;
  if (item.kind === 'tool') takeTool(p, item.id);
  else p.used[id] = (p.used[id] || 0) + 1;
}
