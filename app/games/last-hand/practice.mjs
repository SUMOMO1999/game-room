import { newMatch, applyMove, step, dueAt, viewFor, settings } from './rules/match.mjs';
import { battlesPerChapter } from './rules/table.mjs';
import { opponent } from './rules/opponent.mjs';
import { unique } from './widgets.mjs';
const me = 'local-player';
let openPromise;
function database() {
  return (openPromise ??= new Promise((ok, fail) => {
    const r = indexedDB.open('olh-practice-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('seats');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => {
      openPromise = null;
      fail(r.error);
    };
  }));
}
async function change(f, replace = false) {
  const db = await database();
  return new Promise((ok, fail) => {
    const tx = db.transaction('seats', 'readwrite'),
      s = tx.objectStore('seats'),
      original = s.get('practice'),
      points = s.get('practice-points-v1');
    let value, error;
    // An already-open older tab only knows the original slot. Its ticks must never
    // apply the old attack rules to a practice table created under the points rules.
    points.onsuccess = () => {
      try {
        const next = f(points.result || original.result || null);
        if (next?.save) {
          const isolated = next.save.game.scoreOnly === true || next.save.game.interactionVersion === 1;
          s.put(next.save, isolated ? 'practice-points-v1' : 'practice');
          const other = isolated ? original.result : points.result;
          if (other && (replace || other.game.matchId === next.save.game.matchId))
            s.delete(isolated ? 'practice' : 'practice-points-v1');
        }
        value = next?.value;
      } catch (e) {
        error = e;
        tx.abort();
      }
    };
    tx.oncomplete = () => ok(value);
    tx.onerror = tx.onabort = () => fail(error || tx.error || new Error('练习进度保存失败'));
  });
}
export async function savedPractice() {
  return change((r) => ({
    value: r
      ? { id: r.game.matchId, finished: r.game.status === 'finished', battle: r.game.battle,
          settings: r.game.settings, perChapter: battlesPerChapter(r.game) }
      : null,
  }));
}
function projection(r) {
  const v = viewFor(r.game, me);
  const wall = Date.now();
  const project = (deadline) => deadline == null ? null : wall + Math.max(0, deadline - r.clock);
  return { ...v, deadline: project(v.deadline), matchDeadline: project(v.matchDeadline) };
}
function advanceClock(r) {
  const now = Date.now();
  // Practice counts foreground play. Waking a suspended tab never spends the time away.
  r.clock += Math.max(0, Math.min(1600, now - r.wall));
  r.wall = now;
}
export async function createPractice(config, name) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0],
    now = Date.now();
  return change(() => {
    const game = newMatch([{ id: me, name }], { settings: config, seed, matchId: unique(), now: 0 });
    const r = { game, clock: 0, wall: now };
    return { save: r, value: projection(r) };
  }, true);
}
export async function readPractice(wake = false) {
  return change((r) => {
    if (!r) return { value: null };
    if (wake) r.wall = Date.now();
    return { save: wake ? r : null, value: projection(r) };
  });
}
export async function practiceAction(v, m) {
  return change((r) => {
    if (!r) throw Error('练习进度已不存在');
    advanceClock(r);
    const result = applyMove(
      r.game,
      me,
      { matchId: v.matchId, seatRevision: v.own.revision, move: m },
      r.clock,
    );
    if (!result.ok) throw Error(result.error);
    r.game = result.state;
    return { save: r, value: projection(r) };
  });
}
export async function reschedulePractice(view, fields) {
  return change(r => {
    const g = r?.game;
    if (!g || g.matchId !== view.matchId || g.status !== 'playing') throw Error('这桌练习已结束或被替换');
    for (const key of Object.keys(fields)) {
      if (g.settings[key] !== view.settings[key]) throw Error('另一窗口已改过赛程，请重新打开设置');
    }
    const cfg = settings({ ...g.settings, ...fields }, g.settings.health);
    if (cfg.sections !== g.settings.sections && cfg.sections * battlesPerChapter(g) < g.battle)
      throw Error('所选长度短于当前进度，请多选几章');
    advanceClock(r);
    if (cfg.matchMinutes !== g.settings.matchMinutes) {
      const end = cfg.matchMinutes ? cfg.matchMinutes * 60000 : null;
      if (end != null && end <= r.clock) throw Error('已超过这个时长，请增加分钟数或关闭限时');
      if (g.phase === 'growth' && g.deadline === g.matchDeadline)
        g.deadline = r.clock + g.phaseDuration;
      g.matchDeadline = end;
      if (g.phase === 'growth' && end != null) g.deadline = Math.min(g.deadline, end);
    }
    g.settings = cfg;
    g.seq++;
    return { save: r, value: projection(r) };
  });
}
export async function practiceTick(match, fast) {
  return change((r) => {
    if (!r || r.game.matchId !== match) return { value: null };
    if (r.game.status !== 'playing') return { value: projection(r) };
    advanceClock(r);
    const botDue = r.game.botAt <= r.game.deadline && dueAt(r.game) === r.game.botAt;
    if (fast && botDue) r.game.botAt = Math.min(r.clock, r.game.botAt);
    if (r.clock >= dueAt(r.game)) {
      const result = step(r.game, r.clock, opponent);
      if (result.state) r.game = result.state;
    }
    return { save: r, value: projection(r) };
  });
}
export async function rememberResult(view) {
  if (!view.result || !view.own) return;
  const db = await database();
  return new Promise((ok, fail) => {
    const tx = db.transaction('seats', 'readwrite'),
      s = tx.objectStore('seats'),
      r = s.get('career');
    r.onsuccess = () => {
      const a = r.result || { played: {}, count: 0, flags: {}, venues: [] };
      if (a.played[view.matchId]) return;
      a.played[view.matchId] = true;
      a.count++;
      for (const k of view.result.earned?.[view.self] || []) a.flags[k] = true;
      if (view.result.winnerIds.includes(view.self) && !a.venues.includes(view.settings.arena))
        a.venues.push(view.settings.arena);
      if (a.venues.length === 3) a.flags.tour = true;
      if (a.count >= 10) a.flags.finish10 = true;
      if (a.count >= 50) a.flags.finish50 = true;
      if (Array.from({ length: 11 }, (_, i) => a.flags['hand' + i]).every(Boolean)) a.flags.all = true;
      s.put(a, 'career');
    };
    tx.oncomplete = ok;
    tx.onerror = () => fail(tx.error);
  });
}
export async function career() {
  const db = await database();
  return new Promise((ok, fail) => {
    const r = db.transaction('seats').objectStore('seats').get('career');
    r.onsuccess = () => ok(r.result || { count: 0, flags: {}, venues: [] });
    r.onerror = () => fail(r.error);
  });
}
