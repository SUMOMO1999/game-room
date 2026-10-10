import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, currentDecision, gameProblem } from './rules.mjs';
import { privateView, spectatorView } from './view.mjs';
import { definition, emptyGoods, refreshTemporary } from './model.mjs';
import { cardDraftChoices, cardDraftSelections, cardDraftCost } from './card-draft.mjs';
import { actionDraft, buildChoiceSelection, cardKey, knownCards } from './game-ui-model.mjs';
import { nativeChoiceDraft, nativeChoiceReady, renderNativeWork } from './table-decision-ui.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32), 'd'.repeat(32)];
const context = { now: 1000, randomInt: n => n - 1 };
function fixture(code, playerCount = 2) {
  const state = createGame(ids.slice(0, playerCount), { ...context, matchId: 'c'.repeat(32), actionLimit: 10, goodsPerType: 8 });
  state.deck.push(...state.players.flatMap(player => player.hand));
  state.deck.sort(); state.players.forEach(player => { player.hand = []; });
  state.stage = 'use'; state.drawStarted = true;
  const take = code => { const index = state.deck.findIndex(id => definition(id).sourceCode === code); assert.ok(index >= 0, code); return state.deck.splice(index, 1)[0]; };
  const hand = (player, code) => { const id = take(code); player.hand.push(id); return id; };
  const tool = (player, code) => { const cardId = take(code); player.tools.push({ cardId, exhausted: false }); return cardId; };
  const stock = (player, goods) => { for (const [id, count] of Object.entries(goods)) { player.goods[id] += count; state.bankGoods[id] -= count; } refreshTemporary(player); };
  const cardId = hand(state.players[0], code);
  return { state, cardId, take, hand, tool, stock };
}
function accept(state, type, fields = {}, actor = currentDecision(state)?.actorId ?? state.turnPlayerId) {
  const decision = currentDecision(state), result = applyGameAction(state, actor, { type, matchId: state.matchId, turnId: state.turnId,
    ...(decision ? { effectId: state.pending.id, decisionId: decision.id } : {}), ...fields }, context);
  assert.equal(result.ok, true, result.error); assert.equal(gameProblem(result.state), null); return result.state;
}
function projectedDetail(state, cardId, tool = false, extra = {}) {
  const game = privateView(state, ids[0]);
  const card = (tool ? game.players[0].tools : game.players[0].hand).find(card => cardKey(card) === cardId);
  assert.ok(card, 'source is in the current role projection');
  return { game, detail: { card, tool, choiceInputs: [], ...extra } };
}
function chooseOption(game, detail, partIndex, predicate) {
  const part = cardDraftChoices(game, ids[0], detail)[partIndex];
  const optionIndex = part.choice.options.findIndex(predicate); assert.ok(optionIndex >= 0);
  detail.choiceInputs[partIndex] = { optionIndex };
}
function borrowedFixture(code, ownCount = 0) {
  const f = fixture('M08');
  const toolId = f.tool(f.state.players[1], code), paymentId = f.hand(f.state.players[0], 'G01');
  if (ownCount) f.stock(f.state.players[0], { firearms: ownCount });
  if (code === 'T02') f.stock(f.state.players[1], { imports: 1 });
  let state = accept(f.state, 'play-character', { cardId: f.cardId, params: { targetId: ids[1], toolCardId: toolId } });
  state = accept(state, 'decline-response', {}, ids[1]);
  const game = privateView(state, ids[0]);
  assert.equal(game.pending.choice.kind, 'borrow-tool');
  return { ...f, state, toolId, paymentId, game, detail: { card: game.pending.target, tool: true, choiceInputs: [] } };
}

for (const [count, counter, expectedFee] of [[0, false, 0], [5, false, 2], [6, false, 0], [5, true, 0]]) {
  test(`M01 projected cost and settlement agree: stock ${count}, counter ${counter}`, () => {
    const f = fixture('M01'); f.stock(f.state.players[0], { firearms: count }); f.stock(f.state.players[1], { imports: 1 });
    const counterId = counter ? f.hand(f.state.players[1], 'C07') : null;
    const { game, detail } = projectedDetail(f.state, f.cardId, false, { targetId: ids[1], goodsId: 'imports' });
    const before = structuredClone(f.state);
    for (const short of [false, true]) {
      const text = cardDraftCost(game, ids[0], detail, [], { short });
      assert.match(text, /1行动/); assert.match(text, /被反制不收货物费/);
      assert.equal(text.includes('新占临时格另付2两'), count === 5);
    }
    const command = actionDraft(game, ids[0], detail.card, 'play-character', detail);
    assert.deepEqual(command.params, { targetId: ids[1], goodsId: 'imports' }); assert.deepEqual(f.state, before);
    let state = accept(f.state, 'play-character', command);
    state = accept(state, counter ? 'respond' : 'decline-response', counter ? { cardId: counterId } : {}, ids[1]);
    if (state.pending?.receipt) state = accept(state, 'choose-effect', { selection: state.pending.choice.defaultSelection });
    assert.equal(state.players[0].silver, before.players[0].silver - expectedFee);
    assert.equal(state.actionsUsed, before.actionsUsed + 1);
    if (counter) assert.equal(state.players[1].goods.imports, 1);
  });
}

test('M01 low silver creates a saved retention obligation without a fictitious immediate temporary charge', () => {
  const f = fixture('M01'); f.stock(f.state.players[0], { firearms: 5 }); f.stock(f.state.players[1], { imports: 1 }); f.state.players[0].silver = 1;
  const { game, detail } = projectedDetail(f.state, f.cardId, false, { targetId: ids[1], goodsId: 'imports' });
  assert.match(cardDraftCost(game, ids[0], detail), /超容量再选保留/);
  let state = accept(f.state, 'play-character', actionDraft(game, ids[0], detail.card, 'play-character', detail));
  state = accept(state, 'decline-response', {}, ids[1]); assert.equal(state.players[0].silver, 1);
  const next = privateView(state, ids[0]), pending = next.pending, draft = nativeChoiceDraft(pending);
  assert.equal(pending.choice.kind, 'retain-goods'); assert.equal(nativeChoiceReady(pending, draft), true);
  const markup = renderNativeWork({ pending, game: next, selfId: ids[0], draft, name: id => id, canChoose: true });
  assert.match(markup, /不另付银两/);
  state = accept(state, 'choose-effect', { selection: buildChoiceSelection(pending, draft) });
  assert.equal(state.players[0].silver, 1); assert.equal(state.pending, null);
});

for (const bankCount of [1, 2]) test(`C01 uses actual public stock ${bankCount} and previews the matching incoming temporary fee`, () => {
  const f = fixture('C01');
  f.state.players[1].stallCount = 1; f.state.availableStalls--; f.state.purchasedStalls++;
  f.stock(f.state.players[0], { firearms: 5 }); f.stock(f.state.players[1], { imports: 8 - bankCount });
  const { game, detail } = projectedDetail(f.state, f.cardId, false, { targetId: ids[1] });
  chooseOption(game, detail, 0, option => option.branch === 'goods'); chooseOption(game, detail, 1, option => option.goodsId === 'imports');
  const selections = cardDraftSelections(game, ids[0], detail), before = structuredClone(f.state);
  assert.match(cardDraftCost(game, ids[0], detail, selections), /新占临时格另付2两/);
  const command = actionDraft(game, ids[0], detail.card, 'play-character', { targetId: ids[1], initialChoices: selections });
  assert.equal(command.params.initialChoices.length, 2); assert.deepEqual(f.state, before);
  let state = accept(f.state, 'play-character', command);
  if (bankCount === 1) assert.equal(state.players[0].silver, 18);
  else {
    assert.equal(state.players[0].silver, 20, 'two incoming goods exceed capacity, so retention remains pending');
    state = accept(state, 'choose-effect', { selection: state.pending.choice.defaultSelection }); assert.equal(state.players[0].silver, 18);
  }
  assert.equal(state.pending, null); assert.equal(state.actionsUsed, 1);
});

test('C01 announces at most two draws when the confirmed goods branch leaves no available card', () => {
  const f = fixture('C01'); f.state.players[0].hand.push(...f.state.deck.splice(0));
  const { game, detail } = projectedDetail(f.state, f.cardId, false, { targetId: ids[1] });
  chooseOption(game, detail, 0, option => option.branch === 'goods'); chooseOption(game, detail, 1, option => option.goodsId === 'imports');
  const selections = cardDraftSelections(game, ids[0], detail);
  for (const short of [false, true]) assert.match(cardDraftCost(game, ids[0], detail, selections, { short }), /抽最多2张/);
  const state = accept(f.state, 'play-character', actionDraft(game, ids[0], detail.card, 'play-character', { targetId: ids[1], initialChoices: selections }));
  assert.equal(state.players[1].hand.length, 0); assert.equal(state.players[0].goods.imports, 2); assert.equal(state.pending, null);
});

test('C05 and C13 projected selections form one command and preview real public-layer proceeds', () => {
  const f = fixture('C05'); const tradeId = f.hand(f.state.players[0], 'G01'); f.stock(f.state.players[0], { firearms: 3 }); f.state.bookLayers = 2; f.state.actionsUsed = 2;
  const { game, detail } = projectedDetail(f.state, f.cardId); chooseOption(game, detail, 0, option => option.cardId === tradeId);
  detail.choiceInputs[1] = { goods: { ...emptyGoods(), firearms: 3 } };
  const selections = cardDraftSelections(game, ids[0], detail), proceeds = definition(tradeId).sellSilver + 4;
  assert.match(cardDraftCost(game, ids[0], detail, selections), new RegExp(`获得${proceeds}两`));
  const state = accept(f.state, 'play-character', actionDraft(game, ids[0], detail.card, 'play-character', { initialChoices: selections }));
  assert.equal(state.players[0].silver, 20 + proceeds); assert.equal(state.pending.response.kind, 'merchant'); assert.equal(state.actionsUsed, 3);
  const f13 = fixture('C13'); f13.stock(f13.state.players[0], { imports: 3 });
  const d13 = projectedDetail(f13.state, f13.cardId); d13.detail.choiceInputs[0] = { goods: { ...emptyGoods(), imports: 2 } };
  const s13 = cardDraftSelections(d13.game, ids[0], d13.detail);
  assert.match(cardDraftCost(d13.game, ids[0], d13.detail, s13), /出售2件.*获得4两/);
  assert.equal(accept(f13.state, 'play-character', actionDraft(d13.game, ids[0], d13.detail.card, 'play-character', { initialChoices: s13 })).players[0].silver, 24);
});

for (const code of ['T01', 'T05', 'T09', 'T10']) test(`M08 ${code} preview has zero extra action and the real material/silver fee`, () => {
  const f = borrowedFixture(code, ['T09', 'T10'].includes(code) ? 5 : 0);
  if (code === 'T01') chooseOption(f.game, f.detail, 0, option => option.kind === 'silver');
  if (code === 'T09') chooseOption(f.game, f.detail, 0, option => option.goodId === 'imports');
  if (code === 'T10') {
    const part = cardDraftChoices(f.game, ids[0], f.detail)[0];
    f.detail.choiceInputs[0] = { goodId: 'imports', paymentIndex: part.choice.options[0].payments.findIndex(payment => payment.cardId === f.paymentId) };
  }
  const selections = cardDraftSelections(f.game, ids[0], f.detail), params = selections[0]?.selection ?? {}, before = structuredClone(f.state);
  for (const short of [false, true]) {
    const text = cardDraftCost(f.game, ids[0], f.detail, selections, { borrowed: true, short }); assert.match(text, short ? /已拆·借用0步/ : /借用不计步/);
    assert.doesNotMatch(text, /确认后耗1行动|1行动＋/);
    if (code === 'T01') assert.match(text, /搜到后付1两/);
    if (code === 'T05') assert.match(text, short ? /付1两。/ : /付1两，抽1张/);
    if (code === 'T09') assert.match(text, short ? /付2两.*新占临时格2两/ : /付2两.*新占临时格另付2两/);
    if (code === 'T10') assert.match(text, short ? /弃所选牌.*新占临时格2两/ : /弃所选牌.*新占临时格另付2两/);
  }
  assert.deepEqual(f.state, before, 'preview never mutates state');
  const state = accept(f.state, 'choose-effect', { selection: { borrow: true, params } });
  const fee = { T01: 1, T05: 1, T09: 4, T10: 2 }[code];
  assert.equal(state.players[0].silver, before.players[0].silver - fee); assert.equal(state.actionsUsed, before.actionsUsed);
  assert.equal(state.pending, null);
  if (code === 'T10') assert.ok(state.discard.includes(f.paymentId));
});

test('T01 borrow can pay its selected own hand instead of silver, without advertising a silver charge', () => {
  const f = borrowedFixture('T01'); chooseOption(f.game, f.detail, 0, option => option.cardId === f.paymentId);
  const selections = cardDraftSelections(f.game, ids[0], f.detail);
  assert.match(cardDraftCost(f.game, ids[0], f.detail, selections, { borrowed: true }), /搜到后弃所选手牌/);
  const state = accept(f.state, 'choose-effect', { selection: { borrow: true, params: selections[0].selection } });
  assert.equal(state.players[0].silver, f.state.players[0].silver); assert.ok(state.discard.includes(f.paymentId));
});

test('T01 search cost is conditional: revealing only non-goods never charges the preselected silver', () => {
  const f = borrowedFixture('T01');
  const hiddenGoods = f.state.deck.filter(id => definition(id).category === 'goods');
  f.state.deck = f.state.deck.filter(id => definition(id).category !== 'goods'); f.state.players[1].hand.push(...hiddenGoods);
  f.game = privateView(f.state, ids[0]); f.detail.card = f.game.pending.target;
  chooseOption(f.game, f.detail, 0, option => option.kind === 'silver'); const selections = cardDraftSelections(f.game, ids[0], f.detail);
  assert.match(cardDraftCost(f.game, ids[0], f.detail, selections, { borrowed: true }), /搜到后付1两/);
  const state = accept(f.state, 'choose-effect', { selection: { borrow: true, params: selections[0].selection } });
  assert.equal(state.players[0].silver, f.state.players[0].silver); assert.equal(state.actionsUsed, f.state.actionsUsed); assert.equal(state.pending, null);
});

test('a borrowed equal exchange retains paid temporary occupancy without advertising or charging it twice', () => {
  const f = borrowedFixture('T02', 6); assert.equal(f.state.players[0].temporaryOccupied, true);
  f.detail.choiceInputs[0] = { ownGoodId: 'firearms', otherGoodId: 'imports' };
  const selections = cardDraftSelections(f.game, ids[0], f.detail);
  assert.match(cardDraftCost(f.game, ids[0], f.detail, selections, { borrowed: true }), /临时格不重复收费/);
  const state = accept(f.state, 'choose-effect', { selection: { borrow: true, params: { ...selections[0].selection, targetId: ids[1] } } });
  assert.equal(state.players[0].silver, f.state.players[0].silver); assert.equal(state.players[0].temporaryOccupied, true);
  assert.equal(state.players[0].goods.firearms, 5); assert.equal(state.players[0].goods.imports, 1); assert.equal(state.pending, null);
});

test('material candidates use own hand/tools and current public discard; peers and spectators never reconstruct private faces', () => {
  const f = fixture('T10', 3), ownPayment = f.hand(f.state.players[0], 'G01'), otherPayment = f.hand(f.state.players[1], 'G02');
  f.state.players[0].hand = f.state.players[0].hand.filter(id => id !== f.cardId); f.state.players[0].tools.push({ cardId: f.cardId, exhausted: false });
  const own = projectedDetail(f.state, f.cardId, true), payments = cardDraftChoices(own.game, ids[0], own.detail)[0].choice.options[0].payments;
  assert.ok(payments.some(payment => payment.cardId === ownPayment)); assert.ok(payments.some(payment => payment.cardId === f.cardId));
  assert.equal(payments.some(payment => payment.cardId === otherPayment), false);
  assert.equal(knownCards(privateView(f.state, ids[1])).has(ownPayment), false); assert.equal(knownCards(spectatorView(f.state)).has(ownPayment), false);
  const c11 = fixture('C11'); const recovery = c11.take('T05'); c11.state.discard.push(recovery);
  const d11 = projectedDetail(c11.state, c11.cardId); const part = cardDraftChoices(d11.game, ids[0], d11.detail)[0];
  assert.ok(part.choice.options.every(option => option.cardId.startsWith('discard:')));
  d11.detail.choiceInputs[0] = { optionIndex: 0 }; const selections = cardDraftSelections(d11.game, ids[0], d11.detail);
  const command = actionDraft(d11.game, ids[0], d11.detail.card, 'play-character', { initialChoices: selections });
  const recovered = accept(c11.state, 'play-character', command); assert.ok(recovered.players[0].hand.includes(recovery));
});

test('invalid projected materials and an obsolete public reference reject without fees, entities or randomness changing', () => {
  const f = fixture('C11'); const recovery = f.take('T05'); f.state.discard.push(recovery);
  const d = projectedDetail(f.state, f.cardId); d.detail.choiceInputs[0] = { optionIndex: 0 };
  const selections = cardDraftSelections(d.game, ids[0], d.detail), command = actionDraft(d.game, ids[0], d.detail.card, 'play-character', { initialChoices: selections });
  command.params.initialChoices[0].selection.cardId = 'discard:999:0'; const before = structuredClone(f.state); let calls = 0;
  const result = applyGameAction(f.state, ids[0], { type: 'play-character', matchId: f.state.matchId, turnId: f.state.turnId, ...command }, { now: 1000, randomInt: () => { calls++; return 0; } });
  assert.equal(result.ok, false); assert.deepEqual(f.state, before); assert.equal(calls, 0);
  d.detail.choiceInputs[0] = { optionIndex: 999 }; assert.throws(() => cardDraftSelections(d.game, ids[0], d.detail), RangeError);
});
