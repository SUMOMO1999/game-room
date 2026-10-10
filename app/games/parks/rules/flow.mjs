import { CONTENT_VERSION, CONTENT_PROVENANCE, PARKS, GEAR, PASSIONS, CANTEEN_TOKENS, CAMPING_TILES, TEDDY_CARDS, SEASONS, VOLUNTEER_PROJECTS, TRAIL_DIE } from '../content/catalog.mjs';
import { SEASON_BEHAVIORS } from '../content/behavior-data.mjs';
import { STATE_VERSION, RULE_VERSION, RESOURCE_STOCK, zeroResources, requireRule, integer, configurationProblem, DEFAULT_CONFIGURATION,
  shuffle, randomFor, siteIds, openWindow, createOpportunity, fillMarket, projectActive, emit, player, teddyById, openOpportunities } from './model.mjs';
import { seasonWinners, finalResult } from './scoring.mjs';

export const controllerHikers = (state, controller) => controller.kind === 'human' ? player(state, controller.id).hikers : controller.hikers;
export const inTransit = (state, controller) => controllerHikers(state, controller).filter(hiker => hiker.position < 10);
export const activeControllers = state => state.controllers.filter(controller => inTransit(state, controller).length);
export const allHikers = state => state.controllers.flatMap(controller => controllerHikers(state, controller));

function setTrail(state, randomInt) {
  const order = shuffle(siteIds, randomInt); order.splice(4, 0, 'site.parks');
  state.trail = order.map((siteId, index) => {
    const position = index + 1, resource = position >= 2 ? position % 2 === 0 ? 'sun' : 'water' : null;
    const weather = resource && !(resource === 'sun' && projectActive(state, 'climate-action')) && state.bankResources[resource] > 0 ? resource : null;
    if (weather) state.bankResources[weather] -= 1;
    return { position, siteId, weather };
  });
  const face = TRAIL_DIE[randomInt(TRAIL_DIE.length)]; state.shutterbugSiteId = face.shutterbugSite;
  state.endRewards = { parks: false, photo: false, gear: false };
  if (state.configuration.camping) state.camping.tents = [5, 7, 9].map((position, index) => ({ id: `tent.${index + 1}`, position, slotId: null }));
}
export function beginController(state, index, now) {
  state.controllerIndex = index; state.turnPlayerId = state.controllers[index].id;
  state.turnIndex = state.players.findIndex(owner => owner.id === state.turnPlayerId);
  state.turnNumber += 1; state.currentSiteId = null; state.arrivalMode = null;
  const controller = state.controllers[index];
  if (controller.kind === 'human') { openWindow(state, 'turn', controller.id, now); state.stage = 'move'; }
  else { openWindow(state, 'system', null, now); state.stage = 'teddy-draw'; state.teddy.batch = { remainingGroups: [...new Set(inTransit(state, controller).map(hiker => hiker.groupId))], drawn: null, selectedGroup: null, first: true }; }
}
export function initialGame(playerInputs, options) {
  const ids = Array.isArray(playerInputs) ? playerInputs.map(value => typeof value === 'string' ? value : value?.id) : [];
  const configuration = { ...DEFAULT_CONFIGURATION, ...options.configuration };
  requireRule(!configurationProblem(configuration, ids.length) && new Set(ids).size === ids.length
    && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100 && !id.startsWith('system.')), '参赛者或模式无效。');
  requireRule(typeof options.matchId === 'string' && options.matchId.length > 0 && options.matchId.length <= 100
    && integer(options.now) && Number.isSafeInteger(options.now + 30 * 60 * 1000), '开局编号或时间无效。');
  const state = { version: STATE_VERSION, gameType: 'parks', ruleVersion: RULE_VERSION, contentVersion: CONTENT_VERSION,
    contentDigest: CONTENT_PROVENANCE.sources.map(value => value.sha256).join(':'), behaviorVersion: 'parks-behaviors-v1',
    matchId: options.matchId, configuration, status: 'playing', stage: 'initial-passion', seasonIndex: 0,
    revision: 0, randomCursor: 0, systemCursor: 0, windowSequence: 0, opportunitySequence: 0, publicEventSequence: 0,
    lastPublicEvents: [], committedAt: options.now, startedAt: options.now, players: [], controllers: [], turnNumber: 0,
    bankResources: { ...RESOURCE_STOCK }, decks: {}, markets: { parks: Array(3).fill(null), gear: Array(3).fill(null), canteens: Array(3).fill(null) },
    removed: { parks: [], gear: [], passions: [] }, projects: [], camping: { seasonBoards: [], unusedTiles: [], tents: [], discardedFaces: [] },
    teddy: { deck: [], discard: [], shuffleGeneration: 0, batch: null, lastDraw: null }, seasonRewardQueue: null,
    opportunities: [], decisionWindow: null, firstPlayerId: null, shutterbugOwnerId: null, result: null };
  const randomInt = randomFor(state, options);
  state.projects = shuffle(VOLUNTEER_PROJECTS.map(value => value.id), randomInt).slice(0, configuration.volunteerCount);
  const includedParks = PARKS.filter(value => !projectActive(state, 'reduce-emissions') || ![2, 3].includes(value.points));
  state.removed.parks = PARKS.filter(value => !includedParks.includes(value)).map(value => value.id);
  state.decks.parks = shuffle(includedParks.map(value => value.id), randomInt);
  state.decks.gear = shuffle(GEAR.map(value => value.id), randomInt);
  state.decks.canteens = shuffle(CANTEEN_TOKENS.map(value => value.id), randomInt);
  state.decks.passions = shuffle(PASSIONS.map(value => value.id), randomInt);
  for (const id of ids) {
    const initialCanteen = state.decks.canteens.shift();
    const candidates = state.decks.passions.splice(0, configuration.passionChoice === 'choose' ? 2 : 1);
    state.players.push({ id, hikers: [0, 1].map(index => ({ id: `${id}:hiker:${index + 1}`, position: 0, endSlot: null })), resources: zeroResources(),
      canteenRows: [{ tokens: [initialCanteen], filled: false }, { tokens: [], filled: false }, { tokens: [], filled: false }],
      campfire: ids.length >= 4 && !projectActive(state, 'leave-no-trace'), passionId: configuration.passionChoice === 'random' ? candidates[0] : null,
      passionCandidates: configuration.passionChoice === 'choose' ? candidates : [], passionBranch: null,
      gear: [], visited: [], reserved: [], photos: 0, gearPurchases: 0, paidPhotoWithWildlife: 0, bonusPoints: 0 });
    state.controllers.push({ id, kind: 'human' });
  }
  if (configuration.mode !== 'standard') {
    const groups = configuration.mode === 'solo' ? ['teddy.amber', 'teddy.blue'] : ['teddy.amber'];
    state.controllers.unshift({ id: 'system.teddy', kind: 'teddy', hikers: groups.flatMap(groupId => [1, 2].map(number => ({ id: `${groupId}:${number}`, groupId, position: 0, endSlot: null }))) });
    state.teddy.deck = shuffle(TEDDY_CARDS.map(card => card.id), randomInt);
    state.firstPlayerId = 'system.teddy';
  } else state.firstPlayerId = ids[randomInt(ids.length)];
  state.seasons = ['spring', 'summer', 'fall'].map(season => shuffle(SEASONS.filter(value => value.season === season).map(value => value.id), randomInt)[0]);
  if (configuration.camping) {
    const tiles = shuffle(CAMPING_TILES, randomInt);
    state.camping.seasonBoards = tiles.slice(0, 3).map(tile => ({ tileId: tile.id, faceId: tile.faceIds[randomInt(2)] }));
    state.camping.unusedTiles = tiles.slice(3).map(tile => tile.id);
  }
  setTrail(state, randomInt);
  for (const kind of ['parks', 'gear', 'canteens']) fillMarket(state, kind);
  if (configuration.passionChoice === 'choose') {
    openWindow(state, 'starting-passion', ids[0], options.now);
    createOpportunity(state, ids[0], 'initial-passion', [{ kind: 'starting-passion' }], { mandatory: true, kind: 'starting-passion', started: true });
  } else beginController(state, state.controllers.findIndex(value => value.id === state.firstPlayerId), options.now);
  emit(state, 'match-started', { seasonIndex: 0, mode: configuration.mode }); return state;
}
export function advanceController(state, now) {
  fillMarket(state, 'parks', { compact: true });
  if (!activeControllers(state).length) { state.stage = 'season-awards'; openWindow(state, 'system', null, now); return; }
  const index = Array.from({ length: state.controllers.length }, (_, offset) => (state.controllerIndex + offset + 1) % state.controllers.length)
    .find(value => inTransit(state, state.controllers[value]).length);
  beginController(state, index, now);
}
export function openNextPassion(state, now) {
  const next = state.players.find(owner => owner.passionId === null);
  if (next) { openWindow(state, 'starting-passion', next.id, now); createOpportunity(state, next.id, 'initial-passion', [{ kind: 'starting-passion' }], { mandatory: true, kind: 'starting-passion', started: true }); }
  else beginController(state, state.controllers.findIndex(value => value.id === state.firstPlayerId), now);
}
export function completeSeason(state, context) {
  if (state.seasonIndex === 2) {
    state.result = finalResult(state, context.now); state.status = 'finished'; state.stage = 'finished';
    state.decisionWindow.status = 'complete'; state.decisionWindow.deadlineAt = null;
    emit(state, 'match-ended', { mode: state.configuration.mode }); return;
  }
  for (const site of state.trail) if (site.weather) { state.bankResources[site.weather] += 1; site.weather = null; }
  for (const owner of state.players) {
    for (const row of owner.canteenRows) { if (row.filled) state.bankResources.water += 1; row.filled = false; }
    owner.campfire = !projectActive(state, 'leave-no-trace');
    for (const hiker of owner.hikers) { hiker.position = 0; hiker.endSlot = null; }
  }
  for (const controller of state.controllers.filter(value => value.kind === 'teddy')) for (const hiker of controller.hikers) { hiker.position = 0; hiker.endSlot = null; }
  if (state.configuration.camping) state.camping.discardedFaces.push(state.camping.seasonBoards[state.seasonIndex].faceId);
  state.seasonIndex += 1; const randomInt = randomFor(state, context);
  if (state.configuration.mode !== 'standard') {
    state.teddy.deck = shuffle([...state.teddy.deck, ...state.teddy.discard], randomInt); state.teddy.discard = []; state.teddy.shuffleGeneration += 1;
  }
  setTrail(state, randomInt);
  const oldGear = state.markets.gear.filter(Boolean).at(-1);
  if (oldGear) { state.removed.gear.push(oldGear); state.markets.gear[state.markets.gear.indexOf(oldGear)] = null; fillMarket(state, 'gear', { compact: true }); }
  state.seasonRewardQueue = null;
  emit(state, 'season-started', { seasonIndex: state.seasonIndex, seasonId: state.seasons[state.seasonIndex] });
  beginController(state, state.controllers.findIndex(value => value.id === state.firstPlayerId), context.now);
}
export function drawTeddy(state, context) {
  if (state.teddy.deck.length <= 1) {
    state.teddy.deck = shuffle([...state.teddy.deck, ...state.teddy.discard], randomFor(state, context)); state.teddy.discard = []; state.teddy.shuffleGeneration += 1;
  }
  const cardId = state.teddy.deck.shift(), selection = teddyById.get(state.teddy.deck[0]).ownBackSelection;
  state.teddy.discard.push(cardId); state.teddy.batch.drawn = { cardId, selection };
  state.teddy.lastDraw = { cardId, selection }; state.stage = 'teddy-move';
  const groups = state.teddy.batch.remainingGroups;
  if (state.configuration.mode === 'solo' && groups.length > 1) {
    if (state.teddy.batch.first) openWindow(state, 'teddy-order', state.players[0].id, context.now);
    createOpportunity(state, state.players[0].id, cardId, [{ kind: 'teddy-order' }], { mandatory: true, kind: 'teddy-order', started: true, data: { groups: [...groups] } });
  } else state.teddy.batch.selectedGroup = groups[0];
  emit(state, 'teddy-card-revealed', { cardId, selection });
}
export function moveTeddy(state, context) {
  const controller = state.controllers.find(value => value.kind === 'teddy'), batch = state.teddy.batch;
  const hikers = controller.hikers.filter(hiker => hiker.groupId === batch.selectedGroup && hiker.position < 10)
    .sort((a, b) => (batch.drawn.selection === 'front' ? b.position - a.position : a.position - b.position) || a.id.localeCompare(b.id));
  const hiker = hikers[0], card = teddyById.get(batch.drawn.cardId);
  let position;
  if (activeControllers(state).length === 1) position = 10;
  else if (card.front.movement.kind === 'exact_spaces') position = Math.min(10, hiker.position + card.front.movement.distance);
  else { position = hiker.position + 1; while (position < 10 && allHikers(state).some(value => value.position === position)) position += 1; }
  hiker.position = position; hiker.endSlot = position === 10 ? card.front.trailEnd : null;
  const site = position < 10 ? state.trail[position - 1] : null;
  const tent = state.configuration.camping && state.configuration.mode === 'solo' ? state.camping.tents.find(value => value.position === position && value.slotId === null) : null;
  const face = state.configuration.camping ? state.camping.seasonBoards[state.seasonIndex].faceId : null;
  const usedSlots = state.camping.tents.map(value => value.slotId).filter(Boolean);
  const freeSlot = tent ? [4, 3, 2, 1].map(value => `${face}.slot.${value}`).find(value => !usedSlots.includes(value)) : null;
  if (freeSlot) { tent.position = null; tent.slotId = freeSlot; }
  else {
    if (site?.weather) { state.bankResources[site.weather] += 1; site.weather = null; }
    if (position === 10 && !state.endRewards[hiker.endSlot]) { state.endRewards[hiker.endSlot] = true; if (hiker.endSlot === 'parks') state.firstPlayerId = 'system.teddy'; }
    if (state.configuration.mode === 'solo') {
      if (site?.siteId === state.shutterbugSiteId) state.shutterbugOwnerId = 'system.teddy';
      const kind = site?.siteId === 'site.parks' || hiker.endSlot === 'parks' ? 'parks' : site?.siteId === 'site.gear' || hiker.endSlot === 'gear' ? 'gear' : null;
      if (kind) { const removed = state.markets[kind].filter(Boolean).at(-1);
        if (removed) { state.removed[kind].push(removed); state.markets[kind][state.markets[kind].indexOf(removed)] = null; fillMarket(state, kind, { compact: true }); } }
    }
  }
  emit(state, 'hiker-moved', { actorId: 'system.teddy', hikerId: hiker.id, position, endSlot: hiker.endSlot, campingSlotId: freeSlot });
  batch.remainingGroups = batch.remainingGroups.filter(group => group !== batch.selectedGroup); batch.selectedGroup = null; batch.drawn = null; batch.first = false;
  if (batch.remainingGroups.length) state.stage = 'teddy-draw'; else { state.teddy.batch = null; advanceController(state, context.now); }
}
export function prepareAwards(state, context) {
  state.seasonRewardQueue = seasonWinners(state); state.stage = 'season-next-award';
  emit(state, 'season-qualified', { seasonId: state.seasons[state.seasonIndex], playerIds: [...state.seasonRewardQueue] });
}
export function nextAward(state, context) {
  const id = state.seasonRewardQueue.shift();
  if (!id) { completeSeason(state, context); return; }
  openWindow(state, 'season-reward', id, context.now); state.stage = 'season-reward';
  createOpportunity(state, id, state.seasons[state.seasonIndex], SEASON_BEHAVIORS[state.seasons[state.seasonIndex]].program,
    { mandatory: true, started: true, kind: 'season-reward' });
}
