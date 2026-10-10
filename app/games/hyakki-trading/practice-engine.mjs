/** Device-local practice owns logical time, saved randomness and computer pacing.
 * All materials, decisions and results still belong to the production rules. */
import { createGame, applyGameAction, applyTimeout, gameProblem, currentDecision } from './rules.mjs';
import { privateView } from './view.mjs';
import { chooseHyakkiPracticeAction } from './practice-bot.mjs';
import { DEFAULT_ACTION_LIMIT, DEFAULT_GOODS_PER_TYPE, validActionLimit, validGoodsPerType } from './model.mjs';

export const PRACTICE_SELF = '00000000000000000000000000000001';
export const PRACTICE_BOT = '00000000000000000000000000000002';
export const PRACTICE_STORAGE_KEY = 'game-room:hyakki-trading:practice:v1';
const SAVE_KEYS = ['version', 'kind', 'matchId', 'logicalNow', 'rngState', 'game'];
const CLOCK_TICK = 250, MAX_ELAPSED = 2000;
const failure = (code, message) => Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const stamp = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 2000000;
const validId = value => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);
const validSeed = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const saveNote = '练习保存在这个浏览器，不计入正式积分。';
function savedProblem(saved) {
  if (!exactKeys(saved, SAVE_KEYS) || saved.version !== 1 || saved.kind !== 'hyakki-local-practice'
      || !validId(saved.matchId) || !stamp(saved.logicalNow) || !validSeed(saved.rngState)) return '练习存档版本或字段无效。';
  const issue = gameProblem(saved.game); if (issue) return issue;
  const game = saved.game;
  if (game.matchId !== saved.matchId || game.committedAt > saved.logicalNow || game.lifecycle.startedAt !== 0
      || game.players[0].id !== PRACTICE_SELF || game.players[1].id !== PRACTICE_BOT
      || game.lifecycle.manual || game.lifecycle.absence || game.lifecycle.capacity
      || !['playing', 'finished'].includes(game.status)) return '本机练习身份、时间或牌局归属无效。';
  return null;
}
export function decodeHyakkiPractice(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 524288) return null;
    const saved = JSON.parse(raw); return savedProblem(saved) ? null : saved;
  } catch { return null; }
}
export function encodeHyakkiPractice(saved) {
  const issue = savedProblem(saved); if (issue) throw failure('PRACTICE_SAVE_INVALID', issue);
  return JSON.stringify(saved);
}
function randomStream(seed) {
  let state = seed;
  return { get state() { return state; }, randomInt(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 0xffffffff) throw failure('PRACTICE_RANDOM_INVALID', '洗牌参数无效。');
    const ceiling = Math.floor(0x100000000 / limit) * limit;
    do { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0; } while (state >= ceiling);
    return state % limit;
  } };
}
function fresh({ actionLimit, goodsPerType, seed, requestId }) {
  if (!validActionLimit(actionLimit) || !validGoodsPerType(goodsPerType)) throw failure('PRACTICE_OPTIONS_INVALID', '每回合行动数需要在1至10之间，每类货物需要在4至20之间。');
  const matchId = requestId(); if (!validId(matchId)) throw failure('PRACTICE_ID_INVALID', '练习编号无效。');
  const initial = seed ?? (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  if (!validSeed(initial)) throw failure('PRACTICE_RANDOM_INVALID', '练习随机种子无效。');
  const random = randomStream(initial), firstPlayerId = random.randomInt(2) ? PRACTICE_BOT : PRACTICE_SELF;
  const game = createGame([PRACTICE_SELF, PRACTICE_BOT], { matchId, now: 0, actionLimit, goodsPerType, firstPlayerId, randomInt: random.randomInt });
  return { version: 1, kind: 'hyakki-local-practice', matchId, logicalNow: 0, rngState: random.state, game };
}
const successful = result => {
  if (!result.ok) throw failure(result.code || 'PRACTICE_ACTION_INVALID', result.error);
  return result.state;
};
const actor = game => currentDecision(game)?.actorId ?? game.turnPlayerId;
const clock = game => game.timing.decision ?? game.timing.active;
const commandFields = {
  peek: [], 'finish-draw': [], 'keep-peek': [], 'discard-peek': [], 'end-turn': [], 'decline-response': [], 'pass-bid': [],
  buy: ['cardId'], sell: ['cardId'], 'buy-stall': ['cardId'], respond: ['cardId'],
  'play-character': ['cardId', 'params?'], 'activate-tool': ['cardId', 'params?'],
  'install-tool': ['cardId', 'replaceCardId?'], 'choose-effect': ['selection'], bid: ['amount'],
};
function validFields(type, fields) {
  const keys = typeof type === 'string' && Object.hasOwn(commandFields, type) ? commandFields[type] : null;
  return keys && plain(fields) && keys.filter(key => !key.endsWith('?')).every(key => Object.hasOwn(fields, key))
    && Object.keys(fields).every(key => keys.includes(key) || keys.includes(`${key}?`));
}

/** Per-operation Web Locks plus a saved-text comparison prevent two pages from
 * overwriting one another. Without locks, practice remains explicitly unsaved. */
export async function createHyakkiPracticeSession({ storage, key = PRACTICE_STORAGE_KEY, withLock, seed,
  actionLimit = DEFAULT_ACTION_LIMIT, goodsPerType = DEFAULT_GOODS_PER_TYPE, requestId = () => globalThis.crypto.randomUUID().replaceAll('-', ''),
  now = () => globalThis.performance?.now() ?? Date.now(), canRun = () => true,
  onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, botDelayMs = 700 } = {}) {
  if (typeof key !== 'string' || !key || key.length > 256 || !Number.isSafeInteger(botDelayMs) || botDelayMs < 1 || botDelayMs > 60000
      || [requestId, now, canRun, onChange, setTimer, clearTimer].some(value => typeof value !== 'function')) {
    throw failure('PRACTICE_OPTIONS_INVALID', '本机练习配置无效。');
  }
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  let lock = withLock;
  if (lock === undefined && typeof globalThis.navigator?.locks?.request === 'function') {
    lock = callback => globalThis.navigator.locks.request(key, { mode: 'exclusive' }, callback);
  }
  let storageAvailable = Boolean(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' && typeof lock === 'function');
  let storageNote = storageAvailable ? saveNote : '浏览器无法安全保存练习；本局仍可玩，退出后不能恢复。';
  if (!storageAvailable) storage = null;
  if (typeof lock !== 'function') lock = callback => Promise.resolve().then(callback);
  let saved = null, storedText = null, logicalNow = 0, requiresRestart = false, conflict = false;
  let active = false, destroyed = false, timer = null, anchor = null, botDueAt = null, epoch = 0;
  let queue = Promise.resolve();
  const runAllowed = () => { try { return Boolean(canRun()); } catch { return false; } };
  function disableStorage() {
    storageAvailable = false; storage = null;
    storageNote = '本局无法继续保存；仍可练习，重新进入只能恢复此前成功保存的进度。';
  }
  function read() { if (!storageAvailable) return null; try { return storage.getItem(key); } catch { disableStorage(); return null; } }
  function write(candidate) {
    const text = encodeHyakkiPractice(candidate);
    if (storageAvailable && text !== storedText) {
      try { storage.setItem(key, text); if (storage.getItem(key) !== text) throw new Error('save mismatch'); storedText = text; }
      catch { disableStorage(); }
    }
    saved = candidate;
  }
  function verifyUnchanged() {
    const raw = read();
    if (storageAvailable && raw !== storedText) {
      conflict = true; active = false; epoch++; clearScheduled();
      storageNote = '另一个页面已改变练习。请重新载入已保存进度，避免覆盖它。';
      throw failure('PRACTICE_CONFLICT', storageNote);
    }
  }
  async function locked(callback) {
    let entered = false;
    try { return await lock(() => { entered = true; return callback(); }); }
    catch (error) { if (entered) throw error; disableStorage(); return callback(); }
  }
  function collectElapsed() {
    const wall = now(); if (!Number.isFinite(wall)) throw failure('PRACTICE_CLOCK_INVALID', '练习计时暂时不可用。');
    if (active && runAllowed() && anchor !== null) {
      const elapsed = Math.max(0, Math.floor(wall - anchor));
      if (elapsed <= MAX_ELAPSED) logicalNow += elapsed;
    }
    anchor = wall;
  }
  function clearScheduled() { if (timer !== null) clearTimer(timer); timer = null; }
  function planComputer() {
    botDueAt = saved?.game.status === 'playing' && actor(saved.game) === PRACTICE_BOT ? logicalNow + botDelayMs : null;
  }
  function commit(result, random) {
    const game = successful(result);
    write({ ...saved, game, logicalNow, rngState: random.state }); planComputer();
  }
  function expireDue() {
    if (saved.game.status !== 'playing' || clock(saved.game).deadlineAt === null || clock(saved.game).deadlineAt > logicalNow) return false;
    const random = randomStream(saved.rngState);
    commit(applyTimeout(saved.game, clock(saved.game).actorId, { now: logicalNow, randomInt: random.randomInt }), random);
    return true;
  }
  function snapshot() {
    const game = saved ? privateView(saved.game, PRACTICE_SELF) : null;
    const running = active && runAllowed() && !destroyed;
    if (game?.clock) {
      game.clock.remainingMs = game.clock.deadlineAt === null ? game.clock.remainingMs : Math.max(0, game.clock.deadlineAt - logicalNow);
      game.clock.paused ||= !running;
    }
    return { game, selfId: PRACTICE_SELF, players: game?.players.map(player => ({ id: player.id, name: player.id === PRACTICE_SELF ? '我' : '电脑' })) ?? [],
      logicalNow, matchId: saved?.matchId ?? null, storageAvailable, storageNote, requiresRestart, conflict, active: running, destroyed };
  }
  function publish() { if (!destroyed) { try { onChange(snapshot()); } catch {} } }
  function schedule() {
    clearScheduled();
    if (!active || destroyed || conflict || requiresRestart || saved?.game.status !== 'playing') return;
    if (!runAllowed()) { active = false; anchor = null; return; }
    const deadlines = [clock(saved.game).deadlineAt, botDueAt].filter(value => value !== null);
    if (!deadlines.length) return;
    const generation = epoch;
    const scheduled = setTimer(() => {
      // A cleared callback can still arrive after a newer timer was installed.
      // It must not clear the newer handle or enqueue any work for that match.
      if (timer !== scheduled || generation !== epoch) return;
      timer = null;
      void operation(() => {
        if (generation !== epoch || !active || !runAllowed()) return;
        verifyUnchanged(); collectElapsed();
        if (expireDue()) return; // Never replay a queue of overdue decisions.
        if (botDueAt !== null && logicalNow >= botDueAt && actor(saved.game) === PRACTICE_BOT) {
          const command = chooseHyakkiPracticeAction(privateView(saved.game, PRACTICE_BOT), PRACTICE_BOT, { now: logicalNow });
          if (!command) throw failure('PRACTICE_BOT_INVALID', '电脑暂时无法行动，请重新载入练习。');
          const random = randomStream(saved.rngState);
          commit(applyGameAction(saved.game, PRACTICE_BOT, command, { now: logicalNow, randomInt: random.randomInt }), random);
        } else write({ ...saved, logicalNow });
      }).catch(error => {
        if (destroyed) return;
        active = false; epoch++; clearScheduled(); storageNote = error.message || '练习已暂停，请重新载入保存进度。'; publish();
      });
    }, Math.max(1, Math.min(CLOCK_TICK, Math.min(...deadlines) - logicalNow)));
    timer = scheduled;
  }
  function operation(callback, { allowDestroyed = false } = {}) {
    const task = queue.catch(() => {}).then(() => locked(() => {
      if (destroyed && !allowDestroyed) throw failure('PRACTICE_DESTROYED', '练习页面已关闭。');
      return callback();
    }));
    queue = task; return task.finally(() => { publish(); schedule(); });
  }
  await locked(() => {
    const raw = read(); storedText = raw;
    if (raw !== null) {
      saved = decodeHyakkiPractice(raw);
      if (!saved) { requiresRestart = true; storageNote = '练习存档损坏或版本不受支持，原存档未改变。请重新开始练习。'; }
    } else write(fresh({ actionLimit, goodsPerType, seed, requestId }));
    logicalNow = saved?.logicalNow ?? 0; planComputer();
  });
  async function action(type, fields = {}) {
    if (!validFields(type, fields)) throw failure('PRACTICE_ACTION_INVALID', '请选择当前牌局提供的操作。');
    const decision = saved && currentDecision(saved.game);
    const context = saved && { matchId: saved.matchId, turnId: saved.game.turnId, expectedRevision: saved.game.revision,
      ...(saved.game.pending ? { effectId: saved.game.pending.id, decisionId: decision?.id } : {}) };
    const values = structuredClone(fields);
    return operation(() => {
      if (!saved || requiresRestart) throw failure('PRACTICE_SAVE_INVALID', '请重新开始练习。');
      if (conflict) throw failure('PRACTICE_CONFLICT', storageNote);
      // An explicit choice in a locally paused dialog remains legal. Pausing
      // suppresses elapsed time and computer timers, not the human command.
      verifyUnchanged(); collectElapsed(); expireDue();
      const random = randomStream(saved.rngState);
      commit(applyGameAction(saved.game, PRACTICE_SELF, { type, ...values, ...context }, { now: logicalNow, randomInt: random.randomInt }), random);
      return snapshot();
    });
  }
  async function restart(options = {}) {
    if (!plain(options) || Object.keys(options).some(key => !['actionLimit', 'goodsPerType'].includes(key))) {
      throw failure('PRACTICE_OPTIONS_INVALID', '本机练习配置无效。');
    }
    const { actionLimit: limit = DEFAULT_ACTION_LIMIT, goodsPerType: stock = DEFAULT_GOODS_PER_TYPE } = options;
    return operation(() => {
      verifyUnchanged(); if (conflict) throw failure('PRACTICE_CONFLICT', storageNote);
      const candidate = fresh({ actionLimit: limit, goodsPerType: stock, seed, requestId }); write(candidate);
      logicalNow = 0; requiresRestart = false; epoch++; anchor = now(); planComputer();
      storageNote = storageAvailable ? saveNote : '本局仍可练习，但无法保存进度。'; return snapshot();
    });
  }
  async function reload() {
    return operation(() => {
      if (!storageAvailable) throw failure('PRACTICE_STORAGE_UNAVAILABLE', '无法读取本机存档，可重新开始练习。');
      const raw = read(); if (!storageAvailable) throw failure('PRACTICE_STORAGE_UNAVAILABLE', '无法读取本机存档，可重新开始练习。');
      storedText = raw; saved = decodeHyakkiPractice(raw); logicalNow = saved?.logicalNow ?? 0;
      conflict = false; requiresRestart = !saved; active = false; anchor = null; epoch++; planComputer();
      storageNote = saved ? '已载入保存的练习，请继续。' : '练习存档缺失或无效，请重新开始。'; return snapshot();
    });
  }
  function setActive(value) {
    if (typeof value !== 'boolean') return Promise.reject(failure('PRACTICE_OPTIONS_INVALID', '暂停状态无效。'));
    if (destroyed) return Promise.resolve(snapshot());
    if (value) {
      if (!requiresRestart && !conflict && !active) { active = true; anchor = now(); schedule(); publish(); }
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
    const flushed = setActive(false); destroyed = true; epoch++; clearScheduled(); return flushed.catch(() => snapshot());
  }
  return { snapshot, action, restart, reload, setActive, destroy };
}
