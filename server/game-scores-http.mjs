import { RoomError } from '../app/rooms.mjs';
import { IdentityFailure } from './auth.mjs';
import { ScoreError } from './game-scores.mjs';
import { createIdentityCheckContext, identityCheckContextFor } from './identity-check-context.mjs';
import { prepareCurrentRoomOutput } from './room-output-fence.mjs';

const fail = (status, code, message) => { throw new RoomError(status, code, message); };

/** Read-only delivery of room-scoped totals; neither account identities nor score writes come from clients. */
export function createGameScoresHttp({ sessions, rooms, scores, limit, reply } = {}) {
  if (!sessions?.authorize || !sessions?.assertCurrent || !rooms?.getGameContext || !scores?.prepareRoomRead
      || typeof limit !== 'function' || typeof reply !== 'function') throw new TypeError('Score HTTP requires current identity, room and score services.');
  return async function route({ req, res, url, webRequest }) {
    if (!/^\/api\/rooms\/[^/]+\/scores(?:\/|$)/.test(url.pathname)) return false;
    const match = /^\/api\/rooms\/(\d{6})\/scores$/.exec(url.pathname);
    if (!match) { reply(res, 404, { error: '积分接口不存在。' }); return true; }
    if (req.method !== 'GET') { reply(res, 405, { error: '积分接口只支持读取。' }, { Allow: 'GET' }); return true; }
    if ([...url.searchParams.keys()].some(key => key !== 'matchId') || url.searchParams.getAll('matchId').length > 1
        || url.searchParams.has('matchId') && !/^[a-f0-9]{32}$/.test(url.searchParams.get('matchId'))) fail(400, 'INVALID_SCORE_QUERY', '只可指定原对局编号读取积分。');
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
      // Verify membership before a second provider call. This grants no output yet.
      await wait(() => rooms.getGameContext(match[1], session.userKey, { includeView: false }));
      const after = await wait(() => sessions.authorize(webRequest, { fresh: true, touch: false, context }));
      if (['id', 'userKey', 'issuer', 'sub'].some(field => after?.[field] !== session?.[field])) throw new IdentityFailure();
      if (session.authorizationLineage !== undefined && session.authorizationLineage !== after.authorizationLineage) throw new IdentityFailure(503);
      const prepare = async () => {
        const current = await wait(() => rooms.getGameContext(match[1], session.userKey, { includeView: false }));
        const result = await wait(() => scores.prepareRoomRead({ roomId: current.roomId, roomVersion: current.roomRecord.version,
          matchId: url.searchParams.get('matchId') }));
        return { body: result.body, guards: [...result.guards, current.presenceGuard,
          ...(current.invitationGuard ? [current.invitationGuard] : [])] };
      };
      const output = await prepareCurrentRoomOutput({ sessions, session: after, context, prepare });
      context.assert(); reply(res, 200, output.body); return true;
    } catch (error) {
      if (error instanceof ScoreError) throw new RoomError(error.status, error.code, error.message);
      throw error;
    } finally {
      if (!existingContext) { req.off?.('aborted', abort); res.off?.('close', abort); context.dispose(); }
    }
  };
}
