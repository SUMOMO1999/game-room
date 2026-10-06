import { SIDES, ringIndex } from './board.mjs';

// Public, deterministic movement only. Dice, turns, roles and storage belong to
// the future server adapter; this module cannot authorize or save a real move.
const sideById = new Map(SIDES.map(side => [side.id, side]));

function requireDie(die) {
  if (!Number.isInteger(die) || die < 1 || die > 6) throw new RangeError('骰面必须是 1～6 的整数。');
}

function requireSide(side) {
  if (!sideById.has(side)) throw new TypeError('未知的飞行棋阵营。');
}

function requirePlanes(planes) {
  if (!Array.isArray(planes)) throw new TypeError('飞机列表必须是数组。');
  const ids = new Set(), numbers = new Set();
  for (const plane of planes) {
    if (!plane || typeof plane.id !== 'string' || !plane.id || ids.has(plane.id)) throw new TypeError('飞机 ID 必须唯一且非空。');
    requireSide(plane.side);
    if (!Number.isInteger(plane.number) || plane.number < 1 || plane.number > 4 || numbers.has(`${plane.side}:${plane.number}`)) throw new TypeError('每方飞机序号必须唯一且为 1～4。');
    if (!Number.isInteger(plane.progress) || plane.progress < -2 || plane.progress > 55) throw new RangeError('飞机进度必须是 -2～55 的整数。');
    ids.add(plane.id);
    numbers.add(`${plane.side}:${plane.number}`);
  }
}

function canMove(plane, die) {
  return plane.progress !== 55 && (plane.progress !== -2 || die === 6);
}

export function legalPlaneIds(planes, side, die) {
  requirePlanes(planes);
  requireSide(side);
  requireDie(die);
  return planes.filter(plane => plane.side === side && canMove(plane, die)).map(plane => plane.id);
}

function positionLabel(side, progress) {
  if (progress === -2) return '机库';
  if (progress === -1) return '起飞点';
  if (progress >= 50) return `H${progress - 49}${progress === 55 ? '（完成）' : ''}`;
  return `C${String(ringIndex(side, progress)).padStart(2, '0')}`;
}

function descriptionFor(plane, die, segments, to, capturedIds) {
  const actions = segments.map(segment => ({
    launch: '六点起飞',
    walk: `走 ${segment.steps.length} 格`,
    jump: '同色跳 4 格',
    fly: '捷径飞行',
    bounce: `反弹 ${segment.steps.length} 格`,
  })[segment.kind]).join(' → ');
  return `${sideById.get(plane.side).label} ${plane.number}，骰面 ${die}：${actions}，落在 ${positionLabel(plane.side, to)}${capturedIds.length ? `，击退 ${capturedIds.length} 架敌机` : ''}。`;
}

/** Preview one plane without changing any entity. Unknown/ineligible IDs return null. */
export function previewMove(planes, planeId, die) {
  requirePlanes(planes);
  requireDie(die);
  const plane = planes.find(item => item.id === planeId);
  if (!plane || !canMove(plane, die)) return null;
  const from = plane.progress, segments = [], landings = [], captured = new Set();

  const land = progress => {
    const capturedIds = progress >= 0 && progress <= 49
      ? planes.filter(other => other.id !== plane.id && other.side !== plane.side && other.progress >= 0 && other.progress <= 49
        && !captured.has(other.id) && ringIndex(other.side, other.progress) === ringIndex(plane.side, progress)).map(other => other.id)
      : [];
    capturedIds.forEach(id => captured.add(id));
    landings.push({ progress, capturedIds });
  };
  const addSegment = (kind, start, end, steps) => segments.push({ kind, from: start, to: end, steps });
  let to;

  if (from === -2) {
    to = -1;
    addSegment('launch', from, to, [to]);
    land(to);
  } else {
    const direct = from + die, forwardEnd = Math.min(direct, 55);
    addSegment('walk', from, forwardEnd, Array.from({ length: forwardEnd - from }, (_, index) => from + index + 1));
    to = forwardEnd;
    if (direct > 55) {
      const remainder = direct - 55;
      to = 55 - remainder;
      addSegment('bounce', 55, to, Array.from({ length: remainder }, (_, index) => 54 - index));
    }
    land(to);

    // Effects happen only at actual ring landings, never on crossed cells or H6
    // reached temporarily while bouncing. There is at most one jump and one fly.
    if (to === 17) {
      addSegment('fly', 17, 29, [29]);
      to = 29;
      land(to);
      addSegment('jump', 29, 33, [33]);
      to = 33;
      land(to);
    } else if (to >= 0 && to + 4 <= 49 && (ringIndex(plane.side, to) + 3) % 4 === sideById.get(plane.side).index) {
      const jumped = to + 4;
      addSegment('jump', to, jumped, [jumped]);
      to = jumped;
      land(to);
      if (to === 17) {
        addSegment('fly', 17, 29, [29]);
        to = 29;
        land(to);
      }
    }
  }

  const capturedIds = [...captured];
  return {
    planeId: plane.id, side: plane.side, die, from, to, segments, landings,
    capturedIds, finished: to === 55,
    description: descriptionFor(plane, die, segments, to, capturedIds),
  };
}

/** Apply a current deterministic preview to copies. This is not a server write. */
export function applyPreview(planes, route) {
  requirePlanes(planes);
  if (!route || typeof route !== 'object') throw new TypeError('请先选择可行动的飞机并预览路线。');
  const current = previewMove(planes, route.planeId, route.die);
  const fields = ['planeId', 'side', 'die', 'from', 'to', 'segments', 'landings', 'capturedIds', 'finished', 'description'];
  if (!current || fields.some(field => JSON.stringify(current[field]) !== JSON.stringify(route[field]))) throw new Error('预览已失效，请按当前局面重新选择。');
  const captured = new Set(current.capturedIds);
  return planes.map(plane => ({
    ...plane,
    progress: plane.id === current.planeId ? current.to : captured.has(plane.id) ? -2 : plane.progress,
  }));
}
