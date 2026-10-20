import { gamePath, entryStorageKey } from '../../entry-path.mjs';
import { accountState, accountGeneration, onAccountChange, loadAccount, watchAccountLifecycle, reportAuthFailure } from '../../account-client.mjs';
import { normalizeDrawAndGuessAnswer, normalizeDrawAndGuessGuess } from './matcher.mjs';
import { createWordbankRequestId, canonicalWordbankRequestFingerprint } from './request-intent.mjs';
import { categorySelectedByDefault } from './content-defaults.mjs';

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
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(method === 'GET' ? '词库读取未完成，请重试。' : '操作结果未知，请查询原回执。'), { status: 504, code: method === 'GET' ? 'WORD_BANK_READ_TIMEOUT' : 'UNKNOWN_RESULT' })); }, 10000); });
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (epoch !== accountGeneration()) throw new DOMException('登录状态已更新。', 'AbortError');
    // A slow content request is not evidence that the verified identity expired.
    // Only an explicit authentication failure may conceal this account's data.
    if (error.status === 401 || error.status === 503 && ['identity_unavailable', 'WORD_BANK_IDENTITY_UNAVAILABLE'].includes(error.code)) reportAuthFailure(error);
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function createWordbankPageController({ request = requestWordbank, getAccount = accountState, getGeneration = accountGeneration,
  onChange = () => {}, storage = globalThis.sessionStorage, now = Date.now, cryptoRef = globalThis.crypto } = {}) {
  let owner = null, sequence = 0, destroyed = false, directoryTask = null;
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
    ++sequence; directoryTask = null;
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
  function refreshDirectory() {
    if (directoryTask) return directoryTask;
    const task = (async () => {
      try { const result = await read('/api/wordbanks?limit=100'); state.packs = result.packs; emit(); return result; }
      finally { if (directoryTask === task) directoryTask = null; }
    })();
    directoryTask = task; return task;
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
  const section = (title, intro) => { const node = el('section', undefined, 'wordbank-region'); node.append(el('h2', title)); if (intro) node.append(el('p', intro, 'wordbank-note')); return node; };
  const disclosure = (title, intro) => { const node = el('details', undefined, 'wordbank-disclosure'); node.append(el('summary', title)); if (intro) node.append(el('p', intro, 'wordbank-note')); return node; };
  root.classList.add('wordbank-page'); root.replaceChildren();
  const header = el('header', undefined, 'wordbank-heading'), back = el('a', '← 返回大厅', 'quiet-link'); back.href = gamePath('/');
  header.append(back, el('p', 'DRAW & GUESS', 'eyebrow'), el('h1', '你画我猜 · 词库'), el('p', '搜一个词，补一点灵感。公共库伙伴共编，私人库自己管理。', 'wordbank-note')); root.append(header);
  const status = el('p', '', 'wordbank-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); root.append(status);
  const readRecovery = el('div', undefined, 'wordbank-read-recovery'); readRecovery.hidden = true;
  const retryRead = button('重试读取词库', async () => { retryRead.disabled = true; status.textContent = '正在重新读取词库…';
    try { await controller.refreshDirectory(); readRecovery.hidden = true; status.textContent = '目录已读取，可选择词库继续。'; } finally { retryRead.disabled = false; } });
  readRecovery.append(el('p', '词库暂时未读完，已确认的登录与本机编辑保持。'), retryRead); root.append(readRecovery);
  const gate = el('div', undefined, 'wordbank-gate'), login = el('a', '登录棋牌室', 'primary-button'); login.href = gamePath('/auth/login?returnTo=%2Fwords'); gate.append(el('p', '登录后读取和维护词库。'), login); root.append(gate);
  const content = el('div', undefined, 'wordbank-content'); root.append(content);
  const library = el('section', undefined, 'wordbank-library'), scope = select([['shared', '公共词库'], ['private', '我的私人词库']]), packs = select([]), newName = input('新词库名称');
  const libraryToggle = button('选择词库', () => { library.dataset.open = String(library.dataset.open !== 'true'); libraryToggle.setAttribute('aria-expanded', library.dataset.open); }, 'wordbank-library-toggle secondary-button'); libraryToggle.dataset.pendingSafe = 'true'; libraryToggle.setAttribute('aria-expanded', 'true'); library.dataset.open = 'true';
  const libraryControls = el('div', undefined, 'wordbank-library-controls');
  const packToolbar = el('div', undefined, 'wordbank-toolbar wordbank-pack-toolbar'); packToolbar.append(label('范围', scope), label('当前词库', packs), button('打开词库', () => controller.openPack(packs.value)));
  const creation = disclosure('新建词库'), creationRow = el('div', undefined, 'wordbank-toolbar'); creationRow.append(label('新词库名称', newName), button('新建词库', () => confirmRecoveredWrite(options => controller.create({ name: newName.value, visibility: scope.value }, options)))); creation.append(creationRow);
  libraryControls.append(packToolbar, creation); library.append(libraryToggle, libraryControls); content.append(library);
  const summary = el('p', '', 'wordbank-pack-summary'), pendingBox = el('div', undefined, 'wordbank-warning'), queryReceiptButton = button('查询原回执', () => controller.queryPending());
  queryReceiptButton.dataset.pendingSafe = 'true'; pendingBox.append(el('strong', '原操作结果未知'), el('p', '当前编辑已保留。只查询原回执，不会重发。'), queryReceiptButton); content.append(pendingBox);
  const inspectExpiredButton = button('读取服务器现状，人工核对', () => controller.inspectExpiredIntent()), releaseExpiredButton = button('已人工核对，保留原稿并解除过期编号', () => {
    if (windowRef.confirm('服务器现状不能证明原操作成功或失败。确认已经逐项人工核对？原编号继续标记为无法确认，之后新操作还需再次确认，不会自动补写。')) controller.releaseExpiredIntent({ confirmed: true });
  }), pendingComparison = el('div');
  inspectExpiredButton.dataset.pendingSafe = 'true'; releaseExpiredButton.dataset.pendingSafe = 'true'; pendingBox.append(inspectExpiredButton, pendingComparison, releaseExpiredButton);
  const conflictBox = el('div', undefined, 'wordbank-warning'), conflictText = el('div'); conflictBox.append(el('strong', '伙伴先保存了修改'), conflictText,
    button('保留本人操作，采用新草稿版本', () => { if (windowRef.confirm('确认已比较伙伴草稿与本人待保存操作？相同词条请先逐项核对。')) controller.mergeConflict(); })); content.append(conflictBox);
  const workspace = el('div', undefined, 'wordbank-workspace'); workspace.append(summary); content.append(workspace);
  const mobileNavigation = el('nav', undefined, 'wordbank-mobile-navigation'); mobileNavigation.setAttribute('aria-label', '词库任务');
  const browseButton = button('找词', () => setMobileView('browse')), composeButton = button('添加', () => setMobileView('compose'));
  for (const control of [browseButton, composeButton]) control.dataset.pendingSafe = 'true';
  mobileNavigation.append(browseButton, composeButton); workspace.append(mobileNavigation);
  const workbench = el('div', undefined, 'wordbank-workbench'); workspace.append(workbench);
  const wordsSection = section('词条', '可搜索正文、别名和标签。每页30词。'), search = input('搜索正文、别名或标签'), categoryFilter = select([['', '全部分类']]), difficultyFilter = select([['', '全部难度'], ['easy', '简单'], ['normal', '普通'], ['hard', '挑战']]), wordList = el('div', undefined, 'wordbank-word-list');
  wordsSection.classList.add('wordbank-words'); wordList.setAttribute('role', 'list');
  const filters = el('div', undefined, 'wordbank-filters'); filters.append(label('搜索词条', search), label('分类', categoryFilter), label('难度', difficultyFilter)); wordsSection.append(filters, wordList);
  const emptyList = el('p', '没有找到词条，换个关键词或分类试试。', 'wordbank-empty'); wordsSection.append(emptyList);
  let page = 0; const pager = el('div', undefined, 'wordbank-pager'), pageLabel = el('span'), previousPage = button('上一页', () => { page = Math.max(0, page - 1); render(controller.snapshot()); }), nextPage = button('下一页', () => { page++; render(controller.snapshot()); });
  pager.append(previousPage, pageLabel, nextPage); wordsSection.append(pager); workbench.append(wordsSection);
  const composer = el('aside', undefined, 'wordbank-composer'), composerTitle = el('h2', '添加词语'), editorMode = el('div', undefined, 'wordbank-editor-mode'); composer.setAttribute('aria-label', '录入词语'); composer.append(composerTitle, editorMode); workbench.append(composer);
  let composeMode = 'single';
  const singleModeButton = button('逐个添加', () => setComposeMode('single')), bulkModeButton = button('批量录入', () => setComposeMode('bulk'));
  editorMode.append(singleModeButton, bulkModeButton);
  const editor = el('div', undefined, 'wordbank-editor'), answer = input('例如：自行车'), aliases = input('例如：脚踏车｜自行車'), wordCategory = select([]), difficulty = select([['easy', '简单'], ['normal', '普通'], ['hard', '挑战']]), tags = input('维护标签，用｜分开'); let editingId = null;
  const sharedFields = el('div', undefined, 'wordbank-grid wordbank-editor-fields'); sharedFields.append(label('分类', wordCategory), label('难度', difficulty));
  const editorRow = el('div', undefined, 'wordbank-editor-inputs'), extraFields = disclosure('别名与标签（可选）'); extraFields.classList.add('wordbank-extra-fields'); extraFields.append(label('认可别名（用｜分开）', aliases), label('维护标签（用｜分开）', tags)); editorRow.append(sharedFields, extraFields);
  // The answer is the primary task; category and difficulty follow it in one row.
  editor.append(label('正文', answer));
  const addWordButton = button('加入待保存', () => {
    const fields = { answer: normalizeDrawAndGuessAnswer(answer.value), aliases: aliases.value.trim() ? aliases.value.split(/[|｜]/u).map(normalizeDrawAndGuessAnswer) : [],
      category: wordCategory.value, difficulty: difficulty.value, tags: tags.value.trim() ? tags.value.split(/[|｜]/u).map(normalizeDrawAndGuessAnswer) : [] };
    controller.queue([editingId ? { type: 'word.update', id: editingId, patch: fields } : { type: 'word.add', ...fields }]);
    editingId = null; answer.value = ''; aliases.value = ''; tags.value = ''; extraFields.open = false; controller.setBuffer({ form: null }); composerTitle.textContent = '添加词语'; addWordButton.textContent = '加入待保存';
    answer.focus();
  }, 'primary-button');
  editor.append(editorRow, addWordButton, button('清空，改为新增', () => { editingId = null; answer.value = ''; aliases.value = ''; tags.value = ''; extraFields.open = false; controller.setBuffer({ form: null }); composerTitle.textContent = '添加词语'; addWordButton.textContent = '加入待保存'; })); composer.append(editor);
  const bulkSection = el('div', undefined, 'wordbank-bulk'), bulk = el('textarea'); bulk.rows = 7; bulk.placeholder = '纸船｜折纸小船\n风车';
  const importStatus = el('div', undefined, 'wordbank-import-preview'); let importPreview = null;
  const importAddButton = button('加入待保存', () => { if (!importPreview?.valid) fail('请先完成没有错误的逐行预览。'); controller.queue(importPreview.operations); importPreview = null; bulk.value = ''; controller.setBuffer({ bulk: '' }); importStatus.replaceChildren(); }, 'primary-button');
  bulkSection.append(el('p', '一行一个词：正文｜别名1｜别名2。每批至多200词，先预览再加入。', 'wordbank-note'), label('逐行输入', bulk), button('预览这批词', () => { importPreview = previewWordbankImport(bulk.value, { category: wordCategory.value, difficulty: difficulty.value, words: controller.snapshot().pack.draft.words });
    importStatus.replaceChildren(el('p', importPreview.valid ? `整批校验通过，可录入${importPreview.operations.length}词。` : `本批存在错误，整批暂不加入；${importPreview.operations.length}行文字通过检查。`)); for (const error of importPreview.errors) importStatus.append(el('p', `${error.row ? `第${error.row}行：` : ''}${error.message}`, 'wordbank-error'));
    for (const operation of importPreview.operations.slice(0, 20)) importStatus.append(el('p', `${operation.answer}${operation.aliases.length ? ` · 别名 ${operation.aliases.join('、')}` : ''}`));
    importAddButton.disabled = !importPreview.valid;
  }), importAddButton, importStatus); composer.append(bulkSection);
  const actions = section('保存与发布', '保存草稿供伙伴共编；发布后供新局选用。'), draftCount = el('strong', '', 'wordbank-draft-count'), actionRow = el('div', undefined, 'wordbank-action-row'), queued = el('ol', undefined, 'wordbank-queued'), previewBox = el('div', undefined, 'wordbank-preview');
  const queuedDetails = disclosure('查看待保存修改'); queuedDetails.append(queued);
  const saveButton = button('保存草稿', () => confirmRecoveredWrite(options => controller.save(options)), 'primary-button'), validateButton = button('校验并预览发布', () => controller.validate()), publishButton = button('确认发布当前预览', () => { if (windowRef.confirm('确认已检查当前预览，并将这个版本供伙伴的新局选择？')) return confirmRecoveredWrite(options => controller.publish(options)); }, 'primary-button');
  actionRow.append(saveButton, validateButton, publishButton, button('放弃本机修改', () => { if (windowRef.confirm('只放弃当前本机未保存编辑？服务器草稿与发布版本保留。')) { controller.discard(); importPreview = null; editingId = null; answer.value = ''; aliases.value = ''; tags.value = ''; composerTitle.textContent = '添加词语'; addWordButton.textContent = '加入待保存'; } }));
  actions.classList.add('wordbank-save-actions'); actions.append(draftCount, actionRow, queuedDetails, previewBox); workbench.append(actions);
  const management = el('div', undefined, 'wordbank-management'); workspace.append(management);
  const packSettings = disclosure('词库设置', '名称与启停都先加入本机修改，保存后生效。'), packName = input('词库名称'), packStatus = button('停用词库', () => {
    const pack = controller.snapshot().pack;
    if (windowRef.confirm(`${pack.retired ? '启用' : '停用'}“${pack.name}”？这项修改保存后会影响之后新局选用，已开局继续原内容。`)) controller.queue([{ type: 'pack.status', retired: !pack.retired, confirmed: true }]);
  });
  const settingsRow = el('div', undefined, 'wordbank-toolbar'); settingsRow.append(label('词库名称', packName), button('加入名称修改', () => controller.queue([{ type: 'pack.rename', name: normalizeDrawAndGuessAnswer(packName.value) }])), packStatus); packSettings.append(settingsRow); management.append(packSettings);
  const defaultCategories = el('fieldset', undefined, 'wordbank-default-categories'), defaultCategoryList = el('div', undefined, 'wordbank-default-category-list');
  defaultCategories.append(el('legend', '加载题库时默认勾选的分类'), el('p', '修改加入待保存。保存草稿并发布后，新房间或重新加载该发布版本时采用；已有房间的选择不变。', 'wordbank-note'), defaultCategoryList);
  packSettings.append(defaultCategories);
  const categoriesSection = disclosure('分类管理', '改名保留编号；停用影响之后采用的新版本。'), categoriesList = el('div', undefined, 'wordbank-category-list'), categoryName = input('新分类名称'), categoryCreation = el('div', undefined, 'wordbank-toolbar');
  categoryCreation.append(label('新增分类', categoryName), button('加入新分类', () => controller.queue([{ type: 'category.add', id: `dg-category-${globalThis.crypto.randomUUID()}`, name: normalizeDrawAndGuessAnswer(categoryName.value) }]))); categoriesSection.append(categoriesList, categoryCreation); management.append(categoriesSection);
  const versions = select([]), history = el('div', undefined, 'wordbank-history'), restoreBox = el('div', undefined, 'wordbank-preview'), historySection = disclosure('发布历史、恢复与复制', '恢复旧版生成新草稿，不覆盖已开局的内容。');
  const restoreRow = el('div', undefined, 'wordbank-toolbar'); restoreRow.append(label('已发布版本', versions), button('预览恢复差异', () => controller.restorePreview(Number(versions.value))), button('确认复制旧版为新草稿', () => { if (windowRef.confirm('复制预览旧版为新草稿？当前未发布内容将由这份草稿接续，请先核对差异。')) return confirmRecoveredWrite(options => controller.restore(options)); }));
  historySection.append(restoreRow, restoreBox, history);
  const copyName = input('副本名称'), copyScope = select([['private', '我的私人副本'], ['shared', '明确共享公共副本']]), copyRow = el('div', undefined, 'wordbank-toolbar'); copyRow.append(label('复制名称', copyName), label('副本范围', copyScope),
    button('复制所选发布版', () => { if (copyScope.value === 'shared' && !windowRef.confirm('确认把所选版本的全部词语复制到伙伴共用的公共草稿？')) return;
      return confirmRecoveredWrite(options => controller.copy({ name: copyName.value, visibility: copyScope.value, sourceVersion: Number(versions.value) }, options)); })); historySection.append(copyRow, el('p', '私人副本最多2000词、2 MiB；扩充后的完整基础包可复制为共享副本，或新建私人库逐批添加自己需要的词。', 'wordbank-note')); management.append(historySection);
  function setMobileView(view) {
    workspace.dataset.mobileView = view;
    browseButton.setAttribute('aria-pressed', String(view === 'browse')); composeButton.setAttribute('aria-pressed', String(view === 'compose'));
  }
  setMobileView('browse');
  function setComposeMode(mode, { focus = false } = {}) {
    composeMode = mode;
    if (mode === 'bulk') bulkSection.insertBefore(sharedFields, bulkSection.children[0]); else editorRow.insertBefore(sharedFields, editorRow.children[0]);
    editor.hidden = mode !== 'single'; bulkSection.hidden = mode !== 'bulk';
    singleModeButton.setAttribute('aria-pressed', String(mode === 'single')); bulkModeButton.setAttribute('aria-pressed', String(mode === 'bulk'));
    composerTitle.textContent = mode === 'bulk' ? '批量录入' : editingId ? '修改词语' : '添加词语';
    if (focus) (mode === 'bulk' ? bulk : answer).focus();
  }
  setComposeMode('single');
  let shownPack = null, shownAccount = null;
  const controller = createWordbankPageController({ ...options, onChange: render });
  function confirmRecoveredWrite(action) {
    if (controller.snapshot().manualReconfirmation && !windowRef.confirm('原操作无法确认。确认已核对这份原稿与服务器，现在明确提交一次新的操作？此操作会使用新编号。')) return;
    return action({ confirmedNewIntent: true });
  }
  function run(action) { Promise.resolve().then(action).catch(error => { if (error.name !== 'AbortError') { status.dataset.quiet = 'false'; status.textContent = error.message; readRecovery.hidden = !controller.snapshot().authenticated || error.status === 401; } }); }
  function render(state) {
    const displayedAccount = state.authenticated ? (options.getAccount || accountState)().userKey : null;
    if (displayedAccount !== shownAccount) {
      shownAccount = displayedAccount; shownPack = null; editingId = null; importPreview = null; page = 0; setComposeMode('single'); setMobileView('browse'); library.dataset.open = 'true'; libraryToggle.setAttribute('aria-expanded', 'true');
      for (const detail of [creation, packSettings, categoriesSection, historySection, queuedDetails, extraFields]) detail.open = false;
      for (const control of [packName, answer, aliases, tags, bulk, newName, copyName, categoryName, search]) control.value = '';
      for (const node of [summary, conflictText, pendingComparison, queued, previewBox, restoreBox, importStatus, wordList, categoriesList, defaultCategoryList, history]) node.replaceChildren();
      for (const control of [versions, categoryFilter, wordCategory]) control.replaceChildren();
    }
    gate.hidden = state.authenticated; content.hidden = !state.authenticated; status.textContent = state.message || (state.busy ? '正在处理…' : '未保存内容只在当前浏览器保留；保存后伙伴才能读取。');
    status.dataset.quiet = String(!state.message && !state.busy);
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
    if (!state.pack) { libraryToggle.textContent = '选择词库'; return; }
    const pack = state.pack, oldFilter = categoryFilter.value, oldCategory = wordCategory.value;
    defaultCategoryList.replaceChildren();
    for (const category of pack.draft.categories) {
      const row = el('label', undefined, 'wordbank-default-category'), control = input('', 'checkbox');
      const pending = state.operations.filter(operation => operation.type === 'category.default' && operation.id === category.id).at(-1);
      control.checked = pending?.selected ?? categorySelectedByDefault(category, pack.id); control.disabled = category.status !== 'active' || state.busy || Boolean(state.pending); control.dataset.defaultCategory = category.id;
      control.addEventListener('change', () => run(() => controller.queue([{ type: 'category.default', id: category.id, selected: control.checked }])));
      row.append(control, el('span', category.name + (category.status === 'active' ? '' : '（已停用）'))); defaultCategoryList.append(row);
    }
    if (shownPack !== pack.id) { packName.value = pack.name; shownPack = pack.id; page = 0; setComposeMode(state.bulk && !state.form?.answer ? 'bulk' : 'single'); library.dataset.open = 'false'; libraryToggle.setAttribute('aria-expanded', 'false'); }
    libraryToggle.textContent = `${pack.name} · ${pack.draft.words.length}词　⌄`;
    packStatus.textContent = pack.retired ? '启用词库' : '停用词库';
    categoryFilter.replaceChildren(); const all = el('option', '全部分类'); all.value = ''; categoryFilter.append(all); wordCategory.replaceChildren(); categoriesList.replaceChildren();
    const categoryCounts = new Map(pack.draft.categories.map(category => [category.id, 0]));
    for (const word of pack.draft.words) if (word.status !== 'retired') categoryCounts.set(word.category, (categoryCounts.get(word.category) || 0) + 1);
    for (const category of pack.draft.categories) {
      for (const control of [categoryFilter, wordCategory]) { const option = el('option', `${category.name} · ${categoryCounts.get(category.id) || 0}词${category.status === 'disabled' ? '（停用）' : ''}`); option.value = category.id; control.append(option); }
      const row = el('div', undefined, 'wordbank-category-row'), rename = input('分类名称'); rename.value = category.name;
      row.append(label(`${categoryCounts.get(category.id) || 0}词 · 分类名称`, rename), button('改名', () => controller.queue([{ type: 'category.rename', id: category.id, name: normalizeDrawAndGuessAnswer(rename.value) }])),
        button(category.status === 'active' ? '停用' : '启用', () => { const affected = pack.draft.words.filter(word => word.category === category.id && word.status !== 'retired').length;
          if (category.status === 'active' && !windowRef.confirm(`停用“${category.name}”会影响${affected}个词，确认加入本次修改？`)) return;
          controller.queue([{ type: 'category.status', id: category.id, status: category.status === 'active' ? 'disabled' : 'active', confirmedAffectedCount: affected }]); })); categoriesList.append(row);
    }
    categoryFilter.value = pack.draft.categories.some(category => category.id === oldFilter) ? oldFilter : '';
    wordCategory.value = pack.draft.categories.some(category => category.id === oldCategory) ? oldCategory : pack.draft.categories[0]?.id || '';
    const filtered = pack.draft.words.filter(word => (!categoryFilter.value || word.category === categoryFilter.value) && (!difficultyFilter.value || word.difficulty === difficultyFilter.value)
      && [word.answer, ...word.aliases, ...word.tags].some(term => term.toLowerCase().includes(search.value.toLowerCase())));
    page = Math.min(page, Math.max(0, Math.ceil(filtered.length / 30) - 1)); wordList.replaceChildren();
    const categoryNames = new Map(pack.draft.categories.map(category => [category.id, category.name]));
    for (const word of filtered.slice(page * 30, (page + 1) * 30)) {
      const row = el('div', undefined, 'wordbank-word-row'), details = el('div', undefined, 'wordbank-term'), rowActions = el('div', undefined, 'wordbank-row-actions'); row.setAttribute('role', 'listitem');
      details.append(el('strong', word.answer), el('p', `${categoryNames.get(word.category) || word.category} · ${({ easy: '简单', normal: '普通', hard: '挑战' })[word.difficulty]}${word.status === 'retired' ? ' · 已退役' : word.status === 'draft' ? ' · 草稿' : ''}`, 'wordbank-note'));
      if (word.aliases.length) details.append(el('p', `认可别名：${word.aliases.join('、')}`, 'wordbank-aliases'));
      rowActions.append(button('编辑', () => { editingId = word.id; answer.value = word.answer; aliases.value = word.aliases.join('｜'); wordCategory.value = word.category; difficulty.value = word.difficulty; tags.value = word.tags.join('｜'); addWordButton.textContent = '加入这项修改'; extraFields.open = Boolean(word.aliases.length || word.tags.length); setMobileView('compose'); setComposeMode('single', { focus: true }); composer.scrollIntoView?.({ block: 'nearest' });
        controller.setBuffer({ form: { editingId, answer: answer.value, aliases: aliases.value, category: wordCategory.value, difficulty: difficulty.value, tags: tags.value } }); }),
        button('退役', () => { if (windowRef.confirm(`确认将“${word.answer}”从之后发布的新局中退役？`)) controller.queue([{ type: 'word.retire', id: word.id, confirmed: true }]); })); row.append(details, rowActions); wordList.append(row);
    }
    emptyList.hidden = filtered.length > 0;
    const pageCount = Math.max(1, Math.ceil(filtered.length / 30));
    pageLabel.textContent = `${filtered.length}词 · ${page + 1} / ${pageCount}页`;
    summary.textContent = `${pack.name} · ${pack.visibility === 'private' ? '仅本人可读' : '公共共编'} · ${pack.draft.words.length}词 · ${pack.draft.categories.length}分类 · 草稿${pack.draftRevision} · ${pack.publishedHead ? `发布版${pack.publishedHead}` : '尚未发布'}`;
    composeButton.textContent = state.operations.length ? `添加 · 待保存${state.operations.length}` : '添加';
    draftCount.textContent = state.operations.length ? `${state.operations.length}项本机修改，尚未保存` : '草稿已同步，无本机待保存修改';
    queuedDetails.hidden = state.operations.length === 0;
    const operationNames = { 'category.add': '新增分类', 'category.rename': '分类改名', 'category.status': '启停分类', 'category.default': '默认勾选分类', 'word.add': '新增词语', 'word.update': '修改词语', 'word.retire': '退役词语', 'pack.rename': '词库改名', 'pack.status': '启停词库' };
    queued.replaceChildren(); for (const [index, operation] of state.operations.entries()) {
      const row = el('li', `${operationNames[operation.type] || '内容修改'} · ${operation.answer || operation.patch?.answer || operation.name || pack.draft.words.find(word => word.id === operation.id)?.answer || (operation.type === 'category.default' ? `${pack.draft.categories.find(category => category.id === operation.id)?.name || operation.id} · ${operation.selected ? '默认勾选' : '默认不勾选'}` : operation.id) || '词库状态'}`);
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
    if (state.form && answer.value === '') { editingId = state.form.editingId; answer.value = state.form.answer; aliases.value = state.form.aliases; wordCategory.value = state.form.category; difficulty.value = state.form.difficulty; tags.value = state.form.tags; extraFields.open = Boolean(state.form.aliases || state.form.tags); addWordButton.textContent = editingId ? '加入这项修改' : '加入待保存'; setComposeMode(composeMode); }
    // Dynamic rows are recreated above; fence their new controls as well.
    for (const control of content.querySelectorAll('button')) control.disabled = state.busy || Boolean(state.pending && control.dataset.pendingSafe !== 'true');
    importAddButton.disabled ||= !importPreview?.valid;
    previousPage.disabled ||= page === 0; nextPage.disabled ||= page + 1 >= pageCount;
    saveButton.disabled ||= state.operations.length === 0; validateButton.disabled ||= state.operations.length > 0;
    publishButton.hidden = !state.preview?.report.valid; publishButton.disabled ||= !state.preview?.report.valid || state.operations.length > 0;
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
        if (operation.type === 'category.default') {
          node.append(el('p', `默认分类：${server?.name || operation.id}。本机：${operation.selected ? '勾选' : '不勾选'}；服务器：${server ? (categorySelectedByDefault(server, remote.id) ? '勾选' : '不勾选') : '分类不存在'}。`)); continue;
        }
        node.append(el('p', `分类操作：${operation.name || server?.name || '新增分类'}${operation.status ? ` · ${operation.status === 'active' ? '启用' : '停用'}` : ''}。服务器：${server ? `${server.name} · ${server.status === 'active' ? '启用' : '停用'}` : '尚无此分类'}。`));
      } else node.append(el('p', `词库操作：${operation.name || (operation.retired ? '停用' : '启用')}。服务器：${remote.name} · ${remote.retired ? '停用' : '启用'}。`));
    }
  }
  scope.addEventListener('change', () => render(controller.snapshot()));
  for (const control of [search, categoryFilter, difficultyFilter]) control.addEventListener('input', () => { page = 0; render(controller.snapshot()); });
  bulk.addEventListener('input', () => { importPreview = null; importAddButton.disabled = true; importStatus.replaceChildren(); controller.setBuffer({ bulk: bulk.value }); });
  for (const control of [answer, aliases, wordCategory, difficulty, tags]) control.addEventListener('input', () => {
    if ([wordCategory, difficulty].includes(control)) { importPreview = null; importAddButton.disabled = true; importStatus.replaceChildren(); }
    controller.setBuffer({ form: { editingId, answer: answer.value, aliases: aliases.value, category: wordCategory.value, difficulty: difficulty.value, tags: tags.value } });
  });
  const unsubscribe = (options.onAccountChange || onAccountChange)(() => { controller.identityChanged(); if (controller.snapshot().authenticated) run(() => controller.refreshDirectory()); });
  const lifecycle = options.watchLifecycle === false ? null : watchAccountLifecycle({ windowRef, documentRef, onSuspend: () => { content.hidden = true; }, onVerified: () => { controller.identityChanged(); render(controller.snapshot()); } });
  run(async () => { if (!options.getAccount) await loadAccount(); controller.identityChanged(); if (controller.snapshot().authenticated) await controller.refreshDirectory(); });
  return { controller, destroy() { unsubscribe(); lifecycle?.stop(); controller.destroy(); root.replaceChildren(); } };
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('[data-wordbank-root]') || document.querySelector('#wordbank-root');
  if (root) mountWordbankPage(root);
}
