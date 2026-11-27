import { createGameAudio } from '../../game-audio.mjs';
import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { replacePracticeWithLobby } from '../../platform/practice-navigation.mjs';
import { connectBoard } from './board-input.mjs';
import { active, levels, newGame, numbers, play, progress, validGame, validLevel } from './rules.mjs';
import { acquireLevel, assignOwner, clearBests, openSaves, readLevel, saveLevel } from './save.mjs';

const $ = id => document.getElementById(id);
const board = $('board'), layout = $('mine-layout'), popup = $('popup');
const prefKey = 'sumomo-minesweeper:';
function preference(name, value) {
  try { return value === undefined ? localStorage.getItem(prefKey + name) : localStorage.setItem(prefKey + name, value); }
  catch { return null; }
}
const id = () => globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random();
const audio = createGameAudio();
mountRoomAudioControls({ audio, document });

let db, lock, expected, game, level, best;
let pending = false, readOnly = false, broken = false, temporary = false, dirty = false;
let markMode = false, questions = preference('questions') !== 'off';
let buttons = [], focus = 0, drawnLevel;
let baseWall = Date.now(), baseMonotonic = performance.now(), lastSeen = baseWall, clockOK = true;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('sumomo-minesweeper-v1') : null;
const digits = value => (value < 0 ? '−' : '') + String(Math.abs(value)).padStart(3, '0');

function announce(text) { $('feedback').textContent = text; }
function now() {
  const wall = Date.now();
  clockOK &&= wall >= lastSeen - 1000 && Math.abs(wall - baseWall - (performance.now() - baseMonotonic)) < 6000;
  lastSeen = Math.max(wall, lastSeen);
  return wall;
}
function elapsed() {
  if (!game || game.started === null) return 0;
  return game.ended === null ? Math.floor((Math.max(now(), lastSeen, game.lastTime) - game.started) / 1000) : game.spent;
}
function showClock() { $('elapsed').textContent = digits(Math.min(999, elapsed())); }
function updateMode(flag) {
  markMode = flag;
  $('reveal-mode').setAttribute('aria-pressed', String(!flag));
  $('flag-mode').setAttribute('aria-pressed', String(flag));
}
function buildGrid() {
  const { rows, columns } = levels[level], fragment = document.createDocumentFragment();
  buttons = [];
  layout.dataset.level = level;
  layout.style.setProperty('--board-rows', rows);
  layout.style.setProperty('--board-columns', columns);
  board.setAttribute('aria-rowcount', rows);
  board.setAttribute('aria-colcount', columns);
  for (let y = 0; y < rows; y++) {
    const row = document.createElement('div');
    row.className = 'mine-row';
    row.setAttribute('role', 'row');
    for (let x = 0; x < columns; x++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mine-cell';
      button.dataset.cell = buttons.length;
      button.setAttribute('role', 'gridcell');
      row.append(button);
      buttons.push(button);
    }
    fragment.append(row);
  }
  board.replaceChildren(fragment);
  drawnLevel = level;
}
function setFocus(index, move = false) {
  if (!buttons[index]) return;
  if (buttons[focus]) buttons[focus].tabIndex = -1;
  focus = index;
  buttons[index].tabIndex = 0;
  if (move) buttons[index].focus();
}
function render() {
  if (!game) return;
  const specs = levels[level], mines = new Set(game.mines), flags = new Set(game.flags);
  const opened = new Set(game.opened), uncertain = new Set(game.questions), count = numbers(game, mines);
  const done = !active(game), victory = game.phase === 'won';
  if (drawnLevel !== level) { focus = 0; buildGrid(); }
  for (const [index, button] of buttons.entries()) {
    let state = 'covered', label = '未打开', value = '';
    delete button.dataset.number;
    if (opened.has(index)) {
      state = 'open';
      value = count[index] || '';
      label = value ? '数字 ' + value : '空白';
      if (value) button.dataset.number = value;
    } else if (index === game.hit) {
      state = 'hit'; label = '踩中的雷'; value = '✹';
    } else if (game.phase === 'lost' && flags.has(index) && !mines.has(index)) {
      state = 'wrong'; label = '错误的旗'; value = '×';
    } else if (flags.has(index) || victory && mines.has(index)) {
      state = 'flag'; label = done ? '标出的雷' : '旗'; value = '⚑';
    } else if (game.phase === 'lost' && mines.has(index)) {
      state = 'mine'; label = '地雷'; value = '✹';
    } else if (uncertain.has(index)) {
      state = 'question'; label = '问号'; value = '?';
    }
    button.dataset.state = state;
    button.textContent = value;
    button.setAttribute('aria-label', '第 ' + (Math.floor(index / specs.columns) + 1) + ' 行，第 ' +
      (index % specs.columns + 1) + ' 列，' + label);
    button.setAttribute('aria-disabled', String(done || readOnly || broken));
    button.tabIndex = index === focus ? 0 : -1;
  }
  $('difficulty-name').textContent = specs.label;
  $('difficulty').value = level;
  $('question-pref').checked = questions;
  $('mine-count').textContent = digits(victory ? 0 : specs.count - flags.size);
  $('restart-face').textContent = victory ? '☀︎' : done ? '☹︎' : '☺︎';
  $('restart').disabled = readOnly;
  $('again').disabled = readOnly;
  $('result').hidden = !done;
  $('result-text').textContent = done ? (victory ? '扫雷成功' : '踩到地雷') + ' · ' + game.spent + ' 秒' +
    (victory && best?.seconds === game.spent ? ' · 本机最佳' : '') : '';
  $('save-message').hidden = !(broken || readOnly || temporary);
  $('take-over').hidden = !readOnly || !db;
  $('save-note').textContent = broken ? '存档无法恢复，可明确重开。' :
    readOnly ? '另一标签页正在玩，此页只读。' : '仅本次游玩，进度无法保存。';
  board.setAttribute('aria-busy', String(pending));
  showClock();
}
function dialog(title, body, choices) {
  $('settings-panel').close();
  $('popup-title').textContent = title;
  $('popup-body').replaceChildren(body);
  $('popup-actions').replaceChildren(...choices.map(([label, action]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = () => { popup.close(); void action?.(); };
    return button;
  }));
  if (!popup.open) popup.showModal();
}
const cancelChoice = ['取消'];
function relinquish() { lock?.release(); lock = null; }
async function load(target, { takeover = false, restart = false } = {}) {
  if (pending || !validLevel(target)) return;
  pending = true;
  cancelInput();
  const same = target === level;
  if (!same) relinquish();
  level = target;
  temporary = readOnly = broken = dirty = false;
  let row;
  try {
    if (!db) throw new Error('本机存档不可用');
    if (!lock) {
      lock = await acquireLevel(level, takeover, () => {
        if (level !== target) return;
        readOnly = true; lock = null; render();
      });
      if (lock) row = await assignOwner(db, level, lock.id);
    }
    row ??= await readLevel(db, level);
    readOnly = !lock;
  } catch {
    relinquish();
    temporary = true;
  }
  expected = row?.game;
  best = row?.best;
  broken = expected !== undefined && !validGame(expected, level);
  game = expected && !broken ? expected : newGame(level, id());
  if (restart && !readOnly) {
    broken = false;
    game = newGame(level, id());
    baseWall = lastSeen = Date.now();
    baseMonotonic = performance.now();
    clockOK = true;
    await persist(game);
  } else if (!broken && !questions && !readOnly && game.questions.length) {
    const next = play(game, { type: 'clear-questions', id: game.id, revision: game.revision }, now(), { clockOK });
    if (next !== game) { game = next; await persist(game); }
  }
  preference('level', level);
  updateMode(false);
  pending = false;
  render();
}
async function persist(next, award = false) {
  if (temporary) { dirty = true; return true; }
  try {
    const row = await saveLevel(db, level, lock?.id, expected, next, { award });
    if (!row) {
      const current = await readLevel(db, level);
      game = validGame(current.game, level) ? current.game : newGame(level, id());
      expected = current.game;
      best = current.best;
      broken = current.game !== undefined && !validGame(current.game, level);
      readOnly = true;
      relinquish();
      return false;
    }
    expected = row.game;
    best = row.best;
    channel?.postMessage(level);
    return true;
  } catch {
    relinquish();
    temporary = dirty = true;
    return true;
  }
}
async function act(type, target) {
  if (!game || pending || readOnly || broken || popup.open || $('settings-panel').open || !active(game)) return;
  const next = play(game, { type, index: target, id: game.id, revision: game.revision }, now(), { questions, clockOK });
  if (next === game) {
    if (type === 'chord') announce('快速开格需要周围旗数等于数字。');
    return;
  }
  pending = true;
  const award = active(game) && next.phase === 'won';
  game = next;
  const saved = await persist(next, award);
  pending = false;
  render();
  if (saved) audio.play(next.phase === 'won' ? 'win' : next.phase === 'lost' ? 'loss' : type === 'mark' ? 'select' : 'flip', { gesture: true });
}
function restart() {
  if (pending || readOnly) return;
  if (broken || active(game) && progress(game)) {
    dialog('重新开始？', broken ? '重新开始将替换这个难度无法读取的存档。' : '放弃当前棋盘，重新布雷。',
      [['重新开始', () => load(level, { restart: true })], cancelChoice]);
  } else void load(level, { restart: true });
}

const cancelInput = connectBoard({
  board, act, identity: () => game?.id + ':' + game?.revision,
  move: index => setFocus(index, true), onFocus: index => setFocus(index),
  columns: () => levels[level].columns, isMarkMode: () => markMode,
  isTurned: () => getComputedStyle(document.documentElement).getPropertyValue('--view-angle').trim() === '90deg',
  preview(button, pressed) {
    if (readOnly || broken || !active(game) || !['covered', 'question'].includes(button.dataset.state)) return;
    button.toggleAttribute('data-pressed', pressed);
    $('restart-face').textContent = pressed ? '◉' : '☺︎';
  },
});
$('restart').onclick = $('again').onclick = restart;
$('reveal-mode').onclick = () => updateMode(false);
$('flag-mode').onclick = () => updateMode(true);
$('take-over').onclick = () => dialog('接管此局？', '原来的标签页将改为只读。', [
  ['接管', () => load(level, { takeover: true })], cancelChoice]);
$('difficulty').onchange = async event => {
  const next = event.target.value;
  event.target.value = level;
  if (pending || next === level || !validLevel(next)) return;
  let saved;
  try { saved = db && (await readLevel(db, next)).game; } catch { /* A temporary game remains available. */ }
  const choice = saved ? [['继续该局', () => load(next)], ['重新开始', () => load(next, { restart: true })]] :
    [['切换难度', () => load(next)]];
  dialog('切换到' + levels[next].label, dirty ? '此页的临时进度会丢失。' :
    '当前难度已保存的进度可以稍后继续，离开期间仍计时。', [...choice, cancelChoice]);
};
$('question-pref').onchange = async event => {
  questions = event.target.checked;
  preference('questions', questions ? 'on' : 'off');
  if (!questions && !pending && !readOnly && !broken && active(game) && game.questions.length) {
    pending = true;
    game = play(game, { type: 'clear-questions', id: game.id, revision: game.revision }, now(), { clockOK });
    await persist(game);
    pending = false;
  }
  render();
};
$('rules').onclick = () => dialog('玩法', '数字表示相邻八格的雷数。打开全部安全格获胜，首次开格一定安全。右键、F 或长按标记。双击、同时按左右键或空格可快速打开数字旁未插旗的格子。误旗也可能踩雷。离开页面后仍计时。', [['关闭']]);
$('bests').onclick = async () => {
  const list = document.createElement('ul');
  for (const [key, spec] of Object.entries(levels)) {
    let record;
    try { record = db && (await readLevel(db, key)).best; } catch { /* Keep the empty entry. */ }
    const entry = document.createElement('li');
    entry.textContent = spec.label + ' · ' + (record ? record.seconds + ' 秒 · ' + new Date(record.date).toLocaleDateString() : '暂无纪录');
    list.append(entry);
  }
  dialog('本机最快纪录', list, [['清除纪录', () => dialog('清除纪录？', '清除三档的最快纪录，保留棋盘。', [
    ['清除', async () => { try { if (db) await clearBests(db, Object.keys(levels)); best = null; render(); }
      catch { dialog('无法清除', '本机存储不可用。', [['关闭']]); } }], cancelChoice])], ['关闭']]);
};
$('exit').addEventListener('click', event => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!dirty && !pending) return;
  event.preventDefault();
  if (pending) return announce('正在保存，请稍候。');
  dialog('返回棋牌室？', '本次未保存的进度会丢失。', [['返回', () => replacePracticeWithLobby(location)], cancelChoice]);
}, true);
document.addEventListener('keydown', event => {
  if (event.key !== 'F2' || event.repeat || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  restart();
});
channel?.addEventListener('message', async event => {
  if (!db || !readOnly || event.data !== level || pending) return;
  const target = level;
  try {
    const row = await readLevel(db, target);
    if (level === target && readOnly && validGame(row.game, level)) {
      game = expected = row.game; best = row.best; broken = false; render();
    }
  } catch { /* Keep the last readable board. */ }
});
window.addEventListener('beforeunload', event => {
  if (!dirty && !pending) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('pagehide', relinquish);
window.addEventListener('pageshow', event => { if (event.persisted && !dirty) void load(level); });
setInterval(showClock, 220);
try { db = await openSaves(); } catch { /* Start a playable temporary game. */ }
const previous = preference('level');
await load(validLevel(previous) ? previous : 'beginner');
