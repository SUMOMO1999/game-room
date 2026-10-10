import { SITE_BEHAVIORS, CAMPING_BEHAVIORS } from '../content/behavior-data.mjs';
import { allHikers, activeControllers } from './flow.mjs';
import { player, createOpportunity, openOpportunities, childrenOf, requireRule, RuleError, zeroResources, countResources, projectActive, emit } from './model.mjs';
import { typedPaymentOptions, paymentQuote, pay } from './resources.mjs';
import { currentStep, normalizeEffects, effectChoices, resolveEffect, finishStep, gearHooks } from './effects.mjs';

function plannerKey(state) {
  return JSON.stringify([state.players.map(p => [p.resources, p.canteenRows, p.gear, p.reserved, p.visited, p.passionBranch]), state.bankResources,
    state.markets, state.decks.parks.length, state.decks.gear.length, state.decks.canteens.length, state.shutterbugOwnerId, state.windowUsage,
    state.opportunities.map(op => [op.sourceId, op.status, op.index, op.started, op.data, op.parentId]),
    state.plannerUnknownParks, state.plannerUnknownGear, state.plannerUnknownCanteens]);
}
// Find a certain complete route for the outstanding core obligations. This is
// an existence check, not a bot or a promised random outcome. Unknown dice are
// assigned no gains and the possible mandatory water loss before future costs.
export function canCompleteMandatory(input, ownerId, { budget = 2400 } = {}) {
  const seen = new Set(); let remaining = budget;
  function visit(state) {
    if (--remaining < 0) return false;
    const unknownCanteens = state.plannerUnknownCanteens ?? [], unknownGear = state.plannerUnknownGear ?? [];
    for (const op of openOpportunities(state)) if ((op.kind === 'canteen-effect' && unknownCanteens.includes(op.sourceId)) || (op.kind === 'gear' && unknownGear.includes(op.sourceId))) op.status = 'forgone';
    const priorGear = new Set(player(state, ownerId).gear);
    try { normalizeEffects(state); }
    catch (error) { if (!(error instanceof RuleError)) throw error; return false; }
    state.plannerUnknownGear = [...unknownGear, ...player(state, ownerId).gear.filter(id => !priorGear.has(id))];
    for (const op of openOpportunities(state)) if (op.kind === 'gear' && state.plannerUnknownGear.includes(op.sourceId)) op.status = 'forgone';
    const required = openOpportunities(state).filter(op => op.ownerSeatId === ownerId && op.mandatory);
    if (!required.length) return true;
    const key = plannerKey(state); if (seen.has(key)) return false; seen.add(key);
    const candidates = openOpportunities(state).filter(op => op.ownerSeatId === ownerId && !childrenOf(state, op.id).length);
    for (const op of candidates.sort((a, b) => Number(b.mandatory) - Number(a.mandatory))) {
      const step = currentStep(op);
      if (step?.kind === 'die') {
        // Optional random actions may not be assumed to fund the base action.
        if (!op.mandatory) continue;
        const next = structuredClone(state), copied = next.opportunities.find(value => value.id === op.id), owner = player(next, ownerId);
        if (projectActive(next, 'water-conservation') && !next.windowUsage.sunChecked && next.bankResources.sun > 0) {
          next.windowUsage.sunChecked = true;
          if (owner.resources.water) { owner.resources.water -= 1; next.bankResources.water += 1; }
        }
        copied.started = true; finishStep(copied); if (visit(next)) return true; continue;
      }
      // Starting a certain gear chain can supply core payment; paid optional
      // action chains are permitted only through the same real resolver.
      for (const choice of effectChoices(state, op)) {
        if (choice.fields.action === 'visit' && (state.plannerUnknownParks ?? []).includes(choice.fields.targetId)) continue;
        const payments = choice.cost?.paymentOptions ?? [null];
        for (const payment of payments) {
          const next = structuredClone(state), copied = next.opportunities.find(value => value.id === op.id);
          try {
            const before = player(next, ownerId), oldIds = new Set([...before.gear, ...before.reserved, ...before.canteenRows.flatMap(row => row.tokens)]);
            resolveEffect(next, copied, { type: choice.type, ...choice.fields, ...(payment ? { payment } : {}) });
            if (choice.fields.targetId === 'deck-top') {
              const after = player(next, ownerId), property = { 'buy-gear': 'plannerUnknownGear', 'gain-canteen': 'plannerUnknownCanteens', reserve: 'plannerUnknownParks' }[choice.fields.action];
              if (property) next[property] = [...(next[property] ?? []), ...[...after.gear, ...after.reserved, ...after.canteenRows.flatMap(row => row.tokens)].filter(id => !oldIds.has(id))];
            }
          }
          catch (error) { if (!(error instanceof RuleError)) throw error; continue; }
          if (visit(next)) return true;
        }
      }
    }
    return false;
  }
  return visit(structuredClone(input));
}
export function arrival(state, ownerId, intent) {
  const owner = player(state, ownerId), hiker = owner.hikers.find(value => value.id === intent.hikerId);
  requireRule(hiker && hiker.position < 10 && Number.isSafeInteger(intent.position) && intent.position > hiker.position && intent.position <= 10, '必须选择自己的在途棋子向前移动。');
  requireRule(activeControllers(state).length !== 1 || intent.position === 10, '最后一位在途控制者必须直接去终点。');
  requireRule(['normal', 'camping'].includes(intent.arrivalMode), '请选择普通停靠或露营。');
  if (intent.position === 10) requireRule(['parks', 'photo', 'gear'].includes(intent.endSlot) && intent.arrivalMode === 'normal', '请选择一个终点行动。');
  else {
    requireRule(intent.endSlot === null, '途中不能选择终点行动。');
    const occupied = allHikers(state).some(value => value.id !== hiker.id && value.position === intent.position);
    requireRule(!occupied || owner.campfire, '该位置已有棋子，需要已点燃的营火。');
    if (occupied) owner.campfire = false;
  }
  const site = intent.position < 10 ? state.trail[intent.position - 1] : null;
  hiker.position = intent.position; hiker.endSlot = intent.endSlot;
  state.stage = 'resolve'; state.currentSiteId = site?.siteId ?? null; state.arrivalMode = intent.arrivalMode;
  if (intent.arrivalMode === 'camping') {
    requireRule(state.configuration.camping && site, '本局没有可用露营。');
    const tent = state.camping.tents.find(value => value.position === intent.position && value.slotId === null);
    const faceId = state.camping.seasonBoards[state.seasonIndex].faceId;
    requireRule(tent && intent.campingSlotId?.startsWith(`${faceId}.slot.`) && CAMPING_BEHAVIORS[intent.campingSlotId]
      && !state.camping.tents.some(value => value.slotId === intent.campingSlotId), '帐篷或营地已被使用。');
    const behavior = CAMPING_BEHAVIORS[intent.campingSlotId], cost = behavior.outerCost;
    if (cost.kind === 'resource') pay(state, owner, intent.payment, typedPaymentOptions(owner, { [cost.resource]: cost.amount }, { wildlifeSubstitution: false }));
    else { requireRule(countResources(intent.payment) === 0, '此营地不收资源费用。'); if (cost.kind === 'photo') { requireRule(owner.photos >= cost.amount, '照片不足。'); owner.photos -= cost.amount; } }
    tent.position = null; tent.slotId = intent.campingSlotId;
    const paidResourceExchange = cost.kind !== 'none' && behavior.program.every(step => ['gain', 'gain-choice'].includes(step.kind));
    createOpportunity(state, ownerId, intent.campingSlotId, behavior.program, { mandatory: true, kind: 'base',
      data: paidResourceExchange ? { paidResourceExchange: true, receivedResourceCount: 0 } : {} });
  } else {
    requireRule(intent.campingSlotId === null && countResources(intent.payment) === 0, '普通停靠没有露营费用。');
    if (site?.weather) {
      // The token remains owned by this opportunity until claimed. It is not
      // simultaneously available in the bank or in the player's backpack.
      const resource = site.weather; site.weather = null;
      createOpportunity(state, ownerId, `weather.${intent.position}`, [{ kind: 'claim-weather', resource }], { kind: 'weather', data: { heldWeather: resource } });
    }
    if (site?.siteId === state.shutterbugSiteId) state.shutterbugOwnerId = ownerId;
    if (intent.position === 10 && !state.endRewards[intent.endSlot]) {
      state.endRewards[intent.endSlot] = true;
      if (intent.endSlot === 'parks') state.firstPlayerId = ownerId;
      else createOpportunity(state, ownerId, `end-bonus.${intent.endSlot}`, [{ kind: 'gain', resources: { [intent.endSlot === 'photo' ? 'wildlife' : 'sun']: 1 } }], { kind: 'end-bonus' });
    }
    const program = intent.position === 10 ? [{ kind: intent.endSlot }] : SITE_BEHAVIORS[site.siteId];
    createOpportunity(state, ownerId, site?.siteId ?? `end.${intent.endSlot}`, program, { mandatory: true, kind: 'base' });
    gearHooks(state, owner, 'site-arrival');
  }
  emit(state, 'hiker-moved', { actorId: ownerId, hikerId: hiker.id, position: hiker.position, endSlot: hiker.endSlot, arrivalMode: intent.arrivalMode, campingSlotId: intent.campingSlotId });
}
export function moveChoices(state, ownerId) {
  const owner = player(state, ownerId), candidates = [], fallback = [];
  const preview = (next, fields) => {
    const site = state.trail.find(value => value.position === fields.position);
    const base = openOpportunities(next).find(op => op.kind === 'base');
    return { position: fields.position, siteId: site?.siteId ?? null, endSlot: fields.endSlot,
      arrivalMode: fields.arrivalMode, campfireUsed: owner.campfire && !player(next, ownerId).campfire,
      weather: fields.arrivalMode === 'normal' ? site?.weather ?? null : null,
      campingSlotId: fields.campingSlotId, program: structuredClone(base?.program ?? []),
      firstArrivalReward: fields.position === 10 && !state.endRewards[fields.endSlot] ? fields.endSlot : null };
  };
  for (const hiker of owner.hikers.filter(value => value.position < 10)) {
    for (let position = hiker.position + 1; position <= 10; position += 1) {
      if (activeControllers(state).length === 1 && position !== 10) continue;
      for (const endSlot of position === 10 ? ['parks', 'photo', 'gear'] : [null]) {
        const fields = { hikerId: hiker.id, position, endSlot, arrivalMode: 'normal', campingSlotId: null, payment: zeroResources() };
        const next = structuredClone(state);
        try { arrival(next, ownerId, fields); }
        catch (error) { if (!(error instanceof RuleError)) throw error; continue; }
        if (position === 10) fallback.push({ fields, result: preview(next, fields) });
        if (canCompleteMandatory(next, ownerId)) candidates.push({ type: 'move-hiker', fields, label: position === 10 ? `前往${{ parks: '公园', photo: '摄影', gear: '装备' }[endSlot]}终点` : `前往第${position}站`, sourceId: hiker.id, result: preview(next, fields) });
      }
      if (position === 10 || !state.configuration.camping) continue;
      const face = state.camping.seasonBoards[state.seasonIndex].faceId;
      for (const campingSlotId of [1, 2, 3, 4].map(number => `${face}.slot.${number}`)) {
        const behavior = CAMPING_BEHAVIORS[campingSlotId], cost = behavior.outerCost;
        const payments = cost.kind === 'resource' ? typedPaymentOptions(owner, { [cost.resource]: cost.amount }, { wildlifeSubstitution: false }) : [zeroResources()];
        for (const payment of payments) {
          const fields = { hikerId: hiker.id, position, endSlot: null, arrivalMode: 'camping', campingSlotId, payment };
          const next = structuredClone(state);
          try { arrival(next, ownerId, fields); if (!canCompleteMandatory(next, ownerId)) continue; }
          catch (error) { if (!(error instanceof RuleError)) throw error; continue; }
          const result = preview(next, fields), quote = paymentQuote(owner, payment, result);
          if (cost.kind === 'photo') quote.remainingPhotos = owner.photos - cost.amount;
          candidates.push({ type: 'move-hiker', fields, label: '前往露营地', sourceId: hiker.id,
            cost: { printedCost: cost, actualCost: cost, extraCost: zeroResources(), discounts: [], recommendedPayment: payment,
              paymentOptions: [payment], paymentQuotes: [quote], available: { ...owner.resources }, availablePhotos: owner.photos, wildlifeCanSubstitute: false }, result });
        }
      }
    }
  }
  if (candidates.length) return candidates;
  return fallback.map(({ fields, result }) => ({ type: 'move-hiker', fields, label: '没有可执行行动，前往终点', sourceId: fields.hikerId, result: { ...result, fallback: true } }));
}
