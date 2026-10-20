import test from 'node:test';
import assert from 'node:assert/strict';
import { GOODS } from './content/definitions.mjs';
import { cardDraftChoices, cardDraftSelections } from './card-draft.mjs';
import { actionDraft, buildChoiceSelection } from './game-ui-model.mjs';
import { nativeChoiceDraft, nativeExchangeState, updateNativeChoice, nativeChoiceReady, nativeSelectionText, renderNativeMaterials } from './table-decision-ui.mjs';
import { createGame, applyGameAction, currentDecision, gameProblem } from './rules.mjs';
import { privateView } from './view.mjs';
import { definition, refreshTemporary } from './model.mjs';

const ids=['a','b','c','d'].map(letter=>letter.repeat(32));
const context={now:1000,randomInt:n=>n-1};
const goods=values=>Object.fromEntries(GOODS.map(good=>[good.id,values[good.id]??0]));
function projectedExchange(own,bank){
  const options=GOODS.filter(good=>own[good.id]>0).flatMap(from=>GOODS.filter(to=>to.id!==from.id&&bank[to.id]>=own[from.id]).map(to=>({fromGoodsId:from.id,toGoodsId:to.id})));
  const pending={code:'C06',kind:'character',ownerId:ids[0],actorId:ids[0],choice:{kind:'exchange',options}};
  const game={players:[{id:ids[0],goods:goods(own),hand:[],tools:[]}],bankGoods:goods(bank),discard:[]};
  return {pending,game};
}
const render=(f,draft)=>renderNativeMaterials({...f,selfId:ids[0],draft,name:()=> '我',canChoose:true,partIndex:0});
function chooseFrom(f,draft,id){return updateNativeChoice(f.pending,draft,'exchange-source',{id});}
function chooseTo(f,draft,id){const index=f.pending.choice.options.findIndex(option=>option.fromGoodsId===nativeExchangeState(f.pending,draft).fromGoodsId&&option.toGoodsId===id);assert.ok(index>=0);return updateNativeChoice(f.pending,draft,'option',{index});}
const buttons=markup=>[...markup.matchAll(/<button\b[^>]*data-material-good="([^"]+)"[^>]*>[\s\S]*?<\/button>/gu)].map(match=>({id:match[1],html:match[0]}));

test('C06 thirty legal pairs render six own kinds, then six targets rather than a pair strip',()=>{
  const f=projectedExchange(Object.fromEntries(GOODS.map(good=>[good.id,1])),Object.fromEntries(GOODS.map(good=>[good.id,8]))),before=structuredClone(f);
  assert.equal(f.pending.choice.options.length,30);
  let draft=nativeChoiceDraft(f.pending);
  assert.equal(buttons(render(f,draft)).length,6);assert.doesNotMatch(render(f,draft),/hy-material-exchange/u);
  assert.equal(nativeChoiceReady(f.pending,draft),false);
  draft=chooseFrom(f,draft,'firearms');
  const targets=buttons(render(f,draft));assert.equal(targets.length,6);
  assert.match(targets.find(button=>button.id==='firearms').html,/disabled/u);
  assert.match(targets.find(button=>button.id==='firearms').html,/不能换回同种货物/u);
  assert.equal(nativeChoiceReady(f.pending,draft),false);
  draft=chooseTo(f,draft,'imports');assert.equal(nativeChoiceReady(f.pending,draft),true);
  assert.deepEqual(buildChoiceSelection(f.pending,draft),{fromGoodsId:'firearms',toGoodsId:'imports'});
  assert.deepEqual(f,before,'all previews are read-only');
});

test('C06 insufficient stock remains visible with its amount and reason, and cannot be selected',()=>{
  const f=projectedExchange({firearms:3,imports:1},{firearms:5,imports:2,curios:3,beasts:0,artifacts:1,salt:5});
  let draft=chooseFrom(f,nativeChoiceDraft(f.pending),'firearms');
  const targets=buttons(render(f,draft));
  assert.match(targets.find(button=>button.id==='imports').html,/disabled/u);
  assert.match(targets.find(button=>button.id==='imports').html,/公库2件 · 不足3件/u);
  assert.match(targets.find(button=>button.id==='beasts').html,/公库0件 · 不足3件/u);
  assert.doesNotMatch(targets.find(button=>button.id==='curios').html,/ disabled/u);
  assert.deepEqual(updateNativeChoice(f.pending,draft,'option',{index:-1}),draft);
  draft=chooseTo(f,draft,'curios');
  assert.match(nativeSelectionText(f.pending,f.game,draft,()=> '我'),/交回全部火器3件 → 换入奇物3件。你的火器归零、奇物0→3件；公库奇物剩0件/u);
});

test('C06 back preserves its pair, changing source invalidates the previous target, old drafts remain readable',()=>{
  const f=projectedExchange({firearms:2,imports:1},{firearms:5,imports:5,curios:5,beasts:5,artifacts:5,salt:5});
  let draft=chooseTo(f,chooseFrom(f,nativeChoiceDraft(f.pending),'firearms'),'curios');
  const chosen=draft.optionIndex;
  draft=updateNativeChoice(f.pending,draft,'exchange-back',{});
  assert.equal(nativeChoiceReady(f.pending,draft),false);assert.equal(draft.optionIndex,chosen);
  draft=chooseFrom(f,draft,'firearms');assert.equal(draft.optionIndex,chosen);assert.equal(nativeChoiceReady(f.pending,draft),true);
  draft=chooseFrom(f,draft,'imports');assert.equal(draft.optionIndex,-1);assert.equal(nativeChoiceReady(f.pending,draft),false);
  assert.equal(nativeChoiceReady(f.pending,{optionIndex:chosen}),true,'saved original optionIndex is still understood');
  assert.equal(nativeExchangeState(f.pending,{optionIndex:chosen}).fromGoodsId,'firearms');
  assert.equal(nativeChoiceReady(f.pending,{optionIndex:chosen,exchangeFromGoodsId:'imports'}),false,'a mismatched stale pair cannot be confirmed');
});

test('C06 no own stock or no sufficient alternate public stock cannot become ready',()=>{
  const empty=projectedExchange({},Object.fromEntries(GOODS.map(good=>[good.id,6])));
  assert.match(render(empty,nativeChoiceDraft(empty.pending)),/你没有货物可交换/u);
  const blocked=projectedExchange({firearms:4},{firearms:6,imports:3,curios:3,beasts:3,artifacts:3,salt:3}),draft=nativeChoiceDraft(blocked.pending);
  const source=buttons(render(blocked,draft));assert.equal(source.length,1);assert.match(source[0].html,/disabled/u);assert.match(source[0].html,/公库无足量异种/u);
  assert.deepEqual(chooseFrom(blocked,draft,'firearms'),draft);assert.equal(nativeChoiceReady(blocked.pending,draft),false);
});

test('C06 staging does not change T02 two-player one-good exchange',()=>{
  const pending={code:'T02',choice:{kind:'tool-exchange',options:[{ownGoodIds:['firearms'],otherGoodIds:['imports']}]}};
  let draft=nativeChoiceDraft(pending);assert.equal(nativeExchangeState(pending,draft),null);
  draft=updateNativeChoice(pending,draft,'exchange',{field:'ownGoodId',id:'firearms'});
  draft=updateNativeChoice(pending,draft,'exchange',{field:'otherGoodId',id:'imports'});
  assert.equal(nativeChoiceReady(pending,draft),true);assert.deepEqual(buildChoiceSelection(pending,draft),{ownGoodId:'firearms',otherGoodId:'imports'});
});

function realFixture(playerCount){
  const state=createGame(ids.slice(0,playerCount),{...context,matchId:'e'.repeat(32),actionLimit:5,goodsPerType:8});
  state.deck.push(...state.players.flatMap(player=>player.hand));state.players.forEach(player=>{player.hand=[];});
  const index=state.deck.findIndex(id=>definition(id).sourceCode==='C06'),cardId=state.deck.splice(index,1)[0];state.players[0].hand.push(cardId);
  state.stage='use';state.drawStarted=true;
  state.players[0].goods.firearms=3;state.players[0].goods.imports=3;state.bankGoods.firearms-=3;state.bankGoods.imports-=3;
  refreshTemporary(state.players[0]);assert.equal(gameProblem(state),null);
  return {state,cardId};
}
function accept(state,type,fields){
  const decision=currentDecision(state),result=applyGameAction(state,ids[0],{type,matchId:state.matchId,turnId:state.turnId,...(decision?{effectId:state.pending.id,decisionId:decision.id}:{}),...fields},context);
  assert.equal(result.ok,true,result.error);assert.equal(gameProblem(result.state),null);return result.state;
}
for(const count of [2,4])test(`C06 ${count}-player preselection submits once, preserves total stock and paid temporary occupancy`,()=>{
  const {state,cardId}=realFixture(count),before=structuredClone(state),game=privateView(state,ids[0]),card=game.players[0].hand.find(item=>item.cardId===cardId),detail={card,tool:false,choiceInputs:[]};
  const pending=cardDraftChoices(game,ids[0],detail)[0],f={pending,game};
  detail.choiceInputs[0]=chooseTo(f,chooseFrom(f,nativeChoiceDraft(pending),'firearms'),'curios');
  assert.deepEqual(state,before);
  const initialChoices=cardDraftSelections(game,ids[0],detail);
  assert.deepEqual(initialChoices,[{kind:'exchange',selection:{fromGoodsId:'firearms',toGoodsId:'curios'}}]);
  const after=accept(state,'play-character',actionDraft(game,ids[0],card,'play-character',{initialChoices}));
  assert.equal(after.pending,null);assert.equal(after.actionsUsed,before.actionsUsed+1);assert.equal(after.players[0].silver,before.players[0].silver);
  assert.deepEqual(after.players[0].goods,goods({imports:3,curios:3}));assert.equal(after.players[0].temporaryOccupied,true);
  assert.equal(after.bankGoods.firearms,before.bankGoods.firearms+3);assert.equal(after.bankGoods.curios,before.bankGoods.curios-3);
  assert.equal(after.players[0].hand.includes(cardId),false);assert.equal(after.discard.includes(cardId),true);
});

test('C06 restored pending uses the same staged UI and commits without charging the action again',()=>{
  const {state,cardId}=realFixture(2),started=accept(state,'play-character',{cardId}),snapshot=JSON.parse(JSON.stringify(started)),game=privateView(snapshot,ids[0]);
  assert.equal(game.pending.choice.kind,'exchange');
  const f={pending:game.pending,game},draft=chooseTo(f,chooseFrom(f,nativeChoiceDraft(game.pending),'firearms'),'curios');
  const after=accept(snapshot,'choose-effect',{selection:buildChoiceSelection(game.pending,draft)});
  assert.equal(after.actionsUsed,started.actionsUsed);assert.equal(after.pending,null);assert.equal(after.players[0].silver,started.players[0].silver);
  assert.equal(after.players[0].goods.curios,3);assert.deepEqual(snapshot,started,'staging does not mutate the restored snapshot');
});
