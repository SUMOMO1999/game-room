import { GOODS, getCard } from './content/definitions.mjs';
import { assetPath } from './content/manifest.mjs';
import { renderGoodsIcon } from './digital-card-ui.mjs';
import { cardKey } from './game-ui-model.mjs';

export const dialogEscape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const esc = dialogEscape;
export const DIALOG_PAGE_SIZE = 6;

/** Pagination changes presentation only; original indexes remain the submitted choices. */
export function dialogPage(items, page = 0) {
  const pages = Math.max(1, Math.ceil(items.length / DIALOG_PAGE_SIZE));
  const current = Math.min(pages - 1, Math.max(0, Number.isSafeInteger(page) ? page : 0));
  const start = current * DIALOG_PAGE_SIZE;
  return { items: items.slice(start, start + DIALOG_PAGE_SIZE), start, current, pages, total: items.length };
}

export function renderDialogPager(page, action = 'choice-page') {
  if (page.pages === 1) return '';
  const button = (label, number, disabled) => `<button type="button" data-hy-action="${action}" data-hy-fields="${esc(JSON.stringify({page:number}))}" ${disabled?'disabled':''}>${label}</button>`;
  return `<nav class="hy-dialog-pager" aria-label="候选分页">${button('上一页',page.current-1,page.current===0)}<span>第${page.current+1}/${page.pages}页 · 共${page.total}项</span>${button('下一页',page.current+1,page.current===page.pages-1)}</nav>`;
}

/** Small decision faces retain identity, goods quantities and price; full rules are one action away. */
export function renderCompactCard(card, { readButton = true, inline = false } = {}) {
  const face = getCard(card.definitionId ?? card.id), key = cardKey(card);
  const art = face.category === 'goods'
    ? `<span class="hy-compact-goods">${Object.entries(face.goods).map(([id,count])=>`<span title="${esc(GOODS.find(good=>good.id===id).name)}">${renderGoodsIcon(id)}<b>×${count}</b></span>`).join('')}</span>`
    : `<span class="hy-compact-art"><img src="${assetPath(face.artId)}" alt="" draggable="false" decoding="sync"></span>`;
  return `<span class="hy-compact-face" aria-label="${esc(face.name)}" data-definition-id="${esc(face.id)}"><strong>${esc(face.category==='goods'?(inline?'货物交易':face.sourceCode):face.name)}</strong>${art}<small>${face.category==='goods'?`买${face.buySilver} · 卖${face.sellSilver}两`:esc(face.sourceCode)}</small></span>${readButton?`<button type="button" data-hy-detail="${esc(key)}" aria-label="阅读${esc(face.name)}完整牌文">完整牌文</button>`:''}`;
}

export function renderCompactCards(cards, pageNumber = 0) {
  const page = dialogPage(cards,pageNumber);
  return `<div class="hy-compact-cards" style="--hy-card-count:${Math.max(1,page.items.length)}">${page.items.map(card=>`<article>${renderCompactCard(card)}</article>`).join('')}</div>${renderDialogPager(page,'cards-page')}`;
}

/** Header, scrollable reading area and actions have separate height ownership. */
export function renderDialogBody(content, actions = '', { formId = null } = {}) {
  const inner = `<div class="hy-dialog-content">${content}</div>${actions?`<div class="hy-dialog-footer">${actions}</div>`:''}`;
  return formId ? `<form id="${formId}" class="hy-dialog-layout">${inner}</form>` : `<div class="hy-dialog-layout">${inner}</div>`;
}
