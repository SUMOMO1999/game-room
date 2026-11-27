// Parsed game input stays data at every level, including native card encodings.
const allowedCommands = new Set(['init', 'inited', 'reinited', 'startGame', 'result', 'tempResult',
  'changeRoomConfig', 'changeNumConfig', 'chat', 'emotion', 'throwEmotion', 'giveup', 'auto',
  'unauto', 'cardPile', 'dataSync', 'syncHandcard']);
const reservedKeys = new Set(['__proto__', 'prototype', 'constructor']);

export function gameData(value, depth = 0) {
  if (depth > 24) return false;
  if (typeof value === 'string') {
    if (!value.startsWith('_noname_')) return true;
    if (value === '_noname_infinity' || /^_noname_player:\d+$/.test(value)) return true;
    const tag = /^_noname_(?:vcard|card):/.exec(value);
    if (!tag) return false;
    try { return gameData(JSON.parse(value.slice(tag[0].length)), depth + 1); } catch { return false; }
  }
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => !reservedKeys.has(key) && gameData(child, depth + 1));
}

export function acceptsFrame(frame) {
  if (!Array.isArray(frame) || !allowedCommands.has(frame[0]) || !gameData(frame)) return false;
  if (frame[0] === 'init') return typeof frame[2]?.nickname === 'string';
  return true;
}

