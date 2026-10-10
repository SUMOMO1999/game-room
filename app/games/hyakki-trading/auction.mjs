import { requireRule, player, opponent, goodsCount, goodsEntries, moveGoods, ordinaryCapacity,
  addSilver, discardCards, receiveGoods, completePending, emit, definition } from './model.mjs';

export const AUCTION_PENDING_CONTRACT = Object.freeze({
  stages: Object.freeze(['bidding', 'settling', 'delivering']),
  dataKeys: Object.freeze(['auction', 'paidSilver']),
  auctionKeys: Object.freeze(['kind', 'currentBidderId', 'highestBid', 'highestBidderId', 'passedIds', 'released']),
  choiceKind: 'retain-goods', publicPool: true,
});
const publicGoods = goods => goodsEntries(goods).map(([id, count]) => ({ id, count }));

function current(state) {
  const pending = state.pending;
  requireRule(pending?.kind === 'auction' && pending.data.auction, '当前没有拍卖。');
  return { pending, auction: pending.data.auction };
}
function canBidForGoods(bidder, amount) {
  // A two-good lot always has a legal ordinary-space retention plan: old
  // stock may be discarded. Do not incorrectly reserve a mandatory temp fee.
  return bidder.silver >= amount && ordinaryCapacity(bidder) >= 1;
}

/** The parent character has already fixed all public auction materials. */
export function beginAuction(state, { ownerId, kind }, ctx) {
  const pending = state.pending;
  requireRule(pending && pending.ownerId === ownerId && ['goods', 'cards'].includes(kind)
    && !pending.response && !pending.choice && !pending.receipt, '拍卖材料尚未准备好。');
  requireRule(kind === 'goods' ? goodsCount(pending.goods) === 2 && pending.poolCards.length === 0
    : pending.poolCards.length === 3 && goodsCount(pending.goods) === 0, '拍品必须是完整的一组。');
  player(state, ownerId);
  pending.kind = 'auction'; pending.stage = 'bidding';
  pending.data = { auction: { kind, currentBidderId: ownerId, highestBid: 0, highestBidderId: null, passedIds: [], released: false } };
  emit(state, { type: 'auction-revealed', actorSeatId: ownerId,
    ...(kind === 'cards' ? { cardIds: pending.poolCards.map(cardId => definition(cardId).id) } : { goods: publicGoods(pending.goods) }) });
}

export function bid(state, actorId, amount, ctx) {
  const { pending, auction } = current(state), bidder = player(state, actorId);
  requireRule(pending.stage === 'bidding' && auction.currentBidderId === actorId && !auction.passedIds.includes(actorId), '当前不由你叫价。');
  requireRule(Number.isSafeInteger(amount) && amount >= 1 && amount > auction.highestBid
    && amount <= bidder.silver && (auction.kind !== 'goods' || canBidForGoods(bidder, amount)), '报价须加至少1两，并有可完成的支付与保留方案。');
  auction.highestBid = amount; auction.highestBidderId = actorId;
  emit(state, { type: 'bid-raised', actorSeatId: actorId, silver: amount });
  const nextId = opponent(state, actorId).id;
  if (auction.passedIds.includes(nextId)) { pending.stage = 'settling'; continueAuction(state, ctx); }
  else auction.currentBidderId = nextId;
}

export function passBid(state, actorId, ctx) {
  const { pending, auction } = current(state);
  requireRule(pending.stage === 'bidding' && auction.currentBidderId === actorId && !auction.passedIds.includes(actorId), '当前不由你放弃叫价。');
  auction.passedIds.push(actorId); emit(state, { type: 'bid-passed', actorSeatId: actorId });
  if (auction.highestBidderId || auction.passedIds.length === state.players.length) {
    pending.stage = 'settling'; continueAuction(state, ctx);
  } else auction.currentBidderId = opponent(state, actorId).id;
}

export function continueAuction(state, ctx) {
  const { pending, auction } = current(state);
  if (pending.choice || pending.receipt || pending.stage === 'bidding') return;
  if (pending.stage === 'delivering') { completePending(state); return; }
  requireRule(pending.stage === 'settling', '拍卖步骤无效。');
  auction.currentBidderId = null;
  if (!auction.highestBidderId) {
    moveGoods(pending.goods, state.bankGoods, { ...pending.goods });
    discardCards(state, pending.poolCards.splice(0)); completePending(state); return;
  }
  const winner = player(state, auction.highestBidderId);
  addSilver(winner, -auction.highestBid);
  pending.data.paidSilver = auction.highestBid;
  emit(state, { type: 'auction-settled', actorSeatId: pending.ownerId, targetSeatId: winner.id, silver: auction.highestBid,
    ...(auction.kind === 'cards' ? { cardIds: pending.poolCards.map(cardId => definition(cardId).id) } : { goods: publicGoods(pending.goods) }) });
  pending.stage = 'delivering';
  if (auction.kind === 'cards') { winner.hand.push(...pending.poolCards.splice(0)); completePending(state); }
  else if (receiveGoods(state, winner.id, { ...pending.goods })) completePending(state);
}
