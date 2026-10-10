import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,give,card,passion,op,action,commit,settleEffects,player,zeroResources } from './test-support/fixtures.mjs';
import { createGame,privateView,spectatorView,stateProblem,nextSystemStep,applySystemStep,applyGameAction } from './engine.mjs';
import { createOpportunity,openWindow,RESOURCE_KEYS } from './rules/model.mjs';
import { prepareAwards,nextAward,completeSeason } from './rules/flow.mjs';
import { seasonWinners,finalResult } from './rules/scoring.mjs';
import { SEASON_BEHAVIORS } from './content/behavior-data.mjs';

const teddyEnds=['parks','photo','gear'];
for(let number=1;number<=21;number++)test(`21 Teddy cards execute front movement and NEW top back selector: ${number}`,()=>{
 let s=fixture({mode:'teddy'});const target=`teddy.${number}`,successor=number===4?'teddy.1':'teddy.4';
 s.teddy.deck=[target,successor,...s.teddy.deck.filter(id=>id!==target&&id!==successor)];s.teddy.discard=[];
 const teddy=s.controllers[0];teddy.hikers[0].position=1;teddy.hikers[1].position=3;player(s,'a').hikers[0].position=4;
 s.controllerIndex=0;s.turnPlayerId='system.teddy';s.turnIndex=-1;s.stage='teddy-draw';openWindow(s,'system',null,0);
 s.teddy.batch={remainingGroups:['teddy.amber'],drawn:null,selectedGroup:null,first:true};assert.equal(stateProblem(s),null);
 const original=JSON.stringify(s.players),market=JSON.stringify(s.markets),badge=s.shutterbugOwnerId;
 let step=nextSystemStep(s),result=applySystemStep(s,step,{now:1,serverRandomInt:()=>0});assert.equal(result.ok,true,result.error);s=JSON.parse(JSON.stringify(result.state));
 assert.equal(s.teddy.lastDraw.selection,successor==='teddy.1'?'front':'back');
 step=nextSystemStep(s);result=applySystemStep(s,step,{now:2,serverRandomInt:()=>0});assert.equal(result.ok,true,result.error);s=result.state;
 const selected=successor==='teddy.1'?s.controllers[0].hikers[1]:s.controllers[0].hikers[0],start=successor==='teddy.1'?3:1;
 const distance=number<=9?null:number<=18?2:3;assert.equal(selected.position,distance?start+distance:start===3?5:2);
 assert.equal(JSON.stringify(s.players),original);assert.equal(JSON.stringify(s.markets),market);assert.equal(s.shutterbugOwnerId,badge);
});
test('Teddy end reward uses revealed front, only human controller last must end; stable entity tie',()=>{
 let s=fixture({mode:'teddy'});const teddy=s.controllers[0];teddy.hikers.forEach(h=>h.position=9);
 s.teddy.deck=['teddy.21','teddy.1',...s.teddy.deck.filter(id=>!['teddy.21','teddy.1'].includes(id))];s.teddy.discard=[];
 s.controllerIndex=0;s.turnPlayerId='system.teddy';s.turnIndex=-1;s.stage='teddy-draw';openWindow(s,'system',null,0);s.teddy.batch={remainingGroups:['teddy.amber'],drawn:null,selectedGroup:null,first:true};
 let result=applySystemStep(s,nextSystemStep(s),{now:1,serverRandomInt:()=>0});assert.equal(result.ok,true);s=result.state;
 result=applySystemStep(s,nextSystemStep(s),{now:2,serverRandomInt:()=>0});assert.equal(result.ok,true);s=result.state;
 assert.equal(s.controllers[0].hikers[0].position,10);assert.equal(s.controllers[0].hikers[0].endSlot,'gear');assert.equal(s.endRewards.gear,true);
});
test('solo Teddy color decision saves first draw, no human turn between colors, and tent has priority',()=>{
 let s=fixture({mode:'solo',camping:true});const teddy=s.controllers[0];teddy.hikers[0].position=3;teddy.hikers[1].position=0;
 s.teddy.deck=['teddy.10','teddy.1',...s.teddy.deck.filter(id=>!['teddy.10','teddy.1'].includes(id))];s.teddy.discard=[];
 s.controllerIndex=0;s.turnPlayerId='system.teddy';s.turnIndex=-1;s.stage='teddy-draw';openWindow(s,'system',null,0);s.teddy.batch={remainingGroups:['teddy.amber','teddy.blue'],drawn:null,selectedGroup:null,first:true};
 const market=JSON.stringify(s.markets),weather=s.trail[4].weather;
 let result=applySystemStep(s,nextSystemStep(s),{now:1,serverRandomInt:()=>0});assert.equal(result.ok,true);s=result.state;assert.equal(nextSystemStep(s),null);
 assert.equal(s.decisionWindow.responsibleSeatId,'a');const intent=action(s,c=>c.type==='choose-teddy'&&c.fields.groupId==='teddy.amber');s=commit(JSON.parse(JSON.stringify(s)),intent);
 result=applySystemStep(s,nextSystemStep(s),{now:s.committedAt+1,serverRandomInt:()=>0});assert.equal(result.ok,true);s=result.state;
 assert.equal(s.stage,'teddy-draw');assert.equal(s.turnPlayerId,'system.teddy');assert.equal(s.camping.tents[0].slotId,`${s.camping.seasonBoards[0].faceId}.slot.4`);assert.equal(s.trail[4].weather,weather);assert.equal(JSON.stringify(s.markets),market);
 result=applySystemStep(s,nextSystemStep(s),{now:s.committedAt+1,serverRandomInt:()=>0});assert.equal(result.ok,true);s=result.state;assert.ok(nextSystemStep(s));assert.equal(s.decisionWindow.responsibleSeatId,null);
});
test('single last Teddy card is reshuffled before reveal, never drops last entity or rerolls saved draw',()=>{
 let s=fixture({mode:'teddy'});s.teddy.discard=s.teddy.deck.slice(1);s.teddy.deck=s.teddy.deck.slice(0,1);s.controllerIndex=0;s.turnPlayerId='system.teddy';s.turnIndex=-1;s.stage='teddy-draw';openWindow(s,'system',null,0);s.teddy.batch={remainingGroups:['teddy.amber'],drawn:null,selectedGroup:null,first:true};
 const step=nextSystemStep(s),result=applySystemStep(s,step,{now:1,serverRandomInt:()=>0});assert.equal(result.ok,true);assert.equal(result.state.teddy.shuffleGeneration,1);assert.equal(result.state.teddy.deck.length,20);assert.equal(result.state.teddy.discard.length,1);
 assert.equal(applySystemStep(result.state,step,{now:2,serverRandomInt:()=>{throw new Error('reroll');}}).ok,false);
});

for(const [id,resource,expected] of [['season.1.1','sun','gear'],['season.1.2','water','canteen'],['season.1.3','forest','reserve'],['season.1.4','mountain','photo'],
 ['season.2.1','gear','dice'],['season.2.2','wildlife','dice'],['season.2.3','canteen','dice'],['season.2.4','instant','dice'],
 ['season.3.1','sun','points'],['season.3.2','forest','points'],['season.3.3','mountain','points'],['season.3.4','water','points']])test(`12 season rewards freeze eligibility and execute: ${id}`,()=>{
 let s=fixture();passion(s,'passion.collecting');const owner=player(s,'a');const index=Number(id.split('.')[1])-1;s.seasonIndex=index;s.seasons[index]=id;
 if(index===0||resource==='wildlife')give(s,{[resource]:3});else if(resource==='gear')card(s,'gear','gear.01','a');else if(resource==='canteen')card(s,'canteens','canteen.token.2','a',1);else if(resource==='instant')card(s,'parks','big-bend','a','visited');else card(s,'parks',{sun:'arches',forest:'congaree',mountain:'zion',water:'everglades'}[resource],'a','visited');
 const before=structuredClone(owner);s.stage='season-awards';openWindow(s,'system',null,0);let awarded=applySystemStep(s,nextSystemStep(s),{now:1,serverRandomInt:()=>0});assert.equal(awarded.ok,true);s=awarded.state;assert.deepEqual(s.seasonRewardQueue,['a']);awarded=applySystemStep(s,nextSystemStep(s),{now:2,serverRandomInt:()=>0});assert.equal(awarded.ok,true);s=settleEffects(awarded.state,{onlyRequired:true});const after=player(s,'a');
 if(expected==='gear'){assert.equal(after.gear.length,before.gear.length+1);assert.equal(after.gearPurchases,0);}
 if(expected==='canteen')assert.equal(after.canteenRows.flatMap(r=>r.tokens).length,before.canteenRows.flatMap(r=>r.tokens).length+1);
 if(expected==='reserve')assert.equal(after.reserved.length,before.reserved.length+1);if(expected==='photo')assert.equal(after.photos,before.photos+1);
 if(expected==='dice')assert.equal(after.resources.forest,before.resources.forest+2);if(expected==='points')assert.equal(after.bonusPoints,before.bonusPoints+3);
 assert.equal(stateProblem(s),null);
});
test('season qualification ties freezes order at First Hiker and positive requirement; solo thresholds 3/4/5',()=>{
 let s=fixture();s.seasons[0]='season.1.1';give(s,{sun:1},'a');give(s,{sun:1},'b');s.firstPlayerId='b';assert.deepEqual(seasonWinners(s),['b','a']);prepareAwards(s,{now:1});give(s,{sun:2},'a');assert.deepEqual(s.seasonRewardQueue,['b','a']);
 const solo=fixture({mode:'solo'});solo.seasons[0]='season.1.1';give(solo,{sun:2});assert.deepEqual(seasonWinners(solo),[]);give(solo,{sun:1});assert.deepEqual(seasonWinners(solo),['a']);
 let teddy=fixture({mode:'teddy'});teddy.seasons[0]='season.1.1';give(teddy,{sun:1},'a');give(teddy,{sun:1},'b');teddy.firstPlayerId=teddy.controllers.find(controller=>controller.kind!=='human').id;
 assert.deepEqual(seasonWinners(teddy),['a','b']);teddy.stage='season-awards';openWindow(teddy,'system',null,0);
 const qualified=applySystemStep(teddy,nextSystemStep(teddy),{now:1,serverRandomInt:()=>0});assert.equal(qualified.ok,true);teddy=qualified.state;assert.deepEqual(teddy.seasonRewardQueue,['a','b']);
 const first=applySystemStep(teddy,nextSystemStep(teddy),{now:2,serverRandomInt:()=>0});assert.equal(first.ok,true);teddy=first.state;assert.equal(teddy.decisionWindow.responsibleSeatId,'a');assert.deepEqual(teddy.seasonRewardQueue,['b']);
 teddy.firstPlayerId='b';give(teddy,{sun:1},'b');assert.deepEqual(teddy.seasonRewardQueue,['b']);teddy=commit(teddy,action(teddy,c=>c.type==='finish-window'));
 const second=applySystemStep(teddy,nextSystemStep(teddy),{now:teddy.committedAt+1,serverRandomInt:()=>0});assert.equal(second.ok,true);assert.equal(second.state.decisionWindow.responsibleSeatId,'b');assert.equal(stateProblem(second.state),null);
});
test('season reset returns old weather/filled water first, relights fire, replaces rightmost gear, conserves all tokens',()=>{
 let s=fixture({camping:true});const owner=player(s,'a');s.bankResources.water--;owner.canteenRows[0].filled=true;owner.campfire=false;give(s,{water:2});
 const right=s.markets.gear[2],ownedWater=owner.resources.water;completeSeason(s,{now:1,serverRandomInt:()=>0});assert.equal(s.seasonIndex,1);assert.equal(owner.canteenRows[0].filled,false);assert.equal(owner.resources.water,ownedWater);assert.equal(owner.campfire,true);assert.ok(s.removed.gear.includes(right));assert.equal(stateProblem(s),null);
});
