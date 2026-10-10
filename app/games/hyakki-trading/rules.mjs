/** Authoritative pure rules. One accepted command creates one validated revision. */
import { createDeck, GOODS, CONTENT_VERSION, DIGITAL_RULE_VERSION } from './content/definitions.mjs';
import { RuleError, requireRule, definition, player, opponent, emptyGoods, goodsCount, goodsEntries, addSilver,
  moveGoods, removeCard, discardCards, drawCards, availableCards, shuffled, canReceive, ordinaryCapacity,
  refreshTemporary, createPending, completePending, resolveReceipt, resolveActionReferences, emit,
  DEFAULT_ACTION_LIMIT, DEFAULT_GOODS_PER_TYPE, validActionLimit, validGoodsPerType } from './model.mjs';
import { characterProblem, startCharacter, continueCharacter, chooseCharacter } from './effects.mjs';
import { toolProblem, startTool, continueTool, chooseTool } from './tools.mjs';
import { bid, passBid, continueAuction } from './auction.mjs';
import { TURN_MS, createHyakkiTiming, openHyakkiDecision, closeHyakkiDecision } from './lifecycle.mjs';
import { gameProblem } from './validation.mjs';
import { currentDecision } from './decision.mjs';
export { gameProblem, currentDecision };

const held = state => state.lifecycle.manual || state.lifecycle.absence || state.lifecycle.capacity;
const stamp = value => Number.isSafeInteger(value) && value >= 0;
const failure = error => ({ ok: false, error: error.message, code: error.code });
function check(state) { const issue = gameProblem(state); requireRule(!issue, issue, 'INVALID_GAME_STATE'); }
const runningClock = state => state.timing.decision ?? state.timing.active;

export function createGame(playerIds, { matchId, now, randomInt, actionLimit = DEFAULT_ACTION_LIMIT,
  goodsPerType = DEFAULT_GOODS_PER_TYPE, firstPlayerId = playerIds?.[0], presence } = {}) {
  requireRule(Array.isArray(playerIds) && playerIds.length === 2 && new Set(playerIds).size === 2
    && playerIds.includes(firstPlayerId), '幽街商人需要两位不同的参赛者。');
  requireRule(stamp(now) && Number.isSafeInteger(now + TURN_MS) && validActionLimit(actionLimit) && validGoodsPerType(goodsPerType), '开局参数无效。');
  const deck = shuffled(createDeck().map(card => card.id), randomInt);
  const players = playerIds.map(id => ({ id, hand: deck.splice(0, 5), tools: [], goods: emptyGoods(), silver: 20, stallCount: 0, temporaryOccupied: false }));
  const state = { version: 1, gameType: 'hyakki-trading', ruleVersion: DIGITAL_RULE_VERSION, contentVersion: CONTENT_VERSION, matchId,
    players, deck, discard: [], bankGoods: Object.fromEntries(GOODS.map(good => [good.id, goodsPerType])), goodsPerType,
    availableStalls: 5, purchasedStalls: 0, status: 'playing', result: null,
    firstPlayerId, turnPlayerId: firstPlayerId, turnIndex: playerIds.indexOf(firstPlayerId), turnNumber: 1, turnId: 'turn-1', round: 1,
    stage: 'draw', actionsUsed: 0, actionLimit, drawStarted: false, bookLayers: 0, closing: null,
    revision: 0, publicEventSequence: 1, lastPublicEvents: [{ type: 'match-started' }], committedAt: now,
    ...createHyakkiTiming(playerIds, firstPlayerId, now, presence), pending: null };
  check(state); return state;
}

/** Effects advance only to another explicit choice or a completed operation. */
function continuePending(state, ctx) {
  for (let step = 0; step < 250; step++) {
    const pending = state.pending;
    if (!pending || pending.choice || pending.response || pending.receipt || pending.kind === 'peek'
      || pending.kind === 'auction' && pending.stage === 'bidding') return;
    const previous = JSON.stringify(pending);
    if (pending.kind === 'character') continueCharacter(state, ctx);
    else if (pending.kind === 'tool') continueTool(state, ctx);
    else if (pending.kind === 'auction') continueAuction(state, ctx);
    else if (pending.kind === 'trade') completePending(state);
    else throw new RuleError('未知的效果阶段。', 'INVALID_GAME_STATE');
    requireRule(!state.pending || JSON.stringify(state.pending) !== previous, '效果没有推进。', 'INVALID_GAME_STATE');
  }
  throw new RuleError('效果超出有限结算步骤。', 'INVALID_GAME_STATE');
}

function finishGame(state, lastPlayerId, now) {
  const maximum = Math.max(...state.players.map(owner => owner.silver));
  const leaders = state.players.filter(owner => owner.silver === maximum);
  const winnerId = leaders.length === 2 ? lastPlayerId : leaders[0].id;
  state.status = 'finished';
  state.result = { reason: 'normal-close', winnerIds: [winnerId], aborted: false, settledAt: now,
    wealth: state.players.map(owner => ({ playerId: owner.id, silver: owner.silver })) };
  state.timing.decision = null;
  state.timing.active.remainingMs = Math.max(0, Math.min(state.timing.active.remainingMs, (state.timing.active.deadlineAt ?? now) - now));
  state.timing.active.deadlineAt = null;
  emit(state, { type: 'match-ended', reason: 'normal-close', winnerSeatId: winnerId });
}
function endTurn(state, now, { voluntary = false } = {}) {
  requireRule(!state.pending, '请先完成已经开始的操作。');
  const owner = player(state, state.turnPlayerId);
  if (voluntary && state.actionLimit - state.actionsUsed >= 2) addSilver(owner, 1);
  owner.tools.forEach(tool => { tool.exhausted = false; }); state.bookLayers = 0;
  emit(state, { type: 'turn-ended', actorSeatId: owner.id });
  if (state.closing?.finalPlayerId === owner.id || owner.silver >= 60 && owner.id !== state.firstPlayerId) {
    finishGame(state, owner.id, now); return;
  }
  if (owner.silver >= 60) state.closing = { triggerPlayerId: owner.id, finalPlayerId: opponent(state, owner.id).id };
  state.turnIndex = 1 - state.turnIndex; state.turnPlayerId = state.players[state.turnIndex].id;
  state.turnNumber++; state.turnId = `turn-${state.turnNumber}`; state.round = Math.ceil(state.turnNumber / 2);
  state.stage = 'draw'; state.actionsUsed = 0; state.drawStarted = false;
  state.timing = { active: { id: state.turnId, actorId: state.turnPlayerId, remainingMs: TURN_MS, deadlineAt: now + TURN_MS }, decision: null };
}

function synchronizeClock(state, now) {
  if (state.status !== 'playing') return;
  const decision = currentDecision(state);
  if (state.timing.decision && (decision?.actorId === state.turnPlayerId || decision?.id !== state.timing.decision.id)) {
    const result = closeHyakkiDecision(state, now); requireRule(result.ok, result.error); state.timing = result.state.timing;
  }
  if (decision && decision.actorId !== state.turnPlayerId && !state.timing.decision) {
    const result = openHyakkiDecision(state, { id: decision.id, actorId: decision.actorId, label: '等待对方选择', now });
    requireRule(result.ok, result.error); state.timing = result.state.timing;
  }
}

function ensureActive(state, actorId, now) {
  check(state); player(state, actorId);
  requireRule(stamp(now) && now >= state.committedAt && Number.isSafeInteger(now + TURN_MS), '服务器时间无效。');
  requireRule(state.status === 'playing', '本局已经结束。', 'MATCH_FINISHED');
  requireRule(!held(state), '本局已暂停，请等待双方恢复。', 'GAME_HELD');
}
function fence(state, action, actorId) {
  requireRule(action && action.matchId === state.matchId && action.turnId === state.turnId, '对局或回合已经改变。', 'STALE_ACTION');
  if (action.expectedRevision !== undefined) requireRule(action.expectedRevision === state.revision, '桌面已经更新，请使用当前局面。', 'STALE_ACTION');
  const decision = currentDecision(state);
  if (state.pending) {
    requireRule(decision && action.effectId === state.pending.id && action.decisionId === decision.id, '选择步骤已经改变。', 'STALE_ACTION');
    requireRule(actorId === decision.actorId, '请等待当前玩家完成选择。', 'WRONG_ACTOR');
  } else {
    requireRule(action.effectId === undefined && action.decisionId === undefined, '该效果已经结算。', 'STALE_ACTION');
    requireRule(actorId === state.turnPlayerId, '还没轮到你。', 'WRONG_ACTOR');
  }
}
function consumeAction(state) {
  requireRule(state.actionsUsed < state.actionLimit, '本回合行动已经用完。'); state.actionsUsed++;
}
function requireUse(state) { requireRule(state.stage === 'use', '请先结束看牌阶段。'); }
function ownedCard(state, actorId, cardId, category) {
  const owner = player(state, actorId), card = definition(cardId);
  requireRule(owner.hand.includes(cardId) && (!category || card.category === category), '请选择自己的对应手牌。'); return card;
}
function trade(state, actorId, cardId, buying) {
  requireUse(state);
  const owner = player(state, actorId), card = ownedCard(state, actorId, cardId, 'goods'), vector = { ...emptyGoods(), ...card.goods };
  const silver = buying ? Math.max(0, card.buySilver - 2 * state.bookLayers) : card.sellSilver + 2 * state.bookLayers;
  if (buying) requireRule(canReceive(owner, goodsCount(vector), silver), '银两或货位不足，不能整组买入。');
  consumeAction(state); removeCard(owner.hand, cardId);
  createPending(state, { kind: 'trade', ownerId: actorId, code: buying ? 'buy' : 'sell', sourceCards: [cardId] });
  const fee = buying && goodsCount(owner.goods) + goodsCount(vector) > ordinaryCapacity(owner) && !owner.temporaryOccupied ? 2 : 0;
  moveGoods(buying ? state.bankGoods : owner.goods, buying ? owner.goods : state.bankGoods, vector);
  addSilver(owner, buying ? -silver - fee : silver); refreshTemporary(owner);
  state.pending.stage = 'merchant'; state.pending.response = { kind: 'merchant', actorId: opponent(state, actorId).id, tradeCardId: cardId };
  emit(state, { type: buying ? 'trade-bought' : 'trade-sold', actorSeatId: actorId, cardId: card.id,
    goods: goodsEntries(vector).map(([id, count]) => ({ id, count })), silver });
}
function response(state, actorId, cardId) {
  const pending = state.pending, window = pending?.response;
  requireRule(window && window.actorId === actorId, '当前没有你的回应窗口。');
  if (cardId !== undefined) {
    const card = ownedCard(state, actorId, cardId);
    requireRule(card.sourceCode === (window.kind === 'counter' ? 'C07' : 'C04'), '这张牌不能在此回应。');
    removeCard(player(state, actorId).hand, cardId);
    emit(state, { type: 'response-played', actorSeatId: actorId, cardId: card.id });
    if (window.kind === 'counter') {
      pending.response = null; completePending(state); discardCards(state, [cardId]); return;
    }
    removeCard(pending.sourceCards, window.tradeCardId); player(state, actorId).hand.push(window.tradeCardId); discardCards(state, [cardId]);
  } else emit(state, { type: 'response-declined', actorSeatId: actorId });
  pending.response = null;
}
function chooseEffect(state, actorId, selection, ctx) {
  requireRule(state.pending?.choice?.actorId === actorId, '当前没有你的选择。');
  if (state.pending.receipt) resolveReceipt(state, selection);
  else if (state.pending.kind === 'character') chooseCharacter(state, selection, ctx);
  else if (state.pending.kind === 'tool') chooseTool(state, selection, ctx);
  else throw new RuleError('请选择当前步骤。');
  emit(state, { type: 'choice-resolved', actorSeatId: actorId });
}

function dispatch(state, actorId, action, ctx) {
  if (state.pending) {
    if (action.type === 'respond') response(state, actorId, action.cardId);
    else if (action.type === 'decline-response') response(state, actorId);
    else if (action.type === 'choose-effect') chooseEffect(state, actorId, action.selection, ctx);
    else if (action.type === 'bid') bid(state, actorId, action.amount, ctx);
    else if (action.type === 'pass-bid') passBid(state, actorId, ctx);
    else if (['keep-peek', 'discard-peek'].includes(action.type) && state.pending.kind === 'peek') {
      const [cardId] = state.pending.poolCards.splice(0);
      if (action.type === 'keep-peek') { player(state, actorId).hand.push(cardId); state.stage = 'use'; }
      else discardCards(state, [cardId]);
      emit(state, { type: action.type === 'keep-peek' ? 'draw-kept' : 'draw-discarded', actorSeatId: actorId,
        ...(action.type === 'discard-peek' ? { cardId: definition(cardId).id } : {}) });
      completePending(state);
    } else throw new RuleError('请先完成当前选择。');
    return;
  }
  const owner = player(state, actorId);
  switch (action.type) {
    case 'peek': {
      requireRule(state.stage === 'draw' && availableCards(state) > 0, '当前没有可看的牌。');
      consumeAction(state); state.drawStarted = true;
      createPending(state, { kind: 'peek', ownerId: actorId, code: 'peek' });
      state.pending.stage = 'decision'; state.pending.poolCards = drawCards(state, 1, ctx);
      emit(state, { type: 'draw-peeked', actorSeatId: actorId }); break;
    }
    case 'finish-draw':
      requireRule(state.stage === 'draw', '已进入用牌阶段。'); state.stage = 'use';
      emit(state, { type: 'draw-finished', actorSeatId: actorId }); break;
    case 'end-turn': endTurn(state, ctx.now, { voluntary: true }); break;
    case 'buy': case 'sell': trade(state, actorId, action.cardId, action.type === 'buy'); break;
    case 'buy-stall': {
      requireUse(state); ownedCard(state, actorId, action.cardId, 'stall_permit');
      requireRule(state.availableStalls > 0, '五块摊位已全部售出。'); const cost = state.purchasedStalls ? 3 : 6;
      addSilver(owner, -cost); consumeAction(state); removeCard(owner.hand, action.cardId); discardCards(state, [action.cardId]);
      owner.stallCount++; state.purchasedStalls++; state.availableStalls--; refreshTemporary(owner);
      emit(state, { type: 'stall-expanded', actorSeatId: actorId, silver: cost, count: owner.stallCount }); break;
    }
    case 'play-character': {
      requireUse(state); const card = ownedCard(state, actorId, action.cardId);
      const issue = characterProblem(state, actorId, action.cardId, action.params); requireRule(!issue, issue);
      consumeAction(state); removeCard(owner.hand, action.cardId);
      emit(state, { type: 'character-played', actorSeatId: actorId, cardId: card.id });
      startCharacter(state, action.cardId, action.params, ctx); break;
    }
    case 'install-tool': {
      requireUse(state); const card = ownedCard(state, actorId, action.cardId, 'tool');
      const replacement = owner.tools.findIndex(tool => tool.cardId === action.replaceCardId);
      requireRule(owner.tools.length < 3 ? action.replaceCardId === undefined : replacement >= 0, '道具区有三格，请先选择要替换的道具。');
      consumeAction(state); if (replacement >= 0) discardCards(state, [owner.tools.splice(replacement, 1)[0].cardId]);
      removeCard(owner.hand, action.cardId); owner.tools.push({ cardId: action.cardId, exhausted: false });
      emit(state, { type: 'tool-installed', actorSeatId: actorId, cardId: card.id }); break;
    }
    case 'activate-tool': {
      const tool = owner.tools.find(item => item.cardId === action.cardId);
      requireRule(tool && !tool.exhausted, '请选择尚未使用的自己的道具。');
      const card = definition(action.cardId); if (card.sourceCode !== 'T07') requireUse(state);
      const issue = toolProblem(state, actorId, action.cardId, action.params); requireRule(!issue, issue);
      consumeAction(state); tool.exhausted = true;
      emit(state, { type: 'tool-activated', actorSeatId: actorId, cardId: card.id });
      startTool(state, action.cardId, action.params, ctx); break;
    }
    default: throw new RuleError('不支持的游戏操作。');
  }
}

function commit(state, ctx, initialTurn) {
  continuePending(state, ctx);
  // The last action cannot bypass a response, payment or material selection.
  if (!state.pending && state.status === 'playing' && state.turnId === initialTurn && state.actionsUsed >= state.actionLimit) endTurn(state, ctx.now);
  state.revision++; state.publicEventSequence++; state.committedAt = ctx.now;
  synchronizeClock(state, ctx.now); check(state); return { ok: true, state };
}
export function applyGameAction(game, actorId, action, ctx = {}) {
  try {
    ensureActive(game, actorId, ctx.now); fence(game, action, actorId);
    requireRule(runningClock(game).deadlineAt > ctx.now, '此步骤已经到时，请等待自动结算。', 'ACTION_EXPIRED');
    const state = structuredClone(game); state.lastPublicEvents = [];
    dispatch(state, actorId, resolveActionReferences(state, action), ctx); return commit(state, ctx, game.turnId);
  } catch (error) { if (error instanceof RuleError) return failure(error); throw error; }
}

function defaultPending(state, ctx) {
  const decision = currentDecision(state);
  requireRule(decision, '超时步骤没有默认选择。', 'INVALID_GAME_STATE');
  if (state.pending.response) response(state, decision.actorId);
  else if (state.pending.kind === 'auction' && state.pending.stage === 'bidding') passBid(state, decision.actorId, ctx);
  else if (state.pending.kind === 'peek') dispatch(state, decision.actorId, { type: 'keep-peek' }, ctx);
  else chooseEffect(state, decision.actorId, structuredClone(state.pending.choice.defaultSelection), ctx);
  continuePending(state, ctx);
}
export function applyTimeout(game, actorId, ctx = {}) {
  try {
    ensureActive(game, actorId, ctx.now);
    const clock = runningClock(game);
    requireRule(clock.actorId === actorId && clock.deadlineAt !== null && ctx.now >= clock.deadlineAt, '当前步骤尚未到时。', 'TIMEOUT_NOT_DUE');
    const state = structuredClone(game); state.lastPublicEvents = [];
    const activeExpired = !game.timing.decision;
    if (activeExpired) { state.timing.active.remainingMs = 0; state.timing.active.deadlineAt = ctx.now; }
    if (state.pending) defaultPending(state, ctx);
    // An opponent receives their own bounded response even when the main clock
    // has run out. Only the expired actor's remaining choices use defaults.
    for (let step = 0; activeExpired && state.pending && currentDecision(state)?.actorId === actorId && step < 250; step++) defaultPending(state, ctx);
    requireRule(!activeExpired || !state.pending || currentDecision(state)?.actorId !== actorId, '超时结算未收敛。', 'INVALID_GAME_STATE');
    if (!state.pending && state.status === 'playing' && (activeExpired || state.timing.active.remainingMs === 0)) endTurn(state, ctx.now);
    return commit(state, ctx, game.turnId);
  } catch (error) { if (error instanceof RuleError) return failure(error); throw error; }
}
