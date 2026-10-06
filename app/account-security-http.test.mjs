import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { readSettings, SHARED_ISSUER } from '../server/config.mjs';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';
import { MockProvider, IdentityFailure } from '../server/auth.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';

const CLIENT='27oe1fs5shskll808e733lqm65';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Protocol-level synthetic provider. JWT/cutoff/central pacing are separately
// tested with real RSA signatures in the provider and policy-client tests.
async function fixture(t,{watchdogMs=15000,heartbeatMs=20000}={}) {
  const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock'}),provider=new MockProvider(settings);
  settings.mode='cognito';settings.issuer=SHARED_ISSUER;settings.clientId=CLIENT;
  provider.member='a';provider.status=new Map();provider.checks=[];provider.failOn=null;
  provider.complete=async()=>({issuer:SHARED_ISSUER,sub:provider.member,accessToken:`synthetic-private-${provider.member}`,
    authTime:Math.floor(Date.now()/1000),clientId:CLIENT,expiresAt:Date.now()+3600000});
  provider.check=async identity=>{
    provider.checks.push(identity.sub);
    await provider.beforeCheck?.(identity,provider.checks.length);
    const status=provider.failOn?.(identity,provider.checks.length) ?? provider.status.get(identity.sub) ?? 200;
    if(status!==200) throw new IdentityFailure(status);
    return {...identity,expiresAt:Date.now()+3600000};
  };
  const storage=new EncryptedStore(new MemoryAdapter(),randomBytes(32));
  const runtime=createRuntime(settings,{storage,provider,roomOptions:{pollIntervalMs:0}});
  const server=createUnifiedServer({...runtime,watchdogMs,heartbeatMs});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;settings.origin=base;settings.callback=base+'/auth/callback';
  t.after(()=>server.shutdown());
  const request=async(url,{cookie,csrf,method='GET',body}={})=>{
    const response=await fetch(base+url,{method,redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),
      ...(method==='GET'?{}:{Origin:base}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const text=await response.text();return {response,body:text?JSON.parse(text):null};
  };
  async function login(member,returnTo='/') {
    provider.member=member;
    const start=await request('/auth/login?returnTo='+encodeURIComponent(returnTo));
    const tx=start.response.headers.getSetCookie()[0].split(';')[0];
    const location=new URL(start.response.headers.get('location'));
    const callback=await request(location.pathname+location.search,{cookie:tx});
    assert.equal(callback.response.status,303);
    const cookie=callback.response.headers.getSetCookie().find(value=>value.startsWith(settings.cookieName+'=')).split(';')[0];
    const {body:state}=await request('/api/state',{cookie});assert.equal(state.authenticated,true);
    return {cookie,csrf:state.csrf,state,callback};
  }
  const create=async member=>{
    const result=await request('/api/rooms',{...member,method:'POST',body:{name:'同名朋友',requestId:randomUUID()}});
    assert.equal(result.response.status,201);return result.body;
  };
  return {settings,provider,runtime,server,base,request,login,create};
}
async function stream(f,member,code) {
  const response=await fetch(`${f.base}/api/rooms/${code}/events`,{headers:{Cookie:member.cookie}});
  assert.equal(response.status,200);const reader=response.body.getReader();let text='';
  async function until(predicate) {
    const timer=AbortSignal.timeout(3000);
    while(!predicate(text)) {
      const result=await Promise.race([reader.read(),new Promise((_,reject)=>timer.addEventListener('abort',()=>reject(new Error('private stream deadline')),{once:true}))]);
      if(result.done) break;text+=new TextDecoder().decode(result.value);
    }
    assert.ok(predicate(text),text);return text;
  }
  await until(value=>value.includes('event: view'));
  return {reader,until,text:()=>text};
}

test('E3 every private read checks again before output and a rejected result never exposes a hand',async t=>{
  const f=await fixture(t),a=await f.login('a'),room=await f.create(a);
  let before=f.provider.checks.length;
  const first=await f.request(`/api/rooms/${room.roomCode}`,a);assert.equal(first.response.status,200);
  assert.equal(f.provider.checks.length-before,2);
  before=f.provider.checks.length;
  f.provider.failOn=(_,count)=>count===before+2?401:200;
  const denied=await f.request(`/api/rooms/${room.roomCode}`,a);
  assert.equal(denied.response.status,401);assert.equal(denied.body.view,undefined);
  assert.equal(denied.response.headers.get('set-cookie'),null,'an old 401 must not clear a newly rotated browser session cookie');
  f.provider.failOn=null;
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`,a)).response.status,401);
  const restored=await f.login('a');
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`,restored)).body.view.selfId,room.playerId);
});

test('E3 unknown committed write returns 503 without rollback or retry; the same stable seat survives re-login',async t=>{
  const f=await fixture(t),a=await f.login('a'),room=await f.create(a),before=f.provider.checks.length;
  f.provider.failOn=(_,count)=>count===before+2?503:200;
  const result=await f.request(`/api/rooms/${room.roomCode}/actions`,{...a,method:'POST',body:{type:'ready',ready:true,
    requestId:randomUUID(),expectedRevision:room.view.revision}});
  assert.equal(result.response.status,503);assert.equal(result.body.view,undefined);
  f.provider.failOn=null;
  const current=(await f.request(`/api/rooms/${room.roomCode}`,a)).body.view;
  assert.equal(current.players[0].ready,true);
  assert.equal(current.revision,room.view.revision+1);
  const fresh=await f.login('a','/room.html?code='+room.roomCode);
  assert.equal(fresh.callback.response.headers.get('location'),'/room.html?code='+room.roomCode);
  const same=(await f.request(`/api/rooms/${room.roomCode}`,fresh)).body.view;
  assert.equal(same.selfId,room.playerId);assert.equal(same.revision,current.revision);
});

test('E3 failed known callback keeps the invitation and offers a fixed central re-verification entry',async t=>{
  const f=await fixture(t);
  const state=await f.request('/api/state');
  assert.equal(state.body.reauthReady,true);assert.equal(state.body.reauthHref,'https://agora.sumomoli.com/#account');
  const start=await f.request('/auth/login?returnTo='+encodeURIComponent('/room.html?code=123456'));
  const cookie=start.response.headers.getSetCookie()[0].split(';')[0],url=new URL(start.response.headers.get('location'));
  f.provider.status.set('a',401);
  const failed=await f.request(url.pathname+url.search,{cookie});
  assert.equal(failed.response.status,303);
  assert.equal(failed.response.headers.get('location'),'/room.html?code=123456&login=verify');
  assert.equal(JSON.stringify(failed.body).includes('synthetic-private'),false);
});

test('E3 quiet SSE cutoff closes every old stream, preserving the game and other players private access',async t=>{
  const f=await fixture(t,{watchdogMs:25}),a=await f.login('a'),room=await f.create(a),second=await f.login('a');
  const b=await f.login('b'),joined=await f.request(`/api/rooms/${room.roomCode}/join`,{...b,method:'POST',body:{name:'同名朋友',requestId:randomUUID()}});
  assert.notEqual(joined.body.playerId,room.playerId);
  const one=await stream(f,a,room.roomCode),two=await stream(f,second,room.roomCode),other=await stream(f,b,room.roomCode);
  f.provider.status.set('a',401);
  const closed=await Promise.all([one.until(v=>v.includes('event: closed')),two.until(v=>v.includes('event: closed'))]);
  assert.ok(closed.every(value=>value.includes('"status":401')));
  await one.reader.cancel();await two.reader.cancel();
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`,b)).body.view.selfId,joined.body.playerId);
  assert.equal(other.text().includes('event: closed'),false);await other.reader.cancel();
  f.provider.status.set('a',200);const fresh=await f.login('a');
  const restored=(await f.request(`/api/rooms/${room.roomCode}`,fresh)).body.view;
  assert.equal(restored.selfId,room.playerId);assert.equal(restored.players.length,2);
});

test('E3 watchdog cannot wait behind a blocked private view; unavailable policy pauses without deleting the seat',async t=>{
  const f=await fixture(t,{watchdogMs:25}),a=await f.login('a'),room=await f.create(a),channel=await stream(f,a,room.roomCode);
  const entered=deferred(),release=deferred(),original=f.runtime.rooms.getView;
  let block=true;
  f.runtime.rooms.getView=async(...args)=>{if(block) {block=false;entered.resolve();await release.promise;}return original(...args);};
  const operation=f.runtime.rooms.action(room.roomCode,a.state.userKey,{type:'ready',ready:true,requestId:randomUUID(),expectedRevision:room.view.revision});
  await entered.promise;f.provider.status.set('a',503);
  const closed=await channel.until(value=>value.includes('event: closed'));
  assert.match(closed,/"status":503/);await channel.reader.cancel();release.resolve();await operation;
  f.provider.status.set('a',200);
  const restored=(await f.request(`/api/rooms/${room.roomCode}`,a)).body.view;
  assert.equal(restored.selfId,room.playerId);assert.equal(restored.players[0].ready,true);
});

test('E3 rejected login never deletes a running game, and the same account recovers only its own private hand',async t=>{
  const f=await fixture(t),a=await f.login('a'),room=await f.create(a),b=await f.login('b');
  const joined=await f.request(`/api/rooms/${room.roomCode}/join`,{...b,method:'POST',body:{name:'同名朋友',requestId:randomUUID()}});
  async function action(member,type,extra={}) {
    const view=(await f.request(`/api/rooms/${room.roomCode}`,member)).body.view;
    const result=await f.request(`/api/rooms/${room.roomCode}/actions`,{...member,method:'POST',body:{type,...extra,
      requestId:randomUUID(),expectedRevision:view.revision}});
    assert.equal(result.response.status,200);return result.body.view;
  }
  await action(a,'ready',{ready:true});await action(b,'ready',{ready:true});
  const game=await action(a,'start'),partner=(await f.request(`/api/rooms/${room.roomCode}`,b)).body.view;
  assert.equal(game.phase,'playing');assert.equal(game.game.rack.length,14);
  assert.equal(game.game.playerId,room.playerId);assert.equal(partner.game.playerId,joined.body.playerId);
  assert.equal(partner.game.rack.some(tile=>game.game.rack.some(own=>own.id===tile.id)),false);
  f.provider.status.set('a',401);
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`,a)).response.status,401);
  assert.deepEqual((await f.request(`/api/rooms/${room.roomCode}`,b)).body.view.game,partner.game);
  f.provider.status.set('a',200);const fresh=await f.login('a','/room.html?code='+room.roomCode);
  const recovered=(await f.request(`/api/rooms/${room.roomCode}`,fresh)).body.view;
  assert.equal(recovered.selfId,room.playerId);assert.deepEqual(recovered.game,game.game);
});

test('E3 public heartbeat does not call the central policy; seven stable users keep distinct seats',async t=>{
  const f=await fixture(t,{watchdogMs:15000,heartbeatMs:15}),members=[];
  for(let index=0;index<7;index++) members.push(await f.login('member-'+index));
  const room=await f.create(members[0]);
  const seats=[room.playerId];
  for(const member of members.slice(1)) {
    const result=await f.request(`/api/rooms/${room.roomCode}/join`,{...member,method:'POST',body:{name:'同名朋友',requestId:randomUUID()}});
    assert.equal(result.response.status,201);seats.push(result.body.playerId);
  }
  assert.equal(new Set(seats).size,7);
  const channel=await stream(f,members[0],room.roomCode),before=f.provider.checks.length;
  await channel.until(value=>value.includes(': ping'));
  await delay(35);assert.equal(f.provider.checks.length,before);await channel.reader.cancel();
});

test('E3 a concurrent explicit leave while central output checks wait cannot leak the abandoned seat view',async t=>{
  const f=await fixture(t),a=await f.login('a'),room=await f.create(a),b=await f.login('b');
  await f.request(`/api/rooms/${room.roomCode}/join`,{...b,method:'POST',body:{name:'同名朋友',requestId:randomUUID()}});
  const before=f.provider.checks.length,entered=deferred(),release=deferred();
  f.provider.beforeCheck=async(_,count)=>{if(count===before+2) {entered.resolve();await release.promise;}};
  const response=f.request(`/api/rooms/${room.roomCode}`,a);await entered.promise;
  const current=await f.runtime.rooms.getView(room.roomCode,a.state.userKey);
  await f.runtime.rooms.action(room.roomCode,a.state.userKey,{type:'leave',requestId:randomUUID(),expectedRevision:current.revision});
  release.resolve();const denied=await response;
  assert.equal(denied.response.status,403);assert.equal(denied.body.view,undefined);
  assert.equal((await f.request('/api/state',a)).body.authenticated,true);
});

test('E3 a join response crossing explicit leave and rejoin projects the new authorized seat without replaying writes',async t=>{
  const f=await fixture(t),a=await f.login('a'),room=await f.create(a),b=await f.login('b');
  await f.request(`/api/rooms/${room.roomCode}/join`,{...b,method:'POST',body:{name:'同名朋友',requestId:randomUUID()}});
  const before=f.provider.checks.length,entered=deferred(),release=deferred();
  f.provider.beforeCheck=async(_,count)=>{if(count===before+2) {entered.resolve();await release.promise;}};
  const response=f.request(`/api/rooms/${room.roomCode}/join`,{...a,method:'POST',body:{name:'同名朋友',requestId:randomUUID()}});await entered.promise;
  const current=await f.runtime.rooms.getView(room.roomCode,a.state.userKey);
  await f.runtime.rooms.action(room.roomCode,a.state.userKey,{type:'leave',requestId:randomUUID(),expectedRevision:current.revision});
  const replacement=await f.runtime.rooms.joinRoom(room.roomCode,a.state.userKey,'同名朋友',randomUUID());
  assert.notEqual(replacement.playerId,room.playerId);release.resolve();
  const returned=await response;assert.equal(returned.response.status,201);
  assert.equal(returned.body.playerId,replacement.playerId);assert.equal(returned.body.view.selfId,replacement.playerId);
});
