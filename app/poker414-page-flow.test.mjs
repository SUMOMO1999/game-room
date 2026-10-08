import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createPoker414RoomController } from './games/poker414-2/room-controller.mjs';
import { createRoomActionIntent } from './platform/room-action-intent.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let n = 0; n < 6; n++) await new Promise(resolve => setImmediate(resolve)); };
const error = (status, message = '受控失败') => Object.assign(new Error(message), { status });
const card = 'p414-2-hearts-3-0';
function room({ matchId = 'match-one', selfId = 'self', revision = 1, phase = 'playing', roundId = 3, targetId = 'target-one', windowId = 'window-one' } = {}) {
  const players = ['self', 'friend', 'third'].map(id => ({ id, name: id, ready: true, connected: true }));
  return { gameType: 'poker414-2', roomCode: '123456', roomId: 'room-one', matchId, selfId, selfRole: 'player',
    hostId: 'self', phase, revision, players, spectators: [], actionReceipts: [],
    game: { matchId, roundId, eventSeq: revision, stage: 'playing', turnPlayerId: selfId,
      actionOrder: ['self', 'third', 'friend'], players: players.map(player => ({ id: player.id, handCount: 1, ...(player.id === selfId ? { hand: [card] } : {}) })),
      target: targetId ? { id: targetId, ownerId: 'friend', cardIds: [card], pattern: { kind: 'single', rank: 3, count: 1 } } : null,
      responseWindow: windowId ? { id: windowId, rank: 3, action: 'fork', deadlineAt: 9999999999999 } : null,
      moves: [], notices: [] } };
}
function scores(view, total = 0) {
  return { accountGroup: '4a4', roomId: view.roomId, roomRevision: view.revision, matchId: view.matchId ?? view.lastMatchResult?.matchId ?? null,
    readAt: 100, players: view.players.map(player => ({ playerId: player.id, total })), settlement: null };
}
const clientSource = (await readFile(new URL('./room-client.mjs', import.meta.url), 'utf8')).split('export class RoomClient')[1];
const lifecycleSource = (await readFile(new URL('./account-client.mjs', import.meta.url), 'utf8'))
  .split('export function watchAccountLifecycle')[1].split('\nlet channel = null;')[0];

// The real controller, RoomClient request/action/intent fences, and account lifecycle
// execute here. HTTP, SSE delivery and UI rendering are controlled boundaries;
// these tests do not establish browser geometry, real Agora auth or phone gestures.
async function fixture(t, options = {}) {
  const document = new EventTarget(); document.hidden = false;
  const window = new EventTarget(), calls = [], clients = [], listeners = new Set(), stored = new Map(), timers = new Map();
  const navigation = []; window.location = { href: 'https://example.test/game/poker414.html?code=123456', search: '?code=123456', replace: value => navigation.push(value) };
  let epoch = 1, timerId = 0, serverView = options.view || room(), actionHandler = async () => ({ view: serverView }),
    readHandler = null, scoreHandler = null, logoutHandler = async () => {}, accountReads = 0;
  const stats = { logout: 0, forgotten: [], views: [], gates: [], feedback: [], leaveFailures: [], chats: [], cues: [], destroyed: 0 };
  const context = vm.createContext({ structuredClone, AbortController, DOMException, console, crypto: { randomUUID },
    setTimeout, clearTimeout, Number, Date, Map, Set, Promise,
    normalizeCode: value => String(value), entryStorageKey: value => value,
    superseded: () => new DOMException('superseded', 'AbortError'), createRoomActionIntent,
    state: { mode: 'mock', authenticated: true, userKey: 'a'.repeat(64) }, verification: 'verified', loadSequence: 0,
    retainedDraftOwner: null, retainDraftOwner() {}, ACCOUNT_CHECK_INTERVAL_MS: 15000,
    sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
  });
  const accountState = () => ({ ...context.state, verification: context.verification });
  const accountGeneration = () => epoch;
  const onAccountChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  function changeAccount(next, { increment = true } = {}) {
    if (increment) epoch++;
    context.state = { ...context.state, ...next }; context.verification = next.verification ?? 'verified';
    for (const fn of [...listeners]) fn(accountState());
  }
  const loadAccount = async () => { accountReads++; context.verification = 'verified'; return accountState(); };
  Object.assign(context, { accountState, accountGeneration, onAccountChange, loadAccount,
    reportAuthFailure: failure => changeAccount({ authenticated: false, failureStatus: failure.status, verification: 'anonymous' }),
    api: async (path, args = {}) => {
      calls.push({ path, ...structuredClone({ method: args.method || 'GET', body: args.body }) });
      if (path.endsWith('/scores')) return scoreHandler ? scoreHandler(path, args) : scores(serverView);
      if (path.endsWith('/actions')) return actionHandler(args.body, args);
      return readHandler ? readHandler(path, args) : { view: serverView };
    },
  });
  const RealClient = vm.runInContext(`(class RoomClient${clientSource})`, context, { filename: 'actual-room-client-class.mjs' });
  class Client extends RealClient {
    constructor(...args) { super(...args); clients.push(this); this.connects = 0; }
    connect() { if (!this.stopped) { this.connects++; this.onConnection('online'); } }
  }
  const actualLifecycle = vm.runInContext(`(function watchAccountLifecycle${lifecycleSource})`, context, { filename: 'actual-account-lifecycle.mjs' });
  const watchAccountLifecycle = opts => actualLifecycle({ ...opts, timers: {
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
  } });
  const ui = { audio: { play: kind => stats.cues.push(kind) }, applyView: value => stats.views.push(value),
    conceal: value => stats.gates.push(value), feedback: value => stats.feedback.push(value), leaveFailure: value => stats.leaveFailures.push(value),
    destroy: () => { stats.destroyed++; } };
  const chat = { clear: value => stats.chats.push({ clear: value }), attach: (...args) => stats.chats.push({ attach: args }),
    receive: packet => stats.chats.push({ packet }), connection: value => stats.chats.push({ connection: value }) };
  const dependencies = { roomCode: '123456', document, window, ui, chat, RoomClient: Client, api: context.api,
    accountState, accountGeneration, onAccountChange, loadAccount, watchAccountLifecycle,
    loginHref: value => `/auth/login?returnTo=${encodeURIComponent(value)}`, reauthenticationHref: () => '/#account',
    logoutAccount: async () => { stats.logout++; return logoutHandler(); }, forgetMembership: (...args) => stats.forgotten.push(args),
    roomHref: (code, game) => `./${game}.html?code=${code}`, agoraHref: '/#projects' };
  let controller;
  if (options.entry) {
    const source = (await readFile(new URL('./games/poker414-2/game-page.mjs', import.meta.url), 'utf8')).replace(/^import[\s\S]*?;\s*/gm, '');
    document.querySelector = () => ({ syntheticRoot: true });
    const entryContext = vm.createContext({ ...dependencies, location: window.location, navigator: {}, URLSearchParams,
      entryBase: () => '/game/', mountPoker414Page: value => { stats.uiBindings = value; return ui; }, mountRoomChat: value => { stats.chatBindings = value; return chat; },
      createPoker414RoomController: value => { controller = createPoker414RoomController(value); return controller; },
    });
    vm.runInContext(source, entryContext, { filename: 'actual-poker414-game-page.mjs' });
  } else { controller = createPoker414RoomController(dependencies); void controller.start(); }
  t.after(() => controller.destroy());
  await settle();
  return { controller, document, window, clients, calls, stats, navigation, stored, timers,
    get accountReads() { return accountReads; },
    setView(value, { emit = true } = {}) { serverView = value; if (emit) clients.at(-1)?.receive(value); },
    setAction(fn) { actionHandler = fn; }, setRead(fn) { readHandler = fn; }, setScores(fn) { scoreHandler = fn; }, setLogout(fn) { logoutHandler = fn; },
    changeAccount, context };
}

test('business actions freeze match, round, target, window and selected cards before an overlapping view arrives', async t => {
  for (const type of ['play', 'pass', 'hook', 'fork']) {
    const f = await fixture(t), pending = deferred(), ids = [card];
    f.setAction(() => pending.promise);
    const action = f.controller.act(type, { cardIds: ids, matchId: 'forged', targetId: 'forged', windowId: 'forged' });
    const original = f.calls.find(call => call.method === 'POST').body;
    ids.push('p414-2-hearts-4-0');
    f.setView(room({ matchId: 'match-two', revision: 2, roundId: 10, targetId: 'target-two', windowId: 'window-two' }));
    pending.resolve({ view: f.clients[0].view }); await action;
    assert.equal(original.matchId, 'match-one'); assert.equal(original.roundId, 3); assert.equal(original.targetId, 'target-one');
    assert.equal(original.expectedRevision, 1);
    if (type === 'play') assert.deepEqual(original.cardIds, [card]); else assert.equal(original.cardIds, undefined);
    if (['hook', 'fork'].includes(type)) assert.equal(original.windowId, 'window-one'); else assert.equal(original.windowId, undefined);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('visible focus performs the existing fresh account check without rebuilding the client or hiding the table', async t => {
  const f = await fixture(t), current = f.clients[0], before = f.stats.views.length, gates = f.stats.gates.length, reads = f.accountReads;
  f.window.dispatchEvent(new Event('focus')); await settle();
  assert.equal(f.accountReads, reads + 1); assert.equal(f.clients.length, 1); assert.equal(current.stopped, false);
  assert.equal(current.connects, 1); assert.equal(f.stats.gates.length, gates); assert.equal(f.stats.views.length, before);
});

test('hidden page drops late private views, chat and balances; foreground restores the same seat with a new client', async t => {
  const f = await fixture(t), old = f.clients[0], pending = deferred(); f.setScores(() => pending.promise);
  const refresh = f.controller.refresh(); await settle();
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  const rendered = f.stats.views.length, chatted = f.stats.chats.length;
  old.onView(room({ revision: 9 })); old.onChat({ text: 'late private message' }); old.onConnection('online');
  pending.resolve(scores(room(), 99)); await refresh;
  assert.equal(old.stopped, true); assert.equal(f.stats.views.length, rendered); assert.equal(f.stats.chats.length, chatted);
  f.setScores(null); f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(f.clients.length, 2); assert.equal(f.clients[1].membership.playerId, 'self');
  assert.equal(f.stats.views.at(-1).players.find(player => player.id === 'self').total, 0);
});

test('an account replacement rejects late bootstrap and old client callbacks without overwriting the next seat', async t => {
  const f = await fixture(t), old = f.clients[0], first = deferred();
  f.setRead(() => first.promise); const recovery = f.controller.recover(); await settle();
  f.changeAccount({ userKey: 'b'.repeat(64) });
  f.setView(room({ selfId: 'friend', revision: 4 }), { emit: false }); f.setRead(null);
  const next = f.controller.recover(); first.resolve({ view: room() }); await Promise.all([recovery, next]); await settle();
  assert.equal(f.clients.at(-1).membership.playerId, 'friend'); const rendered = f.stats.views.length;
  old.onView(room({ revision: 99 })); old.onChat({ private: 'stale' }); old.onError(error(401));
  assert.equal(f.stats.views.length, rendered); assert.equal(f.clients.at(-1).stopped, false);
});

test('an unknown write is reconciled by reads and only an explicit retry resends its exact saved intent', async t => {
  const f = await fixture(t); f.setAction(() => { throw new Error('lost response'); });
  await assert.rejects(f.controller.act('play', { cardIds: [card] }), /尚未确认/);
  const original = f.calls.find(call => call.method === 'POST').body;
  assert.ok(f.clients[0].pendingAction()); assert.ok(f.stats.views.at(-1).pending);
  await f.controller.refresh(); f.window.dispatchEvent(new Event('focus')); await settle();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1, 'GET/focus must never replay a business action');
  await assert.rejects(f.controller.act('pass'), /上一操作尚未确认/);
  f.setAction(body => ({ view: { ...room({ revision: 2 }), actionReceipts: [{ requestId: body.requestId, status: 'committed' }] } }));
  await f.controller.retry();
  const writes = f.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 2); assert.deepEqual(writes[1].body, original); assert.equal(f.clients[0].pendingAction(), null);
});

test('room exit needs an explicit left acknowledgement before navigation, membership removal or logout', async t => {
  for (const destination of ['lobby', 'logout', 'agora']) {
    const f = await fixture(t), pending = deferred(); f.setAction(() => pending.promise);
    const leaving = f.controller.leave({ destination }); await settle();
    assert.equal(f.navigation.length, 0); assert.equal(f.stats.logout, 0); assert.equal(f.stats.forgotten.length, 0);
    pending.resolve({}); assert.equal(await leaving, false);
    assert.equal(f.navigation.length, 0); assert.equal(f.stats.logout, 0); assert.equal(f.stats.forgotten.length, 0);
    const original = f.calls.find(call => call.method === 'POST').body;
    f.setAction(() => ({ left: true })); assert.equal(await f.controller.leave({ destination }), true);
    const writes = f.calls.filter(call => call.method === 'POST'); assert.deepEqual(writes[1].body, original);
    assert.deepEqual(f.stats.forgotten, [['123456', 'self']]); assert.equal(f.stats.logout, destination === 'logout' ? 1 : 0);
    assert.deepEqual(f.navigation, [destination === 'agora' ? '/#projects' : './']);
  }
});

test('a stale exit acknowledgement after an account switch cannot sign out or navigate the new account', async t => {
  const f = await fixture(t), pending = deferred(); f.setAction(() => pending.promise);
  const leaving = f.controller.leave({ destination: 'logout' });
  f.changeAccount({ userKey: 'b'.repeat(64) }); pending.resolve({ left: true });
  assert.equal(await leaving, false); assert.equal(f.stats.logout, 0); assert.deepEqual(f.navigation, []); assert.deepEqual(f.stats.forgotten, []);
});

test('late previous-match scores cannot overwrite current-match totals or terminal balances', async t => {
  const f = await fixture(t), older = deferred(), newer = deferred(); let reads = 0;
  f.setScores(() => (++reads === 1 ? older : newer).promise);
  const refresh = f.controller.refresh(); await settle();
  const next = room({ matchId: 'match-two', revision: 2 }); f.setView(next);
  newer.resolve(scores(next, 42)); await settle(); assert.equal(f.stats.views.at(-1).players[0].total, 42);
  older.resolve(scores(room(), -99)); await refresh; await settle();
  assert.equal(f.stats.views.at(-1).matchId, 'match-two'); assert.equal(f.stats.views.at(-1).players[0].total, 42);
});

test('identity errors conceal private state with invitation recovery, while destroyed pages ignore every callback', async t => {
  for (const status of [401, 403, 404, 503]) {
    const f = await fixture(t), old = f.clients[0]; old.onError(error(status));
    assert.equal(old.stopped, true);
    const gate = f.stats.gates.at(-1); assert.equal(typeof gate.message, 'string');
    if (status === 401) assert.match(decodeURIComponent(gate.loginHref), /returnTo=\/\?room=123456/);
    assert.equal(gate.preserveSelection, status === 503);
    f.controller.destroy(); const views = f.stats.views.length, gates = f.stats.gates.length;
    old.onView(room({ revision: 88 })); old.onError(error(503)); f.window.dispatchEvent(new Event('focus'));
    await settle(); assert.equal(f.stats.views.length, views); assert.equal(f.stats.gates.length, gates); assert.equal(f.stats.destroyed, 1);
  }
});

test('actual game-page entry wires actions, scores, chat and mounted Agora exit to the room controller', async t => {
  const f = await fixture(t, { entry: true });
  assert.equal(f.clients.length, 1); assert.equal(f.stats.chats.filter(item => item.attach).length, 1);
  f.stats.chatBindings.onCue('chat'); assert.equal(f.stats.cues.at(-1), 'chat');
  await f.stats.uiBindings.onAction('ready', { ready: false });
  assert.equal(f.calls.find(call => call.method === 'POST').body.type, 'ready');
  f.setAction(() => ({ left: true })); await f.stats.uiBindings.onLeave({ destination: 'agora' });
  assert.deepEqual(f.navigation, ['/#projects']);
});

test('shared host transfer action is accepted by the actual persisted action intent path', async t => {
  const f = await fixture(t); await f.controller.act('transferHost', { playerId: 'friend' });
  const write = f.calls.find(call => call.method === 'POST');
  assert.equal(write.body.type, 'transferHost'); assert.equal(write.body.playerId, 'friend');
});

test('an old logout completion cannot conceal or navigate a newly verified account', async t => {
  for (const outcome of ['failure', 'success']) {
    const f = await fixture(t), logout = deferred(); f.setAction(() => ({ left: true }));
    f.setLogout(() => { f.changeAccount({ authenticated: false, verification: 'anonymous' }); return logout.promise; });
    const leaving = f.controller.leave({ destination: 'logout' }); await settle();
    f.changeAccount({ authenticated: true, userKey: 'b'.repeat(64) });
    f.setView(room({ selfId: 'friend', revision: 4 }), { emit: false }); await f.controller.recover(); await settle();
    const current = f.clients.at(-1), gates = f.stats.gates.length;
    if (outcome === 'failure') logout.reject(error(503, '旧注销请求的迟到失败')); else logout.resolve({});
    assert.equal(await leaving, false);
    assert.equal(current.stopped, false, outcome); assert.equal(f.stats.gates.length, gates, outcome); assert.deepEqual(f.navigation, [], outcome);
  }
});
