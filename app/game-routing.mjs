const GAMES = Object.freeze({
  rummikub: Object.freeze({ name: '拉密', page: 'room.html', minPlayers: 2, maxPlayers: 7 }),
  'army-flip': Object.freeze({ name: '翻棋军棋', page: 'army.html', minPlayers: 2, maxPlayers: 2 }),
});

// Presentation only. The server chooses and persists the room's game type.
export function gameDetails(gameType = 'rummikub') {
  if (typeof gameType !== 'string' || !Object.hasOwn(GAMES, gameType)) throw new TypeError('无法识别这个房间的游戏。');
  return GAMES[gameType];
}
export function gameName(gameType = 'rummikub') { return gameDetails(gameType).name; }
export function roomHref(code, gameType = 'rummikub') {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new TypeError('房间号需要六位数字。');
  return `./${gameDetails(gameType).page}?code=${code}`;
}
