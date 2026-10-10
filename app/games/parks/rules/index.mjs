import { RuleError, requireRule, integer, plain, TURN_MS, openOpportunities, childrenOf, countResources, backpackCapacity, player, fillMarket, emit, canonical } from './model.mjs';
import { initialGame, drawTeddy, moveTeddy, prepareAwards, nextAward } from './flow.mjs';
import { normalizeEffects, currentStep, rollDie } from './effects.mjs';
import { performAction } from './actions.mjs';
import { stateProblem } from './validation.mjs';
export { stateProblem } from './validation.mjs';
export { actionFields, validateActionShape, legalActions } from './actions.mjs';
export { RULE_VERSION, STATE_VERSION, TURN_MS, DEFAULT_CONFIGURATION, normalizeConfiguration, configurationProblem } from './model.mjs';
function contextProblem(context, state) {
  return !plain(context) || !integer(context.now) || state && context.now < state.committedAt;
}
export function createGame(players, context) {
  requireRule(!contextProblem(context), '开局时间无效。');
  const state = initialGame(players, context); normalizeEffects(state);
  requireRule(!stateProblem(state), stateProblem(state), 'INVALID_STATE'); return state;
}
function mutate(state, context, operation) {
  const originalProblem = stateProblem(state);
  if (originalProblem) return { ok: false, state, events: [], error: originalProblem, errorCode: 'INVALID_STATE' };
  if (contextProblem(context, state)) return { ok: false, state, events: [], error: '提交时间无效。', errorCode: 'INVALID_CONTEXT' };
  const next = structuredClone(state); next.lastPublicEvents = [];
  try {
    operation(next); if (next.status === 'playing') normalizeEffects(next); next.revision += 1; next.committedAt = context.now;
    const problem = stateProblem(next); requireRule(!problem, problem, 'INVALID_STATE');
    return { ok: true, state: next, events: [...next.lastPublicEvents], ...(next.decisionWindow.paused ? { roomPhase: 'paused' } : next.status === 'finished' ? { roomPhase: 'finished' } : {}) };
  } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    return { ok: false, state, events: [], error: error.message, errorCode: error.code };
  }
}
export const applyGameAction = (state, playerId, intent, context) => mutate(state, context, next => performAction(next, playerId, intent, context));
function systemType(state) {
  if (state.status !== 'playing' || state.decisionWindow.paused) return null;
  if (state.stage === 'teddy-draw') return { type: 'teddy-draw' };
  if (state.stage === 'teddy-move' && state.teddy.batch.selectedGroup) return { type: 'teddy-move' };
  if (state.stage === 'season-awards') return { type: 'season-awards' };
  if (state.stage === 'season-next-award') return { type: 'season-next-award' };
  const die = openOpportunities(state).find(op => op.started && currentStep(op)?.kind === 'die' && !childrenOf(state, op.id).length
    && (!op.data.blockedBy || !openOpportunities(state).some(value => value.id === op.data.blockedBy)));
  if (die) return { type: 'roll-die', opportunityId: die.id };
  if (state.stage === 'season-reward' && !openOpportunities(state).length && countResources(player(state, state.decisionWindow.responsibleSeatId).resources) <= backpackCapacity(state, player(state, state.decisionWindow.responsibleSeatId))) return { type: 'complete-season-reward' };
  return null;
}
export function nextSystemStep(state) {
  if (stateProblem(state)) return null;
  const next = systemType(state); if (!next) return null;
  return { id: `${state.matchId}:system:${state.systemCursor + 1}:${state.revision}:${next.type}`, ...next,
    matchId: state.matchId, windowId: state.decisionWindow.id, revision: state.revision };
}
export function applySystemStep(state, step, context) {
  return mutate(state, context, next => {
    requireRule(next.decisionWindow.deadlineAt === null || context.now < next.decisionWindow.deadlineAt, '此窗口已超时，先恢复后继续。', 'WINDOW_EXPIRED');
    const expected = nextSystemStep(next);
    requireRule(expected && plain(step) && canonical(step) === canonical(expected), '自动步骤已经处理或状态已变化。', 'STALE_SYSTEM_STEP');
    switch (step.type) {
      case 'teddy-draw': drawTeddy(next, context); break;
      case 'teddy-move': moveTeddy(next, context); break;
      case 'season-awards': prepareAwards(next, context); break;
      case 'season-next-award': nextAward(next, context); break;
      case 'roll-die': rollDie(next, next.opportunities.find(op => op.id === step.opportunityId), context); break;
      case 'complete-season-reward': fillMarket(next, 'parks', { compact: true }); next.stage = 'season-next-award'; next.decisionWindow.status = 'complete'; next.decisionWindow.deadlineAt = null; next.decisionWindow.responsibleSeatId = null; break;
      default: throw new RuleError('未知自动步骤。');
    }
    next.systemCursor += 1;
  });
}
export function pauseGame(state, context) {
  return mutate(state, context, next => {
    requireRule(next.status === 'playing' && !next.decisionWindow.paused, '本局已经暂停或结束。');
    requireRule(context.cause === undefined || typeof context.cause === 'string' && context.cause.length > 0 && context.cause.length <= 100, '暂停原因无效。');
    const window = next.decisionWindow;
    window.remainingMs = window.deadlineAt === null ? 0 : Math.max(0, window.deadlineAt - context.now);
    window.deadlineAt = null; window.paused = true; window.pauseCause = context.cause ?? 'manual';
    emit(next, 'match-paused', { responsibleSeatId: window.responsibleSeatId, cause: window.pauseCause });
  });
}
export function resumeGame(state, context) {
  return mutate(state, context, next => {
    requireRule(next.status === 'playing' && next.decisionWindow.paused, '本局没有暂停。');
    const window = next.decisionWindow;
    if (window.pauseCause === 'timeout') window.remainingMs = window.responsibleSeatId ? TURN_MS : 0;
    window.deadlineAt = window.responsibleSeatId ? context.now + window.remainingMs : null;
    requireRule(window.deadlineAt === null || integer(window.deadlineAt), '恢复时间超出范围。');
    window.paused = false; window.pauseCause = null; emit(next, 'match-resumed', { responsibleSeatId: window.responsibleSeatId });
  });
}
export function applyTimeout(state, context) {
  if (stateProblem(state)) return { ok: false, state, events: [], error: '公园状态无效。', errorCode: 'INVALID_STATE' };
  if (contextProblem(context, state)) return { ok: false, state, events: [], error: '提交时间无效。', errorCode: 'INVALID_CONTEXT' };
  const window = state.decisionWindow;
  if (context.windowId !== window.id || window.paused || window.deadlineAt === null || context.now < window.deadlineAt)
    return { ok: false, state, events: [], error: '超时窗口已变化。', errorCode: 'STALE_TIMEOUT' };
  return pauseGame(state, { ...context, cause: 'timeout' });
}
export function abortGame(state, context) {
  return mutate(state, context, next => {
    requireRule(next.status === 'playing' && typeof context.reason === 'string' && context.reason.length > 0 && context.reason.length <= 100, '中止理由无效或对局已结算。');
    next.status = 'finished'; next.stage = 'finished';
    next.decisionWindow.paused = false; next.decisionWindow.status = 'complete'; next.decisionWindow.deadlineAt = null; next.decisionWindow.responsibleSeatId = null;
    next.result = { reason: context.reason, settledAt: context.now, mode: next.configuration.mode, scores: [], winnerIds: [], tie: false, aborted: true,
      configuration: structuredClone(next.configuration), projectIds: [...next.projects] };
    emit(next, 'match-aborted', { reason: context.reason });
  });
}
