import { PARKS, GEAR, PASSIONS, CANTEEN_TOKENS, TEDDY_CARDS, CAMPING_TILES, SEASONS, VOLUNTEER_PROJECTS, CONTENT_VERSION, CONTENT_PROVENANCE } from '../content/catalog.mjs';
import { RULE_VERSION, STATE_VERSION, RESOURCE_KEYS, RESOURCE_STOCK, integer, plain, validResources, configurationProblem, siteIds, TURN_MS } from './model.mjs';
import { finalResult, passionMetric } from './scoring.mjs';
const phases = ['initial-passion', 'move', 'resolve', 'teddy-draw', 'teddy-move', 'season-awards', 'season-next-award', 'season-reward', 'finished'];
const programKinds = ['gain', 'light-fire', 'photo', 'canteen', 'reserve', 'die', 'parks', 'gear', 'branch', 'trade', 'gain-choice', 'badge', 'free-gear', 'free-photo', 'points', 'starting-passion', 'teddy-order', 'new-water', 'passion-branch', 'gain-replacement', 'claim-weather'];
const ids = collection => collection.map(value => value.id);
function exactCollection(actual, expected) { return Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === actual.length && actual.every(id => expected.includes(id)); }
function vectors(values) { const result = Object.fromEntries(RESOURCE_KEYS.map(key => [key, 0])); for (const value of values) for (const key of RESOURCE_KEYS) result[key] += value[key]; return result; }
function programProblem(step) {
  if (!plain(step) || !programKinds.includes(step.kind)) return true;
  if (step.kind === 'gain') return !plain(step.resources) || Object.keys(step.resources).some(key => !RESOURCE_KEYS.includes(key) || !integer(step.resources[key]) || step.resources[key] > RESOURCE_STOCK[key]);
  if (['points', 'free-photo'].includes(step.kind)) return !integer(step.amount) || step.amount > 10;
  if (step.kind === 'trade') return !integer(step.paymentCount) || step.paymentCount < 1 || step.paymentCount > 2 || !plain(step.resources) || Object.keys(step.resources).some(key => !RESOURCE_KEYS.includes(key) || !integer(step.resources[key]));
  if (step.kind === 'gain-choice') return !integer(step.amount) || step.amount > 2 || !Array.isArray(step.choices) || !step.choices.length || new Set(step.choices).size !== step.choices.length || step.choices.some(key => !RESOURCE_KEYS.includes(key));
  if (step.kind === 'branch') return JSON.stringify(step.choices) !== JSON.stringify(['canteen', 'photo']);
  if (step.kind === 'claim-weather') return !['sun', 'water'].includes(step.resource);
  return false;
}
export function stateProblem(state) {
  try {
    if (!plain(state) || state.version !== STATE_VERSION || state.gameType !== 'parks' || state.ruleVersion !== RULE_VERSION || state.contentVersion !== CONTENT_VERSION
      || state.contentDigest !== CONTENT_PROVENANCE.sources.map(value => value.sha256).join(':') || state.behaviorVersion !== 'parks-behaviors-v1') return '公园规则或内容版本不兼容。';
    if (typeof state.matchId !== 'string' || !state.matchId || state.matchId.length > 100 || !['playing', 'finished'].includes(state.status) || !phases.includes(state.stage)
      || !integer(state.seasonIndex) || state.seasonIndex > 2 || !['revision', 'randomCursor', 'systemCursor', 'windowSequence', 'opportunitySequence', 'publicEventSequence', 'startedAt', 'committedAt', 'turnNumber'].every(key => integer(state[key]))) return '公园对局标识或进度无效。';
    if (!Array.isArray(state.players) || configurationProblem(state.configuration, state.players.length) || new Set(state.players.map(value => value.id)).size !== state.players.length) return '公园人数或配置无效。';
    const playerIds = state.players.map(value => value.id);
    if (!Array.isArray(state.controllers) || state.controllers.length !== state.players.length + Number(state.configuration.mode !== 'standard')
      || state.controllers.filter(value => value.kind === 'human').some(value => !playerIds.includes(value.id)) || state.controllers.filter(value => value.kind === 'human').length !== state.players.length
      || new Set(state.controllers.map(value => value.id)).size !== state.controllers.length || state.controllers.some(value => !['human', 'teddy'].includes(value.kind))
      || (state.configuration.mode !== 'standard' && (state.controllers[0].id !== 'system.teddy' || state.controllers[0].kind !== 'teddy'))
      || !integer(state.controllerIndex ?? 0) || (state.controllerIndex ?? 0) >= state.controllers.length) return '真人和系统控制者关系无效。';
    if (state.stage !== 'initial-passion' && !state.controllers.some(value => value.id === state.turnPlayerId)) return '当前控制者无效。';
    if (!state.controllers.some(value => value.id === state.firstPlayerId) || (state.shutterbugOwnerId !== null && !state.controllers.some(value => value.id === state.shutterbugOwnerId))) return '先手或摄影徽章归属无效。';
    if (!validResources(state.bankResources)) return '公共资源库存无效。';
    const hikers = [], resources = [state.bankResources], parks = [], gears = [], canteens = [], passions = [];
    for (const owner of state.players) {
      if (!plain(owner) || typeof owner.id !== 'string' || !owner.id || owner.id.startsWith('system.') || !validResources(owner.resources) || typeof owner.campfire !== 'boolean'
        || !['photos', 'gearPurchases', 'paidPhotoWithWildlife', 'bonusPoints'].every(key => integer(owner[key]))) return '个人资源或记录无效。';
      if (!Array.isArray(owner.hikers) || owner.hikers.length !== 2 || owner.hikers.some((hiker, index) => hiker.id !== `${owner.id}:hiker:${index + 1}`)) return '个人徒步者无效。';
      hikers.push(...owner.hikers); resources.push(owner.resources);
      if (!Array.isArray(owner.canteenRows) || owner.canteenRows.length !== 3 || owner.canteenRows.some(row => !plain(row) || !Array.isArray(row.tokens) || row.tokens.length > 2 || typeof row.filled !== 'boolean' || row.filled && !row.tokens.length)) return '水壶行无效。';
      for (const row of owner.canteenRows) { canteens.push(...row.tokens); if (row.filled) resources.push({ mountain: 0, forest: 0, sun: 0, water: 1, wildlife: 0 }); }
      if (!Array.isArray(owner.gear) || !Array.isArray(owner.visited) || !Array.isArray(owner.reserved) || !Array.isArray(owner.passionCandidates)
        || ![null, 'ability', 'scoring'].includes(owner.passionBranch) || owner.passionBranch !== null && owner.passionId === null || owner.passionId === null && owner.passionCandidates.length !== 2 || owner.passionId !== null && owner.passionCandidates.length) return '个人卡牌区域无效。';
      if (owner.passionId) passions.push(owner.passionId); passions.push(...owner.passionCandidates);
      if (owner.passionBranch !== null) { const definition = PASSIONS.find(value => value.id === owner.passionId);
        if (!definition || passionMetric(owner, definition.goal) < definition.goal.minimum) return '热忱尚未达标却存在已选分支。'; }
      parks.push(...owner.visited, ...owner.reserved); gears.push(...owner.gear);
      if (owner.gearPurchases > owner.gear.length || state.projects.includes('volunteer.wildlife-conservation') && owner.resources.wildlife > 1) return '装备购买次数或野生动物上限无效。';
    }
    for (const controller of state.controllers.filter(value => value.kind === 'teddy')) {
      const groups = state.configuration.mode === 'solo' ? ['teddy.amber', 'teddy.blue'] : ['teddy.amber'];
      if (!Array.isArray(controller.hikers) || controller.hikers.length !== groups.length * 2 || !exactCollection(controller.hikers.map(hiker => hiker.id), groups.flatMap(group => [1, 2].map(n => `${group}:${n}`)))
        || controller.hikers.some(hiker => !groups.includes(hiker.groupId))) return 'Teddy棋子组无效。';
      hikers.push(...controller.hikers);
    }
    if (new Set(hikers.map(value => value.id)).size !== hikers.length || hikers.some(value => !integer(value.position) || value.position > 10 || (value.position === 10 ? !['parks', 'photo', 'gear'].includes(value.endSlot) : value.endSlot !== null))) return '棋子位置无效。';
    if (!Array.isArray(state.trail) || state.trail.length !== 9 || !exactCollection(state.trail.map(value => value.siteId), [...siteIds, 'site.parks']) || state.trail[4].siteId !== 'site.parks'
      || state.trail.some((site, index) => site.position !== index + 1 || ![null, 'sun', 'water'].includes(site.weather))) return '步道或天气无效。';
    for (const site of state.trail) if (site.weather) resources.push({ mountain: 0, forest: 0, sun: Number(site.weather === 'sun'), water: Number(site.weather === 'water'), wildlife: 0 });
    if (!plain(state.endRewards) || ['parks', 'photo', 'gear'].some(key => typeof state.endRewards[key] !== 'boolean') || ![...siteIds, 'site.parks'].includes(state.shutterbugSiteId)) return '终点或摄影地点无效。';
    if (!plain(state.decks) || !plain(state.markets) || !plain(state.removed) || ['parks', 'gear', 'canteens'].some(key => !Array.isArray(state.decks[key]) || !Array.isArray(state.markets[key]) || state.markets[key].length !== 3)
      || !Array.isArray(state.decks.passions) || !Array.isArray(state.removed.parks) || !Array.isArray(state.removed.gear) || !Array.isArray(state.removed.passions)) return '市场或牌堆无效。';
    if (!exactCollection([...parks, ...state.decks.parks, ...state.markets.parks.filter(Boolean), ...state.removed.parks], ids(PARKS))
      || !exactCollection([...gears, ...state.decks.gear, ...state.markets.gear.filter(Boolean), ...state.removed.gear], ids(GEAR))
      || !exactCollection([...canteens, ...state.decks.canteens, ...state.markets.canteens.filter(Boolean)], ids(CANTEEN_TOKENS))
      || !exactCollection([...passions, ...state.decks.passions, ...state.removed.passions], ids(PASSIONS))) return '卡牌实体重复、遗漏或不属于冻结牌库。';
    if (!Array.isArray(state.seasons) || state.seasons.length !== 3 || state.seasons.some((id, index) => !SEASONS.some(season => season.id === id && season.season === ['spring', 'summer', 'fall'][index]))) return '三季定义无效。';
    if (!Array.isArray(state.projects) || state.projects.length !== state.configuration.volunteerCount || new Set(state.projects).size !== state.projects.length || state.projects.some(id => !ids(VOLUNTEER_PROJECTS).includes(id))) return '志愿项目无效。';
    if (!plain(state.teddy) || !Array.isArray(state.teddy.deck) || !Array.isArray(state.teddy.discard) || !integer(state.teddy.shuffleGeneration)) return 'Teddy牌库无效。';
    if (state.configuration.mode !== 'standard' ? !exactCollection([...state.teddy.deck, ...state.teddy.discard], ids(TEDDY_CARDS)) : state.teddy.deck.length || state.teddy.discard.length) return 'Teddy实体重复或遗漏。';
    if (state.teddy.batch !== null && (!plain(state.teddy.batch) || !Array.isArray(state.teddy.batch.remainingGroups) || new Set(state.teddy.batch.remainingGroups).size !== state.teddy.batch.remainingGroups.length
      || state.teddy.batch.remainingGroups.some(id => !['teddy.amber', 'teddy.blue'].includes(id)) || typeof state.teddy.batch.first !== 'boolean'
      || state.teddy.batch.selectedGroup !== null && !state.teddy.batch.remainingGroups.includes(state.teddy.batch.selectedGroup)
      || state.teddy.batch.drawn !== null && (!ids(TEDDY_CARDS).includes(state.teddy.batch.drawn.cardId) || !['front', 'back'].includes(state.teddy.batch.drawn.selection)))) return 'Teddy待移动步骤无效。';
    if (!plain(state.camping) || !Array.isArray(state.camping.seasonBoards) || !Array.isArray(state.camping.unusedTiles) || !Array.isArray(state.camping.tents) || !Array.isArray(state.camping.discardedFaces)) return '露营记录无效。';
    if (state.configuration.camping) {
      if (state.camping.seasonBoards.length !== 3 || !exactCollection([...state.camping.seasonBoards.map(value => value.tileId), ...state.camping.unusedTiles], ids(CAMPING_TILES))
        || state.camping.seasonBoards.some(value => !CAMPING_TILES.find(tile => tile.id === value.tileId)?.faceIds.includes(value.faceId)) || state.camping.tents.length !== 3
        || state.camping.discardedFaces.length !== state.seasonIndex) return '露营板面或帐篷数量无效。';
      const face = state.camping.seasonBoards[state.seasonIndex].faceId, used = state.camping.tents.map(value => value.slotId).filter(Boolean);
      if (new Set(used).size !== used.length || state.camping.tents.some((tent, index) => tent.id !== `tent.${index + 1}` || (tent.slotId === null ? tent.position !== [5, 7, 9][index] : tent.position !== null || ![1, 2, 3, 4].map(n => `${face}.slot.${n}`).includes(tent.slotId)))) return '帐篷占位无效。';
    } else if (state.camping.seasonBoards.length || state.camping.unusedTiles.length || state.camping.tents.length || state.camping.discardedFaces.length) return '未启用露营却存在露营状态。';
    if (!plain(state.decisionWindow) || state.decisionWindow.id !== `${state.matchId}:window:${state.windowSequence}` || !['turn', 'starting-passion', 'teddy-order', 'season-reward', 'system'].includes(state.decisionWindow.kind)
      || ![null, ...playerIds].includes(state.decisionWindow.responsibleSeatId) || typeof state.decisionWindow.paused !== 'boolean' || !['open', 'complete'].includes(state.decisionWindow.status)
      || !integer(state.decisionWindow.remainingMs) || state.decisionWindow.remainingMs > TURN_MS || state.decisionWindow.deadlineAt !== null && !integer(state.decisionWindow.deadlineAt)
      || state.decisionWindow.paused && state.decisionWindow.deadlineAt !== null) return '责任窗口或计时记录无效。';
    if (!plain(state.windowUsage) || !Array.isArray(state.windowUsage.gear) || !Array.isArray(state.windowUsage.passion) || new Set(state.windowUsage.gear).size !== state.windowUsage.gear.length
      || state.windowUsage.gear.some(id => !ids(GEAR).includes(id)) || new Set(state.windowUsage.passion).size !== state.windowUsage.passion.length || state.windowUsage.passion.some(id => !ids(PASSIONS).includes(id))
      || typeof state.windowUsage.badge !== 'boolean' || typeof state.windowUsage.sunChecked !== 'boolean') return '本窗口限次记录无效。';
    if (!Array.isArray(state.opportunities) || state.opportunities.length > 2048 || new Set(state.opportunities.map(op => op.id)).size !== state.opportunities.length) return '动作机会数量或编号无效。';
    for (const op of state.opportunities) {
      const prefix = `${state.matchId}:op:`, suffix = typeof op?.id === 'string' && op.id.startsWith(prefix) ? op.id.slice(prefix.length) : '';
      if (!plain(op) || !/^[1-9][0-9]*$/u.test(suffix) || !integer(Number(suffix)) || Number(suffix) > state.opportunitySequence || !playerIds.includes(op.ownerSeatId) || op.windowId !== state.decisionWindow.id
        || typeof op.sourceId !== 'string' || !['open', 'complete', 'forgone', 'skipped'].includes(op.status) || typeof op.mandatory !== 'boolean' || typeof op.started !== 'boolean'
        || !Array.isArray(op.program) || !op.program.length || op.program.length > 16 || op.program.some(programProblem) || !integer(op.index) || op.index > op.program.length || !plain(op.data)
        || op.parentId !== null && !state.opportunities.some(parent => parent.id === op.parentId) || op.parentId === op.id) return '动作机会因果或程序无效。';
      if (op.data.heldWater !== undefined) { if (![0, 1].includes(op.data.heldWater) || op.data.heldWater && op.status !== 'open') return '待分配新水归属无效。'; resources.push({ mountain: 0, forest: 0, sun: 0, water: op.data.heldWater, wildlife: 0 }); }
      if (op.data.heldWeather) { if (!['sun', 'water'].includes(op.data.heldWeather) || op.status !== 'open') return '待领取天气归属无效。'; resources.push({ mountain: 0, forest: 0, sun: Number(op.data.heldWeather === 'sun'), water: Number(op.data.heldWeather === 'water'), wildlife: 0 }); }
      if (op.data.blockedBy && !state.opportunities.some(value => value.id === op.data.blockedBy)) return '奖励前提丢失。';
      if (op.data.paidResourceExchange !== undefined && (op.data.paidResourceExchange !== true || !integer(op.data.receivedResourceCount)
        || op.data.receivedResourceCount > 106 || op.status === 'complete' && op.data.receivedResourceCount === 0)) return '付费资源兑换的实际所得记录无效。';
      const seen = new Set([op.id]); let parent = op; while (parent.parentId !== null) { if (seen.has(parent.parentId)) return '动作机会存在因果循环。'; seen.add(parent.parentId); parent = state.opportunities.find(value => value.id === parent.parentId); }
    }
    const stock = vectors(resources); if (RESOURCE_KEYS.some(key => stock[key] !== RESOURCE_STOCK[key])) return '有限资源不守恒。';
    if (state.status === 'finished') {
      if (state.stage !== 'finished' || !plain(state.result) || !integer(state.result.settledAt) || typeof state.result.aborted !== 'boolean' || state.decisionWindow.status !== 'complete') return '终局记录无效。';
      if (!state.result.aborted && JSON.stringify(state.result) !== JSON.stringify(finalResult(state, state.result.settledAt))) return '终局得分与最终状态不一致。';
      if (state.result.aborted && (state.result.scores.length || state.result.winnerIds.length)) return '中止局不能记胜负得分。';
    } else if (state.result !== null || state.stage === 'finished') return '未结束却存在终局记录。';
    if (!Array.isArray(state.lastPublicEvents) || state.lastPublicEvents.length > 512 || state.lastPublicEvents.some(event => !plain(event) || typeof event.id !== 'string' || typeof event.type !== 'string')) return '公开事件记录无效。';
    return null;
  } catch { return '公园状态结构无效。'; }
}
