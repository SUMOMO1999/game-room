import { CARDS, GOODS, createDeck, getCard, DIGITAL_RULE_VERSION } from '../content/definitions.mjs';

// Deliberately synthetic projections for Step 0. They are not engine states,
// saved matches, or a source from which to construct a production game.
export const DIGITAL_SCENES = Object.freeze([
  ['active', '经营主桌'], ['waiting', '准备室'], ['opponent', '对方回合'], ['spectator', '观战'],
  ['peek', '私看：留下或弃掉'], ['guard', '锦衣卫回应'], ['trader', '番商回应'],
  ['oracle', '卦师：六选一'], ['lamp', '两仪灯：留一给一'],
  ['goods-auction', '牙郎：两件货物拍卖'], ['cards-auction', '花魁：三张牌拍卖'],
  ['hand-draft', '县丞：公开手牌重分'], ['goods-draft', '船老大：货物重分'],
  ['tools-draft', '光棍：道具重分'], ['tools', '同名道具与横置'], ['full', '满摊与临时位'],
  ['paused', '共同暂停'], ['suspended', '意外掉线挂起'], ['result', '正常收市结果'], ['dense', '110张密集手牌'],
  ['layout-sparse', '布局：两人少牌'], ['layout-dense', '布局：两人多牌'],
  ['layout-six', '布局：六人公开商铺（未实现多人）'],
].map(entry => Object.freeze(entry)));

const entity = (suffix, copy = 1, extra = {}) => ({ id: `yousei.${suffix}#${String(copy).padStart(2, '0')}`, definitionId: `yousei.${suffix}`, ...extra });
const goods = (...counts) => GOODS.map((good, index) => ({ id: good.id, count: counts[index] ?? 0 }));
const ownId = 'digital-sample-p1', peerId = 'digital-sample-p2';
const cardCandidates = (...suffixes) => suffixes.map((suffix, index) => ({ id: `choice-${index}`, card: entity(suffix), kind: 'card' }));
const goodCandidates = (...indices) => indices.map((index, order) => ({ id: `choice-${order}`, goodId: GOODS[index].id, count: 1, kind: 'good' }));

/** Public composition fixtures only. Peer hand identities never enter this data. */
function layoutFixture(scene) {
  const six = scene === 'layout-six', dense = scene === 'layout-dense';
  const shops = six ? [
    { name: '我 · 青石小铺', silver: 32, stock: [1, 1, 1, 1, 1, 0], tools: [entity('t05'), entity('t04', 1, { tapped: true }), entity('t02')] },
    { name: '灯笼铺老板', silver: 24, stock: [0, 1, 0, 1, 0, 1], tools: [], handCount: 5 },
    { name: '山间行商', silver: 58, stock: [1, 0, 1, 0, 2, 0], tools: [entity('t01')], handCount: 11 },
    { name: '夜雨古玩铺', silver: 0, stock: [0, 0, 0, 1, 0, 2], tools: [entity('t07'), entity('t08', 1, { tapped: true })], handCount: 9 },
    { name: '枫桥客栈与异兽杂货铺', silver: 46, stock: [1, 1, 1, 0, 0, 0], tools: [entity('t03'), entity('t06'), entity('t09', 1, { tapped: true })], handCount: 4 },
    { name: '盐铁商人', silver: 12, stock: [1, 0, 0, 1, 0, 1], tools: [entity('t05', 2, { tapped: true }), entity('t10')], handCount: 7 },
  ] : [
    { name: '我 · 青石小铺', silver: dense ? 47 : 20, stock: dense ? [2, 1, 1, 1, 1, 0] : [1, 0, 0, 0, 0, 0],
      tools: dense ? [entity('t05'), entity('t04', 1, { tapped: true }), entity('t02')] : [] },
    { name: dense ? '灯笼铺老板 · 满装备' : '灯笼铺老板', silver: dense ? 52 : 24,
      stock: dense ? [1, 1, 0, 0, 1, 1] : [0, 0, 1, 0, 0, 0],
      tools: dense ? [entity('t01'), entity('t07', 1, { tapped: true }), entity('t10')] : [entity('t01')], handCount: dense ? 16 : 3 },
  ];
  const discard = entity('c10'), occupied = new Set([discard.id, ...shops.flatMap(shop => shop.tools.map(card => card.id))]);
  const available = createDeck().filter(card => !occupied.has(card.id));
  const buckets = ['goods', 'ordinary_character', 'tool', 'monitored_character', 'stall_permit']
    .map(category => available.filter(card => getCard(card.definitionId).category === category));
  const hand = [], handCount = six ? 20 : dense ? 36 : 4;
  while (hand.length < handCount) {
    for (const bucket of buckets) {
      if (hand.length === handCount) break;
      if (bucket.length) hand.push({ ...bucket.shift() });
    }
  }
  const players = shops.map((shop, index) => ({ id: `digital-sample-p${index + 1}`, name: shop.name,
    seatOrder: index + 1, silver: shop.silver, goods: goods(...shop.stock), tools: shop.tools,
    handCount: index === 0 ? hand.length : shop.handCount, ready: true,
    ordinaryCapacity: dense && index === 0 ? 5 : index === 4 ? 8 : 5, expansions: index === 4 ? 1 : 0 }));
  return { synthetic: true, saved: false, layoutOnly: true,
    layoutLabel: six ? '六人布局演示 · 尚非多人游戏' : `两人布局演示 · ${dense ? '密集手牌与满装备' : '稀疏手牌与空装备'}`,
    ruleVersion: DIGITAL_RULE_VERSION, scene, roomId: 'hyakki-layout-sample', roomCode: '610036', matchId: `hyakki-${scene}`,
    selfId: ownId, selfRole: 'player', phase: 'playing', currentPlayerId: six ? players[2].id : ownId,
    spectatorCount: 2, players, hand,
    market: GOODS.map((good, index) => ({ ...good, count: 8 - shops.reduce((sum, shop) => sum + shop.stock[index], 0) })),
    goodsPerType: 8, expansionStock: six ? 4 : 5, expansionPrice: 3,
    actionLimit: 5, actionsUsed: six ? 3 : dense ? 4 : 1,
    deckCount: 110 - players.reduce((sum, player) => sum + player.handCount + player.tools.length, 0) - 1,
    discardCount: 1, discard, decision: null, clock: '24:12', temporaryPaid: dense,
  };
}

function decision(scene) {
  const base = { id: `sample-decision-${scene}`, actorId: ownId, committed: true, clock: '24:12',
    activeRemaining: '24:12', private: false, selected: [], sourceId: null, candidates: [], kind: 'choose',
    confirmLabel: '确认选择', min: 1, max: 1, notice: '已提交的步骤。收起详情不会取消、退款或重新抽取。' };
  const definitions = {
    peek: { kind: 'peek', private: true, title: '这张牌，留下还是弃掉？',
      description: '看牌已用1行动。留下立刻进入用牌；弃掉后还有行动才可继续看。',
      candidates: cardCandidates('g19'), clock: '24:12', sourceId: 'yousei.g19' },
    guard: { kind: 'response', clock: '00:48', sourceId: 'yousei.m02', title: '锦衣卫 · 是否阻止县丞？',
      description: '对方想将双方手牌公开、合并，再交替选回。现在尚未公开任何私牌。',
      responseId: 'yousei.c07', acceptLabel: '打出锦衣卫 · 免费', declineLabel: '不反制',
      outcome: '使用后取消整个县丞效果；对方已用的1行动不退。两张人物牌弃置。' },
    trader: { kind: 'response', clock: '00:48', sourceId: 'yousei.g01', title: '番商 · 是否取走交易凭据？',
      description: '对方已完成交易；银两与货物不回退。你可以用番商取得这张货物牌。',
      responseId: 'yousei.c04', acceptLabel: '打出番商 · 免费', declineLabel: '不取走',
      outcome: '取得当前货物牌入手，番商弃置。不能取走买办人物本身。', candidates: cardCandidates('g01') },
    oracle: { private: true, sourceId: 'yousei.c02', title: '卦师 · 私看六张，选一张',
      description: '你选择的牌入手，其余保持原相对顺序放回堆顶。整批只用人物的1行动。',
      candidates: cardCandidates('g01', 'c07', 't04', 'g19', 'm06', 'c12'), clock: '24:12' },
    lamp: { private: true, sourceId: 'yousei.t04', title: '两仪灯 · 留一张，另一张给对方',
      description: '两张候选已经固定。选中的入自己手；另一张交给伙伴，道具保持横置。',
      candidates: cardCandidates('c07', 'g19'), clock: '24:12', confirmLabel: '留下选中牌，另一张给对方' },
    'goods-auction': { kind: 'auction', clock: '00:48', sourceId: 'yousei.c09', title: '牙郎 · 这两件一起拍卖',
      description: '两件盐铁为完整拍品。对方现报3两，轮到你；最高价一次支付给银行。',
      candidates: goodCandidates(5, 5), currentBid: 3, nextBid: 4, maxBid: 20, confirmLabel: '确认报价',
      outcome: '报价只能更高且不超过现有银两。对方放弃后你付款、再按人物规则接收货物。' },
    'cards-auction': { kind: 'auction', clock: '00:48', sourceId: 'yousei.c12', title: '花魁 · 三张牌整组拍卖',
      description: '下面三张全部属于这一组拍品，不能单买其中一张。对方现报3两。',
      candidates: cardCandidates('g19', 'c07', 't04'), currentBid: 3, nextBid: 4, maxBid: 20,
      confirmLabel: '确认报价', outcome: '得标者向银行支付一次，三张全部入手；双方首轮都不报价则三张弃置。' },
    'hand-draft': { sourceId: 'yousei.m02', title: '县丞 · 从公开牌池取一张',
      description: '锦衣卫窗口已结束。这批牌现在对双方公开；由使用者先，每次一张交替选。',
      candidates: cardCandidates('g01', 'c07', 't04', 'm05', 'g19'), outcome: '这是第3次选择。已拿走的牌不回池；关闭详情也不会重新合并手牌。' },
    'goods-draft': { sourceId: 'yousei.m05', title: '船老大 · 选一件货物',
      description: '双方原库存已进入公开池，轮流拿一件。你的普通位还空1格。',
      candidates: goodCandidates(0, 1, 1, 4, 5), outcome: '容量或费用不足者跳过；双方均放不下的回公共区。不反复退回池。' },
    'tools-draft': { sourceId: 'yousei.m06', title: '光棍 · 选择一个道具',
      description: '两人的已装道具合并公开，交替选取，直接竖直进入道具区。你还可放2张。',
      candidates: cardCandidates('t01', 't04', 't05', 't07', 't10'), outcome: '每人最多3张。重新拿到的纸上仙也不能越过取牌阶段限制。' },
  };
  return definitions[scene] ? { ...base, ...definitions[scene] } : null;
}

export function digitalFixture(requestedScene = 'active') {
  const scene = DIGITAL_SCENES.some(([id]) => id === requestedScene) ? requestedScene : 'active';
  if (scene.startsWith('layout-')) return layoutFixture(scene);
  const selfGoods = scene === 'full' ? goods(1, 1, 1, 1, 1, 1) : goods(2, 1, 0, 0, 1, 0);
  const peerGoods = goods(0, 0, 1, 1, 0, 0);
  const hand = scene === 'dense' ? createDeck().map(card => ({ ...card }))
    : ['g01', 'g19', 'c02', 'c07', 'c04', 't04', 'm02', 'c12'].map(suffix => entity(suffix, suffix === 't04' ? 2 : 1));
  const tools = [entity('t05', 1), entity('t05', 2, { tapped: true }), entity('t04', 1, { tapped: true })];
  const view = { synthetic: true, saved: false, ruleVersion: DIGITAL_RULE_VERSION, scene,
    roomId: 'hyakki-digital-step0', roomCode: '610036', matchId: 'hyakki-digital-sample', selfId: ownId,
    selfRole: 'player', currentPlayerId: ['opponent', 'guard', 'trader', 'goods-auction', 'cards-auction'].includes(scene) ? peerId : ownId,
    phase: scene === 'waiting' ? 'waiting' : scene === 'result' ? 'finished' : ['paused', 'suspended'].includes(scene) ? 'paused' : 'playing',
    spectatorCount: 2, players: [
      { id: ownId, name: '我 · 青石小铺', silver: scene === 'result' ? 68 : 20, goods: selfGoods, tools, ready: false, handCount: hand.length, ordinaryCapacity: 5, expansions: 0 },
      { id: peerId, name: '灯笼铺老板（示范伙伴）', silver: scene === 'result' ? 64 : 24, goods: peerGoods, tools: [entity('t01')], ready: true, handCount: 5, ordinaryCapacity: 5, expansions: 0 },
    ],
    hand, market: GOODS.map((good, index) => ({ ...good, count: 6 - selfGoods[index].count - peerGoods[index].count })),
    expansionStock: 5, expansionPrice: 6, actionLimit: 5, actionsUsed: scene === 'peek' ? 4 : 2,
    deckCount: scene === 'dense' ? 0 : 82, discardCount: 11, discard: entity('c10'),
    decision: decision(scene), clock: '24:12', temporaryPaid: scene === 'full', resultReason: '双方完成规定回合后，按银两比较。',
  };
  // Even a display-only projection must not place the same physical card in
  // two zones. Committed effect cards have left the hand; candidates are a pool.
  if (view.decision) {
    const candidates = new Set(view.decision.candidates.filter(item => item.kind === 'card').map(item => item.card.id));
    view.hand = view.hand.filter(card => !candidates.has(card.id) && card.definitionId !== view.decision.sourceId);
    for (const player of view.players) player.tools = player.tools.filter(card => !candidates.has(card.id));
  }
  if (scene === 'dense') {
    for (const player of view.players) player.tools = [];
    view.discard = null; view.discardCount = 0;
  }
  view.players[0].handCount = view.hand.length;
  if (scene === 'spectator') {
    view.selfRole = 'spectator'; view.selfId = 'digital-sample-spectator'; view.currentPlayerId = peerId;
    view.hand = []; view.decision = null;
  }
  return view;
}

/** Display selection only. Card ownership and economic rules are not simulated. */
export function validPreviewChoice(view, candidateId) {
  const choice = view?.decision;
  return view?.synthetic === true && view.selfRole === 'player' && view.phase === 'playing'
    && choice?.actorId === view.selfId && choice.candidates.some(candidate => candidate.id === candidateId);
}

export function cardDefinition(card) { return getCard(card?.definitionId ?? card?.id ?? card); }
export const allDigitalCards = () => CARDS;
