import {openingProblem} from '../../../app/games/hyakki-trading/opening.mjs';
import {isExpansionContentVersion,CONFIGURABLE_RULE_VERSION} from '../../../app/games/hyakki-trading/content/expansion-one.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const requireValue=(yes)=>{if(!yes)throw new TypeError('选角公开门与权威初始化不一致。');};
export const isOpeningHistoryGame=game=>game?.kind==='hyakki-opening-game';

/** Trusted before/after room snapshots only. Private confirmations/cancellation
 * create no public player history. Unified initialization and its first public
 * group are committed by the existing room/event/quota transaction together. */
export function projectOpeningHistory(before,room){
  if(!room?.game){
    requireValue(!before?.game||!isOpeningHistoryGame(before.game)||before.game.opening.status==='selecting');
    return null;
  }
  const game=room.game,opening=game.opening;
  requireValue(isOpeningHistoryGame(game)&&game.version===3&&game.ruleVersion===CONFIGURABLE_RULE_VERSION
    &&isExpansionContentVersion(game.contentVersion)&&openingProblem(opening)===null
    &&game.matchId===opening.openingId&&room.matchId===opening.openingId&&room.matchStartedAt===opening.createdAt);
  if(opening.status==='selecting')return null;
  requireValue(opening.status==='completed'&&game.stage==='initialized'&&opening.deal!==null);
  if(before?.game?.opening?.status==='completed'){
    requireValue(before.matchId===room.matchId&&same(before.game,game));return null;
  }
  const old=before?.game?.opening;
  requireValue(old?.status==='selecting'&&openingProblem(old)===null&&before.matchId===room.matchId
    &&old.openingId===opening.openingId&&opening.revision===old.revision+1
    &&same(old.candidates,opening.candidates)&&same(old.remainingRoles,opening.remainingRoles)
    &&same(old.configuration,opening.configuration)&&old.firstPlayerId===opening.firstPlayerId);
  const participants=room.matchParticipants.map(p=>({seatId:p.playerId,userKey:p.userKey}));
  requireValue(same(participants.map(p=>p.seatId),opening.configuration.participantIds));
  const deal=opening.deal;
  return {schemaVersion:4,contentVersion:game.contentVersion,participantIds:opening.configuration.participantIds,
    metadata:{anchor:{kind:'opening'},source:null,rolesRevealed:deal.players.map(p=>({seatId:p.id,roleId:p.roleId})),
      changes:deal.players.map(p=>({seatId:p.id,silver:p.silver,goods:[],handCount:5,toolsAdded:[],toolsRemoved:[]})),
      discard:{beforeCount:0,afterCount:0,removed:[],added:[]}},
    match:{roomId:room.roomId,matchId:room.matchId,ruleVersion:game.ruleVersion,contentVersion:game.contentVersion,
      startedAt:room.matchStartedAt,participants,configuration:opening.configuration},
    sequence:1,commitId:`${room.matchId}-opening`,committedAt:deal.createdAt,mode:'normal',events:[{type:'match-started'}]};
}
