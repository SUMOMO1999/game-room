import { createObjectMotion } from '../../platform/object-motion.mjs';

/** Local layout is visual only; the controller marks authoritative baselines
 * and confirmations. No rack/deck state or private projection is stored here. */
export function mountRummikubMotion({ root = document.body, document: doc = root.ownerDocument,
  window: win = doc.defaultView } = {}) {
  if (!doc.querySelector('[data-rummi-motion-style]')) {
    const style = doc.createElement('link'); style.rel = 'stylesheet';
    style.href = new URL('./motion.css', import.meta.url).href; style.dataset.rummiMotionStyle = '';
    doc.head.append(style);
  }
  root.classList.add('rummi-motion');
  const motion = createObjectMotion({ root, document: doc, window: win, maxObjects: 16 });
  let origins = null, frame = null, quiet = true, quietFrame = null, drop = null, stamp = 0;
  const effects = new Set();
  const tiles = () => [...root.querySelectorAll('#board [data-tile], #rack [data-tile]')];
  function cancel() {
    stamp++; motion.cancel(); origins = null; drop = null;
    for (const effect of effects) effect.cancel(); effects.clear();
    if (frame !== null) win.cancelAnimationFrame(frame); frame = null;
  }
  function baseline() {
    cancel(); quiet = true;
    if (quietFrame !== null) win.cancelAnimationFrame(quietFrame);
    quietFrame = win.requestAnimationFrame(() => { quietFrame = null; quiet = false; });
  }
  function begin() {
    if (quiet || doc.hidden) return false;
    if (origins) return true;
    motion.cancel(); origins = new Map();
    for (const tile of tiles()) {
      const rect = tile.getBoundingClientRect();
      if (rect.width && rect.height) origins.set(tile.dataset.tile, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    return true;
  }
  function end(changed) {
    if (!changed || !origins) return;
    if (frame !== null) win.cancelAnimationFrame(frame);
    const current = stamp;
    frame = win.requestAnimationFrame(() => {
      frame = null; if (current !== stamp || doc.hidden) return;
      const before = origins; origins = null; let count = 0;
      for (const tile of tiles()) {
        if (count >= 16) break;
        const id = tile.dataset.tile, target = tile.getBoundingClientRect();
        let from = before.get(id);
        if (drop?.id === id && win.performance.now() - drop.at < 100) from = drop.rect;
        if (!from && tile.closest('#rack') && before.size) {
          const source = root.querySelector('#draw'), captured = motion.capture(source);
          if (!captured) continue;
          const back = doc.createElement('span'); back.className = 'tile rummi-motion-back'; back.textContent = '◆';
          captured.node = back;
          void motion.move({ from: captured, to: '#rack [data-tile="' + id + '"]', duration: 240, flip: true }); count++; continue;
        }
        if (!from || Math.abs(target.x - from.x) + Math.abs(target.y - from.y) < 3) continue;
        const captured = motion.capture(tile, { presentationAttributes: ['data-color', 'data-joker-type'] }); if (!captured) continue;
        captured.rect = from;
        void motion.move({ from: captured, to: (tile.closest('#rack') ? '#rack' : '#board') + ' [data-tile="' + id + '"]', duration: 210 }); count++;
      }
      drop = null;
    });
  }
  function confirmed(ids) {
    // The same real tiles are already in the player's draft. A small settle
    // marks server acceptance without pretending they were played twice.
    const current = stamp;
    win.requestAnimationFrame(() => {
      if (current !== stamp || doc.hidden || quiet || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      let count = 0;
      for (const tile of root.querySelectorAll('#board [data-tile]')) if (count < 16 && ids.includes(tile.dataset.tile)) {
        count++;
        const effect = tile.animate?.([{ boxShadow: '0 0 0 2px #ffe4a8', transform: 'translateY(-2px)' },
          { boxShadow: '0 0 0 0px transparent', transform: 'translateY(0)' }], { duration: 260, easing: 'ease-out' });
        if (effect) { effects.add(effect); effect.finished.catch(() => {}).finally(() => effects.delete(effect)); }
      }
    });
  }
  const hide = () => { if (doc.hidden) baseline(); };
  doc.addEventListener('visibilitychange', hide); win.addEventListener('resize', baseline);
  baseline();
  return { begin, end, baseline, cancel, confirmed, sync: () => motion.sync(),
    dropOrigin(id, rect) { if (id && rect) drop = { id, rect, at: win.performance.now() }; },
    destroy() { cancel(); if (quietFrame !== null) win.cancelAnimationFrame(quietFrame); motion.destroy();
      doc.removeEventListener('visibilitychange', hide); win.removeEventListener('resize', baseline); } };
}

export function placementCue({ autoSplit = false, merged = false } = {}) {
  return autoSplit ? 'split' : merged ? 'merge' : 'placement';
}
