// Short labels for the table. The full rules stay available in the item and event bubbles.
import { items } from './rules/catalog.mjs';

const itemHints = {
  dealer: '每战开始 +3 银', gap: '顺子可缺一点', glass: '攻击 +2，受伤 +1',
  loop: '顺子可从 A 接 2', fist: '攻击 +1', life: '首次致命伤回满血',
  rebate: '领取及每新章 +1 金', bucket: '亮牌 +500 分', chameleon: '借另一张牌花色',
  mirror: '两对按同花计分', charm: '领取及新章加血和上限', black: '改成 ♠ 或 ♣',
  red: '改成 ♥ 或 ♦', pick: '击中偷银，击倒多偷', ace: 'A 点数 ×6',
  darkFusion: '♠ ♣ 可凑同花', even: '偶数点数 ×4', morph: '改为另一个人头点数',
  odd: '3、5、7、9 点数 ×5', prism: '计分牌齐四色 ×2',
  recycle1: '每战换牌 2 次', recycle2: '每战换牌 3 次', recycle3: '每战换牌 4 次',
  redFusion: '♥ ♦ 可凑同花', royal: '人头牌点数 ×4', underdog: '全是 2～10，牌点 ×3',
  hunter: '人头牌改为 2～10', walker: '2～10 改为人头牌', straightBoost: '顺子按同花顺计分',
  tweak: '牌点 +1 或 −1', trinity: '三连即可成顺', duplicate: '复制一张手牌',
  makeAce: '一张变两张同花色 A', clone: '复制另一件道具', mask: '换一张人头牌的点数',
  tail: '纯银标差 1 返银', reserve: '跳过时预约剩牌', peek: '花 2 银摸二留一',
  escrow: '首次跳过存 2 银', ledger: '独标 1 银解锁私选', insure: '金标落空赔 3 银',
  ruler: '相邻牌点互换花色', needle: '同点两牌各升降 1',
  guardPin: '扣住 8 以上抵 1 伤', echo: '攻击全被挡 +2 银',
  lastStand: '1 血弃防加基础分', lantern: '让后选一次 +3 银',
  scoreBoost: '本战总分 ×1.5', adrenaline: '下次攻击 +1',
  barrier: '挡下本战全部伤害', shifter: '任选另一种花色',
};
export function itemHint(id, version) {
  const item = items[id];
  if (item.aim === 'receive') return '立即 +' + (item.gold ? item.gold + ' 金' : item.silver + ' 银');
  const key = item.effect || id;
  if (key === 'heal') return '回复 ' + (version < 2 ? 2 : 1) + ' 血';
  if (key === 'makeAce' && version < 2) return '一张非 A 变为 A';
  if (id === 'once-recycle1') return '弃一张，摸一张';
  return itemHints[key] || item.desc;
}

// Braced numbers are a single participant's whole prize. Combined awards are
// described separately because survival rounds the sum once per participant.
const events = {
  rps: ['猜拳争{20}', '同时出拳。胜者得{20}，平手各得{10}。'],
  colorBluff: ['猜颜色争{20}', '一人藏色，一人猜。猜中，猜的人得{20}。猜错，藏的人得{20}。'],
  oddEven: ['押单双赢{15}', '押骰子单双，猜中各得{15}。'],
  highLow: ['押大小赢{18}', '2～7 小，9～A 大。猜中得{18}，翻到 8 全桌各得{8}。'],
  harmony: ['同图案各得{20}', '暗选图案。相同各得{20}，不同各得{4}。'],
  split: ['分奖或独抢', '都分各得{15}，独抢得{24}，都抢落空。'],
  minority: ['押少数赢{18}', '选左或右。少数方各得{18}，平分各得{8}，一边倒各得{3}。'],
  majority: ['同伴越多越好', '暗选图案。人数最多组各得{12}，并列领先各得{6}。'],
  singleSuit: ['独选花色得{18}', '暗选花色。独选得{18}，撞色得{2}。'],
  uniqueHigh: ['独报大数赢{24}', '暗报 1～3。唯一且最大的数得{24}，无人独报则各得{4}。'],
  twoPots: ['选盆平分', '银盆装 6 银，分盆装 30 奖分。同盆平分，舍去零头。'],
  prizeBid: ['封标分 30 奖分', '暗押 0～3 银。最高非零标付款，平分 30 奖分。'],
  diceDuel: ['比骰争{20}', '各掷两骰比总点。胜者得{20}，平手各得{10}。'],
  relay: ['邻座异色加奖', '选红或黑，每个不同色的邻座为你加 6 奖分。'],
  bouquet: ['送花互相加奖', '每朵花值 6 奖分，互送双方各再得 8 奖分。'],
  closeSeven: ['点数靠七赢{20}', '各出一个主手点数，A 算 14。靠近 7 得{20}，平手各得{10}。'],
  levy: ['每家收 1 银', '每家取最多 1 银。你得 5 奖分，每取 1 银再加 3 奖分。'],
  richPurse: ['向一人取银', '对方比你富，取最多 3 银，否则最多 1 银。你另得{10}。'],
  safety: ['稳收或掷骰', '稳收得{12}和 1 银。掷出 3～6 得{28}，1～2 得{4}。'],
  draftLeader: ['找高分搭档', '选总分比你高的人得{20}，否则得{8}。搭档得{5}。'],
  patron: ['请客分奖', '朋友选分得{8}，你得{14}和 1 银。朋友选银得 2 银，你得{20}。'],
  cushion: ['主手越短奖越多', '你得 8 奖分，主手比五张每少一张再加 4。其余人各得{2}。'],
  reliefVote: ['收朋友的援助', '送你 1 银的人得{6}。也可送你 4 奖分，自己得{2}。'],
  borrowSuit: ['借最多的花色', '看搭档主手最多的花色。你得 4 奖分，该色每张再加 5。搭档得{4}。'],
  royalTea: ['按人头牌领奖', '选红或黑。你得 4 奖分，全桌该色人头每张再加 3，最多八张。贡献者得{3}。'],
  smallSteps: ['比最小点数', '各报一个主手点数，A 算 14。最低者各得 12 奖分，你另得 8 奖分。'],
  makeTen: ['凑十得奖', 'A 算 1。两点相加不超 10，你得两倍点数的奖分，搭档得{6}。超出则分别得{6}、{2}。'],
  blindBag: ['三袋盲挑一袋', '三袋分别装{6}和 3 银、{16}和 1 银、{28}。洗匀后挑一袋。'],
  doubleTicket: ['多一张抽奖签', '全桌各一签，你多一签。抽中得 24 奖分，你另得 6 奖分。'],
  secondDie: ['看骰猜下一颗', '猜下一骰高低。中得{24}，同点得{14}，错得{4}。收手得{10}。'],
  redEnvelope: ['决定红包分法', '一起领，你得{18}，其余各得{6}。自己多领，你得{22}，其余最低分各得{6}。'],
  receipts: ['落标者返银', '上批落标者各返 1 银。你得 10 奖分，每返一人再加 3 奖分。'],
  warDrum: ['猜拳赢攻击', '猜拳胜者下次攻击 +1，平手各得 1 银。'],
  shieldDice: ['比骰赢护盾', '两骰总点较高得 1 盾，平手各得 1 银。'],
  colorGuard: ['猜色赢护盾', '各猜红黑。翻牌猜中，各得 1 盾。'],
  banner: ['同攻或同守', '各选鼓或盾。选得一样各加 1 攻，不同各得 1 盾。'],
  camp: ['合作回血', '都分各回 1 血，独抢得 2 银，都抢落空。'],
  shieldBid: ['出银争护盾', '暗押 0～3 银。最高非零标付款，各得 1 盾。'],
  ambush: ['猜色赢攻和银', '一人藏色，一人猜。猜中猜的人得 1 攻、1 银，猜错藏的人得。'],
  sevenGuard: ['点数靠七赢盾', '各出一个主手点数，A 算 14。靠近 7 得 1 盾，平手各得 1 银。'],
  bandage: ['回血补盾', '回 1 血。原有 1～2 血时再得 1 盾。'],
  ward: ['获得 2 盾', '获得 2 盾。每点盾抵 1 伤，最多留 2 盾。'],
  supply: ['选战术补给', '三选一。领 3 银，或领 1 银再加 1 攻或 1 盾。'],
  shareHeal: ['两人各回 1 血', '双方各回 1 血，你另得 1 银。溢出的治疗折银。'],
  underdog: ['找高血量对手', '对方血更多，你回 1 血、得 1 盾。否则你得 2 银。对方得 1 银。'],
  healingDice: ['先得盾再掷骰', '先得 1 盾。两骰中有 4～6 点就回 1 血，否则得 2 银。'],
  riposte: ['攻击或护盾 +2', '选战鼓加 2 攻，选盾牌加 2 盾。各自最多存 2 点。'],
  lastSupply: ['残血优先补给', '1～2 血时回 1 血、得 1 盾。3 血以上得 2 银、加 1 攻。'],
};
export function eventHint(card, scoreOnly, expanded = false) {
  const words = events[card.id]?.[expanded ? 1 : 0] || card.rules;
  const text = words.replace(/\{(\d+)\}/g, (_, n) => scoreOnly ? n + ' 分' : Math.ceil(n / 10) + ' 银');
  if (scoreOnly) return text.replaceAll('奖分', '分');
  return expanded && text.includes('奖分') ? text + ' 奖分合计，每满 10 换 1 银，余数换 1 银。' : text;
}
