import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, gameProblem } from './rules.mjs';
import { privateView, spectatorView } from './view.mjs';
import { createDeck, getCard, GOODS } from './content/definitions.mjs';

// A bounded synthetic command generator, not a practice opponent or a balance
// model. Candidate generation receives only one seat's lawful projection.
// Seeds 1/limit 5 and 61/limit 10 exposed the borrowed T04 reshuffle regression:
// the discarded target may remain in the deck while the private choice is open.
const SEEDS = Object.freeze([1, 7, 19, 37, 61, 101, 211, 397, 631, 997, 2027, 4093]);
const LIMITS = Object.freeze([1, 5, 10]);
const MAX_TURNS = 300, MAX_COMMANDS = 5000;
const ids = ['a'.repeat(32), 'b'.repeat(32)];
const cardIds = createDeck().map(card => card.id).sort();
const goodsCount = vector => Object.values(vector).reduce((sum, count) => sum + count, 0);
const covers = (stock, recipe) => Object.entries(recipe).every(([id, count]) => stock[id] >= count);
function random(seed) {
  let value = seed >>> 0 || 1;
  return bound => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) % bound;
  };
}

function useCandidates(view, choose) {
  const owner = view.players.find(player => player.id === view.viewerId), peer = view.players.find(player => player.id !== view.viewerId);
  const hand = owner.hand.map(card => ({ ...card, definition: getCard(card.definitionId) }));
  const goods = goodsCount(owner.goods), ordinary = owner.ordinaryCapacity, remaining = view.remainingActions;
  const entries = [];
  const add = (command, priority) => entries.push({ command, priority: priority + choose(25) });
  if (owner.silver >= 60) add({ type: 'end-turn' }, 1000);
  for (const card of hand) {
    const def = card.definition, cardId = card.cardId, count = goodsCount(def.goods ?? {});
    if (def.category === 'goods') {
      if (covers(owner.goods, def.goods)) add({ type: 'sell', cardId }, 110 + def.sellSilver);
      const total = goods + count, cost = Math.max(0, def.buySilver - 2 * view.bookLayers)
        + (total > ordinary && !owner.temporaryOccupied ? 2 : 0);
      if (total <= ordinary + 1 && covers(view.bankGoods, def.goods) && owner.silver >= cost) {
        const future = Object.fromEntries(GOODS.map(({ id }) => [id, owner.goods[id] + (def.goods[id] ?? 0)]));
        const canSellSoon = hand.some(other => other.cardId !== cardId && other.definition.category === 'goods'
          && covers(future, other.definition.goods));
        add({ type: 'buy', cardId }, canSellSoon ? 85 : 50);
      }
    } else if (def.category === 'stall_permit') {
      if (view.availableStalls && owner.silver >= (view.purchasedStalls ? 3 : 6))
        add({ type: 'buy-stall', cardId }, goods >= ordinary - 1 && owner.silver >= 12 ? 65 : 12);
    } else if (def.category === 'tool') {
      if (owner.tools.length < 3) add({ type: 'install-tool', cardId }, 35);
    } else if (!['C04', 'C07'].includes(def.sourceCode)) {
      const command = { type: 'play-character', cardId, params: {} };
      if (def.sourceCode === 'M01') {
        for (const { id } of GOODS) if (peer.goods[id]) add({ ...command, params: { goodsId: id } }, 60);
      } else if (def.sourceCode === 'M08') {
        for (const tool of peer.tools) add({ ...command, params: { toolCardId: tool.ref } }, 45);
      } else {
        const priority = def.sourceCode === 'C05' && goods >= 3 ? 105 : def.sourceCode === 'C13' && goods ? 90
          : def.sourceCode === 'C03' ? remaining >= 2 ? 48 : 4 : 45;
        add(command, priority);
      }
    }
  }
  for (const tool of owner.tools) {
    if (tool.exhausted || getCard(tool.definitionId).sourceCode === 'T07') continue;
    const code = getCard(tool.definitionId).sourceCode;
    if (['T01', 'T05'].includes(code) && owner.hand.length >= 7) continue;
    add({ type: 'activate-tool', cardId: tool.cardId }, code === 'T08' ? 65 : 40);
  }
  // The explicit idle reward is a legal fall-back, with a small sampled chance
  // to take it early. Limit-one games must instead find material-based income.
  if (view.actionLimit > 1 && remaining >= 2 && (choose(24) === 0 || view.turnNumber > 200)) add({ type: 'end-turn' }, 95);
  add({ type: 'end-turn' }, 0);
  return entries.sort((a, b) => b.priority - a.priority).map(entry => entry.command);
}

function candidates(view, choose) {
  const pending = view.pending;
  if (pending) {
    assert.equal(pending.actorId, view.viewerId);
    const decision = pending.decision;
    assert.ok(decision?.defaultSelection, 'the deciding seat must receive a legal projected default');
    if (pending.response) {
      const responses = decision.options.filter(option => option.type === 'respond');
      return responses.length && (pending.response.kind === 'merchant' || choose(4) === 0)
        ? [...responses, decision.defaultSelection] : [decision.defaultSelection];
    }
    if (pending.kind === 'peek') return [decision.defaultSelection];
    if (pending.kind === 'auction' && pending.stage === 'bidding') {
      const bid = decision.options.find(option => option.type === 'bid');
      return bid && bid.minimum <= 3 && choose(3) === 0
        ? [{ type: 'bid', amount: bid.minimum }, decision.defaultSelection] : [decision.defaultSelection];
    }
    return [{ type: 'choose-effect', selection: decision.defaultSelection }];
  }
  const active = useCandidates(view, choose);
  if (view.stage === 'use') return active;
  const owner = view.players.find(player => player.id === view.viewerId);
  const drawTools = !view.drawStarted && choose(4) === 0 ? owner.tools.filter(tool => !tool.exhausted && getCard(tool.definitionId).sourceCode === 'T07')
    .map(tool => ({ type: 'activate-tool', cardId: tool.cardId })) : [];
  const economical = active.some(command => ['buy', 'sell', 'play-character', 'activate-tool'].includes(command.type));
  const wantsCard = owner.hand.length < 4 || !economical || choose(view.actionLimit === 1 ? 3 : 4) === 0;
  const canDraw = view.deckCount + view.discard.length > 0;
  return [...drawTools, ...(wantsCard && canDraw ? [{ type: 'peek' }] : []), { type: 'finish-draw' }, { type: 'end-turn' }];
}

function assertMaterials(state) {
  assert.equal(gameProblem(state), null);
  const actual = [...state.deck, ...state.discard, ...state.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(state.pending?.sourceCards ?? []), ...(state.pending?.poolCards ?? [])].sort();
  assert.deepEqual(actual, cardIds);
  for (const { id } of GOODS) assert.equal(state.bankGoods[id] + state.players.reduce((sum, owner) => sum + owner.goods[id], 0)
    + (state.pending?.goods[id] ?? 0), 6);
  assert.equal(state.availableStalls + state.players.reduce((sum, owner) => sum + owner.stallCount, 0), 5);
  assert.equal(state.purchasedStalls, state.players.reduce((sum, owner) => sum + owner.stallCount, 0));
}

for (const actionLimit of LIMITS) test(`fixed-seed projected simulation: 12 games at action limit ${actionLimit}`, t => {
  const results = [];
  for (const seed of SEEDS) {
    const randomInt = random(seed), choose = random(seed ^ 0x5bf03635);
    let state = createGame(ids, { matchId: seed.toString(16).padStart(32, '0'), now: 1000, randomInt,
      actionLimit, firstPlayerId: ids[choose(2)] });
    let attempts = 0, accepted = 0, refused = 0, restores = 0, closingSeen = false;
    const acceptedTypes = new Set();
    let last = null;
    while (state.status === 'playing' && state.turnNumber <= MAX_TURNS && attempts < MAX_COMMANDS) {
      const publicTable = spectatorView(state), actorId = publicTable.pending?.actorId ?? publicTable.turnPlayerId;
      const view = privateView(state, actorId);
      const options = candidates(view, choose);
      let advanced = false;
      for (const candidate of options) {
        if (attempts >= MAX_COMMANDS) break;
        const command = { ...candidate, matchId: view.matchId, turnId: view.turnId,
          ...(view.pending ? { effectId: view.pending.id, decisionId: view.pending.decisionId } : {}) };
        last = { turn: view.turnNumber, actorId, command,
          ...(view.pending ? { pending: { code: view.pending.code, stage: view.pending.stage, target: view.pending.target } } : {}) };
        const before = JSON.stringify(state);
        const result = applyGameAction(state, actorId, command, { now: 1000 + ++attempts, randomInt });
        assert.equal(JSON.stringify(state), before, 'the engine may only mutate its candidate clone');
        assert.notEqual(result.code, 'INVALID_GAME_STATE', JSON.stringify({ seed, actionLimit, last, result }));
        if (!result.ok) { refused++; continue; }
        assert.equal(result.state.revision, state.revision + 1);
        if (!state.closing && result.state.closing) {
          assert.ok(result.state.players.find(owner => owner.id === result.state.closing.triggerPlayerId).silver >= 60);
          closingSeen = true;
        }
        state = result.state; accepted++; advanced = true; acceptedTypes.add(command.type);
        assertMaterials(state);
        if (accepted % 17 === 0) {
          const restored = JSON.parse(JSON.stringify(state)); assertMaterials(restored);
          for (const id of ids) assert.deepEqual(privateView(restored, id), privateView(state, id));
          assert.deepEqual(spectatorView(restored), spectatorView(state)); state = restored; restores++;
        }
        break;
      }
      assert.ok(advanced || attempts >= MAX_COMMANDS, JSON.stringify({ seed, actionLimit, last, reason: 'no legal projected candidate' }));
    }
    const metric = { seed, actionLimit, turns: state.turnNumber, attempts, accepted, refused, restores,
      silver: state.players.map(owner => owner.silver), reason: state.result?.reason
        ?? (attempts >= MAX_COMMANDS ? 'command-bound' : 'turn-bound'), commandKinds: acceptedTypes.size };
    results.push(metric);
    if (state.status === 'finished') {
      assert.equal(state.result.reason, 'normal-close');
      assert.ok(closingSeen || state.players.find(owner => owner.id === state.turnPlayerId).silver >= 60, JSON.stringify(metric));
    } else {
      // A finite strategy is not a proof of inevitable victory. In particular,
      // limit one has no idle reward; preserve and report the bounded live game.
      assert.equal(state.status, 'playing');
      assert.ok(state.turnNumber > MAX_TURNS || attempts === MAX_COMMANDS, JSON.stringify({ ...metric, last }));
    }
    assert.ok(restores > 0); assertMaterials(state);
  }
  t.diagnostic(JSON.stringify({ actionLimit, games: results.length,
    finished: results.filter(result => result.reason === 'normal-close').length,
    unfinished: results.filter(result => result.reason !== 'normal-close'), results }));
});
