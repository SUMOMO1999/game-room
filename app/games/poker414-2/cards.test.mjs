import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_VERSION, SUITS, makeDeck, getCard, cardLabel, rankLabel } from './cards.mjs';
import { ART_VERSION, renderCard, renderCardBack, renderPatternBadge } from './art.mjs';

test('two decks contain 54 faces and exactly two distinct entities per face', () => {
  const cards = makeDeck(), faces = new Map();
  assert.equal(cards.length, 108);
  assert.equal(new Set(cards.map(card => card.id)).size, 108);
  for (const card of cards) {
    if (!faces.has(card.faceId)) faces.set(card.faceId, []);
    faces.get(card.faceId).push(card);
    assert.equal(getCard(card.id).id, card.id);
  }
  assert.equal(faces.size, 54);
  for (const copies of faces.values()) {
    assert.deepEqual(copies.map(card => card.copyId), [0, 1]);
    assert.equal(cardLabel(copies[0]), cardLabel(copies[1]));
  }
  assert.deepEqual(SUITS, ['spades', 'hearts', 'clubs', 'diamonds']);
  for (const suit of SUITS) assert.equal(cards.filter(card => card.suit === suit).length, 26);
  assert.equal(cards.filter(card => card.rank === 16).length, 2);
  assert.equal(cards.filter(card => card.rank === 17).length, 2);
  assert.equal(cards.filter(card => card.suit === 'hearts' && card.rank === 3).length, 2);
  assert.equal(CARD_VERSION, 'p414-2-cards-v1');
});

test('decks are independently mutable but canonical entities cannot be changed', () => {
  const first = makeDeck(), second = makeDeck();
  const id = first[0].id;
  first[0].rank = 99;
  first.reverse(); first.pop();
  assert.equal(second.length, 108);
  assert.equal(second[0].rank, 3);
  assert.equal(getCard(id).rank, 3);
  assert.throws(() => { getCard(id).rank = 99; }, TypeError);
  assert.throws(() => SUITS.push('new-suit'), TypeError);
});

test('unknown IDs and inconsistent entities are rejected instead of rendered as another card', () => {
  for (const id of [null, undefined, 0, {}, 'p414-2-hearts-3-2', 'p414-2-joker-15-0', '__proto__', 'p414-2-hearts-3-0\" onclick=\"x']) {
    assert.throws(() => getCard(id), RangeError);
  }
  const card = makeDeck()[0];
  for (const field of ['faceId', 'copyId', 'suit', 'rank']) {
    const invalid = { ...card, [field]: 'forged' };
    assert.throws(() => cardLabel(invalid), TypeError);
    assert.throws(() => renderCard(invalid), TypeError);
  }
  assert.throws(() => cardLabel(null), TypeError);
  assert.throws(() => cardLabel([]), TypeError);
});

test('face labels use normal poker symbols and Chinese suits, not internal rank numbers', () => {
  for (const [rank, label] of [[3, '3'], [10, '10'], [11, 'J'], [12, 'Q'], [13, 'K'], [14, 'A'], [15, '2'], [16, '小王'], [17, '大王']]) {
    assert.equal(rankLabel(rank), label);
  }
  assert.equal(cardLabel(getCard('p414-2-hearts-14-0')), '红桃A');
  assert.equal(cardLabel(getCard('p414-2-clubs-15-1')), '梅花2');
  assert.equal(cardLabel(getCard('p414-2-joker-16-0')), '小王');
  for (const rank of [2, 18, 3.5, '3', NaN]) assert.throws(() => rankLabel(rank), RangeError);
});

test('a selected entity is a single button with independent identity and accessible state', () => {
  const markup = renderCard(getCard('p414-2-clubs-4-1'), { selected: true });
  assert.equal((markup.match(/<button\b/g) || []).length, 1);
  assert.match(markup, /^<button /);
  assert.match(markup, /type="button"/);
  assert.match(markup, /data-card-id="p414-2-clubs-4-1"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /aria-label="梅花4，第2张，已选中"/);
  assert.match(markup, /class="p414-card__rank">4<\/span>/);
  assert.match(markup, /class="p414-card__caption" aria-hidden="true">梅花<\/span>/);
});

test('disabled controls really disable and read-only cards do not introduce an action', () => {
  const card = makeDeck()[0];
  const disabled = renderCard(card, { disabled: true, compact: true });
  assert.match(disabled, /aria-pressed="false" disabled>/);
  assert.match(disabled, /p414-card--compact/);
  const readonly = renderCard(card, { interactive: false });
  assert.match(readonly, /^<span .*role="img"/);
  assert.doesNotMatch(readonly, /<button|aria-pressed|tabindex|onclick/);
  assert.throws(() => renderCard(card, { selected: 'true' }), TypeError);
});

test('all 108 entities render with no network, script, image or inline event dependency', () => {
  for (const card of makeDeck()) {
    const markup = renderCard(card);
    assert.match(markup, new RegExp(`data-card-id="${card.id}"`));
    assert.match(markup, /data-art-version="p414-2-art-vector-v1"/);
    assert.match(markup, /p414-card__caption/);
    assert.doesNotMatch(markup, /<script|<image|<img|<foreignObject|\shref=|\ssrc=|\son\w+=/i);
  }
  assert.equal(ART_VERSION, 'p414-2-art-vector-v1');
});

test('jokers differ by silhouette and normal text as well as color', () => {
  const small = renderCard(getCard('p414-2-joker-16-0'));
  const large = renderCard(getCard('p414-2-joker-17-0'));
  assert.match(small, /p414-card--small-joker/);
  assert.match(large, /p414-card--large-joker/);
  assert.match(small, />小王<\/span>/);
  assert.match(large, />大王<\/span>/);
  assert.notEqual(small.match(/<svg[\s\S]*<\/svg>/)[0], large.match(/<svg[\s\S]*<\/svg>/)[0]);
  assert.doesNotMatch(small + large, /\p{Extended_Pictographic}/u);
});

test('uniform card back has no face or physical identity and cannot be selected', () => {
  const back = renderCardBack();
  assert.match(back, /^<span class="p414-card p414-card--back"/);
  assert.match(back, /aria-label="未公开的牌，统一牌背"/);
  assert.match(back, />牌背<\/span>/);
  assert.equal(renderCardBack(makeDeck()[0]), back);
  assert.doesNotMatch(back, /data-card-id|data-face-id|data-copy-id|data-suit|data-rank|aria-pressed|<button|tabindex/);
});

test('three rocket badges show genuine suit combinations and distinct visible labels', () => {
  const labels = ['杂色火箭', '纯色火箭（非红桃）', '纯红桃火箭'];
  const expectedSuits = [['spades', 'diamonds', 'hearts'], ['clubs', 'clubs', 'clubs'], ['hearts', 'hearts', 'hearts']];
  for (let level = 1; level <= 3; level++) {
    const badge = renderPatternBadge({ kind: 'rocket', level });
    assert.match(badge, new RegExp(`data-pattern-level="${level}"`));
    assert.ok(badge.includes(`>${labels[level - 1]}</span>`));
    assert.deepEqual([...badge.matchAll(/data-badge-suit="([a-z]+)"/g)].map(match => match[1]), expectedSuits[level - 1]);
    assert.equal((badge.match(/>4<\/text>/g) || []).length, 2);
    assert.equal((badge.match(/>A<\/text>/g) || []).length, 1);
  }
});

test('bomb badges represent every count from three through eight with matching cards and text', () => {
  for (let count = 3; count <= 8; count++) {
    const badge = renderPatternBadge({ kind: 'bomb', count });
    assert.match(badge, new RegExp(`data-pattern-count="${count}"`));
    assert.equal((badge.match(/data-bomb-card=/g) || []).length, count);
    assert.equal((badge.match(/<circle /g) || []).length, count);
    assert.ok(badge.includes(`>${count}张炸弹</span>`));
    assert.ok(badge.includes(`${count}张同点数普通牌`));
  }
});

test('reading badges reject unknown types, invalid limits and injected fields', () => {
  for (const pattern of [null, [], 'rocket', {}, { kind: 'rocket', level: 0 }, { kind: 'rocket', level: 4 },
    { kind: 'rocket', level: '1' }, { kind: 'rocket', level: 1, onclick: 'bad' },
    { kind: 'bomb', count: 2 }, { kind: 'bomb', count: 9 }, { kind: 'bomb', count: 3.5 },
    { kind: 'rocket', count: 3 }, { kind: 'unknown', count: 3 }]) {
    assert.throws(() => renderPatternBadge(pattern));
  }
});

test('card back and pattern badges require no network, executable content or emoji', () => {
  const assets = [renderCardBack(), ...[1, 2, 3].map(level => renderPatternBadge({ kind: 'rocket', level })),
    ...[3, 4, 5, 6, 7, 8].map(count => renderPatternBadge({ kind: 'bomb', count }))];
  for (const markup of assets) {
    assert.doesNotMatch(markup, /<script|<image|<img|<foreignObject|\shref=|\ssrc=|\son\w+=/i);
    assert.doesNotMatch(markup, /\p{Extended_Pictographic}/u);
    assert.match(markup, /role="img"/);
    assert.match(markup, /aria-label="[^\"]+"/);
  }
});
