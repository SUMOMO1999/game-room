import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAssetPaths } from '../server/public-assets.mjs';
import { chatTextProblem } from '../app/room-chat.mjs';

// Synthetic fixtures only: no production room, identity, database or network
// client is assembled. The process owns and discards every preview message.
const APP_ROOT = fileURLToPath(new URL('../app/', import.meta.url));
const PREVIEW_ASSETS = [
  'parks-preview.html', 'parks-catalog.html',
  ...['card-ui.mjs', 'preview-fixtures.mjs', 'page-ui.mjs', 'preview.mjs', 'catalog-page.mjs', 'styles.css'].map(file => `games/parks/${file}`),
  ...['catalog', 'park-data', 'component-data', 'optional-data', 'passion-data', 'provenance', 'immutable', 'vector-art', 'asset-manifest', 'sample-assets'].map(file => `games/parks/content/${file}.mjs`),
  ...['park-arches', 'park-grand-teton', 'park-acadia', 'park-black-canyon-of-the-gunnison', 'gear-flint-and-tinder', 'gear-camp-mug'].map(file => `assets/parks/v1/${file}.png`),
];
const ASSETS = new Set([...publicAssetPaths(), ...PREVIEW_ASSETS]);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const ROOM_ID = 'parks-step0-room';
const MAX_MESSAGES = 500, MAX_STREAMS = 12, HEARTBEAT_MS = 15000;
const ROOT_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PARKS · 本地 Step 0</title>
<style>body{font:17px/1.8 system-ui;background:#e9eee4;color:#203c32;margin:0;padding:8vw}main{max-width:44em;margin:auto}a{display:inline-block;color:#fff;background:#315949;border-radius:10px;padding:12px 18px;margin:8px 12px 0 0;text-decoration:none}small{color:#51615b}</style>
<main><p>PARKS · STEP 0</p><h1>从这里出发</h1><p>这是资源、阅读布局与共通控件的本地合成样板，还不能按完整规则游玩。身份、房号、局面与聊天均为合成数据，未接正式账号或房间。</p>
<p>可打开两个成员窗口验证本机聊天。关闭服务会清除消息。</p><a href="./parks-preview.html?enter=1">进入样板 · 成员A</a><a href="./parks-preview.html?enter=1&amp;member=b">进入样板 · 成员B</a><a href="./parks-catalog.html">打开内容图鉴</a>
<p><small>仅监听127.0.0.1 · 不读取正式数据库 · 不执行云操作</small></p></main></html>`;
const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
function send(response, status, body, type = 'application/json; charset=utf-8', head = false) {
  response.writeHead(status, { ...responseHeaders, 'Content-Type': type });
  response.end(head ? undefined : typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
}
function memberQuery(params, { history = false } = {}) {
  const allowed = history ? ['member', 'before', 'after', 'limit'] : ['member'];
  for (const field of params.keys()) if (!allowed.includes(field) || params.getAll(field).length !== 1) {
    throw problem(400, 'INVALID_QUERY', '合成聊天参数无效。');
  }
  const member = params.get('member');
  if (!['a', 'b'].includes(member)) throw problem(400, 'INVALID_MEMBER', '请选择合成成员a或b。');
  const query = { limit: 100 };
  for (const field of ['before', 'after', 'limit']) if (params.has(field)) {
    const value = params.get(field);
    if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw problem(400, 'INVALID_QUERY', '聊天分页参数无效。');
    query[field] = Number(value);
  }
  if (query.limit < 1 || query.limit > 100 || query.before !== undefined && query.before < 1
      || query.before !== undefined && query.after !== undefined) throw problem(400, 'INVALID_QUERY', '聊天分页参数无效。');
  return { member, query };
}
async function readMessage(request) {
  const parts = []; let bytes = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    bytes += part.length;
    if (bytes > 4096) { request.resume(); throw problem(413, 'BODY_TOO_LARGE', '合成消息请求最多4096字节。'); }
    parts.push(part);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw problem(400, 'INVALID_JSON', '消息必须为JSON。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
      || !Object.hasOwn(body, 'text') || !Object.hasOwn(body, 'requestId')
      || typeof body.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(body.requestId)) {
    throw problem(400, 'INVALID_MESSAGE', '仅接受文字和有效请求编号。');
  }
  const textError = chatTextProblem(body.text);
  if (textError) throw problem(400, 'INVALID_CHAT_TEXT', textError);
  return { text: body.text.replace(/\r\n/g, '\n').normalize('NFC'), requestId: body.requestId };
}
function createSyntheticChat() {
  const now = Date.now();
  const messages = [{ messageId: 'parks-preview-message-1', chatSequence: 1, playerId: 'parks-preview-b',
    name: '伙伴（合成B）', text: '你好，这是本机合成聊天；一起看看PARKS样板吧。', sentAt: now, expiresAt: now + 86400000 }];
  const requests = new Map();
  const project = (message, member) => {
    const { requestId, ...value } = message;
    return { ...value, ...(requestId && message.playerId === `parks-preview-${member}` ? { requestId } : {}) };
  };
  function packet(member, selected, hasMore = false) {
    return { roomId: ROOM_ID, messages: selected.map(message => project(message, member)),
      latestSequence: messages.at(-1).chatSequence, oldestSequence: 1, hasMore };
  }
  return {
    initial: member => packet(member, messages.slice(-100)),
    update: (member, message) => packet(member, [message]),
    history(member, query) {
      const candidates = messages.filter(message => (query.after === undefined || message.chatSequence > query.after)
        && (query.before === undefined || message.chatSequence < query.before));
      return packet(member, query.after === undefined ? candidates.slice(-query.limit) : candidates.slice(0, query.limit), candidates.length > query.limit);
    },
    add(member, { text, requestId }) {
      const key = `${member}:${requestId}`, previous = requests.get(key);
      if (previous) {
        if (previous.text !== text) throw problem(409, 'REQUEST_ID_REUSED', '这个请求编号已用于另一条消息。');
        return { message: project(previous, member), duplicate: true };
      }
      if (messages.length >= MAX_MESSAGES) throw problem(429, 'CHAT_CAPACITY', '合成聊天已达500条；重启本机服务后可继续。');
      const stamp = Date.now(), sequence = messages.length + 1;
      const message = { messageId: `parks-preview-message-${sequence}`, chatSequence: sequence,
        playerId: `parks-preview-${member}`, name: member === 'a' ? '我（合成A）' : '伙伴（合成B）',
        text, requestId, sentAt: stamp, expiresAt: stamp + 86400000 };
      messages.push(message); requests.set(key, message); return { message, duplicate: false };
    },
  };
}

export async function startParksPreview({ port = 4383 } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('合成样板禁止在production模式启动。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('端口必须为0～65535的整数。');
  const chat = createSyntheticChat(), streams = new Set();
  let origin, closing = false, closePromise;
  const writeFrame = (stream, frame) => {
    if (stream.response.destroyed || stream.waitingDrain) {
      streams.delete(stream); stream.response.destroy(); return;
    }
    // One bounded packet may exceed Node's high-water mark even for a fast
    // peer. Wait for its drain; never queue more frames behind a slow peer.
    if (!stream.response.write(frame)) {
      stream.waitingDrain = true;
      stream.response.once('drain', () => { stream.waitingDrain = false; });
    }
  };
  const writeEvent = (stream, packet) => writeFrame(stream, `event: chat\ndata: ${JSON.stringify(packet)}\n\n`);
  const server = createServer(async (request, response) => {
    try {
      if (closing) throw problem(503, 'PREVIEW_CLOSING', '本机样板正在关闭。');
      if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== new URL(origin).host
          || request.headers.origin !== undefined && request.headers.origin !== origin) throw problem(403, 'LOCAL_ONLY', '仅允许同源本机访问。');
      const url = new URL(request.url, origin);
      if (url.origin !== origin) throw problem(403, 'LOCAL_ONLY', '仅允许本机预览地址。');
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '.' || part === '..')) throw problem(404, 'NOT_PUBLIC', '资源未公开。');
      const pathname = decoded.startsWith('/game/') ? decoded.slice(5) : decoded;
      if (pathname === '/__parks/chat' || pathname === '/__parks/events') {
        const events = pathname.endsWith('/events');
        if (request.method === 'GET') {
          const { member, query } = memberQuery(url.searchParams, { history: !events });
          if (!events) return send(response, 200, chat.history(member, query));
          if (streams.size >= MAX_STREAMS) throw problem(429, 'STREAM_CAPACITY', '合成聊天连接已满，请关闭多余窗口。');
          response.writeHead(200, { ...responseHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.flushHeaders();
          const stream = { member, response }; streams.add(stream);
          response.once('close', () => streams.delete(stream));
          writeEvent(stream, chat.initial(member)); return;
        }
        if (events || request.method !== 'POST') throw problem(405, 'METHOD_NOT_ALLOWED', '聊天只接受约定的读取和发送。');
        const { member } = memberQuery(url.searchParams);
        if (request.headers.origin !== origin || request.headers['x-parks-preview'] !== '1'
            || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw problem(403, 'PREVIEW_WRITE_FORBIDDEN', '只能从本机合成样板发送消息。');
        const input = await readMessage(request);
        if (closing) throw problem(503, 'PREVIEW_CLOSING', '本机样板正在关闭。');
        const result = chat.add(member, input);
        if (!result.duplicate) for (const stream of streams) writeEvent(stream, chat.update(stream.member, result.message));
        return send(response, 200, { roomId: ROOM_ID, message: result.message, retained: true });
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw problem(405, 'METHOD_NOT_ALLOWED', '静态资源只接受读取。');
      if (pathname === '/') return send(response, 200, ROOT_HTML, MIME['.html'], request.method === 'HEAD');
      const path = pathname.slice(1);
      if (!ASSETS.has(path)) throw problem(404, 'NOT_PUBLIC', '资源不在本机样板白名单。');
      const content = await readFile(resolve(APP_ROOT, path));
      send(response, 200, content, MIME[extname(path)] || 'application/octet-stream', request.method === 'HEAD');
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response,
        error.code === 'ENOENT' ? 404 : error.status || (error instanceof URIError ? 400 : 500),
        { code: error.code || 'PREVIEW_RESOURCE_ERROR', message: error.status ? error.message : '本机资源暂时不可用。', synthetic: true });
      else response.destroy();
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 40; server.maxConnections = 64;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const heartbeat = setInterval(() => {
    for (const stream of streams) writeFrame(stream, ': synthetic-preview-heartbeat\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
  function close() {
    if (closePromise) return closePromise;
    closing = true; clearInterval(heartbeat);
    for (const stream of streams) stream.response.end();
    streams.clear();
    closePromise = new Promise((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); });
    return closePromise;
  }
  return { server, origin, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preview = await startParksPreview({ port: Number(process.env.PORT || 4383) });
  console.log(`PARKS本机合成样板：${preview.origin}/`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await preview.close(); process.exit(0); });
}
