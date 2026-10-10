import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { backupStore, verifyBackup, restoreStore, SCORE_RECOVERY_SCOPES, RECOVERY_SCOPES } from '../server/backup.mjs';
import { snapshotHasRoles, snapshotGameType, snapshotFormatProblem, snapshotAuthorityBindingProblem } from '../server/room-snapshot-compat.mjs';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { CURRENT_DATA_COMPATIBILITY, compareReleaseCompatibility } from '../scripts/release-compatibility.mjs';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createHyakkiContractAdapter, createHyakkiContractPreparers } from './games/hyakki-trading/test-support/contract-adapter.mjs';
import { HYAKKI_EVENT_SCOPES } from '../server/games/hyakki-trading/event-store.mjs';

const id = value => value.toString(16).padStart(32, '0');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'hyakki-backup-compat-'));
  const sourcePath = join(directory, 'source.sqlite'), key = randomBytes(32), now = () => 10000;
  const storage = new EncryptedStore(new SQLiteAdapter(sourcePath, { now }), key, now);
  t.after(() => { storage.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, sourcePath, key, now, storage };
}

test('registry retains independently enumerable known games when creation is disabled', () => {
  const registry = createGameRegistry(defaultGameRegistry.knownTypes().map(type => defaultGameRegistry.gameAdapter(type)), { creationTypes: [] });
  assert.deepEqual(registry.knownTypes(), defaultGameRegistry.knownTypes());
  assert.deepEqual(registry.creationTypes(), []);
  for (const type of registry.knownTypes()) {
    assert.equal(registry.gameAdapter(type).gameType, type);
    assert.equal(registry.gameInfo(type).gameType, type);
    assert.throws(() => registry.normalizeGameType(type), /尚未开放创建/);
  }
  assert.throws(() => registry.knownTypes().push('unknown'), TypeError);
  assert.throws(() => registry.gameAdapter('unknown'), /不支持/);
  assert.throws(() => createGameRegistry([], { creationTypes: ['unknown'] }), /未知游戏/);
});

test('schema12 reserves the hyakki envelope and requires roles, turn clock and stable authority binding', () => {
  const adapter = { gameType: 'hyakki-trading', snapshotProblem: () => false };
  const snapshot = { schemaVersion: 12, gameType: 'hyakki-trading', roomId: id(1), code: '234567', spectators: [], turnClock: null, game: null };
  assert.equal(snapshotHasRoles(snapshot), true);
  assert.equal(snapshotGameType(snapshot), 'hyakki-trading');
  assert.equal(snapshotFormatProblem(snapshot, adapter), false);
  assert.equal(snapshotAuthorityBindingProblem(snapshot, { roomId: id(1), code: '234567' }), false);
  for (const version of [1, 8, 9, 10, 11, 13]) assert.equal(snapshotFormatProblem({ ...snapshot, schemaVersion: version }, adapter), true);
  for (const type of defaultGameRegistry.knownTypes().filter(type => type !== 'hyakki-trading')) {
    assert.equal(snapshotFormatProblem({ ...snapshot, gameType: type }, adapter), true);
    assert.equal(snapshotFormatProblem(snapshot, defaultGameRegistry.gameAdapter(type)), true);
  }
  const noClock = { ...snapshot }; delete noClock.turnClock;
  assert.equal(snapshotFormatProblem(noClock, adapter), true);
  assert.equal(snapshotFormatProblem({ ...snapshot, spectators: null }, adapter), true);
  assert.equal(snapshotAuthorityBindingProblem({ ...snapshot, roomId: undefined }, { roomId: id(1), code: '234567' }), true);
  assert.equal(snapshotAuthorityBindingProblem(snapshot, { roomId: id(2), code: '234567' }), true);
});

test('signed sixteen-scope artifacts restore unchanged and explicitly lack hyakki events', async t => {
  const f = fixture(t), userKey = 'a'.repeat(64), artifact = join(f.directory, 'old-sixteen.sqlite'), restoredPath = join(f.directory, 'restored.sqlite');
  await f.storage.put('game-profiles', userKey, { userKey, nickname: '旧局资料' });
  await f.storage.put('sessions', 'old-session', { token: 'synthetic-private-token' }, 20000);
  await f.storage.put('room-presence', id(1), { lease: 'synthetic-old-device' }, 20000);
  const report = await backupStore({ sourcePath: f.sourcePath, destinationPath: artifact, key: f.key, now: f.now });
  assert.deepEqual(report.scopes, RECOVERY_SCOPES); assert.equal(report.excludedRecords, 2);
  const db = new DatabaseSync(artifact);
  try {
    const { signature, ...manifest } = JSON.parse(db.prepare('SELECT value FROM game_metadata WHERE name=?').get('backup-manifest').value);
    manifest.scopes = SCORE_RECOVERY_SCOPES;
    const signed = { ...manifest, signature: createHmac('sha256', f.key).update('game-room-backup:v1\0').update(JSON.stringify(manifest)).digest('hex') };
    db.prepare('UPDATE game_metadata SET value=? WHERE name=?').run(JSON.stringify(signed), 'backup-manifest');
  } finally { db.close(); }
  const verified = verifyBackup({ sourcePath: artifact, key: f.key });
  assert.equal(verified.scoresIncluded, true); assert.equal(verified.hyakkiEventsIncluded, false);
  assert.equal(verified.manifest.scopes.length, 16);
  const restored = restoreStore({ sourcePath: artifact, destinationPath: restoredPath, key: f.key, offline: true });
  assert.equal(restored.hyakkiEventsIncluded, false); assert.equal(restored.authSessionsRestored, false);
  const reopened = new EncryptedStore(new SQLiteAdapter(restoredPath, { now: f.now }), f.key, f.now);
  try {
    assert.equal((await reopened.get('game-profiles', userKey)).nickname, '旧局资料');
    assert.equal(await reopened.get('sessions', 'old-session'), null);
    assert.equal(await reopened.get('room-presence', id(1)), null);
  } finally { reopened.close(); }
});

test('schema12 and event scopes require a compatible rollback reader', () => {
  const current = structuredClone(CURRENT_DATA_COMPATIBILITY), old = structuredClone(current);
  old.roomSnapshots = { read: old.roomSnapshots.read.filter(version => version <= 11), write: old.roomSnapshots.write.filter(version => version <= 11) };
  old.backupScopes = { read: [...SCORE_RECOVERY_SCOPES], write: [...SCORE_RECOVERY_SCOPES] };
  const manifest = (letter, dataCompatibility) => ({ format: 1, project: 'game-room', releaseId: letter.repeat(20), containsSecrets: false, containsUserData: false, dataCompatibility });
  assert.equal(compareReleaseCompatibility(manifest('a', current), manifest('b', old)).rollbackCompatible, false);
  old.roomSnapshots.read = [...current.roomSnapshots.read];
  assert.equal(compareReleaseCompatibility(manifest('a', current), manifest('b', old)).rollbackCompatible, false);
  old.backupScopes.read = [...current.backupScopes.read];
  assert.equal(compareReleaseCompatibility(manifest('a', current), manifest('b', old)).rollbackCompatible, true);
});

function probeRegistry(creationAllowed) {
  const adapters = [...defaultGameRegistry.knownTypes().filter(type => type !== 'hyakki-trading').map(type => defaultGameRegistry.gameAdapter(type)), createHyakkiContractAdapter()];
  return createGameRegistry(adapters, { creationTypes: [...defaultGameRegistry.creationTypes(), ...(creationAllowed ? ['hyakki-trading'] : [])] });
}
async function activeProbe(t, actionType) {
  const f = fixture(t), users = ['b'.repeat(64), 'c'.repeat(64)], gameRegistry = probeRegistry(true);
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' });
  const runtime = createRuntime(settings, { storage: f.storage, sessions: {}, now: f.now, gameRegistry,
    roomOptions: { pollIntervalMs: 0, serverRandomInt: max => max - 1, transitionPreparers: createHyakkiContractPreparers(f.storage, { now: f.now }) },
    chatOptions: { pollIntervalMs: 0 } });
  const streams = []; let sequence = 0;
  async function close() { runtime.preview.close(); await runtime.chat.close(); for (const stream of streams) await stream(); await runtime.rooms.close(); }
  try {
    const host = await runtime.rooms.createRoom(users[0], '合同甲', 'compat-create', 'hyakki-trading');
    await runtime.rooms.joinRoom(host.roomCode, users[1], '合同乙', 'compat-join');
    for (const user of users) streams.push(await runtime.rooms.subscribe(host.roomCode, user, () => {}, () => {}));
    async function action(user, type, extra = {}) {
      const current = await runtime.rooms.getView(host.roomCode, user);
      const result = await runtime.rooms.action(host.roomCode, user, { type, requestId: `compat-${++sequence}`, expectedRevision: current.revision, ...extra });
      assert.equal(result.error, undefined); return result;
    }
    for (const user of users) await action(user, 'ready', { ready: true });
    await action(users[0], 'start');
    await action(users[0], actionType);
    const snapshot = (await f.storage.read('rooms', host.view.roomId)).value.snapshot;
    return { ...f, users, runtime, gameRegistry, host, snapshot, close };
  } catch (error) { await close(); throw error; }
}

for (const actionType of ['probe-peek', 'probe-response']) test(`414-enabled runtime restores ${actionType} on a fresh process with hyakki creation closed`, async t => {
  const f = await activeProbe(t, actionType);
  try {
    await f.storage.put('sessions', 'excluded-cookie', { token: 'synthetic-secret' }, 20000);
    const artifact = join(f.directory, 'business.sqlite'), restored = join(f.directory, 'restored.sqlite'), keyPath = join(f.directory, 'key');
    await backupStore({ sourcePath: f.sourcePath, destinationPath: artifact, key: f.key, now: f.now, gameRegistry: f.gameRegistry });
    const readRegistry = probeRegistry(false);
    assert.equal(verifyBackup({ sourcePath: artifact, key: f.key, gameRegistry: readRegistry }).hyakkiEventsIncluded, true);
    const restore = restoreStore({ sourcePath: artifact, destinationPath: restored, key: f.key, offline: true, gameRegistry: readRegistry });
    assert.equal(restore.hyakkiEventsIncluded, true); assert.equal(restore.authSessionsRestored, false);
    writeFileSync(keyPath, f.key, { mode: 0o600 });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
      import { EncryptedStore, SQLiteAdapter } from './server/storage.mjs';
      import { readSettings } from './server/config.mjs'; import { createRuntime } from './server/runtime.mjs';
      import { closeRuntime } from './server/production.mjs';
      import { createGameRegistry, defaultGameRegistry } from './app/game-registry.mjs';
      import { createHyakkiContractAdapter, createHyakkiContractPreparers } from './app/games/hyakki-trading/test-support/contract-adapter.mjs';
      const [path, keyPath, snapshotText, usersText] = process.argv.slice(1), before = JSON.parse(snapshotText), users = JSON.parse(usersText);
      const now = () => 10001, storage = new EncryptedStore(new SQLiteAdapter(path, { now }), readFileSync(keyPath), now);
      const registry = createGameRegistry([...defaultGameRegistry.knownTypes().filter(type => type !== 'hyakki-trading').map(type => defaultGameRegistry.gameAdapter(type)), createHyakkiContractAdapter()],
        { creationTypes: defaultGameRegistry.creationTypes() });
      const runtime = createRuntime(readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_POKER414_ENABLED: '1' }), { storage, sessions: {}, now, gameRegistry: registry,
        roomOptions: { pollIntervalMs: 0, transitionPreparers: createHyakkiContractPreparers(storage, { now }) }, chatOptions: { pollIntervalMs: 0 } });
      try {
        await runtime.rooms.ready;
        assert.equal(runtime.poker414Enabled, true);
        assert.equal(runtime.gameRegistry.creationTypes().includes('hyakki-trading'), false);
        assert.equal(runtime.gameRegistry.knownTypes().includes('hyakki-trading'), true);
        await assert.rejects(runtime.rooms.createRoom(users[0], '禁止新建', 'compat-denied', 'hyakki-trading'), error => error.code === 'INVALID_GAME_TYPE');
        const view = await runtime.rooms.getView(before.code, users[0]), after = (await storage.read('rooms', before.roomId)).value.snapshot;
        assert.deepEqual(after.game.pending, before.game.pending);
        assert.deepEqual(after.game.players, before.game.players);
        assert.deepEqual(after.game.deck, before.game.deck);
        assert.equal(after.matchId, before.matchId); assert.deepEqual(after.matchParticipants, before.matchParticipants);
        assert.equal(view.gameType, 'hyakki-trading');
        assert.equal(await storage.get('sessions', 'excluded-cookie'), null);
        assert.equal((await storage.scan('room-presence')).length, 0);
        assert.equal((await storage.scan('hyakki-events')).length, after.game.publicEventSequence);
        console.log(JSON.stringify({ recovered: true, poker414Enabled: true, creationClosed: true, pendingPreserved: true, schema: after.schemaVersion }));
      } finally { await closeRuntime(runtime); }
    `, restored, keyPath, JSON.stringify(f.snapshot), JSON.stringify(f.users)], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { recovered: true, poker414Enabled: true, creationClosed: true, pendingPreserved: true, schema: 12 });
  } finally { await f.close(); }
});

test('backup refuses a missing event group or changed record identity before publishing', async t => {
  const f = await activeProbe(t, 'probe-peek');
  try {
    const groupId = `${f.snapshot.matchId}:1`, saved = await f.storage.read(HYAKKI_EVENT_SCOPES.events, groupId);
    await f.storage.remove(HYAKKI_EVENT_SCOPES.events, groupId, saved.version);
    const artifact = join(f.directory, 'missing-group.sqlite');
    await assert.rejects(backupStore({ sourcePath: f.sourcePath, destinationPath: artifact, key: f.key, now: f.now, gameRegistry: f.gameRegistry }), error => error.code === 'GAME_HISTORY_CORRUPT');
    assert.equal(existsSync(artifact), false);
    await f.storage.put(HYAKKI_EVENT_SCOPES.events, `${f.snapshot.matchId}:999`, saved.value, saved.expiresAt);
    await assert.rejects(backupStore({ sourcePath: f.sourcePath, destinationPath: artifact, key: f.key, now: f.now, gameRegistry: f.gameRegistry }), /identity or retention mismatch/);
    assert.equal(existsSync(artifact), false);
  } finally { await f.close(); }
});
