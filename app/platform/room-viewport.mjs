export function mountCanvasPin({ containers, document, pinOnFocus = false } = {}) {
  const nodes = [...new Set(containers.filter(Boolean))];
  function pin() {
    for (const node of nodes) {
      if (node.scrollTop) node.scrollTop = 0;
      if (node.scrollLeft) node.scrollLeft = 0;
    }
  }
  for (const node of nodes) node.addEventListener('scroll', pin, { passive: true });
  if (pinOnFocus) document.addEventListener('focusin', pin);
  return { pin, destroy() {
    for (const node of nodes) node.removeEventListener('scroll', pin);
    if (pinOnFocus) document.removeEventListener('focusin', pin);
  } };
}

// Keep geometry and game interaction in callbacks. Only entries with keyboard
// recovery opt into the delayed syncs and focus/navigation listeners.
export function mountGameViewport({ window, document, sync, onRecover = () => {}, recoveryDelays = [],
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
  let timers = [], generation = 0, destroyed = false;
  const listeners = [];
  function listen(target, type, handler) {
    target?.addEventListener?.(type, handler);
    listeners.push(() => target?.removeEventListener?.(type, handler));
  }
  function update() { if (!destroyed) sync(); }
  function recover() {
    if (destroyed) return;
    ++generation; timers.forEach(clearTimeout); timers = [];
    onRecover();
    if (destroyed) return;
    update();
    if (destroyed) return;
    const current = generation;
    for (const delay of recoveryDelays) timers.push(setTimeout(() => {
      if (!destroyed && generation === current) update();
    }, delay));
  }
  listen(window, 'resize', update);
  listen(window.visualViewport, 'resize', update); listen(window.visualViewport, 'scroll', update);
  if (recoveryDelays.length) {
    listen(window, 'orientationchange', recover); listen(window.screen?.orientation, 'change', recover);
    listen(window, 'pageshow', recover); listen(document, 'focusin', update);
    listen(document, 'focusout', event => {
      if (event.target?.matches?.('input,textarea,[contenteditable="true"]')) recover();
    });
    listen(document, 'visibilitychange', () => { if (!document.hidden) recover(); });
  }
  update();
  return { sync: update, recover, destroy() {
    if (destroyed) return;
    destroyed = true; ++generation; timers.forEach(clearTimeout); timers = []; listeners.forEach(remove => remove());
  } };
}
