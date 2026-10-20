import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { drawingTestDOM } from '../../test-support/drawing-page-dom.mjs';
import { mountNightMarketBackground, NIGHT_MARKET_BACKGROUND_KEY } from './night-market-background.mjs';
import { publicAssetPaths } from '../../../server/public-assets.mjs';

function fixture({ saved = 'original', readFails = false, writeFails = false } = {}) {
  const document = drawingTestDOM('<head></head><body><main id="table"></main><dialog id="settings"><div class="game-settings-body"></div></dialog></body>');
  const images = [], writes = [], values = new Map(saved === null ? [] : [[NIGHT_MARKET_BACKGROUND_KEY, saved]]);
  class ImageProbe extends EventTarget {
    constructor() { super(); this.complete = false; this.naturalWidth = 0; images.push(this); }
    set src(value) { this.url = value; }
    removeAttribute(name) { if (name === 'src') this.url = null; }
    finish(ok = true) { this.complete = true; this.naturalWidth = ok ? 1920 : 0; this.dispatchEvent(new Event(ok ? 'load' : 'error')); }
  }
  const window = new EventTarget();
  Object.assign(window, { Image: ImageProbe, localStorage: { getItem(key) { if (readFails) throw Error('blocked'); return values.get(key) ?? null; }, setItem(key, value) { if (writeFails) throw Error('quota'); writes.push([key, value]); values.set(key, value); } } });
  document.defaultView = window;
  const root = document.getElementById('table'), dialog = document.getElementById('settings');
  const picker = mountNightMarketBackground({ root, settingsDialog: dialog });
  const choices = dialog.querySelector('.nm-background-options');
  const choose = id => { const input = choices.querySelector(`[data-nm-background="${id}"]`); input.checked = true; const event = new Event('change'); Object.defineProperty(event, 'target', { value: input }); choices.dispatchEvent(event); };
  const checked = () => dialog.querySelectorAll('[data-nm-background]').filter(input => input.checked).map(input => input.value);
  return { document, root, dialog, picker, choices, images, writes, values, choose, checked, status: () => dialog.querySelector('.nm-background-status').textContent };
}

test('first visit and unknown preference use rain without writing account or game data', () => {
  for (const saved of [null, 'untrusted-new-default', '{"background":"rain"}']) {
    const f = fixture({ saved });
    assert.deepEqual(f.checked(), ['rain']); assert.equal(f.images.length, 1); assert.equal(f.writes.length, 0);
    assert.equal(f.root.dataset.nightMarketBackground, 'rain');
    assert.equal(f.document.body.style.getPropertyValue('--nm-background-image'), '');
    f.images[0].finish();
    assert.match(f.document.body.style.getPropertyValue('--nm-background-image'), /hyakki-night-market-rain\.png/);
    f.picker.destroy();
  }
});

test('an explicit original or lantern preference survives the new default', () => {
  const original = fixture({ saved: 'original' });
  assert.deepEqual(original.checked(), ['original']); assert.equal(original.images.length, 0);
  assert.match(original.document.body.style.getPropertyValue('--nm-background-image'), /hyakki-night-market\.webp/);
  original.picker.destroy();
  const lantern = fixture({ saved: 'lantern' });
  lantern.images[0].finish(); assert.equal(lantern.root.dataset.nightMarketBackground, 'lantern');
  assert.equal(lantern.writes.length, 0); lantern.picker.destroy();
});

test('native single-choice settings preload only an exact asset and remember the completed selection', () => {
  const f = fixture();
  assert.equal(f.dialog.querySelectorAll('input').length, 3);
  f.choose('lantern'); assert.deepEqual(f.checked(), ['lantern']); assert.equal(f.writes.length, 0);
  assert.match(f.images[0].url, /\/assets\/hyakki-night-market-lantern\.png$/);
  f.images[0].finish();
  assert.equal(f.root.dataset.nightMarketBackground, 'lantern');
  assert.match(f.document.body.style.getPropertyValue('--nm-background-image'), /hyakki-night-market-lantern\.png/);
  assert.deepEqual(f.writes, [[NIGHT_MARKET_BACKGROUND_KEY, 'lantern']]);
  assert.doesNotMatch(f.document.body.style.getPropertyValue('filter'), /brightness/);
  f.choose('original'); assert.match(f.document.body.style.getPropertyValue('--nm-background-image'), /hyakki-night-market\.webp/);
  assert.equal(f.values.get(NIGHT_MARKET_BACKGROUND_KEY), 'original'); f.picker.destroy();
});

test('a stored alternate image loads without changing the preference or original fallback before success', () => {
  const f = fixture({ saved: 'rain' });
  assert.deepEqual(f.checked(), ['rain']); assert.equal(f.root.dataset.nightMarketBackground, 'rain');
  assert.equal(f.document.body.style.getPropertyValue('--nm-background-image'), '');
  f.images[0].finish(); assert.equal(f.root.dataset.nightMarketBackground, 'rain'); assert.equal(f.writes.length, 0);
  f.picker.destroy();
});

test('read or write storage failure leaves selection available and explains that it cannot be remembered', () => {
  for (const options of [{ readFails: true }, { writeFails: true }]) {
    const f = fixture(options); f.choose('rain'); f.images.at(-1).finish();
    assert.equal(f.root.dataset.nightMarketBackground, 'rain'); assert.deepEqual(f.checked(), ['rain']);
    assert.match(f.status(), /当前仍可切换背景/); assert.match(f.status(), /不会记住/);
    assert.equal(f.writes.length, 0); f.picker.destroy();
  }
});

test('failed image and stale earlier loads cannot replace the chosen original or later image', () => {
  const f = fixture(); f.choose('lantern'); const earlier = f.images[0];
  f.choose('rain'); const latest = f.images[1];
  assert.equal(getEventListeners(earlier, 'load').length, 0); earlier.finish();
  assert.equal(f.root.dataset.nightMarketBackground, 'original'); latest.finish(false);
  assert.deepEqual(f.checked(), ['original']); assert.equal(f.root.dataset.nightMarketBackground, 'original');
  assert.match(f.document.body.style.getPropertyValue('--nm-background-image'), /hyakki-night-market\.webp/);
  assert.match(f.status(), /未能加载，已恢复灯下夜市/); assert.equal(f.values.get(NIGHT_MARKET_BACKGROUND_KEY), 'original');
  f.picker.destroy();
});

test('destroy cancels image listeners, removes settings, restores owned style and ignores late events', () => {
  const f = fixture(); f.choose('lantern'); const image = f.images[0];
  assert.equal(getEventListeners(f.choices, 'change').length, 1);
  f.picker.destroy(); f.picker.destroy();
  assert.equal(getEventListeners(f.choices, 'change').length, 0);
  assert.equal(getEventListeners(image, 'load').length, 0); assert.equal(getEventListeners(image, 'error').length, 0);
  image.finish(); assert.equal(f.root.dataset.nightMarketBackground, undefined); assert.equal(f.writes.length, 0);
  assert.equal(f.dialog.querySelector('.nm-background-settings'), null);
});

test('only the two background assets and presentation modules enter the explicit static allow-list', () => {
  const paths = publicAssetPaths();
  for (const asset of ['assets/hyakki-night-market.webp', 'assets/hyakki-night-market-lantern.png', 'assets/hyakki-night-market-rain.png', 'games/hyakki-trading/night-market-background.mjs', 'games/hyakki-trading/night-market-background.css']) assert.ok(paths.includes(asset), asset);
  assert.ok(!paths.includes('games/hyakki-trading/night-market-background.test.mjs'));
  assert.throws(() => publicAssetPaths([], ['server/private.mjs']));
});
