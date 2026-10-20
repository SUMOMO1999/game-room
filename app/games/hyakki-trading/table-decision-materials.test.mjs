import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, GOODS } from './content/definitions.mjs';
import { buildChoiceSelection } from './game-ui-model.mjs';
import { nativeCardInput, nativeChoiceDraft, nativeChoiceReady, renderNativeMaterials, updateNativeChoice } from './table-decision-ui.mjs';

const ids = ['self', 'other'];
const stock = Object.fromEntries(GOODS.map(good => [good.id, 3]));
const face = code => CARDS.find(card => card.sourceCode === code);
const card = (id, code) => ({ cardId: id, definitionId: face(code).id });
function fixture() {
  return { players: [{ id: ids[0], goods: { ...stock }, hand: [card('fee-hand', 'G01')], tools: [card('fee-tool', 'T03')] },
    { id: ids[1], goods: { ...stock }, hand: [], tools: [] }], bankGoods: { ...stock }, discard: [card('external-fee', 'G02')] };
}
const decode = value => value.replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, '&');
function actions(markup) {
  return [...markup.matchAll(/<button\b[^>]*data-hy-fields="([^"]*)"[^>]*>/gu)].map(match => ({ fields: JSON.parse(decode(match[1])), disabled: /\sdisabled(?:\s|>)/u.test(match[0]) }));
}
function render(game, pending, draft, extra = {}) {
  return renderNativeMaterials({ game, pending, draft, selfId: ids[0], name: id => id, canChoose: true, ...extra });
}

test('two-sided exchange keeps all twelve choices and the borrowed material address', () => {
  const game = fixture(), pending = { code: 'T02', choice: { kind: 'tool-exchange', options: [{ ownGoodIds: GOODS.map(good => good.id), otherGoodIds: GOODS.map(good => good.id) }] } };
  const before = structuredClone(game);
  let draft = nativeChoiceDraft(pending);
  const choices = actions(render(game, pending, draft, { borrowPartIndex: 2 }));
  assert.equal(choices.length, 12);
  for (const field of ['ownGoodId', 'otherGoodId']) {
    assert.deepEqual(choices.filter(choice => choice.fields.field === field).map(choice => choice.fields.id), GOODS.map(good => good.id));
  }
  assert.ok(choices.every(choice => choice.fields.borrowPart === 2 && !choice.disabled));
  for (const fields of [choices[5].fields, choices[6].fields]) draft = updateNativeChoice(pending, draft, fields.type, fields);
  assert.equal(nativeChoiceReady(pending, draft), true);
  assert.deepEqual(buildChoiceSelection(pending, draft), { ownGoodId: GOODS[5].id, otherGoodId: GOODS[0].id });
  assert.deepEqual(game, before, 'reading and choosing only updates the local draft');
});

test('payment materials keep original indexes while owned cards stay in their actual zones', () => {
  const game = fixture(), payments = [{ zone: 'hand', cardId: 'fee-hand' }, { zone: 'tool', cardId: 'fee-tool' }, { zone: 'discard', cardId: 'external-fee' }];
  const pending = { code: 'T10', choice: { kind: 'tool-payment-good', options: [{ goodIds: GOODS.map(good => good.id), payments }] } };
  let draft = nativeChoiceDraft(pending);
  const markup = render(game, pending, draft, { partIndex: 1 }), choices = actions(markup);
  assert.match(markup, /下方手牌或已装备道具中选1张/u);
  assert.equal(choices.filter(choice => choice.fields.type === 'good').length, 6);
  assert.deepEqual(choices.filter(choice => choice.fields.type === 'payment').map(choice => choice.fields), [{ type: 'payment', index: 2, part: 1 }]);
  assert.doesNotMatch(markup, /data-material-card="fee-(?:hand|tool)"/u);
  const input = nativeCardInput(pending, 'fee-tool');
  draft = updateNativeChoice(pending, draft, input.type, input);
  draft = updateNativeChoice(pending, draft, 'good', { id: 'imports' });
  assert.deepEqual(buildChoiceSelection(pending, draft), { goodId: 'imports', payment: payments[1] });
  assert.match(render(game, pending, draft), new RegExp(`已选费用：${face('T03').name}；确认后弃掉。`, 'u'));
});

test('read-only material previews cannot enable either side of an exchange', () => {
  const game = fixture(), pending = { code: 'T02', choice: { kind: 'tool-exchange', options: [{ ownGoodIds: ['firearms'], otherGoodIds: ['imports'] }] } };
  const draft = { ownGoodId: 'firearms', otherGoodId: 'imports' }, before = structuredClone({ game, pending, draft });
  const choices = actions(render(game, pending, draft, { canChoose: false }));
  assert.equal(choices.length, 2);
  assert.ok(choices.every(choice => choice.disabled));
  assert.deepEqual({ game, pending, draft }, before);
});
