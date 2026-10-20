/** Public, deterministic material recommendations. No shuffle or hidden state. */
export const PLAYER_COUNT_CONTENT_VERSION = 'yousei-content-v2';
const baseCopies = Object.freeze(Object.fromEntries([
  ...Array.from({ length: 18 }, (_, i) => [`G${String(i + 1).padStart(2, '0')}`, 2]), ['G19', 4],
  ...[1, 2, 2, 3, 2, 2, 6, 2, 2, 2, 1, 2, 2].map((count, i) => [`C${String(i + 1).padStart(2, '0')}`, count]),
  ...[2, 1, 1, 1, 1, 1, 2, 5].map((count, i) => [`M${String(i + 1).padStart(2, '0')}`, count]),
  ...[2, 2, 2, 2, 3, 2, 2, 2, 2, 3].map((count, i) => [`T${String(i + 1).padStart(2, '0')}`, count]), ['P01', 5],
]));
const extraOrdinary = new Set(['C01', 'C02', 'C04', 'C06', 'C10', 'C13']);
const extraTools = new Set(['T01', 'T03', 'T05', 'T06']);
const profiles = new Map();
function validCount(count) {
  if (!Number.isSafeInteger(count) || count < 2 || count > 6) throw new RangeError('商人参赛人数须为2～6人。');
  return count;
}
export const recommendedGoodsPerType = count => 3 * validCount(count);
export function playerCountProfile(count) {
  validCount(count);
  if (profiles.has(count)) return profiles.get(count);
  const extra = count - 2;
  const copiesByCode = Object.freeze(Object.fromEntries(Object.entries(baseCopies).map(([code, base]) => [code,
    base + extra * (code === 'G19' || code === 'C07' || code === 'P01' ? 2
      : code.startsWith('G') || extraOrdinary.has(code) || extraTools.has(code) ? 1 : 0)])));
  const profile = Object.freeze({ contentVersion: PLAYER_COUNT_CONTENT_VERSION, playerCount: count, deckSize: 110 + extra * 34,
    goodsPerTypeRecommended: recommendedGoodsPerType(count), stallBoards: 5 + extra * 2, copiesByCode });
  profiles.set(count, profile); return profile;
}
export const profileForPlayerCount = playerCountProfile;
