import {addSilver,requireRule} from './model.mjs';
export function toolCost(state,owner,printed,{borrowed=false}={}){
  requireRule(Number.isSafeInteger(printed)&&printed>=0,'道具银两费用无效。');
  const discounted=printed>0&&!borrowed&&owner.id===state.turnPlayerId&&owner.roleId==='yousei.role.r13'&&!state.turnUsage.toolFeeUsed;
  return {silver:Math.max(0,printed-(discounted?1:0)),discounted};
}
export function payToolCost(state,owner,printed,options){
  const quote=toolCost(state,owner,printed,options);addSilver(owner,-quote.silver);
  if(quote.discounted)state.turnUsage.toolFeeUsed=true;return quote.silver;
}
