import { accountState, accountGeneration, onAccountChange, loadAccount, watchAccountLifecycle, logoutAccount, loginHref, reauthenticationHref } from './account-client.mjs';
import { RoomClient, api, loadMembership, forgetMembership } from './room-client.mjs';
import { mountRoomChat } from './room-chat.mjs';
import { createGameAudio } from './game-audio.mjs';
import { gameErrorMessage, roomExitExplanation, orderedRoomPlayers, turnClockDisplay } from './game-presentation.mjs';
import { roomHref } from './game-routing.mjs';
import { BOARD_CELLS, ROAD_EDGES, RAIL_EDGES } from './army-board.mjs';
import { armySideLabel, armyAssignmentText, armyPoint, armyCellLabel, armyTargets, armyIntent, armyTransition, armyResultText, armyLastActionText, armyUsesFlagTransport, armyFlagMarks, armyPickups, armyRulePages, armyRuleModeLabel } from './army-presentation.mjs';

const $ = id => document.getElementById(id);
const roomCode = new URLSearchParams(location.search).get('code') || '';
const loginFailure = new URLSearchParams(location.search).get('login');
let loginConflictNotified = false;
const audio = createGameAudio();
let view = null, client = null, chat = null, connection = 'offline', selected = null, busy = false, leaving = false;
let bootSequence = 0, baseline = true, boardSignature = '', pendingLeave = null, activityPage = 0, rulePage = 0;
let pickupDialog=null;
let clockReceivedAt = 0, clockTimer = null, clockWasExpired = false;
function clockDisplay() { return turnClockDisplay(view, performance.now() - clockReceivedAt); }
function resetTurnClock() {
  if (clockTimer !== null) clearInterval(clockTimer); clockTimer = null; clockWasExpired = false;
  if ($('turn-clock')) $('turn-clock').hidden = true;
}
function renderTurnClock() {
  const node = $('turn-clock'), state = clockDisplay();
  if (!node) return;
  node.hidden = !state.visible;
  if (!state.visible) { resetTurnClock(); return; }
  $('turn-clock-time').textContent = state.time; $('turn-clock-action').textContent = state.action;
  node.classList.toggle('expired', state.expired); node.classList.toggle('paused', state.paused);
  node.title = state.label; node.setAttribute('aria-label', state.label);
  if (state.expired && !clockWasExpired) {
    selected = null; closePickupChoice(); renderBoard(); feedback('本回合时间已到，正在换人。');
  }
  clockWasExpired = state.expired;
}
function receiveTurnClock() {
  clockReceivedAt = performance.now(); renderTurnClock();
  if (view?.turnClock && clockTimer === null) clockTimer = setInterval(renderTurnClock, 250);
}

const cellMap = new Map(BOARD_CELLS.map(cell => [cell.cellId, cell]));
const live = () => Boolean(view && client && !busy && !leaving && connection === 'online' && !document.hidden && accountState().verification === 'verified');
const spectator = () => view?.selfRole === 'spectator';
const playing = () => live() && !spectator() && view.phase === 'playing' && view.game?.status === 'playing' && !clockDisplay().expired;
const canAct = () => playing() && view.game.turnPlayerId === view.selfId;
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; setTimeout(() => { $('toast').hidden = true; }, 4500); }
function feedback(message) { $('army-feedback').textContent = message; }
const gameCanvasContainers=[...new Set([document.querySelector('.shell'),document.querySelector('main'),$('room-play'),$('room-players'),$('army-board-stage')].filter(Boolean))];
function pinGameCanvas() {
  for(const node of gameCanvasContainers) {
    if(node.scrollTop)node.scrollTop=0;
    if(node.scrollLeft)node.scrollLeft=0;
  }
}
for(const node of gameCanvasContainers)node.addEventListener('scroll',pinGameCanvas,{passive:true});
document.addEventListener('focusin',pinGameCanvas);
function syncViewport() {
  pinGameCanvas();
  const viewport = window.visualViewport;
  document.body.style.setProperty('--army-viewport-height', `${viewport?.height || window.innerHeight}px`);
  document.body.style.setProperty('--army-viewport-width', `${viewport?.width || window.innerWidth}px`);
  fitBoard();
}
function fitBoard() {
  const bounds = $('army-board-stage').getBoundingClientRect();
  const unit = Math.max(0, Math.min(bounds.width / 12, bounds.height / 5));
  $('army-board').style.width = `${unit * 12}px`; $('army-board').style.height = `${unit * 5}px`;
  $('army-board').style.setProperty('--army-unit', `${unit}px`);
}
function drawRoads() {
  function lines(edges, className) {
    return edges.map(edge => {
      const from = cellMap.get(edge[0]), to = cellMap.get(edge[1]); if (!from || !to) return '';
      const a = armyPoint(from), b = armyPoint(to);
      return `<line class="${className}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    }).join('');
  }
  $('army-lines').innerHTML = lines(ROAD_EDGES, 'army-road') + lines(RAIL_EDGES, 'army-rail') + lines(RAIL_EDGES, 'army-rail-line') + BOARD_CELLS.map(cell => {
    const point = armyPoint(cell), className = `army-terrain ${cell.terrain}`;
    return cell.terrain === 'camp' ? `<ellipse class="${className}" cx="${point.x}" cy="${point.y}" rx="31" ry="32"/>`
      : `<rect class="${className}" x="${point.x-29}" y="${point.y-26}" width="58" height="52" rx="${cell.terrain==='headquarters'?3:8}"/>`;
  }).join('');
}
function renderBoard() {
  if (!view?.game) return;
  const game = view.game, active = canAct(), targets = active ? armyTargets(game, selected) : new Set();
  const signature = JSON.stringify([game.ruleVersion,game.board, selected, active, game.legalFlips, game.legalMoves,game.legalPickups,game.flagTokens, game.lastAction]);
  if (signature === boardSignature) return;
  boardSignature = signature;
  const cells = game.board.map(item => {
    const cell = cellMap.get(item.cellId); if (!cell) return null;
    const point = armyPoint(cell), piece = item.piece, flags=armyFlagMarks(game,item.cellId),pickups=active?armyPickups(game,item.cellId):[];
    const button = element('button', `army-cell${piece?' has-piece':''}${flags.baseSide?' army-base '+flags.baseSide+'-base':''}${pickups.length?' pickup-ready':''}${selected===item.cellId?' selected':''}${targets.has(item.cellId)?' target':''}${[game.lastAction?.cellId,game.lastAction?.to].includes(item.cellId)?' last-action':''}`);
    button.type = 'button'; button.setAttribute('data-cell-id', item.cellId);
    button.style.left = `${point.x / 12}%`; button.style.top = `${point.y / 5}%`;
    button.disabled = !active;
    button.setAttribute('aria-pressed', String(selected === item.cellId));
    button.setAttribute('aria-label', armyCellLabel(cell, piece, { selected:selected===item.cellId,target:targets.has(item.cellId),canFlip:active&&game.legalFlips.includes(item.cellId),game }));
    if (piece) {
      const token = element('span', `army-piece ${piece.hidden?'hidden-piece':piece.side}`);
      token.setAttribute('aria-hidden', 'true');
      if (!piece.hidden) { token.append(element('span', '', piece.label || '棋子'), element('small', '', armySideLabel(piece.side))); }
      button.append(token);
    } else if (cell.terrain === 'camp') button.append(element('span', 'army-empty-camp'));
    else if (cell.terrain === 'headquarters' && !flags.baseSide) button.append(element('span', 'army-empty-hq', '大本营'));
    if(flags.baseSide) button.append(element('span',`army-base-label ${flags.baseSide}`,flags.baseSide==='red'?'红基地':'黑基地'));
    if(flags.carried.length) button.append(element('span',`army-flag-mark carried ${flags.carried[0]}`,`携${flags.carried.map(side=>side==='red'?'红旗':'黑旗').join('/')}`));
    if(flags.ground.length) button.append(element('span',`army-flag-mark ground ${flags.ground[0]}${flags.ground.length>1?' both':''}`,flags.ground.length>1?`双旗${pickups.length?'·选':''}`:`${flags.ground[0]==='red'?'红旗':'黑旗'}${pickups.length?'·拾':''}`));
    button.addEventListener('click', () => clickCell(item.cellId));
    return button;
  }).filter(Boolean);
  $('army-cells').replaceChildren(...cells);
  $('army-cancel').disabled = !selected;
  requestAnimationFrame(fitBoard);
}
function closePickupChoice() { const dialog=pickupDialog;pickupDialog=null;if(dialog){dialog.close();dialog.remove();} }
function showPickupChoice(cellId,choices) {
  closePickupChoice();const dialog=element('dialog','army-dialog army-pickup-dialog');pickupDialog=dialog;
  dialog.setAttribute('aria-label','选择要拾取的军旗');dialog.append(element('h2','','拾哪一面旗？'),element('p','','脚下有两面军旗，选择本回合要携带的一面。'));
  const buttons=element('div','confirm-actions');
  for(const choice of choices) {
    const button=element('button','secondary-button',`拾起${armySideLabel(choice.flagSide)}军旗`);button.type='button';button.setAttribute('data-pickup-side',choice.flagSide);
    button.addEventListener('click',()=>{closePickupChoice();clickCell(cellId,{flagSide:choice.flagSide});});buttons.append(button);
  }
  const cancel=element('button','quiet-button','暂时不拾');cancel.type='button';cancel.addEventListener('click',closePickupChoice);
  dialog.append(buttons,cancel);dialog.addEventListener('close',()=>{if(pickupDialog===dialog)pickupDialog=null;dialog.remove();});document.body.append(dialog);dialog.showModal();
}
function clickCell(cellId,{flagSide}={}) {
  const intent = armyIntent(view, selected, cellId, { active:canAct(),flagSide });
  if(intent.type==='choose-pickup'){showPickupChoice(cellId,intent.choices);return;}
  if (intent.type === 'flip') { action('flip', { cellId }); return; }
  if (intent.type === 'move') { action('move', { from:intent.from, to:intent.to }); return; }
  if (intent.type === 'pickup') { action('pickup',{cellId:intent.cellId,flagSide:intent.flagSide});return; }
  if (intent.type === 'select' || intent.type === 'cancel') {
    selected = intent.selected;
    audio.play(intent.type==='select'?'select':'undo',{gesture:true});
    if (intent.type === 'cancel') feedback(turnText());
    else {
      const piece = view.game.board.find(cell => cell.cellId === cellId)?.piece;
      feedback(intent.targets.length ? `已选${armySideLabel(piece?.side)} ${piece?.label || '棋子'}，点亮起的目标${armyUsesFlagTransport(view.game)?'走棋、吃子或暗碰':'走棋或吃子'}。` : `这枚${piece?.label || '棋子'}当前没有合法目标，可以另选棋子或翻子。`);
    }
    renderBoard(); return;
  }
  if (intent.message) feedback(intent.message);
}
function turnText() {
  if (!view?.game) return '等待开局。';
  if (spectator()) return view.phase==='paused'?'观战中；双方暂停了棋局，等待玩家继续。':'观战中；可以看公开棋盘和聊天，暗子保持隐藏。';
  if (view.phase === 'paused') return '双方已同意暂停，牌局已保存。任一在席玩家可以继续。';
  if (view.phase === 'aborted' || view.phase === 'finished') return '本局已经结束，可以留在房间再来一局。';
  if (!live()) return '正在恢复连接，确认后继续同一棋局。';
  if (view.game.turnPlayerId !== view.selfId) return '等朋友行动；可以聊天，也可以在房间菜单提和。';
  if (view.game.players.some(player => !player.side)) { const last=view.game.players.find(player=>player.id===view.selfId)?.lastFlipSide; return last && view.game.assignment==='two-flips' ? `你上次翻到${armySideLabel(last)}，再翻同色即可分色。` : '轮到你翻子，按本房间分色方式确定阵营。'; }
  return armyUsesFlagTransport(view.game)?'轮到你：翻子或选明子走棋、暗碰；可点脚下标记拾旗。敌旗须运回己方基地。':'轮到你：翻一枚暗子，或点自己的明子再点亮起的目标。';
}
function renderPlayers() {
  const gamePlayers = view.game?.players || [];
  $('room-players').replaceChildren(...orderedRoomPlayers(view).map(player => {
    const detail = gamePlayers.find(item => item.id === player.id), active = view.phase === 'playing' && view.game?.turnPlayerId === player.id;
    const seat = element('div', `player-seat${player.isNext?' next':''}${active?' current':''}${player.id===view.selfId?' self':''}`);
    const identity=element('div','army-player-identity'), name=element('strong','',player.name);
    name.setAttribute('title',player.name);identity.append(name);
    const roles=[player.id===view.selfId?'我':'',player.id===view.hostId?'房主':''].filter(Boolean);
    if(roles.length)identity.append(element('span','army-player-role',roles.join(' · ')));
    seat.append(element('span', `army-side ${detail?.side || 'unassigned'}`, armySideLabel(detail?.side)), identity);
    seat.append(element('span', 'player-detail', view.phase==='waiting' ? player.ready?'已准备':'等待准备' : `${active?'正在行动':player.isNext?'下一位':'等待'}${!detail?.side&&detail?.lastFlipSide?' · 上次'+armySideLabel(detail.lastFlipSide):''}${player.connected?'':' · 暂时离线'}`));
    return seat;
  }));
}
function renderRoom() {
  if (!view) return;
  document.body.classList.toggle('in-game', Boolean(view.game));
  $('room-code').textContent = roomCode; renderPlayers(); renderTurnClock();
  const host = !spectator() && view.selfId === view.hostId, me = view.players.find(player => player.id === view.selfId);
  $('room-waiting').hidden = view.phase !== 'waiting'; $('room-play').hidden = !view.game;
  $('ready-button').textContent = me?.ready ? '取消准备' : '准备好了'; $('ready-button').hidden=spectator(); $('ready-button').disabled = !live() || spectator();
  $('start-room').hidden = !host; $('start-room').disabled = !live() || view.players.length !== 2 || !view.players.every(player => player.ready);
  $('waiting-hint').textContent = spectator()?`正在观战 · ${view.players.length}/2 人已入座。等待开局时可在房间菜单入座。`:`${view.players.length}/2 人已入座。${host?'双方准备后由你开局。':'双方准备好后等房主开局。'}`;
  const assignment = view.game?.assignment || view.options?.assignment || view.assignment || 'two-flips';
  $('room-rule-note').textContent = `双人翻棋 · ${view.game?armyRuleModeLabel(view.game):'新局运旗规则 v3'} · ${armyAssignmentText(assignment)} ${view.turnClock || view.phase==='waiting'?'每回合30分钟，超时自动跳过。':'旧局未启用计时；重新开局后每回合30分钟。'}`;
  $('army-assignment-rule').textContent = armyAssignmentText(assignment);
  if (!view.game) { $('army-cells').replaceChildren(); boardSignature=''; selected=null; }
  if (view.game) {
    $('army-round').textContent = `第 ${view.game.round} 回合`;
    $('army-turn').textContent = spectator()?'观战中':view.phase==='paused'?'已暂停保存':view.phase==='finished'||view.phase==='aborted'?'本局结束':view.game.players.some(player=>!player.side)?'翻子分色':view.game.turnPlayerId===view.selfId?'轮到你':'朋友的回合';
    renderBoard();
  }
  const finished = ['finished','aborted'].includes(view.phase); $('room-result').hidden = !finished;
  if (finished) {
    const result = view.game?.result || {}, aborted = view.phase==='aborted' || result.aborted;
    const winnerId = result.winnerId || view.game?.winnerId || result.winnerIds?.[0];
    const winner = view.game?.players?.find(player => player.id === winnerId) || view.players.find(player => player.id === winnerId);
    $('result-title').textContent = aborted?'本局已中止。':result.tie?'本局和棋。':winner?`${winner.name} 赢了这一局。`:'本局已经结束。';
    $('result-reason').textContent = aborted?'有朋友退出房间，本局不计输赢。':armyResultText(result, view.players);
    $('result-scores').textContent = aborted?'':winnerId?'本局记录胜负，不设置累计娱乐积分。':'双方记为平局。';
    $('rematch').hidden = !host; $('rematch').disabled = !live();
  }
  renderControls(); renderDrawOffer();
  if ($('rules-dialog').open) renderRules();
  if ($('room-activity-dialog').open) renderActivity();
  if ($('army-captured-dialog').open) renderCaptured();
}
function renderControls() {
  if (!view) return;
  const host = !spectator() && view.selfId === view.hostId, paused = view.phase === 'paused', agreed = view.pause?.agreedIds?.includes(view.selfId);
  $('room-options').disabled = leaving; $('leave-room').disabled = !live();
  $('pause-room').hidden = spectator() || view.phase !== 'playing'; $('pause-room').textContent = agreed?'撤回暂停同意':view.pause?'同意暂停':'提议暂停'; $('pause-room').disabled = !live();
  for (const id of ['resume-room','resume-room-menu']) { $(id).hidden = spectator() || !paused; $(id).disabled = !live() || spectator(); }
  $('take-host').hidden = host || !view.hostCanTakeOver; $('take-host').disabled = !live();
  const others = view.players.filter(player => player.id !== view.selfId), previous = $('next-host').value;
  $('host-transfer-controls').hidden = !host || !others.length;
  $('next-host').replaceChildren(...others.map(player => {const option=element('option','',player.name); option.value=player.id;return option;}));
  if (others.some(player => player.id === previous)) $('next-host').value = previous;
  else $('next-host').value = others[0]?.id || '';
  $('next-host').disabled = !live(); $('transfer-host').disabled = !live() || !others.length;
  $('away-room').disabled = leaving;
  $('confirm-leave-room').disabled = !live(); $('army-resign-confirm').disabled = !playing();
  for (const id of ['cancel-leave-room','leave-room-close','army-resign-cancel','army-resign-close']) $(id).disabled = leaving || busy;
  $('army-offer-draw').hidden = spectator() || view.phase!=='playing'; $('army-offer-draw').disabled = !playing() || Boolean(view.game?.drawOfferByPlayerId);
  $('army-resign').hidden = spectator() || view.phase!=='playing'; $('army-resign').disabled = !playing();
  $('leave-room-explanation').textContent = spectator()?'退出只结束你的观战，不影响正在下棋的朋友或本局结果。棋牌账号继续登录。':roomExitExplanation(view.phase);
  const viewers=view.spectators || [];
  $('army-spectator-note').textContent=viewers.length?`观战 ${viewers.length}/${view.spectatorCapacity || 8} 人：${viewers.map(person=>person.name+(person.connected?'':'（暂时离线）')).join('、')}`:'暂无朋友观战。';
  $('army-switch-role').hidden=view.phase!=='waiting' || host;
  $('army-switch-role').textContent=spectator()?'入座下棋':'改为观战';
  $('army-switch-role').disabled=!live() || (spectator()?view.players.length>=2:viewers.length>=(view.spectatorCapacity || 8));
  const expires = new Date(view.expiresAt), expiry = Number.isFinite(expires.getTime())?` 到期：${expires.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}。`:'';
  $('room-options-note').textContent = (paused?'暂停保存7天，任一在席玩家可以继续。':view.pause?`暂停确认 ${view.pause.agreedIds.length}/${view.pause.requiredIds.length} 人。`:'暂离保留席位；退出会释放席位。无操作8小时后到期。') + expiry;
}
function renderDrawOffer() {
  const offered = view?.game?.drawOfferByPlayerId, available = !spectator() && view?.phase==='playing' && offered;
  $('army-draw-offer').hidden = !available;
  if (!available) return;
  const own = offered === view.selfId;
  $('army-draw-note').textContent = own?'已向朋友提议和棋，等待回复。':'朋友提议和棋，是否同意结束本局？';
  for (const id of ['army-accept-draw','army-decline-draw']) { $(id).hidden = own; $(id).disabled = !playing(); }
}
function renderActivity() {
  const records = (view?.activity || []).toReversed(), pages = Math.ceil(records.length/6);
  activityPage = Math.max(0, Math.min(activityPage, pages-1));
  $('room-activity-list').replaceChildren(...records.slice(activityPage*6,activityPage*6+6).map(record => {
    const row=element('li'),time=element('time','',new Date(record.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));row.append(time,element('span','',record.text));return row;
  }));
  if (!records.length) $('room-activity-list').append(element('li','activity-empty','这一局还没有公开动态。'));
  $('activity-page').textContent = pages?`${activityPage+1}/${pages}`:'暂无动态'; $('activity-prev').disabled=activityPage===0; $('activity-next').disabled=activityPage>=pages-1;
}
function renderCaptured() {
  const pieces = view?.game?.capturedPieces || [];
  $('army-captured-list').replaceChildren(...['red','black'].map(side => {
    const labels = pieces.filter(piece=>!piece.hidden&&piece.side===side).map(piece=>piece.label || '棋子');
    return element('p','',`${armySideLabel(side)}：${labels.length?labels.join('、'):'暂无'}`);
  }));
}
function renderRules() {
  const pages=armyRulePages(view?.game || {ruleVersion:'army-flip-v3'});
  const timerRule=view?.turnClock || !view?.game?'每回合30分钟，时间到自动跳过；暂停时停止计时。':'这局未启用计时，重新开局后启用30分钟回合。';
  for(const page of pages) for(const rule of page) rule.text=rule.text.replace('没有倒计时。',timerRule);
  rulePage=Math.min(rulePage,pages.length-1);
  $('rules-title').textContent=`翻棋军棋 · ${armyRuleModeLabel(view?.game || {ruleVersion:'army-flip-v3'})}`;
  $('army-rule-page').replaceChildren(...pages[rulePage].map(rule=>{const section=element('section');section.append(element('h3','',rule.title),element('p','',rule.text));return section;}));
  $('army-rules-page').textContent=`${rulePage+1}/${pages.length}`; $('army-rules-prev').disabled=rulePage===0; $('army-rules-next').disabled=rulePage===pages.length-1;
}
function applyView(next) {
  if (next.gameType !== 'army-flip') { clearPrivate(); try { location.replace(roomHref(roomCode, next.gameType)); } catch { clearPrivate({status:503}); } return; }
  const previous = view, soundBaseline=baseline || document.hidden || connection!=='online';
  const effects = armyTransition(previous,next,{baseline:soundBaseline});
  const phaseCue=audio.phaseCue(previous,next,{baseline:soundBaseline}); baseline = false;
  if (!previous || previous.matchId !== next.matchId || previous.game?.revision !== next.game?.revision || previous.phase !== next.phase || previous.selfRole !== next.selfRole) {selected=null;closePickupChoice();}
  view=next; receiveTurnClock(); if((view.phase!=='playing' || spectator()) && $('army-resign-dialog').open) $('army-resign-dialog').close(); renderRoom();
  if (!selected) feedback(`${effects.changed?armyLastActionText(next):''}${turnText()}`);
  const publicCue=effects.changed?audio.armyCue(next.game?.lastAction):null;
  const cue=['draw','placement'].includes(effects.cue)?publicCue:effects.cue;
  if(publicCue && publicCue!==cue)audio.play(publicCue,{gesture:busy});
  if (cue) audio.play(cue,{gesture:busy});
  else if(phaseCue) audio.play(phaseCue,{gesture:busy});
}
async function action(type, fields = {}) {
  if (!live() || spectator() && !(type==='set-role' && view.phase==='waiting')) return false;
  const current=client, sequence=bootSequence;
  let accepted=false;
  busy=true; if (['flip','move','pickup','resign'].includes(type)) selected=null; renderRoom();
  try { await current.action(type,fields); if(sequence!==bootSequence || current!==client) return false; accepted=true;
    if(type==='ready')audio.play(fields.ready?'ready':'undo',{gesture:true});
    else if(type==='pause' && view?.phase!=='paused')audio.play(fields.agree===false?'undo':'ready',{gesture:true});
    return true; }
  catch(error) { if(sequence===bootSequence) { audio.play('invalid',{gesture:true});toast(gameErrorMessage(error));feedback(gameErrorMessage(error)); } return false; }
  finally { if(sequence===bootSequence && current===client) { busy=false; renderRoom(); if(!selected) feedback(`${accepted && view?.game?.lastAction?.playerId===view.selfId?armyLastActionText(view):''}${turnText()}`); } }
}
let roomBootstrap = null;
function cancelRoomBootstrap() {const pending=roomBootstrap;roomBootstrap=null;pending?.controller.abort();}
function clearPrivate(error = {}, {preserveDraft=error.status===503} = {}) {
  cancelRoomBootstrap();
  closePickupChoice();
  ++bootSequence; client?.stop(); chat?.clear({preserveDraft}); client=null; view=null; selected=null; busy=false; leaving=false; pendingLeave=null; connection='offline'; baseline=true; boardSignature=''; activityPage=0; resetTurnClock();
  for (const id of ['room-options-dialog','room-activity-dialog','leave-room-dialog','army-resign-dialog','army-captured-dialog']) if($(id).open) $(id).close();
  for (const id of ['army-cells','army-lines','room-players','result-scores','room-activity-list','army-captured-list','next-host']) $(id).replaceChildren();
  document.body.classList.remove('in-game'); $('room-play').hidden=true; $('room-result').hidden=true; $('army-draw-offer').hidden=true; $('room-waiting').hidden=false;
  for (const id of ['ready-button','leave-room','room-options']) $(id).disabled=true;
  $('start-room').hidden=true; $('rematch').hidden=true; $('host-transfer-controls').hidden=true;
  $('army-spectator-note').textContent='';$('army-switch-role').hidden=true;
  $('result-title').textContent=''; $('result-reason').textContent=''; $('army-turn').textContent='等待恢复'; $('army-feedback').textContent='';
  $('connection-label').textContent='等待恢复'; $('waiting-hint').textContent=error.status===503?'暂时无法核验账号，棋局与原席位仍保存在服务器。重新连接后继续。':error.status?gameErrorMessage(error):error.message || '正在核验账号并恢复原席位…';
  const recover=$('room-account-recover'); recover.hidden=!error.status;
  recover.href=error.status===401?loginHref(`/army.html?code=${roomCode}`):error.status===404?'./':location.href;
  recover.textContent=error.status===401?'登录并恢复房间 →':error.status===404?'回到大厅 →':'重新连接 →';
  const reauth=reauthenticationHref(); $('room-account-reauth').hidden=error.status!==401||!reauth; $('room-account-reauth').href=reauth||'#'; $('room-account-reauth-note').hidden=$('room-account-reauth').hidden;
}
async function bootRoom(state) {
  if(roomBootstrap?.generation===accountGeneration() && roomBootstrap.sequence===bootSequence && !roomBootstrap.controller.signal.aborted) return roomBootstrap.promise;
  clearPrivate({}, {preserveDraft:true}); const sequence=bootSequence;
  const task={sequence,generation:accountGeneration(),controller:new AbortController(),promise:null};
  roomBootstrap=task;
  task.promise=(async()=>{
  try {
    state ||= await loadAccount();
    if(sequence!==bootSequence || document.hidden || state.verification!=='verified') return;
    if(!/^\d{6}$/.test(roomCode)) {location.replace('./');return;}
    const legacy=state.mode==='legacy';
    if(!legacy && !state.authenticated) {clearPrivate({status:state.failureStatus===503||loginFailure==='unavailable'||!state.loginReady?503:401,message:loginFailure==='verify'?'登录尚未通过核验，请先重新验证账号。':'请登录后恢复原席位。'});return;}
    const generation=accountGeneration();
    let membership=legacy?loadMembership(roomCode):null,firstView=null;
    if(!legacy) {
      try {firstView=(await api(`/api/rooms/${roomCode}`,{signal:task.controller.signal})).view;membership={roomCode,playerId:firstView.selfId,userKey:state.userKey};}
      catch(error) {if(sequence!==bootSequence)return;if([403,404].includes(error.status)){location.replace(`./?room=${roomCode}`);return;}throw error;}
    }
    if(!membership) {location.replace(`./?room=${roomCode}`);return;}
    if(sequence!==bootSequence || generation!==accountGeneration() || document.hidden || accountState().verification!=='verified') return;
    $('room-account-recover').hidden=true; $('room-account-logout').hidden=legacy;
    const nextClient=new RoomClient(roomCode,membership,{
      onView:next=>{if(sequence===bootSequence&&generation===accountGeneration()&&!document.hidden&&accountState().verification==='verified')applyView(next);},
      onConnection:status=>{if(sequence!==bootSequence||generation!==accountGeneration()||document.hidden)return;if(status!=='online'){baseline=true;selected=null;}connection=status;chat?.connection(status);$('connection-label').textContent=`${status==='online'?'已连接':'重连中'} · ${roomCode}`;renderRoom();},
      onChat:packet=>chat?.receive(packet),
      onError:error=>{if(leaving&&error.status===404)return;if(error.status===404&&view)forgetMembership(roomCode,view.selfId);if(error.status===404||!legacy&&[401,503].includes(error.status))clearPrivate(error);else toast(gameErrorMessage(error));},
    }); client=nextClient;
    drawRoads();
    if(firstView)nextClient.receive(firstView);else await nextClient.refresh();
    if(sequence===bootSequence&&generation===accountGeneration()&&client===nextClient){
      chat.attach(nextClient,nextClient.view,state);nextClient.connect();
      if(nextClient.view && loginFailure==='account' && !loginConflictNotified) {
        loginConflictNotified=true;toast('当前棋牌账号与原席位保持。请先退出棋牌室，再切换账号。');
      }
    }
  }catch(error){if(sequence===bootSequence && !task.controller.signal.aborted)clearPrivate(error);}
  finally {if(roomBootstrap===task)roomBootstrap=null;}
  })();
  return task.promise;
}
let soundRestoreRequested=false;
function updateAudio() {
  const state=audio.state(),toggle=$('sound-toggle');
  toggle.textContent=state.muted||!state.supported?'音效关':state.ready?'音效开':'点按启声';
  toggle.setAttribute('aria-pressed',String(!state.muted&&state.ready));
  toggle.setAttribute('aria-label',state.muted?'开启音效':state.ready?'关闭音效':'点按恢复音效');
  toggle.disabled=!state.supported; $('sound-volume').value=Math.round(state.volume*100);
}
audio.onStateChange(updateAudio);
// Touch activation is granted on release; repeated handlers share audio.unlock().
for(const type of ['pointerdown','touchstart','pointerup','touchend','keydown'])document.addEventListener(type,event=>{
  if(!event.isTrusted)return;
  if(event.target?.closest?.('#sound-toggle') && audio.state().needsGesture)soundRestoreRequested=true;
  audio.unlock().then(updateAudio).catch(()=>{});
},{capture:true});
$('sound-toggle').addEventListener('click',()=>{
  const state=audio.state();audio.setMuted(soundRestoreRequested?false:state.muted?false:state.ready);soundRestoreRequested=false;updateAudio();
  if(!audio.state().muted)audio.unlock().then(()=>{audio.play('placement',{gesture:true});updateAudio();}).catch(updateAudio);
});
$('sound-volume').addEventListener('input',event=>audio.setVolume(Number(event.target.value)/100));updateAudio();
audio.bindPreview({select:$('sound-preview-kind'),button:$('sound-preview'),status:$('sound-preview-status')});
window.addEventListener('resize',syncViewport);window.visualViewport?.addEventListener('resize',syncViewport);window.visualViewport?.addEventListener('scroll',syncViewport);syncViewport();
$('army-cancel').addEventListener('click',()=>{if(!selected)return;selected=null;renderBoard();feedback(turnText());audio.play('undo',{gesture:true});});
$('show-rules').addEventListener('click',()=>{renderRules();$('rules-dialog').showModal();});
for(const id of ['close-rules','start-playing'])$(id).addEventListener('click',()=>$('rules-dialog').close());
for(const [id,delta]of[['army-rules-prev',-1],['army-rules-next',1]])$(id).addEventListener('click',()=>{rulePage+=delta;renderRules();});
$('army-switch-role').addEventListener('click',()=>{if(view?.phase==='waiting')action('set-role',{role:spectator()?'player':'spectator'});});
$('ready-button').addEventListener('click',()=>action('ready',{ready:!view?.players.find(player=>player.id===view.selfId)?.ready}));
$('start-room').addEventListener('click',()=>action('start'));
$('rematch').addEventListener('click',()=>action('rematch'));
$('room-options').addEventListener('click',()=>{renderControls();$('room-menu-status').textContent='';$('room-options-dialog').showModal();});
$('room-options-close').addEventListener('click',()=>$('room-options-dialog').close());
$('show-room-activity').addEventListener('click',()=>{$('room-options-dialog').close();activityPage=0;renderActivity();$('room-activity-dialog').showModal();});
$('room-activity-close').addEventListener('click',()=>$('room-activity-dialog').close());
for(const[id,delta]of[['activity-prev',-1],['activity-next',1]])$(id).addEventListener('click',()=>{activityPage+=delta;renderActivity();});
$('army-captured').addEventListener('click',()=>{renderCaptured();$('army-captured-dialog').showModal();});
$('army-captured-close').addEventListener('click',()=>$('army-captured-dialog').close());
$('away-room').addEventListener('click',()=>{location.href='./';});
$('pause-room').addEventListener('click',async()=>{const agree=!view?.pause?.agreedIds?.includes(view.selfId);if(await action('pause',{agree}))$('room-menu-status').textContent=view?.phase==='paused'?'棋局已保存，准备好后继续。':agree?'已同意暂停，等待朋友确认。':'已撤回暂停同意。';});
const resume=async()=>{if(await action('resume'))$('room-options-dialog').close();};$('resume-room').addEventListener('click',resume);$('resume-room-menu').addEventListener('click',resume);
$('transfer-host').addEventListener('click',async()=>{if(await action('transferHost',{playerId:$('next-host').value}))$('room-menu-status').textContent='房主已转交。';});
$('take-host').addEventListener('click',async()=>{if(await action('transferHost',{playerId:view?.selfId}))$('room-menu-status').textContent='你已接任房主。';});
$('army-offer-draw').addEventListener('click',async()=>{if(await action('offer-draw'))$('room-options-dialog').close();});
$('army-accept-draw').addEventListener('click',()=>action('accept-draw'));$('army-decline-draw').addEventListener('click',()=>action('decline-draw'));
$('army-resign').addEventListener('click',()=>{if(!playing())return;$('room-options-dialog').close();$('army-resign-status').textContent='';$('army-resign-dialog').showModal();});
for(const id of ['army-resign-cancel','army-resign-close'])$(id).addEventListener('click',()=>{if(!busy)$('army-resign-dialog').close();});
$('army-resign-confirm').addEventListener('click',async()=>{if(await action('resign'))$('army-resign-dialog').close();else if(view)$('army-resign-status').textContent='认输结果未确认，请查看棋盘后重试。';});
$('army-resign-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
$('leave-room').addEventListener('click',()=>{if(!live())return;renderControls();$('leave-room-status').textContent='';$('leave-room-dialog').showModal();});
for(const id of ['cancel-leave-room','leave-room-close'])$(id).addEventListener('click',()=>{if(!leaving)$('leave-room-dialog').close();});
$('leave-room-dialog').addEventListener('cancel',event=>{if(leaving)event.preventDefault();});
$('confirm-leave-room').addEventListener('click',async()=>{
  if(!live())return;const current=client,selfId=view.selfId,sequence=bootSequence;leaving=true;busy=true;renderRoom();$('leave-room-status').textContent='正在确认退出…';
  pendingLeave||={type:'leave',requestId:crypto.randomUUID(),expectedRevision:view.revision};
  try{const result=await current.request(`/api/rooms/${roomCode}/actions`,{method:'POST',token:current.membership.token,body:pendingLeave},current.epoch());
    if(sequence!==bootSequence||current!==client)return;if(!result.left)throw new Error('退出结果暂时无法确认，请重试。');current.stop();forgetMembership(roomCode,selfId);clearPrivate();location.href='./';
  }catch(error){if(sequence!==bootSequence||current!==client)return;leaving=false;busy=false;if([400,403,409].includes(error.status))pendingLeave=null;$('leave-room-status').textContent=gameErrorMessage(error);renderRoom();current.connect();}
});
$('copy-invite').addEventListener('click',async()=>{const invitation=new URL(`./?room=${roomCode}`,location.href).href;try{await navigator.clipboard.writeText(invitation);toast('邀请链接已复制，房间号 '+roomCode+'。');}catch{toast('房间号 '+roomCode+'，可以直接告诉朋友。');}});
$('room-account-logout').addEventListener('click',async()=>{clearPrivate();try{await logoutAccount();location.href='./';}catch(error){clearPrivate({status:503});toast(gameErrorMessage(error));}});
chat=mountRoomChat({onCue:kind=>audio.play(kind),onUnavailable:error=>clearPrivate(error.status===403?{...error,status:404}:error)});
onAccountChange(()=>{const state=accountState();if(!state.authenticated&&state.mode!=='legacy'||client&&client.accountEpoch!==accountGeneration())clearPrivate({status:state.failureStatus===503?503:401});});
const lifecycle=watchAccountLifecycle({onSuspend:()=>clearPrivate({message:'正在重新核验账号…'},{preserveDraft:true}),onVerified:state=>{if(!client)bootRoom(state);},onError:error=>clearPrivate(error)});
$('room-account-recover').addEventListener('click',event=>{if($('room-account-recover').textContent==='重新连接 →'){event.preventDefault();lifecycle.refresh();}});
lifecycle.refresh();
