import { getDefinition } from './content/catalog.mjs';
import { getAsset } from './content/asset-manifest.mjs';
import { getSymbolSvg } from './content/vector-art.mjs';
import { gamePath } from '../../entry-path.mjs';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
export const RESOURCE_NAMES = Object.freeze({ mountain:'山岳',forest:'森林',sun:'阳光',water:'水滴',wildlife:'野生动物' });
export function resourceIcon(id) { return `<span class="pk-resource-icon" aria-hidden="true">${getSymbolSvg(id, { size:24 })}</span>`; }
export function resourceLine(resources = {}) {
  return Object.entries(resources).filter(([id, count]) => RESOURCE_NAMES[id] && count > 0).map(([id, count]) => `<span class="pk-resource" aria-label="${RESOURCE_NAMES[id]}${count}">${resourceIcon(id)}<b>${count}</b></span>`).join('');
}
export function cardName(card) { return card.nameZh || card.name || card.id; }
export function cardCost(card) { return card.cost || (Number.isInteger(card.sunCost) ? {sun:card.sunCost} : null); }
export function cardText(card) { return Array.isArray(card.detailText) ? card.detailText.join('；') : card.detailText || card.shortText || ''; }
export function renderArtwork(asset, { thumbnail = false } = {}) {
  if (asset?.status !== 'ready') return '';
  const file = thumbnail ? asset.thumbnailPath || asset.path : asset.atlasPath || asset.path;
  const rect = thumbnail ? asset.thumbnailCropRect || asset.cropRect : asset.cropRect;
  const size = thumbnail ? asset.thumbnailSize || asset.atlasSize : asset.atlasSize;
  if (asset.renderer === 'atlas') {
    if (!file || !rect || !size || ![rect.x,rect.y,rect.width,rect.height,size.width,size.height].every(Number.isFinite)
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > size.width || rect.y + rect.height > size.height) {
      throw new TypeError('插画图集映射无效。');
    }
    const fit = asset.kind === 'gear' ? 'meet' : 'slice';
    // The inner viewport clips the atlas region independently. With "meet", the
    // outer letterbox must not reveal neighboring cells outside the viewBox.
    return `<svg class="pk-atlas-art" viewBox="${rect.x} ${rect.y} ${rect.width} ${rect.height}" preserveAspectRatio="xMidYMid ${fit}" aria-hidden="true"><svg class="pk-atlas-window" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" viewBox="0 0 ${rect.width} ${rect.height}" preserveAspectRatio="none" overflow="hidden"><image href="${escapeHtml(gamePath(file))}" x="${-rect.x}" y="${-rect.y}" width="${size.width}" height="${size.height}" preserveAspectRatio="none" /></svg></svg>`;
  }
  return file ? `<img src="${escapeHtml(gamePath(file))}" alt="" loading="lazy" decoding="async" draggable="false">` : '';
}
export function renderCard(id, { selected = false, interactive = true, missing = false, thumbnail = false } = {}) {
  const card = getDefinition(id), asset = getAsset(id), name = cardName(card), cost = cardCost(card);
  const summary = card.kind === 'park' ? card.effectText : card.shortText || cardText(card);
  const accessibleLabel = [name, Number.isInteger(card.points) ? `${card.points}分` : '', cost ? card.costText : '', summary].filter(Boolean).join('，');
  const art = !missing && asset?.status==='ready' ? renderArtwork(asset,{thumbnail}) : asset?.status==='svg' ? `<span class="pk-vector-art">${(asset.symbols||[]).slice(0,3).map(id=>getSymbolSvg(id,{size:48})).join('')}</span>` : '';
  const tag = interactive ? 'button' : 'article';
  return `<${tag} class="pk-card${selected?' is-selected':''}" ${interactive?`type="button" data-card-id="${escapeHtml(id)}" aria-pressed="${selected}"`:''} aria-label="${escapeHtml(accessibleLabel)}">
    <span class="pk-art${card.kind==='gear'?' pk-art--gear':''}${art?'':' is-fallback'}"><span class="pk-art-fallback">${escapeHtml(name)}<small>${missing?'插画未能加载':'规则图示'}</small></span>${art}</span>
    <span class="pk-card-name">${escapeHtml(name)}</span>
    ${cost || Number.isInteger(card.points) ? `<span class="pk-card-bottom">${cost ? resourceLine(cost) : ''}${Number.isInteger(card.points)?`<strong class="pk-points">${card.points}<small>分</small></strong>`:''}</span>` : ''}
    <span class="pk-card-effect"><span class="pk-card-text">${escapeHtml(summary)}</span></span>
  </${tag}>`;
}
export function renderDetail(id, options = {}) {
  const card = getDefinition(id);
  return `<div class="pk-card-detail">${renderCard(id,{interactive:false,...options})}<div><p class="pk-kicker">${escapeHtml(card.kind)} · ${escapeHtml(card.id)}</p><h3>${escapeHtml(cardName(card))}</h3><p>${escapeHtml(cardText(card))}</p>${cardCost(card)?`<p class="pk-detail-cost">需要 ${resourceLine(cardCost(card))}</p>`:''}${Number.isInteger(card.points)?`<p>游览得分：<strong>${card.points}</strong></p>`:''}</div></div>`;
}
/** A missing file must never remove the card's actual cost, identity or text. */
export function mountImageFallback(root) {
  const failed = event => {
    if (!event.target?.matches?.('.pk-art img,.pk-art image')) return;
    const frame=event.target.closest('.pk-art'); frame.classList.add('is-fallback');
    const artwork=frame.querySelector('img,.pk-atlas-art'); if(artwork)artwork.style.display='none';
    frame.querySelector('small').textContent='插画未能加载';
  };
  root.addEventListener('error',failed,true);
  return () => root.removeEventListener('error',failed,true);
}
