import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRoomStore, RoomError } from './rooms.mjs';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createRoomChat } from '../server/chat.mjs';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey, recordKey } from '../server/storage.mjs';

const gameTypes = ['rummikub', 'army-flip', 'flying-chess', 'draw-and-guess'];
const users = ['owner', 'guest', 'spectator', 'outsider'].map(sub => identityKey('urn:chat-authority-test', sub));
const failure = code => error => error instanceof RoomError && error.code === code;
const words = Array.from({ length: 12 }, (_, index) => ({ id: `chat-word-${index + 1}`, answer: `私密画词${index + 1}`,
  aliases: [`暗号${index + 1}`], category: 'daily', categoryName: '日常', difficulty: 'easy', language: 'zh',
  packId: 'chat-pack', packVersion: '1', definitionVersion: 1, source: '原创测试', status: 'reviewed',
  hintLength: [...`私密画词${index + 1}`].length, tags: [], drawingCue: '服务器绘画提示' }));
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };

// Real rules build the saved rooms; real encrypted adapters enforce the guard.
// Method counters observe validation and projection, not a substitute engine.
function fixture(t, { sqlite, ttlMs = 600000 } = {}) {
  let time = 1000, sequence = 0, nextCode = 234560;
  const now = () => time, builders = [];
  const counts = { imports: 0, private: 0, spectator: 0, reads: new Map() };
  const control = { privateFailure: false, readGate: null };
  const registry = createGameRegistry(gameTypes.map(gameType => {
    const adapter = defaultGameRegistry.gameAdapter(gameType);
    return { ...adapter,
      snapshotProblem(...args) { counts.imports++; return adapter.snapshotProblem(...args); },
      privateView(...args) {
        counts.private++;
        if (control.privateFailure) throw new Error('synthetic private projection failure');
        return adapter.privateView(...args);
      },
      spectatorView(...args) { counts.spectator++; return adapter.spectatorView(...args); },
    };
  }));
  const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(':memory:', { now }) : new MemoryAdapter({ now }), randomBytes(32), now);
  const monitored = new Proxy(storage, { get(target, field) {
    if (field === 'read') return async (scope, id) => {
      counts.reads.set(scope, (counts.reads.get(scope) ?? 0) + 1);
      const record = await target.read(scope, id), gate = control.readGate;
      if (gate?.scope === scope && (!gate.id || gate.id === id)) {
        gate.entered.resolve(); await gate.release.promise;
      }
      return record;
    };
    const value = target[field]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const settings = { now, ttlMs, pausedTtlMs: ttlMs * 7, turnTimeoutMs: 1800000, serverRandomInt: () => 0,
    gameOptions: { firstTurnIndex: 0, randomInt: max => max - 1, frozenCandidates: words } };
  const rooms = createDurableRoomStore({ storage: monitored, ...settings, gameRegistry: registry, pollIntervalMs: 0 });
  const chat = createRoomChat({ storage: monitored, rooms, now, pollIntervalMs: 0 });
  t.after(async () => {
    control.readGate?.release.resolve(); chat.close(); await rooms.close();
    for (const builder of builders) builder.close();
    storage.close();
  });
  async function seed(gameType = 'draw-and-guess', { playing = true, spectators = true, drawing = false } = {}) {
    const code = String(nextCode++), roomId = randomBytes(16).toString('hex');
    const builder = createRoomStore(settings); builders.push(builder);
    builder.createTrustedRoom(users[0], '共同昵称', { code, roomId, gameType });
    builder.joinTrustedRoom(code, users[1], '共同昵称');
    if (spectators) builder.joinTrustedRoom(code, users[2], '共同昵称', { role: 'spectator' });
    function act(user, type, fields = {}) {
      const view = builder.getTrustedView(code, user);
      return builder.trustedAction(code, user, { type, requestId: `chat-action-${++sequence}`, expectedRevision: view.revision, ...fields });
    }
    if (gameType === 'draw-and-guess') act(users[0], 'configure', { drawConfig: { rounds: 2, drawingSeconds: 120,
      contentSelection: { packId: 'chat-pack', version: 1, categoryIds: ['daily'], difficulties: ['easy'] } } });
    if (playing) {
      act(users[0], 'ready', { ready: true }); act(users[1], 'ready', { ready: true }); act(users[0], 'start');
    }
    function choose() {
      const snapshot = builder.exportSnapshot(code), user = users.find(key => snapshot.players.find(player => player.userKey === key)?.id === snapshot.game.turnPlayerId);
      const view = builder.getTrustedView(code, user), selected = view.game.candidates[0];
      act(user, 'choose', { matchId: view.matchId, turnId: view.game.turnId, candidateId: selected.id }); return selected;
    }
    if (drawing) choose();
    await storage.put('room-invites', code, { roomId });
    await storage.put('rooms', roomId, { snapshot: builder.exportSnapshot(code), joins: {} });
    async function save() {
      const previous = await storage.read('rooms', roomId);
      assert.equal(await storage.replaceCAS('rooms', roomId, previous.version, { ...previous.value, snapshot: builder.exportSnapshot(code) }), true);
      return storage.read('rooms', roomId);
    }
    return { code, roomId, builder, act, save, choose };
  }
  async function edit(room, change) {
    const previous = await storage.read('rooms', room.roomId); change(previous.value.snapshot);
    assert.equal(await storage.replaceCAS('rooms', room.roomId, previous.version, previous.value), true);
    return storage.read('rooms', room.roomId);
  }
  function gate(scope, id) {
    const gate = { scope, id, entered: deferred(), release: deferred() }; control.readGate = gate;
    return { entered: gate.entered.promise, release() { control.readGate = null; gate.release.resolve(); } };
  }
  return { rooms, chat, storage, seed, edit, gate, counts, control, now, setTime(value) { time = value; },
    reset() { counts.imports = 0; counts.private = 0; counts.spectator = 0; counts.reads.clear(); } };
}

for (const sqlite of [false, true]) {
  const backing = sqlite ? 'SQLite' : 'Memory';
  test(`${backing}: four actual games validate once per saved version, resolve chat members without private output and retain exact guards`, async t => {
    const f = fixture(t, { sqlite });
    for (const gameType of gameTypes) {
      const room = await f.seed(gameType), saved = await f.storage.read('rooms', room.roomId); f.reset();
      for (const user of users.slice(0, 3)) {
        const member = await f.rooms.getChatMember(room.code, user), player = [...saved.value.snapshot.players, ...saved.value.snapshot.spectators].find(player => player.userKey === user);
        assert.deepEqual(Object.keys(member).sort(), ['guard', 'name', 'playerId', 'roomId', ...(gameType === 'draw-and-guess' ? ['chatProblem'] : [])].sort());
        assert.equal(member.playerId, player.id); assert.equal(member.name, player.name); assert.equal(member.roomId, room.roomId);
        assert.deepEqual(member.guard, { scope: 'rooms', id: room.roomId, version: saved.version, validUntil: saved.value.snapshot.lastActiveAt + 600000 });
        for (const forbidden of ['rack', 'answer', 'candidates', 'userKey', 'tokenHash', 'game', 'view']) assert.equal(Object.hasOwn(member, forbidden), false);
        assert.equal(JSON.stringify(member).includes(words[0].answer), false);
      }
      assert.equal(f.counts.imports, 1); assert.equal(f.counts.private, 1, 'complete import still validates the actual private projection');
      assert.equal(f.counts.spectator, 0); assert.equal(f.counts.reads.get('room-presence'), undefined);
      assert.equal(f.counts.reads.get('game-profiles'), 3); assert.equal(f.counts.reads.get('rooms'), 3);
      assert.deepEqual(await f.storage.read('rooms', room.roomId), saved, 'chat lookup does not renew or rewrite a room');
      const authority = await f.rooms.getGameContext(room.code, users[2], { includeView: false });
      assert.equal(authority.role, 'spectator'); assert.equal(f.counts.imports, 1);
      assert.equal(JSON.stringify(authority).includes('共同昵称'), false, 'member metadata is not added to domain authority output');
      const member = await f.rooms.getChatMember(room.code, users[0]);
      assert.equal(await f.storage.guardedCAS('chat-authority-proof', room.roomId, null, { saved: true }, Number.MAX_SAFE_INTEGER, member.guard), true);
    }
  });

  test(`${backing}: same-name outsiders stay denied; actual role change, leave and closed room invalidate membership`, async t => {
    const f = fixture(t, { sqlite }), room = await f.seed('rummikub', { playing: false });
    const first = await f.rooms.getChatMember(room.code, users[1]);
    await f.rooms.setProfile(users[3], '共同昵称');
    await assert.rejects(f.rooms.getChatMember(room.code, users[3]), failure('SEAT_REQUIRED'));
    await assert.rejects(f.rooms.getChatMember(room.code, { userKey: users[0], roles: ['admin'] }), failure('INVALID_IDENTITY'));
    room.act(users[1], 'set-role', { role: 'spectator' }); await room.save();
    assert.equal((await f.rooms.getChatMember(room.code, users[1])).playerId, first.playerId);
    assert.equal((await f.rooms.getGameContext(room.code, users[1], { includeView: false })).role, 'spectator');
    room.act(users[1], 'leave'); await room.save();
    await assert.rejects(f.rooms.getChatMember(room.code, users[1]), failure('SEAT_REQUIRED'));
    await f.storage.put('rooms', room.roomId, { snapshot: null, roomCode: room.code, reason: 'empty' });
    await assert.rejects(f.rooms.getChatMember(room.code, users[0]), failure('ROOM_NOT_FOUND'));
  });

  test(`${backing}: nickname is freshly read while validated saved names use the original NFC/trim fallback`, async t => {
    const f = fixture(t, { sqlite }), room = await f.seed('rummikub');
    await f.edit(room, snapshot => { snapshot.players[1].name = '  は\u3099  '; });
    const saved = await f.storage.read('rooms', room.roomId);
    assert.equal((await f.rooms.getChatMember(room.code, users[1])).name, 'ば');
    f.reset(); await f.rooms.setProfile(users[1], '当前棋牌昵称');
    assert.equal((await f.rooms.getChatMember(room.code, users[1])).name, '当前棋牌昵称');
    await f.rooms.setProfile(users[1], '再次改名');
    assert.equal((await f.rooms.getChatMember(room.code, users[1])).name, '再次改名');
    assert.equal(f.counts.imports, 0, 'changing a profile does not cache its nickname in room authority');
    await f.storage.remove('game-profiles', users[1]);
    assert.equal((await f.rooms.getChatMember(room.code, users[1])).name, 'ば');
    assert.deepEqual(await f.storage.read('rooms', room.roomId), saved);
    await f.edit(room, snapshot => { snapshot.players[1].name = '坏\n昵称'; });
    await assert.rejects(f.rooms.getChatMember(room.code, users[1]), failure('INVALID_SNAPSHOT'));
  });

  test(`${backing}: every new storage version retains four-game validation, including private projection failure and corrupt encrypted data`, async t => {
    const f = fixture(t, { sqlite });
    for (const gameType of gameTypes) {
      const room = await f.seed(gameType), valid = (await f.storage.read('rooms', room.roomId)).value;
      await f.rooms.getChatMember(room.code, users[0]); f.reset();
      await f.storage.put('rooms', room.roomId, valid);
      await f.rooms.getChatMember(room.code, users[1]); assert.equal(f.counts.imports, 1); assert.equal(f.counts.private, 1);
      await f.edit(room, snapshot => { snapshot.game.version = -1; });
      await assert.rejects(f.rooms.getChatMember(room.code, users[1]), failure('INVALID_SNAPSHOT'));
      await f.storage.put('rooms', room.roomId, valid); f.control.privateFailure = true;
      await assert.rejects(f.rooms.getChatMember(room.code, users[2]), failure('INVALID_SNAPSHOT'));
      f.control.privateFailure = false; await f.storage.put('rooms', room.roomId, valid);
      await f.rooms.getChatMember(room.code, users[0]);
      const key = recordKey('rooms', room.roomId), encoded = await f.storage.adapter.get(key);
      await f.storage.adapter.put(key, { ...encoded, payload: 'AA' });
      await assert.rejects(f.rooms.getChatMember(room.code, users[0]), failure('ROOM_NOT_FOUND'));
      await f.storage.adapter.put(key, encoded); f.reset();
      await f.rooms.getChatMember(room.code, users[0]); assert.equal(f.counts.imports, 1, 'same-version restoration after corruption must revalidate');
    }
  });

  test(`${backing}: legacy schema2/3 member names and seat guards preserve binding compatibility without synthesized writes`, async t => {
    const f = fixture(t, { sqlite });
    for (const [gameType, schemaVersion] of [['rummikub', 2], ['army-flip', 3]]) {
      const room = await f.seed(gameType, { playing: false, spectators: false });
      await f.edit(room, snapshot => {
        snapshot.schemaVersion = schemaVersion; delete snapshot.spectators; delete snapshot.turnClock; delete snapshot.roomId;
        if (schemaVersion === 2) delete snapshot.gameType;
      });
      const saved = await f.storage.read('rooms', room.roomId), member = await f.rooms.getChatMember(room.code, users[1]);
      assert.equal(member.roomId, room.roomId); assert.equal(member.playerId, saved.value.snapshot.players[1].id); assert.equal(member.name, '共同昵称');
      assert.equal(member.guard.version, saved.version); assert.deepEqual(await f.storage.read('rooms', room.roomId), saved);
      await f.storage.put('room-invites', '999999', { roomId: room.roomId });
      await assert.rejects(f.rooms.getChatMember('999999', users[1]), failure('INVALID_SNAPSHOT'));
      await f.edit(room, snapshot => { snapshot.roomId = 'f'.repeat(32); });
      await assert.rejects(f.rooms.getChatMember(room.code, users[1]), failure('INVALID_SNAPSHOT'));
    }
  });

  test(`${backing}: current drawing answers and aliases remain blocked through real chat, reveal and the next actual question`, async t => {
    const f = fixture(t, { sqlite }), room = await f.seed('draw-and-guess', { drawing: true });
    const firstGame = room.builder.exportSnapshot(room.code).game;
    const first = room.builder.getTrustedView(room.code, users[0]).game.word;
    for (const user of users.slice(0, 3)) {
      const member = await f.rooms.getChatMember(room.code, user);
      assert.equal(member.chatProblem(first.answer).code, 'ANSWER_IN_CHAT');
      assert.equal(member.chatProblem(first.aliases[0]).code, 'ANSWER_IN_CHAT');
      assert.equal(member.chatProblem('大家加油'), null);
    }
    await assert.rejects(f.chat.send(room.code, users[2], { text: first.answer, requestId: 'leak-answer' }), failure('ANSWER_IN_CHAT'));
    assert.equal((await f.chat.send(room.code, users[2], { text: '大家加油', requestId: 'spectator-chat' })).message.playerId,
      room.builder.exportSnapshot(room.code).spectators[0].id);
    f.setTime(firstGame.stageClock.deadlineAt);
    assert.equal(room.builder.applyTurnTimeout(room.code, room.builder.exportSnapshot(room.code).turnClock), true); await room.save();
    assert.equal((await f.rooms.getChatMember(room.code, users[1])).chatProblem(first.answer), null);
    const reveal = room.builder.exportSnapshot(room.code).game;
    f.setTime(reveal.stageClock.deadlineAt);
    assert.equal(room.builder.applyTurnTimeout(room.code, room.builder.exportSnapshot(room.code).turnClock), true);
    const next = room.choose(); await room.save();
    assert.notEqual(next.answer, first.answer);
    const current = await f.rooms.getChatMember(room.code, users[2]);
    assert.equal(current.chatProblem(next.answer).code, 'ANSWER_IN_CHAT'); assert.equal(current.chatProblem(first.answer), null);
    await assert.rejects(f.chat.send(room.code, users[1], { text: next.answer, requestId: 'new-answer' }), failure('ANSWER_IN_CHAT'));
    assert.equal((await f.chat.send(room.code, users[1], { text: first.answer, requestId: 'previous-answer' })).message.text, first.answer);
  });

  test(`${backing}: close or room TTL during profile read refuses a cached member and closed store does not start another read`, async t => {
    for (const reason of ['close', 'expiry']) {
      const f = fixture(t, { sqlite, ttlMs: 100 }), room = await f.seed('rummikub');
      const first = await f.rooms.getChatMember(room.code, users[0]), gate = f.gate('game-profiles');
      const pending = f.rooms.getChatMember(room.code, users[0]);
      const rejected = assert.rejects(pending, failure(reason === 'close' ? 'STORE_CLOSED' : 'ROOM_NOT_FOUND'));
      await gate.entered;
      if (reason === 'close') await f.rooms.close(); else f.setTime(first.guard.validUntil);
      gate.release(); await rejected;
      if (reason === 'close') {
        const reads = f.counts.reads.get('rooms');
        await assert.rejects(f.rooms.getChatMember(room.code, users[0]), failure('STORE_CLOSED'));
        assert.equal(f.counts.reads.get('rooms'), reads);
      }
    }
  });

  test(`${backing}: profile-read concurrency retains the old exact-version guard and a real history reread blocks a departed member`, async t => {
    const f = fixture(t, { sqlite }), room = await f.seed('rummikub', { playing: false });
    await f.rooms.getChatMember(room.code, users[1]);
    const gate = f.gate('game-profiles'), pending = f.rooms.getChatMember(room.code, users[1]); await gate.entered;
    room.act(users[1], 'leave'); await room.save(); gate.release();
    const previous = await pending;
    assert.equal(await f.storage.guardedCAS('chat-authority-proof', 'departed', null, { saved: true }, Number.MAX_SAFE_INTEGER, previous.guard), false);
    assert.equal(await f.storage.read('chat-authority-proof', 'departed'), null);
    await assert.rejects(f.rooms.getChatMember(room.code, users[1]), failure('SEAT_REQUIRED'));
    const other = await f.seed('rummikub', { playing: false });
    await f.chat.send(other.code, users[0], { text: '仅成员可读', requestId: 'history' });
    const readGate = f.gate('room-chat', other.roomId), history = f.chat.get(other.code, users[1]);
    const denied = assert.rejects(history, failure('SEAT_REQUIRED')); await readGate.entered;
    other.act(users[1], 'leave'); await other.save(); readGate.release(); await denied;
  });
}
