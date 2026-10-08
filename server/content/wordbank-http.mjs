import { RoomError } from '../../app/rooms.mjs';
import { WordbankError } from './draw-and-guess-wordbank.mjs';
import { identityCheckContextFor } from '../identity-check-context.mjs';

const fail = (status, code, message) => { throw new RoomError(status, code, message); };
const objectFields = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(field => fields.includes(field));

// Transport owns authentication, CSRF and fresh delivery checks. The content
// service owns permissions, versions and receipts; it never accepts body identity.
export function createWordbankHttp({ sessions, rooms, wordbanks, ready = Promise.resolve(), limit, reply, readJson }) {
  return async function route({ req, res, url, webRequest }) {
    if (!url.pathname.startsWith('/api/wordbanks') && !url.pathname.startsWith('/api/wordbank-requests/')) return false;
    const context = identityCheckContextFor(webRequest);
    const wait = operation => context ? context.wait(operation) : operation();
    let session;
    const authorizeOutput = async () => {
      const after = await sessions.authorize(webRequest, { touch: false });
      if (context) {
        if (!session) fail(503, 'WORD_BANK_IDENTITY_UNAVAILABLE', '暂时无法核实词库身份。');
        if (after.id !== session.id || after.userKey !== session.userKey) fail(401, 'WORD_BANK_IDENTITY_CHANGED', '登录身份已变化，请重新读取词库。');
        await sessions.assertCurrent(after, { context });
        context.assert();
      }
    };
    try {
    await wait(() => ready);
    const receipt = /^\/api\/wordbank-requests\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname);
    const match = /^\/api\/wordbanks(?:\/([a-z][a-z0-9-]{0,79})(?:\/(changes|validate|publish|restore-preview|restore|copy|releases\/([1-9]\d{0,8})))?)?$/.exec(url.pathname);
    if (!receipt && !match) { reply(res, 404, { error: '词库接口不存在。' }); return true; }
    const [, packId, operation, rawVersion] = match || [];
    const write = req.method === 'POST';
    const expected = receipt || rawVersion || packId && !operation ? 'GET' : !packId ? null : 'POST';
    if (!['GET', 'POST'].includes(req.method) || expected && req.method !== expected || !packId && !receipt && !['GET', 'POST'].includes(req.method)) {
      reply(res, 405, { error: '请求方法不支持。' }, { Allow: expected || 'GET, POST' }); return true;
    }
    session = await sessions.authorize(webRequest, { fresh: true });
    limit(`user:${session.userKey}`, 120);
    if (write) sessions.checkWrite(webRequest, session);
    const profile = await wait(() => rooms.ensureProfile(session.userKey));
    const actor = { userKey: session.userKey, member: true, displayName: profile.nickname || '伙伴' };
    let result;
    if (receipt) {
      if ([...url.searchParams.keys()].some(name => name !== 'fingerprint') || url.searchParams.getAll('fingerprint').length !== 1 || !/^[a-f0-9]{64}$/.test(url.searchParams.get('fingerprint') || '')) fail(400, 'INVALID_QUERY', '查询回执需要原操作指纹。');
      result = await wait(() => wordbanks.queryRequest(actor, { requestId: receipt[1], fingerprint: url.searchParams.get('fingerprint') }));
    } else if (!packId && !write) {
      const query = {};
      for (const name of url.searchParams.keys()) {
        const raw = url.searchParams.get(name);
        if (!['offset', 'limit'].includes(name) || url.searchParams.getAll(name).length !== 1 || !/^(0|[1-9]\d{0,8})$/.test(raw)) fail(400, 'INVALID_QUERY', '词库分页参数无效。');
        query[name] = Number(raw);
      }
      result = await wait(() => wordbanks.list(actor, query));
    } else if (write) {
      if (url.search) fail(400, 'INVALID_QUERY', '词库操作不接受额外查询参数。');
      const body = await wait(() => readJson(req));
      if (!packId) result = await wait(() => wordbanks.create(actor, body));
      else if (operation === 'changes') result = await wait(() => wordbanks.change(actor, packId, body));
      else if (operation === 'validate') result = await wait(() => wordbanks.preview(actor, packId, body));
      else if (operation === 'publish') result = await wait(() => wordbanks.publish(actor, packId, body));
      else if (operation === 'restore-preview') result = await wait(() => wordbanks.previewRestore(actor, packId, body));
      else if (operation === 'restore') result = await wait(() => wordbanks.restore(actor, packId, body));
      else if (operation === 'copy') {
        if (!objectFields(body, ['requestId', 'name', 'visibility', 'sourceVersion'])) fail(400, 'INVALID_BODY', '复制只需要版本、新名称和范围。');
        result = await wait(() => wordbanks.copy(actor, { ...body, sourcePackId: packId }));
      } else fail(404, 'UNKNOWN_OPERATION', '没有这个词库操作。');
    } else {
      if (url.search) fail(400, 'INVALID_QUERY', '词库详情不接受额外参数。');
      result = await wait(() => rawVersion ? wordbanks.getRelease(actor, packId, Number(rawVersion)) : wordbanks.get(actor, packId));
    }
    // A successful earlier write may survive a later authorization failure.
    // Its original receipt is the recovery source; never auto-repeat the write.
    await authorizeOutput();
    reply(res, !packId && write ? 201 : 200, result);
    return true;
    } catch (error) {
      if (!(error instanceof WordbankError)) throw error;
      if (context) await authorizeOutput();
      reply(res, error.status, { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
      return true;
    }
  };
}
