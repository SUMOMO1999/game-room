// Loopback-only synthetic members; actual SessionService, HTTP/SSE and encrypted SQLite.
// No production accounts, cloud calls or business data are loaded.
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { MockProvider } from '../server/auth.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('本机合成验收不能在生产运行。');
const port = Number(process.env.POKER414_PREVIEW_PORT || 4373);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('预览端口无效。');
const playerCount = Number(process.env.POKER414_PREVIEW_PLAYERS || 3);
if (![3, 8].includes(playerCount)) throw new Error('预览支持3人代表局或8人满员局。');
const spectatorCount = playerCount === 8 ? 8 : 1;
const folder = await mkdtemp(join(tmpdir(), 'poker414-room-preview-'));
const base = `http://127.0.0.1:${port}`;
const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_ORIGIN: base, GAME_ROOM_POKER414_ENABLED: '1',
  GAME_ROOM_STORE_PATH: join(folder, 'preview.sqlite'), GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') });
const provider = new MockProvider(settings);
provider.complete = async () => ({ issuer: 'urn:poker414-loopback', sub: provider.member,
  accessToken: 'synthetic-local-only', expiresAt: Date.now() + 3600000 });
provider.check = async identity => ({ sub: identity.sub });
const runtime = createRuntime(settings, { provider, roomOptions: {
  ...(process.env.POKER414_PREVIEW_SHUFFLE === 'rotate' ? { serverRandomInt: () => 0 } : {}) } });
const previewRooms = runtime.rooms;
runtime.rooms = new Proxy(previewRooms, { get(target, key) {
  const value = target[key];
  if (typeof value !== 'function') return value;
  return async (...args) => { try { return await value.apply(target, args); } catch (error) {
    if (!error.status || error.status >= 500) console.error(`本机房间 ${String(key)} 失败：${error.stack}`);
    throw error;
  } };
} });
const server = createUnifiedServer(runtime), handlers = server.listeners('request');
const members = [];
let code;
server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (req.url?.startsWith('/__414/')) {
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}` || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    const index = /^\/__414\/member\/(\d{1,2})$/.exec(req.url)?.[1], member = members[Number(index)];
    if (index !== undefined && member && code) {
      res.writeHead(303, { 'Set-Cookie': `${member.cookie}; HttpOnly; SameSite=Lax; Path=/`,
        Location: `/poker414.html?code=${code}`, 'Cache-Control': 'no-store' }); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>414本机多人验收</title><h1>414本机多人验收</h1><p>虚构身份 · 真实房间、聊天、积分与加密保存。房间 ${code || '准备中'}</p>${members.map((member, i) => `<p><a href="/__414/member/${i}">${member.name}${i >= playerCount ? '（观众）' : ''}</a></p>`).join('')}</html>`); return;
  }
  for (const handler of handlers) handler.call(server, req, res);
});
server.listen(port, '127.0.0.1'); await once(server, 'listening');
async function request(path, member = {}, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: {
    ...(member.cookie ? { cookie: member.cookie } : {}), ...(body === undefined ? {} : { origin: base,
      'content-type': 'application/json', 'x-csrf-token': member.csrf }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`合成验收准备失败 ${response.status} ${text}`);
  return { response, body: text ? JSON.parse(text) : null };
}
const names = ['小禾', '阿亮', '小满', '漫游到月亮的伙伴', 'オウ', '天天开心', '山间清风', '橘子汽水'].slice(0, playerCount)
  .concat(Array.from({ length: spectatorCount }, (_, i) => `旁观伙伴${i + 1}`));
for (const [i, name] of names.entries()) {
  provider.member = `local-${i}`;
  const start = await request('/auth/login'), callback = new URL(start.response.headers.get('location'));
  const finish = await request(callback.pathname + callback.search, { cookie: start.response.headers.getSetCookie()[0].split(';')[0] });
  const cookie = finish.response.headers.getSetCookie().find(value => value.startsWith(settings.cookieName + '=')).split(';')[0];
  const state = await request('/api/state', { cookie });
  const member = { cookie, csrf: state.body.csrf, name }; members.push(member);
  if (i === 0) code = (await request('/api/rooms', member, { gameType: 'poker414-2', name, requestId: randomUUID() })).body.roomCode;
  else await request(`/api/rooms/${code}/join`, member, { name, requestId: randomUUID(), ...(i >= playerCount ? { role: 'spectator' } : {}) });
}
for (const member of members.slice(1, playerCount)) {
  const view = (await request(`/api/rooms/${code}`, member)).body.view;
  await request(`/api/rooms/${code}/actions`, member, { type: 'ready', ready: true, requestId: randomUUID(), expectedRevision: view.revision });
}
console.log(`414真实房间本机预览：${base}/__414/ · 房间 ${code}`);
const presence = new AbortController();
// Synthetic partners keep their own real streams alive while the reviewer uses one browser.
for (const member of members.slice(1)) {
  void fetch(`${base}/api/rooms/${code}/events`, { headers: { cookie: member.cookie }, signal: presence.signal })
    .then(async response => { if (response.ok) for await (const chunk of response.body) { if (presence.signal.aborted) break; } })
    .catch(error => { if (!presence.signal.aborted) console.error('合成伙伴连接中断：', error.message); });
}
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (closing) return; closing = true; presence.abort(); server.closeAllConnections(); await server.shutdown(); await rm(folder, { recursive: true, force: true });
});
