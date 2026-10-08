/** Page-owned presentation and bounded pending ink. The server owns strokes,
 * sequence, clear generation and writer authorization. Never replay unknown ink. */
export const DRAW_COLORS = Object.freeze([['#ed2634','红'],['#1269dc','蓝'],['#27884f','绿'],['#e8b51e','黄'],
  ['#182a33','黑'],['#ffffff','白'],['#f58a2b','橙'],['#864aba','紫']].map(Object.freeze));
export const DRAW_WIDTHS = Object.freeze([4,10,22]);
// 350ms permits at most 172 append starts in a minute; the remaining user
// allowance is for acquisition, reads and edits. Short strokes share a window.
export const DRAW_BATCH_MS = 350;
const MAX_PENDING_PARTS = 4,MAX_BATCH_POINTS = 256;
const integer = value => Number.isSafeInteger(value) && value>=0;
const clone = value => structuredClone(value);
const identity = value => JSON.stringify([value?.roomId,value?.matchId,value?.turnId]);
export function drawingGeometry(value) {
  const geometry=value&&Object.hasOwn(value,'geometry')?value.geometry:{width:1024,height:768};
  if(!geometry||typeof geometry!=='object'||Array.isArray(geometry)||Object.keys(geometry).length!==2
    ||geometry.width!==1024||![768,576].includes(geometry.height))throw new TypeError('画布尺寸无效。');
  return {width:geometry.width,height:geometry.height};
}
export function normalizedDrawingPoint(event,box) {
  if(!box||box.width<=0||box.height<=0||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return null;
  const x=(event.clientX-box.left)/box.width,y=(event.clientY-box.top)/box.height;
  return x<0||x>1||y<0||y>1?null:[x,y];
}
export function drawingPacketProblem(value,{snapshot=true}={}) {
  try{drawingGeometry(value);}catch{return '画布尺寸无效。';}
  if(!value||typeof value!=='object'||typeof value.bootId!=='string'||!value.bootId
    || !integer(value.sequence)||!integer(value.clearGeneration)||!integer(value.leaseGeneration)
    ||typeof value.roomId!=='string'||value.matchId!==null&&typeof value.matchId!=='string'
    ||value.turnId!==null&&typeof value.turnId!=='string')return '画布响应格式无效。';
  const strokes=snapshot?value.strokes:value.operations;
  if(!Array.isArray(strokes)||strokes.length>1500)return '画布笔画超出范围。';
  let count=0;
  for(const stroke of strokes) {
    if(!stroke||typeof stroke.strokeId!=='string'||stroke.strokeId.length>160||!['pen','eraser'].includes(stroke.tool)
      ||!/^#[a-f0-9]{6}$/iu.test(stroke.color)||!Number.isSafeInteger(stroke.width)||stroke.width<1||stroke.width>32
      ||!Array.isArray(stroke.points)||!stroke.points.length||stroke.points.length>4096)return '画布笔画格式无效。';
    for(const point of stroke.points)if(!Array.isArray(point)||point.length!==2||point.some(n=>!Number.isFinite(n)||n<0||n>1))return '画布坐标无效。';
    count+=stroke.points.length;
  }
  return count>50000?'画布点数超出范围。':null;
}
/** Pure reconciliation used by HTTP and SSE alike. Duplicate sequence is an
 * acknowledgement, never another stroke; a gap requires a full read. */
export function applyDrawingPacket(current,packet,scope,{authoritative=false}={}) {
  return reconcileDrawingPacket(current,packet,scope,authoritative,clone);
}
// The controller never exposes its snapshots. Unchanged strokes can remain
// shared between those private snapshots; edited strokes and incoming ink cannot.
const copyPrivateAppend = current => ({...current,strokes:current.strokes.slice()});
function reconcileDrawingPacket(current,packet,scope,authoritative,copyAppend) {
  if(identity(packet)!==identity(scope))return {accepted:false,reason:'scope'};
  if(packet.kind==='recovery')return {accepted:false,needsRead:true,reason:'recovery'};
  const append=packet.kind==='append',invalid=drawingPacketProblem(packet,{snapshot:!append});
  if(invalid)return {accepted:false,needsRead:true,reason:'invalid'};
  if(current&&packet.bootId!==current.bootId&&!authoritative)return {accepted:false,needsRead:true,reason:'boot'};
  if(!current&&append)return {accepted:false,needsRead:true,reason:'initial'};
  if(append&&packet.geometry&&JSON.stringify(drawingGeometry(packet))!==JSON.stringify(drawingGeometry(current)))return {accepted:false,needsRead:true,reason:'geometry'};
  if(current&&packet.bootId===current.bootId&&(packet.sequence<current.sequence
    ||packet.clearGeneration<current.clearGeneration||packet.leaseGeneration<current.leaseGeneration))return {accepted:false,reason:'old'};
  if(!append)return {accepted:true,snapshot:clone(packet),restarted:!!current&&packet.bootId!==current.bootId};
  if(packet.sequence===current.sequence)return {accepted:false,reason:'duplicate'};
  if(packet.sequence!==current.sequence+1||packet.clearGeneration!==current.clearGeneration)return {accepted:false,needsRead:true,reason:'gap'};
  const next=copyAppend(current);
  for(const part of packet.operations) {
    const index=next.strokes.findIndex(item=>item.strokeId===part.strokeId);
    let stroke=next.strokes[index];
    if(stroke) {
      if(stroke.tool!==part.tool||stroke.width!==part.width||stroke.color!==part.color||stroke.points.length+part.points.length>4096)return {accepted:false,needsRead:true,reason:'style'};
      if(stroke===current.strokes[index])stroke=next.strokes[index]=clone(stroke);
      stroke.points.push(...clone(part.points));
    }else next.strokes.push(clone(part));
  }
  Object.assign(next,{sequence:packet.sequence,clearGeneration:packet.clearGeneration,leaseGeneration:packet.leaseGeneration,
    pointCount:packet.pointCount??next.strokes.reduce((count,stroke)=>count+stroke.points.length,0)});
  if(drawingPacketProblem(next))return {accepted:false,needsRead:true,reason:'limit'};
  return {accepted:true,snapshot:next};
}

export function createDrawingCanvasView({canvas,slot,empty,request,onStatus=()=>{},onState=()=>{},onError=()=>{},
  window:win=globalThis.window,document:doc=globalThis.document,now=()=>Date.now(),deviceId=globalThis.crypto.randomUUID(),
  monotonicNow=()=>globalThis.performance.now(),batchMs=DRAW_BATCH_MS,practice=false}={}) {
  if(!canvas||!slot||typeof request!=='function')throw new TypeError('绘画需要画布、容器和请求接口。');
  if(!Number.isSafeInteger(batchMs)||batchMs<DRAW_BATCH_MS||typeof monotonicNow!=='function')throw new TypeError('笔迹收集间隔不能小于350毫秒。');
  const context=canvas.getContext('2d');canvas.width=1024;canvas.height=768;
  let scope=null,snapshot=null,lease=null,leaseUntil=0,active=null,pending=[],inflight=null,readTask=null;
  let generation=0,serial=0,destroyed=false,tool='pen',color='#182a33',width=10,blocked=true,lastBox=null;
  let flushTimer=null,lastAppendAt=null;
  const listeners=[];
  const listen=(target,type,handler,options)=>{target?.addEventListener?.(type,handler,options);listeners.push(()=>target?.removeEventListener?.(type,handler,options));};
  const valid=g=>!destroyed&&g===generation;
  const allowed=()=>!destroyed&&!doc.hidden&&scope?.enabled&&scope?.drawer&&scope?.stage==='drawing'&&scope?.phase==='playing'
    &&snapshot&&snapshot.stage==='drawing'&&!snapshot.paused&&Boolean(lease!==null)&&!blocked&&now()<leaseUntil;
  function state() {return {ready:allowed(),busy:!!inflight,hasInk:Boolean(snapshot?.strokes?.length),pending:pending.length+Boolean(active),
    canAcquire:!!scope?.enabled&&!!scope?.drawer&&scope?.stage==='drawing'&&!!snapshot?.canvasId&&!snapshot?.paused&&!inflight,pointCount:snapshot?.pointCount??0};}
  function stroke(item,opacity=1) {
    if(!item.points.length)return;
    context.save();context.globalAlpha=opacity;context.strokeStyle=item.tool==='eraser'?'#ffffff':item.color;
    context.fillStyle=context.strokeStyle;context.lineWidth=item.width;context.lineCap='round';context.lineJoin='round';
    const points=item.points;
    context.beginPath();
    if(points.length===1){context.arc(points[0][0]*canvas.width,points[0][1]*canvas.height,item.width/2,0,Math.PI*2);context.fill();}
    else {context.moveTo(points[0][0]*canvas.width,points[0][1]*canvas.height);for(const [x,y]of points.slice(1))context.lineTo(x*canvas.width,y*canvas.height);context.stroke();}
    context.restore();
  }
  function render() {
    if(destroyed)return;
    const geometry=drawingGeometry(snapshot);
    if(canvas.width!==geometry.width)canvas.width=geometry.width;if(canvas.height!==geometry.height)canvas.height=geometry.height;
    canvas.setAttribute?.('aria-label',`画布，逻辑尺寸${geometry.width}乘${geometry.height}，所有设备保持相同比例`);
    context.clearRect(0,0,canvas.width,canvas.height);
    for(const item of snapshot?.strokes??[])stroke(item);
    for(const item of pending)stroke(item,.55);
    if(active)stroke(active,.55);
    if(empty)empty.hidden=Boolean(snapshot?.strokes?.length||pending.length||active);
    canvas.style.cursor=allowed()?'crosshair':'default';onState(state());
  }
  function cancelInk(message,{revoke=false}={}) {
    clearScheduledFlush();
    active=null;pending=[];
    if(revoke){lease=null;leaseUntil=0;blocked=true;}
    if(message)onStatus(message);render();
  }
  function accept(packet,{authoritative=false}={}) {
    if(!scope)return false;
    const result=reconcileDrawingPacket(snapshot,packet,scope,authoritative,copyPrivateAppend);
    if(result.needsRead){cancelInk('正在重新同步已保存画布。未确认笔迹已丢弃。',{revoke:true});refresh().catch(()=>{});return false;}
    if(!result.accepted)return false;
    snapshot=result.snapshot;
    if(result.restarted)cancelInk('服务已恢复。已保存图保持，请在这里重新拿起画笔。',{revoke:true});
    if(lease!==null&&snapshot.leaseGeneration!==lease)cancelInk('画笔已由另一设备接管。此处保持看图。',{revoke:true});
    if(snapshot.stage!=='drawing'||snapshot.paused||!scope.enabled)cancelInk('',{revoke:true});
    fit();render();return true;
  }
  async function refresh() {
    if(destroyed||!scope?.roomId)return;
    if(readTask)return readTask;
    const g=generation;
    const task=(async()=>{try{const packet=await request('read');if(valid(g))accept(packet,{authoritative:true});}
      catch(error){if(valid(g)){cancelInk('画布暂未同步。请重新连接。',{revoke:true});onError(error);throw error;}}
      finally{if(readTask===task)readTask=null;}})();
    readTask=task;return task;
  }
  async function acquire() {
    if(!state().canAcquire)return false;
    cancelInk('正在确认画笔…',{revoke:true});const g=generation;inflight={kind:'acquire',g};render();
    try {
      const before=clone(snapshot),response=await request('acquire',{deviceId,canvasId:before.canvasId,bootId:before.bootId});if(!valid(g))return false;
      if(response.bootId!==before.bootId||response.canvasId!==before.canvasId)throw new Error('画布已经换题或恢复，请同步后重新拿笔。');
      lease=response.leaseGeneration;leaseUntil=response.leaseValidUntil??response.validUntil;blocked=false;
      await refresh();if(!valid(g))return false;
      if(!Number.isSafeInteger(lease)||!Number.isFinite(leaseUntil)||snapshot?.leaseGeneration!==lease)throw new Error('画笔授权尚未确认。');
      onStatus(practice?'本机自由练画 · 自动保存，不判答案。':'画笔就绪。朋友会逐批看到已确认线条。');return true;
    }catch(error){if(valid(g)){cancelInk(error.message,{revoke:true});onError(error);await refresh().catch(()=>{});}return false;}
    finally{if(valid(g)){inflight=null;render();}}
  }
  function fit() {
    const geometry=drawingGeometry(snapshot),aspect=geometry.width/geometry.height;
    const box=slot.getBoundingClientRect(),paperWidth=Math.max(1,Math.min(box.width,box.height*aspect));
    const next={width:paperWidth,height:paperWidth/aspect};
    if(lastBox&&(Math.abs(next.width-lastBox.width)>2||Math.abs(next.height-lastBox.height)>2)&&active)
      cancelInk('画面尺寸已变化，已确认笔迹保持。请重新落笔。');
    lastBox=next;canvas.parentElement.style.width=`${next.width}px`;canvas.parentElement.style.height=`${next.height}px`;
  }
  function end(event,{cancel=false}={}) {
    if(!active||active.pointerId!==event.pointerId)return;
    if(cancel){cancelInk('手势已结束，保留已确认笔迹。');return;}
    const finished={...active};delete finished.pointerId;delete finished.total;delete finished.dirty;const dirty=active.dirty;active=null;
    if(dirty&&finished.points.length)pending.push(finished);render();scheduleFlush();
  }
  listen(canvas,'pointerdown',event=>{
    if(event.button!==0||!allowed()||active||pending.length>=MAX_PENDING_PARTS)return;
    const point=normalizedDrawingPoint(event,canvas.getBoundingClientRect());if(!point)return;
    event.preventDefault();active={strokeId:`${deviceId}-${++serial}`,tool,color,width,points:[point],pointerId:event.pointerId,total:1,dirty:true};
    canvas.setPointerCapture?.(event.pointerId);render();scheduleFlush({collect:true});
  });
  listen(canvas,'pointermove',event=>{
    if(!active||active.pointerId!==event.pointerId)return;
    if(!allowed()){cancelInk('画笔授权已结束，未确认轨迹已停止。',{revoke:true});return;}
    event.preventDefault();
    const coalesced=event.getCoalescedEvents?.();
    // Some PointerEvents expose the API but contain no buffered samples.
    for(const item of coalesced?.length?coalesced:[event]) {
      const point=normalizedDrawingPoint(item,canvas.getBoundingClientRect());
      if(!point){end(event);return;}
      const last=active.points.at(-1);
      if(Math.hypot(point[0]-last[0],point[1]-last[1])<.001)continue;
      if(active.total>=4096||pending.length>=MAX_PENDING_PARTS){cancelInk('这笔过长或同步较慢，请等确认后另画一笔。');return;}
      active.points.push(point);active.total++;active.dirty=true;
      if(active.points.length>=240)batchActive();
    }
    render();scheduleFlush({collect:true});
  });
  listen(canvas,'pointerup',event=>end(event));
  for(const type of ['pointercancel','lostpointercapture'])listen(canvas,type,event=>end(event,{cancel:true}));
  function batchActive({schedule=true}={}) {
    if(!active||!active.dirty||pending.length>=MAX_PENDING_PARTS)return;
    const part={...active};delete part.pointerId;delete part.total;delete part.dirty;
    // The overlap joins chunk boundaries but is also a stored point.
    pending.push(part);active={...active,points:[active.points.at(-1)],total:active.total+1,dirty:false};render();if(schedule)scheduleFlush();
  }
  function clearScheduledFlush() {
    if(flushTimer!==null)win.clearTimeout(flushTimer);flushTimer=null;
  }
  function scheduleFlush({collect=false}={}) {
    if(destroyed||flushTimer!==null||inflight||!allowed()||!pending.length&&!active?.dirty)return;
    const clock=monotonicNow(),collectionDue=collect||lastAppendAt===null?clock+batchMs:clock;
    const rateDue=lastAppendAt===null?clock:lastAppendAt+batchMs,due=Math.max(collectionDue,rateDue);
    flushTimer=win.setTimeout(()=>{flushTimer=null;if(!allowed())return;batchActive({schedule:false});flush();},Math.max(0,due-clock));
  }
  async function flush() {
    if(inflight||!pending.length||!allowed())return;
    if(lastAppendAt!==null&&monotonicNow()-lastAppendAt<batchMs){scheduleFlush();return;}
    const parts=[];let points=0;
    for(const part of pending){if(points+part.points.length>MAX_BATCH_POINTS)break;parts.push(part);points+=part.points.length;}
    const g=generation,before=clone(snapshot),requestId=globalThis.crypto.randomUUID();
    const operations=parts.map(part=>({strokeId:part.strokeId,tool:part.tool,color:part.color,width:part.width,points:clone(part.points)}));
    lastAppendAt=monotonicNow();
    inflight={kind:'append',g};render();
    try {
      const response=await request('append',{deviceId,canvasId:before.canvasId,bootId:before.bootId,leaseGeneration:lease,clearGeneration:before.clearGeneration,
        expectedSequence:before.sequence,requestId,operations});if(!valid(g))return;
      const ack=response.ack;
      if(!ack?.persisted||ack.bootId!==before.bootId||ack.canvasId!==before.canvasId)throw new Error('笔画保存尚未确认。');
      pending=pending.filter(item=>!parts.includes(item));leaseUntil=ack.leaseValidUntil;
      // SSE may already contain exactly this commit. Use the same seq fence.
      accept({kind:'append',bootId:ack.bootId,canvasId:ack.canvasId,roomId:scope.roomId,matchId:scope.matchId,turnId:scope.turnId,
        sequence:ack.sequence,clearGeneration:ack.clearGeneration,leaseGeneration:ack.leaseGeneration,operations});
      onStatus(practice?'本机练画已确认。':'笔迹已确认，其他人可见。');
    }catch(error){if(valid(g)){cancelInk('笔迹结果尚未确认。先同步已保存画布，不自动补画。',{revoke:true});onError(error);await refresh().catch(()=>{});}}
    finally{if(valid(g)){inflight=null;render();scheduleFlush();}}
  }
  async function command(type) {
    if(!allowed()||inflight||active||pending.length)return false;
    const g=generation,before=clone(snapshot);inflight={kind:type,g};render();
    try {
      const response=await request(type,{deviceId,canvasId:before.canvasId,bootId:before.bootId,leaseGeneration:lease,clearGeneration:before.clearGeneration,
        expectedSequence:before.sequence,requestId:globalThis.crypto.randomUUID()});if(!valid(g))return false;
      if(!response.ack?.persisted||response.ack.bootId!==before.bootId||response.ack.canvasId!==before.canvasId)throw new Error('操作保存尚未确认。');
      leaseUntil=response.ack.leaseValidUntil;await refresh();if(valid(g))onStatus(type==='clear'?'画布已清空。':'画布已更新。');return true;
    }catch(error){if(valid(g)){cancelInk('画布操作结果未知，先重新同步。',{revoke:true});onError(error);await refresh().catch(()=>{});}return false;}
    finally{if(valid(g)){inflight=null;render();}}
  }
  function setContext(value) {
    if(destroyed)return;
    const changed=identity(value)!==identity(scope),phaseChanged=value?.stage!==scope?.stage||value?.phase!==scope?.phase;
    if(changed){generation++;snapshot=null;inflight=null;readTask=null;cancelInk('',{revoke:true});}
    scope=value;
    if(!scope?.enabled||!scope?.drawer)cancelInk('',{revoke:true});
    fit();render();
    if((changed||phaseChanged)&&scope?.roomId)refresh().catch(()=>{});
  }
  const timer=win.setInterval(()=>{
    if(lease!==null&&now()>=leaseUntil){cancelInk('画笔已休息。点「继续绘画」重新启用，图仍保存。',{revoke:true});return;}
  },batchMs);
  listen(doc,'visibilitychange',()=>{if(doc.hidden)cancelInk('',{revoke:true});});
  listen(win,'pagehide',()=>cancelInk('',{revoke:true}));
  const resize=typeof win.ResizeObserver==='function'?new win.ResizeObserver(fit):null;resize?.observe(slot);
  return {state,fit,setContext,receive:packet=>accept(packet),refresh,acquire,
    undo:()=>command('undo'),redo:()=>command('redo'),clear:()=>command('clear'),
    finishPointer:()=>{if(active)end({pointerId:active.pointerId});},
    setTool:value=>{if(['pen','eraser'].includes(value)){tool=value;}},
    setColor:value=>{if(DRAW_COLORS.some(([color])=>color===value))color=value;},
    setWidth:value=>{if(DRAW_WIDTHS.includes(value))width=value;},
    conceal(){generation++;scope=null;snapshot=null;inflight=null;readTask=null;cancelInk('',{revoke:true});},
    destroy(){if(destroyed)return;cancelInk('',{revoke:true});destroyed=true;generation++;win.clearInterval(timer);resize?.disconnect();listeners.forEach(remove=>remove());},
  };
}
