import { GOODS, getCard } from './content/definitions.mjs';
import { renderCard, renderCardBack, renderGoodsIcon } from './digital-card-ui.mjs';
import { choiceModel, buildChoiceSelection, defaultChoiceInput, knownCards, cardKey, goodsTotal } from './game-ui-model.mjs';
import { decisionContext } from './game-dialog-ui.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const action=(type,label,fields={},disabled=false,className='')=>`<button type="button" class="${className}" data-hy-action="${type}" data-hy-fields="${esc(JSON.stringify(fields))}" ${disabled?'disabled':''}>${label}</button>`;
const goodName=id=>GOODS.find(good=>good.id===id)?.name??'货物';
const zeros=()=>Object.fromEntries(GOODS.map(good=>[good.id,0]));

/** Reading drafts contain only identities already present in this role projection. */
export function nativeChoiceDraft(pending){
  const model=choiceModel(pending);
  if(!model)return {};
  if(model.type==='goods')return model.raw?defaultChoiceInput(pending):{goods:zeros()};
  if(model.type==='cards')return {cardIds:[]};
  return {optionIndex:-1};
}
export function nativeCardInput(pending,id){
  const model=choiceModel(pending);if(!model)return null;
  if(model.type==='cards'&&model.cardIds.includes(id))return {type:'card',id};
  if(model.type==='payment-good'){const index=model.payments.findIndex(item=>item.cardId===id);if(index>=0)return {type:'payment',index};}
  if(model.type==='option'){const index=model.options.findIndex(item=>item.cardId===id||item.payment?.cardId===id);if(index>=0)return {type:'option',index};}
  return null;
}
export function updateNativeChoice(pending,draft,type,fields){
  const model=choiceModel(pending),next=structuredClone(draft??nativeChoiceDraft(pending));if(!model)return next;
  if(type==='option'&&model.type==='option'&&model.options[fields.index])next.optionIndex=fields.index;
  else if(type==='card'&&model.type==='cards'&&model.cardIds.includes(fields.id)){
    const selected=next.cardIds??[];
    next.cardIds=selected.includes(fields.id)?selected.filter(id=>id!==fields.id):selected.length<model.maximum?[...selected,fields.id]:selected;
  }else if(type==='quantity'&&model.type==='goods'&&Object.hasOwn(model.stock,fields.id)){
    const value=(next.goods?.[fields.id]??0)+fields.delta;
    if(Number.isInteger(value)&&value>=0&&value<=model.stock[fields.id]&&(fields.delta<0||goodsTotal(next.goods)<model.maximum))next.goods={...zeros(),...next.goods,[fields.id]:value};
  }else if(type==='exchange'&&model.type==='exchange'&&['ownGoodId','otherGoodId'].includes(fields.field)){
    if((fields.field==='ownGoodId'?model.own:model.other).includes(fields.id))next[fields.field]=fields.id;
  }else if(type==='good'&&model.type==='payment-good'&&model.goods.includes(fields.id))next.goodId=fields.id;
  else if(type==='payment'&&model.type==='payment-good'&&model.payments[fields.index])next.paymentIndex=fields.index;
  return next;
}
export function nativeChoiceReady(pending,draft){try{buildChoiceSelection(pending,draft);return true;}catch{return false;}}
export function nativeSelectionText(pending,game,draft,name){
  const model=choiceModel(pending),cards=knownCards(game),cardName=id=>cards.has(id)?getCard(cards.get(id).definitionId).name:'这张牌';
  if(!model)return '';
  if(model.type==='goods')return `${model.raw?'保留':'已选'}${goodsTotal(draft.goods)}件：${GOODS.filter(good=>draft.goods?.[good.id]).map(good=>`${good.name}×${draft.goods[good.id]}`).join('、')||'无'}${model.raw?`；${goodsTotal(model.stock)-goodsTotal(draft.goods)}件退公库`:''}`;
  if(model.type==='cards')return `已选${draft.cardIds?.length??0}/${model.minimum===model.maximum?model.minimum:`${model.minimum}～${model.maximum}`}张：${draft.cardIds?.map(cardName).join('、')||'点实际手牌选择'}`;
  if(model.type==='exchange')return draft.ownGoodId&&draft.otherGoodId?`交出${goodName(draft.ownGoodId)}1件，换取${goodName(draft.otherGoodId)}1件。`:'分别点选双方各一件库存。';
  if(model.type==='payment-good')return draft.goodId&&model.payments[draft.paymentIndex]?`取得${goodName(draft.goodId)}1件，弃掉${cardName(model.payments[draft.paymentIndex].cardId)}。`:'点选所需货物和自己作为费用的牌。';
  const option=model.options[draft.optionIndex];if(!option)return '材料尚未选定；点物件可预览。';
  if(option.cardId)return `已选${cardName(option.cardId)}`;
  if(option.payment)return `将弃掉${cardName(option.payment.cardId)}${option.payment.zone==='tool'?'（已装道具）':''}`;
  if(option.goodsId||option.goodId)return `已选${goodName(option.goodsId??option.goodId)}`;
  if(option.fromGoodsId)return `交回${goodName(option.fromGoodsId)}${game.players.find(player=>player.id===pending.actorId)?.goods[option.fromGoodsId]??0}件，换成同数${goodName(option.toGoodsId)}。`;
  if(option.targetId)return `本次借用作用于${name(option.targetId)}`;
  if(option.kind==='silver')return '支付1两，取得搜寻出的货物牌。';
  if(option.borrow!==undefined)return option.borrow?'借用这件道具一次；效果费用另付。':'不借用，完成人物效果。';
  if(option.branch)return pending.choice.kind==='tribute-branch'?option.branch==='pay'?'支付2两给发动者。':'让发动者抽最多2张牌。':option.branch==='draw'?'自己补牌至5张。':'让所选对手弃牌至3张。';
  return '已选定这项材料。';
}

function materialCard(card,selected,disabled,type,fields,caption=''){
  return action('native-select',`${renderCard(card,{interactive:false})}${caption?`<span class="hy-material-caption">${esc(caption)}</span>`:''}`,{type,...fields},disabled,`hy-material-card${selected?' is-selected':''}`).replace('<button ',`<button data-material-card="${esc(cardKey(card))}" `);
}
function goodsObject(id,selected,disabled,type,fields,caption=''){
  return action('native-select',`${renderGoodsIcon(id)}<strong>${goodName(id)}</strong>${caption?`<small>${esc(caption)}</small>`:''}`,{type,...fields},disabled,`hy-material-good${selected?' is-selected':''}`).replace('<button ',`<button data-material-good="${esc(id)}" `);
}
export function renderNativeMaterials({pending,game,selfId,draft,name,canChoose}){
  const model=choiceModel(pending),cards=knownCards(game),self=game.players.find(player=>player.id===selfId);
  const owned=new Set([...(self?.hand??[]),...(self?.tools??[])].map(cardKey));
  const disabled=!canChoose;
  if(pending.auction){
    return (pending.pool??[]).map(card=>`<article class="hy-material-card" data-material-card="${esc(cardKey(card))}">${renderCard(card,{interactive:false})}</article>`).join('')+GOODS.filter(good=>pending.goods[good.id]).map(good=>`<article class="hy-material-good" data-material-good="${good.id}">${renderGoodsIcon(good.id)}<strong>${good.name} ×${pending.goods[good.id]}</strong><small>整组拍品</small></article>`).join('');
  }
  if(!model)return (pending.pool??[]).map(card=>`<article class="hy-material-card" data-material-card="${esc(cardKey(card))}">${renderCard(card,{interactive:false})}</article>`).join('');
  if(model.type==='goods')return GOODS.filter(good=>model.stock[good.id]>0).map(good=>{
    const count=draft.goods?.[good.id]??0;
    return `<article data-material-good="${good.id}" class="hy-material-quantity${count?' is-selected':''}">${renderGoodsIcon(good.id)}<strong>${good.name}</strong><small>${model.raw?'共':'可选'}${model.stock[good.id]}件</small><div>${action('native-select','−',{type:'quantity',id:good.id,delta:-1},disabled||count===0)}<b aria-live="polite">${count}</b>${action('native-select','＋',{type:'quantity',id:good.id,delta:1},disabled||count===model.stock[good.id]||goodsTotal(draft.goods)>=model.maximum)}</div></article>`;
  }).join('');
  if(model.type==='cards')return model.cardIds.filter(id=>!owned.has(id)).map(id=>cards.get(id)?materialCard(cards.get(id),draft.cardIds?.includes(id),disabled,'card',{id}):'').join('');
  if(model.type==='exchange')return `<div class="hy-material-group"><strong>交出自己的</strong>${model.own.map(id=>goodsObject(id,draft.ownGoodId===id,disabled,'exchange',{field:'ownGoodId',id},`${self.goods[id]}件`)).join('')}</div><span class="hy-material-arrow">⇄</span><div class="hy-material-group"><strong>换取对方的</strong>${model.other.map(id=>goodsObject(id,draft.otherGoodId===id,disabled,'exchange',{field:'otherGoodId',id})).join('')}</div>`;
  if(model.type==='payment-good')return `<div class="hy-material-group"><strong>取得公库货物</strong>${model.goods.map(id=>goodsObject(id,draft.goodId===id,disabled,'good',{id},`公库${game.bankGoods[id]}件`)).join('')}</div><span class="hy-material-arrow">＋费用</span>${model.payments.filter(payment=>!owned.has(payment.cardId)).map(payment=>materialCard(cards.get(payment.cardId),draft.paymentIndex===model.payments.indexOf(payment),disabled,'payment',{index:model.payments.indexOf(payment)},'作为费用弃掉')).join('')}`;
  const contextual=pending.choice.kind==='tool-search-payment'?(pending.pool??[]).map(card=>`<article class="hy-material-card" data-material-card="${esc(cardKey(card))}">${renderCard(card,{interactive:false})}<span class="hy-material-caption">支付后取得</span></article>`).join(''):['borrow-tool','borrowed-target'].includes(pending.choice.kind)&&pending.target?.definitionId?`<article class="hy-material-card">${renderCard(pending.target,{interactive:false})}<span class="hy-material-caption">刚拆除 · ${pending.choice.kind==='borrowed-target'?'本次借用':'可借用一次'}</span></article>`:'';
  return contextual+model.options.map((option,index)=>{
    const selected=draft.optionIndex===index;
    if(option.cardId||option.payment?.cardId){const id=option.cardId??option.payment.cardId;if(owned.has(id))return '';return cards.get(id)?materialCard(cards.get(id),selected,disabled,'option',{index},option.payment?'作为费用弃掉':'') : '';}
    if(option.goodsId||option.goodId)return goodsObject(option.goodsId??option.goodId,selected,disabled,'option',{index});
    if(option.fromGoodsId)return action('native-select',`${renderGoodsIcon(option.fromGoodsId)}<span>全部${goodName(option.fromGoodsId)} →</span>${renderGoodsIcon(option.toGoodsId)}<strong>${goodName(option.toGoodsId)}</strong>`,{type:'option',index},disabled,`hy-material-exchange${selected?' is-selected':''}`);
    const label=option.targetId?name(option.targetId):option.kind==='silver'?'支付1两':option.borrow!==undefined?option.borrow?'借用一次':'不借用':option.branch?pending.choice.kind==='tribute-branch'?option.branch==='pay'?'付给发动者2两':'让发动者抽2张':option.branch==='draw'?'自己补至5张':'对方弃至3张':'选择此项';
    return action('native-select',`${option.kind==='silver'||option.branch==='pay'?'<span class="hy-material-coin">两</span>':option.branch==='draw'?renderCardBack():''}<strong>${esc(label)}</strong>`,{type:'option',index},disabled,`hy-material-branch${selected?' is-selected':''}`);
  }).join('');
}

export function renderNativeWork({pending,game,selfId,draft,step=0,short=false,name,canChoose}){
  const context=decisionContext(pending,game,selfId,name),face=context.source;
  const source=pending.sourceCards?.find(card=>card.definitionId===face?.id)??(face?{definitionId:face.id}:pending.sourceCards?.[0]);
  const sourceArt=source?renderCard(source,{interactive:false}):renderCardBack();
  const ready=pending.auction?true:nativeChoiceReady(pending,draft);
  const summary=pending.auction?`整组拍品 · 当前最高${pending.auction.highestBid}两${pending.auction.highestBidderId?'（'+name(pending.auction.highestBidderId)+'）':''}`:nativeSelectionText(pending,game,draft,name);
  let cost=context.cost;
  const model=choiceModel(pending),actor=game.players.find(player=>player.id===pending.actorId);
  let effect=face?.summary??context.reason,task=context.task;
  if(['borrow-tool','borrowed-target'].includes(pending.choice?.kind)&&pending.target?.definitionId){const borrowed=getCard(pending.target.definitionId);effect=`借用${borrowed.name}：${borrowed.summary}`;if(pending.choice.kind==='borrow-tool')task='刚拆除的道具现在可借用一次；不安装、不另耗行动，效果费用另付。';}
  if(model?.type==='goods'&&model.raw)cost=`${pending.code==='C10'?'匠人2两已付 · ':''}本次不再耗行动 · 保留${goodsTotal(draft.goods)}件${goodsTotal(draft.goods)>model.ordinaryCapacity&&model.temporaryFee?`须另付临时格${model.temporaryFee}两`:'不另付银两'}。`;
  if(pending.choice?.kind==='draft-good')cost=`发动已用1行动 · 本次取1件${actor&&goodsTotal(actor.goods)>=actor.ordinaryCapacity&&!actor.temporaryOccupied?'须付临时格2两':'不付银两'}。`;
  if(pending.choice?.kind==='sell-stock'&&goodsTotal(draft.goods))task=`出售${goodsTotal(draft.goods)}件，取得${goodsTotal(draft.goods)*2}两。`;
  if(pending.choice?.kind==='sell-goods'&&goodsTotal(draft.goods)){const trade=pending.sourceCards?.find(card=>getCard(card.definitionId).category==='goods');if(trade)task=`出售3件，取得${getCard(trade.definitionId).sellSilver+2*game.bookLayers}两。`;}
  if(!pending.code?.startsWith('T')&&!['retain-goods','draft-good'].includes(pending.choice?.kind)&&pending.code!=='C10')cost='发动已用1行动 · 本次选择不再消耗行动。';
  if(pending.code?.startsWith('T')&&!['retain-goods','tool-search-payment','tool-payment-good','tool-goods-draw','tool-payment-silver','tool-buy-good'].includes(pending.choice?.kind))cost='激活已用1行动 · 本次选择不再消耗行动。';
  const borrowed=pending.kind==='tool'&&pending.sourceCards?.some(card=>getCard(card.definitionId).sourceCode==='M08');
  if(borrowed&&pending.choice?.kind==='tool-exchange')cost='术士1行动已用 · 借用不再耗行动。';
  const targetId=pending.borrowedTargetId??pending.targetId??(game.players.length===2?game.players.find(player=>player.id!==pending.ownerId)?.id:null),targetSeat=game.players.findIndex(player=>player.id===targetId)+1;
  const outcome=short&&pending.choice?.kind==='tool-exchange'?`与${targetSeat}席各换1件；临时格不重复收费。`:context.outcome;
  let body='',actions='';
  if(!canChoose&&pending.actorId!==selfId){body=`<p class="hy-work-effect">${esc(effect)}</p><p>${esc(context.reason)}</p><p>等待${esc(name(pending.actorId))}完成这一步。</p>`;}
  else if(short&&step===0){body=`<p class="hy-work-effect">${esc(effect)}</p><p class="hy-work-task">${esc(task)}</p>`;actions=action('native-step','查看材料',{step:1},!canChoose,'hy-primary-action');}
  else if(short&&step===1){body=`<p class="hy-work-task">${esc(task)}</p><p class="hy-work-preview">${esc(summary)}</p>`;actions=action('native-step','效果说明',{step:0},false)+action('native-step','核对费用与结果',{step:2},!canChoose||!ready,'hy-primary-action');}
  else{
    body=`${!short?`<p class="hy-work-effect">${esc(effect)}</p><p class="hy-work-task">${esc(task)}</p>`:''}<p class="hy-work-preview">${esc(summary)}</p><p class="hy-work-cost">${esc(cost)}</p><p class="hy-work-outcome">${esc(outcome)}</p>`;
    if(pending.auction){
      const bid=pending.decision.options?.find(option=>option.type==='bid'),amount=draft.amount??bid?.minimum;
      if(short&&step>=3){
        body=`<p class="hy-work-preview">${step===4?'你将放弃这次竞价':`你将报价${amount}两`}</p><p class="hy-work-outcome">${step===4?'放弃后本次拍卖不能重新加入。':'报价不扣款；成交时付最终报价，取得整组拍品。'}</p>`;
        actions=action('native-step',step===4?'返回拍品':'修改报价',{step:step===4?1:2},false)+(step===4?action('pass-bid','确认放弃',{},!canChoose):action('native-bid','确认报价',{},!canChoose||!bid,'hy-primary-action'));
      }else{
        body=`<p class="hy-work-cost">${short?'本轮报价不扣款。':'报价不扣款；成交付最终报价，取得整组。'}</p>${bid?`<div class="hy-native-bid">${action('native-bid-adjust','−',{delta:-1},!canChoose||amount<=bid.minimum)}<label><input id="hy-native-bid-amount" aria-label="本次报价" type="number" inputmode="numeric" min="${bid.minimum}" max="${bid.maximum}" step="1" value="${amount}" ${!canChoose?'disabled':''}>两</label>${action('native-bid-adjust','＋',{delta:1},!canChoose||amount>=bid.maximum)}<small>${bid.minimum}～${bid.maximum}两${short?'':` · 你有${game.players.find(player=>player.id===selfId)?.silver??0}两`}</small></div>`:''}`;
        actions=(short?action('native-step','返回拍品',{step:1},false):'')+(bid?action(short?'native-step':'native-bid',short?'核对报价':'确认报价',short?{step:3}:{},!canChoose,'hy-primary-action'):'')+(!short?action('pass-bid','放弃 · 本轮不能再加入',{},!canChoose):'');
      }
    }else actions=(short?action('native-step','改选材料',{step:1},false):'')+action('native-confirm','确认选择 · 保存后不可撤回',{},!canChoose||!ready,'hy-primary-action');
  }
  if(pending.auction&&short&&step===1&&canChoose)actions=action('native-step','来源说明',{step:0})+action('native-step','报价',{step:2},false,'hy-primary-action')+action('native-step','放弃',{step:4});
  const borrowedLabel=pending.choice?.kind==='borrowed-target'&&pending.target?.definitionId?` · 借${getCard(pending.target.definitionId).name}`:'';
  return `<section class="hy-table-work hy-native-work" data-step-kind="${esc(pending.choice?.kind??'auction')}" data-native-step="${short?step:'all'}" aria-label="来源牌、当前任务与确认"><div class="hy-work-face">${face?`<button type="button" class="hy-source-reader" data-detail-id="${esc(face.id)}" aria-label="阅读${esc(face.name)}完整牌文" title="点来源牌阅读完整牌文">${sourceArt}</button>`:sourceArt}</div><div class="hy-work-copy"><div class="hy-work-heading"><strong>${esc(short&&pending.ownerId===selfId?'你':context.owner)} · ${esc(face?.name??'当前牌')}${esc(borrowedLabel)}${pending.auction&&short&&step===2?' · 最高'+pending.auction.highestBid+'两':''}</strong><small>${pending.actorId===selfId?'轮到你':esc(name(pending.actorId))} · ${pending.choice?.kind==='retain-goods'?'确定最终库存':pending.auction?'整组竞价':'结算这一步'}</small></div>${body}${actions?`<div class="hy-work-actions">${actions}</div>`:''}</div></section>`;
}
