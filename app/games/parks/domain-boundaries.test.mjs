import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,give,card,passion,op,action,commit,settleEffects,player,zeroResources } from './test-support/fixtures.mjs';
import { createGame,privateView,stateProblem,applyGameAction,nextSystemStep,applySystemStep } from './engine.mjs';
import { createOpportunity,openWindow,RESOURCE_KEYS,RESOURCE_STOCK,backpackCapacity } from './rules/model.mjs';
import { completeSeason } from './rules/flow.mjs';
import { randomStream } from './practice-engine.mjs';
import { gainPreview,parkCosts } from './rules/resources.mjs';
import { canCompleteMandatory } from './rules/legality.mjs';
import { CAMPING_TILES } from './content/catalog.mjs';

function project(state,id){state.configuration.volunteerCount=1;state.projects=[`volunteer.${id}`];}
function poolToOther(state,key){player(state,'b').resources[key]+=state.bankResources[key];state.bankResources[key]=0;}
function campFace(state,number){const faceId=`camp.face.${number}`,tile=CAMPING_TILES.find(value=>value.faceIds.includes(faceId)),others=CAMPING_TILES.filter(value=>value.id!==tile.id);state.camping.seasonBoards=[{tileId:tile.id,faceId},...others.slice(0,2).map(value=>({tileId:value.id,faceId:value.faceIds[0]}))];state.camping.unusedTiles=[others[2].id];state.stage='move';return `${faceId}.slot.`;}
test('D01 optional photo cannot spend last certain gear fee; complete intent allows safe alternative payment',()=>{
 let s=fixture();give(s,{sun:1});card(s,'gear','gear.01');op(s,[{kind:'gear'}]);const photo=op(s,[{kind:'photo'}],{mandatory:false,sourceId:'canteen.token.19',kind:'canteen-effect'});
 assert.ok(!privateView(s,'a').legalActions.some(c=>c.opportunityId===photo.id&&c.fields.action==='take-photo'));
 const forged={type:'resolve-opportunity',matchId:s.matchId,windowId:s.decisionWindow.id,opportunityId:photo.id,action:'take-photo',count:1,wildlifeBoost:false,payment:{...zeroResources(),sun:1}};
 const before=JSON.stringify(s),result=applyGameAction(s,'a',forged,{now:1});assert.equal(result.ok,false);assert.equal(result.errorCode,'CORE_OBLIGATION_PROTECTED');assert.equal(JSON.stringify(s),before);
 give(s,{water:1});const choice=privateView(s,'a').legalActions.find(c=>c.opportunityId===photo.id&&c.fields.action==='take-photo');assert.ok(choice);assert.ok(choice.cost.paymentOptions.every(p=>p.sun===0));s=commit(s,choice.fields);s=commit(s,action(s,c=>c.fields.action==='buy-gear'));assert.equal(player(s,'a').gear.length,1);
});
test('cannot offer to forgo the only certain arrival bonus that funds an outstanding location payment',()=>{
 const s=fixture();card(s,'gear','gear.01');const bonus=op(s,[{kind:'gain',resources:{sun:1}}],{mandatory:false,kind:'end-bonus',sourceId:'end-bonus.gear',started:false});op(s,[{kind:'gear'}],{started:false});
 assert.ok(privateView(s,'a').legalActions.some(c=>c.opportunityId===bonus.id&&c.type==='use-opportunity'));assert.ok(!privateView(s,'a').legalActions.some(c=>c.opportunityId===bonus.id&&c.type==='finish-opportunity'));
});
test('same-site new gear triggers now, action gear never replays past event, camping forfeits normal site hook',()=>{
 let s=fixture();passion(s,'passion.collecting');give(s,{sun:2});s.currentSiteId='site.sun';s.arrivalMode='normal';card(s,'gear','gear.17');op(s,[{kind:'gear'}]);s=commit(s,action(s,c=>c.fields.action==='buy-gear'&&c.fields.targetId==='gear.17'));
 assert.ok(s.opportunities.some(o=>o.sourceId==='gear.17'&&o.kind==='gear'));
 let other=fixture();passion(other,'passion.collecting');give(other,{sun:2});other.currentSiteId='site.sun';other.arrivalMode='camping';card(other,'gear','gear.17');op(other,[{kind:'gear'}]);other=commit(other,action(other,c=>c.fields.action==='buy-gear'&&c.fields.targetId==='gear.17'));assert.ok(!other.opportunities.some(o=>o.sourceId==='gear.17'&&o.kind==='gear'));
 card(other,'gear','gear.12');op(other,[{kind:'gear'}]);other=commit(other,action(other,c=>c.fields.action==='buy-gear'&&c.fields.targetId==='gear.12'));assert.ok(!other.opportunities.some(o=>o.sourceId==='gear.12'&&o.kind==='gear'));
});
test('new water is separately owned; can fill only unfilled nonempty row, backpack water cannot later refill',()=>{
 let s=fixture();give(s,{water:2});const parent=op(s,[{kind:'gain',resources:{water:2}}],{started:false});
 s=commit(s,action(s,c=>c.type==='use-opportunity'));
 assert.equal(s.opportunities.filter(o=>o.kind==='new-water'&&o.status==='open').length,2);assert.equal(player(s,'a').resources.water,2);
 const first=action(s,c=>c.type==='allocate-water'&&c.fields.rowIndex===0);s=commit(s,first);assert.equal(player(s,'a').canteenRows[0].filled,true);
 assert.ok(!privateView(s,'a').legalActions.some(c=>c.type==='allocate-water'&&c.fields.rowIndex===0));s=commit(s,action(s,c=>c.type==='allocate-water'&&c.fields.rowIndex===null));
 assert.equal(player(s,'a').resources.water,3);assert.ok(!privateView(s,'a').legalActions.some(c=>c.type==='allocate-water'));assert.equal(stateProblem(s),null);
});
test('full six canteen slots skip forced benefit but do not offer a seventh or replace an old token',()=>{
 let s=fixture();const owner=player(s,'a'),tokens=['canteen.token.1','canteen.token.2','canteen.token.3','canteen.token.4','canteen.token.5','canteen.token.6'];
 const initial=owner.canteenRows.flatMap(r=>r.tokens);for(const id of initial)card(s,'canteens',id);
 owner.canteenRows.forEach(row=>row.tokens=[]); // fixture relocation below returns removed old token.
 for(let i=0;i<tokens.length;i++)card(s,'canteens',tokens[i],'a',Math.floor(i/2));
 give(s,{forest:2,water:1});card(s,'parks','biscayne');op(s,[{kind:'parks'}]);const before=owner.canteenRows.flatMap(r=>r.tokens);s=commit(s,action(s,c=>c.fields.action==='visit'&&c.fields.targetId==='biscayne'));
 assert.deepEqual(player(s,'a').canteenRows.flatMap(r=>r.tokens),before);assert.ok(!privateView(s,'a').legalActions.some(c=>c.fields.action==='gain-canteen'));assert.equal(stateProblem(s),null);
});
test('known item choices expose correct bottle definition and gear trigger; blind choice reveals neither',()=>{
 let s=fixture();card(s,'canteens','canteen.token.11');op(s,[{kind:'canteen'}]);const bottle=privateView(s,'a').legalActions.find(c=>c.fields.targetId==='canteen.token.11');assert.equal(bottle.label,'取得日光水壶');assert.equal(bottle.result.definitionId,'canteen.sun');assert.deepEqual(bottle.result.program,[{kind:'gain',resources:{sun:2}}]);
 const unknownBottle=privateView(s,'a').legalActions.find(c=>c.fields.targetId==='deck-top');assert.equal(unknownBottle.result.definitionId,null);assert.equal(unknownBottle.result.program,null);
 s=fixture();give(s,{sun:3});card(s,'gear','gear.32');op(s,[{kind:'gear'}]);const gear=privateView(s,'a').legalActions.find(c=>c.fields.targetId==='gear.32');assert.equal(gear.result.trigger.siteId,'site.mountain');assert.ok(gear.result.effectText);assert.deepEqual(gear.result.program,[{kind:'gain',resources:{sun:2}},{kind:'light-fire'}]);assert.equal(privateView(s,'a').legalActions.find(c=>c.fields.targetId==='deck-top').result.program,null);
});
test('D04/D05 no route falls back to a terminal once per hiker, no empty fee; occupied place still requires fire',()=>{
 let s=fixture();s.stage='move';project(s,'environmental-studies');
 // Drain park/gear entities into public removal and all canteens onto panels is
 // unnecessary: zero resource + no reserve targets make every park impossible.
 s.removed.parks.push(...s.decks.parks,...s.markets.parks.filter(Boolean));s.decks.parks=[];s.markets.parks.fill(null);s.endRewards.gear=true;
 // Block every normal location by occupying each with a visible Teddy-like
 // controller is not valid, so put both players near the end instead.
 player(s,'a').hikers.forEach(h=>h.position=9);player(s,'b').hikers.forEach(h=>{h.position=10;h.endSlot='parks';});
 const choices=privateView(s,'a').legalActions;assert.equal(choices.length,6);assert.ok(choices.every(c=>c.result?.fallback&&c.fields.position===10));
 s=commit(s,choices.find(c=>c.fields.endSlot==='parks').fields);assert.ok(s.lastPublicEvents.some(e=>e.type==='base-action-skipped'));assert.equal(player(s,'a').resources.sun,0);
 const occupied=fixture();occupied.stage='move';player(occupied,'b').hikers[0].position=1;assert.ok(!privateView(occupied,'a').legalActions.some(c=>c.fields.position===1));player(occupied,'a').campfire=true;assert.ok(privateView(occupied,'a').legalActions.some(c=>c.fields.position===1));
 const otherStillMoving=fixture();otherStillMoving.stage='move';project(otherStillMoving,'environmental-studies');otherStillMoving.removed.parks.push(...otherStillMoving.decks.parks,...otherStillMoving.markets.parks.filter(Boolean));otherStillMoving.decks.parks=[];otherStillMoving.markets.parks.fill(null);otherStillMoving.endRewards.gear=true;player(otherStillMoving,'a').hikers[0].position=9;player(otherStillMoving,'a').hikers[1].position=10;player(otherStillMoving,'a').hikers[1].endSlot='gear';player(otherStillMoving,'b').hikers[0].position=8;player(otherStillMoving,'b').hikers[1].position=10;player(otherStillMoving,'b').hikers[1].endSlot='photo';assert.ok(privateView(otherStillMoving,'a').legalActions.every(c=>c.result?.fallback));
});
test('v0.4 cases1/2: camping generic gains allow wildlife, specific outer fee never substitutes wildlife',()=>{
 for(const capped of [false,true]){let s=fixture({camping:true});if(capped)project(s,'wildlife-conservation');give(s,{water:1});const prefix=campFace(s,3);s=commit(s,action(s,c=>c.fields.campingSlotId===`${prefix}3`&&c.fields.position===5));const gainChoice=privateView(s,'a').legalActions.find(c=>c.fields.action==='choose-gain'&&c.fields.resources.wildlife===2);assert.equal(gainChoice.result.resources.wildlife,capped?1:2);s=commit(s,gainChoice.fields);assert.equal(player(s,'a').resources.wildlife,capped?1:2);}
 const s=fixture({camping:true});give(s,{wildlife:1});const prefix=campFace(s,1);assert.ok(!privateView(s,'a').legalActions.some(c=>c.fields.campingSlotId===`${prefix}3`));s.stage='resolve';op(s,[{kind:'gear'}]);card(s,'gear','gear.01');const purchased=commit(s,action(s,c=>c.fields.targetId==='gear.01'));assert.equal(player(purchased,'a').resources.wildlife,0);
});
test('v0.4 case3: partial paid camping output works, fully empty output rejects before cost and tent commit',()=>{
 let s=fixture({camping:true});player(s,'a').photos=1;poolToOther(s,'forest');const prefix=campFace(s,1);s=commit(s,action(s,c=>c.fields.campingSlotId===`${prefix}1`&&c.fields.position===5));s=settleEffects(s,{onlyRequired:true});assert.equal(player(s,'a').photos,0);assert.equal(player(s,'a').resources.forest,0);assert.equal(player(s,'a').resources.sun,1);assert.equal(player(s,'a').resources.water,1);assert.equal(player(s,'a').resources.mountain,1);
 const empty=fixture({camping:true});player(empty,'a').photos=1;for(const key of ['forest','mountain','sun','water'])poolToOther(empty,key);const emptyPrefix=campFace(empty,1),before=JSON.stringify(empty);assert.ok(!privateView(empty,'a').legalActions.some(c=>c.fields.campingSlotId===`${emptyPrefix}1`));assert.equal(JSON.stringify(empty),before);assert.equal(player(empty,'a').photos,1);assert.equal(empty.camping.tents[0].slotId,null);
});
test('v0.4 cases4/5: certain prior solar or badge gain unlocks the following purchase/photo, empty solar does not',()=>{
 let s=fixture({camping:true});card(s,'gear','gear.01');let prefix=campFace(s,3);s=commit(s,action(s,c=>c.fields.campingSlotId===`${prefix}4`&&c.fields.position===5));s=commit(s,action(s,c=>c.type==='use-opportunity'));s=commit(s,action(s,c=>c.fields.action==='buy-gear'&&c.fields.targetId==='gear.01'));assert.equal(player(s,'a').resources.sun,1);
 const empty=fixture({camping:true});poolToOther(empty,'sun');prefix=campFace(empty,3);assert.ok(!privateView(empty,'a').legalActions.some(c=>c.fields.campingSlotId===`${prefix}4`));
 let badge=fixture({camping:true});project(badge,'environmental-studies');give(badge,{water:1});prefix=campFace(badge,2);badge=commit(badge,action(badge,c=>c.fields.campingSlotId===`${prefix}4`&&c.fields.position===5));badge=commit(badge,action(badge,c=>c.type==='use-opportunity'));assert.equal(badge.shutterbugOwnerId,'a');badge=commit(badge,action(badge,c=>c.fields.action==='take-photo'));assert.equal(player(badge,'a').photos,1);
});
test('v0.4 case6: first new water opens a reserve/gear/new-bottle chain before allocating the second',()=>{
 let s=fixture();passion(s,'passion.collecting');for(const id of [...player(s,'a').canteenRows[0].tokens])card(s,'canteens',id);player(s,'a').canteenRows[0].tokens=[];card(s,'canteens','canteen.token.16','a',0);card(s,'canteens','canteen.token.11');card(s,'gear','gear.10','a');op(s,[{kind:'gain',resources:{water:2}}],{started:false});s=commit(s,action(s,c=>c.type==='use-opportunity'));s=commit(s,action(s,c=>c.type==='allocate-water'&&c.fields.rowIndex===0));s=commit(s,action(s,c=>c.fields.action==='reserve'));s=commit(s,action(s,c=>c.fields.action==='gain-canteen'&&c.fields.targetId==='canteen.token.11'&&c.fields.rowIndex===1));s=commit(s,action(s,c=>c.type==='allocate-water'&&c.fields.rowIndex===1));assert.equal(player(s,'a').resources.sun,2);assert.ok(player(s,'a').canteenRows.slice(0,2).every(row=>row.filled));assert.equal(s.windowUsage.gear.filter(id=>id==='gear.10').length,1);assert.ok(!privateView(s,'a').legalActions.some(c=>c.type==='allocate-water'));
});
test('v0.4 case7: free photo and spent photo do not open paid-photo equipment or badge add-on',()=>{
 let s=fixture();card(s,'gear','gear.24','a');s.shutterbugOwnerId='a';op(s,[{kind:'free-photo',amount:1}],{started:false,sourceId:'season.1.4',kind:'season-reward'});s=commit(s,action(s,c=>c.type==='use-opportunity'));assert.equal(player(s,'a').photos,1);assert.ok(!s.opportunities.some(o=>o.sourceId==='gear.24'));assert.equal(s.windowUsage.badge,false);
 let camp=fixture({camping:true});card(camp,'gear','gear.24','a');player(camp,'a').photos=1;camp.shutterbugOwnerId='a';const prefix=campFace(camp,1);camp=commit(camp,action(camp,c=>c.fields.campingSlotId===`${prefix}1`&&c.fields.position===5));camp=settleEffects(camp,{onlyRequired:true});assert.equal(player(camp,'a').photos,0);assert.ok(!camp.opportunities.some(o=>o.sourceId==='gear.24'));assert.equal(camp.windowUsage.badge,false);
});
test('parks do not refill until window boundary, gear/canteen compact immediately; reserved identities public',()=>{
 let s=fixture();passion(s,'passion.collecting');const original=[...s.markets.parks],target=original[1],deck=s.decks.parks.length;op(s,[{kind:'parks'}]);s=commit(s,action(s,c=>c.fields.action==='reserve'&&c.fields.targetId===target));assert.equal(s.markets.parks[1],null);assert.equal(s.decks.parks.length,deck);
 assert.ok(privateView(s,'b').players.find(p=>p.id==='a').reserved.includes(target));s=commit(s,action(s,c=>c.type==='finish-window'));assert.ok(s.markets.parks.every(Boolean));assert.equal(s.decks.parks.length,deck-1);assert.deepEqual(s.markets.parks.slice(1),[original[0],original[2]]);
});
test('certainty planner cannot use a hidden bottle or free hidden gear to fund a later required payment',()=>{
 const s=fixture(),owner=player(s,'a');for(const id of [...owner.canteenRows[0].tokens])card(s,'canteens',id);owner.canteenRows[0].tokens=[];card(s,'canteens','canteen.token.1','a',0);
 s.decks.canteens.push(...s.markets.canteens.filter(Boolean));s.markets.canteens.fill(null);
 const known=['canteen.token.2','canteen.token.6','canteen.token.16'];
 for(const id of known){for(const p of s.players)for(const row of p.canteenRows)row.tokens=row.tokens.filter(v=>v!==id);s.decks.canteens=s.decks.canteens.filter(v=>v!==id);}
 s.markets.canteens=known;s.decks.canteens=s.decks.canteens.filter(v=>v!=='canteen.token.11');s.decks.canteens.unshift('canteen.token.11');
 op(s,[{kind:'canteen'},{kind:'gain',resources:{water:1}},{kind:'gear'}]);assert.equal(stateProblem(s),null);assert.equal(canCompleteMandatory(s,'a'),false);
 card(s,'canteens','canteen.token.11');assert.equal(canCompleteMandatory(s,'a'),true,'a visible solar bottle may provide a certain route');
 const gear=fixture();gear.currentSiteId='site.mountain';gear.arrivalMode='normal';gear.decks.gear=gear.decks.gear.filter(id=>id!=='gear.32');const marketIndex=gear.markets.gear.indexOf('gear.32');if(marketIndex>=0)gear.markets.gear[marketIndex]=null;gear.decks.gear.unshift('gear.32');
 op(gear,[{kind:'free-gear'},{kind:'gear'}]);assert.equal(stateProblem(gear),null);assert.equal(canCompleteMandatory(gear,'a'),false);
});
test('optional empty park opportunity can be forgone once; started required child still prevents forgoing its parent',()=>{
 let s=fixture();s.removed.parks.push(...s.decks.parks,...s.markets.parks.filter(Boolean));s.decks.parks=[];s.markets.parks.fill(null);const bonus=op(s,[{kind:'parks'}],{mandatory:false,kind:'gear',sourceId:'gear.16',started:false});
 const finish=action(s,c=>c.opportunityId===bonus.id&&c.type==='finish-opportunity');s=commit(s,finish);assert.equal(s.opportunities.find(o=>o.id===bonus.id).status,'forgone');assert.ok(!privateView(s,'a').legalActions.some(c=>c.opportunityId===bonus.id));
 const blocked=fixture();const parent=op(blocked,[{kind:'gain',resources:{water:1}},{kind:'photo'}],{mandatory:false,started:false});const used=action(blocked,c=>c.opportunityId===parent.id&&c.type==='use-opportunity');const next=commit(blocked,used);assert.ok(next.opportunities.some(o=>o.parentId===parent.id&&o.status==='open'&&o.mandatory));
 assert.ok(!privateView(next,'a').legalActions.some(c=>c.opportunityId===parent.id&&c.type==='finish-opportunity'));
});
test('paid exchange uses actual partial finite output and never accepts zero retained output',()=>{
 let s=fixture();give(s,{water:1});poolToOther(s,'wildlife');player(s,'b').resources.wildlife--;s.bankResources.wildlife++;
 op(s,[{kind:'trade',paymentCount:2,resources:{wildlife:2},event:'wildlife-trade'}]);give(s,{sun:1});const choice=action(s,c=>c.fields.action==='trade');assert.equal(privateView(s,'a').legalActions.find(c=>c.fields.action==='trade').result.resources.wildlife,1);s=commit(s,choice);assert.equal(player(s,'a').resources.wildlife,1);assert.equal(player(s,'a').resources.sun+player(s,'a').resources.water,0);
 let empty=fixture();give(empty,{water:1});poolToOther(empty,'wildlife');op(empty,[{kind:'trade',paymentCount:1,resources:{wildlife:1},event:'wildlife-trade'}]);assert.ok(!privateView(empty,'a').legalActions.some(c=>c.fields.action==='trade'));
});
test('every alternative exchange payment previews its own post-payment finite output',()=>{
 let s=fixture();give(s,{sun:1,wildlife:1});player(s,'b').resources.wildlife+=s.bankResources.wildlife-1;s.bankResources.wildlife=1;const exchange=op(s,[{kind:'trade',paymentCount:1,resources:{wildlife:2},event:'wildlife-trade'}]);
 const descriptor=privateView(s,'a').legalActions.find(c=>c.opportunityId===exchange.id&&c.fields.action==='trade');assert.equal(descriptor.cost.paymentQuotes.length,2);
 const solar=descriptor.cost.paymentQuotes.find(q=>q.payment.sun===1),wild=descriptor.cost.paymentQuotes.find(q=>q.payment.wildlife===1);assert.equal(solar.result.resources.wildlife,1);assert.equal(wild.result.resources.wildlife,2);
 assert.equal(solar.remainingResources.sun,0);assert.equal(solar.remainingResources.wildlife,1);assert.equal(wild.remainingResources.sun,1);assert.equal(wild.remainingResources.wildlife,0);assert.deepEqual(descriptor.cost.discounts,[]);
 const before=structuredClone(s),solarState=commit(before,{...descriptor.fields,payment:solar.payment}),wildState=commit(s,{...descriptor.fields,payment:wild.payment});assert.equal(player(solarState,'a').resources.wildlife,2);assert.equal(player(wildState,'a').resources.wildlife,2);assert.equal(player(solarState,'a').resources.sun,0);assert.equal(player(wildState,'a').resources.sun,1);
});
test('all nine projects: initial exclusions/no weather/no fire; water loss once and wildlife immediate cap',()=>{
 const found={};for(let seed=1;seed<=100;seed++){const rng=randomStream(seed),s=createGame(['a'],{matchId:`project${seed}`,now:0,configuration:{mode:'solo',camping:true,volunteerCount:1,passionChoice:'random'},serverRandomInt:n=>rng.randomInt(n)});found[s.projects[0]]=s;}
 assert.equal(Object.keys(found).length,9);
 const reduced=found['volunteer.reduce-emissions'];assert.equal(reduced.removed.parks.length,24);assert.equal(reduced.decks.parks.length+reduced.markets.parks.filter(Boolean).length,39);
 const climate=found['volunteer.climate-action'];assert.deepEqual(climate.trail.map(t=>t.weather),[null,null,'water',null,'water',null,'water',null,'water']);assert.equal(found['volunteer.leave-no-trace'].players[0].campfire,false);
 let s=fixture();project(s,'water-conservation');give(s,{water:2});op(s,[{kind:'gain',resources:{sun:2}}],{started:false});s=commit(s,action(s,c=>c.type==='use-opportunity'));assert.equal(player(s,'a').resources.water,1);op(s,[{kind:'gain',resources:{sun:2}}],{started:false});s=commit(s,action(s,c=>c.type==='use-opportunity'));assert.equal(player(s,'a').resources.water,1);
 let wild=fixture();project(wild,'wildlife-conservation');op(wild,[{kind:'gain',resources:{wildlife:2}}],{started:false});wild=commit(wild,action(wild,c=>c.type==='use-opportunity'));assert.equal(player(wild,'a').resources.wildlife,1);assert.equal(wild.bankResources.wildlife,13);give(wild,{water:1});op(wild,[{kind:'trade',paymentCount:1,resources:{wildlife:1},event:'wildlife-trade'}]);assert.ok(!privateView(wild,'a').legalActions.some(c=>c.fields.action==='trade'&&c.fields.payment.wildlife===0));
});
test('remaining projects enforce reserved-only visits, purchase-driven capacity floor, badge photos and separate compensation',()=>{
 let s=fixture();project(s,'sustainable-transportation');give(s,{mountain:4,forest:4,sun:4,water:4,wildlife:2});card(s,'parks','arches');op(s,[{kind:'parks'}]);assert.ok(!privateView(s,'a').legalActions.some(c=>c.fields.action==='visit'));s=commit(s,action(s,c=>c.fields.action==='reserve'&&c.fields.targetId==='arches'));op(s,[{kind:'parks'}]);assert.ok(privateView(s,'a').legalActions.some(c=>c.fields.action==='visit'&&c.fields.targetId==='arches'));
 const capacity=fixture();project(capacity,'responsible-consumption');for(let n=1;n<=13;n++)card(capacity,'gear',`gear.${String(n).padStart(2,'0')}`,'a');player(capacity,'a').gearPurchases=13;assert.equal(backpackCapacity(capacity,player(capacity,'a')),0);
 const photo=fixture();project(photo,'environmental-studies');give(photo,{sun:1});op(photo,[{kind:'photo'}]);assert.ok(!privateView(photo,'a').legalActions.some(c=>c.fields.action==='take-photo'));photo.shutterbugOwnerId='a';assert.ok(privateView(photo,'a').legalActions.some(c=>c.fields.action==='take-photo'));
 const carbon=fixture();project(carbon,'carbon-offsetting');passion(carbon,'passion.mountaineering','a','ability');give(carbon,{mountain:4,wildlife:1});card(carbon,'parks','zion');const cost=parkCosts(carbon,player(carbon,'a'),{cost:{mountain:3,forest:0,sun:0,water:0,wildlife:0}},'mountain');assert.equal(cost.actualCost.mountain,3);assert.equal(cost.extraCost.mountain,1);
 assert.equal(cost.discounts[0].sourceId,'passion.mountaineering');assert.equal(cost.discounts[0].resources.mountain,1);
});
test('D11 returns weather, then missing water stays empty by original positions; leave-no-trace only blocks relight on reset',()=>{
 let s=fixture();project(s,'leave-no-trace');const owner=player(s,'a');owner.resources.water+=s.bankResources.water;s.bankResources.water=0;
 for(const site of s.trail)if(site.weather==='water'){owner.resources.water++;site.weather=null;}
 assert.equal(owner.resources.water,30);completeSeason(s,{now:1,serverRandomInt:()=>0});assert.equal(owner.campfire,false);assert.equal(s.trail.filter(site=>site.weather==='water').length,0);assert.equal(s.trail.filter(site=>site.weather==='sun').length,4);assert.equal(stateProblem(s),null);
});
