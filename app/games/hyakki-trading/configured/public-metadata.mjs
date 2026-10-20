// Public projection adapted from the accepted legacy provenance algorithm.
import {GOODS,definitionIdForCopy,materialProfileFor} from './material.mjs';
import {expansionPublicMetadataProblem} from '../expansion-public-history.mjs';
const face=(id,profile)=>definitionIdForCopy(id,profile);
const paymentChoices=new Set(['tool-search-payment','tool-payment-good','tool-payment-silver','accountant-discard','role-reset-tool','tool-goods-card-swap']);
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
export function projectConfiguredPublicMetadata(before, after) {
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
  const role=origin?.pending?.kind==='role'?origin.players.find(p=>p.id===origin.pending.ownerId):null;
  const used=after.lastPublicEvents.find(e=>e.type==='role-used')??(!sourceCardId?after.lastPublicEvents.find(e=>e.type==='role-triggered'&&e.roleId==='yousei.role.r15'):null);
  const source=role?{kind:'role',roleId:role.roleId,actorSeatId:role.id}:used?{kind:'role',roleId:used.roleId,actorSeatId:used.actorSeatId}
    :sourceCardId?{kind:'card',definitionId:sourceCardId}:null;
  const value={anchor:{kind:'turn',id:turn.turnId,number:turn.turnNumber,round:turn.round,ownerSeatId:turn.turnPlayerId},source,
    rolesRevealed:[],changes,discard:{beforeCount:previousDiscard.length,afterCount:nextDiscard.length,
      removed:removed.map(({index,cardId})=>({index,definitionId:cardId})),
      added:added.map(({index,cardId,actorSeatId,reason,sourceCardId:card})=>({index,definitionId:cardId,actorSeatId,reason,
        source:card?{kind:'card',definitionId:card}:source}))}};
  const issue = expansionPublicMetadataProblem(value,{contentVersion:after.contentVersion,participantIds:after.players.map(p=>p.id)});
  if (issue) throw TypeError(issue); return value;
}
