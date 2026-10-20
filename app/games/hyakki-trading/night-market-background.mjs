// A device-local presentation preference. It never reads or changes a room,
// account, saved game, or the ecosystem's appearance preferences.
export const NIGHT_MARKET_BACKGROUND_KEY = 'game-room:hyakki-table-background:v1';
export const NIGHT_MARKET_DEFAULT_BACKGROUND = 'rain';
export const NIGHT_MARKET_BACKGROUNDS = Object.freeze([
  Object.freeze({ id: 'original', name: '灯下夜市', file: 'hyakki-night-market.webp' }),
  Object.freeze({ id: 'lantern', name: '暖灯明木', file: 'hyakki-night-market-lantern.png' }),
  Object.freeze({ id: 'rain', name: '雨后青灯', file: 'hyakki-night-market-rain.png' }),
]);
const background = id => NIGHT_MARKET_BACKGROUNDS.find(item => item.id === id)
  ?? NIGHT_MARKET_BACKGROUNDS.find(item => item.id === NIGHT_MARKET_DEFAULT_BACKGROUND);
const imageURL = item => new URL(`../../assets/${item.file}`, import.meta.url).href;

/** Owns the settings inputs, background image probe, and one CSS image variable.
 * Native radio inputs provide the keyboard selection behavior. Image probes are
 * deliberately separate from the game surface: no whole-table filter is used. */
export function mountNightMarketBackground({ root, settingsDialog } = {}) {
  if (!root?.ownerDocument || !settingsDialog) throw new TypeError('夜市背景需要当前桌面和设置。');
  const document = root.ownerDocument, window = document.defaultView;
  const body = document.body, style = body.style, property = '--nm-background-image';
  const previous = { value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) };
  const previousDataset = root.dataset.nightMarketBackground;
  const container = document.createElement('section'); container.className = 'nm-background-settings';
  const fieldset = document.createElement('fieldset');
  const legend = document.createElement('legend'); legend.textContent = '桌面背景'; fieldset.append(legend);
  const choices = document.createElement('div'); choices.className = 'nm-background-options';
  const inputs = new Map();
  for (const item of NIGHT_MARKET_BACKGROUNDS) {
    const label = document.createElement('label'); label.className = 'nm-background-option';
    const preview = document.createElement('img'); preview.src = imageURL(item); preview.alt = ''; preview.draggable = false;
    const caption = document.createElement('span');
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'hyakki-table-background'; input.value = item.id;
    input.setAttribute('aria-label', item.name); input.setAttribute('data-nm-background', item.id);
    const text = document.createElement('span'); text.textContent = item.name;
    caption.append(input, text); label.append(preview, caption); choices.append(label); inputs.set(item.id, input);
  }
  const status = document.createElement('p'); status.className = 'nm-background-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  fieldset.append(choices, status); container.append(fieldset);
  settingsDialog.querySelector('.game-settings-body').append(container);
  let storage = null, canSave = true, disposed = false, generation = 0, pending = null, message = '';
  let selected = NIGHT_MARKET_DEFAULT_BACKGROUND;
  try { storage = window.localStorage; if (!storage?.getItem || !storage?.setItem) canSave = false; }
  catch { canSave = false; }
  function updateStatus() {
    status.textContent = [message, canSave ? '仅保存于此设备的当前浏览器。' : '当前仍可切换背景；浏览器不允许保存，关闭后不会记住。'].filter(Boolean).join(' ');
  }
  function selectInput(id) {
    for (const [key, input] of inputs) {
      input.checked = key === id;
      input.closest('label').classList.toggle('is-selected', key === id);
    }
  }
  function save(id) {
    if (!canSave) return;
    try { storage.setItem(NIGHT_MARKET_BACKGROUND_KEY, id); }
    catch { canSave = false; }
  }
  function releaseProbe() {
    if (!pending) return;
    pending.image.removeEventListener('load', pending.load);
    pending.image.removeEventListener('error', pending.error);
    pending.image.removeAttribute?.('src'); pending = null;
  }
  function apply(id) {
    selected = id; selectInput(id); root.dataset.nightMarketBackground = id;
    // Original is an explicit preference and also the missing-image fallback;
    // it must override the stylesheet's newer rain default.
    style.setProperty(property, `url(${JSON.stringify(imageURL(background(id)))})`);
  }
  function choose(id, persist = false) {
    const item = background(id), token = ++generation; releaseProbe();
    if (item.id === 'original') {
      apply('original'); message = ''; if (persist) save('original'); updateStatus(); return;
    }
    selectInput(item.id); message = '正在加载背景…'; updateStatus();
    let image;
    try { image = new window.Image(); }
    catch { failed(); return; }
    function loaded() {
      if (disposed || token !== generation) return;
      releaseProbe(); apply(item.id); message = ''; if (persist) save(item.id); updateStatus();
    }
    function failed() {
      if (disposed || token !== generation) return;
      releaseProbe(); apply('original'); message = '这张背景未能加载，已恢复灯下夜市。';
      if (persist) save('original'); updateStatus();
    }
    pending = { image, load: loaded, error: failed };
    image.addEventListener('load', loaded); image.addEventListener('error', failed); image.src = imageURL(item);
    if (image.complete) image.naturalWidth > 0 ? loaded() : failed();
  }
  function changed(event) {
    const input = event.target.closest?.('[data-nm-background]');
    if (disposed || !input || !choices.contains(input) || !input.checked) return;
    choose(input.value, true);
  }
  choices.addEventListener('change', changed);
  try { if (canSave) selected = background(storage.getItem(NIGHT_MARKET_BACKGROUND_KEY)).id; }
  catch { canSave = false; }
  // The stylesheet already paints the new default during loading. Preserve a
  // saved choice without briefly forcing the old scene on every fresh mount.
  const restored = selected; selectInput(restored); root.dataset.nightMarketBackground = restored; choose(restored);
  return { destroy() {
    if (disposed) return; disposed = true; generation++; releaseProbe(); choices.removeEventListener('change', changed);
    container.remove();
    if (previous.value) style.setProperty(property, previous.value, previous.priority); else style.removeProperty(property);
    if (previousDataset === undefined) delete root.dataset.nightMarketBackground; else root.dataset.nightMarketBackground = previousDataset;
  } };
}
