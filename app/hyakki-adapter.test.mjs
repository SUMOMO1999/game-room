import test from 'node:test';
import assert from 'node:assert/strict';
import { createHyakkiAdapter, createHyakkiTransitionPreparers } from '../server/games/hyakki-trading/adapter.mjs';
import { requireAdapter } from '../server/games/adapter-contract.mjs';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { createRoomStore } from './rooms.mjs';
import { createGame, applyGameAction, currentDecision } from './games/hyakki-trading/rules.mjs';
import { definition } from './games/hyakki-trading/model.mjs';
import { privateView, spectatorView } from './games/hyakki-trading/view.mjs';
import { gameProblem } from './games/hyakki-trading/validation.mjs';
import { MemoryAdapter, EncryptedStore } from '../server/storage.mjs';
import { createHyakkiEventStore, validateHyakkiPublicEvent, HYAKKI_EVENT_SCOPES } from '../server/games/hyakki-trading/event-store.mjs';
import { validateMatchSummary } from '../server/match-history.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32)], users = ['a'.repeat(64), 'b'.repeat(64)], matchId = 'c'.repeat(32);
const adapter = createHyakkiAdapter();
function fresh() { return createGame(ids, { matchId, now: 1000, randomInt: max => max - 1, actionLimit: 10 }); }
const registry = () => createGameRegistry([...defaultGameRegistry.knownTypes().filter(type => type !== 'hyakki-trading').map(type => defaultGameRegistry.gameAdapter(type)), adapter]);
function run(game, type, extra = {}) {
  const decision = currentDecision(game), actor = decision?.actorId ?? game.turnPlayerId;
  const result = applyGameAction(game, actor, { type, matchId, turnId: game.turnId,
    ...(game.pending ? { effectId: game.pending.id, decisionId: decision.id } : {}), ...extra }, { now: game.committedAt + 1, randomInt: max => max - 1 });
  assert.equal(result.ok, true, result.error); return result.state;
}
function take(game, code, playerId = game.turnPlayerId) {
  const zones = [game.deck, game.discard, ...game.players.map(player => player.hand)], source = zones.find(zone => zone.some(card => definition(card).sourceCode === code));
  const [cardId] = source.splice(source.findIndex(card => definition(card).sourceCode === code), 1);
  game.players.find(player => player.id === playerId).hand.push(cardId); return cardId;
}
function presence(game, now) { return { observedAt: now, seats: game.players.map(player => ({ playerId: player.id, connected: true,
  lastSeenAt: now, leaseExpiresAt: now + 10000, absenceSinceAt: null })) }; }

test('real adapter is readable by default while new creation remains closed', () => {
  assert.equal(requireAdapter(adapter), adapter); assert.equal(defaultGameRegistry.knownTypes().includes('hyakki-trading'), true);
  assert.equal(defaultGameRegistry.creationTypes().includes('hyakki-trading'), false);
  const room = { players: ids.map(id => ({ id })), hyakkiConfig: { actionLimit: 3 } };
  const options = adapter.gameOptions(room, { now: 1000, matchId, serverRandomInt: max => max - 1 });
  const game = adapter.createGame(room.players, options);
  assert.equal(game.firstPlayerId, ids[1]); assert.equal(game.actionLimit, 3); assert.equal(gameProblem(game), null);
  assert.equal(adapter.configure(room, { hyakkiConfig: { actionLimit: 0 } }).problem.code, 'INVALID_CONFIG');
  assert.equal(adapter.configure(room, { hyakkiConfig: { actionLimit: 5, seed: 1 } }).problem.code, 'INVALID_CONFIG');
});

test('a saved waiting room stays readable but cannot start after its creation capability closes', () => {
  const open = createRoomStore({ gameRegistry: registry(), now: () => 1000 });
  const host = open.createTrustedRoom(users[0], '甲', { gameType: 'hyakki-trading', code: '456789', roomId: 'e'.repeat(32) });
  open.joinTrustedRoom(host.roomCode, users[1], '乙');
  for (const [index, user] of users.entries()) open.trustedAction(host.roomCode, user,
    { type: 'ready', ready: true, requestId: `closed-start-ready-${index}`, expectedRevision: open.getTrustedView(host.roomCode, user).revision });
  const snapshot = open.exportSnapshot(host.roomCode), closed = createRoomStore({ gameRegistry: defaultGameRegistry, now: () => 1000 });
  closed.importSnapshot(snapshot);
  const view = closed.getTrustedView(host.roomCode, users[0]);
  assert.equal(view.phase, 'waiting'); assert.equal(view.gameType, 'hyakki-trading');
  assert.throws(() => closed.trustedAction(host.roomCode, users[0],
    { type: 'start', requestId: 'closed-start', expectedRevision: view.revision }), { code: 'INVALID_GAME_TYPE' });
  assert.equal(closed.getTrustedView(host.roomCode, users[0]).phase, 'waiting');
});

test('real room configuration, business action, exported snapshot and closed-creation recovery agree', () => {
  let at = 1000, seq = 0;
  const gameRegistry = registry(), rooms = createRoomStore({ gameRegistry, now: () => at, serverRandomInt: max => max - 1 });
  const host = rooms.createTrustedRoom(users[0], '甲', { gameType: 'hyakki-trading', code: '234567', roomId: 'd'.repeat(32) });
  rooms.joinTrustedRoom(host.roomCode, users[1], '乙');
  function action(user, type, extra = {}) {
    const snapshot = rooms.exportSnapshot(host.roomCode), view = rooms.getTrustedView(host.roomCode, user);
    return rooms.trustedAction(host.roomCode, user, { type, requestId: `real-${++seq}`, expectedRevision: view.revision, ...extra },
      { connected: Object.fromEntries(snapshot.players.map(player => [player.id, true])), presence: presence({ players: snapshot.players }, at) });
  }
  action(users[0], 'configure', { hyakkiConfig: { actionLimit: 4 } });
  for (const user of users) action(user, 'ready', { ready: true });
  action(users[0], 'start');
  let snapshot = rooms.exportSnapshot(host.roomCode);
  const actor = snapshot.matchParticipants.find(player => player.playerId === snapshot.game.turnPlayerId).userKey;
  assert.notEqual(snapshot.revision, snapshot.game.revision);
  action(actor, 'peek', { matchId: snapshot.matchId, turnId: snapshot.game.turnId });
  snapshot = rooms.exportSnapshot(host.roomCode);
  assert.equal(snapshot.schemaVersion, 12); assert.equal(snapshot.hyakkiConfig.actionLimit, 4);
  assert.equal(adapter.roomStateProblem(snapshot, true), null);
  const readRegistry = createGameRegistry(gameRegistry.knownTypes().map(type => gameRegistry.gameAdapter(type)), { creationTypes: defaultGameRegistry.creationTypes() });
  const recovered = createRoomStore({ gameRegistry: readRegistry, now: () => at });
  try {
    recovered.importSnapshot(snapshot);
    assert.equal(recovered.getTrustedView(host.roomCode, actor).game.pending.privatePool[0].cardId, snapshot.game.pending.poolCards[0]);
    assert.throws(() => recovered.createTrustedRoom(users[0], '甲', { gameType: 'hyakki-trading', code: '345678', roomId: 'e'.repeat(32) }), { code: 'INVALID_GAME_TYPE' });
    at = snapshot.game.timing.active.deadlineAt;
    assert.equal(rooms.applyTurnTimeout(host.roomCode, snapshot.turnClock), true);
    const timedOut = rooms.exportSnapshot(host.roomCode);
    assert.equal(timedOut.game.pending, null); assert.equal(timedOut.game.players.find(player => player.id === snapshot.game.turnPlayerId).hand.length,
      snapshot.game.players.find(player => player.id === snapshot.game.turnPlayerId).hand.length + 1);
    assert.equal(gameProblem(timedOut.game), null);
  } finally { recovered.close(); rooms.close(); }
});

test('resignation seals private candidates, leaves money and cards untouched, and exposes only public result wealth', () => {
  const game = run(fresh(), 'peek'), before = structuredClone(game);
  const changed = adapter.lifecycleTransition(game, { reason: 'voluntary-leave', playerId: game.turnPlayerId, now: 2000 });
  assert.equal(changed.ok, true, changed.error); assert.equal(changed.status, 'completed'); assert.equal(changed.state.status, 'finished');
  assert.deepEqual(changed.state.pending, before.pending); assert.deepEqual(changed.state.players, before.players);
  assert.equal(gameProblem(changed.state), null); assert.equal(changed.state.result.reason, 'voluntary-leave');
  assert.equal(privateView(changed.state, game.turnPlayerId).pending.choice, null);
  assert.equal(privateView(changed.state, game.turnPlayerId).pending.readOnly, true);
  assert.doesNotMatch(JSON.stringify(spectatorView(changed.state)), /#\d{2}/u);
  assert.equal(adapter.playerResult(changed.state.result, game.turnPlayerId).outcome, 'loss');
  assert.equal(adapter.playerResult(changed.state.result, game.turnPlayerId).wealth, 20);
  assert.equal(adapter.accountingPolicy, undefined);
});

test('auction reservation releases on terminal lifecycle without buying or reallocating its lot', () => {
  let game = run(fresh(), 'finish-draw'); const cardId = take(game, 'C12');
  game = run(game, 'play-character', { cardId }); game = run(game, 'bid', { amount: 3 });
  assert.ok(game.timing.decision); const before = structuredClone(game);
  const held = adapter.lifecycleTransition(game, { reason: 'presence', now: 2000, presence: { observedAt: 2000, seats: [] } });
  assert.equal(held.ok, true, held.error); assert.equal(gameProblem(held.state), null);
  const ended = adapter.lifecycleTransition(held.state, { reason: 'voluntary-leave', playerId: game.turnPlayerId, now: 2001 });
  assert.equal(ended.ok, true, ended.error); assert.equal(ended.state.pending.data.auction.released, true);
  assert.deepEqual(ended.state.pending.poolCards, before.pending.poolCards); assert.deepEqual(ended.state.players, before.players);
  assert.equal(gameProblem(ended.state), null);
});

test('actor-local choices have legal defaults and the opponent receives no response-card inventory', () => {
  let game = run(fresh(), 'finish-draw'); const cardId = take(game, 'M02');
  const responder = ids.find(id => id !== game.turnPlayerId); take(game, 'C07', responder);
  game = run(game, 'play-character', { cardId });
  const own = privateView(game, responder), peer = privateView(game, game.turnPlayerId), publicView = spectatorView(game);
  assert.ok(own.pending.response.cards.length);
  assert.deepEqual(own.pending.decision.defaultSelection, { type: 'decline-response' });
  assert.equal(peer.pending.response.cards, undefined); assert.equal(publicView.pending.decision.options, undefined);
});

test('adapter rejects extra network fields and resolves only current public targets', () => {
  let game = run(fresh(), 'finish-draw'), owner = game.players.find(player => player.id === game.turnPlayerId), peer = game.players.find(player => player.id !== owner.id);
  const character = take(game, 'M08'), toolId = take(game, 'T08', peer.id);
  peer.hand.splice(peer.hand.indexOf(toolId), 1); peer.tools.push({ cardId: toolId, exhausted: false });
  const index = game.players.indexOf(peer), ref = `tool-${index}:${game.revision}:0`;
  const action = { type: 'play-character', requestId: 'target', expectedRevision: 999, matchId, turnId: game.turnId, cardId: character, params: { toolCardId: ref } };
  assert.equal(adapter.validateAction({ ...action, balance: 100 }).code, 'INVALID_ACTION');
  const result = adapter.applyGameAction(game, owner.id, action, { now: 1200, serverRandomInt: max => max - 1 });
  assert.equal(result.ok, true, result.error); assert.equal(result.state.pending.data.toolCardId, toolId);
  const stale = adapter.applyGameAction(game, owner.id, { ...action, params: { toolCardId: `tool-${index}:999:0` } }, { now: 1200 });
  assert.equal(stale.ok, false); assert.equal(stale.code, 'STALE_REFERENCE');
  const afterCounter = run(result.state, 'decline-response');
  assert.equal(privateView(afterCounter, owner.id).pending.target.definitionId, 'yousei.t08');
  assert.match(privateView(afterCounter, owner.id).pending.target.ref, /^discard:/);
});

function eventFixture() {
  const storage = new EncryptedStore(new MemoryAdapter({ now: () => 3000 }), Buffer.alloc(32, 91), () => 3000);
  const store = createHyakkiEventStore({ storage, now: () => 3000 });
  const match = { roomId: 'd'.repeat(32), matchId, ruleVersion: fresh().ruleVersion, contentVersion: fresh().contentVersion, startedAt: 1000,
    participants: ids.map((seatId, i) => ({ seatId, userKey: users[i] })) };
  const append = (sequence, mode, events) => store.prepareAppend({ match, sequence, commitId: `test-${sequence}`, committedAt: 1000 + sequence, mode, events });
  return { storage, store, append };
}

test('normal-close event group retains its final real action while abnormal termination rejects injected rewards', async () => {
  const f = eventFixture();
  try {
    const initial = await f.append(1, 'normal', [{ type: 'match-started' }]);
    assert.equal(await f.storage.compareAndSwapMany(initial), true);
    const last = [{ type: 'trade-sold', actorSeatId: ids[1], cardId: 'yousei.g01', silver: 10, goods: [{ id: 'firearms', count: 3 }] },
      { type: 'turn-ended', actorSeatId: ids[1] }, { type: 'match-ended', reason: 'normal-close', winnerSeatId: ids[1] }];
    const finished = await f.append(2, 'terminal', last);
    assert.equal(await f.storage.compareAndSwapMany(finished), true);
    const group = await f.storage.get(HYAKKI_EVENT_SCOPES.events, `${matchId}:2`);
    assert.deepEqual(group.events, last);
  } finally { f.storage.close(); }
  const bad = eventFixture();
  try {
    await bad.storage.compareAndSwapMany(await bad.append(1, 'normal', [{ type: 'match-started' }]));
    await assert.rejects(bad.append(2, 'terminal', [{ type: 'turn-ended', actorSeatId: ids[0] },
      { type: 'match-ended', reason: 'voluntary-leave', winnerSeatId: ids[1] }]), error => error.code === 'GAME_HISTORY_INVALID');
    assert.throws(() => validateHyakkiPublicEvent({ type: 'cards-revealed', actorSeatId: ids[0], cardIds: ['yousei.g01#01'] }));
    assert.doesNotThrow(() => validateHyakkiPublicEvent({ type: 'cards-revealed', actorSeatId: ids[0], cardIds: ['yousei.g01'] }));
  } finally { bad.storage.close(); }
});

test('wealth-only history includes both frozen participants and never permanent score fields', () => {
  const result = adapter.lifecycleTransition(fresh(), { reason: 'voluntary-leave', playerId: ids[0], now: 2000 }).state.result;
  const summary = { matchId, roomId: 'd'.repeat(32), roomCode: '234567', game: 'hyakki-trading', ruleVersion: fresh().ruleVersion,
    startedAt: 1000, endedAt: 2000, status: 'completed', reason: 'voluntary-leave', players: ids.map((id, i) => ({
      userKey: users[i], seatId: id, nickname: `玩家${i + 1}`, ...adapter.playerResult(result, id),
    })) };
  assert.equal(validateMatchSummary(summary, { gameRegistry: registry() }), summary);
  assert.equal(summary.players[0].score, undefined); assert.equal(summary.players[0].balanceAfter, undefined);
  assert.throws(() => validateMatchSummary({ ...summary, players: summary.players.map(player => ({ ...player, wealth: -1 })) }, { gameRegistry: registry() }));
});

test('auction pause and restart preserve bidder, amount, candidates and remaining decision time', () => {
  let game = run(fresh(), 'finish-draw'); game = run(game, 'play-character', { cardId: take(game, 'C12') });
  game = run(game, 'bid', { amount: 2 });
  const original = structuredClone(game), decisionId = currentDecision(game).id;
  const paused = adapter.onPhaseChanged(game, 'paused', 1500, { presence: presence(game, 1500) });
  assert.equal(paused.ok, true); assert.equal(gameProblem(paused.state), null);
  assert.equal(paused.state.timing.decision.deadlineAt, null);
  const restored = adapter.lifecycleTransition(structuredClone(paused.state), { reason: 'server-recovery', now: 2000,
    presence: { observedAt: 2000, seats: [] } });
  assert.equal(restored.ok, true, restored.error); assert.equal(gameProblem(restored.state), null);
  assert.equal(restored.state.lifecycle.absence, null);
  const resumed = adapter.onPhaseChanged(restored.state, 'playing', 2500, { presence: presence(game, 2500) });
  assert.equal(resumed.ok, true); assert.equal(gameProblem(resumed.state), null);
  assert.equal(currentDecision(resumed.state).id, decisionId);
  assert.equal(resumed.state.timing.decision.remainingMs, paused.state.timing.decision.remainingMs);
  assert.deepEqual(resumed.state.pending, original.pending); assert.deepEqual(resumed.state.players, original.players);
});

test('paid retention is sealed at cancellation without selecting goods or charging again', () => {
  let game = run(fresh(), 'finish-draw'), owner = game.players.find(player => player.id === game.turnPlayerId);
  owner.goods.firearms = 5; game.bankGoods.firearms = 1;
  game = run(game, 'play-character', { cardId: take(game, 'C10') });
  game = run(game, 'choose-effect', { selection: { goodsId: 'imports' } });
  const before = structuredClone(game);
  assert.equal(game.players.find(player => player.id === owner.id).silver, 18);
  const ended = adapter.lifecycleTransition(game, { reason: 'room-expired', now: 2000 });
  assert.equal(ended.ok, true, ended.error); assert.equal(ended.state.status, 'aborted'); assert.equal(gameProblem(ended.state), null);
  assert.deepEqual(ended.state.pending, before.pending); assert.deepEqual(ended.state.players, before.players);
  assert.deepEqual(ended.state.bankGoods, before.bankGoods);
  const projected = privateView(ended.state, owner.id);
  assert.equal(projected.pending.choice.options, undefined); assert.equal(projected.pending.decision.options, undefined);
  const corrupt = structuredClone(ended.state); corrupt.result.wealth[0].silver++;
  assert.notEqual(gameProblem(corrupt), null);
});
