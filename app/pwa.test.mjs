import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { isStandalone, installationSteps, toggleFullscreen } from './app-shell.mjs';

const app = new URL('./', import.meta.url);
test('install metadata and real PNG sizes are shared by every entry; practice restart stays in header', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', app), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'landscape');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  for (const [filename, size] of [['icons/icon-192.png', 192], ['icons/icon-512.png', 512], ['icons/apple-touch-icon.png', 180]]) {
    const png = await readFile(new URL(filename, app));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  for (const filename of ['index.html', 'practice.html', 'room.html']) {
    const html = await readFile(new URL(filename, app), 'utf8');
    assert.equal((html.match(/rel="manifest"/g) || []).length, 1);
    assert.match(html, /rel="apple-touch-icon"/);
    assert.match(html, /src="\.\/app-shell\.mjs"/);
    assert.match(html, /href="\.\/app-shell\.css"/);
    if (filename !== 'index.html') assert.match(html, /<main>\s*<p class="orientation-hint"/);
    if (filename === 'practice.html') {
      assert.equal((html.match(/id="restart"/g) || []).length, 1);
      assert.match(html.match(/<header[\s\S]*?<\/header>/)[0], /id="restart"/);
    }
  }
});

test('installed mode covers browser display-mode and iOS; guides recognize desktop-mode iPad', () => {
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) }), true);
  assert.equal(isStandalone({ navigator: { standalone: true }, matchMedia: () => ({ matches: false }) }), true);
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) }), false);
  const ipad = installationSteps({ userAgent: 'Safari', platform: 'MacIntel', maxTouchPoints: 5 });
  assert.equal(ipad.label, 'iPhone / iPad');
  assert.ok(ipad.steps.some((step) => step.includes('分享')));
  assert.ok(installationSteps({ userAgent: 'Android Chrome' }).steps.some((step) => step.includes('安装应用')));
});

test('fullscreen requires supported invocation; rejected request keeps a friendly desktop-entry fallback', async () => {
  let entered = 0, exited = 0;
  const documentRef = { fullscreenEnabled: false, fullscreenElement: null,
    documentElement: { requestFullscreen: async () => { entered += 1; } },
    exitFullscreen: async () => { exited += 1; } };
  const unavailable = await toggleFullscreen(documentRef);
  assert.equal(unavailable.ok, false);
  assert.equal(entered, 0);
  documentRef.fullscreenEnabled = true;
  assert.deepEqual(await toggleFullscreen(documentRef), { ok: true, active: true });
  assert.equal(entered, 1);
  documentRef.fullscreenElement = {};
  assert.deepEqual(await toggleFullscreen(documentRef), { ok: true, active: false });
  assert.equal(exited, 1);
  documentRef.fullscreenElement = null;
  documentRef.documentElement.requestFullscreen = async () => { throw new Error('private engine error'); };
  const rejected = await toggleFullscreen(documentRef);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /桌面/);
  assert.ok(!rejected.message.includes('private engine error'));
});

async function worker(fetchImplementation, workerUrl = 'http://127.0.0.1:4177/sw.js') {
  const listeners = new Map();
  let storageTouched = false;
  const context = { Response, URL, fetch: fetchImplementation,
    self: { location: { origin: new URL(workerUrl).origin, href: workerUrl }, addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => {}, clients: { claim: async () => {} } } };
  Object.defineProperty(context, 'caches', { get() { storageTouched = true; throw new Error('Cache Storage must remain unused'); } });
  vm.runInNewContext(await readFile(new URL('sw.js', app), 'utf8'), context);
  const dispatch = (url, method = 'GET', mode = 'navigate') => {
    let response;
    listeners.get('fetch')({ request: { url, method, mode }, respondWith: (value) => { response = value; } });
    return response;
  };
  return { dispatch, listeners, storageTouched: () => storageTouched };
}

test('worker leaves OAuth redirects, API, assets, POST and foreign origins to the browser without touching Cache Storage', async () => {
  let calls = 0;
  const sw = await worker(async () => { calls += 1; throw new Error('should not fetch'); });
  assert.equal(sw.dispatch('http://127.0.0.1:4177/api/rooms/123456'), undefined);
  assert.equal(sw.dispatch('http://127.0.0.1:4177/api/rooms/123456/events', 'GET', 'cors'), undefined);
  assert.equal(sw.dispatch('http://127.0.0.1:4177/auth/login?returnTo=%2F'), undefined);
  assert.equal(sw.dispatch('http://127.0.0.1:4177/auth/callback?code=synthetic&state=synthetic'), undefined);
  assert.equal(sw.dispatch('http://127.0.0.1:4177/auth/logout'), undefined);
  assert.equal(sw.dispatch('http://127.0.0.1:4177/app.mjs', 'GET', 'cors'), undefined);
  assert.equal(sw.dispatch('http://127.0.0.1:4177/api/rooms', 'POST'), undefined);
  assert.equal(sw.dispatch('https://another.example/'), undefined);
  for (const type of ['install', 'activate']) {
    let task;
    sw.listeners.get(type)({ waitUntil: (promise) => { task = promise; } });
    await task;
  }
  assert.equal(calls, 0);
  assert.equal(sw.storageTouched(), false);
});

test('navigation is network-only; network failure provides a self-contained offline page without game data', async () => {
  const latest = new Response('latest page');
  let options;
  const online = await worker(async (_request, config) => { options = config; return latest; });
  assert.equal(await online.dispatch('http://127.0.0.1:4177/room.html?room=123456'), latest);
  assert.equal(options.cache, 'no-store');
  const offline = await worker(async () => { throw new TypeError('network offline'); });
  const response = await offline.dispatch('http://127.0.0.1:4177/room.html?room=123456');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /暂时连不上棋牌室/);
  assert.match(html, /重试进入大厅/);
  assert.ok(!html.includes('123456'));
  assert.ok(!html.includes('Authorization'));
  assert.ok(!html.includes('<script'));
  assert.equal(offline.storageTouched(), false);
});

test('mounted worker leaves Agora/calendar/root auth and private APIs untouched, handles only game navigation without shared cache', async () => {
  let calls = 0;
  const sw = await worker(async () => { calls++; throw new TypeError('synthetic offline'); }, 'https://agora.sumomoli.com/game/sw.js');
  for (const path of ['/', '/calendar/', '/api/identity', '/auth/callback', '/game/api',
    '/game/api/rooms/123456/events', '/game/auth', '/game/auth/callback', '/gamex/room.html', '/game/%2fauth/login']) {
    assert.equal(sw.dispatch('https://agora.sumomoli.com' + path), undefined, path);
  }
  assert.equal(calls, 0);
  const response = await sw.dispatch('https://agora.sumomoli.com/game/room.html?code=123456');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /href="\/game\/"/);
  assert.ok(!html.includes('123456'));
  assert.equal(calls, 1);
  assert.equal(sw.storageTouched(), false);
});

test('worker served from an unsupported project path never intercepts its pages or touches cache', async () => {
  const sw = await worker(async () => { throw new Error('must not fetch'); }, 'https://agora.sumomoli.com/calendar/sw.js');
  assert.equal(sw.dispatch('https://agora.sumomoli.com/calendar/'), undefined);
  assert.equal(sw.storageTouched(), false);
});
