import assert from 'node:assert/strict';
import { createGame, applyGameAction, applySystemStep, nextSystemStep, privateView, stateProblem } from '../engine.mjs';
import { createOpportunity, openWindow, zeroResources, RESOURCE_KEYS, player } from '../rules/model.mjs';
import { randomStream } from '../practice-engine.mjs';
import { chooseParksPracticeAction } from '../practice-bot.mjs';
export function fixture(configuration = {}, seed = 123) {
  const random = randomStream(seed), config = { mode: 'standard', camping: false, volunteerCount: 0, passionChoice: 'random', ...configuration };
  const state = createGame(config.mode === 'solo' ? ['a'] : ['a','b'], { matchId: `fixture${seed}`, now: 0, serverRandomInt: n => random.randomInt(n), configuration: config });
  if(config.mode !== 'standard')state.teddy.batch=null;
  state.controllerIndex = state.controllers.findIndex(controller => controller.id === 'a'); state.turnPlayerId = 'a'; state.turnIndex = 0;
  openWindow(state, 'turn', 'a', 0); state.stage='resolve'; state.currentSiteId=null;state.arrivalMode=null;
  return state;
}
export function give(state, amounts, id='a') { const owner=player(state,id); for(const key of RESOURCE_KEYS){const amount=amounts[key]??0;assert.ok(state.bankResources[key]>=amount);owner.resources[key]+=amount;state.bankResources[key]-=amount;}return owner; }
export function card(state, kind, targetId, ownerId = null, destination = null) {
  const owner=ownerId?player(state,ownerId):null;
  const locations=[state.decks[kind],state.markets[kind],state.removed[kind]??[],...state.players.flatMap(p=>kind==='parks'?[p.visited,p.reserved]:kind==='gear'?[p.gear]:kind==='canteens'?p.canteenRows.map(r=>r.tokens):[])];
  const location=locations.find(items=>items.includes(targetId));assert.ok(location,`${targetId} exists`);
  if(location===state.markets[kind])location[location.indexOf(targetId)]=null;else location.splice(location.indexOf(targetId),1);
  if(owner){const target=destination==='reserved'?owner.reserved:destination==='visited'?owner.visited:kind==='gear'?owner.gear:owner.canteenRows[destination??0].tokens;target.push(targetId);}
  else {const previous=state.markets[kind][0];if(previous)state.decks[kind].push(previous);state.markets[kind][0]=targetId;}
}
export function passion(state, targetId, id='a', branch=null) {
  const owner=player(state,id), previous=owner.passionId;
  const other=state.players.find(p=>p!==owner&&p.passionId===targetId);
  if(other)other.passionId=previous;
  else {const index=state.decks.passions.indexOf(targetId);if(index>=0)state.decks.passions[index]=previous;else assert.equal(targetId,previous);}
  owner.passionId=targetId;owner.passionBranch=branch;
}
export function op(state, program, {sourceId='site.parks',mandatory=true,started=true,kind='base'}={}) { return createOpportunity(state,'a',sourceId,program,{mandatory,started,kind}); }
export function action(state, predicate) {const value=privateView(state,state.decisionWindow.responsibleSeatId).legalActions.find(predicate); assert.ok(value,`expected legal choice at ${state.stage}`);return value.fields;}
export function commit(state, intent, {random=()=>0,now=state.committedAt+1,id=state.decisionWindow.responsibleSeatId}={}) {
  const result=applyGameAction(state,id,intent,{now,serverRandomInt:random});assert.equal(result.ok,true,result.error);assert.equal(stateProblem(result.state),null);return result.state;
}
export function settleEffects(state, {onlyRequired=false,random=()=>0,limit=200}={}) {
  for(let i=0;i<limit;i++){
    const step=nextSystemStep(state);
    if(step && step.type==='roll-die'){const result=applySystemStep(state,step,{now:state.committedAt+1,serverRandomInt:random});assert.equal(result.ok,true,result.error);state=result.state;continue;}
    const required=state.opportunities.filter(o=>o.status==='open'&&o.mandatory);
    if(onlyRequired&&!required.length)return state;
    const choices=privateView(state,state.decisionWindow.responsibleSeatId).legalActions;
    const candidate=choices.find(c=>c.type==='choose-passion'&&c.fields.choice==='scoring')
      ??choices.find(c=>c.type==='allocate-water'&&c.fields.rowIndex===null)
      ??choices.find(c=>c.type==='finish-opportunity'&&required.some(o=>o.id===c.fields.opportunityId&&o.data.visitCount>0))
      ??choices.find(c=>c.type==='resolve-opportunity'&&c.fields.action==='reserve')
      ??choices.find(c=>c.type==='resolve-opportunity'&&c.fields.action==='gain-canteen')
      ??choices.find(c=>c.type==='resolve-opportunity'&&c.fields.action==='replace-gain'&&c.fields.choice==='original')
      ??choices.find(c=>!['finish-window','discard-resources'].includes(c.type));
    if(!candidate)return state;
    state=commit(state,candidate.fields,{random});
  }
  throw new Error('fixture effects unbounded');
}
export function fullMatch(configuration,{count=configuration.mode==='solo'?1:2,seed=1,limit=1200}={}) {
  const random=randomStream(seed),players=Array.from({length:count},(_,i)=>`p${i+1}`);
  let state=createGame(players,{matchId:`full${seed}`,now:0,configuration,serverRandomInt:n=>random.randomInt(n)}),commands=0,types=new Set();
  while(state.status==='playing'&&commands++<limit){
    const step=nextSystemStep(state),context={now:commands,serverRandomInt:n=>random.randomInt(n)};
    const intent=step?null:chooseParksPracticeAction(privateView(state,state.decisionWindow.responsibleSeatId));assert.ok(step||intent,`no legal route ${state.stage}`);
    const result=step?applySystemStep(state,step,context):applyGameAction(state,state.decisionWindow.responsibleSeatId,intent,context);assert.equal(result.ok,true,result.error);
    types.add(step?.type??intent.type);state=JSON.parse(JSON.stringify(result.state));assert.equal(stateProblem(state),null);
  }
  assert.equal(state.status,'finished');return {state,commands,types};
}
export {zeroResources,player};
