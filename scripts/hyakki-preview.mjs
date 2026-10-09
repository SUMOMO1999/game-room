import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAssetPaths } from '../server/public-assets.mjs';

const APP_ROOT = fileURLToPath(new URL('../app/', import.meta.url));
const PREVIEW_ASSETS = [
  'hyakki-preview.html', 'hyakki-catalog.html',
  ...['content.mjs', 'reference-content.mjs', 'art.mjs', 'card-ui.mjs', 'card.css', 'catalog.mjs', 'catalog.css', 'preview.mjs', 'page-ui.mjs', 'styles.css', 'test-support/preview-fixtures.mjs'].map(file => `games/hyakki-trading/${file}`),
  ...['cucumber', 'aburaage', 'lantern', 'fox-fur', 'tengu-feather', 'spirit-stone'].map(id => `assets/hyakki/v1/${id}.svg`),
  ...['festival', 'theft', 'talisman', 'auction', 'stall-permit', 'card-back'].map(id => `assets/hyakki/v1/${id}.webp`),
];
const ASSETS = new Set([...publicAssetPaths(), ...PREVIEW_ASSETS]);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
const ROOT_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>百鬼商会 · 本地Step 0</title><style>body{font:17px/1.8 system-ui;background:#172c35;color:#f1e4cd;margin:0;padding:8vw}main{max-width:45em;margin:auto}a{display:inline-block;color:#172c35;background:#ead6ad;border-radius:10px;padding:10px 18px;margin:8px 12px 0 0;text-decoration:none}small{color:#c7cbbf}</style><main><p>HYAKKI TRADING · STEP 0</p><h1>百鬼商会</h1><p>资源与真实共通控件的本地样板。房号、身份、聊天和牌局全部是合成数据；未接入正式房间、账号或完整规则引擎。</p><p>房间样板请横屏使用；图鉴按截图和补充规则展示五类牌；旧稿120张副本单独保留，完整卡库待补。</p><a href="./hyakki-preview.html?enter=1">打开房间样板</a><a href="./hyakki-catalog.html">查看分类图鉴</a><p><small>仅监听127.0.0.1 · 不写生产数据库 · 不执行云操作</small></p></main></html>`;
function send(response, status, data, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' });
  response.end(data);
}
/** Exact local whitelist. Prefix /game/ exercises the same relative imports. */
export async function startHyakkiPreview({ port = 4381 } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('本地合成样板禁止以production模式启动。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('端口必须为0～65535的整数。');
  let origin;
  const server = createServer(async (request, response) => {
    try {
      if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== new URL(origin).host) return send(response, 403, '仅允许本机访问。');
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, '本地静态样板只接受读取。');
      const url = new URL(request.url, origin);
      if (url.origin !== origin) return send(response, 403, '仅允许本机预览地址。');
      if (url.pathname === '/' || url.pathname === '/game/') return send(response, 200, request.method === 'HEAD' ? '' : ROOT_HTML, MIME['.html']);
      const pathname = decodeURIComponent(url.pathname);
      const path = pathname.startsWith('/game/') ? pathname.slice(6) : pathname.slice(1);
      if (!ASSETS.has(path)) return send(response, 404, '该资源不在本地预览白名单。');
      const content = await readFile(resolve(APP_ROOT, path));
      send(response, 200, request.method === 'HEAD' ? '' : content, MIME[extname(path)] || 'application/octet-stream');
    } catch (error) { send(response, error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500, '本地资源暂时不可用。'); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 40;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, close: () => new Promise((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); }) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await startHyakkiPreview({ port: Number(process.env.PORT || 4381) });
  console.log(`百鬼商会本地样板：${result.origin}/hyakki-preview.html`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await result.close(); process.exit(0); });
}
