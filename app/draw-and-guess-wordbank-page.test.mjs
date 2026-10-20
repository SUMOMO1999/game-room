import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, webcrypto, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createWordbankPageController, previewWordbankImport, mountWordbankPage } from './games/draw-and-guess/wordbank-page.mjs';
import { canonicalWordbankRequest, canonicalWordbankRequestFingerprint, createWordbankRequestId } from './games/draw-and-guess/request-intent.mjs';
import { EncryptedStore, MemoryAdapter, identityKey } from '../server/storage.mjs';
import { createDrawAndGuessWordbank } from '../server/content/draw-and-guess-wordbank.mjs';

const identity = index => identityKey('urn:wordbank-page-test', String(index));
const actor = index => ({ userKey: identity(index), member: true, displayName: '虚构伙伴' });
const code = expected => error => error.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let turn = 0; turn < 8; turn++) await new Promise(resolve => setImmediate(resolve)); };
function sessionStorage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }; }
function fixture(t) {
  let time = 1791300000000, generation = 0, account = { authenticated: true, verification: 'verified', userKey: identity(0) };
  const now = () => time, storage = new EncryptedStore(new MemoryAdapter({ now }), randomBytes(32), now);
  const service = createDrawAndGuessWordbank({ storage, now }), browserStorage = sessionStorage(), calls = [];
  t.after(() => storage.close());
  const requestId = () => createWordbankRequestId(time++);
  async function request(path, options = {}) {
    calls.push({ path, ...structuredClone(options) });
    const current = { userKey: account.userKey, member: true, displayName: '虚构伙伴' }, url = new URL(path, 'http://test.invalid');
    if (url.pathname === '/api/wordbanks') return options.method === 'POST' ? service.create(current, options.body) : service.list(current, { limit: 100 });
    const receipt = /^\/api\/wordbank-requests\/([^/]+)$/.exec(url.pathname);
    if (receipt) return service.queryRequest(current, { requestId: receipt[1], fingerprint: url.searchParams.get('fingerprint') });
    const [, id, operation] = /^\/api\/wordbanks\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname) || [];
    if (!operation) return service.get(current, id);
    const method = { changes: 'change', validate: 'preview', publish: 'publish', 'restore-preview': 'previewRestore', restore: 'restore', copy: 'copy' }[operation];
    return operation === 'copy' ? service.copy(current, { ...options.body, sourcePackId: id }) : service[method](current, id, options.body);
  }
  const model = wrapper => createWordbankPageController({ request: wrapper || request, getAccount: () => account, getGeneration: () => generation,
    storage: browserStorage, now, cryptoRef: webcrypto });
  return { service, request, model, calls, requestId, browserStorage, now,
    account: () => account, generation: () => generation,
    advance(milliseconds) { time += milliseconds; },
    identity(index, authenticated = true, verification = authenticated ? 'verified' : 'anonymous') { generation++; account = { authenticated, verification, userKey: authenticated ? identity(index) : null }; } };
}

test('public request fingerprints match server canonical hashing, preserving normalized original input and target', async () => {
  const input = { requestId: 'abc-synthetic', expectedDraftRevision: 3, operations: [{ type: 'word.add', answer: '　Cafe\u0301　', aliases: ['咖啡'], category: 'custom', difficulty: 'normal', tags: ['饮料'] }] };
  const actual = await canonicalWordbankRequestFingerprint('change', 'dg-pack-example', input, webcrypto);
  assert.equal(actual, createHash('sha256').update(canonicalWordbankRequest('change', 'dg-pack-example', input)).digest('hex'));
  assert.equal(actual, await canonicalWordbankRequestFingerprint('change', 'dg-pack-example', { ...input, requestId: 'other', operations: [{ ...input.operations[0], answer: 'Café' }] }, webcrypto));
  assert.notEqual(actual, await canonicalWordbankRequestFingerprint('change', 'dg-pack-other', input, webcrypto));
  assert.notEqual(actual, await canonicalWordbankRequestFingerprint('publish', 'dg-pack-example', input, webcrypto));
  assert.match(createWordbankRequestId(1791300000000, () => 'fixed-original-intent'), /^[0-9a-z]+-fixed-original-intent$/);
});

test('bulk preview identifies exact row ambiguity and malicious input, never allows partial successful rows to be saved', () => {
  const options = { category: 'custom', difficulty: 'easy', createId: (() => { let count = 0; return () => `dg-test-${count++}`; })() };
  const duplicate = previewWordbankImport('熊猫｜大熊猫\n大 熊 猫\n纸船', options);
  assert.equal(duplicate.valid, false); assert.equal(duplicate.errors[0].row, 2); assert.equal(duplicate.operations.length, 2);
  const malicious = previewWordbankImport('＜script＞\n纸\u200b船\n风车', options);
  assert.equal(malicious.valid, false); assert.deepEqual(malicious.errors.map(error => error.row), [1, 2]);
  assert.equal(previewWordbankImport('纸船｜纸 船', options).valid, false);
  assert.equal(previewWordbankImport('熊猫｜大熊猫\n纸船｜折纸小船', options).valid, true);
  assert.equal(previewWordbankImport('纸船', { ...options, words: [{ answer: '纸船', aliases: [], status: 'retired' }] }).valid, true);
  assert.equal(previewWordbankImport('纸船', { ...options, words: [{ answer: '纸船', aliases: [], status: 'reviewed' }] }).valid, false);
  assert.equal(previewWordbankImport('字'.repeat(65537), options).valid, false);
});

test('controller uses actual trusted content service for complete save, read-only preview and explicit publication without client identity', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '测试库', visibility: 'private' }), model = f.model();
  await model.openPack(created.packId); model.queue([{ type: 'word.add', answer: '纸船', aliases: ['折纸小船'], category: 'custom', difficulty: 'easy', tags: [] }]);
  await model.save(); assert.equal(model.snapshot().operations.length, 0);
  await model.validate(); assert.equal(model.snapshot().preview.report.valid, true); assert.equal(model.snapshot().pack.publishedHead, null);
  await model.publish(); assert.equal(model.snapshot().pack.publishedHead, 1);
  for (const call of f.calls.filter(call => call.method === 'POST')) {
    assert.equal('userKey' in call.body, false); assert.equal('ownerKey' in call.body, false); assert.equal('actor' in call.body, false);
  }
});

test('in-flight save fences later operations; switching to a new package never silently carries another draft', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '测试库', visibility: 'private' }), gate = deferred();
  const model = f.model(async (path, options) => { if (path.endsWith('/changes')) await gate.promise; return f.request(path, options); });
  await model.openPack(created.packId); model.queue([{ type: 'word.add', answer: '纸船', category: 'custom', difficulty: 'easy' }]);
  assert.throws(() => model.create({ name: '第二库', visibility: 'private' }), code('UNSAVED_EDITS'));
  assert.throws(() => model.copy({ name: '副本', visibility: 'private', sourceVersion: 1 }), code('UNSAVED_EDITS'));
  const saving = model.save(); await settle();
  assert.throws(() => model.queue([{ type: 'word.add', answer: '风车', category: 'custom', difficulty: 'easy' }]), code('OPERATION_BUSY'));
  gate.resolve(); await saving; assert.deepEqual(model.snapshot().pack.draft.words.map(word => word.answer), ['纸船']);
});

test('a confirmed successful write remains confirmed when only its subsequent refresh fails', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '测试库', visibility: 'private' });
  let committed = false;
  const model = f.model(async (path, options) => {
    if (committed && !options?.method && path.includes(created.packId)) throw Object.assign(new Error('Synthetic refresh unavailable'), { status: 503 });
    const result = await f.request(path, options); if (path.endsWith('/changes')) committed = true; return result;
  });
  await model.openPack(created.packId); model.queue([{ type: 'word.add', answer: '纸船', category: 'custom', difficulty: 'easy' }]);
  await assert.rejects(model.save()); assert.equal(model.snapshot().pending, null); assert.equal(model.snapshot().operations.length, 0);
  const recreated = f.model(); assert.equal(recreated.snapshot().pending, null);
  assert.equal((await f.service.get(actor(0), created.packId)).draft.words.length, 1);
});

test('lost successful save is queried from persisted original intent after page recreation, with one POST and no new ID', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '测试库', visibility: 'private' });
  const model = f.model(async (path, options) => { const result = await f.request(path, options); if (path.endsWith('/changes')) throw new Error('Synthetic lost successful response'); return result; });
  await model.openPack(created.packId); model.queue([{ type: 'word.add', answer: '纸船', category: 'custom', difficulty: 'easy' }]);
  await assert.rejects(model.save()); const original = model.snapshot().pending;
  assert.ok(original?.body.requestId); model.destroy(); const recreated = f.model();
  assert.equal(recreated.snapshot().pending.body.requestId, original.body.requestId);
  await recreated.queryPending(); assert.equal(recreated.snapshot().pending, null); assert.equal(recreated.snapshot().pack.draft.words.length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/changes')).length, 1);
  assert.ok(f.calls.some(call => call.path.includes(original.body.requestId) && call.path.includes(`fingerprint=${original.fingerprint}`)));
});

test('unconfirmed failed write remains original-query-only across repeated checks and page recreation', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '测试库', visibility: 'private' });
  let writes = 0;
  const model = f.model((path, options) => { if (path.endsWith('/changes')) { writes++; throw new Error('Synthetic unknown before delivery'); } return f.request(path, options); });
  await model.openPack(created.packId); model.queue([{ type: 'word.add', answer: '纸船', category: 'custom', difficulty: 'easy' }]);
  await assert.rejects(model.save()); const requestId = model.snapshot().pending.body.requestId;
  await model.queryPending(); await model.queryPending(); assert.equal(model.snapshot().pending.body.requestId, requestId);
  await assert.rejects(model.save(), code('PENDING_INTENT')); assert.equal(writes, 1);
  const recreated = f.model(); await recreated.queryPending(); assert.equal(recreated.snapshot().pending.body.requestId, requestId);
  assert.equal((await f.service.get(actor(0), created.packId)).draft.words.length, 0);
});

test('an expired unknown intent requires fresh inspection and two explicit manual confirmations before any new write', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '测试库', visibility: 'private' });
  const model = f.model((path, options) => path.endsWith('/changes') ? Promise.reject(new Error('Synthetic unknown')) : f.request(path, options));
  await model.openPack(created.packId); model.queue([{ type: 'word.add', answer: '纸船', category: 'custom', difficulty: 'easy' }]);
  await assert.rejects(model.save()); const original = model.snapshot().pending.body.requestId;
  assert.throws(() => model.releaseExpiredIntent({ confirmed: true }), code('MANUAL_CONFIRMATION_REQUIRED'));
  f.advance(24 * 60 * 60 * 1000 + 1); await assert.rejects(model.queryPending(), code('REQUEST_EXPIRED'));
  assert.throws(() => model.releaseExpiredIntent({ confirmed: true }), code('MANUAL_CONFIRMATION_REQUIRED'));
  await model.inspectExpiredIntent(); assert.throws(() => model.releaseExpiredIntent(), code('MANUAL_CONFIRMATION_REQUIRED'));
  model.releaseExpiredIntent({ confirmed: true }); assert.equal(model.snapshot().pending, null); assert.equal(model.snapshot().operations[0].answer, '纸船');
  assert.equal(model.snapshot().unconfirmedIntent.body.requestId, original); model.destroy();
  const recreated = f.model(); await assert.rejects(recreated.save(), code('NEW_INTENT_CONFIRMATION_REQUIRED'));
  assert.equal((await f.service.get(actor(0), created.packId)).draft.words.length, 0);
  await recreated.save({ confirmedNewIntent: true }); assert.equal(recreated.snapshot().pack.draft.words[0].answer, '纸船');
  assert.notEqual(f.calls.findLast(call => call.path.endsWith('/changes')).body.requestId, original);
});

test('draft conflict preserves only explicit local operations and requires a manual adoption of the current revision', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '共编库', visibility: 'shared' }), model = f.model();
  await model.openPack(created.packId); model.queue([{ type: 'word.add', id: 'dg-local', answer: '纸船', category: 'custom', difficulty: 'easy' }]);
  await f.service.change(actor(1), created.packId, { requestId: f.requestId(), expectedDraftRevision: 0, operations: [{ type: 'word.add', id: 'dg-other', answer: '风车', category: 'custom', difficulty: 'easy' }] });
  await assert.rejects(model.save(), code('DRAFT_CONFLICT'));
  assert.equal(model.snapshot().operations[0].answer, '纸船'); assert.equal(model.snapshot().serverConflict.draftRevision, 1); assert.equal(model.snapshot().pending, null);
  model.mergeConflict(); await model.save(); assert.deepEqual(model.snapshot().pack.draft.words.map(word => word.answer), ['风车', '纸船']);
});

test('late private read and preview after an account switch cannot paint or mutate the new identity', async t => {
  const f = fixture(t), privatePack = await f.service.create(actor(0), { requestId: f.requestId(), name: '仅甲可读', visibility: 'private' });
  const slow = deferred(), model = f.model(path => path.includes(privatePack.packId) ? slow.promise : f.request(path));
  const read = model.openPack(privatePack.packId); f.identity(1); model.identityChanged(); slow.resolve(await f.service.get(actor(0), privatePack.packId));
  await assert.rejects(read, error => error.name === 'AbortError'); assert.equal(model.snapshot().pack, null);
  assert.equal(model.snapshot().authenticated, true); assert.equal(JSON.stringify(model.snapshot()).includes('仅甲可读'), false);
  f.identity(0); const next = f.model(); await next.openPack(privatePack.packId);
  const preview = deferred(), slower = f.model((path, options) => path.endsWith('/validate') ? preview.promise : f.request(path, options));
  await slower.openPack(privatePack.packId); const running = slower.validate(); f.identity(1); slower.identityChanged();
  preview.resolve({ report: { valid: true }, content: { words: [{ answer: '甲的秘密' }] } });
  await assert.rejects(running, error => error.name === 'AbortError'); assert.equal(slower.snapshot().preview, null); assert.equal(slower.snapshot().pack, null);
});

test('suspended identity conceals private content while the original account can recover its unsubmitted edits', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '甲的私库', visibility: 'private' }), model = f.model();
  await model.openPack(created.packId); model.queue([{ type: 'word.add', answer: '秘密纸船', category: 'custom', difficulty: 'normal' }]);
  f.identity(0, false, 'paused'); model.identityChanged(); assert.equal(model.snapshot().pack, null); assert.deepEqual(model.snapshot().operations, []);
  f.identity(0); model.identityChanged(); assert.equal(model.snapshot().operations[0].answer, '秘密纸船');
  f.identity(1); model.identityChanged(); assert.equal(model.snapshot().pack, null); assert.deepEqual(model.snapshot().operations, []);
  f.identity(0); model.identityChanged(); assert.equal(model.snapshot().pack, null); assert.deepEqual(model.snapshot().operations, []);
});

test('real logout clears raw private edits but leaves only the original receipt metadata for the same owner to query', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '甲的私库', visibility: 'private' });
  const model = f.model(async (path, options) => { const result = await f.request(path, options); if (path.endsWith('/changes')) throw new Error('Synthetic lost response'); return result; });
  await model.openPack(created.packId); model.queue([{ type: 'word.add', answer: '秘密纸船', category: 'custom', difficulty: 'normal' }]);
  await assert.rejects(model.save()); const original = model.snapshot().pending.body.requestId;
  f.identity(0, false); model.identityChanged();
  assert.equal([...f.browserStorage.values.values()].some(value => value.includes('秘密纸船') || value.includes('甲的私库')), false);
  model.destroy(); f.identity(1); const other = f.model(); assert.equal(other.snapshot().pending, null); other.destroy();
  f.identity(0); const owner = f.model(); assert.equal(owner.snapshot().pack, null); assert.equal(owner.snapshot().pending.body.requestId, original);
  assert.deepEqual(Object.keys(owner.snapshot().pending.body), ['requestId']); await owner.queryPending();
  assert.equal(owner.snapshot().pack.draft.words[0].answer, '秘密纸船'); assert.equal(f.calls.filter(call => call.path.endsWith('/changes')).length, 1);
});

test('browser UI builds all untrusted word, alias, pack, actor and error content as literal text', async () => {
  class Element extends EventTarget {
    constructor(tag, document) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.classList = { add() {} }; }
    set textContent(value) { this._text = String(value); this.children = []; } get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set innerHTML(value) { throw new Error(`Unsafe HTML sink: ${value}`); }
    append(...nodes) { for (const node of nodes) { if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1); node.parentNode = this; this.children.push(node); } }
    insertBefore(node, reference) { if (node === reference) return node; if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1); node.parentNode = this; const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, node); return node; }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this._text = ''; this.children = []; this.append(...nodes); }
    setAttribute() {} querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tagName.toLowerCase() === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
    focus() {}
  }
  const document = { defaultView: { confirm: () => false }, createElement(tag) { return new Element(tag, this); } };
  const root = new Element('div', document); let account = { authenticated: true, verification: 'verified', userKey: identity(0) }, generation = 0;
  const attack = '<img src=x onerror=alert(1)><script>evil()</script>';
  const pack = { id: 'dg-demo', name: attack, visibility: 'private', draftRevision: 1, publishedHead: null, retired: false, history: [], versions: [],
    draft: { categories: [{ id: 'custom', name: attack, status: 'active' }], words: [{ id: 'dg-word', answer: attack, aliases: [attack], tags: [], category: 'custom', difficulty: 'hard', status: 'draft', hintLength: 3 }] } };
  const view = mountWordbankPage(root, { getAccount: () => account, getGeneration: () => generation, onAccountChange: () => () => {}, watchLifecycle: false,
    request: path => Promise.resolve(path.includes('dg-demo') ? pack : { packs: [pack] }), cryptoRef: webcrypto, storage: sessionStorage() });
  await settle(); await view.controller.openPack('dg-demo');
  assert.ok(root.textContent.includes(attack)); assert.equal(root.querySelectorAll('script').length, 0); assert.equal(root.querySelectorAll('img').length, 0);
  const answer = root.querySelectorAll('input').find(node => node.placeholder === '例如：自行车'); answer.value = attack; answer.dispatchEvent(new Event('input'));
  account = { authenticated: true, verification: 'verified', userKey: identity(1) }; generation++; view.controller.identityChanged();
  assert.equal(root.textContent.includes(attack), false); assert.equal(root.querySelectorAll('input').some(node => node.value.includes(attack)), false);
  account = { authenticated: true, verification: 'verified', userKey: identity(0) }; generation++; view.controller.identityChanged();
  assert.equal(answer.value, '');
  view.destroy();
});

test('public page ships no seed corpus, uses account fences and allows scrolling above the software keyboard', () => {
  const source = readFileSync(new URL('./games/draw-and-guess/wordbank-page.mjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./games/draw-and-guess/wordbank.css', import.meta.url), 'utf8');
  assert.equal(/server\/content|DRAW_AND_GUESS_SEED|innerHTML|insertAdjacentHTML/u.test(source), false);
  assert.ok(source.includes('accountGeneration')); assert.ok(source.includes("cache: 'no-store'"));
  assert.ok(css.includes('min-height:44px')); assert.ok(css.includes('font-size:16px')); assert.ok(css.includes('safe-area-inset-bottom'));
  assert.equal(/\.wordbank-page\s*\{[^}]*overflow\s*:\s*hidden/u.test(css), false);
});

// This minimal document drives the shipped mount and controller, without a browser
// or production identity. Browser geometry/materials are checked separately.
function wordbankDocument({ confirm = () => true } = {}) {
  class Element extends EventTarget {
    constructor(tag, document) {
      super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.className = ''; this.attributes = new Map();
      this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].filter(Boolean).join(' '); } };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    append(...nodes) { for (const node of nodes) { if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1); node.parentNode = this; this.children.push(node); } }
    insertBefore(node, reference) { if (node === reference) return node; if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1); node.parentNode = this; const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, node); return node; }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this._text = ''; this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tagName.toLowerCase() === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
    focus() { this.ownerDocument.activeElement = this; }
  }
  const document = { defaultView: { confirm }, createElement(tag) { return new Element(tag, this); } };
  const root = new Element('main', document);
  const all = () => { const visit = node => [node, ...node.children.flatMap(visit)]; return visit(root); };
  return { root, document, all, byClass: name => all().filter(node => node.className.split(' ').includes(name)),
    button: name => all().find(node => node.tagName === 'BUTTON' && node.textContent === name),
    input: placeholder => all().find(node => node.tagName === 'INPUT' && node.placeholder === placeholder),
    async click(node) { assert.ok(node); assert.equal(node.disabled, false); node.dispatchEvent(new Event('click')); await settle(); } };
}

test('wordbank workbench paginates 5600 words, filters all content, and resets page without rendering thousands of rows', async () => {
  const dom = wordbankDocument(), account = { authenticated: true, verification: 'verified', userKey: identity(0) };
  const pack = { id: 'dg-large-synthetic', name: '虚构大词库', visibility: 'shared', draftRevision: 1, publishedHead: 1, retired: false, versions: [], history: [],
    draft: { categories: [{ id: 'first', name: '测试分类甲', status: 'active' }, { id: 'second', name: '测试分类乙', status: 'active' }],
      words: Array.from({ length: 5600 }, (_, index) => ({ id: `dg-synthetic-${index}`, answer: `虚构词${String(index).padStart(4, '0')}`, aliases: index === 5599 ? ['虚构尾词别称'] : [], tags: [], category: index % 2 ? 'second' : 'first', difficulty: index % 3 ? 'normal' : 'easy', status: 'reviewed', hintLength: 7 })) } };
  const view = mountWordbankPage(dom.root, { getAccount: () => account, getGeneration: () => 0, onAccountChange: () => () => {}, watchLifecycle: false,
    request: async path => path.includes(pack.id) ? structuredClone(pack) : { packs: [pack] }, cryptoRef: webcrypto, storage: sessionStorage() });
  try {
    await settle(); await view.controller.openPack(pack.id);
    assert.equal(dom.byClass('wordbank-word-row').length, 30);
    assert.equal(dom.button('上一页').disabled, true);
    assert.ok(dom.byClass('wordbank-pager')[0].textContent.includes('5600词 · 1 / 187页'));
    await dom.click(dom.button('下一页'));
    assert.equal(dom.byClass('wordbank-term')[0].children[0].textContent, '虚构词0030');
    assert.equal(dom.button('上一页').disabled, false);
    const search = dom.input('搜索正文、别名或标签'); search.value = '虚构尾词别称'; search.dispatchEvent(new Event('input'));
    assert.equal(dom.byClass('wordbank-word-row').length, 1);
    assert.ok(dom.byClass('wordbank-pager')[0].textContent.includes('1词 · 1 / 1页'));
    assert.equal(dom.button('下一页').disabled, true);
    await dom.click(dom.button('编辑'));
    assert.equal(dom.document.activeElement, dom.input('例如：自行车'));
    assert.equal(dom.input('例如：自行车').value, '虚构词5599');
    assert.equal(dom.byClass('wordbank-bulk')[0].hidden, true);
    assert.ok(dom.byClass('wordbank-composer')[0].textContent.includes('修改词语'));
    assert.equal(dom.byClass('wordbank-management')[0].children.every(node => !node.open), true);
    search.value = '没有这个词'; search.dispatchEvent(new Event('input'));
    assert.equal(dom.byClass('wordbank-word-row').length, 0); assert.equal(dom.byClass('wordbank-empty')[0].hidden, false);
  } finally { view.destroy(); }
});

test('one composer preserves both input modes and drives real service save, preview and explicit publish from adjacent actions', async t => {
  const f = fixture(t), dom = wordbankDocument();
  const created = await f.service.create(actor(0), { requestId: f.requestId(), name: '虚构工作台验收', visibility: 'private' });
  const view = mountWordbankPage(dom.root, { request: f.request, getAccount: f.account, getGeneration: f.generation, now: f.now,
    onAccountChange: () => () => {}, watchLifecycle: false, cryptoRef: webcrypto, storage: f.browserStorage });
  t.after(() => view.destroy()); await settle(); await view.controller.openPack(created.packId);
  assert.equal(dom.button('保存草稿').disabled, true); assert.equal(dom.button('确认发布当前预览').hidden, true);
  const answer = dom.input('例如：自行车'); answer.value = '纸船'; answer.dispatchEvent(new Event('input'));
  await dom.click(dom.button('批量录入'));
  const bulk = dom.byClass('wordbank-bulk')[0].querySelectorAll('textarea')[0]; bulk.value = '风车'; bulk.dispatchEvent(new Event('input'));
  await dom.click(dom.button('逐个添加')); assert.equal(answer.value, '纸船');
  const single = dom.byClass('wordbank-editor')[0], bulkSection = dom.byClass('wordbank-bulk')[0];
  const difficulty = dom.byClass('wordbank-editor-fields')[0].querySelectorAll('select')[1]; difficulty.value = 'easy'; difficulty.dispatchEvent(new Event('input'));
  await dom.click(single.querySelectorAll('button').find(node => node.textContent === '加入待保存'));
  assert.equal(view.controller.snapshot().operations[0].answer, '纸船');
  assert.equal(dom.button('保存草稿').disabled, false); assert.equal(dom.button('校验并预览发布').disabled, true);
  await dom.click(dom.button('批量录入')); assert.equal(bulk.value, '风车');
  await dom.click(dom.button('预览这批词'));
  await dom.click(bulkSection.querySelectorAll('button').find(node => node.textContent === '加入待保存'));
  assert.equal(view.controller.snapshot().operations.length, 2);
  assert.ok(dom.byClass('wordbank-save-actions')[0].textContent.includes('保存草稿'));
  await dom.click(dom.button('保存草稿')); assert.equal(view.controller.snapshot().operations.length, 0);
  assert.deepEqual((await f.service.get(actor(0), created.packId)).draft.words.map(word => word.answer), ['纸船', '风车']);
  await dom.click(dom.button('校验并预览发布')); assert.equal(view.controller.snapshot().preview.report.valid, true);
  assert.equal(view.controller.snapshot().pack.publishedHead, null); assert.equal(dom.button('确认发布当前预览').hidden, false);
  await dom.click(dom.button('确认发布当前预览')); assert.equal(view.controller.snapshot().pack.publishedHead, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/publish')).length, 1);
});


test('mobile task navigation keeps filters, unsaved text and bulk input while editing opens optional values and saving keeps the task', async t => {
  const f = fixture(t), dom = wordbankDocument();
  const created = await f.service.create(actor(0), { requestId: f.requestId(), name: '虚构手机词库', visibility: 'private' });
  await f.service.change(actor(0), created.packId, { requestId: f.requestId(), expectedDraftRevision: 0, operations: [{ type: 'word.add', id: 'dg-mobile-original', answer: '松鼠', aliases: ['小松鼠'], tags: ['林间'], category: 'custom', difficulty: 'easy' }] });
  const view = mountWordbankPage(dom.root, { request: f.request, getAccount: f.account, getGeneration: f.generation, now: f.now,
    onAccountChange: () => () => {}, watchLifecycle: false, cryptoRef: webcrypto, storage: f.browserStorage });
  t.after(() => view.destroy()); await settle(); await view.controller.openPack(created.packId);
  const workspace = dom.byClass('wordbank-workspace')[0], library = dom.byClass('wordbank-library')[0];
  assert.equal(workspace.dataset.mobileView, 'browse'); assert.equal(library.dataset.open, 'false');
  assert.equal(dom.button('找词').getAttribute('aria-pressed'), 'true');
  await dom.click(dom.button('添加')); assert.equal(workspace.dataset.mobileView, 'compose');
  const difficulty = dom.byClass('wordbank-editor-fields')[0].querySelectorAll('select')[1]; difficulty.value = 'easy'; difficulty.dispatchEvent(new Event('input'));
  const answer = dom.input('例如：自行车'); answer.value = '纸风车'; answer.dispatchEvent(new Event('input'));
  await dom.click(dom.button('批量录入')); const bulk = dom.byClass('wordbank-bulk')[0].querySelectorAll('textarea')[0];
  bulk.value = '纸船'; bulk.dispatchEvent(new Event('input'));
  await dom.click(dom.button('找词')); const search = dom.input('搜索正文、别名或标签'); search.value = '小松鼠'; search.dispatchEvent(new Event('input'));
  assert.equal(workspace.dataset.mobileView, 'browse'); assert.equal(dom.byClass('wordbank-word-row').length, 1);
  await dom.click(dom.button('添加')); assert.equal(bulk.value, '纸船');
  await dom.click(dom.button('逐个添加')); assert.equal(answer.value, '纸风车');
  await dom.click(dom.byClass('wordbank-editor')[0].querySelectorAll('button').find(node => node.textContent === '加入待保存'));
  await dom.click(dom.button('找词')); await dom.click(dom.button('编辑'));
  assert.equal(workspace.dataset.mobileView, 'compose'); assert.equal(dom.document.activeElement, answer);
  assert.equal(dom.byClass('wordbank-extra-fields')[0].open, true); assert.equal(dom.input('例如：脚踏车｜自行車').value, '小松鼠');
  assert.equal(dom.input('维护标签，用｜分开').value, '林间');
  await dom.click(dom.button('找词')); await dom.click(dom.button('保存草稿'));
  assert.equal(workspace.dataset.mobileView, 'browse'); assert.equal(search.value, '小松鼠');
  assert.equal(view.controller.snapshot().form.answer, '松鼠'); assert.equal(view.controller.snapshot().bulk, '纸船');
  assert.equal(view.controller.snapshot().operations.length, 0); assert.equal(view.controller.snapshot().pack.draft.words.length, 2);
  assert.equal(dom.button('确认发布当前预览').hidden, true, 'Saving still does not publish');
});

test('single and bulk modes move one live category/difficulty group outside the hidden editor and save current bulk choices', async t => {
  const f = fixture(t), dom = wordbankDocument();
  const created = await f.service.create(actor(0), { requestId: f.requestId(), name: '虚构批量控件验收', visibility: 'private' });
  await f.service.change(actor(0), created.packId, { requestId: f.requestId(), expectedDraftRevision: 0,
    operations: [{ type: 'category.add', id: 'dg-mobile-alternate', name: '另一分类' }] });
  const view = mountWordbankPage(dom.root, { request: f.request, getAccount: f.account, getGeneration: f.generation, now: f.now,
    onAccountChange: () => () => {}, watchLifecycle: false, cryptoRef: webcrypto, storage: f.browserStorage });
  t.after(() => view.destroy()); await settle(); await view.controller.openPack(created.packId); await dom.click(dom.button('添加'));
  const fields = dom.byClass('wordbank-editor-fields')[0], [category, difficulty] = fields.querySelectorAll('select');
  const single = dom.byClass('wordbank-editor')[0], bulkSection = dom.byClass('wordbank-bulk')[0];
  assert.equal(fields.parentNode, dom.byClass('wordbank-editor-inputs')[0]);
  await dom.click(dom.button('批量录入'));
  assert.equal(single.hidden, true); assert.equal(bulkSection.hidden, false);
  assert.equal(fields.parentNode, bulkSection); assert.equal(bulkSection.children[0], fields);
  assert.equal(dom.byClass('wordbank-editor-fields').length, 1, 'The same fields are moved, never cloned');
  for (let ancestor = fields; ancestor; ancestor = ancestor.parentNode) assert.equal(ancestor.hidden, false, 'The bulk controls have no hidden DOM ancestor');
  category.value = 'dg-mobile-alternate'; category.dispatchEvent(new Event('input'));
  difficulty.value = 'hard'; difficulty.dispatchEvent(new Event('input'));
  const bulk = bulkSection.querySelectorAll('textarea')[0]; bulk.value = '旋转木马'; bulk.dispatchEvent(new Event('input'));
  await dom.click(dom.button('逐个添加')); assert.equal(fields.parentNode, dom.byClass('wordbank-editor-inputs')[0]);
  assert.equal(category.value, 'dg-mobile-alternate'); assert.equal(difficulty.value, 'hard');
  await dom.click(dom.button('批量录入')); assert.equal(fields.parentNode, bulkSection);
  await dom.click(dom.button('预览这批词')); await dom.click(bulkSection.querySelectorAll('button').find(node => node.textContent === '加入待保存'));
  assert.equal(view.controller.snapshot().operations[0].category, 'dg-mobile-alternate');
  assert.equal(view.controller.snapshot().operations[0].difficulty, 'hard');
  await dom.click(dom.button('保存草稿'));
  const [saved] = (await f.service.get(actor(0), created.packId)).draft.words;
  assert.equal(saved.answer, '旋转木马'); assert.equal(saved.category, 'dg-mobile-alternate'); assert.equal(saved.difficulty, 'hard');
});

test('page recreation restores optional aliases and tags visibly, while a recovered bulk-only draft retains reachable live fields', async t => {
  const f = fixture(t), created = await f.service.create(actor(0), { requestId: f.requestId(), name: '虚构输入恢复验收', visibility: 'private' });
  const options = { request: f.request, getAccount: f.account, getGeneration: f.generation, now: f.now,
    onAccountChange: () => () => {}, watchLifecycle: false, cryptoRef: webcrypto, storage: f.browserStorage };
  const saved = f.model(); await saved.openPack(created.packId);
  saved.setBuffer({ form: { editingId: null, answer: '小纸船', aliases: '折纸船', tags: '纸艺', category: 'custom', difficulty: 'normal' } }); saved.destroy();
  const dom = wordbankDocument(), view = mountWordbankPage(dom.root, options); await settle();
  await dom.click(dom.button('添加'));
  assert.equal(dom.input('例如：自行车').value, '小纸船'); assert.equal(dom.input('例如：脚踏车｜自行車').value, '折纸船');
  assert.equal(dom.input('维护标签，用｜分开').value, '纸艺'); assert.equal(dom.byClass('wordbank-extra-fields')[0].open, true);
  view.controller.setBuffer({ form: { editingId: null, answer: '', aliases: '', tags: '', category: 'custom', difficulty: 'hard' }, bulk: '折纸风车' }); view.destroy();
  const bulkDom = wordbankDocument(), restored = mountWordbankPage(bulkDom.root, options); t.after(() => restored.destroy()); await settle();
  await bulkDom.click(bulkDom.button('添加'));
  const bulkSection = bulkDom.byClass('wordbank-bulk')[0], fields = bulkDom.byClass('wordbank-editor-fields')[0];
  assert.equal(bulkSection.hidden, false); assert.equal(bulkDom.byClass('wordbank-editor')[0].hidden, true);
  assert.equal(fields.parentNode, bulkSection); assert.equal(fields.querySelectorAll('select')[1].value, 'hard');
  assert.equal(bulkSection.querySelectorAll('textarea')[0].value, '折纸风车');
  assert.equal(bulkDom.byClass('wordbank-workspace')[0].dataset.mobileView, 'compose');
  for (let ancestor = fields; ancestor; ancestor = ancestor.parentNode) assert.equal(ancestor.hidden, false);
});
