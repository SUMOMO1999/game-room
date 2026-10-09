import { boardSvg, dieSvg } from './art.mjs';
import { SIDES } from './board.mjs';
import { flyingModel, flyingTransition, flyingRulePages } from './presentation.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountRoomSettings } from '../../platform/room-settings.mjs';
import { mountGameViewport } from '../../platform/room-viewport.mjs';
import { createRoomClock } from '../../platform/room-clock.mjs';
import { orderedRoomPlayers, roomExitExplanation, gameErrorMessage } from '../../platform/room-presentation.mjs';
import { gameViewport } from '../../game-viewport.mjs';
import { roomChatMarkup } from '../../room-chat.mjs';
import { replacePracticeWithLobby, mountPracticeExit } from '../../platform/practice-navigation.mjs';

/** Shared local/online reading and interaction. It never rolls or owns room identity. */
export function mountFlyingPage({ mode = 'room', session = null, lessonOptions = [],
  onAction = () => {}, onLeave = () => {}, onRecover = () => {}, onRetry = () => {},
  onRefresh = () => {}, getPending = () => null, getStorageReady = () => true } = {}) {
  const practice = mode === 'practice', root = document.getElementById('flying-root');
  if (!root) throw new Error('找不到飞行棋页面。');
  document.body.classList.add('flying-body', 'in-game');
  root.innerHTML = `<section class="flying-page">
  <header class="flying-header site-header room-header"><a href="./" ${practice ? 'data-practice-exit' : ''} class="flying-brand" aria-label="返回棋牌室大厅">棋牌室 <small>飞行棋</small></a><div class="flying-header-actions room-toolbar" data-chat-notice-anchor><span id="flying-connection" class="room-toolbar-status"></span><div class="room-toolbar-actions">
  <button id="chat-toggle" class="chat-toggle room-toolbar-action" aria-controls="room-chat" aria-expanded="false" hidden>聊两句 <span id="chat-unread" class="chat-unread" hidden></span></button><button id="sound-toggle" type="button">点按启声</button><button id="flying-rules" type="button">规则</button><button id="flying-options" class="room-toolbar-action" aria-label="游戏设置" type="button">设置</button><button id="flying-exit" class="room-toolbar-action room-toolbar-exit" aria-label="${practice ? '返回大厅' : '退出房间'}" type="button">×</button></div></div></header>
  <aside class="flying-roster" aria-label="玩家与回合"><div id="flying-players" class="flying-players" aria-label="实际出牌顺序"></div><div class="flying-roster-heading"><strong id="flying-turn">正在恢复</strong><button id="flying-enlarge" type="button">看棋盘</button></div></aside>
  <main class="flying-main"><section class="flying-board-panel" aria-label="公开棋盘"><div id="flying-board" class="flying-board-frame" data-chat-dismiss-notices></div></section>
  <section id="flying-controls" class="flying-control-panel" aria-label="飞行棋操作" data-chat-dismiss-notices><div id="flying-gate" class="flying-gate"><p id="flying-gate-text" role="status">正在恢复游戏…</p><a id="flying-login" hidden>登录并恢复</a><a id="flying-reauth" class="account-reauth-link" hidden>去 Agora 验证账号</a><button id="flying-recover" hidden>重新连接</button></div>
  <div id="flying-waiting" hidden><h2>坐好了，就出发。</h2><p id="flying-waiting-text"></p><div class="flying-actions"><button id="flying-ready">准备好了</button><button id="flying-start">开始游戏</button><button id="flying-role">改为观战</button></div><p id="flying-observers"></p></div>
  <div id="flying-live" hidden><div class="flying-stage-row"><div id="flying-die" class="flying-die"></div><div><strong id="flying-stage" class="flying-stage"></strong><span id="turn-clock" class="flying-clock" hidden><span id="turn-clock-time"></span> <small id="turn-clock-action"></small></span></div></div>
  <div id="flying-plane-grid" class="flying-plane-grid"></div><p id="flying-route" class="flying-route"></p><div class="flying-actions"><button id="flying-roll" class="flying-primary">掷骰子</button><button id="flying-confirm" class="flying-primary">确认移动</button><button id="flying-cancel">取消选择</button><button id="flying-resume" hidden>继续对局</button></div></div>
  <div id="flying-result" class="flying-result" hidden><h2 id="flying-result-text"></h2><button id="flying-rematch">再来一局</button></div>
  <div id="flying-recovery" class="flying-recovery" hidden><p id="flying-recovery-text" role="status"></p><div class="flying-actions"><button id="flying-refresh">查看结果</button><button id="flying-retry">重试原操作</button></div></div>
  <p id="flying-feedback" class="flying-feedback" role="status" aria-live="polite"></p></section></main>
  <footer class="flying-footer"><span id="flying-save-note"></span><a href="./" ${practice ? 'data-practice-exit' : ''}>返回大厅</a></footer></section>
  <dialog id="flying-rules-dialog" class="flying-dialog"><div class="dialog-heading"><h2>飞行棋 · 朋友版</h2><button data-close="flying-rules-dialog" aria-label="关闭规则">×</button></div><div id="flying-rule-text"></div></dialog>
  <dialog id="flying-options-dialog" class="flying-dialog"><div class="dialog-heading"><h2>设置</h2><button id="flying-settings-close" data-close="flying-options-dialog" class="close-button" aria-label="关闭设置">×</button></div><div class="game-settings-body"><section><h3>音效与玩法</h3><div id="flying-settings-tools" class="game-settings-controls"></div><div class="sound-settings"><label for="sound-volume">音效音量</label><input id="sound-volume" type="range" min="0" max="100" step="5" value="45"><select id="sound-preview-kind" aria-label="试听种类"><option value="roll">掷骰</option><option value="launch">起飞</option><option value="flight">跳飞</option><option value="move">移动</option><option value="collision">撞机</option><option value="plane-finish">归航</option><option value="turn">轮到你</option><option value="chat">聊天</option><option value="win">结束</option></select><button id="sound-preview">试听</button><span id="sound-preview-status" role="status"></span></div></section><section><h3>${practice ? '练习安排' : '房间安排'}</h3><div class="room-menu-actions">
  <p id="chat-legacy-note" ${practice ? '' : 'hidden'}>${practice ? '这是本机轮流练习，没有联网聊天。和朋友聊天、对局，请从大厅创建或加入房间。' : '当前本机预览不提供联网聊天；正式登录后的朋友房间可聊天。'}</p><a href="./" ${practice ? 'data-practice-exit' : ''}>${practice ? '去大厅，创建联机房间' : '返回大厅，保留席位'}</a><button id="flying-copy" ${practice ? 'hidden' : ''}>复制邀请</button><button id="flying-pause" ${practice ? 'hidden' : ''}>同意暂停</button><button id="flying-host" ${practice ? 'hidden' : ''}>接任房主</button><label id="flying-transfer-label" ${practice ? 'hidden' : ''}>转交房主 <select id="flying-next-host"></select><button id="flying-transfer">转交</button></label>
  <div id="flying-practice-options" ${practice ? '' : 'hidden'}><label>本机轮流人数 <select id="flying-practice-count"><option value="2">2人</option><option value="3">3人</option><option value="4">4人</option></select></label><label>练习内容 <select id="flying-practice-lesson"><option value="">自由练习</option></select></label><button id="flying-restart">重新开始</button><button id="flying-practice-reload" hidden>恢复另一标签页进度</button></div><p id="flying-menu-status" role="status"></p></div></section></div></dialog>
  <dialog id="flying-leave-dialog" class="flying-dialog"><h2>${practice ? '返回大厅？' : '退出房间？'}</h2><p id="flying-leave-description"></p><p id="flying-leave-status" role="status"></p><div class="flying-actions"><button data-close="flying-leave-dialog">继续留在这里</button><button id="flying-leave-confirm">${practice ? '返回大厅' : '确认退出'}</button></div></dialog>
  <dialog id="flying-restart-dialog" class="flying-dialog"><h2>重新开始练习？</h2><p>这会替换本机已保存的练习棋位和骰面，并使用设置中选择的人数与课程。朋友房间不受影响。</p><p id="flying-restart-status" role="status"></p><div class="flying-actions"><button data-close="flying-restart-dialog">继续原练习</button><button id="flying-confirm-restart">确认重新开始</button></div></dialog>
  <dialog id="flying-board-dialog" class="flying-dialog flying-board-dialog"><div class="dialog-heading"><h2>看清棋盘</h2><button data-close="flying-board-dialog" aria-label="收起棋盘">×</button></div><label>放大 <input id="flying-zoom" type="range" min="100" max="250" step="25" value="100"></label><div id="flying-zoom-frame" class="flying-zoom-frame"><div id="flying-zoom-board"></div></div><p>放大后可拖动查看；选机使用主屏的大按钮。</p></dialog>
  ${practice ? '' : roomChatMarkup()}`;
  const $ = id => document.getElementById(id), audio = createGameAudio();
  const unmountPracticeExit = practice ? mountPracticeExit({ document, location }) : () => {};
  let view = null, selectedId = null, choiceKey = null, busy = false, leaving = false, sequence = 0;
  let connection = practice ? 'online' : 'offline', notice = '', destroyed = false, previous = null;
  // A throw is decoration of an already committed roll, never a source of dice
  // values or a reason to block selecting a plane. POST/SSE use the same fence.
  let diceAnimation = null;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  function stopDiceAnimation() { diceAnimation?.cancel(); diceAnimation = null; }
  function animateCommittedDie() {
    stopDiceAnimation();
    if (!active() || reducedMotion?.matches || typeof $('flying-die').animate !== 'function') return;
    diceAnimation = $('flying-die').animate([
      { transform: 'perspective(280px) translateY(0) rotateX(0deg) rotateZ(0deg)', offset: 0 },
      { transform: 'perspective(280px) translateY(-6px) rotateX(155deg) rotateZ(-24deg)', offset: .25 },
      { transform: 'perspective(280px) translateY(-3px) rotateX(310deg) rotateZ(16deg)', offset: .56 },
      { transform: 'perspective(280px) translateY(2px) rotateX(360deg) rotateZ(-5deg)', offset: .82 },
      { transform: 'perspective(280px) translateY(0) rotateX(360deg) rotateZ(0deg)', offset: 1 },
    ], { duration: 650, easing: 'ease-out' });
  }
  const stopHiddenDice = () => { if (document.hidden) stopDiceAnimation(); };
  document.addEventListener('visibilitychange', stopHiddenDice);
  window.addEventListener('pagehide', stopDiceAnimation);
  reducedMotion?.addEventListener?.('change', stopDiceAnimation);
  const node = (tag, className, text) => { const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el; };
  const side = id => SIDES.find(item => item.id === id);
  const key = value => JSON.stringify([value?.roomId,value?.matchId,value?.selfId,value?.game?.rollId]);
  const active = () => !document.hidden && !destroyed && !leaving && connection === 'online';
  const pending = () => !practice && Boolean(getPending());
  const model = () => flyingModel(view,{selectedId,busy:busy || !active() || !getStorageReady() || clock.display().expired,pending:pending()});
  const clock = createRoomClock({onRender(state) {const el=$('turn-clock');el.hidden=!state.visible;if(state.visible){$('turn-clock-time').textContent=state.time;$('turn-clock-action').textContent=state.action;el.classList.toggle('expired',state.expired);el.setAttribute('aria-label',state.label);}},onExpire(){selectedId=null;render();onRefresh();}});
  function render() {
    if(destroyed)return;
    const info=model(), game=view?.game;
    $('flying-gate').hidden=!!view && !['invalid'].includes(view.phase);
    $('flying-waiting').hidden=view?.phase!=='waiting';$('flying-live').hidden=!game||['finished','aborted'].includes(view?.phase);
    $('flying-result').hidden=!['finished','aborted'].includes(view?.phase);
    $('flying-result-text').textContent=info.resultText || (view?.phase==='aborted'?'这一局已中止，不计输赢。':'');
    $('flying-result-text').title=$('flying-result-text').textContent;
    $('flying-rematch').disabled=busy || !active() || pending() || !practice && view?.hostId!==view?.selfId;
    $('flying-confirm-restart').disabled=busy;
    $('flying-rematch').textContent=practice?'重新开始':view?.hostId===view?.selfId?'再来一局':'等房主再开一局';
    $('flying-turn').textContent=practice&&game?`${side(game.players.find(p=>p.id===game.turnPlayerId)?.side)?.label || ''} · 本机轮流`:info.turnText || (view?.phase==='waiting'?'等待朋友坐好':'飞行棋');
    $('flying-turn').title=$('flying-turn').textContent;
    root.classList.toggle('is-your-turn',!!game && game.turnPlayerId===view?.selfId && view?.selfRole!=='spectator' && view?.phase==='playing');
    $('flying-stage').textContent=notice || info.stageText || '';
    $('flying-stage').title=$('flying-stage').textContent;
    $('flying-feedback').textContent=notice || info.feedback || '';
    $('flying-route').textContent=info.route?.description || '';
    const die=info.die;
    $('flying-die').innerHTML=Number.isInteger(die)&&die>=1&&die<=6?dieSvg(die):'<span aria-label="还未掷骰">?</span>';
    $('flying-die').classList.toggle('previous-die',!!die&&!info.dieIsCurrent);
    $('flying-die').setAttribute('aria-label',die?`${info.dieIsCurrent?'本次':'上一骰'} ${die} 点`:'还未掷骰');
    if(die&&!info.dieIsCurrent)$('flying-die').append(node('small','flying-die-label','上一骰'));
    $('flying-roll').hidden=view?.phase!=='playing'||game?.stage!=='await-roll';$('flying-roll').disabled=!info.canRoll;
    $('flying-confirm').hidden=view?.phase!=='playing'||game?.stage!=='await-move';$('flying-confirm').disabled=!info.canConfirm;
    $('flying-cancel').hidden=view?.phase!=='playing'||game?.stage!=='await-move';$('flying-cancel').disabled=!selectedId || busy;
    $('flying-resume').hidden=view?.phase!=='paused';$('flying-resume').disabled=busy||pending()||!active()||view?.selfRole==='spectator';
    const svg=boardSvg({planes:game?.planes || [],selectedId:info.selectedId,legalIds:info.canChoose?game?.legalPlaneIds || []:[],route:info.route,lastMoveId:game?.lastAction?.route?.planeId,observer:view?.selfRole==='spectator',paused:view?.phase==='paused'});
    $('flying-board').innerHTML=svg;
    if($('flying-board-dialog').open)renderZoom(svg);
    $('flying-plane-grid').replaceChildren(...(info.planesToChoose || []).map(plane=>{
      const button=node('button',`flying-plane-button${plane.selected?' selected':''}${plane.legal?' legal':''}`,plane.label);
      button.type='button';button.dataset.planeId=plane.id;button.disabled=!info.canChoose || !plane.legal;button.setAttribute('aria-pressed',String(plane.selected));
      button.style.setProperty('--side-color',side(plane.side)?.color || '#143b30');button.append(node('small','',plane.positionLabel));
      button.addEventListener('click',()=>choose(plane.id));return button;
    }));
    const players=practice && game?game.players.map((p,index)=>({...p,name:view.players?.find(q=>q.id===p.id)?.name||side(p.side)?.label,turnOrder:index+1})):orderedRoomPlayers(view);
    $('flying-players').replaceChildren(...players.map((player,index)=>{
      const s=player.side || game?.players.find(p=>p.id===player.id)?.side || view?.sideAssignments?.find(p=>p.playerId===player.id)?.side;
      const row=node('div',`flying-player${player.id===game?.turnPlayerId && view?.phase==='playing'?' current':''}${player.id===view?.selfId?' self':''}`);
      row.style.setProperty('--side-color',side(s)?.color || '#77948b');
      const label=node('strong','',`${player.turnOrder||index+1} · ${player.name}${player.id===view?.selfId && !practice?' · 我':''}`);label.title=player.name;
      const completed=game?.planes.filter(p=>p.side===s&&p.progress===55).length || 0;
      row.append(label,node('small','',`${side(s)?.label||'待分色'} · ${view?.phase==='waiting'?(player.ready?'已准备':'未准备'):`${completed}/4归航`}`));return row;
    }));
    if(view?.phase==='waiting'){
      const me=view.players.find(p=>p.id===view.selfId), spectator=view.selfRole==='spectator';
      $('flying-waiting-text').textContent=`${view.players.length}/4人 · 六点起飞 · 四架归航获胜 · 每回合30分钟`;
      $('flying-observers').textContent=`${view.spectators?.length||0}位观众${spectator?' · 你正在观战':''}`;
      $('flying-ready').hidden=spectator;$('flying-ready').textContent=me?.ready?'取消准备':'准备好了';$('flying-ready').disabled=busy||pending()||!active()||!getStorageReady();
      $('flying-start').hidden=view.hostId!==view.selfId;$('flying-start').disabled=busy||pending()||!active()||view.players.length<2||!view.players.every(p=>p.ready)||!getStorageReady();
      $('flying-role').textContent=spectator?'加入对局':'改为观战';$('flying-role').disabled=busy||pending()||!active()||!getStorageReady();
    }
    const unknown=pending(), unavailable=!practice && !getStorageReady();
    root.classList.toggle('has-recovery',unknown||unavailable||!!view?.practiceConflict);
    $('flying-recovery').hidden=!unknown&&!unavailable&&!view?.practiceConflict;
    $('flying-recovery-text').textContent=unavailable?'浏览器无法保存操作。请允许本站存储后重进；当前不会发送新操作。':view?.practiceConflict?'另一标签页已更新练习，请恢复该进度后继续。':'上一操作结果尚未确认。先查看结果，或重试同一操作；不会重新掷骰。';
    $('flying-retry').hidden=!unknown;$('flying-refresh').hidden=unavailable;$('flying-refresh').textContent=view?.practiceConflict?'恢复练习':'查看结果';
    $('flying-retry').disabled=busy||!active();$('flying-refresh').disabled=busy;
    $('flying-save-note').textContent=practice?(view?.storageAvailable?'本机轮流练习 · 已保存 · 不计战绩':'本机轮流练习 · 无法保存 · 不计战绩'):(view?.selfRole==='spectator'?'观战 · 只读棋盘':'确认后自动保存');
    if(practice&&view?.lessonLabel)$('flying-save-note').textContent=`固定教学：${view.lessonLabel} · ${view.storageAvailable?'已保存':'无法保存'} · 不计战绩`;
    $('flying-connection').textContent=practice?'仅本机':`${connection==='online'?'已连接':'连接恢复中'}${view?.roomCode?' · '+view.roomCode:''}`;
    $('flying-exit').disabled=leaving || !practice&&!view;
    $('flying-pause').hidden=practice || !view || view.selfRole==='spectator'||!['playing','paused'].includes(view.phase);
    $('flying-pause').textContent=view?.phase==='paused'?'继续对局':view?.pause?.agreedIds?.includes(view.selfId)?'撤回暂停同意':'同意暂停';
    $('flying-host').hidden=practice||!view?.hostCanTakeOver||view?.hostId===view?.selfId||view?.selfRole==='spectator';
    $('flying-transfer-label').hidden=practice||!view||view.hostId!==view.selfId||view.players.length<2;
    const currentHost=$('flying-next-host').value;
    $('flying-next-host').replaceChildren(...(view?.players||[]).filter(p=>p.id!==view?.selfId).map(p=>{const option=node('option','',p.name);option.value=p.id;return option;}));
    if([...$('flying-next-host').options].some(option=>option.value===currentHost))$('flying-next-host').value=currentHost;
    $('flying-practice-reload').hidden=!view?.practiceConflict;
    if(view?.requiresRestart){$('flying-gate-text').textContent='练习存档无法读取。请在选项中重新开始，原记录不会被猜修复。';$('flying-recover').hidden=true;}
  }
  function choose(id){if(!model().canChoose || !view.game.legalPlaneIds.includes(id))return;selectedId=id;choiceKey=key(view);notice='';audio.play('select',{gesture:true});render();}
  function renderZoom(svg){$('flying-zoom-board').innerHTML=svg;$('flying-zoom-board').style.width=`${Math.max(240,$('flying-zoom-frame').clientWidth)*Number($('flying-zoom').value)/100}px`;$('flying-board-detail').textContent=notice || model().route?.description || model().feedback || '';}
  async function run(operation){if(busy||destroyed)return false;const current=sequence;busy=true;notice='';render();try{await operation();return true;}catch(error){if(current===sequence){notice=gameErrorMessage(error);if($('flying-restart-dialog').open)$('flying-restart-status').textContent=notice;audio.play('invalid',{gesture:true});}return false;}finally{if(current===sequence){busy=false;render();}}}
  const action=(type,fields={})=>run(()=>practice?session.action(type,fields):onAction(type,fields));
  function applyView(next,{baseline=false}={}){
    if(destroyed)return;
    if(choiceKey!==key(next)||next?.phase!=='playing'||!next?.game?.legalPlaneIds?.includes(selectedId)){selectedId=null;choiceKey=null;}
    const quiet=baseline||document.hidden, effects=flyingTransition(previous,next,{baseline:quiet}), phaseCue=audio.phaseCue(previous,next,{baseline:quiet});
    if(quiet || previous?.matchId!==next?.matchId || next?.phase!=='playing')stopDiceAnimation();
    previous=next;view=next;notice='';clock.receive(next);render();
    if(effects.cues?.includes('roll'))animateCommittedDie();
    for(const cue of effects.cues||[])audio.play(cue,{gesture:busy});
    if(phaseCue)audio.play(phaseCue,{gesture:busy});
  }
  function conceal({message='正在核验账号并恢复原席位…',loginHref=null,reauthHref=null,preserveSelection=false}={}){
    stopDiceAnimation();
    ++sequence;busy=false;view=null;previous=null;clock.reset();if(!preserveSelection){selectedId=null;choiceKey=null;}notice='';
    for(const dialog of root.querySelectorAll('dialog[open]'))dialog.close();render();$('flying-gate-text').textContent=message;
    $('flying-login').hidden=!loginHref;$('flying-login').href=loginHref||'#';$('flying-reauth').hidden=!reauthHref;$('flying-reauth').href=reauthHref||'#';$('flying-recover').hidden=!!loginHref;
  }
  const listen=(id,event,handler)=>$(id).addEventListener(event,handler);
  listen('flying-roll','click',()=>{if(model().canRoll)action('roll');});
  listen('flying-confirm','click',()=>{const info=model();if(info.canConfirm)action('move',{rollId:view.game.rollId,planeId:info.selectedId});});
  listen('flying-cancel','click',()=>{selectedId=null;choiceKey=null;notice='';audio.play('undo',{gesture:true});render();});
  listen('flying-ready','click',()=>action('ready',{ready:!view?.players.find(p=>p.id===view.selfId)?.ready}));
  listen('flying-start','click',()=>action('start'));listen('flying-role','click',()=>action('set-role',{role:view?.selfRole==='spectator'?'player':'spectator'}));
  listen('flying-rematch','click',()=>practice?$('flying-options-dialog').showModal():action('rematch'));
  listen('flying-resume','click',()=>action('resume'));
  listen('flying-recover','click',()=>onRecover());
  listen('flying-refresh','click',()=>run(()=>practice?session.reload():onRefresh()));listen('flying-retry','click',()=>run(onRetry));
  listen('flying-pause','click',()=>action(view?.phase==='paused'?'resume':'pause',{...(view?.phase==='playing'?{agree:!view.pause?.agreedIds?.includes(view.selfId)}:{})}));
  listen('flying-host','click',()=>action('transferHost',{playerId:view?.selfId}));listen('flying-transfer','click',()=>action('transferHost',{playerId:$('flying-next-host').value}));
  listen('flying-copy','click',async()=>{try{await navigator.clipboard.writeText(new URL(`./?room=${view.roomCode}`,location.href).href);$('flying-menu-status').textContent='邀请链接已复制。';}catch{$('flying-menu-status').textContent=`房间号 ${view?.roomCode || ''}，告诉朋友即可。`;}});
  listen('flying-rules','click',()=>$('flying-rules-dialog').showModal());
  listen('flying-exit','click',()=>{if(leaving)return;$('flying-leave-description').textContent=practice?(view?.storageAvailable?'练习进度已保存，下次可继续。':'当前无法保存，离开后进度会丢失。'):view?.selfRole==='spectator'?'退出后离开观战，不影响朋友对局。':roomExitExplanation(view?.phase);$('flying-leave-status').textContent='';$('flying-leave-dialog').showModal();});
  listen('flying-leave-confirm','click',async()=>{if(leaving)return;if(practice){session.destroy();replacePracticeWithLobby(location);return;}leaving=true;$('flying-leave-confirm').disabled=true;render();try{await onLeave();}finally{leaving=false;$('flying-leave-confirm').disabled=false;render();}});
  $('flying-leave-dialog').addEventListener('cancel',event=>{if(leaving)event.preventDefault();});
  for(const button of root.querySelectorAll('[data-close]'))button.addEventListener('click',()=>{if(!leaving)$(button.dataset.close).close();});
  for(const page of flyingRulePages({practice}).flat()){const p=node('p','',page.text);p.prepend(node('strong','',page.title+' · '));$('flying-rule-text').append(p);}
  for(const lesson of lessonOptions){const option=node('option','',lesson.label);option.value=lesson.id;$('flying-practice-lesson').append(option);}
  listen('flying-restart','click',()=>{if(!practice||busy)return;$('flying-restart-status').textContent='';$('flying-restart-dialog').showModal();});
  listen('flying-confirm-restart','click',()=>run(async()=>{if(!practice)return;await session.restart({playerCount:Number($('flying-practice-count').value),lesson:$('flying-practice-lesson').value||null});$('flying-restart-dialog').close();}));
  listen('flying-practice-reload','click',()=>run(async()=>{await session.reload();$('flying-options-dialog').close();}));
  const detail=node('p','');detail.id='flying-board-detail';$('flying-board-dialog').append(detail);
  listen('flying-enlarge','click',()=>{$('flying-board-dialog').showModal();render();});listen('flying-zoom','input',()=>render());
  const settings=mountRoomSettings({document,buttonId:'flying-options',dialogId:'flying-options-dialog',closeButtonId:'flying-settings-close',containerId:'flying-settings-tools',controlIds:['sound-toggle','flying-rules'],dismissIds:['flying-rules','flying-restart']});
  listen('flying-options','click',()=>{if(practice&&view?.game&&$('flying-options-dialog').open){$('flying-practice-count').value=String(view.game.players.length);$('flying-practice-lesson').value=view.lessonId||'';}});
  const audioControls=mountRoomAudioControls({audio,document});
  const viewport=mountGameViewport({window,document,recoveryDelays:[0,100,300],sync(){const editing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);const frame=gameViewport({width:window.innerWidth,height:window.innerHeight,visual:window.visualViewport,editing});document.body.style.setProperty('--flying-height',`${frame.height}px`);document.body.style.setProperty('--flying-width',`${frame.width}px`);if(frame.resetScroll)window.scrollTo(0,0);}});
  const unsubscribe=practice?session.subscribe(next=>applyView(next,{baseline:!view})):null;
  render();import('../../app-shell.mjs').catch(()=>{});
  return {audio,applyView,view:()=>view,setConnection(value){connection=value;if(value!=='online')stopDiceAnimation();render();},conceal,
    setMessage(message){notice=message;render();},leaveFailure(message){$('flying-leave-status').textContent=message;},
    destroy(){destroyed=true;++sequence;stopDiceAnimation();unmountPracticeExit();document.removeEventListener('visibilitychange',stopHiddenDice);window.removeEventListener('pagehide',stopDiceAnimation);reducedMotion?.removeEventListener?.('change',stopDiceAnimation);unsubscribe?.();session?.destroy();clock.destroy();settings.destroy();audioControls.destroy();viewport.destroy();audio.close?.();}};
}
