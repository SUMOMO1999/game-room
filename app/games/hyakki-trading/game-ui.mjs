import { mountHandDrag } from './hand-drag-ui.mjs';
import { mountDigitalPage } from './digital-page-ui.mjs';
import { renderCardDetails, renderGoodsIcon } from './digital-card-ui.mjs';
import { dialogPage, renderDialogPager, renderCompactCard, renderCompactCards, renderDialogBody } from './game-dialog-ui.mjs';
import { GOODS, getCard } from './content/definitions.mjs';
import { choiceModel, buildChoiceSelection, defaultChoiceInput, knownCards, actionDraft, cardKey, goodsTotal, tableProjection } from './game-ui-model.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const button = (action, label, fields = {}, disabled = false) => `<button type="button" data-hy-action="${action}" data-hy-fields="${esc(JSON.stringify(fields))}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
const goodName = id => GOODS.find(good => good.id === id)?.name ?? '货物';
const titleByKind = {'retain-goods':'选择要留下的货物','take-card':'卦师 · 留下一张','tool-two-cards':'两仪灯 · 自留一张，另一张给对方','discard-hand':'弃牌至剩三张','tool-discard-draw':'弃一或两张，再抽同样张数','auction-goods':'挑选两件完整拍品','sell-goods':'挑选三件出售货物','sell-stock':'选择出售的库存','draft-card':'县丞 · 公开手牌重分','draft-good':'都尉 · 货物重分','draft-tool':'太守 · 道具重分','keep-tool':'夜行 · 只留一件道具','borrow-tool':'术士 · 是否借用该道具','benefit-branch':'员外 · 选择自己的收益','benefit-good':'选择收益货物','trade-card':'买办 · 选择三件货物牌','hand-branch':'讼师 · 选择效果','tribute-branch':'河伯 · 付钱或让对方抽牌','tool-search-payment':'貔貅袋 · 支付取牌费用','tool-exchange':'回天符 · 双方各换一件','tool-payment-good':'无二盏 · 选择货物与支付牌'};
const branchLabel = (kind, branch) => kind === 'tribute-branch' ? branch === 'pay' ? '付给对方2两' : '让对方抽2张'
  : kind === 'hand-branch' ? branch === 'draw' ? '自己补足5张手牌' : '让对方弃到3张'
  : branch === 'draw' ? '自己抽2张，对方得货物' : '自己得货物，对方抽2张';
function choiceLabel(option, kind, cards) {
  const name = id => { const card = cards.get(id); return card ? getCard(card.definitionId).name : '所选牌'; };
  if (option.cardId) return name(option.cardId);
  if (option.branch) return branchLabel(kind, option.branch);
  if (option.borrow !== undefined) return option.borrow ? '免费借用效果，照付该道具费用' : '不借用，完成人物效果';
  if (option.kind === 'silver') return '支付1两取走货物牌';
  if (option.payment) return `${option.payment.zone === 'tool' ? '弃掉已装道具' : '弃掉手牌'}：${name(option.payment.cardId)}`;
  if (option.goodsId || option.goodId) return goodName(option.goodsId ?? option.goodId);
  if (option.fromGoodsId) return `${goodName(option.fromGoodsId)}全部换成${goodName(option.toGoodsId)}`;
  return '选择此项';
}
export function renderChoiceForm(pending, game, draft = defaultChoiceInput(pending), pageNumber = 0) {
  const model = choiceModel(pending), cards = knownCards(game); if (!model) return '';
  const cardOption = (id, input) => {const card = cards.get(id);return `<label class="hy-choice-card">${input}${card ? renderCompactCard(card, {readButton:false}) : '<span>当前候选牌</span>'}${card ? `<button type="button" data-hy-detail="${esc(id)}">完整牌文</button>` : ''}</label>`;};
  if (model.type === 'goods') return `<p>选择${model.minimum === model.maximum ? model.minimum : `${model.minimum}～${model.maximum}`}件。${model.raw ? `普通格${model.ordinaryCapacity}，新占临时格另付${model.temporaryFee}两；其余退回公库。` : ''}</p><div class="hy-goods-choice">${GOODS.map(good=>`<label>${renderGoodsIcon(good.id)}<span>${good.name} · 共${model.stock[good.id]}</span><input type="number" inputmode="numeric" name="good-${good.id}" min="0" max="${model.stock[good.id]}" step="1" value="${draft.goods?.[good.id]??0}" aria-label="保留或选择${good.name}数量"></label>`).join('')}</div>`;
  if (model.type === 'cards') {
    const page=dialogPage(model.cardIds,pageNumber);
    return `<p>请选择${model.minimum === model.maximum ? model.minimum : `${model.minimum}～${model.maximum}`}张 · 已选${draft.cardIds?.length??0}张</p><div class="hy-choice-cards" style="--hy-card-count:${page.items.length}">${page.items.map(id=>cardOption(id,`<input type="checkbox" name="cardIds" value="${esc(id)}" ${(draft.cardIds??[]).includes(id)?'checked':''}>`)).join('')}</div>${renderDialogPager(page)}`;
  }
  const select = (name, label, options, value) => `<label>${label}<select name="${name}">${options.map(option=>`<option value="${esc(option.value)}" ${String(option.value)===String(value)?'selected':''}>${esc(option.label)}</option>`).join('')}</select></label>`;
  const goodsOptions = values => values.map(id=>({value:id,label:goodName(id)}));
  if (model.type === 'exchange') return `<div class="hy-field-grid">${select('ownGoodId','交出我的货物',goodsOptions(model.own),draft.ownGoodId)}${select('otherGoodId','换取对方货物',goodsOptions(model.other),draft.otherGoodId)}</div>`;
  if (model.type === 'payment-good') return `<div class="hy-field-grid">${select('goodId','取得公库货物',goodsOptions(model.goods),draft.goodId)}${select('paymentIndex','弃掉自己的牌',model.payments.map((payment,index)=>({value:index,label:choiceLabel({payment},pending.choice.kind,cards)})),draft.paymentIndex)}</div>`;
  const page=dialogPage(model.options,pageNumber);
  return `${pending.privatePool?'':`<p>选择一项 · 共${model.options.length}项</p>`}<div class="hy-choice-cards" style="--hy-card-count:${page.items.length}">${page.items.map((option,offset)=>{const index=page.start+offset,radio=`<input type="radio" name="optionIndex" value="${index}" ${draft.optionIndex===index?'checked':''}>`;return option.cardId ? cardOption(option.cardId,radio) : `<label class="hy-choice-text">${radio}<span>${esc(choiceLabel(option,pending.choice.kind,cards))}</span></label>`;}).join('')}</div>${renderDialogPager(page)}`;
}
export function publicEventText(event, players = []) {
  const actor = players.find(player=>player.id===event.actorSeatId)?.name ?? '玩家';
  const card = event.cardId ? (()=>{try{return getCard(event.cardId).name;}catch{return '卡牌';}})() : '';
  const labels={'match-started':'夜市开张','draw-peeked':`${actor}看了一张牌`,'draw-kept':`${actor}留下所看牌`,'draw-discarded':`${actor}弃掉${card}`,'draw-finished':`${actor}进入用牌阶段`,'turn-ended':`${actor}结束回合`,'character-played':`${actor}使用${card}`,'tool-installed':`${actor}安装${card}`,'tool-activated':`${actor}使用道具${card}`,'trade-bought':`${actor}买入货物，付${event.silver??0}两`,'trade-sold':`${actor}出售货物，得${event.silver??0}两`,'response-played':`${actor}以${card}回应`,'response-declined':`${actor}不回应`,'choice-resolved':`${actor}完成选择`,'bid-raised':`${actor}报价${event.silver??event.amount??0}两`,'bid-passed':`${actor}放弃竞价`,'auction-settled':`${players.find(player=>player.id===event.targetSeatId)?.name??'玩家'}以${event.silver??0}两取得整组拍品`,'auction-passed':'双方放弃，拍品退回','stall-expanded':`${actor}扩摊`,'paused':'双方暂停夜市','suspended':'夜市挂起，保留当前步骤','resumed':'夜市继续','match-ended':'本局结束','cards-revealed':`${actor}公开候选牌`,'search-revealed':`${actor}完成貔貅袋搜寻`};
  return labels[event.type] ?? '公开步骤已更新';
}

/** Real room UI. Only privateView/spectatorView enter; server commands own all effects. */
export function mountHyakkiPage({root,practice=false,onAction=()=>{},onLeave=()=>{},onRefresh=()=>{},onRetry=()=>{},onRecover=()=>{},onHistory=async()=>null}={}) {
  const document=root.ownerDocument,window=document.defaultView,$=id=>document.getElementById(id);
  let room=null,state={connection:'online',pending:false,canAct:true},destroyed=false,concealed=false,generation=0,scope=null,decisionId=null,presentedDecisionId=null;
  let detail=null,choiceDraft=null,choicePage=0,cardsPage=0,history=null,historyBusy=false,practiceActions={},leaveWorking=false,destination='lobby';
  let receivedAt=0,serverTime=0;
  const base=mountDigitalPage({root,scenes:[],externalDecisions:true,onAction:()=>{},onLeave:()=>leave()});
  root.classList.add('hy-real');
  const feedback = text => {
    base.feedback(text);
    const modal=root.querySelector('dialog[open]');
    if(modal){let note=modal.querySelector('[data-hy-error]');if(!note){note=document.createElement('p');note.dataset.hyError='true';note.setAttribute('role','alert');modal.querySelector('.dialog-heading').after(note);}note.textContent=text;}
  };
  function listen(type,handler){root.addEventListener(type,handler,true);return()=>root.removeEventListener(type,handler,true);}
  const selectionScope = value => [value?.roomId,value?.game?.matchId,value?.selfId,value?.selfRole,value?.phase,value?.game?.turnId,value?.game?.stage,value?.game?.actionsUsed,value?.game?.pending?.decisionId].join(':');
  const sameScope = value => [value?.roomId,value?.matchId??value?.game?.matchId,value?.selfId,value?.selfRole].join(':');
  const available = () => !!room&&!concealed&&!destroyed&&!state.pending&&state.canAct!==false&&state.connection==='online';
  const mine = () => room?.selfRole==='player'&&room.game?.pending?.actorId===room.selfId;
  const active = () => available()&&room.phase==='playing'&&room.selfRole==='player'&&room.game?.turnPlayerId===room.selfId&&!room.game.pending;
  const name = id => [...(room?.players??[]),...(room?.matchPlayers??[])].find(player=>player.id===id)?.name ?? '伙伴';
  const cardList = cards => renderCompactCards(cards,cardsPage);
  function closeDialogs(){root.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());}
  function inspect(title,content){closeDialogs();$('yg-inspector-title').textContent=title;$('yg-inspector-body').innerHTML=renderDialogBody(content);$('yg-inspector').showModal();}
  function readCard(card){if(!card)return;const face=getCard(card.definitionId??card.id);$('hy-reader-title').textContent=face.name+' · 完整牌文';$('hy-reader-body').innerHTML=renderDialogBody(renderCardDetails(face));if(!$('hy-card-reader').open)$('hy-card-reader').showModal();}
  function dispatch(type,fields={},onCommitted=null) {
    if(!available())return;
    const stamp=generation,current=scope;
    try{Promise.resolve(onAction(type,structuredClone(fields))).then(result=>{if(result!==false&&!destroyed&&stamp===generation&&current===scope)onCommitted?.();}).catch(error=>{if(!destroyed&&stamp===generation&&current===scope&&error?.name!=='AbortError')feedback(error.message||'操作未完成。');});}
    catch(error){feedback(error.message||'操作未完成。');}
  }
  async function leave(){if(leaveWorking||destroyed)return;leaveWorking=true;$('yg-leave-confirm').disabled=true;const stamp=generation;try{await onLeave({destination});}catch(error){if(stamp===generation&&!destroyed)leaveFailure(error.message||'退出未确认，请重试。');}finally{if(stamp===generation&&!destroyed){leaveWorking=false;$('yg-leave-confirm').disabled=false;}}}
  function leaveFailure(message){leaveWorking=false;$('yg-leave-confirm').disabled=false;feedback(message);$('hy-leave-note').textContent=message;}
  function selectedCardContent(card,tool=false){
    const face=getCard(card.definitionId),self=room.game?.players.find(player=>player.id===room.selfId),peer=room.game?.players.find(player=>player.id!==room.selfId);
    let operations='';
    if(active()&&(tool||self?.hand?.some(item=>cardKey(item)===cardKey(card)))){
      if(tool){if(!card.exhausted&&(face.sourceCode==='T07'?room.game.stage==='draw'&&!room.game.drawStarted:room.game.stage==='use'))operations=button('confirm-card','使用道具 · 1行动',{type:'activate-tool'});else operations='<p>已横置或不在使用时机。</p>';}
      else if(['C04','C07'].includes(face.sourceCode))operations='<p>只可在对应的回应窗口使用。</p>';
      else if(room.game.stage==='draw')operations=button('begin-play','进入用牌',{cardId:cardKey(card)});
      else if(face.category==='goods')operations=button('confirm-card',`整组买入 · ${Math.max(0,face.buySilver-2*room.game.bookLayers)}两`,{type:'buy'})+button('confirm-card',`整组出售 · ${face.sellSilver+2*room.game.bookLayers}两`,{type:'sell'});
      else if(face.category==='stall_permit')operations=button('confirm-card',`扩摊3格 · ${room.game.purchasedStalls?3:6}两`,{type:'buy-stall'});
      else if(face.category==='tool')operations=(self.tools.length===3?`<label>道具区已满，弃掉一张已装道具<select id="hy-replace">${self.tools.map(tool=>`<option value="${esc(cardKey(tool))}">${esc(getCard(tool.definitionId).name)}${tool.exhausted?' · 已横置':''}</option>`).join('')}</select></label>`:'')+button('confirm-card','安装道具 · 1行动',{type:'install-tool'});
      else {
        let targetMissing=false;
        if(face.sourceCode==='M01'){const goods=GOODS.filter(good=>peer.goods[good.id]>0);targetMissing=goods.length===0;operations=targetMissing?'<p>对方没有可取得的货物。</p>':`<label>取得对方一件货物<select id="hy-target-good">${goods.map(good=>`<option value="${good.id}">${good.name}</option>`).join('')}</select></label>`;}
        if(face.sourceCode==='M08'){targetMissing=peer.tools.length===0;operations=targetMissing?'<p>对方没有可弃掉的道具。</p>':`<label>弃掉对方的一件道具<select id="hy-target-tool">${peer.tools.map(tool=>`<option value="${esc(cardKey(tool))}">${esc(getCard(tool.definitionId).name)}</option>`).join('')}</select></label>`;}
        operations+=button('confirm-card','使用人物 · 1行动',{type:'play-character'},targetMissing);
      }
    }
    return `<section class="hy-card-play" aria-label="选中的牌与操作"><div class="hy-inline-card">${renderCompactCard(card,{readButton:false,inline:true})}</div><div class="hy-inline-copy"><p>${esc(face.summary)}</p><small>${esc(face.costText)}</small><div class="hy-inline-actions">${operations}</div><div class="hy-inline-secondary"><button type="button" data-hy-detail="${esc(cardKey(card))}">完整牌文</button>${button('cancel-card','取消选中')}</div></div></section>`;
  }
  function selectHandCard(card,tool=false){
    if(!card||!room?.game)return;const self=room.game.players.find(player=>player.id===room.selfId);
    const current=(tool?self?.tools:self?.hand)?.find(item=>cardKey(item)===cardKey(card));if(!current)return;
    detail={card:current,tool};render();
  }
  function decision(){
    const pending=room?.game?.pending;if(!pending)return;detail=null;
    $('yg-decision').dataset.kind=pending.auction?'auction':pending.kind==='peek'?'peek':pending.choice?'choice':'response';
    const kind=pending.choice?.kind;presentedDecisionId=pending.decisionId;
    $('yg-decision-title').textContent=titleByKind[kind]??(pending.kind==='peek'?'这张留下吗？':pending.response?pending.response.kind==='counter'?'锦衣卫回应':'番商回应':pending.kind==='auction'?'整组拍品竞价':`${pending.code} · 当前步骤`);
    if(pending.privatePool&&pending.choice)$('yg-decision-title').textContent+=' · 私选';
    let sources=$('hy-decision-sources');if(!sources){sources=document.createElement('span');sources.id='hy-decision-sources';$('yg-decision-title').after(sources);}
    sources.innerHTML=pending.sourceCards.map(card=>`<button type="button" data-hy-detail="${esc(cardKey(card))}">${esc(getCard(card.definitionId).name)} · 牌文</button>`).join('');
    let body=pending.auction?`<p class="hy-auction-price">最高 ${pending.auction.highestBid}两${pending.auction.highestBidderId?' · '+esc(name(pending.auction.highestBidderId)):''} · 整组拍下</p>`:pending.privatePool&&!pending.choice?'<p>仅你可见 · 完整牌文可随时阅读</p>':!mine()?`<p>等待${esc(name(pending.actorId))}</p>`:'';
    if(pending.response&&pending.sourceCards[0])body+=`<p>${esc(getCard(pending.sourceCards[0].definitionId).summary)}</p>`;
    const selectableCards=mine()&&pending.choice&&['cards','option'].includes(choiceModel(pending)?.type)&&pending.choice.options?.some(option=>option.cardId||option.cardIds);
    if(!selectableCards&&(pending.pool?.length||pending.privatePool?.length))body+=cardList(pending.privatePool??pending.pool);
    if(goodsTotal(pending.goods))body+=`<div class="hy-goods-line">${GOODS.filter(good=>pending.goods[good.id]).map(good=>`<span>${renderGoodsIcon(good.id)}${good.name} ×${pending.goods[good.id]}</span>`).join('')}</div>`;
    let actions='',formId=null;
    if(mine()&&available()&&room.phase==='playing'){
      if(pending.kind==='peek')actions=button('keep-peek','留下，进入用牌')+button('discard-peek','弃掉，继续看牌');
      else if(pending.response)actions=(pending.response.cards??[]).map(card=>button('respond',`使用${getCard(card.definitionId).name}`,{cardId:card.cardId})).join('')+button('decline-response','不回应');
      else if(pending.auction&&pending.stage==='bidding'){
        const bid=pending.decision.options.find(option=>option.type==='bid');formId='hy-bid-form';
        actions=`${bid?`<label>报价 <input aria-label="我的报价" name="amount" inputmode="numeric" type="number" min="${bid.minimum}" max="${bid.maximum}" step="1" value="${choiceDraft?.amount??bid.minimum}" required> 两 <small>（${bid.minimum}～${bid.maximum}）</small></label><button type="submit">确认报价</button>`:''}${button('pass-bid','放弃竞价')}`;
      }else if(pending.choice){formId='hy-choice-form';body+=renderChoiceForm(pending,room.game,choiceDraft??defaultChoiceInput(pending),choicePage);actions='<button type="submit">确认选择</button>';}
    }
    $('yg-decision-body').innerHTML=renderDialogBody(body,actions,{formId});closeDialogs();$('yg-decision').showModal();
  }
  function readChoice(){const form=$('hy-choice-form');if(!form)return choiceDraft;const data=new window.FormData(form);return{goods:Object.fromEntries(GOODS.map(good=>[good.id,Number(data.get('good-'+good.id)??0)])),cardIds:[...(choiceDraft?.cardIds??defaultChoiceInput(room.game.pending).cardIds??[]).filter(id=>![...form.querySelectorAll('[name=cardIds]')].some(node=>node.value===id)),...data.getAll('cardIds')],optionIndex:data.has('optionIndex')?Number(data.get('optionIndex')):(choiceDraft?.optionIndex??defaultChoiceInput(room.game.pending).optionIndex??-1),ownGoodId:data.get('ownGoodId'),otherGoodId:data.get('otherGoodId'),goodId:data.get('goodId'),paymentIndex:data.has('paymentIndex')?Number(data.get('paymentIndex')):-1};}
  async function showHistory(after=0){if(historyBusy||!room?.game)return;historyBusy=true;const stamp=generation,match=room.game.matchId;try{const page=await onHistory({after,limit:30});if(stamp!==generation||match!==room?.game?.matchId||destroyed)return;if(page){history=page;inspect('本局公开记录',`<ol class="hy-event-list">${page.groups.flatMap(group=>group.events.map(event=>`<li>${esc(publicEventText(event,room.players))}</li>`)).join('')}</ol>${page.hasMore?button('history','下一页',{after:page.nextAfter}):'<p>已到当前最后一条。</p>'}`);}else inspect('近期公开记录',`<ol>${room.game.lastPublicEvents.map(event=>`<li>${esc(publicEventText(event,room.players))}</li>`).join('')}</ol>`);}catch(error){if(stamp===generation)feedback(error.message||'记录暂时不可用。');}finally{historyBusy=false;}}
  function updateClock(){if(!room||concealed)return;const clock=room.game?.clock??room.turnClock;
    const advance=practice&&state.practiceSnapshot?.active===false?0:Math.max(0,(window.performance?.now()??Date.now())-receivedAt);
    const remaining=!clock?0:clock.paused||clock.deadlineAt===null?clock.remainingMs:Math.max(0,clock.deadlineAt-serverTime-advance);
    const seconds=Math.ceil(remaining/1000);$('yg-clock').textContent=clock?`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:'--:--';
    $('yg-clock-label').textContent=clock?.paused?'余时已冻结':clock?.kind==='decision'?'对方选择 · 主动钟冻结':'主动回合余时';
  }
  function render(){
    const game=room.game,self=room.players.find(player=>player.id===room.selfId),isPlayer=room.selfRole==='player',host=room.hostId===room.selfId;
    $('yg-room-code').textContent=practice?'本机练习 · 电脑只看自己的手牌':room.phase==='waiting'
      ? `房间 ${room.roomCode} · 每回合${room.hyakkiConfig.actionLimit}步 · 每类${room.hyakkiConfig.goodsPerType??6}件`
      : `房间 ${room.roomCode} · ${room.spectators?.length??0}位观众`;
    $('yg-title').textContent=room.phase==='waiting'?'两个人坐好，就开张。':room.phase==='paused'?'夜市暂停 · 当前步骤保留':room.phase==='aborted'?'本局已取消':room.phase==='finished'?`${game?.result.winnerIds.map(name).join('、')??'赢家'}获胜`:
      game?.pending?`${mine()?'轮到你决定':name(game.pending.actorId)+'正在选择'}`:game?.turnPlayerId===room.selfId?'轮到你经营':name(game?.turnPlayerId)+'正在经营';
    root.querySelector('.yg-track').hidden=['waiting','finished','aborted'].includes(room.phase);
    $('yg-readiness').hidden=room.phase!=='waiting';
    $('yg-readiness').innerHTML=room.players.map(player=>`<span><strong>${esc(player.name)}${player.id===room.hostId?' · 房主':''}</strong><b>${player.ready?'已准备':'未准备'}</b></span>`).join('')+(room.players.length<2?'<span>等待第二位伙伴</span>':'');
    let note='',controls='';
    if(room.phase==='waiting'){
      note='双人夜市 · 20两开局 · 每人5张手牌；双方准备后由房主开始。';
      if(practice)controls=button('practice-restart','开始练习');
      else {if(isPlayer)controls+=button('ready',self.ready?'取消准备':'准备好了',{ready:!self.ready},!available());
        if(host)controls+=button('start','开始游戏',{},!available()||room.players.length!==2||!room.players.every(player=>player.ready));
        controls+=button('set-role',isPlayer?'改为观战':'加入对局',{role:isPlayer?'spectator':'player'},!available()||(isPlayer?host:room.players.length>=2))+button('invite','复制邀请');
        if(host)controls+=`<label class="hy-config">每回合行动<select id="hy-action-limit" ${available()?'':'disabled'}>${Array.from({length:10},(_,i)=>`<option value="${i+1}" ${room.hyakkiConfig.actionLimit===i+1?'selected':''}>${i+1}步</option>`).join('')}</select></label><label class="hy-config">每类公共货物<select id="hy-goods-limit" ${available()?'':'disabled'}>${Array.from({length:17},(_,i)=>`<option value="${i+4}" ${(room.hyakkiConfig.goodsPerType??6)===i+4?'selected':''}>${i+4}件</option>`).join('')}</select></label>`;
      }
    }else if(['finished','aborted'].includes(room.phase)){
      note=game?.result?.aborted?'没有赢家，本局财富不计入账号。':`最终银两：${game?.players.map(player=>`${name(player.id)} ${player.silver}两`).join(' · ')}。本局财富不计入账号。`;
      if(practice)controls=button('practice-restart','再来一局');else if(host)controls=button('rematch','回准备室',{},!available());
      controls+=button('history','公开记录');
    }else if(room.phase==='paused'){
      note=game?.holds.capacity?'记录容量已满，当前经济操作已停止；请保留此局。':game?.holds.manual?'双方暂停，保留七天；恢复后继续原步骤。':'伙伴意外离线，保席30分钟；恢复后继续原步骤。';
      if(isPlayer&&game?.holds.manual)controls+=button('resume','继续对局',{},!available());
      if(game?.pending)controls+=button('decision','查看待决步骤');
    }else if(game?.pending){
      note=game.pending.response?'回应期间主动操作冻结；到时按当前默认选项处理。':game.pending.auction?'整组拍品，完整付款；关闭窗口不会放弃竞价。':'材料与费用已保存，请完成当前步骤。';
      controls=button('decision',mine()?'处理当前选择':'查看公开步骤',{},false);
    }else if(active()){
      note=game.stage==='draw'?'先看牌，或直接进入用牌。每看一张花1行动，留下即进入用牌。':'把手牌拖到桌面，或点牌选中使用。';
      if(game.stage==='draw')controls+=button('peek','看一张 · 1行动',{},game.deckCount+game.discard.length===0)+button('finish-draw','进入用牌');
      controls+=button('end-turn',game.remainingActions>=2?'结束回合 · 得1两':'结束回合');
    }else note=isPlayer?`等待${name(game?.turnPlayerId)}，可查看卡牌与公开记录。`:'正在观战；不会显示私牌和私看候选。';
    if(room.pause)note+=` ${name(room.pause.requestedBy)}申请暂停（${room.pause.agreedIds.length}/2同意）。`;
    if(room.pause&&isPlayer)controls+=button('pause',room.pause.agreedIds.includes(room.selfId)?'撤回暂停同意':'同意暂停',{agree:!room.pause.agreedIds.includes(room.selfId)},!available());
    if(detail){const current=knownCards(game).get(cardKey(detail.card));if(!current||game?.pending||!isPlayer)detail=null;else detail.card=current;}
    root.classList.toggle('hy-card-selected',!!detail);
    $('yg-scene-content').innerHTML=detail?selectedCardContent(detail.card,detail.tool):`<p class="yg-scene-note">${esc(note)}</p><div class="yg-table-actions">${controls}</div>`;
    root.querySelectorAll('#yg-hand [data-entity-id]').forEach(node=>{const selected=!!detail&&!detail.tool&&node.dataset.entityId===cardKey(detail.card);node.classList.toggle('is-selected',selected);node.querySelector('button')?.setAttribute('aria-pressed',String(selected));});
    $('yg-portrait-decision').innerHTML=game?.pending?`<strong>${esc(mine()?'轮到你选择':'对方正在选择')}</strong>${button('decision','查看当前步骤')}`:'';
    $('yg-rotation').querySelector('small').textContent=practice?'本机练习 · 退出保留进度':'牌局已保存在房间，转向不会重新开始。';
    $('hy-pause').hidden=practice||!isPlayer||room.phase!=='playing';
    $('hy-host').hidden=practice||!(host||room.hostCanTakeOver);
    $('hy-practice-state').textContent=practice?(state.practiceSnapshot?.storageNote||'进度只保存在这个浏览器；打开设置、看牌或切后台会暂停电脑。'):'';
    $('hy-practice-reload').hidden=!practice||!(state.practiceSnapshot?.conflict||state.practiceSnapshot?.requiresRestart);
    $('hy-connection').hidden=state.connection==='online'&&!state.pending&&state.canAct!==false;
    $('hy-connection-text').textContent=state.pending?'操作结果正在核对，请勿重复提交。':state.canAct===false?'当前不能保存操作，请恢复存储或读取进度。':'正在恢复连接，原席位和已保存步骤会保留。';
    const shortActions=$('hy-short-actions');shortActions.innerHTML=practice?button('practice-hint','提示'):button('invite','邀请')+button('history','记录');

    updateClock();
  }
  function applyView(next,options={}){
    if(destroyed)return;
    const nextScope=sameScope(next),changed=scope!==nextScope,newDecision=next.game?.pending?.decisionId??null;
    if(selectionScope(room)!==selectionScope(next))detail=null;
    if(changed){generation++;closeDialogs();detail=null;choiceDraft=null;history=null;}
    if(decisionId!==newDecision){choiceDraft=null;choicePage=0;cardsPage=0;presentedDecisionId=null;if($('hy-card-reader').open)$('hy-card-reader').close();if($('yg-decision').open)$('yg-decision').close();}
    room=next;scope=nextScope;state={connection:'online',pending:false,canAct:true,...options};concealed=false;
    root.classList.remove('hy-concealed');receivedAt=window.performance?.now()??Date.now();serverTime=room.serverTime??Date.now();
    const inlineFields=detail?[...root.querySelectorAll('.hy-card-play select')].map(node=>({id:node.id,value:node.value,focused:document.activeElement===node})):[];
    base.applyView(tableProjection(next));render();handDrag.sync();
    for(const field of inlineFields){const node=$(field.id);if(node&&[...node.options].some(option=>option.value===field.value)){node.value=field.value;if(field.focused)node.focus({preventScroll:true});}}
    root.querySelectorAll('[data-hy-action="confirm-card"]').forEach(node=>{node.disabled=!active();});
    const newOwnedDecision=!!newDecision&&newDecision!==presentedDecisionId&&mine();decisionId=newDecision;
    if(newOwnedDecision&&available()&&room.phase==='playing')decision();
    // Existing choice DOM stays alive on presence/clock updates, retaining focus and text input.
    if($('yg-decision').open){$('yg-decision-body').querySelectorAll('button,input,select').forEach(node=>{if(!node.dataset.hyDetail&&!['choice-page','cards-page'].includes(node.dataset.hyAction))node.disabled=!available()||room.phase!=='playing';});}
  }
  function conceal({message='正在恢复房间…',loginHref=null,reauthHref=null}={}){
    handDrag.cancel();generation++;concealed=true;closeDialogs();detail=null;choiceDraft=null;history=null;decisionId=null;presentedDecisionId=null;scope=null;
    if(room)base.applyView(tableProjection({...room,game:null,phase:'waiting',selfRole:'spectator',selfId:null}));
    room=null;$('hy-reader-title').textContent='完整牌文';root.querySelectorAll('#yg-inspector-body,#yg-decision-body,#hy-reader-body,#hy-decision-sources,#yg-portrait-decision,#yg-chat-decision-label').forEach(node=>node.replaceChildren());
    root.classList.add('hy-concealed');$('hy-connection').hidden=false;$('hy-connection-text').textContent=message;
    for(const[id,href]of[['hy-login',loginHref],['hy-reauth',reauthHref]]){const link=$(id);link.hidden=!href;if(href)link.href=href;else link.removeAttribute('href');}
  }
  async function invite(){if(!room||practice)return;const url=new URL(window.location.href);url.pathname=url.pathname.replace(/[^/]*$/u,'');url.search='?room='+room.roomCode;url.hash='';try{await window.navigator.clipboard.writeText(url.href);feedback('邀请已复制。');}catch{inspect('房间邀请',`<p>房间 ${esc(room.roomCode)}</p><input value="${esc(url.href)}" readonly aria-label="房间邀请链接">`);}}
  function leaveDialog(next='lobby'){destination=next;closeDialogs();$('yg-leave').querySelector('.dialog-heading h2').textContent=practice?'返回大厅？':room?.selfRole==='player'&&['playing','paused'].includes(room.phase)?'认输并离开？':'退出房间？';
    $('hy-leave-note').textContent=practice?'保留本机练习进度，下次继续。':room?.selfRole==='player'&&['playing','paused'].includes(room.phase)?'这会结束本局，由对方获胜。只想暂时离开请用“返回大厅，保留席位”。':'退出后释放自己的席位或观战位置。';$('yg-leave').showModal();}
  function openPracticeRestart(){inspect('开始新的练习',`<p>重新开始会覆盖这台设备当前的练习；正式房间不受影响。</p><label>每回合行动<select id="hy-practice-limit">${Array.from({length:10},(_,i)=>`<option value="${i+1}" ${i===4?'selected':''}>${i+1}步</option>`).join('')}</select></label><label>每类公共货物<select id="hy-practice-goods">${Array.from({length:17},(_,i)=>`<option value="${i+4}" ${i===4?'selected':''}>${i+4}件</option>`).join('')}</select></label><div class="yg-dialog-actions">${button('practice-confirm','开始新练习')}</div>`);}
  // Keep the common audio/theme/dialog owners. Remove only preview-specific menus.
  root.querySelector('.yg-brand span').textContent=practice?'本机练习 · 电脑对手':'棋牌室 · 双人夜市';
  root.querySelector('#yg-options .game-settings-body section:first-child').hidden=true;
  $('yg-settings-exit').closest('section').innerHTML=`<h3>${practice?'本机练习':'房间安排'}</h3><div class="game-settings-controls"><button type="button" data-hy-action="members">成员与商铺</button><button type="button" data-hy-action="history">公开记录</button><button type="button" id="hy-pause" data-hy-action="pause">申请暂停</button><button type="button" id="hy-host" data-hy-action="host">房主管理</button>${practice?'<button type="button" data-hy-action="practice-restart">重新开始</button><button type="button" data-hy-action="practice-hint">当前提示</button><button type="button" data-hy-action="practice-reload" id="hy-practice-reload">读取保存进度</button>':'<button type="button" data-hy-action="invite">复制邀请</button><button type="button" data-hy-action="keep-seat">返回大厅，保留席位</button><button type="button" data-hy-action="logout">退出棋牌登录</button><button type="button" data-hy-action="agora">返回 Agora</button><button id="hy-practice-reload" hidden></button>'}<button type="button" data-hy-action="leave">${practice?'返回大厅':'退出房间'}</button></div><p id="hy-practice-state"></p><p id="chat-legacy-note" hidden></p><details><summary>第一次怎么玩？</summary><p>每人20两、5张牌。先看牌或直接进入用牌；用货物牌整组买入／卖出，人物和道具提供其他经营办法。行动条共用本回合额度；剩至少2行动主动结束回合可得1两。回合结束达到60两触发收市，最后银两多者胜。</p></details>`;
  $('yg-leave').querySelector('p').id='hy-leave-note';
  const arrangements=$('hy-pause').closest('section');
  arrangements.querySelector('.game-settings-controls').append($('yg-catalog'));
  $('yg-catalog').textContent='查看完整51种卡牌';
  arrangements.querySelector('details').outerHTML=`<details><summary>① 回合顺序与行动例子</summary><p>每人20两、5张手牌。每回合先取牌，再用牌，最后结束；回合行动额度由房主设定（默认5步）。看1张牌用1步，弃掉可继续看；一旦留下就进入用牌。也可直接进入用牌，不花行动。</p><p>例：看第1张并弃掉，花1步；看第2张并留下，再花1步；买一组货物花1步；余2步主动结束，获得1两。耗尽行动或超时结束不赠银两。</p></details><details><summary>② 货物、摊位与临时格</summary><p>用货物牌整组买入或卖出，不能只交易其中一部分。起初5个普通货位＋1个临时位，新占临时格需付2两。人物、道具等带来货物时，按当前选择留下可容纳部分，其余退公库；最终以牌文和当前提示为准。</p><p>持摊位许可可花1步扩摊，每块加3格。全场第一块6两，后续3两；货物总量与扩摊数量有限，公库以右侧库存为准。</p></details><details><summary>③ 人物、道具与对方回应</summary><p>人物通常花1步使用。监视人物可能让对方用锦衣卫抵消；番商可在交易回应窗取走货物牌。回应者有60秒，主动玩家时钟冻结。牌、费用与选择一经提交就保存；关闭详情不会退款，也不会取消已经发动的效果。</p><p>安装道具花1步，使用另花1步，另付牌上要求的银两、货物或弃牌费用。每人最多3件，可弃旧装新；用过横置，自己回合结束复原。貔貅袋等候选牌、拍卖全组拍品与选择数量都在决定窗口显示。</p></details><details><summary>④ 收市、恢复与本机练习</summary><p>回合结束达到60两触发收市：若先手触发，后手再完成一回合；银两最多者胜，平手由最后行动者胜。财富仅属于本局，不计入账号积分。</p><p>正式房间可申请双方暂停；意外离线保留席位和待决步骤，主动退出则认输。本机练习只存在当前浏览器：打开面板、切到后台会暂停电脑，退出后可继续。遇到另一窗口已修改进度，先读取保存进度再操作。</p></details>`;
  $('yg-stay').textContent='继续游戏';$('yg-leave-close').setAttribute('aria-label','继续游戏');
  $('yg-leave-confirm').textContent=practice?'返回大厅':'确认退出';
  $('chat-title').textContent='房间聊天';root.querySelector('.chat-heading p').textContent='和房间里的伙伴聊两句。';
  $('yg-feedback').textContent=practice?'本机练习，真实规则；电脑只使用自己的手牌和公牌。':'先看牌，再经营。';
  $('yg-hand-title').insertAdjacentHTML('afterend','<span id="hy-short-actions"></span>');
  root.insertAdjacentHTML('beforeend',`<section id="hy-connection" class="hy-connection" role="status" hidden><p id="hy-connection-text"></p><div>${button('recover','恢复连接')}${button('retry','核对原操作')}<a id="hy-login" hidden>重新登录</a><a id="hy-reauth" hidden>近期认证</a>${button('keep-seat','返回大厅')}</div></section>`);
  root.insertAdjacentHTML('beforeend','<dialog id="hy-card-reader" class="yg-dialog hy-card-reader" aria-labelledby="hy-reader-title"><div class="dialog-heading"><h2 id="hy-reader-title"></h2><button type="button" id="hy-reader-close" class="close-button" aria-label="返回上一层">×</button></div><div id="hy-reader-body"></div></dialog>');
  function handleAction(type,fields){
    if(type==='cancel-card'){detail=null;render();return;}
    if(type==='begin-play'){if(!active()||room.game.stage!=='draw')return;return dispatch('finish-draw',{},()=>{if(active()&&room.game.stage==='use')selectHandCard(room.game.players.find(player=>player.id===room.selfId)?.hand.find(card=>cardKey(card)===fields.cardId));});}
    if(type==='choice-page'){choiceDraft=readChoice();choicePage=fields.page;return decision();}
    if(type==='cards-page'){cardsPage=fields.page;if($('yg-decision').open)return decision();return inspect('公开弃牌',cardList(room.game.discard));}
    if(type==='decision')return decision();if(type==='history')return void showHistory(fields.after??0);if(type==='invite')return void invite();
    if(type==='leave'||type==='logout'||type==='agora')return leaveDialog(type==='leave'?'lobby':type);
    if(type==='keep-seat'){const stamp=generation;Promise.resolve().then(()=>onLeave({keepSeat:true,destination:'lobby'})).catch(error=>{if(!destroyed&&stamp===generation)feedback(error.message||'返回大厅未完成。');});return;}
    if(type==='recover')return void onRecover();if(type==='retry')return void onRetry();if(type==='refresh')return void onRefresh();
    if(type==='practice-restart')return openPracticeRestart();
    if(type==='practice-confirm'||type==='practice-reload'||type==='practice-hint'){
      const callback=type==='practice-confirm'?practiceActions.onRestart:type==='practice-reload'?practiceActions.onReload:practiceActions.onHint;
      const stamp=generation;Promise.resolve().then(()=>callback?.(type==='practice-confirm'?{actionLimit:Number($('hy-practice-limit').value),goodsPerType:Number($('hy-practice-goods').value)}:undefined)).then(()=>{if(stamp===generation&&!destroyed&&type!=='practice-hint')closeDialogs();}).catch(error=>{if(stamp===generation&&!destroyed)feedback(error.message);});return;
    }
    if(type==='members'){return inspect('成员与公开商铺',`<div class="hy-member-list">${(room?.game?.players??room?.players??[]).map(player=>`<article><h3>${esc(name(player.id))}${player.id===room.hostId?' · 房主':''}</h3><p>${player.silver??20}两 · 手牌${player.handCount??0}张</p>${player.goods?`<p>${GOODS.map(good=>`${good.name} ${player.goods[good.id]}`).join(' · ')}</p>`:''}${player.tools?cardList(player.tools):''}</article>`).join('')}</div><p>观众：${esc(room?.spectators?.map(player=>player.name).join('、')||'暂无')}</p>`);}
    if(type==='host')return inspect('房主管理',room.hostId===room.selfId?`<label>将房主交给<select id="hy-host-target">${room.players.filter(player=>player.id!==room.selfId).map(player=>`<option value="${esc(player.id)}">${esc(player.name)}</option>`).join('')}</select></label>${button('host-transfer','确认转交')}`:button('transferHost','接任房主',{playerId:room.selfId}));
    if(type==='host-transfer')return dispatch('transferHost',{playerId:$('hy-host-target').value});
    if(type==='confirm-card'){try{const values={replaceCardId:$('hy-replace')?.value,goodsId:$('hy-target-good')?.value,toolCardId:$('hy-target-tool')?.value};const gameForAction=practice&&room.phase==='playing'?{...room.game,clock:{...room.game.clock,paused:false}}:room.game;const command=actionDraft(gameForAction,room.selfId,detail.card,fields.type,values);dispatch(fields.type,command,()=>{detail=null;render();});}catch(error){feedback(error.message);}return;}
    return dispatch(type,fields);
  }
  const removeClick=listen('click',event=>{
    const node=event.target.closest('button');if(!node||node.disabled||destroyed)return;
    const stop=()=>{event.preventDefault();event.stopImmediatePropagation();};
    if(node.dataset.hyAction){stop();handleAction(node.dataset.hyAction,JSON.parse(node.dataset.hyFields??'{}'));return;}
    if(node.dataset.detailId){stop();readCard(getCard(node.dataset.detailId));return;}
    if(node.dataset.hyDetail){stop();const card=knownCards(room?.game).get(node.dataset.hyDetail);if(card)readCard(card);return;}
    if(['yg-exit','yg-settings-exit'].includes(node.id)){stop();leaveDialog();return;}
    if(['yg-copy-invite','yg-waiting-invite'].includes(node.id)){stop();void invite();return;}
    if(node.id==='yg-draw-pile'){stop();if(active()&&room.game.stage==='draw')dispatch('peek');return;}
    if(node.id==='yg-discard-pile'){stop();cardsPage=0;if(room?.game)inspect('公开弃牌',cardList(room.game.discard));return;}
    if(node.id==='yg-decision-close'){stop();choiceDraft=$('hy-bid-form')?{amount:Number($('hy-bid-form').elements.amount.value)}:readChoice();$('yg-decision').close();return;}
    if(node.id==='hy-reader-close'){stop();$('hy-card-reader').close();return;}
    if(node.id==='yg-inspector-close'){stop();$('yg-inspector').close();detail=null;return;}
    if(node.id==='yg-rules'){stop();inspect('幽街商人规则','<p>每人20两、5张手牌、5个普通货位＋1个临时位。普通扩摊每块增加3格，首次6两，以后3两。新占临时位另付2两。</p><p>看牌每张1行动；留下后进入用牌，也可以直接进入用牌。货物牌整组交易；人物用1行动；道具安装和使用各1行动，每件每回合限用一次。具体效果以卡牌全文为准。</p><p>尚余2行动主动结束回合可得1两。回合结束达到60两收市；先手触发时后手再完成一回合。银两多者胜，平手由最后行动者胜。</p><p>主动回合30分钟，对方选择60秒并冻结主动钟。暂停保留7天，离线保席30分钟；主动退出认输。每局财富独立。</p>');return;}
    if(node.dataset.cardId){const id=node.closest('[data-entity-id]')?.dataset.entityId;if(id){stop();selectHandCard(knownCards(room?.game).get(id));}return;}
    if(node.dataset.toolId){stop();const card=knownCards(room?.game).get(node.dataset.toolId);if(card)selectHandCard(card,true);return;}
    if(node.dataset.player||node.id==='yg-shop-detail'){stop();handleAction('members',{});return;}
    if(node.id==='yg-expand'){stop();const permit=room?.game?.players.find(player=>player.id===room.selfId)?.hand?.find(card=>getCard(card.definitionId).category==='stall_permit');if(permit)selectHandCard(permit);else feedback('扩摊需要手持许可，点开许可即可购买。');}
  });
  const removeSubmit=listen('submit',event=>{if(!['hy-choice-form','hy-bid-form'].includes(event.target.id))return;event.preventDefault();event.stopImmediatePropagation();if(!mine()||!available())return;try{if(event.target.id==='hy-choice-form'){choiceDraft=readChoice();dispatch('choose-effect',{selection:buildChoiceSelection(room.game.pending,choiceDraft)});}else{const amount=Number(event.target.elements.amount.value),bid=room.game.pending.decision.options.find(option=>option.type==='bid');if(!Number.isSafeInteger(amount)||!bid||amount<bid.minimum||amount>bid.maximum)throw new RangeError('请输入报价范围内的整数。');choiceDraft={amount};dispatch('bid',{amount});}}catch(error){feedback(error.message);}});
  const removeInput=listen('input',event=>{if(event.target.closest('#hy-choice-form'))choiceDraft=readChoice();if(event.target.closest('#hy-bid-form'))choiceDraft={amount:Number(event.target.value)};});
  const removeChange=listen('change',event=>{if(['hy-action-limit','hy-goods-limit'].includes(event.target.id))dispatch('configure',{hyakkiConfig:{actionLimit:Number($('hy-action-limit').value),goodsPerType:Number($('hy-goods-limit').value)}});});
  const handDrag=mountHandDrag({root,getContext:()=>({scope:selectionScope(room),enabled:active(),cardIds:room?.game?.players.find(player=>player.id===room.selfId)?.hand?.map(cardKey)??[],blockedReason:room?.game?.stage==='draw'?'先看牌，或点击进入用牌。':'请先完成当前步骤，轮到你时再用牌。'}),onDrop:id=>selectHandCard(room?.game?.players.find(player=>player.id===room.selfId)?.hand?.find(card=>cardKey(card)===id)),onBlocked:feedback});
  const clearSelection=()=>{if(detail){detail=null;if(room&&!destroyed)render();}};
  window.addEventListener('blur',clearSelection);
  const clock=window.setInterval(updateClock,500);
  return {applyView,conceal,feedback,leaveFailure,selectHandCard,readCard,audio:base.audio,settings:base.settings,openPracticeRestart,
    configurePractice(callbacks){practiceActions={...callbacks};},destroy(){if(destroyed)return;destroyed=true;generation++;room=null;detail=null;choiceDraft=null;history=null;removeClick();removeSubmit();removeInput();removeChange();handDrag.destroy();window.removeEventListener('blur',clearSelection);window.clearInterval(clock);base.destroy();}};
}
