import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomError } from './rooms.mjs';
import { readSettings } from '../server/config.mjs';
import { IdentityFailure } from '../server/auth.mjs';
import { SessionService } from '../server/session-service.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey, opaqueId } from '../server/storage.mjs';
import { createCanvasService, CANVAS_SCOPE, canvasIdFor } from '../server/games/draw-and-guess/canvas-service.mjs';
import { createCanvasHttp } from '../server/games/draw-and-guess/canvas-http.mjs';

const roomId='a'.repeat(32),matchId='b'.repeat(32),drawer='c'.repeat(32),other='d'.repeat(32),spectator='e'.repeat(32);
const issuer='urn:synthetic-canvas-http',owner=identityKey(issuer,'drawer'),guest=identityKey(issuer,'guesser'),viewer=identityKey(issuer,'spectator');
const path='/api/rooms/123456/canvas',operation={strokeId:'stroke-1',tool:'pen',color:'#245c7c',width:4,points:[[.1,.2],[.2,.3]]};
const input=(lease,extra={})=>({deviceId:'device-a',canvasId:lease.canvasId,bootId:lease.bootId,leaseGeneration:lease.leaseGeneration,clearGeneration:0,expectedSequence:0,requestId:'first',operations:[operation],...extra});

async function fixture(t) {
  const folder=mkdtempSync(join(tmpdir(),'canvas-http-')),storage=new EncryptedStore(new SQLiteAdapter(join(folder,'records.sqlite')),randomBytes(32),()=>1000);
  const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock',GAME_ROOM_ORIGIN:'http://127.0.0.1:43127'}),authCalls=[],rates=[];
  let providerCalls=0,failureCall=null,failureStatus=null,hook=null;
  const provider={async check(identity){providerCalls++;if(hook)await hook(providerCalls);if(providerCalls===failureCall)throw new IdentityFailure(failureStatus);
    return {sub:identity.sub,issuer:identity.issuer,expiresAt:identity.expiresAt};}};
  const sessions=new SessionService(settings,{store:storage,provider,now:()=>1000}),original=sessions.authorize.bind(sessions);
  sessions.authorize=(request,options)=>{authCalls.push(options);return original(request,options);};
  await storage.put('rooms',roomId,{snapshot:{roomId,matchId,phase:'playing',game:{turnId:'dg-turn-1',stage:'drawing',turnPlayerId:drawer,stageClock:{deadlineAt:601000}},expiresAt:10000000}});
  await storage.put('room-presence',roomId,{members:{[owner]:{seatId:drawer,role:'player'},[guest]:{seatId:other,role:'player'},[viewer]:{seatId:spectator,role:'spectator'}}});
  const rooms={async getGameContext(code,userKey) {
    const record=await storage.read('rooms',roomId),presence=await storage.read('room-presence',roomId),snapshot=record.value.snapshot,member=presence.value.members[userKey];
    if(!['123456','000123'].includes(code)||!member)throw new RoomError(403,'SEAT_REQUIRED','已经离开房间。');
    return {roomId,seatId:member.seatId,role:member.role,matchId:snapshot.matchId,turnId:snapshot.game.turnId,phase:snapshot.game.stage,roomPhase:snapshot.phase,drawerSeatId:snapshot.game.turnPlayerId,
      deadline:snapshot.game.stageClock.deadlineAt,paused:snapshot.phase==='paused',expiresAt:snapshot.expiresAt,roomRecord:{version:record.version,expiresAt:record.expiresAt},
      roomGuard:{scope:'rooms',id:roomId,expectedVersion:record.version},presenceGuard:{scope:'room-presence',id:roomId,expectedVersion:presence.version,validUntil:snapshot.expiresAt}};
  }};
  const canvases=createCanvasService({storage,rooms,now:()=>1000});
  const route=createCanvasHttp({sessions,rooms,canvases,limit:(key,maximum)=>rates.push([key,maximum]),reply:(res,status,body,headers={})=>Object.assign(res,{status,body,headers}),
    readJson:async req=>{if(Buffer.byteLength(req.body)>32768)throw new RoomError(413,'BODY_TOO_LARGE','请求过大');return JSON.parse(req.body);}});
  async function session(sub='drawer') {
    const id=opaqueId(),csrf=opaqueId(),userKey=identityKey(issuer,sub);
    await storage.put('sessions',id,{phase:'active',issuer,sub,userKey,csrf,accessToken:'synthetic-only',expiresAt:601000,idleUntil:601000});return {id,csrf,userKey};
  }
  const primary=await session();
  async function request(method='GET',body,extra={}) {
    if(method==='POST'&&(extra.path??path).endsWith('/acquire')&&!extra.rawBody)body={canvasId:canvasIdFor(roomId,matchId,'dg-turn-1'),bootId:canvases.bootId,...body};
    const active=extra.session??primary,headers=new Headers({cookie:`${settings.cookieName}=${active.id}`,origin:settings.origin,'x-csrf-token':active.csrf,...extra.headers});
    const url=new URL(extra.path??path,settings.origin),webRequest={headers,url:url.href},res={};
    try {const handled=await route({req:{method,body:body===undefined?'':JSON.stringify(body)},res,url,webRequest});return {...res,handled};}
    catch(error){return {status:error.status??500,body:{error:error.message,code:error.code},error,handled:true};}
  }
  async function editRoom(change) {const record=await storage.read('rooms',roomId);change(record.value.snapshot);await storage.replaceCAS('rooms',roomId,record.version,record.value);}
  t.after(async()=>{await canvases.close();storage.close();rmSync(folder,{recursive:true,force:true});});
  return {storage,canvases,sessions,settings,request,session,primary,authCalls,rates,editRoom,get providerCalls(){return providerCalls;},
    failAt(call,status){failureCall=call;failureStatus=status;},hook(value){hook=value;}};
}

test('canvas HTTP uses two fresh real SessionService checks around every read and confirmed write',async t=>{
  const f=await fixture(t),initial=await f.request();assert.equal(initial.status,200);assert.equal(initial.body.pointCount,0);
  assert.deepEqual(f.authCalls,[{fresh:true},{fresh:true,touch:false}]);assert.equal(f.providerCalls,2);
  const lease=(await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire'})).body;
  assert.equal(lease.persisted,true);assert.equal(lease.leaseValidUntil,16000);
  const append=await f.request('POST',input(lease),{path:path+'/append'});assert.equal(append.status,200);assert.equal(append.body.ack.sequence,1);
  assert.equal((await f.storage.get(CANVAS_SCOPE,lease.canvasId)).strokes[0].points.length,2);
  assert.equal(f.providerCalls,6);assert.deepEqual(f.rates,Array.from({length:3},()=>[`canvas-user:${owner}`,180]));
  for(const secret of [owner,'synthetic-only','csrf','authorizationId','actorSeatId','requests'])assert.equal(JSON.stringify(append.body).includes(secret),false);
});

test('canvas HTTP limits paths/methods/queries and leaves unrelated routes to the BFF',async t=>{
  const f=await fixture(t);assert.equal((await f.request('GET',undefined,{path:'/api/rooms/123456'})).handled,false);
  assert.equal((await f.request('GET',undefined,{path:path+'/unknown'})).status,404);
  assert.equal((await f.request('GET',undefined,{path:path+'/append'})).headers.Allow,'POST');
  assert.equal((await f.request('POST',{},{})).headers.Allow,'GET');
  assert.equal((await f.request('GET',undefined,{path:path+'?userKey='+owner})).status,400);assert.equal(f.providerCalls,0);
  assert.equal((await f.request('GET',undefined,{path:'/api/rooms/000123/canvas'})).status,200);
  assert.equal((await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire',rawBody:true})).status,400);
});

test('a canvas request already cancelled before route setup cannot start fresh authorization work', async () => {
  let checks = 0;
  const sessions = { usesBatchIdentity: true, now: Date.now, checkWrite() {},
    async authorize(request, { context }) { context.assert(); checks++; assert.fail('closed request reached provider'); } };
  const route = createCanvasHttp({ sessions, rooms: { getGameContext() {} },
    canvases: { read() {}, invalidateAuthorization() {} }, limit() {}, reply() {}, readJson() {} });
  for (const [req, res] of [[{ method: 'GET', aborted: true }, {}], [{ method: 'GET' }, { destroyed: true }]]) {
    await assert.rejects(route({ req, res, url: new URL(path, 'http://localhost'), webRequest: new Request('http://localhost') }), error => error.status === 503);
  }
  assert.equal(checks, 0);
});

test('writes reject missing/wrong CSRF and origin without creating a canvas',async t=>{
  const f=await fixture(t);
  for(const headers of [{'x-csrf-token':''},{'x-csrf-token':'wrong'},{origin:'https://untrusted.example'}]) {
    assert.equal((await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire',headers})).status,403);
  }
  assert.equal((await f.storage.scan(CANVAS_SCOPE)).length,1);
});

test('spectators and guessers can read but cannot acquire or impersonate the drawer',async t=>{
  const f=await fixture(t);
  for(const sub of ['guesser','spectator']) {const session=await f.session(sub);
    assert.equal((await f.request('GET',undefined,{session})).status,200);
    assert.equal((await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire',session})).status,403);
  }
  for(const field of ['userKey','playerId','authorizationId','sessionId'])assert.equal((await f.request('POST',{deviceId:'device-a',[field]:owner},{path:path+'/acquire'})).status,400);
});

test('HTTP accepts only bounded batches and echoes historical receipt without double appending',async t=>{
  const f=await fixture(t),lease=(await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire'})).body;
  assert.equal((await f.request('POST',input(lease,{operations:[{...operation,points:Array.from({length:257},()=>[.1,.2])}]}),{path:path+'/append'})).status,413);
  assert.equal((await f.request('POST',input(lease,{userKey:owner}),{path:path+'/append'})).status,400);
  const first=await f.request('POST',input(lease),{path:path+'/append'}),duplicate=await f.request('POST',input(lease),{path:path+'/append'});
  assert.equal(first.body.duplicate,false);assert.equal(duplicate.body.duplicate,true);assert.equal(duplicate.body.ack.sequence,1);
  assert.equal((await f.request()).body.pointCount,2);
  const tooLarge=await f.request('POST',{deviceId:'device-a',junk:'x'.repeat(33000)},{path:path+'/acquire'});assert.equal(tooLarge.status,413);
});

test('same account in a new session cannot reuse the old writer until explicit acquire',async t=>{
  const f=await fixture(t),lease=(await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire'})).body,newSession=await f.session();
  const old=await f.request('POST',input(lease),{path:path+'/append',session:newSession});assert.equal(old.status,409);assert.equal(old.body.code,'CANVAS_STALE_WRITER');
  const acquired=await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire',session:newSession});assert.equal(acquired.body.leaseGeneration,2);
  assert.equal((await f.request('POST',input(acquired.body),{path:path+'/append',session:newSession})).status,200);
  assert.equal((await f.request('POST',input(lease),{path:path+'/append'})).status,409);
});

for(const status of [401,503])test(`fresh authorization ${status} after commit suppresses output and invalidates only the temporary writer`,async t=>{
  const f=await fixture(t),lease=(await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire'})).body;f.failAt(f.providerCalls+2,status);
  const failed=await f.request('POST',input(lease),{path:path+'/append'});assert.equal(failed.status,status);assert.equal('ack' in failed.body,false);assert.equal('strokes' in failed.body,false);
  assert.equal((await f.storage.get(CANVAS_SCOPE,lease.canvasId)).sequence,1);f.failAt(-1,503);
  const session=status===401?await f.session():f.primary;assert.equal((await f.request('GET',undefined,{session})).body.pointCount,2);
  const replay=await f.request('POST',input(lease,{requestId:'unknown-replay',expectedSequence:1}),{path:path+'/append',session});assert.equal(replay.body.code,'CANVAS_STALE_WRITER');
});

test('membership removed during the second fresh check prevents private read delivery',async t=>{
  const f=await fixture(t),session=await f.session('spectator');f.hook(async call=>{
    if(call!==2)return;const record=await f.storage.read('room-presence',roomId);delete record.value.members[viewer];await f.storage.replaceCAS('room-presence',roomId,record.version,record.value);
  });
  const result=await f.request('GET',undefined,{session});assert.equal(result.status,403);assert.equal('strokes' in result.body,false);
});

test('turn changed during the second fresh check suppresses old canvas read and acknowledgement',async t=>{
  const f=await fixture(t);f.hook(async call=>{if(call===2)await f.editRoom(snapshot=>{snapshot.game.turnId='dg-turn-2';});});
  const result=await f.request();assert.equal(result.status,409);assert.equal(result.body.code,'CANVAS_TURN_CHANGED');assert.equal('strokes' in result.body,false);
});

test('post-check account change is rejected and the previous authorization writer is invalidated',async t=>{
  const f=await fixture(t),lease=(await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire'})).body,original=f.sessions.authorize;let calls=0;
  f.sessions.authorize=async(...args)=>{const session=await original(...args);return ++calls===2?{...session,userKey:guest}:session;};
  assert.equal((await f.request()).status,401);f.sessions.authorize=original;
  const result=await f.request('POST',input(lease),{path:path+'/append'});assert.equal(result.body.code,'CANVAS_STALE_WRITER');
});

test('undo, redo and clear use the same CSRF/fresh checks and acknowledged generation contract',async t=>{
  const f=await fixture(t),lease=(await f.request('POST',{deviceId:'device-a'},{path:path+'/acquire'})).body;
  await f.request('POST',input(lease),{path:path+'/append'});
  const command=(requestId,expectedSequence)=>{const {operations,...body}=input(lease,{requestId,expectedSequence});return body;};
  for(const [action,seq,points] of [['undo',1,0],['redo',2,2],['clear',3,0]]) {
    const result=await f.request('POST',command(action,seq),{path:path+'/'+action});assert.equal(result.status,200);assert.equal(result.body.ack.sequence,seq+1);
    assert.equal((await f.request()).body.pointCount,points);
  }
  assert.equal((await f.request()).body.clearGeneration,1);
});
