import { renderCard, renderCardDetails, renderGoodsIcon } from './card-ui.mjs';
import { mountArtFallback } from './art.mjs';
import { gamePath } from '../../entry-path.mjs';
import { GOODS, describeGoods } from './content.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountRoomSettings } from '../../platform/room-settings.mjs';
import { mountGameViewport } from '../../platform/room-viewport.mjs';
import { gameViewport } from '../../game-viewport.mjs';
import { roomChatMarkup } from '../../room-chat.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const button = (id, label, extra = '') => `<button type="button" id="${id}" ${extra}>${label}</button>`;
const isUrgent = view => ['defense', 'bidder'].includes(view?.scene);

/** Step 0 projection only: deliberate preview callbacks cannot submit game moves. */
export function mountHyakkiPreviewPage({ root, scenes, onScene, onAction, onLeave, onPeerMessage } = {}) {
  const document = root.ownerDocument, window = document.defaultView;
  root.innerHTML = `<div class="hy-shell">
    <header class="hy-header room-header"><div class="hy-brand"><strong>百鬼商会</strong><span>本地合成样板 · 房120006</span></div><div class="room-toolbar" data-chat-notice-anchor><div class="room-toolbar-actions">
      ${button('chat-toggle', '聊天 <span id="chat-unread" class="chat-unread" hidden></span>', 'class="chat-toggle room-toolbar-action" aria-controls="room-chat" aria-expanded="false" hidden')}${button('hy-settings', '设置', 'class="room-toolbar-action"')}${button('hy-exit', '×', 'class="room-toolbar-action room-toolbar-exit room-exit" aria-label="退出本地样板"')}
    </div></div></header>
    <div class="hy-layout"><aside class="hy-sidebar"><div class="hy-room-code"><span id="hy-room-label">示例房号</span><strong id="hy-code">120006</strong>${button('hy-invite', '复制邀请')}</div><div id="hy-roster" class="hy-roster" aria-label="固定行动顺序"></div><p id="hy-observers" class="hy-observers">8位示范观众</p></aside>
    <main class="hy-play-area"><section class="hy-market-board" aria-labelledby="hy-stage-title"><div class="hy-stage"><div><span class="hy-eyebrow" id="hy-stage-kind">夜市营业中</span><h1 id="hy-stage-title">轮到你经营</h1></div><div class="hy-clock"><strong id="hy-clock">02:06</strong><small id="hy-clock-note">回合余时示例</small></div></div>
      <div id="hy-market" class="hy-market" aria-label="公共市场库存"></div><div id="hy-scene-content" class="hy-scene-content"></div>
    </section>
    <section id="hy-hand-section" class="hy-hand-section" aria-label="我的手牌" data-chat-dismiss-notices><div class="hy-hand-heading"><div><strong id="hy-hand-label">我的手牌</strong><span id="hy-hand-count"></span></div><div class="hy-hand-tools"><label class="visually-hidden" for="hy-hand-filter">手牌类型</label><select id="hy-hand-filter"><option value="all">全部</option><option value="goods-card">货物牌</option><option value="action">行动牌</option></select>${button('hy-hand-prev', '‹', 'aria-label="上一页手牌"')}<span id="hy-hand-page"></span>${button('hy-hand-next', '›', 'aria-label="下一页手牌"')}</div></div><div id="hy-hand" class="hy-hand"></div></section>
    <section id="hy-action-bar" class="hy-action-bar" aria-label="本轮动作" data-chat-dismiss-notices><div class="hy-self-stats"><strong id="hy-money">32两</strong><span id="hy-capacity">2 / 6格</span><span id="hy-ap">4行动</span></div><div id="hy-actions" class="hy-actions"></div></section>
    <p id="hy-feedback" class="hy-feedback" role="status" aria-live="polite">仅检查资源与操作；不连接正式房间，不保存牌局。</p>
    </main></div></div>
    <div id="hy-urgent-dock" class="hy-urgent-dock" hidden aria-label="聊天中的当前回应"><strong id="hy-urgent-title"></strong><div id="hy-urgent-actions"></div></div>
    <dialog id="hy-options" class="hy-dialog"><div class="dialog-heading"><h2>设置</h2>${button('hy-options-close', '×', 'class="close-button" aria-label="关闭设置"')}</div><div class="hy-modal-response" data-modal-response hidden></div><div class="game-settings-body"><section><h3>本地样板</h3><p>全部房号、身份、牌面和聊天是合成示例，未接入规则引擎。时钟定格用于检查阅读，不是正式倒计时。</p><label for="hy-scene">检查局面</label><select id="hy-scene">${scenes.map(([id, title]) => `<option value="${id}">${escape(title)}</option>`).join('')}</select><div class="game-settings-controls">${button('hy-gallery', '120张完整图鉴')}${button('hy-peer-message', '模拟伙伴发言')}</div></section><section><h3>声音与玩法</h3><div class="game-settings-controls">${button('sound-toggle', '点按启声')}${button('hy-rules', '玩法说明')}</div><div class="sound-settings"><label for="sound-volume">音效音量</label><input type="range" id="sound-volume" min="0" max="100" step="5" value="45"><select id="sound-preview-kind" aria-label="试听声音"><option value="select">选牌</option><option value="draw">摸牌</option><option value="placement">买卖示例</option><option value="turn">本人回应</option><option value="chat">聊天</option><option value="win">结束</option></select>${button('sound-preview', '试听')}<span id="sound-preview-status" role="status"></span></div></section><section><h3>样板出口</h3><div class="game-settings-controls">${button('hy-leave-settings', '退出本地样板')}</div><p id="chat-legacy-note" hidden></p></section></div></dialog>
    <dialog id="hy-inspector" class="hy-dialog hy-inspector"><div class="dialog-heading"><h2 id="hy-inspector-title">查看卡牌</h2>${button('hy-inspector-close', '×', 'class="close-button" aria-label="关闭详情"')}</div><div class="hy-modal-response" data-modal-response hidden></div><div id="hy-inspector-content"></div></dialog>
    <dialog id="hy-leave" class="hy-dialog"><div class="dialog-heading"><h2>退出本地样板？</h2>${button('hy-leave-close', '×', 'class="close-button" aria-label="关闭退出确认"')}</div><p>这里只是合成页面。退出回到样板入口，没有正式席位或牌局需要清理。</p><div class="hy-dialog-actions">${button('hy-stay', '继续查看')}${button('hy-leave-confirm', '退出样板', 'class="hy-primary"')}</div></dialog>
    ${roomChatMarkup()}
    <section id="hy-rotation" class="hy-rotation" hidden aria-labelledby="hy-rotation-title"><svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><rect x="18" y="31" width="64" height="40" rx="7" stroke="currentColor" stroke-width="3"/><path d="M32 18a33 33 0 0 1 51 9m-1-15 2 16-16-1M68 85a33 33 0 0 1-51-9m1 15-2-16 16 1" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><h1 id="hy-rotation-title">横过来，展开百鬼夜市。</h1><p>桌游使用横屏布局，货物、伙伴与手牌可以同时看清。你选中的牌和聊天草稿会保留。</p><button type="button" id="hy-rotation-exit">退出本地样板</button><small>百鬼商会 · 本地资源与页面样板</small></section>`;
  const $ = id => document.getElementById(id), removers = [], audio = createGameAudio();
  let view = null, page = 0, pageSize = 4, selectedId = null, destroyed = false, renderSignature = '', feedbackTimer = null;
  const audioControls = mountRoomAudioControls({ audio, document });
  const unmountArtFallback = mountArtFallback(root);
  const settings = mountRoomSettings({ document, buttonId: 'hy-settings', dialogId: 'hy-options', closeButtonId: 'hy-options-close', dismissIds: ['hy-rules', 'hy-gallery', 'hy-leave-settings', 'hy-peer-message'] });
  const listen = (node, name, callback) => { node.addEventListener(name, callback); removers.push(() => node.removeEventListener(name, callback)); };
  function feedback(text) { $('hy-feedback').textContent = text; $('hy-feedback').classList.add('has-feedback'); window.clearTimeout(feedbackTimer); feedbackTimer = window.setTimeout(() => $('hy-feedback').classList.remove('has-feedback'), 4500); }
  function openDialog(id) { for (const node of document.querySelectorAll('dialog[open]')) node.close(); $(id).showModal(); }
  function closeInspector() { $('hy-inspector').close(); }
  function invoke(type, data = {}) { onAction?.(type, data); }
  const canAct = () => view && ['active', 'six', 'dense', 'practice'].includes(view.scene);
  const filteredHand = () => (view?.selfRole === 'spectator' ? [] : (view?.hand || [])).filter(card => $('hy-hand-filter').value === 'all' || ($('hy-hand-filter').value === 'action' ? card.kind !== 'goods-card' : card.kind === 'goods-card'));
  function cardDetail(card) {
    $('hy-inspector-title').textContent = card.name;
    $('hy-inspector-content').innerHTML = `${renderCardDetails(card)}<div class="hy-dialog-actions">${card.kind === 'goods-card' ? `<button type="button" data-sample-action="buy" ${canAct() ? '' : 'disabled'}>模拟买入 · ${card.buyPrice}两</button><button type="button" data-sample-action="sell" ${canAct() ? '' : 'disabled'}>模拟卖出 · ${card.sellPrice}两</button>` : `<button type="button" data-sample-action="use" ${canAct() && card.kind !== 'talisman' ? '' : 'disabled'}>模拟使用</button>`}</div><p class="hy-detail-note">${canAct() ? '本地交互示例；正式规则与目标选择在后续阶段接入。' : card.kind === 'talisman' && view.scene === 'defense' ? '这是反应牌。关闭详情后可在回应条使用护符。' : '现在仅查看。非本人回合不会提供买卖操作。'}</p>`;
    openDialog('hy-inspector');
  }
  function renderHand() {
    const cards = filteredHand(), pages = Math.max(1, Math.ceil(cards.length / pageSize)); page = Math.min(page, pages - 1);
    $('hy-hand-count').textContent = `${view?.selfRole === 'spectator' ? 0 : view?.hand.length ?? 0}张`;
    $('hy-hand-page').textContent = `${page + 1}/${pages}`;
    $('hy-hand-prev').disabled = page === 0; $('hy-hand-next').disabled = page >= pages - 1;
    const shown = cards.slice(page * pageSize, (page + 1) * pageSize);
    const signature = JSON.stringify([shown.map(card => card.id), selectedId]);
    if (signature !== renderSignature) {
      renderSignature = signature;
      $('hy-hand').innerHTML = shown.length ? shown.map(card => renderCard(card, { selected: card.id === selectedId, interactive: true })).join('') : '<p class="hy-empty-hand">这个分类没有手牌。</p>';
    }
  }
  function renderRoster() {
    $('hy-roster').innerHTML = view.players.map((player, index) => `<button type="button" class="hy-player${player.id === view.currentPlayerId ? ' is-current' : ''}${player.id === view.selfId ? ' is-self' : ''}" data-player-id="${player.id}" aria-label="第${index + 1}位，${escape(player.name)}，${player.money}两，查看摊位"><span class="hy-player-order">${index + 1}</span><span class="hy-player-copy"><strong title="${escape(player.name)}">${escape(player.name)}</strong><small>${view.phase === 'waiting' ? player.ready ? '已准备' : '未准备' : `${player.money}两 · ${player.goods.reduce((sum, good) => sum + good.count, 0)}/${player.capacity}格`}</small></span></button>`).join('');
  }
  function renderStage() {
    const texts = {
      active: ['轮到你经营', '先选一张凭据，买入或卖出货物。'], six: ['轮到你经营', '六位伙伴按左侧顺序依次经营。'], dense: ['120张手牌阅读检查', '按类型筛选或翻页；旋转屏幕保留选中牌。'], practice: ['本机练习页面样板', '这里只检查练习界面；完整电脑对手尚未实现。'],
      waiting: ['夜市即将开张', '2～6位玩家。准备后由房主开始，观众不会收到私牌。'], wait: ['灯笼铺老板正在经营', '对手手牌隐藏；可以查看市场和自己的牌。'],
      defense: ['有人想拿走你的黄瓜', '你有10秒使用护身符，或放弃防御。'], bidder: ['黑市第2件 · 轮到你报价', '当前3两。只能加1两；放弃后本件不能再次加入。'],
      'pending-leave': ['退出申请已记录', '这场三件拍卖结算后离席；已确认的报价仍要兑现。'], spectator: ['观战 · 灯笼铺老板经营', '只看公开市场、银两与摊位，不能查看其他人的手牌。'], paused: ['本局已暂停', '当前阶段和余时冻结；房主恢复后继续。'], offline: ['连接中断 · 保留当前画面', '恢复时先核对原操作。不会假称成功或重复扣款。'], result: ['百鬼收市 · 本局结束', '示范伙伴达到60两。以下仅为合成结算。'],
    };
    const [title, note] = texts[view.scene];
    $('hy-stage-title').textContent = title;
    $('hy-stage-kind').textContent = isUrgent(view) ? '需要你的回应' : view.scene === 'spectator' ? '公开视角' : '百鬼夜市 · 页面样板';
    $('hy-clock').textContent = isUrgent(view) ? `${view.countdown}秒` : view.phase !== 'playing' ? '—' : '02:06';
    $('hy-clock-note').textContent = isUrgent(view) ? '主动回合冻结02:06' : '定格时钟示例';
    $('hy-market-board')?.classList.toggle('is-urgent', isUrgent(view));
    $('hy-market').hidden = view.phase !== 'playing';
    $('hy-market').classList.toggle('is-auction', view.scene === 'bidder');
    if (view.scene === 'bidder') {
      const lot = view.currentCard;
      $('hy-market').setAttribute('aria-label', '当前公开拍品');
      $('hy-market').innerHTML = `<button type="button" id="hy-current-lot" class="hy-public-lot" aria-label="查看当前拍品：${escape(describeGoods(lot.goods))}，基础买${lot.buyPrice}两、卖${lot.sellPrice}两"><span class="hy-public-lot-face">${renderCard(lot, { interactive: false })}</span><span class="hy-public-lot-copy"><strong>第2件 · 货物凭据 <small>点开详情</small></strong><span class="hy-public-lot-data"><span>${escape(describeGoods(lot.goods))}</span><span>基础买 <b>${lot.buyPrice}</b> · 卖 <b>${lot.sellPrice}</b> 两</span></span></span></button>${button('hy-view-market', '库存', 'aria-label="查看全部公共市场库存"')}`;
    } else {
      $('hy-market').setAttribute('aria-label', '公共市场库存');
      $('hy-market').innerHTML = view.market.map(good => `<button type="button" class="hy-good" data-good-id="${good.id}" aria-label="${good.name}，库存${good.count}件，查看详情">${renderGoodsIcon(good.id)}<span>${good.name}</span><strong>${good.count}<small>件</small></strong></button>`).join('');
    }
    const content = $('hy-scene-content');
    if (view.phase === 'waiting') content.innerHTML = `<div class="hy-welcome"><span class="hy-night-seal" aria-hidden="true">商</span><h2>今晚，一起做生意。</h2><p>${note}</p><strong>示例房号 ${view.roomCode}</strong><div class="hy-dialog-actions">${view.selfRole === 'player' ? button('hy-ready', view.players[0].ready ? '取消准备' : '准备好了', 'class="hy-primary"') : '<strong>你正在观战</strong>'}${button('hy-start', '开始样板', `${view.selfRole === 'player' && view.players.every(player => player.ready) ? '' : 'disabled'}`)}${button('hy-watch', view.selfRole === 'player' ? '改为观战' : '加入对局')}${button('hy-waiting-invite', '复制邀请')}</div><small>全部合成数据 · 不会创建真实对局</small></div>`;
    else if (view.phase === 'result') content.innerHTML = `<div class="hy-results"><h2>这一夜，满载而归。</h2><p>${note}</p><div>${view.players.map((player, index) => `<p><span>${index + 1}. ${escape(player.name)}</span><strong>${index === 0 ? 64 : player.money}两</strong></p>`).join('')}</div>${button('hy-rematch', '回准备室', 'class="hy-primary"')}</div>`;
    else content.innerHTML = `<div class="hy-market-story"><div><span class="hy-night-seal" aria-hidden="true">${isUrgent(view) ? view.scene === 'defense' ? '守' : '拍' : '市'}</span><p>${note}</p></div>${isUrgent(view) ? `<span class="hy-effect-tag">${view.scene === 'defense' ? '顺手牵羊 → 你的黄瓜×1' : '当前拍品：货物凭据 · 下个报价4两'}</span>` : '<span class="hy-effect-tag">公共市场 · 每种货物共20件</span>'}</div>`;
    content.title = note;
  }
  function actionMarkup() {
    const action = (type, label, primary = false) => `<button type="button" data-sample-action="${type}"${primary ? ' class="hy-primary"' : ''}>${label}</button>`;
    if (view.scene === 'defense') return action('defend', '护符防御', true) + action('decline-defense', '放弃');
    if (view.scene === 'bidder') return action('bid', '出价4两', true) + action('pass-bid', '放弃');
    if (canAct()) return action('draw', '摸牌', true) + action('end-turn', '结束回合');
    if (view.scene === 'paused') return action('resume', '恢复样板', true);
    if (view.scene === 'offline') return action('recover', '模拟恢复', true);
    return `<span class="hy-passive-label">${view.selfRole === 'spectator' ? '观战中' : view.scene === 'pending-leave' ? '等待结算后离席' : '等待伙伴'}</span>`;
  }
  function syncUrgentChat() {
    const open = !$('room-chat').hidden && isUrgent(view);
    document.body.classList.toggle('hy-urgent-chat', open);
    $('hy-urgent-dock').hidden = !open;
    if (open) { $('hy-urgent-title').textContent = `${view.scene === 'defense' ? '你的防御' : '轮到你报价'} · ${view.countdown}秒`; $('hy-urgent-actions').innerHTML = actionMarkup(); }
  }
  function applyView(next) {
    if (destroyed) return;
    const changed = view?.scene !== next.scene; view = next;
    if (changed) { page = 0; selectedId = null; $('hy-hand-filter').value = 'all'; }
    root.dataset.scene = view.scene; root.classList.toggle('hy-waiting', view.phase !== 'playing');
    $('hy-room-label').textContent = view.scene === 'practice' ? '练习页面样板' : '示例房号';
    $('hy-code').hidden = view.scene === 'practice'; $('hy-invite').hidden = view.scene === 'practice';
    $('hy-observers').textContent = view.scene === 'practice' ? '尚未接入电脑规则' : `${view.players.length}人 · ${view.spectatorCount}位示范观众`;
    $('hy-scene').value = view.scene;
    $('hy-hand-section').hidden = view.phase !== 'playing' || view.selfRole === 'spectator';
    $('hy-action-bar').hidden = view.phase !== 'playing';
    const self = view.players[0];
    $('hy-money').textContent = view.selfRole === 'spectator' ? '公开观战' : `${self.money}两`;
    $('hy-capacity').textContent = view.selfRole === 'spectator' ? '无私牌' : `${self.goods.reduce((sum, good) => sum + good.count, 0)}/${self.capacity}格`;
    $('hy-ap').textContent = view.selfRole === 'spectator' ? '只读' : `${view.actionPoints}行动`;
    $('hy-actions').innerHTML = actionMarkup();
    for (const dock of root.querySelectorAll('[data-modal-response]')) { dock.hidden = !isUrgent(view); dock.innerHTML = isUrgent(view) ? `<strong>${view.scene === 'defense' ? '你的防御' : '轮到你报价'} · ${view.countdown}秒</strong><div>${actionMarkup()}</div>` : ''; }
    renderRoster(); renderStage(); renderHand(); resize(); syncUrgentChat();
  }
  function resize() {
    if (destroyed) return;
    const frame = gameViewport({ width: window.innerWidth, height: window.innerHeight, visual: window.visualViewport, editing: document.activeElement?.matches('input,textarea') });
    document.documentElement.style.setProperty('--hy-height', `${frame.height}px`);
    document.documentElement.style.setProperty('--hy-top', `${frame.top}px`);
    document.body.classList.toggle('hy-keyboard', frame.height < window.innerHeight - 80);
    const portrait = window.innerWidth < window.innerHeight;
    $('hy-rotation').hidden = !portrait;
    root.querySelector('.hy-shell').inert = portrait;
    if (portrait) { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); document.activeElement?.blur?.(); }
    document.body.classList.toggle('hy-portrait', portrait);
    const width = $('hy-hand').clientWidth;
    const cardWidth = parseFloat(window.getComputedStyle($('hy-hand')).getPropertyValue('--hyakki-card-width')) || 112;
    const nextSize = Math.max(1, Math.floor((width + 8) / (cardWidth + 8)));
    if (nextSize !== pageSize) {
      const oldFirst = page * pageSize; pageSize = nextSize;
      const selectedIndex = filteredHand().findIndex(card => card.id === selectedId);
      page = Math.floor((selectedIndex >= 0 ? selectedIndex : oldFirst) / pageSize);
      renderHand();
    }
    if (frame.resetScroll && (window.scrollX || window.scrollY)) window.scrollTo(0, 0);
  }
  function inspector(title, html) { $('hy-inspector-title').textContent = title; $('hy-inspector-content').innerHTML = html; openDialog('hy-inspector'); }
  listen(root, 'click', event => {
    const node = event.target.closest('button'); if (!node || node.disabled) return;
    if (node.dataset.cardId) {
      const card = (view?.hand || []).find(candidate => candidate.id === node.dataset.cardId);
      if (card) { selectedId = card.id; renderHand(); audio.play('select'); cardDetail(card); }
    } else if (node.dataset.sampleAction) { closeInspector(); invoke(node.dataset.sampleAction, { cardId: selectedId }); }
    else if (node.dataset.playerId) {
      const player = view.players.find(candidate => candidate.id === node.dataset.playerId);
      inspector(player.name, `<p>${player.money}两 · 已用${player.goods.reduce((sum, good) => sum + good.count, 0)} / ${player.capacity}格</p><div class="hy-inventory">${player.goods.map(good => `<div>${renderGoodsIcon(good.id)}<span>${GOODS.find(item => item.id === good.id).name}</span><strong>×${good.count}</strong></div>`).join('')}</div><p>公开摊位；不展示对方的手牌。</p>`);
    } else if (node.dataset.goodId) {
      const good = view.market.find(candidate => candidate.id === node.dataset.goodId);
      inspector(good.name, `<div class="hy-good-detail">${renderGoodsIcon(good.id)}<h3>${good.name} · 库存${good.count}件</h3><p>${escape(good.description)}</p><p>凭据会明确显示这种货物的件数。卡图加载失败也保留名称和数量。</p></div>`);
    } else if (node.id === 'hy-ready') invoke('ready');
    else if (node.id === 'hy-start') invoke('start');
    else if (node.id === 'hy-watch') invoke('role');
    else if (node.id === 'hy-rematch') onScene('waiting');
    else if (node.id === 'hy-waiting-invite') $('hy-invite').click();
    else if (node.id === 'hy-current-lot') {
      inspector('当前拍品 · 第2件', `${renderCardDetails(view.currentCard)}<p class="hy-detail-note">这是正在拍卖的公开牌，不是你的手牌。可在上方回应条加价或放弃；未轮到的拍品不会揭示。</p>`);
    } else if (node.id === 'hy-view-market') {
      inspector('公共市场库存', `<div class="hy-inventory">${view.market.map(good => `<div>${renderGoodsIcon(good.id)}<span>${good.name}</span><strong>${good.count}件</strong></div>`).join('')}</div><p>这里只展示六种货物的公开库存。</p>`);
    }
  });
  listen($('hy-scene'), 'change', event => { settings.close(); onScene(event.target.value); });
  listen($('hy-hand-filter'), 'change', () => { page = 0; renderHand(); });
  listen($('hy-hand-prev'), 'click', () => { page = Math.max(0, page - 1); renderHand(); });
  listen($('hy-hand-next'), 'click', () => { page += 1; renderHand(); });
  listen($('hy-inspector-close'), 'click', closeInspector);
  for (const id of ['hy-exit', 'hy-leave-settings']) listen($(id), 'click', () => openDialog('hy-leave'));
  for (const id of ['hy-leave-close', 'hy-stay']) listen($(id), 'click', () => $('hy-leave').close());
  listen($('hy-leave-confirm'), 'click', () => onLeave());
  listen($('hy-rotation-exit'), 'click', () => onLeave());
  listen($('hy-peer-message'), 'click', () => onPeerMessage());
  listen($('hy-gallery'), 'click', () => { window.location.href = gamePath('/hyakki-catalog.html'); });
  listen($('hy-rules'), 'click', () => inspector('百鬼商会 · 首版规则', '<ol class="hy-rule-list"><li>2～6人。每人20两、4张牌、6格摊位。市场六种货物各20件。</li><li>每回合5行动，通常先花1行动摸牌。用货物凭据买入或卖出完整货物组，凭据随后弃置。</li><li>先完成一次动作并达到60两获胜。摸过牌且用了不超过3行动，主动结束可得1两。</li><li>盛典改变一种货物的买卖价；顺手牵羊给目标10秒用护身符防御。</li><li>黑市拍卖三件，一次只揭一件；轮到自己15秒内加1两或放弃。</li><li>许可证支付3两与1行动，永久扩容3格。退出中的拍卖义务结算后才清理。</li></ol><p>这里是资源与界面样板。详细边界以已确认设计书为准；完整规则引擎在后续阶段实现。</p>'));
  listen($('hy-invite'), 'click', async () => {
    const invitation = new URL(window.location.href); invitation.search = '?scene=waiting';
    try { await window.navigator.clipboard.writeText(`仅本机可打开的百鬼商会样板：${invitation}`); feedback('已复制本机样板地址；这不是正式邀请。'); }
    catch { inspector('本机样板地址', `<p>不是正式邀请；只在当前电脑的预览服务中可用。</p><input aria-label="本机样板地址" readonly value="${escape(invitation)}">`); }
  });
  const viewport = mountGameViewport({ window, document, sync: resize, recoveryDelays: [80, 250] });
  const observer = new window.ResizeObserver(resize); observer.observe($('hy-hand'));
  const chatObserver = new window.MutationObserver(syncUrgentChat); chatObserver.observe($('room-chat'), { attributes: true, attributeFilter: ['hidden'] });
  return { applyView, audio, settings, feedback, destroy() {
    if (destroyed) return; destroyed = true; removers.forEach(remove => remove()); viewport.destroy(); observer.disconnect(); chatObserver.disconnect(); settings.destroy(); audioControls.destroy(); audio.destroy?.();
    window.clearTimeout(feedbackTimer); unmountArtFallback(); document.body.classList.remove('hy-urgent-chat', 'hy-keyboard');
  } };
}
