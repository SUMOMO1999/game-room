import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createMatchHistory, HISTORY_RETENTION_MS, historyQuery, validateMatchSummary } from '../server/match-history.mjs';

const a = identityKey('urn:synthetic-history', 'a'), b = identityKey('urn:synthetic-history', 'b');
const id = (value) => value.toString(16).padStart(32, '0');
function summary(number = 1, overrides = {}) {
  return { matchId: id(number), roomId: id(900), roomCode: '123456', game: 'rummikub', ruleVersion: 'friends-v2',
    startedAt: 1000, endedAt: 10000, status: 'completed', reason: 'cleared-rack',
    players: [{ userKey: a, seatId: id(100), nickname: '甲', outcome: 'win', remainingPoints: 0 },
      { userKey: b, seatId: id(101), nickname: '乙', outcome: 'loss', remainingPoints: 31 }], ...overrides };
}
async function fixture(t, sqlite = false) {
  let time = 10000; const now = () => time, key = randomBytes(32);
  const opened = [], directory = sqlite ? await mkdtemp(join(tmpdir(), 'game-history-')) : null;
  const shared = new MemoryAdapter({ now });
  function open() {
    const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(join(directory, 'test.sqlite'), { now }) : shared, key, now);
    opened.push(storage); return { storage, history: createMatchHistory({ storage, now }) };
  }
  t.after(async () => { for (const storage of opened) storage.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  return { open, now, advance: (ms) => { time += ms; } };
}

test('normal wins and losses use remaining hand points; aborted matches never count as played or lost', async (t) => {
  const f = await fixture(t), { history } = f.open();
  await history.archive(summary());
  await history.archive(summary(2, { status: 'aborted', reason: 'player-left', players: summary().players.map((player) => ({ ...player, outcome: 'unscored', remainingPoints: null })) }));
  const view = await history.get(a);
  assert.deepEqual(view.stats, { completed: 1, wins: 1, draws: 0, losses: 0, aborted: 1, periodDays: 180 });
  assert.equal(view.items.length, 2); assert.equal(view.retentionDays, 180);
  assert.deepEqual((await history.get(b)).stats, { completed: 1, wins: 0, draws: 0, losses: 1, aborted: 1, periodDays: 180 });
  assert.deepEqual(view.items[1].self, { outcome: 'win', remainingPoints: 0 });
  for (const secret of [a, b, '"userKey"', '"seatId"', '"roomId"', '"rack"', '"issuer"', '"sub"', '"token"']) assert.equal(JSON.stringify(view).includes(secret), false);
});

test('blocked-pool equal winners are draws, with no fabricated cumulative score', async (t) => {
  const f = await fixture(t), { history } = f.open();
  await history.archive(summary(1, { reason: 'pool-blocked', players: summary().players.map((player) => ({ ...player, outcome: 'draw', remainingPoints: 7 })) }));
  assert.equal((await history.get(a)).stats.draws, 1);
  assert.equal((await history.get(a)).stats.wins, 0);
  assert.equal((await history.get(b)).items[0].self.remainingPoints, 7);
});

test('same match and concurrent matches archive once across SQLite instances and restarts', async (t) => {
  const f = await fixture(t, true), x = f.open(), y = f.open();
  await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? x : y).history.archive(summary())));
  assert.equal((await x.storage.scan('game-history')).length, 1);
  assert.equal((await x.storage.read('history-index', a)).value.entries.length, 1);
  await Promise.all(Array.from({ length: 35 }, (_, index) => (index % 2 ? x : y).history.archive(summary(index + 2))));
  const restarted = f.open();
  assert.equal((await restarted.history.get(a)).stats.completed, 36);
  assert.equal((await restarted.history.get(a)).items.length, 30);
  assert.equal((await restarted.storage.read('history-index', b)).value.entries.length, 36);
});

test('a failed second player index keeps the archive durable and replay repairs it without duplicates', async (t) => {
  const f = await fixture(t, true), { storage } = f.open(); let interrupted = true;
  const unreliable = new Proxy(storage, { get(target, name) {
    if (name === 'putIfAbsent') return async (...args) => {
      if (args[0] === 'history-index' && args[1] === b && interrupted) { interrupted = false; throw new Error('synthetic interruption'); }
      return target.putIfAbsent(...args);
    };
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(createMatchHistory({ storage: unreliable, now: f.now }).archive(summary()), /synthetic interruption/);
  assert.ok(await storage.read('game-history', id(1)));
  assert.equal((await storage.read('history-index', a)).value.entries.length, 1);
  assert.equal(await storage.read('history-index', b), null);
  const restored = f.open();
  await restored.history.archive(summary()); await restored.history.archive(summary());
  assert.equal((await restored.history.get(b)).stats.losses, 1);
  assert.equal((await restored.storage.scan('game-history')).length, 1);
});

test('match collision is rejected without changing the original score, player list or index', async (t) => {
  const f = await fixture(t), { history, storage } = f.open(); await history.archive(summary());
  const altered = summary(); altered.players[1].remainingPoints = 99;
  await assert.rejects(history.archive(altered), (error) => error.code === 'HISTORY_CONFLICT');
  assert.equal((await history.get(b)).items[0].self.remainingPoints, 31);
  assert.equal((await storage.read('history-index', b)).value.entries.length, 1);
});

test('private fields, forged outcomes, invalid timestamps and untrusted identities cannot become history', async (t) => {
  const f = await fixture(t), { history } = f.open();
  for (const bad of [summary(1, { rack: ['secret'] }), summary(1, { startedAt: null }), summary(1, { endedAt: 10001 }),
    summary(1, { players: summary().players.map((player) => ({ ...player, rack: [] })) }),
    summary(1, { players: summary().players.map((player) => ({ ...player, outcome: 'win' })) })]) await assert.rejects(history.archive(bad));
  await assert.rejects(history.get('not-a-user'), (error) => error.status === 401);
  assert.throws(() => validateMatchSummary(summary(1, { status: 'aborted' })), /Invalid/);
  assert.deepEqual((await history.get(identityKey('urn:other-history', 'a'))).items, []);
});

test('pagination has stable ties, signed identity-bound cursors and full retention-period counts', async (t) => {
  const f = await fixture(t), { history } = f.open();
  for (let index = 1; index <= 33; index++) await history.archive(summary(index));
  const first = await history.get(a, { limit: 10 }); assert.equal(first.stats.completed, 33); assert.equal(first.items[0].matchId, id(33));
  const second = await history.get(a, { limit: 10, cursor: first.nextCursor }); assert.equal(second.items[0].matchId, id(23));
  const third = await history.get(a, { limit: 30, cursor: second.nextCursor }); assert.equal(third.items.length, 13); assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map((item) => item.matchId)).size, 33);
  await assert.rejects(history.get(b, { cursor: first.nextCursor }), (error) => error.code === 'INVALID_HISTORY_CURSOR');
  await assert.rejects(history.get(a, { cursor: first.nextCursor.slice(0, -1) + 'x' }), (error) => error.code === 'INVALID_HISTORY_CURSOR');
  f.advance(15 * 60000);
  await assert.rejects(history.get(a, { cursor: first.nextCursor }), (error) => error.code === 'INVALID_HISTORY_CURSOR');
});

test('180-day expiry, replays and late reads never renew history lifetime', async (t) => {
  const f = await fixture(t), { history, storage } = f.open(); await history.archive(summary());
  const before = await storage.read('game-history', id(1));
  f.advance(HISTORY_RETENTION_MS - 1); await history.archive(summary());
  assert.equal((await storage.read('game-history', id(1))).expiresAt, before.expiresAt);
  assert.equal((await history.get(a)).stats.completed, 1);
  f.advance(1); assert.equal((await history.get(a)).stats.completed, 0);
  assert.deepEqual(await history.archive(summary()), { matchId: id(1), expired: true });
  assert.equal(await storage.read('game-history', id(1)), null);
  assert.equal(await storage.read('history-index', a), null);
});

test('pre-existing games keep unknown start time explicit rather than fabricating it', async (t) => {
  const f = await fixture(t), { history } = f.open();
  await history.archive(summary(1, { legacy: true, startedAt: null, ruleVersion: 'friends-v1' }));
  const item = (await history.get(a)).items[0]; assert.equal(item.startedAt, null); assert.equal(item.legacy, true);
});

test('history query rejects duplicate, identity-bearing, unlimited and malformed parameters', () => {
  assert.deepEqual(historyQuery(new URLSearchParams()), { limit: 30 });
  assert.deepEqual(historyQuery(new URLSearchParams('limit=1')), { limit: 1 });
  for (const query of ['limit=0', 'limit=31', 'limit=01', 'limit=5&limit=6', 'cursor=', 'userKey=x', 'other=1'])
    assert.throws(() => historyQuery(new URLSearchParams(query)), (error) => error.status === 400);
});
