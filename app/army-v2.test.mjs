import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, privateView, gameProblem } from './army-rules.mjs';
import { BOARD_CELLS, ARMY_HOME_BASES } from './army-board.mjs';

const players = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const initial = (options = {}) => createGame(players, { randomInt: max => max - 1, firstTurnIndex: 0, ruleVersion: 'army-flip-v2', ...options });
const entities = game => [...game.board.flatMap(({ piece }) => piece ? [piece] : []),
  ...game.captured, ...(game.flagTokens ?? []).map(({ piece }) => piece)];
const entry = (game, cellId) => game.board.find(item => item.cellId === cellId);
const at = (game, id) => game.board.find(({ piece }) => piece?.id === id)?.cellId;
const moves = (game, id = 'alice') => new Set(privateView(game, id).legalMoves.map(({ from, to }) => `${from}:${to}`));
function success(game, id, action) {
  const before = structuredClone(game), result = applyGameAction(game, id, action);
  assert.equal(result.ok, true, result.error); assert.deepEqual(game, before);
  assert.equal(gameProblem(result.state), null);
  assert.equal(result.state.revision, game.revision + 1);
  assert.deepEqual(entities(result.state).map(({ id }) => id).sort(), entities(game).map(({ id }) => id).sort());
  return result.state;
}
function failure(game, id, action, expression) {
  const before = structuredClone(game), result = applyGameAction(game, id, action);
  assert.equal(result.ok, false); assert.equal(typeof result.error, 'string');
  if (expression) assert.match(result.error, expression);
  assert.deepEqual(game, before); assert.equal('state' in result, false);
}
/** Fifty complete canonical entities, including transported flags. */
function position(placements, { hidden = [], tokens = [], turnIndex = 0 } = {}) {
  const game = initial(), canonical = new Map(entities(game).map(piece => [piece.id, piece]));
  const defaults = { r0c1: 'red-flag-1', r11c3: 'black-flag-1' };
  for (const [cellId, id] of Object.entries(defaults)) if (Object.values(placements).includes(id)
      || tokens.some(token => token.id === id)) delete defaults[cellId];
  const layout = { ...defaults, ...placements }, used = new Set();
  game.board = BOARD_CELLS.map(({ cellId }) => {
    const id = layout[cellId]; if (!id) return { cellId, piece: null };
    assert.ok(canonical.has(id)); assert.ok(!used.has(id)); used.add(id);
    return { cellId, piece: { ...canonical.get(id), revealed: !hidden.includes(cellId) } };
  });
  game.flagTokens = tokens.map(({ id, carrierId = null, cellId = null }) => {
    assert.ok(canonical.has(id)); assert.ok(!used.has(id)); used.add(id);
    return { piece: { ...canonical.get(id), revealed: true }, carrierId, cellId };
  });
  game.captured = [...canonical.values()].filter(({ id }) => !used.has(id)).map(piece => ({ ...piece, revealed: true }));
  game.players[0].side = 'red'; game.players[1].side = 'black';
  game.players[0].lastFlipSide = 'red'; game.players[1].lastFlipSide = 'black';
  game.turnIndex = turnIndex; game.round = 51; game.revision = 51;
  game.lastAction = { type: 'decline-draw', playerId: 'bob' };
  assert.equal(gameProblem(game), null, `fixture: ${JSON.stringify(placements)}`);
  return game;
}

test('explicit v2 retains its exact old schema; explicit v1 keeps its exact old schema and cannot be silently upgraded', () => {
  assert.equal(initial().version, 2); assert.equal(initial().ruleVersion, 'army-flip-v2');
  assert.deepEqual(initial().flagTokens, []); assert.equal(gameProblem(initial()), null);
  const old = initial({ ruleVersion: 'army-flip-v1' });
  assert.equal(old.version, 1); assert.equal('flagTokens' in old, false);
  const next = success(old, 'alice', { type: 'flip', cellId: 'r0c0' });
  assert.equal(next.ruleVersion, 'army-flip-v1'); assert.equal('legalPickups' in privateView(next, 'bob'), false);
  assert.throws(() => initial({ ruleVersion: 'army-flip-v9' }), /版本/);
});
test('v2 headquarters are fixed public zones independent of random flag or color assignment', () => {
  assert.deepEqual(ARMY_HOME_BASES, { red: ['r11c1', 'r11c3'], black: ['r0c1', 'r0c3'] });
  assert.ok(Object.isFrozen(ARMY_HOME_BASES) && Object.isFrozen(ARMY_HOME_BASES.red));
});
test('v2 dark endpoint attempts do not jump the occupied endpoint or peek at its identity', () => {
  const game = position({ r1c0: 'red-company-1', r1c2: 'black-general-1', r10c0: 'black-engineer-1' }, { hidden: ['r1c2'] });
  assert.ok(moves(game).has('r1c0:r1c2')); assert.ok(!moves(game).has('r1c0:r1c3'));
  const next = success(game, 'alice', { type: 'move', from: 'r1c0', to: 'r1c2' });
  assert.equal(next.lastAction.outcome, 'attacker-lost'); assert.equal(entry(next, 'r1c2').piece.revealed, true);
  assert.equal(next.round, game.round + 1); assert.equal(next.turnIndex, 1);
});
test('v2 collision with an own dark piece reveals it and leaves both positions intact', () => {
  const game = position({ r1c1: 'red-company-1', r1c2: 'red-general-1', r10c0: 'black-engineer-1' }, { hidden: ['r1c2'] });
  const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.lastAction.outcome, 'friendly-reveal'); assert.equal(entry(next, 'r1c1').piece.id, 'red-company-1');
  assert.equal(entry(next, 'r1c2').piece.id, 'red-general-1'); assert.equal(entry(next, 'r1c2').piece.revealed, true);
  assert.equal(next.captured.length, game.captured.length); assert.equal(next.turnIndex, 1);
});
test('v2 dark enemy ranks publicly resolve capture, sacrifice, and equal-rank mutual loss', () => {
  for (const [attacker, defender, outcome] of [
    ['red-commander-1', 'black-company-1', 'capture'],
    ['red-company-1', 'black-commander-1', 'attacker-lost'],
    ['red-company-1', 'black-company-1', 'mutual'],
  ]) {
    const game = position({ r1c1: attacker, r1c2: defender, r10c0: 'black-engineer-1' }, { hidden: ['r1c2'] });
    const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
    assert.equal(next.lastAction.outcome, outcome);
    assert.ok(entities(next).find(({ id }) => id === defender).revealed);
  }
});
test('v2 enemy dark mine kills an ordinary attacker but the revealed mine cannot be ordinarily attacked', () => {
  const game = position({ r1c1: 'red-commander-1', r1c2: 'black-mine-1', r10c0: 'black-engineer-1' }, { hidden: ['r1c2'] });
  const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.lastAction.outcome, 'attacker-lost'); assert.equal(entry(next, 'r1c2').piece.kind, 'mine');
  assert.equal(entry(next, 'r1c2').piece.revealed, true);
  const revealed = position({ r1c1: 'red-commander-1', r1c2: 'black-mine-1', r10c0: 'black-engineer-1' });
  assert.ok(!moves(revealed).has('r1c1:r1c2')); failure(revealed, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
});
test('v2 engineer survives digging a dark mine, bombs mutually remove dark mines or soldiers', () => {
  for (const [attacker, defender, outcome] of [
    ['red-engineer-1', 'black-mine-1', 'capture'],
    ['red-bomb-1', 'black-mine-1', 'mutual'],
    ['red-company-1', 'black-bomb-1', 'mutual'],
  ]) {
    const game = position({ r1c1: attacker, r1c2: defender, r10c0: 'black-engineer-1' }, { hidden: ['r1c2'] });
    const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
    assert.equal(next.lastAction.outcome, outcome);
  }
});
test('v2 hidden flag protection blocks only after revealing, consumes a turn, and preserves the attacker', () => {
  const game = position({ r1c1: 'red-engineer-1', r1c2: 'black-flag-1', r11c4: 'black-mine-1', r10c0: 'black-engineer-1' }, { hidden: ['r1c2', 'r11c4'] });
  assert.ok(moves(game).has('r1c1:r1c2'));
  const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.lastAction.outcome, 'protected-flag'); assert.equal(entry(next, 'r1c1').piece.id, 'red-engineer-1');
  assert.equal(entry(next, 'r1c2').piece.revealed, true); assert.equal(entry(next, 'r11c4').piece.revealed, false);
  assert.equal(next.flagTokens.length, 0); assert.equal(next.turnIndex, 1);
});
test('v2 ineligible hidden flag attempt, including a bomb, reveals without moving or destroying either entity', () => {
  for (const attacker of ['red-company-1', 'red-bomb-1']) {
    const game = position({ r1c1: attacker, r1c2: 'black-flag-1', r0c4: 'red-engineer-1', r10c0: 'black-engineer-1' }, { hidden: ['r1c2', 'r0c4'] });
    assert.ok(moves(game).has('r1c1:r1c2'));
    const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
    assert.equal(next.lastAction.outcome, 'ineligible-flag'); assert.equal(entry(next, 'r1c1').piece.id, attacker);
    assert.equal(entry(next, 'r1c2').piece.kind, 'flag'); assert.equal(next.status, 'playing');
  }
});
test('v2 taking a cleared enemy flag starts transport rather than victory, flag is conserved outside captured', () => {
  const game = position({ r10c2: 'red-engineer-1', r10c3: 'black-flag-1', r1c0: 'black-engineer-1' });
  let next = success(game, 'alice', { type: 'move', from: 'r10c2', to: 'r10c3' });
  assert.equal(next.status, 'playing'); assert.equal(next.result, null); assert.equal(next.lastAction.outcome, 'flag-pickup');
  assert.deepEqual(next.flagTokens, [{ piece: { id: 'black-flag-1', side: 'black', kind: 'flag', revealed: true }, carrierId: 'red-engineer-1', cellId: null }]);
  assert.ok(!next.captured.some(({ kind }) => kind === 'flag'));
  next = success(next, 'bob', { type: 'move', from: 'r1c0', to: 'r1c1' });
  next = success(next, 'alice', { type: 'move', from: 'r10c3', to: 'r11c3' });
  assert.equal(next.result.reason, 'flag-delivered'); assert.equal(next.winnerId, 'alice');
  assert.equal(next.flagTokens[0].carrierId, null); assert.equal(next.flagTokens[0].cellId, 'r11c3');
  assert.ok(next.result.scores.every(({ points }) => points === null));
  failure(next, 'bob', { type: 'resign' }, /结束/);
});
test('v2 delivery accepts either home headquarters and never the opponents headquarters', () => {
  for (const column of [1, 3]) {
    const game = position({ [`r10c${column}`]: 'red-engineer-1', r1c0: 'black-engineer-1' },
      { tokens: [{ id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
    const next = success(game, 'alice', { type: 'move', from: `r10c${column}`, to: `r11c${column}` });
    assert.equal(next.result.reason, 'flag-delivered');
  }
  const away = position({ r1c3: 'red-engineer-1', r10c0: 'black-engineer-1' },
    { tokens: [{ id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
  assert.equal(success(away, 'alice', { type: 'move', from: 'r1c3', to: 'r0c3' }).status, 'playing');
});
test('v2 black delivery uses black headquarters even if the random flag started elsewhere', () => {
  const game = position({ r1c1: 'black-engineer-1', r10c0: 'red-engineer-1' },
    { turnIndex: 1, tokens: [{ id: 'red-flag-1', carrierId: 'black-engineer-1' }] });
  const next = success(game, 'bob', { type: 'move', from: 'r1c1', to: 'r0c1' });
  assert.equal(next.winnerId, 'bob'); assert.equal(next.result.reason, 'flag-delivered');
});
test('v2 all three engineers must be dead before the smallest surviving rank, including dark ranks, may carry', () => {
  const withHiddenEngineer = position({ r1c1: 'red-platoon-1', r1c2: 'black-flag-1', r0c4: 'red-engineer-3', r10c0: 'black-engineer-1' }, { hidden: ['r0c4'] });
  assert.ok(!moves(withHiddenEngineer).has('r1c1:r1c2'));
  const lowerDark = position({ r1c1: 'red-company-1', r1c2: 'black-flag-1', r0c4: 'red-platoon-1', r10c0: 'black-engineer-1' }, { hidden: ['r0c4'] });
  assert.ok(!moves(lowerDark).has('r1c1:r1c2'));
  const fallback = position({ r1c1: 'red-platoon-1', r1c2: 'black-flag-1', r0c4: 'red-platoon-2', r10c0: 'black-engineer-1' }, { hidden: ['r0c4'] });
  const next = success(fallback, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.flagTokens[0].carrierId, 'red-platoon-1');
  const largerFallback = position({ r1c1: 'red-division-1', r1c2: 'black-flag-1', r10c0: 'black-engineer-1' });
  assert.ok(moves(largerFallback).has('r1c1:r1c2'));
});
test('v2 bombs never acquire a revealed flag even after all ranked soldiers are dead', () => {
  const game = position({ r1c1: 'red-bomb-1', r1c2: 'black-flag-1', r10c0: 'black-engineer-1' });
  assert.ok(!moves(game).has('r1c1:r1c2')); failure(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
});
test('v2 carrying preserves engineer railway turns, regular railway straight lines, and camp protection', () => {
  const rail = position({ r1c2: 'red-engineer-1', r10c2: 'black-engineer-1' }, { tokens: [{ id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
  assert.ok(moves(rail).has('r1c2:r9c4'));
  assert.equal(success(rail, 'alice', { type: 'move', from: 'r1c2', to: 'r9c4' }).flagTokens[0].carrierId, 'red-engineer-1');
  const fallbackRail = position({ r1c2: 'red-platoon-1', r10c2: 'black-engineer-1' }, { tokens: [{ id: 'black-flag-1', carrierId: 'red-platoon-1' }] });
  assert.ok(moves(fallbackRail).has('r1c2:r1c4')); assert.ok(!moves(fallbackRail).has('r1c2:r9c4'));
  const camp = position({ r1c0: 'red-engineer-1', r1c1: 'black-commander-1' }, { tokens: [{ id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
  const safe = success(camp, 'alice', { type: 'move', from: 'r1c0', to: 'r2c1' });
  assert.ok(!moves(safe, 'bob').has('r1c1:r2c1')); assert.equal(safe.flagTokens[0].carrierId, 'red-engineer-1');
});
test('v2 a killed attacking courier drops its flag at the battle cell under the surviving defender', () => {
  const game = position({ r1c1: 'red-engineer-1', r1c2: 'black-company-1', r10c0: 'black-engineer-1' }, { tokens: [{ id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
  const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.flagTokens[0].carrierId, null); assert.equal(next.flagTokens[0].cellId, 'r1c2');
  assert.equal(entry(next, 'r1c2').piece.id, 'black-company-1');
  assert.deepEqual(next.lastAction.flagEvents, [{ type: 'drop', side: 'black', cellId: 'r1c2', carrierId: 'red-engineer-1' }]);
});
test('v2 a killed defending courier drops at the same battle endpoint; ordinary survivor may guard but not carry', () => {
  const game = position({ r1c1: 'red-commander-1', r1c2: 'black-engineer-1', r10c0: 'black-engineer-2', r0c4: 'red-engineer-1' }, { tokens: [{ id: 'red-flag-1', carrierId: 'black-engineer-1' }] });
  const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.flagTokens[0].cellId, 'r1c2'); assert.equal(next.flagTokens[0].carrierId, null);
  assert.equal(entry(next, 'r1c2').piece.id, 'red-commander-1');
});
test('v2 equal couriers may drop both distinct flags on one empty cell without loss or duplication', () => {
  const game = position({ r1c1: 'red-engineer-1', r1c2: 'black-engineer-1', r0c4: 'red-engineer-2', r11c4: 'black-engineer-2' },
    { hidden: ['r0c4', 'r11c4'], tokens: [{ id: 'red-flag-1', carrierId: 'black-engineer-1' }, { id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
  const next = success(game, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(entry(next, 'r1c2').piece, null); assert.equal(next.flagTokens.length, 2);
  assert.ok(next.flagTokens.every(token => token.carrierId === null && token.cellId === 'r1c2'));
  assert.equal(next.lastAction.flagEvents.filter(event => event.type === 'drop').length, 2);
});
test('v2 explicit pickup selects either visible ground flag under a qualified own piece and consumes the turn', () => {
  const game = position({ r1c2: 'red-engineer-1', r10c0: 'black-engineer-1' },
    { tokens: [{ id: 'red-flag-1', cellId: 'r1c2' }, { id: 'black-flag-1', cellId: 'r1c2' }] });
  assert.deepEqual(privateView(game, 'alice').legalPickups, [{ cellId: 'r1c2', flagSide: 'black' }, { cellId: 'r1c2', flagSide: 'red' }]);
  const next = success(game, 'alice', { type: 'pickup', cellId: 'r1c2', flagSide: 'red' });
  assert.equal(next.flagTokens.find(({ piece }) => piece.side === 'red').carrierId, 'red-engineer-1');
  assert.equal(next.turnIndex, 1); assert.equal(next.round, game.round + 1);
  assert.deepEqual(privateView(next, 'alice').legalPickups, []);
});
test('v2 arriving survivor auto-picks one enemy flag first; an existing courier never picks a second flag', () => {
  const ground = position({ r1c1: 'red-engineer-1', r10c0: 'black-engineer-1' },
    { tokens: [{ id: 'red-flag-1', cellId: 'r1c2' }, { id: 'black-flag-1', cellId: 'r1c2' }] });
  const next = success(ground, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(next.flagTokens.find(({ piece }) => piece.side === 'black').carrierId, 'red-engineer-1');
  assert.equal(next.flagTokens.find(({ piece }) => piece.side === 'red').cellId, 'r1c2');
  const carried = position({ r1c1: 'red-engineer-1', r10c0: 'black-engineer-1' },
    { tokens: [{ id: 'red-flag-1', cellId: 'r1c2' }, { id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
  const unchanged = success(carried, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' });
  assert.equal(unchanged.flagTokens.find(({ piece }) => piece.side === 'red').cellId, 'r1c2');
  assert.deepEqual(unchanged.lastAction.flagEvents, []);
});
test('v2 ground flag markers may share an occupied station and do not create hidden or additional railway blockers', () => {
  const game = position({ r1c0: 'red-company-1', r0c4: 'red-engineer-1', r10c0: 'black-engineer-1' }, { tokens: [{ id: 'black-flag-1', cellId: 'r1c2' }] });
  assert.ok(moves(game).has('r1c0:r1c4'));
  const next = success(game, 'alice', { type: 'move', from: 'r1c0', to: 'r1c2' });
  assert.equal(next.flagTokens[0].cellId, 'r1c2'); assert.equal(next.flagTokens[0].carrierId, null);
});
test('v2 own flag is returned to either own headquarters as ground without winning or immediately repicking', () => {
  const game = position({ r10c1: 'red-engineer-1', r1c0: 'black-engineer-1' }, { tokens: [{ id: 'red-flag-1', carrierId: 'red-engineer-1' }] });
  let next = success(game, 'alice', { type: 'move', from: 'r10c1', to: 'r11c1' });
  assert.equal(next.status, 'playing'); assert.equal(next.result, null);
  assert.equal(next.flagTokens[0].carrierId, null); assert.equal(next.flagTokens[0].cellId, 'r11c1');
  assert.deepEqual(next.lastAction.flagEvents.map(({ type }) => type), ['returned']);
  next = success(next, 'bob', { type: 'move', from: 'r1c0', to: 'r1c1' });
  assert.deepEqual(privateView(next, 'alice').legalPickups, []);
  failure(next, 'alice', { type: 'pickup', cellId: 'r11c1', flagSide: 'red' });
});
test('v2 an enemy loose flag picked under an own headquarters occupant delivers and wins exactly once', () => {
  const game = position({ r11c1: 'red-engineer-1', r1c0: 'black-engineer-1' }, { tokens: [{ id: 'black-flag-1', cellId: 'r11c1' }] });
  const next = success(game, 'alice', { type: 'pickup', cellId: 'r11c1', flagSide: 'black' });
  assert.equal(next.result.reason, 'flag-delivered'); assert.deepEqual(next.lastAction.flagEvents.map(({ type }) => type), ['pickup', 'delivered']);
  failure(next, 'alice', { type: 'pickup', cellId: 'r11c1', flagSide: 'black' }, /结束/);
});
test('v2 illegal pickups reject without revealing, moving, removing flags, or incrementing revisions', () => {
  const game = position({ r1c2: 'red-company-1', r0c4: 'red-engineer-1', r10c0: 'black-engineer-1' }, { tokens: [{ id: 'black-flag-1', cellId: 'r1c2' }] });
  for (const action of [{ type: 'pickup', cellId: 'r1c2', flagSide: 'black' },
    { type: 'pickup', cellId: 'r1c2', flagSide: 'blue' }, { type: 'pickup', cellId: 'r1c0', flagSide: 'black' },
    { type: 'pickup', cellId: 'r1c2', flagSide: 'black', carrierId: 'red-engineer-1' }]) failure(game, 'alice', action);
  failure(game, 'bob', { type: 'pickup', cellId: 'r1c2', flagSide: 'black' }, /轮到/);
  failure(game, 'outsider', { type: 'pickup', cellId: 'r1c2', flagSide: 'black' }, /不在/);
});
test('v2 permuting all secret identities leaves public board, dark attempt targets and pickup eligibility identical', () => {
  let game = initial();
  for (const [playerId, id] of [['alice', 'red-company-1'], ['bob', 'black-company-1'], ['alice', 'red-engineer-1']]) {
    game = success(game, playerId, { type: 'flip', cellId: at(game, id) });
  }
  const shuffled = structuredClone(game), hidden = shuffled.board.filter(({ piece }) => piece && !piece.revealed);
  const secret = hidden.map(({ piece }) => piece).reverse(); hidden.forEach((cell, i) => { cell.piece = secret[i]; });
  assert.equal(gameProblem(shuffled), null);
  for (const { id } of players) assert.deepEqual(privateView(shuffled, id), privateView(game, id));
});
test('v2 private flag projection exposes side and already revealed carrier only, never hidden physical identities or aliases', () => {
  const game = position({ r1c2: 'red-engineer-1', r10c0: 'black-engineer-1', r11c4: 'black-general-1' },
    { hidden: ['r11c4'], tokens: [{ id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
  const view = privateView(game, 'alice');
  assert.deepEqual(view.flagTokens, [{ side: 'black', carrierId: 'red-engineer-1', cellId: null }]);
  assert.deepEqual(entry(view, 'r11c4').piece, { hidden: true });
  assert.ok(!JSON.stringify(view).includes('black-general-1')); assert.equal(JSON.stringify(view.flagTokens).includes('flag-1'), false);
  view.flagTokens[0].side = 'red'; assert.equal(game.flagTokens[0].piece.side, 'black');
  view.players[0].name = 'changed'; assert.equal(game.players[0].name, 'Alice');
  assert.deepEqual(privateView(game, 'bob').legalPickups, []);
});

test('v2 rejected pickup on dark cells reveals neither ownership nor piece type and never consumes a turn', () => {
  const game = position({ r1c0: 'red-engineer-1', r1c1: 'red-company-1', r1c2: 'black-company-1',
    r1c3: 'black-engineer-1' }, { hidden: ['r1c1', 'r1c2'] });
  const swapped = structuredClone(game);
  [entry(swapped, 'r1c1').piece, entry(swapped, 'r1c2').piece] = [entry(swapped, 'r1c2').piece, entry(swapped, 'r1c1').piece];
  assert.deepEqual(privateView(game, 'alice'), privateView(swapped, 'alice'));
  const results = [];
  for (const state of [game, swapped]) for (const cellId of ['r1c1', 'r1c2']) for (const flagSide of ['red', 'black']) {
    const before = structuredClone(state), result = applyGameAction(state, 'alice', { type: 'pickup', cellId, flagSide });
    assert.equal(result.ok, false); assert.deepEqual(state, before); results.push(result);
  }
  for (const result of results) assert.deepEqual(result, results[0]);
});
test('v2 snapshots reject duplicate flags, invalid locations, dead/dark/unqualified or doubly laden carriers and captured flags', () => {
  const valid = position({ r1c2: 'red-engineer-1', r10c0: 'black-engineer-1', r0c4: 'red-company-1' }, { tokens: [{ id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
  const corruptions = [
    g => { g.flagTokens.push(structuredClone(g.flagTokens[0])); },
    g => { g.flagTokens[0].cellId = 'r1c2'; }, g => { g.flagTokens[0].carrierId = null; },
    g => { g.flagTokens[0].carrierId = 'red-engineer-3'; }, g => { g.flagTokens[0].carrierId = 'red-company-1'; },
    g => { entry(g, 'r1c2').piece.revealed = false; }, g => { g.flagTokens[0].piece.kind = 'mine'; },
    g => { g.flagTokens[0].piece.revealed = false; }, g => { g.flagTokens[0].cellId = 'r99c0'; g.flagTokens[0].carrierId = null; },
    g => { g.flagTokens[0].delivered = true; }, g => { g.flagTokens = null; },
    g => { entry(g, 'r11c1').piece = entry(g, 'r1c2').piece; entry(g, 'r1c2').piece = null; },
    g => { g.captured.push(g.flagTokens.pop().piece); }, g => { delete g.flagTokens; },
    g => { g.version = 1; }, g => { g.ruleVersion = 'army-flip-v1'; },
  ];
  for (const mutate of corruptions) {
    const game = structuredClone(valid); mutate(game);
    assert.equal(typeof gameProblem(game), 'string'); failure(game, 'alice', { type: 'resign' });
  }
});
test('v2 terminal snapshots cannot claim delivery from capture alone, the wrong base, a lost carrier, or nullable fake winners', () => {
  const game = position({ r10c1: 'red-engineer-1', r1c0: 'black-engineer-1' }, { tokens: [{ id: 'black-flag-1', carrierId: 'red-engineer-1' }] });
  const ended = success(game, 'alice', { type: 'move', from: 'r10c1', to: 'r11c1' });
  for (const mutate of [
    g => { g.result.reason = 'flag-captured'; }, g => { g.lastAction.flagEvents = []; },
    g => { g.lastAction.flagEvents[0].cellId = 'r0c1'; }, g => { g.flagTokens[0].cellId = 'r0c1'; },
    g => { g.lastAction.flagEvents[0].carrierId = 'red-engineer-3'; }, g => { g.result.winnerIds = []; g.winnerId = null; },
    g => { g.result.scores[0].points = 3; }, g => { g.status = 'playing'; g.result = null; g.winnerId = null; },
    g => { g.lastAction.flagEvents = null; }, g => { g.lastAction.flagEvents = [null]; },
    g => { g.lastAction.flagEvents.push(structuredClone(g.lastAction.flagEvents[0])); },
  ]) {
    const corrupt = structuredClone(ended); mutate(corrupt); assert.equal(typeof gameProblem(corrupt), 'string');
  }
});
test('v2 pending draw survives ordinary public reads, pickup or dark encounter clears it, resignation preserves cargo', () => {
  const game = position({ r1c2: 'red-engineer-1', r10c0: 'black-engineer-1' }, { tokens: [{ id: 'black-flag-1', cellId: 'r1c2' }] });
  const offered = success(game, 'bob', { type: 'offer-draw' });
  assert.equal(privateView(offered, 'alice').drawOfferByPlayerId, 'bob');
  const picked = success(offered, 'alice', { type: 'pickup', cellId: 'r1c2', flagSide: 'black' });
  assert.equal(picked.drawOfferByPlayerId, null);
  const resigned = success(picked, 'alice', { type: 'resign' });
  assert.equal(resigned.winnerId, 'bob'); assert.equal(resigned.flagTokens[0].carrierId, 'red-engineer-1');
  const draw = success(offered, 'alice', { type: 'accept-draw' });
  assert.equal(draw.result.tie, true); assert.deepEqual(draw.result.winnerIds, []);
});
test('v2 fifty genuine alternating-color reveals still end in assignment-exhausted draw with exact counters', () => {
  let game = initial(); const pieces = entities(game), red = pieces.filter(({ side }) => side === 'red'), black = pieces.filter(({ side }) => side === 'black');
  const sequence = [];
  for (let turn = 0; turn < 25; turn++) sequence.push((turn % 2 === 0 ? red : black).shift(), (turn % 2 === 0 ? black : red).shift());
  let index = 0; for (const cell of game.board) if (cell.piece) cell.piece = sequence[index++];
  for (let turn = 0; turn < 50; turn++) {
    const id = game.players[game.turnIndex].id;
    game = success(game, id, { type: 'flip', cellId: privateView(game, id).legalFlips[0] });
  }
  assert.equal(game.result.reason, 'assignment-exhausted'); assert.equal(game.round, 51); assert.equal(game.revision, 50);
  assert.deepEqual(privateView(game, 'alice').legalPickups, []);
});
test('v2 genuine flip and move sequence preserves fifty canonical entities through every confirmed result', () => {
  let game = initial();
  for (let step = 0; step < 90 && game.status === 'playing'; step++) {
    const id = game.players[game.turnIndex].id, view = privateView(game, id);
    const action = view.legalFlips.length ? { type: 'flip', cellId: view.legalFlips[0] }
      : view.legalPickups.length ? { type: 'pickup', ...view.legalPickups[0] }
      : { type: 'move', ...view.legalMoves[step % view.legalMoves.length] };
    game = success(game, id, action); assert.equal(entities(game).length, 50);
  }
});
