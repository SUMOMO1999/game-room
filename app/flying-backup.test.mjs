import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
import { createRoomChat } from '../server/chat.mjs';
import { backupStore, verifyBackup, restoreStore, RECOVERY_SCOPES } from '../server/backup.mjs';
import { completeFirstPlayerScript } from './games/flying-chess/fixtures/full-game.mjs';

const users = Array.from({ length: 4 }, (_, index) => identityKey('urn:synthetic-flying-backup', `member-${index}`));

// Every file and encryption key belongs to this test's fresh temporary tree.
// Use the business backup protocol and real durable actions, not a copied DB or
// hand-built schema9/game/history record. No provider, network or production env.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'flying-business-backup-'));
  const key = randomBytes(32), sourcePath = join(directory, 'source.sqlite');
  const backupPath = join(directory, 'backup.sqlite'), restoredPath = join(directory, 'restored.sqlite');
  const opened = [], tape = [], randomCalls = [];
  let at = 100000, sequence = 0;
  const now = () => at, requestId = type => `flight-backup-${type}-${++sequence}`;
  const sourceRandom = maximum => {
    assert.ok(tape.length, 'each source random sample is explicitly declared');
    const value = tape.shift(); assert.ok(value >= 0 && value < maximum);
    randomCalls.push({ maximum, value }); return value;
  };
  function open(path, random = () => { throw new Error('a restored saved game must not sample dice or its first player'); }) {
    const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
    const rooms = createDurableRoomStore({ storage, now, pollIntervalMs: 0, turnTimeoutMs: 60000, serverRandomInt: random });
    const history = createMatchHistory({ storage, now });
    const chat = createRoomChat({ storage, rooms, now, pollIntervalMs: 0 });
    const entry = { storage, rooms, history, chat }; opened.push(entry); return entry;
  }
  t.after(async () => {
    for (const entry of opened) { await entry.chat.close(); await entry.rooms.close(); entry.storage.close(); }
    await rm(directory, { recursive: true, force: true });
  });
  const source = open(sourcePath, sourceRandom);
  const host = await source.rooms.createRoom(users[0], '备份甲', requestId('create'), 'flying-chess');
  for (let index = 1; index < 3; index++) await source.rooms.joinRoom(host.roomCode, users[index], `备份${index}`, requestId('join'));
  const observer = await source.rooms.joinRoom(host.roomCode, users[3], '备份观众', requestId('observe'), 'spectator');
  const snapshot = async (entry = source) => (await entry.storage.read('rooms', host.view.roomId)).value.snapshot;
  const body = async (entry, index, type, fields = {}) => ({ type, requestId: requestId(type),
    expectedRevision: (await entry.rooms.getView(host.roomCode, users[index])).revision, ...fields });
  const action = async (entry, index, type, fields = {}) => {
    const input = await body(entry, index, type, fields);
    const result = await entry.rooms.action(host.roomCode, users[index], input); return { input, result };
  };
  const start = async () => {
    for (let index = 0; index < 3; index++) await action(source, index, 'ready', { ready: true });
    tape.push(2); return action(source, 0, 'start');
  };
  const roll = async die => {
    const current = await snapshot(); tape.push(die - 1);
    return action(source, current.game.turnIndex, 'roll');
  };
  const backup = () => backupStore({ sourcePath, destinationPath: backupPath, key, now });
  const restore = () => {
    const report = restoreStore({ sourcePath: backupPath, destinationPath: restoredPath, key, offline: true });
    return { ...open(restoredPath), report };
  };
  return { directory, key, sourcePath, backupPath, restoredPath, source, host, observer, snapshot, body, action, start, roll,
    backup, restore, randomCalls, now, set: value => { at = value; }, advance: ms => { at += ms; } };
}

async function finish(f) {
  await f.start(); const initial = await f.snapshot();
  let finalMove;
  for (const step of completeFirstPlayerScript(initial.game.players.map(player => player.id), initial.game.firstPlayerIndex)) {
    assert.equal((await f.snapshot()).game.turnPlayerId, step.playerId);
    await f.roll(step.die); const current = await f.snapshot();
    if (current.game.stage === 'await-move') finalMove = await f.action(f.source, current.game.turnIndex, 'move', {
      rollId: current.game.rollId, planeId: `${current.game.players[current.game.turnIndex].side}-${step.number}`,
    });
  }
  return finalMove;
}

for (const phase of ['waiting', 'await-roll', 'await-move', 'paused', 'finished', 'aborted']) {
  test(`signed nine-scope business backup restores real flying ${phase}, original seats and exact saved state`, async t => {
    const f = await fixture(t); let replay;
    if (phase === 'finished') replay = await finish(f);
    else if (phase !== 'waiting') {
      await f.start();
      if (['await-move', 'paused', 'aborted'].includes(phase)) replay = await f.roll(6);
      if (phase === 'paused') {
        f.advance(15000);
        for (let index = 0; index < 3; index++) await f.action(f.source, index, 'pause');
      }
      if (phase === 'aborted') replay = await f.action(f.source, 0, 'leave');
    }
    const original = await f.snapshot(); assert.equal(original.schemaVersion, 9);
    assert.equal(original.phase, ['await-roll', 'await-move'].includes(phase) ? 'playing' : phase);
    if (original.game) assert.equal(original.game.stage, phase === 'paused' || phase === 'aborted' ? 'await-move' : phase);
    if (phase === 'finished') {
      // Archive the real result but retain its outbox, modelling a crash after
      // history committed and before the room acknowledgement was persisted.
      assert.equal(original.pendingRecords.length, 1);
      await f.source.history.archive(original.pendingRecords[0]);
    }
    const message = await f.source.chat.send(f.host.roomCode, users[3], { text: '合成飞行棋聊天', requestId: 'flight-chat-original' });
    await f.source.storage.put('sessions', 'fake-cookie', { token: 'excluded-flight-session' }, f.now() + 60000);
    await f.source.storage.put('transactions', 'fake-pkce', { verifier: 'excluded-flight-verifier' }, f.now() + 60000);
    await f.source.storage.put('room-presence', f.host.view.roomId, { online: true }, f.now() + 60000);
    const sourceRoom = await f.source.storage.read('rooms', f.host.view.roomId);
    const randomCount = f.randomCalls.length;
    const report = await f.backup();
    assert.deepEqual(report.scopes, RECOVERY_SCOPES); assert.equal(report.excludedRecords, 3); assert.equal(report.authSessionsIncluded, false);
    assert.equal((await stat(f.backupPath)).mode & 0o777, 0o600);
    const verified = verifyBackup({ sourcePath: f.backupPath, key: f.key });
    assert.equal(verified.chatIncluded, true); assert.equal(verified.historyIncluded, true);
    assert.ok(verified.rows.some(row => row.key.startsWith('rooms:')));
    const bytes = await readFile(f.backupPath);
    for (const text of [...users, '备份甲', '合成飞行棋聊天', 'excluded-flight-session', 'excluded-flight-verifier']) {
      assert.equal(bytes.includes(Buffer.from(text)), false, `${text} must be encrypted or excluded`);
    }
    const recovered = f.restore();
    assert.equal(recovered.report.authSessionsRestored, false);
    const restoredRoom = await recovered.storage.read('rooms', f.host.view.roomId);
    assert.equal(restoredRoom.version, sourceRoom.version); assert.equal(restoredRoom.expiresAt, sourceRoom.expiresAt);
    assert.deepEqual(restoredRoom.value, sourceRoom.value);
    for (const member of [...original.players, ...original.spectators]) {
      const view = await recovered.rooms.getView(f.host.roomCode, member.userKey);
      assert.equal(view.roomId, original.roomId); assert.equal(view.matchId, original.matchId ?? null); assert.equal(view.selfId, member.id);
      assert.equal(view.selfRole, original.spectators.some(observer => observer.id === member.id) ? 'spectator' : 'player');
      assert.deepEqual(view.turnClock, original.turnClock);
      const seats = await recovered.rooms.recentRooms(member.userKey);
      assert.ok(seats.some(seat => seat.roomCode === original.code && seat.playerId === member.id && seat.gameType === 'flying-chess'));
    }
    assert.equal((await recovered.chat.get(f.host.roomCode, users[3])).messages[0].messageId, message.message.messageId);
    const sameChat = await recovered.chat.send(f.host.roomCode, users[3], { text: '合成飞行棋聊天', requestId: 'flight-chat-original' });
    assert.equal(sameChat.duplicate, true); assert.equal(sameChat.message.chatSequence, message.message.chatSequence);
    for (const [scope, id] of [['sessions', 'fake-cookie'], ['transactions', 'fake-pkce'], ['room-presence', f.host.view.roomId]]) {
      assert.equal(await recovered.storage.read(scope, id), null);
    }
    if (replay) {
      const actor = phase === 'aborted' ? 0 : 2;
      const duplicate = await recovered.rooms.action(f.host.roomCode, users[actor], replay.input);
      assert.deepEqual((await f.snapshot(recovered)).game, original.game);
      assert.equal((await f.snapshot(recovered)).revision, original.revision);
      if (phase === 'aborted') assert.equal(duplicate.left, true);
      else assert.equal(duplicate.view.actionReceipts.find(receipt => receipt.requestId === replay.input.requestId)?.status, 'committed');
    }
    assert.equal(f.randomCalls.length, randomCount, 'verification, restored views and duplicate actions never reroll');
    assert.deepEqual((await f.snapshot()).game, original.game, 'recovery does not mutate the source game');
    if (phase === 'finished') {
      recovered.rooms.setHistory(recovered.history); await recovered.rooms.flushPendingRecords(); await recovered.rooms.flushPendingRecords();
      await recovered.history.archive(original.pendingRecords[0]);
      assert.equal((await recovered.storage.scan('game-history')).length, 1);
      assert.equal((await recovered.history.get(users[2])).stats.wins, 1);
      for (const loser of users.slice(0, 2)) assert.equal((await recovered.history.get(loser)).stats.losses, 1);
      assert.equal((await recovered.history.get(users[3])).stats.completed, 0);
      assert.deepEqual((await f.snapshot(recovered)).pendingRecords, []);
    }
    if (phase === 'aborted') {
      recovered.rooms.setHistory(recovered.history); await recovered.rooms.flushPendingRecords();
      assert.equal((await recovered.history.get(users[2])).stats.completed, 0);
      const history = await recovered.history.get(users[0]);
      assert.equal(history.items[0].status, 'aborted'); assert.equal(history.items[0].self.outcome, 'unscored');
    }
  });
}

test('restored paused pending die resumes its remaining whole turn and expiry discards that die exactly once', async t => {
  const f = await fixture(t); await f.start(); await f.roll(6);
  let pending = await f.snapshot();
  await f.action(f.source, 2, 'move', { rollId: pending.game.rollId, planeId: 'yellow-1' });
  await f.roll(5); f.advance(20000);
  for (let index = 0; index < 3; index++) await f.action(f.source, index, 'pause');
  const paused = await f.snapshot(); assert.equal(paused.turnClock.remainingMs, 40000);
  assert.equal(paused.game.stage, 'await-move'); assert.equal(paused.game.die, 5);
  await f.backup(); f.advance(500000); const recovered = f.restore();
  assert.deepEqual((await recovered.rooms.getView(f.host.roomCode, users[2])).turnClock, paused.turnClock);
  await f.action(recovered, 2, 'resume');
  const resumed = await f.snapshot(recovered);
  assert.equal(resumed.turnClock.deadlineAt, f.now() + 40000); assert.deepEqual(resumed.game, paused.game);
  f.set(resumed.turnClock.deadlineAt);
  await recovered.rooms.sweep(); const expired = await f.snapshot(recovered);
  await recovered.rooms.sweep(); const repeated = await f.snapshot(recovered);
  assert.deepEqual(repeated, expired); assert.equal(expired.game.lastAction.type, 'timeout');
  assert.equal(expired.game.stage, 'await-roll'); assert.equal(expired.game.die, null);
  assert.equal(expired.game.round, paused.game.round + 1); assert.equal(expired.game.revision, paused.game.revision + 1);
  assert.deepEqual(expired.game.planes, paused.game.planes, 'timeout never chooses or moves a saved pending plane');
  assert.equal(expired.game.turnIndex, 0); assert.equal(expired.turnClock.firstPlayerId, paused.turnClock.firstPlayerId);
  assert.equal((await recovered.history.get(users[2])).stats.completed, 0);
});

test('schema9 backup validates real authoritative state before publishing; rejected corrupt source keeps the healthy artifact usable', async t => {
  const f = await fixture(t); await f.start(); await f.roll(6); await f.backup();
  const original = await f.source.storage.read('rooms', f.host.view.roomId);
  const corrupt = structuredClone(original.value); corrupt.snapshot.game.planes[0].progress = 999;
  await f.source.storage.replaceCAS('rooms', f.host.view.roomId, original.version, corrupt, original.expiresAt);
  const rejectedPath = join(f.directory, 'must-not-publish.sqlite');
  await assert.rejects(backupStore({ sourcePath: f.sourcePath, destinationPath: rejectedPath, key: f.key, now: f.now }), error => error.code === 'INVALID_SNAPSHOT');
  assert.equal(existsSync(rejectedPath), false);
  const restored = f.restore(); assert.deepEqual((await f.snapshot(restored)).game, original.value.snapshot.game);
  assert.equal((await restored.rooms.getView(f.host.roomCode, users[2])).game.die, 6);
});
