export const suits = ['s', 'h', 'c', 'd'];
export const suitMark = { s: '♠', h: '♥', c: '♣', d: '♦' };
export const rankMark = (n) => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[n] ?? String(n);
export const cardName = (c) => rankMark(c.rank) + suitMark[c.suit];
export const handTypes = [
  '高牌',
  '一对',
  '两对',
  '三条',
  '顺子',
  '同花',
  '葫芦',
  '四条',
  '同花顺',
  '皇家同花顺',
  '五条',
];
export const damageByHand = [1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 5];
// Rows of the in-game score card, in the same order as handTypes.
export const scoringVersion = 2;
export const handScores = [
  [10, 2],
  [18, 3],
  [18, 5],
  [30, 10],
  [40, 12],
  [63, 15],
  [80, 20],
  [91, 30],
  [100, 40],
  [100, 50],
  [150, 50],
];
export const damagePenalty = (version) => (version >= 2 ? 200 : 100);

export const arenas = [
  {
    key: 'canyon',
    name: '赤金沙谷',
    motto: '砂岩 · 日照',
    felt: '#d4a17a',
    rim: '#a86d4b',
    stone: '#b97056',
    deep: '#694246',
    sky: '#b98976',
    light: '#ffe2a7',
    plant: '#476d59',
  },
  {
    key: 'ruins',
    name: '月泉古庭',
    motto: '青砖 · 月光',
    felt: '#9ebbb0',
    rim: '#597d78',
    stone: '#577c85',
    deep: '#253f50',
    sky: '#617f91',
    light: '#e5ddad',
    plant: '#43665b',
  },
  {
    key: 'forge',
    name: '余烬铸厅',
    motto: '黑曜石 · 熔金',
    felt: '#a88a86',
    rim: '#645260',
    stone: '#584555',
    deep: '#342634',
    sky: '#815659',
    light: '#ffd18a',
    plant: '#af6b44',
  },
];
export const cast = [
  ['ranger', '荆棘游侠', 'Rogue', '#67ae90', '✦', '争牌'],
  ['witch', '灯塔占星师', 'Mage', '#7aaec9', '✷', '构筑'],
  ['guard', '鎏金盾卫', 'Knight', '#e6b663', '⬟', '稳健'],
  ['raider', '红峡角斗士', 'Barbarian', '#dc8b6d', '◆', '争牌'],
  ['shade', '雾巷客', 'Rogue_Hooded', '#a597ca', '☾', '稳健'],
  ['ember', '烬骨术士', 'Skeleton_Mage', '#cd84a8', '✹', '构筑'],
  ['warden', '白瓷守卫', 'Skeleton_Warrior', '#99b5c4', '♜', '稳健'],
  ['scout', '夜市斥候', 'Skeleton_Rogue', '#bab36c', '♧', '争牌'],
  ['porter', '拾星小骨', 'Skeleton_Minion', '#8ab3cc', '✧', '构筑'],
  ['solar', '黄铜司仪', null, '#ebbd71', '☀', '稳健'],
].map(([id, name, model, color, mark, style]) => ({ id, name, model, color, mark, style }));

// Active effects specify their aiming interface. Automatic effects resolve in their named window.
const entries = [
  ['dealer', '庄家补贴', 1, 'relic', 'income', '¤', '每战开始多领 3 银。'],
  ['gap', '缺口顺子', 1, 'relic', 'score', '⋯', '顺子允许一个空缺点数。'],
  ['glass', '玻璃大炮', 1, 'relic', 'combat', '✴', '打人多 2 伤，挨打也多受 1 伤。'],
  ['loop', '首尾相连', 1, 'relic', 'score', '∞', '顺子可以跨过 A 接到 2。'],
  ['fist', '铁拳', 1, 'relic', 'combat', '✊', '每次攻击多 1 伤。'],
  ['recycle1', '换牌Ⅰ', 1, 'relic', 'one', '↻', '每战可弃一张摸一张，共两次。'],
  ['life', '再活一次', 1, 'relic', 'combat', '♥', '第一次受到致命伤害时消耗，回满生命。'],
  ['rebate', '返还金筹', 1, 'relic', 'income', '◉', '获得时和之后每段开始时各领 1 金。'],
  ['bucket', '计分桶', 1, 'relic', 'score', '▥', '每次揭牌固定加 500 分。'],
  ['chameleon', '变色龙', 1, 'relic', 'sample', '◐', '每战一次，将一张牌变为另一张手牌的花色。'],
  ['mirror', '镜面双对', 1, 'relic', 'score', '◫', '两对按同花档计分，保留原有伤害。'],
  [
    'charm',
    '生命护符',
    1,
    'relic',
    'income',
    '♡',
    '获得时和之后每段开始时增加 1 点生命上限并回复 1 点。',
  ],
  ['black', '黑色移花', 1, 'relic', 'black', '♣', '每战一次，把一张牌变为黑桃或梅花。'],
  ['red', '红色移花', 1, 'relic', 'red', '♦', '每战一次，把一张牌变为红桃或方块。'],
  ['pick', '顺手取筹', 1, 'relic', 'combat', '◈', '打中后取走最多 3 银，击倒时最多 5 银。'],
  ['ace', '王牌加分', 2, 'relic', 'score', 'A', '参与计分的 A 点数按六倍算。'],
  ['darkFusion', '黑色融合', 2, 'relic', 'score', '♠', '黑桃与梅花可以共同组成同花。'],
  ['even', '偶数图腾', 2, 'relic', 'score', 'Ⅱ', '参与计分的偶数牌点数按四倍算。'],
  ['morph', '易容', 2, 'relic', 'face', '♛', '每战一次，把一张 J、Q 或 K 换成另一种人头。'],
  ['odd', '奇数图腾', 2, 'relic', 'score', 'Ⅲ', '参与计分的 3、5、7、9 点数按五倍算。'],
  ['prism', '四色棱镜', 2, 'relic', 'score', '◇', '主手的计分牌集齐四种真实花色，总分翻倍。'],
  ['recycle2', '换牌Ⅱ', 2, 'relic', 'one', '↻', '每战最多弃一摸一三次。'],
  ['redFusion', '红色融合', 2, 'relic', 'score', '♥', '红桃与方块可以共同组成同花。'],
  ['royal', '宫廷徽记', 2, 'relic', 'score', '♔', '参与计分的 J、Q、K 点数按四倍算。'],
  [
    'underdog',
    '小牌当家',
    2,
    'relic',
    'score',
    '⚑',
    '提交的主手都在 2～10 时，计分牌点数按三倍算。',
  ],
  ['hunter', '人头猎手', 2, 'relic', 'number', '⌖', '每战一次，把一张人头变为指定的 2～10。'],
  ['recycle3', '换牌Ⅲ', 3, 'relic', 'one', '↻', '每战最多弃一摸一四次。'],
  ['walker', '换形者', 3, 'relic', 'toFace', '♙', '每战一次，把一张 2～10 变为 J、Q 或 K。'],
  ['straightBoost', '顺子强化', 3, 'relic', 'score', '↗', '顺子按同花顺档计分，保留原有伤害。'],
  ['tweak', '微调', 3, 'relic', 'step', '±', '每战一次，将一张牌升或降一点。'],
  ['trinity', '三连', 3, 'relic', 'score', '△', '三张连续点数即可成顺，也能和同花组合。'],
  [
    'duplicate',
    '复写',
    3,
    'relic',
    'one',
    '▣',
    '每战一次，复制一张手牌加入手中。复制品计分后消散。',
  ],
  ['makeAce', '造 A', 3, 'relic', 'one', 'A', '每战一次，把一张手牌变成两张同花色的 A。'],
  ['clone', '克隆', 2, 'tool', 'tool', '◧', '复制身上一件其他一次性道具。不能复制克隆本身。'],
  ['heal', '活力', 1, 'tool', 'self', '✚', '组牌时使用，回复 1 点生命，最多回复到上限。'],
  ['mask', '易容面具', 2, 'tool', 'face', '♕', '将一张 J、Q 或 K 改为另一种人头，用后消耗。'],
  [
    'tail',
    '尾标券',
    1,
    'tool',
    'auction',
    '⌁',
    '纯银标仅少 1 银、输给唯一最高报价时，退最多 2 银。',
  ],
  ['reserve', '留座牌', 1, 'tool', 'auction', '⚐', '过牌时预约一张明牌。无人竞得时优先领取。'],
  ['peek', '摸二留一', 2, 'tool', 'auction', '◉', '花 2 银盲抽时，可看两张，选择一张带走。'],
  [
    'escrow',
    '压住筹码',
    1,
    'relic',
    'auctionAuto',
    '▤',
    '每战首次主动过牌，存 2 银供下一批出价。未用退回。',
  ],
  [
    'ledger',
    '偏门账本',
    2,
    'relic',
    'growth',
    '▦',
    '每战首次用 1 银独占明牌可存一个记号。选物时翻账本，多看一件同级物品，与公共物品择一。',
  ],
  ['insure', '赌注保险', 2, 'tool', 'auction', '▱', '给金标上保险，输掉至少 1 金时获赔 3 银。'],
  ['ruler', '转角尺', 1, 'tool', 'pair', '∠', '选择两张相邻点数且不同花色的牌，交换花色。'],
  ['needle', '缝牌针', 2, 'tool', 'pair', '⋈', '选择一对同点牌，第一张升一点，第二张降一点。'],
  ['guardPin', '暗扣', 2, 'relic', 'defend', '▰', '将一张 8 或更大的手牌扣作防守，抵 1 伤。'],
  ['echo', '回声扣', 1, 'tool', 'self', '◎', '若你本战的攻击被完全挡下，获得 2 银。'],
  [
    'lastStand',
    '背水徽',
    3,
    'relic',
    'vow',
    '⚡',
    '组牌时余 1 血可放弃备牌防守，基础牌分增加四分之一。',
  ],
  [
    'lantern',
    '传灯契',
    2,
    'tool',
    'growth',
    '☼',
    '共享选物时向后一位，得 3 银。每席每次选物最多参与一次。',
  ],
];
const tricks = new Set([
  'hunter',
  'duplicate',
  'makeAce',
  'trinity',
  'pick',
  'red',
  'black',
  'straightBoost',
  'morph',
  'tweak',
  'chameleon',
  'walker',
  'recycle1',
  'recycle2',
  'recycle3',
]);
export const items = Object.fromEntries(
  entries.map(([id, name, tier, kind, aim, glyph, desc], index) => [
    id,
    {
      id,
      name,
      tier,
      kind,
      aim,
      glyph,
      desc,
      category: kind === 'tool' ? '道具' : tricks.has(id) ? '手法' : '遗物',
      extra: index >= 36,
    },
  ]),
);

// A hand trick uses the same rule as its lasting counterpart. The inventory ID
// stays distinct so spending a card never spends or refreshes a permanent use.
const handTricks = [
  ['recycle1', '换牌券', '弃一张手牌，摸一张新牌。'],
  ['chameleon', '借色', '把一张手牌改成另一张手牌的花色。'],
  ['black', '黑墨', '把一张手牌改成黑桃或梅花。'],
  ['red', '朱墨', '把一张手牌改成红桃或方块。'],
  ['hunter', '摘面', '把一张人头牌改成 2～10。'],
  ['walker', '加冕', '把一张 2～10 改成 J、Q 或 K。'],
  ['tweak', '微调片', '把一张手牌升或降一点。'],
  ['duplicate', '复写纸', '复制一张手牌，复制品留到本战结束。'],
  ['makeAce', '王牌印', '把一张手牌变成两张同花色的 A。'],
];
const battleTricks = [
  ['gap', '接桥', '顺子允许缺一个点数。'],
  ['loop', '首尾环', '顺子能从 A 接到 2。'],
  ['mirror', '镜面票', '两对按同花档计分。'],
  ['darkFusion', '双黑印', '黑桃与梅花可以共同组成同花。'],
  ['redFusion', '双红印', '红桃与方块可以共同组成同花。'],
  ['trinity', '三连签', '三张连续的牌可以成顺。'],
  ['straightBoost', '飞顺', '顺子按同花顺档计分。'],
  ['bucket', '满桶', '亮牌得分加 500。'],
  ['fist', '拳套', '攻击多造成 1 伤。'],
  ['glass', '碎晶', '攻击多造成 2 伤，自己受击也多受 1 伤。'],
  ['prism', '折光片', '计分牌集齐四种花色，整手分数翻倍。'],
  ['ace', '狙击镜', '计分的 A 点数按六倍算。'],
  ['royal', '王室印', '计分的人头牌点数按四倍算。'],
  ['odd', '单数符', '计分的 3、5、7、9 点数按五倍算。'],
  ['even', '双数符', '计分的偶数牌点数按四倍算。'],
  ['underdog', '小牌令', '主手都在 10 以下（含 10）时，牌点按三倍算。'],
  ['pick', '妙手', '攻击命中取走最多 3 银，击倒取最多 5 银。'],
  ['life', '续命符', '第一次受到致命伤时回满生命。'],
];
for (const [duration, list] of [
  ['action', handTricks],
  ['battle', battleTricks],
]) {
  for (const [effect, name, description] of list) {
    const original = items[effect];
    const id = 'once-' + effect;
    items[id] = {
      id,
      name,
      effect,
      duration,
      icon: effect,
      tier: original.tier,
      kind: 'tool',
      category: '一次性手法',
      extra: false,
      aim: duration === 'battle' ? 'self' : original.aim,
      glyph: original.glyph,
      desc: (duration === 'battle' ? '仅本战有效。' : '') + description,
    };
  }
}
for (const [id, name, silver, tier] of [
  ['pouch2', '袖袋', 2, 1],
  ['pouch3', '零钱袋', 3, 1],
  ['pouch5', '小钱袋', 5, 1],
  ['pouch8', '中钱袋', 8, 2],
  ['pouch10', '大钱袋', 10, 2],
]) {
  items[id] = {
    id,
    name,
    silver,
    tier,
    kind: 'tool',
    category: '即时奖励',
    aim: 'receive',
    icon: 'pouch',
    glyph: '◉',
    desc: '选中立即获得 ' + silver + ' 银筹。',
    extra: false,
    pool: 3,
  };
}
items['once-scoreBoost'] = {
  id: 'once-scoreBoost',
  name: '分数增幅Ⅰ',
  effect: 'scoreBoost',
  duration: 'battle',
  tier: 2,
  kind: 'tool',
  category: '计分道具',
  aim: 'self',
  icon: 'scoreBoost',
  glyph: '×',
  desc: '这次亮牌的总分乘 1.5，牌型伤害照常结算。',
  extra: false,
  pool: 3,
};
items.adrenaline = {
  id: 'adrenaline',
  name: '肾上腺素',
  tier: 1,
  kind: 'tool',
  category: '攻防道具',
  aim: 'self',
  glyph: '⚔',
  desc: '发动后，下次获得出手机会时多打 1 伤。跨战保留。',
  extra: false,
  pool: 3,
};
items['once-barrier'] = {
  id: 'once-barrier',
  name: '临时护盾',
  effect: 'barrier',
  duration: 'battle',
  tier: 2,
  kind: 'tool',
  category: '攻防道具',
  aim: 'self',
  icon: 'barrier',
  glyph: '⬡',
  desc: '挡下本战受到的全部伤害。亮牌得分照常计算。',
  extra: false,
  pool: 3,
};
items.shifter = {
  id: 'shifter',
  name: '换花',
  tier: 2,
  kind: 'tool',
  category: '改牌道具',
  aim: 'suit',
  glyph: '♧',
  desc: '将一张手牌改成你选的另一种花色，用后消耗。',
  extra: false,
  pool: 3,
};
items.goldenCoin = {
  id: 'goldenCoin',
  name: '金筹',
  tier: 2,
  kind: 'tool',
  category: '即时奖励',
  aim: 'receive',
  gold: 1,
  icon: 'goldenCoin',
  glyph: '◉',
  desc: '获得 1 金筹，可在任一批竞拍时使用。报价先比金筹，再比银筹。',
  extra: false,
  pool: 3,
};
export const stockFor = (item) => item.pool || (item.duration ? 2 : 1);
const survivalEffects = new Set(['glass','fist','life','charm','pick','heal','guardPin','echo','lastStand','adrenaline','barrier']);
export const worksInPointsMatch = (item) => !survivalEffects.has(item.effect || item.id);
export function itemDescription(id, version = scoringVersion, scoreOnly = false) {
  if (scoreOnly) {
    if (id === 'mirror') return '两对按同花档计分。';
    if (id === 'straightBoost') return '顺子按同花顺档计分。';
    if (id === 'once-scoreBoost') return '本战主手得分乘 1.5。';
  }
  if (version < 2) {
    if (id === 'heal') return '组牌时使用，回复 2 点生命，最多回复到上限。';
    if (id === 'makeAce' || id === 'once-makeAce') return '把一张非 A 手牌改成 A。';
  }
  return items[id].desc;
}
export const activeAims = new Set([
  'one',
  'sample',
  'black',
  'red',
  'face',
  'number',
  'toFace',
  'step',
  'pair',
  'defend',
  'vow',
  'tool',
  'self',
  'suit',
]);
export const goals = [
  ['bid', '竞拍得手', '赢下第一次有人争的竞拍。'],
  ['slap', '先声夺人', '完成一次有实伤的攻击。'],
  ['finish1', '初临牌会', '打完第一场。'],
  ...[
    [1, '一对'],
    [2, '两对'],
    [3, '三条'],
    [4, '顺子'],
    [5, '同花'],
    [6, '葫芦'],
    [7, '四条'],
    [8, '同花顺'],
    [9, '皇家同花顺'],
    [10, '五条'],
  ].map(([n, name]) => ['hand' + n, name, '揭开一次' + name + '。']),
  ['last', '谷底回音', '完成一场并排在末位。'],
  ['six', '六席魁首', '赢下六席满桌对局。'],
  ['all', '牌谱齐全', '打出全部十一档牌型。'],
  ['finish10', '常客', '完成十场。'],
  ['tour', '三城巡游', '在三座场地各赢一场。'],
  ['finish50', '再来一手', '完成五十场。'],
  ['tiebreak', '命运掷手', '通过同标掷骰赢下竞拍。'],
  ['reservedWin', '空座藏星', '预约到的明牌进入本战获胜主手。'],
  ['shieldWin', '最后一灯', '用暗扣挡住致命一击后赢得整场。'],
].map(([id, name, desc]) => ({ id, name, desc }));
