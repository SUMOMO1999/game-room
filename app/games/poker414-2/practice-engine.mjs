/** Device-local 414 practice. The production rules own every card and outcome;
 * this session owns a paused logical clock, computer pacing and local recovery.
 * No account, room client, HTTP transport or permanent score ledger is imported. */
import { createGame, advanceGame, applyAction, gameClock, gameProblem, projectGame, RESPONSE_MS } from './rules.mjs';
import { chooseResponseCards } from './patterns.mjs';
import { choosePoker414BotAction } from './practice-bot.mjs';

export const PRACTICE_SELF = 'practice-self';
export const PRACTICE_STORAGE_KEY = 'game-room:poker414-2:practice:v1';
const SAVE_KEYS = ['version', 'kind', 'matchId', 'logicalNow', 'game'];
const BOT_DELAY = 900, HUMAN_RESPONSE_DELAY = 2000, CLOCK_TICK = 250;
const copy = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(value);
const playerIds = count => [PRACTICE_SELF, ...Array.from({ length: count - 1 }, (_, i) => `practice-bot-${i + 1}`)];
const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1000000;
function secureRandom() {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
}
function savedProblem(saved) {
  if (!exactKeys(saved, SAVE_KEYS) || saved.version !== 1 || saved.kind !== 'poker414-local-practice'
      || !validId(saved.matchId) || !integer(saved.logicalNow)) return '练习存档版本或字段无效。';
  const problem = gameProblem(saved.game);
  if (problem) return problem;
  const game = saved.game, expected = playerIds(game.players.length);
  if (game.matchId !== saved.matchId || game.updatedAt > saved.logicalNow || game.createdAt !== 0
      || game.dealBatchSize !== 18 || game.dealIntervalMs !== 250
      || game.players.some(player => !expected.includes(player.id))
      || !['playing', 'finished'].includes(game.status)) return '本机练习身份、时间或牌局归属无效。';
  return null;
}
export function decodePoker414Practice(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 524288) return null;
    const value = JSON.parse(raw);
    return savedProblem(value) ? null : value;
  } catch { return null; }
}
export function encodePoker414Practice(saved) {
  const problem = savedProblem(saved);
  if (problem) throw failure('PRACTICE_SAVE_INVALID', problem);
  return JSON.stringify(saved);
}
function fresh({ playerCount, random, requestId }) {
  if (!Number.isInteger(playerCount) || playerCount < 3 || playerCount > 8) throw failure('PRACTICE_PLAYERS_INVALID', '练习需要3～8人，包括你和电脑。');
  const matchId = requestId();
  if (!validId(matchId)) throw failure('PRACTICE_ID_INVALID', '练习编号无效，请重新开始。');
  return { version: 1, kind: 'poker414-local-practice', matchId, logicalNow: 0,
    game: createGame({ players: playerIds(playerCount), matchId, random, now: 0, dealBatchSize: 18, dealIntervalMs: 250 }) };
}
const requireSuccess = result => {
  if (!result.ok) throw failure(result.code || 'PRACTICE_ACTION_INVALID', result.error);
  return result.state;
};

/** With no Web Locks, continuing unsaved is safer than pretending localStorage
 * read/compare/write is an atomic cross-tab transaction. Tests may inject the
 * same exclusive lock and monotonic clock used by a browser host. */
export async function createPoker414PracticeSession({ storage, key = PRACTICE_STORAGE_KEY, withLock,
  random = secureRandom, requestId = () => globalThis.crypto.randomUUID(),
  now = () => globalThis.performance?.now() ?? Date.now(), canRun = () => true,
  onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof key !== 'string' || !key || key.length > 256
      || [random, requestId, now, canRun, onChange, setTimer, clearTimer].some(value => typeof value !== 'function')) {
    throw failure('PRACTICE_OPTIONS_INVALID', '本机练习配置无效。');
  }
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  let lock = withLock;
  if (lock === undefined && typeof globalThis.navigator?.locks?.request === 'function') {
    lock = callback => globalThis.navigator.locks.request(key, { mode: 'exclusive' }, callback);
  }
  let storageAvailable = Boolean(storage && typeof storage.getItem === 'function'
    && typeof storage.setItem === 'function' && typeof lock === 'function');
  let storageNote = storageAvailable ? '练习保存在这个浏览器，不计入正式积分。' : '浏览器无法安全保存练习；本局仍可玩，退出后不能恢复。';
  if (!storageAvailable) storage = null;
  if (typeof lock !== 'function') lock = callback => Promise.resolve().then(callback);
  let saved = null, storedText = null, logicalNow = 0, requiresRestart = false, conflict = false;
  let active = false, destroyed = false, timer = null, anchor = null, botDueAt = null, epoch = 0;
  let queue = Promise.resolve();

  function disableStorage() {
    storageAvailable = false; storage = null;
    storageNote = '本局无法继续保存；仍可练习，重新进入只能恢复此前成功保存的进度。';
  }
  function read() {
    if (!storageAvailable) return null;
    try { return storage.getItem(key); }
    catch { disableStorage(); return null; }
  }
  function write(candidate) {
    const text = encodePoker414Practice(candidate);
    if (storageAvailable && text !== storedText) {
      try {
        storage.setItem(key, text);
        if (storage.getItem(key) !== text) throw new Error('Local save verification failed');
        storedText = text;
      } catch { disableStorage(); }
    }
    saved = candidate;
  }
  function verifyUnchanged() {
    const raw = read();
    if (storageAvailable && raw !== storedText) {
      conflict = true; active = false;
      storageNote = '另一个页面已改变练习。请重新载入已保存进度，避免覆盖它。';
      throw failure('PRACTICE_CONFLICT', storageNote);
    }
  }
  async function locked(callback) {
    let entered = false;
    try { return await lock(() => { entered = true; return callback(); }); }
    catch (error) {
      if (entered) throw error;
      disableStorage();
      return callback();
    }
  }
  const runAllowed = () => {
    try { return Boolean(canRun()); } catch { return false; }
  };
  function collectElapsed() {
    const wall = now();
    if (!Number.isFinite(wall)) throw failure('PRACTICE_CLOCK_INVALID', '练习计时暂时不可用。');
    if (active && runAllowed() && anchor !== null) {
      const elapsed = Math.max(0, Math.floor(wall - anchor));
      // A sleeping device or heavily throttled task must not fast-forward a
      // five-second response window or replay a queue of computer moves.
      if (elapsed <= HUMAN_RESPONSE_DELAY) logicalNow += elapsed;
    }
    anchor = wall;
  }
  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function canRespond(game, id) {
    const window = game.responseWindow;
    if (!window || window.deadlineAt <= logicalNow || game.target.ownerId === id) return false;
    return Boolean(chooseResponseCards(game.players.find(player => player.id === id).hand, window.rank, window.action));
  }
  function hasComputerOpportunity(game) {
    return game.status === 'playing' && game.stage === 'playing'
      && (game.turnPlayerId !== PRACTICE_SELF || game.players.some(player => player.id !== PRACTICE_SELF && canRespond(game, player.id)));
  }
  function planComputer() {
    botDueAt = null;
    if (!saved || !hasComputerOpportunity(saved.game)) return;
    const humanCanRespond = canRespond(saved.game, PRACTICE_SELF);
    const computerCanRespond = saved.game.players.some(player => player.id !== PRACTICE_SELF && canRespond(saved.game, player.id));
    botDueAt = Math.max(logicalNow + BOT_DELAY, humanCanRespond
      ? computerCanRespond ? saved.game.responseWindow.deadlineAt - RESPONSE_MS + HUMAN_RESPONSE_DELAY
        : saved.game.responseWindow.deadlineAt : 0);
  }
  function snapshot() {
    const game = saved ? projectGame(saved.game, { playerId: PRACTICE_SELF, role: 'player' }) : null;
    return { game, selfId: PRACTICE_SELF, players: game?.players.map(player => ({ id: player.id,
      name: player.id === PRACTICE_SELF ? '我' : `电脑${player.id.slice('practice-bot-'.length)}` })) || [],
      logicalNow, matchId: saved?.matchId || null, storageAvailable, storageNote, requiresRestart, conflict,
      active: active && runAllowed() && !destroyed, destroyed };
  }
  function publish() {
    if (!destroyed) { try { onChange(snapshot()); } catch {} }
  }
  function schedule() {
    clearScheduled();
    if (!active || destroyed || conflict || requiresRestart || !saved || saved.game.status !== 'playing') return;
    if (!runAllowed()) { active = false; anchor = null; return; }
    const clock = gameClock(saved.game);
    const deadlines = [clock?.deadlineAt, botDueAt].filter(value => value !== null && value !== undefined);
    if (!deadlines.length) return; // Human-only turns do not poll the move planner.
    const generation = epoch;
    const delay = Math.max(1, Math.min(CLOCK_TICK, Math.min(...deadlines) - logicalNow));
    timer = setTimer(() => {
      timer = null;
      void operation(() => {
        if (generation !== epoch || !active || !runAllowed()) return;
        verifyUnchanged(); collectElapsed();
        const advanced = advanceGame(saved.game, { now: logicalNow });
        const game = requireSuccess(advanced);
        if (advanced.changed) { write({ ...saved, game, logicalNow }); planComputer(); }
        if (botDueAt !== null && logicalNow >= botDueAt && hasComputerOpportunity(saved.game)) {
          const current = saved.game;
          const responders = current.actionOrder.filter(id => id !== PRACTICE_SELF && canRespond(current, id));
          const ordinaryAllowed = !canRespond(current, PRACTICE_SELF);
          const actors = [...new Set([...responders, ...(ordinaryAllowed && current.turnPlayerId !== PRACTICE_SELF ? [current.turnPlayerId] : [])])];
          let decision = null;
          for (const id of actors) {
            decision = choosePoker414BotAction(projectGame(current, { playerId: id, role: 'player' }), id, { now: logicalNow });
            if (decision) break;
          }
          if (!decision) throw failure('PRACTICE_BOT_INVALID', '电脑暂时无法行动，请重新载入练习。');
          write({ ...saved, game: requireSuccess(applyAction(current, decision, { now: logicalNow })), logicalNow });
          planComputer();
        } else write({ ...saved, logicalNow });
      }).catch(error => {
        if (destroyed) return;
        active = false; clearScheduled();
        storageNote = error.message || '练习已暂停，请重新载入保存的进度。';
        publish();
      });
    }, delay);
  }
  function operation(callback, { allowDestroyed = false } = {}) {
    const task = queue.catch(() => {}).then(() => locked(() => {
      if (destroyed && !allowDestroyed) throw failure('PRACTICE_DESTROYED', '练习页面已关闭。');
      return callback();
    }));
    queue = task;
    return task.finally(() => { publish(); schedule(); });
  }

  await locked(() => {
    const raw = read(); storedText = raw;
    if (raw !== null) {
      saved = decodePoker414Practice(raw);
      if (!saved) { requiresRestart = true; storageNote = '练习存档损坏或版本不受支持，原存档未改变。请重新开始练习。'; }
    } else write(fresh({ playerCount: 3, random, requestId }));
    logicalNow = saved?.logicalNow || 0;
    planComputer();
  });
  async function action(type, fields = {}) {
    // Capture the viewed target before joining the local transaction queue so a
    // double-click can never silently apply to the next player's/new round state.
    const context = saved && { matchId: saved.game.matchId, roundId: saved.game.roundId, targetId: saved.game.target?.id ?? null,
      ...(['hook', 'fork'].includes(type) ? { windowId: saved.game.responseWindow?.id } : {}) };
    const keys = type === 'play' ? ['cardIds'] : [];
    if (!['play', 'pass', 'hook', 'fork'].includes(type) || !exactKeys(fields, keys)) throw failure('PRACTICE_ACTION_INVALID', '请选择出牌、不出或当前勾叉机会。');
    const actionFields = copy(fields);
    return operation(() => {
      if (!saved || requiresRestart) throw failure('PRACTICE_SAVE_INVALID', '请重新开始练习。');
      if (conflict) throw failure('PRACTICE_CONFLICT', storageNote);
      if (!active || !runAllowed()) throw failure('PRACTICE_PAUSED', '练习已暂停，请关闭弹窗后继续。');
      verifyUnchanged(); collectElapsed();
      const advanced = advanceGame(saved.game, { now: logicalNow });
      const game = requireSuccess(advanced);
      write({ ...saved, game, logicalNow });
      if (advanced.changed) planComputer();
      const result = applyAction(game, { type, playerId: PRACTICE_SELF, ...context, ...actionFields }, { now: logicalNow });
      write({ ...saved, game: requireSuccess(result), logicalNow });
      planComputer();
      return snapshot();
    });
  }
  async function restart({ playerCount = 3 } = {}) {
    return operation(() => {
      verifyUnchanged();
      if (conflict) throw failure('PRACTICE_CONFLICT', storageNote);
      const candidate = fresh({ playerCount, random, requestId });
      write(candidate); logicalNow = 0; requiresRestart = false; epoch++;
      storageNote = storageAvailable ? '已开始新的本机练习，不计入正式积分。' : '本局仍可练习，但无法保存进度。';
      anchor = now(); planComputer();
      return snapshot();
    });
  }
  async function reload() {
    return operation(() => {
      if (!storageAvailable) throw failure('PRACTICE_STORAGE_UNAVAILABLE', '无法读取本机存档，可重新开始练习。');
      const raw = read();
      if (!storageAvailable) throw failure('PRACTICE_STORAGE_UNAVAILABLE', '无法读取本机存档，可重新开始练习。');
      storedText = raw; saved = decodePoker414Practice(raw); logicalNow = saved?.logicalNow || 0;
      conflict = false; requiresRestart = !saved; active = false; anchor = null; epoch++;
      storageNote = saved ? '已载入保存的练习，请继续。' : '练习存档缺失或无效，请重新开始。';
      planComputer(); return snapshot();
    });
  }
  function setActive(value) {
    if (typeof value !== 'boolean') return Promise.reject(failure('PRACTICE_OPTIONS_INVALID', '暂停状态无效。'));
    if (destroyed) return Promise.resolve(snapshot());
    if (value) {
      if (!requiresRestart && !conflict) { active = true; anchor = now(); schedule(); publish(); }
      return Promise.resolve(snapshot());
    }
    collectElapsed(); active = false; anchor = null; epoch++; clearScheduled();
    return operation(() => {
      if (saved && !requiresRestart && !conflict) { verifyUnchanged(); write({ ...saved, logicalNow }); }
      return snapshot();
    }, { allowDestroyed: true });
  }
  function destroy() {
    if (destroyed) return Promise.resolve(snapshot());
    const flushed = setActive(false);
    destroyed = true; epoch++; clearScheduled();
    return flushed.catch(() => snapshot());
  }
  return { snapshot, action, restart, reload, setActive, destroy };
}
