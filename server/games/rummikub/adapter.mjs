import * as rules from '../../../app/games/rummikub/multiplayer.mjs';
import { normalizeJokerConfig } from '../../../app/games/rummikub/rules.mjs';
import { point, problem, publicFields } from '../adapter-contract.mjs';

const gameType = 'rummikub';
const ruleVersions = Object.freeze(['friends-v1', 'friends-v2', 'friends-v3', 'friends-v4']);
const actions = Object.freeze({ submit: Object.freeze(['boardIds', 'rackIds', 'boardPositions']),
  draw: Object.freeze(['boardPositions']), pass: Object.freeze(['boardPositions']) });
const fields = ['version', 'ruleVersion', 'board', 'players', 'turnIndex', 'turnPlayerId', 'round',
  'revision', 'status', 'winnerId', 'result', 'boardPositions', 'poolCount', 'consecutivePasses',
  'copies', 'jokerCount', 'jokerConfig', 'tileCount', 'deckCopies', 'deckSize'];
const canonical = value => JSON.stringify(Object.keys(value ?? {}).sort().map(key => [key, value[key]]));

export function createRummikubAdapter({ gameEngine = rules } = {}) {
  const engine = gameEngine;
  if (['createGame', 'applyGameAction', 'privateView'].some(name => typeof engine[name] !== 'function')) throw new TypeError('游戏引擎不完整。');
  return Object.freeze({ gameType, minPlayers: 2, maxPlayers: 7, ruleVersions,
    actionTypes: Object.freeze(Object.keys(actions)), configurationFields: Object.freeze(['jokerConfig']),
    withEngine: replacement => createRummikubAdapter({ gameEngine: replacement }),
    createGame: engine.createGame.bind(engine), applyGameAction: engine.applyGameAction.bind(engine),
    privateView: engine.privateView.bind(engine),
    spectatorView(game) {
      const view = typeof engine.spectatorView === 'function' ? engine.spectatorView(game) : engine.privateView(game, game.players[0].id);
      return publicFields(view, fields, gameType);
    },
    actionFields: type => Object.hasOwn(actions, type) ? actions[type] : null,
    validateAction: () => null,
    stateProblem(game) {
      if (!ruleVersions.includes(game?.ruleVersion)) return '对局规则版本无效。';
      return typeof engine.gameProblem === 'function' ? engine.gameProblem(game) : null;
    },
    configurationSupportProblem: () => null,
    configure(room, input) {
      let jokerConfig;
      try { jokerConfig = normalizeJokerConfig(input.jokerConfig); }
      catch { return { problem: problem(400, 'INVALID_JOKER_CONFIG', '鬼牌设置需要四类0～8张，总数不超过24张。') }; }
      if (canonical(room.jokerConfig) === canonical(jokerConfig)) return { problem: problem(409, 'CONFIG_UNCHANGED', '鬼牌设置没有变化。') };
      return { updates: { jokerConfig } };
    },
    roomView: room => ({ jokerConfig: room.jokerConfig ? structuredClone(room.jokerConfig) : null }),
    gameOptions: (room, options) => ({ ...options, ...(room.jokerConfig ? { jokerConfig: structuredClone(room.jokerConfig) } : {}) }),
    playerSummary(view, playerId) {
      const player = view?.players.find(entry => entry.id === playerId);
      return player ? { rackCount: player.rackCount, opened: player.opened } : {};
    },
    playerResult(result, playerId) {
      const winners = result?.winnerIds ?? [];
      const scores = new Map((result?.scores ?? []).map(score => [score.playerId, score.points]));
      return { outcome: !result ? 'unscored' : winners.includes(playerId) ? winners.length > 1 ? 'draw' : 'win' : 'loss',
        remainingPoints: result ? scores.get(playerId) ?? null : null };
    },
    describeAction({ action, player, beforeGame, afterGame }) {
      const before = beforeGame?.players.find(entry => entry.id === player.id)?.rack?.length ?? 0;
      return { configure: `${player.name}更改了鬼牌设置，所有玩家需要重新准备。`,
        submit: `${player.name}出牌${before - (afterGame?.players.find(entry => entry.id === player.id)?.rack?.length ?? before)}张。`,
        draw: `${player.name}摸了1张牌。`, pass: `${player.name}跳过本回合。` }[action.type];
    },
    supportsTimeout: () => true,
    applyTimeout: (game, playerId) => engine.applyGameAction(game, playerId, { type: game.pool.length ? 'draw' : 'pass' }),
    describeTimeout: (game, player) => `${player.name}本回合时间已到，${game.pool?.length > 0 ? '自动摸牌。' : '牌池已空，自动跳过。'}`,
    snapshotSchema: room => room.game?.ruleVersion === 'friends-v4' ? 8 : Object.hasOwn(room, 'turnClock') ? 7
      : room.rolesEnabled || room.spectators?.length ? 4 : 2,
    snapshotProblem: data => ![1, 2, 4, 7, 8].includes(data.schemaVersion)
      || data.schemaVersion === 8 && data.game?.ruleVersion !== 'friends-v4'
      || data.schemaVersion !== 8 && data.game?.ruleVersion === 'friends-v4',
    roomStateProblem(data, hasRoles) {
      if (data.jokerConfig !== undefined) {
        if (!hasRoles) return '房间设置的版本无效。';
        try { data.jokerConfig = normalizeJokerConfig(data.jokerConfig); }
        catch { return '房间保存的鬼牌设置无效。'; }
      }
      if (data.game && (['friends-v3', 'friends-v4'].includes(data.game.ruleVersion)
        ? !data.jokerConfig || canonical(data.jokerConfig) !== canonical(data.game.jokerConfig)
        : data.jokerConfig !== undefined)) return '本局鬼牌设置与房间保存内容不一致。';
      return null;
    },
    historyPlayerProblem: (status, player) => status === 'completed' ? !point(player.remainingPoints) || player.outcome === 'unscored'
      : player.outcome !== 'unscored' || !(player.remainingPoints === null || point(player.remainingPoints)),
    historyOutcomeProblem: (wins, draws) => !(wins === 1 && draws === 0 || wins === 0 && draws >= 2),
  });
}
