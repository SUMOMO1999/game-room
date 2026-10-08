import test from 'node:test';
import assert from 'node:assert/strict';
import {createDrawingCanvasView,applyDrawingPacket,DRAW_BATCH_MS} from './games/draw-and-guess/canvas-view.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const scope={roomId:'room',matchId:'match',turnId:'turn',drawer:true,enabled:true,phase:'playing',stage:'drawing'};
function harness({append,batchMs=DRAW_BATCH_MS}={}) {
  let time=0,wallOffset=1000,id=0;
  const timers=new Map(),handlers=new Map(),writes=[],localPaint=[];
  const setTimer=(fn,ms,repeat=false)=>{const key=++id;timers.set(key,{fn,due:time+ms,ms,repeat});return key;};
  const win={setTimeout:(fn,ms)=>setTimer(fn,ms),clearTimeout:key=>timers.delete(key),
    setInterval:(fn,ms)=>setTimer(fn,ms,true),clearInterval:key=>timers.delete(key),addEventListener(){},removeEventListener(){}};
  const canvas={style:{},parentElement:{style:{}},setAttribute(){},setPointerCapture(){},
    addEventListener:(type,fn)=>handlers.set(type,fn),removeEventListener:(type)=>handlers.delete(type),
    getBoundingClientRect:()=>({left:0,top:0,width:400,height:300}),
    getContext:()=>({clearRect(){},save(){},restore(){},beginPath(){},arc(){localPaint.push(time);},fill(){},
      moveTo(){localPaint.push(time);},lineTo(){},stroke(){}})};
  let saved={bootId:'boot',canvasId:'canvas',roomId:scope.roomId,matchId:scope.matchId,turnId:scope.turnId,stage:'drawing',paused:false,
    sequence:0,clearGeneration:0,leaseGeneration:1,strokes:[],pointCount:0,deadline:999999};
  async function request(type,body) {
    if(type==='read')return structuredClone(saved);
    if(type==='acquire')return {bootId:saved.bootId,canvasId:saved.canvasId,leaseGeneration:1,leaseValidUntil:time+wallOffset+15000,persisted:true};
    assert.equal(type,'append');writes.push({at:time,body:structuredClone(body)});
    const commit=()=>{
      const packet={kind:'append',bootId:saved.bootId,canvasId:saved.canvasId,roomId:scope.roomId,matchId:scope.matchId,turnId:scope.turnId,
        sequence:saved.sequence+1,clearGeneration:0,leaseGeneration:1,operations:body.operations};
      saved=applyDrawingPacket(saved,packet,scope).snapshot;
      return {ack:{...packet,persisted:true,leaseValidUntil:time+wallOffset+15000}};
    };
    return append?append({body,commit,writes}):commit();
  }
  const view=createDrawingCanvasView({canvas,slot:{getBoundingClientRect:()=>({width:400,height:300})},window:win,
    document:{hidden:false,addEventListener(){},removeEventListener(){}},now:()=>time+wallOffset,monotonicNow:()=>time,
    deviceId:'cadence-device',request,batchMs});
  const fire=(type,point={})=>handlers.get(type)?.({button:0,pointerId:1,clientX:40,clientY:60,preventDefault(){},...point});
  async function advance(ms) {
    const end=time+ms;
    for(;;) {
      const next=[...timers].filter(([,timer])=>timer.due<=end).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];
      if(!next)break;
      const [key,timer]=next;time=timer.due;
      if(timer.repeat)timer.due+=timer.ms;else timers.delete(key);
      timer.fn();await settle();
    }
    time=end;await settle();
  }
  async function start(){view.setContext(scope);await view.refresh();await view.acquire();assert.equal(view.state().ready,true);}
  return {view,fire,advance,start,writes,localPaint,timers,get saved(){return saved;},get time(){return time;},shiftWall(ms){wallOffset+=ms;}};
}

test('350ms collection coalesces finished short strokes and paints locally before network confirmation',async()=>{
  const h=harness();await h.start();h.fire('pointerdown');h.fire('pointerup');
  assert.equal(h.localPaint.at(-1),0);assert.equal(h.writes.length,0);
  await h.advance(100);h.fire('pointerdown',{clientX:90});h.fire('pointerup');await h.advance(249);
  assert.equal(h.writes.length,0);await h.advance(1);
  assert.equal(h.writes.length,1);assert.equal(h.writes[0].at,350);assert.equal(h.writes[0].body.operations.length,2);
  assert.equal(h.saved.strokes.length,2);assert.equal(h.view.state().pending,0);h.view.destroy();assert.equal(h.timers.size,0);
});

test('room upload coalesces one second of locally painted strokes without losing any ink',async()=>{
  const h=harness({batchMs:1000});await h.start();
  for(let index=0;index<4;index++) {
    h.fire('pointerdown',{clientX:40+index*20});h.fire('pointerup');
    assert.equal(h.localPaint.at(-1),index*200);
    await h.advance(200);
  }
  assert.equal(h.writes.length,0);await h.advance(200);
  assert.equal(h.writes.length,1);assert.equal(h.saved.strokes.length,4);
  assert.equal(h.writes[0].body.operations.length,4);assert.equal(h.view.state().pending,0);
  h.view.destroy();assert.equal(h.timers.size,0);
});

test('60 seconds of repeated short strokes stays within 150 appends/min and keeps all 300 strokes',async()=>{
  const h=harness();await h.start();
  for(let index=0;index<300;index++) {h.fire('pointerdown',{clientX:40+index%100});h.fire('pointerup');await h.advance(200);}
  assert.equal(DRAW_BATCH_MS,350);assert.equal(h.writes.length,150);assert.equal(h.saved.strokes.length,300);
  assert.ok(h.writes.every((write,index)=>index===0||write.at-h.writes[index-1].at>=350));
  assert.ok(h.writes.every(write=>write.body.operations.length===2));assert.equal(h.view.state().pending,0);h.view.destroy();
});

test('120 seconds of continuous input caps append starts at the 350ms cadence with no catch-up burst',async()=>{
  const h=harness();await h.start();h.fire('pointerdown');
  for(let index=0;index<2400;index++) {h.fire('pointermove',{clientX:20+index%300,clientY:30+index%200});await h.advance(50);}
  assert.equal(h.writes.length,342);assert.ok(h.writes.every((write,index)=>index===0||write.at-h.writes[index-1].at>=350));
  h.fire('pointerup');await h.advance(350);assert.equal(h.writes.length,343);assert.equal(h.view.state().pending,0);h.view.destroy();
});

test('a held pointer publishes its first dot, then only newly moved points with the same whole-stroke identity',async()=>{
  const h=harness();await h.start();h.fire('pointerdown');await h.advance(350);
  assert.equal(h.saved.pointCount,1);await h.advance(700);assert.equal(h.writes.length,1,'a stationary dot is not resent');
  h.fire('pointermove',{clientX:80});await h.advance(349);assert.equal(h.writes.length,1);await h.advance(1);
  assert.equal(h.writes.length,2);assert.equal(h.saved.strokes.length,1);assert.equal(h.saved.pointCount,3,'one explicit overlap joins the moved segment');
  h.fire('pointerup');await h.advance(700);assert.equal(h.writes.length,2,'release does not append the already confirmed trailing point');h.view.destroy();
});

test('dense point chunks never exceed 256 points and never flush faster when a chunk fills',async()=>{
  const h=harness();await h.start();h.fire('pointerdown');
  for(let index=1;index<=269;index++)h.fire('pointermove',{clientX:20+index%300,clientY:30+index%200});
  h.fire('pointerup');assert.equal(h.writes.length,0);await h.advance(700);
  assert.equal(h.writes.length,2);assert.deepEqual(h.writes.map(write=>write.at),[350,700]);
  assert.ok(h.writes.every(write=>write.body.operations.reduce((sum,part)=>sum+part.points.length,0)<=256));
  assert.equal(h.saved.strokes.length,1);assert.equal(h.saved.pointCount,271);h.view.destroy();
});

test('slow acknowledgement keeps one append in flight and drains already collected ink without catch-up bursts',async()=>{
  let release;const first=new Promise(resolve=>{release=resolve;});
  const h=harness({append:async({commit,writes})=>{if(writes.length===1)await first;return commit();}});await h.start();
  h.fire('pointerdown');h.fire('pointerup');await h.advance(350);
  h.fire('pointerdown',{clientX:80});h.fire('pointerup');await h.advance(700);
  assert.equal(h.writes.length,1);assert.equal(h.view.state().busy,true);release();await settle();await h.advance(0);
  assert.equal(h.writes.length,2);assert.deepEqual(h.writes.map(write=>write.at),[350,1050]);assert.equal(h.saved.strokes.length,2);
  await h.advance(700);assert.equal(h.writes.length,2);h.view.destroy();
});

test('unknown append preserves committed ink via read and never replays the remaining local batch',async()=>{
  const h=harness({append:({commit})=>{commit();throw new Error('synthetic lost acknowledgement');}});await h.start();
  h.fire('pointerdown');h.fire('pointerup');await h.advance(350);
  assert.equal(h.writes.length,1);assert.equal(h.saved.strokes.length,1);assert.equal(h.view.state().hasInk,true);
  assert.equal(h.view.state().ready,false);assert.equal(h.view.state().pending,0);await h.advance(4000);assert.equal(h.writes.length,1);h.view.destroy();
});

test('four pending parts bound an unresponsive writer and conceal cancels all scheduled ink',async()=>{
  let release;const response=new Promise(resolve=>{release=resolve;});
  const h=harness({append:async({commit})=>{await response;return commit();}});await h.start();
  h.fire('pointerdown');h.fire('pointerup');await h.advance(350);
  for(let index=0;index<8;index++){h.fire('pointerdown',{clientX:80+index});h.fire('pointerup');}
  assert.equal(h.view.state().pending,4);assert.equal(h.writes.length,1);h.view.conceal();release();await settle();await h.advance(1000);
  assert.equal(h.writes.length,1);assert.equal(h.view.state().hasInk,false);assert.equal(h.view.state().pending,0);h.view.destroy();assert.equal(h.timers.size,0);
});

test('wall clock correction does not alter append spacing and pointer cancellation does not flush',async()=>{
  const h=harness();await h.start();h.fire('pointerdown');h.fire('pointercancel');await h.advance(350);assert.equal(h.writes.length,0);
  h.fire('pointerdown');h.fire('pointerup');await h.advance(350);h.shiftWall(-500);
  h.fire('pointerdown',{clientX:80});h.fire('pointerup');await h.advance(350);
  assert.deepEqual(h.writes.map(write=>write.at),[700,1050]);h.view.destroy();
});

test('invalid sub-350ms collector is rejected instead of silently exceeding the existing user bucket',()=>{
  assert.throws(()=>createDrawingCanvasView({canvas:{},slot:{},request(){},batchMs:100}),/350毫秒/);
});

test('a browser exposing an empty coalesced event array still records the current pointer movement',async()=>{
  const h=harness();await h.start();h.fire('pointerdown');h.fire('pointermove',{clientX:80,getCoalescedEvents:()=>[]});
  h.fire('pointerup');await h.advance(350);assert.equal(h.saved.pointCount,2);assert.deepEqual(h.saved.strokes[0].points,[[.1,.2],[.2,.2]]);h.view.destroy();
});
