import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewPublisher,encodeBoardPositions,decodeBoardPositions} from './rummikub-preview-client.mjs';
import {fitGroupsToViewport} from './table-layout.mjs';
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(send){let now=0,serial=0;const timers=new Map(),calls=[];
  const publisher=createPreviewPublisher({send:async body=>{calls.push(body);return send?.(body) || {minIntervalMs:2000};},now:()=>now,id:()=>`synthetic-source-${++serial}`,
    setTimer:(callback,delay)=>{const id=++serial;timers.set(id,{callback,at:now+delay});return id;},clearTimer:id=>timers.delete(id)});
  const update=(n,fence='turn-a',eligible=true,paused=false)=>publisher.update({fence,eligible,paused,payload:{matchId:'a'.repeat(32),gameRevision:1,boardIds:[[String(n)]]}});
  const tick=async ms=>{now+=ms;for(const [id,item]of [...timers])if(item.at<=now){timers.delete(id);item.callback();}await settle();};
  return {publisher,calls,update,tick,timers};
}
test('coalesces continuous changes and respects the acknowledged shared capacity delay',async()=>{
  const f=fixture();f.update(1);await f.tick(0);f.update(2);f.update(3);await f.tick(1999);assert.equal(f.calls.length,1);
  await f.tick(1);assert.deepEqual(f.calls[1].boardIds,[['3']]);assert.equal(f.calls[1].sequence,2);
  f.update(3);await f.tick(5000);assert.equal(f.calls.length,2);
});
test('unknown write is not replayed, but a distinct later player edit can publish',async()=>{
  let attempts=0;const f=fixture(()=>{if(!attempts++)throw new Error('unknown');return {minIntervalMs:1000};});
  f.update(1);await f.tick(0);f.update(1);await f.tick(10000);assert.equal(f.calls.length,1);
  f.update(2);await f.tick(0);assert.equal(f.calls.length,2);
});
test('losing and regaining eligibility publishes the unchanged draft as a new snapshot for a new watcher',async()=>{
  const f=fixture();f.update(1);await f.tick(0);assert.equal(f.calls.length,1);
  f.update(1,'turn-a',false);await f.tick(60000);assert.equal(f.calls.length,1);
  f.update(1);await f.tick(0);assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls[1].boardIds,f.calls[0].boardIds);
  assert.notEqual(f.calls[1].previewId,f.calls[0].previewId);assert.equal(f.calls[1].sequence,1);
  f.update(1);await f.tick(10000);assert.equal(f.calls.length,2);
});
test('business pause keeps an accepted source and resumes only the newest edit with its next sequence',async()=>{
  const f=fixture();f.update(1);await f.tick(0);
  f.update(1,'turn-a',true,true);f.update(2,'turn-a',true,true);f.update(3,'turn-a',true,true);
  await f.tick(10000);assert.equal(f.calls.length,1);
  f.update(3);await f.tick(0);assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].previewId,f.calls[0].previewId);assert.equal(f.calls[1].sequence,2);
  assert.deepEqual(f.calls[1].boardIds,[['3']]);f.update(3);await f.tick(10000);assert.equal(f.calls.length,2);
});
test('known throttle sends only newest payload; a new turn or identity erases queued old edits',async()=>{
  let count=0;const f=fixture(()=>{if(!count++)throw Object.assign(new Error('throttled'),{status:429,minIntervalMs:3000});return {minIntervalMs:1000};});
  f.update(1);await f.tick(0);f.update(2);f.update(3);await f.tick(3000);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].boardIds,[['3']]);
  f.update(4);f.update(9,'turn-b',false);await f.tick(10000);assert.equal(f.calls.length,2);
  f.update(10,'turn-b');await f.tick(0);assert.notEqual(f.calls[2].previewId,f.calls[1].previewId);
});
test('positions preserve logical group geometry across screens and reject malformed public arrays',()=>{
  const board=[[{id:'a'},{id:'b'}],[{id:'c'}]],points={'a|b':{x:90,y:25},c:{x:300,y:75}};
  assert.deepEqual(decodeBoardPositions(board,encodeBoardPositions(board,points)),points);
  assert.deepEqual(decodeBoardPositions(board,[{x:Infinity,y:0}]),{});
  assert.deepEqual(encodeBoardPositions(board,{}),[null,null]);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
test('an acknowledgement arriving during business pause retains its source but cannot send pending edits until unpause',async()=>{
  const sending=deferred(),f=fixture(body=>body.sequence===1?sending.promise:{minIntervalMs:1000});
  f.update(1);await f.tick(0);f.update(1,'turn-a',true,true);f.update(2,'turn-a',true,true);
  sending.resolve({minIntervalMs:1000});await settle();await f.tick(10000);assert.equal(f.calls.length,1);
  f.update(2);await f.tick(0);assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].previewId,f.calls[0].previewId);assert.equal(f.calls[1].sequence,2);
  assert.deepEqual(f.calls[1].boardIds,[['2']]);
});
test('eligibility loss fences a pending write so late failures cannot replay it or throttle the fresh unchanged snapshot',async()=>{
  const old=deferred(),f=fixture(body=>f.calls.length===1?old.promise:{minIntervalMs:1000});
  f.update(1);await f.tick(0);f.update(1,'turn-a',false);f.update(1);await f.tick(0);
  assert.equal(f.calls.length,2);assert.notEqual(f.calls[1].previewId,f.calls[0].previewId);
  old.reject(Object.assign(new Error('late rejection'),{status:429,minIntervalMs:60000}));await settle();
  f.update(2);await f.tick(1000);assert.equal(f.calls.length,3);assert.equal(f.calls[2].sequence,2);
  await f.tick(100000);assert.equal(f.calls.length,3);
});
test('a known retired-source sequence rejection after TTL renews once and publishes that edit without a second user edit',async()=>{
  let retired=false;const f=fixture(body=>{
    if(retired && body.sequence>1)throw Object.assign(new Error('retired'),{status:409,code:'PREVIEW_SEQUENCE'});
    return {minIntervalMs:1000};
  });
  f.update(1);await f.tick(0);retired=true;await f.tick(30000);
  f.update(2);await f.tick(0);assert.equal(f.calls.length,2);assert.equal(f.calls[1].sequence,2);
  await f.tick(999);assert.equal(f.calls.length,2);await f.tick(1);
  assert.equal(f.calls.length,3);assert.notEqual(f.calls[2].previewId,f.calls[0].previewId);
  assert.equal(f.calls[2].sequence,1);assert.deepEqual(f.calls[2].boardIds,[['2']]);
  f.update(2);await f.tick(10000);assert.equal(f.calls.length,3);
});
test('known sequence renewal coalesces pending edits and a second sequence rejection stops automatic retries',async()=>{
  const pending=deferred();let attempts=0;
  const f=fixture(()=>{if(!attempts++)return pending.promise;throw Object.assign(new Error('still retired'),{status:409,code:'PREVIEW_SEQUENCE'});});
  f.update(1);await f.tick(0);f.update(2);f.update(3);
  pending.reject(Object.assign(new Error('retired'),{status:409,code:'PREVIEW_SEQUENCE'}));await settle();
  await f.tick(1000);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].boardIds,[['3']]);
  await f.tick(100000);assert.equal(f.calls.length,2);
});
test('other-device, turn, fence, authorization and unknown preview failures are never automatically renewed',async()=>{
  for(const [status,code]of [[409,'PREVIEW_SOURCE_BUSY'],[409,'PREVIEW_NOT_TURN'],[409,'PREVIEW_STALE'],[409,'PREVIEW_DISCONNECTED'],[401,'SESSION_EXPIRED'],[503,'SERVICE_UNAVAILABLE'],[undefined,undefined]]) {
    const f=fixture(()=>{throw Object.assign(new Error('rejected or unknown'),{status,code});});
    f.update(1);await f.tick(0);await f.tick(100000);assert.equal(f.calls.length,1,code);
    f.update(1);await f.tick(0);assert.equal(f.calls.length,1,code);
  }
});
test('a clear for a retired source is not renewed or replayed',async()=>{
  const f=fixture(body=>{if(body.clear)throw Object.assign(new Error('retired'),{status:409,code:'PREVIEW_SEQUENCE'});return {minIntervalMs:1000};});
  f.update(1);await f.tick(0);
  f.publisher.update({fence:'turn-a',eligible:true,payload:{matchId:'a'.repeat(32),gameRevision:1,clear:true}});
  await f.tick(1000);assert.equal(f.calls.length,2);assert.equal(f.calls[1].clear,true);
  await f.tick(100000);assert.equal(f.calls.length,2);
});
test('an unresolved old-fence publication cannot block a new turn or alter the new throttle when it finishes late',async()=>{
  const old=deferred(),f=fixture(body=>body.boardIds[0][0]==='1'?old.promise:{minIntervalMs:1000});
  f.update(1);await f.tick(0);assert.equal(f.calls.length,1);
  f.update(2,'turn-b');await f.tick(0);assert.equal(f.calls.length,2);
  assert.notEqual(f.calls[0].previewId,f.calls[1].previewId);assert.equal(f.calls[1].sequence,1);
  old.resolve({minIntervalMs:9000,nextAllowedAt:100000});await settle();
  f.update(3,'turn-b');await f.tick(1000);assert.equal(f.calls.length,3);assert.equal(f.calls[2].sequence,2);
});
test('reset invalidates an in-flight old publication and its late failure cannot cancel or replay the new generation',async()=>{
  const old=deferred(),f=fixture(body=>body.boardIds[0][0]==='1'?old.promise:{minIntervalMs:1000});
  f.update(1);await f.tick(0);f.publisher.reset();f.update(2);await f.tick(0);
  assert.equal(f.calls.length,2);old.reject(new Error('late unknown'));await settle();
  f.update(2);await f.tick(10000);assert.equal(f.calls.length,2);
  f.update(3);await f.tick(0);assert.equal(f.calls.length,3);assert.equal(f.calls[2].sequence,2);
});
test('continuous changes during one flight coalesce, then a known throttle uses the newest edit instead of the rejected payload',async()=>{
  const sending=deferred(),f=fixture(body=>body.sequence===1?sending.promise:{minIntervalMs:1000});
  f.update(1);await f.tick(0);f.update(2);f.update(3);await f.tick(3000);assert.equal(f.calls.length,1);
  sending.reject(Object.assign(new Error('known rejected'),{status:429,minIntervalMs:1500}));await settle();
  await f.tick(1499);assert.equal(f.calls.length,1);await f.tick(1);
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].boardIds,[['3']]);
});
test('normalized group positions retain exact logical placement on rotation and produce bounded fits at very different viewports',()=>{
  const board=Array.from({length:18},(_,index)=>Array.from({length:3+index%6},(_,tile)=>({id:`group-${index}-${tile}`})));
  const groups=board.map(meld=>({id:meld.map(tile=>tile.id).sort().join('|'),length:meld.length}));
  const first=fitGroupsToViewport(groups,{width:940,height:390},{});
  const original=Object.fromEntries(first.positions.map(point=>[point.id,{x:point.logicalX,y:point.logicalY}]));
  const encoded=encodeBoardPositions(board,original),restored=decodeBoardPositions(board,encoded);
  for(const id of Object.keys(original)){assert.ok(Math.abs(original[id].x-restored[id].x)<1e-8);assert.ok(Math.abs(original[id].y-restored[id].y)<1e-8);}
  for(const viewport of [{width:390,height:844},{width:1100,height:400},{width:568,height:220}]) {
    const fit=fitGroupsToViewport(groups,viewport,restored);
    assert.equal(fit.positions.length,groups.length);assert.ok(fit.scale>0);
    for(const point of fit.positions) {assert.ok(point.x>=0&&point.y>=0);assert.ok(point.x+point.width<=viewport.width+.01);assert.ok(point.y+point.height<=viewport.height+.01);}
  }
});
