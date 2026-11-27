const format = 'minesweeper-classic-v1';
export const levels = Object.freeze({
  beginner: Object.freeze({ label: '初级', columns: 9, rows: 9, count: 10 }),
  intermediate: Object.freeze({ label: '中级', columns: 16, rows: 16, count: 40 }),
  expert: Object.freeze({ label: '高级', columns: 30, rows: 16, count: 99 }),
});
export const validLevel = level => Object.hasOwn(levels, level);

export function newGame(level, id) {
  if (!validLevel(level) || typeof id !== 'string' || !id) throw new TypeError('无效的扫雷局');
  return { format, id, level, phase: 'ready', revision: 0, mines: null, first: null,
    opened: [], flags: [], questions: [], started: null, ended: null, spent: null,
    hit: null, lastTime: null, clockOK: true };
}

export function neighbors(index, { rows, columns }) {
  const row = Math.floor(index / columns), column = index % columns, result = [];
  for (let y = Math.max(0, row - 1); y <= Math.min(row + 1, rows - 1); y++) {
    for (let x = Math.max(0, column - 1); x <= Math.min(column + 1, columns - 1); x++) {
      if (y !== row || x !== column) result.push(y * columns + x);
    }
  }
  return result;
}

export const numbers = (game, mines = new Set(game.mines)) => {
  const level = levels[game.level];
  return Array.from({ length: level.rows * level.columns }, (_, index) =>
    neighbors(index, level).filter(other => mines.has(other)).length);
};
export const active = game => game.phase === 'ready' || game.phase === 'playing';
export const progress = game => game.phase !== 'ready' || !!(game.flags.length || game.questions.length);

function layMines(total, count, first, random) {
  const eligible = Array.from({ length: total }, (_, i) => i).filter(i => i !== first);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (eligible.length - i));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  return eligible.slice(0, count).sort((a, b) => a - b);
}

export function play(game, action, now, { questions = true, clockOK = true, random = Math.random } = {}) {
  if (!active(game) || action.id !== game.id || action.revision !== game.revision) return game;
  const level = levels[game.level], total = level.rows * level.columns;
  const index = action.index, flags = new Set(game.flags), opened = new Set(game.opened);
  const uncertain = new Set(game.questions);
  const next = { ...game, revision: game.revision + 1 };
  if (game.started !== null) {
    next.clockOK = game.clockOK && clockOK && now >= game.lastTime;
    next.lastTime = Math.max(game.lastTime, now);
  }

  if (action.type === 'clear-questions') {
    return uncertain.size ? { ...next, questions: [] } : game;
  }
  if (!Number.isInteger(index) || index < 0 || index >= total) return game;
  if (action.type === 'mark') {
    if (opened.has(index)) return game;
    if (flags.delete(index)) {
      if (questions) uncertain.add(index);
    } else if (!uncertain.delete(index)) flags.add(index);
    return { ...next, flags: [...flags], questions: [...uncertain] };
  }

  let targets;
  if (action.type === 'reveal' && !flags.has(index) && !opened.has(index)) {
    targets = [index];
  } else if (action.type === 'chord' && opened.has(index)) {
    const around = neighbors(index, level), count = around.filter(cell => game.mines.includes(cell)).length;
    if (!count || count !== around.filter(cell => flags.has(cell)).length) return game;
    targets = around.filter(cell => !flags.has(cell) && !opened.has(cell));
    if (!targets.length) return game;
  } else return game;

  if (game.phase === 'ready') {
    next.mines = layMines(total, level.count, index, random);
    next.first = index;
    next.started = next.lastTime = now;
    next.phase = 'playing';
  }
  const mines = new Set(next.mines), counts = numbers(next, mines);
  const hit = targets.filter(cell => mines.has(cell)).sort((a, b) => a - b)[0];
  const queue = [...targets];
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i];
    if (flags.has(cell) || opened.has(cell) || mines.has(cell)) continue;
    opened.add(cell);
    uncertain.delete(cell);
    if (!counts[cell]) queue.push(...neighbors(cell, level));
  }
  next.opened = [...opened];
  next.questions = [...uncertain];
  if (hit !== undefined || opened.size === total - level.count) {
    next.hit = hit ?? null;
    next.phase = hit !== undefined ? 'lost' : 'won';
    next.ended = next.lastTime;
    next.spent = Math.floor((next.ended - next.started) / 1000);
  }
  return next;
}

export function validGame(game, level) {
  if (!game || !validLevel(level) || game.format !== format || game.level !== level
    || typeof game.id !== 'string' || !game.id || game.id.length > 80
    || !Number.isSafeInteger(game.revision) || game.revision < 0 || typeof game.clockOK !== 'boolean') return false;
  const { rows, columns, count } = levels[level], total = rows * columns;
  const index = i => Number.isInteger(i) && i >= 0 && i < total;
  const list = (value, length) => Array.isArray(value) && value.length <= total
    && (length === undefined || value.length === length) && new Set(value).size === value.length && value.every(index);
  const stamp = value => Number.isSafeInteger(value) && value >= 0;
  const { phase, mines, opened, flags, questions, first, started, ended, lastTime, hit, spent } = game;
  if (!list(opened) || !list(flags) || !list(questions)
    || new Set([...opened, ...flags, ...questions]).size !== opened.length + flags.length + questions.length) return false;
  if (phase === 'ready') return !opened.length && [mines, first, started, ended, lastTime, hit, spent].every(value => value === null);
  if (!list(mines, count) || !index(first) || !opened.includes(first) || !stamp(started)
    || !stamp(lastTime) || started > lastTime || opened.some(cell => mines.includes(cell))) return false;
  const allSafe = opened.length === total - count;
  if (phase === 'playing') return !allSafe && ended === null && hit === null && spent === null;
  if (ended !== lastTime || spent !== Math.floor((ended - started) / 1000)) return false;
  if (phase === 'won') return allSafe && hit === null;
  return phase === 'lost' && mines.includes(hit) && !flags.includes(hit);
}
