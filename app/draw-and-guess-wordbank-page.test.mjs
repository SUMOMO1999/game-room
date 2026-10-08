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
    append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
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
