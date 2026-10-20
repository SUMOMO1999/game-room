import test from 'node:test';
import assert from 'node:assert/strict';
import {createDrawingPracticeSession,practiceCanvasProblem} from './games/draw-and-guess/practice-engine.mjs';

const stroke=(strokeId,points,tool='pen')=>({strokeId,points,tool,color:'#182a33',width:tool==='eraser'?32:4});
async function fixture(){
  const map=new Map(),storage={getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value)};
  const session=createDrawingPracticeSession({storage,now:()=>1000}),initial=await session.request('read');
  const lease=await session.request('acquire',{deviceId:'practice-test',canvasId:initial.canvasId,bootId:initial.bootId});
  const read=()=>session.request('read');
  const write=async(type,operations)=>{const saved=await read();return session.request(type,{deviceId:'practice-test',leaseGeneration:lease.leaseGeneration,
    canvasId:saved.canvasId,bootId:saved.bootId,expectedSequence:saved.sequence,clearGeneration:saved.clearGeneration,...(operations?{operations}:{})});};
  return {session,storage,read,write};
}

test('actual local practice retains a complex 4609-point physical stroke, next stroke, eraser, undo and reload',async()=>{
  const f=await fixture(),points=Array.from({length:4609},(_,i)=>[.1+(i%500)/625,i%2?.75:.25]);
  for(let i=0;i<points.length;i+=256)await f.write('append',[stroke('held-gesture',points.slice(i,i+256))]);
  const long=await f.read();assert.equal(long.strokes.length,1);assert.deepEqual(long.strokes[0].points,points);
  await f.write('append',[stroke('next-gesture',[[.1,.9],[.8,.9]])]);
  await f.write('append',[stroke('eraser',[[.5,.1],[.5,.95]],'eraser')]);
  assert.deepEqual((await f.read()).strokes.map(s=>s.tool),['pen','pen','eraser']);
  await f.write('undo');assert.deepEqual((await f.read()).strokes.map(s=>s.strokeId),['held-gesture','next-gesture']);
  await f.write('undo');assert.deepEqual((await f.read()).strokes[0].points,points);
  await f.write('undo');assert.equal((await f.read()).strokes.length,0);
  for(let i=0;i<3;i++)await f.write('redo');
  const restored=createDrawingPracticeSession({storage:f.storage,now:()=>1000});
  assert.deepEqual(await restored.request('read'),await f.read());
  assert.equal(practiceCanvasProblem(JSON.parse(f.storage.getItem(f.session.storageKey))),null);
  restored.destroy();f.session.destroy();
});

test('local practice still enforces total 50k capacity and same-stroke tool identity atomically',async()=>{
  const f=await fixture(),points=Array.from({length:50000},(_,i)=>[i%2?.2:.1,.5]);
  // Capacity is checked on the actual stored packet, including the first append.
  await f.write('append',[stroke('full',points)]);
  const full=await f.read();assert.equal(full.pointCount,50000);
  await assert.rejects(()=>f.write('append',[stroke('full',[[.4,.5]])]),/长度|上限/);
  await assert.rejects(()=>f.write('append',[stroke('different',[[.4,.5]])]),/上限/);
  assert.deepEqual(await f.read(),full,'rejected writes must not change pixels or sequence');
  await f.write('undo');await f.write('append',[stroke('fresh',[[.1,.1],[.2,.2]])]);
  const before=await f.read();
  await assert.rejects(()=>f.write('append',[stroke('fresh',[[.3,.3]],'eraser')]),/格式/);
  assert.deepEqual(await f.read(),before);
  await f.write('clear');await f.write('append',[stroke('after-clear',[[.2,.1],[.4,.3]])]);
  assert.equal((await f.read()).pointCount,2);f.session.destroy();
});
