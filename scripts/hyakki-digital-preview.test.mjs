import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { ASSETS, CARD_FACES } from '../app/games/hyakki-trading/content/manifest.mjs';
import { CARDS } from '../app/games/hyakki-trading/content/definitions.mjs';
import { publicAssetPaths } from '../server/public-assets.mjs';
import { startHyakkiPreview } from './hyakki-preview.mjs';

test('新版全量卡面都能解析到已制资源，旧实验不能冒充新版', async () => {
  assert.equal(CARDS.length, 51);
  assert.equal(CARD_FACES.length, 51);
  assert.equal(ASSETS.length, 39);
  assert.equal(new Set(ASSETS.map(asset => asset.id)).size, 39);
  const ids = new Set(ASSETS.map(asset => asset.id));
  for (const face of CARD_FACES) {
    assert(face.assetIds.length > 0, face.cardId);
    assert(face.assetIds.every(id => ids.has(id)), face.cardId);
    assert(face.textFallback.length > 0, face.cardId);
  }
  for (const asset of ASSETS) {
    const bytes = await readFile(new URL(`../app/assets/hyakki/v2/${asset.file}`, import.meta.url));
    assert(bytes.length > 300, asset.file);
    if (asset.file.endsWith('.webp')) {
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', asset.file);
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', asset.file);
    } else {
      assert.match(bytes.toString(), /<svg[^>]+viewBox=/u, asset.file);
    }
  }
  assert.equal(publicAssetPaths().some(path => path.includes('hyakki')), false,
    'S0本地样板不能顺便开放生产入口或资料');
});

test('新版两个本地路径可读真实卡面和模块，私有来源与测试仍不可下载', async () => {
  const preview = await startHyakkiPreview({ port: 0 });
  try {
    for (const prefix of ['', '/game']) {
      for (const path of [
        'hyakki-preview.html', 'hyakki-catalog.html',
        'games/hyakki-trading/content/definitions.mjs',
        'games/hyakki-trading/content/manifest.mjs',
        'games/hyakki-trading/digital-preview.mjs',
        'games/hyakki-trading/digital-catalog-page.mjs',
        ...ASSETS.map(asset => `assets/hyakki/v2/${asset.file}`),
      ]) {
        const response = await fetch(`${preview.origin}${prefix}/${path}`);
        assert.equal(response.status, 200, prefix + path);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        await response.arrayBuffer();
      }
      for (const path of [
        '.env', 'server/config.mjs', 'docs/proposals/hyakki-trading/physical-card-catalog.json',
        'ops/yousei-photos-2026-10-10/inventory.json',
        'games/hyakki-trading/content/definitions.test.mjs',
        'assets/hyakki/v2/manifest.json',
      ]) {
        const response = await fetch(`${preview.origin}${prefix}/${path}`);
        assert.equal(response.status, 404, prefix + path);
        await response.text();
      }
    }
  } finally {
    await preview.close();
  }
});
