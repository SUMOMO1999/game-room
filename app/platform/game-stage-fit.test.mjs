import test from 'node:test';
import assert from 'node:assert/strict';
import { fitGameStage, mountGameStageFit, stagePointFromClient } from './game-stage-fit.mjs';

const profiles = [
  { id: 'touch', match: v => v.inputMode === 'coarse', width: v => v.width, height: v => v.height, scale: false },
  { id: 'wide', match: v => v.width / v.height > 2.2, width: 1680, height: 630 },
  { id: 'standard', width: 1280, height: 640 },
];
test('one composition fits width and height together, with centered unused table space', () => {
  const fit = fitGameStage({ width: 1152, height: 600, profiles });
  assert.equal(fit.scale, .9); assert.equal(fit.offsetX, 0); assert.equal(fit.offsetY, 12);
  assert.equal(fit.unsupported, false);
  assert.deepEqual(stagePointFromClient(fit, { left: 20, top: 30 }, { clientX: 200, clientY: 132 }), { x: 200, y: 100 });
});
test('ultrawide, tablet touch and tiny windows have explicit independent outcomes', () => {
  assert.equal(fitGameStage({ width: 3440, height: 1440, profiles }).profile, 'wide');
  const touch = fitGameStage({ width: 844, height: 320, inputMode: 'coarse', profiles });
  assert.equal(touch.profile, 'touch'); assert.equal(touch.scale, 1); assert.equal(touch.unsupported, false);
  assert.equal(fitGameStage({ width: 900, height: 300, profiles }).unsupported, true);
});
test('a differently shaped third consumer owns its geometry without changing fit behavior', () => {
  const board = fitGameStage({ width: 900, height: 650, profiles: [{ id: 'square-board', width: 600, height: 600 }] });
  assert.equal(board.offsetX, 150); assert.equal(board.offsetY, 25); assert.equal(board.scale, 1);
  assert.throws(() => fitGameStage({ width: 0, height: 650, profiles }), RangeError);
  assert.throws(() => fitGameStage({ width: 900, height: 650, profiles: [{ id: 'none', match: () => false }] }), TypeError);
});

function fixture() {
  const values = new Map(), attrs = new Map(), hostAttrs = new Map(), listeners = new Map(), frames = new Map();
  let width = 1280, height = 640, frameId = 0;
  const style = { getPropertyValue: name => values.get(name) || '', getPropertyPriority: () => '',
    setProperty: (name, value) => values.set(name, value), removeProperty: name => values.delete(name) };
  const node = map => ({ getAttribute: name => map.get(name) ?? null, setAttribute: (name, value) => map.set(name, value), removeAttribute: name => map.delete(name) });
  const host = { ...node(hostAttrs), getBoundingClientRect: () => ({ width, height }) };
  const stage = { ...node(attrs), style };
  const window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    matchMedia: () => ({ matches: false }), requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id) };
  return { host, stage, window, values, frames, listeners, resize(w, h) { width = w; height = h; listeners.get('resize')?.(); },
    flush() { for (const [id, fn] of frames) { frames.delete(id); fn(); } } };
}
test('resizing updates only owned display properties, deduplicates frames and releases listeners', () => {
  const f = fixture(), results = []; f.stage.style.setProperty('width', 'old-width');
  const owner = mountGameStageFit({ ...f, profiles, onFit: fit => results.push(fit) });
  assert.equal(results.length, 1);
  f.resize(1152, 600); f.resize(1152, 600); assert.equal(f.frames.size, 1); f.flush();
  assert.equal(results.length, 2); assert.equal(owner.getFit().scale, .9);
  f.resize(0, 0); f.flush(); assert.equal(results.length, 2);
  f.resize(1280, 640); owner.destroy(); f.flush();
  assert.equal(f.listeners.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.values.get('width'), 'old-width');
  assert.equal(f.values.has('transform'), false); assert.equal(f.stage.getAttribute('data-stage-profile'), null);
  owner.update(); assert.equal(results.length, 2);
});
