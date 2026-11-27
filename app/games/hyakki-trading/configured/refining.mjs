import {GOODS} from './material.mjs';
import {completePending,createPending,definition,drawCards,emit,goodsCount,goodsEntries,player,requireRule,RuleError,setChoice} from './model.mjs';
import {planRefining} from './expansion-two-economy.mjs';

export const WORKSHOP_OWNER='yousei.role.e2r03';
export const APPRAISER='yousei.role.e2r04';
export const APPRAISAL_JOB='appraiser-draw-discard';
export const REFINING_ARTISAN='E2C02';
export const REFINING_HAMMER='E2T02';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function hasStockQuality(stock,id,refined){
  return typeof refined==='boolean'&&!!stock.refined
    &&(refined?stock.refined[id]>0:stock.goods[id]>stock.refined[id]);
}
export const unitQuality=(id,refined)=>refined===undefined?undefined:{[id]:Number(refined)};
export const qualityFields=(stock,fields,key='refined')=>stock.refined?[...fields,key]:fields;
export function checkedUnitQuality(stock,id,refined){
  requireRule(refined===undefined||hasStockQuality(stock,id,refined),'所选品质已经没有库存。');
  return unitQuality(id,refined);
}

function refiningPlan(state,owner,ordinary,source){
  requireRule(state.configuration.modules?.refining&&state.stage==='use','当前不能精制货物。');
  requireRule(!state.refiningUsed,'本回合已经精制过。');
  const limit=source===REFINING_ARTISAN||owner.roleId===WORKSHOP_OWNER?2:1;
  return planRefining({owner,ordinary,limit});
}
function hammerChoice(owner){
  const ordinary=Object.fromEntries(GOODS.map(({id})=>[id,owner.goods[id]-owner.refined[id]]));
  const first=GOODS.find(({id})=>ordinary[id]>0);
  return first?{options:[{ordinary,maximum:owner.roleId===WORKSHOP_OWNER?2:1}],defaultSelection:{ordinary:{[first.id]:1}}}:null;
}
export function hammerProblem(state,owner,params,copyId,borrowed){
  if(!state.configuration.modules?.refining||state.stage!=='use'||!owner.refined)return '当前不能精制货物。';
  if(borrowed&&(!state.pending||!state.discard.includes(copyId)))return '借用的百工锤不在弃牌区。';
  if(!exact(params,[])&&!exact(params,['ordinary']))return '请选择要精制的货物。';
  if(state.refiningUsed)return '本回合已经精制过。';
  if(exact(params,[]))return hammerChoice(owner)?null:'需要至少1件普通货物。';
  try{refiningPlan(state,owner,params.ordinary,REFINING_HAMMER);return null;}
  catch(error){if(error instanceof RuleError||error instanceof RangeError)return error.message;throw error;}
}

export function refineStock(state,owner,ordinary,source='ordinary'){
  const before=owner.refined;
  owner.refined=refiningPlan(state,owner,ordinary,source);
  const changed=Object.fromEntries(GOODS.map(({id})=>[id,owner.refined[id]-before[id]]));
  state.refiningUsed=true;
  emit(state,{type:'stock-refined',actorSeatId:owner.id,source:source===REFINING_ARTISAN?'artisan':source===REFINING_HAMMER?'hammer':'ordinary',
    goods:goodsEntries(changed).map(([id,count])=>({id,count}))});
}

export function scheduleAppraisal(state,owner,refined){
  if(owner.roleId!==APPRAISER||state.appraisalUsed||!refined||goodsCount(refined)===0)return;
  state.appraisalUsed=true;
  state.afterActions.push({kind:APPRAISAL_JOB,playerId:owner.id});
}
export function refinedSaleFacts(refined){
  return refined&&goodsCount(refined)>0?{refinedGoods:goodsEntries(refined).map(([id,count])=>({id,count}))}:{};
}

function finishHammer(state,owner,ordinary,ctx){
  refineStock(state,owner,ordinary,REFINING_HAMMER);
  owner.hand.push(...drawCards(state,1,ctx));
}
export function startHammer(state,copyId,params,ctx,{borrowed=false}={}){
  const owner=player(state,state.turnPlayerId),issue=hammerProblem(state,owner,params,copyId,borrowed);
  requireRule(!issue,issue);
  if(exact(params,['ordinary'])){
    finishHammer(state,owner,params.ordinary,ctx);
    if(borrowed)completePending(state);
    return;
  }
  const data={toolId:copyId,borrowed};
  if(borrowed)Object.assign(state.pending,{kind:'tool',code:REFINING_HAMMER,choice:null,data});
  else createPending(state,{kind:'tool',ownerId:owner.id,code:REFINING_HAMMER,data});
  state.pending.stage='refining';
  setChoice(state,{kind:'hammer-refine',actorId:owner.id,...hammerChoice(owner)});
}
export function chooseHammer(state,selection,ctx){
  const pending=state.pending;
  requireRule(pending?.code===REFINING_HAMMER&&pending.stage==='refining'&&exact(selection,['ordinary']),'请选择百工锤本次精制的货物。');
  finishHammer(state,player(state,pending.ownerId),selection.ordinary,ctx);
  completePending(state);
}
export function hammerPendingProblem(state,pending){
  const owner=player(state,pending.ownerId),{choice,data}=pending;
  const available=owner.refined&&hammerChoice(owner);
  if(!available||state.refiningUsed||pending.stage!=='refining'||pending.response||pending.receipt||pending.poolCards.length
    ||goodsCount(pending.goods)!==0||!exact(data,['toolId','borrowed'])||typeof data.borrowed!=='boolean'
    ||choice?.kind!=='hammer-refine'||choice.actorId!==owner.id||choice.visibility!=='private'
    ||JSON.stringify(choice.options)!==JSON.stringify(available.options)||JSON.stringify(choice.defaultSelection)!==JSON.stringify(available.defaultSelection)
    ||(data.borrowed?pending.sourceCards.length!==1||definition(pending.sourceCards[0]).sourceCode!=='M08'||!state.discard.includes(data.toolId)
      :pending.sourceCards.length!==0||!owner.tools.some(tool=>tool.cardId===data.toolId&&tool.exhausted))
    ||definition(data.toolId).sourceCode!==REFINING_HAMMER)return '保存的百工锤步骤无效。';
  return null;
}

export function refinedEventPremium(event,{refining=false}={}){
  if(!Object.hasOwn(event,'refinedGoods'))return 0;
  const goods=event.refinedGoods;
  if(!refining||!Array.isArray(event.goods)||!Array.isArray(goods)||!goods.length||goods.length>GOODS.length
    ||new Set(goods.map(good=>good?.id)).size!==goods.length
    ||!goods.every(good=>good&&Object.keys(good).length===2&&Object.hasOwn(good,'id')
      &&Object.hasOwn(good,'count')&&Number.isSafeInteger(good.count)&&good.count>0
      &&event.goods.some(used=>used?.id===good.id&&Number.isSafeInteger(used.count)&&used.count>=good.count)))return null;
  return Math.min(4,goods.reduce((sum,good)=>sum+2*good.count,0));
}
