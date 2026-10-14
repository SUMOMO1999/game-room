import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, applyTimeout, currentDecision, gameProblem } from './rules.mjs';
import { DIGITAL_RULE_VERSION, createDeck } from './content/definitions.mjs';
import { definition } from './model.mjs';
import { createHyakkiPracticeSession, decodeHyakkiPractice, encodeHyakkiPractice,
  PRACTICE_SELF, PRACTICE_BOTS, PRACTICE_STORAGE_KEY } from './practice-engine.mjs';
import { createHyakkiAdapter } from '../../../server/games/hyakki-trading/adapter.mjs';

const ids = [PRACTICE_SELF, ...PRACTICE_BOTS.slice(0, 3)];
const ctx = { now: 0, randomInt: limit => limit - 1 };
const adapter = createHyakkiAdapter();
function accept(state, type, fields = {}) {
  const decision = currentDecision(state), result = applyGameAction(state, decision?.actorId ?? state.turnPlayerId,
    { type, matchId: state.matchId, turnId: state.turnId, expectedRevision: state.revision,
      ...(state.pending ? { effectId: state.pending.id, decisionId: decision.id } : {}), ...fields }, ctx);
  assert.equal(result.ok, true, result.error); assert.equal(gameProblem(result.state), null); return result.state;
}
function borrowing(code, { legacy = false } = {}) {
  let state = createGame(legacy ? ids.slice(0, 2) : ids, { ...ctx, matchId: 'c'.repeat(32), firstPlayerId: ids[0],
    ...(legacy ? { ruleVersion: DIGITAL_RULE_VERSION } : {}) });
  state.deck.push(...state.players.flatMap(owner => owner.hand));
  state.players.forEach(owner => { owner.hand = []; }); state.stage = 'use'; state.drawStarted = true;
  const sourceIndex = legacy ? 1 : 3, take = code => {
    const index = state.deck.findIndex(id => definition(id).sourceCode === code);
    assert(index >= 0); return state.deck.splice(index, 1)[0];
  };
  const cardId = take('M08'), toolId = take(code); state.players[0].hand.push(cardId);
  state.players[sourceIndex].tools.push({ cardId: toolId, exhausted: true });
  for (const [index, good] of [[0, 'imports'], [sourceIndex, 'firearms'], ...(!legacy ? [[1, 'curios']] : [])]) {
    state.players[index].goods[good]++; state.bankGoods[good]--;
  }
  state = accept(state, 'play-character', { cardId, params: { toolCardId: toolId,
    ...(!legacy ? { targetId: ids[sourceIndex] } : {}) } });
  assert.equal(state.pending.response, null, 'no held counter opens no response step');
  return { state, cardId, toolId, sourceIndex, thirdId: ids[1] };
}
function targetChoice(code) {
  const f = borrowing(code); f.state = accept(f.state, 'choose-effect', { selection: { borrow: true } });
  assert.equal(f.state.pending.choice.kind, 'borrowed-target');
  assert.deepEqual(f.state.pending.choice.defaultSelection, { targetId: f.thirdId }); return f;
}
const saved = game => ({ version: game.version, kind: 'hyakki-local-practice', matchId: game.matchId,
  logicalNow: 0, rngState: 42, game });
function environment(raw) {
  const values = new Map([[PRACTICE_STORAGE_KEY, raw]]), writes = [];
  return { values, writes, storage: { getItem: key => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); writes.push(value); } }, withLock: callback => callback(), now: () => 0 };
}
function conserved(state) {
  assert.equal(gameProblem(state), null);
  assert.deepEqual([...state.deck, ...state.discard,
    ...state.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])].sort(), createDeck().map(card => card.id).sort());
}
async function rejectsRestoration(game) {
  const raw = JSON.stringify(saved(game)), env = environment(raw);
  assert.match(gameProblem(game), /选择候选或默认项/u);
  assert.notEqual(adapter.stateProblem(game), null);
  assert.equal(decodeHyakkiPractice(raw), null);
  assert.throws(() => encodeHyakkiPractice(saved(game)), error => error.code === 'PRACTICE_SAVE_INVALID');
  const session = await createHyakkiPracticeSession(env);
  assert.equal(session.snapshot().requiresRestart, true); assert.equal(session.snapshot().game, null);
  await assert.rejects(session.action('choose-effect', { selection: game.pending.choice.defaultSelection }),
    error => error.code === 'PRACTICE_SAVE_INVALID');
  await session.destroy(); assert.deepEqual(env.writes, []); assert.equal(env.values.get(PRACTICE_STORAGE_KEY), raw);
}

test('recovery rejects a T02 target without goods, preserving the original invalid save', async () => {
  const { state } = targetChoice('T02');
  state.pending.choice.options = [{ targetId: ids[2] }]; state.pending.choice.defaultSelection = { targetId: ids[2] };
  await rejectsRestoration(state);
});
test('recovery rejects any unavailable T02 candidate even when its default target is executable', async () => {
  const { state } = targetChoice('T02'); state.pending.choice.options.push({ targetId: ids[2] });
  await rejectsRestoration(state);
});
test('recovery rejects a T02 default that is not among otherwise executable candidates', async () => {
  const { state } = targetChoice('T02'); state.pending.choice.defaultSelection = { targetId: ids[2] };
  await rejectsRestoration(state);
});
test('recovery rejects T04 target choices if its two drawable cards no longer exist', async () => {
  const { state } = targetChoice('T04'); state.players[2].hand.push(...state.deck.splice(0), ...state.discard.splice(0));
  await rejectsRestoration(state);
});
test('recovery rejects a forged paired-target stage for the non-paired T05 tool', async () => {
  const { state } = borrowing('T05'); state.pending.stage = 'borrowed-target';
  Object.assign(state.pending.choice, { kind: 'borrowed-target', visibility: 'public',
    options: [{ targetId: ids[1] }], defaultSelection: { targetId: ids[1] } });
  await rejectsRestoration(state);
});
test('legacy v1 recovery rejects a forged borrowed-target choice instead of interpreting it as v2', async () => {
  const { state } = borrowing('T04', { legacy: true }); state.pending.stage = 'borrowed-target';
  Object.assign(state.pending.choice, { kind: 'borrowed-target', visibility: 'public',
    options: [{ targetId: ids[1] }], defaultSelection: { targetId: ids[1] } });
  await rejectsRestoration(state);
});

for (const code of ['T02', 'T04']) test(`${code}: restored practice accepts a third-person target and completes the real tool choice`, async () => {
  const f = targetChoice(code), before = structuredClone(f.state.players), env = environment(encodeHyakkiPractice(saved(f.state)));
  const session = await createHyakkiPracticeSession(env); assert.equal(session.snapshot().requiresRestart, false);
  await session.action('choose-effect', { selection: { targetId: f.thirdId } });
  let game = decodeHyakkiPractice(env.values.get(PRACTICE_STORAGE_KEY)).game;
  assert.equal(game.pending.data.targetId, ids[f.sourceIndex]); assert.equal(game.pending.data.borrowedTargetId, f.thirdId);
  const pool = [...game.pending.poolCards];
  const selection = code === 'T02' ? { ownGoodId: 'imports', otherGoodId: 'curios' } : { cardId: pool[0] };
  await session.action('choose-effect', { selection }); game = decodeHyakkiPractice(env.values.get(PRACTICE_STORAGE_KEY)).game;
  conserved(game); assert.equal(game.pending, null); assert.equal(game.actionsUsed, 1);
  assert.deepEqual(game.players[f.sourceIndex].goods, before[f.sourceIndex].goods);
  assert.deepEqual(game.players[f.sourceIndex].hand, before[f.sourceIndex].hand);
  if (code === 'T02') {
    assert.equal(game.players[0].goods.curios, 1); assert.equal(game.players[1].goods.imports, 1);
  } else {
    assert(game.players[0].hand.includes(pool[0])); assert(game.players[1].hand.includes(pool[1]));
    assert.equal(game.players[1].hand.length, before[1].hand.length + 1);
  }
  assert.equal(game.discard.filter(id => id === f.cardId).length, 1); await session.destroy();
});
for (const code of ['T02', 'T04']) test(`${code}: a restored executable third-person default finishes in one active timeout`, () => {
  const f = targetChoice(code), restored = decodeHyakkiPractice(encodeHyakkiPractice(saved(f.state))).game;
  const result = applyTimeout(restored, ids[0], { ...ctx, now: restored.timing.active.deadlineAt });
  assert.equal(result.ok, true, result.error); const state = result.state; conserved(state);
  assert.equal(state.pending, null); assert.equal(state.turnNumber, 2); assert.equal(state.turnPlayerId, ids[1]);
  assert.equal(state.discard.filter(id => id === f.cardId).length, 1);
  assert.deepEqual(state.players[f.sourceIndex].goods, f.state.players[f.sourceIndex].goods);
  assert.deepEqual(state.players[f.sourceIndex].hand, f.state.players[f.sourceIndex].hand);
  if (code === 'T02') {
    assert.equal(state.players[0].goods.curios, 1); assert.equal(state.players[1].goods.imports, 1);
  } else {
    assert.equal(state.players[0].hand.length, 1); assert.equal(state.players[1].hand.length, 1);
    assert.notEqual(state.players[0].hand[0], state.players[1].hand[0]);
  }
});
