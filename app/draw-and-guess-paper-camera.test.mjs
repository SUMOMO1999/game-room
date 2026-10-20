import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrawingPaperCamera } from './games/draw-and-guess/paper-camera.mjs';
import { createDrawingCanvasView, normalizedDrawingPoint } from './games/draw-and-guess/canvas-view.mjs';

function eventTarget() {
  const handlers = new Map();
  return { handlers, addEventListener(type, fn, options) { const list = handlers.get(type) || []; list.push({ fn, capture: options === true || options?.capture === true }); handlers.set(type, list); },
    removeEventListener(type, fn, options) { const capture = options === true || options?.capture === true; handlers.set(type, (handlers.get(type) || []).filter(item => item.fn !== fn || item.capture !== capture)); },
    emit(type, event = {}) { for (const { fn } of [...handlers.get(type) || []]) fn(event); },
    listenerCount() { return [...handlers.values()].reduce((total, list) => total + list.length, 0); } };
}
function harness({ width = 390, height = 300, logicalHeight = 576 } = {}) {
  const win = { ...eventTarget(), setInterval: () => 1, clearInterval() {}, setTimeout: () => 2, clearTimeout() {} }, doc = { ...eventTarget(), hidden: false }, paint = [];
  const slot = { ...eventTarget(), style: { touchAction: 'pan-y', cursor: 'auto' }, scrollLeft: 0, scrollTop: 0, captured: null,
    box: { left: 10, top: 20, width, height }, getBoundingClientRect() { return this.box; },
    setPointerCapture(id) { this.captured = id; }, releasePointerCapture(id) { if (this.captured === id) this.captured = null; } };
  const paper = { style: { width: 'original-width', height: 'original-height' }, parentElement: slot };
  const canvas = { ...eventTarget(), style: {}, width: 1024, height: logicalHeight, parentElement: paper, setPointerCapture() {}, setAttribute() {},
    getBoundingClientRect() { return { left: slot.box.left - slot.scrollLeft, top: slot.box.top - slot.scrollTop,
      width: parseFloat(paper.style.width) || slot.box.width, height: parseFloat(paper.style.height) || slot.box.height }; },
    getContext: () => ({ clearRect() {}, save() {}, restore() {}, beginPath() {}, arc(x, y) { paint.push([x, y]); }, fill() {}, moveTo() {}, lineTo() {}, stroke() {} }) };
  function pointer(type, values = {}) {
    const event = { button: 0, pointerId: 1, clientX: 100, clientY: 100, isPrimary: true, target: canvas, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; }, ...values };
    // Actual capture ordering: ancestor capture precedes target listeners even
    // when the camera is installed after the drawing controller.
    for (const { fn, capture } of [...slot.handlers.get(type) || []]) if (capture) { fn(event); if (event.stopped) return event; }
    for (const { fn } of [...canvas.handlers.get(type) || []]) { fn(event); if (event.stopped) return event; }
    for (const { fn, capture } of [...slot.handlers.get(type) || []]) if (!capture) { fn(event); if (event.stopped) return event; }
    return event;
  }
  return { win, doc, slot, paper, canvas, pointer, paint };
}
const approximate = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} should equal ${expected}`);

test('fit contains the full 16:9 or legacy 4:3 paper and zoom changes only parent display pixels', () => {
  const h = harness(), changes = [];
  const camera = createDrawingPaperCamera({ ...h, window: h.win, document: h.doc, onChange: value => changes.push(value) });
  assert.deepEqual(camera.fit({ width: 1024, height: 576 }), { width: 390, height: 219.375 });
  assert.equal(h.paper.style.width, '390px'); assert.equal(h.paper.style.height, '219.375px');
  camera.setZoom(1.5); assert.deepEqual(camera.fit(), { width: 585, height: 329.0625 });
  camera.setZoom(2); assert.deepEqual(camera.fit({ geometry: { width: 1024, height: 768 } }), { width: 780, height: 585 });
  assert.equal(h.canvas.width, 1024); assert.equal(h.canvas.height, 576, 'camera never changes canvas backing geometry');
  assert.equal(changes.at(-1).zoom, 2); assert.equal(changes.at(-1).pan, false);
  camera.reset(); assert.deepEqual(camera.fit(), { width: 390, height: 292.5 });
  h.slot.box = { ...h.slot.box, width: 300, height: 120 }; const short = camera.fit({ width: 1024, height: 576 }); approximate(short.width, 640 / 3); approximate(short.height, 120);
  const retained = camera.state(); retained.zoom = 99; assert.equal(camera.state().zoom, 1);
  camera.destroy();
});

test('zoom preserves the visible paper center, not a cropped bitmap; full view always resets scroll and panning', () => {
  const h = harness(), sequence = [];
  const camera = createDrawingPaperCamera({ canvas: h.canvas, slot: h.slot, window: h.win, document: h.doc,
    onBeforeChange: () => sequence.push('finish-pointer'), onChange: value => sequence.push(`view-${value.zoom}-${value.pan}`) });
  camera.fit({ width: 1024, height: 576 }); camera.setZoom(2);
  approximate(h.slot.scrollLeft, 195); approximate(h.slot.scrollTop, 69.375);
  h.slot.scrollLeft = 100; h.slot.scrollTop = 40;
  const center = { x: (100 + 195) / 780, y: (40 + 150) / 438.75 };
  camera.setZoom(1.5);
  approximate(h.slot.scrollLeft, 585 * center.x - 195); approximate(h.slot.scrollTop, Math.max(0, 329.0625 * center.y - 150));
  camera.setPan(true); assert.equal(camera.state().pan, true); assert.equal(h.slot.style.touchAction, 'none');
  camera.reset(); assert.equal(camera.state().zoom, 1); assert.equal(camera.state().pan, false);
  assert.equal(h.slot.scrollLeft, 0); assert.equal(h.slot.scrollTop, 0); assert.equal(h.slot.style.touchAction, 'pan-y');
  assert.equal(sequence[0], 'finish-pointer'); assert.equal(sequence[1], 'view-2-false');
  const before = sequence.length; camera.setPan(true); assert.equal(sequence.length, before, 'fit view cannot enter pan mode');
  assert.throws(() => camera.setZoom(1.25), RangeError); assert.throws(() => camera.setPan('true'), TypeError);
  assert.throws(() => camera.fit({ width: 1024, height: 600 }), TypeError); assert.equal(camera.state().zoom, 1);
  camera.destroy();
});

test('capture panning moves scroll within real paper bounds and never delivers a pointer to the drawing target', () => {
  const h = harness(), delivered = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) h.canvas.addEventListener(type, () => delivered.push(type));
  const camera = createDrawingPaperCamera({ ...h, window: h.win, document: h.doc }); camera.fit(); camera.setZoom(2); camera.setPan(true);
  const down = h.pointer('pointerdown', { clientX: 200, clientY: 160 });
  assert.equal(down.defaultPrevented, true); assert.equal(camera.state().dragging, true); assert.equal(h.slot.captured, 1);
  h.pointer('pointermove', { clientX: 150, clientY: 100 }); approximate(h.slot.scrollLeft, 245); approximate(h.slot.scrollTop, 129.375);
  h.pointer('pointermove', { clientX: -10000, clientY: -10000 }); approximate(h.slot.scrollLeft, 390); approximate(h.slot.scrollTop, 138.75);
  h.pointer('pointerup'); assert.equal(camera.state().dragging, false); assert.equal(h.slot.captured, null); assert.deepEqual(delivered, []);
  camera.setPan(false); h.pointer('pointerdown'); assert.deepEqual(delivered, ['pointerdown']);
  const box = h.canvas.getBoundingClientRect(); const point = normalizedDrawingPoint({ clientX: box.left + box.width * 0.7, clientY: box.top + box.height * 0.2 }, box);
  approximate(point[0], 0.7); approximate(point[1], 0.2); camera.destroy();
});

test('multi-touch, cancellation, hidden and pagehide stop dragging without allowing stale movement or accidental drawing', () => {
  for (const reason of ['multi', 'cancel', 'lost', 'hidden', 'pagehide']) {
    const h = harness(), camera = createDrawingPaperCamera({ ...h, window: h.win, document: h.doc }); camera.fit(); camera.setZoom(2); camera.setPan(true);
    h.pointer('pointerdown'); assert.equal(camera.state().dragging, true);
    if (reason === 'multi') h.pointer('pointerdown', { pointerId: 2, isPrimary: false });
    if (reason === 'cancel') h.pointer('pointercancel');
    if (reason === 'lost') h.pointer('lostpointercapture', { target: h.slot });
    if (reason === 'hidden') { h.doc.hidden = true; h.doc.emit('visibilitychange'); }
    if (reason === 'pagehide') h.win.emit('pagehide');
    assert.equal(camera.state().dragging, false, reason); const position = [h.slot.scrollLeft, h.slot.scrollTop];
    h.pointer('pointermove', { clientX: 20, clientY: 30 }); assert.deepEqual([h.slot.scrollLeft, h.slot.scrollTop], position, reason);
    h.pointer('pointerup'); h.pointer('pointerup', { pointerId: 2 }); h.doc.hidden = false;
    h.pointer('pointerdown', { pointerId: 3 }); assert.equal(camera.state().dragging, true); camera.destroy();
  }
});

test('camera installed after the real canvas controller blocks writer acquisition while panning and returns directly to drawing', async () => {
  const h = harness(), calls = [], scope = { roomId: 'room', matchId: 'match', turnId: 'turn', drawer: true, enabled: true, phase: 'playing', stage: 'drawing' };
  const saved = { bootId: 'boot', canvasId: 'canvas', ...scope, paused: false, geometry: { width: 1024, height: 576 },
    sequence: 0, clearGeneration: 0, leaseGeneration: 1, strokes: [], pointCount: 0, deadline: 999999 };
  const view = createDrawingCanvasView({ canvas: h.canvas, slot: h.slot, window: h.win, document: h.doc, now: () => 1000, monotonicNow: () => 0,
    deviceId: 'synthetic-camera', request: async type => { calls.push(type); if (type === 'read') return structuredClone(saved);
      if (type === 'acquire') return { bootId: 'boot', canvasId: 'canvas', leaseGeneration: 1, leaseValidUntil: 16000 }; throw new Error('No upload expected'); } });
  view.setContext(scope); await view.refresh();
  const camera = createDrawingPaperCamera({ ...h, window: h.win, document: h.doc, onBeforeChange: () => view.finishPointer() });
  try {
    camera.fit(saved.geometry); camera.setZoom(2); camera.setPan(true);
    h.pointer('pointerdown'); h.pointer('pointermove', { clientX: 50 }); h.pointer('pointerup');
    assert.equal(calls.filter(type => type === 'acquire').length, 0); assert.equal(view.state().pending, 0);
    camera.setPan(false); const box = h.canvas.getBoundingClientRect();
    h.pointer('pointerdown', { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 });
    assert.equal(calls.filter(type => type === 'acquire').length, 1); assert.equal(view.state().pending, 1);
    assert.ok(h.paint.some(([x, y]) => x === 512 && y === 288), 'real local ink uses the enlarged and scrolled canvas rectangle');
    h.pointer('pointerup'); await new Promise(resolve => setImmediate(resolve));
  } finally { camera.destroy(); view.destroy(); }
});

test('destroy releases capture, restores owned inline styles and removes every listener; hidden zero-size fit remains finite', () => {
  const h = harness(), camera = createDrawingPaperCamera({ ...h, window: h.win, document: h.doc });
  camera.fit(); camera.setZoom(2); camera.setPan(true); h.pointer('pointerdown');
  assert.equal(h.slot.listenerCount(), 5); assert.equal(h.win.listenerCount(), 1); assert.equal(h.doc.listenerCount(), 1);
  camera.destroy(); camera.destroy();
  assert.equal(h.slot.captured, null); assert.equal(h.slot.listenerCount() + h.win.listenerCount() + h.doc.listenerCount(), 0);
  assert.deepEqual(h.paper.style, { width: 'original-width', height: 'original-height' }); assert.deepEqual(h.slot.style, { touchAction: 'pan-y', cursor: 'auto' });
  camera.reset(); assert.equal(h.paper.style.width, 'original-width');
  const zero = harness({ width: 0, height: 0 }), next = createDrawingPaperCamera({ ...zero, window: zero.win, document: zero.doc });
  const size = next.fit(); assert.ok(size.width > 0 && Number.isFinite(size.height)); next.destroy();
});

test('page onChange can re-fit after changing CSS; rotating a magnified paper stops the old drag and preserves the logical aspect', () => {
  const h = harness(), geometry = { width: 1024, height: 576 }; let camera, notifications = 0, finished = 0;
  camera = createDrawingPaperCamera({ ...h, window: h.win, document: h.doc, onBeforeChange: () => finished++,
    onChange: () => { notifications++; camera.fit(geometry); } });
  camera.fit(geometry); camera.setZoom(2); camera.setPan(true); h.pointer('pointerdown');
  assert.equal(camera.state().dragging, true); assert.equal(finished, 2);
  h.slot.box = { ...h.slot.box, width: 740, height: 200 };
  const size = camera.fit(geometry); assert.equal(camera.state().dragging, false); assert.equal(h.slot.captured, null);
  approximate(size.width / size.height, 16 / 9); approximate(size.height, 400); assert.equal(camera.state().zoom, 2);
  const position = [h.slot.scrollLeft, h.slot.scrollTop]; h.pointer('pointermove', { clientX: -100, clientY: -100 });
  assert.deepEqual([h.slot.scrollLeft, h.slot.scrollTop], position);
  camera.reset(); assert.equal(camera.state().zoom, 1); assert.equal(camera.state().pan, false);
  approximate(camera.state().width / camera.state().height, 16 / 9); assert.equal(h.canvas.width, 1024); assert.equal(h.canvas.height, 576);
  assert.ok(notifications < 15, 'fit callbacks never recurse without a state transition'); camera.destroy();
});


test('touch implicit canvas capture can hand off to slot without its child lost event cancelling the new pan', () => {
  const h = harness(), camera = createDrawingPaperCamera({ ...h, window: h.win, document: h.doc });
  camera.fit(); camera.setZoom(2); camera.setPan(true); h.pointer('pointerdown', { pointerType: 'touch' });
  h.pointer('lostpointercapture', { pointerType: 'touch', target: h.canvas });
  assert.equal(camera.state().dragging, true); assert.equal(h.slot.captured, 1);
  const before = h.slot.scrollLeft; h.pointer('pointermove', { pointerType: 'touch', clientX: 50 });
  assert.ok(h.slot.scrollLeft > before, 'slot keeps panning after the child implicit-capture handoff');
  h.pointer('lostpointercapture', { pointerType: 'touch', target: h.slot, pointerId: 2 });
  assert.equal(camera.state().dragging, true, 'an unrelated pointer cannot cancel this capture');
  h.pointer('lostpointercapture', { pointerType: 'touch', target: h.slot });
  assert.equal(camera.state().dragging, false); camera.destroy();
});
