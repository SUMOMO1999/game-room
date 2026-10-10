import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm, mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSettings,safeReturnTo} from '../server/config.mjs';
import {EncryptedStore,SQLiteAdapter} from '../server/storage.mjs';
import {MockProvider} from '../server/auth.mjs';
import {createRuntime} from '../server/runtime.mjs';
import {createUnifiedServer} from '../server/unified-http.mjs';
import {createRoomStore} from './rooms.mjs';
import {createParksAdapter} from '../server/games/parks/adapter.mjs';
import {createGameRegistry} from './game-registry.mjs';
import {validateMatchSummary,validateHistoryRecord} from '../server/match-history.mjs';
import {finalResult} from './games/parks/rules/scoring.mjs';
import {randomStream} from './games/parks/practice-engine.mjs';
import {chooseParksPracticeAction} from './games/parks/practice-bot.mjs';
import {CURRENT_DATA_COMPATIBILITY,compareReleaseCompatibility} from '../scripts/release-compatibility.mjs';

async function fixture(t,{enabled=true,serverRandomInt:naturalRandom}={}) {
  const directory=await mkdtemp(join(tmpdir(),'parks-http-')),path=join(directory,'synthetic.sqlite'),key=randomBytes(32),servers=[];
  let at=10000;const now=()=>at;
  async function open() {
    const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock',GAME_ROOM_PARKS_ENABLED:enabled?'1':'0'});
    const storage=new EncryptedStore(new SQLiteAdapter(path,{now}),key,now),provider=new MockProvider(settings,{now});
    provider.complete=async()=>({issuer:'urn:parks-platform-http',sub:provider.member,accessToken:'synthetic-parks-server-only-token',expiresAt:now()+3600000});
    provider.check=async identity=>({sub:identity.sub});
    const runtime=createRuntime(settings,{storage,provider,now,roomOptions:{pollIntervalMs:0,serverRandomInt:naturalRandom ?? (n=>n-1)},chatOptions:{pollIntervalMs:0}});
    const server=createUnifiedServer(runtime);server.listen(0,'127.0.0.1');await once(server,'listening');servers.push(server);
    const base=`http://127.0.0.1:${server.address().port}`;settings.origin=base;settings.callback=`${base}/auth/callback`;settings.postLogout=`${base}/`;
    async function request(path,member={},body) {
      const response=await fetch(base+path,{redirect:'manual',method:body===undefined?'GET':'POST',headers:{...(member.cookie?{Cookie:member.cookie}:{}),...(body===undefined?{}:{Origin:base,'X-CSRF-Token':member.csrf,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const text=await response.text();return {status:response.status,headers:response.headers,body:text?JSON.parse(text):null,text};
    }
    async function login(sub) {provider.member=sub;const start=await request('/auth/login'),location=new URL(start.headers.get('location'));
      const callback=await request(location.pathname+location.search,{cookie:start.headers.getSetCookie()[0].split(';')[0]});assert.equal(callback.status,303);
      const member={cookie:callback.headers.getSetCookie().find(value=>value.startsWith(settings.cookieName+'=')).split(';')[0]};const state=await request('/api/state',member);return {...member,csrf:state.body.csrf,state:state.body};}
    const view=async(code,member)=>{const response=await request(`/api/rooms/${code}`,member);assert.equal(response.status,200,response.text);return response.body.view;};
    async function action(code,member,fields) {const current=await view(code,member);const body={...fields,expectedRevision:current.revision,requestId:randomUUID()};return request(`/api/rooms/${code}/actions`,member,body);}
    async function listen(code,member) {
      const abort=new AbortController(),response=await fetch(`${base}/api/rooms/${code}/events`,{headers:{Cookie:member.cookie},signal:abort.signal});assert.equal(response.status,200);
      const reader=response.body.getReader(),decoder=new TextDecoder(),packets=[],waiters=new Set();let buffer='';
      const reading=(async()=>{for(;;){const {done,value}=await reader.read();if(done)return;buffer+=decoder.decode(value,{stream:true});let end;
        while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const raw=/^data: (.+)$/m.exec(frame)?.[1];if(raw){const packet=JSON.parse(raw);packets.push(packet);for(const accept of [...waiters])accept(packet);}}}})();reading.catch(()=>{});
      const stream={packets,wait(predicate){const old=packets.find(predicate);if(old)return Promise.resolve(old);return new Promise((resolve,reject)=>{
        const accept=value=>{if(predicate(value)){clearTimeout(timer);waiters.delete(accept);resolve(value);}},timer=setTimeout(()=>{waiters.delete(accept);reject(new Error('PARKS SSE view missing'));},3000);waiters.add(accept);});},
        async close(){abort.abort();await reader.cancel().catch(()=>{});await reading.catch(()=>{});}};
      t.after(()=>stream.close());return stream;
    }
    return {settings,runtime,server,base,request,login,view,action,listen,close:async()=>{server.closeAllConnections();await server.shutdown();servers.splice(servers.indexOf(server),1);}};
  }
  t.after(async()=>{for(const server of [...servers]){server.closeAllConnections();await server.shutdown();}await rm(directory,{recursive:true,force:true});});
  return {open,advance:ms=>{at+=ms;}};
}
const config=(mode,extra={})=>({mode,camping:false,volunteerCount:0,passionChoice:'random',...extra});
async function start(f,members,configuration) {
  const created=await f.request('/api/rooms',members[0],{name:'玩家1',gameType:'parks',requestId:randomUUID(),initialConfiguration:{parksConfig:configuration}});assert.equal(created.status,201,created.text);
  const code=created.body.roomCode;
  for(let index=1;index<members.length;index++){const joined=await f.request(`/api/rooms/${code}/join`,members[index],{name:`玩家${index+1}`,requestId:randomUUID()});assert.equal(joined.status,201,joined.text);}
  for(const member of members)assert.equal((await f.action(code,member,{type:'ready',ready:true})).status,200);
  const running=await f.action(code,members[0],{type:'start'});assert.equal(running.status,200,running.text);return {code,view:running.body.view};
}
test('PARKS flag requires unified identity, restores known games when disabled and declares schema15 without new backup scopes',async t=>{
  assert.throws(()=>readSettings({GAME_ROOM_AUTH_MODE:'legacy',GAME_ROOM_PARKS_ENABLED:'1'}),/unified/);
  assert.throws(()=>readSettings({GAME_ROOM_AUTH_MODE:'mock',GAME_ROOM_PARKS_ENABLED:'true'}),/explicit/);
  assert.equal(safeReturnTo('/parks.html?code=123456','https://example.test'),'/parks.html?code=123456');
  const f=await(await fixture(t,{enabled:false})).open(),member=await f.login('disabled');assert.equal(member.state.parksEnabled,false);assert.ok(f.runtime.gameRegistry.knownTypes().includes('parks'));assert.ok(!f.runtime.gameRegistry.creationTypes().includes('parks'));
  assert.equal((await f.request('/api/rooms',member,{name:'玩家',gameType:'parks',requestId:'disabled-create'})).status,400);
  assert.equal(CURRENT_DATA_COMPATIBILITY.backupScopes.write.length,18);assert.ok(CURRENT_DATA_COMPATIBILITY.roomSnapshots.read.includes(15));assert.ok(CURRENT_DATA_COMPATIBILITY.roomSnapshots.write.includes(15));
  const base={format:1,project:'game-room',releaseId:'a'.repeat(20),containsSecrets:false,containsUserData:false};const old=structuredClone(CURRENT_DATA_COMPATIBILITY);old.roomSnapshots.read=old.roomSnapshots.read.filter(value=>value!==15);old.roomSnapshots.write=old.roomSnapshots.write.filter(value=>value!==15);
  assert.deepEqual(compareReleaseCompatibility({...base,dataCompatibility:CURRENT_DATA_COMPATIBILITY},{...base,releaseId:'b'.repeat(20),dataCompatibility:old}),{forwardCompatible:true,rollbackCompatible:false,initial:false,priorLegacy:false});
});
test('real HTTP config and seats enforce solo/Teddy limits, reject forged actions, and keep spectator passion choices private',async t=>{
  const f=await(await fixture(t)).open(),a=await f.login('a'),b=await f.login('b'),observer=await f.login('observer');assert.equal(a.state.parksEnabled,true);
  const solo=await start(f,[a],config('solo',{camping:true,volunteerCount:4,passionChoice:'choose'}));assert.equal(solo.view.minPlayers,1);assert.equal(solo.view.maxPlayers,1);assert.equal(solo.view.game.selfCandidates.length,2);
  const late=await f.request(`/api/rooms/${solo.code}/join`,b,{name:'朋友',role:'player',requestId:'over-solo'});assert.equal(late.status,201);assert.equal(late.body.view.selfRole,'spectator');assert.equal(late.body.view.game.players.length,1);
  const joined=await f.request(`/api/rooms/${solo.code}/join`,observer,{name:'观众',role:'spectator',requestId:'observe'});assert.equal(joined.status,201);assert.deepEqual(joined.body.view.game.selfCandidates,[]);assert.deepEqual(joined.body.view.game.legalActions,[]);
  const legal=solo.view.game.legalActions[0].fields;
  assert.equal((await f.action(solo.code,observer,legal)).status,403);assert.equal((await f.action(solo.code,a,{...legal,serverRandomInt:0})).status,400);
  const before=await f.view(solo.code,a);assert.equal((await f.action(solo.code,a,{...legal,targetId:'not-own-candidate'})).status,409);assert.equal((await f.view(solo.code,a)).game.revision,before.game.revision);
  const ownerStream=await f.listen(solo.code,a),observerStream=await f.listen(solo.code,observer);
  const chosen=await f.action(solo.code,a,legal);assert.equal(chosen.status,200,chosen.text);assert.deepEqual(chosen.body.view.game.selfCandidates,[]);
  const privatePacket=await ownerStream.wait(packet=>packet.revision===chosen.body.view.revision),publicPacket=await observerStream.wait(packet=>packet.revision===chosen.body.view.revision);
  assert.equal(privatePacket.selfRole,'player');assert.equal(publicPacket.selfRole,'spectator');assert.deepEqual(publicPacket.game.legalActions,[]);assert.deepEqual(publicPacket.game.selfCandidates,[]);
  for(const packets of [ownerStream.packets,observerStream.packets])for(const secret of ['userKey','tokenHash','synthetic-parks-server-only-token','"decks"'])assert.equal(JSON.stringify(packets).includes(secret),false);
  await ownerStream.close();await observerStream.close();
  const teddy=await start(f,[a,b],config('teddy',{camping:true,volunteerCount:2}));assert.equal(teddy.view.minPlayers,2);assert.equal(teddy.view.maxPlayers,2);assert.equal(teddy.view.game.teddy.enabled,true);
  const frozen=(await f.runtime.storage.read('rooms',teddy.view.roomId)).value.snapshot;assert.equal(frozen.schemaVersion,15);assert.equal(frozen.game.players.length,2);
});
test('decision timeout pauses same materials; only responsible seat resumes and SQLite restart preserves pending window',async t=>{
  const owner=await fixture(t),f=await owner.open(),a=await f.login('a'),b=await f.login('b');const running=await start(f,[a,b],config('standard',{passionChoice:'choose'}));
  const before=running.view,memberViews=await Promise.all([f.view(running.code,a),f.view(running.code,b)]),index=memberViews.findIndex(view=>view.selfId===before.game.window.responsibleSeatId),members=[a,b];
  owner.advance(1800001);await f.runtime.rooms.sweep();members[0]=await f.login('a');members[1]=await f.login('b');const paused=await f.view(running.code,members[index]);assert.equal(paused.phase,'paused');assert.equal(paused.turnClock.version,4);assert.equal(paused.turnClock.deadlineAt,null);assert.equal(paused.game.window.pauseCause,'timeout');
  assert.deepEqual(paused.game.selfCandidates,memberViews[index].game.selfCandidates);assert.deepEqual(paused.game.markets,before.game.markets);assert.equal(paused.matchId,before.matchId);
  assert.equal((await f.action(running.code,members[1-index],{type:'resume'})).status,403);
  const frozen=(await f.runtime.storage.read('rooms',paused.roomId)).value.snapshot;await f.close();const restarted=await owner.open(),again=await restarted.login(index===0?'a':'b');const restored=await restarted.view(running.code,again);
  assert.equal(restored.phase,'paused');assert.equal(restored.game.window.id,paused.game.window.id);assert.deepEqual(restored.game.selfCandidates,paused.game.selfCandidates);
  assert.deepEqual((await restarted.runtime.storage.read('rooms',paused.roomId)).value.snapshot,frozen);
  const resumed=await restarted.action(running.code,again,{type:'resume'});assert.equal(resumed.status,200,resumed.text);assert.equal(resumed.body.view.phase,'playing');assert.equal(resumed.body.view.game.window.id,paused.game.window.id);assert.equal(resumed.body.view.turnClock.remainingMs,1800000);
});
test('solo history4 accepts actual score basis, preserves completed outcome and rejects economic/private or forged rank fields',()=>{
  const adapter=createParksAdapter(),registry=createGameRegistry([adapter]);const store=createRoomStore({gameRegistry:registry,now:()=>1000,serverRandomInt:n=>n-1});
  const created=store.createTrustedRoom('1'.repeat(64),'玩家',{code:'123456',roomId:'a'.repeat(32),gameType:'parks',initialConfiguration:{parksConfig:config('solo')}});
  let view=created.view;for(const fields of [{type:'ready',ready:true},{type:'start'}])view=store.trustedAction(created.roomCode,'1'.repeat(64),{...fields,requestId:fields.type,expectedRevision:view.revision}).view;
  const game=store.exportSnapshot(created.roomCode).game,result=finalResult(game,1000),summary={matchId:game.matchId,roomId:'a'.repeat(32),roomCode:'123456',game:'parks',ruleVersion:game.ruleVersion,startedAt:1000,endedAt:1000,status:'completed',reason:result.reason,...adapter.historySummary(game),players:[{userKey:'1'.repeat(64),seatId:created.playerId,nickname:'玩家',...adapter.playerResult(result,created.playerId)}]};
  assert.equal(validateMatchSummary(summary,{gameRegistry:registry}),summary);validateHistoryRecord({schemaVersion:4,summary},{gameRegistry:registry});assert.equal(summary.players[0].outcome,'completed');
  for(const change of [value=>value.deltas=[],value=>value.players[0].hand=[],value=>value.players[0].soloRank='Trailblazer',value=>value.parksSummary.configuration.mode='standard']){const forged=structuredClone(summary);change(forged);assert.throws(()=>validateMatchSummary(forged,{gameRegistry:registry}));}store.close();
});
test('solo departure commits one real schema4 outbox, and SQLite restart archives it without fictitious wins or identity leaks',async t=>{
  const owner=await fixture(t),f=await owner.open(),a=await f.login('outbox-owner');const running=await start(f,[a],config('solo',{camping:true,volunteerCount:4}));
  f.runtime.rooms.setHistory({archive:async()=>{throw new Error('synthetic history outage');}});
  const left=await f.action(running.code,a,{type:'leave'});assert.equal(left.status,200,left.text);assert.equal(left.body.left,true);
  const saved=(await f.runtime.storage.read('rooms',running.view.roomId)).value;assert.equal(saved.snapshot,null);assert.equal(saved.pendingRecords.length,1);assert.equal(saved.pendingRecords[0].players.length,1);assert.equal(saved.pendingRecords[0].status,'aborted');
  assert.equal((await f.request('/api/history',a)).status,503);await f.close();
  const restored=await owner.open(),again=await restored.login('outbox-owner'),outsider=await restored.login('outsider');const history=await restored.request('/api/history',again);
  assert.equal(history.status,200,history.text);assert.equal(history.body.items.length,1);assert.equal(history.body.stats.aborted,1);assert.equal(history.body.stats.completed,0);assert.equal(history.body.stats.wins,0);
  assert.equal(history.body.items[0].game,'parks');assert.equal(history.body.items[0].self.outcome,'unscored');assert.equal(history.body.items[0].parksSummary.configuration.volunteerCount,4);
  assert.deepEqual((await restored.runtime.storage.read('rooms',running.view.roomId)).value.pendingRecords,[]);
  const records=await restored.runtime.storage.scan('game-history');assert.equal(records.length,1);assert.equal(records[0].value.schemaVersion,4);
  assert.equal((await restored.request('/api/history',again)).body.items.length,1);assert.deepEqual((await restored.request('/api/history',outsider)).body.items,[]);
  for(const secret of ['userKey','seatId','issuer','synthetic-parks-server-only-token','"decks"','selfCandidates'])assert.equal(history.text.includes(secret),false);
});
test('PARKS saved envelopes reject mode, participant ownership, clock and schema drift while authentic schema15 restores unchanged',()=>{
  const adapter=createParksAdapter(),registry=createGameRegistry([adapter]),settings={gameRegistry:registry,now:()=>1000,serverRandomInt:n=>n-1};const store=createRoomStore(settings);
  const created=store.createTrustedRoom('1'.repeat(64),'玩家',{code:'123456',roomId:'a'.repeat(32),gameType:'parks',initialConfiguration:{parksConfig:config('solo',{passionChoice:'choose'})}});
  let view=created.view;for(const fields of [{type:'ready',ready:true},{type:'start'}])view=store.trustedAction(created.roomCode,'1'.repeat(64),{...fields,requestId:fields.type,expectedRevision:view.revision}).view;
  const frozen=store.exportSnapshot(created.roomCode);store.close();
  for(const change of [value=>value.schemaVersion=14,value=>value.parksConfig.mode='standard',value=>value.matchParticipants[0].userKey='2'.repeat(64),value=>value.matchParticipants[0].name='changed',value=>value.turnClock.id='foreign-window',value=>value.players.push({...structuredClone(value.players[0]),id:'b'.repeat(32),userKey:'2'.repeat(64)})]){
    const forged=structuredClone(frozen);change(forged);const restore=createRoomStore(settings);assert.throws(()=>restore.importSnapshot(forged),error=>error.code==='INVALID_SNAPSHOT');restore.close();
  }
  const restored=createRoomStore(settings);restored.importSnapshot(frozen);assert.deepEqual(restored.exportSnapshot(created.roomCode),frozen);restored.close();
});
test('a real PARKS player exit tells remaining players the whole trip was aborted without score or win settlement',async t=>{
  const f=await(await fixture(t)).open(),a=await f.login('departing'),b=await f.login('remaining');
  const running=await start(f,[a,b],config('standard'));
  const left=await f.action(running.code,a,{type:'leave'});assert.equal(left.status,200,left.text);assert.equal(left.body.left,true);
  const remaining=await f.view(running.code,b);assert.equal(remaining.phase,'aborted');assert.equal(remaining.game.result.aborted,true);
  assert.deepEqual(remaining.game.result.scores,[]);assert.deepEqual(remaining.game.result.winnerIds,[]);
  const text=remaining.activity.find(value=>value.kind==='leave')?.text || remaining.activity.at(-1)?.text;
  assert.match(text,/本局中止，不计输赢或得分/);assert.doesNotMatch(text,/离席计分已确认/);
  const history=await f.request('/api/history',b);assert.equal(history.status,200,history.text);
  assert.equal(history.body.items.length,1);assert.equal(history.body.items[0].status,'aborted');assert.equal(history.body.items[0].self.outcome,'unscored');assert.equal(history.body.items[0].self.score,null);assert.equal(history.body.stats.wins,0);
});
test('fixed-seed natural solo HTTP trip completes all three seasons and archives one non-economic challenge result',async t=>{
  // Advance a realistic request cadence without disabling the production limiter.
  t.mock.timers.enable({apis:['Date'],now:10000});
  const seed=314159,rng=randomStream(seed),owner=await fixture(t,{serverRandomInt:limit=>rng.randomInt(limit)}),f=await owner.open(),member=await f.login('natural-solo');
  const configuration=config('solo',{camping:true,volunteerCount:4,passionChoice:'choose'}),running=await start(f,[member],configuration),commands=[];
  let current=running.view;
  try {
    for(let count=0;current.phase!=='finished' && count<1000;count++) {
      owner.advance(2100);t.mock.timers.tick(2100);
      const intent=chooseParksPracticeAction(current.game);
      assert.ok(intent,`no legal solo action at ${current.game.stage}/${current.game.window.kind}`);
      commands.push({revision:current.revision,stage:current.game.stage,windowId:current.game.window.id,intent});
      const committed=await f.action(running.code,member,intent);assert.equal(committed.status,200,committed.text);current=committed.body.view;
    }
    assert.equal(current.phase,'finished','bounded natural game must finish');assert.equal(current.game.season.index,2);assert.equal(current.game.result.reason,'three-seasons-complete');assert.equal(current.game.result.mode,'solo');assert.equal(current.game.result.scores.length,1);
    const history=await f.request('/api/history',member);assert.equal(history.status,200,history.text);assert.equal(history.body.items.length,1);assert.equal(history.body.stats.completed,1);assert.equal(history.body.stats.wins,0);assert.equal(history.body.stats.draws,0);assert.equal(history.body.stats.losses,0);
    const item=history.body.items[0],score=current.game.result.scores[0];assert.equal(item.matchId,current.matchId);assert.equal(item.game,'parks');assert.equal(item.self.outcome,'completed');assert.equal(item.self.score,score.score);assert.deepEqual(item.self.breakdown,score.breakdown);assert.equal(item.self.difficulty,4);
    assert.equal(item.deltas,undefined);assert.equal(item.accountGroup,undefined);assert.equal(item.self.remainingPoints,null);assert.deepEqual(item.parksSummary.configuration,configuration);
    const frozen=(await f.runtime.storage.read('rooms',current.roomId)).value.snapshot;assert.equal(frozen.schemaVersion,15);assert.deepEqual(frozen.pendingRecords,[]);
    const records=await f.runtime.storage.scan('game-history');assert.equal(records.length,1);assert.equal(records[0].value.schemaVersion,4);
    await f.close();const restarted=await owner.open(),again=await restarted.login('natural-solo');assert.equal((await restarted.request('/api/history',again)).body.items.length,1);assert.deepEqual((await restarted.runtime.storage.read('rooms',current.roomId)).value.snapshot,frozen);
    t.diagnostic(`seed=${seed}; committed=${commands.length}; seasons=3; score=${score.score}; history=1; restored=same-snapshot`);
  } catch(error) {
    // Synthetic failure artifacts retain reproducible seed/intent/state; never skip the rejected step.
    const directory='ops/parks-full-2026-10-11/platform';await mkdir(directory,{recursive:true});await writeFile(join(directory,'natural-solo-failure.json'),JSON.stringify({seed,configuration,commands,current,error:{name:error.name,message:error.message}},null,2)+'\n');throw error;
  }
});
