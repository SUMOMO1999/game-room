import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readSettings } from '../server/config.mjs';
import { MockProvider } from '../server/auth.mjs';
import { createRuntime } from '../server/runtime.mjs';

test('six-seat merchant persists idle presence without public updates, then delivers real actions and absence immediately', async t => {
  let at=Date.now(); const now=()=>at;
  const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock',GAME_ROOM_HYAKKI_ENABLED:'1'});
  const runtime=createRuntime(settings,{provider:new MockProvider(settings,{now}),now,
    roomOptions:{pollIntervalMs:0,serverRandomInt:m=>m-1}});
  const users=Array.from({length:6},(_,i)=>createHash('sha256').update('idle-test-'+i).digest('hex'));
  const counts=Array(6).fill(0),stops=[];
  t.after(async()=>{for(const stop of stops)await stop();runtime.chat.close();await runtime.rooms.close();runtime.storage.close();});
  const first=await runtime.rooms.createRoom(users[0],'测试1',randomUUID(),'hyakki-trading'),code=first.roomCode;
  for(let i=1;i<6;i++)await runtime.rooms.joinRoom(code,users[i],'测试'+i,randomUUID());
  for(let i=0;i<6;i++)stops.push(await runtime.rooms.subscribe(code,users[i],()=>counts[i]++));
  async function act(i,type,extra={}) { const v=await runtime.rooms.getView(code,users[i]);
    return runtime.rooms.action(code,users[i],{type,requestId:randomUUID(),expectedRevision:v.revision,...extra}); }
  for(let i=0;i<6;i++)await act(i,'ready',{ready:true});
  await act(0,'start');
  const before=await runtime.rooms.getView(code,users[0]),savedBefore=await runtime.storage.read('rooms',before.roomId),initial=[...counts];
  for(let i=0;i<12;i++){at+=1000;await runtime.rooms.sweep();}
  const after=await runtime.rooms.getView(code,users[0]),savedAfter=await runtime.storage.read('rooms',before.roomId);
  assert.deepEqual(counts,initial,'idle keepalives must not generate private pushes');
  assert.equal(after.revision,before.revision);assert.equal(after.game.revision,before.game.revision);
  assert.deepEqual(after.turnClock,before.turnClock);
  assert.notEqual(savedAfter.version,savedBefore.version,'physical CAS still fences updated transport evidence');
  assert.ok(savedAfter.value.snapshot.game.lifecycle.checkpoints.every((p,i)=>p.lastSeenAt>savedBefore.value.snapshot.game.lifecycle.checkpoints[i].lastSeenAt));
  const owner=users.findIndex((_,i)=>before.players[i].id===before.game.turnPlayerId);
  const result=await runtime.rooms.action(code,users[owner],{type:'peek',requestId:randomUUID(),expectedRevision:before.revision,
    matchId:before.matchId,turnId:before.game.turnId});
  assert.equal(result.view.game.pending.kind,'peek');assert.equal(result.view.game.pending.privatePool.length,1);
  assert.deepEqual(counts,initial.map(n=>n+1),'every seat receives the real action');
  for(let i=0;i<6;i++)if(i!==owner)assert.equal((await runtime.rooms.getView(code,users[i])).game.pending.privatePool,undefined);
  const beforeDisconnect=await runtime.rooms.getView(code,users[owner]);await stops[5]();
  const held=await runtime.rooms.getView(code,users[owner]);
  assert.equal(held.phase,'paused');assert.ok(held.revision>beforeDisconnect.revision);assert.equal(held.turnClock.deadlineAt,null);
  stops.push(await runtime.rooms.subscribe(code,users[5],()=>counts[5]++));
  const resumed=await runtime.rooms.getView(code,users[owner]);
  assert.equal(resumed.phase,'playing');assert.equal(resumed.game.pending.kind,'peek');
  assert.equal(resumed.game.publicEventSequence,held.game.publicEventSequence+1);
});
