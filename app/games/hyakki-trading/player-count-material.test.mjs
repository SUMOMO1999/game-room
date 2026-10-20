import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, GOODS, CONTENT_VERSION, PLAYER_COUNT_CONTENT_VERSION, DIGITAL_RULE_VERSION,
  createDeck, materialProfile, materialProfileFor, definitionIdForCopy } from './content/definitions.mjs';
import { playerCountProfile, recommendedGoodsPerType } from './content/player-count-profile.mjs';
import { createGame, applyGameAction, currentDecision, gameProblem } from './rules.mjs';
import { definition } from './model.mjs';
import { privateView, spectatorView } from './view.mjs';
import { chooseHyakkiPracticeAction } from './practice-bot.mjs';
import { createHyakkiAdapter } from '../../../server/games/hyakki-trading/adapter.mjs';
import { snapshotFormatProblem, snapshotHasRoles, snapshotAuthorityBindingProblem } from '../../../server/room-snapshot-compat.mjs';
import { createHyakkiPracticeSession, decodeHyakkiPractice, PRACTICE_STORAGE_KEY } from './practice-engine.mjs';
import { createRoomStore } from '../../rooms.mjs';
import { createGameRegistry, defaultGameRegistry } from '../../game-registry.mjs';

const seats = Array.from({ length: 6 }, (_, i) => (i + 1).toString(16).padStart(32, '0'));
const context = { now: 1000, randomInt: limit => limit - 1 };
const fresh = (count, options = {}) => createGame(seats.slice(0, count), { ...context, matchId: 'a'.repeat(32), ...options });
function command(state, type, fields = {}, actorId = currentDecision(state)?.actorId ?? state.turnPlayerId) {
  const decision = currentDecision(state);
  return applyGameAction(state, actorId, { type, matchId: state.matchId, turnId: state.turnId,
    ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}), ...fields }, context);
}
function accept(state, type, fields, actorId) {
  const next = command(state, type, fields, actorId); assert.equal(next.ok, true, next.error);
  assert.equal(gameProblem(next.state), null); return next.state;
}
function arranged(count, version = PLAYER_COUNT_CONTENT_VERSION) {
  const state = fresh(count, { contentVersion: version, actionLimit: 10 });
  state.deck = createDeck({ contentVersion: version, playerCount: count }).map(card => card.id);
  state.players.forEach(owner => { owner.hand = []; }); state.stage = 'use'; state.drawStarted = true;
  return state;
}
function give(state, index, code, copy = 1) {
  const id = state.deck.find(id => definition(id).sourceCode === code && id.endsWith(`#${String(copy).padStart(2, '0')}`));
  assert.ok(id, `${code} copy ${copy} exists`); state.deck.splice(state.deck.indexOf(id), 1); state.players[index].hand.push(id); return id;
}
const materialIds = state => [...state.deck, ...state.discard, ...state.players.flatMap(player => [...player.hand, ...player.tools.map(tool => tool.cardId)]),
  ...(state.pending?.poolCards ?? []), ...(state.pending?.sourceCards ?? [])];

for (const [count, total, boards] of [[2, 110, 5], [3, 144, 7], [4, 178, 9], [5, 212, 11], [6, 246, 13]]) {
  test(`${count} seats: exact material, fixed attack counts and symmetric six-good recipe weights`, () => {
    const profile = playerCountProfile(count), deck = createDeck({ contentVersion: PLAYER_COUNT_CONTENT_VERSION, playerCount: count });
    assert.equal(profile.deckSize, total); assert.equal(profile.stallBoards, boards);
    assert.equal(profile.goodsPerTypeRecommended, count * 3); assert.equal(recommendedGoodsPerType(count), count * 3);
    assert.equal(deck.length, total); assert.equal(new Set(deck.map(copy => copy.id)).size, total);
    const counts = Object.fromEntries(CARDS.map(card => [card.sourceCode, deck.filter(copy => copy.definitionId === card.id).length]));
    for (const card of CARDS) {
      const extra = count - 2, code = card.sourceCode;
      const increment = code === 'G19' || code === 'C07' || code === 'P01' ? 2
        : code.startsWith('G') || ['C01','C02','C04','C06','C10','C13','T01','T03','T05','T06'].includes(code) ? 1 : 0;
      assert.equal(counts[code], card.copies + extra * increment, code);
      if (code.startsWith('M') || ['C03','C05','C08'].includes(code)) assert.equal(counts[code], card.copies);
    }
    const weights = GOODS.map(good => deck.reduce((sum, copy) => sum + (definition(copy.id).goods?.[good.id] ?? 0), 0));
    assert.deepEqual(weights, Array(6).fill(22 + 11 * (count - 2)));
    const game = fresh(count); assert.equal(game.contentVersion, PLAYER_COUNT_CONTENT_VERSION);
    assert.equal(game.goodsPerType, count * 3); assert.equal(game.availableStalls, boards);
    assert.equal(game.deck.length, total - count * 5); assert.equal(gameProblem(game), null);
    assert.equal(privateView(game, seats[0]).players.filter(player => Object.hasOwn(player, 'hand')).length, 1);
    assert.equal(spectatorView(game).players.some(player => Object.hasOwn(player, 'hand')), false);
    assert.throws(() => { profile.copiesByCode.C07 = 99; }, TypeError);
  });
}

test('legacy v1 and multiplayer-v2 material stays exactly 110 at every historical player count', () => {
  for (let count = 2; count <= 6; count++) {
    const old = fresh(count, { contentVersion: CONTENT_VERSION, goodsPerType: 8 });
    assert.equal(materialIds(old).length, 110); assert.equal(old.availableStalls, 5); assert.equal(old.goodsPerType, 8);
    const text = JSON.stringify(old), restored = JSON.parse(text);
    assert.equal(gameProblem(restored), null); assert.equal(JSON.stringify(restored), text);
    const next = accept(accept(restored, 'peek'), 'keep-peek');
    assert.equal(next.contentVersion, CONTENT_VERSION); assert.equal(materialIds(next).length, 110);
  }
  const oldest = fresh(2, { ruleVersion: DIGITAL_RULE_VERSION, goodsPerType: 6 }); delete oldest.goodsPerType;
  const text = JSON.stringify(oldest); assert.equal(gameProblem(JSON.parse(text)), null); assert.equal(JSON.stringify(oldest), text);
});

test('copy validation rejects cross-count and cross-content material without widening old 110 contracts', () => {
  for (const count of [2, 3, 4, 5]) {
    const state = fresh(count), corrupt = structuredClone(state), own = corrupt.players[0].hand;
    own[0] = `yousei.c07#${String(7 + 2 * (count - 2)).padStart(2, '0')}`;
    assert.ok(gameProblem(corrupt)); assert.equal(gameProblem(state), null);
  }
  const old = fresh(6, { contentVersion: CONTENT_VERSION }); old.deck[0] = 'yousei.c07#07';
  assert.ok(gameProblem(old)); assert.equal(definitionIdForCopy('yousei.c07#07', materialProfile(CONTENT_VERSION, 6)), null);
  assert.equal(definitionIdForCopy('yousei.stall-permit#13', materialProfile(PLAYER_COUNT_CONTENT_VERSION, 6)), 'yousei.stall-permit');
  for (const count of [1, 7, 2.5, '3', null, undefined]) assert.throws(() => playerCountProfile(count), RangeError);
  assert.throws(() => materialProfile('future', 6), RangeError);
});

test('recommended supply tracks participating seats; custom and legacy settings survive membership changes', () => {
  const adapter = createHyakkiAdapter(), room = { ...adapter.roomDefaults(), phase: 'waiting', players: seats.slice(0, 2).map(id => ({ id, ready: true })) };
  assert.deepEqual(room.hyakkiConfig, { actionLimit: 5, goodsPerType: 6, goodsSupplyMode: 'recommended' });
  for (let count = 3; count <= 6; count++) {
    room.players = seats.slice(0, count).map(id => ({ id, ready: true })); adapter.playersChanged(room);
    assert.equal(room.hyakkiConfig.goodsPerType, 3 * count); assert(room.players.every(player => !player.ready));
    const options = adapter.gameOptions(room, { ...context, matchId: 'b'.repeat(32), serverRandomInt: context.randomInt });
    assert.equal(options.goodsPerType, 3 * count); assert.equal(materialIds(adapter.createGame(room.players, options)).length, [110,144,178,212,246][count-2]);
  }
  room.hyakkiConfig = adapter.configure(room, { hyakkiConfig: { actionLimit: 5, goodsPerType: 17, goodsSupplyMode: 'custom' } }).updates.hyakkiConfig;
  room.players = seats.slice(0, 3).map(id => ({ id, ready: true })); adapter.playersChanged(room); assert.equal(room.hyakkiConfig.goodsPerType, 17);
  room.hyakkiConfig = adapter.configure(room, { hyakkiConfig: { actionLimit: 5, goodsPerType: 17, goodsSupplyMode: 'recommended' } }).updates.hyakkiConfig;
  assert.equal(room.hyakkiConfig.goodsPerType, 9);
  room.hyakkiConfig = { actionLimit: 5, goodsPerType: 8 }; adapter.playersChanged(room); assert.equal(room.hyakkiConfig.goodsPerType, 8);
  room.hyakkiConfig = { actionLimit: 5 }; adapter.playersChanged(room); assert.equal(adapter.roomView(room).hyakkiConfig.goodsPerType, 6);
});

test('schema21 is merchant-only and never silently repairs an old material envelope', () => {
  const adapter = createHyakkiAdapter(), game = fresh(6), data = { schemaVersion: 21, gameType: 'hyakki-trading', roomId: 'c'.repeat(32), code: '123456',
    players: game.players, spectators: [], game, turnClock: null, hyakkiConfig: { actionLimit: 5, goodsPerType: 18, goodsSupplyMode: 'recommended' } };
  assert.equal(snapshotHasRoles(data), true); assert.equal(snapshotFormatProblem(data, adapter), false);
  assert.equal(snapshotAuthorityBindingProblem(data, { roomId: data.roomId, code: data.code }), false);
  for (const schemaVersion of [12, 13, 14]) assert.equal(snapshotFormatProblem({ ...data, schemaVersion }, adapter), true);
  assert.equal(snapshotFormatProblem({ ...data, gameType: 'rummikub' }, adapter), true);
  assert.equal(snapshotAuthorityBindingProblem(data, { roomId: 'd'.repeat(32), code: data.code }), true);
  const old = fresh(6, { contentVersion: CONTENT_VERSION });
  assert.equal(adapter.snapshotProblem({ ...data, schemaVersion: 14, game: old, hyakkiConfig: { actionLimit: 5, goodsPerType: 8 } }), false);
  assert.equal(adapter.snapshotProblem({ ...data, game: old }), true);
});

for (const mode of ['recommended', 'custom']) test(`${mode}: actual room leave, next-game preparation and closed-creation import keep their correct material`, () => {
  const adapter = createHyakkiAdapter(), adapters = defaultGameRegistry.knownTypes().map(type => type === 'hyakki-trading' ? adapter : defaultGameRegistry.gameAdapter(type));
  const gameRegistry = createGameRegistry(adapters, { creationTypes: ['hyakki-trading'] });
  const rooms = createRoomStore({ gameRegistry, now: () => 1000, serverRandomInt: limit => limit - 1 });
  const users = seats.slice(0, 3).map(id => id.repeat(2));
  const host = rooms.createTrustedRoom(users[0], '甲', { gameType: 'hyakki-trading', roomId: 'd'.repeat(32), code: '234567' });
  rooms.joinTrustedRoom(host.roomCode, users[1], '乙'); rooms.joinTrustedRoom(host.roomCode, users[2], '丙');
  let sequence = 0;
  const act = (user, type, fields = {}) => rooms.trustedAction(host.roomCode, user, { type, ...fields,
    requestId: `material-room-${++sequence}`, expectedRevision: rooms.getTrustedView(host.roomCode, user).revision });
  if (mode === 'custom') act(users[0], 'configure', { hyakkiConfig: { actionLimit: 5, goodsPerType: 17, goodsSupplyMode: 'custom' } });
  for (const user of users) act(user, 'ready', { ready: true }); act(users[0], 'start');
  const started = rooms.exportSnapshot(host.roomCode);
  assert.equal(materialIds(started.game).length, 144); assert.equal(started.game.goodsPerType, mode === 'recommended' ? 9 : 17);
  act(users[2], 'leave'); assert.equal(rooms.getTrustedView(host.roomCode, users[0]).phase, 'aborted');
  act(users[0], 'rematch'); const waiting = rooms.exportSnapshot(host.roomCode);
  assert.equal(waiting.phase, 'waiting'); assert.equal(waiting.players.length, 2);
  assert.equal(waiting.hyakkiConfig.goodsPerType, mode === 'recommended' ? 6 : 17);
  assert.equal(adapter.roomStateProblem(waiting, true), null);
  for (const user of users.slice(0, 2)) act(user, 'ready', { ready: true }); act(users[0], 'start');
  const next = rooms.exportSnapshot(host.roomCode); assert.equal(next.schemaVersion, 21);
  assert.equal(materialIds(next.game).length, 110); assert.equal(next.game.goodsPerType, mode === 'recommended' ? 6 : 17);
  const reader = createRoomStore({ gameRegistry: createGameRegistry(adapters, { creationTypes: [] }), now: () => 1000 });
  reader.importSnapshot(JSON.parse(JSON.stringify(next)));
  assert.deepEqual(reader.exportSnapshot(host.roomCode).game, next.game);
});

test('the thirteenth permit buys the last shared board; one player still cannot exceed five boards', () => {
  let state = arranged(6); const permit = give(state, 0, 'P01', 13);
  state.players.forEach(owner => { owner.stallCount = 2; }); state.availableStalls = 1; state.purchasedStalls = 12;
  assert.equal(gameProblem(state), null); state = accept(state, 'buy-stall', { cardId: permit });
  assert.equal(state.availableStalls, 0); assert.equal(state.purchasedStalls, 13); assert.equal(state.players[0].silver, 17);
  state = arranged(6); const another = give(state, 0, 'P01', 13); state.players[0].stallCount = 5;
  state.purchasedStalls = 5; state.availableStalls = 8; const text = JSON.stringify(state);
  assert.equal(command(state, 'buy-stall', { cardId: another }).ok, false); assert.equal(JSON.stringify(state), text);
});

test('newly added counter copies work at their actual timing, while old matches reject them', () => {
  let state = arranged(6); const source = give(state, 0, 'M04'), counter = give(state, 5, 'C07', 14);
  state = accept(state, 'play-character', { cardId: source, params: { targetId: seats[5] } });
  const next = accept(state, 'respond', { cardId: counter }); assert.equal(next.pending, null);
  assert.deepEqual(next.discard.slice(-2), [source, counter]); assert.equal(next.actionsUsed, 1);
  const old = arranged(6, CONTENT_VERSION), adapter = createHyakkiAdapter();
  const bad = adapter.applyGameAction(old, seats[0], { type: 'respond', cardId: counter, requestId: 'cross-package', expectedRevision: old.revision,
    matchId: old.matchId, turnId: old.turnId }, { now: 1000 }); assert.equal(bad.ok, false); assert.equal(bad.code, 'INVALID_ACTION');
});

test('practice persists recommended/custom mode and restores a frozen six-seat pack without recomputing from caller defaults', async () => {
  let id = 0; const saved = new Map(), storage = { getItem: key => saved.get(key) ?? null, setItem: (key,value) => saved.set(key,value) };
  const options = { storage, withLock: callback => callback(), requestId: () => (++id).toString(16).padStart(32,'0'), seed: 18, playerCount: 6 };
  let session = await createHyakkiPracticeSession(options); assert.equal(session.snapshot().configuration.goodsSupplyMode, 'recommended');
  assert.equal(session.snapshot().configuration.goodsPerType, 18); assert.equal(decodeHyakkiPractice(saved.get(PRACTICE_STORAGE_KEY)).game.deck.length, 216);
  await session.restart({ playerCount: 4, actionLimit: 5, goodsPerType: 17, goodsSupplyMode: 'custom' });
  const before = saved.get(PRACTICE_STORAGE_KEY); await session.destroy();
  session = await createHyakkiPracticeSession({ ...options, playerCount: 2 });
  assert.equal(saved.get(PRACTICE_STORAGE_KEY), before); assert.deepEqual(session.snapshot().configuration,
    { playerCount: 4, actionLimit: 5, goodsPerType: 17, goodsSupplyMode: 'custom' });
  const corrupt = JSON.parse(before); corrupt.configuration.goodsSupplyMode = 'recommended'; assert.equal(decodeHyakkiPractice(JSON.stringify(corrupt)), null);
  await session.restart({ playerCount: 3, actionLimit: 5, goodsPerType: 17, goodsSupplyMode: 'recommended' });
  assert.equal(session.snapshot().configuration.goodsPerType, 9); await session.destroy();
});

for (let count = 2; count <= 6; count++) test(`${count} seats: complete projected-bot game on new material terminates with all frozen copies conserved`, t => {
  let seed = 57 + count; const randomInt = limit => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % limit; };
  let state = fresh(count, { randomInt }), steps = 0;
  const observed = new Set();
  while (state.status === 'playing' && steps++ < 8000) {
    const actor = currentDecision(state)?.actorId ?? state.turnPlayerId;
    const input = chooseHyakkiPracticeAction(privateView(state, actor), actor, { now: 1000 }); assert.ok(input, 'current deciding seat receives a legal action');
    observed.add(input.type);
    const next = applyGameAction(state, actor, input, { now: 1000, randomInt }); assert.equal(next.ok, true, `${input.type}: ${next.error}`); state = next.state;
    if (steps % 41 === 0) { state = JSON.parse(JSON.stringify(state)); assert.equal(gameProblem(state), null); }
  }
  assert.equal(state.status, 'finished'); assert.equal(state.result.wealth.length, count);
  assert.equal(new Set(materialIds(state)).size, [110,144,178,212,246][count-2]); assert.equal(gameProblem(state), null);
  t.diagnostic(JSON.stringify({ playerCount: count, commands: steps, turns: state.turnNumber, observedActions: [...observed] }));
});
