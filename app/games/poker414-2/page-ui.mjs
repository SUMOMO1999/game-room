import { renderCard, renderCardBack, renderPatternBadge } from './art.mjs';
import { makeDeck } from './cards.mjs';
import { handLayout, publicLayout } from './layout.mjs';
import { poker414Selection } from './presentation.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountRoomSettings } from '../../platform/room-settings.mjs';
import { mountGameViewport } from '../../platform/room-viewport.mjs';
import { gameViewport } from '../../game-viewport.mjs';
import { roomChatMarkup } from '../../room-chat.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const button = (id, text, extra = '') => `<button type="button" id="${id}" ${extra}>${text}</button>`;

/** UI receives only a role projection. It neither deals cards nor grants actions. */
export function mountPoker414Page({ root, preview = false, practice = false, onAction = () => {}, onLeave = () => {}, onRefresh = () => {}, onRetry = () => {}, onRecover = () => {}, onScene = () => {}, scenes = [] } = {}) {
  if (!root) throw new TypeError('缺少414页面容器。');
  if (preview && practice) throw new TypeError('练习与操作小样不能混用。');
  const local = preview || practice;
  const document = root.ownerDocument, window = document.defaultView;
  document.body.classList.add('p414-body');
  root.innerHTML = `<div class="p414-shell">
    <header class="p414-header room-header">
      <div class="p414-brand"><strong>414 <small>窜火箭</small></strong><span>${preview ? '操作小样 · 合成局面' : practice ? '单人练习 · 电脑对手' : '棋牌室'}</span></div>
      <div class="room-toolbar" data-chat-notice-anchor><div class="p414-toolbar room-toolbar-actions">${button('chat-toggle', '聊天 <span id="chat-unread" class="chat-unread" hidden></span>', 'class="chat-toggle room-toolbar-action" aria-controls="room-chat" aria-expanded="false" hidden')}${button('p414-settings', '设置', 'class="room-toolbar-action"')}${button('p414-exit', '×', `class="p414-close room-toolbar-action room-toolbar-exit" aria-label="${practice ? '返回大厅' : '退出房间'}"`)}</div></div>
    </header>
    <div class="p414-room-line"><span>${practice ? '本机练习' : '房间'} <b id="p414-code"></b></span>${button('p414-invite', '复制邀请', practice ? 'hidden' : '')}<span id="p414-observers"></span></div>
    <section id="p414-roster" class="p414-roster" aria-label="逆时针行动顺序"></section>
    <main class="p414-table">
      <div class="p414-table-heading"><strong id="p414-turn"></strong>${button('p414-inspect', '看公牌')}</div>
      <div id="p414-waiting" class="p414-waiting" hidden><p class="p414-eyebrow">EVERYONE AT THE TABLE</p><h1>坐好了，就开始。</h1><p id="p414-ready-description"></p><div class="p414-waiting-actions">${button('p414-ready', '准备好了', 'class="p414-primary"')}${button('p414-start', '开始游戏', 'class="p414-primary"')}${button('p414-role', '改为观战')}</div><p id="p414-start-reason"></p><p id="p414-cancellation" hidden></p><p>两副牌 · 3～8人 · 先出完获胜</p></div>
      <div id="p414-playing" class="p414-playing"><div id="p414-public" class="p414-public" aria-label="全部已出公牌"></div><div class="p414-target"><div><strong id="p414-target-label"></strong><span id="p414-window" role="timer"></span></div><div id="p414-target-cards" aria-label="当前要压的牌"></div></div></div>
      <div id="p414-result" class="p414-result" hidden><h1 id="p414-result-title"></h1><p id="p414-result-note"></p><div id="p414-result-scores"></div>${button('p414-rematch', '再来一局', 'class="p414-primary"')}</div>
    </main>
    <section id="p414-actions" class="p414-actions" aria-label="出牌操作" data-chat-dismiss-notices>${button('p414-hook', '勾 ＋1', 'class="p414-response"')}${button('p414-fork', '叉 ＋2', 'class="p414-response"')}${button('p414-play', '出牌', 'class="p414-primary"')}${button('p414-pass', '不出')}</section>
    <section id="p414-hand-section" class="p414-hand-section" data-chat-dismiss-notices><div class="p414-hand-heading"><strong id="p414-hand-label">我的手牌</strong><span id="p414-selection">点选上提，再点取消</span>${button('p414-clear', '取消选择')}</div><div id="p414-hand" class="p414-hand" aria-label="我的手牌"></div></section>
    <section id="p414-recovery" class="p414-recovery" role="status" hidden><p id="p414-connection-note"></p><div>${button('p414-recover', '恢复连接')}${button('p414-retry', '核对原操作')}<a id="p414-login" hidden>重新登录</a><a id="p414-reauth" hidden>重新验证账号</a></div></section>
    <footer id="p414-feedback" class="p414-feedback" role="status" aria-live="polite"></footer>
  </div>
  <dialog id="p414-options-dialog" class="p414-dialog"><div class="dialog-heading"><h2>设置</h2>${button('p414-settings-close', '×', 'class="close-button" aria-label="关闭设置"')}</div><div class="game-settings-body">
    <section><h3>声音与玩法</h3><div id="p414-settings-tools" class="game-settings-controls">${button('sound-toggle', '点按启声')}${button('p414-rules', '玩法说明')}</div><div class="sound-settings"><label for="sound-volume">音效音量</label><input id="sound-volume" type="range" min="0" max="100" step="5" value="45"><select id="sound-preview-kind" aria-label="试听种类"><option value="select">选牌</option><option value="placement">出牌</option><option value="card-hook">勾牌</option><option value="card-fork">叉牌</option><option value="card-bomb">炸弹</option><option value="card-rocket">火箭</option><option value="card-pass">不出</option><option value="turn">轮到你</option><option value="chat">聊天</option><option value="win">获胜</option><option value="loss">结束</option></select>${button('sound-preview', '试听')}<span id="sound-preview-status" role="status"></span></div></section>
    <section><h3>${practice ? '练习安排' : '房间安排'}</h3><div class="game-settings-controls">${button('p414-members', practice ? '练习成员' : '成员与积分')}${button('p414-copy-settings', '复制邀请', practice ? 'hidden' : '')}${button('p414-exit-settings', practice ? '返回大厅' : '退出房间')}${local ? '' : `${button('p414-logout', '退出棋牌登录')}${button('p414-agora', '返回 Agora')}`}</div><div id="p414-host-tools" hidden><label for="p414-host-choice">将房主交给</label><select id="p414-host-choice"></select>${button('p414-transfer', '转交房主')}</div>${button('p414-take-host', '接任房主', 'hidden')}<p id="chat-legacy-note" hidden></p></section>
    ${practice ? `<section><h3>本机练习</h3><p id="p414-practice-save">进度只保存在这个浏览器，不计正式积分。</p><label for="p414-practice-count">下一局总人数（含你）</label><select id="p414-practice-count">${[3,4,5,6,7,8].map(n => `<option value="${n}">${n}人 · ${n - 1}位电脑</option>`).join('')}</select>${button('p414-practice-restart', '重新开始')}${button('p414-practice-reload', '读取已保存进度', 'hidden')}</section>` : ''}
    ${preview ? `<section><h3>本机小样</h3><p>合成牌局，用于布局与操作检查；没有真实输赢或积分。</p><label for="p414-scene">切换局面</label><select id="p414-scene">${scenes.map(([id, label]) => `<option value="${escape(id)}">${escape(label)}</option>`).join('')}</select>${button('p414-friend-message', '模拟朋友发言')}${button('p414-art-gallery', '检查全部牌面')}</section>` : ''}
  </div></dialog>
  <dialog id="p414-rules-dialog" class="p414-dialog"><div class="dialog-heading"><h2>414 · 两副牌</h2>${button('p414-rules-close', '×', 'class="close-button" aria-label="关闭玩法说明"')}</div><ol class="p414-rule-list"><li>3～8人，两副完整扑克牌共108张。第一张发出的红桃3决定先手，逆时针出牌，先出完全部手牌获胜。</li><li>普通回合不限时。点数从小到大为3、4…K、A、2、小王、大王。可出单牌、对子、3～12张顺子、3～12连对；顺子和连对不含2或王，不回绕，跟牌须同型同张数且更大。领出不能不出；其余人全部不出后，最后出牌者重新领出。</li><li>3～8张同点数普通牌组成炸弹，先比张数，再比点数。一小王加一大王是王炸，高于所有普通炸弹；同王对子仅按对子比较，三王／四王不能一起出。</li><li>别人刚出普通单牌，叉加两张；别人刚出对子，勾加一张。之后勾、叉交替，合成最多八张。每次机会5秒，牌组拥有者不能接自己。点勾／叉自动交牌，无需预选；别人刚出普通炸弹或王不能接。单牌链1→3→4→6→7，对牌链2→3→5→6→8，必须交替且不能超8张。</li><li>火箭：纯红桃 ＞ 其他同花色 ＞ 杂色。非红桃的同花色火箭彼此等大。44A火箭高于王炸，4AA不是火箭。只有未出完手牌的纯红桃火箭立即再次领出。任何合法出牌或勾叉清空手牌都立即获胜，不能再被压制。</li><li>${practice ? '练习只显示本局分，不写入账号累计。正式房间的' : ''}结算：负者余牌先提出互不重叠的44A，每组扣10分；一小一大王每组扣5分；剩余每张扣1分，赢家得到所有扣分。火箭花色不影响罚分。${practice ? '正式房间的同一4A4累计永久保存。' : '同一4A4累计永久保存。'}</li><li>${practice ? '练习返回大厅保留本机进度，重新开始才清掉这局；打开设置、看牌或切到后台会暂停。电脑只使用自己的手牌和公牌，不读取你的手牌。' : '开局后主动离开，向其他参赛者每人赔5分；连续失联120秒，本局零分取消。观众可看所有已发手牌，不能出牌。'}</li></ol>${preview ? '<p>这是操作小样的简要说明，完整规则与规则引擎另行验收。</p>' : ''}</dialog>
  <dialog id="p414-leave-dialog" class="p414-dialog"><div class="dialog-heading"><h2>${practice ? '返回大厅？' : '退出房间？'}</h2>${button('p414-leave-close', '×', 'class="close-button" aria-label="关闭退出确认"')}</div><p id="p414-leave-description"></p><p id="p414-leave-error" role="alert" hidden></p><div class="p414-dialog-actions">${button('p414-stay', '继续留在这里')}${button('p414-leave-confirm', '确认退出', 'class="p414-primary"')}</div></dialog>
  <dialog id="p414-inspector-dialog" class="p414-dialog p414-inspector"><div class="dialog-heading"><h2 id="p414-inspector-title">看清公牌</h2>${button('p414-inspector-close', '×', 'class="close-button" aria-label="关闭看牌"')}</div><div id="p414-inspector-content"></div></dialog>
  ${roomChatMarkup()}`;

  const $ = id => document.getElementById(id), disposers = [], audio = createGameAudio();
  let view = null, selected = new Set(), destroyed = false, expiryReported = null, inspectorKind = null, generation = 0;
  let connection = 'online', pending = false, concealed = false, leaveWorking = false, exitDestination = 'lobby';
  let serverTime = null, receivedAt = 0, assistedKey = null, handSignature = null, savedSelection = null, concealMessage = '';
  const selectionScope = value => value && JSON.stringify([value.roomId, value.matchId, value.selfId, value.selfRole]);
  const monotonicNow = () => window.performance?.now() ?? Date.now();
  const now = () => serverTime === null ? Date.now() : practice && view?.clockPaused ? serverTime : serverTime + Math.max(0, monotonicNow() - receivedAt);
  function listen(node, type, handler, options) { node.addEventListener(type, handler, options); disposers.push(() => node.removeEventListener(type, handler, options)); }
  const audioControls = mountRoomAudioControls({ audio, document });
  const settings = mountRoomSettings({ document, buttonId: 'p414-settings', dialogId: 'p414-options-dialog', closeButtonId: 'p414-settings-close',
    dismissIds: ['p414-rules', 'p414-members', 'p414-exit-settings', ...(!local ? ['p414-logout', 'p414-agora'] : [])] });
  const dialogs = ['rules', 'leave', 'inspector'];
  function openDialog(name) {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    $(`p414-${name}-dialog`).showModal();
  }
  function feedback(text) { if (!destroyed) $('p414-feedback').textContent = text; }
  function invoke(callback, ...args) {
    const fence = generation, scope = selectionScope(view);
    const failure = error => {
      if (destroyed || generation !== fence || selectionScope(view) !== scope || error?.name === 'AbortError') return;
      audio.play('invalid');
      feedback(error?.message || '操作未完成，请重试。');
    };
    try { Promise.resolve(callback(...args)).catch(failure); } catch (error) { failure(error); }
  }
  const interactive = () => !!view && !concealed && !pending && connection === 'online' && view.canAct !== false;
  function request(type, fields = {}) { if (interactive()) invoke(onAction, type, fields); }
  function resize() {
    if (destroyed) return;
    const frame = gameViewport({ width: window.innerWidth, height: window.innerHeight, visual: window.visualViewport, editing: !!document.activeElement?.matches('input,textarea') });
    document.documentElement.style.setProperty('--p414-height', `${frame.height}px`);
    document.documentElement.style.setProperty('--p414-top', `${frame.top}px`);
    if (frame.resetScroll && (window.scrollX || window.scrollY)) window.scrollTo(0, 0);
    const width = $('p414-hand').clientWidth;
    if (view && width >= 44) {
      const geometry = handLayout(width, view.selfRole === 'spectator' ? 0 : view.hand.length, { short: frame.height < 500, maxHeight: frame.height < 500 ? frame.height * .38 : frame.height * .40 });
      const hand = $('p414-hand');
      hand.style.setProperty('--hand-columns', geometry.columns);
      hand.style.setProperty('--hand-card-w', `${geometry.cardWidth}px`);
      hand.style.setProperty('--hand-card-h', `${geometry.cardHeight}px`);
    }
    const publicNode = $('p414-public');
    if (view && publicNode.clientWidth) {
      const geometry = publicLayout(publicNode.clientWidth, publicNode.clientHeight, view.publicGroups.map(group => group.cards), { compact: frame.height < 540 && frame.width > frame.height });
      publicNode.style.setProperty('--public-card-w', `${geometry.cardWidth}px`);
      publicNode.style.setProperty('--public-card-h', `${geometry.cardHeight}px`);
      publicNode.style.setProperty('--public-gap', `${geometry.gap}px`);
      publicNode.style.setProperty('--public-mark-size', `${Math.max(12, Math.min(60, publicNode.clientHeight * .6, publicNode.clientWidth * .1))}px`);
    }
  }
  const viewport = mountGameViewport({ window, document, sync: resize, recoveryDelays: [80, 250] });
  const observer = new window.ResizeObserver(resize); observer.observe($('p414-hand')); observer.observe($('p414-public'));

  function selectedAnalysis() {
    return poker414Selection(view ? { ...view, pending, connection, canAct: interactive() } : null, [...selected], { now: now(), includeChoices: false });
  }
  function actionState() {
    const allowed = interactive(), analysis = selectedAnalysis(), self = view?.players.find(player => player.id === view.selfId);
    for (const kind of ['play', 'pass', 'hook', 'fork']) $('p414-' + kind).disabled = !analysis['can' + kind[0].toUpperCase() + kind.slice(1)];
    $('p414-clear').disabled = !selected.size || !allowed;
    $('p414-selection').textContent = analysis.hint;
    $('p414-selection').title = analysis.hint;
    $('p414-ready').disabled = !allowed || (view.canReady ?? (view.phase === 'waiting' && view.selfRole === 'player')) === false;
    $('p414-start').disabled = !allowed || (view.canStart ?? (view.players.length >= 3 && view.players.every(player => player.ready) && view.hostId === view.selfId)) === false;
    $('p414-role').disabled = !allowed || (view.canChangeRole ?? (view.phase === 'waiting' && (view.selfRole === 'spectator' ? view.players.length < 8 : view.hostId !== view.selfId))) === false;
    $('p414-rematch').disabled = !allowed || (view.canRematch ?? (view.hostId === view.selfId)) === false;
    $('p414-transfer').disabled = !allowed || !view?.transferCandidates?.length;
    $('p414-take-host').disabled = !allowed || !view?.canTakeOver;
    $('p414-ready').textContent = self?.ready ? '取消准备' : '准备好了';
    renderHand();
  }
  function renderHand() {
    const hand = $('p414-hand');
    if (!view || concealed) { hand.replaceChildren(); handSignature = null; return; }
    const disabled = !interactive() || view.phase !== 'playing';
    const signature = JSON.stringify([view.selfRole, view.hand.map(card => card.id), disabled]);
    if (signature !== handSignature) {
      handSignature = signature;
      hand.innerHTML = view.selfRole === 'spectator' ? button('p414-all-hands', '查看所有人的手牌')
        : view.hand.map(card => renderCard(card, { selected: selected.has(card.id), disabled })).join('');
    }
    // Selecting a card and duplicate room snapshots must not discard keyboard
    // focus or replace the card under an in-flight pointer gesture.
    for (const card of hand.querySelectorAll('[data-card-id]')) {
      card.classList.toggle('is-selected', selected.has(card.dataset.cardId));
      card.setAttribute('aria-pressed', String(selected.has(card.dataset.cardId)));
    }
  }
  function connectionState() {
    const unknown = Boolean(pending), healthy = connection === 'online' && !concealed;
    $('p414-recovery').hidden = healthy && !unknown;
    const messages = { online: '正在恢复房间。', connecting: '正在连接房间…', reconnecting: '连接中断，正在恢复；保留当前选牌。',
      offline: '连接暂时中断；恢复后先核对牌局，不会重复出牌。', recovering: '正在核对最新房间状态…',
      unauthorized: '登录已失效，手牌已收起。重新登录后恢复原房间。', unavailable: '身份服务暂时不可用，手牌已收起。请稍后恢复。' };
    $('p414-connection-note').textContent = unknown ? '原操作的结果尚未确认。请核对或重试原操作，不要重新出牌。' : concealMessage || messages[connection] || '连接暂时不可用，请恢复。';
    $('p414-retry').hidden = !unknown;
    $('p414-recover').textContent = connection === 'unauthorized' ? '重新登录' : '恢复连接';
    $('p414-recover').hidden = (healthy && unknown) || !$('p414-login').hidden;
    actionState();
  }
  function updateCountdown() {
    if (!view || destroyed || concealed) return;
    const response = view.response, remaining = response ? Math.max(0, response.deadlineAt - now()) : 0;
    $('p414-window').textContent = response ? remaining ? `可${response.action === 'hook' ? '勾' : '叉'} · ${(remaining / 1000).toFixed(1)}秒` : '响应结束 · 普通出牌不限时' : view.phase === 'playing' ? '普通出牌不限时' : '';
    $('p414-window').classList.toggle('is-active', remaining > 0);
    actionState();
    if (response && !remaining && expiryReported !== response.id) {
      expiryReported = response.id;
      if (!local && interactive()) invoke(onRefresh, { reason: 'response-expired' });
    }
  }
  function fillInspector(kind) {
    if (!view || concealed) return;
    $('p414-inspector-title').textContent = kind === 'members' ? (practice ? '练习成员' : '成员与积分') : view.selfRole === 'spectator' ? '全知观战 · 已发手牌与公牌' : '看清公牌';
    const content = $('p414-inspector-content');
    if (kind === 'art') {
      $('p414-inspector-title').textContent = '原创牌面与特殊标记';
      content.innerHTML = `<p>54种牌面，各有两个独立实体。以下只展示图形，不包含任何真实手牌。</p><div class="p414-art-badges">${renderCardBack()}${[1,2,3].map(level => renderPatternBadge({kind:'rocket',level})).join('')}${[3,4,5,6,7,8].map(count => renderPatternBadge({kind:'bomb',count})).join('')}</div><div class="p414-inspector-cards">${makeDeck().filter(card => card.copyId === 0).map(card => renderCard(card,{interactive:false})).join('')}</div>`;
    } else if (kind === 'members') {
      const orderedPlayers = view.actionOrder.map(id => view.players.find(player => player.id === id)).filter(Boolean);
      content.innerHTML = `<p>${practice ? '电脑只看自己的手牌与公牌；练习不计正式积分。' : preview ? '小样不查询真实积分。' : '累计积分来自最近一次已确认查询，游戏进行中不会预扣分。'}</p><p>${local ? '' : Number.isFinite(view.scoresReadAt) ? `读取于 ${escape(new Date(view.scoresReadAt).toLocaleTimeString())}` : '尚未确认读取时间'} ${local ? '' : button('p414-score-refresh', '刷新积分')}</p><div class="p414-member-list">${orderedPlayers.map((player, index) => `<div><strong>${index + 1} · ${escape(player.name)}${player.id === view.selfId ? ' · 我' : ''}</strong><span>${player.count}张${practice ? '' : ` · 累计 ${Number.isSafeInteger(player.total) ? player.total : '待确认'}`}</span></div>`).join('')}</div><p>${view.spectators.length}位观众${view.spectators.length ? ' · ' + view.spectators.map(player => escape(player.name)).join('、') : ''}</p>`;
    } else {
      const groups = view.selfRole === 'spectator' ? [...view.players.map(player => ({ label: `${player.name} · ${player.count}张`, cards: player.hand })), ...view.publicGroups] : view.publicGroups;
      content.innerHTML = groups.length ? groups.map(group => `<section><h3>${escape(group.label)}</h3><div class="p414-inspector-cards">${group.cards.map(card => renderCard(card, { interactive: false })).join('')}</div></section>`).join('') : '<p>还没有出牌。</p>';
    }
  }
  function inspector(kind) {
    if (!view || concealed) return;
    inspectorKind = kind; fillInspector(kind); openDialog('inspector');
    if (kind === 'members' && !local) invoke(onRefresh, { reason: 'scores' });
  }
  function applyView(next) {
    if (destroyed) return;
    const reset = !view || view.roomId !== next.roomId || view.matchId !== next.matchId || view.selfId !== next.selfId || view.selfRole !== next.selfRole;
    if (reset) generation += 1;
    const previousConcealMessage = concealMessage;
    view = next; concealed = false; concealMessage = '';
    if (previousConcealMessage && $('p414-feedback').textContent === previousConcealMessage) feedback('已恢复房间。');
    $('p414-login').hidden = true; $('p414-reauth').hidden = true;
    connection = next.connection ?? connection; pending = next.pending ?? pending;
    serverTime = Number.isFinite(next.serverTime) ? next.serverTime : null; receivedAt = monotonicNow();
    selected = reset ? new Set(savedSelection?.scope === selectionScope(view) ? savedSelection.ids.filter(id => view.hand.some(card => card.id === id)) : []) : new Set([...selected].filter(id => view.hand.some(card => card.id === id)));
    savedSelection = null;
    const assistKey = `${view.matchId}:${view.roundId}:${view.turnPlayerId}:${view.target?.id}`;
    if (view.turnPlayerId === view.selfId && view.selfRole === 'player' && view.phase === 'playing' && assistedKey !== assistKey) {
      assistedKey = assistKey;
      if (!selected.size) {
        const unique = poker414Selection(view, [], { now: now() }).uniqueChoice;
        if (unique) selected = new Set(unique);
      }
    }
    const shell = root.querySelector('.p414-shell'); shell.classList.remove('is-concealed');
    shell.classList.toggle('has-small-hand', view.selfRole === 'player' && view.hand.length > 0 && view.hand.length <= 6);
    shell.classList.toggle('has-public', view.publicGroups.length > 0);
    $('p414-code').textContent = view.roomCode;
    $('p414-observers').textContent = practice ? `${view.players.length - 1}位电脑 · 不计正式积分` : `${view.players.length}人 · ${view.spectators.length}观战`;
    const turn = view.players.find(player => player.id === view.turnPlayerId);
    $('p414-turn').textContent = view.phase === 'waiting' ? '等待大家准备' : view.phase === 'dealing' ? '正在发牌…' : view.phase === 'playing' ? view.selfRole === 'spectator' ? `观战 · ${turn?.name || '伙伴'}出牌` : view.turnPlayerId === view.selfId ? '轮到你出牌' : `${turn?.name || '伙伴'}出牌中` : '本局已结束';
    $('p414-turn').title = $('p414-turn').textContent;
    root.classList.toggle('is-your-turn', view.phase === 'playing' && view.selfRole === 'player' && view.turnPlayerId === view.selfId);
    $('p414-roster').innerHTML = view.actionOrder.map((id, index) => {
      const player = view.players.find(candidate => candidate.id === id);
      return `<div class="p414-seat${id === view.turnPlayerId && view.phase === 'playing' ? ' is-current' : ''}${id === view.selfId ? ' is-self' : ''}"><span class="p414-seat-order">${index + 1}</span><div><strong title="${escape(player.name)}">${escape(player.name)}${id === view.selfId ? ' · 我' : ''}</strong><small>${view.phase === 'waiting' ? player.ready ? '已准备' : '未准备' : `${player.count}张`}${id === view.turnPlayerId && view.phase === 'playing' ? ' · 出牌' : id === view.firstPlayerId ? ' · 先手' : ''}${player.connected === false ? ' · 离线' : ''}</small></div></div>`;
    }).join('');
    $('p414-waiting').hidden = view.phase !== 'waiting';
    $('p414-playing').hidden = !['playing', 'dealing'].includes(view.phase);
    $('p414-result').hidden = !['finished', 'aborted', 'cancelled'].includes(view.phase);
    $('p414-actions').hidden = !['playing', 'dealing'].includes(view.phase) || view.selfRole === 'spectator';
    $('p414-hand-section').hidden = !['playing', 'dealing'].includes(view.phase);
    $('p414-inspect').hidden = !['playing', 'dealing'].includes(view.phase);
    $('p414-ready').hidden = view.selfRole !== 'player';
    $('p414-start').hidden = view.hostId !== view.selfId;
    $('p414-role').textContent = view.selfRole === 'spectator' ? '加入对局' : '改为观战';
    $('p414-ready-description').textContent = `${view.players.length}/8人入座，${view.spectators.length}位观众。全部准备后由房主开始。`;
    $('p414-start-reason').textContent = view.players.length < 3 ? '至少需要3位玩家。' : !view.players.every(player => player.ready) ? '等所有玩家准备好，再开始。' : '大家都准备好了，由房主开始。';
    $('p414-cancellation').textContent = view.cancellationNote || ''; $('p414-cancellation').hidden = !view.cancellationNote;
    $('p414-public').innerHTML = view.publicGroups.length ? view.publicGroups.map(group => `<div class="p414-public-group" style="width:calc(${group.cards.length} * (var(--public-card-w,24px) + 1px) - 1px)"><small title="${escape(group.label)}">${escape(group.label)}</small><div>${group.cards.map(card => renderCard(card, { interactive: false, compact: true })).join('')}</div></div>`).join('') : '<div class="p414-empty" aria-hidden="true"><b>4 · A · 4</b></div>';
    $('p414-target-label').textContent = view.target ? `当前目标 · ${view.target.label}` : view.phase === 'dealing' ? '牌局正在发牌，发完后由先手领出' : '新一轮 · 自由领出';
    $('p414-target-cards').innerHTML = view.target?.cards.map(card => renderCard(card, { interactive: false })).join('') || '';
    $('p414-hand-label').textContent = view.selfRole === 'spectator' ? '全知观战 · 可看所有已发手牌' : `我的手牌 · ${view.hand.length}`;
    $('p414-selection').hidden = view.selfRole === 'spectator'; $('p414-clear').hidden = view.selfRole === 'spectator';
    if (['finished', 'aborted'].includes(view.phase)) {
      const results = view.resultRows ?? view.result ?? [], winner = results.find(result => result.delta > 0);
      $('p414-result-title').textContent = view.resultTitle ?? `${view.players.find(player => player.id === winner?.playerId)?.name || '伙伴'}先出完了！`;
      $('p414-result-note').textContent = preview ? '合成结算示例 · 未写入真实积分' : view.resultNote || '正在核对已保存积分。';
      $('p414-result-scores').innerHTML = results.map(result => `<div><span>${escape(result.name ?? view.players.find(player => player.id === result.playerId)?.name ?? '已离席伙伴')}</span><strong>${result.delta > 0 ? '+' : ''}${result.delta}</strong><small>${practice ? '练习本局分' : Number.isSafeInteger(result.balanceAfter) ? `结算时累计 ${result.balanceAfter}` : '累计待确认'}</small></div>`).join('');
    } else if (view.phase === 'cancelled') {
      $('p414-result-title').textContent = '这一局已取消'; $('p414-result-note').textContent = view.cancellationNote || '本局不计分。重新准备后可以再开。'; $('p414-result-scores').replaceChildren();
    }
    $('p414-rematch').hidden = view.hostId !== view.selfId;
    const candidates = view.transferCandidates ?? [];
    $('p414-host-tools').hidden = candidates.length === 0;
    const previousHostChoice = $('p414-host-choice').value;
    $('p414-host-choice').innerHTML = candidates.map(player => `<option value="${escape(player.id)}">${escape(player.name)}</option>`).join('');
    if (candidates.some(player => player.id === previousHostChoice)) $('p414-host-choice').value = previousHostChoice;
    $('p414-take-host').hidden = !view.canTakeOver;
    $('p414-leave-description').textContent = preview ? '退出本机合成小样，不影响任何真实房间、账号或积分。'
      : view.leaveDescription || (view.selfRole === 'player' && ['playing', 'dealing'].includes(view.phase) ? `退出会结束本局，你扣${5 * (view.players.length - 1)}分，其他参赛者各得5分。` : '退出房间不扣分，可以通过房间号重新加入。');
    if (preview) $('p414-scene').value = view.scene;
    if (inspectorKind && $('p414-inspector-dialog').open) fillInspector(inspectorKind);
    connectionState(); updateCountdown(); resize();
    if (!$('p414-feedback').textContent) feedback(preview ? '本机操作小样 · 合成数据，不计真实积分' : '已同步');
  }
  function clearSelection() { selected.clear(); audio.play('select'); actionState(); }
  listen($('p414-hand'), 'click', event => {
    if (event.target.closest('#p414-all-hands')) { inspector('cards'); return; }
    const target = event.target.closest('[data-card-id]');
    if (!interactive() || !target || target.disabled || !view.hand.some(card => card.id === target.dataset.cardId)) return;
    const id = target.dataset.cardId; selected.has(id) ? selected.delete(id) : selected.add(id);
    audio.play('select'); actionState();
  });
  listen($('p414-clear'), 'click', clearSelection);
  for (const type of ['hook', 'fork', 'play', 'pass']) listen($(`p414-${type}`), 'click', () => {
    if (selectedAnalysis()['can' + type[0].toUpperCase() + type.slice(1)]) request(type, type === 'play' ? { cardIds: [...selected] } : {});
  });
  listen($('p414-ready'), 'click', () => request('ready', { ready: !view?.players.find(player => player.id === view.selfId)?.ready }));
  listen($('p414-role'), 'click', () => request(preview ? 'role' : 'set-role', { role: view.selfRole === 'player' ? 'spectator' : 'player' }));
  for (const type of ['start', 'rematch']) listen($(`p414-${type}`), 'click', () => request(type));
  listen($('p414-transfer'), 'click', () => { if (view?.transferCandidates?.some(player => player.id === $('p414-host-choice').value)) request('transferHost', { playerId: $('p414-host-choice').value }); });
  listen($('p414-take-host'), 'click', () => request('transferHost', { playerId: view.selfId }));
  for (const id of ['p414-invite', 'p414-copy-settings']) listen($(id), 'click', async () => {
    try { await window.navigator.clipboard.writeText(view?.inviteUrl || window.location.href); feedback(preview ? '已复制本机小样地址，仅本机可用。' : '邀请已复制。'); }
    catch { feedback(`房间号 ${view?.roomCode || ''} · 暂时无法复制，可手动分享。`); }
  });
  function confirmLeave(destination = 'lobby') {
    if (destroyed || leaveWorking) return;
    exitDestination = destination; $('p414-leave-error').hidden = true; openDialog('leave');
  }
  for (const id of ['p414-exit', 'p414-exit-settings']) listen($(id), 'click', () => confirmLeave('lobby'));
  if (!local) { listen($('p414-logout'), 'click', () => confirmLeave('logout')); listen($('p414-agora'), 'click', () => confirmLeave('agora')); }
  listen($('p414-stay'), 'click', () => $('p414-leave-dialog').close());
  function leaveFailure(message) {
    if (destroyed) return;
    leaveWorking = false; $('p414-leave-confirm').disabled = false; $('p414-leave-confirm').textContent = '确认退出';
    const error = $('p414-leave-error');
    if (message || error.hidden || !error.textContent) error.textContent = message || '退出结果尚未确认。请恢复连接后核对，不会重复扣分。';
    error.hidden = false;
  }
  listen($('p414-leave-confirm'), 'click', async () => {
    if (leaveWorking) return;
    const fence = generation;
    leaveWorking = true; $('p414-leave-confirm').disabled = true; $('p414-leave-confirm').textContent = '正在确认…';
    try { const left = await onLeave({ destination: exitDestination }); if (destroyed || generation !== fence) return; if (left === false) leaveFailure(); else $('p414-leave-dialog').close(); }
    catch (error) { if (!destroyed && generation === fence && error?.name !== 'AbortError') leaveFailure(error.message); }
  });
  listen($('p414-rules'), 'click', () => openDialog('rules'));
  listen($('p414-members'), 'click', () => inspector('members'));
  listen($('p414-inspector-content'), 'click', event => { if (event.target.closest('#p414-score-refresh')) invoke(onRefresh, { reason: 'scores' }); });
  listen($('p414-inspect'), 'click', () => inspector('cards'));
  listen($('p414-retry'), 'click', () => invoke(onRetry));
  listen($('p414-recover'), 'click', () => invoke(onRecover));
  for (const name of dialogs) listen($(`p414-${name}-close`), 'click', () => $(`p414-${name}-dialog`).close());
  if (preview) listen($('p414-art-gallery'), 'click', () => inspector('art'));
  if (preview) listen($('p414-scene'), 'change', event => { settings.close(); onScene(event.target.value); });
  function conceal(options = {}) {
    if (destroyed) return;
    const { message = '', loginHref = null, reauthHref = null, preserveSelection = false } = typeof options === 'string' ? { message: options } : options;
    generation += 1; leaveWorking = false; $('p414-leave-confirm').disabled = false; $('p414-leave-confirm').textContent = '确认退出';
    savedSelection = preserveSelection && view ? { scope: selectionScope(view), ids: [...selected] } : preserveSelection ? savedSelection : null;
    concealMessage = message; connection = loginHref ? 'unauthorized' : 'unavailable'; pending = false;
    for (const [id, href] of [['p414-login', loginHref], ['p414-reauth', reauthHref]]) {
      const link = $(id); link.hidden = true; link.removeAttribute('href');
      if (href) { try { const url = new URL(href, window.location.href); if (['https:', 'http:'].includes(url.protocol)) { link.href = url.href; link.hidden = false; } } catch {} }
    }
    view = null; selected.clear(); handSignature = null; inspectorKind = null; concealed = true;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    for (const id of ['p414-roster', 'p414-hand', 'p414-public', 'p414-target-cards', 'p414-result-scores', 'p414-inspector-content', 'p414-host-choice']) $(id).replaceChildren();
    for (const id of ['p414-turn', 'p414-result-title', 'p414-result-note', 'p414-target-label', 'p414-window', 'p414-observers', 'p414-cancellation']) $(id).textContent = '';
    root.classList.remove('is-your-turn'); root.querySelector('.p414-shell').classList.add('is-concealed');
    connectionState(); if (message) feedback(message);
  }
  const clockTimer = window.setInterval(updateCountdown, 100);
  return { applyView, feedback, audio, settings, selectCards(ids) {
      if (!interactive() || !view) return;
      selected = new Set(ids.filter(id => view.hand.some(card => card.id === id))); actionState();
    }, selected: () => [...selected], confirmLeave, conceal, leaveFailure,
    setConnection(state) { if (!destroyed) { connection = state; connectionState(); } },
    setPending(value) { if (!destroyed) { pending = Boolean(value); connectionState(); } },
    destroy() {
      if (destroyed) return;
      conceal(); destroyed = true; window.clearInterval(clockTimer); observer.disconnect(); viewport.destroy(); settings.destroy(); audioControls.destroy(); audio.close(); disposers.forEach(dispose => dispose());
    },
  };
}
