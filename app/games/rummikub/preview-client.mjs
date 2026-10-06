export const TABLE_COORDINATE_MAX=10000;
const groupKey=meld=>meld.map(tile=>tile.id).sort().join('|');
export function encodeBoardPositions(board,positions={}) {
  return board.map(meld=>{
    const point=positions[groupKey(meld)];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ?{x:Math.min(1,Math.max(0,point.x/TABLE_COORDINATE_MAX)),y:Math.min(1,Math.max(0,point.y/TABLE_COORDINATE_MAX))}:null;
  });
}
export function decodeBoardPositions(board,positions) {
  if(!Array.isArray(positions) || positions.length!==board.length) return {};
  return Object.fromEntries(board.flatMap((meld,index)=>{
    const point=positions[index];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1
      ?[[groupKey(meld),{x:point.x*TABLE_COORDINATE_MAX,y:point.y*TABLE_COORDINATE_MAX}]]:[];
  }));
}
/** Coalesce public draft changes. Unknown results are never replayed. */
export function createPreviewPublisher({send,onError=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,id=()=>crypto.randomUUID()}={}) {
  let key=null,source=null,sequence=0,signature=null,pending=null,timer=null,nextAt=0,flight=null,epoch=0,enabled=false,paused=false;
  function cancel(){if(timer!==null)clearTimer(timer);timer=null;}
  function reset(){++epoch;cancel();key=null;source=null;sequence=0;signature=null;pending=null;nextAt=0;enabled=false;paused=false;flight=null;}
  function schedule(){if(!enabled || paused || !pending || flight || timer!==null)return;timer=setTimer(flush,Math.max(0,nextAt-now()));}
  async function flush(){
    timer=null;if(!enabled || paused || !pending || flight)return;
    const entry=pending;pending=null;const generation=epoch,currentFlight={generation};flight=currentFlight;
    source ||=id();const body={...entry.payload,previewId:source,sequence:++sequence};
    try {
      const ack=await send(body);
      if(generation!==epoch)return;
      nextAt=Math.max(now()+Math.max(1000,ack.minIntervalMs || 1000),ack.nextAllowedAt || 0);
      if(body.clear){source=null;sequence=0;}
    } catch(error) {
      if(generation!==epoch)return;
      if(error.status===429){
        nextAt=Math.max(now()+Math.max(1000,error.minIntervalMs || (error.retryAfter || 1)*1000),error.nextAllowedAt || 0);
        // A known rejected optional update can be replaced by the newest draft.
        pending ||=entry;
      }else {
        if(error.status===409){source=null;sequence=0;}
        if(error.status===409 && error.code==='PREVIEW_SEQUENCE' && !body.clear && !entry.renewed) {
          // This rejection proves the retired source did not accept the edit.
          // Renew once, using the latest draft, without replaying uncertain
          // results or retrying turn/fence/other-device permission failures.
          pending ||=entry;
          if(!pending.payload.clear) pending={...pending,renewed:true};
          nextAt=Math.max(nextAt,now()+1000);
        } else {
          // Only a distinct subsequent local change may retry an unknown result.
          try {onError(error);} catch {/* Optional preview feedback cannot break a confirmed game. */}
        }
      }
    }finally {if(flight===currentFlight){flight=null;schedule();}}
  }
  function update({fence,eligible,payload,paused:pause=false}) {
    if(fence!==key){reset();key=fence;}
    // Losing the audience or authorization ends this preview generation.
    // A later watcher needs a fresh snapshot even if the draft is unchanged;
    // an old in-flight acknowledgement must not revive its expired source.
    if(enabled && eligible!==true){reset();key=fence;}
    enabled=eligible===true;
    paused=pause===true;
    if(!enabled){cancel();pending=null;return;}
    const next=JSON.stringify(payload);
    if(payload.clear && !source){signature=next;pending=null;cancel();return;}
    if(next!==signature){signature=next;pending={payload:structuredClone(payload)};}
    // A confirmed business write temporarily suspends optional publications,
    // but does not change identity, audience or the active preview source.
    if(paused){cancel();return;}
    schedule();
  }
  return {update,reset};
}
