import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startHyakkiPreview } from './hyakki-preview.mjs';
import { publicAssetPaths } from '../server/public-assets.mjs';

const assetBase = new URL('../app/assets/hyakki/v1/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', assetBase), 'utf8'));

test('百鬼十二项主体齐备且与版本清单逐文件匹配，正式目录未开放', async () => {
  assert.equal(manifest.entries.length, 12);
  assert.equal(new Set(manifest.entries.map(entry => entry.id)).size, 12);
  let total = 0;
  for (const entry of manifest.entries) {
    const bytes = await readFile(new URL(entry.file, assetBase));
    assert.equal(bytes.length, entry.bytes, entry.id);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.id);
    assert(entry.width >= 64 && entry.height >= 64);
    total += bytes.length;
  }
  assert.equal(total, manifest.totalBytes);
  assert.equal(publicAssetPaths().some(path => path.includes('hyakki')), false);
});

test('本机双入口供给完整资源，拒绝写入、错误Host与非白名单私有文件', async () => {
  const preview = await startHyakkiPreview({ port: 0 });
  try {
    assert.equal(preview.server.address().address, '127.0.0.1');
    for (const prefix of ['', '/game']) {
      for (const asset of ['hyakki-preview.html', 'hyakki-catalog.html', ...manifest.entries.map(entry => `assets/hyakki/v1/${entry.file}`)]) {
        const response = await fetch(`${preview.origin}${prefix}/${asset}`);
        assert.equal(response.status, 200, prefix + asset);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        await response.arrayBuffer();
      }
      for (const path of ['.env', 'server/config.mjs', 'ops/production-readiness.json', 'games/hyakki-trading/content.test.mjs', 'assets/hyakki/v1/manifest.json']) {
        const response = await fetch(`${preview.origin}${prefix}/${path}`);
        assert.equal(response.status, 404, path); await response.text();
      }
    }
    const write = await fetch(preview.origin, { method: 'POST', body: 'no mutation' });
    assert.equal(write.status, 405); await write.text();
    const wrongHost = await new Promise((accept, reject) => {
      get(preview.origin, { headers: { Host: 'other.example' } }, response => { response.resume(); accept(response.statusCode); }).once('error', reject);
    });
    assert.equal(wrongHost, 403);
  } finally { await preview.close(); }
});
