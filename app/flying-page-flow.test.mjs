import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createGame, applyRoll } from './games/flying-chess/rules.mjs';
import { createFlyingChessAdapter } from '../server/games/flying-chess/adapter.mjs';
import * as art from './games/flying-chess/art.mjs';
import { SIDES } from './games/flying-chess/board.mjs';
import * as presentation from './games/flying-chess/presentation.mjs';
import * as roomPresentation from './platform/room-presentation.mjs';
import { mountRoomSettings } from './platform/room-settings.mjs';
import { roomChatMarkup } from './room-chat.mjs';
import { createRoomClock } from './platform/room-clock.mjs';
import { mountGameViewport } from './platform/room-viewport.mjs';
import { gameViewport } from './game-viewport.mjs';
import { createRoomSession, createRoomExit } from './platform/room-session.mjs';
import { randomUUID } from 'node:crypto';
import { loginHref } from './account-client.mjs';
import { roomHref } from './game-routing.mjs';
import { publicAssetPaths } from '../server/public-assets.mjs';
import { createGameAudio } from './game-audio.mjs';
import { createServer } from './server.mjs';
import { once } from 'node:events';
import path from 'node:path';

const settle = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// Actual page/model/art logic executes in a minimal DOM. This verifies state,
// async callbacks and button flows, not CSS geometry, pointer hitboxes, native
// dialog focus, trusted gestures, audio loudness or mobile software keyboards.
function fakeDom() {
  const ids = new Map();
  class Node extends EventTarget {
    constructor(tag = 'div') {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = {};
      this.dataset = {}; this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this._text = ''; this._class = '';
      this.style = { setProperty() {} };
      this.classList = { contains: value => this._class.split(/\s+/).includes(value), toggle: (value, force) => {
        const set = new Set(this._class.split(/\s+/).filter(Boolean)), enabled = force ?? !set.has(value);
        enabled ? set.add(value) : set.delete(value); this._class = [...set].join(' '); return enabled;
      }, add: (...values) => values.forEach(value => this.classList.toggle(value, true)) };
    }
    get id() { return this.attributes.id; } set id(value) { this.attributes.id = value; ids.set(value, this); }
    get className() { return this._class; } set className(value) { this._class = value; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    set innerHTML(value) { this._text = ''; this.children = []; parse(value, this); }
    get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'id') this.id = value;
      if (name === 'class') this.className = value;
      if (name === 'hidden') this.hidden = true;
      if (name === 'value') this.value = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(...values) { for (const value of values) { value.parentNode = this; this.children.push(value); } }
    prepend(...values) { for (const value of values) value.parentNode = this; this.children.unshift(...values); }
    replaceChildren(...values) { this._text = ''; this.children = []; this.append(...values); }
    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      const tag = selector.match(/^[\w-]+/)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const [_, attribute] of selector.matchAll(/\[([\w-]+)\]/g)) if (!Object.hasOwn(this.attributes, attribute)) return false;
      if (selector.includes('[open]') && !this.open) return false;
      return Boolean(tag || selector.includes('['));
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    showModal() { this.open = true; } close() { this.open = false; }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  function parse(source, parent) {
    const stack = [parent], voids = new Set(['INPUT', 'META', 'LINK', 'IMG', 'BR', 'HR']);
    for (const token of String(source).match(/<[^>]*>|[^<]+/g) || []) {
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
        const node = new Node(tag);
        for (const match of token.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
          if (match[1] !== tag) node.setAttribute(match[1], match[2] ?? match[3] ?? match[4] ?? '');
        }
        stack.at(-1).append(node); if (!voids.has(node.tagName) && !token.endsWith('/>')) stack.push(node);
      } else stack.at(-1)._text += token;
    }
  }
  const document = new EventTarget(); document.hidden = false; document.body = new Node('body');
  const root = new Node(); root.id = 'flying-root'; document.body.append(root);
  document.getElementById = id => ids.get(id) ?? null; document.createElement = tag => new Node(tag);
  return { document, root, node: id => ids.get(id) };
}

async function page(t, options = {}) {
  const dom = fakeDom(), window = new EventTarget(), cues = [], timers = new Map();
  let timerId = 0;
  window.innerWidth = 844; window.innerHeight = 390; window.scrollTo = () => {}; window.visualViewport = new EventTarget();
  const audio = { play: (kind, flags) => { cues.push({ kind, flags }); },
    phaseCue: createGameAudio({ storage: null, AudioContext: null, document: null, window: null }).phaseCue, close() {} };
  const context = vm.createContext({ ...art, SIDES, ...presentation, ...roomPresentation, gameViewport,
    document: dom.document, window, location: { href: 'http://127.0.0.1/flying.html?code=123456' },
    navigator: {}, console, Event, Number, Object, Promise,
    mountRoomSettings, roomChatMarkup, createGameAudio: () => audio, mountRoomAudioControls: () => ({ destroy() {} }),
    createRoomClock: callbacks => createRoomClock({ ...callbacks, now: () => 1000,
      setInterval: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearInterval: id => timers.delete(id) }),
    mountGameViewport: callbacks => mountGameViewport({ ...callbacks, setTimeout: () => ++timerId, clearTimeout() {} }),
  });
  const source = (await readFile(new URL('./games/flying-chess/page-ui.mjs', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
  const mount = vm.runInContext(`(()=>{${source}\nreturn mountFlyingPage;})()`, context, {
    filename: 'actual-flying-page-ui.mjs', importModuleDynamically: () => Promise.reject(new Error('app shell is tested separately')),
  });
  const ui = mount(options); t.after(() => ui.destroy());
  return { ...dom, ui, cues, window, timers };
}

function projected({ pending = true, phase = 'playing', self = 'self', revision = 4, role = 'player' } = {}) {
  const adapter = createFlyingChessAdapter();
  let game = createGame(['self', 'friend'], { firstPlayerIndex: 0 });
  if (pending) game = applyRoll(game, 'self', 6).state;
  const view = { roomCode: '123456', roomId: 'page-room', matchId: 'page-match', gameType: 'flying-chess',
    selfId: self, selfRole: role, hostId: 'self', revision, phase, turnClock: null, players: [
      { id: 'self', name: '甲', ready: true }, { id: 'friend', name: '乙', ready: true }], spectators: [] };
  view.game = role === 'spectator' ? adapter.spectatorView(game, { phase }) : adapter.privateView(game, self, { phase });
  return view;
}

test('actual page mounts both rule modes and shows every rule paragraph without executing business actions', async t => {
  for (const practice of [false, true]) {
    let calls = 0;
    const session = { subscribe: () => () => {}, destroy() {}, action: () => { calls++; } };
    const f = await page(t, { mode: practice ? 'practice' : 'room', session, onAction: () => { calls++; } });
    const text = f.node('flying-rule-text').textContent;
    for (const group of presentation.flyingRulePages({ practice })) for (const paragraph of group) {
      assert.ok(text.includes(paragraph.title)); assert.ok(text.includes(paragraph.text));
    }
    assert.equal(calls, 0); assert.equal(f.node('flying-exit').getAttribute('aria-label'), practice ? '返回大厅' : '退出房间');
    if (practice) {
      assert.equal(f.node('room-chat'), undefined, 'a local practice must not pretend to have room members');
      assert.equal(f.node('chat-legacy-note').hidden, false);
      assert.match(f.node('chat-legacy-note').textContent, /本机轮流练习.*没有联网聊天/);
    } else {
      assert.ok(f.node('room-chat'));
      assert.ok(f.node('chat-send').classList.contains('primary-button'), 'the actual composer must use the shared short-screen layout');
      assert.equal(f.node('chat-input').getAttribute('enterkeyhint'), 'enter');
    }
  }
});

test('shared settings keeps the saved roll and choice while moving audio and opening a single rules panel', async t => {
  const session = { subscribe: () => () => {}, destroy() {}, action() { assert.fail('settings must not submit a game action'); } };
  const f = await page(t, { mode: 'practice', session });
  const view = { ...projected(), lessonId: 'jump-flight', storageAvailable: true };
  f.ui.applyView(view, { baseline: true });
  f.node('flying-plane-grid').children[0].click();
  f.node('flying-options').click();
  assert.equal(f.node('flying-options-dialog').open, true);
  assert.equal(f.node('flying-options').getAttribute('aria-expanded'), 'true');
  assert.ok(f.node('flying-settings-tools').children.includes(f.node('sound-toggle')));
  assert.ok(f.node('flying-settings-tools').children.includes(f.node('flying-rules')));
  assert.equal(f.node('flying-practice-count').value, '2');
  assert.equal(f.node('flying-practice-lesson').value, 'jump-flight');
  f.node('flying-rules').click();
  assert.equal(f.node('flying-options-dialog').open, false);
  assert.equal(f.node('flying-rules-dialog').open, true);
  assert.equal(f.node('flying-options').getAttribute('aria-expanded'), 'false');
  assert.equal(f.node('flying-die').getAttribute('aria-label'), '本次 6 点');
  assert.equal(f.node('flying-plane-grid').children[0].getAttribute('aria-pressed'), 'true');
  assert.equal(f.node('flying-confirm').disabled, false);
});

test('fixed teaching exposes unavailable persistence before leaving instead of promising recovery', async t => {
  const session = { subscribe: () => () => {}, destroy() {} };
  const f = await page(t, { mode: 'practice', session });
  f.ui.applyView({ ...projected(), practice: true, lessonLabel: '跳后飞', storageAvailable: false }, { baseline: true });
  assert.match(f.node('flying-save-note').textContent, /跳后飞.*无法保存/);
  assert.doesNotMatch(f.node('flying-save-note').textContent, /已保存/);
  f.node('flying-exit').click();
  assert.match(f.node('flying-leave-description').textContent, /离开后进度会丢失/);
});

test('same saved die selection survives connection and viewport recovery, but new die or identity clears it', async t => {
  let actions = 0;
  const f = await page(t, { onAction: () => { actions++; } }), initial = projected();
  f.ui.setConnection('online'); f.ui.applyView(initial, { baseline: true });
  f.node('flying-plane-grid').children[0].click(); assert.equal(f.node('flying-confirm').disabled, false);
  f.ui.setConnection('offline'); assert.equal(f.node('flying-confirm').disabled, true);
  f.ui.setConnection('online'); assert.equal(f.node('flying-confirm').disabled, false);
  f.window.dispatchEvent(new Event('resize')); f.window.dispatchEvent(new Event('orientationchange'));
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
  f.ui.applyView({ ...initial, revision: initial.revision + 1 }, { baseline: true });
  assert.equal(f.node('flying-confirm').disabled, false); assert.equal(actions, 0);
  f.ui.conceal({ preserveSelection: true }); f.ui.applyView(initial, { baseline: true });
  assert.equal(f.node('flying-confirm').disabled, false, 'same member/match/saved die remains selected after verification');
  f.ui.applyView(projected({ self: 'friend', revision: 6 }), { baseline: true });
  assert.equal(f.node('flying-confirm').disabled, true, 'another identity never inherits the original selection');
  f.ui.applyView(projected({ pending: false, revision: 7 }), { baseline: true });
  assert.equal(f.node('flying-confirm').hidden, true); assert.equal(f.node('flying-roll').disabled, false);
});

test('unknown original move remains blocked while explicit room exit is available and independently acknowledged', async t => {
  const move = deferred(), leave = deferred(); let pending = null, moves = 0, leaves = 0;
  const f = await page(t, { getPending: () => pending,
    onAction(type, fields) { moves++; assert.equal(type, 'move'); assert.equal(fields.rollId, 1); pending = { type, ...fields }; return move.promise; },
    onLeave() { leaves++; return leave.promise; } });
  f.ui.setConnection('online'); f.ui.applyView(projected(), { baseline: true });
  f.node('flying-plane-grid').children[0].click(); f.node('flying-confirm').click();
  assert.equal(moves, 1); assert.equal(f.node('flying-confirm').disabled, true);
  assert.equal(f.node('flying-exit').disabled, false); f.node('flying-exit').click();
  assert.equal(f.node('flying-leave-dialog').open, true); f.node('flying-leave-confirm').click();
  assert.equal(leaves, 1); assert.equal(f.node('flying-leave-confirm').disabled, true);
  move.reject(new Error('结果未确认')); await settle();
  assert.equal(f.node('flying-recovery').hidden, false); assert.equal(f.node('flying-confirm').disabled, true);
  leave.resolve(false); await settle();
  assert.equal(f.node('flying-leave-dialog').open, true); assert.equal(f.node('flying-leave-confirm').disabled, false);
  assert.equal(moves, 1); assert.equal(leaves, 1);
});

test('retired action failure cannot write feedback into a recovered identity or unlock its controls', async t => {
  const request = deferred(), f = await page(t, { onAction: () => request.promise });
  f.ui.setConnection('online'); f.ui.applyView(projected(), { baseline: true });
  f.node('flying-plane-grid').children[0].click(); f.node('flying-confirm').click();
  f.ui.conceal({ message: '重新核验身份' }); f.ui.applyView(projected({ self: 'friend', revision: 5 }), { baseline: true });
  const before = f.node('flying-feedback').textContent;
  request.reject(new Error('原玩家操作失败')); await settle();
  assert.equal(f.node('flying-feedback').textContent, before); assert.equal(f.node('flying-confirm').disabled, true);
  assert.equal(f.cues.some(cue => cue.kind === 'invalid'), false);
});

test('observer exit describes only leaving observation and no route permissions are exposed', async t => {
  const f = await page(t); f.ui.setConnection('online'); f.ui.applyView(projected({ role: 'spectator', self: 'observer' }), { baseline: true });
  assert.equal(f.node('flying-confirm').disabled, true); assert.equal(f.node('flying-roll').disabled, true);
  assert.equal(f.node('flying-plane-grid').children.length, 0); f.node('flying-exit').click();
  assert.match(f.node('flying-leave-description').textContent, /不影响朋友对局/);
  assert.equal(f.cues.length, 0, 'restored observer baseline has no historical sound');
});

test('saved room phases cue once although core revision is unchanged, and recovered roll baselines stay quiet', async t => {
  const f = await page(t); f.ui.setConnection('online');
  const waiting = { ...projected({ pending: false, revision: 1 }), phase: 'waiting', matchId: null, game: null };
  f.ui.applyView(waiting, { baseline: true });
  const started = projected({ pending: false, revision: 2 });
  f.ui.applyView(started); f.ui.applyView(structuredClone(started));
  const paused = projected({ pending: false, phase: 'paused', revision: 3 });
  f.ui.applyView(paused); f.ui.applyView(structuredClone(paused));
  const resumed = projected({ pending: false, revision: 4 }); f.ui.applyView(resumed);
  f.ui.applyView({ ...resumed, revision: 5 });
  assert.deepEqual(f.cues.map(cue => cue.kind), ['start', 'pause', 'resume']);
  f.cues.length = 0;
  const roll = projected({ revision: 6 }); f.ui.applyView(roll); f.ui.applyView({ ...roll, revision: 7 });
  assert.deepEqual(f.cues.map(cue => cue.kind), ['roll']);
  f.ui.conceal({ preserveSelection: true }); f.ui.applyView(roll, { baseline: true });
  assert.deepEqual(f.cues.map(cue => cue.kind), ['roll'], 'recovery never replays the saved roll sound');
});

test('actionable terminal controls disappear and a failed action remains readable in the primary stage', async t => {
  const f = await page(t, { onAction: () => { throw new Error('请选择当前骰子的飞机。'); } });
  f.ui.setConnection('online'); f.ui.applyView(projected(), { baseline: true });
  f.node('flying-plane-grid').children[0].click(); f.node('flying-confirm').click(); await settle();
  assert.match(f.node('flying-stage').textContent, /请选择当前骰子的飞机/);
  f.ui.applyView({ ...projected(), phase: 'aborted', abortedResult: { aborted: true } }, { baseline: true });
  assert.equal(f.node('flying-live').hidden, true); assert.equal(f.node('flying-result').hidden, false);
  assert.equal(f.node('flying-exit').disabled, false);
});

test('paused saved dice expose only resume and restore the normal move controls after resuming', async t => {
  const calls = [], f = await page(t, { onAction: type => { calls.push(type); } });
  f.ui.setConnection('online');
  f.ui.applyView(projected({ phase: 'paused' }), { baseline: true });
  for (const id of ['flying-roll', 'flying-confirm', 'flying-cancel']) assert.equal(f.node(id).hidden, true);
  assert.equal(f.node('flying-resume').hidden, false);
  assert.equal(f.node('flying-resume').disabled, false);
  f.node('flying-resume').click(); await settle();
  assert.deepEqual(calls, ['resume']);
  f.ui.applyView(projected());
  assert.equal(f.node('flying-resume').hidden, true);
  assert.equal(f.node('flying-confirm').hidden, false);
  assert.equal(f.node('flying-cancel').hidden, false);
  assert.equal(f.node('flying-confirm').disabled, true, 'resuming still requires an explicit plane choice');
});

// Execute the actual online entry and actual session/exit controllers. Transport
// is a controlled fake; underlying client epochs/auth API have their own tests.
async function onlinePage(t) {
  const dom = fakeDom(), menu = dom.document.createElement('div'); menu.setAttribute('class', 'room-menu-actions'); dom.root.append(menu);
  dom.document.querySelector = () => menu;
  const window = new EventTarget(), memberships = [], clients = [], calls = [], chats = [];
  let epoch = 1, account = { mode: 'mock', authenticated: true, verification: 'verified', userKey: 'a'.repeat(64) };
  let firstView = projected(), handlers, options, leaveResult = () => Promise.resolve({ left: true });
  const location = { search: '?code=123456', href: 'http://127.0.0.1/flying.html?code=123456', replace(value) { this.replaced = value; } };
  class Client {
    constructor(code, membership, callbacks) { this.code = code; this.membership = membership; this.callbacks = callbacks; this.accountEpoch = epoch; this.stopped = false; clients.push(this); }
    receive(value) { this.view = value; this.callbacks.onView(value); }
    epoch() { return { account: this.accountEpoch }; }
    stop() { this.stopped = true; }
    connect() { this.callbacks.onConnection('online'); }
    pendingAction() { return null; } actionStorageReady() { return true; }
    async request(url, request) { calls.push({ url, body: structuredClone(request.body), client: this }); return leaveResult(this, request.body); }
    refresh() { this.receive(firstView); return Promise.resolve(firstView); }
  }
  const ui = { audio: { play() {} }, views: [], gates: [], applyView(value, metadata) { this.views.push({ value, metadata }); },
    setConnection(value) { this.connection = value; }, conceal(value) { this.gates.push(value); }, setMessage() {}, leaveFailure(value) { this.leaveMessage = value; }, destroy() {} };
  const context = vm.createContext({ document: dom.document, window, location, URLSearchParams, Promise, AbortController,
    crypto: { randomUUID }, createRoomSession, createRoomExit, RoomClient: Client,
    mountFlyingPage: value => { options = value; return ui; },
    api: async () => ({ view: firstView }), accountState: () => account, accountGeneration: () => epoch,
    onAccountChange: callback => { memberships.push(callback); }, loadAccount: async () => account,
    watchAccountLifecycle: value => { handlers = value; return { refresh: () => { value.onVerified(account); return Promise.resolve(); } }; },
    loginHref, reauthenticationHref: () => '/#account', logoutAccount: async () => {}, gameErrorMessage: roomPresentation.gameErrorMessage,
    loadMembership: () => null, forgetMembership: (code, member) => calls.push({ forgotten: [code, member] }), roomHref,
    mountRoomChat: () => ({ attach: (...args) => chats.push({ attach: args }), clear: value => chats.push({ clear: value }),
      connection: value => chats.push({ connection: value }), receive: value => chats.push({ packet: value }) }),
  });
  const source = (await readFile(new URL('./games/flying-chess/game-page.mjs', import.meta.url), 'utf8')).replace(/^import[\s\S]*?;\s*/gm, '');
  vm.runInContext(source, context, { filename: 'actual-flying-game-page.mjs' }); await settle();
  t.after(() => window.dispatchEvent(new Event('pagehide')));
  return { ...dom, clients, calls, chats, ui, options, location, refresh: () => handlers.onVerified(account),
    leave: callback => { leaveResult = callback; }, firstView: value => { firstView = value; },
    changeAccount(value) { epoch++; account = value; for (const callback of memberships) callback(account); } };
}

test('actual online entry keeps invite return on 401 and attaches chat to the restored original room', async t => {
  const f = await onlinePage(t); assert.equal(f.clients.length, 1);
  const attached = f.chats.find(item => item.attach).attach;
  assert.equal(attached[1].roomId, 'page-room'); assert.equal(attached[1].selfId, 'self');
  f.clients[0].callbacks.onError(Object.assign(new Error('身份已过期'), { status: 401 }));
  const href = new URL(f.ui.gates.at(-1).loginHref, 'http://127.0.0.1');
  assert.ok(['/flying.html?code=123456', '/?room=123456'].includes(href.searchParams.get('returnTo')),
    'a new login must retain this invite instead of returning to the bare lobby');
});

test('same-account 503 during unknown leave recovers a new client and retries the exact original exit intent', async t => {
  const f = await onlinePage(t), first = f.clients[0], missing = deferred();
  f.leave(() => missing.promise);
  const leaving = f.options.onLeave(); await settle(); assert.equal(f.calls.filter(item => item.body).length, 1);
  const original = f.calls.find(item => item.body).body;
  first.callbacks.onError(Object.assign(new Error('核验暂不可用'), { status: 503 }));
  missing.reject(Object.assign(new Error('退出结果暂不可确认'), { status: 503 })); await leaving;
  f.firstView(projected({ revision: 5 })); f.refresh(); await settle(); assert.equal(f.clients.length, 2);
  f.leave(() => Promise.resolve({ left: true })); await f.options.onLeave();
  const writes = f.calls.filter(item => item.body);
  assert.equal(writes.length, 2); assert.deepEqual(writes[1].body, original);
  assert.equal(f.location.href, './');
});

test('account replacement discards the prior member exit intent before another member may leave', async t => {
  const f = await onlinePage(t), missing = deferred(); f.leave(() => missing.promise);
  const leaving = f.options.onLeave(); await settle(); const original = f.calls.find(item => item.body).body;
  f.changeAccount({ mode: 'mock', authenticated: true, verification: 'verified', userKey: 'b'.repeat(64) });
  missing.reject(new Error('旧账号已离开')); await leaving;
  f.firstView(projected({ self: 'friend', revision: 9 })); f.refresh(); await settle();
  f.leave(() => Promise.resolve({ left: true })); await f.options.onLeave();
  const latest = f.calls.filter(item => item.body).at(-1).body;
  assert.notEqual(latest.requestId, original.requestId); assert.equal(latest.expectedRevision, 9);
});

test('all flying browser module dependencies are explicitly public while server authority and fixtures stay denied', async () => {
  const allowed = new Set(publicAssetPaths()), visited = new Set(), pending = [
    'games/flying-chess/game-page.mjs', 'games/flying-chess/practice-page.mjs',
  ];
  while (pending.length) {
    const current = pending.pop(); if (visited.has(current)) continue; visited.add(current);
    assert.ok(allowed.has(current), `${current} must be in the explicit public allow-list`);
    const source = await readFile(new URL(current, import.meta.url), 'utf8');
    const imports = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
    ].map(match => match[1]);
    for (const value of imports) {
      assert.ok(value.startsWith('.'), `${current} cannot require a Node/provider module in browsers`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(current), value));
      assert.equal(resolved.startsWith('../'), false, `${current} must not traverse out of app`);
      pending.push(resolved);
    }
  }
  assert.ok(visited.has('games/flying-chess/rules.mjs'), 'local practice deliberately uses the public pure core');
  for (const forbidden of ['rooms.mjs', 'game-registry.mjs', 'games/flying-chess/adapter.mjs',
    'games/flying-chess/fixtures/full-game.mjs', 'games/flying-chess/fixtures/scenarios.mjs',
    'games/flying-chess/rules.test.mjs', 'test-support/flying-platform-worker.mjs', '../server/games/flying-chess/adapter.mjs']) {
    assert.equal(allowed.has(forbidden), false, `${forbidden} remains private`);
  }
});

test('actual anonymous HTTP serves the two PWA pages and public practice core while denying server/fixture paths', async t => {
  const server = createServer({ settings: { mode: 'legacy' } }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const file of ['flying.html', 'flying-practice.html']) {
    const response = await fetch(`${origin}/${file}`); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text(); assert.match(html, /viewport-fit=cover/); assert.match(html, /manifest\.webmanifest/);
    assert.match(html, /apple-mobile-web-app-capable/); assert.match(html, /apple-touch-icon\.png/);
  }
  for (const file of ['games/flying-chess/game-page.mjs', 'games/flying-chess/practice-page.mjs',
    'games/flying-chess/rules.mjs', 'games/flying-chess/routes.mjs', 'games/flying-chess/presentation.mjs', 'games/flying-chess/ui.css']) {
    const response = await fetch(`${origin}/${file}`); assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('cache-control'), 'no-store'); await response.arrayBuffer();
  }
  for (const file of ['rooms.mjs', 'game-registry.mjs', 'games/flying-chess/adapter.mjs', 'server/games/flying-chess/adapter.mjs',
    'games/flying-chess/fixtures/full-game.mjs', 'games/flying-chess/rules.test.mjs', 'test-support/flying-platform-worker.mjs']) {
    const response = await fetch(`${origin}/${file}`); assert.equal(response.status, 404, file); await response.arrayBuffer();
  }
});
