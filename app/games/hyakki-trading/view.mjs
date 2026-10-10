/** Role projections contain faces, not globally trackable public card identities. */
import { gameProblem, cardDefinition, validCopy } from './validation.mjs';
import { hyakkiGameClock } from './lifecycle.mjs';
import { currentDecision } from './decision.mjs';
import { goodsPerTypeOf } from './model.mjs';
const clone = value => structuredClone(value);
const publicCard = (state, copyId, zone, index) => ({ ref: `${zone}:${state.revision}:${index}`, definitionId: cardDefinition(copyId).id });
const privateCard = copyId => ({ cardId: copyId, definitionId: cardDefinition(copyId).id });
const terminal = state => state.status !== 'playing';
function publicReference(state, copyId) {
  const zones = [...state.players.map((player, index) => [`tool-${index}`, player.tools.map(tool => tool.cardId)]),
    ['discard', state.discard], ['pool', state.pending?.poolCards ?? []], ['source', state.pending?.sourceCards ?? []]];
  for (const [zone, cards] of zones) {
    const index = cards.indexOf(copyId);
    if (index >= 0) return publicCard(state, copyId, zone, index);
  }
  throw new TypeError('公开选择引用了隐藏材料。');
}
function publicSelection(state, value) {
  if (validCopy(value)) return publicReference(state, value).ref;
  if (Array.isArray(value)) return value.map(item => publicSelection(state, item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicSelection(state, item)]));
  return value;
}
function candidateCards(options) {
  const found = new Set();
  const visit = value => {
    if (validCopy(value)) found.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(options); return [...found].map(privateCard);
}

function pendingView(state, viewerId) {
  const pending = state.pending;
  if (!pending) return null;
  const choice = pending.choice, decision = currentDecision(state), actorId = decision?.actorId ?? pending.ownerId;
  const publicPool = pending.kind === 'auction' || ['M02', 'M06', 'T01'].includes(pending.code);
  const privatePool = pending.kind === 'peek' || ['C02', 'T04'].includes(pending.code);
  const mine = viewerId !== null && actorId === viewerId && !terminal(state);
  const options = choice && mine ? choice.visibility === 'public' ? publicSelection(state, choice.options) : clone(choice.options) : null;
  const defaultSelection = choice && mine ? choice.visibility === 'public' ? publicSelection(state, choice.defaultSelection) : clone(choice.defaultSelection) : null;
  const view = { id: pending.id, decisionId: decision?.id ?? null, kind: pending.kind, ownerId: pending.ownerId, code: pending.code, stage: pending.stage,
    actorId, readOnly: terminal(state), sourceCards: pending.sourceCards.map((card, index) => publicCard(state, card, 'source', index)),
    poolCount: pending.poolCards.length, goods: clone(pending.goods),
    ...(publicPool ? { pool: pending.poolCards.map((card, index) => publicCard(state, card, 'pool', index)) } : {}),
    ...(privatePool && viewerId === pending.ownerId ? { privatePool: pending.poolCards.map(privateCard) } : {}),
    decision: decision ? { ...decision } : null,
    choice: choice ? { id: choice.id, kind: choice.kind, actorId: choice.actorId, visibility: choice.visibility,
      ...(mine ? { options, candidateCards: candidateCards(choice.options).map(card => choice.visibility === 'public'
        ? publicReference(state, card.cardId) : card), defaultSelection } : {}) } : null,
    response: pending.response ? { kind: pending.response.kind, actorId: pending.response.actorId } : null };
  if (pending.response && mine) {
    const code = pending.response.kind === 'counter' ? 'C07' : 'C04';
    const player = state.players.find(player => player.id === viewerId);
    view.response.cards = player.hand.filter(card => cardDefinition(card).sourceCode === code).map(privateCard);
    view.response.defaultSelection = { type: 'decline-response' };
    view.decision.options = [...view.response.cards.map(card => ({ type: 'respond', cardId: card.cardId })), { type: 'decline-response' }];
    view.decision.defaultSelection = { type: 'decline-response' };
  }
  if (mine && choice) Object.assign(view.decision, { options: clone(options), defaultSelection: clone(defaultSelection) });
  if (mine && pending.kind === 'peek') Object.assign(view.decision, {
    options: [{ type: 'keep-peek' }, { type: 'discard-peek' }], defaultSelection: { type: 'keep-peek' },
  });
  if (pending.receipt) view.receipt = { actorId: pending.receipt.actorId, goods: clone(pending.receipt.goods), previousTemporary: pending.receipt.previousTemporary };
  if (pending.kind === 'auction' && pending.data.auction) {
    view.auction = clone(pending.data.auction);
    if (mine && pending.stage === 'bidding') {
      const minimum = pending.data.auction.highestBid + 1, maximum = state.players.find(player => player.id === actorId).silver;
      Object.assign(view.decision, { options: [...(maximum >= minimum ? [{ type: 'bid', minimum, maximum }] : []), { type: 'pass-bid' }],
        defaultSelection: { type: 'pass-bid' } });
    }
  }
  // Initial public targets are already announced before counter-response; private
  // draw/order/payment bookkeeping remains inside pending.data on the server.
  if (pending.code === 'M01' && pending.data.goodsId) view.target = { goodsId: pending.data.goodsId };
  if (pending.code === 'M08' && pending.data.toolCardId) {
    const target = state.players.flatMap((player, playerIndex) => player.tools.map((tool, index) => ({ tool, index, playerIndex })))
      .find(entry => entry.tool.cardId === pending.data.toolCardId);
    if (target) view.target = publicCard(state, target.tool.cardId, `tool-${target.playerIndex}`, target.index);
    else {
      const index = state.discard.indexOf(pending.data.toolCardId);
      if (index >= 0) view.target = publicCard(state, pending.data.toolCardId, 'discard', index);
    }
  }
  return view;
}

function project(state, viewerId) {
  const issue = gameProblem(state); if (issue) throw new TypeError(issue);
  if (viewerId !== null && !state.players.some(player => player.id === viewerId)) throw new RangeError('你不是本局参赛者。');
  return { version: state.version, gameType: state.gameType, ruleVersion: state.ruleVersion, contentVersion: state.contentVersion,
    matchId: state.matchId, revision: state.revision, status: state.status, result: clone(state.result),
    firstPlayerId: state.firstPlayerId, turnPlayerId: state.turnPlayerId, turnId: state.turnId, turnNumber: state.turnNumber,
    round: state.round, stage: state.stage, actionLimit: state.actionLimit, goodsPerType: goodsPerTypeOf(state), actionsUsed: state.actionsUsed,
    remainingActions: state.actionLimit - state.actionsUsed, drawStarted: state.drawStarted, bookLayers: state.bookLayers,
    closing: clone(state.closing), deckCount: state.deck.length,
    discard: state.discard.map((card, index) => publicCard(state, card, 'discard', index)), bankGoods: clone(state.bankGoods),
    availableStalls: state.availableStalls, purchasedStalls: state.purchasedStalls,
    players: state.players.map((player, playerIndex) => ({ id: player.id, silver: player.silver, handCount: player.hand.length,
      goods: clone(player.goods), stallCount: player.stallCount, ordinaryCapacity: 5 + 3 * player.stallCount,
      temporaryOccupied: player.temporaryOccupied,
      tools: player.tools.map((tool, index) => ({ ...publicCard(state, tool.cardId, `tool-${playerIndex}`, index), exhausted: tool.exhausted,
        ...(player.id === viewerId ? { cardId: tool.cardId } : {}) })),
      ...(player.id === viewerId ? { hand: player.hand.map(privateCard) } : {}) })),
    pending: pendingView(state, viewerId), clock: clone(hyakkiGameClock(state)),
    holds: { manual: clone(state.lifecycle.manual), absence: clone(state.lifecycle.absence), capacity: state.lifecycle.capacity },
    publicEventSequence: state.publicEventSequence, lastPublicEvents: clone(state.lastPublicEvents),
    ...(viewerId !== null ? { viewerId } : {}) };
}
export const privateView = (state, playerId) => project(state, playerId);
export const spectatorView = state => project(state, null);
