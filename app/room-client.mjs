import { gamePath, entryStorageKey } from './entry-path.mjs';
import { accountState, accountGeneration, onAccountChange, reportAuthFailure } from './account-client.mjs';

const SESSION_PREFIX = entryStorageKey('friends-game-room.seat.');
const RECENT_KEY = entryStorageKey('friends-game-room.recent-seats.v1');
const unifiedSeats = new Map();
let membershipEpoch = accountGeneration();
onAccountChange(() => {
  if (membershipEpoch !== accountGeneration()) { unifiedSeats.clear(); membershipEpoch = accountGeneration(); }
});
const unified = () => accountState().mode !== 'legacy';
const superseded = () => new DOMException('登录或房间状态已更新，请重新进入。', 'AbortError');

export function normalizeCode(value) { return String(value || '').trim().toUpperCase(); }
export function loadMembership(code) {
  code = normalizeCode(code);
  if (unified()) return unifiedSeats.get(code) || recentSeats().find((entry) => entry.roomCode === code) || null;
  try { return JSON.parse(sessionStorage.getItem(SESSION_PREFIX + code) || 'null'); } catch { return null; }
}
export function recentSeats() {
  if (unified()) return accountState().authenticated ? accountState().recentRooms : [];
  try {
    const data = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(data) ? data.filter(item => item && /^[A-Z0-9]{6}$/.test(item.roomCode) && typeof item.token === 'string').slice(0, 8) : [];
  } catch { return []; }
}
export function rememberMembership(data, name) {
  const seat = { roomCode: data.roomCode, playerId: data.playerId, name, at: Date.now() };
  const gameType=data.view?.gameType || data.gameType;
  if(['rummikub','army-flip'].includes(gameType)) seat.gameType=gameType;
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
export async function api(path, { method = 'GET', token, body, signal } = {}) {
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
  let data;
  try { data = await response.json(); }
  catch {
    if (signal?.aborted || epoch !== accountGeneration()) throw superseded();
    const error = Object.assign(new Error('房间响应暂时无法确认，请稍后重试。'), { status: response.status === 401 ? 401 : 503 });
    if (isUnified) reportAuthFailure(error);
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  if (signal?.aborted || epoch !== accountGeneration()) throw superseded();
  if (!response.ok) {
    const retryAfter = Number(data.retryAfter || response.headers.get('Retry-After'));
    const error = Object.assign(new Error(data.error || data.message || '暂时无法连接房间。'), { status: response.status, code: data.code,
      retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 86400 ? Math.ceil(retryAfter) : null,
      ...(data.code==='PREVIEW_RATE_LIMIT'?{minIntervalMs:data.minIntervalMs,nextAllowedAt:data.nextAllowedAt}:{}) });
    if (isUnified && [401, 503].includes(error.status)) reportAuthFailure(error);
    throw error;
  }
  return data;
}

export class RoomClient {
  constructor(code, membership, { onView, onConnection, onError, onChat = () => {}, onPreview = null }) {
    this.code = normalizeCode(code); this.membership = membership;
    this.onView = onView; this.onConnection = onConnection; this.onError = onError; this.onChat = onChat;
    this.onPreview = typeof onPreview==='function'?onPreview:null;this.previewPacket=null;this.previewTimer=null;this.previewSequences=new Map();
    this.view = null; this.stopped = false; this.controller = null; this.retryTimer = null;
    this.generation = 0; this.streamGeneration = 0; this.accountEpoch = accountGeneration();
    this.requests = new Set();
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
  connect() {
    if (this.stopped || this.accountEpoch !== accountGeneration()) return;
    this.controller?.abort(); clearTimeout(this.retryTimer); this.retryTimer = null;
    const controller = new AbortController(); this.controller = controller;
    const streamGeneration = ++this.streamGeneration;
    const epoch = this.epoch();
    this.onConnection('connecting');
    this.readStream(controller, epoch, streamGeneration).catch(error => {
      if (controller.signal.aborted || !this.live(epoch) || streamGeneration !== this.streamGeneration) return;
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
    const response = await fetch(gamePath(`/api/rooms/${this.code}/events${this.onPreview?'?preview=1':''}`), { headers: {
      ...(!isUnified ? { Authorization: `Bearer ${this.membership.token}` } : {}),
    }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!valid()) throw superseded();
    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch { data = {}; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      if (!valid()) throw superseded();
      const error = Object.assign(new Error(data.error || '房间连接已失效。'), { status: response.status });
      if (isUnified && [401, 503].includes(error.status)) reportAuthFailure(error);
      throw error;
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
    this.onConnection('online');
    try {
      while (valid()) {
        const { value, done } = await reader.read();
        if (!valid()) throw superseded();
        if (done) throw new Error('房间连接已断开。');
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
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
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
