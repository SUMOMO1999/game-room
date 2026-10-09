import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoker414PracticeSession, PRACTICE_SELF, PRACTICE_STORAGE_KEY,
  decodePoker414Practice, encodePoker414Practice } from './practice-engine.mjs';
import { createGame, advanceGame, applyAction, gameProblem, projectGame } from './rules.mjs';
import { choosePoker414BotAction } from './practice-bot.mjs';
import { chooseResponseCards } from './patterns.mjs';
import { getCard } from './cards.mjs';

function randomFor(seed) { return () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x100000000); }
function environment(seed = 11) {
  let wall = 0, id = 0, timerId = 0, chain = Promise.resolve();
  const values = new Map(), timers = new Map(), changes = [], writes = [];
  const storage = { getItem: key => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); writes.push(value); } };
  const withLock = callback => { const task = chain.then(callback); chain = task.catch(() => {}); return task; };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { values, timers, changes, writes, storage, withLock, random: randomFor(seed),
    requestId: () => `test-practice-${++id}`, now: () => wall, onChange: value => changes.push(value),
    setTimer(callback, delay) { const next = ++timerId; timers.set(next, { at: wall + delay, callback }); return next; },
    clearTimer: key => timers.delete(key),
    async step(ms) {
      const end = wall + ms;
      let iterations = 0;
      while (true) {
        await flush();
        const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > end) break;
        assert.ok(++iterations < 10000, 'bounded scheduled work');
        wall = entry[1].at; timers.delete(entry[0]); entry[1].callback();
      }
      wall = end; await flush();
    },
    jump(ms) { wall += ms; }, flush,
  };
}
const savedAt = env => decodePoker414Practice(env.values.get(PRACTICE_STORAGE_KEY));
const rejectsCode = (task, code) => assert.rejects(task, error => error.code === code);

function responseFixture({ computersCanRespond = false } = {}) {
  const ids = [PRACTICE_SELF, 'practice-bot-1', 'practice-bot-2'];
  for (let seed = 1; seed < 300; seed++) {
    let game = createGame({ players: ids, matchId: `response-${seed}`, random: randomFor(seed), now: 0, dealBatchSize: 18, dealIntervalMs: 250 });
    game = advanceGame(game, { now: 1500 }).state;
    if (game.turnPlayerId === PRACTICE_SELF) continue;
    const owner = game.players.find(player => player.id === game.turnPlayerId);
    for (const id of owner.hand) {
      const rank = getCard(id).rank;
      if (rank > 15 || !chooseResponseCards(game.players.find(player => player.id === PRACTICE_SELF).hand, rank, 'fork')) continue;
      const other = game.players.find(player => player.id !== PRACTICE_SELF && player.id !== owner.id);
      if (Boolean(chooseResponseCards(other.hand, rank, 'fork')) !== computersCanRespond) continue;
      const result = applyAction(game, { type: 'play', playerId: owner.id, matchId: game.matchId, roundId: 1, targetId: null, cardIds: [id] }, { now: 1500 });
      assert.equal(result.ok, true);
      return { version: 1, kind: 'poker414-local-practice', matchId: game.matchId, logicalNow: 1500, game: result.state };
    }
  }
  throw new Error('No valid human response fixture');
}

test('new practice deals all 108 real cards to 3–8 fixed local seats, exposing only self hand', async () => {
  const env = environment(), session = await createPoker414PracticeSession(env);
  assert.equal(session.snapshot().game.stage, 'dealing');
  assert.equal(session.snapshot().active, false);
  for (let count = 3; count <= 8; count++) {
    await session.restart({ playerCount: count });
    await session.setActive(true); await env.step(1500); await session.setActive(false);
    const view = session.snapshot(), saved = savedAt(env);
    assert.equal(view.players.length, count);
    assert.equal(view.game.stage, 'playing');
    assert.equal(view.game.deckCount, 0);
    assert.equal(saved.game.players.reduce((total, player) => total + player.hand.length, 0), 108);
    assert.equal(gameProblem(saved.game), null);
    assert.equal(view.game.players.filter(player => Object.hasOwn(player, 'hand')).length, 1);
    assert.deepEqual(view.game, projectGame(saved.game, { playerId: PRACTICE_SELF, role: 'player' }));
    assert.equal(Object.hasOwn(view.game, 'deck'), false);
    assert.equal(view.players.find(player => player.id === PRACTICE_SELF).name, '我');
  }
  await session.destroy();
});

test('real rules and projected computer choices finish a whole practice with no server or permanent ledger', async () => {
  const env = environment(79), session = await createPoker414PracticeSession(env);
  await session.setActive(true);
  for (let tick = 0; tick < 2400 && session.snapshot().game.status === 'playing'; tick++) {
    await env.step(250);
    const view = session.snapshot();
    const choice = choosePoker414BotAction(view.game, PRACTICE_SELF, { now: view.logicalNow });
    if (choice) await session.action(choice.type, choice.type === 'play' ? { cardIds: choice.cardIds } : {});
  }
  const view = session.snapshot();
  assert.equal(view.game.status, 'finished');
  assert.equal(view.game.result.reason, 'emptied-hand');
  assert.equal(view.game.result.deltas.reduce((total, item) => total + item.points, 0), 0);
  assert.equal(gameProblem(savedAt(env).game), null);
  assert.deepEqual([...env.values.keys()], [PRACTICE_STORAGE_KEY]);
  assert.equal(env.timers.size, 0);
  await rejectsCode(session.action('pass'), 'NOT_PLAYING');
  await session.destroy();
});

test('refresh resumes exact dealt cards and match without invoking random or cancelling the game', async () => {
  const env = environment(), first = await createPoker414PracticeSession(env);
  await first.setActive(true); await env.step(1500); await first.destroy();
  const before = savedAt(env), text = env.values.get(PRACTICE_STORAGE_KEY);
  env.jump(24 * 60 * 60 * 1000);
  const restored = await createPoker414PracticeSession({ ...env, random() { throw new Error('Must not shuffle again'); }, requestId() { throw new Error('Must not recreate'); } });
  assert.equal(restored.snapshot().matchId, before.matchId);
  assert.deepEqual(restored.snapshot().game, projectGame(before.game, { playerId: PRACTICE_SELF, role: 'player' }));
  assert.equal(restored.snapshot().logicalNow, before.logicalNow);
  assert.equal(env.values.get(PRACTICE_STORAGE_KEY), text);
  assert.equal(restored.snapshot().game.result, null);
  await restored.destroy();
});

test('human response gets all five seconds before an ordinary computer can replace the target', async () => {
  const env = environment(), fixture = responseFixture();
  env.values.set(PRACTICE_STORAGE_KEY, encodePoker414Practice(fixture));
  const session = await createPoker414PracticeSession(env);
  await session.setActive(true); await env.step(4900);
  assert.equal(session.snapshot().game.target.id, fixture.game.target.id);
  assert.ok(session.snapshot().game.responseWindow);
  assert.equal(session.snapshot().game.moves.length, 1);
  await session.action('fork');
  assert.equal(session.snapshot().game.moves.at(-1).type, 'fork');
  assert.equal(session.snapshot().game.moves.at(-1).playerId, PRACTICE_SELF);
  await session.destroy();
});

test('an eligible computer may compete only after two seconds, without revealing its hand', async () => {
  const env = environment(), fixture = responseFixture({ computersCanRespond: true });
  env.values.set(PRACTICE_STORAGE_KEY, encodePoker414Practice(fixture));
  const session = await createPoker414PracticeSession(env);
  await session.setActive(true); await env.step(1999);
  assert.equal(session.snapshot().game.moves.length, 1);
  await env.step(1);
  assert.equal(session.snapshot().game.moves.length, 2);
  assert.equal(session.snapshot().game.moves.at(-1).type, 'fork');
  assert.notEqual(session.snapshot().game.moves.at(-1).playerId, PRACTICE_SELF);
  assert.equal(session.snapshot().game.players.filter(player => player.hand).length, 1);
  await session.destroy();
});

test('background/modal pause and full reload retain the remaining response time, not wall-clock expiry', async () => {
  const env = environment(), fixture = responseFixture();
  env.values.set(PRACTICE_STORAGE_KEY, encodePoker414Practice(fixture));
  let session = await createPoker414PracticeSession(env);
  await session.setActive(true); await env.step(1800); await session.setActive(false);
  const paused = session.snapshot();
  assert.equal(paused.logicalNow, 3300);
  assert.equal(paused.game.responseWindow.deadlineAt - paused.logicalNow, 3200);
  assert.equal(env.timers.size, 0);
  await env.step(3600000);
  assert.equal(session.snapshot().logicalNow, 3300);
  await rejectsCode(session.action('fork'), 'PRACTICE_PAUSED');
  await session.destroy();
  session = await createPoker414PracticeSession(env);
  assert.equal(session.snapshot().logicalNow, 3300);
  await session.setActive(true); await env.step(3000);
  assert.equal(session.snapshot().game.responseWindow.deadlineAt - session.snapshot().logicalNow, 200);
  await env.step(200);
  assert.equal(session.snapshot().game.responseWindow, null);
  assert.equal(session.snapshot().game.moves.length, 1);
  await session.destroy();
});

test('unexpected timer suspension never fast-forwards the response or queues multiple computer actions', async () => {
  const env = environment(), fixture = responseFixture();
  env.values.set(PRACTICE_STORAGE_KEY, encodePoker414Practice(fixture));
  const session = await createPoker414PracticeSession(env);
  await session.setActive(true);
  const [id, task] = [...env.timers.entries()][0];
  env.timers.delete(id); env.jump(60000); task.callback(); await env.flush();
  assert.equal(session.snapshot().logicalNow, 1500);
  assert.equal(session.snapshot().game.target.id, fixture.game.target.id);
  await session.destroy();
});

test('unavailable storage or missing locks stays playable and explicitly unsaved', async () => {
  for (const unavailable of ['missing-lock', 'read-failure', 'write-failure']) {
    const env = environment();
    const options = { ...env };
    if (unavailable === 'missing-lock') options.withLock = null;
    if (unavailable === 'read-failure') options.storage = { ...env.storage, getItem() { throw new Error('blocked'); } };
    if (unavailable === 'write-failure') options.storage = { ...env.storage, setItem() { throw new Error('quota'); } };
    const session = await createPoker414PracticeSession(options);
    assert.equal(session.snapshot().storageAvailable, false);
    assert.match(session.snapshot().storageNote, /无法|不能/);
    await session.setActive(true); await env.step(1500);
    assert.equal(session.snapshot().game.stage, 'playing');
    await session.destroy();
  }
});

test('corrupt, unknown, duplicated-card and foreign-seat saves remain untouched until explicit restart', async () => {
  const fixture = responseFixture();
  const duplicated = structuredClone(fixture); duplicated.game.deck[0] = duplicated.game.deck[1];
  const foreign = structuredClone(fixture);
  foreign.game = createGame({ players: ['a', 'b', 'c'], matchId: fixture.matchId, random: randomFor(7), now: 0, dealBatchSize: 18, dealIntervalMs: 250 });
  for (const raw of ['{', JSON.stringify({ ...fixture, version: 999 }), JSON.stringify(duplicated), JSON.stringify(foreign)]) {
    const env = environment(); env.values.set(PRACTICE_STORAGE_KEY, raw);
    const session = await createPoker414PracticeSession(env);
    assert.equal(session.snapshot().requiresRestart, true);
    assert.equal(session.snapshot().game, null);
    assert.equal(env.values.get(PRACTICE_STORAGE_KEY), raw);
    await session.setActive(true); await env.step(5000);
    assert.equal(env.values.get(PRACTICE_STORAGE_KEY), raw);
    await session.restart({ playerCount: 4 });
    assert.equal(session.snapshot().requiresRestart, false);
    assert.equal(savedAt(env).game.players.length, 4);
    await session.destroy();
  }
});

test('two tabs cannot overwrite newer moves; the stale tab stops and can reload the shared save', async () => {
  const env = environment(), a = await createPoker414PracticeSession(env), b = await createPoker414PracticeSession(env);
  await a.setActive(true); await env.step(750); await a.setActive(false);
  const latest = env.values.get(PRACTICE_STORAGE_KEY);
  await rejectsCode(b.restart(), 'PRACTICE_CONFLICT');
  assert.equal(b.snapshot().conflict, true);
  assert.equal(env.values.get(PRACTICE_STORAGE_KEY), latest);
  await rejectsCode(b.restart(), 'PRACTICE_CONFLICT');
  await b.reload();
  assert.equal(b.snapshot().conflict, false);
  assert.equal(b.snapshot().matchId, a.snapshot().matchId);
  await b.setActive(true); await env.step(250); await b.setActive(false);
  assert.equal(b.snapshot().game.players.reduce((sum, player) => sum + player.handCount, 0), 72);
  await a.destroy(); await b.destroy();
});

test('destroy cancels timers, queued actions and callbacks while retaining the final local checkpoint', async () => {
  const env = environment(), session = await createPoker414PracticeSession(env);
  await session.setActive(true); await env.step(750);
  const finished = session.destroy();
  assert.equal(env.timers.size, 0);
  await finished;
  const text = env.values.get(PRACTICE_STORAGE_KEY), calls = env.changes.length;
  await env.step(20000);
  assert.equal(env.values.get(PRACTICE_STORAGE_KEY), text);
  assert.equal(env.changes.length, calls);
  await rejectsCode(session.restart(), 'PRACTICE_DESTROYED');
  await rejectsCode(session.action('pass'), 'PRACTICE_DESTROYED');
  await session.destroy();
});

test('invalid user fields cannot impersonate computers or inject a full action envelope', async () => {
  const env = environment(), session = await createPoker414PracticeSession(env);
  await session.setActive(true); await env.step(1500);
  await rejectsCode(session.action('pass', { playerId: 'practice-bot-1' }), 'PRACTICE_ACTION_INVALID');
  await rejectsCode(session.action('restart'), 'PRACTICE_ACTION_INVALID');
  await rejectsCode(session.action('play', { cardIds: [], matchId: 'other' }), 'PRACTICE_ACTION_INVALID');
  await rejectsCode(session.restart({ playerCount: 2 }), 'PRACTICE_PLAYERS_INVALID');
  await session.destroy();
});
