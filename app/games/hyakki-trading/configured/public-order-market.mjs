import {PUBLIC_ORDERS} from '../content/expansion-two.mjs';
import {countGoods, goodsVector} from '../trade-contract.mjs';
import {ordinaryCapacity, shuffled} from './model.mjs';
import {quoteOrderDelivery} from './expansion-two-economy.mjs';

const definitions = PUBLIC_ORDERS.map(order => order.id);
const known = new Set(definitions);
const countOf = (value, count) => Array.isArray(value) && value.length === count;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function need(ok, message) {
  if (!ok) throw new RangeError(message);
}
function fields(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function slotProblem(slot, position) {
  return !fields(slot, ['id', 'position', 'generation']) || !known.has(slot.id)
    || slot.position !== position || !integer(slot.generation, 1, Number.MAX_SAFE_INTEGER);
}

export function publicOrderMarketProblem(market) {
  if (!fields(market, ['draw', 'discard', 'slots', 'pending'])
    || !Array.isArray(market.draw) || !Array.isArray(market.discard) || !countOf(market.slots, 3)
    || market.slots.some(slotProblem)) return '公单牌堆或公开位置无效。';
  const pending = market.pending;
  if (pending !== null && (!fields(pending, ['actorId', 'position', 'generation', 'candidates'])
    || typeof pending.actorId !== 'string' || !pending.actorId || !integer(pending.position, 0, 2)
    || pending.generation !== market.slots[pending.position].generation
    || !Array.isArray(pending.candidates) || !integer(pending.candidates.length, 1, 3))) {
    return '罗盘的待选公单无效。';
  }
  const ids = [...market.draw, ...market.discard, ...market.slots.map(slot => slot.id), ...(pending?.candidates ?? [])];
  if (ids.length !== definitions.length || ids.some(id => !known.has(id)) || new Set(ids).size !== definitions.length) {
    return '18张公单必须各在一个区域。';
  }
  return null;
}

function check(market) {
  const problem = publicOrderMarketProblem(market);
  need(!problem, problem);
}
function availableSlot(market, position, generation) {
  check(market);
  need(market.pending === null, '请先完成罗盘私选。');
  need(integer(position, 0, 2) && market.slots[position].generation === generation, '原公单已更换。');
  need(generation < Number.MAX_SAFE_INTEGER, '公单位置代际达到上限。');
  return market.slots[position];
}
function drawUpTo(next, count, randomInt) {
  const cards = [];
  while (cards.length < count) {
    if (!next.draw.length) {
      if (!next.discard.length) break;
      next.draw = shuffled(next.discard, randomInt);
      next.discard = [];
    }
    cards.push(next.draw.shift());
  }
  return cards;
}
function replace(next, previous, id) {
  next.slots[previous.position] = {id, position:previous.position, generation:previous.generation + 1};
}

export function createPublicOrderMarket(randomInt) {
  const draw = shuffled(definitions, randomInt);
  const slots = draw.splice(0, 3).map((id, position) => ({id, position, generation:1}));
  return {draw, slots, discard:[], pending:null};
}

export function projectPublicOrders(market, viewerId) {
  check(market);
  const pending = market.pending;
  return {
    orders:structuredClone(market.slots),
    choosing:pending !== null,
    ...(pending && pending.actorId === viewerId ? {choice:structuredClone(pending)} : {}),
  };
}

/** Caller owns the turn, card source, action cost and journal. The market,
 * stock and bank are returned together for the caller's single commit. */
export function settlePublicOrder({market, owner, bankGoods, position, generation, selection, broker = false, saleBonusUsed = false, randomInt}) {
  const slot = availableSlot(market, position, generation);
  need(typeof broker === 'boolean', '公单来源无效。');
  const quote = quoteOrderDelivery({owner, orderId:slot.id, selection, broker, saleBonusUsed});
  const goods = goodsVector(owner.goods, {complete:true});
  const refined = goodsVector(owner.refined ?? {});
  const bank = goodsVector(bankGoods, {complete:true});
  for (const [id, count] of Object.entries(quote.delivery.goods)) {
    goods[id] -= count;
    refined[id] -= quote.delivery.refined[id];
    bank[id] += count;
    need(bank[id] <= 20, '公栈库存超出上限。');
  }
  const silver = owner.silver + quote.proceeds;
  need(Number.isSafeInteger(silver) && silver >= 0, '银两超出上限。');
  const next = structuredClone(market);
  next.discard.push(slot.id);
  replace(next, slot, drawUpTo(next, 1, randomInt)[0]);
  check(next);
  return {
    market:next, bankGoods:bank, quote,
    owner:{...owner, goods, refined, silver, temporaryOccupied:countGoods(goods) > ordinaryCapacity(owner)},
  };
}

export function replacePublicOrder({market, position, generation, randomInt}) {
  const slot = availableSlot(market, position, generation);
  const next = structuredClone(market);
  const [id] = drawUpTo(next, 1, randomInt);
  need(id, '没有可换入的公单。');
  replace(next, slot, id);
  next.draw.push(slot.id);
  check(next);
  return next;
}

export function beginPublicOrderChoice({market, position, generation, actorId, randomInt}) {
  availableSlot(market, position, generation);
  need(typeof actorId === 'string' && actorId.length > 0, '罗盘须有选单席位。');
  const next = structuredClone(market);
  const candidates = drawUpTo(next, 3, randomInt);
  need(candidates.length > 0, '没有可换入的公单。');
  next.pending = {actorId, position, generation, candidates};
  check(next);
  return next;
}

export function finishPublicOrderChoice({market, actorId, position, generation, orderId}) {
  check(market);
  const pending = market.pending;
  need(pending && pending.actorId === actorId && pending.position === position
    && pending.generation === generation, '这次罗盘选择已改变。');
  const selected = orderId === undefined ? pending.candidates[0] : orderId;
  need(pending.candidates.includes(selected), '请选择本次揭示的公单。');
  const next = structuredClone(market);
  const previous = market.slots[position];
  replace(next, previous, selected);
  next.draw.push(...pending.candidates.filter(id => id !== selected), previous.id);
  next.pending = null;
  check(next);
  return next;
}
