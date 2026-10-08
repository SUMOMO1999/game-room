// Server-only game dispatch. Never add this module or any full engine/adapter to
// the HTTP asset allow-list: their return values contain private authoritative state.
import { createRummikubAdapter } from '../server/games/rummikub/adapter.mjs';
import { createArmyFlipAdapter } from '../server/games/army-flip/adapter.mjs';
import { createFlyingChessAdapter } from '../server/games/flying-chess/adapter.mjs';
import { createDrawAndGuessAdapter } from '../server/games/draw-and-guess/adapter.mjs';
import { createPoker414Adapter } from '../server/games/poker414-2/adapter.mjs';
import { requireAdapter } from '../server/games/adapter-contract.mjs';

export function createGameRegistry(adapters, { creationTypes } = {}) {
  const catalog = new Map();
  for (const entry of adapters) {
    const adapter = requireAdapter(entry);
    if (catalog.has(adapter.gameType)) throw new TypeError('重复的游戏类型。');
    catalog.set(adapter.gameType, adapter);
  }
  if (creationTypes !== undefined && (!Array.isArray(creationTypes) || new Set(creationTypes).size !== creationTypes.length)) throw new TypeError('创建目录需要不同游戏的列表。');
  const creatable = new Set(creationTypes ?? catalog.keys());
  if ([...creatable].some(type => !catalog.has(type))) throw new TypeError('创建目录包含未知游戏。');
  function knownAdapter(value) {
    if (typeof value !== 'string' || !catalog.has(value)) throw new TypeError('不支持这个游戏类型。');
    return catalog.get(value);
  }
  // Creation availability is independent of saved-state readability. A hidden
  // game cannot be newly created, but backup/recovery must still understand it.
  function normalizeGameType(value = 'rummikub') {
    if (typeof value !== 'string' || !creatable.has(value)) throw new TypeError('这个游戏尚未开放创建。');
    return value;
  }
  function gameInfo(value = 'rummikub') {
    const { gameType, minPlayers, maxPlayers } = knownAdapter(value);
    return { gameType, minPlayers, maxPlayers };
  }
  function gameAdapter(value = 'rummikub', { gameEngine } = {}) {
    const adapter = knownAdapter(value);
    // Only an adapter which explicitly supports the old engine seam can use it.
    return gameEngine && typeof adapter.withEngine === 'function' ? requireAdapter(adapter.withEngine(gameEngine)) : adapter;
  }
  return Object.freeze({ normalizeGameType, gameInfo, gameAdapter,
    creationTypes: () => Object.freeze([...creatable]),
    activityTypes: () => [...new Set([...catalog.values()].flatMap(adapter => adapter.actionTypes))] });
}

export const defaultGameRegistry = createGameRegistry([createRummikubAdapter(), createArmyFlipAdapter(), createFlyingChessAdapter(), createDrawAndGuessAdapter(), createPoker414Adapter()],
  { creationTypes: ['rummikub', 'army-flip', 'flying-chess', 'draw-and-guess'] });
// Historical exports and default game remain available to existing callers.
export const normalizeGameType = defaultGameRegistry.normalizeGameType;
export const gameInfo = defaultGameRegistry.gameInfo;
export const gameAdapter = defaultGameRegistry.gameAdapter;
