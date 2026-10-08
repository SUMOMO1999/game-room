import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as art from './games/poker414-2/art.mjs';
import { makeDeck, getCard } from './games/poker414-2/cards.mjs';
import { handLayout, publicLayout } from './games/poker414-2/layout.mjs';
import { poker414Selection } from './games/poker414-2/presentation.mjs';
import { classifyPattern } from './games/poker414-2/patterns.mjs';
import { fixture } from './games/poker414-2/test-support/preview-fixtures.mjs';
import { roomChatMarkup } from './room-chat.mjs';

// Executes the real UI state/lifecycle code with minimal DOM doubles. Browser
// geometry, native dialogs, audio activation and hitboxes are verified separately.
function fakeDom() {
  const ids = new Map();
  class Node extends EventTarget {
    constructor(tag = 'div') {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = {};
      this.ownerDocument = null; this.clientWidth = 720; this.clientHeight = 240; this.dataset = {}; this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this._text = ''; this._class = '';
      this.style = { setProperty() {} };
      this.classList = { contains: value => this._class.split(/\s+/).includes(value), toggle: (value, force) => {
        const set = new Set(this._class.split(/\s+/).filter(Boolean)), enabled = force ?? !set.has(value);
        enabled ? set.add(value) : set.delete(value); this._class = [...set].join(' '); return enabled;
      }, add: (...values) => values.forEach(value => this.classList.toggle(value, true)), remove: (...values) => values.forEach(value => this.classList.toggle(value, false)) };
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
    removeAttribute(name) { delete this.attributes[name]; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(...values) { for (const value of values) { value.parentNode = this; this.children.push(value); } }
    prepend(...values) { for (const value of values) value.parentNode = this; this.children.unshift(...values); }
    replaceChildren(...values) { this._text = ''; this.children = []; this.append(...values); }
    matches(selector) {
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      const tag = selector.match(/^[\w-]+/)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const [_, attribute] of selector.matchAll(/\[([\w-]+)\]/g)) if (!Object.hasOwn(this.attributes, attribute)) return false;
      if (selector.includes('[open]') && !this.open) return false;
      return Boolean(tag || selector.includes('['));
    }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    showModal() { this.open = true; this.attributes.open = ''; } close() { this.open = false; delete this.attributes.open; }
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
  document.documentElement = new Node('html');
  const root = new Node(); root.ownerDocument = document; root.id = 'p414-root'; document.body.append(root);
  document.getElementById = id => ids.get(id) ?? null; document.createElement = tag => new Node(tag);
  document.querySelectorAll = selector => selector.split(',').flatMap(part => document.body.querySelectorAll(part.trim()));
  return { document, root, node: id => ids.get(id) };
}

async function mount(t, options = {}) {
  const dom = fakeDom(), timers = new Set(), actions = [], exits = [], refreshes = [], recovery = [], retries = [];
  const window = { innerWidth: 844, innerHeight: 390, performance: { now: () => 1000 },
    location: { href: 'http://127.0.0.1/poker414-2.html?code=414000' }, navigator: { clipboard: { writeText: async () => {} } },
    ResizeObserver: class { observe() {} disconnect() {} }, setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); } };
  dom.document.defaultView = window;
  const context = vm.createContext({ ...art, makeDeck, handLayout, publicLayout, poker414Selection, roomChatMarkup, URL,
    createGameAudio: () => ({ play() {}, close() {} }), mountRoomAudioControls: () => ({ destroy() {} }),
    mountRoomSettings: () => ({ close() {}, destroy() {} }), mountGameViewport: () => ({ destroy() {} }),
    gameViewport: input => ({ ...input, top: 0, resetScroll: false }) });
  const source = (await readFile(new URL('./games/poker414-2/page-ui.mjs', import.meta.url), 'utf8')).replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
  const ui = vm.runInContext(`(()=>{${source}\nreturn mountPoker414Page;})()`, context)({ root: dom.root,
    onAction: (type, fields) => actions.push([type, structuredClone(fields)]), onLeave: destination => { exits.push(structuredClone(destination)); return options.leaveResult ?? true; },
    onRefresh: fields => refreshes.push(structuredClone(fields)), onRecover: () => recovery.push(true), onRetry: () => retries.push(true), ...options });
  t.after(() => ui.destroy());
  function cardClick(id) {
    const node = dom.node('p414-hand').querySelectorAll('[data-card-id]').find(node => node.dataset.cardId === id);
    assert.ok(node); const event = new Event('click'); Object.defineProperty(event, 'target', { value: node }); dom.node('p414-hand').dispatchEvent(event);
  }
  return { ...dom, ui, window, timers, actions, exits, refreshes, recovery, retries, cardClick };
}
const card = (rank, suit = 'spades') => getCard(`p414-2-${suit}-${rank}-0`);
const normalized = (scene = 'opening') => ({ ...fixture(scene), canAct: true, connection: 'online', pending: false });

test('414 waiting and role controls send exact common action payloads, and pending disables them', async t => {
  const f = await mount(t), view = normalized('waiting'); view.hostId = view.players[1].id;
  f.ui.applyView(view); f.node('p414-ready').click(); f.node('p414-role').click();
  assert.deepEqual(f.actions, [['ready', { ready: true }], ['set-role', { role: 'spectator' }]]);
  f.ui.setPending(true); f.node('p414-ready').click(); assert.equal(f.actions.length, 2);
  assert.equal(f.node('p414-recovery').hidden, false); assert.equal(f.node('p414-retry').hidden, false);
  f.node('p414-retry').click(); assert.equal(f.retries.length, 1);
});

test('414 unique assistance never overrides manual choices or reselects after cancel on duplicate SSE', async t => {
  const f = await mount(t), view = normalized(); view.hand = [card(5), card(5, 'hearts'), card(10)];
  f.ui.applyView(view); const stableCard = f.node('p414-hand').querySelectorAll('[data-card-id]')[0];
  f.cardClick(card(5).id); f.cardClick(card(5, 'hearts').id);
  assert.equal(f.node('p414-hand').querySelectorAll('[data-card-id]')[0], stableCard, 'selection preserves the focused card element');
  const following = { ...view, target: { id: 't', cards: [card(9)], pattern: classifyPattern([card(9).id]) } };
  f.ui.applyView(following); assert.deepEqual([...f.ui.selected()], view.hand.slice(0,2).map(card => card.id)); assert.equal(f.node('p414-play').disabled, true);
  f.node('p414-clear').click(); f.ui.applyView(following); assert.equal(f.ui.selected().length, 0);
  f.ui.applyView({ ...following, target: { ...following.target, id: 'next' } }); assert.deepEqual([...f.ui.selected()], [card(10).id]);
  f.node('p414-play').click(); assert.deepEqual(f.actions, [['play', { cardIds: [card(10).id] }]]);
});

test('414 identity conceal removes all private cards including an open observer inspector and supplies actual login links', async t => {
  const f = await mount(t), view = normalized('spectator'); f.ui.applyView(view); f.node('p414-inspect').click();
  assert.ok(f.node('p414-inspector-content').querySelectorAll('[data-card-id]').length > 0);
  f.ui.conceal({ message: '请重新登录。', loginHref: '/auth/login?returnTo=414', reauthHref: '/auth/recent', preserveSelection: false });
  assert.equal(f.node('p414-inspector-dialog').open, false);
  for (const id of ['p414-hand', 'p414-inspector-content', 'p414-public', 'p414-result-scores']) assert.equal(f.node(id).children.length, 0);
  assert.equal(f.node('p414-login').hidden, false); assert.equal(f.node('p414-login').href, 'http://127.0.0.1/auth/login?returnTo=414');
  assert.equal(f.node('p414-recover').hidden, true); assert.equal(f.node('p414-play').disabled, true);
  f.ui.applyView(view); assert.equal(f.node('p414-login').hidden, true); assert.equal(f.node('p414-feedback').textContent, '已恢复房间。');
});

test('414 503 keeps selection only for the same room/match/member and 401 clears it', async t => {
  const f = await mount(t), view = normalized(); f.ui.applyView(view); f.cardClick(view.hand[0].id);
  f.ui.conceal({ message: '暂不可用', preserveSelection: true }); assert.equal(f.ui.selected().length, 0);
  f.ui.applyView(view); assert.deepEqual([...f.ui.selected()], [view.hand[0].id]);
  f.ui.conceal({ preserveSelection: true }); f.ui.applyView({ ...view, roomId: 'different-room' }); assert.equal(f.ui.selected().length, 0);
  f.cardClick(view.hand[0].id); f.ui.conceal({ message: '请重登', loginHref: '/auth/login' }); f.ui.applyView(view); assert.equal(f.ui.selected().length, 0);
});

test('414 logout/Agora share explicit penalty confirmation and an unknown leave stays retryable', async t => {
  const f = await mount(t, { leaveResult: false }), view = normalized(); view.leaveDescription = '你扣10分，其他两人各得5分。'; f.ui.applyView(view);
  f.node('p414-agora').click(); assert.equal(f.exits.length, 0); assert.equal(f.node('p414-leave-dialog').open, true); assert.match(f.node('p414-leave-description').textContent, /10分/);
  f.node('p414-leave-confirm').click(); await Promise.resolve();
  assert.deepEqual(f.exits, [{ destination: 'agora' }]); assert.equal(f.node('p414-leave-confirm').disabled, false); assert.equal(f.node('p414-leave-dialog').open, true);
  f.node('p414-stay').click(); f.node('p414-logout').click(); f.node('p414-leave-confirm').click(); await Promise.resolve();
  assert.deepEqual(f.exits[1], { destination: 'logout' });
});

test('414 members refresh read-only totals and expired response triggers one read, never a synthetic game action', async t => {
  const f = await mount(t), view = normalized('response'); view.serverTime = view.response.deadlineAt;
  f.ui.applyView(view); for (const tick of f.timers) tick(); assert.deepEqual(f.refreshes, [{ reason: 'response-expired' }]); assert.equal(f.actions.length, 0);
  f.node('p414-members').click(); assert.deepEqual(f.refreshes[1], { reason: 'scores' }); assert.match(f.node('p414-inspector-content').textContent, /待确认/);
  const memberText = f.node('p414-inspector-content').textContent;
  let previousIndex = -1;
  for (const [index, id] of view.actionOrder.entries()) {
    const player = view.players.find(item => item.id === id);
    const found = memberText.indexOf(`${index + 1} · ${player.name}`);
    assert.ok(found > previousIndex); previousIndex = found;
  }
  f.ui.applyView({ ...view, players: view.players.map(player => ({ ...player, total: 123 })) });
  assert.match(f.node('p414-inspector-content').textContent, /123/); assert.equal(f.node('p414-inspector-dialog').open, true);
  f.ui.destroy(); assert.equal(f.timers.size, 0);
});

test('414 ignores delayed old account action errors and aborts after identity conceal', async t => {
  let reject;
  const action = new Promise((resolve, failure) => { reject = failure; });
  const f = await mount(t, { onAction: () => action }), view = normalized('waiting');
  f.ui.applyView(view); f.node('p414-ready').click();
  f.ui.conceal({ message: '正在恢复新账号' }); f.ui.applyView({ ...view, selfId: 'new-account' });
  reject(new Error('旧账号失败')); await Promise.resolve(); await Promise.resolve();
  assert.notEqual(f.node('p414-feedback').textContent, '旧账号失败');
  f.ui.feedback('当前消息'); f.ui.destroy(); assert.equal(f.timers.size, 0);
});

test('414 false leave keeps the controller failure detail while restoring the confirmation button', async t => {
  const detail = '房间状态已更新，请核对后重试原退出操作。';
  const f = await mount(t, { onLeave: () => { f.ui.leaveFailure(detail); return false; } });
  f.ui.applyView(normalized()); f.node('p414-exit').click(); f.node('p414-leave-confirm').click();
  await Promise.resolve();
  assert.equal(f.node('p414-leave-error').textContent, detail);
  assert.equal(f.node('p414-leave-error').hidden, false);
  assert.equal(f.node('p414-leave-confirm').disabled, false);
  assert.equal(f.node('p414-leave-confirm').textContent, '确认退出');
  assert.equal(f.node('p414-leave-dialog').open, true);
});
