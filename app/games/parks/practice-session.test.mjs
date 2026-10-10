import test from 'node:test';
import assert from 'node:assert/strict';
import { createParksPracticeSession } from './practice-session.mjs';
import { createParksPractice,decodeParksPractice,parksPracticeView } from './practice-engine.mjs';

const key='synthetic-parks-local';
const options={configuration:{mode:'solo',camping:true,volunteerCount:2,passionChoice:'choose'},seed:12345,requestId:()=> 'a'.repeat(32)};
function fixture({raw=null,writable=true}={}) {
  const log={writes:0,reads:0,views:[],failures:[]};let readFail=false,writeFailure=null;
  const storage={raw,getItem(){log.reads++;if(readFail)throw new Error('read unavailable');return this.raw;},setItem(_key,value){log.writes++;if(writeFailure==='before')throw new Error('write unavailable');this.raw=value;if(writeFailure==='after')throw new Error('response lost after save');}};
  const session=createParksPracticeSession({storage,key,canWrite:()=>writable,onView:(view,context)=>log.views.push({view,context}),onFailure:value=>log.failures.push(value)});
  return {session,storage,log,setReadFail:value=>{readFail=value;},setWriteFailure:value=>{writeFailure=value;},setWritable:value=>{writable=value;},
    start(){assert.deepEqual(session.read(),{ok:true,empty:true});assert.equal(session.start(options).ok,true);},intent(){return parksPracticeView(session.snapshot().saved).legalActions.find(action=>!action.disabledReason).fields;}};
}
test('one valid persisted match restores exact hidden RNG, materials and next action without replaying setup',()=>{
  const f=fixture();f.start();const initial=f.storage.raw,expected=f.session.snapshot().saved;
  const resumed=fixture({raw:initial});assert.deepEqual(resumed.session.read(),{ok:true,restored:true});assert.deepEqual(resumed.session.snapshot().saved,expected);assert.equal(resumed.log.writes,0);
  const action=f.intent();assert.equal(f.session.act(action.type,action).ok,true);assert.equal(resumed.session.act(action.type,action).ok,true);assert.equal(resumed.storage.raw,f.storage.raw);
  f.session.tick(500);resumed.session.tick(500);assert.equal(resumed.storage.raw,f.storage.raw);
});
test('failed and mismatched choices change neither authoritative save, revision nor random stream',()=>{
  const f=fixture();f.start();const raw=f.storage.raw,before=f.session.snapshot().saved,valid=f.intent();
  assert.equal(f.session.act(valid.type,{...valid,targetId:'foreign-private-candidate'}).ok,false);assert.equal(f.session.act('finish-window',valid).ok,false);
  assert.equal(f.storage.raw,raw);assert.deepEqual(f.session.snapshot().saved,before);assert.equal(f.log.writes,1);
});
test('unconfirmed restart choices and their cancellation perform no writes or random work',()=>{
  const f=fixture();f.start();const raw=f.storage.raw,before=f.session.snapshot().saved;
  // A setup draft reads this clone; only the final explicit start persists it.
  const draft=f.session.snapshot();draft.saved.game.configuration.mode='standard';draft.saved.game.decks.parks.reverse();
  assert.equal(f.storage.raw,raw);assert.deepEqual(f.session.snapshot().saved,before);assert.equal(f.log.writes,1);
  assert.equal(f.session.start({...options,requestId:()=> 'b'.repeat(32)}).ok,true);assert.equal(f.session.snapshot().saved.matchId,'b'.repeat(32));assert.equal(f.log.writes,2);
});
test('suspended tabs, paused games and read-only windows never advance clocks or automatic choices',()=>{
  const f=fixture();f.start();f.session.suspend(true);let before=f.storage.raw;assert.equal(f.session.tick(500).suspended,true);assert.equal(f.storage.raw,before);
  f.session.suspend(false);assert.equal(f.session.act('pause',{}).ok,true);before=f.storage.raw;assert.equal(f.session.tick(500).suspended,true);assert.equal(f.storage.raw,before);
  assert.equal(f.session.act('resume',{}).ok,true);f.setWritable(false);before=f.storage.raw;assert.equal(f.session.tick(500).suspended,true);assert.equal(f.session.act('pause',{}).ok,false);assert.equal(f.session.start(options).ok,false);assert.equal(f.session.retryStorage().ok,false);assert.equal(f.storage.raw,before);
  assert.equal(f.session.read().ok,true);assert.equal(f.storage.raw,before);
});
test('read-only ownership rejects replacement before invoking setup randomness',()=>{
  const raw=JSON.stringify(createParksPractice(options));let calls=0,writes=0;
  const session=createParksPracticeSession({storage:{getItem:()=>raw,setItem:()=>{writes++;}},key,canWrite:()=>false,create:()=>{calls++;throw new Error('must not create');}});
  assert.equal(session.read().restored,true);assert.equal(session.start(options).ok,false);assert.equal(calls,0);assert.equal(writes,0);
});
test('compare-before-write rejects an already changed external value and does not overwrite it',()=>{
  const f=fixture();f.start();const original=f.session.snapshot().saved,other=JSON.stringify(createParksPractice({...options,requestId:()=> 'b'.repeat(32)}));f.storage.raw=other;
  const action=f.intent();assert.equal(f.session.act(action.type,action).ok,false);assert.equal(f.storage.raw,other);assert.deepEqual(f.session.snapshot().saved,original);assert.equal(f.session.snapshot().blocked,true);assert.equal(f.log.writes,1);
  assert.equal(f.session.retryStorage().ok,false);assert.equal(f.session.read().ok,true);assert.equal(f.session.snapshot().saved.matchId,'b'.repeat(32));
});
test('storage-change events block all automatic work until authoritative storage is re-read',()=>{
  const f=fixture();f.start();const original=f.storage.raw;f.session.externalChange(original);assert.equal(f.session.snapshot().blocked,false);
  f.session.externalChange(null);assert.equal(f.session.snapshot().blocked,true);assert.equal(f.session.tick(500).suspended,true);assert.equal(f.storage.raw,original);
  f.storage.raw=null;assert.deepEqual(f.session.read(),{ok:true,empty:true});assert.equal(f.session.snapshot().saved,null);assert.equal(f.session.snapshot().blocked,false);
});
test('a failed write before persistence leaves memory/RNG intact; retryStorage only unblocks and never replays the action',()=>{
  const f=fixture();f.start();const raw=f.storage.raw,before=f.session.snapshot().saved,action=f.intent();f.setWriteFailure('before');
  assert.equal(f.session.act(action.type,action).ok,false);assert.equal(f.storage.raw,raw);assert.deepEqual(f.session.snapshot().saved,before);assert.equal(f.session.snapshot().blocked,true);
  f.setWriteFailure(null);const writes=f.log.writes;assert.equal(f.session.retryStorage().ok,true);assert.equal(f.log.writes,writes);assert.equal(f.storage.raw,raw);
  assert.equal(f.session.act(action.type,action).ok,true);assert.notEqual(f.storage.raw,raw);
});
test('an unknown write after persistence is retained for reload and cannot be silently resubmitted',()=>{
  const f=fixture();f.start();const before=f.session.snapshot().saved,action=f.intent();f.setWriteFailure('after');
  assert.equal(f.session.act(action.type,action).ok,false);const committed=f.storage.raw;assert.notEqual(committed,JSON.stringify(before));assert.equal(decodeParksPractice(committed).game.revision,before.game.revision+1);
  assert.deepEqual(f.session.snapshot().saved,before);const writes=f.log.writes;assert.equal(f.session.act(action.type,action).ok,false);assert.equal(f.session.retryStorage().ok,false);assert.equal(f.log.writes,writes);
  f.setWriteFailure(null);assert.equal(f.session.read().ok,true);assert.equal(f.storage.raw,committed);assert.equal(f.session.snapshot().saved.game.revision,before.game.revision+1);
  assert.equal(f.session.act(action.type,action).ok,false);assert.equal(f.log.writes,writes);assert.match(f.log.failures[0],/未确认/);
});
test('corrupt or unreadable storage remains intact until a separately confirmed replacement',()=>{
  const f=fixture({raw:'not a saved game'});assert.equal(f.session.read().ok,false);assert.equal(f.storage.raw,'not a saved game');assert.equal(f.log.writes,0);
  assert.equal(f.session.start(options).ok,true);assert.ok(decodeParksPractice(f.storage.raw));const raw=f.storage.raw;f.setReadFail(true);assert.equal(f.session.read().ok,false);assert.equal(f.storage.raw,raw);assert.equal(f.session.tick(500).suspended,true);
});
test('callbacks and snapshots cannot mutate the session-owned saved game',()=>{
  const f=fixture();f.start();const before=f.session.snapshot().saved;f.log.views.at(-1).context.saved.game.decks.parks.reverse();f.log.views.at(-1).view.selfCandidates.reverse();assert.deepEqual(f.session.snapshot().saved,before);
});
test('destroyed sessions cannot read, publish, write or execute even after storage recovers',()=>{
  const f=fixture();f.start();const raw=f.storage.raw,counts={writes:f.log.writes,reads:f.log.reads,views:f.log.views.length};f.session.destroy();
  assert.equal(f.session.read().ok,false);assert.equal(f.session.start(options).ok,false);assert.equal(f.session.act('pause',{}).ok,false);assert.equal(f.session.retryStorage().ok,false);assert.equal(f.session.tick(500).suspended,true);f.session.externalChange('changed');
  assert.equal(f.storage.raw,raw);assert.deepEqual({writes:f.log.writes,reads:f.log.reads,views:f.log.views.length},counts);assert.equal(f.session.snapshot().saved,null);
});
