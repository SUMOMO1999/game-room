import { GOODS, getCard } from './presentation-content.mjs';
import { renderCard, renderCardBack, renderGoodsIcon } from './digital-card-ui.mjs';
import { choiceModel, buildChoiceSelection, defaultChoiceInput, knownCards, cardKey, goodsTotal } from './game-ui-model.mjs';
import { decisionContext } from './game-dialog-ui.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const action=(type,label,fields={},disabled=false,className='')=>`<button type="button" class="${className}" data-hy-action="${type}" data-hy-fields="${esc(JSON.stringify(fields))}" ${disabled?'disabled':''}>${label}</button>`;
const goodName=id=>GOODS.find(good=>good.id===id)?.name??'货物';
const zeros=()=>Object.fromEntries(GOODS.map(good=>[good.id,0]));

/** Same decision: update authority in place without removing a focused native input. */
export function syncTaskMarkup(container, markup, preserve) {
  if (!preserve || !container.childNodes) { container.innerHTML = markup; return; }
  const fresh = container.ownerDocument.createElement('div');
  fresh.innerHTML = markup;
  const active = container.ownerDocument.activeElement;
  function syncChildren(current, next) {
    const previous = [...current.childNodes], desired = [...next.childNodes];
    for (let index = 0; index < Math.max(previous.length, desired.length); index++) {
      const old = previous[index], node = desired[index];
      if (!node) { old.remove(); continue; }
      if (!old) { current.appendChild(node); continue; }
      if (old.nodeType !== node.nodeType || old.nodeName !== node.nodeName || old.id !== node.id) { old.replaceWith(node); continue; }
      if (old.nodeType !== 1) { if (old.nodeValue !== node.nodeValue) old.nodeValue = node.nodeValue; continue; }
      const editing = old === active && old.nodeName === 'INPUT';
      for (const name of old.getAttributeNames()) if (!node.hasAttribute(name) && !(editing && name === 'value')) old.removeAttribute(name);
      for (const name of node.getAttributeNames()) if (!(editing && name === 'value') && old.getAttribute(name) !== node.getAttribute(name)) old.setAttribute(name, node.getAttribute(name));
      if (old.nodeName === 'INPUT' && !editing && old.value !== node.value) old.value = node.value;
      syncChildren(old, node);
    }
  }
  syncChildren(container, fresh);
}
/** Shared accepted source / explanation / confirmation surface. Domain callers
 * supply their own safe markup and authoritative command wiring. */
export function renderTableActionDraft({source,heading,secondary='',description,actions,label='确认前的选牌与材料'}){
  return `<section class="hy-card-play hy-action-draft" aria-label="${esc(label)}"><div class="hy-inline-card">${source}</div><div class="hy-inline-copy"><div class="hy-decision-heading"><strong>${heading}</strong><div class="hy-inline-secondary">${secondary}</div></div><div class="hy-source-description">${description}</div><div class="hy-inline-actions">${actions}</div></div></section>`;
}
export function renderMaterialTarget({label,fields,disabled=false,selected=false,renderAction=action}){
  return renderAction('draft-value',esc(label),fields,disabled,`hy-material-player${selected?' is-selected':''}`);
}

/** C06's two local steps still submit the original, authoritative exchange pair. */
export function nativeExchangeState(pending,draft={}){
  if(pending?.code!=='C06'||pending.choice?.kind!=='exchange')return null;
  draft??={};
  const options=pending.choice.options??[],option=options[draft.optionIndex];
  const fromGoodsId=draft.exchangeFromGoodsId??option?.fromGoodsId??null;
  return {fromGoodsId,step:draft.exchangeStep==='from'||!fromGoodsId?'from':'to',options};
}

/** Reading drafts contain only identities already present in this role projection. */
export function nativeChoiceDraft(pending){
  const model=choiceModel(pending);
  if(!model)return {};
  if(nativeExchangeState(pending))return {optionIndex:-1,exchangeStep:'from'};
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
  const exchange=nativeExchangeState(pending,next);
  if(exchange){
    if(type==='exchange-source'&&exchange.options.some(option=>option.fromGoodsId===fields.id)){
      if(exchange.options[next.optionIndex]?.fromGoodsId!==fields.id)next.optionIndex=-1;
      next.exchangeFromGoodsId=fields.id;next.exchangeStep='to';
    }else if(type==='exchange-back')next.exchangeStep='from';
    else if(type==='option'&&exchange.step==='to'&&exchange.options[fields.index]?.fromGoodsId===exchange.fromGoodsId)next.optionIndex=fields.index;
    return next;
  }
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
export function nativeChoiceReady(pending,draft){try{const exchange=nativeExchangeState(pending,draft);if(exchange&&(exchange.step==='from'||exchange.options[draft?.optionIndex]?.fromGoodsId!==exchange.fromGoodsId))return false;buildChoiceSelection(pending,draft);return true;}catch{return false;}}
export function nativeSelectionText(pending,game,draft,name){
  const model=choiceModel(pending),cards=knownCards(game),cardName=id=>cards.has(id)?getCard(cards.get(id).definitionId).name:'这张牌';
  if(!model)return '';
  const exchange=nativeExchangeState(pending,draft);
  if(exchange){
    const own=game.players.find(player=>player.id===pending.actorId)?.goods??{},from=exchange.fromGoodsId,count=own[from]??0;
    if(exchange.step==='from')return '先选交出哪一类：该类现有货物必须全部换出。';
    const option=exchange.options[draft.optionIndex];
    if(!option||option.fromGoodsId!==from)return `交回全部${goodName(from)}${count}件；再选公库中另一类${count}件。`;
    const to=option.toGoodsId;
    return `交回全部${goodName(from)}${count}件 → 换入${goodName(to)}${count}件。你的${goodName(from)}归零、${goodName(to)}${own[to]??0}→${(own[to]??0)+count}件；公库${goodName(to)}剩${(game.bankGoods[to]??0)-count}件。`;
  }
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
  if(option.branch&&pending.choice.kind==='benefit-branch')return option.branch==='draw'?'自己抽最多2张，对手取得同种最多2件货物。':'自己取得同种最多2件货物，对手抽最多2张。';
  if(option.branch)return pending.choice.kind==='tribute-branch'?option.branch==='pay'?'支付2两给发动者。':'让发动者抽最多2张牌。':option.branch==='draw'?'自己补牌至5张。':'让所选对手弃牌至3张。';
  return '已选定这项材料。';
}

export function renderNativeMaterials({pending,game,selfId,draft,name,canChoose,partIndex,borrowPartIndex,modelOverride=null,renderAction=action,canIncreaseGood=()=>true,optionLabel=null}){
  const chooseAction=(type,label,fields={},disabled=false,className='')=>renderAction(type,label,{...fields,...(partIndex!==undefined?{part:partIndex}:{}),...(borrowPartIndex!==undefined?{borrowPart:borrowPartIndex}:{})},disabled,className);
function materialCard(card,selected,disabled,type,fields,caption=''){
  return chooseAction('native-select',`${renderCard(card,{interactive:false})}${caption?`<span class="hy-material-caption">${esc(caption)}</span>`:''}`,{type,...fields},disabled,`hy-material-card${selected?' is-selected':''}`).replace('<button ',`<button data-material-card="${esc(cardKey(card))}" `);
}
function goodsObject(id,selected,disabled,type,fields,caption=''){
  return chooseAction('native-select',`${renderGoodsIcon(id)}<strong>${goodName(id)}</strong>${caption?`<small>${esc(caption)}</small>`:''}`,{type,...fields},disabled,`hy-material-good${selected?' is-selected':''}`).replace('<button ',`<button data-material-good="${esc(id)}" `);
}
  const model=modelOverride??choiceModel(pending),cards=knownCards(game),self=game.players.find(player=>player.id===selfId);
  const owned=new Set([...(self?.hand??[]),...(self?.tools??[])].flatMap(card=>[cardKey(card),card.ref].filter(Boolean)));
  const disabled=!canChoose;
  if(pending.auction){
    return (pending.pool??[]).map((card,index)=>{
      const face=getCard(card.definitionId??card.id);
      return `<button type="button" class="hy-material-card hy-source-reader" data-material-card="${esc(cardKey(card))}" data-auction-card-index="${index}" data-detail-id="${esc(face.id)}" aria-label="阅读${esc(face.name)}完整牌文">${renderCard(card,{interactive:false})}</button>`;
    }).join('')+GOODS.filter(good=>pending.goods[good.id]).map(good=>`<article class="hy-material-good" data-material-good="${good.id}">${renderGoodsIcon(good.id)}<strong>${good.name} ×${pending.goods[good.id]}</strong><small>整组拍品</small></article>`).join('');
  }
  if(!model)return (pending.pool??[]).map(card=>`<article class="hy-material-card" data-material-card="${esc(cardKey(card))}">${renderCard(card,{interactive:false})}</article>`).join('');
  const exchange=nativeExchangeState(pending,draft);
  if(exchange){
    const owner=game.players.find(player=>player.id===pending.actorId),stock=owner?.goods??{};
    if(exchange.step==='from'){
      const sources=GOODS.filter(good=>stock[good.id]>0);
      return `<section class="hy-exchange-stage" data-exchange-step="from"><p class="hy-exchange-instruction">1 · 选择交出的货物，整类全部换出</p><div class="hy-exchange-options">${sources.map(good=>{
        const possible=exchange.options.some(option=>option.fromGoodsId===good.id);
        return goodsObject(good.id,exchange.fromGoodsId===good.id,disabled||!possible,'exchange-source',{id:good.id},possible?`交出全部${stock[good.id]}件`:`${stock[good.id]}件 · 公库无足量异种`);
      }).join('')}</div>${sources.length?'':'<p class="hy-material-chosen">你没有货物可交换。</p>'}</section>`;
    }
    const count=stock[exchange.fromGoodsId]??0;
    return `<section class="hy-exchange-stage" data-exchange-step="to"><div class="hy-exchange-source"><strong>交出全部${goodName(exchange.fromGoodsId)}${count}件</strong>${chooseAction('native-select','改选交出',{type:'exchange-back'},disabled,'hy-exchange-back')}</div><p class="hy-exchange-instruction">2 · 选择换入的另一类，共${count}件</p><div class="hy-exchange-options">${GOODS.filter(good=>Object.hasOwn(stock,good.id)).map(good=>{
      const index=exchange.options.findIndex(option=>option.fromGoodsId===exchange.fromGoodsId&&option.toGoodsId===good.id),available=game.bankGoods[good.id]??0;
      const caption=good.id===exchange.fromGoodsId?'不能换回同种货物':index<0?`公库${available}件 · 不足${count}件`:`换入${count}件 · 公库${available}件`;
      return goodsObject(good.id,index>=0&&draft.optionIndex===index,disabled||index<0,'option',{index},caption);
    }).join('')}</div></section>`;
  }
  if(model.type==='goods')return GOODS.filter(good=>model.stock[good.id]>0).map(good=>{
    const count=draft.goods?.[good.id]??0;
    return `<article data-material-good="${good.id}" class="hy-material-quantity${count?' is-selected':''}">${renderGoodsIcon(good.id)}<strong>${good.name}</strong><small>${model.raw?'共':'可选'}${model.stock[good.id]}件</small><div>${chooseAction('native-select','−',{type:'quantity',id:good.id,delta:-1},disabled||count===0)}<b aria-live="polite">${count}</b>${chooseAction('native-select','＋',{type:'quantity',id:good.id,delta:1},disabled||count===model.stock[good.id]||goodsTotal(draft.goods)>=model.maximum||!canIncreaseGood(good.id))}</div></article>`;
  }).join('');
  if(model.type==='cards')return model.cardIds.filter(id=>!owned.has(id)).map(id=>cards.get(id)?materialCard(cards.get(id),draft.cardIds?.includes(id),disabled,'card',{id}):'').join('');
  if(model.type==='exchange')return `<div class="hy-material-steps" data-material-flow="exchange"><section class="hy-material-step" data-material-step="own"><h3>${esc(model.ownLabel??'交出自己的1件')}</h3><div class="hy-material-options">${model.own.map(id=>goodsObject(id,draft.ownGoodId===id,disabled,'exchange',{field:'ownGoodId',id},`${self?.goods?.[id]??0}件`)).join('')}</div></section><section class="hy-material-step" data-material-step="other"><h3>${esc(model.otherLabel??'换取对方的1件')}</h3><div class="hy-material-options">${model.other.map(id=>goodsObject(id,draft.otherGoodId===id,disabled,'exchange',{field:'otherGoodId',id})).join('')}</div></section></div>`;
  if(model.type==='payment-good'){
    const selected=model.payments[draft.paymentIndex],selectedCard=selected?cards.get(selected.cardId):null;
    const ownedPayments=model.payments.filter(payment=>owned.has(payment.cardId));
    const zones=[...new Set(ownedPayments.map(payment=>payment.zone==='tool'?'已装备道具':'手牌'))];
    const paymentNote=selectedCard?`已选费用：${getCard(selectedCard.definitionId??selectedCard.id).name}；确认后弃掉。`:zones.length?`从下方${zones.join('或')}中选1张作为费用。`:'选择1张牌作为费用。';
    const otherPayments=model.payments.map((payment,index)=>({payment,index})).filter(({payment})=>!owned.has(payment.cardId));
    return `<div class="hy-material-steps" data-material-flow="payment-good"><section class="hy-material-step" data-material-step="good"><h3>取得公库的1件货物</h3><div class="hy-material-options">${model.goods.map(id=>goodsObject(id,draft.goodId===id,disabled,'good',{id},`公库${game.bankGoods[id]}件`)).join('')}</div></section><section class="hy-material-step" data-material-step="payment"><h3>支付1张牌</h3><p class="hy-material-payment-note">${esc(paymentNote)}</p>${otherPayments.length?`<div class="hy-material-payment-cards">${otherPayments.map(({payment,index})=>cards.get(payment.cardId)?materialCard(cards.get(payment.cardId),draft.paymentIndex===index,disabled,'payment',{index},'作为费用弃掉'):'').join('')}</div>`:''}</section></div>`;
  }
  const contextual=pending.choice.kind==='tool-search-payment'?(pending.pool??[]).map(card=>`<article class="hy-material-card" data-material-card="${esc(cardKey(card))}">${renderCard(card,{interactive:false})}<span class="hy-material-caption">支付后取得</span></article>`).join(''):['borrow-tool','borrowed-target'].includes(pending.choice.kind)&&pending.target?.definitionId?`<article class="hy-material-card">${renderCard(pending.target,{interactive:false})}<span class="hy-material-caption">刚拆除 · ${pending.choice.kind==='borrowed-target'?'本次借用':'可借用一次'}</span></article>`:'';
  return contextual+model.options.map((option,index)=>{
    const selected=draft.optionIndex===index;
    if(option.cardId||option.payment?.cardId){const id=option.cardId??option.payment.cardId;if(owned.has(id))return '';return cards.get(id)?materialCard(cards.get(id),selected,disabled,'option',{index},option.payment?'作为费用弃掉':'') : '';}
    if(option.goodsId||option.goodId)return goodsObject(option.goodsId??option.goodId,selected,disabled,'option',{index});
    if(option.fromGoodsId)return chooseAction('native-select',`${renderGoodsIcon(option.fromGoodsId)}<span>全部${goodName(option.fromGoodsId)} →</span>${renderGoodsIcon(option.toGoodsId)}<strong>${goodName(option.toGoodsId)}</strong>`,{type:'option',index},disabled,`hy-material-exchange${selected?' is-selected':''}`);
    const label=optionLabel?.(option)??(option.targetId?name(option.targetId):option.kind==='silver'?'支付1两':option.borrow!==undefined?option.borrow?'借用一次':'不借用':option.branch?pending.choice.kind==='benefit-branch'?option.branch==='draw'?'自己抽2张':'自己取得货物':pending.choice.kind==='tribute-branch'?option.branch==='pay'?'付给发动者2两':'让发动者抽2张':option.branch==='draw'?'自己补至5张':'对方弃至3张':'选择此项');
    return chooseAction('native-select',`${option.kind==='silver'||option.branch==='pay'?'<span class="hy-material-coin">两</span>':option.branch==='draw'?renderCardBack():''}<strong>${esc(label)}</strong>`,{type:'option',index},disabled,`hy-material-branch${selected?' is-selected':''}`);
  }).join('');
}

export function renderNativeWork({pending,game,selfId,draft,step=0,short=false,narrow=false,name,canChoose,readyOverride=true,costOverride=null,borrowPreview=null}){
  const context=decisionContext(pending,game,selfId,name),face=context.source;
  const source=pending.sourceCards?.find(card=>card.definitionId===face?.id)??(face?{definitionId:face.id}:pending.sourceCards?.[0]);
  const sourceArt=source?renderCard(source,{interactive:false,configuration:game.configuration}):renderCardBack();
  const ready=(pending.auction?true:nativeChoiceReady(pending,draft))&&readyOverride;
  const summary=borrowPreview|| (pending.auction?`整组拍品${pending.pool?.length?` · ${pending.pool.length}张牌`:""} · 当前最高${pending.auction.highestBid}两${pending.auction.highestBidderId?'（'+name(pending.auction.highestBidderId)+'）':''}`:nativeSelectionText(pending,game,draft,name));
  let cost=context.cost;
  const model=choiceModel(pending),actor=game.players.find(player=>player.id===pending.actorId);
  let effect=face?.summary??context.reason,task=context.task;
  if(['borrow-tool','borrowed-target'].includes(pending.choice?.kind)&&pending.target?.definitionId){const borrowed=getCard(pending.target.definitionId);effect=`借用${borrowed.name}：${borrowed.summary}`;if(pending.choice.kind==='borrow-tool')task=short?'点下方材料，选择本次借用。':'刚拆除的道具现在可借用一次；不安装、不另耗行动，效果费用另付。';}
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
  if(short&&!borrowed&&pending.choice?.kind!=='retain-goods'){
    const costs={
      'tool-search-payment':'已用1行动；另付1两或弃1手牌取得所搜牌。',
      'tool-payment-good':'已用1行动；弃所选牌取1货，新占临时格付2两。',
      'tool-goods-draw':'已用1行动；交回所选1货，抽1牌。',
      'tool-payment-silver':'已用1行动；弃所选牌，得2两。',
      'tool-buy-good':'已用1行动；付2两取1货，新占临时格付2两。',
      'artisan-good':'已付1行动和2两；新占临时格另付2两。',
    };
    cost=costs[pending.choice?.kind]??cost.replace('发动已用1行动 · 本次选择不再消耗行动。','已用1行动；这次选择不计步。').replace('激活已用1行动 · 本次选择不再消耗行动。','已用1行动；这次选择不计步。');
  }
  if(short&&model?.type==='goods'&&model.raw)cost=`${pending.code==='C10'?'已付1行动和2两':'已计步'}；${goodsTotal(draft.goods)>model.ordinaryCapacity&&model.temporaryFee?`临时格付${model.temporaryFee}两`:'无额外费用'}。`;
  if(costOverride)cost=costOverride;
  const auctionSummary=pending.auction?`<span class="hy-auction-full">${esc(summary)}</span><span class="hy-auction-brief">最高${pending.auction.highestBid}两${pending.auction.highestBidderId?' · '+(game.players.findIndex(player=>player.id===pending.auction.highestBidderId)+1)+'席':''}</span>`:esc(summary);
  let body=`<p class="hy-work-effect">${esc(effect)}</p><p class="hy-work-preview">${esc(ready||nativeExchangeState(pending,draft)?summary:task)}</p><p class="hy-work-cost">${esc(cost)}</p>`,actions='';
  if(!canChoose&&pending.actorId!==selfId){
    body=`<p class="hy-work-effect">${esc(effect)}</p>${pending.auction?`<p class="hy-work-preview">${auctionSummary}</p>`:''}<p>等待${esc(name(pending.actorId))}完成这一步。</p>`;
  }else if(pending.auction){
    const bid=pending.decision.options?.find(option=>option.type==='bid'),amount=draft.amount??bid?.minimum;
    body=`<div class="hy-auction-context"><p class="hy-work-effect">${esc(effect)}</p><p class="hy-work-preview">${auctionSummary}</p><p class="hy-work-cost">你有${actor?.silver??0}两；报价不扣款，成交付最终报价。</p></div>${bid?`<div class="hy-native-bid">${action('native-bid-adjust','−',{delta:-1},!canChoose||amount<=bid.minimum)}<label><input id="hy-native-bid-amount" aria-label="本次报价" type="number" inputmode="numeric" min="${bid.minimum}" max="${bid.maximum}" step="1" value="${amount}" ${!canChoose?'disabled':''}>两</label>${action('native-bid-adjust','＋',{delta:1},!canChoose||amount>=bid.maximum)}<small>${bid.minimum}～${bid.maximum}两</small></div>`:''}`;
    actions=(bid?action('native-bid','确认报价',{},!canChoose,'hy-primary-action'):'')+action('pass-bid','放弃本次竞价',{},!canChoose);
  }else{
    actions=action('native-confirm','确认选择',{},!canChoose||!ready,'hy-primary-action')+action('native-reset','重新选择',{},!canChoose);
  }
  const borrowedLabel=pending.choice?.kind==='borrowed-target'&&pending.target?.definitionId?` · 借${getCard(pending.target.definitionId).name}`:'';
  return `<section class="hy-table-work hy-native-work" data-step-kind="${esc(pending.choice?.kind??'auction')}" data-native-step="all" aria-label="来源牌、当前任务与确认"><div class="hy-work-face">${face?`<button type="button" class="hy-source-reader" data-detail-id="${esc(face.id)}" aria-label="阅读${esc(face.name)}完整牌文" title="点来源牌阅读完整牌文">${sourceArt}</button>`:sourceArt}</div><div class="hy-work-copy"><div class="hy-work-heading"><strong>${esc(short&&pending.ownerId===selfId?'你':context.owner)} · ${esc(face?.name??'当前牌')}${esc(borrowedLabel)}</strong><small>${pending.actorId===selfId?'轮到你':esc(name(pending.actorId))} · ${pending.choice?.kind==='retain-goods'?'确定最终库存':pending.auction?'整组竞价':'结算这一步'}</small></div><div class="hy-work-description">${body}</div>${actions?`<div class="hy-work-actions">${actions}</div>`:''}</div></section>`;
}
