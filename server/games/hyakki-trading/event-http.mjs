import { RoomError } from '../../../app/rooms.mjs';
import { IdentityFailure } from '../../auth.mjs';
import { createIdentityCheckContext, identityCheckContextFor } from '../../identity-check-context.mjs';
import { prepareCurrentRoomOutput } from '../../room-output-fence.mjs';
import { HyakkiEventError } from './event-store.mjs';

const fail = (status, code, message) => { throw new RoomError(status, code, message); };
export function hyakkiEventQuery(params) {
  const fields = ['after', 'limit', 'roomCode'];
  if ([...params.keys()].some(key => !fields.includes(key)) || fields.some(key => params.getAll(key).length > 1)
      || ['after', 'limit'].some(key => params.has(key) && !/^(?:0|[1-9]\d*)$/.test(params.get(key)))
      || params.has('roomCode') && !/^\d{6}$/.test(params.get('roomCode'))) fail(400, 'INVALID_EVENT_QUERY', '公开历史查询参数无效。');
  const after = Number(params.get('after') ?? 0), limit = Number(params.get('limit') ?? 30);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    fail(400, 'INVALID_EVENT_QUERY', '公开历史查询范围无效。');
  return { after, limit, roomCode: params.get('roomCode') };
}

/** Historical participants keep access; observers need a current room grant. */
export function createHyakkiEventHttp({ sessions, rooms, events, limit, reply } = {}) {
  if (!sessions?.authorize || !sessions?.assertCurrent || !rooms?.getGameContext || !events?.readPage
      || typeof limit !== 'function' || typeof reply !== 'function') throw new TypeError('Hyakki history HTTP requires current identity, room and event services.');
  return async function route({ req, res, url, webRequest }) {
    if (!url.pathname.startsWith('/api/hyakki/')) return false;
    const match = /^\/api\/hyakki\/matches\/([a-f0-9]{32})\/events$/.exec(url.pathname);
    if (!match) { reply(res, 404, { error: '公开历史接口不存在。' }); return true; }
    if (req.method !== 'GET') { reply(res, 405, { error: '公开历史只支持读取。' }, { Allow: 'GET' }); return true; }
    const query = hyakkiEventQuery(url.searchParams);
    const existingContext = identityCheckContextFor(webRequest), cancellation = new AbortController();
    const abort = () => cancellation.abort();
    const context = existingContext ?? createIdentityCheckContext({ now: sessions.now, signal: cancellation.signal,
      timeoutMs: Math.min(8000, sessions.authorizationTimeoutMs ?? 8000) });
    if (!existingContext) {
      req.once?.('aborted', abort); res.once?.('close', abort);
      if (req.aborted || res.destroyed || res.writableEnded) abort();
    }
    const wait = operation => context.wait(operation);
    try {
      const session = await wait(() => sessions.authorize(webRequest, { fresh: true, context }));
      limit(`user:${session.userKey}`, 120);
      const after = await wait(() => sessions.authorize(webRequest, { fresh: true, touch: false, context }));
      if (['id', 'userKey', 'issuer', 'sub'].some(field => after?.[field] !== session?.[field])) throw new IdentityFailure();
      if (session.authorizationLineage !== undefined && session.authorizationLineage !== after.authorizationLineage) throw new IdentityFailure(503);
      const output = await prepareCurrentRoomOutput({ sessions, session: after, context, prepare: async () => {
        const result = await wait(() => events.readPage({ matchId: match[1], after: query.after, limit: query.limit }));
        const guards = [...result.guards];
        if (!result.match.participants.some(player => player.userKey === after.userKey)) {
          if (!query.roomCode) fail(403, 'GAME_HISTORY_FORBIDDEN', '只有本局参赛者或当前观众可读公开历史。');
          const current = await wait(() => rooms.getGameContext(query.roomCode, after.userKey, { includeView: false }));
          if (current.gameType !== 'hyakki-trading' || current.roomId !== result.page.roomId || current.matchId !== match[1])
            fail(403, 'GAME_HISTORY_FORBIDDEN', '当前观战权限不包含这局历史。');
          guards.push(current.roomGuard, current.presenceGuard, ...(current.invitationGuard ? [current.invitationGuard] : []));
        }
        return { body: result.page, guards };
      } });
      context.assert(); reply(res, 200, output.body); return true;
    } catch (error) {
      if (error instanceof HyakkiEventError) throw new RoomError(error.status, error.code, error.message);
      throw error;
    } finally {
      if (!existingContext) { req.off?.('aborted', abort); res.off?.('close', abort); context.dispose(); }
    }
  };
}
