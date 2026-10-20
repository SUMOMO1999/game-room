import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRoomStore } from './rooms.mjs';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { createHyakkiAdapter, createHyakkiTransitionPreparers } from '../server/games/hyakki-trading/adapter.mjs';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { EncryptedStore, SQLiteAdapter, decryptStoredRecord } from '../server/storage.mjs';
import { backupStore, verifyBackup, restoreStore } from '../server/backup.mjs';
import { createHyakkiEventStore, HYAKKI_EVENT_SCOPES, HYAKKI_EVENT_FOREVER,
  HYAKKI_EVENT_GROUP_MAX_BYTES, HYAKKI_EVENT_FINISH_RESERVE_BYTES,
  validateHyakkiEventState, validateHyakkiEventRecord, validateHyakkiPublicEvent } from '../server/games/hyakki-trading/event-store.mjs';
import { projectPublicBattleMetadata, publicBattleMetadataProblem } from './games/hyakki-trading/battle-public-metadata.mjs';
import { materialProfileFor, CONTENT_VERSION, PLAYER_COUNT_CONTENT_VERSION } from './games/hyakki-trading/content/definitions.mjs';
import { definition } from './games/hyakki-trading/model.mjs';
import { gameProblem } from './games/hyakki-trading/validation.mjs';
import { currentDecision } from './games/hyakki-trading/decision.mjs';
import { historyPacketProblem } from './games/hyakki-trading/room-controller.mjs';
import { buildBattleReport, discardProvenance } from './games/hyakki-trading/battle-report-model.mjs';

const users = Array.from({ length: 6 }, (_, i) => String(i + 1).padStart(64, '0'));
const presence = (snapshot, now) => ({ observedAt: now, seats: snapshot.players.map(player => ({ playerId: player.id,
  connected: true, lastSeenAt: now, leaseExpiresAt: now + 10000, absenceSinceAt: null })) });
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
async function decodedRows(storage) {
  return (await Promise.all(Object.values(HYAKKI_EVENT_SCOPES).map(async scope => (await storage.adapter.entries(scope)).map(row => ({
    scope, key: row.key, value: decryptStoredRecord(storage.key, row.key, row), expiresAt: row.expiresAt,
    payloadBytes: Buffer.byteLength(row.payload),
  }))))).flat();
}

async function fixture(t, arrange) {
  const directory = mkdtempSync(join(tmpdir(), 'hyakki-player-count-events-')), sourcePath = join(directory, 'source.sqlite');
  const key = Buffer.alloc(32, 63), opened = [], owners = []; let at = 10000, request = 0;
  t.after(() => { owners.forEach(rooms => rooms.close()); opened.forEach(storage => storage.close()); rmSync(directory, { recursive: true, force: true }); });
  const now = () => at;
  const adapter = createHyakkiAdapter(), gameRegistry = createGameRegistry([
    ...defaultGameRegistry.knownTypes().filter(type => type !== 'hyakki-trading').map(type => defaultGameRegistry.gameAdapter(type)), adapter,
  ]);
  const owner = () => { const rooms = createRoomStore({ gameRegistry, now, serverRandomInt: n => n - 1 }); owners.push(rooms); return rooms; };
  const open = path => { const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now); opened.push(storage); return storage; };
  const first = owner(), host = first.createTrustedRoom(users[0], '甲', { gameType: 'hyakki-trading', code: '234567', roomId: 'e'.repeat(32) });
  for (const [i, user] of users.slice(1).entries()) first.joinTrustedRoom(host.roomCode, user, `玩家${i + 2}`);
  function act(rooms, user, type, extra = {}) {
    const snapshot = rooms.exportSnapshot(host.roomCode);
    return rooms.trustedAction(host.roomCode, user, { type, requestId: `material-${++request}`,
      expectedRevision: snapshot.revision, ...extra }, { connected: Object.fromEntries(snapshot.players.map(player => [player.id, true])),
      presence: presence(snapshot, at) });
  }
  for (const user of users) act(first, user, 'ready', { ready: true });
  act(first, users[0], 'start');
  const snapshot = first.exportSnapshot(host.roomCode), game = snapshot.game;
  assert.equal(snapshot.schemaVersion, 21); assert.equal(game.contentVersion, PLAYER_COUNT_CONTENT_VERSION);
  // A complete, conserved boundary fixture, not a claimed naturally played
  // full match. All following choices use real room/domain actions and CAS.
  const all = [...game.deck, ...game.players.flatMap(player => player.hand)];
  game.deck = []; game.discard = []; game.players.forEach(player => { player.hand = []; player.tools = []; });
  arrange(game, all);
  assert.equal(gameProblem(game), null); assert.equal(adapter.roomStateProblem(snapshot, true), null);
  const rooms = owner(); rooms.importSnapshot(snapshot);
  const storage = open(sourcePath), events = createHyakkiEventStore({ storage, now });
  async function save(before, next) {
    const state = next.game, metadata = projectPublicBattleMetadata(before?.game, state);
    const descriptor = { roomId: next.roomId, matchId: next.matchId, ruleVersion: state.ruleVersion,
      contentVersion: state.contentVersion, startedAt: next.matchStartedAt,
      participants: next.matchParticipants.map(player => ({ seatId: player.playerId, userKey: player.userKey })) };
    const prepared = await events.prepareAppend({ schemaVersion: 3, contentVersion: state.contentVersion,
      playerCount: state.players.length, ...metadata, match: descriptor, sequence: state.publicEventSequence,
      commitId: `boundary-${state.publicEventSequence}`, committedAt: state.committedAt, mode: 'normal', events: state.lastPublicEvents });
    const previous = await storage.read('rooms', next.roomId);
    assert.equal(await storage.compareAndSwapMany({ ...prepared, changes: [...prepared.changes, { scope: 'rooms', id: next.roomId,
      expectedVersion: previous?.version ?? null, value: { snapshot: next }, expiresAt: HYAKKI_EVENT_FOREVER }] }), true);
    return metadata;
  }
  await save(null, snapshot);
  async function step(type, extra = {}) {
    const before = rooms.exportSnapshot(host.roomCode), state = before.game;
    const decision = currentDecision(state), actorId = decision?.actorId ?? state.turnPlayerId;
    const user = before.matchParticipants.find(player => player.playerId === actorId).userKey;
    at++;
    act(rooms, user, type, { matchId: state.matchId, turnId: state.turnId,
      ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}), ...extra });
    const next = rooms.exportSnapshot(host.roomCode), metadata = await save(before, next);
    return { before, next, metadata };
  }
  return { directory, sourcePath, key, gameRegistry, rooms, host, storage, events, open, owner, now, step };
}

test('246-card conserved fixture discards a real 245-card target to three in one encrypted transaction', async t => {
  const f = await fixture(t, (game, all) => {
    const actor = game.players.find(player => player.id === game.turnPlayerId), target = game.players.find(player => player !== actor);
    const index = all.findIndex(id => definition(id).sourceCode === 'C08'); actor.hand = [all.splice(index, 1)[0]];
    target.hand = all; game.stage = 'use'; game.drawStarted = true;
  });
  let snapshot = f.rooms.exportSnapshot(f.host.roomCode), actor = snapshot.game.players.find(p => p.id === snapshot.game.turnPlayerId);
  const targetId = snapshot.game.players.find(p => p.hand.length === 245).id;
  await f.step('play-character', { cardId: actor.hand[0], params: { targetId } });
  await f.step('choose-effect', { selection: { branch: 'discard' } });
  snapshot = f.rooms.exportSnapshot(f.host.roomCode);
  const ids = snapshot.game.players.find(p => p.id === targetId).hand.slice(0, -3);
  const { next, metadata } = await f.step('choose-effect', { selection: { cardIds: ids } });
  assert.equal(next.game.players.find(p => p.id === targetId).hand.length, 3);
  assert.equal(next.game.discard.length, 243);
  assert.equal(publicBattleMetadataProblem(metadata, next.game.players.map(p => p.id), materialProfileFor(next.game)), null);
  assert(publicBattleMetadataProblem(metadata, next.game.players.map(p => p.id)));
  const state = validateHyakkiEventState(await decodedRows(f.storage), { rooms: [next], now: f.now() });
  const group = state.groups.at(-1), measured = Buffer.byteLength(JSON.stringify(group));
  assert(measured <= HYAKKI_EVENT_GROUP_MAX_BYTES);
  assert.equal(state.reservedBytes, HYAKKI_EVENT_FINISH_RESERVE_BYTES);
  const packet = (await f.events.readPage({ matchId: next.matchId })).page;
  assert.equal(historyPacketProblem(packet, { ...next, game: next.game }), null);
  assert(!JSON.stringify(packet).includes('#')); assert(!JSON.stringify(packet).includes('userKey'));
  t.diagnostic(JSON.stringify({ deckSize: 246, targetBefore: 245, targetAfter: 3, discarded: 243, groupBytes: measured,
    groupMaxBytes: HYAKKI_EVENT_GROUP_MAX_BYTES, reserveBytes: HYAKKI_EVENT_FINISH_RESERVE_BYTES }));
});

test('real maximum top-discard exchange stays within 32 KiB and restores group3 metadata through a new backup path', async t => {
  const f = await fixture(t, (game, all) => {
    const actor = game.players.find(player => player.id === game.turnPlayerId), index = all.findIndex(id => definition(id).sourceCode === 'T07');
    actor.tools = [{ cardId: all.splice(index, 1)[0], exhausted: false }]; actor.hand = [all.shift()]; game.discard = all;
  });
  let snapshot = f.rooms.exportSnapshot(f.host.roomCode), actor = snapshot.game.players.find(p => p.id === snapshot.game.turnPlayerId);
  await f.step('activate-tool', { cardId: actor.tools[0].cardId });
  snapshot = f.rooms.exportSnapshot(f.host.roomCode); actor = snapshot.game.players.find(p => p.id === snapshot.game.turnPlayerId);
  const { next, metadata } = await f.step('choose-effect', { selection: { cardId: actor.hand[0] } });
  const state = validateHyakkiEventState(await decodedRows(f.storage), { rooms: [next], now: f.now() }), group = state.groups.at(-1);
  const measured = Buffer.byteLength(JSON.stringify(group));
  assert(measured > 31 * 1024, `actual boundary measured ${measured}`);
  assert(measured <= HYAKKI_EVENT_GROUP_MAX_BYTES);
  const legacy = { ...group, schemaVersion: 2 }; delete legacy.contentVersion; delete legacy.playerCount;
  const { fingerprint: oldFingerprint, ...legacyBody } = legacy; legacy.fingerprint = fingerprint(legacyBody);
  assert.throws(() => validateHyakkiEventRecord(HYAKKI_EVENT_SCOPES.events, legacy));
  const artifact = join(f.directory, 'backup.sqlite'), restored = join(f.directory, 'restored.sqlite');
  await backupStore({ sourcePath: f.sourcePath, destinationPath: artifact, key: f.key, now: f.now, gameRegistry: f.gameRegistry });
  assert.equal(verifyBackup({ sourcePath: artifact, key: f.key, gameRegistry: f.gameRegistry }).hyakkiEventsIncluded, true);
  restoreStore({ sourcePath: artifact, destinationPath: restored, key: f.key, gameRegistry: f.gameRegistry, offline: true });
  const recovered = f.open(restored), recoveredSnapshot = (await recovered.read('rooms', next.roomId)).value.snapshot;
  assert.deepEqual(recoveredSnapshot, next);
  const recoveredRooms = f.owner(); recoveredRooms.importSnapshot(recoveredSnapshot);
  const page = (await createHyakkiEventStore({ storage: recovered, now: f.now }).readPage({ matchId: next.matchId })).page;
  assert.equal(historyPacketProblem(page, next), null);
  const report = buildBattleReport(page.groups, { players: next.game.players, game: next.game, coverage: { complete: true } });
  assert.equal(report.partial, false); assert.equal(report.turns[0].groups.length, 3);
  assert.equal(discardProvenance(page.groups, next.game.discard.map(id => ({ id: definition(id).id }))).length, 244);
  const recoveredGroups = validateHyakkiEventState(await decodedRows(recovered), { rooms: [next], now: f.now() }).groups;
  assert.deepEqual(recoveredGroups.sort((a, b) => a.sequence - b.sequence), state.groups.sort((a, b) => a.sequence - b.sequence));
  t.diagnostic(JSON.stringify({ action: 'paper-top-exchange', discardCount: 244, removed: metadata.discard.removed.length,
    added: metadata.discard.added.length, groupBytes: measured, backupNewPathRestored: true }));
});

test('a correctly fingerprinted group cannot change its frozen match player count', async t => {
  const f = await fixture(t, (game, all) => { game.deck = all; });
  const rows = await decodedRows(f.storage), changed = structuredClone(rows);
  const group = changed.find(row => row.scope === HYAKKI_EVENT_SCOPES.events).value;
  group.playerCount = 2;
  const { fingerprint: oldFingerprint, ...body } = group; group.fingerprint = fingerprint(body);
  // Same-width count/fingerprint leave the encrypted quota unchanged, so this
  // exercises the match binding rather than a size or digest failure.
  assert.doesNotThrow(() => validateHyakkiEventRecord(HYAKKI_EVENT_SCOPES.events, group));
  assert.throws(() => validateHyakkiEventState(changed), error => error.code === 'GAME_HISTORY_CORRUPT');
  assert.equal(validateHyakkiEventState(rows).groups[0].playerCount, 6);
});

test('history page rejects wrong counts, unknown content, private fields and silent group3 downgrade', () => {
  const ids = users.slice(0, 6).map(id => id.slice(-32)), roomId = 'f'.repeat(32), id = 'a'.repeat(32);
  const room = { roomId, matchId: id, game: { contentVersion: PLAYER_COUNT_CONTENT_VERSION, goodsPerType: 18, players: ids.map(id => ({ id })) } };
  const group = { schemaVersion: 3, contentVersion: PLAYER_COUNT_CONTENT_VERSION, playerCount: 6, roomId, matchId: id,
    sequence: 1, committedAt: 10, events: [{ type: 'match-started' }], turn: { id: 'turn-1', number: 1, round: 1, ownerSeatId: ids[0] },
    sourceCardId: null, changes: [], discard: { beforeCount: 0, afterCount: 0, removed: [], added: [] } };
  const packet = { roomId, matchId: id, groups: [group], nextAfter: 1, headSequence: 1, hasMore: false };
  assert.equal(historyPacketProblem(packet, room), null);
  for (const mutate of [p => { p.groups[0].playerCount = 2; }, p => { p.groups[0].contentVersion = 'unknown'; },
    p => { p.groups[0].events[0].hand = ['private']; }, p => { p.groups[0].discard.afterCount = 247; },
    p => { p.groups[0].schemaVersion = 2; delete p.groups[0].contentVersion; delete p.groups[0].playerCount; }]) {
    const invalid = structuredClone(packet); mutate(invalid); assert(historyPacketProblem(invalid, room));
  }
  const legacy = structuredClone(packet); legacy.groups[0].schemaVersion = 2;
  delete legacy.groups[0].contentVersion; delete legacy.groups[0].playerCount;
  assert.equal(historyPacketProblem(legacy, { ...room, game: { ...room.game, contentVersion: CONTENT_VERSION } }), null);
  assert.throws(() => validateHyakkiPublicEvent({ type: 'cards-revealed', actorSeatId: ids[0], cardIds: Array(247).fill('yousei.g01') },
    { contentVersion: PLAYER_COUNT_CONTENT_VERSION, playerCount: 6, deckSize: Infinity }));
  assert.throws(() => validateHyakkiPublicEvent({ type: 'match-started' }, { contentVersion: 'unknown', playerCount: 6 }));
});

for (const count of [2, 3, 4, 5, 6]) test(`${count} naturally dealt seats restore group3 in a new process and continue one real draw`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hyakki-profile-process-')), sourcePath = join(directory, 'source.sqlite');
  const key = Buffer.alloc(32, 71), now = () => 10000, activeUsers = users.slice(0, count), streams = [];
  const storage = new EncryptedStore(new SQLiteAdapter(sourcePath, { now }), key, now);
  const gameRegistry = createGameRegistry([...defaultGameRegistry.knownTypes().filter(type => type !== 'hyakki-trading')
    .map(type => defaultGameRegistry.gameAdapter(type)), createHyakkiAdapter()],
  { creationTypes: [...defaultGameRegistry.creationTypes(), 'hyakki-trading'] });
  const runtime = createRuntime(readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), { storage, sessions: {}, now, gameRegistry,
    roomOptions: { pollIntervalMs: 0, serverRandomInt: n => n - 1, transitionPreparers: createHyakkiTransitionPreparers(storage, { now }) },
    chatOptions: { pollIntervalMs: 0 } });
  t.after(async () => { runtime.preview.close(); await runtime.chat.close(); for (const stop of streams) await stop();
    await runtime.rooms.close(); storage.close(); rmSync(directory, { recursive: true, force: true }); });
  const host = await runtime.rooms.createRoom(activeUsers[0], '原始发牌', 'natural-create', 'hyakki-trading');
  for (const [index, user] of activeUsers.slice(1).entries()) await runtime.rooms.joinRoom(host.roomCode, user, `玩家${index + 2}`, `natural-join-${index}`);
  for (const user of activeUsers) streams.push(await runtime.rooms.subscribe(host.roomCode, user, () => {}, () => {}));
  let sequence = 0;
  async function action(user, type, extra = {}) {
    const view = await runtime.rooms.getView(host.roomCode, user);
    return runtime.rooms.action(host.roomCode, user, { type, requestId: `natural-${++sequence}`, expectedRevision: view.revision, ...extra });
  }
  for (const user of activeUsers) await action(user, 'ready', { ready: true });
  await action(activeUsers[0], 'start');
  const before = (await storage.read('rooms', host.view.roomId)).value.snapshot;
  assert.equal(before.schemaVersion, 21); assert.equal(before.game.contentVersion, PLAYER_COUNT_CONTENT_VERSION);
  assert.equal(before.game.players.length, count); assert(before.game.players.every(player => player.hand.length === 5));
  assert.equal(before.game.goodsPerType, 3 * count);
  assert.equal(materialProfileFor(before.game).deckSize, [110, 144, 178, 212, 246][count - 2]);
  const initial = (await storage.scan(HYAKKI_EVENT_SCOPES.events)).map(row => row.value);
  assert.equal(initial.length, 1); assert.equal(initial[0].schemaVersion, 3); assert.equal(initial[0].playerCount, count);
  const artifact = join(directory, 'backup.sqlite'), destination = join(directory, 'new-process.sqlite');
  const keyPath = join(directory, 'test.key'), fixturePath = join(directory, 'fixture.json');
  await backupStore({ sourcePath, destinationPath: artifact, key, now, gameRegistry });
  restoreStore({ sourcePath: artifact, destinationPath: destination, key, gameRegistry, offline: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(fixturePath, JSON.stringify({ before, users: activeUsers }), { mode: 0o600 });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
    import { EncryptedStore, SQLiteAdapter } from './server/storage.mjs';
    import { readSettings } from './server/config.mjs'; import { createRuntime } from './server/runtime.mjs';
    import { closeRuntime } from './server/production.mjs';
    import { createGameRegistry, defaultGameRegistry } from './app/game-registry.mjs';
    import { createHyakkiAdapter, createHyakkiTransitionPreparers } from './server/games/hyakki-trading/adapter.mjs';
    import { createHyakkiEventStore } from './server/games/hyakki-trading/event-store.mjs';
    import { gameProblem } from './app/games/hyakki-trading/validation.mjs';
    import { materialProfileFor, PLAYER_COUNT_CONTENT_VERSION } from './app/games/hyakki-trading/content/definitions.mjs';
    const [path, keyPath, fixturePath] = process.argv.slice(1), { before, users } = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const now = () => 10001, storage = new EncryptedStore(new SQLiteAdapter(path, { now }), readFileSync(keyPath), now);
    const gameRegistry = createGameRegistry([...defaultGameRegistry.knownTypes().filter(type => type !== 'hyakki-trading')
      .map(type => defaultGameRegistry.gameAdapter(type)), createHyakkiAdapter()], { creationTypes: defaultGameRegistry.creationTypes() });
    const runtime = createRuntime(readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), { storage, sessions: {}, now, gameRegistry,
      roomOptions: { pollIntervalMs: 0, transitionPreparers: createHyakkiTransitionPreparers(storage, { now }) }, chatOptions: { pollIntervalMs: 0 } });
    const streams = [];
    try {
      await runtime.rooms.ready;
      await runtime.rooms.getView(before.code, users[0]);
      const recovered = (await storage.read('rooms', before.roomId)).value.snapshot;
      assert.equal(recovered.schemaVersion, 21); assert.equal(recovered.game.contentVersion, PLAYER_COUNT_CONTENT_VERSION);
      assert.equal(gameProblem(recovered.game), null); assert.deepEqual(recovered.game.players, before.game.players);
      assert.deepEqual(recovered.game.deck, before.game.deck); assert.deepEqual(recovered.matchParticipants, before.matchParticipants);
      assert.equal(gameRegistry.creationTypes().includes('hyakki-trading'), false);
      for (const user of users) streams.push(await runtime.rooms.subscribe(before.code, user, () => {}, () => {}));
      const actor = before.matchParticipants.find(player => player.playerId === before.game.turnPlayerId).userKey;
      let view = await runtime.rooms.getView(before.code, actor);
      assert.equal(view.phase, 'playing');
      const result = await runtime.rooms.action(before.code, actor, { type: 'peek', requestId: 'fresh-process-peek',
        expectedRevision: view.revision, matchId: view.matchId, turnId: view.game.turnId });
      assert.equal(result.error, undefined);
      view = await runtime.rooms.getView(before.code, actor);
      await runtime.rooms.action(before.code, actor, { type: 'keep-peek', requestId: 'fresh-process-keep', expectedRevision: view.revision,
        matchId: view.matchId, turnId: view.game.turnId, effectId: view.game.pending.id, decisionId: view.game.pending.decisionId });
      const after = (await storage.read('rooms', before.roomId)).value.snapshot;
      assert.equal(gameProblem(after.game), null); assert.equal(after.game.deck.length, before.game.deck.length - 1);
      assert.equal(after.game.players.find(player => player.id === before.game.turnPlayerId).hand.length, 6);
      const page = (await createHyakkiEventStore({ storage, now }).readPage({ matchId: before.matchId })).page;
      assert(page.groups.every(group => group.schemaVersion === 3 && group.contentVersion === PLAYER_COUNT_CONTENT_VERSION && group.playerCount === users.length));
      assert(page.groups.some(group => group.events.some(event => event.type === 'draw-kept')));
      console.log(JSON.stringify({ playerCount: users.length, deckSize: materialProfileFor(after.game).deckSize,
        schemaVersion: 21, groupVersion: 3, newProcessReadAndWrite: true, naturalHandsPreserved: true }));
    } finally { for (const stop of streams) await stop(); await closeRuntime(runtime); }
  `, destination, keyPath, fixturePath], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const proof = JSON.parse(child.stdout); assert.equal(proof.playerCount, count); assert.equal(proof.newProcessReadAndWrite, true);
  t.diagnostic(JSON.stringify(proof));
});
