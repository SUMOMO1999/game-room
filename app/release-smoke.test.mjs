import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This test is intentionally excluded by releaseSources. No test identity is shipped.
// The normal suite links existing dependencies; explicit locked mode independently installs
// the actual tar's lockfile, using a private npm cache and no user/global npm configuration.
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
// Explicit local candidates can be checked without rewriting the deployed release descriptor.
const readinessPath = process.env.GAME_ROOM_SMOKE_DESCRIPTOR || path.join(projectRoot, 'ops/production-readiness.json');
const readiness = JSON.parse(readFileSync(readinessPath, 'utf8'));
const descriptor = readiness.application;
const artifact = path.resolve(projectRoot, 'ops', descriptor.artifact);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Calibrating a public clock never changes persisted identity, seats, hand or turn fences.
function assertStableView(actual, expected) {
  const { serverTime: actualTime, ...actualStable } = actual;
  const { serverTime: expectedTime, ...expectedStable } = expected;
  if (Object.hasOwn(actual, 'turnClock')) { assert.ok(Number.isFinite(actualTime)); assert.ok(Number.isFinite(expectedTime)); }
  assert.deepEqual(actualStable, expectedStable);
}


// Match the Linux installer: macOS BSD tar's listing can conceal ._ AppleDouble
// members. No extraction occurs before this complete raw member inventory passes.
function inspectArchive(artifactPath) {
  return JSON.parse(execFileSync('python3', ['-c', `
import hashlib, json, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    entries = [{'name': member.name, 'regular': member.isreg(), 'symbolicLink': member.issym(), 'hardLink': member.islnk(), 'paxHeaders': member.pax_headers,
                'sha256': hashlib.sha256(archive.extractfile(member).read()).hexdigest() if member.isreg() else None} for member in members]
    manifest_members = [member for member in members if member.name == 'release-manifest.json']
    if len(manifest_members) != 1 or not manifest_members[0].isreg():
        raise RuntimeError('Release must have one regular manifest')
    print(json.dumps({'members': entries, 'manifest': json.load(archive.extractfile(manifest_members[0]))}))
`, artifactPath], { encoding: 'utf8' }));
}

function unpack(t, cleanup = () => {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'game-release-smoke-'));
  t.after(async () => { await cleanup(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(hash(readFileSync(artifact)), descriptor.sha256);
  const archive = inspectArchive(artifact);
  const members = archive.members.map(member => member.name);
  assert.equal(members.length, descriptor.files + 1);
  for (const member of archive.members) {
    assert.ok(member.regular && !member.symbolicLink && !member.hardLink, member.name);
    assert.ok(Object.keys(member.paxHeaders).every(header => !/(?:xattr|acl|fflags?)/i.test(header)), `Extended attributes are forbidden: ${member.name}`);
  }
  assert.ok(members.every(file => /^[A-Za-z0-9_./-]+$/.test(file)
    && !path.isAbsolute(file) && !file.split('/').includes('..') && !file.endsWith('/')));
  assert.equal(new Set(members).size, members.length);
  const manifest = archive.manifest;
  assert.equal(manifest.releaseId, descriptor.releaseId);
  assert.equal(manifest.identity, 'dedicated-client-required');
  assert.equal(manifest.containsSecrets, false);
  assert.equal(manifest.containsUserData, false);
  assert.equal(manifest.sourceFiles.length, descriptor.files);
  assert.equal(manifest.packagingFormat, 2);
  assert.equal(hash(JSON.stringify({ packagingFormat: manifest.packagingFormat, sourceFiles: manifest.sourceFiles })).slice(0, 20), manifest.releaseId);
  assert.deepEqual(new Set(members), new Set([...manifest.sourceFiles.map(entry => entry.file), 'release-manifest.json']));
  for (const entry of manifest.sourceFiles) assert.equal(archive.members.find(member => member.name === entry.file).sha256, entry.sha256, entry.file);
  execFileSync('tar', ['-xzf', artifact, '-C', directory]);
  for (const { file, sha256 } of manifest.sourceFiles) {
    const target = path.join(directory, file);
    assert.equal(statSync(target).isFile(), true);
    assert.equal(hash(readFileSync(target)), sha256, file);
    assert.ok(!/(?:\.test\.mjs$|^\.local\/|^ops\/|^specs\/|^node_modules\/|\.env$|^scripts\/local-identity-preview\.mjs$|^app\/server\.mjs$)/.test(file), file);
  }
  return { directory, manifest };
}

test('recorded release tar has an exact manifest, matching file hashes and no private or test content', t => {
  const { manifest } = unpack(t);
  assert.ok(manifest.sourceFiles.some(entry => entry.file === 'scripts/production-start.mjs'));
  assert.ok(manifest.sourceFiles.some(entry => entry.file === 'server/backup.mjs'));
});

test('extracted release enforces v3 settings, public observers and ephemeral previews, then restores private seats and formal geometry', { timeout: 120000 }, async t => {
  let current;
  const { directory, manifest } = unpack(t, async () => {
    if (!current) return;
    if (current.server.listening) await current.server.shutdown();
    else { current.runtime.preview?.close();await current.runtime.chat?.close(); await current.runtime.rooms.close(); current.runtime.storage.close(); }
  });
  if (process.env.GAME_ROOM_SMOKE_INSTALL === 'locked') {
    const configuration = path.join(directory, 'empty-user-npmrc'), globalConfiguration = path.join(directory, 'empty-global-npmrc');
    writeFileSync(configuration, '', { mode: 0o600 }); writeFileSync(globalConfiguration, '', { mode: 0o600 });
    execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], {
      cwd: directory, timeout: 60000, encoding: 'utf8',
      env: { ...process.env, npm_config_cache: path.join(directory, 'npm-cache'),
        npm_config_userconfig: configuration, npm_config_globalconfig: globalConfiguration },
    });
    assert.equal(statSync(path.join(directory, 'node_modules')).isDirectory(), true);
    t.diagnostic(`release ${manifest.releaseId}: independently installed locked public dependencies with scripts disabled`);
  } else {
    symlinkSync(path.join(projectRoot, 'node_modules'), path.join(directory, 'node_modules'));
    t.diagnostic(`release ${manifest.releaseId}: existing node_modules linked; independent installation not claimed`);
  }
  const load = relative => import(pathToFileURL(path.join(directory, relative)).href);
  const [{ readSettings, FORBIDDEN_CLIENT_IDS }, { createRuntime }, { createUnifiedServer },
    { CognitoProvider, MockProvider }, { prepareProduction }, { backupStore, restoreStore, verifyBackup }] = await Promise.all([
    load('server/config.mjs'), load('server/runtime.mjs'), load('server/unified-http.mjs'),
    load('server/auth.mjs'), load('server/production.mjs'), load('server/backup.mjs'),
  ]);
  const key = randomBytes(32), keyFile = path.join(directory, 'test-store.key');
  writeFileSync(keyFile, key.toString('base64url'), { mode: 0o600 });
  const livePath = path.join(directory, 'live.sqlite');
  const env = { NODE_ENV: 'production', GAME_ROOM_AUTH_MODE: 'cognito',
    GAME_ROOM_ORIGIN: 'https://game.sumomoli.com', GAME_ROOM_CLIENT_ID: 'syntheticclientforsmoke',
    GAME_ROOM_STORE_KEY_FILE: keyFile, GAME_ROOM_STORE_PATH: livePath };
  assert.throws(() => readSettings({ ...env, GAME_ROOM_CLIENT_ID: '' }), /dedicated game-room client/);
  for (const client of FORBIDDEN_CLIENT_IDS) assert.throws(() => readSettings({ ...env, GAME_ROOM_CLIENT_ID: client }), /own client/);
  assert.throws(() => new MockProvider(readSettings(env)), /local-only/);
  // Exercise the actual production boot guard, then close it before injected HTTP tests.
  const preflight = await prepareProduction(env);
  preflight.preview?.close();await preflight.chat?.close(); await preflight.rooms.close(); preflight.storage.close();
  async function open(storePath = livePath) {
    const settings = readSettings({ ...env, GAME_ROOM_STORE_PATH: storePath });
    const actual = new CognitoProvider(settings);
    const provider = {
      member: 'release-member-a',
      begin: returnTo => actual.begin(returnTo),
      complete: async (url, transaction) => {
        assert.equal(url.searchParams.get('state'), transaction.state);
        assert.equal(url.searchParams.get('code'), 'test-only-callback');
        return { issuer: settings.issuer, sub: provider.member, accessToken: 'synthetic-release-server-only', expiresAt: Date.now() + 3600000,
          clientId: settings.clientId, authTime: Math.floor(Date.now() / 1000) };
      },
      check: async identity => ({ issuer: identity.issuer, sub: identity.sub, clientId: identity.clientId,
        authTime: identity.authTime, expiresAt: identity.expiresAt }),
    };
    const runtime = createRuntime(settings, { provider, roomOptions: { pollIntervalMs: 0,
      gameOptions: { firstTurnIndex: 0, randomInt: max => max - 1 } } });
    const server = createUnifiedServer(runtime);
    current = { server, runtime, provider };
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    async function request(route, { method = 'GET', cookie, csrf, body, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const content = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method,
          headers: { Host: new URL(settings.origin).host, ...(cookie ? { Cookie: cookie } : {}),
            ...(method !== 'GET' && method !== 'HEAD' ? { Origin: settings.origin } : {}),
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
            ...(content ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(content) } : {}), ...headers } }, res => {
          const chunks = []; res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, headers: res.headers, body: text && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text || null }); });
          res.on('error', reject);
        });
        req.setTimeout(5000, () => req.destroy(new Error('Isolated release HTTP timeout')));
        req.on('error', reject); req.end(content);
      });
    }
    async function login(member, returnTo = '/') {
      provider.member = member;
      const start = await request('/auth/login?returnTo=' + encodeURIComponent(returnTo));
      assert.equal(start.status, 303);
      const location = new URL(start.headers.location);
      assert.equal(location.origin, settings.authDomain);
      assert.equal(location.pathname, '/oauth2/authorize');
      assert.equal(location.searchParams.get('client_id'), env.GAME_ROOM_CLIENT_ID);
      assert.equal(location.searchParams.get('redirect_uri'), settings.callback);
      assert.equal(location.searchParams.get('scope'), 'openid');
      assert.equal(location.searchParams.get('response_type'), 'code');
      assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(location.searchParams.get('code_challenge'));
      assert.ok(location.searchParams.get('nonce'));
      const tx = start.headers['set-cookie'][0];
      assert.match(tx, /^__Host-game-room-transaction=/);
      assert.match(tx, /; Secure/); assert.match(tx, /; HttpOnly/); assert.match(tx, /; SameSite=Lax/);
      assert.ok(!tx.includes('Domain='));
      const callback = await request('/auth/callback?code=test-only-callback&state=' + encodeURIComponent(location.searchParams.get('state')), { cookie: tx.split(';')[0] });
      assert.equal(callback.status, 303); assert.equal(callback.headers.location, returnTo);
      const issued = callback.headers['set-cookie'].find(value => value.startsWith('__Host-game-room-session='));
      assert.match(issued, /; Path=\//); assert.match(issued, /; Secure/); assert.match(issued, /; HttpOnly/);
      assert.ok(!issued.includes('Domain='));
      const cookie = issued.split(';')[0], state = await request('/api/state', { cookie });
      assert.equal(state.body.authenticated, true);
      return { cookie, csrf: state.body.csrf, state: state.body };
    }
    return { ...current, request, login };
  }
  async function stop() { await current.server.shutdown(); current = null; }
  const f = await open();
  const health = await f.request('/healthz'); assert.deepEqual(health.body, { ok: true });
  assert.equal(health.status, 200); assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal((await f.request('/healthz', { method: 'HEAD' })).body, null);
  const a = await f.login('release-member-a');
  const created = await f.request('/api/rooms', { method: 'POST', ...a, body: { name: '同名', requestId: randomUUID() } });
  assert.equal(created.status, 201); const room = created.body;
  const b = await f.login('release-member-b', `/room.html?code=${room.roomCode}`);
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`, b)).status, 403);
  const joined = await f.request(`/api/rooms/${room.roomCode}/join`, { method: 'POST', ...b, body: { name: '同名', requestId: randomUUID() } });
  assert.equal(joined.status, 201); assert.notEqual(joined.body.playerId, room.playerId);
  const supportsChat = manifest.sourceFiles.some(entry => entry.file === 'server/chat.mjs');
  let chatMessage;
  const chatRequest = { text: '候选制品中的合成聊天', requestId: randomUUID() };
  if (supportsChat) {
    assert.equal((await f.request('/room-chat.mjs')).status, 200);
    assert.equal((await f.request(`/api/rooms/${room.roomCode}/chat`)).status, 401);
    assert.equal((await f.request(`/api/rooms/${room.roomCode}/chat`, { method: 'POST', cookie: a.cookie, body: chatRequest })).status, 403);
    const sent = await f.request(`/api/rooms/${room.roomCode}/chat`, { method: 'POST', ...a, body: chatRequest });
    assert.equal(sent.status, 200); chatMessage = sent.body.message;
    assert.equal(chatMessage.playerId, room.playerId);
    const other = await f.request(`/api/rooms/${room.roomCode}/chat`, b);
    assert.equal(other.body.messages[0].text, chatRequest.text);
    assert.equal(other.body.messages[0].requestId, undefined);
    assert.ok(!JSON.stringify(other.body).includes(a.state.userKey));
  }
  assert.equal((await f.request('/api/rooms', { method: 'POST', cookie: a.cookie, body: { name: '未授权', requestId: randomUUID() } })).status, 403);
  async function view(fixture, member) {
    const response = await fixture.request(`/api/rooms/${room.roomCode}`, member);
    assert.equal(response.status, 200); return response.body.view;
  }
  async function action(member, type, extra = {}) {
    const latest = await view(f, member);
    const response = await f.request(`/api/rooms/${room.roomCode}/actions`, { method: 'POST', ...member,
      body: { type, requestId: randomUUID(), expectedRevision: latest.revision, ...extra } });
    assert.equal(response.status, 200); return response.body.view;
  }
  await action(a, 'ready', { ready: true }); await action(b, 'ready', { ready: true });
  const jokerConfig={normal:2,mirror:1,colorChange:1,double:1};
  const configured=await action(a,'configure',{jokerConfig});
  assert.deepEqual(configured.jokerConfig,jokerConfig);
  assert.ok(configured.players.every(player=>!player.ready),'changed rules must revoke every prior ready acknowledgement');
  const premature=await f.request(`/api/rooms/${room.roomCode}/actions`,{method:'POST',...a,
    body:{type:'start',requestId:randomUUID(),expectedRevision:configured.revision}});
  assert.equal(premature.status,409);
  await action(a, 'ready', { ready: true }); await action(b, 'ready', { ready: true }); await action(a, 'start');
  const started=await view(f,a);
  assert.equal(started.game.ruleVersion,'friends-v4');assert.deepEqual(started.game.jokerConfig,jokerConfig);
  assert.equal(started.game.jokerCount,5);assert.equal(started.game.tileCount,109);
  const c=await f.login('release-member-observer',`/room.html?code=${room.roomCode}`);
  const observed=await f.request(`/api/rooms/${room.roomCode}/join`,{method:'POST',...c,
    body:{name:'同名',role:'player',requestId:randomUUID()}});
  assert.equal(observed.status,201);assert.equal(observed.body.view.selfRole,'spectator');
  assert.equal(observed.body.view.players.length,2);assert.notEqual(observed.body.playerId,room.playerId);
  const beforePreviewA=await view(f,a),beforePreviewB=await view(f,b),beforePreviewC=await view(f,c);
  for(const field of ['rack','opened','playerId'])assert.equal(Object.hasOwn(beforePreviewC.game,field),false,field);
  for(const tile of [...beforePreviewA.game.rack,...beforePreviewB.game.rack])assert.ok(!JSON.stringify(beforePreviewC).includes(`"${tile.id}"`));
  const observerWrite=await f.request(`/api/rooms/${room.roomCode}/actions`,{method:'POST',...c,
    body:{type:'draw',requestId:randomUUID(),expectedRevision:beforePreviewC.revision}});
  assert.equal(observerWrite.status,403);assertStableView(await view(f,c), beforePreviewC);
  const previewBody={previewId:randomUUID(),sequence:1,matchId:beforePreviewA.matchId,gameRevision:beforePreviewA.game.revision,
    boardIds:[[beforePreviewA.game.rack[0].id]],positions:[{x:.1,y:.2}]};
  const previewAck=await f.request(`/api/rooms/${room.roomCode}/preview`,{method:'POST',...a,body:previewBody});
  assert.equal(previewAck.status,200);assert.equal(previewAck.body.accepted,true);
  // The real optional publication budget also covers GET reconciliation.
  await new Promise(resolve=>setTimeout(resolve,Math.max(previewAck.body.minIntervalMs,previewAck.body.nextAllowedAt-Date.now(),0)+30));
  const publicPreview=await f.request(`/api/rooms/${room.roomCode}/preview`,c);
  assert.equal(publicPreview.status,200);assert.equal(publicPreview.body.preview.valid,false);
  assert.equal(publicPreview.body.preview.board.flat().length,1);
  assert.equal(publicPreview.body.preview.board[0][0].id,beforePreviewA.game.rack[0].id);
  for(const tile of beforePreviewA.game.rack.slice(1))assert.ok(!JSON.stringify(publicPreview.body).includes(`"${tile.id}"`));
  for(const tile of beforePreviewB.game.rack)assert.ok(!JSON.stringify(publicPreview.body).includes(`"${tile.id}"`));
  assertStableView(await view(f,a), beforePreviewA);assertStableView(await view(f,b), beforePreviewB);
  const opening=['red-10-a','blue-10-a','black-10-a'];
  assert.ok(opening.every(id=>beforePreviewA.game.rack.some(tile=>tile.id===id)),'deterministic test shuffle must provide the physical 30-point opening');
  const geometry=[{x:.72,y:.34}];
  const submitted=await action(a,'submit',{boardIds:[opening],rackIds:beforePreviewA.game.rack.filter(tile=>!opening.includes(tile.id)).map(tile=>tile.id),boardPositions:geometry});
  assert.deepEqual(submitted.game.boardPositions,geometry);
  const beforeA = await view(f, a), beforeB = await view(f, b);
  const beforeC=await view(f,c);
  assert.equal(beforeA.game.rack.length, 11); assert.equal(beforeB.game.rack.length, 14);
  assert.equal(beforeA.hostId, room.playerId); assert.equal(beforeA.game.turnPlayerId, joined.body.playerId);
  assert.deepEqual(beforeC.game.boardPositions,geometry);assert.equal(beforeC.selfRole,'spectator');
  const storedRoom=await f.runtime.storage.get('rooms',beforeA.roomId);
  assert.equal(storedRoom.snapshot.schemaVersion,8);assert.deepEqual(storedRoom.snapshot.jokerConfig,jokerConfig);
  for (const tile of beforeB.game.rack) assert.ok(!JSON.stringify(beforeA).includes(`"${tile.id}"`));
  for (const privateValue of [key.toString('base64url'), 'synthetic-release-server-only', a.state.userKey, b.state.userKey]) assert.ok(!JSON.stringify(beforeA).includes(privateValue));
  await stop();
  const restarted = await open();
  assertStableView(await view(restarted, a), beforeA); assertStableView(await view(restarted, b), beforeB);
  assertStableView(await view(restarted,c), beforeC);
  if (supportsChat) assert.equal((await restarted.request(`/api/rooms/${room.roomCode}/chat`, a)).body.messages[0].messageId, chatMessage.messageId);
  const secondDevice = await restarted.login('release-member-a', `/?room=${room.roomCode}`);
  assert.equal((await view(restarted, secondDevice)).selfId, room.playerId);
  assert.equal(secondDevice.state.recentRooms[0].playerId, room.playerId);
  const livePreview={previewId:randomUUID(),sequence:1,matchId:beforeB.matchId,gameRevision:beforeB.game.revision,
    boardIds:[...beforeB.game.board.map(meld=>meld.map(tile=>tile.id)),[beforeB.game.rack[0].id]],positions:[...geometry,{x:.2,y:.6}]};
  assert.equal((await restarted.request(`/api/rooms/${room.roomCode}/preview`,{method:'POST',...b,body:livePreview})).status,200);
  assert.ok(restarted.runtime.preview.packet(beforeC).preview,'backup is exercised while a public arrangement is active');
  assertStableView(await view(restarted,b), beforeB);
  const backupPath = path.join(directory, 'business-backup.sqlite'), restoredPath = path.join(directory, 'recovered.sqlite');
  const backed = await backupStore({ sourcePath: livePath, destinationPath: backupPath, key });
  assert.equal(backed.authSessionsIncluded, false); assert.ok(backed.excludedRecords >= 3);
  const { rows,manifest:backupManifest } = verifyBackup({ sourcePath: backupPath, key });
  assert.ok(rows.every(row => !/^(?:sessions|transactions|room-presence):/.test(row.key)));
  assert.ok(rows.every(row=>!row.key.includes('preview')));
  assert.deepEqual(new Set(backupManifest.scopes),new Set(['game-profiles','room-invites','rooms','room-memberships','room-registry','room-requests','room-chat','game-history','history-index']));
  await stop();
  const restored = restoreStore({ sourcePath: backupPath, destinationPath: restoredPath, key, offline: true });
  assert.equal(restored.authSessionsRestored, false);
  const recovered = await open(restoredPath);
  assert.equal((await recovered.request('/api/state', a)).body.authenticated, false);
  assert.equal((await recovered.request(`/api/rooms/${room.roomCode}`, a)).status, 401);
  const recoveredA = await recovered.login('release-member-a', `/room.html?code=${room.roomCode}`);
  const recoveredB = await recovered.login('release-member-b');
  const recoveredC=await recovered.login('release-member-observer',`/room.html?code=${room.roomCode}`);
  assertStableView(await view(recovered, recoveredA), beforeA);
  assertStableView(await view(recovered, recoveredB), beforeB);
  assertStableView(await view(recovered,recoveredC), beforeC);
  assert.equal(recoveredC.state.recentRooms[0].playerId,beforeC.selfId);assert.equal(recoveredC.state.recentRooms[0].selfRole,'spectator');
  const clearedPreview=await recovered.request(`/api/rooms/${room.roomCode}/preview`,recoveredC);
  assert.equal(clearedPreview.status,200);assert.equal(clearedPreview.body.preview,null);
  if (supportsChat) {
    const history = await recovered.request(`/api/rooms/${room.roomCode}/chat`, recoveredA);
    assert.equal(history.body.messages[0].expiresAt, chatMessage.expiresAt);
    const repeated = await recovered.request(`/api/rooms/${room.roomCode}/chat`, { method: 'POST', ...recoveredA, body: chatRequest });
    assert.equal(repeated.body.duplicate, true);
    assert.equal(repeated.body.message.messageId, chatMessage.messageId);
  }
  const logout = await recovered.request('/auth/logout', { method: 'POST', ...recoveredA });
  assert.equal(logout.status, 200); assert.equal((await recovered.request(`/api/rooms/${room.roomCode}`, recoveredA)).status, 401);
  assertStableView(await view(recovered, recoveredB), beforeB);
  t.diagnostic('Synthetic provider injection only: no real Cognito account, token exchange, TLS handshake, systemd service or cloud resource change was exercised');
});
