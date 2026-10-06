import { ART_VERSION, BOARD_VERSION, SIDES, RING_CELLS, HOME_CELLS, LAUNCH_CELLS,
  HANGAR_CELLS, boardPosition } from './board.mjs';

// Original code-native artwork for the isolated Step 0 prototype. No images, fonts or network loads.
const INK = '#263b43';
const MUTED = '#526770';
const planePath = 'M0,-12 C2,-12 3,-10 3,-7 L3,-2 L12,4 L12,7 L3,4 L3,8 L7,11 L7,13 L0,11 L-7,13 L-7,11 L-3,8 L-3,4 L-12,7 L-12,4 L-3,-2 L-3,-7 C-3,-10 -2,-12 0,-12 Z';
const sideById = new Map(SIDES.map(side => [side.id, side]));
const escape = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const text = (x, y, value, size = 12, fill = INK, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escape(value)}</text>`;

function marker(side, x, y, size) {
  const color = side.color;
  if (side.marker === 'circle') return `<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${color}"/>`;
  if (side.marker === 'square') return `<rect x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" rx="1" fill="${color}"/>`;
  if (side.marker === 'diamond') return `<path d="M${x},${y - size / 2} L${x + size / 2},${y} L${x},${y + size / 2} L${x - size / 2},${y} Z" fill="${color}"/>`;
  return `<path d="M${x},${y - size / 2} L${x + size / 2},${y + size / 2} L${x - size / 2},${y + size / 2} Z" fill="${color}"/>`;
}

function boardBase() {
  const hangarBoxes = [[34, 34], [424, 34], [424, 424], [34, 424]];
  const hangars = SIDES.map(side => {
    const [x, y] = hangarBoxes[side.index];
    return `<g data-region="${side.id}-hangar"><rect x="${x}" y="${y}" width="142" height="142" rx="18" fill="${side.tint}" stroke="${side.color}" stroke-width="1.5"/>
      ${marker(side, x + 14, y + 20, 10)}${text(x + 26, y + 26, `${side.label}机库`, 14, side.color, 'font-weight="700"')}
      ${HANGAR_CELLS.filter(cell => cell.side === side.id).map(cell => `<circle cx="${cell.x}" cy="${cell.y}" r="20" fill="white" stroke="${side.color}" stroke-dasharray="3 4"/>
        ${text(cell.x, cell.y + 5, cell.number, 14, side.color, 'text-anchor="middle"')}`).join('')}</g>`;
  }).join('');
  const ringPoints = [...RING_CELLS, RING_CELLS[0]].map(cell => `${cell.x},${cell.y}`).join(' ');
  const ring = RING_CELLS.map(cell => {
    const side = sideById.get(cell.side);
    return `<g data-cell-id="${cell.id}"><title>${escape(cell.label)}</title><circle cx="${cell.x}" cy="${cell.y}" r="14" fill="${side.tint}" stroke="${side.color}" stroke-width="1.2"/>
      ${marker(side, cell.x - 7, cell.y - 7, 5)}</g>`;
  }).join('');
  const homeLanes = SIDES.map(side => `<path data-home-lane="${side.id}" transform="rotate(${side.index * 90} 300 300)" d="M96,282 H267 V272 L296,300 L267,328 V318 H96 Z" fill="${side.tint}" stroke="${side.color}" stroke-width="1.4"/>`).join('');
  const homes = HOME_CELLS.map(cell => {
    const side = sideById.get(cell.side);
    return `<g data-cell-id="${cell.id}" data-safe-home="true"><title>${escape(cell.label)}</title><circle cx="${cell.x}" cy="${cell.y}" r="11" fill="white" stroke="${side.color}" stroke-width="1.2"/>
      ${text(cell.x, cell.y + 4, cell.number === 6 ? '✓' : cell.number, 11, side.color, 'text-anchor="middle" font-weight="700"')}</g>`;
  }).join('');
  const launch = LAUNCH_CELLS.map(cell => {
    const side = sideById.get(cell.side), first = boardPosition(cell.side, 0);
    return `<g data-cell-id="${cell.id}"><title>${escape(cell.label)}</title><path d="M${cell.x},${cell.y} L${first.x},${first.y}" fill="none" stroke="${side.color}" stroke-dasharray="3 3"/>
      <circle cx="${cell.x}" cy="${cell.y}" r="16" fill="white" stroke="${side.color}" stroke-width="2"/>
      ${marker(side, cell.x, cell.y, 10)}${text(cell.x, cell.y + 30, '起飞', 12, side.color, 'text-anchor="middle"')}</g>`;
  }).join('');
  const flights = SIDES.map(side => {
    const from = boardPosition(side.id, 17), to = boardPosition(side.id, 29);
    return `<path data-flight-side="${side.id}" d="M${from.x},${from.y} L${to.x},${to.y}" fill="none" stroke="${side.color}" stroke-width="1.4" stroke-dasharray="5 5" opacity=".45"/>`;
  }).join('');
  return `<rect width="600" height="600" rx="20" fill="#fff" stroke="#d8dfdb"/>
    ${text(300, 27, '52格环道 · 归航安全', 13, MUTED, 'text-anchor="middle"')}
    ${hangars}<polyline points="${ringPoints}" fill="none" stroke="#c5d1d0" stroke-width="23" stroke-linejoin="round"/>
    ${homeLanes}${flights}${ring}${homes}${launch}`;
}

function validatePlanes(planes) {
  if (!Array.isArray(planes)) throw new TypeError('Planes must be an array');
  const ids = new Set(), numbers = new Set();
  for (const plane of planes) {
    if (!plane || typeof plane.id !== 'string' || !plane.id || !sideById.has(plane.side)) {
      throw new TypeError('Each plane needs a stable id and a known side');
    }
    if (!Number.isInteger(plane.number) || plane.number < 1 || plane.number > 4) {
      throw new RangeError('Each plane needs a stable number from 1 to 4');
    }
    boardPosition(plane.side, plane.progress, plane.number);
    if (ids.has(plane.id) || numbers.has(`${plane.side}:${plane.number}`)) {
      throw new TypeError('Plane ids and side numbers must be unique');
    }
    ids.add(plane.id); numbers.add(`${plane.side}:${plane.number}`);
  }
}

function routeArt(route, planes) {
  const plane = planes.find(item => item.id === route.planeId);
  if (!plane || route.side !== plane.side || route.from !== plane.progress || !Array.isArray(route.segments)
      || !Array.isArray(route.landings)) throw new TypeError('Route must describe a displayed plane');
  const side = sideById.get(route.side);
  const styles = {
    walk: { color: INK, dash: '' }, launch: { color: side.color, dash: '' },
    jump: { color: '#76520c', dash: '9 6' }, fly: { color: '#654681', dash: '3 6' },
    bounce: { color: '#805131', dash: '2 3' },
  };
  const segments = route.segments.map(segment => {
    const style = styles[segment.kind];
    if (!style || !Array.isArray(segment.steps)) throw new TypeError('Unknown route segment');
    const progress = [segment.from, ...segment.steps, segment.to].filter((value, index, values) =>
      index === 0 || value !== values[index - 1]);
    const points = progress.map(value => boardPosition(route.side, value, plane.number));
    if (points.length < 2) return '';
    const coordinates = points.map(point => `${point.x},${point.y}`).join(' ');
    const [before, end] = points.slice(-2), angle = Math.atan2(end.y - before.y, end.x - before.x);
    const arrow = [end, { x: end.x - 11 * Math.cos(angle) + 5 * Math.sin(angle), y: end.y - 11 * Math.sin(angle) - 5 * Math.cos(angle) },
      { x: end.x - 11 * Math.cos(angle) - 5 * Math.sin(angle), y: end.y - 11 * Math.sin(angle) + 5 * Math.cos(angle) }]
      .map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
    return `<g data-route-kind="${segment.kind}"><polyline points="${coordinates}" fill="none" stroke="white" stroke-width="8" stroke-linejoin="round"/>
      <polyline points="${coordinates}" fill="none" stroke="${style.color}" stroke-width="4" stroke-dasharray="${style.dash}" stroke-linejoin="round"/>
      <polygon points="${arrow}" fill="${style.color}"/></g>`;
  }).join('');
  const landings = route.landings.map((landing, index) => {
    const position = boardPosition(route.side, landing.progress, plane.number);
    if (!Array.isArray(landing.capturedIds)) throw new TypeError('Landing captures must be an array');
    const captured = landing.capturedIds.length;
    return `<g data-route-landing="${position.id}"><circle cx="${position.x}" cy="${position.y}" r="19" fill="none" stroke="${side.color}" stroke-width="2" stroke-dasharray="4 3"/>
      ${text(position.x, position.y - 24, captured ? `${index + 1} · 返库×${captured}` : `${index + 1}`, 12, INK, 'text-anchor="middle" font-weight="700"')}</g>`;
  }).join('');
  const final = boardPosition(route.side, route.to, plane.number);
  return `<g data-route-preview="${escape(route.planeId)}"><title>${escape(route.description || `${side.label}路线预览`)}</title>
    ${segments}${landings}<circle cx="${final.x}" cy="${final.y}" r="23" fill="none" stroke="${INK}" stroke-width="3"/>
    ${text(final.x, final.y + 38, route.finished ? '完成' : '目的地', 13, INK, 'text-anchor="middle" font-weight="700"')}</g>`;
}

function planeArt(planes, { selectedId, legalIds, lastMoveId, observer, paused }) {
  const legal = new Set(observer || paused ? [] : legalIds), groups = new Map();
  for (const plane of planes) {
    const position = boardPosition(plane.side, plane.progress, plane.number);
    if (!groups.has(position.id)) groups.set(position.id, []);
    groups.get(position.id).push(plane);
  }
  return [...groups.values()].map(group => {
    group.sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
    const selected = !observer && !paused && group.some(plane => plane.id === selectedId);
    const recent = group.some(plane => plane.id === lastMoveId);
    const usable = group.some(plane => legal.has(plane.id));
    const plane = group.find(item => selected && item.id === selectedId) || group.find(item => item.id === lastMoveId) || group[0];
    const side = sideById.get(plane.side), position = boardPosition(plane.side, plane.progress, plane.number);
    const complete = plane.progress === 55;
    const state = complete ? '已完成' : selected ? '选中' : usable ? '可行动' : paused ? '已暂停' : observer ? '观战'
      : legal.size ? '不可行动' : '公开位置';
    const label = `${group.map(item => `${sideById.get(item.side).label}${item.number}`).join('、')} · ${position.label} · ${state}`;
    const ids = group.map(item => item.id).join(' ');
    return `<g data-plane-ids="${escape(ids)}" data-plane-state="${state}" transform="translate(${position.x} ${position.y})"><title>${escape(label)}</title>
      ${recent ? `<circle r="23" fill="none" stroke="${INK}" stroke-width="3"/>` : ''}
      ${usable && !selected ? `<circle r="20" fill="white" stroke="${side.color}" stroke-width="3" stroke-dasharray="4 3"/>` : ''}
      <circle r="17" fill="white" stroke="${selected ? INK : side.color}" stroke-width="${selected ? 4 : 2}"/>
      ${selected ? `<circle r="21" fill="none" stroke="${side.color}" stroke-width="2"/>` : ''}
      <path d="${planePath}" transform="scale(.75)" fill="${side.color}" opacity=".28"/>
      ${marker(side, -11, -11, 8)}${text(0, 6, plane.number, 17, side.color, 'text-anchor="middle" font-weight="800"')}
      ${complete ? text(13, -12, '✓', 14, INK, 'font-weight="800"') : ''}
      ${group.length > 1 ? `<g data-stack-count="${group.length}"><rect x="9" y="-26" width="26" height="20" rx="10" fill="${INK}"/>
        ${text(22, -12, `×${group.length}`, 12, 'white', 'text-anchor="middle" font-weight="700"')}
        <rect x="-26" y="20" width="52" height="17" rx="7" fill="white" stroke="${side.color}"/>
        ${text(0, 33, group.map(item => item.number).join('·'), 12, side.color, 'text-anchor="middle" font-weight="700"')}</g>` : ''}</g>`;
  }).join('');
}

/** This image is a reading surface. Large, ordinary HTML controls own all interaction. */
export function boardSvg({ planes = [], selectedId = null, legalIds = [], route = null,
  lastMoveId = null, observer = false, paused = false } = {}) {
  validatePlanes(planes);
  if (!Array.isArray(legalIds) || legalIds.some(id => typeof id !== 'string')) throw new TypeError('Legal plane ids must be an array');
  const preview = route && !observer && !paused ? routeArt(route, planes) : '';
  const visibleSelection = !observer && !paused ? selectedId : null;
  const label = `飞行棋公开棋盘，${planes.length}架飞机${observer ? '，观战模式' : ''}${paused ? '，已暂停' : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="${label}" data-board-version="${BOARD_VERSION}" data-art-version="${ART_VERSION}" focusable="false">
    <title>${label}</title><desc>52格公共环道，四条六格安全归航道。圆、方、菱、三角区分四阵营，飞机序号保持稳定；小格子不承担点击操作。</desc>
    <style>text{font-family:system-ui,-apple-system,"PingFang SC",sans-serif}svg{isolation:isolate}</style>
    ${boardBase()}${preview}${planeArt(planes, { selectedId: visibleSelection, legalIds, lastMoveId, observer, paused })}
    ${paused || observer ? `<rect x="237" y="577" width="126" height="20" rx="10" fill="${INK}"/>
      ${text(300, 591, paused ? '暂停 · 保留棋位' : '观战 · 只读棋盘', 12, 'white', 'text-anchor="middle"')}` : ''}</svg>`;
}

const diePoints = [[], [[32, 32]], [[18, 18], [46, 46]], [[18, 18], [32, 32], [46, 46]],
  [[18, 18], [18, 46], [46, 18], [46, 46]],
  [[18, 18], [18, 46], [32, 32], [46, 18], [46, 46]],
  [[18, 18], [18, 32], [18, 46], [46, 18], [46, 32], [46, 46]]];

export function dieSvg(value) {
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new RangeError('Die value must be an integer from 1 to 6');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 82" width="64" height="82" role="img" aria-label="骰子${value}点" data-die-face="${value}" focusable="false"><title>骰子 ${value} 点</title>
    <rect x="2" y="2" width="60" height="60" rx="13" fill="white" stroke="${INK}" stroke-width="2"/>
    ${diePoints[value].map(([x, y]) => `<circle data-pip="true" cx="${x}" cy="${y}" r="4" fill="${INK}"/>`).join('')}
    ${text(32, 79, `${value}点`, 16, INK, 'text-anchor="middle" font-weight="700" font-family="system-ui,sans-serif"')}</svg>`;
}
