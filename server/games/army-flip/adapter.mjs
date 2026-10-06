import * as engine from '../../../app/games/army-flip/rules.mjs';
import { problem, publicFields } from '../adapter-contract.mjs';

const gameType = 'army-flip';
const ruleVersions = Object.freeze(['army-flip-v1', 'army-flip-v2', 'army-flip-v3']);
const actions = Object.freeze({ flip: Object.freeze(['cellId']), move: Object.freeze(['from', 'to']),
  pickup: Object.freeze(['cellId', 'flagSide']), resign: Object.freeze([]), 'offer-draw': Object.freeze([]),
  'accept-draw': Object.freeze([]), 'decline-draw': Object.freeze([]) });
const fields = ['version', 'ruleVersion', 'board', 'players', 'turnIndex', 'turnPlayerId', 'round',
  'revision', 'status', 'winnerId', 'result', 'assignment', 'capturedPieces', 'drawOfferByPlayerId', 'lastAction', 'flagTokens'];

export function createArmyFlipAdapter() {
  return Object.freeze({ gameType, minPlayers: 2, maxPlayers: 2, ruleVersions,
    actionTypes: Object.freeze(Object.keys(actions)),
    // Keep the historical unsupported-config response after the generic field check.
    configurationFields: Object.freeze(['jokerConfig']),
    createGame: engine.createGame, privateView: engine.privateView,
    spectatorView(game) {
      const view = engine.privateView(game, game.players[0].id);
      return publicFields(view, fields, gameType, { legalFlips: [], legalMoves: [],
        ...(['army-flip-v2', 'army-flip-v3'].includes(view.ruleVersion) ? { legalPickups: [] } : {}) });
    },
    applyGameAction: (game, playerId, action) => engine.applyGameAction(game, playerId,
      action && typeof action === 'object' ? Object.fromEntries(['type', ...(actions[action.type] ?? [])].map(field => [field, action[field]])) : action),
    actionFields: type => Object.hasOwn(actions, type) ? actions[type] : null,
    validateAction(action) {
      for (const field of actions[action.type] ?? []) if (typeof action[field] !== 'string' || !action[field].length || action[field].length > 128)
        return problem(400, 'INVALID_ACTION', '棋盘操作需要有效的格子位置。');
      return null;
    },
    stateProblem(game) {
      if (!ruleVersions.includes(game?.ruleVersion)) return '对局规则版本无效。';
      return engine.gameProblem(game);
    },
    configurationSupportProblem: () => problem(400, 'CONFIG_UNSUPPORTED', '这个游戏没有拉密鬼牌设置。'),
    configure: () => ({ problem: problem(400, 'CONFIG_UNSUPPORTED', '这个游戏没有拉密鬼牌设置。') }),
    roomView: () => ({ jokerConfig: null }), gameOptions: (room, options) => ({ ...options }), playerSummary: () => ({}),
    playerResult(result, playerId) {
      const winners = result?.winnerIds ?? [];
      return { outcome: !result ? 'unscored' : result.tie ? 'draw' : winners.includes(playerId) ? winners.length > 1 ? 'draw' : 'win' : 'loss', remainingPoints: null };
    },
    describeAction: ({ action, player }) => ({ flip: `${player.name}翻开一枚棋子。`, move: `${player.name}移动了棋子。`,
      pickup: `${player.name}拿起${action.flagSide === 'red' ? '红方' : '黑方'}军旗。`, resign: `${player.name}认输了。`,
      'offer-draw': `${player.name}提议和棋。`, 'accept-draw': `${player.name}接受了和棋。`, 'decline-draw': `${player.name}拒绝了和棋。` })[action.type],
    supportsTimeout: game => game.ruleVersion === 'army-flip-v3',
    applyTimeout: engine.applyTimeout,
    describeTimeout: (game, player) => `${player.name}本回合时间已到，自动跳过。`,
    snapshotSchema: room => Object.hasOwn(room, 'turnClock') ? 7 : !room.game || room.game.ruleVersion === 'army-flip-v3' ? 6
      : room.game.ruleVersion === 'army-flip-v2' ? 5 : room.rolesEnabled || room.spectators?.length ? 4 : 3,
    snapshotProblem: data => ![3, 4, 5, 6, 7].includes(data.schemaVersion)
      || data.schemaVersion === 6 && data.game && data.game.ruleVersion !== 'army-flip-v3'
      || data.schemaVersion === 5 && data.game && data.game.ruleVersion !== 'army-flip-v2'
      || data.schemaVersion !== 5 && data.game?.ruleVersion === 'army-flip-v2'
      || ![6, 7].includes(data.schemaVersion) && data.game?.ruleVersion === 'army-flip-v3',
    roomStateProblem: data => data.jokerConfig !== undefined ? '房间设置的版本无效。' : null,
    historyPlayerProblem: (status, player) => player.remainingPoints !== null
      || (status === 'completed' ? player.outcome === 'unscored' : player.outcome !== 'unscored'),
    historyOutcomeProblem: (wins, draws, count) => !(wins === 1 && draws === 0 || wins === 0 && draws === count),
  });
}
