import assert from 'node:assert/strict';
import {createOpening,applyOpeningAction,openingProblem} from '../../opening.mjs';
import {fromOpening,applyGameAction,gameProblem,currentDecision} from '../rules.mjs';
import {privateView,spectatorView} from '../view.mjs';

export const ids=Array.from({length:6},(_,i)=>(i+1).toString(16).repeat(32));
export function fixture(codes=['R01','R12'],configuration={}, {contentVersion}={}){
  let opening=createOpening(ids.slice(0,codes.length),{openingId:'a'.repeat(32),hostId:ids[0],now:1000,
    configuration:{packId:'six-trades-v1',...configuration},randomInt:m=>m-1});
  if(contentVersion)opening.configuration={...opening.configuration,contentVersion};
  // Fixed legal initial candidate material, independent of the runtime chooser.
  const all=[...Object.values(opening.candidates).flat(),...opening.remainingRoles];
  codes.forEach((code,i)=>{const target=`yousei.role.${code.toLowerCase()}`,at=all.indexOf(target);[all[3*i],all[at]]=[all[at],all[3*i]];});
  codes.forEach((_,i)=>{opening.candidates[ids[i]]=all.slice(3*i,3*i+3);});opening.remainingRoles=all.slice(3*codes.length);
  assert.equal(openingProblem(opening),null);
  for(const id of ids.slice(0,codes.length)){
    const r=applyOpeningAction(opening,id,{type:'confirm-role',openingId:opening.openingId,candidateId:`${opening.openingId}.${id}`,
      roleId:opening.candidates[id][0]},{now:1001,randomInt:m=>m-1});assert.equal(r.ok,true,r.error);opening=r.state;
  }
  return fromOpening(opening);
}
export function move(state,code,ownerIndex=0){
  const owner=state.players[ownerIndex],zones=[state.deck,state.discard,...state.players.map(p=>p.hand)];
  const id=zones.flat().find(id=>id.startsWith(`yousei.${code.toLowerCase()}#`));assert.ok(id,code);
  for(const zone of zones){const at=zone.indexOf(id);if(at>=0){zone.splice(at,1);break;}}
  owner.hand.push(id);return id;
}
export function stripResponse(state,code='C04'){
  for(const owner of state.players.slice(1))for(const card of [...owner.hand])if(card.startsWith(`yousei.${code.toLowerCase()}#`)){
    owner.hand.splice(owner.hand.indexOf(card),1);state.deck.push(card);
  }
}
export function run(state,type,extra={},actor=state.turnPlayerId){
  const p=state.pending,decision=currentDecision(state),result=applyGameAction(state,actor,{type,matchId:state.matchId,turnId:state.turnId,
    ...(p?{effectId:p.id,decisionId:decision.id}:{}),...extra},{now:state.committedAt+1,randomInt:m=>m-1});
  assert.equal(result.ok,true,result.error);assert.equal(gameProblem(result.state),null);return result.state;
}
export const use=state=>run(run(state,'peek'),'keep-peek');

