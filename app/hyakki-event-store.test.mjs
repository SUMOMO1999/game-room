import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryAdapter, SQLiteAdapter, EncryptedStore, recordKey, decryptStoredRecord } from '../server/storage.mjs';
import { createRoomScoreCommitter } from '../server/room-score-commit.mjs';
import { createHyakkiEventStore, HYAKKI_EVENT_SCOPES as scopes, HYAKKI_EVENT_FOREVER as forever,
  HYAKKI_EVENT_FINISH_RESERVE_BYTES, HYAKKI_EVENT_RETENTION_MS, HYAKKI_EVENT_PAGE_MAX_BYTES,
  validateHyakkiEventState, validateHyakkiPublicEvent } from '../server/games/hyakki-trading/event-store.mjs';
import { CONTENT_VERSION, DIGITAL_RULE_VERSION } from './games/hyakki-trading/content/definitions.mjs';

const key = Buffer.alloc(32, 52), stamp = 1800000000000, hex = (n, size = 32) => n.toString(16).padStart(size, '0');
const match = (n = 10) => ({ roomId: hex(n), matchId: hex(n + 100), startedAt: stamp,
  ruleVersion: DIGITAL_RULE_VERSION, contentVersion: CONTENT_VERSION,
  participants: [1, 2].map(id => ({ seatId: hex(id), userKey: hex(id, 64) })) });
const append = (descriptor, sequence = 1, mode = 'normal', events = sequence === 1 ? [{ type: 'match-started' }]
  : [{ type: 'turn-ended', actorSeatId: descriptor.participants[0].seatId }]) => ({ match: descriptor, sequence,
  commitId: `commit-${sequence}`, committedAt: stamp + sequence, mode, events });
function fixture(t, backend = 'sqlite', capacityBytes) {
  let time = stamp + 10000;
  const now = () => time, directory = backend === 'sqlite' ? mkdtempSync(join(tmpdir(), 'hyakki-events-')) : null;
  const path = directory && join(directory, 'game.sqlite');
  const storage = new EncryptedStore(backend === 'sqlite' ? new SQLiteAdapter(path, { now }) : new MemoryAdapter({ now }), key, now);
  const events = createHyakkiEventStore({ storage, now, ...(capacityBytes === undefined ? {} : { capacityBytes }) });
  t.after(() => { storage.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  return { storage, events, path, now, advance: ms => { time += ms; } };
}
async function rows(storage) {
  return (await Promise.all(Object.values(scopes).map(async scope => (await storage.adapter.entries(scope)).map(row => ({
    scope, key: row.key, value: decryptStoredRecord(storage.key, row.key, row), expiresAt: row.expiresAt, payloadBytes: Buffer.byteLength(row.payload),
  }))))).flat();
}
const apply = (storage, prepared, extra = [], guards = []) => storage.compareAndSwapMany({ changes: [...prepared.changes, ...extra], guards: [...prepared.guards, ...guards] });
const roomChange = (descriptor, expectedVersion, value) => ({ scope: 'rooms', id: descriptor.roomId, expectedVersion, value, expiresAt: forever });
const code = expected => error => error.code === expected;
const room = (descriptor, sequence) => ({ gameType: 'hyakki-trading', roomId: descriptor.roomId, matchId: descriptor.matchId,
  matchStartedAt: descriptor.startedAt, matchParticipants: descriptor.participants.map(person => ({ playerId: person.seatId, userKey: person.userKey })),
  game: { ruleVersion: descriptor.ruleVersion, contentVersion: descriptor.contentVersion, publicEventSequence: sequence,
    lifecycle: { capacity: false } }, phase: 'playing' });

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: room, public event, head and encrypted quota share one guarded commit`, async t => {
    const f = fixture(t, backend), descriptor = match();
    const prepared = await f.events.prepareAppend(append(descriptor));
    assert.equal(prepared.changes.length, 3); assert.deepEqual(await rows(f.storage), []);
    await f.storage.put('sessions', 'authorization', { member: true });
    const auth = await f.storage.read('sessions', 'authorization');
    await f.storage.put('sessions', 'authorization', { member: false });
    assert.equal(await apply(f.storage, prepared, [roomChange(descriptor, null, { snapshot: room(descriptor, 1), receipt: 'start' })],
      [{ scope: 'sessions', id: 'authorization', expectedVersion: auth.version }]), false);
    assert.equal(await f.storage.get('rooms', descriptor.roomId), null); assert.deepEqual(await rows(f.storage), []);
    assert.equal(await apply(f.storage, prepared, [roomChange(descriptor, null, { snapshot: room(descriptor, 1), receipt: 'start' })]), true);
    const state = validateHyakkiEventState(await rows(f.storage), { rooms: [room(descriptor, 1)], now: f.now() });
    assert.equal(state.heads.length, 1); assert.equal(state.reservedBytes, HYAKKI_EVENT_FINISH_RESERVE_BYTES);
    assert.equal(state.usedBytes, (await rows(f.storage)).reduce((sum, row) => sum + row.payloadBytes, 0));
  });

  test(`${backend}: simultaneous writes have one winner; exact replay never appends or charges again`, async t => {
    const f = fixture(t, backend), descriptor = match();
    await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
    const input = append(descriptor, 2), other = { ...input, commitId: 'racing-device' };
    const [a, b] = await Promise.all([f.events.prepareAppend(input), f.events.prepareAppend(other)]);
    assert.deepEqual(await Promise.all([apply(f.storage, a), apply(f.storage, b)]), [true, false]);
    const before = await rows(f.storage), retry = await f.events.prepareAppend(input);
    assert.deepEqual(retry.changes, []); assert.equal(await f.storage.verifyGuards({ guards: retry.guards }), true);
    assert.deepEqual(await rows(f.storage), before);
    await assert.rejects(f.events.prepareAppend(other), code('GAME_HISTORY_CONFLICT'));
  });

  test(`${backend}: quota exhaustion rejects the economic operation but permits one suspension and terminal release`, async t => {
    const f = fixture(t, backend, HYAKKI_EVENT_FINISH_RESERVE_BYTES + 7000), descriptor = match();
    await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
    let sequence = 2;
    for (; sequence < 40; sequence++) {
      try { await apply(f.storage, await f.events.prepareAppend(append(descriptor, sequence))); }
      catch (error) { assert.equal(error.code, 'GAME_HISTORY_CAPACITY'); break; }
    }
    assert(sequence < 40);
    const before = validateHyakkiEventState(await rows(f.storage));
    assert.equal(before.heads[0].sequence, sequence - 1);
    const capacity = append(descriptor, sequence, 'capacity', [{ type: 'suspended', reason: 'capacity' }]);
    await apply(f.storage, await f.events.prepareAppend(capacity));
    const suspended = validateHyakkiEventState(await rows(f.storage));
    assert.equal(suspended.heads[0].phase, 'capacity-suspended'); assert(suspended.reservedBytes < before.reservedBytes);
    await assert.rejects(f.events.prepareAppend(append(descriptor, sequence + 1)), code('GAME_HISTORY_CAPACITY'));
    await assert.rejects(f.events.prepareAppend({ ...capacity, sequence: sequence + 1, commitId: 'second-suspend' }), code('GAME_HISTORY_INVALID'));
    await assert.rejects(f.events.prepareAppend(append(descriptor, sequence + 1, 'resume', [{ type: 'resumed' }])), code('GAME_HISTORY_CAPACITY'));
    const terminal = append(descriptor, sequence + 1, 'terminal', [{ type: 'pending-closed', reason: 'cancelled' }, { type: 'match-ended', reason: 'cancelled', winnerSeatId: null }]);
    await apply(f.storage, await f.events.prepareAppend(terminal));
    const ended = validateHyakkiEventState(await rows(f.storage));
    assert.equal(ended.reservedBytes, 0); assert.equal(ended.heads[0].phase, 'terminal');
    assert.equal(ended.heads[0].retainUntil, terminal.committedAt + HYAKKI_EVENT_RETENTION_MS);
    assert.deepEqual((await f.events.prepareAppend(terminal)).changes, []);
  });
}

test('SQLite trigger failure rolls back room, receipt, event and both meta rows', async t => {
  const f = fixture(t), descriptor = match();
  const prepared = await f.events.prepareAppend(append(descriptor));
  f.storage.adapter.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON game_records WHEN NEW.key LIKE 'hyakki-events:%' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  await assert.rejects(apply(f.storage, prepared, [roomChange(descriptor, null, { snapshot: room(descriptor, 1), receipt: 'start' })]), /synthetic disk failure/);
  assert.deepEqual(await rows(f.storage), []); assert.equal(await f.storage.get('rooms', descriptor.roomId), null);
  f.storage.adapter.db.exec('DROP TRIGGER fail_event');
  assert.equal(await apply(f.storage, prepared, [roomChange(descriptor, null, { snapshot: room(descriptor, 1), receipt: 'start' })]), true);
});

test('independent SQLite stores contend on one global quota without losing either match', async t => {
  const f = fixture(t), peer = new EncryptedStore(new SQLiteAdapter(f.path, { now: f.now }), key, f.now);
  t.after(() => peer.close());
  const service = createHyakkiEventStore({ storage: peer, now: f.now });
  const first = await f.events.prepareAppend(append(match(10))), second = await service.prepareAppend(append(match(20)));
  assert.equal(await apply(f.storage, first), true); assert.equal(await apply(peer, second), false);
  assert.equal(await apply(peer, await service.prepareAppend(append(match(20)))), true);
  assert.equal(validateHyakkiEventState(await rows(f.storage)).heads.length, 2);
});

test('concurrent starts cannot promise the same cleanup reserve; terminal release makes it reusable', async t => {
  const f = fixture(t, 'sqlite', HYAKKI_EVENT_FINISH_RESERVE_BYTES + 5000);
  const first = await f.events.prepareAppend(append(match(10))), second = await f.events.prepareAppend(append(match(20)));
  assert.equal(await apply(f.storage, first), true); assert.equal(await apply(f.storage, second), false);
  await assert.rejects(f.events.prepareAppend(append(match(20))), code('GAME_HISTORY_CAPACITY'));
  await apply(f.storage, await f.events.prepareAppend(append(match(10), 2, 'terminal', [{ type: 'match-ended', reason: 'cancelled', winnerSeatId: null }])));
  assert.equal(await apply(f.storage, await f.events.prepareAppend(append(match(20)))), true);
  const state = validateHyakkiEventState(await rows(f.storage));
  assert.equal(state.heads.length, 2); assert.equal(state.reservedBytes, HYAKKI_EVENT_FINISH_RESERVE_BYTES);
});

test('paging uses bounded exact keys, strips private match identity and never scans a scope', async t => {
  const f = fixture(t), descriptor = match();
  await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
  for (let sequence = 2; sequence <= 53; sequence++) await apply(f.storage, await f.events.prepareAppend(append(descriptor, sequence)));
  f.storage.scan = () => { throw new Error('Paging must not scan'); };
  let reads = 0; const get = f.storage.adapter.get.bind(f.storage.adapter); f.storage.adapter.get = async key => { reads++; return get(key); };
  const first = await f.events.readPage({ matchId: descriptor.matchId, limit: 50 });
  assert.equal(first.page.groups.length, 50); assert.equal(first.page.hasMore, true); assert.equal(first.guards.length, 51); assert.equal(reads, 51);
  assert(Buffer.byteLength(JSON.stringify(first.page)) < HYAKKI_EVENT_PAGE_MAX_BYTES);
  assert(!JSON.stringify(first.page).includes('userKey')); assert(!JSON.stringify(first.page).includes('commitId'));
  const second = await f.events.readPage({ matchId: descriptor.matchId, after: first.page.nextAfter });
  assert.deepEqual(second.page.groups.map(group => group.sequence), [51, 52, 53]); assert.equal(second.page.hasMore, false);
});

test('terminal collection is bounded, atomic, retryable, and releases measured quota', async t => {
  const f = fixture(t), descriptor = match();
  await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
  for (let sequence = 2; sequence <= 4; sequence++) await apply(f.storage, await f.events.prepareAppend(append(descriptor, sequence)));
  await assert.rejects(f.events.preparePrune({ matchId: descriptor.matchId }), code('GAME_HISTORY_RETAINED'));
  await apply(f.storage, await f.events.prepareAppend(append(descriptor, 5, 'terminal', [{ type: 'match-ended', reason: 'normal-close', winnerSeatId: hex(1) }])));
  f.advance(HYAKKI_EVENT_RETENTION_MS);
  const first = await f.events.preparePrune({ matchId: descriptor.matchId, limit: 2 });
  assert.equal(first.changes.length, 4); await apply(f.storage, first);
  assert.equal(validateHyakkiEventState(await rows(f.storage)).heads[0].prunedThrough, 2);
  assert.equal(await apply(f.storage, first), false);
  while (validateHyakkiEventState(await rows(f.storage)).heads.length) await apply(f.storage, await f.events.preparePrune({ matchId: descriptor.matchId, limit: 2 }));
  const state = validateHyakkiEventState(await rows(f.storage)); assert.equal(state.groups.length, 0); assert.equal(state.reservedBytes, 0);
  assert.equal(state.usedBytes, (await rows(f.storage))[0].payloadBytes);
  assert.deepEqual((await f.events.preparePrune({ matchId: descriptor.matchId })).changes, []);
});

test('scheduled sweep prunes at most four expired matches in bounded commits and preserves active history', async t => {
  const f = fixture(t), active = match(99);
  await apply(f.storage, await f.events.prepareAppend(append(active)));
  for (let index = 0; index < 6; index++) {
    const descriptor = match(index + 20);
    await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
    await apply(f.storage, await f.events.prepareAppend(append(descriptor, 2, 'terminal',
      [{ type: 'match-ended', reason: 'normal-close', winnerSeatId: hex(1) }])));
  }
  assert.deepEqual(await f.events.sweep(), { matches: 0, groups: 0 });
  f.advance(HYAKKI_EVENT_RETENTION_MS);
  assert.deepEqual(await f.events.sweep(), { matches: 4, groups: 8 });
  assert.equal(validateHyakkiEventState(await rows(f.storage)).heads.length, 3);
  assert.deepEqual(await f.events.sweep(), { matches: 2, groups: 4 });
  const remaining = validateHyakkiEventState(await rows(f.storage));
  assert.equal(remaining.heads.length, 1); assert.equal(remaining.heads[0].match.matchId, active.matchId);
  assert.equal((await f.events.readPage({ matchId: active.matchId })).page.groups.length, 1);
});

test('public event validator rejects secret fields, private faces and foreign participants', async t => {
  for (const value of [{ type: 'draw-peeked', actorSeatId: hex(1), cardId: 'yousei.g01' },
    { type: 'draw-kept', actorSeatId: hex(1), hand: [] }, { type: 'tool-installed', actorSeatId: hex(1), cardId: 'yousei.t04#01' },
    { type: 'toString' },
    { type: 'character-played', actorSeatId: hex(1), arbitraryPayload: {} }]) assert.throws(() => validateHyakkiPublicEvent(value), code('GAME_HISTORY_INVALID'));
  const f = fixture(t), descriptor = match(); await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
  await assert.rejects(f.events.prepareAppend(append(descriptor, 2, 'normal', [{ type: 'turn-ended', actorSeatId: hex(99) }])), code('GAME_HISTORY_INVALID'));
});

test('legacy non-score commit paths enforce the same size limit with zero, one or multiple authorization guards', async t => {
  const f = fixture(t), descriptor = match();
  await f.storage.put('sessions', 'one', { active: true }); await f.storage.put('sessions', 'two', { active: true });
  const guards = await Promise.all(['one', 'two'].map(async id => ({ scope: 'sessions', id, expectedVersion: (await f.storage.read('sessions', id)).version })));
  for (const [index, options] of [{}, { guards: guards.slice(0, 1) }, { guards }, { validUntil: f.now() + 100 }].entries()) {
    const id = hex(70 + index), initial = { snapshot: { gameType: index % 2 ? 'no-hand-decision-probe' : 'legacy-unscored', marker: 'old' } };
    await f.storage.put('rooms', id, initial); const previous = await f.storage.read('rooms', id);
    const commit = createRoomScoreCommitter({ storage: f.storage, gameRegistry: { gameAdapter: () => ({ maxSnapshotBytes: 1024 }) } });
    await assert.rejects(commit(id, previous, { snapshot: { ...initial.snapshot, huge: 'x'.repeat(1024) } }, options), code('ROOM_STATE_LIMIT'));
    assert.deepEqual((await f.storage.read('rooms', id)).value, initial);
    assert.equal(await commit(id, previous, { snapshot: { ...initial.snapshot, marker: 'new' } }, options), true);
  }
  assert.deepEqual(await rows(f.storage), []);
});

test('event count and encrypted budget reject oversized groups before any state is committed', async t => {
  const f = fixture(t), descriptor = match(); await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
  const before = await rows(f.storage);
  await assert.rejects(f.events.prepareAppend(append(descriptor, 2, 'normal', Array.from({ length: 65 }, () => ({ type: 'draw-kept', actorSeatId: hex(1) })))), code('GAME_HISTORY_INVALID'));
  const huge = Array.from({ length: 64 }, () => ({ type: 'auction-revealed', actorSeatId: hex(1), cardIds: Array(110).fill('yousei.g19') }));
  await assert.rejects(f.events.prepareAppend(append(descriptor, 2, 'normal', huge)), code('GAME_HISTORY_INVALID'));
  assert.deepEqual(await rows(f.storage), before);
});

test('backup references reject missing room, changed sequence and missing event group', async t => {
  const f = fixture(t), descriptor = match(); await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
  const saved = await rows(f.storage);
  assert.throws(() => validateHyakkiEventState(saved, { rooms: [], now: f.now() }), code('GAME_HISTORY_REFERENCE'));
  assert.throws(() => validateHyakkiEventState(saved, { rooms: [room(descriptor, 2)], now: f.now() }), code('GAME_HISTORY_REFERENCE'));
  const without = saved.filter(row => row.scope !== scopes.events);
  assert.throws(() => validateHyakkiEventState(without), code('GAME_HISTORY_CORRUPT'));
});

test('room references must agree with active or capacity-suspended event head', async t => {
  const f = fixture(t), descriptor = match(); await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
  const activeRows = await rows(f.storage), activeRoom = room(descriptor, 1);
  validateHyakkiEventState(activeRows, { rooms: [activeRoom], now: f.now() });
  validateHyakkiEventState(activeRows, { rooms: [{ ...activeRoom, phase: 'paused' }], now: f.now() });
  assert.throws(() => validateHyakkiEventState(activeRows, { rooms: [{ ...activeRoom, phase: 'finished' }], now: f.now() }), code('GAME_HISTORY_REFERENCE'));
  const falseCapacity = structuredClone(activeRoom); falseCapacity.game.lifecycle.capacity = true;
  assert.throws(() => validateHyakkiEventState(activeRows, { rooms: [falseCapacity], now: f.now() }), code('GAME_HISTORY_REFERENCE'));

  await apply(f.storage, await f.events.prepareAppend(append(descriptor, 2, 'capacity', [{ type: 'suspended', reason: 'capacity' }])));
  const suspendedRows = await rows(f.storage), suspendedRoom = room(descriptor, 2);
  suspendedRoom.phase = 'paused'; suspendedRoom.game.lifecycle.capacity = true;
  validateHyakkiEventState(suspendedRows, { rooms: [suspendedRoom], now: f.now() });
  assert.throws(() => validateHyakkiEventState(suspendedRows, { rooms: [{ ...suspendedRoom, phase: 'playing' }], now: f.now() }), code('GAME_HISTORY_REFERENCE'));
  suspendedRoom.game.lifecycle.capacity = false;
  assert.throws(() => validateHyakkiEventState(suspendedRows, { rooms: [suspendedRoom], now: f.now() }), code('GAME_HISTORY_REFERENCE'));
});

test('terminal room references retain the exact committed end time even without a summary', async t => {
  const f = fixture(t), descriptor = match(); await apply(f.storage, await f.events.prepareAppend(append(descriptor)));
  const terminal = append(descriptor, 2, 'terminal', [{ type: 'match-ended', reason: 'cancelled', winnerSeatId: null }]);
  await apply(f.storage, await f.events.prepareAppend(terminal));
  const saved = await rows(f.storage), terminalRoom = { ...room(descriptor, 2), phase: 'aborted', matchEndedAt: terminal.committedAt };
  validateHyakkiEventState(saved, { rooms: [terminalRoom], now: f.now() });
  validateHyakkiEventState(saved, { rooms: [{ ...terminalRoom, phase: 'finished' }], now: f.now() });
  for (const invalid of [{ ...terminalRoom, phase: 'paused' }, { ...terminalRoom, matchEndedAt: terminal.committedAt + 1 },
    { ...terminalRoom, matchEndedAt: undefined }]) {
    assert.throws(() => validateHyakkiEventState(saved, { rooms: [invalid], now: f.now() }), code('GAME_HISTORY_REFERENCE'));
  }
});

test('real committer integrates a trusted projector, protects non-score sizes and rejects caller write injection', async t => {
  const f = fixture(t), descriptor = match(), initial = { snapshot: { gameType: 'hyakki-trading', phase: 'waiting' } };
  await f.storage.put('rooms', descriptor.roomId, initial);
  const previous = await f.storage.read('rooms', descriptor.roomId), next = { snapshot: room(descriptor, 1), receipt: 'start' };
  const transitionPreparers = new Map([['hyakki-trading', f.events.transitionPreparer(context => {
    assert.equal(context.roomId, descriptor.roomId); assert.equal(context.previous.snapshot.phase, 'waiting');
    context.next.snapshot.untrustedMutation = true;
    return append(descriptor);
  })]]);
  const gameRegistry = { gameAdapter: () => ({ maxSnapshotBytes: 1024 }) };
  const commit = createRoomScoreCommitter({ storage: f.storage, gameRegistry, transitionPreparers });
  await assert.rejects(commit(descriptor.roomId, previous, { snapshot: { ...next.snapshot, huge: 'x'.repeat(2000) } }), code('ROOM_STATE_LIMIT'));
  await assert.rejects(commit(descriptor.roomId, previous, next, { changes: [] }), /Unexpected room commit/);
  assert.equal(await commit(descriptor.roomId, previous, next), true);
  assert.equal((await f.storage.get('rooms', descriptor.roomId)).snapshot.untrustedMutation, undefined);
  validateHyakkiEventState(await rows(f.storage), { rooms: [next.snapshot], now: f.now() });
});

test('preparer scope escapes and duplicate identities cannot write any room or event data', async t => {
  const f = fixture(t), descriptor = match(); await f.storage.put('rooms', descriptor.roomId, { snapshot: { gameType: 'hyakki-trading' } });
  const previous = await f.storage.read('rooms', descriptor.roomId), next = structuredClone(previous.value);
  for (const kind of ['escape', 'duplicate']) {
    const event = { scope: scopes.events, id: 'same', expectedVersion: null, value: {}, expiresAt: forever };
    const prepared = { changes: kind === 'escape' ? [{ ...event, scope: 'sessions' }] : [event, event], guards: [] };
    const commit = createRoomScoreCommitter({ storage: f.storage, gameRegistry: { gameAdapter: () => ({}) },
      transitionPreparers: new Map([['hyakki-trading', { scopes: [scopes.events], prepare: async () => prepared }]]) });
    await assert.rejects(commit(descriptor.roomId, previous, next), /scope|Duplicate/);
    assert.deepEqual((await f.storage.read('rooms', descriptor.roomId)).value, previous.value); assert.deepEqual(await rows(f.storage), []);
  }
});
