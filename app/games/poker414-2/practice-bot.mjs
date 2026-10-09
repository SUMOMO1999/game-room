/** Small deterministic practice opponent. Scheduling and applying actions belong to the controller. */
import { cardsProblem, enumerateLegalPlays, chooseResponseCards, beatsPattern } from './patterns.mjs';

function privateHand(game, playerId) {
  // A full state or spectator projection would let future strategies accidentally cheat.
  if (!game || game.gameType !== 'poker414-2' || Object.hasOwn(game, 'deck')
      || !Array.isArray(game.players)
      || game.players.some(player => player.id !== playerId && Object.hasOwn(player, 'hand'))) return null;
  const hand = game.players.find(player => player.id === playerId)?.hand;
  return cardsProblem(hand) || !hand.length ? null : hand;
}

function chooseOrdinaryPlay(choices, handSize, hasTarget) {
  const finishing = choices.find(choice => choice.cardIds.length === handSize);
  if (finishing) return finishing;
  if (!hasTarget) {
    // Shed useful combinations together, with stable low ranks winning equal-size ties.
    return choices.sort((a, b) => b.cardIds.length - a.cardIds.length
      || a.pattern.rank - b.pattern.rank || a.pattern.rocketTier - b.pattern.rocketTier)[0];
  }
  // The rule comparator also handles bombs and rocket grades; do not copy its strength table.
  return choices.reduce((smallest, candidate) => !smallest || beatsPattern(smallest.pattern, candidate.pattern)
    ? candidate : smallest, null);
}

/**
 * Accept only projectGame(state, { role: 'player', playerId }). Public window
 * information permits an out-of-turn hook/fork. The caller must still apply
 * this action through the authoritative rules against the current state.
 */
export function choosePoker414BotAction(projectedGame, playerId, { now = Date.now() } = {}) {
  const game = projectedGame, hand = privateHand(game, playerId);
  if (!hand || game.status !== 'playing' || game.stage !== 'playing'
      || !Number.isSafeInteger(now) || now < 0) return null;
  const common = { playerId, matchId: game.matchId, roundId: game.roundId, targetId: game.target?.id || null };
  const window = game.responseWindow;
  if (window && game.target?.ownerId !== playerId && now < window.deadlineAt
      && chooseResponseCards(hand, window.rank, window.action)) {
    return { type: window.action, ...common, windowId: window.id };
  }
  if (game.turnPlayerId !== playerId) return null;
  const choices = enumerateLegalPlays(hand, game.target?.pattern || null);
  const chosen = chooseOrdinaryPlay(choices, hand.length, Boolean(game.target));
  if (chosen) return { type: 'play', ...common, cardIds: chosen.cardIds };
  return game.target ? { type: 'pass', ...common } : null;
}
