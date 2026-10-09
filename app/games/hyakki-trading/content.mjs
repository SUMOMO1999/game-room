/** Public card text and fixed Step 0 examples. This module does not create a live match. */
export const CONTENT_VERSION = 'hyakki-content-v1';

function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export const GOODS = freezeTree([
  { id: 'cucumber', name: '黄瓜', stock: 20, description: '鲜绿黄瓜；每个占 1 格摊位。' },
  { id: 'aburaage', name: '油豆腐', stock: 20, description: '金黄油豆腐；每个占 1 格摊位。' },
  { id: 'lantern', name: '灯笼', stock: 20, description: '纸制灯笼；每个占 1 格摊位。' },
  { id: 'fox-fur', name: '狐毛', stock: 20, description: '柔软狐毛；每个占 1 格摊位。' },
  { id: 'tengu-feather', name: '天狗羽毛', stock: 20, description: '天狗的羽毛；每个占 1 格摊位。' },
  { id: 'spirit-stone', name: '灵石', stock: 20, description: '微光灵石；每个占 1 格摊位。' },
]);

export const ACTIONS = freezeTree([
  {
    id: 'festival', typeId: 'hyakki.festival', kind: 'festival', name: '妖怪盛典', count: 8,
    timing: 'active', timingLabel: '本人回合', ap: 1, costText: '1 行动力',
    compactText: '买 −2 · 卖 +2', compactCost: '1力 · 主动',
    shortText: '选一种货物；本回合含它的凭据买 −2、卖 +2。',
    details: [
      '选择一种货物，本回合仅你使用的相关货物凭据享受买价减 2 两、卖价加 2 两；买价最低 1 两。',
      '整张凭据只调整一次；同种货物出现两件也不翻倍。不影响其他玩家或拍卖报价。',
      '每回合最多发动一次，不能更换货物或叠加。支付 1 行动力，牌弃置，效果保留至本回合结束。',
    ],
  },
  {
    id: 'theft', typeId: 'hyakki.theft', kind: 'theft', name: '顺手牵羊', count: 8,
    timing: 'active', timingLabel: '本人回合', ap: 1, costText: '1 行动力',
    compactText: '取走1个货物', compactCost: '1力 · 主动',
    shortText: '偷走另一玩家的 1 个货物；对方有 10 秒防御。',
    details: [
      '选择另一玩家摊位上的 1 个货物；你的摊位须有空位。确认后支付 1 行动力，公开这张牌并等待回应。',
      '目标有 10 秒使用护身符或放弃；无论对方是否持有护身符，都有相同的回应时间。',
      '未防御则货物移到你的摊位；成功防御则货物留在原处。结算后此牌弃置；被防御不退行动力。',
      '等待防御时暂停你的主动回合计时；即使用掉最后 1 行动力，也先结清本次偷窃再换人。',
    ],
  },
  {
    id: 'talisman', typeId: 'hyakki.talisman', kind: 'talisman', name: '护身符', count: 8,
    timing: 'reaction', timingLabel: '本人被偷时', ap: 0, costText: '0 行动力',
    compactText: '取消本次偷窃', compactCost: '0力 · 反应',
    shortText: '在 10 秒内取消对自己的这次偷窃。',
    details: [
      '仅当你是当前偷窃目标时，可在 10 秒回应窗口内使用；不消耗行动力。',
      '取消这一次偷窃，货物留在你的摊位。护身符与偷窃牌均弃置，对方已付的行动力不退还。',
      '不能保护其他玩家，不能预先使用，也不能在窗口结束后补用。每次偷窃最多使用一张。',
      '放弃或超时即不防御；未使用的护身符仍是你的私有手牌。',
    ],
  },
  {
    id: 'auction', typeId: 'hyakki.auction', kind: 'auction', name: '黑市拍卖', count: 6,
    timing: 'active', timingLabel: '本人回合', ap: 1, costText: '1 行动力 · 至少持有 3 两',
    compactText: '无人报你付1两', compactCost: '1力 · 至少3两',
    shortText: '依次拍卖 3 张牌；无人报价由你 1 两接走。',
    details: [
      '发动时至少持有 3 两，牌堆与弃牌合计须有至少 3 张可抽牌，不计这张拍卖牌。确认后支付 1 行动力，一次抽出 3 件拍品，只揭示当前一件。',
      '每件从你开始，按固定轮序出价或放弃。首价 1 两，每次只能加 1 两；当前最高者不用再回应，放弃后不能重入当前件。',
      '每次回应 15 秒；超时或付不起下一价自动放弃。最高者之外无人可继续时成交；无人报价则由你付 1 两接走。',
      '作为发起者，你须为每件后续拍品预留 1 两，当前件最多报“余额 − 后续件数”。预留不提前扣钱；已确认报价和无人报价时的兜底不能撤销。',
      '成交价付给银行，拍品加入买家手牌。下一件重新开放在局玩家竞价；三件全结清后，这张拍卖牌弃置，继续你的剩余回合。',
      '整场拍卖期间暂停主动回合计时，不穿插其他买卖。申请离席者自动放弃后续自愿竞价，但已确认报价与发起者兜底仍须结清。',
    ],
  },
  {
    id: 'stall-permit', typeId: 'hyakki.stall-permit', kind: 'stall-permit', name: '摊位许可证', count: 10,
    timing: 'active', timingLabel: '本人回合', ap: 1, costText: '1 行动力 + 3 两',
    compactText: '容量 +3 格', compactCost: '1力 + 3两',
    shortText: '支付 3 两，让本局摊位容量永久 +3。',
    details: [
      '支付 1 行动力与 3 两给银行，本局摊位容量永久增加 3 格；实际货物数量不变。',
      '这张牌使用后弃置。之后可用其他许可证继续扩容，没有容量上限；同一张牌不能留在手中反复使用。',
      '不足 3 两时不能发动，不扣行动力、不弃牌、不改变容量。',
    ],
  },
]);

const goodsCardType = {
  id: 'goods-card', typeId: 'hyakki.goods-card', kind: 'goods-card', name: '货物凭据', count: 80,
  timing: 'active', timingLabel: '本人回合', ap: 1, costText: '买或卖各 1 行动力',
  shortText: '凭牌买入或卖出所列全部货物，用后弃置。',
  details: [
    '买入：支付 1 行动力与牌面买价，从公库取得完整组合；须有足够银两、公共库存与摊位空位。',
    '卖出：支付 1 行动力，将摊位上的完整组合交回公库，收取牌面卖价。',
    '买卖任选一种，完成后凭据弃置。买来的货物仍在摊位；以后出售须再用另一张适用凭据。',
    '条件不足不能部分成交，不扣钱、不扣行动力、不弃牌。基础组合与价格整局固定，洗回也不改变。',
  ],
};

export const CARD_TYPES = freezeTree([goodsCardType, ...ACTIONS]);

export const RECIPES = freezeTree([
  ...['AAB', 'BBC', 'CCD', 'DDE', 'EEF', 'FFA', 'ABC', 'DEF'].map(id => ({ id, letters: [...id], copies: 8, total: id.length })),
  ...['AABB', 'CCDDE', 'AABBCC', 'DDEEFF'].map(id => ({ id, letters: [...id], copies: 4, total: id.length })),
]);

export const SAMPLE_MAPPING = freezeTree({
  A: 'cucumber', B: 'aburaage', C: 'lantern', D: 'fox-fur', E: 'tengu-feather', F: 'spirit-stone',
});

const goodsById = new Map(GOODS.map(good => [good.id, good]));
const typesById = new Map(CARD_TYPES.map(type => [type.typeId, type]));
const buyPrices = Object.freeze([3, 4, 5]);
const sellPrices = Object.freeze([11, 12, 13]);

export function getGood(id) {
  const good = goodsById.get(id);
  if (!good) throw new RangeError('未知的百鬼商会货物');
  return good;
}

export function getCardType(typeId) {
  const type = typesById.get(typeId);
  if (!type) throw new RangeError('未知的百鬼商会牌类');
  return type;
}

/** Names remain available if the illustration cannot be loaded. */
export function describeGoods(goods) {
  if (!Array.isArray(goods) || goods.length === 0) throw new TypeError('货物组合不能为空');
  const seen = new Set();
  return goods.map(({ id, count }) => {
    if (!Number.isInteger(count) || count < 1 || count > 2 || seen.has(id)) throw new RangeError('货物组合数量或种类重复');
    seen.add(id);
    return `${getGood(id).name} ×${count}`;
  }).join('、');
}

function validateMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new TypeError('示例牌映射须包含 A～F');
  const letters = Object.keys(SAMPLE_MAPPING);
  if (Object.keys(mapping).length !== letters.length || letters.some(letter => !Object.hasOwn(mapping, letter))) {
    throw new RangeError('示例牌映射须恰好包含 A～F');
  }
  const goods = letters.map(letter => getGood(mapping[letter]).id);
  if (new Set(goods).size !== GOODS.length) throw new RangeError('示例牌映射须包含六种不同货物');
}

/**
 * Complete, public 120-card gallery fixture. Prices cycle across the nine allowed
 * pairs for readable coverage. This is not a random generator or a shuffled deck.
 * Live matches must independently randomize and persist their own mapping/prices.
 */
export function createSampleDeck(mapping = SAMPLE_MAPPING) {
  validateMapping(mapping);
  const cards = [];
  const sampleId = () => `sample-hyakki-${String(cards.length + 1).padStart(3, '0')}`;
  for (const recipe of RECIPES) {
    for (let copy = 0; copy < recipe.copies; copy += 1) {
      const quantities = new Map();
      for (const letter of recipe.letters) {
        const id = mapping[letter];
        quantities.set(id, (quantities.get(id) ?? 0) + 1);
      }
      const goods = [...quantities].map(([id, count]) => ({ id, count }));
      const buyPrice = buyPrices[cards.length % buyPrices.length];
      const sellPrice = sellPrices[Math.floor(cards.length / buyPrices.length) % sellPrices.length];
      cards.push({
        ...goodsCardType, id: sampleId(), sample: true, contentVersion: CONTENT_VERSION,
        recipeId: recipe.id, goods, buyPrice, sellPrice,
        details: [`本张凭据：${describeGoods(goods)}。基础买价 ${buyPrice} 两，基础卖价 ${sellPrice} 两。`, ...goodsCardType.details],
      });
    }
  }
  for (const action of ACTIONS) {
    for (let copy = 0; copy < action.count; copy += 1) {
      cards.push({ ...action, id: sampleId(), sample: true, contentVersion: CONTENT_VERSION });
    }
  }
  return freezeTree(cards);
}
