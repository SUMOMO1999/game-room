import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, getCard } from './cards.mjs';
import { classifyPattern, remainingPenalty } from './patterns.mjs';
import { fixture, SCENES } from './test-support/preview-fixtures.mjs';
import { handLayout, publicLayout } from './layout.mjs';

const deckIds = makeDeck().map(card => card.id).sort();

for (const [scene] of SCENES) {
  test(`fixture ${scene}: every one of 108 entities belongs to exactly one real zone`, () => {
    const view = fixture(scene, 1000);
    // Current target is a reference to public cards, not another physical zone.
    const cards = [...view.undealtCards, ...view.players.flatMap(player => player.hand),
      ...view.publicGroups.flatMap(group => group.cards)];
    assert.equal(cards.length, 108);
    assert.deepEqual(cards.map(card => card.id).sort(), deckIds);
    for (const card of cards) assert.deepEqual(card, getCard(card.id));
    for (const player of view.players) {
      assert.equal(player.count, player.hand.length);
      assert.ok(player.count <= Math.ceil(108 / view.players.length));
    }
    assert.deepEqual(view.actionOrder, [view.seatOrder[0], ...view.seatOrder.slice(1).reverse()]);
    if (view.target) assert.ok(view.publicGroups.includes(view.target));
  });
}

test('preparation does not assign cards or a first player before the match begins', () => {
  for (const scene of ['waiting', 'waiting-eight']) {
    const view = fixture(scene);
    assert.equal(view.phase, 'waiting');
    assert.equal(view.undealtCards.length, 108);
    assert.equal(view.players.reduce((sum, player) => sum + player.count, 0), 0);
    assert.deepEqual(view.hand, []);
    assert.equal(view.turnPlayerId, null);
    assert.equal(view.firstPlayerId, null);
    assert.equal(view.response, null);
  }
});

test('initial density examples have 36-card and 14-card self hands from counterclockwise dealing', () => {
  const three = fixture('opening'), eight = fixture('eight');
  assert.deepEqual(three.players.map(player => player.count), [36, 36, 36]);
  assert.equal(three.hand.length, 36);
  assert.equal(eight.hand.length, 14);
  assert.deepEqual(eight.actionOrder.map(id => eight.players.find(player => player.id === id).count), [14, 14, 14, 14, 13, 13, 13, 13]);
  for (const view of [three, eight]) {
    assert.equal(view.publicGroups.length, 0);
    assert.equal(view.undealtCards.length, 0);
    assert.equal(view.firstPlayerId, view.selfId);
    assert.equal(view.turnPlayerId, view.firstPlayerId);
    assert.ok(view.hand.some(card => card.id === 'p414-2-hearts-3-0'));
  }
});

test('dense table is 98 public plus 2 self plus 8 opponents, with history strips not fake actions', () => {
  const view = fixture('dense');
  assert.equal(view.publicGroups.reduce((sum, group) => sum + group.cards.length, 0), 98);
  assert.equal(view.hand.length, 2);
  assert.equal(view.players.slice(1).reduce((sum, player) => sum + player.count, 0), 8);
  assert.ok(view.players.every(player => player.count > 0));
  const strips = view.publicGroups.filter(group => group.displayKind === 'history-strip');
  assert.equal(strips.length, 15);
  for (const strip of strips) {
    assert.match(strip.label, /已出牌第\d+排.*多次行动/);
    assert.doesNotMatch(strip.label, /第\d+手/);
  }
  assert.deepEqual(classifyPattern(view.target.cards.map(card => card.id)), { kind: 'bomb', count: 8, rank: 6, rocketTier: 0 });
  assert.equal(view.response, null);
});

test('response example moves just one public card, keeps initial hand limits and a real next player', () => {
  const view = fixture('response', 1000);
  assert.equal(view.publicGroups[0].cards.length, 1);
  assert.deepEqual(view.players.map(player => player.count), [36, 35, 36]);
  assert.ok(view.hand.filter(card => card.rank === 9).length >= 2);
  assert.equal(view.response.action, 'fork');
  assert.equal(view.response.deadlineAt, 6000);
  const next = view.actionOrder[(view.actionOrder.indexOf(view.targetOwnerId) + 1) % view.actionOrder.length];
  assert.equal(view.turnPlayerId, next);
});

test('spectator keeps the preview identity while it leaves the player role and has no personal hand', () => {
  const view = fixture('spectator');
  assert.equal(view.selfRole, 'spectator');
  assert.equal(view.selfId, fixture('opening').selfId);
  assert.ok(view.spectators.some(observer => observer.id === view.selfId));
  assert.equal(view.players.some(player => player.id === view.selfId), false);
  assert.deepEqual(view.hand, []);
  assert.equal(view.players.length, 8);
  assert.equal(view.spectators.length, 8);
  assert.equal(view.players.reduce((sum, player) => sum + player.hand.length, 0), 108);
  assert.equal(view.actionOrder.includes(view.selfId), false);
  assert.equal(view.seatOrder.includes(view.selfId), false);
  assert.notEqual(view.firstPlayerId, view.selfId);
  assert.notEqual(view.turnPlayerId, view.selfId);
});

test('finished example has a legal eight-card final bomb and actual remaining-card penalties', () => {
  const view = fixture('finished');
  const winningPlayer = view.players[0];
  assert.equal(winningPlayer.count, 0);
  assert.ok(view.players.slice(1).every(player => player.count > 0));
  assert.equal(view.targetOwnerId, winningPlayer.id);
  assert.equal(view.turnPlayerId, null);
  assert.equal(view.response, null);
  assert.deepEqual(classifyPattern(view.target.cards.map(card => card.id)), { kind: 'bomb', count: 8, rank: 6, rocketTier: 0 });
  assert.deepEqual(view.result.map(row => row.delta), [45, -10, -5, -6, -20, -2, -1, -1]);
  for (let index = 1; index < view.players.length; index++) {
    assert.equal(view.result[index].delta, -remainingPenalty(view.players[index].hand.map(card => card.id)).points);
  }
  assert.equal(view.result.reduce((sum, row) => sum + row.delta, 0), 0);
  assert.deepEqual(view.result.map(row => row.balanceAfter), [145, 40, 45, 44, 30, 48, 49, 49]);
});

test('hand targets fit width without overlap and retain 44px height within feasible height budgets', () => {
  for (const width of [280, 320, 362, 744, 800, 1180]) {
    for (const count of [0, 2, 8, 14, 36]) {
      for (const short of [false, true]) {
        const layout = handLayout(width, count, { short });
        const minimumHeight = layout.rows ? layout.rows * 44 + (layout.rows - 1) * layout.gap : 0;
        const compact = handLayout(width, count, { short, maxHeight: minimumHeight + 10 });
        assert.ok(layout.cardWidth >= 44);
        assert.ok(layout.cardHeight >= 44);
        assert.ok(layout.columns * layout.cardWidth + (layout.columns - 1) * layout.gap <= width + 0.000001);
        assert.ok(layout.rows * layout.columns >= count);
        assert.equal(layout.gap, 2);
        assert.ok(compact.cardHeight >= 44);
        assert.ok(compact.height <= minimumHeight + 10);
      }
    }
  }
});

test('all density fixtures keep a deterministic hand geometry after portrait-landscape-portrait', () => {
  for (const scene of ['opening', 'eight', 'response', 'dense', 'spectator']) {
    const view = fixture(scene), before = structuredClone(view);
    const portrait = handLayout(362, view.hand.length, { maxHeight: 330 });
    handLayout(744, view.hand.length, { short: true, maxHeight: 120 });
    assert.deepEqual(handLayout(362, view.hand.length, { maxHeight: 330 }), portrait);
    assert.deepEqual(view, before);
  }
});

test('public table geometry preserves group adjacency in representative available areas', () => {
  const groups = fixture('dense').publicGroups.map(group => group.cards);
  for (const [width, height, compact = false] of [[362, 340], [744, 140], [990, 300], [744, 80, true]]) {
    const layout = publicLayout(width, height, groups, { compact });
    assert.ok(layout.cardWidth >= 12 && layout.cardWidth <= 36);
    let usedWidth = 0, rows = 1;
    for (const group of groups) {
      const groupWidth = group.length * layout.cardWidth + group.length - 1;
      assert.ok(groupWidth <= width);
      if (usedWidth && usedWidth + layout.gap + groupWidth > width) { rows++; usedWidth = 0; }
      usedWidth += (usedWidth ? layout.gap : 0) + groupWidth;
    }
    // Mirrors actual CSS block dimensions, not an arbitrary SVG bounding box:
    // 11px title + 3px inside gap, then 8px between flex rows.
    assert.ok(rows * (layout.cardHeight + (compact ? 0 : 14)) + (rows - 1) * 8 <= height);
  }
});

test('invalid fixture names, counts and widths fail visibly', () => {
  assert.throws(() => fixture('invented'), RangeError);
  for (const width of [NaN, Infinity, -1, 43, '320']) assert.throws(() => handLayout(width, 3), RangeError);
  for (const count of [-1, 1.5, 109, '3']) assert.throws(() => handLayout(320, count), RangeError);
  for (const maxHeight of [NaN, -1, -Infinity, '330', null]) assert.throws(() => handLayout(320, 36, { maxHeight }), RangeError);
  assert.throws(() => handLayout(320, 36, { short: 'true' }), RangeError);
});

test('an impossible height budget cannot silently shrink interactive targets below 44px', () => {
  const layout = handLayout(280, 36, { maxHeight: 40 });
  assert.equal(layout.cardHeight, 44);
  assert.ok(layout.height > 40);
  // The caller can detect this required area and reserve more room; claiming
  // a fit by shrinking the individual hit targets is not an acceptable fallback.
  assert.equal(handLayout(280, 0, { maxHeight: 0 }).height, 0);
});
