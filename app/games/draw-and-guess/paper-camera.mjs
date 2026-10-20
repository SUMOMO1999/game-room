import { drawingGeometry } from './canvas-view.mjs';

const ZOOMS = Object.freeze([1, 1.5, 2]);
const clamp = (value, maximum) => Math.min(Math.max(0, value), Math.max(0, maximum));

/** Page-owned view of one unchanged logical paper. No stroke, lease or server
 * state belongs here. fit() also applies parent CSS width/height synchronously;
 * canvas.width/height and drawing coordinates always stay with canvas-view. */
export function createDrawingPaperCamera({ canvas, slot, onBeforeChange = () => {}, onChange = () => {},
  window: win = globalThis.window, document: doc = globalThis.document } = {}) {
  const paper = canvas?.parentElement;
  if (!canvas || !slot || !paper?.style || !slot.style || typeof slot.getBoundingClientRect !== 'function'
      || typeof onBeforeChange !== 'function' || typeof onChange !== 'function') throw new TypeError('画纸视图需要画布、容器和有效回调。');
  let geometry = drawingGeometry({ geometry: { width: 1024, height: [576, 768].includes(canvas.height) ? canvas.height : 768 } });
  let zoom = 1, pan = false, drag = null, blockedGesture = false, destroyed = false;
  let size = { width: 0, height: 0 };
  const pointers = new Set(), listeners = [];
  const original = { width: paper.style.width || '', height: paper.style.height || '', touchAction: slot.style.touchAction || '', cursor: slot.style.cursor || '' };
  const state = () => ({ zoom, pan, dragging: Boolean(drag), ...size });
  const emit = () => { if (!destroyed) onChange(state()); };
  const listen = (target, type, handler, options) => {
    target?.addEventListener?.(type, handler, options);
    listeners.push(() => target?.removeEventListener?.(type, handler, options));
  };
  const viewport = () => {
    const box = slot.getBoundingClientRect();
    return { width: Number.isFinite(box.width) ? Math.max(0, box.width) : 0,
      height: Number.isFinite(box.height) ? Math.max(0, box.height) : 0 };
  };
  function normalizeGeometry(value) {
    if (value === undefined) return geometry;
    if (value && typeof value === 'object' && (Object.hasOwn(value, 'width') || Object.hasOwn(value, 'height'))) return drawingGeometry({ geometry: value });
    return drawingGeometry(value);
  }
  function fit(value) {
    if (destroyed) return { ...size };
    geometry = normalizeGeometry(value);
    const box = viewport(), aspect = geometry.width / geometry.height;
    const width = Math.max(1, Math.min(box.width, box.height * aspect)) * zoom;
    const next = { width, height: width / aspect };
    if (drag && (Math.abs(next.width - size.width) > 0.01 || Math.abs(next.height - size.height) > 0.01)) stopDrag();
    size = next;
    paper.style.width = `${size.width}px`; paper.style.height = `${size.height}px`;
    return { ...size };
  }
  function stopDrag({ clearPointers = true, notify = true } = {}) {
    const previous = drag; drag = null;
    if (clearPointers) { pointers.clear(); blockedGesture = false; }
    slot.style.cursor = pan ? 'grab' : original.cursor;
    // Lost capture can arrive synchronously, so drag is already cleared above.
    if (previous) { try { slot.releasePointerCapture?.(previous.pointerId); } catch { /* The browser may have released it on cancel or hide. */ } }
    if (previous && notify) emit();
  }
  function updateView(nextZoom, nextPan, { reset = false } = {}) {
    if (destroyed) return state();
    const box = viewport(), center = {
      x: size.width > box.width ? ((slot.scrollLeft || 0) + box.width / 2) / size.width : 0.5,
      y: size.height > box.height ? ((slot.scrollTop || 0) + box.height / 2) / size.height : 0.5,
    };
    onBeforeChange();
    stopDrag({ notify: false }); zoom = nextZoom; pan = nextZoom > 1 && nextPan;
    slot.style.touchAction = pan ? 'none' : original.touchAction;
    slot.style.cursor = pan ? 'grab' : original.cursor;
    // Let the page remove max-width/max-height and enable slot overflow before
    // measuring/applying enlarged paper. The callback must not call setZoom().
    emit(); fit();
    const after = viewport();
    slot.scrollLeft = reset ? 0 : clamp(size.width * center.x - after.width / 2, size.width - after.width);
    slot.scrollTop = reset ? 0 : clamp(size.height * center.y - after.height / 2, size.height - after.height);
    emit(); return state();
  }
  function setZoom(value) {
    if (!ZOOMS.includes(value)) throw new RangeError('画纸缩放只支持1、1.5或2倍。');
    if (destroyed || value === zoom) return state();
    return updateView(value, pan, { reset: value === 1 });
  }
  function setPan(value) {
    if (typeof value !== 'boolean') throw new TypeError('平移开关必须为布尔值。');
    const next = value && zoom > 1;
    if (destroyed || next === pan) return state();
    return updateView(zoom, next);
  }
  function intercept(event) {
    event.preventDefault?.(); event.stopImmediatePropagation?.(); event.stopPropagation?.();
  }
  const captureOptions = { capture: true, passive: false };
  listen(slot, 'pointerdown', event => {
    if (!pan || destroyed) return;
    intercept(event);
    if (doc?.hidden || event.button !== undefined && event.button !== 0) return;
    pointers.add(event.pointerId);
    if (pointers.size !== 1 || event.isPrimary === false) {
      blockedGesture = true; stopDrag({ clearPointers: false }); return;
    }
    if (blockedGesture || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: slot.scrollLeft || 0, top: slot.scrollTop || 0 };
    try { slot.setPointerCapture?.(event.pointerId); } catch { stopDrag(); return; }
    slot.style.cursor = 'grabbing'; emit();
  }, captureOptions);
  listen(slot, 'pointermove', event => {
    if (!pan || destroyed) return;
    intercept(event);
    if (!drag || blockedGesture || event.pointerId !== drag.pointerId || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const box = viewport();
    slot.scrollLeft = clamp(drag.left + drag.x - event.clientX, size.width - box.width);
    slot.scrollTop = clamp(drag.top + drag.y - event.clientY, size.height - box.height);
  }, captureOptions);
  listen(slot, 'pointerup', event => {
    if (!pan || destroyed) return;
    intercept(event); pointers.delete(event.pointerId);
    if (drag?.pointerId === event.pointerId) stopDrag({ clearPointers: false });
    if (!pointers.size) blockedGesture = false;
  }, captureOptions);
  listen(slot, 'pointercancel', event => {
    if (!pan || destroyed) return;
    intercept(event); stopDrag();
  }, captureOptions);
  listen(slot, 'lostpointercapture', event => {
    if (!pan || destroyed) return;
    intercept(event);
    // Touch first implicitly captures the child canvas. Moving that capture to
    // slot emits lost on canvas before got on slot; only losing our own capture
    // ends this drag, not the child's expected handoff event.
    if (event.target === slot && drag?.pointerId === event.pointerId) stopDrag();
  }, captureOptions);
  listen(doc, 'visibilitychange', () => { if (doc.hidden) stopDrag(); });
  listen(win, 'pagehide', () => stopDrag());
  return { fit, setZoom, setPan, reset: () => updateView(1, false, { reset: true }), state,
    destroy() {
      if (destroyed) return;
      stopDrag({ notify: false }); destroyed = true; listeners.splice(0).forEach(remove => remove());
      paper.style.width = original.width; paper.style.height = original.height;
      slot.style.touchAction = original.touchAction; slot.style.cursor = original.cursor;
    } };
}
