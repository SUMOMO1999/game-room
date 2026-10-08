import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomStore } from './rooms.mjs';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { createPoker414Adapter } from '../server/games/poker414-2/adapter.mjs';
import { getCard } from './games/poker414-2/cards.mjs';

const keys = Array.from({ length: 9 }, (_, index) => (index + 1).toString(16).repeat(64));
const adapter = createPoker414Adapter(), registry = createGameRegistry([adapter]);
let sequence = 0;
function fixture(t, count = 3) {
  let at = 100000;
  const now = () => at, store = createRoomStore({ now, gameRegistry: registry, serverRandomInt: max => max - 1 });
  t.after(() => store.close());
  store.createTrustedRoom(keys[0], '甲', { code: '414000', roomId: 'a'.repeat(32), gameType: 'poker414-2' });
  for (let index = 1; index < count; index++) store.joinTrustedRoom('414000', keys[index], `伙伴${index}`);
  const view = (index = 0) => store.getTrustedView('414000', keys[index]);
  const snapshot = () => store.exportSnapshot('414000');
  const indexFor = playerId => snapshot().players.findIndex(player => player.id === playerId);
  const input = (index, type, extra = {}) => ({ type, requestId: `p414-${++sequence}`, expectedRevision: view(index).revision,
    ...(adapter.actionTypes.includes(type) ? { matchId: view(index).matchId, roundId: view(index).game.roundId,
      targetId: view(index).game.target?.id ?? null, ...(['hook', 'fork'].includes(type) ? { windowId: view(index).game.responseWindow?.id } : {}) } : {}), ...extra });
  const send = (index, action) => store.trustedAction('414000', keys[index], action);
  const act = (index, type, extra) => send(index, input(index, type, extra));
  const start = () => { for (let index = 0; index < count; index++) act(index, 'ready', { ready: true }); act(0, 'start'); };
  const deal = () => { at += 3000; assert.equal(store.applyTurnTimeout('414000', snapshot().turnClock), true); };
  const lead = () => {
    const game = snapshot().game, player = game.players.find(member => member.id === game.turnPlayerId);
    const card = player.hand.find(cardId => getCard(cardId).rank <= 15 && game.players.filter(member => member.id !== player.id)
      .every(member => member.hand.filter(id => getCard(id).rank === getCard(cardId).rank).length >= 2));
    assert.ok(card); const index = indexFor(player.id); act(index, 'play', { cardIds: [card] }); return index;
  };
  return { store, view, snapshot, input, send, act, start, deal, lead, indexFor, now, set: value => { at = value; } };
}

test('414 is readable but closed to default creation and requires authenticated stable accounts', t => {
  assert.throws(() => defaultGameRegistry.normalizeGameType('poker414-2'));
  assert.equal(defaultGameRegistry.gameAdapter('poker414-2').snapshotSchema(), 11);
  const f = fixture(t); assert.equal(f.view().gameType, 'poker414-2');
  assert.equal(f.snapshot().schemaVersion, 11); assert.equal(f.view().turnClock, null);
  assert.equal(f.view().commonActions.pause, false);
  assert.throws(() => f.act(0, 'configure'), error => error.code === 'CONFIGURATION_UNSUPPORTED');
  assert.throws(() => f.act(0, 'pause'), error => error.code === 'PAUSE_UNSUPPORTED');
  assert.throws(() => f.act(0, 'start'), error => error.code === 'NOT_READY');
  assert.throws(() => adapter.gameOptions({ players: [{ id: 'one' }] }, {}), /账号/);
});

test('deal clock publishes only confirmed prefix, ordinary turns have no deadline, and 8 seats receive all 108 cards', t => {
  for (const count of [3, 8]) {
    const f = fixture(t, count); f.start();
    assert.equal(f.view().phase, 'playing'); assert.equal(f.view().game.stage, 'dealing');
    assert.equal(f.snapshot().turnClock.kind, 'deal');
    f.store.joinTrustedRoom('414000', keys[8], '观众');
    const original = f.snapshot(); f.set(original.turnClock.deadlineAt);
    assert.equal(f.store.applyTurnTimeout('414000', original.turnClock), true);
    const partial = f.snapshot(); assert.equal(partial.game.dealCursor, 18);
    const observer = f.view(8); assert.equal(observer.selfRole, 'spectator');
    assert.equal(observer.game.players.flatMap(player => player.hand).length, 18);
    const player = f.view(); assert.equal(player.game.players.filter(member => Object.hasOwn(member, 'hand')).length, 1);
    for (const id of partial.game.deck.slice(18)) assert.equal(JSON.stringify(observer).includes(id), false);
    f.deal(); const dealt = f.snapshot(); assert.equal(dealt.game.dealCursor, 108); assert.equal(dealt.turnClock, null);
    assert.deepEqual(dealt.game.players.map(player => player.hand.length).sort(), count === 3 ? [36, 36, 36] : [13,13,13,13,14,14,14,14]);
    assert.equal(f.store.applyTurnTimeout('414000', original.turnClock), false);
  }
});

test('a single creates a response clock after null; only an actual responder may commit through an unrelated pass revision', t => {
  const f = fixture(t); f.start(); f.deal(); f.lead();
  const before = f.snapshot(), responder = before.game.players.find(player => player.id !== before.game.target.ownerId
    && player.id !== before.game.turnPlayerId), responderIndex = f.indexFor(responder.id);
  assert.equal(before.turnClock.kind, 'response');
  const staleFork = f.input(responderIndex, 'fork');
  f.act(f.indexFor(before.game.turnPlayerId), 'pass');
  f.send(responderIndex, staleFork);
  assert.equal(f.snapshot().game.target.source, 'fork'); assert.equal(f.snapshot().game.target.cardIds.length, 3);
  const saved = f.snapshot(); f.send(responderIndex, staleFork); assert.deepEqual(f.snapshot(), saved, 'same intent replays without deducting again');
  assert.throws(() => f.send(responderIndex, { ...staleFork, requestId: `p414-${++sequence}` }), error => error.code === 'STALE_TARGET');
});

test('two forks for one target cannot both remove cards and an old request cannot bind to the next hook', t => {
  const f = fixture(t); f.start(); f.deal(); const owner = f.lead(), opponents = [0, 1, 2].filter(index => index !== owner);
  const left = f.input(opponents[0], 'fork'), right = f.input(opponents[1], 'fork');
  f.send(opponents[0], left); const before = f.snapshot().game.players.find(player => player.id === f.view(opponents[1]).selfId).hand;
  assert.throws(() => f.send(opponents[1], right), error => error.code === 'STALE_TARGET');
  assert.deepEqual(f.snapshot().game.players.find(player => player.id === f.view(opponents[1]).selfId).hand, before);
  assert.equal(f.snapshot().game.responseWindow.action, 'hook');
});

test('actual room actions alternate a pair through eight cards, then close the response window', t => {
  const f = fixture(t); f.start(); f.deal(); const initial = f.snapshot().game;
  const owner = initial.players.find(player => player.id === initial.turnPlayerId);
  const rank = owner.hand.map(id => getCard(id).rank).find(rank => rank <= 15 && owner.hand.filter(id => getCard(id).rank === rank).length === 4);
  assert.ok(rank); const count = player => player.hand.filter(id => getCard(id).rank === rank).length;
  const [firstTwo, secondTwo] = initial.players.filter(player => player.id !== owner.id && count(player) === 2);
  assert.ok(firstTwo && secondTwo);
  f.act(f.indexFor(owner.id), 'play', { cardIds: owner.hand.filter(id => getCard(id).rank === rank).slice(0, 2) });
  const sequence = [[firstTwo, 'hook', 3], [secondTwo, 'fork', 5], [firstTwo, 'hook', 6], [owner, 'fork', 8]];
  for (const [player, type, length] of sequence) {
    f.act(f.indexFor(player.id), type);
    assert.equal(f.snapshot().game.target.cardIds.length, length);
  }
  assert.equal(f.snapshot().game.target.pattern.kind, 'bomb'); assert.equal(f.snapshot().game.responseWindow, null);
  assert.equal(f.snapshot().turnClock, null); assert.equal(f.snapshot().game.playedIds.length, 8);
  assert.equal(f.snapshot().game.players.flatMap(player => player.hand).length, 100);
  // The recovery registry understands every saved game activity even while its
  // public creation gate remains closed. Old hook/fork rows must remain readable.
  const restored = createRoomStore({ now: f.now }); t.after(() => restored.close());
  assert.ok(f.snapshot().activity.some(event => event.type === 'hook'));
  assert.ok(f.snapshot().activity.some(event => event.type === 'fork'));
  restored.importSnapshot(f.snapshot());
  assert.deepEqual(restored.getTrustedView('414000', keys[0]).game, f.view().game);
});

test('action whitelist rejects private state injection, future revisions and another player card', t => {
  const f = fixture(t); f.start(); f.deal(); const current = f.snapshot().game.turnPlayerId, actor = f.indexFor(current);
  const own = f.snapshot().game.players.find(player => player.id === current).hand[0];
  const foreign = f.snapshot().game.players.find(player => player.id !== current).hand[0];
  for (const extra of [{ deck: [] }, { userKey: keys[8] }, { score: 9999 }, { deadlineAt: 1 }]) {
    assert.throws(() => f.act(actor, 'play', { cardIds: [own], ...extra }), error => error.code === 'INVALID_ACTION');
  }
  assert.throws(() => f.act(actor, 'play', { cardIds: [foreign] }), error => error.code === 'NOT_YOUR_CARD');
  f.lead(); const responder = f.indexFor(f.snapshot().game.turnPlayerId);
  assert.throws(() => f.act(responder, 'fork', { expectedRevision: f.view().revision + 1 }), error => error.code === 'REVISION_CONFLICT');
});

test('response cutoff is strict while expiry only clears its window and preserves the ordinary actor', t => {
  const f = fixture(t); f.start(); f.deal(); const owner = f.lead(), responder = [0, 1, 2].find(index => index !== owner);
  const clock = f.snapshot().turnClock, actor = f.snapshot().game.turnPlayerId, action = f.input(responder, 'fork');
  f.set(clock.deadlineAt);
  assert.throws(() => f.send(responder, action), error => error.code === 'RESPONSE_EXPIRED');
  assert.equal(f.store.applyTurnTimeout('414000', clock), true);
  assert.equal(f.snapshot().game.turnPlayerId, actor); assert.equal(f.snapshot().turnClock, null);
  assert.equal(f.snapshot().game.passedPlayerIds.length, 0);
  assert.equal(adapter.actionDeadline(f.snapshot(), { type: 'play' }), null);
});

test('only one response-clock revision permits a current ordinary intent; unrelated revisions still conflict', t => {
  const f = fixture(t); f.start(); f.deal(); f.lead();
  const actor = f.indexFor(f.snapshot().game.turnPlayerId), pass = f.input(actor, 'pass'), clock = f.snapshot().turnClock;
  f.set(clock.deadlineAt); f.store.applyTurnTimeout('414000', clock);
  f.send(actor, pass); assert.equal(f.snapshot().game.passedPlayerIds.length, 1);
  const next = f.indexFor(f.snapshot().game.turnPlayerId), obsolete = f.input(next, 'pass');
  f.store.joinTrustedRoom('414000', keys[8], '观众');
  assert.throws(() => f.send(next, obsolete), error => error.code === 'REVISION_CONFLICT');
});

test('spectators receive every dealt hand but cannot play, pause or change their role during a game', t => {
  const f = fixture(t); f.start(); f.deal(); f.store.joinTrustedRoom('414000', keys[8], '观众');
  assert.equal(f.view(8).game.players.flatMap(player => player.hand).length, 108);
  assert.throws(() => f.act(8, 'pass'), error => error.code === 'SPECTATOR_READ_ONLY');
  assert.throws(() => f.act(8, 'set-role', { role: 'player' }), error => error.code === 'ROOM_LOCKED');
  const before = f.snapshot().game; f.act(8, 'leave'); assert.deepEqual(f.snapshot().game, before);
});

test('voluntary leave during dealing settles each opponent 5 once, retains frozen identity, and hands off host', t => {
  const f = fixture(t); f.start(); const intent = f.input(0, 'leave');
  f.send(0, intent); const saved = f.snapshot();
  assert.equal(saved.phase, 'aborted'); assert.equal(saved.game.status, 'aborted'); assert.equal(saved.players.length, 2);
  assert.equal(saved.hostId, saved.players[0].id); assert.equal(saved.turnClock, null);
  assert.deepEqual(saved.pendingRecords[0].deltas.map(delta => delta.delta).sort((a,b) => a-b), [-10, 5, 5]);
  assert.equal(saved.pendingRecords[0].players.length, 3); assert.equal(saved.pendingRecords[0].reason, 'voluntary-leave');
  assert.deepEqual(f.send(0, intent), { view: null, left: true }); assert.deepEqual(f.snapshot(), saved);
  const restored = createRoomStore({ now: f.now, gameRegistry: registry }); t.after(() => restored.close()); restored.importSnapshot(saved);
  assert.equal(restored.getTrustedView('414000', keys[1]).game.result.reason, 'voluntary-leave');
});

test('system cancellation is match-fenced, zero score, returns stable seats to waiting and starts a different match', t => {
  for (const reason of ['disconnected', 'server-recovery', 'room-expired']) {
    const f = fixture(t); f.start(); f.deal(); const saved = f.snapshot(), matchId = saved.matchId;
    assert.equal(f.store.applyLifecycle('414000', { matchId: 'f'.repeat(32), reason }), false);
    assert.equal(f.store.applyLifecycle('414000', { matchId, reason }), true);
    const cancelled = f.snapshot(); assert.equal(cancelled.phase, 'waiting'); assert.equal(cancelled.game, null);
    assert.equal(cancelled.turnClock, null); assert.equal(cancelled.pendingRecords.length, 1);
    assert.ok(cancelled.pendingRecords[0].deltas.every(delta => delta.delta === 0));
    assert.deepEqual(cancelled.players.map(player => player.id), saved.players.map(player => player.id));
    assert.ok(cancelled.players.every(player => player.ready === false)); assert.equal(cancelled.lastMatchResult.reason, reason);
    assert.equal(f.store.applyLifecycle('414000', { matchId, reason }), false);
    const restored = createRoomStore({ now: f.now, gameRegistry: registry }); t.after(() => restored.close()); restored.importSnapshot(cancelled);
    assert.equal(restored.getTrustedView('414000', keys[0]).lastMatchResult.reason, reason);
    f.start(); assert.notEqual(f.snapshot().matchId, matchId);
  }
});

test('explicit expiry preserves the zero-score pending result after the room TTL has elapsed', t => {
  const f = fixture(t); f.start(); f.set(f.now() + 8 * 60 * 60 * 1000);
  const expired = f.store.expireRoom('414000'); assert.equal(expired.phase, 'waiting');
  assert.equal(expired.pendingRecords.length, 1); assert.equal(expired.pendingRecords[0].reason, 'room-expired');
  assert.ok(expired.pendingRecords[0].deltas.every(delta => delta.delta === 0));
});

test('schema11 rejects mixed envelopes, tampered frozen accounts, deadlines, cards and oversized snapshots', t => {
  const f = fixture(t); f.start(); f.deal(); f.lead(); const saved = f.snapshot();
  const corruptions = [s => { s.schemaVersion = 10; }, s => { s.gameType = 'rummikub'; }, s => { s.roomId = null; },
    s => { s.players[0].ready = 'false'; }, s => { delete s.spectators; },
    s => { s.matchParticipants[0].userKey = keys[8]; }, s => { s.turnClock.deadlineAt++; }, s => { s.turnClock = null; },
    s => { s.game.players[0].hand.push(s.game.players[1].hand[0]); }, s => { s.jokerConfig = {}; },
    s => { s.excess = 'x'.repeat(513 * 1024); }];
  for (const mutate of corruptions) {
    const candidate = structuredClone(saved); mutate(candidate);
    assert.throws(() => f.store.importSnapshot(candidate), error => error.code === 'INVALID_SNAPSHOT');
    assert.deepEqual(f.snapshot(), saved);
  }
  f.store.importSnapshot(saved); assert.deepEqual(f.snapshot(), saved);
});

test('a complete real room game creates one zero-sum terminal summary and no observer result', t => {
  const f = fixture(t); f.start(); f.deal(); f.store.joinTrustedRoom('414000', keys[8], '观众');
  let actions = 0;
  while (f.snapshot().phase === 'playing' && actions++ < 400) {
    const game = f.snapshot().game, playerId = game.turnPlayerId, index = f.indexFor(playerId);
    if (game.target) f.act(index, 'pass');
    else f.act(index, 'play', { cardIds: [game.players.find(player => player.id === playerId).hand[0]] });
  }
  const saved = f.snapshot(); assert.equal(saved.phase, 'finished'); assert.equal(saved.pendingRecords.length, 1);
  const summary = saved.pendingRecords[0]; assert.equal(summary.players.length, 3);
  assert.equal(summary.status, 'completed'); assert.equal(summary.reason, 'emptied-hand');
  assert.equal(summary.deltas.reduce((sum, entry) => sum + entry.delta, 0), 0);
  assert.equal(summary.players.filter(player => player.outcome === 'win').length, 1);
  assert.equal(summary.players.some(player => player.userKey === keys[8]), false);
  assert.equal(f.store.applyLifecycle('414000', { matchId: saved.matchId, reason: 'disconnected' }), false);
  f.store.importSnapshot(saved); assert.equal(f.snapshot().pendingRecords.length, 1);
});
