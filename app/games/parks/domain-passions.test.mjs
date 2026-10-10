import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,give,card,passion,op,action,commit,settleEffects,player,zeroResources } from './test-support/fixtures.mjs';
import { privateView,stateProblem,nextSystemStep,applySystemStep } from './engine.mjs';
import { createOpportunity,passionById,parkById } from './rules/model.mjs';
import { parkCosts } from './rules/resources.mjs';
import { finalResult } from './rules/scoring.mjs';

const goals=[
 ['adventure',['big-bend'],'canyonlands',2],['birdwatching',['arches'],'big-bend',2],['botany',['congaree'],'acadia',3],
 ['forestry',['acadia','congaree'],'shenandoah',3],['kayaking',['big-bend'],'acadia',2],['mountaineering',['arches','badlands'],'zion',3],
 ['rock-climbing',['canyonlands'],'arches',3],['swimming',['big-bend'],'acadia',3],
];
for(const [key,previous,target,metric] of goals)test(`PARKS passion objective ${key} chooses once after actual visit without replay`,()=>{
 let s=fixture();passion(s,`passion.${key}`);give(s,{mountain:4,forest:4,sun:4,water:4,wildlife:3});for(const id of previous)card(s,'parks',id,'a','visited');card(s,'parks',target);op(s,[{kind:'parks'}]);
 s=commit(s,action(s,c=>c.fields.action==='visit'&&c.fields.targetId===target));
 assert.equal(player(s,'a').passionBranch,null);assert.equal(privateView(s,'a').players.find(p=>p.id==='a').passionProgress,metric);
 assert.ok(privateView(s,'a').legalActions.every(c=>c.type==='choose-passion'));
 const chosen=action(s,c=>c.type==='choose-passion'&&c.fields.choice==='ability');s=commit(s,chosen);
 assert.equal(player(s,'a').passionBranch,'ability');assert.ok(!privateView(s,'a').legalActions.some(c=>c.type==='choose-passion'));
 if(key==='adventure')assert.ok(!s.opportunities.some(o=>o.kind==='passion-bonus'));
 if(['birdwatching','forestry','kayaking','mountaineering'].includes(key)){
  const resource={birdwatching:'sun',forestry:'forest',kayaking:'water',mountaineering:'mountain'}[key],definition=parkById.get(target),quote=parkCosts(s,player(s,'a'),definition);
  assert.equal(quote.actualCost[resource],Math.max(0,definition.cost[resource]-1));assert.deepEqual(quote.printedCost,definition.cost);
 }
 assert.equal(stateProblem(s),null);
 const scoring=structuredClone(s);player(scoring,'a').passionBranch='scoring';const definition=passionById.get(`passion.${key}`);assert.equal(finalResult(scoring,100).scores.find(row=>row.playerId==='a').breakdown.passion,Math.floor(metric/definition.score.divisor));
});
test('Collecting second purchase completes goal without refund; subsequent buy costs zero and counts even zero fee',()=>{
 let s=fixture();passion(s,'passion.collecting');give(s,{sun:1});card(s,'gear','gear.01','a');player(s,'a').gearPurchases=1;card(s,'gear','gear.02');op(s,[{kind:'gear'}]);
 s=commit(s,action(s,c=>c.fields.action==='buy-gear'&&c.fields.targetId==='gear.02'));assert.equal(player(s,'a').resources.sun,0);s=commit(s,action(s,c=>c.type==='choose-passion'&&c.fields.choice==='ability'));assert.equal(player(s,'a').resources.sun,0);
 card(s,'gear','gear.03');op(s,[{kind:'gear'}]);const third=action(s,c=>c.fields.action==='buy-gear'&&c.fields.targetId==='gear.03');assert.deepEqual(third.payment,zeroResources());s=commit(s,third);assert.equal(player(s,'a').gearPurchases,3);
 const scoring=structuredClone(s);player(scoring,'a').passionBranch='scoring';assert.equal(finalResult(scoring,10).scores.find(r=>r.playerId==='a').breakdown.passion,3);
});
test('Wildlife is actual paid-photo objective, no retroactive boost; one Wildlife boost plus one badge gives maximum3',()=>{
 let s=fixture();passion(s,'passion.wildlife');give(s,{wildlife:2,sun:2});op(s,[{kind:'photo'}]);const first=action(s,c=>c.fields.action==='take-photo');first.payment={...zeroResources(),wildlife:1};s=commit(s,first);assert.equal(player(s,'a').photos,1);s=commit(s,action(s,c=>c.type==='choose-passion'&&c.fields.choice==='ability'));assert.equal(player(s,'a').photos,1);
 s.shutterbugOwnerId='a';op(s,[{kind:'photo'}]);const three=action(s,c=>c.fields.action==='take-photo'&&c.fields.count===2&&c.fields.wildlifeBoost);s=commit(s,three);assert.equal(player(s,'a').photos,4);assert.ok(s.windowUsage.badge);assert.ok(s.windowUsage.passion.includes('passion.wildlife'));
 op(s,[{kind:'photo'}]);assert.ok(privateView(s,'a').legalActions.filter(c=>c.fields.action==='take-photo').every(c=>c.fields.count===1&&!c.fields.wildlifeBoost));
 const scoring=structuredClone(s);player(scoring,'a').passionBranch='scoring';assert.equal(finalResult(scoring,10).scores.find(r=>r.playerId==='a').breakdown.passion,1);
});
for(const [key,resource,qualifying] of [['botany','forest',['congaree','acadia']],['rock-climbing','mountain',['canyonlands','arches']]])test(`${key} replaces exactly one before inventory check, ordinary empty pool still works, once per window`,()=>{
 let s=fixture();passion(s,`passion.${key}`,'a','ability');for(const id of qualifying)card(s,'parks',id,'a','visited');player(s,'b').resources[resource]+=s.bankResources[resource];s.bankResources[resource]=0;
 op(s,[{kind:'gain',resources:{[resource]:2}}],{started:false,sourceId:`site.${resource}`});s=commit(s,action(s,c=>c.type==='use-opportunity'));
 const choice=privateView(s,'a').legalActions.find(c=>c.fields.action==='replace-gain'&&c.fields.choice==='wildlife');assert.equal(choice.result.resources.wildlife,1);assert.equal(choice.result.resources[resource],0);
 s=commit(s,choice.fields);assert.equal(player(s,'a').resources.wildlife,1);assert.equal(player(s,'a').resources[resource],0);
 op(s,[{kind:'gain',resources:{[resource]:1}}],{started:false,sourceId:`site.${resource}`});s=commit(s,action(s,c=>c.type==='use-opportunity'));assert.ok(!privateView(s,'a').legalActions.some(c=>c.fields.action==='replace-gain'));assert.equal(player(s,'a').resources.wildlife,1);
});
test('Swimming one row fill gives one extra die, second row same window cannot reset allowance',()=>{
 let s=fixture();passion(s,'passion.swimming','a','ability');card(s,'parks','big-bend','a','visited');card(s,'parks','acadia','a','visited');card(s,'canteens','canteen.token.1','a',1);
 for(let index=0;index<2;index++){
  s.bankResources.water--;createOpportunity(s,'a','site.water',[{kind:'new-water'}],{mandatory:true,kind:'new-water',started:true,data:{heldWater:1}});
  s=commit(s,action(s,c=>c.type==='allocate-water'&&c.fields.rowIndex===index));
  if(index===0){assert.ok(nextSystemStep(s));const result=applySystemStep(s,nextSystemStep(s),{now:s.committedAt+1,serverRandomInt:()=>0});assert.equal(result.ok,true);s=result.state;}
  else assert.equal(s.opportunities.filter(o=>o.kind==='passion-bonus').length,1);
 }
 assert.ok(s.windowUsage.passion.includes('passion.swimming'));assert.equal(stateProblem(s),null);
});
test('Adventure newly completed instant park cannot replay, later instant visit uses one die per window',()=>{
 let s=fixture();passion(s,'passion.adventure','a','ability');card(s,'parks','big-bend','a','visited');card(s,'parks','canyonlands','a','visited');give(s,{mountain:4,sun:3,water:1});
 for(const target of ['carlsbad-caverns','hawaii-volcanoes']){
  card(s,'parks',target);op(s,[{kind:'parks'}]);s=commit(s,action(s,c=>c.fields.action==='visit'&&c.fields.targetId===target));s=settleEffects(s,{onlyRequired:true});
  assert.equal(s.opportunities.filter(o=>o.kind==='passion-bonus').length,1);
 }
 assert.ok(s.windowUsage.passion.includes('passion.adventure'));assert.equal(stateProblem(s),null);
});
