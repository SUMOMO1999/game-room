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
async function fixture(t,{gameType='rummikub'}={}) {
  let time=Date.now();const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock'}),provider=new MockProvider(settings);
  settings.mode='cognito';settings.issuer=SHARED_ISSUER;settings.clientId=CLIENT;provider.member='a';provider.checks=[];provider.failOn=null;
  provider.complete=async()=>({issuer:SHARED_ISSUER,sub:provider.member,accessToken:`private-token-${provider.member}`,
    authTime:Math.floor(Date.now()/1000),clientId:CLIENT,expiresAt:Date.now()+3600000});
  provider.check=async identity=>{provider.checks.push(identity.sub);await provider.beforeCheck?.(identity,provider.checks.length);
    const status=provider.failOn?.(identity,provider.checks.length) ?? 200;if(status!==200) throw new IdentityFailure(status);return {...identity,expiresAt:Date.now()+3600000};};
  const storage=new EncryptedStore(new MemoryAdapter(),randomBytes(32));
  const runtime=createRuntime(settings,{storage,provider,roomOptions:{pollIntervalMs:0},previewOptions:{now:()=>time,sweepMs:0}});
  const server=createUnifiedServer(runtime);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;settings.origin=base;settings.callback=base+'/auth/callback';t.after(()=>server.shutdown());
  async function request(path,{cookie,csrf,method='GET',body}={}) {
    const response=await fetch(base+path,{method,redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(method==='GET'?{}:{Origin:base}),
      ...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const text=await response.text();return {response,body:text?JSON.parse(text):null};
  }
  async function login(member) {
    provider.member=member;const start=await request('/auth/login'),tx=start.response.headers.getSetCookie()[0].split(';')[0],location=new URL(start.response.headers.get('location'));
    const callback=await request(location.pathname+location.search,{cookie:tx});assert.equal(callback.response.status,303);
    const cookie=callback.response.headers.getSetCookie().find(value=>value.startsWith(settings.cookieName+'=')).split(';')[0];
    const {body:state}=await request('/api/state',{cookie});return {cookie,csrf:state.csrf,state};
  }
  const a=await login('a'),b=await login('b');
  const create=await request('/api/rooms',{...a,method:'POST',body:{name:'甲',requestId:randomUUID(),gameType}});assert.equal(create.response.status,201);
  const code=create.body.roomCode;const joined=await request(`/api/rooms/${code}/join`,{...b,method:'POST',body:{name:'乙',requestId:randomUUID()}});assert.equal(joined.response.status,201);
  async function action(member,type,fields={}) {
    const current=await runtime.rooms.getView(code,member.state.userKey);
    return request(`/api/rooms/${code}/actions`,{...member,method:'POST',body:{...fields,type,requestId:randomUUID(),expectedRevision:current.revision}});
  }
  assert.equal((await action(a,'ready',{ready:true})).response.status,200);assert.equal((await action(b,'ready',{ready:true})).response.status,200);
  assert.equal((await action(a,'start')).response.status,200);
  const views=await Promise.all([runtime.rooms.getView(code,a.state.userKey),runtime.rooms.getView(code,b.state.userKey)]);
  const owner=views[0].game.turnPlayerId===views[0].selfId?a:b,other=owner===a?b:a,ownerView=views[owner===a?0:1];
  const body={previewId:randomUUID(),sequence:1,matchId:ownerView.matchId,gameRevision:ownerView.game.revision,
    boardIds:ownerView.gameType==='rummikub'?[...ownerView.game.board.map(group=>group.map(tile=>tile.id)),[ownerView.game.rack[0].id]]:[]};
  const post=(value=body,member=owner)=>request(`/api/rooms/${code}/preview`,{...member,method:'POST',body:value});
  return {runtime,provider,base,request,action,login,a,b,owner,other,ownerView,views,body,post,code,advance(ms=6000){time+=ms;}};
}
async function openStream(f,member) {
  const controller=new AbortController(),response=await fetch(`${f.base}/api/rooms/${f.code}/events?preview=1`,{headers:{Cookie:member.cookie},signal:controller.signal});
  assert.equal(response.status,200);const reader=response.body.getReader();let text='';
  async function until(predicate) {
    const timeout=AbortSignal.timeout(4000);
    while(!predicate(text)) {
      const result=await Promise.race([reader.read(),new Promise((_,reject)=>timeout.addEventListener('abort',()=>reject(new Error('preview stream deadline')),{once:true}))]);
      if(result.done) break;text+=new TextDecoder().decode(result.value);
    }
    assert.ok(predicate(text),text);return text;
  }
  await until(text=>text.includes('event: view'));
  if(f.ownerView.gameType==='rummikub')await until(text=>text.includes('event: preview'));
  await new Promise(resolve=>setImmediate(resolve));
  return {until,text:()=>text,close(){controller.abort();}};
}

test('HTTP preview reads/writes fresh-check twice, never persist or advance authoritative state',async t=>{
  const f=await fixture(t),before=await f.runtime.rooms.getView(f.code,f.owner.state.userKey),checks=f.provider.checks.length;
  const persistedBefore=await f.runtime.storage.adapter.entries('rooms');
  const result=await f.post();assert.equal(result.response.status,200);assert.equal(f.provider.checks.length-checks,2);
  assert.equal(result.body.view,undefined);f.advance();const next=f.provider.checks.length;
  const read=await f.request(`/api/rooms/${f.code}/preview`,f.other);assert.equal(read.response.status,200);assert.equal(f.provider.checks.length-next,2);
  assert.deepEqual(read.body.preview.board.flat().map(tile=>tile.id),[f.ownerView.game.rack[0].id]);assert.equal(read.body.preview.valid,false);
  assert.ok(!JSON.stringify(read.body).includes('private-token'));assert.ok(!JSON.stringify(read.body).includes('rack'));
  const after=await f.runtime.rooms.getView(f.code,f.owner.state.userKey);assert.equal(after.revision,before.revision);assert.deepEqual(after.game,before.game);
  assert.deepEqual(await f.runtime.storage.adapter.entries('rooms'),persistedBefore);
  assert.ok([...f.runtime.storage.adapter.records.keys()].every(key=>!key.startsWith('preview:')));
});

test('HTTP rejects another hand and a non-turn seat before any public preview is published',async t=>{
  const f=await fixture(t),other=await f.runtime.rooms.getView(f.code,f.other.state.userKey);
  const stolen=await f.post({...f.body,boardIds:[[other.game.rack[0].id]]});assert.equal(stolen.response.status,400);assert.equal(stolen.body.code,'PREVIEW_PRIVATE_TILE');f.advance();
  const turn=await f.post(f.body,f.other);assert.equal(turn.response.status,409);assert.equal(turn.body.code,'PREVIEW_NOT_TURN');
  assert.equal(f.runtime.preview.packet(f.ownerView).preview,null);
});

test('HTTP budget rejects before online checks and allows no unbounded cross-room preview flood',async t=>{
  const f=await fixture(t);assert.equal((await f.post()).response.status,200);const count=f.provider.checks.length;
  const limited=await f.post({...f.body,sequence:2});assert.equal(limited.response.status,429);assert.equal(limited.body.code,'PREVIEW_RATE_LIMIT');
  assert.ok(limited.body.minIntervalMs>=1112);assert.ok(Number.isFinite(limited.body.nextAllowedAt));assert.equal(f.provider.checks.length,count);
  const otherRoom=await f.request('/api/rooms/654321/preview',f.owner);assert.equal(otherRoom.response.status,429);assert.equal(f.provider.checks.length,count);
});

test('forged preview cookies are unauthorized and cannot steal the global publication budget',async t=>{
  const f=await fixture(t),count=f.provider.checks.length;
  const forged=await f.request(`/api/rooms/${f.code}/preview`,{cookie:`${f.runtime.settings.cookieName}=${'x'.repeat(43)}`});
  assert.equal(forged.response.status,401);assert.equal(f.provider.checks.length,count);
  assert.equal((await f.post()).response.status,200);
});

test('second E3 failure cannot publish an arrangement; existing previews clear on 401/503',async t=>{
  for(const status of [401,503]) {
    const f=await fixture(t);assert.equal((await f.post()).response.status,200);f.advance();
    const count=f.provider.checks.length;f.provider.failOn=(_,index)=>index===count+2?status:200;
    const denied=await f.post({...f.body,sequence:2});assert.equal(denied.response.status,status);assert.equal(denied.body.preview,undefined);
    assert.equal(f.runtime.preview.packet(f.ownerView).preview,null);assert.equal(f.ownerView.game.revision,0);
  }
});

test('turn transition while an E3 check waits discards the prepared preview',async t=>{
  const f=await fixture(t),blocked=deferred(),release=deferred(),count=f.provider.checks.length;
  f.provider.beforeCheck=async(_,index)=>{if(index===count+2) {blocked.resolve();await release.promise;}};
  const pending=f.post();await blocked.promise;
  const current=await f.runtime.rooms.getView(f.code,f.owner.state.userKey);
  await f.runtime.rooms.action(f.code,f.owner.state.userKey,{type:'draw',requestId:randomUUID(),expectedRevision:current.revision});release.resolve();
  const result=await pending;assert.equal(result.response.status,409);assert.equal(result.body.code,'PREVIEW_STALE');
  assert.equal(f.runtime.preview.packet(await f.runtime.rooms.getView(f.code,f.other.state.userKey)).preview,null);
});

test('preview SSE carries safely projected tiles, excludes owner echoes, and fresh-checks each observer',async t=>{
  const f=await fixture(t),observer=await openStream(f,f.other),author=await openStream(f,f.owner);t.after(()=>{observer.close();author.close();});
  const count=f.provider.checks.length,result=await f.post();assert.equal(result.response.status,200);assert.equal(result.body.observerCount,1);assert.equal(result.body.minIntervalMs,1667);
  const text=await observer.until(text=>text.includes('event: preview') && text.includes(f.body.previewId));
  assert.ok(text.includes(f.ownerView.game.rack[0].id));assert.equal(f.provider.checks.length-count,3);
  const ownPackets=author.text().split('event: preview\ndata: ').slice(1).map(packet=>JSON.parse(packet.split('\n\n')[0]));
  assert.equal(ownPackets.length,1);assert.equal(ownPackets[0].preview,null);assert.ok(!author.text().includes(f.body.previewId));assert.ok(!text.includes('private-token'));
  f.advance();const otherSubject=f.other===f.a?'a':'b';f.provider.failOn=identity=>identity.sub===otherSubject?401:200;
  assert.equal((await f.post({...f.body,sequence:2})).response.status,200);
  const closed=await observer.until(text=>text.includes('event: closed'));assert.ok(closed.includes('"status":401'));
  assert.equal((closed.match(/event: preview/g) || []).length,2);
});

test('a late observer stream receives the latest accepted preview while its original 30s TTL remains active',async t=>{
  const f=await fixture(t);assert.equal((await f.post()).response.status,200);f.advance(9000);
  const observer=await openStream(f,f.other);t.after(()=>observer.close());
  const text=await observer.until(text=>text.includes('event: preview') && text.includes(f.body.previewId));
  assert.ok(text.includes(f.ownerView.game.rack[0].id));assert.ok(!text.includes('"rack":'+JSON.stringify(f.ownerView.game.rack)));
});

test('seat leave while a preview check waits cannot authorize stale private room output',async t=>{
  const f=await fixture(t),blocked=deferred(),release=deferred(),count=f.provider.checks.length;
  f.provider.beforeCheck=async(_,index)=>{if(index===count+2) {blocked.resolve();await release.promise;}};
  const pending=f.post();await blocked.promise;const current=await f.runtime.rooms.getView(f.code,f.owner.state.userKey);
  await f.runtime.rooms.action(f.code,f.owner.state.userKey,{type:'leave',requestId:randomUUID(),expectedRevision:current.revision});release.resolve();
  const result=await pending;assert.ok([403,404].includes(result.response.status));assert.equal(result.body.preview,undefined);
});

test('army does not expose a preview endpoint or emit this optional stream channel',async t=>{
  const f=await fixture(t,{gameType:'army-flip'}),result=await f.post();assert.equal(result.response.status,400);assert.equal(result.body.code,'PREVIEW_UNSUPPORTED');
});

test('a logged-in late join is a stable spectator with no hand, game authority or counterfeit nickname ownership',async t=>{
  const f=await fixture(t),c=await f.login('c');
  const joined=await f.request(`/api/rooms/${f.code}/join`,{...c,method:'POST',body:{name:'甲',role:'player',requestId:randomUUID()}});
  assert.equal(joined.response.status,201);const member=joined.body;assert.equal(member.view.selfRole,'spectator');assert.equal(member.view.players.length,2);
  assert.equal(member.view.game.rack,undefined);assert.equal(member.view.game.playerId,undefined);assert.equal(member.view.hostCanTakeOver,false);
  for(const ownerView of f.views) for(const card of ownerView.game.rack) assert.ok(!JSON.stringify(member.view).includes(`"${card.id}"`));
  const relogged=await f.login('c'),restored=await f.request(`/api/rooms/${f.code}/join`,{...relogged,method:'POST',body:{name:'改名',requestId:randomUUID()}});
  assert.equal(restored.body.playerId,member.playerId);assert.equal(restored.body.view.selfRole,'spectator');
  const denied=await f.request(`/api/rooms/${f.code}/actions`,{...relogged,method:'POST',body:{type:'pause',requestId:randomUUID(),expectedRevision:restored.body.view.revision}});
  assert.equal(denied.response.status,403);assert.equal(denied.body.code,'SPECTATOR_READ_ONLY');
  assert.equal((await f.runtime.rooms.getView(f.code,f.owner.state.userKey)).phase,'playing');
  const chat=await f.request(`/api/rooms/${f.code}/chat`,{...relogged,method:'POST',body:{text:'观战中',requestId:randomUUID()}});
  assert.equal(chat.response.status,200);assert.equal(chat.body.message.playerId,member.playerId);assert.equal(chat.body.message.name,'改名');
});

test('a pregame spectator can take a seat via an explicit CAS action, and join never silently changes an existing role',async t=>{
  const f=await fixture(t),c=await f.login('c');
  const created=await f.request('/api/rooms',{...f.a,method:'POST',body:{name:'甲',requestId:randomUUID()}}),code=created.body.roomCode;
  const observer=await f.request(`/api/rooms/${code}/join`,{...c,method:'POST',body:{name:'丙',role:'spectator',requestId:randomUUID()}});
  assert.equal(observer.body.view.selfRole,'spectator');assert.equal(observer.body.view.players.length,1);
  const joined=await f.request(`/api/rooms/${code}/join`,{...c,method:'POST',body:{name:'丙',role:'player',requestId:randomUUID()}});
  assert.equal(joined.body.view.selfRole,'spectator');assert.equal(joined.body.playerId,observer.body.playerId);
  const seated=await f.request(`/api/rooms/${code}/actions`,{...c,method:'POST',body:{type:'set-role',role:'player',requestId:randomUUID(),expectedRevision:joined.body.view.revision}});
  assert.equal(seated.response.status,200);assert.equal(seated.body.view.selfRole,'player');assert.equal(seated.body.view.selfId,observer.body.playerId);
  assert.equal(seated.body.view.players.length,2);assert.equal(seated.body.view.spectators.length,0);
});

test('spectators receive safe table previews and an unverifiable SSE check stops only that connection',async t=>{
  const f=await fixture(t),c=await f.login('c');
  const joined=await f.request(`/api/rooms/${f.code}/join`,{...c,method:'POST',body:{name:'观众',requestId:randomUUID()}}),observer=await openStream(f,c);t.after(()=>observer.close());
  assert.equal(joined.body.view.selfRole,'spectator');const before=f.provider.checks.length;
  assert.equal((await f.post()).response.status,200);const first=await observer.until(text=>text.includes('event: preview') && text.includes(f.body.previewId));
  assert.equal(f.provider.checks.length-before,3);assert.ok(first.includes(f.ownerView.game.rack[0].id));assert.ok(!first.includes('"rack":'));assert.ok(!first.includes('"pool":'));
  f.advance();f.provider.failOn=identity=>identity.sub==='c'?503:200;
  assert.equal((await f.post({...f.body,sequence:2})).response.status,200);const denied=await observer.until(text=>text.includes('event: closed'));
  assert.ok(denied.includes('"status":503'));assert.equal((denied.match(/event: preview/g)||[]).length,2);
  f.provider.failOn=null;const recovered=await f.login('c'),view=(await f.request(`/api/rooms/${f.code}`,recovered)).body.view;
  assert.equal(view.selfId,joined.body.playerId);assert.equal(view.selfRole,'spectator');assert.equal(view.game.rack,undefined);
  assert.equal((await f.runtime.rooms.getView(f.code,f.owner.state.userKey)).game.revision,f.ownerView.game.revision);
});

test('a rejected second preview GET check returns no packet and does not invalidate the author arrangement',async t=>{
  const f=await fixture(t);assert.equal((await f.post()).response.status,200);f.advance();const count=f.provider.checks.length;
  f.provider.failOn=(_,index)=>index===count+2?503:200;
  const rejected=await f.request(`/api/rooms/${f.code}/preview`,f.other);assert.equal(rejected.response.status,503);assert.equal(rejected.body.preview,undefined);
  assert.ok(f.runtime.preview.packet(f.ownerView).preview);assert.equal(f.ownerView.game.revision,0);
});

test('a spectator leaving during its SSE E3 wait receives no late preview and never aborts player turns',async t=>{
  const f=await fixture(t),c=await f.login('c');
  await f.request(`/api/rooms/${f.code}/join`,{...c,method:'POST',body:{name:'观众',requestId:randomUUID()}});
  const observer=await openStream(f,c);t.after(()=>observer.close());const blocked=deferred(),release=deferred();
  f.provider.beforeCheck=async identity=>{if(identity.sub==='c') {blocked.resolve();await release.promise;}};
  const posted=f.post();await blocked.promise;const current=await f.runtime.rooms.getView(f.code,c.state.userKey);
  await f.runtime.rooms.action(f.code,c.state.userKey,{type:'leave',requestId:randomUUID(),expectedRevision:current.revision});release.resolve();
  assert.equal((await posted).response.status,200);const text=await observer.until(text=>text.includes('event: closed'));
  assert.equal((text.match(/event: preview/g)||[]).length,1);assert.ok(!text.includes(f.body.previewId));assert.ok(text.includes('"status":404'));
  assert.equal((await f.runtime.rooms.getView(f.code,f.owner.state.userKey)).phase,'playing');
});

test('HTTP host configuration is a normal E3 business write: readiness resets, a late 503 is reconciled by reading',async t=>{
  const f=await fixture(t),created=await f.request('/api/rooms',{...f.a,method:'POST',body:{name:'新房',requestId:randomUUID()}}),code=created.body.roomCode;
  const first=await f.request(`/api/rooms/${code}/actions`,{...f.a,method:'POST',body:{type:'ready',ready:true,requestId:randomUUID(),expectedRevision:created.body.view.revision}});
  const count=f.provider.checks.length,jokerConfig={normal:2,mirror:1,colorChange:0,double:1};f.provider.failOn=(_,index)=>index===count+2?503:200;
  const configured=await f.request(`/api/rooms/${code}/actions`,{...f.a,method:'POST',body:{type:'configure',jokerConfig,requestId:randomUUID(),expectedRevision:first.body.view.revision}});
  assert.equal(configured.response.status,503);assert.equal(configured.body.view,undefined);f.provider.failOn=null;
  const current=(await f.request(`/api/rooms/${code}`,f.a)).body.view;assert.deepEqual(current.jokerConfig,jokerConfig);assert.equal(current.players[0].ready,false);
  assert.equal(current.game,null);assert.equal(current.revision,first.body.view.revision+1);
});
