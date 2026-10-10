// Isolated Step 0A contract prototype. This is not a PARKS rules engine or a
// registered room adapter. Only the existing encrypted SQLite store is reused.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { createRoomScoreCommitter } from '../server/room-score-commit.mjs';

export const DECISION_MS = 30 * 60 * 1000;
export const CANDIDATE_SNAPSHOT_BYTES = 512 * 1024;
const FOREVER = Number.MAX_SAFE_INTEGER;
const clone = structuredClone;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const ids = players => players.map(player => player.id);
const sameIds = (one, two) => one.length === two.length && one.every(id => two.includes(id));

export function participantLimits(configuration) {
  const ranges = { solo: [1, 1], standard: [2, 5], 'two-teddy': [2, 2] };
  const range = ranges[configuration?.mode];
  if (!Object.hasOwn(ranges, configuration?.mode)) fail('INVALID_MODE');
  return { waitingMin: 1, min: range[0], max: range[1] };
}

export function validateParticipants(state) {
  if (!['waiting', 'playing', 'paused', 'finished', 'aborted'].includes(state.phase)) fail('INVALID_PHASE');
  const limits = participantLimits(state.phase === 'waiting' ? state.configuration : state.frozenConfiguration);
  const members = ids(state.players);
  if (new Set(members).size !== members.length || members.some(id => !/^human-[a-z0-9-]+$/.test(id))) fail('INVALID_HUMAN_SEATS');
  if (state.phase === 'waiting') {
    if (members.length < limits.waitingMin || members.length > limits.max) fail('WAITING_CAPACITY');
    return true;
  }
  const frozen = state.matchParticipants;
  if (!Array.isArray(frozen) || new Set(frozen).size !== frozen.length || frozen.length < limits.min
      || frozen.length > limits.max || frozen.some(id => !/^human-[a-z0-9-]+$/.test(id))) fail('FROZEN_CAPACITY');
  if (!sameIds(ids(state.game.players), frozen)) fail('INVALID_GAME_SEATS');
  if (['playing', 'paused'].includes(state.phase) && !sameIds(members, frozen)) fail('ACTIVE_SEAT_MISMATCH');
  if (members.some(id => !frozen.includes(id))) fail('UNKNOWN_MATCH_SEAT');
  return true;
}

export function waitingState(mode = 'standard', count = 1) {
  const state = { prototypeVersion: 1, revision: 0, phase: 'waiting', configuration: { mode },
    players: Array.from({ length: count }, (_, i) => ({ id: `human-${i + 1}`, ready: false })), spectators: [] };
  validateParticipants(state); return state;
}

export function configureWaiting(state, configuration) {
  if (state.phase !== 'waiting') fail('NOT_WAITING');
  const next = clone(state); next.configuration = clone(configuration);
  validateParticipants(next);
  if (next.configuration.mode !== state.configuration.mode) next.players.forEach(player => { player.ready = false; });
  return next;
}

export function changeWaitingMember(state, id, role) {
  if (state.phase !== 'waiting' || !['player', 'spectator', 'leave'].includes(role)) fail('INVALID_MEMBERSHIP_CHANGE');
  const next = clone(state), oldPlayers = ids(next.players);
  const existing = next.players.find(player => player.id === id);
  next.players = next.players.filter(player => player.id !== id);
  next.spectators = next.spectators.filter(member => member !== id);
  if (role === 'player') next.players.push(existing ?? { id, ready: false });
  if (role === 'spectator') next.spectators.push(id);
  validateParticipants(next);
  if (!sameIds(oldPlayers, ids(next.players))) next.players.forEach(player => { player.ready = false; });
  return next;
}

export function startSyntheticMatch(waiting, { steps = 1, seed = 'synthetic-seed-v1' } = {}) {
  validateParticipants(waiting);
  const { min, max } = participantLimits(waiting.configuration);
  if (waiting.phase !== 'waiting' || waiting.players.length < min || waiting.players.length > max
      || waiting.players.some(player => !player.ready)) fail('NOT_READY');
  if (!Number.isSafeInteger(steps) || steps < 0 || steps > 64) fail('INVALID_PROBE_STEPS');
  const next = clone(waiting);
  Object.assign(next, { phase: 'playing', matchId: 'synthetic-match-1', frozenConfiguration: clone(waiting.configuration),
    matchParticipants: ids(waiting.players), decisionWindow: null,
    game: { players: waiting.players.map(({ id }) => ({ id })), currentPlayer: waiting.players[0].id,
      controllers: [...waiting.players.map(({ id }) => ({ kind: 'human', seatId: id })),
        ...(waiting.configuration.mode === 'standard' ? [] : [{ kind: 'system', id: 'teddy' }])],
      systemWindowId: 'synthetic-system-window-1', systemCursor: 0, remainingSystemSteps: steps,
      random: { seed, cursor: 0 }, resources: 100, paid: 0, lastSystemStep: null } });
  validateParticipants(next); return next;
}

export function nextSystemStep(state) {
  if (state.phase !== 'playing' || state.decisionWindow || state.game.remainingSystemSteps === 0) return null;
  return { id: `${state.matchId}/${state.game.systemWindowId}/${state.game.systemCursor}`, kind: 'synthetic-draw-and-pay' };
}

export function applySystemStep(state, step) {
  const expected = nextSystemStep(state);
  if (!expected || step?.id !== expected.id || step.kind !== expected.kind) fail('STALE_SYSTEM_STEP');
  if (state.game.resources < 1) fail('INSUFFICIENT_PROBE_RESOURCE');
  const next = clone(state);
  // Counter-based deterministic fixture randomness: retrying an uncommitted
  // candidate cannot consume another random value. This is not game balance.
  const digest = createHash('sha256').update(`${next.game.random.seed}\0${next.game.random.cursor}`).digest();
  const die = digest.readUInt32BE(0) % 6 + 1;
  next.game.random.cursor += 1; next.game.systemCursor += 1; next.game.remainingSystemSteps -= 1;
  next.game.resources -= 1; next.game.paid += 1;
  next.game.lastSystemStep = { ...step, die, paid: 1 };
  return next;
}

export function openDecision(state, responsibleSeatId, now, kind = 'season-award') {
  if (state.phase !== 'playing' || !state.matchParticipants.includes(responsibleSeatId)
      || state.decisionWindow || nextSystemStep(state)) fail('INVALID_DECISION');
  const next = clone(state);
  next.decisionWindow = { id: `${state.matchId}/${kind}/1`, kind, responsibleSeatId,
    deadlineAt: now + DECISION_MS, remainingMs: DECISION_MS, pauseCause: null, status: 'active' };
  return next;
}

export function responsibilityClock(state) {
  if (!state.decisionWindow || !['playing', 'paused'].includes(state.phase)) return null;
  const { id, kind, responsibleSeatId, deadlineAt, remainingMs, status } = state.decisionWindow;
  return { id, kind, responsibleSeatId, deadlineAt, remainingMs, paused: status === 'paused' };
}

export function pauseDecision(state, now, cause, agreedIds = []) {
  const window = state.decisionWindow;
  if (state.phase !== 'playing' || !window || !['normal', 'timeout'].includes(cause)) fail('INVALID_PAUSE');
  if (cause === 'timeout' ? now < window.deadlineAt : !sameIds([...new Set(agreedIds)], state.matchParticipants)) fail('PAUSE_NOT_ALLOWED');
  const next = clone(state); next.phase = 'paused';
  Object.assign(next.decisionWindow, { deadlineAt: null, remainingMs: Math.max(0, window.deadlineAt - now),
    pauseCause: cause, status: 'paused' });
  return next;
}

export function resumeDecision(state, actorSeatId, now) {
  const window = state.decisionWindow;
  if (state.phase !== 'paused' || !window) fail('NOT_PAUSED');
  if (!state.matchParticipants.includes(actorSeatId)
      || window.pauseCause === 'timeout' && actorSeatId !== window.responsibleSeatId) fail('RESUME_FORBIDDEN');
  const next = clone(state), remainingMs = window.pauseCause === 'timeout' ? DECISION_MS : window.remainingMs;
  next.phase = 'playing';
  Object.assign(next.decisionWindow, { remainingMs, deadlineAt: now + remainingMs, pauseCause: null, status: 'active' });
  return next;
}

export function prepareSyntheticPayment(state, actorSeatId, windowId, now) {
  if (state.phase !== 'playing' || state.decisionWindow?.status !== 'active') fail('NOT_DECIDING');
  if (actorSeatId !== state.decisionWindow.responsibleSeatId) fail('DECISION_FORBIDDEN');
  if (windowId !== state.decisionWindow.id) fail('STALE_WINDOW');
  if (now >= state.decisionWindow.deadlineAt) fail('DECISION_EXPIRED');
  if (state.game.resources < 1) fail('INSUFFICIENT_PROBE_RESOURCE');
  const next = clone(state); next.game.resources -= 1; next.game.paid += 1; return next;
}

// This probe owns one non-economic rooms record, never score scopes. The
// candidate guard is deliberately outside accounting-policy selection.
export async function commitCandidate(store, roomId, previous, candidate,
  { maxSnapshotBytes = CANDIDATE_SNAPSHOT_BYTES, validUntil = FOREVER } = {}) {
  validateParticipants(candidate);
  const next = clone(candidate); next.revision = (previous?.value.snapshot.revision ?? -1) + 1;
  if (Buffer.byteLength(JSON.stringify(next)) > maxSnapshotBytes) fail('ROOM_STATE_LIMIT');
  return store.compareAndSwapMany({ changes: [{ scope: 'rooms', id: roomId,
    expectedVersion: previous?.version ?? null, value: { snapshot: next }, expiresAt: FOREVER }], guards: [], validUntil });
}

export async function driveSyntheticSteps(store, roomId, { maxSteps = 16 } = {}) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 16) fail('INVALID_BATCH');
  let committed = 0;
  for (; committed < maxSteps; committed++) {
    const saved = await store.read('rooms', roomId), step = nextSystemStep(saved.value.snapshot);
    if (!step) return { committed, needsWake: false };
    if (!await commitCandidate(store, roomId, saved, applySystemStep(saved.value.snapshot, step))) {
      return { committed, needsWake: true, conflict: true };
    }
  }
  return { committed, needsWake: Boolean(nextSystemStep((await store.read('rooms', roomId)).value.snapshot)) };
}

export function openProbeStore(path, key, now = () => 1000) {
  return new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
}
export function createProbeFixture(now = () => 1000) {
  const directory = mkdtempSync(join(tmpdir(), 'parks-step0-contract-'));
  const path = join(directory, 'probe.sqlite'), key = randomBytes(32);
  let store = openProbeStore(path, key, now);
  return { path, key, get store() { return store; },
    reopen() { store.close(); store = openProbeStore(path, key, now); return store; },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

export function readySyntheticMatch(mode = 'solo', count = 1, options) {
  const waiting = waitingState(mode, count); waiting.players.forEach(player => { player.ready = true; });
  return startSyntheticMatch(waiting, options);
}

export async function runProbe() {
  const fixture = createProbeFixture();
  try {
    const state = readySyntheticMatch('solo', 1, { steps: 20 });
    await commitCandidate(fixture.store, 'step-probe', null, state);
    const initial = await fixture.store.read('rooms', 'step-probe'), step = nextSystemStep(initial.value.snapshot);
    const candidate = applySystemStep(initial.value.snapshot, step);
    const first = await commitCandidate(fixture.store, 'step-probe', initial, candidate);
    const duplicate = await commitCandidate(fixture.store, 'step-probe', initial, candidate);
    const batch = await driveSyntheticSteps(fixture.store, 'step-probe');
    fixture.reopen();
    const child = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--resume-fixture'], {
      input: JSON.stringify({ path: fixture.path, key: fixture.key.toString('base64url'), roomId: 'step-probe' }), encoding: 'utf8',
    }));
    const resumed = (await fixture.store.read('rooms', 'step-probe')).value.snapshot;
    const beforeOversize = await fixture.store.read('rooms', 'step-probe');
    let oversizeError;
    try { await commitCandidate(fixture.store, 'step-probe', beforeOversize, { ...resumed, padding: 'x'.repeat(CANDIDATE_SNAPSHOT_BYTES) }); }
    catch (error) { oversizeError = error.code; }
    const afterOversize = await fixture.store.read('rooms', 'step-probe');
    // Recheck the actual committer with the same minimal non-economic seam.
    // The former Step0 bypass is now guarded before any durable write.
    await fixture.store.put('rooms', 'existing-committer-baseline', { snapshot: { gameType: 'synthetic-non-economic', payload: '' } });
    const actualCommit = createRoomScoreCommitter({ storage: fixture.store, now: () => 1000,
      gameRegistry: { gameAdapter: () => ({ maxSnapshotBytes: 1024 }) } });
    const actualPrevious = await fixture.store.read('rooms', 'existing-committer-baseline');
    let actualAcceptedOversize = false, actualOversizeError;
    try { actualAcceptedOversize = await actualCommit('existing-committer-baseline', actualPrevious,
      { snapshot: { gameType: 'synthetic-non-economic', payload: 'x'.repeat(2048) } }); }
    catch (error) { if (error.code !== 'ROOM_STATE_LIMIT') throw error; actualOversizeError = error.code; }
    const actualAfter = await fixture.store.read('rooms', 'existing-committer-baseline');
    const waiting = waitingState('standard', 1); waiting.players[0].ready = true;
    let startBlocked; try { startSyntheticMatch(waiting); } catch (error) { startBlocked = error.code; }
    const decision = openDecision(readySyntheticMatch('standard', 2, { steps: 0 }), 'human-2', 1000);
    const normal = pauseDecision(decision, 1100, 'normal', ['human-1', 'human-2']);
    const normalResume = resumeDecision(normal, 'human-1', 9000);
    const timeout = pauseDecision(decision, decision.decisionWindow.deadlineAt, 'timeout');
    let unauthorizedResume; try { resumeDecision(timeout, 'human-1', 2000000); } catch (error) { unauthorizedResume = error.code; }
    const timeoutResume = resumeDecision(timeout, 'human-2', 2000000);
    return { schemaVersion: 1, createdAt: new Date().toISOString(), node: process.version,
      classification: 'isolated-contract-prototype-with-existing-encrypted-sqlite',
      scope: { actualStorageReused: true, actualRoomAdapterRegistered: false, httpSseConnected: false,
        actualParksRules: false, productionChanges: false, gitChanges: false, persistentTestData: false },
      observations: {
        participantLimits: Object.fromEntries(['solo', 'standard', 'two-teddy'].map(mode => [mode, participantLimits({ mode })])),
        standardOneWaitingAccepted: validateParticipants(waiting), standardOneStartRejected: startBlocked,
        soloHumanSeats: state.players.length, soloControllers: state.game.controllers, automaticClock: responsibilityClock(state),
        firstStepId: step.id, firstCommit: first, staleDuplicateCommit: duplicate, batch,
        newProcessRecovery: child, finalPaid: resumed.game.paid, finalRandomCursor: resumed.game.random.cursor,
        snapshotBytesAfter20SyntheticSteps: Buffer.byteLength(JSON.stringify(resumed)),
        oversizeError, oversizePreservedVersion: beforeOversize.version === afterOversize.version,
        actualNonEconomicCommitterAcceptedOversize: actualAcceptedOversize,
        actualNonEconomicCommitterOversizeError: actualOversizeError,
        actualNonEconomicCommitterPreserved: actualAfter.version === actualPrevious.version && JSON.stringify(actualAfter.value) === JSON.stringify(actualPrevious.value),
        currentPlayer: decision.game.currentPlayer, clockResponsibleSeat: responsibilityClock(decision).responsibleSeatId,
        normalResumeRemainingMs: normalResume.decisionWindow.remainingMs,
        timeoutUnauthorizedResume: unauthorizedResume, timeoutResumeRemainingMs: timeoutResume.decisionWindow.remainingMs },
      limitations: ['Synthetic draw-and-pay demonstrates atomicity only, not PARKS rules or economic settlement.',
        'No real room registration, create request, HTTP/SSE, poll wakeup, history, backup import or full snapshot capacity integration.',
        '512 KiB is a candidate bound; this compact fixture does not establish a worst-case PARKS snapshot.',
        'The actual shared size guard is checked here; complete PARKS path/capacity acceptance is maintained separately.'] };
  } finally { fixture.close(); }
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--resume-fixture') {
    const input = JSON.parse(readFileSync(0, 'utf8')), store = openProbeStore(input.path, Buffer.from(input.key, 'base64url'));
    try {
      const before = (await store.read('rooms', input.roomId)).value.snapshot;
      const result = await driveSyntheticSteps(store, input.roomId);
      const after = (await store.read('rooms', input.roomId)).value.snapshot;
      process.stdout.write(JSON.stringify({ newNodeProcess: true, beforeCursor: before.game.systemCursor,
        afterCursor: after.game.systemCursor, paid: after.game.paid, randomCursor: after.game.random.cursor, ...result }));
    } finally { store.close(); }
  } else {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/parks-contract-probe.mjs [evidence-file]');
    const result = await runProbe(), output = process.argv[2];
    if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}
