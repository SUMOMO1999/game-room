import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampleDeck, getGood, getCardType, GOODS, ACTIONS } from './content.mjs';
import { renderCard, renderCardBack, renderCardDetails, renderGoodsIcon } from './card-ui.mjs';
import { ART_VERSION, assetPath, mountArtFallback } from './art.mjs';

const deck = createSampleDeck();
const visibleText = html => html.replace(/<img\b[^>]*>/gu, '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();

test('all 120 sample faces and detail panels render the supplied card identity and approved text', () => {
  for (const card of deck) {
    const face = renderCard(card);
    const detail = renderCardDetails(card);
    assert.equal((face.match(/<button\b/gu) ?? []).length, 1);
    assert.match(face, /type="button" aria-pressed="false"/u);
    assert.ok(face.includes(`data-card-id="${card.id}"`));
    assert.ok(face.includes(`data-card-kind="${card.kind}"`));
    assert.ok(face.includes(`data-art-version="${ART_VERSION}"`));
    assert.ok(visibleText(face).includes(getCardType(card.typeId).name));
    for (const paragraph of card.details) assert.ok(detail.includes(paragraph), `${card.id}: missing detail`);
    assert.ok(visibleText(detail).includes(card.costText));
    assert.doesNotMatch(face + detail, /undefined|\[object Object\]|<script\b/u);
  }
});

test('names, goods quantities, prices and action effects do not depend on loaded images', () => {
  for (const card of deck) {
    const text = visibleText(renderCard(card));
    assert.ok(text.includes(card.name));
    if (card.kind === 'goods-card') {
      for (const good of card.goods) assert.ok(text.includes(`${getGood(good.id).name} ×${good.count}`));
      assert.ok(text.includes(`买 ${card.buyPrice}`));
      assert.ok(text.includes(`卖 ${card.sellPrice}`));
    } else {
      assert.match(text, new RegExp(`${card.ap}\\s*(?:行动)?力`, 'u'));
      assert.match(text, {
        festival: /买 −2.*卖 \+2/u,
        theft: /1\s*个货物/u,
        talisman: /取消.*偷窃/u,
        auction: /无人报(?:价)?.*1\s*两/u,
        'stall-permit': /容量 \+3.*3\s*两/u,
      }[card.kind]);
    }
  }
});

test('every concealed face uses exactly the same back without card identity or card kind', () => {
  const back = renderCardBack();
  for (const card of deck) {
    // Extra caller data cannot customize a concealed face or reveal a type-specific URL.
    assert.equal(renderCardBack(card), back);
    assert.ok(!back.includes(card.id));
  }
  assert.doesNotMatch(back, /data-card-id|data-card-kind|recipeId|buyPrice|sellPrice/u);
  assert.match(back, /aria-label="未公开的牌，统一牌背"/u);
  assert.match(visibleText(back), /未公开/u);
  assert.equal((back.match(/<img\b/gu) ?? []).length, 1);
  assert.ok(back.includes(assetPath('card-back')));
  for (const item of [...GOODS, ...ACTIONS]) assert.ok(!back.includes(assetPath(item.id)));
});

test('selection is accessible and unavailable cards remain inspectable without exposing a play control', () => {
  const card = deck[0];
  const selected = renderCard(card, { selected: true });
  assert.match(selected, /aria-pressed="true"/u);
  assert.match(selected, /aria-label="[^"]*已选中/u);
  const unavailable = renderCard(card, { disabled: true });
  assert.match(unavailable, /^<button\b/u);
  assert.match(unavailable, /aria-label="[^"]*当前不可使用，可查看说明/u);
  assert.doesNotMatch(unavailable, /\sdisabled(?:\s|>|=)/u);
  const readonly = renderCard(card, { interactive: false });
  assert.match(readonly, /^<span role="img"/u);
  assert.doesNotMatch(readonly, /<button\b|aria-pressed|tabindex/u);
});

test('untrusted card IDs and detail text remain escaped, while visible type names come from the catalog', () => {
  const card = deck[0];
  const attack = `x"><img src=x onerror="alert('x')">&`;
  const markup = renderCard({ ...card, id: attack, name: '<script>wrong name</script>' });
  assert.ok(markup.includes('data-card-id="x&quot;&gt;&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;"'));
  assert.equal((markup.match(/<img\b/gu) ?? []).length, card.goods.length);
  assert.doesNotMatch(markup, /<script|wrong name|<img src=x/u);
  assert.ok(visibleText(markup).includes(getCardType(card.typeId).name));
  const detail = renderCardDetails({ ...card, details: ['<svg onload="bad()"> & \'test\''] });
  assert.ok(detail.includes('&lt;svg onload=&quot;bad()&quot;&gt; &amp; &#39;test&#39;'));
  assert.doesNotMatch(detail, /<svg\b|<script\b/u);
});

test('unknown definitions, inconsistent kinds, invalid prices and invalid options reject before rendering', () => {
  const card = deck[0];
  for (const invalid of [
    null, {}, { ...card, id: '' }, { ...card, details: [42] },
    { ...card, typeId: 'hyakki.unknown' }, { ...card, kind: 'talisman' },
    { ...card, goods: [{ id: 'unknown', count: 1 }] },
    { ...card, goods: [{ id: 'cucumber', count: 3 }] },
    { ...card, buyPrice: 0 }, { ...card, sellPrice: 99 },
  ]) {
    assert.throws(() => renderCard(invalid));
    assert.throws(() => renderCardDetails(invalid));
  }
  for (const option of [{ selected: 'true' }, { disabled: 1 }, { interactive: null }]) assert.throws(() => renderCard(card, option), TypeError);
  for (const id of ['unknown', '__proto__', 'x" onerror="bad()', null]) {
    assert.throws(() => renderGoodsIcon(id), RangeError);
    assert.throws(() => assetPath(id), RangeError);
  }
});

test('art failure handling covers cached and later failures and removes its listener on disposal', () => {
  const marked = new Set();
  const image = (id, complete, naturalWidth, matches = true) => ({
    complete, naturalWidth,
    matches: selector => matches && selector === 'img[data-hyakki-art]',
    classList: { add: className => marked.add(`${id}:${className}`) },
  });
  const cachedFailure = image('cached', true, 0);
  const loaded = image('loaded', true, 128);
  const pending = image('pending', false, 0);
  let listener;
  const root = {
    addEventListener(type, callback, capture) {
      assert.equal(type, 'error');
      assert.equal(capture, true);
      listener = callback;
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'img[data-hyakki-art]');
      return [cachedFailure, loaded, pending];
    },
    removeEventListener(type, callback, capture) {
      assert.equal(type, 'error');
      assert.equal(capture, true);
      assert.equal(callback, listener);
      listener = null;
    },
  };
  const stop = mountArtFallback(root);
  assert.deepEqual([...marked], ['cached:hyakki-art--missing']);
  listener({ target: pending });
  listener({ target: image('unrelated', true, 0, false) });
  assert.deepEqual([...marked], ['cached:hyakki-art--missing', 'pending:hyakki-art--missing']);
  stop();
  assert.equal(listener, null);
});
