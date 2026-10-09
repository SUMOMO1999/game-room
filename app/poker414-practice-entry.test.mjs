import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAssetPaths } from '../server/public-assets.mjs';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';
import { MockProvider } from '../server/auth.mjs';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const entryPage = 'poker414-practice.html';
const enginePath = 'games/poker414-2/practice-engine.mjs';
function imports(source) {
  return [
    /^\s*import\s*(?:[^;]*?\bfrom\s*)?(['"])([^'"]+)\1/gm,
    /^\s*export\s+(?:\{[^}]*\}|\*)\s+from\s*(['"])([^'"]+)\1/gm,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ].flatMap(pattern => [...source.matchAll(pattern)].map(match => match[2]));
}
async function closure(entry, allowed = new Set(publicAssetPaths())) {
  const files = new Map();
  async function visit(file) {
    assert.ok(allowed.has(file), `Unpublished browser dependency: ${file}`);
    assert.ok(!/(?:^|\/)(?:server|test-support|fixtures|ops)\/|\.test\.mjs$/u.test(file), file);
    if (files.has(file)) return;
    const source = await readFile(path.join(appRoot, file), 'utf8'); files.set(file, source);
    const dependencies = file.endsWith('.html')
      ? [...source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)].map(match => match[1])
      : imports(source);
    for (const specifier of dependencies) {
      assert.match(specifier, /^\.\.?\//u, `Browser dependencies must be local: ${specifier}`);
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      assert.ok(!dependency.startsWith('../'), `Dependency escapes app: ${dependency}`);
      await visit(dependency);
    }
  }
  await visit(entry); return files;
}
function get(base, entry, file) {
  const prefix = entry.basePath === '/' ? '/' : entry.basePath;
  return new Promise((resolve, reject) => {
    http.get(`${base}${prefix}${file}`, { headers: { Host: new URL(entry.origin).host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

test('414 practice imports the published real engine and bot without server or accounting dependencies', async () => {
  const pageFiles = await closure(entryPage);
  for (const file of [enginePath, 'games/poker414-2/rules.mjs', 'games/poker414-2/practice-bot.mjs',
    'games/poker414-2/page-ui.mjs', 'platform/practice-navigation.mjs']) assert.ok(pageFiles.has(file), file);
  assert.ok(pageFiles.size > 10, 'Inspect the actual page and common controls, not a substitute entry');
  const engineFiles = await closure(enginePath);
  for (const [file, source] of engineFiles) {
    assert.ok(file.startsWith('games/poker414-2/'), `Practice engine escapes its isolated game: ${file}`);
    assert.equal(/\b(?:fetch|XMLHttpRequest|EventSource|RoomClient|AccountClient)\s*\(/u.test(source), false, file);
    assert.equal(/(?:\/api\/|\/auth\/)/u.test(source), false, file);
  }
  const missing = new Set(publicAssetPaths()); missing.delete('games/poker414-2/rules.mjs');
  await assert.rejects(closure(entryPage, missing), /Unpublished browser dependency: games\/poker414-2\/rules\.mjs/);
});

test('anonymous direct and mounted practice pages and full import closure are served without creating accounts, rooms or scores', async t => {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_ORIGIN: 'http://127.0.0.1:39071',
    GAME_ROOM_POKER414_ENABLED: '0' });
  const entries = [{ id: 'direct', origin: settings.origin, basePath: '/' },
    { id: 'agora', origin: 'http://127.0.0.1:39072', basePath: '/game/' }];
  const adapter = new MemoryAdapter(), storage = new EncryptedStore(adapter, randomBytes(32));
  const provider = new MockProvider(settings); let identityCalls = 0;
  for (const method of ['begin', 'complete', 'check']) provider[method] = async () => { identityCalls++; throw new Error('Practice must not use identity'); };
  const runtime = createRuntime(settings, { storage, provider, roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  await runtime.rooms.ready;
  await runtime.wordbankReady;
  const server = createUnifiedServer({ ...runtime, entries });
  t.after(() => server.shutdown());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, before = structuredClone([...adapter.records]);
  const files = await closure(entryPage);
  for (const file of ['styles.css', 'app-shell.css', 'platform/room-settings.css', 'games/poker414-2/styles.css']) {
    files.set(file, await readFile(path.join(appRoot, file), 'utf8'));
  }
  for (const entry of entries) {
    for (const [file, source] of files) {
      const response = await get(base, entry, file);
      assert.equal(response.status, 200, `${entry.id}/${file}`);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers.location, undefined);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.text, source, `${entry.id}/${file} has the real registered source`);
    }
    for (const file of ['games/poker414-2/rules.test.mjs', 'games/poker414-2/practice-bot.test.mjs',
      'server/games/poker414-2/adapter.mjs', 'games/army-flip/rules.mjs', 'poker414-preview.html',
      'games/poker414-2/preview.mjs', 'games/poker414-2/test-support/preview-fixtures.mjs']) {
      assert.equal((await get(base, entry, file)).status, 404, `${entry.id}/${file}`);
    }
  }
  assert.equal(identityCalls, 0);
  assert.deepEqual([...adapter.records], before, 'Serving practice must not write an identity, room or permanent score');
});
