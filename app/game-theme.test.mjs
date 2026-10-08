import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_THEMES, themeById, initializeGameTheme } from './platform/game-theme.mjs';
const luminance = color => {
  const channels = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
};
const contrast = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + .05) / (low + .05); };
test('every theme keeps main, secondary and button text legible', () => {
  assert.equal(GAME_THEMES.length, 6);
  assert.equal(new Set(GAME_THEMES.map(theme => theme.id)).size, 6);
  for (const theme of GAME_THEMES) {
    for (const text of ['ink', 'muted', 'good', 'bad']) for (const background of ['surface', 'base', 'table', 'control']) assert.ok(contrast(theme[text], theme[background]) >= 4.5, `${theme.id} ${text}/${background}`);
    assert.ok(contrast(theme.base, theme.accent) >= 4.5, `${theme.id} primary action`);
    assert.ok(contrast(theme.rackInk, theme.rack) >= 4.5, `${theme.id} rack text`);
  }
  assert.equal(themeById('unexpected').id, 'classic');
});
test('unavailable device storage cannot block a game; repeated mount shares one preference controller', () => {
  const values = {}, links = [], meta = {}, subscribers = [];
  const doc = { documentElement: { dataset: {}, style: { setProperty: (k, v) => values[k] = v } },
    defaultView: { get localStorage() { throw new Error('blocked'); } },
    head: { append: node => links.push(node) }, createElement: () => ({ dataset: {} }), querySelector: () => ({ setAttribute: (k, v) => meta[k] = v }) };
  const current = initializeGameTheme(doc);
  assert.equal(current.current(), 'classic');assert.equal(initializeGameTheme(doc), current);assert.equal(links.length, 1);
  const remove = current.subscribe(value => subscribers.push(value));current.set('midnight');remove();current.set('wine');
  assert.deepEqual(subscribers, ['classic', 'midnight']);assert.equal(doc.documentElement.dataset.gameTheme, 'wine');
  assert.equal(meta.content, themeById('wine').base);assert.equal(values['--theme-surface'], themeById('wine').surface);
});
