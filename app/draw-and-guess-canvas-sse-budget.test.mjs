import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readSettings } from '../server/config.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { SessionService } from '../server/session-service.mjs';
import { IdentityFailure } from '../server/auth.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';

const SHARED_BYTES=2*1024*1024,CLIENTS=16;
const roomId='a'.repeat(32),matchId='b'.repeat(32),canvasId='c'.repeat(64),turnId='dg-turn-1';
const deferred=()=>{let resolve;const promise=new Promise(value=>{resolve=value;});return {promise,resolve};};
async function until(predicate,message) {
  const end=Date.now()+2000;
  while(!predicate()) {if(Date.now()>=end)assert.fail(message);await delay(5);}
}

// This synthetic, bounded publisher isolates the real BFF queue. Canvas
// durability is covered by the separate domain tests; this test never claims
// that emitting a packet represents a persisted canvas mutation.
async function fixture(t) {
  const folder=mkdtempSync(join(tmpdir(),'canvas-sse-budget-')),now=()=>Date.now(),settings=readSettings({GAME_ROOM_AUTH_MODE:'mock'});
  const storage=new EncryptedStore(new SQLiteAdapter(join(folder,'records.sqlite'),{now}),randomBytes(32),now),clients=[],subscriptions=new Map();
  const bootId=randomUUID();let checkCount=0,hold=null;
  const provider={async check(identity) {
    checkCount++;const gate=hold;
    if(gate) {gate.entered++;gate.active++;const status=await gate.release.promise;gate.active--;if(status!==200)throw new IdentityFailure(status);}
    return {sub:identity.sub};
  }};
  const sessions=new SessionService(settings,{store:storage,provider,now,authorizationTimeoutMs:5000});
  const viewFor=userKey=>({roomCode:'123456',roomId,selfId:userKey.slice(0,32),selfRole:members.findIndex(member=>member.userKey===userKey)<8?'player':'spectator',
    revision:1,phase:'playing',gameType:'draw-and-guess',matchId,game:{turnId}});
  const rooms={async getView(code,userKey) {assert.equal(code,'123456');return viewFor(userKey);},
    async subscribe(code,userKey,send) {send(viewFor(userKey));return ()=>{};},async getGameContext(){throw new Error('Unused HTTP domain context');},async sweep(){},async close(){}};
  const canvases={bootId,async read(){throw new Error('Unused HTTP canvas read');},invalidateAuthorization(){},invalidateActor(){},async sweep(){},async close(){subscriptions.clear();},
    async watch(code,userKey,send) {assert.equal(code,'123456');subscriptions.set(userKey,send);send(packet(0,false));return ()=>subscriptions.delete(userKey);}};
  function packet(sequence,large=true) {
    return {kind:'replace',bootId,canvasId,roomId,matchId,turnId,stage:'drawing',deadline:now()+600000,paused:false,
      sequence,clearGeneration:0,leaseGeneration:1,pointCount:large?1500:0,
      strokes:large?[{strokeId:'bounded-stroke',tool:'pen',color:'#245c7c',width:4,points:Array.from({length:1500},()=>[0.1234567890123456,0.9876543210987654])}]:[]};
  }
  const server=createUnifiedServer({settings,storage,sessions,rooms,canvases,drawingEnabled:true,watchdogMs:60000,heartbeatMs:60000});
  t.after(async()=>{
    if(hold){hold.release.resolve(200);hold=null;}
    for(const client of clients)client.controller.abort();
    await Promise.allSettled(clients.map(client=>client.pump));
    await server.shutdown();rmSync(folder,{recursive:true,force:true});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;settings.origin=base;settings.callback=base+'/auth/callback';settings.postLogout=base+'/';
  const members=[];
  for(let index=0;index<CLIENTS;index++) {
    const id=opaqueId(),sub=`fictional-sse-budget-${index}`,issuer='urn:synthetic-canvas-sse-budget',userKey=identityKey(issuer,sub);
    await storage.put('sessions',id,{phase:'active',issuer,sub,userKey,csrf:opaqueId(),accessToken:`synthetic-token-${index}`,expiresAt:now()+3600000,idleUntil:now()+3600000});
    members.push({id,userKey,cookie:`${settings.cookieName}=${id}`});
  }
  async function openAll() {
    const group=[];
    for(const member of members) {
      const controller=new AbortController(),response=await fetch(base+'/api/rooms/123456/events',{headers:{Cookie:member.cookie},signal:controller.signal});
      assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/event-stream/);
      const reader=response.body.getReader(),client={controller,reader,events:[],done:false,error:null};clients.push(client);group.push(client);
      client.pump=(async()=>{
        let pending='';const decoder=new TextDecoder();
        try {while(true) {
          const item=await reader.read();if(item.done)break;pending+=decoder.decode(item.value,{stream:true});
          for(let end;(end=pending.indexOf('\n\n'))!==-1;) {
            const frame=pending.slice(0,end);pending=pending.slice(end+2);const type=/^event: ([^\n]+)/m.exec(frame)?.[1],data=/^data: (.*)$/m.exec(frame)?.[1];
            if(type&&data)client.events.push({type,data:JSON.parse(data)});
          }
        }} catch(error) {if(error.name!=='AbortError')client.error=error;}
        finally {client.done=true;}
      })();
    }
    await until(()=>group.every(client=>client.events.some(event=>event.type==='canvas'&&event.data.sequence===0)),'initial fresh canvas snapshot was not delivered');
    await until(()=>subscriptions.size===CLIENTS,'canvas watches were not installed');
    return group;
  }
  function startHold() {assert.equal(hold,null);hold={entered:0,active:0,release:deferred()};return hold;}
  function releaseHold(status=200) {const old=hold;hold=null;old.release.resolve(status);return old;}
  function publish(sequence,extra={}) {const value={...packet(sequence),...extra},size=Buffer.byteLength(JSON.stringify(value));
    assert.ok(size<65536,'publisher must remain within the real domain 64KiB event bound');for(const send of [...subscriptions.values()])send(value);return size;}
  async function abortAll(group) {for(const client of group)client.controller.abort();await Promise.allSettled(group.map(client=>client.pump));await until(()=>subscriptions.size===0,'closed watches did not unsubscribe');}
  return {bootId,openAll,startHold,releaseHold,publish,abortAll,storage,members,get checkCount(){return checkCount;}};
}

test('BFF fences an old boot canvas after a held identity check without closing the current SSE connections',async t=>{
  const f=await fixture(t),group=await f.openAll(),held=f.startHold(),oldBootId=randomUUID();
  assert.notEqual(oldBootId,f.bootId);f.publish(1,{bootId:oldBootId});
  await until(()=>held.entered===CLIENTS,'old boot packets must still pass through each fresh delivery check');
  assert.equal(group.some(client=>client.events.some(event=>event.type==='canvas'&&event.data.sequence===1)),false);
  const gate=f.releaseHold();await until(()=>gate.active===0,'held old boot checks did not finish');
  // Ordered delivery of a subsequent current-boot packet proves that every old
  // packet has reached its final fence; no delay is used as proof of absence.
  f.publish(2);
  await until(()=>group.every(client=>client.events.some(event=>event.type==='canvas'&&event.data.sequence===2)),
    'current boot packets must remain deliverable after an old boot is suppressed');
  for(const client of group) {
    assert.equal(client.events.some(event=>event.type==='canvas'&&event.data.bootId===oldBootId),false);
    assert.equal(client.events.find(event=>event.type==='canvas'&&event.data.sequence===2).data.bootId,f.bootId);
    assert.equal(client.done,false);assert.equal(client.events.some(event=>event.type==='closed'),false);
  }
  await f.abortAll(group);
});

test('BFF global 2MiB canvas queue spans 16 real SSE connections, fails closed at its exact byte boundary and releases in finally',async t=>{
  const f=await fixture(t),first=await f.openAll(),checks=f.checkCount,held=f.startHold(),size=f.publish(1);
  await until(()=>held.entered===CLIENTS,'all 16 fresh delivery checks must remain held');
  assert.equal(first.some(client=>client.events.some(event=>event.type==='canvas'&&event.data.sequence===1)),false);
  assert.equal(f.checkCount-checks,CLIENTS,'a held private delivery still runs its own fresh check');
  assert.ok(size*CLIENTS*2<SHARED_BYTES);assert.ok(size*CLIENTS*3>SHARED_BYTES);
  f.publish(2);f.publish(3);
  const retained=Math.floor(SHARED_BYTES/size),survivors=retained-2*CLIENTS,closed=CLIENTS-survivors;
  assert.ok(survivors>=0&&survivors<CLIENTS);
  await until(()=>first.filter(client=>client.done).length===closed,'shared bytes, rather than the per-connection four-event bound, must end the overflowing streams');
  assert.equal(first.some(client=>client.events.some(event=>event.type==='closed')),false,'transport backpressure uses EOF and grants no identity error or packet');
  const gate=f.releaseHold();await until(()=>gate.active===0,'held checks did not finish');
  await until(()=>first.filter(client=>!client.done).every(client=>client.events.some(event=>event.type==='canvas'&&event.data.sequence===3)),'retained streams did not drain confirmed events');
  await f.abortAll(first);
  // Admission after both success and inactive-stream finalizers proves that
  // accounting is released. Leaking the old 2MiB makes this next wave fail.
  const second=await f.openAll(),heldAgain=f.startHold();f.publish(4);
  await until(()=>heldAgain.entered===CLIENTS,'released global budget must admit the next 16 held deliveries');f.publish(5);
  await delay(25);assert.equal(second.some(client=>client.done),false,'two full new waves must fit after finally returns all previous bytes');
  const again=f.releaseHold();await until(()=>again.active===0,'second held checks did not finish');
  await until(()=>second.every(client=>client.events.some(event=>event.type==='canvas'&&event.data.sequence===5)),'second waves did not drain');await f.abortAll(second);
  t.diagnostic(JSON.stringify({connections:CLIENTS,payloadBytes:size,globalLimitBytes:SHARED_BYTES,retainedPackets:retained,overflowEOF:closed,nextWavePackets:2*CLIENTS}));
});

for(const status of [401,503])test(`BFF ${status} after a held fresh check releases the global canvas budget and emits no retained private packets`,async t=>{
  const f=await fixture(t),group=await f.openAll(),held=f.startHold(),size=f.publish(1);
  await until(()=>held.entered===CLIENTS,'fresh checks were not held');f.publish(2);const gate=f.releaseHold(status);
  await until(()=>group.every(client=>client.done),'authorization failure must stop every private stream');await until(()=>gate.active===0,'failed fresh checks did not finish');
  for(const client of group) {
    assert.equal(client.events.some(event=>event.type==='canvas'&&event.data.sequence>0),false);
    assert.equal(client.events.filter(event=>event.type==='closed').length,1);assert.equal(client.events.find(event=>event.type==='closed').data.status,status);
  }
  await f.abortAll(group);
  for(const member of f.members) {
    const record=await f.storage.read('sessions',member.id);
    if(status===401) {assert.equal(record,null);member.id=opaqueId();member.cookie=member.cookie.split('=')[0]+'='+member.id;
      await f.storage.put('sessions',member.id,{phase:'active',issuer:'urn:synthetic-canvas-sse-budget',sub:`fictional-sse-budget-${f.members.indexOf(member)}`,userKey:member.userKey,
      csrf:opaqueId(),accessToken:'synthetic-recovered-token',expiresAt:Date.now()+3600000,idleUntil:Date.now()+3600000});}
    else assert.ok(record,'503 must preserve the original server session');
  }
  const recovered=await f.openAll(),heldAgain=f.startHold();f.publish(3);await until(()=>heldAgain.entered===CLIENTS,'failure-finally must return global bytes before recovery');f.publish(4);
  await delay(25);assert.equal(recovered.some(client=>client.done),false);f.releaseHold();
  await until(()=>recovered.every(client=>client.events.some(event=>event.type==='canvas'&&event.data.sequence===4)),'fresh recovery must deliver only the new wave');await f.abortAll(recovered);
  t.diagnostic(JSON.stringify({status,connections:CLIENTS,payloadBytes:size,suppressedPackets:2*CLIENTS,recoveredPackets:2*CLIENTS}));
});
