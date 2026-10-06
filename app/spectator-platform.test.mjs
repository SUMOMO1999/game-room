import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore } from './rooms.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createRoomChat } from '../server/chat.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
import { backupStore,verifyBackup,restoreStore,RECOVERY_SCOPES } from '../server/backup.mjs';

const users=Array.from({length:18},(_,index)=>identityKey('urn:synthetic-spectator',`user-${index}`));
const options={firstTurnIndex:0,randomInt:max=>max-1};let sequence=0;
function nativeFixture() {
  const rooms=createRoomStore({gameOptions:options});
  const host=rooms.createTrustedRoom(users[0],'同名',{code:'123456',roomId:'1'.repeat(32)});
  const join=(index,role)=>rooms.joinTrustedRoom(host.roomCode,users[index],'同名',{role});
  const action=(index,type,fields={})=>rooms.trustedAction(host.roomCode,users[index],{type,...fields,requestId:`native-${++sequence}`,expectedRevision:rooms.getTrustedView(host.roomCode,users[index]).revision});
  const start=()=>{action(0,'ready',{ready:true});action(1,'ready',{ready:true});action(0,'start');};
  return {rooms,host,join,action,start};
}
async function durableFixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'room-spectators-')),path=join(directory,'source.sqlite'),key=randomBytes(32),opened=[];const now=()=>10000;
  function open(target=path) {
    const storage=new EncryptedStore(new SQLiteAdapter(target,{now}),key,now),rooms=createDurableRoomStore({storage,now,gameOptions:options,pollIntervalMs:0});
    const chat=createRoomChat({rooms,storage,now,pollIntervalMs:0}),history=createMatchHistory({storage,now});rooms.setHistory(history);
    const entry={rooms,storage,chat,history};opened.push(entry);return entry;
  }
  t.after(async()=>{for(const entry of opened) {await entry.chat.close();await entry.rooms.close();entry.storage.close();}await rm(directory,{recursive:true,force:true});});
  const entry=open(),host=await entry.rooms.createRoom(users[0],'同名',`create-${++sequence}`);
  const joinUser=(index,role,roomStore=entry.rooms)=>roomStore.joinRoom(host.roomCode,users[index],'同名',`join-${++sequence}`,role);
  const action=async(index,type,fields={},roomStore=entry.rooms)=>roomStore.action(host.roomCode,users[index],{type,...fields,requestId:`durable-${++sequence}`,
    expectedRevision:(await roomStore.getView(host.roomCode,users[index])).revision});
  const start=async()=>{await action(0,'ready',{ready:true});await action(1,'ready',{ready:true});await action(0,'start');};
  return {directory,path,key,now,entry,host,open,join:joinUser,action,start};
}

test('waiting role switches preserve member IDs, readiness resets, and a host must hand off first',()=>{
  const f=nativeFixture(),player=f.join(1),spectator=f.join(2,'spectator');assert.equal(spectator.view.selfRole,'spectator');
  assert.equal(spectator.view.players.length,2);assert.equal(spectator.view.spectators.length,1);
  f.action(1,'ready',{ready:true});const changed=f.action(1,'set-role',{role:'spectator'}).view;
  assert.equal(changed.selfId,player.playerId);assert.equal(changed.selfRole,'spectator');assert.equal(changed.players.length,1);
  const restored=f.action(1,'set-role',{role:'player'}).view;assert.equal(restored.selfId,player.playerId);assert.equal(restored.players.find(player=>player.id===restored.selfId).ready,false);
  assert.throws(()=>f.action(0,'set-role',{role:'spectator'}),error=>error.code==='HOST_TRANSFER_REQUIRED');
  f.action(0,'transferHost',{playerId:player.playerId});assert.equal(f.action(0,'set-role',{role:'spectator'}).view.selfRole,'spectator');
  f.action(0,'set-role',{role:'player'});f.action(2,'leave');assert.equal(f.rooms.exportSnapshot(f.host.roomCode).schemaVersion,4);
  f.rooms.close();
});

test('late joins automatically spectate, existing accounts preserve their seat and a nickname grants no hand',()=>{
  const f=nativeFixture(),player=f.join(1);f.start();const spectator=f.join(2,'player');
  assert.equal(spectator.view.selfRole,'spectator');assert.equal(spectator.view.players.length,2);assert.equal(spectator.view.game.rack,undefined);
  const own=f.join(1,'spectator');assert.equal(own.playerId,player.playerId);assert.equal(own.view.selfRole,'player');assert.equal(own.view.game.rack.length,14);
  assert.equal(f.join(2,'player').playerId,spectator.playerId);assert.equal(f.join(2).view.selfRole,'spectator');
  assert.throws(()=>f.action(2,'set-role',{role:'player'}),error=>error.code==='ROOM_LOCKED');f.rooms.close();
});

test('spectators cannot influence turn, host, pause votes, preparation, rematch or game actions',()=>{
  const f=nativeFixture();f.join(1);f.join(2,'spectator');f.start();const before=f.rooms.getTrustedView(f.host.roomCode,users[0]).game;
  for(const [type,fields] of [['ready',{ready:true}],['start',{}],['rematch',{}],['transferHost',{}],['pause',{}],['resume',{}],['draw',{}],['pass',{}],['submit',{boardIds:[],rackIds:[]}]]) {
    assert.throws(()=>f.action(2,type,fields),error=>error.status===403 && error.code==='SPECTATOR_READ_ONLY');
  }
  assert.deepEqual(f.rooms.getTrustedView(f.host.roomCode,users[0]).game,before);f.action(2,'leave');assert.equal(f.rooms.getTrustedView(f.host.roomCode,users[0]).phase,'playing');f.rooms.close();
});

test('spectator capacity is separate from the seven Rummikub player seats',()=>{
  const f=nativeFixture();for(let index=1;index<7;index++) f.join(index);for(let index=7;index<15;index++) f.join(index,'spectator');
  const view=f.rooms.getTrustedView(f.host.roomCode,users[0]);assert.equal(view.players.length,7);assert.equal(view.spectators.length,8);
  assert.throws(()=>f.join(15,'spectator'),error=>error.code==='SPECTATOR_FULL');assert.throws(()=>f.action(7,'set-role',{role:'player'}),error=>error.code==='ROOM_FULL');f.rooms.close();
});

test('schema4 public spectators restore safely while old schema2 remains unchanged without spectators',()=>{
  const f=nativeFixture();f.join(1);const old=f.rooms.exportSnapshot(f.host.roomCode);assert.equal(old.schemaVersion,2);assert.equal(old.spectators,undefined);
  f.join(2,'spectator');f.start();const snapshot=f.rooms.exportSnapshot(f.host.roomCode);assert.equal(snapshot.schemaVersion,4);assert.equal(snapshot.gameType,'rummikub');
  const restored=createRoomStore();restored.importSnapshot(snapshot);assert.deepEqual(restored.getTrustedView(f.host.roomCode,users[2]).game,f.rooms.getTrustedView(f.host.roomCode,users[2]).game);
  for(const edit of [data=>data.spectators.push({...data.players[0]}),data=>data.spectators[0].userKey=data.players[0].userKey,data=>data.gameType='unknown',data=>data.hostId=data.spectators[0].id,
    data=>{data.schemaVersion=2;delete data.gameType;}]) {const corrupt=structuredClone(snapshot);edit(corrupt);assert.throws(()=>createRoomStore().importSnapshot(corrupt),error=>error.code==='INVALID_SNAPSHOT');}
  f.rooms.close();restored.close();
});

test('durable observer role and ID recover across another connection, backup and restart without stealing a seat',async t=>{
  const f=await durableFixture(t);await f.join(1);await f.start();
  const initial=await f.entry.rooms.getView(f.host.roomCode,users[0]),tens=initial.game.rack.filter(tile=>tile.value===10);
  await f.action(0,'submit',{boardIds:[tens.map(tile=>tile.id)],rackIds:initial.game.rack.filter(tile=>tile.value!==10).map(tile=>tile.id),boardPositions:[{x:.2,y:.4}]});
  const spectator=await f.join(2),second=f.open();
  const recovery=await f.join(2,'player',second.rooms);assert.equal(recovery.playerId,spectator.playerId);assert.equal(recovery.view.selfRole,'spectator');assert.equal(recovery.view.game.rack,undefined);
  const recent=await second.rooms.recentRooms(users[2]);assert.equal(recent[0].selfRole,'spectator');assert.equal(recent[0].spectatorsCount,1);assert.equal(recent[0].playersCount,2);assert.equal(recent[0].name,'同名');
  const backup=join(f.directory,'backup.sqlite'),destination=join(f.directory,'restored.sqlite');
  const report=await backupStore({sourcePath:f.path,destinationPath:backup,key:f.key,now:f.now});assert.deepEqual(report.scopes,[...RECOVERY_SCOPES]);
  assert.ok(verifyBackup({sourcePath:backup,key:f.key}).rows.every(row=>!['sessions','transactions','room-presence'].includes(row.key.split(':')[0])));
  restoreStore({sourcePath:backup,destinationPath:destination,key:f.key,offline:true});const restored=f.open(destination);
  const view=await restored.rooms.getView(f.host.roomCode,users[2]);assert.equal(view.selfId,spectator.playerId);assert.equal(view.selfRole,'spectator');assert.ok(!('rack' in view.game));
  assert.deepEqual(view.game.boardPositions,[{x:.2,y:.4}]);assert.deepEqual(view.game.board.flat().map(tile=>tile.id).sort(),tens.map(tile=>tile.id).sort());
});

test('draw commits only public geometry with CAS, idempotency, observer privacy and durable recovery',async t=>{
  const f=await durableFixture(t);await f.join(1);await f.join(2,'spectator');
  await f.action(0,'configure',{jokerConfig:{normal:2,mirror:1,colorChange:0,double:0}});await f.start();
  const initial=await f.entry.rooms.getView(f.host.roomCode,users[0]),tens=initial.game.rack.filter(tile=>tile.value===10);
  await f.action(0,'submit',{boardIds:[tens.map(tile=>tile.id)],rackIds:initial.game.rack.filter(tile=>tile.value!==10).map(tile=>tile.id),boardPositions:[{x:.2,y:.4}]});
  const before=await f.entry.rooms.getView(f.host.roomCode,users[1]),second=f.open();
  await assert.rejects(f.action(1,'draw',{boardPositions:[]}),error=>error.code==='INVALID_GAME_ACTION');
  await assert.rejects(f.action(0,'draw',{boardPositions:[{x:.8,y:.6}]}),error=>error.code==='INVALID_GAME_ACTION');
  await assert.rejects(f.action(2,'draw',{boardPositions:[{x:.8,y:.6}]}),error=>error.code==='SPECTATOR_READ_ONLY');
  assert.deepEqual(await f.entry.rooms.getView(f.host.roomCode,users[1]),before);
  const action={type:'draw',boardPositions:[{x:.8,y:.6}],requestId:'durable-layout-draw',expectedRevision:before.revision};
  const drawn=await f.entry.rooms.action(f.host.roomCode,users[1],action);
  assert.equal(drawn.view.revision,before.revision+1);assert.equal(drawn.view.game.revision,before.game.revision+1);
  assert.equal(drawn.view.game.rack.length,before.game.rack.length+1);assert.equal(drawn.view.game.poolCount,before.game.poolCount-1);
  assert.deepEqual(drawn.view.game.boardPositions,[{x:.8,y:.6}]);assert.deepEqual(drawn.view.game.board,before.game.board);
  const replay=await second.rooms.action(f.host.roomCode,users[1],action);assert.deepEqual(replay.view.game,drawn.view.game);
  await assert.rejects(second.rooms.action(f.host.roomCode,users[1],{...action,boardPositions:null}),error=>error.code==='REQUEST_ID_REUSED');
  await assert.rejects(second.rooms.action(f.host.roomCode,users[0],{...action,requestId:'stale-layout-cas'}),error=>error.code==='REVISION_CONFLICT');
  const observed=await second.rooms.getView(f.host.roomCode,users[2]);assert.deepEqual(observed.game.boardPositions,[{x:.8,y:.6}]);assert.equal(observed.game.rack,undefined);
  const backup=join(f.directory,'draw-layout-backup.sqlite'),destination=join(f.directory,'draw-layout-recovered.sqlite');
  await backupStore({sourcePath:f.path,destinationPath:backup,key:f.key,now:f.now});restoreStore({sourcePath:backup,destinationPath:destination,key:f.key,offline:true});
  const restored=f.open(destination),recovered=await restored.rooms.getView(f.host.roomCode,users[1]);
  assert.equal(recovered.selfId,before.selfId);assert.deepEqual(recovered.game,drawn.view.game);assert.equal(recovered.game.ruleVersion,'friends-v4');
});

test('spectators chat under server identity, do not enter match history, and cannot keep an empty player room alive',async t=>{
  const f=await durableFixture(t);await f.join(1);await f.start();const spectator=await f.join(2);
  const message=await f.entry.chat.send(f.host.roomCode,users[2],{text:'观众在聊天',requestId:'spectator-chat'});assert.equal(message.message.playerId,spectator.playerId);
  assert.equal(message.message.name,'同名');await f.action(0,'leave');assert.equal((await f.entry.history.get(users[2])).items.length,0);
  const record=(await f.entry.history.get(users[1])).items[0];assert.equal(record.players.length,2);assert.ok(record.players.every(player=>player.seatId!==spectator.playerId));
  assert.equal((await f.entry.rooms.getView(f.host.roomCode,users[2])).phase,'aborted');await f.action(1,'leave');
  await assert.rejects(f.entry.rooms.getView(f.host.roomCode,users[2]),error=>error.code==='ROOM_NOT_FOUND');assert.equal((await f.entry.rooms.recentRooms(users[2])).length,0);
});

test('global room SSE capacity applies to persisted connections across instances, including observer devices',async t=>{
  const f=await durableFixture(t);await f.join(1);await f.join(2,'spectator');await f.join(3,'spectator');await f.join(4,'spectator');
  const second=f.open(),stops=[];
  for(let index=0;index<16;index++) stops.push(await (index%2?f.entry.rooms:second.rooms).subscribe(f.host.roomCode,users[Math.floor(index/4)],()=>{}));
  await assert.rejects(second.rooms.subscribe(f.host.roomCode,users[4],()=>{}),error=>error.code==='ROOM_CONNECTION_LIMIT');
  await assert.rejects(second.rooms.subscribe(f.host.roomCode,users[2],()=>{}),error=>error.code==='CONNECTION_LIMIT');
  await stops[0]();const reopened=await second.rooms.subscribe(f.host.roomCode,users[4],()=>{});await reopened();for(const stop of stops.slice(1)) await stop();
});

test('role switching uses room CAS and observes capacity rather than turning concurrent spectators into duplicate players',async t=>{
  const f=await durableFixture(t);for(let index=1;index<6;index++) await f.join(index);await f.join(6,'spectator');await f.join(7,'spectator');const second=f.open();
  const a=await f.entry.rooms.getView(f.host.roomCode,users[6]),b=await second.rooms.getView(f.host.roomCode,users[7]);
  const results=await Promise.allSettled([f.entry.rooms.action(f.host.roomCode,users[6],{type:'set-role',role:'player',requestId:'race-a',expectedRevision:a.revision}),
    second.rooms.action(f.host.roomCode,users[7],{type:'set-role',role:'player',requestId:'race-b',expectedRevision:b.revision})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((await f.entry.rooms.getView(f.host.roomCode,users[0])).players.length,7);
  const rejected=results.find(result=>result.status==='rejected');assert.equal(rejected.reason.code,'REVISION_CONFLICT');
});

test('only the waiting Rummikub host configures ghosts; settings reset readiness and freeze inside the next game',()=>{
  const f=nativeFixture();f.join(1);f.join(2,'spectator');f.action(0,'ready',{ready:true});f.action(1,'ready',{ready:true});
  const jokerConfig={normal:2,mirror:1,colorChange:1,double:1};
  assert.throws(()=>f.action(1,'configure',{jokerConfig}),error=>error.code==='HOST_REQUIRED');
  assert.throws(()=>f.action(2,'configure',{jokerConfig}),error=>error.code==='SPECTATOR_READ_ONLY');
  const configured=f.action(0,'configure',{jokerConfig}).view;assert.deepEqual(configured.jokerConfig,jokerConfig);assert.ok(configured.players.every(player=>!player.ready));
  assert.equal(f.rooms.exportSnapshot(f.host.roomCode).schemaVersion,4);f.start();
  const started=f.rooms.getTrustedView(f.host.roomCode,users[0]);assert.equal(started.game.ruleVersion,'friends-v4');assert.equal(started.game.jokerCount,5);
  assert.equal(started.game.tileCount,109);assert.deepEqual(started.game.jokerConfig,jokerConfig);
  assert.throws(()=>f.action(0,'configure',{jokerConfig:{...jokerConfig,normal:3}}),error=>error.code==='ROOM_LOCKED');
  assert.deepEqual(f.rooms.getTrustedView(f.host.roomCode,users[0]).game,started.game);f.rooms.close();
});

test('malformed, missing, over-limit and forged game settings are atomic failures',()=>{
  const f=nativeFixture();f.join(1);f.action(0,'ready',{ready:true});
  for(const jokerConfig of [null,{normal:2},{normal:2,mirror:0,colorChange:0,double:-1},{normal:2,mirror:0,colorChange:0,double:9},
    {normal:8,mirror:8,colorChange:8,double:1},{normal:1.5,mirror:0,colorChange:0,double:0},{normal:2,mirror:0,colorChange:0,double:0,admin:true}]) {
    assert.throws(()=>f.action(0,'configure',{jokerConfig}),error=>error.code==='INVALID_JOKER_CONFIG');
    const view=f.rooms.getTrustedView(f.host.roomCode,users[0]);assert.equal(view.jokerConfig,null);assert.equal(view.players[0].ready,true);
  }
  f.rooms.close();
});

test('custom ghost settings persist through SQLite, rematch, nine-scope restore and strict schema validation',async t=>{
  const f=await durableFixture(t);await f.join(1);const jokerConfig={normal:0,mirror:0,colorChange:0,double:0};
  await f.action(0,'configure',{jokerConfig});await f.start();const second=f.open(),current=await second.rooms.getView(f.host.roomCode,users[0]);
  assert.equal(current.game.ruleVersion,'friends-v4');assert.equal(current.game.tileCount,104);assert.equal(current.game.jokerCount,0);
  const saved=(await second.storage.read('rooms',f.host.view.roomId)).value.snapshot;assert.equal(saved.schemaVersion,8);
  for(const edit of [data=>data.jokerConfig.normal=9,data=>data.jokerConfig.normal=1,data=>{delete data.jokerConfig;},data=>data.schemaVersion=2]) {
    const bad=structuredClone(saved);edit(bad);assert.throws(()=>createRoomStore().importSnapshot(bad),error=>error.code==='INVALID_SNAPSHOT');
  }
  const backup=join(f.directory,'custom-backup.sqlite'),destination=join(f.directory,'custom-restored.sqlite');
  await backupStore({sourcePath:f.path,destinationPath:backup,key:f.key,now:f.now});restoreStore({sourcePath:backup,destinationPath:destination,key:f.key,offline:true});const restored=f.open(destination);
  assert.deepEqual((await restored.rooms.getView(f.host.roomCode,users[0])).game.jokerConfig,jokerConfig);
  await f.action(1,'leave');await f.action(0,'rematch');assert.deepEqual((await f.entry.rooms.getView(f.host.roomCode,users[0])).jokerConfig,jokerConfig);
  await f.join(1);await f.start();assert.deepEqual((await f.entry.rooms.getView(f.host.roomCode,users[0])).game.jokerConfig,jokerConfig);
});
