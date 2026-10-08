import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EncryptedStore, MemoryAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { SessionService } from '../server/session-service.mjs';
import { IdentityFailure } from '../server/auth.mjs';
import { RoomError } from './rooms.mjs';
import { readSettings } from '../server/config.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';

const roomId='a'.repeat(32),matchId='b'.repeat(32),canvasId='c'.repeat(64),turnId='dg-turn-1';
const deferred=()=>{let resolve;const promise=new Promise(value=>{resolve=value;});return {promise,resolve};};
async function until(predicate,message) {const end=Date.now()+2000;while(!predicate()){if(Date.now()>=end)assert.fail(message);await delay(5);}}

// Real legacy sessions, encrypted storage and atomic output guards; only the
// public publisher and identity response are controlled, without external I/O.
async function fixture(t,{watchdogMs=60000,sessionMs=3600000}={}) {
  let time=Date.now(),checks=0,holdIdentity=null,holdRoom=null,sendCanvas,sendView,sendChat,member=true,liveMatch=matchId,liveTurn=turnId;
  const now=()=>time,settings=readSettings({GAME_ROOM_AUTH_MODE:'mock'});
  const storage=new EncryptedStore(new MemoryAdapter({now}),randomBytes(32),now);
  const id=opaqueId(),issuer='urn:synthetic-public-canvas',sub='fictional-member',userKey=identityKey(issuer,sub);
  const provider={async check(identity){checks++;if(holdIdentity){const held=holdIdentity;held.entered++;const status=await held.promise;if(status!==200)throw new IdentityFailure(status);}return {sub:identity.sub};}};
  const sessions=new SessionService(settings,{store:storage,provider,now});
  await storage.put('sessions',id,{phase:'active',issuer,sub,userKey,csrf:opaqueId(),accessToken:'synthetic-server-token',expiresAt:time+sessionMs,idleUntil:time+sessionMs});
  await storage.put('rooms',roomId,{member:true},time+3600000);
  await storage.put('room-presence',roomId,{active:true},time+3600000);
  await storage.put('room-invitations','123456',{roomId},time+3600000);
  const view=revision=>({roomId,roomCode:'123456',selfId:'d'.repeat(32),selfRole:'player',revision,gameType:'draw-and-guess',matchId:liveMatch,phase:'playing',game:{turnId:liveTurn}});
  const rooms={async getView(){if(!member)throw new RoomError(403,'SEAT_REQUIRED','removed');return view(1);},
    async getGameContext(){if(holdRoom){const held=holdRoom;held.entered++;await held.promise;}if(!member)throw new RoomError(403,'SEAT_REQUIRED','removed');
      const [room,presence,invite]=await Promise.all([storage.read('rooms',roomId),storage.read('room-presence',roomId),storage.read('room-invitations','123456')]);
      return {roomId,gameType:'draw-and-guess',matchId:liveMatch,turnId:liveTurn,
        roomGuard:{scope:'rooms',id:roomId,expectedVersion:room.version},
        presenceGuard:{scope:'room-presence',id:roomId,expectedVersion:presence.version,validUntil:time+3600000},
        invitationGuard:{scope:'room-invitations',id:'123456',expectedVersion:invite.version}};},
    async subscribe(code,key,send){sendView=send;send(view(1));return ()=>{sendView=null;};},async sweep(){},async close(){}};
  const bootId=randomUUID();
  const packet=(sequence=0)=>({kind:sequence?'append':'snapshot',bootId,canvasId,roomId,matchId,turnId,sequence,clearGeneration:0,leaseGeneration:1,
    ...(sequence?{operations:[{strokeId:'stroke-a',tool:'pen',color:'#245c7c',width:4,points:[[.1,.2]]}],pointCount:sequence}
      :{stage:'drawing',deadline:time+600000,paused:false,geometry:{width:1024,height:576},strokes:[],pointCount:0})});
  const canvases={bootId,async read(){throw new Error('Unused canvas HTTP route');},invalidateActor(){},invalidateAuthorization(){},async watch(code,key,send){sendCanvas=send;send(packet());return ()=>{sendCanvas=null;};},async sweep(){},async close(){}};
  const chat={async subscribe(code,key,send){sendChat=send;return ()=>{sendChat=null;};},async preparePacket(code,key,value){return value;},async sweep(){},async close(){}};
  const server=createUnifiedServer({settings,storage,sessions,rooms,canvases,chat,drawingEnabled:true,watchdogMs,heartbeatMs:60000});
  let controller,pump;
  t.after(async()=>{holdIdentity?.resolve(200);holdRoom?.resolve();controller?.abort();await pump;server.closeAllConnections();await server.shutdown();});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;settings.origin=base;
  const events=[];let done=false;
  async function open(){controller=new AbortController();const response=await fetch(base+'/api/rooms/123456/events',{headers:{Cookie:`${settings.cookieName}=${id}`},signal:controller.signal});assert.equal(response.status,200);
    pump=(async()=>{const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';try{while(true){const part=await reader.read();if(part.done)break;pending+=decoder.decode(part.value,{stream:true});
      for(let end;(end=pending.indexOf('\n\n'))!==-1;){const frame=pending.slice(0,end);pending=pending.slice(end+2);const type=/^event: ([^\n]+)/m.exec(frame)?.[1],data=/^data: (.*)$/m.exec(frame)?.[1];if(type&&data)events.push({type,data:JSON.parse(data)});}}}catch(error){if(error.name!=='AbortError')throw error;}finally{done=true;}})();
    await until(()=>events.some(event=>event.type==='canvas'),'initial canvas did not arrive');}
  const publish=(sequence,extra={})=>sendCanvas({...packet(sequence),...extra});
  return {open,events,publish,storage,sessions,id,now,advance(ms){time+=ms;},get checks(){return checks;},get done(){return done;},
    holdIdentity(){holdIdentity={...deferred(),entered:0};return holdIdentity;},releaseIdentity(status=200){const held=holdIdentity;holdIdentity=null;held.resolve(status);},
    holdRoom(){holdRoom={...deferred(),entered:0};return holdRoom;},releaseRoom(){const held=holdRoom;holdRoom=null;held.resolve();},
    view(){sendView(view(2));},chat(){sendChat({roomId,messages:[]});},remove(){member=false;},turn(){liveTurn='dg-turn-2';},match(){liveMatch='e'.repeat(32);},
    async sessionChange(change){const record=await storage.read('sessions',id);await storage.replaceCAS('sessions',id,record.version,{...record.value,...change},time+3600000);}};
}
const saw=(f,sequence)=>f.events.some(event=>event.type==='canvas'&&event.data.sequence===sequence);
async function closed(f,status=503){await until(()=>f.done,'stream did not close');assert.equal(f.events.at(-1).type,'closed');assert.equal(f.events.at(-1).data.status,status);}

test('legacy public canvas shares only its fresh lease, accepts idle version changes and stays ordered',async t=>{
  const f=await fixture(t);await f.open();const checks=f.checks;
  await f.sessionChange({idleUntil:f.now()+4000000,lastIdentityCheck:f.now()+1});
  f.publish(1);f.publish(2);await until(()=>saw(f,2),'same-lineage version renewal blocked canvas');
  assert.equal(f.checks,checks);assert.deepEqual(f.events.filter(event=>event.type==='canvas').map(event=>event.data.sequence),[0,1,2]);
});

for(const event of ['view','chat'])test(`legacy ${event} still fresh and cannot borrow canvas authorization`,async t=>{
  const f=await fixture(t);await f.open();const checks=f.checks,hold=f.holdIdentity();f[event]();
  await until(()=>hold.entered===1,'private output did not start fresh identity');assert.equal(f.checks,checks+1);
  f.releaseIdentity(503);await closed(f);assert.equal(f.events.filter(item=>item.type===event).length,event==='view'?1:0);
});

for(const extra of [{answer:'private'}, {operations:[{strokeId:'stroke-a',tool:'pen',color:'#245c7c',width:4,points:[[.1,.2]],account:{sub:'private'}}]}, {kind:'unknown'}])
  test('unknown top-level, nested and kind payloads cannot use the public canvas lease',async t=>{
    const f=await fixture(t);await f.open();const hold=f.holdIdentity();f.publish(1,extra);
    await until(()=>hold.entered===1,'unknown payload bypassed fresh');f.releaseIdentity(503);await closed(f);assert.equal(saw(f,1),false);
  });

for(const change of [{accessToken:'different-token'},{csrf:'different-csrf'},{clientId:'different-client'},{authTime:1}])test('lease rejects changed token or login metadata without another online check',async t=>{
  const f=await fixture(t);await f.open();const checks=f.checks;await f.sessionChange(change);f.publish(1);await closed(f);assert.equal(saw(f,1),false);assert.equal(f.checks,checks);
});

for(const [sessionMs,advance] of [[3600000,25000],[10000,10000]])test('original lease or earlier session deadline forbids output at the exact boundary',async t=>{
  const f=await fixture(t,{sessionMs});await f.open();const checks=f.checks;f.advance(advance);f.publish(1);await closed(f);assert.equal(saw(f,1),false);assert.equal(f.checks,checks);
});

test('lease expiring while room preparation waits cannot output or gain a renewed budget',async t=>{
  const f=await fixture(t);await f.open();const held=f.holdRoom();f.publish(1);await until(()=>held.entered===1,'room read was not held');f.advance(25000);f.releaseRoom();await closed(f);assert.equal(saw(f,1),false);
});

for(const mutation of ['remove','turn','match'])test(`current ${mutation} authority prevents old canvas output`,async t=>{
  const f=await fixture(t);await f.open();f[mutation]();f.publish(1);
  if(mutation==='remove')await closed(f,404);else {f.publish(2,{turnId:'dg-turn-2',...(mutation==='match'?{matchId:'e'.repeat(32),turnId}: {})});await until(()=>saw(f,2),'current scope did not drain after obsolete packet');}
  assert.equal(saw(f,1),false);
});

for(const scope of ['room-presence','room-invitations'])test(`atomic ${scope} conflict is reprepared without online identity or stale output`,async t=>{
  const f=await fixture(t);await f.open();const checks=f.checks,original=f.storage.verifyGuards.bind(f.storage);let changed=false;
  f.storage.verifyGuards=async transaction=>{if(!changed){changed=true;const id=scope==='room-presence'?roomId:'123456',record=await f.storage.read(scope,id);await f.storage.replaceCAS(scope,id,record.version,{changed:true},f.now()+3600000);}return original(transaction);};
  f.publish(1);await until(()=>saw(f,1),'atomic conflict did not reprepare current guards');assert.equal(changed,true);assert.equal(f.checks,checks);
});

for(const status of [401,503])test(`watchdog ${status} closes immediately and retained canvas cannot survive`,async t=>{
  const f=await fixture(t,{watchdogMs:25});await f.open();const held=f.holdIdentity();await until(()=>held.entered===1,'watchdog did not start');f.releaseIdentity(status);await closed(f,status);assert.equal(saw(f,1),false);
});

test('late successful watchdog cannot renew its expired trigger or resurrect a closed stream',async t=>{
  const f=await fixture(t,{watchdogMs:25});await f.open();const held=f.holdIdentity();await until(()=>held.entered===1,'watchdog did not start');f.advance(25000);f.releaseIdentity();await closed(f);assert.equal(saw(f,1),false);
});
