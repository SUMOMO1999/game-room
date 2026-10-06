import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { IdentityFailure } from '../server/auth.mjs';

// This optional test never downloads a proxy, installs a CA, requests a public
// certificate or contacts Agora. The current local binary was independently
// checked against the official Caddy 2.11.7 mac_arm64 release checksums.
const caddyBinary = process.env.GAME_ROOM_TEST_CADDY;
const caddySha = process.env.GAME_ROOM_TEST_CADDY_SHA256 || '0d746e47f39d9706883b3633bf419feb25973e6caaa8eabbf5b44421d59e3973';
const missingProxy = (!caddyBinary || !existsSync(caddyBinary)) && 'Set GAME_ROOM_TEST_CADDY to a checksum-pinned local Caddy binary to run the optional TLS proxy smoke tests';
const runFile = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function fixture(t) {
  assert.match(caddySha, /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(await readFile(caddyBinary)).digest('hex'), caddySha, 'Never execute an unverified proxy binary');
  const directory = await mkdtemp(path.join(tmpdir(), 'game-proxy-smoke-'));
  await chmod(directory, 0o700);
  let upstream, runtime, proxy, proxyExit, logs = '', upstreamClosed = false;
  const streams = new Set(), observed = [];
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
      proxy.kill('SIGTERM');
      await Promise.race([proxyExit, delay(2000)]);
      if (proxy.exitCode === null && proxy.signalCode === null) { proxy.kill('SIGKILL'); await proxyExit; }
    }
    if (upstream?.listening) { await upstream.shutdown(); upstreamClosed = true; }
    else if (runtime && !upstreamClosed) { await runtime.rooms.close(); runtime.storage.close(); }
    await rm(directory, { recursive: true, force: true });
  });
  const certificate = path.join(directory, 'localhost.crt'), privateKey = path.join(directory, 'localhost.key');
  await runFile(process.env.OPENSSL_TEST_BINARY || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes', '-subj', '/CN=game.sumomoli.com', '-addext', 'subjectAltName=DNS:game.sumomoli.com', '-keyout', privateKey, '-out', certificate], { timeout: 10000 });
  await chmod(privateKey, 0o600); await chmod(certificate, 0o600);
  const settings = readSettings({ NODE_ENV: 'production', GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'syntheticownclient12345678', GAME_ROOM_STORE_PATH: path.join(directory, 'test.sqlite'), GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') });
  const provider = {
    member: 'synthetic-a', checks: 0, checkedSubjects:[],
    async begin(returnTo) {
      const state = randomBytes(32).toString('base64url'), url = new URL(settings.callback);
      url.searchParams.set('code', 'synthetic-test-code'); url.searchParams.set('state', state);
      return { url, transaction: { state, nonce: randomUUID(), codeVerifier: randomBytes(32).toString('base64url'), member: this.member, returnTo } };
    },
    async complete(url, transaction) {
      if (url.searchParams.get('code') !== 'synthetic-test-code' || url.searchParams.get('state') !== transaction.state) throw new IdentityFailure();
      return { issuer: settings.issuer, sub: transaction.member, accessToken: 'synthetic-server-only-token',
        authTime:Math.floor(Date.now()/1000),clientId:settings.clientId,expiresAt: Date.now() + 3600000 };
    },
    async check(identity) { this.checks++;this.checkedSubjects.push(identity.sub); return { ...identity }; },
  };
  runtime = createRuntime(settings, { provider, roomOptions: { pollIntervalMs: 0, gameOptions: { firstTurnIndex: 0, randomInt: maximum => maximum - 1 } } });
  upstream = createUnifiedServer({ ...runtime, watchdogMs: 15000 });
  upstream.on('request', req => observed.push({ path: req.url, host: req.headers.host, peer: req.headers['x-game-room-peer'] }));
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  const upstreamPort = upstream.address().port, port = await unusedPort();
  let config = await readFile(new URL('../infra/Caddyfile', import.meta.url), 'utf8');
  // Only isolate listeners/certificate handling; keep the release proxy and
  // default error logger blocks unchanged, including both header overrides.
  config = config.replace(/^\{\n/, '{\n  admin off\n  auto_https off\n');
  config = config.replace('game.sumomoli.com {', `https://game.sumomoli.com:${port} {\n  bind 127.0.0.1\n  tls ${certificate} ${privateKey}`);
  config = config.replace('reverse_proxy 127.0.0.1:4177 {', `reverse_proxy 127.0.0.1:${upstreamPort} {`);
  const configPath = path.join(directory, 'Caddyfile'); await writeFile(configPath, config, { mode: 0o600 });
  proxy = spawn(caddyBinary, ['run', '--config', configPath, '--adapter', 'caddyfile'], { env: { ...process.env, XDG_DATA_HOME: path.join(directory, 'xdg-data'), XDG_CONFIG_HOME: path.join(directory, 'xdg-config') }, stdio: ['ignore', 'pipe', 'pipe'] });
  proxyExit = once(proxy, 'exit').catch(() => {});
  for (const stream of [proxy.stdout, proxy.stderr]) stream.on('data', chunk => { logs += chunk; if (logs.length > 524288) logs = logs.slice(-524288); });
  const ca = await readFile(certificate);
  function request(route, { method = 'GET', cookie = '', csrf, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? null : JSON.stringify(body);
      const req = https.request({ hostname: '127.0.0.1', port, servername: 'game.sumomoli.com', ca, agent: false, path: route, method, headers: { Host: 'game.sumomoli.com', ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: settings.origin } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {}), ...headers } }, res => {
        let text = ''; const authorized = res.socket.authorized;
        res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
        res.on('end', () => { let value = null; try { value = text ? JSON.parse(text) : null; } catch {} resolve({ status: res.statusCode, headers: res.headers, text, body: value, authorized }); });
        res.on('error', reject);
      });
      req.setTimeout(3000, () => req.destroy(new Error('Local TLS request timed out'))); req.on('error', reject); req.end(encoded);
    });
  }
  let ready = false, lastFailure;
  for (let attempt = 0; attempt < 50 && proxy.exitCode === null; attempt++) {
    try { const response = await request('/healthz'); if (response.status === 200) { assert.equal(response.authorized, true); ready = true; break; } }
    catch (error) { lastFailure = error; }
    await delay(50);
  }
  assert.ok(ready, `Local Caddy did not become ready: ${lastFailure?.message || ''}\n${logs}`);
  async function login(member, returnTo = '/') {
    provider.member = member;
    const started = await request('/auth/login?returnTo=' + encodeURIComponent(returnTo)); assert.equal(started.status, 303);
    const tx = started.headers['set-cookie'][0].split(';')[0], callbackUrl = new URL(started.headers.location);
    const callback = await request(callbackUrl.pathname + callbackUrl.search, { cookie: tx }); assert.equal(callback.status, 303);
    const sessionCookie = callback.headers['set-cookie'].find(value => value.startsWith(settings.cookieName + '='));
    assert.ok(sessionCookie); for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(sessionCookie.includes(flag)); assert.ok(!sessionCookie.includes('Domain='));
    const cookie = sessionCookie.split(';')[0], state = await request('/api/state', { cookie }); assert.equal(state.body.authenticated, true);
    return { cookie, csrf: state.body.csrf, state: state.body, callback };
  }
  async function stream(member, roomCode) {
    const events = []; let failure, ended = false, pending = [];
    const changed = () => { const entries = pending; pending = []; for (const resolve of entries) resolve(); };
    const req = https.request({ hostname: '127.0.0.1', port, servername: 'game.sumomoli.com', ca, agent: false, path: `/api/rooms/${roomCode}/events`, headers: { Host: 'game.sumomoli.com', Cookie: member.cookie } });
    streams.add(req); req.on('error', error => { failure = error; changed(); });
    req.on('response', res => {
      if (res.statusCode !== 200) { failure = new Error('Expected an authenticated SSE connection'); changed(); return; }
      assert.equal(res.socket.authorized, true); assert.match(res.headers['content-type'], /^text\/event-stream/);
      let buffer = ''; res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk; let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
        changed();
      });
      res.on('error', error => { failure = error; changed(); }); res.on('end', () => { ended = true; changed(); });
    });
    req.end();
    async function until(type, predicate = () => true, after = 0) {
      const deadline = Date.now() + 3000;
      while (true) {
        const event = events.slice(after).find(event => event.type === type && predicate(event.data));
        if (event) return event.data;
        if (failure) throw failure;
        if (ended) throw new Error('SSE ended before the expected event');
        assert.ok(Date.now() < deadline, 'Caddy must deliver the SSE event within three seconds, without waiting for a heartbeat or response completion');
        let timer;
        await new Promise(resolve => { const wake = () => { clearTimeout(timer); resolve(); }; pending.push(wake); timer = setTimeout(wake, Math.max(1, deadline - Date.now())); });
      }
    }
    await until('view');
    return { events, until, close() { streams.delete(req); req.destroy(); } };
  }
  return { settings, request, login, stream, provider, observed, logs: () => logs, async closeUpstream() { await upstream.shutdown(); upstreamClosed = true; } };
}

test('real local TLS proxy preserves invitation/Secure cookies and promptly isolates each private SSE session', { skip: missingProxy, timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.login('synthetic-a', '/?room=123456');
  assert.equal(a.callback.headers.location, '/?room=123456');
  const created = await f.request('/api/rooms', { method: 'POST', ...a, body: { name: '同昵称', requestId: randomUUID() }, headers: { 'X-Game-Room-Peer': '198.51.100.123' } });
  assert.equal(created.status, 201); assert.equal(f.observed.at(-1).host, 'game.sumomoli.com'); assert.equal(f.observed.at(-1).peer, '127.0.0.1');
  const roomCode = created.body.roomCode, b = await f.login('synthetic-b', `/?room=${roomCode}`);
  assert.equal((await f.request(`/api/rooms/${roomCode}`, b)).status, 403);
  const joined = await f.request(`/api/rooms/${roomCode}/join`, { method: 'POST', ...b, body: { name: '同昵称', requestId: randomUUID() } }); assert.equal(joined.status, 201); assert.notEqual(joined.body.playerId, created.body.playerId);
  async function action(member, type, extra = {}) {
    const latest = await f.request(`/api/rooms/${roomCode}`, member);
    const changed = await f.request(`/api/rooms/${roomCode}/actions`, { method: 'POST', ...member, body: { type, ...extra, requestId: randomUUID(), expectedRevision: latest.body.view.revision } });
    assert.equal(changed.status, 200, changed.text); return changed.body.view;
  }
  await action(a, 'ready', { ready: true }); await action(b, 'ready', { ready: true }); await action(a, 'start');
  const streamA = await f.stream(a, roomCode), streamB = await f.stream(b, roomCode);
  const viewA = await streamA.until('view'), viewB = await streamB.until('view');
  assert.equal(viewA.selfId, created.body.playerId); assert.equal(viewB.selfId, joined.body.playerId); assert.equal(viewA.game.rack.length, 14); assert.equal(viewB.game.rack.length, 14);
  for (const tile of viewB.game.rack) assert.ok(!JSON.stringify(viewA).includes(`"${tile.id}"`));
  for (const tile of viewA.game.rack) assert.ok(!JSON.stringify(viewB).includes(`"${tile.id}"`));
  const countA = streamA.events.length, countB = streamB.events.length, changed = await action(a, 'draw');
  assert.equal((await streamA.until('view', view => view.revision === changed.revision, countA)).game.rack.length, 15);
  assert.equal((await streamB.until('view', view => view.revision === changed.revision, countB)).game.rack.length, 14);
  const anotherDevice = await f.login('synthetic-a'), ownChecks=()=>f.provider.checkedSubjects.filter(sub=>sub==='synthetic-a').length,checksBefore=ownChecks();
  assert.equal((await f.request('/auth/logout', { method: 'POST', ...a })).status, 200);
  assert.equal((await streamA.until('closed')).status, 401); assert.equal(ownChecks(), checksBefore);
  assert.equal((await f.request(`/api/rooms/${roomCode}`, a)).status, 401);
  assert.equal((await f.request(`/api/rooms/${roomCode}`, anotherDevice)).body.view.selfId, created.body.playerId);
  const stillOpen = streamB.events.length, next = await action(b, 'draw');
  assert.equal((await streamB.until('view', view => view.revision === next.revision, stillOpen)).game.rack.length, 15);
  streamA.close(); streamB.close();
});

test('real Caddy default error logger redacts callback query and credential headers on an upstream 502', { skip: missingProxy, timeout: 20000 }, async t => {
  const f = await fixture(t); await f.closeUpstream();
  const secrets = ['synthetic-callback-code-DO-NOT-LOG', 'synthetic-query-state-DO-NOT-LOG', 'synthetic-cookie-DO-NOT-LOG', 'synthetic-bearer-DO-NOT-LOG', 'synthetic-csrf-DO-NOT-LOG'];
  const result = await f.request(`/auth/callback?code=${secrets[0]}&state=${secrets[1]}`, { headers: { Cookie: `__Host-game-room-session=${secrets[2]}`, Authorization: `Bearer ${secrets[3]}`, 'X-CSRF-Token': secrets[4] } });
  assert.equal(result.status, 502);
  let errorLog;
  for (let attempt = 0; attempt < 20; attempt++) {
    errorLog = f.logs().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(entry => entry?.logger === 'http.log.error' && entry.status === 502);
    if (errorLog) break; await delay(20);
  }
  assert.ok(errorLog, 'The test must observe the actual 502 error log, not merely an empty log');
  assert.equal(Object.hasOwn(errorLog.request, 'uri'), false); assert.equal(Object.hasOwn(errorLog.request, 'headers'), false);
  assert.equal(errorLog.request.host, 'game.sumomoli.com');
  for (const secret of secrets) assert.ok(!f.logs().includes(secret), 'Proxy logs must exclude each supplied synthetic credential');
});
