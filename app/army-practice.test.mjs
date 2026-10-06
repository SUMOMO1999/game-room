import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, privateView, gameProblem } from './army-rules.mjs';
import { BOARD_CELLS } from './army-board.mjs';
import { createPracticeGame, applyPracticeAction, practiceProblem, practiceView,
  choosePracticeAction, encodePractice, decodePractice, createPracticeSession,
  PRACTICE_SELF, PRACTICE_BOT, PRACTICE_PLAYERS, PRACTICE_STORAGE_KEY,
  PRACTICE_LEGACY_STORAGE_KEY, PRACTICE_V2_STORAGE_KEY } from './army-practice-engine.mjs';

const fixedRandom = maximum => maximum - 1;
const initial = (ruleVersion = 'army-flip-v1') => createPracticeGame({ ruleVersion, randomInt: fixedRandom, firstTurnIndex: 0 });
const pieces = game => [...game.board.flatMap(({ piece }) => piece ? [piece] : []), ...game.captured,
  ...(game.flagTokens || []).map(({ piece }) => piece)];
const locate = (game, id) => game.board.find(({ piece }) => piece?.id === id).cellId;
function stepBoth(game, playerId, action) {
  const local = applyPracticeAction(game, playerId, action), official = applyGameAction(game, playerId, action);
  assert.deepEqual(local, official);
  if (local.ok) {
    assert.equal(practiceProblem(local.state), null);
    assert.equal(pieces(local.state).length, 50);
    for (const { id } of PRACTICE_PLAYERS) assert.deepEqual(practiceView(local.state, id), privateView(official.state, id));
    return local.state;
  }
  return game;
}
function withFlags(game, tokens) {
  for (const { side, carrierId = null, cellId = null } of tokens) {
    const entry = game.board.find(({ piece }) => piece?.kind === 'flag' && piece.side === side);
    assert.ok(entry); const flag = entry.piece; entry.piece = null;
    game.flagTokens.push({ piece: { ...flag, revealed: true }, carrierId, cellId });
  }
  assert.equal(practiceProblem(game), null);
  return game;
}
function position(placements, { hidden = [], turnIndex = 0, ruleVersion = 'army-flip-v1' } = {}) {
  const game = initial(ruleVersion), deck = new Map(pieces(game).map(piece => [piece.id, piece]));
  const entries = { r0c1: 'red-flag-1', r11c3: 'black-flag-1', ...placements }, used = new Set();
  game.board = BOARD_CELLS.map(({ cellId }) => {
    const id = entries[cellId];
    if (!id) return { cellId, piece: null };
    assert.ok(deck.has(id) && !used.has(id)); used.add(id);
    return { cellId, piece: { ...deck.get(id), revealed: !hidden.includes(cellId) } };
  });
  game.captured = [...deck.values()].filter(({ id }) => !used.has(id)).map(piece => ({ ...piece, revealed: true }));
  game.players[0].side = 'red'; game.players[1].side = 'black';
  game.players[0].lastFlipSide = 'red'; game.players[1].lastFlipSide = 'black';
  game.turnIndex = turnIndex; game.round = 51; game.revision = 51;
  game.lastAction = { type: 'decline-draw', playerId: PRACTICE_BOT };
  assert.equal(practiceProblem(game), null);
  return game;
}
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function timers() {
  let sequence = 0;
  const jobs = new Map();
  return {
    setTimer: callback => { const id = ++sequence; jobs.set(id, { callback, cancelled: false }); return id; },
    clearTimer: id => { if (jobs.has(id)) jobs.get(id).cancelled = true; },
    pending: () => [...jobs].filter(([, job]) => !job.cancelled).map(([id]) => id),
    fire: id => { const job = jobs.get(id); job.cancelled = true; return job.callback(); },
  };
}
const mutexes = new WeakMap();
function mutex(storage) {
  const identity = storage || {};
  if (!mutexes.has(identity)) {
    let tail = Promise.resolve();
    mutexes.set(identity, callback => {
      const next = tail.then(callback); tail = next.catch(() => {}); return next;
    });
  }
  return mutexes.get(identity);
}
async function sessionFixture(options = {}) {
  const storage = Object.hasOwn(options, 'storage') ? options.storage : memoryStorage();
  const timer = timers(), changes = [];
  let match = 0;
  const session = await createPracticeSession({ storage, ...timer, randomInt: () => 0,
    randomUUID: () => `practice-${++match}`, withLock: mutex(storage),
    onChange: snapshot => changes.push(snapshot), ...options });
  return { session, storage, timer, changes };
}

test('army practice starts with the official v1 deck, hidden projection and synthetic identities', () => {
  const game = initial(), official = createGame(PRACTICE_PLAYERS, { ruleVersion: 'army-flip-v1', randomInt: fixedRandom, firstTurnIndex: 0 });
  assert.deepEqual(game, official); assert.equal(gameProblem(game), null);
  assert.equal(pieces(game).length, 50);
  assert.equal(game.board.filter(({ piece }) => piece && !piece.revealed).length, 50);
  assert.equal(game.board.filter(({ piece }) => !piece).length, 10);
  for (const { piece } of practiceView(game).board) if (piece) assert.deepEqual(piece, { hidden: true });
  assert.deepEqual(game.players.map(({ id }) => id), [PRACTICE_SELF, PRACTICE_BOT]);
});
test('army practice consecutive own colors include bombs and exactly match the official assignment', () => {
  let game = initial();
  for (const [playerId, id] of [[PRACTICE_SELF, 'red-bomb-1'], [PRACTICE_BOT, 'black-bomb-1'], [PRACTICE_SELF, 'red-bomb-2']]) {
    game = stepBoth(game, playerId, { type: 'flip', cellId: locate(game, id) });
  }
  assert.equal(game.players[0].side, 'red'); assert.equal(game.players[1].side, 'black');
});
test('army practice topology, mine protection, camps, combat and results match official v1', () => {
  const cases = [
    [position({ r1c2: 'red-engineer-1', r10c2: 'black-engineer-1' }), { type: 'move', from: 'r1c2', to: 'r6c2' }, true],
    [position({ r1c2: 'red-engineer-1', r10c2: 'black-engineer-1' }), { type: 'move', from: 'r1c2', to: 'r3c2' }, false],
    [position({ r1c0: 'red-commander-1', r1c2: 'black-general-1', r10c0: 'black-engineer-1' }, { hidden: ['r1c2'] }), { type: 'move', from: 'r1c0', to: 'r1c3' }, false],
    [position({ r1c0: 'red-company-1', r2c1: 'black-engineer-1', r10c4: 'black-company-1' }), { type: 'move', from: 'r1c0', to: 'r2c1' }, false],
    [position({ r1c1: 'red-engineer-1', r1c2: 'black-mine-1', r10c4: 'black-company-1' }), { type: 'move', from: 'r1c1', to: 'r1c2' }, true],
    [position({ r10c3: 'red-bomb-1', r11c4: 'black-mine-1', r10c0: 'black-company-1' }, { hidden: ['r11c4'] }), { type: 'move', from: 'r10c3', to: 'r11c3' }, false],
    [position({ r10c3: 'red-bomb-1', r10c0: 'black-company-1' }), { type: 'move', from: 'r10c3', to: 'r11c3' }, true],
    [position({ r1c1: 'red-commander-1', r1c2: 'black-company-1' }), { type: 'move', from: 'r1c1', to: 'r1c2' }, true],
  ];
  for (const [game, action, success] of cases) {
    assert.equal(applyPracticeAction(game, PRACTICE_SELF, action).ok, success);
    stepBoth(game, PRACTICE_SELF, action);
  }
});
test('army practice legacy v1 legal automatic opponent stays identical to server through seeded games', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const seeded = start => { let state = start; return maximum => { state = (state * 16807) % 2147483647; return state % maximum; }; };
    let game = createPracticeGame({ ruleVersion: 'army-flip-v1', randomInt: seeded(seed) });
    assert.deepEqual(game, createGame(PRACTICE_PLAYERS, { ruleVersion: 'army-flip-v1', randomInt: seeded(seed) }));
    const random = seeded(seed + 20);
    for (let count = 0; count < 150 && game.status === 'playing'; count++) {
      const playerId = game.players[game.turnIndex].id, visible = practiceView(game, playerId);
      const action = playerId === PRACTICE_BOT ? choosePracticeAction(visible, random)
        : visible.legalFlips.length ? { type: 'flip', cellId: visible.legalFlips[random(visible.legalFlips.length)] }
          : { type: 'move', ...visible.legalMoves[random(visible.legalMoves.length)] };
      assert.ok(action, `seed ${seed}, step ${count}`);
      assert.ok(action.type === 'flip' ? visible.legalFlips.includes(action.cellId)
        : visible.legalMoves.some(move => move.from === action.from && move.to === action.to));
      game = stepBoth(game, playerId, action);
    }
  }
});
test('army practice bot cannot distinguish or select using permuted hidden identities', () => {
  let game = initial();
  for (const [playerId, id] of [[PRACTICE_SELF, 'red-flag-1'], [PRACTICE_BOT, 'black-flag-1'], [PRACTICE_SELF, 'red-commander-1']]) {
    game = stepBoth(game, playerId, { type: 'flip', cellId: locate(game, id) });
  }
  const shuffled = structuredClone(game), hidden = shuffled.board.filter(({ piece }) => piece && !piece.revealed);
  const secret = hidden.map(({ piece }) => piece).reverse(); hidden.forEach((entry, index) => { entry.piece = secret[index]; });
  assert.equal(practiceProblem(shuffled), null);
  assert.deepEqual(practiceView(game, PRACTICE_BOT), practiceView(shuffled, PRACTICE_BOT));
  assert.deepEqual(choosePracticeAction(practiceView(game, PRACTICE_BOT), fixedRandom), choosePracticeAction(practiceView(shuffled, PRACTICE_BOT), fixedRandom));
  assert.equal(choosePracticeAction(practiceView(game)), null);
  const ended = applyPracticeAction(game, PRACTICE_SELF, { type: 'resign' }).state;
  assert.equal(choosePracticeAction(practiceView(ended, PRACTICE_BOT)), null);
});
test('army practice bot takes a revealed flag or safely digs a revealed mine using legal actions', () => {
  const flag = position({ r1c1: 'black-bomb-1', r10c4: 'red-company-1' }, { turnIndex: 1 });
  const action = choosePracticeAction(practiceView(flag, PRACTICE_BOT), () => 0);
  assert.deepEqual(action, { type: 'move', from: 'r1c1', to: 'r0c1' });
  assert.equal(stepBoth(flag, PRACTICE_BOT, action).result.reason, 'flag-captured');
  const mine = position({ r1c1: 'black-engineer-1', r1c2: 'red-mine-1', r10c4: 'red-company-1', r0c0: 'red-mine-2' }, { turnIndex: 1 });
  const dig = choosePracticeAction(practiceView(mine, PRACTICE_BOT), () => 0);
  assert.equal(mine.board.find(({ cellId }) => cellId === dig.to).piece.kind, 'mine');
  assert.equal(stepBoth(mine, PRACTICE_BOT, dig).lastAction.outcome, 'capture');
});
test('army practice saves reject malformed, future, foreign identity or forged chess state', () => {
  const game = initial(), saved = encodePractice(game, 'practice-original');
  assert.deepEqual(decodePractice(saved).game, game);
  for (const value of [null, '', '{', 'x'.repeat(65537), JSON.stringify({ version: 2 })]) assert.equal(decodePractice(value), null);
  const alterations = [
    value => { value.version = 2; }, value => { value.kind = 'real-room'; },
    value => { value.game.players[0].id = 'real-account-sub'; },
    value => { value.game.ruleVersion = 'army-flip-v3'; }, value => { value.game.assignment = 'first-flip'; },
    value => { value.game.board[1].piece.id = value.game.board[0].piece.id; },
    value => { value.game.board[0].piece = null; }, value => { value.game.board[0].piece.kind = 'flag'; },
    value => { value.game.winnerId = PRACTICE_SELF; }, value => { value.matchId = '<script>'; },
    value => { value.game.status = 'finished'; value.game.result = { winnerIds: [PRACTICE_SELF] }; },
  ];
  for (const alter of alterations) { const value = JSON.parse(saved); alter(value); assert.equal(decodePractice(JSON.stringify(value)), null); }
});

test('army practice new games default to v3 while every initial piece remains genuinely hidden', () => {
  const game = createPracticeGame({ randomInt: fixedRandom, firstTurnIndex: 0 });
  assert.equal(game.version, 3); assert.equal(game.ruleVersion, 'army-flip-v3');
  assert.deepEqual(game, createGame(PRACTICE_PLAYERS, { ruleVersion: 'army-flip-v3', randomInt: fixedRandom, firstTurnIndex: 0 }));
  assert.equal(pieces(game).length, 50);
  const view = practiceView(game);
  assert.deepEqual(view.flagTokens, []); assert.deepEqual(view.legalPickups, []);
  for (const { piece } of view.board) if (piece) assert.deepEqual(piece, { hidden: true });
  assert.deepEqual(decodePractice(encodePractice(game, 'v2-first-match')).game, game);
});

test('army practice v2 automatic opponent and every public action match official rules through seeded games', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const seeded = start => { let state = start; return maximum => { state = (state * 16807) % 2147483647; return state % maximum; }; };
    let game = createPracticeGame({ ruleVersion: 'army-flip-v2', randomInt: seeded(seed) });
    assert.deepEqual(game, createGame(PRACTICE_PLAYERS, { ruleVersion: 'army-flip-v2', randomInt: seeded(seed) }));
    const random = seeded(seed + 40);
    for (let count = 0; count < 240 && game.status === 'playing'; count++) {
      const playerId = game.players[game.turnIndex].id, view = practiceView(game, playerId);
      const action = playerId === PRACTICE_BOT ? choosePracticeAction(view, random)
        : view.legalFlips.length ? { type: 'flip', cellId: view.legalFlips[random(view.legalFlips.length)] }
          : view.legalPickups.length ? { type: 'pickup', ...view.legalPickups[random(view.legalPickups.length)] }
            : { type: 'move', ...view.legalMoves[random(view.legalMoves.length)] };
      assert.ok(action, `v2 seed ${seed}, step ${count}`);
      assert.ok(action.type === 'flip' ? view.legalFlips.includes(action.cellId)
        : action.type === 'pickup' ? view.legalPickups.some(item => item.cellId === action.cellId && item.flagSide === action.flagSide)
          : view.legalMoves.some(move => move.from === action.from && move.to === action.to));
      assert.equal(applyPracticeAction(game, playerId, action).ok, true);
      game = stepBoth(game, playerId, action);
    }
  }
});

test('army practice v2 hidden collisions and bot choices do not reveal hidden side, kind or identity', () => {
  const game = position({ r1c0: 'black-company-1', r1c2: 'red-mine-1', r1c3: 'black-commander-1', r10c4: 'red-company-1' },
    { turnIndex: 1, ruleVersion: 'army-flip-v2', hidden: ['r1c2', 'r1c3'] });
  const changed = structuredClone(game);
  const a = changed.board.find(({ cellId }) => cellId === 'r1c2'), b = changed.board.find(({ cellId }) => cellId === 'r1c3');
  [a.piece, b.piece] = [b.piece, a.piece];
  assert.equal(practiceProblem(changed), null);
  assert.deepEqual(practiceView(game, PRACTICE_BOT), practiceView(changed, PRACTICE_BOT));
  assert.deepEqual(choosePracticeAction(practiceView(game, PRACTICE_BOT), fixedRandom), choosePracticeAction(practiceView(changed, PRACTICE_BOT), fixedRandom));
  assert.ok(practiceView(game, PRACTICE_BOT).legalMoves.some(({ from, to }) => from === 'r1c0' && to === 'r1c2'));
  const action = { type: 'move', from: 'r1c0', to: 'r1c2' };
  assert.equal(applyPracticeAction(game, PRACTICE_BOT, action).ok, true);
  stepBoth(game, PRACTICE_BOT, action); stepBoth(changed, PRACTICE_BOT, action);
});

test('army practice v2 bot takes an eligible enemy flag and transports it to its public home base', () => {
  let game = position({ r0c1: null, r9c0: 'red-flag-1', r10c0: 'black-engineer-1', r10c4: 'red-company-1',
    r8c4: 'black-commander-1', r8c3: 'black-company-1', r9c4: 'black-platoon-1' },
    { ruleVersion: 'army-flip-v2', turnIndex: 1, hidden: ['r8c4', 'r8c3', 'r9c4'] });
  const first = choosePracticeAction(practiceView(game, PRACTICE_BOT), () => 0);
  assert.deepEqual(first, { type: 'move', from: 'r10c0', to: 'r9c0' });
  game = stepBoth(game, PRACTICE_BOT, first);
  assert.equal(game.status, 'playing'); assert.equal(game.lastAction.outcome, 'flag-pickup');
  assert.deepEqual(practiceView(game).flagTokens, [{ side: 'red', carrierId: 'black-engineer-1', cellId: null }]);
  for (let turn = 0; turn < 8 && game.status === 'playing'; turn++) {
    const id = game.players[game.turnIndex].id, view = practiceView(game, id);
    const action = id === PRACTICE_BOT ? choosePracticeAction(view, () => 0)
      : view.legalFlips.length ? { type: 'flip', cellId: view.legalFlips[0] } : { type: 'move', ...view.legalMoves[0] };
    assert.equal(applyPracticeAction(game, id, action).ok, true);
    game = stepBoth(game, id, action);
  }
  assert.equal(game.result?.reason, 'flag-delivered'); assert.equal(game.winnerId, PRACTICE_BOT);
  assert.ok(['r0c1', 'r0c3'].includes(game.flagTokens[0].cellId));
});

test('army practice v2 own flag returns home without victory and cannot be repeatedly picked there', () => {
  let game = withFlags(position({ r10c1: 'red-engineer-1', r1c4: 'black-company-1' },
    { ruleVersion: 'army-flip-v2' }), [{ side: 'red', carrierId: 'red-engineer-1' }]);
  game = stepBoth(game, PRACTICE_SELF, { type: 'move', from: 'r10c1', to: 'r11c1' });
  assert.equal(game.status, 'playing'); assert.equal(game.result, null);
  assert.deepEqual(game.lastAction.flagEvents, [{ type: 'returned', side: 'red', cellId: 'r11c1', carrierId: 'red-engineer-1' }]);
  game = stepBoth(game, PRACTICE_BOT, { type: 'move', from: 'r1c4', to: 'r1c3' });
  assert.deepEqual(practiceView(game).legalPickups, []);
  assert.equal(applyPracticeAction(game, PRACTICE_SELF, { type: 'pickup', cellId: 'r11c1', flagSide: 'red' }).ok, false);
  stepBoth(game, PRACTICE_SELF, { type: 'pickup', cellId: 'r11c1', flagSide: 'red' });
});

test('army practice v2 carrier deaths drop both canonical flags on one cell and the bot chooses the enemy pickup', () => {
  const duel = withFlags(position({ r5c0: 'red-engineer-1', r6c0: 'black-engineer-1',
    r1c4: 'red-company-1', r10c4: 'black-company-1' }, { ruleVersion: 'army-flip-v2' }),
    [{ side: 'red', carrierId: 'black-engineer-1' }, { side: 'black', carrierId: 'red-engineer-1' }]);
  const fallen = stepBoth(duel, PRACTICE_SELF, { type: 'move', from: 'r5c0', to: 'r6c0' });
  assert.equal(fallen.lastAction.outcome, 'mutual');
  assert.equal(fallen.lastAction.flagEvents.filter(({ type }) => type === 'drop').length, 2);
  assert.ok(fallen.flagTokens.every(token => token.carrierId === null && token.cellId === 'r6c0'));
  assert.deepEqual(decodePractice(encodePractice(fallen, 'both-flags-dropped')).game, fallen);
  const ground = withFlags(position({ r6c0: 'black-company-1', r1c4: 'red-company-1' },
    { ruleVersion: 'army-flip-v2', turnIndex: 1 }),
    [{ side: 'red', cellId: 'r6c0' }, { side: 'black', cellId: 'r6c0' }]);
  assert.deepEqual(practiceView(ground, PRACTICE_BOT).legalPickups,
    [{ cellId: 'r6c0', flagSide: 'red' }, { cellId: 'r6c0', flagSide: 'black' }]);
  const action = choosePracticeAction(practiceView(ground, PRACTICE_BOT), fixedRandom);
  assert.deepEqual(action, { type: 'pickup', cellId: 'r6c0', flagSide: 'red' });
  const carrying = stepBoth(ground, PRACTICE_BOT, action);
  assert.equal(carrying.flagTokens.find(({ piece }) => piece.side === 'red').carrierId, 'black-company-1');
  stepBoth(ground, PRACTICE_BOT, { type: 'pickup', cellId: 'r6c0', flagSide: 'black' });
});

test('army practice v2 surviving eligible capturer takes a dead carrier flag using only public deaths', () => {
  const game = withFlags(position({ r5c0: 'red-engineer-1', r6c0: 'black-platoon-1', r1c4: 'red-company-1' },
    { ruleVersion: 'army-flip-v2', turnIndex: 1 }), [{ side: 'black', carrierId: 'red-engineer-1' }]);
  const next = stepBoth(game, PRACTICE_BOT, { type: 'move', from: 'r6c0', to: 'r5c0' });
  assert.equal(next.lastAction.outcome, 'capture');
  assert.deepEqual(next.lastAction.flagEvents.map(({ type }) => type), ['drop', 'pickup']);
  assert.equal(next.flagTokens[0].carrierId, 'black-platoon-1');
  assert.deepEqual(decodePractice(encodePractice(next, 'carrier-recaptured')).game, next);
});

test('army practice v2 pickup attempts on every hidden side and kind have the same refusal and preserve the state', () => {
  const refusals = [];
  for (const kind of ['engineer', 'platoon', 'company', 'mine', 'flag', 'bomb']) {
    for (const side of ['red', 'black']) {
      const placements = { r1c2: `${side}-${kind}-1`, r10c4: 'red-company-2', r8c0: 'black-company-2' };
      if (kind === 'flag') placements[side === 'red' ? 'r0c1' : 'r11c3'] = null;
      const game = position(placements, { ruleVersion: 'army-flip-v2', hidden: ['r1c2'] });
      const before = encodePractice(game, 'dark-pickup-refused');
      const action = { type: 'pickup', cellId: 'r1c2', flagSide: 'black' };
      const local = applyPracticeAction(game, PRACTICE_SELF, action), official = applyGameAction(game, PRACTICE_SELF, action);
      assert.deepEqual(local, official); assert.equal(local.ok, false); refusals.push(local.error);
      assert.equal(encodePractice(game, 'dark-pickup-refused'), before);
    }
  }
  assert.equal(new Set(refusals).size, 1);
});

test('army practice v2 carrier refresh and simultaneous tabs deliver a flag exactly once', async () => {
  const game = withFlags(position({ r1c1: 'black-engineer-1', r10c4: 'red-company-1' },
    { ruleVersion: 'army-flip-v2', turnIndex: 1 }), [{ side: 'red', carrierId: 'black-engineer-1' }]);
  const storage = memoryStorage(); storage.setItem(PRACTICE_V2_STORAGE_KEY, encodePractice(game, 'carrying-on-return'));
  const abandoned = await sessionFixture({ storage }); await abandoned.session.resume();
  const oldTimer = abandoned.timer.pending()[0]; abandoned.session.suspend(); await abandoned.timer.fire(oldTimer);
  assert.equal(decodePractice(storage.getItem(PRACTICE_V2_STORAGE_KEY)).game.revision, 51);
  const first = await sessionFixture({ storage }), second = await sessionFixture({ storage });
  await first.session.resume(); await second.session.resume();
  await first.timer.fire(first.timer.pending()[0]); await second.timer.fire(second.timer.pending()[0]);
  const saved = decodePractice(storage.getItem(PRACTICE_V2_STORAGE_KEY));
  assert.equal(saved.game.revision, 52); assert.equal(saved.game.result.reason, 'flag-delivered');
  assert.deepEqual(first.session.snapshot().game, second.session.snapshot().game);
  assert.equal(first.changes.at(-1).baseline, false); assert.equal(second.changes.at(-1).baseline, true);
  assert.equal(first.timer.pending().length, 0); assert.equal(second.timer.pending().length, 0);
});

test('army practice v2 human pickup is confirmed and saved before the automatic opponent may act', async () => {
  const game = withFlags(position({ r6c0: 'red-company-1', r1c4: 'black-company-1' },
    { ruleVersion: 'army-flip-v2' }), [{ side: 'black', cellId: 'r6c0' }]);
  const storage = memoryStorage(); storage.setItem(PRACTICE_V2_STORAGE_KEY, encodePractice(game, 'human-pickup'));
  const fixture = await sessionFixture({ storage }); await fixture.session.resume();
  const action = { type: 'pickup', cellId: 'r6c0', flagSide: 'black' };
  assert.equal((await fixture.session.act(action)).ok, true);
  const saved = decodePractice(storage.getItem(PRACTICE_V2_STORAGE_KEY));
  assert.equal(saved.game.revision, 52); assert.equal(saved.game.flagTokens[0].carrierId, 'red-company-1');
  assert.equal(fixture.timer.pending().length, 1);
  assert.equal((await fixture.session.act(action)).ok, false);
  assert.equal(decodePractice(storage.getItem(PRACTICE_V2_STORAGE_KEY)).game.revision, 52);
  assert.equal(fixture.timer.pending().length, 1);
});
test('army practice saves a confirmed human move before bot delay and restores bot exactly once', async () => {
  const fixture = await sessionFixture(), { session, storage, timer } = fixture;
  await session.resume();
  const cellId = session.snapshot().game.legalFlips[0];
  assert.equal((await session.act({ type: 'flip', cellId })).ok, true);
  assert.equal(decodePractice(storage.getItem(PRACTICE_STORAGE_KEY)).game.revision, 1);
  const abandoned = timer.pending()[0]; session.suspend(); await timer.fire(abandoned);
  assert.equal(decodePractice(storage.getItem(PRACTICE_STORAGE_KEY)).game.revision, 1);
  const restored = await sessionFixture({ storage }); await restored.session.resume(); await restored.session.resume();
  assert.equal(restored.timer.pending().length, 1);
  const next = restored.timer.pending()[0]; await restored.timer.fire(next); await restored.timer.fire(next);
  assert.equal(restored.session.snapshot().game.revision, 2);
  assert.equal(decodePractice(storage.getItem(PRACTICE_STORAGE_KEY)).game.revision, 2);
  assert.equal(restored.timer.pending().length, 0);
  assert.equal(restored.changes.at(-1).baseline, false);
  await restored.session.resume(); assert.equal(restored.changes.at(-1).baseline, true);
});
test('army practice stale timeout cannot erase replacement timer or overwrite a restarted game', async () => {
  const { session, timer, storage } = await sessionFixture();
  await session.resume(); await session.act({ type: 'flip', cellId: session.snapshot().game.legalFlips[0] });
  const old = timer.pending()[0]; session.suspend(); await session.resume();
  const current = timer.pending()[0]; await timer.fire(old);
  assert.equal(session.snapshot().game.revision, 1); assert.deepEqual(timer.pending(), [current]);
  const previousMatch = session.snapshot().matchId; await session.restart(); await timer.fire(current);
  assert.notEqual(session.snapshot().matchId, previousMatch); assert.equal(session.snapshot().game.revision, 0);
  assert.equal(decodePractice(storage.getItem(PRACTICE_STORAGE_KEY)).game.revision, 0);
});
test('army practice concurrent tabs read latest confirmed state and discard stale bot timers', async () => {
  const first = await sessionFixture(); await first.session.resume(); await first.session.act({ type: 'flip', cellId: first.session.snapshot().game.legalFlips[0] });
  const second = await sessionFixture({ storage: first.storage }); await second.session.resume();
  await first.timer.fire(first.timer.pending()[0]);
  await second.timer.fire(second.timer.pending()[0]);
  assert.equal(first.session.snapshot().game.revision, 2); assert.equal(second.session.snapshot().game.revision, 2);
  assert.equal(second.changes.at(-1).baseline, true); assert.equal(second.timer.pending().length, 0);
});
test('army practice exclusive lock prevents interleaved two-tab bot read/write from overwriting a confirmed move', async () => {
  const storage = memoryStorage();
  storage.setItem(PRACTICE_STORAGE_KEY, encodePractice(createPracticeGame({ randomInt: fixedRandom }), 'shared-bot-turn'));
  const first = await sessionFixture({ storage }), second = await sessionFixture({ storage, randomInt: fixedRandom });
  await first.session.resume(); await second.session.resume();
  const originalRead = storage.getItem;
  let interleaved;
  storage.getItem = key => {
    const value = originalRead(key);
    if (!interleaved) interleaved = second.timer.fire(second.timer.pending()[0]);
    return value;
  };
  await first.timer.fire(first.timer.pending()[0]); await interleaved;
  const saved = decodePractice(originalRead(PRACTICE_STORAGE_KEY));
  assert.equal(saved.game.revision, 1); assert.equal(saved.game.round, 2);
  assert.deepEqual(first.session.snapshot().game, second.session.snapshot().game);
  assert.deepEqual(first.session.snapshot().game, practiceView(saved.game));
});
test('army practice rejected lock falls back to unsaved memory without replaying or touching an existing save', async () => {
  const storage = memoryStorage(), original = encodePractice(initial('army-flip-v3'), 'keep-original');
  storage.setItem(PRACTICE_STORAGE_KEY, original);
  const { session } = await sessionFixture({ storage, withLock: async () => { throw new DOMException('Denied', 'SecurityError'); } });
  await session.resume();
  assert.equal(session.snapshot().storageAvailable, false);
  assert.equal((await session.act({ type: 'flip', cellId: session.snapshot().game.legalFlips[0] })).ok, true);
  assert.equal(storage.getItem(PRACTICE_STORAGE_KEY), original);
});
test('army practice browser without Web Locks uses an explicit unsaved game and leaves shared save intact', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), storage = memoryStorage();
  const original = encodePractice(initial('army-flip-v3'), 'keep-original'); storage.setItem(PRACTICE_STORAGE_KEY, original);
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const { session } = await sessionFixture({ storage, withLock: undefined }); await session.resume();
    assert.equal(session.snapshot().storageAvailable, false);
    assert.equal((await session.act({ type: 'flip', cellId: session.snapshot().game.legalFlips[0] })).ok, true);
    assert.equal(storage.getItem(PRACTICE_STORAGE_KEY), original);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator;
  }
});
test('army practice storage rejection uses an explicit unsaved memory session', async () => {
  const rejecting = { getItem() { throw new DOMException('Denied', 'SecurityError'); }, setItem() { throw new DOMException('Denied', 'SecurityError'); } };
  const { session } = await sessionFixture({ storage: rejecting }); await session.resume();
  assert.equal(session.snapshot().storageAvailable, false);
  assert.equal((await session.act({ type: 'flip', cellId: session.snapshot().game.legalFlips[0] })).ok, true);
  assert.equal(session.snapshot().game.revision, 1); assert.equal(session.snapshot().storageAvailable, false);
});
test('army practice transient storage failure permanently isolates the page and cannot overwrite a shared save', async () => {
  for (const failDuringInitialization of [false, true]) {
    const storage = memoryStorage(), original = encodePractice(initial('army-flip-v3'), 'preserve-after-failure');
    storage.setItem(PRACTICE_STORAGE_KEY, original);
    const read = storage.getItem;
    let denied = failDuringInitialization;
    storage.getItem = key => { if (denied) throw new DOMException('Temporarily denied', 'SecurityError'); return read(key); };
    const { session } = await sessionFixture({ storage });
    denied = true; await session.resume();
    assert.equal(session.snapshot().storageAvailable, false);
    denied = false;
    assert.equal((await session.act({ type: 'flip', cellId: session.snapshot().game.legalFlips[0] })).ok, true);
    assert.equal(session.snapshot().storageAvailable, false);
    assert.equal(read(PRACTICE_STORAGE_KEY), original);
  }
});
test('army practice denied default localStorage getter does not prevent playing', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Denied', 'SecurityError'); } });
    const { session } = await sessionFixture({ storage: undefined }); await session.resume();
    assert.equal(session.snapshot().storageAvailable, false);
    assert.equal((await session.act({ type: 'flip', cellId: session.snapshot().game.legalFlips[0] })).ok, true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage;
  }
});
test('army practice unavailable foreground never executes or replays a delayed action', async () => {
  let foreground = true;
  const { session, timer, storage } = await sessionFixture({ canRun: () => foreground }); await session.resume();
  await session.act({ type: 'flip', cellId: session.snapshot().game.legalFlips[0] });
  foreground = false; await timer.fire(timer.pending()[0]);
  assert.equal(session.snapshot().game.revision, 1);
  assert.equal((await session.act({ type: 'flip', cellId: 'r0c0' })).ok, false);
  foreground = true; await session.resume(); const next = timer.pending()[0]; await timer.fire(next);
  assert.equal(decodePractice(storage.getItem(PRACTICE_STORAGE_KEY)).game.revision, 2);
});

test('army practice preserves a legacy save and only an explicit restart creates its independent v3 save', async () => {
  const storage = memoryStorage(), original = encodePractice(initial(), 'legacy-match');
  storage.setItem(PRACTICE_LEGACY_STORAGE_KEY, original);
  const fixture = await sessionFixture({ storage }); await fixture.session.resume();
  assert.equal(fixture.session.snapshot().game.ruleVersion, 'army-flip-v1');
  assert.equal(fixture.session.snapshot().matchId, 'legacy-match');
  const action = { type: 'flip', cellId: fixture.session.snapshot().game.legalFlips[0] };
  assert.equal((await fixture.session.act(action)).ok, true);
  const legacy = storage.getItem(PRACTICE_LEGACY_STORAGE_KEY);
  assert.equal(decodePractice(legacy).game.revision, 1);
  assert.equal(storage.getItem(PRACTICE_STORAGE_KEY), null);
  const oldTimer = fixture.timer.pending()[0];
  await fixture.session.restart(); await fixture.timer.fire(oldTimer);
  assert.equal(fixture.session.snapshot().game.ruleVersion, 'army-flip-v3');
  assert.equal(fixture.session.snapshot().game.revision, 0);
  assert.equal(storage.getItem(PRACTICE_LEGACY_STORAGE_KEY), legacy);
  assert.equal(decodePractice(storage.getItem(PRACTICE_STORAGE_KEY)).game.ruleVersion, 'army-flip-v3');
  const restored = await sessionFixture({ storage });
  assert.deepEqual(restored.session.snapshot().game, fixture.session.snapshot().game);
});

test('army practice a legacy page adopts another tab v3 restart without applying a stale action', async () => {
  const storage = memoryStorage(), legacy = encodePractice(initial(), 'legacy-to-current');
  storage.setItem(PRACTICE_LEGACY_STORAGE_KEY, legacy);
  const first = await sessionFixture({ storage }), second = await sessionFixture({ storage });
  await first.session.resume(); await second.session.resume();
  const staleAction = { type: 'flip', cellId: first.session.snapshot().game.legalFlips[0] };
  await second.session.restart();
  assert.equal((await first.session.act(staleAction)).ok, false);
  assert.deepEqual(first.session.snapshot().game, second.session.snapshot().game);
  assert.equal(first.session.snapshot().game.ruleVersion, 'army-flip-v3');
  assert.equal(first.changes.at(-1).baseline, true);
  assert.equal(storage.getItem(PRACTICE_LEGACY_STORAGE_KEY), legacy);
});

test('army practice prioritizes v2 and a published old client cannot overwrite its current match', async () => {
  const storage = memoryStorage(), oldGame = initial();
  storage.setItem(PRACTICE_LEGACY_STORAGE_KEY, encodePractice(oldGame, 'published-old-client'));
  const current = encodePractice(initial('army-flip-v2'), 'current-client');
  storage.setItem(PRACTICE_V2_STORAGE_KEY, current);
  const fixture = await sessionFixture({ storage }); await fixture.session.resume();
  assert.equal(fixture.session.snapshot().matchId, 'current-client');
  // Model the published client's v1-only writer under its existing lock.
  const oldResult = applyGameAction(oldGame, PRACTICE_SELF, { type: 'flip', cellId: privateView(oldGame, PRACTICE_SELF).legalFlips[0] });
  assert.equal(oldResult.ok, true);
  const oldWritten = encodePractice(oldResult.state, 'published-old-client');
  await mutex(storage)(() => storage.setItem(PRACTICE_LEGACY_STORAGE_KEY, oldWritten));
  await fixture.session.resume();
  assert.equal(fixture.session.snapshot().matchId, 'current-client');
  assert.equal(fixture.session.snapshot().game.revision, 0);
  assert.equal((await fixture.session.act({ type: 'flip', cellId: fixture.session.snapshot().game.legalFlips[0] })).ok, true);
  assert.equal(decodePractice(storage.getItem(PRACTICE_V2_STORAGE_KEY)).game.revision, 1);
  assert.equal(storage.getItem(PRACTICE_LEGACY_STORAGE_KEY), oldWritten);
});

test('army practice current browsers retain the old Web Lock name to coordinate legacy save writers', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), storage = memoryStorage(), names = [];
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      locks: { request: (name, options, callback) => {
        names.push(name); assert.deepEqual(options, { mode: 'exclusive' }); return mutex(storage)(callback);
      } },
    } });
    const fixture = await sessionFixture({ storage, withLock: undefined }); await fixture.session.resume();
    await fixture.session.act({ type: 'flip', cellId: fixture.session.snapshot().game.legalFlips[0] });
    await fixture.session.restart();
    assert.equal(names.length, 4); assert.ok(names.every(name => name === PRACTICE_LEGACY_STORAGE_KEY));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator;
  }
});

test('army practice unknown or corrupt saves permanently detach without erasing either original key', async () => {
  for (const key of [PRACTICE_STORAGE_KEY, PRACTICE_LEGACY_STORAGE_KEY]) {
    for (const corrupt of ['{', JSON.stringify({ version: 3, kind: 'army-local-practice' })]) {
      const storage = memoryStorage();
      storage.setItem(key, corrupt);
      const untouchedKey = key === PRACTICE_STORAGE_KEY ? PRACTICE_LEGACY_STORAGE_KEY : null;
      const untouched = encodePractice(initial(), 'still-valid-legacy');
      if (untouchedKey) storage.setItem(untouchedKey, untouched);
      const fixture = await sessionFixture({ storage }); await fixture.session.resume();
      assert.equal(fixture.session.snapshot().storageAvailable, false);
      assert.equal(fixture.session.snapshot().game.ruleVersion, 'army-flip-v3');
      assert.equal((await fixture.session.act({ type: 'flip', cellId: fixture.session.snapshot().game.legalFlips[0] })).ok, true);
      await fixture.session.restart();
      assert.equal(storage.getItem(key), corrupt);
      if (untouchedKey) assert.equal(storage.getItem(untouchedKey), untouched);
      else assert.equal(storage.getItem(PRACTICE_STORAGE_KEY), null);
    }
  }
});

test('army practice a future or removed current save is never overwritten by an already open page', async () => {
  for (const replacement of [null, '{', JSON.stringify({ version: 7 })]) {
    const fixture = await sessionFixture(); await fixture.session.resume();
    const original = fixture.session.snapshot();
    if (replacement === null) {
      const read = fixture.storage.getItem;
      fixture.storage.getItem = key => key === PRACTICE_STORAGE_KEY ? null : read(key);
    } else fixture.storage.setItem(PRACTICE_STORAGE_KEY, replacement);
    const attempted = await fixture.session.act({ type: 'flip', cellId: original.game.legalFlips[0] });
    assert.equal(attempted.ok, false); assert.equal(fixture.session.snapshot().game.revision, 0);
    assert.equal(fixture.session.snapshot().storageAvailable, false);
    assert.equal((await fixture.session.act({ type: 'flip', cellId: original.game.legalFlips[0] })).ok, true);
    await fixture.session.restart();
    assert.equal(fixture.storage.getItem(PRACTICE_STORAGE_KEY), replacement);
  }
});
