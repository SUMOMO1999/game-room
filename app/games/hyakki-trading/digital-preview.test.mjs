import test from 'node:test';
import assert from 'node:assert/strict';
import { digitalFixture, DIGITAL_SCENES, validPreviewChoice } from './test-support/digital-preview-fixtures.mjs';
import { nextPreviewScene } from './digital-preview.mjs';
import { renderDecisionCandidates, renderPersonalSlots, renderActionTrack } from './digital-page-ui.mjs';
import { getCard } from './content/definitions.mjs';

test('synthetic scenes preserve original examples and add explicitly nonpersistent layout fixtures', () => {
  assert.equal(DIGITAL_SCENES.length, 23);
  for (const [scene] of DIGITAL_SCENES) {
    const view = digitalFixture(scene);
    assert.equal(view.scene, scene); assert.equal(view.synthetic, true); assert.equal(view.saved, false);
    assert.equal(view.players.length, scene === 'layout-six' ? 6 : 2);
    for (const card of view.hand) assert.ok(getCard(card.definitionId));
    if (view.decision) assert.doesNotThrow(() => renderDecisionCandidates(view.decision));
  }
  assert.equal(digitalFixture('unknown').scene, 'active');
});

test('layout fixtures expose representative public seats but never peer hand identities or economic commands', () => {
  for (const scene of ['layout-sparse', 'layout-dense', 'layout-six']) {
    const view = digitalFixture(scene), original = structuredClone(view);
    assert.equal(view.layoutOnly, true); assert.match(view.layoutLabel, /布局演示/);
    assert.equal(view.decision, null);
    assert.deepEqual(view.players.map(player => player.seatOrder), Array.from({ length: view.players.length }, (_, index) => index + 1));
    for (const player of view.players) assert.equal(Object.hasOwn(player, 'hand'), false);
    for (const good of view.market) assert.equal(good.count + view.players.reduce((sum, player) => sum
      + player.goods.find(item => item.id === good.id).count, 0), 8);
    for (const type of ['ready', 'role', 'start', 'peek', 'confirm-draft', 'end-turn', 'respond', 'bid'])
      assert.equal(nextPreviewScene(view, type, { scene, cardId: view.hand[0].id, amount: 1 }), null);
    assert.deepEqual(view, original);
  }
  assert.match(digitalFixture('layout-six').layoutLabel, /尚非多人游戏/);
  assert.equal(digitalFixture('layout-sparse').hand.length, 4);
  assert.equal(digitalFixture('layout-sparse').players[0].tools.length, 0);
  assert.equal(digitalFixture('layout-dense').hand.length, 36);
  assert.equal(digitalFixture('layout-dense').players[0].tools.length, 3);
  assert.deepEqual(digitalFixture('layout-six').players.map(player => player.tools.length), [3, 0, 1, 2, 3, 2]);
});

test('public stock and both shops preserve the frozen six-per-type display, including paid temporary slot', () => {
  for (const scene of ['active', 'full']) {
    const view = digitalFixture(scene);
    for (const good of view.market) assert.equal(good.count + view.players.reduce((sum, player) =>
      sum + player.goods.find(item => item.id === good.id).count, 0), 6);
    const slots = renderPersonalSlots(view.players[0]);
    assert.equal((slots.match(/class="yg-stock-slot/gu) ?? []).length, 6);
    assert.match(slots, /收费临时格/); assert.match(slots, /普通格5/);
  }
  assert.equal(digitalFixture('full').temporaryPaid, true);
});

test('spectator projection contains no private cards, candidates or actionable decision', () => {
  const view = digitalFixture('spectator');
  assert.deepEqual(view.hand, []); assert.equal(view.decision, null);
  assert.equal(nextPreviewScene(view, 'peek'), null);
  assert.equal(nextPreviewScene(view, 'confirm-draft', { scene: view.scene, cardId: 'yousei.c02#01' }), null);
  assert.equal(validPreviewChoice(view, 'choice-0'), false);
});

test('private candidates stay fixed and closing/unknown commands never resample or resolve the decision', () => {
  const view = digitalFixture('oracle'), original = structuredClone(view);
  assert.equal(nextPreviewScene(view, 'close-detail', { decisionId: view.decision.id }), null);
  assert.equal(nextPreviewScene(view, 'peek'), null);
  assert.deepEqual(view, original);
  assert.equal(view.decision.candidates.length, 6);
  assert.equal(digitalFixture('lamp').decision.candidates.length, 2);
});

test('choice completion requires the current decision, exact candidate and player role', () => {
  const view = digitalFixture('oracle'), fields = { decisionId: view.decision.id, selected: ['choice-2'] };
  assert.equal(nextPreviewScene(view, 'choose-effect', fields), 'active');
  assert.equal(nextPreviewScene(view, 'choose-effect', { ...fields, decisionId: 'old-step' }), null);
  assert.equal(nextPreviewScene(view, 'choose-effect', { ...fields, selected: ['invented'] }), null);
  assert.equal(nextPreviewScene(view, 'choose-effect', { ...fields, selected: ['choice-2', 'choice-3'] }), null);
  assert.equal(nextPreviewScene({ ...view, selfRole: 'spectator' }, 'choose-effect', fields), null);
  assert.equal(nextPreviewScene({ ...view, phase: 'paused' }, 'choose-effect', fields), null);
});

test('response kinds cannot be swapped and accepting them remains a fixture transition, without asset mutation', () => {
  const view = digitalFixture('guard'), original = structuredClone(view), fields = { decisionId: view.decision.id };
  assert.notEqual(view.currentPlayerId, view.selfId);
  assert.equal(nextPreviewScene(view, 'respond', fields), 'active');
  assert.equal(nextPreviewScene(view, 'keep-peek', fields), null);
  assert.deepEqual(view, original);
});

test('both auction previews reveal the complete actual lot and reject invalid example bids', () => {
  const goods = digitalFixture('goods-auction'), cards = digitalFixture('cards-auction');
  assert.equal(goods.decision.candidates.length, 2); assert.equal(cards.decision.candidates.length, 3);
  const markup = renderDecisionCandidates(cards.decision);
  for (const candidate of cards.decision.candidates) assert.ok(markup.includes(candidate.card.definitionId));
  for (const amount of [3, 21, 4.1, NaN]) assert.equal(nextPreviewScene(cards, 'bid', { decisionId: cards.decision.id, amount }), null);
  assert.equal(nextPreviewScene(cards, 'bid', { decisionId: cards.decision.id, amount: 4 }), 'active');
});

test('start requires two ready players; paused or opponent boards cannot start economic previews', () => {
  const view = digitalFixture('waiting');
  assert.equal(nextPreviewScene(view, 'start'), null);
  view.players[0].ready = true;
  assert.equal(nextPreviewScene(view, 'start'), 'active');
  assert.equal(nextPreviewScene({ ...view, selfRole: 'spectator' }, 'start'), null);
  for (const scene of ['paused', 'suspended', 'opponent', 'result']) assert.equal(nextPreviewScene(digitalFixture(scene), 'peek'), null);
});

test('draft confirmation remains bound to the selected owned card and originating scene', () => {
  const view = digitalFixture('active'), fields = { scene: 'active', cardId: 'yousei.c02#01' };
  assert.equal(nextPreviewScene(view, 'confirm-draft', fields), 'oracle');
  assert.equal(nextPreviewScene(view, 'confirm-draft', { ...fields, scene: 'dense' }), null);
  assert.equal(nextPreviewScene(view, 'confirm-draft', { ...fields, cardId: 'invented' }), null);
});

test('every shown physical card belongs to one visible zone, including candidate pools and dense hands', () => {
  for (const [scene] of DIGITAL_SCENES) {
    const view = digitalFixture(scene);
    const cards = [...view.hand, ...view.players.flatMap(player => player.tools),
      ...(view.discard ? [view.discard] : []), ...(view.decision?.candidates.filter(item => item.kind === 'card').map(item => item.card) ?? [])];
    assert.equal(new Set(cards.map(card => card.id)).size, cards.length, scene);
  }
});

test('read-only action ruler represents every configured limit and boundary without interactive controls', () => {
  for (let limit = 1; limit <= 10; limit += 1) {
    for (const used of [0, Math.floor(limit / 2), limit]) {
      const markup = renderActionTrack(used, limit);
      assert.equal((markup.match(/class="yg-action-tick/g) ?? []).length, limit + 1);
      assert.match(markup, /yg-action-cursor/);
      assert.ok(markup.includes(`--yg-action-progress:${used / limit * 100}%`));
      assert.doesNotMatch(markup, /<button|<input|tabindex/);
    }
  }
  for (const [used, limit] of [[0, 0], [0, 11], [-1, 5], [6, 5], [1.5, 5]]) assert.throws(() => renderActionTrack(used, limit));
});
