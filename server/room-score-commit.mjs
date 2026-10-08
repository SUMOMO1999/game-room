import { createGameScores, ScoreError } from './game-scores.mjs';

const FOREVER = Number.MAX_SAFE_INTEGER;
const summaries = value => [...(value?.pendingRecords ?? []), ...(value?.snapshot?.pendingRecords ?? [])];

/** The room and its score outbox have one commit point, including expiry and recovery. */
export function createRoomScoreCommitter({ storage, gameRegistry, now, scores }) {
  let service = scores;
  return async function commit(roomId, previous, next, { guards = [], validUntil = FOREVER } = {}) {
    const snapshot = next.snapshot ?? previous.value.snapshot;
    const adapter = snapshot && gameRegistry.gameAdapter(snapshot.gameType);
    const policy = adapter?.accountingPolicy;
    if (!policy) {
      if (guards.length === 1 && guards[0].expectedVersion !== null) {
        const guard = guards[0];
        return storage.guardedCAS('rooms', roomId, previous.version, next, FOREVER,
          { scope: guard.scope, id: guard.id, version: guard.expectedVersion,
            validUntil: Math.min(validUntil, guard.validUntil ?? FOREVER) });
      }
      if (guards.length) return storage.compareAndSwapMany({
        changes: [{ scope: 'rooms', id: roomId, expectedVersion: previous.version, value: next, expiresAt: FOREVER }], guards, validUntil,
      });
      if (validUntil !== FOREVER) return storage.guardedCAS('rooms', roomId, previous.version, next, FOREVER,
        { scope: 'rooms', id: roomId, version: previous.version, validUntil });
      return storage.replaceCAS('rooms', roomId, previous.version, next, FOREVER);
    }
    service ??= createGameScores({ storage, now });
    const oldIds = new Set(summaries(previous.value).map(entry => entry.matchId));
    const ended = summaries(next).filter(entry => !oldIds.has(entry.matchId));
    if (ended.length > 1) throw new Error('One room transition can settle only one match.');
    let prepared;
    if (ended.length) {
      const summary = ended[0];
      prepared = await service.prepareSettlement({
        matchId: summary.matchId, roomId, game: summary.game, ruleVersion: summary.ruleVersion,
        scoringVersion: summary.scoringVersion, settlementVersion: summary.settlementVersion,
        endedAt: summary.endedAt, status: summary.status, reason: summary.reason,
        participants: summary.players.map(({ userKey, seatId }) => ({ userKey, seatId })), deltas: summary.deltas,
      });
      const totals = new Map(prepared.projection.balancesAfter.map(({ userKey, total }) => [userKey, total]));
      for (const player of summary.players) player.balanceAfter = totals.get(player.userKey);
    } else if (next.snapshot?.matchId && next.snapshot.matchId !== previous.value.snapshot?.matchId) {
      prepared = await service.prepareReservation({
        matchId: snapshot.matchId, roomId, game: snapshot.gameType, ruleVersion: snapshot.game.ruleVersion,
        scoringVersion: policy.scoringVersion, startedAt: snapshot.matchStartedAt,
        participants: snapshot.matchParticipants.map(({ userKey, playerId }) => ({ userKey, seatId: playerId })),
      });
    }
    if (next.snapshot && adapter?.maxSnapshotBytes && Buffer.byteLength(JSON.stringify(next.snapshot)) > adapter.maxSnapshotBytes) {
      throw new ScoreError(503, 'ROOM_STATE_LIMIT', '牌局保存内容已达到上限，请稍后重试。');
    }
    return storage.compareAndSwapMany({
      changes: [{ scope: 'rooms', id: roomId, expectedVersion: previous.version, value: next, expiresAt: FOREVER }, ...(prepared?.changes ?? [])],
      guards: [...guards, ...(prepared?.guards ?? [])], validUntil,
    });
  };
}
