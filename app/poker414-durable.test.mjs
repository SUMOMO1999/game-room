import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createGameRegistry } from './game-registry.mjs';
import { createPoker414Adapter } from '../server/games/poker414-2/adapter.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
import { createGameScores, SCORE_SCOPES } from '../server/game-scores.mjs';
import { verifyLiveStore, validateScoreRecoveryReferences } from '../server/backup.mjs';

const users = Array.from({ length: 9 }, (_, i) => identityKey('urn:414-durable-test', String(i)));
const registry = createGameRegistry([createPoker414Adapter()]);
async function fixture(t, { memory = false, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), '414-durable-')), path = join(directory, 'game.sqlite'), key = randomBytes(32);
  let time = 10000, seq = 0; const now = () => time, opened = [];
  async function open(extra = {}) {
    const storage = new EncryptedStore(memory ? new MemoryAdapter({ now }) : new SQLiteAdapter(path, { now }), key, now);
    const rooms = createDurableRoomStore({ storage, now, gameRegistry: registry, pollIntervalMs: 0,
      serverRandomInt: max => max - 1, ...options, ...extra });
    const history = createMatchHistory({ storage, now, gameRegistry: registry });
    rooms.setHistory(history); await rooms.ready;
    const entry = { storage, rooms, history }; opened.push(entry); return entry;
  }
  t.after(async () => { for (const e of opened) { await e.rooms.close(); e.storage.close(); } await rm(directory, { recursive: true, force: true }); });
  const act = async (entry, code, user, type, extra = {}) => {
    const view = await entry.rooms.getView(code, user);
    return entry.rooms.action(code, user, { type, requestId: `action-${++seq}`, expectedRevision: view.revision,
      ...(['play', 'pass', 'hook', 'fork'].includes(type) ? { matchId: view.game.matchId, roundId: view.game.roundId,
        targetId: view.game.target?.id ?? null, ...(['hook', 'fork'].includes(type) ? { windowId: view.game.responseWindow?.id } : {}) } : {}), ...extra });
  };
  async function start(entry, count = 3, deal = true) {
    const host = await entry.rooms.createRoom(users[0], '同名', `create-${++seq}`, 'poker414-2');
    for (let i = 1; i < count; i++) await entry.rooms.joinRoom(host.roomCode, users[i], '同名', `join-${++seq}`);
    for (let i = 0; i < count; i++) await act(entry, host.roomCode, users[i], 'ready', { ready: true });
    await act(entry, host.roomCode, users[0], 'start');
    if (deal) { time += 3000; await entry.rooms.sweep(); }
    return host;
  }
  return { path, key, now, open, act, start, advance: ms => { time += ms; } };
}
const saved = async (entry, host) => (await entry.storage.read('rooms', host.view.roomId)).value.snapshot;
const ledgers = async entry => (await entry.storage.scan(SCORE_SCOPES.ledger)).map(r => r.value);
const balance = async (entry, user) => createGameScores({ storage: entry.storage }).readBalance(user);

for (const memory of [true, false]) for (const ending of ['completed', 'voluntary-leave', 'disconnected']) {
  test(`414 ${memory ? 'Memory' : 'SQLite'} shuffled seats keep frozen score ownership through response expiry and ${ending}`, async t => {
    // Zero selects an actual different seat order, unlike max-1 which never shuffles.
    const f = await fixture(t, { memory, serverRandomInt: () => 0 }), e = await f.open(), host = await f.start(e);
    const initial = await saved(e, host), stops = [];
    assert.notDeepEqual(initial.game.players.map(player => player.id), initial.matchParticipants.map(player => player.playerId));
    for (const user of users.slice(0, 3)) stops.push(await e.rooms.subscribe(host.roomCode, user, () => {}));
    const leader = initial.matchParticipants.find(player => player.playerId === initial.game.turnPlayerId);
    const firstCard = initial.game.players.find(player => player.id === leader.playerId).hand[0];
    await f.act(e, host.roomCode, leader.userKey, 'play', { cardIds: [firstCard] });
    assert.equal((await saved(e, host)).turnClock.kind, 'response');
    f.advance(5000); await e.rooms.sweep();
    const expired = await saved(e, host);
    assert.equal(expired.turnClock, null); assert.equal(expired.clockAdvance.kind, 'response');
    if (ending === 'completed') {
      for (let actions = 0; actions < 324 && (await saved(e, host)).phase === 'playing'; actions++) {
        const snapshot = await saved(e, host), actor = snapshot.matchParticipants.find(player => player.playerId === snapshot.game.turnPlayerId);
        if (snapshot.game.target) await f.act(e, host.roomCode, actor.userKey, 'pass');
        else await f.act(e, host.roomCode, actor.userKey, 'play', { cardIds: [snapshot.game.players.find(player => player.id === actor.playerId).hand[0]] });
      }
      assert.equal((await saved(e, host)).phase, 'finished');
    } else if (ending === 'voluntary-leave') {
      const view = await e.rooms.getView(host.roomCode, users[0]);
      const input = { type: 'leave', requestId: 'shuffled-leave', expectedRevision: view.revision };
      assert.equal((await e.rooms.action(host.roomCode, users[0], input)).left, true);
      assert.equal((await e.rooms.action(host.roomCode, users[0], input)).left, true);
    } else {
      await stops[0](); f.advance(120000); await e.rooms.sweep();
      const cancelled = await saved(e, host);
      assert.equal(cancelled.phase, 'waiting'); assert.equal(cancelled.lastMatchResult.reason, 'disconnected');
    }
    const ledger = await ledgers(e); assert.equal(ledger.length, 1);
    assert.deepEqual(ledger[0].participants.map(player => player.userKey), users.slice(0, 3));
    assert.deepEqual(ledger[0].deltas.map(delta => delta.userKey), users.slice(0, 3));
    assert.equal(ledger[0].deltas.reduce((sum, delta) => sum + delta.delta, 0), 0);
    if (ending === 'voluntary-leave') assert.deepEqual(ledger[0].deltas.map(delta => delta.delta), [-10, 5, 5]);
    else if (ending === 'disconnected') assert.ok(ledger[0].deltas.every(delta => delta.delta === 0));
    else {
      const result = (await saved(e, host)).game.result;
      assert.deepEqual(ledger[0].deltas.map(delta => delta.delta), initial.matchParticipants.map(player =>
        result.deltas.find(delta => delta.playerId === player.playerId).points));
    }
    for (const user of users.slice(0, 3)) {
      const expected = ledger[0].deltas.find(delta => delta.userKey === user).delta;
      assert.equal((await balance(e, user)).total, expected);
      const history = await e.history.get(user); assert.equal(history.items.length, 1);
      assert.equal(history.items[0].self.score, expected); assert.equal(history.items[0].self.balanceAfter, expected);
    }
    if (!memory) {
      verifyLiveStore({ sourcePath: f.path, key: f.key, gameRegistry: registry, now: f.now });
      if (ending === 'voluntary-leave') {
        // Exercise the cross-ledger reference check directly as well: keeping
        // the same identities and zero sum cannot legitimize another seat's score.
        const terminal = await saved(e, host);
        const check = room => validateScoreRecoveryReferences({ rooms: [room], summaries: [], state: { reservations: [], ledgers: ledger } });
        assert.equal(check(terminal), true);
        for (const defect of ['points', 'duplicate-seat', 'foreign-seat']) {
          const changed = structuredClone(terminal), entries = changed.game.result.deltas;
          if (defect === 'points') {
            const loser = entries.find(entry => entry.points < 0), winner = entries.find(entry => entry.points > 0);
            [loser.points, winner.points] = [winner.points, loser.points];
          } else entries[0].playerId = defect === 'duplicate-seat' ? entries[1].playerId : 'f'.repeat(32);
          assert.throws(() => check(changed), /Score recovery reference mismatch/, defect);
        }
      }
    }
  });
}

test('414 real SQLite room start reserves once, deals 108, hides other hands and leaves normal turns unlimited', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e);
  const snapshot = await saved(e, host), views = await Promise.all(users.slice(0, 3).map(user => e.rooms.getView(host.roomCode, user)));
  assert.equal(snapshot.schemaVersion, 11); assert.equal(snapshot.turnClock, null);
  assert.equal(snapshot.game.dealCursor, 108);
  assert.equal((await e.storage.scan(SCORE_SCOPES.meta)).length, 2);
  assert.equal((await ledgers(e)).length, 0);
  for (let i = 0; i < 3; i++) {
    assert.equal(views[i].game.players.find(p => p.id === views[i].selfId).hand.length, 36);
    const serialized = JSON.stringify(views[i]); assert.ok(!serialized.includes('userKey'));
    for (const player of snapshot.game.players.filter(p => p.id !== views[i].selfId)) {
      assert.ok(player.hand.every(id => !serialized.includes(id)));
    }
  }
  const spectator = await e.rooms.joinRoom(host.roomCode, users[3], '观众', 'watch');
  assert.equal(spectator.view.selfRole, 'spectator');
  assert.equal(spectator.view.game.players.reduce((sum, p) => sum + p.hand.length, 0), 108);
  const reconnect = await e.rooms.joinRoom(host.roomCode, users[1], '改名', 'new-device');
  assert.equal(reconnect.playerId, views[1].selfId);
  assert.deepEqual(reconnect.view.game.players.find(p => p.id === views[1].selfId).hand, views[1].game.players.find(p => p.id === views[1].selfId).hand);
  verifyLiveStore({ sourcePath: f.path, key: f.key, gameRegistry: registry, now: f.now });
});

test('414 quota refusal happens before the room starts or any card is dealt', async t => {
  const f = await fixture(t), e = await f.open();
  const limited = createDurableRoomStore({ storage: e.storage, now: f.now, gameRegistry: registry, pollIntervalMs: 0,
    scores: createGameScores({ storage: e.storage, now: f.now, capacityBytes: 100 }) });
  t.after(() => limited.close());
  await assert.rejects(f.start({ ...e, rooms: limited }), error => error.code === 'SCORE_CAPACITY');
  const rooms = await e.storage.scan('rooms'); assert.equal(rooms.length, 1);
  assert.equal(rooms[0].value.snapshot.phase, 'waiting'); assert.equal(rooms[0].value.snapshot.game, null);
  assert.equal((await e.storage.scan(SCORE_SCOPES.meta)).length, 0);
});

test('414 active departure commits exactly one penalty, immutable history balances and room transition together', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e), before = await e.rooms.getView(host.roomCode, users[0]);
  const input = { type: 'leave', requestId: 'repeat-leave', expectedRevision: before.revision };
  const results = await Promise.all([e.rooms.action(host.roomCode, users[0], input), e.rooms.action(host.roomCode, users[0], input)]);
  assert.ok(results.every(result => result.left));
  const ledger = await ledgers(e); assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0].deltas.map(d => d.delta), [-10, 5, 5]);
  const totals = await Promise.all(users.slice(0, 3).map(user => balance(e, user)));
  assert.deepEqual(totals.map(value => value.total), [-10, 5, 5]);
  assert.equal((await e.history.get(users[0])).items[0].self.balanceAfter, -10);
  assert.equal((await saved(e, host)).phase, 'aborted');
  await f.act(e, host.roomCode, users[1], 'leave'); await f.act(e, host.roomCode, users[2], 'leave');
  assert.equal((await ledgers(e)).length, 1);
  verifyLiveStore({ sourcePath: f.path, key: f.key, gameRegistry: registry });
});

test('414 failed atomic storage writes neither penalty nor departure and never publishes a success', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e), before = await saved(e, host);
  let calls = 0; const original = e.storage.compareAndSwapMany.bind(e.storage);
  e.storage.compareAndSwapMany = async () => { calls++; return false; };
  await assert.rejects(f.act(e, host.roomCode, users[0], 'leave'), { code: 'STORE_BUSY' });
  e.storage.compareAndSwapMany = original;
  assert.equal(calls, 3); assert.deepEqual(await saved(e, host), before);
  assert.equal((await ledgers(e)).length, 0); assert.equal((await e.storage.scan(SCORE_SCOPES.balances)).length, 0);
});

test('414 separate rooms settling the same accounts retain both deltas under a real SQLite race', async t => {
  const f = await fixture(t), e = await f.open(), first = await f.start(e), second = await f.start(e);
  await Promise.all([f.act(e, first.roomCode, users[0], 'leave'), f.act(e, second.roomCode, users[1], 'leave')]);
  assert.equal((await ledgers(e)).length, 2);
  assert.deepEqual((await Promise.all(users.slice(0, 3).map(user => balance(e, user)))).map(v => v.total), [-5, -5, 10]);
});

test('414 missing participant cancels at lastSeen + 120 seconds, not lease expiry plus 120 seconds', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e), before = await saved(e, host);
  const close = await e.rooms.subscribe(host.roomCode, users[1], () => {}); await close();
  // Other two stay present; only member 1 determines the cancellation boundary.
  await e.rooms.subscribe(host.roomCode, users[0], () => {}); await e.rooms.subscribe(host.roomCode, users[2], () => {});
  f.advance(119999); await e.rooms.sweep(); assert.equal((await saved(e, host)).phase, 'playing');
  f.advance(1); await e.rooms.sweep();
  const after = await saved(e, host); assert.equal(after.phase, 'waiting');
  assert.deepEqual(after.players.map(p => p.id), before.players.map(p => p.id));
  assert.ok(after.players.every(p => !p.ready)); assert.equal(after.lastMatchResult.reason, 'disconnected');
  assert.deepEqual((await ledgers(e))[0].deltas.map(d => d.delta), [0, 0, 0]);
  assert.equal((await e.storage.scan(SCORE_SCOPES.meta)).find(r => r.value.kind === 'quota').value.reservedBytes, 0);
});

test('414 a reconnect racing cancellation changes the presence fence and preserves the original match', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e);
  const before = await saved(e, host); f.advance(120000);
  const original = e.storage.compareAndSwapMany.bind(e.storage); let raced = false;
  e.storage.compareAndSwapMany = async txn => {
    if (!raced && txn.guards.some(g => g.scope === 'room-presence')) {
      raced = true;
      for (const user of users.slice(0, 3)) await e.rooms.subscribe(host.roomCode, user, () => {});
    }
    return original(txn);
  };
  await e.rooms.sweep(); e.storage.compareAndSwapMany = original;
  assert.equal(raced, true); assert.equal((await saved(e, host)).matchId, before.matchId);
  assert.equal((await saved(e, host)).phase, 'playing'); assert.equal((await ledgers(e)).length, 0);
});

test('414 startup fault recovery is gated before reads, zero-cancels once and permits a fresh new match', async t => {
  const f = await fixture(t), original = await f.open(), host = await f.start(original), before = await saved(original, host);
  await original.rooms.close(); const recovered = await f.open();
  const view = await recovered.rooms.getView(host.roomCode, users[0]);
  assert.equal(view.phase, 'waiting'); assert.equal(view.lastMatchResult.reason, 'server-recovery');
  assert.deepEqual(view.players.map(p => p.id), before.players.map(p => p.id));
  assert.equal((await ledgers(recovered)).length, 1);
  for (const user of users.slice(0, 3)) await f.act(recovered, host.roomCode, user, 'ready', { ready: true });
  await f.act(recovered, host.roomCode, users[0], 'start');
  assert.notEqual((await saved(recovered, host)).matchId, before.matchId);
  assert.equal((await recovered.rooms.getView(host.roomCode, users[0])).phase, 'playing');
});

test('414 TTL cleanup settles zero and releases score capacity in the same tombstone transaction', async t => {
  const f = await fixture(t, { ttlMs: 5000 }), e = await f.open(), host = await f.start(e, 3, false);
  f.advance(5001);
  await assert.rejects(e.rooms.getView(host.roomCode, users[0]), { code: 'ROOM_NOT_FOUND' });
  const record = await e.storage.read('rooms', host.view.roomId);
  assert.equal(record.value.snapshot, null); assert.equal((await ledgers(e)).length, 1);
  assert.equal((await ledgers(e))[0].reason, 'room-expired');
  assert.deepEqual(record.value.pendingRecords[0].players.map(p => p.balanceAfter), [0, 0, 0]);
});

test('414 expired response clock does not reject a still-current ordinary pass as a turn timeout', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e);
  let snapshot = await saved(e, host);
  const leader = snapshot.matchParticipants.find(p => p.playerId === snapshot.game.turnPlayerId).userKey;
  await f.act(e, host.roomCode, leader, 'play', { cardIds: [snapshot.game.players.find(p => p.id === snapshot.game.turnPlayerId).hand[0]] });
  snapshot = await saved(e, host); const user = snapshot.matchParticipants.find(p => p.playerId === snapshot.game.turnPlayerId).userKey;
  const view = await e.rooms.getView(host.roomCode, user), input = { type: 'pass', requestId: 'pass-after-window',
    expectedRevision: view.revision, matchId: snapshot.matchId, roundId: snapshot.game.roundId, targetId: snapshot.game.target.id };
  f.advance(5000); const result = await e.rooms.action(host.roomCode, user, input);
  assert.ok(result.view.game.passedPlayerIds.includes(view.selfId));
});

test('414 a whole real dealt match reaches an atomic normal result and repeated archival cannot recount it', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e);
  let finished = false;
  for (let count = 0; count < 324; count++) {
    const snapshot = await saved(e, host);
    if (snapshot.phase === 'finished') { finished = true; break; }
    const actor = snapshot.matchParticipants.find(p => p.playerId === snapshot.game.turnPlayerId);
    if (snapshot.game.target) await f.act(e, host.roomCode, actor.userKey, 'pass');
    else await f.act(e, host.roomCode, actor.userKey, 'play', {
      cardIds: [snapshot.game.players.find(p => p.id === actor.playerId).hand[0]],
    });
  }
  assert.equal(finished, true); const ledger = (await ledgers(e))[0];
  assert.equal(ledger.status, 'completed'); assert.equal(ledger.deltas.reduce((sum, d) => sum + d.delta, 0), 0);
  assert.equal(ledger.deltas.filter(d => d.delta > 0).length, 1);
  await e.rooms.flushPendingRecords(); await e.rooms.flushPendingRecords();
  assert.equal((await e.history.get(users[0])).stats.completed, 1);
  verifyLiveStore({ sourcePath: f.path, key: f.key, gameRegistry: registry });
});

test('414 cannot be created through the default catalog, while shipped recovery tools really read schema 11', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e);
  const { defaultGameRegistry } = await import('./game-registry.mjs');
  const { createRoomStore } = await import('./rooms.mjs');
  const defaultRooms = createRoomStore({ now: f.now });
  assert.throws(() => defaultRooms.createTrustedRoom(users[0], '甲', { gameType: 'poker414-2' }), { code: 'INVALID_GAME_TYPE' });
  assert.equal(defaultGameRegistry.gameAdapter('poker414-2').snapshotSchema(), 11);
  defaultRooms.importSnapshot(await saved(e, host));
  assert.equal(defaultRooms.getTrustedView(host.roomCode, users[0]).game.ruleVersion, 'poker414-2-v2');
  verifyLiveStore({ sourcePath: f.path, key: f.key });
  defaultRooms.applyLifecycle(host.roomCode, { matchId: (await saved(e, host)).matchId, reason: 'server-recovery' });
  for (const user of users.slice(0, 3)) {
    const view = defaultRooms.getTrustedView(host.roomCode, user);
    defaultRooms.trustedAction(host.roomCode, user, { type: 'ready', ready: true, requestId: user, expectedRevision: view.revision });
  }
  assert.throws(() => defaultRooms.trustedAction(host.roomCode, users[0], { type: 'start', requestId: 'disabled-start',
    expectedRevision: defaultRooms.getTrustedView(host.roomCode, users[0]).revision }), { code: 'INVALID_GAME_TYPE' });
});

test('414 a leave after the deal clock expires is not lost to a housekeeping revision', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e, 3, false);
  f.advance(1000); const result = await f.act(e, host.roomCode, users[0], 'leave');
  assert.equal(result.left, true); assert.deepEqual((await ledgers(e))[0].deltas.map(d => d.delta), [-10, 5, 5]);
});

test('414 automatic deal advancement also stops after two CAS rereads', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e, 3, false), before = await saved(e, host);
  const original = e.storage.compareAndSwapMany.bind(e.storage); let calls = 0;
  e.storage.compareAndSwapMany = async () => { calls++; return false; }; f.advance(1000);
  await assert.rejects(e.rooms.sweep(), { code: 'STORE_BUSY' }); e.storage.compareAndSwapMany = original;
  assert.equal(calls, 3); assert.deepEqual(await saved(e, host), before);
});

test('414 a lost terminal acknowledgement can be retried without counting the penalty twice', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e), view = await e.rooms.getView(host.roomCode, users[0]);
  const input = { type: 'leave', requestId: 'lost-ack', expectedRevision: view.revision };
  const original = e.storage.compareAndSwapMany.bind(e.storage); let lost = false;
  e.storage.compareAndSwapMany = async transaction => {
    const committed = await original(transaction);
    if (committed && !lost) { lost = true; throw new Error('synthetic acknowledgement loss'); }
    return committed;
  };
  await assert.rejects(e.rooms.action(host.roomCode, users[0], input), /acknowledgement loss/);
  e.storage.compareAndSwapMany = original;
  assert.equal((await e.rooms.action(host.roomCode, users[0], input)).left, true);
  assert.equal((await ledgers(e)).length, 1); assert.equal((await balance(e, users[0])).total, -10);
});

test('414 fork accepted before expiry cannot commit at the exact response deadline', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e);
  const { getCard } = await import('./games/poker414-2/cards.mjs');
  let state = await saved(e, host);
  const leader = state.game.players.find(p => p.id === state.game.turnPlayerId);
  let card, follower;
  for (const id of leader.hand) {
    follower = state.game.players.find(p => p.id !== leader.id && p.hand.filter(c => getCard(c).rank === getCard(id).rank).length >= 2);
    if (follower) { card = id; break; }
  }
  assert.ok(card);
  const userFor = seat => state.matchParticipants.find(p => p.playerId === seat).userKey;
  await f.act(e, host.roomCode, userFor(leader.id), 'play', { cardIds: [card] });
  state = await saved(e, host); const user = userFor(follower.id), beforeHand = structuredClone(follower.hand);
  const original = e.storage.compareAndSwapMany.bind(e.storage); let crossed = false;
  e.storage.compareAndSwapMany = async transaction => {
    if (!crossed && transaction.validUntil < Number.MAX_SAFE_INTEGER) {
      crossed = true; f.advance(transaction.validUntil - f.now());
    }
    return original(transaction);
  };
  await assert.rejects(f.act(e, host.roomCode, user, 'fork'), error => ['NO_RESPONSE_WINDOW', 'RESPONSE_EXPIRED', 'WINDOW_CHANGED'].includes(error.code));
  e.storage.compareAndSwapMany = original;
  const after = await saved(e, host); assert.equal(crossed, true);
  assert.deepEqual(after.game.players.find(p => p.id === follower.id).hand, beforeHand);
  assert.equal(after.game.moves.length, 1);
});

test('startup recovery is independent of opting into a disconnection timeout policy', async t => {
  const recoveryOnly = createGameRegistry([{ ...createPoker414Adapter(), disconnectTimeoutMs: undefined }]);
  const f = await fixture(t, { gameRegistry: recoveryOnly }), e = await f.open(), host = await f.start(e);
  await e.rooms.close(); const restarted = await f.open();
  assert.equal((await restarted.rooms.getView(host.roomCode, users[0])).lastMatchResult.reason, 'server-recovery');
});

test('the final enriched snapshot size is checked before room and score writes', async t => {
  const f = await fixture(t), e = await f.open(), host = await f.start(e), previous = await e.storage.read('rooms', host.view.roomId);
  const { createRoomStore } = await import('./rooms.mjs');
  const { createRoomScoreCommitter } = await import('../server/room-score-commit.mjs');
  const engine = createRoomStore({ now: f.now, gameRegistry: registry }); engine.importSnapshot(previous.value.snapshot);
  engine.applyLifecycle(host.roomCode, { matchId: previous.value.snapshot.matchId, reason: 'disconnected' });
  const next = { ...previous.value, snapshot: engine.exportSnapshot(host.roomCode) };
  const limit = Buffer.byteLength(JSON.stringify(next.snapshot));
  const limited = createGameRegistry([{ ...createPoker414Adapter(), maxSnapshotBytes: limit }]);
  const commit = createRoomScoreCommitter({ storage: e.storage, gameRegistry: limited, now: f.now });
  await assert.rejects(commit(host.view.roomId, previous, next), { code: 'ROOM_STATE_LIMIT' });
  assert.equal((await ledgers(e)).length, 0);
  assert.deepEqual((await e.storage.read('rooms', host.view.roomId)).value, previous.value);
});
