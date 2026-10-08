import { renderCard, renderCardBack, renderPatternBadge } from './art.mjs';
import { makeDeck } from './cards.mjs';
import { handLayout, publicLayout } from './layout.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountRoomSettings } from '../../platform/room-settings.mjs';
import { mountGameViewport } from '../../platform/room-viewport.mjs';
import { gameViewport } from '../../game-viewport.mjs';
import { roomChatMarkup } from '../../room-chat.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const button = (id, text, extra = '') => `<button type="button" id="${id}" ${extra}>${text}</button>`;

/** UI receives only a role projection. It neither deals cards nor grants actions. */
export function mountPoker414Page({ root, preview = false, onAction = () => {}, onLeave = () => {}, onScene = () => {}, scenes = [] } = {}) {
  if (!root) throw new TypeError('缺少414页面容器。');
  const document = root.ownerDocument, window = document.defaultView;
  document.body.classList.add('p414-body');
  root.innerHTML = `<div class="p414-shell">
    <header class="p414-header" data-chat-notice-anchor>
      <div class="p414-brand"><strong>414 <small>窜火箭</small></strong><span>${preview ? '操作小样 · 合成局面' : '棋牌室'}</span></div>
      <div class="p414-toolbar">${button('chat-toggle', '聊天 <span id="chat-unread" class="chat-unread" hidden></span>', 'class="chat-toggle" aria-controls="room-chat" aria-expanded="false" hidden')}${button('p414-settings', '设置')}${button('p414-exit', '×', 'class="p414-close" aria-label="退出房间"')}</div>
    </header>
    <div class="p414-room-line"><span>房间 <b id="p414-code"></b></span>${button('p414-invite', '复制邀请')}<span id="p414-observers"></span></div>
    <section id="p414-roster" class="p414-roster" aria-label="逆时针行动顺序"></section>
    <main class="p414-table">
      <div class="p414-table-heading"><strong id="p414-turn"></strong>${button('p414-inspect', '看公牌')}</div>
      <div id="p414-waiting" class="p414-waiting" hidden><p class="p414-eyebrow">EVERYONE AT THE TABLE</p><h1>坐好了，就开始。</h1><p id="p414-ready-description"></p><div class="p414-waiting-actions">${button('p414-ready', '准备好了', 'class="p414-primary"')}${button('p414-start', '开始游戏', 'class="p414-primary"')}${button('p414-role', '改为观战')}</div><p id="p414-start-reason"></p><p>两副牌 · 3～8人 · 先出完获胜</p></div>
      <div id="p414-playing" class="p414-playing"><div id="p414-public" class="p414-public" aria-label="全部已出公牌"></div><div class="p414-target"><div><strong id="p414-target-label"></strong><span id="p414-window" role="timer"></span></div><div id="p414-target-cards" aria-label="当前要压的牌"></div></div></div>
      <div id="p414-result" class="p414-result" hidden><h1 id="p414-result-title"></h1><p id="p414-result-note"></p><div id="p414-result-scores"></div>${button('p414-rematch', '再来一局', 'class="p414-primary"')}</div>
    </main>
    <section id="p414-actions" class="p414-actions" aria-label="出牌操作" data-chat-dismiss-notices>${button('p414-hook', '勾 ＋1', 'class="p414-response"')}${button('p414-fork', '叉 ＋2', 'class="p414-response"')}${button('p414-play', '出牌', 'class="p414-primary"')}${button('p414-pass', '不出')}</section>
    <section id="p414-hand-section" class="p414-hand-section" data-chat-dismiss-notices><div class="p414-hand-heading"><strong id="p414-hand-label">我的手牌</strong><span id="p414-selection">点选上提，再点取消</span>${button('p414-clear', '取消选择')}</div><div id="p414-hand" class="p414-hand" aria-label="我的手牌"></div></section>
    <footer id="p414-feedback" class="p414-feedback" role="status" aria-live="polite"></footer>
  </div>
  <dialog id="p414-options-dialog" class="p414-dialog"><div class="dialog-heading"><h2>设置</h2>${button('p414-settings-close', '×', 'class="close-button" aria-label="关闭设置"')}</div><div class="game-settings-body">
    <section><h3>声音与玩法</h3><div id="p414-settings-tools" class="game-settings-controls">${button('sound-toggle', '点按启声')}${button('p414-rules', '玩法说明')}</div><div class="sound-settings"><label for="sound-volume">音效音量</label><input id="sound-volume" type="range" min="0" max="100" step="5" value="45"><select id="sound-preview-kind" aria-label="试听种类"><option value="select">选牌</option><option value="placement">出牌</option><option value="card-hook">勾牌</option><option value="card-fork">叉牌</option><option value="card-bomb">炸弹</option><option value="card-rocket">火箭</option><option value="card-pass">不出</option><option value="turn">轮到你</option><option value="chat">聊天</option><option value="win">获胜</option><option value="loss">结束</option></select>${button('sound-preview', '试听')}<span id="sound-preview-status" role="status"></span></div></section>
    <section><h3>房间安排</h3><div class="game-settings-controls">${button('p414-members', '成员与积分')}${button('p414-copy-settings', '复制邀请')}${button('p414-exit-settings', '退出房间')}</div><p id="chat-legacy-note" hidden></p></section>
    ${preview ? `<section><h3>本机小样</h3><p>合成牌局，用于布局与操作检查；没有真实输赢或积分。</p><label for="p414-scene">切换局面</label><select id="p414-scene">${scenes.map(([id, label]) => `<option value="${escape(id)}">${escape(label)}</option>`).join('')}</select>${button('p414-friend-message', '模拟朋友发言')}${button('p414-art-gallery', '检查全部牌面')}</section>` : ''}
  </div></dialog>
  <dialog id="p414-rules-dialog" class="p414-dialog"><div class="dialog-heading"><h2>414 · 两副牌</h2>${button('p414-rules-close', '×', 'class="close-button" aria-label="关闭玩法说明"')}</div><ol class="p414-rule-list"><li>3～8人，两副完整扑克牌共108张。第一张发出的红桃3决定先手，逆时针出牌，先出完全部手牌获胜。</li><li>普通回合不限时。可出单牌、对子、顺子、连对、3～8张炸弹、王炸和44A火箭；跟牌需要更大，不出则交给下一位。</li><li>别人刚出普通单牌，叉加两张；别人刚出对子，勾加一张。之后勾、叉交替，合成最多八张。每次机会5秒，牌组拥有者不能接自己。</li><li>火箭：纯红桃 ＞ 其他同花色 ＞ 杂色。非红桃的同花色火箭彼此等大。只有未出完手牌的纯红桃火箭立即再次领出。</li><li>开局后主动离开，向其他参赛者每人赔5分；连续失联120秒，本局零分取消。观众可看所有已发手牌，不能出牌。</li></ol>${preview ? '<p>这是操作小样的简要说明，完整规则与规则引擎另行验收。</p>' : ''}</dialog>
  <dialog id="p414-leave-dialog" class="p414-dialog"><div class="dialog-heading"><h2>退出房间？</h2>${button('p414-leave-close', '×', 'class="close-button" aria-label="关闭退出确认"')}</div><p id="p414-leave-description"></p><div class="p414-dialog-actions">${button('p414-stay', '继续留在这里')}${button('p414-leave-confirm', '确认退出', 'class="p414-primary"')}</div></dialog>
  <dialog id="p414-inspector-dialog" class="p414-dialog p414-inspector"><div class="dialog-heading"><h2 id="p414-inspector-title">看清公牌</h2>${button('p414-inspector-close', '×', 'class="close-button" aria-label="关闭看牌"')}</div><div id="p414-inspector-content"></div></dialog>
  ${roomChatMarkup()}`;

  const $ = id => document.getElementById(id), disposers = [], audio = createGameAudio();
  let view = null, selected = new Set(), destroyed = false, expiryReported = false;
  function listen(node, type, handler, options) { node.addEventListener(type, handler, options); disposers.push(() => node.removeEventListener(type, handler, options)); }
  const audioControls = mountRoomAudioControls({ audio, document });
  const settings = mountRoomSettings({ document, buttonId: 'p414-settings', dialogId: 'p414-options-dialog', closeButtonId: 'p414-settings-close', dismissIds: ['p414-rules', 'p414-members', 'p414-exit-settings'] });
  const dialogs = ['rules', 'leave', 'inspector'];
  function openDialog(name) {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    const dialog = $(`p414-${name}-dialog`); dialog.showModal();
  }
  function feedback(text) { $('p414-feedback').textContent = text; }
  function request(type, fields = {}) {
    try { Promise.resolve(onAction(type, fields)).catch(error => feedback(error.message || '操作未完成，请重试。')); }
    catch (error) { feedback(error.message || '操作未完成，请重试。'); }
  }
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

  function actionState() {
    const playing = view?.phase === 'playing', player = view?.selfRole === 'player';
    const mine = playing && player && view.turnPlayerId === view.selfId;
    $('p414-play').disabled = !mine || !selected.size;
    $('p414-pass').disabled = !mine || !view.target;
    $('p414-clear').disabled = !selected.size;
    $('p414-selection').textContent = selected.size ? `已选 ${selected.size} 张` : '点选上提，再点取消';
    const available = playing && player && view.response && Date.now() < view.response.deadlineAt && view.targetOwnerId !== view.selfId;
    $('p414-hook').disabled = !available || view.response.action !== 'hook';
    $('p414-fork').disabled = !available || view.response.action !== 'fork';
  }
  function updateCountdown() {
    if (!view || destroyed) return;
    const response = view.response, remaining = response ? Math.max(0, response.deadlineAt - Date.now()) : 0;
    $('p414-window').textContent = response ? remaining ? `可${response.action === 'hook' ? '勾' : '叉'} · ${(remaining / 1000).toFixed(1)}秒` : '响应结束 · 普通出牌不限时' : view.phase === 'playing' ? '普通出牌不限时' : '';
    $('p414-window').classList.toggle('is-active', remaining > 0);
    actionState();
    if (response && !remaining && !expiryReported) { expiryReported = true; request('response-expired'); }
  }
  function inspector(kind) {
    $('p414-inspector-title').textContent = kind === 'members' ? '成员与积分' : view?.selfRole === 'spectator' ? '全知观战 · 已发手牌与公牌' : '看清公牌';
    const content = $('p414-inspector-content');
    if (kind === 'art') {
      $('p414-inspector-title').textContent = '原创牌面与特殊标记';
      content.innerHTML = `<p>54种牌面，各有两个独立实体。以下只展示图形，不包含任何真实手牌。</p><div class="p414-art-badges">${renderCardBack()}${[1,2,3].map(level => renderPatternBadge({kind:'rocket',level})).join('')}${[3,4,5,6,7,8].map(count => renderPatternBadge({kind:'bomb',count})).join('')}</div><div class="p414-inspector-cards">${makeDeck().filter(card => card.copyId === 0).map(card => renderCard(card,{interactive:false})).join('')}</div>`;
    } else if (kind === 'members') {
      content.innerHTML = `<p>${preview ? '小样不查询真实积分。以下仅为本局合成成员。' : '累计积分按最近确认结果显示。'}</p>${view.players.map((player, index) => `<p>${index + 1} · ${escape(player.name)}${player.id === view.selfId ? ' · 我' : ''} · ${player.count}张</p>`).join('')}<p>${view.spectators.length}位观众</p>`;
    } else {
      const groups = view.selfRole === 'spectator' ? [...view.players.map(player => ({ label: `${player.name} · ${player.count}张`, cards: player.hand })), ...view.publicGroups] : view.publicGroups;
      content.innerHTML = groups.length ? groups.map(group => `<section><h3>${escape(group.label)}</h3><div class="p414-inspector-cards">${group.cards.map(card => renderCard(card, { interactive: false })).join('')}</div></section>`).join('') : '<p>还没有出牌。</p>';
    }
    openDialog('inspector');
  }
  function applyView(next) {
    if (destroyed) return;
    const reset = !view || view.matchId !== next.matchId || view.selfId !== next.selfId || view.selfRole !== next.selfRole || view.target?.id !== next.target?.id;
    view = next;
    const shell = root.querySelector('.p414-shell');
    shell.classList.toggle('has-small-hand', view.selfRole === 'player' && view.hand.length > 0 && view.hand.length <= 6);
    shell.classList.toggle('has-public', view.publicGroups.length > 0);
    selected = reset ? new Set() : new Set([...selected].filter(id => view.hand.some(card => card.id === id)));
    expiryReported = false;
    $('p414-code').textContent = view.roomCode;
    $('p414-observers').textContent = `${view.players.length}人 · ${view.spectators.length}观战`;
    const turn = view.players.find(player => player.id === view.turnPlayerId);
    $('p414-turn').textContent = view.phase === 'waiting' ? '等待大家准备' : view.phase === 'dealing' ? '正在发牌…' : view.phase === 'playing' ? view.selfRole === 'spectator' ? `观战 · ${turn?.name || '伙伴'}出牌` : view.turnPlayerId === view.selfId ? '轮到你出牌' : `${turn?.name || '伙伴'}出牌中` : '本局已结束';
    $('p414-turn').title = $('p414-turn').textContent;
    root.classList.toggle('is-your-turn', view.phase === 'playing' && view.selfRole === 'player' && view.turnPlayerId === view.selfId);
    // Seat ordering is already supplied by the role projection, never derived from a clock.
    $('p414-roster').innerHTML = view.actionOrder.map((id, index) => {
      const player = view.players.find(candidate => candidate.id === id);
      return `<div class="p414-seat${id === view.turnPlayerId && view.phase === 'playing' ? ' is-current' : ''}${id === view.selfId ? ' is-self' : ''}"><span class="p414-seat-order">${index + 1}</span><div><strong title="${escape(player.name)}">${escape(player.name)}${id === view.selfId ? ' · 我' : ''}</strong><small>${view.phase === 'waiting' ? player.ready ? '已准备' : '未准备' : `${player.count}张`}${id === view.turnPlayerId && view.phase === 'playing' ? ' · 出牌' : id === view.firstPlayerId ? ' · 先手' : ''}</small></div></div>`;
    }).join('');
    $('p414-waiting').hidden = view.phase !== 'waiting';
    $('p414-playing').hidden = !['playing', 'dealing'].includes(view.phase);
    $('p414-result').hidden = !['finished', 'cancelled'].includes(view.phase);
    $('p414-actions').hidden = !['playing', 'dealing'].includes(view.phase);
    $('p414-hand-section').hidden = !['playing', 'dealing'].includes(view.phase);
    $('p414-inspect').hidden = !['playing', 'dealing'].includes(view.phase);
    const self = view.players.find(player => player.id === view.selfId);
    $('p414-ready').hidden = view.selfRole !== 'player';
    $('p414-ready').textContent = self?.ready ? '取消准备' : '准备好了';
    $('p414-start').hidden = view.hostId !== view.selfId;
    $('p414-start').disabled = view.players.length < 3 || !view.players.every(player => player.ready);
    $('p414-role').textContent = view.selfRole === 'spectator' ? '加入对局' : '改为观战';
    $('p414-ready-description').textContent = `${view.players.length}/8人入座，${view.spectators.length}位观众。全部准备后由房主开始。`;
    $('p414-start-reason').textContent = $('p414-start').disabled ? '至少3人，并且所有玩家准备好才能开始。' : '大家都准备好了，可以开始。';
    $('p414-public').innerHTML = view.publicGroups.length ? view.publicGroups.map(group => `<div class="p414-public-group" style="width:calc(${group.cards.length} * (var(--public-card-w,24px) + 1px) - 1px)"><small title="${escape(group.label)}">${escape(group.label)}</small><div>${group.cards.map(card => renderCard(card, { interactive: false, compact: true })).join('')}</div></div>`).join('') : '<div class="p414-empty" aria-hidden="true"><b>4 · A · 4</b></div>';
    $('p414-target-label').textContent = view.target ? `当前目标 · ${view.target.label}` : view.phase === 'dealing' ? '洗牌和分配由服务器确认' : '新一轮 · 自由领出';
    $('p414-target-cards').innerHTML = view.target?.cards.map(card => renderCard(card, { interactive: false })).join('') || '';
    $('p414-hand-label').textContent = view.selfRole === 'spectator' ? '观战中 · 可看所有已发手牌' : `我的手牌 · ${view.hand.length}`;
    $('p414-hand').innerHTML = view.selfRole === 'spectator' ? `${button('p414-all-hands', '查看所有人的手牌')}` : view.hand.map(card => renderCard(card, { selected: selected.has(card.id), disabled: view.phase !== 'playing' })).join('');
    $('p414-selection').hidden = view.selfRole === 'spectator'; $('p414-clear').hidden = view.selfRole === 'spectator';
    if (view.phase === 'finished') {
      $('p414-result-title').textContent = '小禾先出完了！';
      $('p414-result-note').textContent = preview ? '合成结算示例 · 未写入真实积分' : '积分已确认';
      $('p414-result-scores').innerHTML = (view.result || []).map(result => `<div><span>${escape(view.players.find(player => player.id === result.playerId)?.name)}</span><strong>${result.delta > 0 ? '+' : ''}${result.delta}</strong><small>累计 ${result.balanceAfter}</small></div>`).join('');
    } else if (view.phase === 'cancelled') {
      $('p414-result-title').textContent = '这一局已取消';
      $('p414-result-note').textContent = '有伙伴连续失联120秒，本局不计分。重新准备后可以再开。';
      $('p414-result-scores').replaceChildren();
    }
    $('p414-leave-description').textContent = preview ? '退出本机合成小样，不影响任何真实房间、账号或积分。' : view.selfRole === 'spectator' || view.phase === 'waiting' ? '退出后可通过房间号再次加入。' : '主动离开会结束本局，并向其他参赛者每人赔5分。';
    if (preview) $('p414-scene').value = view.scene;
    updateCountdown(); resize();
    feedback(preview ? '本机操作小样 · 合成数据，不计真实积分' : '已同步');
  }
  listen($('p414-hand'), 'click', event => {
    if (event.target.closest('#p414-all-hands')) { inspector('cards'); return; }
    const target = event.target.closest('[data-card-id]');
    if (!target || target.disabled || !view?.hand.some(card => card.id === target.dataset.cardId)) return;
    const id = target.dataset.cardId; selected.has(id) ? selected.delete(id) : selected.add(id);
    target.classList.toggle('is-selected', selected.has(id)); target.setAttribute('aria-pressed', String(selected.has(id)));
    audio.play('select'); actionState();
  });
  listen($('p414-clear'), 'click', () => { selected.clear(); for (const card of $('p414-hand').querySelectorAll('[data-card-id]')) { card.classList.remove('is-selected'); card.setAttribute('aria-pressed', 'false'); } actionState(); });
  for (const type of ['hook', 'fork', 'play', 'pass', 'ready', 'start', 'role', 'rematch']) listen($(`p414-${type}`), 'click', () => request(type, { cardIds: [...selected] }));
  for (const id of ['p414-invite', 'p414-copy-settings']) listen($(id), 'click', async () => {
    try { await window.navigator.clipboard.writeText(window.location.href); feedback(preview ? '已复制本机小样地址，仅本机可用。' : '邀请已复制。'); }
    catch { feedback(`房间号 ${view?.roomCode || ''} · 暂时无法复制，可手动分享。`); }
  });
  for (const id of ['p414-exit', 'p414-exit-settings']) listen($(id), 'click', () => openDialog('leave'));
  listen($('p414-stay'), 'click', () => $('p414-leave-dialog').close());
  listen($('p414-leave-confirm'), 'click', () => onLeave());
  listen($('p414-rules'), 'click', () => openDialog('rules'));
  listen($('p414-members'), 'click', () => inspector('members'));
  listen($('p414-inspect'), 'click', () => inspector('cards'));
  for (const name of dialogs) listen($(`p414-${name}-close`), 'click', () => $(`p414-${name}-dialog`).close());
  if (preview) listen($('p414-art-gallery'), 'click', () => inspector('art'));
  if (preview) listen($('p414-scene'), 'change', event => { settings.close(); onScene(event.target.value); });
  const clockTimer = window.setInterval(updateCountdown, 100);
  return { applyView, feedback, audio, settings, selected: () => [...selected], destroy() {
    if (destroyed) return;
    destroyed = true; window.clearInterval(clockTimer); observer.disconnect(); viewport.destroy(); settings.destroy(); audioControls.destroy(); audio.close(); disposers.forEach(dispose => dispose());
  } };
}
