import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePoker414BotAction } from './practice-bot.mjs';
import { makeDeck, getCard } from './cards.mjs';
import { compareCardIds, classifyPattern } from './patterns.mjs';
import { createGame, advanceGame, applyAction, projectGame, gameProblem } from './rules.mjs';

const deck = makeDeck(), allIds = deck.map(card => card.id);
const rank = (value, count = 1, offset = 0) => deck.filter(card => card.rank === value)
  .slice(offset, offset + count).map(card => card.id);
const heartThree = deck.find(card => card.rank === 3 && card.suit === 'hearts').id;
const privateView = (game, playerId) => projectGame(game, { role: 'player', playerId });
const choose = (game, playerId, now = game.updatedAt + 1) => choosePoker414BotAction(privateView(game, playerId), playerId, { now });
function accepted(result) {
  assert.equal(result.ok, true, result.error);
  assert.equal(gameProblem(result.state), null);
  return result.state;
}
function play(game, playerId, cardIds) {
  return accepted(applyAction(game, { type: 'play', playerId, cardIds, matchId: game.matchId,
    roundId: game.roundId, targetId: game.target?.id || null }, { now: game.updatedAt + 1 }));
}

/** Arrange a complete legal deal; every subsequent action goes through the real rules. */
function dealtWith(hands) {
  const ids = Object.keys(hands), state = createGame({ players: ids, matchId: 'bot-fixture', random: () => 0.999, now: 0 });
  state.firstDealerId = ids[0];
  const desired = ids.flatMap(id => hands[id]);
  assert.equal(new Set(desired).size, desired.length);
  const rest = allIds.filter(id => !desired.includes(id));
  const queues = new Map(ids.map(id => {
    const count = Array.from({ length: 108 }, (_, index) => state.actionOrder[index % ids.length]).filter(owner => owner === id).length;
    return [id, [...hands[id], ...rest.splice(0, count - hands[id].length)]];
  }));
  state.deck = Array.from({ length: 108 }, (_, index) => queues.get(state.actionOrder[index % ids.length]).shift());
  return accepted(advanceGame(state, { now: 3000 }));
}

test('practice bot only consumes its private player projection, never a full state or spectator hands', () => {
  const game = dealtWith({ a: [heartThree], b: [], c: [] });
  assert.equal(choosePoker414BotAction(game, 'a', { now: 3001 }), null);
  assert.equal(choosePoker414BotAction(projectGame(game, { role: 'spectator' }), 'a', { now: 3001 }), null);
  assert.equal(choosePoker414BotAction(privateView(game, 'a'), 'b', { now: 3001 }), null);
  assert.ok(choose(game, 'a'));
});

test('changing opponents hidden cards leaves the deterministic decision unchanged', () => {
  const game = dealtWith({ a: [heartThree], b: [], c: [] }), alternate = structuredClone(game);
  const b = alternate.players.find(player => player.id === 'b'), c = alternate.players.find(player => player.id === 'c');
  const bCard = b.hand.find(id => getCard(id).rank !== 3), cCard = c.hand.find(id => getCard(id).rank !== 3);
  b.hand = b.hand.map(id => id === bCard ? cCard : id).sort(compareCardIds);
  c.hand = c.hand.map(id => id === cCard ? bCard : id).sort(compareCardIds);
  alternate.deck = alternate.deck.map(id => id === bCard ? cCard : id === cCard ? bCard : id);
  assert.equal(gameProblem(alternate), null);
  assert.deepEqual(privateView(game, 'a'), privateView(alternate, 'a'));
  assert.deepEqual(choose(game, 'a'), choose(alternate, 'a'));
});

test('bot responds out of turn, follows an alternating chain to eight cards, then stops responding', () => {
  let game = dealtWith({ a: [heartThree, ...rank(8, 3)], b: rank(8, 3, 3), c: rank(8, 2, 6) });
  game = play(game, 'a', rank(8, 2));
  for (const [id, type, count] of [['b', 'hook', 3], ['c', 'fork', 5], ['a', 'hook', 6], ['b', 'fork', 8]]) {
    const action = choose(game, id);
    assert.equal(action.type, type);
    game = accepted(applyAction(game, action, { now: game.updatedAt + 1 }));
    assert.equal(game.target.cardIds.length, count);
  }
  assert.equal(game.responseWindow, null);
  assert.equal(choose(game, 'b'), null);
  const next = choose(game, game.turnPlayerId);
  assert.ok(['play', 'pass'].includes(next.type));
  accepted(applyAction(game, next, { now: game.updatedAt + 1 }));
});

test('expired response and target owner never emit a hook or fork', () => {
  let game = dealtWith({ a: [heartThree, ...rank(7, 3)], b: rank(7, 2, 3), c: rank(7, 3, 5) });
  game = play(game, 'a', rank(7));
  assert.equal(choose(game, 'a'), null);
  assert.equal(choose(game, 'b').type, 'fork');
  assert.equal(choose(game, 'b', game.responseWindow.deadlineAt), null);
  const current = choose(game, game.turnPlayerId, game.responseWindow.deadlineAt);
  assert.ok(['play', 'pass'].includes(current.type));
});

function strategyView(hand, targetCards = null) {
  return { gameType: 'poker414-2', status: 'playing', stage: 'playing', matchId: 'choice', roundId: 1,
    turnPlayerId: 'a', players: [{ id: 'a', hand }, { id: 'b', handCount: 20 }, { id: 'c', handCount: 20 }],
    target: targetCards ? { id: 'target', ownerId: 'b', cardIds: targetCards, pattern: classifyPattern(targetCards) } : null,
    responseWindow: null };
}

test('lead sheds a low long combination; following uses the smallest legal response or passes', () => {
  let view = strategyView([...rank(5), ...rank(6), ...rank(7), ...rank(12, 2)]);
  const before = structuredClone(view);
  assert.deepEqual(choosePoker414BotAction(view, 'a', { now: 1 }).cardIds, [...rank(5), ...rank(6), ...rank(7)]);
  assert.deepEqual(view, before);
  view = strategyView([...rank(7), ...rank(9), ...rank(12, 3)], rank(6));
  assert.deepEqual(choosePoker414BotAction(view, 'a', { now: 1 }).cardIds, rank(7));
  view = strategyView([...rank(7), ...rank(9)], rank(12));
  assert.equal(choosePoker414BotAction(view, 'a', { now: 1 }).type, 'pass');
});

for (const count of [3, 4, 8]) {
  test(`${count} projected bots complete a real 108-card game with valid actions and one zero-sum settlement`, () => {
    let seed = count;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    let game = createGame({ players: Array.from({ length: count }, (_, index) => `bot-${index}`),
      matchId: `full-${count}`, random, now: 0 });
    for (const player of game.players) assert.equal(choose(game, player.id), null);
    game = accepted(advanceGame(game, { now: 3000 }));
    let actions = 0;
    while (game.status === 'playing' && actions < 1000) {
      const candidates = game.actionOrder.map(id => choose(game, id));
      const action = candidates.find(candidate => candidate && ['hook', 'fork'].includes(candidate.type))
        || candidates.find(Boolean);
      assert.ok(action, 'an ordinary turn must always progress');
      game = accepted(applyAction(game, action, { now: game.updatedAt + 1 }));
      actions += 1;
    }
    assert.equal(game.status, 'finished', 'finite practice game must finish');
    assert.equal(game.result.reason, 'emptied-hand');
    assert.equal(game.result.deltas.reduce((sum, delta) => sum + delta.points, 0), 0);
    assert.equal(new Set([...game.playedIds, ...game.players.flatMap(player => player.hand)]).size, 108);
    for (const player of game.players) assert.equal(choose(game, player.id), null);
  });
}
