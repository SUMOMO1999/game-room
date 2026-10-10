import { PARKS, GEAR, PASSIONS, CANTEENS, CANTEEN_TOKENS, CAMPING_TILES, TEDDY_CARDS, SEASONS, RESOURCES, TRAIL_SITES } from '../content/catalog.mjs';
export const RULE_VERSION = 'parks-2e-full-v1';
export const STATE_VERSION = 1;
export const TURN_MS = 30 * 60 * 1000;
export const RESOURCE_KEYS = Object.freeze(['mountain', 'forest', 'sun', 'water', 'wildlife']);
export const RESOURCE_STOCK = Object.freeze(Object.fromEntries(RESOURCES.map(resource => [resource.id, resource.stock])));
export const zeroResources = () => Object.fromEntries(RESOURCE_KEYS.map(key => [key, 0]));
export const countResources = value => RESOURCE_KEYS.reduce((sum, key) => sum + value[key], 0);
export const integer = value => Number.isSafeInteger(value) && value >= 0;
export const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function validResources(value) {
  return plain(value) && Object.keys(value).length === RESOURCE_KEYS.length
    && RESOURCE_KEYS.every(key => integer(value[key]) && value[key] <= RESOURCE_STOCK[key]);
}
export class RuleError extends Error {
  constructor(message, code = 'ILLEGAL_ACTION') { super(message); this.name = 'RuleError'; this.code = code; }
}
export function requireRule(value, message, code) { if (!value) throw new RuleError(message, code); }
export const parkById = new Map(PARKS.map(value => [value.id, value]));
export const gearById = new Map(GEAR.map(value => [value.id, value]));
export const passionById = new Map(PASSIONS.map(value => [value.id, value]));
export const canteenById = new Map(CANTEEN_TOKENS.map(value => [value.id, value]));
export const canteenDefinitionById = new Map(CANTEENS.map(value => [value.id, value]));
export const campById = new Map(CAMPING_TILES.map(value => [value.id, value]));
export const teddyById = new Map(TEDDY_CARDS.map(value => [value.id, value]));
export const seasonById = new Map(SEASONS.map(value => [value.id, value]));
export const siteIds = TRAIL_SITES.filter(site => !site.fixed).map(site => site.id);
export function player(state, id) {
  const owner = state.players.find(value => value.id === id);
  requireRule(owner, '你不是本局参赛者。', 'SEAT_REQUIRED'); return owner;
}
export const projectActive = (state, id) => state.projects.includes(`volunteer.${id}`);
export const backpackCapacity = (state, owner) => projectActive(state, 'responsible-consumption') ? Math.max(0, 12 - owner.gearPurchases) : 12;
export const ownsBadge = (state, id) => state.shutterbugOwnerId === id;
export const photoAllowed = (state, id) => !projectActive(state, 'environmental-studies') || ownsBadge(state, id);
export const ability = (owner, kind) => owner.passionBranch === 'ability' && passionById.get(owner.passionId)?.ability.kind === kind;
export function shuffle(items, randomInt) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1); requireRule(integer(j) && j <= i, '随机服务返回无效结果。', 'INVALID_RANDOM');
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function randomFor(state, context) {
  return maximum => { requireRule(typeof context.serverRandomInt === 'function', '随机服务不可用。', 'INVALID_RANDOM');
    const result = context.serverRandomInt(maximum); requireRule(integer(result) && result < maximum, '随机结果超出范围。', 'INVALID_RANDOM');
    state.randomCursor += 1; return result; };
}
export function emit(state, type, data = {}) {
  const event = { id: `${state.matchId}:event:${++state.publicEventSequence}`, type, ...data };
  state.lastPublicEvents.push(event); return event;
}
export function openWindow(state, kind, responsibleSeatId, now) {
  state.windowSequence += 1; state.opportunities = [];
  state.decisionWindow = { id: `${state.matchId}:window:${state.windowSequence}`, kind, responsibleSeatId,
    deadlineAt: responsibleSeatId ? now + TURN_MS : null, remainingMs: responsibleSeatId ? TURN_MS : 0,
    paused: false, pauseCause: null, status: 'open' };
  state.windowUsage = { gear: [], passion: [], badge: false, sunChecked: false };
}
export function createOpportunity(state, ownerId, sourceId, program, { mandatory = false, parentId = null, kind = 'effect', data = {}, started = false } = {}) {
  const value = { id: `${state.matchId}:op:${++state.opportunitySequence}`, sourceId, parentId, ownerSeatId: ownerId,
    windowId: state.decisionWindow.id, kind, mandatory, status: 'open', program: structuredClone(program), index: 0, data: structuredClone(data), started };
  state.opportunities.push(value); return value;
}
export const openOpportunities = state => state.opportunities.filter(value => value.status === 'open');
export const childrenOf = (state, value) => openOpportunities(state).filter(child => child.parentId === value && child.mandatory);
export function opportunity(state, id, actorId) {
  const value = state.opportunities.find(item => item.id === id && item.status === 'open');
  requireRule(value && value.windowId === state.decisionWindow.id, '这个选择已结束或已过期。', 'OLD_OPPORTUNITY');
  requireRule(value.ownerSeatId === actorId, '只有当前责任人可以选择。', 'WRONG_ACTOR'); return value;
}
export function fillMarket(state, kind, { compact = false } = {}) {
  const market = state.markets[kind], deck = state.decks[kind];
  if (compact) { const existing = market.filter(Boolean); market.splice(0, 3, ...Array(3 - existing.length).fill(null), ...existing); }
  for (let index = 2; index >= 0; index -= 1) if (market[index] === null && deck.length) market[index] = deck.shift();
}
export function takeFromMarket(state, kind, targetId, { replenish = false } = {}) {
  let value;
  if (targetId === 'deck-top') { requireRule(state.decks[kind].length, '牌堆已空。', 'EMPTY_DECK'); value = state.decks[kind].shift(); }
  else { const index = state.markets[kind].indexOf(targetId); requireRule(index >= 0, '展示对象已不在原位置。', 'TARGET_MISSING'); value = state.markets[kind][index]; state.markets[kind][index] = null; }
  if (replenish) fillMarket(state, kind, { compact: true }); return value;
}
export function configurationProblem(configuration, count) {
  if (!plain(configuration) || Object.keys(configuration).some(key => !['mode', 'camping', 'volunteerCount', 'passionChoice'].includes(key))
    || !['standard', 'teddy', 'solo'].includes(configuration.mode) || typeof configuration.camping !== 'boolean'
    || !integer(configuration.volunteerCount) || configuration.volunteerCount > 4 || !['random', 'choose'].includes(configuration.passionChoice)) return '公园玩法设置无效。';
  if (count !== undefined && (configuration.mode === 'solo' ? count !== 1 : configuration.mode === 'teddy' ? count !== 2 : count < 2 || count > 5)) return '人数与公园玩法不一致。';
  return null;
}
export const DEFAULT_CONFIGURATION = Object.freeze({ mode: 'standard', camping: false, volunteerCount: 0, passionChoice: 'random' });

export function normalizeConfiguration(input = {}) {
  requireRule(plain(input), '公园设置必须是配置对象。');
  const value = { ...DEFAULT_CONFIGURATION, ...input };
  requireRule(!configurationProblem(value), configurationProblem(value)); return value;
}

export function canonical(value) { return JSON.stringify(normalized(value)); }
function normalized(value) { return Array.isArray(value) ? value.map(normalized) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])])) : value; }
