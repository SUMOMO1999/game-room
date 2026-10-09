import { GOODS, CARD_TYPES, RECIPES, createSampleDeck, CONTENT_VERSION } from './content.mjs';
import { ART_VERSION, mountArtFallback } from './art.mjs';
import { renderCard, renderCardBack, renderGoodsIcon, renderCardDetails } from './card-ui.mjs';
import { initializeGameTheme, GAME_THEMES } from '../../platform/game-theme.mjs';
import { gamePath } from '../../entry-path.mjs';

const deck = createSampleDeck();
// Put distinct faces first so reviewers see the complete vocabulary before copies.
const representatives = [
  deck.find(card => card.recipeId === 'ABC'), deck.find(card => card.recipeId === 'AABBCC'),
  ...CARD_TYPES.filter(type => type.kind !== 'goods-card').map(type => deck.find(card => card.kind === type.kind)),
];
const representativeIds = new Set(representatives.map(card => card.id));
const displayDeck = [...representatives, ...deck.filter(card => !representativeIds.has(card.id))];
const root = document.querySelector('#hyakki-catalog');
const theme = initializeGameTheme(document);
root.innerHTML = `<header class="catalog-heading"><div><p class="catalog-eyebrow">百鬼商会 / STEP 0</p><h1>百鬼夜市，开张在即。</h1><p>完整 120 张示例牌 · 12 种配方 · 5 种行动</p></div><a href="${gamePath('/hyakki-preview.html?enter=1')}">查看横屏牌桌 →</a></header>
  <section class="catalog-intro"><div><h2>一套资源，所有牌面</h2><p>以下为固定示例配方与价格，供检阅美术和文案。正式开局会另行随机并保存，不使用此示例发牌。当前尚未接入正式牌局。</p><p class="catalog-versions">${CONTENT_VERSION} · ${ART_VERSION}</p></div><div class="catalog-goods">${GOODS.map(good => `<div>${renderGoodsIcon(good.id)}<strong>${good.name}</strong><span>公库 ×20</span></div>`).join('')}</div></section>
  <nav class="catalog-filters" aria-label="图鉴筛选"><label>牌类<select id="catalog-type"><option value="all">全部 120 张</option>${CARD_TYPES.map(type => `<option value="${type.kind}">${type.name} · ${type.count} 张</option>`).join('')}</select></label><label>配方<select id="catalog-recipe"><option value="all">全部 12 种</option>${RECIPES.map(recipe => `<option value="${recipe.id}">${recipe.id} · ${recipe.total} 件</option>`).join('')}</select></label><label>桌布主题<select id="catalog-theme">${GAME_THEMES.map(item => `<option value="${item.id}">${item.name}</option>`).join('')}</select></label><button id="catalog-missing" type="button" aria-pressed="false">检查缺图阅读</button><strong id="catalog-count" role="status"></strong></nav>
  <section id="catalog-cards" class="catalog-cards" aria-label="完整示例牌"></section>
  <section class="catalog-states"><div><h2>同一张牌的状态</h2><p>选中有描边与文字；不可用仍可查看详情。所有暗牌共用同一牌背，不呈现牌种。</p></div><div>${renderCard(deck[0], { selected: true })}${renderCard(deck[0], { disabled: true })}${renderCardBack()}</div></section>
  <footer>牌面“力”即行动力 · 本地资源图鉴 · 不连接账号或正式房间 · 点击任意正面牌，查看完整规则</footer>
  <dialog class="catalog-detail"><header><h2>牌面说明</h2><button type="button" class="catalog-close" aria-label="关闭牌面说明">×</button></header><div id="catalog-detail-body"></div></dialog>`;
const typeSelect = root.querySelector('#catalog-type');
const recipeSelect = root.querySelector('#catalog-recipe');
const themeSelect = root.querySelector('#catalog-theme');
const missingButton = root.querySelector('#catalog-missing');
const detail = root.querySelector('.catalog-detail');
const stopFallback = mountArtFallback(root);
let missing = false;
function render() {
  const cards = displayDeck.filter(card => (typeSelect.value === 'all' || card.kind === typeSelect.value)
    && (recipeSelect.value === 'all' || card.recipeId === recipeSelect.value));
  root.querySelector('#catalog-cards').innerHTML = cards.map(card => `<article>${renderCard(card)}<small>${card.id.slice(-3)}${card.recipeId ? ` · ${card.recipeId}` : ' · 行动牌'}</small></article>`).join('');
  root.querySelector('#catalog-count').textContent = `显示 ${cards.length} / 120 张`;
}
typeSelect.addEventListener('change', () => { recipeSelect.value = 'all'; recipeSelect.disabled = !['all', 'goods-card'].includes(typeSelect.value); render(); });
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
render();
