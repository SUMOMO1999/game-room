import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRack, moveRackTiles, moveRackTilesToSlot, rackInsertionIndex, reconcileRackOrder,
  fitFreeRack, normalizeRackPositions, normalizeRackBasis, rebaseFreeRack, placeRackTiles } from './rack-layout.mjs';

const EPSILON = 1e-7;

function checkGeometry(count, width, height, options = {}) {
  const layout = fitRack(count, { width, height, ...options });
  assert.equal(layout.rects.length, count, 'no tile may be hidden or omitted');
  assert.equal(layout.fits, width > 0 && height > 0 || count === 0);
  assert.ok(layout.contentWidth <= width + EPSILON);
  assert.ok(layout.contentHeight <= height + EPSILON);
  const indices = new Set();
  for (const rect of layout.rects) {
    assert.ok([rect.x, rect.y, rect.width, rect.height].every(Number.isFinite));
    assert.ok(rect.x >= -EPSILON && rect.y >= -EPSILON);
    assert.ok(rect.x + rect.width <= width + EPSILON, `tile ${rect.index} leaves the rack horizontally`);
    assert.ok(rect.y + rect.height <= height + EPSILON, `tile ${rect.index} leaves the rack vertically`);
    assert.equal(rect.index, rect.row * layout.columns + rect.column);
    assert.ok(!indices.has(rect.index));
    indices.add(rect.index);
  }
  for (let i = 0; i < layout.rects.length; i += 1) {
    for (let j = i + 1; j < layout.rects.length; j += 1) {
      const a = layout.rects[i], b = layout.rects[j];
      const separate = a.x + a.width <= b.x + EPSILON || b.x + b.width <= a.x + EPSILON
        || a.y + a.height <= b.y + EPSILON || b.y + b.height <= a.y + EPSILON;
      assert.ok(separate, `tiles ${i} and ${j} overlap`);
    }
  }
  return layout;
}

test('14 normal tiles form two full-size balanced rows and keep the partial row on the same rail', () => {
  const layout = checkGeometry(14, 640, 132);
  assert.equal(layout.columns, 7);
  assert.equal(layout.rows, 2);
  assert.equal(layout.tileWidth, 44);
  assert.equal(layout.tileHeight, 64);
  assert.equal(layout.readable, true);
  const odd = checkGeometry(15, 640, 132);
  assert.equal(odd.rows, 2);
  assert.equal(odd.rects[0].x, odd.rects[8].x);
  assert.equal(odd.rects.at(-1).column, 6);
});

test('normal 14 to 30 tile hands and dense 106/159 tile hands fit phone, iPad, and narrow boxes', () => {
  for (const [width, height] of [[560, 104], [720, 154], [944, 178], [320, 74], [1, 1]]) {
    for (const count of [1, 14, 15, 21, 30, 106, 159]) checkGeometry(count, width, height);
  }
  const dense = fitRack(159, { width: 560, height: 104 });
  assert.equal(dense.fits, true);
  assert.equal(dense.readable, false, 'fitting tiny tiles must not be represented as comfortable reading');
});

test('the chosen geometry reaches the largest possible tile size rather than making room by hiding tiles', () => {
  for (const count of [14, 21, 30, 106, 159]) {
    const width = 514, height = 115;
    const layout = fitRack(count, { width, height });
    for (let rows = 1; rows <= count; rows += 1) {
      const columns = Math.ceil(count / rows);
      if (Math.ceil(count / columns) !== rows) continue;
      const candidate = Math.min(1, width / (columns * 44 + (columns - 1) * 4), height / (rows * 64 + (rows - 1) * 4));
      assert.ok(candidate <= layout.scale + EPSILON);
    }
  }
});

test('alignment, aspect ratio and an intentional one-row preference remain configurable', () => {
  const options = { width: 640, height: 132, tileWidth: 40, tileHeight: 60, gap: 5, preferredRows: 1 };
  const layout = fitRack(14, options);
  assert.equal(layout.rows, 1);
  assert.equal(layout.tileWidth, 40);
  assert.equal(layout.tileHeight, 60);
  assert.equal(fitRack(14, { ...options, align: 'start' }).originX, 0);
  assert.equal(fitRack(14, { ...options, align: 'end' }).originX, 640 - layout.contentWidth);
  assert.equal(layout.originX, (640 - layout.contentWidth) / 2);
});

test('zero available size is explicitly unavailable, and empty racks have no ghost row', () => {
  for (const [width, height] of [[0, 100], [100, 0], [0, 0]]) {
    const layout = checkGeometry(14, width, height);
    assert.equal(layout.fits, false);
    assert.equal(layout.readable, false);
    assert.equal(layout.scale, 0);
  }
  const empty = checkGeometry(0, 0, 0);
  assert.equal(empty.rows, 0);
  assert.equal(empty.columns, 0);
  assert.equal(empty.readable, true);
  assert.deepEqual(empty.rects, []);
});

test('invalid tile counts fail clearly; invalid dimensions do not create NaN or infinity', () => {
  for (const count of [-1, 1.5, NaN, Infinity, '14', null]) assert.throws(() => fitRack(count), TypeError);
  for (const options of [{ width: Infinity, height: 100 }, { width: 300, height: NaN }, { width: -1, height: 100 }, null]) {
    const layout = fitRack(14, options);
    assert.equal(layout.fits, false);
    assert.ok(layout.rects.every((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)));
  }
});

test('layout is deterministic and never mutates the caller options', () => {
  const options = Object.freeze({ width: 600.125, height: 121.75, tileWidth: 46.5, tileHeight: 67.75, gap: 3.25 });
  assert.deepEqual(fitRack(29, options), fitRack(29, options));
  checkGeometry(29, options.width, options.height, options);
});

test('a single tile moves before/after target gaps without losing any tile', () => {
  const order = Object.freeze(['A', 'B', 'C', 'D']);
  assert.deepEqual(moveRackTiles(order, ['A'], 2), ['B', 'A', 'C', 'D']);
  assert.deepEqual(moveRackTiles(order, ['C'], 1), ['A', 'C', 'B', 'D']);
  assert.deepEqual(moveRackTiles(order, ['A'], 4), ['B', 'C', 'D', 'A']);
  assert.deepEqual(moveRackTiles(order, ['D'], -10), ['D', 'A', 'B', 'C']);
  assert.deepEqual(moveRackTiles(order, ['A'], 999), ['B', 'C', 'D', 'A']);
  assert.deepEqual(order, ['A', 'B', 'C', 'D']);
});

test('multi-selection retains rack order and adjusts gaps for every removed tile', () => {
  const order = ['A', 'B', 'C', 'D', 'E', 'F'];
  const selection = Object.freeze(['E', 'B', 'E', 'unknown']);
  assert.deepEqual(moveRackTiles(order, selection, 6), ['A', 'C', 'D', 'F', 'B', 'E']);
  assert.deepEqual(moveRackTiles(order, ['D', 'B'], 3), ['A', 'C', 'B', 'D', 'E', 'F']);
  assert.deepEqual(moveRackTiles(order, order.toReversed(), 3), order);
  assert.deepEqual(moveRackTiles(order, [], 3), order);
  assert.deepEqual(moveRackTiles(order, ['unknown'], 3), order);
  assert.deepEqual(moveRackTiles(order, ['C'], NaN), order);
});

test('duplicate and unavailable saved IDs are reconciled without nickname or seat inference', () => {
  assert.deepEqual(reconcileRackOrder(['C', 'C', 'old', 'A'], ['A', 'B', 'C', 'D']), ['C', 'A', 'B', 'D']);
  assert.deepEqual(reconcileRackOrder(['old'], ['B', 'A', 'B']), ['B', 'A']);
  assert.deepEqual(reconcileRackOrder(null, ['A', 'B']), ['A', 'B']);
  assert.deepEqual(reconcileRackOrder(['A'], []), []);
  assert.deepEqual(moveRackTiles(['A', 'B', 'A', 'C'], ['A', 'A'], 3), ['B', 'C', 'A']);
});

test('pointer gaps support tile halves, crossing rows, and empty cells in the final row', () => {
  const layout = fitRack(15, { width: 640, height: 132 });
  const first = layout.rects[0], last = layout.rects.at(-1), secondRow = layout.rects[8];
  assert.equal(rackInsertionIndex(layout, { x: first.x + first.width * .25, y: first.y + 1 }), 0);
  assert.equal(rackInsertionIndex(layout, { x: first.x + first.width * .51, y: first.y + 1 }), 1);
  assert.equal(rackInsertionIndex(layout, { x: first.x + first.width * .75, y: first.y + 1 }), 1);
  assert.equal(rackInsertionIndex(layout, { x: secondRow.x - 1, y: secondRow.y + 1 }), 8);
  assert.equal(rackInsertionIndex(layout, { x: last.x + last.width + 40, y: last.y + 1 }), 15);
  assert.equal(rackInsertionIndex(layout, { x: -1e6, y: -1e6 }), 0);
  assert.equal(rackInsertionIndex(layout, { x: 1e6, y: 1e6 }), 15);
  assert.equal(rackInsertionIndex(layout, {}), 15);
  assert.equal(rackInsertionIndex(fitRack(14, { width: 0, height: 0 }), { x: 1, y: 1 }), 14);
});

test('logical slot movement crosses rack rails and appends at unoccupied final-row positions', () => {
  const order = Array.from({ length: 15 }, (_, index) => `tile-${index}`);
  const layout = fitRack(order.length, { width: 640, height: 132 });
  assert.deepEqual(moveRackTilesToSlot(order, ['tile-0', 'tile-1'], layout, { row: 1, column: 0 }), [
    'tile-2', 'tile-3', 'tile-4', 'tile-5', 'tile-6', 'tile-7', 'tile-0', 'tile-1',
    'tile-8', 'tile-9', 'tile-10', 'tile-11', 'tile-12', 'tile-13', 'tile-14',
  ]);
  assert.deepEqual(moveRackTilesToSlot(order, ['tile-0'], layout, { row: 1, column: 7 }), [...order.slice(1), 'tile-0']);
  assert.deepEqual(moveRackTilesToSlot(order, ['tile-0'], layout, { row: Infinity, column: 0 }), order);
});

test('every selection/gap combination conserves unique tile IDs and their relative order', () => {
  const order = ['A', 'B', 'C', 'D', 'E'];
  for (let mask = 0; mask < 2 ** order.length; mask += 1) {
    const selection = order.filter((_, index) => mask & 1 << index);
    for (let index = 0; index <= order.length; index += 1) {
      const result = moveRackTiles(order, selection.toReversed(), index);
      assert.deepEqual([...result].sort(), order);
      assert.equal(new Set(result).size, order.length);
      assert.deepEqual(result.filter((id) => selection.includes(id)), selection);
      assert.deepEqual(result.filter((id) => !selection.includes(id)), order.filter((id) => !selection.includes(id)));
    }
  }
});

test('free hand coordinates sanitize unavailable IDs and clamp positions without accepting corrupt coordinates', () => {
  assert.deepEqual(normalizeRackPositions({ A:{x:2,y:-1,z:9000}, B:{x:NaN,y:.5},
    C:{x:.3,y:.6,z:1}, D:{x:.2,y:.4}, foreign:{x:.1,y:.1} }, ['A','B','C','D']),
    {D:{x:.2,y:.4,z:0},C:{x:.3,y:.6,z:1},A:{x:1,y:0,z:2}});
  assert.deepEqual(normalizeRackPositions(null,['A']),{});
});
test('free drops follow any precise location rather than insertion gaps and raise only the moved group', () => {
  const layout=fitFreeRack(['A','B','C'],{}, {width:600,height:150});
  const positions=placeRackTiles(layout,['B'],{x:341.25,y:61.5},'B');
  const moved=fitFreeRack(['A','B','C'],positions,{width:600,height:150});
  const b=moved.rects.find(rect=>rect.id==='B');assert.ok(Math.abs(b.x-341.25)<EPSILON);assert.ok(Math.abs(b.y-61.5)<EPSILON);
  for(const id of ['A','C']) {
    const original=layout.rects.find(rect=>rect.id===id),current=moved.rects.find(rect=>rect.id===id);
    assert.equal(current.x,original.x);assert.equal(current.y,original.y);assert.ok(current.z<b.z);
  }
});
test('free positions keep the whole tile reachable at every edge and across portrait/landscape changes', () => {
  for(const count of [1,14,22,50,159]) {
    const ids=Array.from({length:count},(_,index)=>`tile-${index}`);
    const positions=Object.fromEntries(ids.map((id,index)=>[id,{x:index%2,y:index%3/2,z:index}]));
    for(const [width,height]of [[220,95],[600,130],[1050,190],[320,170]]) {
      const layout=fitFreeRack(ids,positions,{width,height});
      assert.equal(layout.rects.length,count);assert.equal(new Set(layout.rects.map(rect=>rect.id)).size,count);
      for(const rect of layout.rects) {
        assert.ok(rect.x>=0 && rect.y>=0);assert.ok(rect.x+rect.width<=width+EPSILON);assert.ok(rect.y+rect.height<=height+EPSILON);
        assert.equal(layout.positions[rect.id].x,positions[rect.id].x);assert.equal(layout.positions[rect.id].y,positions[rect.id].y);
      }
    }
  }
});
test('new and returned tiles find a vacant space while remembered manual tiles retain their normalized positions', () => {
  const first=fitFreeRack(['A','B'],{A:{x:.05,y:.7,z:0},B:{x:.8,y:.1,z:1}},{width:600,height:150});
  const added=fitFreeRack(['A','B','new','returned'],first.positions,{width:600,height:150});
  for(const id of ['A','B'])assert.deepEqual(added.positions[id],first.positions[id]);
  const overlap=(a,b)=>a.x<b.width+b.x-EPSILON && b.x<a.width+a.x-EPSILON
    && a.y<b.height+b.y-EPSILON && b.y<a.height+a.y-EPSILON;
  for(const rect of added.rects.filter(rect=>['new','returned'].includes(rect.id))) {
    assert.ok(added.rects.filter(other=>other.id!==rect.id).every(other=>!overlap(rect,other)));
  }
  assert.deepEqual(fitFreeRack(['A'],added.positions,{width:600,height:150}).positions,{A:first.positions.A});
});
test('free multi-selection preserves relative spacing and jointly clamps the selection at rack boundaries', () => {
  const layout=fitFreeRack(['A','B','C'],{A:{x:.1,y:.2},B:{x:.3,y:.4},C:{x:.9,y:.1}},{width:600,height:150});
  const moved=fitFreeRack(['A','B','C'],placeRackTiles(layout,['B','A','missing'],{x:9999,y:-9999},'B'),{width:600,height:150});
  const a=layout.rects.find(rect=>rect.id==='A'),b=layout.rects.find(rect=>rect.id==='B');
  const nextA=moved.rects.find(rect=>rect.id==='A'),nextB=moved.rects.find(rect=>rect.id==='B');
  assert.ok(Math.abs(nextB.x-nextA.x-(b.x-a.x))<EPSILON);assert.ok(Math.abs(nextB.y-nextA.y-(b.y-a.y))<EPSILON);
  assert.ok(Math.abs(nextB.x+nextB.width-600)<EPSILON);assert.equal(nextA.y,0);
  assert.equal(moved.positions.C.x,layout.positions.C.x);assert.equal(moved.positions.C.y,layout.positions.C.y);
});
test('a fully overlapping dense free rack retains every ID and the magnifier signal without shifting its older tiles', () => {
  const ids=Array.from({length:159},(_,index)=>`tile-${index}`);
  const points=Object.fromEntries(ids.slice(0,-1).map((id,z)=>[id,{x:.5,y:.5,z}]));
  const layout=fitFreeRack(ids,points,{width:220,height:100});assert.equal(layout.readable,false);
  assert.equal(layout.rects.length,159);assert.equal(Object.keys(layout.positions).length,159);
  for(const id of ids.slice(0,-1)){assert.equal(layout.positions[id].x,.5);assert.equal(layout.positions[id].y,.5);}
});

test('rotation preserves saved hand coordinates and overlap while returning to the original screen restores exact placement',()=>{
  const ids=Array.from({length:14},(_,i)=>`tile-${i}`);
  const horizontal=fitFreeRack(ids,{}, {width:760,height:105,tileWidth:36.4,tileHeight:51.8,preferredRows:1});
  const positions=placeRackTiles(horizontal,[ids[0]],{x:708,y:40},ids[0]);
  const initial=fitFreeRack(ids,positions,{width:760,height:105,basis:horizontal.basis,tileWidth:36.4,tileHeight:51.8});
  const overlaps=(a,b)=>Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)+EPSILON
    &&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y)+EPSILON;
  for(const [width,height]of [[374,187],[390,168],[1024,130],[760,105]]) {
    const changed=fitFreeRack(ids,positions,{width,height,basis:initial.basis,tileWidth:36.4,tileHeight:51.8});
    assert.deepEqual(changed.positions,initial.positions);assert.deepEqual(changed.basis,initial.basis);
    for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)
      assert.equal(overlaps(changed.rects[i],changed.rects[j]),overlaps(initial.rects[i],initial.rects[j]));
    if(width===760 && height===105)assert.deepEqual(changed.rects,initial.rects);
  }
});
test('eight freely placed portrait tiles reflow as intact readable groups in a shallow landscape rack without saving the projection',()=>{
  const ids=['A','B','C','D','E','F','G','H'],readingOrder=['D','B','A','C','H','G','E','F'];
  const basis={width:350,height:300,tileWidth:36.4,tileHeight:51.8};
  const points=Object.fromEntries(readingOrder.map((id,index)=>[id,{x:(70+index%4*40)/(350-36.4),
    y:(index<4?50:220)/(300-51.8),z:index}]));
  const options={width:760,height:70,basis,tileWidth:36.4,tileHeight:51.8,minReadableWidth:21,minReadableHeight:30};
  const frozen=JSON.stringify({ids,points,basis}),layout=fitFreeRack(ids,points,options);
  assert.equal(layout.adaptiveReflow,true);assert.equal(layout.readable,true);
  assert.equal(layout.tileWidth,36.4);assert.equal(layout.tileHeight,51.8);
  assert.deepEqual(layout.rects.map(rect=>rect.id),ids,'display projection must keep the caller ID mapping');
  assert.deepEqual([...layout.rects].sort((a,b)=>a.x-b.x).map(rect=>rect.id),readingOrder);
  assert.deepEqual(layout.positions,points);assert.deepEqual(layout.basis,basis);
  assert.equal(JSON.stringify({ids,points,basis}),frozen);
  for(const [left,right]of [['D','B'],['B','A'],['A','C'],['H','G'],['G','E'],['E','F']])
    assert.ok(Math.abs(layout.rects.find(rect=>rect.id===right).x-layout.rects.find(rect=>rect.id===left).x-40)<EPSILON);
  const restored=fitFreeRack(ids,layout.positions,{...options,width:350,height:300});
  for(const rect of restored.rects) {
    assert.ok(Math.abs(rect.x-points[rect.id].x*(350-36.4))<EPSILON);
    assert.ok(Math.abs(rect.y-points[rect.id].y*(300-51.8))<EPSILON);
  }
  const editable=rebaseFreeRack(layout),dragged=placeRackTiles(editable,['B'],{x:650,y:12},'B');
  const after=fitFreeRack(ids,dragged,{...options,basis:editable.basis});
  for(const rect of after.rects) {
    const expected=layout.rects.find(previous=>previous.id===rect.id);
    assert.ok(Math.abs(rect.x-(rect.id==='B'?650:expected.x))<EPSILON);
    assert.ok(Math.abs(rect.y-(rect.id==='B'?12:expected.y))<EPSILON);
    assert.equal(rect.width,expected.width);assert.equal(rect.height,expected.height);
  }
});
test('rotation discards only empty margins before changing manual group placement',()=>{
  const ids=['A','B'],basis={width:350,height:300,tileWidth:36.4,tileHeight:51.8};
  const points={A:{x:100/(350-36.4),y:220/(300-51.8),z:0},B:{x:145/(350-36.4),y:220/(300-51.8),z:1}};
  const layout=fitFreeRack(ids,points,{width:760,height:70,basis,tileWidth:36.4,tileHeight:51.8});
  assert.equal(layout.tileWidth,36.4);assert.equal(layout.adaptiveReflow,undefined);
  assert.ok(Math.abs(layout.rects[1].x-layout.rects[0].x-45)<EPSILON);
  assert.equal(layout.rects[0].y,layout.rects[1].y);assert.deepEqual(layout.positions,points);
});
test('dense rotated free hands stay inside the viewport without creating overlap and retain the inspect signal',()=>{
  for(const count of [30,106,159]) {
    const ids=Array.from({length:count},(_,index)=>`tile-${index}`);
    const first=fitFreeRack(ids,{}, {width:350,height:300});
    const layout=fitFreeRack(ids,first.positions,{width:760,height:55,basis:first.basis});
    assert.deepEqual(layout.positions,first.positions);assert.equal(layout.rects.length,count);
    for(const rect of layout.rects) {
      assert.ok(rect.x>=-EPSILON && rect.y>=-EPSILON);
      assert.ok(rect.x+rect.width<=760+EPSILON && rect.y+rect.height<=55+EPSILON);
      for(const other of layout.rects.filter(other=>other.id!==rect.id))assert.ok(
        rect.x+rect.width<=other.x+EPSILON || other.x+other.width<=rect.x+EPSILON
        || rect.y+rect.height<=other.y+EPSILON || other.y+other.height<=rect.y+EPSILON);
    }
    if(count>=106)assert.equal(layout.readable,false);
  }
});
test('a hand move can use the whole new viewport while rebasing leaves the other displayed tiles unmoved',()=>{
  const ids=['A','B','C'],first=fitFreeRack(ids,{}, {width:760,height:105});
  const positions=placeRackTiles(first,['A'],{x:690,y:30},'A');
  const rotated=fitFreeRack(ids,positions,{width:374,height:187,basis:first.basis});
  const rebased=rebaseFreeRack(rotated),moved=placeRackTiles(rebased,['A'],{x:300,y:150},'A');
  const next=fitFreeRack(ids,moved,{width:374,height:187,basis:rebased.basis});
  for(const id of ['B','C']) {
    const old=rotated.rects.find(rect=>rect.id===id),current=next.rects.find(rect=>rect.id===id);
    assert.ok(Math.abs(current.x-old.x)<EPSILON);assert.ok(Math.abs(current.y-old.y)<EPSILON);
    assert.ok(Math.abs(current.width-old.width)<EPSILON);assert.ok(Math.abs(current.height-old.height)<EPSILON);
  }
  assert.ok(Math.abs(next.rects.find(rect=>rect.id==='A').y-Math.min(150,next.height-next.tileHeight))<EPSILON);
  for(const bad of [null,[],{width:760,height:105,tileWidth:Infinity,tileHeight:64},
    {width:10,height:10,tileWidth:44,tileHeight:64}])assert.equal(normalizeRackBasis(bad),null);
});

test('sorted complete hand combinations have exactly a tile-wide boundary; remaining loose cards keep normal gaps',()=>{
  const layout=fitRack(12,{width:1000,height:64,preferredRows:1,groupBreaks:[3,6,9]});
  assert.equal(layout.scale,1);assert.equal(layout.rows,1);
  for(const index of [3,6,9])assert.ok(Math.abs(layout.rects[index].x-layout.rects[index-1].x-layout.tileWidth-layout.tileWidth)<EPSILON);
  for(const index of [1,2,4,5,7,8,10,11])assert.ok(Math.abs(layout.rects[index].x-layout.rects[index-1].x-layout.tileWidth-layout.gap)<EPSILON);
});
test('grouped hand fitting keeps each complete combination on one row, exposes every dense tile and maps actual rectangle gaps',()=>{
  for(const count of [12,159]) {
    const groupBreaks=Array.from({length:count/3},(_,i)=>(i+1)*3);
    const layout=fitRack(count,{width:320,height:100,groupBreaks});assert.equal(layout.rects.length,count);
    for(const end of groupBreaks)assert.equal(new Set(layout.rects.slice(end-3,end).map(rect=>rect.row)).size,1);
    for(const rect of layout.rects) {
      assert.ok(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=320+EPSILON && rect.y+rect.height<=100+EPSILON);
      assert.equal(rackInsertionIndex(layout,{x:rect.x+rect.width*.25,y:rect.y+rect.height/2}),rect.index);
      assert.equal(rackInsertionIndex(layout,{x:rect.x+rect.width*.75,y:rect.y+rect.height/2}),rect.index+1);
    }
    const order=layout.rects.map(rect=>`tile-${rect.index}`),last=layout.rects.at(-1);
    assert.deepEqual(moveRackTilesToSlot(order,[order[0]],layout,{row:last.row,column:last.column+1}),[...order.slice(1),order[0]]);
  }
});
test('sorted-group metadata never shifts an already freely placed private hand or changes its saved canvas',()=>{
  const ids=['A','B','C','D','E','F'],first=fitFreeRack(ids,{}, {width:600,height:150});
  const positions=placeRackTiles(first,['B'],{x:311,y:71},'B'),options={width:374,height:187,basis:first.basis};
  assert.deepEqual(fitFreeRack(ids,positions,{...options,groupBreaks:[3,6]}),fitFreeRack(ids,positions,options));
});
