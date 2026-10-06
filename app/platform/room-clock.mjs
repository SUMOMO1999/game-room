import { turnClockDisplay } from './room-presentation.mjs';

// The server owns the deadline. This controller only advances its displayed
// elapsed time and tells the game when its local interaction must stop.
export function createRoomClock({ onRender, onExpire = () => {}, now = () => performance.now(),
  setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval } = {}) {
  let view = null, receivedAt = 0, timer = null, wasExpired = false, destroyed = false, timerGeneration = 0;
  const display = () => turnClockDisplay(view, now() - receivedAt);
  function stop() {
    ++timerGeneration;
    if (timer !== null) clearInterval(timer);
    timer = null;
  }
  function render() {
    if (destroyed) return;
    const state = display(), renderedView = view, generation = timerGeneration;
    const newlyExpired = state.expired && !wasExpired;
    wasExpired = state.expired;
    onRender?.(state);
    if (destroyed || view !== renderedView || generation !== timerGeneration) return display();
    if (newlyExpired) onExpire();
    if (!destroyed && view === renderedView && generation === timerGeneration && (!state.visible || state.paused)) stop();
    return state;
  }
  function receive(next) {
    if (destroyed) return;
    view = next; receivedAt = now();
    const state = render();
    if (!destroyed && view === next && state.visible && !state.paused && timer === null) {
      const generation = ++timerGeneration;
      timer = setInterval(() => { if (generation === timerGeneration) render(); }, 250);
    }
  }
  function reset() {
    stop(); view = null; wasExpired = false;
    if (!destroyed) onRender?.(display());
  }
  function destroy() { if (!destroyed) { reset(); destroyed = true; } }
  return { display, receive, render, reset, destroy };
}

export function renderRoomClock(document, state) {
  const node = document.getElementById('turn-clock');
  if (!node) return;
  node.hidden = !state.visible;
  if (!state.visible) return;
  document.getElementById('turn-clock-time').textContent = state.time;
  document.getElementById('turn-clock-action').textContent = state.action;
  node.classList.toggle('expired', state.expired); node.classList.toggle('paused', state.paused);
  node.title = state.label; node.setAttribute('aria-label', state.label);
}
