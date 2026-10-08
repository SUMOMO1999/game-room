import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizeDrawAndGuessAnswer, validateDrawAndGuessWordbank, summarizeDrawAndGuessWordbank } from './draw-and-guess-definition.mjs';
import { DRAW_AND_GUESS_CATEGORIES, DRAW_AND_GUESS_SEED } from './draw-and-guess-seed.mjs';
import { canonicalWordbankRequest } from '../../app/games/draw-and-guess/request-intent.mjs';

const FOREVER = Number.MAX_SAFE_INTEGER;
const PACKS = 'wordbank-packs', RELEASES = 'wordbank-releases', INDEX = 'wordbank-index';
const copy = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const bytes = value => value === null ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8');
const identifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const DRAW_AND_GUESS_WORDBANK_LIMITS = Object.freeze({ sharedPacks: 20, privatePacks: 10,
  categories: 64, sharedWords: 5000, privateWords: 2000, sharedBytes: 4 * 1024 * 1024,
  privateBytes: 2 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, receipts: 128,
  requestWindowMs: 24 * 60 * 60 * 1000, futureSkewMs: 5 * 60 * 1000, versions: 50,
  historyMs: 180 * 24 * 60 * 60 * 1000, historyEntries: 2000, references: 1000,
  operations: 200, inputBytes: 64 * 1024 });

export class WordbankError extends Error {
  constructor(status, code, message, details) { super(message); this.name = 'WordbankError'; this.status = status; this.code = code; if (details) this.details = details; }
}
const fail = (status, code, message, details) => { throw new WordbankError(status, code, message, details); };
export function createWordbankRequestId(time = Date.now()) {
  if (!Number.isSafeInteger(time) || time < 0) throw new TypeError('Request time must be a positive epoch millisecond value.');
  return `${time.toString(36)}-${randomUUID()}`;
}
export const createRequestId = createWordbankRequestId;

function trusted(actor) {
  if (!actor || actor.member !== true || !/^[a-f0-9]{64}$/.test(actor.userKey ?? '')) fail(401, 'MEMBER_REQUIRED', '请以有效棋牌身份登录。');
  // Existing account nicknames have a wider display contract than word text.
  // A display label must never invalidate the independently trusted identity.
  let displayName = '伙伴';
  if (typeof actor.displayName === 'string') { try { displayName = normalizeDrawAndGuessAnswer(actor.displayName); } catch {} }
  return { userKey: actor.userKey, label: { displayName, displayCode: hash(`wordbank-display:${actor.userKey}`).slice(0, 10) } };
}
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    fail(400, 'INVALID_INPUT', '操作字段无效；身份与内部版本字段由服务器决定。');
  }
}
function id(value) { if (typeof value !== 'string' || value.length > 80 || !identifier.test(value)) fail(400, 'INVALID_ID', '编号格式无效。'); return value; }
function text(value) { try { return normalizeDrawAndGuessAnswer(value); } catch (error) { fail(400, 'INVALID_TEXT', error.message); } }
function expected(pack, input) {
  if (!Number.isSafeInteger(input.expectedDraftRevision) || pack.draftRevision !== input.expectedDraftRevision) fail(409, 'DRAFT_CONFLICT', '伙伴已经修改草稿，请保留本机编辑并重新预览。');
  if ('expectedPublishedHead' in input && input.expectedPublishedHead !== pack.publishedHead) fail(409, 'HEAD_CONFLICT', '发布版本已变化，请重新预览。');
}
function requestTime(requestId, now, limits) {
  const match = /^([0-9a-z]{1,12})-([A-Za-z0-9_-]{1,128})$/.exec(requestId ?? '');
  const time = match && parseInt(match[1], 36);
  if (!match || !Number.isSafeInteger(time) || time.toString(36) !== match[1]) fail(400, 'INVALID_REQUEST_ID', '内容操作编号需要时间前缀与原意图标识。');
  if (time > now + limits.futureSkewMs) fail(400, 'REQUEST_FUTURE', '操作时间超出允许范围。');
  if (time <= now - limits.requestWindowMs) fail(409, 'REQUEST_EXPIRED', '原操作已过确认期限，请人工确认后重新发起。');
  return time;
}
function blankQuota() { return { schemaVersion: 1, usedBytes: 0, packs: [] }; }
function blankOwner(userKey) { return { schemaVersion: 1, userKey, prunedBefore: -1, receipts: [] }; }
const releaseId = (packId, version) => `${packId}:${version}`;
function fingerprint(operation, packId, input) {
  try { return hash(canonicalWordbankRequest(operation, packId, input)); }
  catch (error) { fail(400, 'INVALID_INPUT', error.message); }
}
function content(pack) {
  return { name: pack.name, categories: copy(pack.draft.categories), words: pack.draft.words.map(word => ({ ...copy(word), status: word.status === 'retired' ? 'retired' : 'reviewed' })) };
}
function previewHash(pack) { return hash({ packId: pack.id, revision: pack.draftRevision, head: pack.publishedHead, content: content(pack) }); }
function restoreHash(pack, release) { return hash({ packId: pack.id, revision: pack.draftRevision, head: pack.publishedHead, draft: pack.draft, targetVersion: release.version, targetHash: release.contentHash }); }

function snapshotInvalid() { throw new TypeError('Invalid draw-and-guess wordbank snapshot'); }
function checkedSnapshotText(value) { try { if (text(value) !== value) snapshotInvalid(); } catch { snapshotInvalid(); } }
function checkedLabel(label) {
  if (!label || typeof label !== 'object' || Array.isArray(label) || Object.keys(label).some(key => !['displayName', 'displayCode'].includes(key))
    || !/^(?:[a-f0-9]{10}|system-seed)$/.test(label.displayCode ?? '')) snapshotInvalid();
  checkedSnapshotText(label.displayName);
}
export function validateDrawAndGuessWordbankSnapshot(scope, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) snapshotInvalid();
  if (scope === PACKS) {
    if (Object.keys(value).some(key => !['schemaVersion', 'id', 'name', 'visibility', 'ownerKey', 'retired', 'draftRevision', 'draft', 'publishedHead', 'versions', 'references', 'history', 'seed', 'lastPublishedVersion', 'copiedFrom'].includes(key))) snapshotInvalid();
    if (!identifier.test(value.id ?? '') || !['shared', 'private'].includes(value.visibility)
      || (value.visibility === 'private' ? !/^[a-f0-9]{64}$/.test(value.ownerKey ?? '') : value.ownerKey !== null)
      || typeof value.retired !== 'boolean' || !Number.isSafeInteger(value.draftRevision) || value.draftRevision < 0
      || !(value.publishedHead === null || Number.isSafeInteger(value.publishedHead) && value.publishedHead > 0)
      || !value.draft || !Array.isArray(value.draft.words) || !Array.isArray(value.draft.categories)
      || !Array.isArray(value.versions) || value.versions.length > 1100 || !Array.isArray(value.references)
      || value.references.length > DRAW_AND_GUESS_WORDBANK_LIMITS.references || !Array.isArray(value.history)
      || value.history.length > DRAW_AND_GUESS_WORDBANK_LIMITS.historyEntries) snapshotInvalid();
    checkedSnapshotText(value.name);
    const report = validateDrawAndGuessWordbank(value.draft.words, { categories: value.draft.categories });
    if (!report.valid || value.draft.words.some(word => word.packId !== value.id)
      || value.draft.categories.length > DRAW_AND_GUESS_WORDBANK_LIMITS.categories
      || value.draft.words.length > (value.visibility === 'shared' ? DRAW_AND_GUESS_WORDBANK_LIMITS.sharedWords : DRAW_AND_GUESS_WORDBANK_LIMITS.privateWords)
      || bytes(value) > (value.visibility === 'shared' ? DRAW_AND_GUESS_WORDBANK_LIMITS.sharedBytes : DRAW_AND_GUESS_WORDBANK_LIMITS.privateBytes)) snapshotInvalid();
    for (const word of value.draft.words) if (Object.keys(word).some(key => !['id', 'category', 'answer', 'aliases', 'difficulty', 'language', 'source', 'status', 'definitionVersion', 'hintLength', 'tags', 'packId', 'drawingCue'].includes(key))) snapshotInvalid();
    const versions = new Set();
    for (const entry of value.versions) {
      if (!Number.isSafeInteger(entry.version) || entry.version < 1 || versions.has(entry.version) || !/^[a-f0-9]{64}$/.test(entry.hash ?? '') || !Number.isFinite(entry.publishedAt)) snapshotInvalid();
      versions.add(entry.version);
    }
    if (value.publishedHead !== null && (!versions.has(value.publishedHead) || value.lastPublishedVersion !== value.publishedHead)) snapshotInvalid();
    if (value.publishedHead === null && value.versions.length) snapshotInvalid();
    const references = new Set();
    for (const reference of value.references) {
      const referenceKey = `${reference.referenceId}:${reference.version}`;
      if (!identifier.test(reference.referenceId ?? '') || references.has(referenceKey) || !versions.has(reference.version) || !Number.isFinite(reference.expiresAt)) snapshotInvalid();
      references.add(referenceKey);
    }
    for (const entry of value.history) {
      if (!Number.isFinite(entry.at) || typeof entry.operation !== 'string' || !['create', 'copy', 'change', 'publish', 'restore'].includes(entry.operation)) snapshotInvalid();
      checkedLabel(entry.actor); checkedSnapshotText(entry.summary);
    }
    if (value.seed !== null && (!value.seed || value.seed.version !== 1 || !/^[a-f0-9]{64}$/.test(value.seed.hash ?? ''))) snapshotInvalid();
  } else if (scope === RELEASES) {
    if (Object.keys(value).some(key => !['schemaVersion', 'packId', 'version', 'name', 'categories', 'words', 'contentHash', 'publishedAt', 'publisher', 'publicationSource'].includes(key))) snapshotInvalid();
    if (!identifier.test(value.packId ?? '') || !Number.isSafeInteger(value.version) || value.version < 1 || !Array.isArray(value.words) || !Array.isArray(value.categories)
      || !/^[a-f0-9]{64}$/.test(value.contentHash ?? '') || !Number.isFinite(value.publishedAt) || !['member', 'system-seed'].includes(value.publicationSource)) snapshotInvalid();
    checkedSnapshotText(value.name); checkedLabel(value.publisher);
    if (!validateDrawAndGuessWordbank(value.words, { categories: value.categories }).valid
      || value.words.some(word => word.packId !== value.packId || !['reviewed', 'retired'].includes(word.status))
      || value.contentHash !== hash({ name: value.name, categories: value.categories, words: value.words })) snapshotInvalid();
    for (const word of value.words) if (Object.keys(word).some(key => !['id', 'category', 'answer', 'aliases', 'difficulty', 'language', 'source', 'status', 'definitionVersion', 'hintLength', 'tags', 'packId', 'drawingCue'].includes(key))) snapshotInvalid();
  } else if (scope === INDEX) {
    if (Object.hasOwn(value, 'userKey')) {
      if (Object.keys(value).some(key => !['schemaVersion', 'userKey', 'prunedBefore', 'receipts'].includes(key))) snapshotInvalid();
      if (!/^[a-f0-9]{64}$/.test(value.userKey ?? '') || !Number.isSafeInteger(value.prunedBefore) || value.prunedBefore < -1
        || !Array.isArray(value.receipts) || value.receipts.length > DRAW_AND_GUESS_WORDBANK_LIMITS.receipts) snapshotInvalid();
      const ids = new Set();
      for (const receipt of value.receipts) {
        const match = /^([0-9a-z]{1,12})-([A-Za-z0-9_-]{1,128})$/.exec(receipt.requestId ?? '');
        if (!match || parseInt(match[1], 36) !== receipt.requestTime || !Number.isSafeInteger(receipt.requestTime) || ids.has(receipt.requestId)
          || !/^[a-f0-9]{64}$/.test(receipt.fingerprint ?? '') || !['create', 'copy', 'change', 'publish', 'restore'].includes(receipt.operation)
          || !(receipt.packId === null || identifier.test(receipt.packId ?? '')) || !['pending', 'committed', 'rejected'].includes(receipt.status)
          || !Number.isFinite(receipt.createdAt) || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= receipt.requestTime
          || receipt.expiresAt > receipt.requestTime + DRAW_AND_GUESS_WORDBANK_LIMITS.requestWindowMs) snapshotInvalid();
        ids.add(receipt.requestId);
        if (receipt.status === 'committed' && (!receipt.result || !identifier.test(receipt.result.packId ?? '') || !Number.isSafeInteger(receipt.result.draftRevision))) snapshotInvalid();
        if (receipt.status === 'rejected' && (!receipt.error || !Number.isInteger(receipt.error.status) || receipt.error.status < 400 || receipt.error.status > 599 || typeof receipt.error.code !== 'string' || typeof receipt.error.message !== 'string')) snapshotInvalid();
      }
    } else if (Object.keys(value).some(key => !['schemaVersion', 'usedBytes', 'packs'].includes(key)) || !Number.isSafeInteger(value.usedBytes) || value.usedBytes < 0 || value.usedBytes > DRAW_AND_GUESS_WORDBANK_LIMITS.totalBytes || !Array.isArray(value.packs)) snapshotInvalid();
  } else snapshotInvalid();
  return value;
}

// Cross-record restore/startup verification; each array contains scan(...).value.
export function validateDrawAndGuessWordbankState(state) {
  if (!state || !['packs', 'releases', 'index'].every(key => Array.isArray(state[key]))) snapshotInvalid();
  const { packs, releases, index } = state;
  for (const [scope, values] of [[PACKS, packs], [RELEASES, releases], [INDEX, index]]) for (const value of values) validateDrawAndGuessWordbankSnapshot(scope, value);
  if (!packs.length && !releases.length && !index.length) return state;
  const quotas = index.filter(value => !Object.hasOwn(value, 'userKey'));
  if (quotas.length !== 1) snapshotInvalid();
  const q = quotas[0], byPack = new Map(packs.map(pack => [pack.id, pack])), byRelease = new Map(releases.map(release => [releaseId(release.packId, release.version), release]));
  if (byPack.size !== packs.length || byRelease.size !== releases.length || new Set(index.filter(value => Object.hasOwn(value, 'userKey')).map(value => value.userKey)).size !== index.length - 1
    || q.usedBytes !== [...packs, ...releases, ...index].reduce((sum, value) => sum + bytes(value), 0) || q.packs.length !== packs.length || new Set(q.packs.map(entry => entry.packId)).size !== packs.length) snapshotInvalid();
  const privateCounts = new Map(); let sharedCount = 0;
  for (const entry of q.packs) {
    const pack = byPack.get(entry.packId);
    if (!pack || entry.visibility !== pack.visibility || entry.ownerKey !== pack.ownerKey) snapshotInvalid();
    if (entry.visibility === 'shared') sharedCount++; else privateCounts.set(entry.ownerKey, (privateCounts.get(entry.ownerKey) ?? 0) + 1);
  }
  if (sharedCount > DRAW_AND_GUESS_WORDBANK_LIMITS.sharedPacks || [...privateCounts.values()].some(count => count > DRAW_AND_GUESS_WORDBANK_LIMITS.privatePacks)) snapshotInvalid();
  let published = 0;
  for (const pack of packs) for (const entry of pack.versions) {
    const release = byRelease.get(releaseId(pack.id, entry.version));
    if (!release || release.contentHash !== entry.hash || release.publishedAt !== entry.publishedAt) snapshotInvalid();
    published++;
  }
  if (published !== releases.length) snapshotInvalid();
  return state;
}

/** Server-only API. The BFF supplies a verified actor; never construct it from a request body.
 * Writes require atomic compareAndSwapMany. There is no single-record fallback. */
export function createDrawAndGuessWordbank({ storage, now = Date.now, limits: overrides = {}, maxCasAttempts = 30, protectedReference = null } = {}) {
  if (!storage?.read || !storage?.compareAndSwapMany) throw new TypeError('Wordbanks require atomic encrypted multi-record storage.');
  if (protectedReference !== null && typeof protectedReference !== 'function') throw new TypeError('Content reference protection must be a trusted callback.');
  if (!Number.isSafeInteger(maxCasAttempts) || maxCasAttempts < 1 || maxCasAttempts > 100) throw new TypeError('Invalid content retry bound.');
  const limits = { ...DRAW_AND_GUESS_WORDBANK_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new TypeError('Only bounded downward wordbank limits are supported.');
    limits[key] = value;
  }
  const ownerId = actor => `owner-${actor.userKey}`;
  async function quota() {
    const saved = await storage.read(INDEX, 'quota');
    const value = saved?.value ?? blankQuota();
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.usedBytes) || value.usedBytes < 0 || !Array.isArray(value.packs)) fail(503, 'CONTENT_CORRUPT', '词库额度记录无法验证。');
    return { value, version: saved?.version ?? null };
  }
  async function owner(actor) {
    const saved = await storage.read(INDEX, ownerId(actor));
    const value = saved?.value ?? blankOwner(actor.userKey);
    if (value.schemaVersion !== 1 || value.userKey !== actor.userKey || !Array.isArray(value.receipts) || !Number.isSafeInteger(value.prunedBefore)) fail(503, 'CONTENT_CORRUPT', '原操作回执无法验证。');
    return { value, version: saved?.version ?? null };
  }
  function access(actor, pack, allowRetired = true) {
    if (!pack || pack.schemaVersion !== 1 || !['shared', 'private'].includes(pack.visibility)) fail(404, 'PACK_UNAVAILABLE', '词库不存在或不可读取。');
    if (pack.visibility === 'private' && pack.ownerKey !== actor.userKey) fail(404, 'PACK_UNAVAILABLE', '词库不存在或不可读取。');
    if (!allowRetired && pack.retired) fail(409, 'PACK_RETIRED', '词库已停用，请选择可用内容。');
  }
  async function load(actor, packId, allowRetired = true) {
    id(packId); const saved = await storage.read(PACKS, packId); access(actor, saved?.value, allowRetired);
    try { validateDrawAndGuessWordbankSnapshot(PACKS, saved.value); } catch { fail(503, 'CONTENT_CORRUPT', '词库内容无法验证。'); }
    return saved;
  }
  function view(actor, pack) {
    const { ownerKey, references, seed, ...visible } = copy(pack);
    return { ...visible, owned: ownerKey === actor.userKey, canEdit: true, seed: seed ? { version: seed.version, hash: seed.hash } : null,
      stats: summarizeDrawAndGuessWordbank(pack.draft.words) };
  }
  function pruneReceipts(value, time) {
    const expired = value.receipts.filter(receipt => receipt.expiresAt <= time);
    value.receipts = value.receipts.filter(receipt => receipt.expiresAt > time).sort((a, b) => a.createdAt - b.createdAt);
    const excess = value.receipts.splice(0, Math.max(0, value.receipts.length - limits.receipts));
    for (const receipt of [...expired, ...excess]) value.prunedBefore = Math.max(value.prunedBefore, receipt.requestTime);
  }
  function quotaChange(saved, value, delta) {
    const oldBytes = saved.version === null ? 0 : bytes(saved.value);
    const baseline = saved.value.usedBytes + delta;
    value.usedBytes = baseline;
    for (let attempt = 0; attempt < 10; attempt++) {
      const updated = baseline + bytes(value) - oldBytes;
      if (updated === value.usedBytes) break;
      value.usedBytes = updated;
    }
    if (value.usedBytes < 0 || value.usedBytes > limits.totalBytes) fail(409, 'GLOBAL_QUOTA', '词库总内容达到额度，请整理或等待明确扩容。');
    return { scope: INDEX, id: 'quota', expectedVersion: saved.version, value, expiresAt: FOREVER };
  }
  function packLimits(pack) {
    if (pack.draft.categories.length > limits.categories || pack.draft.words.length > (pack.visibility === 'shared' ? limits.sharedWords : limits.privateWords)) fail(409, 'PACK_COUNT_LIMIT', '词库分类或词条达到上限。');
    if (bytes(pack) > (pack.visibility === 'shared' ? limits.sharedBytes : limits.privateBytes)) fail(409, 'PACK_BYTE_LIMIT', '词库草稿与记录达到字节上限。');
  }
  function history(pack, actor, operation, summary) {
    pack.history = [...pack.history.filter(entry => entry.at > now() - limits.historyMs), { at: now(), operation, actor: actor.label, summary }].slice(-limits.historyEntries);
  }
  async function reserve(actor, operation, packId, input) {
    const time = now(), stamp = requestTime(input.requestId, time, limits), digest = fingerprint(operation, packId, input);
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const saved = await owner(actor), q = await quota(), updated = copy(saved.value);
      const existing = updated.receipts.find(receipt => receipt.requestId === input.requestId);
      if (existing && existing.fingerprint !== digest) fail(409, 'REQUEST_ID_REUSED', '同一主体的原编号不能跨操作、词库或内容复用。');
      if (existing?.status === 'committed') return { duplicate: true, result: copy(existing.result) };
      if (existing?.status === 'rejected') fail(existing.error.status, existing.error.code, existing.error.message, existing.error.details);
      if (existing) fail(409, 'REQUEST_UNKNOWN', '原操作尚无法确认，请查询回执，不要补写。');
      pruneReceipts(updated, time);
      if (stamp <= updated.prunedBefore) fail(409, 'REQUEST_UNKNOWN', '原操作早于回执裁剪水位，无法确认，请人工重新确认。');
      updated.receipts.push({ requestId: input.requestId, requestTime: stamp, operation, packId,
        fingerprint: digest, status: 'pending', createdAt: time, expiresAt: stamp + limits.requestWindowMs });
      pruneReceipts(updated, time);
      if (stamp <= updated.prunedBefore) fail(409, 'REQUEST_UNKNOWN', '此操作处于回执裁剪边界，请人工重新确认。');
      const qNext = copy(q.value), changes = [
        { scope: INDEX, id: ownerId(actor), expectedVersion: saved.version, value: updated },
        quotaChange(q, qNext, bytes(updated) - (saved.version === null ? 0 : bytes(saved.value))),
      ];
      try { if (await storage.compareAndSwapMany({ changes, guards: [], validUntil: stamp + limits.requestWindowMs })) return { fingerprint: digest }; }
      catch { fail(503, 'UNKNOWN_RESULT', '原操作结果未知，请使用原编号查询回执。'); }
    }
    fail(409, 'CONTENT_BUSY', '伙伴正在更新词库，请保留编辑后重新查询。');
  }
  async function execute(actorInput, operation, packId, input, prepare) {
    const actor = trusted(actorInput);
    if (bytes(input) > limits.inputBytes) fail(413, 'INPUT_TOO_LARGE', '本次输入超过64 KiB上限。');
    if (packId) await load(actor, packId);
    const intent = await reserve(actor, operation, packId, input);
    if (intent.duplicate) return { ...intent.result, duplicate: true };
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const savedOwner = await owner(actor), q = await quota(), nextOwner = copy(savedOwner.value);
      const receipt = nextOwner.receipts.find(item => item.requestId === input.requestId);
      if (!receipt || receipt.fingerprint !== intent.fingerprint || receipt.status !== 'pending') fail(409, 'REQUEST_UNKNOWN', '原意图无法确认，请查询回执。');
      let prepared, rejection;
      try { prepared = await prepare(actor, q); }
      catch (error) { if (!(error instanceof WordbankError)) throw error; rejection = error; }
      let changes = prepared?.changes ?? [], nextQuota = prepared?.quota ?? copy(q.value);
      if (rejection) receipt.status = 'rejected', receipt.error = { status: rejection.status, code: rejection.code, message: rejection.message, ...(rejection.details ? { details: rejection.details } : {}) };
      else receipt.status = 'committed', receipt.result = prepared.result;
      const delta = changes.reduce((sum, change) => sum + bytes(change.value) - bytes(change.original ?? null), 0)
        + bytes(nextOwner) - bytes(savedOwner.value);
      try {
        const qChange = quotaChange(q, nextQuota, delta);
        changes = changes.map(({ original, ...change }) => change);
        const committed = await storage.compareAndSwapMany({ changes: [...changes,
          { scope: INDEX, id: ownerId(actor), expectedVersion: savedOwner.version, value: nextOwner }, qChange], guards: prepared?.guards ?? [], validUntil: receipt.expiresAt });
        if (!committed) continue;
      } catch (error) {
        if (error instanceof WordbankError) {
          // Quota rejection still receives a durable rejected receipt. Its small
          // additional bytes can exhaust the last bytes; then the pending intent
          // remains unknown and charged rather than being silently released.
          if (rejection) throw error;
          const rejected = copy(savedOwner.value), target = rejected.receipts.find(item => item.requestId === input.requestId);
          target.status = 'rejected'; target.error = { status: error.status, code: error.code, message: error.message };
          try {
            const correction = quotaChange(q, copy(q.value), bytes(rejected) - bytes(savedOwner.value));
            if (!await storage.compareAndSwapMany({ changes: [
              { scope: INDEX, id: ownerId(actor), expectedVersion: savedOwner.version, value: rejected }, correction], guards: [] })) continue;
          } catch { fail(503, 'UNKNOWN_RESULT', '原操作无法确认，请查询原编号。'); }
          throw error;
        }
        fail(503, 'UNKNOWN_RESULT', '原操作结果未知，请使用原编号查询回执。');
      }
      if (rejection) throw rejection;
      return copy(prepared.result);
    }
    fail(409, 'REQUEST_UNKNOWN', '原意图已登记但尚未提交，请查询回执，不要补写。');
  }
  async function get(actorInput, packId) { const actor = trusted(actorInput); return view(actor, (await load(actor, packId)).value); }
  async function list(actorInput, { offset = 0, limit = 20 } = {}) {
    const actor = trusted(actorInput);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'INVALID_PAGE', '分页范围无效。');
    const q = await quota(), visible = q.value.packs.filter(entry => entry.visibility === 'shared' || entry.ownerKey === actor.userKey);
    const packs = [];
    for (const entry of visible.slice(offset, offset + limit)) {
      const saved = await storage.read(PACKS, entry.packId);
      if (!saved) continue;
      access(actor, saved.value);
      packs.push({ id: saved.value.id, name: saved.value.name, visibility: saved.value.visibility, retired: saved.value.retired,
        draftRevision: saved.value.draftRevision, publishedHead: saved.value.publishedHead,
        categories: copy(saved.value.draft.categories), stats: summarizeDrawAndGuessWordbank(saved.value.draft.words) });
    }
    return { packs, total: visible.length, offset, hasMore: offset + limit < visible.length };
  }
  async function create(actor, input) {
    keys(input, ['requestId', 'name', 'visibility']);
    const name = text(input.name);
    if (!['shared', 'private'].includes(input.visibility)) fail(400, 'INVALID_VISIBILITY', '词库范围须为公共或私人。');
    return execute(actor, 'create', null, { ...input, name }, async (who, q) => {
      const count = q.value.packs.filter(entry => input.visibility === 'shared' ? entry.visibility === 'shared' : entry.visibility === 'private' && entry.ownerKey === who.userKey).length;
      if (count >= (input.visibility === 'shared' ? limits.sharedPacks : limits.privatePacks)) fail(409, 'PACK_QUOTA', '此范围词库数量已达到上限。');
      const packId = `dg-pack-${randomBytes(12).toString('hex')}`;
      const pack = { schemaVersion: 1, id: packId, name, visibility: input.visibility,
        ownerKey: input.visibility === 'private' ? who.userKey : null, retired: false, draftRevision: 0,
        draft: { categories: [{ id: 'custom', name: '自定义', status: 'active' }], words: [] }, publishedHead: null,
        versions: [], references: [], history: [], seed: null };
      history(pack, who, 'create', '创建词库'); packLimits(pack);
      const qNext = copy(q.value); qNext.packs.push({ packId, visibility: pack.visibility, ownerKey: pack.ownerKey });
      return { changes: [{ scope: PACKS, id: packId, expectedVersion: null, value: pack, original: null }], quota: qNext,
        result: { packId, draftRevision: 0, publishedHead: null } };
    });
  }
  async function copyPack(actorInput, input) {
    keys(input, ['requestId', 'name', 'visibility', 'sourcePackId', 'sourceVersion']);
    const actor = trusted(actorInput), name = text(input.name); id(input.sourcePackId);
    if (!['shared', 'private'].includes(input.visibility)) fail(400, 'INVALID_VISIBILITY', '副本范围须为公共或私人。');
    await getRelease(actorInput, input.sourcePackId, input.sourceVersion);
    return execute(actorInput, 'copy', null, { ...input, name }, async (who, q) => {
      const sourcePack = await load(who, input.sourcePackId, false);
      if (!sourcePack.value.versions.some(entry => entry.version === input.sourceVersion)) fail(404, 'RELEASE_UNAVAILABLE', '源版本不在成功发布目录中。');
      const source = await storage.read(RELEASES, releaseId(input.sourcePackId, input.sourceVersion));
      if (!source) fail(503, 'RELEASE_UNAVAILABLE', '源版本内容无法确认。');
      validateDrawAndGuessWordbankSnapshot(RELEASES, source.value);
      const count = q.value.packs.filter(entry => input.visibility === 'shared' ? entry.visibility === 'shared' : entry.visibility === 'private' && entry.ownerKey === who.userKey).length;
      if (count >= (input.visibility === 'shared' ? limits.sharedPacks : limits.privatePacks)) fail(409, 'PACK_QUOTA', '此范围词库数量已达到上限。');
      const packId = `dg-pack-${randomBytes(12).toString('hex')}`;
      const pack = { schemaVersion: 1, id: packId, name, visibility: input.visibility,
        ownerKey: input.visibility === 'private' ? who.userKey : null, retired: false, draftRevision: 0,
        draft: { categories: copy(source.value.categories), words: source.value.words.map(word => ({ ...copy(word), packId,
          status: word.status === 'retired' ? 'retired' : 'draft' })) }, publishedHead: null, versions: [], references: [], history: [], seed: null,
        copiedFrom: { packId: input.sourcePackId, version: input.sourceVersion, contentHash: source.value.contentHash } };
      history(pack, who, 'copy', `复制已发布版本${input.sourceVersion}为独立草稿`); packLimits(pack);
      const qNext = copy(q.value); qNext.packs.push({ packId, visibility: pack.visibility, ownerKey: pack.ownerKey });
      return { changes: [{ scope: PACKS, id: packId, expectedVersion: null, value: pack, original: null }], quota: qNext,
        guards: [{ scope: PACKS, id: input.sourcePackId, expectedVersion: sourcePack.version }, { scope: RELEASES, id: releaseId(input.sourcePackId, input.sourceVersion), expectedVersion: source.version }],
        result: { packId, draftRevision: 0, publishedHead: null } };
    });
  }
  function applyOperations(pack, operations) {
    if (!Array.isArray(operations) || !operations.length || operations.length > limits.operations) fail(400, 'OPERATIONS_LIMIT', '每次需要1～200个明确操作。');
    for (const [row, operation] of operations.entries()) {
      try {
        switch (operation?.type) {
          case 'category.add': {
            keys(operation, ['type', 'id', 'name']); const categoryId = id(operation.id);
            if (pack.draft.categories.some(category => category.id === categoryId)) fail(409, 'CATEGORY_EXISTS', '分类编号已存在。');
            pack.draft.categories.push({ id: categoryId, name: text(operation.name), status: 'active' }); break;
          }
          case 'category.rename': case 'category.status': {
            keys(operation, operation.type === 'category.rename' ? ['type', 'id', 'name'] : ['type', 'id', 'status', 'confirmedAffectedCount']);
            const category = pack.draft.categories.find(item => item.id === id(operation.id));
            if (!category) fail(404, 'CATEGORY_MISSING', '分类不存在。');
            if (operation.type === 'category.rename') category.name = text(operation.name);
            else {
              if (!['active', 'disabled'].includes(operation.status)) fail(400, 'CATEGORY_STATUS', '分类状态无效。');
              const affected = pack.draft.words.filter(word => word.category === category.id && word.status !== 'retired').length;
              if (operation.status === 'disabled' && operation.confirmedAffectedCount !== affected) fail(409, 'IMPACT_CONFIRMATION', '请确认停用分类影响的当前词数。', { row, affected });
              category.status = operation.status;
            } break;
          }
          case 'word.add': {
            keys(operation, ['type', 'id', 'answer', 'aliases', 'category', 'difficulty', 'tags']);
            const wordId = operation.id === undefined ? `dg-word-${randomBytes(12).toString('hex')}` : id(operation.id);
            if (pack.draft.words.some(word => word.id === wordId)) fail(409, 'WORD_EXISTS', '稳定词条编号已存在。');
            const answer = text(operation.answer), aliases = (operation.aliases ?? []).map(text), tags = (operation.tags ?? []).map(text);
            pack.draft.words.push({ id: wordId, category: id(operation.category), answer, aliases, difficulty: operation.difficulty,
              tags, language: 'zh', source: '伙伴原创录入', status: 'draft', definitionVersion: 1,
              hintLength: Array.from(answer).length, packId: pack.id }); break;
          }
          case 'word.update': {
            keys(operation, ['type', 'id', 'patch']); keys(operation.patch, ['answer', 'aliases', 'category', 'difficulty', 'tags']);
            const index = pack.draft.words.findIndex(word => word.id === id(operation.id));
            if (index < 0) fail(404, 'WORD_MISSING', '词条不存在。');
            const updated = { ...pack.draft.words[index], ...copy(operation.patch), definitionVersion: pack.draft.words[index].definitionVersion + 1, status: 'draft' };
            updated.answer = text(updated.answer); updated.aliases = updated.aliases.map(text); updated.tags = updated.tags.map(text); updated.hintLength = Array.from(updated.answer).length;
            pack.draft.words[index] = updated; break;
          }
          case 'word.retire': {
            keys(operation, ['type', 'id', 'confirmed']); if (operation.confirmed !== true) fail(400, 'IMPACT_CONFIRMATION', '请确认退役词条。');
            const word = pack.draft.words.find(item => item.id === id(operation.id)); if (!word) fail(404, 'WORD_MISSING', '词条不存在。');
            word.status = 'retired'; word.definitionVersion++; break;
          }
          case 'pack.rename': keys(operation, ['type', 'name']); pack.name = text(operation.name); break;
          case 'pack.status': keys(operation, ['type', 'retired', 'confirmed']);
            if (typeof operation.retired !== 'boolean' || operation.confirmed !== true) fail(400, 'IMPACT_CONFIRMATION', '请确认词包启停。'); pack.retired = operation.retired; break;
          default: fail(400, 'UNKNOWN_OPERATION', '此内容操作未定义。');
        }
      } catch (error) {
        if (error instanceof WordbankError) { error.details = { ...error.details, row }; throw error; }
        fail(400, 'INVALID_OPERATION', '此行字段无效。', { row });
      }
    }
    const report = validateDrawAndGuessWordbank(pack.draft.words, { categories: pack.draft.categories });
    if (!report.valid) fail(400, 'CONTENT_INVALID', '批次存在无效或歧义词条，未保存任何行。', report.errors);
  }
  async function change(actor, packId, input) {
    keys(input, ['requestId', 'expectedDraftRevision', 'operations']);
    return execute(actor, 'change', packId, input, async who => {
      const saved = await load(who, packId), pack = copy(saved.value); expected(pack, input); applyOperations(pack, input.operations);
      pack.draftRevision++; history(pack, who, 'change', `修改${input.operations.length}项内容`); packLimits(pack);
      return { changes: [{ scope: PACKS, id: packId, expectedVersion: saved.version, value: pack, original: saved.value }], result: { packId, draftRevision: pack.draftRevision, publishedHead: pack.publishedHead } };
    });
  }
  async function preview(actorInput, packId, input) {
    keys(input, ['expectedDraftRevision', 'expectedPublishedHead']); const actor = trusted(actorInput), pack = (await load(actor, packId, false)).value; expected(pack, input);
    const candidate = content(pack), report = validateDrawAndGuessWordbank(candidate.words, { categories: candidate.categories });
    if (!candidate.words.some(word => word.status === 'reviewed' && candidate.categories.some(category => category.id === word.category && category.status === 'active'))) {
      report.valid = false; report.errors.push({ code: 'empty-release', path: 'words', message: '发布版需要至少一个有效词条。' });
    }
    return { packId, draftRevision: pack.draftRevision, publishedHead: pack.publishedHead, previewHash: previewHash(pack), report, content: candidate };
  }
  async function getRelease(actorInput, packId, version) {
    const actor = trusted(actorInput), saved = await load(actor, packId, false), pack = saved.value;
    if (!Number.isSafeInteger(version) || !pack.versions.some(entry => entry.version === version)) fail(404, 'RELEASE_UNAVAILABLE', '版本未在成功发布目录中。');
    const released = await storage.read(RELEASES, releaseId(packId, version));
    if (!released || released.value.contentHash !== pack.versions.find(entry => entry.version === version).hash
      || released.value.contentHash !== hash({ name: released.value.name, categories: released.value.categories, words: released.value.words })) fail(503, 'RELEASE_UNAVAILABLE', '版本内容无法验证。');
    return copy(released.value);
  }
  async function cleanupVersions(pack, changes, guards) {
    const references = [];
    let checkedRooms = 0;
    for (const reference of pack.references) {
      if (reference.expiresAt > now()) { references.push(reference); continue; }
      if (!reference.referenceId.startsWith('room-')) continue;
      // Missing integration or a large backlog remains conservatively charged.
      // At most 60 room guards plus pack/release/receipt/quota fit the 64-key store.
      if (!protectedReference || checkedRooms >= 60) { references.push(reference); continue; }
      checkedRooms++;
      const protection = await protectedReference({ packId: pack.id, ...copy(reference) });
      if (protection === null) continue;
      const guard = protection?.guard;
      if (!Number.isSafeInteger(protection?.expiresAt) || protection.expiresAt <= now() || protection.expiresAt > now() + 8 * 24 * 60 * 60 * 1000
        || guard?.scope !== 'rooms' || guard.id !== reference.referenceId.slice(5) || !/^[A-Za-z0-9_-]{43}$/.test(guard.expectedVersion ?? '')
        || (guard.validUntil !== undefined && (!Number.isSafeInteger(guard.validUntil) || guard.validUntil <= now()))) {
        fail(503, 'CONTENT_REFERENCE_UNAVAILABLE', '房间内容引用暂时无法验证，保留旧版本。');
      }
      references.push({ ...reference, expiresAt: protection.expiresAt });
      // An expired waiting snapshot can still be protected by its live storage
      // revision without pretending that its room lifetime was extended.
      guards.push({ scope: 'rooms', id: guard.id, expectedVersion: guard.expectedVersion,
        ...(guard.validUntil === undefined ? {} : { validUntil: guard.validUntil }) });
    }
    pack.references = references;
    const protectedVersions = new Set([pack.publishedHead, ...pack.references.map(reference => reference.version)]);
    const keep = new Set(pack.versions.slice(-limits.versions).map(entry => entry.version));
    for (const version of protectedVersions) keep.add(version);
    const roomKeys = new Set(guards.map(guard => `${guard.scope}:${guard.id}`)).size;
    const deleteBudget = Math.max(0, 64 - roomKeys - changes.length - 3);
    const victims = pack.versions.filter(entry => !keep.has(entry.version)).slice(0, Math.min(50, deleteBudget));
    for (const entry of victims) {
      const saved = await storage.read(RELEASES, releaseId(pack.id, entry.version));
      if (!saved) fail(503, 'RELEASE_UNAVAILABLE', '旧版本目录与内容不一致。');
      changes.push({ scope: RELEASES, id: releaseId(pack.id, entry.version), expectedVersion: saved.version, value: null, original: saved.value });
    }
    pack.versions = pack.versions.filter(entry => !victims.includes(entry));
  }
  async function publish(actor, packId, input) {
    keys(input, ['requestId', 'expectedDraftRevision', 'expectedPublishedHead', 'previewHash']);
    if (!Object.hasOwn(input, 'expectedPublishedHead')) fail(400, 'HEAD_REQUIRED', '发布必须携带预期发布头。');
    return execute(actor, 'publish', packId, input, async who => {
      const saved = await load(who, packId, false), pack = copy(saved.value); expected(pack, input);
      const checked = await preview({ ...who, member: true }, packId, input.expectedPublishedHead === undefined ? { expectedDraftRevision: input.expectedDraftRevision } : { expectedDraftRevision: input.expectedDraftRevision, expectedPublishedHead: input.expectedPublishedHead });
      if (input.previewHash !== checked.previewHash) fail(409, 'PREVIEW_STALE', '发布内容与原预览不同，请重新预览。');
      if (!checked.report.valid) fail(400, 'CONTENT_INVALID', '词库不能发布。', checked.report.errors);
      const version = (pack.lastPublishedVersion ?? 0) + 1;
      const release = { schemaVersion: 1, packId, version, name: checked.content.name, categories: checked.content.categories,
        words: checked.content.words, contentHash: hash(checked.content), publishedAt: now(), publisher: who.label, publicationSource: 'member' };
      const changes = [{ scope: RELEASES, id: releaseId(packId, version), expectedVersion: null, value: release, original: null }];
      pack.publishedHead = version; pack.lastPublishedVersion = version;
      pack.versions.push({ version, hash: release.contentHash, publishedAt: release.publishedAt });
      pack.draft.words = copy(release.words); history(pack, who, 'publish', `发布版本${version}`);
      const guards = [];
      await cleanupVersions(pack, changes, guards); packLimits(pack);
      changes.push({ scope: PACKS, id: packId, expectedVersion: saved.version, value: pack, original: saved.value });
      return { changes, guards, result: { packId, draftRevision: pack.draftRevision, publishedHead: version, contentHash: release.contentHash } };
    });
  }
  async function previewRestore(actorInput, packId, input) {
    keys(input, ['version', 'expectedDraftRevision', 'expectedPublishedHead']);
    const actor = trusted(actorInput), pack = (await load(actor, packId)).value; expected(pack, input);
    const release = await getRelease({ ...actor, member: true }, packId, input.version);
    return { packId, version: input.version, draftRevision: pack.draftRevision, publishedHead: pack.publishedHead,
      diffHash: restoreHash(pack, release), currentWordCount: pack.draft.words.length, targetWordCount: release.words.length,
      changedWordCount: release.words.filter(word => canonical(word) !== canonical(pack.draft.words.find(current => current.id === word.id))).length,
      removedWordCount: pack.draft.words.filter(word => !release.words.some(target => target.id === word.id)).length };
  }
  async function restore(actor, packId, input) {
    keys(input, ['requestId', 'version', 'expectedDraftRevision', 'expectedPublishedHead', 'diffHash']);
    if (!Object.hasOwn(input, 'expectedPublishedHead')) fail(400, 'HEAD_REQUIRED', '恢复必须携带预期发布头。');
    return execute(actor, 'restore', packId, input, async who => {
      const saved = await load(who, packId), pack = copy(saved.value); expected(pack, input);
      const release = await getRelease({ ...who, member: true }, packId, input.version);
      if (input.diffHash !== restoreHash(pack, release)) fail(409, 'RESTORE_STALE', '当前草稿或确认差异已变化。');
      const current = new Map(pack.draft.words.map(word => [word.id, word]));
      pack.name = release.name; pack.draft = { categories: copy(release.categories), words: release.words.map(word => ({ ...copy(word),
        status: word.status === 'retired' ? 'retired' : 'draft', definitionVersion: Math.max(word.definitionVersion, current.get(word.id)?.definitionVersion ?? 0) + 1 })) };
      pack.draftRevision++; history(pack, who, 'restore', `将版本${input.version}复制为新草稿`); packLimits(pack);
      return { changes: [{ scope: PACKS, id: packId, expectedVersion: saved.version, value: pack, original: saved.value }], result: { packId, draftRevision: pack.draftRevision, publishedHead: pack.publishedHead } };
    });
  }
  async function queryRequest(actorInput, input) {
    keys(input, ['requestId', 'fingerprint', 'operation', 'packId', 'originalInput']); const actor = trusted(actorInput);
    const stamp = requestTime(input.requestId, now(), limits), saved = await owner(actor);
    const receipt = saved.value.receipts.find(entry => entry.requestId === input.requestId);
    if (input.fingerprint === undefined && (!input.originalInput || typeof input.operation !== 'string')) fail(400, 'REQUEST_FINGERPRINT_REQUIRED', '请提供原操作与内容以核对指纹。');
    if (input.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(input.fingerprint)) fail(400, 'REQUEST_FINGERPRINT_REQUIRED', '原操作指纹无效。');
    const digest = input.fingerprint ?? fingerprint(input.operation, input.packId ?? null, input.originalInput);
    if (receipt && digest !== receipt.fingerprint) fail(409, 'REQUEST_ID_REUSED', '原操作指纹不一致。');
    if (!receipt || stamp <= saved.value.prunedBefore) return { requestId: input.requestId, status: 'unknown' };
    return { requestId: receipt.requestId, fingerprint: receipt.fingerprint, operation: receipt.operation, packId: receipt.packId,
      status: receipt.status === 'pending' ? 'unknown' : receipt.status, ...(receipt.result ? { result: copy(receipt.result) } : {}), ...(receipt.error ? { error: copy(receipt.error) } : {}) };
  }
  async function ensureSeed({ publishInitial = false } = {}) {
    if (typeof publishInitial !== 'boolean') fail(400, 'SEED_OPTIONS', '初始化选项无效。');
    const seedHash = hash({ categories: DRAW_AND_GUESS_CATEGORIES, words: DRAW_AND_GUESS_SEED });
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const saved = await storage.read(PACKS, 'dg-base');
      if (saved) {
        try { validateDrawAndGuessWordbankSnapshot(PACKS, saved.value); } catch { fail(503, 'CONTENT_CORRUPT', '基础词库现有数据无法验证。'); }
        if (saved.value.visibility !== 'shared' || saved.value.ownerKey !== null) fail(409, 'SEED_NOT_EMPTY', '基础包并非未初始化公共包，不覆盖。');
      }
      if (saved?.value.seed) return { imported: false, packId: 'dg-base', seedHash: saved.value.seed.hash };
      if (saved && (saved.value.draftRevision !== 0 || saved.value.publishedHead !== null || saved.value.draft.words.length)) fail(409, 'SEED_NOT_EMPTY', '基础包已有伙伴内容，不覆盖。');
      const q = await quota(), qNext = copy(q.value);
      if (!saved && qNext.packs.filter(entry => entry.visibility === 'shared').length >= limits.sharedPacks) fail(409, 'PACK_QUOTA', '公共词包数量已达到上限。');
      const pack = { schemaVersion: 1, id: 'dg-base', name: '基础词库', visibility: 'shared', ownerKey: null,
        retired: false, draftRevision: 0, draft: { categories: copy(DRAW_AND_GUESS_CATEGORIES), words: copy(DRAW_AND_GUESS_SEED) },
        publishedHead: null, versions: [], references: [], history: [], seed: { version: 1, hash: seedHash } };
      const changes = [];
      if (publishInitial) {
        const candidate = content(pack), release = { schemaVersion: 1, packId: 'dg-base', version: 1,
          ...candidate, contentHash: hash(candidate), publishedAt: now(), publicationSource: 'system-seed',
          publisher: { displayName: '系统基础词库', displayCode: 'system-seed' } };
        pack.publishedHead = 1; pack.lastPublishedVersion = 1; pack.seed.initialPublished = true;
        pack.versions.push({ version: 1, hash: release.contentHash, publishedAt: release.publishedAt });
        changes.push({ scope: RELEASES, id: releaseId('dg-base', 1), expectedVersion: null, value: release });
      }
      packLimits(pack);
      if (!saved) qNext.packs.push({ packId: 'dg-base', visibility: 'shared', ownerKey: null });
      const qChange = quotaChange(q, qNext, bytes(pack) - (saved ? bytes(saved.value) : 0) + changes.reduce((sum, change) => sum + bytes(change.value), 0));
      if (await storage.compareAndSwapMany({ changes: [...changes, { scope: PACKS, id: 'dg-base', expectedVersion: saved?.version ?? null, value: pack }, qChange], guards: [] })) return { imported: true, packId: 'dg-base', seedHash, publishedHead: pack.publishedHead };
    }
    fail(409, 'CONTENT_BUSY', '基础词库初始化有并发，请重新查询。');
  }
  // Trusted room assembly calls this before adopting a version. A reference is
  // conservative until its room deadline; failed room adoption can leave a bounded
  // reference, but never a readable unpublished or already-collected release.
  async function retainRelease(actorInput, packId, version, { referenceId, expiresAt } = {}) {
    const actor = trusted(actorInput); id(referenceId);
    if (!Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 8 * 24 * 60 * 60 * 1000) fail(400, 'REFERENCE_DEADLINE', '房间引用期限无效。');
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const saved = await load(actor, packId, false), pack = copy(saved.value), q = await quota();
      if (!pack.versions.some(entry => entry.version === version)) fail(404, 'RELEASE_UNAVAILABLE', '版本不在成功发布目录中。');
      const released = await storage.read(RELEASES, releaseId(packId, version)); if (!released) fail(503, 'RELEASE_UNAVAILABLE', '版本内容无法验证。');
      pack.references = pack.references.filter(reference => (reference.expiresAt > now() || reference.referenceId.startsWith('room-'))
        && !(reference.referenceId === referenceId && reference.version === version));
      if (pack.references.length >= limits.references) fail(409, 'REFERENCE_LIMIT', '词包活动引用达到上限。');
      pack.references.push({ referenceId, version, expiresAt }); packLimits(pack);
      const qChange = quotaChange(q, copy(q.value), bytes(pack) - bytes(saved.value));
      if (await storage.compareAndSwapMany({ changes: [{ scope: PACKS, id: packId, expectedVersion: saved.version, value: pack }, qChange],
        guards: [{ scope: RELEASES, id: releaseId(packId, version), expectedVersion: released.version, validUntil: expiresAt }] })) return copy(released.value);
    }
    fail(409, 'CONTENT_BUSY', '引用版本正在变化，请重新选择。');
  }
  return Object.freeze({ create, copy: copyPack, get, list, change, preview, publish, previewRestore, restore,
    queryRequest, ensureSeed, getRelease, retainRelease, limits: Object.freeze(limits) });
}
