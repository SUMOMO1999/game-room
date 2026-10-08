import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {IdentityFailure} from '../server/auth.mjs';
import {readSettings} from '../server/config.mjs';
import {IdentityPolicyClient,IDENTITY_POLICY_ISSUER} from '../server/identity-policy-client.mjs';

const BASE=1790000000000;
const identity=index=>({issuer:IDENTITY_POLICY_ISSUER,sub:`interval-member-${index}`,
  clientId:'27oe1fs5shskll808e733lqm65',authTime:BASE/1000-20,accessToken:`interval-token-${index}`});
const policy=who=>({version:1,revokedBefore:0,issuer:who.issuer,sub:who.sub,clientId:who.clientId,authTime:who.authTime});
const unavailable=error=>error instanceof IdentityFailure&&error.status===503;
const microtasks=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
function deferred(){let resolve;const promise=new Promise(value=>{resolve=value;});return {promise,resolve};}
// Same virtual-clock semantics as identity-policy-client.test.mjs; no real wait.
function clock(){
  let time=BASE,sequence=0;const timers=new Map();
  const scheduler={setTimeout(callback,ms){const id=++sequence;timers.set(id,{callback,at:time+ms});return id;},clearTimeout(id){timers.delete(id);}};
  function advance(ms){
    const until=time+ms;
    for(;;){const next=[...timers].filter(([,entry])=>entry.at<=until).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next)break;timers.delete(next[0]);time=next[1].at;next[1].callback();}
    time=until;
  }
  return {scheduler,now:()=>time,advance,count:()=>timers.size};
}
function fixture(fetcher,intervalMs){
  const time=clock();
  return {time,adapter:new IdentityPolicyClient({fetcher,now:time.now,scheduler:time.scheduler,
    ...(intervalMs===undefined?{}:{intervalMs})})};
}

test('interval selection accepts only numeric125/250 and exact Cognito non-batch env opt-in',()=>{
  for(const intervalMs of [125,250])assert.doesNotThrow(()=>new IdentityPolicyClient({intervalMs}));
  assert.doesNotThrow(()=>new IdentityPolicyClient());
  for(const intervalMs of [0,124,126,125.5,NaN,Infinity,'125','250',null])
    assert.throws(()=>new IdentityPolicyClient({intervalMs}),TypeError,`constructor rejects ${String(intervalMs)}`);
  const env={GAME_ROOM_AUTH_MODE:'cognito',GAME_ROOM_CLIENT_ID:'intervaltestclient01'};
  assert.equal(readSettings(env).identityCheckIntervalMs,250);
  assert.equal(readSettings({...env,GAME_ROOM_IDENTITY_CHECK_INTERVAL_MS:'250'}).identityCheckIntervalMs,250);
  assert.equal(readSettings({...env,GAME_ROOM_IDENTITY_CHECK_INTERVAL_MS:'125'}).identityCheckIntervalMs,125);
  assert.equal(readSettings({...env,GAME_ROOM_IDENTITY_CHECK_INTERVAL_MS:'125',GAME_ROOM_IDENTITY_BATCH_ENABLED:'0'}).identityCheckIntervalMs,125);
  for(const value of [0,125,250,NaN,'0','124','126','0125','125.0',' 125','125 ','NaN','',null])
    assert.throws(()=>readSettings({...env,GAME_ROOM_IDENTITY_CHECK_INTERVAL_MS:value}),`config rejects ${String(value)}`);
  for(const mode of ['mock','legacy','disabled'])
    assert.throws(()=>readSettings({...env,GAME_ROOM_AUTH_MODE:mode,GAME_ROOM_IDENTITY_CHECK_INTERVAL_MS:'125'}));
  const batch={...env,GAME_ROOM_IDENTITY_BATCH_ENABLED:'1',GAME_ROOM_IDENTITY_BATCH_KEY_ID:'interval-test',GAME_ROOM_IDENTITY_BATCH_KEY_FILE:'/owned-local-fixture/signing.pem'};
  assert.equal(readSettings(batch).identityCheckIntervalMs,250);
  assert.throws(()=>readSettings({...batch,GAME_ROOM_IDENTITY_CHECK_INTERVAL_MS:'125'}));
});

test('three distinct subjects actually dispatch at125ms opt-in and unchanged250ms default',async()=>{
  for(const intervalMs of [125,undefined]){
    const starts=[],step=intervalMs??250;
    const {adapter,time}=fixture(async(_url,options)=>{
      starts.push(time.now()-BASE);const index=Number(options.headers.Authorization.split('interval-token-')[1]);
      return Response.json(policy(identity(index)));
    },intervalMs);
    const pending=[0,1,2].map(index=>adapter.check(identity(index)));
    assert.deepEqual(starts,[0]);
    time.advance(step-1);assert.deepEqual(starts,[0]);time.advance(1);assert.deepEqual(starts,[0,step]);
    time.advance(step-1);assert.deepEqual(starts,[0,step]);time.advance(1);
    assert.deepEqual(await Promise.all(pending),[0,1,2].map(index=>policy(identity(index))));
    assert.deepEqual(starts,[0,step,step*2]);assert.equal(time.count(),0);
  }
});

test('125ms burst retains the original four-second queue cutoff without admitting expired slots',async()=>{
  const starts=[];
  const {adapter,time}=fixture(async(_url,options)=>{
    starts.push(time.now()-BASE);const index=Number(options.headers.Authorization.split('interval-token-')[1]);
    return Response.json(policy(identity(index)));
  },125);
  const pending=Array.from({length:34},(_,index)=>adapter.check(identity(index))),done=Promise.allSettled(pending);
  time.advance(3999);await microtasks();assert.equal(starts.length,32);
  time.advance(1);const results=await done;
  assert.deepEqual(starts,Array.from({length:32},(_,index)=>index*125));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,32);
  assert.equal(results.filter(x=>x.status==='rejected').length,2);
  assert.ok(results.filter(x=>x.status==='rejected').every(x=>unavailable(x.reason)));
  assert.equal(time.count(),0);
});

test('125ms total deadline stays eight seconds from enqueue and late replies cannot revive a newer check',async()=>{
  const replies=[deferred(),deferred(),deferred()],signals=[];
  const {adapter,time}=fixture((_url,options)=>{signals.push(options.signal);return replies[signals.length-1].promise;},125);
  const first=adapter.check(identity(0)),second=adapter.check(identity(1));
  const failed=Promise.all([assert.rejects(first,unavailable),assert.rejects(second,unavailable)]);
  time.advance(124);assert.equal(signals.length,1);time.advance(1);assert.equal(signals.length,2);
  time.advance(7874);await microtasks();assert.ok(signals.every(signal=>!signal.aborted));
  time.advance(1);await failed;assert.ok(signals.every(signal=>signal.aborted));assert.equal(time.count(),0);
  const newer=adapter.check(identity(0));assert.equal(signals.length,3);
  replies[0].resolve(Response.json(policy(identity(0))));replies[1].resolve(Response.json(policy(identity(1))));await microtasks();
  assert.equal(adapter.check(identity(0)),newer,'late old cleanup preserves the newer in-flight authorization');
  assert.equal(signals.length,3);replies[2].resolve(Response.json(policy(identity(0))));
  assert.deepEqual(await newer,policy(identity(0)));assert.equal(time.count(),0);
});

test('125ms completion is not cached, cancellation cannot revive old checks and unknown outcome never retries',async()=>{
  const oldReply=deferred(),newReply=deferred(),signals=[];
  const {adapter,time}=fixture((_url,options)=>{
    signals.push(options.signal);
    if(signals.length===1)return Promise.resolve(Response.json(policy(identity(0))));
    if(signals.length===2)return oldReply.promise;
    if(signals.length===3)return newReply.promise;
    throw new Error('unknown synthetic transport outcome');
  },125);
  assert.deepEqual(await adapter.check(identity(0)),policy(identity(0)));
  const oldSignal=new AbortController(),old=adapter.check(identity(0),{signal:oldSignal.signal});
  assert.equal(signals.length,1);time.advance(125);assert.equal(signals.length,2,'completed success must cause a new dispatch');
  const cancelled=assert.rejects(old,unavailable);oldSignal.abort();await cancelled;
  assert.equal(signals[1].aborted,true);assert.equal(getEventListeners(oldSignal.signal,'abort').length,0);
  const newer=adapter.check(identity(0));time.advance(125);assert.equal(signals.length,3);
  oldReply.resolve(Response.json(policy(identity(0))));await microtasks();
  assert.equal(adapter.check(identity(0)),newer);assert.equal(signals.length,3);
  newReply.resolve(Response.json(policy(identity(0))));await newer;
  const unknown=adapter.check(identity(1)),rejected=assert.rejects(unknown,unavailable);
  time.advance(125);await rejected;assert.equal(signals.length,4);
  time.advance(8000);await microtasks();assert.equal(signals.length,4,'unknown dispatch is not automatically replayed');
  assert.equal(time.count(),0);
});
