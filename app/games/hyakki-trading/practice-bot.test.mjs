import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, currentDecision, gameProblem } from './rules.mjs';
import { privateView, spectatorView } from './view.mjs';
import { definition, refreshTemporary } from './model.mjs';
import { createDeck, GOODS } from './content/definitions.mjs';
import { legalHyakkiPracticeActions, chooseHyakkiPracticeAction } from './practice-bot.mjs';

const ids = ['a'.repeat(32), 'b'.repeat(32)], context = { now: 0, randomInt: limit => limit - 1 };
const codes = [...Array.from({ length: 13 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`)];
const allCards = createDeck().map(card => card.id).sort();
function conserved(state) {
  assert.equal(gameProblem(state), null);
  assert.deepEqual([...state.deck, ...state.discard, ...state.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])].sort(), allCards);
  for (const good of GOODS) assert.equal(state.bankGoods[good.id] + state.players.reduce((sum, owner) => sum + owner.goods[good.id], 0)
    + (state.pending?.goods[good.id] ?? 0), state.goodsPerType ?? 6);
  assert.equal(state.availableStalls + state.players.reduce((sum, owner) => sum + owner.stallCount, 0), 5);
}
function fixture(code) {
  const state = createGame(ids, { ...context, matchId: 'c'.repeat(32), actionLimit: 10 });
  state.deck.push(...state.players.flatMap(owner => owner.hand)); state.deck.sort();
  state.players.forEach(owner => { owner.hand = []; }); state.stage = 'use'; state.drawStarted = true;
  const [owner, peer] = state.players;
  const take = target => { const at = state.deck.findIndex(id => definition(id).sourceCode === target); assert.ok(at >= 0); return state.deck.splice(at, 1)[0]; };
  const hand = (seat, target) => { const id = take(target); seat.hand.push(id); return id; };
  const tool = (seat, target) => { const cardId = take(target); seat.tools.push({ cardId, exhausted: false }); return cardId; };
  const stock = (seat, entries) => { for (const [id, amount] of Object.entries(entries)) { state.bankGoods[id] -= amount; seat.goods[id] += amount; } refreshTemporary(seat); };
  const cardId = code.startsWith('T') ? tool(owner, code) : hand(owner, code);
  hand(owner, 'G01'); hand(peer, 'G02');
  stock(owner, { firearms: 1, 'salt-iron': 3 }); stock(peer, { imports: 1 });
  if (['C11', 'T07'].includes(code)) state.discard.push(take('T05'));
  if (['M03', 'M06'].includes(code)) { tool(owner, 'T01'); tool(owner, 'T02'); tool(peer, 'T05'); }
  if (code === 'M08') tool(peer, 'T04');
  if (code === 'T07') { state.stage = 'draw'; state.drawStarted = false; }
  return { state, cardId, take, hand, tool, stock };
}
function checked(state, command, ctx = context) {
  const actor = currentDecision(state)?.actorId ?? state.turnPlayerId;
  const result = applyGameAction(state, actor, command, ctx);
  assert.equal(result.ok, true, `${state.pending?.code ?? state.stage} ${JSON.stringify(command)}: ${result.code} ${result.error}`);
  conserved(result.state); return result.state;
}
function commands(state) {
  const actor = currentDecision(state)?.actorId ?? state.turnPlayerId, view = privateView(state, actor);
  const before = structuredClone(view), actions = legalHyakkiPracticeActions(view, actor, { now: 0 });
  assert.ok(actions.length);
  for (const action of actions) checked(state, action);
  assert.deepEqual(view, before);
  return { view, actions, chosen: chooseHyakkiPracticeAction(view, actor, { now: 0 }) };
}
function settle(initial, kinds = new Set()) {
  let state = initial;
  for (let step = 0; state.pending; step++) {
    assert.ok(step < 120, 'mandatory chain is bounded');
    if (state.pending.choice) kinds.add(state.pending.choice.kind);
    state = checked(state, commands(state).chosen);
  }
  return state;
}

test('ordinary bot accepts only its lawful private projection and never mutates it', () => {
  const state = fixture('C01').state, view = privateView(state, ids[0]);
  assert.equal(chooseHyakkiPracticeAction(state, ids[0]), null);
  assert.equal(chooseHyakkiPracticeAction(spectatorView(state), ids[0]), null);
  assert.equal(chooseHyakkiPracticeAction(view, ids[1]), null);
  const leaked = structuredClone(view); leaked.players[1].hand = ['hidden'];
  assert.equal(chooseHyakkiPracticeAction(leaked, ids[0]), null);
  assert.equal(chooseHyakkiPracticeAction({ ...view, clock: { ...view.clock, paused: true } }, ids[0]), null);
  const { chosen } = commands(state); assert.deepEqual(chooseHyakkiPracticeAction(view, ids[0]), chosen);
  const changedHidden = structuredClone(state);
  [changedHidden.deck[0], changedHidden.players[1].hand[0]] = [changedHidden.players[1].hand[0], changedHidden.deck[0]];
  assert.deepEqual(privateView(changedHidden, ids[0]), view);
  assert.deepEqual(chooseHyakkiPracticeAction(privateView(changedHidden, ids[0]), ids[0]), chosen);
});

for (const code of codes) test(`${code}: all projected bot candidates are legal and the real pending chain completes`, () => {
  const f = fixture(code); let state = f.state;
  if (['C04', 'C07'].includes(code)) {
    const responder = state.players[1];
    state.players[0].hand.splice(state.players[0].hand.indexOf(f.cardId), 1); responder.hand.push(f.cardId);
    if (code === 'C04') {
      const owner = state.players[0];
      for (const good of GOODS) { state.bankGoods[good.id] += owner.goods[good.id]; owner.goods[good.id] = 0; }
      f.stock(owner, definition(owner.hand[0]).goods);
    }
    const trigger = code === 'C04' ? { type: 'sell', cardId: state.players[0].hand[0] }
      : { type: 'play-character', cardId: f.hand(state.players[0], 'M04'), params: {} };
    state = checked(state, { ...trigger, matchId: state.matchId, turnId: state.turnId });
    assert.equal(commands(state).chosen.type, 'respond');
  } else {
    const selected = commands(state).actions.find(action => action.cardId === f.cardId && action.type === (code.startsWith('T') ? 'activate-tool' : 'play-character'));
    assert.ok(selected, `legal ${code} activation must be advertised`); state = checked(state, selected);
  }
  settle(state);
});

for (const code of codes.filter(code => code.startsWith('T'))) test(`M08: projected ${code} borrowing choice is legal`, () => {
  const f = fixture('M08');
  const old = f.state.players[1].tools.pop(); f.state.deck.push(old.cardId);
  f.tool(f.state.players[1], code);
  let state = checked(f.state, commands(f.state).actions.find(action => action.cardId === f.cardId));
  state = checked(state, commands(state).actions.find(action => action.type === 'decline-response'));
  const view = privateView(state, ids[0]), selection = view.pending.choice.options.find(option => option.borrow === true);
  if (code === 'T07') assert.equal(selection, undefined);
  else if (selection) {
    state = checked(state, { ...commands(state).chosen, selection });
    settle(state);
  } else assert.fail(`fixture must allow ${code} borrowing`);
});

function random(seed) { return bound => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % bound; }; }
test('a bot must take its first ordinary peek even with useful cards or sixty silver', () => {
  for (const silver of [20, 60]) {
    const state = fixture('C01').state; state.stage = 'draw'; state.drawStarted = false; state.players[0].silver = silver;
    const { actions, chosen } = commands(state);
    assert.deepEqual(actions.map(action => action.type), ['peek']); assert.equal(chosen.type, 'peek');
  }
  const state = fixture('T07').state; state.actionLimit = 1;
  const { actions, chosen } = commands(state);
  assert.deepEqual(actions.map(action => action.type), ['peek']); assert.equal(chosen.type, 'peek');
});

test('legacy one-action practice advances by resolving each peek without inventing income or a win', () => {
  let state = createGame(ids, { ...context, matchId: 'c'.repeat(32), actionLimit: 1 });
  for (let turn = 1; turn <= 12; turn++) {
    assert.equal(state.turnNumber, turn); assert.equal(state.drawStarted, false);
    const first = commands(state).chosen; assert.equal(first.type, 'peek');
    state = checked(state, first); assert.equal(state.turnNumber, turn);
    const resolution = commands(state).chosen; assert.equal(resolution.type, 'keep-peek');
    state = checked(state, resolution); state = JSON.parse(JSON.stringify(state)); conserved(state);
    assert.equal(state.turnNumber, turn + 1); assert.deepEqual(state.players.map(owner => owner.silver), [20, 20]);
  }
  assert.equal(state.status, 'playing'); assert.equal(state.result, null);
});

for (const actionLimit of [5, 10]) for (const seed of [7, 37, 101, 397]) {
  test(`normal practice bots complete true game seed=${seed} actionLimit=${actionLimit}`, t => {
    const randomInt = random(seed), ctx = { now: 0, randomInt };
    let state = createGame(ids, { ...ctx, matchId: seed.toString(16).padStart(32, '0'), actionLimit });
    let commands = 0, restores = 0;
    while (state.status === 'playing' && state.turnNumber <= 300 && commands < 5000) {
      const actor = currentDecision(state)?.actorId ?? state.turnPlayerId;
      const command = chooseHyakkiPracticeAction(privateView(state, actor), actor, { now: 0 });
      assert.ok(command); state = checked(state, command, ctx); commands++;
      if (commands % 23 === 0) { state = JSON.parse(JSON.stringify(state)); conserved(state); restores++; }
    }
    assert.equal(state.status, 'finished', `stopped turn ${state.turnNumber}, commands ${commands}, silver ${state.players.map(owner => owner.silver)}`);
    assert.equal(state.result.reason, 'normal-close'); assert.ok(state.players.some(owner => owner.silver >= 60));
    t.diagnostic(JSON.stringify({ seed, actionLimit, turns: state.turnNumber, commands, restores }));
  });
}
