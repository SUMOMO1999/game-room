// Both hosts draw from this catalog. The family changes the odds, never the rules.
const fair = [
  [
    'rps',
    '猜拳擂台',
    '✊',
    'duel',
    'rps',
    '点一人同时猜拳。胜者得 20 分，平手各得 10 分。',
  ],
  [
    'colorBluff',
    '猜红黑',
    '♥',
    'duel',
    'color',
    '你暗藏红或黑，对手猜颜色。猜中对手得 20 分，猜错你得 20 分。',
  ],
  [
    'oddEven',
    '单双开骰',
    '⚄',
    'all',
    'parity',
    '每人押单或双，再掷一颗骰子。猜中的人各得 15 分。',
  ],
  [
    'highLow',
    '开大开小',
    '♠',
    'all',
    'size',
    '各押大或小，桌上翻一个随机点数。9～A 为大，2～7 为小，猜中得 18 分。翻到 8，全桌各得 8 分。',
  ],
  [
    'harmony',
    '默契暗号',
    '✧',
    'duel',
    'signal',
    '点一人，双方暗选星、月或太阳。选中同一图案各得 20 分，不同各得 4 分。',
  ],
  [
    'split',
    '分还是抢',
    '◈',
    'duel',
    'split',
    '双方暗选分或抢。都分各得 15 分，只有一人抢则拿走 24 分，都抢就都落空。',
  ],
  [
    'minority',
    '少数派',
    '◐',
    'all',
    'side',
    '全桌暗选左或右。人数较少且有人的一边各得 18 分，两边一样多各得 8 分，一边倒各得 3 分。',
  ],
  [
    'majority',
    '找同伴',
    '♧',
    'all',
    'signal',
    '暗选三个图案中一个。人最多的一组各得 12 分。最多人数并列时，领先的组各得 6 分。',
  ],
  [
    'singleSuit',
    '独门花色',
    '♣',
    'all',
    'suit',
    '每人暗选一种花色。全桌只有你选时得 18 分，撞色得 2 分。',
  ],
  [
    'uniqueHigh',
    '独报高数',
    'Ⅲ',
    'all',
    'number',
    '每人暗报 1、2 或 3。只出现一次的最高数字独得 24 分。没有独报数字时全桌各得 4 分。',
  ],
  [
    'twoPots',
    '银盆与分盆',
    '◉',
    'all',
    'pot',
    '各选一个盆。银盆 6 银、分盆 30 分，同盆的人平分，零头留在桌上。',
  ],
  [
    'prizeBid',
    '封标夺奖',
    '♦',
    'all',
    'bid',
    '每人暗押 0～3 银。最高非零报价者支付自己的报价，平分 30 分，零头留在桌上。其余人免付。',
  ],
  [
    'diceDuel',
    '双骰对碰',
    '⚅',
    'give',
    null,
    '点一人，各掷两颗骰子。点数和较高者得 20 分，平手各得 10 分。',
  ],
  [
    'relay',
    '邻座接龙',
    '↔',
    'all',
    'color',
    '同时选红或黑。与你颜色不同的相邻席，每席为你带来 6 分。两人桌只算对方一次。',
  ],
  [
    'bouquet',
    '悄悄递花',
    '❀',
    'all',
    'friend',
    '每人暗送一位朋友一朵花，每朵值 6 分。两人互送时，双方再各得 8 分。',
  ],
  [
    'closeSeven',
    '七点擂台',
    '7',
    'duel',
    'hand',
    '双方从本战主手各暗选一个点数，离 7 更近者得 20 分，平手各得 10 分。A 按 14 算。',
  ],
];
const comeback = [
  [
    'levy',
    '顺走散银',
    '◉',
    'instant',
    null,
    '从其余每席各取最多 1 银。你得 5 分，每收到 1 银再加 3 分。空钱包免付。',
  ],
  [
    'richPurse',
    '向富户借银',
    '◆',
    'give',
    null,
    '点一人。从比你银筹多的朋友处取最多 3 银，否则最多取 1 银。你另得 10 分。',
  ],
  [
    'safety',
    '稳收或搏一把',
    '⚂',
    'host',
    'risk',
    '选稳收得 12 分、1 银。选搏一把掷骰，3～6 点得 28 分，1～2 点得 4 分。',
  ],
  [
    'draftLeader',
    '追分搭档',
    '↑',
    'give',
    null,
    '点一位当前总分比你高的朋友，你得 20 分，否则得 8 分。搭档得 5 分。',
  ],
  [
    'patron',
    '朋友请客',
    '☕',
    'guest',
    'patron',
    '你得 14 分。被点的朋友选领 8 分或 2 银。对方选分，你另得 1 银；对方选银，你另得 6 分。',
  ],
  [
    'cushion',
    '轻装返现',
    '☘',
    'instant',
    null,
    '你得 8 分，本战主手比五张每少用一张再加 4 分。其余牌友各得 2 分。',
  ],
  [
    'reliefVote',
    '众人搭把手',
    '✋',
    'others',
    'relief',
    '其余每席可送你 1 银并从桌上得 6 分，也可给你送 4 奖分并自得 2 分。空钱包可以送分。',
  ],
  [
    'borrowSuit',
    '借花献分',
    '♢',
    'give',
    null,
    '点一人，看对方本战主手中数量最多的花色。你得 4 分，该花色每张再加 5 分。牌主得 4 分。',
  ],
  [
    'royalTea',
    '人头像赏',
    '♛',
    'host',
    'color',
    '选红或黑。全桌主手中该色的 J、Q、K 每张为你加 3 分，最多计 8 张。你另得 4 分，每位有贡献的牌友另得 3 分。',
  ],
  [
    'smallSteps',
    '小牌也值钱',
    '2',
    'all',
    'hand',
    '每人从自己的主手暗报一个点数。点数最低的各得 12 分，你另得 8 分。A 按 14 算。',
  ],
  [
    'makeTen',
    '凑十搭档',
    '10',
    'duel',
    'hand',
    '各暗选一个主手点数，A 按 1 算。两数和不超过 10，你得两倍点数，对方得 6 分。超过则你得 6 分，对方得 2 分。',
  ],
  [
    'blindBag',
    '三只福袋',
    '▣',
    'host',
    'bag',
    '三个福袋装着「6 分和 3 银」「16 分和 1 银」「28 分」。洗匀后挑一个打开。',
  ],
  [
    'doubleTicket',
    '双签抽奖',
    '✦',
    'instant',
    null,
    '每席放入一张签，你多放一张。抽中者得 24 分，你另得 6 分。',
  ],
  [
    'secondDie',
    '下一骰',
    '⚁',
    'host',
    'forecast',
    '先看第一颗骰子，再猜下一颗更大或更小。猜中得 24 分，同点得 14 分，猜错得 4 分。也可收手拿 10 分。',
  ],
  [
    'redEnvelope',
    '怎么分红包',
    '▤',
    'host',
    'envelope',
    '选「全桌一起领」让每席得 6 分，你另得 12 分。选「自己多领」你得 22 分，其余当前总分最低席各得 6 分。',
  ],
  [
    'receipts',
    '落标返现',
    '♧',
    'instant',
    null,
    '最后一批出价落空的人各领回 1 银。你先得 10 分，每有一人领到返现，你再得 3 分。',
  ],
];
const survivalFair = [
  [
    'warDrum',
    '战鼓猜拳',
    '⚔',
    'duel',
    'rps',
    '双方猜拳，胜者下次攻击加 1。平手各得 1 银。',
  ],
  [
    'shieldDice',
    '盾牌对碰',
    '⬡',
    'give',
    null,
    '点一人各掷两骰。较高者获得 1 点护盾，平手双方各得 1 银。',
  ],
  [
    'colorGuard',
    '红黑守阵',
    '◐',
    'all',
    'color',
    '各猜红或黑，再翻一张牌。猜对的每席获得 1 点护盾。',
  ],
  [
    'banner',
    '旗手号令',
    '⚑',
    'duel',
    'stance',
    '双方暗选战鼓或盾牌。选得相同，两人下次攻击各加 1；不同则各得 1 点护盾。',
  ],
  [
    'camp',
    '营地互助',
    '✚',
    'duel',
    'split',
    '双方都选分，各回 1 血。只有一人抢，抢的人得 2 银。双方都抢就都落空。',
  ],
  [
    'shieldBid',
    '战地拍卖',
    '◆',
    'all',
    'bid',
    '各押 0～3 银。最高非零报价者各支付自己的出价，获得 1 点护盾。',
  ],
  [
    'ambush',
    '奇袭口令',
    '⚡',
    'duel',
    'color',
    '你藏一种颜色，由对手猜。猜中对手得 1 攻、1 银，猜错你得这份奖励。',
  ],
  [
    'sevenGuard',
    '七点守备',
    '7',
    'duel',
    'hand',
    '双方暗选一个主手点数。更接近 7 的人获 1 点护盾，平手各得 1 银。A 算 14。',
  ],
];
const survivalComeback = [
  [
    'bandage',
    '救急绷带',
    '✚',
    'instant',
    null,
    '回复 1 血。包扎前只剩 1～2 血时，还获得 1 点护盾。',
  ],
  [
    'ward',
    '应急结界',
    '⬡',
    'instant',
    null,
    '获得 2 点护盾。护盾最多为 2，抵掉几点实伤就消耗几点。',
  ],
  [
    'supply',
    '军需分装',
    '▣',
    'host',
    'supply',
    '选领 3 银、1 攻与 1 银，或 1 点护盾与 1 银。',
  ],
  [
    'shareHeal',
    '传递药瓶',
    '✚',
    'give',
    null,
    '点一位朋友，你们各回 1 血，你另得 1 银。超过生命上限的治疗每点折 1 银。',
  ],
  [
    'underdog',
    '以弱制强',
    '↑',
    'give',
    null,
    '点一人。对方生命高于你时，你回 1 血并得 1 点护盾，否则你得 2 银。对方得 1 银。',
  ],
  [
    'healingDice',
    '骰面疗愈',
    '⚄',
    'instant',
    null,
    '你先得 1 点护盾，再掷两骰。任一颗达到 4 点便回 1 血，否则得 2 银。',
  ],
  [
    'riposte',
    '招架还是反攻',
    '⚔',
    'host',
    'stance',
    '选战鼓，下次攻击加 2；选盾牌，获得 2 点护盾。两项各自最多积 2 点。',
  ],
  [
    'lastSupply',
    '绝处补给',
    '✦',
    'instant',
    null,
    '你只剩 1～2 血时，回 1 血并得 1 点护盾。有 3 血以上时，得 2 银且下次攻击加 1。',
  ],
];
export const eventCards = Object.freeze(
  Object.fromEntries(
    [
      [fair, 'fair', false],
      [comeback, 'comeback', false],
      [survivalFair, 'fair', true],
      [survivalComeback, 'comeback', true],
    ].flatMap(([rows, family, survival]) =>
      rows.map(([id, name, mark, scope, input, rules]) => [
        id,
        Object.freeze({
          id,
          name,
          mark,
          scope,
          input,
          rules,
          family,
          survival,
        }),
      ]),
    ),
  ),
);
const staticOptions = {
  rps: [
    ['rock', '石头'],
    ['scissors', '剪刀'],
    ['paper', '布'],
  ],
  color: [
    ['red', '红'],
    ['black', '黑'],
  ],
  parity: [
    ['odd', '单'],
    ['even', '双'],
  ],
  size: [
    ['high', '大 · 9～A'],
    ['low', '小 · 2～7'],
  ],
  signal: [
    ['star', '星'],
    ['moon', '月'],
    ['sun', '太阳'],
  ],
  split: [
    ['share', '分'],
    ['grab', '抢'],
  ],
  side: [
    ['left', '左边'],
    ['right', '右边'],
  ],
  suit: [
    ['s', '♠ 黑桃'],
    ['h', '♥ 红桃'],
    ['d', '♦ 方片'],
    ['c', '♣ 梅花'],
  ],
  number: [
    ['1', '报 1'],
    ['2', '报 2'],
    ['3', '报 3'],
  ],
  pot: [
    ['silver', '银盆'],
    ['points', '分盆'],
  ],
  risk: [
    ['bank', '稳收'],
    ['roll', '搏一把'],
  ],
  patron: [
    ['points', '领 8 分'],
    ['silver', '领 2 银'],
  ],
  relief: [
    ['silver', '送 1 银'],
    ['cheer', '送 4 奖分'],
  ],
  bag: [
    ['0', '左边'],
    ['1', '中间'],
    ['2', '右边'],
  ],
  forecast: [
    ['up', '更大'],
    ['down', '更小'],
    ['bank', '收手得 10 分'],
  ],
  envelope: [
    ['all', '全桌一起领'],
    ['own', '自己多领'],
  ],
  stance: [
    ['drum', '战鼓'],
    ['shield', '盾牌'],
  ],
  supply: [
    ['silver', '3 银'],
    ['drum', '1 攻和 1 银'],
    ['shield', '1 盾和 1 银'],
  ],
};
export function answerOptions(g, id) {
  const x = g.interaction,
    input = eventCards[x.event]?.input;
  const p = g.players.find((seat) => seat.id === id);
  if (!p || !input) return [];
  let options;
  if (input === 'friend')
    options = g.players
      .filter((seat) => seat !== p && !seat.out && seat.sit !== g.battle)
      .map((seat) => [seat.id, seat.name]);
  else if (input === 'bid')
    options = Array.from({ length: Math.min(3, p.silver) + 1 }, (_, i) => [
      String(i),
      i + ' 银',
    ]);
  else if (input === 'hand') {
    const row = g.showdown.find((hand) => hand.id === id);
    options = [...new Set(row.main.map((card) => card.rank))]
      .sort((a, b) => a - b)
      .map((rank) => [
        String(rank),
        { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[rank] || String(rank),
      ]);
  } else options = staticOptions[input];
  return options
    .filter(
      ([value]) => !(input === 'relief' && value === 'silver' && !p.silver),
    )
    .map(([value, label]) => ({ value, label }));
}
