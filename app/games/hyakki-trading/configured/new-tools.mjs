import {GOODS,CATEGORIES} from '../content/expansion-one.mjs';
import {receiptPlan} from '../trade-contract.mjs';
import {RuleError,requireRule,definition,player,emptyGoods,canReceive,goodsCount,addSilver,moveGoods,removeCard,discardCards,
  createPending,setChoice,completePending,refreshTemporary} from './model.mjs';
import {toolCost,payToolCost} from './tool-cost.mjs';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const good=id=>GOODS.find(g=>g.id===id);
const one=id=>({...emptyGoods(),[id]:1});
export const isNewTool=code=>/^XT(?:0[1-9]|1[0-4])$/u.test(code);
const number=code=>Number(code.slice(2));
const classOf=code=>number(code)<=12?CATEGORIES[(number(code)-1)%6].id:null;
const choicesFor=(state,code)=>GOODS.filter(g=>state.bankGoods[g.id]>0&&g.category===classOf(code)).map(g=>g.id);
const payments=owner=>owner.hand.filter(id=>definition(id).category==='goods');
const targets=state=>state.discard.filter(id=>definition(id).category==='goods');
const exchangeChoices=(state,owner)=>GOODS.filter(g=>owner.goods[g.id]>0).flatMap(from=>GOODS.filter(to=>state.bankGoods[to.id]>0&&to.category!==from.category)
  .map(to=>({ownGoodId:from.id,goodId:to.id})));
const keys=code=>number(code)<=6?[]:number(code)<=12?['goodId']:code==='XT13'?['ownGoodId','goodId']:['payCardId','takeCardId'];
function checkedSelection(state,owner,code,params){
  requireRule(exact(params,keys(code))&&Object.keys(params).length===keys(code).length,'请选齐本次道具所需材料。');
  if(number(code)<=12)requireRule(choicesFor(state,code).includes(params.goodId),'请选择该类尚有库存的货物。');
  else if(code==='XT13')requireRule(exchangeChoices(state,owner).some(x=>same(x,params)),'须用自己的1件货换另一类的1件货。');
  else requireRule(payments(owner).includes(params.payCardId)&&targets(state).includes(params.takeCardId)&&params.payCardId!==params.takeCardId,'请选择手中货物牌及弃牌区另一张货物牌。');
}
export function newToolProblem(state,ownerId,copyId,params={},options={}){
  try{
    const card=definition(copyId),code=card.sourceCode,owner=player(state,ownerId),borrowed=options.borrowed===true;
    requireRule(card.category==='tool'&&isNewTool(code)&&exact(params,keys(code)),'道具参数无效。');
    if(!borrowed&&options.checkOrientation!==false)requireRule(owner.tools.some(t=>t.cardId===copyId&&!t.exhausted),'请选择自己竖直的道具。');
    if(!borrowed)requireRule(state.stage==='use','请先结束摸牌阶段。');
    const fee=toolCost(state,owner,number(code)<=6?0:1,{borrowed}).silver;
    requireRule(owner.silver>=fee,'银两不足以支付道具费用。');
    if(number(code)<=12)requireRule(choicesFor(state,code).length&&canReceive(owner,1,fee),'需要该类货源和足够货位，临时格费另付。');
    if(code==='XT13')requireRule(exchangeChoices(state,owner).length,'没有可换的跨类货物。');
    if(code==='XT14')requireRule(payments(owner).length&&targets(state).length,'需要手中货物牌及弃牌区的货物牌。');
    if(Object.keys(params).length||options.preselected)if(number(code)>6)checkedSelection(state,owner,code,params);
    return null;
  }catch(error){if(error instanceof RuleError||error instanceof RangeError)return error.message;throw error;}
}
function finish(state){completePending(state);}
export function startNewTool(state,copyId,params={},ctx,{borrowed=false}={}){
  const ownerId=borrowed?state.pending.ownerId:state.turnPlayerId,code=definition(copyId).sourceCode;
  const issue=newToolProblem(state,ownerId,copyId,params,{borrowed,checkOrientation:false});requireRule(!issue,issue);
  if(borrowed){
    const p=state.pending;requireRule(p.code==='M08'&&!p.poolCards.length&&!goodsCount(p.goods),'借用来源无效。');
    p.kind='tool';p.code=code;p.stage='start';p.choice=null;p.response=null;p.receipt=null;p.data={toolId:copyId,borrowed:true,params:structuredClone(params)};
  }else createPending(state,{kind:'tool',ownerId,code,data:{toolId:copyId,borrowed:false,params:structuredClone(params)}});
  continueNewTool(state,ctx);
  if(state.pending?.kind==='tool'&&state.pending.code===code&&Object.keys(params).length)chooseNewTool(state,params,ctx);
}
export function continueNewTool(state,ctx){
  const p=state.pending;if(p.choice||p.receipt||p.response)return;
  const owner=player(state,p.ownerId),code=p.code;
  if(number(code)<=6){
    const available=choicesFor(state,code),at=available.length===1?0:ctx.randomInt(available.length);
    requireRule(Number.isSafeInteger(at)&&at>=0&&at<available.length,'道具随机结果无效。');
    const id=available[at],plan=receiptPlan(owner,state.bankGoods,{receive:one(id)});addSilver(owner,-plan.temporaryFee);
    owner.goods=plan.goods;owner.temporaryOccupied=plan.temporaryOccupied;state.bankGoods=plan.bankGoods;finish(state);return;
  }
  p.stage='choosing';
  if(number(code)<=12){const options=choicesFor(state,code).map(goodId=>({goodId}));setChoice(state,{kind:'tool-class-good',actorId:owner.id,visibility:'public',options,defaultSelection:options[0]});}
  else if(code==='XT13'){const options=exchangeChoices(state,owner);setChoice(state,{kind:'tool-class-exchange',actorId:owner.id,visibility:'public',options,defaultSelection:options[0]});}
  else setChoice(state,{kind:'tool-goods-card-swap',actorId:owner.id,options:[{payments:payments(owner),targets:targets(state)}],
    defaultSelection:{payCardId:payments(owner)[0],takeCardId:targets(state)[0]}});
}
export function chooseNewTool(state,selection){
  const p=state.pending,owner=player(state,p.ownerId),code=p.code;
  requireRule(p.kind==='tool'&&p.stage==='choosing'&&p.choice?.actorId===owner.id,'没有当前道具选择。');
  checkedSelection(state,owner,code,selection);
  const cost=toolCost(state,owner,1,{borrowed:p.data.borrowed}).silver;
  if(number(code)<=12||code==='XT13'){
    const give=code==='XT13'?one(selection.ownGoodId):{},receive=one(selection.goodId);
    const plan=receiptPlan(owner,state.bankGoods,{give,receive,cost});payToolCost(state,owner,1,{borrowed:p.data.borrowed});addSilver(owner,-plan.temporaryFee);
    owner.goods=plan.goods;owner.temporaryOccupied=plan.temporaryOccupied;state.bankGoods=plan.bankGoods;
  }else{
    payToolCost(state,owner,1,{borrowed:p.data.borrowed});removeCard(state.discard,selection.takeCardId);
    removeCard(owner.hand,selection.payCardId);discardCards(state,[selection.payCardId]);owner.hand.push(selection.takeCardId);
  }
  p.choice=null;finish(state);
}
export function newToolPendingProblem(state,p){
  try{
    const owner=player(state,p.ownerId),code=p.code;
    requireRule(isNewTool(code)&&number(code)>6&&p.stage==='choosing'&&!p.poolCards.length&&!goodsCount(p.goods)&&p.response===null&&p.receipt===null
      &&exact(p.data,['toolId','borrowed','params'])&&Object.keys(p.data).length===3&&typeof p.data.borrowed==='boolean'
      &&definition(p.data.toolId).sourceCode===code&&exact(p.data.params,keys(code))&&Object.keys(p.data.params).length===0,'道具保存步骤无效。');
    requireRule(p.data.borrowed?p.sourceCards.length===1&&definition(p.sourceCards[0]).sourceCode==='M08'&&state.discard.includes(p.data.toolId)
      :p.sourceCards.length===0&&owner.tools.some(t=>t.cardId===p.data.toolId&&t.exhausted),'道具来源或朝向无效。');
    const c=p.choice;requireRule(c?.actorId===owner.id&&newToolProblem(state,owner.id,p.data.toolId,{}, {borrowed:p.data.borrowed,checkOrientation:false})===null,'道具选择者或材料已无效。');
    if(number(code)<=12)requireRule(c.kind==='tool-class-good'&&c.visibility==='public'&&same(c.options,choicesFor(state,code).map(goodId=>({goodId})))&&c.options.some(o=>same(o,c.defaultSelection)),'类别道具候选无效。');
    else if(code==='XT13')requireRule(c.kind==='tool-class-exchange'&&c.visibility==='public'&&same(c.options,exchangeChoices(state,owner))&&c.options.some(o=>same(o,c.defaultSelection)),'换货道具候选无效。');
    else{requireRule(c.kind==='tool-goods-card-swap'&&c.visibility==='private'&&same(c.options,[{payments:payments(owner),targets:targets(state)}]),'换牌道具候选无效。');checkedSelection(state,owner,code,c.defaultSelection);}
    return null;
  }catch(error){if(error instanceof RuleError||error instanceof RangeError||error instanceof TypeError)return '保存的新道具步骤无效。';throw error;}
}
