import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DECISION_MS, CANDIDATE_SNAPSHOT_BYTES, participantLimits, validateParticipants, waitingState, configureWaiting,
  changeWaitingMember, startSyntheticMatch, readySyntheticMatch, nextSystemStep, applySystemStep, openDecision,
  responsibilityClock, pauseDecision, resumeDecision, prepareSyntheticPayment, commitCandidate,
  driveSyntheticSteps, createProbeFixture, openProbeStore, runProbe,
} from './parks-contract-probe.mjs';

function fixture(t, now) { const value = createProbeFixture(now); t.after(() => value.close()); return value; }
const hasCode = code => error => error.code === code;
const ready = state => { state.players.forEach(player => { player.ready = true; }); return state; };
const probeFile = fileURLToPath(new URL('./parks-contract-probe.mjs', import.meta.url));

test('mode limits distinguish one waiting human from legal start counts and reject unknown modes', () => {
  for (const [mode, min, max] of [['solo', 1, 1], ['standard', 2, 5], ['two-teddy', 2, 2]]) {
    assert.deepEqual(participantLimits({ mode }), { waitingMin: 1, min, max });
    for (let count = 1; count <= max; count++) {
      const state = ready(waitingState(mode, count));
      if (count < min) assert.throws(() => startSyntheticMatch(state), hasCode('NOT_READY'));
      else assert.equal(startSyntheticMatch(state).matchParticipants.length, count);
    }
    assert.throws(() => waitingState(mode, max + 1), hasCode('WAITING_CAPACITY'));
  }
  for (const mode of ['toString', '__proto__', '', null]) assert.throws(() => participantLimits({ mode }), hasCode('INVALID_MODE'));
});

test('configuration and player changes clear readiness; spectators preserve it; rejected capacity preserves input', () => {
  const solo = ready(waitingState('solo'));
  const friends = configureWaiting(solo, { mode: 'standard' });
  assert.equal(friends.players[0].ready, false); assert.equal(solo.configuration.mode, 'solo');
  const two = ready(changeWaitingMember(friends, 'human-2', 'player'));
  const before = structuredClone(two);
  assert.throws(() => configureWaiting(two, { mode: 'solo' }), hasCode('WAITING_CAPACITY'));
  assert.deepEqual(two, before);
  const spectator = changeWaitingMember(two, 'observer-1', 'spectator');
  assert.ok(spectator.players.every(player => player.ready));
  assert.ok(changeWaitingMember(spectator, 'observer-1', 'leave').players.every(player => player.ready));
  const one = changeWaitingMember(two, 'human-2', 'leave');
  assert.equal(one.players.length, 1); assert.equal(one.players[0].ready, false);
  assert.equal(validateParticipants(one), true);
  assert.throws(() => changeWaitingMember(solo, 'human-2', 'player'), hasCode('WAITING_CAPACITY'));
  const full = ready(waitingState('two-teddy', 2));
  assert.throws(() => changeWaitingMember(full, 'human-3', 'player'), hasCode('WAITING_CAPACITY'));
});

test('Teddy belongs to the controller loop, never human seats or frozen participants', () => {
  const state = readySyntheticMatch();
  assert.equal(state.players.length, 1); assert.deepEqual(state.matchParticipants, ['human-1']);
  assert.deepEqual(state.game.players, [{ id: 'human-1' }]);
  assert.deepEqual(state.game.controllers, [{ kind: 'human', seatId: 'human-1' }, { kind: 'system', id: 'teddy' }]);
  const forged = structuredClone(state); forged.players.push({ id: 'teddy', ready: true });
  assert.throws(() => validateParticipants(forged), hasCode('INVALID_HUMAN_SEATS'));
  const activeMissing = structuredClone(state); activeMissing.players = [];
  assert.throws(() => validateParticipants(activeMissing), hasCode('ACTIVE_SEAT_MISMATCH'));
  for (const phase of ['finished', 'aborted']) {
    const terminal = structuredClone(state); terminal.phase = phase; terminal.players = [];
    assert.equal(validateParticipants(terminal), true);
  }
});

test('two SQLite connections can prepare the same system step, but only one commits payment and randomness', async t => {
  const f = fixture(t), other = openProbeStore(f.path, f.key); t.after(() => other.close());
  await commitCandidate(f.store, 'race', null, readySyntheticMatch('solo', 1, { steps: 2 }));
  const [one, two] = await Promise.all([f.store.read('rooms', 'race'), other.read('rooms', 'race')]);
  const step = nextSystemStep(one.value.snapshot), a = applySystemStep(one.value.snapshot, step), b = applySystemStep(two.value.snapshot, step);
  assert.deepEqual(a.game.lastSystemStep, b.game.lastSystemStep);
  const results = await Promise.all([commitCandidate(f.store, 'race', one, a), commitCandidate(other, 'race', two, b)]);
  assert.equal(results.filter(Boolean).length, 1);
  const saved = (await f.store.read('rooms', 'race')).value.snapshot;
  assert.equal(saved.game.paid, 1); assert.equal(saved.game.resources, 99); assert.equal(saved.game.random.cursor, 1);
  assert.equal(saved.game.lastSystemStep.id, step.id);
  assert.throws(() => applySystemStep(saved, step), hasCode('STALE_SYSTEM_STEP'));
});

test('SQLite COMMIT failure rolls back the system cursor, payment and result, and the original step retries identically', async t => {
  const f = fixture(t); await commitCandidate(f.store, 'retry', null, readySyntheticMatch());
  const before = await f.store.read('rooms', 'retry'), step = nextSystemStep(before.value.snapshot);
  const candidate = applySystemStep(before.value.snapshot, step), db = f.store.adapter.db, originalExec = db.exec.bind(db);
  db.exec = statement => { if (statement === 'COMMIT') throw new Error('probe commit failure'); return originalExec(statement); };
  try { await assert.rejects(commitCandidate(f.store, 'retry', before, candidate), /probe commit failure/); }
  finally { db.exec = originalExec; }
  const unchanged = await f.store.read('rooms', 'retry');
  assert.equal(unchanged.version, before.version); assert.deepEqual(unchanged.value, before.value);
  const retry = applySystemStep(unchanged.value.snapshot, nextSystemStep(unchanged.value.snapshot));
  assert.deepEqual(retry, candidate);
  assert.equal(await commitCandidate(f.store, 'retry', unchanged, retry), true);
  assert.equal((await f.store.read('rooms', 'retry')).value.snapshot.game.paid, 1);
});

test('lost acknowledgement after COMMIT is recovered by reading the original persistent step; it never repeats payment', async t => {
  const f = fixture(t); await commitCandidate(f.store, 'unknown', null, readySyntheticMatch());
  const before = await f.store.read('rooms', 'unknown'), step = nextSystemStep(before.value.snapshot);
  const candidate = applySystemStep(before.value.snapshot, step), db = f.store.adapter.db, originalExec = db.exec.bind(db);
  db.exec = statement => { const result = originalExec(statement); if (statement === 'COMMIT') throw new Error('probe response lost'); return result; };
  try { await assert.rejects(commitCandidate(f.store, 'unknown', before, candidate), /probe response lost/); }
  finally { db.exec = originalExec; }
  const recovered = await f.store.read('rooms', 'unknown');
  assert.equal(recovered.value.snapshot.game.lastSystemStep.id, step.id);
  assert.equal(recovered.value.snapshot.game.paid, 1); assert.equal(recovered.value.snapshot.game.random.cursor, 1);
  assert.equal(await commitCandidate(f.store, 'unknown', before, candidate), false);
  assert.equal((await driveSyntheticSteps(f.store, 'unknown')).committed, 0);
});

test('a driver yields after 16 committed steps and a separate Node process resumes the saved cursor without a human clock', async t => {
  const f = fixture(t); await commitCandidate(f.store, 'resume', null, readySyntheticMatch('solo', 1, { steps: 20 }));
  assert.deepEqual(await driveSyntheticSteps(f.store, 'resume'), { committed: 16, needsWake: true });
  f.reopen();
  const result = JSON.parse(execFileSync(process.execPath, [probeFile, '--resume-fixture'], {
    input: JSON.stringify({ path: f.path, key: f.key.toString('base64url'), roomId: 'resume' }), encoding: 'utf8',
  }));
  assert.deepEqual(result, { newNodeProcess: true, beforeCursor: 16, afterCursor: 20, paid: 20, randomCursor: 20,
    committed: 4, needsWake: false });
  const saved = (await f.store.read('rooms', 'resume')).value.snapshot;
  assert.equal(responsibilityClock(saved), null); assert.equal(saved.game.resources, 80);
});

test('paused, terminal and human decision states stop automatic steps immediately', async t => {
  const f = fixture(t);
  for (const phase of ['paused', 'aborted', 'finished']) {
    const state = readySyntheticMatch(); state.phase = phase;
    await commitCandidate(f.store, phase, null, state);
    assert.deepEqual(await driveSyntheticSteps(f.store, phase), { committed: 0, needsWake: false });
  }
  const state = openDecision(readySyntheticMatch('solo', 1, { steps: 0 }), 'human-1', 1000);
  state.game.remainingSystemSteps = 1;
  await commitCandidate(f.store, 'decision', null, state);
  assert.deepEqual(await driveSyntheticSteps(f.store, 'decision'), { committed: 0, needsWake: false });
});

test('leave wins a CAS race and stale Teddy work cannot revive the aborted match or consume resources', async t => {
  const f = fixture(t); await commitCandidate(f.store, 'leave', null, readySyntheticMatch());
  const before = await f.store.read('rooms', 'leave');
  const systemCandidate = applySystemStep(before.value.snapshot, nextSystemStep(before.value.snapshot));
  const leave = structuredClone(before.value.snapshot); leave.phase = 'aborted'; leave.players = [];
  assert.equal(await commitCandidate(f.store, 'leave', before, leave), true);
  assert.equal(await commitCandidate(f.store, 'leave', before, systemCandidate), false);
  const saved = (await f.store.read('rooms', 'leave')).value.snapshot;
  assert.equal(saved.phase, 'aborted'); assert.equal(saved.game.paid, 0); assert.equal(saved.game.random.cursor, 0);
  assert.deepEqual(await driveSyntheticSteps(f.store, 'leave'), { committed: 0, needsWake: false });
});

test('season responsibility differs from current player; only that human can resume a timeout, with the same window and 30 minutes', () => {
  const state = openDecision(readySyntheticMatch('standard', 2, { steps: 0 }), 'human-2', 1000);
  assert.equal(state.game.currentPlayer, 'human-1'); assert.equal(responsibilityClock(state).responsibleSeatId, 'human-2');
  assert.throws(() => prepareSyntheticPayment(state, 'human-1', state.decisionWindow.id, 1001), hasCode('DECISION_FORBIDDEN'));
  assert.throws(() => pauseDecision(state, 1001, 'timeout'), hasCode('PAUSE_NOT_ALLOWED'));
  const paused = pauseDecision(state, state.decisionWindow.deadlineAt, 'timeout');
  assert.equal(paused.decisionWindow.remainingMs, 0); assert.equal(paused.decisionWindow.deadlineAt, null);
  assert.throws(() => resumeDecision(paused, 'human-1', 4000000), hasCode('RESUME_FORBIDDEN'));
  assert.throws(() => resumeDecision(paused, 'teddy', 4000000), hasCode('RESUME_FORBIDDEN'));
  const resumed = resumeDecision(paused, 'human-2', 4000000);
  assert.equal(resumed.decisionWindow.id, state.decisionWindow.id);
  assert.equal(resumed.decisionWindow.remainingMs, DECISION_MS); assert.equal(resumed.decisionWindow.deadlineAt, 4000000 + DECISION_MS);
});

test('normal pause requires every human vote and resumes the saved remaining time after persistence', async t => {
  let time = 1000; const f = fixture(t, () => time);
  const state = openDecision(readySyntheticMatch('standard', 2, { steps: 0 }), 'human-2', time);
  assert.throws(() => pauseDecision(state, time + 1, 'normal', ['human-1']), hasCode('PAUSE_NOT_ALLOWED'));
  const paused = pauseDecision(state, time + 12345, 'normal', ['human-1', 'human-2']);
  await commitCandidate(f.store, 'normal', null, paused); f.reopen(); time = 5000000;
  const restored = (await f.store.read('rooms', 'normal')).value.snapshot;
  const resumed = resumeDecision(restored, 'human-1', time);
  assert.equal(resumed.decisionWindow.remainingMs, DECISION_MS - 12345);
  assert.equal(resumed.decisionWindow.deadlineAt, time + DECISION_MS - 12345);
});

test('payment prepared before timeout cannot commit at the deadline; timeout then persists with no payment', async t => {
  let time = 1000; const f = fixture(t, () => time);
  const state = openDecision(readySyntheticMatch('standard', 2, { steps: 0 }), 'human-2', time);
  await commitCandidate(f.store, 'deadline', null, state);
  const before = await f.store.read('rooms', 'deadline'), window = state.decisionWindow;
  const payment = prepareSyntheticPayment(state, 'human-2', window.id, time);
  time = window.deadlineAt;
  assert.equal(await commitCandidate(f.store, 'deadline', before, payment, { validUntil: window.deadlineAt }), false);
  assert.equal((await f.store.read('rooms', 'deadline')).version, before.version);
  assert.equal(await commitCandidate(f.store, 'deadline', before, pauseDecision(state, time, 'timeout')), true);
  const saved = (await f.store.read('rooms', 'deadline')).value.snapshot;
  assert.equal(saved.phase, 'paused'); assert.equal(saved.game.paid, 0); assert.equal(saved.game.resources, 100);
});

test('non-economic candidate guard rejects oversized creates and updates while preserving revision, resources and receipts', async t => {
  const f = fixture(t), state = readySyntheticMatch();
  await assert.rejects(commitCandidate(f.store, 'too-large-create', null, { ...state, padding: 'x'.repeat(CANDIDATE_SNAPSHOT_BYTES) }), hasCode('ROOM_STATE_LIMIT'));
  assert.equal(await f.store.read('rooms', 'too-large-create'), null);
  await commitCandidate(f.store, 'size', null, state);
  const before = await f.store.read('rooms', 'size'), candidate = applySystemStep(before.value.snapshot, nextSystemStep(before.value.snapshot));
  candidate.padding = 'x'.repeat(CANDIDATE_SNAPSHOT_BYTES);
  await assert.rejects(commitCandidate(f.store, 'size', before, candidate), hasCode('ROOM_STATE_LIMIT'));
  const after = await f.store.read('rooms', 'size');
  assert.equal(after.version, before.version); assert.deepEqual(after.value, before.value);
  assert.deepEqual(await f.store.scan('score-accounts'), []);
  const leave = structuredClone(after.value.snapshot); leave.phase = 'aborted'; leave.players = [];
  assert.equal(await commitCandidate(f.store, 'size', after, leave), true);
});

test('probe evidence rechecks the actual non-economic size guard and preserves the previous durable record', async () => {
  const evidence = await runProbe();
  assert.equal(evidence.scope.actualRoomAdapterRegistered, false);
  assert.equal(evidence.observations.actualNonEconomicCommitterAcceptedOversize, false);
  assert.equal(evidence.observations.actualNonEconomicCommitterOversizeError, 'ROOM_STATE_LIMIT');
  assert.equal(evidence.observations.actualNonEconomicCommitterPreserved, true);
  assert.equal(evidence.observations.oversizePreservedVersion, true);
  assert.equal(evidence.observations.staleDuplicateCommit, false);
  assert.equal(evidence.observations.finalPaid, 20); assert.equal(evidence.observations.finalRandomCursor, 20);
});
