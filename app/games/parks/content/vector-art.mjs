import { deepFreeze } from './immutable.mjs';

// Original code-drawn outlines. Rule text and quantities remain HTML text beside them.
const paths = deepFreeze({
  mountain: '<path d="M5 52 26 14l10 19 7-12 16 31Z"/><path d="m18 29 8 4 7-5M37 32l6 4 5-4"/>',
  forest: '<path d="m32 6-15 20h8L12 42h14v14h12V42h14L39 26h8Z"/>',
  sun: '<circle cx="32" cy="32" r="12"/><path d="M32 5v8m0 38v8M5 32h8m38 0h8M13 13l6 6m26 26 6 6M13 51l6-6m26-26 6-6"/>',
  water: '<path d="M32 5C24 18 13 29 13 39a19 19 0 0 0 38 0C51 29 40 18 32 5Z"/><path d="M21 40c0 7 4 11 11 11"/>',
  wildlife: '<path d="M19 40c5-4 6-12 13-12s8 8 13 12c9 10-4 17-13 12-9 5-22-2-13-12Z"/><ellipse cx="12" cy="29" rx="5" ry="7"/><ellipse cx="24" cy="16" rx="5" ry="7"/><ellipse cx="41" cy="16" rx="5" ry="7"/><ellipse cx="53" cy="29" rx="5" ry="7"/>',
  canteen: '<path d="M25 5h14v10H25ZM23 15h18l7 9v29H16V24Z"/><path d="M17 35h30m-21 9h12M48 25h6v16h-6"/>',
  camera: '<path d="M7 21h12l5-8h17l5 8h11v33H7Z"/><circle cx="32" cy="37" r="11"/><path d="M48 27h3"/>',
  'camera-site': '<path d="M32 60s22-23 22-38a22 22 0 0 0-44 0c0 15 22 38 22 38Z"/><path d="M18 17h7l3-4h8l3 4h7v18H18Z"/><circle cx="32" cy="26" r="6"/>',
  'camera-badge': '<path d="m32 4 8 6 10 1 2 11 7 10-7 9-2 12-10 1-8 6-8-6-10-1-2-12-7-9 7-10 2-11 10-1Z"/><path d="M18 24h8l3-5h7l3 5h7v19H18Z"/><circle cx="32" cy="33" r="6"/>',
  'first-player': '<path d="M13 58V7m0 2h39l-9 11 9 11H13"/><path d="M29 14v12m-4-8 4-4"/>',
  photo: '<path d="M9 7h46v51H9Z"/><path d="M15 14h34v30H15Zm0 30 11-15 8 10 7-8 8 13M25 51h14"/><circle cx="40" cy="22" r="4"/>',
  album: '<path d="M11 10h39v47H11Zm0 0 8-5h36v47h-5M11 48h39"/><path d="m18 39 10-16 9 10 6-7 7 13M25 52h12"/>',
  'photo-ranking': '<path d="M5 38h18v19H5Zm18-13h18v32H23Zm18 21h18v11H41ZM27 8h10l-2 8h-6Z"/>',
  campfire: '<path d="m16 57 34-8M14 49l36 8M33 4c3 13 14 16 10 29 6-2 6-7 6-7 13 23-5 26-17 21C15 48 10 38 17 27c1 9 6 9 6 9C18 22 32 19 33 4Z"/>',
  'campfire-off': '<path d="m13 51 38-12M13 39l38 12M25 29c-6-5 6-9 0-15m13 15c-6-5 6-9 0-15M7 7l50 50"/>',
  tent: '<path d="M4 53 28 10l30 43Zm12 0 14-28 15 28M28 10l5-7M12 53l-4 6m44-6 4 6"/>',
  hiker: '<circle cx="34" cy="10" r="6"/><path d="m32 19-6 19 10 7 3 14m-13-21-8 20m10-28 15 4 7-9M51 23v36M24 19l-7 2-4 18 9 2"/>',
  gear: '<path d="M15 12h34v44H15Zm8-6h18v6H23ZM15 28h34M23 35h18v13H23Zm-8-15H8v23h7m34-23h7v23h-7"/>',
  backpack: '<path d="M13 18q0-9 9-9h20q9 0 9 9v39H13Zm13-9V4h12v5M20 35h24v16H20ZM13 26h38m-22-7h6M7 25h6v21H7Zm44 0h6v21h-6Z"/>',
  passion: '<path d="M32 56S6 39 6 23C6 9 23 6 32 18 41 6 58 9 58 23c0 16-26 33-26 33Z"/><path d="m23 35 7-7 6 6 8-10"/>',
  season: '<path d="M50 7C22 5 8 21 17 42c15 18 37 3 33-35ZM12 56l30-37M22 42l1-17m8 10 15-1"/>',
  die: '<rect x="10" y="10" width="44" height="44" rx="8"/><circle cx="22" cy="22" r="2"/><circle cx="42" cy="22" r="2"/><circle cx="32" cy="32" r="2"/><circle cx="22" cy="42" r="2"/><circle cx="42" cy="42" r="2"/>',
  trail: '<path d="M10 57c1-17 44-11 44-26S17 26 18 8M11 13l7-6 6 7"/><circle cx="23" cy="47" r="4"/><circle cx="43" cy="33" r="4"/><circle cx="29" cy="20" r="4"/>',
  volunteer: '<path d="M12 18h40v40H12ZM23 10h18v13H23ZM24 9V5h16v4M20 33l5 5 9-10M20 47l5 5 9-10m4-7h7m-7 14h7"/>',
  teddy: '<circle cx="16" cy="16" r="8"/><circle cx="48" cy="16" r="8"/><path d="M12 33c0-24 40-24 40 0v11c0 17-40 17-40 0Z"/><circle cx="23" cy="31" r="2"/><circle cx="41" cy="31" r="2"/><ellipse cx="32" cy="43" rx="10" ry="8"/><path d="M28 40h8l-4 5Zm4 5v5"/>',
  'teddy-front': '<path d="M10 44h18V22H10Zm26 0h18V22H36ZM11 13h41m-7-6 7 6-7 6M38 50h14m-7-6 7 6-7 6"/>',
  'teddy-back': '<path d="M10 44h18V22H10Zm26 0h18V22H36ZM11 13h41m-7-6 7 6-7 6M12 50h14m-7-6-7 6 7 6"/>',
  'solo-reference': '<path d="M12 6h40v52H12ZM21 17h22M21 26h22M21 35h22M21 44h14"/>',
  exchange: '<path d="M9 23h42l-9-9m13 27H13l9 9M51 23l-9 9M13 41l9-9"/>',
  circle: '<circle cx="32" cy="32" r="22"/>',
  triangle: '<path d="M32 7 58 55H6Z"/>',
  square: '<rect x="10" y="10" width="44" height="44" rx="3"/>',
  diamond: '<path d="m32 4 28 28-28 28L4 32Z"/>',
  pentagon: '<path d="m32 5 27 20-10 32H15L5 25Z"/>',
});

export const SYMBOL_IDS = deepFreeze(Object.keys(paths));

function escapeXml(text) {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

export function getSymbolSvg(symbolId, { title = '', size = 64 } = {}) {
  if (typeof symbolId !== 'string' || !Object.hasOwn(paths, symbolId)) throw new RangeError('未知的 PARKS 图形');
  if (typeof title !== 'string' || !Number.isInteger(size) || size < 8 || size > 512) throw new RangeError('无效的 PARKS 图形属性');
  const accessibility = title ? `role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title>` : 'aria-hidden="true">';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" ${accessibility}${paths[symbolId]}</svg>`;
}
