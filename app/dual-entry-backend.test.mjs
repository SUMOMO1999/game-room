import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { EncryptedStore, MemoryAdapter } from '../server/storage.mjs';
import { MockProvider, CognitoProvider, IdentityFailure } from '../server/auth.mjs';
import { makeEntries, entryReturnTo, resolveEntry, recordMatchesEntry } from '../server/entry-context.mjs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import * as oidc from 'openid-client';
import { SHARED_ISSUER } from '../server/config.mjs';

async function fixture(t,{serverOptions={},roomOptions={},now=Date.now}={}) {
  const settings = readSettings({ GAME_ROOM_AUTH_MODE:'mock', GAME_ROOM_ORIGIN:'http://127.0.0.1:39071' });
  const entries = [{ id:'direct', origin:settings.origin, basePath:'/' }, { id:'agora', origin:'http://127.0.0.1:39072', basePath:'/game/' }];
  const storage = new EncryptedStore(new MemoryAdapter({now}), randomBytes(32),now);
  const provider = new MockProvider(settings,{now}); provider.member='a';provider.callbackUrls=[];
  const originalBegin=provider.begin.bind(provider), originalComplete=provider.complete.bind(provider);
  provider.begin=async(...args)=>{const result=await originalBegin(...args);result.transaction.member=provider.member;return result;};
  provider.complete=async(url,transaction)=>{provider.callbackUrls.push(url.href);const result=await originalComplete(url,transaction);return {...result,sub:transaction.member};};
  const runtime = createRuntime(settings,{ storage,provider,now,roomOptions:{pollIntervalMs:0,...roomOptions} });
  const server = createUnifiedServer({...runtime, entries, ...serverOptions});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>server.shutdown());
  async function request(entry,path,{ method='GET',cookie='',csrf,body,headers={},signal }={}) {
    const config=entries.find(value=>value.id===entry), mount=config.basePath==='/'?'':config.basePath.slice(0,-1);
    const requestHeaders={ Host:new URL(config.origin).host,
      ...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{Origin:config.origin}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),
      ...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers };
    return new Promise((resolve,reject)=>{
      const outgoing=http.request(base+mount+path,{method,headers:requestHeaders,signal},incoming=>{
        const responseHeaders=new Headers();for(let index=0;index<incoming.rawHeaders.length;index+=2)responseHeaders.append(incoming.rawHeaders[index],incoming.rawHeaders[index+1]);
        resolve(new Response(Readable.toWeb(incoming),{status:incoming.statusCode,headers:responseHeaders}));
      });outgoing.on('error',reject);outgoing.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  async function json(entry,path,options) { const response=await request(entry,path,options);return {response,body:await response.json()}; }
  async function login(entry,member,returnTo='/') {
    provider.member=member;
    const begin=await request(entry,'/auth/login?returnTo='+encodeURIComponent(returnTo));assert.equal(begin.status,303);
    const tx=begin.headers.getSetCookie()[0].split(';')[0], callbackUrl=new URL(begin.headers.get('location'));
    const prefix=entry==='agora'?'/game':'';
    assert.equal(callbackUrl.pathname,prefix+'/auth/callback');
    const callback=await request(entry,callbackUrl.pathname.slice(prefix.length)+callbackUrl.search,{cookie:tx});
    assert.equal(callback.status,303);
    const name=entry==='agora'?'game-room-agora-session':settings.cookieName;
    const cookie=callback.headers.getSetCookie().find(value=>value.startsWith(name+'=')).split(';')[0];
    const {body:state}=await json(entry,'/api/state',{cookie});assert.equal(state.authenticated,true);
    return {cookie,csrf:state.csrf,state,callback,tx};
  }
  return {entries,settings,runtime,provider,request,json,login,server};
}

test('same runtime supports both entries, preserves full callback URL and restores the same seat',async t=>{
  const f=await fixture(t),direct=await f.login('direct','a','/?room=123456'),mounted=await f.login('agora','a','/army.html?code=123456');
  assert.equal(mounted.callback.headers.get('location'),'/game/army.html?code=123456');
  assert.equal(f.provider.callbackUrls[1].split('?')[0],'http://127.0.0.1:39072/game/auth/callback');
  assert.equal(direct.state.userKey,mounted.state.userKey);assert.notEqual(direct.cookie,mounted.cookie);
  const created=await f.json('direct','/api/rooms',{method:'POST',...direct,body:{name:'伙伴',gameType:'army-flip',requestId:randomUUID()}});
  assert.equal(created.response.status,201);
  const code=created.body.roomCode,restored=await f.json('agora',`/api/rooms/${code}`,mounted);
  assert.equal(restored.body.view.selfId,created.body.playerId);assert.equal(restored.body.view.roomId,created.body.view.roomId);
  const recent=await f.json('agora','/api/state',mounted);assert.equal(recent.body.recentRooms[0].roomCode,code);
  for(const path of ['/', '/army.html','/room.html','/practice.html','/entry-path.mjs','/army-room.mjs','/manifest.webmanifest','/sw.js','/icons/icon-192.png']) {
    assert.equal((await f.request('agora',path)).status,200,path);assert.equal((await f.request('direct',path)).status,200,path);
  }
});

test('per-entry cookie and transaction binding prevents borrowing and keeps project logout isolated',async t=>{
  const f=await fixture(t),direct=await f.login('direct','a'),mounted=await f.login('agora','a');
  const borrowed=direct.cookie.replace(f.settings.cookieName,'game-room-agora-session');
  assert.equal((await f.json('agora','/api/state',{cookie:borrowed})).body.authenticated,false);
  assert.equal((await f.json('direct','/api/state',direct)).body.authenticated,true,'wrong-entry probe must not revoke original session');
  const newMount=await f.request('agora','/auth/login'),newUrl=new URL(newMount.headers.get('location'));
  const newTx=newMount.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await f.request('agora','/auth/callback'+newUrl.search,{cookie:newTx+'; '+borrowed})).status,303);
  assert.equal((await f.json('direct','/api/state',direct)).body.authenticated,true,'mounted login rotation must not revoke a borrowed direct cookie');
  assert.equal((await f.request('agora','/api/profile',{method:'PUT',...mounted,body:{nickname:'bad'},headers:{Origin:f.settings.origin}})).status,403);
  assert.equal((await f.request('agora','/auth/logout',{method:'POST',...mounted})).status,200);
  assert.equal((await f.json('agora','/api/state',mounted)).body.authenticated,false);
  assert.equal((await f.json('direct','/api/state',direct)).body.authenticated,true);
  const begin=await f.request('direct','/auth/login'), url=new URL(begin.headers.get('location'));
  const tx=begin.headers.getSetCookie()[0].split(';')[0].replace(f.settings.transactionCookieName,'game-room-agora-transaction');
  const denied=await f.request('agora','/auth/callback'+url.search,{cookie:tx});
  assert.equal(denied.status,303);assert.match(denied.headers.get('location'),/^\/game\/\?login=retry/);
});

test('cross-entry room changes and chat are streamed by the same actual SSE hub',async t=>{
  const f=await fixture(t),a=await f.login('direct','a'),aMounted=await f.login('agora','a'),b=await f.login('direct','b');
  const created=await f.json('direct','/api/rooms',{method:'POST',...a,body:{name:'甲',requestId:randomUUID()}}),code=created.body.roomCode;
  const controller=new AbortController();t.after(()=>controller.abort());
  const stream=await f.request('agora',`/api/rooms/${code}/events`,{...aMounted,signal:controller.signal});assert.equal(stream.status,200);
  const reader=stream.body.getReader();let buffered='';
  async function until(predicate) {
    const timeout=setTimeout(()=>controller.abort(),3000);try {
      while(true) {const packet=await reader.read();if(packet.done)throw new Error('SSE closed');buffered+=new TextDecoder().decode(packet.value);if(predicate(buffered))return buffered;}
    } finally {clearTimeout(timeout);}
  }
  await until(text=>text.includes('event: view'));
  const joined=await f.json('direct',`/api/rooms/${code}/join`,{method:'POST',...b,body:{name:'乙',requestId:randomUUID()}});assert.equal(joined.response.status,201);
  await until(text=>text.includes('乙'));
  const sent=await f.json('direct',`/api/rooms/${code}/chat`,{method:'POST',...b,body:{text:'来自原入口',requestId:randomUUID()}});assert.equal(sent.response.status,200);
  const events=await until(text=>text.includes('来自原入口'));assert.ok(events.includes('event: chat'));assert.ok(!events.includes('synthetic-local-only'));
  controller.abort();
});

test('fixed Host/mount ignore forwarding headers and HTTPS entry cookies keep __Host root rules',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('agora','/',{headers:{Host:'untrusted.invalid','X-Forwarded-Host':'127.0.0.1:39072'}})).status,403);
  assert.equal((await f.request('agora','/',{headers:{'X-Forwarded-Host':'evil.invalid','X-Forwarded-Proto':'https'}})).status,200);
  const entries=makeEntries(f.settings,[{id:'agora',origin:'https://agora.sumomoli.com',basePath:'/game/'}]);
  assert.equal(entries[0].cookieName,'__Host-game-room-agora-session');assert.equal(entries[0].callback,'https://agora.sumomoli.com/game/auth/callback');
});

test('mounted OAuth uses the full external callback during real library code exchange with synthetic signed tokens',async()=>{
  const pair=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey);jwk.kid='mount-local-key';
  const settings={issuer:SHARED_ISSUER,authDomain:'https://synthetic-token.example',clientId:'ownclient12345678',callback:'https://game.sumomoli.com/auth/callback'};
  const provider=new CognitoProvider(settings,{jwks:createLocalJWKSet({keys:[jwk]})});
  const entry={callback:'https://agora.sumomoli.com/game/auth/callback'},start=await provider.begin('/',{entry});
  assert.equal(new URL(start.url).searchParams.get('redirect_uri'),entry.callback);
  const seconds=Math.floor(Date.now()/1000),sign=claims=>new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(pair.privateKey);
  const id=await sign({iss:SHARED_ISSUER,aud:settings.clientId,sub:'synthetic-mount-member',iat:seconds,exp:seconds+3600,nonce:start.transaction.nonce,token_use:'id'});
  const access=await sign({iss:SHARED_ISSUER,client_id:settings.clientId,sub:'synthetic-mount-member',iat:seconds,auth_time:seconds,exp:seconds+1800,scope:'openid',token_use:'access'});
  let exchange;
  provider.config[oidc.customFetch]=async(_url,options)=>{exchange=new URLSearchParams(options.body);return new Response(JSON.stringify({id_token:id,access_token:access,token_type:'Bearer',expires_in:1800}),{headers:{'Content-Type':'application/json'}});};
  const callback=new URL(entry.callback);callback.searchParams.set('state',start.transaction.state);callback.searchParams.set('code','synthetic-code');
  assert.equal((await provider.complete(callback,start.transaction)).sub,'synthetic-mount-member');
  assert.equal(exchange.get('redirect_uri'),entry.callback);assert.equal(exchange.get('code_verifier'),start.transaction.codeVerifier);
});

test('mounted begin and logout recover after clearing a foreign transaction cookie while its original transaction remains usable',async t=>{
  for (const route of ['begin','logout']) {
    const f=await fixture(t),mount=await f.login('agora','a');
    const begun=await f.request('direct','/auth/login'),callbackUrl=new URL(begun.headers.get('location'));
    const directTx=begun.headers.getSetCookie()[0].split(';')[0],transactionId=directTx.slice(directTx.indexOf('=')+1);
    const mountedForeignTx=directTx.replace(f.settings.transactionCookieName,'game-room-agora-transaction');
    const denied=await f.request('agora',route==='begin'?'/auth/login':'/auth/logout',{
      ...(route==='logout'?{method:'POST',csrf:mount.csrf}:{}),cookie:mount.cookie+'; '+mountedForeignTx });
    assert.equal(denied.status,401,route);
    const cleared=denied.headers.getSetCookie();
    assert.ok(cleared.some(value=>value.startsWith('game-room-agora-transaction=;') && value.includes('Max-Age=0')),route+' clears current transaction cookie');
    assert.ok(cleared.every(value=>!value.startsWith('game-room-agora-session=')),route+' cannot clear a newer current-entry session cookie after an old failure');
    assert.ok(cleared.every(value=>!value.startsWith(f.settings.transactionCookieName+'=')),route+' never clears foreign entry cookie');
    assert.equal((await f.runtime.storage.get('transactions',transactionId)).phase,'pending',route+' never consumes/cancels foreign transaction');
    const recovered=await f.login('agora','a');assert.equal(recovered.state.authenticated,true,route+' recovers after browser cookie clear');
    const originalCallback=await f.request('direct',callbackUrl.pathname+callbackUrl.search,{cookie:directTx});
    assert.equal(originalCallback.status,303,route+' original direct callback remains usable');
    assert.ok(originalCallback.headers.getSetCookie().some(value=>value.startsWith(f.settings.cookieName+'=')));
  }
});

test('trusted entry definitions reject insecure production, invalid mounts and explicit empty configuration',()=>{
  const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock'});
  const direct={id:'direct',origin:settings.origin,basePath:'/'},mount={id:'agora',origin:'http://127.0.0.1:39072',basePath:'/game/'};
  assert.equal(makeEntries(settings)[0].direct,true);
  for(const entries of [[],{},null,[direct,direct],[{...mount,id:'direct'}],[{...mount,basePath:'/'}],[{...direct,origin:'http://localhost:9999'}],[{...mount,origin:'http://evil.invalid'}],[{...mount,origin:'http://127.0.0.1:39072/#escape'}]]) assert.throws(()=>makeEntries(settings,entries));
  assert.throws(()=>makeEntries({...settings,production:true},[mount]),/HTTPS/);
  assert.throws(()=>createUnifiedServer({settings,sessions:{},rooms:{},entries:[mount]}),/direct/);
  const secure=makeEntries({...settings,production:true},[{...mount,origin:'https://agora.sumomoli.com'}])[0];
  assert.equal(secure.cookieName,'__Host-game-room-agora-session');assert.equal(secure.secureCookies,true);
  assert.ok(Object.isFrozen(secure));
});

test('logical and external mounted invite return paths are normalized once and unsafe paths return only to the current entry',async t=>{
  const f=await fixture(t),entry=makeEntries(f.settings,f.entries)[1];
  for(const route of ['/room.html?code=123456','/game/room.html?code=123456']) {
    const login=await f.login('agora','a',route);assert.equal(login.callback.headers.get('location'),'/game/room.html?code=123456');
  }
  assert.equal(entryReturnTo('/game/?room=123456',entry),'/?room=123456');
  for (const route of ['/poker414.html?code=123456', '/game/poker414.html?code=123456']) {
    const login = await f.login('agora', 'a', route);
    assert.equal(login.callback.headers.get('location'), '/game/poker414.html?code=123456');
  }
  const direct = await f.login('direct', 'a', '/poker414.html?code=123456');
  assert.equal(direct.callback.headers.get('location'), '/poker414.html?code=123456');
  for(const route of ['/game/game/room.html?code=123456','https://game.sumomoli.com/room.html?code=123456','https://evil.invalid/game/','//evil.invalid','/game//evil.invalid','/game/room.html?code=123456&code=654321','/game/../room.html?code=123456','/game/room.html?code=%31%32%33%34%35%36']) {
    const login=await f.login('agora','a',route);assert.equal(login.callback.headers.get('location'),'/game/',route);
  }
});

test('legacy records without entryKey remain usable only at the original entry and foreign probes do not alter them',async t=>{
  const f=await fixture(t),direct=await f.login('direct','a');
  const id=direct.cookie.slice(direct.cookie.indexOf('=')+1),record=await f.runtime.storage.read('sessions',id);
  delete record.value.entryKey;assert.equal(await f.runtime.storage.replaceCAS('sessions',id,record.version,record.value,record.expiresAt),true);
  assert.equal((await f.json('direct','/api/state',direct)).body.authenticated,true);
  const borrowed=direct.cookie.replace(f.settings.cookieName,'game-room-agora-session');
  assert.equal((await f.json('agora','/api/state',{cookie:borrowed})).body.authenticated,false);
  assert.ok(await f.runtime.storage.get('sessions',id));
  const begin=await f.request('direct','/auth/login'),url=new URL(begin.headers.get('location')),tx=begin.headers.getSetCookie()[0].split(';')[0],txId=tx.slice(tx.indexOf('=')+1);
  const pending=await f.runtime.storage.read('transactions',txId);delete pending.value.entryKey;delete pending.value.identityAnchor;
  assert.equal(await f.runtime.storage.replaceCAS('transactions',txId,pending.version,pending.value,pending.expiresAt),true);
  const denied=await f.request('agora','/auth/callback'+url.search,{cookie:tx.replace(f.settings.transactionCookieName,'game-room-agora-transaction')});
  assert.equal(denied.status,303);assert.equal((await f.runtime.storage.get('transactions',txId)).phase,'pending');
  assert.equal((await f.request('direct','/auth/callback'+url.search,{cookie:tx})).status,303);
  const entries=makeEntries(f.settings,f.entries);
  assert.equal(recordMatchesEntry({entryKey:null},entries[0]),false);assert.equal(recordMatchesEntry({},entries[0]),true);assert.equal(recordMatchesEntry({},entries[1]),false);
});

test('path and duplicate authority headers fail before entry binding or URL normalization',async t=>{
  const f=await fixture(t),entries=makeEntries(f.settings,f.entries),headers={host:new URL(f.entries[1].origin).host};
  for(const url of ['/game//ignored/api/state','/game/../api/state','/game/%252fapi/state','/game/%252e%252e/api/state','/game/%ZZ/api/state','/game/api/state#ignored','//127.0.0.1:39072/game/api/state','https://127.0.0.1:39072/game/api/state','/game/\\api/state']) assert.throws(()=>resolveEntry({url,headers},entries),url);
  for(const rawHeaders of [['Host',headers.host,'hOsT',headers.host],['Host',headers.host,'Origin',f.entries[1].origin,'origin',f.entries[1].origin]]) assert.throws(()=>resolveEntry({url:'/game/api/state',headers,rawHeaders},entries));
  assert.equal((await f.request('agora','//ignored/api/state')).status,403);
  assert.equal((await f.request('agora','/%252fapi/state')).status,403);
});

test('mounted private HTTP and active SSE enforce fresh 401 and 503 without cross-entry fallbacks',async t=>{
  for(const status of [401,503]) {
    const f=await fixture(t,{serverOptions:{watchdogMs:20,heartbeatMs:100}}),direct=await f.login('direct','a'),mounted=await f.login('agora','a');
    const created=await f.json('direct','/api/rooms',{method:'POST',...direct,body:{name:'甲',requestId:randomUUID()}}),code=created.body.roomCode;
    const controller=new AbortController();t.after(()=>controller.abort());
    const response=await f.request('agora',`/api/rooms/${code}/events?preview=1`,{...mounted,signal:controller.signal});assert.equal(response.status,200);
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffered='';
    const until=async predicate=>{const timer=setTimeout(()=>controller.abort(),3000);try {while(!predicate(buffered)){const packet=await reader.read();if(packet.done)break;buffered+=decoder.decode(packet.value);}return buffered;}finally{clearTimeout(timer);}};
    await until(value=>value.includes('event: view')&&value.includes('event: preview'));
    const before=buffered,originalCheck=f.provider.check.bind(f.provider);
    f.provider.check=async identity=>{throw new IdentityFailure(status);};
    const denied=await f.json('agora',`/api/rooms/${code}`,mounted);assert.equal(denied.response.status,status);
    await until(value=>value.includes('event: closed'));
    const delta=buffered.slice(before.length);assert.match(delta,new RegExp('"status":'+status));assert.ok(!delta.includes('event: view'));assert.ok(!delta.includes('event: preview'));
    f.provider.check=originalCheck;
    assert.equal((await f.json('direct','/api/state',direct)).body.authenticated,true,'failure on mounted cookie does not invalidate the direct cookie');
    const mountedState=await f.json('agora','/api/state',mounted);assert.equal(mountedState.body.authenticated,status===503);
    controller.abort();
  }
});

test('current-entry account has priority: foreign callback preserves old session and stream, same account rotates, logout permits explicit switching',async t=>{
  const f=await fixture(t,{serverOptions:{watchdogMs:20,heartbeatMs:100}}),a=await f.login('agora','a'),direct=await f.login('direct','b');
  const created=await f.json('agora','/api/rooms',{method:'POST',...a,body:{name:'甲',requestId:randomUUID()}}),code=created.body.roomCode;
  const controller=new AbortController();t.after(()=>controller.abort());
  const response=await f.request('agora',`/api/rooms/${code}/events`,{...a,signal:controller.signal});assert.equal(response.status,200);
  const reader=response.body.getReader(),first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: view/);
  async function continuation(member,cookie) {
    f.provider.member=member;
    const start=await f.request('agora','/auth/login?returnTo=%2Fgame%2Froom.html%3Fcode%3D'+code,{cookie}),url=new URL(start.headers.get('location')),tx=start.headers.getSetCookie()[0].split(';')[0];
    const txId=tx.slice(tx.indexOf('=')+1);
    const result=await f.request('agora','/auth/callback'+url.search,{cookie:cookie+'; '+tx});
    return {result,txId};
  }
  const conflict=await continuation('b',a.cookie);assert.equal(conflict.result.status,303);assert.equal(conflict.result.headers.get('location'),`/game/room.html?code=${code}&login=account`);
  assert.ok(conflict.result.headers.getSetCookie().every(cookie=>!cookie.startsWith('game-room-agora-session=')));
  assert.equal((await f.json('agora','/api/state',a)).body.userKey,a.state.userKey);
  const pending=await f.runtime.storage.get('transactions',conflict.txId);assert.equal(await f.runtime.storage.get('sessions',pending.candidateSessionId),null);
  assert.equal((await f.json('direct','/api/state',direct)).body.userKey,direct.state.userKey);
  const sent=await f.json('agora',`/api/rooms/${code}/chat`,{method:'POST',...a,body:{text:'旧会话仍可聊天',requestId:randomUUID()}});assert.equal(sent.response.status,200);
  const timer=setTimeout(()=>controller.abort(),3000);let received='';
  try {while(!received.includes('旧会话仍可聊天')) {const packet=await reader.read();if(packet.done)throw new Error('Account conflict ended the original SSE');received+=new TextDecoder().decode(packet.value);}} finally {clearTimeout(timer);}
  assert.ok(!received.includes('event: closed'));
  const same=await continuation('a',a.cookie);assert.equal(same.result.status,303);assert.equal(same.result.headers.get('location'),`/game/room.html?code=${code}`);
  const nextCookie=same.result.headers.getSetCookie().find(value=>value.startsWith('game-room-agora-session=')).split(';')[0];
  const next=await f.json('agora','/api/state',{cookie:nextCookie});assert.equal(next.body.userKey,a.state.userKey);assert.notEqual(nextCookie,a.cookie);
  assert.equal((await f.json('agora','/api/state',a)).body.authenticated,false);
  assert.equal((await f.request('agora','/auth/logout',{method:'POST',cookie:nextCookie,csrf:next.body.csrf})).status,200);
  assert.equal((await f.login('agora','b')).state.userKey,direct.state.userKey);
  controller.abort();
});

test('expired current-entry session does not prevent a newly verified account and stale callbacks cannot activate across entries',async t=>{
  let at=100000;const f=await fixture(t,{now:()=>at}),a=await f.login('agora','a');
  const id=a.cookie.slice(a.cookie.indexOf('=')+1),record=await f.runtime.storage.read('sessions',id);record.value.idleUntil=at-1;
  assert.equal(await f.runtime.storage.replaceCAS('sessions',id,record.version,record.value,record.expiresAt),true);
  f.provider.member='b';const start=await f.request('agora','/auth/login',{cookie:a.cookie}),url=new URL(start.headers.get('location')),tx=start.headers.getSetCookie()[0].split(';')[0];
  const callback=await f.request('agora','/auth/callback'+url.search,{cookie:a.cookie+'; '+tx});assert.equal(callback.status,303);
  const newCookie=callback.headers.getSetCookie().find(value=>value.startsWith('game-room-agora-session=')).split(';')[0];
  assert.notEqual((await f.json('agora','/api/state',{cookie:newCookie})).body.userKey,a.state.userKey);
  const foreign=await f.request('direct','/auth/callback'+url.search,{cookie:tx.replace('game-room-agora-transaction',f.settings.transactionCookieName)});assert.equal(foreign.status,303);
  assert.match(foreign.headers.get('location'),/^\/\?login=retry/);
});

test('begin-time identity anchor survives same-account session rotation and rejects a delayed foreign callback',async t=>{
  const f=await fixture(t),a=await f.login('agora','a');
  async function begin(member) {f.provider.member=member;const response=await f.request('agora','/auth/login',{cookie:a.cookie}),url=new URL(response.headers.get('location')),tx=response.headers.getSetCookie()[0].split(';')[0];return {url,tx};}
  const delayed=await begin('b'),same=await begin('a');
  const rotated=await f.request('agora','/auth/callback'+same.url.search,{cookie:a.cookie+'; '+same.tx});assert.equal(rotated.status,303);
  const newCookie=rotated.headers.getSetCookie().find(value=>value.startsWith('game-room-agora-session=')).split(';')[0];
  assert.equal((await f.json('agora','/api/state',a)).body.authenticated,false,'old session id has actually been removed by rotation');
  const denied=await f.request('agora','/auth/callback'+delayed.url.search,{cookie:a.cookie+'; '+delayed.tx});assert.equal(denied.status,303);assert.equal(denied.headers.get('location'),'/game/?login=account');
  assert.ok(denied.headers.getSetCookie().every(value=>!value.startsWith('game-room-agora-session=')));
  assert.equal((await f.json('agora','/api/state',{cookie:newCookie})).body.userKey,a.state.userKey);
});

test('already bound login intent never changes account when its old session expires, but a fresh post-expiry intent can',async t=>{
  let at=100000;const f=await fixture(t,{now:()=>at}),a=await f.login('agora','a');
  f.provider.member='b';const begin=await f.request('agora','/auth/login',{cookie:a.cookie}),url=new URL(begin.headers.get('location')),tx=begin.headers.getSetCookie()[0].split(';')[0];
  const id=a.cookie.slice(a.cookie.indexOf('=')+1),record=await f.runtime.storage.read('sessions',id);record.value.idleUntil=at-1;
  assert.equal(await f.runtime.storage.replaceCAS('sessions',id,record.version,record.value,record.expiresAt),true);
  const denied=await f.request('agora','/auth/callback'+url.search,{cookie:a.cookie+'; '+tx});assert.equal(denied.headers.get('location'),'/game/?login=account');
  const fresh=await f.request('agora','/auth/login',{cookie:a.cookie}),nextUrl=new URL(fresh.headers.get('location')),nextTx=fresh.headers.getSetCookie()[0].split(';')[0];
  const accepted=await f.request('agora','/auth/callback'+nextUrl.search,{cookie:a.cookie+'; '+nextTx});assert.equal(accepted.status,303);
  const newCookie=accepted.headers.getSetCookie().find(value=>value.startsWith('game-room-agora-session=')).split(';')[0];
  assert.notEqual((await f.json('agora','/api/state',{cookie:newCookie})).body.userKey,a.state.userKey);
});
