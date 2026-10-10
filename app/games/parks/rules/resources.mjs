import { RESOURCE_KEYS, zeroResources, countResources, validResources, requireRule, projectActive, ability, passionById } from './model.mjs';

export function anyPaymentOptions(owner, amount) {
  const options = [];
  function visit(index, left, payment) {
    if (index === RESOURCE_KEYS.length) { if (!left) options.push({ ...payment }); return; }
    const key = RESOURCE_KEYS[index];
    for (let count = 0; count <= Math.min(left, owner.resources[key]); count += 1) { payment[key] = count; visit(index + 1, left - count, payment); }
  }
  visit(0, amount, zeroResources());
  return options.sort((a, b) => a.wildlife - b.wildlife);
}
export function typedPaymentOptions(owner, cost, { wildlifeSubstitution = true } = {}) {
  const required = { ...zeroResources(), ...cost }, options = [];
  if (owner.resources.wildlife < required.wildlife) return options;
  function visit(index, substituted, payment) {
    if (index === 4) { payment.wildlife = required.wildlife + substituted;
      if (payment.wildlife <= owner.resources.wildlife) options.push({ ...payment }); return; }
    const key = RESOURCE_KEYS[index], minimum = wildlifeSubstitution ? 0 : required[key];
    for (let paid = minimum; paid <= Math.min(required[key], owner.resources[key]); paid += 1) {
      payment[key] = paid; visit(index + 1, substituted + required[key] - paid, payment);
    }
  }
  visit(0, 0, zeroResources()); return options.sort((a, b) => a.wildlife - b.wildlife);
}
export const samePayment = (a, b) => validResources(a) && RESOURCE_KEYS.every(key => a[key] === b[key]);
// This is the balance immediately after paying, before any new gains or water
// allocation. Consumers display it directly rather than applying rules again.
export function paymentQuote(owner, payment, result) {
  return { payment: { ...payment }, remainingResources: Object.fromEntries(RESOURCE_KEYS.map(key => [key, owner.resources[key] - payment[key]])), result: structuredClone(result) };
}
export function pay(state, owner, payment, options) {
  requireRule(validResources(payment) && options.some(option => samePayment(payment, option)), '请选择足额且合法的支付组合。', 'INVALID_PAYMENT');
  for (const key of RESOURCE_KEYS) { owner.resources[key] -= payment[key]; state.bankResources[key] += payment[key]; }
}
export function parkCosts(state, owner, definition, compensationResource = 'mountain') {
  const printedCost = { ...definition.cost }, actualCost = { ...printedCost };
  const passion = passionById.get(owner.passionId);
  const discounts = [];
  if (ability(owner, 'parkDiscount') && actualCost[passion.ability.resource] > 0) {
    actualCost[passion.ability.resource] -= 1;
    discounts.push({ sourceId: passion.id, label: passion.nameZh, resources: { ...zeroResources(), [passion.ability.resource]: 1 } });
  }
  const extraCost = zeroResources();
  if (projectActive(state, 'carbon-offsetting')) { requireRule(['mountain', 'forest'].includes(compensationResource), '请选择山或森林作为碳补偿。'); extraCost[compensationResource] = 1; actualCost[compensationResource] += 1; }
  return { printedCost, actualCost, extraCost, discounts, options: typedPaymentOptions(owner, actualCost) };
}
export function gearCosts(owner, printedSunCost) {
  const actualCost = zeroResources(); actualCost.sun = ability(owner, 'freeGearPurchase') ? 0 : printedSunCost;
  const passion = passionById.get(owner.passionId);
  const discounts = actualCost.sun < printedSunCost ? [{ sourceId: passion.id, label: passion.nameZh, resources: { ...zeroResources(), sun: printedSunCost } }] : [];
  return { printedCost: { ...zeroResources(), sun: printedSunCost }, actualCost, extraCost: zeroResources(), discounts, options: typedPaymentOptions(owner, actualCost) };
}
export function gainPreview(state, owner, requested, payment = zeroResources()) {
  const output = zeroResources();
  for (const key of RESOURCE_KEYS) output[key] = Math.min(requested[key] ?? 0, state.bankResources[key] + payment[key]);
  if (projectActive(state, 'wildlife-conservation')) output.wildlife = Math.min(output.wildlife, Math.max(0, 1 - owner.resources.wildlife + payment.wildlife));
  return output;
}
export const canGainAnything = (state, owner, requested, payment) => countResources(gainPreview(state, owner, requested, payment)) > 0;
