import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDeck, validateMeld, normalizeMeld, evaluateDraft } from './rules.mjs';
import { createGame, gameProblem } from './multiplayer-rules.mjs';
import { sortPlayableRack } from './rummikub-assist.mjs';
import { createRoomStore } from './rooms.mjs';
import { createRoomPreview } from '../server/room-preview.mjs';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
import { backupStore, restoreStore, verifyLiveStore } from '../server/backup.mjs';
import { CURRENT_DATA_COMPATIBILITY, compareReleaseCompatibility } from '../scripts/release-compatibility.mjs';

const jokerConfig = { normal: 2, mirror: 1, colorChange: 2, double: 2 };
const deck = createDeck({ jokerConfig }), lookup = new Map(deck.map(tile => [tile.id, tile]));
const tiles = ids => ids.map(id => { assert.ok(lookup.has(id), id); return structuredClone(lookup.get(id)); });
const options = ruleVersion => ({ copies: 2, jokerConfig, ruleVersion });
const change = 'joker-color-change-1', change2 = 'joker-color-change-2';
const users = ['a'.repeat(64), 'b'.repeat(64)];

function room({ version, clock = 60000, rack = ['red-9-a', change, 'blue-11-a', 'black-13-a'], opened = true } = {}) {
  const store = createRoomStore({ now: () => 100000, turnTimeoutMs: clock,
    gameOptions: { firstTurnIndex: 0, randomInt: max => max - 1, ...(version ? { ruleVersion: version } : {}) } });
  const host = store.createTrustedRoom(users[0], '甲', { code: '123456', roomId: 'c'.repeat(32) });
  store.joinTrustedRoom(host.roomCode, users[1], '乙'); let serial = 0;
  const act = (index, type, fields = {}) => store.trustedAction(host.roomCode, users[index], { type,
    requestId: `color-v5-${++serial}`, expectedRevision: store.getTrustedView(host.roomCode, users[index]).revision, ...fields });
  act(0, 'configure', { jokerConfig }); act(0, 'ready', { ready: true }); act(1, 'ready', { ready: true }); act(0, 'start');
  const snapshot = store.exportSnapshot(host.roomCode), game = snapshot.game;
  game.players[0].rack = tiles(rack); game.players[0].opened = opened;
  game.players[1].rack = tiles(['black-1-a', 'black-2-a']); game.players[1].opened = true;
  const used = new Set(game.players.flatMap(player => player.rack).map(tile => tile.id));
  game.pool = deck.filter(tile => !used.has(tile.id)); assert.equal(gameProblem(game), null);
  store.importSnapshot(snapshot);
  return { store, host, act, view: () => store.getTrustedView(host.roomCode, users[0]) };
}

test('v5 rejects both colour-change endpoints and absent or identical colour anchors; old v3/v4 stay frozen', () => {
  for (const ids of [['red-1-a', 'red-2-a', change], [change, 'red-12-a', 'red-13-a']]) {
    for (const version of ['friends-v3', 'friends-v4']) assert.equal(validateMeld(tiles(ids), options(version)).valid, true);
    assert.equal(validateMeld(tiles(ids), options('friends-v5')).valid, false);
  }
  for (const ids of [['red-1-a', change, 'red-3-a'], ['red-1-a', change, change2, 'blue-4-a'],
    ['joker-normal-1', change, 'blue-3-a'], ['red-1-a', change, 'joker-double-1']]) {
    const result = validateMeld(tiles(ids), options('friends-v5'));
    assert.equal(result.valid, false, ids.join(' ')); assert.match(result.reason, /夹在.*不同颜色/);
  }
});

test('v5 accepts every distinct colour pair at 1 and 13, gaps filled by other jokers, and repeated changes back', () => {
  for (const a of ['red', 'blue', 'black', 'orange']) for (const b of ['red', 'blue', 'black', 'orange']) {
    for (const start of [1, 11]) {
      const result = validateMeld(tiles([`${a}-${start}-a`, change, `${b}-${start + 2}-a`]), options('friends-v5'));
      assert.equal(result.valid, a !== b); if (result.valid) assert.equal(result.points, start * 3 + 3);
    }
  }
  for (const [ids, points] of [
    [['red-1-a', change, 'joker-normal-1', 'blue-4-a'], 10],
    [['red-1-a', 'joker-double-1', change, 'blue-5-a'], 15],
    [['red-1-a', change, 'blue-3-a', change2, 'red-5-a'], 15],
  ]) {
    const input = tiles(ids), before = structuredClone(input);
    for (let round = 0; round < 3; round++) {
      const normalized = normalizeMeld(input, options('friends-v5'));
      assert.deepEqual(new Set(normalized.map(tile => tile.id)), new Set(ids));
      assert.equal(validateMeld(normalized, options('friends-v5')).points, points);
    }
    assert.deepEqual(input, before);
  }
});

test('mirror arms require numeric colours on both sides of each change, preserving v4 mirror scoring', () => {
  const good = ['blue-1-a', change, 'red-3-a', 'joker-mirror-1', 'red-3-b', change2, 'blue-1-b'];
  for (const version of ['friends-v4', 'friends-v5']) assert.equal(validateMeld(tiles(good), options(version)).points, 15);
  for (const ids of [[change, 'red-2-a', 'red-3-a', 'joker-mirror-1', 'red-3-b', 'red-2-b', change2],
    ['red-1-a', 'red-2-a', change, 'joker-mirror-1', change2, 'red-2-b', 'red-1-b']]) {
    assert.equal(validateMeld(tiles(ids), options('friends-v4')).valid, true);
    assert.equal(validateMeld(tiles(ids), options('friends-v5')).valid, false);
  }
  for (const ids of [['red-10-a', 'blue-10-a', 'joker-normal-1'], ['red-2-a', 'joker-double-1', 'red-5-a'],
    ['red-13-a', 'joker-mirror-1', 'red-13-b']]) {
    assert.deepEqual(validateMeld(tiles(ids), options('friends-v5')), validateMeld(tiles(ids), options('friends-v4')));
  }
});

test('sorting and draft commit share v5 legality and conserve every physical tile', () => {
  for (const ids of [['red-1-a', 'red-2-a', change], ['red-1-a', change, 'blue-3-a']]) {
    const rack = tiles([...ids, 'black-13-a']), before = structuredClone(rack);
    const result = sortPlayableRack(rack, { ...options('friends-v5'), opened: true });
    assert.deepEqual(rack, before); assert.deepEqual(result.orderIds.toSorted(), rack.map(tile => tile.id).toSorted());
    assert.equal(result.melds.length, ids[1] === change ? 1 : 0);
    const used = new Set(rack.map(tile => tile.id));
    const committed = { version: 1, ruleVersion: 'friends-v5', jokerConfig, rack, board: [],
      pool: deck.filter(tile => !used.has(tile.id)), opened: true, round: 1 };
    const draft = { ...committed, rack: tiles(['black-13-a']), board: [tiles(ids)] };
    assert.equal(evaluateDraft(committed, draft, options('friends-v5')).valid, ids[1] === change);
  }
});

test('new rooms use v5; real public preview and authoritative submission agree without consuming an invalid draft', t => {
  for (const [ids, valid, opened] of [
    [['red-1-a', 'red-2-a', change], false, true],
    [['red-1-a', change, 'blue-3-a'], true, true],
    [['red-1-a', change, 'blue-3-a'], false, false], // Still below the unchanged 30-point opening.
    [['red-9-a', change, 'blue-11-a'], true, false],
  ]) {
    const f = room({ rack: [...ids, 'black-13-a'], opened }); t.after(() => f.store.close());
    const view = f.view(), before = f.store.exportSnapshot('123456'); assert.equal(view.game.ruleVersion, 'friends-v5');
    const channel = createRoomPreview({ now: () => 100000 }); t.after(() => channel.close());
    const prepared = channel.prepare(view, { previewId: 'color_change_source_1', sequence: 1,
      matchId: view.matchId, gameRevision: view.game.revision, boardIds: [ids], positions: [{ x: .1, y: .1 }] }, 'synthetic-session');
    assert.equal(prepared.preview.valid, valid); assert.equal(JSON.stringify(prepared.preview).includes('black-13-a'), false);
    const submit = () => f.act(0, 'submit', { boardIds: [ids], rackIds: ['black-13-a'] });
    if (valid) {
      submit(); const after = f.store.exportSnapshot('123456');
      assert.equal(after.game.players[0].opened, true); assert.deepEqual(after.game.players[1].rack, before.game.players[1].rack);
      assert.deepEqual(after.game.pool, before.game.pool);
    } else {
      assert.throws(submit); const after = f.store.exportSnapshot('123456');
      assert.deepEqual(after.game, before.game); assert.deepEqual(after.turnClock, before.turnClock); assert.equal(after.revision, before.revision);
    }
  }
  assert.equal(createGame([{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }], { firstTurnIndex: 0 }).ruleVersion, 'friends-v2');
});

test('v5 schema20 binds rules, game type and room authority for clockless, timed and paused recovery', t => {
  for (const clock of [0, 60000]) {
    const f = room({ clock }); t.after(() => f.store.close()); const saved = f.store.exportSnapshot('123456');
    assert.equal(saved.schemaVersion, 20); assert.equal(Object.hasOwn(saved, 'turnClock'), clock > 0);
    const restored = createRoomStore({ now: () => 100000 }); t.after(() => restored.close());
    restored.importSnapshot(saved); assert.deepEqual(restored.exportSnapshot('123456'), saved);
    for (const schemaVersion of [1, 2, 4, 7, 8, 17]) {
      const bad = structuredClone(saved); bad.schemaVersion = schemaVersion;
      assert.throws(() => restored.importSnapshot(bad), error => error.code === 'INVALID_SNAPSHOT');
    }
    for (const update of [{ gameType: 'army-flip' }, { game: { ...saved.game, ruleVersion: 'friends-v4' } }]) {
      assert.throws(() => restored.importSnapshot({ ...saved, ...update }), error => error.code === 'INVALID_SNAPSHOT');
    }
    assert.deepEqual(restored.exportSnapshot('123456'), saved);
    if (clock) { f.act(0, 'pause'); f.act(1, 'pause'); const paused = f.store.exportSnapshot('123456');
      restored.importSnapshot(paused); assert.deepEqual(restored.exportSnapshot('123456'), paused); }
  }
  const current = structuredClone(CURRENT_DATA_COMPATIBILITY), prior = structuredClone(current);
  for (const field of ['read', 'write']) prior.roomSnapshots[field] = prior.roomSnapshots[field].filter(value => value !== 20);
  const manifest = (id, dataCompatibility) => ({ format: 1, project: 'game-room', releaseId: id.repeat(20), containsSecrets: false, containsUserData: false, dataCompatibility });
  const result = compareReleaseCompatibility(manifest('a', current), manifest('b', prior));
  assert.equal(result.rollbackCompatible, false); assert.equal(result.forwardCompatible, true);
});

test('real SQLite backup, independent process restart and once-only history retain v5 and schema20', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rummikub-v5-')), path = join(directory, 'live.sqlite'), key = randomBytes(32);
  let live;
  t.after(async () => { if (live) { await live.rooms.close(); live.storage.close(); } await rm(directory, { recursive: true, force: true }); });
  const seed = room({ rack: ['red-9-a', change, 'blue-11-a'], opened: false });
  const snapshot = seed.store.exportSnapshot('123456'), seat = seed.host.playerId; seed.store.close();
  const storage = new EncryptedStore(new SQLiteAdapter(path, { now: () => 100000 }), key, () => 100000);
  const history = createMatchHistory({ storage, now: () => 100000 });
  const rooms = createDurableRoomStore({ storage, now: () => 100000, pollIntervalMs: 0 }); rooms.setHistory(history); live = { storage, rooms };
  await storage.putIfAbsent('rooms', snapshot.roomId, { snapshot }, Number.MAX_SAFE_INTEGER);
  await storage.putIfAbsent('room-invites', '123456', { roomId: snapshot.roomId }, Number.MAX_SAFE_INTEGER);
  const view = await rooms.getView('123456', users[0]);
  await rooms.action('123456', users[0], { type: 'submit', requestId: 'v5-terminal', expectedRevision: view.revision,
    boardIds: [['red-9-a', change, 'blue-11-a']], rackIds: [] });
  await rooms.flushPendingRecords(); assert.equal((await history.get(users[0])).stats.wins, 1);
  assert.doesNotThrow(() => verifyLiveStore({ sourcePath: path, key }));
  const backup = join(directory, 'backup.sqlite'), restored = join(directory, 'restored.sqlite');
  await backupStore({ sourcePath: path, destinationPath: backup, key, now: () => 100000 });
  restoreStore({ sourcePath: backup, destinationPath: restored, key, offline: true });
  await rooms.close(); storage.close(); live = null;
  const child = `
    import { EncryptedStore, SQLiteAdapter } from './server/storage.mjs';
    import { createDurableRoomStore } from './server/durable-rooms.mjs';
    import { createMatchHistory } from './server/match-history.mjs';
    const storage = new EncryptedStore(new SQLiteAdapter(process.env.V5_PATH,{now:()=>100000}),Buffer.from(process.env.V5_KEY,'hex'),()=>100000);
    const rooms = createDurableRoomStore({storage,now:()=>100000,pollIntervalMs:0});
    const history = createMatchHistory({storage,now:()=>100000}); rooms.setHistory(history);
    try { const view = await rooms.getView('123456','${users[0]}'); await rooms.flushPendingRecords(); await rooms.flushPendingRecords();
      const saved = (await storage.read('rooms','${snapshot.roomId}')).value.snapshot;
      console.log(JSON.stringify({seat:view.selfId,version:view.game.ruleVersion,phase:view.phase,schema:saved.schemaVersion,
        board:view.game.board.map(group=>group.map(tile=>tile.id)),history:await history.get('${users[0]}'),records:(await storage.scan('game-history')).length}));
    } finally { await rooms.close(); storage.close(); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', child],
    { cwd: new URL('..', import.meta.url), env: { ...process.env, V5_PATH: restored, V5_KEY: key.toString('hex') } });
  const result = JSON.parse(stdout); assert.equal(result.seat, seat); assert.equal(result.version, 'friends-v5');
  assert.equal(result.schema, 20); assert.equal(result.phase, 'finished'); assert.deepEqual(result.board, [['red-9-a', change, 'blue-11-a']]);
  assert.equal(result.history.stats.wins, 1); assert.equal(result.history.items[0].ruleVersion, 'friends-v5'); assert.equal(result.records, 1);
});
