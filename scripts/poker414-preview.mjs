import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { publicAssetPaths } from '../server/public-assets.mjs';
import { chatQuery, validateChatText } from '../server/chat.mjs';

// This script has no production identity, room service, persistent store or
// network client. Preview chat exists only until this local process exits.
const APP_ROOT = fileURLToPath(new URL('../app/', import.meta.url));
const PREVIEW_ASSETS = [
  'poker414-preview.html', 'games/poker414-2/cards.mjs', 'games/poker414-2/art.mjs',
  'games/poker414-2/page-ui.mjs',
  'games/poker414-2/layout.mjs', 'games/poker414-2/preview.mjs',
  'games/poker414-2/test-support/preview-fixtures.mjs', 'games/poker414-2/styles.css',
];
const ASSETS = new Set([...publicAssetPaths(), ...PREVIEW_ASSETS]);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const ROOM_ID = '414-preview-room';
const CHAT_PATH = '/api/rooms/414000/chat';
const PEER_MESSAGE_PATH = '/api/rooms/414000/preview-message';
const ROOT_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>414 本机操作小样</title>
<style>body{font:18px/1.7 system-ui;margin:0;background:#f5f3ed;color:#18332f}main{max-width:36rem;margin:12vh auto;padding:24px}a{display:inline-block;padding:12px 20px;border-radius:12px;background:#214b40;color:#fff;text-decoration:none}</style>
<main><h1>414 本机操作小样</h1><p>这里只演示牌面、布局和共通控件。全部身份、房号、牌局、聊天及分数均为合成数据，不会加入正式房间或保存正式积分。</p>
<p><a href="/poker414-preview.html?enter=1">进入操作小样</a></p><p>退出示范房后回到这里；关闭本机预览服务会清除聊天记录。</p></main></html>`;
const problem = (status, message) => Object.assign(new Error(message), { status });

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin' });
  response.end(typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
}

async function readBody(request, { peer = false } = {}) {
  const parts = [];
  let bytes = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    bytes += part.length;
    if (bytes > 4096) { request.resume(); throw problem(413, '预览消息请求过大。'); }
    parts.push(part);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw problem(400, '消息必须为 JSON。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'text')
    || (peer ? Object.keys(body).length !== 1
      : Object.keys(body).length !== 2 || !Object.hasOwn(body, 'requestId')
        || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{8,128}$/.test(body.requestId))) {
    throw problem(400, peer ? '示范伙伴消息仅接受文字。' : '仅接受文字和有效请求编号。');
  }
  return { text: validateChatText(body.text), ...(!peer ? { requestId: body.requestId } : {}) };
}

function createPreviewChat() {
  const startedAt = Date.now();
  const messages = ['这是本机合成聊天，可直接试发消息。', '牌面与规则正在制作；这里不连接正式棋牌室。'].map((text, index) => ({
    messageId: `preview-welcome-${index}`, chatSequence: index + 1, playerId: `preview-friend-${index + 1}`,
    name: `示范伙伴${index + 1}`, text, sentAt: startedAt + index,
    expiresAt: startedAt + 24 * 60 * 60 * 1000,
  }));
  const requests = new Map();
  function append(text, author, requestId) {
    if (messages.length >= 500) throw problem(429, '本机小样消息已满；重启预览后可继续。');
    const now = Date.now();
    const message = { messageId: `preview-message-${messages.length + 1}`, chatSequence: messages.length + 1,
      ...author, text, ...(requestId ? { requestId } : {}), sentAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000 };
    messages.push(message);
    if (requestId) requests.set(requestId, message);
    return { roomId: ROOM_ID, message, retained: true };
  }
  return {
    history(query) {
      const candidates = messages.filter(message => message.expiresAt > Date.now()
        && (query.after === undefined || message.chatSequence > query.after)
        && (query.before === undefined || message.chatSequence < query.before));
      return { roomId: ROOM_ID,
        messages: query.after === undefined ? candidates.slice(-query.limit) : candidates.slice(0, query.limit),
        oldestSequence: messages[0]?.chatSequence ?? null, latestSequence: messages.at(-1)?.chatSequence ?? 0,
        hasMore: candidates.length > query.limit, historyTruncated: false };
    },
    add({ text, requestId }) {
      const existing = requests.get(requestId);
      if (existing) {
        if (existing.text !== text) throw problem(409, '这个请求编号已经用于另一条消息。');
        return { roomId: ROOM_ID, message: existing, retained: true };
      }
      return append(text, { playerId: 'preview-self', name: '我（示范）' }, requestId);
    },
    addPeer({ text }) {
      // Only this fixed synthetic peer can be simulated; callers cannot choose
      // an author or sequence, or acknowledge a pending self message.
      return append(text, { playerId: 'preview-friend-1', name: '示范伙伴1' });
    },
  };
}

export async function startPoker414Preview({ port = 4371 } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('合成小样禁止在 production 环境启动。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('端口必须为0～65535的整数。');
  const chat = createPreviewChat();
  let origin;
  const server = createServer(async (request, response) => {
    try {
      if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== new URL(origin).host) {
        throw problem(403, '只允许本机 127.0.0.1 预览访问。');
      }
      const url = new URL(request.url, origin);
      if (url.origin !== origin) throw problem(403, '仅接受本机预览地址。');
      if (url.pathname === CHAT_PATH || url.pathname === PEER_MESSAGE_PATH) {
        const peer = url.pathname === PEER_MESSAGE_PATH;
        if (!peer && request.method === 'GET') return send(response, 200, chat.history(chatQuery(url.searchParams)));
        if (request.method !== 'POST') throw problem(405, '不支持此预览动作。');
        if (request.headers.origin !== origin || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          throw problem(403, '只能从本机小样页面发送消息。');
        }
        if (url.search) throw problem(400, '发送消息不接受查询参数。');
        const body = await readBody(request, { peer });
        return send(response, 200, peer ? chat.addPeer(body) : chat.add(body));
      }
      if (request.method !== 'GET') throw problem(405, '静态预览只接受读取。');
      if (url.pathname === '/') return send(response, 200, ROOT_HTML, MIME['.html']);
      const path = decodeURIComponent(url.pathname.slice(1));
      if (!ASSETS.has(path)) throw problem(404, '此资源未加入本机预览白名单。');
      const content = await readFile(resolve(APP_ROOT, path));
      send(response, 200, content, MIME[extname(path)]);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response,
        error.code === 'ENOENT' ? 404 : error.status || (error instanceof URIError ? 400 : 500),
        { message: error.status ? error.message : '本机预览资源暂时不可用。', synthetic: true });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 40;
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, close: () => new Promise((accept, reject) => {
    server.close(error => error ? reject(error) : accept());
    server.closeAllConnections();
  }) };
}

/** One bounded local cadence check, not a throughput benchmark or identity test.
 * Consumers see only the latest in-memory snapshot, like coalesced poll output.
 * It deliberately has no fake claims about HTTP/SSE, SQLite or cloud capacity. */
export async function runCadenceExperiment() {
  const start = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('合成实验超过9500ms边界。')), 9500);
  const elapsed = () => performance.now() - start;
  const waitUntil = time => delay(Math.max(0, time - elapsed()), undefined, { signal: controller.signal });
  const batches = [], clients = [];
  let dealt = 0, window = null;
  try {
    const producer = (async () => {
      for (let batch = 1; batch <= 6; batch++) {
        await waitUntil(batch * 500);
        dealt = batch * 18; batches.push({ batch, dealt, atMs: Math.round(elapsed()) });
      }
      await waitUntil(3250);
      window = { openedAtMs: elapsed(), deadlineAtMs: elapsed() + 5000 };
    })();
    const consumers = Array.from({ length: 16 }, (_, index) => (async () => {
      const observations = [], phaseMs = Math.floor(index * 1000 / 16);
      for (let poll = 1; poll <= 8; poll++) {
        await waitUntil(poll * 1000 + phaseMs);
        const seenAtMs = elapsed();
        observations.push({ atMs: Math.round(seenAtMs), dealt });
        if (!window) continue;
        const remainingMs = window.deadlineAtMs - seenAtMs;
        await delay(250, undefined, { signal: controller.signal });
        clients.push({ client: index + 1, role: index < 8 ? 'synthetic-player' : 'synthetic-spectator',
          phaseMs, observations, remainingMs: Math.round(remainingMs),
          syntheticPlayerResponseAccepted: index < 8 ? elapsed() < window.deadlineAtMs : null });
        return;
      }
      throw new Error('本机消费者未观察到响应窗口。');
    })());
    await Promise.all([producer, ...consumers]);
    return { type: 'synthetic-local-cadence-only', measuredAt: new Date().toISOString(),
      durationMs: Math.round(elapsed()), configuration: { consumers: 16, batchCount: 6, cardsPerBatch: 18,
        batchEveryMs: 500, pollEveryMs: 1000, responseWindowMs: 5000, simulatedThinkMs: 250 },
      batches, clients: clients.sort((a, b) => a.client - b.client),
      passed: batches.length === 6 && dealt === 108 && clients.length === 16
        && clients.every(client => client.remainingMs > 0 && client.observations.at(-1).dealt === 108)
        && clients.filter(client => client.role === 'synthetic-player').every(client => client.syntheticPlayerResponseAccepted),
      limitations: ['合成内存快照和实际Node定时器，仅观察节奏与轮询相位。',
        '未使用RoomClient、HTTP/SSE、身份核验、SQLite、正式网络或真实玩家。',
        '不是正式容量、SSO或真人五秒响应可用性的验收证明。'] };
  } finally {
    clearTimeout(timeout); controller.abort();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === '--experiment') {
      const result = await runCadenceExperiment();
      const output = new URL('../ops/poker414-step0-2026-10-09/harness.json', import.meta.url);
      await mkdir(new URL('.', output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`本机合成节奏实验：${result.passed ? '通过' : '失败'}，${result.durationMs}ms；不代表正式容量。`);
      if (!result.passed) process.exitCode = 1;
    } else {
      if (args.length > 1 || args[0] && !/^--port=\d+$/.test(args[0])) throw new Error('用法：node scripts/poker414-preview.mjs [--port=4371 | --experiment]');
      const preview = await startPoker414Preview({ port: args.length ? Number(args[0].slice(7)) : 4371 });
      console.log(`414本机合成小样：${preview.origin}/poker414-preview.html`);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        preview.close().catch(() => { process.exitCode = 1; });
      });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
