import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { readSettings, readStoreKey, isSystemdStoreCredential } from '../server/config.mjs';
import { prepareProduction, runtimeVersions, closeRuntime } from '../server/production.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { identityKey, EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createGameRegistry, defaultGameRegistry } from './game-registry.mjs';
import { createGameScores, SCORE_SCOPES } from '../server/game-scores.mjs';

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
test('first drawing boot awaits wordbank and canvas initialization before accepting the persistent store',async t=>{
  const dir=directory(t),env={...base(),GAME_ROOM_DRAWING_ENABLED:'1',GAME_ROOM_STORE_PATH:path.join(dir,'drawing.sqlite'),GAME_ROOM_STORE_KEY:randomBytes(32).toString('base64url')};
  const a=await prepareProduction(env);
  try {assert.equal(a.liveStoreValidation.counts['wordbank-releases'],1);assert.equal(a.liveStoreValidation.counts['draw-canvases'],1);
    assert.equal((await a.wordbanks.getRelease({userKey:'a'.repeat(64),member:true},'dg-base',1)).words.length,560);
  }finally{a.preview?.close();await a.canvases.close();await a.chat.close();await a.rooms.close();a.storage.close();}
});

async function interrupted414(t) {
  const dir = directory(t), key = randomBytes(32), storePath = path.join(dir, 'interrupted.sqlite');
  const env = { ...base(), GAME_ROOM_STORE_PATH: storePath, GAME_ROOM_STORE_KEY: key.toString('base64url') };
  const users = [0, 1, 2].map(index => identityKey('urn:production-414-recovery', String(index)));
  const storage = new EncryptedStore(new SQLiteAdapter(storePath), key);
  const gameRegistry = createGameRegistry(['poker414-2'].map(defaultGameRegistry.gameAdapter));
  const rooms = createDurableRoomStore({ storage, gameRegistry, pollIntervalMs: 0 });
  let sequence = 0;
  async function action(code, user, type, extra = {}) {
    const view = await rooms.getView(code, user);
    return rooms.action(code, user, { type, requestId: `production-${++sequence}`, expectedRevision: view.revision, ...extra });
  }
  async function start() {
    const host = await rooms.createRoom(users[0], '启动甲', `create-${++sequence}`, 'poker414-2');
    for (const user of users.slice(1)) await rooms.joinRoom(host.roomCode, user, '启动伙伴', `join-${++sequence}`);
    for (const user of users) await action(host.roomCode, user, 'ready', { ready: true });
    await action(host.roomCode, users[0], 'start'); return host;
  }
  try {
    const completed = await start(); await action(completed.roomCode, users[0], 'leave');
    const active = await start(), before = (await storage.read('rooms', active.view.roomId)).value.snapshot;
    return { env, users, key, storePath, active, before };
  } finally { await rooms.close(); storage.close(); }
}

test('production preflight completes interrupted 414 cancellation before reporting ready and preserves prior points', async t => {
  const fixture = await interrupted414(t), runtime = await prepareProduction(fixture.env);
  try {
    // Deliberately inspect raw persisted state first: calling rooms.getView here
    // would itself await ready and conceal a premature production return.
    const snapshot = (await runtime.storage.read('rooms', fixture.active.view.roomId)).value.snapshot;
    assert.equal(snapshot.phase, 'waiting'); assert.equal(snapshot.lastMatchResult.reason, 'server-recovery');
    assert.equal(snapshot.lastMatchResult.matchId, fixture.before.matchId);
    assert.deepEqual(snapshot.players.map(player => player.id), fixture.before.players.map(player => player.id));
    const scores = createGameScores({ storage: runtime.storage });
    assert.deepEqual((await Promise.all(fixture.users.map(user => scores.readBalance(user)))).map(value => value.total), [-10, 5, 5]);
    const ledger = await runtime.storage.scan(SCORE_SCOPES.ledger);
    assert.equal(ledger.length, 2);
    assert.deepEqual(ledger.find(row => row.value.reason === 'server-recovery').value.deltas.map(row => row.delta), [0, 0, 0]);
  } finally { await closeRuntime(runtime); }
});

test('production preflight rejects failed 414 recovery without reporting ready or changing committed points', async t => {
  const fixture = await interrupted414(t), original = SQLiteAdapter.prototype.compareAndSwapMany;
  const failure = new Error('Synthetic startup transaction unavailable'); let writes = 0;
  SQLiteAdapter.prototype.compareAndSwapMany = async function () { writes++; throw failure; };
  try { await assert.rejects(prepareProduction(fixture.env), error => error === failure); }
  finally { SQLiteAdapter.prototype.compareAndSwapMany = original; }
  assert.ok(writes > 0);
  const storage = new EncryptedStore(new SQLiteAdapter(fixture.storePath), fixture.key);
  try {
    assert.deepEqual((await storage.read('rooms', fixture.active.view.roomId)).value.snapshot, fixture.before);
    assert.equal((await storage.scan(SCORE_SCOPES.ledger)).length, 1);
    const scores = createGameScores({ storage });
    assert.deepEqual((await Promise.all(fixture.users.map(user => scores.readBalance(user)))).map(value => value.total), [-10, 5, 5]);
  } finally { storage.close(); }
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
