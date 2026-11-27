import { cast, cardName, items, suitMark, rankMark, itemDescription } from './rules/catalog.mjs';
import { itemHint } from './display-copy.mjs';
export const el = (id) => document.getElementById(id);
export const esc = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export const button = (label, act, value = '', cls = '', disabled = false) =>
  '<button type="button" class="' +
  esc(cls) +
  '" data-act="' +
  act +
  '" data-val="' +
  esc(value) +
  '"' +
  (disabled ? ' disabled' : '') +
  '>' +
  esc(label) +
  '</button>';
export function paint(id, html = '') {
  const n = el(id);
  if (n._last !== html) {
    n.innerHTML = html;
    n._last = html;
  }
  n.hidden = !html;
}
export const tierColor = (t) => ['', '#bfd1b0', '#93c8df', '#d7a4ed'][t];
export const gem = (id) =>
  '<span class="gem' +
  (items[id].kind === 'tool' ? ' disposable' : '') +
  '" aria-hidden="true" style="--tier:' +
  tierColor(items[id].tier) +
  '">' +
  '<img draggable="false" alt="" src="./assets/emblems/' +
  (items[id].icon || id) +
  '.png">' +
  (items[id].aim === 'receive'
    ? '<b class="pouchValue">+' + (items[id].silver || items[id].gold) + '</b>'
    : '') +
  '</span>';
export function face(c, { action = '', sel = false, badge = '', css = '', label = '' } = {}) {
  const description = esc((label ? label + ' ' : '') + cardName(c));
  const art = '<img draggable="false" alt="" src="./assets/cards/' + c.suit + c.rank + '.webp">' +
    (badge ? '<span class="badge">' + esc(badge) + '</span>' : '');
  if (!action) return '<span role="img" aria-label="' + description + '" class="face ' +
    esc(css) + (sel ? ' selected' : '') + '">' + art + '</span>';
  return (
    '<button type="button" class="face ' +
    (sel ? 'selected ' : '') +
    css +
    '" data-act="' +
    action +
    '" data-val="' +
    esc(c.id) +
    '" aria-label="' +
    description +
    '" aria-pressed="' +
    sel +
    '">' + art +
    '</button>'
  );
}
export function loot(id, sel, act, version, scoreOnly, tag = '') {
  const x = items[id];
  const hint = itemHint(id, version);
  return (
    '<button type="button" data-act="' +
    act +
    '" data-val="' +
    id +
    '" class="loot ' +
    (sel ? 'sel' : '') +
    '" style="--tier:' +
    tierColor(x.tier) +
    '"' + (act === 'selectLoot' ? ' aria-pressed="' + sel + '"' : '') + ' aria-label="' +
    esc(x.name + '，' + hint + (tag ? '，' + tag : '')) +
    '" title="' +
    esc(itemDescription(id, version, scoreOnly)) +
    '">' +
    '<span class="lootFace">' + gem(id) +
    '<b>' +
    esc(x.name) +
    '</b><small class="lootEffect">' + esc(hint) + '</small>' +
    (tag ? '<span class="lootTag">' + esc(tag) + '</span>' : '') + '</span></button>'
  );
}
export function actor(p) {
  return cast.find((c) => c.id === p.ego) || cast[0];
}
export function cleanPrefs() {
  try {
    return JSON.parse(localStorage.getItem('olh:pref:1')) || {};
  } catch {
    return {};
  }
}
export function saveObj(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}
export function getObj(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
export function unique() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export function notify(text) {
  clearTimeout(notify.timer);
  el('notice').textContent = text;
  el('notice').hidden = false;
  notify.timer = setTimeout(() => (el('notice').hidden = true), 2550);
}
export function dialog(title, content) {
  closeDetail();
  const d = el('sheet');
  d.querySelector('h2').textContent = title;
  el('sheetBody').innerHTML = content;
  if (!d.open) d.showModal();
}
// Follow the point touched on the owner, as the 三国杀 character introduction does.
let openedDetail, lastPointer, detailFrame = 0;
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
function placeDetail() {
  detailFrame = 0;
  if (!openedDetail) return;
  const state = openedDetail;
  const bubble = el('detailBubble');
  if (!state.owner.isConnected && state.selector) {
    state.owner = document.querySelector(state.selector) || state.owner;
    if (state.owner.isConnected) state.owner.setAttribute('aria-expanded', 'true');
  }
  const source = state.owner.getBoundingClientRect();
  if (!source.width || !source.height) { closeDetail(); return; }
  const board = el('tableViewport').getBoundingClientRect();
  const vv = window.visualViewport;
  const margin = 9, gap = 9;
  const left = Math.max(board.left, vv?.offsetLeft || 0) + margin;
  const top = Math.max(board.top, vv?.offsetTop || 0) + margin;
  const right = Math.min(board.right, vv ? vv.offsetLeft + vv.width : innerWidth) - margin;
  const bottom = Math.min(board.bottom, vv ? vv.offsetTop + vv.height : innerHeight) - margin;
  const x = clamp(source.left + source.width * state.x, left, right);
  const y = clamp(source.top + source.height * state.y, top, bottom);
  const wide = right - left;
  const sideRoom = Math.max(x - left, right - x) - gap;
  const side = sideRoom >= Math.min(215, wide * 0.8);
  bubble.style.width = Math.min(340, wide, side ? sideRoom : wide * 0.92) + 'px';
  const below = bottom - y >= y - top;
  const maxHeight = side ? bottom - top : (below ? bottom - y : y - top) - gap;
  bubble.style.maxHeight = Math.floor(Math.min(bottom - top, maxHeight, Math.max(150, (bottom - top) * 0.66))) + 'px';
  const w = bubble.offsetWidth, h = bubble.offsetHeight;
  const onRight = right - x >= x - left;
  const bx = clamp(side ? (onRight ? x + gap : x - w - gap) : x - w / 2, left, right - w);
  const by = clamp(side ? y - h / 2 : (below ? y + gap : y - h - gap), top, bottom - h);
  bubble.style.left = Math.round(bx) + 'px';
  bubble.style.top = Math.round(by) + 'px';
  bubble.dataset.tip = side ? (onRight ? 'left' : 'right') : (below ? 'top' : 'bottom');
  bubble.style.setProperty('--tip', clamp(side ? y - by : x - bx, 12, Math.max(12, (side ? h : w) - 12)) + 'px');
}
export function followDetail() {
  if (openedDetail && !detailFrame) detailFrame = requestAnimationFrame(placeDetail);
}
export function closeDetail(restoreFocus = false) {
  if (!openedDetail) return;
  const {owner} = openedDetail;
  openedDetail = null;
  el('detailBubble').hidden = true;
  owner.removeAttribute('aria-expanded');
  if (restoreFocus && owner.isConnected) owner.focus({preventScroll:true});
}
export function refreshDetail(page, html) {
  if (openedDetail?.page !== page) return;
  const body = el('detailContent'), content = html();
  if (body.innerHTML !== content) { body.innerHTML = content; followDetail(); }
}
function createDetail() {
  const bubble = document.createElement('aside');
  bubble.id = 'detailBubble';
  bubble.hidden = true;
  bubble.setAttribute('aria-labelledby', 'detailTitle');
  bubble.innerHTML = '<header><h2 id="detailTitle"></h2><button type="button" aria-label="收起详情">×</button></header><div id="detailContent"></div>';
  document.body.append(bubble);
  bubble.querySelector('button').onclick = () => closeDetail(true);
  new ResizeObserver(followDetail).observe(el('tableViewport'));
  window.addEventListener('resize', followDetail);
  window.visualViewport?.addEventListener('resize', followDetail);
  window.visualViewport?.addEventListener('scroll', followDetail);
  document.addEventListener('scroll', event => {
    if (!bubble.contains(event.target)) followDetail();
  }, true);
  return bubble;
}
document.addEventListener('pointerdown', event => {
  const trigger = event.target.closest?.('button, [data-act]');
  lastPointer = {trigger, x:event.clientX, y:event.clientY};
  if (openedDetail && !el('detailBubble').contains(event.target) && !openedDetail.owner.contains(event.target)) closeDetail();
}, true);
document.addEventListener('focusin', event => {
  if (openedDetail && !openedDetail.owner.contains(event.target) && !el('detailBubble').contains(event.target)) closeDetail();
}, true);
document.addEventListener('keydown', event => {
  lastPointer = null;
  if (event.key !== 'Escape' || !openedDetail) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closeDetail(true);
}, true);
export function showDetail(trigger, title, html) {
  const bubble = el('detailBubble') || createDetail();
  const nested = openedDetail && bubble.contains(trigger);
  const owner = nested ? openedDetail.owner : trigger?.getClientRects().length ? trigger : el('settingsBtn');
  if (openedDetail?.owner === owner && el('detailTitle').textContent === title) {
    closeDetail(true);
    return;
  }
  const rect = owner.getBoundingClientRect();
  const point = !nested && lastPointer?.trigger === owner && rect.width && rect.height ? lastPointer : null;
  const x = nested ? openedDetail.x : point ? clamp((point.x - rect.left) / rect.width, 0, 1) : 0.5;
  const y = nested ? openedDetail.y : point ? clamp((point.y - rect.top) / rect.height, 0, 1) : 0.5;
  const keyboard = !lastPointer && (owner === document.activeElement || nested);
  closeDetail();
  const selector = owner.id ? '#' + CSS.escape(owner.id) : owner.dataset.act ?
    '[data-act="' + CSS.escape(owner.dataset.act) + '"][data-val="' + CSS.escape(owner.dataset.val || '') + '"]' : '';
  openedDetail = {owner, selector, x, y, page:trigger?.dataset.act};
  el('detailTitle').textContent = title;
  el('detailContent').innerHTML = html;
  el('detailContent').scrollTop = 0;
  bubble.hidden = false;
  owner.setAttribute('aria-expanded', 'true');
  placeDetail();
  if (keyboard && openedDetail) bubble.querySelector('button').focus({preventScroll:true});
}

export const ranked = (n) => rankMark(n),
  suit = (s) => suitMark[s];
