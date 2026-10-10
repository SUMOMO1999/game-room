/** Selecting a card by dragging is local UI state; this owner never dispatches a game action. */
export function mountHandDrag({ root, getContext, onDrop, onBlocked = () => {} }) {
  const document = root.ownerDocument, window = document.defaultView;
  const hand = root.querySelector('#yg-hand'), table = root.querySelector('.yg-centre');
  const target = document.createElement('div');
  target.className = 'hy-hand-drop';
  target.textContent = '松手选牌，再决定如何使用';
  target.setAttribute('aria-hidden', 'true');
  target.hidden = true;
  table.append(target);
  let gesture = null, ghost = null, suppressUntil = 0, destroyed = false;
  const removers = [];
  function listen(node, type, handler, options) {
    node.addEventListener(type, handler, options);
    removers.push(() => node.removeEventListener(type, handler, options));
  }
  function current(candidate) {
    const context = getContext();
    return context && context.scope === candidate.scope && context.cardIds.includes(candidate.cardId)
      && !root.querySelector('dialog[open]') ? context : null;
  }
  function reset(suppress = false) {
    const previous = gesture;
    gesture = null;
    if (suppress) suppressUntil = window.performance.now() + 400;
    if (previous && hand.hasPointerCapture?.(previous.pointerId)) hand.releasePointerCapture(previous.pointerId);
    ghost?.remove(); ghost = null;
    target.hidden = true; target.classList.remove('is-over');
    root.classList.remove('hy-hand-dragging');
  }
  function inside(x, y) {
    const rect = table.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }
  function moveGhost(x, y) {
    ghost.style.left = `${x}px`; ghost.style.top = `${y}px`;
    target.classList.toggle('is-over', inside(x, y));
  }
  listen(hand, 'pointerdown', event => {
    if (destroyed || !event.isPrimary || event.button !== 0) return;
    const card = event.target.closest('.yg-hand-card[data-entity-id]'), context = getContext();
    if (!card || !context?.cardIds.includes(card.dataset.entityId) || root.querySelector('dialog[open]')) return;
    suppressUntil = 0;
    reset();
    gesture = { pointerId: event.pointerId, cardId: card.dataset.entityId, scope: context.scope,
      startX: event.clientX, startY: event.clientY, mode: 'pending', card };
  });
  listen(window, 'pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const context = current(gesture);
    if (!context) return reset(true);
    if (gesture.mode === 'browsing') return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (gesture.mode === 'pending') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
      // Horizontal browsing locks this gesture; it must never become an accidental play.
      if (dy >= 0 || -dy <= Math.abs(dx) * 1.25) { gesture.mode = 'browsing'; return; }
      if (!context.enabled) { gesture.mode = 'browsing'; onBlocked(context.blockedReason || '当前不能出牌，可点牌查看。'); return; }
      gesture.mode = 'dragging';
      hand.setPointerCapture(event.pointerId);
      ghost = document.createElement('div'); ghost.className = 'hy-hand-ghost'; ghost.setAttribute('aria-hidden', 'true');
      const face = gesture.card.querySelector('.yousei-card').cloneNode(true);
      face.removeAttribute('id'); face.setAttribute('tabindex', '-1');
      ghost.append(face); root.append(ghost);
      target.hidden = false; root.classList.add('hy-hand-dragging');
    }
    if (!context.enabled) return reset(true);
    event.preventDefault(); moveGhost(event.clientX, event.clientY);
  }, { passive: false });
  listen(window, 'pointerup', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const saved = gesture, dragging = saved.mode === 'dragging', context = current(saved);
    const accepted = dragging && context?.enabled && inside(event.clientX, event.clientY);
    reset(saved.mode !== 'pending');
    if (accepted) onDrop(saved.cardId);
  });
  listen(window, 'pointercancel', () => reset(gesture && gesture.mode !== 'pending'));
  listen(hand, 'lostpointercapture', event => {
    // Touch starts with implicit capture on the card. Moving capture to the hand
    // releases that old child capture; its bubbling event is not a cancelled drag.
    if (event.target === hand && gesture?.mode === 'dragging' && event.pointerId === gesture.pointerId) reset(true);
  });
  listen(window, 'blur', () => reset(true));
  listen(window, 'resize', () => reset(gesture?.mode === 'dragging'));
  listen(document, 'visibilitychange', () => { if (document.hidden) reset(true); });
  listen(document, 'keydown', event => { if (event.key === 'Escape' && gesture) { event.preventDefault(); reset(true); } }, true);
  listen(root, 'dragstart', event => { if (event.target.closest('#yg-hand')) event.preventDefault(); });
  // Capture before the page click owner, including the synthetic click after touch release.
  listen(document, 'click', event => {
    if (hand.contains(event.target) && event.detail !== 0 && window.performance.now() < suppressUntil) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  return {
    sync() { if (gesture && (!current(gesture) || (gesture.mode === 'dragging' && !getContext()?.enabled))) reset(true); },
    cancel() { reset(gesture?.mode === 'dragging'); },
    destroy() { if (destroyed) return; destroyed = true; reset(); removers.forEach(remove => remove()); target.remove(); }
  };
}
