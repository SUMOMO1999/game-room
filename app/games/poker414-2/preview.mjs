import { fixture, SCENES } from './test-support/preview-fixtures.mjs';
import { mountPoker414Page } from './page-ui.mjs';
import { mountRoomChat } from '../../room-chat.mjs';

// A deliberate exit also guards older preview entries in this tab's history.
// The landing page is the only explicit re-entry; this has no real room state.
let exited = false;
try {
  if (new URLSearchParams(location.search).get('enter') === '1') {
    sessionStorage.removeItem('p414-preview-exited');
    history.replaceState(null, '', location.pathname);
  }
  exited = sessionStorage.getItem('p414-preview-exited') === '1';
} catch {}
if (exited) location.replace('./');
else mountPreview();

function mountPreview() {
  const params = new URLSearchParams(location.search);
  let view = fixture(SCENES.some(([key]) => key === params.get('scene')) ? params.get('scene') : 'opening');
  let stopped = false, dealTimer = null, pollTimer = null;
  const ui = mountPoker414Page({ root: document.getElementById('p414-root'), preview: true, scenes: SCENES,
    onScene: showScene, onAction: action, onLeave: () => {
      try { sessionStorage.setItem('p414-preview-exited', '1'); } catch {}
      stop(); location.replace('./');
    },
  });
  const chat = mountRoomChat({ onCue: kind => ui.audio.play(kind), onUnavailable: error => ui.feedback(`本机聊天连接中断：${error.message}`) });
  async function chatRequest(query = '', body) {
    const response = await fetch(`/api/rooms/414000/chat${query}`, body ? { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || '本机聊天不可用'), { status: response.status });
    return data;
  }
  chat.attach({ chatHistory: fields => chatRequest(fields && Object.keys(fields).length ? `?${new URLSearchParams(fields)}` : ''), sendChat: fields => chatRequest('', fields) }, view,
    { mode: 'synthetic', authenticated:true, userKey:'preview-user' });
  chat.connection('online');
  let polling = false;
  pollTimer = setInterval(async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const packet = await chatRequest();
      if (!stopped) { if (!chat.model.online) chat.connection('online'); chat.receive(packet); }
    } catch { if (!stopped) chat.connection('offline'); }
    finally { polling = false; }
  }, 1500);

  function showScene(scene) {
    clearInterval(dealTimer); dealTimer = null;
    view = fixture(scene); ui.applyView(view);
    history.replaceState(null, '', `?scene=${encodeURIComponent(scene)}`);
  }
  function deal() {
    const final = fixture(view.players.length === 8 ? 'eight' : 'opening');
    view = { ...final, phase:'dealing', hand:[], players:final.players.map(player => ({...player, hand:[], count:0})) };
    let dealt = 0; ui.applyView(view); ui.audio.play('start');
    dealTimer = setInterval(() => {
      dealt += 18;
      for (let i = 0; i < view.players.length; i++) {
        const count = Math.min(final.players[i].hand.length, Math.floor(dealt / view.players.length) + (i < dealt % view.players.length ? 1 : 0));
        view.players[i] = { ...final.players[i], hand:final.players[i].hand.slice(0,count), count };
      }
      view.hand = view.players[0].hand;
      if (dealt >= 108) { clearInterval(dealTimer); dealTimer = null; view = final; ui.audio.play('turn'); }
      ui.applyView(view);
    }, 500);
  }
  function action(type, fields) {
    if (type === 'ready') { const self = view.players.find(player => player.id === view.selfId); self.ready = !self.ready; ui.applyView(view); return; }
    if (type === 'role') {
      if (view.selfRole === 'player') {
        if (view.spectators.length >= 8) { ui.feedback('观众席已满，不能转为观战。'); return; }
        const self = view.players.find(player => player.id === view.selfId);
        view.players = view.players.filter(player => player.id !== view.selfId);
        view.spectators = [...view.spectators, {id:self.id,name:self.name}];
        view.actionOrder = view.actionOrder.filter(id => id !== view.selfId); view.selfRole = 'spectator'; view.hand = [];
      } else {
        if (view.players.length >= 8) { ui.feedback('玩家席已满，可以继续观战。'); return; }
        const self = view.spectators.find(player => player.id === view.selfId);
        view.spectators = view.spectators.filter(player => player.id !== view.selfId);
        view.players = [...view.players,{id:self.id,name:self.name,ready:false,count:0,hand:[]}];
        view.actionOrder = [...view.actionOrder,view.selfId]; view.selfRole = 'player';
      }
      ui.applyView(view); return;
    }
    if (type === 'start') { deal(); return; }
    if (type === 'rematch') { showScene(view.players.length === 8 ? 'waiting-eight' : 'waiting'); return; }
    if (type === 'response-expired') return;
    ui.audio.play(({pass:'card-pass',hook:'card-hook',fork:'card-fork'})[type] || 'placement');
    ui.feedback(`小样操作：${({hook:'勾',fork:'叉',play:`出${fields.cardIds.length}张`,pass:'不出'})[type]}。当前仅验证交互，未提交真实牌局。`);
  }
  document.getElementById('p414-friend-message').addEventListener('click', async () => {
    ui.settings.close();
    try {
      const response = await fetch('/api/rooms/414000/preview-message', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'轮到你啦，试试这手牌！'}) });
      if (!response.ok) throw new Error('合成消息未发送');
      const packet = await response.json();
      if (!stopped) chat.receive({roomId:packet.roomId,messages:[packet.message],latestSequence:packet.message.chatSequence});
    } catch { if (!stopped) ui.feedback('本机合成消息未发送，请重试。'); }
  });
  function stop() { if (stopped) return; stopped = true; clearInterval(dealTimer); clearInterval(pollTimer); chat.clear(); ui.destroy(); }
  window.addEventListener('pagehide', event => { if (!event.persisted) stop(); });
  window.addEventListener('pageshow', () => {
    try { if (sessionStorage.getItem('p414-preview-exited') === '1') { stop(); location.replace('./'); } } catch {}
  });
  ui.applyView(view);

}
