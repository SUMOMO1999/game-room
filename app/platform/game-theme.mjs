import { gamePath, entryStorageKey } from '../entry-path.mjs';

// A local display preference. It never changes accounts, room state or game
// colors: tile numbers, army sides and aircraft colors retain their meanings.
export const GAME_THEMES = Object.freeze([
  { id: 'classic', name: '森林布', hint: '细织牌桌 · 温润黄铜', tone: 'dark',
    base: '#173a31', surface: '#234b3f', table: '#2e5848', control: '#294e42', accent: '#e4ce9b',
    ink: '#f7f4e8', muted: '#ccd8c8', border: '#728b77', glow: '#e5dba414', grain: '#edf4dd06', shadow: '#051d1659',
    rack: '#d8bc90', rackEdge: '#ad8957', rackInk: '#463a29', good: '#d7e5a6', bad: '#ffd3bd' },
  { id: 'midnight', name: '月夜蓝', hint: '深蓝毡面 · 冷银微光', tone: 'dark',
    base: '#1a2838', surface: '#293d50', table: '#2f475e', control: '#2c4156', accent: '#cedde8',
    ink: '#f5f7fa', muted: '#c8d5e0', border: '#7e91a2', glow: '#d4e7fa14', grain: '#dceafa05', shadow: '#09152666',
    rack: '#bdc9cf', rackEdge: '#899da8', rackInk: '#303c45', good: '#cce5c4', bad: '#ffcfbf' },
  // Stable IDs are stored on devices. Renaming a theme never migrates a game.
  { id: 'wine', name: '樱花米白', hint: '暖白纸织 · 陶玫瑰', tone: 'light',
    base: '#f4ede7', surface: '#fffaf5', table: '#e9ded6', control: '#eee4dc', accent: '#85564f',
    ink: '#382d2a', muted: '#6c5851', border: '#bba79a', glow: '#fffdf6b3', grain: '#8d716408', shadow: '#65483a14',
    rack: '#d5b9a4', rackEdge: '#b18e75', rackInk: '#48362d', good: '#476644', bad: '#963b31' },
  { id: 'slate', name: '石墨', hint: '磨砂石灰 · 柔雾绿银', tone: 'dark',
    base: '#252c2f', surface: '#353f43', table: '#414c50', control: '#3b474b', accent: '#cdd8ce',
    ink: '#f2f5ef', muted: '#d0d8d1', border: '#859390', glow: '#d9e5db0c', grain: '#f1f4ed04', shadow: '#12181c59',
    rack: '#bec8bf', rackEdge: '#8e9e90', rackInk: '#343c34', good: '#d3e4b7', bad: '#ffd3bd' },
  { id: 'sand', name: '原木织纹', hint: '亚麻桌布 · 蜂蜜原木', tone: 'light',
    base: '#efe7da', surface: '#fcf7ec', table: '#e4d4bb', control: '#e9decc', accent: '#715b3d',
    ink: '#3b332a', muted: '#665642', border: '#b39c7c', glow: '#fff5de80', grain: '#8c6d430a', shadow: '#73542f17',
    rack: '#d5b788', rackEdge: '#ae8854', rackInk: '#463625', good: '#456243', bad: '#963b31' },
  { id: 'blueprint', name: '海盐', hint: '浅青细麻 · 海玻璃', tone: 'light',
    base: '#e8f0ef', surface: '#f8fcfa', table: '#dce9e5', control: '#e0ebe7', accent: '#356b69',
    ink: '#283e3c', muted: '#4e6964', border: '#9eb6ad', glow: '#fbfffc99', grain: '#58847708', shadow: '#365b5314',
    rack: '#b9cdc1', rackEdge: '#8ca997', rackInk: '#2f4338', good: '#386541', bad: '#963b31' },
].map(theme => Object.freeze(theme)));

const colorFields = ['base', 'surface', 'table', 'control', 'accent', 'ink', 'muted', 'border', 'glow', 'grain', 'shadow', 'rack', 'rackEdge', 'rackInk', 'good', 'bad'];
function setThemeTokens(element, theme) {
  for (const field of colorFields) element.style.setProperty(`--theme-${field.replace(/[A-Z]/gu, letter => '-'+letter.toLowerCase())}`, theme[field]);
}

const key = entryStorageKey('game-room.theme.v1');
const installed = new WeakMap();
export function themeById(id) { return GAME_THEMES.find(theme => theme.id === id) || GAME_THEMES[0]; }
export function initializeGameTheme(documentRef) {
  if (!documentRef?.documentElement?.style || !documentRef.createElement || !documentRef.head) return null;
  if (installed.has(documentRef)) return installed.get(documentRef);
  let storage, current = 'classic';
  try { storage = documentRef.defaultView?.localStorage; current = themeById(storage?.getItem(key)).id; } catch {}
  const subscribers = new Set();
  function apply(id, save = false) {
    const theme = themeById(id); current = theme.id;
    const root = documentRef.documentElement;
    root.dataset.gameTheme = current;
    root.dataset.themeTone = theme.tone;
    root.style.colorScheme = theme.tone;
    setThemeTokens(root, theme);
    // The status bar belongs to the page. Keep its color aligned with the table.
    documentRef.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.base);
    if (save) try { storage?.setItem(key, current); } catch {}
    for (const subscriber of subscribers) subscriber(current);
  }
  const link = documentRef.createElement('link'); link.rel = 'stylesheet'; link.href = gamePath('/platform/game-theme.css');
  link.dataset.gameThemeStyles = ''; documentRef.head.append(link);
  apply(current);
  const controller = { current: () => current, set: id => apply(id, true), subscribe(callback) {
    subscribers.add(callback); callback(current); return () => subscribers.delete(callback);
  } };
  installed.set(documentRef, controller); return controller;
}

export function mountGameThemePicker(documentRef, dialog) {
  const controller = initializeGameTheme(documentRef);
  if (!controller || !dialog?.querySelector || dialog.querySelector('[data-theme-picker]')) return () => {};
  const section = documentRef.createElement('section'); section.dataset.themePicker = '';
  const title = documentRef.createElement('h3'); title.textContent = '桌面主题';
  const note = documentRef.createElement('p'); note.className = 'theme-note'; note.textContent = '只改变画面，记住这台设备的选择。';
  const list = documentRef.createElement('div'); list.className = 'theme-picker';
  const handlers = [];
  for (const theme of GAME_THEMES) {
    const button = documentRef.createElement('button'); button.type = 'button'; button.dataset.themeChoice = theme.id;
    button.className = 'theme-choice'; button.setAttribute('aria-label', `${theme.name}主题，${theme.hint}`);
    setThemeTokens(button, theme);
    const preview = documentRef.createElement('span'); preview.className = 'theme-preview'; preview.dataset.gameTheme = theme.id;
    preview.setAttribute('aria-hidden', 'true');
    const table = documentRef.createElement('span'); table.className = 'theme-preview-table';
    const tiles = documentRef.createElement('span'); tiles.className = 'theme-preview-tiles';
    for (const number of ['1', '2', '3']) { const tile = documentRef.createElement('i'); tile.textContent = number; tiles.append(tile); }
    const rack = documentRef.createElement('span'); rack.className = 'theme-preview-rack';
    const action = documentRef.createElement('span'); action.className = 'theme-preview-action'; action.textContent = '开始';
    table.append(tiles); preview.append(table, rack, action);
    const name = documentRef.createElement('strong'); name.textContent = theme.name;
    const hint = documentRef.createElement('small'); hint.textContent = theme.hint;
    const copy = documentRef.createElement('span'); copy.className = 'theme-choice-copy'; copy.append(name, hint);
    const check = documentRef.createElement('span'); check.className = 'theme-choice-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
    button.append(preview, copy, check); list.append(button);
    const choose = () => controller.set(theme.id); button.addEventListener('click', choose);
    handlers.push(() => button.removeEventListener('click', choose));
  }
  const unsubscribe = controller.subscribe(id => { for (const button of list.children) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === id)); });
  section.append(title, note, list); (dialog.querySelector('.game-settings-body') || dialog).append(section);
  return () => { unsubscribe(); handlers.forEach(remove => remove()); section.remove(); };
}
