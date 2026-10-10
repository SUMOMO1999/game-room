import { TRAIL_DIE } from '../content/catalog.mjs';
import { GEAR_BEHAVIORS, CANTEEN_BEHAVIORS, DIE_BEHAVIORS } from '../content/behavior-data.mjs';
import { player, createOpportunity, openOpportunities, childrenOf, requireRule, zeroResources, countResources, RESOURCE_KEYS,
  projectActive, ability, passionById, parkById, gearById, canteenById, canteenDefinitionById, ownsBadge, photoAllowed, emit, takeFromMarket, randomFor } from './model.mjs';
import { anyPaymentOptions, typedPaymentOptions, parkCosts, gearCosts, gainPreview, paymentQuote, pay } from './resources.mjs';
import { passionMetric } from './scoring.mjs';

export const currentStep = op => op.program[op.index] ?? null;
export const finishStep = op => { op.index += 1; if (op.index >= op.program.length) op.status = 'complete'; };
export const canteenTargets = state => [...state.markets.canteens.filter(Boolean), ...(state.decks.canteens.length ? ['deck-top'] : [])];
export const parkTargets = state => [...state.markets.parks.filter(Boolean), ...(state.decks.parks.length ? ['deck-top'] : [])];
export const gearTargets = state => [...state.markets.gear.filter(Boolean), ...(state.decks.gear.length ? ['deck-top'] : [])];
export const emptyCanteenSlots = owner => owner.canteenRows.flatMap((row, index) => row.tokens.length < 2 ? [index] : []);
export function goalCheck(state, owner, parentId = null) {
  if (!owner.passionId || owner.passionBranch || openOpportunities(state).some(op => op.kind === 'passion-branch')) return null;
  const passion = passionById.get(owner.passionId);
  if (passionMetric(owner, passion.goal) < passion.goal.minimum) return null;
  return createOpportunity(state, owner.id, owner.passionId, [{ kind: 'passion-branch' }], { mandatory: true, kind: 'passion-branch', started: true, parentId });
}
export function gearHooks(state, owner, event) {
  for (const id of owner.gear) {
    const behavior = GEAR_BEHAVIORS[id], trigger = behavior.trigger;
    if (state.windowUsage.gear.includes(id) || openOpportunities(state).some(op => op.sourceId === id)) continue;
    const eligible = trigger.kind === 'action' ? trigger.event === event
      : event === 'site-arrival' && state.arrivalMode === 'normal' && state.currentSiteId === trigger.siteId && state.decisionWindow.kind === 'turn';
    if (eligible) createOpportunity(state, owner.id, id, behavior.program, { kind: 'gear' });
  }
}
export function passionHook(state, owner, kind, parentId) {
  if (ability(owner, kind) && !state.windowUsage.passion.includes(owner.passionId)) {
    state.windowUsage.passion.push(owner.passionId);
    createOpportunity(state, owner.id, owner.passionId, [{ kind: 'die' }], { mandatory: true, kind: 'passion-bonus', started: true, parentId });
  }
}
function actualGain(state, owner, requested, parentId, sourceId) {
  const output = gainPreview(state, owner, requested);
  const parent = state.opportunities.find(value => value.id === parentId);
  if (parent?.data.paidResourceExchange) parent.data.receivedResourceCount += countResources(output);
  for (const key of RESOURCE_KEYS) {
    state.bankResources[key] -= output[key];
    if (key !== 'water') owner.resources[key] += output[key];
  }
  if (output.sun && projectActive(state, 'water-conservation') && !state.windowUsage.sunChecked) {
    state.windowUsage.sunChecked = true;
    if (owner.resources.water) { owner.resources.water -= 1; state.bankResources.water += 1; emit(state, 'project-water-returned', { actorId: owner.id, sourceId: 'volunteer.water-conservation' }); }
  }
  for (let n = 0; n < output.water; n += 1) createOpportunity(state, owner.id, sourceId, [{ kind: 'new-water' }], {
    mandatory: true, kind: 'new-water', started: true, parentId, data: { heldWater: 1 } });
  emit(state, 'resources-gained', { actorId: owner.id, sourceId, resources: output }); return output;
}
export function gain(state, owner, requested, op) {
  const definition = passionById.get(owner.passionId), replacement = definition?.ability;
  if (ability(owner, 'replaceResourceGain') && requested[replacement.from] > 0 && !state.windowUsage.passion.includes(owner.passionId)
    && state.bankResources.wildlife > 0 && !op.data.replacementChecked) {
    createOpportunity(state, owner.id, owner.passionId, [{ kind: 'gain-replacement' }], { mandatory: true, kind: 'gain-replacement', started: true,
      parentId: op.id, data: { requested: { ...requested }, resource: replacement.from } });
    op.data.replacementChecked = true; return false;
  }
  const chosen = op.data.replacementResources ?? requested;
  actualGain(state, owner, chosen, op.id, op.sourceId);
  delete op.data.replacementChecked; delete op.data.replacementResources; return true;
}
export function parkProgram(definition) {
  const effect = definition.instantEffect;
  if (!effect || effect.type === 'none') return [];
  if (effect.type === 'gain_resources') return [{ kind: 'gain', resources: { ...effect.resources } }];
  if (effect.type === 'gain_canteen') return [{ kind: 'canteen' }];
  if (effect.type === 'take_shutterbug_badge') return [{ kind: 'badge' }];
  if (effect.type === 'roll_trail_die') return Array.from({ length: effect.times }, () => ({ kind: 'die' }));
  throw new Error('未绑定公园奖励。');
}
export function normalizeEffects(state) {
  for (let iteration = 0; iteration < 256; iteration += 1) {
    let changed = false;
    for (const op of openOpportunities(state)) {
      if (!op.started || childrenOf(state, op.id).length || (op.data.blockedBy && openOpportunities(state).some(item => item.id === op.data.blockedBy))) continue;
      const owner = player(state, op.ownerSeatId), step = currentStep(op);
      if (!step) { op.status = 'complete'; changed = true; continue; }
      if (step.kind === 'claim-weather') {
        const resource = op.data.heldWeather; requireRule(resource === step.resource, '天气归属无效。');
        state.bankResources[resource] += 1; op.data.heldWeather = null;
        actualGain(state, owner, { [resource]: 1 }, op.id, op.sourceId); finishStep(op); changed = true;
      } else if (step.kind === 'gain') {
        if (gain(state, owner, step.resources, op)) {
          finishStep(op);
          requireRule(op.status !== 'complete' || !op.data.paidResourceExchange || op.data.receivedResourceCount > 0, '本次付费资源兑换没有可保留的所得。', 'NO_RETAINED_OUTPUT');
        }
        changed = true;
      }
      else if (step.kind === 'badge') { state.shutterbugOwnerId = owner.id; emit(state, 'badge-acquired', { actorId: owner.id, sourceId: op.sourceId }); finishStep(op); changed = true; }
      else if (step.kind === 'light-fire') { owner.campfire = true; emit(state, 'campfire-lit', { actorId: owner.id, sourceId: op.sourceId }); finishStep(op); changed = true; }
      else if (step.kind === 'points') { owner.bonusPoints += step.amount; finishStep(op); changed = true; }
      else if (step.kind === 'free-photo') { if (photoAllowed(state, owner.id)) owner.photos += step.amount; else emit(state, 'benefit-unavailable', { actorId: owner.id, sourceId: op.sourceId, reason: '摄影徽章由他人持有。' }); finishStep(op); changed = true; }
      else if (step.kind === 'free-gear') {
        if (state.decks.gear.length) { const id = state.decks.gear.shift(); owner.gear.push(id); gearHooks(state, owner, 'site-arrival'); emit(state, 'gear-acquired', { actorId: owner.id, targetId: id, purchase: false }); }
        else emit(state, 'benefit-unavailable', { actorId: owner.id, sourceId: op.sourceId, reason: '装备牌堆已空。' });
        finishStep(op); changed = true;
      } else if (step.kind === 'canteen' && (!emptyCanteenSlots(owner).length || !canteenTargets(state).length)) {
        emit(state, 'benefit-unavailable', { actorId: owner.id, sourceId: op.sourceId, reason: '水壶槽已满或库存已空。' }); finishStep(op); changed = true;
      }
    }
    if (!changed) return;
  }
  throw new Error('效果链超出有界步骤。');
}

// Raw choices are concrete, server-computed intents. The UI may edit only the
// declared payment vector; the same resolver checks it again at submission.
export function effectChoices(state, op) {
  if (childrenOf(state, op.id).length || (op.data.blockedBy && openOpportunities(state).some(value => value.id === op.data.blockedBy))) return [];
  const owner = player(state, op.ownerSeatId), step = currentStep(op);
  const make = (type, fields, label, cost = null, result = null) => {
    if (cost?.paymentOptions) {
      cost.discounts ??= [];
      cost.paymentQuotes = (cost.paymentQuotes ?? cost.paymentOptions.map(payment => ({ payment, result })))
        .map(quote => paymentQuote(owner, quote.payment, quote.result));
    }
    return { type, fields, label, cost, result };
  };
  const resolve = (fields, label, cost, result) => make('resolve-opportunity', fields, label, cost, result);
  if (!op.started) {
    if (!['gain', 'claim-weather', 'die', 'badge', 'light-fire', 'points', 'free-photo', 'free-gear'].includes(step?.kind)) return effectChoices(state, { ...op, started: true });
    const resources = step.kind === 'claim-weather' ? { [step.resource]: 1 } : step.resources;
    return [make('use-opportunity', {}, op.kind === 'weather' ? '领取天气' : step.kind === 'die' ? '掷步道骰' : op.kind === 'gear' ? '使用装备' : '领取地点收益', null, resources ? { resources: gainPreview(state, owner, resources) } : { effect: step.kind })];
  }
  if (!step) return [];
  const costModel = (cost, options) => ({ ...cost, available: { ...owner.resources }, recommendedPayment: options[0], paymentOptions: options, wildlifeCanSubstitute: true });
  switch (step.kind) {
    case 'new-water': return [make('allocate-water', { rowIndex: null }, '放入背包', null, { resources: { water: 1 } }),
      ...owner.canteenRows.flatMap((row, rowIndex) => !row.filled && row.tokens.length ? [make('allocate-water', { rowIndex }, `填第${rowIndex + 1}行水壶`, null, { canteenIds: [...row.tokens] })] : [])];
    case 'gain-replacement': return [make('resolve-opportunity', { action: 'replace-gain', choice: 'original' }, '按原资源领取', null, { resources: gainPreview(state, owner, op.data.requested) }),
      ...(state.bankResources.wildlife ? [make('resolve-opportunity', { action: 'replace-gain', choice: 'wildlife' }, '将1枚改为野生动物', null,
        { resources: gainPreview(state, owner, { ...op.data.requested, [op.data.resource]: op.data.requested[op.data.resource] - 1, wildlife: (op.data.requested.wildlife ?? 0) + 1 }) })] : [])];
    case 'passion-branch': { const definition = passionById.get(owner.passionId);
      return ['ability', 'scoring'].map(choice => make('choose-passion', { choice }, choice === 'ability' ? '启用能力' : '选择终局计分', null,
        { targetId: definition.id, choice, nameZh: definition.nameZh, text: choice === 'ability' ? definition.abilityText : definition.scoringText,
          goalText: definition.goalText, abilityText: definition.abilityText, scoringText: definition.scoringText,
          effect: structuredClone(choice === 'ability' ? definition.ability : definition.score) })); }
    case 'starting-passion': return owner.passionCandidates.map(targetId => { const definition = passionById.get(targetId);
      return make('choose-starting-passion', { targetId }, definition.nameZh, null,
        { targetId, nameZh: definition.nameZh, goalText: definition.goalText, abilityText: definition.abilityText, scoringText: definition.scoringText,
          goal: structuredClone(definition.goal), ability: structuredClone(definition.ability), scoring: structuredClone(definition.score) }); });
    case 'teddy-order': return op.data.groups.map(groupId => make('choose-teddy', { groupId }, groupId === 'teddy.amber' ? '先移动橙色Teddy' : '先移动蓝色Teddy'));
    case 'branch': return step.choices.flatMap(choice => {
      const child = { ...op, program: [{ kind: choice }], index: 0 };
      return effectChoices(state, child);
    });
    case 'canteen': return emptyCanteenSlots(owner).flatMap(rowIndex => canteenTargets(state).map(targetId => {
      const definition = targetId === 'deck-top' ? null : canteenDefinitionById.get(canteenById.get(targetId).definitionId);
      return resolve({ action: 'gain-canteen', targetId, rowIndex }, definition ? `取得${definition.nameZh}` : '取得牌堆顶水壶', null,
        { targetId, rowIndex, definitionId: definition?.id ?? null, nameZh: definition?.nameZh ?? null,
          effectText: definition?.shortText ?? '取得后才揭示水壶效果。', program: definition ? structuredClone(CANTEEN_BEHAVIORS[definition.id]) : null });
    }));
    case 'reserve': case 'parks': {
      const choices = [];
      if (!op.data.visitCount) for (const targetId of parkTargets(state)) choices.push(resolve({ action: 'reserve', targetId }, targetId === 'deck-top' ? '从牌堆预订' : `预订${parkById.get(targetId).nameZh}`, null, { targetId }));
      if (step.kind === 'parks') {
        const targets = [...owner.reserved, ...(projectActive(state, 'sustainable-transportation') ? [] : state.markets.parks.filter(Boolean))];
        for (const targetId of targets) for (const compensationResource of projectActive(state, 'carbon-offsetting') ? ['mountain', 'forest'] : ['mountain']) {
          const costs = parkCosts(state, owner, parkById.get(targetId), compensationResource);
          if (costs.options.length) choices.push(resolve({ action: 'visit', targetId, compensationResource, payment: costs.options[0] }, `游览${parkById.get(targetId).nameZh}`, costModel(costs, costs.options), { targetId, points: parkById.get(targetId).points, instant: parkProgram(parkById.get(targetId)) }));
        }
        if (op.data.visitCount) choices.push(make('finish-opportunity', {}, '结束本次公园行动'));
      }
      return choices;
    }
    case 'gear': return gearTargets(state).flatMap(targetId => {
      const definition = targetId === 'deck-top' ? null : gearById.get(targetId), costs = gearCosts(owner, definition?.sunCost ?? 2);
      const behavior = definition ? GEAR_BEHAVIORS[targetId] : null;
      return costs.options.length ? [resolve({ action: 'buy-gear', targetId, payment: costs.options[0] }, definition ? `购买${definition.nameZh}` : '购买牌堆顶装备', costModel(costs, costs.options),
        { targetId, nameZh: definition?.nameZh ?? null, triggerText: definition?.trigger.description ?? null,
          effectText: definition ? definition.effectSteps.join('，') : '购买后才揭示装备效果。', trigger: behavior ? structuredClone(behavior.trigger) : null, program: behavior ? structuredClone(behavior.program) : null })] : [];
    });
    case 'photo': {
      if (!photoAllowed(state, owner.id)) return [];
      const choices = [];
      for (const count of ownsBadge(state, owner.id) && !state.windowUsage.badge ? [1, 2] : [1]) {
        const options = anyPaymentOptions(owner, count);
        if (!options.length) continue;
        for (const wildlifeBoost of ability(owner, 'wildlifePhotoPayment') && !state.windowUsage.passion.includes(owner.passionId) ? [false, true] : [false]) {
          const legal = options.filter(payment => !wildlifeBoost || payment.wildlife > 0);
          if (legal.length) choices.push(resolve({ action: 'take-photo', count, wildlifeBoost, payment: legal[0] }, `拍${count + Number(wildlifeBoost)}张照片`,
            costModel({ printedCost: { anyResource: count }, actualCost: { anyResource: count }, extraCost: zeroResources() }, legal), { photos: count + Number(wildlifeBoost) }));
        }
      }
      return choices;
    }
    case 'trade': { const options = anyPaymentOptions(owner, step.paymentCount).filter(payment => countResources(gainPreview(state, owner, step.resources, payment)) > 0);
      if (!options.length) return [];
      const cost = costModel({ printedCost: { anyResource: step.paymentCount }, actualCost: { anyResource: step.paymentCount }, extraCost: zeroResources() }, options);
      cost.paymentQuotes = options.map(payment => ({ payment: { ...payment }, result: { resources: gainPreview(state, owner, step.resources, payment) } }));
      return [resolve({ action: 'trade', payment: options[0] }, '兑换野生动物', cost, cost.paymentQuotes[0].result)]; }
    case 'gain-choice': {
      const distributions = [];
      function visit(index, left, vector) { if (index === step.choices.length) { if (!left) distributions.push({ ...vector }); return; }
        const key = step.choices[index]; for (let n = 0; n <= left; n += 1) { vector[key] = n; visit(index + 1, left - n, vector); } }
      visit(0, step.amount, zeroResources());
      return distributions.map(resources => resolve({ action: 'choose-gain', resources }, '选择要领取的资源', null, { resources: gainPreview(state, owner, resources) }));
    }
    case 'die': return []; // Stable background step performs the random draw.
    default: return [];
  }
}
export function resolveEffect(state, op, intent) {
  const owner = player(state, op.ownerSeatId); let step = currentStep(op);
  requireRule(step && !childrenOf(state, op.id).length && (!op.data.blockedBy || !openOpportunities(state).some(value => value.id === op.data.blockedBy)), '先完成这张牌产生的必选项。');
  if (intent.type === 'use-opportunity') {
    requireRule(!op.started, '这项收益已经开始。'); op.started = true;
    if (op.kind === 'gear') { requireRule(!state.windowUsage.gear.includes(op.sourceId), '本窗口装备已用。'); state.windowUsage.gear.push(op.sourceId); }
    return;
  }
  const choices = effectChoices(state, op);
  const matching = choices.find(choice => choice.type === intent.type && Object.entries(choice.fields).every(([key, value]) => key === 'payment' || JSON.stringify(intent[key]) === JSON.stringify(value)));
  requireRule(matching, '选择不在当前合法候选中。');
  if (!op.started) {
    op.started = true;
    if (op.kind === 'gear') { requireRule(!state.windowUsage.gear.includes(op.sourceId), '本窗口装备已用。'); state.windowUsage.gear.push(op.sourceId); }
  }
  if (step.kind === 'branch') { op.program.splice(op.index, 1, { kind: intent.action === 'gain-canteen' ? 'canteen' : 'photo' }); step = currentStep(op); }
  if (matching.cost?.paymentOptions) pay(state, owner, intent.payment, matching.cost.paymentOptions);
  if (intent.type === 'allocate-water') {
    requireRule(step.kind === 'new-water' && op.data.heldWater === 1, '这枚新水已经分配。');
    op.data.heldWater = 0; finishStep(op);
    if (intent.rowIndex === null) owner.resources.water += 1;
    else {
      const row = owner.canteenRows[intent.rowIndex]; row.filled = true;
      for (const id of row.tokens) createOpportunity(state, owner.id, id, CANTEEN_BEHAVIORS[canteenById.get(id).definitionId], { kind: 'canteen-effect', parentId: op.parentId, started: true });
      passionHook(state, owner, 'rollDieAfterCanteenRow', op.parentId);
      emit(state, 'canteen-filled', { actorId: owner.id, rowIndex: intent.rowIndex, tokenIds: [...row.tokens] });
    }
  } else if (intent.type === 'choose-passion') { owner.passionBranch = intent.choice; finishStep(op); emit(state, 'passion-completed', { actorId: owner.id, passionId: owner.passionId, branch: owner.passionBranch }); }
  else if (intent.type === 'choose-starting-passion') { owner.passionId = intent.targetId; state.removed.passions.push(...owner.passionCandidates.filter(id => id !== intent.targetId)); owner.passionCandidates = []; finishStep(op); }
  else if (intent.type === 'choose-teddy') { state.teddy.batch.selectedGroup = intent.groupId; finishStep(op); }
  else if (intent.type === 'finish-opportunity') { requireRule(step.kind === 'parks' && op.data.visitCount, '还没有完成本次基础公园行动。'); finishStep(op); delete op.data.visitCount; }
  else switch (intent.action) {
    case 'replace-gain': {
      const parent = state.opportunities.find(value => value.id === op.parentId);
      if (intent.choice === 'wildlife') {
        parent.data.replacementResources = { ...op.data.requested, [op.data.resource]: op.data.requested[op.data.resource] - 1, wildlife: (op.data.requested.wildlife ?? 0) + 1 };
        state.windowUsage.passion.push(owner.passionId);
      }
      finishStep(op); break;
    }
    case 'branch': op.program.splice(op.index, 1, { kind: intent.choice }); break;
    case 'gain-canteen': {
      const id = takeFromMarket(state, 'canteens', intent.targetId, { replenish: true }); owner.canteenRows[intent.rowIndex].tokens.push(id);
      emit(state, 'canteen-acquired', { actorId: owner.id, targetId: id, rowIndex: intent.rowIndex }); finishStep(op); break;
    }
    case 'reserve': { const id = takeFromMarket(state, 'parks', intent.targetId); owner.reserved.push(id); finishStep(op); gearHooks(state, owner, 'reserve-park'); emit(state, 'park-reserved', { actorId: owner.id, targetId: id }); break; }
    case 'visit': {
      const definition = parkById.get(intent.targetId), hadAdventure = ability(owner, 'rollDieAfterInstantPark');
      if (owner.reserved.includes(intent.targetId)) owner.reserved = owner.reserved.filter(id => id !== intent.targetId); else takeFromMarket(state, 'parks', intent.targetId);
      owner.visited.push(intent.targetId); op.data.visitCount = (op.data.visitCount ?? 0) + 1;
      const goal = goalCheck(state, owner, op.id);
      const program = parkProgram(definition);
      if (program.length) createOpportunity(state, owner.id, definition.id, program, { mandatory: true, kind: 'park-instant', parentId: op.id, started: true, data: { blockedBy: goal?.id ?? null } });
      if (hadAdventure && definition.hasInstantAction) passionHook(state, owner, 'rollDieAfterInstantPark', op.id);
      emit(state, 'park-visited', { actorId: owner.id, targetId: definition.id, payment: intent.payment }); break;
    }
    case 'buy-gear': {
      const id = takeFromMarket(state, 'gear', intent.targetId, { replenish: true }); owner.gear.push(id); owner.gearPurchases += 1;
      finishStep(op); goalCheck(state, owner, op.id); gearHooks(state, owner, 'site-arrival');
      emit(state, 'gear-acquired', { actorId: owner.id, targetId: id, purchase: true, payment: intent.payment }); break;
    }
    case 'take-photo': {
      owner.photos += intent.count + Number(intent.wildlifeBoost);
      if (intent.count === 2) state.windowUsage.badge = true;
      if (intent.wildlifeBoost) state.windowUsage.passion.push(owner.passionId);
      if (intent.payment.wildlife) owner.paidPhotoWithWildlife += 1;
      finishStep(op); goalCheck(state, owner, op.id); gearHooks(state, owner, 'paid-photo');
      emit(state, 'photos-taken', { actorId: owner.id, count: intent.count + Number(intent.wildlifeBoost), payment: intent.payment }); break;
    }
    case 'trade': actualGain(state, owner, step.resources, op.id, op.sourceId); finishStep(op); gearHooks(state, owner, step.event); emit(state, 'resources-traded', { actorId: owner.id, payment: intent.payment }); break;
    case 'choose-gain': op.program.splice(op.index, 1, { kind: 'gain', resources: { ...intent.resources } }); break;
    default: throw new Error('未绑定用户效果动作。');
  }
}
export function rollDie(state, op, context) {
  requireRule(op.started && currentStep(op)?.kind === 'die' && !childrenOf(state, op.id).length, '当前不能掷骰。');
  const owner = player(state, op.ownerSeatId), face = TRAIL_DIE[randomFor(state, context)(TRAIL_DIE.length)].face;
  finishStep(op); createOpportunity(state, owner.id, `die.${face}`, DIE_BEHAVIORS[face], { mandatory: true, parentId: op.id, kind: 'die-result', started: true });
  gearHooks(state, owner, 'roll-die'); state.lastDie = { sourceId: op.sourceId, face, actorId: owner.id, windowId: state.decisionWindow.id };
  emit(state, 'die-rolled', { actorId: owner.id, sourceId: op.sourceId, face });
}
