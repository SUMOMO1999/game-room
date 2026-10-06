import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRoomStore, RoomError } from './rooms.mjs';
import { readSettings } from '../server/config.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { publicAssetPaths } from '../server/public-assets.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Set(publicAssetPaths());
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
function reply(res, status, body, extra = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}
function requireLocalHost(req) {
  const host = req.headers.host;
  const match = typeof host === 'string' && /^(127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/.exec(host);
  if (!match || Number(match[2] || 80) !== req.socket.localPort) {
    throw new RoomError(403, 'INVALID_HOST', '请通过本机预览地址访问。');
  }
  if (req.headers.origin && req.headers.origin !== `http://${host}`) {
    throw new RoomError(403, 'INVALID_ORIGIN', '请求必须来自当前本机页面。');
  }
  if (req.method === 'POST' && req.headers.origin !== `http://${host}`) {
    throw new RoomError(403, 'INVALID_ORIGIN', '操作必须来自当前本机页面。');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new RoomError(403, 'INVALID_ORIGIN', '请求必须来自当前本机页面。');
  }
}
function bearer(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization || '');
  if (!match) throw new RoomError(401, 'INVALID_TOKEN', '需要你的席位凭证，请先加入房间。');
  return match[1];
}
async function readJson(req) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) {
    throw new RoomError(415, 'JSON_REQUIRED', '请求需要使用 JSON 格式。');
  }
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 32768)) {
    req.resume();
    throw new RoomError(413, 'BODY_TOO_LARGE', '请求内容过大。');
  }
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      req.off('data', onData); req.off('end', onEnd);
      req.off('aborted', onAbort); req.off('error', onError);
      if (error) {
        req.once('error', () => {});
        req.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > 32768) finish(new RoomError(413, 'BODY_TOO_LARGE', '请求内容过大。'));
      else chunks.push(chunk);
    }
    function onEnd() { finish(); }
    function onAbort() { finish(new RoomError(400, 'BODY_ABORTED', '请求已中断。')); }
    function onError() { finish(new RoomError(400, 'BODY_ABORTED', '请求已中断。')); }
    req.on('data', onData); req.on('end', onEnd);
    req.on('aborted', onAbort); req.on('error', onError);
  });
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RoomError(400, 'INVALID_JSON', '请求内容不是有效的 JSON 对象。'); }
}
function makeLimiter() {
  const buckets = new Map();
  return (key, limit) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.since >= 60000) {
      bucket = { since: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 1024) {
      for (const [entry, value] of buckets) if (now - value.since >= 60000) buckets.delete(entry);
      if (buckets.size > 1024) buckets.delete(buckets.keys().next().value);
    }
    if (bucket.count > limit) throw new RoomError(429, 'RATE_LIMIT', '操作太频繁，请稍后再试。');
  };
}

export function createServer(options = {}) {
  const settings=options.settings || readSettings();
  return settings.mode==='legacy' ? createLegacyServer(options) : createUnifiedServer({...options,settings});
}
function createLegacyServer({ store = createRoomStore() } = {}) {
  const limit = makeLimiter();
  const server = http.createServer(async (req, res) => {
    try {
      requireLocalHost(req);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.searchParams.has('token') || url.searchParams.has('authorization')) {
        throw new RoomError(400, 'TOKEN_IN_URL', '席位凭证不能放在网址中。');
      }
      const pathname = url.pathname;
      const isApi = pathname === '/api/rooms' || pathname.startsWith('/api/rooms/');
      if (isApi) {
        limit(`ip:${req.socket.remoteAddress}`, 240);
        const route = /^\/api\/rooms\/(\d{6})(?:\/(join|events|actions))?$/.exec(pathname);
        if (pathname === '/api/rooms') {
          if (req.method !== 'POST') return reply(res, 405, { error: '请使用 POST 创建房间。' }, { Allow: 'POST' });
          limit(`create:${req.socket.remoteAddress}`, 20);
          const body = await readJson(req);
          if (Object.keys(body).some((key) => !['name','gameType'].includes(key))) throw new RoomError(400, 'INVALID_BODY', '创建房间只需要称呼和游戏类型。');
          return reply(res, 201, store.createRoom(body.name,{gameType:body.gameType}));
        }
        if (!route) return reply(res, 404, { error: '接口不存在。', code: 'NOT_FOUND' });
        const [, code, endpoint] = route;
        const allowedMethod = endpoint === 'join' || endpoint === 'actions' ? 'POST' : 'GET';
        if (req.method !== allowedMethod) return reply(res, 405, { error: '请求方法不支持。' }, { Allow: allowedMethod });
        if (endpoint === 'join') {
          limit(`join:${req.socket.remoteAddress}`, 40);
          const body = await readJson(req);
          if (Object.keys(body).some((key) => !['name','role'].includes(key))) throw new RoomError(400, 'INVALID_BODY', '加入房间只需要称呼与参与方式。');
          return reply(res, 201, store.joinRoom(code, body.name,{role:body.role}));
        }
        const token = bearer(req);
        let action;
        if (endpoint === 'actions') {
          action = await readJson(req);
          // A confirmed departure no longer has a seat. The room engine
          // authenticates its retained receipt for exact leave retries; the
          // existing per-IP limit still applies without allocating token keys.
          if (action.type === 'leave') return reply(res, 200, store.action(code, token, action));
        }
        // Authenticate before allocating a per-token rate bucket.
        store.getView(code, token);
        limit(`token:${createHash('sha256').update(token).digest('hex')}`, 120);
        if (endpoint === 'actions') return reply(res, 200, store.action(code, token, action));
        if (endpoint === 'events') {
          let active = false;
          const pending = [];
          const sendView = (view) => {
            if (!active) { pending.push(view); return; }
            if (res.writableLength > 131072) { res.destroy(); return; }
            if (!res.destroyed) res.write(`event: view\ndata: ${JSON.stringify(view)}\n\n`);
          };
          const unsubscribe = store.subscribe(code, token, sendView, (message) => {
            if (!res.destroyed) {
              res.write(`event: closed\ndata: ${JSON.stringify({ error: message })}\n\n`);
              res.end();
            }
          });
          res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          active = true;
          for (const view of pending) sendView(view);
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 20000);
          heartbeat.unref();
          res.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
          return;
        }
        return reply(res, 200, { view: store.getView(code, token) });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: '请求方法不支持。' }, { Allow: 'GET, HEAD' });
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!publicFiles.has(filename)) return reply(res, 404, { error: '页面不存在。' });
      let body;
      try { body = await readFile(path.join(root, filename)); }
      catch (error) {
        if (error.code === 'ENOENT') return reply(res, 404, { error: '页面尚未建立。' });
        throw error;
      }
      res.writeHead(200, { ...headers, 'Content-Type': mime[path.extname(filename)] });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const known = error instanceof RoomError;
      reply(res, known ? error.status : 500, { error: known ? error.message : '本机服务暂时无法完成操作。',
        code: known ? error.code : 'INTERNAL_ERROR' });
    }
  });
  const cleanup = setInterval(() => store.sweep(), 60000);
  cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); store.close(); });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = readSettings();
  const server = createServer({settings});
  server.on('error', (error) => { console.error(`Local preview failed: ${error.message}`); process.exitCode = 1; });
  server.listen(settings.port, settings.host, () => console.log(`棋牌室 ${settings.mode}: ${settings.origin}`));
  for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{ if(server.shutdown) server.shutdown();else server.close(); });
}
