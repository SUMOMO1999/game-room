/** Local hot-seat practice. No accounts, rooms, network, bots or results ledger.
 * Every confirmed action uses the same deterministic core as the server. */
import { createGame, gameProblem, applyRoll, applyMove } from './rules.mjs';
import { SIDES } from './board.mjs';
import { previewMove } from './routes.mjs';

export const FLYING_PRACTICE_STORAGE_KEY = 'game-room:flying-chess:practice:v1';
export const FLYING_PRACTICE_LESSONS = Object.freeze([
  { id: 'launch', label: '六点起飞', note: '掷六，选一架机库飞机，只到起飞点。', target: -2, die: 6 },
  { id: 'no-action', label: '无法起飞', note: '全部在机库，掷五后直接换下一方。', target: -2, die: 5 },
  { id: 'jump-fly', label: '跳后飞', note: '红1掷二：C13 → C17 → C29。', target: 11, die: 2 },
  { id: 'fly-jump', label: '飞后跳', note: '红1掷二：C17 → C29 → C33。', target: 15, die: 2 },
  { id: 'bounce', label: '终点反弹', note: '红1在H4，掷四先到终点再反弹回H4。', target: 53, die: 4 },
  { id: 'finish', label: '精确完成', note: '红1在H4，掷二精确完成；完成机不能再行动。', target: 53, die: 2 },
].map(Object.freeze));
export const PRACTICE_LESSONS = FLYING_PRACTICE_LESSONS;
const lessonById = new Map(FLYING_PRACTICE_LESSONS.map(lesson => [lesson.id, lesson]));
const envelopeKeys = ['version', 'kind', 'matchId', 'game', 'lesson', 'lessonRollIndex'];
const clone = value => structuredClone(value);
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const error = (code, message) => Object.assign(new Error(message), { code });
const validMatchId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(value);
const practicePlayerIds = count => Array.from({ length: count }, (_, index) => `practice-player-${index + 1}`);
function secureRandomInt(maximum) {
  const limit = Math.floor(0x100000000 / maximum) * maximum, values = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(values); } while (values[0] >= limit);
  return values[0] % maximum;
}
function randomIndex(source, maximum) {
  const value = source(maximum);
  if (!Number.isSafeInteger(value) || value < 0 || value >= maximum) throw error('PRACTICE_RANDOM_INVALID', '本机随机暂时不可用，请再试一次。');
  return value;
}
function requireSuccess(result) {
  if (!result.ok) throw error('PRACTICE_ACTION_INVALID', result.error);
  return result.state;
}
function savedProblem(saved) {
  if (!exactKeys(saved, envelopeKeys) || saved.version !== 1 || saved.kind !== 'flying-local-practice'
      || !validMatchId(saved.matchId) || !(saved.lesson === null || lessonById.has(saved.lesson))
      || !Number.isSafeInteger(saved.lessonRollIndex) || saved.lessonRollIndex < 0
      || saved.lessonRollIndex >= Number.MAX_SAFE_INTEGER || saved.lesson === null && saved.lessonRollIndex !== 0) return '练习存档版本或字段无效。';
  const problem = gameProblem(saved.game);
  if (problem) return problem;
  if (saved.game.players.some((player, index) => player.id !== practicePlayerIds(saved.game.players.length)[index])) return '练习玩家身份无效。';
  if (saved.lesson !== null && (saved.game.players.length !== 2 || saved.game.firstPlayerIndex !== 0)) return '教学阵营无效。';
  return null;
}
export function decodeFlyingPractice(value) {
  try {
    if (typeof value !== 'string' || value.length > 65536) return null;
    const saved = JSON.parse(value);
    return savedProblem(saved) ? null : saved;
  } catch { return null; }
}
export function encodeFlyingPractice(saved) {
  const problem = savedProblem(saved);
  if (problem) throw error('PRACTICE_SAVE_INVALID', problem);
  return JSON.stringify(saved);
}

/** Teaching positions are reached by replaying real rolls and moves. No fixture
 * is shipped and no synthetic lastAction, plane coordinate or counter is forged. */
function reachTeachingPosition(target) {
  let game = createGame(practicePlayerIds(2), { firstPlayerIndex: 0 });
  if (target === -2) return game;
  const seen = new Map([[-2, []]]), queue = [-2];
  for (let index = 0; index < queue.length && !seen.has(target); index += 1) {
    const from = queue[index];
    for (let die = 1; die <= 6; die += 1) {
      const route = previewMove([{ id: 'red-1', side: 'red', number: 1, progress: from }], 'red-1', die);
      if (route && !seen.has(route.to)) { seen.set(route.to, [...seen.get(from), die]); queue.push(route.to); }
    }
  }
  if (!seen.has(target)) throw error('PRACTICE_LESSON_INVALID', '教学位置不可达。');
  for (const die of seen.get(target)) {
    game = requireSuccess(applyRoll(game, game.turnPlayerId, die));
    game = requireSuccess(applyMove(game, game.turnPlayerId, { rollId: game.rollId, planeId: 'red-1' }));
    if (game.turnIndex !== 0) game = requireSuccess(applyRoll(game, game.turnPlayerId, 5));
  }
  return game;
}
function freshSaved({ playerCount, lesson, randomInt, requestId }) {
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 4) throw error('PRACTICE_PLAYERS_INVALID', '本机练习需要2～4方。');
  if (!(lesson === null || lessonById.has(lesson))) throw error('PRACTICE_LESSON_INVALID', '请选择有效的教学。');
  const matchId = requestId();
  if (!validMatchId(matchId)) throw error('PRACTICE_ID_INVALID', '练习编号无效。');
  const game = lesson === null ? createGame(practicePlayerIds(playerCount), { firstPlayerIndex: randomIndex(randomInt, playerCount) })
    : reachTeachingPosition(lessonById.get(lesson).target);
  return { version: 1, kind: 'flying-local-practice', matchId, game, lesson, lessonRollIndex: 0 };
}

/** Saving requires a cross-tab exclusive lock. Without one practice remains
 * usable but explicitly unsaved; a read/compare alone is not an atomic CAS. */
export async function createFlyingPracticeSession({ storage,
  key = FLYING_PRACTICE_STORAGE_KEY, randomInt = secureRandomInt,
  requestId = () => globalThis.crypto.randomUUID(), withLock } = {}) {
  if (typeof key !== 'string' || !key || key.length > 256 || typeof randomInt !== 'function' || typeof requestId !== 'function') throw error('PRACTICE_OPTIONS_INVALID', '练习配置无效。');
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  let lock = withLock;
  if (lock === undefined) {
    const locks = globalThis.navigator?.locks;
    if (typeof locks?.request === 'function') lock = callback => locks.request(key, { mode: 'exclusive' }, callback);
  }
  let storageAvailable = Boolean(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' && typeof lock === 'function');
  let storageNote = storageAvailable ? '进度保存在这个浏览器，不计战绩。' : '本机轮流练习，不计战绩；浏览器存储不可用，本局不会保存。';
  if (!storageAvailable) storage = null;
  if (typeof lock !== 'function') lock = callback => Promise.resolve().then(callback);
  let saved = null, storedText = null, requiresRestart = false, conflict = false, destroyed = false, busy = false;
  const listeners = new Set();
  function disableStorage() {
    storage = null; storageAvailable = false;
    storageNote = '本机轮流练习，不计战绩；本局无法保存，返回后不会恢复新动作。';
  }
  function read() {
    if (!storageAvailable) return null;
    try { return storage.getItem(key); }
    catch { disableStorage(); return null; }
  }
  function write(candidate) {
    if (!storageAvailable) { saved = candidate; return; }
    const text = encodeFlyingPractice(candidate);
    try {
      storage.setItem(key, text);
      if (storage.getItem(key) !== text) throw new Error('Save confirmation failed');
      storedText = text; saved = candidate;
    } catch { disableStorage(); saved = candidate; }
  }
  function verifyUnchanged() {
    if (!storageAvailable) return;
    const raw = read();
    if (!storageAvailable) return;
    if (raw !== storedText) {
      conflict = true;
      storageNote = '另一个页面已改变练习进度。请重新载入已保存棋盘，避免覆盖它。';
      throw error('PRACTICE_CONFLICT', storageNote);
    }
  }
  async function locked(callback) {
    let started = false;
    try { return await lock(() => { started = true; return callback(); }); }
    catch (failure) {
      if (started) throw failure;
      disableStorage();
      return callback();
    }
  }
  function view() {
    if (!saved) return { roomId: 'flying-local-practice', matchId: null, gameType: 'flying-chess', selfId: null,
      selfRole: 'player', phase: 'invalid', revision: 0, players: [], spectators: [], game: null,
      practice: true, storageAvailable, storageNote, requiresRestart: true, practiceConflict: conflict };
    const game = clone(saved.game), actor = game.turnPlayerId;
    const canAct = !destroyed && !requiresRestart && !conflict && game.status === 'playing';
    const legal = canAct && game.stage === 'await-move' ? [...game.legalPlaneIds] : [];
    game.playerId = actor;
    game.canRoll = canAct && game.stage === 'await-roll';
    game.legalPlaneIds = legal;
    game.legalMoves = legal.map(planeId => previewMove(game.planes, planeId, game.die));
    if (game.lastAction?.type === 'roll') game.lastAction.legalPlaneIds = [];
    const lesson = lessonById.get(saved.lesson);
    return { roomId: 'flying-local-practice', matchId: saved.matchId, gameType: 'flying-chess', selfId: actor,
      selfRole: 'player', phase: game.status === 'finished' ? 'finished' : 'playing', revision: game.revision,
      players: game.players.map(player => ({ ...player, role: 'player', name: `${SIDES.find(side => side.id === player.side).label}（本机）`,
        connected: true, ready: true, completedCount: game.planes.filter(plane => plane.side === player.side && plane.progress === 55).length })),
      spectators: [], game, practice: true, storageAvailable, storageNote, requiresRestart,
      practiceConflict: conflict, ...(lesson ? { lessonId: lesson.id, lessonLabel: lesson.label, lessonNote: `${lesson.note} 教学骰序固定；随后继续本机轮流练习。` } : {}) };
  }
  function publish() { for (const listener of listeners) { try { listener(view()); } catch {} } }
  async function operation(callback) {
    if (destroyed) throw error('PRACTICE_DESTROYED', '练习页面已关闭。');
    if (busy) throw error('PRACTICE_BUSY', '上一步正在保存，请稍候。');
    busy = true;
    try { return await locked(() => { if (destroyed) throw error('PRACTICE_DESTROYED', '练习页面已关闭。'); return callback(); }); }
    finally { busy = false; publish(); }
  }
  await locked(() => {
    const raw = read(); storedText = raw;
    if (raw !== null) {
      saved = decodeFlyingPractice(raw);
      if (!saved) { requiresRestart = true; storageNote = '练习存档损坏或版本不受支持。原存档未改变，请重新开始练习。'; }
    } else write(freshSaved({ playerCount: 2, lesson: null, randomInt, requestId }));
  });
  async function action(type, fields = {}) {
    return operation(() => {
      if (requiresRestart || !saved) throw error('PRACTICE_SAVE_INVALID', '请重新开始练习。');
      if (conflict) throw error('PRACTICE_CONFLICT', '请重新载入已保存的练习。');
      verifyUnchanged();
      if (!['roll', 'move'].includes(type) || !exactKeys(fields, type === 'roll' ? [] : ['rollId', 'planeId'])) throw error('PRACTICE_ACTION_INVALID', '练习只接受掷骰或确认移动。');
      const game = saved.game;
      if (game.status !== 'playing' || type === 'roll' && game.stage !== 'await-roll') throw error('PRACTICE_ACTION_INVALID', game.status !== 'playing' ? '练习已经结束。' : '请先使用当前骰子。');
      const candidate = clone(saved);
      if (type === 'roll') {
        const lesson = lessonById.get(saved.lesson), sequence = [6, 3, 4, 5, 2, 1];
        if (lesson && saved.lessonRollIndex >= Number.MAX_SAFE_INTEGER - 1) throw error('PRACTICE_ACTION_INVALID', '教学计数已达上限，请重新开始。');
        const die = lesson ? saved.lessonRollIndex === 0 ? lesson.die : sequence[(saved.lessonRollIndex - 1) % sequence.length]
          : randomIndex(randomInt, 6) + 1;
        candidate.game = requireSuccess(applyRoll(game, game.turnPlayerId, die));
        if (lesson) candidate.lessonRollIndex += 1;
      } else candidate.game = requireSuccess(applyMove(game, game.turnPlayerId, fields));
      write(candidate);
      return view();
    });
  }
  async function restart({ playerCount = 2, lesson = null } = {}) {
    return operation(() => {
      if (conflict) throw error('PRACTICE_CONFLICT', '先重新载入另一个页面的进度，再决定重新开始。');
      verifyUnchanged();
      const candidate = freshSaved({ playerCount, lesson, randomInt, requestId });
      requiresRestart = false; conflict = false;
      storageNote = storageAvailable ? '进度保存在这个浏览器，不计战绩。' : '本机轮流练习，不计战绩；本局不会保存。';
      write(candidate); return view();
    });
  }
  async function reload() {
    return operation(() => {
      if (!storageAvailable) throw error('PRACTICE_STORAGE_UNAVAILABLE', '本局无法读取存档；可重新开始本机练习。');
      const raw = read();
      if (!storageAvailable) throw error('PRACTICE_STORAGE_UNAVAILABLE', '本机存储暂时不可用。');
      const restored = decodeFlyingPractice(raw);
      storedText = raw; saved = restored; conflict = false; requiresRestart = !restored;
      storageNote = restored ? '已重新载入这个浏览器保存的练习，不计战绩。' : '练习存档缺失、损坏或版本不受支持。请重新开始练习。';
      return view();
    });
  }
  return { view, action, restart, reload,
    subscribe(listener) {
      if (typeof listener !== 'function' || destroyed) return () => {};
      listeners.add(listener); listener(view()); return () => listeners.delete(listener);
    },
    destroy() { destroyed = true; listeners.clear(); },
  };
}
