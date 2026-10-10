import { boardPosition } from './board.mjs';
import { createObjectMotion } from '../../platform/object-motion.mjs';

/** Only a consecutive accepted move can become a flight. A refreshed board is
 * a baseline, never a request to replay the last route. */
export function flyingMotionPlan(before, after, { baseline = false } = {}) {
  const local = before?.practice && after?.practice && before.roomId === 'flying-local-practice';
  if (baseline || !before?.game || !after?.game || before.roomId !== after.roomId
    || before.matchId !== after.matchId || before.selfRole !== after.selfRole
    || before.selfId !== after.selfId && !local || before.phase !== 'playing'
    || !['playing', 'finished'].includes(after.phase)
    || after.game.revision !== before.game.revision + 1) return null;
  const action = after.game.lastAction, route = action?.route;
  if (action?.type !== 'move' || !route || !Array.isArray(route.segments)
    || !Array.isArray(route.landings) || !Array.isArray(route.capturedIds)) return null;
  const plane = before.game.planes.find(item => item.id === route.planeId);
  const final = after.game.planes.find(item => item.id === route.planeId);
  if (!plane || !final || plane.side !== route.side || plane.progress !== route.from
    || final.progress !== route.to || route.segments.some(segment => !Array.isArray(segment.steps))) return null;
  const captured = route.capturedIds.map(id => before.game.planes.find(item => item.id === id));
  if (captured.some(plane => !plane || after.game.planes.find(item => item.id === plane.id)?.progress !== -2)) return null;
  return { plane: { ...plane }, route: structuredClone(route), captured: captured.map(plane => ({ ...plane })) };
}

/** Keep ordinary steps, bounce direction, and actual landings separate from
 * airborne arcs. Coordinates remain logical board coordinates until mounted. */
export function flyingRoutePoints(plan) {
  const { plane, route } = plan, points = [], landings = [];
  for (const segment of route.segments) {
    const from = boardPosition(plane.side, segment.from, plane.number);
    const to = boardPosition(plane.side, segment.to, plane.number);
    if (['jump', 'fly', 'launch'].includes(segment.kind)) {
      points.push({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - (segment.kind === 'fly' ? 42 : 20), kind: segment.kind });
    }
    for (const progress of segment.steps) points.push({ ...boardPosition(plane.side, progress, plane.number), kind: segment.kind });
    const landing = route.landings.find(item => item.progress === segment.to);
    if (landing && !landings.some(item => item.progress === landing.progress)) landings.push({ ...landing, index: points.length });
  }
  return { points, landings };
}

export function createFlyingMotion({ root, document = root.ownerDocument, window = document.defaultView, onSettled = () => {} }) {
  const motion = createObjectMotion({ root, document, window }), reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let generation = 0, hiddenIds = new Set(), prepared = null, destroyed = false, finishAnimation = null;
  const board = () => root.querySelector('#flying-board svg');
  const screen = (point, matrix = board()?.getScreenCTM()) => matrix
    ? { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f } : null;
  function rect(plane, progress = plane.progress, matrix = board()?.getScreenCTM()) {
    const centre = screen(boardPosition(plane.side, progress, plane.number), matrix);
    if (!centre) return null;
    const size = 48 * Math.hypot(matrix.a, matrix.b);
    return { x: centre.x - size / 2, y: centre.y - size / 2, width: size, height: size };
  }
  function capture(plane) {
    const group = [...root.querySelectorAll('#flying-board [data-plane-ids]')].find(node => node.dataset.planeIds.split(' ').includes(plane.id));
    if (!group) return null;
    // A stack is one reading object, but only the selected numbered plane flies.
    const visual = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    visual.setAttribute('viewBox', '-24 -24 48 48');
    const copy = group.cloneNode(true); copy.removeAttribute('transform');
    copy.querySelector('[data-stack-count]')?.remove();
    for (const text of copy.querySelectorAll('text')) if (/^[1-4]$/.test(text.textContent)) text.textContent = String(plane.number);
    visual.append(copy);
    const snapshot = motion.capture(group, { visual });
    if (snapshot) snapshot.rect = rect(plane);
    return snapshot;
  }
  function cancel({ notify = true } = {}) {
    generation += 1; motion.cancel(); finishAnimation?.cancel(); finishAnimation=null; prepared = null;
    const changed = hiddenIds.size > 0; hiddenIds = new Set();
    if (changed && notify && !destroyed) onSettled();
  }
  function prepare(plan) {
    cancel({ notify: false });
    if (!plan || document.hidden || reduced?.matches || destroyed) return;
    const from = capture(plan.plane), captured = plan.captured.map(plane => ({ plane, from: capture(plane) }));
    if (!from) return;
    prepared = { plan, from, captured, generation };
    hiddenIds = new Set([plan.plane.id, ...captured.filter(item => item.from).map(item => item.plane.id)]);
  }
  async function play() {
    const item = prepared; prepared = null;
    if (!item || destroyed) return;
    const { plan, from, captured, generation: fence } = item, matrix = board()?.getScreenCTM();
    if (!matrix) { cancel(); return; }
    const route = flyingRoutePoints(plan), duration = Math.min(1100, 320 + route.points.length * 65);
    const path = route.points.slice(0, -1).map(point => screen(point, matrix));
    const returns = captured.filter(item => item.from).map(item => {
      const landing = route.landings.find(landing => landing.capturedIds.includes(item.plane.id));
      const delay = landing ? duration * landing.index / route.points.length : 0;
      const a = screen(boardPosition(item.plane.side, item.plane.progress, item.plane.number), matrix);
      const b = screen(boardPosition(item.plane.side, -2, item.plane.number), matrix);
      return motion.move({ from: item.from, to: rect(item.plane, -2, matrix), path: [{ x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 22 }], duration: 260, delay }).then(()=>{
        if (!destroyed && generation===fence) { hiddenIds.delete(item.plane.id); onSettled(); }
      });
    });
    const mover=motion.move({ from, to: rect(plan.plane, plan.route.to, matrix), path, duration, easing: 'linear' }).then(()=>{
      if (!destroyed && generation===fence) { hiddenIds.delete(plan.plane.id); onSettled(); }
    });
    await Promise.all([mover, ...returns]);
    if (destroyed || generation !== fence) return;
    hiddenIds = new Set(); onSettled();
    const destination = [...root.querySelectorAll('#flying-board [data-plane-ids]')].find(node => node.dataset.planeIds.split(' ').includes(plan.plane.id));
    if (plan.route.finished && !document.hidden && !reduced?.matches) finishAnimation=destination?.animate?.([{ opacity: .35 }, { opacity: 1 }], { duration: 200 });
  }
  const interrupt = () => cancel();
  const hidden = () => { if (document.hidden) cancel(); };
  document.addEventListener('visibilitychange', hidden); window.addEventListener('resize', interrupt); window.addEventListener('pagehide', interrupt); reduced?.addEventListener?.('change', interrupt);
  return { prepare, play, hiddenIds: () => hiddenIds, cancel,
    destroy() { destroyed = true; cancel({ notify: false }); motion.destroy(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('resize', interrupt); window.removeEventListener('pagehide', interrupt); reduced?.removeEventListener?.('change', interrupt); } };
}
