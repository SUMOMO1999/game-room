import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { createDeck, getCard } from './games/hyakki-trading/content/definitions.mjs';
import { createHyakkiAdapter, createHyakkiTransitionPreparers } from '../server/games/hyakki-trading/adapter.mjs';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { backupStore, verifyBackup, restoreStore } from '../server/backup.mjs';

function registry(open, legacy = false) {
  const actual = createHyakkiAdapter();
  // Historical writer fixture emits exactly schema12's missing-field shape.
  // It still reaches pending states through real rules and durable commits.
  const adapter = legacy ? { ...actual, roomDefaults: () => ({ turnClock: null, hyakkiConfig: { actionLimit: 5 } }),
    snapshotSchema: () => 12, createGame(players, options) { const game = actual.createGame(players, options); delete game.goodsPerType; return game; } } : actual;
  return createGameRegistry([...defaultGameRegistry.knownTypes().filter(type => type !== 'hyakki-trading').map(type => defaultGameRegistry.gameAdapter(type)), adapter],
    { creationTypes: [...defaultGameRegistry.creationTypes(), ...(open ? ['hyakki-trading'] : [])] });
}
// The fixture selects an explicit shuffle through the same bounded random seam;
// neither a saved state nor an active room is edited to inject a test hand.
function shuffleFor(code) {
  const cards = createDeck(), moving = cards.map(card => card.id), desired = [...moving];
  const index = cards.findIndex(card => getCard(card.definitionId).sourceCode === code);
  [desired[0], desired[index]] = [desired[index], desired[0]];
  const choices = [0];
  for (let i = moving.length - 1; i > 0; i--) {
    const target = moving.indexOf(desired[i]); choices.push(target); [moving[i], moving[target]] = [moving[target], moving[i]];
  }
  return maximum => { const value = choices.length ? choices.shift() : maximum - 1; assert.ok(value >= 0 && value < maximum); return value; };
}

const scenarios = [
  ['C02', 'C02'], ['C10', 'C10'], ['peek', 'C01'], ['counter', 'M02'], ['public-draft', 'M02'],
  ['auction-bid', 'C12'], ['tool-private-pool', 'T04'], ['tool-payment', 'T08'],
  ['manual-auction', 'C12'], ['absence-peek', 'C01'], ['final-round', 'T08'],
  ['legacy-six', 'C02'], ['configured-four', 'C02', 4], ['configured-twenty', 'C10', 20],
];
for (const [scenario, code, goodsPerType] of scenarios) test(`real SQLite ${scenario} restores in a new process with receipts and event material intact`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hyakki-real-recovery-')), sourcePath = join(directory, 'source.sqlite');
  let at = 10000;
  const key = randomBytes(32), now = () => at, users = ['1'.repeat(64), '2'.repeat(64)];
  const storage = new EncryptedStore(new SQLiteAdapter(sourcePath, { now }), key, now);
  const gameRegistry = registry(true, scenario === 'legacy-six'), runtime = createRuntime(readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), {
    storage, sessions: {}, now, gameRegistry, chatOptions: { pollIntervalMs: 0 },
    roomOptions: { pollIntervalMs: 0, serverRandomInt: shuffleFor(code), transitionPreparers: createHyakkiTransitionPreparers(storage, { now }) },
  });
  const streams = [];
  t.after(async () => { runtime.preview.close(); await runtime.chat.close(); for (const stop of streams) await stop();
    await runtime.rooms.close(); storage.close(); rmSync(directory, { recursive: true, force: true }); });
  const host = await runtime.rooms.createRoom(users[0], '真实甲', `real-${code}-create`, 'hyakki-trading');
  await runtime.rooms.joinRoom(host.roomCode, users[1], '真实乙', `real-${code}-join`);
  for (const user of users) streams.push(await runtime.rooms.subscribe(host.roomCode, user, () => {}, () => {}));
  let sequence = 0, lastAction, lastActor, lastResult;
  async function action(user, type, extra = {}) {
    const view = await runtime.rooms.getView(host.roomCode, user);
    lastAction = { type, requestId: `real-${code}-${++sequence}`, expectedRevision: view.revision,
      ...(view.game && !['pause', 'resume'].includes(type) ? { matchId: view.matchId, turnId: view.game.turnId } : {}), ...extra };
    lastActor = user; lastResult = await runtime.rooms.action(host.roomCode, user, lastAction);
    assert.equal(lastResult.error, undefined); return lastResult;
  }
  if (goodsPerType !== undefined) await action(users[0], 'configure', { hyakkiConfig: { actionLimit: 7, goodsPerType } });
  for (const user of users) await action(user, 'ready', { ready: true });
  await action(users[0], 'start'); at += 500;
  const view = await runtime.rooms.getView(host.roomCode, users[0]);
  const card = view.game.players.find(player => player.id === view.selfId).hand.find(card => getCard(card.definitionId).sourceCode === code);
  assert.ok(card);
  const decide = async (user, type, extra = {}) => {
    const current = await runtime.rooms.getView(host.roomCode, user);
    return action(user, type, { effectId: current.game.pending.id, decisionId: current.game.pending.decisionId, ...extra });
  };
  if (['peek', 'absence-peek'].includes(scenario)) await action(users[0], 'peek');
  else {
    await action(users[0], 'peek'); await decide(users[0], 'keep-peek');
    if (code.startsWith('T')) {
      await action(users[0], 'install-tool', { cardId: card.cardId });
      await action(users[0], 'activate-tool', { cardId: card.cardId });
    } else await action(users[0], 'play-character', { cardId: card.cardId });
    if (scenario === 'public-draft') await decide(users[1], 'decline-response');
    if (['auction-bid', 'manual-auction'].includes(scenario)) await decide(users[0], 'bid', { amount: 3 });
    if (scenario === 'final-round') {
      for (let turn = 0; turn < 20; turn++) {
        const current = await runtime.rooms.getView(host.roomCode, users[0]);
        const payment = current.game.pending.choice.options.find(option => option.payment.zone === 'hand');
        assert.ok(payment); await decide(users[0], 'choose-effect', { selection: payment });
        await action(users[0], 'end-turn');
        if ((await runtime.rooms.getView(host.roomCode, users[0])).game.closing) break;
        await action(users[1], 'peek'); await decide(users[1], 'keep-peek'); await action(users[1], 'end-turn');
        await action(users[0], 'peek'); await decide(users[0], 'keep-peek');
        await action(users[0], 'activate-tool', { cardId: card.cardId });
      }
    }
  }
  if (scenario === 'manual-auction') for (const user of users) await action(user, 'pause');
  if (scenario === 'absence-peek') { await streams.pop()(); await runtime.rooms.sweep(); }
  const snapshot = (await storage.read('rooms', host.view.roomId)).value.snapshot;
  assert.equal(snapshot.schemaVersion, scenario === 'legacy-six' ? 12 : 13);
  assert.equal(snapshot.game.goodsPerType, scenario === 'legacy-six' ? undefined : goodsPerType ?? 8);
  assert.equal(snapshot.hyakkiConfig.goodsPerType, snapshot.game.goodsPerType);
  if (!['peek', 'absence-peek', 'final-round'].includes(scenario)) assert.equal(snapshot.game.pending.code, code);
  if (code === 'C10') assert.equal(snapshot.game.players[0].silver, 18);
  if (code === 'C02') assert.equal(snapshot.game.pending.poolCards.length, 6);
  if (scenario === 'counter') assert.equal(snapshot.game.pending.response.kind, 'counter');
  if (scenario === 'public-draft') assert.equal(snapshot.game.pending.choice.visibility, 'public');
  if (scenario === 'tool-private-pool') assert.equal(snapshot.game.pending.poolCards.length, 2);
  if (scenario === 'tool-payment') assert.equal(snapshot.game.pending.choice.kind, 'tool-payment-silver');
  if (scenario === 'manual-auction') assert.ok(snapshot.game.lifecycle.manual);
  if (scenario === 'absence-peek') assert.ok(snapshot.game.lifecycle.absence);
  if (scenario === 'final-round') { assert.ok(snapshot.game.closing); assert.ok(snapshot.game.players[0].silver >= 60); }
  await storage.put('sessions', 'synthetic-cookie', { token: 'synthetic-secret' }, 20000);
  const eventRows = (await storage.scan('hyakki-events')).map(row => row.value).sort((a, b) => a.sequence - b.sequence);
  const artifact = join(directory, 'backup.sqlite'), restored = join(directory, 'new-path.sqlite'), keyPath = join(directory, 'key'), fixturePath = join(directory, 'fixture.json');
  await backupStore({ sourcePath, destinationPath: artifact, key, now, gameRegistry });
  const readRegistry = registry(false);
  assert.equal(verifyBackup({ sourcePath: artifact, key, gameRegistry: readRegistry }).hyakkiEventsIncluded, true);
  restoreStore({ sourcePath: artifact, destinationPath: restored, key, gameRegistry: readRegistry, offline: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(fixturePath, JSON.stringify({ snapshot, users, lastAction, lastActor, eventRows, savedAt: at, scenario }), { mode: 0o600 });
  const worker = `
    import assert from 'node:assert/strict'; import { readFileSync, writeSync } from 'node:fs';
    import { EncryptedStore, SQLiteAdapter } from './server/storage.mjs';
    import { createRuntime } from './server/runtime.mjs'; import { closeRuntime } from './server/production.mjs';
    import { readSettings } from './server/config.mjs';
    import { createGameRegistry, defaultGameRegistry } from './app/game-registry.mjs';
    import { createHyakkiAdapter, createHyakkiTransitionPreparers } from './server/games/hyakki-trading/adapter.mjs';
    import { gameProblem } from './app/games/hyakki-trading/validation.mjs';
    const [path, keyPath, fixturePath, mode] = process.argv.slice(1), fixture = JSON.parse(readFileSync(fixturePath, 'utf8')), before = fixture.snapshot;
    const now = () => fixture.savedAt + 1, storage = new EncryptedStore(new SQLiteAdapter(path, { now }), readFileSync(keyPath), now);
    const gameRegistry = createGameRegistry([...defaultGameRegistry.knownTypes().filter(type => type !== 'hyakki-trading').map(type => defaultGameRegistry.gameAdapter(type)), createHyakkiAdapter()],
      { creationTypes: defaultGameRegistry.creationTypes() });
    const runtime = createRuntime(readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_POKER414_ENABLED: '1' }), {
      storage, sessions: {}, now, gameRegistry, roomOptions: { pollIntervalMs: 0, transitionPreparers: createHyakkiTransitionPreparers(storage, { now }) },
      chatOptions: { pollIntervalMs: 0 } });
    try {
      await runtime.rooms.ready;
      const view = await runtime.rooms.getView(before.code, fixture.users[0]), after = (await storage.read('rooms', before.roomId)).value.snapshot;
      assert.equal(runtime.poker414Enabled, true); assert.equal(runtime.gameRegistry.creationTypes().includes('hyakki-trading'), false);
      assert.equal(gameProblem(after.game), null); assert.deepEqual(after.matchParticipants, before.matchParticipants); assert.equal(after.matchId, before.matchId);
      assert.equal(after.schemaVersion, 13); assert.deepEqual(after.hyakkiConfig, before.hyakkiConfig);
      assert.equal(view.game.goodsPerType, before.game.goodsPerType ?? 6);
      assert.equal(Object.hasOwn(after.game, 'goodsPerType'), Object.hasOwn(before.game, 'goodsPerType'));
      for (const field of ['pending', 'players', 'deck', 'discard', 'bankGoods', 'goodsPerType', 'actionLimit', 'actionsUsed', 'closing', 'bookLayers',
        'availableStalls', 'purchasedStalls', 'turnId', 'turnNumber', 'firstPlayerId']) assert.deepEqual(after.game[field], before.game[field], field);
      assert.deepEqual(after.players.map(player => player.requests), before.players.map(player => player.requests));
      for (const kind of ['active', 'decision']) {
        const original = before.game.timing[kind], restored = after.game.timing[kind];
        if (original === null) { assert.equal(restored, null); continue; }
        assert.equal(restored.remainingMs, original.deadlineAt === null ? original.remainingMs : Math.max(0, original.deadlineAt - now()));
        assert.equal(restored.deadlineAt, null); assert.equal(restored.id, original.id); assert.equal(restored.actorId, original.actorId);
      }
      for (const kind of ['manual', 'absence']) if (before.game.lifecycle[kind]) assert.deepEqual(after.game.lifecycle[kind], before.game.lifecycle[kind]);
      assert.equal(after.phase, 'paused');
      assert.equal(await storage.get('sessions', 'synthetic-cookie'), null); assert.equal((await storage.scan('room-presence')).length, 0);
      const events = (await storage.scan('hyakki-events')).map(row => row.value).sort((a, b) => a.sequence - b.sequence);
      assert.equal(events.length, after.game.publicEventSequence); assert.deepEqual(events.slice(0, fixture.eventRows.length), fixture.eventRows);
      const replay = await runtime.rooms.action(before.code, fixture.lastActor, fixture.lastAction);
      assert.equal(replay.error, undefined);
      assert.ok(replay.view.actionReceipts.some(receipt => receipt.requestId === fixture.lastAction.requestId && receipt.status === 'committed'));
      const afterReplay = (await storage.read('rooms', before.roomId)).value.snapshot;
      assert.deepEqual(afterReplay.game.players, after.game.players); assert.deepEqual(afterReplay.game.pending, after.game.pending);
      assert.equal(afterReplay.game.publicEventSequence, after.game.publicEventSequence);
      assert.equal(view.game.pending?.code, before.game.pending?.code);
      writeSync(1, JSON.stringify({ restored: true, receiptReplayedWithoutNewEvent: true, scenario: fixture.scenario }) + '\\n');
      if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
    } finally { await closeRuntime(runtime); }
  `;
  for (const mode of ['crash', 'reopen']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', worker, restored, keyPath, fixturePath, mode],
      { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 20000 });
    if (mode === 'crash') assert.equal(child.signal, 'SIGKILL', child.stderr || child.stdout);
    else assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(JSON.parse(child.stdout), { restored: true, receiptReplayedWithoutNewEvent: true, scenario });
  }
});
