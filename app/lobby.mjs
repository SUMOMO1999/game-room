import { api, normalizeCode, rememberMembership, recentSeats, forgetMembership } from './room-client.mjs';
import { loadAccount, accountState, accountGeneration, onAccountChange, logoutAccount, watchAccountLifecycle, reauthenticationHref } from './account-client.mjs';
import { roomPhaseLabel, exitConsequence, createExitRequest, historyOutcome, historyPoints } from './lobby-model.mjs';
import { gamePath } from './entry-path.mjs';
import { gameName, roomHref, gameDetails } from './game-routing.mjs';
import { gamePresentation, gamePresentations } from './games/catalog.mjs';
const $=id=>document.getElementById(id);
const raw=new URLSearchParams(location.search).get('room');
const incoming=/^\d{6}$/.test(raw || '')?raw:'';
if(incoming) $('join-code').value=incoming;
const loginFailure=new URLSearchParams(location.search).get('login');
if(loginFailure==='retry') notice('登录未完成或链接已过期，请重新登录。');
else if(loginFailure==='verify') notice('登录尚未通过账号核验。可先重新验证账号，再返回登录棋牌室。');
else if(loginFailure==='unavailable') notice('登录服务暂时不可用，请稍后重试。');
else if(loginFailure==='account') notice('登录账号与当前棋牌账号不同。请先退出棋牌室，再切换账号。');
const returnTo=incoming?`/?room=${incoming}`:'/';
$('account-login').href=gamePath(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
function notice(message) { $('lobby-notice').textContent=message;$('lobby-notice').hidden=false; }
function go(seat) { location.href=roomHref(seat.roomCode,seat.view?.gameType || seat.gameType); }
function historyScore(item,points) {const kind=gamePresentation(item.game).scoreKind;return kind==='outcome'?'仅记录胜负':kind==='score'?(Number.isSafeInteger(points)?`${points} 分`:'本局未计分'):historyPoints(points);}
let renderedGeneration=-1;
let exitState=null;
let historySequence=0,historyCursor=null,historyLoading=false,historyRefreshQueued=false;
let invitationCheckedGeneration=-1;
const historySeen=new Set();
const privateRequests=new Set(),entrySubmissions=new Map();
let entrySubmissionSequence=0;
let privateReady=false,privateEpoch=0;
const privateLive=(generation,epoch)=>privateReady && !document.hidden && generation===accountGeneration() && epoch===privateEpoch;
async function privateApi(path,options={}) {
  const controller=new AbortController();privateRequests.add(controller);
  try {return await api(path,{...options,signal:controller.signal});}
  finally {privateRequests.delete(controller);}
}
function cancelPrivateWork() {
  for(const controller of privateRequests) controller.abort();
  privateRequests.clear();
  for(const submission of entrySubmissions.values()) submission.button.disabled=false;
  entrySubmissions.clear();
  // A cancelled response may follow a committed write. Keep the original
  // fingerprint/requestId; restoration only reads state and recent rooms.
}
function concealLobby() {
  privateReady=false;privateEpoch++;
  cancelPrivateWork();
  $('lobby-forms').hidden=true;$('recent-list').replaceChildren();$('recent-section').hidden=true;
  $('create-name').value='';$('join-name').value='';clearHistory();exitState=null;
  if($('lobby-exit-dialog').open) $('lobby-exit-dialog').close();
  $('lobby-exit-title').textContent='';$('lobby-exit-description').textContent='';$('lobby-exit-status').textContent='';
}
function suspendLobby() {
  concealLobby();$('account-panel').hidden=false;
  $('account-heading').textContent='正在重新核验账号…';$('account-description').textContent='核验完成后再恢复你的房间。';
  for(const id of ['account-login','account-reauth','account-logout','account-retry']) $(id).hidden=true;
}
async function checkIncomingInvitation() {
  if(!privateReady || !incoming || accountState().mode==='legacy' || !accountState().authenticated) return;
  const generation=accountGeneration(),epoch=privateEpoch;
  if(invitationCheckedGeneration===generation) return;
  invitationCheckedGeneration=generation;
  try {await privateApi(`/api/rooms/${incoming}`);}
  catch(error) {
    if(!privateLive(generation,epoch)) return;
    if(error.status===404) {
      notice(`邀请的房间 ${incoming} 已关闭或到期，请向朋友获取新的房间号。`);
      if($('join-code').value===incoming) $('join-code').value='';
    } else if(error.status===503) {invitationCheckedGeneration=-1;notice('暂时无法核对邀请房间，请稍后重试。');}
  }
}
function dateText(value) {
  return Number.isFinite(value) && value>0 ? new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(value) : '';
}
function clearHistory() {
  historySequence++;historyLoading=false;historyRefreshQueued=false;historyCursor=null;historySeen.clear();
  $('history-list').replaceChildren();$('history-stats').textContent='';$('history-section').hidden=true;
  $('history-more').hidden=true;$('history-status').textContent='';
}
function renderExit() {
  if(!exitState) return;
  $('lobby-exit-title').textContent=`退出房间 ${exitState.seat.roomCode}？`;
  $('lobby-exit-description').textContent=exitConsequence(exitState.view.phase,{role:exitState.view.selfRole});
}
async function prepareExit(seat,button) {
  if(!privateReady) return;
  const generation=accountGeneration(),epoch=privateEpoch;button.disabled=true;
  try {
    const data=await privateApi(`/api/rooms/${seat.roomCode}`,{token:seat.token});
    if(!privateLive(generation,epoch)) return;
    if(data.view?.selfId!==seat.playerId) throw Object.assign(new Error('原来的座位已失效，请重新进入房间。'),{status:403,code:'SEAT_REQUIRED'});
    exitState={seat,view:data.view,body:null,generation,epoch};renderExit();
    $('lobby-exit-status').textContent='';$('lobby-exit-confirm').disabled=false;
    $('lobby-exit-dialog').showModal();
  } catch(error) {
    if(!privateLive(generation,epoch)) return;
    notice(error.message);
    if(error.status===404 || error.code==='SEAT_REQUIRED') {forgetMembership(seat.roomCode,seat.playerId);button.closest('.recent-seat').remove();$('recent-section').hidden=!$('recent-list').children.length;}
  } finally {button.disabled=false;}
}
async function loadHistory(append=false) {
  const state=accountState();
  if(!privateReady || state.mode==='legacy' || !state.authenticated) return;
  if(historyLoading) {if(!append) historyRefreshQueued=true;return;}
  const sequence=++historySequence,generation=accountGeneration(),epoch=privateEpoch;historyLoading=true;
  $('history-section').hidden=false;$('history-status').textContent='正在读取…';$('history-retry').hidden=true;$('history-more').disabled=true;
  try {
    const query=new URLSearchParams({limit:'10',...(append && historyCursor?{cursor:historyCursor}:{})});
    const data=await privateApi(`/api/history?${query}`);
    if(sequence!==historySequence || !privateLive(generation,epoch)) return;
    if(!append) {$('history-list').replaceChildren();historySeen.clear();}
    for(const item of data.items || []) {
      if(!item || typeof item.matchId!=='string' || historySeen.has(item.matchId)) continue;
      historySeen.add(item.matchId);
      const row=document.createElement('details');row.className='history-match';
      const summary=document.createElement('summary'),title=document.createElement('strong'),time=document.createElement('span');
      title.textContent=`${gameName(item.game)} · ${historyOutcome(item)}`;time.textContent=dateText(item.endedAt);summary.append(title,time);
      const meta=document.createElement('p');meta.textContent=`房间 ${item.roomCode} · ${historyScore(item,item.self?.score ?? item.self?.remainingPoints)}`;
      const players=document.createElement('ul');
      for(const player of item.players || []) {const li=document.createElement('li');li.textContent=`${player.nickname || '朋友'} · ${historyOutcome({status:item.status,self:{outcome:player.outcome}})} · ${historyScore(item,player.score ?? player.remainingPoints)}`;players.append(li);}
      row.append(summary,meta,players);$('history-list').append(row);
    }
    const stats=data.stats || {};const count=key=>Number.isSafeInteger(stats[key]) && stats[key]>=0?stats[key]:0;
    $('history-stats').textContent=`近 ${data.retentionDays || 180} 天：${count('completed')} 局完成 · ${count('wins')} 胜 · ${count('draws')} 平 · ${count('losses')} 负${count('aborted')?` · ${count('aborted')} 局中止`:''}`;
    historyCursor=typeof data.nextCursor==='string'?data.nextCursor:null;
    $('history-more').hidden=!historyCursor;
    $('history-status').textContent=historySeen.size?'中止局不计输赢。点开一局查看结果。':'还没有战绩。玩完的结果会留在这里，中止局不计输赢。';
  } catch(error) {
    if(sequence!==historySequence || !privateLive(generation,epoch)) return;
    $('history-status').textContent=error.message;$('history-retry').hidden=false;
  } finally {if(sequence===historySequence) {
    historyLoading=false;$('history-more').disabled=false;
    if(historyRefreshQueued) {historyRefreshQueued=false;loadHistory(false);}
  }}
}
function drawAccount() {
  const current=accountState();
  if(document.hidden || ['checking','paused'].includes(current.verification)) {suspendLobby();return;}
  const changed=renderedGeneration!==accountGeneration();
  if(changed && privateReady) concealLobby();
  const restored=!privateReady;renderedGeneration=accountGeneration();
  const state=accountState(),legacy=state.mode==='legacy';
  refreshGameChoices(state);
  if ($('wordbank-link')) $('wordbank-link').hidden = !state.drawingEnabled;
  privateReady=legacy || state.authenticated;
  $('lobby-forms').hidden=!(legacy || state.authenticated);
  $('account-panel').hidden=legacy;
  $('account-login').hidden=state.authenticated || !state.loginReady || (state.failureStatus===503);
  $('account-logout').hidden=!state.authenticated;
  $('account-retry').hidden=state.failureStatus!==503;
  const reauth=reauthenticationHref();
  $('account-reauth').hidden=state.authenticated || state.failureStatus===503 || !reauth;
  $('account-reauth').href=reauth || '#';
  $('account-heading').textContent=state.authenticated?'坐下来，慢慢玩。':state.failureStatus===503?'暂时连不上登录服务。':'用熟悉的账号，见熟悉的人。';
  $('account-description').textContent=state.authenticated
    ?(state.profile?.nickname?`棋牌昵称：${state.profile.nickname}。可以在入房前改称呼。`:'第一次来，入房前填一个棋牌昵称就好。')
    :state.failureStatus===503?'请稍后重试，你在房间的座位会保留。':state.loginReady
      ?`使用原日历账号，无需重新注册。${reauth?'若登录仍失败，请在 Agora 完成账号验证后返回，再登录棋牌室。':''}`
      :'登录入口正在准备，请稍后再来。';
  $('environment-note').textContent=legacy?'当前为本机房间预览。远程朋友入口将在部署后提供。':state.mode==='mock'?'本机隔离预览 · 使用虚构身份。':'与 Agora 共用账号，棋牌昵称与房间分别管理。';
  $('recent-list').replaceChildren();$('recent-section').hidden=true;
  if(!legacy && !state.authenticated) {
    concealLobby();return;
  }
  if(!legacy) for(const id of ['create-name','join-name']) if(changed || !$(id).value) $(id).value=state.profile?.nickname || '';
  $('recent-description').textContent=legacy?'恢复这台设备保存的座位。':'恢复这个账号的座位，换设备也可以接着玩。';
  for(const seat of (legacy?recentSeats():state.recentRooms || [])) {
    const row=document.createElement('div');row.className='recent-seat';
    const label=document.createElement('div');label.className='recent-room-label';
    const title=document.createElement('strong');title.textContent=`${gameName(seat.gameType)} · 房间 ${seat.roomCode} · ${roomPhaseLabel(seat.phase)}${seat.selfRole==='spectator'?' · 观战':''}`;
    const info=document.createElement('span');info.textContent=`${seat.name || '我的座位'}${seat.playersCount?` · ${seat.playersCount} 人`:''}${seat.expiresAt?` · 保留至 ${dateText(seat.expiresAt)}`:''}`;label.append(title,info);
    const controls=document.createElement('div');controls.className='recent-room-controls';
    const button=document.createElement('button');button.className='secondary-button';button.textContent='进入房间 ↗';
    const leave=document.createElement('button');leave.className='text-button';leave.textContent='退出房间';
    controls.append(button,leave);row.append(label,controls);$('recent-list').append(row);
    leave.addEventListener('click',()=>prepareExit(seat,leave));
    button.addEventListener('click',async()=>{
      if(!privateReady) return;
      const generation=accountGeneration(),epoch=privateEpoch;button.disabled=true;
      try { const data=await privateApi(`/api/rooms/${seat.roomCode}`,{token:seat.token});if(!privateLive(generation,epoch)) return;
        const restored=legacy?rememberMembership({...seat,view:data.view},seat.name):{roomCode:seat.roomCode,playerId:data.view.selfId,view:data.view};go(restored);
      } catch(error) {if(!privateLive(generation,epoch)) return;notice(error.message);if(error.status===404 || error.code==='SEAT_REQUIRED' || legacy && error.status===401) {forgetMembership(seat.roomCode,seat.playerId);row.remove();$('recent-section').hidden=!$('recent-list').children.length;} else button.disabled=false;}
    });
  }
  $('recent-section').hidden=!$('recent-list').children.length;
  if(legacy) clearHistory();else {if(changed || restored) loadHistory();checkIncomingInvitation();}
}
async function enter(form,join) {
  const state=accountState();if(!privateReady || state.mode!=='legacy' && !state.authenticated) {notice('请先完成登录核验。');return;}
  if(entrySubmissions.has(form)) return;
  const button=form.querySelector('button[type=submit]'),name=form.querySelector('[name=name]').value.trim(),code=normalizeCode($('join-code').value);
  if(!name || [...name].length>16) {notice('昵称需要 1～16 个字。');return;}
  if(join && !/^\d{6}$/.test(code)) {notice('请填写六位房间号。');return;}
  const generation=accountGeneration(),epoch=privateEpoch;button.disabled=true;$('lobby-notice').hidden=true;
  const gameType=join?undefined:$('create-game').value;
  const role=join?$('join-role')?.value || 'player':undefined;
  if(!join) gameDetails(gameType);
  const fingerprint=JSON.stringify({name,code:join?code:null,...(!join?{gameType}:{role})});
  if(form.requestFingerprint!==fingerprint) {form.requestFingerprint=fingerprint;form.requestId=crypto.randomUUID();}
  const submission={sequence:++entrySubmissionSequence,button,generation,epoch,navigating:false};entrySubmissions.set(form,submission);
  const live=()=>entrySubmissions.get(form)===submission && privateLive(generation,epoch);
  try {const data=await privateApi(join?`/api/rooms/${code}/join`:'/api/rooms',{method:'POST',body:{name,...(!join?{gameType}:{role}),...(state.mode!=='legacy'?{requestId:form.requestId}:{})}});
    if(!live()) return;
    go(state.mode==='legacy'?rememberMembership(data,name):data);
    submission.navigating=true;form.requestId=null;form.requestFingerprint=null;
  } catch(error) {if(!live()) return;notice(error.message);}
  // Navigation is asynchronous. Keep a confirmed entry busy until this page
  // leaves so a second click cannot create another room with a fresh requestId.
  finally {if(entrySubmissions.get(form)===submission && !submission.navigating) {entrySubmissions.delete(form);button.disabled=false;}}
}
$('create-form').addEventListener('submit',event=>{event.preventDefault();enter(event.currentTarget,false);});
function updateCreateGame() {
  const game=gameDetails($('create-game').value);
  $('create-game-description').textContent=`${game.name} · ${game.minPlayers===game.maxPlayers?game.minPlayers:`${game.minPlayers}～${game.maxPlayers}`} 人 · ${gamePresentation($('create-game').value).scoreKind === 'score' ? '一人画，大家同时猜' : '每人回合 30 分钟'}`;
}
// Preserve the current choice while the registered games supply the options.
function refreshGameChoices(state) {
const previousGameChoice = $('create-game').value;
const games = gamePresentations().filter(game => game.gameType !== 'draw-and-guess' || state.drawingEnabled);
$('create-game').replaceChildren(...games.map(game => {
  const option = document.createElement('option'); option.value = game.gameType; option.textContent = game.name; return option;
}));
$('create-game').value = games.some(game => game.gameType === previousGameChoice) ? previousGameChoice : games[0].gameType;
updateCreateGame();
}
refreshGameChoices(accountState());
$('create-game').addEventListener('change',updateCreateGame);
updateCreateGame();
$('join-form').addEventListener('submit',event=>{event.preventDefault();enter(event.currentTarget,true);});
$('account-retry').addEventListener('click',()=>accountLifecycle.refresh());
$('account-logout').addEventListener('click',async()=>{try {await logoutAccount();drawAccount();notice('已退出棋牌室，房间座位会保留。');} catch(error) {notice(error.message);}});
$('lobby-exit-cancel').addEventListener('click',()=>{$('lobby-exit-dialog').close();exitState=null;});
$('lobby-exit-confirm').addEventListener('click',async()=>{
  const pending=exitState;if(!pending || !privateLive(pending.generation,pending.epoch)) return;
  const button=$('lobby-exit-confirm');button.disabled=true;
  try {
    pending.body ||= createExitRequest(pending.view,crypto.randomUUID());
    const data=await privateApi(`/api/rooms/${pending.seat.roomCode}/actions`,{method:'POST',token:pending.seat.token,body:pending.body});
    if(pending!==exitState || !privateLive(pending.generation,pending.epoch)) return;
    if(!data.left) throw new Error('退出结果暂时无法确认，请重试。');
    forgetMembership(pending.seat.roomCode,pending.seat.playerId);$('lobby-exit-dialog').close();exitState=null;
    notice('已退出房间。最后一位玩家退出后，房间会自动关闭。');
    if(accountState().mode==='legacy') drawAccount();else await loadAccount();
  } catch(error) {
    if(pending!==exitState || !privateLive(pending.generation,pending.epoch)) return;
    $('lobby-exit-status').textContent=error.message;
    if(error.status===409) {
      try {const data=await privateApi(`/api/rooms/${pending.seat.roomCode}`,{token:pending.seat.token});
        if(pending===exitState && privateLive(pending.generation,pending.epoch)) {pending.view=data.view;pending.body=null;renderExit();$('lobby-exit-status').textContent='房间刚刚更新，请重新确认退出。';}}
      catch(failure) {if(pending===exitState && privateLive(pending.generation,pending.epoch)) $('lobby-exit-status').textContent=failure.message;}
    }
  } finally {button.disabled=false;}
});
$('history-more').addEventListener('click',()=>loadHistory(true));
$('history-retry').addEventListener('click',()=>loadHistory(false));
$('history-refresh').addEventListener('click',()=>loadHistory(false));
onAccountChange(drawAccount);
const accountLifecycle=watchAccountLifecycle({onSuspend:suspendLobby,onVerified:()=>{if(!privateReady && accountState().authenticated) drawAccount();},onError:error=>notice(error.message)});
accountLifecycle.refresh();
window.addEventListener('pageshow',event=>{if(event.persisted) cancelPrivateWork();});
