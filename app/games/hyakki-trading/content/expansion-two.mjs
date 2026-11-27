import {CATEGORIES, GOODS, ROLES, cardsForExpansion, createExpansionDeck, expansionProfile} from './expansion-one.mjs';

export const EXPANSION_TWO_PACK_ID = 'trade-routes-v1';
export const EXPANSION_TWO_CONTENT_VERSION = 'yousei-content-e2-v1';
export const EXPANSION_TWO_BASE_CONTENT_VERSION = 'yousei-content-v5';
export const EXPANSION_TWO_MODULES = Object.freeze(['orders', 'refining', 'exchange']);
export const ORDER_ONLY_MODULES = Object.freeze({orders:true,refining:false,exchange:false});
export const REFINING_ONLY_MODULES = Object.freeze({orders:false,refining:true,exchange:false});
export const ORDERS_AND_REFINING = Object.freeze({orders:true,refining:true,exchange:false});
export const TRADE_ROUTES_VARIANTS = Object.freeze({
  orders:ORDER_ONLY_MODULES,
  refining:REFINING_ONLY_MODULES,
  'orders-refining':ORDERS_AND_REFINING,
  exchange:Object.freeze({orders:false,refining:false,exchange:true}),
  'orders-exchange':Object.freeze({orders:true,refining:false,exchange:true}),
  'refining-exchange':Object.freeze({orders:false,refining:true,exchange:true}),
  all:Object.freeze({orders:true,refining:true,exchange:true}),
});

const single = ['边关军需', '远洋补给', '奇珍入市', '灵圃备货', '雅集筹办', '修坊备料'];
const mixed = ['军港开市', '异域珍藏', '灵器合供', '海上仙集', '修阁藏珍', '机关灵坊'];
const triples = [[0, 1, 5], [1, 2, 4], [2, 3, 0], [3, 4, 1], [4, 5, 2], [5, 0, 3]];
const label = id => CATEGORIES.find(category => category.id === id).name;
const goodsIn = category => GOODS.filter(good => good.category === category);
const deliveryExample = (goods, silver) => `交${goods.join('、')}，领${silver}两（均为普通货）。`;
const order = (index, fields) => Object.freeze({
  id: 'E2O' + String(index + 1).padStart(2, '0'),
  ...fields,
  example: deliveryExample(fields.example, fields.silver),
  categories: Object.freeze(fields.categories),
});
export const PUBLIC_ORDERS = Object.freeze([
  ...single.map((name, index) => {
    const {id} = CATEGORIES[index];
    const [first, second] = goodsIn(id);
    const other = goodsIn(CATEGORIES[(index + 1) % CATEGORIES.length].id)[0];
    return order(index, {name, kind:'paired', categories:[id], count:3, silver:7,
      summary:label(id) + '类2件，其他任一类1件',
      example:[first, second, other].map(good => good.name + '×1')});
  }),
  ...mixed.map((name, index) => {
    const categories = triples[index].map(i => CATEGORIES[i].id);
    return order(index + 6, {name, kind:'mixed', categories, count:3, silver:8,
      summary:categories.map(id => label(id) + '1件').join('、'),
      example:categories.map(id => goodsIn(id)[0].name + '×1')});
  }),
  ...CATEGORIES.map(({id, name}, index) => order(index + 12, {
    name:name + '集采', kind:'bulk', categories:[id], count:4, silver:11,
    summary:goodsIn(id).map(good => good.name + '4件').join('或'),
    example:[goodsIn(id)[0].name + '×4'],
  })),
]);
const ordersById = new Map(PUBLIC_ORDERS.map(item => [item.id, item]));
export function getPublicOrder(id) {
  const item = ordersById.get(id);
  if (!item) throw new RangeError('公单无效。');
  return item;
}

const copiesByPlayerCount = Object.freeze({2:1, 3:2, 4:3, 5:4, 6:5});
function mainCard(sourceCode, module, name, category, cost, compactText, summary, details, example) {
  const tool = category === 'tool';
  return Object.freeze({id:'yousei.'+sourceCode.toLowerCase(), sourceCode, module, name, category, original:false,
    actionIncrement:tool ? 0 : cost, ...(tool ? {activationActions:cost} : {}), timing:'own-use',
    copiesByPlayerCount, summary, compactText, details:Object.freeze(details), example,
    costText:tool ? `装0步 · 用${cost}步` : `${cost}行动`, artPath:null});
}
function role(sourceCode, module, name, compactText, summary, details, example) {
  return Object.freeze({id:'yousei.role.'+sourceCode.toLowerCase(), sourceCode, module, name, initialSilver:20,
    category:null, compactText, summary, details:Object.freeze(details), example, artPath:null});
}

export const TRADE_ROUTES_CARDS = Object.freeze([
  mainCard('E2C01','orders','行会说客','ordinary_character',1,'交单可替1件','交1张公单，可用任意1件货替代其中1件。',
    ['仍须交足公单件数，共用本回合的交单次数。','精制按实际交付计价，不触发货物牌交易。'],
    '「边关军需」要2件军工货加1件其他类货。打出说客，交火器、木材、番货各1件，用木材补缺的1件军工货，领7两。'),
  mainCard('E2T01','orders','望市罗盘','tool',1,'换公单·3选1','换公单：看订单顶3张，选1张换上。',
    ['订单堆不足时先按规则洗回弃堆，按实际可得数量选择。','未选候选按原序放底，旧公单最后放底。已揭示候选到期取第一张，共用换单次数。'],
    '桌上有「边关军需」，你凑不齐军工货。用罗盘选中它，点「查看候选」，再从翻出的候选里选「修坊备料」，原位置就换成「修坊备料」。'),
  mainCard('E2C02','refining','巧手匠人','ordinary_character',1,'精制1～2件','精制自己的1～2件普通货物。',
    ['可以是同种或不同种。工坊主人也至多精制2件。','共用本回合精制次数，立即不获得银两。'],
    '库存里有普通火器和普通木材各1件。打出巧手匠人，两件一起选，确认后变成精制火器和精制木材，仍放在你的摊位上。'),
  mainCard('E2T02','refining','百工锤','tool',1,'精制1件·摸1张','精制1件货，再摸1张牌。',
    ['工坊主人至多精制2件。共用本回合精制次数。','必须至少有1件可精制的货，主牌无牌可抽时只精制。'],
    '点已装备的百工锤，选1件普通机关。确认后机关变成精制机关，再摸1张手牌。'),
  mainCard('E2C03','exchange','牙行中人','ordinary_character',0,'挂牌至多给2张','挂牌时，你可提供至多2张手牌。',
    ['须至少剩1行动，共用本回合发布次数。两张提供牌必须是不同实体，不能包括此人物。','对方仍至多交1张手牌。发布成功即弃置，无人接受也不收回。'],
    '打出牙行中人，在「我给 → 手牌」选「货物交易」和「锦衣卫」，在「我想换」把银两加到5两。有人接受后，你交出那两张手牌，拿到5两。'),
  mainCard('E2T03','exchange','合契印','tool',0,'挂牌各交至多4件','挂牌时，双方各可交至多4件货。',
    ['须至少剩1行动，共用本回合发布次数。其他资产上限照常。','发布成功后横置。道具复原不重置发布次数，道具离场后旧报价仍保留原条款。'],
    '点已装备的合契印，在「我给」选木材×4，在「我想换」选盐铁×2，再免费发布。有人接受后，你交出4件木材，拿到2件盐铁。'),
]);
export const TRADE_ROUTES_ROLES = Object.freeze([
  role('E2R01','orders','承包商','集采单多得2两','每回合完成一次四件集采公单时，额外得2两。',
    ['行会说客替代1件仍可触发。货物牌和商会交易不触发。'],
    '完成「军工集采」，交4件普通火器。公单原奖11两，你作为承包商额外拿2两，共13两。'),
  role('E2R02','orders','探市客','每回合换单免费','每回合可免费执行一次基础换单。',
    ['须在自己的用牌阶段且至少剩1行动，共用换单次数。','望市罗盘仍按道具原行动成本使用。'],
    '你的用牌阶段还剩1行动。点「公单领赏」，选一张缺货的单并点「换单」。这次换单花0行动，换完仍剩1行动。'),
  role('E2R03','refining','工坊主人','每次精制至多2件','每回合那次精制可处理至多2件普通库存。',
    ['基础精制和百工锤均受益，巧手匠人仍至多2件。','精制次数和单笔溢价上限照常。'],
    '点「精制」，一起选普通机关和普通木材各1件。工坊主人可以用这一次机会精制两件，让两件都变成精制货。'),
  role('E2R04','refining','鉴珍人','首笔精制售货摸弃1','自己回合首次用货物牌卖出或交公单，且交付精制品后，摸1张主牌再弃1张。',
    ['每回合至多一次。无牌可摸时整步略过。先完成原交易回应。','商会、其他兑换和仅精制不触发。'],
    '用「货物交易」卖出2件普通火器和1件精制火器，且这回合还没触发过鉴珍人。等交易处理完，摸1张手牌，再从手牌里弃1张。'),
  role('E2R05','exchange','牙行掌柜','普通挂牌可改价1次','每回合可免费修改自己仍有效的普通报价的索取项1次。',
    ['须在用牌阶段且至少剩1行动。提供项、有效期和发布次数照常，旧报价代际失效。','必须有实际变化；已结束报价和人物、道具报价不适用。'],
    '你挂出「我给木材×2，想换5两」。没人接时，打开自己的普通报价点「改价」，把想换的5两改成4两，仍然给2件木材。'),
  role('E2R06','exchange','流通行商','商会新占临时格付1两','自己参与商会且新占临时格时，格费为1两。',
    ['发布者和接受者均适用。继续占用或未占用时不重收，其他途径收货按原费用。'],
    '你的5个普通货位已满，临时格空着。你在玩家交易里用3两换来1件木材，成交后木材占临时格，你总共付4两，其中1两是格费。'),
]);

export function checkedModules(modules) {
  if (!modules || ![Object.prototype,null].includes(Object.getPrototypeOf(modules)) || Object.keys(modules).length !== EXPANSION_TWO_MODULES.length
    || !EXPANSION_TWO_MODULES.every(key => Object.hasOwn(modules,key) && typeof modules[key] === 'boolean')) {
    throw new RangeError('商路风云的三个模块开关必须明确。');
  }
  return Object.freeze(Object.fromEntries(EXPANSION_TWO_MODULES.map(key => [key,modules[key]])));
}

const profiles = new Map();
/** Resolve the material boundary without changing the old edition's lookup
 * tables. The caller freezes this composition into a new game. */
export function composeTradeRoutes(playerCount, requestedModules) {
  const base = expansionProfile(playerCount,EXPANSION_TWO_BASE_CONTENT_VERSION);
  const modules = checkedModules(requestedModules);
  const key=playerCount+':'+EXPANSION_TWO_MODULES.map(module=>Number(modules[module])).join('');
  const existing=profiles.get(key);
  if(existing)return existing;
  const enabled = Object.values(modules).some(Boolean);
  const extraCards = TRADE_ROUTES_CARDS.filter(card => modules[card.module]);
  const extraRoles = TRADE_ROUTES_ROLES.filter(candidate => modules[candidate.module]);
  const copiesByCode=Object.freeze({...base.copiesByCode,...Object.fromEntries(extraCards.map(card=>[card.sourceCode,card.copiesByPlayerCount[playerCount]]))});
  const copies = extraCards.flatMap(card => Array.from({length:card.copiesByPlayerCount[playerCount]}, (_, index) =>
    Object.freeze({definitionId:card.id,id:card.id+'#'+String(index+1).padStart(2,'0')})));
  const deck = Object.freeze([...createExpansionDeck(playerCount,EXPANSION_TWO_BASE_CONTENT_VERSION), ...copies]);
  const profile=Object.freeze({
    packId:enabled ? EXPANSION_TWO_PACK_ID : base.packId,
    contentVersion:enabled ? EXPANSION_TWO_CONTENT_VERSION : base.contentVersion,
    playerCount, modules, goodsPerTypeRecommended:base.goodsPerTypeRecommended, stallBoards:base.stallBoards, deckSize:deck.length,copiesByCode,
    cards:Object.freeze([...cardsForExpansion(EXPANSION_TWO_BASE_CONTENT_VERSION),...extraCards]),
    roles:Object.freeze([...ROLES,...extraRoles]), deck,
    publicOrders:modules.orders ? PUBLIC_ORDERS : Object.freeze([]),
  });
  profiles.set(key,profile);
  return profile;
}
