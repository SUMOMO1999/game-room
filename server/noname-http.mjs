import { createHash } from 'node:crypto';
import { RoomError } from '../app/rooms.mjs';
import { IdentityFailure } from './auth.mjs';
import { entryPath } from './entry-context.mjs';
import { createIdentityCheckContext } from './identity-check-context.mjs';

const clientPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => new RoomError(400, 'NONAME_INPUT', '无名杀连接信息无效。');
const seatRequired = () => new RoomError(409, 'NONAME_SEAT', '请先在无名杀进入朋友的桌。');
const playerFor = userKey => createHash('sha256').update('noname-player\0' + userKey).digest('hex');

// The relay owns seats. No native room number, player name, or identity sent
// by a browser is ever interpreted as permission to join a call.
export function createNonameHttp({ bridge, gameOrigin, sessions, voice, readJson, limit, reply }) {
  const streams = new Map();
  let closed = false;
  const keyFor = (sessionId, clientId) => sessionId + '/' + clientId;
  function seatFor(session, clientId) {
    const seat = bridge.membership(session.id, clientId);
    if (!seat || seat.playerId !== playerFor(session.userKey)) throw seatRequired();
    return seat;
  }
  function openStream({ session, clientId, webRequest, res }) {
    const key = keyFor(session.id, clientId);
    streams.get(key)?.close();
    if (streams.size >= 1600) throw new RoomError(429, 'NONAME_BUSY', '联机大厅暂时繁忙。');
    const abort = new AbortController();
    let current = null, unsubscribe = null, checking = false, timer;
    let offeredVoice = false;
    const send = (name, value) => {
      if (!res.destroyed && !res.writableEnded) {
        if (!res.write('event: ' + name + '\ndata: ' + JSON.stringify(value) + '\n\n')) close();
      }
    };
    function close(revoke = false) {
      if (abort.signal.aborted) return;
      abort.abort();
      clearInterval(timer);
      streams.delete(key);
      // Loss of the notification connection alone does not end an authorized
      // call. Its existing 30-second lease expires unless this login reconnects.
      unsubscribe?.(!revoke);
      if (revoke && current) voice?.invalidateTerminal(current, clientId);
      if (!res.writableEnded) res.end();
    }
    function update() {
      if (abort.signal.aborted) return;
      const next = bridge.membership(session.id, clientId);
      if (current?.roomId !== next?.roomId) {
        unsubscribe?.();
        if (current) voice?.invalidateTerminal(current, clientId);
        current = next;
        unsubscribe = current && voice ? voice.subscribe(current, packet => send('voice', packet), () => close(true)) : null;
      }
      offeredVoice = Boolean(next && voice?.ready);
      send('seat', { roomId: next?.roomId ?? null, voice: offeredVoice });
    }
    // Renew the short media lease only after rechecking the original login.
    async function keepAlive() {
      if (checking || abort.signal.aborted) return;
      checking = true;
      const context = createIdentityCheckContext({ now: sessions.now, signal: abort.signal, timeoutMs: 8000 });
      try {
        const fresh = await context.wait(() => sessions.authorize(webRequest, { fresh: true, touch: false, context, signal: abort.signal }));
        if (fresh.id !== session.id || fresh.userKey !== session.userKey) throw new IdentityFailure();
        await context.wait(() => sessions.assertCurrent(fresh, { context }));
        context.assert();
        if (current && voice) voice.renew(seatFor(fresh, clientId));
        if (current && offeredVoice !== Boolean(voice?.ready)) update();
        if (!res.write(': online\n\n')) close();
      } catch { close(true); }
      finally { checking = false; context.dispose(); }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    res.once('close', () => close());
    streams.set(key, { close, update, sessionId: session.id });
    timer = setInterval(keepAlive, 15000);
    timer.unref();
    update();
    if (current && voice) voice.renew(current);
  }
  const unwatch = bridge.subscribe((current, previous) => {
    if (previous) voice?.invalidateTerminal(previous, previous.clientId);
    const seat = current ?? previous;
    streams.get(keyFor(seat.sessionId, seat.clientId))?.update();
  });
  async function route({ req, res, url, webRequest, entry, fence }) {
    if (!url.pathname.startsWith('/api/noname/')) return false;
    const match = /^\/api\/noname\/(launch|ticket|events|join|leave)\/([^/]+)$/.exec(url.pathname);
    if (!match || url.search || !clientPattern.test(match[2])) throw invalid();
    const [, action, clientId] = match;
    const method = ['launch', 'events'].includes(action) ? 'GET' : 'POST';
    if (method !== req.method) { reply(res, 405, { error: '请求方法不支持。' }, { Allow: method }); return true; }
    const session = await sessions.authorize(webRequest, { fresh: true, touch: false });
    limit('noname:' + session.userKey, 80);
    let input;
    if (method === 'POST') {
      sessions.checkWrite(webRequest, session);
      input = await readJson(req, 1024);
      const keys = Object.keys(input);
      if (action === 'leave' ? keys.length !== 1 || typeof input.id !== 'string' : keys.length !== 0) throw invalid();
    }
    let prepared;
    let existing;
    if (action === 'ticket' || action === 'launch') existing = await bridge.savedSeat?.(playerFor(session.userKey));
    if (action === 'join' || action === 'leave') {
      if (!voice?.ready) throw new RoomError(424, 'NONAME_VOICE', '房间语音暂时无法连接。');
      prepared = await voice.prepare(seatFor(session, clientId), action, { ...input, clientId });
    }
    // Nothing is minted or joined until the last async account check completes.
    if (sessions.usesBatchIdentity) await fence(session);
    else await sessions.assertCurrent(session);
    if (closed || res.destroyed || res.writableEnded) return true;
    if (action === 'launch') {
      reply(res, 200, {gameOrigin, returnToRoom:Boolean(existing)});
    } else if (action === 'ticket') {
      const ticket = bridge.issue(session.id, playerFor(session.userKey), clientId, { expiresAt: session.expiresAt });
      reply(res, 200, {ticket, managed:bridge.managed === true,
        seat:existing ? {id:existing.id, key:existing.key, nativeSeat:existing.nativeSeat, phase:existing.phase} : null});
    } else if (action === 'events') {
      openStream({ session, clientId, webRequest, res });
    } else {
      const result = voice.commit(prepared, seatFor(session, clientId));
      if (action === 'join') result.url = entry.origin.replace(/^http/, 'ws') + entryPath(entry, '/voice');
      reply(res, 200, result);
    }
    return true;
  }
  return {
    route, seatFor,
    invalidate(sessionId) {
      bridge.revokeSession(sessionId);
      for (const stream of streams.values()) if (stream.sessionId === sessionId) stream.close(true);
    },
    close() {
      if (closed) return;
      closed = true;
      unwatch();
      for (const stream of streams.values()) stream.close(true);
    },
  };
}
