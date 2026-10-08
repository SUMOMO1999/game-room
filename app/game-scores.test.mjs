import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryAdapter, SQLiteAdapter, EncryptedStore, recordKey, decryptStoredRecord } from '../server/storage.mjs';
import { createGameScores, ScoreError, SCORE_SCOPES, SCORE_FOREVER, validateScoreRecord, scoreRecordId, validateScoreState } from '../server/game-scores.mjs';

const key = Buffer.alloc(32, 41), stamp = 1800000000000;
const hex = (value, length = 32) => value.toString(16).padStart(length, '0');
const participants = Array.from({ length: 3 }, (_, index) => ({ userKey: hex(index + 1, 64), seatId: hex(index + 11) }));
const descriptor = (id = 101, players = participants) => ({ matchId: hex(id), roomId: hex(id + 100), game: 'poker414-2',
  ruleVersion: 'poker414-2-v2', scoringVersion: 'poker414-2-score-v1', startedAt: stamp, participants: structuredClone(players) });
function terminal(reservation, points = [10, -4, -6], status = 'completed') {
  const { startedAt: ignored, ...value } = reservation;
  return { ...value, settlementVersion: 0, endedAt: stamp + 10, status, reason: status === 'cancelled' ? 'server-recovery' : status === 'aborted' ? 'voluntary-leave' : 'emptied-hand',
    deltas: value.participants.map((player, index) => ({ userKey: player.userKey, delta: points[index] })) };
}
function fixture(t, type = 'memory', options = {}) {
  let clock = stamp + 100;
  const now = () => clock;
  const directory = type === 'sqlite' ? mkdtempSync(join(tmpdir(), 'scores-')) : null;
  const path = directory && join(directory, 'store.sqlite');
  const adapter = type === 'sqlite' ? new SQLiteAdapter(path, { now }) : new MemoryAdapter({ now });
  const storage = new EncryptedStore(adapter, key, now);
  const scores = createGameScores({ storage, now, ...options });
  t.after(() => { storage.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  return { storage, scores, now, setClock: value => { clock = value; }, path };
}
async function commit(storage, prepared, room = null) {
  const changes = [...prepared.changes, ...(room ? [room] : [])];
  return changes.length ? storage.compareAndSwapMany({ changes, guards: prepared.guards }) : storage.verifyGuards({ guards: prepared.guards });
}
async function rows(storage) {
  return (await Promise.all(Object.values(SCORE_SCOPES).map(async scope => (await storage.adapter.entries(scope)).map(raw => ({
    scope, value: decryptStoredRecord(storage.key, raw.key, raw), expiresAt: raw.expiresAt, payloadBytes: Buffer.byteLength(raw.payload),
  }))))).flat();
}
async function balances(scores, people = participants) { return Promise.all(people.map(async player => (await scores.readBalance(player.userKey)).total)); }
const code = expected => error => error instanceof ScoreError && error.code === expected;

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: preparation is read-only and room plus reservation commit atomically`, async t => {
    const { storage, scores } = fixture(t, backend), match = descriptor();
    const prepared = await scores.prepareReservation(match);
    assert.equal((await rows(storage)).length, 0);
    assert.equal(await commit(storage, prepared, { scope: 'rooms', id: match.roomId, expectedVersion: null,
      value: { phase: 'playing', matchId: match.matchId }, expiresAt: SCORE_FOREVER }), true);
    const state = validateScoreState(await rows(storage));
    assert.equal(state.reservations.length, 1);
    assert(state.reservedBytes > 20000);
    assert.equal((await storage.get('rooms', match.roomId)).matchId, match.matchId);
  });

  test(`${backend}: failed room guard commits neither score nor reservation`, async t => {
    const { storage, scores } = fixture(t, backend), match = descriptor();
    await storage.put('rooms', match.roomId, { phase: 'waiting' });
    const prepared = await scores.prepareReservation(match);
    assert.equal(await commit(storage, prepared, { scope: 'rooms', id: match.roomId, expectedVersion: null,
      value: { phase: 'playing' }, expiresAt: SCORE_FOREVER }), false);
    assert.equal((await rows(storage)).length, 0);
    assert.equal((await storage.get('rooms', match.roomId)).phase, 'waiting');
  });

  test(`${backend}: normal settlement, lost receipt and replay never double count`, async t => {
    const { storage, scores } = fixture(t, backend), match = descriptor(), input = terminal(match);
    assert.equal(await commit(storage, await scores.prepareReservation(match)), true);
    const prepared = await scores.prepareSettlement(input);
    assert.deepEqual(prepared.projection.balancesAfter.map(item => item.total), [10, -4, -6]);
    assert.equal(await commit(storage, prepared), true);
    assert.equal(await commit(storage, prepared), false);
    const replay = await scores.prepareSettlement(input);
    assert.equal(replay.alreadyCommitted, true); assert.equal(replay.changes.length, 0);
    assert.equal(await commit(storage, replay), true);
    assert.deepEqual(await balances(scores), [10, -4, -6]);
    const state = validateScoreState(await rows(storage));
    assert.equal(state.reservedBytes, 0); assert.equal(state.reservations.length, 0); assert.equal(state.ledgers.length, 1);
    await assert.rejects(scores.prepareSettlement(terminal(match, [11, -4, -7])), code('SCORE_SETTLEMENT_CONFLICT'));
  });

  test(`${backend}: zero cancellation and leave compensation release only their own reservation`, async t => {
    const { storage, scores } = fixture(t, backend), first = descriptor(101), second = descriptor(102);
    await commit(storage, await scores.prepareReservation(first));
    await commit(storage, await scores.prepareReservation(second));
    const before = validateScoreState(await rows(storage));
    await commit(storage, await scores.prepareSettlement(terminal(first, [0, 0, 0], 'cancelled')));
    const cancelled = validateScoreState(await rows(storage));
    assert.equal(cancelled.reservedBytes * 2, before.reservedBytes);
    assert.deepEqual(await balances(scores), [0, 0, 0]);
    await commit(storage, await scores.prepareSettlement(terminal(second, [-10, 5, 5], 'aborted')));
    assert.deepEqual(await balances(scores), [-10, 5, 5]);
    assert.equal(validateScoreState(await rows(storage)).reservedBytes, 0);
  });

  test(`${backend}: same account across rooms conflicts then re-reads both balances and quota`, async t => {
    const { storage, scores } = fixture(t, backend), first = descriptor(101), second = descriptor(102);
    await commit(storage, await scores.prepareReservation(first)); await commit(storage, await scores.prepareReservation(second));
    const [one, two] = await Promise.all([scores.prepareSettlement(terminal(first)), scores.prepareSettlement(terminal(second, [-4, 9, -5]))]);
    assert.equal(await commit(storage, one), true); assert.equal(await commit(storage, two), false);
    assert.equal(await commit(storage, await scores.prepareSettlement(terminal(second, [-4, 9, -5]))), true);
    assert.deepEqual(await balances(scores), [6, 5, -11]);
    const state = validateScoreState(await rows(storage)); assert.equal(state.ledgers.length, 2); assert.equal(state.reservedBytes, 0);
  });

  test(`${backend}: correction advances head once, preserves original and applies only difference`, async t => {
    const { storage, scores } = fixture(t, backend), match = descriptor(), original = terminal(match);
    await commit(storage, await scores.prepareReservation(match)); await commit(storage, await scores.prepareSettlement(original));
    const corrected = { ...terminal(match, [12, -3, -9]), settlementVersion: 1, expectedSettlementVersion: 0, correctionId: hex(501) };
    const rival = { ...corrected, correctionId: hex(502), deltas: terminal(match, [15, -5, -10]).deltas };
    const [one, two] = await Promise.all([scores.prepareCorrection(corrected), scores.prepareCorrection(rival)]);
    assert.deepEqual(one.projection.deltas.map(item => item.delta), [2, 1, -3]);
    assert.equal(await commit(storage, one), true); assert.equal(await commit(storage, two), false);
    await assert.rejects(scores.prepareCorrection(rival), code('SCORE_SETTLEMENT_CONFLICT'));
    assert.equal((await scores.prepareCorrection(corrected)).alreadyCommitted, true);
    assert.deepEqual(await balances(scores), [12, -3, -9]);
    const snapshot = validateScoreState(await rows(storage));
    assert.equal(snapshot.ledgers.length, 2); assert.deepEqual(snapshot.ledgers.find(item => item.settlementVersion === 0).deltas, original.deltas);
    const reused = { ...corrected, settlementVersion: 2, expectedSettlementVersion: 1 };
    await assert.rejects(scores.prepareCorrection(reused), code('SCORE_CORRECTION_REUSED'));
    const cancellation = { ...corrected, ...terminal(match, [0, 0, 0], 'cancelled'), settlementVersion: 2, expectedSettlementVersion: 1, correctionId: hex(503) };
    await commit(storage, await scores.prepareCorrection(cancellation));
    assert.deepEqual(await balances(scores), [0, 0, 0]); validateScoreState(await rows(storage));
  });

  test(`${backend}: quota matches actual encrypted payload and survives historical retention time`, async t => {
    const { storage, scores, setClock } = fixture(t, backend), match = descriptor();
    await commit(storage, await scores.prepareReservation(match)); await commit(storage, await scores.prepareSettlement(terminal(match)));
    const actualRows = await rows(storage), snapshot = validateScoreState(actualRows);
    assert.equal(snapshot.usedBytes, actualRows.reduce((sum, item) => sum + item.payloadBytes, 0));
    assert(actualRows.every(item => item.expiresAt === SCORE_FOREVER));
    setClock(stamp + 400 * 86400000); storage.adapter.purgeExpired();
    assert.deepEqual(await balances(scores), [10, -4, -6]); assert.equal((await rows(storage)).length, actualRows.length);
  });
}

test('capacity is reserved before starting; concurrent starts cannot overbook it', async t => {
  const { storage, scores } = fixture(t, 'memory', { capacityBytes: 60000 });
  const [first, second] = await Promise.all([scores.prepareReservation(descriptor(101)), scores.prepareReservation(descriptor(102))]);
  assert.equal(await commit(storage, first), true); assert.equal(await commit(storage, second), false);
  await assert.rejects(scores.prepareReservation(descriptor(102)), code('SCORE_CAPACITY'));
  await commit(storage, await scores.prepareSettlement(terminal(descriptor(101))));
  assert.equal(await commit(storage, await scores.prepareReservation(descriptor(102))), true);
  validateScoreState(await rows(storage));
});

test('an already full store rejects a first reservation without making any records', async t => {
  const { storage, scores } = fixture(t, 'memory', { capacityBytes: 1000 });
  await assert.rejects(scores.prepareReservation(descriptor()), code('SCORE_CAPACITY'));
  assert.equal((await rows(storage)).length, 0);
});

test('eight participants stay within twelve score-plus-room write keys', async t => {
  const { storage, scores } = fixture(t), people = Array.from({ length: 8 }, (_, index) => ({ userKey: hex(index + 1, 64), seatId: hex(index + 11) }));
  const match = descriptor(101, people); await commit(storage, await scores.prepareReservation(match));
  const prepared = await scores.prepareSettlement(terminal(match, [35, -5, -5, -5, -5, -5, -5, -5]));
  assert.equal(prepared.changes.length + 1, 12); await commit(storage, prepared); validateScoreState(await rows(storage));
});

test('identity binding, non-zero cancellation, unsafe numbers and unknown fields are rejected', async t => {
  const { storage, scores } = fixture(t), match = descriptor();
  await assert.rejects(scores.prepareReservation({ ...match, participants: [participants[0], participants[0], participants[2]] }), code('SCORE_INVALID'));
  await assert.rejects(scores.prepareReservation({ ...match, spectators: [] }), code('SCORE_INVALID'));
  await commit(storage, await scores.prepareReservation(match));
  await assert.rejects(scores.prepareSettlement(terminal(match, [10, -4, -6], 'cancelled')), code('SCORE_INVALID'));
  await assert.rejects(scores.prepareSettlement(terminal(match, [Number.MAX_SAFE_INTEGER + 1, -4, -6])), code('SCORE_INVALID'));
  await assert.rejects(scores.prepareSettlement({ ...terminal(match), participants: participants.toReversed(), deltas: terminal(match).deltas.toReversed() }), code('SCORE_MATCH_CONFLICT'));
  await assert.rejects(scores.prepareSettlement(terminal(descriptor(999))), code('SCORE_RESERVATION_MISSING'));
});

test('missing quota, damaged encrypted values and wrong permanent TTL fail closed', async t => {
  const { storage, scores } = fixture(t), match = descriptor();
  await commit(storage, await scores.prepareReservation(match));
  const metaKey = recordKey(SCORE_SCOPES.meta, '4a4:quota'), raw = await storage.adapter.get(metaKey);
  storage.adapter.records.delete(metaKey);
  await assert.rejects(scores.prepareReservation(descriptor(102)), code('SCORE_CORRUPT'));
  storage.adapter.records.set(metaKey, { ...raw, expiresAt: stamp + 180 * 86400000 });
  await assert.rejects(scores.prepareReservation(descriptor(102)), code('SCORE_CORRUPT'));
  storage.adapter.records.set(metaKey, { ...raw, payload: `${raw.payload.slice(0, 10)}x${raw.payload.slice(11)}` });
  await assert.rejects(scores.prepareReservation(descriptor(102)), code('SCORE_CORRUPT'));
});

test('an existing immutable receipt cannot hide a missing settlement head', async t => {
  const { storage, scores } = fixture(t), match = descriptor(), input = terminal(match);
  await commit(storage, await scores.prepareReservation(match)); await commit(storage, await scores.prepareSettlement(input));
  storage.adapter.records.delete(recordKey(SCORE_SCOPES.meta, `4a4:match:${match.matchId}`));
  await assert.rejects(scores.prepareSettlement(input), code('SCORE_CORRUPT'));
});

test('backup accounting refuses altered balance, quota, duplicate and orphan records', async t => {
  const { storage, scores } = fixture(t), match = descriptor();
  await commit(storage, await scores.prepareReservation(match)); await commit(storage, await scores.prepareSettlement(terminal(match)));
  const original = await rows(storage); validateScoreState(original);
  for (const mutate of [values => { values.find(item => item.scope === SCORE_SCOPES.balances).value.total++; },
    values => { values.find(item => item.value.kind === 'quota').value.usedBytes++; },
    values => { values.push(structuredClone(values[0])); },
    values => { values.splice(values.findIndex(item => item.value.kind === 'match'), 1); },
    values => { values.find(item => item.scope === SCORE_SCOPES.ledger).value.fingerprint = '0'.repeat(64); },
    values => { values.find(item => item.scope === SCORE_SCOPES.ledger).value.balancesAfter[0].total++; },
    values => { values.find(item => item.scope === SCORE_SCOPES.ledger).value.sequence++; },
    values => { values.find(item => item.value.kind === 'match').value.startedAt += 1000; }]) {
    const altered = structuredClone(original); mutate(altered); assert.throws(() => validateScoreState(altered), code('SCORE_CORRUPT'));
  }
  for (const row of original) { assert.equal(validateScoreRecord(row.scope, row.value), row.value); assert.equal(typeof scoreRecordId(row.scope, row.value), 'string'); }
});

test('SQLite independent connections race on the same account and a reopened file retains the ledger', async t => {
  const { storage, scores, now, path } = fixture(t, 'sqlite');
  const other = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now), peer = createGameScores({ storage: other, now });
  t.after(() => other.close());
  const first = descriptor(101), second = descriptor(102);
  await commit(storage, await scores.prepareReservation(first)); await commit(other, await peer.prepareReservation(second));
  const [one, two] = await Promise.all([scores.prepareSettlement(terminal(first)), peer.prepareSettlement(terminal(second))]);
  assert.equal(await commit(storage, one), true); assert.equal(await commit(other, two), false);
  assert.equal(await commit(other, await peer.prepareSettlement(terminal(second))), true);
  const reopened = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
  try { assert.deepEqual(await balances(createGameScores({ storage: reopened, now })), [20, -8, -12]); validateScoreState(await rows(reopened)); }
  finally { reopened.close(); }
});
