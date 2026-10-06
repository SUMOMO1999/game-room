// Server-only helpers. An adapter must explicitly define every game policy;
// there is no default draw, score, configuration or projection for a new game.
export const problem = (status, code, message) => ({ status, code, message });
export function publicFields(view, fields, gameType, extra = {}) {
  return { ...Object.fromEntries(fields.filter(field => Object.hasOwn(view, field))
    .map(field => [field, structuredClone(view[field])])), gameType, ...extra };
}
export const point = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000;
export function requireAdapter(adapter) {
  const methods = ['createGame', 'applyGameAction', 'privateView', 'spectatorView', 'stateProblem',
    'actionFields', 'validateAction', 'configurationSupportProblem', 'configure', 'roomView',
    'gameOptions', 'playerSummary', 'playerResult', 'describeAction', 'supportsTimeout',
    'applyTimeout', 'describeTimeout', 'snapshotSchema', 'snapshotProblem', 'roomStateProblem',
    'historyPlayerProblem', 'historyOutcomeProblem'];
  if (!adapter || typeof adapter.gameType !== 'string' || !adapter.gameType
      || !Number.isSafeInteger(adapter.minPlayers) || adapter.minPlayers < 2
      || !Number.isSafeInteger(adapter.maxPlayers) || adapter.maxPlayers < adapter.minPlayers
      || !Array.isArray(adapter.ruleVersions) || !adapter.ruleVersions.length
      || !Array.isArray(adapter.actionTypes) || !Array.isArray(adapter.configurationFields)
      || methods.some(name => typeof adapter[name] !== 'function')) throw new TypeError('游戏适配器不完整。');
  return adapter;
}
