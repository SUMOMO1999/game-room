import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecentRoom, roomPhaseLabel, exitConsequence, createExitRequest, historyOutcome, historyPoints } from './lobby-model.mjs';

test('server recent-room metadata is display-only and does not import identity or credentials', () => {
  const value = normalizeRecentRoom({ roomCode: '123456', playerId: 'seat-a', phase: 'paused', name: '<script>',
    at: 20, expiresAt: 50, playersCount: 2, connectedCount: 1, hostName: '朋友', token: 'secret', userKey: 'forged', hostId: 'seat-a' });
  assert.deepEqual(value, { roomCode: '123456', playerId: 'seat-a', phase: 'paused', name: '<script>', at: 20,
    expiresAt: 50, playersCount: 2, connectedCount: 1, hostName: '朋友' });
  assert.equal(normalizeRecentRoom({ roomCode: '../room', playerId: 'seat-a' }), null);
  assert.equal(normalizeRecentRoom({ roomCode: '123456', playerId: '' }), null);
});
test('legacy recent rooms remain compatible and invalid metadata cannot create fictitious occupancy', () => {
  const value = normalizeRecentRoom({ roomCode: '123456', playerId: 'seat-a', name: '朋友', at: 20,
    playersCount: 100, connectedCount: -1, expiresAt: Infinity });
  assert.equal(value.playersCount, undefined); assert.equal(value.expiresAt, undefined);
  assert.equal(roomPhaseLabel(undefined), '原来的房间');
  assert.equal(roomPhaseLabel('paused'), '暂停保存');
});
test('server game type is retained without client authority, and explicit unknown types cannot become another game', () => {
  const input={roomCode:'123456',playerId:'seat-a',gameType:'army-flip',minPlayers:2,maxPlayers:2,side:'red'};
  const value=normalizeRecentRoom(input);
  assert.equal(value.gameType,'army-flip');assert.equal(value.side,undefined);
  assert.equal(normalizeRecentRoom({...input,gameType:'flying-chess'}).gameType,'flying-chess');
  assert.equal(normalizeRecentRoom({...input,gameType:'unknown'}),null);
});
test('explicit departure describes unfinished-game consequences and uses the current server revision', () => {
  assert.match(exitConsequence('paused'), /结束当前这一局/);
  assert.match(exitConsequence('finished'), /最后一人/);
  assert.deepEqual(createExitRequest({ phase: 'finished', revision: 5, hostId: 'ignored' }, 'exit-1'),
    { type: 'leave', expectedRevision: 5, requestId: 'exit-1' });
  assert.throws(() => createExitRequest({ phase: 'playing', revision: -1 }, 'exit-1'));
  assert.throws(() => createExitRequest({ phase: 'unknown', revision: 0 }, 'exit-1'));
});
test('aborted games never display a win and native remaining points are never labelled cumulative points', () => {
  assert.equal(historyOutcome({ status: 'aborted', self: { outcome: 'win' } }), '已中止 · 不计输赢');
  assert.equal(historyOutcome({ status: 'completed', self: { outcome: 'win' } }), '胜');
  assert.equal(historyPoints(30), '剩余手牌 30 点');
  assert.equal(historyPoints(null), '未计分');
});
