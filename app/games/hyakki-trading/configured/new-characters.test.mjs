import test from 'node:test';
import assert from 'node:assert/strict';
import {ids,fixture,move,stripResponse,run,use} from './test-support/fixture.mjs';
import {applyGameAction,applyTimeout,gameProblem,currentDecision} from './rules.mjs';
import {CATEGORIES,GOODS} from '../content/expansion-one.mjs';
const setup=()=>{let g=fixture(['R12','R10'],{actionLimit:8});stripResponse(g,'C07');return use(g);};
function stock(g,goods,index=0){
  const p=g.players[index];for(const [id,n] of Object.entries(goods)){g.bankGoods[id]-=n;p.goods[id]+=n;}
  const count=Object.values(p.goods).reduce((a,b)=>a+b,0),base=5+(p.roleId==='yousei.role.r10'?1:0),stalls=Math.max(0,Math.ceil((count-base)/3));
  p.stallCount=stalls;g.purchasedStalls=g.players.reduce((sum,p)=>sum+p.stallCount,0);g.availableStalls=5-g.purchasedStalls;p.temporaryOccupied=false;
  assert.equal(gameProblem(g),null);
}
const play=(g,code,params={})=>run(g,'play-character',{cardId:move(g,code),params});
for(let i=0;i<6;i++)test(`XC0${i+1} 按冻结类别任选2件，预选一次提交只付2两`,()=>{
  let g=setup();const goods=GOODS.filter(x=>x.category===CATEGORIES[i].id);g=play(g,`XC0${i+1}`,{goods:{[goods[0].id]:1,[goods[1].id]:1}});
  assert.equal(g.pending,null);assert.equal(g.players[0].silver,24);assert.equal(g.players[0].goods[goods[0].id],1);assert.equal(g.players[0].goods[goods[1].id],1);
});
test('采办满位先支付取货费，收货待决保存准确材料；保留临时格另付2两',()=>{
  let g=setup();stock(g,{timber:5});g=play(g,'XC01',{goods:{firearms:2}});
  assert.equal(g.pending.receipt.actorId,ids[0]);assert.equal(g.players[0].silver,24);assert.equal(g.pending.goods.firearms,2);
  g=run(JSON.parse(JSON.stringify(g)),'choose-effect',{selection:g.pending.choice.defaultSelection});
  assert.equal(g.pending,null);assert.equal(g.players[0].silver,22);assert.equal(g.players[0].temporaryOccupied,true);
  assert.equal(Object.values(g.players[0].goods).reduce((a,b)=>a+b,0),6);
});
test('XC07随机仅抽仍有库存的货种，单候选不重掷；不足2件整笔拒绝且不动随机',()=>{
  let g=setup();stock(g,{firearms:6,mechanism:4},1);g=play(g,'XC07',{categoryId:'military'});
  assert.equal(g.players[0].goods.mechanism,2);assert.equal(g.players[0].silver,25);
  const next=move(g,'XC07'),before=structuredClone(g);let calls=0;
  const r=applyGameAction(g,ids[0],{type:'play-character',cardId:next,params:{categoryId:'military'},matchId:g.matchId,turnId:g.turnId},
    {now:g.committedAt+1,randomInt:m=>{calls++;return 0;}});
  assert.equal(r.ok,false);assert.equal(calls,0);assert.deepEqual(g,before);
});
test('XC08交同类2件换另一类2件按净占用，只收1两',()=>{
  let g=setup();stock(g,{'salt-iron':1,timber:1});g=play(g,'XC08',{give:{'salt-iron':1,timber:1},receive:{mechanism:2}});
  assert.equal(g.players[0].silver,25);assert.equal(g.players[0].goods.mechanism,2);assert.equal(g.players[0].goods.timber,0);
});
test('XC09逐张公开，见到第2张货物就停，不把其余私牌或未来牌序公开',()=>{
  let g=setup();const source=move(g,'XC09'),cards=['C01','G01','C02','XG07'].map(code=>move(g,code));
  for(const id of cards)g.players[0].hand.splice(g.players[0].hand.indexOf(id),1);g.deck.unshift(...cards);
  const hand=g.players[0].hand.length;g=run(g,'play-character',{cardId:source,params:{}});
  assert.equal(g.players[0].hand.length,hand+1);assert.ok(g.players[0].hand.includes(cards[1]));assert.ok(g.players[0].hand.includes(cards[3]));
  assert.equal(g.lastPublicEvents.find(e=>e.type==='search-revealed').cardIds.length,4);assert.ok(g.discard.includes(cards[0]));
});
test('XC10只从弃牌区取锦衣卫，XC11同类混合交货给固定5两',()=>{
  let g=setup(),guard=move(g,'C07');g.players[0].hand.splice(g.players[0].hand.indexOf(guard),1);g.discard.push(guard);
  g=play(g,'XC10',{cardId:guard});assert.ok(g.players[0].hand.includes(guard));assert.equal(g.discard.includes(guard),false);
  stock(g,{firearms:1,mechanism:1});g=play(g,'XC11',{goods:{firearms:1,mechanism:1}});
  assert.equal(g.players[0].silver,31);assert.equal(g.players[0].goods.firearms,0);
});
for(const [code,peerMoney,params] of [['XM01',1,{}],['XM02',40,{}],['XM03',10,{}],['XM04',10,{}],['XM05',10,{categoryId:'military'}],['XM06',10,{categoryId:'military'}]]){
  test(`${code} 实际人物效果，钱货按牌文流向；对手选择只能由对手完成`,()=>{
    let g=setup();g.players[1].silver=peerMoney;stock(g,{firearms:1,mechanism:1},1);g=play(g,code,{targetId:ids[1],...params});
    while(g.pending){
      const actor=currentDecision(g).actorId;assert.equal(actor,ids[1]);g=run(JSON.parse(JSON.stringify(g)),'choose-effect',{selection:g.pending.choice.defaultSelection},actor);
    }
    const expected={XM01:[27,0,2],XM02:[29,37,2],XM03:[26,8,2],XM04:[24,6,2],XM05:[25,10,0],XM06:[27,12,1]}[code];
    assert.deepEqual([g.players[0].silver,g.players[1].silver,g.players[1].goods.firearms+g.players[1].goods.mechanism],expected);
    assert.equal(g.turnUsage.monitorUsed,true);assert.equal(g.actionsUsed,2);
  });
  test(`${code} 被锦衣卫取消，不提前扣未发生的银两费，行动和监次数不退`,()=>{
    let g=setup();g.players[1].silver=40;stock(g,{firearms:1,mechanism:1},1);const guard=move(g,'C07',1);const money=g.players.map(p=>p.silver);
    g=play(g,code,{targetId:ids[1],...params});assert.equal(g.pending.response.kind,'counter');assert.deepEqual(g.players.map(p=>p.silver),money);
    g=run(g,'respond',{cardId:guard},ids[1]);assert.equal(g.pending,null);assert.deepEqual(g.players.map(p=>p.silver),money);
    assert.equal(g.turnUsage.monitorUsed,true);assert.equal(g.actionsUsed,2);
  });
}
test('稽税官无钱只能交货；私改默认材料及越权选择不能通过保存或动作围栏',()=>{
  let g=setup();g.players[1].silver=0;stock(g,{timber:1},1);g=play(g,'XM03',{targetId:ids[1]});
  const malformed=structuredClone(g);malformed.pending.choice.options=[{branch:'silver'}];assert.ok(gameProblem(malformed));
  const before=structuredClone(g),r=applyGameAction(g,ids[0],{type:'choose-effect',selection:{branch:'goods'},matchId:g.matchId,turnId:g.turnId,
    effectId:g.pending.id,decisionId:currentDecision(g).id},{now:g.committedAt+1,randomInt:m=>m-1});
  assert.equal(r.ok,false);assert.equal(r.code,'WRONG_ACTOR');assert.deepEqual(g,before);
  g=run(g,'choose-effect',{selection:{branch:'goods'}},ids[1]);
  const time=g.timing.decision.deadlineAt,result=applyTimeout(g,ids[1],{now:time,randomInt:m=>m-1});
  assert.equal(result.ok,true,result.error);assert.equal(result.state.players[1].goods.timber,0);assert.equal(result.state.players[1].silver,0);
});

test('仓栈主人超量收货保存六个普通格，临时第七格费用另算',()=>{
  let g=fixture(['R10','R12'],{actionLimit:8});stripResponse(g,'C07');g=use(g);
  g.players[0].goods.timber=6;g.bankGoods.timber-=6;assert.equal(gameProblem(g),null);
  g=play(g,'XC01',{goods:{firearms:2}});
  assert.equal(g.pending.choice.options[0].ordinaryCapacity,6);assert.equal(g.pending.choice.options[0].capacity,7);
  assert.equal(gameProblem(JSON.parse(JSON.stringify(g))),null);
  g=run(g,'choose-effect',{selection:g.pending.choice.defaultSelection});assert.equal(g.players[0].silver,16);
  assert.equal(Object.values(g.players[0].goods).reduce((a,b)=>a+b,0),7);assert.equal(g.players[0].temporaryOccupied,true);
});
