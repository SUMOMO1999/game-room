import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { drawingTestDOM } from '../../test-support/drawing-page-dom.mjs';
import { mountHandDrag } from './hand-drag-ui.mjs';

// Exercise the real pointer owner. Fixed rectangles are input fixtures, not
// evidence of actual browser geometry or touch scrolling.
function fixture(t) {
  const document = drawingTestDOM('<body><main id="root"><section class="yg-centre"></section><div id="yg-hand"></div></main></body>');
  const root = document.getElementById('root'), hand = document.getElementById('yg-hand');
  const table = root.querySelector('.yg-centre'), window = new EventTarget();
  Object.assign(window, { performance: { now: () => 1000 } });
  document.defaultView = window;
  // Node 22 ignores boolean capture on removal; preserve browser semantics in
  // this host adapter rather than changing the production listener owner.
  const remove = document.removeEventListener.bind(document);
  document.removeEventListener = (type, listener, options) => remove(type, listener,
    typeof options === 'boolean' ? { capture: options } : options);
  table.getBoundingClientRect = () => ({ left: 300, right: 960, top: 100, bottom: 500 });
  const cards = ['first', 'middle', 'last'].map(id => {
    const card = document.createElement('button'), face = document.createElement('div');
    card.className = 'yg-hand-card'; card.setAttribute('data-entity-id', id);
    face.className = 'yousei-card'; face.textContent = id;
    face.cloneNode = () => {
      const copy = document.createElement('div'); copy.className = face.className;
      copy.textContent = face.textContent; return copy;
    };
    card.append(face); hand.append(card); return { id, card, face };
  });
  let context = { scope: 'turn-1', enabled: true, cardIds: cards.map(card => card.id) }, captured = null;
  hand.setPointerCapture = id => { captured = id; };
  hand.hasPointerCapture = id => captured === id;
  hand.releasePointerCapture = () => { captured = null; };
  const drops = [], blocked = [];
  const ui = mountHandDrag({ root, getContext: () => context,
    onDrop: id => drops.push(id), onBlocked: reason => blocked.push(reason) });
  t.after(() => ui.destroy());
  function event(type, fields = {}) {
    const emitted = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(emitted, key, { value });
    return emitted;
  }
  function pointer(type, id, x, y, fields = {}) {
    const target = cards.find(card => card.id === id).face;
    const emitted = event(type, { target, isPrimary: true, button: 0, pointerId: 1,
      clientX: x, clientY: y, ...fields });
    (type === 'pointerdown' ? hand : window).dispatchEvent(emitted);
    return emitted;
  }
  function clean() {
    assert.equal(root.querySelector('.hy-hand-ghost'), null);
    assert.equal(root.querySelector('.hy-hand-drop')?.hidden ?? true, true);
    assert.equal(root.classList.contains('hy-hand-dragging'), false);
    assert.equal(captured, null);
  }
  return { root, hand, table, window, document, cards, drops, blocked, ui, pointer, event, clean,
    setContext: value => { context = value === null ? null : { ...context, ...value }; } };
}

const starts = [['first', 330], ['middle', 630], ['last', 930]];
for (const [id, startX] of starts) {
  for (const direction of ['diagonal', 'vertical']) {
    test(`${id} card ${direction} upward drag selects once on the table and never before release`, t => {
      const f = fixture(t), endX = direction === 'vertical' ? startX : id === 'last' ? 710 : startX + 210;
      f.pointer('pointerdown', id, startX, 630);
      const move = f.pointer('pointermove', id, startX + (endX - startX) * 0.1, 609);
      assert.equal(move.defaultPrevented, true);
      assert.ok(f.root.querySelector('.hy-hand-ghost'));
      assert.equal(f.root.querySelector('.hy-hand-drop').hidden, false);
      assert.deepEqual(f.drops, [], 'dragging is still an unsubmitted UI selection');
      f.pointer('pointermove', id, endX, 420);
      f.pointer('pointerup', id, endX, 420);
      f.pointer('pointerup', id, endX, 420);
      assert.deepEqual(f.drops, [id], 'release notifies the existing selection owner exactly once');
      f.clean();
    });
  }
  test(`${id} near-horizontal browsing locks even if the pointer later moves over the table`, t => {
    const f = fixture(t), horizontal = id === 'last' ? -40 : 40;
    f.pointer('pointerdown', id, startX, 630);
    assert.equal(f.pointer('pointermove', id, startX + horizontal, 626).defaultPrevented, false);
    assert.equal(f.root.querySelector('.hy-hand-ghost'), null);
    f.pointer('pointermove', id, 710, 420);
    f.pointer('pointerup', id, 710, 420);
    assert.deepEqual(f.drops, []); f.clean();
  });
}

test('small jitter and an ambiguous diagonal remain pending until the upward intent becomes clear', t => {
  const f = fixture(t);
  f.pointer('pointerdown', 'last', 930, 630);
  f.pointer('pointermove', 'last', 920, 619);
  f.pointer('pointermove', 'last', 906, 616);
  assert.equal(f.root.querySelector('.hy-hand-ghost'), null);
  f.pointer('pointermove', 'last', 886, 590);
  assert.ok(f.root.querySelector('.hy-hand-ghost'));
  f.pointer('pointerup', 'last', 710, 420);
  assert.deepEqual(f.drops, ['last']); f.clean();
});

for (const stop of ['outside', 'pointercancel', 'blur', 'cancel', 'disabled-sync', 'disabled-release',
  'scope-sync', 'card-removed-sync', 'context-removed', 'dialog', 'lostcapture']) {
  test(`${stop} interrupts an active drag with zero drop callbacks`, t => {
    const f = fixture(t);
    f.pointer('pointerdown', 'last', 930, 630);
    f.pointer('pointermove', 'last', 930, 590);
    assert.ok(f.root.querySelector('.hy-hand-ghost'));
    if (stop === 'pointercancel') f.pointer('pointercancel', 'last', 710, 420);
    if (stop === 'blur') f.window.dispatchEvent(new Event('blur'));
    if (stop === 'cancel') f.ui.cancel();
    if (stop === 'disabled-sync') { f.setContext({ enabled: false }); f.ui.sync(); }
    if (stop === 'disabled-release') f.setContext({ enabled: false });
    if (stop === 'scope-sync') { f.setContext({ scope: 'turn-2' }); f.ui.sync(); }
    if (stop === 'card-removed-sync') { f.setContext({ cardIds: ['first', 'middle'] }); f.ui.sync(); }
    if (stop === 'context-removed') f.setContext(null);
    if (stop === 'dialog') { const dialog = f.document.createElement('dialog'); dialog.open = true; f.root.append(dialog); }
    if (stop === 'lostcapture') f.hand.dispatchEvent(f.event('lostpointercapture', { target: f.hand, pointerId: 1 }));
    f.pointer('pointerup', 'last', stop === 'outside' ? 1000 : 710, 420);
    assert.deepEqual(f.drops, []); f.clean();
  });
}

test('a disallowed upward gesture explains once and cannot recover into a drop after permission returns', t => {
  const f = fixture(t);
  f.setContext({ enabled: false, blockedReason: '等待伙伴回应' });
  f.pointer('pointerdown', 'last', 930, 630);
  f.pointer('pointermove', 'last', 900, 600);
  f.setContext({ enabled: true });
  f.pointer('pointermove', 'last', 710, 420);
  f.pointer('pointerup', 'last', 710, 420);
  assert.deepEqual(f.blocked, ['等待伙伴回应']); assert.deepEqual(f.drops, []); f.clean();
});

test('child implicit-capture loss and unrelated pointer input do not abort the active hand drag', t => {
  const f = fixture(t);
  f.pointer('pointerdown', 'last', 930, 630);
  f.pointer('pointermove', 'last', 930, 590);
  f.hand.dispatchEvent(f.event('lostpointercapture', { target: f.cards[2].face, pointerId: 1 }));
  f.pointer('pointerup', 'last', 710, 420, { pointerId: 2 });
  assert.ok(f.root.querySelector('.hy-hand-ghost')); assert.deepEqual(f.drops, []);
  f.pointer('pointerup', 'last', 710, 420);
  assert.deepEqual(f.drops, ['last']); f.clean();
});

test('completed drag suppresses its synthetic click while ordinary keyboard clicks remain available', t => {
  const f = fixture(t);
  f.pointer('pointerdown', 'last', 930, 630);
  f.pointer('pointermove', 'last', 930, 590);
  f.pointer('pointerup', 'last', 710, 420);
  const synthetic = f.event('click', { target: f.cards[2].face, detail: 1 });
  f.document.dispatchEvent(synthetic); assert.equal(synthetic.defaultPrevented, true);
  const keyboard = f.event('click', { target: f.cards[2].face, detail: 0 });
  f.document.dispatchEvent(keyboard); assert.equal(keyboard.defaultPrevented, false);
  assert.deepEqual(f.drops, ['last']); f.clean();
});

test('destroy cancels a drag, removes the drop target and releases all event owners', t => {
  const f = fixture(t);
  f.pointer('pointerdown', 'last', 930, 630); f.pointer('pointermove', 'last', 930, 590);
  f.ui.destroy(); f.ui.destroy();
  f.pointer('pointerup', 'last', 710, 420);
  assert.deepEqual(f.drops, []); f.clean();
  assert.equal(f.root.querySelector('.hy-hand-drop'), null);
  for (const type of ['pointermove', 'pointerup', 'pointercancel', 'blur', 'resize']) {
    assert.equal(getEventListeners(f.window, type).length, 0, type);
  }
  assert.equal(getEventListeners(f.hand, 'pointerdown').length, 0);
  assert.equal(getEventListeners(f.document, 'click').length, 0);
});
