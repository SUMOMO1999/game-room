/** Public, immutable board geometry shared by renderer and server rules. */
export const PIECE_LABELS = Object.freeze({
  commander: '司令', general: '军长', division: '师长', brigade: '旅长',
  regiment: '团长', battalion: '营长', company: '连长', platoon: '排长',
  engineer: '工兵', bomb: '炸弹', mine: '地雷', flag: '军旗',
});
export const PIECE_COUNTS = Object.freeze({
  commander: 1, general: 1, division: 2, brigade: 2, regiment: 2,
  battalion: 2, company: 3, platoon: 3, engineer: 3, bomb: 2, mine: 3, flag: 1,
});
export const RANKS = Object.freeze({
  commander: 9, general: 8, division: 7, brigade: 6, regiment: 5,
  battalion: 4, company: 3, platoon: 2, engineer: 1,
});
/** Fixed, public delivery zones in the v2 friends-room variant. */
export const ARMY_HOME_BASES = Object.freeze({
  red: Object.freeze(['r11c1', 'r11c3']),
  black: Object.freeze(['r0c1', 'r0c3']),
});

export function cellId(row, column) {
  if (!Number.isInteger(row) || row < 0 || row >= 12
      || !Number.isInteger(column) || column < 0 || column >= 5) return null;
  return `r${row}c${column}`;
}

const campCoordinates = [[2, 1], [2, 3], [3, 2], [4, 1], [4, 3],
  [7, 1], [7, 3], [8, 2], [9, 1], [9, 3]];
const camps = new Set(campCoordinates.map(([row, column]) => cellId(row, column)));
const headquarters = new Set([[0, 1], [0, 3], [11, 1], [11, 3]]
  .map(([row, column]) => cellId(row, column)));
export const BOARD_CELLS = Object.freeze(Array.from({ length: 60 }, (_, index) => {
  const row = Math.floor(index / 5), column = index % 5;
  const id = cellId(row, column);
  return Object.freeze({ cellId: id, row, column,
    terrain: camps.has(id) ? 'camp' : headquarters.has(id) ? 'headquarters' : 'station' });
}));
const byId = new Map(BOARD_CELLS.map((cell) => [cell.cellId, cell]));
export function getCell(id) { return byId.get(id) ?? null; }
export function isCellId(id) { return typeof id === 'string' && byId.has(id); }

const edgeKey = (a, b) => [a, b].sort().join(':');
function makeEdges(addEdges) {
  const unique = new Map();
  const add = (a, b) => {
    if (a && b && a !== b) unique.set(edgeKey(a, b), Object.freeze([a, b]));
  };
  addEdges(add);
  return Object.freeze([...unique.values()]);
}

// ROAD_EDGES includes the railway's adjacent edges: a piece may always walk one.
export const ROAD_EDGES = makeEdges((add) => {
  for (let row = 0; row < 12; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      if (column < 4) add(cellId(row, column), cellId(row, column + 1));
      if (row < 11 && !(row === 5 && (column === 1 || column === 3))) {
        add(cellId(row, column), cellId(row + 1, column));
      }
    }
  }
  for (const [row, column] of campCoordinates) {
    for (const dr of [-1, 1]) for (const dc of [-1, 1]) {
      add(cellId(row, column), cellId(row + dr, column + dc));
    }
  }
});
export const RAIL_EDGES = makeEdges((add) => {
  for (const row of [1, 5, 6, 10]) {
    for (let column = 0; column < 4; column += 1) add(cellId(row, column), cellId(row, column + 1));
  }
  for (const column of [0, 4]) {
    for (let row = 1; row < 10; row += 1) add(cellId(row, column), cellId(row + 1, column));
  }
  add(cellId(5, 2), cellId(6, 2));
});

function adjacency(edges) {
  const map = new Map(BOARD_CELLS.map(({ cellId: id }) => [id, []]));
  for (const [a, b] of edges) { map.get(a).push(b); map.get(b).push(a); }
  return new Map([...map].map(([id, neighbors]) => [id, Object.freeze(neighbors)]));
}
const roadMap = adjacency(ROAD_EDGES), railMap = adjacency(RAIL_EDGES);
const empty = Object.freeze([]);
export function roadNeighbors(id) { return roadMap.get(id) ?? empty; }
export function railNeighbors(id) { return railMap.get(id) ?? empty; }
