import {CATEGORIES,GOODS,getExpansionCard} from '../content/expansion-one.mjs';
import {getPublicOrder,EXPANSION_TWO_PACK_ID,ORDER_ONLY_MODULES,REFINING_ONLY_MODULES,ORDERS_AND_REFINING} from '../content/expansion-two.mjs';
import {renderCard, renderGoodsIcon} from '../digital-card-ui.mjs';
import {getCard} from '../presentation-content.mjs';
import {renderNativeMaterials, renderTableActionDraft, syncTaskMarkup} from '../table-decision-ui.mjs';
import {matchingOrderCount, planRefining, quoteOrderDelivery} from './expansion-two-economy.mjs';
import {newTradeUsage,quoteGoodsTrade,refinedWithdrawal} from '../trade-contract.mjs';
import {WORKSHOP_OWNER} from './refining.mjs';
import {createExchangeTable} from './exchange-table.mjs';

const escape = text => String(text ?? '').replace(/[&<>"']/gu, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const count = vector => Object.values(vector ?? {}).reduce((sum, n) => sum + n, 0);
const emptySelection = () => ({ordinary:{}, refined:{}});
const publicOrderChoice = effect => ['compass-position','compass-order'].includes(effect?.choice?.kind);
const qualityChoice=(effect,enabled)=>enabled&&['hammer-refine','retain-goods','sell-goods','sell-stock'].includes(effect?.choice?.kind);
const goodsSum=selection=>Object.fromEntries(GOODS.map(({id})=>[id,(selection.ordinary[id]??0)+(selection.refined[id]??0)]));
function button(command, label, data = {}, disabled = false, className = '', accessibleName = '', pressed) {
  return `<button type="button" class="${className}" data-e2-command="${command}" data-e2-fields="${escape(JSON.stringify(data))}"${accessibleName ? ` aria-label="${escape(accessibleName)}"` : ''}${pressed===undefined?'':` aria-pressed="${pressed}"`} ${disabled ? 'disabled' : ''}>${label}</button>`;
}
function orderRecipe(order){
  const category=({id,name},quantity)=>`<span class="e2-order-unit"><span class="e2-order-category" data-category="${id}">${escape(name[0])}</span><b>×${quantity}</b></span>`;
  if(order.kind==='bulk'){
    const [first,second]=GOODS.filter(good=>good.category===order.categories[0]);
    return `<div class="e2-order-recipe e2-order-bulk" role="img" aria-label="${escape(order.summary)}"><span class="e2-order-alternatives">${renderGoodsIcon(first.id)}<small>或</small>${renderGoodsIcon(second.id)}</span><span><b>×4</b> 同种</span></div>`;
  }
  const terms=order.categories.map(id=>category(CATEGORIES.find(item=>item.id===id),order.kind==='paired'?2:1));
  if(order.kind==='paired')terms.push(category({id:'other',name:'异类'},1));
  return `<div class="e2-order-recipe" role="img" aria-label="${escape(order.summary)}">${terms.join('')}</div>`;
}
function orderFace(order) {
  return `<article class="e2-order-face"><strong>${escape(order.name)}</strong>${orderRecipe(order)}<span class="e2-order-reward">领 <b>${order.silver}</b>两</span></article>`;
}
const goodsText = selection => ['ordinary','refined'].flatMap(quality => GOODS.filter(good => selection?.[quality]?.[good.id])
  .map(good => `${quality === 'refined' ? '精制' : ''}${good.name}×${selection[quality][good.id]}`)).join('、');

function missingOrderGoods(order,goods) {
  const primary=order.categories[0];
  const categoryName=id=>CATEGORIES.find(category=>category.id===id).name+'类';
  const inCategory=id=>GOODS.reduce((sum,good)=>sum+(good.category===id?goods[good.id]:0),0);
  if(order.kind==='bulk'){
    const [first,second]=GOODS.filter(good=>good.category===primary);
    const biggest=Math.max(goods[first.id],goods[second.id]);
    const names=goods[first.id]===goods[second.id]?`${first.name}或${second.name}`:goods[first.id]>goods[second.id]?first.name:second.name;
    return biggest<order.count?`${names} ${order.count-biggest}件（同种）`:'';
  }
  if(order.kind==='mixed')return order.categories.filter(id=>inCategory(id)===0).map(id=>categoryName(id)+' 1件').join('、');
  const primaryCount=inCategory(primary);
  return [primaryCount<2?`${categoryName(primary)} ${2-primaryCount}件`:'',
    count(goods)===primaryCount?'其他类 1件':''].filter(Boolean).join('、');
}

export function mountTradeRoutesTable({root, send, rerender, available, inspect}) {
  const el = id => root.querySelector('#' + id);
  let room, scope, panel, orderPosition, orderGeneration, quality, selection, offerId, cardId, wanted, sourceCard, choiceId, choiceIndex,
    resultText = '', trayKey = null, pending = false, exchangeScroll = null, sampleOfferSide = 'provide', returnTradeCard = null;
  const exchange=createExchangeTable({button,escape,frame:options=>frame({...options,
    materials:options.materials?`<div class="e2-live-exchange">${options.materials}</div>`:''}),
  picker:quantityPicker,cardFace,commit,inspect});
  function reset() {
    exchange.reset();
    trayKey = null;
    panel = null; orderPosition = null; orderGeneration = null; quality = 'ordinary';
    selection = emptySelection(); offerId = null; cardId = null; wanted = null; sourceCard = null; choiceIndex = null; choiceId = null;
    sampleOfferSide = 'provide';
    returnTradeCard = null;
  }
  reset();
  const game = () => room?.game;
  const borrowedSeal=effect=>effect?.choice?.kind==='seal-offer';
  const scopeOf = value => {
    const sharedOffer=panel==='exchange'&&value.game?.exchangeMarket&&!sourceCard&&!exchange.borrowedDone();
    return `${value.roomId}:${value.game?.matchId}:${value.selfId}:${value.selfRole}:${sharedOffer?'exchange':value.game?.turnId}`;
  };
  const routes = () => game()?.tradeRoutes??(game()?.configuration?.modules&&(game().publicOrders||game().configuration.modules.refining||game().exchangeMarket)?{
    modules:game().configuration.modules,orders:game().publicOrders?.orders??[],delivered:game().orderUsage?.delivered,replaced:game().orderUsage?.replaced,
    refined:game().refiningUsed,offers:game().exchangeMarket?.offers??[],
  }:null);
  const me = () => game()?.players.find(player => player.id === room.selfId);
  const current = () => available() && room.phase==='playing' && !game()?.pending && room.selfRole === 'player'
    && game()?.turnPlayerId === room.selfId && game()?.stage === 'use' && game()?.actionsUsed < game()?.actionLimit;
  const safe = () => available() && room.phase === 'playing' && !game()?.pending && !game()?.closing && room.selfRole === 'player';
  const orderAvailable = (order,owner=me()) => !!owner&&current()&&!routes().delivered
    &&count(owner.goods)>=order.count&&matchingOrderCount(order,owner.goods)>=order.count-Number(isBroker());
  function selectedOrder() {
    return routes()?.orders.find(item => item.position === orderPosition);
  }
  function chooseOrder(item) {
    if (orderPosition === item.position && orderGeneration === item.generation) return;
    orderPosition = item.position;
    orderGeneration = item.generation;
    selection = emptySelection();
    quality = 'ordinary';
  }
  const inOrderDraft = () => panel === 'orders' && !!room && !pending && !game()?.pending && scope === scopeOf(room);
  const isBroker=()=>sourceCard?.definitionId==='yousei.e2c01';
  const isCompass=()=>sourceCard?.definitionId==='yousei.e2t01';
  const isArtisan=()=>sourceCard?.definitionId==='yousei.e2c02';
  const isHammer=()=>sourceCard?.definitionId==='yousei.e2t02';
  const handlesPending=(effect,gameState=game())=>publicOrderChoice(effect)||borrowedSeal(effect)||qualityChoice(effect,gameState?.configuration?.modules?.refining);
  const exchangeContext=()=>({room,market:game().exchangeMarket,player:room.selfRole==='player'?me():null,sourceCard,
    borrowed:borrowedSeal(game().pending)?game().pending:null,current:current(),safe:safe(),
    canChoose:available()&&room.phase==='playing'&&!pending});
  const sourceFace=()=>sourceCard?cardFace(sourceCard):'';
  function cardFace(card){
    return `<button type="button" class="hy-source-reader" data-detail-id="${escape(card.definitionId)}" aria-label="阅读${escape(getCard(card.definitionId).name)}">${renderCard(card,{interactive:false})}</button>`;
  }
  function frame({title, source, secondary, description, materials, actions, canClose=true, closeLabel='返回'}) {
    const tray = el('hy-task-materials');
    tray.hidden = !materials;
    tray.classList.add('hy-object-selection','hy-object-expanded','hy-grouped-selection','hy-expansion-materials');
    tray.classList.toggle('hy-card-selection', materials.includes('e2-offer-card')&&!materials.includes('e2-live-exchange'));
    el('hy-task-material-title').textContent = title;
    el('hy-material-rechoose').hidden = true;
    const nextTrayKey = `${panel}:${orderPosition ?? ''}:${offerId ?? ''}:${choiceId??''}:${game()?.exchangeMarket?exchange.trayIdentity():sampleOfferSide}`;
    const sameTray = trayKey === nextTrayKey;
    syncTaskMarkup(el('hy-task-material-cards'), materials ? `<div class="hy-material-steps">${materials}</div>` : '', sameTray);
    if (!sameTray) { tray.scrollTop = 0; tray.scrollLeft = 0; }
    else if(exchangeScroll&&materials.includes('e2-live-exchange')){
      tray.scrollTop=exchangeScroll.top;tray.scrollLeft=exchangeScroll.left;
    }
    trayKey = nextTrayKey;
    root.querySelector('.yg-lower').classList.toggle('hy-has-materials', Boolean(materials));
    syncTaskMarkup(el('yg-scene-content'), renderTableActionDraft({
      source, heading:escape(title), secondary, description, actions:(canClose?button('close',closeLabel):'')+actions,
    }), true);
  }
  function quantityPicker(maximum,{owner=me(),ordinaryOnly=false,limits,canChoose=current()&&!pending,
    basket=selection,grade=quality,command='quantity',qualityCommand='quality'}={}) {
    const stock = Object.fromEntries(GOODS.map(({id}) => [id, Math.min(limits?.[id]??Infinity,
      grade === 'refined' ? owner.refined?.[id]??0 : owner.goods[id] - (owner.refined?.[id]??0))]));
    const other = grade === 'ordinary' ? 'refined' : 'ordinary';
    const materials = renderNativeMaterials({
      pending:{choice:{kind:'e2-materials',options:[]}}, game:game(), selfId:room.selfId,
      draft:{goods:basket[grade]}, name:()=>'伙伴', canChoose,
      modelOverride:{type:'goods',stock,maximum:maximum - count(basket[other])},
      canIncreaseGood:id=>!limits||(basket[grade][id]??0)+(basket[other][id]??0)<(limits[id]??0),
      renderAction:(_type, label, fields, disabled, className) => {
        const good = GOODS.find(item => item.id === fields.id);
        return button(command,label,fields,disabled,className,`${fields.delta > 0 ? '增加' : '减少'}${grade === 'refined' ? '精制' : '普通'}${good.name}`);
      },
    });
    return (ordinaryOnly||panel === 'refining'||!routes().modules.refining ? '' : `<div class="e2-quality" aria-label="货物品质">${button(qualityCommand,'普通货',{quality:'ordinary'},false,'','',grade==='ordinary')}${button(qualityCommand,'精制货',{quality:'refined'},false,'','',grade==='refined')}</div>`)
      + `<div class="hy-material-options hy-material-options--quantities">${materials || '<p>没有这种品质的货物。</p>'}</div>`;
  }
  function renderOrders() {
    const position = selectedOrder();
    const title=isBroker()?'行会说客 · 选择公单':isCompass()?'望市罗盘 · 选择要换的公单':'公开订单';
    if (!position) {
      let instruction = isCompass() ? '选一份公单，花1行动查看换单候选。' : '选一份公单，交货领银两，每单花1行动。';
      if (isBroker()) {
        if (routes().delivered) instruction = '本回合已经交过公单。';
        else if (routes().orders.some(item => orderAvailable(getPublicOrder(item.id)))) instruction = '选亮起的公单，再点自己货摊上的货。可以用任意1件货替代其中1件。';
        else instruction = '目前的货物凑不齐桌上的公单。说客可以替代1件，交货总件数仍要凑齐。';
      }
      frame({title,source:sourceFace(),description:`<p>${instruction}</p>`,actions:'',
        materials:orderButtons(routes().orders.map(item=>({id:item.id,fields:{position:item.position}})),'order')});
      return;
    }
    const order = getPublicOrder(position.id);
    const outdated = position.generation !== orderGeneration;
    let quote;
    if(me())try { quote = quoteOrderDelivery({owner:me(),orderId:order.id,selection,broker:isBroker(),saleBonusUsed:game().turnUsage?.saleBonus}); } catch (error) { if (!(error instanceof RangeError)) throw error; }
    const goods=goodsSum(selection), chosen=count(goods);
    const price=me()?.roleId==='yousei.role.e2r02'?0:1;
    const canReplace=current()&&!pending&&!routes().replaced&&!outdated;
    const replacement=game().publicOrders&&!isBroker()&&current()?button('replace',isCompass()?'查看候选 · 1行动':`换单 · ${price}行动`,{},!canReplace):'';
    const canSelect=current()&&!isCompass()&&!routes().delivered&&!outdated;
    let instruction='';
    if(canSelect&&!quote){
      const stock=me().goods;
      const missingStock=matchingOrderCount(order,stock)<order.count-Number(isBroker())||count(stock)<order.count;
      const missing=missingOrderGoods(order,missingStock?stock:goods);
      if(chosen===order.count)instruction='货物搭配不符，请调整';
      else if(missingStock)instruction=missing&&!isBroker()?'库存还缺 '+missing:'库存未凑齐 '+order.count+'件所需货物';
      else if(isBroker())instruction='再选 '+(order.count-chosen)+'件（可替代1件）';
      else instruction=missing?'还需选 '+missing:'请按单面要求选货';
    }
    const orderStatus=canSelect?`<p class="e2-next-note">${escape(quote?goodsText(selection):instruction)}</p>${premiumNote(quote)}${quote?.batchBonus?'<p>整批行商加2两</p>':''}`:'';
    frame({title:order.name,source:sourceFace()||orderFace(order),secondary:orderReader(order),
      description:outdated?'<p>原公单已更换，请返回重选。</p>':`<p>交 ${escape(order.summary)}</p>${orderStatus}`,
      materials:canSelect?quantityPicker(order.count):'',actions:(canSelect?button('submit',quote?`交货领${quote.proceeds}两 · 1行动`:'交货 · 1行动',{},!quote||pending):'')+replacement});
  }
  function orderReader(order){
    return order&&inspect?button('order-read','牌文',{id:order.id},false,'',`${order.name}完整牌文`):'';
  }
  function orderButtons(items,command){
    return `<div class="e2-orders${game()?.publicOrders?' e2-orders--live':''}">${items.map(item=>{
      const order=getPublicOrder(item.id);
      const ready=command==='order'&&!isCompass()&&orderAvailable(order);
      const className=[item.selected?'is-selected':'',ready?'is-sellable':''].filter(Boolean).join(' ');
      return button(command,orderFace(order),item.fields,item.disabled,className,`${order.name}，${order.summary}，${order.silver}两${ready?'，可交货':''}`,item.selected);
    }).join('')}</div>`;
  }
  function renderCompass(effect){
    const mine=effect.actorId===room.selfId&&room.selfRole==='player',options=mine?effect.choice.options??[]:[];
    if(choiceId!==effect.decisionId){choiceId=effect.decisionId;choiceIndex=null;}
    const choose=mine&&available()&&room.phase==='playing'&&!pending;
    const choosePosition=effect.choice.kind==='compass-position';
    const items=options.map((option,index)=>({
      id:choosePosition?routes().orders.find(slot=>slot.position===option.position)?.id:option.orderId,
      fields:{index},disabled:!choose,selected:index===choiceIndex,
    })).filter(item=>item.id);
    const selected=items.find(item=>item.selected);
    frame({title:choosePosition?'望市罗盘 · 选择公单位':'望市罗盘 · 选择新公单',
      source:cardFace({definitionId:'yousei.e2t01'}),secondary:selected?orderReader(getPublicOrder(selected.id)):'',canClose:false,
      description:mine?'<p>选一张。到时取首张。</p>':'<p>等待伙伴用望市罗盘选择，候选仅本人可见。</p>',
      materials:items.length?orderButtons(items,'compass-choice'):'',
      actions:mine?button('compass-confirm','确认选择',{},!choose||!options[choiceIndex]):''});
  }
  const premiumNote=quote=>quote?.premium?`<p>精制加${quote.premium}两${count(selection.refined)>2?'（每笔最多加4两）':''}</p>`:'';
  function saleQuote(card,broker=false){
    try{return quoteGoodsTrade({owner:me(),bankGoods:game().bankGoods,usage:Object.fromEntries(Object.keys(newTradeUsage()).map(key=>[key,game().turnUsage[key]])),
      bookLayers:game().bookLayers,definitionId:card.definitionId,direction:'sell',materials:goodsSum(selection),refinedMaterials:selection.refined,broker});}
    catch(error){if(error instanceof RangeError)return null;throw error;}
  }
  function renderSale(){
    const face=getExpansionCard(sourceCard.definitionId),quote=saleQuote(sourceCard);
    const recipe=face.recipe,n=count(goodsSum(selection));
    const limits=recipe.type==='fixed'?Object.fromEntries(GOODS.map(({id})=>[id,recipe.goods[id]??0]))
      :recipe.type==='class'?Object.fromEntries(GOODS.map(({id,category})=>[id,category===recipe.category?recipe.count:0])):undefined;
    const missing=quote?'':n<recipe.count?`<p>再选${recipe.count-n}件</p>`:'<p>请按牌面要求调整货物。</p>';
    frame({title:`${face.name} · 卖出`,source:sourceFace(),description:`<p>${escape(goodsText(selection)||'请选择本次出售的货物')}</p>${premiumNote(quote)}${missing}`,
      materials:quantityPicker(face.recipe.count,{limits}),actions:button('submit',quote?`确认卖出 · 得${quote.saleProceeds}两`:'确认卖出',{},!current()||!quote||pending)});
  }
  function renderRefining(effect=null) {
    const mine=!effect||effect.actorId===room.selfId;
    const canChoose=mine&&(effect?available()&&room.phase==='playing':current())&&!pending;
    const limit=isArtisan()||me()?.roleId===WORKSHOP_OWNER?2:1;
    const chosen=GOODS.filter(({id})=>selection.ordinary[id]);
    const summary=chosen.length?chosen.map(({id,name})=>`普通${name} → 精制${name} ×${selection.ordinary[id]}`).join('、')
      :limit===1?'选1件普通货':'选1～2件普通货';
    let ready = false;
    if(mine)try { planRefining({owner:me(),ordinary:selection.ordinary,limit}); ready = true; } catch (error) { if (!(error instanceof RangeError)) throw error; }
    const good = Object.keys(selection.ordinary).find(id => selection.ordinary[id]);
    frame({title:effect||isHammer()?'百工锤':isArtisan()?'巧手匠人':'精制库存',source:effect?cardFace({definitionId:'yousei.e2t02'}):sourceFace()||(good?renderGoodsIcon(good):''),
      description:mine?`<p class="e2-next-note">${escape(summary)}</p><p>卖出或交公单，每件 +2两</p>`:'<p>等待对方选择精制的货物。</p>',
      materials:mine?quantityPicker(limit,{canChoose,ordinaryOnly:true}):'',canClose:!effect,
      actions:mine?button(effect?'quality-confirm':'submit',effect?'确认精制':'精制 · 1行动',{},!canChoose||!ready||routes().refined):''});
  }
  function renderQualityChoice(effect){
    if(choiceId!==effect.decisionId){
      reset();choiceId=effect.decisionId;
      if(effect.actorId===room.selfId&&effect.choice.kind==='retain-goods'){
        const initial=effect.choice.defaultSelection;
        selection.refined={...initial.refined};
        selection.ordinary=Object.fromEntries(GOODS.map(({id})=>[id,initial.goods[id]-initial.refined[id]]));
      }
    }
    if(effect.choice.kind==='hammer-refine')return renderRefining(effect);
    if(effect.choice.kind==='sell-stock')return renderStockReturn(effect);
    const mine=effect.actorId===room.selfId,retain=effect.choice.kind==='retain-goods',canChoose=mine&&available()&&room.phase==='playing'&&!pending;
    const card=effect.sourceCards[0],title=retain?'保留货物':'买办 · 选交出的货物';
    const option=effect.choice.options?.[0],n=count(goodsSum(selection));
    const quote=mine&&!retain&&card?saleQuote(card,true):null;
    frame({title,source:card?cardFace(card):'',canClose:false,
      description:mine?`<p>${escape(goodsText(selection)||'未选')}${retain?` · ${n}/${option.capacity}件`:quote?` · 得${quote.saleProceeds}两`:''}</p>${premiumNote(quote)}`:'<p>等待对方选货。</p>',
      materials:mine?quantityPicker(retain?option.capacity:3,{canChoose,owner:retain?{goods:option.combined,refined:option.refined}:me()}):'',
      actions:mine?button('quality-confirm','确认选择',{},!canChoose||(!retain&&!quote)):''});
  }
  function renderStockReturn(effect=null){
    const mine=!effect||effect.actorId===room.selfId;
    const canChoose=mine&&(effect?available()&&room.phase==='playing':current())&&!pending;
    const source=effect?.sourceCards[0]??sourceCard,face=getCard(source.definitionId);
    const maximum=mine?(effect?.choice.options[0].maximum??Math.min(count(me().goods),Math.floor((Number.MAX_SAFE_INTEGER-me().silver)/2))):0;
    const quantity=count(goodsSum(selection));
    frame({title:face.name,source:cardFace(source),canClose:!effect,
      description:mine?`<p>${escape(goodsText(selection)||'选择交回的货物')}${quantity?` · 得${2*quantity}两`:''}</p><p>退回公栈的货物清除品质。</p>`:'<p>等待对方选货。</p>',
      materials:mine?quantityPicker(maximum,{canChoose}):'',
      actions:mine?button(effect?'quality-confirm':'submit',quantity?`交回 · 得${2*quantity}两`:'交回货物',{},!canChoose||quantity===0||quantity>maximum):''});
  }
  function renderSampleExchange() {
    const offer = routes().offers.find(item => item.id === offerId);
    if (offerId === 'new') {
      const giving = sampleOfferSide === 'provide';
      const options = GOODS.map(good => button('want',`${renderGoodsIcon(good.id)}${good.name}`,{id:good.id},false,`hy-material-good${wanted === good.id ? ' is-selected' : ''}`)).join('');
      const give = goodsText(selection);
      const identical = selection.ordinary[wanted] === 1 && count(selection.ordinary) === 1 && !count(selection.refined);
      const sides = [['provide','我给'],['receive','我想换']].map(([side,label])=>button('sample-offer-side',label,{side},false,'','',side===sampleOfferSide)).join('');
      const problem = !give?'先选你愿意给出的货物':!wanted?'再选你想换到的货物':identical?'换取的货物需不同':'';
      frame({title:'发布交易报价',source:wanted ? renderGoodsIcon(wanted) : '',
        description:`<p>我给 ${escape(give || '未选')}</p><p>我想换 ${escape(GOODS.find(good=>good.id===wanted)?.name || '未选')}</p>${problem?`<p class="e2-next-note">${problem}</p>`:''}`,
        materials:`<section class="hy-material-step"><div class="e2-quality">${sides}</div>${giving?quantityPicker(3):`<div class="hy-material-options">${options}</div>`}</section>`,
        actions:giving?button('sample-offer-side','下一步 · 选想换的',{side:'receive'},!give)
          :button('submit','免费发布',{},!current() || Boolean(problem) || pending || routes().posted)});
      return;
    }
    if (!offer) {
      frame({title:'玩家交易',source:'',description:'<p>跟其他玩家换货、银两或手牌。</p>',
        materials:routes().offers.map(item => button('offer',escape(item.label),{id:item.id},false,'hy-material-player')).join(''),
        actions:button('post','发布报价',{},!current() || !safe() || routes().posted)});
      return;
    }
    const cards = me().hand.filter(card => offer.eligibleCards?.includes(card.cardId));
    const cardRequired = Boolean(offer.cardCategory);
    frame({title:offer.label,source:offer.goodsIcon ? renderGoodsIcon(offer.goodsIcon) : '',
      description:`<p>${escape(offer.summary)}</p><p>${escape(offer.feeText || '请选择要交出的手牌。')}</p>`,
      materials:cards.map(card => `<article class="e2-offer-card">${button('card',renderCard(card,{interactive:false}),{id:card.cardId},false,'hy-material-card'+(cardId===card.cardId?' is-selected':''),`选择第${cards.indexOf(card)+1}张货物牌`)}<button type="button" data-detail-id="${escape(card.definitionId)}">牌文</button></article>`).join(''),
      actions:offer.mine ? button('withdraw','撤回报价',{},!safe() || pending) : button('submit','接受报价',{},!safe() || pending || offer.closed || (cardRequired && !cardId))});
  }
  function exchangeSetup(){
    const active=room.hyakkiConfig.modules??{orders:false,refining:false,exchange:false};
    const modules=[['orders','公单',room.tradeRoutesOrdersAvailable],['refining','精制',room.tradeRoutesRefiningAvailable],['exchange','商会',true]];
    const last=Object.values(active).filter(Boolean).length===1;
    root.querySelector('.hy-setup-fields')?.insertAdjacentHTML('beforeend',`<div class="e2-setup"><strong>商路风云</strong><div class="e2-entry">${modules.filter(([, , enabled])=>enabled)
      .map(([key,label])=>button('setup-module',label,{key},!available()||last&&active[key],'','',active[key])).join('')}${last||Object.values(active).some(Boolean)?button('setup-live','改用六行百业',{enabled:false},!available()):''}</div></div>`);
  }
  function render(next, {blocked = false,exchangeScroll:previousScroll=null} = {}) {
    room = next;exchangeScroll=previousScroll;
    const nextScope = scopeOf(room);
    if (scope !== nextScope || game()?.pending&&!handlesPending(game().pending) || blocked) { reset(); scope = nextScope; resultText = ''; }
    if(routes()&&publicOrderChoice(game()?.pending)){renderCompass(game().pending);return;}
    if(routes()&&qualityChoice(game()?.pending,game()?.configuration?.modules?.refining)){renderQualityChoice(game().pending);return;}
    if(game()?.exchangeMarket&&borrowedSeal(game().pending)){exchange.render(exchangeContext());return;}
    if(exchange.borrowedDone())reset();
    if(choiceId)reset();
    if(sourceCard&&![...(me()?.hand??[]),...(me()?.tools??[])].some(card=>card.cardId===sourceCard.cardId))reset();
    if(room.tradeRoutesResumeOnly&&room.hostId===room.selfId){
      root.querySelector('.hy-setup-fields')?.insertAdjacentHTML('beforeend',button('setup-live','改用六行百业',{enabled:false},!available()));
      return;
    }
    if(room.phase==='waiting'&&room.tradeRoutesExchangeAvailable&&room.hostId===room.selfId){
      if(!room.tradeRoutesOrdersAvailable||!room.tradeRoutesRefiningAvailable)exchangeSetup();
      return;
    }
    if(room.phase==='waiting'&&room.tradeRoutesRefiningAvailable&&room.hostId===room.selfId){
      const active=room.hyakkiConfig.modules,options=[
        ...(room.tradeRoutesOrdersAvailable?[['orders','公单',ORDER_ONLY_MODULES]]:[]),
        ['refining','精制',REFINING_ONLY_MODULES],
        ...(room.tradeRoutesOrdersAvailable?[['both','公单＋精制',ORDERS_AND_REFINING]]:[]),
      ];
      root.querySelector('.hy-setup-fields')?.insertAdjacentHTML('beforeend',`<div class="e2-setup"><strong>商路风云</strong><div class="e2-entry">${options.map(([id,label,modules])=>{
        const selected=active?.orders===modules.orders&&active?.refining===modules.refining;
        return button('setup-variant',label,{id},!available(),'','',selected);
      }).join('')}${active?button('setup-live','改用六行百业',{enabled:false},!available()):''}</div></div>`);
      return;
    }
    if(room.phase==='waiting'&&room.tradeRoutesOrdersAvailable&&room.hostId===room.selfId){
      const selected=room.hyakkiConfig.packId===EXPANSION_TWO_PACK_ID;
      root.querySelector('.hy-setup-fields')?.insertAdjacentHTML('beforeend',`<div class="e2-setup">${selected?'<span>已启用商路风云 · 公单</span>':''}${button('setup-live',selected?'改用六行百业':'启用商路风云 · 公单',{enabled:!selected},!available())}</div>`);
      return;
    }
    if (room.phase === 'waiting' && room.tradeRoutesSetup && room.hostId === room.selfId) {
      const settings = root.querySelector('.hy-setup-fields');
      if (settings) settings.insertAdjacentHTML('beforeend', `<div class="e2-setup"><strong>商路风云</strong><div class="e2-entry">${[['orders','公单'],['refining','精制'],['exchange','商会']].map(([key,label]) =>
        button('setup',escape(label)+(room.tradeRoutesSetup[key]?' ✓':''),{key},!available())).join('')}</div>${room.tradeRoutesProfile ? `<small>主牌${room.tradeRoutesProfile.deckSize}张 · ${room.tradeRoutesProfile.roles}位角色</small>` : ''}</div>`);
      return;
    }
    if(game()?.exchangeMarket&&game()?.pending){
      el('yg-scene-content').insertAdjacentHTML('beforeend',button('exchange-read','查看交易报价'));
      return;
    }
    if (!routes() || !['playing','paused','finished','aborted'].includes(room.phase) || blocked) return;
    if (!panel) {
      const modules=routes().modules;
      const controls = [
        modules.orders && button('panel','公单领赏',{panel:'orders'},false,routes().orders.some(({id})=>orderAvailable(getPublicOrder(id)))?'is-sellable':''),
        me()&&modules.refining && button('panel','精制',{panel:'refining'},!current()||routes().refined||!GOODS.some(({id})=>me().goods[id]>(me().refined?.[id]??0))),
        (me()||game()?.exchangeMarket)&&modules.exchange && button('panel','玩家交易'+(routes().offers.length ? ' '+routes().offers.length : ''),{panel:'exchange'}),
      ].filter(Boolean).join('');
      if (controls) el('yg-scene-content').insertAdjacentHTML('beforeend', `<div class="e2-entry">${controls}</div>${resultText ? `<p role="status">${escape(resultText)}</p>` : ''}`);
    } else if (panel === 'orders') renderOrders();
    else if (panel === 'refining') renderRefining();
    else if (panel === 'sale') renderSale();
    else if (panel === 'stock-return') renderStockReturn();
    else if(game().exchangeMarket)exchange.render(exchangeContext());
    else renderSampleExchange();
  }
  async function commit(type, fields) {
    if (pending) return;
    const activeScope=scope;
    pending = true;
    try {
      const accepted = await send(type, fields);
      if (room&&accepted&&scope===activeScope) {
        reset();scope=scopeOf(room);
        resultText = {'order-deliver':'公单已完成。','order-replace':'公单已换。','refine-stock':'货物已精制。','offer-post':'报价已发布。',
          'offer-edit':'报价已更新。','offer-withdraw':'报价已撤回。','offer-accept':'商会成交。'}[type] ?? '';
      }
    } finally { pending = false; if(room)rerender(); }
  }
  function click(event) {
    const reader = event.target.closest('.e2-offer-card [data-detail-id]');
    if (reader) returnTradeCard = reader.closest('.e2-offer-card').querySelector('.hy-material-card');
    const control = event.target.closest('[data-e2-command]');
    if (!control || !root.contains(control) || (!routes() && !room?.tradeRoutesSetup&&!room?.tradeRoutesOrdersAvailable&&!room?.tradeRoutesRefiningAvailable&&!room?.tradeRoutesExchangeAvailable&&!room?.tradeRoutesResumeOnly) || control.disabled) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const {e2Command:command, e2Fields} = control.dataset;
    const fields = JSON.parse(e2Fields);
    if(command==='order-read'){
      const order=getPublicOrder(fields.id);
      return inspect(order.name+' · 完整牌文',`<p>${escape(order.summary)}。</p><p><strong>交货例子</strong><br>${escape(order.example)}</p><p>交单花1行动，基础报酬${order.silver}两。成功后立即补上一张公单。</p>`);
    }
    if (command === 'setup') return commit('configure-trade-routes',{[fields.key]:!room.tradeRoutesSetup[fields.key]});
    if(command==='setup-module'){
      const active=room.hyakkiConfig.modules??{orders:false,refining:false,exchange:false};
      return commit('configure',{hyakkiConfig:{packId:EXPANSION_TWO_PACK_ID,modules:{...active,[fields.key]:!active[fields.key]},
        actionLimit:Math.max(2,room.hyakkiConfig.actionLimit)}});
    }
    if(command==='setup-variant'){
      const modules=fields.id==='orders'?ORDER_ONLY_MODULES:fields.id==='refining'?REFINING_ONLY_MODULES:ORDERS_AND_REFINING;
      return commit('configure',{hyakkiConfig:{packId:EXPANSION_TWO_PACK_ID,modules,actionLimit:Math.max(2,room.hyakkiConfig.actionLimit)}});
    }
    if(command==='setup-live')return commit('configure',{hyakkiConfig:fields.enabled
      ?{packId:EXPANSION_TWO_PACK_ID,modules:ORDER_ONLY_MODULES,actionLimit:Math.max(2,room.hyakkiConfig.actionLimit)}
      :{packId:'six-trades-v1'}});
    if(command==='compass-choice'){choiceIndex=fields.index;rerender();return;}
    if(command==='compass-confirm')return commit('choose-effect',{selection:game().pending.choice.options[choiceIndex]});
    if(command==='quality-confirm')return commit('choose-effect',{selection:game().pending.choice.kind==='hammer-refine'
      ?{ordinary:selection.ordinary}:{goods:goodsSum(selection),refined:selection.refined}});
    if(game()?.exchangeMarket&&command.startsWith('exchange-')){
      const result=exchange.command(command,fields,exchangeContext());
      if(!result)rerender();
      return result;
    }
    if (command === 'panel') { reset(); resultText = ''; panel = fields.panel; scope=scopeOf(room); }
    if (command === 'order') {
      const item = routes().orders.find(order => order.position === fields.position);
      if (item) chooseOrder(item);
    }
    if (command === 'offer') { offerId = fields.id; cardId = null; }
    if (command === 'post') { offerId = 'new'; selection = emptySelection(); wanted = null; sampleOfferSide = 'provide'; }
    if (command === 'sample-offer-side') sampleOfferSide = fields.side;
    if (command === 'quality') quality = fields.quality;
    if (command === 'quantity') selection[quality][fields.id] = (selection[quality][fields.id] ?? 0) + fields.delta;
    if (command === 'card') cardId = fields.id;
    if (command === 'want') wanted = fields.id;
    if (command === 'close') {
      if(panel==='exchange'&&game().exchangeMarket&&exchange.selecting()&&!sourceCard)exchange.close();
      else if (orderPosition !== null || offerId !== null) { orderPosition = null; offerId = null; selection = emptySelection(); quality = 'ordinary'; }
      else reset();
      scope=scopeOf(room);
    }
    if (command === 'withdraw') return commit('offer-withdraw',{offerId});
    if(command==='replace'){
      const position={position:orderPosition,generation:orderGeneration};
      return isCompass()?commit('activate-tool',{cardId:sourceCard.cardId,params:position}):commit('order-replace',position);
    }
    if (command === 'submit') {
      if (panel === 'orders'){
        const params={position:orderPosition,generation:orderGeneration,selection};
        return isBroker()?commit('play-character',{cardId:sourceCard.cardId,params}):commit('order-deliver',params);
      }
      if(panel==='sale')return commit('sell',{cardId:sourceCard.cardId,materials:goodsSum(selection),refinedMaterials:selection.refined});
      if(panel==='stock-return')return commit('play-character',{cardId:sourceCard.cardId,params:{initialChoices:[
        {kind:'sell-stock',selection:{goods:goodsSum(selection),refined:selection.refined}},
      ]}});
      if (panel === 'refining'){
        const params={ordinary:selection.ordinary};
        return sourceCard?commit(isHammer()?'activate-tool':'play-character',{cardId:sourceCard.cardId,params}):commit('refine-stock',params);
      }
      if (offerId === 'new') return commit('offer-post',{provide:selection,receive:{ordinary:{[wanted]:1}}});
      return commit('offer-accept',{offerId,...(cardId ? {cardId} : {})});
    }
    rerender();
  }
  function change(event){
    if(!event.target.matches('[data-e2-offer-request]')||event.target.disabled||!game()?.exchangeMarket)return;
    exchange.requestCard(event.target.value);rerender();
  }
  function closeReader(event){
    if(event.target.id!=='hy-card-reader')return;
    const card=returnTradeCard;
    returnTradeCard=null;
    const tray=el('hy-task-materials');
    if(!card||!tray.contains(card)||tray.hidden)return;
    card.focus({preventScroll:true});
    const face=card.getBoundingClientRect(),bounds=tray.getBoundingClientRect();
    if(face.top<bounds.top||face.bottom>bounds.bottom){
      tray.scrollTop+=face.top-bounds.top-4;
      exchangeScroll={top:tray.scrollTop,left:tray.scrollLeft};
    }
  }
  root.addEventListener('click',click,true);
  root.addEventListener('change',change,true);
  root.addEventListener('close',closeReader,true);
  function openFromTable(kind, reference) {
    if (!room || !routes()?.modules[kind] || pending || game().pending) return;
    const order = kind === 'orders' && reference && routes().orders.find(item =>
      item.position === reference.position && item.generation === reference.generation);
    if (kind === 'orders' && reference && !order) { rerender(); return; }
    if (!(order && inOrderDraft())) reset();
    panel = kind;
    scope = scopeOf(room);
    if(kind==='refining' && reference?.goodId && current() && !routes().refined){
      const id=reference.goodId;
      if(GOODS.some(good=>good.id===id)&&me().goods[id]>(me().refined?.[id]??0))selection.ordinary[id]=1;
    }
    if (order) chooseOrder(order);
    if (kind === 'exchange' && reference) {
      const offer = game().exchangeMarket.offers.find(item=>item.id===reference.offerId && item.generation===reference.generation);
      if (!offer) { reset(); rerender(); return; }
      exchange.command('exchange-offer', reference, exchangeContext());
    }
    rerender();
  }
  function readyOrders(){
    if(!routes()?.modules.orders||!current()||pending||isCompass())return [];
    return routes().orders.filter(item=>orderAvailable(getPublicOrder(item.id))).map(item=>item.position);
  }
  function saleDraft(){
    if(!me()||pending||!available()||room.phase!=='playing')return null;
    const effect=game().pending;
    if(effect){
      if(effect.actorId!==room.selfId||!qualityChoice(effect,routes()?.modules.refining))return null;
      if(effect.choice.kind==='sell-goods')return {limit:3,quality,selection};
      if(effect.choice.kind==='sell-stock')return {limit:effect.choice.options[0].maximum,quality,selection};
      return null;
    }
    if(!current())return null;
    if(panel==='orders'&&!isCompass()&&!routes().delivered){
      const order=selectedOrder();
      if(order&&order.generation===orderGeneration)return {orderId:order.id,broker:isBroker(),quality,selection};
    }
    if(panel==='sale')return {cardId:sourceCard.definitionId,quality,selection};
    if(panel==='stock-return')return {limit:Math.floor((Number.MAX_SAFE_INTEGER-me().silver)/2),quality,selection};
    return null;
  }
  return {render,handlesPending,openFromTable,readyOrders,saleDraft,inOrderDraft,resetFromTable:reset,
    get selectedStock(){ return selection; },
    ownsTask(next,blocked){
      return handlesPending(next.game?.pending,next.game)||!blocked&&scope===scopeOf(next)&&!!panel&&!next.game?.pending;
    },
    canSelectSale(card){
      if(!game()?.configuration?.modules?.refining || !card)return false;
      const {recipe}=getExpansionCard(card.definitionId);
      return recipe.type!=='fixed' || Object.keys(recipe.goods).some(id=>me().refined?.[id]>0);
    },
    selectSale(card){
      reset();panel='sale';sourceCard=card;
      const face=getExpansionCard(card.definitionId);
      if(face.recipe.type==='fixed'){
        try{selection.refined=refinedWithdrawal(me(),face.recipe.goods);
          selection.ordinary=Object.fromEntries(GOODS.map(({id})=>[id,(face.recipe.goods[id]??0)-selection.refined[id]]));}
        catch(error){if(!(error instanceof RangeError))throw error;}
      }
    },
    selectSource(card,installed){
      if(!routes()||!current())return false;
      const orders=routes().modules.orders&&(card.definitionId==='yousei.e2c01'&&!installed||card.definitionId==='yousei.e2t01'&&installed&&!card.exhausted);
      const refining=routes().modules.refining&&(card.definitionId==='yousei.e2c02'&&!installed||card.definitionId==='yousei.e2t02'&&installed&&!card.exhausted);
      const stockReturn=routes().modules.refining&&card.definitionId==='yousei.c13'&&!installed;
      const exchangeSource=game().exchangeMarket&&(card.definitionId==='yousei.e2c03'&&!installed||card.definitionId==='yousei.e2t03'&&installed&&!card.exhausted);
      if(!orders&&!refining&&!stockReturn&&!exchangeSource)return false;
      reset();panel=exchangeSource?'exchange':orders?'orders':refining?'refining':'stock-return';sourceCard=card;scope=scopeOf(room);
      if(exchangeSource)exchange.source(card);
      return true;
    },
    destroy(){root.removeEventListener('click',click,true);root.removeEventListener('change',change,true);
      root.removeEventListener('close',closeReader,true);room=null;}};
}
