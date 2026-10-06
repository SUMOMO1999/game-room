import { accountGeneration } from './account-client.mjs';
import { gameViewport } from './game-viewport.mjs';

const MAX_MESSAGES = 500;
const MAX_OUTBOX = 10;
const copy = (value) => structuredClone(value);
const aborted = () => new DOMException('聊天状态已更新。', 'AbortError');
const canonicalChatText = text => text.replace(/\r\n/g,'\n').normalize('NFC');

export function chatTextProblem(text) {
  if (typeof text !== 'string' || !text.trim()) return '写点什么再发送。';
  text=canonicalChatText(text);
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(text) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) return '消息包含无法显示的字符。';
  if ([...text].length > 500 || new TextEncoder().encode(text).length > 2048) return '每条消息最多 500 个字符。';
  if (text.split('\n').length > 3) return '每条消息最多 3 行。';
  return null;
}

// Chat has its own ordering and identity fence. It never changes the game view,
// revision, tile draft or connection ownership.
export class RoomChatModel {
  constructor({ onChange = () => {}, onUnavailable = () => {}, onNotify = () => {}, onSent = () => {}, getGeneration = accountGeneration,
    now = Date.now, requestId = () => crypto.randomUUID() } = {}) {
    this.onChange = onChange; this.onUnavailable = onUnavailable; this.onNotify = onNotify; this.onSent = onSent;
    this.getGeneration = getGeneration; this.now = now; this.requestId = requestId;
    this.version = 0; this.retained = null; this.transport = null; this.identity = null;
    this.reset();
  }
  reset() {
    this.messages = new Map(); this.outbox = new Map(); this.draft = ''; this.open = false;
    this.atLatest = true; this.unread = new Set(); this.online = false; this.loading = false;
    this.loadingOlder = false; this.hasOlder = false; this.historyTruncated = false;
    this.initialized = false; this.syncSequence = 0; this.oldestSequence = 0;
    this.latestSequence = 0; this.error = ''; this.notice = ''; this.historyTask = null;
  }
  snapshot() {
    this.expire();
    return { available: Boolean(this.identity), open: this.open, online: this.online,
      messages: [...this.messages.values()].sort((a, b) => a.chatSequence - b.chatSequence).map(copy),
      outbox: [...this.outbox.values()].map(copy), draft: this.draft, unread: this.unread.size,
      atLatest: this.atLatest, loading: this.loading, loadingOlder: this.loadingOlder,
      hasOlder: this.hasOlder, historyTruncated: this.historyTruncated,
      playerId: this.identity?.playerId || null, error: this.error, notice: this.notice };
  }
  changed() { this.onChange(this.snapshot()); }
  key(identity) { return identity ? `${identity.userKey}:${identity.roomId}:${identity.playerId}` : null; }
  bind(transport, identity) {
    ++this.version; this.transport = transport; this.reset(); this.identity = { ...identity, epoch: this.getGeneration() };
    if (this.retained?.key === this.key(identity)) {
      this.draft = this.retained.draft;
      this.outbox = new Map(this.retained.outbox.map((entry) => [entry.requestId, { ...entry, status: 'failed', error: '连接已恢复，可重试确认发送结果。' }]));
    }
    this.retained = null; this.changed();
  }
  clear({ preserveDraft = false } = {}) {
    if (preserveDraft && this.identity) {
      this.retained = { key: this.key(this.identity), draft: this.draft, outbox: [...this.outbox.values()].map(copy) };
    } else if (!preserveDraft) this.retained = null;
    ++this.version; this.transport = null; this.identity = null; this.reset(); this.changed();
  }
  epoch() { return { version: this.version, account: this.identity?.epoch }; }
  live(epoch) { return Boolean(this.identity && this.transport && epoch.version === this.version
    && epoch.account === this.getGeneration()); }
  setDraft(text) { if (this.identity) { this.draft = String(text); this.error = ''; this.changed(); } }
  setOpen(open) { this.open = Boolean(open && this.identity); if (this.open && this.atLatest) this.unread.clear(); this.changed(); }
  setAtLatest(value) { this.atLatest = Boolean(value); if (this.open && this.atLatest) this.unread.clear(); this.changed(); }
  jumpLatest() { this.atLatest = true; this.unread.clear(); this.changed(); }
  setConnection(state) {
    if (!this.identity) return;
    this.online = state === 'online'; this.changed();
    if (this.online) this.sync().catch(() => {});
  }
  expire() {
    const now = this.now();
    for (const [id, message] of this.messages) if (message.expiresAt <= now || message.chatSequence < this.oldestSequence) {
      this.messages.delete(id); this.unread.delete(id);
    }
  }
  message(value) {
    if (!value || typeof value.messageId !== 'string' || !value.messageId || value.messageId.length > 128
      || !Number.isSafeInteger(value.chatSequence) || value.chatSequence <= 0
      || typeof value.playerId !== 'string' || !value.playerId || value.playerId.length > 128
      || typeof value.name !== 'string' || value.name.length > 128 || chatTextProblem(value.text)
      || !Number.isSafeInteger(value.sentAt) || value.sentAt < 0 || value.sentAt > 8_640_000_000_000_000
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now() || value.expiresAt > 8_640_000_000_000_000) return null;
    const result = { messageId: value.messageId, chatSequence: value.chatSequence, playerId: value.playerId,
      name: value.name, text: value.text, sentAt: value.sentAt, expiresAt: value.expiresAt };
    // requestId is projected only to its author's own seat; never infer delivery
    // from a same-named player, matching body or client timestamp.
    if (value.playerId === this.identity?.playerId && typeof value.requestId === 'string') result.requestId = value.requestId;
    return result;
  }
  receive(packet, { history = false, before = false, countUnread = false } = {}) {
    if (!this.identity || this.identity.epoch !== this.getGeneration() || packet?.roomId !== this.identity.roomId || !Array.isArray(packet.messages)) return false;
    if (Number.isSafeInteger(packet.oldestSequence) && packet.oldestSequence > 0) this.oldestSequence = Math.max(this.oldestSequence, packet.oldestSequence);
    if (Number.isSafeInteger(packet.latestSequence) && packet.latestSequence >= 0) this.latestSequence = Math.max(this.latestSequence, packet.latestSequence);
    const wasInitialized = this.initialized, alerts = [], confirmations = [], epoch = this.epoch();
    let highest = 0;
    for (const value of packet.messages.slice(0, 100)) {
      const message = this.message(value); if (!message || message.chatSequence < this.oldestSequence) continue;
      const pending = message.requestId && this.outbox.get(message.requestId);
      if(pending && pending.text !== message.text)continue;
      highest = Math.max(highest, message.chatSequence);
      if (pending) {
        this.outbox.delete(message.requestId); this.notice = '已发送';
      }
      if (this.messages.has(message.messageId)) continue;
      // A sequence is immutable as well as its message id.
      if ([...this.messages.values()].some((known) => known.chatSequence === message.chatSequence)) continue;
      this.messages.set(message.messageId, message);
      // A local send gets one quiet confirmation only from a live acknowledgement.
      // History may settle a pending id, but must never replay a bubble on recovery.
      if (pending?.status === 'sending' && !history && this.online) confirmations.push(copy(message));
      if (wasInitialized && !history && this.online && message.playerId !== this.identity.playerId) alerts.push(copy(message));
      if (wasInitialized && (!history || countUnread) && message.playerId !== this.identity.playerId && (!this.open || !this.atLatest)) this.unread.add(message.messageId);
    }
    if (!wasInitialized && !before) {
      this.initialized = true; this.syncSequence = highest || packet.latestSequence || 0;
      this.hasOlder = packet.hasMore === true;
    } else if (before) this.hasOlder = packet.hasMore === true;
    this.historyTruncated ||= packet.historyTruncated === true;
    if (this.initialized) {
      if (this.oldestSequence > this.syncSequence + 1) { this.syncSequence = this.oldestSequence - 1; this.historyTruncated = true; }
      const known = new Set([...this.messages.values()].map((message) => message.chatSequence));
      while (known.has(this.syncSequence + 1)) ++this.syncSequence;
    }
    this.expire();
    const ordered = [...this.messages.values()].sort((a, b) => a.chatSequence - b.chatSequence);
    for (const message of ordered.slice(0, Math.max(0, ordered.length - MAX_MESSAGES))) { this.messages.delete(message.messageId); this.unread.delete(message.messageId); }
    this.changed();
    if (alerts.length && this.live(epoch)) { try { this.onNotify(alerts); } catch { /* Optional notices must not interrupt confirmed chat or game updates. */ } }
    if (confirmations.length && this.live(epoch)) { try { this.onSent(confirmations); } catch { /* The confirmed message is already retained. */ } }
    if (!history && this.initialized && this.online && this.syncSequence < this.latestSequence) this.sync().catch(() => {});
    return true;
  }
  failure(error, epoch) {
    if (!this.live(epoch) || error?.name === 'AbortError') return;
    if ([401, 403, 404, 503].includes(error?.status)) {
      this.clear({ preserveDraft: error.status === 503 }); this.onUnavailable(error); return;
    }
    this.error = error.message || '聊天暂时无法连接，请稍后重试。'; this.changed();
  }
  async sync() {
    if (!this.identity || !this.transport) return;
    if (this.historyTask) return this.historyTask;
    const epoch = this.epoch(); const transport = this.transport;
    this.loading = true; this.error = ''; this.changed();
    const task = Promise.resolve().then(async () => {
      try {
        let readLatest = false;
        if (!this.initialized) {
          const packet = await transport.chatHistory(); if (!this.live(epoch)) throw aborted();
          this.receive(packet, { history: true });
          readLatest = true;
        }
        // Bounded pages avoid an endless loop if a malformed server cursor stalls.
        for (let pages = 0; pages < 5 && (!readLatest || this.syncSequence < this.latestSequence); pages++) {
          const after = this.syncSequence;
          const packet = await transport.chatHistory({ after }); if (!this.live(epoch)) throw aborted();
          this.receive(packet, { history: true, countUnread: true });
          readLatest = true;
          if (this.syncSequence <= after || (!packet.hasMore && this.syncSequence >= this.latestSequence)) break;
        }
      } catch (error) { this.failure(error, epoch); }
      finally { if (this.live(epoch)) { this.loading = false; this.historyTask = null; this.changed(); } }
    });
    this.historyTask = task;
    return task;
  }
  async older() {
    if (!this.identity || !this.hasOlder || this.loadingOlder) return;
    const first = Math.min(...[...this.messages.values()].map((message) => message.chatSequence));
    if (!Number.isSafeInteger(first)) return;
    const epoch = this.epoch(); this.loadingOlder = true; this.atLatest = false; this.error = ''; this.changed();
    try {
      const packet = await this.transport.chatHistory({ before: first }); if (!this.live(epoch)) throw aborted();
      this.receive(packet, { history: true, before: true });
    } catch (error) { this.failure(error, epoch); }
    finally { if (this.live(epoch)) { this.loadingOlder = false; this.changed(); } }
  }
  async send(requestId) {
    if (!this.identity || !this.transport || !this.online) { this.error = '连接恢复后再发送。'; this.changed(); return; }
    let entry = requestId ? this.outbox.get(requestId) : null;
    if (requestId && !entry) return;
    if (entry?.status === 'sending') return;
    if (!entry) {
      // Match the server's canonical body once, before allocating an id. Retries
      // keep this exact body; composing text and the next draft stay untouched.
      const text = canonicalChatText(this.draft.trim()); const problem = chatTextProblem(text);
      if (problem) { this.error = problem; this.changed(); return; }
      if (this.outbox.size >= MAX_OUTBOX) { this.error = '请先确认或移除未发送的消息。'; this.changed(); return; }
      entry = { requestId: this.requestId(), text, status: 'sending', error: '' };
      this.outbox.set(entry.requestId, entry); this.draft = '';
    }
    entry.status = 'sending'; entry.error = ''; this.error = ''; this.notice = '';
    const epoch = this.epoch(); this.changed();
    try {
      const data = await this.transport.sendChat({ text: entry.text, requestId: entry.requestId });
      if (!this.live(epoch)) throw aborted();
      const confirmed = this.message(data.message);
      if (data.roomId !== this.identity.roomId || !confirmed || confirmed.playerId !== this.identity.playerId
        || confirmed.requestId !== entry.requestId || confirmed.text !== entry.text) throw new Error('发送结果暂时无法确认，请重试确认。');
      const retained = data.retained !== false && data.message.retained !== false;
      if (retained) this.receive({ roomId: data.roomId, messages: [data.message], latestSequence: data.message.chatSequence });
      this.outbox.delete(entry.requestId); this.notice = retained ? '已发送' : '已发送 · 原消息已超出当前历史范围'; this.changed();
    } catch (error) {
      if (!this.live(epoch) || error?.name === 'AbortError') return;
      // A trusted same-seat SSE acknowledgement can have arrived before a lost
      // HTTP response. Do not turn that confirmed message into a failed send.
      if (!this.outbox.has(entry.requestId)) return;
      entry.status = 'failed'; entry.error = error.status === 429
        ? `发送太快，${error.retryAfter ? `约 ${error.retryAfter} 秒后` : '稍后'}再试。`
        : error.message || '发送结果未确认，可重试。';
      this.failure(error, epoch); if (this.live(epoch)) this.changed();
    }
  }
  discard(requestId) { if (this.outbox.get(requestId)?.status !== 'sending') { this.outbox.delete(requestId); this.changed(); } }
}

/** New pages consume the shared composer structure, including keyboard layout
 * hooks. Existing static pages retain their compatible markup. */
export function roomChatMarkup() {
  return `<aside id="room-chat" class="room-chat" aria-labelledby="chat-title" hidden>
 <div class="chat-heading"><div><h2 id="chat-title">这一桌，聊两句。</h2><p>最近24小时 · 最多500条；新加入的朋友也能看到。</p></div><button id="chat-close" class="chat-close" type="button" aria-label="收起聊天">×</button></div>
 <div class="chat-history-tools"><button id="chat-older" class="text-button" type="button" hidden>更早的消息</button><span id="chat-truncated" hidden>部分旧消息已到期。</span></div>
 <ol id="chat-messages" class="chat-messages" aria-label="房间消息"></ol><button id="chat-latest" class="chat-latest" type="button" hidden>回到最新 ↓</button>
 <div id="chat-outbox" class="chat-outbox" aria-label="待确认消息"></div>
 <form id="chat-form" class="chat-form"><label class="visually-hidden" for="chat-input">给朋友的消息</label><textarea id="chat-input" rows="2" placeholder="说点什么…" aria-describedby="chat-counter chat-status" enterkeyhint="enter"></textarea><div class="chat-composer-bottom"><span id="chat-counter">0/500</span><button id="chat-send" class="primary-button" type="submit" disabled>发送</button></div></form>
 <div class="chat-status-row"><span id="chat-status" role="status" aria-live="polite"></span><button id="chat-reconnect" class="text-button" type="button" hidden>重新同步</button></div></aside>`;
}

export function mountRoomChat({ documentRef = document, windowRef = window, onUnavailable = () => {}, onCue = () => {}, storage = null } = {}) {
  const byId = (id) => documentRef.getElementById(id);
  const toggle = byId('chat-toggle'); const panel = byId('room-chat'); const list = byId('chat-messages');
  const input = byId('chat-input'); const form = byId('chat-form'); const older = byId('chat-older');
  const latest = byId('chat-latest'); const outbox = byId('chat-outbox'); const status = byId('chat-status');
  let restoringScroll = false; let previousSignature = ''; let lastState = null; let composing = false, compositionEpoch = null, discardCompositionInput = false;
  let awaitingStreamBaseline = true, previewTimer = null, previewEpoch = 0, notificationsSuspended = true, alertsMuted = false;
  let sentTimer = null, sentEpoch = 0, noticesFit = true, visibleChatHeight = windowRef.innerHeight;
  const setTimer = windowRef.setTimeout?.bind(windowRef) || globalThis.setTimeout;
  const clearTimer = windowRef.clearTimeout?.bind(windowRef) || globalThis.clearTimeout;
  try { storage ||= windowRef.localStorage || globalThis.localStorage; const preference=JSON.parse(storage?.getItem('game-room:chat-alerts:v1') || 'null'); alertsMuted=preference?.version===1 && preference.muted===true; } catch { /* Optional device preference. */ }
  const preview = element('aside','room-chat-notice'); preview.id='room-chat-notice'; preview.hidden=true; preview.setAttribute('aria-live','polite');
  const previewOpen = element('button','chat-notice-open'); previewOpen.type='button'; previewOpen.setAttribute('aria-label','打开房间聊天');
  const previewName = element('strong','chat-notice-name'), previewText = element('span','chat-notice-text'); previewOpen.append(previewName,previewText);
  const previewClose = element('button','chat-notice-close','×'); previewClose.type='button'; previewClose.setAttribute('aria-label','收起本条消息提醒');
  preview.append(previewOpen,previewClose); documentRef.body.append(preview);
  const sentPreview = element('aside','room-chat-notice room-chat-own-notice'); sentPreview.id='room-chat-own-notice'; sentPreview.hidden=true; sentPreview.setAttribute('aria-live','polite');
  const sentOpen = element('button','chat-notice-open'); sentOpen.type='button'; sentOpen.setAttribute('aria-label','消息已发送，打开房间聊天');
  const sentName = element('strong','chat-notice-name'), sentText = element('span','chat-notice-text'); sentOpen.append(sentName,sentText);
  const sentClose = element('button','chat-notice-close','×'); sentClose.type='button'; sentClose.setAttribute('aria-label','收起已发送消息');
  sentPreview.append(sentOpen,sentClose); documentRef.body.append(sentPreview);
  const alertsBar=element('div','chat-alerts-bar'), alertsToggle=element('button','chat-alerts-toggle'), alertsHint=element('span','','只影响此设备，未读照常保留');
  alertsToggle.id='chat-alerts-toggle'; alertsToggle.type='button'; alertsBar.append(alertsToggle,alertsHint); panel.querySelector('.chat-heading').querySelector('div').append(alertsBar);
  const model = new RoomChatModel({ onUnavailable, onChange: render, onNotify: notify, onSent: sent });
  function clearPreview() { ++previewEpoch; if(previewTimer!==null)clearTimer(previewTimer); previewTimer=null;preview.hidden=true;previewName.textContent='';previewText.textContent='';previewOpen.setAttribute('aria-label','打开房间聊天'); }
  function clearSent() { ++sentEpoch; if(sentTimer!==null)clearTimer(sentTimer); sentTimer=null;sentPreview.hidden=true;sentName.textContent='';sentText.textContent=''; }
  function clearNotices() { clearPreview();clearSent(); }
  function excerpt(text) { const plain=[...text.replace(/\s+/gu,' ').trim()];return plain.slice(0,72).join('')+(plain.length>72?'…':''); }
  function hidden() { return documentRef.hidden===true || documentRef.visibilityState==='hidden'; }
  function updateAlerts() { alertsToggle.textContent=alertsMuted?'消息提醒关':'消息提醒开'; alertsToggle.setAttribute('aria-pressed',String(!alertsMuted)); }
  function notify(messages) {
    if(notificationsSuspended || alertsMuted || hidden() || !model.identity || model.open || !model.online) return;
    const message=messages.at(-1); if(!message)return;
    updateViewport();
    clearPreview();const epoch=previewEpoch;
    previewName.textContent=message.name || '朋友';previewText.textContent=excerpt(message.text);
    previewOpen.setAttribute('aria-label',`${message.name || '朋友'}发来新消息，打开房间聊天`);preview.hidden=!noticesFit;
    try { onCue('chat'); } catch { /* Audio is optional. */ } previewTimer=setTimer(()=>{if(epoch===previewEpoch)clearPreview();},5500);previewTimer?.unref?.();
  }
  function sent(messages) {
    if(notificationsSuspended || hidden() || !model.identity || !model.online) return;
    const message=messages.at(-1);if(!message)return;
    updateViewport();
    clearSent();const epoch=sentEpoch;sentName.textContent='我 · 已发送';sentText.textContent=excerpt(message.text);
    // The open conversation already shows the full own bubble. Keep the quiet
    // table confirmation ready when it closes, without covering its controls.
    sentPreview.hidden=model.open || !noticesFit;sentTimer=setTimer(()=>{if(epoch===sentEpoch)clearSent();},5500);sentTimer?.unref?.();
  }
  function openChat() { clearPreview();model.setOpen(true);model.jumpLatest();list.scrollTop=list.scrollHeight; }
  previewOpen.addEventListener('click',openChat);previewClose.addEventListener('click',clearPreview);
  sentOpen.addEventListener('click',()=>{clearSent();openChat();});sentClose.addEventListener('click',clearSent);
  alertsToggle.addEventListener('click',()=>{alertsMuted=!alertsMuted;clearPreview();updateAlerts();try{storage?.setItem('game-room:chat-alerts:v1',JSON.stringify({version:1,muted:alertsMuted}));}catch{/* Preference is still effective in this window. */}});
  documentRef.addEventListener('visibilitychange',()=>{if(hidden()){notificationsSuspended=true;clearNotices();}});
  windowRef.addEventListener('pagehide',()=>{notificationsSuspended=true;clearNotices();});
  documentRef.addEventListener('pointerdown',event=>{if(event.target?.closest?.('[data-chat-dismiss-notices],.game-table,.rack,.army-table'))clearNotices();},{capture:true});
  updateAlerts();
  function element(tag, className, text) {
    const node = documentRef.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  function messageNode(message, state) {
    const node = element('li', `chat-message${message.playerId === state.playerId ? ' mine' : ''}`);
    node.dataset.messageId = message.messageId;
    const meta = element('div', 'chat-message-meta'); meta.append(element('strong', '', message.playerId === state.playerId ? `${message.name} · 我` : message.name));
    const time = element('time', '', new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    time.dateTime = new Date(message.sentAt).toISOString(); meta.append(time);
    node.append(meta, element('p', '', message.text)); return node;
  }
  function render(state) {
    lastState = state; updateDensity(state); if(!state.available){if(compositionEpoch)discardCompositionInput=true;composing=false;clearNotices();}else if(state.open)clearPreview();sentPreview.hidden=!state.available || state.open || !noticesFit || !sentText.textContent; toggle.classList.toggle('has-unread',Boolean(state.unread)); toggle.hidden = !state.available; panel.hidden = !state.available || !state.open;
    toggle.setAttribute('aria-expanded', String(state.open));
    byId('chat-unread').hidden = !state.unread; byId('chat-unread').textContent = state.unread > 99 ? '99+' : String(state.unread);
    toggle.setAttribute('aria-label', `房间聊天${state.unread ? `，${state.unread} 条未读消息` : ''}`);
    const nextSignature = JSON.stringify(state.messages);
    if (nextSignature !== previousSignature) {
      const oldHeight = list.scrollHeight; const oldTop = list.scrollTop;
      const anchor = [...list.children].find((node) => node.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
      const anchorId = anchor?.dataset.messageId; const anchorOffset = anchor ? anchor.getBoundingClientRect().top - list.getBoundingClientRect().top : 0;
      const nodes = state.messages.map((message) => messageNode(message, state));
      if (!nodes.length) nodes.push(element('li', 'chat-empty', state.loading ? '正在加载聊天…' : '和这一桌朋友说句话吧。'));
      restoringScroll = true; list.replaceChildren(...nodes); previousSignature = nextSignature;
      if (state.atLatest && !state.loadingOlder) list.scrollTop = list.scrollHeight;
      else {
        const retained = [...list.children].find((node) => node.dataset.messageId === anchorId);
        list.scrollTop = retained ? oldTop + retained.getBoundingClientRect().top - list.getBoundingClientRect().top - anchorOffset : oldTop + Math.max(0, list.scrollHeight - oldHeight);
      }
      queueMicrotask(() => { restoringScroll = false; });
    }
    outbox.replaceChildren(...state.outbox.map((entry) => {
      const row = element('div', 'chat-pending'); row.append(element('p', '', entry.text));
      const meta = element('div', 'chat-pending-actions', entry.status === 'sending' ? '发送中…' : entry.error);
      if (entry.status === 'failed') {
        const retry = element('button', 'text-button', '重试确认'); retry.type = 'button'; retry.disabled = !state.online;
        retry.addEventListener('click', () => model.send(entry.requestId));
        const discard = element('button', 'text-button', '移除'); discard.type = 'button'; discard.addEventListener('click', () => model.discard(entry.requestId));
        meta.append(retry, discard);
      }
      row.append(meta); return row;
    }));
    if (!composing && input.value !== state.draft) input.value = state.draft;
    input.disabled = !state.available;
    byId('chat-send').disabled = !state.available || !state.online || composing || Boolean(chatTextProblem(state.draft.trim()));
    const body=canonicalChatText(state.draft.trim()),problem=body ? chatTextProblem(body) : null;
    byId('chat-counter').textContent = `${[...body].length}/500${problem ? ` · ${problem}` : ''}`;
    older.hidden = !state.hasOlder; older.disabled = state.loadingOlder; older.textContent = state.loadingOlder ? '加载中…' : '更早的消息';
    latest.hidden = !state.open || state.atLatest; latest.textContent = state.unread ? `${state.unread} 条新消息 ↓` : '回到最新 ↓';
    byId('chat-truncated').hidden = !state.historyTruncated;
    status.textContent = state.error || (!state.online ? '重连中 · 可先写草稿' : state.loading ? '正在同步…' : state.notice || '已连接');
    byId('chat-reconnect').hidden = !state.error || !state.available;
  }
  toggle.addEventListener('click', () => { clearPreview(); if(model.open)input.blur();model.setOpen(!model.open); if (model.open && model.atLatest) list.scrollTop = list.scrollHeight; });
  byId('chat-close').addEventListener('click', () => { input.blur(); model.setOpen(false); toggle.focus({ preventScroll: true }); });
  input.addEventListener('input', () => {
    if(discardCompositionInput || compositionEpoch && !model.live(compositionEpoch)){discardCompositionInput=true;model.changed();return;}
    model.setDraft(input.value);
  });
  function cancelComposition() {
    if(compositionEpoch || composing){discardCompositionInput=true;composing=false;input.blur();}
  }
  function resumeEditing() {
    discardCompositionInput=false;
    if(compositionEpoch && !model.live(compositionEpoch)){compositionEpoch=null;composing=false;}
  }
  function finishComposition() {
    const epoch=compositionEpoch;composing=false;compositionEpoch=null;
    if(!discardCompositionInput && (!epoch || model.live(epoch)))model.setDraft(input.value);
    else {discardCompositionInput=true;model.changed();}
  }
  input.addEventListener('compositionstart',()=>{discardCompositionInput=false;composing=true;compositionEpoch=model.epoch();model.changed();});
  input.addEventListener('compositionend',finishComposition);
  input.addEventListener('blur',()=>{if(composing)finishComposition();});
  input.addEventListener('pointerdown',resumeEditing);
  input.addEventListener('keydown', (event) => {
    if(discardCompositionInput && !event.isComposing && event.keyCode!==229
      && (event.key?.length===1 || ['Backspace','Delete'].includes(event.key)))resumeEditing();
    if (composing || event.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); model.send(); }
    if (event.key === 'Escape') { event.stopPropagation(); input.blur(); model.setOpen(false); }
  });
  form.addEventListener('submit', (event) => { event.preventDefault(); if(!composing && !event.isComposing)model.send(); });
  older.addEventListener('click', () => model.older());
  latest.addEventListener('click', () => { model.jumpLatest(); list.scrollTop = list.scrollHeight; });
  byId('chat-reconnect').addEventListener('click', () => model.sync());
  list.addEventListener('scroll', () => {
    if (restoringScroll || !lastState?.open) return;
    const atLatest = list.scrollHeight - list.clientHeight - list.scrollTop < 36;
    if (atLatest !== model.atLatest) model.setAtLatest(atLatest);
  }, { passive: true });
  // Stop the game's document-level Escape handler from touching a tile draft.
  panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); if(!composing && !event.isComposing && event.keyCode!==229){input.blur(); model.setOpen(false);} } });
  const viewport = windowRef.visualViewport;
  function updateDensity(state = lastState) {
    const pending = Boolean(state?.outbox.length);
    panel.classList.toggle('chat-has-outbox', pending);
    // Pending messages need their own reachable scroll region, even when all
    // secondary controls are visible. Compress the composer before it overflows.
    panel.classList.toggle('chat-compact', visibleChatHeight < 360 || pending && visibleChatHeight < 500);
    panel.classList.toggle('chat-compressed', visibleChatHeight < 220 || pending && visibleChatHeight < 280);
  }
  const updateViewport = () => {
    const active=documentRef.activeElement;
    const editing=Boolean(active && (['INPUT','TEXTAREA','SELECT'].includes(active.tagName) || active.isContentEditable));
    const frame=gameViewport({width:windowRef.innerWidth,height:windowRef.innerHeight,visual:viewport,editing});
    panel.style.setProperty('--chat-viewport-height', `${frame.height}px`);
    panel.style.setProperty('--chat-viewport-top', `${frame.top}px`);
    panel.style.setProperty('--chat-viewport-left', `${frame.left}px`);
    panel.style.setProperty('--chat-viewport-width', `${frame.width}px`);
    visibleChatHeight = frame.height; updateDensity();
    panel.classList.toggle('chat-keyboard',editing && frame.height<windowRef.innerHeight-80);
    let noticeTop=frame.top+4;
    // A page may use display:contents for its header. Games declare actual
    // boxed controls rather than teaching the shared chat about their layout.
    for(const node of new Set([...documentRef.querySelectorAll('[data-chat-notice-anchor]'),documentRef.querySelector('.site-header'),documentRef.querySelector('.game-heading')])) {
      if(!node)continue;
      let visible=true;for(let ancestor=node;ancestor;ancestor=ancestor.parentNode)if(ancestor.hidden){visible=false;break;}
      const rect=node.getBoundingClientRect();if(visible && rect.width>0 && rect.height>0)noticeTop=Math.max(noticeTop,rect.bottom+4);
    }
    noticesFit=frame.height>=220 && noticeTop+60<=frame.top+frame.height-4;
    for(const node of [preview,sentPreview]) {
      node.style.setProperty('--chat-viewport-top',`${frame.top}px`);
      node.style.setProperty('--chat-viewport-left',`${frame.left}px`);
      node.style.setProperty('--chat-viewport-width',`${frame.width}px`);
      node.style.setProperty('--chat-notice-top',`${noticeTop}px`);
    }
    preview.hidden=!previewText.textContent || !noticesFit || model.open || alertsMuted || hidden() || notificationsSuspended || !model.online;
    sentPreview.hidden=!sentText.textContent || !noticesFit || model.open || hidden() || notificationsSuspended || !model.online;
  };
  viewport?.addEventListener('resize', updateViewport); viewport?.addEventListener('scroll', updateViewport);
  documentRef.addEventListener('focusin',updateViewport);
  documentRef.addEventListener('focusout',()=>queueMicrotask(updateViewport));
  for(const type of ['resize','pageshow','focus'])windowRef.addEventListener(type,updateViewport);
  updateViewport(); model.changed();
  windowRef.setInterval(() => {
    if (!model.identity) return;
    const count = model.messages.size; model.expire(); if (count !== model.messages.size) model.changed();
  }, 60_000);
  return { model,
    attach(client, view, account) {
      cancelComposition();clearNotices();composing=false;awaitingStreamBaseline=true;notificationsSuspended=hidden();
      byId('chat-legacy-note').hidden = account.mode !== 'legacy';
      if (account.mode === 'legacy' || !account.authenticated || !view?.roomId) { model.clear(); return; }
      model.bind(client, { roomId: view.roomId, roomCode: view.roomCode, playerId: view.selfId, userKey: account.userKey });
      model.sync().catch(() => {});
    },
    receive: (packet) => { if(awaitingStreamBaseline) { const received=model.receive(packet,{history:true,countUnread:model.initialized}); if(received)awaitingStreamBaseline=false;return received;} return model.receive(packet); },
    connection: (state) => { if(state!=='online'){awaitingStreamBaseline=true;clearNotices();} else if(!model.online)awaitingStreamBaseline=true;model.setConnection(state); },
    clear: (options) => { cancelComposition();notificationsSuspended=true;composing=false;awaitingStreamBaseline=true;clearNotices();byId('chat-legacy-note').hidden = true; model.clear(options); },
  };
}
