// Versioned v3 expansion engine derived from the accepted 1f51a0 rules.
// Existing v1/v2 saves keep their original rules and material boundaries.
/** Game-specific material operations. Call only on a candidate clone. */
import { configuredDefinitionId, materialProfileFor, getCard, GOODS, MULTIPLAYER_RULE_VERSION } from './material.mjs';
import {refinedWithdrawal} from '../trade-contract.mjs';
export const DEFAULT_ACTION_LIMIT = 5;
export const DEFAULT_GOODS_PER_TYPE = 8;
export const LEGACY_GOODS_PER_TYPE = 6;
export const MIN_GOODS_PER_TYPE = 4;
export const MAX_GOODS_PER_TYPE = 20;
export const validActionLimit = value => Number.isSafeInteger(value) && value >= 1 && value <= 10;
export const idleRewardThreshold = actionLimit => Math.round(actionLimit / 2);
// Eligibility is shared by authority, presentation and the practice bot;
// voluntary ending and the mandatory first peek remain rule-layer guards.
export const qualifiesForIdleReward = ({ actionLimit, actionsUsed }) => actionsUsed <= idleRewardThreshold(actionLimit);
export const validGoodsPerType = value => Number.isSafeInteger(value) && value >= MIN_GOODS_PER_TYPE && value <= MAX_GOODS_PER_TYPE;
// Absence identifies an old frozen configuration, never a request to refill it.
export const goodsPerTypeOf = value => Object.hasOwn(value, 'goodsPerType') ? value.goodsPerType : LEGACY_GOODS_PER_TYPE;
export class RuleError extends Error {
  constructor(message, code = 'ILLEGAL_ACTION') { super(message); this.name = 'RuleError'; this.code = code; }
}
export function requireRule(condition, message, code) { if (!condition) throw new RuleError(message, code); }
export function definition(copyId) {
  const id = configuredDefinitionId(copyId);
  requireRule(id !== null, '这张牌不存在。'); return getCard(id);
}
export const emptyGoods = () => Object.fromEntries(GOODS.map(good => [good.id, 0]));
export const goodsCount = vector => Object.values(vector).reduce((sum, count) => sum + count, 0);
export const goodsEntries = vector => GOODS.map(good => [good.id, vector[good.id]]).filter(([, count]) => count > 0);
export function validGoods(vector) {
  return vector && typeof vector === 'object' && !Array.isArray(vector) && Object.keys(vector).length === GOODS.length
    && GOODS.every(good => Number.isSafeInteger(vector[good.id]) && vector[good.id] >= 0 && vector[good.id] <= MAX_GOODS_PER_TYPE);
}
export function player(state, id) {
  const value = state.players.find(entry => entry.id === id);
  requireRule(value, '你不是本局参赛者。', 'SEAT_REQUIRED'); return value;
}
export const isMultiplayer = state => state.ruleVersion === MULTIPLAYER_RULE_VERSION;
export function opponent(state, id, targetId = state.pending?.data?.targetId) {
  player(state, id);
  if (state.players.length === 2 && targetId === undefined) targetId = state.players.find(entry => entry.id !== id).id;
  requireRule(targetId !== id && state.players.some(entry => entry.id === targetId), '请选择一位其他参赛者。', 'TARGET_REQUIRED');
  return player(state, targetId);
}
export const pairIds = (state, id) => [id, opponent(state, id).id];
/** Stable clockwise order, independent of page focus, online transport and names. */
export function clockwiseIds(state, id) {
  const index = state.players.findIndex(entry => entry.id === id);
  requireRule(index >= 0, '轮序席位不存在。');
  return Array.from({ length: state.players.length - 1 }, (_, offset) => state.players[(index + offset + 1) % state.players.length].id);
}
export function beginMerchantResponse(state, tradeCardId) {
  const pending = state.pending, remainingIds = clockwiseIds(state, pending.ownerId);
  pending.response = { kind: 'merchant', actorId: remainingIds[0], tradeCardId,
    ...(isMultiplayer(state) ? { remainingIds, remainingMs: 60_000 } : {}) };
  skipUnavailableMerchantResponses(state);
}
/** One authoritative eligibility check for opening, presenting and accepting a reply. */
export function legalResponseCards(state, response = state.pending?.response) {
  const pending = state.pending, actor = state.players.find(owner => owner.id === response?.actorId);
  if (!pending || !response || !actor || actor.id === pending.ownerId) return [];
  let code;
  if (response.kind === 'counter') {
    const targetId = isMultiplayer(state) ? pending.data.targetId : state.players.find(owner => owner.id !== pending.ownerId)?.id;
    if (!['character','role'].includes(pending.kind) || pending.stage !== 'start' || actor.id !== targetId
        || response.tradeCardId !== null || !(pending.kind==='role'&&['R23','R24'].includes(pending.code)||pending.sourceCards.some(id => {
          const face = definition(id); return face.sourceCode === pending.code && face.cancelableByJinyiwei;
        }))) return [];
    code = 'C07';
  } else if (response.kind === 'merchant') {
    if (pending.stage !== 'merchant' || !(pending.kind === 'trade' && ['buy', 'sell'].includes(pending.code)
        || pending.kind === 'character' && pending.code === 'C05')
        || !pending.sourceCards.includes(response.tradeCardId) || definition(response.tradeCardId).category !== 'goods') return [];
    code = 'C04';
  } else return [];
  // Neither response costs silver, goods, capacity or an action. Only a held card
  // at its actual response timing is legal; a matching card elsewhere is not.
  return actor.hand.filter(id => definition(id).sourceCode === code);
}
/** Keep the existing clockwise suffix persistence shape and shared time budget. */
export function skipUnavailableMerchantResponses(state) {
  const response = state.pending?.response;
  if (response?.kind !== 'merchant') return;
  while (!legalResponseCards(state, response).length) {
    if (!isMultiplayer(state) || response.remainingIds.length <= 1) { state.pending.response = null; return; }
    response.remainingIds.shift(); response.actorId = response.remainingIds[0];
  }
}
export function closeWinnerId(state) {
  const first = state.players.findIndex(owner => owner.id === state.firstPlayerId);
  const maximum = Math.max(...state.players.map(owner => owner.silver));
  // Break ties only among the wealth leaders, in this round's frozen order.
  return Array.from({ length: state.players.length }, (_, offset) => state.players[(first + offset) % state.players.length])
    .filter(owner => owner.silver === maximum).at(-1).id;
}
export function addSilver(owner, delta) {
  requireRule(Number.isSafeInteger(delta) && Number.isSafeInteger(owner.silver + delta) && owner.silver + delta >= 0, '银两不足或超出可保存范围。');
  owner.silver += delta;
}
export const bankStock = state => ({goods:state.bankGoods});
export function checkedRefinedWithdrawal(stock,goods,refined){
  try{return refinedWithdrawal(stock,goods,refined);}
  catch(error){if(error instanceof RangeError)throw new RuleError(error.message);throw error;}
}
export function moveGoods(from, to, vector, refined) {
  requireRule(validGoods(vector) && GOODS.every(({id}) => from.goods[id] >= vector[id]
    && to.goods[id] + vector[id] <= MAX_GOODS_PER_TYPE), '货物不足或数量无效。');
  const movedRefined=from.refined!==undefined||refined!==undefined?checkedRefinedWithdrawal(from,vector,refined):null;
  for (const {id} of GOODS) {
    from.goods[id] -= vector[id]; to.goods[id] += vector[id];
    if(from.refined!==undefined)from.refined[id] -= movedRefined[id];
    if(to.refined!==undefined&&movedRefined)to.refined[id] += movedRefined[id];
  }
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
  requireRule(Number.isSafeInteger(count) && count >= 0 && count <= materialProfileFor(state).deckSize, '抽牌数量无效。');
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
export const ordinaryCapacity = owner => 5 + owner.stallCount * 3 + (owner.roleId==='yousei.role.r10'?1:0);
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
    sourceCards: [...sourceCards], poolCards: [], goods: emptyGoods(), data: structuredClone(data), choice: null, response: null, receipt: null,
    ...(state.configuration?.modules?.refining?{refined:emptyGoods()}:{}),
  };
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
  requireRule(pending && !pending.poolCards.length && goodsCount(pending.goods) === 0
    && (!pending.refined||goodsCount(pending.refined)===0) && !pending.receipt, '效果尚有未处理材料。');
  discardCards(state, pending.sourceCards); state.pending = null;
}
export function emit(state, event) { state.lastPublicEvents.push(structuredClone(event)); }

/** Incoming goods already belong to the pending pool, including any auction lot. */
export function receiveGoods(state, actorId, vector) {
  const owner = player(state, actorId), pending = state.pending;
  requireRule(pending && !pending.receipt && validGoods(vector) && GOODS.every(good => pending.goods[good.id] >= vector[good.id]), '待领取货物无效。');
  if (canReceive(owner, goodsCount(vector))) {
    const fee = goodsCount(owner.goods) + goodsCount(vector) > ordinaryCapacity(owner) && !owner.temporaryOccupied ? 2 : 0;
    addSilver(owner, -fee); moveGoods(pending, owner, vector); refreshTemporary(owner); return true;
  }
  pending.receipt = { actorId, goods: { ...vector }, previousTemporary: owner.temporaryOccupied };
  const keep = emptyGoods(); let left = receiptCapacity(owner);
  const incomingRefined=owner.refined?checkedRefinedWithdrawal(pending,vector):null;
  const keepRefined=owner.refined?emptyGoods():null;
  // Stable default: original material first, then incoming, in fixed content order.
  for (const [source,quality] of [[owner.goods,owner.refined],[vector,incomingRefined]]) for (const good of GOODS) {
    const count = Math.min(left, source[good.id]); keep[good.id] += count; left -= count;
    if(quality)keepRefined[good.id]+=Math.max(0,count-(source[good.id]-quality[good.id]));
  }
  const combined = Object.fromEntries(GOODS.map(good => [good.id, owner.goods[good.id] + vector[good.id]]));
  const refined=owner.refined?combinedRefinedStock(owner,incomingRefined):null;
  const option={combined,ordinaryCapacity:ordinaryCapacity(owner),capacity:receiptCapacity(owner),temporaryFee:owner.temporaryOccupied?0:2};
  setChoice(state, { kind: 'retain-goods', actorId, visibility: 'private',
    options:[{...option,...(refined?{refined}:{})}],
    defaultSelection:refined?{goods:keep,refined:keepRefined}:keep });
  return false;
}
export function combinedRefinedStock(owner,incomingRefined){
  return Object.fromEntries(GOODS.map(({id})=>[id,owner.refined[id]+incomingRefined[id]]));
}
export function resolveReceipt(state, keep, keepRefined) {
  const pending = state.pending, receipt = pending?.receipt;
  requireRule(receipt && validGoods(keep), '请选择要保留的货物。');
  const owner = player(state, receipt.actorId), combined = Object.fromEntries(GOODS.map(good => [good.id, owner.goods[good.id] + receipt.goods[good.id]]));
  requireRule(GOODS.every(good => keep[good.id] <= combined[good.id]) && goodsCount(keep) <= receiptCapacity(owner), '保留数量超出货物或位置。');
  let retainedRefined, incomingRefined;
  if(owner.refined!==undefined){
    incomingRefined=checkedRefinedWithdrawal(pending,receipt.goods);
    const combinedRefined=combinedRefinedStock(owner,incomingRefined);
    retainedRefined=checkedRefinedWithdrawal({goods:combined,refined:combinedRefined},keep,keepRefined);
  }
  const fee = goodsCount(keep) > ordinaryCapacity(owner) && !receipt.previousTemporary ? 2 : 0;
  addSilver(owner, -fee);
  for (const good of GOODS) {
    pending.goods[good.id] -= receipt.goods[good.id];
    state.bankGoods[good.id] += combined[good.id] - keep[good.id]; owner.goods[good.id] = keep[good.id];
    if(retainedRefined){
      pending.refined[good.id] -= incomingRefined[good.id];
      owner.refined[good.id] = retainedRefined[good.id];
    }
  }
  refreshTemporary(owner); pending.receipt = null; pending.choice = null;
}

/** Public references expire with the state revision and never address a hidden zone. */
export function resolvePublicCardRef(state, ref) {
  const match = /^(tool-[0-5]|discard|pool|source):(\d+):(\d+)$/u.exec(ref ?? '');
  requireRule(match && Number(match[2]) === state.revision, '公开目标已改变。', 'STALE_REFERENCE');
  const index = Number(match[3]);
  const zone = match[1].startsWith('tool-') ? state.players[Number(match[1].at(-1))]?.tools.map(tool => tool.cardId)
    : match[1] === 'discard' ? state.discard : match[1] === 'source' ? state.pending?.sourceCards
      : state.pending && (state.pending.kind === 'auction' || ['M02', 'M06', 'T01'].includes(state.pending.code)) ? state.pending.poolCards : null;
  requireRule(Array.isArray(zone) && Number.isSafeInteger(index) && index < zone.length, '公开目标不存在。', 'STALE_REFERENCE');
  return zone[index];
}

/** Shared by real rooms and future practice: public choices use expiring refs. */
export function resolveActionReferences(state, action) {
  function resolve(value, depth = 0) {
    requireRule(depth <= 8, '选择结构过深。');
    if (typeof value === 'string' && /^(?:tool-[0-5]|discard|pool|source):/u.test(value)) return resolvePublicCardRef(state, value);
    if (Array.isArray(value)) return value.map(item => resolve(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, depth + 1)]));
    return value;
  }
  const result = { ...action };
  for (const field of ['cardId', 'replaceCardId', 'params', 'selection']) if (Object.hasOwn(action, field)) result[field] = resolve(action[field]);
  return result;
}
