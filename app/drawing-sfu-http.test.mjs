import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { MockProvider, IdentityFailure } from '../server/auth.mjs';
import http from 'node:http';
import {createRoomVoiceService} from '../server/room-voice-service.mjs';
import { readSettings } from '../server/config.mjs';

async function until(predicate,message) {const end=Date.now()+2500;while(!predicate()){if(Date.now()>=end)assert.fail(message);await delay(5);}}
const stroke={strokeId:'shared-stroke',tool:'pen',color:'#245c7c',width:4,points:[[.1,.2],[.2,.3],[.3,.4]]};
const appendBody=(lease,expectedSequence=0,requestId=randomUUID())=>({deviceId:'device-a',canvasId:lease.canvasId,bootId:lease.bootId,leaseGeneration:lease.leaseGeneration,
  clearGeneration:lease.clearGeneration,expectedSequence,requestId,operations:[stroke]});

// All room/content/canvas/session/transport modules below are real. Only the
// identity provider responses are fictional: no Cognito/Agora request is sent.
async function fixture(t,kind,{voiceEnabled=false,batch=false,allGames=false}={}) {
  const folder=mkdtempSync(join(tmpdir(),'drawing-unified-http-'));let time=Date.now();const now=()=>time;
  const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock',...(allGames?{GAME_ROOM_POKER414_ENABLED:'1',GAME_ROOM_HYAKKI_ENABLED:'1',GAME_ROOM_PARKS_ENABLED:'1'}:{})}),storage=new EncryptedStore(kind==='SQLite'?new SQLiteAdapter(join(folder,'records.sqlite'),{now}):new MemoryAdapter({now}),randomBytes(32),now);
  const provider=new MockProvider(settings,{now}),statuses=new Map(),checks=[],streams=[];
  provider.usesBatchIdentity=batch;
  provider.complete=async()=>({issuer:'urn:synthetic-drawing-unified-http',sub:provider.member,accessToken:`server-only-synthetic-${provider.member}`,expiresAt:now()+3600000});
  provider.check=async identity=>{const status=statuses.get(identity.sub)??200;checks.push({sub:identity.sub,status});if(status!==200)throw new IdentityFailure(status);return {sub:identity.sub};};
  const runtime=createRuntime(settings,{storage,provider,now,drawingEnabled:true,roomOptions:{pollIntervalMs:0,serverRandomInt:()=>0},chatOptions:{pollIntervalMs:0}});
  await runtime.wordbankReady;await runtime.canvases.ready;
  const removed=[];const voice=voiceEnabled?createRoomVoiceService({apiKey:'test-key',secret:'synthetic-sfu-auth-test-secret-only',now,media:{remove:async m=>removed.push(m),close:async()=>{}}}):null;
  const media=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('{}');});if(voiceEnabled){media.listen(0,'127.0.0.1');await once(media,'listening');}
  const server=createUnifiedServer({...runtime,voiceHub:voice,...(voiceEnabled?{voiceOrigin:'http://127.0.0.1:'+media.address().port}:{}),watchdogMs:60000,heartbeatMs:60000});
  t.after(async()=>{
    for(const stream of streams)stream.controller.abort();await Promise.allSettled(streams.map(stream=>stream.pump));
    server.closeAllConnections();await server.shutdown();if(voiceEnabled){media.closeAllConnections();await new Promise(r=>media.close(r));}rmSync(folder,{recursive:true,force:true});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;settings.origin=base;settings.callback=base+'/auth/callback';settings.postLogout=base+'/';
  async function request(path,member={},body,extra={}) {
    const method=extra.method??(body===undefined?'GET':'POST');
    const response=await fetch(base+path,{method,redirect:'manual',headers:{...(member.cookie?{Cookie:member.cookie}:{}),
      ...(method!=='GET'?{Origin:base,'X-CSRF-Token':member.csrf??''}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...extra.headers},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const text=await response.text();return {status:response.status,body:text?(response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):{error:text}):null,headers:response.headers,text};
  }
  async function login(sub) {
    provider.member=sub;statuses.set(sub,200);
    const start=await request('/auth/login');assert.equal(start.status,303);
    const transaction=start.headers.getSetCookie()[0].split(';')[0],callback=new URL(start.headers.get('location'));
    const completed=await request(callback.pathname+callback.search,{cookie:transaction});assert.equal(completed.status,303);
    const cookie=completed.headers.getSetCookie().find(value=>value.startsWith(settings.cookieName+'=')).split(';')[0],state=await request('/api/state',{cookie});
    assert.equal(state.body.authenticated,true);return {sub,cookie,csrf:state.body.csrf,userKey:state.body.userKey,state:state.body};
  }
  async function openStream(code,member,{canvas=true}={}) {
    const controller=new AbortController(),response=await fetch(base+`/api/rooms/${code}/events`,{headers:{Cookie:member.cookie},signal:controller.signal});
    assert.equal(response.status,200);const stream={controller,events:[],done:false,error:null};streams.push(stream);
    stream.pump=(async()=>{const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
      try {while(true){const part=await reader.read();if(part.done)break;pending+=decoder.decode(part.value,{stream:true});
        for(let end;(end=pending.indexOf('\n\n'))!==-1;){const frame=pending.slice(0,end);pending=pending.slice(end+2);
          const type=/^event: ([^\n]+)/m.exec(frame)?.[1],data=/^data: (.*)$/m.exec(frame)?.[1];if(type&&data)stream.events.push({type,data:JSON.parse(data)});}}
      }catch(error){if(error.name!=='AbortError')stream.error=error;}finally{stream.done=true;}})();
    await until(()=>(!canvas||stream.events.some(event=>event.type==='canvas'))&&stream.events.some(event=>event.type==='view'),'mounted room SSE did not deliver its view and canvas snapshot');return stream;
  }
  async function waiting() {
    const host=await login('fictional-host'),peer=await login('fictional-peer'),viewer=await login('fictional-viewer');
    const created=await request('/api/rooms',host,{name:'画者',gameType:'draw-and-guess',requestId:randomUUID()});assert.equal(created.status,201,created.text);
    const code=created.body.roomCode;
    assert.equal((await request(`/api/rooms/${code}/join`,peer,{name:'猜者',requestId:randomUUID()})).status,201);
    assert.equal((await request(`/api/rooms/${code}/join`,viewer,{name:'观众',role:'spectator',requestId:randomUUID()})).status,201);
    async function action(member,type,fields={},requestId=randomUUID()) {
      const view=await request(`/api/rooms/${code}`,member);assert.equal(view.status,200,view.text);
      return request(`/api/rooms/${code}/actions`,member,{type,requestId,expectedRevision:view.body.view.revision,...fields});
    }
    assert.equal((await action(host,'ready',{ready:true})).status,200);assert.equal((await action(peer,'ready',{ready:true})).status,200);
    const started=await action(host,'start');assert.equal(started.status,200,started.text);assert.equal(started.body.view.game.stage,'choosing');
    const hostView=(await request(`/api/rooms/${code}`,host)).body.view,drawer=hostView.game.turnPlayerId===hostView.selfId?host:peer,guesser=drawer===host?peer:host;
    return {host,peer,viewer,drawer,guesser,code,action,path:`/api/rooms/${code}/canvas`};
  }
  async function choose(room) {
    const view=(await request(`/api/rooms/${room.code}`,room.drawer)).body.view,choice=view.game.candidates[0];
    const result=await room.action(room.drawer,'choose',{matchId:view.matchId,turnId:view.game.turnId,candidateId:choice.id});assert.equal(result.status,200,result.text);
    return {answer:choice.answer,matchId:view.matchId,turnId:view.game.turnId};
  }
  async function acquire(room,member=room.drawer) {
    const read=await request(room.path,member);assert.equal(read.status,200,read.text);
    return request(room.path+'/acquire',member,{deviceId:'device-a',canvasId:read.body.canvasId,bootId:read.body.bootId});
  }
  return {voice,removed,runtime,storage,provider,statuses,checks,request,login,openStream,waiting,choose,acquire,advance(ms){time+=ms;}};
}

for(const kind of ['Memory','SQLite'])test(`${kind}: real unified drawing HTTP mounts content, private guesses, canvas persistence, SSE and permission recovery`,async t=>{
  const f=await fixture(t,kind),room=await f.waiting(),streams={drawer:await f.openStream(room.code,room.drawer),guesser:await f.openStream(room.code,room.guesser),viewer:await f.openStream(room.code,room.viewer)};
  const choosing=(await f.request(`/api/rooms/${room.code}`,room.drawer)).body.view;
  assert.equal(choosing.game.candidates.length,3);assert.equal((await f.request(`/api/rooms/${room.code}`,room.guesser)).body.view.game.candidates,undefined);
  assert.equal((await f.request(`/api/rooms/${room.code}`,room.viewer)).body.view.game.candidates,undefined);
  const selected=await f.choose(room);await until(()=>Object.values(streams).every(stream=>stream.events.some(event=>event.type==='view'&&event.data.game?.stage==='drawing')),'choose did not reach all authorized SSE views');
  for(const stream of [streams.guesser,streams.viewer])assert.equal(JSON.stringify(stream.events).includes(selected.answer),false);
  const lease=await f.acquire(room);assert.equal(lease.status,200,lease.text);
  const append=await f.request(room.path+'/append',room.drawer,appendBody(lease.body));assert.equal(append.status,200,append.text);assert.equal(append.body.ack.persisted,true);
  await until(()=>Object.values(streams).every(stream=>stream.events.some(event=>event.type==='canvas'&&event.data.kind==='append'&&event.data.sequence===1)),'persisted append was not broadcast by the mounted SSE route');
  for(const member of [room.drawer,room.guesser,room.viewer]) {
    const read=await f.request(room.path,member);assert.equal(read.status,200);assert.equal(read.body.pointCount,3);assert.deepEqual(read.body.strokes[0],stroke);
    for(const hidden of ['accessToken','csrf','requests','actorSeatId',selected.answer,room.drawer.userKey])assert.equal(read.text.includes(hidden),false);
  }
  assert.equal((await f.acquire(room,room.viewer)).status,403);assert.equal((await f.acquire(room,room.guesser)).status,403);
  assert.equal((await f.request(room.path+'/append',room.viewer,appendBody(lease.body,1))).status,403);
  assert.equal((await f.request(room.path+'/append',room.drawer,appendBody(lease.body,1),{headers:{'X-CSRF-Token':'wrong'}})).status,403);
  const outsider=await f.login('fictional-outsider'),forbidden=await f.request(room.path,outsider);assert.equal(forbidden.status,403);assert.equal('strokes' in forbidden.body,false);
  const wrongText='只有本人输入的错误'+randomBytes(8).toString('hex'),wrongId='wrong-only-'+randomUUID();
  const wrong=await room.action(room.guesser,'guess',{matchId:selected.matchId,turnId:selected.turnId,text:wrongText},wrongId);
  assert.equal(wrong.status,200,wrong.text);assert.deepEqual(wrong.body.guessResult,{correct:false,points:0});
  assert.equal(wrong.text.includes(wrongText),false);
  await until(()=>streams.guesser.events.some(event=>event.type==='view'&&event.data.actionReceipts?.some(receipt=>receipt.requestId===wrongId)),'only the guesser should receive its private wrong-result receipt');
  for(const member of [room.drawer,room.viewer])assert.equal((await f.request(`/api/rooms/${room.code}`,member)).body.view.actionReceipts.some(receipt=>receipt.requestId===wrongId),false);
  for(const stream of [streams.drawer,streams.viewer])assert.equal(JSON.stringify(stream.events).includes(wrongId),false);
  for(const stream of Object.values(streams))assert.equal(JSON.stringify(stream.events).includes(wrongText),false);
  assert.equal(JSON.stringify((await f.storage.scan('rooms')).map(record=>record.value)).includes(wrongText),true,'attempts persist privately until reveal');
  const blockedChat=await f.request(`/api/rooms/${room.code}/chat`,room.viewer,{requestId:randomUUID(),text:`答案是${selected.answer}`});
  assert.equal(blockedChat.status,400);assert.equal(blockedChat.body.code,'ANSWER_IN_CHAT');assert.equal(JSON.stringify((await f.storage.scan('room-chat')).map(record=>record.value)).includes(selected.answer),false);
  assert.equal((await room.action(room.viewer,'guess',{matchId:selected.matchId,turnId:selected.turnId,text:wrongText})).status,403);

  f.statuses.set(room.drawer.sub,503);
  assert.equal((await f.request(room.path+'/append',room.drawer,appendBody(lease.body,1))).status,503);
  await until(()=>streams.drawer.done,'503 must close the actual drawer SSE');assert.equal(streams.drawer.events.at(-1).type,'closed');assert.equal(streams.drawer.events.at(-1).data.status,503);
  assert.equal((await f.request(room.path,room.drawer)).status,503);
  assert.equal((await f.request(room.path,room.viewer)).body.pointCount,3);
  f.statuses.set(room.drawer.sub,200);assert.equal((await f.request(room.path,room.drawer)).body.pointCount,3);
  assert.equal((await f.request(room.path+'/append',room.drawer,appendBody(lease.body,1))).body.code,'CANVAS_STALE_WRITER');
  const after503=await f.acquire(room);assert.equal(after503.status,200);assert.equal(after503.body.leaseGeneration,2);
  assert.equal((await f.request(room.path+'/append',room.drawer,appendBody(after503.body,1))).status,200);
  assert.equal((await f.request(room.path,room.viewer)).body.pointCount,6);
  const after503Stream=await f.openStream(room.code,room.drawer);
  assert.equal(after503Stream.events.find(event=>event.type==='canvas').data.pointCount,6);

  f.statuses.set(room.drawer.sub,401);assert.equal((await f.request(room.path+'/append',room.drawer,appendBody(after503.body,2))).status,401);
  await until(()=>after503Stream.done,'401 must close the restored actual drawer SSE');assert.equal(after503Stream.events.at(-1).type,'closed');assert.equal(after503Stream.events.at(-1).data.status,401);
  assert.equal((await f.request(room.path,room.drawer)).status,401);
  const restored=await f.login(room.drawer.sub);assert.notEqual(restored.cookie,room.drawer.cookie);assert.equal(restored.userKey,room.drawer.userKey);
  const restoredView=await f.request(`/api/rooms/${room.code}`,restored);assert.equal(restoredView.body.view.selfId,choosing.game.turnPlayerId);
  assert.equal((await f.request(room.path,restored)).body.pointCount,6);
  const after401Stream=await f.openStream(room.code,restored);assert.equal(after401Stream.events.find(event=>event.type==='canvas').data.pointCount,6);
  assert.equal((await f.request(room.path+'/append',restored,appendBody(after503.body,2))).body.code,'CANVAS_STALE_WRITER');
  const after401=await f.acquire(room,restored);assert.equal(after401.status,200);assert.equal(after401.body.leaseGeneration,3);
  assert.equal((await f.request(room.path+'/append',restored,appendBody(after401.body,2))).status,200);
  assert.equal((await f.request(room.path,room.viewer)).body.pointCount,9);
  const right=await room.action(room.guesser,'guess',{matchId:selected.matchId,turnId:selected.turnId,text:selected.answer});assert.equal(right.status,200,right.text);
  assert.equal(right.body.guessResult.correct,true);assert.equal(right.body.view.game.stage,'reveal');
  await until(()=>streams.viewer.events.some(event=>event.type==='view'&&event.data.game?.stage==='reveal'),'correct guess did not publish the reveal stage to the observer');
  const expectedGuesses=[{playerId:wrong.body.view.selfId,attempts:[{text:wrongText,correct:false},{text:selected.answer,correct:true}]}];
  for(const member of [restored,room.guesser,room.viewer]) {
    const revealed=(await f.request(`/api/rooms/${room.code}`,member)).body.view;
    assert.deepEqual(revealed.game.turnResult.guesses,expectedGuesses);
  }
  const revealEvent=streams.viewer.events.find(event=>event.type==='view'&&event.data.game?.stage==='reveal');
  assert.deepEqual(revealEvent.data.game.turnResult.guesses,expectedGuesses);
  assert.equal((await f.request(room.path+'/append',restored,appendBody(after401.body,3))).body.code,'CANVAS_STAGE_CLOSED');
  assert.equal((await f.request(room.path,room.viewer)).body.pointCount,9);
  t.diagnostic(JSON.stringify({adapter:kind,freshSyntheticChecks:f.checks.length,confirmedPoints:9,canvasSequence:3,restoredSameSeat:true,stage:'reveal'}));
});

test('SQLite: mounted canvas commit followed by fresh 503 is unknown, remains durable and requires explicit new writer confirmation',async t=>{
  const f=await fixture(t,'SQLite'),room=await f.waiting();await f.choose(room);
  const viewerStream=await f.openStream(room.code,room.viewer),lease=await f.acquire(room);assert.equal(lease.status,200);
  const original=f.storage.compareAndSwapMany.bind(f.storage);let injected=false;
  f.storage.compareAndSwapMany=async transaction=>{
    const result=await original(transaction);
    if(result&&!injected&&transaction.changes.some(change=>change.scope==='draw-canvases'&&change.value?.kind==='canvas'&&change.value.sequence===1)) {
      injected=true;f.statuses.set(room.drawer.sub,503);
    }
    return result;
  };
  const failed=await f.request(room.path+'/append',room.drawer,appendBody(lease.body));assert.equal(failed.status,503);assert.equal('ack' in failed.body,false);assert.equal('strokes' in failed.body,false);
  await until(()=>viewerStream.events.some(event=>event.type==='canvas'&&event.data.sequence===1),'a viewer with its own valid fresh authorization did not receive the confirmed ink');
  assert.equal((await f.request(room.path,room.viewer)).body.pointCount,3);f.statuses.set(room.drawer.sub,200);
  assert.equal((await f.request(room.path,room.drawer)).body.sequence,1);
  assert.equal((await f.request(room.path+'/append',room.drawer,appendBody(lease.body,1))).body.code,'CANVAS_STALE_WRITER');
  const newLease=await f.acquire(room);assert.equal(newLease.status,200);assert.equal(newLease.body.leaseGeneration,2);
  assert.equal((await f.request(room.path,room.viewer)).body.pointCount,3,'recovery reads and explicit acquire must not replay unknown points');
});

for(const [kind,batch]of [['Memory',false],['SQLite',false],['Memory',true],['SQLite',true]])test(`${kind} batch=${batch}: SFU join/handshake use fresh cookies, CSRF, final room guards, revocation and ephemeral state`,async t=>{
 const f=await fixture(t,kind,{voiceEnabled:true,batch}),room=await f.waiting(),a=await f.openStream(room.code,room.host),b=await f.openStream(room.code,room.peer),spectator=await f.openStream(room.code,room.viewer),outsider=await f.login('voice-outsider');
 const endpoint=`/api/rooms/${room.code}/voice`,ca='voice-client-a-123456789',cb='voice-client-b-123456789',cv='voice-client-v-123456789';
 assert.equal((await f.request(endpoint+'/join',room.host,{clientId:ca},{headers:{'X-CSRF-Token':'wrong'}})).status,403);
 assert.equal((await f.request(endpoint+'/join',outsider,{clientId:ca})).status,403);
 assert.equal((await f.request(endpoint+'/signal',room.host,{})).status,404);
 assert.equal((await f.request(endpoint+'/join',room.host,{clientId:'x'.repeat(1100)})).status,413);
 const host=await f.request(endpoint+'/join',room.host,{clientId:ca});assert.equal(host.status,200,host.text);assert(host.body.url.endsWith('/voice'));
 const peer=await f.request(endpoint+'/join',room.peer,{clientId:cb});assert.equal(peer.status,200,peer.text);
 const viewer=await f.request(endpoint+'/join',room.viewer,{clientId:cv});assert.equal(viewer.status,200,viewer.text);
 const validate=r=>'/voice/rtc/v1/validate?access_token='+encodeURIComponent(r.body.token);
 assert.equal((await f.request(validate(host),room.host)).status,200);
 assert.equal((await f.request(validate(host),room.peer)).status,403);
 assert.equal((await f.request(validate(host),outsider)).status,403);
 assert.equal((await f.request(validate(host),room.host,undefined,{headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal((await f.request('/voice/twirp/livekit.RoomService/ListRooms',room.host)).status,404);
 const before=(await f.request(`/api/rooms/${room.code}`,room.host)).body.view;
 const changed=await f.request(endpoint+'/join',room.host,{clientId:ca+'new'});assert.equal(changed.status,200,changed.text);
 assert.equal((await f.request(validate(host),room.host)).status,403);assert.equal((await f.request(validate(changed),room.host)).status,200);
 await until(()=>a.events.some(e=>e.type==='voice'&&e.data.target===host.body.id&&e.data.kind==='closed'),'old terminal must close');
 assert.equal(b.events.some(e=>e.type==='voice'&&e.data.target===host.body.id),false);
 const after=(await f.request(`/api/rooms/${room.code}`,room.host)).body.view;assert.equal(before.game.revision,after.game.revision);assert.equal(before.matchId,after.matchId);
 for(const scope of ['rooms','room-chat','game-profiles'])for(const capability of [host.body.token,peer.body.token,viewer.body.token])assert.equal(JSON.stringify((await f.storage.scan(scope)).map(r=>r.value)).includes(capability),false);
 f.statuses.set(room.peer.sub,401);assert.equal((await f.request(endpoint+'/leave',room.peer,{id:peer.body.id,clientId:cb})).status,401);await until(()=>b.done,'revoked private stream must close');await f.voice.settle();assert(f.removed.some(r=>r.identity===peer.body.id));assert.equal((await f.request(validate(peer),room.peer)).status,403);
 const originalAssert=f.runtime.sessions.assertCurrent.bind(f.runtime.sessions);let fences=0;f.runtime.sessions.assertCurrent=async()=>{fences++;throw new IdentityFailure(503);};const fenced=await f.request(endpoint+'/join',room.host,{clientId:'voice-new-final-fence-test'});assert.equal(fenced.status,503);assert(fences>0,'both identity modes must reach the final atomic guard');assert.equal(f.voice.authorizeMedia(changed.body.token).id,changed.body.id);f.runtime.sessions.assertCurrent=originalAssert;
 const left=await f.request(endpoint+'/leave',room.viewer,{id:viewer.body.id,clientId:cv});assert.equal(left.status,200,left.text);await f.voice.settle();assert(f.removed.some(r=>r.identity===viewer.body.id));
 await f.voice.close();assert.equal((await f.request(endpoint+'/join',room.host,{clientId:ca})).status,424);assert.equal((await f.request(room.path,room.host)).status,200,'media failure must preserve game and drawing reads');
});

for(const gameType of ['rummikub','army-flip','flying-chess','poker414-2','hyakki-trading'])test(`${gameType}: actual HTTP and SSE admit current members, isolate rooms, revoke exit, preserve game`,async t=>{
 const f=await fixture(t,'Memory',{voiceEnabled:true,allGames:true}),host=await f.login('voice-'+gameType),other=await f.login('outside-'+gameType);
 const created=await f.request('/api/rooms',host,{name:'语音验收',gameType,requestId:randomUUID()});assert.equal(created.status,201,created.text);
 const code=created.body.roomCode,endpoint=`/api/rooms/${code}/voice`,clientId='current-voice-client-12345678';
 assert.equal((await f.request(endpoint+'/join',host,{clientId})).status,409,'a room read is not an SSE lease');
 const stream=await f.openStream(code,host,{canvas:false}),joined=await f.request(endpoint+'/join',host,{clientId});assert.equal(joined.status,200,joined.text);
 const permit=f.voice.authorizeMedia(joined.body.token);assert.equal(permit.gameType,gameType);assert.equal(permit.playerId,created.body.view.selfId);
 assert.equal((await f.request(endpoint+'/join',other,{clientId:'outsider-voice-client-1234'})).status,403);
 const wrong=await f.request(endpoint+'/leave',host,{id:joined.body.id,clientId:'different-voice-client-1234'});assert.equal(wrong.status,409);
 const before=(await f.request(`/api/rooms/${code}`,host)).body.view;
 const left=await f.request(endpoint+'/leave',host,{id:joined.body.id,clientId});assert.equal(left.status,200,left.text);await f.voice.settle();
 assert.throws(()=>f.voice.authorizeMedia(joined.body.token));
 const after=(await f.request(`/api/rooms/${code}`,host)).body.view;assert.equal(after.revision,before.revision);assert.deepEqual(after.game,before.game);
 const again=await f.request(endpoint+'/join',host,{clientId});assert.equal(again.status,200,again.text);
 stream.controller.abort();await stream.pump;await until(()=>f.removed.some(m=>m.identity===again.body.id),'SSE exit did not revoke media');
});

test('Parks remains explicitly denied and every supported page retains its entry-bound websocket CSP',async t=>{
 const f=await fixture(t,'Memory',{voiceEnabled:true,allGames:true}),host=await f.login('parks-no-voice');
 // A disabled Parks deployment is also fail closed; a forged service authority
 // must never bypass the HTTP/catalog boundary.
 assert.throws(()=>f.voice.subscribe({gameType:'parks',roomId:'r'.repeat(32),playerId:'p'.repeat(32),sessionId:'s'.repeat(32)},()=>{}));
 for(const page of ['room.html','army.html','flying.html','drawing.html','poker414.html','hyakki.html']){
  const result=await f.request('/'+page,host);assert.equal(result.status,200,result.text.slice(0,80));assert.match(result.headers.get('Content-Security-Policy'),/connect-src 'self' ws:\/\/127\.0\.0\.1:\d+\/voice\//);
 }
 const parks=await f.request('/parks.html',host);if(parks.status===200)assert.doesNotMatch(parks.headers.get('Content-Security-Policy'),/\/voice\//);
});
