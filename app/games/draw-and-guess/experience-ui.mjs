/** Only already-public scores and stages drive these presentation cues. Ink,
 * answers, receipts and authorisation remain with the existing controllers. */
export function drawingFeedbackTransition(previous,next,{baseline=false,hidden=false}={}) {
  if(baseline||hidden||!previous?.game||!next?.game||previous.roomId!==next.roomId
    ||previous.matchId!==next.matchId||previous.selfId!==next.selfId||previous.selfRole!==next.selfRole
    ||previous.phase!=='playing'||!['playing','finished'].includes(next.phase)
    ||!(next.game.revision>previous.game.revision))return {gains:[],stage:null};
  const scores=new Map(previous.game.players.map(player=>[player.id,player.score]));
  return {
    gains:next.game.players.filter(player=>scores.has(player.id)&&player.score>scores.get(player.id))
      .map(player=>({id:player.id,points:player.score-scores.get(player.id),drawer:player.id===previous.game.turnPlayerId})),
    stage:previous.game.turnId!==next.game.turnId||previous.game.stage!==next.game.stage?next.game.stage:null,
  };
}

/** Small, interruptible cues beside the affected seat/task. Never covers or
 * resizes the paper; restored views establish a baseline without replay. */
export function createDrawingExperience({root,document:doc,window:win}={}) {
  const live=new Map(),media=win.matchMedia?.('(prefers-reduced-motion: reduce)');let destroyed=false;
  function clear(target) {
    const item=live.get(target);if(!item)return;
    live.delete(target);win.clearTimeout(item.timer);item.animation?.cancel();item.cleanup?.();
  }
  function cancel(){for(const target of [...live.keys()])clear(target);}
  function pulse(target,{gain=null}={}) {
    if(!target||destroyed||doc.hidden)return;
    clear(target);let cleanup;
    if(gain){const badge=target.querySelector('.drawing-score-gain');if(badge){badge.textContent=`+${gain.points}`;badge.hidden=false;
      cleanup=()=>{badge.textContent='';badge.hidden=true;};}}
    const animation=!media?.matches?target.animate?.([
      {transform:'translateY(0)',filter:'brightness(1)'},
      {transform:'translateY(-3px)',filter:'brightness(1.15)',offset:.28},
      {transform:'translateY(0)',filter:'brightness(1)'},
    ],{duration:360,easing:'cubic-bezier(.2,.7,.25,1)'}):null;
    const item={animation,cleanup,timer:win.setTimeout(()=>clear(target),gain?1200:380)};live.set(target,item);
  }
  function apply(previous,next,options={}) {
    const transition=drawingFeedbackTransition(previous,next,{...options,hidden:doc.hidden});
    if(options.baseline||doc.hidden){cancel();return transition;}
    if(previous?.roomId!==next?.roomId||previous?.matchId!==next?.matchId||previous?.selfId!==next?.selfId||previous?.selfRole!==next?.selfRole
      ||previous?.game?.turnId!==next?.game?.turnId||!['playing','finished'].includes(next?.phase))cancel();
    for(const gain of transition.gains){const seat=[...root.querySelectorAll('.drawing-player')].find(row=>row.dataset.playerId===gain.id);pulse(seat,{gain});}
    if(transition.gains.length)pulse(doc.getElementById('drawing-progress'));
    if(transition.stage){const target=doc.getElementById(transition.stage==='reveal'?'drawing-reveal':transition.stage==='finished'?'drawing-result':'drawing-stage');pulse(target);}
    return transition;
  }
  const visibility=()=>{if(doc.hidden)cancel();};
  doc.addEventListener('visibilitychange',visibility);win.addEventListener('resize',cancel);win.addEventListener('pagehide',cancel);media?.addEventListener?.('change',cancel);
  return {apply,reply:()=>pulse(doc.getElementById('drawing-guess-feedback')),cancel,
    destroy(){destroyed=true;cancel();doc.removeEventListener('visibilitychange',visibility);win.removeEventListener('resize',cancel);win.removeEventListener('pagehide',cancel);media?.removeEventListener?.('change',cancel);}};
}
