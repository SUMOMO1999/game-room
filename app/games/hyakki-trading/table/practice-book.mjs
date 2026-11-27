import { cardsFor, rolesFor, isExpansion, getCard } from '../presentation-content.mjs';
import { CARDS as baseCards } from '../content/definitions.mjs';
import { PUBLIC_ORDERS, EXPANSION_TWO_PACK_ID } from '../content/expansion-two.mjs';
import { tag, printCard } from './pieces.mjs';

const editions = { base: '原版', 'six-trades-v1': '六行百业', [EXPANSION_TWO_PACK_ID]: '商路风云' };
const baseIds = new Set(baseCards.map((card) => card.id));
const kinds = { cards: '主牌', roles: '商人', orders: '公单' };
const moduleNames = { orders: '公单', refining: '精制', exchange: '商会' };
export const editionName = (config) => editions[config?.packId] ?? '原版';
export const allModules = (config) =>
  config?.packId === EXPANSION_TWO_PACK_ID && Object.keys(moduleNames).every((key) => config.modules?.[key]);

function button(label, run) {
  const item = tag('button', '', label);
  item.type = 'button';
  item.onclick = run;
  return item;
}
function editionOf(piece) {
  if (piece.module || piece.kind) return EXPANSION_TWO_PACK_ID;
  return baseIds.has(piece.id) ? 'base' : 'six-trades-v1';
}

export function practiceBook(root, newFullGame) {
  const dialog = tag('dialog', 'm-book');
  dialog.setAttribute('aria-label', '本局牌册');
  const bar = tag('header', 'm-book-bar');
  const title = tag('h2');
  const heading = tag('hgroup');
  const activeModules = tag('p', 'm-book-modules');
  heading.append(title, activeModules);
  const edition = tag('select');
  edition.setAttribute('aria-label', '按版本查看');
  const tabs = tag('nav', 'm-book-tabs');
  tabs.setAttribute('aria-label', '牌册分类');
  const shelf = tag('section', 'm-book-shelf');
  const detail = tag('article', 'm-book-detail');
  const back = button('返回牌册', showList);
  const setup = button('开全内容局', () => { dialog.close(); newFullGame(); });
  const leave = button('回牌桌', () => dialog.close());
  bar.append(heading, setup, back, leave);
  tabs.append(edition);
  dialog.append(bar, tabs, shelf, detail);
  root.append(dialog);
  let config, catalog, kind, selection;
  function showList() {
    detail.hidden = back.hidden = true;
    shelf.hidden = tabs.hidden = false;
    title.textContent = editionName(config) + ' · 本局牌册';
    activeModules.hidden = !activeModules.textContent;
    setup.hidden = !newFullGame || allModules(config);
    selection?.focus({ preventScroll: true });
  }
  function showPiece(piece, source) {
    selection = source;
    const order = kind === 'orders';
    const face = order ? piece : getCard(piece.id, config);
    const copy = tag('section');
    const lines = order
      ? [face.summary, '交付可得 ' + face.silver + ' 两。', face.example]
      : [face.summary, ...(face.details ?? []), face.example];
    for (const line of lines.filter(Boolean)) copy.append(tag('p', '', line));
    detail.replaceChildren();
    if (!order) {
      const sample = tag('span', 'm-sample');
      printCard(sample, face.id, config);
      detail.append(sample);
    }
    detail.append(copy);
    shelf.hidden = tabs.hidden = setup.hidden = activeModules.hidden = true;
    detail.hidden = back.hidden = false;
    title.textContent = face.name;
    detail.scrollTop = 0;
    back.focus();
  }
  function renderShelf() {
    const filtered = (key) => catalog[key].filter((piece) => !edition.value || editionOf(piece) === edition.value);
    for (const tab of tabs.querySelectorAll('[data-kind]')) {
      const key = tab.dataset.kind;
      tab.textContent = kinds[key] + ' ' + filtered(key).length;
      tab.setAttribute('aria-pressed', String(key === kind));
      tab.disabled = !filtered(key).length;
    }
    shelf.dataset.kind = kind;
    const items = filtered(kind).map((piece) => {
      const item = button('', () => showPiece(piece, item));
      item.dataset.entry = piece.id;
      if (kind === 'orders') {
        item.append(tag('strong', '', piece.name), tag('span', '', piece.summary), tag('b', '', piece.silver + ' 两'));
      } else printCard(item, piece.id, config);
      return item;
    });
    shelf.replaceChildren(...items);
    shelf.scrollTop = 0;
  }
  for (const key of Object.keys(kinds)) {
    const tab = button(kinds[key], () => { kind = key; renderShelf(); });
    tab.dataset.kind = key;
    tabs.append(tab);
  }
  edition.onchange = () => {
    if (!catalog[kind].some((piece) => !edition.value || editionOf(piece) === edition.value)) kind = 'cards';
    renderShelf();
  };
  dialog.addEventListener('cancel', (event) => {
    if (!detail.hidden) { event.preventDefault(); showList(); }
  });
  return {
    open(configuration) {
      if (dialog.open) return;
      config = configuration;
      catalog = {
        cards: cardsFor(config), roles: isExpansion(config) ? rolesFor(config) : [],
        orders: config?.modules?.orders ? PUBLIC_ORDERS : []
      };
      const active = new Set(Object.values(catalog).flat().map(editionOf));
      edition.replaceChildren(new Option('全部版本', ''), ...Object.entries(editions)
        .filter(([key]) => active.has(key)).map(([key, name]) => new Option(name, key)));
      kind = 'cards';
      selection = null;
      activeModules.textContent = Object.entries(moduleNames)
        .filter(([key]) => config?.modules?.[key]).map(([, label]) => label).join(' · ');
      showList();
      renderShelf();
      dialog.showModal();
      leave.focus();
    },
    close() { if (dialog.open) dialog.close(); },
    destroy() { dialog.remove(); }
  };
}
