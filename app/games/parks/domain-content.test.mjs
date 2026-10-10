import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture,give,card,passion,op,action,commit,settleEffects,player,zeroResources } from './test-support/fixtures.mjs';
import { privateView,stateProblem,applyGameAction,applySystemStep,nextSystemStep } from './engine.mjs';
import { finalResult } from './rules/scoring.mjs';
import { gearHooks } from './rules/effects.mjs';
import { createOpportunity } from './rules/model.mjs';
import { CAMPING_TILES } from './content/catalog.mjs';

// Recorded independently from the publisher's full 63-card original, before
// catalog comparison (441 fields, original SHA in independent-review.md).
const parksOracle=JSON.parse(readFileSync(new URL('./test-support/park-oracle.json',import.meta.url),'utf8'));
for(const [id,points,mountain,forest,sun,water,wildlife,instant] of parksOracle)test(`63-card actual visit and reward: ${id}`,()=>{
 let s=fixture();passion(s,'passion.collecting');give(s,{mountain,forest,sun,water,wildlife});card(s,'parks',id);op(s,[{kind:'parks'}]);
 const before=structuredClone(player(s,'a').resources),canteens=player(s,'a').canteenRows.flatMap(r=>r.tokens).length;
 const intent=action(s,c=>c.type==='resolve-opportunity'&&c.fields.action==='visit'&&c.fields.targetId===id);
 assert.deepEqual(intent.payment,{mountain,forest,sun,water,wildlife});s=commit(s,intent);s=settleEffects(s,{onlyRequired:true});
 assert.deepEqual(player(s,'a').visited,[id]);assert.equal(stateProblem(s),null);
 const [,amountText]=instant.split(':'),amount=Number(amountText??0),owner=player(s,'a');
 if(instant.startsWith('gain-'))assert.equal(owner.resources[instant.slice(5).split(':')[0]],amount);
 if(instant.startsWith('canteen:'))assert.equal(owner.canteenRows.flatMap(r=>r.tokens).length,canteens+1);
 if(instant.startsWith('badge:'))assert.equal(s.shutterbugOwnerId,'a');
 if(instant.startsWith('die:'))assert.equal(owner.resources.forest,1);
 if(instant==='none')assert.deepEqual(owner.resources,zeroResources());
 assert.equal(finalResult(s,s.committedAt).scores.find(row=>row.playerId==='a').breakdown.parks,points);
});

// Independent literal table from the frozen rule facts. Each item creates its
// real trigger, then commits the same user/system actions as the actual room.
const gearOracle=[
 ['site.water','fire'],['site.sun','fire'],['site.forest','fire'],['site.mountain','fire'],
 ['site.water','photo'],['site.sun','photo'],['site.forest','photo'],['site.mountain','photo'],
 ['wildlife-trade','canteen'],['reserve-park','canteen'],['wildlife-trade','photo'],['reserve-park','photo'],['roll-die','photo'],
 ['wildlife-trade','reserve'],['roll-die','reserve'],['site.water','reserve'],['site.sun','reserve'],['site.forest','reserve'],['site.mountain','reserve'],
 ['paid-photo','die'],['wildlife-trade','sun:2'],['paid-photo','sun:2'],['wildlife-trade','water:2'],['paid-photo','water:2'],
 ['reserve-park','mountain:1'],['site.sun','mountain:1'],['site.mountain','mountain:1'],['reserve-park','forest:1'],['site.water','forest:1'],['site.forest','forest:1'],
 ['roll-die','die'],['site.mountain','sun:2,fire'],['site.forest','sun:2,fire'],['site.water','wildlife:1'],['site.sun','wildlife:1'],['site.forest','wildlife:1'],['site.mountain','wildlife:1']];
gearOracle.forEach(([trigger,expected],index)=>test(`37 gear effect execution and once-window bound: ${index+1}`,()=>{
 let s=fixture();passion(s,'passion.collecting');const owner=give(s,{mountain:4,forest:4,sun:4,water:4,wildlife:4});card(s,'gear',`gear.${String(index+1).padStart(2,'0')}`,'a');
 const before=structuredClone(owner),gearId=owner.gear[0];
 if(trigger.startsWith('site.')){s.currentSiteId=trigger;s.arrivalMode='normal';gearHooks(s,owner,'site-arrival');}
 else gearHooks(s,owner,trigger);
 assert.equal(s.opportunities.length,1);assert.equal(s.opportunities[0].sourceId,gearId);s=settleEffects(s);const after=player(s,'a');
 for(const part of expected.split(',')){
  if(part==='fire')assert.equal(after.campfire,true);
  else if(part==='photo')assert.equal(after.photos,before.photos+1);
  else if(part==='reserve')assert.equal(after.reserved.length,before.reserved.length+1);
  else if(part==='canteen')assert.equal(after.canteenRows.flatMap(r=>r.tokens).length,before.canteenRows.flatMap(r=>r.tokens).length+1);
  else if(part==='die')assert.equal(after.resources.forest,before.resources.forest+1);
  else {const [resource,count]=part.split(':');assert.equal(after.resources[resource],before.resources[resource]+Number(count));}
 }
 assert.ok(s.windowUsage.gear.includes(gearId));const count=s.opportunities.length;gearHooks(s,after,trigger.startsWith('site.')?'site-arrival':trigger);assert.equal(s.opportunities.length,count);
 assert.equal(stateProblem(s),null);
}));

for(const [tokenId,effect] of [['canteen.token.1','mountain'],['canteen.token.6','forest'],['canteen.token.11','sun'],['canteen.token.16','parks'],['canteen.token.19','photo'],['canteen.token.22','wildlife']])test(`all 6 canteen effects consume only a newly acquired water: ${effect}`,()=>{
 let s=fixture();passion(s,'passion.collecting');const owner=give(s,{mountain:3,forest:3,sun:3,water:3,wildlife:3});
 owner.canteenRows[1].tokens.push(...owner.canteenRows[0].tokens);owner.canteenRows[0].tokens=[];card(s,'canteens',tokenId,'a',0);
 const before=structuredClone(owner);s.bankResources.water-=1;
 createOpportunity(s,'a','site.water',[{kind:'new-water'}],{mandatory:true,kind:'new-water',started:true,data:{heldWater:1}});
 s=commit(s,action(s,c=>c.type==='allocate-water'&&c.fields.rowIndex===0));s=settleEffects(s);
 assert.equal(player(s,'a').canteenRows[0].filled,true);
 if(['mountain','forest','sun','wildlife'].includes(effect))assert.equal(player(s,'a').resources[effect],before.resources[effect]+(effect==='sun'?2:1));
 if(effect==='photo')assert.equal(player(s,'a').photos,1);if(effect==='parks')assert.equal(player(s,'a').reserved.length,1);
 assert.ok(!privateView(s,'a').legalActions.some(c=>c.type==='allocate-water'));assert.equal(stateProblem(s),null);
});

// Full eight faces, all 32 slots. Costs and expected core outcomes are explicit
// test literals rather than an inverse of behavior-data's compiler.
const campOracle={
 1:[['photo',1,{sun:1,water:1,mountain:1,forest:1},0,0,0],['none',0,{},0,1,1],['mountain',1,{sun:5},0,0,0],['none',0,{},1,0,0,'park']],
 2:[['photo',1,{wildlife:2},0,0,0],['none',0,{mountain:1,water:1},0,0,0],['forest',1,{water:5},0,0,0],['none',0,{},1,0,0,'badge']],
 3:[['wildlife',1,{forest:3},0,0,0],['none',0,{mountain:1},1,0,0],['water',1,{wildlife:2},0,0,0],['none',0,{sun:2},0,1,0]],
 4:[['wildlife',1,{mountain:3},0,0,0],['none',0,{forest:1},1,0,0],['sun',1,{forest:2},0,0,0],['none',0,{wildlife:2},0,0,0,'trade']],
 11:[['none',0,{wildlife:1},0,0,0],['photo',1,{sun:1,water:1,mountain:1,forest:1},0,0,0],['none',0,{forest:1},1,0,0],['none',0,{sun:2},0,1,0]],
 12:[['photo',1,{wildlife:2},0,0,0],['wildlife',1,{forest:3},0,0,0],['none',0,{mountain:1},1,0,0],['none',0,{wildlife:2},0,0,0,'trade']],
 13:[['forest',1,{sun:5},0,0,0],['water',1,{forest:2},0,0,0],['wildlife',1,{mountain:3},0,0,0],['none',0,{},1,0,0,'badge']],
 14:[['none',0,{mountain:1,water:1},0,0,0],['mountain',1,{water:5},0,0,0],['sun',1,{wildlife:2},0,0,0],['none',0,{},1,0,0,'park']],
};
for(const [face,slots] of Object.entries(campOracle))slots.forEach(([cost,amount,reward,photos,gears,canteens,extra],index)=>test(`32 camping slots actual move/fee/core execution: ${face}.${index+1}`,()=>{
 let s=fixture({camping:true});passion(s,'passion.collecting');give(s,{mountain:4,forest:4,sun:4,water:4,wildlife:4});player(s,'a').photos=5;card(s,'gear','gear.01');
 const faceId=`camp.face.${face}`,tile=CAMPING_TILES.find(tile=>tile.faceIds.includes(faceId));const other=CAMPING_TILES.filter(value=>value.id!==tile.id);
 s.camping.seasonBoards=[{tileId:tile.id,faceId},...other.slice(0,2).map(value=>({tileId:value.id,faceId:value.faceIds[0]}))];s.camping.unusedTiles=[other[2].id];s.stage='move';
 const before=structuredClone(player(s,'a')),slotId=`${faceId}.slot.${index+1}`;
 s=commit(s,action(s,c=>c.type==='move-hiker'&&c.fields.position===5&&c.fields.campingSlotId===slotId));s=settleEffects(s,{onlyRequired:true});const after=player(s,'a');
 assert.equal(s.camping.tents[0].slotId,slotId);assert.equal(after.photos,before.photos-(cost==='photo'?amount:0)+photos);
 assert.equal(after.gear.length,before.gear.length+gears);assert.equal(after.canteenRows.flatMap(row=>row.tokens).length,before.canteenRows.flatMap(row=>row.tokens).length+canteens);
 if(extra==='park')assert.equal(after.reserved.length,before.reserved.length+1);if(extra==='badge')assert.equal(s.shutterbugOwnerId,'a');
 const corePayment=zeroResources();if(gears)corePayment.sun=1;if(photos)corePayment.water=1;if(extra==='trade')corePayment.water=2;
 for(const key of Object.keys(corePayment))assert.equal(after.resources[key],before.resources[key]+(reward[key]??0)-(cost===key?amount:0)-corePayment[key],`${key} outcome`);
 assert.equal(stateProblem(s),null);
}));
