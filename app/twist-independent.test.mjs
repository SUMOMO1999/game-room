import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, validateMeld, normalizeMeld, stateProblem, evaluateDraft, commitDraft } from './rules.mjs';
import { createGame, applyGameAction, privateView, spectatorView, gameProblem } from './multiplayer-rules.mjs';
import { splitRunAfterExtraction } from './rummikub-assist.mjs';

// Independently checked against the official Twist PDF, physical page 0:
// https://rummikub.com/wp-content/uploads/2021/12/8600_8601-4236-0011-140317_Rummikub-with-a-Twist-English_Manual_8-pages.pdf
// Multiple colour changes, one mirror per meld, and expanded double reflection
// are explicit friends-v3 choices; they are not claimed as printed examples.
const config = { normal: 8, mirror: 1, colorChange: 8, double: 7 };
const options = { copies: 3, jokerConfig: config, maxJokers: 24, jokerCount: 24, ruleVersion: 'friends-v3' };
const deck = createDeck(options), byId = new Map(deck.map(tile => [tile.id, tile]));
const tile = id => { assert.ok(byId.has(id), `unknown synthetic tile ${id}`); return { ...byId.get(id) }; };
const tiles = (...ids) => ids.map(tile);
const ids = meld => meld.map(({ id }) => id);
const analyze = (...names) => validateMeld(tiles(...names), options);
function state(rackIds, boardIds = [], opened = true) {
  const used = new Set([...rackIds, ...boardIds.flat()]);
  return { version: 1, ruleVersion: 'friends-v3', jokerConfig: { ...config },
    rack: tiles(...rackIds), board: boardIds.map(names => tiles(...names)),
    pool: deck.filter(({ id }) => !used.has(id)).map(tile => ({ ...tile })), opened, round: 1 };
}
function game(rackIds, boardIds = [], otherIds = ['orange-1-a']) {
  const result = createGame([{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }], { ...options, firstTurnIndex: 0 });
  const used = new Set([...rackIds, ...boardIds.flat(), ...otherIds]);
  result.players[0].rack = tiles(...rackIds); result.players[0].opened = true;
  result.players[1].rack = tiles(...otherIds); result.players[1].opened = true;
  result.board = boardIds.map(names => tiles(...names)); result.pool = deck.filter(({ id }) => !used.has(id)).map(tile => ({ ...tile }));
  assert.equal(gameProblem(result), null); return result;
}

test('numeric and colour reflection is strict for every colour and every two-number range', () => {
  for (const color of ['red', 'blue', 'black', 'orange']) for (let value = 1; value < 13; value++) {
    const source = tiles(`${color}-${value}-a`, `${color}-${value + 1}-a`, 'joker-mirror-1', `${color}-${value + 1}-b`, `${color}-${value}-b`);
    const before = structuredClone(source), result = validateMeld(source, options);
    assert.deepEqual(result, { valid: true, type: 'run', points: 2 * (value + value + 1), reason: '' });
    assert.deepEqual(normalizeMeld(source, options), source); assert.deepEqual(source, before);
    const wrongNumber = [...source.slice(0, 3), source[4], source[3]];
    assert.equal(validateMeld(wrongNumber, options).valid, false, 'same bag of numbers is not physical reflection');
    for (const otherColor of ['red', 'blue', 'black', 'orange'].filter(other => other !== color)) {
      const wrongColor = [...source.slice(0, 3), tile(`${otherColor}-${value + 1}-a`), tile(`${otherColor}-${value}-a`)];
      assert.equal(validateMeld(wrongColor, options).valid, false, 'equal values do not remove reflected colour requirements');
    }
  }
});

test('group mirror preserves the real centre, paired colour order, zero score and physical identity', () => {
  const source = tiles('red-7-a', 'blue-7-a', 'joker-mirror-1', 'blue-7-b', 'red-7-b');
  assert.deepEqual(validateMeld(source, options), { valid: true, type: 'group', points: 28, reason: '' });
  assert.equal(analyze('red-7-a', 'blue-7-a', 'joker-mirror-1', 'red-7-b', 'blue-7-b').valid, false);
  assert.equal(analyze('joker-mirror-1', 'red-7-a', 'blue-7-a', 'blue-7-b', 'red-7-b').valid, false);
  assert.deepEqual(normalizeMeld(source, options), source);
  assert.equal(analyze('red-7-a', 'joker-mirror-1', 'red-7-b').points, 14);
});

test('normal joker can reflect one side, while a colour change must really change both reflected segments', () => {
  assert.deepEqual(analyze('joker-normal-1', 'black-5-a', 'joker-mirror-1', 'black-5-b', 'black-4-a'), { valid: true, type: 'run', points: 18, reason: '' });
  assert.deepEqual(analyze('blue-4-a', 'joker-color-change-1', 'red-6-a', 'joker-mirror-1', 'red-6-b', 'joker-color-change-2', 'blue-4-b'), { valid: true, type: 'run', points: 30, reason: '' });
  assert.equal(analyze('blue-4-a', 'joker-color-change-1', 'red-6-a', 'joker-mirror-1', 'red-6-b', 'joker-normal-1', 'blue-4-b').valid, false);
  const reverse = tiles('red-6-a', 'joker-color-change-1', 'blue-4-a', 'joker-mirror-1', 'blue-4-b', 'joker-color-change-2', 'red-6-b');
  const normalized = normalizeMeld(reverse, options);
  assert.equal(validateMeld(normalized, options).valid, true);
  assert.deepEqual(normalizeMeld(normalized, options), normalized);
  assert.deepEqual(ids(normalized).sort(), ids(reverse).sort());
});

test('double occupies two virtual slots but never becomes two physical tiles or permits a two-tile meld', () => {
  assert.deepEqual(analyze('blue-2-a', 'joker-double-1', 'blue-5-a'), { valid: true, type: 'run', points: 14, reason: '' });
  assert.deepEqual(analyze('blue-3-a', 'red-3-a', 'joker-double-1'), { valid: true, type: 'group', points: 12, reason: '' });
  assert.equal(analyze('blue-2-a', 'joker-double-1').valid, false);
  assert.equal(analyze('blue-1-a', 'joker-double-1', 'blue-3-a').valid, false);
  assert.equal(analyze('blue-3-a', 'red-3-a', 'black-3-a', 'joker-double-1').valid, false);
  for (const source of [tiles('blue-1-a', 'joker-double-1', 'blue-2-a'), tiles('blue-12-a', 'joker-double-1', 'blue-13-a')]) {
    const normalized = normalizeMeld(source, options);
    assert.equal(validateMeld(normalized, options).valid, true, 'nonmirror input order remains cosmetic');
    assert.equal(normalized.length, 3); assert.deepEqual(ids(normalized).sort(), ids(source).sort());
  }
});

test('project double reflection expands paired slots without relaxing a missing slot or its numeric range', () => {
  const source = tiles('blue-2-a', 'joker-double-1', 'blue-5-a', 'joker-mirror-1', 'blue-5-b', 'blue-4-a', 'blue-3-a', 'blue-2-b');
  assert.deepEqual(validateMeld(source, options), { valid: true, type: 'run', points: 28, reason: '' });
  assert.equal(source.length, 8); assert.equal(normalizeMeld(source, options).length, 8);
  assert.equal(analyze('blue-2-a', 'joker-double-1', 'blue-5-a', 'joker-mirror-1', 'blue-5-b', 'blue-3-a', 'blue-2-b').valid, false);
  assert.equal(analyze('blue-2-a', 'joker-double-1', 'blue-5-a', 'joker-mirror-1', 'blue-5-b', 'blue-4-a', 'red-3-a', 'blue-2-b').valid, false);
});

test('colour-change endpoints permit later different-colour extension and reject same-colour continuation', () => {
  assert.deepEqual(analyze('blue-3-a', 'blue-4-a', 'joker-color-change-1'), { valid: true, type: 'run', points: 12, reason: '' });
  assert.deepEqual(analyze('blue-3-a', 'blue-4-a', 'joker-color-change-1', 'red-6-a'), { valid: true, type: 'run', points: 18, reason: '' });
  assert.equal(analyze('blue-3-a', 'blue-4-a', 'joker-color-change-1', 'blue-6-a').valid, false);
  assert.equal(analyze('blue-10-a', 'red-10-a', 'joker-color-change-1').valid, false);
  // Anchoring 12/13 forces the joker to represent 11 at the beginning;
  // lower anchors could legitimately normalize it to the higher-scoring end.
  assert.deepEqual(analyze('joker-color-change-1', 'red-12-a', 'red-13-a'), { valid: true, type: 'run', points: 36, reason: '' });
});

test('project multiple colour changes can return to the original colour, but cannot silently change colour at an ordinary tile', () => {
  assert.deepEqual(analyze('blue-1-a', 'joker-color-change-1', 'red-3-a', 'joker-color-change-2', 'blue-5-a'), { valid: true, type: 'run', points: 15, reason: '' });
  assert.deepEqual(analyze('blue-1-a', 'joker-color-change-1', 'joker-color-change-2', 'blue-4-a'), { valid: true, type: 'run', points: 10, reason: '' });
  assert.equal(analyze('blue-1-a', 'joker-color-change-1', 'red-3-a', 'blue-4-a', 'joker-color-change-2', 'black-6-a').valid, false);
});

test('a v3 draft cannot remove its saved configuration or use an external configuration to hide the omission', () => {
  const committed = state(['red-10-a', 'blue-10-a', 'black-10-a', 'red-1-a'], [], false);
  const draft = structuredClone(committed); draft.board = [draft.rack.splice(0, 3)]; delete draft.jokerConfig;
  const before = structuredClone(committed);
  assert.equal(evaluateDraft(committed, draft, options).valid, false);
  assert.equal(commitDraft(committed, draft, options).ok, false);
  assert.ok(stateProblem(draft, false, options));
  const missing = structuredClone(committed); delete missing.jokerConfig;
  assert.ok(stateProblem(missing, false, options)); assert.deepEqual(committed, before);
});

test('fixed config rejects changed counts, subtype forgery, mismatched options and version downgrade', () => {
  const original = state(['red-10-a', 'blue-10-a', 'joker-double-1', 'red-1-a'], [], false);
  const draft = structuredClone(original); draft.board = [draft.rack.splice(0, 3)];
  assert.equal(evaluateDraft(original, draft, options).valid, true);
  for (const mutate of [
    next => { next.jokerConfig.double--; },
    next => { next.board[0][2].jokerType = 'normal'; },
    next => { next.ruleVersion = 'friends-v2'; },
    next => { next.jokerConfig.secret = 'not-a-setting'; },
  ]) {
    const next = structuredClone(draft); mutate(next);
    assert.equal(evaluateDraft(original, next, options).valid, false);
  }
  assert.equal(evaluateDraft(original, draft, { ...options, jokerCount: 23 }).valid, false);
  assert.equal(evaluateDraft(original, draft, { ...options, jokerConfig: { ...config, normal: 7 }, jokerCount: 23 }).valid, false);
  const saved = commitDraft(original, draft, options); assert.equal(saved.ok, true);
  assert.equal(stateProblem(JSON.parse(JSON.stringify(saved.state)), true, options), null);
  assert.deepEqual(saved.state.jokerConfig, config);
});

test('explicit old rules reject typed special jokers instead of silently opting a single meld into v3', () => {
  const source = tiles('red-10-a', 'blue-10-a', 'joker-double-1');
  for (const ruleVersion of ['friends-v1', 'friends-v2', 'practice-v1', 'practice-v2']) assert.equal(validateMeld(source, { ruleVersion }).valid, false, ruleVersion);
  assert.equal(validateMeld(source, options).valid, true);
  assert.equal(validateMeld(source).valid, true, 'unversioned analysis may infer explicit physical types');
});

test('24 configured jokers do not cause permutation search on maximal mirror and adversarial ordinary runs', () => {
  let n = 0, c = 0, color = 'blue'; const a = [], b = [];
  for (let value = 1; value <= 13; value++) {
    if ([2, 5, 8, 11].includes(value)) { a.push(`joker-color-change-${++c}`); b.push(`joker-color-change-${c + 4}`); color = color === 'blue' ? 'red' : 'blue'; }
    else if ([3, 6, 9, 12].includes(value)) { a.push(`joker-normal-${++n}`); b.push(`joker-normal-${n + 4}`); }
    else { a.push(`${color}-${value}-a`); b.push(`${color}-${value}-b`); }
  }
  const largest = tiles(...a, 'joker-mirror-1', ...b.toReversed()), wrong = structuredClone(largest);
  wrong[0] = tile('black-1-a');
  const mixed = tiles('red-1-a', 'blue-13-a', ...Array.from({ length: 4 }, (_, i) => `joker-normal-${i + 1}`), ...Array.from({ length: 3 }, (_, i) => `joker-color-change-${i + 1}`), 'joker-double-1', 'joker-double-2');
  const allJokers = deck.filter(tile => tile.joker), before = structuredClone(largest), started = performance.now();
  for (let repeat = 0; repeat < 100; repeat++) {
    assert.deepEqual(validateMeld(largest, options), { valid: true, type: 'run', points: 182, reason: '' });
    assert.equal(validateMeld(wrong, options).valid, false);
    assert.equal(validateMeld(mixed, options).valid, true);
    assert.equal(validateMeld(allJokers, options).valid, false);
    assert.equal(validateMeld([...largest, tile('black-13-c')], options).valid, false);
  }
  assert.ok(performance.now() - started < 2500, 'bounded slots/counts must not enumerate 24! physical-joker arrangements');
  assert.deepEqual(largest, before);
});

test('public/spectator projections expose subtype/configuration only for public tiles and never the pool or another rack', () => {
  const source = game(['joker-double-1', 'blue-9-a'], [['blue-2-a', 'blue-3-a', 'joker-mirror-1', 'blue-3-b', 'blue-2-b']], ['joker-color-change-8', 'black-13-c']);
  source.secret = 'synthetic-private-server-field'; source.players[1].secret = 'synthetic-private-player-field';
  source.pool[0].secret = 'synthetic-private-pool-field'; source.players[0].rack[0].secret = 'synthetic-private-card-field';
  const before = structuredClone(source), publicView = spectatorView(source), own = privateView(source, 'alice');
  for (const view of [publicView, own]) {
    const text = JSON.stringify(view);
    for (const value of ['synthetic-private-server-field', 'synthetic-private-player-field', 'synthetic-private-pool-field', 'synthetic-private-card-field', 'joker-color-change-8', 'black-13-c']) assert.equal(text.includes(value), false, value);
    assert.equal(Object.hasOwn(view, 'pool'), false); assert.equal(Object.hasOwn(view.players[1], 'rack'), false);
    assert.deepEqual(view.jokerConfig, config); assert.equal(view.board[0][2].jokerType, 'mirror');
  }
  assert.equal(Object.hasOwn(publicView, 'rack'), false); assert.equal(Object.hasOwn(publicView, 'opened'), false); assert.equal(Object.hasOwn(publicView, 'playerId'), false);
  assert.equal(own.rack[0].jokerType, 'double');
  own.jokerConfig.double = 0; own.rack[0].jokerType = 'normal'; publicView.board[0][0].value = 13;
  assert.deepEqual(source, before);
  const forged = applyGameAction(source, 'alice', { type: 'submit', boardIds: [...source.board.map(ids), ['joker-color-change-8', 'black-13-c', 'blue-9-a']], rackIds: ['joker-double-1'] });
  assert.equal(forged.ok, false); assert.deepEqual(source, before);
  assert.equal(JSON.stringify(forged).includes('black-13-c'), false);
});

test('special-run extraction preserves every remaining physical entity and leaves short fragments for final validation', () => {
  for (const [names, removed] of [
    [['blue-1-a', 'blue-2-a', 'joker-color-change-1', 'red-4-a', 'red-5-a', 'red-6-a'], 'red-4-a'],
    [['red-1-a', 'red-2-a', 'joker-double-1', 'red-5-a', 'red-6-a', 'red-7-a'], 'red-5-a'],
  ]) {
    const source = tiles(...names), before = structuredClone(source), groups = splitRunAfterExtraction(source, [removed], options);
    assert.equal(validateMeld(source, options).type, 'run'); assert.equal(groups.length, 2);
    assert.deepEqual(ids(groups.flat()).sort(), names.filter(id => id !== removed).sort()); assert.deepEqual(source, before);
    assert.equal(groups.flat().filter(tile => tile.joker).length, 1); assert.ok(groups.some(group => !validateMeld(group, options).valid));
    const rack = removed.startsWith('red-4') ? ['black-4-a', 'orange-4-a', 'blue-12-a'] : ['black-5-a', 'orange-5-a', 'blue-12-a'];
    const committed = state(rack, [names]), draft = structuredClone(committed);
    draft.board = [...groups, tiles(removed, rack[0], rack[1])]; draft.rack = tiles(rack[2]);
    assert.equal(evaluateDraft(committed, draft, options).valid, false, 'geometric extraction must not claim an incomplete table is legal');
  }
});

test('mirror extraction is a physical draft operation, not an automatic legal symmetric rearrangement', () => {
  const names = ['blue-1-a', 'blue-2-a', 'blue-3-a', 'joker-mirror-1', 'blue-3-b', 'blue-2-b', 'blue-1-b'];
  const source = tiles(...names), before = structuredClone(source);
  const groups = splitRunAfterExtraction(source, ['blue-2-a', 'blue-2-b'], options);
  assert.deepEqual(groups.map(ids), [['blue-1-a'], ['blue-3-a', 'joker-mirror-1', 'blue-3-b'], ['blue-1-b']]);
  assert.deepEqual(ids(groups.flat()).sort(), names.filter(id => !['blue-2-a', 'blue-2-b'].includes(id)).sort());
  assert.equal(validateMeld(groups[1], options).valid, true); assert.equal(validateMeld(groups[0], options).valid, false);
  const committed = state(['red-2-a', 'black-2-a', 'red-2-b', 'black-2-b', 'red-9-a'], [names]), draft = structuredClone(committed);
  draft.board = [...groups, tiles('blue-2-a', 'red-2-a', 'black-2-a'), tiles('blue-2-b', 'red-2-b', 'black-2-b')]; draft.rack = tiles('red-9-a');
  assert.equal(evaluateDraft(committed, draft, options).valid, false); assert.deepEqual(source, before);
  const removedMirror = splitRunAfterExtraction(source, ['joker-mirror-1'], options);
  assert.equal(removedMirror.length, 2); assert.ok(removedMirror.every(group => validateMeld(group, options).valid));
  const canReuse = state(['blue-8-a', 'blue-8-b', 'red-9-a'], [names]);
  const reused = structuredClone(canReuse); reused.board = [...removedMirror, tiles('blue-8-a', 'joker-mirror-1', 'blue-8-b')]; reused.rack = tiles('red-9-a');
  assert.equal(evaluateDraft(canReuse, reused, options).valid, true, 'freeing the mirror is legal when all final physical groups are valid');
});
