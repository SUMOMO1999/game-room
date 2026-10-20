import { createRoomSession, createRoomExit } from './room-session.mjs';

const common = new Set(['ready', 'start', 'rematch', 'set-role', 'transferHost', 'configure', 'pause', 'resume']);
const matchId = view => view?.matchId ?? view?.lastMatchResult?.matchId ?? null;

/** Owns this page's subscriptions and reply fences, never game rules or identity policy. */
export function createCardRoomController({ policy, roomCode, document, window, ui, chat, RoomClient, api,
  accountState, accountGeneration, onAccountChange, loadAccount, watchAccountLifecycle,
  loginHref, reauthenticationHref, logoutAccount, forgetMembership, roomHref,
  agoraHref = 'https://agora.sumomoli.com/#projects' }) {
  if (!policy || typeof policy.gameType !== 'string' || !Array.isArray(policy.businessTypes)
      || typeof policy.command !== 'function' || typeof policy.cues !== 'function') throw new TypeError('房间控制器缺少玩法合同。');
  const business = new Set(policy.businessTypes);
  let client = null, view = null, historySequence = 0;
  let connection = 'offline', busy = false, leaving = false, baseline = true, seatScope = null, disposed = false;
  const session = createRoomSession({ document, accountGeneration, accountState, getClient: () => client });
  const render = () => { if (view) ui.applyView(view, { connection,
    pending: busy || leaving || client?.pendingAction() || false,
    canAct: Boolean(client && connection === 'online' && session.current(session.capture(client))
      && client.actionStorageReady() !== false) }); };
  function clearPrivate(error = {}, { preserveDraft = error.status === 503 } = {}) {
    session.invalidate(); ++historySequence; client?.stop(); client = null; view = null;
    chat.clear({ preserveDraft }); connection = 'offline'; busy = false; leaving = false; baseline = true;
    ui.conceal({ message: error.status === 401 ? '请重新登录，恢复原席位和已保存的对局。'
      : error.status === 503 ? '暂时无法核验账号。请重新连接，已保存的对局不会被清除。'
        : error.status === 404 ? '房间或原席位已关闭，请返回大厅。' : error.message || '正在核验账号并恢复房间…',
    loginHref: error.status === 401 ? loginHref(`/?room=${roomCode}`) : null,
    reauthHref: error.status === 401 ? reauthenticationHref() : null, preserveSelection: preserveDraft });
  }
  function unavailable(error) {
    if (disposed) return;
    if ([401, 403, 404, 503].includes(error?.status)) clearPrivate(error.status === 403 ? { ...error, status: 404 } : error);
    else ui.feedback(error.message || '暂时没有收到确认，请先刷新核对。');
  }
  async function history({ limit = 30 } = {}) {
    const current = client, room = view, sequence = ++historySequence;
    if (!current || !room || !matchId(room)) return null;
    const fence = session.capture(current), id = matchId(room);
    try {
      const packet = await current.request(`/api/history?limit=${Math.min(30, Math.max(1, Number(limit) || 30))}`, {}, current.epoch());
      if (!session.passive(fence) || sequence !== historySequence || !view || view.roomId !== room.roomId || matchId(view) !== id) return null;
      return packet;
    } catch (error) {
      if (session.passive(fence) && sequence === historySequence) unavailable(error);
      return null;
    }
  }
  function cues(previous, next) {
    if (baseline || !previous) return;
    if (previous.matchId !== next.matchId) {
      if (previous.phase === 'waiting' && next.game) ui.audio.play('start');
      return;
    }
    for (const cue of policy.cues(previous.game, next.game, next.selfId, next.selfRole)) ui.audio.play(cue);
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
        if (first.gameType !== policy.gameType) { window.location.replace(roomHref(roomCode, first.gameType)); return; }
        const scope = JSON.stringify([state.userKey, first.roomId, first.selfId]);
        if (seatScope !== null && scope !== seatScope) exit.reset();
        seatScope = scope;
        const next = new RoomClient(roomCode, { roomCode, playerId: first.selfId, userKey: state.userKey }, {
          onView(value) {
            if (!session.passive(fence)) return;
            if (value.roomId !== first.roomId || value.selfId !== first.selfId) { clearPrivate({ status: 404 }); return; }
            if (value.gameType !== policy.gameType) { window.location.replace(roomHref(roomCode, value.gameType)); return; }
            cues(view, value); view = value; baseline = false; render();
            if (!next.actionStorageReady()) ui.feedback('无法保存操作记录，请允许本站存储后重新进入房间；仍可查看牌局或退出。');
          },
          onConnection(status) {
            if (!session.passive(fence)) return;
            if (status !== 'online') baseline = true;
            connection = status; chat.connection(status); render();
          },
          onChat(packet) { if (session.passive(fence)) chat.receive(packet); },
          onError(error) {
            if (!session.passive(fence) || leaving && error.status === 404) return;
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
    if (current.pendingAction()) throw new Error('上一步结果尚未确认，请先刷新或重试原操作。');
    if (current.actionStorageReady() === false) throw new Error('无法保存操作记录，请允许本站存储后重新进入房间。');
    if (!business.has(type) && !common.has(type)) throw new Error('未知的游戏操作。');
    const game = view.game;
    const body = business.has(type) ? policy.command(game, type, fields) : structuredClone(fields);
    busy = true; render();
    try {
      const result = await current.action(type, body);
      if (!session.passive(fence)) throw Object.assign(new Error('页面或账号已变更，旧操作结果已隔离。'), { name: 'AbortError' });
      return result;
    }
    catch (error) { if (session.passive(fence) && [401, 403, 404, 503].includes(error.status)) unavailable(error); throw error; }
    finally { if (session.passive(fence)) { busy = false; render(); } }
  }
  async function readRoom() {
    const current = client, fence = session.capture(current);
    if (!current || !session.passive(fence)) return lifecycle.refresh();
    try { await current.refresh(); }
    catch (error) { if (session.passive(fence)) unavailable(error); }
  }
  async function retry() {
    const current = client, fence = session.capture(current);
    if (!current || !session.current(fence) || busy || leaving) return;
    busy = true; render();
    try { await current.retryAction(); }
    catch (error) { if (session.passive(fence)) unavailable(error); }
    finally { if (session.passive(fence)) { busy = false; render(); } }
  }
  const exit = createRoomExit({ session, roomCode, getClient: () => client, getView: () => view, forgetMembership,
    requireAcknowledgement: true, onPending: () => { leaving = true; render(); },
    onFailure: error => { leaving = false; ui.leaveFailure(error.message); render(); },
    onLeft: () => { exit.reset(); seatScope = null; clearPrivate({ message: '已确认退出房间。' }); },
  });
  async function leave({ destination = 'lobby', keepSeat = false } = {}) {
    // Leaving has its own acknowledged lifecycle request. An unresolved game
    // intent remains intact; it must not trap the player or be replayed here.
    if (leaving) { ui.leaveFailure('正在确认退出，请稍等。'); return false; }
    if (keepSeat) {
      destroy(); window.location.replace('./'); return true;
    }
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
    if (state.verification !== 'verified' || !state.authenticated || client && client.accountEpoch !== accountGeneration()) clearPrivate({ status: state.failureStatus === 503 ? 503 : 401 });
  });
  const lifecycle = watchAccountLifecycle({ windowRef: window, documentRef: document,
    onSuspend: () => clearPrivate({ message: '正在重新核验账号…' }, { preserveDraft: true }),
    onVerified: (state, { reason } = {}) => {
      if (!client) void boot(state);
      else if (reason === 'return' || reason === 'focus') void readRoom();
    }, onError: unavailable });
  function destroy() {
    if (disposed) return;
    disposed = true; lifecycle.stop(); unsubscribe(); session.destroy(); client?.stop(); chat.clear(); ui.destroy();
    window.removeEventListener('pagehide', pagehide);
  }
  function pagehide(event) { if (!event.persisted) destroy(); }
  window.addEventListener('pagehide', pagehide);
  return { start: () => lifecycle.refresh(), act, refresh: readRoom, retry, recover: () => lifecycle.refresh(),
    leave, history, unavailable, destroy };
}
