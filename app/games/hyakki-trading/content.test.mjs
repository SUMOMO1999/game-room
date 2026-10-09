import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_VERSION, GOODS, ACTIONS, CARD_TYPES, RECIPES, SAMPLE_MAPPING, createSampleDeck, getGood, getCardType, describeGoods } from './content.mjs';

test('the full sample inventory has 120 distinct cards and the approved six class counts', () => {
  const deck = createSampleDeck();
  assert.equal(deck.length, 120);
  assert.equal(new Set(deck.map(card => card.id)).size, 120);
  assert.deepEqual(CARD_TYPES.map(type => [type.kind, deck.filter(card => card.typeId === type.typeId).length]), [
    ['goods-card', 80], ['festival', 8], ['theft', 8], ['talisman', 8], ['auction', 6], ['stall-permit', 10],
  ]);
  assert.equal(GOODS.reduce((sum, good) => sum + good.stock, 0), 120);
  for (const card of deck) {
    assert.equal(card.contentVersion, CONTENT_VERSION);
    assert.equal(card.sample, true);
    assert.match(card.id, /^sample-hyakki-\d{3}$/);
    assert.ok(card.name && card.shortText && card.costText && card.timingLabel);
    assert.ok(card.details.length >= 3 && card.details.every(detail => typeof detail === 'string' && detail.length > 0));
  }
});

test('all twelve recipes have exact multiplicities, complete quantities and fixed valid prices', () => {
  const goodsCards = createSampleDeck().filter(card => card.kind === 'goods-card');
  assert.deepEqual(RECIPES.map(recipe => recipe.id), ['AAB', 'BBC', 'CCD', 'DDE', 'EEF', 'FFA', 'ABC', 'DEF', 'AABB', 'CCDDE', 'AABBCC', 'DDEEFF']);
  for (const recipe of RECIPES) {
    const copies = goodsCards.filter(card => card.recipeId === recipe.id);
    assert.equal(copies.length, recipe.copies);
    for (const card of copies) {
      const expected = {};
      for (const letter of recipe.letters) expected[SAMPLE_MAPPING[letter]] = (expected[SAMPLE_MAPPING[letter]] ?? 0) + 1;
      assert.deepEqual(Object.fromEntries(card.goods.map(good => [good.id, good.count])), expected);
      assert.equal(card.goods.reduce((sum, good) => sum + good.count, 0), recipe.total);
      assert.ok(card.goods.every(good => good.count >= 1 && good.count <= 2));
      assert.ok([3, 4, 5].includes(card.buyPrice));
      assert.ok([11, 12, 13].includes(card.sellPrice));
      assert.ok(card.details[0].includes(describeGoods(card.goods)));
    }
  }
  assert.equal(new Set(goodsCards.map(card => `${card.buyPrice}/${card.sellPrice}`)).size, 9);
  assert.deepEqual(createSampleDeck(), createSampleDeck());
});

test('a different valid mapping changes goods but preserves quantities, identities and prices', () => {
  const mapping = { A: 'spirit-stone', B: 'tengu-feather', C: 'fox-fur', D: 'lantern', E: 'aburaage', F: 'cucumber' };
  const original = createSampleDeck();
  const remapped = createSampleDeck(mapping);
  assert.deepEqual(remapped[0].goods, [{ id: 'spirit-stone', count: 2 }, { id: 'tengu-feather', count: 1 }]);
  assert.notDeepEqual(remapped[0].goods, original[0].goods);
  assert.equal(remapped[0].buyPrice, original[0].buyPrice);
  assert.equal(remapped[0].sellPrice, original[0].sellPrice);
  assert.equal(remapped[0].id, original[0].id);
  mapping.A = 'cucumber';
  assert.equal(remapped[0].goods[0].id, 'spirit-stone');
  for (const badMapping of [null, [], {}, { ...SAMPLE_MAPPING, F: 'cucumber' }, { ...SAMPLE_MAPPING, A: 'unknown' }, { ...SAMPLE_MAPPING, G: 'lantern' }]) {
    assert.throws(() => createSampleDeck(badMapping));
  }
});

test('definitions and every nested sample value are immutable', () => {
  const deck = createSampleDeck();
  for (const mutation of [
    () => { GOODS[0].stock = 0; },
    () => { ACTIONS[0].details.push('changed'); },
    () => { CARD_TYPES.pop(); },
    () => { RECIPES[0].letters[0] = 'F'; },
    () => { SAMPLE_MAPPING.A = 'lantern'; },
    () => { deck.pop(); },
    () => { deck[0].buyPrice = 99; },
    () => { deck[0].goods[0].count = 99; },
    () => { deck[0].details.push('changed'); },
  ]) assert.throws(mutation, TypeError);
  assert.deepEqual(deck, createSampleDeck());
});

test('lookups reject unknown data and text fallback names every distinct good with its count', () => {
  assert.equal(getGood('cucumber').name, '黄瓜');
  assert.equal(getCardType('hyakki.talisman').ap, 0);
  assert.equal(describeGoods([{ id: 'cucumber', count: 2 }, { id: 'lantern', count: 1 }]), '黄瓜 ×2、灯笼 ×1');
  for (const id of [undefined, '__proto__', 'unknown', {}]) {
    assert.throws(() => getGood(id), RangeError);
    assert.throws(() => getCardType(id), RangeError);
  }
  for (const goods of [null, [], [{ id: 'cucumber', count: 0 }], [{ id: 'cucumber', count: 3 }], [{ id: 'cucumber', count: 1 }, { id: 'cucumber', count: 1 }]]) {
    assert.throws(() => describeGoods(goods));
  }
});

test('action timing and visible warnings preserve defense, auction guarantees and one-turn festival scope', () => {
  for (const action of ACTIONS) {
    assert.ok(action.compactText.trim());
    assert.match(action.compactCost, new RegExp(`${action.ap}\\s*(?:行动)?力`, 'u'));
  }
  const charm = getCardType('hyakki.talisman');
  assert.equal(charm.timing, 'reaction');
  assert.equal(charm.ap, 0);
  assert.match(charm.details.join(''), /10 秒/);
  for (const action of ACTIONS.filter(action => action.kind !== 'talisman')) {
    assert.equal(action.timing, 'active');
    assert.equal(action.ap, 1);
  }
  const auction = getCardType('hyakki.auction').details.join('');
  for (const text of ['只揭示当前一件', '15 秒', '无人报价', '余额 − 后续件数', '兜底不能撤销', '离席']) assert.ok(auction.includes(text));
  const festival = getCardType('hyakki.festival').details.join('');
  for (const text of ['最低 1 两', '每回合最多发动一次', '不影响其他玩家', '只调整一次']) assert.ok(festival.includes(text));
});
