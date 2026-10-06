import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLORS, createDeck, validateMeld, normalizeMeld, createPracticeState, createJokerPracticeState,
  ruleVersionOf, canRearrangeJokers, evaluateDraft, commitDraft, drawTile, sortRack,
} from './rules.mjs';

const tile = (color, value, copy = 'a') => ({ id: `${color}-${value}-${copy}`, color, value });
const joker = (copy = 'a') => ({ id: `joker-${copy}`, color: 'red', value: 1, joker: true });
const allTiles = (state) => [...state.rack, ...state.pool, ...state.board.flat()];
const ids = (state) => allTiles(state).map((item) => item.id).sort();
const tenIds = ['red-10-a', 'blue-10-a', 'black-10-a'];
const fourIds = ['blue-4-a', 'black-4-a', 'orange-4-a'];

function play(state, meldIds) {
  const draft = structuredClone(state);
  for (const group of meldIds) {
    const meld = group.map((id) => {
      const index = draft.rack.findIndex((item) => item.id === id);
      assert.notEqual(index, -1, `fixture rack is missing ${id}`);
      return draft.rack.splice(index, 1)[0];
    });
    draft.board.push(meld);
  }
  return draft;
}

function exchangeWithPool(state, rackId, poolId) {
  const rackIndex = state.rack.findIndex((item) => item.id === rackId);
  const poolIndex = state.pool.findIndex((item) => item.id === poolId);
  assert.notEqual(rackIndex, -1);
  assert.notEqual(poolIndex, -1);
  [state.rack[rackIndex], state.pool[poolIndex]] = [state.pool[poolIndex], state.rack[rackIndex]];
}

function practiceFixture({ board, rack, copies = 2, jokerCount = copies, ruleVersion = 'practice-v2', opened = true }) {
  const deck = createDeck({ copies, jokerCount });
  const known = new Map(deck.map(item => [item.id, item]));
  const used = new Set([...board.flat(), ...rack]);
  assert.equal(used.size, board.flat().length + rack.length);
  const take = id => { assert.ok(known.has(id), `unknown fixture tile ${id}`); return structuredClone(known.get(id)); };
  return { version: 1, ruleVersion, board: board.map(meld => meld.map(take)), rack: rack.map(take),
    pool: deck.filter(item => !used.has(item.id)), opened, round: 1 };
}

function rearrange(state, boardIds) {
  const draft = structuredClone(state);
  const known = new Map([...draft.rack, ...draft.board.flat()].map(item => [item.id, item]));
  const played = new Set(boardIds.flat());
  draft.board = boardIds.map(meld => meld.map(id => { assert.ok(known.has(id)); return known.get(id); }));
  draft.rack = draft.rack.filter(item => !played.has(item.id));
  return draft;
}

test('fixture conserves the complete two-copy 106-tile deck and has three legal table melds', () => {
  const state = createPracticeState();
  assert.equal(state.rack.length, 14);
  assert.equal(state.pool.length, 83);
  assert.equal(state.board.length, 3);
  assert.equal(new Set(ids(state)).size, 106);
  assert.equal(allTiles(state).filter((item) => item.joker).length, 2);
  for (const color of COLORS) {
    for (let value = 1; value <= 13; value += 1) {
      assert.equal(allTiles(state).filter((item) => !item.joker && item.color === color && item.value === value).length, 2);
    }
  }
  assert.ok(state.board.every((meld) => validateMeld(meld).valid));
  const another = createPracticeState();
  state.rack[0].value = 2;
  assert.equal(another.rack[0].value, 10, 'fixtures must not share mutable tile objects');
});

test('same-number groups require three or four distinct colors, including physical duplicate copies', () => {
  assert.deepEqual(validateMeld([tile('red', 10), tile('blue', 10), tile('black', 10)]),
    { valid: true, type: 'group', points: 30, reason: '' });
  assert.equal(validateMeld(COLORS.map((color) => tile(color, 10))).points, 40);
  assert.equal(validateMeld([tile('red', 10), tile('red', 10, 'b'), tile('blue', 10)]).valid, false);
  assert.equal(validateMeld([tile('red', 10), tile('blue', 10)]).valid, false);
  assert.equal(validateMeld([...COLORS.map((color) => tile(color, 10)), joker()]).valid, false);
});

test('runs allow arbitrary visual order but do not repeat numbers, mix colors, or wrap 13 to 1', () => {
  assert.deepEqual(validateMeld([tile('red', 3), tile('red', 1), tile('red', 2)]),
    { valid: true, type: 'run', points: 6, reason: '' });
  assert.equal(validateMeld([tile('red', 12), tile('red', 13), tile('red', 1)]).valid, false);
  assert.equal(validateMeld([tile('red', 1), tile('red', 3), tile('red', 5)]).valid, false);
  assert.equal(validateMeld([tile('red', 1), tile('blue', 2), tile('red', 3)]).valid, false);
  assert.equal(validateMeld([tile('red', 2), tile('red', 2, 'b'), tile('red', 3)]).valid, false);
  assert.equal(validateMeld(Array.from({ length: 13 }, (_, index) => tile('orange', index + 1))).points, 91);
});

test('jokers substitute missing colors or numbers without crossing numeric boundaries', () => {
  assert.equal(validateMeld([tile('red', 10), tile('blue', 10), joker()]).points, 30);
  assert.deepEqual(validateMeld([tile('red', 10), joker(), tile('red', 11)]),
    { valid: true, type: 'run', points: 33, reason: '' });
  assert.equal(validateMeld([tile('red', 12), tile('red', 13), joker()]).points, 36);
  assert.equal(validateMeld([joker(), tile('blue', 1), tile('blue', 2)]).points, 6);
  assert.equal(validateMeld([tile('red', 1), tile('red', 4), joker()]).valid, false);
  assert.equal(validateMeld([tile('red', 10), tile('red', 10, 'b'), joker()]).valid, false);
  assert.equal(validateMeld([tile('red', 13), joker(), joker('b')]).type, 'group');
  assert.equal(validateMeld([tile('red', 1), joker(), joker('b')]).type, 'run');
  assert.equal(validateMeld([joker(), joker('b'), { ...joker(), id: 'joker-c' }]).valid, false);
});

test('malformed tiles and duplicate IDs cannot form legal melds', () => {
  assert.equal(validateMeld(null).valid, false);
  assert.equal(validateMeld([tile('red', 1), tile('red', 2), tile('red', 14)]).valid, false);
  assert.equal(validateMeld([tile('red', 1), tile('red', 2), { ...tile('red', 3), color: 'green' }]).valid, false);
  assert.equal(validateMeld([tile('red', 1), tile('red', 2), { ...tile('red', 3), id: 'red-2-a' }]).valid, false);
});

test('opening needs at least 30 points from the hand, including joker substitutions', () => {
  const state = createPracticeState();
  const below = evaluateDraft(state, play(state, [fourIds]));
  assert.equal(below.valid, false);
  assert.equal(below.points, 12);
  assert.match(below.reason, /30/);
  const exact = evaluateDraft(state, play(state, [tenIds]));
  assert.equal(exact.valid, true);
  assert.equal(exact.points, 30);
  assert.deepEqual(exact.playedIds, tenIds);
  const withJoker = evaluateDraft(state, play(state, [['red-10-a', 'blue-10-a', 'joker-a']]));
  assert.equal(withJoker.valid, true);
  assert.equal(withJoker.points, 30);
});

test('even an opening of 30 points cannot also modify a pre-existing table meld', () => {
  const state = createPracticeState();
  exchangeWithPool(state, 'orange-2-a', 'red-4-a');
  const draft = play(state, [tenIds]);
  const index = draft.rack.findIndex((item) => item.id === 'red-4-a');
  draft.board[0].push(draft.rack.splice(index, 1)[0]);
  assert.ok(validateMeld(draft.board[0]).valid, 'the modified meld itself is legal');
  assert.equal(evaluateDraft(state, draft).valid, false);
  assert.match(evaluateDraft(state, draft).reason, /首次开局/);
});

test('commits are immutable, preserve IDs, mark opening, and advance the practice round', () => {
  const state = createPracticeState();
  const draft = play(state, [tenIds]);
  const original = structuredClone(state);
  const originalDraft = structuredClone(draft);
  const result = commitDraft(state, draft);
  assert.equal(result.ok, true);
  assert.equal(result.state.opened, true);
  assert.equal(result.state.round, 2);
  assert.equal(result.state.rack.length, 11);
  assert.deepEqual(ids(result.state), ids(state));
  assert.deepEqual(state, original);
  assert.deepEqual(draft, originalDraft);
  result.state.board[0][0].value = 13;
  assert.equal(state.board[0][0].value, 1);
  const failure = commitDraft(state, play(state, [fourIds]));
  assert.equal(failure.ok, false);
  assert.equal('state' in failure, false);
  assert.deepEqual(state, original);
});

test('after opening one hand tile may extend an ordinary meld; rearranging alone cannot submit', () => {
  const state = createPracticeState();
  state.opened = true;
  exchangeWithPool(state, 'orange-2-a', 'red-4-a');
  const draft = structuredClone(state);
  const index = draft.rack.findIndex((item) => item.id === 'red-4-a');
  draft.board[0].push(draft.rack.splice(index, 1)[0]);
  assert.deepEqual(evaluateDraft(state, draft), { valid: true, reason: '', points: 4, playedIds: ['red-4-a'] });
  const onlyRearranged = structuredClone(state);
  onlyRearranged.board.reverse();
  assert.match(evaluateDraft(state, onlyRearranged).reason, /至少/);
});

test('ordinary table melds can be split and rebuilt when every resulting meld is legal', () => {
  const state = createPracticeState();
  state.opened = true;
  for (const [oldId, newId] of [['orange-2-a', 'blue-6-a'], ['orange-6-a', 'blue-10-b'], ['black-13-a', 'blue-11-b']]) {
    exchangeWithPool(state, oldId, newId);
  }
  const draft = structuredClone(state);
  const originalRun = draft.board.splice(1, 1)[0];
  const fromHand = ['blue-6-a', 'blue-10-b', 'blue-11-b'].map((id) => {
    const index = draft.rack.findIndex((item) => item.id === id);
    return draft.rack.splice(index, 1)[0];
  });
  draft.board.push([fromHand[0], originalRun[0], originalRun[1]]);
  draft.board.push([originalRun[2], fromHand[1], fromHand[2]]);
  const result = evaluateDraft(state, draft);
  assert.equal(result.valid, true);
  assert.equal(result.points, 27);
});

test('table tiles cannot be taken into the rack, even if the total count is unchanged', () => {
  const state = createPracticeState();
  state.opened = true;
  const draft = structuredClone(state);
  [draft.rack[0], draft.board[0][0]] = [draft.board[0][0], draft.rack[0]];
  assert.deepEqual(ids(draft), ids(state));
  assert.match(evaluateDraft(state, draft).reason, /不能取回手牌/);
});

test('committed joker melds are locked against otherwise legal retrieval and extension', () => {
  const base = createPracticeState();
  base.ruleVersion = 'practice-v1';
  const locked = play(base, [fourIds.concat('joker-a')]);
  locked.opened = true;
  const retrieval = play(locked, [['red-6-a', 'red-7-a', 'red-8-a']]);
  const jokerGroup = retrieval.board.find((meld) => meld.some((item) => item.id === 'joker-a'));
  const jokerIndex = jokerGroup.findIndex((item) => item.id === 'joker-a');
  retrieval.board.at(-1).push(jokerGroup.splice(jokerIndex, 1)[0]);
  assert.ok(retrieval.board.every((meld) => validateMeld(meld).valid));
  assert.match(evaluateDraft(locked, retrieval).reason, /锁定/);

  const runBase = createPracticeState();
  runBase.ruleVersion = 'practice-v1';
  const lockedRun = play(runBase, [['red-6-a', 'red-7-a', 'joker-a']]);
  lockedRun.opened = true;
  const extension = structuredClone(lockedRun);
  const index = extension.rack.findIndex((item) => item.id === 'red-8-a');
  extension.board.at(-1).push(extension.rack.splice(index, 1)[0]);
  assert.ok(validateMeld(extension.board.at(-1)).valid);
  assert.match(evaluateDraft(lockedRun, extension).reason, /锁定/);

  const wholeGroupMove = play(locked, [tenIds]);
  wholeGroupMove.board.reverse();
  wholeGroupMove.board.forEach((meld) => meld.reverse());
  assert.equal(evaluateDraft(locked, wholeGroupMove).valid, true);
});

test('ID, tile-identity, pool, and round tampering are rejected', () => {
  const state = createPracticeState();
  const valid = play(state, [tenIds]);
  const lost = structuredClone(valid);
  lost.rack.pop();
  assert.match(evaluateDraft(state, lost).reason, /106/);
  const duplicate = structuredClone(valid);
  duplicate.rack[0] = { ...duplicate.rack[1] };
  assert.match(evaluateDraft(state, duplicate).reason, /重复/);
  const identity = structuredClone(valid);
  identity.rack[0].color = 'black';
  assert.match(evaluateDraft(state, identity).reason, /不能改变/);
  const unknown = structuredClone(valid);
  unknown.rack[0].id = 'forged-tile';
  assert.match(evaluateDraft(state, unknown).reason, /不能改变/);
  const poolChanged = structuredClone(valid);
  [poolChanged.pool[0], poolChanged.pool[1]] = [poolChanged.pool[1], poolChanged.pool[0]];
  assert.match(evaluateDraft(state, poolChanged).reason, /牌池/);
  const flags = structuredClone(valid);
  flags.opened = true;
  assert.match(evaluateDraft(state, flags).reason, /开局标记/);
  flags.opened = false;
  flags.round += 1;
  assert.match(evaluateDraft(state, flags).reason, /回合数/);
  assert.equal(evaluateDraft(null, valid).valid, false);
});

test('an illegal resulting table is not accepted after opening', () => {
  const state = createPracticeState();
  state.opened = true;
  const draft = play(state, [['red-6-a', 'red-7-a']]);
  assert.match(evaluateDraft(state, draft).reason, /至少需要3/);
  assert.equal(commitDraft(state, draft).ok, false);
});

test('undo followed by draw restores the committed table and ends the practice turn', () => {
  const state = createPracticeState();
  const original = structuredClone(state);
  const pendingDraft = play(state, [tenIds]);
  // UI undo resets its draft to the committed snapshot. drawTile deliberately
  // accepts that committed snapshot, never the unfinished table edits.
  const undoneDraft = structuredClone(state);
  const result = drawTile(undoneDraft);
  assert.equal(result.ok, true);
  assert.equal(result.state.rack.length, 15);
  assert.equal(result.state.pool.length, 82);
  assert.equal(result.state.round, 2);
  assert.equal(result.state.opened, false);
  assert.deepEqual(result.state.board, original.board);
  assert.equal(result.state.rack.at(-1).id, original.pool[0].id);
  assert.deepEqual(ids(result.state), ids(original));
  assert.deepEqual(state, original);
  assert.equal(pendingDraft.rack.length, 11, 'drawing must not mutate a separate draft');
  const nextDraft = play(result.state, [tenIds, ['red-4-a', 'blue-4-a', 'black-4-a']]);
  assert.equal(commitDraft(result.state, nextDraft).state.round, 3);
});

test('empty pool and empty rack finish practice without invented multiplayer settlement', () => {
  const exhausted = createPracticeState();
  exhausted.rack.push(...exhausted.pool.splice(0));
  const before = structuredClone(exhausted);
  assert.deepEqual(drawTile(exhausted), { ok: false, error: '牌池已空，本次练习结束。' });
  assert.deepEqual(exhausted, before);
  const finished = createPracticeState();
  finished.pool.push(...finished.rack.splice(0));
  assert.match(drawTile(finished).error, /手牌已全部出完/);
});

test('sorting creates an independent rack while keeping every physical tile and putting jokers last', () => {
  const state = createPracticeState();
  const original = structuredClone(state.rack);
  const sorted = sortRack(state.rack);
  assert.deepEqual(sorted.map((item) => item.id).sort(), original.map((item) => item.id).sort());
  assert.equal(sorted.at(-1).joker, true);
  assert.deepEqual(state.rack, original);
  sorted[0].value = 13;
  assert.deepEqual(state.rack, original);
});

test('configurable decks keep the default practice deck and add a distinct third physical copy', () => {
  assert.equal(createDeck().length, 106);
  const deck = createDeck({ copies: 3, jokerCount: 3 });
  assert.equal(deck.length, 159);
  assert.equal(new Set(deck.map((item) => item.id)).size, 159);
  assert.equal(deck.filter((item) => item.joker).length, 3);
  for (const color of COLORS) {
    for (let value = 1; value <= 13; value += 1) {
      assert.deepEqual(deck.filter((item) => !item.joker && item.color === color && item.value === value).map((item) => item.id),
        ['a', 'b', 'c'].map((copy) => `${color}-${value}-${copy}`));
    }
  }
  assert.equal(createDeck({ copies: 2, jokerCount: 4 }).length, 108);
  assert.throws(() => createDeck({ copies: 1 }), /2或3/);
  assert.throws(() => createDeck({ copies: 3, jokerCount: 5 }), /鬼牌/);
});

test('three configured jokers can substitute numbers or colors but cannot form an all-joker meld', () => {
  const threeJokers = [joker(), joker('b'), joker('c')];
  assert.equal(validateMeld([tile('red', 13), ...threeJokers]).valid, false, 'practice default remains max two');
  assert.deepEqual(validateMeld([tile('red', 13), ...threeJokers], { maxJokers: 3 }),
    { valid: true, type: 'group', points: 52, reason: '' });
  assert.deepEqual(validateMeld([tile('red', 1), ...threeJokers], { maxJokers: 3 }),
    { valid: true, type: 'run', points: 10, reason: '' });
  assert.equal(validateMeld(threeJokers, { maxJokers: 3 }).valid, false);
  assert.equal(validateMeld([tile('red', 13, 'c'), tile('red', 13, 'a'), joker('c')], { maxJokers: 3 }).valid, false);
});

test('configured draft validation conserves all 159 cards without changing practice defaults', () => {
  const config = { copies: 3, jokerCount: 3 };
  const deck = createDeck(config);
  const rackIds = ['red-13-c', 'joker-a', 'joker-b', 'joker-c', 'orange-2-c'];
  const hand = new Set(rackIds);
  const state = {
    version: 1, board: [], rack: deck.filter((item) => hand.has(item.id)),
    pool: deck.filter((item) => !hand.has(item.id)), opened: false, round: 1,
  };
  const draft = play(state, [['red-13-c', 'joker-a', 'joker-b', 'joker-c']]);
  assert.equal(evaluateDraft(state, draft).valid, false, 'default practice does not silently accept a larger deck');
  const result = evaluateDraft(state, draft, config);
  assert.equal(result.valid, true);
  assert.equal(result.points, 52);
  const committed = commitDraft(state, draft, config);
  assert.equal(committed.ok, true);
  assert.deepEqual(ids(committed.state), ids(state));
  assert.equal(allTiles(committed.state).length, 159);
  const lost = structuredClone(draft);
  lost.pool.pop();
  assert.match(evaluateDraft(state, lost, config).reason, /159/);
  const drawn = drawTile(state, config);
  assert.equal(drawn.ok, true);
  assert.deepEqual(ids(drawn.state), ids(state));
});

test('normalization arranges the 6/7/9/8 regression as 6/7/8/9 without mutating physical tiles', () => {
  const meld = Object.freeze([6, 7, 9, 8].map((value) => Object.freeze(tile('red', value))));
  const normalized = normalizeMeld(meld);
  assert.deepEqual(normalized.map((item) => item.value), [6, 7, 8, 9]);
  assert.deepEqual(meld.map((item) => item.value), [6, 7, 9, 8]);
  assert.notEqual(normalized, meld);
  assert.equal(normalized[2], meld[3], 'normalizing moves the same physical tile object');
  assert.deepEqual(normalizeMeld(normalized), normalized, 'normalization is idempotent');
});

test('run normalization places jokers in their represented interior and boundary positions', () => {
  const middle = [tile('red', 9), joker(), tile('red', 6), tile('red', 8)];
  const original = structuredClone(middle);
  assert.deepEqual(normalizeMeld(middle).map((item) => item.id), ['red-6-a', 'joker-a', 'red-8-a', 'red-9-a']);
  assert.deepEqual(normalizeMeld([tile('blue', 13), tile('blue', 12), joker()]).map((item) => item.id),
    ['joker-a', 'blue-12-a', 'blue-13-a']);
  assert.deepEqual(normalizeMeld([joker(), tile('red', 11), tile('red', 10)]).map((item) => item.id),
    ['red-10-a', 'red-11-a', 'joker-a']);
  assert.deepEqual(middle, original);
  assert.equal(middle[1].value, 1, 'represented value must not replace the joker placeholder');
});

test('same-number groups and illegal drafts retain their original order', () => {
  const group = [tile('blue', 10), joker(), tile('black', 10)];
  const invalid = [tile('red', 9), tile('red', 6), tile('red', 7)];
  for (const meld of [group, invalid, [tile('red', 2)], [joker(), joker('b'), joker('c')]]) {
    const result = normalizeMeld(meld, { maxJokers: 3 });
    assert.deepEqual(result, meld);
    assert.notEqual(result, meld);
  }
  assert.deepEqual(normalizeMeld(null), []);
});

test('configured three-joker runs normalize by assigned values while all-joker drafts stay unchanged', () => {
  const meld = [joker('b'), joker('c'), tile('red', 10, 'c'), joker('a')];
  assert.deepEqual(normalizeMeld(meld), meld, 'the two-joker default does not normalize an invalid larger draft');
  const normalized = normalizeMeld(meld, { maxJokers: 3 });
  assert.deepEqual(normalized.map((item) => item.id), ['red-10-c', 'joker-b', 'joker-c', 'joker-a']);
  assert.equal(validateMeld(normalized, { maxJokers: 3 }).points, 46);
  assert.deepEqual(normalizeMeld(normalized, { maxJokers: 3 }), normalized);
  const allJokers = [joker('c'), joker('a'), joker('b')];
  assert.deepEqual(normalizeMeld(allJokers, { maxJokers: 3 }), allJokers);
});

test('practice commits normalize new and legacy valid runs only after existing rule validation', () => {
  const state = createPracticeState();
  exchangeWithPool(state, 'orange-2-a', 'red-9-a');
  state.board[1].reverse(); // A legacy snapshot may contain a valid unordered run.
  const original = structuredClone(state);
  const draft = play(state, [['red-6-a', 'red-7-a', 'red-9-a', 'red-8-a']]);
  const result = commitDraft(state, draft);
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.board.at(-1).map((item) => item.value), [6, 7, 8, 9]);
  assert.deepEqual(result.state.board[1].map((item) => item.value), [7, 8, 9]);
  assert.deepEqual(ids(result.state), ids(state));
  assert.deepEqual(state, original);
  assert.deepEqual(draft.board.at(-1).map((item) => item.value), [6, 7, 9, 8]);
  assert.deepEqual(result.state.board[2].map((item) => item.color), ['red', 'blue', 'black']);
});

test('practice commits save joker runs in the same order used to calculate initial 30 points', () => {
  const state = createPracticeState();
  exchangeWithPool(state, 'orange-2-a', 'red-9-a');
  const draft = play(state, [['red-9-a', 'joker-a', 'red-6-a', 'red-8-a']]);
  assert.equal(evaluateDraft(state, draft).points, 30);
  const result = commitDraft(state, draft);
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.board.at(-1).map((item) => item.id), ['red-6-a', 'joker-a', 'red-8-a', 'red-9-a']);
  assert.deepEqual(ids(result.state), ids(state));
});

test('new practice fixtures use v2 while old saves retain v1 through commits and draws', () => {
  const lesson = createJokerPracticeState();
  assert.equal(lesson.ruleVersion, 'practice-v2');
  assert.equal(lesson.opened, true);
  assert.equal(lesson.rack.length, 14);
  assert.equal(lesson.pool.length, 86);
  assert.equal(new Set(ids(lesson)).size, 106);
  assert.ok(lesson.board.every(meld => validateMeld(meld).valid));
  assert.deepEqual(lesson.board[0].map(item => item.id), ['red-6-a', 'joker-a', 'red-8-a']);
  assert.equal(canRearrangeJokers(lesson), true);
  assert.equal(canRearrangeJokers({ ruleVersion: 'friends-v2' }), true);
  const legacy = createPracticeState();
  delete legacy.ruleVersion;
  assert.equal(ruleVersionOf(legacy), 'practice-v1');
  assert.equal(canRearrangeJokers(legacy), false);
  const committed = commitDraft(legacy, play(legacy, [tenIds]));
  assert.equal(committed.ok, true);
  assert.equal('ruleVersion' in committed.state, false, 'saving old practice must not silently upgrade it');
  assert.equal('ruleVersion' in drawTile(legacy).state, false);
  assert.equal(commitDraft(lesson, rearrange(lesson, [
    ['red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a', 'joker-a'],
  ])).state.ruleVersion, 'practice-v2');
});

test('v2 joker replacement can reuse the joker in an existing meld with only one hand tile', () => {
  const state = createJokerPracticeState();
  const original = structuredClone(state);
  const draft = rearrange(state, [
    ['red-6-a', 'red-7-a', 'red-8-a'],
    ['blue-10-a', 'blue-11-a', 'blue-12-a', 'joker-a'],
  ]);
  assert.deepEqual(evaluateDraft(state, draft), { valid: true, reason: '', points: 7, playedIds: ['red-7-a'] });
  const result = commitDraft(state, draft);
  assert.equal(result.ok, true);
  assert.deepEqual(ids(result.state), ids(state));
  assert.deepEqual(state, original);
  assert.equal(result.state.board[1].at(-1).id, 'joker-a');
  assert.equal(result.state.board[1].at(-1).value, 1, 'represented number never overwrites physical identity');
});

test('v2 permits legal extensions and splitting of old joker melds', () => {
  const run = practiceFixture({ board: [['red-6-a', 'joker-a', 'red-8-a']], rack: ['red-9-a', 'black-2-a'] });
  assert.equal(evaluateDraft(run, rearrange(run, [['red-6-a', 'joker-a', 'red-8-a', 'red-9-a']])).valid, true);
  const group = practiceFixture({ board: [['blue-4-a', 'black-4-a', 'joker-a']], rack: ['orange-4-a', 'black-2-a'] });
  assert.equal(evaluateDraft(group, rearrange(group, [['blue-4-a', 'black-4-a', 'joker-a', 'orange-4-a']])).valid, true);
  const longRun = practiceFixture({
    board: [['red-1-a', 'joker-a', 'red-3-a', 'red-4-a', 'red-5-a', 'red-6-a']], rack: ['red-7-a', 'black-2-a'],
  });
  const split = rearrange(longRun, [['red-1-a', 'joker-a', 'red-3-a'], ['red-4-a', 'red-5-a', 'red-6-a', 'red-7-a']]);
  assert.equal(commitDraft(longRun, split).ok, true);
});

test('v2 still forbids returning a table joker to rack, loose jokers and table-only submissions', () => {
  const state = createJokerPracticeState();
  const returned = rearrange(state, [['red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a']]);
  returned.rack.push(structuredClone(state.board[0][1]));
  assert.match(evaluateDraft(state, returned).reason, /不能取回手牌/);
  const loose = rearrange(state, [
    ['red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a'], ['joker-a'],
  ]);
  const original = structuredClone(state);
  assert.match(commitDraft(state, loose).error, /至少需要3张/);
  assert.deepEqual(state, original, 'a rejected rearrangement leaves the committed table untouched');
  const unchangedHand = structuredClone(state);
  unchangedHand.board.reverse();
  assert.match(evaluateDraft(state, unchangedHand).reason, /至少需要出一张手牌/);
});

test('v2 opening remains hand-only and cannot rearrange a pre-existing joker meld', () => {
  const state = practiceFixture({ opened: false,
    board: [['red-6-a', 'joker-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a']],
    rack: ['red-7-a', 'red-10-a', 'blue-10-b', 'black-10-a', 'black-2-a'],
  });
  const draft = rearrange(state, [
    ['red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a', 'joker-a'],
    ['red-10-a', 'blue-10-b', 'black-10-a'],
  ]);
  assert.match(evaluateDraft(state, draft).reason, /首次开局/);
});

test('rule metadata cannot be forged or upgraded by a draft', () => {
  const state = createPracticeState();
  const valid = play(state, [tenIds]);
  const unknown = structuredClone(valid);
  unknown.ruleVersion = 'practice-v99';
  assert.match(evaluateDraft(state, unknown).reason, /规则版本无效/);
  const switched = structuredClone(valid);
  switched.ruleVersion = 'practice-v1';
  assert.match(evaluateDraft(state, switched).reason, /不能改变本局规则版本/);
  const old = structuredClone(state);
  delete old.ruleVersion;
  const upgrade = play(old, [tenIds]);
  upgrade.ruleVersion = 'practice-v2';
  assert.match(evaluateDraft(old, upgrade).reason, /不能改变本局规则版本/);
  const badState = structuredClone(state);
  badState.ruleVersion = null;
  assert.match(drawTile(badState).error, /规则版本无效/);
});

test('three-copy v2 rearranges multiple table jokers without losing their physical identities', () => {
  const config = { copies: 3, jokerCount: 3 };
  const state = practiceFixture({ ...config,
    board: [['red-6-c', 'joker-a', 'red-8-c'], ['blue-10-c', 'blue-11-c', 'joker-b']],
    rack: ['red-7-c', 'blue-12-c', 'black-2-c', 'joker-c'],
  });
  const draft = rearrange(state, [
    ['red-6-c', 'red-7-c', 'red-8-c'], ['blue-10-c', 'blue-11-c', 'blue-12-c', 'joker-a', 'joker-b'],
  ]);
  const result = commitDraft(state, draft, config);
  assert.equal(result.ok, true, result.error);
  assert.equal(allTiles(result.state).length, 159);
  assert.deepEqual(ids(result.state), ids(state));
  assert.deepEqual(result.state.board[1].map(item => item.id),
    ['joker-a', 'blue-10-c', 'blue-11-c', 'blue-12-c', 'joker-b']);
});
