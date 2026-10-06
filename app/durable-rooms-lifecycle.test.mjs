import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createMatchHistory } from '../server/match-history.mjs';

const users = [0, 1, 2].map((index) => identityKey('https://synthetic.example', `lifecycle-${index}`));
let sequence = 0;
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'game-lifecycle-')), key = randomBytes(32), opened = [];
  let time = 10000;
  function open() {
    const storage = new EncryptedStore(new SQLiteAdapter(join(directory, 'rooms.sqlite'), { now: () => time }), key, () => time);
    const rooms = createDurableRoomStore({ storage, now: () => time, pollIntervalMs: 0,
      gameOptions: { firstTurnIndex: 0, randomInt: (maximum) => maximum - 1 }, ...extra });
    const value = { storage, rooms }; opened.push(value); return value;
  }
  const first = open();
  t.after(async () => { for (const entry of opened) { await entry.rooms.close(); entry.storage.close(); } await rm(directory, { recursive: true }); });
  const act = async (rooms, code, index, type, fields = {}) => rooms.action(code, users[index], {
    type, requestId: `durable-life-${++sequence}`, expectedRevision: (await rooms.getView(code, users[index])).revision, ...fields,
  });
  async function running(count = 2) {
    const a = await first.rooms.createRoom(users[0], '甲', `create-${++sequence}`);
    for (let index = 1; index < count; index++) await first.rooms.joinRoom(a.roomCode, users[index], `玩家${index}`, `join-${++sequence}`);
    for (let index = 0; index < count; index++) await act(first.rooms, a.roomCode, index, 'ready', { ready: true });
    return (await act(first.rooms, a.roomCode, 0, 'start')).view;
  }
  return { ...first, open, act, running, time: () => time, advance: (ms) => { time += ms; } };
}

test('durable active leave revokes all devices, retains outbox through empty closure, and replays after restart', async (t) => {
  const f = await fixture(t), first = await f.running(), peer = f.open(), ended = [];
  await f.rooms.subscribe(first.roomCode, users[0], () => {}, (reason) => ended.push(reason));
  await peer.rooms.subscribe(first.roomCode, users[0], () => {}, (reason) => ended.push(reason));
  const leave = { type: 'leave', requestId: 'lost-leave-response', expectedRevision: first.revision };
  const replies = await Promise.all([f.rooms.action(first.roomCode, users[0], leave), peer.rooms.action(first.roomCode, users[0], leave)]);
  assert.ok(replies.every((reply) => reply.left)); await peer.rooms.sweep(); assert.equal(ended.length, 2);
  assert.deepEqual(await f.rooms.recentRooms(users[0]), []);
  await assert.rejects(peer.rooms.getView(first.roomCode, users[0]), { code: 'SEAT_REQUIRED' });
  const remainder = await f.rooms.getView(first.roomCode, users[1]); assert.equal(remainder.phase, 'aborted');
  const final = { type: 'leave', requestId: 'final-leave-response', expectedRevision: remainder.revision };
  await f.rooms.action(first.roomCode, users[1], final);
  const restored = f.open(); assert.deepEqual(await restored.rooms.action(first.roomCode, users[1], final), { view: null, left: true });
  const saved = (await f.storage.read('rooms', first.roomId)).value;
  assert.equal(saved.snapshot, null); assert.equal(saved.pendingRecords.length, 1);
  assert.equal(saved.pendingRecords[0].matchId, first.matchId);
  await assert.rejects(restored.rooms.action(first.roomCode, users[1], { ...final, type: 'draw' }), { code: 'REQUEST_ID_REUSED' });
  assert.deepEqual(await restored.rooms.recentRooms(users[1]), []);
});

test('outbox survives archive failure, retries idempotently, and expiry produces unscored history', async (t) => {
  const f = await fixture(t, { ttlMs: 1000 }), view = await f.running();
  f.rooms.setHistory({ archive: async () => { throw new Error('temporary history outage'); } });
  await f.act(f.rooms, view.roomCode, 0, 'leave');
  assert.equal((await f.storage.read('rooms', view.roomId)).value.snapshot.pendingRecords.length, 1);
  const archived = new Map(); f.rooms.setHistory({ archive: async (summary) => { archived.set(summary.matchId, summary); } });
  await f.rooms.flushPendingRecords(); await f.rooms.flushPendingRecords(); assert.equal(archived.size, 1);
  assert.equal((await f.storage.read('rooms', view.roomId)).value.snapshot.pendingRecords.length, 0);
  const next = await f.running(); f.advance(1001); await f.rooms.sweep();
  assert.equal(archived.get(next.matchId).reason, 'expired');
  assert.ok(archived.get(next.matchId).players.every((player) => player.outcome === 'unscored'));
});

test('unanimous pause survives restart for seven-day TTL, does not renew on reads, and any member resumes', async (t) => {
  const f = await fixture(t, { ttlMs: 1000, pausedTtlMs: 7000 }), view = await f.running();
  f.advance(400); const proposal = (await f.act(f.rooms, view.roomCode, 0, 'pause')).view;
  assert.equal(proposal.expiresAt, view.expiresAt);
  const paused = (await f.act(f.rooms, view.roomCode, 1, 'pause')).view;
  assert.equal(paused.expiresAt, f.time() + 7000);
  f.advance(2000); const restored = f.open();
  assert.equal((await restored.rooms.getView(view.roomCode, users[1])).phase, 'paused');
  const recent = (await restored.rooms.recentRooms(users[1]))[0];
  assert.equal(recent.expiresAt, paused.expiresAt); assert.equal(recent.playersCount, 2); assert.equal(recent.hostName, '甲');
  await assert.rejects(f.act(restored.rooms, view.roomCode, 0, 'draw'), { code: 'GAME_PAUSED' });
  const resumed = (await f.act(restored.rooms, view.roomCode, 1, 'resume')).view; assert.equal(resumed.phase, 'playing');
  assert.equal(resumed.game.turnPlayerId, view.game.turnPlayerId);
  await f.act(restored.rooms, view.roomCode, 0, 'pause'); await f.act(restored.rooms, view.roomCode, 1, 'pause');
  f.advance(7001); await restored.rooms.sweep();
  await assert.rejects(restored.rooms.getView(view.roomCode, users[1]), { code: 'ROOM_NOT_FOUND' });
  assert.equal((await f.storage.read('rooms', view.roomId)).value.pendingRecords[0].reason, 'expired');
});

test('offline host takeover waits presence lease plus grace and reconnect racing CAS prevents takeover', async (t) => {
  const f = await fixture(t, { presenceTtlMs: 20, hostTakeoverGraceMs: 60 }), view = await f.running();
  const close = await f.rooms.subscribe(view.roomCode, users[0], () => {});
  f.advance(50); await close(); f.advance(79);
  assert.equal((await f.rooms.getView(view.roomCode, users[1])).hostCanTakeOver, false);
  await assert.rejects(f.act(f.rooms, view.roomCode, 1, 'transferHost'), { code: 'HOST_ACTIVE' });
  f.advance(1); assert.equal((await f.rooms.getView(view.roomCode, users[1])).hostCanTakeOver, true);
  const original = f.storage.guardedCAS.bind(f.storage); let race = true;
  f.storage.guardedCAS = async (...args) => {
    if (race) { race = false; await f.rooms.subscribe(view.roomCode, users[0], () => {}); }
    return original(...args);
  };
  await assert.rejects(f.act(f.rooms, view.roomCode, 1, 'transferHost'), { code: 'HOST_ACTIVE' });
  assert.equal((await f.rooms.getView(view.roomCode, users[1])).hostId, view.hostId);
});

test('simultaneous departures preserve one aborted result; leave acknowledgements have finite retention', async (t) => {
  const f = await fixture(t, { leaveRetentionMs: 100 }), view = await f.running(); const peer = f.open();
  const a = { type: 'leave', requestId: 'parallel-a', expectedRevision: view.revision };
  const b = { type: 'leave', requestId: 'parallel-b', expectedRevision: view.revision };
  const replies = await Promise.allSettled([f.rooms.action(view.roomCode, users[0], a), peer.rooms.action(view.roomCode, users[1], b)]);
  assert.equal(replies.filter((result) => result.status === 'fulfilled').length, 1);
  const remaining = replies[0].status === 'fulfilled' ? 1 : 0;
  const last = { type: 'leave', requestId: 'last-after-conflict', expectedRevision: (await f.rooms.getView(view.roomCode, users[remaining])).revision };
  await f.rooms.action(view.roomCode, users[remaining], last);
  assert.equal((await f.storage.read('rooms', view.roomId)).value.pendingRecords.length, 1);
  f.advance(101); await assert.rejects(f.rooms.action(view.roomCode, users[remaining], last), { code: 'ROOM_NOT_FOUND' });
  await f.rooms.sweep(); assert.equal((await f.storage.read('rooms', view.roomId)).value.pendingRecords.length, 1);
});

test('completed and paused games let every member leave; committed outbox archives into the real history service', async (t) => {
  const f = await fixture(t), history = createMatchHistory({ storage: f.storage, now: f.time }); f.rooms.setHistory(history);
  let view = await f.running(); const completedId = view.matchId;
  while (view.game.poolCount || view.phase !== 'finished') {
    const snapshot = (await f.storage.read('rooms', view.roomId)).value.snapshot;
    const player = snapshot.players.find((entry) => entry.id === view.game.turnPlayerId);
    view = (await f.act(f.rooms, view.roomCode, users.indexOf(player.userKey), view.game.poolCount ? 'draw' : 'pass')).view;
  }
  const settlement = structuredClone(view.game.result);
  await f.act(f.rooms, view.roomCode, 0, 'leave');
  assert.deepEqual((await f.rooms.getView(view.roomCode, users[1])).game.result, settlement);
  await f.act(f.rooms, view.roomCode, 1, 'leave');
  const completed = await history.get(users[0]); assert.equal(completed.items[0].matchId, completedId);
  assert.equal(completed.stats.completed, 1); assert.equal(completed.items[0].status, 'completed');
  assert.ok(!/userKey|seatId|rack/.test(JSON.stringify(completed)));
  const paused = await f.running(); await f.act(f.rooms, paused.roomCode, 0, 'pause'); await f.act(f.rooms, paused.roomCode, 1, 'pause');
  await f.act(f.rooms, paused.roomCode, 0, 'leave'); await f.act(f.rooms, paused.roomCode, 1, 'leave');
  const historyResult = await history.get(users[1]); assert.equal(historyResult.stats.completed, 1); assert.equal(historyResult.stats.aborted, 1);
  assert.ok(historyResult.items.find((item) => item.matchId === paused.matchId).players.every((player) => player.outcome === 'unscored'));
  assert.deepEqual(await f.rooms.recentRooms(users[0]), []); assert.deepEqual(await f.rooms.recentRooms(users[1]), []);
});

test('room tombstones expire only after outbox is archived and retired invitation prevents stale create resurrection', async (t) => {
  const f = await fixture(t, { leaveRetentionMs: 100 }), view = await f.running(), original = (await f.storage.read('rooms', view.roomId)).value.snapshot;
  f.rooms.setHistory({ archive: async () => { throw new Error('offline'); } });
  await f.act(f.rooms, view.roomCode, 0, 'leave'); await f.act(f.rooms, view.roomCode, 1, 'leave');
  f.advance(101); await f.rooms.sweep(); assert.equal((await f.storage.read('rooms', view.roomId)).value.pendingRecords.length, 1);
  f.rooms.setHistory({ archive: async () => {} }); await f.rooms.sweep();
  assert.equal(await f.storage.read('rooms', view.roomId), null);
  assert.deepEqual((await f.storage.read('room-invites', view.roomCode)).value, { roomId: view.roomId, retired: true });
  const operationKey = createHash('sha256').update(`${users[0]}\0create\0old-pending-create`).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({ name: '甲' })).digest('hex');
  await f.storage.put('room-requests', operationKey, { kind: 'create', fingerprint, roomId: view.roomId, code: view.roomCode, status: 'pending', snapshot: original });
  await assert.rejects(f.rooms.createRoom(users[0], '甲', 'old-pending-create'), { code: 'ROOM_NOT_FOUND' });
  assert.equal(await f.storage.read('rooms', view.roomId), null);
});

test('failed expiry CAS retries a concurrently renewed room and offline takeover preserves game revision', async (t) => {
  const f = await fixture(t, { ttlMs: 1000, presenceTtlMs: 20, hostTakeoverGraceMs: 60 }), view = await f.running();
  const replace = f.storage.replaceCAS.bind(f.storage); let renew = true;
  f.storage.replaceCAS = async (...args) => {
    if (args[0] === 'rooms' && args[3].snapshot === null && renew) {
      renew = false; const current = await f.storage.read('rooms', view.roomId); current.value.snapshot.lastActiveAt = f.time();
      await replace('rooms', view.roomId, current.version, current.value);
    }
    return replace(...args);
  };
  f.advance(1001); const renewed = await f.rooms.getView(view.roomCode, users[1]);
  assert.equal(renewed.phase, 'playing'); assert.equal(renewed.expiresAt, f.time() + 1000);
  assert.deepEqual((await f.storage.read('rooms', view.roomId)).value.snapshot.pendingRecords, []);
  assert.equal(renewed.hostCanTakeOver, true);
  const transferred = (await f.act(f.rooms, view.roomCode, 1, 'transferHost')).view;
  assert.equal(transferred.hostId, transferred.selfId); assert.equal(transferred.game.revision, renewed.game.revision);
});

test('recent cleanup cannot remove a seat that another device has just rejoined', async (t) => {
  const f = await fixture(t), a = await f.rooms.createRoom(users[0], '甲', `waiting-${++sequence}`);
  const member = await f.rooms.joinRoom(a.roomCode, users[1], '乙', `initial-${++sequence}`);
  const oldIndex = (await f.storage.read('room-memberships', users[1])).value;
  await f.act(f.rooms, a.roomCode, 1, 'leave'); await f.storage.put('room-memberships', users[1], oldIndex);
  const replace = f.storage.replaceCAS.bind(f.storage); let race = true;
  f.storage.replaceCAS = async (...args) => {
    if (args[0] === 'room-memberships' && race) {
      race = false; await f.rooms.joinRoom(a.roomCode, users[1], '乙', `rejoined-${++sequence}`);
    }
    return replace(...args);
  };
  assert.deepEqual(await f.rooms.recentRooms(users[1]), []);
  const recent = await f.rooms.recentRooms(users[1]); assert.equal(recent.length, 1); assert.notEqual(recent[0].playerId, member.playerId);
});

test('a committed departure cannot erase a new seat another device joins before old index cleanup', async (t) => {
  const f = await fixture(t), host = await f.rooms.createRoom(users[0], '甲', `cleanup-host-${++sequence}`);
  const old = await f.rooms.joinRoom(host.roomCode, users[1], '乙', `cleanup-join-${++sequence}`);
  const read = f.storage.read.bind(f.storage); let race = true, newSeat;
  f.storage.read = async (...args) => {
    if (args[0] === 'room-memberships' && args[1] === users[1] && race) {
      race = false; newSeat = await f.rooms.joinRoom(host.roomCode, users[1], '乙', `cleanup-rejoin-${++sequence}`);
    }
    return read(...args);
  };
  await f.act(f.rooms, host.roomCode, 1, 'leave');
  assert.notEqual(newSeat.playerId, old.playerId);
  assert.equal((await f.rooms.recentRooms(users[1]))[0].playerId, newSeat.playerId);
  assert.equal((await f.rooms.getView(host.roomCode, users[1])).selfId, newSeat.playerId);
});

test('legacy tombstones without roomCode are reclaimed with or without old create markers', async (t) => {
  const f = await fixture(t, { leaveRetentionMs: 100 });
  const marked = await f.rooms.createRoom(users[0], '甲', `legacy-marked-${++sequence}`);
  const unmarked = await f.rooms.createRoom(users[1], '乙', `legacy-unmarked-${++sequence}`);
  await f.storage.put('rooms', marked.view.roomId, { snapshot: null, deletedAt: f.time(), reason: 'empty' });
  await f.storage.put('rooms', unmarked.view.roomId, { snapshot: null, deletedAt: f.time(), reason: 'expired' });
  const operation = (await f.storage.scan('room-requests')).find((entry) => entry.value.roomId === marked.view.roomId);
  const operationKey = createHash('sha256').update(`${users[0]}\0create\0legacy-surviving`).digest('hex');
  await f.storage.put('room-requests', operationKey, operation.value);
  await f.storage.put('room-registry', 'active', {});
  f.advance(101); await f.rooms.sweep();
  assert.equal(await f.storage.read('rooms', marked.view.roomId), null); assert.equal(await f.storage.read('rooms', unmarked.view.roomId), null);
  assert.deepEqual((await f.storage.read('room-invites', marked.roomCode)).value, { roomId: marked.view.roomId, retired: true });
  assert.equal((await f.storage.read('room-invites', unmarked.roomCode)).value.roomId, unmarked.view.roomId);
  await assert.rejects(f.rooms.getView(unmarked.roomCode, users[1]), { code: 'ROOM_NOT_FOUND' });
});
