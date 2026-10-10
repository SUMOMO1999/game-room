import { getDefinition, PASSIONS, CAMPING_FACES, CANTEENS, GEAR } from './content/catalog.mjs';
import { getSymbolSvg } from './content/vector-art.mjs';
import { renderCard, renderDetail, resourceLine, escapeHtml as esc, cardName, mountImageFallback } from './card-ui.mjs';
import { SITE_VIEWS, SAMPLE_PARKS, SCENES, PAYMENT_SAMPLE } from './preview-fixtures.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountRoomSettings } from '../../platform/room-settings.mjs';
import { mountGameViewport } from '../../platform/room-viewport.mjs';
import { gameViewport } from '../../game-viewport.mjs';
import { roomChatMarkup } from '../../room-chat.mjs';

const button = (id,label,extra='')=>`<button type="button" id="${id}" ${extra}>${label}</button>`;
const symbol = (id,size=28)=>getSymbolSvg(id,{size});
const dialog = (id,title,body)=>`<dialog id="${id}" class="pk-dialog"><div class="dialog-heading"><h2 id="${id}-title">${title}</h2>${button(`${id}-close`,'×',`class="close-button" aria-label="关闭${title}" data-close="${id}"`)}</div>${body}</dialog>`;

/** Projection-only Step 0. Callbacks simulate navigation; none can submit a game. */
export function mountParksPreviewPage({root,onScene,onLeave,onPeerMessage}={}) {
  const document=root.ownerDocument,window=document.defaultView;
  root.innerHTML=`<div class="pk-shell">
    <header class="pk-header"><div class="pk-brand"><strong>PARKS</strong><span>国家公园 <small>本地样板</small></span></div><button type="button" id="pk-room" class="pk-room">示例房号 <b>120063</b></button><div class="room-toolbar" data-chat-notice-anchor><div class="room-toolbar-actions">${button('chat-toggle','聊天 <span id="chat-unread" class="chat-unread" hidden></span>','class="room-toolbar-action" hidden aria-controls="room-chat" aria-expanded="false"')}${button('pk-settings','设置','class="room-toolbar-action"')}${button('pk-exit','×','class="room-toolbar-action room-toolbar-exit room-exit" aria-label="退出本地样板"')}</div></div></header>
    <div class="pk-layout"><aside class="pk-sidebar"><p class="pk-kicker">这一趟旅程</p><div id="pk-roster"></div><button id="pk-members" type="button">成员与顺序</button><button type="button" id="pk-project">本局志愿项目</button><div class="pk-season-stamps"><span class="is-current">春</span><span>夏</span><span>秋</span></div><p class="pk-side-note">两名徒步者<br>一趟三季旅行</p></aside>
    <main class="pk-main"><section class="pk-board"><header class="pk-stage"><div><span class="pk-kicker" id="pk-stage-kind">春季 · 第1 / 3季</span><h1 id="pk-stage-title">选一位徒步者，向前走。</h1></div><div class="pk-clock"><strong id="pk-clock">29:36</strong><small>定格示例</small></div></header>
      <div id="pk-board-content" class="pk-board-content"><section class="pk-trail-panel"><div class="pk-section-heading"><h2>步道</h2><span>起点 → 第5格公园 → 终点</span></div><div id="pk-trail" class="pk-trail"></div><p class="pk-trail-note">从左到右、逐行向前。每次只移动一名徒步者。</p></section><section class="pk-market-panel"><div class="pk-section-heading"><h2>公共公园</h2><button type="button" id="pk-market-next" aria-label="切换公园样板">换一组</button></div><div id="pk-market" class="pk-market"></div><p class="pk-market-note">轻点卡牌看费用与奖励，手里的资源不等于行动机会。</p></section></div>
      <div id="pk-scene-panel" class="pk-scene-panel" hidden></div>
    </section>
    <section class="pk-personal" id="pk-personal" aria-label="我的个人区域" data-chat-dismiss-notices><div class="pk-backpack"><div class="pk-section-heading"><h2>我的背包</h2><span id="pk-capacity">10 / 10</span></div><div class="pk-resources" id="pk-resources"></div><div class="pk-hikers">${button('pk-hiker-1',`${symbol('hiker',22)}<span>徒步者 1</span>`,'aria-pressed="true"')}${button('pk-hiker-2',`${symbol('hiker',22)}<span>徒步者 2</span>`,'aria-pressed="false"')}</div></div><div class="pk-personal-items" id="pk-personal-items"></div></section>
    <footer class="pk-action-bar" data-chat-dismiss-notices><p id="pk-feedback" role="status" aria-live="polite">资源与交互样板 · 尚非可玩的完整游戏</p><div id="pk-actions" class="pk-actions"></div></footer></main></div>
    <section class="pk-portrait" hidden><span class="pk-portrait-art">${symbol('trail',92)}</span><h1>横过来，展开这一趟旅程。</h1><p id="pk-portrait-state" role="status"></p><p>路线、公共公园和自己的背包会同时可见。已选卡牌会保留；聊天、设置和退出仍在上方。</p><a class="pk-link-button" href="./parks-catalog.html">先看看卡牌图鉴</a></section>
  </div>
  ${dialog('pk-options','设置',`<div class="game-settings-body"><section><h3>本地样板</h3><p>合成房间与固定牌面，不连接正式账号，不结算或保存对局。聊天通过本机服务连接合成伙伴。</p><label for="pk-scene">检查场景</label><select id="pk-scene">${SCENES.map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select><div class="game-settings-controls">${button('pk-peer-message','合成伙伴发言')}<a href="./parks-catalog.html" class="pk-link-button">完整内容图鉴</a></div></section><section><h3>声音与玩法</h3><div class="game-settings-controls">${button('sound-toggle','点按启声')}${button('pk-rules','玩法说明')}</div><div class="sound-settings"><label for="sound-volume">音效音量</label><input type="range" id="sound-volume" min="0" max="100" step="5" value="45"><select id="sound-preview-kind" aria-label="试听音效"><option value="select">选中</option><option value="placement">落点与资源</option><option value="turn">轮到你</option><option value="chat">聊天</option><option value="win">结束</option></select>${button('sound-preview','试听')}<span id="sound-preview-status" role="status"></span></div></section><section><h3>房间安排 · 合成演示</h3><div class="game-settings-controls">${button('pk-role','切换观战')}${button('pk-host','转交房主')}${button('pk-invite','复制样板邀请')}${button('pk-pause','暂停样板')}</div><p id="chat-legacy-note" hidden></p></section></div>`)}
  ${dialog('pk-detail','详情','<div id="pk-detail-content"></div>')}
  ${dialog('pk-leave','退出本地样板？',`<p>将返回本地入口。这里没有正式席位或需要清理的牌局。</p><div class="pk-dialog-actions">${button('pk-stay','继续查看')}${button('pk-leave-confirm','退出样板','class="pk-primary"')}</div>`)}
  ${roomChatMarkup()}`;
  const $=id=>document.getElementById(id),listeners=[],audio=createGameAudio();
  let view=null,marketOffset=0,campFace=0,closed=false;
  const audioControls=mountRoomAudioControls({audio,document});
  const settings=mountRoomSettings({document,buttonId:'pk-settings',dialogId:'pk-options',closeButtonId:'pk-options-close',dismissIds:['pk-peer-message','pk-rules','pk-role','pk-host','pk-invite','pk-pause']});
  const stopFallback=mountImageFallback(root);
  const listen=(target,event,fn)=>{target.addEventListener(event,fn);listeners.push(()=>target.removeEventListener(event,fn));};
  function feedback(text){$('pk-feedback').textContent=text;}
  function openDialog(id){for(const d of root.querySelectorAll('dialog[open]'))d.close();if(!$('room-chat').hidden)$('chat-close').click();$(id).showModal();}
  function details(title,body){$('pk-detail-title').textContent=title;$('pk-detail-content').innerHTML=body;openDialog('pk-detail');}
  function inspect(id){view.selectedCard=id;const c=getDefinition(id);details(cardName(c),renderDetail(id,{missing:view.scene==='missing'}));audio.play('select');}
  function renderMarket(){const ids=SAMPLE_PARKS.slice(marketOffset).concat(SAMPLE_PARKS.slice(0,marketOffset)).slice(0,3);$('pk-market').innerHTML=ids.map(id=>renderCard(id,{selected:id===view.selectedCard,missing:view.scene==='missing'})).join('');}
  function renderTrail(){
    $('pk-trail').innerHTML=SITE_VIEWS.map(({id,symbol:icon},i)=>{const site=getDefinition(id);return `<button type="button" class="pk-site${view.selectedSite===id?' is-selected':''}" data-site="${id}" aria-pressed="${view.selectedSite===id}" aria-label="第${i+1}格，${esc(site.nameZh)}，${esc(site.shortText)}"><span class="pk-site-number">${i+1}</span>${symbol(icon,32)}<strong>${esc(site.nameZh)}</strong><small>${esc(site.shortText)}</small>${i===1?'<span class="pk-piece" aria-label="我的徒步者1">1</span>':i===2?'<span class="pk-piece pk-peer-piece" aria-label="伙伴的徒步者">▲</span>':''}</button>`;}).join('');
  }
  function personal(){
    $('pk-resources').innerHTML=resourceLine(view.resources);$('pk-capacity').textContent=`${Object.values(view.resources).reduce((a,b)=>a+b,0)} / ${view.capacity}`;
    const dense=view.scene==='dense';
    $('pk-hiker-1').setAttribute('aria-pressed',String(view.selectedHiker===1));$('pk-hiker-2').setAttribute('aria-pressed',String(view.selectedHiker===2));
    $('pk-personal-items').innerHTML=[['campfire-off','营火 · 熄灭','campfire.extinguished'],['canteen','水壶 · 三行','canteen.mountain'],['passion','热忱 · 探险',PASSIONS[0].id],['gear',dense?'装备 · 12件':'装备 · 2件','gear.01'],['photo','照片 · 2张','photo']].map(([icon,label,id])=>`<button type="button" data-personal="${id}">${symbol(icon,26)}<span>${label}</span></button>`).join('');
  }
  function showCamps(){
    const face=CAMPING_FACES.find(f=>f.id=== (campFace?'camp.face.12':'camp.face.1'));
    details(face.nameZh,`<p>${symbol('tent',28)} 黄色帐篷 · 未占用。先确认营位和外层费用，再执行内部动作。营地内的购买／拍照仍需要支付。</p><div class="pk-camp-grid">${face.slots.map(slot=>`<button type="button" data-camp="${slot.id}"><strong>营位 ${slot.position}</strong><span>${esc(slot.outerCost.descriptionZh)}</span><small>${slot.effectSteps.map(s=>esc(s.descriptionZh)).join(' → ')}</small></button>`).join('')}</div><button type="button" id="pk-flip-camp">翻看这块板的另一面</button><p class="pk-note">本地面板示范；未占用营位、未扣费。</p>`);
  }
  function renderScene(){
    const scene=view.scene, special=['waiting','passion','teddy','season','paused','result','solo-result','payment','empty-pool'].includes(scene);
    $('pk-board-content').hidden=special;$('pk-scene-panel').hidden=!special;
    const panel=$('pk-scene-panel'); panel.innerHTML='';
    if(scene==='waiting')panel.innerHTML=`<div class="pk-waiting"><span class="pk-kicker">准备出发</span><h2>把日常，留在步道起点。</h2><p>示例房间 <b>120063</b> · 2位合成成员</p><p>标准2人 · 露营开启 · 志愿项目1张</p><div class="pk-dialog-actions">${button('pk-ready',view.players[0].ready?'取消准备':'准备好了')}${button('pk-start','开始样板',`class="pk-primary" ${view.players[0].ready?'':'disabled'}`)}</div><button type="button" id="pk-wait-invite">复制样板邀请</button></div>`;
    if(scene==='passion')panel.innerHTML=`<div class="pk-choice-heading"><h2>选一份热忱，带着它出发。</h2><p>只显示自己的候选；确认后不能重抽。</p></div><div class="pk-choices">${PASSIONS.slice(0,2).map(p=>`<button type="button" data-passion="${p.id}"><strong>${esc(p.nameZh)}</strong><span>${esc(p.goalText)}</span><small>达成后：能力／终局计分二选一</small></button>`).join('')}</div>`;
    if(scene==='teddy')panel.innerHTML=`<div class="pk-choice-heading"><h2>Teddy 已翻牌，先移动哪组？</h2><p>选择处理顺序，不重抽卡。当前待选时间29:36。</p></div><div class="pk-choices">${['青绿','紫罗兰'].map((name,i)=>`<button type="button" data-teddy="${i}">${symbol('teddy',56)}<strong>先处理${name}组</strong></button>`).join('')}</div><div class="pk-dialog-actions"><button type="button" data-card-id="teddy.1">查看Teddy第1张</button><button type="button" data-card-id="teddy.4">查看Teddy第4张</button></div>`;
    if(scene==='season')panel.innerHTML=`<div class="pk-choice-heading"><h2>春季奖励：预订一座公园。</h2><p>背包森林数最多且至少1个的玩家获得奖励；并列者都获得。<br>本示例：我2个，伙伴1个。预订只归入个人预订区，不直接得分。</p></div><div class="pk-choices">${button('pk-season-choice','选择预订公园','class="pk-primary"')}${button('pk-season-finish','放弃本次奖励机会')}</div>`;
    if(scene==='payment')panel.innerHTML=`<div class="pk-choice-heading"><h2>游览拱门 · 先核清这一笔。</h2><p>固定支付示例：本场景启用碳补偿项目，选择额外支付1森林。</p></div><div class="pk-payment"><div><strong>支付前</strong>${resourceLine(PAYMENT_SAMPLE.before)}</div><div><strong>印刷费用</strong>${resourceLine(PAYMENT_SAMPLE.printed)}</div><div><strong>项目附费</strong>${resourceLine(PAYMENT_SAMPLE.surcharge)}</div><div><strong>支付后</strong>${resourceLine(PAYMENT_SAMPLE.after)}</div></div><p>所得：拱门归入已游览区，获得3分；无即时资源奖励。确认仅演示，不修改背包。</p><div class="pk-dialog-actions">${button('pk-payment-rules','查看附费规则')}${button('pk-confirm-choice','确认这笔支付（样板）','class="pk-primary"')}</div>`;
    if(scene==='empty-pool')panel.innerHTML=`<div class="pk-choice-heading"><h2>太阳池为空，先别花掉资源。</h2><p>第1面营位3：支付1山 → 获取5太阳。<br>固定反例：池内0太阳，实际所得为0，本次付费行动不可执行。</p></div><div class="pk-dialog-actions"><button type="button" data-card-id="camp.face.1.slot.3">查看营位费用</button>${button('pk-unavailable-payment','无法支付 · 无可领取资源','disabled aria-describedby="pk-empty-reason"')}</div><p id="pk-empty-reason">山岳保留在背包。换一个营位或返回选择，不把0收益当作成功。</p>`;
    if(scene==='paused')panel.innerHTML=`<div class="pk-waiting">${symbol('campfire-off',56)}<h2>旅程暂歇 · 恢复示意</h2><p>超时暂停 · 当前责任人：我<br>继续后给当前窗口30分钟，已翻Teddy牌不重抽。</p>${button('pk-resume','继续当前选择','class="pk-primary"')}</div>`;
    if(scene.includes('result'))panel.innerHTML=`<div class="pk-result"><div><span class="pk-kicker">三季走完了</span><h2>${scene==='solo-result'?'一日行者':'这一趟，收获满满。'}</h2><p>${scene==='solo-result'?'单人34分 · 志愿项目1张':'我 34分 · 伙伴31分'}</p><p class="pk-note">固定计分展示，尚无真实对局结算。</p></div><dl><div><dt>7座公园</dt><dd>23</dd></div><div><dt>照片</dt><dd>3</dd></div><div><dt>照片排名</dt><dd>0</dd></div><div><dt>游泳热忱</dt><dd>4</dd></div><div><dt>秋季奖励</dt><dd>3</dd></div><div><dt>起始玩家</dt><dd>1</dd></div><div><dt>合计</dt><dd>34</dd></div></dl>${button('pk-again','再看准备室','class="pk-primary"')}</div>`;
  }
  function actions(){
    const canAct=['active','dense','missing','camping'].includes(view.scene)&&view.selfRole==='player';
    $('pk-actions').innerHTML=view.scene==='waiting'?'':view.scene==='camping'?button('pk-camps','选择营位','class="pk-primary"'):['paused','passion','teddy','season','result','solo-result','payment','empty-pool'].includes(view.scene)?'':`${button('pk-personal-detail','查看个人区')}${button('pk-move',view.selectedSite?'查看前往方案':'选择目的地',`class="pk-primary" ${canAct&&view.selectedSite?'':'disabled'}`)}`;
  }
  function applyView(next){
    view=next;root.dataset.scene=view.scene;$('pk-scene').value=view.scene;
    $('pk-stage-title').textContent=({waiting:'准备出发。',passion:'选择这趟旅程的热忱。',teddy:'Teddy批次 · 由我选择颜色顺序',season:'春季奖励 · 轮到我领取',paused:'当前选择暂停中。',result:'旅程结束 · 多人计分示意', 'solo-result':'旅程结束 · 官方单人计分示意',payment:'支付确认 · 费用与收益先看清', 'empty-pool':'库存不足 · 资源仍在自己手里',opponent:'伙伴正在选择，稍等片刻。',spectator:'观战中 · 跟着他们的脚步',camping:'进入营地，还是留在步道？',dense:'旅程渐丰，个人物件仍清楚。',missing:'插画失败，牌面信息仍保留。'})[view.scene]||'选一位徒步者，向前走。';
    $('pk-portrait-state').textContent=`${SCENES.find(([id])=>id===view.scene)[1]} · ${view.selfRole==='spectator'?'观战':view.scene==='opponent'?'伙伴正在选择':'我（合成）'} · ${view.phase==='paused'?'已暂停':view.phase==='finished'?'已完成':'春季 29:36（示例）'}`;
    $('pk-roster').innerHTML=view.players.map((p,i)=>`<div class="pk-player${i===0?' is-self':''}"><span>${i===0?'●':'▲'}</span><div><strong>${esc(p.name)}</strong><small>${view.phase==='waiting'?(p.ready?'已准备':'未准备'):i===0?(view.scene==='opponent'?'等待伙伴':'本人'):view.scene==='opponent'?'正在行动':'下一位'}</small></div></div>`).join('');
    $('pk-personal').hidden=view.selfRole==='spectator';$('pk-clock').textContent=view.phase==='paused'?'已暂停':view.phase==='finished'?'已完成':'29:36';
    root.querySelector('.pk-main').classList.toggle('no-personal',view.selfRole==='spectator');
    renderScene();renderMarket();renderTrail();personal();actions();
  }
  async function invite(){try{await window.navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?enter=1&scene=waiting`);feedback('本地样板地址已复制；只有这台电脑能访问。');}catch{details('本地样板邀请',`<p>此本机地址可复制查看，不是正式房号邀请：</p><p class="pk-copy-url">${esc(window.location.origin+window.location.pathname+'?enter=1&scene=waiting')}</p>`);}}
  listen(root,'change',e=>{if(e.target.id==='pk-scene'){settings.close();onScene(e.target.value);}});
  listen(root,'click',event=>{
    const node=event.target.closest('button');if(!node||node.disabled)return;
    if(node.dataset.close){$(node.dataset.close).close();return;}
    if(node.dataset.cardId){inspect(node.dataset.cardId);return;}
    if(node.dataset.site){view.selectedSite=node.dataset.site;renderTrail();actions();feedback(`已选${cardName(getDefinition(view.selectedSite))}，确认前可查看方案。`);audio.play('select');return;}
    if(node.dataset.personal){
      if(node.dataset.personal==='canteen.mountain')details('我的水壶行',`<div class="pk-canteen-rows"><section><h3>第1行 · 尚未填水</h3>${renderCard(CANTEENS[0].id)}${renderCard(CANTEENS[1].id)}</section><section><h3>第2行 · 已填水</h3>${renderCard(CANTEENS[2].id)}<span class="pk-empty-slot">空槽</span></section><section><h3>第3行 · 尚未填水</h3><span class="pk-empty-slot">空槽</span><span class="pk-empty-slot">空槽</span></section></div><p>只可用新获得的水填行。一枚水触发本行两个既有水壶，各执行一次。</p>`);
      else if(node.dataset.personal==='gear.01')details('我的装备',`<div class="pk-item-list">${(view.scene==='dense'?GEAR.slice(0,12):[getDefinition('gear.01'),getDefinition('gear.10')]).map(g=>`<button type="button" data-card-id="${g.id}"><strong>${esc(g.nameZh)}</strong><span>${esc(g.shortText)}</span></button>`).join('')}</div>`);
      else inspect(node.dataset.personal);return;
    }
    if(node.dataset.reserve){details('确认预订',`${renderDetail(node.dataset.reserve)}<p>本次预订免费；实际游览仍需支付牌面资源。</p>${button('pk-confirm-choice','确认预订（样板）','class="pk-primary"')}`);return;}
    if(node.dataset.passion){details('确认热忱',`${renderDetail(node.dataset.passion)}<button type="button" id="pk-confirm-choice" class="pk-primary">选择这份热忱（样板）</button>`);return;}
    if(node.dataset.teddy!==undefined){feedback(`已演示第${Number(node.dataset.teddy)+1}组先行；没有进行规则移动。`);audio.play('placement');return;}
    if(node.dataset.camp){details('露营前确认',`${renderDetail(node.dataset.camp)}${node.dataset.camp==='camp.face.1.slot.3'?'<p>固定账示例：支付前山2、森林1、太阳1、水1（共5）；支付1山，无项目附费；池内太阳足够时领取5太阳。余额山1、森林1、太阳6、水1（共9），未超容量10。</p>':''}<p>先看清外层费用和内部费用，再进入。样板只演示确认流程。</p><div class="pk-dialog-actions">${button('pk-camps','重新选营位')}${button('pk-confirm-choice','确认营位（样板）','class="pk-primary"')}</div>`);return;}
    switch(node.id){
      case 'pk-exit':openDialog('pk-leave');break;
      case 'pk-stay':$('pk-leave').close();break;
      case 'pk-leave-confirm':onLeave();break;
      case 'pk-room':case 'pk-invite':case 'pk-wait-invite':void invite();break;
      case 'pk-peer-message':onPeerMessage();break;
      case 'pk-role':onScene(view.selfRole==='spectator'?'waiting':'spectator');break;
      case 'pk-host':details('转交房主',`<p>仅合成演示，确认不会改变正式房间。</p>${button('pk-confirm-choice','转交给山野里的漫游伙伴','class="pk-primary"')}`);break;
      case 'pk-pause':onScene('paused');break;
      case 'pk-resume':onScene('active');break;
      case 'pk-ready':view.players[0].ready=!view.players[0].ready;applyView(view);break;
      case 'pk-start':case 'pk-confirm-choice':$('pk-detail').close();onScene('active');feedback('确认流程已演示；没有提交正式游戏动作。');break;
      case 'pk-again':onScene('waiting');break;
      case 'pk-hiker-1':case 'pk-hiker-2':view.selectedHiker=node.id.endsWith('1')?1:2;for(const id of [1,2])$('pk-hiker-'+id).setAttribute('aria-pressed',String(view.selectedHiker===id));audio.play('select');break;
      case 'pk-market-next':marketOffset=(marketOffset+1)%SAMPLE_PARKS.length;renderMarket();break;
      case 'pk-camps':showCamps();break;
      case 'pk-flip-camp':campFace=1-campFace;showCamps();break;
      case 'pk-payment-rules':inspect(PAYMENT_SAMPLE.projectId);break;
      case 'pk-season-choice':details('选择预订公园',`<p>预订一座，留待后续公园行动支付费用后游览。样板仅演示选择。</p><div class="pk-reserve-list">${SAMPLE_PARKS.slice(0,3).map(id=>`<button type="button" data-reserve="${id}">${esc(cardName(getDefinition(id)))}</button>`).join('')}</div>`);break;
      case 'pk-season-finish':onScene('active');feedback('已演示结束奖励窗口，不是结束普通回合。');break;
      case 'pk-move':{const site=getDefinition(view.selectedSite);details('确认前往',`<h3>徒步者${view.selectedHiker} → ${esc(site.nameZh)}</h3><p>${esc(site.shortText)}</p><p>样板目标未占用 · 不消耗营火<br>资源池、费用和真实可走条件会由后续规则核心核验。</p><div class="pk-dialog-actions">${button('pk-detail-cancel','再想一下','data-close="pk-detail"')}${button('pk-confirm-choice','确认前往（样板）','class="pk-primary"')}</div>`);break;}
      case 'pk-members':details('成员与行动顺序','<p>1 · 我（合成）<br>2 · 山野里的漫游伙伴（合成）</p><p>已到終点的成员不再行动。Teddy是独立规则控制者，不占真人席位。</p>');break;
      case 'pk-project':inspect('volunteer.responsible-consumption');break;
      case 'pk-personal-detail':details('我的旅程',`<p>背包 ${resourceLine(view.resources)}</p><p>本局负责任消费：买过2件装备，容量12 → 10。免费获得的装备不计入购买次数。</p><div class="pk-dialog-actions">${button('pk-project','本局志愿项目')}${button('pk-members','成员与顺序')}</div><p></p><button type="button" data-personal="canteen.mountain">查看水壶三行</button><div class="pk-item-list">${[PASSIONS[0].id,'gear.01','gear.10','campfire.extinguished','photo'].map(id=>`<button type="button" data-card-id="${id}">${esc(cardName(getDefinition(id)))}</button>`).join('')}</div>`);break;
      case 'pk-rules':details('怎样开始一趟旅程？','<ol><li>每回合移动自己一名徒步者，只能向前。</li><li>地点给予资源或行动机会，公共公园第5格固定。</li><li>游览公园、拍照和完成热忱得分，三季后结算。</li><li>露营改走营位分支；Teddy按牌自动行动，不是普通电脑。</li></ol><p>这里只演示资源与交互。完整规则、电脑与正式联机按计划后续接入。</p>');break;
    }
  });
  listen($('pk-settings'),'click',()=>{if(!$('room-chat').hidden)$('chat-close').click();});
  listen($('chat-toggle'),'click',()=>{for(const d of root.querySelectorAll('dialog[open]'))d.close();});
  const viewport=mountGameViewport({window,document,recoveryDelays:[80,250],sync(){
    const f=gameViewport({width:window.innerWidth,height:window.innerHeight,visual:window.visualViewport,editing:document.activeElement?.matches('input,textarea')});
    root.style.setProperty('--pk-height',`${f.height}px`);root.style.setProperty('--pk-top',`${f.top}px`);
    const portrait=window.innerWidth<window.innerHeight;root.querySelector('.pk-portrait').hidden=!portrait;root.querySelector('.pk-layout').inert=portrait;document.body.classList.toggle('pk-portrait-mode',portrait);
    if(f.resetScroll&&(window.scrollY||window.scrollX))window.scrollTo(0,0);
  }});
  return {audio,applyView,feedback,destroy(){if(closed)return;closed=true;listeners.forEach(remove=>remove());viewport.destroy();settings.destroy();audioControls.destroy();audio.destroy?.();stopFallback();}};
}
