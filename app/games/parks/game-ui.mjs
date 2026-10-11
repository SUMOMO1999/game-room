import { getDefinition, CANTEEN_TOKENS } from './content/catalog.mjs';
import { renderCard, renderDetail, resourceLine, resourceIcon, RESOURCE_NAMES, escapeHtml as esc, cardName, mountImageFallback } from './card-ui.mjs';
import { getSymbolSvg, SYMBOL_IDS } from './content/vector-art.mjs';
import { createParksDraft, actionIdentity, parksViewScope, parksStageProfiles, createParksDisplayClock } from './game-ui-model.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountRoomSettings } from '../../platform/room-settings.mjs';
import { mountGameStageFit } from '../../platform/game-stage-fit.mjs';
import { createObjectMotion } from '../../platform/object-motion.mjs';
import { roomChatMarkup } from '../../room-chat.mjs';

const tokens = new Map(CANTEEN_TOKENS.map(value => [value.id, value.definitionId]));
const definition = id => { try { return getDefinition(tokens.get(id) || id); } catch { return null; } };
const name = id => definition(id) ? cardName(definition(id)) : '';
const siteSymbols = { 'wildlife-trade': 'exchange', 'canteen-or-photo': 'camera', 'trail-die': 'die', parks: 'mountain', 'trail-end': 'first-player' };
const symbol = (id, size = 28) => getSymbolSvg(siteSymbols[id] || (SYMBOL_IDS.includes(id) ? id : 'trail'), { size });
const button = (label, attrs = '') => `<button type="button" ${attrs}>${label}</button>`;
const dialog = (id, title, body) => `<dialog id="${id}" class="pg-dialog"><header><h2>${title}</h2>${button('×', `data-close="${id}" aria-label="关闭${title}"`)}</header>${body}</dialog>`;
const seasons = ['春', '夏', '秋'];
const resourceText = vector => Object.entries(vector || {}).filter(([key, count]) => RESOURCE_NAMES[key] && count > 0).map(([key, count]) => `${RESOURCE_NAMES[key]}${count}`).join('、');

/** Quotes are supplied by the engine. Presentation never reconstructs prices. */
export function actionOutcome(action) {
  const result = action?.result || {}, parts = [];
  if (result.targetId) parts.push(name(result.targetId));
  if (result.points) parts.push(`获得${result.points}分`);
  if (result.photos) parts.push(`拍摄${result.photos}张照片`);
  if (result.resources) parts.push(`获得${resourceText(result.resources)}`);
  if (result.rowIndex !== undefined && result.rowIndex !== null) parts.push(`放入第${result.rowIndex + 1}行`);
  if (result.canteenIds?.length) parts.push(action.type === 'allocate-water'
    ? result.canteenIds.map(id => `${name(id)}：${definition(id)?.shortText || '执行该壶效果'}`).join('，')
    : `获得${result.canteenIds.length}枚水壶`);
  if (result.instant?.length) parts.push(result.instant.map(step => step.resources ? `立即获得${resourceText(step.resources)}` : ({ die: '掷步道骰', badge: '取得摄影徽章', canteen: '取得水壶', 'free-photo': '免费拍照' }[step.kind] || '')).filter(Boolean).join('，'));
  if (result.triggerText) parts.push(`触发条件：${result.triggerText}${result.effectText ? `；触发后：${result.effectText}` : ''}`);
  else if (result.effectText) parts.push(result.effectText);
  if (result.forgoOptionalCount) parts.push(`放弃${result.forgoOptionalCount}项未用额外收益`);
  if (action?.type === 'move-hiker') parts.push(action.fields.arrivalMode === 'camping' ? name(action.fields.campingSlotId) : action.fields.position === 10 ? `终点 · ${{parks:'预订或游览公园',photo:'拍照',gear:'购买装备'}[action.fields.endSlot] || '抵达步道终点'}` : `向前移动到第${action.fields.position}站`);
  if (action?.type === 'move-hiker') { parts.push(result.campfireUsed ? '消耗营火' : '不消耗营火'); if (result.weather) parts.push(`领取天气：${RESOURCE_NAMES[result.weather]}`); if (result.arrivalMode === 'camping') parts.push('露营，不领取地点天气'); if (result.siteId && result.arrivalMode !== 'camping') parts.push(definition(result.siteId)?.shortText); }
  if (result.firstArrivalReward) parts.push({ parks: '公园位首到奖励：取得起始标记', photo: '摄影位首到奖励：野生动物1', gear: '装备位首到奖励：阳光1' }[result.firstArrivalReward]);
  if (action?.type === 'allocate-water') parts.push(action.fields.rowIndex === null ? '水进入背包' : `填满第${action.fields.rowIndex + 1}行，立即执行水壶效果`);
  if (action?.type === 'choose-passion') parts.push(action.fields.choice === 'ability' ? '获得本局永久能力' : '选择终局计分', result.text);
  if (action?.type === 'choose-starting-passion') parts.push(result.goalText, `能力：${result.abilityText || ''}`, `计分：${result.scoringText || ''}`);
  if (action?.type === 'discard-resources') parts.push(`归还${resourceText(action.fields.resources)}`);
  return parts.filter(Boolean).join(' · ');
}

export function quoteCost(action) {
  const cost = action?.cost, payment = action?.fields?.payment;
  if (!cost) return '';
  const costLine = value => value?.kind === 'photo' ? `${value.amount}张照片` : value?.kind === 'resource' ? `${RESOURCE_NAMES[value.resource]}${value.amount}` : value?.anyResource ? `任意资源${value.anyResource}` : resourceLine(value) || '免费';
  const adjustments = [...(cost.discounts || []).map(value => value.label), resourceText(cost.extraCost) ? `项目加收${resourceText(cost.extraCost)}` : ''].filter(Boolean);
  const pricing = cost.printedCost ? `印刷 ${costLine(cost.printedCost)} → 实际 ${costLine(cost.actualCost)}${adjustments.length ? ` · ${esc(adjustments.join('、'))}` : ''}` : cost.kind ? cost.kind === 'photos' ? `营费：${cost.amount}张照片` : cost.kind === 'resource' ? `营费：${RESOURCE_NAMES[cost.resource]}${cost.amount}` : '' : '';
  return `<div class="pg-cost">${pricing ? `<span>${pricing}</span>` : ''}${payment ? `<span>付款 ${resourceLine(payment) || '免费'}</span>` : ''}${cost.remainingResources ? `<span title="付款后的背包余额，尚未计入本次收益与填壶">付后余额 ${resourceLine(cost.remainingResources) || '空'}</span>` : ''}${cost.remainingPhotos !== undefined ? `<span>付后${cost.remainingPhotos}张照片</span>` : ''}</div>`;
}

export function mountParksPage({ root, practice = false, tutorial = false, onAction = async () => {}, onLeave = async () => {},
  onRefresh = () => {}, onRetry = () => {}, onRecover = () => {}, onHistory = async () => null, onRestart = () => {}, onHint = () => {}, onTutorialControl = () => {}, onTutorialDescription = () => null } = {}) {
  const doc = root.ownerDocument, win = doc.defaultView, draft = createParksDraft(), displayClock = createParksDisplayClock(), listeners = [];
  let room = null, gate = { pending: false, canAct: false, connection: 'offline' }, hikerId = null, source = null,
    market = 'parks', personal = 'canteens', localBusy = false, closed = false, scope = null, inspectedId = null, generation = 0, activeRequest = 0, selectedTarget = null, recoveryFeedback = null, tutorialGuide = null;
  root.innerHTML = `<div class="pg-host" id="pg-host"><div class="pg-stage" id="pg-stage">
    <header class="pg-header"><div class="pg-brand"><strong>PARKS</strong><span>国家公园 <small>${tutorial ? '跟着走一趟' : practice ? '本机练习' : '朋友同行'}</small></span></div><button id="pg-room" type="button" hidden></button><span id="pg-connection"></span><div class="pg-public-controls"><button type="button" id="pg-season" class="pg-eyebrow" aria-label="查看当前季节目标与奖励"></button><button type="button" id="pg-die" hidden></button></div><nav>${button('聊天 <span id="chat-unread" class="chat-unread" hidden></span>', 'id="chat-toggle" hidden')}${button('设置', 'id="pg-settings"')}${button('×', 'id="pg-exit" aria-label="退出"')}</nav></header>
    <div id="pg-content" class="pg-content"><section class="pg-table"><div class="pg-topline"><div><h1 id="pg-title">正在展开旅程…</h1></div><div class="pg-public-info"><div id="pg-clock"></div></div></div>
      <div id="pg-roster" class="pg-roster" aria-label="同行者与公开材料"></div>
      <div id="pg-trail" class="pg-trail" aria-label="步道，从左到右向前"></div>
      <div class="pg-lower"><section class="pg-market"><header><h2>公共市场</h2><div id="pg-market-tabs"></div></header><div id="pg-market-cards"></div></section>
        <section class="pg-task" id="pg-task" aria-label="当前行动"><div id="pg-task-heading"></div><div id="pg-task-sources" class="pg-source-tabs"></div><div id="pg-choices" class="pg-choices"></div><div id="pg-quote" class="pg-quote"></div><div id="pg-commit" class="pg-commit"></div></section>
        <section class="pg-camping" id="pg-camping" hidden></section></div></section>
      <section class="pg-personal" id="pg-personal" aria-label="我的个人区域"><section class="pg-backpack"><header><h2>我的背包</h2><span id="pg-capacity"></span></header><div id="pg-resources"></div><div id="pg-hikers"></div></section><section class="pg-possessions"><header><div id="pg-personal-tabs"></div><select id="pg-personal-select" aria-label="查看我的物件"><option value="canteens">水壶</option><option value="gear">装备</option><option value="parks">公园</option><option value="passion">热忱</option></select><span id="pg-summary"></span></header><div id="pg-items" class="pg-items"></div></section></section>
      <footer class="pg-footer"><p id="pg-feedback" role="status" aria-live="polite"></p><div id="pg-recovery" hidden>${button('刷新核对', 'id="pg-refresh"')}${button('重试原操作', 'id="pg-retry"')}${button('恢复原席位', 'id="pg-recover"')}</div></footer></div>
    <section id="pg-rotate" class="pg-rotate" hidden><div>${symbol('trail', 80)}<h2>横过来，展开旅程。</h2><p>当前对局与选择会保留。</p></div></section>
    <section id="pg-too-small" class="pg-rotate" hidden><div><h2>请稍微展开窗口</h2><p>展开到至少 620 × 320，或使用全屏。当前对局会保留。</p></div></section></div></div>
    ${dialog('pg-options', '设置', `<div class="game-settings-body"><section><h3>声音</h3>${button('点按启声', 'id="sound-toggle"')}<label>音量<input id="sound-volume" type="range" min="0" max="100" step="5" value="45"></label><div class="sound-settings"><select id="sound-preview-kind" aria-label="试听声音"><option value="move">徒步</option><option value="draw">取牌</option><option value="placement">放置</option><option value="roll">掷骰</option><option value="turn">轮到你</option></select>${button('试听', 'id="sound-preview"')}<span id="sound-preview-status" role="status"></span></div></section><section><h3>旅程</h3><div class="game-settings-controls">${button('暂停', 'id="pg-pause"')}${button('玩法说明', 'id="pg-rules"')}${button('本局动态', 'id="pg-activity"')}${button('对局记录', 'id="pg-history"')}${practice ? button('当前提示', 'id="pg-hint"') + button('重新开始', 'id="pg-restart"') : button('复制邀请', 'id="pg-invite"')}</div><p id="pg-mode"></p></section><section id="pg-arrangement" hidden><h3>开局玩法</h3><form id="pg-config"><label>模式<select name="mode"><option value="standard">基础版 2～5人</option><option value="teddy">双人 Teddy</option><option value="solo">官方单人</option></select></label><label>露营<select name="camping"><option value="true">加入</option><option value="false">关闭</option></select></label><label>志愿项目<select name="volunteerCount">${[0,1,2,3,4].map(n=>`<option value="${n}">${n}个</option>`).join('')}</select></label><label>热忱<select name="passionChoice"><option value="choose">二选一</option><option value="random">随机分配</option></select></label><p>调整后所有玩家重新准备；开局后本局规则固定。</p><button type="submit" id="pg-config-save">确认修改</button></form></section></div>`)}
    ${dialog('pg-reading', '随行指南', '<div id="pg-reading-content"></div>')}
    ${dialog('pg-leave', '离开这趟旅程？', `<p id="pg-leave-note"></p><div class="pg-dialog-actions">${button('继续玩', 'data-close="pg-leave"')}${button(practice ? '保存并返回' : '保留席位，返回大厅', 'id="pg-keep"')}${practice ? '' : button('退出房间', 'id="pg-leave-confirm"')}</div>`)}<p id="chat-legacy-note" hidden></p>${roomChatMarkup()}`;
  const $ = id => doc.getElementById(id), rotateMarkup = doc.getElementById("pg-rotate").innerHTML, audio = createGameAudio(), motion = createObjectMotion({ root, document: doc, window: win });
  const listen = (node, type, callback, options) => { node?.addEventListener(type, callback, options); listeners.push(() => node?.removeEventListener(type, callback, options)); };
  const settings = mountRoomSettings({ document: doc, buttonId: 'pg-settings', dialogId: 'pg-options', closeButtonId: null,
    dismissIds: ['pg-rules', 'pg-history', 'pg-restart', 'pg-invite', 'pg-hint', 'pg-activity'].filter(id => $(id)) });
  const audioControls = mountRoomAudioControls({ audio, document: doc }), removeFallback = mountImageFallback(root);
  const fit = mountGameStageFit({ host: $('pg-host'), stage: $('pg-stage'), profiles: parksStageProfiles(), minScale: .85, window: win,
    onFit(value) { motion.cancel(); $('pg-too-small').hidden = !value.unsupported; orient(); } });
  function orient() { if (!room && $('pg-content').hidden) return; const portrait = win.innerHeight > win.innerWidth; $('pg-rotate').hidden = !portrait; $('pg-content').inert = portrait || !$('pg-too-small').hidden; }
  listen(win, 'resize', orient); orient();
  function feedback(text) { if (!closed) $('pg-feedback').textContent = String(text || ''); }
  function hint(fields) { if (locked() || !fields) { feedback('当前没有需要你选择的动作。'); return false; } const action = legal().find(value => JSON.stringify(value.fields) === JSON.stringify(fields));
    if (!action || !draft.select(action, room)) return false; hikerId = action.fields.hikerId || hikerId; source = action.opportunityId; selectedTarget = action.fields.targetId || null; renderTask(room.game); renderTrail(room.game); feedback('这是一个合法建议。看清费用与结果后，由你确认或取消。'); return true; }
  function open(id) { for (const node of root.querySelectorAll('dialog[open]')) node.close(); $(id).showModal(); }
  function read(title, html) { $('pg-reading').querySelector('h2').textContent = title; $('pg-reading-content').innerHTML = html; open('pg-reading'); }
  const locked = () => closed || !room?.game || gate.pending || !gate.canAct || localBusy || room.game.window?.paused || tutorialGuide?.complete;
  const legal = () => room?.game?.legalActions || [];
  const memberName = id => room?.members?.find(value => (value.id || value.playerId) === id)?.name || room?.matchPlayers?.find(value => value.id === id)?.name || (id === room?.selfId ? '你' : room?.game?.players?.findIndex(value => value.id === id) >= 0 ? `同行者 ${room.game.players.findIndex(value => value.id === id) + 1}` : 'Teddy');
  const color = id => Math.max(0, room?.game?.controllers?.findIndex(value => value.id === id) ?? 0) % 7;
  function piece(hiker) { const index = color(hiker.controllerId); return `<span class="pg-piece pg-color-${index}" data-piece="${esc(hiker.id)}" aria-label="${esc(memberName(hiker.controllerId))}的徒步者" title="${esc(memberName(hiker.controllerId))}">${symbol(hiker.controllerKind === 'teddy' ? 'teddy' : 'hiker', 24)}<small class="pg-piece-mark" aria-hidden="true">${['●','▲','■','◆','★','✚','⬟'][index]}</small></span>`; }
  function actionButton(action, index) {
    const target = action.fields.targetId && definition(action.fields.targetId);
    const active = draft.isSelected(action);
    const guided = tutorialGuide?.suggestedAction && JSON.stringify(action.fields) === JSON.stringify(tutorialGuide.suggestedAction);
    const branchEffect = tutorialGuide && action.type === 'choose-passion' ? action.result?.text : null;
    return button(`${target ? `<span class="pg-choice-art">${renderCard(target.id, { interactive: false, thumbnail: true })}</span>` : ''}<span>${esc(action.label || '选择')}${branchEffect ? `<span class="pg-branch-effect">${esc(branchEffect)}</span>` : action.result?.resources ? `<span class="pg-choice-resource">${resourceLine(action.result.resources)}</span>` : actionOutcome(action) ? `<small>${esc(actionOutcome(action))}</small>` : ''}</span>`, `data-action-index="${index}" ${guided ? 'data-tutorial-target="true"' : ''} class="pg-choice${target ? ' pg-choice-card' : ''}${active ? ' is-selected' : ''}" aria-pressed="${Boolean(active)}" ${locked() ? 'disabled' : ''}`);
  }
  function renderTrail(game) {
    const starts = game.hikers.filter(value => value.position === 0);
    const slots = [{ position: 0, start: true }, ...game.trail, { position: 10, end: true }];
    $('pg-trail').innerHTML = slots.map(slot => {
      const site = definition(slot.siteId), selected = draft.current()?.fields.position === slot.position;
      const available = hikerId && legal().some(value => value.type === 'move-hiker' && value.fields.hikerId === hikerId && value.fields.position === slot.position);
      const hikers = slot.start ? starts : game.hikers.filter(value => value.position === slot.position);
      const guided = available && !tutorialGuide?.complete && tutorialGuide?.suggestedAction?.type === 'move-hiker' && tutorialGuide.suggestedAction.position === slot.position;
      return `<button type="button" data-position="${slot.position}" ${guided ? 'data-tutorial-target="true"' : ''} class="pg-site${available ? ' can-move' : ''}${selected ? ' is-selected' : ''}" aria-label="${esc(slot.start ? '起点' : slot.end ? '终点：公园、摄影或装备' : `第${slot.position}站，${site?.nameZh}，${site?.shortText}`)}${guided ? '，本课建议目的地' : ''}" ${locked() && available ? 'disabled' : ''}><span class="pg-site-label">${slot.start ? '出发' : slot.end ? '终点' : `${slot.position} · ${esc(site?.nameZh)}`}</span><span class="pg-site-icon">${symbol(slot.start ? 'trail' : slot.end ? 'trail-end' : slot.siteId.slice(5), 38)}</span><span class="pg-weather">${slot.weather ? `<span data-weather="${slot.position}">${resourceIcon(slot.weather)}</span>` : ''}${slot.shutterbug ? symbol('photo', 20) : ''}${slot.end ? ['parks','photo','gear'].map(id => `<span class="pg-end-reward${game.endRewards[id] ? ' is-taken' : ''}" aria-label="${{parks:'起始标记',photo:'野生动物1',gear:'阳光1'}[id]}：${game.endRewards[id] ? '已领取' : '首到可领'}" title="${{parks:'起始标记',photo:'野生动物1',gear:'阳光1'}[id]}：${game.endRewards[id] ? '已领取' : '首到可领'}">${symbol({parks:'first-player',photo:'wildlife',gear:'sun'}[id],14)}</span>`).join('') : ''}</span><span class="pg-site-pieces">${hikers.map(piece).join('')}</span></button>`;
    }).join('');
  }
  function renderRoster(game) {
    $('pg-roster').innerHTML = game.players.map(owner => `<button type="button" class="pg-person pg-color-${color(owner.id)}${game.window?.responsibleSeatId === owner.id ? ' is-turn' : ''}" data-owner="${esc(owner.id)}"><span><b>${['●','▲','■','◆','★','✚','⬟'][color(owner.id)]} ${esc(memberName(owner.id))}${owner.id === game.firstPlayerId ? ' · 起始' : ''}</b><small>${owner.hikers.every(value => value.position === 10) ? '本季完成 · ' : ''}${owner.visited.length}公园 · ${owner.photos}照片 · ${owner.gear.length}装备</small></span><span>${resourceLine(owner.resources)}</span><span class="pg-fire">${symbol(owner.campfire ? 'campfire' : 'campfire-off', 24)}</span></button>`).join('') + (game.teddy?.enabled ? `<button type="button" class="pg-person pg-teddy" id="pg-teddy"><b>${symbol('teddy', 25)} Teddy</b><small>已翻${game.teddy.discardCount}张${game.teddy.lastDraw ? ` · ${esc(name(game.teddy.lastDraw.cardId))}` : ''}</small></button>` : '');
  }
  function renderMarket(game) {
    $('pg-market-tabs').innerHTML = [['parks', '公园'], ['gear', '装备'], ['canteens', '水壶']].map(([id, label]) => button(label, `data-market="${id}" aria-pressed="${market === id}"`)).join('');
    $('pg-market-cards').innerHTML = game.markets[market].map((id, index) => id ? `<div data-market-slot="${market}-${index}" data-market-target="${esc(id)}">${renderCard(tokens.get(id) || id, { thumbnail: true })}</div>` : `<div class="pg-empty-card">${market === 'parks' ? '公园' : market === 'gear' ? '装备' : '水壶'}牌堆已空</div>`).join('');
  }
  function renderPersonal(game) {
    const owner = game.players.find(value => value.id === room.selfId); $('pg-personal').hidden = !owner;
    if (!owner) return;
    $('pg-capacity').textContent = `${owner.backpackCount} / ${owner.backpackCapacity}`;
    $('pg-resources').innerHTML = Object.keys(RESOURCE_NAMES).map(id => `<span data-resource="${id}">${resourceIcon(id)}<b>${owner.resources[id]}</b></span>`).join('');
    $('pg-hikers').innerHTML = owner.hikers.map((hiker, index) => button(`${piece({ ...hiker, controllerId: owner.id })}<span>徒步者 ${index + 1}</span>`, `data-hiker="${esc(hiker.id)}" aria-pressed="${hiker.id === hikerId}" ${locked() || !legal().some(value => value.type === 'move-hiker' && value.fields.hikerId === hiker.id) ? 'disabled' : ''}`)).join('');
    $('pg-summary').innerHTML = `<span data-photo-total>${owner.photos}张照片</span> · ${owner.visited.length}处公园`;
    $('pg-personal-select').value = personal;
    $('pg-personal-tabs').innerHTML = [['canteens', '水壶'], ['gear', `装备 ${owner.gear.length}`], ['parks', `公园 ${owner.visited.length + owner.reserved.length}`], ['passion', '热忱']].map(([id, label]) => button(label, `data-personal="${id}" aria-pressed="${personal === id}"`)).join('');
    if (personal === 'canteens') $('pg-items').innerHTML = `<div class="pg-canteen-rows">${owner.canteenRows.map((row, index) => `<div class="pg-canteen-row${row.filled ? ' is-filled' : ''}" data-canteen-row="${index}"><span>${index + 1}${symbol('water', 22)}</span>${row.tokens.map(id => button(`${symbol('canteen', 25)}<b>${esc(name(id))}</b>`, `data-card-id="${esc(tokens.get(id))}"`)).join('')}${row.tokens.length < 2 ? '<span class="pg-canteen-empty">空壶位</span>' : ''}<small>${row.filled ? '本季已填' : '可填水'}</small></div>`).join('')}</div>`;
    else if (personal === 'gear') $('pg-items').innerHTML = owner.gear.map(id => { const ops = game.opportunities.filter(value => value.sourceId === id && value.ownerSeatId === room.selfId); return `<div class="pg-owned-card"><span>${ops.some(value => value.status === 'open') ? '有待处理收益' : ops.length ? '本窗口已处理' : '等待条件触发'}</span>${renderCard(id, { thumbnail: true })}</div>`; }).join('') || '<p class="pg-empty">取得的装备会放在这里。</p>';
    else if (personal === 'parks') $('pg-items').innerHTML = [...owner.reserved.map(id => `<div class="pg-owned-card"><span>已预定</span>${renderCard(id, { thumbnail: true })}</div>`), ...owner.visited.map(id => `<div class="pg-owned-card"><span>已游览</span>${renderCard(id, { thumbnail: true })}</div>`)].join('') || '<p class="pg-empty">游览或预定的公园会放在这里。</p>';
    else { const passion = definition(owner.passionId); $('pg-items').innerHTML = passion ? `<div class="pg-passion"><b>${esc(cardName(passion))}</b><span>${esc(passion.goalText)}</span><span>进度 ${esc(typeof owner.passionProgress === 'object' ? Object.values(owner.passionProgress).join(' / ') : owner.passionProgress)}</span><p>${esc(owner.passionBranch === 'ability' ? passion.abilityText : owner.passionBranch === 'scoring' ? passion.scoringText : '达成目标后，选择能力或终局计分。')}</p>${button('完整说明', `data-card-id="${esc(passion.id)}"`)}</div>` : '<p>先从两张热忱中选择一张。</p>'; }
  }
  function renderTask(game) {
    if (tutorialGuide?.complete) { renderTutorialCompletion(game); return; }
    const actions = legal(), current = draft.current(), own = game.window?.responsibleSeatId === room.selfId;
    $('pg-stage').dataset.hasDraft = String(Boolean(current));
    let candidates = actions;
    if (game.stage === 'move') {
      if (!actions.some(value => value.fields.hikerId === hikerId)) hikerId = actions[0]?.fields.hikerId || null;
      candidates = actions.filter(value => value.fields.hikerId === hikerId && current?.fields.position === value.fields.position);
      $('pg-task-heading').innerHTML = '<span class="pg-eyebrow">踏上下一站</span><h2>选徒步者，再点步道目的地</h2><p>只能向前走。有人占位时会消耗营火。</p>';
      $('pg-task-sources').innerHTML = '';
    } else {
      const ops = game.opportunities.filter(value => value.status === 'open' && value.ownerSeatId === room.selfId);
      const ids = [...new Set(actions.map(value => value.opportunityId))];
      if (!ids.includes(source)) source = ids[0] ?? null;
      const op = ops.find(value => value.id === source), card = definition(op?.sourceId);
      $('pg-task-heading').innerHTML = `<span class="pg-eyebrow">${own ? op?.mandatory ? '这一步必须完成' : '本次可选收益' : '同行者正在行动'}</span><h2>${esc(card?.nameZh || op?.label || (own ? '完成这一站' : memberName(game.window?.responsibleSeatId || game.turnPlayerId)))}</h2><p>${esc(op?.reason || (own ? '选择对象后，在下方核对并确认。' : '公开材料与步道会同步更新。'))}</p>${card?.shortText ? `<p class="pg-effect">${esc(card.shortText)}</p>` : ''}${op?.kind === 'new-water' ? `<span data-new-water="true">${symbol('water', 30)}</span>` : ''}`;
      $('pg-task-sources').innerHTML = ids.length > 1 ? ids.map(id => { const item = ops.find(value => value.id === id); return button(esc(name(item?.sourceId) || item?.label || '结束这一步'), `data-source="${esc(id || '')}" aria-pressed="${source === id}"`); }).join('') : '';
      candidates = actions.filter(value => value.opportunityId === source);
      if (selectedTarget && candidates.some(value => value.fields.targetId === selectedTarget)) candidates = candidates.filter(value => value.fields.targetId === selectedTarget);
    }
    if (game.window?.paused) { $('pg-task-heading').innerHTML = `<h2>${game.window.pauseCause === 'timeout' ? '本步超时，旅程已暂停' : '旅程已暂停'}</h2><p>${game.window.pauseCause === 'timeout' ? `${esc(memberName(game.window.responsibleSeatId))}可在设置中恢复这一步，重新获得30分钟。` : '任一玩家可在设置中恢复，继续使用暂停前的剩余时间。'}</p>`; candidates = []; }
    if (tutorialGuide) {
      // Keep every real choice, but make this lesson's suggested object visible
      // first. Selecting a source still follows that source's own legal action.
      if (!current && tutorialGuide.suggestedAction) candidates = [...candidates].sort((a, b) => Number(JSON.stringify(b.fields) === JSON.stringify(tutorialGuide.suggestedAction)) - Number(JSON.stringify(a.fields) === JSON.stringify(tutorialGuide.suggestedAction)));
      const description = !current && candidates[0] ? onTutorialDescription(candidates[0].fields) || tutorialGuide : tutorialGuide;
      const block = gate.tutorialBlock;
      $('pg-task-heading').innerHTML = `<span class="pg-lesson-caption">第${tutorialGuide.number}/${tutorialGuide.total}课 · ${esc(tutorialGuide.title)}</span><h2>${esc(block?.heading || (current ? '看清结果，再确认' : description.heading))}</h2><p class="pg-lesson-goal">目标：${esc(tutorialGuide.goal)}</p><p class="pg-lesson-instruction">${esc(block?.message || (current ? '这只是选择预览，尚未移动或付款。确认才执行；取消可重新选择。' : description.instruction))}</p>`;
    }
    $('pg-choices').innerHTML = game.stage === 'move' && candidates.length === 1 ? '' : candidates.map(action => actionButton(action, actions.indexOf(action))).join('');
    $('pg-quote').innerHTML = current ? `<div><strong>${esc(current.label)}</strong><p>${esc(actionOutcome(current))}</p>${quoteCost(current)}</div>${current.cost?.paymentOptions?.length > 1 ? `<div class="pg-payments" aria-label="选择付款组合">${current.cost.paymentOptions.map((payment, index) => button(resourceLine(payment) || '免费', `data-payment="${index}" aria-label="支付${esc(resourceText(payment) || '零资源')}" aria-pressed="${JSON.stringify(payment) === JSON.stringify(current.fields.payment || current.fields.resources)}"`)).join('')}</div>` : ''}` : '';
    $('pg-commit').innerHTML = current ? `${button('取消选择', 'data-cancel="true"')}${button('确认 · ' + esc(current.label), `data-confirm="true" class="pg-primary" ${locked() ? 'disabled' : ''}`)}` : '';
    if (tutorialGuide && gate.tutorialBlock) $('pg-commit').innerHTML = tutorialRecoveryControls();
    if (game.result) renderResult(game);
  }
  function tutorialRecoveryControls() {
    return `${button('刷新核对原进度', 'data-tutorial-refresh="true"')}${gate.tutorialBlock?.retryStorage ? button('重试存档核对', 'data-tutorial-storage-retry="true"') : ''}`;
  }
  function renderTutorialCompletion(game) {
    const guide = tutorialGuide;
    const unavailable = localBusy || gate.pending ? ' disabled' : '';
    $('pg-stage').dataset.hasDraft = 'false';
    $('pg-task-heading').innerHTML = `<span class="pg-lesson-caption">第${guide.number}/${guide.total}课 · ${esc(guide.title)}</span><h2><span class="pg-lesson-check" aria-hidden="true">✓</span> 本课完成</h2><p class="pg-lesson-result">${esc(guide.outcome?.text || '本课目标已完成。')}</p>`;
    $('pg-task-sources').innerHTML = '';
    $('pg-choices').innerHTML = `<div class="pg-lesson-learned"><strong>记住这一条</strong><p>${esc(guide.instruction)}</p>${guide.outcome?.resources && resourceText(guide.outcome.resources) ? `<span class="pg-lesson-gain">${resourceLine(guide.outcome.resources)}</span>` : ''}${game.result ? button('查看计分明细', `data-score="${esc(room.selfId)}"`) : ''}</div>`;
    $('pg-quote').innerHTML = gate.tutorialBlock ? `<p class="pg-lesson-continuation"><strong>${esc(gate.tutorialBlock.heading)}</strong> · ${esc(gate.tutorialBlock.message)}</p>${tutorialRecoveryControls()}` : `<p class="pg-lesson-continuation">${esc(guide.continuation)}</p>`;
    $('pg-commit').innerHTML = `${button(esc(guide.nextLabel), `data-tutorial-control="next" class="pg-primary"${unavailable}`)}${button('重练本课', `data-tutorial-control="retry"${unavailable || !gate.canAct ? ' disabled' : ''}`)}${guide.nextLabel !== '完整练习 →' ? button('完整练习', `data-tutorial-control="practice"${unavailable}`) : ''}`;
  }
  function renderResult(game) {
    const result = game.result;
    $('pg-task-heading').innerHTML = `<span class="pg-eyebrow">${result.aborted ? '旅程已中止' : '这一趟旅程结束了'}</span><h2>${result.mode === 'solo' && !result.aborted ? '单人挑战完成' : result.winnerIds?.includes(room.selfId) ? '你留下了最精彩的足迹' : '谢谢同行'}</h2><p>${result.aborted ? '本局未完成三季，不计入获胜或得分。' : '公园、照片、热忱与季节奖励的得分已经结清。'}</p>`;
    $('pg-choices').innerHTML = result.scores.map(score => button(`<strong>${esc(memberName(score.playerId))} · ${score.score}分</strong><small>查看计分明细</small>`, `data-score="${esc(score.playerId)}"`)).join('');
    $('pg-commit').innerHTML = practice ? button('再走一趟', 'data-restart="true" class="pg-primary"') : room.hostId === room.selfId ? button('再来一局', 'data-common="rematch" class="pg-primary"') : '<span>等房主安排下一趟旅程</span>';
  }
  function renderCamping(game) {
    $('pg-camping').hidden = !game.camping.enabled;
    if (!game.camping.enabled) return;
    $('pg-camping').innerHTML = '<h2>本季营地</h2>' + game.camping.slots.map(slot => { const card = definition(slot.id); return button(`${symbol('tent', 23)}<span>${esc(card?.shortText)}<small>${slot.occupiedTentId ? '本季已占用' : '选择目的地后可进入'}</small></span>`, `data-camping="${esc(slot.id)}" ${slot.occupiedTentId ? 'disabled' : ''}`); }).join('');
  }
  function renderWaiting() {
    const members = room.members || [], ready = members.find(value => (value.id || value.playerId) === room.selfId)?.ready;
    const players = members.filter(value => value.role !== 'spectator'), minimum = room.participantLimits?.playing?.min || room.minPlayers || 2, maximum = room.participantLimits?.playing?.max || room.maxPlayers || 5;
    const startReason = players.length < minimum || players.length > maximum ? `当前模式需要${minimum === maximum ? minimum : `${minimum}～${maximum}`}位玩家。` : !players.every(value => value.ready) ? '所有玩家准备后，房主即可开始。' : '';
    $('pg-title').textContent = '等朋友，一起出发'; $('pg-season').textContent = `准备室 · 房间 ${room.code || room.roomCode || ''}`;
    $('pg-roster').innerHTML = members.map(value => `<div class="pg-person"><b>${esc(value.name)}</b><span>${value.role === 'spectator' ? '观战' : value.ready ? '已准备' : '未准备'}</span>${room.hostId === room.selfId && value.role !== 'spectator' && (value.id || value.playerId) !== room.selfId ? button('转交房主', `data-transfer="${esc(value.id || value.playerId)}"`) : ''}</div>`).join('');
    $('pg-trail').innerHTML = ''; $('pg-market-cards').innerHTML = ''; $('pg-market-tabs').innerHTML = ''; $('pg-personal').hidden = true; $('pg-camping').hidden = true;
    $('pg-task-heading').innerHTML = `<h2>一趟三季，两名徒步者</h2><p>${esc(modeText(room.parksConfig))} · 约40～70分钟</p><p>${esc(startReason || '都准备好了，可以出发。')}</p>`; $('pg-task-sources').innerHTML = ''; $('pg-quote').innerHTML = ''; $('pg-commit').innerHTML = '';
    const unavailable = gate.pending || !gate.canAct || localBusy ? ' disabled' : '';
    $('pg-choices').innerHTML = `${room.selfRole === 'player' ? button(ready ? '取消准备' : '准备好了', `data-common="ready" data-ready="${!ready}"${unavailable}`) : ''}${button(room.selfRole === 'spectator' ? '加入游戏' : '转为观战', `data-role="${room.selfRole === 'spectator' ? 'player' : 'spectator'}"${unavailable}`)}${room.hostId === room.selfId ? button('开始旅程', `data-common="start" class="pg-primary"${unavailable || startReason ? ' disabled' : ''} aria-describedby="pg-task-heading"`) : ''}${room.hostCanTakeOver ? button('接管房主', `data-transfer="${room.selfId}"${unavailable}`) : ''}`;
  }
  function modeText(config = {}) { return `${{ standard: '基础版 2～5人', teddy: '双人 + 巡护员 Teddy', solo: '官方单人' }[config.mode] || '基础版'} · ${config.camping ? '含露营' : '不含露营'} · ${config.volunteerCount || 0}个志愿项目`; }
  function applyView(value, options = {}) {
    if (closed) return;
    const nextScope = parksViewScope(value), same = nextScope === scope, previous = room?.game;
    const before = new Map((previous?.hikers || []).map(item => [item.id, motion.capture(`[data-piece="${item.id}"]`)]));
    const ownBefore = previous?.players.find(value => value.id === room?.selfId), oldWater = motion.capture('[data-new-water]');
    const oldDie = motion.capture('#pg-die'), oldPhoto = motion.capture('#pg-task .pg-choice.is-selected') || motion.capture('#pg-task-heading'), oldWeather = new Map((previous?.trail || []).filter(value => value.weather).map(value => [`weather.${value.position}`, motion.capture(`[data-weather="${value.position}"]`)]));
    const oldMarkets = new Map(Object.values(previous?.markets || {}).flat().filter(Boolean).map(id => [id, motion.capture(`[data-market-target="${id}"] .pk-card`)]));
    if (!same) { motion.cancel(); hikerId = null; source = null; inspectedId = null; selectedTarget = null; localBusy = false; ++activeRequest; ++generation; }
    scope = nextScope; room = { ...value, members: value.members || [...(value.players || []).map(owner => ({ ...owner, role: 'player' })), ...(value.spectators || []).map(owner => ({ ...owner, role: 'spectator' }))] }; gate = { ...gate, ...options }; draft.sync(room);
    if (tutorial && options.tutorialGuide !== undefined) tutorialGuide = options.tutorialGuide;
    $('pg-stage').dataset.tutorial = String(tutorial);
    $('pg-stage').dataset.lessonComplete = String(Boolean(tutorialGuide?.complete));
    if (tutorialGuide?.complete) draft.cancel();
    else if (tutorialGuide?.suggestedAction && !draft.current() && (!same || previous?.window?.id !== value.game?.window?.id || source === null)) {
      hikerId = tutorialGuide.suggestedAction.hikerId || hikerId; source = tutorialGuide.suggestedAction.opportunityId;
    }
    // The first authorized projection may precede the online connection event.
    // Clear only the recovery message we own, preserving any intervening error.
    if (gate.connection === 'online' && recoveryFeedback !== null) {
      if ($('pg-feedback').textContent === recoveryFeedback) feedback('');
      recoveryFeedback = null;
    }
    $('pg-content').hidden = false; $('pg-rotate').innerHTML = rotateMarkup; orient(); $('pg-room').hidden = practice || !room.code && !room.roomCode; $('pg-room').textContent = `房间 ${room.code || room.roomCode || ''}`;
    $('pg-connection').textContent = practice ? '本机保存' : gate.connection === 'online' ? '已连接' : '重新连接中';
    $('pg-recovery').hidden = practice || gate.connection === 'online' && !gate.pending;
    $('pg-mode').textContent = `第二版 · 官方规则1.1 · ${modeText(room.parksConfig || room.game?.configuration)}${Number.isFinite(room.expiresAt) ? ` · 房间保留至 ${new Date(room.expiresAt).toLocaleString('zh-CN')}` : ''}${room.pause ? ` · 暂停同意 ${room.pause.agreedIds.length}/${room.pause.requiredIds.length}` : ''}`;
    $('pg-stage').dataset.selfRole = room.selfRole; $('pg-stage').dataset.roomPhase = room.phase;
    $('pg-arrangement').hidden = practice || room.phase !== 'waiting' || room.hostId !== room.selfId;
    if (!$('pg-arrangement').hidden) { const form = $('pg-config'); for (const key of ['mode','camping','volunteerCount','passionChoice']) form.elements[key].value = String(room.parksConfig[key]); $('pg-config-save').disabled = gate.pending || !gate.canAct || localBusy; }
    $('pg-pause').disabled = !room.game || !['playing','paused'].includes(room.phase) || room.selfRole !== 'player' || gate.pending || !gate.canAct || localBusy || tutorialGuide?.complete || room.game.window.pauseCause === 'timeout' && room.game.window.responsibleSeatId !== room.selfId; $('pg-pause').textContent = room.game?.window?.paused ? '恢复旅程' : room.pause?.agreedIds?.includes(room.selfId) ? '撤回同意' : room.pause ? '同意暂停' : '请求暂停';
    if (!room.game) { displayClock.clear(); $('pg-clock').textContent = ''; $('pg-die').hidden = true; renderWaiting(); return; }
    const game = room.game; $('pg-stage').dataset.gameStage = game.stage; $('pg-stage').dataset.ownTurn = String(game.window?.responsibleSeatId === room.selfId);
    if (game.stage === 'move' && !legal().some(value => value.fields.hikerId === hikerId)) hikerId = legal()[0]?.fields.hikerId || null;
    $('pg-title').textContent = game.result ? '旅程的最后一页' : game.window?.paused ? '暂停 · 稍作休息' : game.window?.responsibleSeatId === room.selfId ? '轮到你，留下足迹' : `${memberName(game.window?.responsibleSeatId || game.turnPlayerId)}的旅程`;
    $('pg-season').textContent = `${seasons[game.season.index]}季 ${game.season.index + 1}/3 · 季节与步道`;
    $('pg-die').hidden = !game.lastDie; if (game.lastDie) $('pg-die').innerHTML = `${symbol('die', 20)}${symbol(game.lastDie.face, 20)}`;
    displayClock.update(game, win.performance.now()); renderClock();
    const ownNext = game.players.find(value => value.id === room.selfId);
    if (ownBefore && ownNext && previous?.revision !== game.revision) { if (ownNext.visited.length > ownBefore.visited.length || ownNext.reserved.length > ownBefore.reserved.length) personal = 'parks'; else if (ownNext.gear.length > ownBefore.gear.length) personal = 'gear'; }
    renderRoster(game); renderTrail(game); renderMarket(game); renderPersonal(game); renderCamping(game); renderTask(game); motion.sync();
    if (previous?.matchId === game.matchId && previous.revision !== game.revision) for (const hiker of game.hikers) {
      const old = previous.hikers.find(value => value.id === hiker.id);
      if (old?.position !== hiker.position && before.get(hiker.id)) void motion.move({ from: before.get(hiker.id), to: `[data-piece="${hiker.id}"]`, duration: 360 });
    }
    if (previous?.matchId === game.matchId && previous.revision !== game.revision && ownBefore && ownNext) {
      for (const id of [...ownNext.gear, ...ownNext.visited, ...ownNext.reserved]) if (![...ownBefore.gear, ...ownBefore.visited, ...ownBefore.reserved].includes(id) && oldMarkets.get(id)) void motion.move({ from: oldMarkets.get(id), to: `#pg-items [data-card-id="${id}"]`, duration: 340 });
      if (oldWater) { const row = ownNext.canteenRows.findIndex((value,index) => value.filled && !ownBefore.canteenRows[index].filled); if (row >= 0) void motion.move({ from: oldWater, to: `[data-canteen-row="${row}"]`, duration: 290 }); }
      const oldEvents = new Set((previous.lastPublicEvents || []).map(value => value.id)), events = (game.lastPublicEvents || []).filter(value => !oldEvents.has(value.id));
      if (events.some(value => value.type === 'die-rolled')) void motion.move({ from: oldDie || motion.capture('#pg-die'), to: '#pg-die', duration: 220, flip: true });
      const weatherGain = events.find(value => value.type === 'resources-gained' && value.actorId === room.selfId && oldWeather.has(value.sourceId));
      if (weatherGain) for (const id of Object.keys(RESOURCE_NAMES)) if (ownNext.resources[id] > ownBefore.resources[id] && weatherGain.resources[id] > 0) void motion.move({ from: oldWeather.get(weatherGain.sourceId), to: `#pg-resources [data-resource="${id}"] .pk-resource-icon`, duration: 300 });
      if (ownNext.photos > ownBefore.photos && events.some(value => value.type === 'photos-taken' && value.actorId === room.selfId)) void motion.move({ from: oldPhoto, to: '[data-photo-total]', duration: 270, flip: true });
    }
  }
  function renderClock() { const ms = displayClock.read(win.performance.now()), seconds = ms === null ? null : Math.ceil(ms / 1000); $('pg-clock').textContent = room?.game?.window?.responsibleSeatId && seconds !== null ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''; }
  const clockTimer = win.setInterval(() => { if (!closed && !doc.hidden) renderClock(); }, 500);
  async function commit() {
    const selected = draft.current(); if (!selected || locked()) return;
    const stamp = generation, request = ++activeRequest; localBusy = true; renderTask(room.game); $('pg-pause').disabled = true;
    try { const result = await onAction(selected.type, selected.fields); if (stamp !== generation || closed) return;
      if (result === false || result?.ok === false) feedback(result?.error || '操作未确认，选择会保留。'); else { draft.cancel(); feedback(''); }
    } catch (error) { if (stamp === generation && !closed) { audio.play('invalid'); feedback(error.message || '没有收到确认，请核对当前桌面。'); } }
    finally { if (activeRequest === request) { localBusy = false; if (!closed && room) applyView(room, gate); } }
  }
  async function common(type, fields = {}) { if (localBusy || gate.pending) return; localBusy = true; const stamp = generation, request = ++activeRequest;
    try { await onAction(type, fields); } catch (error) { if (stamp === generation && !closed) feedback(error.message); }
    finally { if (activeRequest === request) { localBusy = false; if (!closed && room) applyView(room, gate); } }
  }
  listen(root, 'click', async event => {
    const node = event.target.closest('button'); if (!node || node.disabled || closed) return;
    if (node.dataset.tutorialRefresh) { onRefresh(); return; }
    if (node.dataset.tutorialStorageRetry) { onRetry(); return; }
    if (node.dataset.tutorialControl && tutorialGuide?.complete) { onTutorialControl(node.dataset.tutorialControl); return; }
    if (node.dataset.close) { $(node.dataset.close).close(); return; }
    if (node.dataset.hiker) { hikerId = node.dataset.hiker; draft.cancel(); audio.play('select'); renderTrail(room.game); renderTask(room.game); renderPersonal(room.game); return; }
    if (node.dataset.position !== undefined) {
      const matches = legal().filter(value => value.type === 'move-hiker' && value.fields.hikerId === hikerId && value.fields.position === Number(node.dataset.position));
      if (matches.length && !locked()) { draft.select(matches[0], room); audio.play('select'); renderTrail(room.game); renderTask(room.game); }
      else if (!matches.length) { const tile = room.game.trail.find(value => value.position === Number(node.dataset.position)); if (tile) { const site = definition(tile.siteId); read(site.nameZh, `<p>${esc(site.detailText)}</p>`); } }
      return;
    }
    if (node.dataset.camping) { const action = legal().find(value => value.fields.campingSlotId === node.dataset.camping && value.fields.hikerId === hikerId && value.fields.position === draft.current()?.fields.position); if (action && !locked()) { draft.select(action, room); renderTask(room.game); renderTrail(room.game); } else feedback('先在步道选目的地，再选择这个营位。'); return; }
    if (node.dataset.actionIndex !== undefined && !locked()) { draft.select(legal()[Number(node.dataset.actionIndex)], room); audio.play('select'); renderTask(room.game); return; }
    if (node.dataset.payment !== undefined && !locked()) { const payment = draft.current()?.cost?.paymentOptions[Number(node.dataset.payment)]; if (payment && draft.choosePayment(payment)) { audio.play('select'); renderTask(room.game); } return; }
    if (node.dataset.confirm) { await commit(); return; }
    if (node.dataset.cancel) { draft.cancel(); selectedTarget = null; audio.play('undo'); renderTask(room.game); renderTrail(room.game); return; }
    if (node.dataset.market) { market = node.dataset.market; renderMarket(room.game); return; }
    if (node.dataset.personal) { personal = node.dataset.personal; renderPersonal(room.game); return; }
    if (node.dataset.source !== undefined) { source = node.dataset.source || null; selectedTarget = null; draft.cancel(); renderTask(room.game); return; }
    if (node.dataset.cardId) { const target = node.closest('[data-market-target]')?.dataset.marketTarget, actions = legal().filter(action => action.fields.targetId === target && action.opportunityId === source);
      if (target && actions.length && !locked()) { selectedTarget = target; draft.cancel(); if (actions.length === 1) draft.select(actions[0], room); audio.play('select'); renderTask(room.game); return; }
      inspectedId = node.dataset.cardId; read(name(inspectedId), renderDetail(inspectedId, { thumbnail: true })); return; }
    if (node.dataset.owner) { const owner = room.game.players.find(value => value.id === node.dataset.owner); read(memberName(owner.id), `<p>${resourceLine(owner.resources)} · ${owner.photos}张照片 · 营火${owner.campfire ? '点燃' : '熄灭'}${owner.id === room.game.firstPlayerId ? ' · 起始玩家' : ''}${owner.id === room.game.shutterbugOwnerId ? ' · 持有摄影徽章' : ''}</p><p>${owner.hikers.map((hiker,index) => `徒步者${index+1}：${hiker.position === 0 ? '起点' : hiker.position === 10 ? '终点' : `第${hiker.position}站`}`).join(' · ')}</p>${owner.passionId ? renderDetail(owner.passionId) : ''}<div class="pg-read-cards">${[...owner.gear, ...owner.reserved, ...owner.visited].map(id => renderCard(id, { thumbnail: true })).join('') || '<p>还没有取得公开卡牌。</p>'}</div>`); return; }
    if (node.id === 'pg-teddy') read('巡护员 Teddy', `<p>每次先翻出正面执行移动，再用牌堆新顶牌背面决定移动哪名徒步者。Teddy是系统控制者，不消耗玩家席位。</p>${room.game.teddy.lastDraw ? renderDetail(room.game.teddy.lastDraw.cardId) : '<p>尚未翻牌。</p>'}<p>尚余${room.game.teddy.drawCount}张 · 已翻${room.game.teddy.discardCount}张</p>`);
    if (node.id === 'pg-die' && room.game.lastDie) read('刚掷出的步道骰', renderDetail(`die.${room.game.lastDie.face}`));
    if (node.id === 'pg-season' && room?.game) read('公共步道 · 本季目标', `<div class="pg-trail-read">${room.game.trail.map(tile => `<p><b>第${tile.position}站 · ${esc(name(tile.siteId))}</b> ${esc(definition(tile.siteId)?.shortText)} · ${tile.weather ? `天气${RESOURCE_NAMES[tile.weather]}` : '天气已取'}${tile.shutterbug ? ' · 摄影地点' : ''}${room.game.hikers.some(value => value.position === tile.position) ? ` · ${esc(room.game.hikers.filter(value => value.position === tile.position).map(value => memberName(value.controllerId)).join('、'))}在此` : ' · 无人占位'}</p>`).join('')}<p>终点首到奖励：${['parks','photo','gear'].map(id => `${{parks:'起始标记',photo:'野生动物1',gear:'阳光1'}[id]}${room.game.endRewards[id] ? '已取' : '可领'}`).join(' · ')}</p></div>${renderDetail(room.game.season.id)}`);
    if (node.id === 'pg-activity' && room) { const activity = room.activity?.map(value => `<p>${esc(value.text || '')}</p>`).filter(Boolean) || []; const labels = { 'hiker-moved':'移动徒步者', 'resources-gained':'取得资源', 'park-visited':'游览公园', 'park-reserved':'预订公园', 'gear-acquired':'取得装备', 'canteen-filled':'填满水壶', 'photos-taken':'拍照', 'die-rolled':'掷步道骰', 'teddy-card-revealed':'Teddy翻牌', 'passion-completed':'完成热忱' }; read('本局动态', activity.length ? activity.join('') : (room.game?.lastPublicEvents || []).filter(value => labels[value.type]).map(value => `<p>${esc(memberName(value.actorId))} · ${labels[value.type]}${value.targetId ? ` · ${esc(name(value.targetId))}` : ''}${value.resources ? ` · ${resourceLine(value.resources)}` : ''}${value.position ? ` · 第${value.position}站` : ''}</p>`).join('') || '<p>旅程还没有开始。</p>'); return; }
    if (node.dataset.score) { const owner = room.game.players.find(value => value.id === node.dataset.score), score = room.game.result.scores.find(value => value.playerId === owner?.id); if (!score) return; const labels = { parks:'游览公园',photos:'照片',photoRanking:'摄影排名',passion:'热忱',fallBonus:'秋季奖励',firstPlayer:'起始玩家' }; read(`${memberName(owner.id)}的足迹`, `<p>共 ${score.score} 分${room.game.result.mode === 'solo' ? ` · ${esc(score.soloRank || '未达评级')} · ${score.difficulty}个志愿项目</p><p>30分 Dayhiker · 35分 Trekker · 40分 Explorer · 45分 Adventurer · 50分 Trailblazer` : ''}</p><dl>${Object.entries(score.breakdown).map(([key,value])=>`<dt>${esc(labels[key] || key)}</dt><dd>${value}分</dd>`).join('')}</dl><div class="pg-read-cards">${owner.visited.map(id => renderCard(id, { thumbnail: true })).join('')}</div>`); return; }
    if (node.dataset.common) { await common(node.dataset.common, node.dataset.common === 'ready' ? { ready: node.dataset.ready === 'true' } : {}); return; }
    if (node.dataset.role) { await common('set-role', { role: node.dataset.role }); return; }
    if (node.dataset.transfer) { await common('transferHost', { playerId: node.dataset.transfer }); return; }
    if (node.dataset.restart || node.id === 'pg-restart') { onRestart(); return; }
    if (node.id === 'pg-hint') { onHint(); return; }
    if (node.id === 'pg-pause' && room?.game) { await common(room.game.window.paused ? 'resume' : 'pause', room.game.window.paused ? {} : { agree: !room.pause?.agreedIds?.includes(room.selfId) }); return; }
    if (node.id === 'pg-rules') read('随行指南', `<p>每回合移动一名徒步者，沿步道向前到任意可执行行动的地点。先收天气，再执行地点的基础行动与触发的收益。</p><p>资源用于游览公园、购买装备和拍照。水可以进入背包或填满一行水壶，触发该行效果；每行每季只能填一次。野生动物可代替普通资源，印刷的野生动物费用仍必须支付野生动物。</p><p>有人占据的地点要使用点燃的营火。全体徒步者（含Teddy）都到终点后，本季完成；比较季节目标、重排步道并复原营火和水壶。三季后，公园、照片、热忱与季节奖励合计得分最高者获胜。志愿项目改变规则与单人难度，不直接加分。</p><p>${esc(modeText(room.parksConfig || room.game?.configuration))}</p><div class="pg-read-cards">${(room.game?.projects || []).map(id => renderCard(id, { thumbnail: true })).join('')}</div><p><a href="./parks-tutorial.html">实战教学</a> · <a href="./parks-catalog.html">完整牌库与可选玩法</a></p>`);
    if (node.id === 'pg-history') { const stamp = generation; feedback('正在读取记录…'); try { const packet = await onHistory({ limit: 30 }); if (stamp === generation && !closed) { read('对局记录', `<p>${(packet?.items || []).filter(value => value.game === 'parks').map(value => `${value.endedAt ? esc(new Date(value.endedAt).toLocaleString('zh-CN')) : '本机当前局'} · ${value.self?.score ?? ''}分 · ${{win:'获胜',loss:'完成',draw:'并列',completed:'完成',unscored:'中止'}[value.self?.outcome] || '完成'}${value.parksSummary?.mode === 'solo' ? ' · 官方单人' : ''}`).join('<br>') || '暂无国家公园记录。'}</p>`); feedback(''); } } catch (error) { feedback(error.message); } }
    if (node.id === 'pg-invite' || node.id === 'pg-room') { try { await win.navigator.clipboard.writeText(win.location.href); feedback('邀请链接已复制。'); } catch { feedback(`房间号 ${room.code || room.roomCode}，可在大厅输入加入。`); } }
    if (node.id === 'pg-exit') { $('pg-leave-note').textContent = practice ? '当前旅程会保存在本机，下次从这一站继续。' : '保留席位返回大厅，可再次进入继续。' + (room?.selfRole === 'spectator' ? '退出只会离开观战。' : ['playing','paused'].includes(room?.phase) ? '确认退出会立即中止所有人的本局，不计输赢或得分。' : '确认退出会离开房间。') + ''; open('pg-leave'); }
    if (node.id === 'pg-keep' || node.id === 'pg-leave-confirm') { node.disabled = true; try { await onLeave({ keepSeat: node.id === 'pg-keep', destination: 'lobby' }); } catch (error) { feedback(error.message || '离开未确认，请重试。'); } finally { if (!closed) node.disabled = false; } }
    if (node.id === 'pg-refresh') onRefresh(); if (node.id === 'pg-retry') onRetry(); if (node.id === 'pg-recover') onRecover();
  });
  listen($('pg-personal-select'), 'change', () => { personal = $('pg-personal-select').value; if (room?.game) renderPersonal(room.game); });
  listen($('pg-config'), 'submit', event => { event.preventDefault(); if (!room || room.phase !== 'waiting' || room.hostId !== room.selfId || gate.pending || !gate.canAct) return;
    const form = $('pg-config'); void common('configure', { parksConfig: { mode: form.elements.mode.value, camping: form.elements.camping.value === 'true', volunteerCount: Number(form.elements.volunteerCount.value), passionChoice: form.elements.passionChoice.value } }); });
  listen(doc, 'visibilitychange', () => { if (doc.hidden) motion.cancel(); });
  function conceal({ message, loginHref, reauthHref } = {}) { ++generation; ++activeRequest; localBusy = false; room = null; scope = null; draft.clear(); displayClock.clear(); motion.cancel(); for (const node of root.querySelectorAll('dialog[open]')) node.close(); $('pg-content').hidden = true; recoveryFeedback = String(message || ''); feedback(recoveryFeedback); $('pg-rotate').hidden = false; $('pg-rotate').innerHTML = `<div><h2>${esc(message || '正在恢复旅程…')}</h2>${loginHref ? `<a href="${esc(loginHref)}">重新登录</a>` : ''}${reauthHref ? `<a href="${esc(reauthHref)}">重新核验账号</a>` : ''}${button('重新连接', 'id="pg-refresh"')}</div>`; }
  return { audio, applyView, feedback, hint, leaveFailure: feedback, conceal, settings, hasOpenPanel: () => Boolean(root.querySelector('dialog[open]')), isObscured: () => win.innerHeight > win.innerWidth || !$('pg-too-small').hidden,
    destroy() { if (closed) return; closed = true; ++generation; win.clearInterval(clockTimer); displayClock.clear(); draft.clear(); motion.destroy(); fit.destroy(); settings.destroy(); audioControls.destroy(); audio.close(); removeFallback(); listeners.forEach(remove => remove()); for (const node of root.querySelectorAll('dialog[open]')) node.close(); } };
}
