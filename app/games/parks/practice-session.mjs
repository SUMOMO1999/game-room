import { createParksPractice, decodeParksPractice, encodeParksPractice, parksPracticeView, applyParksPracticeAction,
  advanceParksPractice, pauseParksPractice, resumeParksPractice } from './practice-engine.mjs';

/** One persisted match, compared before every write. No hidden-tab clock or bot. */
export function createParksPracticeSession({ storage, key, create = createParksPractice, canWrite = () => true, onView = () => {}, onFailure = () => {} } = {}) {
  let saved = null, expected = null, blocked = false, suspended = false, disposed = false;
  function fail(message) { blocked = true; onFailure(message); return { ok: false, error: message }; }
  const writable = () => !disposed && canWrite();
  const readOnly = () => ({ ok: false, error: '当前窗口只读，请在持有这局练习的窗口继续。' });
  function publish(events = []) { if (saved && !disposed) onView(parksPracticeView(saved), { saved: structuredClone(saved), events, blocked }); }
  function read() {
    if (disposed) return { ok: false, error: '练习已结束。' };
    try { expected = storage.getItem(key); } catch { return fail('无法读取本机存档，请允许本站存储。'); }
    if (expected === null) { saved = null; blocked = false; return { ok: true, empty: true }; }
    saved = decodeParksPractice(expected);
    if (!saved) return fail('原存档无法读取。它仍保留在本机；重新开始会替换这份存档。');
    blocked = false; publish(); return { ok: true, restored: true };
  }
  function persist(next, events = []) {
    if (disposed || !next) return { ok: false, error: '练习已结束。' };
    if (!writable()) return readOnly();
    try {
      if (storage.getItem(key) !== expected) return fail('另一窗口已更新这局练习。请刷新接续，避免覆盖它。');
      const raw = encodeParksPractice(next); storage.setItem(key, raw);
      if (storage.getItem(key) !== raw) return fail('存档未写入。请检查本站存储后刷新核对。');
      expected = raw; saved = structuredClone(next); blocked = false; publish(events); return { ok: true };
    } catch { return fail('保存结果未确认，已经暂停操作。请恢复存储并刷新核对，再继续这局练习。'); }
  }
  function apply(operation) {
    if (!writable()) return readOnly();
    if (!saved || blocked || disposed) return { ok: false, error: '先恢复本机存档，再继续。' };
    const result = operation(saved); if (!result.ok) return { ok: false, error: result.error };
    return persist(result.saved, result.events);
  }
  return {
    read,
    start(options) { if (disposed) return { ok: false }; if (!writable()) return readOnly(); try { return persist(create(options)); } catch (error) { return { ok: false, error: error.message }; } },
    act(type, intent) { if (!['pause','resume'].includes(type) && intent?.type !== type) return { ok: false, error: '操作与当前选择不一致。' }; return apply(value => type === 'pause' ? pauseParksPractice(value) : type === 'resume' ? resumeParksPractice(value) : applyParksPracticeAction(value, intent)); },
    tick(elapsedMs) { if (!writable() || suspended || blocked || disposed || !saved || saved.game.status !== 'playing' || saved.game.decisionWindow.paused) return { ok: true, suspended: true };
      return apply(value => advanceParksPractice(value, { elapsedMs: Math.min(2000, Math.max(0, Math.round(elapsedMs))), maxSteps: 1 })); },
    suspend(value) { suspended = Boolean(value); },
    externalChange(raw) { if (disposed || raw === expected) return; fail('另一窗口更新了练习，请刷新接续。'); },
    retryStorage() { if (!writable()) return readOnly(); try { if (storage.getItem(key) !== expected) return fail('存档已改变，请刷新接续。'); blocked = false; publish(); return { ok: true }; } catch { return fail('本机存储仍不可用。'); } },
    snapshot() { return { saved: saved ? structuredClone(saved) : null, blocked, suspended }; },
    destroy() { disposed = true; saved = null; expected = null; },
  };
}
