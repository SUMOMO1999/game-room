import { createObjectMotion } from '../../platform/object-motion.mjs';

/** Both Army pages pass consecutive public projections after acceptance. */
export function mountArmyMotion({ root = document.body, document: doc = root.ownerDocument,
  window: win = doc.defaultView } = {}) {
  const motion = createObjectMotion({ root, document: doc, window: win, maxObjects: 6 });
  let frame = null, generation = 0;
  const timers = new Set(), badges = new Set();
  const cell = id => root.querySelector('[data-cell-id="' + id + '"]');
  const token = id => cell(id)?.querySelector('.army-piece');
  function cancel() {
    generation++; if (frame !== null) win.cancelAnimationFrame(frame); frame = null; motion.cancel();
    for (const timer of timers) win.clearTimeout(timer); timers.clear();
    for (const badge of badges) badge.remove(); badges.clear();
  }
  function prepare(previous, next, { baseline = false } = {}) {
    if (baseline || !previous?.game || previous.matchId !== next.matchId
      || previous.selfId !== next.selfId || previous.selfRole !== next.selfRole
      || !['playing', 'finished'].includes(next.phase)) { cancel(); return null; }
    if (next.game?.revision <= previous.game.revision) { motion.sync(); return null; }
    cancel();
    const action = next.game.lastAction;
    if (!action || !['flip', 'move', 'pickup'].includes(action.type)) return null;
    const id = action.cellId || action.to;
    const plan = { action, id, source: motion.capture(token(action.from || id)),
      defender: action.type === 'move' ? motion.capture(token(action.to)) : null };
    const beforeSource = previous.game.board.find(item => item.cellId === action.from)?.piece;
    const afterSource = next.game.board.find(item => item.cellId === action.from)?.piece;
    plan.stayed = action.type === 'move' && beforeSource && afterSource?.id === beforeSource.id;
    plan.survived = Boolean(next.game.board.find(item => item.cellId === action.to)?.piece?.id === beforeSource?.id && beforeSource);
    return plan;
  }
  function badge(id, text) {
    const target = cell(id); if (!target) return;
    const label = doc.createElement('span'); label.className = 'army-action-effect';
    label.textContent = text; label.setAttribute('aria-hidden', 'true'); target.append(label); badges.add(label);
    const timer = win.setTimeout(() => { label.remove(); badges.delete(label); timers.delete(timer); }, 850); timers.add(timer);
  }
  const resultNames = { capture: '吃子', 'attacker-lost': '碰撞·折损', mutual: '双方移除',
    'mine-sacrifice': '排雷·牺牲', flag: '夺旗', 'friendly-reveal': '同阵营',
    'protected-flag': '军旗受保护', 'ineligible-flag': '无法携旗' };
  function play(plan) {
    if (!plan) return;
    const stamp = generation;
    frame = win.requestAnimationFrame(async () => {
      frame = null; if (stamp !== generation || doc.hidden) return;
      const action = plan.action, targetCell = cell(plan.id); if (!targetCell) return;
      let task = Promise.resolve(false);
      if (action.type === 'flip' || plan.stayed) {
        task = motion.move({ from: plan.stayed ? plan.defender : plan.source,
          to: '[data-cell-id="' + plan.id + '"] .army-piece', duration: 80, flip: true });
      } else if (action.type === 'move' && plan.source) {
        const rect = targetCell.getBoundingClientRect(), size = plan.source.rect;
        const contact = { x: rect.x + (rect.width - size.width) / 2, y: rect.y + (rect.height - size.height) / 2,
          width: size.width, height: size.height };
        task = motion.move({ from: plan.source,
          to: plan.survived ? '[data-cell-id="' + plan.id + '"] .army-piece' : contact,
          duration: 260, fade: !plan.survived });
        if (plan.defender && action.outcome !== 'move') {
          const d = plan.defender.rect;
          void motion.move({ from: plan.defender, to: d, duration: 140, delay: 220, fade: true });
        }
      }
      await task; if (stamp !== generation || doc.hidden) return;
      if (resultNames[action.outcome]) badge(plan.id, resultNames[action.outcome]);
      for (const event of action.flagEvents || []) badge(event.cellId || plan.id,
        ({ pickup: '拾旗', drop: '掉旗', returned: '军旗归位', delivered: '送旗成功' })[event.type] || '军旗变化');
    });
  }
  const hidden = () => { if (doc.hidden) cancel(); };
  doc.addEventListener('visibilitychange', hidden); win.addEventListener('resize', cancel); win.addEventListener('pagehide', cancel);
  return { prepare, play, sync: () => motion.sync(), cancel,
    destroy() { cancel(); motion.destroy(); doc.removeEventListener('visibilitychange', hidden);
      win.removeEventListener('resize', cancel); win.removeEventListener('pagehide', cancel); } };
}
