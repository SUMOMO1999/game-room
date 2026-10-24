import {gameProblem} from './validation.mjs';
import {projectConfiguredPublicMetadata} from './public-metadata.mjs';
import {openingProblem} from '../opening.mjs';
import {CONFIGURABLE_RULE_VERSION,getRole} from '../content/expansion-one.mjs';
import {newTurnUsage,newRoleState} from './role-state.mjs';
import {isConfiguredBase,baseGameProblem,baseToLegacy} from './base.mjs';
import {projectPublicBattleMetadata} from '../battle-public-metadata.mjs';
import {getCard} from '../content/definitions.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const demand=yes=>{if(!yes)throw new TypeError('扩展权威回合与公开战况不一致。');};
export const isConfiguredGame=game=>game?.version===3&&game.ruleVersion===CONFIGURABLE_RULE_VERSION&&game.kind!=='hyakki-opening-game';
export function projectConfiguredHistory(before,room){
  const game=room?.game,old=before?.game;
  demand(isConfiguredGame(game)&&(isConfiguredBase(game)?baseGameProblem(game):gameProblem(game))===null&&room.matchId===game.matchId);
  if(old&&same(old,game))return null;
  const participants=room.matchParticipants.map(p=>({seatId:p.playerId,userKey:p.userKey}));
  demand(same(participants.map(p=>p.seatId),game.configuration.participantIds));
  if(isConfiguredGame(old)&&game.publicEventSequence===old.publicEventSequence){
    const a=structuredClone(old),b=structuredClone(game);a.lifecycle.checkpoints=[];b.lifecycle.checkpoints=[];
    demand(same(a,b));return null;
  }
  if(isConfiguredGame(old))demand(game.publicEventSequence===old.publicEventSequence+1);
  let metadata;
  if(isConfiguredBase(game)){
    demand(!old||isConfiguredBase(old)&&baseGameProblem(old)===null&&same(old.configuration,game.configuration));
    metadata=projectPublicBattleMetadata(old?baseToLegacy(old):null,baseToLegacy(game));
  }else if(old?.kind==='hyakki-opening-game'){
    const opening=old.opening;
    demand(openingProblem(opening)===null&&opening.status==='selecting'&&opening.openingId===game.matchId
      &&same(opening.configuration,game.configuration)&&opening.firstPlayerId===game.firstPlayerId
      &&game.revision===0&&game.publicEventSequence===1&&game.turnNumber===1&&game.stage==='draw'&&!game.drawStarted
      &&game.actionsUsed===0&&game.pending===null&&game.afterActions.length===0&&game.bookLayers===0&&game.closing===null
      &&game.discard.length===0&&same(game.turnUsage,newTurnUsage())&&game.committedAt>=opening.updatedAt
      &&game.lifecycle.startedAt===opening.createdAt&&game.players.every(p=>opening.candidates[p.id].includes(p.roleId)
        &&(!opening.choices[p.id]||opening.choices[p.id]===p.roleId)&&p.hand.length===5&&p.tools.length===0
        &&p.silver===getRole(p.roleId,game.configuration).initialSilver&&p.stallCount===0&&Object.values(p.goods).every(n=>n===0)
        &&same(p.roleState,newRoleState(p.roleId))));
    metadata={anchor:{kind:'opening'},source:null,rolesRevealed:game.players.map(p=>({seatId:p.id,roleId:p.roleId})),
      changes:game.players.map(p=>({seatId:p.id,silver:p.silver,goods:[],handCount:5,toolsAdded:[],toolsRemoved:[]})),
      discard:{beforeCount:0,afterCount:0,removed:[],added:[]}};
  }else{
    demand(isConfiguredGame(old)&&gameProblem(old)===null&&old.matchId===game.matchId&&same(old.configuration,game.configuration));
    metadata=projectConfiguredPublicMetadata(old,game);
  }
  const events=isConfiguredBase(game)?game.lastPublicEvents.map(event=>{
    if(!['trade-bought','trade-sold'].includes(event.type))return event;
    const owner=old.players.find(p=>p.id===event.actorSeatId),buying=event.type==='trade-bought',card=getCard(event.cardId);
    const count=event.goods.reduce((sum,g)=>sum+g.count,0),temporaryFee=buying&&!owner.temporaryOccupied
      &&Object.values(owner.goods).reduce((a,b)=>a+b,0)+count>5+3*owner.stallCount?2:0;
    return {...event,silver:event.silver+temporaryFee,price:{printed:buying?card.buySilver:card.sellSilver,bookLayers:old.bookLayers,
      roleAdjustment:0,goodsPrice:event.silver,buyTax:0,temporaryFee}};
  }):game.lastPublicEvents;
  const mode=events.some(e=>e.type==='match-ended')?'terminal':events.some(e=>e.type==='suspended'&&e.reason==='capacity')?'capacity'
    :old?.lifecycle?.capacity&&!game.lifecycle.capacity?'resume':'normal';
  return {schemaVersion:4,contentVersion:game.contentVersion,participantIds:game.configuration.participantIds,metadata,
    match:{roomId:room.roomId,matchId:game.matchId,ruleVersion:game.ruleVersion,contentVersion:game.contentVersion,
      startedAt:room.matchStartedAt,participants,configuration:game.configuration},
    sequence:game.publicEventSequence,commitId:`${game.matchId}-${game.publicEventSequence}`,committedAt:game.committedAt,mode,events};
}
/** Return-to-waiting can commit a terminal summary without retaining a room
 * game. Preserve its final public fact using the same frozen match identity. */
export function projectConfiguredDetachedEnd(before,summary){
  const game=before?.game;
  if(!isConfiguredGame(game)||game.status!=='playing'||summary?.matchId!==before.matchId)return null;
  const events=[{type:'match-ended',reason:summary.reason,winnerSeatId:summary.players.find(p=>p.outcome==='win')?.seatId??null}],
    after={...game,lastPublicEvents:events};
  return {schemaVersion:4,contentVersion:game.contentVersion,participantIds:game.configuration.participantIds,
    metadata:isConfiguredBase(game)?projectPublicBattleMetadata(baseToLegacy(game),baseToLegacy(after)):projectConfiguredPublicMetadata(game,after),
    match:{roomId:before.roomId,matchId:before.matchId,ruleVersion:game.ruleVersion,contentVersion:game.contentVersion,
      startedAt:before.matchStartedAt,participants:before.matchParticipants.map(p=>({seatId:p.playerId,userKey:p.userKey})),configuration:game.configuration},
    sequence:game.publicEventSequence+1,commitId:`${game.matchId}-${game.publicEventSequence+1}`,committedAt:summary.endedAt,mode:'terminal',events};
}
