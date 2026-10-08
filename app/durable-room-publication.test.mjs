import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRoomStore, RoomError } from './rooms.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey } from '../server/storage.mjs';

// Real four-game adapters, encrypted records and publication callbacks. No
// substitute projection or engine-count seam can make a private leak pass.
const users = ['owner', 'guest', 'spectator', 'outsider'].map(sub => identityKey('urn:publication-test', sub));
const attack = 'callback-cannot-own-the-next-view';
const words = Array.from({ length: 12 }, (_, index) => ({ id: `publication-word-${index + 1}`, answer: `秘密画词${index + 1}`,
  aliases: [`暗号${index + 1}`], category: 'daily', categoryName: '日常', difficulty: 'easy', language: 'zh',
  packId: 'publication-pack', packVersion: '1', definitionVersion: 1, source: '原创测试', status: 'reviewed',
  hintLength: [...`秘密画词${index + 1}`].length, tags: [], drawingCue: '只保留在服务端的试画提示' }));
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const failure = code => error => error instanceof RoomError && error.code === code;

async function fixture(t, { sqlite, ttlMs = 600000 } = {}) {
  let time = 1000, sequence = 0;
  const now = () => time;
  const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(':memory:', { now }) : new MemoryAdapter({ now }), randomBytes(32), now);
  const settings = { now, ttlMs, pausedTtlMs: ttlMs * 7, turnTimeoutMs: 1800000, serverRandomInt: max => max === 6 ? 5 : 0,
    gameOptions: { firstTurnIndex: 0, randomInt: max => max - 1, frozenCandidates: words } };
  const rooms = createDurableRoomStore({ storage, ...settings, pollIntervalMs: 0 });
  const builders = [], stops = [];
  t.after(async () => {
    for (const stop of stops) await stop();
    await rooms.close();
    for (const builder of builders) builder.close();
    storage.close();
  });
  async function seed(gameType, { drawing = false } = {}) {
    const code = '123456', roomId = randomBytes(16).toString('hex'), builder = createRoomStore(settings); builders.push(builder);
    builder.createTrustedRoom(users[0], '合成房主', { code, roomId, gameType });
    builder.joinTrustedRoom(code, users[1], '合成伙伴'); builder.joinTrustedRoom(code, users[2], '合成观众', { role: 'spectator' });
    const act = (user, type, fields = {}) => {
      const view = builder.getTrustedView(code, user);
      return builder.trustedAction(code, user, { type, requestId: `member-${users.indexOf(user)}-intent-${++sequence}`,
        expectedRevision: view.revision, ...fields });
    };
    if (gameType === 'draw-and-guess') act(users[0], 'configure', { drawConfig: { rounds: 2, drawingSeconds: 120,
      contentSelection: { packId: 'publication-pack', version: 1, categoryIds: ['daily'], difficulties: ['easy'] } } });
    act(users[0], 'ready', { ready: true }); act(users[1], 'ready', { ready: true }); act(users[0], 'start');
    if (gameType === 'flying-chess') act(users[0], 'roll');
    if (drawing) {
      const view = builder.getTrustedView(code, users[0]);
      act(users[0], 'choose', { matchId: view.matchId, turnId: view.game.turnId, candidateId: view.game.candidates[0].id });
      const chosen = builder.getTrustedView(code, users[1]);
      act(users[1], 'guess', { matchId: chosen.matchId, turnId: chosen.game.turnId, text: '合成的未匹配猜测' });
    }
    const snapshot = builder.exportSnapshot(code);
    await storage.put('room-invites', code, { roomId });
    await storage.put('rooms', roomId, { snapshot, joins: {} });
    await storage.put('room-registry', 'active', { [roomId]: { code, reservedAt: time } });
    await storage.put('room-presence', roomId, { schemaVersion: 2, connections: {}, lastSeen: {} });
    return { code, roomId, snapshot };
  }
  async function subscribe(room, user, onView, onEnd = () => {}) {
    const stop = await rooms.subscribe(room.code, user, onView, onEnd); stops.push(stop); return stop;
  }
  async function changePublication(room) {
    const record = await storage.read('rooms', room.roomId); record.value.snapshot.lastActiveAt++;
    assert.equal(await storage.replaceCAS('rooms', room.roomId, record.version, record.value), true);
    return storage.read('rooms', room.roomId);
  }
  return { storage, rooms, seed, subscribe, changePublication, now, setTime(value) { time = value; } };
}

function damage(view) {
  view.game.injected = attack;
  if (view.game.players?.length) view.game.players[0].name = attack;
  if (view.game.rack?.length) view.game.rack[0].value = 999;
  if (view.game.board?.length) {
    const cell = view.game.board[0];
    if (Array.isArray(cell) && cell.length) cell[0].value = 999;
    else if (cell.piece) cell.piece.kind = attack;
  }
  if (view.game.candidates?.length) view.game.candidates[0].answer = attack;
  if (view.game.word) { view.game.word.answer = attack; view.game.word.aliases.push(attack); }
  if (view.game.planes?.length) view.game.planes[0].progress = 999;
  if (view.game.legalMoves?.length) view.game.legalMoves[0].injected = attack;
  view.players[0].name = attack; view.players.push({ id: attack, name: attack });
  view.matchPlayers[0].name = attack; view.spectators.splice(0);
  view.actionReceipts ??= [];
  if (view.actionReceipts.length) view.actionReceipts[0].requestId = attack;
  view.actionReceipts.push({ requestId: attack, status: 'committed', guessResult: { injected: attack } });
  view.activity.push({ text: attack });
  if (view.turnClock) view.turnClock.deadlineAt = 0;
}

function assertPrivate(room, views) {
  for (let index = 0; index < views.length; index++) {
    const view = views[index], text = JSON.stringify(view);
    assert.equal(view.selfRole, index === 2 ? 'spectator' : 'player');
    assert.equal(text.includes(attack), false);
    assert.equal(text.includes('userKey'), false); assert.equal(text.includes('tokenHash'), false);
    const member = [...room.snapshot.players, ...room.snapshot.spectators].find(player => player.userKey === users[index]);
    if (view.actionReceipts) {
      assert.deepEqual(view.actionReceipts.map(receipt => receipt.requestId), member.requests.map(receipt => receipt[0]));
      for (const other of [...room.snapshot.players, ...room.snapshot.spectators].filter(player => player !== member)) {
        for (const [requestId] of other.requests) assert.equal(view.actionReceipts.some(receipt => receipt.requestId === requestId), false);
      }
    }
  }
  const [owner, guest, spectator] = views;
  if (owner.gameType === 'rummikub') {
    const racks = room.snapshot.game.players.map(player => player.rack);
    assert.deepEqual(owner.game.rack, racks[0]); assert.deepEqual(guest.game.rack, racks[1]);
    assert.equal(Object.hasOwn(spectator.game, 'rack'), false);
    for (const tile of racks[0]) assert.equal(JSON.stringify(guest).includes(JSON.stringify(tile.id)), false);
    for (const tile of racks[1]) assert.equal(JSON.stringify(owner).includes(JSON.stringify(tile.id)), false);
    for (const view of views) {
      assert.equal(Object.hasOwn(view.game, 'pool'), false);
      for (const tile of room.snapshot.game.pool) assert.equal(JSON.stringify(view).includes(JSON.stringify(tile.id)), false);
    }
  } else if (owner.gameType === 'army-flip') {
    assert.ok(owner.game.legalFlips.length); assert.deepEqual(guest.game.legalFlips, []); assert.deepEqual(spectator.game.legalFlips, []);
    for (const cell of room.snapshot.game.board.filter(cell => cell.piece && !cell.piece.revealed)) {
      for (const view of views) {
        assert.deepEqual(view.game.board.find(entry => entry.cellId === cell.cellId).piece, { hidden: true });
        assert.equal(JSON.stringify(view).includes(JSON.stringify(cell.piece.id)), false);
      }
    }
    assert.equal(Object.hasOwn(spectator.game, 'playerId'), false);
  } else if (owner.gameType === 'flying-chess') {
    assert.equal(owner.game.stage, 'await-move'); assert.equal(owner.game.die, 6); assert.ok(owner.game.legalMoves.length);
    assert.deepEqual(guest.game.legalMoves, []); assert.deepEqual(spectator.game.legalMoves, []);
    assert.deepEqual(guest.game.legalPlaneIds, []); assert.deepEqual(spectator.game.legalPlaneIds, []);
    assert.equal(Object.hasOwn(spectator.game, 'playerId'), false);
    for (const view of views) assert.deepEqual(view.game.planes, room.snapshot.game.planes);
  } else {
    assert.equal(owner.gameType, 'draw-and-guess');
    if (owner.game.stage === 'choosing') { assert.equal(owner.game.candidates.length, 3); assert.equal(owner.game.canChoose, true); }
    else { assert.equal(owner.game.stage, 'drawing'); assert.equal(owner.game.word.answer,
      words.find(word => word.id === room.snapshot.game.selectedWordId).answer); assert.equal(owner.game.canDraw, true); }
    for (const view of [guest, spectator]) {
      assert.equal(Object.hasOwn(view.game, 'candidates'), false); assert.equal(Object.hasOwn(view.game, 'word'), false);
      for (const word of words) assert.equal(JSON.stringify(view).includes(JSON.stringify(word.answer)), false);
    }
    for (const view of views) assert.equal(JSON.stringify(view).includes('只保留在服务端的试画提示'), false);
  }
}

for (const sqlite of [false, true]) {
  const adapter = sqlite ? 'SQLite' : 'Memory';
  for (const gameType of ['rummikub', 'army-flip', 'flying-chess', 'draw-and-guess']) {
    test(`${adapter}: ${gameType} publication isolates a mutating and throwing member from later members and saved state`, async t => {
      const f = await fixture(t, { sqlite }), room = await f.seed(gameType), deliveries = [[], [], []];
      await f.subscribe(room, users[0], view => { deliveries[0].push(structuredClone(view)); damage(view); throw new Error('synthetic failed transport'); });
      await f.subscribe(room, users[1], view => deliveries[1].push(view));
      await f.subscribe(room, users[2], view => deliveries[2].push(view));
      const saved = await f.storage.read('rooms', room.roomId);
      assert.deepEqual(saved.value.snapshot, room.snapshot, 'callbacks cannot edit any authoritative game or action receipt');
      const expected = await Promise.all(users.slice(0, 3).map(user => f.rooms.getView(room.code, user)));
      assertPrivate(room, expected);
      for (let index = 0; index < 3; index++) assert.deepEqual(deliveries[index].at(-1), expected[index]);
      assert.deepEqual(await f.storage.read('rooms', room.roomId), saved);
      for (const values of deliveries) values.length = 0;
      const nextSaved = await f.changePublication(room);
      await f.rooms.sweep();
      const nextExpected = await Promise.all(users.slice(0, 3).map(user => f.rooms.getView(room.code, user)));
      for (let index = 0; index < 3; index++) { assert.equal(deliveries[index].length, 1); assert.deepEqual(deliveries[index][0], nextExpected[index]); }
      assertPrivate(room, nextExpected);
      assert.deepEqual(await f.storage.read('rooms', room.roomId), nextSaved, 'a later publication uses saved state and never persists callback damage');
    });
  }

  test(`${adapter}: drawing publication keeps the selected answer and private guess receipt with their actual owners`, async t => {
    const f = await fixture(t, { sqlite }), room = await f.seed('draw-and-guess', { drawing: true }), deliveries = [[], [], []];
    await f.subscribe(room, users[0], view => { deliveries[0].push(structuredClone(view)); damage(view); });
    await f.subscribe(room, users[1], view => deliveries[1].push(view));
    await f.subscribe(room, users[2], view => deliveries[2].push(view));
    assertPrivate(room, deliveries.map(values => values.at(-1)));
    assert.equal(deliveries[1].at(-1).actionReceipts.some(receipt => receipt.guessResult?.correct === false), true);
    assert.equal(deliveries[0].at(-1).actionReceipts.some(receipt => receipt.guessResult?.correct === false), false);
    assert.deepEqual((await f.storage.read('rooms', room.roomId)).value.snapshot, room.snapshot);
  });

  test(`${adapter}: a departed member is ended before any later publication while remaining members retain their own game`, async t => {
    const f = await fixture(t, { sqlite }), room = await f.seed('rummikub'), deliveries = [[], [], []], ended = [[], [], []];
    for (let index = 0; index < 3; index++) await f.subscribe(room, users[index], view => deliveries[index].push(view),
      (reason, status) => ended[index].push({ reason, status }));
    const count = deliveries[1].length, before = await f.rooms.getView(room.code, users[1]);
    assert.deepEqual(await f.rooms.action(room.code, users[1], { type: 'leave', requestId: 'departed-member', expectedRevision: before.revision }), { view: null, left: true });
    assert.equal(deliveries[1].length, count); assert.equal(ended[1].length, 1); assert.equal(ended[1][0].status, 404);
    assert.equal(deliveries[0].at(-1).phase, 'aborted'); assert.equal(deliveries[2].at(-1).phase, 'aborted');
    assert.equal(Object.hasOwn(deliveries[2].at(-1).game, 'rack'), false);
    await f.changePublication(room); await f.rooms.sweep();
    assert.equal(deliveries[1].length, count); assert.equal(ended[1].length, 1);
    await assert.rejects(f.rooms.getView(room.code, users[1]), failure('SEAT_REQUIRED'));
  });

  test(`${adapter}: expired room publication closes each subscription once and cannot revive private data`, async t => {
    const f = await fixture(t, { sqlite, ttlMs: 100 }), room = await f.seed('army-flip'), views = [[], [], []], ended = [[], [], []];
    for (let index = 0; index < 3; index++) await f.subscribe(room, users[index], view => views[index].push(view),
      (reason, status) => ended[index].push({ reason, status }));
    const counts = views.map(values => values.length);
    f.setTime(1100); await f.rooms.sweep(); await f.rooms.sweep();
    for (let index = 0; index < 3; index++) { assert.equal(views[index].length, counts[index]); assert.equal(ended[index].length, 1); assert.equal(ended[index][0].status, 404); }
    await assert.rejects(f.rooms.getView(room.code, users[0]), failure('ROOM_NOT_FOUND'));
    await assert.rejects(f.rooms.subscribe(room.code, users[0], () => assert.fail('expired room cannot publish')), failure('ROOM_NOT_FOUND'));
    assert.equal((await f.storage.read('rooms', room.roomId)).value.snapshot, null);
  });

  test(`${adapter}: publication crossing TTL while reading presence closes all members without a late view`, async t => {
    const f = await fixture(t, { sqlite, ttlMs: 100 }), room = await f.seed('rummikub'), views = [[], [], []], ended = [[], [], []];
    for (let index = 0; index < 3; index++) await f.subscribe(room, users[index], view => views[index].push(view),
      (reason, status) => ended[index].push({ reason, status }));
    const counts = views.map(values => values.length), read = f.storage.read.bind(f.storage), gate = deferred(), release = deferred();
    // The second presence read in sweep is the publication's context (the
    // first renews live transport presence). Capture the real read then delay.
    let presenceReads = 0;
    f.storage.read = async (...args) => {
      const record = await read(...args);
      if (args[0] === 'room-presence' && ++presenceReads === 2) { gate.resolve(); await release.promise; }
      return record;
    };
    f.setTime(1099);
    const pending = f.rooms.sweep();
    try {
      await gate.promise; f.setTime(1100); release.resolve(); await pending;
      for (let index = 0; index < 3; index++) { assert.equal(views[index].length, counts[index]); assert.equal(ended[index].length, 1); assert.equal(ended[index][0].status, 404); }
    } finally { release.resolve(); await pending.catch(() => {}); f.storage.read = read; }
  });

  test(`${adapter}: closing the store during a pending publication does not deliver another private view`, async t => {
    const f = await fixture(t, { sqlite }), room = await f.seed('rummikub'), views = [[], [], []], ended = [[], [], []];
    for (let index = 0; index < 3; index++) await f.subscribe(room, users[index], view => views[index].push(view),
      (reason, status) => ended[index].push({ reason, status }));
    const counts = views.map(values => values.length), read = f.storage.read.bind(f.storage), gate = deferred(), release = deferred();
    let presenceReads = 0;
    f.storage.read = async (...args) => {
      const record = await read(...args);
      if (args[0] === 'room-presence' && ++presenceReads === 2) { gate.resolve(); await release.promise; }
      return record;
    };
    await f.changePublication(room);
    const pending = f.rooms.sweep(); let stopped;
    try {
      await gate.promise; stopped = f.rooms.close(); release.resolve(); await pending; await stopped;
      for (let index = 0; index < 3; index++) { assert.equal(views[index].length, counts[index]); assert.equal(ended[index].length, 1); }
      await assert.rejects(f.rooms.getGameContext(room.code, users[0], { includeView: false }), failure('STORE_CLOSED'));
    } finally { release.resolve(); await pending.catch(() => {}); await stopped; f.storage.read = read; }
  });
}
