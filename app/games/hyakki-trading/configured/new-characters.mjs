import {GOODS,CATEGORIES} from '../content/expansion-one.mjs';
import {goodsVector as vectorOf,receiptPlan,categoryCounts} from '../trade-contract.mjs';
import {RuleError,requireRule,definition,player,opponent,emptyGoods,goodsCount,addSilver,moveGoods,removeCard,discardCards,
  drawCards,availableCards,refreshTemporary,createPending,setChoice,clearChoice,completePending,receiveGoods,legalResponseCards,emit} from './model.mjs';
import {compensateMonitorLoss} from './role-effects.mjs';

const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const category=id=>CATEGORIES.some(c=>c.id===id);
const inClass=(id,cat)=>GOODS.some(g=>g.id===id&&g.category===cat);
const totalClass=(stock,cat)=>GOODS.filter(g=>g.category===cat).reduce((n,g)=>n+stock[g.id],0);
const stocked=stock=>GOODS.filter(g=>stock[g.id]>0).map(g=>g.id);
const codeOf=id=>definition(id).sourceCode;
const counter=id=>/^XM0[1-6]$/u.test(id);
const choices={XC01:'class-procure',XC02:'class-procure',XC03:'class-procure',XC04:'class-procure',XC05:'class-procure',XC06:'class-procure',
  XC08:'class-exchange',XC10:'recover-guard',XC11:'class-surrender'};
const categoryFor=code=>/^XC0[1-6]$/u.test(code)?CATEGORIES[Number(code.slice(2))-1].id:null;
const firstVector=(stock,count,cat)=>{
  const v=emptyGoods();for(const g of GOODS){if(cat&&!inClass(g.id,cat))continue;v[g.id]=Math.min(count,stock[g.id]);count-=v[g.id];}return v;
};
function checkedVector(value,stock,count,{cat,maximum=count}={}){
  const v=vectorOf(value);requireRule(goodsCount(v)>=count&&goodsCount(v)<=maximum&&GOODS.every(g=>v[g.id]<=stock[g.id]&&(!cat||!v[g.id]||inClass(g.id,cat))),'所选货物不符合数量、类别或库存。');return v;
}
function exchange(state,owner,selection){
  requireRule(exact(selection,['give','receive'])&&Object.keys(selection).length===2,'请选择交出和换入的货物。');
  const give=checkedVector(selection.give,owner.goods,2),receive=checkedVector(selection.receive,state.bankGoods,2);
  const own=Object.keys(categoryCounts(give)),incoming=Object.keys(categoryCounts(receive));
  requireRule(own.length===1&&incoming.length===1&&own[0]!==incoming[0],'须用同一类的2件货换另一类的2件货。');
  const plan=receiptPlan(owner,state.bankGoods,{give,receive,cost:1});return {give,receive,plan};
}
function defaultExchange(state,owner){
  for(const from of CATEGORIES)if(totalClass(owner.goods,from.id)>=2)for(const to of CATEGORIES)if(to.id!==from.id&&totalClass(state.bankGoods,to.id)>=2)
    return {give:firstVector(owner.goods,2,from.id),receive:firstVector(state.bankGoods,2,to.id)};
  return null;
}
const guards=state=>state.discard.filter(id=>codeOf(id)==='C07');
const inputKeys=code=>counter(code)?['targetId',...(['XM05','XM06'].includes(code)?['categoryId']:[])]
  :categoryFor(code)||code==='XC11'?['goods']:code==='XC07'?['categoryId']:code==='XC08'?['give','receive']:code==='XC10'?['cardId']:[];
export const isNewCharacter=code=>/^XC(?:0[1-9]|1[01])$/u.test(code)||counter(code);
export function newCharacterProblem(state,actorId,copyId,params={}){
  try{
    const code=codeOf(copyId),owner=player(state,actorId);requireRule(isNewCharacter(code)&&exact(params,inputKeys(code)),'新人物选择参数无效。');
    const cat=categoryFor(code),peer=counter(code)?opponent(state,actorId,params.targetId):null;
    if(cat){requireRule(owner.silver>=2&&totalClass(state.bankGoods,cat)>=2,'需要2两及该类至少2件公货。');if(params.goods!==undefined)checkedVector(params.goods,state.bankGoods,2,{cat});}
    if(code==='XC07')requireRule(owner.silver>=1&&category(params.categoryId)&&totalClass(state.bankGoods,params.categoryId)>=2,'请选择至少有2件公货的一类，并支付1两。');
    if(code==='XC08'){
      requireRule(owner.silver>=1&&defaultExchange(state,owner),'需要1两和能换出的同类2件货。');
      if(params.give!==undefined||params.receive!==undefined)exchange(state,owner,params);
    }
    if(code==='XC09')requireRule(availableCards(state)>0,'没有可翻的牌。');
    if(code==='XC10')requireRule(guards(state).length&&(params.cardId===undefined||guards(state).includes(params.cardId)),'弃牌区没有可取回的锦衣卫。');
    if(code==='XC11'){
      requireRule(goodsCount(owner.goods)>0,'至少需要自己的1件货物。');
      if(params.goods!==undefined){const v=checkedVector(params.goods,owner.goods,1,{maximum:3});requireRule(Object.keys(categoryCounts(v)).length===1,'交出的货物必须同类。');
        requireRule(Number.isSafeInteger(owner.silver+2*goodsCount(v)+(stocked(v).length===2?1:0)),'银两超出可保存范围。');}
    }
    if(code==='XM01')requireRule(peer.silver>=1&&Number.isSafeInteger(owner.silver+Math.min(2,peer.silver)),'对手须有银两。');
    if(code==='XM02')requireRule(peer.silver-owner.silver>=6&&Number.isSafeInteger(owner.silver+3),'对手须至少比你多6两。');
    if(code==='XM03')requireRule(peer.silver>=2||goodsCount(peer.goods)>0,'对手无银两或货物可交。');
    if(code==='XM04')requireRule(owner.silver>=2&&peer.silver>=1,'你须有2两，对手须有银两。');
    if(['XM05','XM06'].includes(code))requireRule(category(params.categoryId)&&totalClass(peer.goods,params.categoryId)>0
      &&(code!=='XM05'||owner.silver>=1)&& (code!=='XM06'||Number.isSafeInteger(peer.silver+2)&&Number.isSafeInteger(owner.silver+1)),
      '请选择对手有库存的一类，并满足费用。');
    return null;
  }catch(error){if(error instanceof RangeError||error instanceof RuleError)return error.message;throw error;}
}
function offer(state,kind,actorId,options,defaultSelection,visibility='public'){
  setChoice(state,{kind,actorId,options,defaultSelection,visibility});
}
function deliver(state,actorId,goods){
  moveGoods(state.bankGoods,state.pending.goods,goods);state.pending.stage='done';receiveGoods(state,actorId,goods);
  if(!state.pending.receipt)completePending(state);
}
function randomGoods(state,cat,count,ctx){
  const v=emptyGoods();for(let i=0;i<count;i++){
    const choices=GOODS.filter(g=>(!cat||g.category===cat)&&state.bankGoods[g.id]-v[g.id]>0).map(g=>g.id);
    requireRule(choices.length>0,'随机货源已不足。');const at=choices.length===1?0:ctx.randomInt(choices.length);
    requireRule(Number.isSafeInteger(at)&&at>=0&&at<choices.length,'随机结果无效。');v[choices[at]]++;
  }return v;
}
export function startNewCharacter(state,copyId,params={},ctx){
  const issue=newCharacterProblem(state,state.turnPlayerId,copyId,params);requireRule(!issue,issue);
  const code=codeOf(copyId),ownerId=state.turnPlayerId;
  createPending(state,{kind:'character',ownerId,code,sourceCards:[copyId],data:{params:structuredClone(params),paid:false}});
  if(counter(code)){
    state.pending.data.targetId=opponent(state,ownerId,params.targetId).id;
    state.pending.response={kind:'counter',actorId:state.pending.data.targetId,tradeCardId:null};
    if(legalResponseCards(state).length)return;state.pending.response=null;
  }
  continueNewCharacter(state,ctx);
  const p=state.pending,kind=choices[code];
  if(p?.choice?.actorId===ownerId&&p.choice.kind===kind&&Object.keys(params).length)chooseNewCharacter(state,params,ctx);
}
export function continueNewCharacter(state,ctx){
  const p=state.pending;if(p.response||p.choice||p.receipt)return;
  const owner=player(state,p.ownerId),code=p.code,params=p.data.params,cat=categoryFor(code),peer=counter(code)?opponent(state,owner.id,p.data.targetId):null;
  if(p.stage==='done'){completePending(state);return;}
  if(cat){offer(state,'class-procure',owner.id,[{goods:{...state.bankGoods},categoryId:cat,count:2}],{goods:firstVector(state.bankGoods,2,cat)});return;}
  if(code==='XC07'){addSilver(owner,-1);p.data.paid=true;deliver(state,owner.id,randomGoods(state,params.categoryId,2,ctx));return;}
  if(code==='XC08'){offer(state,'class-exchange',owner.id,[{ownGoods:{...owner.goods},bankGoods:{...state.bankGoods},count:2}],defaultExchange(state,owner));return;}
  if(code==='XC09'){
    let found=0;for(let i=0;i<5&&availableCards(state)>0&&found<2;i++){
      const [card]=drawCards(state,1,ctx);p.poolCards.push(card);if(definition(card).category==='goods')found++;
    }
    emit(state,{type:'search-revealed',actorSeatId:owner.id,cardIds:p.poolCards.map(id=>definition(id).id)});
    for(const card of p.poolCards.splice(0))if(definition(card).category==='goods')owner.hand.push(card);else discardCards(state,[card]);
    completePending(state);return;
  }
  if(code==='XC10'){offer(state,'recover-guard',owner.id,guards(state).map(cardId=>({cardId})),{cardId:guards(state)[0]});return;}
  if(code==='XC11'){const first=stocked(owner.goods)[0];offer(state,'class-surrender',owner.id,[{goods:{...owner.goods},minimum:1,maximum:3}],{goods:{...emptyGoods(),[first]:1}});return;}
  const before=Object.fromEntries(state.players.map(x=>[x.id,x.silver]));
  if(code==='XM01'){const silver=Math.min(2,peer.silver);addSilver(peer,-silver);addSilver(owner,silver);}
  else if(code==='XM02'){addSilver(peer,-3);addSilver(owner,3);}
  else if(code==='XM03'){
    const options=[...(peer.silver>=2?[{branch:'silver'}]:[]),...(goodsCount(peer.goods)>0?[{branch:'goods'}]:[])];
    offer(state,'penalty-branch',peer.id,options,options[0]);return;
  }else if(code==='XM04'){addSilver(owner,-2);addSilver(peer,-Math.min(4,peer.silver));}
  else if(['XM05','XM06'].includes(code)){
    if(code==='XM05'&&!p.data.paid){addSilver(owner,-1);p.data.paid=true;}
    const count=code==='XM05'?Math.min(2,totalClass(peer.goods,params.categoryId)):1;
    p.stage='choose';offer(state,'monitored-return',peer.id,[{goods:{...peer.goods},categoryId:params.categoryId,count}],
      {goods:firstVector(peer.goods,count,params.categoryId)});return;
  }else requireRule(false,'未知的新人物效果。');
  compensateMonitorLoss(state,before,owner.id);completePending(state);
}
export function chooseNewCharacter(state,selection,ctx){
  const p=state.pending,owner=player(state,p.ownerId),code=p.code,kind=p.choice?.kind,peer=counter(code)?opponent(state,owner.id,p.data.targetId):null;
  requireRule(p.choice&&!p.response&&!p.receipt,'没有当前人物选择。');
  const before=Object.fromEntries(state.players.map(x=>[x.id,x.silver]));
  if(kind==='class-procure'){
    requireRule(exact(selection,['goods'])&&Object.keys(selection).length===1,'请选择该类2件货物。');
    const goods=checkedVector(selection.goods,state.bankGoods,2,{cat:categoryFor(code)});addSilver(owner,-2);p.data.paid=true;clearChoice(state);deliver(state,owner.id,goods);return;
  }
  if(kind==='class-exchange'){
    const {plan}=exchange(state,owner,selection);addSilver(owner,-1-plan.temporaryFee);owner.goods=plan.goods;owner.temporaryOccupied=plan.temporaryOccupied;state.bankGoods=plan.bankGoods;
  }else if(kind==='recover-guard'){
    requireRule(exact(selection,['cardId'])&&Object.keys(selection).length===1&&guards(state).includes(selection.cardId),'请选择弃牌区的锦衣卫。');
    removeCard(state.discard,selection.cardId);owner.hand.push(selection.cardId);
  }else if(kind==='class-surrender'){
    requireRule(exact(selection,['goods'])&&Object.keys(selection).length===1,'请选择同类货物。');
    const goods=checkedVector(selection.goods,owner.goods,1,{maximum:3});requireRule(Object.keys(categoryCounts(goods)).length===1,'交出货物必须同类。');
    addSilver(owner,2*goodsCount(goods)+(stocked(goods).length===2?1:0));moveGoods(owner.goods,state.bankGoods,goods);refreshTemporary(owner);
  }else if(kind==='penalty-branch'){
    requireRule(exact(selection,['branch'])&&Object.keys(selection).length===1&&p.choice.options.some(x=>x.branch===selection.branch),'请选择可支付的分支。');
    if(selection.branch==='silver')addSilver(peer,-2);
    else{clearChoice(state);p.stage='choose';offer(state,'monitored-return',peer.id,[{goods:{...peer.goods},categoryId:null,count:1}],{goods:firstVector(peer.goods,1)});return;}
  }else if(kind==='monitored-return'){
    requireRule(exact(selection,['goods'])&&Object.keys(selection).length===1,'请选择要交回的货物。');
    const option=p.choice.options[0],goods=checkedVector(selection.goods,peer.goods,option.count,{cat:option.categoryId});
    moveGoods(peer.goods,state.bankGoods,goods);refreshTemporary(peer);if(code==='XM06'){addSilver(peer,2);addSilver(owner,1);}
  }else requireRule(false,'人物选择无效。');
  compensateMonitorLoss(state,before,owner.id);clearChoice(state);completePending(state);
}

/** Read-only saved-state checks never draw or charge the effect again. */
export function newCharacterPendingProblem(state,p){
  try{
    const owner=player(state,p.ownerId),code=p.code,params=p.data.params,cat=categoryFor(code),peer=counter(code)?opponent(state,owner.id,p.data.targetId):null;
    requireRule(isNewCharacter(code)&&p.sourceCards.length===1&&codeOf(p.sourceCards[0])===code&&!p.poolCards.length
      &&exact(p.data,['params','paid',...(counter(code)?['targetId']:[])])&&Object.keys(p.data).length===(counter(code)?3:2)
      &&typeof p.data.paid==='boolean'&&exact(params,inputKeys(code)),'新人物来源或参数无效。');
    if(counter(code))requireRule(opponent(state,owner.id,params.targetId).id===peer.id&&state.turnUsage.monitorUsed,'监视人物目标或额度无效。');
    if(p.response){requireRule(counter(code)&&p.stage==='start'&&!p.data.paid&&p.choice===null&&p.receipt===null
      &&goodsCount(p.goods)===0&&legalResponseCards(state).length>0,'新监视人物回应无效。');return null;}
    if(p.receipt){
      requireRule((cat||code==='XC07')&&p.stage==='done'&&p.data.paid&&p.receipt.actorId===owner.id
        &&goodsCount(p.goods)===2&&GOODS.every(g=>!p.goods[g.id]||inClass(g.id,cat??params.categoryId)),'新人物待收货无效。');return null;
    }
    requireRule(goodsCount(p.goods)===0&&p.choice&&p.choice.visibility==='public','新人物必须停在明确选择。');
    const c=p.choice,selected=c.defaultSelection,same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const ownedChoice=kind=>requireRule(c.actorId===owner.id&&c.kind===kind&&p.stage==='start'&&!p.data.paid,'人物选择归属无效。');
    if(cat){
      ownedChoice('class-procure');requireRule(same(c.options,[{goods:{...state.bankGoods},categoryId:cat,count:2}]),'类别候选已变化。');
      checkedVector(selected.goods,state.bankGoods,2,{cat});
    }else if(code==='XC08'){
      ownedChoice('class-exchange');requireRule(same(c.options,[{ownGoods:{...owner.goods},bankGoods:{...state.bankGoods},count:2}]),'交换候选已变化。');exchange(state,owner,selected);
    }else if(code==='XC10'){
      ownedChoice('recover-guard');requireRule(same(c.options,guards(state).map(cardId=>({cardId})))&&c.options.some(x=>same(x,selected)),'锦衣卫候选无效。');
    }else if(code==='XC11'){
      ownedChoice('class-surrender');requireRule(same(c.options,[{goods:{...owner.goods},minimum:1,maximum:3}]),'交货候选无效。');
      const v=checkedVector(selected.goods,owner.goods,1,{maximum:3});requireRule(Object.keys(categoryCounts(v)).length===1,'默认交货类别无效。');
    }else if(code==='XM03'&&c.kind==='penalty-branch'){
      requireRule(c.actorId===peer.id&&p.stage==='start'&&!p.data.paid&&same(c.options,[...(peer.silver>=2?[{branch:'silver'}]:[]),...(goodsCount(peer.goods)?[{branch:'goods'}]:[])])
        &&c.options.some(x=>same(x,selected)),'交税分支无效。');
    }else if(['XM03','XM05','XM06'].includes(code)&&c.kind==='monitored-return'){
      const cat=code==='XM03'?null:params.categoryId,count=code==='XM05'?Math.min(2,totalClass(peer.goods,cat)):1;
      requireRule(c.actorId===peer.id&&p.stage==='choose'&&p.data.paid===(code==='XM05')
        &&same(c.options,[{goods:{...peer.goods},categoryId:cat,count}]),'监视交货步骤无效。');checkedVector(selected.goods,peer.goods,count,{cat});
    }else requireRule(false,'新人物保存了不支持的步骤。');
    return null;
  }catch(error){if(error instanceof RuleError||error instanceof RangeError||error instanceof TypeError)return '保存的新人物步骤无效。';throw error;}
}
