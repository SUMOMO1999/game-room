import { createDrawingCanvasView, DRAW_COLORS, DRAW_WIDTHS, DRAW_BATCH_MS } from './canvas-view.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountRoomSettings } from '../../platform/room-settings.mjs';
import { mountGameViewport } from '../../platform/room-viewport.mjs';
import { createRoomClock } from '../../platform/room-clock.mjs';
import { gameViewport } from '../../game-viewport.mjs';
import { orderedRoomPlayers, gameErrorMessage, roomExitExplanation } from '../../platform/room-presentation.mjs';
import { roomChatMarkup, mountRoomChat } from '../../room-chat.mjs';
import { mountPracticeExit, replacePracticeWithLobby } from '../../platform/practice-navigation.mjs';
import { createRoomSession, createRoomExit } from '../../platform/room-session.mjs';
import { RoomClient, api, loadMembership, forgetMembership } from '../../room-client.mjs';
import { accountState, accountGeneration, onAccountChange, loadAccount, watchAccountLifecycle,
  loginHref, reauthenticationHref, logoutAccount } from '../../account-client.mjs';
import { roomHref } from '../../game-routing.mjs';
import { entryStorageKey } from '../../entry-path.mjs';
import { normalizeDrawAndGuessGuess } from './matcher.mjs';

const node=(document,tag,className,text)=>{const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item;};
const drawingScope=view=>JSON.stringify([accountState().userKey??'local',view?.roomId,view?.matchId,view?.game?.turnId]);
export function drawingGuessDraftKey(scope) {
  if(!scope)return null;const [owner,...game]=JSON.parse(scope);
  return /^[a-f0-9]{64}$/u.test(owner)?entryStorageKey(`game-room.private-draft.${owner}.draw-guess.${JSON.stringify(game)}`):null;
}
export function drawingStageText(view) {
  if(!view)return '正在恢复原席位和画布…';
  if(view.phase==='waiting')return '朋友坐好了，就开始。';
  if(view.phase==='paused')return '对局已暂停，画布与题目已保存。';
  if(view.phase==='aborted')return '本局已中止，不计输赢。';
  const game=view.game,drawer=view.players?.find(player=>player.id===game?.turnPlayerId)?.name??'朋友';
  if(game?.stage==='finished')return game.result?.winnerIds?.length?'本局结束，看看大家的成绩。':'本局无人猜中，再来一局吧。';
  if(game?.stage==='choosing')return game.turnPlayerId===view.selfId?'轮到你画：先选一个词。':`${drawer}正在选词。`;
  if(game?.stage==='reveal')return `本题揭晓：${game.word?.answer??'正在同步'}。`;
  if(view.selfRole==='spectator')return `${drawer}正在绘画 · 你在观战。`;
  if(game?.turnPlayerId===view.selfId)return '你正在绘画，其他人同时猜。';
  if(game?.guessedPlayerIds?.includes(view.selfId))return '你猜中了！继续看朋友画。';
  return `${drawer}正在画，猜猜是什么？`;
}
export function latestGuessReceipt(view,beforeIds=[],turnId,requestId) {
  return (view?.actionReceipts??[]).filter(receipt=>receipt.status==='committed'
    &&!beforeIds.includes(receipt.requestId)&&(!requestId||receipt.requestId===requestId)
    &&receipt.guessResult&&(!turnId||!receipt.turnId||receipt.turnId===turnId)).at(-1)??null;
}

/** The same canvas/tools/status assembly serves local free paint and rooms.
 * It delegates identity, request receipts and canvas persistence to its callers. */
export function createDrawingGamePage({mode='room',root=globalThis.document?.getElementById('drawing-root'),
  document:doc=globalThis.document,window:win=globalThis.window,onAction=()=>{},onLeave=()=>{},onRecover=()=>{},
  onRefresh=()=>{},onRetry=()=>{},canvasRequest,onCanvasError=()=>{},getPending=()=>null,getStorageReady=()=>true}={}) {
  if(!root)throw new Error('找不到你画我猜页面。');
  const practice=mode==='practice';doc.documentElement.classList.add('drawing-root');doc.body.classList.add('drawing-body','in-game');
  root.innerHTML=`<div class="drawing-page">
    <header class="drawing-header site-header room-header"><a href="./" ${practice?'data-practice-exit':''} class="drawing-brand">棋牌室 <small>你画我猜</small></a>
      <nav class="drawing-header-actions room-toolbar" data-chat-notice-anchor><span id="drawing-connection" class="drawing-connection room-toolbar-status"></span><div class="room-toolbar-actions">
      <button id="chat-toggle" class="chat-toggle room-toolbar-action" aria-controls="room-chat" aria-expanded="false" hidden>聊两句 <span id="chat-unread" class="chat-unread" hidden></span></button>
      <button id="drawing-settings" class="room-toolbar-action" type="button">设置</button><button id="drawing-exit" class="room-toolbar-action room-toolbar-exit" type="button" aria-label="${practice?'返回大厅':'退出房间'}">×</button></div></nav></header>
    <div class="drawing-stage-bar"><span id="drawing-room-code" class="drawing-room-code" hidden></span><strong id="drawing-stage" role="status">正在恢复…</strong><span id="drawing-hint" class="drawing-hint" hidden></span><span id="drawing-round"></span>
      <span id="turn-clock" hidden><span id="turn-clock-time"></span><small id="turn-clock-action"></small></span></div>
    <main class="drawing-main"><section class="drawing-canvas-panel" aria-label="共享画布" data-chat-dismiss-notices>
      <div id="drawing-canvas-slot" class="canvas-slot drawing-canvas-slot">
      <div class="drawing-paper"><canvas id="drawing-canvas" width="1024" height="768" aria-label="画布，所有设备保持相同比例"></canvas><span id="drawing-empty" class="drawing-empty">从一笔开始。</span></div></div></section>
      <aside class="drawing-sidebar"><section id="drawing-gate" class="drawing-card"><h1>你画我猜</h1><p id="drawing-gate-text">正在核验账号…</p>
        <a id="drawing-login" hidden>登录并恢复</a><a id="drawing-reauth" class="account-reauth-link" hidden>去 Agora 验证账号</a><button id="drawing-recover" hidden>重新连接</button></section>
      <section id="drawing-waiting" class="drawing-card" hidden><h2>大家一起画，一起猜。</h2><p id="drawing-waiting-text"></p>
        <div class="drawing-actions"><button id="drawing-ready" class="primary-button">准备好了</button><button id="drawing-start" class="primary-button">开始游戏</button><button id="drawing-role">改为观战</button><button id="drawing-waiting-copy">复制邀请</button></div>
        <p id="drawing-waiting-config"></p><button id="drawing-config-open">房间玩法设置</button><a href="./words">管理词库 →</a></section>
      <section id="drawing-choosing" class="drawing-card" hidden><h2>选一个，画给朋友看。</h2><div id="drawing-candidates" class="drawing-candidates"></div></section>
      <section id="drawing-tools" class="drawing-tools" hidden><div class="drawing-tool-heading"><button id="drawing-acquire" class="primary-button">拿起画笔</button><button id="drawing-tools-toggle" aria-expanded="false">画笔工具</button></div>
        <div id="drawing-tool-panel" hidden><div class="drawing-tool-row drawing-paint-controls"><button data-tool="pen" aria-pressed="true">画笔</button><button data-tool="eraser" aria-pressed="false">橡皮</button>
          <select id="drawing-color" aria-label="画笔颜色"></select><select id="drawing-width" aria-label="画笔粗细"><option value="4">细</option><option value="10" selected>中</option><option value="22">粗</option></select></div>
          <div id="drawing-palette" class="drawing-palette"></div><div class="drawing-tool-row"><button id="drawing-undo" title="撤销最后一笔" aria-label="撤销最后一笔">撤销</button><button id="drawing-redo" title="恢复刚刚撤销的一笔" aria-label="恢复刚刚撤销的一笔">恢复</button><button id="drawing-clear" title="清空整张画布，重新画" aria-label="清空整张画布，重新画">清空</button></div></div>
      </section>
      <form id="drawing-guess-form" class="drawing-guess-form" hidden><label for="drawing-guess-input">输入答案</label><div class="drawing-guess-row"><input id="drawing-guess-input" maxlength="128" autocomplete="off" spellcheck="false" enterkeyhint="send" aria-describedby="drawing-guess-feedback"><button id="drawing-guess-send" class="primary-button" type="submit">猜！</button></div><p id="drawing-guess-feedback" role="status" aria-live="polite"></p><button id="drawing-hide-keyboard" type="button" hidden>收起键盘</button></form>
      <section id="drawing-reveal" class="drawing-card" hidden><p>本题答案</p><h2 id="drawing-answer"></h2><p id="drawing-aliases"></p><p id="drawing-turn-result"></p></section>
      <section id="drawing-result" class="drawing-card" hidden><h2 id="drawing-result-title"></h2><ol id="drawing-results"></ol><button id="drawing-rematch" class="primary-button">再来一局</button></section>
      <section id="drawing-recovery" class="drawing-recovery" hidden><p id="drawing-recovery-text" role="status"></p><div class="drawing-actions"><button id="drawing-refresh">查看结果</button><button id="drawing-retry">重试原操作</button></div></section>
      <span id="drawing-paint-status" class="drawing-paint-status" role="status">已确认的画布会自动保存。</span><div id="drawing-players" class="drawing-players" aria-label="绘画顺序与分数"></div><p id="drawing-feedback" class="drawing-feedback" role="status"></p></aside></main>
    <footer class="drawing-footer"><span id="drawing-save-note"></span></footer>
    <dialog id="drawing-settings-dialog" class="drawing-dialog"><div class="dialog-heading"><h2>设置</h2><button id="drawing-settings-close" aria-label="关闭设置">×</button></div>
      <div class="game-settings-body"><section><h3>声音与玩法</h3><div class="game-settings-controls"><button id="sound-toggle">点按启声</button><button id="drawing-rules-open">玩法说明</button></div>
      <div class="sound-settings"><label for="sound-volume">音效音量</label><input id="sound-volume" type="range" min="0" max="100" step="5" value="45"><select id="sound-preview-kind" aria-label="音效种类"><option value="turn">轮到你画</option><option value="commit">猜中</option><option value="restore">揭晓</option><option value="win">整局结束</option><option value="chat">发言</option><option value="invalid">失败</option></select><button id="sound-preview">试听</button><span id="sound-preview-status" role="status"></span></div></section>
      <section><h3>${practice?'本机练画':'房间安排'}</h3><div class="room-menu-actions"><p ${practice?'':'hidden'}>自由练画只练画笔，不判答案、不计战绩，也没有联网聊天。图保存在这台设备。</p>
        <p id="chat-legacy-note" hidden>当前本机预览不提供联网聊天；正式登录后的朋友房间可聊天。</p><button id="drawing-roster-open" ${practice?'hidden':''}>成员与分数</button><a href="./" ${practice?'data-practice-exit':''}>${practice?'返回大厅':'返回大厅，保留席位'}</a><button id="drawing-copy" ${practice?'hidden':''}>复制邀请</button><button id="drawing-pause" ${practice?'hidden':''}>同意暂停</button>
        <button id="drawing-resume" hidden>继续对局</button><button id="drawing-host" hidden>接任房主</button><label id="drawing-transfer-label" hidden>转交房主<select id="drawing-next-host"></select><button id="drawing-transfer">转交</button></label>
        <button id="drawing-logout" ${practice?'hidden':''}>退出棋牌室登录</button><p id="drawing-menu-status" role="status"></p></div></section></div></dialog>
    <dialog id="drawing-rules-dialog" class="drawing-dialog"><div class="dialog-heading"><h2>经典你画我猜</h2><button data-close="drawing-rules-dialog" aria-label="关闭规则">×</button></div><div class="drawing-dialog-body"><p>2～8人，每人轮流画，其他人同时猜。默认每人2题，选词15秒，绘画120秒，揭晓8秒。</p><p>选一个词后用画表达。不能直接写答案、拼音或通过聊天透题。所有猜者答对，或时间到，就揭晓。</p><p>首次猜中得100～200分，越早猜中分越多。每有一人猜中，画者得25分。同题只计一次；相同总分并列，全局无人猜中则没有赢家。</p><p>猜词只匹配正文及明确别名。答案请用猜词框；普通聊天不判答案。观众可看图和聊天，不能画或猜。</p><p>画者可使用画笔、橡皮、颜色、粗细。撤销移除最后一笔；恢复放回刚刚撤销的一笔；清空清除整张画布及撤销记录，可重新画。断线未确认笔迹丢弃，恢复先取已保存画布。换设备需明确接管。</p><p>返回大厅保留席位；进行中玩家明确退出房间会中止本局。暂停须全体玩家同意，继续使用剩余时间。</p></div></dialog>
    <dialog id="drawing-leave-dialog" class="drawing-dialog"><h2>${practice?'返回大厅？':'退出房间？'}</h2><p id="drawing-leave-note"></p><p id="drawing-leave-status" role="status"></p><div class="drawing-actions"><button data-close="drawing-leave-dialog">继续留在这里</button><button id="drawing-leave-confirm" class="primary-button">${practice?'返回大厅':'确认退出'}</button></div></dialog>
    <dialog id="drawing-clear-dialog" class="drawing-dialog"><h2>清空这张画布？</h2><p>清除已确认的笔迹和撤销记录。题目、分数与时间保持。</p><div class="drawing-actions"><button data-close="drawing-clear-dialog">继续画</button><button id="drawing-clear-confirm">确认清空</button></div></dialog>
    <dialog id="drawing-roster-dialog" class="drawing-dialog"><div class="dialog-heading"><h2>绘画顺序与分数</h2><button data-close="drawing-roster-dialog" aria-label="关闭成员">×</button></div><div id="drawing-roster-full" class="drawing-dialog-body"></div></dialog>
    <dialog id="drawing-config-dialog" class="drawing-dialog"><div class="dialog-heading"><h2>房间玩法设置</h2><button data-close="drawing-config-dialog" aria-label="关闭配置">×</button></div><div class="drawing-dialog-body"><label>每人绘画次数<select id="drawing-rounds"><option>1</option><option selected>2</option><option>3</option><option>4</option><option>5</option></select></label><label>绘画秒数<input id="drawing-seconds" type="number" min="30" max="600" value="120"></label><label>发布词包<select id="drawing-pack"></select></label><p>采用确定发布版本。词包更新不会改变已开局题目。</p><div id="drawing-config-content"></div><p id="drawing-config-status" role="status"></p><button id="drawing-config-save" class="primary-button">保存设置，重新准备</button></div></dialog>
    ${practice?'':roomChatMarkup()}</div>`;
  const $=id=>doc.getElementById(id),audio=createGameAudio(),listeners=[];
  const listen=(target,type,handler,options)=>{target?.addEventListener?.(type,handler,options);listeners.push(()=>target?.removeEventListener?.(type,handler,options));};
  let view=null,connection=practice?'online':'offline',busy=false,leaving=false,destroyed=false,baseline=true,scope=null,composing=false,inputSerial=0,guessFeedback='',guessSubmission=null;
  let paintState={},draftStorage,configEpoch=0,configRelease=null,packs=[];try{draftStorage=win.sessionStorage;}catch{}
  const draftKey=()=>practice?null:drawingGuessDraftKey(scope);
  function saveDraft(){try{const key=draftKey();if(key)draftStorage?.setItem(key,$('drawing-guess-input').value);}catch{}}
  function setScope(next) {
    const nextScope=drawingScope(next);if(nextScope===scope)return;
    saveDraft();scope=nextScope;inputSerial++;composing=false;guessFeedback='';guessSubmission=null;
    try{$('drawing-guess-input').value=draftStorage?.getItem(draftKey())??'';}catch{$('drawing-guess-input').value='';}
  }
  function feedback(text){$('drawing-feedback').textContent=text;}
  const active=()=>!destroyed&&!leaving&&!doc.hidden&&connection==='online';
  const available=()=>active()&&!busy&&!getPending()&&getStorageReady();
  const clock=createRoomClock({onRender(state){$('turn-clock').hidden=!state.visible;if(state.visible){$('turn-clock-time').textContent=state.time;$('turn-clock-action').textContent=view?.game?.stage==='choosing'?'选词':view?.game?.stage==='reveal'?'揭晓':'绘画';}
    if(state.expired){paint?.setContext(canvasContext(false));$('drawing-guess-send').disabled=true;}},onExpire(){paint?.finishPointer();onRefresh();}});
  const canvasContext=(allow=available())=>({roomId:view?.roomId??null,matchId:view?.matchId??null,turnId:view?.game?.turnId??null,
    phase:view?.phase??'waiting',stage:view?.game?.stage??'choosing',drawer:practice||view?.selfId===view?.game?.turnPlayerId,
    enabled:allow&&!clock.display().expired&&view?.phase==='playing'});
  const paint=createDrawingCanvasView({canvas:$('drawing-canvas'),slot:$('drawing-canvas-slot'),empty:$('drawing-empty'),window:win,document:doc,
    batchMs:practice?DRAW_BATCH_MS:1000,
    practice,request:canvasRequest,onStatus:text=>{$('drawing-paint-status').textContent=text;},onError:onCanvasError,
    onState:value=>{paintState=value;renderTools();}});
  function renderTools() {
    $('drawing-acquire').hidden=paintState.ready;
    $('drawing-acquire').textContent=paintState.pointCount?'继续绘画 / 接管':'拿起画笔';
    $('drawing-acquire').disabled=!paintState.canAcquire;
    for(const name of ['undo','redo','clear'])$('drawing-'+name).disabled=!paintState.ready||paintState.busy||paintState.pending>0;
  }
  for(const [color,name]of DRAW_COLORS){const option=node(doc,'option','',name+'色');option.value=color;$('drawing-color').append(option);
    const button=node(doc,'button','drawing-color-chip');button.type='button';button.style.setProperty('--paint-color',color);button.dataset.color=color;button.title=name+'色';button.setAttribute('aria-label',name+'色画笔');button.setAttribute('aria-pressed',String(color==='#182a33'));
    listen(button,'click',()=>{paint.setColor(color);$('drawing-color').value=color;syncColors();});$('drawing-palette').append(button);}
  $('drawing-color').value='#182a33';
  function syncColors(){for(const item of $('drawing-palette').children)item.setAttribute('aria-pressed',String(item.dataset.color===$('drawing-color').value));}
  listen($('drawing-color'),'change',()=>{paint.setColor($('drawing-color').value);syncColors();});
  listen($('drawing-width'),'change',()=>paint.setWidth(Number($('drawing-width').value)));
  for(const item of root.querySelectorAll('[data-tool]'))listen(item,'click',()=>{paint.setTool(item.dataset.tool);for(const button of root.querySelectorAll('[data-tool]'))button.setAttribute('aria-pressed',String(button===item));});
  listen($('drawing-acquire'),'click',()=>paint.acquire());
  listen($('drawing-tools-toggle'),'click',()=>{paint.finishPointer();$('drawing-tool-panel').hidden=!$('drawing-tool-panel').hidden;$('drawing-tools-toggle').setAttribute('aria-expanded',String(!$('drawing-tool-panel').hidden));fit();});
  for(const name of ['undo','redo'])listen($('drawing-'+name),'click',async()=>{paint.finishPointer();if(await paint[name]())audio.play('undo',{gesture:true});});
  const open=id=>{paint.finishPointer();$('drawing-guess-input').blur();if(!$(id).open)$(id).showModal();};
  for(const button of root.querySelectorAll('[data-close]'))listen(button,'click',()=>$(button.dataset.close).close());
  listen($('drawing-clear'),'click',()=>open('drawing-clear-dialog'));
  listen($('drawing-clear-confirm'),'click',async()=>{$('drawing-clear-dialog').close();if(await paint.clear())audio.play('restore',{gesture:true});});
  function renderRoster(target,full=false) {
    const players=practice?[]:orderedRoomPlayers(view);
    target.replaceChildren(...players.map(player=>{const row=node(doc,'div',`drawing-player${player.id===view?.game?.turnPlayerId?' current':''}${player.id===view?.selfId?' self':''}`);
      const name=node(doc,'strong','',`${player.turnOrder??''} ${player.name}${player.id===view.selfId?' · 我':''}`.trim());name.title=player.name;
      const score=view?.game?.players.find(p=>p.id===player.id)?.score??0;
      row.append(name,node(doc,'small','',view.phase==='waiting'?(player.ready?'已准备':'未准备'):`${score}分${view.game?.guessedPlayerIds.includes(player.id)?' · 猜中了':''}`));return row;}));
    if(full){target.append(node(doc,'p','',`${view?.spectators?.length??0} 位观众${view?.selfRole==='spectator'?' · 你在观战':''}`));}
  }
  function render() {
    if(destroyed)return;
    const game=view?.game,terminal=['finished','aborted'].includes(view?.phase),drawer=view?.selfId===game?.turnPlayerId;
    $('drawing-gate').hidden=!!view;$('drawing-waiting').hidden=view?.phase!=='waiting';
    $('drawing-choosing').hidden=view?.phase!=='playing'||game?.stage!=='choosing'||!drawer;
    $('drawing-tools').hidden=!practice&&(!game||game.stage!=='drawing'||!drawer||terminal);
    $('drawing-guess-form').hidden=practice||!game||game.stage!=='drawing'||view.selfRole==='spectator'||drawer||terminal;
    $('drawing-guess-send').disabled=!available()||!game?.canGuess||clock.display().expired||composing;
    $('drawing-guess-input').disabled=!!view&&view.phase==='paused';
    $('drawing-guess-feedback').textContent=guessFeedback||(game?.guessedPlayerIds?.includes(view?.selfId)?'你猜中了，等本题揭晓。':'只有你看见提交的答案。');
    $('drawing-reveal').hidden=game?.stage!=='reveal'||terminal;
    $('drawing-result').hidden=!terminal;
    $('drawing-stage').textContent=practice?'自由练画 · 不判答案，不计分':drawingStageText(view);
    $('drawing-stage').title=$('drawing-stage').textContent;
    $('drawing-round').textContent=!practice&&game?`第${game.round}/${game.settings.rounds}轮 · ${game.turnNumber}/${game.totalTurns}题`:'';
    $('drawing-hint').hidden=!game?.hint&&!game?.word;
    $('drawing-hint').textContent=game?.word?`${drawer&&game.stage==='drawing'?'你的题目：':''}${game.word.answer}`:game?.hint?`${game.hint.categoryName} · ${game.hint.hintLength}字`:'';
    $('drawing-hint').title=$('drawing-hint').textContent;
    $('drawing-hint').classList.toggle('private-word',!!drawer&&game?.stage==='drawing');
    root.classList.toggle('drawing-is-drawer',!!drawer);root.classList.toggle('drawing-is-practice',practice);
    if(view?.phase==='waiting'){
      const me=view.players.find(p=>p.id===view.selfId),observer=view.selfRole==='spectator';
      $('drawing-waiting-text').textContent=`${view.players.length}/8位玩家 · ${view.spectators?.length??0}位观众`;
      $('drawing-ready').hidden=observer;$('drawing-ready').textContent=me?.ready?'取消准备':'准备好了';$('drawing-ready').disabled=!available();
      $('drawing-start').hidden=view.hostId!==view.selfId;$('drawing-start').disabled=!available()||view.players.length<2||!view.players.every(p=>p.ready)||!view.drawConfig?.contentSelection;
      $('drawing-role').textContent=observer?'加入对局':'改为观战';$('drawing-role').disabled=!available();
      const config=view.drawConfig;
      $('drawing-waiting-config').textContent=config?`每人${config.rounds}题 · 绘画${config.drawingSeconds}秒 · ${config.contentSelection?'已选择发布词库':'房主需先选择词库'}`:'';
      $('drawing-config-open').disabled=!available()||view.hostId!==view.selfId;
    }
    const candidates=game?.candidates??[];
    if(!$('drawing-choosing').hidden){$('drawing-candidates').replaceChildren(...candidates.map(word=>{const button=node(doc,'button','drawing-candidate',word.answer);button.type='button';button.disabled=!available()||!game.canChoose;
      button.append(node(doc,'small','',word.categoryName));listen(button,'click',()=>act('choose',{matchId:view.matchId,turnId:game.turnId,candidateId:word.id}));return button;}));}
    else $('drawing-candidates').replaceChildren();
    if(game?.word&&game.stage==='reveal'){$('drawing-answer').textContent=game.word.answer;$('drawing-aliases').textContent=game.word.aliases.length?'认可别名：'+game.word.aliases.join('、'):'';
      $('drawing-turn-result').textContent=`${game.guessedPlayerIds.length}人猜中 · 画者+${game.turnResult?.drawerScore??0}分`;}
    if(terminal){$('drawing-result-title').textContent=view.phase==='aborted'?'本局中止，不计输赢':game.result.winnerIds.length?'本局成绩':'本局无人猜中';
      $('drawing-results').replaceChildren(...(game?.result?.scores??game?.players?.map(p=>({playerId:p.id,score:p.score,rank:null}))??[]).map(score=>{const name=view.players.find(p=>p.id===score.playerId)?.name??'离席玩家';return node(doc,'li','',`${score.rank===null?'':score.rank+'名 · '}${name} · ${score.score}分`);}));
      $('drawing-rematch').disabled=!available()||view.hostId!==view.selfId;}
    renderRoster($('drawing-players'));if($('drawing-roster-dialog').open)renderRoster($('drawing-roster-full'),true);
    $('drawing-connection').textContent=practice?'仅本机':`${connection==='online'?'已连接':'连接恢复中'}${view?.roomCode?' · '+view.roomCode:''}`;
    const showRoomCode=!practice&&view?.phase==='waiting'&&!!view.roomCode;
    $('drawing-room-code').hidden=!showRoomCode;
    $('drawing-room-code').textContent=showRoomCode?'房间 '+view.roomCode:'';
    $('drawing-exit').disabled=leaving||!practice&&!view;
    $('drawing-copy').disabled=!view;
    $('drawing-waiting-copy').disabled=!view?.roomCode;
    $('drawing-pause').hidden=practice||!view||view.selfRole==='spectator'||!['playing','paused'].includes(view.phase);
    $('drawing-pause').textContent=view?.phase==='paused'?'继续对局':view?.pause?.agreedIds?.includes(view.selfId)?'撤回暂停同意':'同意暂停';
    $('drawing-resume').hidden=view?.phase!=='paused'||view?.selfRole==='spectator';
    $('drawing-host').hidden=!view?.hostCanTakeOver||view?.hostId===view?.selfId||view?.selfRole==='spectator';
    $('drawing-transfer-label').hidden=practice||!view||view.hostId!==view.selfId||view.players.length<2;
    const chosen=$('drawing-next-host').value;$('drawing-next-host').replaceChildren(...(view?.players??[]).filter(p=>p.id!==view.selfId).map(p=>{const option=node(doc,'option','',p.name);option.value=p.id;return option;}));
    if([...$('drawing-next-host').options].some(option=>option.value===chosen))$('drawing-next-host').value=chosen;
    $('drawing-save-note').textContent=practice?(view?.storageAvailable?'本机自由练画 · 自动保存':'仅保留本次窗口 · 浏览器不允许保存'):view?.selfRole==='spectator'?'观战 · 只读画布':'确认后自动保存';
    const unknown=!!getPending(),storage=!getStorageReady();$('drawing-recovery').hidden=!unknown&&!storage;
    $('drawing-recovery-text').textContent=storage?'浏览器无法保存操作，请允许本站存储后继续。':'上一操作尚未确认。先查看结果；重试保留原编号，不重复计分。';
    $('drawing-retry').hidden=!unknown;$('drawing-retry').disabled=!active()||busy;$('drawing-refresh').disabled=busy;
    paint.setContext(canvasContext());renderTools();fit();
  }
  function fit(){const frame=gameViewport({width:win.innerWidth,height:win.innerHeight,visual:win.visualViewport,
    editing:['INPUT','TEXTAREA','SELECT'].includes(doc.activeElement?.tagName)});
    for(const [name,value]of Object.entries({width:frame.width,height:frame.height,top:frame.top,left:frame.left}))root.style.setProperty('--drawing-'+name,`${value}px`);
    root.classList.toggle('drawing-keyboard-open',frame.height<win.innerHeight*.78&&doc.activeElement?.tagName==='INPUT');
    $('drawing-hide-keyboard').hidden=doc.activeElement!==$('drawing-guess-input');paint.fit();}
  const viewport=mountGameViewport({window:win,document:doc,sync:fit,recoveryDelays:[0,100,350],onRecover:()=>paint.finishPointer()});
  const audioControls=mountRoomAudioControls({audio,document:doc});
  const settings=mountRoomSettings({document:doc,buttonId:'drawing-settings',dialogId:'drawing-settings-dialog',closeButtonId:'drawing-settings-close'});
  const removePractice=practice?mountPracticeExit({document:doc,location:win.location}):()=>{};
  listen($('drawing-settings'),'click',()=>paint.finishPointer(),{capture:true});
  listen($('chat-toggle'),'click',()=>{paint.finishPointer();$('drawing-guess-input').blur();},{capture:true});
  listen($('drawing-rules-open'),'click',()=>{settings.close({restoreFocus:false});open('drawing-rules-dialog');});
  listen($('drawing-roster-open'),'click',()=>{settings.close({restoreFocus:false});renderRoster($('drawing-roster-full'),true);open('drawing-roster-dialog');});
  listen($('drawing-exit'),'click',()=>{$('drawing-leave-note').textContent=practice?'练画会保存在本机，下次主动进入可继续。':view?.selfRole==='spectator'?'退出观战，不改变朋友的对局。':roomExitExplanation(view?.phase);$('drawing-leave-status').textContent='';open('drawing-leave-dialog');});
  listen($('drawing-leave-confirm'),'click',()=>{if(practice){paint.finishPointer();replacePracticeWithLobby(win.location);}else onLeave();});
  listen($('drawing-ready'),'click',()=>act('ready',{ready:!view?.players.find(p=>p.id===view.selfId)?.ready}));
  listen($('drawing-start'),'click',()=>act('start'));
  listen($('drawing-role'),'click',()=>act('set-role',{role:view?.selfRole==='spectator'?'player':'spectator'}));
  listen($('drawing-rematch'),'click',()=>act('rematch'));
  listen($('drawing-pause'),'click',()=>act(view?.phase==='paused'?'resume':'pause',{...(view?.phase==='paused'?{}:{agree:!view?.pause?.agreedIds?.includes(view.selfId)})}));
  listen($('drawing-resume'),'click',()=>act('resume'));
  listen($('drawing-host'),'click',()=>act('transferHost',{playerId:view?.selfId}));
  listen($('drawing-transfer'),'click',()=>act('transferHost',{playerId:$('drawing-next-host').value}));
  async function copyInvitation(){if(!view?.roomCode)return;const href=new URL(`./?room=${view.roomCode}`,win.location.href).href;try{await win.navigator.clipboard.writeText(href);feedback('邀请链接已复制。');}catch{feedback('房间号 '+(view?.roomCode??''));}}
  listen($('drawing-copy'),'click',copyInvitation);listen($('drawing-waiting-copy'),'click',copyInvitation);
  listen($('drawing-recover'),'click',onRecover);listen($('drawing-refresh'),'click',onRefresh);listen($('drawing-retry'),'click',onRetry);
  async function loadConfigRelease() {
    const epoch=++configEpoch,pack=packs.find(pack=>pack.id===$('drawing-pack').value),roomId=view?.roomId;configRelease=null;$('drawing-config-save').disabled=true;
    if(!pack){$('drawing-config-status').textContent='请先在词库页发布可采用的词包。';return;}
    const saved=view.drawConfig?.contentSelection,version=saved?.packId===pack.id?saved.version:pack.publishedHead;
    try {
      const release=await api(`/api/wordbanks/${pack.id}/releases/${version}`);
      if(epoch!==configEpoch||destroyed||view?.roomId!==roomId||view.phase!=='waiting'||!$('drawing-config-dialog').open)return;
      const categories=release.categories.filter(category=>category.status==='active'),counts={};
      for(const word of release.words??[])if(word.status==='reviewed')counts[word.category]=(counts[word.category]??0)+1;
      configRelease={packId:pack.id,version,categories,counts};
      const checked=saved?.packId===pack.id&&saved.version===version?saved.categoryIds:['daily','nature','food','action-job','place-transport'];
      const difficulties=saved?.packId===pack.id&&saved.version===version?saved.difficulties:['easy','normal'];
      const panel=$('drawing-config-content');panel.replaceChildren(node(doc,'p','',`${pack.name} · 已发布版本${version}`));
      const categoryTitle=node(doc,'strong','','分类');panel.append(categoryTitle);
      for(const category of categories){const label=node(doc,'label','drawing-check');const input=node(doc,'input');input.type='checkbox';input.dataset.drawingCategory=category.id;
        input.checked=checked.includes(category.id);label.append(input,node(doc,'span','',`${category.name} · ${counts[category.id]??0}词`));panel.append(label);}
      if(!categories.some(category=>checked.includes(category.id)))panel.querySelector('[data-drawing-category]')?.click();
      panel.append(node(doc,'strong','','难度'));
      for(const [value,name]of [['easy','简单'],['normal','普通'],['hard','挑战']]){const label=node(doc,'label','drawing-check'),input=node(doc,'input');input.type='checkbox';input.dataset.drawingDifficulty=value;input.checked=difficulties.includes(value);label.append(input,node(doc,'span','',name));panel.append(label);}
      $('drawing-config-status').textContent='每题需3个不同候选，服务器开局时再次检查所选范围的词量。';$('drawing-config-save').disabled=false;
    }catch(error){if(epoch===configEpoch){$('drawing-config-status').textContent=gameErrorMessage(error);onCanvasError(error);}}
  }
  listen($('drawing-config-open'),'click',async()=>{
    if(!view?.drawConfig||view.hostId!==view.selfId)return;$('drawing-rounds').value=String(view.drawConfig.rounds);$('drawing-seconds').value=String(view.drawConfig.drawingSeconds);open('drawing-config-dialog');
    const epoch=++configEpoch,roomId=view.roomId;$('drawing-config-save').disabled=true;$('drawing-config-status').textContent='正在读取可采用的发布词包…';
    try{const data=await api('/api/wordbanks?limit=100');if(epoch!==configEpoch||destroyed||view?.roomId!==roomId||view.phase!=='waiting'||!$('drawing-config-dialog').open)return;
      packs=data.packs.filter(pack=>!pack.retired&&Number.isInteger(pack.publishedHead)&&pack.publishedHead>0);
      $('drawing-pack').replaceChildren(...packs.map(pack=>{const option=node(doc,'option','',pack.name+(pack.visibility==='private'?' · 我的私库':''));option.value=pack.id;return option;}));
      const selected=view.drawConfig.contentSelection?.packId??'dg-base';if(packs.some(pack=>pack.id===selected))$('drawing-pack').value=selected;
      await loadConfigRelease();
    }catch(error){if(epoch===configEpoch){$('drawing-config-status').textContent=gameErrorMessage(error);onCanvasError(error);}}
  });
  listen($('drawing-pack'),'change',loadConfigRelease);listen($('drawing-config-dialog'),'close',()=>{++configEpoch;configRelease=null;});
  listen($('drawing-config-save'),'click',async()=>{if(!view?.drawConfig||!configRelease||view.phase!=='waiting')return;
    const categoryIds=[...$('drawing-config-content').querySelectorAll('[data-drawing-category]:checked')].map(input=>input.dataset.drawingCategory);
    const difficulties=[...$('drawing-config-content').querySelectorAll('[data-drawing-difficulty]:checked')].map(input=>input.dataset.drawingDifficulty);
    if(!categoryIds.length||!difficulties.length){$('drawing-config-status').textContent='请至少选一个分类和一种难度。';return;}
    const value={rounds:Number($('drawing-rounds').value),drawingSeconds:Number($('drawing-seconds').value),contentSelection:{packId:configRelease.packId,version:configRelease.version,categoryIds,difficulties}};
    if(!Number.isInteger(value.drawingSeconds)||value.drawingSeconds<30||value.drawingSeconds>600){$('drawing-config-status').textContent='绘画时间需要30～600秒。';return;}
    if(await act('configure',{drawConfig:value}))$('drawing-config-dialog').close();});
  listen($('drawing-hide-keyboard'),'click',()=>{$('drawing-guess-input').blur();fit();});
  listen($('drawing-guess-input'),'compositionstart',()=>{composing=true;render();});listen($('drawing-guess-input'),'compositionend',()=>{composing=false;render();});
  listen($('drawing-guess-input'),'input',()=>{inputSerial++;saveDraft();});
  listen($('drawing-guess-form'),'submit',async event=>{
    event.preventDefault();if(composing||event.isComposing||!view?.game?.canGuess||!available())return;
    const text=$('drawing-guess-input').value,serial=inputSerial,capturedScope=scope,turnId=view.game.turnId,before=view.actionReceipts?.map(r=>r.requestId)??[];
    try{if(!normalizeDrawAndGuessGuess(text))throw new Error('请填写答案。');}catch(error){guessFeedback=error.message;render();return;}
    guessSubmission={scope:capturedScope,serial,turnId,before};
    const result=await act('guess',{matchId:view.matchId,turnId,text});
    if(!result||capturedScope!==scope)return;
    if(!guessSubmission)return; // The owning receipt may have arrived through SSE first.
    const receipt=guessSubmission?.requestId&&latestGuessReceipt(view,before,turnId,guessSubmission.requestId);
    if(!receipt){guessFeedback='提交尚未确认，输入仍保留。请先查看结果。';render();return;}
    confirmGuess(receipt);render();
  });
  function confirmGuess(receipt) {
    if(!guessSubmission||guessSubmission.scope!==scope)return;
    guessFeedback=receipt.guessResult.correct?`猜中了！+${receipt.guessResult.points}分。`:'还没猜对，换个答案再试。';
    if(guessSubmission.serial===inputSerial){$('drawing-guess-input').value='';saveDraft();}
    guessSubmission=null;audio.play(receipt.guessResult.correct?'commit':'select',{gesture:true});
  }
  async function act(type,fields={}) {
    if(!available())return false;paint.finishPointer();busy=true;render();
    try{const operation=onAction(type,fields),intent=getPending();
      if(type==='guess'&&guessSubmission&&intent?.type==='guess'&&intent.matchId===fields.matchId&&intent.turnId===fields.turnId)
        guessSubmission.requestId=intent.requestId;
      await operation;if(destroyed)return false;return true;}
    catch(error){if(!destroyed){feedback(gameErrorMessage(error));if(type==='guess')guessFeedback=gameErrorMessage(error);audio.play('invalid',{gesture:true});}return false;}
    finally{if(!destroyed){busy=false;render();}}
  }
  function applyView(next,{baseline:initial=false}={}) {
    if(destroyed)return;
    const previous=view,silent=baseline||initial||doc.hidden||connection!=='online';setScope(next);view=next;
    const receipt=guessSubmission?.requestId&&latestGuessReceipt(next,guessSubmission.before,guessSubmission.turnId,guessSubmission.requestId);if(receipt)confirmGuess(receipt);
    clock.receive(next);baseline=false;render();
    if(!silent&&previous?.matchId===next.matchId&&previous?.game?.revision<next.game?.revision) {
      if(next.game.stage==='finished')audio.play(next.game.result.winnerIds.includes(next.selfId)?'win':'draw-result');
      else if(previous.game.turnId!==next.game.turnId&&next.game.turnPlayerId===next.selfId)audio.play('turn');
      else if(previous.game.stage!==next.game.stage)audio.play(next.game.stage==='reveal'?'restore':next.game.stage==='drawing'?'start':'select');
      else if(next.game.lastAction?.type==='guess')audio.play('commit');
    }
    const cue=audio.phaseCue(previous,next,{baseline:silent});if(cue)audio.play(cue);
  }
  const page={audio,paint,applyView,setMessage:feedback,setConnection(value){connection=value;if(value!=='online'){baseline=true;paint.setContext(canvasContext(false));}render();},
    conceal({message='正在恢复账号与席位…',loginHref:href,reauthHref:reauth,preserveDraft=false}={}) {
      if(preserveDraft)saveDraft();else{try{const key=draftKey();if(key)draftStorage?.removeItem(key);}catch{}}
      scope=null;guessSubmission=null;inputSerial++;view=null;baseline=true;connection='offline';paint.conceal();clock.reset();
      for(const dialog of root.querySelectorAll('dialog[open]'))dialog.close();
      $('drawing-guess-input').value='';$('drawing-candidates').replaceChildren();$('drawing-answer').textContent='';$('drawing-hint').textContent='';
      for(const id of ['drawing-roster-full','drawing-results','drawing-config-content','drawing-pack'])$(id).replaceChildren();
      for(const id of ['drawing-aliases','drawing-turn-result','drawing-waiting-text','drawing-waiting-config','drawing-config-status'])$(id).textContent='';
      ++configEpoch;configRelease=null;packs=[];
      $('drawing-gate-text').textContent=message;$('drawing-login').hidden=!href;$('drawing-login').href=href??'#';$('drawing-reauth').hidden=!reauth;$('drawing-reauth').href=reauth??'#';$('drawing-recover').hidden=!!href;render();
    },
    leaveFailure(error){leaving=false;$('drawing-leave-status').textContent=typeof error==='string'?error:gameErrorMessage(error);render();},
    leaving(){leaving=true;paint.conceal();$('drawing-leave-status').textContent='正在确认退出…';render();},
    destroy(){if(destroyed)return;saveDraft();destroyed=true;paint.destroy();clock.destroy();viewport.destroy();settings.destroy();audioControls.destroy();audio.close();removePractice();listeners.forEach(remove=>remove());},
  };
  render();return page;
}
export const mountDrawingPage=createDrawingGamePage;

export function showDrawingBootFailure({document:doc=globalThis.document,window:win=globalThis.window}={}) {
  const root=doc.getElementById('drawing-root');if(!root)return;
  // Clear every private node before constructing a generic recovery view. A
  // rendering/programming exception is never displayed as raw server content.
  const card=node(doc,'section','drawing-card'),title=node(doc,'h1','','房间暂时无法恢复');
  const message=node(doc,'p','','原席位与已确认画布保持。请重新载入，或返回大厅。');
  const retry=node(doc,'button','primary-button','重新载入'),back=node(doc,'a','','返回大厅');
  retry.type='button';retry.addEventListener('click',()=>win.location.reload());back.href='./';
  card.append(title,message,retry,back);root.replaceChildren(card);
}

export async function bootDrawingRoom({document:doc=globalThis.document,window:win=globalThis.window}={}) {
  const roomCode=new URLSearchParams(win.location.search).get('code')??'';
  let client=null,view=null,chat=null,baseline=true,leaving=false,scope=null;
  const session=createRoomSession({document:doc,accountGeneration,accountState,getClient:()=>client});
  let lifecycle,fatal=false,removeAccount=()=>{};
  const ui=createDrawingGamePage({document:doc,window:win,mode:'room',
    onAction:async(type,fields)=>{const current=client,fence=session.capture(current);if(!current||!session.current(fence))throw new Error('请恢复房间后继续。');
      try{return await current.action(type,fields);}catch(error){if(session.current(fence)&&[401,503].includes(error.status))clearPrivate(error);throw error;}},
    canvasRequest:async(type,body)=>{const current=client,fence=session.capture(current);if(!current||!session.current(fence))throw new Error('请恢复账号与画布后继续。');
      return current.request(`/api/rooms/${roomCode}/canvas${type==='read'?'':'/'+type}`,{...(type==='read'?{}:{method:'POST',body}),token:current.membership.token},current.epoch());},
    onCanvasError:error=>{if([401,503].includes(error.status))clearPrivate(error);else ui.setMessage(gameErrorMessage(error));},
    getPending:()=>client?.pendingAction(),getStorageReady:()=>client?.actionStorageReady()??true,
    onRefresh:()=>client?.refresh(),onRetry:()=>client?.retryAction(),onRecover:()=>lifecycle?.refresh(),onLeave:()=>exit.run()});
  const exit=createRoomExit({session,roomCode,getClient:()=>client,getView:()=>view,forgetMembership,requireAcknowledgement:true,
    onPending:()=>{leaving=true;ui.leaving();},onFailure:error=>{leaving=false;ui.leaveFailure(error);},onLeft:()=>{exit.reset();scope=null;clearPrivate();win.location.href='./';}});
  function clearPrivate(error={},{preserveDraft=error.status===503}={}) {
    if(fatal)return;
    session.invalidate();const retired=client;client=null;view=null;baseline=true;leaving=false;retired?.stop();
    ui.conceal({message:error.status===503?'暂时无法核验账号，已保存画布与原席位保持。请重新连接。':error.status===401?'请重新登录，恢复原席位、题目与画布。':error.status===404?'房间或原席位已关闭，请返回大厅。':error.message??'正在核验账号并恢复原席位…',
      loginHref:error.status===401?loginHref(`/?room=${roomCode}`):null,reauthHref:error.status===401?reauthenticationHref():null,preserveDraft});
    chat?.clear({preserveDraft});
  }
  function failBootstrap() {
    if(fatal)return;fatal=true;session.destroy();client?.stop();client=null;view=null;removeAccount();lifecycle?.stop();
    try{ui.conceal();ui.destroy();}catch{ /* Emergency view below removes all private DOM even if rendering failed. */ }
    showDrawingBootFailure({document:doc,window:win});
  }
  const guarded=callback=>(...args)=>{try{return callback(...args);}catch{failBootstrap();}};
  function boot(verified) {return session.bootstrap(()=>clearPrivate({},{preserveDraft:true}),async task=>{
    try {
      const state=verified??await loadAccount();if(!session.current(task,{account:false,verified:false})||state.verification!=='verified')return;
      if(!/^\d{6}$/u.test(roomCode)){win.location.replace('./');return;}
      const legacy=state.mode==='legacy';if(!legacy&&!state.authenticated){clearPrivate({status:state.failureStatus===503||!state.loginReady?503:401});return;}
      let membership=legacy?loadMembership(roomCode):null,firstView=null;
      if(!legacy){try{firstView=(await api(`/api/rooms/${roomCode}`,{signal:task.controller.signal})).view;membership={roomCode,playerId:firstView.selfId,userKey:state.userKey};}
        catch(error){if(!session.current(task))return;if([403,404].includes(error.status)){win.location.replace(`./?room=${roomCode}`);return;}throw error;}}
      if(!session.current(task))return;if(!membership){win.location.replace(`./?room=${roomCode}`);return;}
      const nextScope=JSON.stringify([state.userKey??'legacy',roomCode,membership.playerId]);if(scope!==null&&scope!==nextScope)exit.reset();scope=nextScope;
      const next=new RoomClient(roomCode,membership,{onView:guarded(value=>{if(!session.current(fence))return;if(value.gameType!=='draw-and-guess'){win.location.replace(roomHref(roomCode,value.gameType));return;}view=value;ui.applyView(value,{baseline});baseline=false;}),
        onConnection:guarded(value=>{if(!session.current(fence))return;if(value!=='online')baseline=true;ui.setConnection(value);chat?.connection(value);}),
        onCanvas:guarded(packet=>{if(session.current(fence))ui.paint.receive(packet);}),onChat:guarded(packet=>{if(session.current(fence))chat?.receive(packet);}),
        onError:guarded(error=>{if(!session.current(fence)||leaving&&error.status===404)return;if(error.status===404&&view)forgetMembership(roomCode,view.selfId);
          if(error.status===404||!legacy&&[401,503].includes(error.status))clearPrivate(error);else ui.setMessage(gameErrorMessage(error));})});
      client=next;const fence=session.capture(next);if(firstView)next.receive(firstView);else await next.refresh();
      if(session.current(fence)){chat.attach(next,next.view,state);next.connect();}
    }catch(error){if(session.current(task,{verified:false}))clearPrivate(error);}
  });}
  chat=mountRoomChat({onCue:kind=>ui.audio.play(kind),onUnavailable:error=>clearPrivate(error.status===403?{...error,status:404}:error)});
  doc.getElementById('drawing-logout').addEventListener('click',async()=>{exit.reset();scope=null;clearPrivate();try{await logoutAccount();win.location.href='./';}catch{clearPrivate({status:503});}});
  removeAccount=onAccountChange(guarded(state=>{if(!state.authenticated&&state.mode!=='legacy'||client&&client.accountEpoch!==accountGeneration())clearPrivate({status:state.failureStatus===503?503:401});}));
  lifecycle=watchAccountLifecycle({windowRef:win,documentRef:doc,onSuspend:guarded(()=>clearPrivate({message:'正在重新核验账号…'},{preserveDraft:true})),
    onVerified:guarded(state=>{if(!client&&!fatal)Promise.resolve(boot(state)).catch(failBootstrap);}),onError:guarded(clearPrivate)});
  win.addEventListener('pagehide',event=>{if(!event.persisted){client?.stop();session.destroy();ui.destroy();}});
  // Installation controls never gate the authenticated room bootstrap.
  import('../../app-shell.mjs').catch(()=>{if(!fatal)ui.setMessage('安装说明暂未打开，房间可以继续使用。');});
  await lifecycle.refresh();return ui;
}
if(typeof document!=='undefined'&&document.body?.dataset.mode==='drawing-room')bootDrawingRoom().catch(()=>showDrawingBootFailure());
