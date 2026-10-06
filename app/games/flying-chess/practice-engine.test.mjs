import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlyingPracticeSession, FLYING_PRACTICE_STORAGE_KEY,
  PRACTICE_LESSONS, decodeFlyingPractice, encodeFlyingPractice } from './practice-engine.mjs';
import { gameProblem } from './rules.mjs';
import { createFlyingChessAdapter } from '../../../server/games/flying-chess/adapter.mjs';

function environment() {
  const values = new Map(), reads = [], writes = [];
  const storage = { getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { writes.push(key); values.set(key, value); } };
  let queue = Promise.resolve();
  const withLock = callback => { const result = queue.then(callback); queue = result.catch(() => {}); return result; };
  let nextId = 1;
  return { values, reads, writes, storage, withLock, randomInt: () => 0, requestId: () => `practice-${nextId++}` };
}
const rawGame = (env, key = FLYING_PRACTICE_STORAGE_KEY) => decodeFlyingPractice(env.values.get(key)).game;
const rejectsCode = (operation, code) => assert.rejects(operation, failure => failure.code === code);

test('2/3/4 hot-seat practice uses complete real allocations and matching server projections', async () => {
  for (const count of [2, 3, 4]) {
    const env = environment(), session = await createFlyingPracticeSession(env);
    await session.restart({ playerCount: count });
    const view = session.view();
    assert.deepEqual(view.players.map(player => player.side), count === 2 ? ['red', 'yellow']
      : count === 3 ? ['red', 'blue', 'yellow'] : ['red', 'blue', 'yellow', 'green']);
    assert.equal(view.game.planes.length, count * 4);
    assert.equal(view.selfId, view.game.turnPlayerId);
    assert.equal(view.selfRole, 'player');
    assert.equal(view.practice, true);
    assert.equal(view.storageAvailable, true);
    assert.equal(gameProblem(rawGame(env)), null);
    assert.deepEqual(createFlyingChessAdapter().privateView(rawGame(env), view.selfId), view.game);
    assert.ok(view.players.every(player => player.name.includes('本机')));
  }
});

test('refresh restores confirmed die and legal route without re-rolling or replaying any action', async () => {
  const env = environment();
  let randomCalls = 0;
  const session = await createFlyingPracticeSession({ ...env, randomInt: maximum => { randomCalls++; return maximum === 6 ? 5 : 0; } });
  const roll = await session.action('roll');
  assert.equal(roll.game.die, 6); assert.equal(randomCalls, 2);
  const before = env.values.get(FLYING_PRACTICE_STORAGE_KEY), writes = env.writes.length;
  const restored = await createFlyingPracticeSession({ ...env, randomInt: () => { throw new Error('Must not re-roll'); },
    requestId: () => { throw new Error('Must not start fresh'); } });
  assert.deepEqual(restored.view(), session.view());
  assert.equal(env.writes.length, writes);
  assert.equal(env.values.get(FLYING_PRACTICE_STORAGE_KEY), before);
  const moved = await restored.action('move', { rollId: roll.game.rollId, planeId: 'red-1' });
  assert.equal(moved.game.planes[0].progress, -1);
  assert.equal(moved.game.stage, 'await-roll');
  assert.equal(moved.game.round, 1);
  assert.equal(moved.game.lastAction.outcome, 'six-again');
});

test('all fixed lessons have valid replayed core state and consume real rules once', async () => {
  const env = environment(), session = await createFlyingPracticeSession(env);
  const expected = {
    launch: { to: -1, kinds: ['launch'] },
    'no-action': null,
    'jump-fly': { to: 29, kinds: ['walk', 'jump', 'fly'] },
    'fly-jump': { to: 33, kinds: ['walk', 'fly', 'jump'] },
    bounce: { to: 53, kinds: ['walk', 'bounce'] },
    finish: { to: 55, kinds: ['walk'] },
  };
  for (const lesson of PRACTICE_LESSONS) {
    await session.restart({ lesson: lesson.id });
    assert.equal(gameProblem(rawGame(env)), null);
    assert.equal(session.view().lessonLabel, lesson.label);
    const rolled = await session.action('roll');
    assert.equal(gameProblem(rawGame(env)), null);
    assert.equal(rolled.game.lastAction.legalPlaneIds.length, 0);
    if (expected[lesson.id] === null) {
      assert.equal(rolled.game.lastAction.die, 5);
      assert.equal(rolled.game.lastAction.outcome, 'no-move');
      assert.equal(rolled.game.stage, 'await-roll');
      assert.equal(rolled.selfId, rolled.players[1].id);
      continue;
    }
    const route = rolled.game.legalMoves.find(move => move.planeId === 'red-1');
    assert.equal(route.to, expected[lesson.id].to);
    assert.deepEqual(route.segments.map(segment => segment.kind), expected[lesson.id].kinds);
    const moved = await session.action('move', { rollId: rolled.game.rollId, planeId: 'red-1' });
    assert.equal(moved.game.planes[0].progress, route.to);
    assert.equal(gameProblem(rawGame(env)), null);
    assert.equal(moved.game.lastAction.route.to, route.to);
    if (lesson.id === 'finish') assert.ok(!moved.game.legalPlaneIds.includes('red-1'));
  }
});

test('teaching dice cursor persists across refresh; teaching never uses ordinary random', async () => {
  const env = environment(), session = await createFlyingPracticeSession(env);
  await session.restart({ lesson: 'bounce' });
  let restored = await createFlyingPracticeSession({ ...env, randomInt: () => { throw new Error('Teaching is fixed'); } });
  const rolled = await restored.action('roll'); assert.equal(rolled.game.die, 4);
  restored = await createFlyingPracticeSession({ ...env, randomInt: () => { throw new Error('Teaching is fixed'); } });
  await restored.action('move', { rollId: rolled.game.rollId, planeId: 'red-1' });
  const next = await restored.action('roll');
  assert.equal(next.game.die, 6);
  assert.equal(next.selfId, next.players[1].id);
});

test('complete local four-plane game reaches true victory and freezes further actions', async () => {
  const env = environment(), dice = [];
  for (let plane = 1; plane <= 4; plane++) for (const die of [6, 5, 5, 4, 4, 4, 6]) {
    dice.push(die); if (die !== 6) dice.push(1);
  }
  const session = await createFlyingPracticeSession({ ...env, randomInt: maximum => maximum === 2 ? 0 : dice.shift() - 1 });
  for (let plane = 1; plane <= 4; plane++) for (const die of [6, 5, 5, 4, 4, 4, 6]) {
    const rolled = await session.action('roll');
    assert.equal(rolled.game.die, die);
    const moved = await session.action('move', { rollId: rolled.game.rollId, planeId: `red-${plane}` });
    assert.equal(gameProblem(rawGame(env)), null);
    if (die !== 6) {
      const other = await session.action('roll');
      assert.equal(other.game.lastAction.outcome, 'no-move');
      assert.equal(other.game.lastAction.die, 1);
    } else if (plane === 4 && moved.phase === 'finished') {
      assert.equal(moved.game.result.winnerIds[0], moved.players[0].id);
      assert.deepEqual(moved.game.result.completedCounts.map(item => item.completed), [4, 0]);
      assert.equal(moved.game.canRoll, false);
    }
  }
  assert.equal(dice.length, 0);
  assert.equal(session.view().phase, 'finished');
  const before = env.values.get(FLYING_PRACTICE_STORAGE_KEY);
  await rejectsCode(session.action('roll'), 'PRACTICE_ACTION_INVALID');
  assert.equal(env.values.get(FLYING_PRACTICE_STORAGE_KEY), before);
  const restored = await createFlyingPracticeSession({ ...env, randomInt: () => { throw new Error('Finished is not restarted'); } });
  assert.deepEqual(restored.view(), session.view());
});

test('corrupt and unsupported saves are preserved until explicit restart, never guessed or auto-replaced', async () => {
  const validEnv = environment(); await createFlyingPracticeSession(validEnv);
  const valid = JSON.parse(validEnv.values.get(FLYING_PRACTICE_STORAGE_KEY));
  for (const corrupt of ['{', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, foreign: true }),
    JSON.stringify({ ...valid, game: { ...valid.game, planes: valid.game.planes.map((plane, index) => ({ ...plane, progress: index === 0 ? 11 : plane.progress })) } }),
    JSON.stringify({ ...valid, game: { ...valid.game, boardVersion: 'unknown' } }),
    JSON.stringify({ ...valid, lesson: 'missing-lesson' }),
    JSON.stringify({ ...valid, game: { ...valid.game, players: valid.game.players.map(player => ({ ...player, id: `stranger-${player.id}` })) } })]) {
    const env = environment(); env.values.set(FLYING_PRACTICE_STORAGE_KEY, corrupt);
    const session = await createFlyingPracticeSession({ ...env, randomInt: () => 0 });
    assert.equal(session.view().phase, 'invalid'); assert.equal(session.view().game, null);
    assert.equal(session.view().requiresRestart, true);
    assert.equal(env.writes.length, 0); assert.equal(env.values.get(FLYING_PRACTICE_STORAGE_KEY), corrupt);
    await rejectsCode(session.action('roll'), 'PRACTICE_SAVE_INVALID');
    await session.restart({ playerCount: 3 });
    assert.equal(session.view().phase, 'playing'); assert.equal(session.view().players.length, 3);
    assert.equal(gameProblem(rawGame(env)), null);
  }
});

test('strict codec rejects wrong envelopes and impossible final-action data', async () => {
  const env = environment(), session = await createFlyingPracticeSession(env);
  await session.restart({ lesson: 'jump-fly' }); await session.action('roll');
  const valid = JSON.parse(env.values.get(FLYING_PRACTICE_STORAGE_KEY));
  assert.equal(encodeFlyingPractice(decodeFlyingPractice(JSON.stringify(valid))), JSON.stringify(valid));
  for (const corrupt of [{ ...valid, kind: 'official-room' }, { ...valid, matchId: ' bad id ' },
    { ...valid, lessonRollIndex: -1 }, { ...valid, lessonRollIndex: Number.MAX_SAFE_INTEGER },
    { ...valid, game: { ...valid.game, die: 8 } },
    { ...valid, game: { ...valid.game, lastAction: { ...valid.game.lastAction, die: 6 } } }]) {
    assert.equal(decodeFlyingPractice(JSON.stringify(corrupt)), null);
    assert.throws(() => encodeFlyingPractice(corrupt), failure => failure.code === 'PRACTICE_SAVE_INVALID');
  }
  assert.equal(decodeFlyingPractice(' '.repeat(65537)), null);
});

test('same-key tabs cannot overwrite another confirmed move; reload is explicit and never acts', async () => {
  const env = environment(), options = { ...env, randomInt: maximum => maximum === 6 ? 5 : 0 };
  const first = await createFlyingPracticeSession(options), second = await createFlyingPracticeSession(options);
  const rolled = await first.action('roll');
  const stored = env.values.get(FLYING_PRACTICE_STORAGE_KEY), writes = env.writes.length;
  await rejectsCode(second.action('roll'), 'PRACTICE_CONFLICT');
  assert.equal(second.view().practiceConflict, true); assert.equal(second.view().game.canRoll, false);
  await rejectsCode(second.restart(), 'PRACTICE_CONFLICT');
  assert.equal(env.values.get(FLYING_PRACTICE_STORAGE_KEY), stored);
  assert.equal(env.writes.length, writes);
  const reloaded = await second.reload();
  assert.equal(reloaded.game.die, 6); assert.equal(reloaded.practiceConflict, false);
  assert.equal(env.writes.length, writes);
  const moved = await second.action('move', { rollId: rolled.game.rollId, planeId: 'red-2' });
  assert.equal(moved.game.planes[1].progress, -1);
  await rejectsCode(first.action('move', { rollId: rolled.game.rollId, planeId: 'red-1' }), 'PRACTICE_CONFLICT');
  assert.equal(rawGame(env).planes[0].progress, -2); assert.equal(rawGame(env).planes[1].progress, -1);
});

test('two simultaneous initializations produce one confirmed match, not last-writer replacement', async () => {
  const env = environment(); let randomCalls = 0;
  const sessions = await Promise.all([createFlyingPracticeSession({ ...env, randomInt: () => { randomCalls++; return 0; } }),
    createFlyingPracticeSession({ ...env, randomInt: () => { randomCalls++; return 0; } })]);
  assert.equal(randomCalls, 1); assert.equal(env.writes.length, 1);
  assert.deepEqual(sessions[0].view(), sessions[1].view());
});

test('duplicate in-flight roll and delayed actions after destroy never sample or move', async () => {
  const env = environment(); let release, armed = false, calls = 0;
  const withLock = callback => armed ? new Promise(resolve => { release = resolve; }).then(callback) : Promise.resolve().then(callback);
  const session = await createFlyingPracticeSession({ ...env, withLock, randomInt: maximum => { calls++; return maximum === 6 ? 5 : 0; } });
  armed = true;
  const pending = session.action('roll');
  await rejectsCode(session.action('roll'), 'PRACTICE_BUSY');
  assert.equal(calls, 1); release(); await pending;
  assert.equal(calls, 2); assert.equal(session.view().game.die, 6);
  const pendingMove = session.action('move', { rollId: session.view().game.rollId, planeId: 'red-1' });
  session.destroy(); release();
  await rejectsCode(pendingMove, 'PRACTICE_DESTROYED');
  assert.equal(rawGame(env).planes[0].progress, -2);
  await rejectsCode(session.action('roll'), 'PRACTICE_DESTROYED');
});

test('storage denied, unavailable or lacking lock stays usable but explicitly unsaved', async () => {
  const env = environment();
  const throwingRead = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('Must not write'); } };
  for (const options of [{ ...env, storage: null }, { ...env, storage: throwingRead },
    { storage: env.storage, withLock: null, randomInt: () => 0, requestId: () => 'no-lock' }]) {
    const session = await createFlyingPracticeSession(options);
    assert.equal(session.view().storageAvailable, false); assert.match(session.view().storageNote, /不会保存|无法保存/);
    const rolled = await session.action('roll');
    assert.equal(rolled.game.lastAction.outcome, 'no-move');
    assert.equal(rolled.game.lastAction.die, 1);
    assert.equal(rolled.game.round, 2);
  }
  assert.equal(env.values.size, 0);
});

test('mid-game write failure continues local practice with clear save-loss notice and preserves old stored state', async () => {
  const env = environment(); let denied = false;
  const storage = { getItem: env.storage.getItem, setItem(key, value) { if (denied) throw new Error('Quota'); env.storage.setItem(key, value); } };
  const session = await createFlyingPracticeSession({ ...env, storage, randomInt: maximum => maximum === 6 ? 5 : 0 });
  const initial = env.values.get(FLYING_PRACTICE_STORAGE_KEY); denied = true;
  const rolled = await session.action('roll');
  assert.equal(rolled.game.die, 6); assert.equal(rolled.storageAvailable, false);
  assert.match(rolled.storageNote, /无法保存/);
  assert.equal(env.values.get(FLYING_PRACTICE_STORAGE_KEY), initial);
  const moved = await session.action('move', { rollId: rolled.game.rollId, planeId: 'red-1' });
  assert.equal(moved.game.planes[0].progress, -1); assert.equal(moved.storageAvailable, false);
});

test('invalid actions, random values and stale dice do not modify stored progress', async () => {
  const env = environment(); let calls = 0, bad = false;
  const session = await createFlyingPracticeSession({ ...env, randomInt: maximum => { calls++; return bad ? 6 : maximum === 6 ? 5 : 0; } });
  const before = env.values.get(FLYING_PRACTICE_STORAGE_KEY);
  for (const [type, fields] of [['roll', { die: 6 }], ['select', {}], ['cancel', {}], ['move', { rollId: 1, planeId: 'red-1', foreign: true }]]) {
    await rejectsCode(session.action(type, fields), 'PRACTICE_ACTION_INVALID');
    assert.equal(env.values.get(FLYING_PRACTICE_STORAGE_KEY), before);
  }
  assert.equal(calls, 1); bad = true;
  await rejectsCode(session.action('roll'), 'PRACTICE_RANDOM_INVALID');
  assert.equal(env.values.get(FLYING_PRACTICE_STORAGE_KEY), before); bad = false;
  const rolled = await session.action('roll'), current = env.values.get(FLYING_PRACTICE_STORAGE_KEY);
  await rejectsCode(session.action('roll'), 'PRACTICE_ACTION_INVALID');
  await rejectsCode(session.action('move', { rollId: rolled.game.rollId + 1, planeId: 'red-1' }), 'PRACTICE_ACTION_INVALID');
  await rejectsCode(session.action('move', { rollId: rolled.game.rollId, planeId: 'yellow-1' }), 'PRACTICE_ACTION_INVALID');
  assert.equal(env.values.get(FLYING_PRACTICE_STORAGE_KEY), current);
});

test('views are copies; subscription observes only confirmations and destroy releases listeners', async () => {
  const env = environment(), session = await createFlyingPracticeSession(env), seen = [];
  const unsubscribe = session.subscribe(view => { seen.push(view.revision); view.game.planes[0].progress = 55; });
  assert.deepEqual(seen, [0]); assert.equal(session.view().game.planes[0].progress, -2);
  await session.action('roll'); assert.deepEqual(seen, [0, 1]);
  unsubscribe(); await session.action('roll'); assert.deepEqual(seen, [0, 1]);
  session.destroy(); assert.equal(session.view().game.canRoll, false);
  assert.equal(gameProblem(rawGame(env)), null);
});

test('practice key never reads or changes official room, account or other-game storage', async () => {
  const env = environment(), unrelated = new Map([
    ['game-room:account', 'identity-do-not-touch'], ['game-room:rooms', 'room-do-not-touch'],
    ['army-local-practice', 'army-do-not-touch'], ['rummikub:practice', 'tiles-do-not-touch'],
  ]);
  for (const [key, value] of unrelated) env.values.set(key, value);
  const session = await createFlyingPracticeSession(env); await session.action('roll');
  await session.restart({ playerCount: 4 });
  assert.ok(env.reads.every(key => key === FLYING_PRACTICE_STORAGE_KEY));
  assert.ok(env.writes.every(key => key === FLYING_PRACTICE_STORAGE_KEY));
  for (const [key, value] of unrelated) assert.equal(env.values.get(key), value);
});
