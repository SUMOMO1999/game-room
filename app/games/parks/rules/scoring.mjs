import { parkById, gearById, passionById } from './model.mjs';
import { SEASON_BEHAVIORS } from '../content/behavior-data.mjs';

export function passionMetric(owner, metric) {
  const parks = owner.visited.map(id => parkById.get(id));
  switch (metric.metric) {
    case 'visitedInstantParks': return parks.filter(park => park.hasInstantAction).length;
    case 'visitedParksWithPrintedResource': return parks.filter(park => park.cost[metric.resource] > 0).length;
    case 'visitedPrintedResourceTotal': return parks.reduce((sum, park) => sum + park.cost[metric.resource], 0);
    case 'gearPurchases': return owner.gearPurchases;
    case 'paidPhotoWithWildlife': return owner.paidPhotoWithWildlife;
    case 'currentPhotos': return owner.photos;
    default: throw new Error('未知热忱统计。');
  }
}
export function seasonMetric(owner, seasonId) {
  const metric = SEASON_BEHAVIORS[seasonId].metric;
  switch (metric.kind) {
    case 'backpack': return owner.resources[metric.resource];
    case 'gear-sun-total': return owner.gear.reduce((sum, id) => sum + gearById.get(id).sunCost, 0);
    case 'canteen-count': return owner.canteenRows.reduce((sum, row) => sum + row.tokens.length, 0);
    case 'instant-park-count': return owner.visited.filter(id => parkById.get(id).hasInstantAction).length;
    case 'printed-park-total': return owner.visited.reduce((sum, id) => sum + parkById.get(id).cost[metric.resource], 0);
    default: throw new Error('未知季节统计。');
  }
}
export function seasonWinners(state) {
  const id = state.seasons[state.seasonIndex];
  const values = state.players.map(owner => ({ id: owner.id, value: seasonMetric(owner, id) }));
  const minimum = state.configuration.mode === 'solo' ? [3, 4, 5][state.seasonIndex] : 1;
  const highest = Math.max(...values.map(item => item.value));
  const qualified = values.filter(item => item.value >= minimum && (state.configuration.mode === 'solo' || item.value === highest)).map(item => item.id);
  const first = state.controllers.findIndex(item => item.id === state.firstPlayerId);
  return Array.from({ length: state.controllers.length }, (_, offset) => state.controllers[(first + offset) % state.controllers.length].id).filter(id => qualified.includes(id));
}
export function finalResult(state, now) {
  const solo = state.configuration.mode === 'solo';
  const scores = state.players.map(owner => {
    const passion = passionById.get(owner.passionId);
    const rank = owner.photos > 0 ? 1 + state.players.filter(other => other.photos > owner.photos).length : null;
    const photoRanking = solo || rank === null ? 0 : state.players.length === 2 ? rank === 1 ? 3 : 0 : rank === 1 ? 4 : rank === 2 ? 2 : 0;
    const breakdown = { parks: owner.visited.reduce((sum, id) => sum + parkById.get(id).points, 0), photos: owner.photos,
      photoRanking, passion: owner.passionBranch === 'scoring' ? Math.floor(passionMetric(owner, passion.score) / passion.score.divisor) : 0,
      fallBonus: owner.bonusPoints, firstPlayer: state.firstPlayerId === owner.id ? 1 : 0 };
    const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
    const threshold = [50, 45, 40, 35, 30].find(value => score >= value) ?? null;
    const soloRank = solo ? ({ 30: 'Dayhiker', 35: 'Trekker', 40: 'Explorer', 45: 'Adventurer', 50: 'Trailblazer' }[threshold] ?? null) : null;
    return { playerId: owner.id, score, parkCount: owner.visited.length, breakdown, photoRank: rank, ...(solo ? { soloRank, rankThreshold: threshold, difficulty: state.projects.length } : {}) };
  });
  const maximum = Math.max(...scores.map(item => item.score));
  const highest = scores.filter(item => item.score === maximum);
  const parkCount = Math.max(...highest.map(item => item.parkCount));
  const winnerIds = solo ? [] : highest.filter(item => item.parkCount === parkCount).map(item => item.playerId);
  return { reason: 'three-seasons-complete', settledAt: now, mode: state.configuration.mode, scores, winnerIds,
    tie: winnerIds.length > 1, aborted: false, configuration: structuredClone(state.configuration), projectIds: [...state.projects] };
}
