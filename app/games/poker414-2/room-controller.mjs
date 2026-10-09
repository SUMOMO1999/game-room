import { createRoomSession, createRoomExit } from '../../platform/room-session.mjs';
import { toPoker414View, poker414Cues } from './presentation.mjs';

const business = new Set(['play', 'pass', 'hook', 'fork']);
const common = new Set(['ready', 'start', 'rematch', 'set-role', 'transferHost']);
const matchId = view => view?.matchId ?? view?.lastMatchResult?.matchId ?? null;

/** Owns this page's subscriptions and reply fences, never game rules or identity policy. */
export function createPoker414RoomController({ roomCode, document, window, ui, chat, RoomClient, api,
  accountState, accountGeneration, onAccountChange, loadAccount, watchAccountLifecycle,
  loginHref, reauthenticationHref, logoutAccount, forgetMembership, roomHref,
  agoraHref = 'https://agora.sumomoli.com/#projects' }) {
  let client = null, view = null, scores = null, scoreKey = null, scoreSequence = 0;
  let connection = 'offline', busy = false, leaving = false, baseline = true, seatScope = null, disposed = false;
  const session = createRoomSession({ document, accountGeneration, accountState, getClient: () => client });
  const render = () => { if (view) ui.applyView(toPoker414View(view, { scorePacket: scores, connection,
    pending: busy || leaving || client?.pendingAction() || false, canAct: client?.actionStorageReady() !== false })); };
  function clearPrivate(error = {}, { preserveDraft = error.status === 503 } = {}) {
    session.invalidate(); ++scoreSequence; client?.stop(); client = null; view = null; scores = null; scoreKey = null;
    chat.clear({ preserveDraft }); connection = 'offline'; busy = false; leaving = false; baseline = true;
    ui.conceal({ message: error.status === 401 ? '请重新登录，恢复原席位和已保存的对局。'
      : error.status === 503 ? '暂时无法核验账号。请重新连接，已保存的对局和积分不会被清除。'
        : error.status === 404 ? '房间或原席位已关闭，请返回大厅。' : error.message || '正在核验账号并恢复房间…',
    loginHref: error.status === 401 ? loginHref(`/?room=${roomCode}`) : null,
    reauthHref: error.status === 401 ? reauthenticationHref() : null, preserveSelection: preserveDraft });
  }
  function unavailable(error) {
    if ([401, 403, 404, 503].includes(error?.status)) clearPrivate(error.status === 403 ? { ...error, status: 404 } : error);
    else ui.feedback(error.message || '暂时没有收到确认，请先刷新核对。');
  }
  function scoreIdentity(value) {
    return JSON.stringify([value.roomId, value.selfId, matchId(value), value.phase,
      value.players.map(player => player.id), value.game?.result?.settledAt ?? null]);
  }
  async function refreshScores({ force = false } = {}) {
    const current = client, room = view;
    if (!current || !room) return;
    const key = scoreIdentity(room);
    if (!force && key === scoreKey) return;
    scoreKey = key;
    const sequence = ++scoreSequence, fence = session.capture(current);
    try {
      const packet = await current.request(`/api/rooms/${roomCode}/scores`, {}, current.epoch());
      if (!session.current(fence) || sequence !== scoreSequence || !view || key !== scoreIdentity(view)) return;
      if (packet.roomId !== view.roomId || packet.matchId !== matchId(view)) return;
      scores = packet; render();
    } catch (error) {
      if (!session.current(fence) || sequence !== scoreSequence) return;
      scoreKey = null;
      if ([401, 403, 404, 503].includes(error.status)) unavailable(error);
      else ui.feedback('累计积分暂未读取成功；可以刷新核对，不会重新结算。');
    }
  }
  function cues(previous, next) {
    if (baseline || !previous) return;
    if (previous.matchId !== next.matchId) {
      if (previous.phase === 'waiting' && next.game?.stage === 'dealing') ui.audio.play('start');
      return;
    }
    for (const cue of poker414Cues(previous.game, next.game, next.selfId, next.selfRole)) ui.audio.play(cue);
  }
  function boot(verifiedState) {
    return session.bootstrap(() => clearPrivate({}, { preserveDraft: true }), async task => {
      try {
        const state = verifiedState || await loadAccount();
        if (!session.current(task, { account: false, verified: false }) || state.verification !== 'verified') return;
        if (!/^\d{6}$/.test(roomCode)) { window.location.replace('./'); return; }
        if (!state.authenticated || state.mode === 'legacy') {
          clearPrivate({ status: state.failureStatus === 503 ? 503 : 401 }); return;
        }
        let first;
        try { first = (await api(`/api/rooms/${roomCode}`, { signal: task.controller.signal })).view; }
        catch (error) {
          if (!session.current(task)) return;
          if ([403, 404].includes(error.status)) { window.location.replace(`./?room=${roomCode}`); return; }
          throw error;
        }
        if (!session.current(task)) return;
        const scope = JSON.stringify([state.userKey, first.roomId, first.selfId]);
        if (seatScope !== null && scope !== seatScope) exit.reset();
        seatScope = scope;
        const next = new RoomClient(roomCode, { roomCode, playerId: first.selfId, userKey: state.userKey }, {
          onView(value) {
            if (!session.current(fence)) return;
            if (value.gameType !== 'poker414-2') { window.location.replace(roomHref(roomCode, value.gameType)); return; }
            cues(view, value); view = value; baseline = false; render(); void refreshScores();
            if (!next.actionStorageReady()) ui.feedback('无法保存操作记录，请允许本站存储后重新进入房间；仍可查看牌局或退出。');
          },
          onConnection(status) {
            if (!session.current(fence)) return;
            if (status !== 'online') baseline = true;
            connection = status; chat.connection(status); render();
          },
          onChat(packet) { if (session.current(fence)) chat.receive(packet); },
          onError(error) {
            if (!session.current(fence) || leaving && error.status === 404) return;
            if (error.status === 404 && view) forgetMembership(roomCode, view.selfId);
            unavailable(error);
          },
        });
        client = next;
        const fence = session.capture(next);
        next.receive(first);
        if (session.current(fence)) { chat.attach(next, next.view, state); next.connect(); }
      } catch (error) { if (session.current(task, { verified: false })) unavailable(error); }
    });
  }
  async function act(type, fields = {}) {
    const current = client, fence = session.capture(current);
    if (!current || !view || !session.current(fence) || connection !== 'online' || busy || leaving) throw new Error('请等待房间连接恢复。');
    if (!business.has(type) && !common.has(type)) throw new Error('未知的414操作。');
    const game = view.game;
    const body = business.has(type) ? { matchId: game?.matchId, roundId: game?.roundId, targetId: game?.target?.id ?? null,
      ...(type === 'play' ? { cardIds: [...(fields.cardIds || [])] } : {}),
      ...(['hook', 'fork'].includes(type) ? { windowId: game?.responseWindow?.id } : {}) } : fields;
    busy = true; render();
    try { return await current.action(type, body); }
    catch (error) { if (session.current(fence) && [401, 403, 404, 503].includes(error.status)) unavailable(error); throw error; }
    finally { if (session.current(fence)) { busy = false; render(); } }
  }
  async function readRoom() {
    const current = client, fence = session.capture(current);
    if (!current || !session.current(fence)) return lifecycle.refresh();
    try { await current.refresh(); if (session.current(fence)) await refreshScores({ force: true }); }
    catch (error) { if (session.current(fence)) unavailable(error); }
  }
  async function retry() {
    const current = client, fence = session.capture(current);
    if (!current || !session.current(fence) || busy || leaving) return;
    busy = true; render();
    try { await current.retryAction(); }
    catch (error) { if (session.current(fence)) unavailable(error); }
    finally { if (session.current(fence)) { busy = false; render(); } }
  }
  const exit = createRoomExit({ session, roomCode, getClient: () => client, getView: () => view, forgetMembership,
    requireAcknowledgement: true, onPending: () => { leaving = true; render(); },
    onFailure: error => { leaving = false; ui.leaveFailure(error.message); render(); },
    onLeft: () => { exit.reset(); seatScope = null; clearPrivate({ message: '已确认退出房间。' }); },
  });
  async function leave({ destination = 'lobby' } = {}) {
    const epoch = accountGeneration();
    if (!await exit.run() || accountGeneration() !== epoch) return false;
    if (destination === 'logout') {
      const task = logoutAccount(), logoutEpoch = accountGeneration();
      try { await task; } catch (error) {
        if (!disposed && accountGeneration() === logoutEpoch) unavailable(error);
        return false;
      }
      if (disposed || accountGeneration() !== logoutEpoch) return false;
    }
    window.location.replace(destination === 'agora' ? agoraHref : './'); return true;
  }
  const unsubscribe = onAccountChange(state => {
    if (!state.authenticated || client && client.accountEpoch !== accountGeneration()) clearPrivate({ status: state.failureStatus === 503 ? 503 : 401 });
  });
  const lifecycle = watchAccountLifecycle({ windowRef: window, documentRef: document,
    onSuspend: () => clearPrivate({ message: '正在重新核验账号…' }, { preserveDraft: true }),
    onVerified: state => { if (!client) void boot(state); }, onError: unavailable });
  function destroy() {
    if (disposed) return;
    disposed = true; lifecycle.stop(); unsubscribe(); session.destroy(); client?.stop(); chat.clear(); ui.destroy();
    window.removeEventListener('pagehide', pagehide);
  }
  function pagehide(event) { if (!event.persisted) destroy(); }
  window.addEventListener('pagehide', pagehide);
  return { start: () => lifecycle.refresh(), act, refresh: readRoom, retry, recover: () => lifecycle.refresh(),
    leave, unavailable, destroy };
}
