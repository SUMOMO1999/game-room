import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHyakkiHttpFixture } from './test-support/hyakki-http-fixture.mjs';
import { CONTENT_VERSION, createDeck, getCard, DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION } from './games/hyakki-trading/content/definitions.mjs';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { currentDecision } from './games/hyakki-trading/rules.mjs';
import { gameProblem } from './games/hyakki-trading/validation.mjs';
import { createHyakkiAdapter } from '../server/games/hyakki-trading/adapter.mjs';
import { validateHyakkiEventState, HYAKKI_EVENT_SCOPES } from '../server/games/hyakki-trading/event-store.mjs';
import { decryptStoredRecord } from '../server/storage.mjs';
import { snapshotFormatProblem } from '../server/room-snapshot-compat.mjs';
import { backupStore, verifyBackup, restoreStore, RECOVERY_SCOPES } from '../server/backup.mjs';
import { CURRENT_DATA_COMPATIBILITY, compareReleaseCompatibility } from '../scripts/release-compatibility.mjs';

// An explicit bounded shuffle reaches the tested real rules through opening
// hands and HTTP actions. No active authoritative game is edited for the test.
function openingShuffle(codes, placements = []) {
  const deck = createDeck(), moving = deck.map(card => card.id), desired = [...moving];
  const selected = new Set();
  for (const [position, code] of [...codes.map((code, offset) => [25 + offset, code]), ...placements]) {
    const card = deck.find(card => !selected.has(card.id) && getCard(card.definitionId).sourceCode === code);
    assert.ok(card); selected.add(card.id);
    const index = desired.indexOf(card.id);
    [desired[position], desired[index]] = [desired[index], desired[position]];
  }
  const choices = [5];
  for (let index = moving.length - 1; index > 0; index--) {
    const target = moving.indexOf(desired[index]); choices.push(target);
    [moving[index], moving[target]] = [moving[target], moving[index]];
  }
  return maximum => { const value = choices.length ? choices.shift() : maximum - 1; assert.ok(value >= 0 && value < maximum); return value; };
}
async function table(t, codes, storagePath = null, placements = []) {
  // Preserve the original 110-card HTTP/recovery trajectory and schema14 assertions.
  const current = createHyakkiAdapter(), legacy = { ...current,
    roomDefaults: () => ({ turnClock: null, hyakkiConfig: { actionLimit: 5, goodsPerType: 8 } }),
    createGame: (players, options) => current.createGame(players, { ...options, contentVersion: CONTENT_VERSION }) };
  const gameRegistry = createGameRegistry(defaultGameRegistry.knownTypes().map(type => type === 'hyakki-trading' ? legacy : defaultGameRegistry.gameAdapter(type)),
    { creationTypes: defaultGameRegistry.creationTypes() });
  const fixture = await createHyakkiHttpFixture(t, { storagePath, gameRegistry, serverRandomInt: openingShuffle(codes, placements) });
  const members = [];
  // Provider.complete's selected mock identity is intentionally serialized.
  for (let index = 0; index < 9; index++) members.push(await fixture.login(`multi-${index}`));
  const created = await fixture.request('/api/rooms', members[0], { name: '玩家1', gameType: 'hyakki-trading', requestId: randomUUID() });
  assert.equal(created.status, 201, created.text); const code = created.body.roomCode;
  for (let index = 1; index < 8; index++) {
    const joined = await fixture.request(`/api/rooms/${code}/join`, members[index], { name: `玩家${index + 1}`,
      requestId: randomUUID(), ...(index >= 6 ? { role: 'spectator' } : {}) });
    assert.equal(joined.status, 201, joined.text);
  }
  for (let index = 0; index < 8; index++) members[index].seat = (await fixture.view(code, members[index])).selfId;
  const streams = [];
  for (const member of members.slice(0, 8)) streams.push(await fixture.listen(code, member));
  await fixture.action(code, members[0], 'configure', { hyakkiConfig: { actionLimit: 10, goodsPerType: 8 } });
  for (const member of members.slice(0, 6)) await fixture.action(code, member, 'ready', { ready: true });
  const started = await fixture.action(code, members[0], 'start'), roomId = started.view.roomId;
  assert.equal(started.view.game.ruleVersion, MULTIPLAYER_RULE_VERSION);
  assert.equal(started.view.game.version, 2); assert.equal(started.view.players.length, 6);
  assert.equal(started.view.game.turnPlayerId, members[5].seat);
  return { ...fixture, members, streams, code, roomId, owner: members[5],
    snapshot: async () => (await fixture.runtime.storage.read('rooms', roomId)).value.snapshot };
}
const cardCode = (view, code) => view.game.players.find(player => player.id === view.selfId).hand.find(card => getCard(card.definitionId).sourceCode === code).cardId;
async function rejected(f, member, type, extras = {}) {
  const view = await f.view(f.code, member), response = await f.request(`/api/rooms/${f.code}/actions`, member, {
    type, requestId: randomUUID(), expectedRevision: view.revision, matchId: view.matchId, turnId: view.game.turnId,
    ...(view.game.pending ? { effectId: view.game.pending.id, decisionId: view.game.pending.decisionId } : {}), ...extras });
  assert.ok([400, 403, 409].includes(response.status), response.text); return response;
}
function evidence(name, value) {
  const directory = new URL('../ops/hyakki-multiplayer-2026-10-11/platform/e3-resumed/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL(name, directory), JSON.stringify(value, null, 2) + '\n');
}

test('six players and two observers use real HTTP/SSE with directed response, private hands and frozen cancellation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hyakki-six-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await table(t, ['M02', 'M08', 'T04', 'C12', 'M07'], join(directory, 'source.sqlite'), [[10, 'C07']]);
  const { members, owner, streams } = f;
  const opening = await Promise.all(streams.map(stream => stream.wait(packet => packet.event === 'view' && packet.data.game?.status === 'playing')));
  for (let index = 0; index < 8; index++) {
    const view = opening[index].data.game, hands = view.players.filter(player => Object.hasOwn(player, 'hand'));
    assert.equal(hands.length, index < 6 ? 1 : 0);
    if (index < 6) assert.equal(hands[0].id, members[index].seat);
    assert.equal(JSON.stringify(view).includes('"deck"'), false);
    assert.equal(JSON.stringify(opening[index].data).includes('userKey'), false);
  }
  await f.action(f.code, owner, 'peek');
  const peek = await Promise.all(streams.map(stream => stream.wait(packet => packet.event === 'view' && packet.data.game?.pending?.kind === 'peek')));
  const secret = peek[5].data.game.pending.privatePool[0].cardId;
  for (let index = 0; index < 8; index++) if (index !== 5) {
    assert.equal(peek[index].data.game.pending.privatePool, undefined);
    assert.equal(JSON.stringify(peek[index].data).includes(secret), false);
  }
  await f.action(f.code, owner, 'keep-peek');
  const ready = await f.view(f.code, owner), cardId = cardCode(ready, 'M02'), before = await f.snapshot();
  await rejected(f, owner, 'play-character', { cardId });
  await rejected(f, owner, 'play-character', { cardId, params: { targetId: owner.seat } });
  assert.deepEqual((await f.snapshot()).game, before.game);
  const played = await f.action(f.code, owner, 'play-character', { cardId, params: { targetId: members[2].seat } });
  assert.equal(played.view.game.pending.targetId, members[2].seat);
  assert.equal(played.view.game.pending.actorId, members[2].seat);
  assert.equal(played.view.turnClock.kind, 'decision');
  const directed = await f.snapshot(); assert.equal(directed.game.timing.active.deadlineAt, null);
  assert.equal(directed.game.timing.decision.actorId, members[2].seat);
  assert.equal(directed.game.timing.decision.deadlineAt, directed.game.committedAt + 60000);
  for (const member of [members[1], members[6]]) await rejected(f, member, 'decline-response');
  assert.deepEqual((await f.snapshot()).game.pending, directed.game.pending);
  const historyPath = `/api/hyakki/matches/${directed.matchId}/events`;
  assert.equal((await f.request(`${historyPath}?roomCode=${f.code}`, members[8])).status, 403);
  assert.equal((await f.request(`${historyPath}?roomCode=${f.code}`, members[6])).status, 200);
  const savedRows = [];
  for (const scope of Object.values(HYAKKI_EVENT_SCOPES)) for (const row of await f.runtime.storage.adapter.entries(scope)) savedRows.push({
    scope, value: decryptStoredRecord(f.runtime.storage.key, row.key, row), payloadBytes: Buffer.byteLength(row.payload), expiresAt: row.expiresAt });
  const checked = validateHyakkiEventState(savedRows, { rooms: [directed] });
  assert.equal(checked.heads[0].match.participants.length, 6);
  const wrongOrder = structuredClone(directed); wrongOrder.matchParticipants.reverse();
  assert.ok(createHyakkiAdapter().roomStateProblem(wrongOrder, true));
  assert.throws(() => validateHyakkiEventState(savedRows, { rooms: [wrongOrder] }));
  const restoration = await restoreInNewProcess(f, directory, directed);
  await f.action(f.code, members[2], 'decline-response');
  const choice = await f.snapshot(); assert.equal(choice.game.timing.decision, null);
  assert.equal(currentDecision(choice.game).actorId, owner.seat); assert.equal(choice.turnClock.kind, 'turn');
  const material = structuredClone(choice.game);
  await f.action(f.code, members[1], 'leave');
  const ended = await f.snapshot(); assert.equal(ended.phase, 'aborted'); assert.equal(ended.game.status, 'aborted');
  assert.equal(ended.game.result.reason, 'cancelled'); assert.deepEqual(ended.game.result.winnerIds, []);
  for (const field of ['players', 'deck', 'discard', 'bankGoods', 'pending', 'availableStalls']) assert.deepEqual(ended.game[field], material[field], field);
  assert.equal(ended.matchParticipants.length, 6); assert.equal(ended.players.length, 5); assert.equal(ended.turnClock, null);
  assert.equal(gameProblem(ended.game), null); assert.equal(createHyakkiAdapter().roomStateProblem(ended, true), null);
  for (const member of members.slice(0, 6)) {
    const history = await f.request('/api/history', member); assert.equal(history.status, 200);
    assert.equal(history.body.items[0].status, 'aborted'); assert.equal(history.body.items[0].players.length, 6);
    assert.equal(history.body.items[0].self.outcome, 'unscored');
  }
  const p95 = [...f.metrics.latencies].sort((a, b) => a - b)[Math.ceil(f.metrics.latencies.length * .95) - 1];
  const result = { environment: 'local HTTP / SQLite / synthetic upstream identity', players: 6, spectators: 2,
    streams: 8, directedResponse: true, privateHands: true, privatePeek: true, cancellationFrozen: true,
    restore: restoration, requests: f.metrics.requests, identityChecks: f.metrics.identityChecks,
    requestBytes: f.metrics.requestBytes, responseBytes: f.metrics.responseBytes,
    sseBytes: streams.reduce((sum, stream) => sum + stream.bytes, 0), latencyP95Ms: p95, scopeCount: RECOVERY_SCOPES.length };
  evidence('http-sse-recovery.json', result); t.diagnostic(JSON.stringify(result));
});

async function restoreInNewProcess(f, directory, before, { suffix = '', continuation = null } = {}) {
  const sourcePath = join(directory, 'source.sqlite'), backup = join(directory, `backup${suffix}.sqlite`), destination = join(directory, `restored${suffix}.sqlite`);
  const key = f.runtime.storage.key, now = () => before.game.committedAt;
  await backupStore({ sourcePath, destinationPath: backup, key, now, gameRegistry: f.runtime.gameRegistry });
  const manifest = verifyBackup({ sourcePath: backup, key, gameRegistry: f.runtime.gameRegistry });
  assert.equal(manifest.manifest.scopes.length, 18);
  restoreStore({ sourcePath: backup, destinationPath: destination, key, gameRegistry: f.runtime.gameRegistry, offline: true });
  const keyPath = join(directory, 'key'), inputPath = join(directory, 'fixture.json');
  writeFileSync(keyPath, key, { mode: 0o600 }); writeFileSync(inputPath, JSON.stringify(before), { mode: 0o600 });
  const worker = `
    import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
    import { EncryptedStore, SQLiteAdapter } from './server/storage.mjs';
    import { createRuntime } from './server/runtime.mjs'; import { closeRuntime } from './server/production.mjs';
    import { readSettings } from './server/config.mjs';
    import { gameProblem } from './app/games/hyakki-trading/validation.mjs';
    const [path,keyPath,inputPath,continuationText] = process.argv.slice(1), before = JSON.parse(readFileSync(inputPath)), continuation = JSON.parse(continuationText);
    const now = () => before.game.committedAt + 1, storage = new EncryptedStore(new SQLiteAdapter(path,{now}),readFileSync(keyPath),now);
    const runtime = createRuntime(readSettings({GAME_ROOM_AUTH_MODE:'mock',GAME_ROOM_HYAKKI_ENABLED:'0'}),{
      storage,sessions:{},now,roomOptions:{pollIntervalMs:0},chatOptions:{pollIntervalMs:0}});
    const subscriptions=[];
    try {
      await runtime.rooms.ready;
      const views=[]; for(const member of before.matchParticipants) views.push(await runtime.rooms.getView(before.code,member.userKey));
      const after=(await storage.read('rooms',before.roomId)).value.snapshot;
      assert.equal(after.schemaVersion,14); assert.equal(after.phase,'paused'); assert.equal(after.game.version,2);
      assert.equal(gameProblem(after.game),null); assert.deepEqual(after.matchParticipants,before.matchParticipants);
      for(const field of ['players','pending','deck','discard','bankGoods','firstPlayerId','turnId','actionsUsed']) assert.deepEqual(after.game[field],before.game[field],field);
      for(const kind of ['active','decision']) { const old=before.game.timing[kind], clock=after.game.timing[kind];
        if(!old) {assert.equal(clock,null);continue;} assert.equal(clock.id,old.id);assert.equal(clock.actorId,old.actorId);
        assert.equal(clock.remainingMs,old.deadlineAt===null?old.remainingMs:old.deadlineAt-now());assert.equal(clock.deadlineAt,null); }
      for(const [i,view] of views.entries()) {assert.equal(view.game.players.filter(player=>Object.hasOwn(player,'hand')).length,1);
        assert.equal(view.game.players.find(player=>Object.hasOwn(player,'hand')).id,before.matchParticipants[i].playerId);}
      assert.equal((await storage.scan('sessions')).length,0); assert.equal((await storage.scan('room-presence')).length,0);
      await assert.rejects(runtime.rooms.createRoom(before.matchParticipants[0].userKey,'禁止新建','disabled','hyakki-trading'));
      let continued = null;
      if(continuation) {
        for(const member of before.matchParticipants) subscriptions.push(await runtime.rooms.subscribe(before.code,member.userKey,()=>{},()=>{}));
        const owner = before.matchParticipants.find(member=>member.playerId===before.game.pending.ownerId);
        const recipient = before.game.players.find(player=>player.id===continuation.recipientId);
        const source = before.game.players.find(player=>player.id===before.game.pending.data.targetId);
        const picked = before.game.pending.poolCards[0], leftover = before.game.pending.poolCards[1];
        assert(owner && recipient && source && picked && leftover);
        const current = await runtime.rooms.getView(before.code,owner.userKey); assert.equal(current.phase,'playing');
        assert.equal(current.game.pending.actorId,owner.playerId);
        const selected = await runtime.rooms.action(before.code,owner.userKey,{type:'choose-effect',requestId:'continued-private-pool',
          expectedRevision:current.revision,matchId:current.matchId,turnId:current.game.turnId,effectId:current.game.pending.id,
          decisionId:current.game.pending.decisionId,selection:{cardId:picked}});
        assert.equal(selected.error,undefined);
        const completed = (await storage.read('rooms',before.roomId)).value.snapshot;
        assert.equal(completed.game.pending,null);
        for(const old of before.game.players) {
          const expected = old.hand.concat(old.id===owner.playerId?[picked]:old.id===recipient.id?[leftover]:[]);
          assert.deepEqual(completed.game.players.find(player=>player.id===old.id).hand,expected);
        }
        const recipientView = await runtime.rooms.getView(before.code,before.matchParticipants.find(member=>member.playerId===recipient.id).userKey);
        assert(recipientView.game.players.find(player=>player.id===recipient.id).hand.some(card=>card.cardId===leftover));
        continued={ownerChooses:true,recipientGetsExactLeftover:true,sourceHandUnchanged:true,otherHandsUnchanged:true,pendingCompleted:true};
      }
      console.log(JSON.stringify({newProcess:true,newPath:true,version:2,schema:14,participants:6,targetPreserved:true,clockPreserved:true,creationClosed:true,sessionsRestored:false,...(continued?{continued}:{})}));
    } finally {for(const stop of subscriptions) await stop();await closeRuntime(runtime);}
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', worker, destination, keyPath, inputPath, JSON.stringify(continuation)],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr || child.stdout); return JSON.parse(child.stdout.trim());
}

test('six-player auction remains open after passes until every losing bidder has declined', async t => {
  const f = await table(t, ['C12', 'T04', 'M07', 'M08', 'C02']);
  await f.action(f.code, f.owner, 'peek'); await f.action(f.code, f.owner, 'keep-peek');
  const view = await f.view(f.code, f.owner); await f.action(f.code, f.owner, 'play-character', { cardId: cardCode(view, 'C12') });
  let state = await f.snapshot(); const seats = state.game.players.map(player => player.id), member = id => f.members.find(player => player.seat === id);
  await f.action(f.code, member(currentDecision(state.game).actorId), 'bid', { amount: 1 });
  state = await f.snapshot(); await f.action(f.code, member(currentDecision(state.game).actorId), 'pass-bid');
  state = await f.snapshot(); assert.equal(state.game.pending.kind, 'auction');
  await f.action(f.code, member(currentDecision(state.game).actorId), 'bid', { amount: 2 });
  let choices = 0;
  while ((state = await f.snapshot()).game.pending) {
    assert.ok(++choices <= 18, 'auction/default chain is bounded');
    const actor = currentDecision(state.game).actorId, projected = await f.view(f.code, member(actor));
    if (projected.game.pending.choice) await f.action(f.code, member(actor), 'choose-effect', { selection: projected.game.pending.decision.defaultSelection });
    else await f.action(f.code, member(actor), 'pass-bid');
  }
  assert.equal(gameProblem(state.game), null); assert.equal(state.game.players.length, 6);
  const events = (await f.runtime.storage.scan('hyakki-events')).flatMap(row => row.value.events);
  assert.ok(events.filter(event => event.type === 'bid-passed').length >= 5);
  assert.equal(events.filter(event => event.type === 'auction-settled').length, 1);
  assert.equal(new Set(seats).size, 6); evidence('auction.json', { players: 6, passes: events.filter(event => event.type === 'bid-passed').length,
    settledOnce: true, boundedChoices: choices });
});

test('real six-seat M08 preserves its source and separate third-seat recipient through private T04 recovery', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hyakki-borrow-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await table(t, ['T04', 'C02', 'M07', 'C12', 'C07'], join(directory, 'source.sqlite'), [[0, 'M08']]);
  await f.action(f.code, f.owner, 'peek'); await f.action(f.code, f.owner, 'keep-peek');
  const hand = await f.view(f.code, f.owner); await f.action(f.code, f.owner, 'install-tool', { cardId: cardCode(hand, 'T04') });
  await f.action(f.code, f.owner, 'end-turn');
  const actor = f.members[0], third = f.members[2];
  await f.action(f.code, actor, 'peek'); await f.action(f.code, actor, 'keep-peek');
  const own = await f.view(f.code, actor), targetTool = own.game.players[5].tools[0]; assert.match(targetTool.ref, /^tool-5:/);
  await f.action(f.code, actor, 'play-character', { cardId: cardCode(own, 'M08'), params: { targetId: f.owner.seat, toolCardId: targetTool.ref } });
  await f.action(f.code, f.owner, 'decline-response');
  await f.action(f.code, actor, 'choose-effect', { selection: { borrow: true } });
  const borrowed = await f.snapshot(); assert.equal(borrowed.game.pending.choice.kind, 'borrowed-target');
  assert.equal(borrowed.game.pending.data.targetId, f.owner.seat); assert.equal(borrowed.game.pending.data.borrowedTargetId, undefined);
  assert.equal(borrowed.game.pending.choice.options.length, 5);
  const restoration = await restoreInNewProcess(f, directory, borrowed);
  await f.action(f.code, actor, 'choose-effect', { selection: { targetId: third.seat } });
  const privatePool = await f.view(f.code, actor), pending = (await f.snapshot()).game.pending;
  assert.equal(pending.data.targetId, f.owner.seat); assert.equal(pending.data.borrowedTargetId, third.seat);
  assert.equal(privatePool.game.pending.privatePool.length, 2);
  for (const member of f.members.slice(1, 8)) {
    const view = await f.view(f.code, member); assert.equal(view.game.pending.privatePool, undefined);
    for (const card of privatePool.game.pending.privatePool) assert.equal(JSON.stringify(view).includes(card.cardId), false);
  }
  // T04's owner chooses one private candidate; the other is delivered directly.
  // The recipient has no separate decision/clock. Check exact transfer rather
  // than inventing an obligation which neither the card nor resolver defines.
  const selectedState = await f.snapshot(), picked = pending.poolCards[0], leftover = pending.poolCards[1];
  assert.equal(currentDecision(selectedState.game).actorId,actor.seat);
  assert.equal(selectedState.turnClock.kind,'turn'); assert.equal(selectedState.game.timing.decision,null);
  await rejected(f,third,'choose-effect',{selection:{cardId:picked}});
  await rejected(f,f.members[6],'choose-effect',{selection:{cardId:picked}});
  assert.deepEqual((await f.snapshot()).game,selectedState.game,'unauthorized selections preserve all material');
  const privateRestoration = await restoreInNewProcess(f,directory,selectedState,{suffix:'-borrowed-pool',continuation:{recipientId:third.seat}});
  await f.action(f.code,actor,'choose-effect',{selection:{cardId:picked}});
  const ended = await f.snapshot(); assert.equal(ended.game.pending,null); assert.equal(gameProblem(ended.game),null);
  for(const old of selectedState.game.players) {
    const expected = old.hand.concat(old.id===actor.seat?[picked]:old.id===third.seat?[leftover]:[]);
    assert.deepEqual(ended.game.players.find(player=>player.id===old.id).hand,expected);
  }
  const received = await f.view(f.code,third);
  assert(received.game.players.find(player=>player.id===third.seat).hand.some(card=>card.cardId===leftover));
  assert.equal(ended.game.discard.filter(id=>id===pending.data.toolId).length,1,'borrowed tool is removed once');
  evidence('borrowed-target.json', { players: 6, publicToolReference: 'tool-5', sourceTargetDistinctFromRecipient: true,
    ownerChoosesPrivatePool:true,recipientGetsExactLeftover:true,sourceAndOtherHandsUnchanged:true,recipientOwnClock:false,
    privatePoolRestrictedToOwner: true, restoration, privateRestoration, boundedChoices: 1,
    oracleCorrection:'T04 directly gives the leftover to borrowedTargetId; it never creates a recipient decision.' });
});

test('schema14 writer retains old readers, rejects v2 in old envelopes and forbids the current schema13 rollback', () => {
  const adapter = createHyakkiAdapter(), current = structuredClone(CURRENT_DATA_COMPATIBILITY), old = structuredClone(current);
  old.roomSnapshots.read = old.roomSnapshots.read.filter(version => version <= 13);
  // Reconstruct the historical schema13 capability, excluding later PARKS writes.
  old.roomSnapshots.write = old.roomSnapshots.write.filter(version => version <= 14).map(version => version === 14 ? 13 : version);
  const manifest = (id, dataCompatibility) => ({ format: 1, project: 'game-room', releaseId: id.repeat(20), containsSecrets: false, containsUserData: false, dataCompatibility });
  const result = compareReleaseCompatibility(manifest('a', current), manifest('b', old));
  assert.equal(result.forwardCompatible, true); assert.equal(result.rollbackCompatible, false);
  assert.equal(RECOVERY_SCOPES.length, 18); assert.equal(adapter.maxPlayers, 6);
  assert.deepEqual(adapter.ruleVersions, [DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION]);
  const envelope = { schemaVersion: 13, gameType: 'hyakki-trading', turnClock: null, spectators: [],
    players: [{}, {}], game: { version: 2, ruleVersion: MULTIPLAYER_RULE_VERSION } };
  assert.equal(snapshotFormatProblem(envelope, adapter), true);
  assert.equal(snapshotFormatProblem({ ...envelope, schemaVersion: 14 }, adapter), false);
});
