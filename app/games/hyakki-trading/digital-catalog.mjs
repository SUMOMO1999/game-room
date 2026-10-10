import { CARDS, CATEGORIES, GOODS, getCard, getCategory } from './content/definitions.mjs';
import { mountArtFallback } from './content/manifest.mjs';
import { renderCard, renderCardDetails, renderCardBack, renderGoodsIcon } from './digital-card-ui.mjs';
import { initializeGameTheme, GAME_THEMES } from '../../platform/game-theme.mjs';
import { gamePath } from '../../entry-path.mjs';

const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const mounted = new WeakMap();
let nextDialogId = 0;

export function filterCards({ category = 'all', query = '' } = {}) {
  if (category !== 'all') getCategory(category);
  if (typeof query !== 'string') throw new TypeError('检索词须为文字');
  const terms = query.trim().toLocaleLowerCase('zh-CN').split(/\s+/u).filter(Boolean);
  return CARDS.filter(card => {
    if (category !== 'all' && card.category !== category) return false;
    const text = [card.id, card.sourceCode, card.name, getCategory(card.category).name, card.summary, card.costText, card.timingLabel, ...card.details].join(' ').toLocaleLowerCase('zh-CN');
    return terms.every(term => text.includes(term));
  });
}

/** The HTML entry owns mounting and disposal; importing this module does not start a page. */
export function mountDigitalCatalog(root) {
  if (!root?.ownerDocument || !root?.querySelector) throw new TypeError('图鉴需要页面根节点');
  mounted.get(root)?.();
  const documentRef = root.ownerDocument;
  const theme = initializeGameTheme(documentRef);
  const dialogId = `yousei-catalog-detail-${++nextDialogId}`;
  root.classList.add('yousei-catalog');
  root.innerHTML = `<header class="yousei-catalog__heading"><div><p class="yousei-catalog__eyebrow">幽街商人 · 数字版</p><h1>全卡图鉴</h1><p>51种牌面 · 110张牌 · 五类生意</p></div><a class="yousei-catalog__link" href="${gamePath('/hyakki-preview.html?enter=1')}">进入页面样板 →</a></header>
    <section class="yousei-catalog__intro"><div><h2>认清手里的每一张牌</h2><p>按牌名、编号、货物或效果查找，点牌查看完整用法。货物牌整组买卖；人物用后弃置；道具先安装，再按时机激活。</p><p class="yousei-catalog__note">当前为本地内容与页面样板；完整对局和独立练习尚未开放。牌面使用自制美术和归纳说明。</p></div><div class="yousei-catalog__stock" aria-label="数字版初始公共库存">${GOODS.map(good => `<span>${renderGoodsIcon(good.id)}<strong>${good.name}</strong><span>×${good.initialStock}</span></span>`).join('')}<small>数字版：每种6件，共36件</small></div></section>
    <nav class="yousei-catalog__filters" aria-label="图鉴筛选"><label>搜索牌面<input type="search" data-catalog-search placeholder="牌名、编号、货物或效果" maxlength="120" autocomplete="off"></label><label>牌类<select data-catalog-category><option value="all">全部 · 51种／110张</option>${CATEGORIES.map(category => { const cards = CARDS.filter(card => card.category === category.id); return `<option value="${category.id}">${category.name} · ${cards.length}种／${cards.reduce((sum, card) => sum + card.copies, 0)}张</option>`; }).join('')}</select></label><label>桌布主题<select data-catalog-theme>${GAME_THEMES.map(item => `<option value="${item.id}">${item.name}</option>`).join('')}</select></label><button type="button" data-catalog-missing aria-pressed="false">检查缺图阅读</button></nav>
    <div class="yousei-catalog__result"><strong data-catalog-count role="status" aria-live="polite"></strong><button type="button" data-catalog-reset>重置筛选</button></div>
    <section class="yousei-catalog__cards" data-catalog-cards aria-label="全部卡牌"></section>
    <section class="yousei-catalog__states"><div><h2>同名道具，各自使用</h2><p>选中有描边，横置有文字；当前不可用的牌也能点开阅读。暗牌全部使用同一个牌背。</p></div><div>${renderCard(getCard('yousei.t05'), { selected: true })}${renderCard(getCard('yousei.t05'), { tapped: true, disabled: true })}${renderCardBack()}</div></section>
    <footer class="yousei-catalog__footer">许可：全局首次买板6两，之后3两；共5块，每块增加3格。数字版裁定随版本固定。</footer>
    <dialog class="yousei-catalog__dialog" aria-labelledby="${dialogId}"><header><h2 id="${dialogId}">牌面说明</h2><button type="button" data-catalog-close aria-label="关闭牌面说明">×</button></header><div data-catalog-detail></div></dialog>`;
  const query = root.querySelector('[data-catalog-search]');
  const category = root.querySelector('[data-catalog-category]');
  const themeSelect = root.querySelector('[data-catalog-theme]');
  const missingButton = root.querySelector('[data-catalog-missing]');
  const dialog = root.querySelector('dialog');
  const removers = [];
  function listen(target, type, callback) {
    target.addEventListener(type, callback);
    removers.push(() => target.removeEventListener(type, callback));
  }
  function render() {
    const cards = filterCards({ category: category.value, query: query.value });
    root.querySelector('[data-catalog-count]').textContent = `显示${cards.length}种 · ${cards.reduce((sum, card) => sum + card.copies, 0)}张副本`;
    root.querySelector('[data-catalog-cards]').innerHTML = cards.length
      ? cards.map(card => `<article class="yousei-catalog__entry">${renderCard(card)}<p><strong>${escape(card.name)}</strong><span>${card.sourceCode} · 共${card.copies}张</span></p></article>`).join('')
      : '<p class="yousei-catalog__empty">没有符合条件的牌。试试较短的关键词，或重置筛选。</p>';
  }
  listen(query, 'input', render);
  listen(category, 'change', render);
  listen(root.querySelector('[data-catalog-reset]'), 'click', () => { query.value = ''; category.value = 'all'; render(); query.focus(); });
  themeSelect.value = theme?.current() ?? 'classic';
  listen(themeSelect, 'change', () => theme?.set(themeSelect.value));
  listen(missingButton, 'click', () => {
    const missing = root.classList.toggle('yousei-missing-art');
    missingButton.setAttribute('aria-pressed', String(missing));
  });
  listen(root, 'click', event => {
    const face = event.target.closest?.('button[data-card-id]');
    if (!face || !root.contains(face)) return;
    root.querySelector('[data-catalog-detail]').innerHTML = renderCardDetails(getCard(face.dataset.cardId));
    if (!dialog.open) dialog.showModal();
  });
  listen(root.querySelector('[data-catalog-close]'), 'click', () => dialog.close());
  const stopArtFallback = mountArtFallback(root);
  const dispose = () => {
    removers.forEach(remove => remove());
    stopArtFallback();
    if (dialog.open) dialog.close();
    if (mounted.get(root) === dispose) mounted.delete(root);
  };
  mounted.set(root, dispose);
  render();
  return dispose;
}
