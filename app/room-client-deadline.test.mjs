import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient, api } from './room-client.mjs';
import { accountState, accountGeneration, loadAccount } from './account-client.mjs';
const CODE='123456', USER='a'.repeat(64);
const AUTH={mode:'mock',loginReady:true,authenticated:true,userKey:USER,csrf:'synthetic-csrf',profile:{nickname:'合成玩家'},recentRooms:[]};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
const view=(revision,receipts)=>({roomCode:CODE,roomId:'b'.repeat(32),selfId:'self',revision,phase:'playing',...(receipts?{actionReceipts:receipts}:{})});
const deferred=()=>{let resolve;const promise=new Promise(accept=>{resolve=accept;});return {promise,resolve};};
const settle=async()=>{for(let index=0;index<8;index++)await new Promise(resolve=>setImmediate(resolve));};
function clock(t){let at=0,serial=0;const pending=new Map();
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{const id=++serial;pending.set(id,{at:at+delay,callback});return id;});
  t.mock.method(globalThis,'clearTimeout',id=>pending.delete(id));
  return {pending,tick(ms){at+=ms;for(const [id,item]of [...pending])if(item.at<=at&&pending.has(id)){pending.delete(id);item.callback();}}};
}
async function fixture(t){t.mock.method(globalThis,'fetch',async()=>json(AUTH));await loadAccount();const timers=clock(t),connections=[],errors=[],views=[];
  const client=new RoomClient(CODE,{playerId:'self'},{onView:value=>views.push(value),onConnection:value=>connections.push(value),onError:error=>errors.push(error)});
  t.after(()=>client.stop());client.receive(view(4));return {client,timers,connections,errors,views};
}
function openStream(revision){let controller;const body=new ReadableStream({start(value){controller=value;}});
  controller.enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify(view(revision))}\n\n`));
  return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
}
test('ordinary successful request cancels its deadline and keeps the same verified identity',async t=>{
  const f=await fixture(t),epoch=accountGeneration();t.mock.method(globalThis,'fetch',async()=>json({view:view(5)}));
  assert.equal((await f.client.refresh()).revision,5);assert.equal(f.timers.pending.size,0);assert.equal(accountGeneration(),epoch);assert.equal(f.client.requests.size,0);
});
test('a write that never answers times out at ten seconds and reconciles with one read without replaying the POST',async t=>{
  const f=await fixture(t),pending=deferred(),calls=[],epoch=accountGeneration();
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return options.method==='POST'?pending.promise:json({view:view(5)});});
  const result=f.client.action('draw');const rejected=assert.rejects(result,error=>error.code==='ROOM_REQUEST_TIMEOUT'&&!error.status);
  await settle();f.timers.tick(9999);await settle();assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,false);
  f.timers.tick(1);await rejected;assert.deepEqual(calls.map(call=>call.options.method),['POST','GET']);assert.equal(calls[0].options.signal.aborted,true);
  assert.equal(f.client.view.revision,5);assert.equal(f.client.requests.size,0);assert.equal(f.timers.pending.size,0);assert.equal(accountGeneration(),epoch);
  pending.resolve(json({view:view(99)}));await settle();assert.equal(f.client.view.revision,5);
});
test('an unanswered response body is bounded, conceals private state and allows a fresh verified read-only recovery',async t=>{
  const f=await fixture(t),pending=deferred();let signal;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{signal=options.signal;return {ok:true,status:200,json:()=>pending.promise};});
  const reading=f.client.refresh(),rejected=assert.rejects(reading,error=>error.status===503&&error.code==='ROOM_REQUEST_TIMEOUT');await settle();f.timers.tick(10000);await rejected;
  assert.equal(signal.aborted,true);assert.equal(accountState().verification,'unavailable');assert.equal(f.client.stopped,true);
  t.mock.method(globalThis,'fetch',async()=>json(AUTH));await loadAccount();const restored=new RoomClient(CODE,{playerId:'self'},{onView(){},onConnection(){},onError(){}});t.after(()=>restored.stop());
  const calls=[];t.mock.method(globalThis,'fetch',async(_url,options)=>{calls.push(options.method);return json({view:view(6)});});assert.equal((await restored.refresh()).revision,6);assert.deepEqual(calls,['GET']);
  pending.resolve({view:view(99)});await settle();assert.equal(restored.view.revision,6);assert.equal(accountState().verification,'verified');
});
test('a real HTTP503 keeps its existing identity failure path and does not replay an action',async t=>{
  const f=await fixture(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return json({error:'服务暂时无法核验。'},503);});
  await assert.rejects(f.client.action('draw'),error=>error.status===503);assert.equal(calls,1);assert.equal(accountState().verification,'unavailable');assert.equal(f.timers.pending.size,0);
});
test('an unanswered SSE handshake reopens read-only after two seconds and a retired late response cannot repaint',async t=>{
  const f=await fixture(t),pending=deferred(),calls=[],epoch=accountGeneration();
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return calls.length===1?pending.promise:openStream(6);});
  f.client.connect();await settle();assert.equal(f.connections.at(-1),'connecting');f.timers.tick(10000);await settle();
  assert.equal(f.connections.at(-1),'offline');assert.equal(calls[0].options.signal.aborted,true);assert.equal(f.errors.length,0);assert.equal(accountGeneration(),epoch);
  f.timers.tick(2000);await settle();assert.equal(calls.length,2);assert.equal(f.connections.at(-1),'online');assert.equal(f.client.view.revision,6);
  pending.resolve(openStream(99));await settle();assert.equal(f.client.view.revision,6);assert.ok(calls.every(call=>!call.options.method));
});
test('a known rejected SSE status with an unanswered JSON body stays bounded and preserves its private failure semantics',async t=>{
  for(const status of [401,503]){
    const f=await fixture(t),pending=deferred();let calls=0;
    t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:false,status,json:()=>pending.promise};});
    f.client.connect();await settle();f.timers.tick(10000);await settle();assert.equal(calls,1);assert.equal(f.errors.at(-1).status,status);
    assert.equal(accountState().verification,status===503?'unavailable':'anonymous');assert.equal(f.client.stopped,true);assert.equal(f.timers.pending.size,0);
    pending.resolve({error:'迟到错误'});await settle();assert.equal(calls,1);
  }
});
test('stop interrupts a handshake whose fetch ignores abort and never schedules a replacement stream',async t=>{
  const f=await fixture(t),pending=deferred();let signal,calls=0;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{calls++;signal=options.signal;return pending.promise;});f.client.connect();await settle();f.client.stop();await settle();
  assert.equal(signal.aborted,true);assert.equal(f.timers.pending.size,0);pending.resolve(openStream(99));await settle();f.timers.tick(20000);await settle();assert.equal(calls,1);assert.equal(f.client.view.revision,4);
});
test('a timed-out flying write retains its exact intent until an owning receipt or an explicit identical retry',async t=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),values=new Map();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}});
  t.after(()=>old?Object.defineProperty(globalThis,'sessionStorage',old):delete globalThis.sessionStorage);
  const f=await fixture(t);f.client.receive(view(4,[]));const pending=deferred(),bodies=[];let retry=false;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{if(options.method==='POST'){const body=JSON.parse(options.body);bodies.push(body);return retry?json({view:view(5,[{requestId:body.requestId,status:'committed'}])}):pending.promise;}return json({view:view(4,[])});});
  const result=f.client.action('roll'),rejected=assert.rejects(result,/尚未确认/);await settle();f.timers.tick(10000);await rejected;
  assert.equal(bodies.length,1);assert.deepEqual(f.client.pendingAction(),bodies[0]);assert.equal(f.client.actionInFlight,false);
  retry=true;await f.client.retryAction();assert.equal(bodies.length,2);assert.deepEqual(bodies[1],bodies[0]);assert.equal(f.client.pendingAction(),null);
  pending.resolve(json({view:view(99,[])}));await settle();assert.equal(f.client.view.revision,5);
});

test('exported api has one overall deadline across a delayed fetch and an unanswered response body',async t=>{
  const f=await fixture(t),headers=deferred(),body=deferred();let signal;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{signal=options.signal;return headers.promise;});
  const reading=api(`/api/rooms/${CODE}`),rejected=assert.rejects(reading,error=>error.status===503&&error.code==='ROOM_REQUEST_TIMEOUT');await settle();
  assert.equal(f.timers.pending.size,1);f.timers.tick(6000);headers.resolve({ok:true,status:200,json:()=>body.promise});await settle();
  f.timers.tick(3999);await settle();assert.equal(signal.aborted,false);f.timers.tick(1);await rejected;assert.equal(signal.aborted,true);assert.equal(f.timers.pending.size,0);
});
test('exported api respects external abort immediately and its retired401 cannot invalidate a newer account',async t=>{
  const f=await fixture(t),pending=deferred(),controller=new AbortController();let signal;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{signal=options.signal;return pending.promise;});
  const reading=api(`/api/rooms/${CODE}`,{signal:controller.signal}),rejected=assert.rejects(reading,error=>error.name==='AbortError');await settle();
  controller.abort();await rejected;assert.equal(signal.aborted,true);assert.equal(f.timers.pending.size,0);
  t.mock.method(globalThis,'fetch',async()=>json({...AUTH,userKey:'d'.repeat(64),csrf:'new-identity-csrf'}));await loadAccount();const epoch=accountGeneration();
  pending.resolve(json({error:'old failed read'},401));await settle();assert.equal(accountGeneration(),epoch);assert.equal(accountState().userKey,'d'.repeat(64));assert.equal(accountState().failureStatus,null);
});

test('exported api preserves known401 and503 headers when either read or write JSON hangs and never poisons a newer login',async t=>{
  for(const status of [401,503])for(const method of ['GET','POST']){
    const f=await fixture(t),pending=deferred(),calls=[];
    t.mock.method(globalThis,'fetch',async(_url,options)=>{calls.push(options);return {ok:false,status,json:()=>pending.promise};});
    const result=api(`/api/rooms/${CODE}${method==='POST'?'/actions':''}`,{method,...(method==='POST'?{body:{type:'draw',requestId:'same-intent',expectedRevision:4}}:{})});
    const rejected=assert.rejects(result,error=>error.status===status&&error.code==='ROOM_REQUEST_TIMEOUT');await settle();f.timers.tick(10000);await rejected;
    assert.equal(calls.length,1);assert.equal(calls[0].signal.aborted,true);assert.equal(f.client.stopped,true);
    assert.equal(accountState().verification,status===401?'anonymous':'unavailable');assert.equal(accountState().authenticated,false);assert.equal(f.timers.pending.size,0);
    t.mock.method(globalThis,'fetch',async()=>json({...AUTH,userKey:'e'.repeat(64),csrf:'new-after-timeout'}));await loadAccount();const epoch=accountGeneration();
    pending.resolve({error:'retired body'});await settle();assert.equal(accountGeneration(),epoch);assert.equal(accountState().userKey,'e'.repeat(64));assert.equal(accountState().failureStatus,null);
  }
});
test('known403 and429 body timeouts retain their rejection status without invalidating identity, while success200 writes remain unconfirmed',async t=>{
  for(const status of [403,429,200]){
    const f=await fixture(t),epoch=accountGeneration(),pending=deferred();let calls=0;
    t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:status===200,status,json:()=>pending.promise};});
    const result=api(`/api/rooms/${CODE}/actions`,{method:'POST',body:{type:'draw',requestId:'unchanged',expectedRevision:4}});
    const rejected=assert.rejects(result,error=>error.code==='ROOM_REQUEST_TIMEOUT'&&(status===200?!error.status:error.status===status));await settle();f.timers.tick(10000);await rejected;
    assert.equal(calls,1);assert.equal(accountGeneration(),epoch);assert.equal(accountState().verification,'verified');assert.equal(f.client.stopped,false);
    pending.resolve({view:view(99)});await settle();assert.equal(f.client.view.revision,4);assert.equal(accountGeneration(),epoch);
  }
});
