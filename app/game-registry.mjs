// Server-only game dispatch. Never add this module or either full engine to the
// HTTP asset allow-list: their return values contain private authoritative state.
import * as rummikub from './multiplayer-rules.mjs';
import * as army from './army-rules.mjs';

const catalogs = Object.freeze({
  rummikub: Object.freeze({ gameType: 'rummikub', minPlayers: 2, maxPlayers: 7,
    ruleVersions: Object.freeze(['friends-v1', 'friends-v2', 'friends-v3', 'friends-v4']), engine: rummikub,
    actions: Object.freeze({ submit: Object.freeze(['boardIds', 'rackIds', 'boardPositions']),
      draw: Object.freeze(['boardPositions']), pass: Object.freeze(['boardPositions']) }) }),
  'army-flip': Object.freeze({ gameType: 'army-flip', minPlayers: 2, maxPlayers: 2,
    ruleVersions: Object.freeze(['army-flip-v1', 'army-flip-v2', 'army-flip-v3']), engine: army,
    actions: Object.freeze({ flip: Object.freeze(['cellId']), move: Object.freeze(['from', 'to']),
      pickup: Object.freeze(['cellId', 'flagSide']),
      resign: Object.freeze([]), 'offer-draw': Object.freeze([]), 'accept-draw': Object.freeze([]), 'decline-draw': Object.freeze([]) }) }),
});

function publicProjection(engine, game, gameType) {
  const view = typeof engine.spectatorView === 'function' ? engine.spectatorView(game)
    : engine.privateView(game, game.players[0].id);
  const common = ['version', 'ruleVersion', 'board', 'players', 'turnIndex', 'turnPlayerId',
    'round', 'revision', 'status', 'winnerId', 'result'];
  const fields = gameType === 'army-flip' ? [...common, 'assignment', 'capturedPieces', 'drawOfferByPlayerId', 'lastAction', 'flagTokens']
    : [...common, 'boardPositions', 'poolCount', 'consecutivePasses', 'copies', 'jokerCount', 'jokerConfig', 'tileCount', 'deckCopies', 'deckSize'];
  // The actual engines already project every nested object by allow-list. This
  // second boundary prevents any player-specific top-level data from reaching
  // a spectator if an adapter changes in a future release.
  return { ...Object.fromEntries(fields.filter((field) => Object.hasOwn(view, field))
    .map((field) => [field, structuredClone(view[field])])), gameType,
    ...(gameType === 'army-flip' ? { legalFlips: [], legalMoves: [], ...(['army-flip-v2', 'army-flip-v3'].includes(view.ruleVersion) ? { legalPickups: [] } : {}) } : {}) };
}

export function normalizeGameType(value = 'rummikub') {
  if (typeof value !== 'string' || !Object.hasOwn(catalogs, value)) throw new TypeError('不支持这个游戏类型。');
  return value;
}

export function gameInfo(value = 'rummikub') {
  const { gameType, minPlayers, maxPlayers } = catalogs[normalizeGameType(value)];
  return { gameType, minPlayers, maxPlayers };
}

export function gameAdapter(value = 'rummikub', { gameEngine } = {}) {
  const item = catalogs[normalizeGameType(value)];
  // The historical test seam customizes only Rummikub. A custom engine must not
  // silently replace a different persisted game's authoritative implementation.
  const engine = item.gameType === 'rummikub' && gameEngine ? gameEngine : item.engine;
  if (['createGame', 'applyGameAction', 'privateView'].some((name) => typeof engine[name] !== 'function')) {
    throw new TypeError('游戏引擎不完整。');
  }
  return { ...gameInfo(item.gameType), ruleVersions: item.ruleVersions,
    createGame: engine.createGame.bind(engine), privateView: engine.privateView.bind(engine),
    spectatorView: (game) => publicProjection(engine, game, item.gameType),
    applyTimeout: (game, playerId) => item.gameType === 'army-flip' && typeof engine.applyTimeout === 'function'
      ? engine.applyTimeout(game, playerId) : { ok: false, error: '这个规则版本没有自动跳过。' },
    applyGameAction: (game, playerId, action) => engine.applyGameAction(game, playerId,
      item.gameType === 'army-flip' && action && typeof action === 'object'
        ? Object.fromEntries(['type', ...(item.actions[action.type] ?? [])].map((field) => [field, action[field]]))
        : action),
    actionFields: (type) => Object.hasOwn(item.actions, type) ? item.actions[type] : null,
    stateProblem: (game) => {
      if (!item.ruleVersions.includes(game?.ruleVersion)) return '对局规则版本无效。';
      return typeof engine.gameProblem === 'function' ? engine.gameProblem(game) : null;
    } };
}
