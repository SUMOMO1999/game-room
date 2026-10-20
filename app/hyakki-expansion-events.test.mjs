import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EncryptedStore,SQLiteAdapter,decryptStoredRecord} from '../server/storage.mjs';
import {createHyakkiEventStore,validateHyakkiEventState,HYAKKI_EVENT_SCOPES,HYAKKI_EVENT_PAGE_MAX_BYTES} from '../server/games/hyakki-trading/event-store.mjs';
import {freezeMatchConfiguration} from './games/hyakki-trading/opening-configuration.mjs';
import {CARDS,GOODS,ROLES,createExpansionDeck} from './games/hyakki-trading/content/expansion-one.mjs';
import {history4EventProblem,history4GroupProblem,history4PacketProblem,decodeHistory4Metadata} from './games/hyakki-trading/public-history-v4.mjs';

const stamp=1800000000000,hex=n=>n.toString(16).padStart(32,'0');
function descriptor(n=6,packId='six-trades-v1'){
  const configuration=freezeMatchConfiguration({packId},Array.from({length:n},(_,i)=>hex(i+1)));
  return {roomId:hex(30),matchId:hex(31),startedAt:stamp,ruleVersion:configuration.ruleVersion,contentVersion:configuration.contentVersion,
    participants:configuration.participantIds.map((seatId,i)=>({seatId,userKey:(i+1).toString(16).padStart(64,'0')})),configuration};
}
const context=d=>({contentVersion:d.contentVersion,participantIds:d.configuration.participantIds});
const metadata=(d,sequence=1)=>({anchor:sequence===1?{kind:'opening'}:{kind:'turn',id:'turn-1',number:1,round:1,ownerSeatId:hex(1)},
  source:null,rolesRevealed:sequence===1?d.participants.map((p,i)=>({seatId:p.seatId,roleId:ROLES[i].id})):[],changes:[],
  discard:{beforeCount:0,afterCount:0,removed:[],added:[]}});
const input=(d,sequence=1,meta=metadata(d,sequence))=>({schemaVersion:4,contentVersion:d.contentVersion,
  participantIds:d.configuration.participantIds,metadata:meta,match:d,sequence,commitId:`event-${sequence}`,committedAt:stamp+sequence,mode:'normal',
  events:sequence===1?[{type:'match-started'}]:[{type:'turn-ended',actorSeatId:hex(1)}]});
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'merchant-history4-')),now=()=>stamp+100000;
  const storage=new EncryptedStore(new SQLiteAdapter(join(directory,'room.sqlite'),{now}),randomBytes(32),now);
  const events=createHyakkiEventStore({storage,now});
  t.after(()=>{storage.close();rmSync(directory,{recursive:true,force:true});});
  return {storage,events};
}
async function rows(storage){
  return (await Promise.all(Object.values(HYAKKI_EVENT_SCOPES).map(async scope=>(await storage.adapter.entries(scope)).map(row=>({scope,key:row.key,
    value:decryptStoredRecord(storage.key,row.key,row),expiresAt:row.expiresAt,payloadBytes:Buffer.byteLength(row.payload)}))))).flat();
}
const commit=(f,p)=>f.storage.compareAndSwapMany(p);
const rejected=error=>error.code==='GAME_HISTORY_INVALID';
function room(d,sequence=1){return {roomId:d.roomId,matchId:d.matchId,game:{ruleVersion:d.ruleVersion,contentVersion:d.contentVersion,
  configuration:d.configuration,players:d.participants.map((p,i)=>({id:p.seatId,roleId:ROLES[i].id})),publicEventSequence:sequence}};}
function ceiling(d){
  const m=metadata(d,2),cards=createExpansionDeck(6),source={kind:'role',roleId:'yousei.role.r01',actorSeatId:hex(1)};
  m.source=source;
  m.changes=d.participants.map(p=>({seatId:p.seatId,silver:-123456789,goods:GOODS.map(g=>({id:g.id,delta:20})),handCount:360,
    toolsAdded:CARDS.filter(c=>c.category==='tool').slice(0,3).map(c=>c.id),toolsRemoved:[]}));
  m.discard={beforeCount:360,afterCount:360,removed:cards.map((c,index)=>({index,definitionId:c.definitionId})),
    added:cards.map((c,index)=>({index,definitionId:c.definitionId,actorSeatId:hex(6),reason:'draw-discarded',source}))};
  return m;
}

test('2～6人实际加密写读按冻结人数和角色公开；头记录仍小于2048字节',async t=>{
  for(let n=2;n<=6;n++){
    const f=fixture(t),d=descriptor(n),m=metadata(d);
    m.changes=d.participants.map(p=>({seatId:p.seatId,silver:20,goods:[],handCount:5,toolsAdded:[],toolsRemoved:[]}));
    assert.equal(await commit(f,await f.events.prepareAppend(input(d,1,m))),true);
    const record=validateHyakkiEventState(await rows(f.storage)),page=(await f.events.readPage({matchId:d.matchId})).page;
    assert.equal(record.groups.length,1);assert.deepEqual(record.heads[0].match.configuration,d.configuration);
    assert.ok(Buffer.byteLength(JSON.stringify(record.heads[0]))<2048);
    assert.deepEqual(decodeHistory4Metadata(page.groups[0].metadata,context(d)),m);
    assert.equal(history4PacketProblem(page,room(d)),null);
    for(const privateField of ['userKey','fingerprint','commitId','candidates','deck','hand"'])assert.equal(JSON.stringify(page).includes(privateField),false);
    const before=await rows(f.storage);assert.deepEqual((await f.events.prepareAppend(input(d,1,m))).changes,[]);
    assert.deepEqual(await rows(f.storage),before);
  }
});
test('完整360位置／十二货上界真正存入SQLite；分页按字节停止且游标不丢记录',async t=>{
  const f=fixture(t),d=descriptor(),large=ceiling(d);
  assert.ok(Buffer.byteLength(JSON.stringify(large))>32768);
  await commit(f,await f.events.prepareAppend(input(d)));
  for(let sequence=2;sequence<=35;sequence++){
    const next=input(d,sequence,large);next.events=[{type:'cards-revealed',actorSeatId:hex(1),cardIds:createExpansionDeck(6).map(c=>c.definitionId)}];
    await commit(f,await f.events.prepareAppend(next));
  }
  const state=validateHyakkiEventState(await rows(f.storage));
  assert.ok(state.groups.every(g=>Buffer.byteLength(JSON.stringify(g))<=32768));
  assert.deepEqual(decodeHistory4Metadata(state.groups[1].metadata,context(d)),large);
  const sequences=[];let after=0,pages=0;
  do{
    const page=(await f.events.readPage({matchId:d.matchId,after,limit:50})).page;
    assert.ok(Buffer.byteLength(JSON.stringify(page))<HYAKKI_EVENT_PAGE_MAX_BYTES);
    assert.equal(history4PacketProblem(page,room(d,35),after),null);
    sequences.push(...page.groups.map(g=>g.sequence));after=page.nextAfter;pages++;
    if(!page.hasMore)break;
  }while(pages<5);
  assert.ok(pages>1);assert.deepEqual(sequences,Array.from({length:35},(_,i)=>i+1));
  t.diagnostic('保守元数据容量上界通过真实存储；不是完整规则引擎执行的整局轨迹。');
});
test('授权守卫冲突和SQLite中断不得留下半条开局；两请求只写一次和只计一次额度',async t=>{
  const f=fixture(t),d=descriptor(),prepared=await f.events.prepareAppend(input(d));
  const roomWrite={scope:'rooms',id:d.roomId,expectedVersion:null,value:{snapshot:room(d)},expiresAt:Number.MAX_SAFE_INTEGER};
  await f.storage.put('sessions','guard',{active:true});const guard=await f.storage.read('sessions','guard');
  await f.storage.put('sessions','guard',{active:false});
  assert.equal(await f.storage.compareAndSwapMany({changes:[...prepared.changes,roomWrite],guards:[...prepared.guards,
    {scope:'sessions',id:'guard',expectedVersion:guard.version}]}),false);
  assert.deepEqual(await rows(f.storage),[]);assert.equal(await f.storage.get('rooms',d.roomId),null);
  f.storage.adapter.db.exec("CREATE TRIGGER stop_event BEFORE INSERT ON game_records WHEN NEW.key LIKE 'hyakki-events:%' BEGIN SELECT RAISE(ABORT,'test interrupt'); END");
  await assert.rejects(f.storage.compareAndSwapMany({changes:[...prepared.changes,roomWrite],guards:prepared.guards}),/test interrupt/);
  assert.deepEqual(await rows(f.storage),[]);assert.equal(await f.storage.get('rooms',d.roomId),null);
  f.storage.adapter.db.exec('DROP TRIGGER stop_event');
  assert.equal(await f.storage.compareAndSwapMany({changes:[...prepared.changes,roomWrite],guards:prepared.guards}),true);
  const [a,b]=await Promise.all([f.events.prepareAppend(input(d,2)),f.events.prepareAppend({...input(d,2),commitId:'competitor'})]);
  assert.deepEqual(await Promise.all([commit(f,a),commit(f,b)]),[true,false]);
  assert.deepEqual((await f.events.prepareAppend(input(d,2))).changes,[]);
  assert.equal(validateHyakkiEventState(await rows(f.storage)).groups.length,2);
});
test('拒绝错版本／错席位顺序／实体牌与候选泄漏；旧公开类型不放宽',async t=>{
  const f=fixture(t),d=descriptor();await commit(f,await f.events.prepareAppend(input(d)));
  for(const mutate of [
    x=>x.participantIds.reverse(),x=>x.contentVersion='yousei-content-v2',x=>x.match.configuration.playerCount=2,
    x=>x.events=[{type:'__proto__'}],x=>x.events=[{type:'draw-peeked',actorSeatId:hex(1),cardId:'yousei.g01'}],
    x=>x.events=[{type:'character-played',actorSeatId:hex(1),cardId:'yousei.c01#01'}],
    x=>x.metadata.candidates=['yousei.role.r01'],x=>x.metadata.source={kind:'card',definitionId:'yousei.role.r01'},
  ]){
    const bad=structuredClone(input(d,2));mutate(bad);await assert.rejects(f.events.prepareAppend(bad),rejected);
  }
  assert.equal(validateHyakkiEventState(await rows(f.storage)).groups.length,1);
  const old=await import('../../../merchant-action-strip-2026-10-20/source/server/games/hyakki-trading/event-store.mjs');
  const currentRows=await rows(f.storage);
  assert.throws(()=>old.validateHyakkiEventState(currentRows),error=>error.code==='GAME_HISTORY_INVALID'||error.code==='GAME_HISTORY_CORRUPT');
});
test('公开交易必须给出可核算的价目；税和临时格费不混入卖价',()=>{
  const d=descriptor(),c=context(d),event={type:'trade-bought',actorSeatId:hex(1),cardId:'yousei.xg07',goods:[{id:'firearms',count:1},{id:'mechanism',count:2}],
    silver:4,price:{printed:4,bookLayers:1,roleAdjustment:-1,goodsPrice:1,buyTax:1,temporaryFee:2}};
  assert.equal(history4EventProblem(event,c),null);
  for(const patch of [{silver:1},{price:{...event.price,goodsPrice:2}},{price:{...event.price,temporaryFee:3}},{goods:[{id:'firearms',count:2}]}])
    assert.ok(history4EventProblem({...event,...patch},c));
  assert.ok(history4EventProblem({...event,price:undefined},c));
  assert.ok(history4EventProblem({...event,type:'trade-sold'},c));
});
test('可调原版新局沿六货目录存组4，不引入扩展货或角色',async t=>{
  const f=fixture(t),d=descriptor(4,'base'),oldMeta={turn:{id:'turn-1',number:1,round:1,ownerSeatId:hex(1)},sourceCardId:null,changes:[],
    discard:{beforeCount:0,afterCount:0,removed:[],added:[]}};
  await commit(f,await f.events.prepareAppend(input(d,1,oldMeta)));
  const page=(await f.events.readPage({matchId:d.matchId})).page;
  assert.equal(page.groups[0].metadata.format,'base-public-v1');assert.equal(history4PacketProblem(page,room(d)),null);
  assert.ok(history4EventProblem({type:'role-used',actorSeatId:hex(1),roleId:'yousei.role.r01'},context(d)));
  assert.ok(history4EventProblem({type:'auction-revealed',actorSeatId:hex(1),cardIds:[],goods:[{id:'timber',count:1}]},context(d)));
});
test('客户端核捕获局的版本／角色公开／游标／容量；不由响应自报人数',async t=>{
  const f=fixture(t),d=descriptor();await commit(f,await f.events.prepareAppend(input(d)));
  const page=(await f.events.readPage({matchId:d.matchId})).page,view=room(d);
  assert.equal(history4PacketProblem(page,view),null);
  for(const mutate of [x=>x.groups[0].participantIds.reverse(),x=>x.nextAfter=0,x=>x.headSequence=0,
    x=>x.groups[0].metadata.data[2][0][1]=23,x=>x.groups[0].events[0].privateHand=[],x=>x.candidates=[]]){
    const bad=structuredClone(page);mutate(bad);assert.ok(history4PacketProblem(bad,view));
  }
  const wrong=structuredClone(view);wrong.game.configuration=freezeMatchConfiguration({packId:'base'},d.configuration.participantIds);
  assert.ok(history4PacketProblem(page,wrong));
  assert.ok(history4GroupProblem({...page.groups[0],metadata:{format:'latest',data:[]}},context(d),{wire:true}));
});

test('合法角色编号也不得冒用另一席身份或伪造弃牌来源',async t=>{
  const f=fixture(t),d=descriptor();await commit(f,await f.events.prepareAppend(input(d)));
  for(const target of ['event','source','discard']){
    const next=input(d,2),source={kind:'role',roleId:'yousei.role.r23',actorSeatId:hex(1)};
    if(target==='event')next.events=[{type:'role-used',actorSeatId:hex(1),roleId:source.roleId}];
    if(target==='source')next.metadata.source=source;
    if(target==='discard')next.metadata.discard={beforeCount:0,afterCount:1,removed:[],
      added:[{index:0,definitionId:'yousei.c01',actorSeatId:hex(2),reason:'response',source}]};
    await assert.rejects(f.events.prepareAppend(next),rejected);
  }
  const valid=input(d,2);valid.events=[{type:'role-used',actorSeatId:hex(1),roleId:'yousei.role.r01'}];
  valid.metadata.source={kind:'role',roleId:'yousei.role.r01',actorSeatId:hex(1)};
  await commit(f,await f.events.prepareAppend(valid));
  const page=(await f.events.readPage({matchId:d.matchId})).page;
  assert.equal(history4PacketProblem(page,room(d,2)),null);
  const forged=structuredClone(page);forged.groups[1].events[0].roleId='yousei.role.r23';
  assert.ok(history4PacketProblem(forged,room(d,2)));
});
