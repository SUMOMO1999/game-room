import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBoard } from './board-layout.mjs';
import { pathToFileURL } from 'node:url';
const tableSource=process.env.GAME_ROOM_UI_TEST_SOURCE_ROOT;
const { arrangeGroups, fitGroupsToViewport, placeGroup, rectanglesIntersect, boardLayoutPositions }=await import(tableSource?new URL('table-layout.mjs',pathToFileURL(tableSource.replace(/\/$/,'')+'/')):new URL('./table-layout.mjs',import.meta.url));

const EPSILON=1e-7;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} ≠ ${expected}`);

function assertFullyVisible(layout, width, height) {
  for (const rect of [...layout.positions, layout.newTarget]) {
    assert.ok(rect.x >= 0 && rect.y >= 0);
    assert.ok(rect.x + rect.width <= width + 1e-7, 'a group escaped the viewport width');
    assert.ok(rect.y + rect.height <= height + 1e-7, 'a group escaped the viewport height');
  }
  assertNoOverlap(layout);
}

test('159 public tiles and the new-group target fit a short phone without hiding or scrolling any group', () => {
  const groups = Array.from({ length: 53 }, (_, i) => ({ id: `g${i}`, length: 3 }));
  const layout = fitGroupsToViewport(groups, { width: 682, height: 110 });
  assert.equal(layout.positions.length, 53); assert.equal(layout.overflow, false);
  assert.ok(layout.canvasScale > 0 && layout.canvasScale < 1);
  assertFullyVisible(layout, 682, 110);
});
test('dense overview reflows across the available width instead of shrinking a narrow wrapped canvas', () => {
  const lengths = [...Array(39).fill(3), 13, 13];
  const layout = fitGroupsToViewport(lengths, { width: 701, height: 75 });
  assertFullyVisible(layout, 701, 75);
  assert.ok(layout.scale >= 0.25, 'a feasible readable scale must not be lost to unused horizontal space');
  assert.ok(layout.contentWidth > 650, 'the short dense table should use its available width');
  assert.equal(layout.positions.length, 41);
});
test('far saved positions remain identifiable, non-overlapping and entirely inside a square device viewport', () => {
  const groups = [{ id: 'run', length: 13 }, { id: 'set', length: 3 }];
  const saved = { run: { x: 9000, y: 12000 }, set: { x: 7000, y: 12000 } };
  const before = structuredClone(saved);
  const layout = fitGroupsToViewport(groups, { width: 540, height: 300 }, saved);
  assertFullyVisible(layout, 540, 300); assert.deepEqual(saved, before);
  assert.equal(layout.positions[0].id, 'run');
  assert.ok(layout.positions[0].x > layout.positions[1].x);
});
test('a fitting table stays full size, and a long unfinished group is also kept entirely visible', () => {
  const regular = fitGroupsToViewport([3, 3], { width: 600, height: 150 });
  assert.equal(regular.scale, 1); assert.equal(regular.canvasScale, 1);
  const long = fitGroupsToViewport([50], { width: 320, height: 100 });
  assertFullyVisible(long, 320, 100); assert.equal(long.positions.length, 1); assert.equal(long.positions[0].id, '0');
});
test('a temporarily hidden viewport has finite zero-sized overview geometry without changing game identities', () => {
  const layout = fitGroupsToViewport([{ id: 'waiting', length: 3 }], { width: 0, height: 0 });
  assert.equal(layout.scale, 0); assert.equal(layout.positions[0].id, 'waiting');
  for (const rect of [...layout.positions, layout.newTarget]) for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(rect[key]));
});

function assertNoOverlap(layout) {
  const rects = [...layout.positions, layout.newTarget];
  for (const [index, rect] of rects.entries()) {
    for (const field of ['x', 'y', 'width', 'height', 'logicalX', 'logicalY']) {
      assert.ok(Number.isFinite(rect[field]) && rect[field] >= 0, `invalid ${field}`);
    }
    near(rect.logicalX * layout.scale + (layout.displayOffsetX || 0), rect.x);
    near(rect.logicalY * layout.scale + (layout.displayOffsetY || 0), rect.y);
    for (const other of rects.slice(index + 1)) {
      assert.equal(rectanglesIntersect(rect, other, 0), false,
        `overlap: ${JSON.stringify(rect)} / ${JSON.stringify(other)}`);
    }
  }
}

test('whole-group automatic placement leaves exactly one logical tile between complete groups', () => {
  const layout = arrangeGroups([3, 3, 3, 3, 3], { width: 890, height: 72 });
  assert.equal(layout.scale, 1);
  assert.equal(layout.overflow, false);
  assert.deepEqual(layout.positions.map(({ x, y, width, height }) => ({ x, y, width, height })),
    [0, 160, 320, 480, 640].map((x) => ({ x, y: 0, width: 122, height: 72 })));
  assert.equal(layout.newTarget.x, 800);
  assert.equal(layout.newTarget.width, 90);
  assert.equal(layout.contentWidth, 890);
  assert.equal(layout.contentHeight, 72);
  assertNoOverlap(layout);
});

test('106 and 159 tiles use the same maximum fitting scale as fitBoard, with no covered target', () => {
  for (const lengths of [[...Array(34).fill(3), 4], Array(53).fill(3)]) {
    const options = { width: 780, height: 180 };
    const expected = fitBoard(lengths, options);
    const layout = arrangeGroups(lengths, options);
    assert.equal(layout.positions.length, lengths.length);
    assert.equal(layout.scale, expected.scale);
    assert.equal(layout.contentHeight, expected.contentHeight);
    assert.equal(layout.overflow, expected.overflow);
    assert.ok(layout.newTarget.width >= 44 && layout.newTarget.height >= 44);
    assertNoOverlap(layout);
  }
});

test('13-tile runs stay intact and large mode preserves full size for scrolling', () => {
  const options = { width: 350, height: 100 };
  const compact = arrangeGroups([{ id: 'long-run', length: 13 }], options);
  assert.equal(compact.scale, 0.52);
  assert.equal(compact.overflow, false);
  near(compact.positions[0].width, 542 * compact.scale);
  assertNoOverlap(compact);
  const large = arrangeGroups([{ id: 'long-run', length: 13 }], { ...options, large: true });
  assert.equal(large.scale, 1);
  assert.equal(large.positions[0].width, 542);
  assert.equal(large.overflow, true);
  assertNoOverlap(large);
  const savedLarge = arrangeGroups([{ id: 'long-run', length: 13 }], { ...options, large: true },
    { 'long-run': { x: 180, y: 25 } });
  assert.equal(savedLarge.scale, 1);
  assert.equal(savedLarge.positions[0].logicalX, 180);
  assert.equal(savedLarge.positions[0].logicalY, 25);
  assert.equal(savedLarge.overflow, true);
  assertNoOverlap(savedLarge);
});

test('stable identities preserve saved logical positions after group order changes', () => {
  const groups = [{ id: 'tile-a|tile-b|tile-c', length: 3 }, { id: 'd|e|f', length: 3 }];
  const saved = { 'tile-a|tile-b|tile-c': { x: 120, y: 40 }, 'd|e|f': { x: 300, y: 200 }, deleted: { x: 9999, y: 9999 } };
  const before = JSON.stringify({ groups, saved });
  for (const input of [groups, [...groups].reverse()]) {
    const layout = arrangeGroups(input, { width: 800, height: 500 }, saved);
    assert.equal(layout.scale, 1);
    for (const position of layout.positions) {
      assert.equal(position.logicalX, saved[position.id].x);
      assert.equal(position.logicalY, saved[position.id].y);
    }
    assertNoOverlap(layout);
  }
  assert.equal(JSON.stringify({ groups, saved }), before, 'the game and saved layout remain unchanged');
});

test('saved arrangements choose the largest fitting scale while retaining relative coordinates', () => {
  const layout = arrangeGroups([{ id: 'a', length: 3 }], { width: 400, height: 100 },
    { a: { x: 600, y: 0 } });
  assert.equal(layout.scale, 0.54);
  assert.equal(layout.overflow, false);
  near(layout.positions[0].x, 600 * 0.54);
  near(layout.positions[0].logicalX, 600);
  assert.ok((600 + 122) * 0.56 > 400, 'the next scale step cannot contain the saved placement');
  assertNoOverlap(layout);
});

test('fixed overview headers trigger actual logical-coordinate adjustment rather than cover a group', () => {
  const layout = arrangeGroups([{ id: 'a', length: 3 }, { id: 'b', length: 3 }],
    { width: 70, height: 100 }, { a: { x: 0, y: 0 }, b: { x: 0, y: 82 } });
  assert.equal(layout.scale, 0.4);
  near(layout.positions[0].height, 33.2);
  near(layout.positions[1].y, 48.4);
  near(layout.positions[1].logicalY, 121);
  assert.equal(layout.newTarget.height, 44);
  assert.equal(layout.overflow, true);
  assertNoOverlap(layout);
});

test('partial saved layouts support an enlarged group and a new split group without overlap', () => {
  const layout = arrangeGroups([{ id: 'a', length: 13 }, { id: 'b', length: 3 }, { id: 'new', length: 3 }],
    { width: 800, height: 400 }, { a: { x: 0, y: 0 }, b: { x: 132, y: 0 } });
  assert.equal(layout.scale, 1);
  assert.equal(layout.overflow, false);
  assert.equal(layout.positions[0].width, 542);
  assert.equal(layout.positions[0].x, 0);
  assert.ok(layout.positions[1].y > 0, 'the old neighbor moves clear of the enlarged run');
  assert.equal(layout.positions[2].id, 'new');
  assertNoOverlap(layout);
});

test('a vacated first-row slot receives the new target and an unsaved group before shrinking the table', () => {
  const groups = [8, 3, 3, 3, 3, 3, 3].map((length, index) => ({ id: `group-${index}`, length }));
  const options = { width: 780, height: 150 };
  const original = arrangeGroups(groups, options);
  assert.equal(original.scale, 0.82);
  const saved = Object.fromEntries(original.positions.map(({ id, logicalX, logicalY }) => [id, { x: logicalX, y: logicalY }]));
  // The 8-tile group fills the second row's old new-target slot. Its original
  // first-row slot is now free, although farther away than a third-row point.
  saved['group-0'] = { x: 480, y: 110 };
  for (const input of [groups, [...groups, { id: 'split-group', length: 3 }]]) {
    const layout = arrangeGroups(input, options, saved);
    assert.equal(layout.scale, original.scale, 'do not shrink solely to keep the new target near its old point');
    assert.equal(layout.overflow, false);
    if(input.length===groups.length) {
      assert.equal(layout.newTarget.y,0);
      assert.ok(layout.newTarget.x+layout.newTarget.width<=original.positions[0].width+1e-7);
    }
    assert.ok(layout.newTarget.x+layout.newTarget.width<=options.width+1e-7);
    assert.ok(layout.newTarget.y+layout.newTarget.height<=options.height+1e-7);
    for (const position of layout.positions.filter(({ id }) => id !== 'split-group')) {
      near(position.logicalX, saved[position.id].x);
      near(position.logicalY, saved[position.id].y);
    }
    if (input.length > groups.length) {
      assert.equal(layout.positions.at(-1).y, 0, 'an unsaved split group also uses the vacated row');
    }
    assertNoOverlap(layout);
  }
});

test('restoring all 53 compact groups remains non-overlapping and includes a free new target', () => {
  const groups = Array.from({ length: 53 }, (_, index) => ({ id: `group-${index}`, length: 3 }));
  const options = { width: 780, height: 240 };
  const original = arrangeGroups(groups, options);
  const saved = new Map(original.positions.map(({ id, logicalX, logicalY }) => [id, { x: logicalX, y: logicalY }]));
  const restored = arrangeGroups(groups, options, saved);
  assert.equal(restored.scale, original.scale);
  assert.equal(restored.overflow, false);
  assertNoOverlap(restored);
});

test('far saved coordinates remain scrollable at the minimum scale; invalid and stale entries are ignored', () => {
  const groups = [{ id: 'a', length: 13 }];
  const layout = arrangeGroups(groups, { width: 100, height: 40 }, { a: { x: 10000, y: 5000 } });
  assert.equal(layout.scale, 0.4);
  assert.equal(layout.overflow, true);
  assert.equal(layout.positions[0].logicalX, 10000);
  assert.equal(layout.positions[0].logicalY, 5000);
  assertNoOverlap(layout);
  const options = { width: 600, height: 100 };
  for (const saved of [{ a: { x: -1, y: 0 } }, { a: { x: NaN, y: 0 } }, { a: { x: 0, y: Infinity } }, { deleted: { x: 9000, y: 9000 } }]) {
    assert.deepEqual(arrangeGroups(groups, options, saved), arrangeGroups(groups, options));
  }
});

test('empty tables and hidden viewports expose finite scroll geometry without mutating or inventing groups', () => {
  const empty = arrangeGroups([], { width: 90, height: 72 });
  assert.equal(empty.scale, 1);
  assert.equal(empty.positions.length, 0);
  assert.deepEqual(empty.newTarget, { width: 90, height: 72, x: 0, y: 0, logicalX: 0, logicalY: 0 });
  assert.equal(empty.overflow, false);
  for (const options of [null, {}, { width: 0, height: 0 }, { width: NaN, height: Infinity }]) {
    const layout = arrangeGroups([3, 13], options);
    assert.equal(layout.scale, 0.4);
    assert.equal(layout.overflow, true);
    assertNoOverlap(layout);
  }
  assert.deepEqual(arrangeGroups([0, -1, '3', NaN, 3.5], { width: 90, height: 72 }), empty);
  assert.throws(() => arrangeGroups([{ id: 'same', length: 3 }, { id: 'same', length: 4 }]), /标识不能重复/);
});

test('edge contact and the exact reserved gap are allowed; a fractional shortfall is moved clear', () => {
  const obstacle = { x: 0, y: 0, width: 122, height: 72 };
  const rect = { width: 122, height: 72 };
  assert.equal(rectanglesIntersect(obstacle, { ...obstacle, x: 122 }), false);
  assert.equal(rectanglesIntersect(obstacle, { ...obstacle, x: 132 }, 10), false);
  assert.equal(rectanglesIntersect(obstacle, { ...obstacle, x: 131.9 }, 10), true);
  assert.equal(rectanglesIntersect(obstacle, { ...obstacle, x: 132 - 1e-8 }, 10), false);
  assert.equal(rectanglesIntersect(null, obstacle), false);
  assert.deepEqual(placeGroup(rect, { x: 132, y: 0 }, [obstacle], { width: 400, gap: 10 }),
    { x: 132, y: 0, ...rect, shifted: false });
  assert.deepEqual(placeGroup(rect, { x: 131.9, y: 0 }, [obstacle], { width: 400, gap: 10 }),
    { x: 132, y: 0, ...rect, shifted: true });
});

test('drop previews clamp to the horizontal canvas, find a nearby gap, and fall down when the row is full', () => {
  const rect = { width: 122, height: 72 };
  const obstacles = [{ x: 0, y: 0, ...rect }];
  const before = JSON.stringify({ rect, obstacles });
  assert.deepEqual(placeGroup(rect, { x: 30, y: 20 }, obstacles, { width: 400, gap: 10 }),
    { x: 30, y: 82, ...rect, shifted: true });
  assert.deepEqual(placeGroup(rect, { x: 0, y: 0 }, obstacles, { width: 122, gap: 10 }),
    { x: 0, y: 82, ...rect, shifted: true });
  assert.deepEqual(placeGroup(rect, { x: 500, y: -5 }, [], { width: 400 }),
    { x: 278, y: 0, ...rect, shifted: true });
  assert.deepEqual(placeGroup(rect, { x: -10, y: -10 }, [], { width: 100 }),
    { x: 0, y: 0, ...rect, shifted: true });
  assert.equal(JSON.stringify({ rect, obstacles }), before);
  assert.throws(() => placeGroup({ width: NaN, height: 72 }), /有限的正数/);
});

test('optional height prefers visible free points even when the preferred point is free below the viewport', () => {
  const rect = { width: 80, height: 72 };
  const obstacles = [{ x: 90, y: 0, ...rect }];
  const desired = { x: 90, y: 82 };
  assert.deepEqual(placeGroup(rect, desired, obstacles, { width: 180 }),
    { ...desired, ...rect, shifted: false }, 'omitting height preserves the unbounded contract');
  assert.deepEqual(placeGroup(rect, desired, obstacles, { width: 180, height: 72 }),
    { x: 0, y: 0, ...rect, shifted: true });
  assert.deepEqual(placeGroup(rect, { x: 100, y: 0 }, obstacles, { width: 180, height: 72 }),
    { x: 0, y: 0, ...rect, shifted: true }, 'a farther visible point wins over the closer point below the row');
  assert.deepEqual(placeGroup(rect, { x: 0, y: 0 }, [{ x: 0, y: 0, ...rect }], { width: 80, height: 72 }),
    { x: 0, y: 82, ...rect, shifted: true }, 'the canvas may grow downward when no visible point is free');
});

test('automatic public groups and their new target have one tile of spacing, including dense fixed-screen tables',()=>{
  for(const [groups,width,height]of [[[3,3],600,150],[Array(53).fill(3),682,110]]) {
    const layout=fitGroupsToViewport(groups,{width,height});assertFullyVisible(layout,width,height);
    const rects=[...layout.positions,layout.newTarget];
    for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++)assert.equal(rectanglesIntersect(rects[i],rects[j],38*layout.scale),false);
  }
});
test('free table saved nearby public groups reserve one tile while already safe coordinates remain exact',()=>{
  const groups=[{id:'a',length:3},{id:'b',length:3}];
  for(const gap of [0,4,37.9,38,90]) {
    const saved={a:{x:100,y:20},b:{x:222+gap,y:20}},before=structuredClone(saved);
    const layout=fitGroupsToViewport(groups,{width:1200,height:400},saved);
    assert.equal(layout.positions[0].logicalX,100);assert.equal(layout.positions[0].logicalY,20);
    assert.equal(rectanglesIntersect(layout.positions[0],layout.positions[1],38*layout.scale),false);
    if(gap>=38) {assert.equal(layout.positions[1].logicalX,saved.b.x);assert.equal(layout.positions[1].logicalY,saved.b.y);}
    else {assert.equal(layout.positions[1].logicalX,260);assert.equal(layout.positions[1].logicalY,20);}
    assertFullyVisible(layout,1200,400);assert.deepEqual(saved,before,'repair cannot mutate the shared input');
  }
});
test('free table growing a saved three-card run leaves one tile before its existing neighbor',()=>{
  const saved={a:{x:100,y:20},b:{x:260,y:20}},before=structuredClone(saved);
  const groups=[{id:'a',length:4},{id:'b',length:3}];
  for(const [width,height]of [[1200,400],[358,600],[701,128]]) {
    const layout=fitGroupsToViewport(groups,{width,height},saved);
    assertFullyVisible(layout,width,height);
    assert.equal(rectanglesIntersect(layout.positions[0],layout.positions[1],38*layout.scale),false);
    assert.equal(layout.positions[0].logicalX,100);assert.equal(layout.positions[0].logicalY,20);
  }
  assert.deepEqual(saved,before);
});
test('free table six mixed manually saved groups keep one tile of clearance through dense and repeated rotated views',()=>{
  const groups=[3,3,3,4,5,3].map((length,i)=>({id:`mixed-${i}`,length}));
  const saved=Object.fromEntries(groups.map((group,i)=>[group.id,{x:[100,222,344,100,264,470][i],y:i<3?20:92}]));
  const before=structuredClone(saved),views=new Map();
  for(const [width,height]of [[358,600],[844,170],[1280,500],[358,600],[682,110],[358,600]]) {
    const layout=fitGroupsToViewport(groups,{width,height},saved),key=`${width}x${height}`;
    assertFullyVisible(layout,width,height);
    const all=[...layout.positions,layout.newTarget];
    for(let i=0;i<all.length;i++)for(const other of all.slice(i+1))assert.equal(rectanglesIntersect(all[i],other,38*layout.scale),false,'manual groups and target need the automatic spacing too');
    if(views.has(key))assert.deepEqual(layout,views.get(key),'rotation cannot progressively push the same saved layout');
    else views.set(key,layout);
  }
  assert.deepEqual(saved,before);
});

test('large automatic tables center their sparse groups in a focused width and expand for dense hands without shrinking the achievable tiles',()=>{
  for(const lengths of [Array(8).fill(3),Array(53).fill(3),[13,13,13,13,13,13,13,13,13,13,13]]) {
    const height=lengths.length===8?300:120,options={width:1200,height};
    const layout=fitGroupsToViewport(lengths,options),full=fitGroupsToViewport(lengths,{...options,focused:false});
    assertFullyVisible(layout,1200,height);assert.ok(layout.scale>=full.scale-EPSILON);
    const rects=[...layout.positions,layout.newTarget],left=Math.min(...rects.map(rect=>rect.x)),right=Math.max(...rects.map(rect=>rect.x+rect.width));
    near(left,1200-right);
    if(lengths.length===8){assert.equal(layout.scale,1);assert.ok(right-left<=1200*.65+EPSILON);}
  }
});


test('a saved centered wide table projects out origin margins on a narrow view while preserving every shared logical coordinate', () => {
  const groups=Array.from({length:7},(_,i)=>({id:`saved-${i}`,length:7}));
  const desktop=fitGroupsToViewport(groups,{width:1266,height:500});
  const saved=Object.fromEntries(desktop.positions.map(p=>[p.id,{x:p.logicalX,y:p.logicalY}]));
  const before=JSON.stringify(saved),narrow=fitGroupsToViewport(groups,{width:358,height:600},saved);
  assert.ok(narrow.adaptiveReflow || narrow.displayOffsetX<0);assert.ok(narrow.scale>.57, 'centering margins must not shrink a feasible 22px card to 14px');
  assertFullyVisible(narrow,358,600);
  assert.deepEqual(boardLayoutPositions(narrow),saved);
  assert.deepEqual(narrow.positions.map(p=>p.id),groups.map(g=>g.id));
  const display=boardLayoutPositions(narrow,{display:true});
  for(const [aIndex,a]of narrow.positions.entries())for(const b of narrow.positions.slice(aIndex+1)) {
    near((a.x-b.x)/narrow.scale,display[a.id].x-display[b.id].x);
    near((a.y-b.y)/narrow.scale,display[a.id].y-display[b.id].y);
  }
  assert.equal(JSON.stringify(saved),before);
  const restored=fitGroupsToViewport(groups,{width:1266,height:500},saved);
  assert.equal(restored.scale,1);assert.equal(restored.displayOffsetX,undefined);assert.equal(restored.displayOffsetY,undefined);
  assert.deepEqual(restored.positions,desktop.positions);
});

test('saved hand-arranged positive x and y margins get a view-only projection without moving, merging or hiding groups', () => {
  const groups=[{id:'far-run',length:13},{id:'far-set',length:3}];
  const saved={'far-run':{x:9000,y:12000},'far-set':{x:8400,y:12110}},before=structuredClone(saved);
  for(let repeat=0;repeat<8;repeat++)for(const [width,height]of[[358,600],[701,128],[682,110],[1266,500]]) {
    const layout=fitGroupsToViewport(groups,{width,height},saved);
    assert.ok(layout.displayOffsetX<0 && layout.displayOffsetY<0);assertFullyVisible(layout,width,height);
    assert.deepEqual(boardLayoutPositions(layout),saved);
    assert.deepEqual(saved,before);
  }
});

test('fitting saved views retain deliberate position while zero-origin dense views keep the previous projection contract', () => {
  const groups=[{id:'a',length:3},{id:'b',length:3}],saved={a:{x:120,y:40},b:{x:300,y:200}};
  const fits=fitGroupsToViewport(groups,{width:800,height:500},saved);assert.equal(fits.scale,1);
  assert.equal(fits.displayOffsetX,undefined);assert.equal(fits.displayOffsetY,undefined);
  assertFullyVisible(fits,800,500);
  for(const [count,length]of[[11,13],[53,3]]) {
    const dense=Array.from({length:count},(_,i)=>({id:`dense-${i}`,length}));
    const first=fitGroupsToViewport(dense,{width:1266,height:500});
    const points=Object.fromEntries(first.positions.map(p=>[p.id,{x:p.logicalX,y:p.logicalY}]));
    const again=fitGroupsToViewport(dense,{width:1266,height:500},points);
    assert.equal(again.displayOffsetX,undefined,'quantized scale improvement alone must not move a dense saved view');
    assert.equal(again.displayOffsetY,undefined);assertFullyVisible(again,1266,500);
  }
  const origin={a:{x:0,y:0},b:{x:0,y:110}},small=fitGroupsToViewport(groups,{width:320,height:60},origin);
  assert.equal(small.displayOffsetX,undefined);assert.equal(small.displayOffsetY,undefined);assertFullyVisible(small,320,60);
});

test('orientation reflow makes an eleven-group forty-one-tile portrait table readable in landscape and back without changing shared points',()=>{
  const groups=[3,3,3,4,4,4,4,4,4,4,4].map((length,i)=>({id:`rotation-${i}`,length}));
  const first=fitGroupsToViewport(groups,{width:358,height:600});
  const saved=Object.fromEntries(first.positions.map(p=>[p.id,{x:p.logicalX,y:p.logicalY}])),before=structuredClone(saved);
  assert.equal(groups.reduce((n,g)=>n+g.length,0),41);
  const shapeHeight=Math.max(...groups.map(g=>saved[g.id].y+72));
  for(const [width,height]of [[358,600],[701,128],[358,600],[701,128],[358,600]]) {
    const layout=fitGroupsToViewport(groups,{width,height},saved);
    assert.equal(layout.adaptiveReflow,true);assertFullyVisible(layout,width,height);
    assert.ok(layout.scale>=(width===358?.85:.6),'the original tiny tall-thumbnail scale cannot pass this readability check');
    if(width===701)assert.ok(layout.scale>=Math.min(1,height/shapeHeight)*1.35,'landscape improves at least35% over uniformly shrinking the original tall group shape');
    assert.deepEqual(boardLayoutPositions(layout),saved);assert.deepEqual(layout.positions.map(p=>p.id),groups.map(g=>g.id));
    assert.notDeepEqual(boardLayoutPositions(layout,{display:true}),saved);
    for(const [i,rect]of layout.positions.entries())for(const other of layout.positions.slice(i+1))assert.equal(rectanglesIntersect(rect,other,38*layout.scale),false);
  }
  assert.deepEqual(saved,before);
});

test('orientation reflow preserves input order and corrected shared coordinates while display reading order follows their saved locations',()=>{
  const groups=[{id:'bottom',length:4},{id:'middle',length:4},{id:'top',length:3},{id:'last',length:3}];
  const saved={top:{x:100,y:0},middle:{x:100,y:110},bottom:{x:100,y:220},last:{x:100,y:330}},before=structuredClone(saved);
  const layout=fitGroupsToViewport(groups,{width:701,height:100},saved);
  assert.equal(layout.adaptiveReflow,true);assertFullyVisible(layout,701,100);
  assert.deepEqual(layout.positions.map(p=>p.id),groups.map(g=>g.id));assert.deepEqual(boardLayoutPositions(layout),saved);
  const display=boardLayoutPositions(layout,{display:true});assert.ok(display.top.x<display.middle.x && display.middle.x<display.bottom.x && display.bottom.x<display.last.x);
  assert.deepEqual(saved,before);
});

test('orientation reflow leaves zero or one group and temporarily zero viewports finite without inventing display edits',()=>{
  for(const groups of [[],[{id:'solo',length:3}]])for(const [width,height]of [[0,0],[358,600],[701,128]]) {
    const saved=groups.length?{solo:{x:120,y:40}}:{},before=structuredClone(saved);
    const layout=fitGroupsToViewport(groups,{width,height},saved);assert.equal(layout.adaptiveReflow,undefined);
    for(const rect of [...layout.positions,layout.newTarget])for(const name of ['x','y','width','height'])assert.ok(Number.isFinite(rect[name]));
    assert.equal(layout.positions.length,groups.length);assert.deepEqual(boardLayoutPositions(layout),saved);assert.deepEqual(saved,before);
  }
  const groups=Array.from({length:11},(_,i)=>({id:`hidden-${i}`,length:3})),saved=Object.fromEntries(groups.map((g,i)=>[g.id,{x:0,y:i*110}]));
  const layout=fitGroupsToViewport(groups,{width:0,height:0},saved);assert.equal(layout.scale,0);assert.equal(layout.adaptiveReflow,undefined);assert.deepEqual(boardLayoutPositions(layout),saved);
});
