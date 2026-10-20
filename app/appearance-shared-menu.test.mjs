import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAssetPaths } from '../server/public-assets.mjs';
import { releaseSources } from '../scripts/build-release.mjs';
import { APPEARANCE_MENU_HTML } from './platform/appearance-menu-template.mjs';

// Presentation-source integrity only. Real menu layout, scrolling, hit targets,
// focus and material appearance require independent browser observations.
const appRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(appRoot);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readApp = file => readFileSync(join(appRoot, file), 'utf8');
const sharedCssSha256 = '7c356c89fe1f25204e8f854dd30c98f9e440dfb2b7c1aa07b4b3839d8379f2a4';
const sharedMenuSha256 = '5371ac2634243fb1dbe0be9f465dae9f74cee908dc3f698ed5d2ef6673780b69';
// Canonical menu.html captured from the fixed shared-menu manifest, allowing the
// public test source to run without an Agora checkout or private ops directory.
const sharedMenuSource = "<dialog id=\"appearance-dialog\" class=\"appearance-dialog\" aria-labelledby=\"appearance-title\" aria-describedby=\"appearance-help\">\n  <div class=\"appearance-header\"><h2 id=\"appearance-title\">外观</h2><button class=\"appearance-close\" type=\"button\" data-close-appearance aria-label=\"关闭外观设置\">×</button></div>\n  <div class=\"appearance-body\">\n    <p id=\"appearance-help\">仅保存在当前设备的浏览器，不修改账号资料。</p>\n    <p id=\"appearance-current\">Agora 原样 · 纸感</p>\n    <fieldset><legend>外观</legend><div class=\"appearance-options\">\n      <label class=\"appearance-choice\"><input type=\"radio\" name=\"appearance-style\" value=\"paper\"><span class=\"appearance-style-swatch\" data-style-swatch=\"paper\" aria-hidden=\"true\"></span>纸感</label>\n      <label class=\"appearance-choice\"><input type=\"radio\" name=\"appearance-style\" value=\"glass\"><span class=\"appearance-style-swatch\" data-style-swatch=\"glass\" aria-hidden=\"true\"></span>玻璃</label>\n      <label class=\"appearance-choice\"><input type=\"radio\" name=\"appearance-style\" value=\"soft\"><span class=\"appearance-style-swatch\" data-style-swatch=\"soft\" aria-hidden=\"true\"></span>柔感</label>\n    </div></fieldset>\n    <fieldset><legend>预设</legend><label for=\"appearance-preset\" class=\"visually-hidden\">所选外观的预设</label><select id=\"appearance-preset\"></select><span id=\"appearance-modified\" class=\"appearance-modified\" hidden>已微调</span></fieldset>\n    <fieldset><legend>配色</legend><div id=\"appearance-palette-options\" class=\"appearance-palettes\"></div><details class=\"appearance-custom-colors\"><summary>自定义配色<span id=\"appearance-palette-name\" class=\"appearance-palette-name\"></span></summary><div class=\"appearance-colors\">\n      <label class=\"appearance-color\"><input id=\"appearance-accent\" type=\"color\" value=\"#80024e\" aria-label=\"强调色\"><span>强调色<output id=\"appearance-accent-value\">#80024E</output></span></label>\n      <label class=\"appearance-color\"><input id=\"appearance-ink\" type=\"color\" value=\"#343432\" aria-label=\"文字颜色\"><span>文字<output id=\"appearance-ink-value\">#343432</output></span></label>\n      <label class=\"appearance-color\"><input id=\"appearance-muted\" type=\"color\" value=\"#6b6b66\" aria-label=\"辅助文字颜色\"><span>辅助文字<output id=\"appearance-muted-value\">#6B6B66</output></span></label>\n      <label class=\"appearance-color\"><input id=\"appearance-surface\" type=\"color\" value=\"#fbfaf7\" aria-label=\"表面底色\"><span>表面底色<output id=\"appearance-surface-value\">#FBFAF7</output></span></label>\n    </div></details></fieldset>\n    <p id=\"appearance-contrast-note\" hidden>自定义配色对比偏低，设置面板已保持文字可读；页面配色保留。</p>\n    <fieldset id=\"appearance-backgrounds\" hidden><legend>玻璃背景</legend><p>只更换背景，保留当前颜色与材质。</p><div id=\"appearance-background-options\" class=\"appearance-backgrounds\"></div></fieldset>\n    <p id=\"appearance-status\" role=\"status\" aria-live=\"polite\"></p>\n  </div>\n  <div class=\"appearance-actions\"><button id=\"appearance-reset\" type=\"button\">恢复 Agora 原样</button><button class=\"appearance-done\" type=\"button\" data-close-appearance>完成</button></div>\n</dialog>\n";
// Explicit consumer differences: project name and the user's reset label.
// Device-help text and the remaining common DOM stay byte-for-byte identical.
const expectedMenu = sharedMenuSource.replaceAll('Agora', '棋牌室')
  .replace('恢复 棋牌室 原样', '恢复默认外观');
const menu = APPEARANCE_MENU_HTML;
const entries = new Map([
  ['index.html', 'lobby'], ['practice-hub.html', 'practice-hub'], ['words.html', 'wordbank'],
  ['room.html', 'rummikub'], ['practice.html', 'rummikub'],
  ['army.html', 'army-flip'], ['army-practice.html', 'army-flip'],
  ['flying.html', 'flying-chess'], ['flying-practice.html', 'flying-chess'],
  ['drawing.html', 'draw-and-guess'], ['drawing-practice.html', 'draw-and-guess'],
  ['poker414.html', 'poker414-2'], ['poker414-practice.html', 'poker414-2'],
  ['parks.html', 'parks'], ['parks-practice.html', 'parks'], ['parks-tutorial.html', 'parks'],
  ['hyakki-catalog.html', 'catalog'], ['parks-catalog.html', 'catalog'],
]);
const primaryStyles = new Map([
  ['styles.css', '6f824f8078c5455cf6d8e066d8509b98feb861b94270d2bc69df9a5c3e0d8057'],
  ['games/draw-and-guess/wordbank.css', '8613caf0444767e6692320ecd3b555278e4878833654ecac8cd46f6b95f44148'],
  ['games/hyakki-trading/digital-catalog.css', '06c398b7c9c1666b92acbeeb4e47150a376cc589affb5abf46238720bd0a47ff'],
]);
const primaryFor = file => file === 'words.html' ? 'games/draw-and-guess/wordbank.css'
  : file === 'hyakki-catalog.html' ? 'games/hyakki-trading/digital-catalog.css' : 'styles.css';
const assetPath = (reference, from) => new URL(reference, new URL(from, 'https://candidate.invalid/')).pathname.slice(1);
const legacyPins = new Map([
  ['platform/game-theme.css', '5e320b6ae24eff24d9fc7ae21dda7793d3bb92af61c1bdac4c8daa86d7568417'],
  ['platform/game-theme.mjs', '913c50c563450415dc0baddf15cc97a147c9c1a9bbb14ba3f7c89dd6ecb1da93'],
  ['platform/room-settings.css', 'd566cb502139819b6ab00a16c2498d941d34e8e9c6130cc1ae2f95fe3e68846f'],
  ['platform/room-settings.mjs', '28c370869a3ae73d2162cf95f4c1e503706a422c9fa44f88b3feb3e619003811'],
]);

test('each atomic primary CSS contains its pinned product base, canonical menu and current adapter in order', () => {
  const canonical = readFileSync(join(appRoot, 'platform/appearance-menu.css'));
  const adapter = readFileSync(join(appRoot, 'platform/game-appearance.css'));
  assert.equal(digest(canonical), sharedCssSha256);
  for (const [file, baselineSha] of primaryStyles) {
    const bytes = readFileSync(join(appRoot, file)), segments = []; let cursor = 0;
    for (const label of [file === 'games/draw-and-guess/wordbank.css' ? 'wordbank-usability-2026-10-17' : 'baseline-37493', 'shared-menu-v2', 'project-adapter']) {
      const begin = Buffer.from('/* BEGIN SUMOMO-APPEARANCE ' + label + ' */\n');
      const end = Buffer.from('\n/* END SUMOMO-APPEARANCE ' + label + ' */\n');
      assert(bytes.subarray(cursor, cursor + begin.length).equals(begin), file + ' begins the next declared section');
      const contentStart = cursor + begin.length, contentEnd = bytes.indexOf(end, contentStart);
      assert(contentEnd >= contentStart, file + ' has a complete ' + label + ' section');
      segments.push(bytes.subarray(contentStart, contentEnd)); cursor = contentEnd + end.length;
    }
    if(file === 'games/draw-and-guess/wordbank.css')assert.equal(digest(bytes.subarray(cursor)), '799b25a9ebd52246d7c273cac1d1d8e51a0845be170654d44b9defa670779d20', 'Published default-category addition stays exact');
    else assert.equal(cursor, bytes.length, file + ' contains no appended copies or undeclared CSS');
    assert.equal(digest(segments[0]), baselineSha, file + ' retains its pinned product base');
    assert.deepEqual(segments[1], canonical, file + ' retains canonical menu bytes');
    assert.deepEqual(segments[2], adapter, file + ' retains current adapter bytes');
    assert.doesNotMatch(bytes.toString(), /@import[^;]*(?:appearance-menu|game-appearance)\.css/i);
  }
});

test('menu template retains the canonical shared DOM with only explicit project wording replacements', () => {
  assert.equal(digest(Buffer.from(sharedMenuSource)), sharedMenuSha256);
  assert.equal(typeof menu, 'string', 'One shared dialog template is exported');
  assert.equal(menu, expectedMenu);
  assert.doesNotMatch(menu, /Agora/);
  assert.match(menu, /id="appearance-reset" type="button">恢复默认外观<\/button>/);
});

test('shared visible order and accessibility hooks remain available to the real controller', () => {
  assert.deepEqual([...menu.matchAll(/<legend>([^<]+)<\/legend>/g)].map(match => match[1]), ['外观', '预设', '配色', '玻璃背景']);
  assert.deepEqual([...menu.matchAll(/name="appearance-style" value="([^"]+)"/g)].map(match => match[1]), ['paper', 'glass', 'soft']);
  assert.match(menu, /aria-labelledby="appearance-title" aria-describedby="appearance-help"/);
  assert.match(menu, /<details class="appearance-custom-colors"><summary>自定义配色/);
  for (const role of ['accent', 'ink', 'muted', 'surface']) {
    assert.match(menu, new RegExp('id="appearance-' + role + '" type="color"'));
    assert.match(menu, new RegExp('id="appearance-' + role + '-value"'));
  }
  assert.match(menu, /id="appearance-palette-options" class="appearance-palettes"/);
  assert.match(menu, /<fieldset id="appearance-backgrounds" hidden>/);
  assert.match(menu, /id="appearance-background-options" class="appearance-backgrounds"/);
  assert.equal([...menu.matchAll(/data-close-appearance/g)].length, 2);
  assert.match(menu, /id="appearance-status" role="status" aria-live="polite"/);
  const ids = [...menu.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Shared dialog IDs remain unique');
});

test('all eighteen theme consumers request their own complete primary CSS with its exact content version', () => {
  assert.equal(entries.size, 18);
  for (const [file, scope] of entries) {
    const html = readApp(file), body = html.match(/<body\b[^>]*>/i)?.[0];
    const primary = primaryFor(file), hash = digest(readFileSync(join(appRoot, primary)));
    const expected = './' + primary + '?v=appearance-' + (file==='words.html'?'d3a7477efab0':hash.slice(0, 12));
    const styles = [...html.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => tag.match(/\bhref=["']([^"']+)["']/)?.[1]).filter(Boolean);
    const primaryLinks = styles.filter(reference => assetPath(reference, file) === primary);
    assert.deepEqual(primaryLinks, [expected], file + ' requests one correctly versioned primary stylesheet');
    assert.doesNotMatch(html, /href=["']\.\/platform\/(?:appearance-menu|game-appearance)\.css(?:[?"'])/);
    if (file === 'words.html' || file === 'hyakki-catalog.html') {
      assert.equal(styles.some(reference => assetPath(reference, file) === 'styles.css'), false, file + ' never gains the global layout baseline');
    }
    assert.match(body, new RegExp('data-appearance-scope="' + scope + '"'), file);
  }
});

test('opt-in entry inventory is exact and never includes Sanguosha or preview-only pages', () => {
  const optedIn = readdirSync(appRoot).filter(file => file.endsWith('.html') && /data-appearance-scope=/.test(readApp(file))).sort();
  assert.deepEqual(optedIn, [...entries.keys()].sort());
  assert.equal(optedIn.some(file => /sanguosha|preview/.test(file)), false);
  for (const file of readdirSync(appRoot).filter(file => file.endsWith('.html') && !entries.has(file))) {
    assert.doesNotMatch(readApp(file), /platform\/(?:appearance-menu\.css|appearance-menu-template\.mjs)/, file);
  }
});

test('shared menu adoption preserves the exact four published legacy theme and settings files', () => {
  for (const [file, sha256] of legacyPins) assert.equal(digest(readFileSync(join(appRoot, file))), sha256, file);
});

test('shared presentation assets and all opted-in HTML references remain in the public build closure', () => {
  const publicFiles = new Set(publicAssetPaths()), runtime = new Set(releaseSources(projectRoot));
  for (const file of ['platform/appearance-menu.css', 'platform/appearance-menu-template.mjs']) {
    assert(publicFiles.has(file), 'Shared asset is public: ' + file);
    assert(runtime.has('app/' + file), 'Shared asset is packaged: ' + file);
  }
  for (const file of entries.keys()) {
    assert(publicFiles.has(file), file); assert(runtime.has('app/' + file), file);
    for (const [tag] of readApp(file).matchAll(/<(?:link|script)\b[^>]*>/gi)) {
      const reference = tag.match(/(?:href|src)=["']([^"']+)["']/)?.[1];
      if (!reference) continue;
      assert(reference.startsWith('./'), file + ' uses a local public asset: ' + reference);
      const target = assetPath(reference, file);
      assert(publicFiles.has(target), file + ' → ' + target);
      assert(runtime.has('app/' + target), file + ' packages ' + target);
    }
  }
  assert.equal([...publicFiles, ...runtime].some(file => /sanguosha/.test(file)), false);
  assert.equal([...publicFiles].some(file => /(?:^|\/)(?:server|ops|specs|test-support|tests|fixtures)(?:\/|$)|\.test\.mjs$/.test(file)), false);
});
