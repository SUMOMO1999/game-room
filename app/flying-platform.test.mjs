import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoomStore, DEFAULT_TURN_TIMEOUT_MS } from './rooms.mjs';
import { defaultGameRegistry } from './game-registry.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createMatchHistory, validateMatchSummary } from '../server/match-history.mjs';
import { createFlyingChessAdapter } from '../server/games/flying-chess/adapter.mjs';
import { gameProblem } from './games/flying-chess/rules.mjs';
import { completeFirstPlayerScript } from './games/flying-chess/fixtures/full-game.mjs';
import { readSettings } from '../server/config.mjs';
import { MockProvider } from '../server/auth.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createServer } from './server.mjs';

const GAME = 'flying-chess';
const issuer = 'urn:synthetic-flying-platform';
const users = Array.from({ length: 8 }, (_, index) => identityKey(issuer, `member-${index}`));
let sequence = 0;
const requestId = prefix => `flight-${prefix}-${++sequence}`;
const hasCode = code => error => error?.code === code;

function randomTape() {
  const values = [], calls = [];
  return {
    push: (...next) => values.push(...next), calls,
    sample(maximum) {
      const value = values.length ? values.shift() : 0;
      assert.ok(Number.isSafeInteger(value) && value >= 0 && value < maximum, 'A test random value obeys the trusted server bound');
      calls.push({ maximum, value });
      return value;
    },
  };
}

function memory(t, { count = 2, first = 0, clockMs } = {}) {
  let at = 100000;
  const tape = randomTape();
  const store = createRoomStore({ now: () => at, ...(clockMs === undefined ? {} : { turnTimeoutMs: clockMs }),
    serverRandomInt: maximum => tape.sample(maximum) });
  t.after(() => store.close());
  const host = store.createTrustedRoom(users[0], '同名', { gameType: GAME, code: String(100000 + ++sequence),
    roomId: sequence.toString(16).padStart(32, '0') });
  for (let index = 1; index < count; index++) store.joinTrustedRoom(host.roomCode, users[index], '同名');
  const view = index => store.getTrustedView(host.roomCode, users[index]);
  const action = (index, type, fields = {}, id = requestId(type)) => store.trustedAction(host.roomCode, users[index], {
    type, requestId: id, expectedRevision: view(index).revision, ...fields });
  const start = () => {
    for (let index = 0; index < count; index++) action(index, 'ready', { ready: true });
    tape.push(first); action(0, 'start');
    return view(0);
  };
  return { store, host, view, action, start, tape, now: () => at, set: value => { at = value; } };
}

async function durable(t, { clockMs = 60000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'flying-platform-'));
  const storePath = join(directory, 'business.sqlite'), key = randomBytes(32), opened = [], tape = randomTape();
  let at = 100000;
  const now = () => at;
  function open({ storageHook, archive = true } = {}) {
    const storage = new EncryptedStore(new SQLiteAdapter(storePath, { now }), key, now);
    const wrapped = storageHook ? new Proxy(storage, { get(target, field) {
      if (field === 'guardedCAS') return (...args) => storageHook(args, () => target.guardedCAS(...args));
      const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value;
    } }) : storage;
    const rooms = createDurableRoomStore({ storage: wrapped, now, pollIntervalMs: 0, turnTimeoutMs: clockMs,
      serverRandomInt: maximum => tape.sample(maximum) });
    const history = createMatchHistory({ storage, now });
    if (archive) rooms.setHistory(history);
    const entry = { storage, rooms, history }; opened.push(entry); return entry;
  }
  async function close(entry) {
    if (!entry.closed) { await entry.rooms.close(); entry.storage.close(); entry.closed = true; }
  }
  t.after(async () => { for (const entry of opened) await close(entry); await rm(directory, { recursive: true, force: true }); });
  async function action(entry, host, index, type, fields = {}, id = requestId(type)) {
    const view = await entry.rooms.getView(host.roomCode, users[index]);
    return entry.rooms.action(host.roomCode, users[index], { type, requestId: id, expectedRevision: view.revision, ...fields });
  }
  async function start(entry, { count = 2, first = 0, observer = false } = {}) {
    const host = await entry.rooms.createRoom(users[0], '同名', requestId('create'), GAME);
    for (let index = 1; index < count; index++) await entry.rooms.joinRoom(host.roomCode, users[index], '同名', requestId('join'));
    if (observer) await entry.rooms.joinRoom(host.roomCode, users[7], '同名', requestId('observe'), 'spectator');
    for (let index = 0; index < count; index++) await action(entry, host, index, 'ready', { ready: true });
    tape.push(first); await action(entry, host, 0, 'start');
    return host;
  }
  async function snapshot(entry, host) { return (await entry.storage.read('rooms', host.view.roomId)).value.snapshot; }
  async function restoreProcess(host, index = 0) {
    const worker = fileURLToPath(new URL('./test-support/flying-platform-worker.mjs', import.meta.url));
    const child = spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ storePath, keyHex: key.toString('hex'), at, code: host.roomCode,
      userKey: users[index], roomId: host.view.roomId }));
    const [status] = await once(child, 'exit');
    assert.equal(status, 0, `A fresh synthetic process recovered the room: ${stderr}`);
    return JSON.parse(stdout);
  }
  return { directory, storePath, key, open, close, action, start, snapshot, restoreProcess, tape, now,
    set: value => { at = value; }, advance: ms => { at += ms; } };
}

test('the real third adapter admits 2/3/4 fixed sides and chooses only from seated players', t => {
  assert.equal(defaultGameRegistry.gameAdapter(GAME).gameType, GAME);
  assert.equal(createFlyingChessAdapter().gameType, GAME);
  const sides = { 2: ['red', 'yellow'], 3: ['red', 'blue', 'yellow'], 4: ['red', 'blue', 'yellow', 'green'] };
  for (const count of [2, 3, 4]) {
    const f = memory(t, { count, first: count - 1 });
    const observer = f.store.joinTrustedRoom(f.host.roomCode, users[7], '同名', { role: 'spectator' });
    const started = f.start();
    assert.deepEqual(started.game.players.map(player => player.side), sides[count]);
    assert.equal(started.game.turnPlayerId, started.players[count - 1].id);
    assert.equal(started.turnClock.firstPlayerId, started.players[count - 1].id);
    assert.equal(started.turnClock.durationMs, DEFAULT_TURN_TIMEOUT_MS);
    assert.deepEqual(f.tape.calls, [{ maximum: count, value: count - 1 }]);
    assert.ok(!started.game.players.some(player => player.id === observer.playerId));
    assert.equal(started.game.planes.length, count * 4);
    assert.equal(gameProblem(f.store.exportSnapshot(f.host.roomCode).game), null);
    assert.equal(f.store.exportSnapshot(f.host.roomCode).schemaVersion, 9);
  }
});

test('a real waiting roster change invalidates consent, while spectators and account recovery preserve it', t => {
  const f = memory(t, { count: 2 });
  for (let index = 0; index < 2; index++) f.action(index, 'ready', { ready: true });
  const before = f.view(0), originalId = before.selfId;
  f.store.joinTrustedRoom(f.host.roomCode, users[7], '同名', { role: 'spectator' });
  assert.ok(f.view(0).players.every(player => player.ready));
  const recovered = f.store.joinTrustedRoom(f.host.roomCode, users[0], '更改昵称也不是新席位');
  assert.equal(recovered.playerId, originalId); assert.ok(f.view(0).players.every(player => player.ready));
  f.store.joinTrustedRoom(f.host.roomCode, users[2], '同名');
  assert.ok(f.view(0).players.every(player => !player.ready));
  for (let index = 0; index < 3; index++) f.action(index, 'ready', { ready: true });
  f.action(2, 'set-role', { role: 'spectator' });
  assert.ok(f.view(0).players.every(player => !player.ready));
  for (let index = 0; index < 2; index++) f.action(index, 'ready', { ready: true });
  f.action(2, 'leave');
  assert.ok(f.view(0).players.every(player => player.ready), 'A spectator departure is not a roster change');
  f.action(1, 'leave'); assert.equal(f.view(0).players[0].ready, false);
  assert.equal(f.view(0).turnClock, null); assert.equal(f.view(0).game, null);
});

test('wrong actor, stale revision, spectators, wrong stage and client randomness are rejected before sampling', t => {
  const f = memory(t); f.store.joinTrustedRoom(f.host.roomCode, users[7], '同名', { role: 'spectator' }); f.start();
  const before = f.store.exportSnapshot(f.host.roomCode), count = f.tape.calls.length;
  assert.throws(() => f.action(1, 'roll'), hasCode('INVALID_GAME_ACTION'));
  assert.throws(() => f.action(7, 'roll'), hasCode('SPECTATOR_READ_ONLY'));
  assert.throws(() => f.store.trustedAction(f.host.roomCode, users[6], { type: 'roll', requestId: requestId('outsider'), expectedRevision: f.view(0).revision }), hasCode('SEAT_REQUIRED'));
  assert.throws(() => f.action(0, 'roll', { expectedRevision: before.revision - 1 }), hasCode('REVISION_CONFLICT'));
  for (const extra of [{ die: 6 }, { seed: 1 }, { firstPlayerIndex: 0 }, { serverRandomInt: 0 }, { randomInt: 0 }, { playerId: before.players[1].id }]) {
    assert.throws(() => f.action(0, 'roll', extra), hasCode('INVALID_ACTION'));
  }
  assert.throws(() => f.action(0, 'move', { rollId: 1, planeId: 'red-1' }), hasCode('INVALID_GAME_ACTION'));
  assert.equal(f.tape.calls.length, count); assert.deepEqual(f.store.exportSnapshot(f.host.roomCode).game, before.game);
  f.tape.push(5); f.action(0, 'roll');
  assert.throws(() => f.action(0, 'roll'), hasCode('INVALID_GAME_ACTION'));
  assert.throws(() => f.action(1, 'move', { rollId: 1, planeId: 'yellow-1' }), hasCode('INVALID_GAME_ACTION'));
  assert.equal(f.tape.calls.length, count + 1);
});

test('six-again uses one whole-turn deadline and pause preserves pending die across a new process', async t => {
  const f = await durable(t), a = f.open(), host = await f.start(a);
  const initial = await a.rooms.getView(host.roomCode, users[0]);
  f.advance(5000); f.tape.push(5); await f.action(a, host, 0, 'roll');
  let pending = await a.rooms.getView(host.roomCode, users[0]);
  assert.equal(pending.game.die, 6); assert.deepEqual(pending.turnClock, initial.turnClock);
  await f.action(a, host, 0, 'move', { rollId: pending.game.rollId, planeId: 'red-1' });
  assert.deepEqual((await a.rooms.getView(host.roomCode, users[0])).turnClock, initial.turnClock);
  f.advance(10000); f.tape.push(5); await f.action(a, host, 0, 'roll');
  pending = await a.rooms.getView(host.roomCode, users[0]);
  await f.action(a, host, 0, 'pause'); await f.action(a, host, 1, 'pause');
  const paused = await f.snapshot(a, host);
  assert.equal(paused.game.die, 6); assert.equal(paused.game.stage, 'await-move');
  assert.equal(paused.turnClock.remainingMs, 45000); assert.equal(paused.turnClock.deadlineAt, null);
  await f.close(a); f.advance(500000);
  const reopened = await f.restoreProcess(host);
  assert.equal(reopened.view.phase, 'paused'); assert.deepEqual(reopened.snapshot.game, paused.game);
  assert.deepEqual(reopened.snapshot.turnClock, paused.turnClock);
  assert.equal(reopened.view.game.canRoll, false); assert.deepEqual(reopened.view.game.legalPlaneIds, []);
  assert.deepEqual(reopened.view.game.legalMoves, []);
  const b = f.open();
  await assert.rejects(f.action(b, host, 0, 'move', { rollId: reopened.view.game.rollId, planeId: 'red-2' }), hasCode('GAME_PAUSED'));
  await f.action(b, host, 1, 'resume');
  const resumed = await b.rooms.getView(host.roomCode, users[0]);
  assert.equal(resumed.turnClock.deadlineAt, f.now() + 45000); assert.equal(resumed.game.die, 6);
  await f.action(b, host, 0, 'move', { rollId: resumed.game.rollId, planeId: 'red-2' });
  assert.equal((await b.rooms.getView(host.roomCode, users[0])).turnClock.deadlineAt, resumed.turnClock.deadlineAt);
  assert.equal((await b.rooms.getView(host.roomCode, users[0])).game.round, initial.game.round);
});

test('the persisted request id fences concurrent dice and retries after a true process restart', async t => {
  const f = await durable(t), a = f.open(), b = f.open(), host = await f.start(a);
  const before = await a.rooms.getView(host.roomCode, users[0]); f.tape.push(5, 0, 1);
  const body = { type: 'roll', requestId: requestId('two-devices'), expectedRevision: before.revision };
  const views = await Promise.all([a.rooms.action(host.roomCode, users[0], body), b.rooms.action(host.roomCode, users[0], body)]);
  const saved = await f.snapshot(a, host), samples = f.tape.calls.length;
  assert.equal(saved.game.rollId, 1); assert.equal(saved.revision, before.revision + 1);
  for (const result of views) assert.deepEqual(result.view.game, views[0].view.game);
  await f.close(a); await f.close(b);
  const restored = await f.restoreProcess(host); assert.deepEqual(restored.snapshot.game, saved.game);
  const c = f.open(); const replay = await c.rooms.action(host.roomCode, users[0], body);
  assert.deepEqual(replay.view.game, views[0].view.game); assert.equal(f.tape.calls.length, samples);
  assert.deepEqual(replay.view.actionReceipts.find(receipt => receipt.requestId === body.requestId),
    { requestId: body.requestId, status: 'committed' });
  assert.ok(!(await c.rooms.getView(host.roomCode, users[1])).actionReceipts.some(receipt => receipt.requestId === body.requestId));
  await assert.rejects(c.rooms.action(host.roomCode, users[0], { ...body, expectedRevision: before.revision + 1 }), hasCode('REQUEST_ID_REUSED'));
  assert.equal(f.tape.calls.length, samples);
});

test('a failed SQLite candidate never broadcasts or leaves a receipt; only its successful retry is visible', async t => {
  const f = await durable(t); let rejectNext = false; const candidates = [];
  const a = f.open({ storageHook: async (args, commit) => {
    if (rejectNext && args[0] === 'rooms' && args[3].snapshot?.game?.lastAction?.type === 'roll') {
      rejectNext = false; candidates.push(structuredClone(args[3].snapshot)); return false;
    }
    return commit();
  } });
  const host = await f.start(a), packets = [], unsub = await a.rooms.subscribe(host.roomCode, users[0], view => packets.push(view));
  t.after(unsub); const before = await a.rooms.getView(host.roomCode, users[0]);
  f.tape.push(5, 0); rejectNext = true;
  const body = { type: 'roll', requestId: requestId('retry-candidate'), expectedRevision: before.revision };
  const result = await a.rooms.action(host.roomCode, users[0], body);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].game.lastAction.die, 6);
  assert.equal(result.view.game.lastAction.die, 1); assert.equal(result.view.game.rollId, 1);
  assert.equal(packets.filter(view => view.game.rollId === 1).length, 1);
  assert.ok(packets.every(view => view.game.lastAction?.die !== 6));
  assert.ok(packets.filter(view => view.revision === before.revision).every(view =>
    !view.actionReceipts.some(receipt => receipt.requestId === body.requestId)));
  assert.equal(result.view.actionReceipts.filter(receipt => receipt.requestId === body.requestId && receipt.status === 'committed').length, 1);
  const saved = await f.snapshot(a, host);
  assert.equal(saved.game.lastAction.die, result.view.game.lastAction.die);
  assert.equal(gameProblem(saved.game), null);
  const samples = f.tape.calls.length;
  await a.rooms.action(host.roomCode, users[0], body); assert.equal(f.tape.calls.length, samples);
  assert.equal((await f.snapshot(a, host)).revision, before.revision + 1);
});

test('sampling before the deadline but committing after it discards the candidate and advances timeout once', async t => {
  const f = await durable(t); let expireNext = false; let discarded = null;
  const a = f.open({ storageHook: async (args, commit) => {
    if (expireNext && args[0] === 'rooms' && args[3].snapshot?.game?.lastAction?.type === 'roll') {
      expireNext = false; discarded = structuredClone(args[3].snapshot);
      assert.equal(args[5].scope, 'rooms'); assert.equal(args[5].id, args[1]); assert.equal(args[5].version, args[2]);
      f.set(args[5].validUntil);
    }
    return commit();
  } });
  const host = await f.start(a), before = await a.rooms.getView(host.roomCode, users[0]), packets = [];
  const unsub = await a.rooms.subscribe(host.roomCode, users[0], view => packets.push(view)); t.after(unsub);
  f.set(before.turnClock.deadlineAt - 1); f.tape.push(5); expireNext = true;
  await assert.rejects(a.rooms.action(host.roomCode, users[0], { type: 'roll', requestId: requestId('deadline-race'), expectedRevision: before.revision }), hasCode('REVISION_CONFLICT'));
  assert.equal(discarded.game.die, 6);
  const after = await f.snapshot(a, host);
  assert.equal(after.game.rollId, 0); assert.equal(after.game.round, before.game.round + 1);
  assert.equal(after.game.lastAction.type, 'timeout'); assert.equal(after.game.lastAction.discardedDie, null);
  assert.deepEqual(after.game.planes, before.game.planes);
  assert.ok(packets.every(view => view.game.rollId === 0 && view.game.die === null));
  assert.ok(packets.every(view => !view.actionReceipts.some(receipt => receipt.status === 'committed'
    && receipt.requestId.startsWith('flight-deadline-race'))));
  const b = f.open(); await Promise.all([a.rooms.sweep(), b.rooms.sweep()]);
  assert.equal((await f.snapshot(b, host)).game.round, after.game.round);
});

test('different concurrent requests cannot commit two rolls at the same room revision', async t => {
  const f = await durable(t), a = f.open(), b = f.open(), host = await f.start(a), before = await a.rooms.getView(host.roomCode, users[0]);
  const requests = [0, 1].map(() => ({ type: 'roll', requestId: requestId('conflicting-roll'), expectedRevision: before.revision }));
  f.tape.push(5, 1, 2);
  const results = await Promise.allSettled([a.rooms.action(host.roomCode, users[0], requests[0]), b.rooms.action(host.roomCode, users[0], requests[1])]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const loser = results.findIndex(result => result.status === 'rejected'); assert.equal(results[loser].reason.code, 'REVISION_CONFLICT');
  const saved = await f.snapshot(a, host), samples = f.tape.calls.length;
  assert.equal(saved.game.rollId, 1); assert.equal(saved.revision, before.revision + 1);
  await assert.rejects(b.rooms.action(host.roomCode, users[0], requests[loser]), hasCode('REVISION_CONFLICT'));
  assert.equal(f.tape.calls.length, samples);
  const receipts = (await a.rooms.getView(host.roomCode, users[0])).actionReceipts.filter(receipt => requests.some(input => input.requestId === receipt.requestId));
  assert.equal(receipts.filter(receipt => receipt.status === 'committed').length, 1);
  assert.equal(receipts.filter(receipt => receipt.status === 'rejected').length, 1);
});

test('two SQLite timer owners discard one saved die once without moving a plane or re-rolling', async t => {
  const f = await durable(t), a = f.open(), b = f.open(), host = await f.start(a);
  f.tape.push(5); await f.action(a, host, 0, 'roll');
  const before = await f.snapshot(a, host), samples = f.tape.calls.length;
  f.set(before.turnClock.deadlineAt); await Promise.all([a.rooms.sweep(), b.rooms.sweep()]);
  const after = await f.snapshot(b, host);
  assert.equal(after.game.round, before.game.round + 1); assert.equal(after.revision, before.revision + 1);
  assert.equal(after.game.lastAction.type, 'timeout'); assert.equal(after.game.lastAction.discardedDie, 6);
  assert.equal(after.game.stage, 'await-roll'); assert.equal(after.game.die, null);
  assert.equal(after.turnClock.deadlineAt, f.now() + 60000); assert.deepEqual(after.game.planes, before.game.planes);
  assert.equal(f.tape.calls.length, samples);
  await Promise.all([a.rooms.sweep(), b.rooms.sweep()]); assert.deepEqual((await f.snapshot(a, host)).game, after.game);
});

test('schema9 waiting, awaiting-roll and awaiting-move recover unchanged in fresh Node processes', async t => {
  const f = await durable(t); let entry = f.open();
  const host = await entry.rooms.createRoom(users[0], '同名', requestId('waiting'), GAME);
  await entry.rooms.joinRoom(host.roomCode, users[1], '同名', requestId('waiting-join'));
  const waiting = await f.snapshot(entry, host); assert.equal(waiting.turnClock, null); assert.equal(waiting.schemaVersion, 9);
  await f.close(entry); const waitingRestore = await f.restoreProcess(host);
  assert.deepEqual(waitingRestore.snapshot, waiting); assert.equal(waitingRestore.recent[0].gameType, GAME);
  entry = f.open();
  for (let index = 0; index < 2; index++) await f.action(entry, host, index, 'ready', { ready: true });
  f.tape.push(1); await f.action(entry, host, 0, 'start');
  const roll = await f.snapshot(entry, host); await f.close(entry);
  assert.deepEqual((await f.restoreProcess(host)).snapshot, roll);
  entry = f.open(); f.tape.push(5); await f.action(entry, host, 1, 'roll');
  const move = await f.snapshot(entry, host); await f.close(entry);
  const restored = await f.restoreProcess(host, 1); assert.deepEqual(restored.snapshot, move);
  assert.equal(restored.view.selfId, move.players[1].id); assert.equal(restored.view.game.die, 6);
});

test('finishing the actual game writes exactly one outbox result with only player identities and survives restart', async t => {
  const f = await durable(t), a = f.open({ archive: false }), host = await f.start(a, { count: 3, observer: true });
  const initial = await f.snapshot(a, host), script = completeFirstPlayerScript(initial.game.players.map(player => player.id), 0);
  let finalMove;
  for (const step of script) {
    const index = initial.players.findIndex(player => player.id === step.playerId);
    f.tape.push(step.die - 1); await f.action(a, host, index, 'roll');
    const rolled = await a.rooms.getView(host.roomCode, users[index]);
    if (step.number !== null) {
      const planeId = `${rolled.game.players[index].side}-${step.number}`;
      finalMove = { type: 'move', rollId: rolled.game.rollId, planeId, requestId: requestId('full-game-move'), expectedRevision: rolled.revision };
      await a.rooms.action(host.roomCode, users[index], finalMove);
    }
  }
  const finished = await f.snapshot(a, host);
  assert.equal(gameProblem(finished.game), null); assert.equal(finished.phase, 'finished'); assert.equal(finished.turnClock, null);
  assert.equal(finished.pendingRecords.length, 1);
  const summary = finished.pendingRecords[0]; validateMatchSummary(summary);
  assert.equal(summary.game, GAME); assert.deepEqual(summary.players.map(player => player.outcome), ['win', 'loss', 'loss']);
  assert.deepEqual(summary.players.map(player => player.userKey), users.slice(0, 3));
  assert.ok(summary.players.every(player => player.remainingPoints === null));
  assert.ok(!JSON.stringify(summary).includes(users[7]));
  await f.close(a); const restored = await f.restoreProcess(host);
  assert.equal(restored.view.phase, 'finished'); assert.deepEqual(restored.snapshot.game, finished.game);
  const b = f.open(), c = f.open(); await Promise.all([b.rooms.flushPendingRecords(), c.rooms.flushPendingRecords()]);
  assert.equal((await b.storage.scan('game-history')).length, 1);
  assert.equal((await f.snapshot(b, host)).pendingRecords.length, 0);
  for (let index = 0; index < 3; index++) assert.equal((await b.history.get(users[index])).items.length, 1);
  assert.equal((await b.history.get(users[7])).items.length, 0);
  const sampleCount = f.tape.calls.length;
  await b.rooms.action(host.roomCode, users[0], finalMove); await b.rooms.flushPendingRecords();
  assert.equal((await b.storage.scan('game-history')).length, 1); assert.equal(f.tape.calls.length, sampleCount);
  await f.action(b, host, 1, 'leave');
  const departed = await f.snapshot(b, host); assert.equal(departed.game.players.length, 3); assert.equal(departed.players.length, 2);
  await f.close(b); await f.close(c); assert.equal((await f.restoreProcess(host)).view.phase, 'finished');
});

test('active departure archives an unscored aborted game without discarding stable historic players', async t => {
  const f = await durable(t), a = f.open({ archive: false }), host = await f.start(a, { observer: true });
  f.tape.push(5); await f.action(a, host, 0, 'roll');
  const playing = await f.snapshot(a, host); await f.action(a, host, 0, 'leave');
  const aborted = await f.snapshot(a, host);
  assert.equal(aborted.phase, 'aborted'); assert.equal(aborted.players.length, 1);
  assert.deepEqual(aborted.game, playing.game); assert.equal(aborted.turnClock, null);
  assert.equal(aborted.pendingRecords.length, 1); validateMatchSummary(aborted.pendingRecords[0]);
  assert.ok(aborted.pendingRecords[0].players.every(player => player.outcome === 'unscored'));
  await f.close(a); const restored = await f.restoreProcess(host, 1);
  assert.equal(restored.view.phase, 'aborted'); assert.equal(restored.view.game.result.aborted, true);
  const b = f.open(); await b.rooms.flushPendingRecords(); await b.rooms.flushPendingRecords();
  assert.equal((await b.storage.scan('game-history')).length, 1); assert.equal((await b.history.get(users[7])).items.length, 0);
  const otherIdentity = await b.rooms.joinRoom(host.roomCode, users[6], '同名', requestId('same-name'));
  assert.equal(otherIdentity.view.selfRole, 'spectator'); assert.notEqual(otherIdentity.playerId, playing.players[0].id);
  await assert.rejects(b.rooms.action(host.roomCode, users[6], { type: 'roll', requestId: requestId('same-name-roll'), expectedRevision: otherIdentity.view.revision }), hasCode('SPECTATOR_READ_ONLY'));
});

test('schema9 rejects mismatched participant identities, colors, clock fences and disguised older games atomically', t => {
  const f = memory(t); f.start(); const original = f.store.exportSnapshot(f.host.roomCode);
  const mutators = [
    data => { data.schemaVersion = 8; }, data => { data.gameType = 'rummikub'; },
    data => { data.game.players[0].side = 'yellow'; }, data => { data.turnClock.round++; },
    data => { data.turnClock.playerId = data.players[1].id; }, data => { data.players[0].userKey = data.players[1].userKey; },
    data => { data.matchParticipants[0].userKey = users[6]; }, data => { data.matchParticipants[0].playerId = data.players[1].id; },
    data => { data.spectators.push({ ...data.players[0], id: 'e'.repeat(32), userKey: users[7], ready: false }); data.game.players.push({ id: 'e'.repeat(32), side: 'blue' }); },
  ];
  for (const mutate of mutators) {
    const bad = structuredClone(original); mutate(bad);
    assert.throws(() => f.store.importSnapshot(bad), hasCode('INVALID_SNAPSHOT'));
    assert.deepEqual(f.store.exportSnapshot(f.host.roomCode), original);
  }
});

async function httpFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'flying-http-')); let at = 100000; const now = () => at;
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), tape = randomTape();
  const storage = new EncryptedStore(new SQLiteAdapter(join(directory, 'synthetic.sqlite'), { now }), randomBytes(32), now);
  const provider = new MockProvider(settings, { now }); provider.member = 'member-0';
  provider.complete = async () => ({ issuer, sub: provider.member, accessToken: 'synthetic-only', expiresAt: at + 3600000 });
  provider.check = async identity => ({ sub: identity.sub });
  const runtime = createRuntime(settings, { storage, provider, now, roomOptions: { pollIntervalMs: 0,
    serverRandomInt: maximum => tape.sample(maximum) } });
  const server = createServer({ ...runtime, watchdogMs: 20 });
  t.after(async () => { if (server.listening) await server.shutdown(); else { await runtime.rooms.close(); storage.close(); }
    await rm(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  settings.origin = base; settings.callback = `${base}/auth/callback`; settings.postLogout = `${base}/`;
  async function request(route, { method = 'GET', cookie, csrf, body } = {}) {
    const response = await fetch(base + route, { method, redirect: 'manual', headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: base }),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }
  async function login(index) {
    provider.member = `member-${index}`;
    const begin = await request('/auth/login'); assert.equal(begin.status, 303);
    const tx = begin.headers.getSetCookie()[0].split(';')[0], callbackUrl = new URL(begin.headers.get('location'));
    const callback = await request(callbackUrl.pathname + callbackUrl.search, { cookie: tx }); assert.equal(callback.status, 303);
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith(`${settings.cookieName}=`)).split(';')[0];
    const state = await request('/api/state', { cookie }); assert.equal(state.body.authenticated, true);
    return { cookie, csrf: state.body.csrf };
  }
  return { request, login, tape, runtime, base };
}

test('real unified HTTP rejects forged die and outsiders with zero sampling while preserving same-name seats', async t => {
  const f = await httpFixture(t), a = await f.login(0), b = await f.login(1), observer = await f.login(7), outsider = await f.login(6);
  const created = await f.request('/api/rooms', { method: 'POST', ...a, body: { gameType: GAME, name: '同名', requestId: requestId('http-create') } });
  assert.equal(created.status, 201); const code = created.body.roomCode;
  const joined = await f.request(`/api/rooms/${code}/join`, { method: 'POST', ...b, body: { name: '同名', requestId: requestId('http-join') } });
  assert.equal(joined.status, 201); assert.notEqual(joined.body.playerId, created.body.playerId);
  assert.equal((await f.request(`/api/rooms/${code}/join`, { method: 'POST', ...observer, body: { name: '同名', role: 'spectator', requestId: requestId('http-observe') } })).status, 201);
  async function action(member, type, extra = {}) {
    const state = await f.request(`/api/rooms/${code}`, member);
    return f.request(`/api/rooms/${code}/actions`, { method: 'POST', ...member,
      body: { type, requestId: requestId('http-action'), expectedRevision: state.body.view.revision, ...extra } });
  }
  assert.equal((await action(a, 'ready', { ready: true })).status, 200);
  assert.equal((await action(b, 'ready', { ready: true })).status, 200);
  f.tape.push(0); assert.equal((await action(a, 'start')).status, 200); const samples = f.tape.calls.length;
  assert.equal((await action(a, 'roll', { die: 6 })).status, 400);
  assert.equal((await action(b, 'roll')).status, 409);
  assert.equal((await action(observer, 'roll')).status, 403);
  const outsiderWrite = await f.request(`/api/rooms/${code}/actions`, { method: 'POST', ...outsider,
    body: { type: 'roll', requestId: requestId('outsider-http'), expectedRevision: (await f.request(`/api/rooms/${code}`, a)).body.view.revision } });
  assert.equal(outsiderWrite.status, 403);
  assert.equal((await f.request(`/api/rooms/${code}`)).status, 401); assert.equal(f.tape.calls.length, samples);
  const anotherDevice = await f.login(0), restored = await f.request(`/api/rooms/${code}`, anotherDevice);
  assert.equal(restored.body.view.selfId, created.body.playerId); assert.equal(f.tape.calls.length, samples);
  f.tape.push(5); assert.equal((await action(anotherDevice, 'roll')).status, 200);
  const publicView = await f.request(`/api/rooms/${code}`, observer);
  assert.equal(publicView.body.view.selfRole, 'spectator'); assert.equal(publicView.body.view.game.die, 6);
  for (const forbidden of ['userKey', 'synthetic-only', issuer, 'tokenHash']) assert.ok(!JSON.stringify(publicView.body).includes(forbidden));
});

test('flying-room HTTP and private SSE share chat for both players and spectators without changing a saved roll', {timeout:15000}, async t => {
  const f=await httpFixture(t),a=await f.login(0),b=await f.login(1),observer=await f.login(7),outsider=await f.login(6);
  const created=await f.request('/api/rooms',{method:'POST',...a,body:{gameType:GAME,name:'同名',requestId:requestId('chat-create')}});
  assert.equal(created.status,201);const code=created.body.roomCode,roomPath=`/api/rooms/${code}`,chatPath=`${roomPath}/chat`;
  const joined=await f.request(`${roomPath}/join`,{method:'POST',...b,body:{name:'同名',requestId:requestId('chat-join')}});
  const watched=await f.request(`${roomPath}/join`,{method:'POST',...observer,body:{name:'同名',role:'spectator',requestId:requestId('chat-watch')}});
  assert.equal(joined.status,201);assert.equal(watched.status,201);
  assert.notEqual(joined.body.playerId,created.body.playerId);assert.notEqual(watched.body.playerId,joined.body.playerId);
  async function action(member,type,fields={}) {
    const current=await f.request(roomPath,member);
    const response=await f.request(`${roomPath}/actions`,{method:'POST',...member,body:{type,...fields,requestId:requestId('chat-action'),expectedRevision:current.body.view.revision}});
    assert.equal(response.status,200);return response;
  }
  await action(a,'ready',{ready:true});await action(b,'ready',{ready:true});f.tape.push(0);await action(a,'start');
  f.tape.push(5);await action(a,'roll');
  const before=(await f.request(roomPath,a)).body.view,samples=f.tape.calls.length;
  assert.equal(before.game.stage,'await-move');assert.equal(before.game.die,6);assert.equal(before.game.rollId,1);
  async function openStream(member) {
    const controller=new AbortController();
    const response=await fetch(`${f.base}${roomPath}/events`,{headers:{Cookie:member.cookie},signal:controller.signal});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
    const reader=response.body.getReader(),decoder=new TextDecoder(),packets=[];let pending='';
    t.after(async()=>{controller.abort();await reader.cancel().catch(()=>{});});
    async function until(predicate) {
      for(let attempts=0;attempts<100;attempts++) {
        const found=packets.find(predicate);if(found)return found;
        const part=await reader.read();assert.equal(part.done,false,'Private room events remain available to a current member');
        pending+=decoder.decode(part.value,{stream:true});let boundary;
        while((boundary=/\r?\n\r?\n/.exec(pending))) {
          const raw=pending.slice(0,boundary.index);pending=pending.slice(boundary.index+boundary[0].length);
          const lines=raw.split(/\r?\n/),event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim();
          const data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
          if(event&&data)packets.push({event,data:JSON.parse(data)});
        }
      }
      assert.fail('Expected a bounded room event');
    }
    await until(packet=>packet.event==='view');await until(packet=>packet.event==='chat');
    return {packets,until};
  }
  const peerStream=await openStream(b),observerStream=await openStream(observer);
  const inputs=[{member:a,text:'房主的中文消息'},{member:b,text:'非当前回合的朋友消息'},{member:observer,text:'观众也能参与聊天'}];
  const confirmations=[];
  for(const input of inputs) {
    input.body={text:input.text,requestId:requestId('shared-chat')};
    const result=await f.request(chatPath,{method:'POST',...input.member,body:input.body});
    assert.equal(result.status,200);confirmations.push(result.body.message);
  }
  assert.deepEqual(confirmations.map(message=>message.playerId),[created.body.playerId,joined.body.playerId,watched.body.playerId]);
  for(const stream of [peerStream,observerStream]) {
    await stream.until(packet=>packet.event==='chat'&&packet.data.latestSequence===3);
    const messages=stream.packets.filter(packet=>packet.event==='chat').flatMap(packet=>packet.data.messages);
    assert.deepEqual(messages.map(message=>message.text),inputs.map(input=>input.text));
    assert.equal(new Set(messages.map(message=>message.messageId)).size,3);
    for(const secret of ['synthetic-only',issuer,'authorUserKey','tokenHash',...users])assert.ok(!JSON.stringify(stream.packets).includes(secret));
  }
  const duplicate=await f.request(chatPath,{method:'POST',...a,body:inputs[0].body});
  assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicate,true);assert.equal(duplicate.body.message.messageId,confirmations[0].messageId);
  const history=(await f.request(chatPath,b)).body;
  assert.equal(history.messages.length,3);assert.equal(history.latestSequence,3);
  assert.equal(history.messages[0].requestId,undefined);assert.equal(history.messages[1].requestId,inputs[1].body.requestId);assert.equal(history.messages[2].requestId,undefined);
  assert.equal((await f.request(chatPath)).status,401);
  assert.equal((await f.request(chatPath,outsider)).status,403);
  assert.equal((await f.request(chatPath,{method:'POST',...outsider,body:{text:'同名但没有入席',requestId:requestId('outside-chat')}})).status,403);
  const deniedStream=await fetch(`${f.base}${roomPath}/events`,{headers:{Cookie:outsider.cookie}});
  assert.equal(deniedStream.status,403);assert.doesNotMatch(deniedStream.headers.get('content-type'),/text\/event-stream/);
  assert.ok(!(await deniedStream.text()).includes(inputs[0].text));
  const after=(await f.request(roomPath,a)).body.view;
  assert.equal(after.revision,before.revision);assert.deepEqual(after.game,before.game);assert.deepEqual(after.turnClock,before.turnClock);
  assert.equal(f.tape.calls.length,samples);
});

test('a completed flying room exposes only the original public participant names after its winner leaves',t=>{
  const f=memory(t),first=f.start(),ids=first.game.players.map(player=>player.id);
  for(const step of completeFirstPlayerScript(ids,0)){
    const index=ids.indexOf(step.playerId);f.tape.push(step.die-1);f.action(index,'roll');
    if(step.number!==null){const rolled=f.view(index);f.action(index,'move',{rollId:rolled.game.rollId,planeId:`${rolled.game.players[index].side}-${step.number}`});}
  }
  assert.equal(f.view(1).phase,'finished');const original=f.view(1).matchPlayers;
  f.action(0,'leave');const remaining=f.view(1);assert.deepEqual(remaining.matchPlayers,original);
  assert.deepEqual(remaining.matchPlayers,ids.map(id=>({id,name:'同名'})));assert.ok(!/userKey|seatId|token|rack/.test(JSON.stringify(remaining.matchPlayers)));
  const restored=createRoomStore({now:f.now});t.after(()=>restored.close());restored.importSnapshot(f.store.exportSnapshot(f.host.roomCode));
  assert.deepEqual(restored.getTrustedView(f.host.roomCode,users[1]).matchPlayers,original);
  f.action(1,'rematch');assert.deepEqual(f.view(1).matchPlayers,[]);
});
