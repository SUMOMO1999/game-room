import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectorPages, roomTransition, roomExitExplanation, roomDraftMatches, gameErrorMessage } from './game-presentation.mjs';

const tiles = count => Array.from({ length: count }, (_, index) => ({ id: `tile-${index}`, value: index % 13 + 1 }));
const view = overrides => ({ roomId: 'private-room', selfId: 'me', revision: 10, phase: 'playing', game: {
  round: 3, status: 'playing', turnPlayerId: 'friend', board: [tiles(3)],
  players: [{ id: 'me', rackCount: 14 }, { id: 'friend', rackCount: 18 }], ...overrides?.game,
}, ...Object.fromEntries(Object.entries(overrides || {}).filter(([key]) => key !== 'game')) });

test('inspector pages conserve every tile in 21/30/50 and extreme 159 tile racks', () => {
  for (const count of [0, 14, 21, 30, 50, 159]) {
    const rack = Object.freeze(tiles(count));
    const pages = inspectorPages([], rack, 'rack');
    assert.deepEqual(pages.flatMap(page => page.tiles), rack);
    assert.ok(pages.every(page => page.tiles.length <= 14));
    assert.equal(pages.length, Math.ceil(count / 14));
  }
});

test('unfinished long public groups paginate and whole-group selection preserves the original group', () => {
  const group = tiles(50), next = [{ id: 'second-group' }];
  const pages = inspectorPages([group, next], [], 'board');
  assert.equal(pages.length, 5); assert.deepEqual(pages.flatMap(page => page.tiles), [...group, ...next]);
  assert.ok(pages.slice(0, 4).every(page => page.groupIndex === 0 && page.parts === 4));
  assert.deepEqual(pages[2].selectionIds, group.map(tile => tile.id));
  assert.equal(pages[4].groupIndex, 1); assert.equal(pages[4].part, 0);
});

test('first, duplicate, reconnect and another seat snapshots never generate cues or animations', () => {
  const old = view(), next = view({ revision: 11, game: { round: 4, turnPlayerId: 'me', board: [tiles(6)] } });
  for (const [previous, current, options] of [[null, next], [old, old], [old, next, { baseline: true }],
    [old, { ...next, selfId: 'someone' }], [old, { ...next, roomId: 'different' }]]) {
    assert.deepEqual(roomTransition(previous, current, options), { cue: null, boardChanged: false, arrivedIds: [], turnToSelf: false });
  }
});

test('a real friend commit highlights only newly public tiles and prioritizes my next turn', () => {
  const notice = roomTransition(view(), view({ revision: 11, game: { round: 4, turnPlayerId: 'me', board: [tiles(6)] } }));
  assert.equal(notice.cue, 'turn'); assert.equal(notice.turnToSelf, true); assert.equal(notice.boardChanged, true);
  assert.deepEqual(notice.arrivedIds, ['tile-3', 'tile-4', 'tile-5']);
  assert.equal(roomTransition(view(), view({ revision: 11, game: { round: 4, turnPlayerId: 'third', board: [tiles(6)] } })).cue, 'commit');
});

test('friend draw, own action, natural ending, paused and aborted are distinct', () => {
  const old = view();
  assert.equal(roomTransition(old, view({ revision: 11, game: { round: 4, turnPlayerId: 'third', players: [{ id: 'friend', rackCount: 19 }] } })).cue, 'draw');
  assert.equal(roomTransition(view({ game: { turnPlayerId: 'me' } }), view({ revision: 11, game: { round: 4, turnPlayerId: 'friend', board: [tiles(6)] } })).cue, null);
  assert.equal(roomTransition(old, view({ revision: 11, phase: 'finished', game: { status: 'finished' } })).cue, 'win');
  for (const phase of ['paused', 'aborted', 'waiting']) assert.equal(roomTransition(old, view({ revision: 11, phase })).cue, null);
  assert.equal(roomTransition(old, view({ revision: 11, phase: 'finished', game: { status: 'aborted', result: { aborted: true } } })).cue, null);
});

test('leaving a live or paused game explicitly explains no scores; leaving settled room preserves the account', () => {
  for (const phase of ['playing', 'paused']) assert.match(roomExitExplanation(phase), /不计输赢/);
  for (const phase of ['waiting', 'finished', 'aborted']) assert.match(roomExitExplanation(phase), /账号继续登录/);
});

test('feedback preserves useful public errors but removes network, stack and oversized diagnostics', () => {
  assert.equal(gameErrorMessage({status:409,message:'轮到另一位朋友了，请稍等。'}),'轮到另一位朋友了，请稍等。');
  for(const message of ['Failed to fetch','TypeError: Cannot read properties','内部错误\n at render (app.mjs:123)', '查询错误 https://host/secret', '错'.repeat(300)]) {
    assert.equal(gameErrorMessage({message}),'连接暂时不可用，请稍后重试。');
  }
  assert.match(gameErrorMessage({status:503,message:'Error: sqlite unavailable'}),/整理会保留/);
  assert.match(gameErrorMessage({status:401}),/重新登录/);
});

test('draft restoration follows game revision and match identity across votes, host transfer and pause', () => {
  const saved={revision:10,matchId:'one-match',gameRevision:3};
  for(const phase of ['playing','paused']) assert.equal(roomDraftMatches(saved,view({revision:20,matchId:'one-match',phase,game:{revision:3}})),true);
  assert.equal(roomDraftMatches(saved,view({matchId:'one-match',game:{revision:4}})),false);
  assert.equal(roomDraftMatches(saved,view({matchId:'another-match',game:{revision:3}})),false);
  assert.equal(roomDraftMatches(saved,view({matchId:'one-match',phase:'aborted',game:{revision:3}})),false);
  assert.equal(roomDraftMatches({revision:10},view()),true);
  assert.equal(roomDraftMatches({revision:9},view()),false);
});
