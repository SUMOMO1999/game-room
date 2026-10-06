// Server-only game dispatch. Never add this module or any full engine/adapter to
// the HTTP asset allow-list: their return values contain private authoritative state.
import { createRummikubAdapter } from '../server/games/rummikub/adapter.mjs';
import { createArmyFlipAdapter } from '../server/games/army-flip/adapter.mjs';
import { createFlyingChessAdapter } from '../server/games/flying-chess/adapter.mjs';
import { requireAdapter } from '../server/games/adapter-contract.mjs';

export function createGameRegistry(adapters) {
  const catalog = new Map();
  for (const entry of adapters) {
    const adapter = requireAdapter(entry);
    if (catalog.has(adapter.gameType)) throw new TypeError('重复的游戏类型。');
    catalog.set(adapter.gameType, adapter);
  }
  function normalizeGameType(value = 'rummikub') {
    if (typeof value !== 'string' || !catalog.has(value)) throw new TypeError('不支持这个游戏类型。');
    return value;
  }
  function gameInfo(value = 'rummikub') {
    const { gameType, minPlayers, maxPlayers } = catalog.get(normalizeGameType(value));
    return { gameType, minPlayers, maxPlayers };
  }
  function gameAdapter(value = 'rummikub', { gameEngine } = {}) {
    const adapter = catalog.get(normalizeGameType(value));
    // Only an adapter which explicitly supports the old engine seam can use it.
    return gameEngine && typeof adapter.withEngine === 'function' ? requireAdapter(adapter.withEngine(gameEngine)) : adapter;
  }
  return Object.freeze({ normalizeGameType, gameInfo, gameAdapter,
    activityTypes: () => [...new Set([...catalog.values()].flatMap(adapter => adapter.actionTypes))] });
}

export const defaultGameRegistry = createGameRegistry([createRummikubAdapter(), createArmyFlipAdapter(), createFlyingChessAdapter()]);
// Historical exports and default game remain available to existing callers.
export const normalizeGameType = defaultGameRegistry.normalizeGameType;
export const gameInfo = defaultGameRegistry.gameInfo;
export const gameAdapter = defaultGameRegistry.gameAdapter;
