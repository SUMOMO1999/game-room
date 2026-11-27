import {
  items,
  handTypes,
  handScores,
  damageByHand,
  damagePenalty,
  scoringVersion,
  stockFor,
  worksInPointsMatch,
  itemDescription,
  goals,
  cardName,
} from './rules/catalog.mjs';
import { el, esc, button, gem, showDetail, face, paint, getObj, saveObj } from './widgets.mjs';
import { career } from './practice.mjs';
import { decisionSummary, matchSummary } from './timing.mjs';
import {eventCards} from './rules/interaction-cards.mjs';
import {resultDetails} from './interaction-view.mjs';
const paragraph = (t) => '<p>' + esc(t) + '</p>';
const table = (heads, rows) =>
  '<table class="receipt"><tr>' +
  heads.map((h) => '<th>' + h + '</th>').join('') +
  '</tr>' +
  rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') +
  '</table>';
const preference = 'olh:book';
const newestPool = Math.max(...Object.values(items).map(stockFor));
const sections = [
  ['hands', '牌型'], ['rules', '玩法'], ['items', '物品'], ['events','互动'], ['goals', '战绩'], ['history', '记录'],
];
let current = 'hands', revision = 0, contentKey = '';
export function closeBook() {
  revision++;
  el('bookPanel').hidden = true;
  el('codexBtn').setAttribute('aria-expanded', 'false');
  saveObj(preference, { open: false, tab: current });
  el('codexBtn').focus({preventScroll: true});
}
export function toggleBook(v) {
  return el('bookPanel').hidden ? book(current, v) : closeBook();
}
export function restoreBook(v) {
  const saved = getObj(preference);
  if (sections.some(([key]) => key === saved?.tab)) current = saved.tab;
  if (saved?.open) return book(current, v);
}
export function syncBook(v, careerChanged = false) {
  if (careerChanged && current === 'goals') contentKey = '';
  if (!el('bookPanel').hidden) return book(current, v);
}
export async function book(tab = 'hands', v = null) {
  const version = v ? v.scoringVersion || 1 : scoringVersion;
  const pool = v ? v.itemPoolVersion || 1 : newestPool;
  const fourBattles = !v || v.chapterVersion >= 2;
  const scoreOnly = v?.scoreOnly === true;
  const changed = current !== tab;
  const opening = el('bookPanel').hidden;
  if (changed || opening) {
    current = tab;
    saveObj(preference, { open: true, tab });
  }
  el('bookPanel').hidden = false;
  el('codexBtn').setAttribute('aria-expanded', 'true');
  // Keep scroll, search text and focused controls while a hand or a bid is in progress.
  const key = JSON.stringify([tab, version, v?.interactionVersion, v?.settings.mode, scoreOnly, v?.settings.expansion,
    tab === 'rules' && [fourBattles, decisionSummary(v?.settings), matchSummary(v?.settings)], tab === 'items' && pool,
    tab === 'history' && v?.log, tab === 'goals' && v?.status]);
  if (key === contentKey && !opening) return;
  const ticket = ++revision;
  contentKey = key;
  paint('bookTabs', sections.map(([id, label]) => button(label, 'book', id, id === tab ? 'on' : '')).join(''));
  const picker = el('bookSection');
  if (!picker.options.length)
    for (const [id, label] of sections) picker.add(new Option(label === '牌型' ? '牌型与计分' : label, id));
  picker.value = tab;
  for (const node of el('bookTabs').children) node.setAttribute('aria-pressed', String(node.dataset.val === tab));
  const container = el('bookBody');
  const scroll = changed ? 0 : container.scrollTop;
  let body = '';
  if (tab === 'rules')
    body =
      paragraph('每战先拿两张底牌，再拿四批牌。每批可以出价、跳过或抽牌。全桌锁定后一起开标。') +
      paragraph(
        '先比金筹，再比银筹。最高同价的人掷' +
          (version >= 2 ? '二十' : '六') +
          '面骰，最高点再平由并列的人重掷。输标也付款，随后随机分一张剩牌。跳过免费，从桌上剩牌随机拿一张。抽牌花 2 银，从牌库摸一张。',
      ) +
      paragraph(
        scoreOnly ? '每人选一至五张组成主手。翻牌时，每人把自己的牌型分加进总分，总分相同并列。' :
        v ? '从手里选一至五张亮牌，其余留作防守。第一名选一人攻击，三人以上第二名受保护。留下的牌组成对子可抵 1 伤。' :
        '积分赛中，各自的主手给自己挣分，打完赛程比总分。生存赛中，赢家选对手扣血，坚持到最后获胜。',
      ) +
      paragraph(
        (fourBattles
          ? '每章打四战。第一、三战后，每人同时从自己的三件遗物中选一件。第二战后，大家按累计积分从低到高挑共享道具。桌上比参与人数多摆一件，每人取走一件。同分的席位按本章座次轮转。'
          : '这桌沿用开局时的三战一段。段首挑遗物，第一战后按低分优先挑共享道具。') +
        (scoreOnly ? '所有人都能打到终场。' : v?.settings.mode === 'survival' ? '生存赛剩最后一人获胜，超过约定章数后每战递增扣血，同时出局可并列。' :
          v ? '这桌沿用开局时的积分规则，零血停一战。' : ''),
      ) +
      ((!v || v.interactionVersion) ? paragraph('每战头名、末名各发起一次互动，三张里两明一暗。头名偏向公平挑战，末名更容易抽到补给。所有人锁定后同时亮出选择。' + (scoreOnly ? '互动另奖积分或银筹。' : '生存桌先做两次互动，再选人攻击。通用牌每人每次所得奖分按 10 分换 1 银，零头再换 1 银。')) : '') +
      paragraph(matchSummary(v?.settings) + decisionSummary(v?.settings) + '全员提前锁定就直接开标。') +
      (v?.settings.matchMinutes ? paragraph(scoreOnly ? '整桌到点时，打完当前一战再按总分排名。' : v.settings.mode === 'survival' ?
        '到点打完当前一战，存活席先比生命再比总分，相同则并列。' : '到点打完当前一战，先比总分再比生命，相同则并列。') : '') +
      paragraph(
        (version >= 2
          ? '只把亮起的牌算入点数。先加牌型底分，再乘该牌型的倍率。'
          : '这桌沿用开局时的牌型顺位 × 100，加参与点数。') +
          (v && !scoreOnly ? '每点实伤最多扣 ' + damagePenalty(version) + ' 积分。' : ''),
      );
  if (tab === 'hands')
    body = table(
      ['牌型', '底分', ...(version >= 2 ? ['倍率'] : []), ...(scoreOnly ? [] : ['伤害'])],
      handTypes.map((n, i) => [
        n,
        ...(version >= 2 ? [handScores[i][0], '×' + handScores[i][1]] : [(i + 1) * 100]),
        ...(scoreOnly ? [] : [damageByHand[i]]),
      ]),
    ) + paragraph(version >= 2 ? '手分＝（底分＋成牌点数）×倍率。' : '手分＝底分＋成牌点数。');
  if (tab === 'items')
    body =
      '<div class="bookFilters"><input type="search" id="itemSearch" aria-label="搜名称或效果" placeholder="搜名称或效果"><select id="itemKind" aria-label="物品类型"><option value="">全部</option><option value="relic">持续能力</option><option value="tool">一次性道具</option><option value="auction">竞拍相关</option><option value="extra">原创扩展</option></select></div><p id="emptyBook" hidden>没有匹配的物品。</p>' +
      Object.values(items)
        .filter((x) => stockFor(x) <= pool && (!scoreOnly || worksInPointsMatch(x)) && (!v || v.settings.expansion || !x.extra))
        .map(
          (x) =>
            '<div class="itemLine" data-book-id="' +
            x.id +
            '">' +
            gem(x.id) +
            '<div><strong>' +
            esc(x.name) +
            '</strong> <small>' +
            ['', 'Ⅰ', 'Ⅱ', 'Ⅲ'][x.tier] +
            ' · ' +
            x.category +
            (x.extra ? ' · 原创' : '') +
            '</small><p>' +
            esc(itemDescription(x.id, version, scoreOnly)) +
            '</p></div></div>',
        )
        .join('');
  if (tab === 'events') {
    body = v && !v.interactionVersion ? paragraph('这张旧桌沿用开局规则。新开的积分桌和生存桌都有战后互动。') :
      paragraph('本手头名与末名各选一次，两张明牌、一张暗牌。头名每张有八成概率抽到公平玩法，末名每张有八成概率抽到翻身玩法。') +
      (!scoreOnly ? paragraph('生存桌上，通用牌每人每次所得奖分按 10 分换 1 银，余数再换 1 银。攻、盾各最多 2 点。') : '') +
      Object.values(eventCards).filter(c=>!scoreOnly || !c.survival).map(c=>
        '<div class="itemLine"><span aria-hidden="true">'+esc(c.mark)+'</span><div><strong>'+esc(c.name)+'</strong><small> · '+
        (c.survival?'生存 / ':'')+(c.family==='fair'?'公平':'翻身')+'</small><p>'+esc(c.rules)+'</p></div></div>').join('');
  }
  if (tab === 'goals') {
    const a = await career();
    body =
      paragraph(
        '已完成 ' +
          a.count +
          ' 场　·　解锁 ' +
          goals.filter((g) => a.flags[g.id]).length +
          ' / ' +
          goals.length,
      ) +
      goals
        .map(
          (g) =>
            '<div class="itemLine"><span>' +
            (a.flags[g.id] ? '✦' : '◇') +
            '</span><div><b>' +
            esc(g.name) +
            '</b><p>' +
            esc(g.desc) +
            '</p></div></div>',
        )
        .join('');
  }
  if (tab === 'history')
    body = v?.log?.length
      ? [...v.log].reverse().map(paragraph).join('')
      : paragraph('入席后，这里会记下公开的竞拍和每战结果。');
  if (ticket !== revision) return;
  container.innerHTML = body;
  container.scrollTop = scroll;
  if (tab === 'items') {
    const search = document.getElementById('itemSearch'),
      kind = document.getElementById('itemKind');
    const rows = document.querySelectorAll('[data-book-id]');
    const filter = () => {
      const query = search.value.trim();
      let count = 0;
      for (const row of rows) {
        const item = items[row.dataset.bookId];
        const match =
          (!kind.value || (kind.value === 'auction' ? ['auction','auctionAuto'].includes(item.aim) || item.id === 'ledger' : kind.value === 'extra' ? item.extra : item.kind === kind.value)) &&
          (item.name.includes(query) || itemDescription(item.id, version, scoreOnly).includes(query));
        row.hidden = !match;
        if (match) count++;
      }
      document.getElementById('emptyBook').hidden = count !== 0;
    };
    search.oninput = kind.onchange = filter;
  }
}
export function auctionBill(v, target) {
  const a = v.award || v.lastAward;
  if (!a) return;
  const who = (id) => v.players.find((x) => x.id === id)?.name;
  const card = (id) => (id ? cardName({ rank: +id.slice(1), suit: id[0] }) : '—');
  showDetail(target,
    '开标明细',
    table(
      ['席位', '报价', '得牌'],
      a.entries.map((b) => {
        const r = a.received.find((r) => r.id === b.id);
        return [
          who(b.id),
          b.kind === 'bid'
            ? card(b.card) + ' · ' + b.gold + '金 ' + b.silver + '银'
            : b.kind === 'blind'
              ? '抽牌 · 牌库 · 2银'
              : '跳过 · 桌上剩牌',
          r?.blind ? '暗牌' : card(r?.card),
        ];
      }),
    ) +
      a.lots
        .filter((x) => x.rolls.length)
        .map((x) =>
          paragraph(
            card(x.card) +
              ' · ' +
              x.rolls
                .map((r) => r.map((d) => who(d.id) + ' ' + d.die + ' 点').join('、'))
                .join(' → '),
          ),
        )
        .join('') +
      a.rewards.map((x) => paragraph(who(x.id) + ' · ' + x.text)).join(''),
  );
}
export function battleBill(v, target) {
  const rows = v.showdown.length ? v.showdown : v.lastBattle?.showdown || [];
  const rounds = v.interaction?.results || (v.settledEvents?.length ? v.settledEvents : null) || (v.lastBattle && (!v.showdown.length || v.lastBattle.battle === v.battle) ? v.lastBattle.events : []) || [];
  showDetail(target,
    '揭牌明细',
    rows
      .map(
        (x) =>
          '<div class="itemLine"><div><strong>' +
          esc(v.players.find((p) => p.id === x.id)?.name) +
          ' · ' +
          x.label +
          ' · ' +
          x.points +
          ' 分</strong><p>主手 ' +
          x.main.map(cardName).join('　') +
          (v.scoreOnly ? '</p><p>亮牌时总分 ' + x.previousTotal + ' + ' + x.points + ' = ' + x.total +
            ' · ' + (x.sharedRank ? '并列' : '') + '第 ' + x.overallRank : '</p><p>备牌 ' +
          ([...x.backup.map(cardName), ...(x.hiddenGuard ? ['暗扣牌'] : [])].join('　') || '无') +
          ' · ' +
          (x.boosts?.includes('barrier')
            ? '护盾挡全部伤害'
            : '抵 ' + (x.block.pair + x.block.pin) + ' 伤')) +
          '</p><p>' +
          esc(x.lines.map(([k, n]) => k + ' ' + n).join('　')) +
          (x.adrenaline ? '</p><p>肾上腺素 · 下次出手多 1 伤' : '') +
          (x.boosts?.length
            ? '</p><p>本战道具　' + esc(x.boosts.map((id) => items['once-' + id].name).join('、'))
            : '') +
          '</p></div></div>',
      )
      .join('') + rounds.map(r=>'<h3>'+esc(eventCards[r.event].name)+'</h3>'+resultDetails(v,r)).join(''),
  );
}
