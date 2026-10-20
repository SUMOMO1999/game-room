import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, gameProblem, currentDecision } from './rules.mjs';
import { projectPublicBattleMetadata, publicBattleMetadataProblem } from './battle-public-metadata.mjs';
import { buildBattleReport } from './battle-report-model.mjs';
import { definition } from './model.mjs';
const ids=[1,2].map(n=>String(n).padStart(32,'0')),ctx={now:0,randomInt:n=>n-1};
function fixture(){const game=createGame(ids,{...ctx,matchId:'e'.repeat(32),firstPlayerId:ids[0]});
 game.deck.push(...game.players.flatMap(p=>p.hand));game.players.forEach(p=>{p.hand=[];});game.stage='use';game.drawStarted=true;
 const take=code=>{const at=game.deck.findIndex(id=>definition(id).sourceCode===code);assert(at>=0);return game.deck.splice(at,1)[0];};
 return {game,take};}
const apply=(game,actor,type,fields={})=>{const result=applyGameAction(game,actor,{type,matchId:game.matchId,turnId:game.turnId,...(game.pending?{effectId:game.pending.id,decisionId:currentDecision(game)?.id}:{}),...fields},ctx);assert.equal(result.ok,true,result.error);return result.state;};
test('turn-ending transition records previous owner with actual public resource result',()=>{
 const {game}=fixture(),after=apply(game,ids[0],'end-turn'),meta=projectPublicBattleMetadata(game,after);
 assert.equal(after.turnPlayerId,ids[1]);assert.equal(meta.turn.ownerSeatId,ids[0]);assert.equal(meta.turn.id,'turn-1');
 assert.deepEqual(meta.changes,[{seatId:ids[0],silver:1,goods:[],handCount:0,toolsAdded:[],toolsRemoved:[]}]);
});
test('private peek face never enters journal until exact card is publicly discarded',()=>{
 const {game}=fixture();game.stage='draw';game.drawStarted=false;
 const peek=apply(game,ids[0],'peek'),secret=peek.pending.poolCards[0],face=definition(secret).id;
 const hidden=projectPublicBattleMetadata(game,peek);assert.equal(hidden.sourceCardId,null);assert(!JSON.stringify(hidden).includes(secret));
 assert(!JSON.stringify(hidden).includes(face));
 const after=apply(peek,ids[0],'discard-peek'),meta=projectPublicBattleMetadata(peek,after);
 assert.equal(meta.discard.added.at(-1).cardId,face);assert.equal(meta.discard.added.at(-1).reason,'draw-discarded');
 assert.equal(meta.discard.added.at(-1).actorSeatId,ids[0]);assert.equal(meta.sourceCardId,null);
});
test('tool replacement tracks the actual public copy location without exporting copy IDs',()=>{
 const {game,take}=fixture(),owner=game.players[0];owner.tools=[take('T01'),take('T02'),take('T03')].map(cardId=>({cardId,exhausted:false}));
 const installed=take('T04');owner.hand.push(installed);const replaced=owner.tools[1].cardId;
 assert.equal(gameProblem(game),null);const after=apply(game,ids[0],'install-tool',{cardId:installed,replaceCardId:replaced});
 const meta=projectPublicBattleMetadata(game,after),change=meta.changes.find(row=>row.seatId===ids[0]);
 assert.deepEqual(change.toolsAdded,[definition(installed).id]);assert.deepEqual(change.toolsRemoved,[definition(replaced).id]);
 assert.equal(meta.discard.added[0].cardId,definition(replaced).id);assert.equal(meta.discard.added[0].reason,'replaced');
 assert.equal(meta.discard.added[0].sourceCardId,definition(installed).id);assert(!JSON.stringify(meta).includes(replaced));
});
test('unknown historical discard and reordering stay unknown, no same-name origin repair',()=>{
 const {game,take}=fixture();game.discard.push(take('G01'),take('G02'));
 const after=structuredClone(game);after.discard.reverse();after.lastPublicEvents=[{type:'resumed'}];
 const meta=projectPublicBattleMetadata(game,after);assert.equal(meta.discard.removed.length,2);
 assert(meta.discard.added.every(item=>item.reason==='unknown'&&item.actorSeatId===null));
});
test('metadata whitelist rejects private payload, card copy identifiers and foreign owner',()=>{
 const {game}=fixture(),meta=projectPublicBattleMetadata(null,game);assert.equal(publicBattleMetadataProblem(meta,ids),null);
 for(const change of [v=>{v.hand=[];},v=>{v.sourceCardId=game.deck[0];},v=>{v.turn.ownerSeatId='f'.repeat(32);},v=>{v.changes=[{seatId:ids[0],silver:0,goods:[],handCount:0,toolsAdded:[],toolsRemoved:[],private:true}];}]){
  const copy=structuredClone(meta);change(copy);assert(publicBattleMetadataProblem(copy,ids));
 }
});

test('a search recycling cards back into the same discard order breaks previous provenance',()=>{
 const {game,take}=fixture(); const owner=game.players[0],tool=take('T01');owner.tools.push({cardId:tool,exhausted:false});
 // Every goods card is in hands so the search exhausts the physical deck and
 // returns all publicly revealed misses, including the old discard cards.
 owner.hand.push(...game.deck.filter(id=>definition(id).category==='goods'));
 game.deck=game.deck.filter(id=>definition(id).category!=='goods');game.discard.push(...game.deck.splice(0));
 assert.equal(gameProblem(game),null);const after=apply(game,ids[0],'activate-tool',{cardId:tool}),meta=projectPublicBattleMetadata(game,after);
 assert.equal(meta.discard.removed.length,game.discard.length);assert(meta.discard.added.every(item=>item.reason==='unknown'));
});

test('a real six-seat auction can exceed 50 commits in one actual owner turn without transport truncation',()=>{
 const seats=Array.from({length:6},(_,i)=>String(i+1).padStart(32,'0'));
 let state=createGame(seats,{...ctx,matchId:'d'.repeat(32),firstPlayerId:seats[0],actionLimit:10});
 state.deck.push(...state.players.flatMap(p=>p.hand));state.players.forEach(p=>{p.hand=[];p.silver=100;});
 const at=state.deck.findIndex(id=>definition(id).sourceCode==='C12'),cardId=state.deck.splice(at,1)[0];state.players[0].hand.push(cardId);
 state.stage='use';state.drawStarted=true;assert.equal(gameProblem(state),null);
 const groups=[{schemaVersion:2,sequence:state.publicEventSequence,committedAt:0,events:state.lastPublicEvents,...projectPublicBattleMetadata(null,state)}];
 const step=(actor,type,fields={})=>{const before=state;state=apply(state,actor,type,fields);assert.equal(gameProblem(state),null);
  groups.push({schemaVersion:2,sequence:state.publicEventSequence,committedAt:state.committedAt,events:state.lastPublicEvents,...projectPublicBattleMetadata(before,state)});};
 step(seats[0],'play-character',{cardId});
 for(let amount=1;amount<=60;amount++)step(currentDecision(state).actorId,'bid',{amount});
 for(let n=0;state.pending;n++){assert(n<6);step(currentDecision(state).actorId,'pass-bid');}
 const ended=groups.find(g=>g.events.some(e=>e.type==='auction-settled'));assert(ended);assert(ended.changes.some(c=>c.silver===-60));
 step(seats[0],'end-turn');const report=buildBattleReport(groups,{players:seats.map(id=>({id})),game:state,coverage:{complete:true}});
 assert(groups.length>50);assert.equal(report.turns[0].groups.length,groups.length);assert.equal(report.turns[0].complete,true);
 assert(report.turns[0].groups.every(g=>g.turn.ownerSeatId===seats[0]));assert.equal(report.partial,false);
});
