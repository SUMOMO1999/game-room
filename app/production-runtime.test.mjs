import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { readSettings, readStoreKey, isSystemdStoreCredential } from '../server/config.mjs';
import { prepareProduction, runtimeVersions } from '../server/production.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { identityKey } from '../server/storage.mjs';

function directory(t) { const dir = mkdtempSync(path.join(tmpdir(), 'game-production-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const base = () => ({ NODE_ENV: 'production', GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'ownclient12345678' });
test('systemd root-owned read-only credentials allow its UID ACL without weakening ordinary key-file rules', () => {
  const env = { CREDENTIALS_DIRECTORY: '/run/credentials/game-room.service', GAME_ROOM_STORE_KEY_FILE: '/run/credentials/game-room.service/store-key' };
  const file = { uid: 0, mode: 0o440, isFile: () => true }, dir = { uid: 0, mode: 0o550, isDirectory: () => true };
  assert.equal(isSystemdStoreCredential(env, file, dir), true);
  assert.equal(isSystemdStoreCredential({ ...env, GAME_ROOM_STORE_KEY_FILE: '/tmp/key' }, file, dir), false);
  assert.equal(isSystemdStoreCredential({ ...env, CREDENTIALS_DIRECTORY: '/run/credentials/agora.service' }, file, dir), false);
  assert.equal(isSystemdStoreCredential(env, { ...file, mode: 0o444 }, dir), false);
  assert.equal(isSystemdStoreCredential(env, file, { ...dir, uid: 501 }), false);
  assert.equal(isSystemdStoreCredential(env, file, { ...dir, mode: 0o570 }), false);
});
test('protected key file loads identical stable bytes and refuses competing, permissive, symlink or malformed sources', t => {
  const dir = directory(t), file = path.join(dir, 'key'), key = randomBytes(32);
  writeFileSync(file, key.toString('base64url') + '\n', { mode: 0o600 });
  assert.deepEqual(readStoreKey({ GAME_ROOM_STORE_KEY_FILE: file }), key);
  assert.throws(() => readStoreKey({ GAME_ROOM_STORE_KEY_FILE: file, GAME_ROOM_STORE_KEY: key.toString('base64url') }), /one/);
  chmodSync(file, 0o644); assert.throws(() => readStoreKey({ GAME_ROOM_STORE_KEY_FILE: file }), /owner-only/); chmodSync(file, 0o600);
  const link = path.join(dir, 'link'); symlinkSync(file, link); assert.throws(() => readStoreKey({ GAME_ROOM_STORE_KEY_FILE: link }), /owner-only/);
  assert.throws(() => readStoreKey({ GAME_ROOM_STORE_KEY_FILE: 'relative' }), /absolute/);
  assert.throws(() => readStoreKey({ GAME_ROOM_STORE_KEY: 'invalid' }), /32/);
});
test('production fails closed without own client or stable storage and binds only loopback', t => {
  const dir = directory(t), env = { ...base(), GAME_ROOM_STORE_PATH: path.join(dir, 'game.sqlite'), GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') };
  assert.equal(readSettings(env).host, '127.0.0.1');
  for (const clientId of ['15ieknek25quijgqdqcd8rfmom', '5dkhqk318ogvf9qjvp0p5m7dfi', '27ol1sbgk8g9c4deeqvjcifs77']) assert.throws(() => readSettings({ ...env, GAME_ROOM_CLIENT_ID: clientId }), /own client/);
  assert.throws(() => readSettings({ ...env, GAME_ROOM_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => readSettings({ ...env, GAME_ROOM_AUTH_MODE: 'mock' }), /Cognito/);
});
test('production runtime initializes once, restores profile and rejects wrong key at startup', async t => {
  const dir = directory(t), env = { ...base(), GAME_ROOM_STORE_PATH: path.join(dir, 'game.sqlite'), GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') };
  const userKey = identityKey('urn:synthetic-production-runtime', 'member');
  const a = await prepareProduction(env); await a.storage.put('game-profiles', userKey, { userKey, nickname: '好友' }); await a.chat?.close(); await a.rooms.close(); a.storage.close();
  const b = await prepareProduction(env); assert.equal((await b.storage.get('game-profiles', userKey)).nickname, '好友'); assert.equal(b.liveStoreValidation.counts['game-profiles'], 1); await b.chat?.close(); await b.rooms.close(); b.storage.close();
  await assert.rejects(prepareProduction({ ...env, GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') }));
  assert.match(runtimeVersions().sqlite, /^3\./);
});
function request(port, pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: 'game.sumomoli.com', ...headers } }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); }); req.on('error', reject); req.end(); });
}
test('reverse proxy public health exposes no state, enforces host, and shutdown awaits durable close', async t => {
  const dir = directory(t), runtime = await prepareProduction({ ...base(), GAME_ROOM_STORE_PATH: path.join(dir, 'game.sqlite'), GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') });
  const original = runtime.rooms.close; let closed = false;
  runtime.rooms.close = async () => { await new Promise(resolve => setTimeout(resolve, 10)); await original(); closed = true; };
  const server = createUnifiedServer(runtime); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const health = await request(port, '/healthz'); assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.body), { ok: true });
    assert.equal((await request(port, '/healthz', { Host: 'evil.example' })).status, 403);
    assert.equal((await request(port, '/healthz', {}, 'POST')).status, 405);
    assert.equal((await request(port, '/healthz', {}, 'HEAD')).body, '');
    const login = await request(port, '/auth/login?returnTo=%2Froom.html%3Fcode%3D123456');
    assert.equal(login.status, 303); for(const flag of ['Secure','HttpOnly','SameSite=Lax','Path=/']) assert.ok(login.headers['set-cookie'][0].includes(flag)); assert.ok(!login.headers['set-cookie'][0].includes('Domain='));
  } finally { await server.shutdown(); }
  assert.equal(closed, true);
});

test('HTTP shutdown still closes durable rooms and storage after a chat cleanup failure', async t => {
  const dir = directory(t), runtime = await prepareProduction({ ...base(), GAME_ROOM_STORE_PATH: path.join(dir, 'game.sqlite'), GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') });
  const closeChat = runtime.chat.close, closeRooms = runtime.rooms.close, closeStorage = runtime.storage.close.bind(runtime.storage);
  const order = [], failure = new Error('Synthetic chat close failure');
  runtime.chat.close = async () => { await closeChat(); order.push('chat'); throw failure; };
  runtime.rooms.close = async () => { await closeRooms(); order.push('rooms'); };
  runtime.storage.close = () => { closeStorage(); order.push('storage'); };
  const server = createUnifiedServer(runtime);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await assert.rejects(server.shutdown(), error => error === failure);
  assert.deepEqual(order, ['chat', 'rooms', 'storage']);
});
