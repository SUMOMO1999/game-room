import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createGameScores, SCORE_SCOPES, SCORE_FOREVER } from '../server/game-scores.mjs';
import { createRoomStore } from './rooms.mjs';
import { createGameRegistry } from './game-registry.mjs';
import { createPoker414Adapter } from '../server/games/poker414-2/adapter.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
import { backupStore, verifyBackup, verifyLiveStore, restoreStore, RECOVERY_SCOPES } from '../server/backup.mjs';

const gameRegistry = createGameRegistry([createPoker414Adapter()]);
const id = number => number.toString(16).padStart(32, '0');
const users = [0, 1, 2].map(index => identityKey('urn:synthetic-414-recovery', String(index)));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'poker414-recovery-')), sourcePath = join(directory, 'source.sqlite');
  const key = randomBytes(32), now = () => 10000;
  const storage = new EncryptedStore(new SQLiteAdapter(sourcePath, { now }), key, now);
  const scores = createGameScores({ storage, now });
  t.after(() => { storage.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, sourcePath, key, now, storage, scores,
    backup: file => backupStore({ sourcePath, destinationPath: join(directory, file), key, now, gameRegistry }) };
}
const descriptor = () => ({ matchId: id(1), roomId: id(2), game: 'poker414-2', ruleVersion: 'poker414-2-v2',
  scoringVersion: 'poker414-2-score-v1', startedAt: 1000,
  participants: users.map((userKey, index) => ({ userKey, seatId: id(index + 10) })) });
async function commit(storage, plan, changes = []) {
  assert.equal(await storage.compareAndSwapMany({ changes: [...changes, ...plan.changes], guards: plan.guards }), true);
}
async function settle(f) {
  const opening = descriptor(); await commit(f.storage, await f.scores.prepareReservation(opening));
  const input = { ...opening, settlementVersion: 0, endedAt: 10000, status: 'completed', reason: 'emptied-hand',
    deltas: users.map((userKey, index) => ({ userKey, delta: [11, -5, -6][index] })) };
  delete input.startedAt;
  const plan = await f.scores.prepareSettlement(input); await commit(f.storage, plan);
  const summary = { matchId: input.matchId, roomId: input.roomId, roomCode: '234567', game: input.game,
    ruleVersion: input.ruleVersion, scoringVersion: input.scoringVersion, accountGroup: '4a4', settlementVersion: 0,
    startedAt: 1000, endedAt: input.endedAt, status: input.status, reason: input.reason, deltas: input.deltas,
    players: input.participants.map((player, index) => ({ ...player, nickname: `恢复伙伴${index}`,
      outcome: index === 0 ? 'win' : 'loss', score: input.deltas[index].delta, balanceAfter: plan.projection.balancesAfter[index].total })) };
  await createMatchHistory({ storage: f.storage, now: f.now, gameRegistry }).archive(summary);
  return { input, summary };
}

test('sixteen-scope backup restores permanent scores on a new path and new process without restoring sessions', async t => {
  const f = fixture(t); await settle(f);
  await f.storage.put('sessions', 'excluded', { token: 'never-copy-this-session' }, 20000);
  const backupPath = join(f.directory, 'backup.sqlite'), restoredPath = join(f.directory, 'restored.sqlite');
  const captured = await f.backup('backup.sqlite');
  assert.deepEqual(captured.scopes, RECOVERY_SCOPES); assert.equal(captured.scopes.length, 16);
  assert.equal(captured.excludedRecords, 1);
  const verified = verifyBackup({ sourcePath: backupPath, key: f.key, gameRegistry });
  assert.equal(verified.scoresIncluded, true);
  assert.equal(restoreStore({ sourcePath: backupPath, destinationPath: restoredPath, key: f.key, offline: true, gameRegistry }).scoresIncluded, true);
  const bytes = readFileSync(backupPath);
  for (const secret of [...users, 'never-copy-this-session', '恢复伙伴']) assert.equal(bytes.includes(Buffer.from(secret)), false);
  const keyPath = join(f.directory, 'synthetic-key'); writeFileSync(keyPath, f.key, { mode: 0o600 });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { EncryptedStore, SQLiteAdapter } from ${JSON.stringify(new URL('../server/storage.mjs', import.meta.url).href)};
    import { createGameScores } from ${JSON.stringify(new URL('../server/game-scores.mjs', import.meta.url).href)};
    const store = new EncryptedStore(new SQLiteAdapter(process.argv[1]), readFileSync(process.argv[2]), () => 10000);
    const scores = createGameScores({storage:store,now:()=>10000});
    const values = await Promise.all(JSON.parse(process.argv[3]).map(key=>scores.readBalance(key)));
    console.log(JSON.stringify({totals:values.map(value=>value.total),sessions:(await store.scan('sessions')).length,
      forever:(await store.scan('game-score-ledger')).every(row=>row.expiresAt===Number.MAX_SAFE_INTEGER)}));
    store.close();`, restoredPath, keyPath, JSON.stringify(users)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { totals: [11, -5, -6], sessions: 0, forever: true });
  assert.throws(() => restoreStore({ sourcePath: backupPath, destinationPath: f.sourcePath, key: f.key, offline: true, gameRegistry }), /Destination already exists/);
});

test('backup rejects a missing room for a live score reservation, then accepts its real schema11 room', async t => {
  const f = fixture(t), rooms = createRoomStore({ now: f.now, gameRegistry, serverRandomInt: max => max - 1 });
  t.after(() => rooms.close());
  const host = rooms.createTrustedRoom(users[0], '甲', { code: '234567', roomId: id(40), gameType: 'poker414-2' });
  rooms.joinTrustedRoom(host.roomCode, users[1], '乙'); rooms.joinTrustedRoom(host.roomCode, users[2], '丙');
  let request = 0;
  for (const userKey of users) rooms.trustedAction(host.roomCode, userKey,
    { type: 'ready', ready: true, requestId: `recovery-${++request}`, expectedRevision: rooms.getTrustedView(host.roomCode, userKey).revision });
  rooms.trustedAction(host.roomCode, users[0], { type: 'start', requestId: `recovery-${++request}`,
    expectedRevision: rooms.getTrustedView(host.roomCode, users[0]).revision });
  const snapshot = rooms.exportSnapshot(host.roomCode);
  const input = { matchId: snapshot.matchId, roomId: snapshot.roomId, game: snapshot.gameType,
    ruleVersion: snapshot.game.ruleVersion, scoringVersion: snapshot.game.scoringVersion, startedAt: snapshot.matchStartedAt,
    participants: snapshot.matchParticipants.map(player => ({ userKey: player.userKey, seatId: player.playerId })) };
  await commit(f.storage, await f.scores.prepareReservation(input));
  await assert.rejects(f.backup('orphan.sqlite'), /Score recovery reference mismatch/);
  await f.storage.put('rooms', snapshot.roomId, { snapshot });
  await f.backup('active.sqlite');
  assert.doesNotThrow(() => verifyLiveStore({ sourcePath: f.sourcePath, key: f.key, now: f.now, gameRegistry }));
  const saved = await f.storage.read('rooms', snapshot.roomId);
  const changed = structuredClone(saved.value); changed.snapshot.matchParticipants[0].userKey = 'a'.repeat(64);
  // The room's own seat consistency guard rejects a changed account before a backup can publish.
  await f.storage.replaceCAS('rooms', snapshot.roomId, saved.version, changed);
  await assert.rejects(f.backup('wrong-owner.sqlite'));
});

test('permanent balances, expiry, quota and archived balance projections are checked before publishing', async t => {
  for (const defect of ['balance', 'expiry', 'quota', 'summary']) {
    const f = fixture(t); const { summary } = await settle(f);
    const scope = defect === 'quota' ? SCORE_SCOPES.meta : defect === 'summary' ? 'game-history' : SCORE_SCOPES.balances;
    const key = defect === 'quota' ? '4a4:quota' : defect === 'summary' ? summary.matchId : `4a4:${users[0]}`;
    const saved = await f.storage.read(scope, key), value = structuredClone(saved.value);
    if (defect === 'balance') value.total++;
    if (defect === 'quota') value.usedBytes++;
    if (defect === 'summary') value.summary.players[0].balanceAfter++;
    await f.storage.replaceCAS(scope, key, saved.version, value, defect === 'expiry' ? SCORE_FOREVER - 1 : saved.expiresAt);
    await assert.rejects(f.backup(`bad-${defect}.sqlite`));
  }
});

test('later score corrections retain the original archived balance while backups reconcile the new total', async t => {
  const f = fixture(t), { input } = await settle(f);
  const corrected = { ...input, settlementVersion: 1, expectedSettlementVersion: 0, correctionId: id(70),
    deltas: users.map((userKey, index) => ({ userKey, delta: [20, -8, -12][index] })) };
  await commit(f.storage, await f.scores.prepareCorrection(corrected));
  await f.backup('corrected.sqlite');
  assert.equal((await f.scores.readBalance(users[0])).total, 20);
  const history = createMatchHistory({ storage: f.storage, now: f.now, gameRegistry });
  assert.equal((await history.get(users[0])).items[0].self.balanceAfter, 11);
  assert.equal((await f.storage.scan(SCORE_SCOPES.ledger)).length, 2);
});
