import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  APPEARANCE_STYLES, APPEARANCE_PRESETS, APPEARANCE_SCHEMA, GLASS_BACKGROUNDS,
  createDefaultAppearanceState, createInitialAppearanceState, chooseDefaultAppearance, validateAppearanceState, validateLibrarySet,
  chooseAppearance, choosePreset, updateAppearanceColors, chooseGlassBackground,
  COLOR_PALETTES, paletteColors, chooseColorPalette, currentColorPalette, safeAppearancePanelColors,
  hexToRgb, rgbToHex, contrastRatio, contrastingForeground,
} from './platform/appearance-data.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const accepted = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const rejected = (result, code) => { assert.equal(result.ok, false); if (code) assert.equal(result.error.code, code); assert.equal(typeof result.error.message, 'string'); };
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const active = styleId => accepted(chooseAppearance(createDefaultAppearanceState(), styleId));

test('the copied schema, nine complete presets and eight environments match the captured upstream contract', () => {
  assert.deepEqual(APPEARANCE_STYLES.map(style => style.id), ['paper', 'glass', 'soft']);
  assert.equal(digest(APPEARANCE_SCHEMA), '246066afc7b66155c82a932a4e874922b53802dcaf478c3dd3a82b71be0246e5');
  assert.equal(digest(APPEARANCE_PRESETS), '605464805c2a07ca0c573c035aaa08c7d4354e70eb3e072d322efd8e96cd1d34');
  assert.equal(digest(GLASS_BACKGROUNDS), '9ab075c28e9da4e12a792eb674d0b5d3ce74670c8a060a2347c914799c4c6981');
  assert.equal(APPEARANCE_PRESETS.length, 9);
  for (const style of APPEARANCE_STYLES) {
    assert.equal(APPEARANCE_PRESETS.filter(set => set.styleId === style.id).length, 3);
    for (const set of APPEARANCE_PRESETS.filter(set => set.styleId === style.id)) {
      assert.deepEqual(accepted(validateLibrarySet(set)), set);
      assert.equal(Object.keys(set.tokens).length, style.id === 'glass' ? 19 : 10);
      assert.deepEqual(accepted(validateLibrarySet(JSON.parse(JSON.stringify(set)))), set);
    }
  }
  assert(Object.isFrozen(APPEARANCE_PRESETS[0].tokens));
  assert(Object.isFrozen(APPEARANCE_SCHEMA.glass.find(control => control.key === 'background').options));
});

test('default state leaves the existing theme active and owns independent working copies', () => {
  const first = createDefaultAppearanceState(), second = createDefaultAppearanceState();
  assert.equal(first.version, 2);
  assert.equal(first.activeStyle, null);
  assert.deepEqual(first.presetIds, { paper: 'builtin-paper-editorial', glass: 'builtin-glass-daylight', soft: 'builtin-soft-quiet' });
  for (const set of Object.values(first.sets)) { assert.equal(set.version, 1); assert(!Object.hasOwn(set, 'presetIds')); }
  assert.deepEqual(accepted(validateAppearanceState(first)), first);
  first.sets.paper.tokens.accent = '#123456';
  assert.equal(second.sets.paper.tokens.accent, '#80024e');
  assert.equal(APPEARANCE_PRESETS[0].tokens.accent, '#80024e');
});

test('a fresh initial appearance matches the accepted quiet-soft green default without changing the explicit legacy constructor', () => {
  const original = createDefaultAppearanceState(), initial = createInitialAppearanceState(), another = createInitialAppearanceState();
  assert.equal(original.activeStyle, null); assert.equal(initial.activeStyle, 'soft');
  assert.equal(initial.presetIds.soft, 'builtin-soft-quiet'); assert.equal(currentColorPalette(initial), 'green');
  assert.deepEqual(initial.sets.soft.tokens, {
    radius: 18, gap: 18, accent: '#027f6e', ink: '#1a211e', muted: '#5f6563', surface: '#e6e9e8',
    motion: 1, duration: 240, easing: 0, distance: 6,
  });
  assert.deepEqual(initial.sets.paper, original.sets.paper); assert.deepEqual(initial.sets.glass, original.sets.glass);
  assert.deepEqual(accepted(validateAppearanceState(initial)), initial);
  initial.sets.soft.tokens.accent = '#123456'; initial.sets.paper.tokens.accent = '#abcdef';
  assert.equal(another.sets.soft.tokens.accent, '#027f6e'); assert.equal(another.sets.paper.tokens.accent, '#80024e');
  assert.deepEqual(createDefaultAppearanceState(), original);
});

test('explicit default selection restores only the soft working copy and preserves other materials and their provenance', () => {
  let state = active('paper');
  state = accepted(choosePreset(state, 'builtin-paper-ocean'));
  state = accepted(updateAppearanceColors(state, { ink: '#123456' }));
  state = accepted(chooseAppearance(state, 'glass')); state = accepted(choosePreset(state, 'builtin-glass-reading'));
  state = accepted(chooseGlassBackground(state, 7)); state = accepted(chooseColorPalette(state, 'amber'));
  state = accepted(chooseAppearance(state, 'soft')); state = accepted(choosePreset(state, 'builtin-soft-sage'));
  state = accepted(updateAppearanceColors(state, { ink: '#abcdef' }));
  const before = frozen(state), changed = accepted(chooseDefaultAppearance(before));
  assert.equal(changed.activeStyle, 'soft'); assert.deepEqual(changed.sets.soft, createInitialAppearanceState().sets.soft);
  assert.deepEqual(changed.presetIds, { ...before.presetIds, soft: 'builtin-soft-quiet' });
  for (const styleId of ['paper', 'glass']) assert.deepEqual(changed.sets[styleId], before.sets[styleId]);
  assert.deepEqual(accepted(validateAppearanceState(JSON.parse(JSON.stringify(changed)))), changed);
  assert.deepEqual(accepted(chooseDefaultAppearance(changed)), changed);
  rejected(chooseDefaultAppearance({ version: 99 }), 'state-schema');
});

test('the new initial default does not reinterpret valid v1/v2 saved choices or persisted explicit legacy state', () => {
  for (const styleId of [null, 'paper', 'glass', 'soft']) {
    let saved = accepted(chooseAppearance(createDefaultAppearanceState(), styleId));
    if (styleId !== null) {
      saved = accepted(updateAppearanceColors(saved, { accent: '#123456' }));
      if (styleId === 'glass') saved = accepted(chooseGlassBackground(saved, 6));
    }
    const before = clone(saved), legacy = { version: 1, activeStyle: saved.activeStyle, sets: clone(saved.sets) };
    createInitialAppearanceState();
    const restored = accepted(validateAppearanceState(JSON.parse(JSON.stringify(saved))));
    assert.deepEqual(restored, before);
    const migrated = accepted(validateAppearanceState(legacy));
    assert.equal(migrated.activeStyle, styleId); assert.deepEqual(migrated.sets, before.sets);
    assert.deepEqual(saved, before);
  }
});

test('switching appearances and returning to the legacy theme retains each material colors and background', () => {
  let state = active('paper');
  state = accepted(updateAppearanceColors(state, { accent: '#123456', surface: '#fafafa' }));
  const paper = clone(state.sets.paper);
  state = accepted(chooseAppearance(state, 'glass'));
  state = accepted(updateAppearanceColors(state, { ink: '#234567', muted: '#345678' }));
  state = accepted(chooseGlassBackground(state, 7));
  const glass = clone(state.sets.glass);
  state = accepted(chooseAppearance(state, 'soft'));
  state = accepted(updateAppearanceColors(state, { accent: '#456789' }));
  const soft = clone(state.sets.soft);
  state = accepted(chooseAppearance(state, null));
  assert.equal(state.activeStyle, null);
  for (const styleId of ['paper', 'glass', 'soft', 'glass', 'paper']) {
    state = accepted(chooseAppearance(state, styleId));
    assert.deepEqual(state.sets, { paper, glass, soft });
  }
  assert.deepEqual(accepted(validateAppearanceState(JSON.parse(JSON.stringify(state)))), state);
});

test('a preset resets only the active material and rejects mismatched or unknown selections', () => {
  let state = active('glass');
  state = accepted(updateAppearanceColors(state, { accent: '#123456' }));
  state = accepted(chooseGlassBackground(state, 6));
  state = accepted(chooseAppearance(state, 'paper'));
  state = accepted(updateAppearanceColors(state, { accent: '#abcdef' }));
  state = accepted(chooseAppearance(state, 'glass'));
  const paper = clone(state.sets.paper), soft = clone(state.sets.soft);
  const changed = accepted(choosePreset(state, 'builtin-glass-reading'));
  assert.deepEqual(changed.presetIds, { ...state.presetIds, glass: 'builtin-glass-reading' });
  assert.deepEqual(changed.sets.glass, APPEARANCE_PRESETS.find(set => set.id === 'builtin-glass-reading'));
  assert.deepEqual(changed.sets.paper, paper); assert.deepEqual(changed.sets.soft, soft);
  rejected(choosePreset(state, 'builtin-paper-editorial'), 'preset');
  rejected(choosePreset(state, 'missing'), 'preset');
  rejected(choosePreset(createDefaultAppearanceState(), 'builtin-glass-daylight'), 'preset');
});

test('color edits become deterministic custom working sets without changing unrelated settings or the input', () => {
  const original = frozen(active('glass'));
  const changed = accepted(updateAppearanceColors(original, { accent: '#ABCDEF', surface: '#fefefe' }));
  assert.deepEqual(changed.presetIds, original.presetIds);
  assert.equal(changed.sets.glass.id, 'custom-glass-local');
  assert.equal(changed.sets.glass.origin, 'custom');
  assert.deepEqual(changed.sets.glass.tokens, { ...original.sets.glass.tokens, accent: '#ABCDEF', surface: '#fefefe' });
  assert.deepEqual(changed.sets.paper, original.sets.paper); assert.deepEqual(changed.sets.soft, original.sets.soft);
  assert.equal(changed.sets.glass.createdAt, original.sets.glass.createdAt);
  assert.equal(changed.sets.glass.updatedAt, original.sets.glass.updatedAt);
  assert.deepEqual(changed, accepted(updateAppearanceColors(original, { accent: '#ABCDEF', surface: '#fefefe' })));
  assert.deepEqual(accepted(updateAppearanceColors(original, { accent: original.sets.glass.tokens.accent })), original);
  const imported = clone(changed); imported.sets.glass.id = 'my-import'; imported.sets.glass.name = '我的玻璃';
  const edited = accepted(updateAppearanceColors(imported, { ink: '#010203' }));
  assert.equal(edited.sets.glass.id, 'my-import'); assert.equal(edited.sets.glass.name, '我的玻璃');
  accepted(validateAppearanceState(edited));
});

test('each glass background changes exactly the background token and keeps material, colors and other styles', () => {
  let state = active('glass');
  state = accepted(updateAppearanceColors(state, { accent: '#123456', ink: '#234567', muted: '#345678', surface: '#fafafa' }));
  const original = frozen(state);
  for (const id of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const changed = accepted(chooseGlassBackground(original, id));
    assert.deepEqual(changed.sets.glass.tokens, { ...original.sets.glass.tokens, background: id });
    assert.deepEqual(changed.sets.paper, original.sets.paper); assert.deepEqual(changed.sets.soft, original.sets.soft);
    assert.deepEqual({ ...changed.sets.glass, tokens: original.sets.glass.tokens }, original.sets.glass);
    accepted(validateAppearanceState(changed));
  }
  for (const id of [-1, 8, 0.5, '2', null, NaN, Infinity]) rejected(chooseGlassBackground(original, id), 'background');
  rejected(chooseGlassBackground(active('paper'), 3), 'style');
});

test('bad portable inputs are rejected without coercion, field dropping or unsupported specimen overrides', () => {
  const original = APPEARANCE_PRESETS.find(set => set.styleId === 'glass');
  const mutations = [
    set => { set.product = 'game-room'; }, set => { set.version = 2; }, set => { set.kind = 'theme'; },
    set => { set.styleId = 'unknown'; }, set => { set.origin = 'remote'; }, set => { set.id = 'bad id'; },
    set => { set.name = ' a'; }, set => { set.name = '<img>'; }, set => { set.name = 'a'.repeat(41); },
    set => { set.tokens.blur = '16'; }, set => { set.tokens.blur = 1.5; }, set => { set.tokens.blur = 31; },
    set => { set.tokens.background = 8; }, set => { set.tokens.motion = 3; }, set => { set.tokens.duration = 85; },
    set => { set.tokens.opacity = NaN; }, set => { set.tokens.accent = '#fff'; },
    set => { set.tokens.accent = '#ffffff;--x:url(x)'; }, set => { set.tokens.accent = 'red'; },
    set => { set.tokens.extra = 1; }, set => { delete set.tokens.gap; },
    set => { set.createdAt = '2026-10-15'; }, set => { set.createdAt = '2026-02-30T00:00:00.000Z'; },
    set => { set.updatedAt = '2026-10-14T00:00:00.000Z'; }, set => { set.overrides = { quiet: { radius: 10, depth: 5 } }; },
    set => { set.overrides = { arbitrary: {} }; }, set => { delete set.updatedAt; },
  ];
  for (const mutate of mutations) { const candidate = clone(original); mutate(candidate); rejected(validateLibrarySet(candidate)); }
  for (const value of [null, [], 'set', new Date(), Object.create({ ...original })]) rejected(validateLibrarySet(value));
  const unsupported = clone(original); unsupported.overrides = { quiet: { radius: 10 } };
  rejected(validateLibrarySet(unsupported), 'overrides');
  assert.deepEqual(unsupported.overrides, { quiet: { radius: 10 } });
});

test('strict state and operation boundaries preserve invalid source records and do not execute accessors', () => {
  const original = createDefaultAppearanceState();
  const mutations = [
    state => { state.version = '1'; }, state => { state.extra = true; }, state => { state.activeStyle = 'classic'; },
    state => { state.version = 3; }, state => { delete state.presetIds; },
    state => { state.presetIds.glass = 'builtin-paper-editorial'; }, state => { state.presetIds.paper = 'missing'; },
    state => { delete state.presetIds.soft; }, state => { state.presetIds.extra = null; },
    state => { delete state.sets.paper; }, state => { state.sets.unknown = state.sets.paper; },
    state => { state.sets.paper = clone(state.sets.soft); }, state => { state.sets.glass.tokens.background = 99; },
  ];
  for (const mutate of mutations) {
    const candidate = clone(original); mutate(candidate); const before = clone(candidate);
    rejected(validateAppearanceState(candidate)); rejected(chooseAppearance(candidate, 'paper'));
    assert.deepEqual(candidate, before);
  }
  const getter = clone(original); let accessed = false;
  Object.defineProperty(getter.sets.glass.tokens, 'background', { enumerable: true, get() { accessed = true; throw new Error('must not run'); } });
  rejected(validateAppearanceState(getter)); assert.equal(accessed, false);
  const stateGetter = clone(original);
  Object.defineProperty(stateGetter, 'sets', { enumerable: true, get() { throw new Error('must not run'); } });
  rejected(validateAppearanceState(stateGetter));
  for (const styleId of [undefined, 'unknown', 'toString', 1]) rejected(chooseAppearance(original, styleId), 'style');
  rejected(updateAppearanceColors(original, { accent: '#ffffff' }), 'style');
  const current = frozen(active('paper'));
  for (const colors of [{}, { background: '#ffffff' }, { accent: 'white' }, { accent: '#fff' }, { accent: '#ffffff', extra: '#000000' }, null, []]) rejected(updateAppearanceColors(current, colors), 'colors');
});

test('source preset identities survive continuous color/background edits, style changes and JSON cold recovery', () => {
  let state = createDefaultAppearanceState();
  const sources = { paper: 'builtin-paper-ocean', glass: 'builtin-glass-reading', soft: 'builtin-soft-sage' };
  for (const styleId of ['paper', 'glass', 'soft']) {
    state = accepted(chooseAppearance(state, styleId));
    state = accepted(choosePreset(state, sources[styleId]));
    for (const accent of ['#123456', '#345678', '#ABCDEF']) state = accepted(updateAppearanceColors(state, { accent }));
    if (styleId === 'glass') for (const background of [3, 6, 7]) state = accepted(chooseGlassBackground(state, background));
    assert.equal(state.sets[styleId].origin, 'custom');
    assert.equal(state.sets[styleId].id, 'custom-' + styleId + '-local');
    assert.equal(state.presetIds[styleId], sources[styleId]);
  }
  const snapshot = clone(state);
  for (const styleId of [null, 'paper', 'glass', 'soft']) state = accepted(chooseAppearance(state, styleId));
  assert.deepEqual(state.sets, snapshot.sets); assert.deepEqual(state.presetIds, sources);
  const restored = accepted(validateAppearanceState(JSON.parse(JSON.stringify(state))));
  assert.deepEqual(restored, state); assert.deepEqual(restored.presetIds, sources);
});

test('legacy v1 curated and uniquely identifiable custom sets migrate without changing saved visual data or identities', () => {
  for (const preset of APPEARANCE_PRESETS) {
    const legacy = { version: 1, activeStyle: preset.styleId, sets: clone(createDefaultAppearanceState().sets) };
    legacy.sets[preset.styleId] = clone(preset);
    const curated = accepted(validateAppearanceState(legacy));
    assert.equal(curated.version, 2); assert.equal(curated.presetIds[preset.styleId], preset.id);
    assert.deepEqual(curated.sets, legacy.sets);
    const custom = legacy.sets[preset.styleId];
    custom.id = 'old-custom-' + preset.styleId; custom.origin = 'custom'; custom.name = '旧自定名称';
    Object.assign(custom.tokens, { accent: '#010203', ink: '#123456', muted: '#234567', surface: '#345678' });
    if (preset.styleId === 'glass') custom.tokens.background = 7;
    const before = clone(legacy), migrated = accepted(validateAppearanceState(legacy));
    assert.equal(migrated.presetIds[preset.styleId], preset.id);
    assert.deepEqual(migrated.sets, before.sets); assert.deepEqual(legacy, before);
    assert.deepEqual(accepted(validateAppearanceState(JSON.parse(JSON.stringify(migrated)))), migrated);
    const edited = accepted(updateAppearanceColors(migrated, { accent: '#abcdef' }));
    assert.equal(edited.sets[preset.styleId].id, custom.id); assert.equal(edited.sets[preset.styleId].name, custom.name);
    assert.equal(edited.presetIds[preset.styleId], preset.id);
  }
});

test('unrecoverable legacy provenance stays explicitly null without nearest-preset guesses or token replacement', () => {
  const legacy = { version: 1, activeStyle: 'paper', sets: clone(createDefaultAppearanceState().sets) };
  Object.assign(legacy.sets.paper, { id: 'old-custom', name: '看似暖纸 · 原样', origin: 'custom' });
  legacy.sets.paper.tokens.radius = 7;
  const before = clone(legacy), migrated = accepted(validateAppearanceState(legacy));
  assert.equal(migrated.presetIds.paper, null); assert.deepEqual(migrated.sets, before.sets);
  const changed = accepted(updateAppearanceColors(migrated, { accent: '#010203' }));
  assert.equal(changed.presetIds.paper, null); assert.equal(changed.sets.paper.id, 'old-custom');
  assert.equal(accepted(validateAppearanceState(JSON.parse(JSON.stringify(changed)))).presetIds.paper, null);
  const selected = accepted(choosePreset(changed, 'builtin-paper-archive'));
  assert.equal(selected.presetIds.paper, 'builtin-paper-archive');
  const unknownCurated = clone(legacy); unknownCurated.sets.paper.origin = 'curated';
  assert.equal(accepted(validateAppearanceState(unknownCurated)).presetIds.paper, null);
  const badV1 = clone(legacy); badV1.presetIds = migrated.presetIds;
  rejected(validateAppearanceState(badV1), 'state-schema');
});

test('six palette constants and all eighteen style/color combinations preserve the shared-menu values', () => {
  assert.deepEqual(COLOR_PALETTES, [
    { id: 'plum', name: '梅紫', accent: '#80024e' }, { id: 'blue', name: '海蓝', accent: '#0d73cc' },
    { id: 'green', name: '松绿', accent: '#027f6e' }, { id: 'amber', name: '琥珀', accent: '#a56101' },
    { id: 'coral', name: '珊瑚', accent: '#d13415' }, { id: 'graphite', name: '石墨', accent: '#202020' },
  ]);
  const neutral = {
    plum: ['#211f26', '#65636d', '#faf9fb', '#eae7ec'], blue: ['#1c2024', '#60646c', '#f9f9fb', '#e8e8ec'],
    green: ['#1a211e', '#5f6563', '#f7f9f8', '#e6e9e8'], amber: ['#21201c', '#63635e', '#f9f9f8', '#e9e8e6'],
    coral: ['#211f26', '#65636d', '#faf9fb', '#eae7ec'], graphite: ['#202020', '#646464', '#f9f9f9', '#e8e8e8'],
  };
  for (const styleId of ['paper', 'glass', 'soft']) for (const palette of COLOR_PALETTES) {
    const [ink, muted, paper, soft] = neutral[palette.id];
    const colors = paletteColors(styleId, palette.id);
    assert.deepEqual(colors, { accent: palette.accent, ink, muted, surface: styleId === 'glass' ? '#ffffff' : styleId === 'soft' ? soft : paper });
    colors.accent = '#123456'; assert.equal(paletteColors(styleId, palette.id).accent, palette.accent);
  }
  assert(Object.isFrozen(COLOR_PALETTES[0]));
  for (const args of [['unknown', 'blue'], ['paper', 'ocean'], ['glass', 'pine'], ['paper', null]]) assert.equal(paletteColors(...args), null);
});

test('palette choices only replace the four active colors and retain source preset, material, background and other styles', () => {
  for (const styleId of ['paper', 'glass', 'soft']) {
    const preset = APPEARANCE_PRESETS.filter(set => set.styleId === styleId)[1];
    let state = accepted(choosePreset(active(styleId), preset.id));
    state = accepted(updateAppearanceColors(state, { accent: '#010203' }));
    if (styleId === 'glass') state = accepted(chooseGlassBackground(state, 6));
    const before = frozen(state), set = before.sets[styleId];
    for (const palette of COLOR_PALETTES) {
      const changed = accepted(chooseColorPalette(before, palette.id));
      assert.deepEqual(changed.sets[styleId].tokens, { ...set.tokens, ...paletteColors(styleId, palette.id) });
      assert.deepEqual(changed.presetIds, before.presetIds);
      assert.equal(changed.sets[styleId].id, set.id); assert.equal(changed.sets[styleId].name, set.name);
      for (const other of ['paper', 'glass', 'soft'].filter(id => id !== styleId)) assert.deepEqual(changed.sets[other], before.sets[other]);
      assert.equal(currentColorPalette(changed), palette.id);
      const restored = accepted(validateAppearanceState(JSON.parse(JSON.stringify(changed))));
      assert.deepEqual(restored, changed); assert.equal(currentColorPalette(restored), palette.id);
      if (styleId === 'glass') {
        const background = accepted(chooseGlassBackground(changed, 7));
        assert.deepEqual(background.sets.glass.tokens, { ...changed.sets.glass.tokens, background: 7 });
        assert.equal(currentColorPalette(background), palette.id); assert.deepEqual(background.presetIds, changed.presetIds);
      }
      const customized = accepted(updateAppearanceColors(changed, { ink: '#123456' }));
      assert.equal(currentColorPalette(customized), null);
      const uppercase = clone(changed);
      for (const key of ['accent', 'ink', 'muted', 'surface']) uppercase.sets[styleId].tokens[key] = uppercase.sets[styleId].tokens[key].toUpperCase();
      assert.equal(currentColorPalette(uppercase), palette.id);
    }
  }
  rejected(chooseColorPalette(active('paper'), 'unknown'), 'palette');
  rejected(chooseColorPalette(createDefaultAppearanceState(), 'plum'), 'style');
  assert.equal(currentColorPalette(createDefaultAppearanceState()), null); assert.equal(currentColorPalette({}), null);
});

test('five panel colors follow shared-menu contrast thresholds without changing extreme or normal product tokens', () => {
  for (const styleId of ['paper', 'glass', 'soft']) {
    for (const palette of COLOR_PALETTES) {
      const tokens = frozen(paletteColors(styleId, palette.id)), panel = safeAppearancePanelColors(tokens);
      assert.equal(panel.surface, tokens.surface);
      assert.equal(panel.ink, contrastRatio(tokens.ink, tokens.surface) >= 4.5 ? tokens.ink : contrastingForeground(tokens.surface));
      assert.equal(panel.muted, contrastRatio(tokens.muted, tokens.surface) >= 4.5 ? tokens.muted : contrastingForeground(tokens.surface));
      assert.equal(panel.accent, contrastRatio(tokens.accent, tokens.surface) >= 3 ? tokens.accent : contrastingForeground(tokens.surface));
    }
    for (const surface of ['#ffffff', '#000000', '#777777']) {
      let state = active(styleId);
      state = accepted(updateAppearanceColors(state, { surface, accent: surface, ink: surface, muted: surface }));
      const before = clone(state), panel = safeAppearancePanelColors(frozen(state.sets[styleId].tokens));
      assert.deepEqual(Object.keys(panel), ['surface', 'ink', 'muted', 'accent', 'onAccent']);
      assert.equal(panel.surface, surface);
      assert(contrastRatio(panel.ink, panel.surface) >= 4.5); assert(contrastRatio(panel.muted, panel.surface) >= 4.5);
      assert(contrastRatio(panel.accent, panel.surface) >= 3); assert(contrastRatio(panel.onAccent, panel.accent) >= 4.5);
      assert.deepEqual(state, before); assert.deepEqual(accepted(validateAppearanceState(state)), before);
    }
  }
  for (const tokens of [null, {}, { accent: 'red', ink: '#000000', muted: '#000000', surface: '#ffffff' }]) assert.throws(() => safeAppearancePanelColors(tokens), TypeError);
});

test('all environments remain bounded offline artwork without executable or remote references', () => {
  assert.deepEqual(GLASS_BACKGROUNDS.map(background => background.id), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const background of GLASS_BACKGROUNDS) {
    assert(!/https?:|@import|<script/i.test(background.background));
    assert(Buffer.byteLength(background.background) < 3000);
    for (const match of background.background.matchAll(/url\("([^"]+)"\)/g)) {
      assert(match[1].startsWith('data:image/svg+xml,'));
      const svg = decodeURIComponent(match[1].slice('data:image/svg+xml,'.length));
      assert(svg.includes('viewBox="0 0 1600 1000"'));
      assert(!/<script|on\w+=|href=|foreignObject/i.test(svg));
    }
  }
});

test('opaque foreground and contrast helpers preserve the source behavior without coercion', () => {
  assert.deepEqual(hexToRgb('#12aBef'), { r: 18, g: 171, b: 239 });
  assert.equal(rgbToHex({ r: 18, g: 171, b: 239 }), '#12abef');
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#abcdef', '#abcdef'), 1);
  assert.equal(contrastingForeground('#000000'), '#ffffff');
  assert.equal(contrastingForeground('#ffffff'), '#000000');
  for (const value of ['#fff', 'white', 3, null]) { assert.equal(hexToRgb(value), null); assert.equal(contrastingForeground(value), null); assert.equal(contrastRatio(value, '#ffffff'), null); }
  for (const value of [{ r: -1, g: 1, b: 2 }, { r: '1', g: 1, b: 2 }, { r: 1, g: 1 }, { r: 1, g: 2, b: 3, alpha: 1 }]) assert.equal(rgbToHex(value), null);
});
