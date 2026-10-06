import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createRoomStore, RoomError } from './rooms.mjs';

const issuer = 'https://synthetic.example/pool';
const users = Array.from({ length: 10 }, (_, index) => identityKey(issuer, `synthetic-member-${index}`));
const options = { firstTurnIndex: 0, randomInt: (max) => max - 1 };
const codeError = (code) => (error) => error instanceof RoomError && error.code === code;
let requests = 0;
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'game-room-durable-test-'));
  const path = join(directory, 'test.sqlite');
  const key = randomBytes(32);
  let time = 10000;
  const now = () => time;
  const opened = [];
  function open() {
    const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
    const roomStore = createDurableRoomStore({ storage, now, gameOptions: options, pollIntervalMs: 0, ...overrides });
    opened.push({ storage, roomStore });
    return { storage, roomStore };
  }
  t.after(async () => {
    for (const entry of opened) {
      if (!entry.closed) { await entry.roomStore.close(); entry.storage.close(); entry.closed = true; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function shutdown(entry) {
    await entry.roomStore.close(); entry.storage.close();
    opened.find((candidate) => candidate.roomStore === entry.roomStore).closed = true;
  }
  return { path, open, shutdown, setTime: (value) => { time = value; }, getTime: now };
}
async function perform(store, code, userKey, type, extra = {}) {
  const view = await store.getView(code, userKey);
  return store.action(code, userKey, { type, requestId: `action-${++requests}`,
    expectedRevision: view.revision, ...extra });
}
async function running(store) {
  const a = await store.createRoom(users[0], '共同昵称', `create-${++requests}`);
  const b = await store.joinRoom(a.roomCode, users[1], '共同昵称', `join-${++requests}`);
  await perform(store, a.roomCode, users[0], 'ready', { ready: true });
  await perform(store, a.roomCode, users[1], 'ready', { ready: true });
  await perform(store, a.roomCode, users[0], 'start');
  return { a, b };
}

test('durable profiles automatically upsert once; the project nickname is independent of claims', async (t) => {
  const f = await fixture(t);
  const a = f.open().roomStore, b = f.open().roomStore;
  const profiles = await Promise.all([a.ensureProfile(users[0]), b.ensureProfile(users[0])]);
  assert.deepEqual(profiles[0], profiles[1]);
  assert.equal(profiles[0].nickname, null);
  assert.deepEqual(Object.keys(profiles[0]).sort(), ['createdAt', 'nickname', 'updatedAt', 'userKey']);
  const changed = await a.setProfile(users[0], '棋牌自己的名字');
  assert.equal(changed.nickname, '棋牌自己的名字');
  assert.equal((await b.ensureProfile(users[0], '中心的新名字')).nickname, '棋牌自己的名字');
  await assert.rejects(a.ensureProfile({ userKey: users[0], roles: ['admin'] }), codeError('INVALID_IDENTITY'));
  await assert.rejects(a.setProfile(users[0], '名\n字'), codeError('INVALID_NAME'));
});

test('concurrent create request is idempotent across SQLite connections and never returns a credential', async (t) => {
  const f = await fixture(t);
  const a = f.open().roomStore, b = f.open().roomStore;
  const memberships = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    (index % 2 ? a : b).createRoom(users[0], '房主', 'same-create')));
  assert.ok(memberships.every((member) => member.roomCode === memberships[0].roomCode && member.playerId === memberships[0].playerId));
  assert.deepEqual(Object.keys(memberships[0]).sort(), ['playerId', 'roomCode', 'view']);
  assert.equal(memberships[0].view.players.length, 1);
  assert.ok(!/token|userKey|tokenHash/.test(JSON.stringify(memberships[0])));
  await assert.rejects(b.createRoom(users[0], '另一个名字', 'same-create'), codeError('REQUEST_ID_REUSED'));
  assert.equal((await a.recentRooms(users[0])).length, 1);
});

test('same account joins one seat across concurrent devices; same nickname never claims another seat', async (t) => {
  const f = await fixture(t);
  const a = f.open().roomStore, b = f.open().roomStore;
  const host = await a.createRoom(users[0], '同名', 'host');
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    (index % 2 ? a : b).joinRoom(host.roomCode, users[1], '同名', `join-${index}`)));
  assert.ok(results.every((member) => member.playerId === results[0].playerId));
  assert.notEqual(results[0].playerId, host.playerId);
  assert.equal((await a.getView(host.roomCode, users[0])).players.length, 2);
  await assert.rejects(b.getView(host.roomCode, users[2]), codeError('SEAT_REQUIRED'));
  await assert.rejects(b.action(host.roomCode, users[2], { type: 'start', requestId: 'pretend-admin', expectedRevision: 1 }), codeError('SEAT_REQUIRED'));
  await assert.rejects(b.joinRoom(host.roomCode, users[1], '别的名字', 'join-0'), codeError('REQUEST_ID_REUSED'));
});

test('room capacity is reserved atomically across instances and released after an empty room closes', async (t) => {
  const f = await fixture(t, { maxRooms: 1 });
  const aStore = f.open().roomStore, bStore = f.open().roomStore;
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    (index % 2 ? aStore : bStore).createRoom(users[index], '玩家', `capacity-${index}`)));
  const created = outcomes.filter((entry) => entry.status === 'fulfilled');
  assert.equal(created.length, 1);
  assert.ok(outcomes.filter((entry) => entry.status === 'rejected').every((entry) => entry.reason.code === 'ROOM_LIMIT'));
  const host = created[0].value;
  const user = users[outcomes.findIndex((entry) => entry.status === 'fulfilled')];
  await perform(aStore, host.roomCode, user, 'leave');
  const next = await bStore.createRoom(users[0], '新房主', 'new-capacity');
  assert.notEqual(next.roomCode, host.roomCode);
});

test('interrupted creation resumes idempotently and cannot resurrect a room closed before its completion marker', async (t) => {
  const f = await fixture(t);
  const entry = f.open();
  let interrupt = true;
  const intercepted = new Proxy(entry.storage, {
    get(target, property) {
      if (property === 'replaceCAS') return async (...args) => {
        if (args[0] === 'room-requests' && interrupt) { interrupt = false; throw new Error('synthetic storage interruption'); }
        return target.replaceCAS(...args);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const interruptedStore = createDurableRoomStore({ storage: intercepted, now: f.getTime, pollIntervalMs: 0 });
  t.after(() => interruptedStore.close());
  await assert.rejects(interruptedStore.createRoom(users[0], '甲', 'interrupted'), /synthetic storage interruption/);
  const registry = (await entry.storage.read('room-registry', 'active')).value;
  const code = Object.values(registry)[0].code;
  const firstView = await entry.roomStore.getView(code, users[0]);
  const resumed = await interruptedStore.createRoom(users[0], '甲', 'interrupted');
  assert.equal(resumed.roomCode, code);
  assert.equal(resumed.playerId, firstView.selfId);
  assert.equal(resumed.view.players.length, 1);

  interrupt = true;
  await assert.rejects(interruptedStore.createRoom(users[1], '乙', 'interrupted-then-left'), /synthetic storage interruption/);
  const records = (await entry.storage.read('room-registry', 'active')).value;
  const secondCode = Object.values(records).find((record) => record.code !== code).code;
  await perform(entry.roomStore, secondCode, users[1], 'leave');
  await assert.rejects(interruptedStore.createRoom(users[1], '乙', 'interrupted-then-left'), codeError('ROOM_NOT_FOUND'));
});

test('persisted playing game restores exact private rack and turn on a new session or server restart', async (t) => {
  const f = await fixture(t);
  const original = f.open();
  const { a, b } = await running(original.roomStore);
  const beforeA = await original.roomStore.getView(a.roomCode, users[0]);
  const beforeB = await original.roomStore.getView(a.roomCode, users[1]);
  await f.shutdown(original);
  const restored = f.open().roomStore;
  assert.deepEqual(await restored.getView(a.roomCode, users[0]), beforeA);
  assert.deepEqual(await restored.getView(a.roomCode, users[1]), beforeB);
  const membership = await restored.joinRoom(a.roomCode, users[1], '新设备显示名', 'resume-playing');
  assert.equal(membership.playerId, b.playerId);
  assert.equal(membership.view.players.length, 2);
  assert.equal(membership.view.players.find((entry) => entry.id === b.playerId).name, '共同昵称');
  assert.equal((await restored.ensureProfile(users[1])).nickname, '新设备显示名');
  const spectator=await restored.joinRoom(a.roomCode,users[2],'共同昵称','late');assert.equal(spectator.view.selfRole,'spectator');
  assert.equal(spectator.view.players.length,2);assert.ok(!('rack' in spectator.view.game));
  const serialized = JSON.stringify(beforeA);
  assert.ok(beforeB.game.rack.every((tile) => !serialized.includes(`"${tile.id}"`)));
  assert.ok(!('pool' in beforeA.game));
});

test('cross-instance actions apply once, reject stale versions, wrong turn, forged player and admin shortcuts', async (t) => {
  const f = await fixture(t);
  const aStore = f.open().roomStore, bStore = f.open().roomStore;
  const { a, b } = await running(aStore);
  const view = await aStore.getView(a.roomCode, users[0]);
  const draw = { type: 'draw', requestId: 'once-draw', expectedRevision: view.revision };
  const results = await Promise.all([aStore.action(a.roomCode, users[0], draw), bStore.action(a.roomCode, users[0], draw)]);
  assert.ok(results.every((entry) => entry.view.revision === view.revision + 1));
  const latest = await bStore.getView(a.roomCode, users[0]);
  assert.equal(latest.game.rack.length, 15);
  assert.equal(latest.game.poolCount, view.game.poolCount - 1);
  await assert.rejects(aStore.action(a.roomCode, users[1], { ...draw, requestId: 'stale' }), codeError('REVISION_CONFLICT'));
  await assert.rejects(aStore.action(a.roomCode, users[0], { ...draw, requestId: 'wrong-turn', expectedRevision: latest.revision }), codeError('INVALID_GAME_ACTION'));
  await assert.rejects(aStore.action(a.roomCode, users[1], { ...draw, requestId: 'forged-player', expectedRevision: latest.revision, playerId: a.playerId }), codeError('INVALID_ACTION'));
  await assert.rejects(aStore.action(a.roomCode, users[0], { ...draw, type: 'pass' }), codeError('REQUEST_ID_REUSED'));
  assert.equal((await bStore.getView(b.roomCode, users[1])).game.turnPlayerId, b.playerId);
});

test('administrator identity still needs a seat and host ownership; seven-seat recovery precedes full/locked checks', async (t) => {
  const f = await fixture(t);
  const store = f.open().roomStore;
  const host = await store.createRoom(users[0], '房主', 'seven-host');
  for (let index = 1; index < 7; index += 1) await store.joinRoom(host.roomCode, users[index], '玩家', `seven-${index}`);
  await assert.rejects(store.joinRoom(host.roomCode, users[7], '管理员', 'eighth'), codeError('ROOM_FULL'));
  const restored = await store.joinRoom(host.roomCode, users[1], '恢复', 'recover-full');
  assert.equal(restored.view.players.length, 7);
  await assert.rejects(perform(store, host.roomCode, users[1], 'start'), codeError('HOST_REQUIRED'));
  for (let index = 0; index < 7; index += 1) await perform(store, host.roomCode, users[index], 'ready', { ready: true });
  await perform(store, host.roomCode, users[0], 'start');
  const again = await store.joinRoom(host.roomCode, users[1], '恢复', 'recover-locked');
  assert.equal(again.playerId, restored.playerId);
  assert.equal(again.view.game.players.reduce((sum, player) => sum + player.rackCount, 0) + again.view.game.poolCount, 159);
});

test('multi-device SSE presence crosses instances; single-session disconnect preserves cards, turn and other connection', async (t) => {
  const f = await fixture(t);
  const aStore = f.open().roomStore, bStore = f.open().roomStore;
  const { a, b } = await running(aStore);
  const aEvents = [], bEvents = [];
  const a1 = await aStore.subscribe(a.roomCode, users[0], (view) => aEvents.push(view));
  const a2 = await bStore.subscribe(a.roomCode, users[0], () => {});
  const b1 = await bStore.subscribe(a.roomCode, users[1], (view) => bEvents.push(view));
  await aStore.sweep();
  assert.ok(aEvents.at(-1).players.every((player) => player.connected));
  const before = await aStore.getView(a.roomCode, users[0]);
  await a1();
  assert.equal((await aStore.getView(a.roomCode, users[1])).players.find((player) => player.id === a.playerId).connected, true);
  await a2();
  assert.equal(bEvents.at(-1).players.find((player) => player.id === a.playerId).connected, false);
  const after = await bStore.getView(a.roomCode, users[0]);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.game.rack, before.game.rack);
  assert.equal(after.game.turnPlayerId, before.game.turnPlayerId);
  assert.equal(bEvents.at(-1).game.playerId, b.playerId);
  await b1();
});

test('SSE connection limits are enforced across instances for one account', async (t) => {
  const f = await fixture(t);
  const aStore = f.open().roomStore, bStore = f.open().roomStore;
  const a = await aStore.createRoom(users[0], '房主', 'connections');
  const unsubscribe = [];
  for (let index = 0; index < 4; index += 1) unsubscribe.push(await (index % 2 ? aStore : bStore).subscribe(a.roomCode, users[0], () => {}));
  await assert.rejects(aStore.subscribe(a.roomCode, users[0], () => {}), codeError('CONNECTION_LIMIT'));
  for (const close of unsubscribe) await close();
  assert.equal((await bStore.getView(a.roomCode, users[0])).players[0].connected, false);
});

test('presence polling and private reads do not renew game TTL; expired invitations never revive old games', async (t) => {
  const f = await fixture(t, { ttlMs: 100, maxRooms: 1 });
  const store = f.open().roomStore;
  const host = await store.createRoom(users[0], '房主', 'ttl-create');
  const ended = [];
  await store.subscribe(host.roomCode, users[0], () => {}, (reason) => ended.push(reason));
  f.setTime(f.getTime() + 90);
  await store.sweep();
  await store.getView(host.roomCode, users[0]);
  f.setTime(f.getTime() + 11);
  await store.sweep();
  assert.equal(ended.length, 1);
  await assert.rejects(store.getView(host.roomCode, users[0]), codeError('ROOM_NOT_FOUND'));
  await assert.rejects(store.createRoom(users[0], '房主', 'ttl-create'), codeError('ROOM_NOT_FOUND'));
  const replacement = await store.createRoom(users[0], '新房', 'new-create');
  assert.notEqual(replacement.roomCode, host.roomCode);
  assert.equal((await store.recentRooms(users[0])).length, 1);
});

test('project room leave transfers host without deleting the project profile or shared identity', async (t) => {
  const f = await fixture(t);
  const store = f.open().roomStore;
  const a = await store.createRoom(users[0], '甲', 'leave-host');
  const b = await store.joinRoom(a.roomCode, users[1], '乙', 'leave-join');
  assert.deepEqual(await perform(store, a.roomCode, users[0], 'leave'), { view: null, left: true });
  await assert.rejects(store.getView(a.roomCode, users[0]), codeError('SEAT_REQUIRED'));
  assert.equal((await store.getView(a.roomCode, users[1])).hostId, b.playerId);
  assert.equal((await store.ensureProfile(users[0])).nickname, '甲');
  assert.deepEqual(await store.recentRooms(users[0]), []);
  await perform(store, a.roomCode, users[1], 'leave');
  await assert.rejects(store.createRoom(users[0], '甲', 'leave-host'), codeError('ROOM_NOT_FOUND'));
});

test('recent rooms persist across devices, filter removed seats and are bounded to eight records', async (t) => {
  const f = await fixture(t);
  const aStore = f.open().roomStore, bStore = f.open().roomStore;
  const rooms = await Promise.all(Array.from({ length: 9 }, (_, index) =>
    (index % 2 ? aStore : bStore).createRoom(users[0], '甲', `recent-${index}`)));
  const recent = await bStore.recentRooms(users[0]);
  assert.equal(recent.length, 8);
  assert.ok(recent.every((entry) => rooms.some((room) => room.roomCode === entry.roomCode && room.playerId === entry.playerId)));
  assert.deepEqual(await bStore.recentRooms(users[1]), []);
  const leave = recent[0];
  await perform(aStore, leave.roomCode, users[0], 'leave');
  assert.equal((await bStore.recentRooms(users[0])).length, 7);
});

test('anonymous legacy snapshots are never claimed by a matching nickname or a new unified account', () => {
  const legacy = createRoomStore();
  const anonymous = legacy.createRoom('同名');
  const snapshot = legacy.exportSnapshot(anonymous.roomCode);
  const loaded = createRoomStore();
  loaded.importSnapshot(snapshot);
  assert.throws(() => loaded.getTrustedView(anonymous.roomCode, users[0]), codeError('SEAT_REQUIRED'));
  assert.equal(loaded.getView(anonymous.roomCode, anonymous.token).selfId, anonymous.playerId);
  const duplicate = copySnapshot(snapshot);
  duplicate.players.push({ ...duplicate.players[0], id: randomBytes(16).toString('hex'), userKey: users[0] });
  duplicate.players[0].userKey = users[0];
  assert.throws(() => loaded.importSnapshot(duplicate), codeError('INVALID_SNAPSHOT'));
});
function copySnapshot(value) { return structuredClone(value); }

test('a polling storage outage ends streams with 503 and keeps the saved room and seat', async (t) => {
  const f = await fixture(t, { pollIntervalMs: 10 });
  const { storage, roomStore } = f.open();
  const host = await roomStore.createRoom(users[0], '房主', 'poll-outage');
  let settle;
  const ended = new Promise((resolve) => { settle = resolve; });
  await roomStore.subscribe(host.roomCode, users[0], () => {}, (reason, status) => settle({ reason, status }));
  const originalRead = storage.read.bind(storage);
  storage.read = async () => { throw new Error('synthetic storage outage'); };
  const timer = setTimeout(() => settle({ status: 'timeout' }), 1000);
  let failure;
  try { failure = await ended; }
  finally { clearTimeout(timer); storage.read = originalRead; }
  assert.equal(failure.status, 503);
  assert.match(failure.reason, /暂时无法同步/);
  const recovered = await roomStore.getView(host.roomCode, users[0]);
  assert.equal(recovered.selfId, host.playerId);
  assert.equal(recovered.hostId, host.playerId);
});

test('SQLite snapshots and profiles are encrypted at rest with no raw nicknames or stable identity key', async (t) => {
  const f = await fixture(t);
  const entry = f.open();
  const room = await entry.roomStore.createRoom(users[0], '合成加密验证昵称', 'encrypted');
  await f.shutdown(entry);
  const bytes = await readFile(f.path);
  assert.ok(!bytes.includes(Buffer.from('合成加密验证昵称')));
  assert.ok(!bytes.includes(Buffer.from(users[0])));
  const restarted = f.open().roomStore;
  assert.equal((await restarted.getView(room.roomCode, users[0])).selfId, room.playerId);
});
