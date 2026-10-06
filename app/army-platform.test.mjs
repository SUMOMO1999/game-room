import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore } from './rooms.mjs';
import * as rummikub from './multiplayer-rules.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createMatchHistory, validateMatchSummary } from '../server/match-history.mjs';
import { createRoomChat } from '../server/chat.mjs';
import { backupStore, restoreStore, verifyBackup, verifyLiveStore, RECOVERY_SCOPES } from '../server/backup.mjs';

const users = Array.from({ length: 8 }, (_, i) => identityKey('urn:synthetic-army-platform', `member-${i}`));
const gameOptions = { firstTurnIndex: 0, randomInt: (max) => max - 1 };
let sequence = 0;
const id = (prefix) => `${prefix}-${++sequence}`;
const codeError = (code) => (error) => error?.code === code;
function memoryFixture() {
  const store = createRoomStore({ gameOptions });
  const create = (gameType, code, number) => store.createTrustedRoom(users[0], '同名', { gameType, code, roomId: number.toString(16).padStart(32, '0') });
  function action(host, index, type, extra = {}) {
    return store.trustedAction(host.roomCode, users[index], { type, requestId: id('memory'),
      expectedRevision: store.getTrustedView(host.roomCode, users[index]).revision, ...extra });
  }
  function start(host) {
    store.joinTrustedRoom(host.roomCode, users[1], '同名');
    action(host, 0, 'ready', { ready: true }); action(host, 1, 'ready', { ready: true }); action(host, 0, 'start');
  }
  return { store, create, action, start };
}
async function durableFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'army-platform-')), path = join(directory, 'business.sqlite'), key = randomBytes(32);
  let time = 10000; const now = () => time, opened = [];
  function open(target = path) {
    const storage = new EncryptedStore(new SQLiteAdapter(target, { now }), key, now);
    const rooms = createDurableRoomStore({ storage, now, gameOptions, pollIntervalMs: 0 });
    const history = createMatchHistory({ storage, now }); rooms.setHistory(history);
    const entry = { storage, rooms, history }; opened.push(entry); return entry;
  }
  async function close(entry) { if (!entry.closed) { await entry.rooms.close(); entry.storage.close(); entry.closed = true; } }
  t.after(async () => { for (const entry of opened) await close(entry); await rm(directory, { recursive: true, force: true }); });
  async function action(entry, host, index, type, extra = {}) {
    return entry.rooms.action(host.roomCode, users[index], { type, requestId: id('durable'),
      expectedRevision: (await entry.rooms.getView(host.roomCode, users[index])).revision, ...extra });
  }
  async function start(entry, gameType = 'army-flip') {
    const host = await entry.rooms.createRoom(users[0], '同名', id('create'), gameType);
    await entry.rooms.joinRoom(host.roomCode, users[1], '同名', id('join'));
    await action(entry, host, 0, 'ready', { ready: true }); await action(entry, host, 1, 'ready', { ready: true }); await action(entry, host, 0, 'start');
    return host;
  }
  async function flip(entry, host) {
    const view = await entry.rooms.getView(host.roomCode, users[0]);
    const index = view.game.turnPlayerId === host.playerId ? 0 : 1;
    const current = await entry.rooms.getView(host.roomCode, users[index]);
    assert.ok(current.game.legalFlips.length, 'A new military game has an available covered piece');
    return action(entry, host, index, 'flip', { cellId: current.game.legalFlips[0] });
  }
  async function assignSides(entry, host) {
    for (let i = 0; i < 50; i++) {
      const view = await entry.rooms.getView(host.roomCode, users[0]);
      if (view.game.players.every((player) => player.side)) return view;
      await flip(entry, host);
    }
    assert.fail('Sides should be assigned before all pieces are revealed');
  }
  return { directory, path, key, now, open, close, action, start, flip, assignSides, advance: (ms) => { time += ms; } };
}

test('one room store dispatches both games; late military spectators cannot pick a side or occupy a player seat', () => {
  const f = memoryFixture(), army = f.create('army-flip', '234567', 1), rummi = f.create('rummikub', '345678', 2);
  assert.equal(army.view.gameType, 'army-flip'); assert.equal(army.view.minPlayers, 2); assert.equal(army.view.maxPlayers, 2);
  for (let i = 1; i < 7; i++) f.store.joinTrustedRoom(rummi.roomCode, users[i], '同名');
  f.start(army);
  const spectator=f.store.joinTrustedRoom(army.roomCode, users[2], '同名');
  assert.equal(spectator.view.selfRole,'spectator');assert.equal(spectator.view.players.length,2);
  assert.deepEqual(spectator.view.game.legalMoves,[]);assert.deepEqual(spectator.view.game.legalFlips,[]);
  const restored = f.store.joinTrustedRoom(army.roomCode, users[0], '不同昵称');
  assert.equal(restored.playerId, army.playerId); assert.equal(restored.view.players[0].name, '同名');
  assert.equal(f.store.getTrustedView(rummi.roomCode, users[0]).players.length, 7);
  assert.throws(() => f.action(army, 0, 'flip', { cellId: '0', side: 'red' }), codeError('INVALID_ACTION'));
  assert.throws(() => f.action(rummi, 0, 'flip', { cellId: '0' }), codeError('INVALID_ACTION'));
  assert.throws(() => f.action(army, 0, 'submit', { boardIds: [], rackIds: [] }), codeError('INVALID_ACTION'));
  assert.throws(() => f.store.createRoom('甲', { gameType: 'unknown' }), codeError('INVALID_GAME_TYPE'));
  f.store.close();
});

test('military waiting capacity is two, and a single ready host cannot start', () => {
  const f = memoryFixture(), army = f.create('army-flip', '456789', 3);
  f.action(army, 0, 'ready', { ready: true });
  assert.throws(() => f.action(army, 0, 'start'), codeError('NOT_READY'));
  f.store.joinTrustedRoom(army.roomCode, users[1], '同名');
  assert.throws(() => f.store.joinTrustedRoom(army.roomCode, users[2], '同名'), codeError('ROOM_FULL'));
  assert.equal(f.store.getTrustedView(army.roomCode, users[0]).players.length, 2); f.store.close();
});

test('versioned snapshots preserve old Rummikub games and require an explicit military discriminator', () => {
  const f = memoryFixture(), rummi = f.create('rummikub', '567890', 4), army = f.create('army-flip', '678901', 5);
  assert.equal(f.store.exportSnapshot(rummi.roomCode).schemaVersion, 2);
  assert.equal(Object.hasOwn(f.store.exportSnapshot(rummi.roomCode), 'gameType'), false);
  assert.equal(f.store.exportSnapshot(army.roomCode).schemaVersion, 6);
  assert.equal(f.store.exportSnapshot(army.roomCode).gameType, 'army-flip');
  f.start(rummi); f.start(army);
  const armyBefore = f.store.getTrustedView(army.roomCode, users[0]);
  f.action(army, 0, 'flip', { cellId: armyBefore.game.legalFlips[0] });
  const military = f.store.exportSnapshot(army.roomCode), recovered = createRoomStore({ gameOptions });
  recovered.importSnapshot(military);
  assert.deepEqual(recovered.getTrustedView(army.roomCode, users[0]).game, f.store.getTrustedView(army.roomCode, users[0]).game);
  assert.equal(recovered.getTrustedView(army.roomCode, users[1]).selfId, military.players[1].id);
  for (const schema of [1, 2]) {
    const old = f.store.exportSnapshot(rummi.roomCode); old.schemaVersion = schema; old.game.ruleVersion = schema === 1 ? 'friends-v1' : 'friends-v2';
    recovered.importSnapshot(old);
    assert.deepEqual(recovered.exportSnapshot(rummi.roomCode).game, old.game);
    assert.equal(recovered.getTrustedView(rummi.roomCode, users[0]).gameType, 'rummikub');
  }
  for (const change of [ { gameType: undefined }, { gameType: 'unknown' }, { schemaVersion: 2 },
    { game: { ...military.game, ruleVersion: 'friends-v2' } }, { players: [...military.players, { ...military.players[1], id: '8'.repeat(32), userKey: users[2] }] } ]) {
    assert.throws(() => recovered.importSnapshot({ ...structuredClone(military), ...change }), codeError('INVALID_SNAPSHOT'));
    assert.deepEqual(recovered.exportSnapshot(army.roomCode).game, military.game);
  }
  f.store.close(); recovered.close();
});

test('military pause, recovery and active departure use the shared unscored lifecycle', () => {
  const f = memoryFixture(), army = f.create('army-flip', '789012', 6); f.start(army);
  const original = f.store.exportSnapshot(army.roomCode).game;
  f.action(army, 0, 'pause'); assert.equal(f.store.getTrustedView(army.roomCode, users[0]).phase, 'playing');
  f.action(army, 1, 'pause'); assert.equal(f.store.getTrustedView(army.roomCode, users[0]).phase, 'paused');
  assert.throws(() => f.action(army, 0, 'flip', { cellId: '0' }), codeError('GAME_PAUSED'));
  f.action(army, 1, 'resume'); assert.deepEqual(f.store.exportSnapshot(army.roomCode).game, original);
  f.action(army, 0, 'leave');
  const remaining = f.store.getTrustedView(army.roomCode, users[1]);
  assert.equal(remaining.phase, 'aborted'); assert.equal(remaining.game.result.aborted, true); assert.equal(remaining.game.result.winnerIds.length, 0);
  const record = f.store.exportSnapshot(army.roomCode).pendingRecords[0];
  assert.equal(record.game, 'army-flip'); assert.equal(record.status, 'aborted');
  assert.deepEqual(record.players.map((player) => player.outcome), ['unscored', 'unscored']);
  assert.ok(record.players.every((player) => player.remainingPoints === null));
  f.action(army, 1, 'leave'); assert.throws(() => f.store.getTrustedView(army.roomCode, users[1]), codeError('ROOM_NOT_FOUND')); f.store.close();
});

test('two SQLite processes restore both games, military sides and stable original seats', async (t) => {
  const f = await durableFixture(t), a = f.open(), rummi = await f.start(a, 'rummikub'), army = await f.start(a);
  await f.action(a, rummi, 0, 'draw'); await f.flip(a, army);
  const oldRummi = (await a.storage.read('rooms', rummi.view.roomId)).value.snapshot.game;
  const military = (await a.storage.read('rooms', army.view.roomId)).value.snapshot.game;
  await f.close(a); const b = f.open();
  assert.deepEqual((await b.storage.read('rooms', rummi.view.roomId)).value.snapshot.game, oldRummi);
  const recovered = await b.rooms.joinRoom(army.roomCode, users[0], '改了名字也不认新席', id('recover'));
  assert.equal(recovered.playerId, army.playerId);
  assert.deepEqual((await b.storage.read('rooms', army.view.roomId)).value.snapshot.game, military);
  const recent = await b.rooms.recentRooms(users[0]);
  assert.equal(recent.find((room) => room.roomCode === army.roomCode).gameType, 'army-flip');
  assert.equal(recent.find((room) => room.roomCode === army.roomCode).maxPlayers, 2);
  assert.equal(recent.find((room) => room.roomCode === rummi.roomCode).gameType, 'rummikub');
  await assert.rejects(b.rooms.getView(army.roomCode, users[2]), codeError('SEAT_REQUIRED'));
});

test('military create is idempotent across connections and cannot reuse a request for another game', async (t) => {
  const f = await durableFixture(t), a = f.open(), b = f.open();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).rooms.createRoom(users[0], '甲', 'same-army', 'army-flip')));
  assert.equal(new Set(results.map((entry) => entry.roomCode)).size, 1);
  assert.equal(new Set(results.map((entry) => entry.playerId)).size, 1);
  await assert.rejects(a.rooms.createRoom(users[0], '甲', 'same-army'), codeError('REQUEST_ID_REUSED'));
  const old = await a.rooms.createRoom(users[0], '乙', 'same-old');
  await assert.rejects(b.rooms.createRoom(users[0], '乙', 'same-old', 'army-flip'), codeError('REQUEST_ID_REUSED'));
  assert.equal((await b.rooms.createRoom(users[0], '乙', 'same-old', 'rummikub')).playerId, old.playerId);
  await a.rooms.joinRoom(results[0].roomCode, users[1], '甲', id('second'));
  await assert.rejects(b.rooms.joinRoom(results[0].roomCode, users[2], '甲', id('third')), codeError('ROOM_FULL'));
  await assert.rejects(b.rooms.createRoom(users[0], '甲', id('invalid'), 'four-armies'), codeError('INVALID_GAME_TYPE'));
});

test('a historical pending Rummikub creation can finish after adding military dispatch', async (t) => {
  const f = await durableFixture(t), entry = f.open(), memory = createRoomStore({ gameOptions });
  const roomId = 'a'.repeat(32), code = '123456', name = '历史昵称', requestId = 'legacy-pending';
  const host = memory.createTrustedRoom(users[0], name, { roomId, code });
  const fingerprint = createHash('sha256').update('{"name":"历史昵称"}').digest('hex');
  const operationKey = createHash('sha256').update(`${users[0]}\0create\0${requestId}`).digest('hex');
  await entry.storage.putIfAbsent('room-invites', code, { roomId }, Number.MAX_SAFE_INTEGER);
  await entry.storage.putIfAbsent('room-requests', operationKey, { kind: 'create', fingerprint, roomId, code, status: 'pending', snapshot: memory.exportSnapshot(code) }, f.now() + 86400000);
  const recovered = await entry.rooms.createRoom(users[0], name, requestId);
  assert.equal(recovered.roomCode, code); assert.equal(recovered.playerId, host.playerId);
  assert.equal((await entry.storage.read('rooms', roomId)).value.snapshot.schemaVersion, 2);
  memory.close();
});

test('concurrent military flip commits once; old revision and replay cannot turn another covered piece', async (t) => {
  const f = await durableFixture(t), a = f.open(), b = f.open(), host = await f.start(a);
  const view = await a.rooms.getView(host.roomCode, users[0]), cells = view.game.legalFlips;
  const action = { type: 'flip', cellId: cells[0], expectedRevision: view.revision, requestId: 'same-flip' };
  await Promise.all([a.rooms.action(host.roomCode, users[0], action), b.rooms.action(host.roomCode, users[0], action)]);
  const after = await a.rooms.getView(host.roomCode, users[0]);
  assert.equal(after.game.revision, view.game.revision + 1);
  await b.rooms.action(host.roomCode, users[0], action);
  assert.equal((await b.rooms.getView(host.roomCode, users[0])).game.revision, after.game.revision);
  await assert.rejects(a.rooms.action(host.roomCode, users[0], { ...action, cellId: cells[1] }), codeError('REQUEST_ID_REUSED'));
  await assert.rejects(a.rooms.action(host.roomCode, users[1], { ...action, requestId: 'stale-flip', cellId: cells[1] }), codeError('REVISION_CONFLICT'));
  assert.equal((await b.rooms.getView(host.roomCode, users[1])).game.revision, after.game.revision);
  const wrongTurn = await a.rooms.getView(host.roomCode, users[0]);
  await assert.rejects(f.action(a, host, 0, 'flip', { cellId: wrongTurn.game.board.find((cell) => cell.piece?.hidden).cellId }), codeError('INVALID_GAME_ACTION'));
  const activities = JSON.stringify(after.activity);
  const full = (await a.storage.read('rooms', host.view.roomId)).value.snapshot.game;
  for (const cell of full.board.filter((cell) => cell.piece && !cell.piece.revealed)) {
    assert.equal(activities.includes(cell.piece.id), false);
    assert.equal(JSON.stringify(after).includes(cell.piece.id), false);
  }
});

test('a legal military move survives a process restart and exact replay cannot move twice', async (t) => {
  const f = await durableFixture(t), entry = f.open(), host = await f.start(entry);
  let view, index, move;
  for (let count = 0; count < 50; count++) {
    const baseline = await entry.rooms.getView(host.roomCode, users[0]);
    index = baseline.game.turnPlayerId === host.playerId ? 0 : 1;
    view = await entry.rooms.getView(host.roomCode, users[index]);
    move = view.game.legalMoves.find(({ to }) => view.game.board.find((cell) => cell.cellId === to).piece === null);
    if (move) break;
    await f.flip(entry, host);
  }
  assert.ok(move, 'Revealing real pieces opens a move to an initially empty camp');
  const originalPiece = view.game.board.find((cell) => cell.cellId === move.from).piece;
  const body = { type: 'move', ...move, expectedRevision: view.revision, requestId: 'persisted-move' };
  const moved = (await entry.rooms.action(host.roomCode, users[index], body)).view;
  assert.equal(moved.game.board.find((cell) => cell.cellId === move.from).piece, null);
  assert.equal(moved.game.board.find((cell) => cell.cellId === move.to).piece.id, originalPiece.id);
  await f.close(entry); const restarted = f.open();
  const replay = await restarted.rooms.action(host.roomCode, users[index], body);
  assert.equal(replay.view.game.revision, moved.game.revision);
  assert.deepEqual(replay.view.game.board, moved.game.board);
  assert.equal(replay.view.game.turnPlayerId, moved.game.turnPlayerId);
});

test('distinct military moves racing on the same revision commit one action and reject the other', async (t) => {
  const f = await durableFixture(t), a = f.open(), b = f.open(), host = await f.start(a);
  const before = await a.rooms.getView(host.roomCode, users[0]);
  const proposals = before.game.legalFlips.slice(0, 2).map((cellId, index) => ({
    type: 'flip', cellId, expectedRevision: before.revision, requestId: `different-flip-${index}`,
  }));
  const results = await Promise.allSettled(proposals.map((body, index) => (index ? b : a).rooms.action(host.roomCode, users[0], body)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected'); assert.equal(rejected.reason.code, 'REVISION_CONFLICT');
  const after = await b.rooms.getView(host.roomCode, users[0]);
  assert.equal(after.game.revision, before.game.revision + 1); assert.equal(after.revision, before.revision + 1);
  assert.equal(after.game.board.filter((cell) => cell.piece && cell.piece.hidden === false).length, 1);
  assert.notEqual(after.game.turnPlayerId, before.game.turnPlayerId);
});

test('historical custom Rummikub engine retains its context and cannot replace military dispatch', () => {
  const calls = [], custom = { calls,
    createGame(players, options) { this.calls.push('create'); return rummikub.createGame(players, options); },
    applyGameAction(game, playerId, action) { this.calls.push(action.type); return rummikub.applyGameAction(game, playerId, action); },
    privateView(game, playerId) { this.calls.push('view'); return rummikub.privateView(game, playerId); },
  };
  const store = createRoomStore({ gameOptions, gameEngine: custom });
  const host = store.createTrustedRoom(users[0], '甲', { code: '891234', roomId: '9'.repeat(32) });
  store.joinTrustedRoom(host.roomCode, users[1], '乙');
  const action = (code, user, type, fields = {}) => store.trustedAction(code, user, { type, requestId: id('custom'),
    expectedRevision: store.getTrustedView(code, user).revision, ...fields });
  action(host.roomCode, users[0], 'ready', { ready: true }); action(host.roomCode, users[1], 'ready', { ready: true });
  action(host.roomCode, users[0], 'start'); action(host.roomCode, users[0], 'draw');
  assert.ok(calls.includes('create')); assert.ok(calls.includes('draw')); assert.ok(calls.includes('view'));
  const before = [...calls], army = store.createTrustedRoom(users[0], '甲', { gameType: 'army-flip', code: '912345', roomId: '8'.repeat(32) });
  store.joinTrustedRoom(army.roomCode, users[1], '乙');
  action(army.roomCode, users[0], 'ready', { ready: true }); action(army.roomCode, users[1], 'ready', { ready: true });
  action(army.roomCode, users[0], 'start'); action(army.roomCode, users[0], 'resign');
  assert.equal(store.getTrustedView(army.roomCode, users[1]).game.result.reason, 'resigned');
  assert.deepEqual(calls, before); store.close();
});

test('military resign and accepted draw archive honest outcomes with no fabricated hand points', async (t) => {
  const f = await durableFixture(t), entry = f.open(), resigned = await f.start(entry);
  await f.assignSides(entry, resigned); await f.action(entry, resigned, 0, 'resign');
  const win = await entry.history.get(users[1]), loss = await entry.history.get(users[0]);
  assert.equal(win.items[0].game, 'army-flip'); assert.equal(win.items[0].ruleVersion, 'army-flip-v3');
  assert.equal(win.items[0].self.outcome, 'win'); assert.equal(loss.items[0].self.outcome, 'loss');
  assert.ok(win.items[0].players.every((player) => player.remainingPoints === null));
  const drawn = await f.start(entry); await f.assignSides(entry, drawn);
  await f.action(entry, drawn, 0, 'offer-draw'); await f.action(entry, drawn, 1, 'accept-draw');
  const view = await entry.rooms.getView(drawn.roomCode, users[0]);
  assert.equal(view.phase, 'finished'); assert.equal(view.game.result.tie, true); assert.deepEqual(view.game.result.winnerIds, []);
  assert.equal((await entry.history.get(users[0])).stats.draws, 1); assert.equal((await entry.history.get(users[1])).stats.draws, 1);
  assert.equal((await entry.storage.scan('game-history')).length, 2);
  await entry.rooms.flushPendingRecords(); assert.equal((await entry.storage.scan('game-history')).length, 2);
  const summary = (await entry.storage.scan('game-history')).find((record) => record.value.summary.players.every((player) => player.outcome === 'draw')).value.summary;
  assert.throws(() => validateMatchSummary({ ...summary, ruleVersion: 'friends-v2' }));
  assert.throws(() => validateMatchSummary({ ...summary, players: summary.players.map((player) => ({ ...player, remainingPoints: 0 })) }));
  assert.throws(() => validateMatchSummary({ ...summary, players: [{ ...summary.players[0], outcome: 'draw' }, { ...summary.players[1], outcome: 'loss' }] }));
});

test('nine-scope backup restores mixed games, military pending history, chat and seats to a new database', async (t) => {
  const f = await durableFixture(t), entry = f.open(), rummi = await f.start(entry, 'rummikub'), army = await f.start(entry);
  const previous = await f.start(entry, 'rummikub'); await f.action(entry, previous, 0, 'leave');
  const chat = createRoomChat({ storage: entry.storage, rooms: entry.rooms, now: f.now });
  await chat.send(army.roomCode, users[0], { text: '军棋房间消息', requestId: 'backup-chat' }); await chat.close();
  await f.assignSides(entry, army);
  entry.rooms.setHistory({ archive: async () => { throw new Error('synthetic history outage'); } });
  await f.action(entry, army, 0, 'offer-draw'); await f.action(entry, army, 1, 'accept-draw');
  const rummiBefore = (await entry.storage.read('rooms', rummi.view.roomId)).value.snapshot.game;
  const armyBefore = (await entry.storage.read('rooms', army.view.roomId)).value.snapshot;
  assert.equal(armyBefore.pendingRecords.length, 1);
  const backupPath = join(f.directory, 'backup.sqlite'), recoveredPath = join(f.directory, 'recovered.sqlite');
  await backupStore({ sourcePath: f.path, destinationPath: backupPath, key: f.key, now: f.now });
  const verified = verifyBackup({ sourcePath: backupPath, key: f.key }); assert.deepEqual(verified.manifest.scopes, RECOVERY_SCOPES);
  assert.equal(verified.manifest.authSessionsIncluded, false);
  restoreStore({ sourcePath: backupPath, destinationPath: recoveredPath, key: f.key, offline: true });
  const recovered = f.open(recoveredPath); await recovered.rooms.flushPendingRecords(); await recovered.rooms.flushPendingRecords();
  assert.deepEqual((await recovered.storage.read('rooms', rummi.view.roomId)).value.snapshot.game, rummiBefore);
  assert.equal((await recovered.rooms.getView(army.roomCode, users[0])).selfId, army.playerId);
  assert.deepEqual((await recovered.storage.read('rooms', army.view.roomId)).value.snapshot.game, armyBefore.game);
  const history = await recovered.history.get(users[0]); assert.equal(history.stats.draws, 1); assert.equal(history.stats.aborted, 1);
  assert.deepEqual((await recovered.storage.read('rooms', army.view.roomId)).value.snapshot.pendingRecords, []);
  const recoveredChat = createRoomChat({ storage: recovered.storage, rooms: recovered.rooms, now: f.now });
  assert.equal((await recoveredChat.get(army.roomCode, users[0])).messages[0].text, '军棋房间消息'); await recoveredChat.close();
  assert.equal((await recovered.storage.scan('sessions')).length, 0); assert.equal((await recovered.storage.scan('room-presence')).length, 0);
  assert.deepEqual((await entry.storage.read('rooms', rummi.view.roomId)).value.snapshot.game, rummiBefore);
});

test('startup and backup reject unknown military snapshots and invalid pending creation snapshots', async (t) => {
  const f = await durableFixture(t), entry = f.open(), host = await f.start(entry);
  const saved = await entry.storage.read('rooms', host.view.roomId), bad = structuredClone(saved.value);
  bad.snapshot.gameType = 'unknown'; await entry.storage.replaceCAS('rooms', host.view.roomId, saved.version, bad, saved.expiresAt);
  assert.throws(() => verifyLiveStore({ sourcePath: f.path, key: f.key }), codeError('INVALID_SNAPSHOT'));
  await assert.rejects(backupStore({ sourcePath: f.path, destinationPath: join(f.directory, 'bad.sqlite'), key: f.key, now: f.now }), codeError('INVALID_SNAPSHOT'));
  const changed = await entry.storage.read('rooms', host.view.roomId); await entry.storage.replaceCAS('rooms', host.view.roomId, changed.version, saved.value, saved.expiresAt);
  await entry.storage.putIfAbsent('room-requests', 'd'.repeat(64), { kind: 'create', status: 'pending', roomId: host.view.roomId, code: host.roomCode,
    snapshot: { ...saved.value.snapshot, phase: 'waiting', game: null, gameType: 'unknown' } }, f.now() + 1000);
  assert.throws(() => verifyLiveStore({ sourcePath: f.path, key: f.key }), codeError('INVALID_SNAPSHOT'));
});

test('carrying a flag survives schema7 clock backup and stable-seat recovery, then delivery archives exactly once', async (t) => {
  const f = await durableFixture(t), entry = f.open(), host = await f.start(entry);
  const saved = await entry.storage.read('rooms', host.view.roomId), record = structuredClone(saved.value);
  const game = record.snapshot.game;
  assert.equal(game.ruleVersion, 'army-flip-v3'); assert.equal(record.snapshot.schemaVersion, 7);
  const pieces = game.board.flatMap(({ piece }) => piece ? [{ ...piece, revealed: true }] : []);
  const positions = new Map([['red-flag-1', 'r0c1'], ['black-flag-1', 'r10c3'],
    ['red-engineer-1', 'r10c2'], ['black-engineer-1', 'r1c0']]);
  game.board = game.board.map(({ cellId }) => ({ cellId, piece: pieces.find((piece) => positions.get(piece.id) === cellId) ?? null }));
  game.captured = pieces.filter((piece) => !positions.has(piece.id));
  game.players = game.players.map((player, index) => ({ ...player, side: index ? 'black' : 'red', lastFlipSide: index ? 'black' : 'red' }));
  game.round = 51; game.revision = 51; game.turnIndex = 0;
  record.snapshot.turnClock.round = game.round; record.snapshot.turnClock.playerId = game.players[game.turnIndex].id;
  game.lastAction = { type: 'decline-draw', playerId: game.players[1].id };
  record.snapshot.revision += 1;
  assert.equal(await entry.storage.replaceCAS('rooms', host.view.roomId, saved.version, record, saved.expiresAt), true);
  await f.action(entry, host, 0, 'move', { from: 'r10c2', to: 'r10c3' });
  const carrying = await entry.rooms.getView(host.roomCode, users[0]);
  assert.equal(carrying.phase, 'playing'); assert.equal(carrying.game.result, null);
  assert.deepEqual(carrying.game.flagTokens, [{ side: 'black', carrierId: 'red-engineer-1', cellId: null }]);
  const watching = await entry.rooms.joinRoom(host.roomCode, users[2], '同名', id('watch'));
  assert.equal(watching.view.selfRole, 'spectator');
  assert.deepEqual(watching.view.game.flagTokens, carrying.game.flagTokens);
  assert.deepEqual(watching.view.game.legalPickups, []);
  await assert.rejects(f.action(entry, host, 2, 'pickup', { cellId: 'r10c3', flagSide: 'black' }), codeError('SPECTATOR_READ_ONLY'));
  verifyLiveStore({ sourcePath: f.path, key: f.key });
  const backupPath = join(f.directory, 'flag-backup.sqlite'), target = join(f.directory, 'flag-restored.sqlite');
  await backupStore({ sourcePath: f.path, destinationPath: backupPath, key: f.key, now: f.now });
  restoreStore({ sourcePath: backupPath, destinationPath: target, key: f.key, offline: true });
  const restored = f.open(target), returned = await restored.rooms.joinRoom(host.roomCode, users[0], '改名不能换席位', id('return'));
  assert.equal(returned.playerId, host.playerId);
  assert.deepEqual(returned.view.game, (await entry.rooms.getView(host.roomCode, users[0])).game);
  await f.action(restored, host, 1, 'move', { from: 'r1c0', to: 'r1c1' });
  await f.action(restored, host, 0, 'move', { from: 'r10c3', to: 'r11c3' });
  const ended = await restored.rooms.getView(host.roomCode, users[0]);
  assert.equal(ended.game.result.reason, 'flag-delivered'); assert.equal(ended.game.winnerId, host.playerId);
  await restored.rooms.flushPendingRecords(); await restored.rooms.flushPendingRecords();
  const history = await restored.history.get(users[0]);
  assert.equal(history.stats.completed, 1); assert.equal(history.items[0].ruleVersion, 'army-flip-v3');
  assert.equal(history.items[0].self.outcome, 'win');
  verifyLiveStore({ sourcePath: target, key: f.key });
  assert.equal((await entry.rooms.getView(host.roomCode, users[0])).phase, 'playing');
});

test('v3 sacrificed mine and stable seats survive encrypted backup restore; duplicate action and history archive stay idempotent', async t => {
  const f = await durableFixture(t), entry = f.open(), host = await f.start(entry);
  const saved = await entry.storage.read('rooms', host.view.roomId), record = structuredClone(saved.value), game = record.snapshot.game;
  const pieces = game.board.flatMap(({ piece }) => piece ? [{ ...piece, revealed: true }] : []);
  const positions = new Map([['red-flag-1', 'r0c1'], ['black-flag-1', 'r11c3'],
    ['red-platoon-1', 'r1c1'], ['black-mine-1', 'r1c2'], ['black-engineer-1', 'r10c0']]);
  game.board = game.board.map(({ cellId }) => ({ cellId, piece: pieces.find(piece => positions.get(piece.id) === cellId) ?? null }));
  game.captured = pieces.filter(piece => !positions.has(piece.id));
  game.players = game.players.map((player, index) => ({ ...player, side: index ? 'black' : 'red', lastFlipSide: index ? 'black' : 'red' }));
  game.round = 51; game.revision = 51; game.turnIndex = 0;
  record.snapshot.turnClock.round = game.round; record.snapshot.turnClock.playerId = game.players[game.turnIndex].id;
  game.lastAction = { type: 'decline-draw', playerId: game.players[1].id }; record.snapshot.revision += 1;
  assert.equal(record.snapshot.schemaVersion, 7);
  assert.equal(await entry.storage.replaceCAS('rooms', host.view.roomId, saved.version, record, saved.expiresAt), true);
  const before = await entry.rooms.getView(host.roomCode, users[0]);
  const action = { type: 'move', from: 'r1c1', to: 'r1c2', requestId: id('demine'), expectedRevision: before.revision };
  const confirmed = await entry.rooms.action(host.roomCode, users[0], action);
  const replay = await entry.rooms.action(host.roomCode, users[0], action); assert.deepEqual(replay, confirmed);
  assert.equal(confirmed.view.game.lastAction.outcome, 'mine-sacrifice');
  assert.equal(confirmed.view.game.board.find(cell => cell.cellId === 'r1c2').piece, null);
  assert.deepEqual(confirmed.view.game.capturedPieces.slice(-2).map(piece => piece.id), ['red-platoon-1', 'black-mine-1']);
  verifyLiveStore({ sourcePath: f.path, key: f.key });
  const backup = join(f.directory, 'sacrifice-backup.sqlite'), target = join(f.directory, 'sacrifice-restored.sqlite');
  await backupStore({ sourcePath: f.path, destinationPath: backup, key: f.key, now: f.now });
  restoreStore({ sourcePath: backup, destinationPath: target, key: f.key, offline: true });
  const restored = f.open(target), returned = await restored.rooms.joinRoom(host.roomCode, users[0], '另一个显示名', id('return-demine'));
  assert.equal(returned.playerId, host.playerId); assert.deepEqual(returned.view.game, confirmed.view.game);
  const watching = await restored.rooms.joinRoom(host.roomCode, users[2], '同名', id('watch-demine'));
  assert.equal(watching.view.selfRole, 'spectator'); assert.deepEqual(watching.view.game.legalMoves, []);
  await assert.rejects(f.action(restored, host, 2, 'resign'), codeError('SPECTATOR_READ_ONLY'));
  await f.action(restored, host, 1, 'resign');
  await restored.rooms.flushPendingRecords(); await restored.rooms.flushPendingRecords();
  const alice = await restored.history.get(users[0]), bob = await restored.history.get(users[1]);
  assert.equal(alice.stats.completed, 1); assert.equal(bob.stats.completed, 1);
  assert.equal(alice.items[0].ruleVersion, 'army-flip-v3'); assert.equal(alice.items[0].self.outcome, 'win');
  assert.equal(bob.items[0].self.outcome, 'loss'); assert.ok(alice.items[0].players.every(player => player.remainingPoints === null));
  assert.equal((await entry.rooms.getView(host.roomCode, users[0])).phase, 'playing');
  verifyLiveStore({ sourcePath: target, key: f.key });
});
