import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOARD_VERSION, ART_VERSION, SIDES, RING_CELLS, HOME_CELLS,
  LAUNCH_CELLS, HANGAR_CELLS, boardPosition, ringIndex } from './board.mjs';
import { boardSvg, dieSvg } from './art.mjs';

const sample = readFileSync(new URL('../../../docs/assets/samples/flying-chess-step0.svg', import.meta.url), 'utf8');
const plane = (side, number, progress) => ({ id: `${side}-${number}`, side, number, progress });

test('board geometry preserves all independently reviewed Step 0 ring and home coordinates', () => {
  const ringSample = [...sample.matchAll(/data-track-id="(C\d{2})" data-x="(\d+)" data-y="(\d+)"/g)]
    .map(([, id, x, y]) => ({ id, x: Number(x), y: Number(y) }));
  assert.equal(ringSample.length, 52);
  assert.deepEqual(RING_CELLS.map(({ id, x, y }) => ({ id, x, y })), ringSample);
  const homes = [...sample.matchAll(/data-home-id="([0-3])-H([1-6])" data-x="(\d+)" data-y="(\d+)"/g)]
    .map(([, side, number, x, y]) => ({ id: `${SIDES[Number(side)].id}-H${number}`, x: Number(x), y: Number(y) }));
  assert.equal(homes.length, 24);
  assert.deepEqual(HOME_CELLS.map(({ id, x, y }) => ({ id, x, y })), homes);
  assert.equal(new Set(RING_CELLS.map(({ x, y }) => `${x},${y}`)).size, 52);
  assert.deepEqual(RING_CELLS.map(cell => cell.side).slice(0, 8), ['green', 'red', 'blue', 'yellow', 'green', 'red', 'blue', 'yellow']);
});

test('each side traverses 50 ring cells then exactly six private home cells', () => {
  const starts = ['C00', 'C13', 'C26', 'C39'], entries = ['C49', 'C10', 'C23', 'C36'];
  for (const side of SIDES) {
    assert.equal(boardPosition(side.id, 0).id, starts[side.index]);
    assert.equal(boardPosition(side.id, 49).id, entries[side.index]);
    assert.equal(new Set(Array.from({ length: 50 }, (_, progress) => ringIndex(side.id, progress))).size, 50);
    assert.equal(boardPosition(side.id, 50).id, `${side.id}-H1`);
    assert.equal(boardPosition(side.id, 55).id, `${side.id}-H6`);
    assert.match(boardPosition(side.id, 55).label, /完成/);
  }
});

test('hangar numbering and independent launch cells match the reviewed original geometry', () => {
  assert.deepEqual(LAUNCH_CELLS.map(({ x, y }) => [x, y]), [[44, 184], [416, 44], [556, 416], [184, 556]]);
  assert.deepEqual(HANGAR_CELLS.filter(cell => cell.number === 1).map(({ x, y }) => [x, y]), [[66, 92], [456, 92], [456, 482], [66, 482]]);
  for (const side of SIDES) for (let number = 1; number <= 4; number += 1) {
    const hangar = boardPosition(side.id, -2, number), launch = boardPosition(side.id, -1, number);
    assert.equal(hangar.id, `${side.id}-hangar-${number}`);
    assert.equal(launch.id, `${side.id}-launch`);
    assert.notEqual(launch.id, boardPosition(side.id, 0).id);
  }
});

test('public topology is frozen and malformed or unreachable coordinates are rejected', () => {
  assert.equal(BOARD_VERSION, 'fc-board-v1'); assert.equal(ART_VERSION, 'fc-art-vector-v1');
  for (const collection of [SIDES, RING_CELLS, HOME_CELLS, HANGAR_CELLS, LAUNCH_CELLS]) {
    assert.ok(Object.isFrozen(collection)); assert.ok(collection.every(Object.isFrozen));
  }
  for (const progress of [-2, -1, 50, 55, 49.5, NaN, '1', null]) assert.throws(() => ringIndex('red', progress), RangeError);
  for (const progress of [-3, 56, 1.5, NaN, '0']) assert.throws(() => boardPosition('red', progress), RangeError);
  for (const number of [0, 5, 1.5, '1', null]) assert.throws(() => boardPosition('red', -2, number), RangeError);
  for (const side of ['', 'black', 0, null, {}]) assert.throws(() => boardPosition(side, 0), TypeError);
  const position = boardPosition('red', 0); position.x = 0;
  assert.equal(boardPosition('red', 0).x, 80, 'callers cannot mutate public geometry');
});

test('all shortcut lines cross the opposing H3, while home cells remain explicitly safe', () => {
  for (const side of SIDES) {
    const from = boardPosition(side.id, 17), to = boardPosition(side.id, 29);
    const opposite = SIDES[(side.index + 2) % 4];
    const cross = boardPosition(opposite.id, 52);
    assert.equal(from.x === to.x ? cross.x : cross.y, from.x === to.x ? from.x : from.y);
    assert.ok(cross.x >= Math.min(from.x, to.x) && cross.x <= Math.max(from.x, to.x));
    assert.ok(cross.y >= Math.min(from.y, to.y) && cross.y <= Math.max(from.y, to.y));
  }
  const svg = boardSvg();
  assert.equal((svg.match(/data-safe-home="true"/g) || []).length, 24);
  assert.equal((svg.match(/data-flight-side=/g) || []).length, 4);
});

test('a four-plane stack keeps every stable number and visibly identifies selected and recent planes', () => {
  const planes = [1, 2, 3, 4].map(number => plane('red', number, 11));
  const before = structuredClone(planes);
  const svg = boardSvg({ planes, selectedId: 'red-3', legalIds: ['red-1', 'red-2', 'red-3', 'red-4'], lastMoveId: 'red-2' });
  assert.match(svg, /data-stack-count="4"/); assert.match(svg, /1·2·3·4/);
  assert.match(svg, /data-plane-ids="red-1 red-2 red-3 red-4"/);
  assert.match(svg, /data-plane-state="选中"/);
  assert.match(svg, />3<\/text>/); assert.match(svg, /circle r="23"[^>]*stroke-width="3"/);
  assert.deepEqual(planes, before, 'rendering never moves or reorders caller-owned planes');
});

const route = {
  planeId: 'red-2', side: 'red', from: 11, to: 29,
  segments: [{ kind: 'walk', from: 11, to: 13, steps: [12, 13] },
    { kind: 'jump', from: 13, to: 17, steps: [17] }, { kind: 'fly', from: 17, to: 29, steps: [29] }],
  landings: [{ progress: 13, capturedIds: [] }, { progress: 17, capturedIds: ['blue-1', 'blue-2'] }, { progress: 29, capturedIds: [] }],
  capturedIds: ['blue-1', 'blue-2'], finished: false, description: 'C13 → C17 → C29',
};

test('route preview has distinct walk, jump and fly strokes, actual landing capture count and final destination', () => {
  const planes = [plane('red', 2, 11)], before = structuredClone({ planes, route });
  const svg = boardSvg({ planes, selectedId: 'red-2', legalIds: ['red-2'], route });
  for (const kind of ['walk', 'jump', 'fly']) assert.match(svg, new RegExp(`data-route-kind="${kind}"`));
  assert.match(svg, /stroke-dasharray="9 6"/); assert.match(svg, /stroke-dasharray="3 6"/);
  assert.match(svg, /data-route-landing="C13"/); assert.match(svg, /data-route-landing="C17"/); assert.match(svg, /data-route-landing="C29"/);
  assert.match(svg, /返库×2/); assert.match(svg, /目的地/);
  assert.deepEqual({ planes, route }, before, 'preview consumes no dice or positions');
});

test('observer and paused renderers never leak local selection or unconfirmed routes', () => {
  const options = { planes: [plane('red', 2, 11)], selectedId: 'red-2', legalIds: ['red-2'], route };
  for (const state of [{ observer: true }, { paused: true }]) {
    const svg = boardSvg({ ...options, ...state });
    assert.doesNotMatch(svg, /data-route-preview|data-route-kind|data-plane-state="选中"|data-plane-state="可行动"/);
    assert.match(svg, state.observer ? /观战 · 只读棋盘/ : /暂停 · 保留棋位/);
  }
});

test('all four side shapes and completed-plane state survive without any bitmap resource', () => {
  const svg = boardSvg({ planes: SIDES.map(side => plane(side.id, 1, 55)) });
  for (const side of SIDES) assert.match(svg, new RegExp(`${side.label}1`));
  assert.equal((svg.match(/data-plane-state="已完成"/g) || []).length, 4);
  assert.doesNotMatch(svg, /<image|<script|<foreignObject|<a\s|url\(|href=|<use\s/);
  assert.match(svg, /viewBox="0 0 600 600"/);
});

test('SVG attribute and description text escape caller-owned identifiers', () => {
  const id = 'red-2"><script>alert(1)</script>';
  const maliciousRoute = { ...route, planeId: id, description: '<img src="https://example.invalid">' };
  const svg = boardSvg({ planes: [{ ...plane('red', 2, 11), id }], selectedId: id, legalIds: [id], route: maliciousRoute });
  assert.doesNotMatch(svg, /<script>|<img\s|href=/);
  assert.match(svg, /&lt;script&gt;/); assert.match(svg, /&lt;img/);
});

test('art rejects duplicate identity, missing numbers and mismatched route origin', () => {
  assert.throws(() => boardSvg({ planes: [plane('red', 1, 0), plane('red', 1, 1)] }), TypeError);
  assert.throws(() => boardSvg({ planes: [{ id: 'x', side: 'red', progress: 0 }] }), RangeError);
  assert.throws(() => boardSvg({ planes: [plane('red', 2, 12)], route }), TypeError);
  assert.throws(() => boardSvg({ legalIds: 'red-1' }), TypeError);
});

test('six dice faces preserve exact pip counts and a visible numeric fallback', () => {
  for (let value = 1; value <= 6; value += 1) {
    const svg = dieSvg(value);
    assert.equal((svg.match(/data-pip="true"/g) || []).length, value);
    assert.match(svg, new RegExp(`aria-label="骰子${value}点"`));
    assert.match(svg, new RegExp(`>${value}点<\\/text>`));
    assert.doesNotMatch(svg, /<image|href=|url\(/);
  }
  for (const value of [0, 7, -1, 2.5, '6', null, NaN]) assert.throws(() => dieSvg(value), RangeError);
});
