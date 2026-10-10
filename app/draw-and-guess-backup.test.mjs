import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {EncryptedStore,SQLiteAdapter} from '../server/storage.mjs';
import {readSettings} from '../server/config.mjs';
import {createRuntime} from '../server/runtime.mjs';
import {closeRuntime} from '../server/production.mjs';
import {backupStore,restoreStore,verifyLiveStore,verifyBackup,validateDrawingRecoveryReferences} from '../server/backup.mjs';
const users=['a','b','c'].map(c=>c.repeat(64));
const now=()=>1791340000000;
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'drawing-full-backup-')),path=join(dir,'source.sqlite'),key=randomBytes(32);
  const storage=new EncryptedStore(new SQLiteAdapter(path,{now}),key,now);
  const settings=readSettings({GAME_ROOM_PORT:'4361',GAME_ROOM_AUTH_MODE:'mock',GAME_ROOM_STORE_KEY:key.toString('base64url')});
  const runtime=createRuntime(settings,{storage,now,drawingEnabled:true,roomOptions:{pollIntervalMs:0,serverRandomInt:()=>0}});
  t.after(async()=>{await closeRuntime(runtime);rmSync(dir,{recursive:true,force:true});});
  await runtime.wordbankReady;await runtime.canvases.ready;
  const host=await runtime.rooms.createRoom(users[0],'画者','backup-create','draw-and-guess'),code=host.roomCode;
  await runtime.rooms.joinRoom(code,users[1],'猜者','backup-join');
  await runtime.rooms.joinRoom(code,users[2],'观众','backup-watch','spectator');
  const action=async(user,type,extra={})=>{const view=await runtime.rooms.getView(code,user);return runtime.rooms.action(code,user,{type,requestId:randomBytes(16).toString('hex'),expectedRevision:view.revision,...extra});};
  return {...runtime,dir,path,key,code,host,action};
}
for(const phase of ['waiting','drawing'])test(`whole drawing ${phase} restores in a fresh process with original seats, content and confirmed ink`,async t=>{
  const f=await fixture(t);let lease;
  if(phase==='drawing') {
    await f.action(users[0],'ready',{ready:true});await f.action(users[1],'ready',{ready:true});await f.action(users[0],'start');
    const v=await f.rooms.getView(f.code,users[0]);await f.action(users[0],'choose',{matchId:v.matchId,turnId:v.game.turnId,candidateId:v.game.candidates[0].id});
    const paper=await f.canvases.read(f.code,users[0]);lease=await f.canvases.acquire(f.code,users[0],{deviceId:'backup-device',canvasId:paper.canvasId,bootId:paper.bootId},{authorizationId:'old-session'});
    await f.canvases.append(f.code,users[0],{deviceId:'backup-device',canvasId:lease.canvasId,bootId:lease.bootId,requestId:'confirmed-stroke',leaseGeneration:lease.leaseGeneration,clearGeneration:0,expectedSequence:0,
      operations:[{strokeId:'saved-ink',tool:'pen',color:'#245c7c',width:4,points:[[.1,.2],[.3,.4],[.5,.6]]}]},{authorizationId:'old-session'});
  }
  const original=(await f.storage.read('rooms',f.host.view.roomId)).value.snapshot;
  const artifact=join(f.dir,'business.sqlite'),restored=join(f.dir,'restored.sqlite');
  const report=await backupStore({sourcePath:f.path,destinationPath:artifact,key:f.key,now});assert.equal(report.scopes.length,18);
  assert.equal(verifyBackup({sourcePath:artifact,key:f.key}).manifest.authSessionsIncluded,false);
  restoreStore({sourcePath:artifact,destinationPath:restored,key:f.key,offline:true});
  const child=`import {EncryptedStore,SQLiteAdapter} from './server/storage.mjs';import {createRuntime} from './server/runtime.mjs';import {readSettings} from './server/config.mjs';import {closeRuntime} from './server/production.mjs';
    const [path,key,code,phase]=process.argv.slice(1),now=()=>1791340000000,storage=new EncryptedStore(new SQLiteAdapter(path,{now}),Buffer.from(key,'base64url'),now);
    const r=createRuntime(readSettings({GAME_ROOM_PORT:'4361',GAME_ROOM_AUTH_MODE:'mock'}),{storage,now,drawingEnabled:true,roomOptions:{pollIntervalMs:0}});await r.wordbankReady;await r.canvases.ready;
    const users=['a','b','c'].map(c=>c.repeat(64)),views=await Promise.all(users.map(u=>r.rooms.getView(code,u)));const release=await r.wordbanks.getRelease({userKey:users[0],member:true},'dg-base',1);
    let paper=phase==='drawing'?await r.canvases.read(code,users[1]):null;
    console.log(JSON.stringify({views,releaseWords:release.words.length,paper,room:(await storage.scan('rooms'))[0].value.snapshot}));await closeRuntime(r);`;
  const recovered=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',child,restored,f.key.toString('base64url'),f.code,phase],{cwd:process.cwd(),encoding:'utf8'}));
  assert.deepEqual(recovered.room,original);assert.equal(recovered.releaseWords,560);
  assert.equal(recovered.views[0].selfId,original.players[0].id);assert.equal(recovered.views[1].selfId,original.players[1].id);assert.equal(recovered.views[2].selfId,original.spectators[0].id);
  if(phase==='drawing') {assert.equal(recovered.paper.pointCount,3);assert.equal(recovered.paper.sequence,1);assert.notEqual(recovered.paper.bootId,lease.bootId);assert.equal(recovered.views[1].game.word,undefined);}
  assert.doesNotThrow(()=>verifyLiveStore({sourcePath:restored,key:f.key}));
});
test('recovery references refuse future/orphan canvas questions and missing adopted waiting releases',()=>{
  const room={roomId:'a'.repeat(32),matchId:'b'.repeat(32),phase:'playing',game:{turnNumber:2}},canvas={kind:'canvas',roomId:room.roomId,matchId:room.matchId,turnId:'dg-turn-2'};
  const state={packs:[],releases:[],index:[]},check=(rooms,canvases,summaries=[])=>validateDrawingRecoveryReferences({rooms,canvases,wordbankState:state,summaries});
  assert.equal(check([room],[canvas]),true);assert.throws(()=>check([room],[{...canvas,turnId:'dg-turn-3'}]),/Future/);
  assert.throws(()=>check([],[canvas]),/Orphan/);assert.equal(check([],[canvas],[{roomId:room.roomId,matchId:room.matchId}]),true);
  assert.throws(()=>check([{...room,phase:'waiting',drawConfig:{contentSelection:{packId:'gone',version:1,categoryIds:['daily']}}}],[]),/Waiting room/);
});
