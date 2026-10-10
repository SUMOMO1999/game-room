import { openOpportunities, childrenOf, opportunity, player, requireRule, RuleError, plain, validResources, RESOURCE_KEYS, countResources, backpackCapacity, zeroResources, fillMarket, emit, canonical } from './model.mjs';
import { normalizeEffects, currentStep, effectChoices, resolveEffect } from './effects.mjs';
import { arrival, moveChoices, canCompleteMandatory } from './legality.mjs';
import { advanceController, openNextPassion } from './flow.mjs';
import { paymentQuote } from './resources.mjs';

const fenceFields = ['type', 'matchId', 'windowId', 'opportunityId'];
const fields = {
  'move-hiker': ['hikerId', 'position', 'endSlot', 'arrivalMode', 'campingSlotId', 'payment'],
  'use-opportunity': [], 'resolve-opportunity': ['action', 'targetId', 'rowIndex', 'payment', 'count', 'wildlifeBoost', 'compensationResource', 'resources', 'choice'],
  'allocate-water': ['rowIndex'], 'choose-passion': ['choice'], 'choose-starting-passion': ['targetId'], 'choose-teddy': ['groupId'],
  'finish-opportunity': [], 'discard-resources': ['resources'], 'finish-window': [],
};
export const actionFields = Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Object.freeze([...fenceFields, ...value])])));
const resolveFields = {
  reserve: ['action', 'targetId'], visit: ['action', 'targetId', 'payment', 'compensationResource'], 'buy-gear': ['action', 'targetId', 'payment'],
  'gain-canteen': ['action', 'targetId', 'rowIndex'], 'take-photo': ['action', 'count', 'wildlifeBoost', 'payment'], trade: ['action', 'payment'],
  branch: ['action', 'choice'], 'choose-gain': ['action', 'resources'], 'replace-gain': ['action', 'choice'],
};
export function validateActionShape(intent) {
  if (!plain(intent) || !actionFields[intent.type] || Object.keys(intent).some(key => !actionFields[intent.type].includes(key))) return '操作字段无效。';
  const exact = intent.type === 'resolve-opportunity' ? resolveFields[intent.action] : fields[intent.type];
  if (!exact || Object.keys(intent).length !== fenceFields.length + exact.length || [...fenceFields, ...exact].some(key => !Object.hasOwn(intent, key))) return '操作参数不完整或含无关字段。';
  if (typeof intent.matchId !== 'string' || typeof intent.windowId !== 'string' || !(intent.opportunityId === null || typeof intent.opportunityId === 'string')) return '操作编号无效。';
  if (Object.hasOwn(intent, 'payment') && !validResources(intent.payment) || Object.hasOwn(intent, 'resources') && !validResources(intent.resources)) return '资源组合无效。';
  return null;
}
export function fenced(state, op, choice) {
  return { ...choice, fields: { type: choice.type, matchId: state.matchId, windowId: state.decisionWindow.id, opportunityId: op?.id ?? null, ...choice.fields },
    sourceId: choice.sourceId ?? op?.sourceId ?? null, opportunityId: op?.id ?? null, disabledReason: null };
}
function activeMandatory(state) { return openOpportunities(state).filter(op => op.mandatory); }
function discardChoices(owner, amount) {
  const options = [];
  function visit(index, left, vector) { if (index === RESOURCE_KEYS.length) { if (!left) options.push({ ...vector }); return; }
    const key = RESOURCE_KEYS[index]; for (let count = 0; count <= Math.min(owner.resources[key], left); count += 1) { vector[key] = count; visit(index + 1, left - count, vector); } }
  visit(0, amount, zeroResources()); return options;
}
export function legalActions(state, ownerId, { guard = true } = {}) {
  if (state.status !== 'playing' || state.decisionWindow?.paused || state.decisionWindow?.status !== 'open'
    || state.decisionWindow?.responsibleSeatId !== ownerId) return [];
  if (state.stage === 'move') return moveChoices(state, ownerId).map(choice => fenced(state, null, choice));
  const owner = player(state, ownerId), choices = [];
  const priority = openOpportunities(state).find(op => ['starting-passion', 'passion-branch', 'teddy-order', 'gain-replacement'].includes(currentStep(op)?.kind));
  for (const op of openOpportunities(state).filter(value => value.ownerSeatId === ownerId && (!priority || value.id === priority.id))) {
    for (const choice of effectChoices(state, op)) {
      if (guard) {
        const viable = (choice.cost?.paymentOptions ?? [null]).filter(payment => {
          const next = structuredClone(state), copied = next.opportunities.find(item => item.id === op.id);
          try { resolveEffect(next, copied, { type: choice.type, ...choice.fields, ...(payment ? { payment } : {}) }); normalizeEffects(next);
            return canCompleteMandatory(next, ownerId); }
          catch (error) { if (!(error instanceof RuleError)) throw error; return false; }
        });
        if (!viable.length) continue;
        if (choice.cost?.paymentOptions) {
          choice.cost.paymentOptions = viable; choice.cost.recommendedPayment = viable[0]; choice.fields.payment = viable[0];
          if (choice.cost.paymentQuotes) { choice.cost.paymentQuotes = choice.cost.paymentQuotes.filter(quote => viable.some(payment => canonical(payment) === canonical(quote.payment)));
            choice.result = structuredClone(choice.cost.paymentQuotes.find(quote => canonical(quote.payment) === canonical(viable[0]))?.result ?? choice.result); }
        }
      }
      choices.push(fenced(state, op, choice));
    }
    if (!op.mandatory && !childrenOf(state, op.id).length && (!op.started || currentStep(op)?.kind !== 'die')) {
      const next = structuredClone(state); forgo(next, next.opportunities.find(value => value.id === op.id));
      if (!guard || canCompleteMandatory(next, ownerId)) choices.push(fenced(state, op, { type: 'finish-opportunity', fields: {}, label: '放弃这项额外收益', cost: null, result: null }));
    }
  }
  if (!activeMandatory(state).length && ['resolve', 'season-reward'].includes(state.stage)) {
    const excess = countResources(owner.resources) - backpackCapacity(state, owner);
    if (excess > 0) {
      const options = discardChoices(owner, excess);
      choices.push(fenced(state, null, { type: 'discard-resources', fields: { resources: options[0] }, label: `归还${excess}枚超额资源`, cost: { discardCount: excess, available: { ...owner.resources }, recommendedPayment: options[0], paymentOptions: options,
        paymentQuotes: options.map(payment => paymentQuote(owner, payment, null)) }, result: null }));
    } else choices.push(fenced(state, null, { type: 'finish-window', fields: {}, label: state.stage === 'season-reward' ? '完成季节奖励' : '结束回合', cost: null, result: { forgoOptionalCount: openOpportunities(state).filter(op => !op.mandatory).length } }));
  }
  return choices;
}
function forgo(state, op) {
  requireRule(!op.mandatory, '基础行动或必选项不能直接放弃。');
  requireRule(!childrenOf(state, op.id).length, '先结清已经产生的必选项。');
  if (op.data.heldWeather) { state.bankResources[op.data.heldWeather] += 1; op.data.heldWeather = null; }
  op.status = 'forgone';
}
export function performAction(state, ownerId, intent, context) {
  requireRule(!validateActionShape(intent), validateActionShape(intent));
  const window = state.decisionWindow;
  requireRule(state.status === 'playing' && !window.paused && window.status === 'open', '当前对局不能操作。', 'PAUSED_OR_FINISHED');
  requireRule(intent.matchId === state.matchId && intent.windowId === window.id && ownerId === window.responsibleSeatId, '这不是当前由你负责的操作窗口。', 'STALE_WINDOW');
  requireRule(context.now < window.deadlineAt, '此窗口已超时，先恢复后继续。', 'WINDOW_EXPIRED');
  player(state, ownerId);
  if (intent.type === 'move-hiker') {
    requireRule(state.stage === 'move' && intent.opportunityId === null, '本回合已经移动过棋子。');
    const choices = moveChoices(state, ownerId), matching = choices.find(choice => canonical(choice.fields) === canonical(Object.fromEntries(fields['move-hiker'].map(key => [key, intent[key]]))));
    requireRule(matching, '此目的地没有可完成的地点行动。'); arrival(state, ownerId, intent);
    if (matching.result?.fallback && !canCompleteMandatory(state, ownerId)) {
      const base = openOpportunities(state).find(op => op.kind === 'base'); base.status = 'skipped';
      emit(state, 'base-action-skipped', { actorId: ownerId, reason: '没有可执行行动，前往终点。' });
    }
  } else if (intent.type === 'discard-resources') {
    requireRule(intent.opportunityId === null && !activeMandatory(state).length && ['resolve', 'season-reward'].includes(state.stage), '先完成本次必选操作。');
    const owner = player(state, ownerId), excess = countResources(owner.resources) - backpackCapacity(state, owner);
    requireRule(excess > 0 && countResources(intent.resources) === excess && RESOURCE_KEYS.every(key => intent.resources[key] <= owner.resources[key]), '必须恰好归还超出容量的资源。');
    for (const key of RESOURCE_KEYS) { owner.resources[key] -= intent.resources[key]; state.bankResources[key] += intent.resources[key]; }
  } else if (intent.type === 'finish-window') {
    requireRule(intent.opportunityId === null && legalActions(state, ownerId).some(choice => choice.type === 'finish-window'), '本次基础行动、必选项或背包检查尚未完成。');
    for (const op of openOpportunities(state)) forgo(state, op);
    if (state.stage === 'season-reward') { fillMarket(state, 'parks', { compact: true }); state.stage = 'season-next-award'; state.decisionWindow.status = 'complete'; state.decisionWindow.deadlineAt = null; state.decisionWindow.responsibleSeatId = null; }
    else advanceController(state, context.now);
  } else {
    requireRule(state.stage !== 'move' && intent.opportunityId !== null, '先移动一个棋子。');
    const op = opportunity(state, intent.opportunityId, ownerId);
    const priority = openOpportunities(state).find(value => ['starting-passion', 'passion-branch', 'teddy-order', 'gain-replacement'].includes(currentStep(value)?.kind));
    requireRule(!priority || priority.id === op.id, '请先完成当前必选项。');
    if (intent.type === 'finish-opportunity' && !op.mandatory) { requireRule(!op.started || currentStep(op)?.kind !== 'die', '已开始的骰子不能撤回。'); forgo(state, op); }
    else resolveEffect(state, op, intent);
    normalizeEffects(state);
    requireRule(canCompleteMandatory(state, ownerId), '先完成地点基础行动，或保留足够的确定费用。', 'CORE_OBLIGATION_PROTECTED');
    if (intent.type === 'choose-starting-passion') openNextPassion(state, context.now);
    if (intent.type === 'choose-teddy') { window.responsibleSeatId = null; window.deadlineAt = null; window.remainingMs = 0; window.kind = 'system'; }
  }
  normalizeEffects(state);
}
