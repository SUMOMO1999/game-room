import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomActionIntent } from './platform/room-action-intent.mjs';
import { RoomClient } from './room-client.mjs';
const scope = { owner: 'a'.repeat(64), roomId: 'b'.repeat(32), memberId: 'c'.repeat(32) };
const view = (revision, actionReceipts = []) => ({ roomId: scope.roomId, roomCode: '123456', selfId: scope.memberId,
  revision, actionReceipts, phase: 'playing', gameType: 'flying-chess' });
function storage() { const data = new Map(); return { getItem: key => data.get(key) || null,
  setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
const fixture = saved => createRoomActionIntent({ scope, storage: saved, key: 'test-intent', requestId: () => 'immutable-request' });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
function client(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage() });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; });
  const value = new RoomClient('123456', { playerId: scope.memberId, token: 'synthetic-local-token' },
    { onView: () => {}, onConnection: () => {}, onError: () => {} });
  t.after(() => value.stop()); value.receive(view(4)); return value;
}
test('a pending roll restores exact intent and ignores unrelated revisions, rooms and members', () => {
  const saved = storage(), first = fixture(saved), body = first.begin('roll', {}, view(4));
  const second = fixture(saved); assert.deepEqual(second.retry(), body);
  assert.equal(second.reconcile(view(9)), null);
  assert.equal(second.reconcile({ ...view(10, [{ requestId: body.requestId, status: 'committed' }]), selfId: 'other' }), null);
  assert.throws(() => second.begin('roll', {}, view(9)), error => error.code === 'ACTION_UNCONFIRMED');
  assert.deepEqual(second.pending(), body);
  assert.equal(second.reconcile(view(10, [{ requestId: body.requestId, status: 'committed' }])).status, 'committed');
  assert.equal(second.pending(), null); assert.equal(fixture(saved).pending(), null);
});
test('an owning rejection resolves without converting it into a fresh roll', () => {
  const intent = fixture(storage()), body = intent.begin('move', { rollId: 7, planeId: 'red-1' }, view(12));
  const receipt = { requestId: body.requestId, status: 'rejected', error: { status: 409, code: 'REVISION_CONFLICT', message: '不同步' } };
  assert.deepEqual(intent.reconcile(view(13, [receipt])), receipt); assert.equal(intent.pending(), null);
});
test('storage denial prevents sending, and another owner cannot restore a prior intent', () => {
  const saved = storage(), intent = fixture(saved); intent.begin('roll', {}, view(4));
  const changed = createRoomActionIntent({ scope: { ...scope, owner: 'd'.repeat(64) }, storage: saved, key: 'test-intent' });
  assert.equal(changed.pending(), null);
  const denied = fixture({ getItem: () => null, setItem: () => { throw new Error('storage denied'); }, removeItem: () => {} });
  assert.throws(() => denied.begin('roll', {}, view(4)), /storage denied/); assert.equal(denied.pending(), null);
});
test('unavailable or unreadable storage never creates a new request that could lose its recovery record', () => {
  for (const saved of [undefined, {}, { getItem: () => { throw new Error('read denied'); }, setItem: () => {}, removeItem: () => {} }]) {
    const intent = fixture(saved);
    assert.equal(intent.available(), false);
    assert.throws(() => intent.begin('roll', {}, view(4)), error => error.code === 'INTENT_STORAGE_UNAVAILABLE');
    assert.equal(intent.pending(), null);
  }
});
test('RoomClient denied storage getter still displays the board but never sends a business POST', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('browser storage disabled'); } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; });
  const seen = [], current = new RoomClient('123456', { playerId: scope.memberId },
    { onView: value => seen.push(value), onConnection: () => {}, onError: () => {} });
  t.after(() => current.stop()); let posts = 0;
  t.mock.method(globalThis, 'fetch', async () => { posts++; return response({ view: view(5) }); });
  current.receive(view(4)); assert.equal(seen.length, 1); assert.equal(current.actionStorageReady(), false);
  await assert.rejects(current.action('roll'), error => error.code === 'INTENT_STORAGE_UNAVAILABLE');
  assert.equal(posts, 0); assert.equal(current.pendingAction(), null);
});
test('RoomClient proves a lost response from the owning receipt without a second POST', async t => {
  const current = client(t); let body; const methods = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    methods.push(options.method);
    if (options.method === 'POST') { body = JSON.parse(options.body); throw new TypeError('lost response'); }
    return response({ view: view(5, [{ requestId: body.requestId, status: 'committed' }]) });
  });
  assert.equal((await current.action('roll')).revision, 5);
  assert.deepEqual(methods, ['POST', 'GET']); assert.equal(current.pendingAction(), null);
});
test('RoomClient blocks a new intent after an ambiguous response and explicitly retries the identical request', async t => {
  const current = client(t), bodies = []; let retry = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'POST') {
      bodies.push(JSON.parse(options.body));
      if (!retry) throw new TypeError('lost before commit');
      return response({ view: view(7, [{ requestId: bodies[0].requestId, status: 'committed' }]) });
    }
    return response({ view: view(6) }); // Another player's presence changed this revision.
  });
  await assert.rejects(current.action('roll'), /尚未确认/);
  await assert.rejects(current.action('roll'), error => error.code === 'ACTION_UNCONFIRMED');
  assert.equal(bodies.length, 1); assert.equal(current.pendingAction().expectedRevision, 4);
  retry = true; await current.retryAction(); assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(current.pendingAction(), null);
});
test('RoomClient restored pending intent never replays it automatically and accepts explicit leave', async t => {
  const first = client(t); let body;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'POST') { body = JSON.parse(options.body); throw new TypeError('lost'); }
    return response({ view: view(5) });
  });
  await assert.rejects(first.action('roll')); first.stop();
  const next = new RoomClient('123456', first.membership, { onView: () => {}, onConnection: () => {}, onError: () => {} });
  t.after(() => next.stop()); next.receive(view(6)); assert.deepEqual(next.pendingAction(), body);
  next.receive(view(7, [{ requestId: body.requestId, status: 'rejected', error: { status: 409, code: 'REVISION_CONFLICT', message: '已更新' } }]));
  assert.equal(next.pendingAction(), null);
  t.mock.method(globalThis, 'fetch', async () => response({ left: true, view: null }));
  assert.equal(await next.action('leave'), null); assert.equal(next.pendingAction(), null);
});
