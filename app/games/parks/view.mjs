import { CAMPING_BEHAVIORS, SEASON_BEHAVIORS } from './content/behavior-data.mjs';
import { stateProblem } from './rules/validation.mjs';
import { legalActions } from './rules/actions.mjs';
import { controllerHikers } from './rules/flow.mjs';
import { parkById, passionById, seasonById, backpackCapacity, countResources, openOpportunities } from './rules/model.mjs';
import { passionMetric } from './rules/scoring.mjs';
const clone = structuredClone;
const sourceReason = op => ({ base: '你停在这个地点，必须完成本次地点行动。', weather: '这里还有未领取的天气，可先安排它的收益。',
  'end-bonus': '你是第一个选择此终点行动的人。', gear: '你刚完成了这件装备的触发条件，本窗口可使用一次。', 'canteen-effect': '新水填入这一行，现在可以获得这些水壶的收益。',
  'new-water': '刚取得的这一枚新水可以放入背包或填一行尚未填过的水壶。', 'park-instant': '你刚游览这个公园，领取它的即时收益。',
  'die-result': '这是刚掷出的真实骰面，领取对应收益。', 'passion-branch': '你已达成热忱目标，现在选择能力或终局计分。', 'starting-passion': '从自己这两张热忱中选一张作为本局目标。',
  'gain-replacement': '你的热忱能力可以把本次一枚普通资源改为野生动物。', 'teddy-order': '本轮Teddy要分别移动两个颜色组，你决定哪个组先使用这张牌。',
  'season-reward': '你符合本季的奖励条件，先结清奖励再开始下一季。', 'passion-bonus': '已生效的热忱为本次行动提供额外收益。' }[op.kind] ?? '处理这项已经获得的收益。');
const labels = { base: '地点行动', weather: '天气', 'end-bonus': '首到奖励', gear: '装备收益', 'canteen-effect': '水壶收益', 'new-water': '分配新水',
  'park-instant': '公园即时收益', 'die-result': '骰子收益', 'passion-branch': '完成热忱', 'starting-passion': '选择热忱', 'gain-replacement': '替换领取资源',
  'teddy-order': 'Teddy颜色顺序', 'season-reward': '季节奖励', 'passion-bonus': '热忱收益' };
function projection(state, selfId, context = {}) {
  const problem = stateProblem(state); if (problem) throw new TypeError(problem);
  const participant = state.players.find(owner => owner.id === selfId);
  const actionable = participant && (!Number.isSafeInteger(context.now) || state.decisionWindow.deadlineAt === null || context.now < state.decisionWindow.deadlineAt);
  const actions = actionable ? legalActions(state, selfId) : [];
  const players = state.players.map(owner => ({ id: owner.id, hikers: clone(owner.hikers), resources: clone(owner.resources), canteenRows: clone(owner.canteenRows),
    campfire: owner.campfire, passionId: owner.passionId, passionBranch: owner.passionBranch, passionProgress: owner.passionId ? passionMetric(owner, passionById.get(owner.passionId).goal) : null,
    gear: [...owner.gear], visited: [...owner.visited], reserved: [...owner.reserved], photos: owner.photos, gearPurchases: owner.gearPurchases,
    backpackCapacity: backpackCapacity(state, owner), backpackCount: countResources(owner.resources), bonusPoints: owner.bonusPoints,
    score: state.result?.scores.find(value => value.playerId === owner.id)?.score ?? null }));
  const hikers = state.controllers.flatMap(controller => controllerHikers(state, controller).map(hiker => ({ ...clone(hiker), controllerId: controller.id, controllerKind: controller.kind })));
  const window = clone(state.decisionWindow);
  if (Number.isSafeInteger(context.now) && window.deadlineAt !== null) window.remainingMs = Math.max(0, window.deadlineAt - context.now);
  const opportunities = openOpportunities(state).map(op => ({ id: op.id, windowId: op.windowId, sourceId: op.sourceId, parentId: op.parentId,
    ownerSeatId: op.ownerSeatId, kind: op.kind, mandatory: op.mandatory, started: op.started, status: op.status, label: labels[op.kind] ?? '当前收益', reason: sourceReason(op),
    choices: actions.filter(action => action.opportunityId === op.id) }));
  const faceId = state.configuration.camping ? state.camping.seasonBoards[state.seasonIndex].faceId : null;
  return { version: state.version, gameType: state.gameType, ruleVersion: state.ruleVersion, contentVersion: state.contentVersion, behaviorVersion: state.behaviorVersion,
    matchId: state.matchId, revision: state.revision, status: state.status, stage: state.stage, configuration: clone(state.configuration),
    selfId: participant?.id ?? null, players, controllers: state.controllers.map(controller => ({ id: controller.id, kind: controller.kind })), hikers,
    turnPlayerId: state.turnPlayerId ?? null, turnIndex: state.turnIndex ?? null, turnNumber: state.turnNumber,
    firstPlayerId: state.firstPlayerId, shutterbugOwnerId: state.shutterbugOwnerId, shutterbugSiteId: state.shutterbugSiteId,
    trail: state.trail.map(site => ({ ...clone(site), hikerIds: hikers.filter(hiker => hiker.position === site.position).map(hiker => hiker.id), shutterbug: site.siteId === state.shutterbugSiteId })),
    endRewards: clone(state.endRewards), markets: clone(state.markets), deckCounts: Object.fromEntries(['parks', 'gear', 'canteens', 'passions'].map(kind => [kind, state.decks[kind].length])),
    bankResources: clone(state.bankResources), season: { id: state.seasons[state.seasonIndex], index: state.seasonIndex, nameZh: seasonById.get(state.seasons[state.seasonIndex]).nameZh,
      metric: clone(SEASON_BEHAVIORS[state.seasons[state.seasonIndex]].metric), reward: clone(SEASON_BEHAVIORS[state.seasons[state.seasonIndex]].program) },
    projects: [...state.projects], camping: { enabled: state.configuration.camping, faceId, remainingBoardsCount: state.configuration.camping ? 2 - state.seasonIndex : 0,
      tents: clone(state.camping.tents), slots: faceId ? [1, 2, 3, 4].map(n => { const id = `${faceId}.slot.${n}`; return { id, ...clone(CAMPING_BEHAVIORS[id]), occupiedTentId: state.camping.tents.find(tent => tent.slotId === id)?.id ?? null }; }) : [] },
    teddy: { enabled: state.configuration.mode !== 'standard', drawCount: state.teddy.deck.length, discardCount: state.teddy.discard.length,
      lastDraw: clone(state.teddy.lastDraw), pendingGroups: clone(state.teddy.batch?.remainingGroups ?? []), selectedGroup: state.teddy.batch?.selectedGroup ?? null },
    lastDie: clone(state.lastDie ?? null), window, opportunities, legalActions: actions, selfCandidates: participant ? [...participant.passionCandidates] : [],
    currentSiteId: state.currentSiteId ?? null, arrivalMode: state.arrivalMode ?? null, lastPublicEvents: clone(state.lastPublicEvents), result: clone(state.result) };
}
export const privateView = (state, selfId, context) => projection(state, selfId, context);
export const spectatorView = (state, context) => projection(state, null, context);
