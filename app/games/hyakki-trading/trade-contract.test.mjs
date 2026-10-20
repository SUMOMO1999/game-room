import test from 'node:test';
import assert from 'node:assert/strict';
import {GOODS,CARDS,CATEGORIES} from './content/expansion-one.mjs';
import {newTradeUsage,goodsVector,resolveTradeMaterials,ordinaryCapacity,receiptPlan,quoteGoodsTrade,settleGoodsTrade} from './trade-contract.mjs';

const playerId='1'.repeat(32),role=code=>`yousei.role.${code.toLowerCase()}`;
const bank=()=>Object.fromEntries(GOODS.map(good=>[good.id,6]));
const owner=(code='R12',goods={},silver=20,stallCount=0)=>({id:playerId,roleId:role(code),goods:goodsVector(goods),silver,stallCount,
  temporaryOccupied:Object.values(goods).reduce((a,b)=>a+b,0)>5+3*stallCount+(code==='R10'?1:0)});
function input(code,extra={}){return {owner:owner(code),bankGoods:bank(),usage:newTradeUsage(),bookLayers:0,
  definitionId:'yousei.g01',direction:'buy',...extra};}

test('D02 同一类和同一种严格区分；G19仍是旧六种',()=>{
  const mixture={firearms:1,mechanism:2};
  assert.equal(resolveTradeMaterials('yousei.xg07',mixture).mechanism,2);
  assert.throws(()=>resolveTradeMaterials('yousei.g01',mixture),/配方/);
  const legacySix=resolveTradeMaterials('yousei.g19');assert.equal(legacySix.mechanism,0);
  assert.deepEqual(Object.entries(legacySix).filter(([,n])=>n),[['firearms',1],['imports',1],['curios',1],['beasts',1],['antiques',1],['salt-iron',1]]);
  assert.throws(()=>resolveTradeMaterials('yousei.g19',{mechanism:1,silk:1,pearl:1,herb:1,painting:1,timber:1}),/配方/);
  assert.throws(()=>resolveTradeMaterials('yousei.g19',legacySix,{broker:true}),/三件/);
});
test('四类柔性配方与39个货物定义的实际件数；其他类不含本类',()=>{
  assert.ok(resolveTradeMaterials('yousei.xg13',{firearms:1,mechanism:1,silk:1}));
  assert.throws(()=>resolveTradeMaterials('yousei.xg13',{firearms:1,mechanism:2}),/配方/);
  assert.throws(()=>resolveTradeMaterials('yousei.xg13',{firearms:1,silk:2}),/配方/);
  assert.ok(resolveTradeMaterials('yousei.xg19',{firearms:1,silk:1,pearl:1}));
  assert.throws(()=>resolveTradeMaterials('yousei.xg19',{firearms:1,mechanism:1,silk:1}),/配方/);
  assert.ok(resolveTradeMaterials('yousei.xg20',{timber:3}));
  for(const card of CARDS.filter(card=>card.category==='goods')){
    const r=card.recipe,matching=GOODS.filter(good=>good.category===r.category),elsewhere=GOODS.find(good=>good.category!==r.category);
    const selected=r.type==='fixed'?r.goods:r.type==='class'?{[matching[0].id]:3}
      :r.type==='mixed'?{[matching[0].id]:2,[elsewhere.id]:1}
      :r.type==='distinct'?{firearms:1,imports:1,curios:1}:{timber:3};
    assert.equal(Object.values(resolveTradeMaterials(card.id,selected)).reduce((a,b)=>a+b,0),card.sourceCode==='G19'?6:3);
  }
});
test('材料不接受角色、未知货、负数、字符串、多件或缺少的柔性选择',()=>{
  for(const selection of [{role:3},{firearms:-1,mechanism:4},{firearms:'3'},{firearms:21},null]){
    assert.throws(()=>resolveTradeMaterials('yousei.xg20',selection),RangeError);
  }
  assert.throws(()=>resolveTradeMaterials('yousei.xg07'),RangeError);
  assert.throws(()=>resolveTradeMaterials('yousei.role.r01',{firearms:3}),RangeError);
});
test('D03 书算在先、专商在后，临时格2两独立；零牌价不占专商优惠',()=>{
  const request=input('R01',{owner:owner('R01',{imports:3}),bookLayers:1});
  const before=structuredClone(request),quote=quoteGoodsTrade(request);
  assert.deepEqual([quote.printedPrice,quote.goodsPrice,quote.roleAdjustment,quote.temporaryFee,quote.totalPayment],[3,0,-1,2,2]);
  const trade=settleGoodsTrade(request);assert.equal(trade.owner.silver,18);assert.equal(trade.usage.specialistBuy,true);
  assert.deepEqual(request,before);
  const free=settleGoodsTrade({...request,bookLayers:2});
  assert.equal(free.quote.goodsPrice,0);assert.equal(free.usage.specialistBuy,false);assert.equal(free.owner.silver,18);
});
test('六类专商各自用实际材料、买卖独立；第二笔无优惠',()=>{
  CATEGORIES.forEach((category,index)=>{
    const selected=Object.fromEntries(GOODS.filter(g=>g.category===category.id).map((g,i)=>[g.id,i?2:1]));
    const code=`R${String(index+1).padStart(2,'0')}`,definitionId=`yousei.xg${String(index+7).padStart(2,'0')}`;
    const buy=settleGoodsTrade(input(code,{definitionId,materials:selected}));
    assert.equal(buy.owner.silver,17);assert.equal(buy.usage.specialistBuy,true);assert.equal(buy.usage.specialistSell,false);
    const sale=settleGoodsTrade(input(code,{owner:buy.owner,bankGoods:buy.bankGoods,usage:buy.usage,definitionId,materials:selected,direction:'sell'}));
    assert.equal(sale.quote.saleProceeds,11);assert.equal(sale.owner.silver,28);assert.equal(sale.usage.specialistSell,true);
    const next=quoteGoodsTrade(input(code,{usage:sale.usage,definitionId,materials:selected}));assert.equal(next.goodsPrice,4);
  });
});
test('D04 行税不被书算抵掉，含临时格总付3；普通原牌价0也收税',()=>{
  const request=input('R23',{owner:owner('R23',{imports:3},3),bookLayers:2});
  const trade=settleGoodsTrade(request);
  assert.deepEqual([trade.quote.goodsPrice,trade.quote.buyTax,trade.quote.temporaryFee,trade.quote.totalPayment],[0,1,2,3]);
  assert.equal(trade.owner.silver,0);assert.equal(trade.bankSilverDelta,3);
  assert.throws(()=>settleGoodsTrade({...request,owner:{...request.owner,silver:2}}),/银两不足/);
});
test('D05 买办按实际材料加价，不能按印刷军工类偷取奖励',()=>{
  const actual={timber:1,painting:1,silk:1};
  const request=input('R07',{owner:owner('R07',actual),definitionId:'yousei.xg13',materials:actual,direction:'sell',broker:true});
  assert.equal(settleGoodsTrade(request).quote.saleProceeds,14);
  assert.equal(settleGoodsTrade({...request,bookLayers:1}).quote.saleProceeds,16);
  const military=settleGoodsTrade({...request,owner:owner('R01',actual)});
  assert.equal(military.quote.saleProceeds,11);assert.equal(military.usage.specialistSell,false);
  const twoClasses={firearms:1,mechanism:1,painting:1};
  const badBonus=settleGoodsTrade({...request,owner:owner('R07',twoClasses),materials:twoClasses});
  assert.equal(badBonus.quote.saleProceeds,11);assert.equal(badBonus.usage.saleBonus,false);
});
test('R08只有同品种3件加2，买办的实际同种3件可以触发',()=>{
  const actual={timber:3};
  const sale=settleGoodsTrade(input('R08',{owner:owner('R08',actual),definitionId:'yousei.xg13',direction:'sell',materials:actual,broker:true,bookLayers:1}));
  assert.equal(sale.quote.saleProceeds,15);assert.equal(sale.usage.saleBonus,true);
  const mix={firearms:1,mechanism:2};
  const mixed=settleGoodsTrade(input('R08',{owner:owner('R08',mix),definitionId:'yousei.xg07',direction:'sell',materials:mix}));
  assert.equal(mixed.quote.saleProceeds,10);assert.equal(mixed.usage.saleBonus,false);
});
test('D06 R24零价买入占次数，但卖出与买办子卖仍可用',()=>{
  const buy=settleGoodsTrade(input('R24',{bookLayers:2}));assert.equal(buy.owner.silver,20);assert.equal(buy.usage.goodsBuys,1);
  assert.throws(()=>quoteGoodsTrade(input('R24',{usage:buy.usage})),/一次/);
  const sell=settleGoodsTrade(input('R24',{owner:buy.owner,bankGoods:buy.bankGoods,usage:buy.usage,direction:'sell',broker:true}));
  assert.equal(sell.owner.silver,30);assert.equal(sell.usage.goodsBuys,1);
});
test('D10 R11只生成一次后置摸弃义务，报价和失败均不触发',()=>{
  const request=input('R11'),before=structuredClone(request);
  quoteGoodsTrade(request);assert.deepEqual(request,before);
  const first=settleGoodsTrade(request);
  assert.deepEqual(first.afterSourceSettled,{kind:'accountant-draw-discard',playerId});assert.equal(first.usage.accountant,true);
  assert.equal(first.owner.hand,undefined,'此经济合同不提前抽牌或跳过番商／货牌去向');
  const second=settleGoodsTrade({...request,usage:first.usage});assert.equal(second.afterSourceSettled,null);
  assert.throws(()=>settleGoodsTrade({...request,bankGoods:{...bank(),firearms:2}}),/不足/);assert.deepEqual(request,before);
});
test('D14 等量交换按净结果，不重复临时费；回交可充本笔货源',()=>{
  const o=owner('R12',{timber:2,'salt-iron':2,painting:2});
  const plan=receiptPlan(o,bank(),{give:{timber:1,'salt-iron':1},receive:{imports:1,silk:1},cost:1});
  assert.equal(plan.temporaryFee,0);assert.equal(plan.temporaryOccupied,true);assert.equal(plan.goods.imports,1);
  const noSource={...bank(),imports:0},before=structuredClone(o);
  assert.throws(()=>receiptPlan(o,noSource,{give:{timber:1},receive:{imports:1},cost:1}),/公共货物不足/);assert.deepEqual(o,before);
  assert.equal(receiptPlan(o,{...bank(),timber:0},{give:{timber:1},receive:{timber:1}}).bankGoods.timber,0);
  assert.equal(receiptPlan(o,bank(),{give:{timber:1}}).temporaryOccupied,false);
});
test('R10额外普通格影响同一容量校验；普通满位拒绝不许收后弃旧货',()=>{
  assert.equal(ordinaryCapacity(owner('R10')),6);assert.equal(ordinaryCapacity(owner('R10',{},20,2)),12);
  const six=owner('R10',{timber:6});assert.equal(six.temporaryOccupied,false);
  const plan=receiptPlan(six,bank(),{receive:{silk:1}});assert.equal(plan.temporaryFee,2);
  assert.throws(()=>receiptPlan(six,bank(),{receive:{silk:2}}),/货位/);
  assert.throws(()=>receiptPlan({...six,silver:1},bank(),{receive:{silk:1}}),/银两/);
});
test('R19 付过正牌价买入和卖出才得1，费用不计资格且奖励不能预付买价',()=>{
  const request=input('R19'),buy=settleGoodsTrade(request);
  assert.equal(buy.turnoverReward,0);assert.equal(buy.usage.paidBuy,true);
  const sale=settleGoodsTrade({...request,owner:buy.owner,bankGoods:buy.bankGoods,usage:buy.usage,direction:'sell'});
  assert.equal(sale.owner.silver,28);assert.equal(sale.turnoverReward,1);assert.equal(sale.bankSilverDelta,-11);
  const free=settleGoodsTrade({...request,owner:owner('R19',{imports:3}),bookLayers:2});
  assert.equal(free.quote.temporaryFee,2);assert.equal(free.usage.paidBuy,false);
  const freeSale=settleGoodsTrade({...request,owner:free.owner,bankGoods:free.bankGoods,usage:free.usage,direction:'sell'});
  assert.equal(freeSale.turnoverReward,0);
  const sold={...newTradeUsage(),sold:true};
  assert.throws(()=>settleGoodsTrade({...request,owner:owner('R19',{},2),usage:sold}),/银两不足/);
  const reverse=settleGoodsTrade({...request,owner:owner('R19',{},3),usage:sold});
  assert.equal(reverse.owner.silver,1);assert.equal(reverse.turnoverReward,1);assert.equal(reverse.bankSilverDelta,2);
});
test('整笔守恒、独立银行收支和失败不动钱货／额度',()=>{
  for(const request of [input('R23'),input('R01'),input('R07',{owner:owner('R07',{timber:1,painting:1,silk:1}),definitionId:'yousei.xg13',direction:'sell',materials:{timber:1,painting:1,silk:1},broker:true})]){
    const before=structuredClone(request),out=settleGoodsTrade(request);
    assert.equal(out.owner.silver-request.owner.silver+out.bankSilverDelta,0);
    for(const {id} of GOODS)assert.equal(request.owner.goods[id]+request.bankGoods[id],out.owner.goods[id]+out.bankGoods[id]);
    assert.deepEqual(request,before);
  }
  const request=input('R01',{owner:owner('R01',{},1)}),before=structuredClone(request);
  assert.throws(()=>settleGoodsTrade(request),/银两不足/);assert.deepEqual(request,before);
  for(const bookLayers of [-1,0.5,'1',Number.MAX_SAFE_INTEGER])assert.throws(()=>quoteGoodsTrade({...input('R01'),bookLayers}),RangeError);
  assert.throws(()=>quoteGoodsTrade({...input('R01'),usage:{...newTradeUsage(),specialistBuy:null}}),RangeError);
  for(const usage of [{...newTradeUsage(),specialistBuy:true},{...newTradeUsage(),turnoverReward:true},{...newTradeUsage(),accountant:true}]){
    assert.throws(()=>quoteGoodsTrade({...input('R01'),usage}),RangeError);
  }
  assert.throws(()=>settleGoodsTrade(input('R08',{owner:owner('R08',{firearms:3},Number.MAX_SAFE_INTEGER),direction:'sell'})),/超出/);
});
