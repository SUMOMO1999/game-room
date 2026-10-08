import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { MockProvider } from '../server/auth.mjs';
import { readSettings } from '../server/config.mjs';
import { createWordbankRequestId } from '../server/content/draw-and-guess-wordbank.mjs';
import { canonicalWordbankRequestFingerprint } from './games/draw-and-guess/request-intent.mjs';

async function fixture(t, sqlite) {
  const directory = mkdtempSync(join(tmpdir(), 'wordbank-http-size-')), now = Date.now;
  const storage = new EncryptedStore(sqlite ? new SQLiteAdapter(join(directory, 'content.sqlite'), { now }) : new MemoryAdapter({ now }), randomBytes(32), now);
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), provider = new MockProvider(settings, { now });
  provider.complete = async () => ({ issuer: 'urn:synthetic-wordbank-wire-size', sub: 'fictional-content-editor', accessToken: 'server-only-fictional-content-editor', expiresAt: now() + 3600000 });
  provider.check = async identity => ({ sub: identity.sub });
  const runtime = createRuntime(settings, { storage, provider, now, drawingEnabled: true, roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  await runtime.wordbankReady; await runtime.canvases.ready;
  const server = createUnifiedServer(runtime);
  t.after(async () => { server.closeAllConnections(); await server.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  settings.origin = origin; settings.callback = `${origin}/auth/callback`; settings.postLogout = `${origin}/`;
  async function wire(path, { cookie, csrf, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const response = await fetch(origin + path, { method, redirect: 'manual', headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': csrf || '' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }
  const start = await wire('/auth/login?returnTo=%2Fwords'); assert.equal(start.status, 303);
  const callback = new URL(start.headers.get('location')), transaction = start.headers.getSetCookie()[0].split(';')[0];
  const completed = await wire(callback.pathname + callback.search, { cookie: transaction }); assert.equal(completed.status, 303);
  const cookie = completed.headers.getSetCookie().find(value => value.startsWith(settings.cookieName + '=')).split(';')[0];
  const account = await wire('/api/state', { cookie }); assert.equal(account.body.authenticated, true);
  return { runtime, wire: (path, options = {}) => wire(path, { cookie, csrf: account.body.csrf, ...options }), origin, cookie, csrf: account.body.csrf };
}

for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'Memory'}: real unified wordbank accepts a complete 32–64 KiB batch, refuses larger bodies and keeps legacy limits`, async t => {
  const f = await fixture(t, sqlite);
  // These remain existing legal account nicknames. Content display fallbacks
  // cannot rename the profile or block its independently verified identity.
  assert.equal((await f.wire('/api/profile', { method: 'PUT', body: { nickname: '<伙伴>' } })).status, 200);
  const created = await f.wire('/api/wordbanks', { body: { requestId: createWordbankRequestId(), name: '线路大小验收', visibility: 'private' } });
  assert.equal(created.status, 201); const packId = created.body.packId;
  const operations = Array.from({ length: 200 }, (_, index) => ({ type: 'word.add', id: `dg-wire-${String(index).padStart(3, '0')}-${'a'.repeat(24)}`,
    answer: `航海绘画练习纸船${index}`, aliases: [`蓝天白云折纸小舟${index}`], category: 'custom', difficulty: 'normal', tags: ['海边绘画'] }));
  const body = { requestId: createWordbankRequestId(), expectedDraftRevision: 0, operations }, size = Buffer.byteLength(JSON.stringify(body));
  assert.ok(size > 32768 && size <= 65536, `test batch must exercise the actual wire interval: ${size}`);
  const saved = await f.wire(`/api/wordbanks/${packId}/changes`, { body }); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = await f.wire(`/api/wordbanks/${packId}`); assert.equal(read.body.draft.words.length, 200); assert.equal(read.body.history[0].actor.displayName, '伙伴');
  assert.equal((await f.wire('/api/state')).body.profile.nickname, '<伙伴>');
  const fingerprint = await canonicalWordbankRequestFingerprint('change', packId, body);
  const receipt = await f.wire(`/api/wordbank-requests/${body.requestId}?fingerprint=${fingerprint}`); assert.equal(receipt.body.status, 'committed');
  assert.equal((await f.wire(`/api/wordbank-requests/${body.requestId}`)).status, 400);
  const tooLarge = await f.wire(`/api/wordbanks/${packId}/changes`, { body: { requestId: createWordbankRequestId(), expectedDraftRevision: 1, operations, padding: 'x'.repeat(65536) } });
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.code, 'BODY_TOO_LARGE');
  const after = await f.wire(`/api/wordbanks/${packId}`); assert.equal(after.body.draftRevision, 1); assert.equal(after.body.draft.words.length, 200);
  const oldLimit = await f.wire('/api/profile', { method: 'PUT', body: { nickname: 'x'.repeat(33000) } }); assert.equal(oldLimit.status, 413);
  // No Content-Length means the streamed-byte branch must independently enforce
  // 64 KiB, rather than relying on an eager header check.
  const chunked = await new Promise((resolve, reject) => {
    const req = httpRequest(f.origin + `/api/wordbanks/${packId}/changes`, { method: 'POST', headers: { Cookie: f.cookie, Origin: f.origin,
      'X-CSRF-Token': f.csrf, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.write('{"padding":"'); req.write('x'.repeat(32768)); req.end('x'.repeat(32768) + '"}');
  });
  assert.equal(chunked.status, 413); assert.equal(chunked.body.code, 'BODY_TOO_LARGE');
});
