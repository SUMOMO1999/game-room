/** Public geometry only: progress is a logical position, never a pixel measurement. */
export const BOARD_VERSION = 'fc-board-v1';
export const ART_VERSION = 'fc-art-vector-v1';

export const SIDES = Object.freeze([
  { id: 'red', index: 0, label: '红圆', marker: 'circle', color: '#a53e3e', tint: '#f6e0dd' },
  { id: 'blue', index: 1, label: '蓝方', marker: 'square', color: '#2b6f9d', tint: '#deedf5' },
  { id: 'yellow', index: 2, label: '黄菱', marker: 'diamond', color: '#8a6507', tint: '#f7edce' },
  { id: 'green', index: 3, label: '绿三角', marker: 'triangle', color: '#36745c', tint: '#deeee4' },
].map(Object.freeze));
const sideById = new Map(SIDES.map(side => [side.id, side]));

function sideDefinition(id) {
  const side = sideById.get(id);
  if (!side) throw new TypeError('Unknown flying-chess side');
  return side;
}

function rotate([x, y], times) {
  for (let turn = 0; turn < times; turn += 1) [x, y] = [600 - y, x];
  return { x, y };
}

const firstQuadrant = [
  [80, 204], [116, 192], [148, 192], [180, 204], [204, 180],
  [192, 148], [192, 116], [204, 80], [236, 68], [268, 68],
  [300, 68], [332, 68], [364, 68],
];

export const RING_CELLS = Object.freeze(Array.from({ length: 52 }, (_, index) => {
  const side = SIDES[(index + 3) % 4];
  const id = `C${String(index).padStart(2, '0')}`;
  return Object.freeze({ id, index, ...rotate(firstQuadrant[index % 13], Math.floor(index / 13)),
    side: side.id, label: `${id} · ${side.label}` });
}));

export const HOME_CELLS = Object.freeze(SIDES.flatMap(side => Array.from({ length: 6 }, (_, index) =>
  Object.freeze({ id: `${side.id}-H${index + 1}`, side: side.id, index, number: index + 1,
    progress: index + 50, ...rotate([116 + 32 * index, 300], side.index),
    label: `${side.label} H${index + 1}${index === 5 ? ' · 完成' : ' · 安全归航'}` }))));

export const LAUNCH_CELLS = Object.freeze(SIDES.map(side => Object.freeze({
  id: `${side.id}-launch`, side: side.id, index: side.index,
  ...rotate([44, 184], side.index), label: `${side.label}起飞点`,
})));

// Hangar numbering matches the original Step 0 artwork, independent of direction of travel.
const hangarOrigins = [[66, 92], [456, 92], [456, 482], [66, 482]];
export const HANGAR_CELLS = Object.freeze(SIDES.flatMap(side => Array.from({ length: 4 }, (_, index) => {
  const [x, y] = hangarOrigins[side.index];
  return Object.freeze({ id: `${side.id}-hangar-${index + 1}`, side: side.id,
    number: index + 1, x: x + (index % 2) * 72, y: y + Math.floor(index / 2) * 52,
    label: `${side.label} ${index + 1} · 机库` });
})));

/** 52 shared ring cells, but each side traverses only 50 before entering its own home. */
export function ringIndex(sideId, progress) {
  const side = sideDefinition(sideId);
  if (!Number.isInteger(progress) || progress < 0 || progress > 49) {
    throw new RangeError('Ring progress must be an integer from 0 to 49');
  }
  return (side.index * 13 + progress) % 52;
}

export function boardPosition(sideId, progress, number = 1) {
  const side = sideDefinition(sideId);
  if (!Number.isInteger(progress) || progress < -2 || progress > 55) {
    throw new RangeError('Plane progress must be an integer from -2 to 55');
  }
  if (!Number.isInteger(number) || number < 1 || number > 4) {
    throw new RangeError('Plane number must be an integer from 1 to 4');
  }
  const cell = progress === -2 ? HANGAR_CELLS[side.index * 4 + number - 1]
    : progress === -1 ? LAUNCH_CELLS[side.index]
      : progress < 50 ? RING_CELLS[ringIndex(sideId, progress)]
        : HOME_CELLS[side.index * 6 + progress - 50];
  return { x: cell.x, y: cell.y, id: cell.id, label: cell.label };
}
