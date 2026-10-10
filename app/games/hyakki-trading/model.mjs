/** Game-specific material operations. Call only on a candidate clone. */
import { createDeck, getCard, GOODS } from './content/definitions.mjs';
const copies = new Map(createDeck().map(card => [card.id, card.definitionId]));
export class RuleError extends Error {
  constructor(message, code = 'ILLEGAL_ACTION') { super(message); this.name = 'RuleError'; this.code = code; }
}
export function requireRule(condition, message, code) { if (!condition) throw new RuleError(message, code); }
export function definition(copyId) {
  requireRule(copies.has(copyId), '这张牌不存在。'); return getCard(copies.get(copyId));
}
export const emptyGoods = () => Object.fromEntries(GOODS.map(good => [good.id, 0]));
export const goodsCount = vector => Object.values(vector).reduce((sum, count) => sum + count, 0);
export const goodsEntries = vector => GOODS.map(good => [good.id, vector[good.id]]).filter(([, count]) => count > 0);
export function validGoods(vector) {
  return vector && typeof vector === 'object' && !Array.isArray(vector) && Object.keys(vector).length === GOODS.length
    && GOODS.every(good => Number.isSafeInteger(vector[good.id]) && vector[good.id] >= 0 && vector[good.id] <= 6);
}
export function player(state, id) {
  const value = state.players.find(entry => entry.id === id);
  requireRule(value, '你不是本局参赛者。', 'SEAT_REQUIRED'); return value;
}
export function opponent(state, id) { player(state, id); return state.players.find(entry => entry.id !== id); }
export function addSilver(owner, delta) {
  requireRule(Number.isSafeInteger(delta) && Number.isSafeInteger(owner.silver + delta) && owner.silver + delta >= 0, '银两不足或超出可保存范围。');
  owner.silver += delta;
}
export function moveGoods(from, to, vector) {
  requireRule(validGoods(vector) && GOODS.every(good => from[good.id] >= vector[good.id] && to[good.id] + vector[good.id] <= 6), '货物不足或数量无效。');
  for (const good of GOODS) { from[good.id] -= vector[good.id]; to[good.id] += vector[good.id]; }
}
export function removeCard(array, id) {
  const index = array.indexOf(id); requireRule(index >= 0, '这张牌已不在原来的位置。', 'CARD_MOVED');
  return array.splice(index, 1)[0];
}
export function discardCards(state, ids, { sort = false } = {}) {
  state.discard.push(...(sort ? [...ids].sort() : ids));
}
export function shuffled(cards, randomInt) {
  requireRule(typeof randomInt === 'function', '随机服务不可用。');
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index--) {
    const target = randomInt(index + 1);
    requireRule(Number.isSafeInteger(target) && target >= 0 && target <= index, '随机结果无效。');
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
export const availableCards = state => state.deck.length + state.discard.length;
export function drawCards(state, count, { randomInt }) {
  requireRule(Number.isSafeInteger(count) && count >= 0 && count <= 110, '抽牌数量无效。');
  const result = [];
  while (result.length < count) {
    if (!state.deck.length) {
      if (!state.discard.length) break;
      state.deck = shuffled(state.discard, randomInt); state.discard = [];
    }
    result.push(state.deck.shift());
  }
  return result;
}
export const ordinaryCapacity = owner => 5 + owner.stallCount * 3;
export const receiptCapacity = owner => ordinaryCapacity(owner) + (owner.temporaryOccupied || owner.silver >= 2 ? 1 : 0);
export function canReceive(owner, count, cost = 0) {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(cost) || cost < 0) return false;
  const total = goodsCount(owner.goods) + count, ordinary = ordinaryCapacity(owner);
  return total <= ordinary + 1 && owner.silver >= cost + (total > ordinary && !owner.temporaryOccupied ? 2 : 0);
}
export function refreshTemporary(owner) { owner.temporaryOccupied = goodsCount(owner.goods) > ordinaryCapacity(owner); }
export function paymentOptions(state, id) {
  const owner = player(state, id);
  return [...owner.hand.map(cardId => ({ zone: 'hand', cardId })), ...owner.tools.map(tool => ({ zone: 'tool', cardId: tool.cardId }))];
}
export function payCard(state, id, payment) {
  const owner = player(state, id);
  requireRule(payment && typeof payment === 'object' && Object.keys(payment).length === 2 && ['hand', 'tool'].includes(payment.zone), '请选择自己的支付牌。');
  if (payment.zone === 'hand') removeCard(owner.hand, payment.cardId);
  else {
    const index = owner.tools.findIndex(tool => tool.cardId === payment.cardId);
    requireRule(index >= 0, '请选择自己的已装道具。'); owner.tools.splice(index, 1);
  }
  discardCards(state, [payment.cardId]);
}
export function createPending(state, { kind, ownerId, code, sourceCards = [], data = {} }) {
  requireRule(!state.pending, '请先完成当前步骤。');
  state.pending = { id: `${state.matchId}:${state.turnNumber}:${state.revision + 1}`, kind, ownerId, code, stage: 'start',
    sourceCards: [...sourceCards], poolCards: [], goods: emptyGoods(), data: structuredClone(data), choice: null, response: null, receipt: null };
  return state.pending;
}
export function setChoice(state, { kind, actorId, visibility = 'private', options = [], defaultSelection }) {
  requireRule(state.pending && defaultSelection !== undefined, '选择步骤缺少合法默认项。');
  const priorId = state.pending.choice?.id;
  state.pending.choice = { id: `${state.pending.id}:${state.revision + 1}:${kind}${priorId ? ':next' : ''}`,
    kind, actorId, visibility, options: structuredClone(options), defaultSelection: structuredClone(defaultSelection) };
  return state.pending.choice;
}
export function clearChoice(state) { requireRule(state.pending, '没有当前步骤。'); state.pending.choice = null; }
export function completePending(state) {
  const pending = state.pending;
  requireRule(pending && !pending.poolCards.length && goodsCount(pending.goods) === 0 && !pending.receipt, '效果尚有未处理材料。');
  discardCards(state, pending.sourceCards); state.pending = null;
}
export function emit(state, event) { state.lastPublicEvents.push(structuredClone(event)); }

/** Incoming goods already belong to the pending pool, including any auction lot. */
export function receiveGoods(state, actorId, vector) {
  const owner = player(state, actorId), pending = state.pending;
  requireRule(pending && !pending.receipt && validGoods(vector) && GOODS.every(good => pending.goods[good.id] >= vector[good.id]), '待领取货物无效。');
  if (canReceive(owner, goodsCount(vector))) {
    const fee = goodsCount(owner.goods) + goodsCount(vector) > ordinaryCapacity(owner) && !owner.temporaryOccupied ? 2 : 0;
    addSilver(owner, -fee); moveGoods(pending.goods, owner.goods, vector); refreshTemporary(owner); return true;
  }
  pending.receipt = { actorId, goods: { ...vector }, previousTemporary: owner.temporaryOccupied };
  const keep = emptyGoods(); let left = receiptCapacity(owner);
  // Stable default: original material first, then incoming, in fixed content order.
  for (const source of [owner.goods, vector]) for (const good of GOODS) {
    const count = Math.min(left, source[good.id]); keep[good.id] += count; left -= count;
  }
  const combined = Object.fromEntries(GOODS.map(good => [good.id, owner.goods[good.id] + vector[good.id]]));
  setChoice(state, { kind: 'retain-goods', actorId, visibility: 'private',
    options: [{ combined, ordinaryCapacity: ordinaryCapacity(owner), capacity: receiptCapacity(owner), temporaryFee: owner.temporaryOccupied ? 0 : 2 }], defaultSelection: keep });
  return false;
}
export function resolveReceipt(state, keep) {
  const pending = state.pending, receipt = pending?.receipt;
  requireRule(receipt && validGoods(keep), '请选择要保留的货物。');
  const owner = player(state, receipt.actorId), combined = Object.fromEntries(GOODS.map(good => [good.id, owner.goods[good.id] + receipt.goods[good.id]]));
  requireRule(GOODS.every(good => keep[good.id] <= combined[good.id]) && goodsCount(keep) <= receiptCapacity(owner), '保留数量超出货物或位置。');
  const fee = goodsCount(keep) > ordinaryCapacity(owner) && !receipt.previousTemporary ? 2 : 0;
  addSilver(owner, -fee);
  for (const good of GOODS) {
    pending.goods[good.id] -= receipt.goods[good.id];
    state.bankGoods[good.id] += combined[good.id] - keep[good.id]; owner.goods[good.id] = keep[good.id];
  }
  refreshTemporary(owner); pending.receipt = null; pending.choice = null;
}

/** Public references expire with the state revision and never address a hidden zone. */
export function resolvePublicCardRef(state, ref) {
  const match = /^(tool-[01]|discard|pool|source):(\d+):(\d+)$/u.exec(ref ?? '');
  requireRule(match && Number(match[2]) === state.revision, '公开目标已改变。', 'STALE_REFERENCE');
  const index = Number(match[3]);
  const zone = match[1].startsWith('tool-') ? state.players[Number(match[1].at(-1))].tools.map(tool => tool.cardId)
    : match[1] === 'discard' ? state.discard : match[1] === 'source' ? state.pending?.sourceCards
      : state.pending && (state.pending.kind === 'auction' || ['M02', 'M06', 'T01'].includes(state.pending.code)) ? state.pending.poolCards : null;
  requireRule(Array.isArray(zone) && Number.isSafeInteger(index) && index < zone.length, '公开目标不存在。', 'STALE_REFERENCE');
  return zone[index];
}

/** Shared by real rooms and future practice: public choices use expiring refs. */
export function resolveActionReferences(state, action) {
  function resolve(value, depth = 0) {
    requireRule(depth <= 8, '选择结构过深。');
    if (typeof value === 'string' && /^(?:tool-[01]|discard|pool|source):/u.test(value)) return resolvePublicCardRef(state, value);
    if (Array.isArray(value)) return value.map(item => resolve(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, depth + 1)]));
    return value;
  }
  const result = { ...action };
  for (const field of ['cardId', 'replaceCardId', 'params', 'selection']) if (Object.hasOwn(action, field)) result[field] = resolve(action[field]);
  return result;
}
