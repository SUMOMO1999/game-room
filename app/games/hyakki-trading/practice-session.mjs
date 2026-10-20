/** Shared practice persistence and pacing. Domain implementations supply only rules and journal projection. */
const failure=(code,message)=>Object.assign(new Error(message),{code});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stamp=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER-2000000;
const CLOCK_TICK=250,SAVE_CLOCK_CHECKPOINT=1000,MAX_ELAPSED=2000;
const saveNote='练习保存在这个浏览器，不计入正式积分。';
const successful=result=>{if(!result.ok)throw failure(result.code||'PRACTICE_ACTION_INVALID',result.error);return result.state;};
export function randomStream(seed) {
  let state = seed;
  return { get state() { return state; }, randomInt(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 0xffffffff) throw failure('PRACTICE_RANDOM_INVALID', '洗牌参数无效。');
    const ceiling = Math.floor(0x100000000 / limit) * limit;
    do { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0; } while (state >= ceiling);
    return state % limit;
  } };
}
/** Per-operation Web Locks plus a saved-text comparison prevent two pages from
 * overwriting one another. Without locks, practice remains explicitly unsaved. */
export async function createPracticeSession(runtime, { storage, key = 'game-room:hyakki-trading:practice:v1', withLock, seed,
  actionLimit = 5, goodsPerType, goodsSupplyMode, playerCount = 2, packId, closingTarget, requestId = () => globalThis.crypto.randomUUID().replaceAll('-', ''),
  now = () => globalThis.performance?.now() ?? Date.now(), canRun = () => true,
  onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, botDelayMs = 2000 } = {}) {
  const {fresh, decode:decodeHyakkiPractice, encode:encodeHyakkiPractice, currentDecision, clock, privateView,
    applyGameAction, applyTimeout, chooseAction:chooseHyakkiPracticeAction, actor, validFields, PRACTICE_SELF, PRACTICE_BOTS} = runtime;
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
  function disableStorage(note) {
    storageAvailable = false; storage = null;
    storageNote = note || '本局无法继续保存；仍可练习，重新进入只能恢复此前成功保存的进度。';
  }
  function read() { if (!storageAvailable) return null; try { return storage.getItem(key); } catch { disableStorage(); return null; } }
  function write(candidate) {
    let text;
    try { text = encodeHyakkiPractice(candidate); }
    catch (error) { if (error.code !== 'PRACTICE_SAVE_CAPACITY') throw error; disableStorage(error.message); saved = candidate; return; }
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
    botDueAt = saved?.game.status === 'playing' && PRACTICE_BOTS.includes(actor(saved.game)) ? logicalNow + botDelayMs : null;
  }
  function commit(result, random) {
    const game = successful(result);
    write(runtime.transition(saved, game, random.state, logicalNow)); planComputer();
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
    const configuration = saved ? structuredClone(saved.configuration ?? { playerCount: saved.game.players.length,
      actionLimit: saved.game.actionLimit, goodsPerType: saved.game.goodsPerType ?? 6, goodsSupplyMode: 'custom' }) : null;
    return { game, configuration, selfId: PRACTICE_SELF, players: game?.players.map(player => ({ id: player.id, name: player.id === PRACTICE_SELF ? '我' : `电脑${PRACTICE_BOTS.indexOf(player.id) + 1}` })) ?? [],
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
        if (botDueAt !== null && logicalNow >= botDueAt && PRACTICE_BOTS.includes(actor(saved.game))) {
          const computerId = actor(saved.game);
          const command = chooseHyakkiPracticeAction(privateView(saved.game, computerId), computerId, { now: logicalNow });
          if (!command) throw failure('PRACTICE_BOT_INVALID', '电脑暂时无法行动，请重新载入练习。');
          const random = randomStream(saved.rngState);
          commit(applyGameAction(saved.game, computerId, command, { now: logicalNow, randomInt: random.randomInt }), random);
        } else if (logicalNow - saved.logicalNow >= SAVE_CLOCK_CHECKPOINT) write({ ...saved, logicalNow });
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
    } else write(fresh({ actionLimit, goodsPerType, goodsSupplyMode, playerCount, packId, closingTarget, seed, requestId }));
    logicalNow = saved?.logicalNow ?? 0; planComputer();
  });
  async function action(type, fields = {}) {
    if (!validFields(type, fields)) throw failure('PRACTICE_ACTION_INVALID', '请选择当前牌局提供的操作。');
    const decision = saved && currentDecision(saved.game);
    const context = saved && runtime.context(saved.game, decision);
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
    if (!plain(options) || Object.keys(options).some(key => !runtime.restartFields.includes(key))) {
      throw failure('PRACTICE_OPTIONS_INVALID', '本机练习配置无效。');
    }
    const { actionLimit: limit = 5, goodsPerType: stock, goodsSupplyMode: mode, playerCount: count = 2 } = options;
    return operation(() => {
      verifyUnchanged(); if (conflict) throw failure('PRACTICE_CONFLICT', storageNote);
      const candidate = fresh({ ...options, actionLimit: limit, goodsPerType: stock, goodsSupplyMode: mode, playerCount: count, seed, requestId }); write(candidate);
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
  function history({ after = 0, limit = 30 } = {}) {
    if (!stamp(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw failure('PRACTICE_HISTORY_QUERY', '公开战况读取范围无效。');
    if (!saved || requiresRestart) throw failure('PRACTICE_SAVE_INVALID', '请先载入可用的练习进度。');
    return runtime.history(saved, {after,limit});
  }
  return { snapshot, action, restart, reload, setActive, destroy, history };
}
