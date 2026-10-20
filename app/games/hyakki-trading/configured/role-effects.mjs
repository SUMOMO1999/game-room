import {getRole,GOODS,CATEGORIES} from '../content/expansion-one.mjs';
import {requireRule,player,opponent,goodsCount,createPending,completePending,legalResponseCards,setChoice,
  drawCards,availableCards,removeCard,discardCards,addSilver,emit,emptyGoods,definition,canReceive,moveGoods,refreshTemporary} from './model.mjs';
import {goodsVector,categoryCounts,receiptPlan} from '../trade-contract.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const subset=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
const active=['R09','R14','R16','R17','R18','R20','R22','R23','R24'];
const good=id=>GOODS.find(g=>g.id===id),one=id=>({...emptyGoods(),[id]:1});
const optionsGoods=(state,cat)=>GOODS.filter(g=>state.bankGoods[g.id]>0&&(!cat||g.category===cat)).map(g=>g.id);
const recoverable=state=>state.discard.filter(id=>definition(id).category==='tool');
const resetTools=owner=>owner.tools.filter(t=>t.exhausted).map(t=>t.cardId);
function exchangeDefault(state,owner){
  for(const from of GOODS)if(owner.goods[from.id]>0)for(const to of GOODS)if(to.id!==from.id&&to.category===from.category&&state.bankGoods[to.id]>0)
    return {give:one(from.id),receive:one(to.id)};
  return null;
}
function checkedExchange(state,owner,selection){
  requireRule(exact(selection,['give','receive']),'请选择同类交换的具体货物。');
  const give=goodsVector(selection.give),receive=goodsVector(selection.receive),a=Object.keys(categoryCounts(give)),b=Object.keys(categoryCounts(receive)),n=goodsCount(give);
  requireRule(n>=1&&n<=2&&goodsCount(receive)===n&&a.length===1&&b.length===1&&a[0]===b[0]
    &&GOODS.some(g=>give[g.id]!==receive[g.id]),'须交换同类等量1～2件，并改变至少一种货的数量。');
  return receiptPlan(owner,state.bankGoods,{give,receive});
}
const paramsKeys=code=>['R23','R24'].includes(code)?['targetId']:code==='R09'?['give','receive']:code==='R14'?['cardId']
  :code==='R17'?['categoryId']:['R18','R20'].includes(code)?['goodId']:code==='R22'?['cardId','toolCardId']:[];
export const roleActionCost=state=>getRole(player(state,state.turnPlayerId).roleId).sourceCode==='R22'?0:1;
export function roleProblem(state,actorId,params={}){
  const owner=player(state,actorId),code=getRole(owner.roleId).sourceCode;
  if(!active.includes(code))return '此角色没有当前可发动的能力。';
  if(!subset(params,paramsKeys(code)))return '角色选择参数无效。';
  if(state.turnUsage.roleUsed)return '本回合已使用过角色能力。';
  if(['R23','R24'].includes(code)){
    if(state.turnUsage.monitorUsed)return '本回合已使用过【监】。';
    if(!exact(params,['targetId']))return '请选择一名对手。';
    const peer=opponent(state,actorId,params.targetId);
    if(peer.silver<2||code==='R23'&&peer.silver<owner.silver||code==='R24'&&goodsCount(peer.goods)<3)return '这名对手不满足收税条件。';
    if(!Number.isSafeInteger(owner.silver+2))return '银两超出可保存范围。';
  }
  if(code==='R09'){
    if(!exchangeDefault(state,owner))return '需要自己的库存及同类其他货种。';
    if(Object.keys(params).length)checkedExchange(state,owner,params);
  }
  if(code==='R14'&&(owner.silver<1||!recoverable(state).length||params.cardId!==undefined&&!recoverable(state).includes(params.cardId)))return '需要1两及弃牌区的道具。';
  if(code==='R16'&&(!optionsGoods(state).length||!canReceive(owner,1)))return '没有货源或可负担的货位。';
  if(code==='R17'&&(!exact(params,['categoryId'])||!CATEGORIES.some(c=>c.id===params.categoryId)||!optionsGoods(state,params.categoryId).length||!canReceive(owner,1,1)))return '请选择有货的一类，并留出1两和货位。';
  if(code==='R18'&&(!optionsGoods(state).length||!canReceive(owner,1,2)||params.goodId!==undefined&&!optionsGoods(state).includes(params.goodId)))return '需要2两、货源和可负担的货位。';
  if(code==='R20'&&(!goodsCount(owner.goods)||!Number.isSafeInteger(owner.silver+2)||params.goodId!==undefined&&!(owner.goods[params.goodId]>0)))return '需要自己的1件货物。';
  if(code==='R22'&&(state.actionsUsed>=state.actionLimit||!owner.hand.length||!resetTools(owner).length
    ||Object.keys(params).length&&(!exact(params,['cardId','toolCardId'])||!owner.hand.includes(params.cardId)||!resetTools(owner).includes(params.toolCardId))))return '须保留至少1行动，弃1手牌并选择自己横置的道具。';
  return null;
}
export function beginRole(state,actorId,params={},ctx){
  const issue=roleProblem(state,actorId,params);requireRule(!issue,issue);
  const owner=player(state,actorId),code=getRole(owner.roleId).sourceCode;
  state.turnUsage.roleUsed=true;
  if(['R23','R24'].includes(code)){
    state.turnUsage.monitorUsed=true;createPending(state,{kind:'role',ownerId:actorId,code,data:{targetId:params.targetId}});
    emit(state,{type:'role-used',actorSeatId:actorId,roleId:owner.roleId,targetSeatId:params.targetId});
    state.pending.response={kind:'counter',actorId:params.targetId,tradeCardId:null};
    if(legalResponseCards(state).length)return;state.pending.response=null;
  }else{createPending(state,{kind:'role',ownerId:actorId,code});emit(state,{type:'role-used',actorSeatId:actorId,roleId:owner.roleId});}
  continueRole(state,ctx,params);
  if(state.pending?.kind==='role'&&state.pending.code===code&&Object.keys(params).length&&state.pending.choice)chooseRole(state,params,ctx);
}
export function compensateMonitorLoss(state,before,sourceOwnerId){
  for(const owner of state.players)if(owner.id!==sourceOwnerId&&owner.roleId==='yousei.role.r21'
    &&owner.roleState.compensationAvailable&&owner.silver<before[owner.id]){
    addSilver(owner,1);owner.roleState.compensationAvailable=false;
    emit(state,{type:'role-triggered',actorSeatId:owner.id,roleId:owner.roleId,silver:1});
  }
}
export function continueRole(state,ctx={},params={}){
  const pending=state.pending;requireRule(pending?.kind==='role','没有当前角色效果。');
  if(pending.response||pending.choice||pending.receipt)return;
  const owner=player(state,pending.ownerId);
  if(['R23','R24'].includes(pending.code)){
    const peer=opponent(state,owner.id,pending.data.targetId),before=Object.fromEntries(state.players.map(p=>[p.id,p.silver]));
    addSilver(peer,-2);addSilver(owner,2);compensateMonitorLoss(state,before,owner.id);completePending(state);return;
  }
  if(pending.code==='R16'||pending.code==='R17'){
    const available=optionsGoods(state,pending.code==='R17'?params.categoryId:null),at=available.length===1?0:ctx.randomInt(available.length);
    requireRule(Number.isSafeInteger(at)&&at>=0&&at<available.length,'角色随机结果无效。');
    const fee=pending.code==='R17'?1:0,plan=receiptPlan(owner,state.bankGoods,{receive:one(available[at]),cost:fee});
    addSilver(owner,-fee-plan.temporaryFee);owner.goods=plan.goods;owner.temporaryOccupied=plan.temporaryOccupied;state.bankGoods=plan.bankGoods;
    completePending(state);return;
  }
  if(pending.code==='R09')setChoice(state,{kind:'role-class-exchange',actorId:owner.id,visibility:'public',options:[{ownGoods:{...owner.goods},bankGoods:{...state.bankGoods},minimum:1,maximum:2}],defaultSelection:exchangeDefault(state,owner)});
  else if(pending.code==='R14')setChoice(state,{kind:'role-recover-tool',actorId:owner.id,visibility:'public',options:recoverable(state).map(cardId=>({cardId})),defaultSelection:{cardId:recoverable(state)[0]}});
  else if(pending.code==='R18'||pending.code==='R20'){
    const choices=pending.code==='R18'?optionsGoods(state):GOODS.filter(g=>owner.goods[g.id]>0).map(g=>g.id),options=choices.map(goodId=>({goodId}));
    setChoice(state,{kind:'role-good',actorId:owner.id,visibility:'public',options,defaultSelection:options[0]});
  }else if(pending.code==='R22')setChoice(state,{kind:'role-reset-tool',actorId:owner.id,options:[{payments:[...owner.hand],tools:resetTools(owner)}],defaultSelection:{cardId:owner.hand[0],toolCardId:resetTools(owner)[0]}});
  else requireRule(false,'角色步骤无效。');
}
/** A successful trade schedules this after source disposal/merchant response.
 * The new private card joins the hand before the forced discard decision. */
export function beginAfterActions(state,ctx){
  requireRule(!state.pending&&state.afterActions.length,'没有待完成的交易后义务。');
  const job=state.afterActions.shift();
  requireRule(job.kind==='accountant-draw-discard'&&player(state,job.playerId).roleId==='yousei.role.r11','交易后义务无效。');
  if(!availableCards(state))return;
  const owner=player(state,job.playerId),[card]=drawCards(state,1,ctx);owner.hand.push(card);
  createPending(state,{kind:'role',ownerId:owner.id,code:'R11'});
  state.pending.stage='discard';
  setChoice(state,{kind:'accountant-discard',actorId:owner.id,options:owner.hand.map(cardId=>({cardId})),defaultSelection:{cardId:owner.hand[0]}});
  emit(state,{type:'role-triggered',actorSeatId:owner.id,roleId:owner.roleId});
}
export function chooseRole(state,selection){
  const p=state.pending,owner=player(state,p?.ownerId);
  requireRule(p?.kind==='role'&&p.choice&&!p.response&&!p.receipt,'没有当前角色选择。');
  if(p.code==='R11'){
    requireRule(p.stage==='discard'&&p.choice.kind==='accountant-discard'&&exact(selection,['cardId'])&&owner.hand.includes(selection.cardId),'请选择自己要弃的1张手牌。');
    removeCard(owner.hand,selection.cardId);discardCards(state,[selection.cardId]);
  }else if(p.code==='R09'){
    const plan=checkedExchange(state,owner,selection);addSilver(owner,-plan.temporaryFee);owner.goods=plan.goods;owner.temporaryOccupied=plan.temporaryOccupied;state.bankGoods=plan.bankGoods;
  }else if(p.code==='R14'){
    requireRule(exact(selection,['cardId'])&&recoverable(state).includes(selection.cardId),'请选择弃牌区道具。');
    addSilver(owner,-1);removeCard(state.discard,selection.cardId);owner.hand.push(selection.cardId);
  }else if(['R18','R20'].includes(p.code)){
    requireRule(exact(selection,['goodId'])&&p.choice.options.some(x=>x.goodId===selection.goodId),'请选择当前可用的1件货物。');
    if(p.code==='R18'){
      const plan=receiptPlan(owner,state.bankGoods,{receive:one(selection.goodId),cost:2});addSilver(owner,-2-plan.temporaryFee);
      owner.goods=plan.goods;owner.temporaryOccupied=plan.temporaryOccupied;state.bankGoods=plan.bankGoods;
    }else{moveGoods(owner.goods,state.bankGoods,one(selection.goodId));refreshTemporary(owner);addSilver(owner,2);}
  }else if(p.code==='R22'){
    requireRule(exact(selection,['cardId','toolCardId'])&&owner.hand.includes(selection.cardId)&&resetTools(owner).includes(selection.toolCardId),'请选择手牌与自己的横置道具。');
    removeCard(owner.hand,selection.cardId);discardCards(state,[selection.cardId]);owner.tools.find(t=>t.cardId===selection.toolCardId).exhausted=false;
  }else requireRule(false,'角色选择无效。');
  p.choice=null;completePending(state);
}
export function activeRolePendingProblem(state,p){
  try{
    const owner=player(state,p.ownerId),c=p.choice,same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    requireRule(active.includes(p.code)&&!['R23','R24'].includes(p.code)&&p.stage==='start'&&exact(p.data,[])
      &&p.response===null&&c?.actorId===owner.id&&state.turnUsage.roleUsed,'角色待决归属无效。');
    if(p.code==='R09'){
      requireRule(c.kind==='role-class-exchange'&&c.visibility==='public'&&same(c.options,[{ownGoods:{...owner.goods},bankGoods:{...state.bankGoods},minimum:1,maximum:2}]),'角色换货候选无效。');
      checkedExchange(state,owner,c.defaultSelection);
    }else if(p.code==='R14')requireRule(owner.silver>=1&&c.kind==='role-recover-tool'&&c.visibility==='public'
      &&same(c.options,recoverable(state).map(cardId=>({cardId})))&&c.options.some(o=>same(o,c.defaultSelection)),'角色取回道具候选无效。');
    else if(['R18','R20'].includes(p.code)){
      const choices=p.code==='R18'?optionsGoods(state):GOODS.filter(g=>owner.goods[g.id]>0).map(g=>g.id);
      requireRule(c.kind==='role-good'&&c.visibility==='public'&&same(c.options,choices.map(goodId=>({goodId})))&&c.options.some(o=>same(o,c.defaultSelection))
        &&(p.code==='R18'?canReceive(owner,1,2):Number.isSafeInteger(owner.silver+2)),'角色收货或交货候选无效。');
    }else if(p.code==='R22')requireRule(state.actionsUsed<state.actionLimit&&c.kind==='role-reset-tool'&&c.visibility==='private'
      &&same(c.options,[{payments:[...owner.hand],tools:resetTools(owner)}])&&exact(c.defaultSelection,['cardId','toolCardId'])
      &&owner.hand.includes(c.defaultSelection.cardId)&&resetTools(owner).includes(c.defaultSelection.toolCardId),'调器师候选无效。');
    else requireRule(false,'随机角色不能保存未抽取的步骤。');
    return null;
  }catch{return '保存的主动角色步骤无效。';}
}
