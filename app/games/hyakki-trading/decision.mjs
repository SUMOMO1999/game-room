/** Stable decision fencing shared by the engine and its private projection. */
export function currentDecision(state) {
  const pending = state?.pending;
  if (!pending) return null;
  if (pending.choice) return { id: pending.choice.id, actorId: pending.choice.actorId, kind: pending.choice.kind };
  if (pending.response) return { id: `${pending.id}:response:${pending.response.kind}`, actorId: pending.response.actorId, kind: pending.response.kind };
  if (pending.kind === 'auction' && pending.stage === 'bidding') {
    const auction = pending.data.auction, actorId = auction.currentBidderId;
    // Pause/presence revisions must not manufacture a new bid or reset its clock.
    return { id: `${pending.id}:bid:${auction.highestBid}:${auction.passedIds.length}:${actorId}`, actorId, kind: 'auction' };
  }
  if (pending.kind === 'peek') return { id: `${pending.id}:peek`, actorId: pending.ownerId, kind: 'peek' };
  return null;
}
