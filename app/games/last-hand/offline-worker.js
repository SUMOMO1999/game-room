const scope = new URL(self.registration.scope);
const build = new URL(self.location.href).searchParams.get('build');
const family = 'sumomo-last-hand:' + scope.pathname + ':';
const cacheName = family + build;
const manifestUrl = new URL('./offline-list.json', scope);
const entryUrl = new URL('./index.html', scope);

self.addEventListener('install', event => event.waitUntil((async () => {
  const response = await fetch(manifestUrl, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw Error('离线牌桌目录暂时不可用');
  const manifest = await response.json();
  if (!build || manifest.build !== build) throw Error('牌桌正在更新');
  const cache = await caches.open(cacheName);
  try {
    await cache.addAll(manifest.urls.map(file => new Request(new URL(file, scope), {
      cache: 'reload', credentials: 'omit', redirect: 'error',
    })));
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }
  const previous = self.registration.active?.scriptURL;
  if (previous && manifest.upgradeFrom?.includes(new URL(previous).searchParams.get('build'))) {
    await self.skipWaiting();
  }
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) {
    if (key.startsWith(family) && key !== cacheName) await caches.delete(key);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scope.origin ||
      url.href === manifestUrl.href || url.pathname.endsWith('/offline-worker.js') ||
      /\/(?:api|auth|voice)\//.test(url.pathname)) return;
  const isTable = request.mode === 'navigate' && url.pathname === entryUrl.pathname;
  if (request.mode === 'navigate' && !isTable) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return (await cache.match(isTable ? entryUrl.href : request)) || fetch(request);
  })());
});
