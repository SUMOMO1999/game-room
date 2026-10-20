import test from 'node:test';
import assert from 'node:assert/strict';
import {ids,fixture,move,stripResponse,run,use} from './test-support/fixture.mjs';
import {applyGameAction,gameProblem,currentDecision} from './rules.mjs';
import {privateView,spectatorView} from './view.mjs';
import {CATEGORIES,GOODS} from '../content/expansion-one.mjs';
const setup=(role='R12')=>{const g=fixture([role,'R10'],{actionLimit:8});stripResponse(g,'C07');return use(g);};
function install(g,code,index=0){const id=move(g,code,index);g=run(g,'install-tool',{cardId:id},g.players[index].id);return {g,id};}
for(let i=1;i<=6;i++)test(`XT0${i} 仅从本类合法库存随机1件，花1行动并横置；免费不等于免临时格费`,()=>{
  let {g,id}=install(setup(),`XT0${i}`);const n=g.actionsUsed;
  g=run(g,'activate-tool',{cardId:id,params:{}});
  const goods=GOODS.filter(x=>x.category===CATEGORIES[i-1].id);
  assert.equal(goods.reduce((sum,x)=>sum+g.players[0].goods[x.id],0),1);assert.equal(g.players[0].silver,26);
  assert.equal(g.actionsUsed,n+1);assert.equal(g.players[0].tools.find(t=>t.cardId===id).exhausted,true);
});
for(let i=7;i<=12;i++)test(`XT${String(i).padStart(2,'0')} 本类任选货种，预选一次提交只付1两`,()=>{
  let {g,id}=install(setup(),`XT${String(i).padStart(2,'0')}`);const good=GOODS.find(x=>x.category===CATEGORIES[i-7].id);
  g=run(g,'activate-tool',{cardId:id,params:{goodId:good.id}});
  assert.equal(g.players[0].goods[good.id],1);assert.equal(g.players[0].silver,25);assert.equal(g.pending,null);
});
test('随机道具无货／满位／临时费差1时拒绝，不横置、不耗行动、不抽随机',()=>{
  let {g,id}=install(setup(),'XT01');g.players[0].goods.timber=6;g.bankGoods.timber-=6;g.players[0].temporaryOccupied=true;g.players[0].silver=1;
  assert.equal(gameProblem(g),null);const before=structuredClone(g);let calls=0;
  const r=applyGameAction(g,ids[0],{type:'activate-tool',cardId:id,params:{},matchId:g.matchId,turnId:g.turnId},
    {now:g.committedAt+1,randomInt:m=>{calls++;return 0;}});
  assert.equal(r.ok,false);assert.equal(calls,0);assert.deepEqual(g,before);
});
test('随机道具进临时格单收2两；巧匠不抵这项费用',()=>{
  let {g,id}=install(setup('R13'),'XT01');g.players[0].goods.timber=5;g.bankGoods.timber-=5;
  g=run(g,'activate-tool',{cardId:id,params:{}});
  assert.equal(g.players[0].silver,18);assert.equal(g.players[0].temporaryOccupied,true);assert.equal(g.turnUsage.toolFeeUsed,false);
});
test('XT13按净占用换另一类，不重复临时费；同类换货非法',()=>{
  let {g,id}=install(setup(),'XT13');g.players[0].goods.timber=6;g.bankGoods.timber-=6;g.players[0].temporaryOccupied=true;
  const invalid=applyGameAction(g,ids[0],{type:'activate-tool',cardId:id,params:{ownGoodId:'timber',goodId:'salt-iron'},matchId:g.matchId,turnId:g.turnId},
    {now:g.committedAt+1,randomInt:m=>m-1});assert.equal(invalid.ok,false);
  g=run(g,'activate-tool',{cardId:id,params:{ownGoodId:'timber',goodId:'silk'}});
  assert.equal(g.players[0].silver,25);assert.equal(g.players[0].goods.timber,5);assert.equal(g.players[0].goods.silk,1);assert.equal(g.players[0].temporaryOccupied,true);
});
test('XT14手牌支付和公开目标引用分开；不能取回刚支付的牌，恢复选择不重复付费',()=>{
  let {g,id}=install(setup(),'XT14'),pay=move(g,'G01'),take=move(g,'XG07');g.players[0].hand.splice(g.players[0].hand.indexOf(take),1);g.discard.push(take);
  g=run(g,'activate-tool',{cardId:id,params:{}});assert.equal(g.players[0].silver,26);
  const view=privateView(g,ids[0]),option=view.pending.choice.options[0];
  assert.ok(option.payments.includes(pay));assert.ok(option.targets.every(x=>x.startsWith('discard:')));
  assert.equal(privateView(g,ids[1]).pending.choice.options,undefined);assert.equal(spectatorView(g).pending.choice.options,undefined);
  const before=structuredClone(g),bad=applyGameAction(g,ids[0],{type:'choose-effect',selection:{payCardId:pay,takeCardId:pay},
    matchId:g.matchId,turnId:g.turnId,effectId:g.pending.id,decisionId:currentDecision(g).id},{now:g.committedAt+1,randomInt:m=>m-1});
  assert.equal(bad.ok,false);assert.deepEqual(g,before);
  g=run(JSON.parse(JSON.stringify(g)),'choose-effect',{selection:{payCardId:pay,takeCardId:option.targets[0]}});
  assert.equal(g.players[0].silver,25);assert.ok(g.players[0].hand.includes(take));assert.ok(g.discard.includes(pay));
});
test('R13第一次正银两道具减1，0费道具不占优惠；第二次按原价且不能少付临时费',()=>{
  let {g,id:free}=install(setup('R13'),'XT01');g=run(g,'activate-tool',{cardId:free,params:{}});assert.equal(g.turnUsage.toolFeeUsed,false);
  let result=install(g,'T05');g=result.g;g.players[0].silver=0;const hand=g.players[0].hand.length;
  g=run(g,'activate-tool',{cardId:result.id,params:{}});assert.equal(g.players[0].hand.length,hand+1);assert.equal(g.players[0].silver,0);assert.equal(g.turnUsage.toolFeeUsed,true);
  result=install(g,'XT07');g=result.g;const before=structuredClone(g);
  const bad=applyGameAction(g,ids[0],{type:'activate-tool',cardId:result.id,params:{goodId:'firearms'},matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});
  assert.equal(bad.ok,false);assert.deepEqual(g,before);
});
test('术士借用新道具不享受R13优惠；原道具和术士实体正确归位',()=>{
  let g=setup('R13'),borrowed=move(g,'XT07',1),source=move(g,'M08');g.players[1].hand.splice(g.players[1].hand.indexOf(borrowed),1);
  g.players[1].tools.push({cardId:borrowed,exhausted:false});g.players[0].silver=1;
  g=run(g,'play-character',{cardId:source,params:{targetId:ids[1],toolCardId:borrowed}});
  g=run(g,'choose-effect',{selection:{borrow:true}});assert.equal(g.pending.code,'XT07');assert.equal(g.players[0].silver,1);
  g=run(g,'choose-effect',{selection:g.pending.choice.defaultSelection});
  assert.equal(g.players[0].silver,0);assert.equal(g.turnUsage.toolFeeUsed,false);assert.ok(g.discard.includes(borrowed));assert.ok(g.discard.includes(source));
});
