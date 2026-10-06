import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyRoll, applyMove, applyTimeout } from './rules.mjs';
import { createFlyingChessAdapter } from '../../../server/games/flying-chess/adapter.mjs';
import { flyingModel, flyingTransition, flyingRulePages, flyingSideLabel } from './presentation.mjs';

const adapter = createFlyingChessAdapter();
const members = [{ id: 'alice', name: '朋友甲' }, { id: 'bob', name: '朋友乙' }];
function view(game = createGame(['alice', 'bob'], { firstPlayerIndex: 0 }), { selfId = 'alice', phase = 'playing', observer = false } = {}) {
  const projection = observer ? adapter.spectatorView(game, { phase }) : adapter.privateView(game, selfId, { phase });
  if (phase === 'paused') projection.status = 'paused';
  return { roomId: 'room-one', roomCode: '123456', matchId: 'match-one', revision: game.revision + 5,
    selfId, selfRole: observer ? 'spectator' : 'player', phase, players: structuredClone(members), game: projection };
}
const rolled = (game, die = 6) => { const result = applyRoll(game, game.turnPlayerId, die); assert.equal(result.ok, true); return result.state; };
const moved = (game, planeId = 'red-1') => { const result = applyMove(game, game.turnPlayerId, { rollId: game.rollId, planeId }); assert.equal(result.ok, true); return result.state; };

test('current private roll projection offers dice and four stable numbered planes without predicting a result', () => {
  const input = view(), original = structuredClone(input), model = flyingModel(input);
  assert.equal(model.canRoll, true); assert.equal(model.canChoose, false); assert.equal(model.canConfirm, false);
  assert.equal(model.route, null); assert.equal(model.die, null); assert.equal(model.selfSide, 'red');
  assert.deepEqual(model.planesToChoose.map(item => [item.id, item.number, item.positionLabel]),
    [1, 2, 3, 4].map(number => [`red-${number}`, number, '机库 · 六点起飞']));
  assert.ok(model.planesToChoose.every(plane => !plane.legal && !plane.selected && !plane.completed));
  assert.match(model.turnText, /轮到你/); assert.equal(model.nextPlayerId, 'bob');
  assert.deepEqual(input, original, 'model construction leaves the caller projection unchanged');
});

test('saved six exposes four individual launch choices and a current route only for a selected legal aircraft', () => {
  const input = view(rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 }))), original = structuredClone(input);
  const unselected = flyingModel(input), selected = flyingModel(input, { selectedId: 'red-3' });
  assert.equal(unselected.canRoll, false); assert.equal(unselected.canChoose, true); assert.equal(unselected.canConfirm, false);
  assert.equal(selected.canConfirm, true); assert.equal(selected.selectedId, 'red-3');
  assert.equal(selected.die, 6); assert.equal(selected.dieIsCurrent, true);
  assert.deepEqual(selected.legalIds, ['red-1', 'red-2', 'red-3', 'red-4']);
  assert.deepEqual(selected.route, input.game.legalMoves[2]); assert.match(selected.feedback, /六点起飞/);
  assert.equal(selected.planesToChoose.filter(plane => plane.selected).length, 1);
  selected.route.to = 55;
  assert.deepEqual(input, original, 'returned route is a copy, not a writable reference into the saved projection');
});

test('observers, another player, paused, terminal, wrong private owner and missing role never obtain a preview', () => {
  const game = rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 }));
  const cases = [view(game, { observer: true, selfId: 'watcher' }), view(game, { selfId: 'bob' }),
    view(game, { phase: 'paused' }), { ...view(game), phase: 'finished' }, { ...view(game), phase: 'aborted' },
    { ...view(game), selfId: 'bob' }, { ...view(game), selfRole: undefined }];
  for (const input of cases) {
    // Stale permission arrays must not authorize a route after a role/phase change.
    input.game.canRoll = true; input.game.legalPlaneIds = game.legalPlaneIds;
    input.game.legalMoves = view(game).game.legalMoves;
    const model = flyingModel(input, { selectedId: 'red-1' });
    assert.equal(model.canRoll, false); assert.equal(model.canChoose, false); assert.equal(model.canConfirm, false);
    assert.equal(model.route, null); assert.equal(model.selectedId, null); assert.deepEqual(model.legalIds, []);
    assert.ok(model.planesToChoose.every(plane => !plane.legal && !plane.selected));
  }
});

test('busy and unknown requests block both stages while explicitly describing unresolved results', () => {
  const roll = view(), choose = view(rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 })));
  for (const input of [roll, choose]) {
    const busy = flyingModel(input, { selectedId: 'red-1', busy: true });
    assert.equal(busy.canRoll, false); assert.equal(busy.canChoose, false); assert.equal(busy.canConfirm, false);
    assert.match(busy.stageText, /等待正式结果/);
    const unknown = flyingModel(input, { selectedId: 'red-1', pending: true, busy: true });
    assert.equal(unknown.route, null); assert.equal(unknown.canRoll, false); assert.equal(unknown.canConfirm, false);
    assert.match(unknown.stageText, /尚未确认/); assert.match(unknown.feedback, /原操作/); assert.match(unknown.feedback, /退出房间/);
  }
});

test('unknown, opponent, removed and completed selected aircraft are discarded without falling back to the first plane', () => {
  const input = view(rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 })));
  for (const selectedId of ['unknown', 'yellow-1', '', null]) {
    const model = flyingModel(input, { selectedId });
    assert.equal(model.selectedId, null); assert.equal(model.route, null); assert.equal(model.canConfirm, false);
  }
  const removed = structuredClone(input); removed.game.planes = removed.game.planes.filter(plane => plane.id !== 'red-1');
  assert.equal(flyingModel(removed, { selectedId: 'red-1' }).canConfirm, false);
  const completed = structuredClone(input); completed.game.planes.find(plane => plane.id === 'red-1').progress = 55;
  const model = flyingModel(completed, { selectedId: 'red-1' });
  assert.equal(model.route, null); assert.equal(model.planesToChoose[0].completed, true); assert.equal(model.planesToChoose[0].legal, false);
});

test('a permission id requires a matching route with the same saved die, origin, side and aircraft', () => {
  const input = view(rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 })));
  for (const change of [{ die: 5 }, { from: 0 }, { side: 'yellow' }, { planeId: 'yellow-1' }, { segments: null }, { to: 56 }]) {
    const broken = structuredClone(input); Object.assign(broken.game.legalMoves[0], change);
    assert.equal(flyingModel(broken, { selectedId: 'red-1' }).route, null);
  }
  const missing = structuredClone(input); missing.game.legalMoves = [];
  assert.equal(flyingModel(missing).canChoose, false);
  const missingId = structuredClone(input); missingId.game.legalPlaneIds = [];
  assert.equal(flyingModel(missingId, { selectedId: 'red-1' }).canConfirm, false);
});

test('waiting colours come from side assignments, not nickname or seat position', () => {
  const input = { phase: 'waiting', selfId: 'bob', selfRole: 'player', players: members,
    sideAssignments: [{ playerId: 'alice', side: 'red' }, { playerId: 'bob', side: 'yellow' }], game: null };
  const model = flyingModel(input);
  assert.equal(model.selfSide, 'yellow'); assert.deepEqual(model.planesToChoose, []);
  assert.equal(model.canRoll, false); assert.equal(model.route, null); assert.match(model.stageText, /随机选先手/);
  assert.equal(flyingModel({ ...input, selfId: 'same-nickname' }).selfSide, null);
});

test('no legal move shows the committed previous die while the next player can roll', () => {
  const game = rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 }), 5);
  const model = flyingModel(view(game, { selfId: 'bob' }));
  assert.equal(model.canRoll, true); assert.equal(model.die, 5); assert.equal(model.dieIsCurrent, false);
  assert.match(model.feedback, /没有可行动/); assert.match(model.turnText, /轮到你/);
});

test('six bonus, timeout discard, paused and aborted text do not invent a loss or a new die', () => {
  const afterSix = moved(rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 })));
  assert.match(flyingModel(view(afterSix)).stageText, /六点奖励/);
  const pending = rolled(afterSix, 5), timedOut = applyTimeout(pending);
  assert.equal(timedOut.ok, true);
  const timeoutModel = flyingModel(view(timedOut.state));
  assert.match(timeoutModel.feedback, /5 点已弃掉/); assert.equal(timeoutModel.die, null);
  const paused = flyingModel(view(pending, { phase: 'paused' }), { selectedId: 'red-1' });
  assert.equal(paused.die, 5); assert.match(paused.stageText, /不重新掷骰/); assert.equal(paused.route, null);
  const aborted = view(afterSix); aborted.phase = 'aborted'; aborted.game.status = 'aborted'; aborted.game.result = { aborted: true, winnerIds: [] };
  assert.match(flyingModel(aborted).resultText, /所有人不计输赢/);
});

test('terminal result names the actual winner without fabricating other finishing places', () => {
  const input = view(); input.phase = 'finished'; input.game.status = 'finished'; input.game.stage = 'finished';
  input.game.result = { winnerIds: ['bob'], completedCounts: [{ playerId: 'alice', completed: 2 }, { playerId: 'bob', completed: 4 }] };
  const model = flyingModel(input);
  assert.match(model.resultText, /朋友乙.*四架.*赢得/); assert.doesNotMatch(model.resultText, /第二|第三|积分|手牌/);
  assert.equal(model.canRoll, false); assert.equal(model.canChoose, false);
});

test('transition emits one saved roll cue and never emits it again for a receipt-only room revision', () => {
  const before = view(), after = view(rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 })));
  assert.deepEqual(flyingTransition(before, after), { changed: true, cues: ['roll'] });
  assert.deepEqual(flyingTransition(after, { ...after, revision: after.revision + 1 }), { changed: false, cues: [] });
  assert.deepEqual(flyingTransition(after, after), { changed: false, cues: [] });
  assert.deepEqual(flyingTransition(after, before), { changed: false, cues: [] });
});

test('baseline, new match, different room/account/role and missing revision never replay historical effects', () => {
  const before = view(), after = view(rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 })));
  assert.deepEqual(flyingTransition(before, after, { baseline: true }), { changed: false, cues: [] });
  for (const change of [{ roomId: 'other-room' }, { roomCode: '654321' }, { matchId: 'other-match' },
    { selfId: 'bob' }, { selfRole: 'spectator' }]) {
    assert.deepEqual(flyingTransition(before, { ...after, ...change }), { changed: false, cues: [] });
  }
  const malformed = structuredClone(after); delete malformed.game.revision;
  assert.deepEqual(flyingTransition(before, malformed), { changed: false, cues: [] });
  assert.deepEqual(flyingTransition(null, after), { changed: false, cues: [] });
  assert.deepEqual(flyingTransition({ ...before, matchId: null }, { ...after, matchId: null }), { changed: false, cues: [] });
  assert.deepEqual(flyingTransition({ ...before, roomId: null, roomCode: null }, { ...after, roomId: null, roomCode: null }), { changed: false, cues: [] });
});

test('explicit local practice retains public action sound when the same device switches to the next side', () => {
  const game = createGame(['alice', 'bob'], { firstPlayerIndex: 0 });
  const before = { ...view(game), roomId: 'flying-local-practice', roomCode: undefined, practice: true };
  const after = { ...view(rolled(game, 5), { selfId: 'bob' }), roomId: 'flying-local-practice', roomCode: undefined, practice: true };
  assert.deepEqual(flyingTransition(before, after), { changed: true, cues: ['roll', 'turn'] });
  assert.deepEqual(flyingTransition({ ...before, practice: false }, after), { changed: false, cues: [] });
  assert.deepEqual(flyingTransition({ ...before, roomId: 'room-one' }, { ...after, roomId: 'room-one' }), { changed: false, cues: [] });
});

test('one most descriptive public move cue takes precedence over lower action cues', () => {
  const before = view(rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 })));
  const after = view(moved(rolled(createGame(['alice', 'bob'], { firstPlayerIndex: 0 }))));
  assert.deepEqual(flyingTransition(before, after), { changed: true, cues: ['launch'] });
  const base = structuredClone(after);
  for (const [route, cue] of [
    [{ capturedIds: ['yellow-1', 'yellow-2'], finished: true, segments: [{ kind: 'fly' }] }, 'collision'],
    [{ capturedIds: [], finished: true, segments: [{ kind: 'walk' }] }, 'plane-finish'],
    [{ capturedIds: [], finished: false, segments: [{ kind: 'jump' }, { kind: 'fly' }] }, 'flight'],
    [{ capturedIds: [], finished: false, segments: [{ kind: 'walk' }, { kind: 'bounce' }] }, 'move'],
  ]) {
    const input = structuredClone(base); Object.assign(input.game.lastAction.route, route);
    assert.deepEqual(flyingTransition(before, input), { changed: true, cues: [cue] });
  }
});

test('public dice or movement and own next turn each occur once; observers never receive own turn', () => {
  const game = createGame(['alice', 'bob'], { firstPlayerIndex: 0 });
  const before = view(game, { selfId: 'bob' }), after = view(rolled(game, 5), { selfId: 'bob' });
  assert.deepEqual(flyingTransition(before, after), { changed: true, cues: ['roll', 'turn'] });
  const observerBefore = view(game, { selfId: 'watcher', observer: true }), observerAfter = view(rolled(game, 5), { selfId: 'watcher', observer: true });
  assert.deepEqual(flyingTransition(observerBefore, observerAfter), { changed: true, cues: ['roll'] });
  const timeout = applyTimeout(game).state;
  assert.deepEqual(flyingTransition(before, view(timeout, { selfId: 'bob' })), { changed: true, cues: ['turn'] });
});

test('finish emits only the outcome cue; pause/resume and abort never synthesize a move', () => {
  const before = view(), after = structuredClone(before); after.game.revision += 1; after.phase = 'finished';
  after.game.status = 'finished'; after.game.result = { winnerIds: ['alice'] };
  after.game.lastAction = { type: 'move', route: { capturedIds: [], finished: true, segments: [{ kind: 'walk' }] } };
  assert.deepEqual(flyingTransition(before, after), { changed: true, cues: ['win'] });
  assert.deepEqual(flyingTransition({ ...before, selfId: 'bob' }, { ...after, selfId: 'bob' }), { changed: true, cues: ['loss'] });
  assert.deepEqual(flyingTransition({ ...before, selfRole: 'spectator' }, { ...after, selfRole: 'spectator' }), { changed: true, cues: ['draw-result'] });
  const paused = { ...after, phase: 'paused', game: { ...after.game, status: 'paused', result: null } };
  assert.deepEqual(flyingTransition(before, paused), { changed: true, cues: [] });
  const resumed = { ...after, phase: 'playing', game: { ...after.game, status: 'playing', result: null } };
  assert.deepEqual(flyingTransition({ ...before, phase: 'paused' }, resumed), { changed: true, cues: [] });
  assert.deepEqual(flyingTransition(before, { ...after, phase: 'aborted' }), { changed: true, cues: [] });
});

test('rule pages reflect the agreed friend rules, practise distinction and isolated mutable caller copies', () => {
  const pages = flyingRulePages(), practice = flyingRulePages({ practice: true });
  assert.equal(pages.length, 4); assert.ok(pages.every(page => page.length === 2));
  const text = JSON.stringify(pages);
  assert.match(text, /仅六点起飞/); assert.match(text, /连续三个六也不处罚/);
  assert.match(text, /每次最多一跳一飞/); assert.match(text, /精确到终点/); assert.match(text, /整个回合 30 分钟/);
  assert.match(text, /原请求/); assert.match(text, /所有人不计输赢/);
  assert.match(JSON.stringify(practice), /本机练习/); assert.doesNotMatch(JSON.stringify(practice), /整个回合 30 分钟/);
  pages[0][0].text = 'changed'; assert.notEqual(flyingRulePages()[0][0].text, 'changed');
  assert.equal(flyingSideLabel('red'), '红圆'); assert.equal(flyingSideLabel('unknown'), '未分阵营');
});
