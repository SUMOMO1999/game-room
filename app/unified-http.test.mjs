import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { readSettings } from '../server/config.mjs';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { MockProvider, IdentityFailure } from '../server/auth.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createServer } from './server.mjs';

async function fixture(t,roomOptions={},serverOptions={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'game-unified-'));
  let clock=Date.now();const now=()=>clock;
  const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock'});
  const storage=new EncryptedStore(new SQLiteAdapter(path.join(directory,'test.sqlite'),{now}),randomBytes(32),now);
  const provider=new MockProvider(settings,{now});provider.member='member-a';provider.status=200;provider.checks=0;
  provider.complete=async()=>({issuer:'urn:synthetic',sub:provider.member,accessToken:'synthetic-server-only',expiresAt:clock+3600000});
  provider.check=async identity=>{provider.checks++;if(provider.status!==200) throw new IdentityFailure(provider.status);return {sub:identity.sub};};
  const runtime=createRuntime(settings,{storage,provider,now,roomOptions:{pollIntervalMs:0,...roomOptions}});
  const server=createServer({...runtime,watchdogMs:20,...serverOptions});
  t.after(async()=>{if(server.listening) await server.shutdown();else {await runtime.rooms.close();storage.close();}await rm(directory,{recursive:true,force:true});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;settings.origin=base;settings.callback=base+'/auth/callback';settings.postLogout=base+'/';
  async function request(url,{method='GET',cookie='',csrf,body,headers={}}={}) {
    const response=await fetch(base+url,{method,redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{Origin:base}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const text=await response.text();return {response,body:text?JSON.parse(text):null};
  }
  async function login(member,returnTo='/') {
    provider.member=member;
    const start=await request('/auth/login?returnTo='+encodeURIComponent(returnTo));assert.equal(start.response.status,303);
    const tx=start.response.headers.getSetCookie()[0].split(';')[0];
    const callback=await request(new URL(start.response.headers.get('location')).pathname+new URL(start.response.headers.get('location')).search,{cookie:tx});
    assert.equal(callback.response.status,303);
    const cookie=callback.response.headers.getSetCookie().find(s=>s.startsWith(settings.cookieName+'=')).split(';')[0];
    const {body:state}=await request('/api/state',{cookie});assert.equal(state.authenticated,true);
    return {cookie,csrf:state.csrf,state,callback};
  }
  async function create(member,name='朋友') {const {body,response}=await request('/api/rooms',{method:'POST',...member,body:{name,requestId:randomUUID()}});assert.equal(response.status,201);return body;}
  return {base,request,login,create,runtime,provider,tick:ms=>clock+=ms};
}

test('unified HTTP invitation return, no registration, scoped profile and trusted same-name seats',async t=>{
  const f=await fixture(t);const a=await f.login('a','/?room=123456');
  assert.equal(a.callback.response.headers.get('location'),'/?room=123456');
  const invalid=await f.request('/auth/callback?code=invalid&state=invalid');assert.equal(invalid.response.status,303);assert.equal(invalid.response.headers.get('location'),'/?login=retry');assert.equal(a.state.profile.nickname,null);assert.deepEqual(a.state.recentRooms,[]);
  const room=await f.create(a,'同昵称');assert.equal(room.token,undefined);assert.equal(room.view.players.length,1);
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`)).response.status,401);
  const b=await f.login('b');assert.equal((await f.request(`/api/rooms/${room.roomCode}`,b)).response.status,403);
  const joined=await f.request(`/api/rooms/${room.roomCode}/join`,{method:'POST',...b,body:{name:'同昵称',requestId:randomUUID()}});
  assert.equal(joined.response.status,201);assert.notEqual(joined.body.playerId,room.playerId);
  const anotherDevice=await f.login('a');const restored=await f.request(`/api/rooms/${room.roomCode}`,anotherDevice);
  assert.equal(restored.body.view.selfId,room.playerId);assert.equal(anotherDevice.state.recentRooms[0].roomCode,room.roomCode);
  assert.equal(anotherDevice.state.profile.nickname,'同昵称');
  const text=JSON.stringify(restored.body);for(const forbidden of ['synthetic-server-only','userKey','csrf','urn:synthetic','token']) assert.ok(!text.includes(forbidden));
  assert.equal((await f.request('/api/rooms',{method:'POST',...a,body:{name:'伪造',requestId:randomUUID(),userKey:b.state.userKey}})).response.status,400);
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`,{...a,headers:{Authorization:'Bearer '+'a'.repeat(43)}})).response.status,400);
  for(const route of ['/server/auth.mjs','/rooms.mjs','/specs/production-client-request.json','/../project.md']) assert.equal((await f.request(route,a)).response.status,404);
});

test('military HTTP keeps an immutable two-seat game, returns invitations and restores the same seat on another device',async t=>{
  const f=await fixture(t),a=await f.login('army-a'),b=await f.login('army-b'),outsider=await f.login('army-outsider');
  const requestId=randomUUID();
  const created=await f.request('/api/rooms',{method:'POST',...a,body:{name:'同昵称',gameType:'army-flip',requestId}});
  assert.equal(created.response.status,201);const room=created.body,code=room.roomCode;
  assert.equal(room.view.gameType,'army-flip');assert.equal(room.view.maxPlayers,2);
  const repeat=await f.request('/api/rooms',{method:'POST',...a,body:{name:'同昵称',gameType:'army-flip',requestId}});
  assert.equal(repeat.body.roomCode,code);
  assert.equal((await f.request('/api/rooms',{method:'POST',...a,body:{name:'同昵称',gameType:'rummikub',requestId}})).response.status,409);
  assert.equal((await f.request(`/api/rooms/${code}/join`,{method:'POST',...b,body:{name:'同昵称',gameType:'rummikub',requestId:randomUUID()}})).response.status,400);
  const joined=await f.request(`/api/rooms/${code}/join`,{method:'POST',...b,body:{name:'同昵称',requestId:randomUUID()}});
  assert.equal(joined.response.status,201);assert.notEqual(joined.body.playerId,room.playerId);
  assert.equal((await f.request(`/api/rooms/${code}/join`,{method:'POST',...outsider,body:{name:'旁人',requestId:randomUUID()}})).response.status,409);
  async function action(member,type,fields={}) {
    const current=await f.request(`/api/rooms/${code}`,member);
    const result=await f.request(`/api/rooms/${code}/actions`,{method:'POST',...member,body:{type,...fields,requestId:randomUUID(),expectedRevision:current.body.view.revision}});
    assert.equal(result.response.status,200,JSON.stringify(result.body));return result.body.view;
  }
  await action(a,'ready',{ready:true});await action(b,'ready',{ready:true});const started=await action(a,'start');
  assert.equal(started.game.gameType,'army-flip');assert.equal(started.game.board.filter(cell=>cell.piece?.hidden).length,50);
  for(const cell of started.game.board.filter(cell=>cell.piece?.hidden)) assert.deepEqual(cell.piece,{hidden:true});
  const member=started.game.turnPlayerId===room.playerId?a:b;
  const turnView=(await f.request(`/api/rooms/${code}`,member)).body.view;
  const first=await action(member,'flip',{cellId:turnView.game.legalFlips[0]});
  assert.equal(first.game.board.filter(cell=>cell.piece && !cell.piece.hidden).length,1);
  const restored=await f.login('army-a',`/army.html?code=${code}`);
  assert.equal(restored.callback.response.headers.get('location'),`/army.html?code=${code}`);
  const view=(await f.request(`/api/rooms/${code}`,restored)).body.view;
  assert.equal(view.selfId,room.playerId);assert.equal(view.game.revision,first.game.revision);
  assert.equal(restored.state.recentRooms[0].gameType,'army-flip');
  await action(a,'resign');
  const history=(await f.request('/api/history',a)).body.items;
  assert.equal(history[0].game,'army-flip');assert.equal(history[0].self.outcome,'loss');assert.equal(history[0].self.remainingPoints,null);
  for(const file of ['army.html','army.css','army-room.mjs','army-presentation.mjs','army-board.mjs','game-routing.mjs']) {
    const response=await fetch(f.base+'/'+file);assert.equal(response.status,200,file);
  }
  for(const file of ['army-rules.mjs','game-registry.mjs','army-rules.test.mjs']) assert.equal((await f.request('/'+file)).response.status,404,file);
});

test('unified writes require Origin and CSRF and fresh identity; outages cannot become anonymous',async t=>{
  const f=await fixture(t),a=await f.login('a');
  assert.equal((await f.request('/api/rooms',{method:'POST',cookie:a.cookie,body:{name:'甲',requestId:randomUUID()}})).response.status,403);
  assert.equal((await f.request('/api/rooms',{method:'POST',...a,headers:{Origin:'https://evil.example'},body:{name:'甲',requestId:randomUUID()}})).response.status,403);
  const room=await f.create(a),checks=f.provider.checks;f.provider.status=503;
  assert.equal((await f.request(`/api/rooms/${room.roomCode}/actions`,{method:'POST',...a,body:{type:'ready',ready:true,requestId:randomUUID(),expectedRevision:room.view.revision}})).response.status,503);
  assert.ok(f.provider.checks>checks);
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`,a)).response.status,503);
  f.provider.status=200;assert.equal((await f.request(`/api/rooms/${room.roomCode}`,a)).body.view.players[0].ready,false);
  f.provider.status=401;
  assert.equal((await f.request('/api/state',a)).body.authenticated,false);
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`,a)).response.status,401);
});

test('authenticated draw accepts only current public layout and rejects malformed, spectator and stale writes atomically',async t=>{
  const f=await fixture(t,{gameOptions:{firstTurnIndex:0,randomInt:maximum=>maximum-1}}),a=await f.login('layout-a'),b=await f.login('layout-b'),observer=await f.login('layout-observer');
  const room=await f.create(a),code=room.roomCode;
  await f.request(`/api/rooms/${code}/join`,{method:'POST',...b,body:{name:'乙',requestId:randomUUID()}});
  await f.request(`/api/rooms/${code}/join`,{method:'POST',...observer,body:{name:'旁观',role:'spectator',requestId:randomUUID()}});
  async function action(member,type,fields={}) {
    const before=(await f.request(`/api/rooms/${code}`,member)).body.view;
    return f.request(`/api/rooms/${code}/actions`,{method:'POST',...member,body:{type,...fields,requestId:randomUUID(),expectedRevision:before.revision}});
  }
  assert.equal((await action(a,'ready',{ready:true})).response.status,200);assert.equal((await action(b,'ready',{ready:true})).response.status,200);
  assert.equal((await action(a,'start')).response.status,200);
  const initial=(await f.request(`/api/rooms/${code}`,a)).body.view,played=['red-10-a','blue-10-a','black-10-a'];
  assert.equal((await action(a,'submit',{boardIds:[played],rackIds:initial.game.rack.filter(tile=>!played.includes(tile.id)).map(tile=>tile.id),boardPositions:[{x:.1,y:.2}]})).response.status,200);
  const before=(await f.request(`/api/rooms/${code}`,b)).body.view;
  assert.equal((await action(b,'draw',{boardPositions:[]})).response.status,409);
  assert.equal((await action(b,'draw',{boardPositions:[{x:.5,y:.5,rack:played}]})).response.status,409);
  assert.equal((await action(b,'draw',{boardPositions:[{x:.5,y:.5}],boardIds:[played]})).response.status,400);
  assert.equal((await action(a,'draw',{boardPositions:[{x:.5,y:.5}]})).response.status,409);
  assert.equal((await action(observer,'draw',{boardPositions:[{x:.5,y:.5}]})).response.status,403);
  assert.deepEqual((await f.request(`/api/rooms/${code}`,b)).body.view,before);
  const body={type:'draw',boardPositions:[{x:.75,y:.65}],requestId:randomUUID(),expectedRevision:before.revision};
  const draw=await f.request(`/api/rooms/${code}/actions`,{method:'POST',...b,body});assert.equal(draw.response.status,200);
  assert.equal(draw.body.view.game.rack.length,before.game.rack.length+1);assert.equal(draw.body.view.game.poolCount,before.game.poolCount-1);
  assert.deepEqual(draw.body.view.game.board,before.game.board);assert.deepEqual(draw.body.view.game.boardPositions,[{x:.75,y:.65}]);
  const replay=await f.request(`/api/rooms/${code}/actions`,{method:'POST',...b,body});assert.equal(replay.response.status,200);assert.deepEqual(replay.body.view.game,draw.body.view.game);
  const stale=await f.request(`/api/rooms/${code}/actions`,{method:'POST',...a,body:{...body,requestId:randomUUID()}});assert.equal(stale.response.status,409);
  const publicView=(await f.request(`/api/rooms/${code}`,observer)).body.view;assert.equal(publicView.game.rack,undefined);assert.deepEqual(publicView.game.boardPositions,[{x:.75,y:.65}]);
  const inherited=await action(a,'draw');assert.equal(inherited.response.status,200);assert.deepEqual(inherited.body.view.game.boardPositions,[{x:.75,y:.65}]);
});

async function openStream(f,member,roomCode) {
  const response=await fetch(`${f.base}/api/rooms/${roomCode}/events`,{headers:{Cookie:member.cookie}});assert.equal(response.status,200);
  const reader=response.body.getReader();let text='';
  async function until(predicate) {const timeout=AbortSignal.timeout(2000);while(!predicate(text)) {
    const read=reader.read();const result=await Promise.race([read,new Promise((_,reject)=>timeout.addEventListener('abort',()=>reject(new Error('SSE timeout')),{once:true}))]);
    if(result.done) break;text+=new TextDecoder().decode(result.value);
  }assert.ok(predicate(text),text);return text;}
  await until(value=>value.includes('event: view'));return {reader,until};
}

test('project logout closes private SSE but keeps the seat, other-device session and provider login',async t=>{
  const f=await fixture(t),a=await f.login('a'),room=await f.create(a),second=await f.login('a');
  const stream=await openStream(f,a,room.roomCode),before=f.provider.checks;
  const logout=await f.request('/auth/logout',{method:'POST',...a});assert.equal(logout.response.status,200);
  const text=await stream.until(value=>value.includes('event: closed'));assert.match(text,/"status":401/);await stream.reader.cancel();
  assert.equal(f.provider.checks,before);assert.equal((await f.request(`/api/rooms/${room.roomCode}`,a)).response.status,401);
  assert.equal((await f.request(`/api/rooms/${room.roomCode}`,second)).body.view.selfId,room.playerId);
  assert.ok(logout.response.headers.getSetCookie().every(value=>!value.includes('Domain=') && value.includes('Max-Age=0')));
});

test('quiet SSE detects read-cache identity outage and absolute/idle expiration without extending idle',async t=>{
  const f=await fixture(t),a=await f.login('a'),room=await f.create(a),stream=await openStream(f,a,room.roomCode);
  f.provider.status=503;f.tick(60001);
  const text=await stream.until(value=>value.includes('event: closed'));assert.match(text,/"status":503/);await stream.reader.cancel();
  f.provider.status=200;const restored=await f.login('a'),next=await openStream(f,restored,room.roomCode);f.tick(1800001);
  assert.match(await next.until(value=>value.includes('event: closed')),/"status":401/);await next.reader.cancel();
  assert.equal((await f.request('/api/state',restored)).body.authenticated,false);
  const newLogin=await f.login('a');assert.equal((await f.request(`/api/rooms/${room.roomCode}`,newLogin)).body.view.selfId,room.playerId);
});


test('public invitations accept external navigation; slow write body cannot outlive logout',async t=>{
  const f=await fixture(t),a=await f.login('a');
  const entry=await fetch(f.base+'/?room=123456',{headers:{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate'}});assert.equal(entry.status,200);await entry.text();
  assert.equal((await f.request('/api/state',{...a,headers:{'Sec-Fetch-Site':'cross-site'}})).response.status,403);
  const body=JSON.stringify({name:'迟到创建',requestId:randomUUID()});
  const pending=new Promise((resolve,reject)=>{
    const request=http.request(f.base+'/api/rooms',{method:'POST',headers:{Cookie:a.cookie,Origin:f.base,'X-CSRF-Token':a.csrf,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    request.on('error',reject);request.flushHeaders();
    f.request('/auth/logout',{method:'POST',...a}).then(result=>{assert.equal(result.response.status,200);request.end(body);}).catch(reject);
  });
  assert.equal(await pending,401);
  const again=await f.login('a');assert.deepEqual(again.state.recentRooms,[]);
});


test('clock calibration alone causes no repeated private SSE authorization; committed timeout still arrives',async t=>{
  const f=await fixture(t,{turnTimeoutMs:60000},{watchdogMs:60000}),a=await f.login('clock-a'),b=await f.login('clock-b'),room=await f.create(a);
  const code=room.roomCode;await f.request(`/api/rooms/${code}/join`,{method:'POST',...b,body:{name:'伙伴',requestId:randomUUID()}});
  async function action(member,type,fields={}) {const current=(await f.request(`/api/rooms/${code}`,member)).body.view;return f.request(`/api/rooms/${code}/actions`,{method:'POST',...member,body:{type,requestId:randomUUID(),expectedRevision:current.revision,...fields}});}
  await action(a,'ready',{ready:true});await action(b,'ready',{ready:true});await action(a,'start');
  const originalSubscribe=f.runtime.rooms.subscribe.bind(f.runtime.rooms);let deliver;
  f.runtime.rooms.subscribe=async(code,key,onView,onEnd)=>{deliver=onView;return originalSubscribe(code,key,onView,onEnd);};
  const originalAuthorize=f.runtime.sessions.authorize.bind(f.runtime.sessions);let checks=0;
  f.runtime.sessions.authorize=async(...args)=>{checks++;return originalAuthorize(...args);};
  const stream=await openStream(f,a,code),initial=(await f.runtime.rooms.getView(code,a.state.userKey)),before=checks;
  for(let i=0;i<20;i++)deliver({...initial,serverTime:initial.serverTime+i+1});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(checks,before,'timestamp-only publisher updates must not run E3 authorization');
  f.tick(60001);await f.runtime.rooms.sweep();
  const text=await stream.until(value=>(value.match(/event: view/g)||[]).length===2);
  const packets=text.split('event: view\ndata: ').slice(1).map(packet=>JSON.parse(packet.split('\n\n')[0]));
  assert.equal(packets[1].game.round,packets[0].game.round+1);assert.equal(packets[1].revision,packets[0].revision+1);
  assert.equal(packets[1].turnClock.deadlineAt,packets[1].serverTime+60000);
  assert.equal(packets.length,2);assert.ok(checks>before);await stream.reader.cancel();
});

test('real preview-enabled SSE gives player and spectator an empty safe initial baseline before live public placements and reseeds it on reconnect',async t=>{
  const f=await fixture(t,{gameOptions:{firstTurnIndex:0,randomInt:maximum=>maximum-1}},{watchdogMs:60000});
  const a=await f.login('public-a'),b=await f.login('public-b'),observer=await f.login('public-observer'),room=await f.create(a),code=room.roomCode;
  for(const [member,role] of [[b,'player'],[observer,'spectator']]) {
    const joined=await f.request(`/api/rooms/${code}/join`,{method:'POST',...member,body:{name:role,role,requestId:randomUUID()}});
    assert.equal(joined.response.status,201);
  }
  async function action(member,type,fields={}) {const current=(await f.request(`/api/rooms/${code}`,member)).body.view;return f.request(`/api/rooms/${code}/actions`,{method:'POST',...member,body:{type,requestId:randomUUID(),expectedRevision:current.revision,...fields}});}
  await action(a,'ready',{ready:true});await action(b,'ready',{ready:true});const started=(await action(a,'start')).body.view;
  const actor=started.game.turnPlayerId===room.playerId?a:b,other=actor===a?b:a;
  async function previewStream(member) {
    const response=await fetch(`${f.base}/api/rooms/${code}/events?preview=1`,{headers:{Cookie:member.cookie}});assert.equal(response.status,200);
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',packets=[];
    t.after(()=>reader.cancel().catch(()=>{}));
    async function until(count) {
      while(packets.length<count) {
        const timeout=AbortSignal.timeout(2000),result=await Promise.race([reader.read(),new Promise((_,reject)=>timeout.addEventListener('abort',()=>reject(new Error('preview SSE timeout')),{once:true}))]);
        assert.equal(result.done,false);pending+=decoder.decode(result.value,{stream:true});let at;
        while((at=pending.indexOf('\n\n'))>=0) {const text=pending.slice(0,at);pending=pending.slice(at+2);
          if(text.startsWith('event: preview\n'))packets.push(JSON.parse(text.slice('event: preview\ndata: '.length)));
        }
      }
      return packets[count-1];
    }
    return {reader,until};
  }
  const player=await previewStream(other),watcher=await previewStream(observer),emptyPlayer=await player.until(1),emptyWatcher=await watcher.until(1);
  const safeFields=['version','roomCode','roomId','matchId','gameRevision','turnPlayerId','ownerId','ownerName','previewId','sequence','expiresAt','updatedAt','observerCount','minIntervalMs','preview','clearReason'];
  for(const empty of [emptyPlayer,emptyWatcher]) {
    assert.equal(empty.preview,null);assert.ok(Object.keys(empty).every(key=>safeFields.includes(key)));
    for(const forbidden of ['rack','csrf','accessToken','userKey'])assert.equal(JSON.stringify(empty).includes(forbidden),false);
  }
  const current=(await f.request(`/api/rooms/${code}`,actor)).body.view,exposed=current.game.rack.slice(0,3).map(tile=>tile.id);
  const update=await f.request(`/api/rooms/${code}/preview`,{method:'POST',...actor,body:{previewId:'public-sound-real',sequence:1,matchId:current.matchId,gameRevision:current.game.revision,boardIds:[exposed],positions:[{x:.1,y:.2}]}});
  assert.equal(update.response.status,200,JSON.stringify(update.body));
  const livePlayer=await player.until(2),liveWatcher=await watcher.until(2);
  for(const packet of [livePlayer,liveWatcher])assert.deepEqual(packet.preview.board.flat().map(tile=>tile.id),exposed);
  await player.reader.cancel();const reconnected=await previewStream(other),snapshot=await reconnected.until(1);
  assert.deepEqual(snapshot.preview,livePlayer.preview);assert.equal(snapshot.sequence,livePlayer.sequence);
  await watcher.reader.cancel();await reconnected.reader.cancel();
});
