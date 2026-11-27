import {GOODS, getExpansionCard} from '../content/expansion-one.mjs';
import {getPublicOrder} from '../content/expansion-two.mjs';
import {goodsVector,isSameKindBatch} from '../trade-contract.mjs';
import {ordinaryCapacity} from './model.mjs';

const total = vector => Object.values(vector).reduce((sum, count) => sum + count, 0);
const mapGoods = value => Object.fromEntries(GOODS.map(({id}) => [id, value(id)]));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function need(ok, message) {
  if (!ok) throw new RangeError(message);
}
function assetsStock(owner) {
  const goods = goodsVector(owner.goods, {complete:true});
  const refined = goodsVector(owner.refined ?? {});
  need(GOODS.every(({id}) => refined[id] <= goods[id]), '精制数量超过库存。');
  return {goods, refined};
}
function selectedGoods(owner, selection) {
  const stock = assetsStock(owner);
  const ordinary = goodsVector(selection?.ordinary ?? {});
  const refined = goodsVector(selection?.refined ?? {});
  need(GOODS.every(({id}) => ordinary[id] <= stock.goods[id] - stock.refined[id] && refined[id] <= stock.refined[id]), '所选品质或货物库存不足。');
  return {ordinary, refined, goods:mapGoods(id => ordinary[id] + refined[id])};
}

export function matchingOrderCount(order, goods) {
  const primary = order.categories[0];
  const countIn = category => GOODS.filter(good => good.category === category)
    .reduce((sum, good) => sum + goods[good.id], 0);
  if (order.kind === 'paired') {
    return Math.min(2, countIn(primary)) + Math.min(1, total(goods) - countIn(primary));
  }
  if (order.kind === 'mixed') return order.categories.filter(category => countIn(category) > 0).length;
  return Math.max(...GOODS.filter(good => good.category === primary).map(good => goods[good.id]));
}

export function quoteOrderDelivery({owner, orderId, selection, broker = false, saleBonusUsed = false}) {
  const order = getPublicOrder(orderId);
  const delivery = selectedGoods(owner, selection);
  need(total(delivery.goods) === order.count && matchingOrderCount(order, delivery.goods) >= order.count - Number(broker), '所选货物不符合公单要求。');
  const premium = Math.min(4, total(delivery.refined) * 2);
  const contractor = order.kind === 'bulk' && owner.roleId === 'yousei.role.e2r01' ? 2 : 0;
  const batchBonus = owner.roleId === 'yousei.role.r08' && !saleBonusUsed && isSameKindBatch(delivery.goods) ? 2 : 0;
  return {orderId, delivery, baseSilver:order.silver, premium, contractor, batchBonus,
    proceeds:order.silver + premium + contractor + batchBonus};
}

export function planRefining({owner, ordinary, limit = 1}) {
  const stock = assetsStock(owner);
  const selection = selectedGoods(owner, {ordinary});
  need(integer(limit, 1, 2) && integer(total(selection.ordinary), 1, limit), '本次精制件数不符。');
  return mapGoods(id => stock.refined[id] + selection.ordinary[id]);
}

function exchangeLeg(owner, terms, {goodsLimit, cardLimit}) {
  const selected = selectedGoods(owner, terms);
  const silver = terms.silver ?? 0;
  const cardIds = terms.cardIds ?? [];
  need(integer(silver, 0, 10), '报价银两须在0～10两之间。');
  need(total(selected.goods) <= goodsLimit, '本侧货物超过报价上限。');
  need(Array.isArray(cardIds) && cardIds.length <= cardLimit && new Set(cardIds).size === cardIds.length
    && cardIds.every(id => typeof id === 'string' && owner.hand.includes(id)), '所选手牌已不在手中或超过上限。');
  need(silver > 0 || total(selected.goods) > 0 || cardIds.length > 0, '双方都须提供资产。');
  return {...selected, silver, cardIds:[...cardIds]};
}
function exchangeSide(owner, give, receive) {
  const stock = assetsStock(owner);
  const goods = mapGoods(id => stock.goods[id] - give.goods[id] + receive.goods[id]);
  const refined = mapGoods(id => stock.refined[id] - give.refined[id] + receive.refined[id]);
  const ordinary = ordinaryCapacity(owner);
  need(total(goods) <= ordinary + 1, '成交后货位不足。');
  const temporaryOccupied = total(goods) > ordinary;
  const fee = temporaryOccupied && !owner.temporaryOccupied ? (owner.roleId === 'yousei.role.e2r06' ? 1 : 2) : 0;
  const silver = owner.silver - give.silver + receive.silver - fee;
  need(owner.silver >= give.silver && Number.isSafeInteger(silver) && silver >= 0, '银两不足以交割并支付临时格费。');
  return {goods, refined, silver, temporaryOccupied, fee, hand:[...owner.hand.filter(id => !give.cardIds.includes(id)), ...receive.cardIds]};
}

/** Resolve exact asset legs before mutating either seat. Request category and
 * offer/revision fences belong to the caller. This function never edits owners. */
export function quoteExchange({maker, taker, provide, receive, source = 'ordinary',
  cardDefinition = id => getExpansionCard(id.split('#')[0]).id}) {
  need(maker.id !== taker.id, '发布者不能接自己的报价。');
  need(['ordinary', 'broker', 'seal'].includes(source), '报价来源无效。');
  const goodsLimit = source === 'seal' ? 4 : 3;
  const left = exchangeLeg(maker, provide, {goodsLimit, cardLimit:source === 'broker' ? 2 : 1});
  const right = exchangeLeg(taker, receive, {goodsLimit, cardLimit:1});
  need(!left.silver || !right.silver, '银两只能由一方支付。');
  const leftFaces = left.cardIds.map(cardDefinition).sort();
  const rightFaces = right.cardIds.map(cardDefinition).sort();
  const sameCards = leftFaces.length === rightFaces.length && leftFaces.every((face, i) => face === rightFaces[i]);
  const sameGoods = GOODS.every(({id}) => left.ordinary[id] === right.ordinary[id] && left.refined[id] === right.refined[id]);
  need(left.silver !== right.silver || !sameCards || !sameGoods, '双方提供的资产完全相同。');
  return {maker:exchangeSide(maker, left, right), taker:exchangeSide(taker, right, left)};
}
