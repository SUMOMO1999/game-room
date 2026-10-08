import test from 'node:test';
import assert from 'node:assert/strict';
import {drawingStageText,latestGuessReceipt} from './games/draw-and-guess/game-page.mjs';
import {applyDrawingPacket,drawingPacketProblem,drawingGeometry,normalizedDrawingPoint,createDrawingCanvasView} from './games/draw-and-guess/canvas-view.mjs';
import {createDrawingPracticeSession,practiceCanvasProblem} from './games/draw-and-guess/practice-engine.mjs';

const scope={roomId:'room',matchId:'match',turnId:'turn'},stroke=(id='stroke-1',points=[[.1,.2]])=>({strokeId:id,tool:'pen',color:'#182a33',width:10,points});
const snapshot=(extra={})=>({bootId:'boot-a',canvasId:'canvas',...scope,stage:'drawing',deadline:999999,paused:false,
  sequence:0,clearGeneration:0,leaseGeneration:1,strokes:[],pointCount:0,...extra});
const append=(seq=1,extra={})=>({kind:'append',bootId:'boot-a',canvasId:'canvas',...scope,sequence:seq,clearGeneration:0,leaseGeneration:1,operations:[stroke()],pointCount:1,...extra});
const memory=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value)};};
function drawingHarness(request,now=()=>1000,box={width:400,height:300}) {
  const paths=[],attributes={},handlers=new Map(),canvas={width:0,height:0,style:{},parentElement:{style:{}},
    addEventListener(type,fn){handlers.set(type,fn);},removeEventListener(){},setPointerCapture(){},
    setAttribute(name,value){attributes[name]=value;},
    getBoundingClientRect:()=>({left:0,top:0,width:400,height:300}),
    getContext:()=>({clearRect(){},save(){},restore(){},beginPath(){},arc(){},fill(){},moveTo(x,y){paths.push(['move',x,y]);},lineTo(x,y){paths.push(['line',x,y]);},stroke(){}})};
  let tick,serial=1;const timeouts=new Map(),win={setInterval(fn){tick=fn;return 1;},clearInterval(){},
    setTimeout(fn){const id=++serial;timeouts.set(id,fn);return id;},clearTimeout(id){timeouts.delete(id);},addEventListener(){},removeEventListener(){}};
  const doc={hidden:false,addEventListener(){},removeEventListener(){}};
  const view=createDrawingCanvasView({canvas,slot:{getBoundingClientRect:()=>box},request,window:win,document:doc,deviceId:'test-device',now,monotonicNow:now});
  const fire=(type,point={})=>handlers.get(type)?.({button:0,pointerId:1,clientX:40,clientY:60,preventDefault(){},...point});
  return {view,canvas,paths,attributes,box,fire,tick:()=>{tick();for(const [id,fn]of [...timeouts]){timeouts.delete(id);fn();}},doc};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('public stage copy separates choosing/drawer/guesser/spectator/reveal/paused/finished',()=>{
  const base={phase:'playing',selfId:'b',selfRole:'player',players:[{id:'a',name:'甲'}],game:{stage:'drawing',turnPlayerId:'a',guessedPlayerIds:[]}};
  assert.match(drawingStageText(base),/甲正在画/);assert.match(drawingStageText({...base,selfRole:'spectator'}),/观战/);
  assert.match(drawingStageText({...base,selfId:'a'}),/你正在绘画/);
  assert.match(drawingStageText({...base,game:{...base.game,stage:'choosing'}}),/选词/);
  assert.match(drawingStageText({...base,phase:'paused'}),/已暂停/);
  assert.match(drawingStageText({...base,game:{...base.game,stage:'reveal',word:{answer:'猫'}}}),/猫/);
  assert.match(drawingStageText({...base,game:{...base.game,stage:'finished',result:{winnerIds:[]}}}),/无人猜中/);
});

test('owner guess receipt works without a public type/text field and never reuses old feedback',()=>{
  const view={actionReceipts:[{requestId:'old',status:'committed',guessResult:{correct:false,points:0}},
    {requestId:'ready',status:'committed'},{requestId:'new',status:'committed',guessResult:{correct:true,points:175}},
    {requestId:'bad',status:'rejected',error:{message:'错误'}}]};
  assert.equal(latestGuessReceipt(view,['old']).requestId,'new');assert.equal(latestGuessReceipt(view,['old','new']),null);
  assert.equal(latestGuessReceipt(view,[],undefined,'old').requestId,'old');
  assert.equal(latestGuessReceipt(view,[],undefined,'other-device'),null);
  assert.equal(latestGuessReceipt({actionReceipts:[{requestId:'new',status:'committed',turnId:'old-turn',guessResult:{correct:true,points:175}}]},[],'current'),null);
});

test('HTTP/SSE same sequence applies one whole stroke, later chunks retain whole-stroke undo identity',()=>{
  let current=snapshot();current=applyDrawingPacket(current,append(),scope).snapshot;
  assert.equal(current.strokes.length,1);assert.equal(current.strokes[0].points.length,1);
  assert.equal(applyDrawingPacket(current,append(),scope).reason,'duplicate');
  current=applyDrawingPacket(current,append(2,{operations:[stroke('stroke-1',[[.2,.3]])],pointCount:2}),scope).snapshot;
  assert.equal(current.strokes.length,1);assert.equal(current.strokes[0].points.length,2);
  const styled=append(3,{operations:[{...stroke(),color:'#ff0000'}]});assert.equal(applyDrawingPacket(current,styled,scope).needsRead,true);
});

test('seq gap, old clear/writer epochs and restart require authoritative restore without accepting stale ink',()=>{
  const current=snapshot({sequence:8,clearGeneration:2,leaseGeneration:4,strokes:[stroke()],pointCount:1});
  assert.equal(applyDrawingPacket(current,append(10,{clearGeneration:2,leaseGeneration:4}),scope).needsRead,true);
  assert.equal(applyDrawingPacket(current,append(9,{clearGeneration:1,leaseGeneration:4}),scope).reason,'old');
  assert.equal(applyDrawingPacket(current,append(9,{clearGeneration:2,leaseGeneration:3}),scope).reason,'old');
  assert.equal(applyDrawingPacket(current,{...snapshot(),bootId:'boot-b'},scope).needsRead,true);
  const restored=applyDrawingPacket(current,{...snapshot(),bootId:'boot-b'},scope,{authoritative:true});assert.equal(restored.accepted,true);assert.equal(restored.restarted,true);
  assert.equal(applyDrawingPacket(current,append(9,{turnId:'old-turn'}),scope).reason,'scope');
  assert.equal(applyDrawingPacket(current,{...scope,kind:'recovery'},scope).needsRead,true);
});

test('private append snapshots isolate incoming coordinates and the pure reconciler retains deep copies',async()=>{
  const original=snapshot({strokes:[stroke('kept',[[.4,.5],[.5,.6]])],pointCount:2});
  const pure=applyDrawingPacket(original,append(1,{operations:[stroke('new',[[.7,.8],[.8,.9]])],pointCount:4}),scope).snapshot;
  pure.strokes[0].points[0][0]=.9;assert.equal(original.strokes[0].points[0][0],.4);
  const initial=snapshot({strokes:[stroke('continued'),stroke('kept',[[.4,.5],[.5,.6]])],pointCount:3});
  const h=drawingHarness(async()=>initial);
  try {
    h.view.setContext({...scope,drawer:false,stage:'drawing',phase:'playing',enabled:true});await h.view.refresh();
    initial.strokes[0].points[0][0]=.9;initial.strokes[1].points.push([.9,.9]);
    const packet=append(1,{operations:[stroke('continued',[[.2,.3]]),stroke('new',[[.7,.8],[.8,.9]])],pointCount:6});
    assert.equal(h.view.receive(packet),true);
    packet.operations[0].points[0][0]=.9;packet.operations[1].points[1][1]=.1;
    packet.operations[1].points.push([.9,.9]);h.paths.length=0;
    assert.equal(h.view.receive(append(2,{operations:[stroke('kept',[[.6,.7]])],pointCount:7})),true);
    assert.deepEqual(h.paths,[['move',.1*1024,.2*768],['line',.2*1024,.3*768],
      ['move',.4*1024,.5*768],['line',.5*1024,.6*768],['line',.6*1024,.7*768],
      ['move',.7*1024,.8*768],['line',.8*1024,.9*768]]);
    assert.equal(h.view.state().pointCount,7);
  }finally{h.view.destroy();}
});

test('a later invalid append part leaves the private confirmed snapshot unchanged before recovery',async()=>{
  const initial=snapshot({strokes:[stroke('first',[[.1,.2],[.2,.3]]),stroke('second',[[.4,.5],[.5,.6]])],pointCount:4});
  let reads=0,release;
  const h=drawingHarness(async()=>++reads===1?initial:new Promise(resolve=>{release=resolve;}));
  try {
    h.view.setContext({...scope,drawer:false,stage:'drawing',phase:'playing',enabled:true});await h.view.refresh();h.paths.length=0;
    const packet=append(1,{operations:[stroke('first',[[.3,.4]]),{...stroke('second',[[.6,.7]]),color:'#ff0000'}],pointCount:6});
    assert.equal(h.view.receive(packet),false);assert.equal(reads,2);
    assert.deepEqual(h.paths,[['move',.1*1024,.2*768],['line',.2*1024,.3*768],
      ['move',.4*1024,.5*768],['line',.5*1024,.6*768]]);
    assert.equal(h.view.state().pointCount,4);h.paths.length=0;
    assert.equal(h.view.receive(append(1,{operations:[stroke('first',[[.3,.4]])],pointCount:5})),true);
    assert.deepEqual(h.paths,[['move',.1*1024,.2*768],['line',.2*1024,.3*768],['line',.3*1024,.4*768],
      ['move',.4*1024,.5*768],['line',.5*1024,.6*768]]);
    assert.equal(h.view.state().pointCount,5);
  }finally{h.view.destroy();release?.(initial);await settle();}
});

test('normalized points preserve logical coordinates across orientation and reject releases outside paper',()=>{
  assert.deepEqual(normalizedDrawingPoint({clientX:210,clientY:170},{left:10,top:20,width:400,height:300}),[.5,.5]);
  assert.deepEqual(normalizedDrawingPoint({clientX:410,clientY:320},{left:10,top:20,width:800,height:600}),[.5,.5]);
  assert.equal(normalizedDrawingPoint({clientX:0,clientY:0},{left:10,top:20,width:400,height:300}),null);
  assert.ok(drawingPacketProblem(snapshot({strokes:[stroke('bad',[[2,.5]])]})));
});

test('saved canvas geometry accepts only new wide paper or unchanged legacy paper',()=>{
  assert.deepEqual(drawingGeometry(snapshot()),{width:1024,height:768});
  assert.deepEqual(drawingGeometry(snapshot({geometry:{width:1024,height:576}})),{width:1024,height:576});
  for(const geometry of [null,{width:1024,height:512},{width:768,height:1024},{width:1024,height:576,other:true}])
    assert.match(drawingPacketProblem(snapshot({geometry})),/尺寸无效/);
  const wide=snapshot({geometry:{width:1024,height:576}});
  assert.equal(applyDrawingPacket(wide,append(1,{geometry:{width:1024,height:768}}),scope).reason,'geometry');
  assert.deepEqual(applyDrawingPacket(wide,append(),scope).snapshot.geometry,wide.geometry);
});

test('actual canvas controller uses wide landscape area and keeps ink proportions across rotation',async()=>{
  const ink=stroke('box',[[.25,.25],[.75,.75]]),box={width:606,height:259};
  const legacy=drawingHarness(async()=>snapshot({strokes:[ink],pointCount:2}),()=>1000,{...box});
  const wide=drawingHarness(async()=>snapshot({geometry:{width:1024,height:576},strokes:[ink],pointCount:2}),()=>1000,{...box});
  for(const h of [legacy,wide]){h.view.setContext({...scope,drawer:false,stage:'drawing',phase:'playing',enabled:true});await h.view.refresh();}
  const size=h=>({width:parseFloat(h.canvas.parentElement.style.width),height:parseFloat(h.canvas.parentElement.style.height)});
  assert.ok(Math.abs(size(legacy).width-259*4/3)<.001);assert.equal(size(legacy).height,259);
  assert.ok(Math.abs(size(wide).width-259*16/9)<.001);assert.equal(size(wide).height,259);
  assert.ok(size(wide).width*size(wide).height/(size(legacy).width*size(legacy).height)>1.32);
  assert.deepEqual(wide.paths.at(-2),['move',256,144]);assert.deepEqual(wide.paths.at(-1),['line',768,432]);
  assert.deepEqual(legacy.paths.at(-2),['move',256,192]);assert.deepEqual(legacy.paths.at(-1),['line',768,576]);
  assert.match(wide.attributes['aria-label'],/1024乘576/);assert.match(legacy.attributes['aria-label'],/1024乘768/);
  Object.assign(wide.box,{width:370,height:480});wide.view.fit();
  assert.deepEqual(size(wide),{width:370,height:370*9/16});
  assert.equal(wide.canvas.width,1024);assert.equal(wide.canvas.height,576);
  for(const h of [legacy,wide])h.view.destroy();
});

test('new practice persists wide geometry while existing no-geometry artwork keeps legacy shape through editing',async()=>{
  const storage=memory(),session=createDrawingPracticeSession({storage,now:()=>1000});
  const initial=await session.request('read');assert.deepEqual(initial.geometry,{width:1024,height:576});
  await session.request('acquire',{deviceId:'new',canvasId:initial.canvasId,bootId:initial.bootId});
  const saved=JSON.parse(storage.getItem(session.storageKey));assert.deepEqual(saved.canvas.geometry,initial.geometry);
  delete saved.canvas.geometry;saved.canvas.strokes=[stroke('legacy',[[.25,.25],[.75,.75]])];saved.canvas.pointCount=2;
  storage.setItem(session.storageKey,JSON.stringify(saved));session.destroy();
  const restored=createDrawingPracticeSession({storage,now:()=>1000}),before=await restored.request('read');
  assert.deepEqual(drawingGeometry(before),{width:1024,height:768});assert.equal(Object.hasOwn(before,'geometry'),false);
  const lease=await restored.request('acquire',{deviceId:'old',canvasId:before.canvasId,bootId:before.bootId});
  await restored.request('append',{deviceId:'old',canvasId:before.canvasId,bootId:before.bootId,leaseGeneration:lease.leaseGeneration,
    expectedSequence:before.sequence,clearGeneration:before.clearGeneration,requestId:'edit-old',operations:[stroke('added')]});
  const after=await restored.request('read');assert.equal(Object.hasOwn(after,'geometry'),false);assert.deepEqual(after.strokes[0].points,before.strokes[0].points);
  const h=drawingHarness(type=>restored.request(type));h.view.setContext({...before,drawer:true,phase:'playing',enabled:true});await h.view.refresh();
  assert.equal(h.canvas.height,768);assert.match(h.attributes['aria-label'],/1024乘768/);h.view.destroy();restored.destroy();
});

test('local practice saves and recovers committed strokes, whole-stroke undo/redo/clear and isolates formal rooms',async()=>{
  const storage=memory(),session=createDrawingPracticeSession({storage,now:()=>1000}),deviceId='local-device';
  const initial=await session.request('read');let lease=await session.request('acquire',{deviceId,canvasId:initial.canvasId,bootId:initial.bootId});
  const write=async(type,operations)=>{const saved=await session.request('read');const result=await session.request(type,{deviceId,leaseGeneration:lease.leaseGeneration,
    canvasId:saved.canvasId,bootId:saved.bootId,expectedSequence:saved.sequence,clearGeneration:saved.clearGeneration,requestId:'test',...(operations?{operations}:{})});return result;};
  await write('append',[stroke()]);await write('append',[stroke('stroke-1',[[.2,.3]])]);
  assert.equal((await session.request('read')).strokes[0].points.length,2);
  await write('undo');assert.equal((await session.request('read')).strokes.length,0);
  await write('redo');assert.equal((await session.request('read')).strokes[0].points.length,2);
  const restored=createDrawingPracticeSession({storage,now:()=>1000});assert.equal((await restored.request('read')).strokes.length,1);
  assert.equal(restored.view().game.canDraw,true);assert.equal(Object.hasOwn(restored.view(),'token'),false);
  await write('clear');assert.equal((await session.request('read')).clearGeneration,1);assert.equal((await session.request('read')).strokes.length,0);
  const damaged=JSON.parse(storage.getItem(session.storageKey));damaged.undone=[stroke('x',[[2,2]])];assert.ok(practiceCanvasProblem(damaged));
  session.destroy();restored.destroy();
});

test('two local tabs cannot overwrite each other; storage failure remains explicit memory-only',async()=>{
  const storage=memory(),one=createDrawingPracticeSession({storage}),two=createDrawingPracticeSession({storage});
  const initial=await one.request('read'),ids={canvasId:initial.canvasId,bootId:initial.bootId};
  await one.request('acquire',{deviceId:'one',...ids});await assert.rejects(()=>two.request('acquire',{deviceId:'two',...ids}),/另一标签页/);
  await two.request('read');await two.request('acquire',{deviceId:'two',...ids});assert.equal((await one.request('read')).leaseGeneration,2);
  const memoryOnly=createDrawingPracticeSession({storage:null});assert.equal(memoryOnly.storageAvailable(),false);
  await memoryOnly.request('acquire',{deviceId:'offline',...ids});assert.equal(memoryOnly.view().storageAvailable,false);
  one.destroy();two.destroy();memoryOnly.destroy();
});

test('canvas controller keeps confirmed ink on unknown response, stops writer and never auto-replays',async()=>{
  let server=snapshot(),writes=0;
  const request=async(type,body)=>{if(type==='read')return structuredClone(server);
    assert.equal(body.canvasId,server.canvasId);assert.equal(body.bootId,server.bootId);
    if(type==='acquire')return {bootId:server.bootId,canvasId:server.canvasId,leaseGeneration:1,leaseValidUntil:16000,persisted:true};
    if(type==='append'){writes++;server=applyDrawingPacket(server,append(server.sequence+1,{operations:body.operations}),scope).snapshot;throw new Error('响应丢失');}};
  const h=drawingHarness(request);h.view.setContext({...scope,drawer:true,stage:'drawing',phase:'playing',enabled:true});await h.view.refresh();await h.view.acquire();
  assert.equal(h.view.state().ready,true);h.fire('pointerdown');h.fire('pointermove',{clientX:80,clientY:100});h.fire('pointerup');h.tick();await settle();
  assert.equal(writes,1);assert.equal(h.view.state().ready,false);assert.equal(h.view.state().hasInk,true);h.tick();await settle();assert.equal(writes,1);
  h.view.setContext({...scope,drawer:true,stage:'drawing',phase:'playing',enabled:false});assert.equal(h.view.state().hasInk,true);
  h.view.destroy();
});

test('canvas controller lease expiry and pointer cancellation discard unconfirmed ink without writing',async()=>{
  let time=1000,writes=0;const request=async(type)=>type==='read'?snapshot():type==='acquire'?{bootId:'boot-a',canvasId:'canvas',leaseGeneration:1,leaseValidUntil:1500,persisted:true}:(writes++,{});
  const h=drawingHarness(request,()=>time);h.view.setContext({...scope,drawer:true,stage:'drawing',phase:'playing',enabled:true});await h.view.refresh();await h.view.acquire();
  h.fire('pointerdown');h.fire('pointercancel');assert.equal(h.view.state().pending,0);assert.equal(writes,0);
  h.fire('pointerdown');time=1500;h.tick();assert.equal(h.view.state().ready,false);assert.equal(h.view.state().pending,0);assert.equal(writes,0);h.view.destroy();
});
