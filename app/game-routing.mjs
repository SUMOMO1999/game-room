import { gamePresentation } from './games/catalog.mjs';

// Presentation only. The server chooses and persists the room's game type.
export function gameDetails(gameType = 'rummikub') {
  return gamePresentation(gameType).route;
}
export function gameName(gameType = 'rummikub') { return gameDetails(gameType).name; }
export function roomHref(code, gameType = 'rummikub') {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new TypeError('房间号需要六位数字。');
  return `./${gameDetails(gameType).page}?code=${code}`;
}
