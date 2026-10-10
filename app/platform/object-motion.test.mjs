import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjectMotion } from './object-motion.mjs';
import { placementCue } from '../games/rummikub/motion-ui.mjs';

function surface() {
  const animations = [], elements = new Map();
  class Node {
    constructor(rect = { x: 10, y: 20, width: 40, height: 50 }) {
      this.rect = rect; this.style = { visibility: '', setProperty(name, value) { this[name] = value; } };
      this.children = []; this.attributes = {}; this.tagName = 'BUTTON';
    }
    getBoundingClientRect() { return this.rect; }
    cloneNode() { const node = new Node(this.rect); node.attributes = { ...this.attributes }; return node; }
    querySelectorAll() { return []; }
    getAttributeNames() { return Object.keys(this.attributes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(node) { this.children.push(node); node.parent = this; }
    replaceChildren(node) { this.children = []; this.append(node); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    animate(frames, options) {
      let resolve, reject;
      const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
      const animation = { finished, frames, options, resolve, cancel: () => reject(new DOMException('', 'AbortError')) };
      animations.push(animation); return animation;
    }
  }
  const doc = new EventTarget(), win = new EventTarget(), reduced = new EventTarget(), root = new Node();
  doc.createElement = () => new Node(); doc.hidden = false;
  reduced.matches = false; win.matchMedia = () => reduced; win.getComputedStyle = () => ({ length: 0 });
  root.querySelector = selector => elements.get(selector);
  const source = new Node(), target = new Node({ x: 300, y: 120, width: 44, height: 55 });
  source.setAttribute('data-tile', 'lawful-own-tile'); source.setAttribute('data-color', 'blue');
  source.setAttribute('id', 'interactive-source'); elements.set('#target', target);
  return { doc, win, root, reduced, source, target, elements, animations, Node,
    motion: createObjectMotion({ root, document: doc, window: win, maxObjects: 2 }) };
}

test('presentation capture removes identity/actions, preserves only caller-declared visual attributes', () => {
  const s = surface(), captured = s.motion.capture(s.source, { presentationAttributes: ['data-color'] });
  assert.deepEqual(captured.node.attributes, { 'data-color': 'blue', tabindex: '-1' });
  assert.deepEqual(captured.rect, s.source.rect); s.motion.destroy();
});

test('re-render sync restores old nodes and cancellation cannot later unhide a new movement', async () => {
  const s = surface(), first = s.motion.move({ from: s.motion.capture(s.source), to: '#target' });
  assert.equal(s.target.style.visibility, 'hidden');
  const replacement = new s.Node(); replacement.style.visibility = 'visible'; s.elements.set('#target', replacement);
  s.motion.sync(); assert.equal(s.target.style.visibility, ''); assert.equal(replacement.style.visibility, 'hidden');
  s.motion.cancel(); assert.equal(replacement.style.visibility, 'visible'); assert.equal(s.root.children.length, 0);
  const second = s.motion.move({ from: s.motion.capture(s.source), to: '#target' });
  await first; assert.equal(replacement.style.visibility, 'hidden', 'late old finalizer preserves the newer ghost');
  s.animations.at(-1).resolve(); assert.equal(await second, true); assert.equal(replacement.style.visibility, 'visible');
  s.motion.destroy();
});

test('hidden, resize, reduced motion and destruction immediately release transient objects', async () => {
  for (const kind of ['hidden', 'resize', 'reduced', 'destroy']) {
    const s = surface(), running = s.motion.move({ from: s.motion.capture(s.source), to: '#target' });
    if (kind === 'hidden') { s.doc.hidden = true; s.doc.dispatchEvent(new Event('visibilitychange')); }
    if (kind === 'resize') s.win.dispatchEvent(new Event('resize'));
    if (kind === 'reduced') { s.reduced.matches = true; s.reduced.dispatchEvent(new Event('change')); }
    if (kind === 'destroy') s.motion.destroy();
    assert.equal(s.motion.activeCount(), 0); assert.equal(s.root.children.length, 0); assert.equal(s.target.style.visibility, '');
    assert.equal(await running, false); s.motion.destroy();
  }
});

test('route timing accepts finite linear landing delay and rejects excess transient objects', async () => {
  const s = surface(), from = () => s.motion.capture(s.source);
  const a = s.motion.move({ from: from(), to: s.target.rect, path: [{ x: 80, y: 150 }], duration: 1100, delay: 950, easing: 'linear' });
  const b = s.motion.move({ from: from(), to: s.target.rect });
  assert.equal(await s.motion.move({ from: from(), to: s.target.rect }), false);
  assert.equal(s.animations[0].options.delay, 950); assert.equal(s.animations[0].options.easing, 'linear');
  assert.equal(s.animations[0].frames.length, 3); s.motion.cancel(); await Promise.all([a, b]); s.motion.destroy();
});

test('one local Rummikub operation chooses one primary sound, including automatic split and merge', () => {
  assert.equal(placementCue(), 'placement'); assert.equal(placementCue({ merged: true }), 'merge');
  assert.equal(placementCue({ autoSplit: true, merged: true }), 'split');
});
