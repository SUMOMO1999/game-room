import { gamePath, entryStorageKey } from './entry-path.mjs';
import { accountState, accountGeneration, onAccountChange, reportAuthFailure } from './account-client.mjs';
import { storedGameType } from './games/types.mjs';
import { createRoomActionIntent } from './platform/room-action-intent.mjs';

const SESSION_PREFIX = entryStorageKey('friends-game-room.seat.');
const RECENT_KEY = entryStorageKey('friends-game-room.recent-seats.v1');
// The server pings every 20 seconds. Three silent intervals allow slow networks
// without leaving a half-open reader permanently reported as connected.
const STREAM_IDLE_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;
const streamTimeout = error => ['STREAM_OPEN_TIMEOUT', 'STREAM_RESPONSE_TIMEOUT', 'STREAM_IDLE_TIMEOUT'].includes(error?.code);
// Race the deadline as well as aborting the transport: a stalled body or a
// source that ignores AbortSignal must still release its page-owned controls.
async function boundedRequest(operation, controller, timeoutError) {
  let timer, abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(superseded());
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) { abort(); return; }
      timer = setTimeout(() => { reject(timeoutError()); controller.abort(); }, REQUEST_TIMEOUT_MS);
      Promise.resolve(operation()).then(resolve, reject);
    });
  } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
}
const unifiedSeats = new Map();
let membershipEpoch = accountGeneration();
onAccountChange(() => {
  if (membershipEpoch !== accountGeneration()) { unifiedSeats.clear(); membershipEpoch = accountGeneration(); }
});
const unified = () => accountState().mode !== 'legacy';
const superseded = () => new DOMException('登录或房间状态已更新，请重新进入。', 'AbortError');
const knownSeat = seat => { try { storedGameType(seat?.gameType); return true; } catch { return false; } };

export function normalizeCode(value) { return String(value || '').trim().toUpperCase(); }
export function loadMembership(code) {
  code = normalizeCode(code);
  if (unified()) return unifiedSeats.get(code) || recentSeats().find((entry) => entry.roomCode === code) || null;
  try { const seat = JSON.parse(sessionStorage.getItem(SESSION_PREFIX + code) || 'null'); return seat && knownSeat(seat) ? seat : null; } catch { return null; }
}
export function recentSeats() {
  if (unified()) return accountState().authenticated ? accountState().recentRooms : [];
  try {
    const data = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(data) ? data.filter(item => item && /^[A-Z0-9]{6}$/.test(item.roomCode) && typeof item.token === 'string' && knownSeat(item)).slice(0, 8) : [];
  } catch { return []; }
}
export function rememberMembership(data, name) {
  const seat = { roomCode: data.roomCode, playerId: data.playerId, name, at: Date.now() };
  const gameType=data.view?.gameType ?? data.gameType;
  if(gameType !== undefined) seat.gameType=storedGameType(gameType);
  if (unified()) {
    if (!accountState().authenticated) throw superseded();
    unifiedSeats.set(seat.roomCode, seat);
    return { ...seat };
  }
  seat.token = data.token;
  try { sessionStorage.setItem(SESSION_PREFIX + seat.roomCode, JSON.stringify(seat)); }
  catch { throw new Error('浏览器未允许保存座位，请允许本站存储后再进入房间。'); }
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([seat, ...recentSeats().filter(item => item.roomCode !== seat.roomCode || item.playerId !== seat.playerId)].slice(0, 8))); }
  catch { /* Refresh recovery still works via session storage. */ }
  return seat;
}
export function forgetMembership(code, playerId) {
  code = normalizeCode(code);
  if (unified()) { if (unifiedSeats.get(code)?.playerId === playerId) unifiedSeats.delete(code); return; }
  const seat = loadMembership(code);
  if (seat?.playerId === playerId) { try { sessionStorage.removeItem(SESSION_PREFIX + code); } catch {} }
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentSeats().filter(item => item.roomCode !== code || item.playerId !== playerId))); } catch {}
}
// Parsing owns no identity notification. Its late completion is harmless even
// when a transport ignores abort after the public wrapper has already settled.
async function rawApi(path, { method = 'GET', token, body, signal, onFailureStatus } = {}) {
  if (signal?.aborted) throw superseded();
  const epoch = accountGeneration();
  const account = accountState();
  const isUnified = account.mode !== 'legacy';
  const response = await fetch(gamePath(path), { method, signal, cache: 'no-store', credentials: 'same-origin', headers: {
    ...(!isUnified && token ? { Authorization: `Bearer ${token}` } : {}),
    ...(isUnified && method !== 'GET' && method !== 'HEAD' && account.csrf ? { 'X-CSRF-Token': account.csrf } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (signal?.aborted || epoch !== accountGeneration()) throw superseded();
  if (!response.ok && (response.status >= 400 && response.status < 500 || response.status === 503)) onFailureStatus?.(response.status);
  let data;
  try { data = await response.json(); }
  catch {
    if (signal?.aborted || epoch !== accountGeneration()) throw superseded();
    const error = Object.assign(new Error('房间响应暂时无法确认，请稍后重试。'), { status: response.status === 401 ? 401 : 503 });
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  if (signal?.aborted || epoch !== accountGeneration()) throw superseded();
  if (!response.ok) {
    const retryAfter = Number(data.retryAfter || response.headers.get('Retry-After'));
    const error = Object.assign(new Error(data.error || data.message || '暂时无法连接房间。'), { status: response.status, code: data.code,
      retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 86400 ? Math.ceil(retryAfter) : null,
      ...(data.code==='PREVIEW_RATE_LIMIT'?{minIntervalMs:data.minIntervalMs,nextAllowedAt:data.nextAllowedAt}:{}) });
    throw error;
  }
  return data;
}

// All entry points, including the first room read and lobby submissions, share
// one deadline across fetch and JSON. A caller's cancellation still fences it.
export async function api(path, { method = 'GET', token, body, signal } = {}) {
  if (signal?.aborted) throw superseded();
  const epoch = accountGeneration(), isUnified = unified(), controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const writing = !['GET', 'HEAD'].includes(method);
  let responseFailureStatus = null;
  try {
    const data = await boundedRequest(() => rawApi(path, { method, token, body, signal: controller.signal,
      onFailureStatus: status => { responseFailureStatus = status; } }), controller, () => {
      const status = responseFailureStatus ?? (writing ? null : 503);
      const message = status === 401 ? '登录已过期，请重新登录后继续。' : responseFailureStatus !== null
        ? '房间暂时无法确认这次请求，请稍后重试。' : writing
          ? '操作结果尚未确认，请稍后重试原操作。' : '房间暂时没有回应，请重新连接。';
      return Object.assign(new Error(message), { code: 'ROOM_REQUEST_TIMEOUT', ...(status === null ? {} : { status }) });
    });
    if (signal?.aborted || epoch !== accountGeneration()) throw superseded();
    return data;
  } catch (error) {
    // Notify after the bounded operation settles. A current 401/503 keeps its
    // status; an old caller or late failed body cannot invalidate a new login.
    if (signal?.aborted || epoch !== accountGeneration()) throw superseded();
    if (isUnified && [401, 503].includes(error.status)) reportAuthFailure(error);
    throw error;
  } finally { signal?.removeEventListener('abort', abort); }
}

export class RoomClient {
  constructor(code, membership, { onView, onConnection, onError, onChat = () => {}, onPreview = null }) {
    this.code = normalizeCode(code); this.membership = membership;
    this.onView = onView; this.onConnection = onConnection; this.onError = onError; this.onChat = onChat;
    this.onPreview = typeof onPreview==='function'?onPreview:null;this.previewPacket=null;this.previewTimer=null;this.previewSequences=new Map();
    this.view = null; this.stopped = false; this.controller = null; this.retryTimer = null;
    this.generation = 0; this.streamGeneration = 0; this.accountEpoch = accountGeneration();
    this.requests = new Set();
    this.actionIntent = null; this.actionInFlight = false;
    this.unsubscribeAccount = onAccountChange((account) => {
      if (this.stopped || this.accountEpoch === accountGeneration()) return;
      this.stop(); this.view = null; this.onConnection('offline');
      const error = Object.assign(new Error(account.failureStatus === 503 ? '登录状态暂时无法确认，请稍后重试。' : '请重新登录棋牌后恢复房间。'), { status: account.failureStatus || 401 });
      this.onError(error);
    });
  }
  epoch() { return { generation: this.generation, account: this.accountEpoch }; }
  live(epoch) { return !this.stopped && epoch.generation === this.generation && epoch.account === accountGeneration(); }
  async request(path, options, epoch) {
    if (!this.live(epoch)) throw superseded();
    const controller = new AbortController(); this.requests.add(controller);
    try {
      const data = await api(path, { ...options, signal: controller.signal });
      if (!this.live(epoch)) throw superseded();
      return data;
    } finally { this.requests.delete(controller); }
  }
  async refresh() {
    const epoch = this.epoch();
    const data = await this.request(`/api/rooms/${this.code}`, { token: this.membership.token }, epoch);
    this.receive(data.view || data, epoch);
    return this.view;
  }
  receive(view, epoch = this.epoch()) {
    if (!this.live(epoch) || !view || view.roomCode !== this.code || view.selfId !== this.membership.playerId) return;
    if (this.view && view.revision < this.view.revision) return;
    const previewFence=value=>JSON.stringify([value?.roomId,value?.matchId,value?.phase,value?.game?.revision,value?.game?.turnPlayerId]);
    if(previewFence(view)!==previewFence(this.view)) {this.resetPreview();this.previewSequences.clear();}
    if (Array.isArray(view.actionReceipts) && !this.actionIntent) {
      const owner = accountState().userKey || this.membership.playerId;
      let storage; try { storage = globalThis.sessionStorage; } catch { /* Memory fencing remains available. */ }
      this.actionIntent = createRoomActionIntent({ scope: { owner, roomId: view.roomId || view.roomCode, memberId: view.selfId },
        storage, key: entryStorageKey(`game-room.action-intent.${owner}.${view.roomId || view.roomCode}.${view.selfId}`) });
    }
    this.actionIntent?.reconcile(view);
    this.view = view; this.onView(view);
  }
  resetPreview() {
    clearTimeout(this.previewTimer);this.previewTimer=null;this.previewPacket=null;this.onPreview?.(null);
  }
  receivePreview(packet,epoch=this.epoch()) {
    if(!this.onPreview || !this.live(epoch) || !packet || packet.version!==1 || packet.roomCode!==this.code
      || packet.roomId!==this.view?.roomId || packet.matchId!==this.view?.matchId || packet.gameRevision!==this.view?.game?.revision
      || packet.turnPlayerId!==this.view?.game?.turnPlayerId || this.view?.phase!=='playing' || this.view?.gameType!=='rummikub') return;
    if(packet.preview) {
      if(packet.ownerId!==packet.turnPlayerId || !Number.isFinite(packet.expiresAt) || packet.expiresAt<=Date.now()
        || !Number.isSafeInteger(packet.sequence) || packet.sequence<1 || typeof packet.previewId!=='string') return;
      const previous=this.previewSequences.get(packet.previewId) || 0;
      if(packet.sequence<=previous) return;
      this.previewSequences.set(packet.previewId,packet.sequence);
      if(this.previewSequences.size>16) this.previewSequences.delete(this.previewSequences.keys().next().value);
    }
    this.resetPreview();this.previewPacket=packet;this.onPreview(packet);
    if(packet.preview) this.previewTimer=setTimeout(()=>this.resetPreview(),Math.min(30000,packet.expiresAt-Date.now()));
  }
  async readPreview() {
    const epoch=this.epoch(),packet=await this.request(`/api/rooms/${this.code}/preview`,{token:this.membership.token},epoch);
    this.receivePreview(packet,epoch);return packet;
  }
  async sendPreview(body) {
    if(!this.onPreview) throw new Error('本连接未启用桌面整理预览。');
    const epoch=this.epoch();
    try {return await this.request(`/api/rooms/${this.code}/preview`,{method:'POST',token:this.membership.token,body},epoch);}
    catch(error) {
      if(!this.live(epoch) || error.name==='AbortError') throw superseded();
      if(!error.status) {
        // The server may have accepted the public preview. Read its state,
        // never automatically replay this transient write.
        try {error.preview=await this.readPreview();} catch(readError) {if([401,503].includes(readError.status)) throw readError;}
        error.message='整理预览结果未确认，请查看当前牌面后再操作。';
      }
      throw error;
    }
  }
  clearPreview({previewId,sequence,matchId,gameRevision}) {return this.sendPreview({previewId,sequence,matchId,gameRevision,clear:true});}
  async chatHistory({ before, after, limit = 100 } = {}) {
    const epoch = this.epoch();
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set('before', String(before));
    if (after !== undefined) query.set('after', String(after));
    return this.request(`/api/rooms/${this.code}/chat?${query}`, { token: this.membership.token }, epoch);
  }
  async sendChat({ text, requestId }) {
    const epoch = this.epoch();
    return this.request(`/api/rooms/${this.code}/chat`, { method: 'POST', token: this.membership.token,
      body: { text, requestId } }, epoch);
  }
  async action(type, fields = {}) {
    const epoch = this.epoch();
    if (!this.live(epoch)) throw superseded();
    if (!this.view) throw new Error('正在恢复房间，请稍等。');
    if (this.actionIntent) {
      if (this.actionInFlight) throw Object.assign(new Error('正在确认操作，请稍等。'), { code: 'ACTION_PENDING' });
      return this.submitIntent(this.actionIntent.begin(type, fields, this.view), epoch);
    }
    const body = { ...fields, type, requestId: crypto.randomUUID(), expectedRevision: this.view.revision };
    let data;
    try { data = await this.request(`/api/rooms/${this.code}/actions`, { method: 'POST', token: this.membership.token, body }, epoch); }
    catch (error) {
      if ([401, 503].includes(error.status)) throw error;
      if (!this.live(epoch) || error.name === 'AbortError') throw superseded();
      // A missing response may follow a committed action. Reconcile by reading;
      // only a new explicit player action may submit another business write.
      if (!error.status || error.status === 409) {
        await this.refresh();
        if (!error.status) error.message = '操作结果未确认，已刷新牌局。请查看当前牌面后再操作。';
      }
      throw error;
    }
    this.receive(data.view, epoch); return data.view;
  }
  pendingAction() { return this.actionIntent?.pending() || null; }
  actionStorageReady() { return this.actionIntent?.available() ?? true; }
  async retryAction() {
    const epoch = this.epoch();
    if (!this.live(epoch)) throw superseded();
    if (this.actionInFlight) throw Object.assign(new Error('正在确认操作，请稍等。'), { code: 'ACTION_PENDING' });
    if (!this.actionIntent) throw new Error('没有待确认的操作。');
    // An explicit retry keeps all three: request ID, body and expected revision.
    return this.submitIntent(this.actionIntent.retry(), epoch);
  }
  async submitIntent(body, epoch) {
    this.actionInFlight = true;
    try {
      let data;
      try { data = await this.request(`/api/rooms/${this.code}/actions`, { method: 'POST', token: this.membership.token, body }, epoch); }
      catch (error) {
        if (!this.live(epoch) || [401, 503].includes(error.status) || error.name === 'AbortError') throw error;
        if (!error.status || error.status === 409) {
          await this.refresh();
          const receipt = this.view?.actionReceipts?.find(entry => entry.requestId === body.requestId);
          if (receipt?.status === 'committed') return this.view;
          if (receipt?.status === 'rejected') throw Object.assign(new Error(receipt.error?.message || '操作未执行。'), receipt.error);
        }
        if (error.status >= 400 && error.status < 500) this.actionIntent.clear();
        else error.message = '操作结果尚未确认，请恢复牌局或重试原操作。';
        throw error;
      }
      if (data?.left === true) { this.actionIntent.clear(); return null; }
      if (!data?.view || data.view.selfId !== this.membership.playerId || data.view.roomCode !== this.code) {
        throw Object.assign(new Error('操作结果尚未确认，请恢复牌局。'), { status: 503 });
      }
      this.receive(data.view, epoch); this.actionIntent.clear(); return this.view;
    } finally { this.actionInFlight = false; }
  }
  connect() {
    if (this.stopped || this.accountEpoch !== accountGeneration()) return;
    this.controller?.abort(); clearTimeout(this.retryTimer); this.retryTimer = null;
    const controller = new AbortController(); this.controller = controller;
    const streamGeneration = ++this.streamGeneration;
    const epoch = this.epoch();
    this.onConnection('connecting');
    this.readStream(controller, epoch, streamGeneration).catch(error => {
      if ((controller.signal.aborted && !streamTimeout(error)) || !this.live(epoch) || streamGeneration !== this.streamGeneration) return;
      this.onConnection('offline');
      this.resetPreview();
      if ([401, 503, 404,429].includes(error.status)) { this.onError(error); return; }
      this.retryTimer = setTimeout(() => { if (this.live(epoch)) this.connect(); }, 2000);
    });
  }
  async readStream(controller, epoch = this.epoch(), streamGeneration = this.streamGeneration) {
    const valid = () => this.live(epoch) && !controller.signal.aborted && streamGeneration === this.streamGeneration;
    if (!valid()) throw superseded();
    const isUnified = unified();
    let response;
    this.requests.add(controller);
    try {
      response = await boundedRequest(() => fetch(gamePath(`/api/rooms/${this.code}/events${this.onPreview?'?preview=1':''}`), { headers: {
        ...(!isUnified ? { Authorization: `Bearer ${this.membership.token}` } : {}),
      }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal }), controller,
      () => Object.assign(new Error('房间连接暂时没有回应，正在重新连接。'), { code: 'STREAM_OPEN_TIMEOUT' }));
      if (!valid()) throw superseded();
      if (!response.ok) {
        let data;
        try {
          data = await boundedRequest(() => response.json(), controller,
            () => Object.assign(new Error('房间连接暂时无法确认，请重新连接。'), { code: 'STREAM_RESPONSE_TIMEOUT', status: response.status }));
        } catch (error) {
          if (error.code === 'STREAM_RESPONSE_TIMEOUT') {
            if (isUnified && [401, 503].includes(error.status)) reportAuthFailure(error);
            throw error;
          }
          data = {};
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
        if (!valid()) throw superseded();
        const error = Object.assign(new Error(data.error || '房间连接已失效。'), { status: response.status });
        if (isUnified && [401, 503].includes(error.status)) reportAuthFailure(error);
        throw error;
      }
    } finally { this.requests.delete(controller); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
    let idleTimer = null, rejectRead = null;
    const abortRead = () => rejectRead?.(superseded());
    const renewDeadline = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!valid()) return;
        // Reject before aborting, so this transport timeout uses the ordinary
        // read-only reconnect path instead of looking like intentional stop().
        rejectRead?.(Object.assign(new Error('房间连接暂时没有回应，正在重新连接。'), { code: 'STREAM_IDLE_TIMEOUT' }));
        controller.abort();
      }, STREAM_IDLE_MS);
      idleTimer?.unref?.();
    };
    this.requests.add(controller);
    controller.signal.addEventListener('abort', abortRead);
    try {
      renewDeadline();
      this.onConnection('online');
      while (valid()) {
        const { value, done } = await new Promise((resolve, reject) => {
          rejectRead = reject;
          reader.read().then(resolve, reject);
        }).finally(() => { rejectRead = null; });
        if (!valid()) throw superseded();
        if (done) throw new Error('房间连接已断开。');
        // Fragments count as transport activity; empty chunks do not extend
        // the deadline. A ping is not an identity verification or a game view.
        if (value?.byteLength) renewDeadline();
        pending += decoder.decode(value, { stream: true });
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(pending))) {
          if (!valid()) throw superseded();
          const packet = pending.slice(0, separator.index); pending = pending.slice(separator.index + separator[0].length);
          if (packet.length > 1048576) throw new Error('房间消息格式无效。');
          const lines = packet.split(/\r?\n/);
          const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
          if (event !== 'view' && event !== 'closed' && event !== 'chat' && event !== 'preview') continue;
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) {
            const decoded = JSON.parse(data);
            const parsed = decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : {};
            if (event === 'closed') {
              this.resetPreview();
              const status = [401, 503, 404,429].includes(parsed.status) ? parsed.status : 404;
              const error = Object.assign(new Error(parsed.error || '房间已关闭。'), { status });
              if (isUnified && [401, 503].includes(status)) reportAuthFailure(error);
              throw error;
            }
            if(event==='preview') this.receivePreview(parsed,epoch);
            else if (event === 'chat') {
              if (isUnified && this.view?.roomId && parsed.roomId === this.view.roomId) this.onChat(parsed);
            } else this.receive(parsed.view || parsed, epoch);
          }
        }
        // A page of 100 chat messages can exceed 64 KiB. Keep a bounded 1 MiB
        // packet while permitting the supported UTF-8 text history size.
        if (pending.length > 1048576) throw new Error('房间消息格式无效。');
      }
    } finally {
      clearTimeout(idleTimer); controller.signal.removeEventListener('abort', abortRead);
      this.requests.delete(controller);
      // A source whose cancel promise hangs must not prevent the reconnect.
      reader.cancel().catch(() => {}); reader.releaseLock();
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.generation += 1;
    this.resetPreview();this.previewSequences.clear();
    this.controller?.abort();
    for (const controller of this.requests) controller.abort();
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.unsubscribeAccount?.();
  }
}
