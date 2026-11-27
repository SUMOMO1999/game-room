import {GOODS,definitionIdForCopy,materialProfileFor} from './material.mjs';
import {completePending,definition,discardCards,emit,goodsCount,player,removeCard,requireRule,RuleError,setChoice} from './model.mjs';
import {goodsVector} from '../trade-contract.mjs';
import {quoteExchange} from './expansion-two-economy.mjs';

export const EXCHANGE_BROKER='E2C03';
export const EXCHANGE_SEAL='E2T03';
export const EXCHANGE_KEEPER='yousei.role.e2r05';
const sources=['ordinary','broker','seal'];
const closedReasons=['withdrawn','expired','unfunded','traded','closing','ended'];
const plain=value=>value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const subset=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const exact=(value,keys)=>subset(value,keys)&&keys.every(key=>Object.hasOwn(value,key));
const integer=(value,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const offerId=turn=>'offer-'+turn;
const validOfferId=id=>typeof id==='string'&&/^offer-[1-9][0-9]{0,15}$/u.test(id)&&integer(Number(id.slice(6)),1);
export const validExchangeOfferReference=({offerId,generation})=>validOfferId(offerId)&&integer(generation,1,2);
export const exchangeOfferKey=({id,generation})=>`${id}:${generation}`;
const newUsage=()=>({published:false,edited:false,traded:false});
export const createExchangeMarket=players=>({offers:[],usage:Object.fromEntries(players.map(({id})=>[id,newUsage()]))});
export const isExchangeEvent=type=>['offer-posted','offer-edited','offer-closed','offer-accepted'].includes(type);

function normalizeGoods(value){
  if(value===undefined)return {};
  const full=goodsVector(value);
  return Object.fromEntries(GOODS.flatMap(({id})=>full[id]?[ [id,full[id]] ]:[]));
}
function normalizeLeg(terms,{source,profile,side,publicCards=false}){
  const provide=side==='provide',cardKey=provide?(publicCards?'cards':'cardIds'):'card';
  requireRule(subset(terms,['ordinary','refined','silver',cardKey]),'报价资产字段无效。');
  const ordinary=normalizeGoods(terms.ordinary),refined=normalizeGoods(terms.refined);
  const silver=terms.silver===undefined?0:terms.silver;
  requireRule(profile.modules.refining||!goodsCount(refined),'当前牌局没有精制货。');
  const count=goodsCount(ordinary)+goodsCount(refined);
  requireRule(count<=(source==='seal'?4:3)&&integer(silver,0,10),'货物或银两超过报价上限。');
  if(provide){
    const cards=Object.hasOwn(terms,cardKey)?terms[cardKey]:[];
    requireRule(Array.isArray(cards)&&cards.length<=(source==='broker'?2:1)
      &&(publicCards||new Set(cards).size===cards.length)&&cards.every(id=>typeof id==='string'
        &&(publicCards?profile.cards.some(card=>card.id===id):definitionIdForCopy(id,profile))),'报价手牌无效或超过上限。');
    requireRule(count||silver||cards.length,'双方都须提供资产。');
    return {ordinary,refined,silver,[cardKey]:[...cards]};
  }
  const card=terms.card??null;
  const exactFace=exact(card,['definitionId'])&&profile.cards.some(face=>face.id===card.definitionId);
  const category=exact(card,['category'])&&profile.cards.some(face=>face.category===card.category);
  requireRule(card===null||exactFace||category,'请选择本局的一种手牌或牌类。');
  requireRule(count||silver||card,'双方都须提供资产。');
  return {ordinary,refined,silver,card:card&&{...card}};
}
function normalizeOffer(provide,receive,source,profile){
  requireRule(sources.includes(source),'报价来源无效。');
  const give=normalizeLeg(provide,{source,profile,side:'provide'});
  const take=normalizeLeg(receive,{source,profile,side:'receive'});
  requireRule(!give.silver||!take.silver,'银两只能由一方支付。');
  const sameCards=!take.card?give.cardIds.length===0
    :give.cardIds.length===1&&definition(give.cardIds[0]).id===take.card.definitionId;
  requireRule(!sameCards||give.silver!==take.silver||!same(give.ordinary,take.ordinary)||!same(give.refined,take.refined),
    '双方提供的资产完全相同。');
  return {provide:give,receive:take};
}
export function exchangeTermsProblem(provide,receive,profile,source='ordinary'){
  try{
    if(provide===undefined)normalizeLeg(receive,{source:'ordinary',profile,side:'receive'});
    else normalizeOffer(provide,receive,source,profile);
    return null;
  }catch(error){if(error instanceof RuleError||error instanceof RangeError)return error.message;throw error;}
}
const canFund=(owner,terms)=>owner.silver>=terms.silver&&terms.cardIds.every(id=>owner.hand.includes(id))
  &&GOODS.every(({id})=>(terms.ordinary[id]??0)<=owner.goods[id]-(owner.refined?.[id]??0)
    &&(terms.refined[id]??0)<=(owner.refined?.[id]??0));
const meetsCard=(id,condition)=>{
  const card=definition(id);
  return condition.definitionId?card.id===condition.definitionId:card.category===condition.category;
};
function publicProvide({cardIds,...terms}){
  return {...structuredClone(terms),cards:cardIds.map(id=>definition(id).id)};
}
function publicOffer({provide,receive,...offer}){
  return {...offer,provide:publicProvide(provide),receive:structuredClone(receive)};
}
function publishable(state,owner,{borrowed=false}={}){
  const usage=state.exchangeMarket?.usage[owner.id];
  requireRule(usage&&!state.closing&&state.stage==='use'&&state.turnPlayerId===owner.id
    &&(!state.pending||borrowed)&& (borrowed||state.actionsUsed<state.actionLimit),
  '当前不能挂牌。');
  requireRule(!usage.published&&!usage.traded,'本区间已经挂牌或成交。');
  return usage;
}
export function exchangeSealBorrowable(state,owner){
  try{publishable(state,owner,{borrowed:true});return null;}
  catch(error){if(error instanceof RuleError)return error.message;throw error;}
}
export function startBorrowedExchangeSeal(state,copyId,params){
  const pending=state.pending,owner=player(state,pending.ownerId);
  if(!exact(params,[])){
    postExchangeOffer(state,owner,params,materialProfileFor(state),{source:'seal',sourceCardId:copyId,borrowed:true});
    completePending(state);
    return;
  }
  Object.assign(pending,{kind:'tool',code:EXCHANGE_SEAL,stage:'offer',data:{toolId:copyId}});
  setChoice(state,{kind:'seal-offer',actorId:owner.id,options:[{skip:true}],defaultSelection:{skip:true}});
}
export function chooseBorrowedExchangeSeal(state,selection){
  const {ownerId,data:{toolId}}=state.pending;
  if(!(exact(selection,['skip'])&&selection.skip===true)){
    postExchangeOffer(state,player(state,ownerId),selection,materialProfileFor(state),{source:'seal',sourceCardId:toolId,borrowed:true});
  }
  completePending(state);
}
export function borrowedSealPendingProblem(state,pending){
  const {sourceCards,poolCards,data,choice,ownerId}=pending;
  return state.configuration.modules?.exchange&&pending.stage==='offer'&&sourceCards.length===1&&definition(sourceCards[0]).sourceCode==='M08'
    &&exact(data,['toolId'])&&state.discard.includes(data.toolId)&&definition(data.toolId).sourceCode===EXCHANGE_SEAL
    &&!poolCards.length&&!goodsCount(pending.goods)&&!goodsCount(pending.refined??{})&&!pending.response&&!pending.receipt
    &&choice?.kind==='seal-offer'&&choice.actorId===ownerId&&choice.visibility==='private'
    &&same(choice.options,[{skip:true}])&&same(choice.defaultSelection,{skip:true})
    &&!exchangeSealBorrowable(state,player(state,ownerId))?null:'借用商会印信的报价步骤无效。';
}
export function postExchangeOffer(state,owner,params,profile,{source='ordinary',sourceCardId,borrowed=false}={}){
  const usage=publishable(state,owner,{borrowed});
  requireRule(exact(params,['provide','receive']),'请填写提供项和索取项。');
  const terms=normalizeOffer(params.provide,params.receive,source,profile);
  requireRule(canFund(owner,terms.provide)&&(!sourceCardId||!terms.provide.cardIds.includes(sourceCardId)),'提供的资产已不足或包含发动用牌。');
  const offer={id:offerId(state.turnNumber),generation:1,makerId:owner.id,source,
    expiresAtTurn:state.turnNumber+state.players.length,...terms};
  requireRule(integer(offer.expiresAtTurn,1),'报价有效期超出范围。');
  usage.published=true;state.exchangeMarket.offers.push(offer);
  if(source==='broker'){
    removeCard(owner.hand,sourceCardId);discardCards(state,[sourceCardId]);
    emit(state,{type:'character-played',actorSeatId:owner.id,cardId:definition(sourceCardId).id});
  }else if(source==='seal'&&!borrowed){
    owner.tools.find(tool=>tool.cardId===sourceCardId).exhausted=true;
    emit(state,{type:'tool-activated',actorSeatId:owner.id,cardId:definition(sourceCardId).id});
  }
  emit(state,{type:'offer-posted',actorSeatId:owner.id,offer:publicOffer(offer)});
}
function activeOffer(state,action){
  requireRule(state.exchangeMarket&&!state.closing&&!state.pending,'当前不能操作商会报价。');
  requireRule(validExchangeOfferReference(action),'报价标识无效。');
  const offer=state.exchangeMarket.offers.find(item=>item.id===action.offerId&&item.generation===action.generation);
  requireRule(offer,'报价已结束或已修改。','STALE_OFFER');
  return offer;
}
function closeOffer(state,offer,reason,events=state.lastPublicEvents){
  state.exchangeMarket.offers.splice(state.exchangeMarket.offers.indexOf(offer),1);
  events.push({type:'offer-closed',actorSeatId:offer.makerId,offerId:offer.id,generation:offer.generation,reason});
}
export function closeExchangeOffers(state,reason,events=state.lastPublicEvents){
  for(const offer of [...(state.exchangeMarket?.offers??[])])closeOffer(state,offer,reason,events);
}
export function beginExchangeTurn(state){
  if(!state.exchangeMarket)return;
  if(state.closing)closeExchangeOffers(state,'closing');
  else for(const offer of [...state.exchangeMarket.offers])if(offer.expiresAtTurn<=state.turnNumber)closeOffer(state,offer,'expired');
  state.exchangeMarket.usage[state.turnPlayerId]=newUsage();
}
export function pruneExchangeOffers(state){
  if(!state.exchangeMarket)return;
  for(const offer of [...state.exchangeMarket.offers]){
    if(state.exchangeMarket.usage[offer.makerId].traded)closeOffer(state,offer,'traded');
    else if(!canFund(player(state,offer.makerId),offer.provide))closeOffer(state,offer,'unfunded');
  }
}
export function editExchangeOffer(state,owner,action,profile){
  const offer=activeOffer(state,action),usage=state.exchangeMarket.usage[owner.id];
  requireRule(offer.makerId===owner.id&&offer.source==='ordinary'&&owner.roleId===EXCHANGE_KEEPER&&!usage.edited
    &&state.stage==='use'&&state.actionsUsed<state.actionLimit,'当前不能改价。');
  const {receive}=normalizeOffer(offer.provide,action.receive,offer.source,profile);
  requireRule(!same(receive,offer.receive),'索取项没有实际变化。');
  offer.receive=receive;offer.generation++;usage.edited=true;
  emit(state,{type:'offer-edited',actorSeatId:owner.id,offer:publicOffer(offer)});
}
export function withdrawExchangeOffer(state,owner,action){
  const offer=activeOffer(state,action);
  requireRule(offer.makerId===owner.id,'只能撤回自己的报价。');
  closeOffer(state,offer,'withdrawn');
}
function exchangeQuote(state,offer,maker,taker,cardId){
  requireRule(maker.id!==taker.id,'发布者不能接受自己的报价。');
  requireRule(!state.exchangeMarket.usage[maker.id].traded&&!state.exchangeMarket.usage[taker.id].traded,'本区间已经成交。');
  const {card,...requested}=offer.receive;
  requireRule(card?typeof cardId==='string'&&taker.hand.includes(cardId)&&meetsCard(cardId,card):cardId===undefined,'请选择符合报价的手牌。');
  const receive={...requested,cardIds:card?[cardId]:[]};
  const quote=quoteExchange({maker,taker,provide:offer.provide,receive,source:offer.source,cardDefinition:id=>definition(id).id});
  return {quote,receive};
}
function applyExchangeSide(owner,{goods,refined,silver,temporaryOccupied,hand}){
  Object.assign(owner,{goods,silver,temporaryOccupied,hand});
  if(owner.refined)owner.refined=refined;
}
export function acceptExchangeOffer(state,taker,action){
  const offer=activeOffer(state,action),maker=player(state,offer.makerId);
  const {quote,receive}=exchangeQuote(state,offer,maker,taker,action.cardId);
  applyExchangeSide(maker,quote.maker);applyExchangeSide(taker,quote.taker);
  state.exchangeMarket.usage[maker.id].traded=true;state.exchangeMarket.usage[taker.id].traded=true;
  state.exchangeMarket.offers.splice(state.exchangeMarket.offers.indexOf(offer),1);
  emit(state,{type:'offer-accepted',actorSeatId:taker.id,makerSeatId:maker.id,offerId:offer.id,generation:offer.generation,source:offer.source,
    provide:publicProvide(offer.provide),receive:publicProvide(receive),makerFee:quote.maker.fee,takerFee:quote.taker.fee});
}
export function projectExchangeMarket(state,viewerId){
  const viewer=state.players.find(owner=>owner.id===viewerId);
  const enabled=state.status==='playing'&&!state.pending&&!state.lifecycle.manual&&!state.lifecycle.absence&&!state.lifecycle.capacity;
  return {offers:state.exchangeMarket.offers.map(offer=>{
    const visible=publicOffer(offer);
    if(!viewer)return visible;
    const maker=player(state,offer.makerId),mine=viewer.id===maker.id;
    const own={...visible,mine};
    if(mine)return own;
    const matching=offer.receive.card?viewer.hand.filter(id=>meetsCard(id,offer.receive.card)):[undefined];
    const eligibleCards=[];
    let ready=false,problem=null,temporaryFee=0;
    if(enabled)for(const cardId of matching){
      try{
        const {quote}=exchangeQuote(state,offer,maker,viewer,cardId);
        ready=true;temporaryFee=quote.taker.fee;if(cardId)eligibleCards.push(cardId);
      }
      catch(error){if(error instanceof RuleError||error instanceof RangeError)problem=error.message;else throw error;}
    }
    return {...own,ready,eligibleCards,...(ready?{temporaryFee}:{reason:problem??(enabled?'没有符合条件的手牌。':'当前有待完成的步骤。')})};
  }),...(viewer?{usage:{...state.exchangeMarket.usage[viewer.id]}}:{})};
}

export function exchangeStateProblem(state,profile){
  try{
    const market=state.exchangeMarket,ids=state.players.map(p=>p.id);
    requireRule(exact(market,['offers','usage'])&&exact(market.usage,ids)&&Array.isArray(market.offers)&&market.offers.length<=ids.length
      &&new Set(market.offers.map(offer=>offer.makerId)).size===market.offers.length
      &&new Set(market.offers.map(offer=>offer.id)).size===market.offers.length,'商会保存格式无效。');
    requireRule(state.status==='playing'&&!state.closing||market.offers.length===0,'收市或终局不能保留报价。');
    for(const id of ids){
      const usage=market.usage[id];
      const firstTurn=(ids.indexOf(id)-ids.indexOf(state.firstPlayerId)+ids.length)%ids.length+1;
      requireRule(exact(usage,['published','edited','traded'])&&Object.values(usage).every(v=>typeof v==='boolean')
        &&(!usage.edited||usage.published&&player(state,id).roleId===EXCHANGE_KEEPER)
        &&(firstTurn<=state.turnNumber||!usage.published),'商会区间次数无效。');
    }
    for(const offer of market.offers){
      requireRule(exact(offer,['id','generation','makerId','source','expiresAtTurn','provide','receive'])&&validOfferId(offer.id)
        &&integer(offer.generation,1,2)&&ids.includes(offer.makerId),'保存的报价标识无效。');
      const posted=Number(offer.id.slice(6)),maker=player(state,offer.makerId),usage=market.usage[maker.id];
      const expectedMaker=ids[(ids.indexOf(state.firstPlayerId)+posted-1)%ids.length];
      requireRule(expectedMaker===maker.id&&posted<=state.turnNumber&&offer.expiresAtTurn===posted+ids.length&&offer.expiresAtTurn>state.turnNumber
        &&usage.published&&!usage.traded&&usage.edited===(offer.generation===2)
        &&(offer.generation===1||offer.source==='ordinary'),'报价与区间代际不一致。');
      const terms=normalizeOffer(offer.provide,offer.receive,offer.source,profile);
      requireRule(same(offer.provide,terms.provide)&&same(offer.receive,terms.receive)&&canFund(maker,offer.provide),'报价资产与实际库存不符。');
    }
    return null;
  }catch(error){if(error instanceof RuleError||error instanceof RangeError||error instanceof TypeError)return '保存的商会状态无效。';throw error;}
}

export const exchangePublicOffers=market=>(market?.offers??[]).map(publicOffer);
/** The committed public facts must account for the exact active offer set. */
export function exchangePublicHistoryAfter(offers,events,profile){
  if(!events.some(event=>isExchangeEvent(event.type)))return offers;
  const active=new Map(offers.map(offer=>[offer.id,offer]));
  for(const event of events){
    if(!isExchangeEvent(event.type))continue;
    if(event.type==='offer-posted'){
      if(active.has(event.offer.id)||[...active.values()].some(offer=>offer.makerId===event.actorSeatId))return null;
      active.set(event.offer.id,event.offer);
      continue;
    }
    const offer=active.get(event.offerId??event.offer.id);
    if(!offer)return null;
    if(event.type==='offer-edited'){
      if(offer.makerId!==event.actorSeatId||offer.generation+1!==event.offer.generation
        ||!same({...offer,generation:event.offer.generation,receive:event.offer.receive},event.offer)
        ||same(offer.receive,event.offer.receive))return null;
      active.set(offer.id,event.offer);
      continue;
    }
    if(offer.generation!==event.generation)return null;
    if(event.type==='offer-closed'){
      if(offer.makerId!==event.actorSeatId)return null;
    }else{
      const {card,...expected}=offer.receive;
      const {cards,...received}=event.receive;
      const face=cards.length===1?profile.cards.find(item=>item.id===cards[0]):null;
      const matching=card?(card.definitionId?face?.id===card.definitionId:face?.category===card.category):cards.length===0;
      if(!matching||!same(expected,received)||offer.makerId!==event.makerSeatId
        ||offer.source!==event.source||!same(offer.provide,event.provide))return null;
    }
    active.delete(offer.id);
  }
  return [...active.values()];
}
export function exchangeHistoryMatches(before,after,events,profile){
  return same(exchangePublicHistoryAfter(exchangePublicOffers(before),events,profile),exchangePublicOffers(after));
}

export function exchangeEventProblem(event,ids,profile){
  try{
    requireRule(profile.modules.exchange&&ids.includes(event.actorSeatId),'商会事件席位无效。');
    if(event.type==='offer-posted'||event.type==='offer-edited'){
      const offer=event.offer;
      requireRule(exact(event,['type','actorSeatId','offer'])&&exact(offer,['id','generation','makerId','source','expiresAtTurn','provide','receive'])
        &&validOfferId(offer.id)&&offer.makerId===event.actorSeatId&&sources.includes(offer.source)
        &&offer.generation===(event.type==='offer-posted'?1:2)&&offer.expiresAtTurn===Number(offer.id.slice(6))+ids.length
        &&(event.type==='offer-posted'||offer.source==='ordinary'),'公开报价格式无效。');
      const left=normalizeLeg(offer.provide,{source:offer.source,profile,side:'provide',publicCards:true});
      const right=normalizeLeg(offer.receive,{source:offer.source,profile,side:'receive'});
      requireRule(same(left,offer.provide)&&same(right,offer.receive)&&(!left.silver||!right.silver),'公开报价资产无效。');
      const sameCards=!right.card?left.cards.length===0:left.cards.length===1&&left.cards[0]===right.card.definitionId;
      requireRule(!sameCards||left.silver!==right.silver||!same(left.ordinary,right.ordinary)||!same(left.refined,right.refined),'公开报价资产完全相同。');
    }else{
      requireRule(validOfferId(event.offerId)&&integer(event.generation,1,2),'报价标识无效。');
      if(event.type==='offer-closed')requireRule(exact(event,['type','actorSeatId','offerId','generation','reason'])
        &&closedReasons.includes(event.reason),'报价结束事件无效。');
      else{
        requireRule(event.type==='offer-accepted'&&exact(event,['type','actorSeatId','makerSeatId','offerId','generation','source','provide','receive','makerFee','takerFee'])
          &&sources.includes(event.source)&&(event.generation===1||event.source==='ordinary')
          &&ids.includes(event.makerSeatId)&&event.makerSeatId!==event.actorSeatId&&integer(event.makerFee,0,2)&&integer(event.takerFee,0,2),'成交事件无效。');
        const left=normalizeLeg(event.provide,{source:event.source,profile,side:'provide',publicCards:true});
        const right=normalizeLeg(event.receive,{source:event.source==='broker'?'ordinary':event.source,profile,side:'provide',publicCards:true});
        requireRule(same(left,event.provide)&&same(right,event.receive)&&(!left.silver||!right.silver)
          &&(left.silver!==right.silver||!same(left.ordinary,right.ordinary)||!same(left.refined,right.refined)
            ||!same([...left.cards].sort(),[...right.cards].sort())),'公开成交资产无效。');
      }
    }
    return null;
  }catch(error){if(error instanceof RuleError||error instanceof RangeError||error instanceof TypeError)return '公开商会事件无效。';throw error;}
}
