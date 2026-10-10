import { deepFreeze } from './immutable.mjs';
import { OPTIONAL_DATA } from './optional-data.mjs';

// Own typed interpretation of the frozen facts and D01–D11 / M01–M10.
// No display-string parsing or external source-code identifiers at runtime.
const gain = (resource, amount = 1) => ({ kind: 'gain', resources: { [resource]: amount } });
const action = kind => ({ kind });
const sites = ['site.forest', 'site.mountain', 'site.sun', 'site.water'];
const gear = {};
const add = (number, trigger, program) => { gear[`gear.${String(number).padStart(2, '0')}`] = { trigger, program, perWindow: 1 }; };
const onSite = siteId => ({ kind: 'site', siteId });
const onAction = event => ({ kind: 'action', event });
const fourSites = ['site.water', 'site.sun', 'site.forest', 'site.mountain'];
fourSites.forEach((site, index) => {
  add(1 + index, onSite(site), [action('light-fire')]);
  add(5 + index, onSite(site), [action('photo')]);
  add(16 + index, onSite(site), [action('reserve')]);
  add(34 + index, onSite(site), [gain('wildlife')]);
});
add(9, onAction('wildlife-trade'), [action('canteen')]);
add(10, onAction('reserve-park'), [action('canteen')]);
add(11, onAction('wildlife-trade'), [action('photo')]);
add(12, onAction('reserve-park'), [action('photo')]);
add(13, onAction('roll-die'), [action('photo')]);
add(14, onAction('wildlife-trade'), [action('reserve')]);
add(15, onAction('roll-die'), [action('reserve')]);
add(20, onAction('paid-photo'), [action('die')]);
add(21, onAction('wildlife-trade'), [gain('sun', 2)]);
add(22, onAction('paid-photo'), [gain('sun', 2)]);
add(23, onAction('wildlife-trade'), [gain('water', 2)]);
add(24, onAction('paid-photo'), [gain('water', 2)]);
add(25, onAction('reserve-park'), [gain('mountain')]);
add(26, onSite('site.sun'), [gain('mountain')]);
add(27, onSite('site.mountain'), [gain('mountain')]);
add(28, onAction('reserve-park'), [gain('forest')]);
add(29, onSite('site.water'), [gain('forest')]);
add(30, onSite('site.forest'), [gain('forest')]);
add(31, onAction('roll-die'), [action('die')]);
add(32, onSite('site.mountain'), [gain('sun', 2), action('light-fire')]);
add(33, onSite('site.forest'), [gain('sun', 2), action('light-fire')]);
export const GEAR_BEHAVIORS = deepFreeze(gear);

export const CANTEEN_BEHAVIORS = deepFreeze({
  'canteen.mountain': [gain('mountain')], 'canteen.forest': [gain('forest')],
  'canteen.sun': [gain('sun', 2)], 'canteen.parks': [action('parks')],
  'canteen.photo': [action('photo')], 'canteen.wildlife-trade': [{ kind: 'trade', paymentCount: 1, resources: { wildlife: 1 }, event: 'wildlife-trade' }],
});
export const SITE_BEHAVIORS = deepFreeze({
  [sites[0]]: [gain('forest')], [sites[1]]: [gain('mountain')],
  [sites[2]]: [gain('sun', 2)], [sites[3]]: [gain('water', 2)],
  'site.wildlife-trade': [{ kind: 'trade', paymentCount: 1, resources: { wildlife: 1 }, event: 'wildlife-trade' }],
  'site.canteen-or-photo': [{ kind: 'branch', choices: ['canteen', 'photo'] }],
  'site.gear': [action('gear')], 'site.trail-die': [action('die')], 'site.parks': [action('parks')],
});
export const DIE_BEHAVIORS = deepFreeze({
  forest: [gain('forest')], mountain: [gain('mountain')], sun: [gain('sun', 2)],
  water: [gain('water', 2)], wildlife: [gain('wildlife')], canteen: [action('canteen')],
});

export const SEASON_BEHAVIORS = deepFreeze({
  'season.1.1': { metric: { kind: 'backpack', resource: 'sun' }, program: [action('free-gear')] },
  'season.1.2': { metric: { kind: 'backpack', resource: 'water' }, program: [action('canteen')] },
  'season.1.3': { metric: { kind: 'backpack', resource: 'forest' }, program: [action('reserve')] },
  'season.1.4': { metric: { kind: 'backpack', resource: 'mountain' }, program: [{ kind: 'free-photo', amount: 1 }] },
  'season.2.1': { metric: { kind: 'gear-sun-total' }, program: [action('die'), action('die')] },
  'season.2.2': { metric: { kind: 'backpack', resource: 'wildlife' }, program: [action('die'), action('die')] },
  'season.2.3': { metric: { kind: 'canteen-count' }, program: [action('die'), action('die')] },
  'season.2.4': { metric: { kind: 'instant-park-count' }, program: [action('die'), action('die')] },
  'season.3.1': { metric: { kind: 'printed-park-total', resource: 'sun' }, program: [{ kind: 'points', amount: 3 }] },
  'season.3.2': { metric: { kind: 'printed-park-total', resource: 'forest' }, program: [{ kind: 'points', amount: 3 }] },
  'season.3.3': { metric: { kind: 'printed-park-total', resource: 'mountain' }, program: [{ kind: 'points', amount: 3 }] },
  'season.3.4': { metric: { kind: 'printed-park-total', resource: 'water' }, program: [{ kind: 'points', amount: 3 }] },
});

function campingStep(step) {
  switch (step.type) {
    case 'gain_resource': return gain(step.resource, step.amount);
    case 'gain_canteen': return action('canteen');
    case 'buy_gear': return action('gear');
    case 'parks_action': return action('parks');
    case 'take_photo': return action('photo');
    case 'take_shutterbug_badge': return action('badge');
    case 'roll_trail_die': return Array.from({ length: step.times }, () => action('die'));
    case 'choose_resource': return { kind: 'gain-choice', choices: [...step.choices], amount: step.amount };
    case 'gain_any_resources': return { kind: 'gain-choice', choices: [...step.allowedResources], amount: step.amount };
    case 'trade_resources': return { kind: 'trade', paymentCount: step.payment.anyResource, resources: { ...step.gain }, event: 'wildlife-trade' };
    default: throw new Error('未绑定露营行为。');
  }
}
export const CAMPING_BEHAVIORS = deepFreeze(Object.fromEntries(OPTIONAL_DATA.camping.faces.flatMap(face => face.slots.map(slot => [slot.id, {
  outerCost: slot.outerCost.type === 'none' ? { kind: 'none' }
    : slot.outerCost.type === 'spend_photo' ? { kind: 'photo', amount: slot.outerCost.amount }
      : { kind: 'resource', resource: slot.outerCost.resource, amount: slot.outerCost.amount },
  program: slot.effectSteps.flatMap(campingStep),
}]))));

export const PROJECT_BEHAVIORS = deepFreeze({
  'volunteer.water-conservation': { kind: 'lose-water-on-sun', perWindow: 1 },
  'volunteer.wildlife-conservation': { kind: 'wildlife-cap', maximum: 1 },
  'volunteer.sustainable-transportation': { kind: 'reserved-parks-only' },
  'volunteer.responsible-consumption': { kind: 'capacity-per-gear-purchase', base: 12, decrement: 1, minimum: 0 },
  'volunteer.environmental-studies': { kind: 'badge-required-for-photos' },
  'volunteer.climate-action': { kind: 'no-sun-weather' },
  'volunteer.reduce-emissions': { kind: 'exclude-low-printed-parks', points: [2, 3] },
  'volunteer.leave-no-trace': { kind: 'extinguished-at-season-start' },
  'volunteer.carbon-offsetting': { kind: 'extra-park-payment', choices: ['mountain', 'forest'], amount: 1, wildlifeSubstitution: true },
});

export const BEHAVIOR_COUNTS = deepFreeze({ gear: Object.keys(GEAR_BEHAVIORS).length, canteens: Object.keys(CANTEEN_BEHAVIORS).length,
  sites: Object.keys(SITE_BEHAVIORS).length, seasons: Object.keys(SEASON_BEHAVIORS).length,
  campingSlots: Object.keys(CAMPING_BEHAVIORS).length, projects: Object.keys(PROJECT_BEHAVIORS).length, die: Object.keys(DIE_BEHAVIORS).length });
