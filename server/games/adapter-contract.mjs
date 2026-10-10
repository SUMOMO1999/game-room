// Server-only helpers. An adapter must explicitly define every game policy;
// there is no default draw, score, configuration or projection for a new game.
export const problem = (status, code, message) => ({ status, code, message });
export function publicFields(view, fields, gameType, extra = {}) {
  return { ...Object.fromEntries(fields.filter(field => Object.hasOwn(view, field))
    .map(field => [field, structuredClone(view[field])])), gameType, ...extra };
}
export const point = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000;
// Optional contracts have no implicit game policy. Existing engines keep the
// legacy turn, common-action and unscored-abort behavior when these are absent.
// gameClock: legacy stage clock, or null / {kind,id,deadlineAt} (room version 3).
// clockVersion:4 projects only kind,id,deadlineAt,remainingMs,paused,label.
// lifecycleTransition: {ok,state,roomPhase,returnToWaiting}; only server calls it.
// terminal:false preserves a live match; terminal results may specify the
// history status ('completed' or 'aborted'). Omission retains legacy aborts.
// checkpointOnly:true advances CAS revision without renewing activity or TTL.
// usesPresenceLifecycle opts into trusted seat evidence on presence/recovery
// events. Evidence contains observedAt and seats with playerId, connected,
// lastSeenAt, leaseExpiresAt and absenceSinceAt, never transport credentials.
// roomRetentionDeadline(state) extends generic TTL through a business deadline.
// actionConcurrencyProblem: revalidate the immutable intent on the current game.
// actionDeadline: commit-time guard, independent of the clock used for display.
// gameEndedAt(state): authoritative domain terminal timestamp, independent of
// optional point settlement. Omission preserves the existing room-time policy.
export function requireAdapter(adapter) {
  const methods = ['createGame', 'applyGameAction', 'privateView', 'spectatorView', 'stateProblem',
    'actionFields', 'validateAction', 'configurationSupportProblem', 'configure', 'roomView',
    'gameOptions', 'playerSummary', 'playerResult', 'describeAction', 'supportsTimeout',
    'applyTimeout', 'describeTimeout', 'snapshotSchema', 'snapshotProblem', 'roomStateProblem',
    'historyPlayerProblem', 'historyOutcomeProblem', 'playersChanged', 'roomDefaults', 'turnTimeoutMs'];
  if (!adapter || typeof adapter.gameType !== 'string' || !adapter.gameType
      || !Number.isSafeInteger(adapter.minPlayers) || adapter.minPlayers < 2
      || !Number.isSafeInteger(adapter.maxPlayers) || adapter.maxPlayers < adapter.minPlayers
      || !Array.isArray(adapter.ruleVersions) || !adapter.ruleVersions.length
      || !Array.isArray(adapter.actionTypes) || !Array.isArray(adapter.configurationFields)
      || methods.some(name => typeof adapter[name] !== 'function')
      || ['gameClock', 'commonActionProblem', 'lifecycleTransition', 'roomRetentionDeadline', 'actionConcurrencyProblem', 'actionDeadline',
        'gameStatusForRoomPhase', 'gameEndedAt', 'matchSummary', 'historySummaryProblem'].some(name => adapter[name] !== undefined && typeof adapter[name] !== 'function')
      || adapter.clockAdvanceActionTypes !== undefined && (!Array.isArray(adapter.clockAdvanceActionTypes)
        || typeof adapter.actionConcurrencyProblem !== 'function'
        || adapter.clockAdvanceActionTypes.some(type => !adapter.actionTypes.includes(type)))
      || adapter.recoverOnStartup !== undefined && (typeof adapter.recoverOnStartup !== 'boolean'
        || adapter.recoverOnStartup && typeof adapter.lifecycleTransition !== 'function')
      || adapter.usesPresenceLifecycle !== undefined && (typeof adapter.usesPresenceLifecycle !== 'boolean'
        || adapter.usesPresenceLifecycle && typeof adapter.lifecycleTransition !== 'function')
      || adapter.businessCasAttempts !== undefined && (!Number.isSafeInteger(adapter.businessCasAttempts)
        || adapter.businessCasAttempts < 1 || adapter.businessCasAttempts > 100)
      || adapter.disconnectTimeoutMs !== undefined && (!Number.isSafeInteger(adapter.disconnectTimeoutMs)
        || adapter.disconnectTimeoutMs < 1 || typeof adapter.lifecycleTransition !== 'function')
      || adapter.maxSnapshotBytes !== undefined && (!Number.isSafeInteger(adapter.maxSnapshotBytes) || adapter.maxSnapshotBytes < 1024)
      || adapter.accountingPolicy !== undefined && (!adapter.accountingPolicy || typeof adapter.accountingPolicy !== 'object'
        || Array.isArray(adapter.accountingPolicy) || Object.keys(adapter.accountingPolicy).length !== 2
        || typeof adapter.accountingPolicy.accountGroup !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(adapter.accountingPolicy.accountGroup ?? '')
        || typeof adapter.accountingPolicy.scoringVersion !== 'string' || !adapter.accountingPolicy.scoringVersion.length
        || adapter.accountingPolicy.scoringVersion.length > 80 || typeof adapter.matchSummary !== 'function')) throw new TypeError('游戏适配器不完整。');
  return adapter;
}

export function roomExpiry(snapshot, adapter, { ttlMs, pausedTtlMs }) {
  const ordinary = snapshot.lastActiveAt + (snapshot.phase === 'paused' ? pausedTtlMs : ttlMs);
  if (!snapshot.game || !adapter.roomRetentionDeadline) return ordinary;
  const deadline = adapter.roomRetentionDeadline(snapshot.game);
  if (deadline === null || deadline === undefined) return ordinary;
  if (!Number.isSafeInteger(deadline) || deadline < 0) throw new TypeError('游戏保留期限无效。');
  return Math.max(ordinary, deadline);
}
