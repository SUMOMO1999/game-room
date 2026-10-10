import { CARDS, CATEGORIES, GOODS, getCard } from './content/definitions.mjs';
import { renderCard, renderCardDetails, renderGoodsIcon, renderCardBack } from './digital-card-ui.mjs';
import { mountArtFallback } from './content/manifest.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountRoomSettings } from '../../platform/room-settings.mjs';
import { mountGameViewport } from '../../platform/room-viewport.mjs';
import { gameViewport } from '../../game-viewport.mjs';
import { roomChatMarkup } from '../../room-chat.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const button = (id, label, attributes = '') => `<button type="button" id="${id}" ${attributes}>${label}</button>`;
const action = (type, label, extra = '') => `<button type="button" data-preview-action="${type}" ${extra}>${label}</button>`;
const definition = card => getCard(card?.definitionId ?? card?.id ?? card);
const goodName = id => GOODS.find(good => good.id === id)?.name ?? id;
const totalGoods = player => player.goods.reduce((sum, item) => sum + item.count, 0);
const isOwnDecision = view => view?.selfRole === 'player' && view.decision?.actorId === view.selfId;
const canOperate = view => view?.phase === 'playing' && view.selfRole === 'player'
  && view.currentPlayerId === view.selfId && !view.decision;

/** A read-only ruler: its number of intervals follows the room's action limit. */
export function renderActionTrack(used, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isInteger(used) || used < 0 || used > limit) {
    throw new RangeError('行动条需要 1～10 的上限和有效已用行动数。');
  }
  const position = used / limit * 100;
  return `<div class="yg-action-rail" aria-hidden="true" style="--yg-action-progress:${position}%">
    <span class="yg-action-line"></span><span class="yg-action-fill"></span>
    ${Array.from({ length: limit + 1 }, (_, index) => `<span class="yg-action-tick${index <= used ? ' is-used' : ''}" style="--yg-tick-position:${index / limit * 100}%"><i></i><small>${index}</small></span>`).join('')}
    <span class="yg-action-cursor"><i></i><b>${used}</b></span></div>`;
}

export function renderDecisionCandidates(decision, selected = []) {
  const selectable = decision.kind === 'choose';
  return decision.candidates.map(candidate => `<article class="yg-candidate${selected.includes(candidate.id) ? ' is-selected' : ''}">
    ${candidate.kind === 'card' ? renderCard(candidate.card, { interactive: false })
      : `<div class="yg-good-candidate">${renderGoodsIcon(candidate.goodId)}<strong>${escape(goodName(candidate.goodId))}</strong><span>${candidate.count}件</span></div>`}
    <div class="yg-candidate-actions">${selectable ? `<button type="button" data-choice="${candidate.id}" aria-pressed="${selected.includes(candidate.id)}">${selected.includes(candidate.id) ? '已选中' : '选这张'.replace('张', candidate.kind === 'good' ? '件' : '张')}</button>` : ''}
    ${candidate.kind === 'card' ? `<button type="button" data-detail-id="${candidate.card.definitionId}" aria-label="查看${escape(definition(candidate.card).name)}详情">看详情</button>` : ''}</div></article>`).join('');
}

/** Uses only a role-filtered table projection; tool controls always read a definition. */
export function renderPublicPlayerPanel(player, { bookLayers = 0, finalTurn = false } = {}) {
  const badges = [bookLayers ? `书算${bookLayers}层` : '', finalTurn ? '末回合' : ''].filter(Boolean);
  return `<section class="yg-peer-panel" data-public-player="${escape(player.id)}" aria-label="${escape(player.name)}的公开商铺">
    <button type="button" class="yg-peer-overview" data-player="${escape(player.id)}" aria-label="查看${escape(player.name)}的公开商铺详情">
      <span class="yg-peer-heading"><strong title="${escape(player.name)}">${escape(player.name)}</strong><b>${player.silver}两</b><span>手牌${player.handCount}张</span></span>
      ${badges.length ? `<span class="yg-peer-badges">${badges.map(badge => `<span>${badge}</span>`).join('')}</span>` : ''}
      <span class="yg-peer-goods">${GOODS.map(good => { const count = player.goods.find(item => item.id === good.id)?.count ?? 0; return `<span class="yg-peer-good" data-good-id="${good.id}" title="${good.name}${count}件" aria-label="${good.name}${count}件">${renderGoodsIcon(good.id)}<b>${count}</b></span>`; }).join('')}</span>
    </button>
    <div class="yg-peer-tools" aria-label="已装备道具">${player.tools.length ? player.tools.map(tool => { const face = definition(tool); return `<button type="button" class="yg-peer-tool${tool.tapped ? ' is-tapped' : ''}" data-detail-id="${face.id}" aria-label="${face.name}，${tool.tapped ? '已用' : '可用'}，查看牌文">${renderCard(tool, { interactive: false })}<span class="yg-peer-tool-name">${face.name}</span><span class="yg-peer-tool-state">${tool.tapped ? '已用' : '可用'}</span></button>`; }).join('') : '<span class="yg-peer-no-tools">尚未装备道具</span>'}</div>
  </section>`;
}

export function renderPersonalSlots(player) {
  const occupied = player.goods.flatMap(item => Array.from({ length: item.count }, () => item.id));
  const ordinary = Array.from({ length: player.ordinaryCapacity }, (_, index) => occupied[index] ?? null);
  const temporary = occupied[player.ordinaryCapacity] ?? null;
  const slot = (goodId, index, temporarySlot = false) => `<span class="yg-stock-slot${temporarySlot ? ' is-temporary' : ''}${goodId ? '' : ' is-empty'}"
    aria-label="${temporarySlot ? '收费临时格' : `普通格${index + 1}`}：${goodId ? escape(goodName(goodId)) : '空'}">
    ${goodId ? renderGoodsIcon(goodId) : '<span aria-hidden="true">＋</span>'}<small>${temporarySlot ? '临时' : index + 1}</small></span>`;
  return ordinary.map((id, index) => slot(id, index)).join('') + slot(temporary, ordinary.length, true);
}

const RULES = [
  '双人。每人20两、5张手牌、5个普通格＋1个收费临时格。六类货物默认各8件，开局前可设各4～20件；旧局保留原数量。',
  '每回合默认5行动，开局前可设1～10。取牌与用牌共用额度：每回合第一张必摸，留下或弃掉均耗1行动，之后才可用牌；弃掉才可继续摸。',
  '按货物牌的固定配方整组买入或卖出，使用后弃牌；临时格从空变为占用时另付2两。',
  '许可购买一块3格扩摊板。全局第一次6两，此后3两，公共区总共5块。',
  '道具先放置，再使用，分别花1行动。使用后横置，本人回合结束恢复；同名道具分别使用，最多放3张。',
  '锦衣卫只在监视人物刚发动时免费回应；番商只在对方货物交易完成后取走那张货物牌，交易不回退。',
  '主动回合30分钟，对方做选择60秒且冻结主动钟。共同暂停保留7天；意外断线挂起并保席30分钟。样板的时钟只是定格示意。',
  '主动认输则对手胜；意外保席超期取消且无胜者。关闭详情不能撤回已经提交的牌效、支付或抽牌。',
  '回合结束达到60两触发收市；先手触发时后手补最后一个完整回合。最后银两多者胜，平手由最后行动者胜。财富只属于本局。',
];

/** Renders safe synthetic projections. It never owns rules, accounts or writes. */
export function mountDigitalPage({ root, scenes, onScene, onAction, onLeave, onPeerMessage, externalDecisions = false } = {}) {
  if (!root) throw new TypeError('新版样板缺少挂载点。');
  const document = root.ownerDocument, window = document.defaultView;
  root.innerHTML = `<div class="yg-shell">
    <header class="yg-header room-header"><div class="yg-brand"><strong>幽街商人</strong><span>本地合成样板 · 未联网／未保存</span></div>
      <div class="room-toolbar" data-chat-notice-anchor><div class="room-toolbar-actions">
        ${button('chat-toggle', '聊天 <span id="chat-unread" class="chat-unread" hidden></span>', 'class="chat-toggle room-toolbar-action" aria-controls="room-chat" aria-expanded="false" hidden')}
        ${button('yg-settings', '设置', 'class="room-toolbar-action"')}${button('yg-exit', '×', 'class="room-toolbar-action room-toolbar-exit room-exit" aria-label="退出本地样板"')}
      </div></div></header>
    <section class="yg-table" aria-label="公共桌面" data-chat-dismiss-notices>
      <aside class="yg-piles" aria-label="抽牌与弃牌"><button type="button" id="yg-draw-pile" class="yg-pile"><span class="yg-pile-art">${renderCardBack()}</span><span>抽牌堆 <b id="yg-deck-count"></b></span></button>
        <button type="button" id="yg-discard-pile" class="yg-pile"><span class="yg-discard-mark" aria-hidden="true">弃</span><span>弃牌区 <b id="yg-discard-count"></b></span></button></aside>
      <main class="yg-centre"><div class="yg-stage"><div><h1 id="yg-title">轮到你经营</h1><span id="yg-room-code">示例房号610036</span></div><div class="yg-time"><strong id="yg-clock">24:12</strong><small id="yg-clock-label">定格时钟示例</small></div></div>
        <div id="yg-track" class="yg-track" aria-label="共享行动条"><span id="yg-track-label"></span><div id="yg-track-steps" role="meter" aria-labelledby="yg-track-label" aria-valuemin="0"></div></div><div id="yg-readiness" class="yg-readiness" hidden></div>
        <div id="yg-scene-content" class="yg-scene-content"></div>
      </main>
      <aside id="yg-peer" class="yg-peer" aria-label="其他玩家的公开商铺"></aside>
      <aside class="yg-storage"><section id="yg-public-stock" class="yg-public"><div class="yg-public-heading"><strong>公共货摊</strong><span id="yg-stock-limit"></span></div><button type="button" id="yg-market" class="yg-market" aria-label="查看六类公共货物和库存详情"></button></section>
        <section id="yg-personal" class="yg-personal" aria-label="我的货物"><button type="button" id="yg-shop-detail"><span class="yg-personal-heading"><strong>我的货物</strong><span id="yg-silver"></span></span><span id="yg-stock-slots" class="yg-stock-slots"></span><span class="yg-shop-note" id="yg-shop-note"></span></button>${button('yg-expand', '扩摊', 'aria-label="查看扩摊费用"')}</section>
      </aside>
    </section>
    <div class="yg-lower" data-chat-dismiss-notices><section id="yg-tool-zone" class="yg-tool-zone" aria-label="已装备道具"><div class="yg-tool-heading"><strong>已装备</strong><span id="yg-tool-count"></span></div><div id="yg-tools" class="yg-tools"></div></section>
      <section id="yg-hand-section" class="yg-hand-section" aria-label="我的手牌"><div class="yg-hand-heading"><strong id="yg-hand-title">我的手牌</strong><span class="yg-hand-guide">横滑看牌 · 点牌选择</span></div><div id="yg-hand" class="yg-hand" tabindex="0" aria-label="全部手牌，左右滑动或方向键浏览"></div></section>
      <section id="yg-observer-note" class="yg-observer-note" hidden><h2>观战只看公开信息</h2><p>这里不会显示任何人的手牌、私看候选或未公开的牌序。</p></section>
    </div><p id="yg-feedback" class="yg-feedback" role="status" aria-live="polite">合成局面只用于检查页面和选择流程；主题、音量偏好沿用本机设置。</p>
    <section id="yg-rotation" class="yg-rotation" hidden><div aria-hidden="true" class="yg-rotate-icon">↻</div><h2>横过来，展开整张夜市。</h2><p>聊天、设置和退出仍在上方。横竖切换保留当前选择与聊天草稿。</p><div id="yg-portrait-decision"></div><small>本地合成样板 · 不保存牌局</small></section>
    </div>
    <dialog id="yg-options" class="yg-dialog"><div class="dialog-heading"><h2>设置</h2>${button('yg-options-close', '×', 'class="close-button" aria-label="关闭设置"')}</div><div class="game-settings-body">
      <section><h3>页面检查</h3><p>房号、双方、库存及聊天都是当前标签页内的合成示例。这里没有创建正式牌局，也不是完整练习。</p><label for="yg-scene">检查局面</label><select id="yg-scene">${scenes.map(([id, label]) => `<option value="${id}">${escape(label)}</option>`).join('')}</select><div class="game-settings-controls">${button('yg-peer-message', '模拟伙伴发言')}${button('yg-catalog', '查看51种卡牌')}</div></section>
      <section><h3>手牌分类</h3><select id="yg-hand-filter" aria-label="手牌分类"><option value="all">全部</option>${CATEGORIES.map(category => `<option value="${category.id}">${escape(category.name)}</option>`).join('')}</select></section><section><h3>声音与玩法</h3><div class="game-settings-controls">${button('sound-toggle', '点按启声')}${button('yg-rules', '玩法说明')}</div><div class="sound-settings"><label for="sound-volume">音效音量</label><input id="sound-volume" type="range" min="0" max="100" step="5" value="45"><select id="sound-preview-kind" aria-label="试听声音"><option value="select">选牌</option><option value="draw">看牌</option><option value="placement">公共出牌</option><option value="turn">轮到自己／回应</option><option value="chat">伙伴发言</option><option value="win">收市结束</option></select>${button('sound-preview', '试听')}<span id="sound-preview-status" role="status"></span></div></section>
      <section><h3>样板出口</h3><div class="game-settings-controls">${button('yg-copy-invite', '复制样板邀请')}${button('yg-settings-exit', '退出本地样板')}</div><p id="chat-legacy-note" hidden></p></section></div></dialog>
    <dialog id="yg-decision" class="yg-dialog yg-decision-dialog" aria-labelledby="yg-decision-title"><div class="dialog-heading"><h2 id="yg-decision-title"></h2>${button('yg-decision-close', '×', 'class="close-button" aria-label="收起待决选择，保留当前步骤"')}</div><div id="yg-decision-body"></div></dialog>
    <dialog id="yg-inspector" class="yg-dialog" aria-labelledby="yg-inspector-title"><div class="dialog-heading"><h2 id="yg-inspector-title">卡牌详情</h2>${button('yg-inspector-close', '×', 'class="close-button" aria-label="关闭详情"')}</div><div id="yg-inspector-body"></div></dialog>
    <dialog id="yg-leave" class="yg-dialog"><div class="dialog-heading"><h2>退出本地样板？</h2>${button('yg-leave-close', '×', 'class="close-button" aria-label="继续查看样板"')}</div><p>示例局面和聊天只在当前标签页内。退出不会影响任何真实房间、账号或伙伴。</p><div class="yg-dialog-actions">${button('yg-stay', '继续查看')}${button('yg-leave-confirm', '退出样板', 'class="yg-primary"')}</div></dialog>
    ${roomChatMarkup()}
    <div id="yg-chat-decision" class="yg-chat-decision" hidden><strong id="yg-chat-decision-label"></strong>${button('yg-chat-decision-open', '查看当前选择')}</div>`;
  const $ = id => document.getElementById(id), removers = [];
  let view = null, selectedHand = null, selectedChoices = [], destroyed = false;
  let returnToDecision = false, pendingDraft = null, appliedScope = null, appliedDecisionId = null, bidDraft = null, feedbackTimer;
  let renderedHand = null;
  const audio = createGameAudio({ document, window });
  const audioControls = mountRoomAudioControls({ audio, document });
  const unmountArt = mountArtFallback(root);
  const settings = mountRoomSettings({ document, buttonId: 'yg-settings', dialogId: 'yg-options', closeButtonId: 'yg-options-close',
    dismissIds: ['yg-rules', 'yg-catalog', 'yg-settings-exit', 'yg-peer-message', 'yg-copy-invite'] });
  function listen(target, type, callback, options) {
    target.addEventListener(type, callback, options); removers.push(() => target.removeEventListener(type, callback, options));
  }
  function feedback(message) {
    if (destroyed) return;
    $('yg-feedback').textContent = message; $('yg-feedback').classList.add('is-feedback');
    window.clearTimeout(feedbackTimer); feedbackTimer = window.setTimeout(() => $('yg-feedback').classList.remove('is-feedback'), 5000);
  }
  function closeDialogs() { root.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); }
  function clearPrivatePanels() {
    closeDialogs();
    $('yg-inspector-body').replaceChildren(); $('yg-decision-body').replaceChildren();
    $('yg-inspector-title').textContent = '卡牌详情'; $('yg-decision-title').textContent = '';
    returnToDecision = false; pendingDraft = null;
  }
  function openDialog(id) { closeDialogs(); $(id).showModal(); }
  function inspect(title, content, { fromDecision = false } = {}) {
    returnToDecision = fromDecision; $('yg-inspector-title').textContent = title;
    $('yg-inspector-body').innerHTML = content; openDialog('yg-inspector');
  }
  function closeInspector() {
    $('yg-inspector').close(); pendingDraft = null;
    if (returnToDecision && isOwnDecision(view)) { returnToDecision = false; openDecision(); }
  }
  function invoke(type, fields = {}) { if (!destroyed) onAction?.(type, { ...fields, decisionId: view.decision?.id }); }
  const filteredHand = () => (view?.selfRole === 'player' ? view.hand : []).filter(card =>
    $('yg-hand-filter').value === 'all' || definition(card).category === $('yg-hand-filter').value);
  function renderHand() {
    const cards = filteredHand(), hand = $('yg-hand'), scroll = hand.scrollLeft;
    $('yg-hand-title').textContent = `我的手牌 ${view?.hand.length ?? 0}`;
    const markup = cards.length ? cards.map(card => `<div class="yg-hand-card" data-entity-id="${escape(card.id)}">${renderCard(card, { interactive: true, selected: card.id === selectedHand })}</div>`).join('') : '<p class="yg-empty">这个分类没有手牌。</p>';
    // Presence/clock updates must not interrupt a swipe or discard keyboard focus.
    if (renderedHand !== markup) { hand.innerHTML = markup; renderedHand = markup; hand.scrollLeft = scroll; }
  }
  function actions() {
    if (view.phase === 'waiting') return (view.selfRole === 'player' ? action('ready', view.players[0].ready ? '取消准备' : '准备好了', 'class="yg-primary"') : '<strong>你正在观战</strong>')
      + action('start', '开始样板', view.players.every(player => player.ready) && view.selfRole === 'player' ? '' : 'disabled')
      + action('role', view.selfRole === 'player' ? '改为观战' : '加入对局');
    if (view.phase === 'finished') return action('rematch', '回准备室', 'class="yg-primary"');
    if (view.scene === 'paused') return action('resume', '模拟双方回桌继续', 'class="yg-primary"');
    if (view.scene === 'suspended') return action('recover', '模拟同席位恢复', 'class="yg-primary"');
    if (isOwnDecision(view)) return button('yg-decision-open', '展开当前选择', 'class="yg-primary"');
    return canOperate(view) ? action('peek', '看一张 · 1行动', 'class="yg-primary"') + action('end-turn', '结束回合')
      : '<span class="yg-readonly">可以查看公开区域，等待伙伴。</span>';
  }
  function renderTable() {
    const player = view.players.find(entry => entry.id === view.currentPlayerId);
    const title = view.phase === 'waiting' ? '两个人坐好，就开张。' : view.phase === 'finished' ? '夜市收市 · 我方68两获胜'
      : view.scene === 'paused' ? '共同暂停 · 余时冻结' : view.scene === 'suspended' ? '伙伴离线 · 当前步骤已挂起'
      : isOwnDecision(view) ? view.decision.title : view.selfRole === 'spectator' ? '观战 · 只读公开牌面'
      : canOperate(view) ? '轮到你经营' : '灯笼铺老板正在经营';
    $('yg-title').textContent = title; $('yg-title').title = title;
    $('yg-room-code').textContent = `示例房号 ${view.roomCode} · ${view.spectatorCount}位观众`;
    $('yg-clock').textContent = view.scene === 'paused' ? '24:12' : view.scene === 'suspended' ? '29:42' : view.decision?.clock ?? view.clock;
    $('yg-clock-label').textContent = view.scene === 'suspended' ? '保席余时示例' : view.decision ? '选择余时示例' : '主动余时示例';
    $('yg-track').hidden = ['waiting', 'finished'].includes(view.phase);
    $('yg-readiness').hidden = !['waiting', 'finished'].includes(view.phase);
    $('yg-readiness').innerHTML = view.players.map(entry => `<span><strong title="${escape(entry.name)}">${entry.id === view.selfId ? '我' : '伙伴'}</strong><b>${view.phase === 'finished' ? `${entry.silver}两` : entry.ready ? '已准备' : '未准备'}</b></span>`).join('');
    $('yg-track-label').textContent = `${player?.id === view.selfId ? '我' : '伙伴'}的行动 · ${view.actionsUsed}/${view.actionLimit}`;
    $('yg-track-steps').setAttribute('aria-valuemax', String(view.actionLimit));
    $('yg-track-steps').setAttribute('aria-valuenow', String(view.actionsUsed));
    $('yg-track-steps').setAttribute('aria-valuetext', `已用${view.actionsUsed}步，余${view.actionLimit - view.actionsUsed}步`);
    $('yg-track-steps').innerHTML = renderActionTrack(view.actionsUsed, view.actionLimit);
    let note = '先选手牌阅读费用和效果；未确认前可取消。';
    if (view.decision) note = view.decision.description;
    else if (view.phase === 'waiting') note = `${view.players.map(entry => `${entry.name}：${entry.ready ? '已准备' : '未准备'}`).join(' · ')}。邀请与观战仅作页面演示。`;
    else if (view.phase === 'finished') note = `${view.resultReason} 伙伴64两；本局财富不累计到账号。`;
    else if (view.scene === 'paused') note = '双方已同意暂停，原选择和余时保留。7天截止不因自然离线而改成30分钟。';
    else if (view.scene === 'suspended') note = '意外断线保席30分钟；两人都离线不会自动交易或攒钱。恢复后继续原步骤。';
    else if (view.scene === 'dense') note = '手牌连续横滑浏览；分类与横竖切换不改牌序。';
    else if (view.scene === 'full') note = '五个普通格已满，临时格占用且已付2两；腾空不退款，再占用才收费。';
    else if (view.selfRole === 'spectator') note = '双方私牌、私看候选和未来牌序都不显示。';
    $('yg-scene-content').innerHTML = `<p class="yg-scene-note">${escape(note)}</p><div class="yg-table-actions">${actions()}${view.phase === 'waiting' ? button('yg-waiting-invite', '复制样板邀请') : ''}</div>`;
    $('yg-deck-count').textContent = `${view.deckCount}张`; $('yg-discard-count').textContent = `${view.discardCount}张`;
    $('yg-discard-pile').disabled = !view.discard;
    $('yg-market').innerHTML = view.market.map(good => `<span class="yg-market-good" aria-label="公共${escape(good.name)}${good.count}件">${renderGoodsIcon(good.id)}<span>${escape(good.name)}</span><strong>${good.count}</strong></span>`).join('');
    $('yg-stock-limit').textContent = `每类${view.goodsPerType ?? 6}件`;
    const publicPlayers = view.selfRole === 'player' ? view.players.filter(entry => entry.id !== view.selfId) : view.players;
    $('yg-peer').classList.toggle('is-observer', view.selfRole !== 'player');
    $('yg-peer').innerHTML = publicPlayers.map(entry => renderPublicPlayerPanel(entry, {
      bookLayers: entry.id === view.currentPlayerId ? view.bookLayers : 0,
      finalTurn: entry.id === view.closing?.finalPlayerId,
    })).join('');
    const self = view.selfRole === 'player' ? view.players.find(entry => entry.id === view.selfId) : null;
    $('yg-personal').hidden = !self; $('yg-hand-section').hidden = !self; $('yg-tool-zone').hidden = !self; $('yg-observer-note').hidden = !!self;
    if (self) {
      $('yg-silver').textContent = `${self.silver}两`;
      $('yg-stock-slots').innerHTML = GOODS.map(good => `<span class="yg-owned-good" aria-label="我的${escape(good.name)}${self.goods.find(item => item.id === good.id)?.count ?? 0}件" title="${escape(good.name)}">${renderGoodsIcon(good.id)}<b>${self.goods.find(item => item.id === good.id)?.count ?? 0}</b></span>`).join('');
      $('yg-shop-note').textContent = `${totalGoods(self)}/${self.ordinaryCapacity}普通格＋1临时格 · ${view.temporaryPaid ? '临时已付2两' : '临时占用付2两'}`;
      $('yg-tool-count').textContent = `${self.tools.length}/3`;
      $('yg-tools').innerHTML = self.tools.length ? self.tools.map(tool => `<button type="button" data-tool-id="${escape(tool.id)}" class="yg-equipped${tool.tapped ? ' is-tapped' : ''}" aria-label="${escape(definition(tool).name)}，${tool.tapped ? '已用，本回合不可再发动' : '可用'}">${renderCard(tool, { interactive: false })}<span class="yg-equipped-state">${tool.tapped ? '已用' : '可用'}</span></button>`).join('') : '<span class="yg-tool-empty">道具放在这里<br>先安装，再使用</span>';
    } else { $('yg-stock-slots').replaceChildren(); $('yg-tools').replaceChildren(); }
    renderHand();
    $('yg-portrait-decision').innerHTML = isOwnDecision(view) ? `<strong>${escape(view.decision.title)} · ${view.decision.clock}</strong>${button('yg-portrait-decision-open', '查看并处理当前选择', 'class="yg-primary"')}` : '';
    syncChatDecision();
  }
  function renderDecision() {
    if (!isOwnDecision(view)) return;
    const decision = view.decision;
    $('yg-decision-title').textContent = decision.title;
    const controls = decision.kind === 'peek' ? action('keep-peek', '留下 · 转入用牌', 'class="yg-primary"') + action('discard-peek', '弃掉 · 可继续看')
      : decision.kind === 'response' ? action('respond', escape(decision.acceptLabel), 'class="yg-primary"') + action('decline-response', escape(decision.declineLabel))
      : decision.kind === 'auction' ? `<label class="yg-bid-label" for="yg-bid">我的报价 <input id="yg-bid" type="number" inputmode="numeric" min="${decision.nextBid}" max="${decision.maxBid}" step="1" value="${escape(bidDraft ?? decision.nextBid)}"> 两</label>${action('bid', escape(decision.confirmLabel), 'class="yg-primary"')}${action('pass-bid', '放弃竞价')}`
      : action('choose-effect', escape(decision.confirmLabel), `class="yg-primary" ${selectedChoices.length >= decision.min ? '' : 'disabled'}`);
    $('yg-decision-body').innerHTML = `<div class="yg-decision-context"><p>${escape(decision.description)}</p><span class="yg-decision-clock">${decision.private ? '仅你可见' : '公开步骤'} · 余时 ${decision.clock}（定格）${view.currentPlayerId !== view.selfId ? ` · 对方主动钟冻结于${decision.activeRemaining}` : ' · 使用自己的主动余时'}</span>
      ${decision.sourceId ? `<button type="button" data-detail-id="${decision.sourceId}">查看${escape(getCard(decision.sourceId).name)}完整牌文</button>` : ''}</div>
      ${decision.kind === 'response' ? `<div class="yg-response-effect">${renderCardDetails(getCard(decision.sourceId))}<p><strong>你的回应：</strong>${escape(getCard(decision.responseId).summary)}</p></div>` : `<p class="yg-candidates-guide">共${decision.candidates.length}${decision.candidates[0]?.kind === 'good' ? '件货物' : '张牌'} · 向下滚动可看完整${decision.kind === 'auction' ? '拍品' : '候选'}，每张均可查看详情。</p><div class="yg-candidates">${renderDecisionCandidates(decision, selectedChoices)}</div>`}
      ${decision.outcome ? `<p class="yg-decision-outcome">${escape(decision.outcome)}</p>` : ''}
      <p class="yg-committed-note">${escape(decision.notice)}</p><div class="yg-dialog-actions yg-decision-actions">${controls}</div>`;
  }
  function openDecision() { if (!isOwnDecision(view)) return; renderDecision(); openDialog('yg-decision'); }
  function cardDetail(card, { fromDecision = false, tool = null } = {}) {
    const cardData = definition(card), usable = canOperate(view);
    const inHand = view.hand.some(entry => entry.id === card.id);
    const reactionOnly = ['yousei.c04', 'yousei.c07'].includes(cardData.id);
    const operations = tool && usable ? action('prepare-tool', tool.tapped ? '本回合已使用' : '准备使用 · 1行动', tool.tapped ? 'disabled' : '')
      : inHand && usable && !reactionOnly ? cardData.category === 'goods'
      ? action('prepare-buy', `买入 · ${cardData.buySilver}两`) + action('prepare-sell', `卖出 · ${cardData.sellSilver}两`)
      : action('prepare-use', cardData.category === 'tool' ? '准备安装 · 1行动' : '准备使用 · 1行动')
      : '';
    inspect(cardData.name, `${renderCardDetails(cardData)}${reactionOnly ? '<p class="yg-detail-state">这张牌仅在对方对应的回应窗口免费使用；现在不会作为普通1行动人物发动。</p>' : ''}${tool ? `<p class="yg-detail-state">${tool.tapped ? '当前横置，不能再次使用；本人回合结束恢复竖直。' : '当前竖直；确认使用后横置。同名道具分别计算。'}</p>` : ''}<div class="yg-dialog-actions">${operations}</div><p>这里只演示阅读与选择；未进行真实结算。</p>`, { fromDecision });
  }
  function showPrepared(type) {
    const card = view.hand.find(entry => entry.id === selectedHand) ?? view.players.find(entry => entry.id === view.selfId)?.tools.find(entry => entry.id === selectedHand);
    if (!card || !canOperate(view)) return;
    pendingDraft = { type, cardId: card.id, scene: view.scene };
    const name = definition(card).name;
    inspect(`确认${type === 'prepare-buy' ? '买入' : type === 'prepare-sell' ? '卖出' : '使用'} · ${name}`, `${renderCardDetails(card)}<p>这是发起前的确认。现在取消不会扣钱、耗步或改动牌区；确认后演示相应待决步骤。</p><div class="yg-dialog-actions">${button('yg-cancel-draft', '取消')}${button('yg-confirm-draft', '确认模拟操作', 'class="yg-primary"')}</div>`);
  }
  function syncChatDecision() {
    if (!view) return;
    const show = !$('room-chat').hidden && isOwnDecision(view);
    $('yg-chat-decision').hidden = !show;
    $('yg-chat-decision-label').textContent = show ? `${view.decision.title} · ${view.decision.clock}` : '';
    document.body.classList.toggle('yg-has-chat-decision', show);
  }
  function resize() {
    if (destroyed) return;
    const frame = gameViewport({ width: window.innerWidth, height: window.innerHeight, visual: window.visualViewport,
      editing: document.activeElement?.matches('input,textarea') });
    root.style.setProperty('--yg-height', `${frame.height}px`); root.style.setProperty('--yg-top', `${frame.top}px`);
    const portrait = window.innerWidth < window.innerHeight;
    root.classList.toggle('yg-portrait', portrait); $('yg-rotation').hidden = !portrait;
    root.querySelector('.yg-table').inert = portrait; root.querySelector('.yg-lower').inert = portrait;
    document.body.classList.toggle('yg-keyboard', frame.height < window.innerHeight - 80);
    if (frame.resetScroll && (window.scrollX || window.scrollY)) window.scrollTo(0, 0);
  }
  function applyView(next) {
    if (destroyed) return;
    const scope = [next.roomId, next.matchId, next.selfId, next.selfRole, next.scene].join(':');
    const scopeChanged = appliedScope !== scope;
    const decisionChanged = appliedDecisionId !== next.decision?.id;
    if (!externalDecisions && view !== next) closeDialogs();
    if (scopeChanged) { selectedHand = null; $('yg-hand-filter').value = 'all'; $('yg-hand').scrollLeft = 0; }
    if (scopeChanged || decisionChanged) { clearPrivatePanels(); selectedChoices = []; bidDraft = null; }
    view = next; appliedScope = scope; appliedDecisionId = view.decision?.id;
    root.dataset.scene = view.scene; root.dataset.role = view.selfRole;
    $('yg-scene').value = view.scene; renderTable(); resize();
    if (!externalDecisions && $('yg-decision').open) { if (isOwnDecision(view)) renderDecision(); else $('yg-decision').close(); }
  }
  async function copyInvite() {
    const url = new URL(window.location.href); url.search = '?scene=waiting';
    try { await window.navigator.clipboard.writeText(`幽街商人本机合成样板（不是正式房间邀请）：${url}`); feedback('已复制本机样板地址；不连接正式房间。'); }
    catch { if (!destroyed) inspect('样板邀请', `<p>仅当前本机预览可打开，不是正式邀请。</p><input aria-label="样板邀请地址" value="${escape(url)}" readonly>`); }
  }
  listen(root, 'click', event => {
    const node = event.target.closest('button'); if (!node || node.disabled || destroyed) return;
    if (node.dataset.previewAction) {
      const type = node.dataset.previewAction;
      if (type.startsWith('prepare-')) { showPrepared(type); return; }
      if (type === 'choose-effect' && (!isOwnDecision(view) || selectedChoices.length < view.decision.min)) return;
      let amount;
      if (type === 'bid') {
        amount = Number($('yg-bid')?.value); const decision = view.decision;
        if (!Number.isSafeInteger(amount) || amount < decision.nextBid || amount > decision.maxBid) { $('yg-bid').setCustomValidity(`请输入${decision.nextBid}～${decision.maxBid}的整数银两。`); $('yg-bid').reportValidity(); return; }
      }
      invoke(type, { selected: [...selectedChoices], ...(amount === undefined ? {} : { amount }) }); return;
    }
    if (node.dataset.choice) {
      if (!isOwnDecision(view) || !view.decision.candidates.some(candidate => candidate.id === node.dataset.choice)) return;
      selectedChoices = selectedChoices.includes(node.dataset.choice) ? [] : [node.dataset.choice]; renderDecision(); audio.play('select'); return;
    }
    if (node.dataset.detailId) { cardDetail(getCard(node.dataset.detailId), { fromDecision: $('yg-decision').open }); return; }
    if (node.dataset.cardId) {
      const id = node.closest('[data-entity-id]')?.dataset.entityId;
      const card = view.hand.find(entry => entry.id === id); if (!card || view.selfRole !== 'player') return;
      selectedHand = id; renderHand(); audio.play('select'); cardDetail(card); return;
    }
    if (node.dataset.toolId) {
      const tool = view.players.find(entry => entry.id === view.selfId)?.tools.find(entry => entry.id === node.dataset.toolId);
      if (tool) { selectedHand = tool.id; cardDetail(tool, { tool }); } return;
    }
    if (node.dataset.player || node.id === 'yg-shop-detail') {
      const player = view.players.find(entry => entry.id === (node.dataset.player ?? view.selfId));
      if (player) inspect(`${player.name} · 公开商铺`, `<p>${player.silver}两 · 普通容量${player.ordinaryCapacity}格＋1临时格 · 手牌${player.handCount}张</p><div class="yg-detail-goods">${player.goods.map(good => `<div>${renderGoodsIcon(good.id)}<strong>${escape(goodName(good.id))}</strong><span>${good.count}件</span></div>`).join('')}</div><h3>已装道具</h3><div class="yg-candidates">${player.tools.map(tool => `<article>${renderCard(tool, { tapped: tool.tapped, interactive: false })}<p>${tool.tapped ? '横置 · 已用' : '竖直 · 可用'}</p></article>`).join('')}</div><p>其他人的手牌和私看候选不在这里显示。</p>`); return;
    }
    if (node.id === 'yg-market') { inspect('公共货摊 · 六类库存', `<div class="yg-detail-goods">${view.market.map(good => `<div>${renderGoodsIcon(good.id)}<strong>${good.name}</strong><span>${good.count}件</span></div>`).join('')}</div><p>本局开局每类${view.goodsPerType ?? 6}件；当前库存已扣除双方货物。购买时必须满足完整配方，不能缺货先扣款。</p>`); return; }
    if (['yg-decision-open', 'yg-portrait-decision-open', 'yg-chat-decision-open'].includes(node.id)) { openDecision(); return; }
    if (node.id === 'yg-decision-close') { $('yg-decision').close(); feedback('当前步骤与已选候选保留；没有取消、退款或重新抽取。'); return; }
    if (node.id === 'yg-inspector-close' || node.id === 'yg-cancel-draft') { closeInspector(); return; }
    if (node.id === 'yg-confirm-draft') { const draft = pendingDraft; if (draft && draft.scene === view.scene) { pendingDraft = null; invoke('confirm-draft', draft); } return; }
    if (node.id === 'yg-draw-pile') { if (canOperate(view)) invoke('peek'); else feedback('现在只能查看牌堆张数；不能越过当前待决步骤抽牌。'); return; }
    if (node.id === 'yg-discard-pile') { if (view.discard) cardDetail(view.discard); return; }
    if (node.id === 'yg-expand') { inspect('扩展商铺', `<h3>3个新的普通格</h3><p>公共扩摊板剩${view.expansionStock}块。本次价格${view.expansionPrice}两；须持许可、处于自己的用牌阶段且有1行动。</p><p>全局首块6两，之后每块3两。扩容后临时格自动腾空，已经支付的临时费不退。</p><div class="yg-extension-slots"><span>普通格</span><span>普通格</span><span>普通格</span></div><p>当前仅说明费用，没有假装扣款或取得扩摊板。</p>`); return; }
    if (node.id === 'yg-waiting-invite' || node.id === 'yg-copy-invite') { void copyInvite(); return; }
    if (['yg-exit', 'yg-settings-exit'].includes(node.id)) { openDialog('yg-leave'); return; }
    if (['yg-stay', 'yg-leave-close'].includes(node.id)) { $('yg-leave').close(); return; }
    if (node.id === 'yg-leave-confirm') { onLeave?.(); return; }
    if (node.id === 'yg-peer-message') { onPeerMessage?.(); return; }
    if (node.id === 'yg-rules') { inspect('幽街商人 · 数字版规则', `<ol class="yg-rules">${RULES.map(rule => `<li>${escape(rule)}</li>`).join('')}</ol>`); return; }
    if (node.id === 'yg-catalog') inspect('51种卡牌 · 新版完整卡目', `<p>公开定义可查。点击牌文详情，人物、监视人物与道具按类型区别。</p><div class="yg-catalog">${CARDS.map(card => `<article>${renderCard(card, { interactive: false })}<button type="button" data-detail-id="${card.id}">查看${escape(card.name)}</button></article>`).join('')}</div>`);
  });
  listen($('yg-scene'), 'change', event => { settings.close(); onScene?.(event.target.value); });
  listen($('yg-hand-filter'), 'change', () => { $('yg-hand').scrollLeft = 0; renderHand(); });
  listen($('yg-inspector'), 'cancel', event => { event.preventDefault(); closeInspector(); });
  listen($('yg-decision'), 'cancel', event => { event.preventDefault(); $('yg-decision').close(); });
  listen($('yg-decision'), 'input', event => {
    if (event.target.id === 'yg-bid') { bidDraft = event.target.value; event.target.setCustomValidity(''); }
  });
  const viewport = mountGameViewport({ window, document, sync: resize, recoveryDelays: [80, 250] });
  const observer = new window.ResizeObserver(resize); observer.observe($('yg-hand'));
  const chatObserver = new window.MutationObserver(syncChatDecision); chatObserver.observe($('room-chat'), { attributes: true, attributeFilter: ['hidden'] });
  $('chat-title').textContent = '样板双成员聊天'; root.querySelector('.chat-heading p').textContent = '仅当前标签页内 · 未连接真实伙伴 · 退出即清空';
  return { applyView, openDecision, audio, feedback, settings, destroy() {
    if (destroyed) return; destroyed = true; clearPrivatePanels(); removers.forEach(remove => remove());
    viewport.destroy(); observer.disconnect(); chatObserver.disconnect(); settings.destroy(); audioControls.destroy(); void audio.close();
    unmountArt(); window.clearTimeout(feedbackTimer); document.body.classList.remove('yg-keyboard', 'yg-has-chat-decision');
    view = null; selectedChoices = []; selectedHand = null; bidDraft = null; root.replaceChildren();
  } };
}
