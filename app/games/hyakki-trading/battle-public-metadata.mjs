import { CARDS, GOODS, materialProfile, materialProfileFor, definitionIdForCopy } from './content/definitions.mjs';

const definitions = new Map(CARDS.map(card => [card.id, card]));
const face = (id, profile) => definitionIdForCopy(id, profile) ?? (definitions.has(id) ? id : null);
const goodsIds = new Set(GOODS.map(good => good.id));
const seat = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const card = value => definitions.has(value);
const nullableCard = value => value === null || card(value);
const reasons = new Set(['used', 'draw-discarded', 'replaced', 'payment', 'response', 'auction-unsold', 'removed', 'unknown']);
const paymentChoices = new Set(['tool-search-payment', 'tool-payment-good', 'tool-payment-silver']);

export function publicBattleMetadataProblem(value, participantIds = null, context) {
  let profile;
  try {
    if (context !== undefined && typeof context?.contentVersion !== 'string') return '公开战况内容版本无效。';
    profile = context === undefined ? materialProfile() : materialProfile(context.contentVersion, context.playerCount);
  } catch { return '公开战况内容版本无效。'; }
  const maxCards = profile.deckSize;
  if (!exact(value, ['turn', 'sourceCardId', 'changes', 'discard'])) return '公开战况元数据字段无效。';
  const { turn, changes, discard } = value;
  const member = id => seat(id) && (!participantIds || participantIds.includes(id));
  if (!exact(turn, ['id', 'number', 'round', 'ownerSeatId']) || !integer(turn.number, 1)
    || turn.id !== `turn-${turn.number}` || !integer(turn.round, 1) || !member(turn.ownerSeatId)
    || !nullableCard(value.sourceCardId)) return '公开战况回合来源无效。';
  if (!Array.isArray(changes) || changes.length > 6 || new Set(changes.map(item => item?.seatId)).size !== changes.length
    || changes.some(item => !exact(item, ['seatId', 'silver', 'goods', 'handCount', 'toolsAdded', 'toolsRemoved'])
      || !member(item.seatId) || !integer(item.silver, -Number.MAX_SAFE_INTEGER) || !integer(item.handCount, -maxCards, maxCards)
      || !Array.isArray(item.goods) || item.goods.length > 6 || new Set(item.goods.map(good => good?.id)).size !== item.goods.length
      || item.goods.some(good => !exact(good, ['id', 'delta']) || !goodsIds.has(good.id) || !integer(good.delta, -20, 20) || good.delta === 0)
      || ['toolsAdded', 'toolsRemoved'].some(key => !Array.isArray(item[key]) || item[key].length > 3
        || item[key].some(id => definitions.get(id)?.category !== 'tool'))
      || !(item.silver || item.handCount || item.goods.length || item.toolsAdded.length || item.toolsRemoved.length))) return '公开战况资源变化无效。';
  if (!exact(discard, ['beforeCount', 'afterCount', 'removed', 'added']) || !integer(discard.beforeCount, 0, maxCards)
    || !integer(discard.afterCount, 0, maxCards) || !Array.isArray(discard.removed) || !Array.isArray(discard.added)
    || discard.removed.length > maxCards || discard.added.length > maxCards
    || discard.beforeCount - discard.removed.length + discard.added.length !== discard.afterCount
    || new Set(discard.removed.map(item => item?.index)).size !== discard.removed.length
    || new Set(discard.added.map(item => item?.index)).size !== discard.added.length
    || discard.removed.some(item => !exact(item, ['index', 'cardId']) || !integer(item.index, 0, discard.beforeCount - 1) || !card(item.cardId))
    || discard.added.some(item => !exact(item, ['index', 'cardId', 'actorSeatId', 'reason', 'sourceCardId'])
      || !integer(item.index, 0, discard.afterCount - 1) || !card(item.cardId)
      || item.actorSeatId !== null && !member(item.actorSeatId) || !reasons.has(item.reason) || !nullableCard(item.sourceCardId))) return '公开弃牌来源无效。';
  return null;
}

function publicSource(before, after, profile) {
  const pending = before?.pending;
  if (pending && ['character', 'tool', 'trade', 'auction'].includes(pending.kind) && pending.sourceCards.length) return face(pending.sourceCards[0], profile);
  const event = after.lastPublicEvents.find(item => ['character-played', 'tool-activated', 'trade-bought', 'trade-sold'].includes(item.type));
  return event?.cardId ?? null;
}

function discardOrigin(copyId, before, after, sourceCardId, profile) {
  const unknown = { actorSeatId: null, reason: 'unknown', sourceCardId };
  if (!before) return unknown;
  const pending = before.pending, definitionId = face(copyId, profile), events = after.lastPublicEvents;
  if (pending?.kind === 'peek' && pending.poolCards.includes(copyId)
    && events.some(event => event.type === 'draw-discarded' && event.actorSeatId === pending.ownerId && event.cardId === definitionId)) {
    return { actorSeatId: pending.ownerId, reason: 'draw-discarded', sourceCardId: null };
  }
  if (pending?.sourceCards.includes(copyId)) return { actorSeatId: pending.ownerId, reason: 'used', sourceCardId };
  if (pending?.kind === 'auction' && pending.poolCards.includes(copyId) && pending.data.auction.highestBidderId === null
    && !after.pending) return { actorSeatId: pending.ownerId, reason: 'auction-unsold', sourceCardId };
  const owner = before.players.find(player => player.hand.includes(copyId));
  if (owner) {
    const removedWithFace = owner.hand.filter(id => face(id, profile) === definitionId && !after.players.find(player => player.id === owner.id).hand.includes(id));
    if (removedWithFace.length === 1) {
      const response = events.find(event => event.type === 'response-played' && event.actorSeatId === owner.id && event.cardId === definitionId);
      if (response) return { actorSeatId: owner.id, reason: 'response', sourceCardId };
      const used = events.find(event => ['character-played', 'trade-bought', 'trade-sold'].includes(event.type)
        && event.actorSeatId === owner.id && event.cardId === definitionId);
      if (used) return { actorSeatId: owner.id, reason: 'used', sourceCardId: definitionId };
    }
    if (pending?.choice?.actorId === owner.id && paymentChoices.has(pending.choice.kind)) {
      return { actorSeatId: owner.id, reason: 'payment', sourceCardId };
    }
  }
  const equipped = before.players.find(player => player.tools.some(tool => tool.cardId === copyId));
  const installed = equipped && events.find(event => event.type === 'tool-installed' && event.actorSeatId === equipped.id);
  if (installed) return { actorSeatId: equipped.id, reason: 'replaced', sourceCardId: installed.cardId };
  if (equipped && pending?.choice?.actorId === equipped.id && paymentChoices.has(pending.choice.kind)) {
    return { actorSeatId: equipped.id, reason: 'payment', sourceCardId };
  }
  return unknown;
}

/** Trusted owner input only. Output contains no copy IDs, hands, pending
 * choices, shuffle data or future card faces; it is safe for every viewer. */
export function projectPublicBattleMetadata(before, after) {
  const profile = materialProfileFor(after);
  const origin = before?.matchId === after.matchId ? before : null, turn = origin ?? after;
  if (origin && (origin.contentVersion !== after.contentVersion || origin.players.length !== after.players.length)) throw TypeError('公开战况内容版本不一致。');
  const sourceCardId = publicSource(origin, after, profile), previousDiscard = origin?.discard ?? [], nextDiscard = after.discard;
  const changes = origin ? after.players.flatMap(player => {
    const old = origin.players.find(item => item.id === player.id), removed = old.tools.filter(tool => !player.tools.some(item => item.cardId === tool.cardId));
    const added = player.tools.filter(tool => !old.tools.some(item => item.cardId === tool.cardId));
    const value = { seatId: player.id, silver: player.silver - old.silver,
      goods: GOODS.flatMap(good => player.goods[good.id] !== old.goods[good.id] ? [{ id: good.id, delta: player.goods[good.id] - old.goods[good.id] }] : []),
      handCount: player.hand.length - old.hand.length, toolsAdded: added.map(tool => face(tool.cardId, profile)), toolsRemoved: removed.map(tool => face(tool.cardId, profile)) };
    return value.silver || value.handCount || value.goods.length || value.toolsAdded.length || value.toolsRemoved.length ? [value] : [];
  }) : [];
  // A reshuffle/reordering cannot preserve provenance by matching definitions.
  // Reset those positions to unknown, including cards that happen to reappear.
  const previousShared = previousDiscard.filter(id => nextDiscard.includes(id)), nextShared = nextDiscard.filter(id => previousDiscard.includes(id));
  const recycled = origin && previousDiscard.some(id => after.deck.includes(id)
    || after.pending?.poolCards.includes(id) || after.players.some(player => player.hand.includes(id)
      || player.tools.some(tool => tool.cardId === id)))
    || origin && after.lastPublicEvents.some(event => event.type === 'search-revealed' && event.cardIds.length > origin.deck.length);
  const reordered = Boolean(recycled) || previousShared.some((id, index) => id !== nextShared[index]);
  const removed = previousDiscard.flatMap((id, index) => reordered || !nextDiscard.includes(id) ? [{ index, cardId: face(id, profile) }] : []);
  const added = nextDiscard.flatMap((id, index) => reordered || !previousDiscard.includes(id)
    ? [{ index, cardId: face(id, profile), ...(reordered && previousDiscard.includes(id)
      ? { actorSeatId: null, reason: 'unknown', sourceCardId: null } : discardOrigin(id, origin, after, sourceCardId, profile)) }] : []);
  const value = { turn: { id: turn.turnId, number: turn.turnNumber, round: turn.round, ownerSeatId: turn.turnPlayerId },
    sourceCardId, changes, discard: { beforeCount: previousDiscard.length, afterCount: nextDiscard.length, removed, added } };
  const issue = publicBattleMetadataProblem(value, after.players.map(player => player.id), profile);
  if (issue) throw TypeError(issue); return value;
}
