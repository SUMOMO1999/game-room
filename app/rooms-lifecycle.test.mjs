import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomStore } from './rooms.mjs';

const options = { firstTurnIndex: 0, randomInt: (maximum) => maximum - 1 };
const keys = ['a', 'b', 'c'].map((key) => key.repeat(64));
let sequence = 0;
function fixture(count = 2, extra = {}) {
  let time = 1000;
  const store = createRoomStore({ now: () => time, gameOptions: options, ...extra });
  const host = store.createTrustedRoom(keys[0], '甲', { code: '234567', roomId: 'd'.repeat(32) });
  const seats = [host];
  for (let index = 1; index < count; index++) seats.push(store.joinTrustedRoom(host.roomCode, keys[index], `玩家${index}`));
  const act = (index, type, fields = {}, context) => store.trustedAction(host.roomCode, keys[index], {
    type, requestId: `life-${++sequence}`, expectedRevision: store.getTrustedView(host.roomCode, keys[index]).revision, ...fields,
  }, context);
  const start = () => { for (let index = 0; index < count; index++) act(index, 'ready', { ready: true }); return act(0, 'start').view; };
  return { store, host, seats, act, start, advance: (milliseconds) => { time += milliseconds; }, time: () => time };
}

test('playing departure aborts without deleting original cards or participants; last departure closes with replay receipt', () => {
  const f = fixture(); const initial = f.start(), raw = f.store.exportSnapshot(f.host.roomCode).game;
  const input = { type: 'leave', requestId: 'depart-playing', expectedRevision: initial.revision };
  assert.deepEqual(f.store.trustedAction(f.host.roomCode, keys[0], input), { view: null, left: true });
  assert.deepEqual(f.store.trustedAction(f.host.roomCode, keys[0], input), { view: null, left: true });
  assert.throws(() => f.store.getTrustedView(f.host.roomCode, keys[0]), { code: 'SEAT_REQUIRED' });
  const view = f.store.getTrustedView(f.host.roomCode, keys[1]);
  assert.equal(view.phase, 'aborted'); assert.equal(view.game.status, 'aborted');
  assert.deepEqual(view.game.result, { reason: 'player-left', winnerIds: [], scores: [], tie: false, aborted: true });
  assert.equal(view.hostId, f.seats[1].playerId); assert.equal(view.players.length, 1);
  const saved = f.store.exportSnapshot(f.host.roomCode);
  assert.deepEqual(saved.game, raw); assert.equal(saved.pendingRecords.length, 1);
  assert.ok(saved.pendingRecords[0].players.every((player) => player.outcome === 'unscored' && player.remainingPoints === null));
  assert.ok(!JSON.stringify(view).includes(keys[0]));
  assert.throws(() => f.act(1, 'draw'), { code: 'GAME_NOT_PLAYING' });
  const leave = { type: 'leave', requestId: 'last-depart', expectedRevision: view.revision };
  assert.deepEqual(f.store.trustedAction(f.host.roomCode, keys[1], leave), { view: null, left: true });
  assert.deepEqual(f.store.trustedAction(f.host.roomCode, keys[1], leave), { view: null, left: true });
  assert.throws(() => f.store.getTrustedView(f.host.roomCode, keys[1]), { code: 'ROOM_NOT_FOUND' });
  assert.equal(f.store.exportSnapshot(f.host.roomCode).pendingRecords.length, 1);
  assert.throws(() => f.store.createTrustedRoom(keys[0], '新房', { code: f.host.roomCode, roomId: 'e'.repeat(32) }), { code: 'ROOM_EXISTS' });
});

test('finished departure retains original result snapshots and rematch creates a new match after fresh readiness', () => {
  const f = fixture(); const first = f.start(); let view = first;
  while (view.game.poolCount) view = f.act(keys.indexOf(f.store.exportSnapshot(f.host.roomCode).players.find((p) => p.id === view.game.turnPlayerId).userKey), 'draw').view;
  for (let index = 0; index < 2; index++) view = f.act(keys.indexOf(f.store.exportSnapshot(f.host.roomCode).players.find((p) => p.id === view.game.turnPlayerId).userKey), 'pass').view;
  const result = structuredClone(view.game.result), pending = f.store.exportSnapshot(f.host.roomCode).pendingRecords;
  f.act(0, 'leave');
  const remaining = f.store.getTrustedView(f.host.roomCode, keys[1]);
  assert.equal(remaining.phase, 'finished'); assert.deepEqual(remaining.game.result, result);
  assert.equal(remaining.game.players.length, 2); assert.deepEqual(f.store.exportSnapshot(f.host.roomCode).pendingRecords, pending);
  f.act(1, 'rematch'); f.store.joinTrustedRoom(f.host.roomCode, keys[2], '新朋友');
  f.act(1, 'ready', { ready: true }); f.act(2, 'ready', { ready: true });
  const second = f.act(1, 'start').view; assert.notEqual(second.matchId, first.matchId);
  assert.equal(f.store.exportSnapshot(f.host.roomCode).pendingRecords.length, 1);
});

test('pause needs every present member, retains seven days only after unanimity, and any member may resume', () => {
  const f = fixture(2, { ttlMs: 1000, pausedTtlMs: 7000 }); const first = f.start();
  f.advance(400); const proposed = f.act(0, 'pause').view;
  assert.equal(proposed.phase, 'playing'); assert.equal(proposed.expiresAt, first.expiresAt);
  assert.deepEqual(proposed.pause.agreedIds, [f.seats[0].playerId]);
  f.advance(400); const paused = f.act(1, 'pause').view;
  assert.equal(paused.phase, 'paused'); assert.equal(paused.expiresAt, f.time() + 7000);
  assert.deepEqual(f.store.getTrustedView(f.host.roomCode, keys[0]).game.rack, first.game.rack); assert.equal(paused.game.status, 'paused');
  assert.throws(() => f.act(0, 'draw'), { code: 'GAME_PAUSED' });
  f.advance(2000); assert.equal(f.store.getTrustedView(f.host.roomCode, keys[1]).phase, 'paused');
  const resumed = f.act(1, 'resume').view; assert.equal(resumed.phase, 'playing'); assert.equal(resumed.expiresAt, f.time() + 1000);
  assert.equal(resumed.game.turnPlayerId, first.game.turnPlayerId);
});

test('pause cancellation, paused leave and restored legacy game preserve consent and original game rules', () => {
  const f = fixture(); f.start(); f.act(0, 'pause');
  assert.equal(f.act(0, 'pause', { agree: false }).view.pause, null);
  const old = f.store.exportSnapshot(f.host.roomCode); old.schemaVersion = 1;
  for (const key of ['matchId', 'matchStartedAt', 'matchParticipants', 'pendingRecords', 'leaveReceipts', 'pauseVote']) delete old[key];
  old.game.ruleVersion = 'friends-v1';
  const restored = createRoomStore({ now: f.time, gameOptions: options }); restored.importSnapshot(old);
  assert.equal(restored.getTrustedView(f.host.roomCode, keys[0]).game.ruleVersion, 'friends-v1');
  const id = restored.exportSnapshot(f.host.roomCode).matchId; assert.match(id, /^[a-f0-9]{32}$/);
  const again = createRoomStore({ now: f.time }); again.importSnapshot(old); assert.equal(again.exportSnapshot(f.host.roomCode).matchId, id);
  f.act(0, 'pause'); f.act(1, 'pause'); f.act(0, 'leave');
  assert.equal(f.store.getTrustedView(f.host.roomCode, keys[1]).phase, 'aborted');
});

test('host departure chooses connected member; takeover is server-owned and cannot nominate a different player', () => {
  const f = fixture(3);
  const context = { connected: { [f.seats[2].playerId]: true }, hostCanTakeOver: false };
  f.act(0, 'leave', {}, context);
  assert.equal(f.store.getTrustedView(f.host.roomCode, keys[1]).hostId, f.seats[2].playerId);
  assert.throws(() => f.act(1, 'transferHost', {}, context), { code: 'HOST_ACTIVE' });
  assert.throws(() => f.act(1, 'transferHost', { playerId: f.seats[2].playerId }, { connected: {}, hostCanTakeOver: true }), { code: 'HOST_ACTIVE' });
  assert.equal(f.act(1, 'transferHost', {}, { connected: {}, hostCanTakeOver: true }).view.hostId, f.seats[1].playerId);
  assert.equal(f.act(1, 'transferHost', { playerId: f.seats[2].playerId }, context).view.hostId, f.seats[2].playerId);
});

test('public activity is bounded, contains no private credentials, and metadata actions preserve the game revision', () => {
  const f = fixture(); const initial = f.start(), gameRevision = initial.game.revision;
  const input = { type: 'pause', agree: true, requestId: 'once-public-pause', expectedRevision: initial.revision };
  const proposed = f.store.trustedAction(f.host.roomCode, keys[0], input).view;
  assert.equal(proposed.activity.length, initial.activity.length + 1);
  const replay = f.store.trustedAction(f.host.roomCode, keys[0], input).view;
  assert.deepEqual(replay.activity, proposed.activity);
  assert.throws(() => f.act(1, 'pass'), { code: 'INVALID_GAME_ACTION' });
  assert.deepEqual(f.store.getTrustedView(f.host.roomCode, keys[0]).activity, proposed.activity);
  f.act(1, 'pause'); f.act(1, 'resume'); f.act(0, 'transferHost', { playerId: f.seats[1].playerId });
  assert.equal(f.store.getTrustedView(f.host.roomCode, keys[0]).game.revision, gameRevision);
  for (let index = 0; index < 45; index++) { f.act(0, 'pause'); f.act(0, 'pause', { agree: false }); }
  const view = f.store.getTrustedView(f.host.roomCode, keys[0]);
  assert.equal(view.activity.length, 40); assert.ok(view.activity[0].sequence > 1);
  assert.equal(new Set(view.activity.map((entry) => entry.id)).size, 40);
  assert.ok(!JSON.stringify(view.activity).includes(keys[0]));
  assert.ok(!/rack|token|userKey/.test(JSON.stringify(view.activity)));
  const restored = createRoomStore({ now: f.time }); restored.importSnapshot(f.store.exportSnapshot(f.host.roomCode));
  assert.deepEqual(restored.getTrustedView(f.host.roomCode, keys[0]).activity, view.activity);
});

test('legacy finished snapshots keep existing settlement without inventing archived timestamps or records', () => {
  const f = fixture(); f.start(); let view = f.store.getTrustedView(f.host.roomCode, keys[0]);
  while (view.game.poolCount || view.phase !== 'finished') {
    const player = f.store.exportSnapshot(f.host.roomCode).players.find((entry) => entry.id === view.game.turnPlayerId);
    view = f.act(keys.indexOf(player.userKey), view.game.poolCount ? 'draw' : 'pass').view;
  }
  const old = f.store.exportSnapshot(f.host.roomCode); old.schemaVersion = 1;
  for (const key of ['matchId', 'matchStartedAt', 'matchEndedAt', 'matchParticipants', 'pendingRecords', 'activity', 'activitySequence']) delete old[key];
  const restored = createRoomStore({ now: f.time }); restored.importSnapshot(old);
  const snapshot = restored.exportSnapshot(f.host.roomCode);
  assert.equal(snapshot.matchStartedAt, null); assert.equal(snapshot.matchEndedAt, null);
  assert.deepEqual(snapshot.pendingRecords, []); assert.deepEqual(snapshot.game.result, view.game.result);
  const again = createRoomStore({ now: f.time }); again.importSnapshot(snapshot);
  assert.deepEqual(again.getTrustedView(f.host.roomCode, keys[0]).game.result, view.game.result);
});
