import {renderExpansionPrint} from './expansion-card-ui.mjs';
import {GOODS as EXP_GOODS} from './presentation-content.mjs';
import {getExpansionCard,CATEGORIES as EXP_CLASSES} from './content/expansion-one.mjs';
import { getCard, getGood, getCategory } from './presentation-content.mjs';
import { ART_VERSION, assetPath } from './content/manifest.mjs';

const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function definition(card,configuration=null) {
  if (typeof card === 'string') return getCard(card,configuration);
  if (!card || typeof card !== 'object') throw new TypeError('牌面需要已知的内容定义');
  return getCard(card.definitionId ?? card.id,configuration);
}

function picture(id, label, className = '') {
  // Dynamic hand replacements must paint their decoded face in the same frame.
  // Async decoding produced loaded-but-blank cards during local screenshot checks.
  return `<span class="yousei-art ${className}"><span class="yousei-art__fallback" aria-hidden="true">${escape(label)}</span><img loading="eager" src="${assetPath(id)}" data-yousei-art="${escape(id)}" alt="" draggable="false" decoding="sync"></span>`;
}

export function renderGoodsIcon(id) {
  const good = getGood(id);
  return `<span class="yousei-good-icon" data-goods-icon="${escape(good.id)}" aria-hidden="true"><span class="yousei-art"><img src=".${escape(good.icon)}" alt="" draggable="false" decoding="sync"></span></span>`;
}

export function renderCard(card, { selected = false, disabled = false, interactive = true, tapped = false,configuration=null } = {}) {
  const face = definition(card,configuration);
  for (const flag of [selected, disabled, interactive, tapped]) {
    if (typeof flag !== 'boolean') throw new TypeError('牌面显示状态必须为布尔值');
  }
  if (tapped && face.category !== 'tool') throw new RangeError('只有道具可以横置');
  const original=!/^(X|E2)/.test(face.sourceCode)&&face.category!=='role';
  const print=original?getExpansionCard(face.id):face;
  const artwork=original&&face.artId?assetPath(face.artId):print.artPath;
  const footerLabel=face.category==='stall_permit'?'1步 · 扩摊3格':['C04','C07'].includes(face.sourceCode)?'回应 · 0步':undefined;
  const contents=renderExpansionPrint({...print,artPath:artwork},{goods:EXP_GOODS,classes:EXP_CLASSES,footerLabel,wrap:false});
  const tag=interactive?'button':'span';
  const semantics=interactive?`type="button" aria-pressed="${selected}"`:'role="img"';
  const label=[face.name,face.summary,face.costText,tapped?'已横置':'',disabled?'暂不可用':''].filter(Boolean).join('，');
  return `<${tag} ${semantics} class="yousei-card ex-new-card${selected?' is-selected':''}${disabled?' is-unavailable':''}${tapped?' is-tapped':''}" data-card-id="${escape(face.id)}" data-card-category="${escape(face.category)}" aria-label="${escape(label)}">${contents}</${tag}>`;
}

/** No card input is read: every hidden face produces exactly the same markup and asset URL. */
export function renderCardBack() {
  return `<span class="yousei-card yousei-card--back" role="img" aria-label="未公开的牌，统一牌背" data-art-version="${ART_VERSION}">${picture('card-back', '幽街商人', 'yousei-card__back-art')}<span class="yousei-card__back-label">未公开</span></span>`;
}

export function renderCardDetails(card,{configuration=null}={}) {
  const face = definition(card,configuration);
  const category = getCategory(face.category);
  const example = face.example ? `<p><strong>使用例子</strong><br>${escape(face.example)}</p>` : '';
  return `<section class="yousei-card-details"><div class="yousei-card-details__face">${renderCard(face, { interactive: false,configuration })}</div><div class="yousei-card-details__copy"><p class="yousei-card-details__eyebrow">${escape(category.name)} · ${face.sourceCode} · 牌堆共${face.copies}张</p><h3>${escape(face.name)}</h3>${example}<p class="yousei-card-details__timing">${escape(face.timingLabel)}<br>${escape(face.costText)}</p><p class="yousei-card-details__summary">${escape(face.summary)}</p><ul>${face.details.map(text => `<li>${escape(text)}</li>`).join('')}</ul></div></section>`;
}
