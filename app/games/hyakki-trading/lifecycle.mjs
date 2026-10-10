/** Pure business time. Transport credentials and connection IDs never enter a saved game. */
export const TURN_MS = 30 * 60 * 1000;
export const RESPONSE_MS = 60 * 1000;
export const ABSENCE_MS = 30 * 60 * 1000;
export const PAUSE_MS = 7 * 24 * 60 * 60 * 1000;
const stamp = value => Number.isSafeInteger(value) && value >= 0;
const clone = value => structuredClone(value);
const deadline = (at, duration) => {
  if (!stamp(at) || !stamp(duration) || !Number.isSafeInteger(at + duration)) throw new TypeError('计时参数无效。');
  return at + duration;
};
const held = game => Boolean(game.lifecycle.manual || game.lifecycle.absence || game.lifecycle.capacity);
const fail = error => ({ ok: false, error });
const phase = game => game.status === 'finished' ? 'finished' : game.status === 'aborted' ? 'aborted' : held(game) ? 'paused' : 'playing';

function evidence(presence, ids, now) {
  if (!presence || !stamp(presence.observedAt) || presence.observedAt > now || !Array.isArray(presence.seats)) return [];
  return ids.map(playerId => {
    const seat = presence.seats.find(entry => entry.playerId === playerId);
    if (!seat || ![seat.lastSeenAt, seat.leaseExpiresAt, seat.absenceSinceAt].every(value => value === null || stamp(value))) return null;
    // The shared transport records a close notification as lastSeen even when
    // its connection lease has already expired. That notification cannot renew
    // business presence or move the persisted checkpoint beyond that lease.
    const lastSeenAt = seat.lastSeenAt !== null && seat.leaseExpiresAt !== null
      ? Math.min(seat.lastSeenAt, seat.leaseExpiresAt) : seat.lastSeenAt;
    return { playerId, connected: seat.connected === true && seat.leaseExpiresAt > now,
      lastSeenAt, leaseExpiresAt: seat.leaseExpiresAt, absenceSinceAt: seat.absenceSinceAt };
  }).filter(Boolean);
}
function allOnline(game, presence, now) {
  const seats = evidence(presence, game.players.map(player => player.id), now);
  return seats.length === game.players.length && seats.every(seat => seat.connected);
}
function freeze(game, at) {
  for (const clock of [game.timing.active, game.timing.decision]) {
    if (clock?.deadlineAt !== null && clock?.deadlineAt !== undefined) {
      clock.remainingMs = Math.min(clock.remainingMs, Math.max(0, clock.deadlineAt - at));
      clock.deadlineAt = null;
    }
  }
}
function run(game, now) {
  if (held(game) || game.status !== 'playing') return;
  const clock = game.timing.decision ?? game.timing.active;
  if (clock.deadlineAt === null) clock.deadlineAt = deadline(now, clock.remainingMs);
}
export function createHyakkiTiming(playerIds, turnPlayerId, now, presence) {
  if (!Array.isArray(playerIds) || playerIds.length !== 2 || new Set(playerIds).size !== 2 || !playerIds.includes(turnPlayerId)) {
    throw new TypeError('计时席位无效。');
  }
  const seats = evidence(presence, playerIds, now);
  return {
    timing: { active: { id: 'turn-1', actorId: turnPlayerId, remainingMs: TURN_MS, deadlineAt: deadline(now, TURN_MS) }, decision: null },
    lifecycle: { startedAt: now, checkpoints: playerIds.map(playerId => {
      const seat = seats.find(entry => entry.playerId === playerId);
      return { playerId, lastSeenAt: seat?.lastSeenAt ?? now, leaseExpiresAt: seat?.leaseExpiresAt ?? now };
    }), absence: null, manual: null, capacity: false },
  };
}

/** Opening another player's decision freezes the active clock exactly once. */
export function openHyakkiDecision(game, { id, actorId, label, now }) {
  if (phase(game) !== 'playing' || game.timing.decision || !game.players.some(player => player.id === actorId)
      || actorId === game.turnPlayerId || typeof id !== 'string' || !id || typeof label !== 'string' || !label || label.length > 40) {
    return fail('当前不能开启对方选择。');
  }
  const state = clone(game); freeze(state, now);
  state.timing.decision = { id, actorId, label, remainingMs: RESPONSE_MS, deadlineAt: deadline(now, RESPONSE_MS) };
  return { ok: true, state };
}
export function closeHyakkiDecision(game, now) {
  if (phase(game) !== 'playing' || !game.timing.decision) return fail('当前没有待确认的选择。');
  const state = clone(game); state.timing.decision = null; run(state, now);
  return { ok: true, state };
}
function finish(state, reason, now, winnerId = null) {
  freeze(state, now); state.status = winnerId ? 'finished' : 'aborted';
  state.result = { reason, winnerIds: winnerId ? [winnerId] : [], aborted: !winnerId, settledAt: now };
}
const expired = (game, now) => game.lifecycle.manual?.deadlineAt <= now ? 'room-expired'
  : game.lifecycle.absence?.deadlineAt <= now ? 'absence-expired' : null;
function result(before, state) {
  const changed = JSON.stringify(before) !== JSON.stringify(state);
  const a = clone(before), b = clone(state);
  a.lifecycle.checkpoints = []; b.lifecycle.checkpoints = [];
  return { ok: true, state, changed, checkpointOnly: changed && JSON.stringify(a) === JSON.stringify(b),
    roomPhase: phase(state), terminal: ['finished', 'aborted'].includes(state.status),
    ...(['finished', 'aborted'].includes(state.status) ? { status: state.status === 'finished' ? 'completed' : 'aborted' } : {}) };
}

/** All callers supply trusted server evidence, never an action body. */
export function transitionHyakkiLifecycle(game, { reason, playerId, now, presence } = {}) {
  if (!stamp(now)) return fail('服务器时间无效。');
  const state = clone(game);
  if (['finished', 'aborted'].includes(game.status)) return result(game, state);
  const expiry = expired(state, now);
  if (expiry) { finish(state, expiry, now); return result(game, state); }
  if (reason === 'voluntary-leave') {
    if (!state.players.some(player => player.id === playerId)) return fail('你不是本局参赛者。');
    finish(state, reason, now, state.players.find(player => player.id !== playerId).id);
    return result(game, state);
  }
  if (reason === 'room-expired') { finish(state, reason, now); return result(game, state); }
  if (!['presence', 'disconnected', 'server-recovery', 'capacity', 'capacity-cleared'].includes(reason)) return fail('不支持的系统状态。');
  if (reason === 'capacity-cleared') state.lifecycle.capacity = false;

  const ids = state.players.map(player => player.id), seats = evidence(presence, ids, now);
  for (const checkpoint of state.lifecycle.checkpoints) {
    const seat = seats.find(entry => entry.playerId === checkpoint.playerId);
    // Persist only credible timestamps. A missing transport record cannot move them forward.
    if (seat && seat.lastSeenAt !== null && seat.lastSeenAt >= checkpoint.lastSeenAt) {
      checkpoint.lastSeenAt = seat.lastSeenAt;
      if (seat.leaseExpiresAt !== null) checkpoint.leaseExpiresAt = seat.leaseExpiresAt;
    }
  }
  if (!state.lifecycle.manual) {
    if (allOnline(state, presence, now)) state.lifecycle.absence = null;
    else if (!state.lifecycle.absence) {
      const absentAt = Math.min(...state.lifecycle.checkpoints.filter(checkpoint =>
        !seats.find(seat => seat.playerId === checkpoint.playerId)?.connected).map(checkpoint => {
        const seat = seats.find(entry => entry.playerId === checkpoint.playerId);
        return Math.min(now, seat?.absenceSinceAt ?? checkpoint.leaseExpiresAt);
      }));
      state.lifecycle.absence = { startedAt: absentAt, deadlineAt: deadline(absentAt, ABSENCE_MS) };
      freeze(state, absentAt);
    }
  }
  const overdue = expired(state, now);
  if (overdue) finish(state, overdue, now);
  else {
    // A capacity fallback can be discovered long after a lease expired. Freeze
    // at that credible absence point first; never charge the detection delay.
    if (reason === 'capacity') { freeze(state, now); state.lifecycle.capacity = true; }
    run(state, now);
  }
  return result(game, state);
}

export function hyakkiCommonActionProblem(game, action, { now, presence } = {}) {
  if (!game || !['pause', 'resume'].includes(action.type)) return null;
  if (expired(game, now)) return '本局保留时间已到。';
  if (!allOnline(game, presence, now)) return '双方回到房间后才能暂停或继续。';
  if (game.lifecycle.absence || game.lifecycle.capacity) return '系统挂起尚未解除，请等待恢复。';
  return null;
}
export function changeHyakkiPause(game, roomPhase, now, { presence } = {}) {
  if (!game) return { ok: true, state: game };
  // The first vote does not change the phase or clocks.
  if (roomPhase === 'playing' && !game.lifecycle.manual) return { ok: true, state: game };
  const issue = hyakkiCommonActionProblem(game, { type: roomPhase === 'paused' ? 'pause' : 'resume' }, { now, presence });
  if (issue) return fail(issue);
  const state = clone(game);
  if (roomPhase === 'paused') {
    freeze(state, now);
    state.lifecycle.manual ??= { startedAt: now, deadlineAt: deadline(now, PAUSE_MS) };
  } else { state.lifecycle.manual = null; run(state, now); }
  return { ok: true, state };
}
export function hyakkiRetentionDeadline(game) {
  return Math.max(game.lifecycle.manual?.deadlineAt ?? 0, game.lifecycle.absence?.deadlineAt ?? 0);
}
export function hyakkiGameClock(game) {
  if (!game || game.status !== 'playing') return null;
  const decision = game.timing.decision, clock = decision ?? game.timing.active;
  return { clockVersion: 4, kind: decision ? 'decision' : 'turn', id: clock.id,
    deadlineAt: clock.deadlineAt, remainingMs: clock.remainingMs, paused: held(game), label: decision?.label ?? '本回合' };
}

/** Validate persisted time as data, before recovery or a private projection. */
export function hyakkiTimingProblem(game) {
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const ids = game?.players?.map(player => player.id) ?? [], life = game?.lifecycle, timing = game?.timing;
  if (ids.length !== 2 || new Set(ids).size !== 2 || !ids.includes(game.turnPlayerId)
      || !exact(life, ['startedAt', 'checkpoints', 'absence', 'manual', 'capacity']) || !stamp(life.startedAt)
      || typeof life.capacity !== 'boolean' || !Array.isArray(life.checkpoints) || life.checkpoints.length !== 2
      || life.checkpoints.some((checkpoint, index) => !exact(checkpoint, ['playerId', 'lastSeenAt', 'leaseExpiresAt'])
        || checkpoint.playerId !== ids[index] || !stamp(checkpoint.lastSeenAt) || !stamp(checkpoint.leaseExpiresAt)
        || checkpoint.leaseExpiresAt < checkpoint.lastSeenAt)
      || !exact(timing, ['active', 'decision'])) return '保存的业务时钟结构无效。';
  for (const [hold, duration] of [[life.absence, ABSENCE_MS], [life.manual, PAUSE_MS]]) {
    if (hold !== null && (!exact(hold, ['startedAt', 'deadlineAt']) || !stamp(hold.startedAt)
        || !stamp(hold.deadlineAt) || hold.deadlineAt - hold.startedAt !== duration)) return '保存的保留期限无效。';
  }
  if (life.manual && life.absence) return '手动暂停与意外离线不能互相续期。';
  for (const [clock, duration, isDecision] of [[timing.active, TURN_MS, false], [timing.decision, RESPONSE_MS, true]]) {
    if (isDecision && clock === null) continue;
    if (!exact(clock, ['id', 'actorId', 'remainingMs', 'deadlineAt', ...(isDecision ? ['label'] : [])])
        || typeof clock.id !== 'string' || !clock.id || clock.id.length > 128 || !ids.includes(clock.actorId)
        || (isDecision ? clock.actorId === game.turnPlayerId || typeof clock.label !== 'string' || !clock.label || clock.label.length > 40
          : clock.actorId !== game.turnPlayerId)
        || !stamp(clock.remainingMs) || clock.remainingMs > duration
        || clock.deadlineAt !== null && !stamp(clock.deadlineAt)) return '保存的阶段时钟无效。';
    const frozen = held(game) || game.status !== 'playing' || !isDecision && timing.decision !== null;
    if (frozen !== (clock.deadlineAt === null)) return '时钟运行状态不一致。';
  }
  return null;
}
