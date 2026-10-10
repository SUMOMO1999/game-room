import { getCard, getGood, getCategory } from './content/definitions.mjs';
import { ART_VERSION, assetPath } from './content/manifest.mjs';

const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function definition(card) {
  if (typeof card === 'string') return getCard(card);
  if (!card || typeof card !== 'object') throw new TypeError('牌面需要已知的内容定义');
  return getCard(card.definitionId ?? card.id);
}

function picture(id, label, className = '') {
  // Dynamic hand replacements must paint their decoded face in the same frame.
  // Async decoding produced loaded-but-blank cards during local screenshot checks.
  return `<span class="yousei-art ${className}"><span class="yousei-art__fallback" aria-hidden="true">${escape(label)}</span><img loading="eager" src="${assetPath(id)}" data-yousei-art="${escape(id)}" alt="" draggable="false" decoding="sync"></span>`;
}

export function renderGoodsIcon(id) {
  const good = getGood(id);
  return `<span class="yousei-good-icon" aria-hidden="true">${picture(id, good.name.slice(0, 1))}</span>`;
}

export function renderCard(card, { selected = false, disabled = false, interactive = true, tapped = false } = {}) {
  const face = definition(card);
  for (const flag of [selected, disabled, interactive, tapped]) {
    if (typeof flag !== 'boolean') throw new TypeError('牌面显示状态必须为布尔值');
  }
  if (tapped && face.category !== 'tool') throw new RangeError('只有道具可以横置');
  const category = getCategory(face.category);
  const goods = face.category === 'goods';
  const watched = face.category === 'monitored_character';
  const goodsLabel = goods ? Object.entries(face.goods).map(([id,count]) => `${getGood(id).name}×${count}`).join('，') : '';
  const label = [face.name, category.name, goodsLabel, face.summary, face.costText, tapped ? '已横置' : '', selected ? '已选中' : '', disabled ? '当前不可使用，可查看说明' : ''].filter(Boolean).join('，');
  const tag = interactive ? 'button' : 'span';
  const semantics = interactive ? `type="button" aria-pressed="${selected}"` : 'role="img"';
  const body = goods
    ? `<span class="yousei-card__goods yousei-card__goods--${Object.keys(face.goods).length}">${Object.entries(face.goods).map(([id, count]) => `<span class="yousei-card__good" aria-label="${escape(getGood(id).name)}×${count}" title="${escape(getGood(id).name)}×${count}">${renderGoodsIcon(id)}<b>×${count}</b></span>`).join('')}</span>`
    : picture(face.artId, face.name, 'yousei-card__portrait');
  const faceCost = face.category === 'tool' ? '装1步 · 用1步' : face.category === 'stall_permit' ? '1步 · 扩摊3格' : ['ordinary_character','monitored_character'].includes(face.category) ? ['C04','C07'].includes(face.sourceCode) ? '回应 · 0步' : '行动 · 1步' : face.costText;
  const footer = goods
    ? `<span class="yousei-card__prices"><span>买<b>${face.buySilver}</b></span><span>卖<b>${face.sellSilver}</b></span></span>`
    : `<span class="yousei-card__cost">${escape(faceCost)}</span>`;
  const state = [selected ? '已选中' : '', tapped ? '已横置' : '', disabled ? '暂不可用' : ''].filter(Boolean).join(' · ');
  // Face IDs identify public definitions. Never serialize a private entity ID, owner, or deck order.
  return `<${tag} ${semantics} class="yousei-card${selected ? ' is-selected' : ''}${disabled ? ' is-unavailable' : ''}${tapped ? ' is-tapped' : ''}" data-card-id="${escape(face.id)}" data-card-category="${face.category}" data-art-version="${ART_VERSION}" aria-label="${escape(label)}"><span class="yousei-card__heading"><span class="yousei-card__category">${watched ? '◉ ' : ''}${escape(category.name)}</span><span class="yousei-card__code">${face.sourceCode}</span></span><span class="yousei-card__name">${goods ? '货物交易' : escape(face.name)}</span>${body}${footer}${state ? `<span class="yousei-card__state" aria-hidden="true">${escape(state)}</span>` : ''}</${tag}>`;
}

/** No card input is read: every hidden face produces exactly the same markup and asset URL. */
export function renderCardBack() {
  return `<span class="yousei-card yousei-card--back" role="img" aria-label="未公开的牌，统一牌背" data-art-version="${ART_VERSION}">${picture('card-back', '幽街商人', 'yousei-card__back-art')}<span class="yousei-card__back-label">未公开</span></span>`;
}

export function renderCardDetails(card) {
  const face = definition(card);
  const category = getCategory(face.category);
  return `<section class="yousei-card-details"><div class="yousei-card-details__face">${renderCard(face, { interactive: false })}</div><div class="yousei-card-details__copy"><p class="yousei-card-details__eyebrow">${escape(category.name)} · ${face.sourceCode} · 牌堆共${face.copies}张</p><h3>${escape(face.name)}</h3><p class="yousei-card-details__timing">${escape(face.timingLabel)}<br>${escape(face.costText)}</p><p class="yousei-card-details__summary">${escape(face.summary)}</p><ul>${face.details.map(text => `<li>${escape(text)}</li>`).join('')}</ul></div></section>`;
}
