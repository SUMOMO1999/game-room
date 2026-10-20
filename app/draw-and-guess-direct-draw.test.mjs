import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrawingCanvasView, applyDrawingPacket } from './games/draw-and-guess/canvas-view.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
const scope = { roomId: 'synthetic-room', matchId: 'synthetic-match', turnId: 'synthetic-turn', drawer: true, enabled: true, phase: 'playing', stage: 'drawing' };
function target() { const listeners = new Map(); return { addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }, emit(type, event = {}) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); }, count() { return [...listeners.values()].reduce((n, s) => n + s.size, 0); } }; }
function fixture() {
  let time = 0, serial = 0, saved = { kind: 'replace', bootId: 'boot', canvasId: 'canvas', ...scope, sequence: 0, clearGeneration: 0, leaseGeneration: 0, strokes: [], pointCount: 0, paused: false };
  const timers = new Map(), requests = [], gates = [], statuses = [];
  const timer = (fn, ms, repeat = false) => { const id = ++serial; timers.set(id, { fn, ms, at: time + ms, repeat }); return id; };
  const win = { ...target(), setTimeout: (fn, ms) => timer(fn, ms), clearTimeout: id => timers.delete(id), setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: id => timers.delete(id) };
  const doc = { ...target(), hidden: false };
  const canvas = { ...target(), style: {}, parentElement: { style: {} }, setAttribute() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }), getContext: () => ({ clearRect() {}, save() {}, restore() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {} }) };
  async function request(type, body) {
    requests.push({ type, body: structuredClone(body) });
    if (type === 'read') return structuredClone(saved);
    if (type === 'acquire') return new Promise((resolve, reject) => gates.push({ resolve, reject }));
    assert.equal(type, 'append');
    const packet = { kind: 'append', ...scope, bootId: 'boot', canvasId: 'canvas', sequence: saved.sequence + 1, clearGeneration: saved.clearGeneration, leaseGeneration: saved.leaseGeneration, operations: body.operations };
    saved = applyDrawingPacket(saved, packet, scope).snapshot;
    return { ack: { ...packet, persisted: true, leaseValidUntil: 100000 } };
  }
  const view = createDrawingCanvasView({ canvas, slot: { getBoundingClientRect: () => ({ width: 400, height: 300 }) }, window: win, document: doc, request, deviceId: 'synthetic-device', now: () => time + 1000, monotonicNow: () => time, onStatus: text => statuses.push(text) });
  const pointers=new Map();
  function fire(type, point = {}) {const pointerId=point.pointerId??1,old=pointers.get(pointerId)??{clientX:40,clientY:60},position={clientX:point.clientX??old.clientX,clientY:point.clientY??old.clientY};pointers.set(pointerId,position);canvas.emit(type, { button: 0, pointerId, preventDefault() {}, ...position, ...point });}
  async function ready() { view.setContext(scope); await view.refresh(); await settle(); }
  async function grant(index = gates.length - 1) { saved = { ...saved, leaseGeneration: saved.leaseGeneration + 1 }; gates[index].resolve({ bootId: 'boot', canvasId: 'canvas', leaseGeneration: saved.leaseGeneration, leaseValidUntil: 100000 }); await settle(); }
  async function advance(ms) { const end = time + ms; for (;;) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [id, t] = next; time = t.at; if (t.repeat) t.at += t.ms; else timers.delete(id); t.fn(); await settle(); } time = end; await settle(); }
  const count = type => requests.filter(r => r.type === type).length;
  return { view, canvas, doc, win, requests, statuses, gates, ready, fire, grant, advance, count, get saved() { return saved; }, takeover() { saved = { ...saved, leaseGeneration: saved.leaseGeneration + 1 }; view.receive(structuredClone(saved)); }, destroy() { view.destroy(); assert.equal(timers.size, 0); assert.equal(canvas.count() + doc.count() + win.count(), 0); } };
}

test('first two short marks are previewed while acquire is pending and sent exactly once after its verified response', async () => {
  const f = fixture(); await f.ready(); assert.equal(f.count('acquire'), 0);
  f.fire('pointerdown'); f.fire('pointerup'); f.fire('pointerdown', { clientX: 90 }); f.fire('pointerup');
  assert.equal(f.count('acquire'), 1); assert.equal(f.count('append'), 0); assert.equal(f.view.state().pending, 2);
  await f.advance(1400); assert.equal(f.count('append'), 0);
  await f.grant(); await f.advance(350);
  assert.equal(f.count('append'), 1); assert.equal(f.saved.strokes.length, 2); assert.equal(f.saved.strokes[0].points.length, 1); assert.equal(f.saved.strokes[1].points.length, 1);
  await f.advance(1400); assert.equal(f.count('acquire'), 1); assert.equal(f.count('append'), 1); f.destroy();
});

test('hidden then foreground before delayed acquire resolves does not resurrect a writer or replay preview ink', async () => {
  const f = fixture(); await f.ready(); f.fire('pointerdown'); f.fire('pointerup');
  f.doc.hidden = true; f.doc.emit('visibilitychange'); f.doc.hidden = false; f.doc.emit('visibilitychange');
  await f.grant(); await f.advance(1400);
  assert.equal(f.view.state().ready, false); assert.equal(f.view.state().pending, 0); assert.equal(f.count('append'), 0); assert.equal(f.count('acquire'), 1);
  f.fire('pointerdown'); f.fire('pointerup'); assert.equal(f.count('acquire'), 2); await f.grant(); await f.advance(350);
  assert.equal(f.saved.strokes.length, 1); f.destroy();
});

test('disable then re-enable in the same room generation invalidates a delayed writer intent', async () => {
  const f = fixture(); await f.ready(); f.fire('pointerdown'); f.fire('pointerup');
  f.view.setContext({ ...scope, enabled: false, phase: 'paused' }); await settle();
  f.view.setContext(scope); await f.view.refresh(); await f.grant(); await f.advance(1400);
  assert.equal(f.view.state().ready, false); assert.equal(f.view.state().pending, 0); assert.equal(f.count('append'), 0); assert.equal(f.count('acquire'), 1);
  f.fire('pointerdown'); f.fire('pointerup'); await f.grant(); await f.advance(350); assert.equal(f.saved.strokes.length, 1); f.destroy();
});

test('a newer writer lease stops this device and repeated SSE/read/render do not reclaim it without a new pointer intent', async () => {
  const f = fixture(); await f.ready(); f.fire('pointerdown'); f.fire('pointerup'); await f.grant(); await f.advance(350);
  f.takeover(); assert.equal(f.view.state().ready, false);
  for (let i = 0; i < 5; i++) { f.view.receive(structuredClone(f.saved)); f.view.setContext(scope); await f.view.refresh(); }
  await f.advance(1400); assert.equal(f.count('acquire'), 1); assert.equal(f.count('append'), 1);
  f.fire('pointerdown'); f.fire('pointerup'); assert.equal(f.count('acquire'), 2); await f.grant(); await f.advance(350); assert.equal(f.saved.strokes.length, 2); f.destroy();
});

test('non-drawer, disabled and non-drawing scopes cannot request acquisition through pointer input', async () => {
  for (const extra of [{ drawer: false }, { enabled: false }, { phase: 'paused' }, { stage: 'choosing' }, { stage: 'reveal' }, { stage: 'finished' }]) {
    const f = fixture(); await f.ready(); f.view.setContext({ ...scope, ...extra }); await f.view.refresh(); f.fire('pointerdown'); f.fire('pointermove', { clientX: 90 }); f.fire('pointerup'); await f.advance(1400);
    assert.equal(f.count('acquire'), 0); assert.equal(f.count('append'), 0); f.destroy();
  }
});


test('failed first acquisition discards only preview and permits the next intentional stroke to recover', async () => {
  const f=fixture();await f.ready();f.fire('pointerdown');f.fire('pointermove',{clientX:90});f.fire('pointerup');
  f.gates[0].reject(Object.assign(new Error('重新连接后继续绘画'),{status:401}));await settle();await f.advance(1400);
  assert.equal(f.count('append'),0);assert.equal(f.view.state().pending,0);assert.equal(f.view.state().ready,false);
  f.fire('pointerdown',{clientX:180});f.fire('pointerup');await f.grant();await f.advance(350);
  assert.equal(f.count('acquire'),2);assert.equal(f.saved.strokes.length,1);assert.deepEqual(f.saved.strokes[0].points,[[.45,.2]]);f.destroy();
});

test('a turn change and explicit conceal both invalidate delayed first strokes without writes', async () => {
  for(const kind of ['turn','conceal']) {
    const f=fixture();await f.ready();f.fire('pointerdown');f.fire('pointerup');
    if(kind==='turn')f.view.setContext({...scope,turnId:'next-turn'});else f.view.conceal();
    await f.grant();await f.advance(1400);assert.equal(f.count('append'),0);assert.equal(f.view.state().pending,0);assert.equal(f.view.state().ready,false);f.destroy();
  }
});

test('a long acquisition is bounded at 64 pending strokes and never uploads a second touch as ink', async () => {
  const f=fixture();await f.ready();
  f.fire('pointerdown');f.fire('pointerdown',{pointerId:2,clientX:200});f.fire('pointerup',{pointerId:2});f.fire('pointerup');
  for(let i=1;i<70;i++){f.fire('pointerdown',{clientX:40+i});f.fire('pointerup');}
  assert.equal(f.count('acquire'),1);assert.equal(f.view.state().pending,64);assert.equal(f.count('append'),0);
  await f.grant();await f.advance(1400);assert.equal(f.saved.strokes.length,64);assert.equal(f.saved.strokes[0].points.length,1);f.destroy();
});
