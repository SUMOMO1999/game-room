/** Selecting a card by dragging is local UI state; this owner never dispatches a game action. */
export function mountHandDrag({ root, getContext, onDrop, onBlocked = () => {}, surface }) {
  const document = root.ownerDocument, window = document.defaultView;
  const hand = surface?.hand ?? root.querySelector('#yg-hand');
  const table = surface?.table ?? root.querySelector('.yg-centre');
  const cardSelector = surface?.cardSelector ?? '.yg-hand-card[data-entity-id]';
  const cardId = card => card.dataset.entityId ?? card.dataset.instance;
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
      && !document.querySelector('dialog[open]') ? context : null;
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
    const rect = (surface ? target : target.parentElement).getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }
  function moveGhost(x, y) {
    if (surface) {
      const left = gesture.bounds.left + x - gesture.startX;
      const top = gesture.bounds.top + y - gesture.startY;
      ghost.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    } else {
      ghost.style.left = `${x}px`; ghost.style.top = `${y}px`;
    }
    target.classList.toggle('is-over', inside(x, y));
  }
  listen(hand, 'pointerdown', event => {
    if (destroyed || !event.isPrimary || event.button !== 0) return;
    const card = event.target.closest(cardSelector), context = getContext();
    if (!card || !context?.cardIds.includes(cardId(card)) || document.querySelector('dialog[open]')) return;
    suppressUntil = 0;
    reset();
    gesture = { pointerId: event.pointerId, cardId: cardId(card), scope: context.scope,
      startX: event.clientX, startY: event.clientY, mode: 'pending', card,
      bounds: surface ? card.getBoundingClientRect() : null };
  });
  listen(window, 'pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const context = current(gesture);
    if (!context) return reset(true);
    if (gesture.mode === 'browsing') return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (gesture.mode === 'pending') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
      const horizontal = Math.abs(dx), upward = -dy;
      // Keep near-horizontal browsing locked, but accept natural diagonal lifts
      // from either end of the hand. Between the two directions, wait for intent.
      if (dy >= 12 || (horizontal >= 12 && upward <= horizontal * 0.5)) {
        gesture.mode = 'browsing'; return;
      }
      if (upward < 12 || upward < horizontal * 0.65) return;
      if (!context.enabled) { gesture.mode = 'browsing'; onBlocked(context.blockedReason || '当前不能出牌，可点牌查看。'); return; }
      gesture.mode = 'dragging';
      hand.setPointerCapture(event.pointerId);
      ghost = document.createElement('div'); ghost.className = 'hy-hand-ghost'; ghost.setAttribute('aria-hidden', 'true');
      if (surface) {
        ghost.classList.add('m-print');
        ghost.style.width = `${gesture.bounds.width}px`;
        ghost.style.height = `${gesture.bounds.height}px`;
      }
      const face = gesture.card.querySelector('.yousei-card').cloneNode(true);
      face.removeAttribute('id'); face.setAttribute('tabindex', '-1');
      ghost.append(face); (surface?.table ?? root).append(ghost);
      target.textContent=context.label??'松手选牌，再决定如何使用';
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
  listen(window, 'pointercancel', event => {
    if (gesture?.pointerId === event.pointerId) reset(gesture.mode !== 'pending');
  });
  listen(hand, 'lostpointercapture', event => {
    // Touch starts with implicit capture on the card. Moving capture to the hand
    // releases that old child capture; its bubbling event is not a cancelled drag.
    if (event.target === hand && gesture?.mode === 'dragging' && event.pointerId === gesture.pointerId) reset(true);
  });
  listen(window, 'blur', () => reset(true));
  listen(window, 'resize', () => reset(gesture?.mode === 'dragging'));
  listen(document, 'visibilitychange', () => { if (document.hidden) reset(true); });
  listen(document, 'keydown', event => { if (event.key === 'Escape' && gesture) { event.preventDefault(); reset(true); } }, true);
  listen(root, 'dragstart', event => { if (event.target.closest(cardSelector)) event.preventDefault(); });
  // Capture before the page click owner, including the synthetic click after touch release.
  listen(document, 'click', event => {
    if (hand.contains(event.target) && (!surface || event.target.closest(cardSelector)) && event.detail !== 0 && window.performance.now() < suppressUntil) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  return {
    sync() { if (gesture && (!current(gesture) || (gesture.mode === 'dragging' && !getContext()?.enabled))) reset(true); },
    cancel() { reset(gesture?.mode === 'dragging'); },
    destroy() { if (destroyed) return; destroyed = true; reset(); removers.forEach(remove => remove()); target.remove(); }
  };
}
