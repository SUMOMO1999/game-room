import { getGood, getCardType, describeGoods } from './content.mjs';
import { ART_VERSION, assetPath } from './art.mjs';

const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function picture(id, className) {
  return `<img class="${className}" data-hyakki-art="${id}" src="${assetPath(id)}" alt="" draggable="false" decoding="async">`;
}

export function renderGoodsIcon(id) {
  getGood(id);
  return `<span class="hyakki-good-icon" aria-hidden="true">${picture(id, 'hyakki-good-image')}</span>`;
}

function validateCard(card) {
  if (!card || typeof card !== 'object' || typeof card.id !== 'string' || !card.id
      || !Array.isArray(card.details) || !card.details.every(text => typeof text === 'string')) {
    throw new TypeError('牌面需要明确的定义、编号与规则文字');
  }
  const type = getCardType(card.typeId);
  if (type.kind !== card.kind) throw new RangeError('牌面类型不一致');
  if (card.kind === 'goods-card') {
    describeGoods(card.goods);
    if (![3, 4, 5].includes(card.buyPrice) || ![11, 12, 13].includes(card.sellPrice)) {
      throw new RangeError('牌面基础买卖价格不正确');
    }
  }
  return type;
}

export function renderCard(card, { selected = false, disabled = false, interactive = true } = {}) {
  const type = validateCard(card);
  for (const flag of [selected, disabled, interactive]) if (typeof flag !== 'boolean') throw new TypeError('牌面状态必须为布尔值');
  const goods = card.kind === 'goods-card';
  const label = `${type.name}，${goods ? `${describeGoods(card.goods)}，买 ${card.buyPrice} 两，卖 ${card.sellPrice} 两` : `${type.costText}，${type.shortText}`}${selected ? '，已选中' : ''}${disabled ? '，当前不可使用，可查看说明' : ''}`;
  const tag = interactive ? 'button' : 'span';
  // Disabled means unavailable for play, not unreadable: details remain reachable.
  const semantics = interactive ? `type="button" aria-pressed="${selected}"` : 'role="img"';
  const body = goods
    ? `<span class="hyakki-card__goods">${card.goods.map(item => `<span class="hyakki-card__good">${renderGoodsIcon(item.id)}<span>${escape(getGood(item.id).name)}</span><b>×${item.count}</b></span>`).join('')}</span>`
    : `<span class="hyakki-card__illustration">${picture(card.kind, 'hyakki-action-image')}</span>`;
  const footer = goods
    ? `<span class="hyakki-card__prices"><span>买 <b>${card.buyPrice}</b></span><span>卖 <b>${card.sellPrice}</b></span></span>`
    : `<span class="hyakki-card__effect">${escape(type.compactText)}</span><span class="hyakki-card__cost">${escape(type.compactCost)}</span>`;
  return `<${tag} ${semantics} class="hyakki-card${selected ? ' is-selected' : ''}${disabled ? ' is-unavailable' : ''}" data-card-id="${escape(card.id)}" data-card-kind="${card.kind}" data-art-version="${ART_VERSION}" aria-label="${escape(label)}"><span class="hyakki-card__name">${escape(type.name)}</span>${body}${footer}<span class="hyakki-card__state" aria-hidden="true">${selected ? '已选中' : disabled ? '暂不可用' : ''}</span></${tag}>`;
}

/** Deliberately accepts no face/id: every hidden card has identical DOM and URL. */
export function renderCardBack() {
  return `<span class="hyakki-card hyakki-card--back" role="img" aria-label="未公开的牌，统一牌背" data-art-version="${ART_VERSION}">${picture('card-back', 'hyakki-back-image')}<span class="hyakki-card__back-label">未公开</span></span>`;
}

export function renderCardDetails(card) {
  const type = validateCard(card);
  return `<section class="hyakki-card-details"><div class="hyakki-card-details__face">${renderCard(card, { interactive: false })}</div><div><h3>${escape(type.name)}</h3><p class="hyakki-card-details__timing">${escape(type.timingLabel)} · ${escape(type.costText)}</p><ul>${card.details.map(text => `<li>${escape(text)}</li>`).join('')}</ul></div></section>`;
}
