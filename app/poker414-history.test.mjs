import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EncryptedStore, MemoryAdapter, identityKey } from '../server/storage.mjs';
import { createGameRegistry } from './game-registry.mjs';
import { createPoker414Adapter } from '../server/games/poker414-2/adapter.mjs';
import { createMatchHistory, validateMatchSummary, validateHistoryRecord } from '../server/match-history.mjs';

const id = number => number.toString(16).padStart(32, '0');
const users = [0, 1, 2].map(number => identityKey('urn:synthetic-414-history', String(number)));
const gameRegistry = createGameRegistry([createPoker414Adapter()]);
function summary() {
  const deltas = [11, -5, -6];
  return { matchId: id(1), roomId: id(2), roomCode: '234567', game: 'poker414-2', ruleVersion: 'poker414-2-v2',
    accountGroup: '4a4', scoringVersion: 'poker414-2-score-v1', settlementVersion: 0,
    startedAt: 1000, endedAt: 10000, status: 'completed', reason: 'emptied-hand',
    deltas: users.map((userKey, index) => ({ userKey, delta: deltas[index] })),
    players: users.map((userKey, index) => ({ userKey, seatId: id(index + 10), nickname: `同名伙伴${index}`,
      outcome: index === 0 ? 'win' : 'loss', score: deltas[index], balanceAfter: deltas[index] })) };
}
function fixture(t) {
  const now = () => 10000, storage = new EncryptedStore(new MemoryAdapter({ now }), randomBytes(32), now);
  t.after(() => storage.close());
  return { storage, history: createMatchHistory({ storage, now, gameRegistry }) };
}

test('414 history preserves settlement-time balances and safe public deltas without account identifiers', async t => {
  const { storage, history } = fixture(t), input = summary();
  await history.archive(input);
  const record = await storage.read('game-history', input.matchId);
  assert.equal(record.value.schemaVersion, 3); validateHistoryRecord(record.value, { gameRegistry });
  const item = (await history.get(users[1])).items[0];
  assert.equal(item.accountGroup, '4a4'); assert.equal(item.settlementVersion, 0);
  assert.equal(item.scoringVersion, 'poker414-2-score-v1');
  assert.equal(item.self.score, -5); assert.equal(item.self.balanceAfter, -5);
  assert.deepEqual(item.deltas, input.deltas.map((entry, index) => ({ nickname: input.players[index].nickname, delta: entry.delta })));
  for (const secret of [...users, 'userKey', 'seatId', 'roomId', 'participants']) assert.equal(JSON.stringify(item).includes(secret), false);
});

test('replaying reordered fields is idempotent, but changed scores or saved balances conflict', async t => {
  const { history } = fixture(t), input = summary(); await history.archive(input);
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  reversed.players = reversed.players.map(player => Object.fromEntries(Object.entries(player).reverse()));
  reversed.deltas = reversed.deltas.map(delta => Object.fromEntries(Object.entries(delta).reverse()));
  await history.archive(reversed);
  const changedBalance = structuredClone(input); changedBalance.players[0].balanceAfter++;
  await assert.rejects(history.archive(changedBalance), error => error.code === 'HISTORY_CONFLICT');
  const changedScore = structuredClone(input);
  changedScore.players[0].score++; changedScore.players[1].score--;
  changedScore.deltas[0].delta++; changedScore.deltas[1].delta--;
  await assert.rejects(history.archive(changedScore), error => error.code === 'HISTORY_CONFLICT');
  assert.equal((await history.get(users[0])).stats.wins, 1);
  assert.equal((await history.get(users[0])).items[0].self.balanceAfter, 11);
});

test('414 historical summaries reject uncommitted, mismatched, nonzero-sum and private fields', () => {
  const invalid = [
    value => { delete value.players[0].balanceAfter; },
    value => { value.accountGroup = 'stock'; },
    value => { value.scoringVersion = 'unknown'; },
    value => { value.deltas[0].userKey = users[1]; },
    value => { value.deltas[0].delta++; },
    value => { value.players[0].score++; },
    value => { value.players[0].balanceAfter = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.deltas[0].hand = ['secret']; },
    value => { value.players[0].hand = ['secret']; },
    value => { value.deck = ['secret']; },
  ];
  for (const mutate of invalid) {
    const value = summary(); mutate(value);
    assert.throws(() => validateMatchSummary(value, { gameRegistry }), /Invalid/);
  }
});

test('voluntary payment and system cancellation archive as unscored while keeping explicit deltas', async t => {
  const { history } = fixture(t);
  for (const [index, reason, values] of [[0, 'voluntary-leave', [-10, 5, 5]], [1, 'server-recovery', [0, 0, 0]]]) {
    const value = summary(); value.matchId = id(index + 20); value.status = 'aborted'; value.reason = reason;
    value.players.forEach((player, playerIndex) => { player.outcome = 'unscored'; player.score = values[playerIndex]; player.balanceAfter = values[playerIndex]; });
    value.deltas.forEach((entry, playerIndex) => { entry.delta = values[playerIndex]; });
    await history.archive(value);
  }
  const packet = await history.get(users[0]);
  assert.equal(packet.stats.aborted, 2); assert.equal(packet.stats.completed, 0);
  assert.deepEqual(packet.items.map(item => item.self.score), [0, -10]);
});
