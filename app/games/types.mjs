// Persisted type identifiers are independent of which finished game pages are
// currently advertised in the lobby. Missing historical types mean Rummikub;
// an explicit unknown value must never be silently converted to another game.
export const GAME_TYPES = Object.freeze(['rummikub', 'army-flip', 'flying-chess']);
export function storedGameType(value = 'rummikub') {
  if (typeof value !== 'string' || !GAME_TYPES.includes(value)) throw new TypeError('无法识别这个房间的游戏。');
  return value;
}
