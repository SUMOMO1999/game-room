/** Persisted game validation. This module is pure and never repairs untrusted saves. */
import { CARDS, GOODS, createDeck, CONTENT_VERSION, DIGITAL_RULE_VERSION } from './content/definitions.mjs';
import { hyakkiTimingProblem } from './lifecycle.mjs';
import { CHARACTER_PENDING_CONTRACTS } from './effects.mjs';
import { TOOL_PENDING_CONTRACTS } from './tools.mjs';
import { AUCTION_PENDING_CONTRACT } from './auction.mjs';
import { currentDecision } from './decision.mjs';
import { MAX_GOODS_PER_TYPE, goodsPerTypeOf, validGoodsPerType } from './model.mjs';

export const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const exactFields = (value, fields) => plainObject(value) && Reflect.ownKeys(value).length === fields.length
  && fields.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
export const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
export const seatId = value => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/\p{Cc}/u.test(value);
const copies = new Map(createDeck().map(copy => [copy.id, copy.definitionId]));
const definitions = new Map(CARDS.map(card => [card.id, card]));
const goodsIds = GOODS.map(good => good.id);
export const validCopy = value => typeof value === 'string' && copies.has(value);
export const cardDefinition = copyId => definitions.get(copies.get(copyId));
export const goodsVector = value => exactFields(value, goodsIds) && goodsIds.every(id => integer(value[id], 0, MAX_GOODS_PER_TYPE));
const countGoods = vector => goodsIds.reduce((total, id) => total + vector[id], 0);
const uniqueCopies = value => Array.isArray(value) && value.length <= 110 && value.every(validCopy) && new Set(value).size === value.length;
const boundedJson = (value, depth = 0) => depth <= 8 && (value === null || typeof value === 'boolean'
  || typeof value === 'string' && value.length <= 256 || integer(value, -Number.MAX_SAFE_INTEGER)
  || Array.isArray(value) && value.length <= 110 && value.every(item => boundedJson(item, depth + 1))
  || plainObject(value) && Reflect.ownKeys(value).length <= 20 && Object.entries(value).every(([key, item]) =>
    /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(key) && boundedJson(item, depth + 1)));

const eventFields = {
  'match-started': [], 'draw-peeked': ['actorSeatId'], 'draw-kept': ['actorSeatId'],
  'draw-discarded': ['actorSeatId', 'cardId'], 'draw-finished': ['actorSeatId'],
  'trade-bought': ['actorSeatId', 'cardId', 'goods', 'silver'], 'trade-sold': ['actorSeatId', 'cardId', 'goods', 'silver'],
  'stall-expanded': ['actorSeatId', 'silver', 'count'], 'character-played': ['actorSeatId', 'cardId', 'targetSeatId'],
  'tool-installed': ['actorSeatId', 'cardId'], 'tool-activated': ['actorSeatId', 'cardId', 'targetSeatId'],
  'response-played': ['actorSeatId', 'cardId'], 'response-declined': ['actorSeatId'],
  'choice-resolved': ['actorSeatId', 'targetSeatId', 'count'], 'auction-revealed': ['actorSeatId', 'cardIds', 'goods'],
  'cards-revealed': ['actorSeatId', 'cardIds'], 'search-revealed': ['actorSeatId', 'cardIds'],
  'bid-raised': ['actorSeatId', 'silver'], 'bid-passed': ['actorSeatId'],
  'auction-settled': ['actorSeatId', 'targetSeatId', 'silver', 'cardIds', 'goods'],
  'turn-ended': ['actorSeatId'], paused: [], resumed: [], suspended: ['reason'], 'pending-closed': ['reason'],
  'match-ended': ['reason', 'winnerSeatId'],
};
const endReasons = ['voluntary-leave', 'normal-close', 'absence-expired', 'room-expired', 'cancelled'];
const eventReasons = [...endReasons, 'capacity', 'disconnected', 'server-recovery'];
function publicEvent(value, ids, goodsPerType) {
  const fields = eventFields[value?.type];
  if (!fields || !plainObject(value) || Object.keys(value).some(key => key !== 'type' && !fields.includes(key))) return false;
  if (fields.includes('actorSeatId') && !ids.includes(value.actorSeatId)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith('SeatId') && !(key === 'winnerSeatId' && item === null) && !ids.includes(item)) return false;
    if (key === 'cardId' && !definitions.has(item)) return false;
    if (key === 'cardIds' && (!Array.isArray(item) || item.length > 110 || !item.every(id => definitions.has(id)))) return false;
    if (key === 'goods' && (!Array.isArray(item) || item.length > 6 || new Set(item.map(good => good?.id)).size !== item.length
      || item.some(good => !exactFields(good, ['id', 'count']) || !goodsIds.includes(good.id) || !integer(good.count, 0, goodsPerType)))) return false;
    if (key === 'silver' && !integer(item) || key === 'count' && !integer(item, 0, 110) || key === 'reason' && !eventReasons.includes(item)) return false;
  }
  return !['suspended', 'pending-closed', 'match-ended'].includes(value.type) || eventReasons.includes(value.reason);
}

const stateFields = ['version', 'gameType', 'ruleVersion', 'contentVersion', 'matchId', 'players', 'deck', 'discard', 'bankGoods',
  'availableStalls', 'purchasedStalls', 'status', 'result', 'firstPlayerId', 'turnPlayerId', 'turnIndex', 'turnNumber', 'turnId', 'round',
  'stage', 'actionsUsed', 'actionLimit', 'drawStarted', 'bookLayers', 'closing', 'revision', 'publicEventSequence', 'lastPublicEvents',
  'committedAt', 'timing', 'lifecycle', 'pending'];
const playerFields = ['id', 'hand', 'tools', 'goods', 'silver', 'stallCount', 'temporaryOccupied'];
const pendingFields = ['id', 'kind', 'ownerId', 'code', 'stage', 'sourceCards', 'poolCards', 'goods', 'data', 'choice', 'response', 'receipt'];

function subsetFields(value, fields) {
  return plainObject(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : plainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const oneOf = (value, options) => options.some(option => same(value, option));
const ownHand = (state, id) => state.players.find(player => player.id === id).hand;
const ownTools = (state, id) => state.players.find(player => player.id === id).tools.map(tool => tool.cardId);
const legalPayment = (state, id, value) => exactFields(value, ['zone', 'cardId'])
  && (value.zone === 'hand' ? ownHand(state, id) : value.zone === 'tool' ? ownTools(state, id) : []).includes(value.cardId);
const cardSelection = (value, zone) => exactFields(value, ['cardId']) && zone.includes(value.cardId);
const goodSelection = (value, key, stock) => exactFields(value, [key]) && goodsIds.includes(value[key]) && stock[value[key]] > 0;
function choiceProblem(state, pending) {
  const choice = pending.choice; if (!choice) return null;
  const publicChoices = ['exchange', 'recover-tool', 'draft-card', 'keep-tool', 'draft-good', 'draft-tool',
    'tool-exchange', 'tool-goods-draw', 'tool-buy-good'];
  if (choice.visibility !== (publicChoices.includes(choice.kind) ? 'public' : 'private')) return '保存的选择可见范围无效。';
  const owner = state.players.find(player => player.id === pending.ownerId), peer = state.players.find(player => player.id !== owner.id);
  const actor = state.players.find(player => player.id === choice.actorId), options = choice.options, selected = choice.defaultSelection;
  const everyOption = check => options.every(check) && check(selected) && oneOf(selected, options);
  let valid = false;
  switch (choice.kind) {
    case 'peek': valid = everyOption(value => exactFields(value, ['keep']) && typeof value.keep === 'boolean'); break;
    case 'benefit-branch': valid = everyOption(value => exactFields(value, ['branch']) && ['draw', 'goods'].includes(value.branch)); break;
    case 'hand-branch': valid = everyOption(value => exactFields(value, ['branch']) && ['draw', 'discard'].includes(value.branch)
      && (value.branch === 'draw' ? owner.hand.length < 5 && state.deck.length + state.discard.length > 0 : peer.hand.length > 3)); break;
    case 'tribute-branch': valid = actor.id === peer.id && everyOption(value => exactFields(value, ['branch']) && ['pay', 'draw'].includes(value.branch)
      && (value.branch === 'pay' ? peer.silver >= 2 && Number.isSafeInteger(owner.silver + 2) : state.deck.length + state.discard.length > 0)); break;
    case 'benefit-good': case 'artisan-good': valid = everyOption(value => goodSelection(value, 'goodsId', state.bankGoods)
      && (choice.kind !== 'artisan-good' || state.bankGoods[value.goodsId] >= 2)); break;
    case 'draft-good': valid = everyOption(value => goodSelection(value, 'goodsId', pending.goods)); break;
    case 'tool-goods-draw': valid = everyOption(value => goodSelection(value, 'goodId', owner.goods)); break;
    case 'tool-buy-good': valid = everyOption(value => goodSelection(value, 'goodId', state.bankGoods)); break;
    case 'take-card': case 'draft-card': case 'draft-tool': case 'tool-two-cards':
      valid = everyOption(value => cardSelection(value, pending.poolCards)); break;
    case 'trade-card': valid = everyOption(value => cardSelection(value, owner.hand) && cardDefinition(value.cardId).category === 'goods'
      && Object.values(cardDefinition(value.cardId).goods).reduce((a, b) => a + b, 0) === 3
      && Number.isSafeInteger(owner.silver + cardDefinition(value.cardId).sellSilver + 2 * state.bookLayers)); break;
    case 'recover-tool': valid = everyOption(value => cardSelection(value, state.discard) && cardDefinition(value.cardId).category === 'tool'); break;
    case 'keep-tool': valid = everyOption(value => cardSelection(value, ownTools(state, actor.id))); break;
    case 'return-card': case 'tool-discard-swap': valid = everyOption(value => cardSelection(value, owner.hand)); break;
    case 'borrow-tool': valid = everyOption(value => exactFields(value, ['borrow']) && typeof value.borrow === 'boolean'); break;
    case 'exchange': valid = everyOption(value => exactFields(value, ['fromGoodsId', 'toGoodsId']) && goodsIds.includes(value.fromGoodsId)
      && goodsIds.includes(value.toGoodsId) && value.fromGoodsId !== value.toGoodsId && owner.goods[value.fromGoodsId] > 0
      && state.bankGoods[value.toGoodsId] >= owner.goods[value.fromGoodsId]); break;
    case 'sell-goods': case 'sell-stock': case 'auction-goods': {
      const stock = choice.kind === 'auction-goods' ? state.bankGoods : owner.goods;
      const minimum = choice.kind === 'sell-goods' ? 3 : choice.kind === 'auction-goods' ? 2 : 1;
      const maximum = choice.kind === 'sell-stock' ? Math.min(countGoods(owner.goods), Math.floor((Number.MAX_SAFE_INTEGER - owner.silver) / 2)) : minimum;
      valid = options.length === 1 && exactFields(options[0], ['goods', 'minimum', 'maximum']) && same(options[0].goods, stock)
        && options[0].minimum === minimum && options[0].maximum === maximum && exactFields(selected, ['goods']) && goodsVector(selected.goods)
        && goodsIds.every(id => selected.goods[id] <= stock[id]) && integer(countGoods(selected.goods), minimum, maximum); break;
    }
    case 'discard-hand': case 'tool-discard-draw': {
      const cards = choice.kind === 'discard-hand' ? peer.hand : owner.hand, option = options[0];
      const required = choice.kind === 'discard-hand' ? cards.length - 3 : null;
      valid = options.length === 1 && exactFields(option, required === null ? ['cardIds', 'min', 'max'] : ['cardIds', 'count'])
        && uniqueCopies(option.cardIds) && same([...option.cardIds].sort(), [...cards].sort())
        && (required === null ? option.min === 1 && option.max === Math.min(2, cards.length) : option.count === required && actor.id === peer.id)
        && exactFields(selected, ['cardIds']) && uniqueCopies(selected.cardIds) && selected.cardIds.every(card => cards.includes(card))
        && integer(selected.cardIds.length, required ?? 1, required ?? Math.min(2, cards.length)); break;
    }
    case 'retain-goods': {
      const receipt = pending.receipt, option = options[0], ordinary = 5 + actor.stallCount * 3;
      const capacity = ordinary + (actor.temporaryOccupied || actor.silver >= 2 ? 1 : 0);
      const combined = Object.fromEntries(goodsIds.map(id => [id, actor.goods[id] + (receipt?.goods[id] ?? 0)]));
      valid = receipt !== null && options.length === 1 && exactFields(option, ['combined', 'ordinaryCapacity', 'capacity', 'temporaryFee'])
        && same(option.combined, combined) && option.ordinaryCapacity === ordinary && option.capacity === capacity
        && option.temporaryFee === (actor.temporaryOccupied ? 0 : 2) && goodsVector(selected)
        && goodsIds.every(id => selected[id] <= combined[id]) && countGoods(selected) <= capacity; break;
    }
    case 'tool-search-payment': valid = everyOption(value => exactFields(value, ['kind']) && value.kind === 'silver' && owner.silver >= 1
      || exactFields(value, ['kind', 'cardId']) && value.kind === 'card' && owner.hand.includes(value.cardId)); break;
    case 'tool-exchange': {
      const option = options[0];
      valid = options.length === 1 && exactFields(option, ['ownGoodIds', 'otherGoodIds'])
        && same(option.ownGoodIds, goodsIds.filter(id => owner.goods[id] > 0)) && same(option.otherGoodIds, goodsIds.filter(id => peer.goods[id] > 0))
        && exactFields(selected, ['ownGoodId', 'otherGoodId']) && option.ownGoodIds.includes(selected.ownGoodId)
        && option.otherGoodIds.includes(selected.otherGoodId); break;
    }
    case 'tool-payment-silver': valid = everyOption(value => exactFields(value, ['payment']) && legalPayment(state, owner.id, value.payment)); break;
    case 'tool-payment-good': {
      const option = options[0];
      valid = options.length === 1 && exactFields(option, ['goodIds', 'payments'])
        && same(option.goodIds, goodsIds.filter(id => state.bankGoods[id] > 0)) && Array.isArray(option.payments) && option.payments.length > 0
        && option.payments.every(payment => legalPayment(state, owner.id, payment)) && exactFields(selected, ['goodId', 'payment'])
        && option.goodIds.includes(selected.goodId) && oneOf(selected.payment, option.payments); break;
    }
    default: return '存档含未知选择类型。';
  }
  return valid ? null : '选择候选或默认项不在当前合法材料中。';
}
function branchProblem(state, pending) {
  const ids = state.players.map(player => player.id), data = pending.data;
  let contract;
  if (pending.kind === 'character') {
    contract = CHARACTER_PENDING_CONTRACTS[pending.code];
    if (!contract || contract.responseOnly || !contract.stages.includes(pending.stage) || !subsetFields(data, contract.data)
        || pending.choice && pending.choice.kind !== 'retain-goods' && !contract.choices.includes(pending.choice.kind)) return '人物步骤或字段无效。';
    if (!pending.sourceCards.some(card => cardDefinition(card).sourceCode === pending.code)) return '人物来源牌缺失。';
    if (pending.sourceCards.length !== (pending.code === 'C05' && data.tradeCardId !== undefined ? 2 : 1)) return '人物来源牌数量无效。';
    if (data.branch !== undefined && !['draw', 'goods'].includes(data.branch) || data.benefitIndex !== undefined && !integer(data.benefitIndex, 0, 2)
        || data.goodsId !== undefined && !goodsIds.includes(data.goodsId) || data.nextActorId !== undefined && !ids.includes(data.nextActorId)
        || data.playerIndex !== undefined && !integer(data.playerIndex, 0, 2)
        || data.tradeCardId !== undefined && !pending.sourceCards.includes(data.tradeCardId)
        || data.toolCardId !== undefined && (!validCopy(data.toolCardId) || cardDefinition(data.toolCardId).category !== 'tool')
        || data.tempPaid !== undefined && (!exactFields(data.tempPaid, ids) || ids.some(id => typeof data.tempPaid[id] !== 'boolean'))) return '人物保存参数无效。';
    if (pending.response?.kind === 'counter' && (pending.stage !== 'start' || pending.poolCards.length || countGoods(pending.goods))) return '反制之前不能移动待决材料。';
    if (pending.poolCards.length && !['C02', 'M02', 'M06'].includes(pending.code)) return '人物含未定义秘密牌区。';
    if (pending.code === 'M06' && pending.poolCards.some(card => cardDefinition(card).category !== 'tool')) return '道具分配池含非道具。';
    const requiredData = {
      C01: pending.stage === 'benefits' ? ['branch', 'benefitIndex'] : [],
      C05: pending.stage === 'start' ? [] : ['tradeCardId'], M01: ['goodsId'],
      M02: pending.stage === 'draft' ? ['nextActorId'] : [], M03: pending.stage === 'keep' ? ['playerIndex'] : [],
      M05: pending.stage === 'draft' ? ['nextActorId', 'tempPaid'] : [], M06: pending.stage === 'draft' ? ['nextActorId'] : [],
      M08: ['toolCardId'],
    }[pending.code] ?? [];
    if (!exactFields(data, requiredData)) return '人物步骤缺少固定参数。';
    if (pending.choice && !pending.receipt) {
      const choiceStages = { 'benefit-branch': 'start', 'benefit-good': 'benefits', 'take-card': 'select',
        'trade-card': 'start', 'sell-goods': 'sell', exchange: 'start', 'hand-branch': 'start', 'discard-hand': 'discard',
        'auction-goods': 'start', 'artisan-good': 'receive', 'recover-tool': 'start', 'sell-stock': 'start',
        'draft-card': 'draft', 'keep-tool': 'keep', 'tribute-branch': 'start', 'draft-good': 'draft',
        'draft-tool': 'draft', 'return-card': 'return', 'borrow-tool': 'borrow' };
      if (pending.stage !== choiceStages[pending.choice.kind]) return '人物选择与已保存步骤不一致。';
      const expectedActor = ['discard-hand', 'tribute-branch'].includes(pending.choice.kind)
        ? ids.find(id => id !== pending.ownerId)
        : ['draft-card', 'draft-good', 'draft-tool'].includes(pending.choice.kind) ? data.nextActorId
          : pending.choice.kind === 'keep-tool' ? [pending.ownerId, ids.find(id => id !== pending.ownerId)][data.playerIndex]
            : pending.choice.kind === 'benefit-good' && data.benefitIndex === 1 ? ids.find(id => id !== pending.ownerId) : pending.ownerId;
      if (pending.choice.actorId !== expectedActor) return '人物选择不属于当前步骤的玩家。';
    }
    if (pending.receipt && !({ C01: ['benefits'], C10: ['done'], M01: ['done'] }[pending.code]?.includes(pending.stage))) return '人物步骤不支持待收货。';
    if (!pending.choice && !pending.response) return '人物保存步骤缺少当前选择。';
    if (pending.poolCards.length && (pending.code === 'C02' ? pending.stage !== 'select' || pending.poolCards.length > 6
        : pending.stage !== 'draft')) return '人物候选牌与步骤不一致。';
    if (!pending.receipt && pending.code !== 'M05' && countGoods(pending.goods) !== 0) return '人物步骤含无归属货物。';
  } else if (pending.kind === 'tool') {
    contract = TOOL_PENDING_CONTRACTS[pending.code];
    if (!contract || !contract.stages.includes(pending.stage) || !subsetFields(data, contract.dataKeys)
        || !validCopy(data.toolId) || cardDefinition(data.toolId).sourceCode !== pending.code || typeof data.borrowed !== 'boolean'
        || !plainObject(data.params) || pending.choice && pending.choice.kind !== contract.choiceKind) return '道具步骤或字段无效。';
    const toolKeys = { T01: ['kind', 'cardId'], T02: ['ownGoodId', 'otherGoodId'], T03: ['cardIds'], T04: ['cardId'],
      T05: [], T06: ['goodId'], T07: ['cardId'], T08: ['payment'], T09: ['goodId'], T10: ['goodId', 'payment'] };
    if (!subsetFields(data.params, toolKeys[pending.code]) || data.discardTopId !== undefined && state.discard.at(-1) !== data.discardTopId
        || data.paidSilver !== undefined && !integer(data.paidSilver, 1, 2)
        || (data.borrowed ? pending.code === 'T07' || pending.sourceCards.length !== 1
          || cardDefinition(pending.sourceCards[0]).sourceCode !== 'M08'
          || !(state.discard.includes(data.toolId) || ['T01', 'T04'].includes(pending.code) && state.deck.includes(data.toolId)
            || pending.code === 'T04' && pending.poolCards.includes(data.toolId))
          : pending.sourceCards.length !== 0 || !state.players.find(player => player.id === pending.ownerId).tools.some(tool => tool.cardId === data.toolId && tool.exhausted))) return '道具保存材料无效。';
    if (pending.choice?.actorId !== pending.ownerId || pending.response || pending.receipt) return '道具选择者无效。';
    if (pending.stage !== 'choosing' || !pending.choice || countGoods(pending.goods) !== 0) return '道具待选步骤无效。';
    if (pending.poolCards.length && !['T01', 'T04'].includes(pending.code) || pending.code === 'T04' && pending.poolCards.length !== 2
        || pending.code === 'T01' && pending.poolCards.some(card => cardDefinition(card).category !== 'goods')) return '道具候选池无效。';
  } else if (pending.kind === 'auction') {
    const auction = data.auction;
    if (!AUCTION_PENDING_CONTRACT.stages.includes(pending.stage) || !subsetFields(data, AUCTION_PENDING_CONTRACT.dataKeys)
        || !exactFields(auction, AUCTION_PENDING_CONTRACT.auctionKeys) || !['goods', 'cards'].includes(auction.kind)
        || !integer(auction.highestBid) || !(auction.highestBidderId === null || ids.includes(auction.highestBidderId))
        || (auction.highestBid === 0) !== (auction.highestBidderId === null)
        || !Array.isArray(auction.passedIds) || auction.passedIds.length > 2 || new Set(auction.passedIds).size !== auction.passedIds.length
        || auction.passedIds.some(id => !ids.includes(id)) || typeof auction.released !== 'boolean'
        || auction.released !== (state.status !== 'playing') || data.paidSilver !== undefined && data.paidSilver !== auction.highestBid) return '拍卖账本无效。';
    if (pending.stage === 'bidding' ? !ids.includes(auction.currentBidderId) || auction.passedIds.includes(auction.currentBidderId)
        || auction.highestBidderId !== null && (auction.currentBidderId === auction.highestBidderId
          || auction.highestBid > state.players.find(player => player.id === auction.highestBidderId).silver)
      : auction.currentBidderId !== null || data.paidSilver === undefined || !pending.receipt) return '拍卖决策或付款状态无效。';
    if (auction.kind === 'cards' ? pending.code !== 'C12' || pending.poolCards.length !== 3 || countGoods(pending.goods) !== 0
      : pending.code !== 'C09' || pending.poolCards.length !== 0 || countGoods(pending.goods) !== 2) return '拍品材料不完整。';
    if (pending.sourceCards.length !== 1 || cardDefinition(pending.sourceCards[0]).sourceCode !== pending.code
        || pending.response || pending.choice && pending.choice.kind !== 'retain-goods') return '拍卖来源或选择无效。';
  } else if (pending.kind === 'peek') {
    if (pending.code !== 'peek' || pending.stage !== 'decision' || pending.poolCards.length !== 1 || pending.sourceCards.length
        || countGoods(pending.goods) || Object.keys(data).length || pending.response || pending.receipt || pending.choice) return '普通私看区无效。';
  } else if (pending.kind === 'trade') {
    if (!['buy', 'sell'].includes(pending.code) || pending.stage !== 'merchant' || Object.keys(data).length
        || pending.sourceCards.length !== 1 || cardDefinition(pending.sourceCards[0]).category !== 'goods' || pending.poolCards.length
        || countGoods(pending.goods) || pending.choice || pending.receipt || pending.response?.kind !== 'merchant') return '交易回应区无效。';
  }
  return choiceProblem(state, pending);
}

/** Base pending envelope; the per-effect branch contracts below reject unsupported steps/data. */
export function pendingProblem(state, pending) {
  const ids = state.players.map(player => player.id);
  if (!exactFields(pending, pendingFields) || !identifier(pending.id) || !['peek', 'trade', 'character', 'tool', 'auction'].includes(pending.kind)
      || pending.ownerId !== state.turnPlayerId || !identifier(pending.stage) || !identifier(pending.code)
      || !uniqueCopies(pending.sourceCards) || !uniqueCopies(pending.poolCards) || !goodsVector(pending.goods)
      || !plainObject(pending.data) || !boundedJson(pending.data)) return '保存的待结算区无效。';
  const choice = pending.choice, response = pending.response, receipt = pending.receipt;
  if (choice !== null && (!exactFields(choice, ['id', 'kind', 'actorId', 'visibility', 'options', 'defaultSelection'])
      || !identifier(choice.id) || !identifier(choice.kind) || !ids.includes(choice.actorId) || !['private', 'public'].includes(choice.visibility)
      || !Array.isArray(choice.options) || !choice.options.length || choice.options.length > 110
      || !boundedJson(choice.options) || !boundedJson(choice.defaultSelection))) return '保存的选择无效。';
  if (response !== null && (!exactFields(response, ['kind', 'actorId', 'tradeCardId']) || !['counter', 'merchant'].includes(response.kind)
      || !ids.includes(response.actorId) || response.actorId === pending.ownerId
      || (response.kind === 'counter' ? response.tradeCardId !== null || !/^M0[1-8]$/u.test(pending.code)
        : !validCopy(response.tradeCardId) || cardDefinition(response.tradeCardId).category !== 'goods' || !pending.sourceCards.includes(response.tradeCardId)))) return '保存的回应无效。';
  if (receipt !== null && (!exactFields(receipt, ['actorId', 'goods', 'previousTemporary']) || !ids.includes(receipt.actorId)
      || !goodsVector(receipt.goods) || typeof receipt.previousTemporary !== 'boolean'
      || receipt.previousTemporary !== state.players.find(player => player.id === receipt.actorId).temporaryOccupied
      || !same(receipt.goods, pending.goods) || countGoods(receipt.goods) === 0
      || choice?.kind !== 'retain-goods' || choice.actorId !== receipt.actorId)) return '保存的收货选择无效。';
  if (response && (choice || receipt) || receipt && goodsIds.some(id => receipt.goods[id] > pending.goods[id])) return '待结算分支相互冲突。';
  return branchProblem(state, pending);
}

export function gameProblem(state) {
  try {
    const fields = plainObject(state) && Object.hasOwn(state, 'goodsPerType') ? [...stateFields, 'goodsPerType'] : stateFields;
    if (!exactFields(state, fields) || state.version !== 1 || state.gameType !== 'hyakki-trading'
        || state.ruleVersion !== DIGITAL_RULE_VERSION || state.contentVersion !== CONTENT_VERSION || !seatId(state.matchId)) return '不支持的幽街存档格式。';
    const goodsPerType = goodsPerTypeOf(state);
    if (!validGoodsPerType(goodsPerType)) return '每类货物数量须为4～20件。';
    if (!Array.isArray(state.players) || state.players.length !== 2 || new Set(state.players.map(player => player?.id)).size !== 2
        || state.players.some(player => !exactFields(player, playerFields) || !seatId(player.id) || !uniqueCopies(player.hand)
          || !Array.isArray(player.tools) || player.tools.length > 3 || player.tools.some(tool => !exactFields(tool, ['cardId', 'exhausted'])
            || !validCopy(tool.cardId) || cardDefinition(tool.cardId).category !== 'tool' || typeof tool.exhausted !== 'boolean')
          || !goodsVector(player.goods) || !integer(player.silver) || !integer(player.stallCount, 0, 5) || typeof player.temporaryOccupied !== 'boolean'
          || countGoods(player.goods) > 6 + 3 * player.stallCount
          || player.temporaryOccupied !== (countGoods(player.goods) > 5 + 3 * player.stallCount))) return '保存的玩家材料无效。';
    const ids = state.players.map(player => player.id);
    if (!uniqueCopies(state.deck) || !uniqueCopies(state.discard) || !goodsVector(state.bankGoods)
        || !integer(state.availableStalls, 0, 5) || !integer(state.purchasedStalls, 0, 5)
        || state.availableStalls + state.purchasedStalls !== 5 || state.players.reduce((sum, player) => sum + player.stallCount, 0) !== state.purchasedStalls) return '保存的公共材料无效。';
    if (!['playing', 'finished', 'aborted'].includes(state.status) || !ids.includes(state.firstPlayerId) || !ids.includes(state.turnPlayerId)
        || !integer(state.turnIndex, 0, 1) || state.players[state.turnIndex].id !== state.turnPlayerId
        || !integer(state.turnNumber, 1) || state.turnId !== `turn-${state.turnNumber}` || !integer(state.round, 1)
        || state.round !== Math.ceil(state.turnNumber / 2) || state.turnIndex !== (ids.indexOf(state.firstPlayerId) + state.turnNumber - 1) % 2
        || !['draw', 'use'].includes(state.stage) || !integer(state.actionLimit, 1, 10) || !integer(state.actionsUsed, 0, state.actionLimit)
        || typeof state.drawStarted !== 'boolean' || !integer(state.bookLayers, 0, state.actionsUsed) || !integer(state.revision)
        || !integer(state.publicEventSequence, 1) || state.publicEventSequence !== state.revision + 1 || !integer(state.committedAt)) return '保存的回合状态无效。';
    if (state.closing !== null && (!exactFields(state.closing, ['finalPlayerId', 'triggerPlayerId'])
        || !ids.includes(state.closing.finalPlayerId) || !ids.includes(state.closing.triggerPlayerId)
        || state.closing.finalPlayerId === state.closing.triggerPlayerId)) return '保存的收市状态无效。';
    if (state.pending !== null) { const issue = pendingProblem(state, state.pending); if (issue) return issue; }
    const material = [...state.deck, ...state.discard, ...state.players.flatMap(player => [...player.hand, ...player.tools.map(tool => tool.cardId)]),
      ...(state.pending ? [...state.pending.sourceCards, ...state.pending.poolCards] : [])];
    if (material.length !== 110 || new Set(material).size !== 110 || material.some(card => !copies.has(card))) return '110张实体牌必须各处于一个材料区。';
    if (goodsIds.some(id => state.bankGoods[id] + state.players.reduce((sum, player) => sum + player.goods[id], 0) + (state.pending?.goods[id] ?? 0) !== goodsPerType)) return `六类货物必须各守恒${goodsPerType}件。`;
    if (!Array.isArray(state.lastPublicEvents) || !state.lastPublicEvents.length || state.lastPublicEvents.length > 64
        || state.lastPublicEvents.some(event => !publicEvent(event, ids, goodsPerType))) return '保存的公开事件无效。';
    const timing = hyakkiTimingProblem(state); if (timing) return timing;
    if (state.timing.active.id !== state.turnId || state.committedAt < state.lifecycle.startedAt) return '回合与时钟代际不一致。';
    const decision = currentDecision(state), expectedActor = decision?.actorId;
    if (expectedActor && expectedActor !== state.turnPlayerId
      ? state.timing.decision?.actorId !== expectedActor || state.timing.decision.id !== decision.id
      : state.timing.decision !== null) return '选择者与回应时钟不一致。';
    if (state.status === 'playing') {
      if (state.result !== null) return '进行中的对局不能含终局结果。';
    } else {
      const result = state.result;
      if (!exactFields(result, ['reason', 'winnerIds', 'aborted', 'settledAt', 'wealth']) || !endReasons.includes(result.reason)
          || !Array.isArray(result.winnerIds) || result.winnerIds.length > 2 || new Set(result.winnerIds).size !== result.winnerIds.length
          || result.winnerIds.some(id => !ids.includes(id)) || result.aborted !== (state.status === 'aborted')
          || !integer(result.settledAt, state.lifecycle.startedAt) || result.settledAt !== state.committedAt
          || !Array.isArray(result.wealth) || result.wealth.length !== 2 || new Set(result.wealth.map(value => value?.playerId)).size !== 2
          || result.wealth.some(value => !exactFields(value, ['playerId', 'silver']) || !ids.includes(value.playerId)
            || value.silver !== state.players.find(player => player.id === value.playerId).silver)
          || (result.aborted ? result.winnerIds.length !== 0 || !['absence-expired', 'room-expired', 'cancelled'].includes(result.reason)
            : result.reason === 'voluntary-leave' ? result.winnerIds.length !== 1
              : result.reason !== 'normal-close' || result.winnerIds.length < 1 || state.pending !== null)) return '保存的终局结果无效。';
      if (result.reason === 'normal-close') {
        const most = Math.max(...state.players.map(player => player.silver));
        const leaders = state.players.filter(player => player.silver === most);
        const expectedWinner = leaders.length === 2 ? state.turnPlayerId : leaders[0].id;
        if (result.winnerIds.length !== 1 || result.winnerIds[0] !== expectedWinner) return '收市财富与胜负不一致。';
      }
    }
    return null;
  } catch { return '保存的幽街状态无效。'; }
}
