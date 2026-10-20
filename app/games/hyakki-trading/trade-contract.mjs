import {GOODS,getRole,getExpansionCard} from './content/expansion-one.mjs';

// These functions own materials, price, capacity and per-turn trade accounting.
// The rules caller still owns phase/action/source-card fences and merchant
// responses. A quote is never accepted back from the client as settlement input.
const goodsById=new Map(GOODS.map(good=>[good.id,good]));
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const check=(condition,message)=>{if(!condition)throw new RangeError(message);};
const copy=value=>structuredClone(value);
const flags=['specialistBuy','specialistSell','saleBonus','accountant','paidBuy','sold','turnoverReward'];
export const newTradeUsage=()=>Object.fromEntries([...flags.map(flag=>[flag,false]),['goodsBuys',0]]);
export function tradeUsageProblem(usage){
  return !record(usage)||Object.keys(usage).length!==flags.length+1
    ||Object.keys(usage).some(key=>![...flags,'goodsBuys'].includes(key))
    ||flags.some(key=>typeof usage[key]!=='boolean')||!integer(usage.goodsBuys)
    ||(usage.specialistBuy||usage.paidBuy)&&usage.goodsBuys===0
    ||(usage.specialistSell||usage.saleBonus)&&!usage.sold
    ||usage.turnoverReward&&!(usage.paidBuy&&usage.sold)
    ||usage.accountant&&!(usage.goodsBuys>0||usage.sold)
    ?'本回合交易记录无效。':null;
}
export function goodsVector(value,{complete=false}={}){
  check(record(value)&&Object.keys(value).every(id=>goodsById.has(id))
    &&Object.values(value).every(count=>integer(count,0,20)),'货物须为本包已知品种和有效件数。');
  check(!complete||Object.keys(value).length===GOODS.length,'货物向量须包含本局十二种货物。');
  return Object.fromEntries(GOODS.map(good=>[good.id,value[good.id]??0]));
}
export const countGoods=vector=>Object.values(vector).reduce((sum,count)=>sum+count,0);
export function categoryCounts(vector){
  const result={};
  for(const [id,count] of Object.entries(goodsVector(vector)))if(count){
    const category=goodsById.get(id).category;result[category]=(result[category]??0)+count;
  }
  return result;
}
export function resolveTradeMaterials(definitionId,selection,{broker=false}={}){
  check(typeof broker==='boolean','买办交易标记无效。');
  const card=getExpansionCard(definitionId);check(card.category==='goods','交易来源须为货物牌。');
  check(!broker||card.recipe.count===3,'买办只能配三件货物牌。');
  const vector=goodsVector(selection===undefined&&card.recipe.type==='fixed'?card.recipe.goods:selection);
  const count=countGoods(vector),categories=categoryCounts(vector),recipe=card.recipe;
  check(count===recipe.count,'本次具体货物件数与配方不符。');
  if(broker)return vector;
  let valid=false;
  switch(recipe.type){
    case 'fixed':valid=GOODS.every(good=>vector[good.id]===(recipe.goods[good.id]??0));break;
    case 'class':valid=categories[recipe.category]===count;break;
    case 'mixed':valid=categories[recipe.category]===recipe.primaryCount&&count-recipe.primaryCount===recipe.otherCount;break;
    case 'distinct':valid=Object.keys(categories).length===count;break;
    case 'any':valid=true;break;
  }
  check(valid,'所选货物不满足本牌配方的种类或类别要求。');return vector;
}
export function ordinaryCapacity(owner){
  check(integer(owner.stallCount,0,5),'摊位扩展数量无效。');
  return 5+3*owner.stallCount+(getRole(owner.roleId).sourceCode==='R10'?1:0);
}
function ownerProblem(owner){
  check(record(owner)&&integer(owner.silver)&&typeof owner.temporaryOccupied==='boolean','玩家钱货状态无效。');
  const goods=goodsVector(owner.goods,{complete:true}),capacity=ordinaryCapacity(owner);
  check(countGoods(goods)<=capacity+1&&owner.temporaryOccupied===(countGoods(goods)>capacity),'当前货位占用无效。');
  return goods;
}
/** Net exchange and all receipts share the same final-capacity rule. */
export function receiptPlan(owner,bankGoods,{give={},receive={},cost=0}={}){
  const before=ownerProblem(owner),bank=goodsVector(bankGoods,{complete:true});
  const outgoing=goodsVector(give),incoming=goodsVector(receive);check(integer(cost),'费用无效。');
  const after={},bankAfter={};
  for(const {id} of GOODS){
    check(before[id]>=outgoing[id],'自己的货物不足。');
    check(bank[id]+outgoing[id]>=incoming[id],'公共货物不足。');
    after[id]=before[id]-outgoing[id]+incoming[id];bankAfter[id]=bank[id]+outgoing[id]-incoming[id];
    check(integer(after[id],0,20)&&integer(bankAfter[id],0,20),'货物数量超出本局可保存范围。');
  }
  const ordinary=ordinaryCapacity(owner),count=countGoods(after);
  check(count<=ordinary+1,'没有足够的货位。');
  const temporaryOccupied=count>ordinary,temporaryFee=temporaryOccupied&&!owner.temporaryOccupied?2:0;
  check(integer(cost+temporaryFee)&&owner.silver>=cost+temporaryFee,'银两不足以支付本笔费用与临时格费。');
  return {goods:after,bankGoods:bankAfter,temporaryOccupied,temporaryFee};
}
export function quoteGoodsTrade({owner,bankGoods,usage,bookLayers,definitionId,direction,materials,broker=false}){
  check(['buy','sell'].includes(direction)&&(!broker||direction==='sell'),'交易方向无效。');
  check(!tradeUsageProblem(usage)&&integer(bookLayers)&&integer(2*bookLayers),'交易修正状态无效。');
  ownerProblem(owner);
  const role=getRole(owner.roleId),card=getExpansionCard(definitionId);
  const goods=resolveTradeMaterials(definitionId,materials,{broker}),categories=categoryCounts(goods);
  check(direction!=='buy'||role.sourceCode!=='R24'||usage.goodsBuys===0,'本回合已经完成一次货物牌买入。');
  const buying=direction==='buy',printed=buying?card.buySilver:card.sellSilver;
  const bookPrice=buying?Math.max(0,printed-2*bookLayers):printed+2*bookLayers;
  check(integer(bookPrice),'书算修正超出可保存范围。');
  let roleAdjustment=0,usedFlag=null;
  if(role.category&&(categories[role.category]??0)>=2){
    const flag=buying?'specialistBuy':'specialistSell';
    if(!usage[flag]&&(!buying||bookPrice>0)){roleAdjustment=buying?-1:1;usedFlag=flag;}
  }else if(!buying&&!usage.saleBonus){
    if(role.sourceCode==='R07'&&Object.keys(categories).length>=3){roleAdjustment=3;usedFlag='saleBonus';}
    if(role.sourceCode==='R08'&&countGoods(goods)===3&&Object.values(goods).filter(n=>n>0).length===1){roleAdjustment=2;usedFlag='saleBonus';}
  }
  const goodsPrice=bookPrice+roleAdjustment,buyTax=buying&&role.sourceCode==='R23'?1:0;
  check(integer(goodsPrice)&&integer(goodsPrice+buyTax),'交易价格超出可保存范围。');
  const plan=receiptPlan(owner,bankGoods,{give:buying?{}:goods,receive:buying?goods:{},cost:buying?goodsPrice+buyTax:0});
  const totalPayment=buying?goodsPrice+buyTax+plan.temporaryFee:0;
  check(integer(owner.silver+(buying?-totalPayment:goodsPrice)),'交易银两超出可保存范围。');
  return {definitionId,direction,broker,goods,printedPrice:printed,bookLayers,roleAdjustment,usedFlag,
    goodsPrice,buyTax,temporaryFee:plan.temporaryFee,totalPayment,saleProceeds:buying?0:goodsPrice};
}
/** Returns a new economic fragment and deferred obligations; never mutates inputs.
 * R11 must run after merchant responses/source disposition, before turn-end.
 * Source ownership and consumption are committed by the enclosing rules command.
 */
export function settleGoodsTrade(input){
  const quote=quoteGoodsTrade(input),owner=copy(input.owner),usage=copy(input.usage),buying=quote.direction==='buy';
  const plan=receiptPlan(owner,input.bankGoods,{give:buying?{}:quote.goods,receive:buying?quote.goods:{},cost:buying?quote.goodsPrice+quote.buyTax:0});
  Object.assign(owner,{silver:owner.silver+(buying?-quote.totalPayment:quote.saleProceeds),goods:plan.goods,temporaryOccupied:plan.temporaryOccupied});
  if(quote.usedFlag)usage[quote.usedFlag]=true;
  if(buying){usage.goodsBuys++;usage.paidBuy||=quote.goodsPrice>0;}else usage.sold=true;
  check(integer(usage.goodsBuys),'交易次数超出可保存范围。');
  const role=getRole(owner.roleId),accountant=role.sourceCode==='R11'&&!usage.accountant;
  if(accountant)usage.accountant=true;
  const turnoverReward=role.sourceCode==='R19'&&usage.paidBuy&&usage.sold&&!usage.turnoverReward?1:0;
  if(turnoverReward){check(integer(owner.silver+1),'周转奖励超出可保存范围。');owner.silver++;usage.turnoverReward=true;}
  return {owner,bankGoods:plan.bankGoods,usage,quote,bankSilverDelta:(buying?quote.totalPayment: -quote.saleProceeds)-turnoverReward,
    turnoverReward,afterSourceSettled:accountant?{kind:'accountant-draw-discard',playerId:owner.id}:null};
}
