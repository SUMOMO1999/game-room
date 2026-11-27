// The touch ghost follows the finger locally. Only the final gesture may submit a move.
export function mountGestures(root, { perform }) {
  let drag = null,
    suppress = 0;
  function end() {
    drag?.ghost?.remove();
    drag?.node?.classList.remove('held');
    drag = null;
  }
  function down(e) {
    if (!drag) suppress = 0;
    const node = e.target.closest('.face[data-act]');
    if (
      !node ||
      node.disabled ||
      !['hand', 'lot', 'peek'].includes(node.dataset.act) ||
      e.button !== 0 ||
      drag
    )
      return;
    drag = {
      id: e.pointerId,
      node,
      x: e.clientX,
      y: e.clientY,
      dx: 0,
      dy: 0,
      moved: false,
      ghost: null,
    };
    node.classList.add('held');
  }
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(drag.dx, drag.dy) < 7) return;
    if (!drag.moved) {
      drag.moved = true;
      const b = drag.node.getBoundingClientRect(),
        clone = drag.node.cloneNode(true);
      clone.removeAttribute('data-act');
      clone.tabIndex = -1;
      clone.setAttribute('aria-hidden', 'true');
      clone.classList.add('dragGhost');
      Object.assign(clone.style, {
        position: 'fixed',
        top: b.top + 'px',
        left: b.left + 'px',
        width: b.width + 'px',
        height: b.height + 'px',
        pointerEvents: 'none',
        zIndex: 20,
        margin: '0',
        rotate: 'none',
        translate: 'none',
        transition: 'none',
      });
      document.body.append(clone);
      drag.ghost = clone;
      root.setPointerCapture?.(e.pointerId);
    }
    e.preventDefault();
    drag.ghost.style.transform = 'translate3d(' + drag.dx + 'px,' + drag.dy + 'px,0) rotate(2deg)';
  }
  function up(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { node, moved, dy } = drag;
    const tap = !moved && e.pointerType === 'touch';
    if (moved || tap) suppress = performance.now() + 440;
    end();
    if (tap) {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.face[data-act]');
      if (target?.dataset.act === node.dataset.act && target.dataset.val === node.dataset.val)
        perform(node.dataset.act, node.dataset.val, target);
      return;
    }
    if (!moved) return;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-act]');
    if (node.dataset.act === 'lot') {
      const card = target?.dataset.act === 'lot' ? target : node;
      perform('lot', card.dataset.val, card);
    } else if (node.dataset.act === 'hand' && (Math.abs(dy) > 22 || target?.dataset.act === 'hand'))
      perform('hand', node.dataset.val);
  }
  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move, { passive: false });
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', (e) => {
    if (drag?.id === e.pointerId) end();
  });
  window.addEventListener('blur', end);
  root.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.face')) e.preventDefault();
  });
  root.addEventListener(
    'click',
    (e) => {
      if (performance.now() < suppress) {
        e.preventDefault();
        e.stopImmediatePropagation();
        suppress = 0;
      }
    },
    { capture: true },
  );
}
