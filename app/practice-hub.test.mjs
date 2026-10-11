import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentationCatalog, presentationCatalog } from './games/catalog.mjs';
import { mountPracticeHub } from './practice-hub.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { MockProvider } from '../server/auth.mjs';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';

// Minimal DOM boundary: exercise the actual consumer without a browser dependency.
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.hidden = false; this.value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name, handler) { if (this.listeners.get(name) === handler) this.listeners.delete(name); }
}
function fixture() {
  const ids = new Map(['hub-games', 'hub-search', 'hub-count', 'hub-empty'].map(id => [id, new Node(id)]));
  return { ids, document: { createElement: tag => new Node(tag), getElementById: id => ids.get(id) } };
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function definition(game) { const { route, ...fields } = game; return fields; }

test('practice hub renders one game per directory registration and retains every primary and PARKS mode entry', () => {
  const { ids, document } = fixture(), dispose = mountPracticeHub({ document });
  const cards = ids.get('hub-games').children;
  assert.deepEqual(cards.map(card => card.dataset.game), presentationCatalog.list().map(game => game.gameType));
  assert.equal(cards.length, 7);
  for (const game of presentationCatalog.list()) {
    const card = cards.find(card => card.dataset.game === game.gameType);
    assert.equal(descendants(card).filter(node => node.className === 'hub-primary')[0].href, `./${game.practicePage}`);
  }
  const parks = cards.find(card => card.dataset.game === 'parks');
  assert.deepEqual(descendants(parks).filter(node => node.tagName === 'a').map(node => node.href), ['./parks-practice.html', './parks-tutorial.html', './parks-practice.html?mode=solo', './parks-catalog.html']);
  assert.equal(ids.get('hub-count').textContent, '7 款游戏');
  dispose(); assert.equal(ids.get('hub-search').listeners.size, 0);
});

test('an eighth metadata registration reaches the same consumer without changing navigation or assuming known illustrations', () => {
  const next = definition(presentationCatalog.get('rummikub'));
  Object.assign(next, { gameType: 'new-board-game', name: '新桌游', page: 'new-board.html', practicePage: 'new-practice.html', assets: [] });
  delete next.practiceSummary; delete next.practiceLinks;
  const catalog = createPresentationCatalog([...presentationCatalog.list().map(definition), next]);
  const { ids, document } = fixture(); mountPracticeHub({ document, catalog });
  const cards = ids.get('hub-games').children, last = cards.at(-1);
  assert.equal(cards.length, 8); assert.equal(last.dataset.game, 'new-board-game');
  assert.equal(descendants(last).find(node => node.className === 'hub-primary').href, './new-practice.html');
  assert.equal(descendants(last).find(node => node.className === 'hub-summary').textContent, '熟悉玩法与操作，再约朋友一起玩。');
  assert.equal(descendants(last).find(node => node.className === 'hub-art').innerHTML.includes('<svg'), true);
  const search = ids.get('hub-search'); search.value = '新桌游'; search.listeners.get('input')();
  assert.deepEqual(cards.filter(card => !card.hidden).map(card => card.dataset.game), ['new-board-game']);
  assert.equal(ids.get('hub-count').textContent, '1 / 8 款');
  search.value = '没有这款'; search.listeners.get('input')(); assert.equal(ids.get('hub-empty').hidden, false);
  search.value = ''; search.listeners.get('input')(); assert.equal(cards.filter(card => !card.hidden).length, 8); assert.equal(ids.get('hub-empty').hidden, true);
});

test('practice descriptions and supplementary links stay immutable browser metadata with local safe routes', () => {
  const game = definition(presentationCatalog.get('parks'));
  for (const links of [[{ label: '逃出目录', page: '../server/private.html' }], [{ label: '外部', page: 'https://example.com/' }], [{ label: '脚本', page: 'javascript:alert(1)' }], [{ label: '未知字段', page: 'parks-tutorial.html', account: true }], [{ label: '重复', page: 'parks-tutorial.html' }, { label: '再次', page: 'parks-tutorial.html' }]]) {
    assert.throws(() => createPresentationCatalog([{ ...game, practiceLinks: links }]), TypeError);
  }
  assert.throws(() => createPresentationCatalog([{ ...game, practiceSummary: '' }]), TypeError);
  const original = [{ label: '学习', page: 'parks-tutorial.html' }];
  const registered = createPresentationCatalog([{ ...game, practiceLinks: original }]).get('parks');
  original[0].label = 'changed'; original.push({ label: 'new', page: 'parks-catalog.html' });
  assert.deepEqual(registered.practiceLinks, [{ label: '学习', page: 'parks-tutorial.html' }]);
  assert.equal(Object.isFrozen(registered.practiceLinks), true); assert.equal(Object.isFrozen(registered.practiceLinks[0]), true);
});

test('anonymous direct and mounted hub and all game entries remain public without touching identities or saved rooms', async t => {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_ORIGIN: 'http://127.0.0.1:39103', GAME_ROOM_PARKS_ENABLED: '0' });
  const entries = [{ id: 'direct', origin: settings.origin, basePath: '/' }, { id: 'agora', origin: 'http://127.0.0.1:39104', basePath: '/game/' }];
  const adapter = new MemoryAdapter(), storage = new EncryptedStore(adapter, randomBytes(32)), provider = new MockProvider(settings);
  let identityCalls = 0;
  for (const method of ['begin', 'complete', 'check']) provider[method] = async () => { identityCalls++; throw new Error('Hub must not use identity'); };
  const runtime = createRuntime(settings, { storage, provider, roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  await runtime.rooms.ready; await runtime.wordbankReady;
  const server = createUnifiedServer({ ...runtime, entries }); t.after(() => server.shutdown());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const before = structuredClone([...adapter.records]);
  const paths = new Set(['practice-hub.html', 'practice-hub.mjs', 'practice-hub.css', 'games/catalog.mjs', ...presentationCatalog.list().flatMap(game => [game.practicePage, ...game.practiceLinks.map(link => link.page.split('?')[0])]).filter(Boolean)]);
  for (const entry of entries) for (const file of paths) {
    const response = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path: `${entry.basePath}${file}`, headers: { Host: new URL(entry.origin).host } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, source: Buffer.concat(chunks).toString('utf8') })); response.on('error', reject);
      }); request.on('error', reject);
    });
    assert.equal(response.status, 200, `${entry.id}/${file}`); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['set-cookie'], undefined); assert.equal(response.headers.location, undefined);
    assert.equal(response.source, await readFile(new URL(`./${file}`, import.meta.url), 'utf8'), `${entry.id}/${file}`);
  }
  assert.equal(identityCalls, 0); assert.deepEqual([...adapter.records], before);
});
