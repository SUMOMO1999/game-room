import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeck, getCard } from './games/hyakki-trading/content/definitions.mjs';
import { gameProblem } from './games/hyakki-trading/validation.mjs';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { closeRuntime } from '../server/production.mjs';
import { verifyLiveStore } from '../server/backup.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
import { requireAdapter } from '../server/games/adapter-contract.mjs';
import { createHyakkiAdapter } from '../server/games/hyakki-trading/adapter.mjs';

// Deterministic server shuffle, never an injected hand or edited live state.
function shuffle(firstIndex, characterOwner) {
  const cards = createDeck(), moving = cards.map(card => card.id), desired = [...moving];
  for (const [position, code] of [[0, 'T08'], [characterOwner === 0 ? 1 : 5, 'M04'], [characterOwner === 0 ? 5 : 1, 'C07']]) {
    const index = desired.findIndex(id => getCard(cards.find(card => card.id === id).definitionId).sourceCode === code);
    [desired[position], desired[index]] = [desired[index], desired[position]];
  }
  const choices = [firstIndex];
  for (let index = moving.length - 1; index > 0; index--) {
    const target = moving.indexOf(desired[index]); choices.push(target);
    [moving[index], moving[target]] = [moving[target], moving[index]];
  }
  return maximum => { const value = choices.length ? choices.shift() : maximum - 1; assert.ok(value >= 0 && value < maximum); return value; };
}

async function fixture(t, { firstIndex = 0, characterOwner = 1 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hyakki-terminal-clock-')), sourcePath = join(directory, 'game.sqlite');
  let at = 10000, advancing = false, sequence = 0;
  const now = () => advancing ? ++at : at, key = randomBytes(32), users = ['1'.repeat(64), '2'.repeat(64)];
  const storage = new EncryptedStore(new SQLiteAdapter(sourcePath, { now }), key, now);
  const runtime = createRuntime(readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_HYAKKI_ENABLED: '1' }), {
    storage, sessions: {}, now, roomOptions: { pollIntervalMs: 0, serverRandomInt: shuffle(firstIndex, characterOwner) },
    chatOptions: { pollIntervalMs: 0 },
  });
  runtime.rooms.setHistory(createMatchHistory({ storage, now, gameRegistry: runtime.gameRegistry }));
  const stops = [];
  t.after(async () => { for (const stop of stops) await stop(); await closeRuntime(runtime); rmSync(directory, { recursive: true, force: true }); });
  const host = await runtime.rooms.createRoom(users[0], '甲', 'terminal-create', 'hyakki-trading');
  await runtime.rooms.joinRoom(host.roomCode, users[1], '乙', 'terminal-join');
  for (const user of users) stops.push(await runtime.rooms.subscribe(host.roomCode, user, () => {}, () => {}));
  const view = index => runtime.rooms.getView(host.roomCode, users[index]);
  const saved = async () => (await storage.read('rooms', host.view.roomId)).value.snapshot;
  let lastAction, lastActor;
  async function action(index, type, extra = {}) {
    const current = await view(index);
    const common = ['configure', 'ready', 'start', 'leave'].includes(type);
    lastAction = { type, requestId: `terminal-${++sequence}`, expectedRevision: current.revision,
      ...(!common ? { matchId: current.matchId, turnId: current.game.turnId,
        ...(current.game.pending ? { effectId: current.game.pending.id, decisionId: current.game.pending.decisionId } : {}) } : {}), ...extra };
    lastActor = users[index];
    const result = await runtime.rooms.action(host.roomCode, users[index], lastAction);
    assert.equal(result.error, undefined); return result;
  }
  await action(0, 'configure', { hyakkiConfig: { actionLimit: 3 } });
  for (const index of [0, 1]) await action(index, 'ready', { ready: true });
  await action(0, 'start');
  const handCard = async (index, code) => (await view(index)).game.players.find(player => player.id === (awaitedIds[index])).hand
    .find(card => getCard(card.definitionId).sourceCode === code)?.cardId;
  const awaitedIds = [(await view(0)).selfId, (await view(1)).selfId];
  const toolId = await handCard(0, 'T08'); assert.ok(toolId);
  async function drawOne(index, keep = true) { await action(index, 'peek'); await action(index, keep ? 'keep-peek' : 'discard-peek'); }
  async function enrichHost(target) {
    if ((await saved()).game.turnPlayerId === awaitedIds[1]) { await drawOne(1); await action(1, 'end-turn'); }
    for (let turn = 0; turn < 25; turn++) {
      const current = await saved();
      assert.equal(current.game.turnPlayerId, awaitedIds[0]);
      await drawOne(0);
      if (!current.game.players[0].tools.length) await action(0, 'install-tool', { cardId: toolId });
      await action(0, 'activate-tool', { cardId: toolId });
      const pending = (await view(0)).game.pending;
      const payment = pending.choice.options.find(option => option.payment.zone === 'hand'
        && !['M04', 'C07'].includes(getCard(option.payment.cardId.split('#')[0]).sourceCode));
      assert.ok(payment); await action(0, 'choose-effect', { selection: payment });
      if ((await saved()).game.players[0].silver === target) return;
      // The installation turn spends all three actions and ends after payment.
      if ((await saved()).game.turnPlayerId === awaitedIds[0]) await action(0, 'end-turn');
      await drawOne(1); await action(1, 'end-turn');
    }
    assert.fail('Legal economy did not reach the intended close boundary');
  }
  async function assertTerminal(reason = 'normal-close') {
    const snapshot = await saved(), endedAt = snapshot.game.result.settledAt;
    assert.equal(snapshot.phase, 'finished'); assert.equal(snapshot.game.status, 'finished'); assert.equal(gameProblem(snapshot.game), null);
    assert.equal(snapshot.game.result.reason, reason); assert.equal(snapshot.matchEndedAt, endedAt); assert.ok(now() > endedAt);
    const groups = (await storage.scan('hyakki-events')).map(row => row.value).filter(group => group.matchId === snapshot.matchId).sort((a,b) => a.sequence-b.sequence);
    assert.equal(groups.length, snapshot.game.publicEventSequence);
    assert.equal(groups.at(-1).mode, 'terminal'); assert.equal(groups.at(-1).committedAt, endedAt);
    assert.equal(groups.at(-1).events.at(-1).type, 'match-ended');
    await runtime.rooms.flushPendingRecords();
    const summaries = (await storage.scan('game-history')).map(row => row.value.summary).filter(summary => summary.matchId === snapshot.matchId);
    assert.equal(summaries.length, 1); assert.equal(summaries[0].endedAt, endedAt);
    assert.deepEqual(summaries[0].players.map(player => player.wealth), snapshot.game.players.map(player => player.silver));
    const replay = await runtime.rooms.action(host.roomCode, lastActor, lastAction); assert.equal(replay.error, undefined);
    assert.equal((await saved()).game.publicEventSequence, snapshot.game.publicEventSequence);
    verifyLiveStore({ sourcePath, key, now });
    return snapshot;
  }
  return { action, view, saved, handCard, drawOne, enrichHost, assertTerminal, ids: awaitedIds, advance: () => { advancing = true; } };
}

for (const mode of ['first-final-response', 'first-final-counter', 'second-direct-close', 'second-response-close']) {
  test(`wall-clock advancement preserves one authoritative terminal time through SQLite: ${mode}`, async t => {
    const first = mode.startsWith('first'), f = await fixture(t, { firstIndex: first ? 0 : 1, characterOwner: first ? 1 : 0 });
    await f.enrichHost(mode === 'second-response-close' ? 58 : 60);
    if (mode === 'second-direct-close') { f.advance(); await f.action(0, 'end-turn'); }
    else {
      await f.action(0, 'end-turn');
      if (!first) { await f.drawOne(1); await f.action(1, 'end-turn'); }
      else assert.ok((await f.saved()).game.closing);
      const owner = first ? 1 : 0, responder = 1 - owner;
      await f.drawOne(owner, false); await f.drawOne(owner);
      await f.action(owner, 'play-character', { cardId: await f.handCard(owner, 'M04') });
      assert.equal((await f.saved()).game.actionsUsed, 3);
      assert.equal((await f.saved()).game.pending.response.kind, 'counter');
      assert.equal((await f.saved()).phase, 'playing');
      if (mode === 'first-final-counter') { f.advance(); await f.action(responder, 'respond', { cardId: await f.handCard(responder, 'C07') }); }
      else {
        await f.action(responder, 'decline-response');
        assert.equal((await f.saved()).game.pending.choice.kind, 'tribute-branch');
        f.advance(); await f.action(responder, 'choose-effect', { selection: { branch: 'pay' } });
      }
    }
    const final = await f.assertTerminal();
    assert.equal(final.game.result.winnerIds[0], f.ids[0]);
  });
}

for (const stage of ['counter', 'tribute-choice']) test(`leaving during ${stage} persists the domain terminal time despite subsequent clock reads`, async t => {
  const f = await fixture(t, { characterOwner: 0 });
  await f.drawOne(0); await f.action(0, 'play-character', { cardId: await f.handCard(0, 'M04') });
  if (stage === 'tribute-choice') await f.action(1, 'decline-response');
  f.advance(); await f.action(stage === 'counter' ? 0 : 1, 'leave');
  const final = await f.assertTerminal('voluntary-leave'); assert.ok(final.game.pending);
});

test('optional authoritative end-time hook must be callable and stays separate from score settlement', () => {
  const adapter = createHyakkiAdapter(); assert.equal(adapter.matchSummary, undefined); assert.equal(adapter.accountingPolicy, undefined);
  assert.equal(requireAdapter(adapter), adapter);
  assert.throws(() => requireAdapter({ ...adapter, gameEndedAt: 1 }), /适配器/);
});
