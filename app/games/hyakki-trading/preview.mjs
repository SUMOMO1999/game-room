import { fixture, SCENES } from './test-support/preview-fixtures.mjs';
import { mountHyakkiPreviewPage } from './page-ui.mjs';
import { mountRoomChat, chatTextProblem } from '../../room-chat.mjs';

// Local-only UI fixture controller; no network room client or account tokens.
let exited = false;
try {
  if (new URLSearchParams(location.search).get('enter') === '1') sessionStorage.removeItem('hyakki-preview-exited');
  exited = sessionStorage.getItem('hyakki-preview-exited') === '1';
} catch {}
if (exited) location.replace('./');
else mountPreview();

function mountPreview() {
  let view = fixture(new URLSearchParams(location.search).get('scene'));
  let stopped = false, chat = null;
  const messages = [], requests = new Map();
  function append(text, peer = false, requestId) {
    const problem = chatTextProblem(text); if (problem) throw new Error(problem);
    if (messages.length >= 500) throw new Error('本地样板消息已满，重新进入可清空。');
    if (requestId && requests.has(requestId)) return requests.get(requestId);
    const now = Date.now();
    const message = { messageId: `sample-chat-${messages.length + 1}`, chatSequence: messages.length + 1, playerId: peer ? 'sample-p2' : 'sample-p1', name: peer ? '灯笼铺老板（示范）' : '我（示范）', text, sentAt: now, expiresAt: now + 86400000, ...(requestId ? { requestId } : {}) };
    messages.push(message); if (requestId) requests.set(requestId, message); return message;
  }
  append('这里的聊天在当前标签页内运行，不连接任何正式伙伴。', true);
  const packet = () => ({ roomId: view.roomId, messages: [...messages], latestSequence: messages.length, oldestSequence: 1, hasMore: false });
  const ui = mountHyakkiPreviewPage({ root: document.getElementById('hyakki-root'), scenes: SCENES,
    onScene: showScene, onAction: action, onPeerMessage: () => {
      if (view.scene === 'practice') { ui.feedback('练习样板不提供模拟联机聊天。'); return; }
      append('这单生意不错，轮到你啦！', true); chat.receive(packet());
    }, onLeave: () => {
      try { sessionStorage.setItem('hyakki-preview-exited', '1'); } catch {}
      stop(); location.replace('./');
    },
  });
  chat = mountRoomChat({ onCue: kind => ui.audio.play(kind), onUnavailable: error => ui.feedback(error.message) });
  const transport = {
    chatHistory: async ({ after, before, limit = 50 } = {}) => {
      const filtered = messages.filter(message => (!after || message.chatSequence > after) && (!before || message.chatSequence < before));
      return { ...packet(), messages: before ? filtered.slice(-limit) : after ? filtered.slice(0, limit) : filtered.slice(-limit), hasMore: filtered.length > limit };
    },
    sendChat: async ({ text, requestId }) => ({ roomId: view.roomId, message: append(text, false, requestId), retained: true }),
  };
  function attachChat() {
    if (view.scene === 'practice') { chat.clear(); return; }
    chat.attach(transport, view, { mode: 'synthetic', authenticated: true, userKey: 'hyakki-step0-user' });
    chat.connection('online');
    chat.receive(packet());
  }
  function showScene(scene) {
    const oldPractice = view.scene === 'practice'; view = fixture(scene); ui.applyView(view);
    history.replaceState(null, '', `${location.pathname}?scene=${encodeURIComponent(view.scene)}`);
    if (oldPractice !== (view.scene === 'practice')) attachChat();
    ui.feedback('本地合成局面已切换；没有创建或改动真实牌局。');
  }
  function action(type, fields) {
    if (type === 'ready') { view.players[0].ready = !view.players[0].ready; ui.applyView(view); return; }
    if (type === 'role') { view.selfRole = view.selfRole === 'player' ? 'spectator' : 'player'; ui.applyView(view); ui.feedback(view.selfRole === 'spectator' ? '样板已改为观战；不会获得私牌。' : '样板已加入玩家席。'); return; }
    if (type === 'start') { if (view.players.every(player => player.ready)) showScene('six'); return; }
    if (['recover', 'resume'].includes(type)) { showScene('active'); return; }
    const label = { draw: '摸牌', 'end-turn': '结束回合', buy: '买入', sell: '卖出', use: '使用行动牌', defend: '护符防御', 'decline-defense': '放弃防御', bid: '出价4两', 'pass-bid': '放弃竞价' }[type] || type;
    ui.audio.play(type === 'draw' ? 'draw' : ['defend', 'bid'].includes(type) ? 'turn' : 'placement');
    ui.feedback(`已演示「${label}」反馈。当前没有规则结算或真实资金变动。`);
  }
  function stop() { if (stopped) return; stopped = true; chat?.clear(); ui.destroy(); }
  window.addEventListener('pagehide', event => { if (!event.persisted) stop(); });
  window.addEventListener('pageshow', () => {
    try { if (sessionStorage.getItem('hyakki-preview-exited') === '1') { stop(); location.replace('./'); } } catch {}
  });
  ui.applyView(view); attachChat();
}
