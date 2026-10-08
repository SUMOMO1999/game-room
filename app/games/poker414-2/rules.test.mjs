import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, getCard } from './cards.mjs';
import { compareCardIds, classifyPattern, enumerateLegalPlays } from './patterns.mjs';
import { createGame, advanceGame, applyAction, abortGame, cancelGame, restoreGame,
  projectGame, gameProblem, validateGame, gameClock, disconnectExpired, RESPONSE_MS } from './rules.mjs';

const deck = makeDeck();
const allIds = deck.map(card => card.id);
const rank = (value, count = 1, offset = 0) => deck.filter(card => card.rank === value).slice(offset, offset + count).map(card => card.id);
const face = (suit, value, count = 1) => deck.filter(card => card.suit === suit && card.rank === value).slice(0, count).map(card => card.id);
const mixed = [...face('spades', 4), ...face('diamonds', 4), ...face('diamonds', 14)];
const pure = suit => [...face(suit, 4, 2), ...face(suit, 14)];
const create = (count = 3, options = {}) => createGame({ players: Array.from({ length: count }, (_, index) => `p${index}`),
  matchId: 'test-match', random: () => 0.999, now: 0, ...options });
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function accepted(result) { assert.equal(result.ok, true, result.error); assert.equal(gameProblem(result.state), null); return result.state; }
function actionFor(game, type, playerId, cardIds) {
  return { type, playerId, matchId: game.matchId, roundId: game.roundId, targetId: game.target?.id || null,
    ...(type === 'play' ? { cardIds } : {}), ...(['hook', 'fork'].includes(type) ? { windowId: game.responseWindow?.id || '' } : {}) };
}
function act(game, type, playerId = game.turnPlayerId, cards, now = game.updatedAt + 1) {
  return accepted(applyAction(game, actionFor(game, type, playerId, cards), { now }));
}
function reject(game, action, code, now = game.updatedAt + 1) {
  const before = structuredClone(game), result = applyAction(freeze(game), action, { now });
  assert.equal(result.ok, false); assert.equal(result.code, code);
  assert.equal(result.state, game); assert.deepEqual(game, before);
}

/**
 * Isolated middle-game fixture, not a claim of a replayed full match. Initial
 * ownership still derives from a complete 108-card deal. Removed filler cards
 * are public single-card rounds; no entities are invented or duplicated.
 */
function scenario(hands, { fill = true, start = Object.keys(hands)[0] } = {}) {
  const ids = Object.keys(hands), state = createGame({ players: ids, matchId: 'scenario', random: () => 0.999, now: 0 });
  state.firstDealerId = ids[0];
  const desired = ids.flatMap(id => hands[id]);
  assert.equal(new Set(desired).size, desired.length);
  const leftovers = allIds.filter(id => !desired.includes(id)), assigned = new Map();
  const counts = Object.fromEntries(ids.map(id => [id, 0]));
  for (let index = 0; index < 108; index += 1) counts[state.actionOrder[index % ids.length]] += 1;
  for (const id of ids) {
    assert.ok(hands[id].length <= counts[id]);
    assigned.set(id, [...hands[id], ...leftovers.splice(0, counts[id] - hands[id].length)]);
  }
  const queues = new Map([...assigned].map(([id, cards]) => [id, [...cards]]));
  state.deck = Array.from({ length: 108 }, (_, index) => queues.get(state.actionOrder[index % ids.length]).shift());
  let game = accepted(advanceGame(state, { now: 3000 }));
  game.turnPlayerId = start;
  if (!fill) {
    game.notices = []; game.eventSeq = 0; game.roundId = 1;
    const priorPlayers = [...game.players.filter(player => player.id !== start), game.players.find(player => player.id === start)];
    for (const player of priorPlayers) {
      const removed = player.hand.filter(id => !hands[player.id].includes(id));
      for (const id of removed) {
        game.eventSeq += 1;
        const eventId = `${game.matchId}:e${game.eventSeq}`, targetId = `${eventId}:target`;
        game.moves.push({ eventId, type: 'play', playerId: player.id, cardIds: [id], targetId,
          rootId: targetId, sourceTargetId: null, roundId: game.roundId, at: 3000 });
        game.playedIds.push(id); game.roundId += 1;
      }
      player.hand = [...hands[player.id]].sort(compareCardIds);
    }
  } else {
    // The requested leader owns a prior isolated round. Keep that public card
    // and its ownership evidence instead of overriding the first-heart leader.
    const player = game.players.find(candidate => candidate.id === start);
    const filler = player.hand.find(id => !hands[start].includes(id));
    assert.ok(filler);
    const eventId = `${game.matchId}:e${++game.eventSeq}`, targetId = `${eventId}:target`;
    game.moves.push({ eventId, type: 'play', playerId: start, cardIds: [filler], targetId,
      rootId: targetId, sourceTargetId: null, roundId: 1, at: 3000 });
    game.playedIds.push(filler); player.hand = player.hand.filter(id => id !== filler);
    game.roundId = 2;
  }
  assert.equal(gameProblem(game), null);
  return game;
}

for (let count = 3; count <= 8; count += 1) {
  test(`T08: ${count} players deal all 108 once, counterclockwise from the fixed first dealer`, () => {
    let randomCalls = 0;
    const initial = freeze(create(count, { random: () => { randomCalls += 1; return 0.9; } }));
    const callsAtCreation = randomCalls;
    let state = accepted(advanceGame(initial, { now: 499 }));
    assert.equal(state, initial);
    state = accepted(advanceGame(state, { now: 500 }));
    assert.equal(state.dealCursor, 18);
    state = accepted(advanceGame(state, { now: 3000 }));
    const expected = Array.from({ length: count }, (_, index) => Math.floor(108 / count) + (index < 108 % count ? 1 : 0));
    const dealer = state.actionOrder.indexOf(state.firstDealerId);
    const actual = expected.map((_, index) => state.players.find(player => player.id === state.actionOrder[(dealer + index) % count]).hand.length);
    assert.deepEqual(actual, expected);
    assert.equal(state.dealCursor, 108); assert.equal(state.stage, 'playing');
    assert.equal(state.turnPlayerId, state.firstPlayerId);
    assert.equal(gameClock(state), null);
    assert.equal(randomCalls, callsAtCreation);
    assert.equal(accepted(advanceGame(state, { now: 9000 })), state);
    assert.equal(new Set(state.players.flatMap(player => player.hand)).size, 108);
    assert.equal(initial.dealCursor, 0);
  });
}

test('T07: first officially dealt heart three wins the mark, including both given to one player', () => {
  for (const secondIndex of [1, 3]) {
    const state = create(), hearts = face('hearts', 3, 2), rest = allIds.filter(id => !hearts.includes(id));
    state.deck = [...rest]; state.deck.splice(0, 0, hearts[0]); state.deck.splice(secondIndex, 0, hearts[1]);
    const expected = state.firstDealerId, playing = accepted(advanceGame(state, { now: 3000 }));
    assert.equal(playing.firstPlayerId, expected); assert.equal(playing.firstHeart3.cardId, hearts[0]);
    assert.equal(playing.firstHeart3.dealIndex, 0);
    const firstNonHeart = playing.players.find(player => player.id === expected).hand.find(id => !hearts.includes(id));
    const after = act(playing, 'play', expected, [firstNonHeart]);
    assert.equal(after.moves[0].cardIds[0], firstNonHeart);
  }
});

test('T01/T02/T03: actual moves use quantity then rank, refuse insufficient/equal strength unchanged', () => {
  let game = scenario({ a: rank(13, 6), b: rank(15, 6), c: rank(3, 7) });
  game = act(game, 'play', 'a', rank(13, 6));
  assert.equal(game.turnPlayerId, 'c');
  game = act(game, 'play', 'c', rank(3, 7));
  reject(game, actionFor(game, 'play', 'b', rank(15, 6)), 'NOT_STRONGER');
  game = scenario({ a: rank(5, 4), b: rank(5, 4, 4), c: rank(6, 4) });
  game = act(game, 'play', 'a', rank(5, 4));
  game = act(game, 'play', 'c', rank(6, 4));
  reject(game, actionFor(game, 'play', 'b', rank(5, 4, 4)), 'NOT_STRONGER');
});

test('T04/T05: actual same-joker pair and mixed-joker bomb maintain distinct strength', () => {
  let game = scenario({ a: rank(15, 2), b: rank(17, 2), c: rank(16, 2) });
  game = act(game, 'play', 'a', rank(15, 2)); game = act(game, 'play', 'c', rank(16, 2));
  assert.equal(game.target.pattern.kind, 'pair-small-jokers');
  assert.equal(game.responseWindow, null);
  game = scenario({ a: rank(15, 8), b: rank(8), c: [...rank(16), ...rank(17)] });
  game = act(game, 'play', 'a', rank(15, 8)); game = act(game, 'play', 'c', [...rank(16), ...rank(17)]);
  assert.equal(game.target.pattern.kind, 'mixed-joker-bomb');
});

test('T06/T16/T19/T20: all rocket grades play correctly and only hearts lead again', () => {
  let game = scenario({ a: mixed, b: pure('hearts'), c: pure('clubs') });
  const round = game.roundId;
  game = act(game, 'play', 'a', mixed); assert.equal(game.turnPlayerId, 'c');
  game = act(game, 'play', 'c', pure('clubs')); assert.equal(game.turnPlayerId, 'b');
  game = act(game, 'play', 'b', pure('hearts'));
  assert.equal(game.turnPlayerId, 'b'); assert.equal(game.target, null); assert.equal(game.roundId, round + 1);
  reject(game, actionFor(game, 'pass', 'b'), 'MUST_LEAD');
  game = scenario({ a: pure('spades'), b: rank(9), c: pure('clubs') });
  game = act(game, 'play', 'a', pure('spades'));
  reject(game, actionFor(game, 'play', 'c', pure('clubs')), 'NOT_STRONGER');
});

test('T09/T11: competing forks reference one target, move only new entities, and preserve evidence', () => {
  let game = scenario({ a: rank(7), b: rank(7, 2, 1), c: rank(7, 2, 3) });
  const publicBefore = game.playedIds.length, movesBefore = game.moves.length;
  game = act(game, 'play', 'a', rank(7));
  const oldTarget = game.target.id, oldWindow = game.responseWindow.id;
  const rival = actionFor(game, 'fork', 'c'), beforeB = game.players.find(player => player.id === 'b').hand.length;
  game = act(game, 'fork', 'b');
  assert.equal(game.players.find(player => player.id === 'b').hand.length, beforeB - 2);
  assert.equal(game.target.cardIds.length, 3); assert.equal(game.target.sourceTargetId, oldTarget);
  assert.notEqual(game.responseWindow.id, oldWindow); assert.equal(game.responseWindow.action, 'hook');
  reject(game, rival, 'STALE_TARGET');
  const beforeC = game.players.find(player => player.id === 'c').hand.length;
  game = act(game, 'hook', 'c');
  assert.equal(game.target.cardIds.length, 4);
  assert.equal(game.players.find(player => player.id === 'c').hand.length, beforeC - 1);
  assert.equal(game.playedIds.length, publicBefore + 4); assert.deepEqual(game.moves.slice(movesBefore).map(move => move.cardIds.length), [1, 2, 1]);
  assert.equal(new Set(game.playedIds).size, publicBefore + 4);
  assert.equal(game.target.rootId, game.moves[movesBefore].targetId);
});

test('T10/T22/T24: single chain 1→3→4→6→7 alternates and closes rather than exceeding eight', () => {
  let game = scenario({ a: rank(7), b: rank(7, 2, 1), c: rank(7, 2, 3), d: rank(7, 3, 5) });
  game = act(game, 'play', 'a', rank(7)); game = act(game, 'fork', 'b');
  reject(game, actionFor(game, 'fork', 'd'), 'STALE_WINDOW');
  game = act(game, 'hook', 'c');
  reject(game, actionFor(game, 'hook', 'd'), 'STALE_WINDOW');
  game = act(game, 'fork', 'd'); assert.equal(game.target.cardIds.length, 6);
  game = act(game, 'hook', 'c'); assert.equal(game.target.cardIds.length, 7);
  assert.equal(game.responseWindow, null); assert.equal(game.target.ownerId, 'c');
  reject(game, actionFor(game, 'hook', 'd'), 'RESPONSE_EXPIRED');
  reject(game, actionFor(game, 'fork', 'd'), 'RESPONSE_EXPIRED');
});

test('T23/T25: pair chain reaches eight, allows returning participants but disallows owner response', () => {
  let game = scenario({ a: rank(8, 3), b: rank(8, 3, 3), c: rank(8, 2, 6) });
  const publicBefore = game.playedIds.length;
  game = act(game, 'play', 'a', rank(8, 2)); game = act(game, 'hook', 'b');
  reject(game, actionFor(game, 'fork', 'b'), 'OWN_TARGET');
  game = act(game, 'fork', 'c'); assert.equal(game.target.cardIds.length, 5);
  game = act(game, 'hook', 'a'); assert.equal(game.target.cardIds.length, 6);
  game = act(game, 'fork', 'b'); assert.equal(game.target.cardIds.length, 8);
  assert.equal(game.target.ownerId, 'b'); assert.equal(game.turnPlayerId, 'a');
  assert.equal(game.responseWindow, null); assert.equal(game.playedIds.length, publicBefore + 8);
});

test('direct bombs are never response sources and king singles cannot be forked', () => {
  let game = scenario({ a: rank(6, 3), b: rank(6, 2, 3), c: rank(9) });
  game = act(game, 'play', 'a', rank(6, 3)); assert.equal(game.responseWindow, null);
  reject(game, actionFor(game, 'hook', 'b'), 'RESPONSE_EXPIRED');
  game = scenario({ a: rank(16), b: rank(16, 1, 1), c: rank(9) });
  game = act(game, 'play', 'a', rank(16)); assert.equal(game.responseWindow, null);
});

test('T12: passes preserve the window; exact expiry only closes response and does not impose turn timeout', () => {
  let game = scenario({ a: rank(5), b: rank(5, 2, 1), c: rank(9) });
  game = act(game, 'play', 'a', rank(5), 4000);
  const window = structuredClone(game.responseWindow), delayedHook = actionFor(game, 'fork', 'b');
  game = act(game, 'pass', 'c', undefined, 4500);
  assert.deepEqual(game.responseWindow, window); assert.equal(game.turnPlayerId, 'b');
  assert.equal(accepted(applyAction(game, delayedHook, { now: 8999 })).target.cardIds.length, 3);
  reject(game, delayedHook, 'RESPONSE_EXPIRED', 9000);
  const closed = accepted(advanceGame(game, { now: 9000 }));
  assert.equal(closed.turnPlayerId, 'b'); assert.equal(closed.responseWindow, null);
  const passed = act(game, 'pass', 'b', undefined, 9001);
  assert.equal(passed.target, null); assert.equal(passed.turnPlayerId, 'a');
  reject(passed, delayedHook, 'STALE_TARGET', 9002);
  const played = act(game, 'play', 'b', rank(5, 3, 1), 9001);
  assert.equal(played.target.pattern.kind, 'bomb');
});

test('a new target cannot inherit an old window or old winning request, even at the same rank', () => {
  let game = scenario({ a: rank(5), b: rank(5, 2, 1), c: rank(6) });
  game = act(game, 'play', 'a', rank(5)); const old = actionFor(game, 'fork', 'b');
  game = act(game, 'play', 'c', rank(6));
  reject(game, old, 'STALE_TARGET');
});

test('T13/T26: final rocket or response immediately wins, invalidates later actions and settles once', () => {
  let game = scenario({ a: mixed, b: rank(9), c: pure('hearts') }, { fill: false });
  game = act(game, 'play', 'a', mixed);
  assert.equal(game.status, 'finished'); assert.equal(game.result.winnerId, 'a'); assert.equal(game.responseWindow, null);
  reject(game, actionFor(game, 'play', 'c', pure('hearts')), 'NOT_PLAYING');
  assert.equal(accepted(cancelGame(game, 'server-recovery', { now: game.updatedAt + 1 })), game);
  assert.equal(abortGame(game, 'b', { now: game.updatedAt + 1 }).code, 'ALREADY_ENDED');
  assert.equal(game.result.deltas.reduce((sum, entry) => sum + entry.points, 0), 0);
  game = scenario({ a: [...rank(9, 2), ...rank(11)], b: rank(9, 1, 2), c: [...rank(9, 2, 3), ...rank(12)] }, { fill: false });
  game = act(game, 'play', 'a', rank(9, 2)); game = act(game, 'hook', 'b');
  assert.equal(game.status, 'finished'); assert.equal(game.result.winnerId, 'b'); assert.equal(game.responseWindow, null);
  reject(game, actionFor(game, 'fork', 'c'), 'NOT_PLAYING');
});

test('T14: voluntary eight-player abort has only compensation, including the locked dealing stage', () => {
  const game = create(8), cancelled = accepted(abortGame(game, 'p1', { now: 1 }));
  assert.equal(cancelled.status, 'aborted'); assert.equal(cancelled.result.winnerId, null);
  assert.equal(cancelled.result.deltas.find(entry => entry.playerId === 'p1').points, -35);
  assert.deepEqual(cancelled.result.deltas.filter(entry => entry.playerId !== 'p1').map(entry => entry.points), [5, 5, 5, 5, 5, 5, 5]);
  assert.equal(cancelled.result.deltas.reduce((sum, entry) => sum + entry.points, 0), 0);
  assert.equal(abortGame(game, 'spectator', { now: 1 }).ok, false);
});

test('T15: 120 seconds is measured from server last-seen; a live other device blocks cancellation', () => {
  assert.equal(disconnectExpired({ lastSeenAt: 10, now: 120009, hasLiveConnection: false }), false);
  assert.equal(disconnectExpired({ lastSeenAt: 10, now: 120010, hasLiveConnection: false }), true);
  assert.equal(disconnectExpired({ lastSeenAt: 10, now: 999999, hasLiveConnection: true }), false);
  const game = accepted(advanceGame(create(), { now: 3000 }));
  const cancelled = accepted(cancelGame(game, 'disconnected', { now: 123000 }));
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result.winnerId, null);
  assert.ok(cancelled.result.deltas.every(entry => entry.points === 0));
  reject(cancelled, actionFor(cancelled, 'play', game.turnPlayerId, [game.players.find(player => player.id === game.turnPlayerId).hand[0]]), 'NOT_PLAYING');
  assert.equal(cancelGame(game, 'client-says-offline', { now: 123000 }).ok, false);
});

test('T17: player and authorized spectator views exclude undealt order and enforce role membership', () => {
  const state = accepted(advanceGame(create(), { now: 500 }));
  const playerId = state.players[0].id, player = projectGame(state, { playerId, role: 'player' });
  const spectator = projectGame(state, { role: 'spectator' });
  assert.equal(Object.hasOwn(player, 'deck'), false); assert.equal(Object.hasOwn(spectator, 'deck'), false);
  assert.equal(player.players.filter(entry => Object.hasOwn(entry, 'hand')).length, 1);
  assert.equal(spectator.players.flatMap(entry => entry.hand).length, 18);
  const leaked = JSON.stringify(spectator);
  assert.ok(state.deck.slice(18).every(id => !leaked.includes(id)));
  assert.throws(() => projectGame(state, { playerId: 'spectator', role: 'player' }));
  const playing = accepted(advanceGame(state, { now: 3000 }));
  reject(playing, actionFor(playing, 'play', 'spectator', [playing.players[0].hand[0]]), 'NOT_PLAYER');
});

test('T21 boundary: summary uses shared 4a4 group and immutable version; permanent dedup belongs to storage', () => {
  const finished = accepted(abortGame(create(), 'p0', { now: 1 }));
  assert.equal(finished.result.accountGroup, '4a4');
  assert.equal(finished.result.gameType, 'poker414-2');
  assert.equal(finished.result.settlementVersion, 0);
  assert.equal(finished.result.scoringVersion, 'poker414-2-score-v1');
  assert.equal(Object.hasOwn(finished.result, 'balance'), false);
  assert.deepEqual(accepted(restoreGame(JSON.parse(JSON.stringify(finished)), { now: 10000 })).result, finished.result);
});

test('failure recovery cancels an unfinished match, never redeals or extends a response', () => {
  let game = scenario({ a: rank(5), b: rank(5, 2, 1), c: rank(9) });
  game = act(game, 'play', 'a', rank(5));
  const originalDeck = [...game.deck], restored = accepted(restoreGame(JSON.parse(JSON.stringify(game)), { now: 10000 }));
  assert.equal(restored.status, 'cancelled'); assert.equal(restored.result.reason, 'server-recovery');
  assert.deepEqual(restored.deck, originalDeck); assert.deepEqual(restored.players, game.players);
  assert.equal(restored.responseWindow, null); assert.ok(restored.result.deltas.every(entry => entry.points === 0));
});

test('all public action boundaries reject injected, duplicate, wrong-seat and wrong-match inputs immutably', () => {
  const game = accepted(advanceGame(create(), { now: 3000 })), actor = game.players.find(player => player.id === game.turnPlayerId);
  const valid = actionFor(game, 'play', actor.id, [actor.hand[0]]);
  reject(game, { ...valid, points: 100 }, 'INVALID_ACTION');
  reject(game, { ...valid, cardIds: [actor.hand[0], actor.hand[0]] }, 'INVALID_ACTION');
  reject(game, { ...valid, matchId: 'other-match' }, 'STALE_TARGET');
  reject(game, { ...valid, roundId: game.roundId + 1 }, 'STALE_TARGET');
  const rival = game.players.find(player => player.id !== actor.id);
  reject(game, { ...valid, cardIds: [rival.hand[0]] }, 'NOT_YOUR_CARD');
  reject(game, { ...valid, playerId: rival.id, cardIds: [rival.hand[0]] }, 'NOT_YOUR_TURN');
  reject(game, { ...valid, type: 'pause' }, 'INVALID_ACTION');
  assert.equal(applyAction(game, valid, { now: game.updatedAt - 1 }).code, 'INVALID_TIME');
});

test('saved state validation rejects versions, entity loss, ownership swaps, result changes and window forgery', () => {
  let game = scenario({ a: rank(5), b: rank(5, 2, 1), c: rank(9) });
  game = act(game, 'play', 'a', rank(5));
  const corruptions = [state => { state.version += 1; }, state => { state.players[0].hand.pop(); },
    state => { state.players[0].hand[0] = state.players[1].hand[0]; },
    state => { state.firstPlayerId = 'unknown'; }, state => { state.responseWindow.deadlineAt += 1; },
    state => { state.target.source = 'hook'; }, state => { state.turnPlayerId = state.target.ownerId; },
    state => { state.moves[0].cardIds.push(state.moves[0].cardIds[0]); }, state => { state.secret = 'unknown field'; }];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(game); corrupt(candidate);
    assert.equal(validateGame(candidate), false);
    assert.equal(restoreGame(candidate, { now: 10000 }).ok, false);
  }
  const ended = accepted(abortGame(game, 'a', { now: 4000 })); ended.result.deltas[0].points += 1;
  assert.equal(validateGame(ended), false);
});

test('saved first lead must remain with the first officially dealt heart-three owner', () => {
  const game = accepted(advanceGame(create(), { now: 3000 }));
  const other = game.players.find(player => player.id !== game.firstPlayerId);
  for (const corrupt of [state => { state.turnPlayerId = other.id; }, state => { state.roundId = 2; }]) {
    const damaged = structuredClone(game); corrupt(damaged);
    assert.equal(validateGame(damaged), false);
    assert.equal(restoreGame(damaged, { now: 3001 }).code, 'INVALID_STATE');
    assert.equal(applyAction(damaged, actionFor(damaged, 'play', damaged.turnPlayerId,
      [damaged.players.find(player => player.id === damaged.turnPlayerId).hand[0]]), { now: 3001 }).code, 'INVALID_STATE');
  }
});

test('saved new-round lead stays with the last target owner after passes or a heart rocket', () => {
  let passed = accepted(advanceGame(create(), { now: 3000 }));
  const leader = passed.turnPlayerId, hand = passed.players.find(player => player.id === leader).hand;
  passed = act(passed, 'play', leader, [hand[0]]);
  passed = act(passed, 'pass'); passed = act(passed, 'pass');
  assert.equal(passed.target, null); assert.equal(passed.turnPlayerId, leader);
  let rocket = scenario({ a: pure('hearts'), b: rank(8), c: rank(9) });
  rocket = act(rocket, 'play', 'a', pure('hearts'));
  for (const game of [passed, rocket]) {
    const other = game.players.find(player => player.id !== game.turnPlayerId);
    for (const corrupt of [state => { state.turnPlayerId = other.id; }, state => { state.roundId += 1; }]) {
      const damaged = structuredClone(game); corrupt(damaged);
      assert.equal(validateGame(damaged), false);
      assert.equal(restoreGame(damaged, { now: damaged.updatedAt + 1 }).code, 'INVALID_STATE');
      assert.equal(applyAction(damaged, actionFor(damaged, 'play', damaged.turnPlayerId,
        [damaged.players.find(player => player.id === damaged.turnPlayerId).hand[0]]), { now: damaged.updatedAt + 1 }).code, 'INVALID_STATE');
    }
  }
});

test('creation refuses unsupported players, randomness, clock and client-injected configuration', () => {
  for (const count of [2, 9]) assert.throws(() => create(count));
  for (const random of [() => -0.1, () => 1, () => NaN, () => '0.5']) assert.throws(() => create(3, { random }));
  assert.throws(() => create(3, { players: ['same', 'same', 'c'] }));
  assert.throws(() => create(3, { now: -1 }));
  assert.throws(() => create(3, { deck: [] }));
  assert.throws(() => create(3, { dealBatchSize: 0 }));
});

for (const count of [3, 8]) {
  test(`${count} seats: real creation-to-finish script keeps entities, privacy and final score coherent`, () => {
    let seed = count * 9157;
    const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
    let game = accepted(advanceGame(create(count, { random }), { now: 3000 })), actions = 0;
    while (game.status === 'playing' && actions < 1000) {
      const player = game.players.find(candidate => candidate.id === game.turnPlayerId);
      const candidates = enumerateLegalPlays(player.hand, game.target?.pattern || null);
      game = candidates.length ? act(game, 'play', player.id, candidates[0].cardIds)
        : act(game, 'pass', player.id);
      const view = projectGame(game, { playerId: player.id, role: 'player' });
      assert.ok(view.players.filter(candidate => candidate.id !== player.id).every(candidate => !Object.hasOwn(candidate, 'hand')));
      assert.equal(new Set([...game.playedIds, ...game.players.flatMap(candidate => candidate.hand)]).size, 108);
      actions += 1;
    }
    assert.equal(game.status, 'finished'); assert.ok(actions < 1000);
    assert.equal(game.players.filter(player => player.hand.length === 0).length, 1);
    assert.equal(game.result.deltas.reduce((sum, entry) => sum + entry.points, 0), 0);
    assert.deepEqual(accepted(restoreGame(JSON.parse(JSON.stringify(game)), { now: game.updatedAt + 10000 })).result, game.result);
  });
}
