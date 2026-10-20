import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBattleReport, discardProvenance } from './battle-report-model.mjs';
const a='1'.padStart(32,'0'), b='2'.padStart(32,'0'), c='3'.padStart(32,'0');
const players=[a,b,c].map((id,i)=>({id,name:`玩家${i+1}`}));
const game=(extra={})=>({status:'playing',firstPlayerId:b,turnId:'turn-2',turnNumber:2,turnPlayerId:c,publicEventSequence:54,...extra});
const group=(sequence,events,owner=b,number=1)=>({schemaVersion:2,sequence,committedAt:sequence,events,
 turn:{id:`turn-${number}`,number,round:Math.ceil(number/3),ownerSeatId:owner},sourceCardId:null,changes:[],
 discard:{beforeCount:0,afterCount:0,removed:[],added:[]}});
const event={type:'draw-kept',actorSeatId:b};
test('53 transport groups remain one complete real turn with responders and auction actors',()=>{
 const groups=Array.from({length:53},(_,i)=>group(i+1,i===0?[{type:'match-started'}]:i===52?[{type:'turn-ended',actorSeatId:b}]:[i===50?{type:'auction-bid',actorSeatId:a,amount:5}:i===51?{type:'response-played',actorSeatId:c,cardId:'yousei.c07'}:event]));
 groups.push(group(54,[{type:'draw-kept',actorSeatId:c}],c,2));
 const report=buildBattleReport(groups,{game:game(),players,coverage:{complete:true}});
 assert.equal(report.partial,false);assert.equal(report.turns.length,2);assert.equal(report.turns[0].groups.length,53);
 assert.equal(report.turns[0].ownerId,b);assert.equal(report.turns[0].complete,true);assert.equal(report.turns[1].ongoing,true);
 assert.deepEqual(report.players.map(p=>p.turns),[[],['turn-1'],['turn-2']]);
 assert.equal(report.turns[0].entries.find(e=>e.event.type==='response-played').event.actorSeatId,c);
});
test('old groups use trusted first player and explicit ended owner rather than next actor',()=>{
 const groups=[group(1,[{type:'match-started'}]),group(2,[{type:'response-played',actorSeatId:a,cardId:'yousei.c07'},{type:'turn-ended',actorSeatId:b}])].map(({turn,discard,changes,sourceCardId,...v})=>({...v,schemaVersion:1}));
 const report=buildBattleReport(groups,{players,game:game({publicEventSequence:2})});
 assert.equal(report.partial,false);assert.equal(report.turns[0].ownerId,b);assert.equal(report.turns[0].ended,true);assert.equal(report.turns[1].groups.length,0);
});
test('gaps and migrated practice make only the incomplete turn partial; next complete turn remains usable',()=>{
 const report=buildBattleReport([group(42,[event]),group(43,[{type:'turn-ended',actorSeatId:b}]),group(44,[event],c,2)],{
  players,game:game({publicEventSequence:44}),coverage:{startSequence:42,firstTurn:{number:1,ownerId:b},partialStart:true,complete:true}});
 assert.equal(report.turns[0].partial,true);assert.equal(report.turns[0].complete,false);assert.equal(report.turns[1].complete,true);
 const missing=buildBattleReport([group(1,[event]),group(3,[event])],{players,game:game({turnId:'turn-1',turnNumber:1,turnPlayerId:b,publicEventSequence:3})});
 assert(missing.issues.includes('missing-sequence'));assert.equal(missing.turns[0].partial,true);
});
test('multi-turn recovery aggregate is explicitly unassigned, never falsely attributed to old owner',()=>{
 const crossed=group(2,[{type:'turn-ended',actorSeatId:b},{type:'draw-kept',actorSeatId:c},{type:'turn-ended',actorSeatId:c}]);
 const report=buildBattleReport([group(1,[event]),crossed],{players,game:game({turnId:'turn-3',turnNumber:3,turnPlayerId:a,publicEventSequence:2})});
 assert.equal(report.unassigned[0].sequence,2);assert.equal(report.turns[0].entries.length,1);assert.equal(report.partial,true);
 assert(report.issues.includes('ambiguous-turn-boundary'));
});
test('captured upper sequence excludes newer data; conflicting duplicate never produces complete pages',()=>{
 const g=group(1,[event]);const frozen=buildBattleReport([g,group(2,[event])],{players,game:game({publicEventSequence:1})});
 assert.equal(frozen.turns.flatMap(t=>t.groups).length,1);
 const conflict=buildBattleReport([g,{...g,events:[{type:'resumed'}]}],{players,game:game({publicEventSequence:1})});
 assert(conflict.issues.includes('conflicting-sequence'));assert(conflict.turns.every(t=>!t.complete));
});
test('discard provenance tracks public positions; old/missing groups cannot be repaired by same definition',()=>{
 const initial=group(1,[event]);initial.discard={beforeCount:0,afterCount:2,removed:[],added:[0,1].map(index=>({index,cardId:'yousei.g01',actorSeatId:index?a:b,reason:'used',sourceCardId:'yousei.g01'}))};
 const changed=group(2,[event]);changed.discard={beforeCount:2,afterCount:1,removed:[{index:0,cardId:'yousei.g01'}],added:[]};
 assert.equal(discardProvenance([initial,changed],[{id:'yousei.g01'}])[0].actorSeatId,a);
 assert.equal(discardProvenance([initial,{...changed,schemaVersion:1}],[{id:'yousei.g01'}])[0].known,false);
 assert.equal(discardProvenance([initial,{...changed,sequence:3}],[{id:'yousei.g01'}])[0].known,false);
});

test('an explicitly proven late-turn boundary supports a complete lazy-loaded current page',()=>{
 const g=group(52,[event],c,8);const report=buildBattleReport([g],{players,
  game:game({turnId:'turn-8',turnNumber:8,turnPlayerId:c,publicEventSequence:52}),
  coverage:{startSequence:52,firstTurn:{id:'turn-8',number:8,round:3,ownerId:c},partialStart:false,complete:true}});
 assert.equal(report.turns.length,1);assert.equal(report.turns[0].complete,true);assert.equal(report.partial,false);
 const conflicting=buildBattleReport([group(1,[event]),group(2,[event],a,1)],{players,game:game({turnId:'turn-1',turnNumber:1,turnPlayerId:b,publicEventSequence:2})});
 assert(conflicting.issues.includes('conflicting-turn-owner'));assert.equal(conflicting.unassigned.length,1);assert.equal(conflicting.turns[0].complete,false);
});
