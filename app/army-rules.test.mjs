import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame as createVersionedGame, applyGameAction, privateView, gameProblem } from './army-rules.mjs';
const createGame = (players, options = {}) => createVersionedGame(players, { ...options, ruleVersion: 'army-flip-v1' });
import { BOARD_CELLS, PIECE_COUNTS } from './army-board.mjs';
const players = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const initial = (options = {}) => createGame(players, { randomInt: (max) => max - 1, firstTurnIndex: 0, ...options });
const allPieces = (game) => [...game.board.flatMap(({ piece }) => piece ? [piece] : []), ...game.captured];
const moveSet = (game, id = 'alice') => new Set(privateView(game, id).legalMoves.map(({ from, to }) => `${from}:${to}`));
function success(game, id, action) {
  const original = structuredClone(game), result = applyGameAction(game, id, action);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(game, original);
  assert.equal(gameProblem(result.state), null);
  assert.equal(result.state.revision, game.revision + 1);
  assert.deepEqual(allPieces(result.state).map(({ id }) => id).sort(), allPieces(game).map(({ id }) => id).sort());
  return result.state;
}
function failure(game, id, action, expression) {
  const original = structuredClone(game), result = applyGameAction(game, id, action);
  assert.equal(result.ok, false); assert.equal(typeof result.error, 'string');
  if (expression) assert.match(result.error, expression);
  assert.deepEqual(game, original); assert.equal('state' in result, false);
}
/** A complete conserved fifty-piece position, not a fabricated partial deck. */
function position(placements, { hidden = [], turnIndex = 0 } = {}) {
  const game = initial(), byId = new Map(allPieces(game).map((piece) => [piece.id, piece]));
  const entries = { r0c1: 'red-flag-1', r11c3: 'black-flag-1', ...placements };
  const used = new Set();
  game.board = BOARD_CELLS.map(({ cellId }) => {
    const id = entries[cellId];
    if (!id) return { cellId, piece: null };
    assert.ok(byId.has(id)); assert.ok(!used.has(id)); used.add(id);
    return { cellId, piece: { ...byId.get(id), revealed: !hidden.includes(cellId) } };
  });
  game.captured = [...byId.values()].filter(({ id }) => !used.has(id)).map((piece) => ({ ...piece, revealed: true }));
  game.players[0].side = 'red'; game.players[1].side = 'black';
  game.players[0].lastFlipSide = 'red'; game.players[1].lastFlipSide = 'black';
  game.turnIndex = turnIndex; game.round = 51; game.revision = 51;
  game.lastAction = { type: 'decline-draw', playerId: 'bob' };
  assert.equal(gameProblem(game), null, `fixture invalid: ${JSON.stringify(placements)}`);
  return game;
}
const find = (game, id) => game.board.find(({ piece }) => piece?.id === id).cellId;

test('army production game keeps 50 canonical pieces, ten empty camps and randomized first turn', () => {
  for (let index = 0; index < 5; index += 1) {
    const game = createGame(players);
    assert.equal(gameProblem(game), null); assert.equal(allPieces(game).length, 50);
    assert.equal(new Set(allPieces(game).map(({ id }) => id)).size, 50);
    for (const side of ['red', 'black']) for (const [kind, count] of Object.entries(PIECE_COUNTS)) {
      assert.equal(allPieces(game).filter((piece) => piece.side === side && piece.kind === kind).length, count);
    }
    assert.ok(game.board.every(({ cellId, piece }) => BOARD_CELLS.find((cell) => cell.cellId === cellId).terrain === 'camp' ? piece === null : piece && !piece.revealed));
    assert.ok([0, 1].includes(game.turnIndex)); assert.equal(game.assignment, 'two-flips');
    assert.ok(game.players.every(({ side }) => side === null));
  }
});
test('army injectable bounded shuffle and starter are deterministic without accepting client layouts', () => {
  const calls = [];
  const game = createGame(players, { randomInt: (max) => { calls.push(max); return max - 1; } });
  assert.deepEqual(calls, [...Array.from({ length: 49 }, (_, i) => 50 - i), 2]);
  assert.equal(game.turnIndex, 1); assert.deepEqual(initial(), initial());
  assert.throws(() => initial({ randomInt: (max) => max }), /随机源/);
  assert.throws(() => initial({ randomInt: null }), /随机源/);
  assert.throws(() => initial({ firstTurnIndex: 2 }), /首位/);
  assert.throws(() => initial({ assignment: 'bomb-neutral' }), /阵营/);
});
test('army requires exactly two distinct valid players', () => {
  for (const list of [[], [players[0]], [...players, { id: 'c', name: 'C' }]]) assert.throws(() => createGame(list), /两位/);
  assert.throws(() => createGame([players[0], players[0]]), /重复/);
  assert.throws(() => createGame([players[0], { id: 'b', name: ' ' }]), /名字/);
});
test('army first-flip variant assigns both camps after one reveal', () => {
  let game = initial({ assignment: 'first-flip' });
  game = success(game, 'alice', { type: 'flip', cellId: find(game, 'black-commander-1') });
  assert.equal(game.players[0].side, 'black'); assert.equal(game.players[1].side, 'red');
  assert.equal(game.turnIndex, 1); assert.equal(game.round, 2);
});
test('army two-flips means consecutive own turns, includes colored bombs and ignores opponent color', () => {
  let game = initial();
  game = success(game, 'alice', { type: 'flip', cellId: find(game, 'red-bomb-1') });
  assert.equal(game.players[0].side, null);
  game = success(game, 'bob', { type: 'flip', cellId: find(game, 'black-bomb-1') });
  assert.equal(game.players[0].side, null);
  game = success(game, 'alice', { type: 'flip', cellId: find(game, 'red-bomb-2') });
  assert.equal(game.players[0].side, 'red'); assert.equal(game.players[1].side, 'black');
  assert.equal(game.players[0].lastFlipSide, 'red');
});
test('army alternating own colors reset the streak rather than using any two same-colored reveals', () => {
  let game = initial();
  for (const [playerId, pieceId] of [['alice', 'red-commander-1'], ['bob', 'black-commander-1'],
    ['alice', 'black-general-1'], ['bob', 'red-general-1'], ['alice', 'red-engineer-1']]) {
    game = success(game, playerId, { type: 'flip', cellId: find(game, pieceId) });
    assert.equal(game.players[0].side, null);
  }
  game = success(game, 'bob', { type: 'flip', cellId: find(game, 'red-engineer-2') });
  assert.equal(game.players[1].side, 'red'); assert.equal(game.players[0].side, 'black');
});
test('army fifty genuine alternating reveals without a same-color own streak finish as a draw instead of deadlocking', () => {
  let game = initial();
  const pieces = allPieces(game), red = pieces.filter(({ side }) => side === 'red'), black = pieces.filter(({ side }) => side === 'black');
  const sequence = [];
  for (let turn = 0; turn < 25; turn += 1) {
    sequence.push((turn % 2 === 0 ? red : black).shift(), (turn % 2 === 0 ? black : red).shift());
  }
  assert.equal(red.length, 0); assert.equal(black.length, 0);
  let pieceIndex = 0;
  for (const entry of game.board) if (entry.piece) entry.piece = sequence[pieceIndex++];
  assert.equal(gameProblem(game), null);
  for (let step = 0; step < 50; step += 1) {
    const playerId = game.players[game.turnIndex].id, view = privateView(game, playerId);
    game = success(game, playerId, { type: 'flip', cellId: view.legalFlips[0] });
    assert.ok(game.players.every(({ side }) => side === null));
    assert.equal(game.status, step === 49 ? 'finished' : 'playing');
  }
  assert.equal(game.round, 51); assert.equal(game.revision, 50);
  assert.equal(game.result.reason, 'assignment-exhausted'); assert.equal(game.result.tie, true);
  assert.deepEqual(game.result.winnerIds, []); assert.equal(game.winnerId, null);
  assert.deepEqual(privateView(game, 'alice').legalFlips, []);
  assert.deepEqual(privateView(game, 'alice').legalMoves, []);
  assert.equal(privateView(game, 'alice').board.filter(({ piece }) => piece?.hidden === false).length, 50);
  failure(game, 'bob', { type: 'flip', cellId: 'r0c0' }, /结束/);
  const forged = structuredClone(game); forged.status = 'playing'; forged.result = null;
  assert.equal(typeof gameProblem(forged), 'string');
  const fakeEarly = success(initial(), 'bob', { type: 'resign' });
  fakeEarly.result.reason = 'assignment-exhausted'; fakeEarly.result.tie = true; fakeEarly.result.winnerIds = []; fakeEarly.winnerId = null;
  assert.equal(typeof gameProblem(fakeEarly), 'string');
});
test('army rejects wrong turns, outsiders, invalid positions and premature or dark moves atomically', () => {
  const game = initial();
  failure(game, 'bob', { type: 'flip', cellId: 'r0c0' }, /轮到/);
  failure(game, 'outsider', { type: 'resign' }, /不在/);
  failure(game, 'alice', { type: 'move', from: 'r0c0', to: 'r0c1' }, /尚未/);
  failure(game, 'alice', { type: 'flip', cellId: 'r2c1' }, /没有/);
  failure(game, 'alice', { type: 'flip', cellId: 'r00c0' }, /位置/);
  failure(game, 'alice', { type: 'flip', cellId: 'r0c0', side: 'red' }, /参数/);
  failure(game, 'alice', null, /不支持/);
  const changed = success(game, 'alice', { type: 'flip', cellId: 'r0c0' });
  failure(changed, 'bob', { type: 'flip', cellId: 'r0c0' }, /没有/);
});
test('army dark projection has no physical identity, side, kind, captured statistics or alias reference', () => {
  const game = initial(), view = privateView(game, 'alice');
  assert.equal(view.legalFlips.length, 50); assert.deepEqual(view.legalMoves, []);
  for (const { piece } of view.board) if (piece) assert.deepEqual(piece, { hidden: true });
  assert.equal(JSON.stringify(view).includes('red-commander-1'), false);
  assert.equal('captured' in view, false); assert.deepEqual(view.capturedPieces, []);
  view.players[0].name = 'changed'; view.board[0].piece.hidden = false;
  assert.equal(game.players[0].name, 'Alice'); assert.equal(game.board[0].piece.revealed, false);
  assert.equal(privateView(game, 'bob').legalFlips.length, 0);
  assert.throws(() => privateView(game, 'stranger'), /不在/);
});
test('army public projection exposes a flipped label and legal cells without revealing remaining dark pieces', () => {
  const game = success(initial(), 'alice', { type: 'flip', cellId: 'r0c0' });
  const view = privateView(game, 'bob');
  assert.deepEqual(view.board[0].piece, { hidden: false, id: 'red-commander-1', side: 'red', kind: 'commander', label: '司令' });
  assert.equal(view.legalFlips.length, 49); assert.deepEqual(view.board[1].piece, { hidden: true });
});
test('army permuting every unrevealed identity leaves both players public projection and legal moves unchanged', () => {
  let game = initial();
  for (const [playerId, pieceId] of [['alice', 'red-flag-1'], ['bob', 'black-flag-1'], ['alice', 'red-commander-1']]) {
    game = success(game, playerId, { type: 'flip', cellId: find(game, pieceId) });
  }
  const shuffledSecrets = structuredClone(game);
  const hidden = shuffledSecrets.board.filter(({ piece }) => piece && !piece.revealed);
  const pieces = hidden.map(({ piece }) => piece).reverse();
  hidden.forEach((entry, index) => { entry.piece = pieces[index]; });
  assert.equal(gameProblem(shuffledSecrets), null);
  assert.notDeepEqual(shuffledSecrets.board, game.board);
  for (const { id } of players) assert.deepEqual(privateView(shuffledSecrets, id), privateView(game, id));
});
test('army ordinary railway pieces travel straight but cannot turn onto side rails or use a road-plus-rail shortcut', () => {
  const game = position({ r1c2: 'red-commander-1', r10c2: 'black-engineer-1' });
  const moves = moveSet(game);
  assert.ok(moves.has('r1c2:r1c4')); assert.ok(moves.has('r1c2:r1c0'));
  assert.ok(!moves.has('r1c2:r2c4')); assert.ok(!moves.has('r1c2:r3c2'));
  failure(game, 'alice', { type: 'move', from: 'r1c2', to: 'r2c4' });
});
test('army engineer can turn continuously along railway, including the center bridge, but cannot chain roads', () => {
  const game = position({ r1c2: 'red-engineer-1', r10c2: 'black-engineer-1' });
  const moves = moveSet(game);
  assert.ok(moves.has('r1c2:r6c2')); assert.ok(moves.has('r1c2:r9c4'));
  assert.ok(!moves.has('r1c2:r3c2')); assert.ok(!moves.has('r1c2:r11c0'));
  const next = success(game, 'alice', { type: 'move', from: 'r1c2', to: 'r6c2' });
  assert.equal(next.board.find(({ cellId }) => cellId === 'r6c2').piece.id, 'red-engineer-1');
});
test('army engineer starting off railway cannot walk onto it then use a railway route in the same turn', () => {
  const game = position({ r0c2: 'red-engineer-1', r10c2: 'black-company-1' });
  assert.ok(moveSet(game).has('r0c2:r1c2'));
  assert.ok(!moveSet(game).has('r0c2:r1c4'));
  assert.ok(!moveSet(game).has('r0c2:r6c2'));
  failure(game, 'alice', { type: 'move', from: 'r0c2', to: 'r1c4' });
});
test('army railway blockers include allies, enemies and dark pieces; no jumping beyond any blocker', () => {
  const game = position({ r1c0: 'red-commander-1', r1c2: 'red-general-1', r10c0: 'black-engineer-1' });
  assert.ok(moveSet(game).has('r1c0:r1c1')); assert.ok(!moveSet(game).has('r1c0:r1c3'));
  const enemy = position({ r1c0: 'red-commander-1', r1c2: 'black-general-1', r10c0: 'black-engineer-1' });
  assert.ok(moveSet(enemy).has('r1c0:r1c2')); assert.ok(!moveSet(enemy).has('r1c0:r1c3'));
  const dark = position({ r1c0: 'red-commander-1', r1c2: 'black-general-1', r10c0: 'black-engineer-1' }, { hidden: ['r1c2'] });
  assert.ok(!moveSet(dark).has('r1c0:r1c2')); assert.ok(!moveSet(dark).has('r1c0:r1c3'));
});
test('army camps allow their printed diagonal road, protect enemy occupants and never enable other diagonal travel', () => {
  const game = position({ r1c0: 'red-company-1', r2c1: 'black-engineer-1', r10c4: 'black-company-1' });
  failure(game, 'alice', { type: 'move', from: 'r1c0', to: 'r2c1' });
  const empty = position({ r1c0: 'red-company-1', r10c4: 'black-company-1' });
  assert.ok(moveSet(empty).has('r1c0:r2c1')); assert.ok(!moveSet(empty).has('r1c0:r2c2'));
  success(empty, 'alice', { type: 'move', from: 'r1c0', to: 'r2c1' });
});
test('army headquarters are ordinary movable stations in this explicitly versioned flip variant', () => {
  const game = position({ r0c3: 'red-commander-1', r10c4: 'black-company-1' });
  assert.ok(moveSet(game).has('r0c3:r1c3'));
  success(game, 'alice', { type: 'move', from: 'r0c3', to: 'r1c3' });
});
test('army military ranks capture weaker, sacrifice weaker attackers and remove both equal ranks', () => {
  for (const [attacker, defender, outcome, survivors] of [
    ['red-commander-1', 'black-company-1', 'capture', 'red-commander-1'],
    ['red-company-1', 'black-commander-1', 'attacker-lost', 'black-commander-1'],
    ['red-company-1', 'black-company-1', 'mutual', null],
  ]) {
    const game = position({ r1c1: attacker, r1c2: defender, r10c4: 'black-engineer-1' });
    const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
    assert.equal(next.lastAction.outcome, outcome);
    assert.equal(next.board.find(({ cellId }) => cellId === 'r1c2').piece?.id ?? null, survivors);
  }
});
test('army engineer removes a mine while ordinary pieces cannot attack it', () => {
  const game = position({ r1c1: 'red-engineer-1', r1c2: 'black-mine-1', r10c4: 'black-company-1' });
  const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.board.find(({ cellId }) => cellId === 'r1c2').piece.id, 'red-engineer-1');
  const ordinary = position({ r1c1: 'red-commander-1', r1c2: 'black-mine-1', r10c4: 'black-company-1' });
  failure(ordinary, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
});
test('army bombs remove both pieces against any rank, a mine, or another bomb', () => {
  for (const defender of ['black-commander-1', 'black-mine-1', 'black-bomb-1']) {
    const game = position({ r1c1: 'red-bomb-1', r1c2: defender, r10c4: 'black-company-1' });
    const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
    assert.equal(next.lastAction.outcome, 'mutual');
    assert.equal(next.board.find(({ cellId }) => cellId === 'r1c2').piece, null);
  }
});
test('army immovable mines and flags cannot move and losing a commander never auto-reveals the flag', () => {
  const game = position({ r1c1: 'red-commander-1', r1c2: 'black-bomb-1', r10c4: 'black-company-1', r0c0: 'red-mine-1' }, { hidden: ['r0c1'] });
  failure(game, 'alice', { type: 'move', from: 'r0c0', to: 'r1c0' });
  failure(game, 'alice', { type: 'move', from: 'r0c1', to: 'r1c1' });
  const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.board.find(({ cellId }) => cellId === 'r0c1').piece.revealed, false);
});
test('army flags stay protected by even an unrevealed surviving mine; bombs cannot bypass protection', () => {
  for (const attacker of ['red-company-1', 'red-bomb-1']) {
    const game = position({ r10c3: attacker, r11c4: 'black-mine-1', r10c0: 'black-company-1' }, { hidden: ['r11c4'] });
    failure(game, 'alice', { type: 'move', from: 'r10c3', to: 'r11c3' });
  }
});
test('army captures an exposed flag after all three mines are gone even when another piece remains dark', () => {
  const game = position({ r10c3: 'red-company-1', r10c0: 'black-company-1', r1c1: 'black-engineer-1' }, { hidden: ['r1c1'] });
  const next = success(game, 'alice', { type: 'move', from: 'r10c3', to: 'r11c3' });
  assert.equal(next.status, 'finished'); assert.equal(next.winnerId, 'alice');
  assert.deepEqual(next.result, { reason: 'flag-captured', winnerIds: ['alice'],
    scores: [{ playerId: 'alice', name: 'Alice', points: null }, { playerId: 'bob', name: 'Bob', points: null }], tie: false });
  failure(next, 'bob', { type: 'resign' }, /结束/);
});
test('army bomb flag capture wins after clearing mines even though both bomb and flag disappear', () => {
  const game = position({ r10c3: 'red-bomb-1', r10c0: 'black-company-1' });
  const next = success(game, 'alice', { type: 'move', from: 'r10c3', to: 'r11c3' });
  assert.equal(next.result.reason, 'flag-captured'); assert.equal(next.winnerId, 'alice');
  assert.equal(next.board.find(({ cellId }) => cellId === 'r11c3').piece, null);
});
test('army absence of movable enemy pieces cannot end a game while any dark piece can still be flipped', () => {
  const game = position({ r1c0: 'red-company-1', r10c0: 'black-engineer-1' }, { hidden: ['r10c0'] });
  const next = success(game, 'alice', { type: 'move', from: 'r1c0', to: 'r1c1' });
  assert.equal(next.status, 'playing'); assert.equal(privateView(next, 'bob').legalFlips.length, 1);
  assert.deepEqual(privateView(next, 'bob').legalMoves, []);
});
test('army no dark pieces plus no legal enemy moves causes automatic blocked loss', () => {
  const game = position({ r1c1: 'red-commander-1', r1c2: 'black-company-1' });
  const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.status, 'finished'); assert.equal(next.result.reason, 'blocked');
  assert.equal(next.winnerId, 'alice'); assert.equal(next.turnIndex, 1);
});
test('army offers and declines do not consume a chess turn, no repeated pending offer or self-acceptance', () => {
  let game = success(initial(), 'bob', { type: 'offer-draw' });
  assert.equal(game.turnIndex, 0); assert.equal(game.round, 1); assert.equal(game.drawOfferByPlayerId, 'bob');
  failure(game, 'bob', { type: 'offer-draw' }, /已有/);
  failure(game, 'bob', { type: 'accept-draw' }, /对方/);
  failure(game, 'bob', { type: 'decline-draw' }, /对方/);
  game = success(game, 'alice', { type: 'decline-draw' });
  assert.equal(game.round, 1); assert.equal(game.drawOfferByPlayerId, null);
  failure(game, 'alice', { type: 'accept-draw' }, /对方/);
});
test('army mutually accepted draw before assignment has no winner and nullable scores', () => {
  let game = success(initial(), 'bob', { type: 'offer-draw' });
  game = success(game, 'alice', { type: 'accept-draw' });
  assert.equal(game.status, 'finished'); assert.equal(game.winnerId, null);
  assert.deepEqual(game.result.winnerIds, []); assert.equal(game.result.tie, true);
  assert.ok(game.result.scores.every(({ points }) => points === null));
  failure(game, 'alice', { type: 'flip', cellId: 'r0c0' }, /结束/);
});
test('army normal move or reveal clears a pending draw; resignation can happen outside turn or before assignment', () => {
  const offered = success(initial(), 'bob', { type: 'offer-draw' });
  const flipped = success(offered, 'alice', { type: 'flip', cellId: 'r0c0' });
  assert.equal(flipped.drawOfferByPlayerId, null);
  const ended = success(initial(), 'bob', { type: 'resign' });
  assert.equal(ended.winnerId, 'alice'); assert.equal(ended.result.reason, 'resigned');
  assert.equal(ended.round, 1); assert.equal(ended.players[0].side, null);
});
test('army rejects corrupted conserved deck, cell graph, version, sides, scores and forged winner snapshots', () => {
  const corruptions = [
    (g) => { g.version = 2; }, (g) => { g.ruleVersion = 'army-flip-v2'; },
    (g) => { g.assignment = 'neutral'; }, (g) => { g.board[0].piece.kind = 'flag'; },
    (g) => { g.board[1].piece.id = g.board[0].piece.id; }, (g) => { g.board[0].piece = null; },
    (g) => { g.board[0].cellId = 'r1c0'; }, (g) => { g.board[0].piece.revealed = 'yes'; },
    (g) => { g.board[0].piece.hack = true; }, (g) => { g.players[0].side = 'red'; },
    (g) => { g.board[11].piece = g.board[0].piece; g.board[0].piece = null; },
    (g) => { g.revision = -1; }, (g) => { g.turnIndex = 2; },
    (g) => { g.winnerId = 'alice'; }, (g) => { g.drawOfferByPlayerId = 'stranger'; },
  ];
  for (const alter of corruptions) {
    const game = initial(); alter(game);
    assert.equal(typeof gameProblem(game), 'string');
    failure(game, 'alice', { type: 'resign' });
    assert.throws(() => privateView(game, 'alice'));
  }
  const ended = success(initial(), 'bob', { type: 'resign' });
  for (const alter of [(g) => { g.result.scores[0].points = 10; },
    (g) => { g.result.winnerIds = ['bob']; g.winnerId = 'bob'; },
    (g) => { g.result.reason = 'flag-captured'; },
    (g) => { g.result.scores.reverse(); }, (g) => { g.lastAction.type = 'accept-draw'; }]) {
    const game = structuredClone(ended); alter(game); assert.equal(typeof gameProblem(game), 'string');
  }
});
test('army simulated complete reveal and legal play retains every piece and exposes no remaining hidden attributes', () => {
  let game = initial();
  for (let step = 0; step < 50 && game.status === 'playing'; step += 1) {
    const playerId = game.players[game.turnIndex].id, view = privateView(game, playerId);
    assert.ok(view.legalFlips.length);
    game = success(game, playerId, { type: 'flip', cellId: view.legalFlips[0] });
  }
  assert.equal(game.board.filter(({ piece }) => piece && !piece.revealed).length, 0);
  assert.ok(game.players.every(({ side }) => side !== null));
  for (let step = 0; step < 30 && game.status === 'playing'; step += 1) {
    const playerId = game.players[game.turnIndex].id, view = privateView(game, playerId);
    assert.ok(view.legalMoves.length);
    const target = view.legalMoves.find(({ to }) => game.board.find(({ cellId }) => cellId === to).piece)
      ?? view.legalMoves[step % view.legalMoves.length];
    game = success(game, playerId, { type: 'move', ...target });
  }
  assert.equal(allPieces(game).length, 50); assert.equal(gameProblem(game), null);
});
