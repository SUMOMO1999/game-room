import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from './cards.mjs';
import { classifyPattern, beatsPattern, enumerateLegalPlays, chooseResponseCards,
  remainingPenalty, patternKey, cardsProblem } from './patterns.mjs';

const deck = makeDeck();
const rank = (value, count = 1) => deck.filter(card => card.rank === value).slice(0, count).map(card => card.id);
const face = (suit, value, count = 1) => deck.filter(card => card.suit === suit && card.rank === value).slice(0, count).map(card => card.id);
const mixed = [...face('spades', 4), ...face('diamonds', 4), ...face('diamonds', 14)];
const pure = suit => [...face(suit, 4, 2), ...face(suit, 14)];
const classify = ids => { const pattern = classifyPattern(ids); assert.ok(pattern); return pattern; };

test('T01–T05: bombs compare quantity, then rank; same kings are ordinary pairs', () => {
  assert.equal(beatsPattern(classify(rank(3, 7)), classify(rank(13, 6))), true);
  assert.equal(beatsPattern(classify(rank(15, 6)), classify(rank(3, 7))), false);
  assert.equal(beatsPattern(classify(rank(6, 4)), classify(rank(5, 4))), true);
  assert.equal(beatsPattern(classify(rank(5, 4)), classify(rank(5, 4))), false);
  assert.equal(classify(rank(16, 2)).kind, 'pair-small-jokers');
  assert.equal(classify(rank(17, 2)).kind, 'pair-large-jokers');
  assert.equal(beatsPattern(classify(rank(16, 2)), classify(rank(15, 2))), true);
  assert.equal(beatsPattern(classify(rank(17, 2)), classify(rank(16, 2))), true);
  assert.equal(beatsPattern(classify(rank(17, 2)), classify(rank(3, 3))), false);
  assert.equal(beatsPattern(classify([...rank(16), ...rank(17)]), classify(rank(15, 8))), true);
  assert.equal(classifyPattern([...rank(16, 2), ...rank(17)]), null);
  assert.equal(classifyPattern([...rank(16, 2), ...rank(17, 2)]), null);
});

test('T06/T16/T19: rocket physical copies and three grade equality are exact', () => {
  const a = classify(mixed), b = classify(pure('clubs')), c = classify(pure('hearts'));
  assert.equal(a.rocketTier, 1); assert.equal(b.rocketTier, 2); assert.equal(c.rocketTier, 3);
  assert.equal(beatsPattern(b, a), true); assert.equal(beatsPattern(c, b), true);
  assert.equal(beatsPattern(classify(pure('spades')), b), false);
  assert.equal(beatsPattern(a, a), false);
  assert.equal(beatsPattern(a, classify([...rank(16), ...rank(17)])), true);
  assert.equal(classifyPattern([...face('clubs', 4), ...face('clubs', 14, 2)]), null);
  assert.equal(new Set(pure('clubs')).size, 3);
});

test('inherited sequence boundaries: 3–A only, equal lengths, no triples or wraparound', () => {
  const straight = values => values.flatMap(value => rank(value));
  const pairs = values => values.flatMap(value => rank(value, 2));
  assert.equal(classify(straight([3, 4, 5])).kind, 'straight');
  assert.equal(classify(straight(Array.from({ length: 12 }, (_, index) => index + 3))).count, 12);
  assert.equal(classify(pairs(Array.from({ length: 12 }, (_, index) => index + 3))).count, 24);
  assert.equal(beatsPattern(classify(straight([4, 5, 6])), classify(straight([3, 4, 5]))), true);
  assert.equal(beatsPattern(classify(straight([4, 5, 6, 7])), classify(straight([3, 4, 5]))), false);
  assert.equal(beatsPattern(classify(pairs([4, 5, 6])), classify(straight([3, 4, 5]))), false);
  for (const cards of [straight([14, 15, 3]), straight([13, 14, 15]), pairs([3, 4]),
    [3, 4, 5].flatMap(value => rank(value, 3)), [...rank(3, 3), ...rank(5)], []]) {
    assert.equal(classifyPattern(cards), null);
  }
});

test('T18: remaining penalties extract rockets and joker bombs without double counting', () => {
  assert.deepEqual(remainingPenalty([...rank(4, 8), ...rank(14, 4)]), { points: 40, rockets: 4, jokerBombs: 0 });
  assert.equal(remainingPenalty([...rank(16, 2), ...rank(17, 2)]).points, 10);
  assert.equal(remainingPenalty([...rank(16, 2), ...rank(17)]).points, 6);
  assert.equal(remainingPenalty(rank(16, 2)).points, 2);
  assert.equal(remainingPenalty([...rank(4, 4), ...rank(14, 2)]).points, 20);
  assert.equal(remainingPenalty([...rank(4, 2), ...rank(14), ...rank(16)]).points, 11);
});

test('unique-play assistance deduplicates physical copies but preserves rocket grades', () => {
  const hand = [...pure('hearts'), ...pure('clubs'), ...face('diamonds', 9, 2)];
  const choices = enumerateLegalPlays(hand, classify([...rank(16), ...rank(17)]));
  assert.deepEqual(choices.map(choice => choice.pattern.rocketTier).sort(), [1, 2, 3]);
  const single = enumerateLegalPlays(face('diamonds', 9, 2), classify(rank(8)));
  assert.equal(single.length, 1);
  assert.equal(single[0].cardIds.length, 1);
  assert.equal(new Set(choices.map(choice => patternKey(choice.pattern))).size, choices.length);
});

test('response auto-pick is stable and cannot silently change the required number', () => {
  const hand = rank(7, 8).reverse();
  assert.deepEqual(chooseResponseCards(hand, 7, 'hook'), face('spades', 7));
  assert.deepEqual(chooseResponseCards(hand, 7, 'fork'), face('spades', 7, 2));
  assert.equal(chooseResponseCards(rank(7), 7, 'fork'), null);
  assert.throws(() => chooseResponseCards(rank(16, 2), 16, 'hook'));
});

test('all bounded enumerated choices are physically present, legal, and equivalent-class unique', () => {
  let seed = 41;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let sample = 0; sample < 24; sample += 1) {
    const pool = deck.map(card => card.id);
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const next = Math.floor(random() * (index + 1)); [pool[index], pool[next]] = [pool[next], pool[index]];
    }
    const hand = pool.slice(0, 36), choices = enumerateLegalPlays(hand);
    assert.ok(choices.length < 256);
    assert.equal(new Set(choices.map(choice => patternKey(choice.pattern))).size, choices.length);
    for (const choice of choices) {
      assert.ok(choice.cardIds.every(id => hand.includes(id)));
      assert.deepEqual(classifyPattern(choice.cardIds), choice.pattern);
    }
    const target = classify(rank(10, 3));
    assert.ok(enumerateLegalPlays(hand, target).every(choice => beatsPattern(choice.pattern, target)));
  }
});

test('unknown, duplicate, oversized, sparse and invalid entities never classify as a legal hand', () => {
  const first = rank(3)[0];
  for (const invalid of [null, 'cards', [first, first], ['not-a-card'], [null], new Array(2)]) {
    assert.equal(classifyPattern(invalid), null);
    assert.throws(() => enumerateLegalPlays(invalid));
  }
  assert.ok(cardsProblem(deck.slice(0, 37).map(card => card.id)));
  assert.equal(beatsPattern({ kind: 'rocket', count: 3, rank: 4, rocketTier: 99 }, null), false);
});
