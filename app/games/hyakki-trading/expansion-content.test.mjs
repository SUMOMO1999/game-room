import test from 'node:test';
import assert from 'node:assert/strict';
import {CARDS as oldCards,GOODS as oldGoods,CONTENT_VERSION,PLAYER_COUNT_CONTENT_VERSION,createDeck as oldDeck} from './content/definitions.mjs';
import {CARDS,GOODS,CATEGORIES,ROLES,EXPANSION_CONTENT_VERSION,LEGACY_EXPANSION_CONTENT_VERSION,createExpansionDeck,expansionProfile,expansionPartitionProblem,expansionDefinitionForCopy,getExpansionCard,getRole} from './content/expansion-one.mjs';
import {waitingConfiguration,updateWaitingConfiguration,freezeMatchConfiguration,materialForConfiguration} from './opening-configuration.mjs';

const ids=Array.from({length:6},(_,i)=>(i+1).toString(16).repeat(32));
const totals=[183,228,273,318,363];
const categoryCounts=[
  {goods:74,ordinary_character:50,monitored_character:22,tool:32,stall_permit:5},
  {goods:94,ordinary_character:66,monitored_character:24,tool:38,stall_permit:6},
  {goods:114,ordinary_character:82,monitored_character:26,tool:44,stall_permit:7},
  {goods:134,ordinary_character:98,monitored_character:28,tool:50,stall_permit:8},
  {goods:154,ordinary_character:114,monitored_character:30,tool:56,stall_permit:9},
];
for(let people=2;people<=6;people++)test(`${people}人实际生成完整牌实体并按牌类独立核账`,()=>{
  const deck=createExpansionDeck(people),profile=expansionProfile(people);
  assert.equal(deck.length,totals[people-2]);assert.equal(new Set(deck.map(c=>c.id)).size,deck.length);
  assert.equal(new Set(deck.map(c=>c.definitionId)).size,103);
  assert.deepEqual(deck.reduce((all,c)=>{const kind=getExpansionCard(c.definitionId).category;all[kind]=(all[kind]??0)+1;return all;},{}),categoryCounts[people-2]);
  assert.equal(profile.goodsPerTypeRecommended,people*3);assert.equal(profile.stallBoards,people+3);
  assert.equal(expansionPartitionProblem(deck.map(c=>c.id),people),null);
  const remaining=[...deck],hands=Array.from({length:people},()=>remaining.splice(0,5));
  assert.equal(remaining.length,totals[people-2]-5*people);
  assert.equal(expansionPartitionProblem([...remaining,...hands.flat()].map(c=>c.id),people),null);
});
test('6类各2货、角色与主牌分区、G19始终只取旧六货',()=>{
  assert.equal(CATEGORIES.length,6);assert.equal(GOODS.length,12);assert.equal(ROLES.length,24);
  for(const c of CATEGORIES)assert.equal(GOODS.filter(g=>g.category===c.id).length,2);
  assert.equal(CARDS.length,103);assert.equal(CARDS.filter(c=>c.original).length,51);
  const g19=getExpansionCard('yousei.g19');assert.deepEqual(g19.goods,Object.fromEntries(oldGoods.map(g=>[g.id,1])));
  for(const role of ROLES){assert.equal(expansionDefinitionForCopy(role.id+'#01',6),null);if(role.sourceCode!=='R12')assert.equal(getRole(role.id),role);}
  assert.equal(getRole('yousei.role.r12').initialSilver,26);
});
test('混包、重复、缺失和超出本人数的副本均拒绝',()=>{
  const deck=createExpansionDeck(2).map(c=>c.id),copy=deck.at(-1);
  assert.match(expansionPartitionProblem([...deck.slice(1),deck[1]],2),/重复/);
  assert.match(expansionPartitionProblem(deck.slice(1),2),/总数/);
  assert.match(expansionPartitionProblem([...deck.slice(0,-1),'yousei.role.r01#01'],2),/未知/);
  assert.match(expansionPartitionProblem([...deck.slice(0,-1),'yousei.g01#03'],2),/人数/);
  for(const bad of ['yousei.g01#00','yousei.g01#1','yousei.g01#01tail','yousei.unknown#01',null])assert.equal(expansionDefinitionForCopy(bad,2),null);
  assert.equal(expansionDefinitionForCopy(copy,2),copy.split('#')[0]);
  for(const count of [1,7,2.5,'2',NaN])assert.throws(()=>createExpansionDeck(count),RangeError);
});
test('原版v1／v2的定义、六货和既有牌量保持',()=>{
  assert.equal(oldCards.length,51);assert.equal(oldGoods.length,6);
  for(let n=2;n<=6;n++){
    assert.equal(oldDeck({contentVersion:CONTENT_VERSION,playerCount:n}).length,110);
    assert.equal(oldDeck({contentVersion:PLAYER_COUNT_CONTENT_VERSION,playerCount:n}).length,110+(n-2)*34);
  }
});
test('新房默认开扩展，旧房缺包仍为原版，均默认60',()=>{
  assert.equal(waitingConfiguration({},{playerCount:2,newRoom:true}).packId,'six-trades-v1');
  const old=waitingConfiguration({actionLimit:5,goodsPerType:9},{playerCount:3});
  assert.equal(old.packId,'base');assert.equal(old.closingTarget,60);assert.equal(old.goodsSupplyMode,'custom');
  const off=waitingConfiguration({packId:'base',closingTarget:100},{playerCount:4,newRoom:true});
  assert.equal(off.packId,'base');assert.equal(off.closingTarget,100);
});
test('人数变化真正切配表；推荐跟人数，手选保持',()=>{
  const initial=waitingConfiguration({},{playerCount:2,newRoom:true});
  const changed=updateWaitingConfiguration(initial,{},6);assert.equal(changed.configuration.goodsPerType,18);assert.equal(changed.changed,true);
  const custom=updateWaitingConfiguration(initial,{goodsPerType:17},2).configuration;
  assert.equal(updateWaitingConfiguration(custom,{},6).configuration.goodsPerType,17);
  for(let n=2;n<=6;n++){
    const frozen=freezeMatchConfiguration(initial,ids.slice(0,n));
    assert.equal(materialForConfiguration(frozen).deckSize,totals[n-2]);assert.equal(frozen.goodsPerType,n*3);
    assert.throws(()=>{frozen.playerCount=6;},TypeError);
  }
});
test('非法金额、包、人数与冻结值篡改不能进入开局',()=>{
  for(const closingTarget of [0,26,35,201,'60',Infinity,NaN])assert.throws(()=>waitingConfiguration({closingTarget},{playerCount:2,newRoom:true}),RangeError);
  for(const closingTarget of [30,60,200])for(const packId of ['base','six-trades-v1']){
    const frozen=freezeMatchConfiguration(waitingConfiguration({packId,closingTarget},{playerCount:2,newRoom:true}),ids.slice(0,2));
    assert.equal(frozen.closingTarget,closingTarget);assert.ok(materialForConfiguration(frozen).deckSize>=110);
  }
  const initial=freezeMatchConfiguration(waitingConfiguration({},{playerCount:2,newRoom:true}),ids.slice(0,2));
  assert.throws(()=>materialForConfiguration({...initial,playerCount:6}),RangeError);
  assert.throws(()=>materialForConfiguration({...initial,contentVersion:'latest'}),RangeError);
  assert.throws(()=>materialForConfiguration({...initial,cheat:true}),RangeError);
  assert.throws(()=>freezeMatchConfiguration({},[ids[0],ids[0]]),RangeError);
  assert.throws(()=>waitingConfiguration({packId:'latest'},{playerCount:2}),RangeError);
});
