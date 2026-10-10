import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createHyakkiRoomController } from './games/hyakki-trading/room-controller.mjs';
import { createRoomActionIntent } from './platform/room-action-intent.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let n = 0; n < 6; n++) await new Promise(resolve => setImmediate(resolve)); };
const error = (status, message = '受控失败') => Object.assign(new Error(message), { status });
const card = 'yousei.g01#01';
function room({ matchId = 'a'.repeat(32), selfId = 'self', revision = 1, phase = 'playing' } = {}) {
  const players = ['self', 'friend'].map(id => ({ id, name: id, ready: true, connected: true }));
  return { gameType: 'hyakki-trading', roomCode: '123456', roomId: 'room-one', matchId, selfId,
    selfRole: 'player', hostId: 'self', phase, revision, players, spectators: [], actionReceipts: [],
    game: { matchId, turnId: 'turn-1', publicEventSequence: revision, turnPlayerId: selfId,
      pending: { id: 'effect-1', decisionId: 'choice-1', actorId: selfId }, lastPublicEvents: [] } };
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
  const navigation = []; window.location = { href: 'https://example.test/game/hyakki.html?code=123456', search: '?code=123456', replace: value => navigation.push(value) };
  let epoch = 1, timerId = 0, serverView = options.view || room(), actionHandler = async () => ({ view: serverView }),
    readHandler = null, historyHandler = null, logoutHandler = async () => {}, accountReads = 0;
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
      if (path.startsWith('/api/hyakki/')) return historyHandler ? historyHandler(path, args) : {roomId: serverView.roomId, matchId: serverView.matchId, groups: [], nextAfter: 0};
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
  const ui = { audio: { play: kind => stats.cues.push(kind) }, applyView: (value, options) => stats.views.push({...value, ...options}),
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
    const source = (await readFile(new URL('./games/hyakki-trading/game-page.mjs', import.meta.url), 'utf8')).replace(/^import[\s\S]*?;\s*/gm, '');
    document.querySelector = () => ({ syntheticRoot: true });
    const entryContext = vm.createContext({ ...dependencies, location: window.location, navigator: {}, URLSearchParams,
      entryBase: () => '/game/', mountHyakkiPage: value => { stats.uiBindings = value; return ui; }, mountRoomChat: value => { stats.chatBindings = value; return chat; },
      createHyakkiRoomController: value => { controller = createHyakkiRoomController(value); return controller; },
    });
    vm.runInContext(source, entryContext, { filename: 'actual-poker414-game-page.mjs' });
  } else { controller = createHyakkiRoomController(dependencies); void controller.start(); }
  t.after(() => controller.destroy());
  await settle();
  return { controller, document, window, clients, calls, stats, navigation, stored, timers,
    get accountReads() { return accountReads; },
    setView(value, { emit = true } = {}) { serverView = value; if (emit) clients.at(-1)?.receive(value); },
    setAction(fn) { actionHandler = fn; }, setRead(fn) { readHandler = fn; }, setHistory(fn) { historyHandler = fn; }, setLogout(fn) { logoutHandler = fn; },
    changeAccount, context };
}

test('an unknown write is reconciled by reads and only an explicit retry resends its exact saved intent', async t => {
  const f = await fixture(t); f.setAction(() => { throw new Error('lost response'); });
  await assert.rejects(f.controller.act('buy', { cardId: card }), /尚未确认/);
  const original = f.calls.find(call => call.method === 'POST').body;
  assert.ok(f.clients[0].pendingAction()); assert.ok(f.stats.views.at(-1).pending);
  await f.controller.refresh(); f.window.dispatchEvent(new Event('focus')); await settle();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1, 'GET/focus must never replay a business action');
  await assert.rejects(f.controller.act('end-turn'), /上一操作尚未确认/);
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

test('visible focus performs the existing fresh account check without rebuilding the client or hiding the table', async t => {
  const f = await fixture(t), current = f.clients[0], before = f.stats.views.length, gates = f.stats.gates.length, reads = f.accountReads;
  f.window.dispatchEvent(new Event('focus')); await settle();
  assert.equal(f.accountReads, reads + 1); assert.equal(f.clients.length, 1); assert.equal(current.stopped, false);
  assert.equal(current.connects, 1); assert.equal(f.stats.gates.length, gates); assert.equal(f.stats.views.length, before);
});


test('actual entry mounts room chat and routes explicit host actions', async t => {
  const f = await fixture(t, {entry:true});
  assert.equal(f.clients.length, 1); assert.equal(f.stats.chats.filter(item=>item.attach).length, 1);
  f.stats.chatBindings.onCue('chat'); assert.equal(f.stats.cues.at(-1), 'chat');
  await f.stats.uiBindings.onAction('configure', {hyakkiConfig:{actionLimit:10}});
  assert.deepEqual(f.calls.find(call=>call.method==='POST').body.hyakkiConfig, {actionLimit:10});
});
test('decisions bind to the current game, turn and pending identity and copy selection before awaiting', async t => {
  const f = await fixture(t), pending = deferred(), selection={keep:{firearms:1}};
  f.setAction(()=>pending.promise);
  const writing=f.controller.act('choose-effect',{selection,matchId:'forged',turnId:'forged',decisionId:'forged',effectId:'forged'});
  selection.keep.firearms=99;
  const body=f.calls.find(call=>call.method==='POST').body;
  assert.equal(body.matchId, 'a'.repeat(32)); assert.equal(body.turnId,'turn-1');
  assert.equal(body.effectId,'effect-1'); assert.equal(body.decisionId,'choice-1');
  assert.deepEqual(body.selection,{keep:{firearms:1}});
  pending.resolve({view:{...room(),actionReceipts:[{requestId:body.requestId,status:'committed'}]}}); await writing;
});
test('history responses from previous seats or matches are discarded', async t => {
  const f=await fixture(t), pending=deferred(); f.setHistory(()=>pending.promise);
  const reading=f.controller.history(); f.setView(room({matchId:'b'.repeat(32),revision:2}));
  pending.resolve({roomId:'room-one',matchId:'a'.repeat(32),groups:[{old:true}]});
  assert.equal(await reading,null);
  const late=deferred(); f.setHistory(()=>late.promise); const again=f.controller.history();
  f.changeAccount({userKey:'b'.repeat(64)});
  late.resolve({roomId:'room-one',matchId:'b'.repeat(32),groups:[{secret:true}]});
  assert.equal(await again,null);
});
test('keeping a seat returns without a leave write; unknown economic intent blocks that shortcut', async t => {
  const f=await fixture(t); assert.equal(await f.controller.leave({keepSeat:true}),true);
  assert.deepEqual(f.navigation,['./']); assert.equal(f.calls.some(call=>call.method==='POST'),false);
  assert.equal(f.stats.forgotten.length,0);
  const g=await fixture(t); g.setAction(()=>{throw new Error('lost response');});
  await assert.rejects(g.controller.act('buy',{cardId:card}));
  assert.equal(await g.controller.leave({keepSeat:true}),false); assert.deepEqual(g.navigation,[]);
});
