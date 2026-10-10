import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARDS, GOODS, CATEGORIES, INITIAL_STOCK, getCard, getGood, getCategory, createDeck, DIGITAL_RULE_VERSION, CONTENT_VERSION, assertContentVersion, assertRuleVersion } from './definitions.mjs';
import { ASSETS, CARD_FACES, assetPath, getAsset } from './manifest.mjs';

const reference = JSON.parse(readFileSync(new URL('../../../../docs/proposals/hyakki-trading/physical-card-catalog.json', import.meta.url), 'utf8'));
const sumCopies = cards => cards.reduce((sum, card) => sum + card.copies, 0);

test('digital catalog preserves all 51 verified definitions and every one of the 110 copies', () => {
  assert.equal(CARDS.length, 51);
  assert.equal(sumCopies(CARDS), 110);
  assert.equal(new Set(CARDS.map(card => card.id)).size, 51);
  for (const source of reference.cards) {
    const card = getCard(source.id);
    for (const key of ['id', 'name', 'category', 'copies']) assert.equal(card[key], source[key]);
    assert.ok(card.summary && card.compactText && card.costText && card.timingLabel);
    assert.ok(card.details.length >= 2 && card.details.every(text => typeof text === 'string' && text.length > 8));
    for (const key of ['actionIncrement', 'placementActionIncrement', 'activationActionIncrement', 'timing', 'tapOnActivation', 'untapAt', 'cancelableByJinyiwei', 'firstGlobalPurchaseSilver', 'laterPurchaseSilver', 'slotsAdded', 'sharedBoards']) {
      if (Object.hasOwn(source, key)) assert.deepEqual(card[key], source[key]);
    }
  }
  assert.deepEqual(Object.fromEntries(CATEGORIES.map(category => [category.id, sumCopies(CARDS.filter(card => card.category === category.id))])), reference.rulebookCategoryCopies);
  assert.deepEqual(CATEGORIES.map(category => CARDS.filter(card => card.category === category.id).length), [19, 1, 13, 8, 10]);
});

test('all 19 goods recipes and printed prices map exactly, including six goods G19', () => {
  for (const source of reference.cards.filter(card => card.category === 'goods')) {
    const card = getCard(source.id);
    const translated = Object.fromEntries(Object.entries(card.goods).map(([id, count]) => [getGood(id).name, count]));
    assert.deepEqual(translated, source.goods);
    assert.equal(card.buySilver, source.buySilver);
    assert.equal(card.sellSilver, source.sellSilver);
  }
  const six = getCard('yousei.g19');
  assert.equal(Object.keys(six.goods).length, 6);
  assert.ok(Object.values(six.goods).every(count => count === 1));
  assert.deepEqual([six.copies, six.buySilver, six.sellSilver], [4, 10, 18]);
});

test('initial stock is six of each named good and frozen with the digital rule version', () => {
  assert.equal(DIGITAL_RULE_VERSION, reference.digitalRuleVersion);
  assert.equal(DIGITAL_RULE_VERSION, reference.digitalInitialStock.ruleVersion);
  assert.deepEqual(Object.fromEntries(GOODS.map(good => [good.name, good.initialStock])), reference.digitalInitialStock.byType);
  assert.deepEqual(Object.keys(INITIAL_STOCK), GOODS.map(good => good.id));
  assert.equal(Object.values(INITIAL_STOCK).reduce((sum, count) => sum + count, 0), 36);
  assert.equal(assertRuleVersion(DIGITAL_RULE_VERSION), true);
  assert.equal(assertContentVersion(CONTENT_VERSION), true);
  for (const unknown of [null, '', 'yousei-digital-v2', 'hyakki-content-v1']) assert.throws(() => assertRuleVersion(unknown));
});

test('content and material instances are deeply immutable and cannot share mutable runtime state', () => {
  const deck = createDeck();
  assert.equal(deck.length, 110);
  assert.equal(new Set(deck.map(card => card.id)).size, 110);
  for (const card of CARDS) {
    assert.equal(deck.filter(entity => entity.definitionId === card.id).length, card.copies);
    assert.throws(() => { card.name = 'changed'; }, TypeError);
    assert.throws(() => card.details.push('changed'), TypeError);
  }
  assert.throws(() => { getCard('yousei.g01').goods.firearms = 99; }, TypeError);
  assert.throws(() => { INITIAL_STOCK.firearms = 99; }, TypeError);
  assert.throws(() => { GOODS[0].initialStock = 99; }, TypeError);
  assert.throws(() => { deck[0].definitionId = 'bad'; }, TypeError);
  assert.throws(() => deck.reverse(), TypeError);
  assert.notEqual(createDeck(), deck);
  assert.notEqual(createDeck()[0], deck[0]);
});

test('unknown IDs and versions reject rather than silently selecting a known definition', () => {
  for (const unknown of [null, undefined, '', '__proto__', 'yousei.g99']) {
    assert.throws(() => getCard(unknown), RangeError);
    assert.throws(() => getGood(unknown), RangeError);
    assert.throws(() => getCategory(unknown), RangeError);
    assert.throws(() => getAsset(unknown), RangeError);
    assert.throws(() => assertContentVersion(unknown), RangeError);
  }
});

test('39 original subjects map to every one of the 51 card faces without private source paths', () => {
  assert.equal(ASSETS.length, 39);
  assert.equal(new Set(ASSETS.map(asset => asset.id)).size, 39);
  assert.equal(ASSETS.filter(asset => asset.file.endsWith('.webp')).length, 32);
  assert.equal(CARD_FACES.length, 51);
  for (const card of CARDS) {
    const face = CARD_FACES.find(face => face.cardId === card.id);
    assert.ok(face && face.assetIds.length && face.textFallback);
    assert.equal(face.sourceCode, card.sourceCode);
    for (const id of face.assetIds) {
      assert.ok(getAsset(id).cardIds.includes(card.id));
      assert.match(assetPath(id), /^\/assets\/hyakki\/v2\/[a-z0-9-]+\.(?:svg|webp)$/u);
    }
    assert.ok(face.scenes.includes('catalog') && face.scenes.includes('details'));
  }
  for (const asset of ASSETS) {
    assert.equal(assetPath(asset.id, 'https://example.test/game/entry-path.mjs'), `/game/assets/hyakki/v2/${asset.file}`);
    assert.equal(assetPath(asset.id, 'https://example.test/entry-path.mjs'), `/assets/hyakki/v2/${asset.file}`);
  }
  assert.doesNotMatch(JSON.stringify({ CARDS, ASSETS, CARD_FACES }), /ops\/|sourceArchive|sourceBatch|sourceIds|physical-card-catalog|\/Users\/|\.jpe?g/iu);
});

test('digital details retain special response, cost, privacy and tool distinctions', () => {
  const details = id => getCard(`yousei.${id}`).details.join(' ');
  assert.match(details('c04'), /交易保留/u);
  assert.match(details('c05'), /G19.*不可/u);
  assert.match(details('c07'), /尚未执行的效果费用不支付/u);
  assert.match(details('c03'), /买价最低0/u);
  assert.match(details('c02'), /原相对顺序/u);
  assert.match(details('c12'), /全部公开/u);
  assert.match(details('m06'), /竖直.*最多各3/u);
  assert.match(details('m08'), /纸上仙.*不能借用/u);
  assert.match(details('m08'), /只能支付自己的手牌或已安装道具/u);
  assert.match(details('t01'), /每张候选本次最多查看一次/u);
  assert.match(details('t01'), /未找到.*不支付.*行动和横置仍保留/u);
  assert.match(details('t04'), /对手只看自己获得的一张/u);
  assert.match(details('t07'), /新安装.*不能立即激活/u);
  assert.match(details('t09'), /共4两/u);
});
