import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, currentDecision, gameProblem } from './rules.mjs';
import { privateView } from './view.mjs';
import { definition } from './model.mjs';
import { chooseHyakkiPracticeAction, legalHyakkiPracticeActions } from './practice-bot.mjs';

const ids = Array.from({ length: 6 }, (_, index) => (index + 1).toString(16).padStart(32, '0'));
const ctx = { now: 0, randomInt: limit => limit - 1 };
function fixture(code) {
  const game = createGame(ids, { ...ctx, matchId: 'e'.repeat(32), actionLimit: 10 });
  game.deck.push(...game.players.flatMap(player => player.hand)); game.players.forEach(player => { player.hand = []; });
  game.deck.sort(); game.stage = 'use'; game.drawStarted = true;
  const take = code => { const index = game.deck.findIndex(card => definition(card).sourceCode === code); assert.ok(index >= 0); return game.deck.splice(index, 1)[0]; };
  const [owner, ...peers] = game.players, cardId = take(code);
  if (code.startsWith('T')) owner.tools.push({ cardId, exhausted: false }); else owner.hand.push(cardId);
  owner.goods.firearms = 1; game.bankGoods.firearms--;
  for (const peer of peers) {
    peer.goods.imports = 1; game.bankGoods.imports--;
    peer.hand.push(game.deck.splice(game.deck.findIndex(card => definition(card).category === 'goods'), 1)[0]);
  }
  peers.at(-1).tools.push({ cardId: take('T05'), exhausted: false });
  if (code === 'M03') { owner.tools.push({ cardId: take('T03'), exhausted: false }); owner.tools.push({ cardId: take('T06'), exhausted: false }); }
  assert.equal(gameProblem(game), null); return { game, cardId };
}
for (const code of ['C01', 'C08', 'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'T02', 'T04']) test(`six-seat ${code} bot candidates have explicit legal targets and settle with private projections`, () => {
  const { game, cardId } = fixture(code), own = privateView(game, ids[0]);
  const candidates = legalHyakkiPracticeActions(own, ids[0], { now: 0 }).filter(action => action.cardId === cardId);
  assert.ok(candidates.length); assert.ok(candidates.every(action => ids.slice(1).includes(action.params.targetId)));
  for (const action of candidates) {
    const result = applyGameAction(game, ids[0], action, ctx); assert.equal(result.ok, true, result.error);
    assert.equal(result.state.pending?.data.targetId, action.params.targetId);
  }
  if (code === 'M08') assert.match(candidates[0].params.toolCardId, /^tool-5:/);
  const altered = structuredClone(game);
  [altered.deck[0], altered.players[1].hand[0]] = [altered.players[1].hand[0], altered.deck[0]];
  assert.deepEqual(privateView(altered, ids[0]), own);
  assert.deepEqual(chooseHyakkiPracticeAction(privateView(altered, ids[0]), ids[0]), chooseHyakkiPracticeAction(own, ids[0]));
  let state = applyGameAction(game, ids[0], candidates[0], ctx).state;
  for (let step = 0; state.pending; step++) {
    assert.ok(step < 100, 'mandatory projected default chain is bounded');
    const actor = currentDecision(state).actorId, command = chooseHyakkiPracticeAction(privateView(state, actor), actor, { now: 0 });
    assert.ok(command); const result = applyGameAction(state, actor, command, ctx);
    assert.equal(result.ok, true, result.error); state = result.state;
  }
  assert.equal(gameProblem(state), null);
});
