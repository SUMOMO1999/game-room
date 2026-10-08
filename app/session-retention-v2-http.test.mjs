import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readSettings } from '../server/config.mjs';
import { IdentityFailure } from '../server/auth.mjs';
import { EncryptedStore, MemoryAdapter, opaqueId, identityKey } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { makeEntries } from '../server/entry-context.mjs';

const BASE = Date.UTC(2026, 9, 8), HOUR = 3600000, DAY = 86400000;
const fingerprint = (settings, sub) => createHash('sha256').update(settings.issuer + '\0' + sub).digest('hex');
const resume = (settings, sub, code = '123456') => '/auth/resume?expectedIdentity=' + fingerprint(settings, sub)
  + '&returnTo=' + encodeURIComponent('/room.html?code=' + code);

async function fixture(t) {
  let clock = BASE;
  const now = () => clock, settings = readSettings({ GAME_ROOM_AUTH_MODE: 'cognito',
    GAME_ROOM_CLIENT_ID: 'retentionhttpclient1234', GAME_ROOM_SESSION_REFRESH_ENABLED: '1', GAME_ROOM_SESSION_MAX_DAYS: '30' });
  const definitions = [{ id: 'direct', origin: settings.origin, basePath: '/' },
    { id: 'agora', origin: 'http://127.0.0.1:39072', basePath: '/game/' }];
  const entries = makeEntries(settings, definitions), adapter = new MemoryAdapter({ now }),
    storage = new EncryptedStore(adapter, randomBytes(32), now);
  const provider = { checks: 0, refreshes: 0, status: 200,
    async check(identity) { this.checks++; if (this.status !== 200) throw new IdentityFailure(this.status);
      assert.ok(identity.expiresAt > now()); return { ...identity }; },
    async refresh(identity) { this.refreshes++; return { issuer: identity.issuer, sub: identity.sub,
      clientId: identity.clientId, authTime: identity.authTime, accessToken: 'own-http-renewed-token', expiresAt: now() + HOUR }; },
    async begin() { throw new Error('entry probe/resume must not start OAuth'); } };
  const runtime = createRuntime(settings, { storage, provider, now, roomOptions: { pollIntervalMs: 0 } });
  const server = createUnifiedServer({ ...runtime, entries: definitions });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = 'http://127.0.0.1:' + server.address().port;
  async function seed(entryId, sub) {
    const entry = entries.find(candidate => candidate.id === entryId), id = opaqueId();
    const session = { phase: 'active', entryKey: entry.key, issuer: settings.issuer, sub,
      userKey: identityKey(settings.issuer, sub), clientId: settings.clientId, authTime: Math.floor(BASE / 1000) - 100,
      accessToken: 'own-http-old-' + sub, csrf: opaqueId(), createdAt: now(), lastIdentityCheck: now(),
      expiresAt: now() + HOUR, idleUntil: now() + settings.idleMs, sessionVersion: 2,
      sessionExpiresAt: now() + 30 * DAY, refreshIssuedAt: now(), refreshExpiresAt: now() + 30 * DAY,
      refreshToken: 'own-http-refresh-' + sub };
    await storage.put('sessions', id, session, session.sessionExpiresAt);
    return { id, entryId, sub, cookie: `${entry.cookieName}=${id}`, csrf: session.csrf, userKey: session.userKey, session };
  }
  async function request(member, path, { method = 'GET', body, cookie = member.cookie } = {}) {
    const entry = entries.find(candidate => candidate.id === member.entryId), prefix = entry.basePath === '/' ? '' : '/game';
    const response = await new Promise((resolve, reject) => {
      const outgoing = http.request(base + prefix + path, { method, headers: { host: entry.host, cookie,
        ...(method === 'GET' ? {} : { origin: entry.origin, 'x-csrf-token': member.csrf, 'content-type': 'application/json' }) } }, incoming => {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode, headers }));
      });
      outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const text = await response.text(); return { response, body: text ? JSON.parse(text) : null };
  }
  return { settings, entries, adapter, storage, runtime, provider, seed, request, now, advance(ms) { clock += ms; } };
}

test('HTTP dormant entry probes reveal only the own-entry fingerprint, preserve idle and never create a profile or room', async t => {
  const f = await fixture(t), direct = await f.seed('direct', 'member-a'), mounted = await f.seed('agora', 'member-a');
  f.advance(2 * HOUR);
  f.runtime.rooms.ensureProfile = async () => { throw new Error('probe must not create profile'); };
  f.runtime.rooms.recentRooms = async () => { throw new Error('probe must not enumerate rooms'); };
  for (const member of [direct, mounted]) {
    const result = await f.request(member, '/api/entry-status');
    assert.equal(result.response.status, 200); assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.response.headers.get('set-cookie'), null);
    assert.deepEqual(result.body, { identityFingerprint: fingerprint(f.settings, member.sub) });
    const record = await f.storage.read('sessions', member.id);
    assert.equal(record.value.idleUntil, member.session.idleUntil); assert.equal(record.expiresAt, member.session.sessionExpiresAt);
    assert.ok(!JSON.stringify(result.body).includes('own-http-'));
  }
  assert.equal(f.provider.refreshes, 2);
  assert.ok([...f.adapter.records.keys()].every(key => key.startsWith('sessions:')));
});

test('HTTP expected identity cannot authorize a cold or foreign-entry Cookie and mismatch does not activate dormant v2', async t => {
  const f = await fixture(t), direct = await f.seed('direct', 'member-a'), mounted = await f.seed('agora', 'member-a');
  f.advance(2 * HOUR);
  const foreign = await f.request(mounted, '/api/entry-status', { cookie: direct.cookie });
  assert.equal(foreign.response.status, 401);
  const cold = await f.request(mounted, resume(f.settings, mounted.sub), { cookie: direct.cookie });
  assert.equal(cold.response.status, 303); assert.match(cold.response.headers.get('location'), /^\/game\/auth\/login\?/);
  const mismatch = await f.request(mounted, resume(f.settings, 'member-b'));
  assert.equal(mismatch.response.status, 409); assert.equal((await f.storage.get('sessions', mounted.id)).idleUntil, mounted.session.idleUntil);
  assert.equal((await f.storage.get('sessions', direct.id)).accessToken, direct.session.accessToken);
});

test('HTTP invitation resume restores the same original seat and hand across entries without merging another player hand', async t => {
  const f = await fixture(t), first = await f.seed('direct', 'member-a'), other = await f.seed('direct', 'member-b'),
    mounted = await f.seed('agora', 'member-a');
  const created = await f.request(first, '/api/rooms', { method: 'POST', body: { name: '同名伙伴', requestId: randomUUID() } });
  assert.equal(created.response.status, 201); const code = created.body.roomCode;
  const joined = await f.request(other, `/api/rooms/${code}/join`, { method: 'POST', body: { name: '同名伙伴', requestId: randomUUID() } });
  assert.equal(joined.response.status, 201);
  for (const [member, type] of [[first, 'ready'], [other, 'ready'], [first, 'start']]) {
    const current = (await f.request(member, `/api/rooms/${code}`)).body.view;
    const changed = await f.request(member, `/api/rooms/${code}/actions`, { method: 'POST', body: { type,
      ...(type === 'ready' ? { ready: true } : {}), expectedRevision: current.revision, requestId: randomUUID() } });
    assert.equal(changed.response.status, 200);
  }
  const before = (await f.request(first, `/api/rooms/${code}`)).body.view,
    otherBefore = (await f.request(other, `/api/rooms/${code}`)).body.view;
  assert.equal(before.game.rack.length, 14);
  f.advance(2 * HOUR);
  const status = await f.request(mounted, '/api/entry-status'); assert.equal(status.response.status, 200);
  const result = await f.request(mounted, resume(f.settings, mounted.sub, code));
  assert.equal(result.response.status, 303); assert.equal(result.response.headers.get('location'), `/game/room.html?code=${code}`);
  const recovered = (await f.request(mounted, `/api/rooms/${code}`)).body.view;
  assert.equal(recovered.selfId, before.selfId); assert.equal(recovered.roomId, before.roomId);
  assert.deepEqual(recovered.game.rack, before.game.rack);
  assert.ok(recovered.game.rack.every(tile => !otherBefore.game.rack.some(otherTile => tile.id === otherTile.id)));
  assert.equal((await f.storage.get('sessions', mounted.id)).authTime, mounted.session.authTime);
  assert.equal((await f.storage.get('sessions', first.id)).idleUntil, first.session.idleUntil);
});

test('HTTP identity availability failure remains 503 with retained credentials and no automatic OAuth or private response', async t => {
  const f = await fixture(t), member = await f.seed('agora', 'member-a'); f.advance(2 * HOUR); f.provider.status = 503;
  for (const path of ['/api/entry-status', resume(f.settings, member.sub)]) {
    const result = await f.request(member, path);
    assert.equal(result.response.status, 503); assert.equal(result.response.headers.get('location'), null);
    assert.equal(result.response.headers.get('set-cookie'), null); assert.ok(!JSON.stringify(result.body).includes('own-http-'));
    const current = await f.storage.get('sessions', member.id);
    assert.ok(current); assert.equal(current.refreshToken, member.session.refreshToken);
    assert.equal(current.idleUntil, member.session.idleUntil);
  }
});
