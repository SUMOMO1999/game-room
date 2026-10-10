import test from 'node:test';
import assert from 'node:assert/strict';
import { choiceModel, buildChoiceSelection, defaultChoiceInput, actionDraft, knownCards, tableProjection } from './game-ui-model.mjs';
import { renderChoiceForm, publicEventText } from './game-ui.mjs';
import { GOODS } from './content/definitions.mjs';
import { createGame, applyGameAction, currentDecision } from './rules.mjs';
import { privateView, spectatorView } from './view.mjs';
const ids=['a'.repeat(32),'b'.repeat(32)],ctx={now:1000,randomInt:n=>n-1};
const goods=n=>Object.fromEntries(GOODS.map((good,index)=>[good.id,index===0?n:0]));
const pending=(kind,options,defaultSelection)=>({choice:{kind,options,defaultSelection}});
const cases=[
 pending('retain-goods',[{combined:goods(6),ordinaryCapacity:5,capacity:6,temporaryFee:2}],goods(5)),
 pending('auction-goods',[{goods:goods(6),minimum:2,maximum:2}],{goods:goods(2)}),
 pending('discard-hand',[{cardIds:['card1','card2','card3'],count:2}],{cardIds:['card1','card2']}),
 pending('tool-discard-draw',[{cardIds:['card1','card2'],min:1,max:2}],{cardIds:['card1']}),
 pending('tool-exchange',[{ownGoodIds:['firearms'],otherGoodIds:['imports']}],{ownGoodId:'firearms',otherGoodId:'imports'}),
 pending('tool-payment-good',[{goodIds:['firearms'],payments:[{zone:'hand',cardId:'card1'},{zone:'tool',cardId:'card2'}]}],{goodId:'firearms',payment:{zone:'tool',cardId:'card2'}}),
 pending('borrow-tool',[{borrow:false},{borrow:true}],{borrow:false}),
 pending('take-card',[{cardId:'card1'},{cardId:'card2'}],{cardId:'card2'}),
];
test('every choice schema round-trips the server default without inventing card or goods IDs',()=>{
 for(const p of cases)assert.deepEqual(buildChoiceSelection(p,defaultChoiceInput(p)),p.choice.defaultSelection,p.choice.kind);
});
test('choice input rejects excess stock, wrong count, duplicate/unknown card, foreign payment and empty choice',()=>{
 for(const [p,input] of [[cases[0],{goods:goods(7)}],[cases[1],{goods:goods(1)}],[cases[1],{goods:goods(-1)}],[cases[2],{cardIds:['card1','card1']}],[cases[3],{cardIds:['foreign']}],[cases[4],{ownGoodId:'imports',otherGoodId:'imports'}],[cases[5],{goodId:'firearms',paymentIndex:4}],[cases[6],{optionIndex:-1}]])assert.throws(()=>buildChoiceSelection(p,input),RangeError);
 assert.equal(choiceModel({choice:{kind:'take-card'}}),null,'another player has no private options');
});
function fresh(){return createGame(ids,{...ctx,matchId:'c'.repeat(32)});}
function act(state,type,fields={},actor=state.turnPlayerId){const decision=currentDecision(state);const result=applyGameAction(state,actor,{type,matchId:state.matchId,turnId:state.turnId,...(decision?{effectId:state.pending.id,decisionId:decision.id}:{}),...fields},ctx);assert.equal(result.ok,true,result.error);return result.state;}
function hand(state,code){const copyId=`yousei.${code}#01`;for(const p of state.players)p.hand=p.hand.filter(id=>id!==copyId);state.deck=state.deck.filter(id=>id!==copyId);state.players[0].hand.push(copyId);return copyId;}
test('real private peek projection has only the owner candidate; spectator model never reconstructs it',()=>{
 const state=act(fresh(),'peek'),own=privateView(state,ids[0]),other=privateView(state,ids[1]),watch=spectatorView(state);
 const candidate=own.pending.privatePool[0].cardId;assert.ok(knownCards(own).has(candidate));assert.equal(knownCards(other).has(candidate),false);assert.equal(knownCards(watch).has(candidate),false);
 const room={roomId:'room',roomCode:'123456',players:ids.map((id,i)=>({id,name:`成员${i}`})),game:watch,selfId:'viewer',selfRole:'spectator',phase:'playing'};
 assert.deepEqual(tableProjection(room).hand,[]);assert.equal(tableProjection(room).players.length,2);
});
test('action drafts require current turn/own card and send only current projection identities',()=>{
 let state=fresh();const id=hand(state,'g01');state=act(act(state,'peek'),'keep-peek');const game=privateView(state,ids[0]),card=game.players[0].hand.find(c=>c.cardId===id);
 assert.deepEqual(actionDraft(game,ids[0],card,'buy'),{cardId:id});assert.throws(()=>actionDraft(game,ids[1],card,'buy'),RangeError);assert.throws(()=>actionDraft({...game,clock:{paused:true}},ids[0],card,'buy'),RangeError);assert.throws(()=>actionDraft(game,ids[0],{cardId:'forged',definitionId:'yousei.g01'},'buy'),RangeError);
});
test('character target draft preserves opponent public tool ref instead of a hidden copy ID',()=>{
 let state=fresh();const actor=hand(state,'m08'),tool=hand(state,'t05');state.players[0].hand=state.players[0].hand.filter(id=>id!==tool);state.players[1].tools.push({cardId:tool,exhausted:false});state=act(act(state,'peek'),'keep-peek');const game=privateView(state,ids[0]);const ref=game.players[1].tools[0].ref;
 assert.deepEqual(actionDraft(game,ids[0],game.players[0].hand.find(c=>c.cardId===actor),'play-character',{toolCardId:ref}),{cardId:actor,params:{toolCardId:ref}});
 assert.throws(()=>actionDraft(game,ids[0],game.players[0].hand.find(c=>c.cardId===actor),'play-character',{toolCardId:tool}),RangeError);
});
test('real oracle private choice renders each candidate as a selectable complete card',()=>{
 let state=fresh();const cardId=hand(state,'c02');state=act(act(state,'peek'),'keep-peek');state=act(state,'play-character',{cardId});if(state.pending?.response)state=act(state,'decline-response',{},ids[1]);const game=privateView(state,ids[0]);
 assert.equal(game.pending.choice.kind,'take-card');const form=renderChoiceForm(game.pending,game);assert.match(form,/完整牌文/);assert.equal((form.match(/name="optionIndex"/gu)||[]).length,game.pending.choice.options.length);assert.deepEqual(buildChoiceSelection(game.pending,defaultChoiceInput(game.pending)),game.pending.choice.defaultSelection);
});
test('public history presents translated events, never raw JSON',()=>{
 assert.match(publicEventText({type:'bid-raised',actorSeatId:ids[0],silver:5},[{id:ids[0],name:'甲'}]),/甲报价5两/);assert.equal(publicEventText({type:'unknown',secret:'do not render'}),'公开步骤已更新');
});
