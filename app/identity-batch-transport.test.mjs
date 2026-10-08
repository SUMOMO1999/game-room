import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createIdentityBatchTransport } from '../server/identity-batch-transport.mjs';
import { IdentityBatchClient } from '../server/identity-batch-client.mjs';
import { IdentityFailure } from '../server/auth.mjs';
import { SHARED_ISSUER } from '../server/config.mjs';
import { IDENTITY_BATCH_ENDPOINT, identityBatchRef, encodeIdentityBatch,
  signIdentityBatch, readIdentityBatchBody } from '../server/identity-batch-wire.mjs';

const keys = generateKeyPairSync('ed25519');
const permitted = new Set(['content-digest', 'content-type', 'x-agora-audience', 'signature-input', 'signature',
  'host', 'content-length', 'transfer-encoding', 'user-agent', 'accept', 'connection', 'accept-encoding']);
const unavailable = error => error.message === 'Identity batch transport unavailable';
const failed = status => error => error instanceof IdentityFailure && error.status === status;
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
async function settled(predicate) {
  const end = performance.now() + 1000;
  while (!predicate()) { assert.ok(performance.now() < end, 'native operation did not settle'); await nextTurn(); }
}
function signedOptions(extra = {}) {
  const now = Date.now(), batchRef = identityBatchRef();
  const body = encodeIdentityBatch({ batchRef, entries: [{ ref: identityBatchRef(), accessToken: 'synthetic-token',
    triggeredAtMs: now, queueUntilMs: now + 4000, deadlineMs: now + 8000 }] });
  const headers = signIdentityBatch({ body, batchRef, privateKey: keys.privateKey, keyId: 'local-transport-v1',
    created: Math.floor(now / 1000), expires: Math.floor(now / 1000) + 8 });
  return { method: 'POST', headers, body, credentials: 'omit', redirect: 'error', cache: 'no-store', ...extra };
}
async function local(t, handler) {
  const observed = [], handlerErrors = [];
  const server = createServer((request, response) => {
    const record = { method: request.method, path: request.url, headers: request.headers, rawHeaders: request.rawHeaders };
    observed.push(record);
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      record.body = Buffer.concat(chunks);
      await handler(request, response, record);
    })().catch(error => { handlerErrors.push(error); response.destroy(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  let agent, destroys = 0;
  const factories = [], transport = createIdentityBatchTransport({
    agentFactory: () => {
      agent = new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1 });
      const original = agent.destroy.bind(agent);
      agent.destroy = () => { destroys++; original(); };
      return agent;
    },
    requester: (url, options) => {
      assert.equal(url.href, IDENTITY_BATCH_ENDPOINT);
      assert.deepEqual(Object.keys(options).sort(), ['agent', 'headers', 'method']);
      factories.push(options);
      return httpRequest({ hostname: '127.0.0.1', port, path: url.pathname, ...options });
    },
  });
  t.after(async () => {
    await transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(handlerErrors, []);
  });
  return { transport, observed, factories, url: `http://127.0.0.1:${port}/api/identity/batch`,
    agent: () => agent, destroys: () => destroys };
}

test('native request sends only adapter-1 headers at the fixed signed target and streams its body', { timeout: 5000 }, async t => {
  const fixture = await local(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"synthetic":true}');
  });
  const options = signedOptions(), result = await fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, options);
  assert.equal(result.status, 200); assert.equal(result.redirected, false);
  assert.deepEqual(await readIdentityBatchBody(result), Buffer.from('{"synthetic":true}'));
  const [request] = fixture.observed;
  assert.equal(request.method, 'POST'); assert.equal(request.path, '/api/identity/batch');
  assert.deepEqual(request.body, options.body);
  assert.deepEqual(Object.keys(request.headers).sort(), ['accept', 'accept-encoding', 'connection', 'content-digest',
    'content-length', 'content-type', 'host', 'signature', 'signature-input', 'x-agora-audience']);
  assert.ok(Object.keys(request.headers).every(name => permitted.has(name)));
  assert.equal(request.headers.host, 'agora.sumomoli.com'); assert.equal(request.headers.connection, 'keep-alive');
  assert.equal(request.headers['content-length'], String(options.body.length));
  assert.equal(request.headers.accept, 'application/json'); assert.equal(request.headers['accept-encoding'], 'identity');
  for (const [name, value] of Object.entries(options.headers)) assert.equal(request.headers[name.toLowerCase()], value);
  assert.equal(fixture.agent().maxSockets, 4); assert.equal(fixture.agent().maxFreeSockets, 1);
  assert.equal(fixture.transport.occupancy.activeRequests, 0);
  const closing = fixture.transport.close(); assert.equal(fixture.transport.close(), closing);
  await closing; assert.equal(fixture.destroys(), 1);
  await assert.rejects(fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, options), unavailable);
});

test('actual Node fetch adds a forbidden sec-fetch-mode header while native transport satisfies the same strict gate',
  { timeout: 5000 }, async t => {
    const fixture = await local(t, (_request, response, record) => {
      const unknown = Object.keys(record.headers).filter(name => !permitted.has(name));
      response.writeHead(unknown.length ? 400 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ unknown }));
    });
    const options = signedOptions();
    const fetchResponse = await fetch(fixture.url, { ...options,
      headers: { ...options.headers, Host: 'agora.sumomoli.com' } });
    assert.equal(fetchResponse.status, 400);
    assert.deepEqual((await fetchResponse.json()).unknown.sort(), ['accept-language', 'cache-control', 'pragma', 'sec-fetch-mode']);
    assert.equal(fixture.observed[0].headers['sec-fetch-mode'], 'cors');
    const native = await fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, options);
    assert.equal(native.status, 200); assert.deepEqual(JSON.parse(await readIdentityBatchBody(native)), { unknown: [] });
  });

test('request validation rejects altered endpoints, automatic/auth headers and byte overflow before opening a socket',
  { timeout: 5000 }, async t => {
    const fixture = await local(t, () => { assert.fail('invalid input must not dial'); });
    const options = signedOptions();
    for (const url of [`${IDENTITY_BATCH_ENDPOINT}?extra=1`, 'http://agora.sumomoli.com/api/identity/batch',
      'https://foreign.example/api/identity/batch']) await assert.rejects(fixture.transport.fetcher(url, options), unavailable);
    const aborted = new AbortController(); aborted.abort();
    for (const patch of [{ method: 'GET' }, { credentials: 'include' }, { redirect: 'follow' }, { cache: 'default' },
      { body: new Uint8Array(1) }, { body: Buffer.alloc(147457) }, { signal: aborted.signal }, { signal: {} },
      { rejectUnauthorized: false }, { headers: { ...options.headers, Cookie: 'synthetic' } },
      { headers: { ...options.headers, Authorization: 'synthetic' } }, { headers: { ...options.headers, 'Sec-Fetch-Mode': 'cors' } },
      { headers: { ...options.headers, 'accept-encoding': 'gzip' } }, { headers: { ...options.headers, Accept: 'text/plain' } },
      { headers: { ...options.headers, Signature: 'x'.repeat(8192) } },
      { headers: { ...options.headers, 'Content-Type': 'application/json\r\nCookie: synthetic' } }]) {
      await assert.rejects(fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, { ...options, ...patch }), unavailable);
    }
    assert.equal(fixture.factories.length, 0); assert.equal(fixture.observed.length, 0);
    assert.equal(fixture.transport.occupancy.activeRequests, 0);
  });

test('streamed response stays occupied through real native close and cancels without losing resource accounting',
  { timeout: 5000 }, async t => {
    const started = deferred();
    const fixture = await local(t, (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"held":'); started.resolve(response);
    });
    const controller = new AbortController();
    const result = await fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, signedOptions({ signal: controller.signal }));
    await started.promise;
    assert.equal(fixture.transport.occupancy.activeRequests, 1);
    const reader = result.body.getReader(); assert.equal(Buffer.from((await reader.read()).value).toString(), '{"held":');
    controller.abort();
    await assert.rejects(reader.read(), unavailable); reader.releaseLock();
    assert.equal(fixture.transport.occupancy.activeRequests, 0);
    assert.equal(fixture.observed.length, 1);
  });

test('explicit Web body cancellation awaits native request and response close', { timeout: 5000 }, async t => {
  const fixture = await local(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{}');
  });
  const result = await fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, signedOptions());
  assert.equal(fixture.transport.occupancy.activeRequests, 1);
  await result.body.cancel();
  assert.equal(fixture.transport.occupancy.activeRequests, 0);
});

test('machine errors and redirects never follow a location and resolve only after native close', { timeout: 5000 }, async t => {
  let status = 401;
  const fixture = await local(t, (_request, response) => {
    response.writeHead(status, { Location: 'https://foreign.example/token', 'Content-Type': 'application/json' });
    response.write('{"unread":"synthetic-token"');
  });
  for (status of [401, 403, 302, 503]) {
    const result = await fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, signedOptions());
    assert.equal(result.status, status); assert.equal(result.body, null); assert.equal(result.redirected, false);
    assert.equal(fixture.transport.occupancy.activeRequests, 0);
  }
  assert.equal(fixture.observed.length, 4);
});

test('truncated response is sanitized and closes the real native operation', { timeout: 5000 }, async t => {
  const fixture = await local(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' }); response.end('{}');
    void nextTurn().then(() => request.socket.destroy());
  });
  const result = await fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, signedOptions());
  await assert.rejects(readIdentityBatchBody(result), unavailable);
  assert.equal(fixture.transport.occupancy.activeRequests, 0); assert.equal(fixture.observed.length, 1);
});

test('pre-header connection failure is sanitized, settled, and has no automatic retry', { timeout: 5000 }, async t => {
  const fixture = await local(t, (request, _response) => { request.socket.destroy(); });
  await assert.rejects(fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, signedOptions()), unavailable);
  assert.equal(fixture.transport.occupancy.activeRequests, 0); assert.equal(fixture.observed.length, 1);
});

test('close drains pending headers and held body, destroys its own Agent, and rejects new requests', { timeout: 5000 }, async t => {
  const headerHeld = deferred(); let count = 0;
  const fixture = await local(t, (_request, response) => {
    if (++count === 1) {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{}');
    } else headerHeld.resolve();
  });
  const result = await fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, signedOptions());
  const reader = result.body.getReader(); await reader.read();
  const held = fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, signedOptions());
  const failure = assert.rejects(held, unavailable);
  await headerHeld.promise; assert.equal(fixture.transport.occupancy.activeRequests, 2);
  await fixture.transport.close(); await failure;
  await assert.rejects(reader.read(), unavailable); reader.releaseLock();
  assert.equal(fixture.transport.occupancy.activeRequests, 0); assert.equal(fixture.transport.occupancy.closed, true);
  assert.equal(fixture.destroys(), 1);
  await assert.rejects(fixture.transport.fetcher(IDENTITY_BATCH_ENDPOINT, signedOptions()), unavailable);
  assert.equal(fixture.observed.length, 2);
});

test('actual IdentityBatchClient consumes signed native response and maps machine 401 to project-unavailable',
  { timeout: 5000 }, async t => {
    let status = 200;
    const expected = { issuer: SHARED_ISSUER, sub: 'native-player', clientId: 'batchtestclient1234',
      authTime: Math.floor(Date.now() / 1000) - 60, expiresAt: Date.now() + 60000, accessToken: 'synthetic-native-token' };
    const fixture = await local(t, (_request, response, record) => {
      assert.ok(Object.keys(record.headers).every(name => permitted.has(name)));
      const batch = JSON.parse(record.body);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: 1, batchRef: batch.batchRef,
        entries: batch.entries.map(item => ({ ref: item.ref, status: 200, policy: { version: 1, revokedBefore: 0,
          issuer: expected.issuer, sub: expected.sub, clientId: expected.clientId, authTime: expected.authTime } })) }));
    });
    const client = new IdentityBatchClient({ enabled: true, keyId: 'local-transport-v1', privateKey: keys.privateKey,
      fetcher: fixture.transport.fetcher });
    t.after(() => client.close());
    assert.equal((await client.check(expected)).sub, expected.sub);
    assert.equal(client.occupancy.activeTransports, 0); status = 401;
    await assert.rejects(client.check(expected), failed(503));
    await settled(() => client.occupancy.activeTransports === 0);
    assert.equal(fixture.transport.occupancy.activeRequests, 0); assert.equal(fixture.observed.length, 2);
  });
