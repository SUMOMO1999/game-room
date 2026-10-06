import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { entryBase, gamePath, entryStorageKey } from './entry-path.mjs';
import { normalizeRecentRoom } from './lobby-model.mjs';

const DIRECT = 'https://game.sumomoli.com/entry-path.mjs';
const MOUNTED = 'https://agora.sumomoli.com/game/entry-path.mjs';
const USER = 'a'.repeat(64), OTHER = 'b'.repeat(64), CODE = '123456';
const AUTH = { mode:'mock', loginReady:true, authenticated:true, userKey:USER, csrf:'synthetic-entry-csrf',
  reauthReady:true, reauthHref:'https://agora.sumomoli.com/#account', profile:{nickname:'朋友'}, recentRooms:[] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers:{'Content-Type':'application/json'} });

test('entry selection only accepts the loaded root/game module directory, independent of invitation query input', () => {
  assert.equal(entryBase(DIRECT), '/');
  assert.equal(entryBase(MOUNTED + '?returnTo=https://untrusted.example/#other'), '/game/');
  assert.equal(entryBase('http://127.0.0.1:4231/game/entry-path.mjs'), '/game/');
  assert.equal(entryBase(new URL('./entry-path.mjs', import.meta.url)), '/');
  for (const url of ['https://agora.sumomoli.com/calendar/entry-path.mjs',
    'https://agora.sumomoli.com/game/nested/entry-path.mjs', 'https://agora.sumomoli.com/%67ame/entry-path.mjs',
    'https://user:password@agora.sumomoli.com/game/entry-path.mjs', 'data:text/javascript,void(0)',
    'javascript:alert(1)', 'not a URL']) assert.throws(() => entryBase(url), TypeError);
});

test('API/SSE and logical login return paths preserve their exact entry and reject path escapes before requesting', () => {
  const login = '/auth/login?returnTo=%2Froom.html%3Fcode%3D123456';
  assert.equal(gamePath(login, DIRECT), login);
  assert.equal(gamePath(login, MOUNTED), '/game' + login);
  assert.equal(gamePath('/api/rooms/123456/events?preview=1', MOUNTED), '/game/api/rooms/123456/events?preview=1');
  assert.equal(gamePath('/', MOUNTED), '/game/');
  for (const path of ['//untrusted.example/', 'https://untrusted.example/', '/game/../calendar/',
    '/../auth', '/./api/state', '/api//state', '/api/%2Fstate', '/api/%5cstate',
    '/api/%2estate', '/api/%252estate', '/api\\state', '/api/state\n', '/api/state\x00']) {
    assert.throws(() => gamePath(path, MOUNTED), TypeError, path);
  }
});

test('direct private keys retain exact old records while mounted drafts, rack placements and legacy seats are distinct', () => {
  for (const key of ['game-room.private-draft-owner.v1', `game-room.private-draft.${USER}.room.self`,
    'friends-game-room.practice.v1', 'friends-game-room.practice.joker.v2',
    'friends-game-room.draft.123456.self', 'friends-game-room.seat.123456',
    'friends-game-room.recent-seats.v1', 'game-room:army-practice:v1', 'game-room:army-practice:v3']) {
    assert.equal(entryStorageKey(key, DIRECT), key);
    assert.equal(entryStorageKey(key, MOUNTED), 'agora-game:' + key);
    assert.notEqual(entryStorageKey(key, DIRECT), entryStorageKey(key, MOUNTED));
  }
});

function storage(data = new Map()) {
  return { data, get length(){return data.size;}, key:index=>[...data.keys()][index],
    getItem:key=>data.get(key) ?? null, setItem:(key,value)=>data.set(key,String(value)), removeItem:key=>data.delete(key) };
}
async function loadModule(context, filename, extra = '') {
  const source = await readFile(new URL(filename, import.meta.url), 'utf8');
  const names = [...source.matchAll(/^export (?:async )?(?:function|class|const)\s+(\w+)/gm)].map(match=>match[1]);
  const code = source.replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
  return vm.runInContext(`(()=>{${code}\n${extra}\nreturn {${names.join(',')}};})()`, context, {filename});
}
async function browserFixture(moduleUrl, { legacy = false, sessionData = new Map(), localData = new Map() } = {}) {
  const requests = [], sessionStorage = storage(sessionData), localStorage = storage(localData);
  const context = vm.createContext({ URL, Response, AbortController, TextDecoder, structuredClone,
    setTimeout, clearTimeout, Date, sessionStorage, localStorage, normalizeRecentRoom,
    location:{hostname:'127.0.0.1', href:moduleUrl},
    fetch:async(path, options={})=>{
      requests.push({path,options});
      if (path.endsWith('/api/state')) return json(legacy ? { mode:'legacy', authenticated:false } : AUTH);
      if (path.includes('/events')) return new Response('event: closed\ndata: {"status":429,"error":"synthetic bounded close"}\n\n',
        {headers:{'Content-Type':'text/event-stream'}});
      if (path.endsWith('/auth/logout')) return json({ok:true});
      return json({ok:true,view:{revision:1,roomId:'same-business-room',selfId:'self'}});
    } });
  // Execute the real helper and components as browser modules, with only their
  // import linkage supplied by this isolated context; no production network.
  const helper = (await readFile(new URL('entry-path.mjs', import.meta.url), 'utf8'))
    .replaceAll('import.meta.url', JSON.stringify(moduleUrl)).replace(/^export /gm, '');
  Object.assign(context, vm.runInContext(`(()=>{${helper};return {entryBase,gamePath,entryStorageKey};})()`,context));
  const account = await loadModule(context, 'account-client.mjs'); Object.assign(context, account);
  await account.loadAccount();
  const rooms = await loadModule(context, 'room-client.mjs');
  return {account, rooms, requests, sessionStorage, localStorage};
}

test('real account/room clients route state, CSRF writes, preview/SSE and login to the mounted entry with no seat token URL', async () => {
  const f = await browserFixture(MOUNTED);
  assert.equal(f.requests[0].path, '/game/api/state');
  assert.equal(f.account.loginHref('/room.html?code=123456'), '/game/auth/login?returnTo=%2Froom.html%3Fcode%3D123456');
  assert.equal(f.account.reauthenticationHref(), '/#account');
  await f.rooms.api('/api/rooms/123456/preview', {method:'POST',token:'must-not-be-shared',body:{requestId:'synthetic'}});
  const write = f.requests.at(-1);
  assert.equal(write.path, '/game/api/rooms/123456/preview');
  assert.equal(write.options.credentials, 'same-origin');
  assert.equal(write.options.cache, 'no-store');
  assert.equal(write.options.headers['X-CSRF-Token'], AUTH.csrf);
  assert.equal(write.options.headers.Authorization, undefined);
  const client = new f.rooms.RoomClient(CODE, {playerId:'self'}, {onPreview:()=>{},onView:()=>{},onConnection:()=>{},onError:()=>{}});
  await assert.rejects(client.readStream(new AbortController()), error => error.status === 429);
  assert.equal(f.requests.at(-1).path, '/game/api/rooms/123456/events?preview=1');
  assert.equal(f.account.accountState().authenticated, true);
  client.stop();
});

test('real direct clients keep existing state/login/CSRF routes and direct central recovery URL', async () => {
  const f = await browserFixture(DIRECT);
  assert.equal(f.requests[0].path, '/api/state');
  assert.equal(f.account.loginHref('/army.html?code=123456'), '/auth/login?returnTo=%2Farmy.html%3Fcode%3D123456');
  assert.equal(f.account.reauthenticationHref(), AUTH.reauthHref);
  await f.rooms.api('/api/rooms/123456/actions', {method:'POST',body:{requestId:'synthetic'}});
  assert.equal(f.requests.at(-1).path, '/api/rooms/123456/actions');
});

test('mounted 503 preserves only its local owner/draft namespace; 401 removes only that owner without touching direct or other members', async () => {
  const draft = `game-room.private-draft.${USER}.same-business-room.self`;
  const other = `game-room.private-draft.${OTHER}.same-business-room.friend`;
  const data = new Map([[draft,'direct private rack'], ['agora-game:' + draft,'mounted private rack'],
    ['agora-game:' + other,'other member rack']]);
  const f = await browserFixture(MOUNTED, {sessionData:data});
  f.account.reportAuthFailure({status:503});
  assert.equal(data.get('agora-game:game-room.private-draft-owner.v1'), USER);
  assert.equal(data.get('agora-game:' + draft), 'mounted private rack');
  assert.equal(data.get('game-room.private-draft-owner.v1'), undefined);
  f.account.reportAuthFailure({status:401});
  assert.equal(data.has('agora-game:' + draft), false);
  assert.equal(data.get(draft), 'direct private rack');
  assert.equal(data.get('agora-game:' + other), 'other member rack');
});

test('mounted project logout uses only its own endpoint and removes its draft, preserving all direct records', async () => {
  const draft = `game-room.private-draft.${USER}.same-business-room.self`;
  const data = new Map([[draft,'direct private rack'], ['agora-game:' + draft,'mounted private rack']]);
  const f = await browserFixture(MOUNTED, {sessionData:data});
  await f.account.logoutAccount();
  assert.equal(f.requests.filter(request=>request.path.endsWith('/auth/logout')).length, 1);
  assert.equal(f.requests.at(-1).path, '/game/auth/logout');
  assert.equal(data.has('agora-game:' + draft), false);
  assert.equal(data.get(draft), 'direct private rack');
  assert.equal(f.account.accountState().authenticated, false);
});

test('legacy direct records remain readable; mounted legacy seats occupy a separate browser namespace', async () => {
  const sessions = new Map(), locals = new Map();
  const direct = await browserFixture(DIRECT, {legacy:true,sessionData:sessions,localData:locals});
  direct.rooms.rememberMembership({roomCode:CODE,playerId:'direct-seat',token:'direct-seat-token'}, '旧朋友');
  const mounted = await browserFixture(MOUNTED, {legacy:true,sessionData:sessions,localData:locals});
  assert.equal(mounted.rooms.loadMembership(CODE), null);
  mounted.rooms.rememberMembership({roomCode:CODE,playerId:'mounted-seat',token:'mounted-seat-token'}, '新入口');
  assert.equal(direct.rooms.loadMembership(CODE).playerId, 'direct-seat');
  assert.equal(mounted.rooms.loadMembership(CODE).playerId, 'mounted-seat');
  mounted.rooms.forgetMembership(CODE, 'mounted-seat');
  assert.equal(mounted.rooms.loadMembership(CODE), null);
  assert.equal(direct.rooms.loadMembership(CODE).playerId, 'direct-seat');
});
