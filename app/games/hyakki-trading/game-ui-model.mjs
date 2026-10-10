/** UI input contracts consume only the current role projection. No hidden rules/state. */
import { GOODS, getCard } from './content/definitions.mjs';
const ids = GOODS.map(good => good.id);
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new RangeError(message); };
const quantity = value => Number.isSafeInteger(value) && value >= 0;
export const goodsTotal = goods => ids.reduce((n, id) => n + (goods?.[id] ?? 0), 0);
export const cardKey = card => card.cardId ?? card.ref ?? card.id;
export function choiceModel(pending) {
  const choice = pending?.choice;
  if (!choice?.options) return null;
  const first = choice.options[0] ?? {};
  if (choice.kind === 'retain-goods') return { type: 'goods', stock: first.combined, minimum: 0, maximum: first.capacity, raw: true, ordinaryCapacity: first.ordinaryCapacity, temporaryFee: first.temporaryFee };
  if (first.goods && Number.isInteger(first.minimum)) return { type: 'goods', stock: first.goods, minimum: first.minimum, maximum: first.maximum, raw: false };
  if (first.cardIds) return { type: 'cards', cardIds: first.cardIds, minimum: first.count ?? first.min, maximum: first.count ?? first.max };
  if (choice.kind === 'tool-exchange') return { type: 'exchange', own: first.ownGoodIds, other: first.otherGoodIds };
  if (choice.kind === 'tool-payment-good') return { type: 'payment-good', goods: first.goodIds, payments: first.payments };
  return { type: 'option', options: choice.options };
}
export function buildChoiceSelection(pending, input) {
  const model = choiceModel(pending); if (!model) return fail('当前没有可处理的选择。');
  if (model.type === 'goods') {
    const goods = Object.fromEntries(ids.map(id => [id, Number(input.goods?.[id] ?? 0)]));
    if (ids.some(id => !quantity(goods[id]) || goods[id] > model.stock[id]) || goodsTotal(goods) < model.minimum || goodsTotal(goods) > model.maximum) return fail(`请选择${model.minimum}～${model.maximum}件现有货物。`);
    return model.raw ? goods : { goods };
  }
  if (model.type === 'cards') {
    const cardIds = input.cardIds ?? [];
    if (!Array.isArray(cardIds) || new Set(cardIds).size !== cardIds.length || cardIds.some(id => !model.cardIds.includes(id)) || cardIds.length < model.minimum || cardIds.length > model.maximum) return fail(`请选择${model.minimum}～${model.maximum}张牌。`);
    return { cardIds: [...cardIds] };
  }
  if (model.type === 'exchange') {
    if (!model.own.includes(input.ownGoodId) || !model.other.includes(input.otherGoodId)) return fail('请选择双方各一种现有货物。');
    return { ownGoodId: input.ownGoodId, otherGoodId: input.otherGoodId };
  }
  if (model.type === 'payment-good') {
    const payment = model.payments[input.paymentIndex];
    if (!model.goods.includes(input.goodId) || !payment) return fail('请选择货物和支付牌。');
    return { goodId: input.goodId, payment: copy(payment) };
  }
  const option = model.options[input.optionIndex];
  if (!option) return fail('请先选择一项。');
  return copy(option);
}
export function defaultChoiceInput(pending) {
  const model = choiceModel(pending), selected = pending?.choice?.defaultSelection;
  if (!model) return {};
  if (model.type === 'goods') return { goods: copy(model.raw ? selected : selected.goods) };
  if (model.type === 'cards') return { cardIds: [...selected.cardIds] };
  if (model.type === 'exchange') return copy(selected);
  if (model.type === 'payment-good') return { goodId: selected.goodId, paymentIndex: model.payments.findIndex(payment => same(payment, selected.payment)) };
  return { optionIndex: model.options.findIndex(option => same(option, selected)) };
}
export function knownCards(game) {
  const all = [...(game?.players.flatMap(player => [...(player.hand ?? []), ...player.tools]) ?? []), ...(game?.discard ?? []),
    ...(game?.pending?.sourceCards ?? []), ...(game?.pending?.pool ?? []), ...(game?.pending?.privatePool ?? []), ...(game?.pending?.choice?.candidateCards ?? [])];
  return new Map(all.map(card => [cardKey(card), card]));
}
export function actionDraft(game, selfId, card, type, input = {}) {
  if (!game || game.status !== 'playing' || game.turnPlayerId !== selfId || game.pending || game.clock?.paused) return fail('现在不是你的可操作阶段。');
  const self = game.players.find(player => player.id === selfId), peer = game.players.find(player => player.id !== selfId);
  const key = cardKey(card), face = getCard(card.definitionId);
  if (type === 'activate-tool') {
    if (!self.tools.some(tool => cardKey(tool) === key && !tool.exhausted)) return fail('该道具目前不可使用。');
    if (face.sourceCode === 'T07' ? game.stage !== 'draw' || game.drawStarted : game.stage !== 'use') return fail('不在这张道具的使用时机。');
    return { cardId: key, params: {} };
  }
  if (game.stage !== 'use' || !self.hand.some(item => cardKey(item) === key)) return fail('请先进入用牌阶段，并使用自己的手牌。');
  if (['buy', 'sell'].includes(type) && face.category === 'goods') return { cardId: key };
  if (type === 'buy-stall' && face.category === 'stall_permit') return { cardId: key };
  if (type === 'install-tool' && face.category === 'tool') {
    if (self.tools.length === 3) {
      if (!self.tools.some(tool => cardKey(tool) === input.replaceCardId)) return fail('请选择要弃掉的已装道具。');
      return { cardId: key, replaceCardId: input.replaceCardId };
    }
    return { cardId: key };
  }
  if (type === 'play-character' && ['ordinary_character', 'monitored_character'].includes(face.category) && !['C04','C07'].includes(face.sourceCode)) {
    if (face.sourceCode === 'M01') {
      if (!ids.includes(input.goodsId) || !peer.goods[input.goodsId]) return fail('请选择对手现有的一件货物。');
      return { cardId: key, params: { goodsId: input.goodsId } };
    }
    if (face.sourceCode === 'M08') {
      if (!peer.tools.some(tool => cardKey(tool) === input.toolCardId)) return fail('请选择对手的道具。');
      return { cardId: key, params: { toolCardId: input.toolCardId } };
    }
    return { cardId: key, params: {} };
  }
  return fail('当前牌不能执行该操作。');
}
export function tableProjection(room) {
  const game = room.game, self = game?.players.find(player => player.id === room.selfId);
  const players = (game?.players ?? room.players).map(player => ({...player, name: [...room.players,...(room.matchPlayers??[])].find(member => member.id === player.id)?.name ?? player.name ?? '伙伴',
    ready: !!room.players.find(member => member.id === player.id)?.ready, silver: player.silver ?? 20, handCount: player.handCount ?? 0, ordinaryCapacity: player.ordinaryCapacity ?? 5,
    goods: GOODS.map(good => ({id: good.id, count: player.goods?.[good.id] ?? 0})), tools: (player.tools ?? []).map(tool => ({...tool,id:cardKey(tool),tapped:tool.exhausted})) }));
  while (players.length < 2) players.push({ id: 'empty-seat', name: '等待伙伴', ready: false, silver: 0, handCount: 0, ordinaryCapacity: 5, goods: GOODS.map(good => ({id:good.id,count:0})),tools:[] });
  return {roomId:room.roomId ?? room.code,matchId:game?.matchId ?? room.matchId,selfId:room.selfId,selfRole:room.selfRole,roomCode:room.roomCode ?? room.code,
    scene: 'active',phase:room.phase,players,currentPlayerId:game?.turnPlayerId ?? room.selfId,decision:null,bookLayers:game?.bookLayers??0,closing:game?.closing??null,
    hand:(self?.hand??[]).map(card=>({...card,id:cardKey(card)})),actionLimit:game?.actionLimit??room.hyakkiConfig?.actionLimit??5,actionsUsed:game?.actionsUsed??0,goodsPerType:game?.goodsPerType??room.hyakkiConfig?.goodsPerType??6,
    clock:'--:--',deckCount:game?.deckCount??0,discardCount:game?.discard?.length??0,discard:game?.discard?.at(-1)?{...game.discard.at(-1),id:cardKey(game.discard.at(-1))}:null,
    market:GOODS.map(good=>({...good,count:game?.bankGoods?.[good.id]??room.hyakkiConfig?.goodsPerType??6})),spectatorCount:room.spectators?.length??0,
    temporaryPaid:!!self?.temporaryOccupied,expansionStock:game?.availableStalls??5,expansionPrice:game?.purchasedStalls?3:6,resultReason:''};
}
