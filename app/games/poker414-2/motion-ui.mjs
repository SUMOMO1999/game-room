import { classifyPattern } from './patterns.mjs';
import { createObjectMotion } from '../../platform/object-motion.mjs';

const list = value => Array.isArray(value) ? value : [];
const scope = view => JSON.stringify([view?.roomId, view?.matchId, view?.selfId, view?.selfRole]);

/** Animation follows newly accepted, lawfully visible entities. Other players'
 * private hand objects are never consulted, including by an all-seeing viewer. */
export function poker414MotionPlan(before, after) {
  if (!before || !after || scope(before) !== scope(after) || after.eventSeq !== before.eventSeq + 1
    || before.connection !== 'online' || after.connection !== 'online'
    || after.clockPaused || !['dealing', 'playing'].includes(before.phase)
    || !['dealing', 'playing', 'finished'].includes(after.phase)) return null;
  if (before.phase === 'dealing' && after.selfRole === 'player') {
    const old = new Set(list(before.hand).map(card => card.id));
    const ids = list(after.hand).filter(card => !old.has(card.id)).map(card => card.id);
    return ids.length ? { kind: 'deal', ids } : null;
  }
  const old = new Set(list(before.publicGroups).flatMap(group => list(group.cards).map(card => card.id)));
  const groups = list(after.publicGroups).map(group => ({ group, added: list(group.cards).filter(card => !old.has(card.id)) })).filter(item => item.added.length);
  if (groups.length !== 1) return null;
  const { group, added } = groups[0], pattern = classifyPattern(group.cards.map(card => card.id));
  const source = after.target?.rootId === group.id ? after.target.source : 'play';
  const kind = ['hook', 'fork'].includes(source) ? source : pattern?.kind === 'rocket' ? 'rocket' : pattern?.kind?.includes('bomb') ? 'bomb' : 'play';
  return { kind, ownerId: group.ownerId, ids: added.map(card => card.id), own: after.selfRole === 'player' && group.ownerId === after.selfId };
}

export function createPoker414Motion({ root, document = root.ownerDocument, window = document.defaultView }) {
  const motion = createObjectMotion({ root, document, window }), reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let cueTimer = null, cueAnimation = null, destroyed = false;
  const card = (area, id) => [...root.querySelectorAll(`#p414-${area} [data-card-id]`)].find(node => node.dataset.cardId === id);
  const cue = () => root.querySelector('#p414-effect');
  function cancel() {
    motion.cancel(); cueAnimation?.cancel(); cueAnimation = null; window.clearTimeout(cueTimer); cueTimer = null;
    if (cue()) { cue().textContent = ''; cue().removeAttribute('data-kind'); }
  }
  function capture(plan, before) {
    if (!plan || destroyed) return null;
    if (plan.kind !== 'deal') cancel();
    return { plan, sources: plan.ids.map(id => {
      if (plan.kind === 'deal') return motion.capture(root.querySelector('#p414-deck .p414-card'));
      if (plan.own && list(before.hand).some(item => item.id === id)) return motion.capture(card('hand', id));
      return null;
    }) };
  }
  function showCue(plan) {
    const label = ({ hook: '勾 +1', fork: '叉 +2', rocket: '火箭', bomb: '炸弹' })[plan.kind];
    if (!label || !cue()) return;
    window.clearTimeout(cueTimer); cueAnimation?.cancel();
    cue().textContent = label; cue().dataset.kind = plan.kind;
    if (!document.hidden && !reduced?.matches) cueAnimation = cue().animate?.([
      { transform: 'translateY(4px) scale(.96)', opacity: .4 }, { transform: 'translateY(0) scale(1)', opacity: 1 },
    ], { duration: 180, easing: 'ease-out' });
    cueTimer = window.setTimeout(() => { if (cue()) { cue().textContent = ''; cue().removeAttribute('data-kind'); } }, 1000);
  }
  function play(prepared) {
    if (!prepared || destroyed || document.hidden) return;
    const { plan, sources } = prepared;
    plan.ids.forEach((id, index) => {
      const area = plan.kind === 'deal' ? 'hand' : 'public', target = card(area, id);
      if (!target) return;
      let from = sources[index];
      // A newly public opponent face starts at its public seat. This never
      // captures or reconstructs an opponent hand.
      if (!from && plan.kind !== 'deal') {
        const seat = [...root.querySelectorAll('[data-player-id]')].find(node => node.dataset.playerId === plan.ownerId);
        const snapshot = motion.capture(target), rect = seat?.getBoundingClientRect();
        if (snapshot && rect?.width) from = { ...snapshot, rect: { x: rect.x + rect.width / 2 - snapshot.rect.width / 2, y: rect.y + rect.height / 2 - snapshot.rect.height / 2, width: snapshot.rect.width, height: snapshot.rect.height } };
      }
      if (from) void motion.move({ from, to: `#p414-${area} [data-card-id="${id}"]`, duration: plan.kind === 'deal' ? 150 : 240, delay: Math.min(70, index * 12), flip: plan.kind === 'deal' });
    });
    motion.sync(); showCue(plan);
  }
  const hidden = () => { if (document.hidden) cancel(); };
  document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', cancel); reduced?.addEventListener?.('change', cancel);
  return { capture, play, sync: () => motion.sync(), cancel,
    destroy() { destroyed = true; cancel(); motion.destroy(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', cancel); reduced?.removeEventListener?.('change', cancel); } };
}
