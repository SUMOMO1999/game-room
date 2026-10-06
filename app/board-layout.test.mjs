import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBoard } from './board-layout.mjs';

test('a normal 15-tile table remains full-size when its five groups and new target fit', () => {
  // 5 * 122 + 90 + 5 * 38 = 890px wide; one row is 72px high.
  assert.deepEqual(fitBoard([3, 3, 3, 3, 3], { width: 890, height: 72 }), {
    scale: 1, rows: 1, overflow: false, contentHeight: 72,
  });
  const lengths = [3, 3, 3, 3, 3];
  const before = [...lengths];
  fitBoard(lengths, { width: 600, height: 100 });
  assert.deepEqual(lengths, before, 'layout calculation must not mutate a draft');
});

test('scan picks the largest fitting .02 step rather than prematurely shrinking the table', () => {
  // At .84 the two rows occupy 152.88px; at .82 they occupy 149.24px.
  assert.deepEqual(fitBoard([3, 3, 3, 3, 3], { width: 700, height: 150 }), {
    scale: 0.82, rows: 2, overflow: false, contentHeight: 149.24,
  });
  const largerStep = fitBoard([3, 3, 3, 3, 3], { width: 700, height: 152.88 });
  assert.equal(largerStep.scale, 0.84);
});

test('a dense 106-tile table fits through whole-group wrapping and automatic reduction', () => {
  const groups = [...Array(34).fill(3), 4];
  assert.equal(groups.reduce((sum, count) => sum + count, 0), 106);
  const result = fitBoard(groups, { width: 780, height: 180 });
  assert.deepEqual(result, { scale: 0.4, rows: 3, overflow: false, contentHeight: 140.8 });
  assert.equal(fitBoard(groups, { width: 780, height: 194.96 }).scale, 0.42);
});

test('a dense 159-tile legacy table reports its overview limit while retaining all 53 groups and a minimum 44px target', () => {
  const groups = Array(53).fill(3);
  const result = fitBoard(groups, { width: 780, height: 180 });
  assert.deepEqual(result, { scale: 0.4, rows: 5, overflow: true, contentHeight: 237.6 });
  // Four ordinary rows: 33.2 each. Last row height is 44, with four 15.2px gaps.
  assert.ok(Math.abs(result.contentHeight - (4 * 33.2 + 44 + 4 * 15.2)) < 1e-7);
});

test('a 13-tile run remains one unbroken group and width alone can require shrinking', () => {
  // Base width: 13 * 38 + 12 * 4 = 542px. .68 is too wide for 360px.
  assert.deepEqual(fitBoard([13], { width: 360, height: 150 }), {
    scale: 0.66, rows: 2, overflow: false, contentHeight: 121.64,
  });
  assert.deepEqual(fitBoard([13], { width: 350, height: 100 }), {
    scale: 0.52, rows: 1, overflow: false, contentHeight: 44,
  });
});

test('small groups use the 80*scale width floor and exact row gaps', () => {
  // A one-tile draft occupies 80px, followed by 38px and a 90px new target.
  assert.deepEqual(fitBoard([1], { width: 208, height: 72 }), {
    scale: 1, rows: 1, overflow: false, contentHeight: 72,
  });
  assert.deepEqual(fitBoard([1], { width: 100, height: 182, large: true }), {
    scale: 1, rows: 2, overflow: false, contentHeight: 182,
  });
});

test('the fixed 10px small-scale header is used below .7', () => {
  assert.deepEqual(fitBoard([13, 13, 13], { width: 700, height: 160 }), {
    scale: 0.62, rows: 2, overflow: false, contentHeight: 115.48,
  });
});

test('extremely small viewports stop at .4 and report width/height overflow for scroll fallback', () => {
  assert.deepEqual(fitBoard([3], { width: 30, height: 25 }), {
    scale: 0.4, rows: 2, overflow: true, contentHeight: 92.4,
  });
  assert.deepEqual(fitBoard([3], { width: 100, height: 20 }), {
    scale: 0.4, rows: 2, overflow: true, contentHeight: 92.4,
  });
  const longRun = fitBoard([13], { width: 100, height: 500 });
  assert.equal(longRun.scale, 0.4);
  assert.equal(longRun.overflow, true, 'one oversized whole group still needs horizontal scrolling');
});

test('large mode never shrinks and exposes overflow independently of normal auto fitting', () => {
  const groups = Array(53).fill(3);
  const options = { width: 780, height: 180, large: true };
  const first = fitBoard(groups, options);
  assert.deepEqual(first, { scale: 1, rows: 11, overflow: true, contentHeight: 1172 });
  assert.deepEqual(fitBoard(groups, options), first, 'same geometry remains stable across renders');
  assert.equal(fitBoard(groups, { width: 1200, height: 800, large: true }).scale, 1);
  assert.ok(fitBoard(groups, { width: 780, height: 180 }).scale < first.scale);
});

test('empty tables keep scale 1 and account for the new-meld target', () => {
  assert.deepEqual(fitBoard([], { width: 90, height: 72 }), {
    scale: 1, rows: 1, overflow: false, contentHeight: 72,
  });
  assert.deepEqual(fitBoard([], { width: 20, height: 20 }), {
    scale: 1, rows: 1, overflow: true, contentHeight: 72,
  });
});

test('invalid or hidden-container dimensions never yield NaN or negative layout sizes', () => {
  for (const options of [null, {}, { width: 0, height: 0 }, { width: -1, height: -20 },
    { width: NaN, height: Infinity }, { width: '780', height: 180 }]) {
    const result = fitBoard([3, 13], options);
    assert.equal(result.scale, 0.4);
    assert.equal(result.overflow, true);
    assert.ok(Number.isFinite(result.contentHeight) && result.contentHeight > 0);
    assert.ok(Number.isInteger(result.rows) && result.rows > 0);
  }
  assert.deepEqual(fitBoard([0, -1, NaN, Infinity, 3.5, '3'], { width: 90, height: 72 }),
    fitBoard([], { width: 90, height: 72 }));
  assert.equal(fitBoard(undefined, { width: 90, height: 72 }).scale, 1);
});
