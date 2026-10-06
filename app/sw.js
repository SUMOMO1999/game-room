// No Cache Storage: all game assets, APIs and credentials remain network-only.
const OFFLINE_PAGE = "<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"><meta name=\"theme-color\" content=\"#f5f3ec\"><title>暂时离线 · 棋牌室</title><style>html{font-family:system-ui,sans-serif;color:#15171b;background:#f5f3ec}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;box-sizing:border-box}main{width:min(100%,380px)}.mark{display:grid;place-items:center;width:54px;height:68px;border-radius:8px;background:#fffaf0;border:1px solid #dedacb;font-size:40px;font-weight:700;color:#315b50}h1{font-size:25px;font-weight:500;margin:27px 0 15px}p{font-size:14px;line-height:1.9;color:#707b70}a{display:inline-block;color:#fffaf0;background:#315b50;border-radius:8px;padding:13px 20px;margin-top:15px;text-decoration:none}a:focus-visible{outline:2px solid #005bd7;outline-offset:4px}</style></head><body><main><span class=\"mark\" aria-hidden=\"true\">3</span><h1>暂时连不上棋牌室。</h1><p>朋友局需要网络连接。联网后返回大厅，再恢复你的座位。</p><a href=\"./\">重试进入大厅 →</a></main></body></html>\n";
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const mount = new URL('./', self.location.href).pathname;
  const url = new URL(request.url);
  const logicalPath = url.pathname.slice(mount.length - 1);
  if (request.method !== 'GET' || request.mode !== 'navigate'
      || !['/', '/game/'].includes(mount) || url.origin !== self.location.origin || !url.pathname.startsWith(mount)
      || /%(?:2f|5c|2e)/i.test(url.pathname) || logicalPath === '/api' || logicalPath.startsWith('/api/')
      || logicalPath === '/auth' || logicalPath.startsWith('/auth/')) return;
  const offlinePage = mount === '/' ? OFFLINE_PAGE : OFFLINE_PAGE.replace('href="./"', 'href="/game/"');
  event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => new Response(offlinePage, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff' },
  })));
});
