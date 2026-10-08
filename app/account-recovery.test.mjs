import test from 'node:test';
import assert from 'node:assert/strict';

const USER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const OWNER = 'game-room.private-draft-owner.v1';
const draftKey = (user = USER) => `game-room.private-draft.${user}.room-id.self`;
const AUTH = { mode: 'mock', loginReady: true, authenticated: true, userKey: USER,
  csrf: 'synthetic-current-csrf', profile: { nickname: '朋友' },
  recentRooms: [{ roomCode: '123456', playerId: 'self' }] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json' } });
let sequence = 0;
async function fixture(t, initial = []) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const data = new Map(initial);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return data.size; }, key: index => [...data.keys()][index],
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete globalThis.sessionStorage);
  const account = await import(`./account-client.mjs?recovery-${++sequence}`);
  const authenticate = async (extra = {}) => {
    t.mock.method(globalThis, 'fetch', async () => json({ ...AUTH, ...extra }));
    return account.loadAccount();
  };
  return { account, data, authenticate };
}

test('game availability requires explicit server booleans and is withdrawn during identity recovery', async t => {
  const { account, authenticate } = await fixture(t);
  assert.equal(account.accountState().poker414Enabled, false);
  await authenticate({ poker414Enabled: 'true', drawingEnabled: true });
  assert.equal(account.accountState().poker414Enabled, false);
  assert.equal(account.accountState().drawingEnabled, true);
  await authenticate({ poker414Enabled: true });
  assert.equal(account.accountState().poker414Enabled, true);
  account.reportAuthFailure({ status: 503 });
  assert.equal(account.accountState().poker414Enabled, false);
  await authenticate();
  assert.equal(account.accountState().poker414Enabled, false);
});

test('each game room can return from login without allowing arbitrary paths or extra role fields', async t => {
  const { account } = await fixture(t);
  for (const name of ['room', 'army', 'flying', 'drawing', 'poker414']) {
    const path = `/${name}.html?code=123456`;
    assert.equal(new URL(account.loginHref(path), 'http://localhost').searchParams.get('returnTo'), path);
    assert.equal(new URL(account.loginHref(path + '&role=host'), 'http://localhost').searchParams.get('returnTo'), '/');
  }
});

test('503 hides all private account state and fences old replies while preserving only the local draft namespace', async t => {
  const { account, data, authenticate } = await fixture(t);
  await authenticate();
  data.set(draftKey(), JSON.stringify({ revision: 7, rackIds: ['red-7-a'], boardIds: [] }));
  data.set(draftKey(OTHER), 'unrelated draft');
  const before = account.accountGeneration();
  account.reportAuthFailure({ status: 503 });
  const paused = account.accountState();
  assert.ok(account.accountGeneration() > before);
  assert.equal(paused.failureStatus, 503);
  assert.equal(paused.authenticated, false);
  assert.equal(paused.userKey, null);
  assert.equal(paused.csrf, null);
  assert.equal(paused.profile, null);
  assert.deepEqual(paused.recentRooms, []);
  assert.equal(data.get(OWNER), USER);
  assert.ok(data.has(draftKey()));
  assert.ok(![...data.values()].some(value => value.includes(AUTH.csrf)));
  // A newly checked session for the same identity can resume its draft even if CSRF rotated.
  await authenticate({ csrf: 'newly-verified-csrf' });
  assert.equal(account.accountState().authenticated, true);
  assert.ok(data.has(draftKey()));
  assert.ok(data.has(draftKey(OTHER)));
  assert.equal(data.has(OWNER), false);
});

test('401 after temporary failure removes the retained draft without deleting another identity or practice', async t => {
  const { account, data, authenticate } = await fixture(t);
  await authenticate();
  data.set(draftKey(), 'private IDs'); data.set(draftKey(OTHER), 'other private IDs');
  data.set('friends-game-room.practice.v1', 'practice');
  account.reportAuthFailure({ status: 503 });
  account.reportAuthFailure({ status: 401 });
  assert.equal(data.has(draftKey()), false);
  assert.equal(data.has(OWNER), false);
  assert.ok(data.has(draftKey(OTHER)));
  assert.ok(data.has('friends-game-room.practice.v1'));
  assert.equal(account.accountState().failureStatus, 401);
});

test('a verified different identity clears the old suspended namespace and does not inherit its draft', async t => {
  const { account, data, authenticate } = await fixture(t);
  await authenticate(); data.set(draftKey(), 'old private IDs');
  data.set(draftKey(OTHER), 'other private IDs');
  account.reportAuthFailure({ status: 503 });
  await authenticate({ userKey: OTHER, csrf: 'other-current-csrf' });
  assert.equal(account.accountState().userKey, OTHER);
  assert.equal(data.has(draftKey()), false);
  assert.equal(data.has(OWNER), false);
  assert.ok(data.has(draftKey(OTHER)));
});

test('project logout during 503 discards the suspended draft before the request even when logout fails', async t => {
  const { account, data, authenticate } = await fixture(t);
  await authenticate(); data.set(draftKey(), 'private IDs');
  account.reportAuthFailure({ status: 503 });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/auth/logout');
    assert.equal(data.has(draftKey()), false);
    assert.equal(data.has(OWNER), false);
    assert.equal(options.credentials, 'same-origin');
    assert.ok(!('Authorization' in options.headers));
    assert.ok(!('X-CSRF-Token' in options.headers));
    throw new TypeError('synthetic network unavailable');
  });
  await assert.rejects(account.logoutAccount(), error => error.status === 503);
  assert.equal(account.accountState().authenticated, false);
  assert.equal(data.has(draftKey()), false);
  assert.equal(data.has(OWNER), false);
});

test('reload cannot authenticate from a draft marker but can preserve it until the same identity is checked online', async t => {
  const { account, data, authenticate } = await fixture(t, [[OWNER, USER], [draftKey(), 'private IDs']]);
  const initial = account.accountState();
  assert.equal(initial.authenticated, false);
  assert.equal(initial.userKey, null);
  assert.equal(initial.csrf, null);
  t.mock.method(globalThis, 'fetch', async () => json({ error: 'synthetic identity unavailable' }, 503));
  await assert.rejects(account.loadAccount(), error => error.status === 503);
  assert.ok(data.has(draftKey()));
  await authenticate();
  assert.equal(account.accountState().authenticated, true);
  assert.ok(data.has(draftKey()));
  assert.equal(data.has(OWNER), false);
});

test('a fresh anonymous response after reload clears a retained draft and never interprets it as a seat', async t => {
  const { account, data } = await fixture(t, [[OWNER, USER], [draftKey(), 'private IDs']]);
  t.mock.method(globalThis, 'fetch', async () => json({ mode: 'mock', loginReady: true, authenticated: false }));
  await account.loadAccount();
  assert.equal(account.accountState().authenticated, false);
  assert.deepEqual(account.accountState().recentRooms, []);
  assert.equal(data.has(draftKey()), false);
  assert.equal(data.has(OWNER), false);
});

test('a regular pageshow after cookie login supersedes an older anonymous initial check without another login click', async t => {
  const { account } = await fixture(t); const windowRef = new EventTarget(); const documentRef = new EventTarget(); documentRef.hidden = false;
  let serverAuthenticated = false, resolveInitial, reads = 0;
  const initial = new Promise(resolve => { resolveInitial = resolve; });
  const checking = new Promise(resolve => { t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); reads += 1;
    if (reads === 1) { resolve(); return initial; }
    return json(serverAuthenticated ? AUTH : { mode: 'mock', loginReady: true, authenticated: false });
  }); });
  const watcher = account.watchAccountLifecycle({ windowRef, documentRef }); t.after(() => watcher.stop());
  const loading = watcher.refresh(); await checking;
  // Simulate the OAuth callback installing its own-domain cookie while the old lobby response is still pending.
  serverAuthenticated = true;
  const pageshow = new Event('pageshow'); Object.defineProperty(pageshow, 'persisted', { value: false }); windowRef.dispatchEvent(pageshow);
  resolveInitial(json({ mode: 'mock', loginReady: true, authenticated: false })); await loading;
  assert.equal(reads, 2); assert.equal(account.accountState().authenticated, true); assert.equal(account.accountState().userKey, USER);
});

test('restored or focused lobby checks the current cookie and clears account state on a verified logout', async t => {
  const { account, authenticate } = await fixture(t); await authenticate();
  const windowRef = new EventTarget(); const documentRef = new EventTarget(); documentRef.hidden = false;
  let serverAuthenticated = true, reads = 0, observed;
  t.mock.method(globalThis, 'fetch', async () => { reads += 1; return json(serverAuthenticated ? AUTH : { mode: 'mock', loginReady: true, authenticated: false }); });
  const watcher = account.watchAccountLifecycle({ windowRef, documentRef }); t.after(() => watcher.stop());
  const returned = new Promise(resolve => { observed = account.onAccountChange(state => { if (!state.authenticated) resolve(); }); });
  serverAuthenticated = false; const restored = new Event('pageshow'); Object.defineProperty(restored, 'persisted', { value: true }); windowRef.dispatchEvent(restored);
  await returned; observed();
  assert.equal(account.accountState().profile, null); assert.equal(account.accountState().csrf, null); assert.deepEqual(account.accountState().recentRooms, []);
  serverAuthenticated = true;
  const focused = new Promise(resolve => { observed = account.onAccountChange(state => { if (state.authenticated) resolve(); }); }); windowRef.dispatchEvent(new Event('focus')); await focused; observed();
  assert.equal(account.accountState().userKey, USER);
  const count = reads; documentRef.hidden = true; documentRef.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); assert.equal(reads, count);
  watcher.stop(); documentRef.hidden = false; windowRef.dispatchEvent(new Event('focus')); await Promise.resolve(); assert.equal(reads, count);
});

test('lifecycle refresh during project logout cannot reauthenticate the cookie still awaiting server deletion', async t => {
  const { account, authenticate } = await fixture(t); await authenticate();
  const windowRef = new EventTarget(); const documentRef = new EventTarget(); documentRef.hidden = false;
  let finishLogout, reads = 0;
  const logoutResponse = new Promise(resolve => { finishLogout = resolve; });
  t.mock.method(globalThis, 'fetch', async url => { if (url === '/auth/logout') return logoutResponse; reads += 1; return json(AUTH); });
  const watcher = account.watchAccountLifecycle({ windowRef, documentRef }); t.after(() => watcher.stop());
  const loggingOut = account.logoutAccount(); windowRef.dispatchEvent(new Event('pageshow')); windowRef.dispatchEvent(new Event('focus')); await watcher.refresh();
  assert.equal(reads, 0); assert.equal(account.accountState().authenticated, false); assert.equal(account.accountState().csrf, null);
  finishLogout(json({ ok: true })); await loggingOut; assert.equal(account.accountState().authenticated, false);
});
