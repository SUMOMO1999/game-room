/** Stable card identities. Face artwork and rule strength never determine ownership. */
export const CARD_VERSION = 'p414-2-cards-v1';
export const SUITS = Object.freeze(['spades', 'hearts', 'clubs', 'diamonds']);

const suitLabels = Object.freeze({ spades: '黑桃', hearts: '红桃', clubs: '梅花', diamonds: '方块' });
const rankLabels = Object.freeze({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' });

/** Numeric ranks are already in rule order: 3..K, A, 2, small joker, large joker. */
export function rankLabel(rank) {
  if (!Number.isInteger(rank) || rank < 3 || rank > 17) throw new RangeError('未知的414牌点数');
  return rankLabels[rank] ?? String(rank);
}

const canonicalDeck = [];
for (let copyId = 0; copyId < 2; copyId += 1) {
  for (const suit of [...SUITS, 'joker']) {
    const ranks = suit === 'joker' ? [16, 17] : Array.from({ length: 13 }, (_, index) => index + 3);
    for (const rank of ranks) {
      const faceId = `p414-2-${suit}-${rank}`;
      canonicalDeck.push(Object.freeze({ id: `${faceId}-${copyId}`, faceId, copyId, suit, rank }));
    }
  }
}
Object.freeze(canonicalDeck);
const cardsById = new Map(canonicalDeck.map(card => [card.id, card]));

/** New entities on every call: shuffling a deck cannot mutate the canonical definitions. */
export function makeDeck() {
  return canonicalDeck.map(card => ({ ...card }));
}

/** Return an immutable canonical entity; do not parse or silently coerce unknown IDs. */
export function getCard(id) {
  if (typeof id !== 'string' || !cardsById.has(id)) throw new RangeError('未知的414牌实体');
  return cardsById.get(id);
}

/** Face label, without a copy suffix. Callers can add a local duplicate-card position. */
export function cardLabel(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new TypeError('414牌必须是实体对象');
  const canonical = getCard(card.id);
  if (['faceId', 'copyId', 'suit', 'rank'].some(key => card[key] !== canonical[key])) {
    throw new TypeError('414牌定义与实体编号不一致');
  }
  return card.suit === 'joker' ? rankLabel(card.rank) : `${suitLabels[card.suit]}${rankLabel(card.rank)}`;
}
