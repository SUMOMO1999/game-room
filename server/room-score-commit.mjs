import { createGameScores, ScoreError } from './game-scores.mjs';

const FOREVER = Number.MAX_SAFE_INTEGER;
const summaries = value => [...(value?.pendingRecords ?? []), ...(value?.snapshot?.pendingRecords ?? [])];
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const protectedScope = scope => scope === 'rooms' || scope.startsWith('room-') || scope.startsWith('game-score-')
  || ['sessions', 'transactions', 'game-profiles', 'game-history', 'history-index'].includes(scope);

function preparers(input) {
  if (!(input instanceof Map)) throw new TypeError('Transition preparers must be a trusted startup Map.');
  return new Map([...input].map(([gameType, item]) => {
    if (typeof gameType !== 'string' || !plain(item) || Object.keys(item).some(key => !['scopes', 'prepare'].includes(key))
        || typeof item.prepare !== 'function' || !Array.isArray(item.scopes) || !item.scopes.length
        || new Set(item.scopes).size !== item.scopes.length || item.scopes.some(scope => typeof scope !== 'string'
          || !/^[a-z][a-z0-9-]{0,63}$/u.test(scope) || protectedScope(scope))) throw new TypeError('Invalid trusted transition preparer.');
    return [gameType, { scopes: new Set(item.scopes), prepare: item.prepare }];
  }));
}

function checkedPreparation(prepared, allowed) {
  if (!plain(prepared) || Object.keys(prepared).some(key => !['changes', 'guards'].includes(key))
      || !Array.isArray(prepared.changes) || !Array.isArray(prepared.guards)) throw new TypeError('Invalid additional room write set.');
  for (const item of [...prepared.changes, ...prepared.guards]) {
    if (!plain(item) || !allowed.has(item.scope)) throw new TypeError('Transition write set exceeds its owned scopes.');
  }
  const ids = prepared.changes.map(item => JSON.stringify([item.scope, item.id]));
  if (new Set(ids).size !== ids.length) throw new TypeError('Duplicate transition write identity.');
  return structuredClone(prepared);
}

/** The room and its score outbox have one commit point, including expiry and recovery. */
export function createRoomScoreCommitter({ storage, gameRegistry, now, scores, transitionPreparers = new Map() }) {
  const additional = preparers(transitionPreparers);
  let service = scores;
  return async function commit(roomId, previous, next, options = {}) {
    if (!plain(options) || Object.keys(options).some(key => !['guards', 'validUntil'].includes(key))) throw new TypeError('Unexpected room commit input.');
    const { guards = [], validUntil = FOREVER } = options;
    const snapshot = next.snapshot ?? previous.value.snapshot;
    const adapter = snapshot && gameRegistry.gameAdapter(snapshot.gameType);
    const policy = adapter?.accountingPolicy;
    function checkSnapshotSize() {
      if (next.snapshot && adapter?.maxSnapshotBytes && Buffer.byteLength(JSON.stringify(next.snapshot)) > adapter.maxSnapshotBytes) {
        throw new ScoreError(503, 'ROOM_STATE_LIMIT', '牌局保存内容已达到上限，请稍后重试。');
      }
    }
    // This boundary also applies to unscored games and all legacy fast paths.
    checkSnapshotSize();
    const extra = additional.get(snapshot?.gameType);
    if (!policy && !extra) {
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
    if (policy) service ??= createGameScores({ storage, now });
    const oldIds = new Set(summaries(previous.value).map(entry => entry.matchId));
    const ended = summaries(next).filter(entry => !oldIds.has(entry.matchId));
    if (policy && ended.length > 1) throw new Error('One room transition can settle only one match.');
    let prepared;
    if (policy && ended.length) {
      const summary = ended[0];
      prepared = await service.prepareSettlement({
        matchId: summary.matchId, roomId, game: summary.game, ruleVersion: summary.ruleVersion,
        scoringVersion: summary.scoringVersion, settlementVersion: summary.settlementVersion,
        endedAt: summary.endedAt, status: summary.status, reason: summary.reason,
        participants: summary.players.map(({ userKey, seatId }) => ({ userKey, seatId })), deltas: summary.deltas,
      });
      const totals = new Map(prepared.projection.balancesAfter.map(({ userKey, total }) => [userKey, total]));
      for (const player of summary.players) player.balanceAfter = totals.get(player.userKey);
    } else if (policy && next.snapshot?.matchId && next.snapshot.matchId !== previous.value.snapshot?.matchId) {
      prepared = await service.prepareReservation({
        matchId: snapshot.matchId, roomId, game: snapshot.gameType, ruleVersion: snapshot.game.ruleVersion,
        scoringVersion: policy.scoringVersion, startedAt: snapshot.matchStartedAt,
        participants: snapshot.matchParticipants.map(({ userKey, playerId }) => ({ userKey, seatId: playerId })),
      });
    }
    // Score totals can enlarge the terminal snapshot after the first check.
    checkSnapshotSize();
    const appended = extra ? checkedPreparation(await extra.prepare({ roomId,
      previous: structuredClone(previous.value), next: structuredClone(next) }), extra.scopes) : { changes: [], guards: [] };
    return storage.compareAndSwapMany({
      changes: [{ scope: 'rooms', id: roomId, expectedVersion: previous.version, value: next, expiresAt: FOREVER }, ...(prepared?.changes ?? []), ...appended.changes],
      guards: [...guards, ...(prepared?.guards ?? []), ...appended.guards], validUntil,
    });
  };
}
