import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MemoryAdapter, SQLiteAdapter, EncryptedStore, recordKey, opaqueId, MAX_TRANSACTION_RECORDS, MAX_TRANSACTION_BYTES } from '../server/storage.mjs';

const FOREVER=Number.MAX_SAFE_INTEGER;
function fixture(t,kind,{now=()=>1000,capacity=10000}={}) {
  const key=randomBytes(32),folder=mkdtempSync(join(tmpdir(),'storage-many-'));
  const path=join(folder,'records.sqlite');let store=new EncryptedStore(kind==='SQLite'?new SQLiteAdapter(path,{now}):new MemoryAdapter({now,capacity}),key,now);
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  return {get store(){return store;},key,path,reopen(){store.close();store=new EncryptedStore(new SQLiteAdapter(path,{now}),key,now);return store;}};
}
const change=(scope,id,expectedVersion,value,expiresAt)=>({scope,id,expectedVersion,value,...(expiresAt===undefined?{}:{expiresAt})});
const guard=(scope,id,expectedVersion,validUntil)=>({scope,id,expectedVersion,...(validUntil===undefined?{}:{validUntil})});
const invalid=promise=>assert.rejects(promise,/Invalid atomic storage transaction/);

for(const kind of ['Memory','SQLite']) {
  test(`${kind}: one atomic transaction creates content head, immutable release, owner receipt and quota`,async t=>{
    const {store}=fixture(t,kind);await store.put('wordbank-index','quota',{used:0});const quota=await store.read('wordbank-index','quota');
    assert.equal(await store.compareAndSwapMany({changes:[change('wordbank-packs','pack',null,{head:'release-1'}),
      change('wordbank-releases','release-1',null,{words:['合成词']}),change('wordbank-index','owner-request',null,{completed:true}),
      change('wordbank-index','quota',quota.version,{used:1})],guards:[]}),true);
    assert.equal((await store.get('wordbank-packs','pack')).head,'release-1');
    assert.equal((await store.get('wordbank-releases','release-1')).words[0],'合成词');
    assert.equal((await store.get('wordbank-index','owner-request')).completed,true);assert.equal((await store.get('wordbank-index','quota')).used,1);
  });

  test(`${kind}: one stale changed record rejects the whole transaction and absent output remains absent`,async t=>{
    const {store}=fixture(t,kind);await store.put('rooms','room',{turn:1});const stale=await store.read('rooms','room');
    await store.replaceCAS('rooms','room',stale.version,{turn:2});
    assert.equal(await store.compareAndSwapMany({changes:[change('rooms','room',stale.version,{turn:3}),change('draw-canvases','canvas',null,{points:[1]})]}),false);
    assert.equal((await store.get('rooms','room')).turn,2);assert.equal(await store.get('draw-canvases','canvas'),null);
  });

  test(`${kind}: absent guards fence creation, deletion is versioned, and expired rows count as logically absent`,async t=>{
    let time=1000;const {store}=fixture(t,kind,{now:()=>time});
    await store.put('draw-canvases','retired',{points:[1]},1500);time=1500;
    assert.equal(await store.compareAndSwapMany({changes:[change('draw-canvases','retired',null,{points:[2]})],guards:[guard('wordbank-index','absent',null)]}),true);
    const current=await store.read('draw-canvases','retired');
    await store.put('wordbank-index','absent',{present:true});
    assert.equal(await store.compareAndSwapMany({changes:[change('draw-canvases','retired',current.version,null)],guards:[guard('wordbank-index','absent',null)]}),false);
    assert.equal((await store.get('draw-canvases','retired')).points[0],2);
    assert.equal(await store.compareAndSwapMany({changes:[change('draw-canvases','retired',current.version,null)]}),true);
    assert.equal(await store.get('draw-canvases','retired'),null);
    assert.equal(await store.compareAndSwapMany({changes:[change('draw-canvases','retired',null,null)]}),true);
  });

  test(`${kind}: same-key guard/change may agree; duplicate changes and inconsistent overlap are rejected`,async t=>{
    const {store}=fixture(t,kind);await store.put('rooms','room',{turn:1});const current=await store.read('rooms','room');
    await invalid(store.compareAndSwapMany({changes:[change('rooms','room',current.version,{turn:2}),change('rooms','room',current.version,{turn:3})]}));
    await invalid(store.compareAndSwapMany({changes:[change('rooms','room',current.version,{turn:2})],guards:[guard('rooms','room',null)]}));
    assert.equal(await store.compareAndSwapMany({changes:[change('rooms','room',current.version,{turn:2})],
      guards:[guard('rooms','room',current.version,3000),guard('rooms','room',current.version,2500)]}),true);
  });

  test(`${kind}: malformed scope/id/version, missing value, unknown fields and unbounded record counts reject before writing`,async t=>{
    const {store}=fixture(t,kind),valid=change('draw-canvases','canvas',null,{points:[]});
    for(const item of [{...valid,scope:'rooms:forged'},{...valid,scope:'Rooms'},{...valid,scope:''},{...valid,scope:new String('rooms')},
      {...valid,id:''},{...valid,id:'bad\0id'},{...valid,id:'\ud800'},{...valid,expectedVersion:'unknown'},
      {...valid,expectedVersion:{toString:()=>opaqueId()}},{...valid,value:undefined},{...valid,value:[]},{...valid,scopeAlias:'rooms'}])
      await invalid(store.compareAndSwapMany({changes:[item]}));
    await invalid(store.compareAndSwapMany({changes:[valid],now:()=>1000}));
    await invalid(store.compareAndSwapMany({changes:[]}));
    await invalid(store.compareAndSwapMany({changes:[{...valid,value:null,expiresAt:2000}]}));
    await invalid(store.compareAndSwapMany({changes:Array.from({length:MAX_TRANSACTION_RECORDS+1},(_,i)=>change('draw-canvases',String(i),null,{points:[]}))}));
    assert.equal(await store.get('draw-canvases','canvas'),null);
  });

  test(`${kind}: global and guard deadlines reject equality without changing other records`,async t=>{
    const {store}=fixture(t,kind);await store.put('room-presence','member',{epoch:1});const presence=await store.read('room-presence','member');
    const changes=[change('draw-canvases','canvas',null,{points:[]})];
    assert.equal(await store.compareAndSwapMany({changes,validUntil:1000}),false);
    assert.equal(await store.compareAndSwapMany({changes,guards:[guard('room-presence','member',presence.version,1000)]}),false);
    assert.equal(await store.get('draw-canvases','canvas'),null);
  });

  test(`${kind}: original prerequisite expiration during commit preparation rolls back every proposed record`,async t=>{
    let phase=false,calls=0;const now=()=>phase&&++calls>=4?2000:1000;const {store}=fixture(t,kind,{now});
    await store.put('room-presence','member',{epoch:1},2000);const presence=await store.read('room-presence','member');
    phase=true;
    assert.equal(await store.compareAndSwapMany({changes:[change('draw-canvases','canvas',null,{points:[1]}),change('wordbank-index','receipt',null,{ok:true})],
      guards:[guard('room-presence','member',presence.version)]}),false);
    phase=false;assert.equal(await store.get('draw-canvases','canvas'),null);assert.equal(await store.get('wordbank-index','receipt'),null);
  });

  test(`${kind}: an overwritten or deleted prerequisite must remain live until commit`,async t=>{
    let phase=false,calls=0;const now=()=>phase&&++calls>=3?2000:1000;const {store}=fixture(t,kind,{now});
    await store.put('rooms','room',{turn:1},2000);const room=await store.read('rooms','room');phase=true;
    assert.equal(await store.compareAndSwapMany({changes:[change('rooms','room',room.version,null),change('draw-canvases','canvas',null,{points:[1]})]}),false);
    phase=false;assert.equal((await store.get('rooms','room')).turn,1);assert.equal(await store.get('draw-canvases','canvas'),null);
  });

  test(`${kind}: new record expiry and guard deadline are rechecked immediately before commit`,async t=>{
    let phase=false,calls=0;const now=()=>phase&&++calls>=4?2000:1000;const {store}=fixture(t,kind,{now});
    await store.put('rooms','room',{turn:1});const room=await store.read('rooms','room');
    phase=true;
    assert.equal(await store.compareAndSwapMany({changes:[change('draw-canvases','canvas',null,{points:[1]},2000),change('wordbank-index','receipt',null,{ok:true})],
      guards:[guard('rooms','room',room.version,2000)]}),false);
    phase=false;assert.equal(await store.get('draw-canvases','canvas'),null);assert.equal(await store.get('wordbank-index','receipt'),null);
  });

  test(`${kind}: revoked presence epoch rejects a previously prepared writer transaction`,async t=>{
    const {store}=fixture(t,kind);await store.put('room-presence','member',{epoch:1,active:true});const old=await store.read('room-presence','member');
    await store.replaceCAS('room-presence','member',old.version,{epoch:2,active:false});
    assert.equal(await store.compareAndSwapMany({changes:[change('draw-canvases','canvas',null,{points:[1]})],guards:[guard('room-presence','member',old.version)]}),false);
    assert.equal(await store.get('draw-canvases','canvas'),null);
  });

  test(`${kind}: different third-domain inventory contract uses the same mechanism without business branches`,async t=>{
    const {store}=fixture(t,kind);await store.put('inventory','remaining',{items:1});const stock=await store.read('inventory','remaining');
    assert.equal(await store.compareAndSwapMany({changes:[change('inventory','remaining',stock.version,{items:0}),change('receipts','checkout-1',null,{items:1})],
      guards:[guard('holds','exclusive',null)],validUntil:3000}),true);
    assert.equal((await store.get('inventory','remaining')).items,0);assert.equal((await store.get('receipts','checkout-1')).items,1);
  });

  test(`${kind}: existing guardedCAS still fences legacy chat against the current room`,async t=>{
    const {store}=fixture(t,kind);await store.put('rooms','room',{turn:1});const room=await store.read('rooms','room');
    assert.equal(await store.guardedCAS('room-chat','room',null,{sequence:1},FOREVER,{scope:'rooms',id:'room',version:room.version,validUntil:2000}),true);
    await store.compareAndSwapMany({changes:[change('rooms','room',room.version,{turn:2})]});
    assert.equal(await store.guardedCAS('room-chat','room',(await store.read('room-chat','room')).version,{sequence:2},FOREVER,
      {scope:'rooms',id:'room',version:room.version,validUntil:2000}),false);
  });
}

test('Memory capacity failure preserves every old record and does not partially add new ones',async t=>{
  const {store}=fixture(t,'Memory',{capacity:2});await store.put('rooms','a',{turn:1});await store.put('rooms','b',{turn:1});const a=await store.read('rooms','a');
  await assert.rejects(store.compareAndSwapMany({changes:[change('rooms','a',a.version,{turn:2}),change('draw-canvases','new',null,{points:[]})]}),/capacity/);
  assert.equal((await store.get('rooms','a')).turn,1);assert.equal(await store.get('draw-canvases','new'),null);
});

test('SQLite independent connections race the final quota with one complete winner and no losing receipt',async t=>{
  const {store,key,path}=fixture(t,'SQLite'),other=new EncryptedStore(new SQLiteAdapter(path,{now:()=>1000}),key,()=>1000);t.after(()=>other.close());
  await store.put('wordbank-index','quota',{remaining:1});const [a,b]=await Promise.all([store.read('wordbank-index','quota'),other.read('wordbank-index','quota')]);
  const [one,two]=await Promise.all([store.compareAndSwapMany({changes:[change('wordbank-index','quota',a.version,{remaining:0}),change('wordbank-index','receipt-a',null,{ok:true})]}),
    other.compareAndSwapMany({changes:[change('wordbank-index','quota',b.version,{remaining:0}),change('wordbank-index','receipt-b',null,{ok:true})]})]);
  assert.equal([one,two].filter(Boolean).length,1);assert.equal((await store.get('wordbank-index','quota')).remaining,0);
  assert.equal([await store.get('wordbank-index','receipt-a'),await store.get('wordbank-index','receipt-b')].filter(Boolean).length,1);
});

test('SQLite COMMIT failure rolls back all rows; a post-COMMIT error remains unknown rather than false success',async t=>{
  const {store}=fixture(t,'SQLite');await store.put('rooms','room',{turn:1});const room=await store.read('rooms','room'),db=store.adapter.db,exec=db.exec.bind(db);
  db.exec=statement=>{if(statement==='COMMIT')throw new Error('synthetic commit failure');return exec(statement);};
  await assert.rejects(store.compareAndSwapMany({changes:[change('rooms','room',room.version,{turn:2}),change('draw-canvases','canvas',null,{points:[1]})]}),/commit failure/);
  db.exec=exec;assert.equal((await store.get('rooms','room')).turn,1);assert.equal(await store.get('draw-canvases','canvas'),null);
  db.exec=statement=>{const result=exec(statement);if(statement==='COMMIT')throw new Error('synthetic post-commit response loss');return result;};
  await assert.rejects(store.compareAndSwapMany({changes:[change('rooms','room',room.version,{turn:2}),change('draw-canvases','canvas',null,{points:[1]})]}),/response loss/);
  db.exec=exec;assert.equal((await store.get('rooms','room')).turn,2);assert.equal((await store.get('draw-canvases','canvas')).points.length,1);
});

test('SQLite partial statement failure rolls back earlier inserts and overwrites',async t=>{
  const {store}=fixture(t,'SQLite');await store.put('rooms','room',{turn:1});const room=await store.read('rooms','room'),write=store.adapter.write,original=write.run.bind(write);let calls=0;
  write.run=(...args)=>{if(++calls===2)throw new Error('synthetic second statement failure');return original(...args);};
  await assert.rejects(store.compareAndSwapMany({changes:[change('rooms','room',room.version,{turn:2}),change('draw-canvases','canvas',null,{points:[1]})]}),/statement failure/);
  write.run=original;assert.equal((await store.get('rooms','room')).turn,1);assert.equal(await store.get('draw-canvases','canvas'),null);
});

test('SQLite checks a changed guard again before commit and rolls back transactional side effects',async t=>{
  const {store}=fixture(t,'SQLite');await store.put('room-presence','member',{epoch:1});const member=await store.read('room-presence','member');
  const write=store.adapter.write,original=write.run.bind(write);
  write.run=(...args)=>{const result=original(...args);store.adapter.db.prepare('UPDATE game_records SET revision=? WHERE key=?').run(opaqueId(),recordKey('room-presence','member'));return result;};
  assert.equal(await store.compareAndSwapMany({changes:[change('draw-canvases','canvas',null,{points:[1]})],guards:[guard('room-presence','member',member.version)]}),false);
  write.run=original;assert.equal((await store.read('room-presence','member')).version,member.version);assert.equal(await store.get('draw-canvases','canvas'),null);
});

test('SQLite writer lock rejects the transaction with no partial rows',async t=>{
  const {store,path}=fixture(t,'SQLite'),other=new SQLiteAdapter(path,{now:()=>1000});store.adapter.db.exec('PRAGMA busy_timeout=1');other.db.exec('BEGIN IMMEDIATE');
  try {await assert.rejects(store.compareAndSwapMany({changes:[change('draw-canvases','canvas',null,{points:[1]}),change('wordbank-index','receipt',null,{ok:true})]}),/locked/);}
  finally {other.db.exec('ROLLBACK');other.close();}
  assert.equal(await store.get('draw-canvases','canvas'),null);assert.equal(await store.get('wordbank-index','receipt'),null);
});

test('SQLite multi-scope committed records survive adapter reopen and a genuinely new Node process with the same key',async t=>{
  const f=fixture(t,'SQLite');await f.store.compareAndSwapMany({changes:[change('rooms','room',null,{turn:1}),change('draw-canvases','canvas',null,{points:[1,2]}),change('wordbank-index','receipt',null,{ok:true})]});
  const saved=await f.store.read('rooms','room');f.reopen();assert.equal((await f.store.read('rooms','room')).version,saved.version);
  const moduleUrl=new URL('../server/storage.mjs',import.meta.url).href;
  const source=`import {EncryptedStore,SQLiteAdapter} from ${JSON.stringify(moduleUrl)};
const store=new EncryptedStore(new SQLiteAdapter(process.env.STORAGE_MANY_PATH,{now:()=>1000}),Buffer.from(process.env.STORAGE_MANY_KEY,'hex'),()=>1000);
try {console.log(JSON.stringify({room:await store.get('rooms','room'),canvas:await store.get('draw-canvases','canvas'),receipt:await store.get('wordbank-index','receipt')}));} finally {store.close();}`;
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{PATH:process.env.PATH,STORAGE_MANY_PATH:f.path,STORAGE_MANY_KEY:f.key.toString('hex')},stdio:['ignore','pipe','pipe']}));
  assert.deepEqual(result,{room:{turn:1},canvas:{points:[1,2]},receipt:{ok:true}});
  assert.equal(readFileSync(f.path).includes(Buffer.from('receipt')),false);
});

test('adapter ciphertext hard limit rejects before opening a SQLite transaction',async t=>{
  const {store}=fixture(t,'SQLite');await invalid(store.adapter.compareAndSwapMany({changes:[{key:recordKey('draw-canvases','canvas'),expectedVersion:null,
    record:{v:1,revision:opaqueId(),expiresAt:FOREVER,payload:'A'.repeat(MAX_TRANSACTION_BYTES+1)}}],guards:[],validUntil:FOREVER}));
  assert.equal(await store.get('draw-canvases','canvas'),null);assert.equal(store.adapter.db.prepare('SELECT count(*) AS n FROM game_records').get().n,0);
});

test('non-finite transaction clock fails closed after writes and SQLite rollback leaves no residue',async t=>{
  let phase=false,calls=0;const now=()=>phase&&++calls>=3?NaN:1000;const {store}=fixture(t,'SQLite',{now});phase=true;
  await assert.rejects(store.compareAndSwapMany({changes:[change('draw-canvases','canvas',null,{points:[1]})]}),/finite clock/);
  phase=false;assert.equal(await store.get('draw-canvases','canvas'),null);
});
