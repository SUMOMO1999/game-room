import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlyingPracticeSession } from './practice-engine.mjs';
import { createGame, applyRoll, applyMove, gameProblem } from './rules.mjs';
import { flyingMotionPlan, flyingRoutePoints } from './motion-ui.mjs';

async function lesson(name) {
  const session = await createFlyingPracticeSession({ storage: null, randomInt: () => 0, requestId: () => 'motion-test' });
  await session.restart({ lesson: name }); await session.action('roll');
  const before = session.view();
  await session.action('move', { rollId: before.game.rollId, planeId: 'red-1' });
  const after = session.view(); session.destroy(); return { before, after };
}
for (const [name, kinds] of [['jump-fly', ['walk','jump','fly']], ['fly-jump', ['walk','fly','jump']], ['bounce',['walk','bounce']], ['finish',['walk']], ['launch',['launch']]]) {
  test(`accepted ${name} keeps the committed segments, points and landing order`, async () => {
    const { before, after } = await lesson(name), plan = flyingMotionPlan(before, after);
    assert.ok(plan); assert.deepEqual(plan.route.segments.map(segment => segment.kind), kinds);
    const path = flyingRoutePoints(plan);
    assert.deepEqual(path.landings.map(item => item.progress), plan.route.landings.map(item => item.progress));
    for (const segment of plan.route.segments) assert.equal(path.points.filter(point => point.kind === segment.kind).length, segment.steps.length + (['fly','jump','launch'].includes(segment.kind) ? 1 : 0));
    assert.equal(plan.route.finished, name === 'finish');
    assert.equal(before.game.planes.find(plane => plane.id === 'red-1').progress, plan.route.from);
  });
}
test('duplicates, refreshed gaps, manual baseline and changed role have no flight', async () => {
  const { before, after } = await lesson('fly-jump');
  assert.equal(flyingMotionPlan(after, after), null);
  assert.equal(flyingMotionPlan(before, after, { baseline: true }), null);
  assert.equal(flyingMotionPlan(before, { ...after, selfRole: 'spectator' }), null);
  const gap=structuredClone(after); gap.game.revision++; assert.equal(flyingMotionPlan(before,gap),null);
  assert.equal(flyingMotionPlan(before,{...after,phase:'paused'}),null);
});
test('collision uses each actual landing and returns the captured numbered plane', () => {
  let game=createGame(['one','two'],{firstPlayerIndex:0}), seed=5, pair=null;
  for(let index=0;index<100 && !pair;index++){
    seed=(seed*1664525+1013904223)>>>0;game=applyRoll(game,game.turnPlayerId,seed%6+1).state;
    if(game.stage!=='await-move')continue;
    const before=game;game=applyMove(game,game.turnPlayerId,{rollId:game.rollId,planeId:game.legalPlaneIds[index%game.legalPlaneIds.length]}).state;
    if(game.lastAction.route.capturedIds.length)pair={before,after:game};
  }
  assert.ok(pair);assert.equal(gameProblem(pair.before),null);assert.equal(gameProblem(pair.after),null);
  const base={roomId:'room',roomCode:'123456',matchId:'match',selfId:'one',selfRole:'player',phase:'playing'};
  const before={...base,game:pair.before}, after={...base,game:pair.after};
  const plan=flyingMotionPlan(before,after);assert.ok(plan);
  assert.deepEqual(plan.captured.map(plane=>plane.id),plan.route.capturedIds);
  assert.deepEqual(plan.route.landings.flatMap(landing=>landing.capturedIds),plan.route.capturedIds);
  for(const id of plan.route.capturedIds)assert.equal(after.game.planes.find(plane=>plane.id===id).progress,-2);
});
