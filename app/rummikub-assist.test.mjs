import test from 'node:test';
import assert from 'node:assert/strict';
import { sortPlayableRack, autoSplitDuplicateRun } from './rummikub-assist.mjs';
import { createDeck, validateMeld, evaluateDraft } from './rules.mjs';
const byId = new Map(createDeck({ copies: 3, jokerCount: 4 }).map((tile) => [tile.id, tile]));
const hand = (...ids) => ids.map((id) => ({ ...byId.get(id) }));
const ids = (tiles) => tiles.map(({ id }) => id);
const allIds = (result) => result.orderIds.toSorted();
function sort(input, options = {}) {
  const before = structuredClone(input), result = sortPlayableRack(input, options);
  assert.deepEqual(input, before);
  assert.deepEqual(allIds(result), ids(input).toSorted());
  assert.equal(new Set(result.orderIds).size, input.length);
  assert.deepEqual(ids(result.rack), result.orderIds);
  const suggested = result.melds.flatMap(({ tiles }) => ids(tiles));
  assert.equal(new Set(suggested).size, suggested.length);
  assert.deepEqual(result.orderIds.slice(0, suggested.length), suggested);
  for (const meld of result.melds) {
    const valid = validateMeld(meld.tiles, { ...options, maxJokers: options.maxJokers ?? options.jokerCount ?? (options.jokerConfig ? Object.values(options.jokerConfig).reduce((sum, count) => sum + count, 0) : 2) });
    assert.equal(valid.valid, true); assert.equal(meld.type, valid.type); assert.equal(meld.points, valid.points);
  }
  assert.equal(result.points, result.melds.reduce((sum, { points }) => sum + points, 0));
  assert.equal(result.canOpen, result.points >= 30);
  assert.equal(result.searchLimited, true);
  return result;
}
function context({ board = [], rack = [], opened = true, ruleVersion = 'friends-v2', copies = 2, jokerCount = 2, jokerConfig } = {}) {
  const options = { copies, jokerCount, ...(jokerConfig === undefined ? {} : { jokerConfig }) };
  const configured = createDeck(options), lookup = new Map(configured.map((tile) => [tile.id, tile]));
  const used = new Set([...board.flat(), ...rack]);
  const committed = { version: 1, ruleVersion, ...(jokerConfig === undefined ? {} : { jokerConfig }), board: board.map((meld) => meld.map((id) => ({ ...lookup.get(id) }))),
    rack: rack.map((id) => ({ ...lookup.get(id) })),
    pool: configured.filter(({ id }) => !used.has(id)), opened, round: 1 };
  return { committed, draft: structuredClone(committed), ...options, ruleVersion, maxJokers: jokerCount };
}
const run = ['red-4-a', 'red-5-a', 'red-6-a', 'red-7-a', 'red-8-a'];
function duplicateContext(settings = {}) {
  const value = context({ board: [run], rack: ['red-6-b', 'black-13-a'], ...settings });
  value.draft.rack = value.draft.rack.filter(({ id }) => id !== 'red-6-b');
  value.draft.board[0].splice(2, 0, hand('red-6-b')[0]);
  return { ...value, meldIndex: 0 };
}

test('playable sorting puts a legal mixed-order run and same-number group before unrelated cards', () => {
  const result = sort(hand('black-13-a', 'red-6-a', 'red-4-a', 'blue-10-a', 'red-5-a', 'black-10-a', 'orange-10-a', 'blue-1-a'));
  assert.equal(result.melds.length, 2); assert.equal(result.melds.flatMap(({ tiles }) => tiles).length, 6);
  assert.ok(result.melds.some(({ type }) => type === 'run')); assert.ok(result.melds.some(({ type }) => type === 'group'));
  assert.deepEqual(new Set(result.unmatchedIds), new Set(['black-13-a', 'blue-1-a']));
});
test('playable sorting can use two physical copies of a pivot in independent own-hand combinations', () => {
  const result = sort(hand('red-4-a', 'red-5-a', 'red-6-a', 'red-6-b', 'blue-6-a', 'black-6-a'), { opened: false });
  assert.equal(result.melds.length, 2); assert.equal(result.points, 33); assert.equal(result.canOpen, true);
  assert.equal(result.unmatchedIds.length, 0);
});
test('playable sorting identifies two complete physical-copy runs instead of dropping repeated values', () => {
  const result = sort(hand('red-4-a', 'red-4-b', 'red-5-a', 'red-5-b', 'red-6-a', 'red-6-b'), { opened: false });
  assert.equal(result.melds.length, 2); assert.equal(result.points, 30); assert.equal(result.canOpen, true);
});
test('opening sorter prefers an actual 30-point group over a low run competing for the same joker', () => {
  const rack = hand('red-1-a', 'red-2-a', 'blue-10-a', 'black-10-a', 'joker-a');
  const result = sort(rack, { opened: false, mode: 'color' });
  assert.equal(result.canOpen, true); assert.ok(result.points >= 30);
  assert.deepEqual(new Set(ids(result.melds[0].tiles)), new Set(['blue-10-a', 'black-10-a', 'joker-a']));
});
test('opening sorter combines independent low-point melds to meet the threshold and reports shortfall honestly', () => {
  const complete = sort(hand('red-1-a', 'red-2-a', 'red-3-a', 'blue-7-a', 'blue-8-a', 'blue-9-a'), { opened: false });
  assert.equal(complete.points, 30); assert.equal(complete.canOpen, true);
  const low = sort(hand('red-1-a', 'red-2-a', 'red-3-a', 'black-13-a'), { opened: false });
  assert.equal(low.points, 6); assert.equal(low.canOpen, false);
});
test('color and number sorting choose their natural type when two plans compete without an opening constraint', () => {
  const rack = hand('red-1-a', 'red-2-a', 'blue-10-a', 'black-10-a', 'joker-a');
  assert.equal(sort(rack, { mode: 'color' }).melds[0].type, 'run');
  assert.equal(sort(rack, { mode: 'number' }).melds[0].type, 'group');
});
test('own-hand joker suggestions obey the configured maximum and do not change old versus new rule metadata', () => {
  const rack = hand('red-10-a', 'red-12-a', 'joker-a', 'joker-b', 'joker-c', 'black-13-a');
  for (const ruleVersion of ['practice-v1', 'practice-v2', 'friends-v1', 'friends-v2']) {
    const result = sort(rack, { ruleVersion, maxJokers: 1, opened: false });
    assert.ok(result.melds.every(({ tiles }) => tiles.filter(({ joker }) => joker).length <= 1));
  }
  assert.equal(sort(hand('joker-a', 'joker-b')).melds.length, 0);
  assert.equal(sort(hand('red-10-a', 'joker-a', 'joker-b'), { maxJokers: 0 }).melds.length, 0);
});
test('explicit playable sort is deterministic, detached and has no hidden manual-order persistence', () => {
  const rack = hand('blue-1-a', 'red-8-a', 'red-6-a', 'red-7-a', 'black-13-a');
  const first = sort(rack), second = sort(rack);
  assert.deepEqual(first, second);
  first.rack[0].value = 999; first.melds[0].tiles[0].color = 'fake';
  assert.deepEqual(rack, hand('blue-1-a', 'red-8-a', 'red-6-a', 'red-7-a', 'black-13-a'));
  const manuallyChanged = [rack.at(-1), ...rack.slice(0, -1)];
  assert.equal(manuallyChanged[0].id, 'black-13-a');
  assert.deepEqual(ids(rack), ['blue-1-a', 'red-8-a', 'red-6-a', 'red-7-a', 'black-13-a']);
});
test('playable sorting keeps every ID in a full 159-tile friend deck and the four-joker 160-tile test configuration', () => {
  for (const jokerCount of [3, 4]) {
    const deck = createDeck({ copies: 3, jokerCount }).reverse();
    const result = sort(deck, { jokerCount, opened: false });
    assert.ok(result.canOpen); assert.ok(result.melds.length > 0);
    assert.ok(result.melds.flatMap(({ tiles }) => tiles).length >= 100);
  }
});
test('playable sorting handles empty and no-meld hands without manufacturing cards, and rejects malformed identities', () => {
  assert.deepEqual(sort([]).rack, []);
  assert.equal(sort(hand('red-1-a', 'blue-2-a', 'black-4-a')).melds.length, 0);
  for (const rack of [null, hand('red-1-a', 'red-1-a'), [{ id: 'bad', color: 'red', value: 14 }]]) assert.throws(() => sortPlayableRack(rack), TypeError);
  assert.throws(() => sortPlayableRack([], { maxJokers: 5 }), TypeError);
  assert.throws(() => sortPlayableRack([], { ruleVersion: 'future-v9' }), TypeError);
  assert.throws(() => sortPlayableRack([], { opened: 'yes' }), TypeError);
});
test('duplicate pivot 456 plus incoming 6 plus 78 proposes 456 and 678 with each physical tile used once', () => {
  const meld = hand('red-4-a', 'red-5-a', 'red-6-b', 'red-6-a', 'red-7-a', 'red-8-a'), before = structuredClone(meld);
  const result = autoSplitDuplicateRun(meld);
  assert.equal(result.pivotValue, 6); assert.equal(result.requiresDraftValidation, true); assert.equal(result.evaluation, null);
  assert.deepEqual(result.melds.map((tiles) => tiles.map(({ value }) => value)), [[4, 5, 6], [6, 7, 8]]);
  assert.deepEqual(result.melds.flatMap(ids).toSorted(), ids(meld).toSorted());
  assert.deepEqual(meld, before); assert.notEqual(result.melds[0][2].id, result.melds[1][0].id);
});
test('duplicate pivot can split a longer run into two complete normalized legal runs without cloning the pivot', () => {
  const result = autoSplitDuplicateRun(hand('red-9-a', 'red-4-a', 'red-5-a', 'red-6-a', 'red-7-a', 'red-8-a', 'red-8-b', 'red-10-a', 'red-11-a'));
  assert.deepEqual(result.melds.map((tiles) => tiles.map(({ value }) => value)), [[4, 5, 6, 7, 8], [8, 9, 10, 11]]);
});
test('duplicate split declines unrelated invalid drafts, endpoint duplicates, gaps, multiple repeats, mixed colors and jokers', () => {
  const bad = [
    hand('red-4-a', 'red-5-a', 'red-6-a', 'red-7-a', 'red-8-a'),
    hand('red-4-a', 'red-4-b', 'red-5-a', 'red-6-a', 'red-7-a', 'red-8-a'),
    hand('red-4-a', 'red-5-a', 'red-6-a', 'red-7-a', 'red-8-a', 'red-8-b'),
    hand('red-4-a', 'red-5-a', 'red-6-a', 'red-6-b', 'red-8-a', 'red-9-a'),
    hand('red-4-a', 'red-5-a', 'red-6-a', 'red-6-b', 'red-7-a', 'red-7-b', 'red-8-a'),
    hand('red-4-a', 'red-5-a', 'red-6-a', 'blue-6-b', 'red-7-a', 'red-8-a'),
    hand('red-4-a', 'joker-a', 'red-6-a', 'red-6-b', 'red-7-a', 'red-8-a'),
    hand('red-4-a', 'red-5-a', 'red-6-a', 'red-6-a', 'red-7-a', 'red-8-a'),
  ];
  for (const meld of bad) assert.equal(autoSplitDuplicateRun(meld), null);
  assert.equal(autoSplitDuplicateRun(null), null);
});
test('duplicate split with real complete context passes authoritative deck, old-table and played-hand evaluation', () => {
  const value = duplicateContext(), before = structuredClone(value);
  const result = autoSplitDuplicateRun(value.draft.board[0], value);
  assert.equal(result.requiresDraftValidation, false); assert.equal(result.evaluation.valid, true);
  assert.deepEqual(result.evaluation.playedIds, ['red-6-b']);
  assert.deepEqual(value, before);
  const proposal = { ...value.draft, board: result.melds };
  assert.equal(evaluateDraft(value.committed, proposal, value).valid, true);
});
test('duplicate split cannot edit public runs before opening, yet can open purely own 36-point duplicate-pivot tiles', () => {
  const locked = duplicateContext({ opened: false });
  assert.equal(autoSplitDuplicateRun(locked.draft.board[0], locked), null);
  const value = context({ opened: false, rack: [...run, 'red-6-b'] });
  value.draft.board = [value.draft.rack]; value.draft.rack = [];
  const result = autoSplitDuplicateRun(value.draft.board[0], { ...value, meldIndex: 0 });
  assert.equal(result.evaluation.valid, true); assert.equal(result.evaluation.points, 36);
});
test('duplicate split enforces 30 points during first play and can count other legal own-hand melds in the same draft', () => {
  const low = ['red-1-a', 'red-2-a', 'red-3-a', 'red-3-b', 'red-4-a', 'red-5-a'];
  const value = context({ opened: false, rack: low }); value.draft.board = [value.draft.rack]; value.draft.rack = [];
  assert.equal(autoSplitDuplicateRun(value.draft.board[0], { ...value, meldIndex: 0 }), null);
  const full = context({ opened: false, rack: [...low, 'blue-10-a', 'blue-11-a', 'blue-12-a'] });
  full.draft.board = [full.draft.rack.slice(0, 6), full.draft.rack.slice(6)]; full.draft.rack = [];
  const result = autoSplitDuplicateRun(full.draft.board[0], { ...full, meldIndex: 0 });
  assert.equal(result.evaluation.points, 51);
});
test('duplicate split preserves original joker-lock rules: v1 rejects changed old joker groups, v2 accepts complete legal rearrangement', () => {
  for (const ruleVersion of ['friends-v1', 'friends-v2']) {
    const value = context({ ruleVersion, board: [['red-4-a', 'joker-a', 'red-6-a', 'red-7-a', 'red-8-a'], ['blue-10-a', 'blue-11-a', 'blue-12-a']],
      rack: ['red-5-a', 'red-6-b'] });
    value.draft.board = [hand('red-4-a', 'red-5-a', 'red-6-a', 'red-6-b', 'red-7-a', 'red-8-a'), hand('blue-10-a', 'blue-11-a', 'blue-12-a', 'joker-a')];
    value.draft.rack = [];
    const result = autoSplitDuplicateRun(value.draft.board[0], { ...value, meldIndex: 0 });
    if (ruleVersion === 'friends-v1') assert.equal(result, null);
    else { assert.equal(result.evaluation.valid, true); assert.equal(result.evaluation.points, 11); }
  }
});
test('duplicate split declines lost or duplicated physical tiles, altered pools and other unfinished groups', () => {
  for (const alter of [
    (v) => { v.draft.rack = []; },
    (v) => { v.draft.pool.reverse(); },
    (v) => { v.draft.rack.push({ ...v.draft.board[0][0] }); },
    (v) => { v.draft.board.push([v.draft.rack.pop()]); },
  ]) {
    const value = duplicateContext(); alter(value);
    assert.equal(autoSplitDuplicateRun(value.draft.board[0], value), null);
  }
  const value = duplicateContext();
  assert.equal(autoSplitDuplicateRun(value.draft.board[0], { committed: value.committed }), null);
  assert.equal(autoSplitDuplicateRun(value.draft.board[0], { ...value, meldIndex: 20 }), null);
  assert.equal(autoSplitDuplicateRun(value.draft.board[0], { ...value, draft: { ...value.draft, board: [null] } }), null);
});
test('duplicate split supports the confirmed three-copy 159-tile state without altering unrelated physical copies', () => {
  const value = duplicateContext({ copies: 3, jokerCount: 3, rack: ['red-6-c', 'black-13-a'] });
  // Replace the hand insertion helper's intended b tile with the third physical copy.
  value.draft = structuredClone(value.committed);
  value.draft.rack = value.draft.rack.filter(({ id }) => id !== 'red-6-c');
  value.draft.board[0].splice(3, 0, hand('red-6-c')[0]);
  const result = autoSplitDuplicateRun(value.draft.board[0], value);
  assert.equal(result.evaluation.valid, true); assert.deepEqual(result.evaluation.playedIds, ['red-6-c']);
});

const twistConfig = { normal: 8, mirror: 2, colorChange: 7, double: 7 };
const twistOptions = { ruleVersion: 'friends-v3', jokerConfig: twistConfig, jokerCount: 24, maxJokers: 24, opened: false };
const twistLookup = new Map(createDeck({ copies: 3, jokerConfig: twistConfig }).map((tile) => [tile.id, tile]));
const twistHand = (...tileIds) => tileIds.map((id) => ({ ...twistLookup.get(id) }));
test('v3 playable sort recognizes each typed joker with canonical points and never manufactures another copy', () => {
  const cases = [
    { rack: ['blue-10-a', 'black-10-a', 'joker-normal-1', 'red-1-a'], type: 'normal', points: 30 },
    { rack: ['blue-10-a', 'red-10-a', 'joker-double-1', 'black-2-a'], type: 'double', points: 40 },
    { rack: ['blue-2-a', 'blue-3-a', 'joker-mirror-1', 'blue-3-b', 'blue-2-b', 'black-13-a'], type: 'mirror', points: 10 },
    { rack: ['red-10-a', 'joker-color-change-1', 'blue-12-a', 'black-2-a'], type: 'color-change', points: 33 },
  ];
  for (const item of cases) {
    const result = sort(twistHand(...item.rack), twistOptions);
    const matched = result.melds.find(({ tiles }) => tiles.some(({ jokerType }) => jokerType === item.type));
    assert.ok(matched, `${item.type} should receive a finite legal suggestion`);
    assert.equal(matched.points, item.points);
    assert.equal(result.canOpen, item.points >= 30);
  }
});
test('v3 all 180 physical tiles and 24 mixed jokers sort deterministically within a bounded search', () => {
  const deck = createDeck({ copies: 3, jokerConfig: twistConfig }).reverse();
  const started = performance.now(), result = sort(deck, twistOptions);
  assert.ok(performance.now() - started < 3000, 'full configured deck must not enumerate 24 joker permutations');
  assert.equal(result.orderIds.length, 180); assert.ok(result.canOpen);
  assert.ok(result.melds.flatMap(({ tiles }) => tiles).length >= 140);
  assert.deepEqual(sort(deck, twistOptions), result);
  for (const bad of [
    { ...twistOptions, jokerCount: 23, maxJokers: 23 },
    { ...twistOptions, jokerConfig: { normal: 8, mirror: 8, colorChange: 8, double: 8 } },
    { ...twistOptions, ruleVersion: 'friends-v2' },
  ]) {
    if (bad.ruleVersion === 'friends-v2') assert.equal(sortPlayableRack(twistHand('blue-10-a', 'red-10-a', 'joker-double-1'), bad).melds.length, 0);
    else assert.throws(() => sortPlayableRack([], bad), TypeError);
  }
});
test('v3 duplicate pivot split preserves the full 180-tile config and cannot override opening or subtype state', () => {
  const value = duplicateContext({ copies: 3, jokerCount: 24, jokerConfig: twistConfig, ruleVersion: 'friends-v3', rack: ['red-6-b', 'joker-double-1'] });
  const before = structuredClone(value), result = autoSplitDuplicateRun(value.draft.board[0], value);
  assert.ok(result); assert.equal(result.evaluation.valid, true); assert.deepEqual(result.evaluation.playedIds, ['red-6-b']);
  assert.deepEqual(value, before);
  assert.equal(autoSplitDuplicateRun(value.draft.board[0], { ...value, committed: { ...value.committed, opened: false }, draft: { ...value.draft, opened: false } }), null);
  const noConfig = structuredClone(value); delete noConfig.draft.jokerConfig;
  assert.equal(autoSplitDuplicateRun(noConfig.draft.board[0], noConfig), null);
});

const insertionConfig={normal:1,mirror:1,colorChange:1,double:1};
function jokerDraft(names,jokerId,{opened=true}={}) {
  const value=context({rack:[...names,'black-13-c'],opened,copies:3,jokerCount:4,
    jokerConfig:insertionConfig,ruleVersion:'friends-v3'});
  value.draft.board=[value.draft.rack.filter(tile=>tile.id!=='black-13-c')];
  value.draft.rack=value.draft.rack.filter(tile=>tile.id==='black-13-c');
  return {...value,meldIndex:0,insertedIds:[jokerId],dropIndex:names.indexOf(jokerId)};
}
function insertionResult(value) {
  const before=structuredClone(value),result=autoSplitDuplicateRun(value.draft.board[0],value);
  assert.deepEqual(value,before);assert.ok(result,'a complete canonical partition should exist');
  assert.equal(result.evaluation.valid,true);assert.equal(result.requiresDraftValidation,false);
  assert.deepEqual(result.melds.flat().map(tile=>tile.id).sort(),value.draft.board[0].map(tile=>tile.id).sort());
  assert.equal(new Set(result.melds.flat().map(tile=>tile.id)).size,value.draft.board[0].length);
  for(const group of result.melds)assert.equal(validateMeld(group,value).valid,true);
  const board=value.draft.board.flatMap((group,index)=>index===0?result.melds:[group]);
  assert.equal(evaluateDraft(value.committed,{...value.draft,board},value).valid,true);
  return result;
}
test('inserted normal joker splits at its intended middle drop even though whole-set rules would normalize it into 9',()=>{
  const names=['red-1-a','red-2-a','red-3-a','red-4-a','joker-normal-1','red-5-a','red-6-a','red-7-a','red-8-a'];
  const value=jokerDraft(names,'joker-normal-1'),whole=validateMeld(value.draft.board[0],value);
  assert.equal(whole.valid,true);const result=insertionResult(value);assert.equal(result.melds.length,2);
  assert.deepEqual(result.melds.map(ids),[names.slice(0,5),names.slice(5)]);
});
test('inserted double joker can supply a legal endpoint pair in a middle-drop partition without creating extra entities',()=>{
  const names=['red-1-a','red-2-a','red-3-a','red-4-a','joker-double-1','red-5-a','red-6-a','red-7-a','red-8-a'];
  const value=jokerDraft(names,'joker-double-1');assert.equal(validateMeld(value.draft.board[0],value).valid,true);
  const result=insertionResult(value);assert.equal(result.melds.length,2);
  assert.deepEqual(result.melds.map(ids),[names.slice(0,5),names.slice(5)]);
  assert.equal(result.melds.flat().filter(tile=>tile.joker).length,1);
});
test('mirror insertion partitions only around a canonical symmetric centre, with the fewest complete groups',()=>{
  const names=['red-1-a','red-2-a','red-3-a','red-4-a','joker-mirror-1','red-4-b','red-5-a','red-6-a','red-7-a'];
  const result=insertionResult(jokerDraft(names,'joker-mirror-1'));assert.equal(result.melds.length,3);
  assert.deepEqual(result.melds.map(ids),[names.slice(0,3),names.slice(3,6),names.slice(6)]);
  const invalid=jokerDraft(['red-1-a','red-2-a','red-3-a','red-4-a','joker-mirror-1','red-5-a','red-6-a','red-7-a','red-8-a'],'joker-mirror-1');
  assert.equal(autoSplitDuplicateRun(invalid.draft.board[0],invalid),null);
});
test('color-change insertion uses the existing run color-boundary rule and never a standalone wildcard group',()=>{
  const names=['red-1-a','red-2-a','red-3-a','red-4-a','joker-color-change-1','blue-6-a','blue-7-a','blue-8-a','red-10-a','red-11-a','red-12-a'];
  const result=insertionResult(jokerDraft(names,'joker-color-change-1'));assert.equal(result.melds.length,2);
  const containing=result.melds.find(group=>group.some(tile=>tile.id==='joker-color-change-1'));
  assert.equal(validateMeld(containing,{...insertionConfig,ruleVersion:'friends-v3',jokerConfig:insertionConfig,maxJokers:4}).type,'run');
  const invalid=jokerDraft(['red-3-a','blue-3-a','joker-color-change-1','red-8-a','red-9-a','red-10-a'],'joker-color-change-1');
  assert.equal(autoSplitDuplicateRun(invalid.draft.board[0],invalid),null);
});
test('a whole run already honoring the normal/double/color-change gap or mirror centre stays a single group',()=>{
  for(const [jokerId,names]of [
    ['joker-normal-1',['red-1-a','red-2-a','red-3-a','red-4-a','joker-normal-1','red-6-a','red-7-a','red-8-a']],
    ['joker-double-1',['red-1-a','red-2-a','red-3-a','red-4-a','joker-double-1','red-7-a','red-8-a']],
    ['joker-color-change-1',['red-1-a','red-2-a','red-3-a','red-4-a','joker-color-change-1','blue-6-a','blue-7-a','blue-8-a']],
    ['joker-mirror-1',['red-1-a','red-2-a','red-3-a','joker-mirror-1','red-3-b','red-2-b','red-1-b']],
  ]) {
    const value=jokerDraft(names,jokerId);assert.equal(validateMeld(value.draft.board[0],value).valid,true);
    assert.equal(autoSplitDuplicateRun(value.draft.board[0],value),null);
  }
});
test('joker insertion never bypasses the complete opening threshold or another unfinished table group',()=>{
  const low=jokerDraft(['red-1-a','red-2-a','joker-normal-1','red-2-b','red-3-a','red-4-a'],'joker-normal-1',{opened:false});
  assert.equal(autoSplitDuplicateRun(low.draft.board[0],low),null);
  const high=jokerDraft(['red-1-a','red-2-a','red-3-a','red-4-a','joker-normal-1','red-5-a','red-6-a','red-7-a','red-8-a'],'joker-normal-1',{opened:false});
  assert.ok(insertionResult(high).evaluation.points>=30);
  const unrelated=jokerDraft(['red-1-a','red-2-a','red-3-a','red-4-a','joker-normal-1','red-5-a','red-6-a','red-7-a','red-8-a'],'joker-normal-1');
  unrelated.draft.board.push([unrelated.draft.rack[0]]);unrelated.draft.rack=[];
  assert.equal(autoSplitDuplicateRun(unrelated.draft.board[0],unrelated),null);
});
test('a recovered public joker respects old v1 locked groups; v2 allows the same otherwise complete rearrangement',()=>{
  for(const ruleVersion of ['friends-v1','friends-v2']) {
    const names=['red-1-a','red-2-a','red-3-a','red-4-a','red-5-a','red-6-a','red-7-a','red-8-a'];
    const value=context({board:[names,['blue-10-a','blue-11-a','joker-a']],rack:['blue-12-a','black-13-a'],ruleVersion});
    value.draft.board[0].splice(4,0,hand('joker-a')[0]);value.draft.board[1]=hand('blue-10-a','blue-11-a','blue-12-a');
    value.draft.rack=value.draft.rack.filter(tile=>tile.id!=='blue-12-a');
    Object.assign(value,{meldIndex:0,insertedIds:['joker-a'],dropIndex:4});
    const result=autoSplitDuplicateRun(value.draft.board[0],value);
    if(ruleVersion==='friends-v1')assert.equal(result,null);else{assert.ok(result);assert.equal(result.evaluation.valid,true);}
  }
});
test('joker repair requires a real explicit insertion and unchanged full-deck context',()=>{
  const value=jokerDraft(['red-1-a','red-2-a','red-3-a','red-4-a','joker-normal-1','red-5-a','red-6-a','red-7-a','red-8-a'],'joker-normal-1');
  for(const change of [{insertedIds:undefined},{insertedIds:['unknown']},{insertedIds:['joker-normal-1','joker-normal-1']},
    {committed:undefined},{meldIndex:1},{draft:{...value.draft,pool:[]}}])assert.equal(autoSplitDuplicateRun(value.draft.board[0],{...value,...change}),null);
  assert.equal(autoSplitDuplicateRun(value.draft.board[0],{ruleVersion:'friends-v3',jokerConfig:insertionConfig,maxJokers:4,insertedIds:['joker-normal-1'],dropIndex:4}),null);
});

test('three-group mirror repair uses only two owned insertions in a legal public run and keeps unrelated groups and the exact full deck',()=>{
  const numbers=[1,2,3,4,5,6,7].map(n=>`red-${n}-a`),other=['blue-10-a','blue-11-a','blue-12-a'];
  const value=context({board:[numbers,other],rack:['joker-mirror-1','red-4-b','black-13-a'],
    copies:2,jokerCount:4,jokerConfig:insertionConfig,ruleVersion:'friends-v3'});
  const inserted=value.draft.rack.filter(tile=>tile.id!=='black-13-a');
  value.draft.rack=value.draft.rack.filter(tile=>tile.id==='black-13-a');value.draft.board[0].splice(4,0,...inserted);
  Object.assign(value,{meldIndex:0,insertedIds:inserted.map(tile=>tile.id),dropIndex:4});
  const original=structuredClone(value),result=insertionResult(value);
  assert.equal(result.melds.length,3);assert.deepEqual(result.melds.map(ids),[
    numbers.slice(0,3),['red-4-a','joker-mirror-1','red-4-b'],numbers.slice(4)]);
  assert.deepEqual(result.evaluation.playedIds.toSorted(),['joker-mirror-1','red-4-b'].toSorted());
  const complete={...value.draft,board:[...result.melds,value.draft.board[1]]};
  assert.deepEqual(ids(complete.board.at(-1)),other);assert.deepEqual(complete.pool,original.committed.pool);
  assert.equal(new Set([...complete.rack,...complete.pool,...complete.board.flat()].map(tile=>tile.id)).size,108);
  assert.equal(evaluateDraft(value.committed,complete,value).valid,true);assert.deepEqual(value,original);
});
