import { GOODS, CARD_TYPES, RECIPES, createSampleDeck, CONTENT_VERSION } from './content.mjs';
import { REFERENCE_CATEGORIES, REFERENCE_UNRESOLVED, DRAFT_CATEGORIES, draftCategory } from './reference-content.mjs';
import { ART_VERSION, mountArtFallback, assetPath } from './art.mjs';
import { renderCard, renderCardBack, renderGoodsIcon, renderCardDetails } from './card-ui.mjs';
import { initializeGameTheme, GAME_THEMES } from '../../platform/game-theme.mjs';
import { gamePath } from '../../entry-path.mjs';

const deck = createSampleDeck();
const representatives = [deck.find(card => card.recipeId === 'ABC'), deck.find(card => card.recipeId === 'AABBCC'),
  ...CARD_TYPES.filter(type => type.kind !== 'goods-card').map(type => deck.find(card => card.kind === type.kind))];
const representativeIds = new Set(representatives.map(card => card.id));
const displayDeck = [...representatives, ...deck.filter(card => !representativeIds.has(card.id))];
const root = document.querySelector('#hyakki-catalog');
const theme = initializeGameTheme(document);
root.innerHTML = `<header class="catalog-heading"><div><p class="catalog-eyebrow">百鬼商会 / 分类实验版</p><h1>先认牌类，再看牌面。</h1><p>货物 · 摊位许可 · 人物 · 道具</p></div><a href="${gamePath('/hyakki-preview.html?enter=1')}">查看摊位与道具区 →</a></header>
  <section class="catalog-reference-intro"><h2>四个大类，不再把牌名当分类</h2><p>按你提供的商品截图整理。下列张数是该盒配件数量，不代表不同牌种数；具体牌面还在补充。示意图沿用自制资源，没有复制商品卡图。</p><p>${REFERENCE_UNRESOLVED}</p><p>截图的“抽看牌＋公用行动条”与旧稿个人行动力尚未统一，本页先确认分类与分区。</p></section>
  <nav class="catalog-reference-filter" aria-label="参考大类筛选"><label>大类<select id="reference-category"><option value="all">全部四类</option>${REFERENCE_CATEGORIES.map(type => `<option value="${type.id}">${type.name}</option>`).join('')}</select></label><label>桌布主题<select id="catalog-theme">${GAME_THEMES.map(item => `<option value="${item.id}">${item.name}</option>`).join('')}</select></label></nav>
  <section class="catalog-reference-grid" aria-label="截图确认的四类牌">${REFERENCE_CATEGORIES.map(category => `<article class="catalog-reference" data-reference-category="${category.id}"><header><h2>${category.name}</h2><span>${category.quantity}</span></header><div class="catalog-reference-body"><div class="catalog-reference-face" aria-label="${category.example}，牌面待补">${referenceArt(category.id)}<strong>${category.example}</strong><small>牌面待补 · 分类示意</small></div><div><p class="catalog-zone">${category.zone}</p><p>${category.summary}</p><p class="catalog-pending"><strong>还需确认</strong><br>${category.missing}</p></div></div></article>`).join('')}</section>
  <section class="catalog-zones"><h2>牌桌上的四块地方</h2><div><article><strong>公共市场</strong><p>大家共用的货物库存。</p></article><article><strong>我的摊位</strong><p>已买到的实际货物、占用与空位。</p></article><article><strong>我的道具区</strong><p>已放置的道具及本回合状态。</p></article><article><strong>我的手牌</strong><p>未打出的牌，仅自己可见。</p></article></div></section>
  <details class="catalog-draft"><summary>朋友稿已有示例 · 120 张副本（非实体版完整卡库）</summary>
    <section class="catalog-intro"><div><h2>保留旧稿，便于对照</h2><p>此处是旧稿的 12 种货物配方与五个效果定义，含重复牌；价格和效果只属于旧稿实验基线。护身符在旧稿属于反应行动牌；与实体版的对应关系待核。</p><p class="catalog-versions">${CONTENT_VERSION} · ${ART_VERSION}</p></div><div class="catalog-goods">${GOODS.map(good => `<div>${renderGoodsIcon(good.id)}<strong>${good.name}</strong><span>旧稿公库 ×20</span></div>`).join('')}</div></section>
    <nav class="catalog-filters" aria-label="朋友稿筛选"><label>大类<select id="catalog-category"><option value="all">全部旧稿大类</option>${DRAFT_CATEGORIES.map(type => `<option value="${type.id}">${type.name}</option>`).join('')}</select></label><label>具体牌种<select id="catalog-type"></select></label><label>配方<select id="catalog-recipe"><option value="all">全部 12 种</option>${RECIPES.map(recipe => `<option value="${recipe.id}">${recipe.id} · ${recipe.total} 件</option>`).join('')}</select></label><button id="catalog-missing" type="button" aria-pressed="false">检查缺图阅读</button><strong id="catalog-count" role="status"></strong></nav>
    <section id="catalog-cards" class="catalog-cards" aria-label="朋友稿示例牌"></section>
    <section class="catalog-states"><div><h2>同一张牌的状态</h2><p>选中有描边与文字；不可用仍可查看详情。暗牌共用牌背。</p></div><div>${renderCard(deck[0], { selected: true })}${renderCard(deck[0], { disabled: true })}${renderCardBack()}</div></section>
  </details>
  <footer>本地分类与布局实验 · 未接入正式牌局 · 完整卡牌和原版规则待补</footer>
  <dialog class="catalog-detail"><header><h2>朋友稿 · 牌面说明</h2><button type="button" class="catalog-close" aria-label="关闭牌面说明">×</button></header><div id="catalog-detail-body"></div></dialog>`;

function referenceArt(id) {
  if (id === 'goods') return `<div class="catalog-reference-goods">${GOODS.slice(0, 3).map(good => renderGoodsIcon(good.id)).join('')}</div>`;
  if (id === 'permit') return `<img class="catalog-reference-permit" data-hyakki-art="stall-permit" src="${assetPath('stall-permit')}" alt="自制许可插画示意">`;
  // Deliberately neutral diagrams: no invented character/item artwork or effects.
  const shape = id === 'character'
    ? '<circle cx="48" cy="28" r="12"/><path d="M23 76v-9a25 25 0 0 1 50 0v9"/>'
    : '<path d="M26 34h44l-5 34H31zM22 34h52M35 24h26M48 24v-7M30 45H17v13h16M66 45h13v13H63M34 68l-4 9M62 68l4 9"/>';
  return `<svg class="catalog-reference-symbol" viewBox="0 0 96 96" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
}
const categorySelect = root.querySelector('#catalog-category');
const typeSelect = root.querySelector('#catalog-type');
const recipeSelect = root.querySelector('#catalog-recipe');
const themeSelect = root.querySelector('#catalog-theme');
const missingButton = root.querySelector('#catalog-missing');
const detail = root.querySelector('.catalog-detail');
const stopFallback = mountArtFallback(root);
let missing = false;
function render() {
  const cards = displayDeck.filter(card => (categorySelect.value === 'all' || draftCategory(card.kind) === categorySelect.value)
    && (typeSelect.value === 'all' || card.kind === typeSelect.value)
    && (recipeSelect.value === 'all' || card.recipeId === recipeSelect.value));
  root.querySelector('#catalog-cards').innerHTML = cards.map(card => `<article>${renderCard(card)}<small>旧稿 ${card.id.slice(-3)}${card.recipeId ? ` · ${card.recipeId}` : ''}</small></article>`).join('');
  root.querySelector('#catalog-count').textContent = `旧稿显示 ${cards.length} / 120 张副本`;
}
function syncTypes() {
  const types = CARD_TYPES.filter(type => categorySelect.value === 'all' || draftCategory(type.kind) === categorySelect.value);
  typeSelect.innerHTML = `<option value="all">全部牌种</option>${types.map(type => `<option value="${type.kind}">${type.name} · ${type.count} 张</option>`).join('')}`;
  recipeSelect.value = 'all'; syncRecipe(); render();
}
function syncRecipe() {
  recipeSelect.disabled = !['all', 'goods'].includes(categorySelect.value) || !['all', 'goods-card'].includes(typeSelect.value);
}
root.querySelector('#reference-category').addEventListener('change', event => {
  for (const panel of root.querySelectorAll('[data-reference-category]')) panel.hidden = event.target.value !== 'all' && event.target.value !== panel.dataset.referenceCategory;
});
categorySelect.addEventListener('change', syncTypes);
typeSelect.addEventListener('change', () => { recipeSelect.value = 'all'; syncRecipe(); render(); });
recipeSelect.addEventListener('change', render);
themeSelect.value = theme.current();
themeSelect.addEventListener('change', () => theme.set(themeSelect.value));
missingButton.addEventListener('click', () => { missing = !missing; root.classList.toggle('catalog-missing-art', missing); missingButton.setAttribute('aria-pressed', String(missing)); });
root.addEventListener('click', event => {
  const face = event.target.closest('button[data-card-id]');
  if (!face) return;
  const card = deck.find(item => item.id === face.dataset.cardId);
  if (!card) return;
  root.querySelector('#catalog-detail-body').innerHTML = renderCardDetails(card);
  detail.showModal();
});
root.querySelector('.catalog-close').addEventListener('click', () => detail.close());
window.addEventListener('pagehide', stopFallback, { once: true });
syncTypes();
