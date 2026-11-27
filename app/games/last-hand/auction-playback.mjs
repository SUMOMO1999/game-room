import { awardTiming, awardBeat } from './rules/award-timing.mjs';
import { el, esc } from './widgets.mjs';
import { cardName } from './rules/catalog.mjs';
import { dealerPoint } from './layout.mjs';

export function dealMarket(v, reduced) {
  const elapsed = Math.max(0, Date.now() - (v.deadline - v.phaseDuration));
  if (reduced || !Number.isFinite(elapsed) || elapsed >= 900) return;
  const board = el('world').getBoundingClientRect();
  const [sx, sy] = dealerPoint(board.height > board.width);
  const cards = [...el('market').querySelectorAll('.face')];
  if (v.batch === 1) cards.push(...el('hand').querySelectorAll('.handrow .face'));
  cards.forEach((card, i) => {
    const b = card.getBoundingClientRect();
    const dx = board.left + sx * board.width - (b.x + b.width/2);
    const dy = board.top + (sy - .035) * board.height - (b.y + b.height/2);
    const face = card.querySelector('img');
    card.classList.add('dealing');
    const motion = face.animate([
      { transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(-12deg) scale(.25)', opacity: .2 },
      { transform: 'none', opacity: 1 },
    ], { duration: 400, delay: 60 * i, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' });
    motion.currentTime = elapsed;
    motion.onfinish = motion.oncancel = () => card.classList.remove('dealing');
  });
}

export function bidRows(v, card) {
  const entries = v.award.entries.filter((e) => e.kind === 'bid' && e.card === card);
  entries.sort((a, b) => b.gold - a.gold || b.silver - a.silver);
  if (!entries.length) return '';
  // Let prices use empty neighbouring slots. Keep a boundary halfway to the next occupied card.
  const occupied = v.award.market.map((c, index) => v.award.lots.some((lot) => lot.card === c.id) ? index : -1).filter((index) => index >= 0);
  const slot = v.award.market.findIndex((c) => c.id === card);
  const group = occupied.indexOf(slot);
  const cap = entries.length > 3 ? 3.5 : 0.8;
  const left = Math.min(cap, group > 0 ? (slot - occupied[group - 1] - 1) / 2 : slot);
  const right = Math.min(cap, group + 1 < occupied.length ? (occupied[group + 1] - slot - 1) / 2 : v.award.market.length - slot - 1);
  return '<div class="bidRows" style="--left-space:' + (-100 * left) + '%;--right-space:' + (-100 * right) + '%">' + entries.map((entry, i) => {
    const name = v.players.find((p) => p.id === entry.id).name;
    const coins = (entry.gold ? entry.gold + '金 ' : '') + entry.silver + '银';
    const price = (entry.gold ? '<em>' + entry.gold + '金</em> ' : '') + '<strong>' + entry.silver + '银</strong>';
    return '<div class="bidRow" data-bidder="' + esc(entry.id) + '" style="--order:' + i +
      '" title="' + esc(name + '　' + coins) + '"><span>' + esc(name) +
      '</span><b>' + price + '</b><i></i></div>';
  }).join('') + '</div>';
}

export function auctionResult(v) {
  const entry = v.award.entries.find((e) => e.id === v.self);
  const received = v.award.received.find((e) => e.id === v.self);
  if (!entry || !received) return '本批收牌完毕';
  if (received.blind) return '花 2 银，从牌库抽了一张';
  const face = v.award.market.find((c) => c.id === received.card);
  if (!face) return '已收牌';
  if (entry.kind === 'pass') return '跳过，从剩牌拿到 ' + cardName(face);
  return (entry.card === face.id ? '竞得 ' : '未中标，从剩牌拿到 ') + cardName(face);
}

// The table clock owns this timeline, including when the browser rejoins halfway through.
export function playbackFor(v) {
  if (v?.phase !== 'award' || !v.award) return null;
  const plan = awardTiming(v.award);
  return { plan, deadline: v.deadline, duration: v.phaseDuration || 2800 };
}
export function syncAward(v, playback, reduced, now = Date.now()) {
  const world = el('world');
  if (!playback) {
    delete world.dataset.beat;
    delete world.dataset.received;
    return;
  }
  const { plan, duration, deadline } = playback;
  const ms = reduced ? plan.duration : plan.duration * (1 - Math.max(0, deadline - now) / duration);
  const beat = awardBeat(plan, ms);
  world.dataset.beat = beat;
  const ownIndex = v.award.received.findIndex((entry) => entry.id === v.self);
  world.dataset.received = String(ownIndex >= 0 && ms >= plan.collect + ownIndex * 50 + 1200);
  const rollIndex = Math.floor((ms - plan.diceStart) / plan.throwMs);
  const roll = beat === 'dice' ? plan.rolls[rollIndex] : null;
  const landed = ms - plan.diceStart - rollIndex * plan.throwMs >= plan.landed;
  const name = (id) => v.players.find((p) => p.id === id)?.name || '牌友';
  const card = roll && v.award.market.find((c) => c.id === roll.card);
  const contested = v.award.lots.length > 0;
  const title = roll
    ? cardName(card) + ' 同价 · ' + name(roll.id) + (roll.attempt > 1 ? ' 重掷' : ' 掷骰') + (landed ? '　' + roll.die + ' 点' : '…')
    : { approach: contested ? '开标 · 出价者入场' : '亮出全桌行动', compare: contested ? '比价 · 先比金，再比银' : '本批无人出价', winner: contested ? '得主揭晓' : '分配本批卡牌', collect: '领取本批卡牌', home: '收牌完毕' }[beat];
  if (el('phaseTitle').textContent !== title) el('phaseTitle').textContent = title;
  const decided = ms >= plan.winner;
  for (const lot of world.querySelectorAll('#market .lot')) {
    const id = lot.dataset.card;
    const won = v.award.lots.find((l) => l.card === id);
    lot.classList.toggle('rolling', roll?.card === id);
    lot.classList.toggle('claimed', decided && !!won);
    for (const row of lot.querySelectorAll('.bidRow')) {
      const player = row.dataset.bidder;
      row.classList.toggle('won', decided && player === won?.winner);
      row.classList.toggle('rolling', roll?.id === player && roll.card === id);
      const shown = plan.rolls.filter((r, i) => r.card === id && r.id === player &&
        ms >= plan.diceStart + i * plan.throwMs + plan.landed);
      const score = shown.length ? '⚄ ' + shown.at(-1).die : '';
      const number = row.querySelector('i');
      if (number.textContent !== score) number.textContent = score;
    }
  }
  const note = el('auctionNote');
  if (note) {
    const content = ms >= plan.home ? auctionResult(v) :
      beat === 'winner' ? (v.award.lots.length ? '中标者站上所得的牌，绿色标出成交价' : '本批无人出价，分配剩牌') :
      beat === 'approach' ? '全部行动已锁定' : beat === 'compare' ? (contested ? '每张牌下显示对它的报价' : '跳过的席位分剩牌，抽牌的席位从牌库摸') :
      beat === 'dice' ? '最高报价相同，由骰点决定' : '卡牌正在入手';
    if (note.textContent !== content) note.textContent = content;
  }
  return roll ? (landed ? 'land-' : 'roll-') + rollIndex : beat;
}
