export { parksCommand } from './game-ui-model.mjs';
export const PARKS_BUSINESS_TYPES = Object.freeze(['move-hiker', 'use-opportunity',
  'resolve-opportunity', 'allocate-water', 'choose-passion', 'choose-starting-passion',
  'choose-teddy', 'finish-opportunity', 'discard-resources', 'finish-window']);

/** One public cue per accepted transition; replayed baselines remain silent. */
export function parksCues(previous, next, selfId, role) {
  if (!previous || !next || previous.matchId !== next.matchId
    || previous.revision === next.revision) return [];
  if (!previous.result && next.result) return [role === 'player' && next.result.winnerIds?.includes(selfId) ? 'win' : 'draw-result'];
  if (previous.season?.index !== next.season?.index) return ['start'];
  const old = new Set((previous.lastPublicEvents || []).map(event => event.id));
  const events = (next.lastPublicEvents || []).filter(event => !old.has(event.id));
  if (events.some(event => event.type === 'die-rolled')) return ['roll'];
  if (events.some(event => event.type === 'teddy-card-revealed')) return ['draw'];
  if (events.some(event => event.type === 'photos-taken')) return ['commit'];
  if (events.some(event => ['park-visited','park-reserved'].includes(event.type))) return ['draw'];
  if (events.some(event => event.type === 'canteen-filled')) return ['merge'];
  if (previous.window?.responsibleSeatId !== selfId && next.window?.responsibleSeatId === selfId && role === 'player') return ['turn'];
  if (next.players?.some(player => player.hikers?.some(hiker =>
    previous.players?.find(old => old.id === player.id)?.hikers?.find(old => old.id === hiker.id)?.position !== hiker.position))) return ['move'];
  return ['placement'];
}
