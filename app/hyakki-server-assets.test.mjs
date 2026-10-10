import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { gamePresentation, creatableGamePresentations } from './games/catalog.mjs';
import { ASSETS } from './games/hyakki-trading/content/manifest.mjs';
import { publicAssetPaths } from '../server/public-assets.mjs';
import { releaseSources } from '../scripts/build-release.mjs';
import { readSettings, safeReturnTo } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';
import { MockProvider } from '../server/auth.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const privatePaths = ['hyakki-preview.html', 'parks-preview.html', 'parks-catalog.html',
  'games/hyakki-trading/digital-preview.mjs', 'games/hyakki-trading/test-support/contract-adapter.mjs',
  'games/hyakki-trading/validation-view.test.mjs', 'server/games/hyakki-trading/adapter.mjs',
  'assets/hyakki/v2/manifest.json', 'games/parks/content/catalog.mjs'];

test('Hyakki browser closure contains real room, practice, catalog and every art asset, while its release excludes experiments', () => {
  const assets = new Set(publicAssetPaths()), files = new Set(releaseSources(root));
  const hyakki = gamePresentation('hyakki-trading');
  assert.equal(creatableGamePresentations({ hyakkiEnabled: false }).includes(hyakki), false);
  assert.equal(creatableGamePresentations({ hyakkiEnabled: true }).includes(hyakki), true);
  assert.equal(safeReturnTo('/hyakki.html?code=123456', 'https://game.example'), '/hyakki.html?code=123456');
  for (const art of ASSETS) assert.ok(assets.has(`assets/hyakki/v2/${art.file}`));
  assert.equal(ASSETS.length, 39);
  for (const file of hyakki.assets) {
    assert.ok(files.has(`app/${file}`), file);
    if (!/\.(?:mjs|html|css)$/.test(file)) continue;
    const source = readFileSync(join(root, 'app', file), 'utf8');
    const references = file.endsWith('.mjs') ? [...source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)]
      : file.endsWith('.html') ? [...source.matchAll(/(?:src|href)=["'](\.[^"']+)["']/g)]
        : [...source.matchAll(/@import\s+["'](\.[^"']+)["']/g)];
    for (const match of references) {
      const dependency = relative(join(root, 'app'), resolve(root, 'app', dirname(file), match[1])) || 'index.html';
      assert.ok(assets.has(dependency), `${file} → ${dependency}`);
    }
  }
  for (const file of privatePaths) assert.equal(assets.has(file), false, file);
  assert.equal([...files].some(file => /(?:^|\/)parks(?:\/|-)|test-support|\.test\.mjs$|hyakki-preview|digital-preview/.test(file)), false);
  assert.ok(files.has('server/games/hyakki-trading/event-http.mjs'));
  assert.ok(files.has('server/games/hyakki-trading/adapter.mjs'));
});

function request(base, path, host) {
  return new Promise((accept, reject) => {
    const outgoing = http.get(base + path, { headers: { Host: host } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => accept({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    }); outgoing.on('error', reject);
  });
}

test('direct and /game/ entry serve exact Hyakki assets and WebP MIME, with private paths returning 404', async t => {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_HYAKKI_ENABLED: '1' });
  settings.origin = 'https://game.example';
  const storage = new EncryptedStore(new MemoryAdapter(), randomBytes(32));
  const runtime = createRuntime(settings, { storage, provider: new MockProvider(settings), roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  const entries = [{ id: 'direct', origin: 'https://game.example', basePath: '/' },
    { id: 'agora', origin: 'https://agora.example', basePath: '/game/' }];
  const server = createUnifiedServer({ ...runtime, entries });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await server.shutdown(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const entry of entries) {
    const host = new URL(entry.origin).host;
    for (const file of gamePresentation('hyakki-trading').assets) {
      const result = await request(base, entry.basePath + file, host);
      assert.equal(result.status, 200, entry.basePath + file);
      assert.deepEqual(result.bytes, readFileSync(join(root, 'app', file)), file);
      if (file.endsWith('.webp')) assert.equal(result.headers['content-type'], 'image/webp');
    }
    for (const file of privatePaths) assert.equal((await request(base, entry.basePath + file, host)).status, 404, file);
  }
});
