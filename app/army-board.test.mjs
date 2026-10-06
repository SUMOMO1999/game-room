import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_CELLS, ROAD_EDGES, RAIL_EDGES, cellId, getCell, isCellId,
  roadNeighbors, railNeighbors, PIECE_COUNTS } from './army-board.mjs';
const edgeKey = ([a, b]) => [a, b].sort().join(':');
const roadSet = new Set(ROAD_EDGES.map(edgeKey));
const railSet = new Set(RAIL_EDGES.map(edgeKey));
const mirror = (id) => { const cell = getCell(id); return cellId(11 - cell.row, 4 - cell.column); };

test('army board has 60 unique cells, ten camps, four headquarters and fifty initial piece slots', () => {
  assert.equal(BOARD_CELLS.length, 60);
  assert.equal(new Set(BOARD_CELLS.map(({ cellId }) => cellId)).size, 60);
  assert.equal(BOARD_CELLS.filter(({ terrain }) => terrain === 'camp').length, 10);
  assert.equal(BOARD_CELLS.filter(({ terrain }) => terrain === 'headquarters').length, 4);
  assert.equal(Object.values(PIECE_COUNTS).reduce((a, b) => a + b, 0), 25);
  assert.equal(cellId(11, 4), 'r11c4');
  for (const args of [[-1, 0], [12, 0], [0, 5], [0, 0.5], ['1', 0]]) assert.equal(cellId(...args), null);
  assert.equal(isCellId('r01c0'), false); assert.equal(getCell('bad'), null);
});
test('all 133 road connections and 35 rail connections are distinct valid undirected edges', () => {
  assert.equal(ROAD_EDGES.length, 133); assert.equal(roadSet.size, 133);
  assert.equal(RAIL_EDGES.length, 35); assert.equal(railSet.size, 35);
  for (const [a, b] of ROAD_EDGES) {
    assert.ok(isCellId(a) && isCellId(b) && a !== b);
    assert.ok(roadNeighbors(a).includes(b) && roadNeighbors(b).includes(a));
  }
  for (const edge of RAIL_EDGES) assert.ok(roadSet.has(edgeKey(edge)));
});
test('mountain boundary has exactly three crossing bridges and no phantom middle-side road', () => {
  for (const column of [0, 2, 4]) {
    assert.ok(roadSet.has(edgeKey([cellId(5, column), cellId(6, column)])));
    assert.ok(railSet.has(edgeKey([cellId(5, column), cellId(6, column)])));
  }
  for (const column of [1, 3]) assert.ok(!roadSet.has(edgeKey([cellId(5, column), cellId(6, column)])));
  assert.ok(!roadNeighbors('r5c1').includes('r6c2'));
});
test('only camp-connected diagonal roads exist, including camp-to-camp diagonals', () => {
  for (const [a, b] of ROAD_EDGES) {
    const left = getCell(a), right = getCell(b);
    if (left.row !== right.row && left.column !== right.column) {
      assert.equal(Math.abs(left.row - right.row), 1);
      assert.equal(Math.abs(left.column - right.column), 1);
      assert.ok(left.terrain === 'camp' || right.terrain === 'camp');
    }
  }
  assert.ok(roadNeighbors('r3c2').includes('r2c1'));
  assert.ok(roadNeighbors('r3c2').includes('r4c3'));
  assert.ok(!roadNeighbors('r0c0').includes('r1c1'));
});
test('both board terrain and every connection are rotationally symmetric', () => {
  for (const cell of BOARD_CELLS) assert.equal(getCell(mirror(cell.cellId)).terrain, cell.terrain);
  for (const edge of ROAD_EDGES) assert.ok(roadSet.has(edgeKey(edge.map(mirror))));
  for (const edge of RAIL_EDGES) assert.ok(railSet.has(edgeKey(edge.map(mirror))));
});
test('public topology cannot be mutated by another renderer or caller', () => {
  assert.throws(() => { BOARD_CELLS[0].row = 9; }, TypeError);
  assert.throws(() => ROAD_EDGES.push(['x', 'y']), TypeError);
  assert.throws(() => { ROAD_EDGES[0][0] = 'bad'; }, TypeError);
  assert.throws(() => roadNeighbors('r0c0').push('bad'), TypeError);
  assert.deepEqual(railNeighbors('bad'), []);
});
