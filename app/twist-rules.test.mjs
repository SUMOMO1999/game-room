import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, validateMeld, normalizeMeld, evaluateDraft, stateProblem, commitDraft,
  normalizeJokerConfig, defaultJokerConfig, jokerCountOf } from './rules.mjs';
import { createGame, applyGameAction, privateView, spectatorView, gameProblem } from './multiplayer-rules.mjs';

const config = { normal: 8, mirror: 2, colorChange: 7, double: 7 };
const deck = createDeck({ copies: 3, jokerConfig: config }), byId = new Map(deck.map((tile) => [tile.id, tile]));
const tiles = (...ids) => ids.map((id) => { assert.ok(byId.has(id), `unknown tile ${id}`); return { ...byId.get(id) }; });
const options = { copies: 3, jokerConfig: config, jokerCount: 24, maxJokers: 24, ruleVersion: 'friends-v3' };
function valid(ids, points, type) {
  const input = tiles(...ids), before = structuredClone(input), result = validateMeld(input, options);
  assert.equal(result.valid, true, result.reason); assert.equal(result.points, points); if (type) assert.equal(result.type, type);
  const normalized = normalizeMeld(input, options);
  assert.deepEqual(normalized.map(({ id }) => id).sort(), input.map(({ id }) => id).sort());
  assert.deepEqual(validateMeld(normalized, options), result); assert.deepEqual(input, before);
  return normalized;
}
function bad(ids, message) {
  const result = validateMeld(tiles(...ids), options); assert.equal(result.valid, false);
  if (message) assert.match(result.reason, message);
}
function state(rackIds, boardIds = [], opened = false) {
  const used = new Set([...rackIds, ...boardIds.flat()]);
  return { version: 1, ruleVersion: 'friends-v3', jokerConfig: { ...config },
    rack: tiles(...rackIds), board: boardIds.map((ids) => tiles(...ids)),
    pool: deck.filter(({ id }) => !used.has(id)).map((tile) => ({ ...tile })), opened, round: 1 };
}
const people = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
function multiplayer(racks, boardIds = [], opened = false) {
  const game = createGame(people, { ...options, firstTurnIndex: 0 });
  const used = new Set([...racks.flat(), ...boardIds.flat()]);
  game.players.forEach((player, index) => { player.rack = tiles(...racks[index]); player.opened = opened; });
  game.board = boardIds.map((ids) => tiles(...ids)); game.pool = deck.filter(({ id }) => !used.has(id)).map((tile) => ({ ...tile }));
  assert.equal(gameProblem(game), null); return game;
}

test('four-type config is strict, bounded, detached and supports zero through 24 jokers without changing digit copies', () => {
  assert.deepEqual(defaultJokerConfig(2), { normal: 2, mirror: 0, colorChange: 0, double: 0 });
  assert.deepEqual(defaultJokerConfig(3), { normal: 3, mirror: 0, colorChange: 0, double: 0 });
  const normalized = normalizeJokerConfig(config); normalized.normal = 0; assert.equal(config.normal, 8);
  assert.equal(jokerCountOf(config), 24);
  for (const copies of [2, 3]) {
    const configured = createDeck({ copies, jokerConfig: config });
    assert.equal(configured.length, copies * 52 + 24); assert.equal(new Set(configured.map(({ id }) => id)).size, configured.length);
    assert.equal(configured.filter(({ jokerType }) => jokerType === 'color-change').length, 7);
    const zero = createDeck({ copies, jokerConfig: { normal: 0, mirror: 0, colorChange: 0, double: 0 } });
    assert.equal(zero.length, copies * 52); assert.equal(zero.some(({ joker }) => joker), false);
  }
  for (const value of [null, [], {}, { ...config, normal: 9 }, { ...config, mirror: -.1 }, { ...config, normal: 8.5 },
    { normal: 8, mirror: 8, colorChange: 8, double: 8 }, { ...config, secret: 'hidden' }]) assert.throws(() => normalizeJokerConfig(value));
  assert.throws(() => createDeck({ copies: 2, jokerConfig: config, jokerCount: 2 }), /总数/);
  assert.throws(() => createDeck({ copies: 1, jokerConfig: config }));
  assert.deepEqual(createDeck().filter(({ joker }) => joker).map(({ id }) => id), ['joker-a', 'joker-b']);
  const disabledMirror = { normal: 2, mirror: 0, colorChange: 0, double: 0 };
  assert.equal(validateMeld(tiles('blue-5-a', 'joker-mirror-1', 'blue-5-b'), { ruleVersion: 'friends-v3', jokerConfig: disabledMirror }).valid, false);
  assert.equal(validateMeld(tiles('red-10-a', 'blue-10-a', 'joker-double-1'), { ruleVersion: 'friends-v3', jokerConfig: {}, maxJokers: 1 }).valid, false);
});

test('double joker occupies exactly two consecutive values or missing colors with at least three physical tiles', () => {
  assert.deepEqual(valid(['blue-2-a', 'joker-double-1', 'blue-5-a'], 14, 'run').map(({ id }) => id), ['blue-2-a', 'joker-double-1', 'blue-5-a']);
  valid(['blue-3-a', 'red-3-a', 'joker-double-1'], 12, 'group');
  valid(['blue-10-a', 'joker-normal-1', 'joker-double-1'], 46, 'run');
  valid(['blue-2-a', 'blue-3-a', 'joker-double-1'], 14, 'run');
  bad(['blue-2-a', 'joker-double-1'], /至少/);
  bad(['blue-1-a', 'joker-double-1', 'blue-3-a']);
  valid(['blue-12-a', 'joker-double-1', 'blue-13-a'], 46, 'run');
  bad(['blue-11-a', 'joker-double-1', 'blue-13-a']);
  bad(['blue-3-a', 'red-3-a', 'black-3-a', 'joker-double-1']);
});

test('color-change joker makes a genuine run color boundary, works at an end and cannot be a group joker', () => {
  valid(['blue-3-a', 'blue-4-a', 'joker-color-change-1', 'red-6-a'], 18, 'run');
  valid(['blue-3-a', 'blue-4-a', 'joker-color-change-1'], 12, 'run');
  valid(['blue-1-a', 'joker-color-change-1', 'red-3-a', 'joker-color-change-2', 'blue-5-a'], 15, 'run');
  bad(['blue-3-a', 'blue-4-a', 'joker-color-change-1', 'blue-6-a']);
  bad(['blue-10-a', 'red-10-a', 'joker-color-change-1']);
  bad(['blue-1-a', 'joker-color-change-1', 'red-3-a', 'blue-4-a']);
});

test('mirror reflects both numeric and color sequences, scores zero itself and permits a regular joker on just one side', () => {
  valid(['blue-2-a', 'blue-3-a', 'joker-mirror-1', 'blue-3-b', 'blue-2-b'], 10, 'run');
  valid(['red-3-a', 'blue-3-a', 'joker-mirror-1', 'blue-3-b', 'red-3-b'], 12, 'group');
  valid(['joker-normal-1', 'black-5-a', 'joker-mirror-1', 'black-5-b', 'black-4-a'], 18, 'run');
  valid(['blue-4-a', 'joker-color-change-1', 'red-6-a', 'joker-mirror-1', 'red-6-b', 'joker-color-change-2', 'blue-4-b'], 30, 'run');
  valid(['blue-5-a', 'joker-mirror-1', 'blue-5-b'], 10, 'group');
  bad(['blue-2-a', 'blue-3-a', 'joker-mirror-1', 'red-3-a', 'red-2-a']);
  bad(['blue-2-a', 'blue-3-a', 'joker-mirror-1', 'blue-3-b', 'blue-1-a']);
  bad(['blue-2-a', 'blue-3-a', 'joker-mirror-1'], /两边/);
  bad(['blue-2-a', 'joker-mirror-1', 'joker-mirror-2', 'blue-2-b'], /最多.*镜像/);
});

test('mirror can reflect two virtual double-joker slots against two ordinary physical tiles without treating the joker as normal', () => {
  valid(['blue-2-a', 'joker-double-1', 'blue-5-a', 'joker-mirror-1', 'blue-5-b', 'blue-4-a', 'blue-3-a', 'blue-2-b'], 28, 'run');
  valid(['blue-3-a', 'joker-double-1', 'joker-mirror-1', 'red-3-a', 'black-3-a', 'blue-3-b'], 18, 'group');
  bad(['blue-2-a', 'joker-double-1', 'blue-5-a', 'joker-mirror-1', 'blue-5-b', 'blue-3-a', 'blue-2-b']);
});

test('ambiguous mirrored direction takes the highest legitimate represented opening score and normalizes stably', () => {
  const normalized = valid(['joker-normal-1', 'blue-2-a', 'joker-mirror-1', 'blue-2-b', 'joker-normal-2'], 10, 'run');
  assert.deepEqual(normalized.map(({ id }) => id), ['blue-2-a', 'joker-normal-1', 'joker-mirror-1', 'joker-normal-2', 'blue-2-b']);
  assert.deepEqual(normalizeMeld(normalized, options), normalized);
});

test('high joker counts remain bounded and no combination consisting entirely of jokers becomes legal', () => {
  for (const ids of [['joker-normal-1', 'joker-normal-2', 'joker-double-1'], ['joker-normal-1', 'joker-mirror-1', 'joker-normal-2']]) bad(ids, /普通牌/);
  const half = [], other = []; let n = 0, c = 0, color = 'blue';
  for (let value = 1; value <= 13; value += 1) {
    if ([2, 5, 8, 11].includes(value)) { half.push(`joker-color-change-${++c}`); other.push(`joker-color-change-${c + 4}`); color = color === 'blue' ? 'red' : 'blue'; }
    else if ([3, 6, 9, 12].includes(value)) { half.push(`joker-normal-${++n}`); other.push(`joker-normal-${n + 4}`); }
    else { half.push(`${color}-${value}-a`); other.push(`${color}-${value}-b`); }
  }
  // This isolated configuration makes all eight CC instances available while
  // respecting each per-type bound and the 24-total bound.
  const fullConfig = { normal: 8, mirror: 1, colorChange: 8, double: 0 };
  const lookup = new Map(createDeck({ copies: 2, jokerConfig: fullConfig }).map((tile) => [tile.id, tile]));
  const full = [...half, 'joker-mirror-1', ...other.toReversed()].map((id) => ({ ...lookup.get(id) }));
  const before = structuredClone(full), start = performance.now();
  for (let repeat = 0; repeat < 50; repeat += 1) assert.deepEqual(validateMeld(full, { jokerConfig: fullConfig }), { valid: true, type: 'run', points: 182, reason: '' });
  assert.ok(performance.now() - start < 1500, 'bounded 27-physical mirror must not enumerate joker permutations');
  assert.deepEqual(full, before);
  const game = createGame(people, { copies: 2, jokerConfig: fullConfig, firstTurnIndex: 0 });
  const used = new Set([...full.map(({ id }) => id), 'black-2-a', 'orange-1-a']);
  game.players[0].rack = [...full, { ...lookup.get('black-2-a') }]; game.players[1].rack = [{ ...lookup.get('orange-1-a') }];
  game.pool = [...lookup.values()].filter(({ id }) => !used.has(id)).map((tile) => ({ ...tile }));
  assert.equal(gameProblem(game), null);
  const submitted = applyGameAction(game, 'alice', { type: 'submit', boardIds: [full.map(({ id }) => id)], rackIds: ['black-2-a'] });
  assert.equal(submitted.ok, true, submitted.error); assert.equal(submitted.state.board[0].length, 27); assert.equal(gameProblem(submitted.state), null);
});

test('shared v3 draft validation uses mirror zero, double contributions and immutable canonical joker types for opening', () => {
  const low = state(['blue-5-a', 'joker-mirror-1', 'blue-5-b', 'black-2-a']);
  const lowDraft = structuredClone(low); lowDraft.board = [tiles('blue-5-a', 'joker-mirror-1', 'blue-5-b')]; lowDraft.rack = tiles('black-2-a');
  assert.equal(evaluateDraft(low, lowDraft, options).points, 10); assert.equal(evaluateDraft(low, lowDraft, options).valid, false);
  const original = state(['blue-10-a', 'red-10-a', 'joker-double-1', 'black-2-a']), draft = structuredClone(original);
  draft.board = [tiles('blue-10-a', 'red-10-a', 'joker-double-1')]; draft.rack = tiles('black-2-a');
  assert.deepEqual(evaluateDraft(original, draft, options), { valid: true, reason: '', points: 40, playedIds: ['blue-10-a', 'red-10-a', 'joker-double-1'] });
  const result = commitDraft(original, draft, options); assert.equal(result.ok, true, result.error); assert.equal(result.state.opened, true);
  assert.deepEqual(result.state.jokerConfig, config); assert.equal(stateProblem(result.state, true, options), null);
  const corrupt = structuredClone(draft); corrupt.board[0][2].jokerType = 'normal';
  assert.match(evaluateDraft(original, corrupt, options).reason, /身份/);
  const changed = structuredClone(draft); changed.jokerConfig.normal -= 1;
  assert.match(evaluateDraft(original, changed, options).reason, /设置/);
  const removed = structuredClone(draft); delete removed.jokerConfig;
  assert.match(evaluateDraft(original, removed, options).reason, /设置/);
  assert.equal(commitDraft(original, removed, options).ok, false);
  const removedState = structuredClone(original); delete removedState.jokerConfig;
  assert.match(stateProblem(removedState, true, options), /设置/);
  for (const ruleVersion of ['practice-v1', 'practice-v2', 'friends-v1', 'friends-v2']) {
    assert.equal(validateMeld(draft.board[0], { ruleVersion }).valid, false);
    assert.equal(validateMeld(tiles('red-10-a', 'blue-10-a', 'joker-normal-1'), { ruleVersion }).valid, false);
  }
});

test('multiplayer opt-in v3 preserves all configured physical entities, layouts, subtype views and old v2 defaults', () => {
  const legacy = createGame(people, { firstTurnIndex: 0 }); assert.equal(legacy.ruleVersion, 'friends-v2'); assert.equal(Object.hasOwn(legacy, 'jokerConfig'), false);
  const game = multiplayer([['blue-10-a', 'red-10-a', 'joker-double-1', 'black-2-a'], ['orange-1-a']]);
  assert.equal(game.ruleVersion, 'friends-v3'); assert.equal(game.tileCount, 180); assert.equal(game.jokerCount, 24);
  const before = structuredClone(game), action = { type: 'submit', boardIds: [['blue-10-a', 'red-10-a', 'joker-double-1']], rackIds: ['black-2-a'], boardPositions: [{ x: .2, y: .8 }] };
  const result = applyGameAction(game, 'alice', action); assert.equal(result.ok, true, result.error); assert.equal(gameProblem(result.state), null); assert.deepEqual(game, before);
  for (const view of [privateView(result.state, 'alice'), privateView(result.state, 'bob'), spectatorView(result.state)]) {
    assert.deepEqual(view.jokerConfig, config); assert.equal(view.board[0][2].jokerType, 'double'); assert.deepEqual(view.boardPositions, [{ x: .2, y: .8 }]);
    view.jokerConfig.double = 0;
  }
  assert.equal(result.state.jokerConfig.double, 7);
  const forged = structuredClone(result.state); forged.board[0][2].jokerType = 'normal'; assert.match(gameProblem(forged), /类型/);
  const downgrade = structuredClone(game); downgrade.ruleVersion = 'friends-v2'; assert.match(gameProblem(downgrade), /设置/);
  const mismatch = structuredClone(game); mismatch.jokerCount -= 1; assert.match(gameProblem(mismatch), /设置/);
});

test('v3 mirror table submission and drawing leave the fixed configuration and table unchanged', () => {
  const base = multiplayer([['blue-2-a', 'blue-3-a', 'joker-mirror-1', 'blue-3-b', 'blue-2-b', 'black-2-a'], ['orange-1-a']], [], true);
  const result = applyGameAction(base, 'alice', { type: 'submit', boardIds: [['blue-2-a', 'blue-3-a', 'joker-mirror-1', 'blue-3-b', 'blue-2-b']], rackIds: ['black-2-a'] });
  assert.equal(result.ok, true, result.error);
  const draw = applyGameAction(result.state, 'bob', { type: 'draw', jokerConfig: { normal: 0, mirror: 0, colorChange: 0, double: 0 } });
  assert.equal(draw.ok, true, draw.error); assert.deepEqual(draw.state.jokerConfig, config); assert.deepEqual(draw.state.board, result.state.board);
});
