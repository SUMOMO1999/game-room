import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeck, validateMeld, normalizeMeld, evaluateDraft, stateProblem } from './rules.mjs';
import { createGame, applyGameAction, gameProblem } from './multiplayer-rules.mjs';
import { createRoomStore } from './rooms.mjs';
import { sortPlayableRack } from './rummikub-assist.mjs';
import { openingProgress } from './game-presentation.mjs';
import { createRoomPreview } from '../server/room-preview.mjs';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { createMatchHistory } from '../server/match-history.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { CURRENT_DATA_COMPATIBILITY, compareReleaseCompatibility } from '../scripts/release-compatibility.mjs';

const jokerConfig = {normal:2,mirror:1,colorChange:2,double:2};
const deck = createDeck({copies:2,jokerConfig}), lookup = new Map(deck.map(tile=>[tile.id,tile]));
const tiles = ids => ids.map(id=>{assert.ok(lookup.has(id),id);return structuredClone(lookup.get(id));});
const options = ruleVersion=>({copies:2,jokerConfig,ruleVersion});
const users = ['a'.repeat(64),'b'.repeat(64)];
function state(ids,ruleVersion='friends-v4',board=[]) {
  const used = new Set([...ids,...board.flat()]);
  return {version:1,ruleVersion,jokerConfig:structuredClone(jokerConfig),rack:tiles(ids),board:board.map(tiles),
    pool:deck.filter(tile=>!used.has(tile.id)),opened:false,round:1};
}
function room({version='friends-v4',clock=60000,board=[],rack=['red-13-a','joker-mirror-1','red-13-b','black-13-a']}={}) {
  const store=createRoomStore({now:()=>100000,turnTimeoutMs:clock,gameOptions:{firstTurnIndex:0,randomInt:max=>max-1,ruleVersion:version}});
  const host=store.createTrustedRoom(users[0],'甲',{code:'123456',roomId:'c'.repeat(32)});
  store.joinTrustedRoom(host.roomCode,users[1],'乙');let serial=0;
  const act=(index,type,fields={})=>store.trustedAction(host.roomCode,users[index],{type,requestId:`mirror-v4-${++serial}`,
    expectedRevision:store.getTrustedView(host.roomCode,users[index]).revision,...fields});
  act(0,'configure',{jokerConfig});act(0,'ready',{ready:true});act(1,'ready',{ready:true});act(0,'start');
  const snapshot=store.exportSnapshot(host.roomCode),game=snapshot.game;
  game.board=board.map(tiles);game.boardPositions=null;
  game.players[0].rack=tiles(rack);game.players[0].opened=false;
  game.players[1].rack=tiles(['black-1-a','black-2-a']);game.players[1].opened=true;
  const used=new Set([...game.board.flat(),...game.players.flatMap(player=>player.rack)].map(tile=>tile.id));
  game.pool=deck.filter(tile=>!used.has(tile.id));assert.equal(gameProblem(game),null);
  store.importSnapshot(snapshot);
  return {store,host,act,snapshot,view:()=>store.getTrustedView(host.roomCode,users[0])};
}

test('v4 mirror groups count one corresponding digit while v3 and inferred standalone calls remain zero',()=>{
  for(const n of [1,10,13]) {
    const meld=tiles([`red-${n}-a`,'joker-mirror-1',`red-${n}-b`]);
    assert.equal(validateMeld(meld,options('friends-v4')).points,3*n);
    assert.equal(validateMeld(meld,options('friends-v3')).points,2*n);
    assert.equal(validateMeld(meld,{jokerConfig}).points,2*n);
    assert.deepEqual(normalizeMeld(meld,options('friends-v4')),meld);
  }
});

test('ascending, descending and double-adjacent mirror axes keep physical order and score through repeated normalization',()=>{
  const cases=[
    [['red-1-a','red-2-a','red-3-a','joker-mirror-1','red-3-b','red-2-b','red-1-b'],15],
    [['red-3-a','red-2-a','red-1-a','joker-mirror-1','red-1-b','red-2-b','red-3-b'],13],
    [['red-2-a','joker-double-1','joker-mirror-1','red-4-a','red-3-a','red-2-b'],22],
    [['red-4-a','joker-double-1','joker-mirror-1','red-2-a','red-3-a','red-4-b'],20],
  ];
  for(const [ids,points]of cases) {
    const meld=tiles(ids),input=structuredClone(meld);
    for(let round=0;round<3;round++) {
      assert.equal(validateMeld(meld,options('friends-v4')).points,points);
      assert.deepEqual(normalizeMeld(meld,options('friends-v4')),input);
    }
    const committed=state([...ids,'black-13-a']),draft=structuredClone(committed);
    draft.board=[normalizeMeld(meld,options('friends-v4'))];draft.rack=tiles(['black-13-a']);
    assert.equal(stateProblem(committed,true,options('friends-v4')),null);
    assert.equal(evaluateDraft(committed,draft,options('friends-v4')).points,points);
  }
});

test('other joker scoring, validity and settled hand penalties stay unchanged under v4',()=>{
  for(const ids of [['red-10-a','blue-10-a','joker-normal-1'],['red-2-a','joker-double-1','red-5-a'],
    ['red-3-a','red-4-a','joker-color-change-1','blue-6-a']]) {
    assert.deepEqual(validateMeld(tiles(ids),options('friends-v4')),validateMeld(tiles(ids),options('friends-v3')));
  }
  const legacy=createGame([{id:'a',name:'甲'},{id:'b',name:'乙'}],{firstTurnIndex:0});
  assert.equal(legacy.ruleVersion,'friends-v2');
  const current=createGame([{id:'a',name:'甲'},{id:'b',name:'乙'}],{jokerConfig,firstTurnIndex:0});
  assert.equal(current.ruleVersion,'friends-v4');
  current.players[0].rack=tiles(['red-10-a','blue-10-a','black-10-a']);current.players[1].rack=tiles(['joker-mirror-1']);
  const used=new Set(current.players.flatMap(player=>player.rack).map(tile=>tile.id));current.pool=deck.filter(tile=>!used.has(tile.id));
  const finished=applyGameAction(current,'a',{type:'submit',boardIds:[['red-10-a','blue-10-a','black-10-a']],rackIds:[]});
  assert.equal(finished.ok,true,finished.error);assert.equal(finished.state.result.scores[1].points,30);
});

test('true RoomStore opening, assistance and public preview agree on new 39 and legacy 26 without leaking private hands',()=>{
  for(const version of ['friends-v4','friends-v3']) {
    const f=room({version}),view=f.view(),ids=['red-13-a','joker-mirror-1','red-13-b'];
    const preview=createRoomPreview({now:()=>100000});
    try {
      const prepared=preview.prepare(view,{previewId:'mirror_score_source_1',sequence:1,matchId:view.matchId,gameRevision:view.game.revision,boardIds:[ids],positions:[{x:.1,y:.1}]},'private-session');
      assert.equal(prepared.preview.valid,version==='friends-v4');
      if(version==='friends-v3')assert.match(prepared.preview.validationMessage,/26/);
      const suggestion=sortPlayableRack(view.game.rack,{...options(version),opened:false,mode:'number'});
      assert.equal(suggestion.points,version==='friends-v4'?39:26);assert.equal(suggestion.canOpen,version==='friends-v4');
      const before=f.store.exportSnapshot('123456');
      if(version==='friends-v4') {
        f.act(0,'submit',{boardIds:[ids],rackIds:['black-13-a']});
        const after=f.store.exportSnapshot('123456');assert.equal(after.game.players[0].opened,true);
        assert.deepEqual(after.game.players[1].rack,before.game.players[1].rack);assert.deepEqual(after.game.pool,before.game.pool);
        assert.equal(f.store.getTrustedView('123456',users[1]).game.rack.some(tile=>tile.id==='black-13-a'),false);
      } else {
        assert.throws(()=>f.act(0,'submit',{boardIds:[ids],rackIds:['black-13-a']}),/26/);
        assert.deepEqual(f.store.exportSnapshot('123456').game,before.game);
      }
      assert.equal(JSON.stringify(prepared.preview).includes('black-13-a'),false);
    } finally {preview.close();f.store.close();}
  }
});

test('opening display excludes old table points and the authority rejects borrowing and incomplete own groups',()=>{
  const publicGroup=['blue-10-a','blue-11-a','blue-12-a'],own=['red-9-a','joker-mirror-1','red-9-b'];
  const committed=state([...own,'black-13-a'],'friends-v4',[publicGroup]),draft=structuredClone(committed);
  draft.board.push(tiles(own));draft.rack=tiles(['black-13-a']);
  const display=openingProgress(committed,draft,options('friends-v3'));
  assert.equal(display.points,27);assert.equal(display.missing,3);assert.equal(display.mirrorNote,'镜像计对应数字');
  assert.equal(evaluateDraft(committed,draft,options('friends-v4')).valid,false);
  const borrowed=structuredClone(draft);borrowed.board[1].push(borrowed.board[0].shift());
  assert.match(evaluateDraft(committed,borrowed,options('friends-v4')).reason,/首次.*自己|首次.*原|重组/);
  draft.board.push(tiles(['black-13-a']));draft.rack=[];
  assert.equal(openingProgress(committed,draft,options('friends-v4')).points,27);
  assert.equal(evaluateDraft(committed,draft,options('friends-v4')).valid,false);
});

test('v4 schema8 handles clockless, timed and paused states and cannot be disguised as any older snapshot',()=>{
  for(const clock of [0,60000]) {
    const f=room({clock}),saved=f.store.exportSnapshot('123456');assert.equal(saved.schemaVersion,8);
    assert.equal(Object.hasOwn(saved,'turnClock'),clock>0);
    const restored=createRoomStore({now:()=>100000});restored.importSnapshot(saved);
    assert.deepEqual(restored.exportSnapshot('123456'),saved);
    for(let schemaVersion=1;schemaVersion<=7;schemaVersion++) {
      const bad=structuredClone(saved);bad.schemaVersion=schemaVersion;
      assert.throws(()=>restored.importSnapshot(bad),error=>error.code==='INVALID_SNAPSHOT');
      assert.deepEqual(restored.exportSnapshot('123456'),saved);
    }
    if(clock) {f.act(0,'pause');f.act(1,'pause');const paused=f.store.exportSnapshot('123456');restored.importSnapshot(paused);assert.deepEqual(restored.exportSnapshot('123456'),paused);}
    f.store.close();restored.close();
  }
});

test('schema7 v3 imports and exports unchanged and only a genuinely new rematch adopts v4',()=>{
  const f=room({version:'friends-v3'}),old=f.store.exportSnapshot('123456');assert.equal(old.schemaVersion,7);
  const current=createRoomStore({now:()=>100000,turnTimeoutMs:60000,gameOptions:{firstTurnIndex:0}});current.importSnapshot(old);
  assert.deepEqual(current.exportSnapshot('123456'),old);
  const forged=structuredClone(old);forged.schemaVersion=8;
  assert.throws(()=>current.importSnapshot(forged),error=>error.code==='INVALID_SNAPSHOT');
  let n=0;
  const act=(index,type,fields={})=>current.trustedAction('123456',users[index],{type,requestId:`rematch-v4-${++n}`,expectedRevision:current.getTrustedView('123456',users[index]).revision,...fields});
  act(1,'leave');act(0,'rematch');current.joinTrustedRoom('123456',users[1],'乙');act(0,'ready',{ready:true});act(1,'ready',{ready:true});act(0,'start');
  assert.equal(current.getTrustedView('123456',users[0]).game.ruleVersion,'friends-v4');assert.equal(current.exportSnapshot('123456').schemaVersion,8);
  assert.deepEqual(old.game.ruleVersion,'friends-v3');current.close();f.store.close();
});

test('SQLite restart retains v4 schema8, stable seats and new opening scoring, and archives the native result once',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mirror-v4-')),path=join(directory,'data.sqlite'),key=randomBytes(32),opened=[];
  t.after(async()=>{for(const entry of opened){await entry.rooms?.close();entry.storage.close();}await rm(directory,{recursive:true,force:true});});
  const seed=room({rack:['red-13-a','joker-mirror-1','red-13-b']}),snapshot=seed.store.exportSnapshot('123456');seed.store.close();
  function open() {
    const storage=new EncryptedStore(new SQLiteAdapter(path,{now:()=>100000}),key,()=>100000);
    const history=createMatchHistory({storage,now:()=>100000});
    const rooms=createDurableRoomStore({storage,now:()=>100000,pollIntervalMs:60000});rooms.setHistory(history);
    const entry={storage,history,rooms};opened.push(entry);return entry;
  }
  const a=open();await a.storage.putIfAbsent('rooms',snapshot.roomId,{snapshot},Number.MAX_SAFE_INTEGER);
  await a.storage.putIfAbsent('room-invites','123456',{roomId:snapshot.roomId},Number.MAX_SAFE_INTEGER);
  const b=open(),view=await b.rooms.getView('123456',users[0]);assert.equal(view.selfId,seed.host.playerId);assert.equal(view.game.ruleVersion,'friends-v4');
  await assert.rejects(b.rooms.action('123456',users[0],{type:'submit',requestId:'v4-forged',expectedRevision:view.revision,
    boardIds:[['red-13-a','joker-mirror-1','red-13-b'],['black-13-a','blue-13-a','orange-13-a']],rackIds:[]}),/牌|手牌/);
  assert.deepEqual((await b.rooms.getView('123456',users[0])).game,view.game);
  const won=await b.rooms.action('123456',users[0],{type:'submit',requestId:'v4-finish',expectedRevision:view.revision,
    boardIds:[['red-13-a','joker-mirror-1','red-13-b']],rackIds:[]});
  assert.equal(won.view.phase,'finished');assert.equal(won.view.game.ruleVersion,'friends-v4');
  const finished=(await b.storage.read('rooms',snapshot.roomId)).value.snapshot;assert.equal(finished.schemaVersion,8);
  const c=open();assert.equal((await c.rooms.getView('123456',users[0])).selfId,seed.host.playerId);
  await Promise.all([b.rooms.flushPendingRecords(),c.rooms.flushPendingRecords()]);
  assert.equal((await c.history.get(users[0])).stats.wins,1);assert.equal((await c.history.get(users[0])).items[0].ruleVersion,'friends-v4');
  assert.equal((await c.history.get(users[1])).stats.losses,1);
  assert.equal((await c.storage.scan('game-history')).length,1);
});

test('schema8 capability forbids rollback to schema7 while preserving all nine backup scopes',()=>{
  const current=structuredClone(CURRENT_DATA_COMPATIBILITY),prior=structuredClone(current);
  prior.roomSnapshots={read:[1,2,3,4,5,6,7],write:[2,3,4,5,6,7]};
  const manifest=(id,dataCompatibility)=>({format:1,project:'game-room',releaseId:id.repeat(20),containsSecrets:false,containsUserData:false,dataCompatibility});
  assert.equal(compareReleaseCompatibility(manifest('a',current),manifest('b',prior)).rollbackCompatible,false);
  assert.equal(compareReleaseCompatibility(manifest('a',current),manifest('b',prior)).forwardCompatible,true);
  assert.deepEqual(current.backupScopes,prior.backupScopes);assert.equal(current.backupScopes.write.length,9);
});
