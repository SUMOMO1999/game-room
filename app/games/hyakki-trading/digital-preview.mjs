import { digitalFixture, DIGITAL_SCENES, validPreviewChoice } from './test-support/digital-preview-fixtures.mjs';
import { mountDigitalPage } from './digital-page-ui.mjs';
import { mountRoomChat, chatTextProblem } from '../../room-chat.mjs';

/** Changes fixture scenes only; no game engine, network client or save API. */
export function nextPreviewScene(view, type, fields = {}) {
  if (view?.synthetic !== true || view.layoutOnly === true) return null;
  if (type === 'ready' || type === 'role') return view.phase === 'waiting' ? view.scene : null;
  if (type === 'start') return view.phase === 'waiting' && view.selfRole === 'player'
    && view.players.every(player => player.ready) ? 'active' : null;
  if (type === 'rematch') return view.phase === 'finished' ? 'waiting' : null;
  if (type === 'resume') return view.scene === 'paused' ? 'active' : null;
  if (type === 'recover') return view.scene === 'suspended' ? 'oracle' : null;
  const decision = view.decision;
  if (['keep-peek', 'discard-peek', 'respond', 'decline-response', 'choose-effect', 'bid', 'pass-bid'].includes(type)) {
    if (view.phase !== 'playing' || view.selfRole !== 'player' || decision?.actorId !== view.selfId || fields.decisionId !== decision.id) return null;
    const accepted = { peek: ['keep-peek', 'discard-peek'], response: ['respond', 'decline-response'],
      choose: ['choose-effect'], auction: ['bid', 'pass-bid'] }[decision.kind] ?? [];
    if (!accepted.includes(type)) return null;
    if (type === 'choose-effect' && (fields.selected?.length !== 1 || !validPreviewChoice(view, fields.selected[0]))) return null;
    if (type === 'bid' && (!Number.isSafeInteger(fields.amount) || fields.amount < decision.nextBid || fields.amount > decision.maxBid)) return null;
    return 'active';
  }
  if (view.phase !== 'playing' || view.selfRole !== 'player' || view.currentPlayerId !== view.selfId || decision) return null;
  if (type === 'peek') return 'peek';
  if (type === 'end-turn') return 'opponent';
  if (type === 'confirm-draft' && fields.scene === view.scene) {
    const owned = [...view.hand, ...(view.players.find(player => player.id === view.selfId)?.tools ?? [])].find(card => card.id === fields.cardId);
    if (!owned) return null;
    return { 'yousei.c02': 'oracle', 'yousei.t04': 'lamp', 'yousei.m02': 'hand-draft', 'yousei.c12': 'cards-auction',
      'yousei.c09': 'goods-auction', 'yousei.m05': 'goods-draft', 'yousei.m06': 'tools-draft' }[owned.definitionId] ?? 'active';
  }
  return null;
}

export function mountDigitalPreview({ root, window = root?.ownerDocument.defaultView, document = root?.ownerDocument,
  onExit = () => window.location.replace('./') } = {}) {
  if (!root || !window || !document) throw new TypeError('新版样板需要页面挂载点。');
  let view = digitalFixture(new URLSearchParams(window.location.search).get('scene'));
  let stopped = false, chat;
  const messages = [], receipts = new Map();
  function append(text, peer = false, requestId) {
    if (stopped) throw new DOMException('样板已关闭。', 'AbortError');
    const problem = chatTextProblem(text); if (problem) throw new Error(problem);
    if (requestId && receipts.has(requestId)) return receipts.get(requestId);
    if (messages.length >= 500) throw new Error('样板聊天已满；退出后重新进入即可清空。');
    const at = Date.now(), message = { messageId: `digital-sample-${messages.length + 1}`, chatSequence: messages.length + 1,
      playerId: peer ? 'digital-sample-p2' : view.selfId, name: peer ? '灯笼铺老板（合成）' : '我（合成）', text,
      sentAt: at, expiresAt: at + 86400000, ...(requestId ? { requestId } : {}) };
    messages.push(message); if (requestId) receipts.set(requestId, message); return message;
  }
  append('这是本机双成员聊天示例，没有连接真实伙伴。可以试试发送与消息气泡。', true);
  const packet = () => ({ roomId: view.roomId, messages: [...messages], latestSequence: messages.length, oldestSequence: 1, hasMore: false });
  const ui = mountDigitalPage({ root, scenes: DIGITAL_SCENES, onScene: showScene, onAction: act,
    onPeerMessage() { append('我这边货物摆好了，轮到你作选择啦。', true); chat.receive(packet()); },
    onLeave() { stop(); onExit(); },
  });
  chat = mountRoomChat({ documentRef: document, windowRef: window, onCue: cue => ui.audio.play(cue),
    onUnavailable: error => ui.feedback(error.message) });
  const transport = {
    async chatHistory({ before, after, limit = 50 } = {}) {
      const filtered = messages.filter(message => (!before || message.chatSequence < before) && (!after || message.chatSequence > after));
      return { ...packet(), messages: after ? filtered.slice(0, limit) : filtered.slice(-limit), hasMore: filtered.length > limit };
    },
    async sendChat({ text, requestId }) { return { roomId: view.roomId, message: append(text, false, requestId), retained: true }; },
  };
  function attachChat() {
    chat.attach(transport, view, { mode: 'synthetic', authenticated: true, userKey: 'hyakki-digital-step0-user' });
    chat.connection('online'); chat.receive(packet());
  }
  function showScene(scene) {
    if (stopped) return;
    const previousSelf = view.selfId; view = digitalFixture(scene); ui.applyView(view);
    window.history.replaceState(null, '', `${window.location.pathname}?scene=${encodeURIComponent(view.scene)}`);
    if (previousSelf !== view.selfId) attachChat();
    ui.feedback('已切换合成局面；没有创建、结算或保存正式牌局。');
  }
  function act(type, fields) {
    if (view.layoutOnly) { ui.feedback('这是只读布局演示；可查看公开商铺和牌文，不会执行交易或推进回合。'); return; }
    const scene = nextPreviewScene(view, type, fields);
    if (!scene) { ui.feedback('这个示例操作已不适用；当前步骤未被改变。'); return; }
    if (type === 'ready') { if (view.selfRole !== 'player') return; view.players[0].ready = !view.players[0].ready; ui.applyView(view); return; }
    if (type === 'role') { view.selfRole = view.selfRole === 'player' ? 'spectator' : 'player'; ui.applyView(view); return; }
    ui.audio.play(['respond', 'bid', 'choose-effect'].includes(type) ? 'turn' : type === 'peek' ? 'draw' : 'placement');
    showScene(scene); ui.feedback('已演示确认后的页面切换；没有执行真实银两或牌区结算。');
  }
  function stop() {
    if (stopped) return; stopped = true; chat?.clear(); ui.destroy();
    window.removeEventListener('pagehide', onPageHide);
  }
  function onPageHide(event) { if (!event.persisted) stop(); }
  window.addEventListener('pagehide', onPageHide);
  ui.applyView(view); attachChat();
  if (new URLSearchParams(window.location.search).get('panel') === 'decision') ui.openDecision();
  return { showScene, getView: () => structuredClone(view), destroy: stop };
}

const root = globalThis.document?.getElementById?.('hyakki-digital-root');
if (root) mountDigitalPreview({ root });
