import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {gamePresentation} from './games/catalog.mjs';
import {readSettings} from '../server/config.mjs';
import {createRuntime} from '../server/runtime.mjs';
import {createUnifiedServer} from '../server/unified-http.mjs';
import {EncryptedStore,MemoryAdapter} from '../server/storage.mjs';
import {MockProvider} from '../server/auth.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const privatePaths=['parks-preview.html','games/parks/engine.mjs','games/parks/preview.mjs','games/parks/page-ui.mjs','games/parks/preview-fixtures.mjs','games/parks/domain-modes.test.mjs','games/parks/test-support/domain-fixtures.mjs','server/games/parks/adapter.mjs'];
function request(base, path, host) {
  return new Promise((accept, reject) => {
    const outgoing = http.get(base + path, { headers: { Host: host } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => accept({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    }); outgoing.on('error', reject);
  });
}

test('PARKS direct and mounted entries serve the full exact asset closure while excluding private engine, previews and tests', async t => {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_PARKS_ENABLED: '1' });
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
    for (const file of [...gamePresentation('parks').assets, 'platform/game-stage-fit.mjs']) {
      const result = await request(base, entry.basePath + file, host);
      assert.equal(result.status, 200, entry.basePath + file);
      assert.deepEqual(result.bytes, readFileSync(join(root, 'app', file)), file);
      if (file.endsWith('.webp')) assert.equal(result.headers['content-type'], 'image/webp');
    }
    for (const file of privatePaths) assert.equal((await request(base, entry.basePath + file, host)).status, 404, file);
  }
});
