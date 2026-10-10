import { GOODS } from './content/definitions.mjs';
import { RuleError, requireRule, definition, player, opponent, emptyGoods, goodsCount,
  addSilver, moveGoods, removeCard, discardCards, drawCards, availableCards, canReceive,
  refreshTemporary, payCard, paymentOptions, createPending, setChoice, clearChoice,
  completePending, receiveGoods, emit } from './model.mjs';

export const implementedToolCodes = Object.freeze(Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`));
const choiceKinds = ['tool-search-payment', 'tool-exchange', 'tool-discard-draw', 'tool-two-cards', null,
  'tool-goods-draw', 'tool-discard-swap', 'tool-payment-silver', 'tool-buy-good', 'tool-payment-good'];
export const TOOL_PENDING_CONTRACTS = Object.freeze(Object.fromEntries(implementedToolCodes.map((code, index) => [code, Object.freeze({
  stages: Object.freeze(['start', 'choosing', 'delivering', 'done']), choiceKind: choiceKinds[index],
  dataKeys: Object.freeze(['toolId', 'borrowed', 'params', ...(code === 'T07' ? ['discardTopId'] : []),
    ...(['T05', 'T09'].includes(code) ? ['paidSilver'] : [])]), publicPool: code === 'T01',
})])));
const goodIds = GOODS.map(good => good.id);
const sorted = values => [...values].sort();
const singleGood = id => ({ ...emptyGoods(), [id]: 1 });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const selectedGoods = goods => goodIds.filter(id => goods[id] > 0);
const samePayment = (a, b) => a?.zone === b?.zone && a?.cardId === b?.cardId;
const paymentsFor = (state, id) => [...paymentOptions(state, id)].sort((a, b) => a.cardId.localeCompare(b.cardId) || a.zone.localeCompare(b.zone));
const selectionKeys = {
  T01: ['kind', 'cardId'], T02: ['ownGoodId', 'otherGoodId'], T03: ['cardIds'], T04: ['cardId'],
  T05: [], T06: ['goodId'], T07: ['cardId'], T08: ['payment'], T09: ['goodId'], T10: ['goodId', 'payment'],
};

function effectProblem(state, ownerId, copyId, { borrowed = false, checkOrientation = true } = {}) {
  const card = definition(copyId), owner = player(state, ownerId);
  if (card.category !== 'tool') return '请选择道具。';
  const code = card.sourceCode;
  if (!implementedToolCodes.includes(code)) return '道具效果尚未支持。';
  if (borrowed && code === 'T07') return '纸上仙只能拆除，不能借用。';
  if (!borrowed && checkOrientation) {
    const installed = owner.tools.find(tool => tool.cardId === copyId);
    if (!installed || installed.exhausted) return '请选择自己尚未使用的道具。';
  }
  if (code === 'T07') {
    if (state.stage !== 'draw' || state.drawStarted) return '纸上仙只能在第一次普通看牌之前使用。';
  } else if (!borrowed && state.stage !== 'use') return '请先结束取牌阶段。';
  const available = availableCards(state), goods = goodsCount(owner.goods);
  switch (code) {
    case 'T01': return available < 1 || owner.silver < 1 && !owner.hand.length ? '需要可搜索的牌，以及1两或1张手牌。' : null;
    case 'T02': return !goods || !goodsCount(opponent(state, ownerId).goods) ? '双方各有至少1件货物才能交换。' : null;
    case 'T03': return !owner.hand.length ? '至少需要1张可弃手牌。' : null;
    case 'T04': return available < 2 ? '两仪灯需要至少2张可抽牌。' : null;
    case 'T05': return available < 1 || owner.silver < 1 ? '需要1两和至少1张可抽牌。' : null;
    case 'T06': return !goods || available < 1 ? '需要自己的1件货物和可抽牌。' : null;
    case 'T07': return !owner.hand.length || !state.discard.length ? '需要自己的手牌和弃牌顶牌。' : null;
    case 'T08': return !paymentOptions(state, ownerId).length ? '没有可牺牲的自己的牌。'
      : !Number.isSafeInteger(owner.silver + 2) ? '银两已达到可保存范围。' : null;
    case 'T09': return !goodsCount(state.bankGoods) || !canReceive(owner, 1, 2) ? '需要2两、货源及可负担的位置。' : null;
    case 'T10': return !goodsCount(state.bankGoods) || !paymentOptions(state, ownerId).length || !canReceive(owner, 1, 0)
      ? '需要自己的支付牌、货源及可负担的位置。' : null;
    default: return '道具效果尚未支持。';
  }
}

export function toolProblem(state, ownerId, copyId, params = {}, options = {}) {
  try {
    const code = definition(copyId).sourceCode;
    if (!plain(params) || Object.keys(params).some(key => !selectionKeys[code]?.includes(key))) return '道具选择参数无效。';
    return effectProblem(state, ownerId, copyId, options);
  } catch (error) {
    if (error instanceof RuleError || error instanceof RangeError) return '道具或使用者无效。';
    throw error;
  }
}

/** Root has already charged the action and exhausted a normally installed tool. */
export function startTool(state, copyId, params = {}, ctx, { borrowed = false } = {}) {
  const ownerId = borrowed ? state.pending?.ownerId : state.turnPlayerId;
  requireRule(ownerId && !effectProblem(state, ownerId, copyId, { borrowed, checkOrientation: false }), '道具当前不能发动。');
  const code = definition(copyId).sourceCode;
  requireRule(plain(params) && Object.keys(params).every(key => selectionKeys[code].includes(key)), '道具选择参数无效。');
  if (borrowed) {
    requireRule(state.pending && !state.pending.poolCards.length && !goodsCount(state.pending.goods)
      && !state.pending.receipt && !state.pending.response, '外层人物尚未结清。');
    Object.assign(state.pending, { kind: 'tool', code, stage: 'start', choice: null,
      data: { toolId: copyId, borrowed: true, params: structuredClone(params) } });
  } else createPending(state, { kind: 'tool', ownerId, code, data: { toolId: copyId, borrowed: false, params: structuredClone(params) } });
  continueTool(state, ctx);
  if (state.pending?.kind === 'tool' && state.pending.choice && Object.keys(params).length) {
    chooseTool(state, params, ctx);
  }
}

function choose(state, kind, options, defaultSelection, visibility = 'private') {
  state.pending.stage = 'choosing';
  setChoice(state, { kind, actorId: state.pending.ownerId, visibility, options, defaultSelection });
}
function finish(state) {
  state.pending.stage = 'done'; completePending(state);
}
function paySearchOptions(owner) {
  return [...(owner.silver >= 1 ? [{ kind: 'silver' }] : []), ...sorted(owner.hand).map(cardId => ({ kind: 'card', cardId }))];
}

/** Only the saved stage may proceed, so reopening a choice never pays or draws again. */
export function continueTool(state, ctx) {
  const pending = state.pending;
  requireRule(pending?.kind === 'tool', '没有待结算的道具。');
  if (pending.choice || pending.receipt) return;
  if (pending.stage === 'delivering' || pending.stage === 'done') { finish(state); return; }
  requireRule(pending.stage === 'start', '道具步骤无效。');
  const owner = player(state, pending.ownerId), code = pending.code;
  if (code === 'T01') {
    // Revealed misses stay outside the discard/reshuffle pool until searching
    // ends, so every eligible entity can be inspected at most once.
    const revealed = [];
    while (availableCards(state) > 0) {
      const [cardId] = drawCards(state, 1, ctx);
      if (!cardId) break;
      pending.poolCards.push(cardId); revealed.push(definition(cardId).id);
      if (definition(cardId).category === 'goods') break;
    }
    if (revealed.length) emit(state, { type: 'search-revealed', actorSeatId: owner.id, cardIds: revealed });
    const found = pending.poolCards.at(-1);
    if (!found || definition(found).category !== 'goods') {
      discardCards(state, pending.poolCards.splice(0)); finish(state); return;
    }
    discardCards(state, pending.poolCards.splice(0, pending.poolCards.length - 1));
    const options = paySearchOptions(owner);
    choose(state, 'tool-search-payment', options, options[0]); return;
  }
  if (code === 'T02') {
    const ownGoods = selectedGoods(owner.goods), otherGoods = selectedGoods(opponent(state, owner.id).goods);
    choose(state, 'tool-exchange', [{ ownGoodIds: ownGoods, otherGoodIds: otherGoods }],
      { ownGoodId: ownGoods[0], otherGoodId: otherGoods[0] }, 'public'); return;
  }
  if (code === 'T03') {
    const cardIds = sorted(owner.hand);
    choose(state, 'tool-discard-draw', [{ cardIds, min: 1, max: Math.min(2, cardIds.length) }], { cardIds: [cardIds[0]] }); return;
  }
  if (code === 'T04') {
    pending.poolCards.push(...drawCards(state, 2, ctx));
    requireRule(pending.poolCards.length === 2, '两仪灯的两张牌不完整。');
    const options = sorted(pending.poolCards).map(cardId => ({ cardId }));
    choose(state, 'tool-two-cards', options, options[0]); return;
  }
  if (code === 'T05') {
    addSilver(owner, -1); pending.data.paidSilver = 1;
    owner.hand.push(...drawCards(state, 1, ctx)); finish(state); return;
  }
  if (code === 'T06') {
    const options = selectedGoods(owner.goods).map(goodId => ({ goodId }));
    choose(state, 'tool-goods-draw', options, options[0], 'public'); return;
  }
  if (code === 'T07') {
    const options = sorted(owner.hand).map(cardId => ({ cardId }));
    pending.data.discardTopId = state.discard.at(-1);
    choose(state, 'tool-discard-swap', options, options[0]); return;
  }
  if (code === 'T08') {
    const options = paymentsFor(state, owner.id).map(payment => ({ payment }));
    choose(state, 'tool-payment-silver', options, options[0]); return;
  }
  if (code === 'T09') {
    const options = selectedGoods(state.bankGoods).map(goodId => ({ goodId }));
    choose(state, 'tool-buy-good', options, options[0], 'public'); return;
  }
  if (code === 'T10') {
    const goodIds = selectedGoods(state.bankGoods), payments = paymentsFor(state, owner.id);
    choose(state, 'tool-payment-good', [{ goodIds, payments }], { goodId: goodIds[0], payment: payments[0] }); return;
  }
  requireRule(false, '道具步骤无效。');
}

export function chooseTool(state, selection, ctx) {
  const pending = state.pending;
  requireRule(pending?.kind === 'tool' && pending.choice && !pending.receipt && pending.stage === 'choosing', '没有这个道具选择。');
  const owner = player(state, pending.ownerId), code = pending.code;
  if (code === 'T01') {
    requireRule((exact(selection, ['kind']) && selection.kind === 'silver' && owner.silver >= 1)
      || (exact(selection, ['kind', 'cardId']) && selection.kind === 'card' && owner.hand.includes(selection.cardId)), '请选择可支付的1两或自己的手牌。');
    if (selection.kind === 'silver') addSilver(owner, -1);
    else { removeCard(owner.hand, selection.cardId); discardCards(state, [selection.cardId]); }
    const target = pending.poolCards.pop();
    requireRule(target && definition(target).category === 'goods', '搜索目标已变化。');
    owner.hand.push(target); discardCards(state, pending.poolCards.splice(0));
  } else if (code === 'T02') {
    const other = opponent(state, owner.id);
    requireRule(exact(selection, ['ownGoodId', 'otherGoodId']) && goodIds.includes(selection.ownGoodId)
      && goodIds.includes(selection.otherGoodId) && owner.goods[selection.ownGoodId] > 0 && other.goods[selection.otherGoodId] > 0, '请选择双方现有的各1件货物。');
    const own = singleGood(selection.ownGoodId), theirs = singleGood(selection.otherGoodId);
    moveGoods(owner.goods, pending.goods, own); moveGoods(other.goods, pending.goods, theirs);
    moveGoods(pending.goods, owner.goods, theirs); moveGoods(pending.goods, other.goods, own);
    // An equal exchange retains the original final occupancy, without charging
    // either player's already occupied temporary space a second time.
    refreshTemporary(owner); refreshTemporary(other);
  } else if (code === 'T03') {
    requireRule(exact(selection, ['cardIds']) && Array.isArray(selection.cardIds) && selection.cardIds.length >= 1
      && selection.cardIds.length <= 2 && new Set(selection.cardIds).size === selection.cardIds.length
      && selection.cardIds.every(cardId => owner.hand.includes(cardId)), '请选择自己的1或2张不同手牌。');
    for (const cardId of selection.cardIds) removeCard(owner.hand, cardId);
    discardCards(state, selection.cardIds, { sort: true });
    owner.hand.push(...drawCards(state, selection.cardIds.length, ctx));
  } else if (code === 'T04') {
    requireRule(exact(selection, ['cardId']) && pending.poolCards.includes(selection.cardId) && pending.poolCards.length === 2, '请选择原来的两张候选之一。');
    removeCard(pending.poolCards, selection.cardId); owner.hand.push(selection.cardId);
    opponent(state, owner.id).hand.push(...pending.poolCards.splice(0));
  } else if (code === 'T06') {
    requireRule(exact(selection, ['goodId']) && goodIds.includes(selection.goodId) && owner.goods[selection.goodId] > 0, '请选择自己的1件库存。');
    moveGoods(owner.goods, state.bankGoods, singleGood(selection.goodId)); refreshTemporary(owner);
    owner.hand.push(...drawCards(state, 1, ctx));
  } else if (code === 'T07') {
    requireRule(exact(selection, ['cardId']) && owner.hand.includes(selection.cardId)
      && state.discard.at(-1) === pending.data.discardTopId, '手牌或弃牌顶已经变化。');
    removeCard(owner.hand, selection.cardId); owner.hand.push(state.discard.pop()); discardCards(state, [selection.cardId]);
  } else if (code === 'T08') {
    requireRule(exact(selection, ['payment']) && paymentOptions(state, owner.id).some(option => samePayment(option, selection.payment)), '请选择自己可牺牲的牌。');
    payCard(state, owner.id, selection.payment); addSilver(owner, 2);
  } else if (code === 'T09' || code === 'T10') {
    requireRule(exact(selection, code === 'T09' ? ['goodId'] : ['goodId', 'payment']) && goodIds.includes(selection.goodId)
      && state.bankGoods[selection.goodId] > 0 && canReceive(owner, 1, code === 'T09' ? 2 : 0), '货源、成本或可用位置不足。');
    if (code === 'T10') {
      requireRule(paymentOptions(state, owner.id).some(option => samePayment(option, selection.payment)), '请选择自己可牺牲的牌。');
      payCard(state, owner.id, selection.payment);
    } else { addSilver(owner, -2); pending.data.paidSilver = 2; }
    moveGoods(state.bankGoods, pending.goods, singleGood(selection.goodId));
    clearChoice(state); pending.stage = 'delivering';
    requireRule(receiveGoods(state, owner.id, { ...pending.goods }), '道具不能丢弃原库存腾位置。');
    continueTool(state, ctx); return;
  } else requireRule(false, '道具选择无效。');
  clearChoice(state); finish(state);
}
