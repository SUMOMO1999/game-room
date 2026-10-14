import { GOODS } from './content/definitions.mjs';
import { RuleError, requireRule, definition, player, opponent, pairIds, isMultiplayer, beginMerchantResponse, legalResponseCards, emptyGoods, goodsCount, addSilver,
  moveGoods, removeCard, discardCards, drawCards, availableCards, ordinaryCapacity,
  refreshTemporary, createPending, setChoice, clearChoice, completePending, receiveGoods, emit } from './model.mjs';
import { beginAuction } from './auction.mjs';
import { toolProblem, startTool } from './tools.mjs';

export const implementedCharacterCodes = Object.freeze([
  ...Array.from({ length: 13 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, index) => `M${String(index + 1).padStart(2, '0')}`),
]);

// The validator and private projection consume this bounded persistence surface.
// Fields in data are references/step bookkeeping, never additional material zones.
export const CHARACTER_PENDING_CONTRACTS = Object.freeze(Object.fromEntries(Object.entries({
  C01: { stages: ['start', 'benefits'], data: ['branch', 'benefitIndex'], choices: ['benefit-branch', 'benefit-good'] },
  C02: { stages: ['start', 'select'], data: [], choices: ['take-card'], poolVisibility: 'private' },
  C03: { stages: ['start'], data: [], choices: [] },
  C04: { responseOnly: true, stages: [], data: [], choices: [] },
  C05: { stages: ['start', 'sell', 'merchant', 'done'], data: ['tradeCardId'], choices: ['trade-card', 'sell-goods'] },
  C06: { stages: ['start'], data: [], choices: ['exchange'] },
  C07: { responseOnly: true, stages: [], data: [], choices: [] },
  C08: { stages: ['start', 'discard'], data: [], choices: ['hand-branch', 'discard-hand'] },
  C09: { stages: ['start'], data: [], choices: ['auction-goods'] },
  C10: { stages: ['start', 'receive', 'done'], data: [], choices: ['artisan-good'] },
  C11: { stages: ['start'], data: [], choices: ['recover-tool'] },
  C12: { stages: ['start'], data: [], choices: [] },
  C13: { stages: ['start'], data: [], choices: ['sell-stock'] },
  M01: { stages: ['start', 'done'], data: ['goodsId'], choices: [] },
  M02: { stages: ['start', 'draft'], data: ['nextActorId'], choices: ['draft-card'], poolVisibility: 'public' },
  M03: { stages: ['start', 'keep'], data: ['playerIndex'], choices: ['keep-tool'] },
  M04: { stages: ['start'], data: [], choices: ['tribute-branch'] },
  M05: { stages: ['start', 'draft'], data: ['nextActorId', 'tempPaid'], choices: ['draft-good'] },
  M06: { stages: ['start', 'draft'], data: ['nextActorId'], choices: ['draft-tool'], poolVisibility: 'public' },
  M07: { stages: ['start', 'return'], data: [], choices: ['return-card'] },
  M08: { stages: ['start', 'borrow'], data: ['toolCardId'], choices: ['borrow-tool'] },
}).map(([code, contract]) => [code, Object.freeze({ ...contract,
  stages: Object.freeze([...contract.stages, ...(code === 'M08' ? ['borrowed-target'] : [])]),
  data: Object.freeze([...contract.data, ...(['C01', 'C08'].includes(code) || code.startsWith('M') ? ['targetId'] : []),
    ...(code === 'M08' ? ['borrowedTargetId'] : [])]),
  choices: Object.freeze([...contract.choices, ...(code === 'M08' ? ['borrowed-target'] : [])]) })])));

const goodsIds = Object.freeze(GOODS.map(item => item.id).sort());
const sorted = cards => [...cards].sort();
const vector = (goodsId, count = 1) => ({ ...emptyGoods(), [goodsId]: count });
const handWithout = (owner, copyId) => owner.hand.filter(id => id !== copyId);
const tripleCards = cards => sorted(cards.filter(id => definition(id).category === 'goods' && goodsCount(definition(id).goods) === 3));
const saleCards = (state, owner, cards = owner.hand) => tripleCards(cards)
  .filter(id => Number.isSafeInteger(owner.silver + definition(id).sellSilver + 2 * state.bookLayers));
const sellableCount = owner => Math.min(goodsCount(owner.goods), Math.floor((Number.MAX_SAFE_INTEGER - owner.silver) / 2));
const canPayTribute = (owner, peer) => peer.silver >= 2 && Number.isSafeInteger(owner.silver + 2);
const publicTools = state => sorted(state.discard.filter(id => definition(id).category === 'tool'));
const hasMoney = state => state.players.some(owner => owner.silver >= 1);
const stockTypes = stock => goodsIds.filter(id => stock[id] > 0);
const pairedCharacter = code => ['C01', 'C08'].includes(code) || /^M0[1-8]$/u.test(code);
const pairedActors = state => pairIds(state, state.pending.ownerId).map(id => player(state, id));
const nextPairActor = (state, actorId) => pairIds(state, state.pending.ownerId).find(id => id !== actorId);
const borrowedTargetOptions = (state, ownerId, toolId) => state.players.filter(actor => actor.id !== ownerId
  && !toolProblem(state, ownerId, toolId, { targetId: actor.id }, { borrowed: true })).map(actor => ({ targetId: actor.id }));
const exchangeOptions = (state, owner) => stockTypes(owner.goods).flatMap(fromGoodsId =>
  goodsIds.filter(toGoodsId => toGoodsId !== fromGoodsId && state.bankGoods[toGoodsId] >= owner.goods[fromGoodsId])
    .map(toGoodsId => ({ fromGoodsId, toGoodsId })));

const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, allowed) { return plain(value) && Object.keys(value).every(key => allowed.includes(key)); }
const initialKinds = Object.freeze({ C01: ['benefit-branch', 'benefit-good'], C05: ['trade-card', 'sell-goods'],
  C06: ['exchange'], C08: ['hand-branch'], C09: ['auction-goods'], C10: ['artisan-good'],
  C11: ['recover-tool'], C13: ['sell-stock'] });
const initialSelectionKeys = Object.freeze({ 'benefit-branch': ['branch'], 'benefit-good': ['goodsId'],
  'trade-card': ['cardId'], 'sell-goods': ['goods'], exchange: ['fromGoodsId', 'toGoodsId'],
  'hand-branch': ['branch'], 'auction-goods': ['goods'], 'artisan-good': ['goodsId'],
  'recover-tool': ['cardId'], 'sell-stock': ['goods'] });
function initialChoicesProblem(state, code, steps) {
  const kinds = initialKinds[code];
  if (!kinds || !Array.isArray(steps) || !steps.length || steps.length > kinds.length) return '人物预选步骤无效。';
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index], keys = initialSelectionKeys[kinds[index]];
    if (!fields(step, ['kind', 'selection']) || Object.keys(step).length !== 2 || step.kind !== kinds[index]
      || !fields(step.selection, keys) || Object.keys(step.selection).length !== keys.length) return '人物预选材料无效。';
  }
  const count = code === 'C01' ? steps[0].selection.branch === 'goods' && goodsCount(state.bankGoods) ? 2 : 1 : kinds.length;
  return steps.length === count ? null : '请先选齐本次人物所需材料。';
}
function choose(state, kind, actorId, options, { visibility = 'private', defaultSelection = options[0] } = {}) {
  requireRule(options.length > 0 && defaultSelection !== undefined, '此步骤没有合法选项。');
  setChoice(state, { kind, actorId, visibility, options, defaultSelection });
}
function goodsChoice(state, kind, actorId, source, minimum, maximum) {
  const selected = emptyGoods(); let remaining = minimum;
  for (const id of goodsIds) { selected[id] = Math.min(source[id], remaining); remaining -= selected[id]; }
  choose(state, kind, actorId, [{ goods: { ...source }, minimum, maximum }], { defaultSelection: { goods: selected } });
}
function checkedGoods(selection, source, minimum, maximum) {
  requireRule(fields(selection, ['goods']) && fields(selection.goods, goodsIds)
    && goodsIds.every(id => Number.isSafeInteger(selection.goods[id]) && selection.goods[id] >= 0
      && selection.goods[id] <= source[id]), '请选择当前可用的货物。');
  const count = goodsCount(selection.goods);
  requireRule(count >= minimum && count <= maximum, '选择的货物数量不正确。');
  return selection.goods;
}
function checkedCard(selection, cards) {
  requireRule(fields(selection, ['cardId']) && cards.includes(selection.cardId), '所选牌已不在当前候选中。');
  return selection.cardId;
}
function checkedBranch(selection, options) {
  requireRule(fields(selection, ['branch']) && options.includes(selection.branch), '当前不能选择该分支。');
  return selection.branch;
}
function checkedGood(selection, ids) {
  requireRule(fields(selection, ['goodsId']) && ids.includes(selection.goodsId), '当前不能选择该货物。');
  return selection.goodsId;
}
function giveCards(state, actorId, count, ctx) {
  const cards = drawCards(state, count, ctx);
  player(state, actorId).hand.push(...cards);
  emit(state, { type: 'choice-resolved', actorSeatId: actorId, count: cards.length });
}
function receiving(state, actorId, goods, source) {
  moveGoods(source, state.pending.goods, goods);
  if (state.players.some(owner => owner.goods === source)) refreshTemporary(state.players.find(owner => owner.goods === source));
  return receiveGoods(state, actorId, goods);
}

/** Activation checks use public counts and valid owned targets, never hidden card kinds. */
export function characterProblem(state, ownerId, copyId, params = {}) {
  const owner = state.players.find(item => item.id === ownerId);
  if (!owner || !owner.hand.includes(copyId)) return '请使用自己的手牌。';
  const card = definition(copyId), code = card.sourceCode;
  if (!implementedCharacterCodes.includes(code)) return '这张牌不是人物牌。';
  if (code === 'C04' || code === 'C07') return '这张人物只能在对应回应窗口使用。';
  const allowed = [...(code === 'M01' ? ['goodsId'] : code === 'M08' ? ['toolCardId'] : []),
    ...(isMultiplayer(state) && pairedCharacter(code) ? ['targetId'] : []), ...(initialKinds[code] ? ['initialChoices'] : [])];
  if (!fields(params, allowed)) return '人物参数无效。';
  if (Object.hasOwn(params, 'initialChoices')) {
    const problem = initialChoicesProblem(state, code, params.initialChoices);
    if (problem) return problem;
  }
  let peer = null;
  if (pairedCharacter(code)) {
    try { peer = opponent(state, ownerId, params.targetId); }
    catch (error) { if (error instanceof RuleError) return error.message; throw error; }
  }
  const stock = goodsCount(owner.goods), draws = availableCards(state);
  switch (code) {
    case 'C01': return draws || goodsCount(state.bankGoods) ? null : '没有可获得的牌或货物。';
    case 'C02': return draws ? null : '没有可抽的牌。';
    case 'C03': return null;
    case 'C05': return stock >= 3 && saleCards(state, owner, handWithout(owner, copyId)).length ? null : '需要三件库存、三件货物牌及可保存的卖价。';
    case 'C06': return exchangeOptions(state, owner).length ? null : '公库没有足额的异种货物可交换。';
    case 'C08': return handWithout(owner, copyId).length < 5 && draws || peer.hand.length > 3 ? null : '双方手牌均无可调整的分支。';
    case 'C09': return goodsCount(state.bankGoods) >= 2 && hasMoney(state) ? null : '拍卖需要两件货物且至少一人有一两。';
    case 'C10': return owner.silver >= 2 && goodsIds.some(id => state.bankGoods[id] >= 2) ? null : '需要两两和公库两件同种货物。';
    case 'C11': return publicTools(state).length ? null : '弃牌中没有道具。';
    case 'C12': return draws >= 3 && hasMoney(state) ? null : '拍卖需要三张可抽牌且至少一人有一两。';
    case 'C13': return sellableCount(owner) ? null : '没有可出售的库存或银两已达上限。';
    case 'M01': return goodsIds.includes(params.goodsId) && peer.goods[params.goodsId] >= 1 ? null : '请选择对手现有的一件货物。';
    case 'M02': return handWithout(owner, copyId).length + peer.hand.length ? null : '双方没有可分配的手牌。';
    case 'M03': return owner.tools.length > 1 || peer.tools.length > 1 ? null : '双方均没有多余道具。';
    case 'M04': return canPayTribute(owner, peer) || draws ? null : '当前无法支付两两，也没有可抽牌。';
    case 'M05': return stock + goodsCount(peer.goods) ? null : '双方没有可分配的库存。';
    case 'M06': return owner.tools.length + peer.tools.length ? null : '双方没有可分配的道具。';
    case 'M07': return peer.hand.length ? null : '对手没有手牌。';
    case 'M08': return peer.tools.some(tool => tool.cardId === params.toolCardId) ? null : '请选择对手的一张道具。';
    default: return '人物效果未定义。';
  }
}

export function startCharacter(state, copyId, params = {}, ctx) {
  const code = definition(copyId).sourceCode, ownerId = state.turnPlayerId;
  requireRule(implementedCharacterCodes.includes(code) && !['C04', 'C07'].includes(code), '这张牌不能主动发动。');
  const peer = pairedCharacter(code) ? opponent(state, ownerId, params.targetId) : null;
  createPending(state, { kind: 'character', ownerId, code, sourceCards: [copyId],
    data: { ...(code === 'M01' ? { goodsId: params.goodsId } : code === 'M08' ? { toolCardId: params.toolCardId } : {}),
      ...(isMultiplayer(state) && peer ? { targetId: peer.id } : {}) } });
  if (code.startsWith('M')) {
    state.pending.response = { kind: 'counter', actorId: peer.id, tradeCardId: null };
    if (legalResponseCards(state).length) return;
    state.pending.response = null;
  }
  continueCharacter(state, ctx);
  // Only this card's bounded, already-known owner choices may join activation.
  // They are consumed on the candidate clone, never saved as future intentions.
  const pendingId = state.pending?.id;
  for (const step of params.initialChoices ?? []) {
    const pending = state.pending;
    requireRule(pending?.id === pendingId && pending.kind === 'character' && pending.code === code
      && !pending.response && !pending.receipt && pending.choice?.actorId === ownerId
      && pending.choice.kind === step.kind, '人物预选步骤已经改变。');
    chooseCharacter(state, step.selection, ctx);
    emit(state, { type: 'choice-resolved', actorSeatId: ownerId });
    if (state.pending?.kind === 'character') continueCharacter(state, ctx);
  }
}

function continueBenefits(state, ctx) {
  const pending = state.pending;
  if (!pending.data.branch) {
    choose(state, 'benefit-branch', pending.ownerId, [{ branch: 'draw' }, { branch: 'goods' }]); return;
  }
  while (pending.data.benefitIndex < 2) {
    const own = pending.data.benefitIndex === 0, actorId = own ? pending.ownerId : opponent(state, pending.ownerId).id;
    const benefit = own ? pending.data.branch : pending.data.branch === 'draw' ? 'goods' : 'draw';
    if (benefit === 'draw') { pending.data.benefitIndex++; giveCards(state, actorId, 2, ctx); }
    else if (!goodsCount(state.bankGoods)) pending.data.benefitIndex++;
    else { choose(state, 'benefit-good', actorId, stockTypes(state.bankGoods).map(goodsId => ({ goodsId }))); return; }
  }
  completePending(state);
}
function continueToolKeeping(state) {
  const pending = state.pending, order = pairIds(state, pending.ownerId);
  while (pending.data.playerIndex < order.length) {
    const actor = player(state, order[pending.data.playerIndex]);
    if (actor.tools.length <= 1) { pending.data.playerIndex++; continue; }
    choose(state, 'keep-tool', actor.id, sorted(actor.tools.map(tool => tool.cardId)).map(cardId => ({ cardId })), { visibility: 'public' }); return;
  }
  completePending(state);
}
function canDraftGood(state, actorId) {
  const actor = player(state, actorId), count = goodsCount(actor.goods), capacity = ordinaryCapacity(actor);
  return count < capacity || count === capacity && (state.pending.data.tempPaid[actorId] || actor.silver >= 2);
}
function continueDraft(state, kind) {
  const pending = state.pending;
  if (kind === 'goods' ? !goodsCount(pending.goods) : !pending.poolCards.length) { completePending(state); return; }
  const eligible = id => kind === 'goods' ? canDraftGood(state, id) : kind === 'tools' ? player(state, id).tools.length < 3 : true;
  let actorId = pending.data.nextActorId;
  if (!eligible(actorId)) actorId = nextPairActor(state, actorId);
  if (!eligible(actorId)) {
    if (kind === 'goods') moveGoods(pending.goods, state.bankGoods, { ...pending.goods });
    else { discardCards(state, pending.poolCards, { sort: true }); pending.poolCards = []; }
    for (const actor of pairedActors(state)) refreshTemporary(actor);
    completePending(state); return;
  }
  pending.data.nextActorId = actorId;
  if (kind === 'goods') choose(state, 'draft-good', actorId, stockTypes(pending.goods).map(goodsId => ({ goodsId })), { visibility: 'public' });
  else choose(state, kind === 'tools' ? 'draft-tool' : 'draft-card', actorId,
    sorted(pending.poolCards).map(cardId => ({ cardId })), { visibility: 'public' });
}

/** Resume persisted steps without repeating draws, fees, pool construction or disposal. */
export function continueCharacter(state, ctx) {
  const pending = state.pending;
  requireRule(pending?.kind === 'character', '当前没有人物效果。');
  if (pending.response || pending.choice || pending.receipt) return;
  const owner = player(state, pending.ownerId), peer = pairedCharacter(pending.code) ? opponent(state, owner.id) : null;
  if (pending.stage === 'done') { completePending(state); return; }
  switch (pending.code) {
    case 'C01': continueBenefits(state, ctx); return;
    case 'C02':
      if (pending.stage === 'start') { pending.poolCards = drawCards(state, 6, ctx); pending.stage = 'select'; }
      if (!pending.poolCards.length) { completePending(state); return; }
      choose(state, 'take-card', owner.id, sorted(pending.poolCards).map(cardId => ({ cardId }))); return;
    case 'C03': state.bookLayers++; completePending(state); return;
    case 'C05':
      if (pending.stage === 'merchant') { completePending(state); return; }
      if (pending.stage === 'start') choose(state, 'trade-card', owner.id, saleCards(state, owner).map(cardId => ({ cardId })));
      else goodsChoice(state, 'sell-goods', owner.id, owner.goods, 3, 3);
      return;
    case 'C06': choose(state, 'exchange', owner.id, exchangeOptions(state, owner), { visibility: 'public' }); return;
    case 'C08':
      if (pending.stage === 'discard') {
        const count = Math.max(0, peer.hand.length - 3), cardIds = sorted(peer.hand);
        if (!count) { completePending(state); return; }
        choose(state, 'discard-hand', peer.id, [{ cardIds, count }], { defaultSelection: { cardIds: cardIds.slice(0, count) } });
      } else {
        const options = [];
        if (owner.hand.length < 5 && availableCards(state)) options.push({ branch: 'draw' });
        if (peer.hand.length > 3) options.push({ branch: 'discard' });
        choose(state, 'hand-branch', owner.id, options);
      }
      return;
    case 'C09': goodsChoice(state, 'auction-goods', owner.id, state.bankGoods, 2, 2); return;
    case 'C10':
      if (pending.stage === 'start') { addSilver(owner, -2); pending.stage = 'receive'; }
      choose(state, 'artisan-good', owner.id, goodsIds.filter(id => state.bankGoods[id] >= 2).map(goodsId => ({ goodsId }))); return;
    case 'C11': choose(state, 'recover-tool', owner.id, publicTools(state).map(cardId => ({ cardId })), { visibility: 'public' }); return;
    case 'C12':
      pending.poolCards = drawCards(state, 3, ctx);
      requireRule(pending.poolCards.length === 3, '拍品不足三张。');
      beginAuction(state, { ownerId: owner.id, kind: 'cards' }, ctx); return;
    case 'C13': goodsChoice(state, 'sell-stock', owner.id, owner.goods, 1, sellableCount(owner)); return;
    case 'M01':
      pending.stage = 'done';
      receiving(state, owner.id, vector(pending.data.goodsId), peer.goods);
      if (!pending.receipt) completePending(state);
      return;
    case 'M02':
      if (pending.stage === 'start') {
        pending.poolCards = [...owner.hand, ...peer.hand]; owner.hand = []; peer.hand = [];
        pending.stage = 'draft'; pending.data.nextActorId = owner.id;
        emit(state, { type: 'cards-revealed', actorSeatId: owner.id, cardIds: pending.poolCards.map(id => definition(id).id) });
      }
      continueDraft(state, 'cards'); return;
    case 'M03':
      if (pending.stage === 'start') { pending.stage = 'keep'; pending.data.playerIndex = 0; }
      continueToolKeeping(state); return;
    case 'M04': {
      const options = [];
      if (canPayTribute(owner, peer)) options.push({ branch: 'pay' });
      if (availableCards(state)) options.push({ branch: 'draw' });
      choose(state, 'tribute-branch', peer.id, options); return;
    }
    case 'M05':
      if (pending.stage === 'start') {
        pending.data.tempPaid = Object.fromEntries(pairedActors(state).map(actor => [actor.id, actor.temporaryOccupied]));
        for (const actor of pairedActors(state)) { moveGoods(actor.goods, pending.goods, { ...actor.goods }); refreshTemporary(actor); }
        pending.stage = 'draft'; pending.data.nextActorId = owner.id;
      }
      continueDraft(state, 'goods'); return;
    case 'M06':
      if (pending.stage === 'start') {
        pending.poolCards = [...owner.tools, ...peer.tools].map(tool => tool.cardId); owner.tools = []; peer.tools = [];
        pending.stage = 'draft'; pending.data.nextActorId = owner.id;
      }
      continueDraft(state, 'tools'); return;
    case 'M07':
      if (pending.stage === 'start') {
        requireRule(peer.hand.length > 0, '对手没有可交换的手牌。');
        const index = ctx.randomInt(peer.hand.length);
        requireRule(Number.isInteger(index) && index >= 0 && index < peer.hand.length, '随机结果无效。');
        owner.hand.push(peer.hand.splice(index, 1)[0]); pending.stage = 'return';
      }
      choose(state, 'return-card', owner.id, sorted(owner.hand).map(cardId => ({ cardId }))); return;
    case 'M08':
      if (pending.stage === 'start') {
        const index = peer.tools.findIndex(tool => tool.cardId === pending.data.toolCardId);
        requireRule(index >= 0, '目标道具已不存在。');
        const [removed] = peer.tools.splice(index, 1); discardCards(state, [removed.cardId]); pending.stage = 'borrow';
      }
      if (pending.stage === 'borrowed-target') {
        choose(state, 'borrowed-target', owner.id, borrowedTargetOptions(state, owner.id, pending.data.toolCardId), { visibility: 'public' }); return;
      }
      {
        const pairedTool = ['T02', 'T04'].includes(definition(pending.data.toolCardId).sourceCode) && isMultiplayer(state);
        const canBorrow = pairedTool ? borrowedTargetOptions(state, owner.id, pending.data.toolCardId).length > 0
          : !toolProblem(state, owner.id, pending.data.toolCardId, {}, { borrowed: true });
        choose(state, 'borrow-tool', owner.id, canBorrow ? [{ borrow: true }, { borrow: false }] : [{ borrow: false }]); return;
      }
    default: requireRule(false, '当前人物不能主动结算。');
  }
}

/** Every selected material is checked in its current authoritative zone. */
export function chooseCharacter(state, selection, ctx) {
  const pending = state.pending, choice = pending?.choice;
  requireRule(pending?.kind === 'character' && choice && !pending.response && !pending.receipt, '当前没有人物选择。');
  const owner = player(state, pending.ownerId), peer = pairedCharacter(pending.code) ? opponent(state, owner.id) : null,
    actor = player(state, choice.actorId);
  switch (choice.kind) {
    case 'benefit-branch':
      pending.data.branch = checkedBranch(selection, ['draw', 'goods']); pending.data.benefitIndex = 0; pending.stage = 'benefits'; break;
    case 'benefit-good': {
      const id = checkedGood(selection, stockTypes(state.bankGoods));
      const goods = vector(id, Math.min(2, state.bankGoods[id]));
      pending.data.benefitIndex++; clearChoice(state); receiving(state, actor.id, goods, state.bankGoods); return;
    }
    case 'take-card': {
      const id = checkedCard(selection, pending.poolCards);
      removeCard(pending.poolCards, id); owner.hand.push(id);
      state.deck.unshift(...pending.poolCards); pending.poolCards = []; clearChoice(state); completePending(state); return;
    }
    case 'trade-card': {
      const id = checkedCard(selection, saleCards(state, owner));
      removeCard(owner.hand, id); pending.sourceCards.unshift(id); pending.data.tradeCardId = id; pending.stage = 'sell'; break;
    }
    case 'sell-goods': {
      const goods = checkedGoods(selection, owner.goods, 3, 3), tradeCardId = pending.data.tradeCardId;
      requireRule(pending.sourceCards.includes(tradeCardId) && goodsCount(definition(tradeCardId).goods) === 3, '买办货物牌无效。');
      moveGoods(owner.goods, state.bankGoods, goods); refreshTemporary(owner);
      addSilver(owner, definition(tradeCardId).sellSilver + 2 * state.bookLayers);
      pending.stage = 'merchant'; beginMerchantResponse(state, tradeCardId);
      emit(state, { type: 'trade-sold', actorSeatId: owner.id, cardId: definition(tradeCardId).id,
        goods: goodsIds.filter(id => goods[id]).map(id => ({ id, count: goods[id] })),
        silver: definition(tradeCardId).sellSilver + 2 * state.bookLayers }); break;
    }
    case 'exchange': {
      requireRule(fields(selection, ['fromGoodsId', 'toGoodsId']) && exchangeOptions(state, owner)
        .some(option => option.fromGoodsId === selection.fromGoodsId && option.toGoodsId === selection.toGoodsId), '必须完整交换为足额异种货物。');
      const count = owner.goods[selection.fromGoodsId];
      moveGoods(owner.goods, state.bankGoods, vector(selection.fromGoodsId, count));
      moveGoods(state.bankGoods, owner.goods, vector(selection.toGoodsId, count));
      refreshTemporary(owner); clearChoice(state); completePending(state); return;
    }
    case 'hand-branch': {
      const allowed = [];
      if (owner.hand.length < 5 && availableCards(state)) allowed.push('draw');
      if (peer.hand.length > 3) allowed.push('discard');
      const branch = checkedBranch(selection, allowed);
      if (branch === 'draw') { giveCards(state, owner.id, 5 - owner.hand.length, ctx); clearChoice(state); completePending(state); return; }
      pending.stage = 'discard'; break;
    }
    case 'discard-hand': {
      requireRule(fields(selection, ['cardIds']) && Array.isArray(selection.cardIds)
        && selection.cardIds.length === peer.hand.length - 3 && new Set(selection.cardIds).size === selection.cardIds.length
        && selection.cardIds.every(id => peer.hand.includes(id)), '请选择足够的现有手牌，保留三张。');
      for (const id of selection.cardIds) removeCard(peer.hand, id);
      discardCards(state, selection.cardIds, { sort: true }); clearChoice(state); completePending(state); return;
    }
    case 'auction-goods': {
      const goods = checkedGoods(selection, state.bankGoods, 2, 2);
      moveGoods(state.bankGoods, pending.goods, goods); clearChoice(state);
      beginAuction(state, { ownerId: owner.id, kind: 'goods' }, ctx); return;
    }
    case 'artisan-good': {
      const id = checkedGood(selection, goodsIds.filter(id => state.bankGoods[id] >= 2));
      pending.stage = 'done'; clearChoice(state); receiving(state, owner.id, vector(id, 2), state.bankGoods);
      if (!pending.receipt) completePending(state);
      return;
    }
    case 'recover-tool': {
      const id = checkedCard(selection, publicTools(state)); removeCard(state.discard, id); owner.hand.push(id);
      clearChoice(state); completePending(state); return;
    }
    case 'sell-stock': {
      const goods = checkedGoods(selection, owner.goods, 1, sellableCount(owner)), count = goodsCount(goods);
      moveGoods(owner.goods, state.bankGoods, goods); refreshTemporary(owner); addSilver(owner, 2 * count);
      clearChoice(state); completePending(state); return;
    }
    case 'draft-card': {
      const id = checkedCard(selection, pending.poolCards); removeCard(pending.poolCards, id); actor.hand.push(id);
      pending.data.nextActorId = nextPairActor(state, actor.id); break;
    }
    case 'keep-tool': {
      const id = checkedCard(selection, actor.tools.map(tool => tool.cardId));
      discardCards(state, actor.tools.filter(tool => tool.cardId !== id).map(tool => tool.cardId), { sort: true });
      actor.tools = actor.tools.filter(tool => tool.cardId === id); pending.data.playerIndex++; break;
    }
    case 'tribute-branch': {
      const allowed = [];
      if (canPayTribute(owner, peer)) allowed.push('pay');
      if (availableCards(state)) allowed.push('draw');
      const branch = checkedBranch(selection, allowed);
      if (branch === 'pay') { addSilver(peer, -2); addSilver(owner, 2); }
      else giveCards(state, owner.id, 2, ctx);
      clearChoice(state); completePending(state); return;
    }
    case 'draft-good': {
      const id = checkedGood(selection, stockTypes(pending.goods));
      requireRule(canDraftGood(state, actor.id), '当前没有可负担的货位。');
      moveGoods(pending.goods, actor.goods, vector(id));
      if (goodsCount(actor.goods) > ordinaryCapacity(actor)) {
        if (!pending.data.tempPaid[actor.id]) { addSilver(actor, -2); pending.data.tempPaid[actor.id] = true; }
        actor.temporaryOccupied = true;
      }
      pending.data.nextActorId = nextPairActor(state, actor.id); break;
    }
    case 'draft-tool': {
      const id = checkedCard(selection, pending.poolCards);
      requireRule(actor.tools.length < 3, '道具区已满。');
      removeCard(pending.poolCards, id); actor.tools.push({ cardId: id, exhausted: false });
      pending.data.nextActorId = nextPairActor(state, actor.id); break;
    }
    case 'return-card': {
      const id = checkedCard(selection, owner.hand); removeCard(owner.hand, id); peer.hand.push(id);
      clearChoice(state); completePending(state); return;
    }
    case 'borrow-tool': {
      requireRule(fields(selection, ['borrow', 'params']) && typeof selection.borrow === 'boolean'
        && (selection.params === undefined || plain(selection.params)), '借用选择无效。');
      if (!selection.borrow) {
        requireRule(selection.params === undefined || !Object.keys(selection.params).length, '不借用时不能指定道具材料。');
        clearChoice(state); completePending(state); return;
      }
      if (selection.params && Object.keys(selection.params).length) {
        const issue = toolProblem(state, owner.id, pending.data.toolCardId, selection.params, { borrowed: true, preselected: true });
        requireRule(!issue, issue ?? '借用道具材料无效。');
        const toolId = pending.data.toolCardId; clearChoice(state);
        startTool(state, toolId, selection.params, ctx, { borrowed: true }); return;
      }
      if (isMultiplayer(state) && ['T02', 'T04'].includes(definition(pending.data.toolCardId).sourceCode)) {
        requireRule(borrowedTargetOptions(state, owner.id, pending.data.toolCardId).length > 0, '当前没有可借用的目标。');
        pending.stage = 'borrowed-target'; break;
      }
      const problem = toolProblem(state, owner.id, pending.data.toolCardId, {}, { borrowed: true });
      requireRule(!problem, problem ?? '当前无法借用该道具。');
      const target = pending.data.toolCardId; clearChoice(state); startTool(state, target, {}, ctx, { borrowed: true }); return;
    }
    case 'borrowed-target': {
      requireRule(fields(selection, ['targetId']) && borrowedTargetOptions(state, owner.id, pending.data.toolCardId)
        .some(option => option.targetId === selection.targetId), '请选择当前可借用的其他参赛者。');
      pending.data.borrowedTargetId = selection.targetId;
      const toolId = pending.data.toolCardId; clearChoice(state);
      startTool(state, toolId, { targetId: selection.targetId }, ctx, { borrowed: true }); return;
    }
    default: requireRule(false, '未知的人物选择。');
  }
  clearChoice(state);
}
