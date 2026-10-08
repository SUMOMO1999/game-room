// Public, deterministic text contract. No content, account, DOM or Node dependencies.
export const DRAW_AND_GUESS_MATCHER_VERSION = 'zh-exact-v1';
const forbidden = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{M}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;
const edges = new Set(Array.from('，。！？、；：,.!?;:「」『』“”‘’"\'（）()'));
const encoder = new TextEncoder();
export function drawAndGuessCharacterLength(value) {
  if (typeof value !== 'string') throw new TypeError('文字必须是字符串。');
  return Array.from(value.normalize('NFC')).length;
}
export function checkDrawAndGuessText(value, { maxCharacters, maxBytes, allowEmpty = false }) {
  if (typeof value !== 'string') throw new TypeError('文字必须是字符串。');
  const nfc = value.normalize('NFC'), nfkc = value.normalize('NFKC');
  if (forbidden.test(nfc) || forbidden.test(nfkc) || /[<>]/u.test(nfkc)) {
    throw new TypeError('文字含控制、不可见、未合成组合标记、损坏、私用或 HTML 标记字符。');
  }
  if (Array.from(nfc).length > maxCharacters || encoder.encode(value).length > maxBytes) {
    throw new RangeError(`文字至多 ${maxCharacters} 个字符、${maxBytes} UTF-8 字节。`);
  }
  if (!allowEmpty && !value.trim()) throw new TypeError('文字不能为空。');
}
export function normalizeDrawAndGuessAnswer(value) {
  checkDrawAndGuessText(value, { maxCharacters: 32, maxBytes: 128 });
  const display = value.normalize('NFC').trim().replace(/\p{Zs}+/gu, ' ');
  if (!display) throw new TypeError('文字不能为空。');
  return display;
}
function matchText(value) {
  const characters = Array.from(value.normalize('NFKC').replace(/[A-Z]/g, c => c.toLowerCase()).replace(/\p{White_Space}/gu, ''));
  while (characters.length && edges.has(characters[0])) characters.shift();
  while (characters.length && edges.has(characters.at(-1))) characters.pop();
  return characters.join('');
}
export function normalizeDrawAndGuessGuess(value) {
  checkDrawAndGuessText(value, { maxCharacters: 64, maxBytes: 256, allowEmpty: true });
  return matchText(value);
}
// A chat message has a different bound. It is never treated as a guess.
export function normalizeDrawAndGuessChat(value) {
  if (typeof value !== 'string') throw new TypeError('文字必须是字符串。');
  if (encoder.encode(value).length > 2048 || Array.from(value.normalize('NFC')).length > 500) throw new RangeError('聊天内容过长。');
  const singleLine = value.replace(/\r?\n/gu, ' ');
  checkDrawAndGuessText(singleLine, { maxCharacters: 500, maxBytes: 2048, allowEmpty: true });
  return matchText(singleLine);
}
