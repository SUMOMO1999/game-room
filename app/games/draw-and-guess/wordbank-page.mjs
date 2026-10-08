import { gamePath, entryStorageKey } from '../../entry-path.mjs';
import { accountState, accountGeneration, onAccountChange, loadAccount, watchAccountLifecycle, reportAuthFailure } from '../../account-client.mjs';
import { normalizeDrawAndGuessAnswer, normalizeDrawAndGuessGuess } from './matcher.mjs';
import { createWordbankRequestId, canonicalWordbankRequestFingerprint } from './request-intent.mjs';

const copy = value => structuredClone(value);
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const requestUnknown = error => !error?.status || error.status >= 500 || error.status === 401 || ['REQUEST_UNKNOWN', 'UNKNOWN_RESULT'].includes(error.code);

export function previewWordbankImport(value, { category, difficulty = 'normal', words = [], createId = () => `dg-word-${globalThis.crypto.randomUUID()}` } = {}) {
  const lines = String(value).split(/\r?\n/u), errors = [], operations = [], terms = new Map();
  if (new TextEncoder().encode(String(value)).length > 65536) return { valid: false, errors: [{ row: 0, message: '内容过长，请分批输入。' }], operations: [] };
  for (const word of words.filter(word => word.status !== 'retired')) for (const answer of [word.answer, ...word.aliases]) terms.set(normalizeDrawAndGuessGuess(answer), word.answer);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      if (!category || !['easy', 'normal', 'hard'].includes(difficulty)) fail('请选择分类与难度。');
      const [answer, ...aliases] = line.split(/[|｜]/u).map(normalizeDrawAndGuessAnswer);
      if (aliases.length > 8) fail('每词至多8个认可别名。');
      const local = new Set();
      for (const term of [answer, ...aliases]) {
        const normalized = normalizeDrawAndGuessGuess(term);
        if (!normalized) fail('规范化后没有可匹配的文字。');
        if (local.has(normalized)) fail('同一词的正文或别名重复。');
        if (terms.has(normalized)) fail(`与“${terms.get(normalized)}”的正文或别名重合。`);
        local.add(normalized);
      }
      for (const normalized of local) terms.set(normalized, answer);
      operations.push({ type: 'word.add', id: createId(), category, answer, aliases, difficulty, tags: [] });
    } catch (error) { errors.push({ row: index + 1, message: error.message }); }
  }
  if (!operations.length && !errors.length) errors.push({ row: 0, message: '请先输入词语。' });
  if (operations.length > 200) errors.push({ row: 0, message: '每批至多200词，请拆成几批分别预览。' });
  return { valid: errors.length === 0, operations, errors };
}

// No request body contains an identity. Current account and its generation fence
// every fetch, parsed body and late error notification.
export async function requestWordbank(path, { method = 'GET', body, signal } = {}) {
  if (signal?.aborted) throw new DOMException('操作已停止。', 'AbortError');
  const epoch = accountGeneration(), account = accountState();
  if (!account.authenticated || account.verification !== 'verified') fail('请先登录棋牌室。', 'MEMBER_REQUIRED');
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer;
  try {
    const operation = (async () => {
      const response = await fetch(gamePath(path), { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-CSRF-Token': account.csrf }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json();
      if (epoch !== accountGeneration() || controller.signal.aborted) throw new DOMException('登录状态已更新。', 'AbortError');
      if (!response.ok) throw Object.assign(new Error(data.error || data.message || '词库操作未完成。'), { status: response.status, code: data.code, details: data.details });
      return data;
    })();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(method === 'GET' ? '词库读取未完成，请重试。' : '操作结果未知，请查询原回执。'), { status: 503, code: 'UNKNOWN_RESULT' })); }, 10000); });
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (epoch !== accountGeneration()) throw new DOMException('登录状态已更新。', 'AbortError');
    if ([401, 503].includes(error.status)) reportAuthFailure(error);
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function createWordbankPageController({ request = requestWordbank, getAccount = accountState, getGeneration = accountGeneration,
  onChange = () => {}, storage = globalThis.sessionStorage, now = Date.now, cryptoRef = globalThis.crypto } = {}) {
  let owner = null, sequence = 0, destroyed = false;
  const buffers = new Map();
  let state = { packs: [], pack: null, operations: [], pending: null, preview: null, restorePreview: null, serverConflict: null,
    busy: false, authenticated: false, message: '', error: null, bulk: '', form: null, pendingExpired: false, pendingInspection: null, manualReconfirmation: false, unconfirmedIntent: null };
  const storageKey = identity => entryStorageKey(`game-room.private-draft.${identity}.wordbank.v1`);
  const recoveryKey = identity => entryStorageKey(`game-room.action-intent.${identity}.wordbank.v1`);
  const draftOwnerKey = entryStorageKey('game-room.wordbank-draft-owner.v1');
  let draftOwner = null;
  try { draftOwner = storage?.getItem?.(draftOwnerKey) || null; } catch {}
  const snapshot = () => copy(state);
  function emit() { if (!destroyed) onChange(snapshot()); }
  const minimalIntent = intent => intent ? { operation: intent.operation, packId: intent.packId,
    fingerprint: intent.fingerprint, body: { requestId: intent.body.requestId } } : null;
  function clearPrivate(identity) {
    buffers.delete(identity);
    try { storage?.removeItem?.(storageKey(identity)); if (draftOwner === identity) storage?.removeItem?.(draftOwnerKey); } catch {}
    if (draftOwner === identity) draftOwner = null;
  }
  function stash() {
    if (!owner) return;
    const value = { pack: state.pack, operations: state.operations, pending: state.pending, bulk: state.bulk, form: state.form,
      manualReconfirmation: state.manualReconfirmation, unconfirmedIntent: state.unconfirmedIntent };
    buffers.set(owner, copy(value));
    draftOwner = owner;
    try {
      storage?.setItem?.(storageKey(owner), JSON.stringify(value)); storage?.setItem?.(draftOwnerKey, owner);
      if (state.pending || state.manualReconfirmation || state.unconfirmedIntent) storage?.setItem?.(recoveryKey(owner), JSON.stringify({
        pending: minimalIntent(state.pending), manualReconfirmation: state.manualReconfirmation, unconfirmedIntent: minimalIntent(state.unconfirmedIntent) }));
      else storage?.removeItem?.(recoveryKey(owner));
    } catch { /* Memory remains fenced to this account. */ }
  }
  function identityChanged() {
    const account = getAccount(), identity = account.authenticated && account.verification === 'verified' ? account.userKey : null;
    if (identity === owner && state.authenticated === Boolean(identity)) return;
    const preserveDraft = !identity && ['paused', 'checking', 'unavailable'].includes(account.verification);
    if (owner) { if (preserveDraft) stash(); else clearPrivate(owner); }
    if (identity) {
      for (const savedIdentity of buffers.keys()) if (savedIdentity !== identity) clearPrivate(savedIdentity);
      if (draftOwner && draftOwner !== identity) clearPrivate(draftOwner);
    } else if (!preserveDraft && draftOwner) clearPrivate(draftOwner);
    ++sequence;
    owner = identity;
    state = { packs: [], pack: null, operations: [], pending: null, preview: null, restorePreview: null, serverConflict: null,
      busy: false, authenticated: Boolean(identity), message: identity ? '' : '登录后才能读取和维护词库。', error: null, bulk: '', form: null,
      pendingExpired: false, pendingInspection: null, manualReconfirmation: false, unconfirmedIntent: null };
    if (identity) {
      let saved = buffers.get(identity);
      if (!saved) { try { saved = JSON.parse(storage?.getItem?.(storageKey(identity)) || 'null'); } catch {} }
      if (saved && typeof saved === 'object') Object.assign(state, { pack: saved.pack ?? null, operations: saved.operations ?? [], pending: saved.pending ?? null, bulk: saved.bulk ?? '', form: saved.form ?? null,
        manualReconfirmation: saved.manualReconfirmation === true, unconfirmedIntent: saved.unconfirmedIntent ?? null });
      if (!state.pending) {
        try { const recovery = JSON.parse(storage?.getItem?.(recoveryKey(identity)) || 'null');
          if (recovery) Object.assign(state, { pending: recovery.pending ?? null, manualReconfirmation: recovery.manualReconfirmation === true, unconfirmedIntent: recovery.unconfirmedIntent ?? null });
        } catch {}
      }
      if (state.pending) state.message = '保留了结果未知的原操作，请先查询回执。';
      else if (state.operations.length || state.form || state.bulk) state.message = '已恢复本账号未提交的编辑，请核对服务器草稿后保存。';
    }
    emit();
  }
  const fence = () => ({ sequence, generation: getGeneration(), owner });
  const current = captured => !destroyed && captured.sequence === sequence && captured.generation === getGeneration()
    && captured.owner === owner && getAccount().authenticated && getAccount().verification === 'verified';
  async function read(path, options) {
    const captured = fence(); const value = await request(path, options);
    if (!current(captured)) throw new DOMException('页面或登录已更新。', 'AbortError');
    return value;
  }
  async function busy(run) {
    if (state.busy) return;
    state.busy = true; state.error = null; emit(); const captured = fence();
    try { return await run(captured); }
    catch (error) { if (current(captured) && error.name !== 'AbortError') { state.error = { message: error.message, code: error.code, details: error.details }; state.message = error.message; emit(); } throw error; }
    finally { if (current(captured)) { state.busy = false; emit(); } }
  }
  async function refreshDirectory() {
    const result = await read('/api/wordbanks?limit=100'); state.packs = result.packs; emit(); return result;
  }
  async function openPack(packId, { discard = false } = {}) {
    if (state.busy) fail('当前操作尚在处理，请稍后切换。');
    if (state.pending) fail('请先查询原操作回执。', 'PENDING_INTENT');
    if ((state.operations.length || state.bulk || state.form?.answer) && !discard) fail('请先保存本次修改，或明确放弃后切换。', 'UNSAVED_EDITS');
    ++sequence; const pack = await read(`/api/wordbanks/${packId}`);
    state.pack = pack; state.operations = []; state.preview = null; state.restorePreview = null; state.serverConflict = null; state.form = null; state.bulk = ''; stash(); emit(); return pack;
  }
  function queue(operations) {
    if (!state.pack || !state.authenticated) fail('请先打开一个词库。');
    if (state.busy) fail('本次提交尚在处理，请完成后再编辑。', 'OPERATION_BUSY');
    if (state.pending) fail('原操作未知期间不能添加新的提交。', 'PENDING_INTENT');
    if (state.operations.length + operations.length > 200) fail('本次最多200项修改，请先保存当前批次。');
    state.operations.push(...copy(operations)); state.preview = null; state.restorePreview = null; state.message = `本机待保存${state.operations.length}项修改。`; stash(); emit();
  }
  function removeOperation(index) {
    if (state.busy || state.pending) fail('当前操作尚未确认，请先完成原操作。');
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.operations.length) fail('待保存操作已更新，请重新核对。');
    state.operations.splice(index, 1); state.preview = null; state.restorePreview = null; stash(); emit();
  }
  async function committed(intent, result) {
    if (intent.operation === 'change') state.operations = [];
    state.pending = null; state.pendingExpired = false; state.pendingInspection = null; state.preview = null; state.restorePreview = null; state.serverConflict = null;
    state.message = '原操作已经确认保存，正在刷新当前草稿。'; stash(); emit();
    const packId = result.packId || intent.packId;
    if (packId) state.pack = await read(`/api/wordbanks/${packId}`);
    state.message = intent.operation === 'publish' ? '新版本已发布；正在玩的房间继续使用原版本。' : intent.operation === 'restore' ? '旧版本已复制为新草稿，请重新预览后发布。' : state.pack?.visibility === 'private' ? '已保存，仅本人可以读取当前内容。' : '已保存，伙伴可以读取当前内容。';
    await refreshDirectory(); stash(); emit(); return result;
  }
  async function write(operation, packId, path, input, { confirmedNewIntent = false } = {}) {
    if (state.pending) fail('原操作尚未确认，请先查询回执。', 'PENDING_INTENT');
    if (state.manualReconfirmation && !confirmedNewIntent) fail('原编号无法确认，必须人工再次确认这份新操作。', 'NEW_INTENT_CONFIRMATION_REQUIRED');
    const captured = fence(), body = { ...copy(input), requestId: createWordbankRequestId(now(), () => cryptoRef.randomUUID()) };
    const fingerprintInput = operation === 'copy' ? { ...body, sourcePackId: packId } : body;
    const intentPack = ['create', 'copy'].includes(operation) ? null : packId;
    const fingerprint = await canonicalWordbankRequestFingerprint(operation, intentPack, fingerprintInput, cryptoRef);
    if (!current(captured)) throw new DOMException('登录状态已更新。', 'AbortError');
    const intent = { operation, packId: intentPack, path, body, fingerprint };
    state.pending = intent; state.manualReconfirmation = false; stash(); emit();
    let result;
    try {
      result = await request(path, { method: 'POST', body });
      if (!current(captured)) throw new DOMException('登录状态已更新。', 'AbortError');
    } catch (error) {
      if (!current(captured)) throw error;
      if (!requestUnknown(error)) { state.pending = null; if (['DRAFT_CONFLICT', 'HEAD_CONFLICT', 'PREVIEW_STALE', 'RESTORE_STALE'].includes(error.code)) {
        const server = await read(`/api/wordbanks/${packId}`); state.serverConflict = server;
        state.message = '伙伴已修改。本人操作保留，请比较后明确合并。';
      } }
      else state.message = '这次操作结果未知，只能查询原回执；当前编辑已保留。';
      stash(); emit(); throw error;
    }
    return committed(intent, result);
  }
  async function save(options) {
    if (!state.operations.length) fail('没有待保存修改。');
    return busy(() => write('change', state.pack.id, `/api/wordbanks/${state.pack.id}/changes`, {
      expectedDraftRevision: state.pack.draftRevision, operations: state.operations }, options));
  }
  async function validate() {
    if (state.operations.length || state.pending) fail('请先保存并确认本次修改，再预览发布。');
    return busy(async () => { const pack = state.pack; state.preview = await read(`/api/wordbanks/${pack.id}/validate`, { method: 'POST', body: {
      expectedDraftRevision: pack.draftRevision, expectedPublishedHead: pack.publishedHead } });
      state.message = state.preview.report.valid ? '内容程序校验通过。请核对数量、别名和难度；未画过的词仍需真人试画。' : '词库有问题，修正后再预览。'; emit(); return state.preview; });
  }
  async function publish(options) {
    if (!state.preview?.report.valid || state.operations.length) fail('请先完成当前草稿的发布预览。');
    const preview = state.preview;
    return busy(() => write('publish', state.pack.id, `/api/wordbanks/${state.pack.id}/publish`, {
      expectedDraftRevision: preview.draftRevision, expectedPublishedHead: preview.publishedHead, previewHash: preview.previewHash }, options));
  }
  async function restorePreview(version) {
    if (state.operations.length || state.pending) fail('请先保存或明确放弃本机修改。');
    return busy(async () => { const pack = state.pack; state.restorePreview = await read(`/api/wordbanks/${pack.id}/restore-preview`, {
      method: 'POST', body: { version, expectedDraftRevision: pack.draftRevision, expectedPublishedHead: pack.publishedHead } }); emit(); return state.restorePreview; });
  }
  async function restore(options) {
    const preview = state.restorePreview;
    if (!preview) fail('请先预览恢复差异。');
    return busy(() => write('restore', state.pack.id, `/api/wordbanks/${state.pack.id}/restore`, { version: preview.version,
      expectedDraftRevision: preview.draftRevision, expectedPublishedHead: preview.publishedHead, diffHash: preview.diffHash }, options));
  }
  async function queryPending() {
    if (!state.pending) fail('没有待确认的原操作。');
    return busy(async captured => {
      const intent = state.pending; let receipt;
      try { receipt = await read(`/api/wordbank-requests/${intent.body.requestId}?fingerprint=${intent.fingerprint}`); }
      catch (error) { if (current(captured) && error.code === 'REQUEST_EXPIRED') { state.pendingExpired = true; emit(); } throw error; }
      if (receipt.fingerprint && receipt.fingerprint !== intent.fingerprint) fail('回执与原意图不一致，请保留编辑并停止补写。', 'RECEIPT_MISMATCH');
      if (receipt.status === 'committed') return committed(intent, receipt.result);
      if (receipt.status === 'rejected') { state.pending = null; state.error = receipt.error; state.message = receipt.error?.message || '原操作未提交，请修正原稿再确认新操作。'; stash(); emit(); }
      else { state.message = '原操作仍无法确认。不会重发或创建新编号，请保留编辑后人工核实。'; emit(); }
      return receipt;
    });
  }
  async function inspectExpiredIntent() {
    if (!state.pendingExpired || !state.pending) fail('先查询原回执，只有已过确认期限的原编号可人工核实。');
    return busy(async () => {
      await refreshDirectory();
      state.pendingInspection = state.pending.packId ? await read(`/api/wordbanks/${state.pending.packId}`) : { directory: copy(state.packs) };
      state.message = '已读取服务器现状。这不能证明原操作成功或失败，请逐项比较原稿后人工确认。'; emit();
    });
  }
  function releaseExpiredIntent({ confirmed = false } = {}) {
    if (!confirmed || !state.pendingExpired || !state.pendingInspection || !state.pending) fail('必须先读取并人工核对服务器现状。', 'MANUAL_CONFIRMATION_REQUIRED');
    state.unconfirmedIntent = copy(state.pending);
    if (state.pending.packId) state.pack = state.pendingInspection;
    state.pending = null; state.pendingExpired = false; state.pendingInspection = null; state.manualReconfirmation = true;
    state.preview = null; state.restorePreview = null;
    state.message = '原编号仍标记为无法确认，原稿已保留。下一次写入需要再次人工确认新操作。'; stash(); emit();
  }
  function mergeConflict() {
    if (!state.serverConflict || state.pending) fail('请先获取冲突的服务器草稿。');
    state.pack = state.serverConflict; state.serverConflict = null; state.preview = null; state.restorePreview = null;
    state.message = '保留了本人操作并采用新草稿版本。再次保存前请核对可能重合的词条。'; stash(); emit();
  }
  function discard() { if (state.pending) fail('未知操作不能直接放弃编号。'); state.operations = []; state.form = null; state.bulk = ''; state.preview = null; state.restorePreview = null; stash(); emit(); }
  function setBuffer(fields) { for (const key of ['bulk', 'form']) if (Object.hasOwn(fields, key)) state[key] = copy(fields[key]); stash(); }
  function requireCleanSwitch() {
    if (state.operations.length || state.bulk || state.form?.answer) fail('请先保存本次修改，或明确放弃后创建／复制其他词库。', 'UNSAVED_EDITS');
  }
  identityChanged();
  return { snapshot, identityChanged, refreshDirectory, openPack, queue, removeOperation, save, validate, publish, restorePreview, restore, queryPending, inspectExpiredIntent, releaseExpiredIntent, mergeConflict, discard, setBuffer,
    create: (input, options) => { requireCleanSwitch(); return busy(() => write('create', null, '/api/wordbanks', input, options)); },
    copy: (input, options) => { requireCleanSwitch(); return busy(() => write('copy', state.pack.id, `/api/wordbanks/${state.pack.id}/copy`, input, options)); },
    destroy() { stash(); destroyed = true; ++sequence; } };
}

export function mountWordbankPage(root, options = {}) {
  const documentRef = root.ownerDocument || globalThis.document, windowRef = documentRef.defaultView || globalThis.window;
  const el = (tag, text, className) => { const node = documentRef.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, action, className = 'secondary-button') => { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', () => run(action)); return node; };
  const input = (placeholder, type = 'text') => { const node = el('input'); node.type = type; node.placeholder = placeholder; return node; };
  const select = values => { const node = el('select'); for (const [value, name] of values) { const option = el('option', name); option.value = value; node.append(option); } return node; };
  const label = (name, control) => { const node = el('label', name); node.append(control); return node; };
  const section = (title, intro) => { const node = el('section', undefined, 'wordbank-section'); node.append(el('h2', title)); if (intro) node.append(el('p', intro, 'wordbank-note')); return node; };
  root.classList.add('wordbank-page'); root.replaceChildren();
  const header = el('header', undefined, 'wordbank-heading'), back = el('a', '← 返回大厅', 'quiet-link'); back.href = gamePath('/');
  header.append(back, el('p', 'DRAW & GUESS', 'eyebrow'), el('h1', '一起维护好玩的词。'), el('p', '公共库伙伴共编，私人库自己管理。已有房间继续使用开局时采用的版本。', 'wordbank-note')); root.append(header);
  const status = el('p', '', 'wordbank-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); root.append(status);
  const gate = el('div', undefined, 'wordbank-gate'), login = el('a', '登录棋牌室', 'primary-button'); login.href = gamePath('/auth/login?returnTo=%2Fwords'); gate.append(el('p', '登录后读取和维护词库。'), login); root.append(gate);
  const content = el('div', undefined, 'wordbank-content'); root.append(content);
  const library = section('公共与我的词库'), scope = select([['shared', '公共词库'], ['private', '我的私人词库']]), packs = select([]), newName = input('新词库名称');
  const packToolbar = el('div', undefined, 'wordbank-toolbar'); packToolbar.append(label('范围', scope), label('词库', packs), button('打开', () => controller.openPack(packs.value)));
  const creation = el('div', undefined, 'wordbank-toolbar'); creation.append(label('新建名称', newName), button('新建词库', () => confirmRecoveredWrite(options => controller.create({ name: newName.value, visibility: scope.value }, options))));
  library.append(packToolbar, creation); content.append(library);
  const summary = el('p', '', 'wordbank-note'), pendingBox = el('div', undefined, 'wordbank-warning'), queryReceiptButton = button('查询原回执', () => controller.queryPending());
  queryReceiptButton.dataset.pendingSafe = 'true'; pendingBox.append(el('strong', '原操作结果未知'), el('p', '当前编辑已保留。只查询原回执，不会重发。'), queryReceiptButton); content.append(pendingBox);
  const inspectExpiredButton = button('读取服务器现状，人工核对', () => controller.inspectExpiredIntent()), releaseExpiredButton = button('已人工核对，保留原稿并解除过期编号', () => {
    if (windowRef.confirm('服务器现状不能证明原操作成功或失败。确认已经逐项人工核对？原编号继续标记为无法确认，之后新操作还需再次确认，不会自动补写。')) controller.releaseExpiredIntent({ confirmed: true });
  }), pendingComparison = el('div');
  inspectExpiredButton.dataset.pendingSafe = 'true'; releaseExpiredButton.dataset.pendingSafe = 'true'; pendingBox.append(inspectExpiredButton, pendingComparison, releaseExpiredButton);
  const conflictBox = el('div', undefined, 'wordbank-warning'), conflictText = el('div'); conflictBox.append(el('strong', '伙伴先保存了修改'), conflictText,
    button('保留本人操作，采用新草稿版本', () => { if (windowRef.confirm('确认已比较伙伴草稿与本人待保存操作？相同词条请先逐项核对。')) controller.mergeConflict(); })); content.append(conflictBox);
  const workspace = el('div', undefined, 'wordbank-workspace'); workspace.append(summary); content.append(workspace);
  const packSettings = section('当前词库'), packName = input('词库名称'), packStatus = button('停用词库', () => {
    const pack = controller.snapshot().pack;
    if (windowRef.confirm(`${pack.retired ? '启用' : '停用'}“${pack.name}”？这项修改保存后会影响之后新局选用，已开局继续原内容。`)) controller.queue([{ type: 'pack.status', retired: !pack.retired, confirmed: true }]);
  });
  packSettings.append(label('词库名称', packName), button('加入名称修改', () => controller.queue([{ type: 'pack.rename', name: normalizeDrawAndGuessAnswer(packName.value) }])), packStatus); workspace.append(packSettings);
  const categoriesSection = section('分类', '分类改名保留编号。停用分类影响之后采用的新版本。'), categoriesList = el('div', undefined, 'wordbank-category-list'), categoryName = input('新分类名称');
  categoriesSection.append(categoriesList, label('新增分类', categoryName), button('加入新分类', () => controller.queue([{ type: 'category.add', id: `dg-category-${globalThis.crypto.randomUUID()}`, name: normalizeDrawAndGuessAnswer(categoryName.value) }]))); workspace.append(categoriesSection);
  const wordsSection = section('词语与认可别名', '程序校验通过表示文字与别名一致；难度和可画性还需要伙伴试画。'), search = input('搜索正文、别名或标签'), categoryFilter = select([['', '全部分类']]), difficultyFilter = select([['', '全部难度'], ['easy', '简单'], ['normal', '普通'], ['hard', '挑战']]), wordList = el('div', undefined, 'wordbank-word-list');
  const filters = el('div', undefined, 'wordbank-toolbar'); filters.append(label('搜索', search), label('分类', categoryFilter), label('难度', difficultyFilter)); wordsSection.append(filters, wordList);
  let page = 0; const pager = el('div', undefined, 'wordbank-toolbar'), pageLabel = el('span'); pager.append(button('上一页', () => { page = Math.max(0, page - 1); render(controller.snapshot()); }), pageLabel,
    button('下一页', () => { page++; render(controller.snapshot()); })); wordsSection.append(pager); workspace.append(wordsSection);
  const editor = section('添加或修改词语'), answer = input('例如：自行车'), aliases = input('例如：脚踏车｜自行車'), wordCategory = select([]), difficulty = select([['easy', '简单'], ['normal', '普通'], ['hard', '挑战']]), tags = input('维护标签，用｜分开'); let editingId = null;
  const editorRow = el('div', undefined, 'wordbank-grid'); editorRow.append(label('正文', answer), label('认可别名', aliases), label('分类', wordCategory), label('难度', difficulty), label('维护标签', tags));
  editor.append(editorRow, button('加入本次修改', () => {
    const fields = { answer: normalizeDrawAndGuessAnswer(answer.value), aliases: aliases.value.trim() ? aliases.value.split(/[|｜]/u).map(normalizeDrawAndGuessAnswer) : [],
      category: wordCategory.value, difficulty: difficulty.value, tags: tags.value.trim() ? tags.value.split(/[|｜]/u).map(normalizeDrawAndGuessAnswer) : [] };
    controller.queue([editingId ? { type: 'word.update', id: editingId, patch: fields } : { type: 'word.add', ...fields }]);
    editingId = null; answer.value = ''; aliases.value = ''; tags.value = ''; controller.setBuffer({ form: null });
  }), button('改为新增', () => { editingId = null; answer.value = ''; aliases.value = ''; tags.value = ''; controller.setBuffer({ form: null }); })); workspace.append(editor);
  const bulkSection = section('分批录入', '一行一个词：正文｜别名1｜别名2。每批至多200词，先预览，再加入待保存修改。'), bulk = el('textarea'); bulk.rows = 7; bulk.placeholder = '纸船｜折纸小船\n风车';
  const importStatus = el('div', undefined, 'wordbank-import-preview'); let importPreview = null;
  const importAddButton = button('将预览词加入本次修改', () => { if (!importPreview?.valid) fail('请先完成没有错误的逐行预览。'); controller.queue(importPreview.operations); importPreview = null; bulk.value = ''; controller.setBuffer({ bulk: '' }); importStatus.replaceChildren(); });
  bulkSection.append(label('逐行输入', bulk), button('预览这批词', () => { importPreview = previewWordbankImport(bulk.value, { category: wordCategory.value, difficulty: difficulty.value, words: controller.snapshot().pack.draft.words });
    importStatus.replaceChildren(el('p', importPreview.valid ? `整批校验通过，可录入${importPreview.operations.length}词。` : `本批存在错误，整批暂不加入；${importPreview.operations.length}行文字通过检查。`)); for (const error of importPreview.errors) importStatus.append(el('p', `${error.row ? `第${error.row}行：` : ''}${error.message}`, 'wordbank-error'));
    for (const operation of importPreview.operations.slice(0, 20)) importStatus.append(el('p', `${operation.answer}${operation.aliases.length ? ` · 别名 ${operation.aliases.join('、')}` : ''}`));
    importAddButton.disabled = !importPreview.valid;
  }), importAddButton, importStatus); workspace.append(bulkSection);
  const actions = section('草稿、发布与恢复', '保存草稿不等于发布。发布前检查分类、词数、别名和难度。'), queued = el('ol', undefined, 'wordbank-queued'), previewBox = el('div', undefined, 'wordbank-preview');
  actions.append(queued, button('保存草稿', () => confirmRecoveredWrite(options => controller.save(options)), 'primary-button'), button('放弃本机待保存修改', () => { if (windowRef.confirm('只放弃当前本机未保存编辑？服务器草稿与发布版本保留。')) { controller.discard(); importPreview = null; editingId = null; answer.value = ''; aliases.value = ''; tags.value = ''; } }),
    button('校验并预览发布', () => controller.validate()), button('确认发布当前预览', () => { if (windowRef.confirm('确认已检查当前预览，并将这个版本供伙伴的新局选择？')) return confirmRecoveredWrite(options => controller.publish(options)); }, 'primary-button'), previewBox); workspace.append(actions);
  const versions = select([]), history = el('div', undefined, 'wordbank-history'), restoreBox = el('div', undefined, 'wordbank-preview');
  actions.append(label('已发布版本', versions), button('预览恢复差异', () => controller.restorePreview(Number(versions.value))), button('确认复制旧版为新草稿', () => { if (windowRef.confirm('复制预览旧版为新草稿？当前未发布内容将由这份草稿接续，请先核对差异。')) return confirmRecoveredWrite(options => controller.restore(options)); }), restoreBox, history);
  const copyName = input('副本名称'), copyScope = select([['private', '我的私人副本'], ['shared', '明确共享公共副本']]); actions.append(label('复制名称', copyName), label('副本范围', copyScope),
    button('复制所选发布版', () => { if (copyScope.value === 'shared' && !windowRef.confirm('确认把所选版本的全部词语复制到伙伴共用的公共草稿？')) return;
      return confirmRecoveredWrite(options => controller.copy({ name: copyName.value, visibility: copyScope.value, sourceVersion: Number(versions.value) }, options)); }));
  let shownPack = null, shownAccount = null;
  const controller = createWordbankPageController({ ...options, onChange: render });
  function confirmRecoveredWrite(action) {
    if (controller.snapshot().manualReconfirmation && !windowRef.confirm('原操作无法确认。确认已核对这份原稿与服务器，现在明确提交一次新的操作？此操作会使用新编号。')) return;
    return action({ confirmedNewIntent: true });
  }
  function run(action) { Promise.resolve().then(action).catch(error => { if (error.name !== 'AbortError') status.textContent = error.message; }); }
  function render(state) {
    const displayedAccount = state.authenticated ? (options.getAccount || accountState)().userKey : null;
    if (displayedAccount !== shownAccount) {
      shownAccount = displayedAccount; shownPack = null; editingId = null; importPreview = null; page = 0;
      for (const control of [packName, answer, aliases, tags, bulk, newName, copyName, categoryName, search]) control.value = '';
      for (const node of [summary, conflictText, pendingComparison, queued, previewBox, restoreBox, importStatus, wordList, categoriesList, history]) node.replaceChildren();
      for (const control of [versions, categoryFilter, wordCategory]) control.replaceChildren();
    }
    gate.hidden = state.authenticated; content.hidden = !state.authenticated; status.textContent = state.message || (state.busy ? '正在处理…' : '未保存内容只在当前浏览器保留；保存后伙伴才能读取。');
    pendingBox.hidden = !state.pending; conflictBox.hidden = !state.serverConflict; workspace.hidden = !state.pack;
    inspectExpiredButton.hidden = !state.pendingExpired; releaseExpiredButton.hidden = !state.pendingInspection;
    pendingComparison.replaceChildren();
    if (state.pendingInspection && state.pending) {
      pendingComparison.append(el('p', `原编号：${state.pending.body.requestId}，依然无法确认。`));
      if (state.pendingInspection.directory) {
        pendingComparison.append(el('p', `原${state.pending.operation === 'copy' ? '复制' : '新建'}名称：“${state.pending.body.name}”。请核对目录是否已有同次操作形成的词库。`));
        for (const item of state.pendingInspection.directory) pendingComparison.append(el('p', `${item.name} · 草稿${item.draftRevision} · 发布${item.publishedHead ?? '尚无'} · ${item.stats.total}词`));
      } else appendComparison(pendingComparison, state.pack, state.pendingInspection, state.pending.body.operations || []);
    }
    for (const control of content.querySelectorAll('button')) control.disabled = state.busy || Boolean(state.pending && control.dataset.pendingSafe !== 'true');
    if (!state.authenticated) { packs.replaceChildren(); wordList.replaceChildren(); categoriesList.replaceChildren(); history.replaceChildren(); return; }
    if (state.pack && shownPack !== state.pack.id) scope.value = state.pack.visibility;
    const selected = state.pack?.id || packs.value, visiblePacks = state.packs.filter(pack => pack.visibility === scope.value); packs.replaceChildren();
    for (const pack of visiblePacks) { const option = el('option', `${pack.name}${pack.retired ? '（停用）' : ''}`); option.value = pack.id; packs.append(option); }
    packs.value = visiblePacks.some(pack => pack.id === selected) ? selected : visiblePacks[0]?.id || '';
    if (!state.pack) return;
    const pack = state.pack, oldFilter = categoryFilter.value, oldCategory = wordCategory.value;
    if (shownPack !== pack.id) { packName.value = pack.name; shownPack = pack.id; }
    packStatus.textContent = pack.retired ? '启用词库' : '停用词库';
    categoryFilter.replaceChildren(); const all = el('option', '全部分类'); all.value = ''; categoryFilter.append(all); wordCategory.replaceChildren(); categoriesList.replaceChildren();
    for (const category of pack.draft.categories) {
      for (const control of [categoryFilter, wordCategory]) { const option = el('option', `${category.name}${category.status === 'disabled' ? '（停用）' : ''}`); option.value = category.id; control.append(option); }
      const row = el('div', undefined, 'wordbank-category-row'), rename = input('分类名称'); rename.value = category.name;
      row.append(label('分类名称', rename), button('改名', () => controller.queue([{ type: 'category.rename', id: category.id, name: normalizeDrawAndGuessAnswer(rename.value) }])),
        button(category.status === 'active' ? '停用' : '启用', () => { const affected = pack.draft.words.filter(word => word.category === category.id && word.status !== 'retired').length;
          if (category.status === 'active' && !windowRef.confirm(`停用“${category.name}”会影响${affected}个词，确认加入本次修改？`)) return;
          controller.queue([{ type: 'category.status', id: category.id, status: category.status === 'active' ? 'disabled' : 'active', confirmedAffectedCount: affected }]); })); categoriesList.append(row);
    }
    categoryFilter.value = pack.draft.categories.some(category => category.id === oldFilter) ? oldFilter : '';
    wordCategory.value = pack.draft.categories.some(category => category.id === oldCategory) ? oldCategory : pack.draft.categories[0]?.id || '';
    const filtered = pack.draft.words.filter(word => (!categoryFilter.value || word.category === categoryFilter.value) && (!difficultyFilter.value || word.difficulty === difficultyFilter.value)
      && [word.answer, ...word.aliases, ...word.tags].some(term => term.toLowerCase().includes(search.value.toLowerCase())));
    page = Math.min(page, Math.max(0, Math.ceil(filtered.length / 30) - 1)); wordList.replaceChildren();
    for (const word of filtered.slice(page * 30, (page + 1) * 30)) {
      const row = el('article', undefined, 'wordbank-word-row'), details = el('div'); details.append(el('strong', word.answer),
        el('p', `${word.aliases.length ? `别名：${word.aliases.join('、')} · ` : ''}${({ easy: '简单', normal: '普通', hard: '挑战' })[word.difficulty]} · ${word.status === 'retired' ? '退役' : word.status === 'draft' ? '草稿' : '编辑校对'} · 提示${word.hintLength}字`, 'wordbank-note'));
      row.append(details, button('编辑', () => { editingId = word.id; answer.value = word.answer; aliases.value = word.aliases.join('｜'); wordCategory.value = word.category; difficulty.value = word.difficulty; tags.value = word.tags.join('｜'); answer.focus();
        controller.setBuffer({ form: { editingId, answer: answer.value, aliases: aliases.value, category: wordCategory.value, difficulty: difficulty.value, tags: tags.value } }); }),
        button('退役', () => { if (windowRef.confirm(`确认将“${word.answer}”从之后发布的新局中退役？`)) controller.queue([{ type: 'word.retire', id: word.id, confirmed: true }]); })); wordList.append(row);
    }
    pageLabel.textContent = `${filtered.length}词 · 第${page + 1}/${Math.max(1, Math.ceil(filtered.length / 30))}页`;
    summary.textContent = `${pack.name} · ${pack.visibility === 'private' ? '仅本人可读' : '伙伴公共共编'} · 草稿${pack.draftRevision} · 已发布${pack.publishedHead ?? '尚无版本'} · ${pack.draft.words.length}词`;
    const operationNames = { 'category.add': '新增分类', 'category.rename': '分类改名', 'category.status': '启停分类', 'word.add': '新增词语', 'word.update': '修改词语', 'word.retire': '退役词语', 'pack.rename': '词库改名', 'pack.status': '启停词库' };
    queued.replaceChildren(); for (const [index, operation] of state.operations.entries()) {
      const row = el('li', `${operationNames[operation.type] || '内容修改'} · ${operation.answer || operation.patch?.answer || operation.name || pack.draft.words.find(word => word.id === operation.id)?.answer || operation.id || '词库状态'}`);
      row.append(button('移除此项', () => controller.removeOperation(index))); queued.append(row);
    }
    previewBox.replaceChildren(); if (state.preview) {
      previewBox.append(el('p', `预览${state.preview.report.stats?.total ?? 0}词：${state.preview.report.valid ? '程序校验通过，待本人确认发布' : '发现问题'}`));
      for (const error of state.preview.report.errors) previewBox.append(el('p', `${error.path}：${error.message}`, 'wordbank-error'));
    }
    if (state.error?.details && Array.isArray(state.error.details)) for (const error of state.error.details) previewBox.append(el('p', `${error.path || '当前行'}：${error.message}`, 'wordbank-error'));
    const chosenVersion = versions.value; versions.replaceChildren(); for (const version of [...pack.versions].reverse()) { const option = el('option', `版本${version.version} · ${new Date(version.publishedAt).toLocaleString()}`); option.value = String(version.version); versions.append(option); }
    if (pack.versions.some(version => String(version.version) === chosenVersion)) versions.value = chosenVersion;
    restoreBox.replaceChildren(); if (state.restorePreview) restoreBox.append(el('p', `恢复版本${state.restorePreview.version}：当前${state.restorePreview.currentWordCount}词 → 目标${state.restorePreview.targetWordCount}词；${state.restorePreview.changedWordCount}词变化、${state.restorePreview.removedWordCount}词移出当前草稿。确认后仍须重新预览发布。`));
    history.replaceChildren(el('h3', '修改记录')); for (const entry of [...pack.history].reverse().slice(0, 50)) history.append(el('p', `${new Date(entry.at).toLocaleString()} · ${entry.actor.displayName} #${entry.actor.displayCode} · ${entry.summary}`));
    if (state.serverConflict) { conflictText.replaceChildren(); appendComparison(conflictText, pack, state.serverConflict, state.operations); }
    bulk.value = state.bulk;
    if (state.form && answer.value === '') { editingId = state.form.editingId; answer.value = state.form.answer; aliases.value = state.form.aliases; wordCategory.value = state.form.category; difficulty.value = state.form.difficulty; tags.value = state.form.tags; }
    // Dynamic rows are recreated above; fence their new controls as well.
    for (const control of content.querySelectorAll('button')) control.disabled = state.busy || Boolean(state.pending && control.dataset.pendingSafe !== 'true');
    importAddButton.disabled ||= !importPreview?.valid;
  }
  function appendComparison(node, base, remote, operations) {
    node.append(el('p', `服务器草稿${remote.draftRevision}，${remote.draft.words.length}词，发布${remote.publishedHead ?? '尚无'}；本机保留${operations.length}项操作。服务器现状不能单独证明原操作结果。`));
    const wordText = word => word ? `${word.answer} · 别名${word.aliases?.join('、') || '无'} · ${({ easy: '简单', normal: '普通', hard: '挑战' })[word.difficulty] || ''} · ${word.status === 'retired' ? '退役' : '有效'}${word.tags?.length ? ` · 标签${word.tags.join('、')}` : ''}` : '尚无此词';
    for (const operation of operations) {
      if (operation.type.startsWith('word.')) {
        const original = base?.draft.words.find(word => word.id === operation.id);
        const local = operation.type === 'word.add' ? operation : operation.type === 'word.update' ? { ...original, ...operation.patch } : { ...original, status: 'retired' };
        const server = remote.draft.words.find(word => word.id === operation.id || word.answer === local.answer);
        node.append(el('p', `本机：${wordText(local)}。服务器：${wordText(server)}。`));
      } else if (operation.type.startsWith('category.')) {
        const server = remote.draft.categories.find(category => category.id === operation.id);
        node.append(el('p', `分类操作：${operation.name || server?.name || '新增分类'}${operation.status ? ` · ${operation.status === 'active' ? '启用' : '停用'}` : ''}。服务器：${server ? `${server.name} · ${server.status === 'active' ? '启用' : '停用'}` : '尚无此分类'}。`));
      } else node.append(el('p', `词库操作：${operation.name || (operation.retired ? '停用' : '启用')}。服务器：${remote.name} · ${remote.retired ? '停用' : '启用'}。`));
    }
  }
  scope.addEventListener('change', () => render(controller.snapshot()));
  for (const control of [search, categoryFilter, difficultyFilter]) control.addEventListener('input', () => { page = 0; render(controller.snapshot()); });
  bulk.addEventListener('input', () => { importPreview = null; importAddButton.disabled = true; importStatus.replaceChildren(); controller.setBuffer({ bulk: bulk.value }); });
  for (const control of [answer, aliases, wordCategory, difficulty, tags]) control.addEventListener('input', () => controller.setBuffer({ form: { editingId, answer: answer.value, aliases: aliases.value, category: wordCategory.value, difficulty: difficulty.value, tags: tags.value } }));
  const unsubscribe = (options.onAccountChange || onAccountChange)(() => { controller.identityChanged(); if (controller.snapshot().authenticated) run(() => controller.refreshDirectory()); });
  const lifecycle = options.watchLifecycle === false ? null : watchAccountLifecycle({ windowRef, documentRef, onSuspend: () => { content.hidden = true; }, onVerified: () => { controller.identityChanged(); render(controller.snapshot()); } });
  run(async () => { if (!options.getAccount) await loadAccount(); controller.identityChanged(); if (controller.snapshot().authenticated) await controller.refreshDirectory(); });
  return { controller, destroy() { unsubscribe(); lifecycle?.stop(); controller.destroy(); root.replaceChildren(); } };
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('[data-wordbank-root]') || document.querySelector('#wordbank-root');
  if (root) mountWordbankPage(root);
}
