import { getExpansionCard } from '../content/expansion-one.mjs';
import { getPublicOrder } from '../content/expansion-two.mjs';
import { matchingOrderCount } from '../configured/expansion-two-economy.mjs';
import { countGoods, findMaterials, resolveTradeMaterials } from '../trade-contract.mjs';

// A piece is useful only if the player can finish the whole sale from the stock left on the counter.
// Quantities of either quality satisfy the same recipe. Selection and payment stay with the game.
export function saleMaterials(player, draft) {
  if (!player?.goods || !draft) return null;
  const order = draft.orderId && getPublicOrder(draft.orderId);
  const recipe = draft.cardId && getExpansionCard(draft.cardId).recipe;
  const selected = {};
  const available = {};
  for (const [id, count] of Object.entries(player.goods)) {
    selected[id] = (draft.selection.ordinary?.[id] ?? 0) + (draft.selection.refined?.[id] ?? 0);
    available[id] = count - selected[id];
  }
  const left = (order?.count ?? recipe?.count ?? draft.limit) - countGoods(selected);
  const eligible = new Set();
  // A printed list has exactly one possible delivery, regardless of the size of the stall.
  const fixed = recipe?.type === 'fixed' ? recipe.goods : null;
  const fixedFits = fixed && Object.entries(fixed).every(([id, need]) => player.goods[id] >= need) &&
    Object.entries(selected).every(([id, n]) => n <= (fixed[id] ?? 0));
  for (const [id, count] of Object.entries(available)) {
    if (count <= 0 || left <= 0) continue;
    if (fixed) {
      if (!fixedFits || selected[id] >= (fixed[id] ?? 0)) continue;
    } else if (recipe || order) {
      const rest = { ...available, [id]: count - 1 };
      const complete = findMaterials(rest, left - 1, (extra) => {
        const bundle = { ...selected, [id]: selected[id] + 1 };
        for (const [good, n] of Object.entries(extra)) bundle[good] += n;
        return order ? matchingOrderCount(order, bundle) >= order.count - Number(!!draft.broker)
          : resolveTradeMaterials(draft.cardId, bundle);
      });
      if (!complete) continue;
    }
    eligible.add(id);
  }
  const gradeCount = (id, quality) => quality === 'refined'
    ? player.refined?.[id] ?? 0 : player.goods[id] - (player.refined?.[id] ?? 0);
  const taken = (id, quality) => draft.selection[quality]?.[id] ?? 0;
  return {
    quality: draft.quality, verb: order ? '可交货' : '可卖出', taken,
    canAdd: (id, quality) => eligible.has(id) && taken(id, quality) < gradeCount(id, quality)
  };
}

export function paintSaleMaterials(stock, form, hint) {
  const seen = new Map();
  const slots = [...stock.querySelectorAll('button[data-good]')];
  // The rules count identical pieces. Keep the particular copy the player tapped selected.
  slots.sort((a,b) => Number(b.classList.contains('m-good-picked')) - Number(a.classList.contains('m-good-picked')));
  stock.toggleAttribute('data-selecting-goods', !!hint);
  for (const slot of slots) {
    const { good, quality } = slot.dataset;
    const key = good + '/' + quality;
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const picked = !!hint && index < hint.taken(good, quality);
    const ready = !!hint && !picked && hint.canAdd(good, quality);
    slot.classList.toggle('m-good-ready', ready);
    slot.classList.toggle('m-good-picked', picked);
    slot.disabled = !!hint && !picked && !ready;
    if (hint) slot.setAttribute('aria-pressed', String(picked));
    else slot.removeAttribute('aria-pressed');
    slot.setAttribute('aria-label', slot.title + (picked ? '，已选，可撤回' : ready ? '，' + hint.verb : ''));
  }
  for (const row of form.querySelectorAll('.m-form article.hy-material-quantity')) {
    const id = row.dataset.materialGood;
    const ready = !!hint && hint.canAdd(id, hint.quality);
    row.classList.toggle('m-good-ready', ready);
    const plus = row.querySelector('button:last-of-type');
    if (hint && plus) plus.disabled = !ready;
  }
  for (const tab of form.querySelectorAll('.m-form [data-e2-command="quality"]')) {
    const { quality } = JSON.parse(tab.dataset.e2Fields);
    const ready = !!hint && slots.some(slot => slot.dataset.quality === quality && hint.canAdd(slot.dataset.good, quality));
    tab.classList.toggle('m-quality-ready', ready);
    tab.setAttribute('aria-label', tab.textContent.trim());
    tab.setAttribute('aria-description', ready ? '有符合条件的货物' : '');
  }
}

// Forward a physical piece to the same quality and quantity controls as the open choice.
export function pickSalePiece(tray, slot, hint) {
  if (!hint || slot.disabled) return;
  const { good, quality } = slot.dataset;
  if (quality !== hint.quality) {
    const tab = [...tray.querySelectorAll('[data-e2-command="quality"]')]
      .find(node => JSON.parse(node.dataset.e2Fields).quality === quality);
    if (!tab || tab.disabled) return;
    tab.click();
  }
  const delta = slot.classList.contains('m-good-picked') ? -1 : 1;
  const row = tray.querySelector('article[data-material-good="' + CSS.escape(good) + '"]');
  const control = [...(row?.querySelectorAll('button') ?? [])].find(node => {
    const data = JSON.parse(node.dataset.e2Fields ?? node.dataset.exFields ?? node.dataset.hyFields ?? '{}');
    return data.delta === delta && data.id === good;
  });
  if (control && !control.disabled) {
    slot.classList.toggle('m-good-picked', delta > 0);
    control.click();
  }
}
