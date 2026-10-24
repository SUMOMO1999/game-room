import {mountExpansionTable} from './configured/table-ui.mjs';
import { mountHandDrag } from './hand-drag-ui.mjs';
import { mountDigitalPage } from './digital-page-ui.mjs';
import { renderCard, renderCardBack, renderCardDetails, renderGoodsIcon } from './digital-card-ui.mjs';
import { mountTableMotion } from './table-motion-ui.mjs';
import { syncTaskMarkup, renderTableActionDraft, renderMaterialTarget, nativeChoiceDraft, nativeCardInput, updateNativeChoice, nativeChoiceReady, nativeExchangeState, nativeSelectionText, renderNativeMaterials, renderNativeWork } from './table-decision-ui.mjs';
import { dialogPage, renderDialogPager, renderCompactCard, renderCompactCards, renderPublicDiscardCards, renderDialogBody, decisionContext } from './game-dialog-ui.mjs';
import { mountBattleReport } from './battle-report-ui.mjs';
import { cardDraftChoices, cardDraftSelections, cardDraftCost } from './card-draft.mjs';
import { benefitDraftState, benefitDraftSummary, renderBenefitDraft, renderBenefitGoods, renderBenefitBranches } from './benefit-draft-ui.mjs';
import { GOODS, getCard,goodsFor } from './presentation-content.mjs';
import { qualifiesForIdleReward } from './model.mjs';
import { choiceModel, buildChoiceSelection, defaultChoiceInput, knownCards, actionDraft, cardKey, goodsTotal, tableProjection, tradeAvailability, requiresOpponent, materialTransition, supplySetup, opponentTableEvent } from './game-ui-model.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const button = (action, label, fields = {}, disabled = false, className = '') => `<button type="button" data-hy-action="${action}" data-hy-fields="${esc(JSON.stringify(fields))}" ${className ? `class="${className}"` : ''} ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
const goodName = id => GOODS.find(good => good.id === id)?.name ?? '货物';
const titleByKind = {'retain-goods':'选择要留下的货物','take-card':'留下一张牌','tool-two-cards':'两仪灯 · 自留一张，另一张给对手','discard-hand':'弃牌至剩三张','tool-discard-draw':'弃一或两张，再抽同样张数','auction-goods':'挑选两件完整拍品','sell-goods':'挑选三件出售货物','sell-stock':'选择出售的库存','draft-card':'县丞 · 公开手牌重分','draft-good':'船老大 · 货物重分','draft-tool':'光棍 · 道具重分','keep-tool':'魁首 · 只留一件道具','borrow-tool':'术士 · 是否借用该道具','borrowed-target':'借用道具 · 另选对手','benefit-branch':'把戏人 · 选择自己的收益','benefit-good':'选择自己的收益货物','trade-card':'买办 · 选择货物牌','hand-branch':'典史 · 选择效果','tribute-branch':'蛊婆 · 付钱或让发动者抽牌','tool-search-payment':'貔貅袋 · 支付取牌费用','tool-exchange':'许愿井 · 双方各换一件','tool-payment-good':'选择货物与支付牌'};
const branchLabel = (kind, branch) => kind === 'tribute-branch' ? branch === 'pay' ? '付给对方2两' : '让对方抽2张'
  : kind === 'hand-branch' ? branch === 'draw' ? '自己补足5张手牌' : '让对方弃到3张'
  : branch === 'draw' ? '自己抽2张，对方得货物' : '自己得货物，对方抽2张';
function choiceLabel(option, kind, cards) {
  const name = id => { const card = cards.get(id); return card ? getCard(card.definitionId).name : '所选牌'; };
  if (option.cardId) return name(option.cardId);
  if (option.targetId) return `第${(cards.players??[]).findIndex(player=>player.id===option.targetId)+1}席 · ${cards.playerName?.(option.targetId)??'对手'}`;
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
  cards.players=game.players;cards.playerName=id=>game.players.find(player=>player.id===id)?.name??'对手';
  const cardOption = (id, input) => {const card = cards.get(id);return `<label class="hy-choice-card">${input}${card ? renderCompactCard(card, {readButton:false}) : '<span>当前候选牌</span>'}${card ? `<button type="button" data-hy-detail="${esc(id)}">完整牌文</button>` : ''}</label>`;};
  if (model.type === 'goods') return `<p>选择${model.minimum === model.maximum ? model.minimum : `${model.minimum}～${model.maximum}`}件。${model.raw ? `普通格${model.ordinaryCapacity}，新占临时格另付${model.temporaryFee}两；其余退回公库。` : ''}</p><div class="hy-goods-choice">${GOODS.filter(good=>Object.hasOwn(model.stock,good.id)).map(good=>`<label>${renderGoodsIcon(good.id)}<span>${good.name} · 共${model.stock[good.id]}</span><input type="number" inputmode="numeric" name="good-${good.id}" min="0" max="${model.stock[good.id]}" step="1" value="${draft.goods?.[good.id]??0}" aria-label="保留或选择${good.name}数量"></label>`).join('')}</div>`;
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
  const target = players.find(player=>player.id===event.targetSeatId)?.name ?? '所选伙伴';
  const goods = Object.entries(event.goods??{}).filter(([,count])=>Number.isSafeInteger(count)&&count>0).map(([id,count])=>`${goodName(id)}×${count}`).join('、');
  if(event.type==='trade-bought')return `${actor}买入${goods||card||'整组货物'}，付${event.silver??0}两`;
  if(event.type==='trade-sold')return `${actor}出售${goods||card||'整组货物'}，得${event.silver??0}两`;
  if(event.type==='auction-settled')return `${target}以${event.silver??0}两取得拍品${goods?`：${goods}`:''}`;
  if(event.type==='auction-revealed')return `${actor}发起拍卖${goods?`：${goods}`:''}`;
  if(event.type==='stall-expanded')return `${actor}付${event.silver??0}两扩摊${Number.isSafeInteger(event.count)?`，现有${event.count}块扩摊`:''}`;
  if(['character-played','tool-activated'].includes(event.type)&&event.targetSeatId)return `${actor}对${target}使用${card}`;
  if(['role-used','role-triggered'].includes(event.type))return `${actor}${event.type==='role-used'?'发动':'触发'}${getCard(event.roleId).name}${event.targetSeatId?' → '+target:''}${event.silver?' · '+event.silver+'两':''}`;
  const labels={'match-started':'夜市开张','draw-peeked':`${actor}看了一张牌`,'draw-kept':`${actor}留下所看牌`,'draw-discarded':`${actor}弃掉${card}`,'draw-finished':`${actor}进入用牌阶段`,'turn-ended':`${actor}结束回合`,'character-played':`${actor}使用${card}`,'tool-installed':`${actor}安装${card}`,'tool-activated':`${actor}使用道具${card}`,'trade-bought':`${actor}买入货物，付${event.silver??0}两`,'trade-sold':`${actor}出售货物，得${event.silver??0}两`,'response-played':`${actor}以${card}回应`,'response-declined':`${actor}不回应`,'choice-resolved':`${actor}完成选择`,'bid-raised':`${actor}报价${event.silver??event.amount??0}两`,'bid-passed':`${actor}放弃竞价`,'auction-settled':`${players.find(player=>player.id===event.targetSeatId)?.name??'玩家'}以${event.silver??0}两取得整组拍品`,'auction-passed':'竞价结束，拍品退回','stall-expanded':`${actor}扩摊`,'paused':'全员同意暂停夜市','suspended':'夜市挂起，保留当前步骤','resumed':'夜市继续','match-ended':'本局结束','cards-revealed':`${actor}公开候选牌`,'search-revealed':`${actor}完成貔貅袋搜寻`};
  return labels[event.type] ?? '公开步骤已更新';
}

/** Real room UI. Only privateView/spectatorView enter; server commands own all effects. */
function expansionSetupFields(prefix,configuration,disabled=false){
  return `<label class="hy-setup-field hy-expansion-toggle"><span>六行百业扩展</span><input type="checkbox" id="${prefix}-expansion" ${configuration.packId==='six-trades-v1'?'checked':''} ${disabled?'disabled':''}></label><label class="hy-setup-field"><span>收市金额</span><select id="${prefix}-closing" ${disabled?'disabled':''}>${Array.from({length:18},(_,i)=>30+i*10).map(n=>`<option value="${n}" ${(configuration.closingTarget??60)===n?'selected':''}>${n}两</option>`).join('')}</select></label>`;
}
export function mountHyakkiPage({root,practice=false,onAction=()=>{},onLeave=()=>{},onRefresh=()=>{},onRetry=()=>{},onRecover=()=>{},onHistory=async()=>null}={}) {
  const document=root.ownerDocument,window=document.defaultView,$=id=>document.getElementById(id);
  let room=null,state={connection:'online',pending:false,canAct:true},destroyed=false,concealed=false,generation=0,scope=null,decisionId=null,presentedDecisionId=null;
  let detail=null,choiceDraft=null,cardsPage=0,decisionStep=0,responseDraft=null,practiceActions={},leaveWorking=false,destination='lobby';
  let discardPage=0,discardMarkup='';
  let receivedAt=0,serverTime=0,actionRequest=null,inspectorKind=null,practiceSetup=null,practiceSetupMatchId=null,peerPresentation=null;
  const actionGateDisabled=new Map();
  const base=mountDigitalPage({root,scenes:[],externalDecisions:true,onAction:()=>{},onLeave:()=>leave(),
    onLayout:()=>{if(room&&!destroyed)render({preserveTaskDOM:true});}});
  root.classList.add('hy-real');
  const motion=mountTableMotion({root});
  const feedback = text => {
    base.feedback(text);
    const modal=root.querySelector('dialog[open]');
    if(modal){let note=modal.querySelector('[data-hy-error]');if(!note){note=document.createElement('p');note.dataset.hyError='true';note.setAttribute('role','alert');modal.querySelector('.dialog-heading').after(note);}note.textContent=text;}
  };
  const expansionTable=mountExpansionTable({root,send:dispatch,read:readCard,rerender:render,feedback,available:()=>available(),clearLegacyDraft:()=>{detail=null;},isLegacyMaterial:id=>!!ownedDraftInput(id)||isLegacyReplacement(id),inspect});
  function listen(type,handler){root.addEventListener(type,handler,true);return()=>root.removeEventListener(type,handler,true);}
  const selectionScope = value => [value?.roomId,value?.game?.matchId,value?.selfId,value?.selfRole,value?.phase,value?.game?.turnId,value?.game?.stage,value?.game?.actionsUsed,value?.game?.pending?.decisionId].join(':');
  const sameScope = value => [value?.roomId,value?.matchId??value?.game?.matchId,value?.selfId,value?.selfRole].join(':');
  const available = () => !!room&&!concealed&&!destroyed&&!state.pending&&state.canAct!==false&&state.connection==='online';
  const mine = () => room?.selfRole==='player'&&room.game?.pending?.actorId===room.selfId;
  const active = () => available()&&room.phase==='playing'&&room.selfRole==='player'&&room.game?.turnPlayerId===room.selfId&&!room.game.pending;
  const firstPeekRequired = () => room?.game?.stage==='draw'&&!room.game.drawStarted&&room.game.deckCount+room.game.discard.length>0;
  const name = id => [...(room?.players??[]),...(room?.matchPlayers??[])].find(player=>player.id===id)?.name ?? '伙伴';
  const cardList = cards => renderCompactCards(cards,cardsPage);
  const setupText = setup => setup.deckSize
    ? `${setup.playerCount}人 · 主牌${setup.deckSize}张 · 每种推荐${setup.goodsPerTypeRecommended}件；当前${setup.goodsPerType}件（${setup.goodsSupplyMode==='recommended'?'随人数推荐':'手选，人数变化时保留'}）`
    : '2～6人可开局；凑齐参赛玩家后显示牌量与推荐库存。';
  const supplySelect = (id,value,disabled=false) => `<select id="${id}" ${disabled?'disabled':''}>${Array.from({length:17},(_,i)=>`<option value="${i+4}" ${value===i+4?'selected':''}>${i+4}件</option>`).join('')}</select>`;
  const discardList = () => {discardPage=dialogPage(room.game.discard,discardPage).current;const origins=battleReport.discardOrigins(room.game.discard);return renderPublicDiscardCards([...room.game.discard].reverse(),discardPage,{origins:origins.items,originsLoaded:origins.loaded,name});};
  function closeDialogs(){root.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());}
  function inspect(title,content,actions=''){closeDialogs();inspectorKind=null;$('yg-inspector-title').textContent=title;$('yg-inspector-body').innerHTML=renderDialogBody(content,actions);$('yg-inspector').showModal();}
  function showMembers(playerId=null){
    const allPlayers=room?.game?.players??room?.players??[];
    const players=playerId===null?allPlayers:allPlayers.filter(player=>player.id===playerId);
    if(playerId!==null&&!players.length)return;
    const title=playerId===null?'成员与公开商铺':playerId===room.selfId?'我的商铺':'对手信息';
    return inspect(title,`<div class="hy-member-list">${players.map(player=>`<article><h3>${esc(name(player.id))}${player.id===room.hostId?' · 房主':''}</h3><p>${player.silver??20}两 · 手牌${player.handCount??0}张</p>${player.roleId?`<p class="hy-public-role"><strong>${esc(getCard(player.roleId,room.game.configuration??room.game.opening?.configuration).name)}</strong> · ${esc(getCard(player.roleId,room.game.configuration??room.game.opening?.configuration).compactText)} <button type="button" data-hy-read-card="${esc(player.roleId)}">完整能力</button></p>`:''}${player.goods?`<p>${goodsFor(room.game).map(good=>`${good.name} ${player.goods[good.id]}`).join(' · ')}</p>`:''}${player.goods?`<p>普通容量${player.ordinaryCapacity}格 · 临时格${player.temporaryOccupied?'已占用，已付2两':'空闲，占用付2两'}</p>`:''}${player.tools?.length?`<p>${player.tools.map(tool=>`${esc(getCard(tool.definitionId).name)}：${tool.exhausted?'已用':'可用'}`).join(' · ')}</p>${cardList(player.tools)}`:''}</article>`).join('')}</div>${playerId?'':`<p>观众：${esc(room?.spectators?.map(player=>player.name).join('、')||'暂无')}</p>`}`);
  }
  function showDiscard(page=0){if(!room?.game)return;discardPage=page;discardMarkup=discardList();inspect('公开弃牌',discardMarkup);inspectorKind='discard';}
  function syncDiscardReader(){
    const markup=discardList();if(markup===discardMarkup)return;discardMarkup=markup;
    const content=$('yg-inspector-body').querySelector('.hy-dialog-content');if(!content)return;
    const top=content.scrollTop,oldRow=content.querySelector('.hy-public-discard'),left=oldRow?.scrollLeft??0;
    const next=document.createElement('div');next.innerHTML=markup;
    const nextRow=next.querySelector('.hy-public-discard');
    if(oldRow&&nextRow){
      oldRow.replaceChildren(...nextRow.children);
      content.querySelector('.hy-discard-guide').textContent=next.querySelector('.hy-discard-guide').textContent;
      const pager=content.querySelector('.hy-dialog-pager'),nextPager=next.querySelector('.hy-dialog-pager');
      if(pager&&nextPager)pager.replaceChildren(...nextPager.children);
      else if(pager)pager.remove();else if(nextPager)content.append(nextPager);
      oldRow.scrollLeft=left;
    }else content.innerHTML=markup;
    content.scrollTop=top;
  }
  function readCard(card){if(!card)return;const face=getCard(card.definitionId??card.id);$('hy-reader-title').textContent=face.name+' · 完整牌文';$('hy-reader-body').innerHTML=renderDialogBody(renderCardDetails(face,{configuration:room?.game?.configuration??room?.game?.opening?.configuration}));if(!$('hy-card-reader').open)$('hy-card-reader').showModal();}
  function dispatch(type,fields={},onCommitted=null) {
    if(!available()||actionRequest)return;
    const stamp=generation,current=scope;
    try{
      const result=onAction(type,structuredClone(fields)),token={};
      const waiting=result&&typeof result.then==='function';
      if(waiting&&!destroyed&&!concealed&&stamp===generation&&current===scope){actionRequest=token;renderActionGate();}
      Promise.resolve(result).then(accepted=>{
        if(actionRequest===token)actionRequest=null;
        if(accepted!==false&&!destroyed&&stamp===generation&&current===scope)onCommitted?.();
      }).catch(error=>{if(!destroyed&&stamp===generation&&current===scope&&error?.name!=='AbortError')feedback(error.message||'操作未完成。');})
        .finally(()=>{if(actionRequest===token)actionRequest=null;if(waiting&&!destroyed&&stamp===generation&&current===scope&&!concealed)render();});
    }
    catch(error){if(!destroyed&&stamp===generation&&current===scope)feedback(error.message||'操作未完成。');}
  }
  // Release only this request's temporary lock before authority recomputes controls.
  function restoreActionGate(){
    for(const [node,disabled] of actionGateDisabled)node.disabled=disabled;
    actionGateDisabled.clear();
  }
  function renderActionGate(){
    root.setAttribute('aria-busy',String(!!actionRequest||state.pending));
    if(!actionRequest)return;
    $('hy-connection').hidden=false;$('hy-connection-text').textContent='正在结算这次操作，请勿重复提交。';
    const lock=node=>{if(!actionGateDisabled.has(node))actionGateDisabled.set(node,node.disabled);node.disabled=true;};
    root.querySelectorAll('[data-hy-action]').forEach(node=>{if(node.tagName==='BUTTON'&&!['history','discard-page'].includes(node.dataset.hyAction))lock(node);});
    $('yg-scene-content').querySelectorAll('input,select').forEach(lock);
  }
  async function leave(){if(leaveWorking||destroyed)return;leaveWorking=true;$('yg-leave-confirm').setAttribute('aria-busy','true');$('yg-leave-confirm').disabled=true;const stamp=generation;try{await onLeave({destination});}catch(error){if(stamp===generation&&!destroyed)leaveFailure(error.message||'退出未确认，请重试。');}finally{if(stamp===generation&&!destroyed){leaveWorking=false;$('yg-leave-confirm').removeAttribute('aria-busy');$('yg-leave-confirm').disabled=false;}}}
  function leaveFailure(message){leaveWorking=false;$('yg-leave-confirm').removeAttribute('aria-busy');$('yg-leave-confirm').disabled=false;feedback(message);$('hy-leave-note').textContent=message;}
  function borrowDraft(){
    const pending=room?.game?.pending;
    if(!mine()||pending?.choice?.kind!=='borrow-tool'||!pending.target)return null;
    const selected=pending.choice.options[choiceDraft?.optionIndex];if(!selected?.borrow)return null;
    return {card:pending.target,tool:true,targetId:choiceDraft?.borrowTargetId,choiceInputs:choiceDraft?.toolInputs??[]};
  }
  function borrowParts(){const draft=borrowDraft();return draft?cardDraftChoices(room.game,room.selfId,draft):[];}
  function borrowReady(){
    const draft=borrowDraft();if(!draft)return true;
    const needs=requiresOpponent(getCard(draft.card.definitionId),'activate-tool');
    if(needs&&room.game.players.length>2&&!draft.targetId)return false;
    return borrowParts().every((part,index)=>nativeChoiceReady(part,draft.choiceInputs[index]??nativeChoiceDraft(part)));
  }
  function borrowCost(){
    const draft=borrowDraft();if(!draft)return null;
    let selections=[];if(borrowReady())selections=cardDraftSelections(room.game,room.selfId,draft);
    return cardDraftCost(room.game,room.selfId,draft,selections,{short:shortScreen(),borrowed:true});
  }
  function borrowedCardInput(id){
    for(const [index,part] of borrowParts().entries()){const input=nativeCardInput(part,id);if(input)return {...input,borrowPart:index};}
    return null;
  }
  function borrowedSelected(input){
    const part=borrowParts()[input.borrowPart],draft=choiceDraft?.toolInputs?.[input.borrowPart]??nativeChoiceDraft(part);
    return input.type==='card'?draft.cardIds?.includes(input.id):input.type==='payment'?draft.paymentIndex===input.index:draft.optionIndex===input.index;
  }
  const draftParts = () => detail ? cardDraftChoices(room.game,room.selfId,detail) : [];
  function dianBranch(){return detail&&getCard(detail.card.definitionId).sourceCode==='C08'?draftParts()[0]?.choice.options[detail.choiceInputs?.[0]?.optionIndex]?.branch:null;}
  const draftInput = (part,index) => detail?.choiceInputs?.[index] ?? nativeChoiceDraft(part);
  function ownedDraftInput(id) {
    if(!detail||!active())return null;
    for(const [index,part] of draftParts().entries()) {
      const input=nativeCardInput(part,id);if(input)return {...input,part:index};
    }
    return null;
  }
  function draftSelected(input) {
    if(!input)return false;
    const part=draftParts()[input.part],draft=draftInput(part,input.part);
    return input.type==='card'?draft.cardIds?.includes(input.id):input.type==='payment'?draft.paymentIndex===input.index:draft.optionIndex===input.index;
  }
  function selectedCardContent(card,tool=false){
    const face=getCard(card.definitionId),self=room.game.players.find(player=>player.id===room.selfId),others=room.game.players.filter(player=>player.id!==room.selfId);
    const needsTarget=requiresOpponent(face,tool?'activate-tool':'play-character')&&!(face.sourceCode==='C08'&&dianBranch()==='draw');
    const peer=others.find(player=>player.id===(others.length===1?others[0].id:detail?.targetId));
    const parts=draftParts(),ready=parts.every((part,index)=>nativeChoiceReady(part,draftInput(part,index)));
    let operations='',conditions='',summary=face.sourceCode==='M08'?'拆掉对方1件道具，可借用其效果；借用费用另付。':face.summary;
    let selections=[];if(ready)selections=cardDraftSelections(room.game,room.selfId,detail);
    if(active()&&(tool||self.hand.some(item=>cardKey(item)===cardKey(card)))){
      if(tool){
        const timing=face.sourceCode==='T07'?room.game.stage==='draw'&&!room.game.drawStarted:room.game.stage==='use';
        const reserved=face.sourceCode==='T07'&&firstPeekRequired()&&room.game.remainingActions<2;
        if(reserved)conditions='<p>须保留1行动摸第一张牌，本回合不能先用此道具。</p>';
        else if(card.exhausted||!timing)conditions='<p>已使用或不在使用时机。</p>';
        else operations=button('confirm-card','确认使用 · 1行动',{type:'activate-tool'},!ready||needsTarget&&!peer||!room.game.remainingActions,'hy-primary-action');
      }else if(['C04','C07'].includes(face.sourceCode))conditions='<p>只可在对应的回应窗口使用。</p>';
      else if(room.game.stage==='draw')operations=firstPeekRequired()?button('peek','先摸一张 · 1行动'):button('begin-play','进入用牌',{cardId:cardKey(card)});
      else if(face.category==='goods'){
        const trade=tradeAvailability(room.game,room.selfId,card);
        const condition=(label,met)=>`<span class="hy-condition${met?' is-met':' is-unmet'}">${label}${met?'✓':'不足'}</span>`;
        conditions=`<div class="hy-trade-conditions" aria-label="整组交易条件"><span>买：${condition('公库',trade.publicStock)}${condition('货位',trade.space)}${condition('银两',trade.silver)}</span><span>卖：${condition('库存',trade.ownStock)}</span></div>`;
        summary=`交易耗1行动${trade.temporaryFee?` · 买入含临时格${trade.temporaryFee}两`:''}`;
        operations=button('confirm-card',`确认买入 · ${trade.buyTotal}两`,{type:'buy'},!trade.canBuy,'hy-primary-action')+button('confirm-card',`确认出售 · ${trade.sellPrice}两`,{type:'sell'},!trade.canSell);
      }else if(face.category==='stall_permit')operations=button('confirm-card',`确认扩摊 · ${room.game.purchasedStalls?3:6}两`,{type:'buy-stall'},!room.game.remainingActions,'hy-primary-action');
      else if(face.category==='tool')operations=button('confirm-card','确认安装 · 0行动',{type:'install-tool'},!room.game.remainingActions||self.tools.length===3&&!detail.replaceCardId,'hy-primary-action');
      else {
        let missing=needsTarget&&!peer;
        if(face.sourceCode==='C01'&&!benefitDraftState(room.game,room.selfId,detail).available)missing=true;
        if(face.sourceCode==='M01'&&peer)missing=!peer.goods[detail.goodsId];
        if(face.sourceCode==='M08'&&peer)missing=!peer.tools.some(item=>cardKey(item)===detail.toolCardId);
        operations=button('confirm-card','确认使用 · 1行动',{type:'play-character'},!ready||missing||!room.game.remainingActions,'hy-primary-action');
      }
    }
    if(needsTarget&&face.sourceCode!=='C01'&&!shortScreen())conditions+=`<p class="hy-target-summary">${peer?'作用于'+esc(name(peer.id)):'先在下方选择对手'}${detail.goodsId?' · 取得'+goodName(detail.goodsId)+'1件':''}${detail.toolCardId?' · 拆除'+esc(getCard(peer.tools.find(item=>cardKey(item)===detail.toolCardId).definitionId).name):''}</p>`;
    if(parts.length)conditions+=`<p class="hy-decision-preview">${esc(face.sourceCode==='C01'?benefitDraftSummary(room.game,room.selfId,detail,name):parts.map((part,index)=>nativeSelectionText(part,room.game,draftInput(part,index),name)).join('；'))}</p>`;
    if(tool||['ordinary_character','monitored_character'].includes(face.category))conditions+=`<p class="hy-work-cost">${esc(cardDraftCost(room.game,room.selfId,detail,selections,{short:shortScreen()}))}</p>`;
    if(face.category==='tool'&&!tool&&self.tools.length===3)conditions+=`<p>${detail.replaceCardId?'将弃掉'+esc(getCard(self.tools.find(item=>cardKey(item)===detail.replaceCardId).definitionId).name):'点现有装备，选择替换的一件'}。</p>`;
    operations+=button('cancel-card','取消');
    const selectedObject=face.category==='goods'?Object.entries(face.goods).map(([id,count])=>`${goodName(id)}×${count}`).join('／'):face.name;
    return renderTableActionDraft({source:`<button type="button" class="hy-source-reader" data-hy-detail="${esc(cardKey(card))}" aria-label="阅读${esc(face.name)}完整牌文" title="点来源牌阅读完整牌文">${renderCard(card,{interactive:false})}</button>`,heading:`${esc(selectedObject)}${shortScreen()&&needsTarget&&peer?' · '+esc(taskName(peer.id)):''}`,secondary:`<button type="button" data-hy-detail="${esc(cardKey(card))}" aria-label="阅读${esc(face.name)}完整牌文">牌文</button>`,description:`<p class="hy-decision-summary">${esc(summary)}</p>${conditions}`,actions:operations});
  }
  // An equipped expansion card can be an original hand tool's replacement.
  // Preserve that installation intent before the expansion click router runs.
  function isLegacyReplacement(id){
    if(!detail||detail.tool||!active()||getCard(detail.card.definitionId).category!=='tool')return false;
    const self=room.game.players.find(player=>player.id===room.selfId);
    return self.tools.length===3&&self.tools.some(card=>cardKey(card)===id);
  }
  function selectHandCard(card,tool=false){
    if(!card||!room?.game)return;const self=room.game.players.find(player=>player.id===room.selfId);
    const current=(tool?self?.tools:self?.hand)?.find(item=>cardKey(item)===cardKey(card));if(!current)return;
    // Reading a private card is independent from the public action surface.
    // A peer turn or an in-flight receipt must never turn reading into a draft.
    if(actionRequest||!active()&&!mine()){readCard(current);return;}
    const localInput=ownedDraftInput(cardKey(current));
    if(localInput){const part=draftParts()[localInput.part];detail.choiceInputs??=[];detail.choiceInputs[localInput.part]=updateNativeChoice(part,draftInput(part,localInput.part),localInput.type,localInput);render();return;}
    if(tool&&isLegacyReplacement(cardKey(current))){
      detail.replaceCardId=cardKey(current);render();return;
    }
    if(!room.game.pending&&expansionTable.select(current))return;
    const borrowedInput=borrowedCardInput(cardKey(current));
    if(borrowedInput&&available()){const part=borrowParts()[borrowedInput.borrowPart];choiceDraft.toolInputs??=[];choiceDraft.toolInputs[borrowedInput.borrowPart]=updateNativeChoice(part,choiceDraft.toolInputs[borrowedInput.borrowPart],borrowedInput.type,borrowedInput);render();return;}
    if(room.game.pending?.choice&&mine()){
      const input=nativeCardInput(room.game.pending,cardKey(current));
      if(input&&available()&&room.phase==='playing'){choiceDraft=updateNativeChoice(room.game.pending,choiceDraft,input.type,input);decisionStep=Math.max(1,decisionStep);render();}
      else readCard(current);
      return;
    }
    if(room.game.pending?.response&&mine()){
      if(room.game.pending.response.cards?.some(item=>cardKey(item)===cardKey(current))){responseDraft=cardKey(current);render();}
      else readCard(current);
      return;
    }
    motion.cancel();
    const from=motion.capture(root.querySelector(`[data-entity-id="${window.CSS.escape(cardKey(current))}"] .yousei-card`));
    detail={card:current,tool,choiceInputs:[]};render();
    void motion.move({from,to:'.hy-inline-card .yousei-card',duration:180});
  }
  const inlinePending=pending=>!!pending;
  const primaryStep=pending=>pending.kind==='peek'||!!pending.response||['benefit-branch','benefit-good'].includes(pending.choice?.kind);
  const shortScreen=()=>['mobile','compact'].includes($('yg-playfield').dataset.stageProfile);
  const narrowPhone=()=>$('yg-playfield').dataset.stageProfile==='mobile'&&$('yg-playfield').clientWidth<750;
  const taskName=id=>{
    const full=name(id),letters=Array.from(full);if(!shortScreen()||letters.length<=10)return full;
    const seat=room.game?.players.findIndex(player=>player.id===id)??-1;
    return `${seat>=0?`${seat+1}席 · `:''}${letters.slice(0,5).join('')}…`;
  };
  function renderDraftMaterials(){
    if(!detail||!active())return '';
    const face=getCard(detail.card.definitionId),others=room.game.players.filter(player=>player.id!==room.selfId);
    if(face.sourceCode==='C01')return renderBenefitDraft({game:room.game,selfId:room.selfId,detail,name,canChoose:active()});
    const targetId=others.length===1?others[0].id:detail.targetId,peer=others.find(player=>player.id===targetId);
    let html='';
    if(face.sourceCode==='C08'){
      if(dianBranch()==='discard')return peer?`<p class="hy-material-chosen">由${esc(name(peer.id))}自行选择弃牌，直到剩3张。</p>`:
        others.map(player=>{const count=player.handCount??player.hand?.length??0;return button('draft-value',`${name(player.id)} · ${count}张手牌`,{field:'targetId',id:player.id},count<=3,'hy-material-player');}).join('');
      return draftParts().map((part,index)=>renderNativeMaterials({pending:part,game:room.game,selfId:room.selfId,draft:draftInput(part,index),name,canChoose:active(),partIndex:index})).join('');
    }
    const selectingObject=['M01','M08'].includes(face.sourceCode);
    if(requiresOpponent(face,detail.tool?'activate-tool':'play-character')&&others.length>1&&(!selectingObject||!peer))html+=others.map(player=>renderMaterialTarget({label:`${name(player.id)} · ${selectingObject?(face.sourceCode==='M01'?goodsTotal(player.goods)+'件库存':player.tools.length+'件装备'):player.silver+'两'}`,fields:{field:'targetId',id:player.id},disabled:selectingObject&&(face.sourceCode==='M01'?!goodsTotal(player.goods):!player.tools.length),selected:targetId===player.id})).join('');
    if(peer&&face.sourceCode==='M01')html+=GOODS.filter(good=>peer.goods[good.id]>0).map(good=>`<button type="button" class="hy-material-good${detail.goodsId===good.id?' is-selected':''}" data-hy-action="draft-value" data-hy-fields="${esc(JSON.stringify({field:'goodsId',id:good.id}))}">${renderGoodsIcon(good.id)}<strong>${good.name}</strong><small>库存${peer.goods[good.id]}件</small></button>`).join('');
    if(peer&&face.sourceCode==='M08')html+=peer.tools.map(tool=>`<button type="button" class="hy-material-card${detail.toolCardId===cardKey(tool)?' is-selected':''}" data-hy-action="draft-value" data-hy-fields="${esc(JSON.stringify({field:'toolCardId',id:cardKey(tool)}))}">${renderCard(tool,{interactive:false})}<small>拆除${esc(name(peer.id))}的这件</small></button>`).join('');
    if(peer&&selectingObject&&!html)html='<p class="hy-material-chosen">这位对手没有可取的物件，请改选对手。</p>';
    for(const [index,part] of draftParts().entries())html+=renderNativeMaterials({pending:part,game:room.game,selfId:room.selfId,draft:draftInput(part,index),name,canChoose:active(),partIndex:index});
    return html;
  }
  function renderPeerPresentation(){
    if(!peerPresentation)return '';
    const event=peerPresentation.event,face=event.cardId?getCard(event.cardId):null;
    const art=face?`<button type="button" class="hy-source-reader" data-detail-id="${esc(face.id)}" aria-label="阅读${esc(face.name)}完整牌文">${renderCard(face,{interactive:false})}</button>`:renderCardBack();
    return `<section class="hy-table-work hy-peer-played" aria-label="对手刚刚的公开操作"><div class="hy-work-face">${art}</div><div class="hy-work-copy"><strong>${esc(publicEventText(event,room.players))}</strong>${face?`<p class="hy-work-effect">${esc(face.summary)}</p>`:'<p>牌面仅持有者可见。</p>'}</div></section>`;
  }
  function renderTableStep(pending){
    const context=decisionContext(pending,room.game,room.selfId,taskName),own=mine();
    const source=pending.kind==='peek'?pending.privatePool?.[0]:pending.sourceCards?.[0];
    const face=source?getCard(source.definitionId):context.source;
    const art=source?renderCard(source,{interactive:false,configuration:room.game.configuration}):face?renderCard(face,{interactive:false,configuration:room.game.configuration}):renderCardBack();
    const canChoose=own&&available()&&room.phase==='playing';
    let actions='',preview='',cost=context.cost,responseChosen=false;
    const selected=choiceDraft?.optionIndex??-1;
    if(pending.kind==='peek'){
      actions=own?button('keep-peek',narrowPhone()?'留下用牌':'留下 · 进入用牌',{},!canChoose,'hy-primary-action')+button('discard-peek',narrowPhone()?'弃掉续摸':'弃掉 · 继续摸牌',{},!canChoose):`<span>等待${esc(name(pending.actorId))}留弃</span>`;
    }else if(pending.response){
      const selectedResponse=pending.response.cards?.find(card=>cardKey(card)===responseDraft);
      responseChosen=!!selectedResponse;
      const responseHint=pending.response.kind==='counter'
        ?selectedResponse?shortScreen()?`锦衣卫和${face?.name??'来源人物'}弃置。`:'锦衣卫与来源人物弃置；取消本次效果。':'点锦衣卫取消此效果，或不回应。'
        :selectedResponse?'番商弃置，交易牌加入你的手牌。':'点下方番商取得交易牌；不回应则顺位继续。';
      preview=own?`<p class="hy-work-preview">${esc(pending.response.cards?.length?responseHint:'你没有可用回应牌；不回应后继续原效果。')}</p>`:'';
      actions=own?(selectedResponse?button('respond',shortScreen()&&pending.response.kind==='counter'?'确认反制':`打出${getCard(selectedResponse.definitionId).name} · 0行动`,{cardId:cardKey(selectedResponse)},!canChoose,'hy-primary-action'):'')+button('decline-response','不回应',{},!canChoose):`<span>等待${esc(name(pending.actorId))}回应</span>`;
    }else if(own){
      const kind=pending.choice.kind,options=pending.choice.options;
      if(kind!=='benefit-branch'&&selected<0)preview='<p class="hy-work-preview">在货物选项中选一种，确认前可改选。</p>';
      const option=options[selected];
      if(option){
        if(kind==='benefit-good'){const quantity=Math.min(2,room.game.bankGoods[option.goodsId]);preview=`<p class="hy-work-preview">${renderGoodsIcon(option.goodsId)}<strong>将取得${goodName(option.goodsId)} ×${quantity}</strong><span>可改选</span></p>`;cost='发动已用1行动 · 本次选择不再消耗行动。超容量再选保留；首次占临时格付2两。';}
        else preview=`<p class="hy-work-preview"><strong>你${option.branch==='draw'?'抽最多2张牌':'取得同种最多2件货物'}</strong>；${esc(taskName(pending.targetId))}${option.branch==='draw'?'取得同种最多2件货物':'抽最多2张牌'}。</p>`;
      }
      if(option)actions=(kind==='benefit-branch'?button('inline-rechoose','改选',{},!canChoose,'hy-rechoose'):'')+button('inline-confirm',kind==='benefit-good'?'确认取得货物':'确认收益分配',{},!canChoose,'hy-primary-action');
    }
    let heading=pending.kind==='peek'?(face?.name??'伙伴正在私看'):titleByKind[pending.choice?.kind]??'当前回应';
    let description=pending.kind==='peek'?(own&&face?face.summary:`${name(pending.ownerId)}正在私看，其他人只见牌背。`):context.reason;
    let outcome='';
    if(pending.kind==='peek'){outcome=own?'留下进入用牌；弃掉可继续摸牌。':'等待本人完成留弃。';cost=narrowPhone()?'已用1行动；留弃免费。':'摸牌已用1行动 · 留／弃不再消耗行动。';}
    else if(pending.response){
      const ownerLabel=shortScreen()?`${room.game.players.findIndex(player=>player.id===pending.ownerId)+1}席`:taskName(pending.ownerId);
      heading=`${ownerLabel} → ${own?'你回应':taskName(pending.actorId)}`;
      description=own&&pending.code==='M01'&&pending.target?.goodsId?responseChosen?`阻止对方拿走${goodName(pending.target.goodsId)}×1。`:`将取走你的${goodName(pending.target.goodsId)}1件。`:face?.summary??context.reason;
      cost='回应不花行动和银两。';
    }
    else if(pending.choice?.kind==='benefit-branch'){description=`${own?'你':taskName(pending.actorId)}先取一项收益，${taskName(pending.targetId)}取得另一项。`;cost='发动已用1行动 · 本次选择不再消耗行动。';}
    else if(pending.choice?.kind==='benefit-good'){description=pending.ownerId===pending.actorId?`${own?'你':taskName(pending.actorId)}选择了货物收益，现在选一种。`:`${taskName(pending.ownerId)}选择抽牌，因此${own?'你':taskName(pending.actorId)}取得货物收益。`;if(selected<0)cost='发动已用1行动 · 本次选择不再消耗行动。';}
    return `<section class="hy-table-work${pending.kind==='peek'?' hy-table-peek':''}${selected>=0?' has-draft':''}" aria-label="桌面当前牌与真实步骤" data-step-kind="${esc(pending.choice?.kind??pending.response?.kind??pending.kind)}"><div class="hy-work-face">${face?`<button type="button" class="hy-source-reader" data-detail-id="${esc(face.id)}" aria-label="阅读${esc(face.name)}完整牌文" title="点来源牌阅读完整牌文">${art}</button>`:art}</div><div class="hy-work-copy"><div class="hy-work-heading" title="${esc(name(pending.ownerId))} → ${esc(name(pending.actorId))}"><strong>${esc(heading)}</strong><small>${pending.kind==='peek'?'本次摸牌':pending.response?esc(face?.name??'来源牌'):esc(taskName(pending.ownerId))+'的'+esc(face?.name??'牌')}</small></div><div class="hy-work-description">${description?`<p class="hy-work-effect">${esc(description)}</p>`:''}${preview}${outcome?`<p class="hy-work-outcome">${esc(outcome)}</p>`:''}<p class="hy-work-cost">${esc(cost)}</p></div>${actions?`<div class="hy-work-actions">${actions}</div>`:''}</div></section>`;
  }
  function syncMarketChoice(){
    const pending=room?.game?.pending,choosing=pending?.choice?.kind==='benefit-good'&&mine();
    $('yg-public-stock').classList.toggle('hy-market-choice',choosing);
    for(const node of root.querySelectorAll('[data-market-good]')){
      const index=choosing?pending.choice.options.findIndex(option=>option.goodsId===node.dataset.marketGood):-1;
      node.disabled=choosing&&(index<0||!available()||room.phase!=='playing');
      node.classList.toggle('is-legal',choosing&&index>=0);
      if(choosing){node.setAttribute('aria-pressed',String(index>=0&&choiceDraft?.optionIndex===index));node.setAttribute('aria-label',`选择${goodName(node.dataset.marketGood)}，公库${room.game.bankGoods[node.dataset.marketGood]}件`);}
      else node.removeAttribute('aria-pressed');
    }
  }
  function decision(){
    const pending=room?.game?.pending;if(!pending)return;detail=null;
    presentedDecisionId=pending.decisionId;
    if($('yg-decision').open)$('yg-decision').close();
    render();
  }
  function showHistory(){if(!room?.game)return;closeDialogs();battleReport.open();}
  function updateClock(){if(!room||concealed)return;const clock=room.game?.clock??room.turnClock;
    const advance=practice&&state.practiceSnapshot?.active===false?0:Math.max(0,(window.performance?.now()??Date.now())-receivedAt);
    const remaining=!clock?0:clock.paused||clock.deadlineAt===null?clock.remainingMs:Math.max(0,clock.deadlineAt-serverTime-advance);
    const seconds=Math.ceil(remaining/1000);$('yg-clock').textContent=clock?`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:'--:--';
    $('yg-clock-label').textContent=clock?.paused?'余时已冻结':clock?.kind==='decision'?'对方选择 · 主动钟冻结':'主动回合余时';
  }
  function renderRoomControl(){
    const node=$('hy-room-control'),isPlayer=room.selfRole==='player';
    const resumable=!practice&&isPlayer&&room.phase==='paused'&&room.game?.holds.manual;
    const voting=!practice&&isPlayer&&room.phase==='playing'&&room.pause;
    node.hidden=!resumable&&!voting;
    node.disabled=!available();
    if(resumable){node.textContent='继续对局';node.setAttribute('data-hy-action','resume');node.setAttribute('data-hy-fields','{}');node.setAttribute('aria-label','夜市已暂停，继续对局并恢复原步骤');}
    else if(voting){
      const agreed=room.pause.agreedIds.includes(room.selfId),progress=`${room.pause.agreedIds.length}/${room.game?.players.length??room.players.length}`;
      node.textContent=`${agreed?'撤回同意':'同意暂停'} ${progress}`;
      node.setAttribute('data-hy-action','pause');node.setAttribute('data-hy-fields',JSON.stringify({agree:!agreed}));
      node.setAttribute('aria-label',`${name(room.pause.requestedBy)}申请暂停，${progress}人同意；${agreed?'撤回你的同意':'同意暂停并保留当前步骤'}`);
    }
  }
  function render({preserveTaskDOM=false}={}){
    expansionTable.syncView(room);
    restoreActionGate();
    const game=room.game,self=room.players.find(player=>player.id===room.selfId),isPlayer=room.selfRole==='player',host=room.hostId===room.selfId;
    const setup=supplySetup(room.players.length,room.hyakkiConfig);
    $('yg-room-code').textContent=practice?'本机练习 · 电脑只看自己的手牌':room.phase==='waiting'
      ? `房间 ${room.roomCode} · 每回合${room.hyakkiConfig.actionLimit}步 · 每种${setup.goodsPerType}件`
      : `房间 ${room.roomCode} · ${room.spectators?.length??0}位观众`;
    $('yg-title').textContent=room.phase==='waiting'?'伙伴准备好，就开张。':room.phase==='paused'?'夜市暂停 · 当前步骤保留':room.phase==='aborted'?'本局已取消':room.phase==='finished'?`${game?.result.winnerIds.map(name).join('、')??'赢家'}获胜`:
      game?.pending?`${mine()?'轮到你决定':name(game.pending.actorId)+'正在选择'}`:game?.turnPlayerId===room.selfId?'轮到你经营':name(game?.turnPlayerId)+'正在经营';
    $('yg-title').title=$('yg-title').textContent;
    root.querySelector('.yg-track').hidden=['waiting','finished','aborted'].includes(room.phase);
    $('yg-readiness').hidden=room.phase!=='waiting';
    $('yg-readiness').innerHTML=room.players.map(player=>`<span><strong>${esc(player.name)}${player.id===room.hostId?' · 房主':''}</strong><b>${player.ready?'已准备':'未准备'}</b></span>`).join('')+(room.players.length<2?'<span>等待第二位伙伴</span>':'');
    let note='',controls='';
    if(room.phase==='waiting'){
      note=`2～6人夜市 · 20两开局 · 每人5张手牌；全部玩家准备后由房主开始。${setupText(setup)}`;
      if(practice)controls=button('practice-restart','开始练习');
      else {if(isPlayer)controls+=button('ready',self.ready?'取消准备':'准备好了',{ready:!self.ready},!available());
        if(host)controls+=button('start','开始游戏',{},!available()||room.players.length<2||room.players.length>6||!room.players.every(player=>player.ready));
        controls+=button('set-role',isPlayer?'改为观战':'加入对局',{role:isPlayer?'spectator':'player'},!available()||(isPlayer?host:room.players.length>=6))+button('invite','复制邀请');
        if(host)controls+=`<div class="hy-setup-fields">${expansionSetupFields('hy-room',room.hyakkiConfig,!available())}<label class="hy-setup-field"><span>每回合行动</span><select id="hy-action-limit" ${available()?'':'disabled'}>${Array.from({length:10},(_,i)=>`<option value="${i+1}" ${room.hyakkiConfig.actionLimit===i+1?'selected':''}>${i+1}步</option>`).join('')}</select></label><label class="hy-setup-field"><span>每种公共货物</span>${supplySelect('hy-goods-limit',setup.goodsPerType,!available())}</label><div class="hy-setup-recommend"><span>${setup.goodsPerTypeRecommended?`按${setup.playerCount}人推荐每种${setup.goodsPerTypeRecommended}件`:'凑齐2人后提供推荐'}</span>${button('setup-recommend','采用推荐',{},!available()||!setup.deckSize||setup.goodsSupplyMode==='recommended')}</div></div>`;
      }
    }else if(['finished','aborted'].includes(room.phase)){
      note=game?.result?.aborted?'没有赢家，本局财富不计入账号。':`最终银两：${game?.players.map(player=>`${name(player.id)} ${player.silver}两`).join(' · ')}。本局财富不计入账号。`;
      if(practice)controls=button('practice-restart','再来一局');else if(host)controls=button('rematch','回准备室',{},!available());
      controls+=button('history','公开记录');
    }else if(room.phase==='paused'){
      note=game?.holds.capacity?'记录容量已满，当前经济操作已停止；请保留此局。':game?.holds.manual?'全员同意暂停，保留七天；恢复后继续原步骤。':'伙伴意外离线，保席30分钟；恢复后继续原步骤。';
      if(game?.pending)controls+=button('decision','查看待决步骤');
    }else if(game?.pending){
      note=game.pending.response?'回应期间主动操作冻结；到时按当前默认选项处理。':game.pending.auction?'整组拍品，完整付款；关闭窗口不会放弃竞价。':'材料与费用已保存，请完成当前步骤。';
      controls=button('decision',mine()?'处理当前选择':'查看公开步骤',{},false);
    }else if(active()){
      note=game.stage==='draw'?(firstPeekRequired()?'先摸第一张牌，留下或弃掉都花1行动。':game.deckCount+game.discard.length===0?'已无可摸的牌，可以进入用牌。':'已摸过牌；可继续摸，也可进入用牌。每摸一张花1行动。'):'把手牌拖到桌面，或点牌选中使用。';
      if(game.stage==='draw')controls+=button('peek',firstPeekRequired()?'摸第一张 · 1行动':'再摸一张 · 1行动',{},game.deckCount+game.discard.length===0)+button('finish-draw','进入用牌',{},firstPeekRequired());
      if(qualifiesForIdleReward(game)&&!firstPeekRequired())note+=' 现在结束回合可得1两。';
      controls+=button('end-turn','结束回合',{},firstPeekRequired());
    }else note=isPlayer?`等待${name(game?.turnPlayerId)}，可查看卡牌与公开记录。`:'正在观战；不会显示私牌和私看候选。';
    if(room.pause)note+=` ${name(room.pause.requestedBy)}申请暂停（${room.pause.agreedIds.length}/${game?.players.length??room.players.length}同意）。`;
    if(detail){
      // Free installation changes ownership zones without changing actionsUsed.
      // Authority may arrive before the request receipt: a card remaining known
      // in the discard pile or equipment is no longer a valid hand draft.
      const owner=game?.players.find(player=>player.id===room.selfId);
      const current=(detail.tool?owner?.tools:owner?.hand)?.find(card=>cardKey(card)===cardKey(detail.card));
      if(!current||game?.pending||!isPlayer)detail=null;
      else {
        detail.card=current;
        if(detail.replaceCardId&&!owner.tools.some(card=>cardKey(card)===detail.replaceCardId))detail.replaceCardId=null;
        const target=game.players.find(player=>player.id!==room.selfId&&(game.players.length===2||player.id===detail.targetId));
        if(detail.toolCardId&&!target?.tools.some(card=>cardKey(card)===detail.toolCardId))detail.toolCardId=null;
      }
    }
    root.classList.toggle('hy-card-selected',!!detail);
    const tableStep=!expansionTable.handlesPending(game?.pending)&&inlinePending(game?.pending);
    root.classList.toggle('hy-pending-inline',tableStep);
    const native=tableStep&&!primaryStep(game.pending),nativeDraft=choiceDraft??nativeChoiceDraft(game?.pending);
    const taskMarkup=tableStep?native?renderNativeWork({pending:game.pending,game,selfId:room.selfId,draft:nativeDraft,step:decisionStep,short:shortScreen(),narrow:narrowPhone(),name:taskName,canChoose:mine()&&available()&&room.phase==='playing',readyOverride:borrowReady(),costOverride:borrowCost(),borrowPreview:borrowDraft()?borrowParts().map((part,index)=>nativeSelectionText(part,game,borrowDraft().choiceInputs[index]??nativeChoiceDraft(part),name)).join('；'):null}):renderTableStep(game.pending):detail?selectedCardContent(detail.card,detail.tool):peerPresentation?renderPeerPresentation():`<p class="yg-scene-note">${esc(note)}</p><div class="yg-table-actions">${controls}</div>`;
    if(!expansionTable.hasDraft()&&!expansionTable.handlesPending(game?.pending))syncTaskMarkup($('yg-scene-content'),taskMarkup,preserveTaskDOM&&tableStep);
    let materialHtml=native?renderNativeMaterials({pending:game.pending,game,selfId:room.selfId,draft:nativeDraft,name,canChoose:mine()&&available()&&room.phase==='playing'}):renderDraftMaterials();
    const choosingBenefitBranch=game?.pending?.code==='C01'&&game.pending.choice?.kind==='benefit-branch'&&mine();
    if(choosingBenefitBranch)materialHtml=renderBenefitBranches({pending:game.pending,draft:choiceDraft,canChoose:available()&&room.phase==='playing'});
    const receivingBenefit=game?.pending?.code==='C01'&&game.pending.choice?.kind==='benefit-good'&&mine();
    if(receivingBenefit)materialHtml=renderBenefitGoods({game,pending:game.pending,draft:choiceDraft,canChoose:available()&&room.phase==='playing'});
    const borrowed=borrowDraft();
    if(borrowed){
      const borrowingChoice=`<section class="hy-material-step"><h3>已拆除的道具</h3><div class="hy-material-borrow-choice">${materialHtml}</div></section>`;
      let borrowingMaterials='';
      if(requiresOpponent(getCard(borrowed.card.definitionId),'activate-tool')&&game.players.length>2)borrowingMaterials+=`<section class="hy-material-step"><h3>选择借用对象</h3><div class="hy-material-options">${game.players.filter(player=>player.id!==room.selfId).map(player=>button('native-borrow-target',name(player.id),{targetId:player.id},!available(),`hy-material-player${borrowed.targetId===player.id?' is-selected':''}`)).join('')}</div></section>`;
      for(const [index,part] of borrowParts().entries())borrowingMaterials+=renderNativeMaterials({pending:part,game,selfId:room.selfId,draft:borrowed.choiceInputs[index]??nativeChoiceDraft(part),name,canChoose:available(),borrowPartIndex:index});
      materialHtml=`<div class="hy-material-steps" data-material-flow="borrow">${borrowingChoice}${borrowingMaterials}</div>`;
    }
    const groupedMaterials=!!borrowed||[...(native?[game.pending]:[]),...(detail?draftParts():[])].some(part=>['exchange','payment-good'].includes(choiceModel(part)?.type));
    const targetedObject=detail&&['M01','M08','C08'].includes(getCard(detail.card.definitionId).sourceCode);
    const exchangePart=detail&&getCard(detail.card.definitionId).sourceCode==='C06'?draftParts()[0]:native?game.pending:null;
    const exchangeState=exchangePart?nativeExchangeState(exchangePart,detail?draftInput(exchangePart,0):nativeDraft):null;
    const benefitState=detail&&getCard(detail.card.definitionId).sourceCode==='C01'?benefitDraftState(game,room.selfId,detail):choosingBenefitBranch?{step:'branch'}:receivingBenefit?{step:'receive'}:null;
    const materialPeer=targetedObject?game.players.find(player=>player.id!==room.selfId&&(game.players.length===2||player.id===detail.targetId)):null;
    $('hy-task-materials').classList.toggle('hy-object-selection',!!targetedObject||!!exchangeState||!!benefitState||groupedMaterials);
    $('hy-task-materials').classList.toggle('hy-grouped-selection',groupedMaterials);
    $('hy-task-materials').classList.toggle('hy-exchange-selection',!!exchangeState);
    $('hy-task-materials').classList.toggle('hy-benefit-selection',!!benefitState);
    // Keep one readable decision surface through every step on short screens.
    // Choosing the opponent also needs room; reserving it only after selection
    // squeezes names into narrow columns and can put choices behind the hand.
    $('hy-task-materials').classList.toggle('hy-object-expanded',!!targetedObject||!!exchangeState||!!benefitState||groupedMaterials);
    $('hy-task-materials').hidden=!materialHtml;
    $('hy-material-rechoose').hidden=!(targetedObject&&(dianBranch()||materialPeer&&game.players.length>2));
    $('hy-material-rechoose').textContent=detail&&getCard(detail.card.definitionId).sourceCode==='C08'?'改选方式':'改选对手';
    $('hy-task-material-title').textContent=detail?(draftParts().map(part=>part.title).join('；')||'选择本次使用的对象'):game?.pending?.auction?'整组拍品':game?.pending?.choice?.visibility==='private'?'本步材料 · 只有你可见':'本步公开材料';
    if(targetedObject)$('hy-task-material-title').textContent=materialPeer?`选择${name(materialPeer.id)}的${getCard(detail.card.definitionId).sourceCode==='M01'?'1件货物':'1件装备'}`:'先选择一位对手';
    if(detail&&getCard(detail.card.definitionId).sourceCode==='C08')$('hy-task-material-title').textContent=dianBranch()==='discard'?(materialPeer?`由${name(materialPeer.id)}弃牌至3张`:'选择弃牌的对手'):dianBranch()==='draw'?'自己补牌至5张':'典史 · 选择效果';
    if(exchangeState)$('hy-task-material-title').textContent=exchangeState.step==='from'?'货郎 · 先选交出的货物':'货郎 · 再选换入的货物';
    if(benefitState)$('hy-task-material-title').textContent=`把戏人 · ${{branch:'1 选择自己的收益',goods:'2 选择自己的货物',target:'选择另一位受益者',ready:'核对双方收益',receive:'选择你的收益货物'}[benefitState.step]}`;
    if(!expansionTable.hasDraft()&&!expansionTable.handlesPending(game?.pending))syncTaskMarkup($('hy-task-material-cards'),materialHtml,preserveTaskDOM&&tableStep);
    root.querySelector('.yg-lower').classList.toggle('hy-has-materials',!$('hy-task-materials').hidden);
    root.classList.toggle('hy-native-pending',native);
    syncMarketChoice();renderRoomControl();motion.sync();
    for(const node of root.querySelectorAll('#yg-hand [data-entity-id]')){
      const borrowedInput=borrowedCardInput(node.dataset.entityId),localInput=ownedDraftInput(node.dataset.entityId),input=borrowedInput??(native&&mine()?nativeCardInput(game.pending,node.dataset.entityId):localInput);
      const selected=borrowedInput?borrowedSelected(borrowedInput):localInput?draftSelected(localInput):input?input.type==='card'?nativeDraft.cardIds?.includes(input.id):input.type==='payment'?nativeDraft.paymentIndex===input.index:nativeDraft.optionIndex===input.index:!!detail&&!detail.tool&&node.dataset.entityId===cardKey(detail.card)||tableStep&&node.dataset.entityId===responseDraft;
      node.classList.toggle('is-selected',!!selected);node.classList.toggle('is-task-material',!!input);node.querySelector('button')?.setAttribute('aria-pressed',String(!!selected));
    }
    for(const node of root.querySelectorAll('#yg-tools [data-tool-id]')){
      const borrowedInput=borrowedCardInput(node.dataset.toolId),localInput=ownedDraftInput(node.dataset.toolId),input=borrowedInput??(native&&mine()?nativeCardInput(game.pending,node.dataset.toolId):localInput);
      node.classList.toggle('is-task-material',!!input);node.classList.toggle('is-selected',borrowedInput?borrowedSelected(borrowedInput):localInput?draftSelected(localInput):input?(input.type==='payment'?nativeDraft.paymentIndex===input.index:nativeDraft.optionIndex===input.index):detail?.replaceCardId===node.dataset.toolId);
    }
    $('yg-portrait-decision').innerHTML=game?.pending?`<strong>${esc(mine()?'轮到你选择':'对方正在选择')}</strong>${button('decision','查看当前步骤')}`:'';
    $('yg-rotation').querySelector('small').textContent=practice?'本机练习 · 退出保留进度':'牌局已保存在房间，转向不会重新开始。';
    $('hy-pause').hidden=practice||!isPlayer||room.phase!=='playing';
    $('hy-host').hidden=practice||!(host||room.hostCanTakeOver);
    $('hy-practice-state').textContent=practice?(state.practiceSnapshot?.storageNote||'进度只保存在这个浏览器；打开设置、看牌或切后台会暂停电脑。'):'';
    $('hy-practice-reload').hidden=!practice||!(state.practiceSnapshot?.conflict||state.practiceSnapshot?.requiresRestart);
    $('hy-connection').hidden=state.connection==='online'&&!state.pending&&state.canAct!==false;
    $('hy-connection-text').textContent=state.pending?'操作结果正在核对，请勿重复提交。':state.canAct===false?'当前不能保存操作，请恢复存储或读取进度。':'正在恢复连接，原席位和已保存步骤会保留。';

    // Preserve an old pending dialog without overriding an in-flight lock afterward.
    if($('yg-decision').open){$('yg-decision-body').querySelectorAll('button,input,select').forEach(node=>{if(!node.dataset.hyDetail&&!['choice-page','cards-page'].includes(node.dataset.hyAction))node.disabled=!available()||room.phase!=='playing';});}
    base.syncActions?.();expansionTable.render(room); updateClock();renderActionGate();
  }
  function applyView(next,options={}){
    if(destroyed)return;
    restoreActionGate();
    const before=room;
    const nextScope=sameScope(next),changed=scope!==nextScope,newDecision=next.game?.pending?.decisionId??null;
    const preserveTaskDOM=!changed&&!!newDecision&&decisionId===newDecision;
    const confirmed=!changed&&state.connection==='online'&&(options.connection??'online')==='online'&&next.game?.publicEventSequence>before?.game?.publicEventSequence;
    if(confirmed)motion.cancel();
    const nextPeer=changed||options.connection&&options.connection!=='online'?null:opponentTableEvent(before,next,peerPresentation);
    const newPeerEvent=confirmed&&nextPeer&&nextPeer!==peerPresentation?nextPeer.event:null;
    const peerOrigin=newPeerEvent?motion.capture(`[data-public-player="${window.CSS.escape(newPeerEvent.actorSeatId)}"] .nm-hand-count`):null;
    peerPresentation=nextPeer;
    const selectedCommit=confirmed&&detail?(next.game.lastPublicEvents??[]).find(event=>event.actorSeatId===next.selfId&&event.cardId===detail.card.definitionId&&['character-played','trade-bought','trade-sold','tool-installed','tool-activated'].includes(event.type)):null;
    const previousCard=confirmed?motion.capture('.hy-work-face .yousei-card')??(selectedCommit?motion.capture('.hy-inline-card .yousei-card'):null):null;
    const previousDeck=confirmed?motion.capture('#yg-draw-pile .yousei-card'):null;
    const previousSelectedId=selectedCommit?cardKey(detail.card):null;
    const materialMove=confirmed?materialTransition(before?.game,next.game,next.selfId,choiceDraft):null;
    const materialCard=materialMove?.card;
    const fromMaterial=materialCard&&!materialCard.fromDeck?motion.capture(root.querySelector(`[data-entity-id="${window.CSS.escape(materialCard.fromId)}"] .yousei-card`))??motion.capture(root.querySelector(`#yg-tools [data-tool-id="${window.CSS.escape(materialCard.fromId)}"] .yousei-card`))??motion.capture(root.querySelector(`[data-material-card="${window.CSS.escape(materialCard.fromId)}"] .yousei-card`))??(before.game.pending.sourceCards?.some(card=>cardKey(card)===materialCard.fromId)?motion.capture('.hy-work-face .yousei-card'):null):null;
    const fromGoods=materialMove?.goods?motion.capture(materialMove.goods.delta<0?`#yg-stock-slots .yg-owned-good[title="${goodName(materialMove.goods.id)}"] .yousei-good-icon`:`[data-material-good="${materialMove.goods.id}"] .yousei-good-icon`):null;
    const previousGood=confirmed?motion.capture('#yg-market [aria-pressed=true] .yousei-good-icon'):null;
    const previousGoodId=confirmed&&before?.game?.pending?.choice?.kind==='benefit-good'?before.game.pending.choice.options?.[choiceDraft?.optionIndex]?.goodsId:null;
    if(selectionScope(room)!==selectionScope(next))detail=null;
    if(changed){generation++;actionRequest=null;motion.cancel();battleReport.invalidate();closeDialogs();inspectorKind=null;detail=null;choiceDraft=null;responseDraft=null;}
    if(decisionId!==newDecision){choiceDraft=null;responseDraft=null;cardsPage=0;decisionStep=0;presentedDecisionId=null;if(newDecision&&next.game?.pending?.actorId===next.selfId&&$('hy-card-reader').open)$('hy-card-reader').close();if($('yg-decision').open)$('yg-decision').close();}
    room=next;scope=nextScope;state={connection:'online',pending:false,canAct:true,...options};concealed=false;
    root.classList.remove('hy-concealed');receivedAt=window.performance?.now()??Date.now();serverTime=room.serverTime??Date.now();
    const economySnapshot=confirmed?base.captureTable?.():null;
    base.applyView(tableProjection(next));render({preserveTaskDOM});handDrag.sync();battleReport.sync();
    if(inspectorKind==='discard'&&$('yg-inspector').open&&room.game)syncDiscardReader();
    if(confirmed)base.animateTable?.(economySnapshot,before,next);
    const newOwnedDecision=!!newDecision&&newDecision!==presentedDecisionId&&mine();decisionId=newDecision;
    if(newOwnedDecision&&available()&&room.phase==='playing')decision();
    if(confirmed){
      const pending=next.game.pending,events=next.game.lastPublicEvents??[];
      if(pending?.kind==='peek'&&pending.ownerId===next.selfId&&pending.privatePool?.length&&pending.decisionId!==before.game.pending?.decisionId)
        void motion.move({from:previousDeck,to:'.hy-work-face .yousei-card',flip:true,duration:200});
      else if(before.game.pending?.kind==='peek'&&before.game.pending.ownerId===next.selfId&&events.some(event=>event.type==='draw-kept'&&event.actorSeatId===next.selfId)){
        const id=before.game.pending.privatePool?.[0]?.cardId;
        const destination=id?root.querySelector(`#yg-hand [data-entity-id="${window.CSS.escape(id)}"] .yousei-card`):null;
        if(destination){const hand=$('yg-hand'),rect=destination.getBoundingClientRect(),area=hand.getBoundingClientRect();if(rect.right>area.right)hand.scrollLeft+=rect.right-area.right+4;}
        void motion.move({from:previousCard,to:destination,duration:260});
      }else if(before.game.pending?.kind==='peek'&&before.game.pending.ownerId===next.selfId&&events.some(event=>event.type==='draw-discarded'&&event.actorSeatId===next.selfId))
        void motion.move({from:previousCard,to:'#yg-discard-art .yousei-card',duration:260});
      else if(previousGood&&previousGoodId&&next.game.players.find(player=>player.id===next.selfId)?.goods[previousGoodId]>before.game.players.find(player=>player.id===next.selfId)?.goods[previousGoodId])
        void motion.move({from:previousGood,to:`#yg-stock-slots .yg-owned-good[title="${goodName(previousGoodId)}"] .yousei-good-icon`,duration:240});
      else if(materialMove?.card){
        const card=materialMove.card,to=card.zone==='discard'?'#yg-discard-art .yousei-card':card.zone==='tool'?`#yg-tools [data-tool-id="${window.CSS.escape(card.toId)}"] .yousei-card`:`#yg-hand [data-entity-id="${window.CSS.escape(card.toId)}"] .yousei-card`;
        const destination=root.querySelector(to);
        if(destination&&card.zone==='hand')destination.closest('.yg-hand-card')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
        void motion.move({from:card.fromDeck?previousDeck:fromMaterial,to,duration:240});
      }else if(materialMove?.goods&&fromGoods){
        const good=materialMove.goods,to=good.toPeerId?`[data-public-player="${window.CSS.escape(good.toPeerId)}"] [data-good-id="${good.id}"] .yousei-good-icon`:good.delta>0?`#yg-stock-slots .yg-owned-good[title="${goodName(good.id)}"] .yousei-good-icon`:`#yg-public-stock [data-market-good="${good.id}"] .yousei-good-icon`;
        void motion.move({from:fromGoods,to,duration:240});
      }
      else if(previousCard&&previousSelectedId&&['tool-installed','tool-activated'].includes(selectedCommit.type)&&!pending)
        void motion.move({from:previousCard,to:`#yg-tools [data-tool-id="${window.CSS.escape(previousSelectedId)}"] .yousei-card`,duration:180});
      else if(previousCard&&selectedCommit&&['character-played','trade-bought','trade-sold','tool-activated'].includes(selectedCommit.type))
        void motion.move({from:previousCard,to:pending?.sourceCards?.length?'.hy-work-face .yousei-card':'#yg-discard-art .yousei-card',duration:180});
      else if(newPeerEvent){
        const peerHand=`[data-public-player="${window.CSS.escape(newPeerEvent.actorSeatId)}"] .nm-hand-count`;
        if(newPeerEvent.type==='draw-kept'&&previousCard)void motion.move({from:previousCard,to:peerHand,duration:380});
        else {
          const from=newPeerEvent.type==='draw-peeked'?previousDeck:peerOrigin&&previousDeck?{node:previousDeck.node,rect:{...previousDeck.rect,x:peerOrigin.rect.x,y:peerOrigin.rect.y}}:previousDeck;
          const to=pending?'.hy-work-face .yousei-card':'.hy-peer-played .yousei-card';
          void motion.move({from,to,flip:!!newPeerEvent.cardId,duration:420});
        }
      }
    }
  }
  function conceal({message='正在恢复房间…',loginHref=null,reauthHref=null}={}){
    $('yg-leave-confirm').removeAttribute('aria-busy');
    restoreActionGate();root.setAttribute('aria-busy','false');
    handDrag.cancel();motion.cancel();base.cancelTable?.();generation++;actionRequest=null;concealed=true;battleReport.invalidate();closeDialogs();inspectorKind=null;detail=null;choiceDraft=null;responseDraft=null;decisionId=null;presentedDecisionId=null;scope=null;
    if(room)base.applyView(tableProjection({...room,game:null,phase:'waiting',selfRole:'spectator',selfId:null}));
    peerPresentation=null;room=null;$('hy-reader-title').textContent='完整牌文';root.querySelectorAll('#yg-scene-content,#hy-task-material-cards,#yg-inspector-body,#yg-decision-body,#hy-reader-body,#hy-decision-sources,#yg-portrait-decision,#yg-chat-decision-label').forEach(node=>node.replaceChildren());
    root.classList.add('hy-concealed');$('hy-connection').hidden=false;$('hy-connection-text').textContent=message;
    for(const[id,href]of[['hy-login',loginHref],['hy-reauth',reauthHref]]){const link=$(id);link.hidden=!href;if(href)link.href=href;else link.removeAttribute('href');}
  }
  async function invite(){if(!room||practice)return;const url=new URL(window.location.href);url.pathname=url.pathname.replace(/[^/]*$/u,'');url.search='?room='+room.roomCode;url.hash='';try{await window.navigator.clipboard.writeText(url.href);feedback('邀请已复制。');}catch{inspect('房间邀请',`<p>房间 ${esc(room.roomCode)}</p><input value="${esc(url.href)}" readonly aria-label="房间邀请链接">`);}}
  function leaveDialog(next='lobby'){destination=next;closeDialogs();$('yg-leave').querySelector('.dialog-heading h2').textContent=practice?'返回大厅？':room?.selfRole==='player'&&['playing','paused'].includes(room.phase)?'认输并离开？':'退出房间？';
    $('hy-leave-note').textContent=practice?'保留本机练习进度，下次继续。':room?.selfRole==='player'&&['playing','paused'].includes(room.phase)?room.game?.players.length>2?'多人局主动退出将取消本局，没有赢家。只想暂时离开请用“返回大厅，保留席位”。':'这会结束本局，由对方获胜。只想暂时离开请用“返回大厅，保留席位”。':'退出后释放自己的席位或观战位置。';$('yg-leave').showModal();}
  function syncPracticeSetup(){
    if(!practiceSetup)return;
    const setup=supplySetup(practiceSetup.playerCount,practiceSetup);practiceSetup={...practiceSetup,...setup};
    $('hy-practice-goods').value=String(setup.goodsPerType);$('hy-practice-profile').textContent=setupText(setup);
    root.querySelector('[data-hy-action="practice-recommend"]').disabled=setup.goodsSupplyMode==='recommended';
  }
  function openPracticeRestart(){
    const currentMatch=room?.matchId??room?.game?.matchId??null;
    if(!practiceSetup||practiceSetupMatchId!==currentMatch){
      const snapshot=state.practiceSnapshot,config=snapshot?.configuration??room?.hyakkiConfig;
      const count=snapshot?.players?.length??room?.players?.length??2;
      practiceSetup={...(config?.packId?{packId:config.packId,closingTarget:config.closingTarget??60}:{}),playerCount:count,actionLimit:config?.actionLimit??5,...supplySetup(count,config??{goodsSupplyMode:'recommended'})};
      practiceSetupMatchId=currentMatch;
    }
    inspect('开始新的练习',`<div class="hy-practice-restart-layout"><div class="hy-dialog-content"><p>重新开始会覆盖这台设备当前的练习；正式房间不受影响。</p><div class="hy-setup-fields">${expansionSetupFields('hy-practice',practiceSetup)}<label class="hy-setup-field"><span>总人数（含自己）</span><select id="hy-practice-players">${Array.from({length:5},(_,i)=>`<option value="${i+2}" ${practiceSetup.playerCount===i+2?'selected':''}>${i+2}人 · ${i+1}名电脑</option>`).join('')}</select></label><label class="hy-setup-field"><span>每回合行动</span><select id="hy-practice-limit">${Array.from({length:10},(_,i)=>`<option value="${i+1}" ${practiceSetup.actionLimit===i+1?'selected':''}>${i+1}步</option>`).join('')}</select></label><label class="hy-setup-field"><span>每种公共货物</span>${supplySelect('hy-practice-goods',practiceSetup.goodsPerType)}</label><div class="hy-setup-recommend"><span>手选后保留数值，可随时恢复人数推荐。</span>${button('practice-recommend','采用推荐')}</div></div><p id="hy-practice-profile" role="status"></p></div><div class="yg-dialog-actions">${button('practice-confirm','开始新练习')}</div></div>`);
    syncPracticeSetup();
  }
  // Keep the common audio/theme/dialog owners. Remove only preview-specific menus.
  root.querySelector('.yg-brand span').textContent=practice?'本机练习 · 1～5名电脑对手':'棋牌室 · 2～6人夜市';
  root.querySelector('.room-toolbar-actions').insertAdjacentHTML('afterbegin','<button type="button" id="hy-room-control" class="room-toolbar-action" hidden></button>');
  root.querySelector('#yg-options .game-settings-body section:first-child').hidden=true;
  $('yg-settings-exit').closest('section').innerHTML=`<h3>${practice?'本机练习':'房间安排'}</h3><div class="game-settings-controls"><button type="button" data-hy-action="members">成员与商铺</button><button type="button" data-hy-action="history">战况</button><button type="button" id="hy-pause" data-hy-action="pause">申请暂停</button><button type="button" id="hy-host" data-hy-action="host">房主管理</button>${practice?'<button type="button" data-hy-action="practice-restart">重新开始</button><button type="button" data-hy-action="practice-hint">当前提示</button><button type="button" data-hy-action="practice-reload" id="hy-practice-reload">读取保存进度</button>':'<button type="button" data-hy-action="invite">复制邀请</button><button type="button" data-hy-action="keep-seat">返回大厅，保留席位</button><button type="button" data-hy-action="logout">退出棋牌登录</button><button type="button" data-hy-action="agora">返回 Agora</button><button id="hy-practice-reload" hidden></button>'}<button type="button" data-hy-action="leave">${practice?'返回大厅':'退出房间'}</button></div><p id="hy-practice-state"></p><p id="chat-legacy-note" hidden></p><details><summary>第一次怎么玩？</summary><p>每人20两、5张牌。每回合必须先摸看一张；弃掉可继续摸，留下或主动结束摸牌后进入用牌。用货物牌整组买入／卖出，人物和道具提供其他经营办法。行动条共用本回合额度；已用行动不超过上限的一半（四舍五入），主动结束回合可得1两。回合结束达到房主设定的收市金额（默认60两）触发收市，最后银两多者胜。</p></details>`;
  $('yg-leave').querySelector('p').id='hy-leave-note';
  const arrangements=$('hy-pause').closest('section');
  arrangements.querySelector('.game-settings-controls').append($('yg-catalog'));
  $('yg-catalog').textContent='查看完整51种卡牌';
  arrangements.querySelector('details').outerHTML=`<details><summary>① 回合顺序与行动例子</summary><p>每人20两、5张手牌。每回合必须先摸看一张；弃掉可继续摸，留下或主动结束摸牌后进入用牌。看1张牌用1步，留下或弃掉不重复计步。每回合行动额度由房主设定（默认5步）。</p><p>主动结束时，已用步数不超过行动上限÷2四舍五入的值，奖励1两。例如默认5步、门槛3步：看第1张并弃掉，花1步；看第2张并留下，再花1步；买一组货物花1步；余2步主动结束，获得1两。耗尽行动或超时结束不赠银两。</p></details><details><summary>② 货物、摊位与临时格</summary><p>用货物牌整组买入或卖出，不能只交易其中一部分。起初5个普通货位＋1个临时位，新占临时格需付2两。人物、道具等带来货物时，按当前选择留下可容纳部分，其余退公库；最终以牌文和当前提示为准。</p><p>持摊位许可可花1步扩摊，每块加3格。全场第一块6两，后续3两；货物总量与扩摊数量有限，公库以右侧库存为准。</p></details><details><summary>③ 人物、道具与对方回应</summary><p>人物通常花1步使用。监视人物可能让对方用锦衣卫抵消；番商可在交易回应窗取走货物牌。回应者有60秒，主动玩家时钟冻结。牌、费用与选择一经提交就保存；关闭详情不会退款，也不会取消已经发动的效果。</p><p>安装道具不耗行动，使用花1步，另付牌上要求的银两、货物或弃牌费用。每人最多3件，可弃旧装新；用过横置，自己回合结束复原。候选牌和拍卖整组拍品直接摆在桌面；点材料预览；确认前可取消，选好后一次确认。已摸出新牌或开始拍卖的步骤按画面提示继续。</p></details><details><summary>④ 收市、恢复与本机练习</summary><p>回合结束达到房主设定的收市金额（默认60两）触发收市：本轮余下席位完成回合后结算；银两最多者胜，平手由最后行动者胜。财富仅属于本局，不计入账号积分。</p><p>正式房间可申请全员同意暂停；意外离线保留席位和待决步骤，主动退出则认输。本机练习只存在当前浏览器：打开面板、切到后台会暂停电脑，退出后可继续。遇到另一窗口已修改进度，先读取保存进度再操作。</p></details>`;
  $('yg-stay').textContent='继续游戏';$('yg-leave-close').setAttribute('aria-label','继续游戏');
  $('yg-leave-confirm').textContent=practice?'返回大厅':'确认退出';
  $('chat-title').textContent='房间聊天';root.querySelector('.chat-heading p').textContent='和房间里的伙伴聊两句。';
  $('yg-feedback').textContent=practice?'本机练习，真实规则；电脑只使用自己的手牌和公牌。':'先看牌，再经营。';
  $('yg-hand-section').insertAdjacentHTML('beforebegin','<section id="hy-task-materials" class="hy-task-materials" hidden><div class="yg-hand-heading"><strong id="hy-task-material-title">本步材料</strong><small>横滑浏览 · 点物件选择</small><button type="button" id="hy-material-rechoose" data-hy-action="draft-target-reset" hidden>改选对手</button></div><div id="hy-task-material-cards" class="hy-task-material-cards"></div></section>');
  root.querySelector('.yg-centre').append($('hy-task-materials'));
  root.insertAdjacentHTML('beforeend',`<section id="hy-connection" class="hy-connection" role="status" hidden><p id="hy-connection-text"></p><div>${button('recover','恢复连接')}${button('retry','核对原操作')}<a id="hy-login" hidden>重新登录</a><a id="hy-reauth" hidden>近期认证</a>${button('keep-seat','返回大厅')}</div></section>`);
  root.insertAdjacentHTML('beforeend','<dialog id="hy-card-reader" class="yg-dialog hy-card-reader" aria-labelledby="hy-reader-title"><div class="dialog-heading"><h2 id="hy-reader-title"></h2><button type="button" id="hy-reader-close" class="close-button" aria-label="返回上一层">×</button></div><div id="hy-reader-body"></div></dialog>');
  const battleReport=mountBattleReport({dialog:$('yg-inspector'),title:$('yg-inspector-title'),body:$('yg-inspector-body'),getContext:()=>room,requestPage:onHistory,formatEvent:publicEventText});
  function handleAction(type,fields){
    if(type==='history')return showHistory();
    if(type==='discard-page')return showDiscard(fields.page);
    if(actionRequest)return;
    if(type==='draft-target-reset'){if(!detail||!active())return;detail.targetId=null;detail.goodsId=null;detail.toolCardId=null;detail.choiceInputs=[];render();return;}
    if(type==='draft-value'){if(!detail||!active()||!['targetId','goodsId','toolCardId','ownGoodId','otherGoodId'].includes(fields.field))return;detail[fields.field]=fields.id;if(fields.field==='targetId'){detail.goodsId=null;detail.toolCardId=null;detail.ownGoodId=null;detail.otherGoodId=null;if(!['C01','C08'].includes(getCard(detail.card.definitionId).sourceCode))detail.choiceInputs=[];detail.benefitStep=null;base.focusPublicPlayer(fields.id);}render();return;}
    if(type==='benefit-step'){if(!detail||!active()||getCard(detail.card.definitionId).sourceCode!=='C01'||!['branch','goods','target'].includes(fields.step))return;detail.benefitStep=fields.step;render();return;}
    if(type==='native-borrow-target'){if(!borrowDraft()||!available()||!room.game.players.some(player=>player.id===fields.targetId&&player.id!==room.selfId))return;choiceDraft.borrowTargetId=fields.targetId;choiceDraft.toolInputs=[];render();return;}
    if(type==='native-select'){
      if(fields.borrowPart!==undefined&&borrowDraft()&&available()){
        const part=borrowParts()[fields.borrowPart];if(!part)return;
        choiceDraft.toolInputs??=[];choiceDraft.toolInputs[fields.borrowPart]=updateNativeChoice(part,choiceDraft.toolInputs[fields.borrowPart],fields.type,fields);render();return;
      }
      if(detail&&active()){
        const part=draftParts()[fields.part??0];if(!part)return;
        detail.choiceInputs??=[];const previousOption=detail.choiceInputs[fields.part??0]?.optionIndex;
        detail.choiceInputs[fields.part??0]=updateNativeChoice(part,draftInput(part,fields.part??0),fields.type,fields);
        if(fields.part===0&&part.choice.kind==='benefit-branch'&&previousOption!==detail.choiceInputs[0].optionIndex)detail.choiceInputs.splice(1);
        if(getCard(detail.card.definitionId).sourceCode==='C01')detail.benefitStep=null;
        render();base.audio.play('select');return;
      }
      if(!mine()||!available()||room.phase!=='playing')return;
      choiceDraft=updateNativeChoice(room.game.pending,choiceDraft,fields.type,fields);render();base.audio.play('select');return;
    }
    if(type==='native-reset'){if(!mine()||!available())return;choiceDraft=nativeChoiceDraft(room.game.pending);render();return;}
    if(type==='native-confirm'){
      if(!mine()||!available()||room.phase!=='playing')return;
      try{
        const selection=buildChoiceSelection(room.game.pending,choiceDraft??nativeChoiceDraft(room.game.pending));
        const borrowed=borrowDraft();
        if(borrowed){
          if(!borrowReady())return feedback('请选齐本次借用的对象和材料。');
          const selected=cardDraftSelections(room.game,room.selfId,borrowed);
          const needs=requiresOpponent(getCard(borrowed.card.definitionId),'activate-tool');
          selection.params={...(selected[0]?.selection??{}),...(needs&&room.game.version>=2?{targetId:room.game.players.length===2?room.game.players.find(player=>player.id!==room.selfId).id:borrowed.targetId}:{})};
        }
        dispatch('choose-effect',{selection});
      }catch(error){feedback(error.message);}return;
    }
    if(type==='native-bid-adjust'){const bid=room.game?.pending?.decision.options?.find(option=>option.type==='bid');if(!mine()||!available()||!bid||room.phase!=='playing')return;choiceDraft={amount:Math.max(bid.minimum,Math.min(bid.maximum,(Number.isSafeInteger(choiceDraft?.amount)?choiceDraft.amount:bid.minimum)+fields.delta))};render();return;}
    if(type==='native-bid'){const bid=room.game?.pending?.decision.options?.find(option=>option.type==='bid');if(!mine()||!available()||!bid||room.phase!=='playing')return;const amount=choiceDraft?.amount??bid.minimum;if(!Number.isSafeInteger(amount)||amount<bid.minimum||amount>bid.maximum)return feedback(`请输入${bid.minimum}～${bid.maximum}两的整数报价。`);dispatch('bid',{amount});return;}
    if(type==='inline-rechoose'){if(!mine()||!available())return;choiceDraft=null;render();return;}
    if(type==='inline-option'){if(!mine()||!available()||fields.index<0)return;choiceDraft={optionIndex:fields.index};render();return;}
    if(type==='inline-confirm'){if(!mine()||!available())return;try{dispatch('choose-effect',{selection:buildChoiceSelection(room.game.pending,choiceDraft??{optionIndex:-1})});}catch(error){feedback(error.message);}return;}
    if(type==='cancel-card'){detail=null;render();return;}
    if(['begin-play','finish-draw','end-turn'].includes(type)&&firstPeekRequired())return feedback('每回合必须先摸第一张牌，留下或弃掉后才能继续。');
    if(type==='begin-play'){if(!active()||room.game.stage!=='draw')return;return dispatch('finish-draw',{},()=>{if(active()&&room.game.stage==='use')selectHandCard(room.game.players.find(player=>player.id===room.selfId)?.hand.find(card=>cardKey(card)===fields.cardId));});}
    if(type==='cards-page'){cardsPage=fields.page;if($('yg-decision').open)return decision();return inspect('公开弃牌',cardList([...room.game.discard].reverse()));}
    if(type==='decision')return decision();if(type==='invite')return void invite();
    if(type==='leave'||type==='logout'||type==='agora')return leaveDialog(type==='leave'?'lobby':type);
    if(type==='keep-seat'){const stamp=generation;Promise.resolve().then(()=>onLeave({keepSeat:true,destination:'lobby'})).catch(error=>{if(!destroyed&&stamp===generation)feedback(error.message||'返回大厅未完成。');});return;}
    if(type==='recover')return void onRecover();if(type==='retry')return void onRetry();if(type==='refresh')return void onRefresh();
    if(type==='practice-restart')return openPracticeRestart();
    if(type==='practice-recommend'){if(!practice||!practiceSetup)return;practiceSetup.goodsSupplyMode='recommended';syncPracticeSetup();return;}
    if(type==='setup-recommend'){
      if(room?.phase!=='waiting'||room.hostId!==room.selfId||!available())return;
      const setup=supplySetup(room.players.length,{goodsSupplyMode:'recommended'});if(!setup.deckSize)return;
      return dispatch('configure',{hyakkiConfig:{...(room.hyakkiConfig.packId?{packId:room.hyakkiConfig.packId,closingTarget:room.hyakkiConfig.closingTarget}:{}),actionLimit:Number($('hy-action-limit').value),goodsPerType:setup.goodsPerType,goodsSupplyMode:'recommended'}});
    }
    if(type==='practice-confirm'||type==='practice-reload'||type==='practice-hint'){
      const callback=type==='practice-confirm'?practiceActions.onRestart:type==='practice-reload'?practiceActions.onReload:practiceActions.onHint;
      const options=type==='practice-confirm'?{...(practiceSetup.packId?{packId:practiceSetup.packId,closingTarget:practiceSetup.closingTarget??60}:{}),playerCount:Number($('hy-practice-players').value),actionLimit:Number($('hy-practice-limit').value),goodsPerType:Number($('hy-practice-goods').value),goodsSupplyMode:practiceSetup.goodsSupplyMode}:undefined;
      const stamp=generation;Promise.resolve().then(()=>callback?.(options)).then(()=>{if(stamp===generation&&!destroyed&&type!=='practice-hint')closeDialogs();}).catch(error=>{if(stamp===generation&&!destroyed)feedback(error.message);});return;
    }
    if(type==='members')return showMembers();
    if(type==='opponent')return showMembers(fields.playerId);
    if(type==='host')return inspect('房主管理',room.hostId===room.selfId?`<label>将房主交给<select id="hy-host-target">${room.players.filter(player=>player.id!==room.selfId).map(player=>`<option value="${esc(player.id)}">${esc(player.name)}</option>`).join('')}</select></label>${button('host-transfer','确认转交')}`:button('transferHost','接任房主',{playerId:room.selfId}));
    if(type==='host-transfer')return dispatch('transferHost',{playerId:$('hy-host-target').value});
    if(type==='confirm-card'){
      if(!detail||!active())return;
      try{
        const selections=cardDraftSelections(room.game,room.selfId,detail);
        const values={targetId:detail.targetId,replaceCardId:detail.replaceCardId,goodsId:detail.goodsId,toolCardId:detail.toolCardId,
          ...(detail.tool&&selections.length?{toolSelection:selections[0].selection}:{}),
          ...(!detail.tool&&selections.length?{initialChoices:selections}:{})};
        const gameForAction=practice?{...room.game,clock:{...room.game.clock,paused:false}}:room.game;
        const command=actionDraft(gameForAction,room.selfId,detail.card,fields.type,values);
        dispatch(fields.type,command,()=>{detail=null;if($('yg-inspector').open)$('yg-inspector').close();render();});
      }catch(error){feedback(error.message);}return;
    }
    return dispatch(type,fields);
  }
  const removeClick=listen('click',event=>{
    const node=event.target.closest('button');if(!node||node.disabled||destroyed)return;
    const stop=()=>{event.preventDefault();event.stopImmediatePropagation();};
    if(node.dataset.hyBattle){stop();battleReport.handle(node.dataset.hyBattle,JSON.parse(node.dataset.hyBattleFields??'{}'));return;}
    if(node.dataset.focusPlayer){stop();base.focusPublicPlayer(node.dataset.focusPlayer);render();root.querySelector(`[data-focus-player="${window.CSS.escape(node.dataset.focusPlayer)}"]`)?.focus({preventScroll:true});return;}
    if(node.dataset.marketGood&&room?.game?.pending?.choice?.kind==='benefit-good'){
      stop();if(actionRequest||!mine()||!available())return;
      const index=room.game.pending.choice.options.findIndex(option=>option.goodsId===node.dataset.marketGood);
      if(index>=0){choiceDraft={optionIndex:index};render();}return;
    }
    if(node.dataset.hyAction){stop();handleAction(node.dataset.hyAction,JSON.parse(node.dataset.hyFields??'{}'));return;}
    if(node.dataset.hyReadCard){stop();readCard(getCard(node.dataset.hyReadCard));return;}
    if(node.dataset.detailId){stop();readCard(getCard(node.dataset.detailId));return;}
    if(node.dataset.hyDetail){stop();const card=knownCards(room?.game).get(node.dataset.hyDetail);if(card)readCard(card);return;}
    if(['yg-exit','yg-settings-exit'].includes(node.id)){stop();leaveDialog();return;}
    if(['yg-copy-invite','yg-waiting-invite'].includes(node.id)){stop();void invite();return;}
    if(node.id==='yg-draw-pile'){stop();if(active()&&room.game.stage==='draw')dispatch('peek');return;}
    if(node.id==='yg-discard-pile'){stop();showDiscard();return;}
    if(node.id==='hy-reader-close'){stop();$('hy-card-reader').close();return;}
    if(node.id==='yg-inspector-close'){stop();inspectorKind=null;$('yg-inspector').close();return;}
    if(node.id==='yg-rules'){stop();inspect('幽街商人规则',(room?.hyakkiConfig?.packId==='six-trades-v1'?'<p>六行百业：六类十二种货物。开局从自己的三位候选中选一位角色，全部确认后统一发牌；初始银两和常驻能力见角色牌。配货单按牌面类别和件数选齐后整组交易。</p>':'')+'<p>每人20两、5张手牌、5个普通货位＋1个临时位。普通扩摊每块增加3格，首次6两，以后3两。新占临时位另付2两。</p><p>每回合必须先摸看一张；弃掉可继续摸，留下或主动结束摸牌后进入用牌。看牌每张1行动。货物牌整组交易；人物用1行动；道具安装不耗行动，使用花1行动，每件每回合限用一次。具体效果以卡牌全文为准。</p><p>已用行动不超过上限的一半（四舍五入），主动结束回合可得1两。回合结束达到'+(room?.game?.configuration?.closingTarget??room?.hyakkiConfig?.closingTarget??60)+'两收市；本轮余下席位完成回合后结算。银两多者胜，平手由最后行动者胜。</p><p>主动回合30分钟，对方选择60秒并冻结主动钟。暂停保留7天，离线保席30分钟；主动退出认输。每局财富独立。</p>');return;}
    if(node.dataset.cardId){const id=node.closest('[data-entity-id]')?.dataset.entityId;if(id){stop();selectHandCard(knownCards(room?.game).get(id));}return;}
    if(node.dataset.toolId){stop();const card=knownCards(room?.game).get(node.dataset.toolId);if(card)selectHandCard(card,true);return;}
    if(node.dataset.player){stop();handleAction('opponent',{playerId:node.dataset.player});return;}
    if(node.id==='yg-shop-detail'){stop();handleAction('members',{});return;}
  });
  const removeInput=listen('input',event=>{
    if(actionRequest)return;
    if(event.target.id==='hy-native-bid-amount'&&mine()&&available()){
      const bid=room.game.pending?.decision.options?.find(option=>option.type==='bid'),amount=Number(event.target.value);
      if(bid){choiceDraft={amount};const confirm=root.querySelector('[data-hy-action="native-bid"]')??[...root.querySelectorAll('[data-hy-action="native-step"]')].find(node=>JSON.parse(node.dataset.hyFields??'{}').step===3);if(confirm)confirm.disabled=!Number.isSafeInteger(amount)||amount<bid.minimum||amount>bid.maximum;}
    }
  });
  const removeChange=listen('change',event=>{
    if(['hy-room-expansion','hy-room-closing'].includes(event.target.id)){
      if(room.hostId!==room.selfId||room.phase!=='waiting'||!available())return;
      return dispatch('configure',{hyakkiConfig:{packId:$('hy-room-expansion').checked?'six-trades-v1':'base',closingTarget:Number($('hy-room-closing').value)}});
    }
    if(['hy-practice-expansion','hy-practice-closing'].includes(event.target.id)){
      practiceSetup={...practiceSetup,packId:$('hy-practice-expansion').checked?'six-trades-v1':'base',closingTarget:Number($('hy-practice-closing').value)};syncPracticeSetup();return;
    }

    if(['hy-action-limit','hy-goods-limit'].includes(event.target.id)){
      if(room?.phase!=='waiting'||room.hostId!==room.selfId)return;
      const setup=supplySetup(room.players.length,room.hyakkiConfig);
      dispatch('configure',{hyakkiConfig:{...(room.hyakkiConfig.packId?{packId:room.hyakkiConfig.packId,closingTarget:room.hyakkiConfig.closingTarget}:{}),actionLimit:Number($('hy-action-limit').value),goodsPerType:Number($('hy-goods-limit').value),goodsSupplyMode:event.target.id==='hy-goods-limit'?'custom':setup.goodsSupplyMode}});
    }
    if(practiceSetup&&['hy-practice-players','hy-practice-limit','hy-practice-goods'].includes(event.target.id)){
      practiceSetup={...practiceSetup,playerCount:Number($('hy-practice-players').value),actionLimit:Number($('hy-practice-limit').value),goodsPerType:Number($('hy-practice-goods').value),goodsSupplyMode:event.target.id==='hy-practice-goods'?'custom':practiceSetup.goodsSupplyMode};
      syncPracticeSetup();
    }
  });
  const removeBattleScroll=listen('scroll',event=>battleReport.scroll(event.target));
  const handDrag=mountHandDrag({root,getContext:()=>{
    const pending=room?.game?.pending,choosing=pending?.choice&&mine()&&available()&&room.phase==='playing';
    const responding=!!pending?.response&&mine(),canRespond=responding&&available()&&room.phase==='playing';
    return {scope:selectionScope(room),enabled:!actionRequest&&(active()||!!choosing||canRespond),
      label:responding?'松手预选回应牌，再确认回应':choosing?'松手选作材料，再确认选择':'松手选牌，再决定如何使用',
      cardIds:room?.game?.players.find(player=>player.id===room.selfId)?.hand?.map(cardKey).filter(id=>responding?pending.response.cards?.some(card=>cardKey(card)===id):!choosing||nativeCardInput(pending,id))??[],
      blockedReason:actionRequest?'正在结算这次操作，请稍候。':responding?'当前暂不能回应，请先恢复对局或连接。':firstPeekRequired()?'每回合必须先摸第一张牌。':'请先完成当前步骤，轮到你时再用牌。'};
  },onDrop:id=>selectHandCard(room?.game?.players.find(player=>player.id===room.selfId)?.hand?.find(card=>cardKey(card)===id)),onBlocked:feedback});
  // Pointer ownership cancels an unfinished drag itself. Losing window focus
  // only ends presentation; authority transitions still own draft invalidation.
  const cancelPresentation=()=>{motion.cancel();base.cancelTable?.();};
  window.addEventListener('blur',cancelPresentation);
  const clock=window.setInterval(updateClock,500);
  return {applyView,conceal,feedback,leaveFailure,selectHandCard,readCard,audio:base.audio,settings:base.settings,openPracticeRestart,
    configurePractice(callbacks){practiceActions={...callbacks};},destroy(){if(destroyed)return;$('yg-leave-confirm').removeAttribute('aria-busy');restoreActionGate();actionRequest=null;root.setAttribute('aria-busy','false');destroyed=true;generation++;expansionTable.destroy();battleReport.destroy();room=null;detail=null;choiceDraft=null;removeClick();removeInput();removeChange();removeBattleScroll();handDrag.destroy();motion.destroy();window.removeEventListener('blur',cancelPresentation);window.clearInterval(clock);base.destroy();}};
}
