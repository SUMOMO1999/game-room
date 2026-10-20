// Runs accepted old-card examples in the new material/version, with neutral
// active-only roles. Original test files and their original engine stay intact.
export * from '../rules.mjs';
import {createOpening,applyOpeningAction} from '../../opening.mjs';
import {fromOpening} from '../rules.mjs';
export function createGame(ids,options){
  const {matchId,now,firstPlayerId=ids[0],actionLimit=5,goodsPerType=6,randomInt}=options;
  let opening=createOpening(ids,{openingId:matchId,hostId:ids[0],now,randomInt,configuration:{packId:'six-trades-v1',actionLimit,goodsPerType}});
  const roles=['R09','R14','R16','R17','R18','R20'],all=[...Object.values(opening.candidates).flat(),...opening.remainingRoles];
  ids.forEach((id,i)=>{const at=all.indexOf(`yousei.role.${roles[i].toLowerCase()}`);[all[3*i],all[at]]=[all[at],all[3*i]];});
  ids.forEach((id,i)=>{opening.candidates[id]=all.slice(3*i,3*i+3);});opening.remainingRoles=all.slice(3*ids.length);opening.firstPlayerId=firstPlayerId;
  for(const id of ids){const r=applyOpeningAction(opening,id,{type:'confirm-role',openingId:matchId,candidateId:`${matchId}.${id}`,roleId:opening.candidates[id][0]},{now,randomInt});
    if(!r.ok)throw new Error(r.error);opening=r.state;}
  return fromOpening(opening);
}
