/** Ordinary practice decisions use only the deciding seat's private projection. */
import { GOODS, getCard } from './content/definitions.mjs';

const count = vector => Object.values(vector).reduce((sum, value) => sum + value, 0);
const covers = (stock, recipe) => Object.entries(recipe).every(([id, amount]) => stock[id] >= amount);
const canAdd = (owner, amount, cost = 0) => {
  const total = count(owner.goods) + amount;
  return total <= owner.ordinaryCapacity + 1
    && owner.silver >= cost + (total > owner.ordinaryCapacity && !owner.temporaryOccupied ? 2 : 0);
};
function legalView(view, playerId, now, allowPaused) {
  return view?.gameType === 'hyakki-trading' && view.viewerId === playerId && view.status === 'playing'
    && !Object.hasOwn(view, 'deck') && !Object.hasOwn(view, 'lifecycle') && !view.pending?.data
    && Array.isArray(view.players) && view.players.length === 2
    && view.players.every(owner => owner.id === playerId ? Array.isArray(owner.hand) && owner.hand.every(card => typeof card?.cardId === 'string'
      && typeof card.definitionId === 'string') : !Object.hasOwn(owner, 'hand'))
    && !view.holds?.manual && !view.holds?.absence && !view.holds?.capacity
    && (!view.clock?.paused || allowPaused === true) && (now === undefined || Number.isSafeInteger(now) && now >= 0
      && (view.clock?.deadlineAt === null || view.clock?.deadlineAt > now));
}
const jitter = text => {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
};
function faceValue(definition) {
  if (definition.category === 'goods') return 20 + definition.sellSilver;
  if (definition.category === 'tool') return 22;
  if (definition.category === 'stall_permit') return 9;
  if (['C04', 'C07'].includes(definition.sourceCode)) return 12;
  return ['C01', 'C05', 'C08', 'C13', 'M01', 'M04'].includes(definition.sourceCode) ? 28 : 18;
}
function ordinaryActions(view) {
  const owner = view.players.find(item => item.id === view.viewerId), peer = view.players.find(item => item.id !== view.viewerId);
  const available = view.deckCount + view.discard.length, ownGoods = count(owner.goods), bankGoods = count(view.bankGoods);
  const cards = owner.hand.map(card => ({ ...card, face: getCard(card.definitionId) })), actions = [];
  if (view.remainingActions <= 0) return [{ type: 'end-turn' }];
  const canTribute = peer.silver >= 2 && Number.isSafeInteger(owner.silver + 2);
  for (const card of cards) {
    const face = card.face, cardId = card.cardId;
    if (face.category === 'goods') {
      const sell = face.sellSilver + view.bookLayers * 2, buy = Math.max(0, face.buySilver - view.bookLayers * 2);
      if (covers(owner.goods, face.goods) && Number.isSafeInteger(owner.silver + sell)) actions.push({ type: 'sell', cardId });
      if (covers(view.bankGoods, face.goods) && canAdd(owner, count(face.goods), buy)) actions.push({ type: 'buy', cardId });
    } else if (face.category === 'stall_permit') {
      if (view.availableStalls > 0 && owner.silver >= (view.purchasedStalls ? 3 : 6)) actions.push({ type: 'buy-stall', cardId });
    } else if (face.category === 'tool') {
      if (owner.tools.length < 3) actions.push({ type: 'install-tool', cardId });
      else for (const tool of owner.tools) actions.push({ type: 'install-tool', cardId, replaceCardId: tool.cardId });
    } else {
      let allowed = false;
      switch (face.sourceCode) {
        case 'C01': allowed = available > 0 || bankGoods > 0; break;
        case 'C02': allowed = available > 0; break;
        case 'C03': allowed = true; break;
        case 'C05': allowed = ownGoods >= 3 && cards.some(other => other.face.category === 'goods'
          && count(other.face.goods) === 3 && Number.isSafeInteger(owner.silver + other.face.sellSilver + view.bookLayers * 2)); break;
        case 'C06': allowed = GOODS.some(from => owner.goods[from.id] > 0 && GOODS.some(to => to.id !== from.id
          && view.bankGoods[to.id] >= owner.goods[from.id])); break;
        case 'C08': allowed = owner.hand.length - 1 < 5 && available > 0 || peer.handCount > 3; break;
        case 'C09': allowed = bankGoods >= 2 && view.players.some(item => item.silver >= 1); break;
        case 'C10': allowed = owner.silver >= 2 && GOODS.some(good => view.bankGoods[good.id] >= 2); break;
        case 'C11': allowed = view.discard.some(item => getCard(item.definitionId).category === 'tool'); break;
        case 'C12': allowed = available >= 3 && view.players.some(item => item.silver >= 1); break;
        case 'C13': allowed = ownGoods >= 1 && Number.isSafeInteger(owner.silver + 2); break;
        case 'M01':
          for (const good of GOODS) if (peer.goods[good.id] > 0) actions.push({ type: 'play-character', cardId, params: { goodsId: good.id } });
          break;
        case 'M02': allowed = owner.hand.length - 1 + peer.handCount > 0; break;
        case 'M03': allowed = owner.tools.length > 1 || peer.tools.length > 1; break;
        case 'M04': allowed = canTribute || available > 0; break;
        case 'M05': allowed = ownGoods + count(peer.goods) > 0; break;
        case 'M06': allowed = owner.tools.length + peer.tools.length > 0; break;
        case 'M07': allowed = peer.handCount > 0; break;
        case 'M08':
          for (const tool of peer.tools) actions.push({ type: 'play-character', cardId, params: { toolCardId: tool.ref } });
          break;
      }
      if (allowed) actions.push({ type: 'play-character', cardId, params: {} });
    }
  }
  for (const tool of owner.tools) {
    if (tool.exhausted) continue;
    const code = getCard(tool.definitionId).sourceCode;
    let allowed = false;
    switch (code) {
      case 'T01': allowed = available > 0 && (owner.silver >= 1 || owner.hand.length > 0); break;
      case 'T02': allowed = ownGoods > 0 && count(peer.goods) > 0; break;
      case 'T03': allowed = owner.hand.length > 0; break;
      case 'T04': allowed = available >= 2; break;
      case 'T05': allowed = available > 0 && owner.silver >= 1; break;
      case 'T06': allowed = ownGoods > 0 && available > 0; break;
      case 'T08': allowed = Number.isSafeInteger(owner.silver + 2); break;
      case 'T09': allowed = bankGoods > 0 && canAdd(owner, 1, 2); break;
      case 'T10': allowed = bankGoods > 0 && canAdd(owner, 1); break;
    }
    if (allowed) actions.push({ type: 'activate-tool', cardId: tool.cardId, params: {} });
  }
  actions.push({ type: 'end-turn' }); return actions;
}
function pendingActions(view) {
  const pending = view.pending, decision = pending.decision;
  if (pending.actorId !== view.viewerId || !decision?.defaultSelection) return [];
  if (pending.choice) return [{ type: 'choose-effect', selection: structuredClone(decision.defaultSelection) }];
  if (pending.kind === 'auction') {
    const bid = decision.options.find(option => option.type === 'bid');
    return [...(bid ? [{ type: 'bid', amount: bid.minimum }] : []), { type: 'pass-bid' }];
  }
  return decision.options.map(option => structuredClone(option));
}

/** Enumerates only publicly provable ordinary moves and projected legal choices.
 * No engine trial, hidden deck, opposing hand, or material reconstruction occurs. */
export function legalHyakkiPracticeActions(view, playerId = view?.viewerId, { now, allowPaused = false } = {}) {
  if (!legalView(view, playerId, now, allowPaused)) return [];
  let actions;
  if (view.pending) actions = pendingActions(view);
  else if (view.turnPlayerId !== playerId) return [];
  else if (view.stage === 'use') actions = ordinaryActions(view);
  else {
    const owner = view.players.find(item => item.id === playerId);
    const firstPeekRequired = !view.drawStarted && view.deckCount + view.discard.length > 0;
    actions = firstPeekRequired ? [] : [{ type: 'finish-draw' }, { type: 'end-turn' }];
    if (view.remainingActions > 0) {
      if (view.deckCount + view.discard.length > 0) actions.unshift({ type: 'peek' });
      if (!view.drawStarted && owner.hand.length && view.discard.length && view.remainingActions >= 2) for (const tool of owner.tools) {
        if (!tool.exhausted && getCard(tool.definitionId).sourceCode === 'T07') actions.unshift({ type: 'activate-tool', cardId: tool.cardId, params: {} });
      }
    }
  }
  const fence = { matchId: view.matchId, turnId: view.turnId, expectedRevision: view.revision,
    ...(view.pending ? { effectId: view.pending.id, decisionId: view.pending.decisionId } : {}) };
  return actions.map(action => ({ ...action, ...fence }));
}

function choosePending(view, actions) {
  const pending = view.pending, owner = view.players.find(item => item.id === view.viewerId);
  if (pending.choice) return actions[0]; // The complete engine-supplied default also covers every future mandatory selector.
  if (pending.response) return actions.find(action => action.type === 'respond') ?? actions[0];
  if (pending.kind === 'peek') return actions.find(action => action.type === 'keep-peek') ?? actions[0];
  if (pending.kind === 'auction') {
    const ceiling = pending.auction.kind === 'goods' ? 3 : 4;
    return actions.find(action => action.type === 'bid' && action.amount <= ceiling && owner.silver - action.amount >= 4)
      ?? actions.find(action => action.type === 'pass-bid');
  }
  return actions[0];
}
function ordinaryScore(view, action) {
  const owner = view.players.find(item => item.id === view.viewerId), peer = view.players.find(item => item.id !== view.viewerId);
  const card = [...owner.hand, ...owner.tools].find(item => item.cardId === action.cardId), face = card && getCard(card.definitionId);
  if (action.type === 'end-turn') return owner.silver >= 60 ? 1000 : view.remainingActions >= 2
    && jitter(`${view.matchId}:${view.turnId}`) % 24 === 0 ? 95 : 0;
  if (action.type === 'sell') return 115 + face.sellSilver;
  if (action.type === 'buy') {
    const future = Object.fromEntries(GOODS.map(({ id }) => [id, owner.goods[id] + (face.goods[id] ?? 0)]));
    return owner.hand.some(other => other.cardId !== action.cardId && getCard(other.definitionId).category === 'goods'
      && covers(future, getCard(other.definitionId).goods)) ? 85 : 50;
  }
  if (action.type === 'buy-stall') return count(owner.goods) >= owner.ordinaryCapacity - 1 && owner.silver >= 12 ? 65 : 12;
  if (action.type === 'install-tool') {
    if (!action.replaceCardId) return 35;
    const old = owner.tools.find(tool => tool.cardId === action.replaceCardId);
    return faceValue(face) > faceValue(getCard(old.definitionId)) ? 20 : -20;
  }
  if (action.type === 'activate-tool') {
    if (['T01', 'T05'].includes(face.sourceCode) && owner.hand.length >= 7) return -10;
    return face.sourceCode === 'T08' ? 65 : 40;
  }
  if (action.type === 'play-character') {
    switch (face.sourceCode) {
      case 'C05': return 105;
      case 'C13': return 90;
      case 'C03': return view.remainingActions >= 2 && owner.hand.some(item => getCard(item.definitionId).category === 'goods'
        && covers(owner.goods, getCard(item.definitionId).goods)) ? 145 : 4;
      case 'C01': case 'C02': case 'C08': return 65;
      case 'M01': return 65;
      case 'M02': return peer.handCount > owner.hand.length ? 60 : 18;
      case 'M03': return peer.tools.length > owner.tools.length ? 60 : 4;
      case 'M04': return 60;
      case 'M05': return count(peer.goods) > count(owner.goods) ? 55 : 12;
      case 'M06': return peer.tools.length > owner.tools.length ? 55 : 15;
      case 'M07': return 20;
      case 'M08': return 55;
      default: return 45;
    }
  }
  return 0;
}

export function chooseHyakkiPracticeAction(view, playerId = view?.viewerId, options = {}) {
  const actions = legalHyakkiPracticeActions(view, playerId, options);
  if (!actions.length) return null;
  if (view.pending) return choosePending(view, actions);
  if (view.stage === 'draw') {
    const owner = view.players.find(item => item.id === playerId), paper = actions.find(action => action.type === 'activate-tool');
    if (paper) {
      const low = [...owner.hand].sort((a, b) => faceValue(getCard(a.definitionId)) - faceValue(getCard(b.definitionId)) || a.cardId.localeCompare(b.cardId))[0];
      if (faceValue(getCard(view.discard.at(-1).definitionId)) > faceValue(getCard(low.definitionId)))
        return { ...paper, params: { cardId: low.cardId } };
    }
    if (!view.drawStarted && view.deckCount + view.discard.length > 0) return actions.find(action => action.type === 'peek');
    if (owner.silver >= 60) return actions.find(action => action.type === 'end-turn');
    const useful = ordinaryActions(view).some(action => ['buy', 'sell', 'play-character', 'activate-tool'].includes(action.type));
    const wantsCard = owner.hand.length < 4 || !useful || jitter(`${view.matchId}:${view.turnId}:draw`) % (view.actionLimit === 1 ? 3 : 4) === 0;
    return wantsCard && actions.find(action => action.type === 'peek') || actions.find(action => action.type === 'finish-draw');
  }
  return actions.map((action, index) => ({ action, index, score: ordinaryScore(view, action)
    + (action.type === 'end-turn' ? 0 : jitter(`${view.matchId}:${view.revision}:${JSON.stringify(action)}`) % 13) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0].action;
}

export const chooseHyakkiBotAction = chooseHyakkiPracticeAction;
