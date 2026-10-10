/** Finite, disposable presentation. Callers supply only lawful visible objects.
 * It never retains a game projection, queues business events, or locks input. */
export function createObjectMotion({ root, document: doc = root?.ownerDocument,
  window: win = doc?.defaultView, maxObjects = 24, onError = () => {} } = {}) {
  if (!root || !doc || !win) throw new TypeError('Object motion requires a mounted surface.');
  const limit = Math.min(32, Math.max(1, Number.isInteger(maxObjects) ? maxObjects : 24));
  const active = new Set(), reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let destroyed = false;
  const rectOf = value => {
    const r = value?.getBoundingClientRect?.() ?? value;
    if (!r || ![r.x ?? r.left, r.y ?? r.top, r.width, r.height].every(Number.isFinite)
      || r.width <= 0 || r.height <= 0) return null;
    return { x: r.x ?? r.left, y: r.y ?? r.top, width: r.width, height: r.height };
  };
  function copyVisual(element, visual, presentationAttributes = []) {
    let copy = (visual || element).cloneNode(true);
    if (!visual && element.namespaceURI === 'http://www.w3.org/2000/svg' && element.tagName.toLowerCase() !== 'svg') {
      const box = element.getBBox?.();
      if (!box || !box.width || !box.height) return null;
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', [box.x, box.y, box.width, box.height].join(' '));
      copy.removeAttribute('transform'); svg.append(copy); copy = svg;
    }
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      node.removeAttribute('id'); node.removeAttribute('autofocus');
      for (const name of node.getAttributeNames?.() || []) if (name.startsWith('data-') && !presentationAttributes.includes(name)) node.removeAttribute(name);
      node.setAttribute('tabindex', '-1');
    }
    const computed = win.getComputedStyle?.(element);
    Object.assign(copy.style, { position: 'relative', inset: 'auto', left: 'auto', top: 'auto',
      width: '100%', height: '100%', margin: '0', transform: 'none', visibility: 'visible',
      fontSize: computed?.fontSize || '', lineHeight: computed?.lineHeight || '',
      color: computed?.color || '', background: computed?.background || '' });
    // Preserve inherited visual variables without importing a game's vocabulary.
    for (let index = 0; index < (computed?.length || 0); index++) {
      const name = computed[index]; if (name.startsWith('--')) copy.style.setProperty(name, computed.getPropertyValue(name));
    }
    return copy;
  }
  function capture(element, options = {}) {
    if (destroyed || doc.hidden) return null;
    const node = typeof element === 'string' ? root.querySelector(element) : element;
    const rect = rectOf(node); if (!rect || !node?.cloneNode) return null;
    const copy = copyVisual(node, options.visual, options.presentationAttributes); return copy ? { rect, node: copy } : null;
  }
  function finish(record) {
    if (record.finished) return;
    record.finished = true;
    record.ghost.remove();
    if (record.destination) record.destination.style.visibility = record.visibility;
    active.delete(record);
  }
  function cancel() {
    for (const record of [...active]) { record.cancelled = true; record.animation?.cancel(); finish(record); }
  }
  function sync() {
    for (const record of [...active]) {
      if (!record.selector) continue;
      const next = root.querySelector(record.selector);
      if (!next) { record.cancelled = true; record.animation?.cancel(); finish(record); continue; }
      if (next === record.destination) continue;
      record.destination.style.visibility = record.visibility;
      record.destination = next; record.visibility = next.style.visibility; next.style.visibility = 'hidden';
    }
  }
  async function move({ from, to, path = [], duration = 260, delay = 0, flip = false, fade = false,
    easing = 'cubic-bezier(.2,.75,.3,1)' } = {}) {
    if (destroyed || doc.hidden || reduced?.matches || active.size >= limit || !from?.node) return false;
    const a = rectOf(from.rect); if (!a) return false;
    const destination = typeof to === 'string' ? root.querySelector(to) : to?.getBoundingClientRect ? to : null;
    const b = rectOf(destination || to); if (!b) return false;
    if (!Array.isArray(path) || path.length > 96 || path.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
    if (!['linear','ease-out','cubic-bezier(.2,.75,.3,1)'].includes(easing)) return false;
    const time = Math.min(1400, Math.max(80, Number.isFinite(duration) ? duration : 260));
    const wait = Math.min(1400, Math.max(0, Number.isFinite(delay) ? delay : 0));
    const target = flip && destination ? capture(destination) : null;
    const ghost = doc.createElement('div'); ghost.className = 'object-motion-ghost';
    ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true; ghost.append(from.node);
    Object.assign(ghost.style, { position: 'fixed', zIndex: '90', pointerEvents: 'none',
      left: a.x + 'px', top: a.y + 'px', width: a.width + 'px', height: a.height + 'px',
      margin: '0', transformOrigin: 'center', perspective: '700px' });
    root.append(ghost);
    if (typeof ghost.animate !== 'function') { ghost.remove(); return false; }
    const record = { ghost, destination, selector: typeof to === 'string' ? to : null,
      visibility: destination?.style.visibility, animation: null, cancelled: false, finished: false };
    active.add(record); if (destination) destination.style.visibility = 'hidden';
    const points = [{ x: a.x + a.width / 2, y: a.y + a.height / 2 }, ...path,
      { x: b.x + b.width / 2, y: b.y + b.height / 2 }];
    const frames = points.map((p, i) => {
      const fraction = i / (points.length - 1), width = a.width + (b.width - a.width) * fraction,
        height = a.height + (b.height - a.height) * fraction;
      return { left: (p.x - width / 2) + 'px', top: (p.y - height / 2) + 'px', width: width + 'px', height: height + 'px',
        opacity: fade ? 1 - fraction : 1, transform: 'scale(' + (fade ? 1 - fraction * .18 : 1 + Math.sin(fraction * Math.PI) * .035) + ')' };
    });
    try {
      record.animation = ghost.animate(frames, { duration: time, delay: wait, easing, fill: 'forwards' });
      await record.animation.finished; if (record.cancelled || destroyed) return false;
      if (target) {
        record.animation = ghost.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(90deg)' }], { duration: 90, fill: 'forwards' });
        await record.animation.finished; if (record.cancelled || destroyed) return false;
        ghost.replaceChildren(target.node);
        record.animation = ghost.animate([{ transform: 'rotateY(-90deg)' }, { transform: 'rotateY(0deg)' }], { duration: 110, fill: 'forwards' });
        await record.animation.finished;
      }
      return !record.cancelled && !destroyed;
    } catch (error) { if (!record.cancelled && error?.name !== 'AbortError') onError(error); return false; }
    finally { finish(record); }
  }
  const hidden = () => { if (doc.hidden) cancel(); };
  doc.addEventListener('visibilitychange', hidden); win.addEventListener('resize', cancel);
  win.addEventListener('pagehide', cancel); reduced?.addEventListener?.('change', cancel);
  return { capture, move, cancel, sync, activeCount: () => active.size,
    destroy() { if (destroyed) return; destroyed = true; cancel(); doc.removeEventListener('visibilitychange', hidden);
      win.removeEventListener('resize', cancel); win.removeEventListener('pagehide', cancel); reduced?.removeEventListener?.('change', cancel); } };
}
