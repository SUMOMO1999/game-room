import test from 'node:test';
import assert from 'node:assert/strict';
import {ids,fixture,move,stripResponse,run,use} from './test-support/fixture.mjs';
import {applyGameAction,gameProblem} from './rules.mjs';
import {privateView,spectatorView} from './view.mjs';

test('选角统一初始化正式回合；R12只得26，R21开局即有保护，十二货与180牌守恒',()=>{
  const state=fixture(['R12','R21']);assert.equal(state.players[0].silver,26);assert.equal(state.players[1].silver,20);
  assert.equal(state.players[1].roleState.compensationAvailable,true);assert.equal(state.timing.active.deadlineAt,1001+30*60*1000);
  assert.equal(state.deck.length,170);assert.equal(Object.keys(state.bankGoods).length,12);
  assert.equal(state.turnUsage.turnId,state.turnId);assert.equal(gameProblem(state),null);
  assert.equal(spectatorView(state).players.some(p=>'hand' in p),false);
  assert.equal(privateView(state,ids[0]).players.filter(p=>'hand' in p).length,1);
});
test('真正柔性买卖按具体材料与一次优惠；交易事件分列完整价目',()=>{
  let state=fixture(['R01','R12']);stripResponse(state);const card=move(state,'XG07');state=use(state);
  state=run(state,'buy',{cardId:card,materials:{firearms:1,mechanism:2}});
  assert.equal(state.players[0].silver,17);assert.equal(state.players[0].goods.mechanism,2);assert.equal(state.bankGoods.mechanism,4);
  assert.deepEqual(state.lastPublicEvents.find(e=>e.type==='trade-bought').price,
    {printed:4,bookLayers:0,roleAdjustment:-1,goodsPrice:3,buyTax:0,temporaryFee:0});
  assert.equal(state.turnUsage.specialistBuy,true);assert.ok(state.discard.includes(card));
});
test('材料非法整笔拒绝，不耗行动／优惠或随机，源牌和钱货保持',()=>{
  let state=fixture();const card=move(state,'XG13');state=use(state);const before=structuredClone(state);let randomCalls=0;
  const result=applyGameAction(state,ids[0],{type:'buy',cardId:card,materials:{firearms:3},matchId:state.matchId,turnId:state.turnId},
    {now:state.committedAt+1,randomInt:m=>{randomCalls++;return m-1;}});
  assert.equal(result.ok,false);assert.equal(randomCalls,0);assert.deepEqual(state,before);
});
test('税角色与原【监】共用本回合额度；锦衣卫取消不退行动／额度且角色仍在',()=>{
  let state=fixture(['R23','R21']);const guard=move(state,'C07',1),monitor=move(state,'M04');state=use(state);
  state=run(state,'use-role',{params:{targetId:ids[1]}});
  assert.equal(state.pending.kind,'role');assert.equal(state.pending.response.actorId,ids[1]);
  assert.equal(state.players[0].silver,20);assert.equal(state.players[1].silver,20);
  state=run(state,'respond',{cardId:guard},ids[1]);assert.equal(state.pending,null);
  assert.equal(state.players[0].roleId,'yousei.role.r23');assert.equal(state.turnUsage.monitorUsed,true);assert.equal(state.actionsUsed,2);
  assert.equal(state.players[1].roleState.compensationAvailable,true);
  const before=structuredClone(state),r=applyGameAction(state,ids[0],{type:'play-character',cardId:monitor,params:{targetId:ids[1]},
    matchId:state.matchId,turnId:state.turnId},{now:state.committedAt+1,randomInt:m=>m-1});
  assert.equal(r.ok,false);assert.match(r.error,/【监】/);assert.deepEqual(state,before);
});
test('未反制才付税，镖行主只补实际因对手监失去的钱且只补一次',()=>{
  let state=fixture(['R23','R21']);stripResponse(state,'C07');state=use(state);
  state=run(state,'use-role',{params:{targetId:ids[1]}});
  assert.equal(state.players[0].silver,22);assert.equal(state.players[1].silver,19);
  assert.equal(state.players[1].roleState.compensationAvailable,false);
  assert.equal(state.lastPublicEvents.filter(e=>e.type==='role-triggered').length,1);
});
test('R11最后一步成交先等番商，再私摸私弃；义务未完不得换人',()=>{
  let state=fixture(['R11','R12'],{actionLimit:2}),trade=move(state,'G01'),merchant=move(state,'C04',1);
  state=use(state);const hand=state.players[0].hand.length;
  state=run(state,'buy',{cardId:trade});assert.equal(state.pending.response.kind,'merchant');
  assert.equal(state.players[0].hand.length,hand-1);assert.equal(state.afterActions.length,1);assert.equal(state.turnPlayerId,ids[0]);
  const serialized=JSON.parse(JSON.stringify(state));assert.equal(gameProblem(serialized),null);
  state=run(serialized,'respond',{cardId:merchant},ids[1]);
  assert.equal(state.pending.code,'R11');assert.equal(state.players[0].hand.length,hand);assert.equal(state.actionsUsed,2);
  assert.equal(state.players[1].hand.includes(trade),true);assert.equal(state.afterActions.length,0);
  assert.equal(privateView(state,ids[1]).pending.choice.options,undefined);assert.equal(spectatorView(state).pending.choice.options,undefined);
  const chosen=state.pending.choice.options.at(-1).cardId;state=run(state,'choose-effect',{selection:{cardId:chosen}});
  assert.equal(state.turnPlayerId,ids[1]);assert.equal(state.turnId,'turn-2');assert.equal(state.players[0].hand.length,hand-1);
  assert.ok(state.discard.includes(chosen));assert.equal(state.turnUsage.accountant,false);
});
test('R11的0价交易也触发，买办子卖也共用同一次；普通摸看不会重新开启',()=>{
  let state=fixture(['R11','R12'],{actionLimit:6});stripResponse(state);const trade=move(state,'G01'),broker=move(state,'C05');
  state=use(state);state.bookLayers=2;state.actionsUsed=2;
  state=run(state,'buy',{cardId:trade});assert.equal(state.players[0].silver,20);assert.equal(state.pending.code,'R11');
  state=run(state,'choose-effect',{selection:state.pending.choice.defaultSelection});assert.equal(state.pending,null);assert.equal(state.stage,'use');
  const sale=move(state,'XG07');state=run(state,'play-character',{cardId:broker,params:{}});
  state=run(state,'choose-effect',{selection:{cardId:sale}});
  state=run(state,'choose-effect',{selection:{goods:{...state.players[0].goods}}});
  assert.equal(state.pending,null);assert.equal(state.turnUsage.accountant,true);assert.equal(state.players[0].silver,34);
});
test('收市金额用本局冻结值；最后席触发即收市，领先并列按冻结顺序判胜',()=>{
  let state=fixture(['R12','R01'],{closingTarget:30});state.players[0].silver=29;state=use(state);state=run(state,'end-turn');
  assert.equal(state.players[0].silver,30);assert.equal(state.closing.triggerPlayerId,ids[0]);assert.equal(state.status,'playing');
  state.players[1].silver=29;state=use(state);state=run(state,'end-turn');
  assert.equal(state.status,'finished');assert.deepEqual(state.result.winnerIds,[ids[1]]);assert.equal(state.result.wealth[1].silver,30);
});
test('保存严格核实际turnId、角色唯一、源实体和全牌区，不静默修复',()=>{
  const state=fixture(['R10','R12']);for(const mutate of [g=>g.turnUsage.turnId='turn-2',g=>g.players[1].roleId=g.players[0].roleId,
    g=>g.deck.push(g.players[0].hand[0]),g=>g.configuration.playerCount=6,g=>g.players[1].roleState.compensationAvailable=true]){
    const bad=structuredClone(state);mutate(bad);assert.ok(gameProblem(bad));
  }
});
