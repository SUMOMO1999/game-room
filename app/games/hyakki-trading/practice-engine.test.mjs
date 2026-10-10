import test from 'node:test';
import assert from 'node:assert/strict';
import { createHyakkiPracticeSession, PRACTICE_SELF, PRACTICE_BOT, PRACTICE_STORAGE_KEY,
  encodeHyakkiPractice, decodeHyakkiPractice } from './practice-engine.mjs';
import { chooseHyakkiPracticeAction } from './practice-bot.mjs';
import { createGame, applyGameAction, gameProblem, currentDecision } from './rules.mjs';
import { privateView } from './view.mjs';
import { definition, refreshTemporary } from './model.mjs';
import { createDeck, GOODS } from './content/definitions.mjs';

const ids = [PRACTICE_SELF, PRACTICE_BOT], ctx = { now: 0, randomInt: limit => limit - 1 };
const flush = () => new Promise(resolve => setImmediate(resolve));
function environment(seed = 7) {
  let wall = 0, id = 0, timerId = 0, chain = Promise.resolve(), running = true;
  const values = new Map(), timers = new Map(), changes = [], writes = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem(key, value) { values.set(key, value); writes.push(value); } };
  const withLock = callback => { const task = chain.then(callback); chain = task.catch(() => {}); return task; };
  return { values, timers, changes, writes, storage, withLock, seed, requestId: () => (++id).toString(16).padStart(32, '0'),
    now: () => wall, canRun: () => running, run: value => { running = value; }, onChange: value => changes.push(value),
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { at: wall + delay, callback }); return id; },
    clearTimer: id => timers.delete(id), jump: ms => { wall += ms; }, flush,
    async step(ms) {
      const end = wall + ms; let runs = 0;
      while (true) {
        await flush(); const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > end) break;
        assert.ok(++runs <= 10000, 'bounded timer work'); wall = entry[1].at; timers.delete(entry[0]); entry[1].callback();
      }
      wall = end; await flush();
    },
  };
}
const savedAt = env => decodeHyakkiPractice(env.values.get(PRACTICE_STORAGE_KEY));
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
const fields = command => Object.fromEntries(Object.entries(command).filter(([key]) => !['type', 'matchId', 'turnId', 'expectedRevision', 'effectId', 'decisionId'].includes(key)));
function savedGame(game, logicalNow = 0) {
  return { version: 1, kind: 'hyakki-local-practice', matchId: game.matchId, logicalNow, rngState: 42, game };
}
function fixture(code, { ownerId = PRACTICE_SELF, full = false } = {}) {
  const state = createGame(ids, { ...ctx, matchId: 'c'.repeat(32), firstPlayerId: ownerId });
  state.deck.push(...state.players.flatMap(owner => owner.hand)); state.deck.sort(); state.players.forEach(owner => { owner.hand = []; });
  state.stage = 'use'; state.drawStarted = true;
  const owner = state.players.find(player => player.id === ownerId), peer = state.players.find(player => player.id !== ownerId);
  const take = target => { const at = state.deck.findIndex(card => definition(card).sourceCode === target); assert.ok(at >= 0); return state.deck.splice(at, 1)[0]; };
  const cardId = take(code);
  if (code.startsWith('T')) owner.tools.push({ cardId, exhausted: false }); else owner.hand.push(cardId);
  peer.hand.push(take('G02')); owner.hand.push(take('G01'));
  if (full) { owner.goods.firearms = 5; state.bankGoods.firearms -= 5; owner.silver = 0; refreshTemporary(owner); }
  const result = applyGameAction(state, owner.id, { type: code.startsWith('T') ? 'activate-tool' : 'play-character', cardId,
    matchId: state.matchId, turnId: state.turnId }, ctx);
  assert.equal(result.ok, true, result.error); return result.state;
}
function applyDefault(state) {
  const actor = currentDecision(state)?.actorId ?? state.turnPlayerId;
  const command = chooseHyakkiPracticeAction(privateView(state, actor), actor, { now: 0 });
  assert.ok(command); const result = applyGameAction(state, actor, command, ctx);
  assert.equal(result.ok, true, result.error); return result.state;
}
function conserved(game) {
  assert.equal(gameProblem(game), null);
  assert.deepEqual([...game.deck, ...game.discard, ...game.players.flatMap(owner => [...owner.hand, ...owner.tools.map(tool => tool.cardId)]),
    ...(game.pending?.sourceCards ?? []), ...(game.pending?.poolCards ?? [])].sort(), createDeck().map(card => card.id).sort());
  for (const good of GOODS) assert.equal(game.bankGoods[good.id] + game.players.reduce((sum, owner) => sum + owner.goods[good.id], 0)
    + (game.pending?.goods[good.id] ?? 0), game.goodsPerType ?? 6);
  assert.equal(game.availableStalls + game.players.reduce((sum, owner) => sum + owner.stallCount, 0), 5);
}

test('new practice is paused, contains real materials and exposes exactly the human hand', async () => {
  const env = environment(), session = await createHyakkiPracticeSession(env);
  const view = session.snapshot(), saved = savedAt(env);
  assert.equal(view.game.actionLimit, 5); assert.equal(view.game.goodsPerType, 8);
  conserved(saved.game); assert.equal(saved.game.deck.length, 100); assert.equal(view.active, false); assert.equal(view.game.clock.paused, true);
  assert.equal(view.players.length, 2); assert.equal(view.selfId, PRACTICE_SELF);
  assert.equal(view.game.players.filter(owner => owner.hand).length, 1);
  assert.equal(Object.hasOwn(view.game, 'deck'), false); assert.equal(Object.hasOwn(view.game, 'lifecycle'), false);
  assert.equal(env.timers.size, 0); assert.deepEqual([...env.values.keys()], [PRACTICE_STORAGE_KEY]);
  for (const actionLimit of [1, 5, 10]) { await session.restart({ actionLimit }); assert.equal(savedAt(env).game.actionLimit, actionLimit); }
  await rejects(session.restart({ actionLimit: 0 }), 'PRACTICE_OPTIONS_INVALID'); await session.destroy();
});

test('legacy six-goods practice restores untouched, while only explicit restart takes new configured stock', async () => {
  const env = environment(), game = createGame(ids, { ...ctx, matchId: 'd'.repeat(32), actionLimit: 7, goodsPerType: 6 });
  delete game.goodsPerType;
  const pending = applyGameAction(game, PRACTICE_SELF, { type: 'peek', matchId: game.matchId, turnId: game.turnId }, ctx);
  assert.equal(pending.ok, true, pending.error);
  const original = encodeHyakkiPractice(savedGame(pending.state)); env.values.set(PRACTICE_STORAGE_KEY, original);
  const session = await createHyakkiPracticeSession({ ...env, actionLimit: 1, goodsPerType: 20 });
  assert.equal(session.snapshot().game.actionLimit, 7); assert.equal(session.snapshot().game.goodsPerType, 6);
  assert.equal(env.values.get(PRACTICE_STORAGE_KEY), original); assert.deepEqual(savedAt(env).game.pending, pending.state.pending);
  await session.action('keep-peek'); assert.equal(Object.hasOwn(savedAt(env).game, 'goodsPerType'), false); conserved(savedAt(env).game);
  for (const goodsPerType of [4, 8, 20]) {
    await session.restart({ actionLimit: 3, goodsPerType });
    const before = env.values.get(PRACTICE_STORAGE_KEY);
    assert.equal(savedAt(env).game.goodsPerType, goodsPerType); assert.equal(savedAt(env).game.actionLimit, 3); conserved(savedAt(env).game);
    await session.reload(); assert.equal(env.values.get(PRACTICE_STORAGE_KEY), before);
  }
  const before = env.values.get(PRACTICE_STORAGE_KEY);
  for (const options of [{ goodsPerType: 3 }, { goodsPerType: 21 }, { goodsPerType: '8' }, { goodsPerType: null }, { unexpected: 8 }]) {
    await rejects(session.restart(options), 'PRACTICE_OPTIONS_INVALID'); assert.equal(env.values.get(PRACTICE_STORAGE_KEY), before);
  }
  await session.restart(); assert.equal(session.snapshot().game.goodsPerType, 8); assert.equal(session.snapshot().game.actionLimit, 5);
  await session.destroy();
});

test('paused decision dialog accepts an explicit human action and never wakes the computer', async () => {
  const env = environment(), game = fixture('M04'); env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(savedGame(game)));
  const session = await createHyakkiPracticeSession(env);
  await rejects(session.action('decline-response'), 'WRONG_ACTOR');
  assert.equal(session.snapshot().active, false); assert.equal(env.timers.size, 0);
  await session.setActive(true); await env.step(700); await session.setActive(false);
  // M04 lets the opponent choose; take a separately saved own C02 dialog.
  env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(savedGame(fixture('C02')))); await session.reload();
  const view = session.snapshot(), command = chooseHyakkiPracticeAction(view.game, PRACTICE_SELF, { now: view.logicalNow, allowPaused: true });
  assert.equal(command.type, 'choose-effect'); await session.action(command.type, fields(command));
  assert.equal(session.snapshot().active, false); assert.equal(session.snapshot().game.pending, null); assert.equal(env.timers.size, 0);
  await session.destroy();
});

for (const code of ['C02', 'T01', 'T04', 'M02', 'M07', 'C09', 'C12']) test(`${code}: reload retains exact pending materials, choices and saved random state`, async () => {
  const env = environment(); let game = fixture(code);
  if (game.pending.response) game = applyDefault(game);
  env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(savedGame(game)));
  const first = await createHyakkiPracticeSession(env); const before = first.snapshot(); await first.destroy();
  const text = env.values.get(PRACTICE_STORAGE_KEY); env.jump(86400000);
  const restored = await createHyakkiPracticeSession({ ...env, seed: 0, requestId() { throw new Error('must not recreate'); } });
  assert.deepEqual(restored.snapshot().game, before.game); assert.equal(restored.snapshot().logicalNow, 0);
  assert.equal(env.values.get(PRACTICE_STORAGE_KEY), text); assert.equal(savedAt(env).rngState, 42);
  if (restored.snapshot().game.pending.actorId === PRACTICE_SELF) {
    const command = chooseHyakkiPracticeAction(restored.snapshot().game, PRACTICE_SELF, { allowPaused: true });
    await restored.action(command.type, fields(command)); conserved(savedAt(env).game);
  } else { await restored.setActive(true); await env.step(700); conserved(savedAt(env).game); }
  await restored.destroy();
});

test('goods retention receipt survives reload and the projected default remains a legal bot choice', async () => {
  const env = environment(); let game = fixture('C01', { full: true });
  const view = privateView(game, PRACTICE_SELF), command = chooseHyakkiPracticeAction(view, PRACTICE_SELF);
  const branch = view.pending.choice.options.find(option => option.branch === 'goods');
  assert.ok(branch); game = applyGameAction(game, PRACTICE_SELF, { ...command, selection: branch }, ctx).state;
  while (!game.pending.receipt) game = applyDefault(game);
  env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(savedGame(game)));
  const session = await createHyakkiPracticeSession(env), before = session.snapshot(); await session.destroy();
  const restored = await createHyakkiPracticeSession(env); assert.deepEqual(restored.snapshot().game, before.game);
  const choice = chooseHyakkiPracticeAction(restored.snapshot().game, PRACTICE_SELF, { allowPaused: true });
  await restored.action(choice.type, fields(choice)); conserved(savedAt(env).game); assert.equal(savedAt(env).game.pending, null);
  await restored.destroy();
});

test('response pause freezes both active and decision clocks across a day and a reload', async () => {
  const env = environment(), game = fixture('M07', { ownerId: PRACTICE_BOT });
  env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(savedGame(game)));
  let session = await createHyakkiPracticeSession(env);
  await session.setActive(true); await env.step(1500); await session.setActive(false);
  const before = savedAt(env), view = session.snapshot(); assert.equal(view.game.clock.kind, 'decision');
  assert.equal(view.game.clock.remainingMs, 58500); assert.equal(before.game.timing.active.deadlineAt, null);
  await session.destroy(); env.jump(86400000); session = await createHyakkiPracticeSession(env);
  assert.deepEqual(savedAt(env), before); assert.equal(session.snapshot().game.clock.remainingMs, 58500);
  assert.equal(session.snapshot().game.clock.paused, true);
  await session.action('decline-response');
  assert.equal(savedAt(env).game.timing.active.deadlineAt, 1500 + before.game.timing.active.remainingMs);
  assert.equal(session.snapshot().active, false); await session.destroy();
});

test('active timeout uses the real default exactly once, then preserves the next decision window', async () => {
  const env = environment(), game = fixture('M04', { ownerId: PRACTICE_BOT });
  const saved = savedGame(game, 59900); env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(saved));
  const session = await createHyakkiPracticeSession(env); await session.setActive(true); await env.step(100);
  const current = savedAt(env).game; assert.equal(current.revision, game.revision + 1); assert.equal(current.pending.choice.kind, 'tribute-branch');
  assert.equal(current.pending.choice.actorId, PRACTICE_SELF); assert.equal(current.timing.decision.deadlineAt, 120000);
  assert.equal(session.snapshot().game.clock.remainingMs, 60000); await session.destroy();
});

test('sleeping device and inactive host do not fast-forward timers or replay computer actions', async () => {
  const env = environment(), game = fixture('M04'); env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(savedGame(game)));
  const session = await createHyakkiPracticeSession(env); await session.setActive(true);
  const callback = [...env.timers.values()][0].callback; env.timers.clear(); env.jump(3600000); callback(); await flush();
  assert.equal(session.snapshot().logicalNow, 0); assert.equal(savedAt(env).game.revision, game.revision);
  env.run(false); await env.step(250); assert.equal(session.snapshot().active, false); assert.equal(env.timers.size, 0);
  env.run(true); await session.setActive(true); await env.step(700);
  assert.equal(savedAt(env).game.revision, game.revision + 1); await session.destroy();
});

test('queued duplicate human commands retain the viewed revision and cannot spend the next step', async () => {
  const env = environment(); const game = createGame(ids, { ...ctx, matchId: 'd'.repeat(32) });
  env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(savedGame(game)));
  const session = await createHyakkiPracticeSession(env);
  await rejects(session.action('__proto__'), 'PRACTICE_ACTION_INVALID');
  await rejects(session.action('peek', { game }), 'PRACTICE_ACTION_INVALID');
  await rejects(session.action('peek', { expectedRevision: 0 }), 'PRACTICE_ACTION_INVALID');
  const results = await Promise.allSettled([session.action('finish-draw'), session.action('finish-draw')]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'STALE_ACTION');
  assert.equal(savedAt(env).game.revision, 1); await session.destroy();
});

test('two local pages cannot overwrite a changed save; reload is explicit and paused', async () => {
  const env = environment(), game = createGame(ids, { ...ctx, matchId: 'd'.repeat(32) });
  env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(savedGame(game)));
  const first = await createHyakkiPracticeSession(env), second = await createHyakkiPracticeSession(env);
  await first.action('finish-draw'); const text = env.values.get(PRACTICE_STORAGE_KEY);
  await rejects(second.action('peek'), 'PRACTICE_CONFLICT'); assert.equal(env.values.get(PRACTICE_STORAGE_KEY), text);
  assert.equal(second.snapshot().conflict, true); await second.reload(); assert.equal(second.snapshot().conflict, false);
  assert.equal(second.snapshot().active, false); assert.equal(second.snapshot().game.stage, 'use');
  await second.action('end-turn'); await rejects(first.action('end-turn'), 'PRACTICE_CONFLICT');
  await first.destroy(); await second.destroy();
});

test('invalid versions, duplicate material, foreign identity and unsupported saves are preserved until explicit restart', async () => {
  const game = createGame(ids, { ...ctx, matchId: 'd'.repeat(32) }), valid = savedGame(game);
  for (const mutate of [value => { value.version = 2; }, value => { value.game.deck[0] = value.game.deck[1]; },
    value => { value.rngState = 0; }, value => { value.extra = true; }, value => { value.game.players[0].id = 'e'.repeat(32); }]) {
    const env = environment(), changed = structuredClone(valid); mutate(changed); const text = JSON.stringify(changed);
    assert.equal(decodeHyakkiPractice(text), null); env.values.set(PRACTICE_STORAGE_KEY, text);
    const session = await createHyakkiPracticeSession(env); assert.equal(session.snapshot().requiresRestart, true);
    await rejects(session.action('peek'), 'PRACTICE_SAVE_INVALID'); assert.equal(env.values.get(PRACTICE_STORAGE_KEY), text);
    await session.restart(); assert.equal(session.snapshot().requiresRestart, false); conserved(savedAt(env).game); await session.destroy();
  }
  assert.equal(decodeHyakkiPractice('x'.repeat(524289)), null); assert.equal(decodeHyakkiPractice('{'), null);
});

test('missing lock and read/write failures are explicitly unsaved; game remains playable', async () => {
  for (const options of [{ withLock: null }, { storage: { getItem() { throw new Error('denied'); }, setItem() {} } },
    { storage: { getItem: () => null, setItem() { throw new Error('full'); } } }, { withLock() { throw new Error('lock unavailable'); } }]) {
    const env = environment(), session = await createHyakkiPracticeSession({ ...env, ...options });
    assert.equal(session.snapshot().storageAvailable, false); assert.match(session.snapshot().storageNote, /不能恢复|此前成功|无法继续保存/);
    await session.setActive(true); await env.step(700); assert.equal(session.snapshot().requiresRestart, false);
    await session.restart({ actionLimit: 1 }); assert.equal(session.snapshot().game.actionLimit, 1); await session.destroy();
  }
});

test('rejected command cannot advance saved random state; restoration reproduces the next shuffle', async () => {
  const env = environment(), game = createGame(ids, { ...ctx, matchId: 'd'.repeat(32) });
  game.discard.push(...game.deck.splice(0)); const value = savedGame(game);
  env.values.set(PRACTICE_STORAGE_KEY, encodeHyakkiPractice(value));
  const session = await createHyakkiPracticeSession(env), before = env.values.get(PRACTICE_STORAGE_KEY);
  await rejects(session.action('buy', { cardId: 'bad' }), 'ILLEGAL_ACTION'); assert.equal(env.values.get(PRACTICE_STORAGE_KEY), before);
  await session.action('peek'); const expected = savedAt(env); assert.notEqual(expected.rngState, value.rngState); await session.destroy();
  const secondEnv = environment(); secondEnv.values.set(PRACTICE_STORAGE_KEY, before);
  const restored = await createHyakkiPracticeSession(secondEnv); await restored.action('peek');
  assert.deepEqual(savedAt(secondEnv), expected); await restored.destroy();
});

test('restart and destroy invalidate captured old callbacks without writing or publishing after disposal', async () => {
  const env = environment(), session = await createHyakkiPracticeSession(env); await session.setActive(true);
  const old = [...env.timers.values()][0].callback; await session.restart({ actionLimit: 10 });
  const newer = session.snapshot().matchId; old(); await flush(); assert.equal(session.snapshot().matchId, newer);
  const latest = [...env.timers.values()][0].callback; await session.destroy();
  const writes = env.writes.length, changes = env.changes.length; latest(); await flush();
  assert.equal(env.timers.size, 0); assert.equal(env.writes.length, writes); assert.equal(env.changes.length, changes);
  await rejects(session.action('end-turn'), 'PRACTICE_DESTROYED');
});

for (const actionLimit of [1, 5, 10]) test(`session scheduling, human commands and saved recovery finish a full true game at actionLimit=${actionLimit}`, async t => {
  const env = environment(37); let session = await createHyakkiPracticeSession({ ...env, actionLimit });
  await session.setActive(true); let commands = 0, restores = 0;
  for (let tick = 0; tick < 5000 && session.snapshot().game.status === 'playing'; tick++) {
    const view = session.snapshot(), command = chooseHyakkiPracticeAction(view.game, PRACTICE_SELF, { now: view.logicalNow });
    if (command) { await session.action(command.type, fields(command)); commands++; }
    else await env.step(700);
    if (tick > 0 && tick % 53 === 0) {
      const before = session.snapshot().game; await session.destroy(); session = await createHyakkiPracticeSession(env);
      assert.deepEqual({ ...session.snapshot().game, clock: null }, { ...before, clock: null }); await session.setActive(true); restores++;
    }
    assert.ok(session.snapshot().game.turnNumber <= 300); assert.equal(session.snapshot().conflict, false);
  }
  const view = session.snapshot(); assert.equal(view.game.status, 'finished', view.storageNote); assert.equal(view.game.result.reason, 'normal-close');
  assert.ok(view.game.players.some(owner => owner.silver >= 60)); conserved(savedAt(env).game); assert.equal(env.timers.size, 0);
  assert.deepEqual([...env.values.keys()], [PRACTICE_STORAGE_KEY]); t.diagnostic(JSON.stringify({ actionLimit, turns: view.game.turnNumber, humanCommands: commands, restores }));
  await session.destroy();
});
