/** Local feedback, bound to a seat and match. Only the viewer's own known rack is remembered. */
const idsOf = view => (view?.game?.board || []).flat().map(tile => tile.id);
function sameMatch(state, view) {
  const safeIds=value=>value===undefined || Array.isArray(value) && value.length<=180 && value.every(id=>typeof id==='string' && id.length<=128);
  return state && state.version===1 && state.roomId===view.roomId && state.selfId===view.selfId && state.matchId===view.matchId
    && safeIds(state.observedIds) && safeIds(state.ownRackIds)
    && Number.isSafeInteger(state.gameRevision) && state.gameRevision<=view.game.revision
    && Array.isArray(state.baselineIds) && state.baselineIds.length<=180 && new Set(state.baselineIds).size===state.baselineIds.length
    && state.baselineIds.every(id=>typeof id==='string' && idsOf(view).includes(id))
    && typeof state.turnPlayerId==='string';
}
export function updateTurnFeedback(state, view) {
  if(!view?.game || !Array.isArray(view.game.board) || view.gameType==='army-flip' || view.selfRole==='spectator') return null;
  const ids=idsOf(view),restore=sameMatch(state,view);
  const ownTurnCompleted=restore && state.gameRevision<view.game.revision
    && state.turnPlayerId===view.selfId && view.game.turnPlayerId!==view.selfId;
  const gap=restore?view.game.revision-state.gameRevision:0;
  const order=view.game.players?.map(player=>player.id) || [];
  const previousIndex=order.indexOf(state?.turnPlayerId),ownIndex=order.indexOf(view.selfId);
  const ownDistance=previousIndex>=0 && ownIndex>=0?(ownIndex-previousIndex+order.length)%order.length:null;
  const missedOwnCompletion=restore && gap>1 && (ownDistance!==null?gap>ownDistance:state.turnPlayerId===view.selfId);
  let recovered=restore && state.recovered===true;
  let baselineIds=!restore || ownTurnCompleted?ids:state.baselineIds;
  if(missedOwnCompletion) {
    // A whole cycle may have completed during an unknown write / reconnection.
    // Exact authorship cannot be inferred from the final board. Exclude cards
    // already observed and our own known hand, and label the remainder honestly.
    const previouslyKnown=new Set([...(state.observedIds || state.baselineIds),...(state.ownRackIds || [])]);
    baselineIds=ids.filter(id=>previouslyKnown.has(id));recovered=true;
  } else if(ownTurnCompleted || !restore) recovered=false;
  const base=new Set(baselineIds);
  return {version:1,roomId:view.roomId,selfId:view.selfId,matchId:view.matchId,
    gameRevision:view.game.revision,turnPlayerId:view.game.turnPlayerId,baselineIds:[...baselineIds],
    newIds:ids.filter(id=>!base.has(id)),observedIds:[...ids],
    ownRackIds:(view.game.rack || []).map(tile=>tile.id),recovered};
}
export function turnFeedbackMessage(view,newCount=0,{recovered=false}={}) {
  if(!view?.game || view.phase==='waiting') return '等待开局';
  if(view.phase==='paused') return '棋局已暂停保存';
  if(view.phase!=='playing') return '这一局已结束';
  const own=view.game.turnPlayerId===view.selfId;
  if(own) return `轮到你了${newCount?recovered?` · 恢复后新增 ${newCount} 张牌`:` · 朋友新出了 ${newCount} 张牌`:''}`;
  const player=view.players?.find(player=>player.id===view.game.turnPlayerId);
  return `${player?.name || '朋友'}正在出牌${newCount?` · 新牌标记 ${newCount} 张`:''}`;
}
