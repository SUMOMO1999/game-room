import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Every domain import below resolves inside the extracted release, never the
// working tree. This worker is test-only and excluded from runtime packaging.
const [packageRoot, directory, operation] = process.argv.slice(2);
const load = file => import(pathToFileURL(join(packageRoot, file)).href);
const { EncryptedStore, SQLiteAdapter, identityKey } = await load('server/storage.mjs');
const { createDurableRoomStore } = await load('server/durable-rooms.mjs');
const { createGameRegistry, defaultGameRegistry } = await load('app/game-registry.mjs');
const { createMatchHistory } = await load('server/match-history.mjs');
const { createGameScores, SCORE_SCOPES } = await load('server/game-scores.mjs');
const { backupStore, verifyLiveStore } = await load('server/backup.mjs');
const seedPath = join(directory, 'seed.json'), keyPath = join(directory, 'synthetic.key');
const users = [0, 1, 2].map(index => identityKey('urn:414-package-recovery', String(index)));
const seed = operation === 'seed' ? { time: Date.now() } : JSON.parse(readFileSync(seedPath, 'utf8'));
const key = operation === 'seed' ? randomBytes(32) : Buffer.from(readFileSync(keyPath, 'utf8'), 'base64url');
if (operation === 'seed') writeFileSync(keyPath, key.toString('base64url'), { mode: 0o600 });
const path = join(directory, operation === 'seed' ? 'source.sqlite' : 'restored.sqlite');
const now = () => seed.time;
const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
const gameRegistry = operation === 'seed'
  ? createGameRegistry([...defaultGameRegistry.creationTypes(), 'poker414-2'].map(defaultGameRegistry.gameAdapter))
  : defaultGameRegistry;
const rooms = createDurableRoomStore({ storage, now, pollIntervalMs: 0, gameRegistry, serverRandomInt: () => 0 });
const history = createMatchHistory({ storage, now, gameRegistry });
rooms.setHistory(history);
const scores = createGameScores({ storage, now });
let sequence = 0;
async function action(code, user, type, extra = {}) {
  const view = await rooms.getView(code, user);
  return rooms.action(code, user, { type, requestId: `${operation}-${++sequence}`, expectedRevision: view.revision,
    ...(['play', 'pass'].includes(type) ? { matchId: view.game.matchId, roundId: view.game.roundId, targetId: view.game.target?.id ?? null } : {}), ...extra });
}
const snapshot = async room => (await storage.read('rooms', room.view.roomId)).value.snapshot;
const ledgers = async () => (await storage.scan(SCORE_SCOPES.ledger)).map(record => record.value);
const totals = async () => (await Promise.all(users.map(user => scores.readBalance(user)))).map(value => value.total);
async function start(gameType = 'poker414-2', deal = true) {
  const host = await rooms.createRoom(users[0], '恢复甲', `create-${++sequence}`, gameType);
  const count = gameType === 'poker414-2' ? 3 : 2;
  for (let index = 1; index < count; index++) await rooms.joinRoom(host.roomCode, users[index], `恢复${index}`, `join-${++sequence}`);
  for (const user of users.slice(0, count)) await action(host.roomCode, user, 'ready', { ready: true });
  await action(host.roomCode, users[0], 'start');
  if (gameType === 'poker414-2' && deal) { seed.time += 3000; await rooms.sweep(); }
  return host;
}
try {
  await rooms.ready;
  if (operation === 'seed') {
    const completed = await start();
    for (let count = 0; count < 324 && (await snapshot(completed)).phase === 'playing'; count++) {
      const state = await snapshot(completed), actor = state.matchParticipants.find(player => player.playerId === state.game.turnPlayerId);
      await action(completed.roomCode, actor.userKey, state.game.target ? 'pass' : 'play', state.game.target ? {} : {
        cardIds: [state.game.players.find(player => player.id === actor.playerId).hand[0]],
      });
    }
    assert.equal((await snapshot(completed)).phase, 'finished');
    const penalty = await start();
    await action(penalty.roomCode, users[1], 'leave');
    const response = await start(), before = await snapshot(response);
    const actor = before.matchParticipants.find(player => player.playerId === before.game.turnPlayerId);
    await action(response.roomCode, actor.userKey, 'play', {
      cardIds: [before.game.players.find(player => player.id === actor.playerId).hand[0]],
    });
    const dealing = await start('poker414-2', false), legacy = await start('rummikub');
    await rooms.flushPendingRecords();
    seed.active = await Promise.all([response, dealing].map(async room => ({ room, snapshot: await snapshot(room) })));
    assert.equal(seed.active[0].snapshot.game.stage, 'playing');
    assert.equal(seed.active[0].snapshot.turnClock.kind, 'response');
    assert.equal(seed.active[1].snapshot.game.stage, 'dealing');
    seed.legacy = { room: legacy, snapshot: await snapshot(legacy) };
    seed.completed = { room: completed, snapshot: await snapshot(completed) };
    seed.ledger = await ledgers(); seed.totals = await totals();
    assert.equal(seed.ledger.length, 2);
    assert.deepEqual(new Set(seed.ledger.map(entry => entry.reason)), new Set(['emptied-hand', 'voluntary-leave']));
    for (const scope of ['sessions', 'transactions', 'room-presence']) await storage.put(scope, 'synthetic-ephemeral', { excluded: true }, seed.time + 60000);
    writeFileSync(seedPath, JSON.stringify(seed), { mode: 0o600 });
    const backup = await backupStore({ sourcePath: path, destinationPath: join(directory, 'business-backup.sqlite'), key, now });
    assert.equal(backup.scopes.length, 16); assert.ok(backup.excludedRecords >= 3);
    console.log(JSON.stringify({ phase: operation, completedLedgers: seed.ledger.length, activeRooms: seed.active.length,
      totals: seed.totals, scopes: backup.scopes.length, excludedEphemeralRecords: backup.excludedRecords }));
  } else {
    assert.deepEqual(defaultGameRegistry.creationTypes(), ['rummikub', 'army-flip', 'flying-chess', 'draw-and-guess']);
    assert.equal(defaultGameRegistry.gameAdapter('poker414-2').snapshotSchema(), 11);
    for (const entry of seed.active) {
      const view = await rooms.getView(entry.room.roomCode, users[0]);
      assert.equal(view.phase, 'waiting'); assert.equal(view.game, null);
      assert.equal(view.lastMatchResult.reason, 'server-recovery');
      assert.equal(view.lastMatchResult.matchId, entry.snapshot.matchId);
      assert.deepEqual(view.players.map(player => player.id), entry.snapshot.players.map(player => player.id));
      for (const user of users) await action(entry.room.roomCode, user, 'ready', { ready: true });
      await assert.rejects(action(entry.room.roomCode, users[0], 'start'), { code: 'INVALID_GAME_TYPE' });
    }
    await assert.rejects(rooms.createRoom(users[0], '不可新开', `${operation}-disabled`, 'poker414-2'), { code: 'INVALID_GAME_TYPE' });
    assert.deepEqual((await snapshot(seed.legacy.room)).game, seed.legacy.snapshot.game);
    assert.deepEqual((await snapshot(seed.legacy.room)).players.map(player => player.id), seed.legacy.snapshot.players.map(player => player.id));
    assert.deepEqual((await snapshot(seed.completed.room)).game, seed.completed.snapshot.game);
    assert.deepEqual(await totals(), seed.totals);
    const current = await ledgers(); assert.equal(current.length, 4);
    for (const prior of seed.ledger) assert.deepEqual(current.find(row => row.matchId === prior.matchId), prior);
    for (const cancelled of current.filter(row => row.reason === 'server-recovery')) assert.ok(cancelled.deltas.every(entry => entry.delta === 0));
    for (const scope of ['sessions', 'transactions', 'room-presence']) assert.equal((await storage.scan(scope)).length, 0);
    await rooms.flushPendingRecords();
    for (let index = 0; index < users.length; index++) {
      const archived = await history.get(users[index]);
      assert.equal(archived.items.length, 4);
      assert.equal(archived.items.reduce((sum, item) => sum + item.self.score, 0), seed.totals[index]);
    }
    verifyLiveStore({ sourcePath: path, key, now });
    const backup = await backupStore({ sourcePath: path, destinationPath: join(directory, `${operation}-backup.sqlite`), key, now });
    console.log(JSON.stringify({ phase: operation, newGamesDisabled: true, cancelledOnce: 2, retainedLedgers: 2,
      ledgerCount: current.length, totals: await totals(), scopes: backup.scopes.length,
      legacyGamePreserved: true, noAuthRestored: true }));
  }
} finally { await rooms.close(); storage.close(); }
