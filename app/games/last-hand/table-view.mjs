import { items, cast, itemDescription, activeAims } from './rules/catalog.mjs';
import { bestSelection, evaluate, blockValue } from './rules/poker.mjs';
import { remaining } from './rules/effects.mjs';
import { battleRelics, attackBonus, chapterIndex, battleInChapter } from './rules/table.mjs';
import { bidRows } from './auction-playback.mjs';
import { seatPoints } from './layout.mjs';
import {
  el,
  esc,
  button,
  paint,
  gem,
  face,
  loot,
  actor,
  tierColor,
  ranked,
  suit,
} from './widgets.mjs';
import {interactionPanel, handReminder} from './interaction-view.mjs';
import { itemHint } from './display-copy.mjs';
const names = {
  interact: '战后互动',
  growth: '战间奖励',
  auction: '竞拍',
  peek: '摸二留一',
  award: '开标',
  build: '组主手',
  reveal: '全桌揭牌',
  attack: '选择攻击目标',
  hit: '攻防结算',
  finish: '终场',
};
const byId = (v, id) => v.players.find((p) => p.id === id)?.name || '牌友';
export function draftFor(v) {
  return {
    match: v.matchId,
    epoch: v.epoch,
    card: null,
    silver: 0,
    gold: 0,
    item: null,
    source: null,
    main:
      v.phase === 'build' && v.own
        ? bestSelection(
            v.own.hand,
            battleRelics(v.own),
            v.own.vow,
            v.own.guard,
            v.scoringVersion || 1,
            v.scoreOnly,
          ).ids
        : [],
    loot: null,
  };
}
export function possibleSource(itemId, c, p, d) {
  if (!itemId) return true;
  const id = items[itemId].effect || itemId;
  if (d.source && ['sample', 'pair'].includes(items[itemId].aim)) {
    const src = p.hand.find((x) => x.id === d.source);
    if (!src || c === src) return false;
    return id === 'chameleon'
      ? src.suit !== c.suit
      : id === 'needle'
        ? src.rank === c.rank && src.rank > 2 && src.rank < 14
        : Math.abs(src.rank - c.rank) === 1 && src.suit !== c.suit;
  }
  switch (id) {
    case 'makeAce':
      return p.scoringVersion >= 2 ? p.hand.length < 12 : c.rank !== 14;
    case 'morph':
    case 'mask':
    case 'hunter':
      return c.rank >= 11 && c.rank <= 13;
    case 'walker':
      return c.rank <= 10;
    case 'guardPin':
      return c.rank >= 8 && !p.vow;
    case 'chameleon':
      return p.hand.some((x) => x.suit !== c.suit);
    case 'needle':
      return c.rank > 2 && c.rank < 14 && p.hand.some((x) => x !== c && x.rank === c.rank);
    case 'ruler':
      return p.hand.some((x) => Math.abs(x.rank - c.rank) === 1 && x.suit !== c.suit);
    default:
      return true;
  }
}
const auctionAction = {reserve:'选明牌后跳过', peek:'抽牌 · 2 银', tail:'出价 · 只押银', insure:'出价 · 须押金'};
export function effectStatus(id, v) {
  const item = items[id];
  if (id === 'escrow') return '竞拍中主动跳过时自动生效';
  if (id === 'ledger') return v.growth?.canLedger ? '选取奖励时可翻账本' : '竞拍积攒记号，选物时使用';
  if (!activeAims.has(item.aim) && !['auction', 'growth'].includes(item.aim)) return '满足条件时自动生效';
  if (effectReady(id, v)) return item.aim === 'auction' ? '竞拍可用 · ' + auctionAction[id] : '现在可用';
  if (!remaining(v.own, id)) return '本战次数已用完';
  if (item.aim === 'growth') return '挑选共享道具时使用';
  if (item.aim === 'auction') {
    if (v.phase === 'auction' && v.own?.pending) return '已封标，下批竞拍再用';
    if (v.phase === 'auction' && id === 'peek' && v.own.silver < 2) return '抽牌需要 2 银';
    if (v.phase === 'auction' && id === 'insure' && !v.own.gold) return '出价需至少 1 金';
    if (v.phase === 'auction' && id === 'tail' && !v.own.silver && !v.own.bank) return '出价需至少 1 银';
    return '竞拍时使用 · ' + auctionAction[id];
  }
  return v.phase === 'build' ? '当前手牌或状态不满足条件' : '组牌时使用';
}
export function effectReady(itemId, v) {
  const p = v.own;
  if (!p || !v.actors.includes(v.self) || remaining(p, itemId) <= 0) return false;
  const item = items[itemId],
    id = item.effect || itemId,
    aim = item.aim;
  if (v.phase === 'growth')
    return (
      id === 'lantern' &&
      !v.growth.simultaneous &&
      v.growth.kind !== 'private' &&
      v.growth.order.length > 1 &&
      !v.growth.personal &&
      !v.growth.passed.some((id) => v.growth.order.slice(0, 2).includes(id))
    );
  if (v.phase === 'auction')
    return aim === 'auction' && (id !== 'peek' || p.silver >= 2) && (id !== 'insure' || p.gold > 0) &&
      (id !== 'tail' || p.silver + p.bank > 0);
  if (v.phase !== 'build') return false;
  if (item.duration === 'battle') return true;
  if (
    (id.startsWith('recycle') && p.replacementsAvailable === false) ||
    (id === 'duplicate' && p.hand.length >= 12)
  )
    return false;
  if (id === 'heal') return p.hp < p.maxHp;
  if (id === 'lastStand') return p.hp === 1 && !p.guard;
  if (id === 'echo') return !p.echo;
  if (id === 'clone') return p.tools.some((x) => x !== 'clone');
  if (
    ![
      'one',
      'sample',
      'black',
      'red',
      'suit',
      'face',
      'number',
      'toFace',
      'step',
      'pair',
      'defend',
    ].includes(aim)
  )
    return false;
  return p.hand.some((c) => possibleSource(id, c, p, {}));
}
function stepper(v, d) {
  const p = v.own,
    can = v.actors.includes(v.self),
    row = (key, caption, n, max) =>
      '<div>' +
      button('−', 'adjust', key + '-', '', !can || n <= 0) +
      '<b class="' +
      (key === 'gold' ? 'g' : 's') +
      '">' +
      caption +
      ' ' +
      n +
      '</b>' +
      button('＋', 'adjust', key + '+', '', !can || n >= max) +
      '</div>';
  return (
    '<div class="stepper" aria-label="调整密封报价">' +
    row('silver', '银', d.silver, p.silver + p.bank) +
    row('gold', '金', d.gold, p.gold) +
    '</div>'
  );
}
function roundComparison(v) {
  const first = v.showdown[0];
  if (!first) return '';
  const mine = v.showdown.find(hand => hand.id === v.self);
  const leaders = v.showdown.filter(hand => hand.rank === 1);
  const highest = leaders.find(hand => hand.id !== v.self) || first;
  function row(kind, title, hand, owner = '') {
    const cards = hand?.main.map(card => face(card)).join('') || '';
    const result = hand
      ? '<span class="roundHandValue">' + esc(hand.label) + ' <b>' + hand.points + ' 分</b></span>'
      : '<span class="roundHandValue">本战未出牌</span>';
    return '<section class="roundHand ' + kind + '"><div class="roundHandInfo"><b>' + title + '</b>' +
      (owner ? '<span class="roundHandOwner" title="' + esc(owner) + '">' + esc(owner) + '</span>' : '') +
      result + '</div><div class="roundHandCards">' + cards + '</div></section>';
  }
  const label = leaders.length > 1 ? '并列最高 · ' + leaders.length + ' 人' : '本战最高';
  const leaderName = highest.id === v.self ? '我' : byId(v, highest.id);
  const hit = v.phase === 'hit' ? v.hit : null;
  let impact;
  if (v.scoreOnly) {
    const hand = mine || highest;
    impact = '<p class="roundImpact">' + (mine ? '我的总分' : esc(byId(v, hand.id)) + ' 总分') +
      ' ' + hand.previousTotal + ' + ' + hand.points + ' = <b>' + hand.total + '</b> · 总排名' +
      (hand.sharedRank ? '并列' : '') + '第 ' + hand.overallRank + '</p>';
  } else if (hit) {
    impact = '<p class="roundImpact"><b>' + esc(byId(v, hit.target)) + '</b> 承受 ' + hit.actual +
      ' 伤 · 基础 ' + hit.base + ' / 抵挡 ' + hit.blocked + ' · 生命 ' +
      hit.before + ' → ' + hit.after + (hit.eventBlocked ? ' · 互动盾挡 ' + hit.eventBlocked : '') + (hit.result ? ' · ' + esc(hit.result) : '') + '</p>';
  } else {
    impact = '<p class="roundImpact">最高主手的牌型伤害 ' + highest.damage + ' 点</p>';
  }
  return '<div class="central roundComparison">' +
    (v.own ? row('own', '我的主手', mine) : '') +
    row('highest', label, highest, leaderName) + impact + '</div>';
}

function rewardPanel(v, draft, can, room) {
  const g = v.growth;
  const options = [...g.offers, ...(g.personal ? [g.personal] : [])];
  const pick = options.includes(draft.loot) ? draft.loot : null;
  const canTake = id => items[id].kind === 'tool' || !v.own?.relics.includes(id);
  const skill = g.kind === 'relic';
  const title = skill ? '选技能' : g.kind === 'private' ? '账本私选' : '选道具';
  const caption = can ? (skill ? '整场有效' : g.kind === 'tool' ? '低分先选' : '') :
    (g.simultaneous ? (v.own ? '等牌友选好' : '各自三选一') : byId(v, g.order[0]) + ' 挑选中');
  const order = g.kind !== 'tool' ? '' : '<div class="draftOrder" aria-label="选取顺序">' +
    g.order.map((id, i) => '<span class="' + (i === 0 ? 'current' : '') + '"><span class="draftName">' +
      esc(byId(v, id)) + '</span> ' + v.players.find(p => p.id === id).score + '</span>').join(' › ') + '</div>';
  const cards = options.map(id => loot(id, can && pick === id, can ? 'selectLoot' : 'inspectItem',
    v.scoringVersion, v.scoreOnly, id === g.personal ? '私选' : can && !canTake(id) ? '已拥有' : '')).join('');
  const controls = [];
  if (can) {
    if (g.canLedger) controls.push(button('翻账本', 'ledger'));
    if (pick) controls.push('<button type="button" class="rewardInfo" data-act="inspectItem" data-val="' +
      esc(pick) + '" aria-label="查看' + esc(items[pick].name) + '详情">详情</button>');
    controls.push(options.some(canTake)
      ? button(pick ? '领取·' + items[pick].name : skill ? '领取技能' : '领取道具', 'takeLoot', pick || '', 'gold', !pick || !canTake(pick))
      : button('跳过', 'emptyLoot', '', 'gold'));
  }
  if (room && v.battle === 1 && v.batch === 0 && g.order.includes(v.self))
    controls.push(button('换角色', 'chooseAvatar'));
  const taken = g.picked.at(-1);
  const receipt = taken ? '<div class="pickOutcome">' +
    esc(byId(v, taken.id)) + ' 取得 ' + esc(items[taken.item].name) + '</div>' : '';
  return '<section class="central rewardPanel" aria-label="' + title + '"><header><h2>' + title +
    '</h2><span>' + esc(caption) + '</span></header><div class="rewardScroll">' + order +
    (cards ? '<div class="lootRow' + (g.kind === 'tool' && !can ? ' turnWaiting' : '') +
      '" style="--reward-cols:' + Math.min(4, options.length) + '">' + cards + '</div>' : '') +
    receipt + '</div>' + (controls.length ? '<div class="rewardActions">' + controls.join('') + '</div>' : '') + '</section>';
}

export function drawTable(v, d, room) {
  const me = v.own,
    can = v.actors.includes(v.self),
    who = (id) => byId(v, id);
  el('world').dataset.screen = 'table';
  el('world').dataset.phase = v.phase;
  el('home').hidden = true;
  el('route').hidden = false;
  el('matchClock').hidden = v.matchDeadline == null || v.status === 'finished';
  el('leaveBtn').hidden = false;
  const currentNode = 2 * battleInChapter(v) - (v.phase === 'growth' ? 2 : 1);
  const trail = ['⚔','◈','⚔','ϟ','⚔','◈','⚔'];
  const chapter = v.chapterVersion >= 2
    ? '<span>章节 ' + (chapterIndex(v) + 1) + '-' + currentNode + '</span><span class="chapterTrail" aria-label="本章进度">' +
      trail.map((s,i) => '<b class="' + (i+1 === currentNode ? 'current' : i+1 < currentNode ? 'past' : '') + '">' + s + '</b>').join('') + '</span>'
    : '<span>第 ' + (chapterIndex(v) + 1) + ' 段 · 第 ' + v.battle + ' 战</span>';
  const route = chapter +
    '<span aria-label="竞拍批次">' +
    [1, 2, 3, 4].map((i) => '<i class="' + (i <= v.batch ? 'on' : '') + '"></i>').join('') +
    '</span><time id="clock"></time>';
  paint('phaseBar', route);
  el('phaseTitle').hidden = v.phase === 'growth';
  el('phaseTitle').textContent = v.scoreOnly && v.phase === 'reveal' ? '积分结算' : names[v.phase] || '牌桌';
  paint(
    'scoreboard',
    v.players
      .map((p) => {
        const a = actor(p),
          target = v.targets.includes(p.id) && v.attacker === v.self,
          eventTarget = v.interaction?.stage === 'target' && v.interaction.host === v.self && v.interaction.targets.includes(p.id);
        return (
          '<button type="button" data-act="' +
          (target ? 'attack' : eventTarget ? 'eventTarget' : 'inspectSeat') +
          '" data-val="' +
          esc(p.id) +
          '" style="--seat:' +
          a.color +
          '" class="seatRow ' +
          (Math.abs(p.score) >= 1000 ? 'longScore ' : '') +
          (p.id === v.self ? 'mine ' : '') +
          (p.out ? 'out ' : '') +
          (target || eventTarget ? 'target' : '') +
          (eventTarget && d.eventChoice?.action === 'eventTarget' && d.eventChoice.value === p.id ? ' previewTarget' : '') +
          '"><img class="emblem" src="./assets/portraits/' +
          a.id +
          '.png" alt=""><span class="seatInfo"><span class="seatHeading"><strong>' +
          esc(p.name) +
          (p.id === v.self ? ' · 我' : '') +
          (p.ready ? ' ✓' : '') +
          '</strong><b class="seatScore" aria-label="累计积分 ' + p.score + '" title="累计积分">' +
          p.score + '分</b></span><small>' +
          (v.scoreOnly ? '<span title="总排名">第' + (1 + v.players.filter(other => other.score > p.score).length) + '</span>'
            : '<span class="hp">♥' + p.hp + '</span>') + '<span>◉' +
          p.silver +
          '</span><span class="money">◆' +
          p.gold +
          '</span>' + (p.eventShield ? '<span title="互动护盾">⬡' + p.eventShield + '</span>' : '') +
          (p.eventAttack ? '<span title="互动攻击">⚔' + p.eventAttack + '</span>' : '') + '</small></span></button>'
        );
      })
      .join(''),
  );
  if (v.phase === 'finish') el('scoreboard').hidden = true;
  const world = el('world');
  const bids = v.phase === 'award' ? v.award?.entries.filter(e => e.kind === 'bid') || [] : [];
  const sharing = new Set(bids.filter(bid => bids.some(other => other.id !== bid.id && other.card === bid.card)).map(bid => bid.id));
  const pts = seatPoints(v.players.length, world.clientHeight > world.clientWidth);
  paint(
    'seatTags',
    v.players
      .map((p, i) => {
        const t = v.targets.includes(p.id) && v.attacker === v.self;
        return (
          '<' +
          (t ? 'button' : 'span') +
          ' data-seat="' + esc(p.id) + '" class="tag ' +
          (t ? 'target ' : '') +
          (sharing.has(p.id) ? 'sharedLot ' : '') +
          (p.id === v.self ? 'mine' : '') +
          '" style="left:' +
          pts[i][0] * 100 +
          '%;top:' +
          pts[i][1] * 100 +
          '%" ' +
          (t ? 'data-act="attack" data-val="' + esc(p.id) + '"' : '') +
          '>' +
          esc(p.name) +
          (p.out
            ? ' · 出局'
            : p.sitting
              ? ' · 停战'
              : v.protected === p.id
                ? ' ◈'
                : p.ready
                  ? ' ✓'
                  : '') +
          '</' +
          (t ? 'button' : 'span') +
          '>'
        );
      })
      .join(''),
  );
  const auction = ['auction', 'award', 'peek'].includes(v.phase);
  let market = '',
    center = '',
    actions = '',
    hand = '';
  const msg = (s) => '<span class="message">' + esc(s) + '</span>',
    panel = (head, body) => '<div class="central"><h2>' + esc(head) + '</h2>' + body + '</div>';
  if (auction) {
    const locked = me?.pending,
      selected = locked?.card || d.card;
    market = (v.award?.market || v.market)
      .map((c) => {
        return (
          '<div class="lot" data-card="' + esc(c.id) + '">' +
          face(c, {
            action: 'lot',
            sel: v.phase === 'auction' && c.id === selected,
            label: '明牌',
          }) +
          (v.phase === 'award' ? bidRows(v, c.id) : '') +
          (v.phase === 'auction' && can && me && c.id === selected ? stepper(v, d) : '') +
          '</div>'
        );
      })
      .join('');
  }
  if (v.phase === 'auction') {
    if (can) {
      const reserve = d.item === 'reserve',
        peek = d.item === 'peek',
        insurance = d.item === 'insure',
        tail = d.item === 'tail';
      const inactive = !d.card || (!d.gold && !d.silver) || (insurance && !d.gold) || (tail && !!d.gold);
      actions =
        '<button type="button" class="gold quoted" data-act="bid" title="先选明牌，再用加号出价" ' +
        (inactive ? 'disabled' : '') +
        '><b>出价</b><small>' + (!d.card ? '先选明牌' : !d.gold && !d.silver ? '请加筹码' :
          (d.gold ? d.gold + ' 金 ' : '') + d.silver + ' 银') + '</small></button>' +
        '<button class="quoted quiet" data-act="pass" title="从无人认领的明牌中随机拿一张" ' +
          (reserve && !d.card ? 'disabled' : '') + '><b>跳过</b><small>' +
          (reserve ? '预约剩牌' : '免费 · 桌上剩牌') + '</small></button>' +
        '<button class="quoted" data-act="blind" title="花 2 银，从牌库随机抽一张" ' +
          (me.silver < 2 ? 'disabled' : '') + '><b>抽牌</b><small>' +
          (peek ? '2 银 · 摸二留一' : '2 银 · 牌库') + '</small></button>';
    } else
      actions = msg(
        me?.pending
          ? '已封标 · ' +
              (me.pending.kind === 'bid'
                ? me.pending.gold + '金 ' + me.pending.silver + '银'
                : me.pending.kind === 'blind'
                  ? '抽牌 · 2 银'
                  : '跳过 · 分剩牌') +
              ' · 等开标'
          : '等待全桌封标',
      );
  } else if (v.phase === 'peek') {
    if (me?.peek) {
      market = me.peek.map((c) => face(c, { action: 'peek', label: '保留' })).join('');
      actions = msg('点选一张私牌保留');
    } else actions = msg('等牌友选牌');
  } else if (v.phase === 'award') {
    actions = '<span class="message" id="auctionNote" role="status"></span>' + button('明细', 'auctionBill');
  } else if (v.phase === 'growth') {
    center = rewardPanel(v, d, can, room);
  } else if (v.phase === 'build') {
    if (me && !me.choice && can) {
      const ids = d.main.filter((id) => me.hand.some((c) => c.id === id) && id !== me.guard);
      d.main = ids;
      const main = me.hand.filter((c) => ids.includes(c.id)),
        e = evaluate(main, battleRelics(me), me.vow, v.scoringVersion || 1),
        backup = me.hand.filter((c) => !ids.includes(c.id)),
        def = blockValue(backup, me.guard, me.vow);
      if (d.item) {
        const x = items[d.item];
        center = panel(
          x.name,
          '<p>' +
            esc(itemHint(x.id, v.scoringVersion)) +
            '</p><div class="panelButtons">' +
            effectChoices(v, d) +
            '</div>',
        );
        actions = button('取消', 'cancelEffect');
        if (!['self', 'vow', 'tool'].includes(x.aim))
          actions += msg(d.source ? '选目标' : '选手牌');
      } else {
        center = panel(
          e.label,
          '<p>' +
            e.points +
            (v.scoreOnly ? ' 分' : ' 分　·　' +
            (main.length ? e.damage + attackBonus(me) : 0) +
            ' 伤　·　' +
            (battleRelics(me).includes('barrier')
              ? '护盾挡全部伤害'
              : '备牌抵 ' + (def.pair + def.pin) + ' 伤')) +
            '</p><div class="miniCards">' +
            main.map((c) => face(c, { action: 'hand', label: v.scoreOnly ? '移回手牌' : '移回备牌' })).join('') +
            '</div>' +
            (me.boosts?.length || me.adrenaline
              ? '<button class="boostList" data-act="inspectBoosts">生效中 · ' +
                ((me.boosts?.length || 0) + Number(!!me.adrenaline)) +
                '</button>'
              : ''),
        );
        actions =
          button('推荐主手', 'suggest') +
          button('亮牌 · ' + main.length + ' 张', 'submit', '', 'gold', !main.length);
      }
    } else actions = msg(me?.choice ? '已锁定 · 等亮牌' : '等牌友组牌');
  } else if (v.phase === 'interact') {
    center = interactionPanel(v, d.eventChoice);
    hand = '<div class="eventFooter">' + handReminder(v) + button('本战明细', 'battleBill') + '</div>';
  } else if (v.phase === 'reveal' || v.phase === 'attack' || v.phase === 'hit') {
    center = roundComparison(v);
    if (v.phase === 'attack')
      actions =
        msg(can ? '点对手出击' : who(v.attacker) + ' 正在选对手') +
        button('全桌牌型', 'battleBill');
    else actions = button('全桌明细', 'battleBill');
  } else if (v.phase === 'finish') {
    center = panel(
      v.scoreOnly && v.result.winnerIds.length > 1 ? v.result.winnerIds.length + ' 人并列第一' :
        v.result.winnerIds.map(who).join('、') + ' 获胜',
      '<p>' +
        esc(v.settings.mode === 'survival' ? '生存赛' : '积分赛') +
        (v.result.reason === 'time-limit' ? ' · 时间到' : v.result.reason === 'last-standing' ? ' · 生存决胜' : ' · 赛程完成') +
        ' · 共 ' +
        v.battle +
        ' 战</p><div class="standingsScroll" tabindex="0" aria-label="最终排名"><table class="receipt">' +
        v.result.standings
          .map(
            (s, i) =>
              '<tr><td>' +
              (v.scoreOnly && v.result.standings.some(other => other.id !== s.id && other.rank === s.rank) ? '并列 ' : '') + (s.rank ?? i + 1) +
              '</td><td>' +
              esc(s.name) +
              '</td><td>' +
              s.score +
              ' 分</td>' + (v.scoreOnly ? '' : '<td>♥ ' + s.hp + '</td>') + '</tr>',
          )
          .join('') +
        '</table></div><div class="finishButtons">' +
        button('再来一局', 'again', '', 'gold', !!room && room.selfId !== room.hostId) +
        button('返回棋牌室', 'exit') + '</div>',
    );
  }
  if (me && me.hand.length && !['finish','interact'].includes(v.phase)) {
    const sel = v.phase === 'build' ? me.choice || d.main : [];
    hand =
      '<div class="handLabel">' +
      (v.phase === 'build'
        ? '主手 ' + sel.length + ' / 5' + (v.scoreOnly ? '' : '　·　其余为备牌')
        : '我的私牌' + (v.phase === 'award' ? '' : ' · ' + me.hand.length)) +
      ' </div><div class="handrow" style="--n:' +
      me.hand.length +
      ';--steps:' +
      Math.max(1, me.hand.length - 1) +
      '">' +
      me.hand
        .map((c) =>
          face(c, {
            action: v.phase === 'build' && can ? 'hand' : '',
            sel: sel.includes(c.id),
            badge: hintFor(c, me, d) || (c.id === me.guard ? '暗扣' : c.copy ? '复写' : ''),
            css:
              d.item && v.phase === 'build'
                ? d.source === c.id
                  ? 'source'
                  : possibleSource(d.item, c, me, d)
                    ? 'valid'
                    : 'dim'
                : v.phase === 'award' && c === me.hand.at(-1) && v.award.received.some((r) => r.id === v.self) ? 'incoming' : '',
            label: '手牌',
          }),
        )
        .join('') +
      '</div>';
  }
  paint('market', market);
  const centerNode = el('center');
  const watched = el('world').dataset.phase;
  const previous = centerNode.dataset.phase === watched ? centerNode.querySelector('.rewardScroll, .eventBody, .eventPanel:not(:has(.eventBody))') : null;
  const scroll = previous?.scrollTop || 0;
  const focused = centerNode.contains(document.activeElement) ? document.activeElement : null;
  paint('center', center);
  centerNode.dataset.phase = watched;
  if (previous && !previous.isConnected) {
    const replacement = centerNode.querySelector('.rewardScroll, .eventBody, .eventPanel:not(:has(.eventBody))');
    if (replacement) replacement.scrollTop = scroll;
    if (focused?.dataset.act) {
      const next = [...centerNode.querySelectorAll('[data-act]')].find(node =>
        node.dataset.act === focused.dataset.act && node.dataset.val === focused.dataset.val);
      next?.focus({preventScroll:true});
    }
  }
  paint('actions', actions);
  paint('hand', hand);
  for (const [kind, id] of [
    ['relics', 'relics'],
    ['tools', 'tools'],
  ]) {
    const unique = me ? [...new Set(me[kind])] : [];
    if (v.phase === 'auction' && kind === 'tools') unique.sort((a,b) => Number(effectReady(b,v)) - Number(effectReady(a,v)));
    const shown = unique.slice(0, kind === 'relics' && world.clientWidth < 650 ? 2 : world.clientWidth < 650 ? 3 : 4);
    paint(
      id,
      (me && kind === 'relics' && v.phase !== 'finish' ? button('我的技能 ' + unique.length, 'bag', 'relics', 'skillLabel') : '') +
      shown
        .map((key) => {
          const item = items[key],
            count = me[kind].filter((x) => x === key).length;
          return (
            '<button type="button" class="pocket ' +
            (effectReady(key, v) || !activeAims.has(item.aim) && !['auction', 'growth'].includes(item.aim) ? '' : 'spent ') +
            (v.phase === 'auction' && item.aim === 'auction' && effectReady(key, v) ? 'auctionReady ' : '') +
            (d.item === key ? 'active' : '') +
            '" data-act="item" data-val="' +
            key +
            '" style="--tier:' +
            tierColor(item.tier) +
            '" title="' +
            esc(itemDescription(key, v.scoringVersion, v.scoreOnly)) +
            '" aria-label="' +
            esc(item.name + (v.phase === 'auction' && item.aim === 'auction' ? ' · ' + effectStatus(key, v) : '')) +
            '">' +
            gem(key) +
            '<small>' +
            esc(item.name) +
            (count > 1 ? ' ×' + count : '') +
            '</small></button>'
          );
        })
        .join('') +
        (kind !== 'relics' && unique.length > shown.length
          ? button('+' + (unique.length - shown.length), 'bag', kind)
          : ''),
    );
  }
}
function hintFor(c, p, d) {
  const a = p.hand.find((q) => q.id === d.source);
  if (!a || !possibleSource(d.item, c, p, d) || a.id === c.id) return '';
  if (d.item === 'ruler') return suit(a.suit) + ' ⇄ ' + suit(c.suit);
  if (d.item === 'needle') return ranked(a.rank + 1) + ' ／ ' + ranked(c.rank - 1);
  if (items[d.item]?.aim === 'sample') return suit(a.suit) + ' → ' + suit(c.suit);
  return '';
}
function effectChoices(v, d) {
  const x = items[d.item],
    p = v.own,
    c = p.hand.find((c) => c.id === d.source);
  if (x.aim === 'self' || x.aim === 'vow') return button('发动', 'effectNow', '', 'gold');
  if (x.aim === 'tool')
    return [...new Set(p.tools.filter((id) => id !== 'clone'))]
      .map((id) => button(items[id].name, 'effectOther', id))
      .join('');
  if (!c) return '';
  if (['red', 'black', 'suit'].includes(x.aim))
    return (x.aim === 'suit' ? ['s', 'h', 'c', 'd'] : x.aim === 'red' ? ['d', 'h'] : ['s', 'c'])
      .filter((s) => s !== c.suit)
      .map((s) => button(suit(c.suit) + ' → ' + suit(s), 'effectSuit', s))
      .join('');
  let ns =
    x.aim === 'number'
      ? [2, 3, 4, 5, 6, 7, 8, 9, 10]
      : x.aim === 'face' || x.aim === 'toFace'
        ? [11, 12, 13]
        : x.aim === 'step'
          ? [c.rank - 1, c.rank + 1]
          : [];
  return ns
    .filter((n) => n !== c.rank && n >= 2 && n <= 14)
    .map((n) => button(ranked(c.rank) + ' → ' + ranked(n), 'effectRank', n))
    .join('');
}
