import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountGameViewport, mountCanvasPin } from '../../platform/room-viewport.mjs';
import { createRoomClock, renderRoomClock } from '../../platform/room-clock.mjs';
import { createRoomSession, createRoomExit } from '../../platform/room-session.mjs';
import { entryStorageKey, gamePath } from '../../entry-path.mjs';
import { createPracticeState, createJokerPracticeState, createDeck, validateMeld, normalizeMeld, evaluateDraft, commitDraft, drawTile, sortRack, stateProblem, ruleVersionOf, canRearrangeJokers } from './rules.mjs';
import { RoomClient, api, loadMembership, normalizeCode, forgetMembership } from '../../room-client.mjs';
import { loadAccount, accountState, accountGeneration, onAccountChange, logoutAccount, watchAccountLifecycle, loginHref, reauthenticationHref } from '../../account-client.mjs';
import { fitGroupsToViewport, placeGroup, boardLayoutPositions } from './table-layout.mjs';
import { mountRoomChat } from '../../room-chat.mjs';
import { fitFreeRack, normalizeRackPositions, normalizeRackBasis, rebaseFreeRack, placeRackTiles, moveRackTiles } from './rack-layout.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { inspectorPages as paginateInspector, roomTransition, openingProgress } from './presentation.mjs';
import { roomExitExplanation, roomDraftMatches, gameErrorMessage, orderedRoomPlayers } from '../../platform/room-presentation.mjs';
import { roomHref } from '../../game-routing.mjs';
import { updateTurnFeedback, turnFeedbackMessage } from './feedback.mjs';
import { sortPlayableRack, autoSplitDuplicateRun, splitRunAfterExtraction } from './assist.mjs';
import { gameViewport } from '../../game-viewport.mjs';
import { createPreviewPublisher,encodeBoardPositions,decodeBoardPositions } from './preview-client.mjs';

const $ = (id) => document.getElementById(id);
const clone = (value) => structuredClone(value);
const COLORS = { red: '红色', blue: '蓝色', black: '黑色', orange: '黄色' };
const ROOM_MODE = document.body.dataset.mode === 'room';
const JOKER_LESSON = !ROOM_MODE && new URLSearchParams(location.search).get('lesson') === 'joker';
const STORAGE_KEY = entryStorageKey(JOKER_LESSON ? 'friends-game-room.practice.joker.v2' : 'friends-game-room.practice.v1');
const newPracticeState = () => JOKER_LESSON ? createJokerPracticeState() : createPracticeState();
const roomCode = normalizeCode(new URLSearchParams(location.search).get('code'));
const loginFailure=new URLSearchParams(location.search).get('login');
let loginConflictNotified = false;
let roomClient = null;
let roomView = null;
const turnClock = createRoomClock({
  onRender: state => renderRoomClock(document, state),
  onExpire: () => {
    clearDrag(); previewPublisher.reset();
    for (const id of ['commit','draw','restore','undo','return-rack']) $(id).disabled = true;
    document.body.classList.remove('rummi-own-turn'); $('feedback-text').textContent = '本回合时间已到，正在换人。';
  },
  setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
});
const clockDisplay = () => turnClock.display();
const renderTurnClock = () => turnClock.render();
const resetTurnClock = () => turnClock.reset();
const receiveTurnClock = () => turnClock.receive(roomView);

let connection = 'connecting';
let busy = false;
let restoredRoomDraft = false;
let roomAccountUserKey = null;
const roomSession = createRoomSession({ document, accountGeneration, accountState, getClient: () => roomClient });
let roomChat = null;
let needsRoomBaseline = true;
let leavingRoom = false;

const roomExit = createRoomExit({ session: roomSession, roomCode, getClient: () => roomClient, getView: () => roomView, forgetMembership,
  onPending: () => { leavingRoom=true; busy=true; renderRoomMeta(); $('leave-room-status').textContent='正在确认退出…'; },
  onFailure: error => { leavingRoom=false; busy=false; $('leave-room-status').textContent=gameErrorMessage(error); renderRoomMeta(); render(); },
  onLeft: () => { clearRoomPrivate(); location.href='./'; },
});
const arrivedTileIds = new Map();
let turnNoticeUntil = 0;
let turnFeedbackState=null;
const newSinceOwnTurn=new Set();
let remotePreview=null;
let publicPlacementSound=null,needsPublicPlacementBaseline=true;
const publicSoundKey=view=>JSON.stringify([view?.roomId,view?.selfId,view?.matchId]);
const publicSoundIds=board=>Array.isArray(board)?board.flat().filter(tile=>typeof tile?.id==='string').map(tile=>tile.id):[];
function observePublicPlacementView(view,{baseline=false}={}) {
  const ids=publicSoundIds(view.game?.board),key=publicSoundKey(view);
  if(!view.game || view.phase!=='playing') needsPublicPlacementBaseline=false;
  if(baseline || publicPlacementSound?.key!==key) {
    publicPlacementSound={key,revision:view.game?.revision,formalIds:new Set(ids),visibleIds:new Set(ids),heardIds:new Set(ids),expiredIds:new Set()};return;
  }
  const state=publicPlacementSound,arrived=ids.some(id=>!state.heardIds.has(id));
  for(const id of ids)state.heardIds.add(id);
  state.formalIds=new Set(ids);
  if(state.revision!==view.game?.revision || view.phase!=='playing') {state.visibleIds=new Set(ids);state.expiredIds.clear();}
  state.revision=view.game?.revision;
  if(arrived && ['playing','finished'].includes(view.phase)) audio.play('placement');
}
function observePublicPlacementPreview(packet) {
  if(!packet || document.hidden || !roomView?.game || roomView.phase!=='playing' || connection!=='online'
    || packet.roomId!==roomView.roomId || packet.matchId!==roomView.matchId || packet.gameRevision!==roomView.game.revision
    || packet.turnPlayerId!==roomView.game.turnPlayerId || packet.preview && packet.ownerId!==packet.turnPlayerId) return;
  const key=publicSoundKey(roomView),baseline=needsPublicPlacementBaseline || publicPlacementSound?.key!==key;
  if(publicPlacementSound?.key!==key)observePublicPlacementView(roomView,{baseline:true});
  const state=publicPlacementSound;needsPublicPlacementBaseline=false;
  if(!packet.preview) {
    if(['expired','disconnected','identity-failed'].includes(packet.clearReason)) {for(const id of state.visibleIds)if(!state.formalIds.has(id))state.expiredIds.add(id);}
    else if(packet.clearReason==='cleared')state.expiredIds.clear();
    state.visibleIds=new Set(state.formalIds);return;
  }
  const ids=publicSoundIds(packet.preview.board),next=new Set(ids);
  const arrived=ids.some(id=>!state.visibleIds.has(id) && !state.formalIds.has(id) && !state.expiredIds.has(id));
  for(const id of ids)state.heardIds.add(id);
  for(const id of state.expiredIds)if(!next.has(id))state.expiredIds.delete(id);
  state.visibleIds=next;
  if(!baseline && arrived && packet.ownerId!==roomView.selfId)audio.play('placement');
}
function rememberOwnPublicPlacement() {
  if(!ROOM_MODE || !canAct() || publicPlacementSound?.key!==publicSoundKey(roomView))return;
  for(const id of publicSoundIds(draft.board))publicPlacementSound.heardIds.add(id);
}
const previewPublisher=createPreviewPublisher({send:body=>roomClient.sendPreview(body),onError:error=>{
  if([401,503].includes(error.status))clearRoomPrivate(error);
  else if(error.status!==409 && error.status!==404 && error.name!=='AbortError') $('preview-status').textContent='整理预览暂未同步，正式牌局仍以确认出牌为准。';
}});
const displayedBoard=()=>remotePreview?.preview?.board || draft.board;
const spectating=()=>ROOM_MODE && roomView?.selfRole==='spectator';
function fittedBoard(tiles, positions) {
  const board=$('board'),style=getComputedStyle(board);
  return fitGroupsToViewport(tiles.map(meld=>({id:groupKey(meld),length:meld.length})),
    {width:board.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),height:board.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)},positions);
}
function captureBoardPositions() {
  return encodeBoardPositions(draft.board,boardLayoutPositions(fittedBoard(draft.board,tablePositions)));
}
function captureCommittedBoardPositions() {
  const current=boardLayoutPositions(fittedBoard(draft.board,tablePositions));
  const baseline=boardLayoutPositions(fittedBoard(committed.board,committedTablePositions));
  // A draw discards unconfirmed tile edits. Only an unchanged whole group can
  // retain its visual arrangement; changed groups return to their formal layout.
  const positions=Object.fromEntries(committed.board.map(meld=>{
    const key=groupKey(meld),point=current[key] || baseline[key];
    return [key,{x:point.x,y:point.y}];
  }));
  return encodeBoardPositions(committed.board,positions);
}
function queueLocalPreview() {
  if(!ROOM_MODE || !roomView?.game)return;
  const game=roomView.game,fence=JSON.stringify([roomView.roomId,roomView.selfId,roomView.matchId,game.revision,game.turnPlayerId]);
  const boardIds=draft.board.map(meld=>meld.map(tile=>tile.id));
  const changed=tilesChanged() || layoutChanged();
  const payload={matchId:roomView.matchId,gameRevision:game.revision,...(changed?
    {boardIds,positions:captureBoardPositions().map(point=>point || {x:0,y:0})}:{clear:true})};
  const observers=[...roomView.players,...(roomView.spectators || [])].some(member=>member.id!==roomView.selfId && member.connected);
  const actor=!spectating() && accountState().verification==='verified' && !document.hidden && roomView.phase==='playing'
    && game.status==='playing' && game.turnPlayerId===roomView.selfId && !clockDisplay().expired && !leavingRoom && connection==='online';
  previewPublisher.update({fence,eligible:actor && observers && accountState().mode!=='legacy',paused:busy,payload});
}
function receiveRemotePreview(packet) {
  observePublicPlacementPreview(packet);
  if(document.hidden || !roomView?.game || packet?.ownerId===roomView.selfId || packet?.gameRevision!==roomView.game.revision || canAct()) packet=null;
  const next=packet?.preview?packet:null;
  if(next===remotePreview)return;
  remotePreview=next;
  if(roomView?.game) {
    // A preview changes only the public table, never the private rack's DOM
    // or a pointer capture used to arrange that rack during another's turn.
    renderBoard({allowRackDrag:true});
    if(spectating()) {
      const current=roomView.players.find(player=>player.id===roomView.game.turnPlayerId);
      $('feedback-text').textContent=remotePreview?`${remotePreview.ownerName}正在整理桌面，确认后才正式保存。`:`正在观战 · ${current?.name || '朋友'}的回合。只能查看公共桌面。`;
    }
  }
}
let activityPage = 0;
let jokerSettingsSignature=null;
let lastVerifiedSessionExpiresAt=null;
const JOKER_NAMES={normal:'传统百搭',mirror:'镜像百搭','color-change':'变色百搭',double:'双重百搭'};
const JOKER_ART={normal:'joker-normal-v2.png',mirror:'joker-mirror-v2.png','color-change':'joker-color-change-v2.png',double:'joker-double-v2.png'};
const JOKER_FALLBACK={normal:'百搭',mirror:'镜像','color-change':'变色',double:'双重'};
const JOKER_FIELDS={normal:'joker-normal',mirror:'joker-mirror',colorChange:'joker-color-change',double:'joker-double'};
function renderJokerSettings({force=false}={}) {
  if(!$('joker-config-form') || !roomView)return;
  const config=roomView.jokerConfig || roomView.game?.jokerConfig || {normal:roomView.players.length>4?3:2,mirror:0,colorChange:0,double:0};
  const signature=JSON.stringify(config);
  if(force || jokerSettingsSignature!==signature)for(const [key,id]of Object.entries(JOKER_FIELDS))$(id).value=String(config[key]);
  jokerSettingsSignature=signature;
  const canConfigure=roomView.phase==='waiting' && roomView.hostId===roomView.selfId && !busy && connection==='online';
  const total=Object.values(JOKER_FIELDS).reduce((sum,id)=>sum+Number($(id).value),0);
  for(const id of Object.values(JOKER_FIELDS))$(id).disabled=!canConfigure;
  const valid=Object.values(JOKER_FIELDS).every(id=>Number.isInteger(Number($(id).value)) && Number($(id).value)>=0 && Number($(id).value)<=8) && total<=24;
  $('joker-config-summary').textContent=`鬼牌共 ${total} 张 · 数字牌 ${roomView.players.length>4?156:104} 张`;
  $('joker-config-apply').hidden=roomView.hostId!==roomView.selfId || roomView.phase!=='waiting';
  $('joker-config-apply').disabled=!canConfigure || !valid;
  $('joker-config-status').textContent=!valid?'每类0～8张，合计不能超过24张。':roomView.phase!=='waiting'?'本局设置已锁定；下一局开始前可更改。':roomView.hostId!==roomView.selfId?'由房主设置；变更后所有玩家重新准备。':'';
}
function roomDraftKey(view) {
  return entryStorageKey(accountState().mode==='legacy' ? `friends-game-room.draft.${roomCode}.${view.selfId}`
    : `game-room.private-draft.${roomAccountUserKey}.${view.roomId}.${view.selfId}`);
}
const deck = newPracticeState();
const canonical = new Map([...deck.rack, ...deck.pool, ...deck.board.flat()].map((tile) => [tile.id, tile]));
let committed = clone(deck);
let draft = clone(deck);
let selection = new Set();
let history = [];
let sortMode = '';
let drag = null;
let ghost = null;
let dropHighlight = null;
let autoScrollFrame = null;
let suppressClick = false;
let toastTimer;
let storageAvailable = true;
let boardFitFrame = null;
let rackLayout = null;
let rackOrder = [];
let rackPositions = {};
let rackBasis = null;
let playableRackGroups=[];
let playableRackSignature='';
let playableCanOpen=true;
let rackFitFrame = null;
let inspectorIndex = 0;
let inspectorMode = 'board';
const audio = createGameAudio();
const COLOR_MARKS={red:'● 红',blue:'▲ 蓝',orange:'◆ 黄',black:'■ 黑'};
try { $('tile-color-assist').checked=localStorage.getItem('game-room:color-assist:v1')==='true'; } catch { /* Optional device preference. */ }
document.body.classList.toggle('color-assist',$('tile-color-assist').checked);
$('tile-color-assist').addEventListener('change',event=>{
  const enabled=event.target.checked;document.body.classList.toggle('color-assist',enabled);
  try {localStorage.setItem('game-room:color-assist:v1',String(enabled));} catch { /* Does not affect game state. */ }
});
mountRoomAudioControls({ audio, document, onLabel: '声音开', offLabel: '声音关', restoreWhenUnready: true });

const inspector=document.createElement('dialog');
inspector.id='tile-inspector';inspector.className='tile-inspector';inspector.setAttribute('aria-labelledby','inspector-title');
inspector.innerHTML='<div class="dialog-heading"><h2 id="inspector-title">看清这一组</h2><button type="button" class="close-button" id="inspector-close" aria-label="关闭看牌">×</button></div><p id="inspector-note"></p><div id="inspector-tiles" class="inspector-tiles"></div><div class="inspector-actions"><button id="inspector-prev" type="button" class="secondary-button">上一组</button><span id="inspector-page"></span><button id="inspector-next" type="button" class="secondary-button">下一组</button><button id="inspector-select" type="button" class="primary-button">选中这一组</button></div>';
document.body.append(inspector);
function inspectorPages() {
  return paginateInspector(displayedBoard(), orderedRack(), inspectorMode);
}
function renderInspector() {
  const pages=inspectorPages();inspectorIndex=Math.max(0,Math.min(inspectorIndex,pages.length-1));
  const page=pages[inspectorIndex],tiles=page?.tiles || [];
  $('inspector-title').textContent=inspectorMode==='board'?page?`组合 ${page.groupIndex+1}${page.parts>1?` · ${page.part+1}/${page.parts}`:''}`:'公共桌面还没有牌':'我的手牌';
  $('inspector-note').textContent=inspectorMode==='board'?'每页最多14张；选中这一组后回牌桌继续整理。':'每页14张；点选后回到手牌区，可以自由摆放。';
  $('inspector-tiles').innerHTML=tiles.map(tile=>tileHTML(tile).replace('data-tile=','data-inspect-tile=')).join('');
  $('inspector-page').textContent=pages.length?`${inspectorIndex+1} / ${pages.length}`:'没有牌';
  $('inspector-prev').disabled=inspectorIndex===0;
  $('inspector-next').disabled=inspectorIndex>=pages.length-1;
  $('inspector-prev').textContent='上一页';
  $('inspector-next').textContent='下一页';
  $('inspector-select').hidden=inspectorMode!=='board';
  $('inspector-select').disabled=Boolean(remotePreview) || !canAct() || !page || page.selectionIds.some(isOpeningPublicTile);
}
function openInspector(mode,index=0) {
  clearDrag();inspectorMode=mode;inspectorIndex=index;renderInspector();
  if(!inspector.open) inspector.showModal();
}
$('inspector-close').addEventListener('click',()=>inspector.close());
for(const [id,delta] of [['inspector-prev',-1],['inspector-next',1]]) $(id).addEventListener('click',()=>{inspectorIndex+=delta;renderInspector();});
$('inspector-select').addEventListener('click',()=>{
  const ids=inspectorPages()[inspectorIndex]?.selectionIds || [];
  if(!canAct() || ids.some(isOpeningPublicTile)) return;
  selection=new Set(ids);inspector.close();render();
});
$('inspector-tiles').addEventListener('click',event=>{
  const tile=event.target.closest('[data-inspect-tile]');if(!tile) return;
  const id=tile.dataset.inspectTile;
  if(inspectorMode==='rack' || canAct()) {inspector.close();toggleTile(id);}
});
$('rack-inspect')?.addEventListener('click',()=>openInspector('rack'));
let tablePositions = {};
let committedTablePositions = {};
let tableLayout = null;
let splitKey = null;
let groupDropPreview = null;

const groupKey = (meld) => meld.map(tile => tile.id).sort().join('|');
const roomRuleOptions = game => ({ copies:game.copies,jokerCount:game.jokerCount,maxJokers:game.jokerCount,
  ruleVersion:game.ruleVersion,...(game.jokerConfig===undefined?{}:{jokerConfig:game.jokerConfig}) });
const meldOptions = () => ROOM_MODE && roomView?.game ? roomRuleOptions(roomView.game) : undefined;
function safePositions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, point]) => key.length <= 1000 && point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x <= 10000 && point.y <= 10000).map(([key, point]) => [key, { x: point.x, y: point.y }]));
}
function currentPositions() {
  return tableLayout ? boardLayoutPositions(tableLayout, { display: true }) : clone(tablePositions);
}
function inheritPositions(oldBoard, newBoard, positions) {
  return Object.fromEntries(newBoard.flatMap(meld => {
    const key = groupKey(meld);
    if (positions[key]) return [[key, positions[key]]];
    const ids = new Set(meld.map(tile => tile.id));
    const origin = oldBoard.map(previous => ({ key: groupKey(previous), shared: previous.filter(tile => ids.has(tile.id)).length })).filter(item => item.shared && positions[item.key]).sort((a, b) => b.shared - a.shared)[0];
    return origin ? [[key, positions[origin.key]]] : [];
  }));
}
const layoutChanged = () => JSON.stringify(tablePositions) !== JSON.stringify(committedTablePositions);

function queueBoardFit({allowRackDrag=false}={}) {
  if(boardFitFrame!==null) cancelAnimationFrame(boardFitFrame);
  boardFitFrame=requestAnimationFrame(()=>{
    boardFitFrame=null;
    const board=$('board');
    if(!board.clientWidth || !board.clientHeight || drag?.active && !(allowRackDrag && drag.type==='tile' && drag.element.closest('#rack'))) return;
    const style=getComputedStyle(board);
    const width=board.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    const height=board.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
    const shown=displayedBoard(),shownPositions=remotePreview?decodeBoardPositions(shown,remotePreview.preview.positions):tablePositions;
    const fit=fitGroupsToViewport(shown.map(meld=>({id:groupKey(meld),length:meld.length})),{width,height},shownPositions);
    tableLayout=fit;
    board.style.setProperty('--board-scale',fit.baseScale);
    board.classList.toggle('board-overview',fit.baseScale<0.7);
    const canvas=board.querySelector('.table-canvas');
    canvas.style.transformOrigin='0 0';
    canvas.style.transform=`scale(${fit.canvasScale})`;
    canvas.style.width=`${width/fit.canvasScale}px`;
    canvas.style.height=`${height/fit.canvasScale}px`;
    fit.positions.forEach(point=>{
      const element=[...canvas.querySelectorAll('.meld')].find(item=>item.dataset.groupKey===point.id);
      if(element) {element.style.left=`${point.x/fit.canvasScale}px`;element.style.top=`${point.y/fit.canvasScale}px`;}
    });
    const target=canvas.querySelector('.new-meld');
    target.style.left=`${fit.newTarget.x/fit.canvasScale}px`;target.style.top=`${fit.newTarget.y/fit.canvasScale}px`;
    $('board-view').textContent='看牌';
    $('board-view').title='放大查看组合，不改变桌面位置';
    $('board-count').textContent=`${shown.flat().length} 张牌${fit.scale<1?' · 紧凑显示':''}`;
    queueLocalPreview();
  });
}
$('board').classList.add('auto-fit');
$('board-view').addEventListener('click',()=>openInspector('board'));
window.addEventListener('resize',queueBoardFit);
if(typeof ResizeObserver!=='undefined') new ResizeObserver(queueBoardFit).observe($('board'));

function orderedRack() {
  const known = new Map(draft.rack.map(tile => [tile.id, tile]));
  rackOrder = [...new Set(rackOrder)].filter(id => known.has(id));
  rackOrder.push(...draft.rack.filter(tile => !rackOrder.includes(tile.id)).map(tile => tile.id));
  return rackOrder.map(id => known.get(id));
}
function currentRackLayout() {
  const rack=$('rack'),style=getComputedStyle(rack);
  const left=parseFloat(style.paddingLeft)||0,top=parseFloat(style.paddingTop)||0;
  const width=Math.max(0,rack.clientWidth-left-(parseFloat(style.paddingRight)||0));
  const height=Math.max(0,rack.clientHeight-top-(parseFloat(style.paddingBottom)||0));
  let end=0;const groupBreaks=['color','number'].includes(sortMode)?playableRackGroups.map(group=>end+=group.length):[];
  return fitFreeRack(orderedRack().map(tile=>tile.id),rackPositions,{width,height,basis:rackBasis,groupBreaks,
    tileWidth:36.4,tileHeight:51.8,gap:3.5,preferredRows:2,minReadableWidth:21,minReadableHeight:30});
}
function positionRackTiles(ids,point) {
  if(!point || !Number.isFinite(point.rackX) || !Number.isFinite(point.rackY)) return false;
  const layout=rebaseFreeRack(currentRackLayout());
  rackBasis=layout.basis;
  rackPositions=placeRackTiles(layout,ids,{x:point.rackX-(point.grabX ?? layout.tileWidth/2),
    y:point.rackY-(point.grabY ?? layout.tileHeight/2)},point.anchorId);
  return true;
}
function queueRackFit() {
  if(rackFitFrame!==null) cancelAnimationFrame(rackFitFrame);
  rackFitFrame=requestAnimationFrame(()=>{
    rackFitFrame=null;
    const rack=$('rack'),style=getComputedStyle(rack);
    if(!rack.clientWidth || !rack.clientHeight || drag?.active) return;
    const left=parseFloat(style.paddingLeft)||0,top=parseFloat(style.paddingTop)||0;
    rackLayout=currentRackLayout();
    const before=JSON.stringify(rackPositions);
    rackPositions=rackLayout.manual?rackLayout.positions:{};
    rackBasis=rackLayout.manual?rackLayout.basis:null;
    rack.style.setProperty('--rack-tile-width',`${rackLayout.tileWidth}px`);
    rack.style.setProperty('--rack-tile-height',`${rackLayout.tileHeight}px`);
    rack.style.setProperty('--rack-rows',rackLayout.rows);
    rack.classList.toggle('rack-compact',!rackLayout.readable);
    $('rack-inspect')?.classList.toggle('attention',!rackLayout.readable);
    [...rack.querySelectorAll('[data-tile]')].forEach((element,index)=>{
      const point=rackLayout.rects[index];
      Object.assign(element.style,{position:'absolute',left:`${left+point.x}px`,top:`${top+point.y}px`,width:`${point.width}px`,height:`${point.height}px`,fontSize:`${point.width*0.64}px`,zIndex:String(point.z+1)});
    });
    if(before!==JSON.stringify(rackPositions)) save();
  });
}
window.addEventListener('resize',queueRackFit);
if(typeof ResizeObserver!=='undefined') new ResizeObserver(queueRackFit).observe($('rack'));
const canvasPin = mountCanvasPin({ document, containers: [document.querySelector('.shell'), document.querySelector('main'), $('room-play'), $('room-players'), $('board'), $('rack')] });
function syncViewport() {
  canvasPin.pin();
  const viewport=window.visualViewport;
  const editing=Boolean(document.activeElement?.matches?.('input,textarea,[contenteditable="true"]'));
  const values=gameViewport({width:window.innerWidth || innerWidth,height:window.innerHeight || innerHeight,visual:viewport,editing});
  for(const key of ['width','height','top','left']) document.documentElement.style.setProperty(`--game-viewport-${key}`,`${values[key]}px`);
  if(values.resetScroll && (window.scrollX || window.scrollY)) window.scrollTo?.(0,0);
  queueBoardFit();queueRackFit();
}
mountGameViewport({ window, document, sync: syncViewport, onRecover: clearDrag,
  recoveryDelays: [120, 350, 750], setTimeout, clearTimeout });

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}

function sameTile(a, b) {
  return a.id === b.id && a.color === b.color && a.value === b.value && Boolean(a.joker) === Boolean(b.joker);
}

function validSavedState(state, isDraft = false) {
  if (!state || state.version !== 1 || typeof state.opened !== 'boolean' || !Number.isSafeInteger(state.round) || state.round < 1 || state.round > 100000) return false;
  if (![state.rack, state.pool, state.board].every(Array.isArray) || state.board.length > 106 || !state.board.every(Array.isArray)) return false;
  const tiles = [...state.rack, ...state.pool, ...state.board.flat()];
  if (tiles.length !== 106 || new Set(tiles.map((tile) => tile?.id)).size !== 106) return false;
  if (!tiles.every((tile) => tile && canonical.has(tile.id) && sameTile(tile, canonical.get(tile.id)))) return false;
  return !stateProblem(state, !isDraft);
}

function restoreSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.schema !== 1 || !validSavedState(saved.committed) || !validSavedState(saved.draft, true)) throw new Error('invalid practice state');
    if (saved.committed.opened !== saved.draft.opened || saved.committed.round !== saved.draft.round) throw new Error('mismatched practice turn');
    if (ruleVersionOf(saved.committed) !== ruleVersionOf(saved.draft)) throw new Error('mismatched practice rules');
    if (JSON.stringify(saved.committed.pool) !== JSON.stringify(saved.draft.pool)) throw new Error('mismatched pool');
    const publicIds = new Set(saved.committed.board.flat().map((tile) => tile.id));
    if (saved.draft.rack.some((tile) => publicIds.has(tile.id))) throw new Error('public tile in rack');
    if (!saved.committed.opened) {
      for (const state of [saved.committed, saved.draft]) {
        const publicMelds = state.board.filter((meld) => meld.some((tile) => publicIds.has(tile.id)));
        if (JSON.stringify(publicMelds) !== JSON.stringify(deck.board)) throw new Error('opening board changed');
      }
    }
    committed = saved.committed;
    draft = saved.draft;
    committed.board=committed.board.map(meld=>normalizeMeld(meld));
    draft.board=draft.board.map(meld=>normalizeMeld(meld));
    tablePositions=safePositions(saved.tablePositions);
    committedTablePositions=safePositions(saved.committedTablePositions);
    if (saved.sortMode === 'color' || saved.sortMode === 'number' || saved.sortMode === 'manual') sortMode = saved.sortMode;
    rackOrder=Array.isArray(saved.rackOrder)?saved.rackOrder.filter(id=>typeof id==='string'):saved.draft.rack.map(tile=>tile.id);
    rackPositions=normalizeRackPositions(saved.rackPositions,saved.draft.rack.map(tile=>tile.id));
    rackBasis=normalizeRackBasis(saved.rackBasis);
    toast('已恢复这局练习，未提交的整理也保留了。');
  } catch {
    // A malformed or unavailable device-local save must never stop the practice.
    try { localStorage.removeItem(STORAGE_KEY); } catch { storageAvailable = false; }
    toast('这台设备的练习记录无法恢复，已重新开始。');
  }
}

function save() {
  if (ROOM_MODE) {
    if (!roomView?.game || spectating()) return;
    try { sessionStorage.setItem(roomDraftKey(roomView), JSON.stringify({ revision: roomView.revision, matchId:roomView.matchId, gameRevision:roomView.game.revision, boardIds: draft.board.map(meld => meld.map(tile => tile.id)), rackIds: draft.rack.map(tile => tile.id), rackOrder, rackPositions, rackBasis, sortMode, tablePositions, committedTablePositions,turnFeedbackState })); } catch { /* Server seat recovery is independent from draft storage. */ }
    return;
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 1, committed, draft, rackOrder, rackPositions, rackBasis, sortMode, tablePositions, committedTablePositions })); }
  catch {
    if (storageAvailable) toast('浏览器未允许保存；刷新后可能需要重新开始。');
    storageAvailable = false;
  }
}

function tilesChanged() {
  return JSON.stringify(draft.rack) !== JSON.stringify(committed.rack) || JSON.stringify(draft.board) !== JSON.stringify(committed.board);
}

function tileHTML(tile) {
  const selected = selection.has(tile.id);
  const jokerType=tile.jokerType===undefined?'normal':Object.hasOwn(JOKER_ART,tile.jokerType)?tile.jokerType:'unknown';
  const label = tile.joker ? JOKER_NAMES[jokerType] || '未知鬼牌' : `${COLORS[tile.color]} ${tile.value}`;
  const arrived=(arrivedTileIds.get(tile.id) || 0)>performance.now();
  const newSince=newSinceOwnTurn.has(tile.id);
  const newDescription=turnFeedbackState?.recovered?'恢复后新增的牌':'朋友新出的牌';
  const playableGroup=playableRackGroups.findIndex(group=>group.some(item=>item.id===tile.id));
  return `<button type="button" class="tile${tile.joker ? ' joker' : ''}${selected ? ' selected' : ''}${arrived?' tile-arrived':''}${newSince?' tile-new-since-turn':''}${playableGroup>=0?' tile-playable':''}" data-tile="${tile.id}" data-color="${tile.color}"${tile.joker?` data-joker-type="${jokerType}"`:''}${playableGroup>=0?` data-playable-group="${playableGroup}"`:''} aria-label="${label}${newSince?'，'+newDescription:''}${playableGroup>=0?`，手牌组合 ${playableGroup+1}${playableCanOpen?'':'，尚未满30点'}`:''}" aria-pressed="${selected}" title="${label}${newSince?' · '+newDescription:''}">${tile.joker ? `<span class="joker-face" aria-hidden="true">${JOKER_ART[jokerType]?`<img src="${gamePath('/assets/'+JOKER_ART[jokerType])}" alt="" class="joker-art"><span class="joker-art-fallback">${JOKER_FALLBACK[jokerType]}</span>`:'<span class="joker-missing">?</span>'}</span>` : tile.value}${tile.joker && jokerType!=='normal'?`<span class="joker-kind" aria-hidden="true">${{mirror:'镜','color-change':'变',double:'双',unknown:'未知'}[jokerType]}</span>`:''}${tile.joker?'':`<span class="tile-color-tag" aria-hidden="true">${COLOR_MARKS[tile.color]}</span>`}${newSince?'<span class="tile-new-mark" aria-hidden="true">新</span>':''}${playableGroup>=0?`<span class="rack-group-mark" aria-hidden="true">${playableGroup+1}</span>`:''}</button>`;
}

function renderRuleText() {
  const state = ROOM_MODE ? { ruleVersion: roomView?.game?.ruleVersion || (roomView?.jokerConfig ? 'friends-v4' : 'friends-v2') } : committed;
  const unlocked = canRearrangeJokers(state);
  $('rule-version').textContent = `${ROOM_MODE ? '拉密朋友局' : JOKER_LESSON ? '拉密操作练习 · 鬼牌重组' : '拉密操作练习'}${unlocked ? '' : ' · 这局沿用旧规则'}`;
  $('rule-version').dataset.ruleVersion = ruleVersionOf(state);
  $('joker-rule').textContent = unlocked
    ? '开局后可以重组含鬼牌组合。取回的鬼牌可接进已有组合，或组成新组；本回合必须重新用到桌上，并至少出一张自己的牌。桌面牌不能拿回手牌。'
    : '这局保留旧规则：已提交的含鬼牌组合只能移动整组位置，不能拆分、接牌或取回鬼牌。重新开始一局即可使用鬼牌重组。';
  if ($('twist-rule')) {
    $('twist-rule').hidden = !['friends-v3','friends-v4'].includes(ruleVersionOf(state));
    $('twist-rule').textContent = '传统百搭代替一个数字。镜像百搭必须在正中，两侧数字和颜色对称；每组限一张。'
      + (ruleVersionOf(state)==='friends-v4' ? '朋友计分：镜像计靠中心的对应数字；相邻双重牌只取靠中心的一格。' : '这局沿用旧计分：镜像自身计0分。')
      + '变色百搭只用于顺子，数字仍连续，可改变后面牌的颜色。双重百搭在顺子中代替连续两个数字，在同数组中代替两种缺少的颜色。每组至少三张实牌，不能全是鬼牌；手里每张鬼牌结算按30点。';
  }
  if (ROOM_MODE && $('tile-count-rule')) {
    const game=roomView?.game,copies=game?.copies || (roomView?.players?.length>4?3:2);
    const jokerCount=game?.jokerCount ?? (roomView?.jokerConfig ? Object.values(roomView.jokerConfig).reduce((sum,count)=>sum+count,0) : copies);
    $('tile-count-rule').textContent=`2～4人用两副数字牌；5～7人用三副。这局用${copies===3?'三':'两'}副数字牌和${jokerCount}张鬼牌，共${copies*52+jokerCount}张；每人起手14张。`;
  }
  if (ROOM_MODE) {
    const timed = roomView?.turnClock || roomView?.phase === 'waiting';
    $('room-rule-note').textContent = (unlocked ? '朋友局：首次30点，开局后可取回和重组鬼牌。' : '这局保留旧规则：含鬼牌组合锁定。')
      + (timed ? '每回合30分钟，时间到自动摸牌；牌池空时过牌。没有罚牌。' : '旧局未启用计时；重新开局后每回合30分钟。没有罚牌。');
  }
}

function renderBoard({allowRackDrag=false}={}) {
  const deckOptions = meldOptions();
  const publicIds = new Set(committed.board.flat().map((tile) => tile.id));
  const shownBoard=displayedBoard();
  if($('preview-status')) {
    $('preview-status').hidden=!remotePreview;
    $('preview-status').textContent=remotePreview?`${remotePreview.ownerName}正在整理 · 未确认${remotePreview.preview.valid?'':' · '+remotePreview.preview.validationMessage}`:'';
  }
  $('board').classList.toggle('board-live-preview',Boolean(remotePreview));
  $('board').innerHTML = '<div class="table-canvas" data-board-surface>' + shownBoard.map((meld, index) => {
    const result = validateMeld(meld, deckOptions);
    const openingLocked = !committed.opened && meld.some((tile) => publicIds.has(tile.id));
    const jokerLocked = !canRearrangeJokers(committed) && committed.board.some((original) => original.some((tile) => tile.joker) && original.some((tile) => meld.some((current) => current.id === tile.id)));
    const locked = openingLocked || jokerLocked;
    const isNew = meld.every((tile) => !publicIds.has(tile.id));
    const status = remotePreview?'整理中 · 未确认':openingLocked ? '开局后可重组' : jokerLocked ? '本局鬼牌组锁定' : result.valid ? `${result.type === 'run' ? '顺子' : '同数'} · ${result.points} 点` : '还差一点';
    const key=groupKey(meld);
    const splitting=splitKey===key;
    const tiles=meld.map((tile,tileIndex)=>(remotePreview?tileHTML(tile).replace('data-tile=','disabled data-preview-tile='):tileHTML(tile))+(splitting && !remotePreview && tileIndex<meld.length-1 ? `<button class="split-gap" style="left:calc((42px * ${tileIndex+1} - 2px) * var(--board-scale))" data-cut="${tileIndex+1}" data-meld="${index}" aria-label="在组合 ${index+1} 的第 ${tileIndex+1} 张牌后拆开" title="从这里拆开">✂</button>` : '')).join('');
    return `<div class="meld${locked ? ' locked' : ''}${result.valid ? '' : ' invalid'}${splitting ? ' splitting' : ''}" data-zone="${index}" data-group-key="${key}" style="--meld-count:${meld.length}"><button class="meld-header" data-place="${index}" data-group="${index}" aria-label="拖动组合 ${index+1}${selection.size?'；点击加入选中牌':''}" title="拖动整组到空位整理，拖到另一组拼接"><span><span aria-hidden="true" class="group-grip">⠿</span> ${isNew ? '我的组合' : '组合'} ${String(index+1).padStart(2,'0')}</span><small>${status}</small></button><div class="meld-tiles" data-zone="${index}">${tiles}</div><button type="button" class="split-group" data-split="${index}" aria-label="${splitting?'取消拆分':'拆分组合 '+(index+1)}" aria-pressed="${splitting}" ${locked || meld.length<2 || !canAct()?'disabled':''} title="点这里，再选两张牌之间的分界">${splitting?'×':'✂'}</button></div>`;
  }).join('') + '<button class="new-meld" data-zone="new" data-place="new" aria-label="把选中牌放进新组合"><b aria-hidden="true">+</b><span>新组合 <span aria-hidden="true">·</span> 把牌放到这里</span></button></div>';
  $('board-count').textContent = `${shownBoard.flat().length} 张牌`;
  queueBoardFit({allowRackDrag});
}

function renderOpeningProgress(evaluation, deckOptions) {
  if (spectating()) return;
  const progress = openingProgress(committed, draft, deckOptions);
  if (!progress) { $('table-note').title='';return; }
  $('opening-label').textContent = progress.label;
  $('table-note').textContent = progress.detail;
  $('table-note').title = '首次只计自己的合法新组合，不能借用桌面上原有的牌。';
  if (progress.ownGroups && (evaluation.valid || evaluation.points > 0)) {
    $('feedback-text').textContent = `开局累计 ${progress.points} 点，${progress.missing ? `还差 ${progress.missing} 点` : '已达到 30 点'}${progress.mirrorNote ? `；${progress.mirrorNote}` : ''}。`;
  }
}

function render() {
  document.body.classList.toggle('rummi-spectator',spectating());
  renderRuleText();
  if(playableRackSignature!==draft.rack.map(tile=>tile.id).sort().join('|') || !['color','number'].includes(sortMode)) {playableRackGroups=[];playableRackSignature='';}
  const deckOptions = meldOptions();
  const availableIds = new Set([...draft.rack, ...draft.board.flat()].map((tile) => tile.id));
  selection = new Set([...selection].filter((id) => availableIds.has(id)));
  draft.board=draft.board.map(meld=>normalizeMeld(meld,deckOptions));
  if(splitKey && !draft.board.some(meld=>groupKey(meld)===splitKey)) splitKey=null;
  renderBoard();
  $('rack').innerHTML = orderedRack().map(tileHTML).join('');
  $('rack-count').textContent = draft.rack.length;
  const poolCount = ROOM_MODE ? roomView?.game?.poolCount || 0 : draft.pool.length;
  $('pool-count').textContent = `牌池 ${poolCount} 张`;
  $('round-label').textContent = `第 ${draft.round} 轮`;
  $('opening-label').textContent = draft.opened ? '已开局 · 可以重组' : '开局 ≥ 30 点';
  $('selection-hint').textContent = selection.size ? `选中 ${selection.size} 张 · 拖到牌架调顺序，或放进组合` : playableRackGroups.length?`前 ${playableRackGroups.length} 组已成组合${playableCanOpen?' · 可选牌出牌':' · 首次还需凑满30点'}`:'拖动手牌调顺序 · 选牌后放到桌面';
  $('return-rack').disabled = selection.size === 0;
  $('undo').disabled = history.length === 0;
  $('restore').disabled = !tilesChanged() && !layoutChanged();
  $('board-arrange').disabled = !canAct();
  $('sort-color').classList.toggle('active', sortMode === 'color');
  $('sort-number').classList.toggle('active', sortMode === 'number');
  const evaluation = evaluateDraft(committed, draft, deckOptions);
  $('commit').disabled = !evaluation.valid;
  $('draw').disabled = committed.pool.length === 0 || committed.rack.length === 0;
  $('feedback').className = 'feedback';
  let message;
  let icon = '○';
  if (committed.rack.length === 0) {
    message = '手牌已经出完了！这次练习完成，可以重新开始。'; icon = '✓';
    $('commit').disabled = true;
    $('feedback').classList.add('valid');
  } else if (evaluation.valid) {
    message = `桌面组合全部合法，本轮打出 ${evaluation.playedIds.length} 张 · ${evaluation.points} 点。`; icon = '✓';
    $('feedback').classList.add('valid');
  } else if (JSON.stringify(draft.board) !== JSON.stringify(committed.board)) {
    message = evaluation.reason;
    $('feedback').classList.add('invalid');
  } else if (!draft.pool.length) {
    message = '牌池已空，可以继续尝试出牌，或重新开始练习。';
  } else {
    message = draft.opened ? JOKER_LESSON && draft.round === 1 ? '试试红7换出鬼牌，再把鬼牌接到蓝色顺子。' : '可以给桌面接牌，也可以重新组合。出牌前，每组都要合法。' : '用三张不同颜色的 10，就能完成第一次出牌。';
  }
  $('feedback-text').textContent = message;
  $('feedback').querySelector('.feedback-icon').textContent = icon;
  $('table-note').textContent = draft.opened ? '桌面可以重组；已提交的牌不能收回手牌。' : '首次出牌先用自己的牌，开局后再重组桌面。';
  renderOpeningProgress(evaluation, deckOptions);
  if (ROOM_MODE) {
    const myTurn = canAct();
    document.body.classList.toggle('rummi-own-turn',myTurn);
    if($('turn-banner')) {
      $('turn-banner').textContent=turnFeedbackMessage(roomView,newSinceOwnTurn.size,{recovered:turnFeedbackState?.recovered});
      $('turn-banner').classList.toggle('your-turn',myTurn);
      $('turn-banner').hidden=!roomView?.game;
    }
    const current = roomView?.players.find(player => player.id === roomView.game?.turnPlayerId);
    if (!myTurn) {
      $('commit').disabled = true; $('draw').disabled = true; $('restore').disabled = true; $('undo').disabled = true; $('return-rack').disabled = true;
      if (roomView?.phase === 'aborted') $('feedback-text').textContent = '这一局已中止，不计输赢；房主可以再开一局。';
      else if (roomView?.phase === 'finished') $('feedback-text').textContent = '这一局已结束，结算结果见上方。';
      else if (roomView?.phase === 'paused') $('feedback-text').textContent = '牌局已暂停，席位和手牌已保存。可以整理手牌，准备好后继续。';
      else if (clockDisplay().expired) $('feedback-text').textContent = '本回合时间已到，正在换人。';
      else if (busy) $('feedback-text').textContent = '正在确认这次操作…';
      else if (connection !== 'online') $('feedback-text').textContent = '正在恢复连接，未提交的整理会保留。';
      else $('feedback-text').textContent = `等 ${current?.name || '朋友'} 出牌，你的手牌只有你能看见。`;
    } else {
      $('draw').textContent = poolCount ? '摸一张' : '过牌';
      $('draw').setAttribute('aria-label',poolCount?'摸一张':'过牌');
      $('draw').disabled = false;
      if (!evaluation.valid && !tilesChanged()) $('feedback-text').textContent = draft.opened ? '轮到你了，接牌或重组后确认。' : '轮到你了，首次出牌用自己的牌凑满 30 点。';
    }
    const paused=roomView?.phase==='paused';
    $('resume-room').hidden=!paused || spectating();
    $('resume-room').disabled=busy || connection!=='online';
    $('draw').hidden=paused || spectating();
    $('commit').hidden=paused || spectating();
    if(spectating()) $('feedback-text').textContent=remotePreview?`${remotePreview.ownerName}正在整理桌面，确认后才正式保存。`:`正在观战 · ${current?.name || '朋友'}的回合。只能查看公共桌面。`;
    if(paused) $('opening-label').textContent='牌局已暂停';
    else if(roomView?.pause?.type==='pause') $('opening-label').textContent=`暂停确认 ${roomView.pause.agreedIds.length}/${roomView.pause.requiredIds.length}`;
  }
  save();
  queueRackFit();
}

function canAct() { return !ROOM_MODE || (!spectating() && accountState().verification==='verified' && !document.hidden && roomView?.phase === 'playing' && roomView.game?.status === 'playing' && roomView.game?.turnPlayerId === roomView.selfId && !clockDisplay().expired && !busy && !leavingRoom && connection === 'online'); }

function safeText(value) { return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]); }

function renderRoomMeta() {
  if (!roomView) return;
  renderRuleText();
  document.body.classList.toggle('in-game',Boolean(roomView.game));
  document.body.classList.toggle('rummi-spectator',spectating());
  $('room-code').textContent = roomView.roomCode;
  const gamePlayers = roomView.game?.players || [];
  $('room-players').innerHTML = orderedRoomPlayers(roomView).map(player => {
    const active = roomView.game?.turnPlayerId === player.id && roomView.phase === 'playing';
    const details = gamePlayers.find(item => item.id === player.id);
    const count = details?.rackCount ?? player.rackCount ?? 0;
    const status = roomView.phase === 'waiting' ? player.ready ? '已准备' : '还没准备' : `${count}张${active ? ' · 出牌中' : ''}`;
    const fullStatus = roomView.phase === 'waiting' ? status : `${count} 张手牌${active ? ' · 正在出牌' : ''}${player.isNext ? ' · 下一位' : ''}`;
    return `<div class="player-seat${player.isNext ? ' next' : ''}${active ? ' current' : ''}${active && player.id===roomView.selfId && turnNoticeUntil>performance.now()?' turn-notice':''}${player.id===roomView.selfId?' self':''}"><span class="player-avatar" aria-hidden="true">${safeText(Array.from(player.name)[0]||'友')}</span>${player.turnOrder?`<span class="player-turn-order" title="第${player.turnOrder}位${player.isNext?' · 下一位':''}" aria-label="第${player.turnOrder}位${player.isNext?'，下一位':''}">${player.turnOrder}${player.isNext?' ›':''}</span>`:''}<strong title="${safeText(player.name)}">${safeText(player.name)}${player.id === roomView.selfId ? ' · 我' : ''}${player.id === roomView.hostId ? ' ♡' : ''}</strong><span title="${safeText(fullStatus)}${player.connected?'':' · 暂时离线'}" aria-label="${safeText(fullStatus)}${player.connected?'':' · 暂时离线'}">${status}${player.connected ? '' : roomView.phase==='waiting'?' · 暂时离线':' · 离线'}</span></div>`;
  }).join('') + (roomView.phase === 'waiting' ? Array.from({length:7-roomView.players.length}, () => '<div class="player-seat empty"><strong>留个座位</strong><span>等待朋友加入</span></div>').join('') : '');
  $('room-waiting').hidden = roomView.phase !== 'waiting';
  $('room-play').hidden = !roomView.game;
  $('room-result').hidden = !['finished','aborted'].includes(roomView.phase);
  const me = roomView.players.find(player => player.id === roomView.selfId);
  $('ready-button').textContent = me?.ready ? '取消准备' : '准备好了';
  $('ready-button').hidden=spectating();$('ready-button').disabled = busy || connection !== 'online';
  if($('role-toggle')) {
    $('role-toggle').hidden=roomView.phase!=='waiting';
    $('role-toggle').textContent=spectating()?'加入牌局':'改为观战';
    $('role-toggle').disabled=busy || connection!=='online';
  }
  if($('spectator-list')) {
    const observers=roomView.spectators || [];
    $('spectator-list').hidden=!observers.length;
    $('spectator-list').textContent=`观战 ${observers.length}/${roomView.spectatorCapacity || 8}：${observers.map(member=>member.name+(member.id===roomView.selfId?'（我）':'')).join('、')}`;
  }
  const host = roomView.selfId === roomView.hostId;
  $('start-room').hidden = !host;
  $('start-room').disabled = busy || connection !== 'online' || roomView.players.length < 2 || !roomView.players.every(player => player.ready);
  $('leave-room').disabled = busy || connection !== 'online';
  const copies = roomView.players.length > 4 ? 3 : 2;
  const totalTiles=copies*52+(roomView.jokerConfig?Object.values(roomView.jokerConfig).reduce((sum,n)=>sum+n,0):copies);
  $('waiting-hint').textContent = `${roomView.players.length} 人已入座 · 本局使用${copies === 3 ? '三' : '两'}副数字牌，共 ${totalTiles} 张。${host ? '大家准备后，由你开始。' : spectating()?'你正在观战，开局前可以加入牌局。':'准备好后等房主开始。'}`;
  renderRoomControls(); renderTurnClock();
  if($('room-activity-dialog').open) renderRoomActivity();
  if (['finished','aborted'].includes(roomView.phase)) {
    const result = roomView.game.result;
    const aborted=roomView.phase==='aborted' || result?.aborted;
    const winners = (result?.winnerIds || []).map(id => roomView.game.players.find(player => player.id === id)?.name || roomView.players.find(player => player.id === id)?.name || result?.scores?.find(score=>score.playerId===id)?.name || '朋友').join('、');
    $('result-title').textContent = aborted?'这一局已中止。':`${winners || '这一局'}${result?.tie ? ' 共同获胜。' : ' 赢了这一局。'}`;
    $('result-reason').textContent = aborted?'有朋友退出房间，本局不计输赢。留下的朋友可以重新开局。':result?.reason === 'blocked' ? '牌池耗尽，所有人连续过牌，按剩余手牌点数结算。' : '手牌全部打出，这一局结束。';
    $('result-scores').innerHTML = aborted?'':(result?.scores || []).map(score => `<div class="result-row"><span>${safeText(score.name)}</span><span>剩余手牌 ${score.points} 点</span></div>`).join('');
    $('rematch').hidden = !host; $('rematch').disabled = busy || connection !== 'online';
  }
}

function renderRoomControls() {
  if(!ROOM_MODE || !roomView) return;
  const live=!busy && !leavingRoom && connection==='online';
  const host=roomView.selfId===roomView.hostId;
  const paused=roomView.phase==='paused';
  const agreed=roomView.pause?.agreedIds?.includes(roomView.selfId);
  $('room-options').disabled=leavingRoom;
  $('pause-room').hidden=roomView.phase!=='playing' || spectating();
  $('pause-room').textContent=agreed?'撤回暂停同意':roomView.pause?'同意暂停':'提议暂停';
  $('pause-room').disabled=!live;
  $('resume-room-menu').hidden=!paused || spectating();$('resume-room-menu').disabled=!live;
  $('take-host').hidden=host || !roomView.hostCanTakeOver || spectating();$('take-host').disabled=!live;
  const others=roomView.players.filter(player=>player.id!==roomView.selfId);
  $('host-transfer-controls').hidden=!host || !others.length;
  const selected=$('next-host').value;
  $('next-host').innerHTML=others.map(player=>`<option value="${safeText(player.id)}">${safeText(player.name)}</option>`).join('');
  if(others.some(player=>player.id===selected)) $('next-host').value=selected;
  $('next-host').disabled=!live;$('transfer-host').disabled=!live || !others.length;
  $('away-room').disabled=leavingRoom;
  $('confirm-leave-room').disabled=!live;
  $('cancel-leave-room').disabled=leavingRoom;$('leave-room-close').disabled=leavingRoom;
  $('leave-room').disabled=!live;
  $('leave-room-explanation').textContent=spectating()?'退出观战，不会中止玩家的牌局。':roomExitExplanation(roomView.phase);
  const expires=new Date(roomView.expiresAt);
  const expiry=typeof roomView.expiresAt==='number' && Number.isFinite(expires.getTime())
    ?`到期：${expires.toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}。`:'';
  const note=paused?'暂停牌局保存7天；任意在席朋友可继续。':roomView.pause?.type==='pause'
    ?`暂停确认 ${roomView.pause.agreedIds.length}/${roomView.pause.requiredIds.length} 人，全部同意后保存7天。`
    :'暂离保留席位；退出房间释放席位。';
  $('room-options-note').textContent=note+(paused?'':'无业务操作8小时后到期。')+expiry;
  renderJokerSettings();
}

function renderRoomActivity() {
  const records=Array.isArray(roomView?.activity)?roomView.activity.filter(item=>item && typeof item.text==='string').toReversed():[];
  const pages=Math.ceil(records.length/8);activityPage=Math.max(0,Math.min(activityPage,pages-1));
  $('room-activity-list').replaceChildren();
  if(!records.length) {
    const item=document.createElement('li');item.className='activity-empty';item.textContent='这一桌还没有新的公开行动。';$('room-activity-list').append(item);
  }
  for(const record of records.slice(activityPage*8,(activityPage+1)*8)) {
    const item=document.createElement('li'),time=document.createElement('time'),text=document.createElement('span');
    const date=new Date(record.at);time.textContent=Number.isFinite(date.getTime())?date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'—';
    text.textContent=record.text;item.append(time,text);$('room-activity-list').append(item);
  }
  $('activity-page').textContent=pages?`${activityPage+1} / ${pages}`:'暂无动态';
  $('activity-prev').disabled=activityPage===0;$('activity-next').disabled=activityPage>=pages-1;
}

function applyRoomView(view) {
  if(view.gameType && view.gameType!=='rummikub') {
    const href=roomHref(view.code || roomCode,view.gameType);
    roomClient?.stop();
    if(typeof location.replace==='function') location.replace(href);else location.href=href;
    return;
  }
  const previousView=roomView,oldGame=previousView?.game;
  if(previousView && (previousView.roomId!==view.roomId || previousView.matchId!==view.matchId
      || previousView.selfId!==view.selfId)) {rackPositions={};rackBasis=null;}
  if(view.selfRole==='spectator' && previousView?.selfRole!=='spectator' || !view.game && oldGame) {
    // A retained member ID is not a retained private hand. Rematch / becoming
    // an observer must erase the former player's local cache and visible DOM.
    try {sessionStorage.removeItem(roomDraftKey(previousView || view));}catch{}
    clearDrag();selection.clear();history=[];rackOrder=[];rackPositions={};rackBasis=null;tablePositions={};committedTablePositions={};tableLayout=null;
    committed={version:1,rack:[],board:[],pool:[],opened:false,round:0};draft=clone(committed);
    playableRackGroups=[];playableRackSignature='';turnFeedbackState=null;newSinceOwnTurn.clear();remotePreview=null;previewPublisher.reset();
    if(inspector.open)inspector.close();$('inspector-tiles').replaceChildren();$('rack').replaceChildren();$('board').replaceChildren();
    $('rack-count').textContent='0';restoredRoomDraft=false;
  }
  if(remotePreview && (remotePreview.roomId!==view.roomId || remotePreview.matchId!==view.matchId || remotePreview.gameRevision!==view.game?.revision || remotePreview.turnPlayerId!==view.game?.turnPlayerId || view.phase!=='playing'))remotePreview=null;
  if(view.game && !turnFeedbackState) {
    try {turnFeedbackState=JSON.parse(sessionStorage.getItem(roomDraftKey(view)) || 'null')?.turnFeedbackState || null;}catch{}
  }
  turnFeedbackState=updateTurnFeedback(turnFeedbackState,view);
  newSinceOwnTurn.clear();for(const id of turnFeedbackState?.newIds || []) newSinceOwnTurn.add(id);
  const phaseCue=audio.phaseCue(previousView,view,{baseline:needsRoomBaseline || document.hidden || connection!=='online'});
  const effects=roomTransition(previousView,view,{baseline:needsRoomBaseline || document.hidden || connection!=='online'});
  observePublicPlacementView(view,{baseline:needsRoomBaseline || document.hidden || connection!=='online'});
  if(!document.hidden) needsRoomBaseline=false;
  const now=performance.now();
  for(const [id,until] of arrivedTileIds) if(until<=now) arrivedTileIds.delete(id);
  for(const id of effects.arrivedIds) arrivedTileIds.set(id,now+550);
  if(effects.turnToSelf) turnNoticeUntil=now+700;
  roomView = view; receiveTurnClock();
  if(previousView && previousView.phase!==view.phase) {
    $('room-menu-status').textContent=view.phase==='paused'?'全部朋友已同意，牌局已暂停并保存。'
      :previousView.phase==='paused' && view.phase==='playing'?'牌局已继续。'
      :view.phase==='aborted'?'本局已中止，不计输赢。':'';
  }
  renderRoomMeta();
  if (!view.game) return;
  const game = view.game;
  // Unseen tiles only describe the public deck's complement, never their owners.
  const ownRack=Array.isArray(game.rack)?game.rack:[],seen = new Set([...ownRack, ...game.board.flat()].map(tile => tile.id));
  const next = { version:1, ruleVersion:game.ruleVersion,...(game.jokerConfig===undefined?{}:{jokerConfig:game.jokerConfig}),rack:ownRack, board:game.board.map(meld=>normalizeMeld(meld,roomRuleOptions(game))), pool:createDeck(roomRuleOptions(game)).filter(tile => !seen.has(tile.id)), opened:spectating()?true:game.opened, round:game.round };
  const abortedNow=previousView?.phase!=='aborted' && view.phase==='aborted';
  const same = oldGame && !abortedNow && JSON.stringify(next) === JSON.stringify(committed);
  if (!same) {
    if(inspector.open) inspector.close();
    const retained=Array.isArray(game.boardPositions)?decodeBoardPositions(next.board,game.boardPositions):oldGame?inheritPositions(committed.board,next.board,{...committedTablePositions,...tablePositions}):{};
    clearDrag(); committed = clone(next); draft = clone(next); selection.clear(); history = []; splitKey=null;
    tablePositions=retained; committedTablePositions=clone(retained); tableLayout=null;
    if (!restoredRoomDraft && !spectating()) {
      restoredRoomDraft = true;
      try {
        const saved = JSON.parse(sessionStorage.getItem(roomDraftKey(view)) || 'null');
        if(Array.isArray(saved?.rackOrder)) rackOrder=saved.rackOrder.filter(id=>typeof id==='string');
        else if(Array.isArray(saved?.rackIds)) rackOrder=saved.rackIds.filter(id=>typeof id==='string');
        rackPositions=(typeof saved?.matchId==='string'?saved.matchId===view.matchId:roomDraftMatches(saved,view))
          ?normalizeRackPositions(saved?.rackPositions,next.rack.map(tile=>tile.id)):{};
        rackBasis=Object.keys(rackPositions).length?normalizeRackBasis(saved?.rackBasis):null;
        if (roomDraftMatches(saved,view) && Array.isArray(saved.rackIds) && Array.isArray(saved.boardIds) && saved.boardIds.every(Array.isArray)) {
          const known = new Map([...next.rack, ...next.board.flat()].map(tile => [tile.id,tile]));
          const ids = [...saved.rackIds,...saved.boardIds.flat()];
          if (ids.length === known.size && new Set(ids).size === known.size && ids.every(id => known.has(id))) {
            const hand = new Set(next.rack.map(tile=>tile.id));
            if (saved.rackIds.every(id=>hand.has(id))) { draft.rack=saved.rackIds.map(id=>known.get(id)); draft.board=saved.boardIds.filter(meld=>meld.length).map(meld=>normalizeMeld(meld.map(id=>known.get(id)),roomRuleOptions(game))); sortMode=saved.sortMode || ''; tablePositions=safePositions(saved.tablePositions); committedTablePositions=safePositions(saved.committedTablePositions); }
          }
        }
      } catch { /* A bad local draft cannot replace the server state. */ }
    }
  }
  if(!same || previousView?.phase!==view.phase) {
    if(same) clearDrag();
    render();
  } else if(roomView.pause?.type==='pause') {
    // A vote/presence snapshot must not replace DOM tiles during a drag.
    $('opening-label').textContent=`暂停确认 ${roomView.pause.agreedIds.length}/${roomView.pause.requiredIds.length}`;
  } else if(roomView.phase==='playing') {
    const progress=spectating()?null:openingProgress(committed,draft,meldOptions());
    $('opening-label').textContent=progress?.label || (draft.opened?'已开局 · 可以重组':'开局 ≥ 30 点');
  }
  if(effects.cue) audio.play(effects.cue);
  else if(phaseCue) audio.play(phaseCue,{gesture:busy});
  if(same)queueLocalPreview();
}

async function roomAction(type, fields = {}) {
  if (busy || leavingRoom || !roomClient) return false;
  const client=roomClient, fence=roomSession.capture(client);
  if(type==='submit')rememberOwnPublicPlacement();
  const current=()=>roomSession.current(fence);
  busy = true; clearDrag(); renderRoomMeta(); if (roomView?.game) render();
  try { await client.action(type, fields); if(!current())return false; if(type==='submit' && roomView?.phase!=='finished') audio.play('commit'); else if(type==='draw') audio.play('draw',{gesture:true}); else if(type==='ready')audio.play(fields.ready?'ready':'undo',{gesture:true});else if(type==='pause' && roomView?.phase!=='paused')audio.play(fields.agree===false?'undo':'ready',{gesture:true}); return true; }
  catch(error) { if(current() && error.name!=='AbortError') {audio.play('invalid',{gesture:true});toast(gameErrorMessage(error));}return false; }
  finally { if(current()) {busy = false; renderRoomMeta(); if (roomView?.game) render();} }
}

function pushHistory() {
  history.push({ draft: clone(draft), sortMode, rackOrder:[...rackOrder], rackPositions:clone(rackPositions), rackBasis:clone(rackBasis), tablePositions:clone(tablePositions) });
  if (history.length > 60) history.shift();
}

function isOpeningPublicTile(id) {
  return !committed.opened && committed.board.flat().some((tile) => tile.id === id);
}

function moveTiles(ids, zone, beforeId = null, point = null) {
  if(zone==='rack' && ids.length && ids.every(id=>draft.rack.some(tile=>tile.id===id))) {
    const order=orderedRack().map(tile=>tile.id);
    const before=beforeId?order.indexOf(beforeId):-1;
    if(point) {if(canAct())pushHistory();positionRackTiles(ids,point);}
    else rackOrder=moveRackTiles(order,ids,before>=0?before:order.length);
    sortMode='manual';selection.clear();audio.play('placement',{gesture:true});render();return;
  }
  if (!canAct()) { toast('现在还没轮到你，等当前玩家完成这一轮。'); return; }
  if (!ids.length) { toast('先选中要移动的牌，也可以直接拖动。'); return; }
  const publicIds = new Set(committed.board.flat().map((tile) => tile.id));
  if (ids.some(isOpeningPublicTile)) { toast('第一次出牌先用自己的手牌，开局后才能重组桌面。'); return; }
  if (zone === 'rack' && ids.some((id) => publicIds.has(id))) { toast('已经提交的桌面牌不能收回手牌。'); return; }
  const lockedJokerMelds = canRearrangeJokers(committed) ? [] : committed.board.filter((meld) => meld.some((tile) => tile.joker));
  if (lockedJokerMelds.some((meld) => meld.some((tile) => ids.includes(tile.id)))) {
    toast('这局沿用旧规则，含鬼牌组合只能整组移动位置。'); return;
  }
  const index = zone !== 'rack' && zone !== 'new' ? Number(zone) : -1;
  if (zone !== 'rack' && zone !== 'new' && (!Number.isInteger(index) || !draft.board[index])) return;
  if (!committed.opened && index >= 0 && draft.board[index].some((tile) => publicIds.has(tile.id))) {
    toast('先用自己的牌组成新组合，凑满 30 点。'); return;
  }
  if (index >= 0 && lockedJokerMelds.some((meld) => meld.some((tile) => draft.board[index].some((current) => current.id === tile.id)))) {
    toast('这局沿用旧规则，含鬼牌组合不能拆分或接牌。'); return;
  }
  const allTiles = new Map([...draft.rack, ...draft.board.flat()].map((tile) => [tile.id, tile]));
  const moved = ids.map((id) => allTiles.get(id)).filter(Boolean);
  if (moved.length !== ids.length) return;
  const oldBoard=clone(draft.board);
  const positions=currentPositions();
  const destinationPoint=index>=0?positions[groupKey(draft.board[index])]:point || (tableLayout?{x:tableLayout.newTarget.logicalX,y:tableLayout.newTarget.logicalY}:null);
  pushHistory();
  const idSet = new Set(ids);
  draft.rack = draft.rack.filter((tile) => !idSet.has(tile.id));
  draft.board = draft.board.map((meld) => meld.filter((tile) => !idSet.has(tile.id)));
  let destination;
  if (zone === 'rack') destination = draft.rack;
  else if (zone === 'new') { draft.board.push([]); destination = draft.board.at(-1); }
  else destination = draft.board[index];
  const before = beforeId ? destination.findIndex((tile) => tile.id === beforeId) : -1;
  destination.splice(before >= 0 ? before : destination.length, 0, ...moved);
  rackPositions=normalizeRackPositions(rackPositions,draft.rack.map(tile=>tile.id));
  if(zone==='rack' && point) positionRackTiles(ids,point);
  draft.board = draft.board.filter((meld) => meld.length);
  const destinationIndex=draft.board.indexOf(destination);
  const autoSplit=zone==='rack'?null:autoSplitDuplicateRun(destination,{committed,draft,meldIndex:destinationIndex,
    insertedIds:ids,beforeId,dropIndex:before>=0?before:destination.length-moved.length,
    copies:roomView?.game?.copies || 2,jokerCount:roomView?.game?.jokerCount || 2,...meldOptions()});
  if(autoSplit) draft.board.splice(destinationIndex,1,...autoSplit.melds);
  draft.board=draft.board.flatMap(meld=>{
    if(meld===destination)return [meld];
    const original=oldBoard.find(group=>group.some(tile=>idSet.has(tile.id)) && group.filter(tile=>!idSet.has(tile.id)).length===meld.length && meld.every(tile=>group.some(old=>old.id===tile.id)));
    return original?splitRunAfterExtraction(original,ids,meldOptions()):[meld];
  });
  draft.board=draft.board.map(meld=>normalizeMeld(meld,meldOptions()));
  tablePositions=inheritPositions(oldBoard,draft.board,positions);
  if(zone!=='rack' && destinationPoint) {
    if(autoSplit) {
      let x=destinationPoint.x;
      for(const meld of autoSplit.melds) {tablePositions[groupKey(meld)]={x,y:destinationPoint.y};x+=Math.max(meld.length*42-4,80)+38;}
    }
    else tablePositions[groupKey(destination)]=destinationPoint;
  }
  selection.clear();
  sortMode = '';
  splitKey=null;
  if(zone!=='rack')rememberOwnPublicPlacement();
  audio.play('placement',{gesture:true});
  if(autoSplit)audio.play('split',{gesture:true});
  else if(index>=0 && oldBoard.some((group,sourceIndex)=>sourceIndex!==index && group.some(tile=>ids.includes(tile.id))))audio.play('merge',{gesture:true});
  render();
  if(autoSplit) toast(`已自动拆成 ${autoSplit.melds.length} 组合法组合；确认出牌后才保存。`);
  requestAnimationFrame(() => document.querySelector(`[data-tile="${moved[0].id}"]`)?.focus({ preventScroll: true }));
}

function splitMeld(index, offset) {
  const meld=draft.board[index];
  if(!canAct() || !meld || !Number.isInteger(offset) || offset<=0 || offset>=meld.length) return;
  const publicIds=new Set(committed.board.flat().map(tile=>tile.id));
  if(!committed.opened && meld.some(tile=>publicIds.has(tile.id))) {toast('开局后才能拆分公共组合。');return;}
  if(!canRearrangeJokers(committed) && committed.board.some(original=>original.some(tile=>tile.joker) && original.some(tile=>meld.some(current=>current.id===tile.id)))) {toast('这局沿用旧规则，含鬼牌组合不能拆分。');return;}
  const oldBoard=clone(draft.board),positions=currentPositions(),anchor=positions[groupKey(meld)]||{x:0,y:0};
  pushHistory();
  const left=meld.slice(0,offset),right=meld.slice(offset);
  draft.board.splice(index,1,left,right);
  tablePositions=inheritPositions(oldBoard,draft.board,positions);
  tablePositions[groupKey(left)]={...anchor};
  tablePositions[groupKey(right)]={x:anchor.x+Math.max(42*left.length-4,80)+38,y:anchor.y};
  splitKey=null;selection.clear();sortMode='';render();
  toast('已拆成两组，可以继续接牌或重组。');
  audio.play('split',{gesture:true});
}

function groupPlacement(current,x,y) {
  const canvas=$('board').querySelector('.table-canvas');
  const rect=canvas.getBoundingClientRect();
  const source=tableLayout?.positions.find(point=>point.id===current.key);
  if(!source) return null;
  return placeGroup({width:source.width,height:source.height},{x:x-rect.left-current.offsetX,y:y-rect.top-current.offsetY},tableLayout.positions.filter(point=>point.id!==current.key),{width:rect.width,height:rect.height,gap:38*tableLayout.scale});
}

function moveGroup(current,x,y,target) {
  if(!canAct()) return;
  const index=draft.board.findIndex(meld=>groupKey(meld)===current.key);
  if(index<0) return;
  const destination=target?.closest('.meld[data-group-key]');
  if(destination && destination.dataset.groupKey!==current.key) {
    const tile=target.closest('[data-tile]');
    moveTiles(draft.board[index].map(item=>item.id),destination.dataset.zone,tile?.dataset.tile || null);
    return;
  }
  if(!target?.closest('#board')) return;
  const point=groupPlacement(current,x,y);
  if(!point) return;
  pushHistory();tablePositions=currentPositions();
  tablePositions[current.key]={x:(point.x-(tableLayout.displayOffsetX || 0))/tableLayout.scale,y:(point.y-(tableLayout.displayOffsetY || 0))/tableLayout.scale};
  selection.clear();splitKey=null;render();
  audio.play('placement',{gesture:true});
}

function toggleTile(id) {
  const inRack=draft.rack.some(tile=>tile.id===id);
  if (!canAct() && !inRack) return;
  if (isOpeningPublicTile(id)) { toast('开局后，才可以移动公共桌面的牌。'); return; }
  if (selection.has(id)) selection.delete(id); else selection.add(id);
  audio.play('select',{gesture:true});
  if(inRack && selection.has(id) && Object.keys(rackPositions).length) {
    const positions=currentRackLayout().positions;
    positions[id]={...positions[id],z:Object.keys(positions).length};
    rackPositions=normalizeRackPositions(positions,draft.rack.map(tile=>tile.id));
  }
  render();
  requestAnimationFrame(() => document.querySelector(`[data-tile="${id}"]`)?.focus({ preventScroll: true }));
}

// Image errors do not bubble. Capture them for rack, table, inspectors and
// transient drag copies; keep the tile's type readable without changing play.
document.addEventListener('error', (event) => {
  const image=event.target;
  if(image?.classList?.contains('joker-art'))image.closest('.joker-face')?.classList.add('joker-load-failed');
}, true);

document.addEventListener('click', (event) => {
  if (suppressClick) { suppressClick = false; return; }
  const cut=event.target.closest('[data-cut]');
  if(cut) {splitMeld(Number(cut.dataset.meld),Number(cut.dataset.cut));return;}
  const split=event.target.closest('[data-split]');
  if(split) {
    if(!canAct()) return;
    const meld=draft.board[Number(split.dataset.split)];
    if(!meld) return;
    splitKey=splitKey===groupKey(meld)?null:groupKey(meld);
    selection.clear();render();return;
  }
  const tile = event.target.closest('[data-tile]');
  if (tile) { toggleTile(tile.dataset.tile); return; }
  const place = event.target.closest('[data-place]');
  if (place) {
    if(place.hasAttribute('data-group') && !selection.size) {
      const meld=draft.board[Number(place.dataset.group)];
      if(!canAct() || !meld) return;
      if(meld.some(tile=>isOpeningPublicTile(tile.id))) {toast('拖动标题可以整理位置，开局后才能重组公共牌。');return;}
      selection=new Set(meld.map(tile=>tile.id));splitKey=null;render();return;
    }
    moveTiles([...selection], place.dataset.place); return;
  }
  if (event.target === $('rack') && selection.size) {
    const rect=$('rack').getBoundingClientRect(),style=getComputedStyle($('rack'));
    moveTiles([...selection], 'rack', null,{rackX:event.clientX-rect.left-(parseFloat(style.paddingLeft)||0),
      rackY:event.clientY-rect.top-(parseFloat(style.paddingTop)||0)});
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  const handle=event.target.closest('[data-group]');
  if(handle && canAct()) {
    const index=Number(handle.dataset.group),meld=draft.board[index],element=handle.closest('.meld');
    if(!meld || !element) return;
    const rect=element.getBoundingClientRect();
    drag={type:'group',key:groupKey(meld),element:handle,groupElement:element,x:event.clientX,y:event.clientY,offsetX:event.clientX-rect.left,offsetY:event.clientY-rect.top,pointerId:event.pointerId,active:false};
    handle.setPointerCapture(event.pointerId);return;
  }
  const tile = event.target.closest('[data-tile]');
  if (!tile || isOpeningPublicTile(tile.dataset.tile) || (!canAct() && !tile.closest('#rack'))) return;
  const rect=tile.getBoundingClientRect();
  drag = { type:'tile', id: tile.dataset.tile, element: tile, x: event.clientX, y: event.clientY,
    grabX:event.clientX-rect.left,grabY:event.clientY-rect.top,pointerId: event.pointerId, active: false };
  tile.setPointerCapture(event.pointerId);
});

function clearDrag() {
  if (autoScrollFrame !== null) cancelAnimationFrame(autoScrollFrame);
  autoScrollFrame = null;
  if (drag?.element.isConnected) drag.element.classList.remove('dragging');
  drag?.groupElement?.classList.remove('group-dragging');
  if (drag?.element.hasPointerCapture?.(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
  ghost?.remove(); ghost = null;
  dropHighlight?.classList.remove('drop-active','merge-active'); dropHighlight = null;
  groupDropPreview?.remove();groupDropPreview=null;
  drag = null;
  queueBoardFit();
  queueRackFit();
}

function highlightDrop(x, y) {
  const under=document.elementFromPoint(x,y);
  let target=under?.closest('[data-zone]');
  if(drag?.type==='group') {
    target=under?.closest('.meld[data-group-key]');
    if(target?.dataset.groupKey===drag.key) target=null;
  }
  if (target !== dropHighlight) { dropHighlight?.classList.remove('drop-active','merge-active'); dropHighlight = target; dropHighlight?.classList.add(drag?.type==='group'?'merge-active':'drop-active'); }
  if(drag?.type==='group') {
    if(target || !under?.closest('#board')) {groupDropPreview?.remove();groupDropPreview=null;return;}
    const point=groupPlacement(drag,x,y);
    if(!point) return;
    if(!groupDropPreview) {groupDropPreview=document.createElement('div');groupDropPreview.className='group-drop-preview';$('board').querySelector('.table-canvas').append(groupDropPreview);}
    Object.assign(groupDropPreview.style,{left:`${point.x/tableLayout.canvasScale}px`,top:`${point.y/tableLayout.canvasScale}px`,width:`${point.width/tableLayout.canvasScale}px`,height:`${point.height/tableLayout.canvasScale}px`});
  }
}

function scrollDuringDrag() {
  if (!drag?.active) return;
  const { currentX: x, currentY: y } = drag;
  highlightDrop(x, y);
  autoScrollFrame = requestAnimationFrame(scrollDuringDrag);
}

document.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 7) return;
  event.preventDefault();
  if (!drag.active) {
    drag.active = true;
    drag.currentX = event.clientX; drag.currentY = event.clientY;
    autoScrollFrame = requestAnimationFrame(scrollDuringDrag);
    if(drag.type==='group') {
      ghost=document.createElement('div');ghost.className='board auto-fit group-drag-ghost';ghost.setAttribute('aria-hidden','true');ghost.setAttribute('inert','');
      ghost.style.setProperty('--board-scale',tableLayout.scale);
      if(tableLayout.scale<0.7) ghost.classList.add('board-overview');
      const copy=drag.groupElement.cloneNode(true);
      copy.style.left='0px';copy.style.top='0px';
      for(const node of [copy,...copy.querySelectorAll('*')]) {
        for(const name of [...node.attributes].map(item=>item.name)) {
          const presentation=node.classList.contains('tile') && (name==='data-color' || name==='data-joker-type');
          if(name==='id' || (name.startsWith('data-') && !presentation)) node.removeAttribute(name);
        }
      }
      copy.querySelector('.split-group')?.remove();ghost.append(copy);document.querySelector('.shell').append(ghost);
      drag.groupElement.classList.add('group-dragging');
    } else {
      ghost = drag.element.cloneNode(true);
      ghost.removeAttribute('data-tile'); ghost.removeAttribute('aria-pressed'); ghost.setAttribute('aria-hidden', 'true');ghost.setAttribute('inert','');
      ghost.style.position='fixed';
      ghost.className = `${drag.element.className} drag-ghost`;
      document.body.append(ghost);
      drag.element.classList.add('dragging');
    }
  }
  drag.currentX = event.clientX; drag.currentY = event.clientY;
  ghost.style.left = `${event.clientX-(drag.type==='group'?drag.offsetX:0)}px`; ghost.style.top = `${event.clientY-(drag.type==='group'?drag.offsetY:0)}px`;
  highlightDrop(event.clientX, event.clientY);
}, { passive: false });

document.addEventListener('pointerup', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const current = drag;
  if (current.active) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const zone = target?.closest('[data-zone]');
    const targetTile = target?.closest('[data-tile]');
    clearDrag();
    if(current.type==='group') {moveGroup(current,event.clientX,event.clientY,target);return;}
    if (zone) {
      const ids = selection.has(current.id) ? [...selection] : [current.id];
      const beforeId = targetTile && !ids.includes(targetTile.dataset.tile) ? targetTile.dataset.tile : null;
      const rect=$('rack').getBoundingClientRect(),style=getComputedStyle($('rack'));
      const point=zone.dataset.zone==='rack'?{rackX:event.clientX-rect.left-(parseFloat(style.paddingLeft)||0),
        rackY:event.clientY-rect.top-(parseFloat(style.paddingTop)||0),grabX:current.grabX,
        grabY:current.grabY,anchorId:current.id}:null;
      moveTiles(ids, zone.dataset.zone, beforeId,point);
    } else if(target?.closest('#board')) {
      const canvas=$('board').querySelector('.table-canvas').getBoundingClientRect();
      const ids=selection.has(current.id)?[...selection]:[current.id];
      moveTiles(ids,'new',null,{x:Math.max(0,(event.clientX-canvas.left-(tableLayout.displayOffsetX || 0))/tableLayout.scale-19),y:Math.max(0,(event.clientY-canvas.top-(tableLayout.displayOffsetY || 0))/tableLayout.scale-27)});
    }
  } else clearDrag();
});
document.addEventListener('pointercancel', clearDrag);
window.addEventListener('blur', clearDrag);
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearDrag(); save(); } });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { clearDrag(); selection.clear(); splitKey=null; render(); }
});

$('return-rack').addEventListener('click', () => moveTiles([...selection], 'rack'));
$('undo').addEventListener('click', () => {
  const previous = history.pop();
  if (!previous) return;
  draft = previous.draft; rackOrder=previous.rackOrder || rackOrder; rackPositions=previous.rackPositions || {};rackBasis=previous.rackBasis || null;sortMode = previous.sortMode; tablePositions=previous.tablePositions || {};selection.clear();splitKey=null;render();
  audio.play('undo',{gesture:true});
});
$('restore').addEventListener('click', () => {
  pushHistory(); draft = clone(committed); tablePositions=clone(committedTablePositions);selection.clear(); splitKey=null;sortMode = ''; render();
  toast('已还原到本轮开始，可以重新整理。');
  audio.play('restore',{gesture:true});
});
$('board-arrange').addEventListener('click',()=>{
  if(!canAct()) return;
  clearDrag();pushHistory();
  // An explicit arrange is an edit. Save this arrangement immediately so a
  // later local rotation cannot silently publish a different automatic layout.
  tablePositions=boardLayoutPositions(fittedBoard(draft.board,{}),{display:true});
  selection.clear();splitKey=null;render();
  audio.play('sort',{gesture:true});
});
$('sort-color').addEventListener('click', () => {
  arrangePlayableRack('color');
});
$('sort-number').addEventListener('click', () => {
  arrangePlayableRack('number');
});
function arrangePlayableRack(mode) {
  const result=sortPlayableRack(orderedRack(),{opened:committed.opened,mode,...meldOptions(),ruleVersion:committed.ruleVersion});
  rackOrder=result.orderIds;rackPositions={};rackBasis=null;sortMode=mode;playableRackGroups=result.melds.map(meld=>meld.tiles);playableCanOpen=committed.opened || result.canOpen;
  playableRackSignature=draft.rack.map(tile=>tile.id).sort().join('|');render();
  audio.play('sort',{gesture:true});
  toast(result.melds.length?`已把 ${result.melds.length} 组手牌组合放在前面${playableCanOpen?'':'，首次出牌尚未满30点'}。`:'未找到完整组合，已按顺序整理。');
}
$('commit').addEventListener('click', () => {
  if (ROOM_MODE) { if (canAct()) roomAction('submit', { boardIds:draft.board.map(meld=>meld.map(tile=>tile.id)), rackIds:draft.rack.map(tile=>tile.id),boardPositions:captureBoardPositions() }); return; }
  const result = commitDraft(committed, draft);
  if (!result.ok) { audio.play('invalid',{gesture:true});toast(result.error); return; }
  const opening = !committed.opened;
  committed = result.state; draft = clone(committed); committedTablePositions=clone(tablePositions);history = []; selection.clear();splitKey=null;render();
  audio.play(committed.rack.length?'commit':'win',{gesture:true});
  toast(committed.rack.length ? opening ? '开局成功！现在可以接牌和重组桌面。' : '出牌成功，继续下一轮练习。' : '手牌出完了，这次练习完成！');
});
$('draw').addEventListener('click', () => {
  if (ROOM_MODE) { if (canAct()) roomAction(roomView.game.poolCount ? 'draw' : 'pass',{boardPositions:captureCommittedBoardPositions()}); return; }
  const hadDraft = JSON.stringify(draft.board) !== JSON.stringify(committed.board);
  const result = drawTile(committed);
  if (!result.ok) { toast(result.error); return; }
  committed = result.state; draft = clone(committed); tablePositions=clone(committedTablePositions);history = []; selection.clear(); splitKey=null;sortMode = ''; render();
  audio.play('draw',{gesture:true});
  toast(hadDraft ? '已还原未提交的整理，并摸了一张牌，进入下一轮。' : '摸了一张牌，进入下一轮练习。');
});
$('show-rules').addEventListener('click', () => { clearDrag(); $('rules-dialog').showModal(); });
for (const id of ['close-rules', 'start-playing']) $(id).addEventListener('click', () => $('rules-dialog').close());
$('restart').addEventListener('click', () => $('restart-dialog').showModal());
$('cancel-restart').addEventListener('click', () => $('restart-dialog').close());
$('confirm-restart').addEventListener('click', () => {
  committed = newPracticeState(); draft = clone(committed); rackOrder=[];rackPositions={};rackBasis=null;tablePositions={};committedTablePositions={};tableLayout=null;history = []; selection.clear(); splitKey=null;sortMode = ''; clearDrag(); render();
  $('restart-dialog').close(); toast(JOKER_LESSON ? '已摆好鬼牌练习，试试用红7换出鬼牌。' : '已经重新发好牌。试着先出三张 10。');
  audio.play('start',{gesture:true});
});

function clearRoomPrivate(error = {}, {preserveDraft=error.status===503} = {}) {
  roomSession.invalidate();
  if(inspector.open) inspector.close();$('inspector-tiles').replaceChildren();
  for(const id of ['room-options-dialog','leave-room-dialog','room-activity-dialog','joker-settings-dialog']) if($(id)?.open) $(id).close();
  jokerSettingsSignature=null;
  if(roomView && preserveDraft) save();
  if(roomView && !preserveDraft) { try {sessionStorage.removeItem(roomDraftKey(roomView));} catch {} }
  roomChat?.clear({preserveDraft});
  previewPublisher.reset();remotePreview=null;
  if($('preview-status')) {$('preview-status').hidden=true;$('preview-status').textContent='';}
  roomClient?.stop();roomView=null;roomClient=null;connection='offline';busy=false;restoredRoomDraft=false; resetTurnClock();
  clearDrag();selection.clear();history=[];committed={version:1,rack:[],board:[],pool:[],opened:false,round:0};draft=clone(committed);
  tablePositions={};committedTablePositions={};tableLayout=null;splitKey=null;rackOrder=[];rackPositions={};rackBasis=null;rackLayout=null;playableRackGroups=[];playableRackSignature='';
  leavingRoom=false;roomExit.reset();needsRoomBaseline=true;publicPlacementSound=null;needsPublicPlacementBaseline=true;arrivedTileIds.clear();turnNoticeUntil=0;turnFeedbackState=null;newSinceOwnTurn.clear();
  document.body.classList.remove('in-game','rummi-own-turn','rummi-spectator');
  if($('turn-banner')) {$('turn-banner').hidden=true;$('turn-banner').textContent='';}
  for(const id of ['board','rack','room-players','result-scores']) $(id).replaceChildren();
  if($('spectator-list')) {$('spectator-list').textContent='';$('spectator-list').hidden=true;}
  $('rack-count').textContent='0';$('board-count').textContent='0 张牌';$('result-title').textContent='';$('result-reason').textContent='';
  $('room-play').hidden=true;$('room-result').hidden=true;$('room-waiting').hidden=false;
  $('ready-button').disabled=true;$('start-room').hidden=true;$('leave-room').disabled=true;$('rematch').hidden=true;
  $('room-options').disabled=true;$('next-host').replaceChildren();$('host-transfer-controls').hidden=true;
  $('room-activity-list').replaceChildren();activityPage=0;
  $('room-menu-status').textContent='';$('leave-room-status').textContent='';
  $('pause-room').hidden=true;$('resume-room-menu').hidden=true;$('take-host').hidden=true;
  $('room-options-note').textContent='暂离保留席位；退出房间会释放席位。';
  $('connection-label').textContent='等待恢复';$('waiting-hint').textContent=error.status===401 && lastVerifiedSessionExpiresAt && Date.now()>=lastVerifiedSessionExpiresAt?'本次登录已到期。重新登录即可回到原房间，座位和已确认牌面都保留。':error.status?gameErrorMessage(error):error.message || '正在确认登录状态…';
  const recover=$('room-account-recover');recover.hidden=!error.status;
  recover.href=error.status===401?loginHref(`/room.html?code=${roomCode}`):error.status===404?'./':location.href;
  recover.textContent=error.status===401?'登录并恢复房间 →':error.status===404?'回到大厅 →':'重新连接 →';
  const reauth=reauthenticationHref();
  $('room-account-reauth').hidden=error.status!==401 || !reauth;
  $('room-account-reauth').href=reauth || '#';
  $('room-account-reauth-note').hidden=$('room-account-reauth').hidden;
}
function bootRoom(verifiedState) {
  return roomSession.bootstrap(() => clearRoomPrivate({}, {preserveDraft:true}), async task => {
    try {
      const state = verifiedState || await loadAccount();
      if (!roomSession.current(task, {account:false, verified:false}) || state.verification !== 'verified') return;
      if (!/^\d{6}$/.test(roomCode)) { location.replace('./'); return; }
      const legacy = state.mode === 'legacy';
      if (!legacy && !state.authenticated) {
        if (state.failureStatus === 503 || loginFailure === 'unavailable' || !state.loginReady) {
          clearRoomPrivate({status:503,message:'暂时无法确认登录状态，请稍后重试。'}); return;
        }
        clearRoomPrivate({status:401,message:loginFailure === 'verify' ? '登录尚未通过账号核验。可先重新验证账号，再返回恢复房间。' : '请登录棋牌室后恢复原房间。'}); return;
      }
      const accountFence = roomSession.capture();
      roomAccountUserKey = state.userKey || null; lastVerifiedSessionExpiresAt = state.expiresAt || null;
      let membership = legacy ? loadMembership(roomCode) : null, firstView = null;
      if (!legacy) {
        try {
          firstView = (await api(`/api/rooms/${roomCode}`, {signal:task.controller.signal})).view;
          membership = {roomCode,playerId:firstView.selfId,userKey:state.userKey};
        } catch (error) {
          if (!roomSession.current(accountFence)) return;
          if ([403,404].includes(error.status)) { location.replace(`./?room=${roomCode}`); return; }
          throw error;
        }
      }
      if (!roomSession.current(accountFence)) return;
      if (!membership) { location.replace(`./?room=${roomCode}`); return; }
      $('room-account-recover').hidden = true; $('room-account-logout').hidden = legacy;
      const client = new RoomClient(roomCode, membership, {
        onView: view => { if (roomSession.current(clientFence)) applyRoomView(view); },
        onConnection: state => {
          if (!roomSession.current(clientFence)) return;
          if (state !== 'online') { needsRoomBaseline=true; publicPlacementSound=null; needsPublicPlacementBaseline=true; }
          if (drag) clearDrag();
          connection=state; roomChat?.connection(state);
          $('connection-label').textContent=(state==='online'?'已连接':state==='offline'?'重连中':'连接中')+' · '+roomCode;
          renderRoomMeta(); if (roomView?.game) render();
        },
        onChat: packet => { if (roomSession.current(clientFence)) roomChat?.receive(packet); },
        onPreview: packet => { if (roomSession.current(clientFence)) receiveRemotePreview(packet); },
        onError: error => {
          if (!roomSession.current(clientFence)) return;
          // A successful leave closes our own stream before its HTTP acknowledgement may arrive.
          if (leavingRoom && error.status===404) return;
          if (error.status===404 && roomView) forgetMembership(roomCode,roomView.selfId);
          if (error.status===404 || !legacy && [401,503].includes(error.status)) clearRoomPrivate(error);
          else { toast(gameErrorMessage(error)); $('waiting-hint').textContent=gameErrorMessage(error); }
        },
      });
      roomClient = client;
      const clientFence = roomSession.capture(client);
      if (firstView) client.receive(firstView); else await client.refresh();
      if (roomSession.current(clientFence)) {
        roomChat.attach(client,client.view,state); client.connect();
        if (client.view && loginFailure==='account' && !loginConflictNotified) {
          loginConflictNotified=true; toast('当前棋牌账号与原席位保持。请先退出棋牌室，再切换账号。');
        }
      }
    } catch (error) {
      if (!roomSession.current(task, {verified:false})) return;
      clearRoomPrivate(error); toast(gameErrorMessage(error));
    }
  });
}

if (ROOM_MODE) {
  roomChat=mountRoomChat({onCue:kind=>audio.play(kind),onUnavailable:error=>clearRoomPrivate(error.status===403?{...error,status:404,message:error.message}:error)});
  onAccountChange(()=>{
    const state=accountState();
    if(!state.authenticated && state.mode!=='legacy' || roomClient && roomClient.accountEpoch!==accountGeneration()) {
      const preserveDraft=state.failureStatus===503 || state.authenticated && state.userKey===roomAccountUserKey;
      clearRoomPrivate({status:state.failureStatus===503?503:401,message:state.failureStatus===503?'暂时无法确认登录状态，请稍后重试。':'登录状态已改变，请恢复连接。'},{preserveDraft});
    }
  });
  const accountLifecycle=watchAccountLifecycle({
    onSuspend:()=>{clearRoomPrivate({message:'正在重新核验账号…'},{preserveDraft:true});},
    onVerified:state=>{if(!roomClient) bootRoom(state);},
    onError:error=>{clearRoomPrivate(error);},
  });
  accountLifecycle.refresh();
  $('room-account-recover').addEventListener('click',event=>{
    if($('room-account-recover').textContent==='重新连接 →') {event.preventDefault();accountLifecycle.refresh();}
  });
  $('room-account-logout').addEventListener('click',async()=>{
    clearRoomPrivate();
    try {await logoutAccount();location.href='./';}catch(error) {clearRoomPrivate({status:503,message:gameErrorMessage(error)});toast(gameErrorMessage(error));}
  });
  $('ready-button').addEventListener('click',()=>{if(roomView && connection==='online') roomAction('ready',{ready:!roomView.players.find(player=>player.id===roomView.selfId)?.ready});});
  $('role-toggle')?.addEventListener('click',()=>{if(roomView && connection==='online')roomAction('set-role',{role:spectating()?'player':'spectator'});});
  $('joker-settings-open')?.addEventListener('click',()=>{$('room-options-dialog').close();renderJokerSettings({force:true});$('joker-settings-dialog').showModal();});
  $('joker-settings-close')?.addEventListener('click',()=>$('joker-settings-dialog').close());
  for(const id of Object.values(JOKER_FIELDS))$(id)?.addEventListener('input',()=>renderJokerSettings());
  $('joker-config-form')?.addEventListener('submit',async event=>{
    event.preventDefault();if(!roomView || roomView.phase!=='waiting' || roomView.selfId!==roomView.hostId || $('joker-config-apply').disabled)return;
    const jokerConfig=Object.fromEntries(Object.entries(JOKER_FIELDS).map(([key,id])=>[key,Number($(id).value)]));
    if(await roomAction('configure',{jokerConfig})) {toast('鬼牌设置已保存，大家需要重新准备。');$('joker-settings-dialog').close();}
  });
  $('start-room').addEventListener('click',()=>roomAction('start'));
  $('rematch').addEventListener('click',()=>{restoredRoomDraft=false;roomAction('rematch');});
  $('room-options').addEventListener('click',()=>{clearDrag();renderRoomControls();$('room-menu-status').textContent='';$('room-options-dialog').showModal();});
  $('room-options-close').addEventListener('click',()=>$('room-options-dialog').close());
  $('show-room-activity').addEventListener('click',()=>{$('room-options-dialog').close();activityPage=0;renderRoomActivity();$('room-activity-dialog').showModal();});
  $('room-activity-close').addEventListener('click',()=>$('room-activity-dialog').close());
  for(const [id,direction] of [['activity-prev',-1],['activity-next',1]]) $(id).addEventListener('click',()=>{activityPage+=direction;renderRoomActivity();});
  $('away-room').addEventListener('click',()=>{save();location.href='./';});
  $('pause-room').addEventListener('click',async()=>{
    const agree=!roomView?.pause?.agreedIds?.includes(roomView?.selfId);
    if(await roomAction('pause',{agree})) $('room-menu-status').textContent=roomView?.phase==='paused'?'已保存牌局，准备好后继续。':agree?'已同意暂停，等待其他朋友确认。':'已撤回暂停同意。';
  });
  const resumeRoom=async()=>{if(await roomAction('resume')) $('room-options-dialog').close();};
  $('resume-room').addEventListener('click',resumeRoom);$('resume-room-menu').addEventListener('click',resumeRoom);
  $('transfer-host').addEventListener('click',async()=>{if(await roomAction('transferHost',{playerId:$('next-host').value})) $('room-menu-status').textContent='房主已转交。';});
  $('take-host').addEventListener('click',async()=>{if(await roomAction('transferHost',{playerId:roomView?.selfId})) $('room-menu-status').textContent='你已接任房主。';});
  $('leave-room').addEventListener('click',()=>{
    if(busy || leavingRoom || !roomView || connection!=='online') return;
    clearDrag();renderRoomControls();$('leave-room-status').textContent='';$('leave-room-dialog').showModal();
  });
  for(const id of ['cancel-leave-room','leave-room-close']) $(id).addEventListener('click',()=>{if(!leavingRoom) $('leave-room-dialog').close();});
  $('leave-room-dialog').addEventListener('cancel',event=>{if(leavingRoom) event.preventDefault();});
  $('confirm-leave-room').addEventListener('click',()=>{
    if (busy || leavingRoom || !roomView || connection!=='online') return;
    roomExit.run();
  });
  $('copy-invite').addEventListener('click',async()=>{
    const invitation=new URL(`./?room=${roomCode}`,location.href).href;
    try {await navigator.clipboard.writeText(invitation);toast('邀请链接已复制，房间号 '+roomCode+'。');}catch {toast('房间号 '+roomCode+'，可以直接告诉朋友。');}
  });
} else {
  $('lesson-basic').setAttribute('aria-current', JOKER_LESSON ? 'false' : 'page');
  $('lesson-joker').setAttribute('aria-current', JOKER_LESSON ? 'page' : 'false');
  if (JOKER_LESSON) $('practice-description').textContent = '用红7补齐红色顺子，把鬼牌接进蓝色顺子，再确认出牌。';
  restoreSaved(); render();
}
