import test from 'node:test';
import assert from 'node:assert/strict';
import { levels, neighbors, newGame, numbers, play, validGame } from './rules.mjs';

function act(game, type, index, extra, now = 17000) {
  return play(game, { type, index, id: game.id, revision: game.revision }, now, extra);
}
function fixed() {
  return { ...newGame('beginner', 'fixed'), phase: 'playing', revision: 1,
    mines: [0, 10, 72, 73, 74, 75, 76, 77, 78, 79], first: 1, opened: [1], started: 10, lastTime: 10 };
}

test('all three presets sample every mine once, and protect only the first cell', () => {
  for (const [name, spec] of Object.entries(levels)) {
    const game = newGame(name, 'fresh');
    for (let i = 0; i < spec.rows * spec.columns; i++) {
      const first = act(game, 'reveal', i, { random: () => 0 });
      assert(validGame(first, name));
      assert(!first.mines.includes(i));
      assert.equal(first.mines.length, spec.count);
    }
  }
  const first = act(newGame('beginner', 'one'), 'reveal', 0, { random: () => 0 });
  assert(first.mines.includes(1));
  assert.equal(first.opened.length, 1);
  assert.deepEqual(neighbors(8, levels.beginner), [7, 16, 17]);
});

test('flags before play do not start a clock, question marks open, and duplicates preserve revisions', () => {
  const blank = newGame('beginner', 'marks');
  const flagged = act(blank, 'mark', 0);
  assert.equal(act(flagged, 'reveal', 0), flagged);
  assert.equal(flagged.started, null);
  const questioned = act(flagged, 'mark', 0);
  const opened = act(questioned, 'reveal', 0);
  assert(opened.opened.includes(0));
  assert(!opened.questions.includes(0));
  assert.equal(play(opened, { type: 'reveal', index: 5, id: opened.id, revision: questioned.revision }, 20000), opened);
});

test('a documented wrong flag makes chording lose and picks the first mine', () => {
  const game = fixed();
  assert.equal(numbers(game)[1], 2);
  assert.equal(act(game, 'chord', 1), game);
  const marked = act(act(game, 'mark', 2), 'mark', 9);
  const result = act(marked, 'chord', 1);
  assert.equal(result.phase, 'lost');
  assert.equal(result.hit, 0);
  assert(validGame(result, game.level));
  assert.equal(act(result, 'mark', 3), result);
});

test('last safe square wins; a backward clock cannot earn a best', () => {
  const game = fixed();
  game.opened = Array.from({ length: 81 }, (_, i) => i).filter(i => i !== 80 && !game.mines.includes(i));
  game.lastTime = 19000;
  const result = act(game, 'reveal', 80, {}, 15000);
  assert.equal(result.phase, 'won');
  assert.equal(result.clockOK, false);
  assert.equal(result.spent, 18);
  assert(validGame(result, game.level));
  assert(!validGame({ ...result, first: 10 }, game.level));
});
