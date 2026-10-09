const EPSILON = 1e-9;
const DEFAULT_TILE_WIDTH = 44;
const DEFAULT_TILE_HEIGHT = 64;
const DEFAULT_GAP = 4;

const positive = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
const dimension = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));


// Group ends refer to the sorted hand's complete playable combinations.
// Trailing ungrouped tiles remain individual units with the normal small gap.
function fitGroupedRack(tileCount, ends, settings) {
  const {width,height,tileWidth:tw,tileHeight:th,gap,preferredRows,minReadableWidth,minReadableHeight,align}=settings;
  const units=[];let start=0;
  for(const end of ends){units.push({start,length:end-start,group:true});start=end;}
  for(let index=start;index<tileCount;index++)units.push({start:index,length:1,group:false});
  let best=null;
  for(let capacity=1;capacity<=tileCount;capacity++) {
    const rects=[];let row=0,column=0,x=0,previous=null,contentWidth=0;
    for(const unit of units) {
      if(column && column+unit.length>capacity){contentWidth=Math.max(contentWidth,x);row++;column=0;x=0;previous=null;}
      if(column)x+=previous?.group?tw:gap;
      for(let offset=0;offset<unit.length;offset++) {
        if(offset)x+=gap;
        rects.push({index:unit.start+offset,row,column:column++,x,y:row*(th+gap),width:tw,height:th});x+=tw;
      }
      previous=unit;
    }
    const rows=row+1,fullWidth=Math.max(contentWidth,x),fullHeight=rows*th+(rows-1)*gap;
    const scale=Math.min(1,width/fullWidth,height/fullHeight),preference=Math.abs(rows-preferredRows);
    if(!best || scale>best.scale+EPSILON || Math.abs(scale-best.scale)<=EPSILON
      &&(preference<best.preference || preference===best.preference && rows<best.rows))best={rects,rows,fullWidth,fullHeight,scale,preference};
  }
  const scale=best.scale,tileWidth=tw*scale,tileHeight=th*scale,contentWidth=best.fullWidth*scale,contentHeight=best.fullHeight*scale;
  const originX=align==='start'?0:align==='end'?Math.max(0,width-contentWidth):Math.max(0,(width-contentWidth)/2);
  return {columns:Math.max(...best.rects.map(rect=>rect.column+1)),rows:best.rows,tileWidth,tileHeight,gap:gap*scale,
    groupGap:tileWidth,grouped:true,groupBreaks:ends,scale,contentWidth,contentHeight,originX,
    rects:best.rects.map(rect=>({...rect,x:originX+rect.x*scale,y:rect.y*scale,width:tileWidth,height:tileHeight})),
    fits:width>0 && height>0,readable:tileWidth+EPSILON>=minReadableWidth && tileHeight+EPSILON>=minReadableHeight};
}

/**
 * A row-major rack in local pixel coordinates. Every tile is visible without
 * overlapping another tile or leaving the available rectangle. Dense racks
 * continue shrinking; readable is a separate signal for a magnifier, rather
 * than a reason to hide tiles or fall back to scrolling.
 *
 * Two balanced rows are preferred when they can keep the same tile size as a
 * one-row rack. The last partial row starts in the same column as the first.
 * Layout never changes the order or grouping of the underlying hand.
 */
export function fitRack(tileCount, options = {}) {
  if (!Number.isSafeInteger(tileCount) || tileCount < 0) throw new TypeError('手牌数量必须是非负安全整数');
  const settings = options && typeof options === 'object' ? options : {};
  const width = dimension(settings.width);
  const height = dimension(settings.height);
  const preferredWidth = positive(settings.tileWidth, DEFAULT_TILE_WIDTH);
  const preferredHeight = positive(settings.tileHeight, DEFAULT_TILE_HEIGHT);
  const preferredGap = typeof settings.gap === 'number' && Number.isFinite(settings.gap) && settings.gap >= 0 ? settings.gap : DEFAULT_GAP;
  const preferredRows = Number.isSafeInteger(settings.preferredRows) && settings.preferredRows > 0 ? settings.preferredRows : 2;
  const minReadableWidth = positive(settings.minReadableWidth, 30);
  const minReadableHeight = positive(settings.minReadableHeight, 44);
  const align = ['start', 'end'].includes(settings.align) ? settings.align : 'center';
  if (tileCount === 0) {
    return { columns: 0, rows: 0, tileWidth: preferredWidth, tileHeight: preferredHeight, gap: preferredGap,
      scale: 1, contentWidth: 0, contentHeight: 0, originX: 0, rects: [], fits: true, readable: true };
  }

  const groupEnds=Array.isArray(settings.groupBreaks)?[...new Set(settings.groupBreaks.filter(end=>Number.isSafeInteger(end) && end>0 && end<=tileCount))].sort((a,b)=>a-b):[];
  if(groupEnds.length)return fitGroupedRack(tileCount,groupEnds,{width,height,tileWidth:preferredWidth,tileHeight:preferredHeight,
    gap:preferredGap,preferredRows,minReadableWidth,minReadableHeight,align});
  let best = null;
  for (let rows = 1; rows <= tileCount; rows += 1) {
    const columns = Math.ceil(tileCount / rows);
    // Only consider occupied rows; e.g. 14 tiles with 2 columns have 7 rows,
    // never an eighth empty row that unnecessarily makes the tiles smaller.
    if (Math.ceil(tileCount / columns) !== rows) continue;
    const fullWidth = columns * preferredWidth + (columns - 1) * preferredGap;
    const fullHeight = rows * preferredHeight + (rows - 1) * preferredGap;
    const scale = Math.min(1, width / fullWidth, height / fullHeight);
    const preference = Math.abs(rows - preferredRows);
    if (!best || scale > best.scale + EPSILON || Math.abs(scale - best.scale) <= EPSILON
      && (preference < best.preference || preference === best.preference && rows < best.rows)) {
      best = { columns, rows, scale, preference };
    }
  }

  const tileWidth = preferredWidth * best.scale;
  const tileHeight = preferredHeight * best.scale;
  const gap = preferredGap * best.scale;
  const contentWidth = best.columns * tileWidth + (best.columns - 1) * gap;
  const contentHeight = best.rows * tileHeight + (best.rows - 1) * gap;
  const originX = align === 'start' ? 0 : align === 'end' ? Math.max(0, width - contentWidth) : Math.max(0, (width - contentWidth) / 2);
  const rects = Array.from({ length: tileCount }, (_, index) => {
    const row = Math.floor(index / best.columns);
    const column = index % best.columns;
    return { index, row, column, x: originX + column * (tileWidth + gap), y: row * (tileHeight + gap), width: tileWidth, height: tileHeight };
  });
  return { columns: best.columns, rows: best.rows, tileWidth, tileHeight, gap, scale: best.scale,
    contentWidth, contentHeight, originX, rects, fits: width > 0 && height > 0,
    readable: tileWidth + EPSILON >= minReadableWidth && tileHeight + EPSILON >= minReadableHeight };
}

/** Normalize saved orders against authoritative IDs, retaining existing order. */
export function reconcileRackOrder(orderIds, availableIds) {
  const available = uniqueIds(availableIds);
  const allowed = new Set(available);
  const remembered = uniqueIds(orderIds).filter((id) => allowed.has(id));
  const seen = new Set(remembered);
  return [...remembered, ...available.filter((id) => !seen.has(id))];
}

function uniqueIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
}

/**
 * Move a selection into an original-order insertion gap, 0 through length.
 * Example: moving A in [A,B,C] to gap 2 gives [B,A,C]. Removing selected IDs
 * before that gap shifts its index accordingly. The selection keeps its rack
 * order, even when pointer-selection IDs arrive in a different order.
 * Unknown IDs are ignored; neither input array is mutated.
 */
export function moveRackTiles(orderIds, movedIds, index) {
  const order = uniqueIds(orderIds);
  const movedSet = new Set(uniqueIds(movedIds));
  const moved = order.filter((id) => movedSet.has(id));
  if (!moved.length || !Number.isFinite(index)) return order;
  const target = clamp(Math.trunc(index), 0, order.length);
  const removedBefore = order.slice(0, target).filter((id) => movedSet.has(id)).length;
  const remaining = order.filter((id) => !movedSet.has(id));
  remaining.splice(target - removedBefore, 0, ...moved);
  return remaining;
}

/**
 * Map a pointer in the fitted rack to the nearest original-order gap. Negative
 * or outside coordinates clamp to the row edges; empty positions in the last
 * row map to the end. A drop on the right half of a tile goes after that tile.
 */
export function rackInsertionIndex(layout, point = {}) {
  const count = Array.isArray(layout?.rects) ? layout.rects.length : 0;
  if (!count || !Number.isSafeInteger(layout?.columns) || layout.columns < 1) return 0;
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return count;
  if(layout.grouped) {
    const rows=[...new Set(layout.rects.map(rect=>rect.row))];
    const row=rows.reduce((nearest,value)=>Math.abs(layout.rects.find(rect=>rect.row===value).y+layout.tileHeight/2-point.y)
      <Math.abs(layout.rects.find(rect=>rect.row===nearest).y+layout.tileHeight/2-point.y)?value:nearest,rows[0]);
    const rects=layout.rects.filter(rect=>rect.row===row);
    return rects.find(rect=>point.x<rect.x+rect.width/2)?.index ?? rects.at(-1).index+1;
  }
  const pitchX = layout.tileWidth + layout.gap;
  const pitchY = layout.tileHeight + layout.gap;
  if (!Number.isFinite(pitchX) || pitchX <= 0 || !Number.isFinite(pitchY) || pitchY <= 0) return count;
  const row = clamp(Math.floor((point.y + layout.gap / 2) / pitchY), 0, Math.ceil(count / layout.columns) - 1);
  const originX = Number.isFinite(layout.originX) ? layout.originX : 0;
  const column = clamp(Math.floor((point.x - originX + layout.tileWidth / 2 + layout.gap) / pitchX), 0, layout.columns);
  return Math.min(count, row * layout.columns + column);
}

/** A logical slot means the gap immediately before its row-major tile. */
export function moveRackTilesToSlot(orderIds, movedIds, layout, slot = {}) {
  const order = uniqueIds(orderIds);
  if (!order.length || !Number.isSafeInteger(layout?.columns) || layout.columns < 1
    || !Number.isFinite(slot?.row) || !Number.isFinite(slot?.column)) return order;
  if(layout.grouped) {
    const row=clamp(Math.trunc(slot.row),0,layout.rows-1),rects=layout.rects.filter(rect=>rect.row===row);
    const column=clamp(Math.trunc(slot.column),0,rects.length);
    return moveRackTiles(order,movedIds,rects[column]?.index ?? rects.at(-1).index+1);
  }
  const row = clamp(Math.trunc(slot.row), 0, Math.ceil(order.length / layout.columns) - 1);
  const column = clamp(Math.trunc(slot.column), 0, layout.columns);
  return moveRackTiles(order, movedIds, Math.min(order.length, row * layout.columns + column));
}

/** Device-private coordinates describe the fraction of a tile's movable area
 * within its saved canvas. Reading projections never replace these points. */
export function normalizeRackPositions(value, availableIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = new Set(uniqueIds(availableIds));
  const entries = Object.entries(value).filter(([id, point]) => allowed.has(id)
    && point && typeof point === 'object' && !Array.isArray(point)
    && Number.isFinite(point.x) && Number.isFinite(point.y));
  entries.sort((a, b) => (Number.isSafeInteger(a[1].z) ? a[1].z : 0)
    - (Number.isSafeInteger(b[1].z) ? b[1].z : 0));
  return Object.fromEntries(entries.map(([id, point], z) => [id,
    { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1), z }]));
}
const normalizedRect = (rect, width, height, z = 0) => ({
  x: width > rect.width ? clamp(rect.x / (width - rect.width), 0, 1) : 0,
  y: height > rect.height ? clamp(rect.y / (height - rect.height), 0, 1) : 0, z,
});
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
function emptyRackSpace(layout, occupied) {
  const maxX = Math.max(0, layout.width - layout.tileWidth), maxY = Math.max(0, layout.height - layout.tileHeight);
  const candidates = [];
  const pitchX = layout.tileWidth + layout.gap, pitchY = layout.tileHeight + layout.gap;
  for (let y = 0; y <= maxY + EPSILON; y += pitchY || 1) {
    for (let x = 0; x <= maxX + EPSILON; x += pitchX || 1) candidates.push({ x, y });
  }
  candidates.push({ x: maxX, y: maxY }, { x: maxX, y: 0 }, { x: 0, y: maxY });
  let best = null, bestCost = Infinity;
  for (const point of candidates) {
    const rect = { ...point, width: layout.tileWidth, height: layout.tileHeight };
    const cost = occupied.reduce((sum, item) => sum + overlapArea(rect, item), 0);
    if (cost < bestCost) { best = rect; bestCost = cost; }
    if (cost <= EPSILON) return rect;
  }
  // A densely hand-arranged rack may leave no tile-sized gap. Place only this
  // new tile at the least-covered edge; existing manual positions never move.
  return best ?? { x: 0, y: 0, width: layout.tileWidth, height: layout.tileHeight };
}

/** A optional private canvas basis preserves geometry through rotation. */
export function normalizeRackBasis(value) {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const {width,height,tileWidth,tileHeight}=value;
  if(![width,height,tileWidth,tileHeight].every(n=>Number.isFinite(n) && n>0 && n<=1e6)
    ||tileWidth>width+EPSILON || tileHeight>height+EPSILON)return null;
  return {width,height,tileWidth,tileHeight};
}

function rackBounds(rects) {
  const x=Math.min(...rects.map(rect=>rect.x)),y=Math.min(...rects.map(rect=>rect.y));
  return {x,y,width:Math.max(...rects.map(rect=>rect.x+rect.width))-x,
    height:Math.max(...rects.map(rect=>rect.y+rect.height))-y};
}

// Nearby tiles on the same rail form an intact spatial group. Existing overlap
// also joins groups, so a reading projection cannot alter their stacking.
function rackSpatialGroups(rects, basis) {
  const remaining=new Set(rects),groups=[];
  for(const first of rects) {
    if(!remaining.delete(first))continue;
    const members=[first];
    for(let index=0;index<members.length;index++)for(const other of remaining) {
      const rect=members[index],horizontalGap=Math.max(rect.x,other.x)
        -Math.min(rect.x+rect.width,other.x+other.width);
      if(overlapArea(rect,other)>EPSILON || Math.abs(rect.y-other.y)<=basis.tileHeight/2
        && horizontalGap<=basis.tileWidth*.6) {
        remaining.delete(other);members.push(other);
      }
    }
    groups.push({...rackBounds(members),rects:members});
  }
  return groups.sort((a,b)=>a.y-b.y || a.x-b.x);
}

/** Fit intact manual groups in spatial reading order, keeping their internal
 * distances and z order. Only the returned display rectangles are reflowed. */
function reflowRackGroups(rects, basis, width, height, maximumScale) {
  const groups=rackSpatialGroups(rects,basis),gap=basis.tileWidth;
  const pack=scale=>{
    const availableWidth=width/scale,packed=[];
    let x=0,y=0,rowHeight=0;
    for(const group of groups) {
      if(x && x+group.width>availableWidth+EPSILON){x=0;y+=rowHeight+gap;rowHeight=0;}
      if(group.width>availableWidth+EPSILON || (y+group.height)*scale>height+EPSILON)return null;
      for(const rect of group.rects)packed.push({...rect,x:(x+rect.x-group.x)*scale,
        y:(y+rect.y-group.y)*scale,width:rect.width*scale,height:rect.height*scale});
      x+=group.width+gap;rowHeight=Math.max(rowHeight,group.height);
    }
    return packed;
  };
  let low=0,high=maximumScale;
  if(pack(high))low=high;
  else for(let iteration=0;iteration<36;iteration++) {
    const middle=(low+high)/2;
    if(pack(middle))low=middle;else high=middle;
  }
  const packed=pack(low),bounds=rackBounds(packed),offsetX=Math.max(0,(width-bounds.width)/2);
  return {scale:low,rects:packed.map(rect=>({...rect,x:rect.x+offsetX})),adaptiveReflow:true};
}

/** Normal fitting remains the default. A smaller screen first removes empty
 * canvas margins, then reflows intact manual groups only for a useful reading
 * gain. Saved positions and basis remain unchanged until an explicit move.
 * New/returned IDs find a gap without displacing remembered tiles. */
export function fitFreeRack(orderIds, remembered, options = {}) {
  const ids = uniqueIds(orderIds), width = dimension(options.width), height = dimension(options.height);
  const positions = normalizeRackPositions(remembered, ids), manual = Object.keys(positions).length > 0;
  const fitted = { ...fitRack(ids.length, manual?{...options,groupBreaks:undefined}:options), width, height };
  const basis=normalizeRackBasis(options.basis)
    ?? normalizeRackBasis({width,height,tileWidth:fitted.tileWidth,tileHeight:fitted.tileHeight});
  if (!manual || !basis) {
    const rects = fitted.rects.map((rect, index) => ({ ...rect, id: ids[index], z: index }));
    return { ...fitted, rects, manual, basis, positions: Object.fromEntries(rects.map(rect => [rect.id,
      normalizedRect(rect, width, height, rect.z)])) };
  }
  const maximumScale=Math.min(
    positive(options.tileWidth,DEFAULT_TILE_WIDTH)/basis.tileWidth,
    positive(options.tileHeight,DEFAULT_TILE_HEIGHT)/basis.tileHeight);
  const scale=Math.min(width/basis.width,height/basis.height,maximumScale);
  const canvas={width:basis.width,height:basis.height,tileWidth:basis.tileWidth,tileHeight:basis.tileHeight,
    gap:fitted.gap/Math.max(scale,EPSILON)};
  const rects = ids.filter(id => positions[id]).map(id => ({ id,
    x: positions[id].x * Math.max(0, basis.width - basis.tileWidth),
    y: positions[id].y * Math.max(0, basis.height - basis.tileHeight),
    width: basis.tileWidth, height: basis.tileHeight, z: positions[id].z }));
  let z = rects.length;
  for (const id of ids.filter(id => !positions[id])) {
    const rect = { ...emptyRackSpace(canvas, rects), id, z: z++ };
    rects.push(rect); positions[id] = normalizedRect(rect, basis.width, basis.height, rect.z);
  }
  const scaled=(rect,factor,x=0,y=0)=>({...rect,x:(rect.x-x)*factor,y:(rect.y-y)*factor,
    width:rect.width*factor,height:rect.height*factor});
  let display={scale,rects:rects.map(rect=>scaled(rect,scale))};
  const resized=Math.abs(width-basis.width)>EPSILON || Math.abs(height-basis.height)>EPSILON;
  if(width && height && resized && scale<maximumScale-EPSILON) {
    const bounds=rackBounds(rects);
    const projectedScale=Math.min(maximumScale,width/bounds.width,height/bounds.height);
    if(projectedScale>scale+EPSILON)display={scale:projectedScale,
      rects:rects.map(rect=>scaled(rect,projectedScale,bounds.x,bounds.y))};
    if(display.scale<maximumScale*.75) {
      const reflow=reflowRackGroups(rects,basis,width,height,maximumScale);
      if(reflow.scale>=display.scale*1.25)display=reflow;
    }
  }
  const byId=new Map(display.rects.map(rect=>[rect.id,rect]));
  const tileWidth=basis.tileWidth*display.scale,tileHeight=basis.tileHeight*display.scale;
  return { ...fitted, ...display, tileWidth,tileHeight,basis,rects:ids.map(id=>byId.get(id)),manual,positions,
    readable:fitted.readable && tileWidth+EPSILON>=positive(options.minReadableWidth,30)
      && tileHeight+EPSILON>=positive(options.minReadableHeight,44) };
}

/** A move on a differently shaped screen adopts that screen's full private
 * canvas without changing any existing displayed position or tile size. */
export function rebaseFreeRack(layout) {
  const basis=normalizeRackBasis({width:layout?.width,height:layout?.height,
    tileWidth:layout?.tileWidth,tileHeight:layout?.tileHeight});
  if(!basis)return layout;
  return {...layout,basis,positions:Object.fromEntries(layout.rects.map(rect=>[rect.id,
    normalizedRect(rect,basis.width,basis.height,rect.z)]))};
}

/** Move selected tiles as a spatial group around the grabbed tile, keeping
 * their relative distances. Its bounding rectangle clamps at the rack edges;
 * overlaps are allowed, and the moved group becomes the frontmost layer. */
export function placeRackTiles(layout, movedIds, point = {}, anchorId = null) {
  const rects = Array.isArray(layout?.rects) ? layout.rects : [], ids = rects.map(rect => rect.id);
  const positions = normalizeRackPositions(layout?.positions, ids), moved = new Set(uniqueIds(movedIds));
  const selected = rects.filter(rect => moved.has(rect.id));
  if (!selected.length || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || !layout.width || !layout.height) return positions;
  const anchor = selected.find(rect => rect.id === anchorId) ?? selected[0];
  const x1 = Math.min(...selected.map(rect => rect.x)), y1 = Math.min(...selected.map(rect => rect.y));
  const x2 = Math.max(...selected.map(rect => rect.x + rect.width)), y2 = Math.max(...selected.map(rect => rect.y + rect.height));
  const dx = clamp(point.x - anchor.x, -x1, Math.max(-x1, layout.width - x2));
  const dy = clamp(point.y - anchor.y, -y1, Math.max(-y1, layout.height - y2));
  selected.forEach((rect, index) => { positions[rect.id] = normalizedRect(
    { ...rect, x: rect.x + dx, y: rect.y + dy }, layout.width, layout.height, ids.length + index); });
  return normalizeRackPositions(positions, ids);
}
