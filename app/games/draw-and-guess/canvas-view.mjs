/** Page-owned presentation and bounded pending ink. The server owns strokes,
 * sequence, clear generation and writer authorization. Never replay unknown ink. */
import { DRAW_COLORS } from './paint-colors.mjs';
export { DRAW_COLORS };
export const DRAW_WIDTHS = Object.freeze([4,10,22]);
export const DRAW_ERASER_WIDTHS = Object.freeze([8,18,32]);
// 350ms permits at most 172 append starts in a minute; the remaining user
// allowance is for acquisition, reads and edits. Short strokes share a window.
export const DRAW_BATCH_MS = 350;
// Local backpressure is independent of the unchanged upload cadence. A slow
// first ACK must not erase already visible, never-sent later strokes.
// Buffering is bounded by the existing whole-canvas point budget, not an
// unrelated 4096-point cliff. Cutting one gesture into transport chunks must not
// consume the 64-gesture backlog allowance. No server quota or cadence changes.
const MAX_PENDING_GESTURES=64,MAX_CANVAS_POINTS=50000,MAX_PREVIEW_DELTAS=4096,MAX_BATCH_POINTS=256,MAX_STROKE_POINTS=50000;
const SAMPLE_WINDOW = 64, PATH_ERROR_PX = .45;
// Simplify only an unsent, bounded window. Each retained segment is within
// PATH_ERROR_PX of every raw sample it replaces; corners and both ends survive.
// This makes traffic follow visible geometry rather than pointer hardware Hz.
function simplifyWindow(points,geometry) {
  if(points.length<3)return points;
  const pixel=points.map(([x,y])=>[x*geometry.width,y*geometry.height]);
  const keep=new Uint8Array(points.length);keep[0]=keep[points.length-1]=1;
  const stack=[[0,points.length-1]],limit=PATH_ERROR_PX*PATH_ERROR_PX;
  while(stack.length) {
    const [start,end]=stack.pop(),a=pixel[start],b=pixel[end],dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
    let farthest=-1,max=limit;
    for(let i=start+1;i<end;i++) {
      const p=pixel[i],t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)):0;
      const distance=(p[0]-a[0]-t*dx)**2+(p[1]-a[1]-t*dy)**2;
      if(distance>max){max=distance;farthest=i;}
    }
    if(farthest!==-1){keep[farthest]=1;stack.push([start,farthest],[farthest,end]);}
  }
  return points.filter((_,i)=>keep[i]);
}
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
      ||!Array.isArray(stroke.points)||!stroke.points.length||stroke.points.length>MAX_STROKE_POINTS)return '画布笔画格式无效。';
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
// The controller owns this snapshot exclusively. It validates a whole delta
// before appending, and copies inbound points so callers cannot mutate history.
const copyPrivateAppend = current => current;
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
  if(!append)return {accepted:true,snapshot:{...clone(packet),pointCount:packet.strokes.reduce((n,s)=>n+s.points.length,0)},restarted:!!current&&packet.bootId!==current.bootId};
  if(packet.sequence===current.sequence)return {accepted:false,reason:'duplicate'};
  if(packet.sequence!==current.sequence+1||packet.clearGeneration!==current.clearGeneration)return {accepted:false,needsRead:true,reason:'gap'};
  // Validate the complete delta before touching private history. No full stroke
  // clone or 50k-point scan for every chunk; public callers retain deep copies.
  const sizes=new Map(current.strokes.map(item=>[item.strokeId,{item,count:item.points.length}]));
  let pointCount=current.pointCount??current.strokes.reduce((n,item)=>n+item.points.length,0);
  for(const part of packet.operations) {
    const before=sizes.get(part.strokeId);
    if(before&&(before.item.tool!==part.tool||before.item.width!==part.width||before.item.color!==part.color
      ||before.count+part.points.length>MAX_STROKE_POINTS))return {accepted:false,needsRead:true,reason:'style'};
    sizes.set(part.strokeId,{item:part,count:(before?.count??0)+part.points.length});pointCount+=part.points.length;
  }
  if(sizes.size>1500||pointCount>50000)return {accepted:false,needsRead:true,reason:'limit'};
  const next=copyAppend(current);
  for(const part of packet.operations) {
    const index=next.strokes.findIndex(item=>item.strokeId===part.strokeId);
    let stroke=next.strokes[index];
    if(stroke) {
      if(stroke.tool!==part.tool||stroke.width!==part.width||stroke.color!==part.color||stroke.points.length+part.points.length>MAX_STROKE_POINTS)return {accepted:false,needsRead:true,reason:'style'};
      if(copyAppend!==copyPrivateAppend&&stroke===current.strokes[index])stroke=next.strokes[index]=clone(stroke);
      stroke.points.push(...clone(part.points));
    }else next.strokes.push(clone(part));
  }
  Object.assign(next,{sequence:packet.sequence,clearGeneration:packet.clearGeneration,leaseGeneration:packet.leaseGeneration,
    pointCount});
  return {accepted:true,snapshot:next};
}

export function createDrawingCanvasView({canvas,slot,empty,request,onStatus=()=>{},onState=()=>{},onError=()=>{},
  window:win=globalThis.window,document:doc=globalThis.document,now=()=>Date.now(),deviceId=globalThis.crypto.randomUUID(),
  monotonicNow=()=>globalThis.performance.now(),batchMs=DRAW_BATCH_MS,practice=false,fitPaper,surfaceFactory}={}) {
  if(!canvas||!slot||typeof request!=='function')throw new TypeError('绘画需要画布、容器和请求接口。');
  if(!Number.isSafeInteger(batchMs)||batchMs<DRAW_BATCH_MS||typeof monotonicNow!=='function')throw new TypeError('笔迹收集间隔不能小于350毫秒。');
  const context=canvas.getContext('2d');canvas.width=1024;canvas.height=768;
  let scope=null,snapshot=null,lease=null,leaseUntil=0,active=null,pending=[],inflight=null,readTask=null;
  let generation=0,serial=0,destroyed=false,tool='pen',color='#182a33',blocked=true,surface=null,queuedCommand=null;
  const drainWaiters=new Set();
  const widthByTool={pen:10,eraser:18};
  let flushTimer=null,lastAppendAt=null,paintFrameId=null,confirmedDirty=true,lastState=null,writerIntent=0;
  let confirmedDeltas=[],previewDeltas=[],previewDirty=true;
  const backing=typeof context.drawImage==='function'?doc.createElement?.('canvas'):null;
  const backingContext=backing?.getContext?.('2d');
  const preview=backing?doc.createElement?.('canvas'):null,previewContext=preview?.getContext?.('2d');
  const listeners=[];
  const listen=(target,type,handler,options)=>{target?.addEventListener?.(type,handler,options);listeners.push(()=>target?.removeEventListener?.(type,handler,options));};
  const valid=g=>!destroyed&&g===generation;
  const drawable=()=>!!(!destroyed&&!doc.hidden&&scope?.enabled&&scope?.drawer&&scope?.stage==='drawing'&&scope?.phase==='playing'
    &&snapshot?.stage==='drawing'&&!snapshot.paused);
  const allowed=()=>drawable()&&lease!==null&&!blocked&&now()<leaseUntil;
  // An intentional first mark starts writer acquisition. Until that one request
  // is verified, bounded local preview may collect ink, but flush cannot send it.
  const previewAllowed=()=>allowed()||drawable()&&inflight?.kind==='acquire'&&inflight.intent===writerIntent;
  function state() {return {loaded:!!snapshot,ready:allowed(),busy:!!inflight,hasInk:Boolean(snapshot?.strokes?.length),pending:pending.length+Boolean(active),
    canAcquire:!!drawable()&&!!snapshot?.canvasId&&!inflight,canEdit:!!drawable()&&!!snapshot?.canvasId&&!queuedCommand,
    editing:!!queuedCommand,tool,color,width:widthByTool[tool],pointCount:snapshot?.pointCount??0};}
  function stroke(item,opacity=1,target=context) {
    if(!item.points.length)return;
    target.save();target.globalAlpha=opacity;target.strokeStyle=item.tool==='eraser'?'#ffffff':item.color;
    target.fillStyle=target.strokeStyle;target.lineWidth=item.width;target.lineCap='round';target.lineJoin='round';
    const points=item.points;
    target.beginPath();
    if(points.length===1){target.arc(points[0][0]*canvas.width,points[0][1]*canvas.height,item.width/2,0,Math.PI*2);target.fill();}
    else {target.moveTo(points[0][0]*canvas.width,points[0][1]*canvas.height);for(const [x,y]of points.slice(1))target.lineTo(x*canvas.width,y*canvas.height);target.stroke();}
    target.restore();
  }
  function paintFrame() {
    if(destroyed)return;
    const geometry=drawingGeometry(snapshot);
    if(canvas.width!==geometry.width)canvas.width=geometry.width;if(canvas.height!==geometry.height)canvas.height=geometry.height;
    const label=`画布，逻辑尺寸${geometry.width}乘${geometry.height}，所有设备保持相同比例`;
    if(canvas.getAttribute?.('aria-label')!==label)canvas.setAttribute?.('aria-label',label);
    if(surface){surface.render({geometry,snapshot,pending:pending.filter(part=>!inflight?.confirmed||!inflight.parts?.includes(part)),active,
      enabled:drawable()&&!queuedCommand,style:{tool,color,width:widthByTool[tool]}});if(empty)empty.hidden=true;return;}
    context.clearRect(0,0,canvas.width,canvas.height);
    if(backingContext) {
      if(backing.width!==canvas.width||backing.height!==canvas.height){backing.width=canvas.width;backing.height=canvas.height;confirmedDirty=true;}
      if(confirmedDirty){
        backingContext.clearRect(0,0,backing.width,backing.height);
        for(const item of snapshot?.strokes??[])stroke(item,1,backingContext);
        confirmedDirty=false;
      }else for(const item of confirmedDeltas)stroke(item,1,backingContext);
      confirmedDeltas=[];
      context.drawImage(backing,0,0);
    } else for(const item of snapshot?.strokes??[])stroke(item);
    if(previewContext) {
      if(preview.width!==canvas.width||preview.height!==canvas.height){preview.width=canvas.width;preview.height=canvas.height;previewDirty=true;}
      if(previewDirty){previewContext.clearRect(0,0,preview.width,preview.height);for(const item of pending)stroke(item,1,previewContext);if(active)stroke(active,1,previewContext);previewDirty=false;}
      else for(const item of previewDeltas)stroke(item,1,previewContext);
      previewDeltas=[];context.drawImage(preview,0,0);
    }else {for(const item of pending)stroke(item);if(active)stroke(active);}
    if(empty)empty.hidden=Boolean(snapshot?.strokes?.length||pending.length||active);
    canvas.style.cursor=drawable()?'crosshair':'default';
  }
  function render({immediate=false}={}) {
    if(destroyed)return;
    const next=state();
    for(const wake of drainWaiters)wake();
    if(!lastState||Object.keys(next).some(key=>next[key]!==lastState[key])){lastState=next;onState({...next});}
    if(immediate||typeof win.requestAnimationFrame!=='function') {
      if(paintFrameId!==null){win.cancelAnimationFrame(paintFrameId);paintFrameId=null;}
      paintFrame();return;
    }
    if(paintFrameId===null)paintFrameId=win.requestAnimationFrame(()=>{paintFrameId=null;paintFrame();});
  }
  function cancelInk(message,{revoke=false,immediate=false}={}) {
    clearScheduledFlush();
    active=null;pending=[];previewDirty=true;previewDeltas=[];surface?.cancel();
    if(revoke){writerIntent++;lease=null;leaseUntil=0;blocked=true;}
    if(message)onStatus(message);render({immediate});
  }
  function accept(packet,{authoritative=false}={}) {
    if(!scope)return false;
    const result=reconcileDrawingPacket(snapshot,packet,scope,authoritative,copyPrivateAppend);
    if(result.needsRead){cancelInk('正在重新同步已保存画布。未确认笔迹已丢弃。',{revoke:true});refresh().catch(()=>{});return false;}
    if(!result.accepted)return false;
    snapshot=result.snapshot;
    // SSE/full read can commit our batch before its HTTP ACK. Account for those
    // exact points once, while retaining the batch for idempotent ACK handling.
    if(inflight?.kind==='append'&&packet.bootId===inflight.bootId&&packet.sequence===inflight.sequence+1
      &&packet.clearGeneration===inflight.clearGeneration&&packet.leaseGeneration===inflight.leaseGeneration) {
      inflight.confirmed=inflight.expectedTails.every(({strokeId,start,points})=>{
        const saved=snapshot.strokes.find(stroke=>stroke.strokeId===strokeId);
        return saved?.points.length===start+points.length&&points.every((point,index)=>point[0]===saved.points[start+index][0]&&point[1]===saved.points[start+index][1]);
      });
    }
    // Confirmed append chunks extend the backing bitmap exactly once. Full reads,
    // undo/redo, clear and geometry changes rebuild it from authoritative ink.
    if(packet.kind==='append'&&!confirmedDirty&&backingContext)confirmedDeltas.push(...packet.operations.map(clone));
    else {confirmedDirty=true;confirmedDeltas=[];}
    if(result.restarted)cancelInk('服务已恢复，已保存图保持。直接落笔即可继续。',{revoke:true});
    if(lease!==null&&snapshot.leaseGeneration!==lease)cancelInk('另一设备正在绘画。此处落笔可接管，已保存图保持。',{revoke:true});
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
  // Writes need revision headers, not another deep copy of all saved points.
  function canvasHeader(){const {canvasId,bootId,sequence,clearGeneration}=snapshot;return {canvasId,bootId,sequence,clearGeneration};}
  async function acquire() {
    if(!state().canAcquire)return false;
    cancelInk('正在连接画笔，先画的线条会保留预览…',{revoke:true});
    const g=generation,task={kind:'acquire',g,intent:writerIntent};inflight=task;render();
    const stillWanted=()=>valid(g)&&task.intent===writerIntent&&drawable();
    try {
      const before=canvasHeader(),response=await request('acquire',{deviceId,canvasId:before.canvasId,bootId:before.bootId});if(!stillWanted())return false;
      if(response.bootId!==before.bootId||response.canvasId!==before.canvasId)throw new Error('画布已经换题或恢复，请同步后重新落笔。');
      lease=response.leaseGeneration;leaseUntil=response.leaseValidUntil??response.validUntil;blocked=false;
      await refresh();if(!stillWanted())return false;
      if(!Number.isSafeInteger(lease)||!Number.isFinite(leaseUntil)||snapshot?.leaseGeneration!==lease)throw new Error('画笔授权尚未确认。');
      onStatus(practice?'本机自由练画 · 自动保存，不判答案。':'画笔就绪。朋友会逐批看到已确认线条。');return true;
    }catch(error){if(stillWanted()){cancelInk(error.message,{revoke:true});onError(error);await refresh().catch(()=>{});}return false;}
    finally{if(valid(g)&&inflight===task){inflight=null;render();scheduleFlush({collect:!!active?.dirty});}}
  }
  function fit() {
    const geometry=drawingGeometry(snapshot),aspect=geometry.width/geometry.height;
    const box=slot.getBoundingClientRect(),paperWidth=Math.max(1,Math.min(box.width,box.height*aspect));
    const next=fitPaper?.(geometry)??{width:paperWidth,height:paperWidth/aspect};
    canvas.parentElement.style.width=`${next.width}px`;canvas.parentElement.style.height=`${next.height}px`;
    surface?.resize();
  }
  function end(event,{cancel=false}={}) {
    if(!active||active.pointerId!==event.pointerId)return;
    if(cancel){cancelInk('手势已结束，保留已确认笔迹。');return;}
    simplifyActive();const finished=inkPart(active),dirty=active.dirty;active=null;
    if(dirty&&finished.points.length)pending.push(finished);render();scheduleFlush();
  }
  function begin(event) {
    if(event.button!==0||active||queuedCommand)return false;
    const point=normalizedDrawingPoint(event,canvas.getBoundingClientRect());if(!point)return false;
    if(!previewAllowed()) {
      if(!state().canAcquire)return false;
      // acquire clears previous unconfirmed ink synchronously, before this new
      // stroke is created. Mounting or receiving state never acquires a lease.
      void acquire();
      if(!previewAllowed())return false;
    }
    if(pendingGestures()>=MAX_PENDING_GESTURES){onStatus('同步较慢，已有笔迹保持，确认后可继续落笔。');return false;}
    if(bufferedPointCount()>=MAX_CANVAS_POINTS){onStatus('画布已满，撤销或清空后可以继续。');return false;}
    event.preventDefault();active={strokeId:`${deviceId}-${++serial}`,tool,color,width:widthByTool[tool],points:[point],pointerId:event.pointerId,dirty:true,sampleStart:0};
    previewDeltas.push(inkPart(active));
    if(!surfaceFactory)canvas.setPointerCapture?.(event.pointerId);render();scheduleFlush({collect:true});return true;
  }
  function inkPart(item){return {strokeId:item.strokeId,tool:item.tool,color:item.color,width:item.width,points:item.points.slice()};}
  function simplifyActive() {
    if(!active)return;
    const tail=active.points.slice(active.sampleStart),simple=simplifyWindow(tail,drawingGeometry(snapshot));
    active.points.splice(active.sampleStart,tail.length,...simple);
    active.sampleStart=active.points.length-1;
  }
  function move(event) {
    if(!active||active.pointerId!==event.pointerId)return;
    if(!previewAllowed()){cancelInk('画笔授权已结束，未确认轨迹已停止。',{revoke:true});return;}
    event.preventDefault();
    const coalesced=event.getCoalescedEvents?.(),box=canvas.getBoundingClientRect();
    // Pointer capture continues at the paper boundary and back in. Coordinates
    // remain in the same logical paper when the displayed dimensions change.
    const points=[];for(const item of coalesced?.length?[...coalesced,event]:[event]) {
      if(!Number.isFinite(item.clientX)||!Number.isFinite(item.clientY)||box.width<=0||box.height<=0)continue;
      points.push([Math.max(0,Math.min(1,(item.clientX-box.left)/box.width)),Math.max(0,Math.min(1,(item.clientY-box.top)/box.height))]);
    }
    appendPoints(points);
  }
  function appendPoints(points) {
    if(!active||!previewAllowed())return false;
    const geometry=drawingGeometry(snapshot);
    for(const point of points) {
      if(!Array.isArray(point)||point.length!==2||point.some(n=>!Number.isFinite(n)))continue;
      point[0]=Math.max(0,Math.min(1,point[0]));point[1]=Math.max(0,Math.min(1,point[1]));
      const last=active.points.at(-1);
      if(Math.hypot((point[0]-last[0])*geometry.width,(point[1]-last[1])*geometry.height)<.01)continue;
      if(active.capacityBlocked)return false;
      const required=active.dirty?1:2;
      if(bufferedPointCount()+required>MAX_CANVAS_POINTS)simplifyActive();
      if(bufferedPointCount()+required>MAX_CANVAS_POINTS){
        // The real canvas quota is finite. Keep this pointer captured and all
        // collected ink; never invent a chord over samples we cannot accept.
        active.capacityBlocked=true;onStatus('画布已满，已画笔迹正在保存。松开后可撤销或清空画布。');return false;
      }
      if(previewDeltas.length>=MAX_PREVIEW_DELTAS){previewDirty=true;previewDeltas=[];}
      if(!previewDirty)previewDeltas.push({strokeId:active.strokeId,tool:active.tool,color:active.color,width:active.width,points:[last,point]});
      active.points.push(point);active.dirty=true;
      if(active.points.length-active.sampleStart>=SAMPLE_WINDOW)simplifyActive();
      if(active.points.length>=240)batchActive();
    }
    render();scheduleFlush({collect:true});return true;
  }
  if(!surfaceFactory){
    listen(canvas,'pointerdown',begin);listen(canvas,'pointermove',move);
    listen(canvas,'pointerup',event=>{move(event);end(event);});
    for(const type of ['pointercancel','lostpointercapture'])listen(canvas,type,event=>end(event,{cancel:true}));
  }
  function pendingPoints(){return pending.reduce((count,part)=>count+part.points.length,0);}
  function pendingGestures(){return new Set(pending.map(part=>part.strokeId)).size;}
  function bufferedPointCount(){
    const confirmedPending=inflight?.kind==='append'&&inflight.confirmed?inflight.parts.reduce((n,part)=>n+part.points.length,0):0;
    return (snapshot?.pointCount??0)+pendingPoints()-confirmedPending+(active?.dirty?active.points.length:0);
  }
  function batchActive({schedule=true}={}) {
    if(!active||!active.dirty)return;
    simplifyActive();const part=inkPart(active);
    // The overlap joins chunk boundaries but is also a stored point.
    pending.push(part);active={...active,points:[active.points.at(-1)],dirty:false,sampleStart:0};render();if(schedule)scheduleFlush();
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
    for(const part of pending){if(parts.length>=16||points+part.points.length>MAX_BATCH_POINTS)break;parts.push(part);points+=part.points.length;}
    const g=generation,before=canvasHeader(),requestId=globalThis.crypto.randomUUID();
    const operations=parts.map(part=>({strokeId:part.strokeId,tool:part.tool,color:part.color,width:part.width,points:clone(part.points)}));
    lastAppendAt=monotonicNow();
    const tails=new Map();
    for(const part of operations){
      if(!tails.has(part.strokeId))tails.set(part.strokeId,{strokeId:part.strokeId,start:snapshot.strokes.find(s=>s.strokeId===part.strokeId)?.points.length??0,points:[]});
      tails.get(part.strokeId).points.push(...part.points);
    }
    inflight={kind:'append',g,parts,confirmed:false,bootId:before.bootId,sequence:before.sequence,
      clearGeneration:before.clearGeneration,leaseGeneration:lease,expectedTails:[...tails.values()]};render();
    try {
      const response=await request('append',{deviceId,canvasId:before.canvasId,bootId:before.bootId,leaseGeneration:lease,clearGeneration:before.clearGeneration,
        expectedSequence:before.sequence,requestId,operations});if(!valid(g))return;
      const ack=response.ack;
      if(!ack?.persisted||ack.bootId!==before.bootId||ack.canvasId!==before.canvasId)throw new Error('笔画保存尚未确认。');
      pending=pending.filter(item=>!parts.includes(item));previewDirty=true;previewDeltas=[];leaseUntil=ack.leaseValidUntil;
      // SSE may already contain exactly this commit. Use the same seq fence.
      accept({kind:'append',bootId:ack.bootId,canvasId:ack.canvasId,roomId:scope.roomId,matchId:scope.matchId,turnId:scope.turnId,
        sequence:ack.sequence,clearGeneration:ack.clearGeneration,leaseGeneration:ack.leaseGeneration,operations});
      onStatus(active?.capacityBlocked||snapshot.pointCount>=MAX_CANVAS_POINTS?'画布已满，松开后可撤销或清空，再继续画。':practice?'本机练画已确认。':'笔迹已确认，其他人可见。');
    }catch(error){if(valid(g)){cancelInk('笔迹结果尚未确认。先同步已保存画布，不自动补画。',{revoke:true});onError(error);await refresh().catch(()=>{});}}
    finally{if(valid(g)){inflight=null;render();scheduleFlush();}}
  }
  async function command(type) {
    if(!state().canEdit)return false;
    const queued={type,g:generation,intent:writerIntent};queuedCommand=queued;
    if(active){surface?.finish();if(active)end({pointerId:active.pointerId});}
    render();
    try{return await executeCommand(type,queued);}finally{if(queuedCommand===queued){queuedCommand=null;render();}}
  }
  async function executeCommand(type,queued) {
    const intentGeneration=queued.g;
    // Intent is captured immediately; server edits wait for this same turn's
    // bounded ink queue. No guessed history, unknown-write replay or later-turn edit.
    if(inflight||pending.length){
      onStatus('正在保存最后一笔，随后执行操作…');
      await new Promise(resolve=>{const wake=()=>{if(!valid(intentGeneration)||queued.intent!==writerIntent||!drawable()||!inflight&&!pending.length){drainWaiters.delete(wake);resolve();}};drainWaiters.add(wake);scheduleFlush();wake();});
    }
    if(!valid(intentGeneration)||queued.intent!==writerIntent||!drawable())return false;
    // A deliberate edit may renew an idle/failed writer. Never require another
    // mark just to undo or clear a full canvas, and never resend unknown ink.
    const recoverWriter=type==='clear'&&!practice;
    if(!recoverWriter&&!allowed()&&!await acquire())return false;
    if(!valid(intentGeneration)||!drawable()||!recoverWriter&&!allowed()||inflight||active||pending.length)return false;
    // Clearing must also work at the exact byte quota. Renewing a writer in a
    // separate commit can itself need more space, so confirm the latest image
    // and ask the server to renew and clear in one atomic, fenced operation.
    if(recoverWriter)cancelInk('正在确认并清空画布…',{revoke:true});
    const g=generation,task={kind:type,g,intent:writerIntent};inflight=task;render();
    const stillWanted=()=>valid(g)&&task.intent===writerIntent&&drawable();
    try {
      if(recoverWriter){await refresh();if(!stillWanted()||!snapshot?.canvasId)return false;}
      const before=canvasHeader();
      const response=await request(type,{deviceId,canvasId:before.canvasId,bootId:before.bootId,leaseGeneration:lease,clearGeneration:before.clearGeneration,
        expectedSequence:before.sequence,requestId:globalThis.crypto.randomUUID(),
        ...(recoverWriter?{recoverWriter:true,leaseGeneration:snapshot.leaseGeneration}:{})});if(!stillWanted())return false;
      if(!response.ack?.persisted||response.ack.bootId!==before.bootId||response.ack.canvasId!==before.canvasId)throw new Error('操作保存尚未确认。');
      if(recoverWriter){
        if(!integer(response.ack.leaseGeneration)||!Number.isFinite(response.ack.leaseValidUntil))throw new Error('画笔授权尚未确认。');
        lease=response.ack.leaseGeneration;blocked=false;
      }
      leaseUntil=response.ack.leaseValidUntil;await refresh();if(!stillWanted()||!allowed())return false;
      onStatus(type==='clear'?'画布已清空，可以继续画。':'画布已更新。');return true;
    }catch(error){if(valid(g)){cancelInk('画布操作结果未知，先重新同步。',{revoke:true});onError(error);await refresh().catch(()=>{});}return false;}
    finally{if(valid(g)&&inflight===task){inflight=null;render();}}
  }
  function setContext(value) {
    if(destroyed)return;
    const changed=identity(value)!==identity(scope),phaseChanged=value?.stage!==scope?.stage||value?.phase!==scope?.phase;
    if(changed){generation++;queuedCommand=null;snapshot=null;confirmedDirty=true;confirmedDeltas=[];inflight=null;readTask=null;cancelInk('',{revoke:true,immediate:true});}
    scope=value;
    if(!scope?.enabled||!scope?.drawer||scope.phase!=='playing'||scope.stage!=='drawing')cancelInk('',{revoke:true});
    fit();render();
    if((changed||phaseChanged)&&scope?.roomId)refresh().catch(()=>{});
  }
  // A still-held, stationary pen is an ongoing user intent. Appending its
  // current endpoint once before expiry changes no geometry, stays within the
  // same writer fence, and uses the ordinary cadence/ACK path. No reacquisition
  // race, read, or background heartbeat; pointerup removes the intent. This
  // costs at most one canvas point per 10 seconds of actually holding still.
  const timer=win.setInterval(()=>{
    if(lease!==null&&now()>=leaseUntil){cancelInk('画笔已休息，图仍保存。直接落笔即可继续。',{revoke:true});return;}
    if(active&&!active.capacityBlocked&&!inflight&&!pending.length&&!active.dirty&&allowed()
      &&now()>=leaseUntil-5000&&bufferedPointCount()<MAX_CANVAS_POINTS) {
      active.dirty=true;scheduleFlush();
    }
  },batchMs);
  listen(doc,'visibilitychange',()=>{if(doc.hidden)cancelInk('',{revoke:true});});
  listen(win,'pagehide',()=>cancelInk('',{revoke:true}));
  const resize=typeof win.ResizeObserver==='function'?new win.ResizeObserver(fit):null;resize?.observe(slot);
  if(surfaceFactory)surface=surfaceFactory({canvas,host:canvas.parentElement,onBegin:begin,onPoints:appendPoints,
    onEnd:()=>{if(active)end({pointerId:active.pointerId});},
    onStyle:next=>{if(/^#[a-f0-9]{6}$/iu.test(next.color))color=next.color;if(Number.isSafeInteger(next.width)&&next.width>=1&&next.width<=32)widthByTool[tool]=next.width;render();},
    onCommand:type=>command(type),onError});
  return {state,fit,setContext,receive:packet=>accept(packet),refresh,acquire,
    setProperties:open=>surface?.setProperties(open),
    undo:()=>command('undo'),redo:()=>command('redo'),clear:()=>command('clear'),
    finishPointer:()=>{surface?.finish();if(active)end({pointerId:active.pointerId});},
    setTool:value=>{if(['pen','eraser'].includes(value)){tool=value;render();}},
    setColor:value=>{if(DRAW_COLORS.some(([color])=>color===value)){color=value;render();}},
    brushStyle:()=>({tool,color,width:widthByTool[tool]}),
    setWidth:value=>{if((tool==='eraser'?DRAW_ERASER_WIDTHS:DRAW_WIDTHS).includes(value)){widthByTool[tool]=value;render();}},
    conceal(){generation++;scope=null;snapshot=null;confirmedDirty=true;confirmedDeltas=[];inflight=null;readTask=null;cancelInk('',{revoke:true,immediate:true});},
    destroy(){if(destroyed)return;snapshot=null;confirmedDirty=true;confirmedDeltas=[];cancelInk('',{revoke:true,immediate:true});destroyed=true;generation++;for(const wake of drainWaiters)wake();surface?.destroy();win.clearInterval(timer);resize?.disconnect();listeners.forEach(remove=>remove());if(backing){backing.width=1;backing.height=1;}if(preview){preview.width=1;preview.height=1;}},
  };
}
