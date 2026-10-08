// Isolated browser globals for a local experiment. Application source modules
// are loaded unchanged; only DOM presentation, cookies and loopback fetch are adapted.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

export async function createCapacityClient({ appRoot, base, member, observe }) {
  if (typeof vm.SourceTextModule !== 'function') throw new Error('Use node --experimental-vm-modules');
  const timers = new Set(), intervals = new Set(), controllers = new Set(), modules = new Map();
  const storage = () => { const data = new Map(); return { get length() { return data.size; }, key: n => [...data.keys()][n],
    getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) }; };
  const document = new EventTarget(); document.hidden = false;
  const window = new EventTarget(); window.location = new URL(`${base}/poker414.html?code=${member.code}`);
  window.location.replace = value => observe('navigation', { member: member.label, value });
  const wrappedFetch = async (input, options = {}) => {
    const url = new URL(input, base); if (url.origin !== base) throw new Error('Non-loopback client fetch denied');
    const headers = new Headers(options.headers); headers.set('Cookie', member.cookie);
    if ((options.method || 'GET') !== 'GET') headers.set('Origin', base);
    const started = performance.now(), response = await fetch(url, { ...options, headers });
    observe('http', { member: member.label, path: url.pathname, method: options.method || 'GET', status: response.status, elapsedMs: performance.now() - started });
    if (!url.pathname.endsWith('/events') || !response.ok) return response;
    const reader = response.body.getReader(); let stopped = false, output;
    const inputController = { close() { if (stopped) return; stopped = true; try { output.close(); } catch {} void reader.cancel().catch(() => {}); } };
    controllers.add(inputController); member.breakStream = () => inputController.close();
    const body = new ReadableStream({
      start(controller) {
        output = controller;
        (async () => { try { while (!stopped) {
          const item = await reader.read(); if (stopped) break;
          if (item.done) { controller.close(); break; }
          observe('sseBytes', { member: member.label, bytes: item.value.byteLength }); controller.enqueue(item.value);
        } } catch (error) { if (!stopped) controller.error(error); }
        finally { stopped = true; controllers.delete(inputController); void reader.cancel().catch(() => {}); } })();
      }, cancel() { stopped = true; controllers.delete(inputController); return reader.cancel(); },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const context = vm.createContext({ console, structuredClone, URL, URLSearchParams, Event, EventTarget, AbortController, DOMException,
    TextDecoder, TextEncoder, Headers, Response, Request, ReadableStream, fetch: wrappedFetch, crypto: webcrypto,
    performance, location: window.location, window, document, navigator: { onLine: true },
    sessionStorage: storage(), localStorage: storage(),
    setTimeout: (fn, ms, ...args) => { const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms); timers.add(timer); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
    setInterval: (fn, ms, ...args) => { const timer = setInterval(() => { observe('clientTimer', { member: member.label, ms }); fn(...args); }, ms); intervals.add(timer); return timer; },
    clearInterval: timer => { intervals.delete(timer); clearInterval(timer); },
  });
  async function moduleFor(file) {
    if (modules.has(file)) return modules.get(file);
    if (!file.startsWith(appRoot + path.sep) || !file.endsWith('.mjs')) throw new Error('Invalid local browser module');
    const module = new vm.SourceTextModule(await readFile(file, 'utf8'), { context, identifier: file,
      initializeImportMeta(meta) { meta.url = base + '/' + path.relative(appRoot, file).split(path.sep).join('/'); } });
    modules.set(file, module); return module;
  }
  async function load(relative) {
    const module = await moduleFor(path.resolve(appRoot, relative));
    if (module.status === 'unlinked') await module.link((specifier, parent) => moduleFor(path.resolve(path.dirname(parent.identifier), specifier)));
    if (module.status === 'linked') await module.evaluate();
    return module.namespace;
  }
  const account = await load('account-client.mjs'), room = await load('room-client.mjs');
  const actual = await load('games/poker414-2/room-controller.mjs');
  class Client extends room.RoomClient {
    constructor(...args) { super(...args); member.client = this; observe('clientCreated', { member: member.label }); }
    receive(view, epoch) { const before = this.view; super.receive(view, epoch); if (this.view && this.view !== before) observe('view', { member: member.label, view: this.view }); }
  }
  let controller;
  if (member.game === 'poker414-2') {
    const ui = { audio: { play() {} }, applyView() {}, feedback: message => observe('feedback', { member: member.label, message }),
      conceal: value => observe('conceal', { member: member.label, message: value.message }), leaveFailure() {}, destroy() {} };
    controller = actual.createPoker414RoomController({ roomCode: member.code, document, window, ui,
      chat: { attach(client) { void client.chatHistory().catch(error => observe('clientError', { member: member.label, status: error.status ?? null, message: error.message })); }, clear() {}, connection() {}, receive: () => observe('chat', { member: member.label }) },
      RoomClient: Client, api: room.api, ...account, forgetMembership: room.forgetMembership,
      roomHref: code => `./room.html?code=${code}` });
    await controller.start();
  } else {
    await account.loadAccount(); const first = await room.api(`/api/rooms/${member.code}`);
    const client = new Client(member.code, { playerId: first.view.selfId, userKey: account.accountState().userKey }, {
      onView() {}, onConnection: status => observe('connection', { member: member.label, status }),
      onError: error => observe('clientError', { member: member.label, status: error.status ?? null, message: error.message }),
      onChat: () => observe('chat', { member: member.label }) });
    client.receive(first.view); client.connect();
    const lifecycle = account.watchAccountLifecycle({ windowRef: window, documentRef: document, onSuspend() {}, onVerified() {},
      onError: error => observe('clientError', { member: member.label, status: error.status ?? null }) });
    await lifecycle.refresh({ conceal: false });
    controller = { act: (...args) => client.action(...args), recover: () => lifecycle.refresh(), destroy() { lifecycle.stop(); client.stop(); } };
  }
  return { controller, account, room, async close() {
    controller.destroy(); for (const stream of controllers) stream.close();
    for (const timer of timers) clearTimeout(timer); for (const timer of intervals) clearInterval(timer);
    timers.clear(); intervals.clear(); await new Promise(resolve => setImmediate(resolve));
    return { timers: timers.size, intervals: intervals.size, streams: controllers.size };
  } };
}
