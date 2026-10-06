import test from 'node:test';
import assert from 'node:assert/strict';
import { SIDES, ringIndex } from './board.mjs';
import { legalPlaneIds, previewMove, applyPreview } from './routes.mjs';
import { SCENARIOS } from './fixtures/scenarios.mjs';

const sideIds = SIDES.map(side => side.id);
const planes = (changes = {}) => sideIds.flatMap(side => Array.from({ length: 4 }, (_, index) => {
  const id = `${side}-${index + 1}`;
  return { id, side, number: index + 1, progress: changes[id] ?? -2 };
}));

for (const [index, side] of sideIds.entries()) {
  test(`${side}: six launches one plane only to its private launch point`, () => {
    const before = planes(), snapshot = structuredClone(before);
    assert.deepEqual(legalPlaneIds(before, side, 5), []);
    assert.deepEqual(legalPlaneIds(before, side, 6), [1, 2, 3, 4].map(number => `${side}-${number}`));
    const route = previewMove(before, `${side}-2`, 6);
    assert.equal(route.to, -1);
    assert.deepEqual(route.segments, [{ kind: 'launch', from: -2, to: -1, steps: [-1] }]);
    assert.deepEqual(route.landings, [{ progress: -1, capturedIds: [] }]);
    assert.equal(route.finished, false);
    const after = applyPreview(before, route);
    assert.equal(after.find(plane => plane.id === `${side}-2`).progress, -1);
    assert.equal(after.filter(plane => plane.progress !== -2).length, 1);
    assert.deepEqual(before, snapshot);
    for (const [planeIndex, plane] of before.entries()) assert.notEqual(after[planeIndex], plane);
  });

  test(`${side}: walk to 13 jumps to 17 then flies to 29, with each landing capture`, () => {
    const enemySides = [1, 2, 3].map(offset => sideIds[(index + offset) % 4]);
    const before = planes({
      [`${side}-1`]: 11,
      [`${enemySides[0]}-1`]: 0,
      [`${enemySides[1]}-1`]: 43,
      [`${enemySides[2]}-1`]: 42,
      [`${enemySides[1]}-2`]: 52,
    });
    const route = previewMove(before, `${side}-1`, 2);
    assert.equal(route.to, 29);
    assert.deepEqual(route.segments.map(segment => segment.kind), ['walk', 'jump', 'fly']);
    assert.deepEqual(route.segments[0].steps, [12, 13]);
    assert.deepEqual(route.landings.map(landing => landing.progress), [13, 17, 29]);
    assert.deepEqual(route.landings.map(landing => landing.capturedIds), enemySides.map(enemy => [`${enemy}-1`]));
    const after = applyPreview(before, route);
    enemySides.forEach(enemy => assert.equal(after.find(plane => plane.id === `${enemy}-1`).progress, -2));
    assert.equal(after.find(plane => plane.id === `${enemySides[1]}-2`).progress, 52, 'enemy H3 is safe under the flight line');
    assert.equal(ringIndex(side, route.to), [29, 42, 3, 16][index]);
  });

  test(`${side}: directly landing on 17 flies to 29 then jumps to 33`, () => {
    const enemySides = [1, 2, 3].map(offset => sideIds[(index + offset) % 4]);
    const route = previewMove(planes({
      [`${side}-1`]: 15,
      [`${enemySides[0]}-1`]: 4,
      [`${enemySides[1]}-1`]: 3,
      [`${enemySides[2]}-1`]: 46,
    }), `${side}-1`, 2);
    assert.equal(route.to, 33);
    assert.deepEqual(route.segments.map(segment => segment.kind), ['walk', 'fly', 'jump']);
    assert.deepEqual(route.landings.map(landing => landing.progress), [17, 29, 33]);
    assert.deepEqual(route.capturedIds, enemySides.map(enemy => `${enemy}-1`));
    assert.equal(ringIndex(side, route.to), [33, 46, 7, 20][index]);
  });

  test(`${side}: own-color final ring entrance does not jump into home`, () => {
    const route = previewMove(planes({ [`${side}-1`]: 47 }), `${side}-1`, 2);
    assert.equal(route.to, 49);
    assert.deepEqual(route.segments.map(segment => segment.kind), ['walk']);
    assert.equal(ringIndex(side, route.to), [49, 10, 23, 36][index]);
    const entered = previewMove(planes({ [`${side}-1`]: 49 }), `${side}-1`, 1);
    assert.equal(entered.to, 50);
    assert.deepEqual(entered.capturedIds, []);
  });

  test(`${side}: exact H6 completes, overshooting bounces without completion`, () => {
    const before = planes({ [`${side}-1`]: 53 });
    const exact = previewMove(before, `${side}-1`, 2);
    assert.equal(exact.to, 55);
    assert.equal(exact.finished, true);
    assert.deepEqual(exact.segments[0].steps, [54, 55]);
    const bounced = previewMove(before, `${side}-1`, 4);
    assert.equal(bounced.to, 53);
    assert.equal(bounced.finished, false);
    assert.deepEqual(bounced.segments, [
      { kind: 'walk', from: 53, to: 55, steps: [54, 55] },
      { kind: 'bounce', from: 55, to: 53, steps: [54, 53] },
    ]);
    assert.deepEqual(bounced.landings, [{ progress: 53, capturedIds: [] }]);
    const completed = applyPreview(before, exact);
    assert.equal(previewMove(completed, `${side}-1`, 6), null);
    assert.equal(legalPlaneIds(completed, side, 6).includes(`${side}-1`), false);
  });
}

test('four same-side planes are individually selectable; moving one leaves three stacked', () => {
  const before = planes({ 'red-1': 7, 'red-2': 7, 'red-3': 7, 'red-4': 7 });
  assert.deepEqual(legalPlaneIds(before, 'red', 1), ['red-1', 'red-2', 'red-3', 'red-4']);
  const after = applyPreview(before, previewMove(before, 'red-3', 1));
  assert.deepEqual(after.filter(plane => plane.side === 'red').map(plane => plane.progress), [7, 7, 8, 7]);
});

test('actual landing clears all four enemy planes; crossed enemy planes and friends survive', () => {
  const before = planes({
    'red-1': 6, 'red-2': 8, 'yellow-1': 33,
    'blue-1': 47, 'blue-2': 47, 'blue-3': 47, 'blue-4': 47,
  });
  const route = previewMove(before, 'red-1', 2);
  assert.equal(route.to, 8);
  assert.deepEqual(route.capturedIds, ['blue-1', 'blue-2', 'blue-3', 'blue-4']);
  const after = applyPreview(before, route);
  assert.equal(after.find(plane => plane.id === 'yellow-1').progress, 33);
  assert.equal(after.find(plane => plane.id === 'red-2').progress, 8);
  assert.equal(after.filter(plane => plane.side === 'blue' && plane.progress === -2).length, 4);
});

test('neither walking nor jumping nor flying captures enemies between actual landings', () => {
  const before = planes({
    'red-1': 11, 'yellow-1': 38, 'yellow-2': 41, 'green-1': 36,
  });
  // Valid ring positions: yellow 38=C12 (walk), yellow 41=C15 (jump), green 36=C23 (flight).
  const route = previewMove(before, 'red-1', 2);
  assert.deepEqual(route.capturedIds, []);
  const after = applyPreview(before, route);
  for (const id of ['yellow-1', 'yellow-2', 'green-1']) assert.equal(after.find(plane => plane.id === id).progress, before.find(plane => plane.id === id).progress);
});

test('a different-side shortcut cell does not activate the wrong flight route', () => {
  const route = previewMove(planes({ 'blue-1': 2 }), 'blue-1', 2);
  assert.equal(ringIndex('blue', route.to), 17);
  assert.equal(route.to, 4);
  assert.deepEqual(route.segments.map(segment => segment.kind), ['walk']);
});

test('launch point consumes later ordinary die steps before the first ring cell', () => {
  const one = previewMove(planes({ 'red-1': -1 }), 'red-1', 1);
  assert.equal(one.to, 0);
  assert.deepEqual(one.segments[0].steps, [0]);
  const five = previewMove(planes({ 'red-1': -1 }), 'red-1', 5);
  assert.equal(five.to, 4);
  assert.deepEqual(five.segments[0].steps, [0, 1, 2, 3, 4]);
});

test('a six from H5 bounces back to H1; own-home moves never collide', () => {
  const route = previewMove(planes({ 'red-1': 54, 'yellow-1': 52 }), 'red-1', 6);
  assert.equal(route.to, 50);
  assert.equal(route.finished, false);
  assert.deepEqual(route.segments[1].steps, [54, 53, 52, 51, 50]);
  assert.deepEqual(route.capturedIds, []);
});

test('published full example moves one red plane through launch, jump/flight and exact home', () => {
  let current = planes();
  const observed = [];
  for (const die of [6, 5, 5, 4, 4, 4, 6]) {
    const route = previewMove(current, 'red-1', die);
    observed.push(route.to);
    current = applyPreview(current, route);
  }
  assert.deepEqual(observed, [-1, 4, 13, 33, 41, 49, 55]);
  assert.equal(legalPlaneIds(current, 'red', 5).length, 0);
});

test('all reachable progress values and dice keep one selected plane in bounds without changing identities', () => {
  for (const side of sideIds) for (let progress = -2; progress <= 55; progress++) for (let die = 1; die <= 6; die++) {
    const before = planes({ [`${side}-1`]: progress });
    const snapshot = structuredClone(before);
    const route = previewMove(before, `${side}-1`, die);
    const expectedLegal = progress !== 55 && (progress !== -2 || die === 6);
    assert.equal(Boolean(route), expectedLegal, `${side}, progress ${progress}, die ${die}`);
    if (!route) continue;
    assert.ok(Number.isInteger(route.to) && route.to >= -1 && route.to <= 55);
    assert.equal(route.finished, route.to === 55);
    assert.ok(route.segments.filter(segment => segment.kind === 'jump').length <= 1);
    assert.ok(route.segments.filter(segment => segment.kind === 'fly').length <= 1);
    const after = applyPreview(before, route);
    assert.deepEqual(before, snapshot);
    assert.deepEqual(after.map(({ id, side, number }) => ({ id, side, number })), before.map(({ id, side, number }) => ({ id, side, number })));
    assert.deepEqual(after.filter(plane => plane.id !== route.planeId), before.filter(plane => plane.id !== route.planeId));
  }
});

test('stale or forged previews fail instead of editing another entity or capture list', () => {
  const before = planes({ 'red-1': 6, 'blue-1': 47 });
  const route = previewMove(before, 'red-1', 2);
  assert.throws(() => applyPreview(before, { ...route, to: 55 }), /预览已失效/);
  assert.throws(() => applyPreview(before, { ...route, capturedIds: ['yellow-1'] }), /预览已失效/);
  const changed = planes({ 'red-1': 6, 'blue-1': -2 });
  assert.throws(() => applyPreview(changed, route), /预览已失效/);
  assert.throws(() => applyPreview(before, null), /请先选择/);
  assert.equal(previewMove(before, 'not-a-plane', 2), null);
  assert.equal(previewMove(before, 'red-2', 2), null);
});

test('invalid dice, identities, duplicate numbers and corrupted progress reject explicitly', () => {
  const before = planes();
  for (const die of [0, 7, 1.5, '6', null, undefined]) {
    assert.throws(() => legalPlaneIds(before, 'red', die), RangeError);
    assert.throws(() => previewMove(before, 'red-1', die), RangeError);
  }
  assert.throws(() => legalPlaneIds(before, 'purple', 6), TypeError);
  assert.throws(() => previewMove(null, 'red-1', 6), TypeError);
  assert.throws(() => previewMove([...before, before[0]], 'red-1', 6), TypeError);
  assert.throws(() => previewMove(before.map(plane => plane.id === 'red-2' ? { ...plane, number: 1 } : plane), 'red-1', 6), TypeError);
  for (const progress of [-3, 56, 3.5, '0']) assert.throws(() => previewMove(planes({ 'red-1': progress }), 'red-1', 6), RangeError);
});

test('synthetic scenarios cover roles, pause, 2/3/4 sides and every usable plane with no input mutation', () => {
  assert.equal(new Set(SCENARIOS.map(scenario => scenario.id)).size, SCENARIOS.length);
  assert.ok(SCENARIOS.some(scenario => scenario.role === 'observer'));
  assert.ok(SCENARIOS.some(scenario => scenario.paused));
  assert.deepEqual([...new Set(SCENARIOS.map(scenario => scenario.planes.length))].sort((a, b) => a - b), [8, 12, 16]);
  for (const scenario of SCENARIOS) {
    assert.equal(scenario.planes.length, scenario.participatingSides.length * 4);
    for (const side of scenario.participatingSides) assert.equal(scenario.planes.filter(plane => plane.side === side).length, 4);
    const saved = structuredClone(scenario);
    for (const id of legalPlaneIds(scenario.planes, scenario.side, scenario.die)) applyPreview(scenario.planes, previewMove(scenario.planes, id, scenario.die));
    assert.deepEqual(scenario, saved);
  }
});
