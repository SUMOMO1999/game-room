import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { execFileSync } from 'node:child_process';
import { startParksPreview } from './parks-preview.mjs';
import { publicAssetPaths } from '../server/public-assets.mjs';
import { RoomChatModel } from '../app/room-chat.mjs';

async function fixture(t) {
  const preview = await startParksPreview({ port: 0 }); t.after(() => preview.close()); return preview;
}
async function post(preview, member, text, requestId, { prefix = '', headers = {}, rawBody, ...options } = {}) {
  return fetch(`${preview.origin}${prefix}/__parks/chat?member=${member}`, { method: 'POST',
    headers: { Origin: preview.origin, 'Content-Type': 'application/json', 'x-parks-preview': '1', ...headers },
    body: rawBody ?? JSON.stringify({ text, requestId }), ...options });
}
function eventStream(url) {
  return new Promise((accept, reject) => {
    const request = get(url, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`SSE ${response.statusCode}`)); return; }
      let buffer = '', ended = false; const queued = [], waiters = [];
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        while (buffer.includes('\n\n')) {
          const split = buffer.indexOf('\n\n'), frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          if (!frame.startsWith('event: chat\n')) continue;
          const value = JSON.parse(frame.slice('event: chat\ndata: '.length));
          if (waiters.length) waiters.shift().resolve(value); else queued.push(value);
        }
      });
      response.on('close', () => { ended = true; for (const waiter of waiters.splice(0)) waiter.reject(new Error('SSE closed')); });
      response.on('error', () => {});
      accept({ response, next() {
        if (queued.length) return Promise.resolve(queued.shift());
        if (ended) return Promise.reject(new Error('SSE closed'));
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('SSE event timeout')), 3000);
          waiters.push({ resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
        });
      }, close() { response.destroy(); request.destroy(); } });
    });
    request.once('error', reject);
  });
}
async function json(response, status = 200) { assert.equal(response.status, status); return response.json(); }

test('loopback preview rejects production and invalid ports without opening a listener', async () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { startParksPreview } from ${JSON.stringify(new URL('./parks-preview.mjs', import.meta.url).href)}; try { await startParksPreview({port:0}); process.exitCode=1; } catch (error) { console.log(error.message); }`],
    { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' });
  assert.match(output, /production/);
  for (const port of [-1, 65536, 1.5, '4383']) await assert.rejects(startParksPreview({ port }), /端口/);
});

test('root and /game serve synthetic entry; production exposes finished PARKS assets but keeps preview and server assembly private', async t => {
  const preview = await fixture(t); assert.equal(preview.server.address().address, '127.0.0.1');
  for(const path of ['parks-preview.html','games/parks/preview.mjs','games/parks/preview-fixtures.mjs','games/parks/page-ui.mjs','games/parks/engine.mjs']) assert.equal(publicAssetPaths().includes(path),false,path);
  assert.equal(publicAssetPaths().includes('parks-catalog.html'),true);
  for (const prefix of ['', '/game']) {
    const entry = await fetch(`${preview.origin}${prefix}/`); assert.equal(entry.status, 200);
    const html = await entry.text(); assert.match(html, /还不能按完整规则游玩/); assert.match(html, /member=b/); assert.match(html, /parks-catalog.html/);
    for (const path of ['parks-preview.html', 'parks-catalog.html', 'games/parks/card-ui.mjs', 'games/parks/preview-fixtures.mjs',
      ...['catalog', 'park-data', 'component-data', 'optional-data', 'passion-data', 'provenance', 'immutable', 'vector-art', 'asset-manifest', 'sample-assets'].map(name => `games/parks/content/${name}.mjs`),
      'room-chat.mjs', 'platform/room-settings.mjs', 'platform/game-theme.css']) {
      const response = await fetch(`${preview.origin}${prefix}/${path}`); assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      if (path.endsWith('.mjs')) assert.match(response.headers.get('content-type'), /text\/javascript/);
      await response.arrayBuffer();
    }
    const head = await fetch(`${preview.origin}${prefix}/parks-preview.html`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }
});

test('private paths, traversal, malformed URLs, wrong host, foreign origin and static writes are rejected', async t => {
  const preview = await fixture(t);
  for (const prefix of ['', '/game']) for (const path of ['.env', 'rooms.mjs', 'game-registry.mjs', 'server/storage.mjs',
    'ops/production-readiness.json', 'games/parks/content/content.test.mjs', 'games/parks/engine.mjs',
    'assets/parks/v1/manifest.json', '%2e%2e%2fserver/storage.mjs', 'games%5cparks%5cengine.mjs']) {
    const response = await fetch(`${preview.origin}${prefix}/${path}`); assert.equal(response.status, 404, path); await response.text();
  }
  const malformed = await fetch(`${preview.origin}/%ZZ`); assert.equal(malformed.status, 400); await malformed.text();
  const foreign = await fetch(preview.origin, { headers: { Origin: 'http://foreign.invalid' } }); assert.equal(foreign.status, 403); await foreign.text();
  const wrongHost = await new Promise((accept, reject) => {
    get(preview.origin, { headers: { Host: 'foreign.invalid' } }, response => { response.resume(); accept(response.statusCode); }).once('error', reject);
  });
  assert.equal(wrongHost, 403);
  const write = await fetch(preview.origin, { method: 'POST', body: 'no' }); assert.equal(write.status, 405); await write.text();
});

test('chat writes require same origin and marker; field, text and 4096-byte limits reject before appending', async t => {
  const preview = await fixture(t);
  for (const headers of [{ Origin: 'http://foreign.invalid' }, { Origin: '' }, { 'x-parks-preview': '0' }, { 'Content-Type': 'text/plain' }]) {
    await json(await post(preview, 'a', 'text', 'request-1', { headers }), 403);
  }
  for (const rawBody of ['null', '[]', 'invalid', JSON.stringify({ text: 'text', requestId: 'request-1', playerId: 'b' }),
    JSON.stringify({ text: ' ', requestId: 'request-1' }), JSON.stringify({ text: '\tbad', requestId: 'request-1' }),
    JSON.stringify({ text: '字'.repeat(501), requestId: 'request-1' }), JSON.stringify({ text: 'a\nb\nc\nd', requestId: 'request-1' }),
    JSON.stringify({ text: 'valid', requestId: '' })]) await json(await post(preview, 'a', '', '', { rawBody }), 400);
  await json(await post(preview, 'a', '', '', { rawBody: 'x'.repeat(4097) }), 413);
  const history = await json(await fetch(`${preview.origin}/__parks/chat?member=a`));
  assert.equal(history.messages.length, 1); assert.equal(history.latestSequence, 1);
});

test('member-local idempotency returns the same message, rejects altered text and hides other-member request IDs', async t => {
  const preview = await fixture(t);
  const first = await json(await post(preview, 'a', 'か\u3099\r\n同行', 'same-id'));
  const duplicate = await json(await post(preview, 'a', 'が\n同行', 'same-id', { prefix: '/game' }));
  assert.deepEqual(duplicate, first); assert.equal(first.roomId, 'parks-step0-room'); assert.equal(first.retained, true);
  await json(await post(preview, 'a', 'other text', 'same-id'), 409);
  const fromB = await json(await post(preview, 'b', '另一位合成成员', 'same-id'));
  assert.notEqual(fromB.message.messageId, first.message.messageId);
  for (const member of ['a', 'b']) {
    const history = await json(await fetch(`${preview.origin}/game/__parks/chat?member=${member}`));
    assert.equal(history.latestSequence, 3);
    for (const message of history.messages) assert.equal(Object.hasOwn(message, 'requestId'), message.playerId === `parks-preview-${member}` && message.chatSequence > 1);
  }
});

test('history paginates after/before/limit in sequence order and rejects conflicting or unknown cursor fields', async t => {
  const preview = await fixture(t);
  for (let i = 1; i <= 5; i++) await json(await post(preview, 'a', `第${i}条`, `page-${i}`));
  const after = await json(await fetch(`${preview.origin}/__parks/chat?member=a&after=1&limit=2`));
  assert.deepEqual(after.messages.map(message => message.chatSequence), [2, 3]); assert.equal(after.hasMore, true);
  const before = await json(await fetch(`${preview.origin}/__parks/chat?member=a&before=5&limit=2`));
  assert.deepEqual(before.messages.map(message => message.chatSequence), [3, 4]); assert.equal(before.hasMore, true);
  const latest = await json(await fetch(`${preview.origin}/__parks/chat?member=a&limit=2`));
  assert.deepEqual(latest.messages.map(message => message.chatSequence), [5, 6]);
  for (const suffix of ['member=c', 'member=a&member=b', 'member=a&after=1&before=2', 'member=a&before=0',
    'member=a&limit=0', 'member=a&limit=101', 'member=a&after=-1', 'member=a&limit=2&limit=3', 'member=a&unknown=1']) {
    await json(await fetch(`${preview.origin}/__parks/chat?${suffix}`), 400);
  }
});

test('HTTP sends reach both SSE members with author-only receipts and feed the real common RoomChatModel', async t => {
  const preview = await fixture(t), a = await eventStream(`${preview.origin}/__parks/events?member=a`), b = await eventStream(`${preview.origin}/game/__parks/events?member=b`);
  t.after(() => { a.close(); b.close(); });
  const firstA = await a.next(), firstB = await b.next(); assert.equal(firstA.messages[0].playerId, 'parks-preview-b');
  assert.equal(firstB.messages[0].requestId, undefined);
  const model = new RoomChatModel({ getGeneration: () => 0 });
  model.bind({}, { userKey: 'synthetic-b', roomId: 'parks-step0-room', playerId: 'parks-preview-b' });
  model.receive(firstB, { history: true });
  const acknowledgement = await json(await post(preview, 'a', '真实HTTP与SSE，合成房间。', 'sse-request'));
  const pushedA = await a.next(), pushedB = await b.next();
  assert.equal(pushedA.messages[0].requestId, 'sse-request'); assert.equal(pushedB.messages[0].requestId, undefined);
  assert.equal(pushedB.messages[0].messageId, acknowledgement.message.messageId);
  assert.equal(pushedB.oldestSequence, 1); assert.equal(pushedB.hasMore, false);
  assert.equal(model.receive(pushedB), true); assert.equal(model.snapshot().messages.length, 2);
  assert.equal(model.snapshot().messages[1].text, acknowledgement.message.text); model.clear();
});

test('SSE connections are bounded and closing the server terminates active streams; a new session starts clean', async t => {
  const preview = await fixture(t), streams = [];
  t.after(() => streams.forEach(stream => stream.close()));
  for (let i = 0; i < 12; i++) { const stream = await eventStream(`${preview.origin}/__parks/events?member=${i % 2 ? 'a' : 'b'}`); streams.push(stream); await stream.next(); }
  await json(await fetch(`${preview.origin}/__parks/events?member=a`), 429);
  await json(await post(preview, 'a', 'only this process', 'session-local'));
  for (const stream of streams) await stream.next();
  await preview.close(); await preview.close();
  assert.equal(preview.server.listening, false);
  const fresh = await fixture(t), history = await json(await fetch(`${fresh.origin}/__parks/chat?member=a`));
  assert.equal(history.messages.length, 1); assert.equal(history.latestSequence, 1);
});

test('500-message cap bounds both history and idempotency state while retaining successful retries at capacity', async t => {
  const preview = await fixture(t);
  for (let i = 1; i <= 499; i++) await json(await post(preview, 'a', `合成${i}`, `capacity-${i}`));
  await json(await post(preview, 'b', '超出容量', 'capacity-overflow'), 429);
  const retried = await json(await post(preview, 'a', '合成1', 'capacity-1')); assert.equal(retried.message.chatSequence, 2);
  const history = await json(await fetch(`${preview.origin}/__parks/chat?member=a&after=400&limit=100`));
  assert.equal(history.latestSequence, 500); assert.equal(history.messages.length, 100); assert.equal(history.hasMore, false);
});

test('a bounded initial SSE packet of 100 maximum-length messages drains without truncation', async t => {
  const preview = await fixture(t), text = '林'.repeat(500);
  for (let i = 1; i <= 100; i++) await json(await post(preview, 'a', text, `long-${i}`));
  const stream = await eventStream(`${preview.origin}/__parks/events?member=b`); t.after(() => stream.close());
  const packet = await stream.next();
  assert.equal(packet.messages.length, 100); assert.equal(packet.latestSequence, 101);
  assert.equal(packet.messages[99].text, text); assert.equal(packet.messages[99].requestId, undefined);
});
