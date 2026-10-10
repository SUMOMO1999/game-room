import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, GOODS, getCard, getGood, createDeck } from './content/definitions.mjs';
import { ASSETS, assetPath, mountArtFallback } from './content/manifest.mjs';
import { renderCard, renderCardDetails, renderCardBack, renderGoodsIcon } from './digital-card-ui.mjs';
import { filterCards } from './digital-catalog.mjs';

const textOnly = html => html.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();

test('all 51 image faces preserve canonical labels and complete rules in details', () => {
  for (const card of CARDS) {
    const markup = renderCard(card), text = textOnly(markup), detail = renderCardDetails(card);
    assert.match(markup, /^<button type="button" aria-pressed="false"/u);
    assert.ok(markup.includes(`data-card-id="${card.id}"`));
    assert.ok(text.includes(card.sourceCode));
    assert.ok(detail.includes(card.name));
    assert.ok(detail.includes(card.costText));
    for (const paragraph of card.details) assert.ok(detail.includes(paragraph));
    if (card.category === 'goods') {
      for (const [id, count] of Object.entries(card.goods)) { assert.ok(markup.includes(`aria-label="${getGood(id).name}×${count}"`)); assert.ok(markup.includes(`<b>×${count}</b>`)); assert.ok(markup.includes(assetPath(id))); }
      assert.ok(text.includes(`买 ${card.buySilver}`));
      assert.ok(text.includes(`卖 ${card.sellSilver}`));
    } else {
      assert.ok(text.includes(card.name));
      assert.doesNotMatch(markup, /yousei-card__effect/u);
      assert.ok(detail.includes(card.summary));
      assert.ok(markup.includes(assetPath(card.artId)));
      assert.match(markup, /loading="eager"[^>]+decoding="sync"/u);
    }
    assert.doesNotMatch(markup + detail, /undefined|\[object Object\]|<script\b/u);
  }
});

test('hidden cards produce one identical back regardless of every possible face and private entity', () => {
  const back = renderCardBack();
  for (const card of [...CARDS, ...createDeck()]) {
    assert.equal(renderCardBack(card), back);
    assert.ok(!back.includes(card.id));
  }
  assert.doesNotMatch(back, /data-card-id|data-card-category|definitionId|copies|buySilver|sellSilver/u);
  for (const asset of ASSETS.filter(asset => asset.id !== 'card-back')) assert.ok(!back.includes(assetPath(asset.id)));
  assert.equal((back.match(/<img /gu) ?? []).length, 1);
  assert.ok(back.includes(assetPath('card-back')));
});

test('public face renderers discard private instance IDs and untrusted replacement text', () => {
  const instance = { id: 'private-card-ref-owner-42', definitionId: 'yousei.c07', name: '<script>bad()</script>', details: ['<img onerror=bad()>'] };
  const markup = renderCard(instance) + renderCardDetails(instance);
  assert.doesNotMatch(markup, /private-card-ref|owner-42|<script|onerror/u);
  assert.match(markup, /锦衣卫/u);
  for (const bad of [null, {}, { id: 'unknown' }, { id: 'yousei.c07', definitionId: 'unknown' }]) assert.throws(() => renderCard(bad));
  assert.throws(() => renderGoodsIcon('unknown'));
});

test('selection, unavailable and sideways tools remain readable and distinct', () => {
  const selected = renderCard(getCard('yousei.t05'), { selected: true });
  assert.match(selected, /aria-pressed="true"/u);
  assert.match(selected, /已选中/u);
  const unavailable = renderCard(getCard('yousei.t05'), { disabled: true, tapped: true });
  assert.match(unavailable, /is-tapped/u);
  assert.match(unavailable, /当前不可使用，可查看说明/u);
  assert.match(unavailable, /已横置/u);
  assert.doesNotMatch(unavailable, / disabled[ =>]/u);
  assert.match(renderCard(getCard('yousei.c07'), { interactive: false }), /^<span role="img"/u);
  for (const options of [{ selected: 'yes' }, { disabled: 1 }, { interactive: null }, { tapped: 'false' }]) assert.throws(() => renderCard(CARDS[0], options), TypeError);
  assert.throws(() => renderCard(CARDS[0], { tapped: true }), RangeError);
  for (const good of GOODS) assert.ok(renderGoodsIcon(good.id).includes(assetPath(good.id)));
});

test('catalog search supports categories, IDs, effects and compound terms; empty results stay empty', () => {
  assert.equal(filterCards().length, 51);
  assert.equal(filterCards({ category: 'tool' }).length, 10);
  assert.equal(filterCards({ category: 'monitored_character' }).length, 8);
  assert.deepEqual(filterCards({ query: 'G19' }).filter(card => card.category === 'goods').map(card => card.id), ['yousei.g19']);
  assert.deepEqual(filterCards({ query: '貔貅袋' }).map(card => card.id), ['yousei.t01']);
  assert.ok(filterCards({ category: 'goods', query: '火器 10两' }).some(card => card.id === 'yousei.g01'));
  assert.ok(filterCards({ query: '临时格' }).length > 1);
  assert.deepEqual(filterCards({ category: 'tool', query: '不存在的牌名' }), []);
  assert.throws(() => filterCards({ category: 'unknown' }));
  assert.throws(() => filterCards({ query: null }));
});

test('art fallback covers cached and later errors, recovers after load and releases both listeners', () => {
  const states = new Map(), listeners = new Map();
  const image = (id, complete, naturalWidth) => ({ complete, naturalWidth,
    matches: selector => selector === 'img[data-yousei-art]',
    classList: { toggle: (name, on) => states.set(`${id}:image:${name}`, on) },
    closest: () => ({ classList: { toggle: (name, on) => states.set(`${id}:frame:${name}`, on) } }),
  });
  const cached = image('cached', true, 0), pending = image('pending', false, 0);
  const root = { addEventListener: (type, callback, capture) => { assert.equal(capture, true); listeners.set(type, callback); },
    querySelectorAll: () => [cached, pending],
    removeEventListener: (type, callback, capture) => { assert.equal(capture, true); assert.equal(listeners.get(type), callback); listeners.delete(type); },
  };
  const dispose = mountArtFallback(root);
  assert.equal(states.get('cached:frame:is-missing'), true);
  assert.equal(states.get('cached:frame:is-loaded'), false);
  assert.equal(states.has('pending:frame:is-missing'), false);
  listeners.get('error')({ target: pending });
  assert.equal(states.get('pending:frame:is-missing'), true);
  listeners.get('load')({ target: pending });
  assert.equal(states.get('pending:frame:is-missing'), false);
  assert.equal(states.get('pending:frame:is-loaded'), true);
  dispose();
  assert.equal(listeners.size, 0);
});

test('six-kind goods use six image/quantity cells rather than a long name list', () => {
  const markup=renderCard('yousei.g19');
  assert.equal((markup.match(/class="yousei-card__good"/gu)||[]).length,6);
  assert.equal((markup.match(/<b>×1<\/b>/gu)||[]).length,6);
  for(const good of GOODS)assert.ok(!textOnly(markup).includes(good.name));
  assert.match(markup,/yousei-card__goods--6/u);
  assert.match(renderCard('yousei.t04'),/装1步 · 用1步/u);
  assert.match(renderCard('yousei.c07'),/回应 · 0步/u);
  assert.match(renderCard('yousei.m08'),/行动 · 1步/u);
});
