import test from 'node:test';
import assert from 'node:assert/strict';
import { gameAdapter } from './game-registry.mjs';

const people = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const options = { randomInt: (maximum) => maximum - 1, firstTurnIndex: 0 };

test('Rummikub adapter permits optional public positions on turn endings and strictly validates saved coordinates', () => {
  const adapter = gameAdapter(), game = adapter.createGame(people, options);
  assert.deepEqual(adapter.actionFields('submit'), ['boardIds', 'rackIds', 'boardPositions']);
  assert.deepEqual(adapter.actionFields('draw'), ['boardPositions']); assert.deepEqual(adapter.actionFields('pass'), ['boardPositions']);
  assert.equal(adapter.stateProblem(game), null);
  game.boardPositions = [{ x: .2, y: .3 }];
  assert.match(adapter.stateProblem(game), /位置/);
  assert.throws(() => adapter.spectatorView(game), /位置/);
  delete game.boardPositions;
  assert.equal(adapter.stateProblem(game), null);
  assert.equal(adapter.spectatorView(game).boardPositions, null);
});

test('Rummikub spectator can follow real submitted cards and normalized layout while all hands and pool IDs stay private', () => {
  const adapter = gameAdapter(), game = adapter.createGame(people, options);
  const played = ['red-10-a', 'blue-10-a', 'black-10-a'];
  const result = adapter.applyGameAction(game, 'alice', { type: 'submit', boardIds: [played],
    rackIds: game.players[0].rack.filter(({ id }) => !played.includes(id)).map(({ id }) => id),
    boardPositions: [{ x: .25, y: .65 }] });
  assert.equal(result.ok, true, result.error);
  const view = adapter.spectatorView(result.state);
  assert.equal(view.gameType, 'rummikub'); assert.equal(view.turnPlayerId, 'bob');
  assert.deepEqual(view.boardPositions, [{ x: .25, y: .65 }]);
  for (const field of ['rack', 'pool', 'playerId', 'opened']) assert.equal(Object.hasOwn(view, field), false);
  const text = JSON.stringify(view);
  for (const tile of [...result.state.pool, ...result.state.players.flatMap(({ rack }) => rack)]) {
    assert.equal(text.includes(`"${tile.id}"`), false, `private tile leaked: ${tile.id}`);
  }
  view.boardPositions[0].x = .9; view.board[0][0].value = 99; view.players[0].name = 'changed';
  assert.equal(result.state.boardPositions[0].x, .25); assert.equal(result.state.players[0].name, 'Alice');
  assert.equal(result.state.board[0][0].value, 10);
});

test('army spectators see concealed cells without physical IDs, side, kind or legal private actions', () => {
  const adapter = gameAdapter('army-flip'), game = adapter.createGame(people, options);
  const view = adapter.spectatorView(game);
  assert.equal(view.gameType, 'army-flip'); assert.equal(Object.hasOwn(view, 'playerId'), false);
  assert.deepEqual(view.legalFlips, []); assert.deepEqual(view.legalMoves, []);
  assert.deepEqual(view.legalPickups, []);
  assert.equal(view.board.filter(({ piece }) => piece?.hidden).length, 50);
  for (const { piece } of view.board) if (piece) assert.deepEqual(piece, { hidden: true });
  const text = JSON.stringify(view);
  for (const { piece } of game.board) if (piece) assert.equal(text.includes(`"${piece.id}"`), false);
  const next = structuredClone(game), hidden = next.board.filter(({ piece }) => piece && !piece.revealed);
  [hidden[0].piece, hidden[1].piece] = [hidden[1].piece, hidden[0].piece];
  assert.equal(adapter.stateProblem(next), null);
  assert.deepEqual(adapter.spectatorView(next), view, 'hidden swaps must not leak through any public projection');
});

test('army spectators follow a real flip but never receive player action permission', () => {
  const adapter = gameAdapter('army-flip'), game = adapter.createGame(people, options);
  const target = adapter.privateView(game, 'alice').legalFlips[0];
  const result = adapter.applyGameAction(game, 'alice', { type: 'flip', cellId: target,
    requestId: 'test-transport', expectedRevision: 0 });
  assert.equal(result.ok, true, result.error);
  const view = adapter.spectatorView(result.state), piece = view.board.find(({ cellId }) => cellId === target).piece;
  assert.equal(piece.hidden, false); assert.equal(typeof piece.kind, 'string');
  assert.equal(view.lastAction.cellId, target); assert.equal(view.turnPlayerId, 'bob');
  assert.deepEqual(view.legalFlips, []); assert.deepEqual(view.legalMoves, []);
  assert.deepEqual(view.legalPickups, []);
  view.board.find(({ cellId }) => cellId === target).piece.kind = 'secret'; view.players[0].name = 'changed';
  assert.notEqual(result.state.board.find(({ cellId }) => cellId === target).piece.kind, 'secret');
  assert.equal(result.state.players[0].name, 'Alice');
});

test('spectator adapter does not forward player-specific or arbitrary top-level fields from a future projection', () => {
  const normal = gameAdapter(), game = normal.createGame(people, options);
  const custom = { createGame: normal.createGame, applyGameAction: normal.applyGameAction,
    privateView: (state, id) => ({ ...normal.privateView(state, id), csrf: 'private-token', accessToken: 'private-token', internalSecret: 'secret' }) };
  const view = gameAdapter('rummikub', { gameEngine: custom }).spectatorView(game);
  for (const field of ['rack', 'playerId', 'opened', 'csrf', 'accessToken', 'internalSecret']) assert.equal(Object.hasOwn(view, field), false);
  assert.equal(view.poolCount, game.pool.length);
});
