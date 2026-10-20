import test from 'node:test';
import assert from 'node:assert/strict';
import {createDrawingCanvasView,applyDrawingPacket} from './games/draw-and-guess/canvas-view.mjs';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const scope={roomId:'pen-room',matchId:'pen-match',turnId:'pen-turn',drawer:true,enabled:true,phase:'playing',stage:'drawing'};
const target=()=>{const handlers=new Map();return {addEventListener:(type,fn)=>handlers.set(type,fn),removeEventListener:type=>handlers.delete(type),emit:(type,event={})=>handlers.get(type)?.(event)};};
// A deterministic 1:4 raster oracle implements the Canvas 2D operations this
// view uses. It checks actual compositing/order before and after ACKs, not only
// model arrays. Browser pixels are additionally exercised by the release UI run.
function rasterCanvas() {
  const pixels=new Map(),canvas={width:0,height:0,pixels};let path=[],dot=null;
  const ctx={strokeStyle:'#000000',lineWidth:10,save(){},restore(){},clearRect(){pixels.clear();},beginPath(){path=[];dot=null;},
    arc(x,y,r){dot=[x,y,r];},moveTo(x,y){path=[[x,y]];},lineTo(x,y){path.push([x,y]);},
    drawImage(source){for(const [key,value]of source.pixels)pixels.set(key,value);},
    fill(){if(dot)paintSegment([dot[0],dot[1]],[dot[0],dot[1]],dot[2]);},
    stroke(){for(let i=1;i<path.length;i++)paintSegment(path[i-1],path[i],ctx.lineWidth/2);}};
  function paintSegment(a,b,r) {
    const left=Math.max(0,Math.floor((Math.min(a[0],b[0])-r)/4)),right=Math.min(255,Math.ceil((Math.max(a[0],b[0])+r)/4));
    const top=Math.max(0,Math.floor((Math.min(a[1],b[1])-r)/4)),bottom=Math.min(191,Math.ceil((Math.max(a[1],b[1])+r)/4));
    for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)if(segmentDistance([x*4+2,y*4+2],a,b)<=r)pixels.set(y*256+x,ctx.strokeStyle==='#ffffff'?2:1);
  }
  canvas.getContext=()=>ctx;return canvas;
}
function harness({ackMs=0,acquireMs=0,echoBeforeAck=false,raster=false,failAppend=false}={}) {
  let time=0,id=0,reads=0,acquires=0;const timers=new Map(),writes=[],edits=[],statuses=[],work={segments:0,clears:0,copies:0};
  const delay=(fn,ms,repeat=false)=>{const key=++id;timers.set(key,{fn,at:time+ms,ms,repeat});return key;};
  const win={...target(),setTimeout:delay,clearTimeout:key=>timers.delete(key),setInterval:(fn,ms)=>delay(fn,ms,true),clearInterval:key=>timers.delete(key)};
  const ctx=()=>({clearRect(){work.clears++;},drawImage(){work.copies++;},save(){},restore(){},beginPath(){},arc(){},fill(){},moveTo(){},lineTo(){work.segments++;},stroke(){}});
  const doc={...target(),hidden:false,createElement:()=>raster?rasterCanvas():{width:0,height:0,getContext:ctx}};
  const box={left:0,top:0,width:1024,height:768};
  const canvas={...(raster?rasterCanvas():{getContext:ctx}),...target(),style:{},parentElement:{style:{}},getBoundingClientRect:()=>({...box}),getAttribute(){},setAttribute(){},setPointerCapture(){}};
  let saved={kind:'replace',...scope,bootId:'boot',canvasId:'canvas',sequence:0,clearGeneration:0,leaseGeneration:0,strokes:[],pointCount:0,paused:false};
  const request=async(type,body)=>{
    if(type==='read'){reads++;return structuredClone(saved);}
    if(type==='acquire'){acquires++;if(acquireMs)await new Promise(resolve=>delay(resolve,acquireMs));saved={...saved,leaseGeneration:saved.leaseGeneration+1};return {...saved,leaseValidUntil:time+15000};}
    if(type==='clear'||type==='undo'){edits.push({type,at:time});
      saved={...saved,strokes:type==='clear'?[]:saved.strokes.slice(0,-1),sequence:saved.sequence+1,
        clearGeneration:saved.clearGeneration+(type==='clear'?1:0),leaseGeneration:saved.leaseGeneration+(body.recoverWriter?1:0)};
      saved.pointCount=saved.strokes.reduce((n,s)=>n+s.points.length,0);return {ack:{...saved,persisted:true,leaseValidUntil:time+15000}};
    }
    assert.equal(type,'append');const record={at:time,body:structuredClone(body)};writes.push(record);
    const packet={kind:'append',...scope,bootId:saved.bootId,canvasId:saved.canvasId,sequence:saved.sequence+1,clearGeneration:saved.clearGeneration,leaseGeneration:saved.leaseGeneration,operations:body.operations};
    if(echoBeforeAck){saved=applyDrawingPacket(saved,packet,scope).snapshot;assert.ok(saved);view.receive(structuredClone(packet));}
    if(ackMs)await new Promise(resolve=>delay(resolve,ackMs));
    if(failAppend)throw new Error('synthetic unknown append');
    if(!echoBeforeAck){saved=applyDrawingPacket(saved,packet,scope).snapshot;assert.ok(saved);}
    return {ack:{...packet,persisted:true,leaseValidUntil:time+15000}};
  };
  const view=createDrawingCanvasView({canvas,slot:{getBoundingClientRect:()=>({...box})},window:win,document:doc,request,now:()=>time,monotonicNow:()=>time,deviceId:'pen-device',batchMs:1000,onStatus:text=>statuses.push(text)});
  const fire=(type,x=100,y=100,extra={})=>canvas.emit(type,{button:0,pointerId:1,clientX:x,clientY:y,preventDefault(){},...extra});
  async function advance(ms){const end=time+ms;for(;;){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;const [key,t]=next;time=t.at;if(t.repeat)t.at+=t.ms;else timers.delete(key);t.fn();await settle();}time=end;await settle();}
  async function start(){view.setContext(scope);await view.refresh();const grant=view.acquire();await advance(acquireMs);await grant;}
  return {view,fire,advance,start,box,doc,win,writes,edits,statuses,work,canvas,get saved(){return saved;},get time(){return time;},get acquires(){return acquires;},get reads(){return reads;},seed(strokes){saved={...saved,strokes:structuredClone(strokes),pointCount:strokes.reduce((n,s)=>n+s.points.length,0)};view.receive(saved);},takeover(){saved={...saved,leaseGeneration:saved.leaseGeneration+1};view.receive(saved);},destroy(){view.destroy();assert.equal(timers.size,0);}};
}
const curve=(index,rate=480)=>{const a=index/rate*2*Math.PI;return [512+240*Math.cos(a),384+160*Math.sin(a)];};
const points=f=>f.saved.strokes.flatMap(stroke=>stroke.points.map(([x,y])=>[x*1024,y*768]));
const near=(actual,expected,epsilon=.46)=>assert.ok(Math.hypot(actual[0]-expected[0],actual[1]-expected[1])<=epsilon,`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);

test('actual one-second room cadence keeps a 480Hz 30-second gesture through 2s acknowledgements',async t=>{
  const f=harness({ackMs:2000});await f.start();f.fire('pointerdown',...curve(0));
  for(let i=1;i<=14400;i++){f.fire('pointermove',...curve(i));await f.advance(1000/480);}
  f.fire('pointerup',...curve(14400));await f.advance(12000);
  const output=points(f);assert.equal(f.saved.strokes.length,1);near(output.at(-1),curve(14400));
  // The drawing returns to its starting point each second: total length, not only
  // an endpoint, detects silent early release or skipped complete loops.
  const length=output.reduce((n,p,i)=>i?n+Math.hypot(p[0]-output[i-1][0],p[1]-output[i-1][1]):0,0);
  assert.ok(length>37000,`all thirty loops must survive; got length ${length}`);
  assert.equal(f.view.state().pending,0);assert.ok(f.writes.every((w,i)=>!i||w.at-f.writes[i-1].at>=1000));
  assert.ok(f.writes.every(w=>w.body.operations.length<=16&&w.body.operations.reduce((n,p)=>n+p.points.length,0)<=256));
  assert.ok(f.work.segments<150000,'preview work must stay proportional to arriving ink, not pending history per sample');
  t.diagnostic(JSON.stringify({rawSamples:14401,retainedPoints:f.saved.pointCount,appendRequests:f.writes.length,rasterLineSegments:f.work.segments,gestureLength:length}));f.destroy();
});

test('resizing the displayed paper during a held pointer preserves its gesture and normalized tail',async()=>{
  const f=harness();await f.start();f.fire('pointerdown',100,100);f.fire('pointermove',200,200);
  Object.assign(f.box,{width:512,height:384});f.view.fit();f.fire('pointermove',200,150);f.fire('pointerup',200,150);await f.advance(2000);
  assert.equal(f.saved.strokes.length,1);near(points(f).at(-1),[400,300]);f.destroy();
});

test('captured pointer can leave and return to paper without silently losing the remaining gesture',async()=>{
  const f=harness();await f.start();f.fire('pointerdown',900,300);f.fire('pointermove',1100,300);f.fire('pointermove',900,400);f.fire('pointermove',600,500);f.fire('pointerup',600,500);await f.advance(2000);
  assert.equal(f.saved.strokes.length,1);near(points(f).at(-1),[600,500]);f.destroy();
});

test('a held still pen renews its live writer before expiry and continues without a second down',async()=>{
  const f=harness();await f.start();f.fire('pointerdown',100,100);await f.advance(18000);f.fire('pointermove',800,500);f.fire('pointerup',800,500);await f.advance(2000);
  assert.equal(f.saved.strokes.length,1);near(points(f).at(-1),[800,500]);assert.equal(f.acquires,1,'a held pen renews with the ordinary append fence, not a new writer acquisition');f.destroy();
});

const segmentDistance=(point,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length)):0;return Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dy);};
function assertGeometry(raw,output) {
  near(output[0],raw[0]);near(output.at(-1),raw.at(-1));
  let worst=0;
  for(const p of raw){let distance=Infinity;for(let i=1;i<output.length;i++)distance=Math.min(distance,segmentDistance(p,output[i-1],output[i]));worst=Math.max(worst,distance);}
  assert.ok(worst<=.450001,`raw geometry drift ${worst}px exceeds the 0.45 logical-pixel budget`);
}

for(const tool of ['pen','eraser'])test(`${tool}: fast 3px loops and acute zigzags preserve corners, endpoints and subpixel geometry`,async()=>{
  const f=harness({ackMs:250});await f.start();f.view.setTool(tool);f.view.setWidth(tool==='eraser'?8:4);
  const raw=[];
  for(let i=0;i<=1200;i++){const a=i/32*Math.PI*2;raw.push([200+3*Math.cos(a),200+3*Math.sin(a)]);}
  for(let leg=0;leg<8;leg++){const a=raw.at(-1),b=[400+(leg%2)*100,210+leg*45];for(let i=1;i<=128;i++)raw.push([a[0]+(b[0]-a[0])*i/128,a[1]+(b[1]-a[1])*i/128]);}
  f.fire('pointerdown',...raw[0]);for(const p of raw.slice(1)){f.fire('pointermove',...p);await f.advance(1000/480);}f.fire('pointerup',...raw.at(-1));await f.advance(8000);
  assert.equal(f.saved.strokes.length,1);assert.equal(f.saved.strokes[0].tool,tool);assertGeometry(raw,points(f));assert.equal(f.view.state().pending,0);f.destroy();
});

test('pointerup contributes its own final coordinate while another captured touch never joins the stroke',async()=>{
  const f=harness();await f.start();f.fire('pointerdown',100,100);f.fire('pointermove',200,200);f.fire('pointermove',800,100,{pointerId:2});f.fire('pointerup',900,100,{pointerId:2});f.fire('pointerup',300,400);await f.advance(2000);
  assert.deepEqual(points(f),[[100,100],[200,200],[300,400]]);f.destroy();
});

test('high frequency incompressible zigzags remain one full gesture under sustained 2s acknowledgements',async t=>{
  const f=harness({ackMs:2000});await f.start();f.fire('pointerdown',100,100);
  for(let i=1;i<=12000;i++){f.fire('pointermove',100+(i%2)*600,100+(i%3)*200);await f.advance(1000/480);}
  // A later point while still held must survive after the upload backlog drains.
  await f.advance(110000);f.fire('pointermove',800,650);f.fire('pointerup',800,650);await f.advance(4000);
  assert.equal(f.saved.strokes.length,1);near(points(f).at(-1),[800,650]);
  assert.ok(f.saved.strokes[0].points.length>=12002,'none of the alternating corners can be simplified or dropped');
  assert.equal(f.view.state().pending,0);assert.ok(f.writes.every((w,i)=>!i||w.at-f.writes[i-1].at>=1000));
  t.diagnostic(JSON.stringify({rawSamples:12002,retainedPoints:f.saved.pointCount,appendRequests:f.writes.length}));f.destroy();
});

for(const invalidation of ['takeover','hide','reveal','conceal'])test(`${invalidation}: ongoing stationary-pen renewal never reacquires or paints after authority ends`,async()=>{
  const f=harness();await f.start();f.fire('pointerdown',100,100);await f.advance(2000);
  if(invalidation==='takeover')f.takeover();
  if(invalidation==='hide'){f.doc.hidden=true;f.doc.emit('visibilitychange');}
  if(invalidation==='reveal')f.view.setContext({...scope,stage:'reveal'});
  if(invalidation==='conceal')f.view.conceal();
  const calls=f.writes.length;await f.advance(20000);f.fire('pointermove',800,500);f.fire('pointerup',800,500);await f.advance(2000);
  assert.equal(f.writes.length,calls);assert.equal(f.acquires,1);assert.equal(f.view.state().ready,false);f.destroy();
});

test('a stopped pointer never keeps its writer alive in the background',async()=>{
  const f=harness();await f.start();f.fire('pointerdown',100,100);f.fire('pointerup',100,100);await f.advance(40000);
  assert.equal(f.writes.length,1);assert.equal(f.view.state().ready,false);assert.equal(f.acquires,1);f.destroy();
});

test('SSE before delayed HTTP acknowledgements keeps later pen and eraser gestures and applies each chunk once',async()=>{
  const f=harness({ackMs:2000,echoBeforeAck:true});await f.start();
  f.fire('pointerdown',100,100);f.fire('pointermove',300,300);f.fire('pointerup',400,300);await f.advance(1000);
  f.view.setTool('eraser');f.view.setWidth(32);f.fire('pointerdown',200,100);f.fire('pointermove',200,400);f.fire('pointerup',200,500);
  f.view.setTool('pen');f.fire('pointerdown',600,100);f.fire('pointermove',600,500);f.fire('pointerup',650,600);await f.advance(8000);
  assert.equal(f.saved.strokes.length,3);assert.deepEqual(f.saved.strokes.map(s=>s.tool),['pen','eraser','pen']);
  assert.deepEqual(f.saved.strokes.map(s=>s.points.at(-1)),[[400/1024,300/768],[200/1024,500/768],[650/1024,600/768]]);
  assert.equal(f.view.state().pending,0);assert.equal(f.view.state().pointCount,f.saved.pointCount);f.destroy();
});

test('the real 50k canvas ceiling keeps collected ink bounded and visible without accepting a false continuation',async()=>{
  const f=harness();await f.start();
  f.seed([{strokeId:'old',tool:'pen',color:'#182a33',width:10,points:Array.from({length:49980},(_,i)=>[(i%2)*.5,.2])}]);
  f.fire('pointerdown',100,100);
  for(let i=1;i<=3000;i++)f.fire('pointermove',100+(i%2)*600,100+(i%3)*200);
  assert.ok(f.statuses.some(text=>text.includes('画布已满')));assert.ok(f.view.state().pending>0,'held pointer and collected ink remain until release');
  f.fire('pointerup',800,600);await f.advance(2000);
  assert.equal(f.saved.pointCount,50000);assert.equal(f.view.state().pending,0);
  assert.equal(f.saved.strokes.length,2);assert.notDeepEqual(f.saved.strokes[1].points.at(-1),[800/1024,600/768]);f.destroy();
});

test('SSE-confirmed pending points count only once toward the unchanged canvas ceiling',async()=>{
  const f=harness({ackMs:2000,echoBeforeAck:true});await f.start();
  f.seed([{strokeId:'old',tool:'pen',color:'#182a33',width:10,points:Array.from({length:49990},(_,i)=>[(i%2)*.5,.2])}]);
  f.fire('pointerdown',100,100);f.fire('pointermove',300,400);f.fire('pointerup',400,200);await f.advance(1000);
  f.fire('pointerdown',100,300);f.fire('pointermove',300,100);f.fire('pointermove',400,600);f.fire('pointermove',800,100);f.fire('pointerup',900,500);await f.advance(6000);
  assert.equal(f.saved.strokes.length,3);near(points(f).at(-1),[900,500]);assert.equal(f.saved.pointCount,49998);
  assert.equal(f.statuses.some(text=>text.includes('画布已满')),false);f.destroy();
});

test('pending bitmap preserves pen/eraser/pen pixel order across SSE, delayed ACK and full read rebuild',async()=>{
  const f=harness({ackMs:2000,echoBeforeAck:true,raster:true});await f.start();
  f.view.setWidth(22);f.fire('pointerdown',100,300);f.fire('pointermove',700,300);f.fire('pointerup',800,300);await f.advance(1000);
  f.view.setTool('eraser');f.view.setWidth(32);f.fire('pointerdown',400,100);f.fire('pointermove',400,500);f.fire('pointerup',400,600);
  f.view.setTool('pen');f.view.setWidth(10);f.fire('pointerdown',300,200);f.fire('pointermove',500,400);f.fire('pointerup',600,500);
  const before=new Map(f.canvas.pixels);
  assert.equal(before.get(75*256+50),1,'first pen remains outside eraser');
  assert.equal(before.get(70*256+100),2,'eraser covers the first pen');
  assert.equal(before.get(75*256+100),1,'later pen wins where it crosses the eraser');
  await f.advance(9000);assert.deepEqual(f.canvas.pixels,before,'ACK removes preview only after the same ink is confirmed');
  await f.view.refresh();assert.deepEqual(f.canvas.pixels,before,'full authoritative bitmap matches the incremental path');f.destroy();
});

for(const command of ['undo','clear'])test(`${command} frees a full canvas for the next intentional gesture`,async()=>{
  const f=harness();await f.start();f.seed([{strokeId:'full',tool:'pen',color:'#182a33',width:10,points:Array.from({length:50000},(_,i)=>[(i%2)*.5,.2])}]);
  f.fire('pointerdown',100,100);f.fire('pointerup',200,200);await f.advance(1000);assert.equal(f.writes.length,0);
  assert.ok(f.statuses.at(-1).includes('画布已满'));assert.equal(await f.view[command](),true);
  f.fire('pointerdown',100,100);f.fire('pointermove',300,300);f.fire('pointerup',800,500);await f.advance(2000);
  assert.equal(f.saved.strokes.length,1);near(points(f).at(-1),[800,500]);assert.equal(f.view.state().pending,0);f.destroy();
});


test('first-stroke undo is immediately available and executes once after the same ink is acknowledged',async()=>{
 const f=harness({ackMs:2000});await f.start();f.fire('pointerdown',100,100);f.fire('pointerup',300,150);
 assert.equal(f.view.state().canEdit,true);const edit=f.view.undo();assert.equal(f.view.state().editing,true);
 assert.equal(await f.view.undo(),false);f.fire('pointerdown',500,300);f.fire('pointerup',600,300);
 await f.advance(4000);assert.equal(await edit,true);assert.equal(f.saved.strokes.length,0);
 assert.deepEqual(f.edits.map(e=>e.type),['undo']);assert.equal(f.writes.length,1);assert.equal(f.view.state().editing,false);f.destroy();
});
for(const kind of ['takeover','hide','reveal','conceal'])test(`a queued edit cannot cross ${kind}`,async()=>{
 const f=harness({ackMs:2000});await f.start();f.fire('pointerdown',100,100);f.fire('pointerup',300,150);
 await f.advance(1000);const edit=f.view.clear();
 if(kind==='takeover')f.takeover();if(kind==='hide'){f.doc.hidden=true;f.doc.emit('visibilitychange');}
 if(kind==='reveal')f.view.setContext({...scope,stage:'reveal'});if(kind==='conceal')f.view.conceal();
 await f.advance(4000);assert.equal(await edit,false);assert.equal(f.edits.length,0);f.destroy();
});
test('unknown append outcome cancels a queued undo even if a subsequent read finds committed ink',async()=>{
 const f=harness({ackMs:2000,echoBeforeAck:true,failAppend:true});await f.start();f.fire('pointerdown',100,100);f.fire('pointerup',300,150);
 await f.advance(1000);const edit=f.view.undo();await f.advance(4000);
 assert.equal(await edit,false);assert.equal(f.saved.strokes.length,1);assert.equal(f.edits.length,0);f.destroy();
});
