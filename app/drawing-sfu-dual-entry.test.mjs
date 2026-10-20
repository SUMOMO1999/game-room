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
import {createRoomVoiceService} from '../server/room-voice-service.mjs';
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
  const runtime = createRuntime(settings,{ storage,provider,now,drawingEnabled:true,roomOptions:{pollIntervalMs:0,...roomOptions} });
  const media=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('{}');});media.listen(0,'127.0.0.1');await once(media,'listening');t.after(()=>new Promise(r=>media.close(r)));
  const voice=createRoomVoiceService({apiKey:'test-key',secret:'synthetic-sfu-dual-entry-only-secret',media:{remove:async()=>{},close:async()=>{}}});serverOptions={...serverOptions,voiceHub:voice,voiceOrigin:'http://127.0.0.1:'+media.address().port};
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
  return {voice,entries,settings,runtime,provider,request,json,login,server};
}

test('SFU stays under both configured entries; mounted cookie is independent and admin is never public',async t=>{
 const f=await fixture(t),direct=await f.login('direct','voice-user'),mounted=await f.login('agora','voice-user');
 const created=await f.json('direct','/api/rooms',{method:'POST',...direct,body:{name:'本人',gameType:'draw-and-guess',requestId:randomUUID()}});assert.equal(created.response.status,201);const code=created.body.roomCode;
 assert.equal((await f.json('agora','/api/rooms/'+code,mounted)).response.status,200);
 const readers=[],controllers=[];t.after(async()=>{for(const c of controllers)c.abort();await Promise.allSettled(readers.map(r=>r.cancel()));});
 for(const [entry,member]of [['direct',direct],['agora',mounted]]){const cancel=new AbortController();controllers.push(cancel);const response=await f.request(entry,`/api/rooms/${code}/events`,{...member,signal:cancel.signal});assert.equal(response.status,200);const reader=response.body.getReader();readers.push(reader);await reader.read();
  const result=await f.json(entry,`/api/rooms/${code}/voice/join`,{method:'POST',...member,body:{clientId:randomUUID()}});assert.equal(result.response.status,200,JSON.stringify(result.body));const html=await f.request(entry,'/drawing.html',member),csp=html.headers.get('content-security-policy');assert(csp.includes("connect-src 'self' "+f.entries.find(e=>e.id===entry).origin.replace('http:','ws:')+(entry==='agora'?'/game':'')+'/voice/;'));const other=await f.request(entry,'/room.html',member);assert.equal(other.headers.get('content-security-policy').includes('ws:'),true);const expected=f.entries.find(e=>e.id===entry);assert.equal(result.body.url,expected.origin.replace('http:','ws:')+(entry==='agora'?'/game':'')+'/voice');
  const path='/voice/rtc/v1/validate?access_token='+encodeURIComponent(result.body.token);assert.equal((await f.request(entry,path,member)).status,200);
  const wrong={cookie:member.cookie.replace(entry==='agora'?'game-room-agora-session':f.settings.cookieName,entry==='agora'?f.settings.cookieName:'game-room-agora-session')};assert.equal((await f.request(entry,path,wrong)).status,401);
  assert.equal((await f.request(entry,'/voice/twirp/livekit.RoomService/ListRooms',member)).status,404);
  const leave=await f.json(entry,`/api/rooms/${code}/voice/leave`,{method:'POST',...member,body:{id:result.body.id,clientId:JSON.parse(Buffer.from(result.body.token.split('.')[1],'base64url')).sub}});assert.equal(leave.response.status,409,'unrelated terminal identifier cannot act as client nonce');
 }
});
