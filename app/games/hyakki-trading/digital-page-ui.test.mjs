import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { drawingTestDOM } from '../../test-support/drawing-page-dom.mjs';
import { digitalFixture, DIGITAL_SCENES } from './test-support/digital-preview-fixtures.mjs';
import { mountDigitalPage } from './digital-page-ui.mjs';

// DOM lifecycle checks run real page/settings/audio modules. Geometry and
// rendered font sizes remain the independent real-browser acceptance's job.
function fixture(t, scene = 'active') {
  const document = drawingTestDOM('<head></head><body><main id="hyakki-digital-root"></main></body>');
  const window = new EventTarget(), root = document.getElementById('hyakki-digital-root');
  Object.assign(window, { innerWidth: 1512, innerHeight: 827, navigator: {}, visualViewport: null,
    setTimeout, clearTimeout, scrollTo() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ columnGap: '8px', paddingLeft: '3px', paddingRight: '3px',
      getPropertyValue: name => name === '--hyakki-card-width' ? '132px' : '192px' }),
  });
  document.defaultView = window; root.ownerDocument = document;
  const query = root.querySelector.bind(root);
  root.querySelector = selector => selector === '.chat-heading p' ? query('.chat-heading').querySelector('p') : query(selector);
  const ui = mountDigitalPage({ root, scenes: DIGITAL_SCENES }); ui.applyView(digitalFixture(scene));
  t.after(() => ui.destroy());
  const byId = id => document.getElementById(id);
  function eventAt(node, type = 'click', target = root) {
    const event = new Event(type); Object.defineProperty(event, 'target', { value: node }); target.dispatchEvent(event);
  }
  return { ui, root, document, window, byId, eventAt };
}

test('installed tapped tool exposes disabled activation, never installation', t => {
  const f = fixture(t), tool = f.root.querySelectorAll('[data-tool-id]').find(node => node.dataset.toolId === 'yousei.t04#01');
  f.eventAt(tool);
  const body = f.byId('yg-inspector-body');
  assert.equal(body.querySelector('[data-preview-action="prepare-use"]'), null);
  assert.ok(body.querySelector('[data-preview-action="prepare-tool"]').getAttribute('disabled') !== null);
  assert.match(body.textContent, /当前横置，不能再次使用/);
});

test('switching to spectator clears closed private panels as well as the visible hand', t => {
  const f = fixture(t, 'oracle'); f.ui.openDecision();
  assert.equal(f.byId('yg-decision-body').querySelectorAll('[data-card-id]').length, 6);
  f.eventAt(f.byId('yg-decision-body').querySelector('[data-detail-id]'));
  assert.ok(f.byId('yg-inspector-body').querySelector('[data-card-id]'));
  f.ui.applyView(digitalFixture('spectator'));
  assert.equal(f.byId('yg-decision-body').querySelectorAll('[data-card-id]').length, 0);
  assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-card-id]').length, 0);
  assert.equal(f.byId('yg-hand').querySelectorAll('[data-card-id]').length, 0);
  assert.equal(f.byId('yg-inspector').open, false);
});

test('role mutation in the same projection object still clears private details', t => {
  const f = fixture(t), view = digitalFixture('waiting'); f.ui.applyView(view);
  f.eventAt(f.byId('yg-hand').querySelector('[data-card-id]'));
  assert.ok(f.byId('yg-inspector-body').querySelector('[data-card-id]'));
  view.selfRole = 'spectator'; f.ui.applyView(view);
  assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-card-id]').length, 0);
});

test('auction bid survives detail, collapse and rotation but resets for another decision', t => {
  const f = fixture(t, 'cards-auction'); f.ui.openDecision();
  let input = f.byId('yg-bid'); input.value = '7'; input.setCustomValidity = () => {};
  f.eventAt(input, 'input', f.byId('yg-decision'));
  f.eventAt(f.byId('yg-decision-body').querySelector('[data-detail-id]'));
  f.eventAt(f.byId('yg-inspector-close'));
  assert.equal(f.byId('yg-bid').value, '7');
  f.eventAt(f.byId('yg-decision-close')); f.ui.openDecision();
  f.window.innerWidth = 390; f.window.innerHeight = 844; f.window.dispatchEvent(new Event('resize'));
  assert.equal(f.byId('yg-bid').value, '7');
  f.ui.applyView(digitalFixture('goods-auction')); f.ui.openDecision();
  assert.equal(f.byId('yg-bid').value, '4');
});

test('destroy removes private DOM and all audio/viewport listeners, and stays idempotent', t => {
  const f = fixture(t, 'oracle'); f.ui.openDecision();
  assert.ok(getEventListeners(f.window, 'focus').length > 0);
  f.ui.destroy(); f.ui.destroy();
  assert.equal(f.root.children.length, 0);
  for (const type of ['focus', 'blur', 'pagehide', 'pageshow', 'resize']) assert.equal(getEventListeners(f.window, type).length, 0, type);
});


test('dense hand keeps all artwork cards mounted, preserves scrolling, and separates equipment from tabletop goods', t => {
  const f = fixture(t, 'dense'), hand = f.byId('yg-hand');
  assert.equal(hand.querySelectorAll('[data-card-id]').length, 110);
  assert.equal(f.byId('yg-hand-next'), null);
  assert.equal(hand.querySelector('.yg-hand-summary'), null);
  assert.ok(f.byId('yg-personal').closest('.yg-table'));
  assert.ok(f.byId('yg-tool-zone').closest('.yg-lower'));
  hand.scrollLeft = 240;
  f.ui.applyView(digitalFixture('dense'));
  assert.equal(hand.scrollLeft, 240);
  f.ui.applyView(digitalFixture('spectator'));
  assert.equal(hand.scrollLeft, 0);
  assert.equal(f.byId('yg-tool-zone').hidden, true);
});
