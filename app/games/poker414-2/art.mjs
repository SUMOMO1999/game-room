import { cardLabel, getCard, rankLabel } from './cards.mjs';

export const ART_VERSION = 'p414-2-art-vector-v1';

const INK = '#243841';
const RED = '#bd2636';
const SUIT_NAMES = Object.freeze({ spades: '黑桃', hearts: '红桃', clubs: '梅花', diamonds: '方块' });

// Original compact paths, not a font or an external icon collection. Every suit
// also has a normal HTML label, so missing SVG rendering cannot hide its identity.
const SUIT_PATHS = Object.freeze({
  spades: 'M16 2C13 7 3 12 3 20C3 26 10 29 14 24L12 33H20L18 24C22 29 29 26 29 20C29 12 19 7 16 2Z',
  hearts: 'M16 32C13 28 3 21 3 12C3 3 13 2 16 10C19 2 29 3 29 12C29 21 19 28 16 32Z',
  clubs: 'M16 2C7 2 7 13 12 15C2 11 0 24 8 27C11 28 13 26 14 24L12 33H20L18 24C19 26 21 28 24 27C32 24 30 11 20 15C25 13 25 2 16 2Z',
  diamonds: 'M16 2L29 18L16 34L3 18Z',
});

function suitSvg(suit, className) {
  const fill = suit === 'hearts' || suit === 'diamonds' ? RED : INK;
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 36" width="32" height="36" aria-hidden="true" focusable="false"><path d="${SUIT_PATHS[suit]}" fill="${fill}"/></svg>`;
}

function jokerSvg(large) {
  // Small: two-point blue bell cap and diamond. Large: red five-point crown
  // and a sun medallion. Distinct silhouettes remain readable without color.
  const shape = large
    ? `<path d="M10 34L6 14L19 23L23 6L32 20L41 6L45 23L58 14L54 34Z" fill="#b42635" stroke="#7e2230" stroke-width="2" stroke-linejoin="round"/>
       <path d="M13 35H51V42H13Z" fill="#d3a63c" stroke="#86641e" stroke-width="2"/>
       <path d="M32 18L37 26L32 33L27 26Z" fill="#fff5d9"/>
       <path d="M32 46L36 50L42 49L42 55L46 59L42 63L42 69L36 68L32 72L28 68L22 69L22 63L18 59L22 55L22 49L28 50Z" fill="#d3a63c"/>
       <circle cx="32" cy="59" r="7" fill="#fff5d9" stroke="#b42635" stroke-width="2"/>`
    : `<path d="M11 38C10 29 8 21 5 15C18 14 26 20 32 27C38 20 46 14 59 15C56 21 54 29 53 38Z" fill="#305f93" stroke="#243f5e" stroke-width="2" stroke-linejoin="round"/>
       <circle cx="6" cy="13" r="4" fill="#d1a545" stroke="#806224" stroke-width="1.5"/>
       <circle cx="58" cy="13" r="4" fill="#d1a545" stroke="#806224" stroke-width="1.5"/>
       <path d="M12 38H52V44H12Z" fill="#f4eee1" stroke="#243f5e" stroke-width="2"/>
       <path d="M32 48L43 60L32 72L21 60Z" fill="#305f93" stroke="#243f5e" stroke-width="2"/>
       <path d="M32 54L37 60L32 66L27 60Z" fill="#f4eee1"/>`;
  return `<svg class="p414-card__center p414-card__joker-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 78" width="64" height="78" aria-hidden="true" focusable="false">${shape}</svg>`;
}

/** One semantic control per entity; event delegation belongs to the page. */
export function renderCard(card, { selected = false, disabled = false, interactive = true, compact = false } = {}) {
  const label = cardLabel(card);
  for (const value of [selected, disabled, interactive, compact]) {
    if (typeof value !== 'boolean') throw new TypeError('414牌显示状态必须为布尔值');
  }
  const entity = getCard(card.id);
  const joker = entity.suit === 'joker', large = entity.rank === 17;
  const red = entity.suit === 'hearts' || entity.suit === 'diamonds' || large;
  const classes = ['p414-card', red ? 'p414-card--red' : 'p414-card--black'];
  if (joker) classes.push('p414-card--joker', large ? 'p414-card--large-joker' : 'p414-card--small-joker');
  if (selected) classes.push('is-selected');
  if (disabled) classes.push('is-disabled');
  if (compact) classes.push('p414-card--compact');
  const accessibleLabel = `${label}，第${entity.copyId + 1}张${selected ? '，已选中' : ''}`;
  const attributes = `class="${classes.join(' ')}" data-card-id="${entity.id}" data-face-id="${entity.faceId}" data-copy-id="${entity.copyId}" data-suit="${entity.suit}" data-rank="${entity.rank}" data-art-version="${ART_VERSION}" aria-label="${accessibleLabel}"`;
  const tag = interactive ? 'button' : 'span';
  const semantics = interactive ? ` type="button" aria-pressed="${selected}"${disabled ? ' disabled' : ''}` : ` role="img"${disabled ? ' aria-disabled="true"' : ''}`;
  const corner = joker ? (large ? '大' : '小') : rankLabel(entity.rank);
  const picture = joker ? jokerSvg(large) : suitSvg(entity.suit, 'p414-card__center');
  const caption = joker ? label : SUIT_NAMES[entity.suit];
  return `<${tag} ${attributes}${semantics}><span class="p414-card__corner" aria-hidden="true"><span class="p414-card__rank">${corner}</span>${joker ? '' : suitSvg(entity.suit, 'p414-card__suit')}</span>${picture}<span class="p414-card__caption" aria-hidden="true">${caption}</span></${tag}>`;
}

/** Identical backs carry no face, entity, copy or ownership data. */
export function renderCardBack() {
  return `<span class="p414-card p414-card--back" data-art-version="${ART_VERSION}" role="img" aria-label="未公开的牌，统一牌背"><svg class="p414-card__back-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 96" width="72" height="96" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="70" height="94" rx="7" fill="#263f4c" stroke="#d5c696" stroke-width="2"/>
    <rect x="6" y="6" width="60" height="84" rx="4" fill="none" stroke="#b8c8c8" stroke-width="1"/>
    <path d="M8 24L36 8L64 24L8 56L64 88M8 40L64 8M8 72L64 40M8 88L64 56M8 8L64 40M8 40L64 72M8 56L64 88M8 24L64 56" fill="none" stroke="#68818b" stroke-width="1"/>
    <path d="M36 23L56 48L36 73L16 48Z" fill="#263f4c" stroke="#d5c696" stroke-width="2"/>
    <path d="M36 33L48 48L36 63L24 48Z" fill="none" stroke="#d5c696" stroke-width="1"/>
    <circle cx="36" cy="48" r="4" fill="#d5c696"/>
  </svg><span class="p414-card__caption" aria-hidden="true">牌背</span></span>`;
}

function rocketBadgeSvg(level) {
  const suits = level === 1 ? ['spades', 'diamonds', 'hearts']
    : level === 2 ? ['clubs', 'clubs', 'clubs'] : ['hearts', 'hearts', 'hearts'];
  const cards = suits.map((suit, index) => {
    const ink = suit === 'hearts' || suit === 'diamonds' ? RED : INK;
    return `<g transform="translate(${3 + index * 33} 4)" data-badge-suit="${suit}"><rect width="30" height="44" rx="4" fill="#fffdf6" stroke="${ink}" stroke-width="1.5"/>
      <text x="15" y="19" text-anchor="middle" font-family="system-ui,sans-serif" font-size="16" font-weight="700" fill="${ink}">${index === 2 ? 'A' : '4'}</text>
      <path transform="translate(9 24) scale(.375)" d="${SUIT_PATHS[suit]}" fill="${ink}"/></g>`;
  }).join('');
  return `<svg class="p414-pattern-badge__art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 102 52" width="102" height="52" aria-hidden="true" focusable="false">${cards}</svg>`;
}

function bombBadgeSvg(count) {
  const cards = Array.from({ length: count }, (_, index) => `<rect data-bomb-card="${index + 1}" x="${5 + index * 10}" y="5" width="22" height="33" rx="3" fill="#fffdf6" stroke="${INK}" stroke-width="1.5"/>`).join('');
  const marks = Array.from({ length: count }, (_, index) => `<circle cx="${9 + index * 11}" cy="46" r="2.5" fill="${INK}"/>`).join('');
  return `<svg class="p414-pattern-badge__art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 102 52" width="102" height="52" aria-hidden="true" focusable="false">${cards}${marks}</svg>`;
}

/** Resource-reading labels only; this does not classify cards or authorize play. */
export function renderPatternBadge(pattern) {
  if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(pattern))) throw new TypeError('414阅读标识需要明确牌型。');
  const rocket = pattern.kind === 'rocket', bomb = pattern.kind === 'bomb';
  const valueKey = rocket ? 'level' : 'count', value = pattern[valueKey];
  if ((!rocket && !bomb) || Reflect.ownKeys(pattern).length !== 2
      || !Object.hasOwn(pattern, 'kind') || !Object.hasOwn(pattern, valueKey)
      || !Number.isInteger(value) || (rocket ? value < 1 || value > 3 : value < 3 || value > 8)) {
    throw new RangeError('只支持三档火箭或3～8张普通炸弹标识。');
  }
  const label = rocket ? ['杂色火箭', '纯色火箭（非红桃）', '纯红桃火箭'][value - 1] : `${value}张炸弹`;
  const description = rocket ? `${label}，等级${value}，两张4加一张A` : `${label}，${value}张同点数普通牌`;
  return `<span class="p414-pattern-badge p414-pattern-badge--${pattern.kind}" data-pattern-kind="${pattern.kind}" data-pattern-${valueKey}="${value}" data-art-version="${ART_VERSION}" role="img" aria-label="${description}">${rocket ? rocketBadgeSvg(value) : bombBadgeSvg(value)}<span class="p414-pattern-badge__label" aria-hidden="true">${label}</span></span>`;
}
