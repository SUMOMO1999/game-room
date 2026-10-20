import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomSession,createRoomExit} from './platform/room-session.mjs';
import {loadPageFixture} from './test-support/load-page-fixture.mjs';

const [{fixture:rummikub},{fixture:drawing},{fixture:army},{fixture:cardRoom}]=await Promise.all([
  loadPageFixture(new URL('./account-lifecycle-ui.test.mjs',import.meta.url)),
  loadPageFixture(new URL('./draw-and-guess-boot.test.mjs',import.meta.url)),
  loadPageFixture(new URL('./army-ui.test.mjs',import.meta.url)),
  loadPageFixture(new URL('./platform/card-room-controller.test.mjs',import.meta.url)),
]);
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve,reject;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};

test('passive fence permits only verified current-source output while hidden; write/current and every invalidation remain fenced',()=>{
  const document={hidden:false};let generation=1,verification='verified',client={};
  const session=createRoomSession({document,accountGeneration:()=>generation,accountState:()=>({verification}),getClient:()=>client});
  const fence=session.capture(client);document.hidden=true;
  assert.equal(session.current(fence),false);assert.equal(session.passive(fence),true);
  verification='unavailable';assert.equal(session.passive(fence),false);verification='verified';
  generation++;assert.equal(session.passive(fence),false);generation--;
  client={};assert.equal(session.passive(fence),false);const fresh=session.capture(client);assert.equal(session.passive(fresh),true);
  session.invalidate();assert.equal(session.passive(fresh),false);const final=session.capture(client);session.destroy();assert.equal(session.passive(final),false);
});

test('actual Rummikub keeps draft and SSE across hidden periodic checks; passive view updates but no hidden draw is dispatched',async t=>{
  const f=await rummikub(t),client=f.pageAPI.client(),epoch=f.account.accountGeneration();
  f.pageAPI.move(f.pageAPI.draft().rack[0].id);const draft=f.pageAPI.draft(),reads=f.calls.filter(c=>c.url==='/api/state').length;
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.pageAPI.client(),client);assert.equal(f.streams[0].signal.aborted,false);assert.equal(f.account.accountState().verification,'verified');
  for(let i=0;i<3;i++){f.timers.tick(15000);await settle();}
  assert.equal(f.calls.filter(c=>c.url==='/api/state').length,reads+3);assert.equal(f.account.accountGeneration(),epoch);assert.equal(f.streams.length,1);
  const next=structuredClone(client.view);next.revision++;next.players[1].name='后台同步的伙伴';
  f.streams[0].controller.enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify(next)}\n\n`));await settle();
  assert.equal(client.view.revision,next.revision);assert.match(f.get('room-players').textContent,/后台同步的伙伴/);assert.deepEqual(f.pageAPI.draft(),draft);
  const writes=f.calls.filter(c=>c.options.method==='POST').length;
  for(const id of ['draw','ready-button','start-room','pause-room','resume-room'])f.get(id).dispatchEvent(new Event('click'));await settle();
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,writes);
  f.deferRoom({promise:Promise.resolve(json({view:next}))});
  const roomReads=f.calls.filter(c=>c.url==='/api/rooms/123456').length;
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await settle();
  assert.equal(f.pageAPI.client(),client);assert.equal(f.streams.length,1);assert.deepEqual(f.pageAPI.draft(),draft);
  assert.equal(f.calls.filter(c=>c.url==='/api/rooms/123456').length,roomReads+1);assert.equal(f.get('draw').disabled,false);
});

for(const status of [401,503])test(`actual Rummikub background ${status} closes the private stream and fences late output`,async t=>{
  const f=await rummikub(t),old=f.pageAPI.client();f.pageAPI.move(f.pageAPI.draft().rack[0].id);
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  f.deferState({promise:Promise.resolve(json({error:'synthetic background refusal'},status))});f.timers.tick(15000);await settle();
  assert.equal(f.account.accountState().failureStatus,status);assert.equal(f.pageAPI.client(),null);assert.equal(f.streams[0].signal.aborted,true);assert.equal(f.get('rack').children.length,0);
  const draftKeys=[...f.sessionStorage.values.keys()].filter(k=>k.startsWith('game-room.private-draft.'));
  assert.equal(draftKeys.length>0,status===503);
  old.onView({...old.view,revision:999});old.onConnection('online');await settle();assert.equal(f.pageAPI.client(),null);assert.equal(f.get('rack').children.length,0);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
});

test('actual drawing hidden room receives view SSE and preserves guess draft; a hidden submit creates no action',async t=>{
  const f=await drawing(t,{playing:true}),input=f.document.getElementById('drawing-guess-input');input.value='后台保留的纸船';input.dispatchEvent(new Event('input'));
  const calls=f.calls.filter(c=>c.endsWith('/events')).length,epoch=f.account.accountGeneration();
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  const next=f.roomView();next.revision=2;next.players[1].name='后台绘画伙伴';f.pushView(next);await settle();
  assert.equal(f.document.getElementById('drawing-gate').hidden,true);assert.match(f.document.getElementById('drawing-players').textContent,/后台绘画伙伴/);
  assert.equal(f.document.getElementById('drawing-guess-input'),input);assert.equal(input.value,'后台保留的纸船');
  assert.equal(f.document.getElementById('drawing-guess-send').disabled,true);
  f.document.getElementById('drawing-guess-form').dispatchEvent(new Event('submit',{cancelable:true}));await settle();assert.equal(f.actions.length,0);
  f.setRoomView(next);const roomReads=f.calls.filter(c=>c==='/api/rooms/123456').length;
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await settle();
  assert.equal(f.calls.filter(c=>c.endsWith('/events')).length,calls);assert.equal(f.account.accountGeneration(),epoch);assert.equal(input.value,'后台保留的纸船');
  assert.equal(f.calls.filter(c=>c==='/api/rooms/123456').length,roomReads+1);assert.equal(f.document.getElementById('drawing-guess-send').disabled,false);
});

test('actual army hidden room receives passive board metadata, denies a move, and returns on the same stream',async t=>{
  const f=await army(t),client=f.pageAPI.client(),next=structuredClone(f.pageAPI.view());
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));next.revision++;next.players[1].name='后台军棋伙伴';f.push(next);await settle();
  assert.equal(f.pageAPI.client(),client);assert.equal(f.streams[0].signal.aborted,false);assert.match(f.get('room-players').textContent,/后台军棋伙伴/);
  assert.equal(f.get('pause-room').disabled,true);
  f.pageAPI.click('r0c0');f.pageAPI.click('r1c0');await settle();assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
  f.timers.tick(15000);await settle();assert.equal(f.pageAPI.client(),client);assert.equal(f.account.accountState().verification,'verified');
  f.setView(next);const roomReads=f.calls.filter(c=>c.url==='/api/rooms/123456').length;
  f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();assert.equal(f.pageAPI.client(),client);assert.equal(f.streams.length,1);
  assert.equal(f.calls.filter(c=>c.url==='/api/rooms/123456').length,roomReads+1);assert.equal(f.get('pause-room').disabled,false);
});

test('foreground confirmation re-renders a passive card view without a new server event, reconnect, write, or periodic room read',async()=>{
  const f=cardRoom();await f.start();const client=f.client(),next={...client.view,revision:2};
  f.document.hidden=true;client.receive(next);assert.equal(f.calls.views.at(-1).options.canAct,false);
  client.refreshImpl=async()=>client.receive(next);f.life().onVerified(f.state(),{reason:'periodic'});await settle();assert.equal(client.refreshes??0,0);
  f.document.hidden=false;f.life().onVerified(f.state(),{reason:'return'});await settle();
  assert.equal(client.refreshes,1);assert.equal(f.calls.views.at(-1).options.canAct,true);assert.equal(f.calls.views.at(-1).value.revision,2);
  assert.equal(client.connected,1);assert.equal(client.actions.length,0);assert.equal(client.requests.length,0);f.controller.destroy();
});

test('a background identity replacement clears the old client and never bootstraps a new private room until foreground',async t=>{
  const f=await rummikub(t),old=f.pageAPI.client();f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  const current=f.account.accountState();f.setState({...current,userKey:'b'.repeat(64),csrf:'new-background-account',profile:{nickname:'新后台账号'}});f.timers.tick(15000);await settle();
  assert.equal(old.stopped,true);assert.equal(f.pageAPI.client(),null);assert.equal(f.streams.length,1);assert.equal(f.get('rack').children.length,0);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await settle();assert.notEqual(f.pageAPI.client(),old);assert.equal(f.streams.length,2);
});

test('ordinary hide during a soft check keeps the same epoch; pagehide still retires the pending response and stream',async t=>{
  const f=await rummikub(t),old=f.pageAPI.client(),pending=deferred();f.deferState(pending);f.window.dispatchEvent(new Event('focus'));await settle();
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));assert.equal(old.stopped,false);
  const hide=new Event('pagehide');Object.defineProperty(hide,'persisted',{value:true});f.window.dispatchEvent(hide);assert.equal(old.stopped,true);assert.equal(f.get('rack').children.length,0);
  pending.resolve(json({...f.account.accountState(),authenticated:true,userKey:'a'.repeat(64),csrf:'synthetic-csrf'}));await settle();assert.equal(f.pageAPI.client(),null);assert.equal(f.get('rack').children.length,0);
});

test('actual Rummikub action sent before hidden accepts its owned ACK and releases busy without automatic replay',async t=>{
  const f=await rummikub(t),gate=deferred();f.setAction(()=>gate.promise);
  f.get('pause-room').dispatchEvent(new Event('click'));await settle();assert.equal(f.calls.filter(c=>c.url.endsWith('/actions')).length,1);
  const next=structuredClone(f.pageAPI.client().view);next.revision++;
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));gate.resolve(json({view:next}));await settle();
  assert.equal(f.calls.filter(c=>c.url.endsWith('/actions')).length,1);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await settle();f.setAction(()=>json({view:{...next,revision:next.revision+1}}));
  f.get('pause-room').dispatchEvent(new Event('click'));await settle();assert.equal(f.calls.filter(c=>c.url.endsWith('/actions')).length,2);
});

test('actual army pre-hidden action completes and releases busy while a new hidden action remains denied',async t=>{
  const f=await army(t),gate=deferred();f.setAction(()=>gate.promise);const pending=f.pageAPI.action('pause',{agree:true});await settle();
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));gate.resolve(json({view:{...f.pageAPI.view(),revision:2}}));assert.equal(await pending,true);
  assert.equal(await f.pageAPI.action('pause',{agree:false}),false);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
  f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();f.setAction(()=>json({view:{...f.pageAPI.view(),revision:3}}));
  assert.equal(await f.pageAPI.action('pause',{agree:false}),true);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,2);
});

for(const outcome of ['ack','error'])test(`real card controller clears an owned background ${outcome} without allowing new hidden writes`,async()=>{
  const f=cardRoom();await f.start();const client=f.client(),gate=deferred();client.actionImpl=()=>gate.promise;
  const pending=f.controller.act('finish-window');f.document.hidden=true;
  if(outcome==='ack'){gate.resolve(client.view);await pending;}else{gate.reject(new Error('synthetic known transport failure'));await assert.rejects(pending,/synthetic/);}
  assert.equal(f.calls.views.at(-1).options.pending,false);await assert.rejects(f.controller.act('ready',{ready:true}),/等待/);assert.equal(client.actions.length,1);
  f.document.hidden=false;client.actionImpl=async()=>client.view;await f.controller.act('ready',{ready:true});assert.equal(client.actions.length,2);f.controller.destroy();
});

for(const outcome of ['ack','error'])test(`owned explicit retry ${outcome} while hidden releases busy but never retries itself`,async()=>{
  const f=cardRoom();await f.start();const client=f.client(),gate=deferred();client.retryImpl=()=>gate.promise;
  const pending=f.controller.retry();f.document.hidden=true;if(outcome==='ack')gate.resolve();else gate.reject(new Error('synthetic retry unknown'));await pending;
  assert.equal(client.retries,1);await f.controller.retry();assert.equal(client.retries,1);
  f.document.hidden=false;client.retryImpl=async()=>{};await f.controller.retry();assert.equal(client.retries,2);f.controller.destroy();
});

for(const changed of [false,true])test(`pre-hidden explicit exit ACK ${changed?'rejects a replaced identity':'completes once without a second write'}`,async()=>{
  const document={hidden:true},gate=deferred();let epoch=1,requests=0,stopped=0,left=0;
  const client={membership:{token:null},epoch:()=>1,request:()=>{requests++;return gate.promise;},stop:()=>{stopped++;},connect(){}};
  const session=createRoomSession({document,accountGeneration:()=>epoch,accountState:()=>({verification:'verified'}),getClient:()=>client});
  const exit=createRoomExit({session,roomCode:'123456',getClient:()=>client,getView:()=>({revision:1,selfId:'self'}),forgetMembership(){},requireAcknowledgement:true,onLeft:()=>left++,requestId:()=> 'same-exit'});
  assert.equal(await exit.run(),false);assert.equal(requests,0);document.hidden=false;const pending=exit.run();document.hidden=true;assert.equal(exit.run(),pending);assert.equal(requests,1);
  if(changed)epoch++;gate.resolve({left:true});assert.equal(await pending,!changed);assert.equal(left,changed?0:1);assert.equal(stopped,changed?0:1);assert.equal(requests,1);
});
