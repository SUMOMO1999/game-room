import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, privateView, gameProblem } from './army-rules.mjs';
import { BOARD_CELLS } from './army-board.mjs';
import { createRoomStore } from './rooms.mjs';
import { gameAdapter } from './game-registry.mjs';
import { applyPracticeAction, practiceView, createPracticeGame, createPracticeSession,
  encodePractice, decodePractice, PRACTICE_PLAYERS, PRACTICE_STORAGE_KEY,
  PRACTICE_V2_STORAGE_KEY, PRACTICE_LEGACY_STORAGE_KEY } from './army-practice-engine.mjs';
import { armyRulePages, armyRuleModeLabel, armyLastActionText } from './army-presentation.mjs';

const players = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const start = (options = {}) => createGame(players, { randomInt: max => max - 1, firstTurnIndex: 0, ...options });
const entities = game => [...game.board.flatMap(({ piece }) => piece ? [piece] : []),
  ...game.captured, ...game.flagTokens.map(({ piece }) => piece)];
const entry = (game, cellId) => game.board.find(item => item.cellId === cellId);
const hasMove = (game, from, to) => privateView(game, game.players[game.turnIndex].id)
  .legalMoves.some(move => move.from === from && move.to === to);
function position(placements, { hidden = [], tokens = [], turnIndex = 0,
  ruleVersion = 'army-flip-v3', identities = players } = {}) {
  const game = createGame(identities, { ruleVersion, randomInt: max => max - 1, firstTurnIndex: 0 });
  const canonical = new Map(entities(game).map(piece => [piece.id, piece]));
  const defaults = { r0c1: 'red-flag-1', r11c3: 'black-flag-1' };
  for (const [cell, id] of Object.entries(defaults)) if (Object.values(placements).includes(id)
      || tokens.some(token => token.id === id)) delete defaults[cell];
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
  game.players = game.players.map((player, index) => ({ ...player, side: index ? 'black' : 'red', lastFlipSide: index ? 'black' : 'red' }));
  game.turnIndex = turnIndex; game.round = 51; game.revision = 51;
  game.lastAction = { type: 'decline-draw', playerId: game.players[1].id };
  assert.equal(gameProblem(game), null);
  return game;
}
function success(game, from, to) {
  const before = structuredClone(game), actor = game.players[game.turnIndex].id;
  const result = applyGameAction(game, actor, { type: 'move', from, to });
  assert.equal(result.ok, true, result.error); assert.deepEqual(game, before);
  assert.equal(gameProblem(result.state), null); assert.equal(result.state.turnIndex, 1 - game.turnIndex);
  assert.equal(result.state.revision, game.revision + 1); assert.equal(result.state.round, game.round + 1);
  assert.deepEqual(entities(result.state).map(piece => piece.id).sort(), entities(game).map(piece => piece.id).sort());
  return result.state;
}

test('new military games choose v3; explicit v1 and v2 remain unchanged and strictly versioned', () => {
  assert.equal(start().ruleVersion, 'army-flip-v3'); assert.equal(start().version, 3);
  for (const version of [1, 2]) {
    const old = start({ ruleVersion: `army-flip-v${version}` });
    assert.equal(old.version, version); assert.equal(gameProblem(old), null);
    assert.equal(applyGameAction(old, 'alice', { type: 'flip', cellId: 'r0c0' }).state.ruleVersion, old.ruleVersion);
  }
  const invalid = start(); invalid.version = 2; assert.match(gameProblem(invalid), /版本/);
});
test('v3 both sides sacrifice the smallest surviving officer against revealed and dark enemy mines', () => {
  for (const side of ['red', 'black']) for (const dark of [false, true]) {
    const other = side === 'red' ? 'black' : 'red';
    const game = position({ r1c1: `${side}-platoon-1`, r1c2: `${other}-mine-1`, r10c0: `${other}-engineer-1` },
      { turnIndex: side === 'red' ? 0 : 1, hidden: dark ? ['r1c2'] : [] });
    assert.ok(hasMove(game, 'r1c1', 'r1c2'));
    const next = success(game, 'r1c1', 'r1c2');
    assert.equal(next.lastAction.outcome, 'mine-sacrifice'); assert.equal(entry(next, 'r1c1').piece, null);
    assert.equal(entry(next, 'r1c2').piece, null);
    assert.deepEqual(next.captured.slice(-2).map(piece => piece.id), [`${side}-platoon-1`, `${other}-mine-1`]);
  }
});
test('one surviving engineer, even unrevealed, disables the officer fallback without changing dark target hints', () => {
  for (const hiddenEngineer of [false, true]) {
    const placements = { r1c1: 'red-platoon-1', r1c2: 'black-mine-1', r0c4: 'red-engineer-3', r10c0: 'black-engineer-1' };
    const known = position(placements, { hidden: hiddenEngineer ? ['r0c4'] : [] });
    assert.equal(hasMove(known, 'r1c1', 'r1c2'), false);
    assert.equal(applyGameAction(known, 'alice', { type: 'move', from: 'r1c1', to: 'r1c2' }).ok, false);
    const dark = position(placements, { hidden: ['r1c2', ...(hiddenEngineer ? ['r0c4'] : [])] });
    assert.ok(hasMove(dark, 'r1c1', 'r1c2'));
    const next = success(dark, 'r1c1', 'r1c2');
    assert.equal(next.lastAction.outcome, 'attacker-lost'); assert.equal(entry(next, 'r1c2').piece.kind, 'mine');
  }
});
test('unrevealed lower officers block larger officers while every tied lowest officer remains eligible', () => {
  const higher = position({ r1c1: 'red-company-1', r1c2: 'black-mine-1', r0c4: 'red-platoon-1', r10c0: 'black-engineer-1' }, { hidden: ['r0c4'] });
  assert.equal(hasMove(higher, 'r1c1', 'r1c2'), false);
  for (const id of ['red-platoon-1', 'red-platoon-2']) {
    const other = id === 'red-platoon-1' ? 'red-platoon-2' : 'red-platoon-1';
    const tied = position({ r1c1: id, r1c2: 'black-mine-1', r0c4: other, r10c0: 'black-engineer-1' }, { hidden: ['r0c4'] });
    assert.equal(success(tied, 'r1c1', 'r1c2').lastAction.outcome, 'mine-sacrifice');
  }
});
test('fallback rank is recalculated after the last lowest officer dies, so the next rank can clear a remaining mine', () => {
  let game = position({ r1c1: 'red-platoon-1', r1c2: 'black-mine-1', r0c3: 'red-company-1', r1c3: 'black-mine-2', r10c0: 'black-engineer-1' });
  assert.equal(hasMove(game, 'r0c3', 'r1c3'), false);
  game = success(game, 'r1c1', 'r1c2');
  game = success(game, 'r10c0', 'r10c1');
  assert.ok(hasMove(game, 'r0c3', 'r1c3'));
  assert.equal(success(game, 'r0c3', 'r1c3').lastAction.outcome, 'mine-sacrifice');
});
test('three officer sacrifices remove all mine protection; the next surviving rank can then pick up and deliver the enemy flag', () => {
  let game = position({ r1c1: 'red-platoon-1', r1c2: 'black-mine-1',
    r0c3: 'red-platoon-2', r1c3: 'black-mine-2', r0c4: 'red-platoon-3', r1c4: 'black-mine-3',
    r10c2: 'red-company-1', r10c3: 'black-flag-1', r10c0: 'black-engineer-1' });
  assert.equal(hasMove(game, 'r10c2', 'r10c3'), false);
  for (const [index, from, to] of [[0, 'r1c1', 'r1c2'], [1, 'r0c3', 'r1c3'], [2, 'r0c4', 'r1c4']]) {
    game = success(game, from, to);
    assert.equal(game.captured.filter(piece => piece.side === 'black' && piece.kind === 'mine').length, index + 1);
    game = index % 2 ? success(game, 'r10c1', 'r10c0') : success(game, 'r10c0', 'r10c1');
  }
  assert.ok(hasMove(game, 'r10c2', 'r10c3'));
  game = success(game, 'r10c2', 'r10c3'); assert.equal(game.flagTokens[0].carrierId, 'red-company-1');
  game = success(game, 'r10c1', 'r10c0');
  game = success(game, 'r10c3', 'r11c3'); assert.equal(game.result.reason, 'flag-delivered'); assert.equal(game.winnerId, 'alice');
});
test('v3 engineer survives mine removal and bombs still trade; fallback never grants engineer railway turning', () => {
  for (const [kind, outcome] of [['engineer', 'capture'], ['bomb', 'mutual']]) {
    const game = position({ r1c1: `red-${kind}-1`, r1c2: 'black-mine-1', r10c0: 'black-engineer-1' });
    assert.equal(success(game, 'r1c1', 'r1c2').lastAction.outcome, outcome);
  }
  const officer = position({ r1c2: 'red-platoon-1', r10c2: 'black-engineer-1' });
  assert.ok(hasMove(officer, 'r1c2', 'r1c4')); assert.equal(hasMove(officer, 'r1c2', 'r9c4'), false);
});
test('dark friendly mine only reveals; own soldier does not die or remove it', () => {
  const game = position({ r1c1: 'red-platoon-1', r1c2: 'red-mine-1', r10c0: 'black-engineer-1' }, { hidden: ['r1c2'] });
  const next = success(game, 'r1c1', 'r1c2'); assert.equal(next.lastAction.outcome, 'friendly-reveal');
  assert.equal(next.captured.length, game.captured.length); assert.equal(entry(next, 'r1c1').piece.id, 'red-platoon-1');
});
test('sacrificing a flag carrier conserves its flag as a ground marker at the now empty mine cell', () => {
  const game = position({ r1c1: 'red-platoon-1', r1c2: 'black-mine-1', r10c0: 'black-engineer-1' },
    { tokens: [{ id: 'red-flag-1', carrierId: 'red-platoon-1' }] });
  const next = success(game, 'r1c1', 'r1c2');
  assert.equal(next.flagTokens[0].carrierId, null); assert.equal(next.flagTokens[0].cellId, 'r1c2');
  assert.deepEqual(next.lastAction.flagEvents, [{ type: 'drop', side: 'red', cellId: 'r1c2', carrierId: 'red-platoon-1' }]);
  assert.equal(next.status, 'playing');
});
test('v2 active games retain ordinary-officer mine loss and never inherit v3 fallback', () => {
  for (const dark of [false, true]) {
    const game = position({ r1c1: 'red-platoon-1', r1c2: 'black-mine-1', r10c0: 'black-engineer-1' },
      { ruleVersion: 'army-flip-v2', hidden: dark ? ['r1c2'] : [] });
    assert.equal(hasMove(game, 'r1c1', 'r1c2'), dark);
    if (dark) assert.equal(success(game, 'r1c1', 'r1c2').lastAction.outcome, 'attacker-lost');
  }
});
test('v3 hidden-identity permutations leave all public projections and legal dark attempts identical', () => {
  const game = position({ r1c1: 'red-platoon-1', r1c2: 'black-mine-1', r0c4: 'red-engineer-1', r10c0: 'black-engineer-1' }, { hidden: ['r1c2', 'r0c4'] });
  const shuffled = structuredClone(game), a = entry(shuffled, 'r1c2'), b = entry(shuffled, 'r0c4');
  [a.piece, b.piece] = [b.piece, a.piece]; assert.equal(gameProblem(shuffled), null);
  assert.deepEqual(privateView(shuffled, 'alice'), privateView(game, 'alice'));
  assert.ok(gameAdapter('army-flip').spectatorView(game).board.filter(cell => cell.piece?.hidden).every(cell => Object.keys(cell.piece).length === 1));
});
test('v3 rejects fabricated sacrifice outcomes, wrong casualty order, and a forged revived lower-rank blocker', () => {
  const game = position({ r1c1: 'red-platoon-1', r1c2: 'black-mine-1', r10c0: 'black-engineer-1' });
  const result = success(game, 'r1c1', 'r1c2');
  for (const corrupt of [
    value => { value.lastAction.outcome = 'mutual'; },
    value => { value.captured.push(...value.captured.splice(-2).reverse()); },
    value => { value.lastAction.outcome = 'capture'; },
    value => { const index = value.captured.findIndex(piece => piece.id === 'red-engineer-1');
      entry(value, 'r0c4').piece = value.captured.splice(index, 1)[0]; },
  ]) { const changed = structuredClone(result); corrupt(changed); assert.notEqual(gameProblem(changed), null); }
  const old = structuredClone(result); old.version = 2; old.ruleVersion = 'army-flip-v2'; assert.notEqual(gameProblem(old), null);
});
test('v3 local practice collision and every visible result exactly match the authoritative game', () => {
  for (const dark of [false, true]) {
    const game = position({ r1c1: 'red-platoon-1', r1c2: 'black-mine-1', r10c0: 'black-engineer-1' },
      { identities: PRACTICE_PLAYERS, hidden: dark ? ['r1c2'] : [] });
    const actor = PRACTICE_PLAYERS[0].id, action = { type: 'move', from: 'r1c1', to: 'r1c2' };
    const local = applyPracticeAction(game, actor, action), official = applyGameAction(game, actor, action);
    assert.deepEqual(local, official); assert.ok(local.ok);
    assert.deepEqual(practiceView(local.state), privateView(official.state, actor));
    assert.deepEqual(decodePractice(encodePractice(local.state, 'v3-demine')).game, official.state);
  }
});
test('v3 practice automatic opponent takes only public legal actions through seeded matches and agrees with the server', async () => {
  const { choosePracticeAction, PRACTICE_BOT } = await import('./army-practice-engine.mjs');
  for (let seed = 1; seed <= 3; seed++) {
    const seeded = start => { let value = start; return max => { value = value * 16807 % 2147483647; return value % max; }; };
    let game = createPracticeGame({ randomInt: seeded(seed) }), random = seeded(seed + 40);
    assert.deepEqual(game, createGame(PRACTICE_PLAYERS, { ruleVersion: 'army-flip-v3', randomInt: seeded(seed) }));
    for (let index = 0; index < 200 && game.status === 'playing'; index++) {
      const actor = game.players[game.turnIndex].id, view = practiceView(game, actor);
      const action = actor === PRACTICE_BOT ? choosePracticeAction(view, random)
        : view.legalFlips.length ? { type: 'flip', cellId: view.legalFlips[random(view.legalFlips.length)] }
          : view.legalPickups.length ? { type: 'pickup', ...view.legalPickups[random(view.legalPickups.length)] }
            : { type: 'move', ...view.legalMoves[random(view.legalMoves.length)] };
      assert.ok(action);
      const local = applyPracticeAction(game, actor, action), official = applyGameAction(game, actor, action);
      assert.deepEqual(local, official); assert.ok(local.ok, local.error); game = local.state;
      assert.equal(gameProblem(game), null);
    }
  }
});
test('schema6 saves only v3; schema5 old v2 stays readable and mixed version/schema claims fail closed', () => {
  const store = createRoomStore({ gameOptions: { randomInt: max => max - 1, firstTurnIndex: 0 } });
  const room = store.createRoom('Alice', { gameType: 'army-flip' });
  const bob = store.joinRoom(room.roomCode, 'Bob');
  const act = (token, type, extra = {}) => store.action(room.roomCode, token, { type,
    requestId: `v3-${type}-${token}`, expectedRevision: store.getView(room.roomCode, token).revision, ...extra });
  assert.equal(store.exportSnapshot(room.roomCode).schemaVersion, 6);
  act(room.token, 'ready', { ready: true }); act(bob.token, 'ready', { ready: true }); act(room.token, 'start');
  const saved = store.exportSnapshot(room.roomCode); assert.equal(saved.schemaVersion, 6); assert.equal(saved.game.ruleVersion, 'army-flip-v3');
  const restarted = createRoomStore(); restarted.importSnapshot(saved);
  assert.deepEqual(restarted.getView(room.roomCode, room.token).game, store.getView(room.roomCode, room.token).game);
  const old = structuredClone(saved); old.schemaVersion = 5; old.game.version = 2; old.game.ruleVersion = 'army-flip-v2';
  const legacy = createRoomStore(); legacy.importSnapshot(old); assert.equal(legacy.exportSnapshot(room.roomCode).schemaVersion, 5);
  for (const [schemaVersion, ruleVersion] of [[5, 'army-flip-v3'], [6, 'army-flip-v2'], [4, 'army-flip-v3']]) {
    const bad = structuredClone(saved); bad.schemaVersion = schemaVersion; bad.game.ruleVersion = ruleVersion;
    assert.throws(() => createRoomStore().importSnapshot(bad), /保存/);
  }
});
test('v3 practice resumes v2 without migration; restart uses a separate v3 key and old writers cannot overwrite it', async () => {
  const map = new Map(), storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  const old = encodePractice(createPracticeGame({ ruleVersion: 'army-flip-v2' }), 'retained-v2');
  const first = encodePractice(createPracticeGame({ ruleVersion: 'army-flip-v1' }), 'retained-v1');
  storage.setItem(PRACTICE_V2_STORAGE_KEY, old); storage.setItem(PRACTICE_LEGACY_STORAGE_KEY, first);
  let number = 0;
  const options = { storage, withLock: callback => callback(), randomUUID: () => `v3-${++number}` };
  const session = await createPracticeSession(options);
  assert.equal(session.snapshot().game.ruleVersion, 'army-flip-v2'); assert.equal(session.snapshot().matchId, 'retained-v2');
  await session.restart(); assert.equal(session.snapshot().game.ruleVersion, 'army-flip-v3');
  const current = storage.getItem(PRACTICE_STORAGE_KEY); assert.ok(current);
  assert.equal(storage.getItem(PRACTICE_V2_STORAGE_KEY), old); assert.equal(storage.getItem(PRACTICE_LEGACY_STORAGE_KEY), first);
  storage.setItem(PRACTICE_V2_STORAGE_KEY, old);
  const restored = await createPracticeSession(options); assert.deepEqual(restored.snapshot().game, session.snapshot().game);
  assert.equal(storage.getItem(PRACTICE_STORAGE_KEY), current);
});
test('v3 presentation explains sacrifice explicitly while old v2 instructions keep old mine behavior', () => {
  assert.match(armyRulePages(start()).flat().map(rule => rule.text).join(''), /最小存活官阶.*同归排雷/);
  assert.doesNotMatch(armyRulePages(start({ ruleVersion: 'army-flip-v2' })).flat().map(rule => rule.text).join(''), /同归排雷/);
  assert.match(armyRuleModeLabel(start()), /v3/);
  assert.match(armyLastActionText({ players, game: { lastAction: { type: 'move', playerId: 'alice', outcome: 'mine-sacrifice', flagEvents: [] } } }), /Alice.*地雷同归/);
});
