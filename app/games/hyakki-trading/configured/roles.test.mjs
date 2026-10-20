import test from 'node:test';
import assert from 'node:assert/strict';
import {ids,fixture,move,stripResponse,run,use} from './test-support/fixture.mjs';
import {applyGameAction,applyTimeout,gameProblem,currentDecision} from './rules.mjs';
import {privateView,spectatorView} from './view.mjs';
import {CATEGORIES,GOODS} from '../content/expansion-one.mjs';
const setup=role=>{const g=fixture([role,'R12'],{actionLimit:8});stripResponse(g,'C04');stripResponse(g,'C07');return use(g);};
function stock(g,goods,index=0){for(const [id,n] of Object.entries(goods)){g.players[index].goods[id]+=n;g.bankGoods[id]-=n;}assert.equal(gameProblem(g),null);}
for(let i=1;i<=6;i++)test(`R0${i} 实际货物牌买卖各优惠一次，只看实际类别材料`,()=>{
  let g=setup(`R0${i}`),buy=move(g,`XG${String(i+6).padStart(2,'0')}`),sale=move(g,'XG20');
  const goods=GOODS.filter(x=>x.category===CATEGORIES[i-1].id),materials={[goods[0].id]:1,[goods[1].id]:2};
  g=run(g,'buy',{cardId:buy,materials});assert.equal(g.players[0].silver,17);
  g=run(g,'sell',{cardId:sale,materials});assert.equal(g.players[0].silver,27);assert.equal(g.turnUsage.specialistBuy,true);assert.equal(g.turnUsage.specialistSell,true);
});
test('R07三类卖出多3，R08同种三件多2；不把同类混合当同种',()=>{
  for(const [code,goods,expected] of [['R07',{firearms:1,silk:1,pearl:1},32],['R08',{timber:3},31]]){
    let g=setup(code);stock(g,goods);g=run(g,'sell',{cardId:move(g,'XG20'),materials:goods});assert.equal(g.players[0].silver,expected);
  }
});
test('R09同类净交换1～2件、免费且每回合一次；不允许原样交换',()=>{
  let g=setup('R09');stock(g,{firearms:2,mechanism:1});g=run(g,'use-role',{params:{give:{firearms:2},receive:{mechanism:2}}});
  assert.equal(g.players[0].goods.mechanism,3);assert.equal(g.players[0].silver,20);assert.equal(g.actionsUsed,2);
  const before=structuredClone(g),r=applyGameAction(g,ids[0],{type:'use-role',params:{give:{mechanism:1},receive:{firearms:1}},matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});
  assert.equal(r.ok,false);assert.deepEqual(g,before);
});
test('R14实际从弃牌区取道具，付1两和1行动，取回不等于安装',()=>{
  let g=setup('R14'),tool=move(g,'XT01');g.players[0].hand.splice(g.players[0].hand.indexOf(tool),1);g.discard.push(tool);
  g=run(g,'use-role',{params:{}});assert.equal(g.pending.code,'R14');const v=privateView(g,ids[0]);assert.match(v.pending.choice.defaultSelection.cardId,/^discard:/);
  g=run(JSON.parse(JSON.stringify(g)),'choose-effect',{selection:v.pending.choice.defaultSelection});
  assert.equal(g.players[0].silver,19);assert.ok(g.players[0].hand.includes(tool));assert.equal(g.players[0].tools.length,0);
});
for(const [role,params,expected] of [['R16',{},20],['R17',{categoryId:'spirit'},19],['R18',{goodId:'pearl'},18]])test(`${role} 角色取货按自身费用，真实扣行动并一次结算`,()=>{
  let g=setup(role);g=run(g,'use-role',{params});assert.equal(g.pending,null);assert.equal(g.players[0].silver,expected);
  assert.equal(Object.values(g.players[0].goods).reduce((a,b)=>a+b,0),1);assert.equal(g.actionsUsed,2);assert.equal(g.turnUsage.roleUsed,true);
  if(role==='R17')assert.equal(g.players[0].goods.herb,1);if(role==='R18')assert.equal(g.players[0].goods.pearl,1);
});
test('R19真实付价买入和卖出才奖励1两；临时费或0牌价不构成资格',()=>{
  let g=setup('R19'),buy=move(g,'G01'),sale=move(g,'XG20');g=run(g,'buy',{cardId:buy});g=run(g,'sell',{cardId:sale,materials:{firearms:3}});
  assert.equal(g.players[0].silver,27);assert.equal(g.turnUsage.turnoverReward,true);
  g=setup('R19');g.bookLayers=2;g.actionsUsed=2;buy=move(g,'G01');g=run(g,'buy',{cardId:buy});assert.equal(g.turnUsage.paidBuy,false);assert.equal(g.players[0].silver,20);
});
test('R20交1件库存固定得2两，不消耗或触发货物牌交易次数',()=>{
  let g=setup('R20');stock(g,{timber:1});g=run(g,'use-role',{params:{goodId:'timber'}});
  assert.equal(g.players[0].silver,22);assert.equal(g.players[0].goods.timber,0);assert.equal(g.turnUsage.sold,false);assert.equal(g.actionsUsed,2);
});
test('R21开局已有一次保护，两个对手连续监也只赔一次，下次自己回合才刷新',()=>{
  let g=fixture(['R21','R23','R24'],{actionLimit:8});stripResponse(g,'C07');stock(g,{timber:3});g=use(g);g=run(g,'end-turn');
  g=use(g);g=run(g,'use-role',{params:{targetId:ids[0]}});assert.equal(g.players[0].silver,20);assert.equal(g.players[0].roleState.compensationAvailable,false);
  g=run(g,'end-turn');g=use(g);g=run(g,'use-role',{params:{targetId:ids[0]}});assert.equal(g.players[0].silver,18);
  g=run(g,'end-turn');assert.equal(g.turnPlayerId,ids[0]);assert.equal(g.players[0].roleState.compensationAvailable,true);
});
test('R22弃1手牌重置自己的道具不花行动，重新激活仍花行动和银两',()=>{
  let g=setup('R22'),tool=move(g,'T05');g=run(g,'install-tool',{cardId:tool});g.players[0].tools[0].exhausted=true;
  const actions=g.actionsUsed,hand=g.players[0].hand.length;g=run(g,'use-role',{params:{}});
  const v=privateView(g,ids[0]);assert.match(v.pending.choice.defaultSelection.toolCardId,/^tool-0:/);
  g=run(g,'choose-effect',{selection:v.pending.choice.defaultSelection});assert.equal(g.actionsUsed,actions);assert.equal(g.players[0].hand.length,hand-1);
  assert.equal(g.players[0].tools[0].exhausted,false);g=run(g,'activate-tool',{cardId:tool,params:{}});
  assert.equal(g.actionsUsed,actions+1);assert.equal(g.players[0].silver,19);assert.equal(g.players[0].tools[0].exhausted,true);
});
test('R22没有剩余行动时不能靠零步重置跨过换人，拒绝不弃牌',()=>{
  let g=setup('R22'),tool=move(g,'T05');g=run(g,'install-tool',{cardId:tool});g.players[0].tools[0].exhausted=true;g.actionsUsed=g.actionLimit;
  const before=structuredClone(g),r=applyGameAction(g,ids[0],{type:'use-role',params:{cardId:g.players[0].hand[0],toolCardId:tool},matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});
  assert.equal(r.ok,false);assert.deepEqual(g,before);
});
test('R23实际0牌价买入仍付1行税；R24一次买入后仍能卖出',()=>{
  let g=setup('R23');g.bookLayers=2;g.actionsUsed=2;g=run(g,'buy',{cardId:move(g,'G01')});assert.equal(g.players[0].silver,19);assert.equal(g.lastPublicEvents[0].price.buyTax,1);
  g=setup('R24');g=run(g,'buy',{cardId:move(g,'G01')});const next=move(g,'G03'),before=structuredClone(g);
  const bad=applyGameAction(g,ids[0],{type:'buy',cardId:next,matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});assert.equal(bad.ok,false);assert.deepEqual(g,before);
  g=run(g,'sell',{cardId:move(g,'XG20'),materials:{firearms:3}});assert.equal(g.players[0].silver,26);
});
test('R15付1两秘密看2选1，另一张回顶原序；仍只耗普通摸看的1行动',()=>{
  let g=fixture(['R15','R12'],{actionLimit:5});const [first,second,third]=g.deck;
  g=run(g,'peek',{inspect:true});assert.equal(g.players[0].silver,19);assert.equal(g.actionsUsed,1);assert.equal(g.pending.poolCards.length,2);
  const other=JSON.stringify(privateView(g,ids[1])),watch=JSON.stringify(spectatorView(g));assert.equal(other.includes(first),false);assert.equal(other.includes(second),false);assert.equal(watch.includes(first),false);
  g=run(JSON.parse(JSON.stringify(g)),'choose-effect',{selection:{cardId:second}});assert.deepEqual(g.deck.slice(0,2),[first,third]);assert.equal(g.pending.poolCards[0],second);
  g=run(g,'discard-peek');assert.equal(g.stage,'draw');assert.equal(g.actionsUsed,1);
  const before=structuredClone(g),r=applyGameAction(g,ids[0],{type:'peek',inspect:true,matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});assert.equal(r.ok,false);assert.deepEqual(g,before);
  g=run(g,'peek');g=run(g,'keep-peek');assert.ok(g.players[0].hand.includes(first));assert.equal(g.players[0].silver,19);assert.equal(g.actionsUsed,2);
});
test('R15先正常摸看就放弃当回合增益；不足2张不能付费但仍能正常摸',()=>{
  let g=fixture(['R15','R12']);g=run(run(g,'peek'),'discard-peek');const money=g.players[0].silver;
  const bad=applyGameAction(g,ids[0],{type:'peek',inspect:true,matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});assert.equal(bad.ok,false);assert.equal(g.players[0].silver,money);
  g=fixture(['R15','R12']);const only=g.deck.pop();g.players[0].hand.push(...g.deck,...g.players[1].hand);g.deck=[only];g.players[1].hand=[];assert.equal(gameProblem(g),null);
  const r=applyGameAction(g,ids[0],{type:'peek',inspect:true,matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});assert.equal(r.ok,false);assert.equal(g.players[0].silver,20);
  g=run(g,'peek');g=run(g,'keep-peek');assert.ok(g.players[0].hand.includes(only));
});
test('R15私选或留弃的超时沿原默认收尾，不再收费、不重新抽两张',()=>{
  let g=fixture(['R15','R12']);g=run(g,'peek',{inspect:true});const first=g.pending.poolCards[0];
  const r=applyTimeout(g,ids[0],{now:g.timing.active.deadlineAt,randomInt:()=>{throw new Error('no redraw expected');}});
  assert.equal(r.ok,true,r.error);assert.equal(r.state.turnPlayerId,ids[1]);assert.equal(r.state.players[0].silver,19);assert.ok(r.state.players[0].hand.includes(first));
});
