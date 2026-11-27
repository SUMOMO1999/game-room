export function connectBoard({ board, scroll, act, move, identity, preview, onFocus, isMarkMode, columns }) {
  let press, lastTap;
  const cell = event => event.target.closest?.('[data-cell]');
  const index = node => Number(node.dataset.cell);
  const at = (event, node) => node.contains(document.elementFromPoint(event.clientX, event.clientY));
  function cancel() {
    if (!press) return;
    clearTimeout(press.timer);
    preview(press.node, false);
    press = null;
  }
  function release(event, kind) {
    const current = press;
    cancel();
    if (current && at(event, current.node) && current.identity === identity()) {
      act(kind, index(current.node));
    }
  }
  board.addEventListener('contextmenu', event => event.preventDefault());
  board.addEventListener('focusin', event => { if (cell(event)) onFocus(index(cell(event))); });
  board.addEventListener('mousedown', event => {
    const node = cell(event);
    if (!node || (event.button !== 0 && event.button !== 2) || event.sourceCapabilities?.firesTouchEvents) return;
    if (press?.type === 'mouse' && press.node === node && event.buttons === 3) {
      press.chord = true;
      return;
    }
    cancel();
    press = { type: 'mouse', node, button: event.button, identity: identity() };
    if (event.button === 0) preview(node, true);
  });
  window.addEventListener('mouseup', event => {
    if (press?.type !== 'mouse') return;
    if (press.chord) release(event, 'chord');
    else if (event.button === press.button) release(event, event.button === 2 ? 'mark' : 'reveal');
  });
  window.addEventListener('mousemove', event => {
    if (press?.type === 'mouse' && !at(event, press.node)) cancel();
  });
  board.addEventListener('dblclick', event => { if (cell(event)) act('chord', index(cell(event))); });
  board.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse') return;
    if (!event.isPrimary || press) { cancel(); lastTap = null; return; }
    const node = cell(event);
    if (!node) return;
    const current = { type: 'touch', node, id: event.pointerId, x: event.clientX, y: event.clientY,
      identity: identity() };
    press = current;
    preview(node, true);
    current.timer = setTimeout(() => {
      if (press !== current || current.identity !== identity()) return;
      lastTap = null;
      current.marked = true;
      preview(node, false);
      act('mark', index(node));
    }, 400);
  });
  window.addEventListener('pointermove', event => {
    if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) {
      cancel(); lastTap = null;
    }
  });
  window.addEventListener('pointerup', event => {
    if (press?.type !== 'touch' || press.id !== event.pointerId) return;
    // Compatibility mouse events must never apply the touch a second time.
    const current = press;
    cancel();
    if (current.marked || !at(event, current.node) || current.identity !== identity()) return;
    const target = index(current.node);
    if (current.node.dataset.number) {
      if (lastTap?.node === current.node && performance.now() - lastTap.time <= 320) {
        lastTap = null;
        act('chord', target);
      } else lastTap = { node: current.node, time: performance.now() };
      return;
    }
    lastTap = null;
    act(isMarkMode() ? 'mark' : 'reveal', target);
  });
  // Safari can synthesize compatibility mouse events after the touch. Only
  // real mouse pointerdown authorizes a mouse gesture on such browsers.
  let mouseAllowed = false;
  board.addEventListener('pointerdown', event => { mouseAllowed = event.pointerType === 'mouse'; }, true);
  board.addEventListener('mousedown', event => { if (!mouseAllowed) event.stopImmediatePropagation(); }, true);
  board.addEventListener('dblclick', event => { if (!mouseAllowed) event.stopImmediatePropagation(); }, true);
  for (const [target, name] of [[window, 'pointercancel'], [window, 'blur'], [window, 'resize'], [scroll, 'scroll'], [document, 'visibilitychange']]) {
    target.addEventListener(name, () => { cancel(); lastTap = null; });
  }
  board.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') cancel(); });
  board.addEventListener('keydown', event => {
    const node = cell(event);
    if (!node) return;
    const width = columns(), target = index(node);
    const step = { ArrowLeft: target % width ? -1 : 0, ArrowRight: target % width < width - 1 ? 1 : 0,
      ArrowUp: -width, ArrowDown: width };
    const action = { Enter: 'reveal', f: 'mark', F: 'mark', ' ': 'chord' }[event.key];
    if (Object.hasOwn(step, event.key)) {
      event.preventDefault();
      move(target + step[event.key]);
    } else if (action) {
      event.preventDefault();
      if (!event.repeat) act(action, target);
    }
  });
  board.addEventListener('click', event => {
    // Programmatic activation from accessibility tools has no pointer.
    if (event.detail === 0 && cell(event)) act('reveal', index(cell(event)));
  });
  return cancel;
}
