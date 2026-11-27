import {getPublicOrder} from '../content/expansion-two.mjs';
import {GOODS} from './material.mjs';
import {completePending,createPending,definition,discardCards,emit,goodsCount,player,removeCard,requireRule,setChoice} from './model.mjs';
import {beginPublicOrderChoice,finishPublicOrderChoice,publicOrderMarketProblem,replacePublicOrder,settlePublicOrder} from './public-order-market.mjs';
import {applyGoodsReceipt} from '../trade-contract.mjs';
import {refinedEventPremium,scheduleAppraisal,refinedSaleFacts} from './refining.mjs';

export const ORDER_BROKER='E2C01';
export const ORDER_COMPASS='E2T01';
const SCOUT='yousei.role.e2r02';
const exact=(value,keys)=>value&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const positionOf=({position,generation})=>({position,generation});
export const newOrderUsage=()=>({delivered:false,replaced:false});

function needsOrderAction(state,used){
  requireRule(state.publicOrders&&state.stage==='use','当前不能操作公单。');
  requireRule(!state.orderUsage[used],'本回合已使用这次公单操作。');
  requireRule(state.actionsUsed<state.actionLimit,'公单操作至少需要剩余1行动。');
}
function matchingPosition(state,params){
  return exact(params,['position','generation'])&&Number.isSafeInteger(params.position)
    &&params.position>=0&&params.position<3&&state.publicOrders.slots[params.position].generation===params.generation;
}
export function validOrderDeliveryInput(selection,{refining=false}={}){
  if(!exact(selection,['ordinary'])&&!exact(selection,['ordinary','refined']))return false;
  const validVector=(value,max)=>value&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
    &&Object.entries(value).every(([id,count])=>GOODS.some(good=>good.id===id)&&Number.isSafeInteger(count)&&count>=0&&count<=max);
  return validVector(selection.ordinary,4)&&(!Object.hasOwn(selection,'refined')||validVector(selection.refined,refining?4:0));
}
function recordReplacement(state,owner,position,source,previous){
  const slot=state.publicOrders.slots[position];
  emit(state,{type:'order-replaced',actorSeatId:owner.id,source,position,
    generation:slot.generation,orderId:previous,replacementId:slot.id});
}
export function deliverOrder(state,owner,params,ctx,brokerCard){
  needsOrderAction(state,'delivered');
  requireRule(exact(params,['position','generation','selection'])
    &&validOrderDeliveryInput(params.selection,{refining:state.configuration.modules?.refining}),'请选择本次交单的货物。');
  requireRule(matchingPosition(state,positionOf(params)),'原公单已更换。','STALE_ORDER');
  const previous=state.publicOrders.slots[params.position]?.id;
  const result=settlePublicOrder({market:state.publicOrders,owner,bankGoods:state.bankGoods,
    ...params,broker:brokerCard!==undefined,saleBonusUsed:state.turnUsage.saleBonus,randomInt:ctx.randomInt});
  state.actionsUsed++;
  state.orderUsage.delivered=true;
  if(result.quote.batchBonus){
    state.turnUsage.saleBonus=true;
    state.turnUsage.sold=true;
  }
  state.publicOrders=result.market;
  state.bankGoods=result.bankGoods;
  const delivery=result.quote.delivery;
  applyGoodsReceipt(owner,{...result.owner,refined:owner.refined===undefined?undefined:result.owner.refined});
  owner.silver=result.owner.silver;
  scheduleAppraisal(state,owner,delivery.refined);
  if(brokerCard!==undefined){
    removeCard(owner.hand,brokerCard);
    discardCards(state,[brokerCard]);
    emit(state,{type:'character-played',actorSeatId:owner.id,cardId:definition(brokerCard).id});
  }
  emit(state,{type:'order-delivered',actorSeatId:owner.id,source:brokerCard===undefined?'ordinary':'broker',
    position:params.position,generation:result.market.slots[params.position].generation,orderId:previous,
    replacementId:result.market.slots[params.position].id,silver:result.quote.proceeds-result.quote.batchBonus,
    ...refinedSaleFacts(delivery.refined),
    goods:GOODS.filter(({id})=>delivery.goods[id]>0).map(({id})=>({id,count:delivery.goods[id]}))});
  if(result.quote.batchBonus)emit(state,{type:'role-triggered',actorSeatId:owner.id,roleId:owner.roleId,silver:result.quote.batchBonus});
}
export function replaceOrder(state,owner,params,ctx){
  needsOrderAction(state,'replaced');
  requireRule(matchingPosition(state,params),'原公单已更换。','STALE_ORDER');
  const previous=state.publicOrders.slots[params.position].id;
  state.publicOrders=replacePublicOrder({market:state.publicOrders,...params,randomInt:ctx.randomInt});
  state.orderUsage.replaced=true;
  if(owner.roleId!==SCOUT)state.actionsUsed++;
  recordReplacement(state,owner,params.position,owner.roleId===SCOUT?'scout':'ordinary',previous);
}
export function compassProblem(state,copyId,params,{borrowed=false}={}){
  if(!state.publicOrders||state.stage!=='use'||state.orderUsage.replaced||state.publicOrders.pending)return '当前不能用罗盘换单。';
  if(borrowed&&(!state.pending||!state.discard.includes(copyId)))return '借用的罗盘不在弃牌区。';
  if(borrowed&&exact(params,[]))return null;
  return matchingPosition(state,params)?null:'请选择仍在位的公单。';
}
function revealOrders(state,actorId,position,ctx){
  const market=beginPublicOrderChoice({market:state.publicOrders,actorId,...position,randomInt:ctx.randomInt});
  state.publicOrders=market;
  state.pending.stage='orders';
  const options=market.pending.candidates.map(orderId=>({orderId}));
  setChoice(state,{kind:'compass-order',actorId,options,defaultSelection:options[0]});
  emit(state,{type:'order-compass-opened',actorSeatId:actorId,...position});
}
export function startCompass(state,copyId,params,ctx,{borrowed=false}={}){
  const actorId=state.turnPlayerId;
  const issue=compassProblem(state,copyId,params,{borrowed});
  requireRule(!issue,issue);
  const data={toolId:copyId,borrowed};
  if(borrowed)Object.assign(state.pending,{kind:'tool',code:ORDER_COMPASS,choice:null,data});
  else createPending(state,{kind:'tool',ownerId:actorId,code:ORDER_COMPASS,data});
  state.orderUsage.replaced=true;
  if(borrowed&&exact(params,[])){
    state.pending.stage='position';
    const options=state.publicOrders.slots.map(positionOf);
    setChoice(state,{kind:'compass-position',actorId,options,defaultSelection:options[0]});
    return;
  }
  revealOrders(state,actorId,params,ctx);
}
export function chooseCompass(state,selection,ctx){
  const pending=state.pending,actorId=pending.ownerId;
  if(pending.stage==='position'){
    requireRule(matchingPosition(state,selection),'请选择仍在位的公单。','STALE_ORDER');
    revealOrders(state,actorId,selection,ctx);
    return;
  }
  requireRule(pending.stage==='orders'&&exact(selection,['orderId']),'请选择本次揭示的公单。');
  const {position,generation}=state.publicOrders.pending;
  const previous=state.publicOrders.slots[position].id;
  state.publicOrders=finishPublicOrderChoice({market:state.publicOrders,actorId,position,generation,...selection});
  recordReplacement(state,player(state,actorId),position,'compass',previous);
  completePending(state);
}
export function orderStateProblem(state){
  const issue=publicOrderMarketProblem(state.publicOrders);
  if(issue)return issue;
  if(!exact(state.orderUsage,['delivered','replaced'])||Object.values(state.orderUsage).some(value=>typeof value!=='boolean')
    ||state.stage!=='use'&&Object.values(state.orderUsage).some(Boolean))return '公单回合次数无效。';
  if(state.publicOrders.pending&&state.pending?.code!==ORDER_COMPASS)return '罗盘候选缺少对应的待决步骤。';
  return null;
}
export function compassPendingProblem(state,pending){
  if(!state.publicOrders||!state.orderUsage.replaced||state.stage!=='use'||pending.response||pending.receipt
    ||pending.poolCards.length||goodsCount(pending.goods)||!exact(pending.data,['toolId','borrowed'])
    ||typeof pending.data.borrowed!=='boolean'||definition(pending.data.toolId).sourceCode!==ORDER_COMPASS)return '罗盘步骤无效。';
  const {toolId,borrowed}=pending.data;
  const owner=player(state,pending.ownerId);
  if(borrowed?!(state.discard.includes(toolId)&&pending.sourceCards.length===1&&definition(pending.sourceCards[0]).sourceCode==='M08')
    :pending.sourceCards.length||!owner.tools.some(tool=>tool.cardId===toolId&&tool.exhausted))return '罗盘来源无效。';
  const market=state.publicOrders,choice=pending.choice;
  if(choice?.actorId!==owner.id||choice.visibility!=='private')return '罗盘选择归属无效。';
  const awaitingPosition=pending.stage==='position'&&borrowed&&market.pending===null;
  const awaitingOrder=pending.stage==='orders'&&market.pending?.actorId===owner.id;
  if(!awaitingPosition&&!awaitingOrder)return '罗盘待选状态无效。';
  const options=awaitingPosition?market.slots.map(positionOf):market.pending.candidates.map(orderId=>({orderId}));
  return choice.kind===(awaitingPosition?'compass-position':'compass-order')&&same(choice.options,options)
    &&same(choice.defaultSelection,options[0])?null:'罗盘候选与牌堆不一致。';
}

// Closed event payloads can be projected today and written by the new history reader later.
export function orderEventProblem(event,ids,{refining=false}={}){
  const base=['type','actorSeatId','position','generation'];
  const validLocation=ids.includes(event?.actorSeatId)&&Number.isInteger(event.position)&&event.position>=0&&event.position<3
    &&Number.isSafeInteger(event.generation)&&event.generation>=1;
  if(!validLocation)return '公单战况位置无效。';
  if(event.type==='order-compass-opened')return exact(event,base)?null:'公单战况格式无效。';
  const fields=[...base,'orderId','replacementId','source'];
  if(event.generation<2||!['order-delivered','order-replaced'].includes(event.type)||event.orderId===event.replacementId)return '公单战况代际无效。';
  let order;
  try{order=getPublicOrder(event.orderId);getPublicOrder(event.replacementId);}catch(error){if(error instanceof RangeError)return error.message;throw error;}
  if(event.type==='order-replaced')return exact(event,fields)&&['ordinary','scout','compass'].includes(event.source)?null:'换单战况格式无效。';
  const premium=refinedEventPremium(event,{refining});
  return exact(event,[...fields,'goods','silver',...(Object.hasOwn(event,'refinedGoods')?['refinedGoods']:[])])&&['ordinary','broker'].includes(event.source)
    &&premium!==null&&(event.silver===order.silver+premium||order.kind==='bulk'&&event.silver===order.silver+premium+2)
    &&Array.isArray(event.goods)&&event.goods.length<=order.count&&event.goods.every(g=>exact(g,['id','count'])
      &&GOODS.some(({id})=>id===g.id)&&Number.isSafeInteger(g.count)&&g.count>0)
    &&new Set(event.goods.map(g=>g.id)).size===event.goods.length&&event.goods.reduce((sum,g)=>sum+g.count,0)===order.count
    ?null:'交单战况格式无效。';
}
