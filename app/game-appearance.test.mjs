import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { initializeGameTheme, themeById, GAME_THEMES } from './platform/game-theme.mjs';
import { mountRoomSettings } from './platform/room-settings.mjs';
import { drawingTestDOM } from './test-support/drawing-page-dom.mjs';
import { APPEARANCE_PRESETS, GLASS_BACKGROUNDS, createDefaultAppearanceState, createInitialAppearanceState, chooseAppearance, validateAppearanceState } from './platform/appearance-data.mjs';
import { APPEARANCE_STORAGE_KEY, appearancePaint, initializeGameAppearance, mountGameAppearancePicker } from './platform/game-appearance.mjs';

const accepted = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const clone = value => JSON.parse(JSON.stringify(value));

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, event = {}) { for (const callback of [...(listeners.get(type) || [])]) callback(event); },
    listenerCount() { return [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0); },
  };
}

// A controlled document exercises the real controller without a browser or
// network. Business elements, focus and settings ownership stay outside it.
function fixture({ raw = null, legacy = null, blocked = false, denyWrite = false, denyRead = false, supportsFilter = true } = {}) {
  const records = new Map(), reads = [], writes = [], style = new Map(), changes = [], links = [];
  if (raw !== null) records.set(APPEARANCE_STORAGE_KEY, raw);
  if (legacy !== null) records.set('game-room.theme.v1', legacy);
  const storage = {
    getItem(key) { reads.push(key); if (denyRead) throw new Error('read denied'); return records.get(key) ?? null; },
    setItem(key, value) { if (denyWrite) throw new Error('quota denied'); writes.push({ key, value }); records.set(key, value); },
  };
  const media = new Map();
  const win = {
    ...eventTarget(), navigator: {}, CSS: { supports: () => supportsFilter },
    get localStorage() { if (blocked) throw new Error('本机存储被禁用'); return storage; },
    matchMedia(query) { if (!media.has(query)) media.set(query, { ...eventTarget(), matches: false }); return media.get(query); },
  };
  const root = { dataset: {}, style: {
    setProperty(key, value) { style.set(key, value); changes.push({ key, value }); },
    removeProperty(key) { style.delete(key); changes.push({ key, removed: true }); },
  } };
  const meta = { content: '#173a31', getAttribute(key) { return this[key] ?? null; }, setAttribute(key, value) { this[key] = value; } };
  const document = {
    ...eventTarget(), documentElement: root, defaultView: win,
    querySelector: selector => selector === 'meta[name="theme-color"]' ? meta : null,
    createElement: tagName => ({ tagName, dataset: {} }), head: { append: node => links.push(node) },
  };
  return { document, win, root, storage, records, reads, writes, style, changes, links, meta,
    preference(query, matches) { const target = media.get(query); assert(target, query); target.matches = matches; target.emit('change'); },
    listeners: () => document.listenerCount() + win.listenerCount() + [...media.values()].reduce((count, target) => count + target.listenerCount(), 0),
  };
}

const paintValues = fixture => Object.fromEntries([...fixture.style].filter(([key]) => key.startsWith('--appearance-')));
const legacyValues = fixture => Object.fromEntries([...fixture.style].filter(([key]) => key.startsWith('--theme-')));

test('initial mount projects the soft-green default over existing theme tokens without changing or persisting them and shares one controller', () => {
  const f = fixture({ legacy: 'wine' });
  const old = initializeGameTheme(f.document), originalTokens = legacyValues(f);
  const controller = initializeGameAppearance(f.document, { scope: 'rummikub' });
  assert.equal(controller.state().activeStyle, 'soft'); assert.equal(controller.issue(), '');
  assert.equal(initializeGameAppearance(f.document, { scope: 'rummikub' }), controller);
  assert.deepEqual(f.writes, []); assert.equal(f.records.get('game-room.theme.v1'), 'wine');
  assert.equal(old.current(), 'wine'); assert.deepEqual(legacyValues(f), originalTokens);
  assert.equal(f.root.dataset.gameAppearance, 'soft'); assert.equal(f.meta.content, '#e6e9e8');
  const exposed = controller.state(); exposed.sets.paper.tokens.accent = '#123456';
  assert.notEqual(controller.state().sets.paper.tokens.accent, '#123456');
  controller.destroy();
});

test('missing appearance preferences and absent or invalid legacy choices use the fresh quiet-soft green default without persisting', () => {
  for (const legacy of [null, '', 'unknown', 'toString']) {
    const f = fixture({ legacy });
    const controller = initializeGameAppearance(f.document, { scope: 'practice-hub' });
    assert.deepEqual(controller.state(), createInitialAppearanceState());
    assert.equal(controller.state().presetIds.soft, 'builtin-soft-quiet');
    assert.equal(f.root.dataset.gameAppearance, 'soft'); assert.equal(f.root.dataset.appearance, 'soft');
    assert.equal(f.style.get('--appearance-accent'), '#027f6e'); assert.equal(f.meta.content, '#e6e9e8');
    assert.equal(controller.issue(), ''); assert.deepEqual(f.writes, []);
    assert.equal(f.records.has(APPEARANCE_STORAGE_KEY), false);
    assert.equal(f.records.get('game-room.theme.v1') ?? null, legacy);
    controller.destroy();
  }
});

test('each legacy-only device starts with soft-green while keeping all six original theme preferences and tokens available', () => {
  for (const theme of GAME_THEMES) {
    const f = fixture({ legacy: theme.id });
    const old = initializeGameTheme(f.document), originalTokens = legacyValues(f);
    const controller = initializeGameAppearance(f.document, { scope: 'rummikub' });
    assert.deepEqual(controller.state(), createInitialAppearanceState());
    assert.equal(old.current(), theme.id); assert.equal(f.root.dataset.gameTheme, theme.id);
    assert.equal(f.meta.content, '#e6e9e8'); assert.deepEqual(legacyValues(f), originalTokens);
    assert.equal(f.root.dataset.gameAppearance, 'soft'); assert.equal(f.style.get('--appearance-accent'), '#027f6e');
    assert.equal(f.records.get('game-room.theme.v1'), theme.id); assert.deepEqual(f.writes, []);
    assert.equal(f.records.has(APPEARANCE_STORAGE_KEY), false); controller.destroy();
  }
});

test('valid v1 and v2 saved choices including explicit original appearance win over the new default without rewriting storage', () => {
  for (const version of [1, 2]) for (const activeStyle of [null, 'paper', 'glass', 'soft']) {
    const current = accepted(chooseAppearance(createDefaultAppearanceState(), activeStyle));
    current.sets.paper.tokens.accent = '#123456'; current.sets.glass.tokens.background = 7;
    const saved = version === 1 ? { version: 1, activeStyle, sets: clone(current.sets) } : current;
    const raw = JSON.stringify(saved), f = fixture({ raw, legacy: 'wine' });
    initializeGameTheme(f.document);
    const controller = initializeGameAppearance(f.document, { scope: 'lobby' });
    const expected = accepted(validateAppearanceState(saved));
    assert.deepEqual(controller.state(), expected); assert.equal(controller.state().activeStyle, activeStyle);
    assert.equal(f.records.get(APPEARANCE_STORAGE_KEY), raw); assert.deepEqual(f.writes, []);
    assert.equal(f.records.get('game-room.theme.v1'), 'wine');
    if (activeStyle === null) { assert.equal(f.root.dataset.gameAppearance, undefined); assert.equal(f.meta.content, themeById('wine').base); }
    else assert.equal(f.root.dataset.gameAppearance, activeStyle);
    controller.destroy();
  }
});

// The resolver loads the actual local sources under their two real browser URL
// shapes. import.meta.url and entryStorageKey stay unmodified; no HTTP is sent.
async function loadBrowserAppearance(base) {
  const origin = new URL(base).origin, root = new URL(base);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.')) {
        return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
      }
      if (specifier.startsWith(root.href)) return { url: specifier, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (new URL(url).origin !== origin) return nextLoad(url, context);
      assert(url.startsWith(root.href));
      const path = url.slice(root.href.length);
      assert.match(path, /^(?:platform\/)?[a-z-]+\.mjs$/);
      return { format: 'module', source: readFileSync(new URL(path, import.meta.url), 'utf8'), shortCircuit: true };
    },
  });
  try {
    return { appearance: await import(new URL('platform/game-appearance.mjs', root)),
      theme: await import(new URL('platform/game-theme.mjs', root)) };
  } finally { hooks.deregister(); }
}

test('both real entry URL shapes default legacy-only devices to soft-green and independently restore explicit selections after remount', async () => {
  const direct = await loadBrowserAppearance('https://game.appearance-test.invalid/');
  const mounted = await loadBrowserAppearance('https://agora.appearance-test.invalid/game/');
  const directKey = 'game-room.appearance.v1', mountedKey = 'agora-game:game-room.appearance.v1';
  assert.equal(direct.appearance.APPEARANCE_STORAGE_KEY, directKey);
  assert.equal(mounted.appearance.APPEARANCE_STORAGE_KEY, mountedKey);
  const f = fixture({ legacy: 'wine' });
  f.records.set('agora-game:game-room.theme.v1', 'midnight');
  const selections = new Map();
  for (const [api, key, material] of [[direct, directKey, 'paper'], [mounted, mountedKey, 'glass']]) {
    api.theme.initializeGameTheme(f.document);
    const controller = api.appearance.initializeGameAppearance(f.document, { scope: 'lobby' });
    assert.deepEqual(controller.state(), createInitialAppearanceState());
    assert.equal(f.records.has(key), false);
    accepted(controller.select(material)); accepted(controller.colors({ accent: material === 'paper' ? '#345678' : '#876543' }));
    if (material === 'glass') accepted(controller.background(7));
    selections.set(key, controller.state()); controller.destroy();
  }
  const recordsBefore = new Map(f.records), writes = f.writes.length;
  for (let cycle = 0; cycle < 3; cycle++) for (const [api, key] of [[direct, directKey], [mounted, mountedKey]]) {
    const controller = api.appearance.initializeGameAppearance(f.document, { scope: 'wordbank' });
    assert.deepEqual(controller.state(), selections.get(key));
    assert.equal(f.root.dataset.gameAppearance, selections.get(key).activeStyle);
    assert.equal(api.appearance.initializeGameAppearance(f.document, { scope: 'wordbank' }), controller);
    controller.destroy(); controller.destroy(); assert.equal(f.listeners(), 0);
  }
  assert.deepEqual(f.records, recordsBefore); assert.equal(f.writes.length, writes);
  for (const [api, key] of [[direct, directKey], [mounted, mountedKey]]) {
    const controller = api.appearance.initializeGameAppearance(f.document, { scope: 'rummikub' });
    accepted(controller.select(null)); const explicit = controller.state(); controller.destroy();
    const restored = api.appearance.initializeGameAppearance(f.document, { scope: 'rummikub' });
    assert.deepEqual(restored.state(), explicit); assert.equal(restored.state().activeStyle, null);
    assert.equal(f.root.dataset.gameAppearance, undefined);
    accepted(restored.reset()); assert.deepEqual(restored.state(), createInitialAppearanceState()); restored.destroy();
    assert.deepEqual(JSON.parse(f.records.get(key)), createInitialAppearanceState());
  }
  assert.equal(f.records.get('game-room.theme.v1'), 'wine');
  assert.equal(f.records.get('agora-game:game-room.theme.v1'), 'midnight');
  assert(f.writes.every(write => [directKey, mountedKey].includes(write.key)));
});

test('valid device preferences restore and every actual preset and background can be applied without writing the legacy key', () => {
  const saved = accepted(chooseAppearance(createDefaultAppearanceState(), 'glass'));
  saved.sets.glass.tokens.background = 6;
  const f = fixture({ raw: JSON.stringify(saved), legacy: 'midnight' });
  initializeGameTheme(f.document); const originalTokens = legacyValues(f);
  const controller = initializeGameAppearance(f.document, { scope: 'lobby' });
  assert.deepEqual(controller.state(), saved); assert.equal(f.writes.length, 0);
  assert.equal(f.root.dataset.gameAppearance, 'glass'); assert.equal(f.style.get('--appearance-environment'), GLASS_BACKGROUNDS[6].background);
  for (const preset of APPEARANCE_PRESETS) {
    accepted(controller.select(preset.styleId)); accepted(controller.preset(preset.id));
    assert.deepEqual(controller.state().sets[preset.styleId], preset);
    assert.equal(f.root.dataset.gameUiSet, preset.id);
    assert.equal(f.style.get('--appearance-accent'), preset.tokens.accent);
    assert.equal(f.style.get('--appearance-ink'), preset.tokens.ink);
    assert.equal(f.style.get('--appearance-surface'), preset.tokens.surface);
  }
  accepted(controller.select('glass'));
  const material = controller.state().sets.glass.tokens;
  for (const background of GLASS_BACKGROUNDS) {
    accepted(controller.background(background.id));
    assert.equal(f.style.get('--appearance-environment'), background.background);
    assert.deepEqual(controller.state().sets.glass.tokens, { ...material, background: background.id });
  }
  assert(f.writes.length > 0); assert(f.writes.every(write => write.key === APPEARANCE_STORAGE_KEY));
  assert.deepEqual(accepted(validateAppearanceState(JSON.parse(f.records.get(APPEARANCE_STORAGE_KEY)))), controller.state());
  assert.equal(f.records.get('game-room.theme.v1'), 'midnight'); assert.deepEqual(legacyValues(f), originalTokens);
  const persisted = f.records.get(APPEARANCE_STORAGE_KEY); controller.destroy();
  const next = fixture({ raw: persisted });
  const restored = initializeGameAppearance(next.document, { scope: 'wordbank' });
  assert.equal(restored.state().sets.glass.tokens.background, 7); assert.equal(restored.state().activeStyle, 'glass');
  assert.deepEqual(next.writes, []); restored.destroy();
});

test('corrupt and unsupported records remain untouched while initialization uses soft-green even on legacy-only devices', () => {
  const unknown = createDefaultAppearanceState(); unknown.extra = true;
  for (const raw of ['{broken', JSON.stringify(unknown), ' '.repeat(110001)]) for (const legacy of [null, 'sand']) {
    const f = fixture({ raw, legacy });
    if (legacy) initializeGameTheme(f.document);
    const controller = initializeGameAppearance(f.document, { scope: 'practice-hub' });
    assert.deepEqual(controller.state(), createInitialAppearanceState()); assert(controller.issue());
    assert.equal(f.records.get(APPEARANCE_STORAGE_KEY), raw); assert.deepEqual(f.writes, []);
    assert.equal(f.root.dataset.gameAppearance, 'soft');
    assert.equal(f.meta.content, '#e6e9e8');
    controller.destroy();
  }
});

test('blocked storage and quota denial keep the chosen appearance usable for the current document', () => {
  for (const options of [{ blocked: true }, { denyWrite: true }]) {
    const f = fixture(options), controller = initializeGameAppearance(f.document, { scope: 'draw-and-guess' });
    assert.deepEqual(controller.state(), createInitialAppearanceState());
    accepted(controller.select('paper')); accepted(controller.colors({ accent: '#123456' }));
    assert.equal(controller.state().activeStyle, 'paper'); assert.equal(f.style.get('--appearance-accent'), '#123456');
    assert.match(controller.issue(), /本次.*有效/); assert.deepEqual(f.writes, []);
    controller.destroy();
  }
});

test('a storage read failure keeps soft-green usable and a later successful explicit write clears the visible issue', () => {
  const f = fixture({ denyRead: true, legacy: 'midnight' });
  const controller = initializeGameAppearance(f.document, { scope: 'lobby' });
  assert.deepEqual(controller.state(), createInitialAppearanceState()); assert(controller.issue());
  assert.equal(f.root.dataset.gameAppearance, 'soft'); assert.deepEqual(f.writes, []);
  accepted(controller.select('paper')); assert.equal(controller.issue(), '');
  assert.equal(JSON.parse(f.records.get(APPEARANCE_STORAGE_KEY)).activeStyle, 'paper');
  assert.equal(f.records.get('game-room.theme.v1'), 'midnight'); controller.destroy();
});

test('cross-tab storage changes use validated state, reject foreign events, and never echo a storage write', () => {
  const f = fixture(), controller = initializeGameAppearance(f.document, { scope: 'parks' });
  const incoming = accepted(chooseAppearance(createDefaultAppearanceState(), 'soft'));
  incoming.sets.soft.tokens.accent = '#123456';
  const raw = JSON.stringify(incoming);
  f.win.emit('storage', { key: 'another-key', storageArea: f.storage, newValue: raw });
  f.win.emit('storage', { key: APPEARANCE_STORAGE_KEY, storageArea: {}, newValue: raw });
  assert.deepEqual(controller.state(), createInitialAppearanceState());
  f.win.emit('storage', { key: APPEARANCE_STORAGE_KEY, storageArea: f.storage, newValue: raw });
  assert.deepEqual(controller.state(), incoming); assert.equal(f.style.get('--appearance-accent'), '#123456');
  const paint = paintValues(f);
  f.win.emit('storage', { key: APPEARANCE_STORAGE_KEY, storageArea: f.storage, newValue: '{broken' });
  assert.deepEqual(controller.state(), incoming); assert.deepEqual(paintValues(f), paint); assert(controller.issue());
  f.win.emit('storage', { key: APPEARANCE_STORAGE_KEY, storageArea: f.storage, newValue: null });
  assert.deepEqual(controller.state(), createInitialAppearanceState()); assert.equal(controller.issue(), '');
  assert.equal(f.root.dataset.gameAppearance, 'soft');
  const expectedPaint = appearancePaint(createInitialAppearanceState());
  assert.deepEqual(paintValues(f), Object.fromEntries(Object.entries(expectedPaint.values).map(([key, value]) => ['--appearance-' + key, value])));
  assert.equal(f.meta.content, '#e6e9e8'); assert.deepEqual(f.writes, []);
  controller.destroy();
});

test('removing appearance preferences returns to soft-green regardless of any old theme key without echoing writes', () => {
  const f = fixture({ legacy: 'wine' });
  initializeGameTheme(f.document);
  const controller = initializeGameAppearance(f.document, { scope: 'parks' });
  accepted(controller.select('glass')); accepted(controller.background(6));
  const writes = f.writes.length;
  for (const legacy of ['wine', null, 'unknown', 'sand']) {
    if (legacy === null) f.records.delete('game-room.theme.v1');
    else f.records.set('game-room.theme.v1', legacy);
    f.win.emit('storage', { key: APPEARANCE_STORAGE_KEY, storageArea: f.storage, newValue: null });
    assert.deepEqual(controller.state(), createInitialAppearanceState());
    assert.equal(f.root.dataset.gameAppearance, 'soft'); assert.equal(f.meta.content, '#e6e9e8');
    assert.equal(f.style.get('--appearance-accent'), '#027f6e');
  }
  assert.equal(controller.issue(), ''); assert.equal(f.writes.length, writes); controller.destroy();
});

test('defaultPreset resets only soft while reset restores all fresh default working copies and persists only the appearance key', () => {
  const f = fixture({ legacy: 'midnight' });
  const controller = initializeGameAppearance(f.document, { scope: 'lobby' });
  accepted(controller.select('paper')); accepted(controller.preset('builtin-paper-ocean'));
  accepted(controller.colors({ ink: '#123456' }));
  accepted(controller.select('glass')); accepted(controller.preset('builtin-glass-reading'));
  accepted(controller.background(7)); accepted(controller.palette('amber'));
  accepted(controller.select('soft')); accepted(controller.preset('builtin-soft-sage'));
  accepted(controller.colors({ ink: '#abcdef' }));
  const before = controller.state();
  accepted(controller.defaultPreset()); const selected = controller.state();
  assert.equal(selected.activeStyle, 'soft'); assert.deepEqual(selected.sets.soft, createInitialAppearanceState().sets.soft);
  assert.equal(selected.presetIds.soft, 'builtin-soft-quiet');
  for (const styleId of ['paper', 'glass']) {
    assert.deepEqual(selected.sets[styleId], before.sets[styleId]); assert.equal(selected.presetIds[styleId], before.presetIds[styleId]);
  }
  assert.deepEqual(accepted(validateAppearanceState(JSON.parse(f.records.get(APPEARANCE_STORAGE_KEY)))), selected);
  accepted(controller.reset()); const reset = controller.state();
  assert.deepEqual(reset, createInitialAppearanceState());
  assert.notDeepEqual(reset.sets.paper, before.sets.paper); assert.notDeepEqual(reset.sets.glass, before.sets.glass);
  assert.deepEqual(accepted(validateAppearanceState(JSON.parse(f.records.get(APPEARANCE_STORAGE_KEY)))), reset);
  assert.equal(f.root.dataset.gameAppearance, 'soft'); assert.equal(f.style.get('--appearance-accent'), '#027f6e');
  assert.equal(f.records.get('game-room.theme.v1'), 'midnight'); assert(f.writes.every(write => write.key === APPEARANCE_STORAGE_KEY));
  controller.destroy();
});

test('legacy selection exits the new appearance without overwriting legacy preference or the existing theme tokens', () => {
  const f = fixture({ legacy: 'sand' });
  const old = initializeGameTheme(f.document), originalTokens = legacyValues(f);
  const controller = initializeGameAppearance(f.document, { scope: 'army-flip' });
  accepted(controller.select('glass'));
  f.document.emit('click', { target: { closest: selector => selector === '[data-theme-choice]' ? {} : null } });
  assert.equal(controller.state().activeStyle, null); assert.equal(old.current(), 'sand');
  assert.equal(f.root.dataset.gameTheme, 'sand'); assert.equal(f.meta.content, themeById('sand').base);
  assert.deepEqual(legacyValues(f), originalTokens); assert.equal(f.records.get('game-room.theme.v1'), 'sand');
  accepted(controller.select('soft'));
  f.document.emit('change', { target: { matches: selector => selector === '[data-catalog-theme],#catalog-theme' } });
  assert.equal(controller.state().activeStyle, null); assert.deepEqual(legacyValues(f), originalTokens);
  assert(f.writes.every(write => write.key === APPEARANCE_STORAGE_KEY)); controller.destroy();
});

test('render projection omits spacing, font sizing and motion geometry while retaining portable token values', () => {
  const state = accepted(chooseAppearance(createDefaultAppearanceState(), 'glass'));
  const original = appearancePaint(state), tuned = clone(state);
  tuned.sets.glass.tokens.gap = 28; tuned.sets.glass.tokens.fontSize = 19; tuned.sets.glass.tokens.distance = 12;
  assert.deepEqual(appearancePaint(tuned), original);
  assert.equal(tuned.sets.glass.tokens.gap, 28); assert.equal(tuned.sets.glass.tokens.fontSize, 19);
  for (const preset of APPEARANCE_PRESETS) {
    const candidate = accepted(chooseAppearance(createDefaultAppearanceState(), preset.styleId)); candidate.sets[preset.styleId] = clone(preset);
    const paint = appearancePaint(candidate);
    assert(!Object.keys(paint.values).some(key => /gap|font|padding|margin|transform|translate|scale|distance|width|height/i.test(key)));
  }
  assert.equal(appearancePaint(createDefaultAppearanceState()), null);
  assert.throws(() => appearancePaint({ version: 2 }), TypeError);
});

test('reduced transparency, unsupported filters and reduced motion update the real controller without storage writes', () => {
  const f = fixture(), controller = initializeGameAppearance(f.document, { scope: 'flying-chess' });
  accepted(controller.select('glass')); const writes = f.writes.length;
  assert.equal(f.root.dataset.appearanceFallback, 'none'); assert.equal(f.style.get('--appearance-blur'), '16px');
  f.preference('(prefers-reduced-transparency: reduce)', true);
  assert.equal(f.root.dataset.appearanceFallback, 'opaque'); assert.equal(f.style.get('--appearance-blur'), '0px');
  assert.match(f.style.get('--appearance-panel'), /96%/);
  f.preference('(prefers-reduced-motion: reduce)', true); assert.equal(f.style.get('--appearance-duration'), '0ms');
  f.preference('(prefers-reduced-transparency: reduce)', false); assert.equal(f.style.get('--appearance-blur'), '16px');
  f.preference('(prefers-reduced-motion: reduce)', false); assert.equal(f.style.get('--appearance-duration'), '240ms');
  assert.equal(f.writes.length, writes); controller.destroy();
  const unsupported = fixture({ supportsFilter: false });
  const fallback = initializeGameAppearance(unsupported.document, { scope: 'catalog' }); accepted(fallback.select('glass'));
  assert.equal(unsupported.root.dataset.appearanceFallback, 'opaque'); assert.equal(unsupported.style.get('--appearance-blur'), '0px');
  fallback.destroy();
});

test('functional overlays use the lab reading floor, distinguish both opaque fallbacks and remove the projection on legacy selection', () => {
  const f = fixture(), controller = initializeGameAppearance(f.document, { scope: 'draw-and-guess' });
  const state = accepted(chooseAppearance(createDefaultAppearanceState(), 'glass'));
  Object.assign(state.sets.glass.tokens, { surface: '#f0f2f4', opacity: 10, protection: 20 });
  accepted(controller.replace(state));
  const projected = () => f.style.get('--appearance-functional-surface');
  const percentage = () => Number(projected().match(/ (\d+(?:\.\d+)?)%,transparent\)$/)?.[1]);
  assert.match(projected(), /^color-mix\(in srgb,#f0f2f4 /);
  assert(Math.abs(percentage() - 80.1) < 1e-10, 'the lab overlay is stronger than its large glass panel');
  assert.notEqual(projected(), f.style.get('--appearance-panel'));
  Object.assign(state.sets.glass.tokens, { opacity: 30, protection: 50 }); accepted(controller.replace(state));
  assert(Math.abs(percentage() - 83.6) < 1e-10, 'opacity and protection still tune the reading floor');
  const beforePreferences = f.writes.length;
  f.preference('(prefers-reduced-transparency: reduce)', true); assert.equal(percentage(), 97);
  assert.equal(f.style.get('--appearance-blur'), '0px');
  f.preference('(prefers-reduced-transparency: reduce)', false); assert(Math.abs(percentage() - 83.6) < 1e-10);
  assert.equal(f.writes.length, beforePreferences);
  for (const material of ['paper', 'soft']) { accepted(controller.select(material)); assert.equal(projected(), controller.state().sets[material].tokens.surface); }
  accepted(controller.select(null)); assert.equal(projected(), undefined); assert.deepEqual(paintValues(f), {}); assert.equal(f.style.has('--glass-blur'), false);
  controller.destroy(); assert.equal(f.listeners(), 0);
  const unsupported = fixture({ supportsFilter: false }), fallback = initializeGameAppearance(unsupported.document, { scope: 'catalog' });
  accepted(fallback.select('glass')); assert.match(unsupported.style.get('--appearance-functional-surface'), / 96%,transparent\)$/);
  const writes = unsupported.writes.length;
  unsupported.preference('(prefers-reduced-transparency: reduce)', true); assert.match(unsupported.style.get('--appearance-functional-surface'), / 97%,transparent\)$/);
  unsupported.preference('(prefers-reduced-transparency: reduce)', false); assert.match(unsupported.style.get('--appearance-functional-surface'), / 96%,transparent\)$/);
  assert.equal(unsupported.writes.length, writes); accepted(fallback.select(null)); assert.equal(unsupported.style.has('--appearance-functional-surface'), false);
  fallback.destroy(); assert.equal(unsupported.listeners(), 0);
});

test('Sanguosha initialization and picker perform zero document, DOM or storage access', () => {
  let accesses = 0;
  const forbidden = new Proxy({}, { get() { accesses++; throw new Error('SGS must be excluded before document access'); } });
  assert.equal(initializeGameAppearance(forbidden, { scope: 'sanguosha' }), null);
  const remove = mountGameAppearancePicker(forbidden, forbidden, { scope: 'sanguosha' });
  assert.equal(typeof remove, 'function'); remove(); assert.equal(accesses, 0);
});

test('unsubscribe, destruction and page lifecycle release owned listeners and cannot commit stale operations', () => {
  const f = fixture(), controller = initializeGameAppearance(f.document, { scope: 'poker414-2' });
  const snapshots = [], unsubscribe = controller.subscribe((state, issue) => snapshots.push({ state, issue }));
  accepted(controller.select('paper')); assert.equal(snapshots.length, 2);
  unsubscribe(); accepted(controller.select('soft')); assert.equal(snapshots.length, 2);
  const listeners = f.listeners(); assert(listeners > 0);
  f.win.emit('pagehide', { persisted: true }); assert.equal(f.listeners(), listeners);
  f.win.emit('pageshow', { persisted: true }); assert.equal(controller.state().activeStyle, 'soft');
  const before = controller.state(), writes = f.writes.length;
  controller.destroy(); controller.destroy(); assert.equal(f.listeners(), 0);
  f.win.emit('storage', { key: APPEARANCE_STORAGE_KEY, storageArea: f.storage, newValue: null });
  f.document.emit('click', { target: { closest: () => ({}) } }); controller.refresh();
  assert.deepEqual(controller.state(), before); assert.equal(f.writes.length, writes); assert.throws(() => controller.select('glass'), /关闭/);
  const remounted = initializeGameAppearance(f.document, { scope: 'poker414-2' }); assert.notEqual(remounted, controller);
  assert.equal(remounted.state().activeStyle, 'soft'); assert.equal(f.writes.length, writes);
  f.win.emit('pagehide', { persisted: false }); assert.equal(f.listeners(), 0);
  assert.throws(() => remounted.select('paper'), /关闭/);
});

test('repeated real settings and appearance mounting restores the six-card owner, original controls and exact listener baseline', t => {
  const document = drawingTestDOM('<head><meta name="theme-color" content="#173a31"></head><body><header id="header"><button id="settings">设置</button><button id="sound">声音</button><input id="volume"><button id="chat">聊天</button></header><dialog id="settings-dialog"><div class="game-settings-body"><div id="audio-slot"></div></div><button id="settings-close">关闭</button></dialog></body>');
  const records = new Map(), media = new Map(), writes = [];
  const window = Object.assign(new EventTarget(), { navigator: {}, CSS: { supports: () => true }, localStorage: {
    getItem: key => records.get(key) ?? null, setItem(key, value) { records.set(key, value); writes.push({ key, value }); },
  }, matchMedia(query) { if (!media.has(query)) media.set(query, Object.assign(new EventTarget(), { matches: false })); return media.get(query); } });
  document.defaultView = window;
  const header = document.getElementById('header'), originalOrder = [...header.children];
  const sound = document.getElementById('sound'), volume = document.getElementById('volume'), chat = document.getElementById('chat');
  let toggles = 0, volumeChanges = 0;
  const toggle = () => { toggles++; }, changeVolume = () => { volumeChanges++; };
  sound.addEventListener('click', toggle); volume.addEventListener('input', changeVolume); volume.value = '37';
  t.after(() => { sound.removeEventListener('click', toggle); volume.removeEventListener('input', changeVolume); });
  const types = ['click', 'input', 'change', 'close', 'cancel', 'keydown', 'storage', 'pageshow', 'pagehide', 'visibilitychange'];
  const count = targets => targets.reduce((total, target) => total + types.reduce((sum, type) => sum + getEventListeners(target, type).length, 0), 0);
  // The minimal selector implementation deliberately avoids a '*' parser.
  const allNodes = root => [root, ...root.children.flatMap(allNodes)];
  const totalListeners = () => count([document, window, ...media.values(), ...allNodes(document.documentElement)]);
  const originalListeners = totalListeners();
  for (let cycle = 0; cycle < 3; cycle++) {
    const settings = mountRoomSettings({ document, buttonId: 'settings', dialogId: 'settings-dialog', closeButtonId: 'settings-close',
      controlIds: [{ id: 'sound', containerId: 'audio-slot' }, { id: 'volume', containerId: 'audio-slot' }] });
    const dialog = document.getElementById('settings-dialog'), section = dialog.querySelector('[data-theme-picker]');
    const cards = section.querySelectorAll('[data-theme-choice]'), note = section.querySelector('.theme-note'), originalNote = note.textContent;
    section.hidden = cycle === 1; const originallyHidden = section.hidden, settingsListeners = totalListeners();
    const remove = mountGameAppearancePicker(document, dialog, { scope: 'rummikub' });
    const controller = initializeGameAppearance(document, { scope: 'rummikub' });
    accepted(controller.select('glass')); accepted(controller.preset('builtin-glass-reading')); accepted(controller.background(6));
    assert.equal(section.hidden, false); assert.equal(dialog.querySelector('[data-open-appearance]').nextSibling, section);
    assert.deepEqual(section.querySelectorAll('[data-theme-choice]'), cards); assert(cards.every(card => card.getAttribute('aria-pressed') === 'false'));
    const mountedListeners = totalListeners(), menu = document.getElementById('appearance-dialog'), menuNodes = allNodes(menu);
    const duplicateRemove = mountGameAppearancePicker(document, dialog, { scope: 'rummikub' }); duplicateRemove();
    assert.equal(totalListeners(), mountedListeners); assert.equal(dialog.querySelectorAll('[data-open-appearance]').length, 1);
    sound.dispatchEvent(new Event('click')); volume.dispatchEvent(new Event('input'));
    assert.equal(toggles, cycle * 2 + 1); assert.equal(volumeChanges, cycle * 2 + 1); assert.equal(volume.value, '37');
    assert.equal(document.getElementById('sound'), sound); assert.equal(sound.parentNode, document.getElementById('audio-slot')); assert.equal(chat.parentNode, header);
    remove(); remove();
    assert.equal(totalListeners(), settingsListeners); assert.equal(count(menuNodes), 0, 'detached menu releases its actual node listeners');
    assert.equal(document.getElementById('appearance-dialog'), null); assert.equal(dialog.querySelector('[data-open-appearance]'), null);
    assert.equal(section.hidden, originallyHidden); assert.equal(note.textContent, originalNote); assert.throws(() => controller.select('paper'), /关闭/);
    // Appearance teardown leaves both the original picker subscription and its
    // original six button handlers alive until their settings owner destroys it.
    const legacy = initializeGameTheme(document); legacy.set('wine');
    assert.equal(cards.filter(card => card.getAttribute('aria-pressed') === 'true').length, 1);
    const oldChoice = cards.find(card => card.dataset.themeChoice === 'blueprint');oldChoice.dispatchEvent(new Event('click'));
    assert.equal(legacy.current(), 'blueprint'); assert.equal(oldChoice.getAttribute('aria-pressed'), 'true'); assert.equal(note.textContent, originalNote);
    assert.equal(getEventListeners(oldChoice, 'click').length, 1);
    settings.open(); assert.equal(dialog.open, true); settings.destroy(); settings.destroy();
    assert.deepEqual(header.children, originalOrder); assert.equal(document.getElementById('sound'), sound); assert.equal(document.getElementById('volume'), volume);
    assert.equal(totalListeners(), originalListeners); assert.equal(count(allNodes(section)), 0);
    sound.dispatchEvent(new Event('click')); volume.dispatchEvent(new Event('input'));
    assert.equal(toggles, cycle * 2 + 2); assert.equal(volumeChanges, cycle * 2 + 2); assert.equal(volume.value, '37');
  }
  assert(writes.some(write => write.key === APPEARANCE_STORAGE_KEY)); assert.equal(records.get('game-room.theme.v1'), 'blueprint');
});
