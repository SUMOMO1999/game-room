import { parkById } from './rules/model.mjs';
// The bot receives exactly a participant's projection. No authoritative deck,
// other player's draft or future campsite is reachable through this API.
export function chooseParksPracticeAction(view) {
  if (!view || !Array.isArray(view.legalActions) || !view.selfId) return null;
  const self = view.players.find(owner => owner.id === view.selfId);
  const actions = view.legalActions.filter(action => !action.disabledReason);
  if (!actions.length) return null;
  function score(action) {
    const fields = action.fields;
    if (action.type === 'choose-starting-passion') return 100 + ({ 'passion.birdwatching': 8, 'passion.kayaking': 7, 'passion.collecting': 6 }[fields.targetId] ?? 0);
    if (action.type === 'choose-passion') return fields.choice === (view.season.index < 2 ? 'ability' : 'scoring') ? 100 : 90;
    if (action.type === 'choose-teddy') return 100;
    if (action.type === 'move-hiker') {
      const hiker = view.hikers.find(value => value.id === fields.hikerId), site = view.trail.find(value => value.position === fields.position);
      const distance = fields.position - hiker.position;
      let value = 25 - distance * 1.8;
      if (fields.position === 10) value += fields.endSlot === 'parks' ? 5 : fields.endSlot === 'photo' ? 2 : 1;
      if (fields.arrivalMode === 'camping') value += 2;
      if (site?.weather) value += 2;
      if (site?.shutterbug) value += 3;
      if (site?.siteId === 'site.parks') value += view.markets.parks.some(id => id && parkById.get(id).points >= 4) ? 7 : 2;
      if (site?.siteId === 'site.gear') value += 3;
      if (site?.siteId === 'site.water') value += self.resources.water < 3 ? 5 : 1;
      if (site?.siteId === 'site.sun') value += self.resources.sun < 3 ? 5 : 1;
      if (['site.forest', 'site.mountain'].includes(site?.siteId)) value += 4;
      return value;
    }
    if (action.type === 'allocate-water') {
      if (fields.rowIndex === null) return self.resources.water < 3 ? 45 : 20;
      const row = self.canteenRows[fields.rowIndex]; return 35 + row.tokens.length * 3;
    }
    if (action.type === 'resolve-opportunity') {
      if (fields.action === 'visit') return 80 + parkById.get(fields.targetId).points * 2;
      if (fields.action === 'buy-gear') return 65 - (action.cost?.actualCost?.sun ?? 0);
      if (fields.action === 'reserve') return 35 + (parkById.get(fields.targetId)?.points ?? 0);
      if (fields.action === 'take-photo') return 65 + action.result.photos;
      if (fields.action === 'gain-canteen') return 60 + Number(self.canteenRows[fields.rowIndex].tokens.length === 1);
      if (fields.action === 'trade') return 60 - (fields.payment.wildlife ?? 0) * 20;
      if (fields.action === 'choose-gain') return 60 + Object.entries(fields.resources).reduce((sum, [key, count]) => sum + count * (key === 'wildlife' ? 5 : self.resources[key] < 2 ? 4 : 1), 0);
      if (fields.action === 'replace-gain') return fields.choice === 'wildlife' ? 70 : 60;
      if (fields.action === 'branch') return fields.choice === (self.canteenRows.flatMap(row => row.tokens).length < 4 ? 'canteen' : 'photo') ? 60 : 50;
    }
    if (action.type === 'use-opportunity') return action.sourceId?.startsWith('weather.') ? 90 : 70;
    if (action.type === 'discard-resources') return 20;
    if (action.type === 'finish-window') return 0;
    return -10;
  }
  return structuredClone(actions.map((action, index) => ({ action, index, score: score(action) })).sort((a, b) => b.score - a.score || a.index - b.index)[0].action.fields);
}
