import { fitBoard } from './board-layout.mjs';

const EPSILON = 1e-7;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const viewportSize = (value) => finite(value) && value > 0 ? value : 0;
const validRect = (rect) => rect && finite(rect.x) && finite(rect.y)
  && finite(rect.width) && rect.width > 0 && finite(rect.height) && rect.height > 0;

function intersects(a, b, gap) {
  return !(a.x + a.width + gap <= b.x + EPSILON
    || b.x + b.width + gap <= a.x + EPSILON
    || a.y + a.height + gap <= b.y + EPSILON
    || b.y + b.height + gap <= a.y + EPSILON);
}

/** Edge contact is allowed. A positive gap also reserves space between groups. */
export function rectanglesIntersect(a, b, gap = 0) {
  return Boolean(validRect(a) && validRect(b)
    && intersects(a, b, finite(gap) && gap >= 0 ? gap : 0));
}

/**
 * All arguments and results use the same pixel coordinate space.
 * Keep the desired point when free and within the optional viewport; otherwise
 * prefer free edge candidates inside width/height before choosing by distance.
 * Width constrains horizontal placement; vertical space may grow for scrolling
 * when the viewport cannot contain the group. Height defaults to Infinity.
 * This helper does not merge groups or change any game data.
 */
export function placeGroup(rect, desired = {}, otherRects = [], options = {}) {
  if (!finite(rect?.width) || rect.width <= 0 || !finite(rect?.height) || rect.height <= 0) {
    throw new TypeError('组合宽高必须是有限的正数');
  }
  const settings = options && typeof options === 'object' ? options : {};
  const gap = finite(settings.gap) && settings.gap >= 0 ? settings.gap : 10;
  const width = finite(settings.width) && settings.width >= 0 ? settings.width : Infinity;
  const height = finite(settings.height) && settings.height >= 0 ? settings.height : Infinity;
  const maxX = Math.max(0, width - rect.width);
  const requested = { x: finite(desired?.x) ? desired.x : 0, y: finite(desired?.y) ? desired.y : 0 };
  const obstacles = Array.isArray(otherRects) ? otherRects.filter(validRect) : [];
  const normalize = (point) => ({ x: Math.min(maxX, Math.max(0, point.x)), y: Math.max(0, point.y) });
  const preferred = normalize(requested);
  const free = (point) => !obstacles.some((obstacle) => intersects({ ...point, width: rect.width, height: rect.height }, obstacle, gap));
  const withinViewport = (point) => point.x + rect.width <= width + EPSILON
    && point.y + rect.height <= height + EPSILON;
  const result = (point) => ({ ...point, width: rect.width, height: rect.height,
    shifted: Math.abs(point.x - requested.x) > EPSILON || Math.abs(point.y - requested.y) > EPSILON });
  if (withinViewport(preferred) && free(preferred)) return result(preferred);

  const candidates = [preferred, { x: 0, y: 0 }];
  if (height !== Infinity && rect.height <= height) {
    candidates.push({ x: preferred.x, y: height - rect.height });
  }
  let bottom = 0;
  for (const obstacle of obstacles) {
    bottom = Math.max(bottom, obstacle.y + obstacle.height);
    const left = obstacle.x - rect.width - gap;
    const right = obstacle.x + obstacle.width + gap;
    const top = obstacle.y - rect.height - gap;
    const below = obstacle.y + obstacle.height + gap;
    candidates.push(
      { x: preferred.x, y: top }, { x: preferred.x, y: below },
      { x: left, y: preferred.y }, { x: right, y: preferred.y },
      { x: obstacle.x, y: top }, { x: obstacle.x, y: below },
      { x: left, y: obstacle.y }, { x: right, y: obstacle.y },
    );
  }
  // These last candidates guarantee an unobstructed vertical fallback.
  candidates.push({ x: preferred.x, y: bottom + gap }, { x: 0, y: bottom + gap });
  const distance = (point) => (point.x - preferred.x) ** 2 + (point.y - preferred.y) ** 2;
  candidates.splice(0, candidates.length, ...candidates.map(normalize));
  candidates.sort((a, b) => Number(withinViewport(b)) - Number(withinViewport(a))
    || distance(a) - distance(b) || a.y - b.y || a.x - b.x);
  return result(candidates.find(free));
}

function normalizeGroups(input) {
  if (!Array.isArray(input)) return [];
  const groups = [];
  const ids = new Set();
  for (const [index, item] of input.entries()) {
    const object = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
    const length = typeof item === 'number' ? item : object?.length;
    if (!Number.isSafeInteger(length) || length <= 0) continue;
    const id = typeof object?.id === 'string' && object.id.length ? object.id : String(index);
    if (ids.has(id)) throw new TypeError('组合标识不能重复');
    ids.add(id);
    groups.push({ id, length });
  }
  return groups;
}

function savedPoint(savedPositions, id) {
  const point = savedPositions instanceof Map ? savedPositions.get(id)
    : savedPositions && Object.hasOwn(savedPositions, id) ? savedPositions[id] : undefined;
  return point && finite(point.x) && point.x >= 0 && finite(point.y) && point.y >= 0 ? point : null;
}

function geometry(groups, scale) {
  const groupHeight = 54 * scale + (scale < 0.7 ? 10 : 14 * scale) + 4 * scale;
  return [...groups.map(({ id, length }) => ({ id,
    width: Math.max((42 * length - 4) * scale, 80 * scale), height: groupHeight })),
  { width: Math.max(44, 90 * scale), height: Math.max(44, groupHeight) }];
}

function pack(items, width, scale) {
  const gap = 38 * scale;
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return items.map((item) => {
    if (rowHeight && x + gap + item.width > width + EPSILON) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    if (rowHeight) x += gap;
    const position = { ...item, x, y };
    x += item.width;
    rowHeight = Math.max(rowHeight, item.height);
    return position;
  });
}

function positionedLayout(groups, width, height, scale, savedPositions, hasSaved) {
  const items = geometry(groups, scale);
  const automatic = pack(items, width, scale);
  let placed = automatic;
  if (hasSaved) {
    placed = new Array(items.length);
    const occupied = [];
    const put = (index, desired, availableWidth, availableHeight = Infinity, gap = 38 * scale) => {
      const point = placeGroup(items[index], desired, occupied,
        { width: availableWidth, height: availableHeight, gap });
      placed[index] = { ...items[index], x: point.x, y: point.y };
      occupied.push(placed[index]);
    };
    // Existing positions take priority and retain the same one-tile clearance
    // as automatic/new placement. Enlarged or closely saved groups move only
    // enough to clear their neighbors. Do not clamp them to a smaller viewport:
    // uniform scaling preserves already well-spaced arrangements.
    groups.forEach((group, index) => {
      const point = savedPoint(savedPositions, group.id);
      if (point) put(index, { x: point.x * scale, y: point.y * scale }, Infinity, Infinity);
    });
    groups.forEach((group, index) => {
      if (!placed[index]) put(index, automatic[index], width, height);
    });
    put(items.length - 1, automatic.at(-1), width, height);
  }
  const contentWidth = Math.max(0, ...placed.map((rect) => rect.x + rect.width));
  const contentHeight = Math.max(0, ...placed.map((rect) => rect.y + rect.height));
  const toView = (rect) => {
    const saved = savedPoint(savedPositions, rect.id);
    // Preserve unchanged stored values exactly instead of multiplying/dividing
    // them into a different floating-point serialization on each resize.
    return { ...rect,
      logicalX: saved && Math.abs(rect.x - saved.x * scale) <= EPSILON ? saved.x : rect.x / scale,
      logicalY: saved && Math.abs(rect.y - saved.y * scale) <= EPSILON ? saved.y : rect.y / scale };
  };
  return {
    scale,
    positions: placed.slice(0, -1).map(toView),
    newTarget: toView(placed.at(-1)),
    contentWidth: Math.round(contentWidth * 1000) / 1000,
    contentHeight: Math.round(contentHeight * 1000) / 1000,
    overflow: contentWidth > width + EPSILON || contentHeight > height + EPSILON,
  };
}

/**
 * groups: lengths, or [{id, length}] with stable UI-owned identities.
 * savedPositions: {[id]: {x,y}} (or Map), in scale-1 logical pixels.
 * width/height and returned rectangles use current rendered pixels; actual
 * logicalX/Y include any collision adjustment. Stale/invalid saved entries
 * are ignored. Inputs are never mutated. The separate newTarget never covers
 * a group. At the .4 limit, oversized arrangements stay scrollable via overflow.
 */
export function arrangeGroups(input, options = {}, savedPositions = {}) {
  const groups = normalizeGroups(input);
  const settings = options && typeof options === 'object' ? options : {};
  const width = viewportSize(settings.width);
  const height = viewportSize(settings.height);
  const hasSaved = groups.some((group) => savedPoint(savedPositions, group.id));
  if (!hasSaved || settings.large === true || !groups.length) {
    const scale = settings.large === true ? 1
      : fitBoard(groups.map((group) => group.length), { width, height }).scale;
    return positionedLayout(groups, width, height, scale, savedPositions, hasSaved);
  }
  for (let step = 50; step >= 20; step -= 1) {
    const layout = positionedLayout(groups, width, height, step / 50, savedPositions, true);
    if (!layout.overflow || step === 20) return layout;
  }
}

/** Remove only unused saved-origin margins in a smaller view. Logical points
 * remain in the shared coordinate system; display offsets are view-only.
 */
function projectedSavedOrigin(groups, width, height, savedPositions, previous) {
  if (!width || !height || previous.scale >= 1 - EPSILON || !groups.length) return null;
  // Compute the unchanged shape at full logical size. Merely increasing the
  // previous canvasScale would retain the .4 minimum already chosen for margins.
  const raw = positionedLayout(groups, width, height, 1, savedPositions, true);
  const minX = Math.min(...raw.positions.map(rect => rect.x));
  const minY = Math.min(...raw.positions.map(rect => rect.y));
  if (minX <= EPSILON && minY <= EPSILON) return null;
  const local = raw.positions.map(rect => ({ ...rect, x: rect.x - minX, y: rect.y - minY }));
  const spanWidth = Math.max(...local.map(rect => rect.x + rect.width));
  const spanHeight = Math.max(...local.map(rect => rect.y + rect.height));
  const upper = Math.min(1, width / spanWidth, height / spanHeight);
  const targetFor = factor => placeGroup(raw.newTarget, { x: 0, y: 0 }, local,
    { width: width / factor, height: height / factor, gap: 38 });
  const fits = factor => {
    const target = targetFor(factor);
    return target.x + target.width <= width / factor + EPSILON
      && target.y + target.height <= height / factor + EPSILON;
  };
  let low = 0, high = upper;
  if (fits(upper)) low = upper;
  else for (let iteration = 0; iteration < 36; iteration++) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle; else high = middle;
  }
  const factor = low;
  // A quantized arrangeGroups step may slightly understate the full-size
  // shape's feasible factor. Only margins that actually limit the continuous
  // absolute group bounds justify moving the view, never that rounding alone.
  const absoluteUpper = Math.min(1,
    width / Math.max(...raw.positions.map(rect => rect.x + rect.width)),
    height / Math.max(...raw.positions.map(rect => rect.y + rect.height)));
  if (!(factor > previous.scale + EPSILON && factor > absoluteUpper + EPSILON)) return null;
  const target = targetFor(factor);
  const projected = raw.positions.map(rect => ({ ...rect,
    x: (rect.x - minX) * factor, y: (rect.y - minY) * factor,
    width: rect.width * factor, height: rect.height * factor }));
  return { scale: factor, baseScale: 1, canvasScale: factor,
    displayOffsetX: -minX * factor, displayOffsetY: -minY * factor,
    positions: projected,
    newTarget: { ...target, x: target.x * factor, y: target.y * factor,
      width: target.width * factor, height: target.height * factor,
      logicalX: target.x + minX, logicalY: target.y + minY },
    contentWidth: Math.max(spanWidth, target.x + target.width) * factor,
    contentHeight: Math.max(spanHeight, target.y + target.height) * factor,
    overflow: false, readable: factor >= 0.65 };
}

/** Shared coordinates for persistence; display coordinates for an actual edit.
 * Resizing alone may reflow the local view, but cannot rearrange another player's
 * table or serialize that temporary projection as a new public layout.
 */
export function boardLayoutPositions(layout, { display = false } = {}) {
  return Object.fromEntries(layout.positions.map(point => [point.id, {
    x: display ? point.logicalX : point.sharedLogicalX ?? point.logicalX,
    y: display ? point.logicalY : point.sharedLogicalY ?? point.logicalY,
  }]));
}

/** Fixed-screen game overview. Keep every group visible, including very dense
 * tables or far-apart user positions; inspection supplies readable larger cards.
 * canvasScale is applied to the whole canvas, so headers scale with the tiles.
 */
export function fitGroupsToViewport(input, options = {}, savedPositions = {}) {
  const width = viewportSize(options.width), height = viewportSize(options.height);
  const groups = normalizeGroups(input);
  const hasSaved = groups.some(group => savedPoint(savedPositions, group.id));
  let base;
  if (width && height && !hasSaved) {
    // Reflow in logical space at each candidate scale. Shrinking an already
    // wrapped narrow canvas wastes horizontal room and makes dense tables
    // unnecessarily tiny. Explicit user positions still keep their geometry.
    const fittingFactor = usableWidth => {
      const fits = factor => {
        const layout = positionedLayout(groups, usableWidth / factor, height / factor, 1, {}, false);
        return layout.contentWidth * factor <= usableWidth + EPSILON
          && layout.contentHeight * factor <= height + EPSILON;
      };
      let low=0,high=1;
      if(fits(1))return 1;
      for(let iteration=0;iteration<36;iteration++) {
        const middle=(low+high)/2;
        if(fits(middle))low=middle;else high=middle;
      }
      return Math.max(Number.EPSILON,low);
    };
    const fullFactor=fittingFactor(width);
    let usableWidth=width;
    if(width>=900 && options.focused!==false)for(const fraction of [.65,.75,.85,1]) {
      usableWidth=width*fraction;
      if(fittingFactor(usableWidth)>=fullFactor-EPSILON)break;
    }
    const factor=fittingFactor(usableWidth);
    base = positionedLayout(groups, usableWidth / factor, height / factor, 1, {}, false);
  } else {
    // Resolve saved public groups once in their shared logical space, then
    // scale the whole canvas. Per-device compact header heights must not turn
    // an already safe saved gap into new logical positions on every rotation.
    base = positionedLayout(groups, width, height, 1, savedPositions, hasSaved);
  }
  const rects = [...base.positions, base.newTarget];
  const contentWidth = Math.max(1, ...rects.map(rect => rect.x + rect.width));
  const contentHeight = Math.max(1, ...rects.map(rect => rect.y + rect.height));
  const canvasScale = Math.min(1, width / contentWidth, height / contentHeight);
  const factor = Math.max(0, canvasScale);
  const scaled = rect => ({ ...rect, x: rect.x * factor, y: rect.y * factor, width: rect.width * factor, height: rect.height * factor });
  const result={ ...base, baseScale: base.scale, canvasScale: factor, scale: base.scale * factor,
    positions: base.positions.map(scaled), newTarget: scaled(base.newTarget),
    contentWidth: contentWidth * factor, contentHeight: contentHeight * factor,
    overflow: false, readable: base.scale * factor >= 0.65 };
  if (hasSaved) {
    const projection = projectedSavedOrigin(groups, width, height, savedPositions, result);
    const preserved = projection || result;
    // A tall portrait arrangement must not become a tiny portrait thumbnail
    // inside a wide, shallow landscape table (or vice versa). Prefer the saved
    // shape whenever readable; reflow intact groups only for a material gain.
    // This is a view projection: capture retains the corrected shared points.
    if (width && height && groups.length >= 4 && preserved.scale < 0.65) {
      const shared = new Map(base.positions.map(point => [point.id, point]));
      const readingOrder = groups.map((group, index) => ({ ...group, index }))
        .sort((a, b) => shared.get(a.id).logicalY - shared.get(b.id).logicalY
          || shared.get(a.id).logicalX - shared.get(b.id).logicalX || a.index - b.index);
      const reflow = fitGroupsToViewport(readingOrder, options);
      if (reflow.scale >= preserved.scale * 1.35) {
        const offset = width >= 900 && options.focused !== false ? 0
          : Math.max(0, (width - reflow.contentWidth) / 2);
        const shift = point => ({ ...point, x: point.x + offset,
          logicalX: point.logicalX + offset / reflow.scale });
        const byId = new Map(reflow.positions.map(point => {
          const source = shared.get(point.id);
          return [point.id, { ...shift(point), sharedLogicalX: source.logicalX,
            sharedLogicalY: source.logicalY }];
        }));
        return { ...reflow, positions: groups.map(group => byId.get(group.id)),
          newTarget: shift(reflow.newTarget), contentWidth: reflow.contentWidth + offset,
          adaptiveReflow: true };
      }
    }
    return preserved;
  }
  if(!hasSaved && width>=900 && options.focused!==false && result.scale>0) {
    const offset=Math.max(0,(width-result.contentWidth)/2);
    const centered=rect=>({...rect,x:rect.x+offset,logicalX:rect.logicalX+offset/result.scale});
    result.positions=result.positions.map(centered);result.newTarget=centered(result.newTarget);result.contentWidth+=offset;
  }
  return result;
}
