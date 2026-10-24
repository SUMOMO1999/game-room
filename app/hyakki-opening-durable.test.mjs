import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDurableRoomStore} from '../server/durable-rooms.mjs';
import {EncryptedStore,SQLiteAdapter,identityKey} from '../server/storage.mjs';
import {createGameRegistry,defaultGameRegistry} from './game-registry.mjs';
import {createHyakkiOpeningContractAdapter} from '../server/games/hyakki-trading/opening-contract-adapter.mjs';
import {expansionPartitionProblem} from './games/hyakki-trading/content/expansion-one.mjs';
import {openingGameProblem} from '../server/games/hyakki-trading/opening-contract-adapter.mjs';
import {createHyakkiAdapter,createHyakkiTransitionPreparers} from '../server/games/hyakki-trading/adapter.mjs';
import {createRoomStore} from './rooms.mjs';
import {CONTENT_VERSION,PLAYER_COUNT_CONTENT_VERSION,DIGITAL_RULE_VERSION,MULTIPLAYER_RULE_VERSION} from './games/hyakki-trading/content/definitions.mjs';
import {backupStore,verifyBackup,restoreStore} from '../server/backup.mjs';
import {validateHyakkiEventState,createHyakkiEventStore} from '../server/games/hyakki-trading/event-store.mjs';

const users=Array.from({length:8},(_,i)=>identityKey('urn:synthetic:merchant-opening',`member-${i}`));
const registry=()=>createGameRegistry(defaultGameRegistry.knownTypes().map(type=>type==='hyakki-trading'?createHyakkiOpeningContractAdapter():defaultGameRegistry.gameAdapter(type)),
  {creationTypes:[...defaultGameRegistry.creationTypes(),'hyakki-trading']});
const codeError=code=>error=>error.code===code;
async function fixture(t,n=2){
  const directory=mkdtempSync(join(tmpdir(),'merchant-opening-cas-')),path=join(directory,'room.sqlite'),key=randomBytes(32);
  let time=10_000,draws=0;const now=()=>time,entries=[];
  function open(){
    const storage=new EncryptedStore(new SQLiteAdapter(path,{now}),key,now);
    const rooms=createDurableRoomStore({storage,now,gameRegistry:registry(),pollIntervalMs:0,
      transitionPreparers:createHyakkiTransitionPreparers(storage,{now}),serverRandomInt:max=>{draws++;return max-1;}});
    const entry={rooms,storage,closed:false};entries.push(entry);return entry;
  }
  async function close(entry){if(!entry.closed){await entry.rooms.close();entry.storage.close();entry.closed=true;}}
  t.after(async()=>{for(const e of entries)await close(e);rmSync(directory,{recursive:true});});
  const a=open(),b=open();await Promise.all([a.rooms.ready,b.rooms.ready]);
  const room=await a.rooms.createRoom(users[0],'房主',randomUUID(),'hyakki-trading'),code=room.roomCode;
  for(let i=1;i<n;i++)await a.rooms.joinRoom(code,users[i],`玩家${i+1}`,randomUUID());
  const command=async(user,type,extras={},store=a.rooms)=>{
    const view=await store.getView(code,user);
    return store.action(code,user,{type,requestId:randomUUID(),expectedRevision:view.revision,...extras});
  };
  for(let i=0;i<n;i++)await command(users[i],'ready',{ready:true});
  const started=await command(users[0],'start');
  const snapshot=async()=> (await a.storage.read('rooms',started.view.roomId)).value.snapshot;
  const roleCommand=(view,index=0)=>({type:'confirm-role',requestId:randomUUID(),expectedRevision:view.revision,
    openingId:view.game.opening.openingId,candidateId:view.game.opening.self.candidateId,roleId:view.game.opening.self.candidates[index]});
  return {a,b,code,n,started,command,roleCommand,snapshot,open,close,path,key,directory,now,setTime:t=>{time=t;},draws:()=>draws};
}
for(const n of [2,6])test(`${n}席用真实SQLite双连接同时确认，独立私选、陈旧房间版本可重验、仅一次统一发牌`,async t=>{
  const f=await fixture(t,n);
  const views=await Promise.all(users.slice(0,n).map(user=>f.a.rooms.getView(f.code,user)));
  const initial=await f.snapshot(),draws=f.draws();
  assert.equal(initial.schemaVersion,22);assert.equal(initial.game.opening.deal,null);assert.equal(initial.turnClock.kind,'opening');
  assert.equal('turnId' in views[0].game,false);
  for(let i=0;i<n;i++){
    assert.equal(views[i].game.opening.self.candidates.length,3);
    assert.equal(views[i].game.players.some(p=>'silver' in p||'hand' in p),false);
    for(let j=0;j<n;j++)if(j!==i){
      for(const roleId of views[j].game.opening.self.candidates)assert.equal(JSON.stringify(views[i]).includes(roleId),false);
    }
  }
  const commands=views.map(view=>f.roleCommand(view));
  const results=await Promise.all(commands.map((body,i)=>(i%2?f.b.rooms:f.a.rooms).action(f.code,users[i],body)));
  assert.equal(results.length,n);
  const saved=await f.snapshot(),deal=saved.game.opening.deal;
  assert.equal(saved.game.stage,'initialized');assert.equal(saved.turnClock,null);assert.equal(openingGameProblem(saved.game),null);
  assert.equal(deal.deck.length,183+45*(n-2)-5*n);
  assert.equal(expansionPartitionProblem([...deal.deck,...deal.players.flatMap(p=>p.hand)],n),null);
  assert.equal(new Set(deal.players.map(p=>p.roleId)).size,n);
  assert.equal(saved.pendingRecords.length,0);
  // Retry after completion: the durable receipt wins before stage validation.
  await f.b.rooms.action(f.code,users[0],commands[0]);
  assert.deepEqual((await f.snapshot()).game,saved.game);
  assert.equal(f.draws()>draws,true);
  const receiptView=await f.a.rooms.getView(f.code,users[0]);
  assert.equal(receiptView.actionReceipts.find(r=>r.requestId===commands[0].requestId).status,'committed');
  const stranger=await f.a.rooms.joinRoom(f.code,users[7],'观众',randomUUID(),'spectator');
  assert.equal(stranger.view.game.opening.self,undefined);assert.equal(stranger.view.game.players.some(p=>'hand' in p),false);
  assert.equal(JSON.stringify(stranger.view).includes('unusedRoles'),false);
  await assert.rejects(f.command(users[7],'confirm-role',{openingId:initial.matchId,candidateId:commands[0].candidateId,roleId:commands[0].roleId}),/观众/);
});
test('真实房间拒绝越权／串候选和请求换正文，取消回准备且不建战绩',async t=>{
  const f=await fixture(t,6),before=await f.snapshot();
  const v0=await f.a.rooms.getView(f.code,users[0]),v1=await f.a.rooms.getView(f.code,users[1]);
  await assert.rejects(f.command(users[1],'confirm-role',{openingId:v1.matchId,candidateId:v0.game.opening.self.candidateId,roleId:v0.game.opening.self.candidates[0]}),codeError('STALE_CANDIDATE'));
  await assert.rejects(f.command(users[1],'cancel-opening',{openingId:v1.matchId}),codeError('WRONG_ACTOR'));
  assert.deepEqual((await f.snapshot()).game,before.game);
  const input=f.roleCommand(await f.a.rooms.getView(f.code,users[0]));
  await f.a.rooms.action(f.code,users[0],input);
  await assert.rejects(f.b.rooms.action(f.code,users[0],{...input,roleId:v0.game.opening.self.candidates[1]}),codeError('REQUEST_ID_REUSED'));
  const stopped=await f.command(users[0],'cancel-opening',{openingId:v0.matchId});
  assert.equal(stopped.view.phase,'waiting');assert.equal(stopped.view.game,null);assert.equal(stopped.view.matchId,null);
  const saved=await f.snapshot();assert.equal(saved.pendingRecords.length,0);assert.equal('lastMatchResult' in saved,false);
  assert.equal(saved.players.every(p=>p.ready===false),true);assert.equal(saved.turnClock,null);
  assert.equal((await f.a.storage.scan('match-history')).length,0);
  await assert.rejects(f.command(users[1],'confirm-role',{openingId:input.openingId,candidateId:input.candidateId,roleId:input.roleId}),codeError('GAME_NOT_PLAYING'));
});
test('离席事务先成立则无发牌、无战绩；新的开局不接受上一局意图',async t=>{
  const f=await fixture(t),old=await f.a.rooms.getView(f.code,users[1]),late=f.roleCommand(old);
  await f.command(users[0],'confirm-role',{openingId:old.matchId,candidateId:(await f.a.rooms.getView(f.code,users[0])).game.opening.self.candidateId,
    roleId:(await f.a.rooms.getView(f.code,users[0])).game.opening.self.candidates[0]});
  await f.command(users[1],'leave');
  const saved=await f.snapshot();assert.equal(saved.phase,'waiting');assert.equal(saved.game,null);assert.equal(saved.pendingRecords.length,0);
  await f.a.rooms.joinRoom(f.code,users[1],'再加入',randomUUID());
  await f.command(users[0],'ready',{ready:true});await f.command(users[1],'ready',{ready:true});await f.command(users[0],'start');
  await assert.rejects(f.b.rooms.action(f.code,users[1],late),codeError('STALE_OPENING'));
});
test('普通断线不阻止60秒期限，超时只补原第一候选；手动暂停保留余时且可取消',async t=>{
  const f=await fixture(t,6),saved=await f.snapshot();
  // No listeners are connected throughout this test. The real durable layer
  // still checks presence and uses the opening-stage opt-in to keep time.
  f.setTime(20_000);
  await f.command(users[0],'confirm-role',{openingId:saved.matchId,candidateId:`${saved.matchId}.${saved.game.players[0].id}`,roleId:saved.game.opening.candidates[saved.game.players[0].id][1]});
  for(let i=0;i<6;i++)await f.command(users[i],'pause',{agree:true});
  const paused=await f.snapshot();assert.equal(paused.phase,'paused');assert.equal(paused.turnClock.remainingMs,50_000);
  f.setTime(200_000);await f.command(users[0],'resume');
  assert.equal((await f.snapshot()).turnClock.deadlineAt,250_000);
  f.setTime(250_000);
  await f.a.rooms.sweep();
  const timed=await f.a.rooms.getView(f.code,users[0]),done=await f.snapshot();
  assert.equal(timed.game.stage,'initialized');
  done.game.opening.configuration.participantIds.forEach((id,i)=>assert.equal(done.game.opening.choices[id],saved.game.opening.candidates[id][i===0?1:0]));
  assert.equal(done.game.opening.deal.players.reduce((sum,p)=>sum+p.hand.length,0),30);
  const cancel=await fixture(t,2);
  await cancel.command(users[0],'pause',{agree:true});await cancel.command(users[1],'pause',{agree:true});
  assert.equal((await cancel.snapshot()).phase,'paused');
  await cancel.command(users[0],'cancel-opening',{openingId:cancel.started.view.matchId});
  assert.equal((await cancel.snapshot()).game,null);
});
test('转移房主后只有新房主能取消；不改变候选与原期限',async t=>{
  const f=await fixture(t,2),before=await f.snapshot();
  await f.command(users[0],'transferHost',{playerId:before.players[1].id});
  const after=await f.snapshot();assert.deepEqual(after.game,before.game);
  await assert.rejects(f.command(users[0],'cancel-opening',{openingId:before.matchId}),codeError('WRONG_ACTOR'));
  await f.command(users[1],'cancel-opening',{openingId:before.matchId});assert.equal((await f.snapshot()).phase,'waiting');
});
test('未发牌的手动暂停开局超过房间保留期，清理不制造终局／战绩',async t=>{
  const f=await fixture(t);
  await f.command(users[0],'pause',{agree:true});await f.command(users[1],'pause',{agree:true});
  const before=await f.snapshot();assert.equal(before.game.opening.deal,null);
  f.setTime(10_000+7*24*60*60*1000);
  await f.a.rooms.sweep();
  await assert.rejects(f.a.rooms.getView(f.code,users[0]),codeError('ROOM_NOT_FOUND'));
  const saved=(await f.a.storage.read('rooms',before.roomId))?.value;
  assert.equal((saved?.pendingRecords??[]).length,0);
  assert.equal((await f.a.storage.scan('game-history')).length,0);
});
test('最后确认的事务被拒绝时不留下半次发牌，原请求重试后才统一完成',async t=>{
  const f=await fixture(t),v0=await f.a.rooms.getView(f.code,users[0]);
  await f.a.rooms.action(f.code,users[0],f.roleCommand(v0));
  const v1=await f.a.rooms.getView(f.code,users[1]),command=f.roleCommand(v1,1),before=await f.snapshot();
  const commit=f.a.storage.compareAndSwapMany.bind(f.a.storage);let rejected=0;
  f.a.storage.compareAndSwapMany=async()=>{rejected++;return false;};
  await assert.rejects(f.a.rooms.action(f.code,users[1],command),codeError('STORE_BUSY'));
  f.a.storage.compareAndSwapMany=commit;
  assert.equal(rejected,8);assert.deepEqual((await f.snapshot()).game,before.game);
  assert.equal((await f.snapshot()).game.opening.deal,null);
  await f.a.rooms.action(f.code,users[1],command);
  const after=await f.snapshot();assert.equal(after.game.opening.status,'completed');
  assert.equal(after.game.opening.deal.players[1].roleId,command.roleId);
  assert.equal(after.game.opening.deal.players.every(p=>p.hand.length===5),true);
});
test('最后确认在提交时刚好到期，由真实存储期限拒绝并采用原默认，不接受迟到改选',async t=>{
  const f=await fixture(t),v0=await f.a.rooms.getView(f.code,users[0]);
  await f.a.rooms.action(f.code,users[0],f.roleCommand(v0));
  const v1=await f.a.rooms.getView(f.code,users[1]),command=f.roleCommand(v1,1);
  f.setTime(69_999);
  const commit=f.a.storage.compareAndSwapMany.bind(f.a.storage);let first=true;
  f.a.storage.compareAndSwapMany=async request=>{if(first){first=false;f.setTime(70_000);}return commit(request);};
  await assert.rejects(f.a.rooms.action(f.code,users[1],command),codeError('STALE_OPENING'));
  f.a.storage.compareAndSwapMany=commit;
  const after=await f.snapshot();assert.equal(after.game.opening.status,'completed');
  assert.equal(after.game.opening.choices[v1.selfId],v1.game.opening.self.candidates[0]);
  assert.notEqual(after.game.opening.choices[v1.selfId],command.roleId);
});
test('开局合同适配器也按旧规则读取并续行原110张／人数配比旧局',t=>{
  for(const [n,contentVersion,ruleVersion] of [[2,CONTENT_VERSION,DIGITAL_RULE_VERSION],[4,CONTENT_VERSION,MULTIPLAYER_RULE_VERSION],[6,PLAYER_COUNT_CONTENT_VERSION,MULTIPLAYER_RULE_VERSION]]){
    const original=createHyakkiAdapter(),legacy={...original,
      ...(contentVersion===CONTENT_VERSION?{roomDefaults:()=>({turnClock:null,hyakkiConfig:{actionLimit:5,goodsPerType:6}})}:{}),
      createGame:(players,options)=>original.createGame(players,{...options,contentVersion,ruleVersion})};
    const oldRegistry=createGameRegistry(defaultGameRegistry.knownTypes().map(type=>type==='hyakki-trading'?legacy:defaultGameRegistry.gameAdapter(type)),{creationTypes:['hyakki-trading']});
    const before=createRoomStore({gameRegistry:oldRegistry,now:()=>10_000,serverRandomInt:max=>max-1});
    const after=createRoomStore({gameRegistry:registry(),now:()=>10_000,serverRandomInt:max=>max-1});t.after(()=>{before.close();after.close();});
    const room=before.createTrustedRoom(users[0],'原房主',{gameType:'hyakki-trading',code:`10000${n}`,roomId:randomBytes(16).toString('hex')}),code=room.roomCode;
    for(let i=1;i<n;i++)before.joinTrustedRoom(code,users[i],`原玩家${i}`);
    const command=(store,user,type,extra={})=>store.trustedAction(code,user,{type,requestId:randomUUID(),expectedRevision:store.getTrustedView(code,user).revision,...extra});
    for(let i=0;i<n;i++)command(before,users[i],'ready',{ready:true});command(before,users[0],'start');
    const saved=before.exportSnapshot(code);after.importSnapshot(saved);
    assert.deepEqual(after.exportSnapshot(code),saved);assert.equal(after.getTrustedView(code,users[0]).game.contentVersion,contentVersion);
    const owner=users[saved.game.turnIndex];
    command(after,owner,'peek',{matchId:saved.matchId,turnId:saved.game.turnId});
    assert.equal(after.exportSnapshot(code).game.contentVersion,contentVersion);
    assert.equal(after.exportSnapshot(code).game.deck.length,contentVersion===CONTENT_VERSION?110-5*n-1:246-5*n-1);
  }
});
for(const completed of [false,true])test(`${completed?'已统一发牌及首条战况':'部分确认'}用真实18scope备份、新路径还原及独立新进程续入；旧正式读者明确拒绝新数据`,async t=>{
  const f=await fixture(t,6),v=await f.a.rooms.getView(f.code,users[0]);
  const input=f.roleCommand(v,1);await f.a.rooms.action(f.code,users[0],input);
  if(completed)for(let i=1;i<6;i++)await f.a.rooms.action(f.code,users[i],f.roleCommand(await f.a.rooms.getView(f.code,users[i])));
  const saved=await f.snapshot(),artifact=join(f.directory,'backup','opening.sqlite'),restored=join(f.directory,'recovery','room.sqlite');
  if(!completed){
    assert.equal(validateHyakkiEventState([],{rooms:[saved],now:f.now()}).heads.length,0);
    const fakeDealt=structuredClone(saved);fakeDealt.game.stage='initialized';
    assert.throws(()=>validateHyakkiEventState([],{rooms:[fakeDealt],now:f.now()}),codeError('GAME_HISTORY_REFERENCE'));
  }else assert.throws(()=>validateHyakkiEventState([],{rooms:[saved],now:f.now()}),codeError('GAME_HISTORY_REFERENCE'));
  const publicBefore=completed?(await createHyakkiEventStore({storage:f.a.storage,now:f.now}).readPage({matchId:saved.matchId})).page:null;
  await backupStore({sourcePath:f.path,destinationPath:artifact,key:f.key,now:f.now,gameRegistry:registry()});
  const verified=verifyBackup({sourcePath:artifact,key:f.key,gameRegistry:registry()});
  assert.equal(verified.manifest.scopes.length,18);assert.equal(verified.manifest.authSessionsIncluded,false);
  const originalReader=await import('../../../merchant-action-strip-2026-10-20/source/server/backup.mjs');
  assert.throws(()=>originalReader.verifyBackup({sourcePath:artifact,key:f.key}),
    error=>completed?['GAME_HISTORY_INVALID','GAME_HISTORY_CORRUPT'].includes(error.code):error.code==='INVALID_SNAPSHOT');
  restoreStore({sourcePath:artifact,destinationPath:restored,key:f.key,offline:true,gameRegistry:registry()});
  await f.close(f.a);await f.close(f.b);
  // Ephemeral test key only, never a real environment credential.
  const handoff=join(f.directory,'handoff.json');writeFileSync(handoff,JSON.stringify({path:restored,key:f.key.toString('hex'),code:f.code,user:users[0],at:70_000}),{mode:0o600});
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {readFileSync} from 'node:fs';
    import {EncryptedStore,SQLiteAdapter} from ${JSON.stringify(new URL('../server/storage.mjs',import.meta.url).href)};
    import {createDurableRoomStore} from ${JSON.stringify(new URL('../server/durable-rooms.mjs',import.meta.url).href)};
    import {createGameRegistry,defaultGameRegistry} from ${JSON.stringify(new URL('./game-registry.mjs',import.meta.url).href)};
    import {createHyakkiOpeningContractAdapter} from ${JSON.stringify(new URL('../server/games/hyakki-trading/opening-contract-adapter.mjs',import.meta.url).href)};
    import {createHyakkiTransitionPreparers} from ${JSON.stringify(new URL('../server/games/hyakki-trading/adapter.mjs',import.meta.url).href)};
    import {createHyakkiEventStore} from ${JSON.stringify(new URL('../server/games/hyakki-trading/event-store.mjs',import.meta.url).href)};
    const x=JSON.parse(readFileSync(process.argv[1],'utf8')),now=()=>x.at;
    const storage=new EncryptedStore(new SQLiteAdapter(x.path,{now}),Buffer.from(x.key,'hex'),now);
    const gameRegistry=createGameRegistry(defaultGameRegistry.knownTypes().map(t=>t==='hyakki-trading'?createHyakkiOpeningContractAdapter():defaultGameRegistry.gameAdapter(t)),{creationTypes:['hyakki-trading']});
    const rooms=createDurableRoomStore({storage,now,gameRegistry,pollIntervalMs:0,serverRandomInt:m=>m-1,
      transitionPreparers:createHyakkiTransitionPreparers(storage,{now})});await rooms.ready;
    await rooms.sweep();const view=await rooms.getView(x.code,x.user),saved=(await storage.read('rooms',view.roomId)).value.snapshot;
    const page=(await createHyakkiEventStore({storage,now}).readPage({matchId:saved.matchId})).page;
    process.stdout.write(JSON.stringify({view,opening:saved.game.opening,page}));await rooms.close();storage.close();
  `,handoff],{encoding:'utf8',timeout:20_000,maxBuffer:1024*1024});
  assert.equal(child.status,0,child.stderr);
  const result=JSON.parse(child.stdout);
  assert.deepEqual(result.opening.candidates,saved.game.opening.candidates);
  assert.equal(result.opening.choices[saved.players[0].id],input.roleId);
  assert.equal(result.opening.status,'completed');assert.equal(result.opening.deal.deck.length,333);
  assert.equal(result.opening.deal.createdAt,completed?saved.game.opening.deal.createdAt:70_000);
  assert.equal(result.opening.deal.players.every(p=>p.hand.length===5),true);
  assert.equal(result.page.groups.length,1);assert.equal(result.page.headSequence,1);assert.equal(result.page.groups[0].schemaVersion,4);
  if(completed){assert.deepEqual(result.opening,saved.game.opening);assert.deepEqual(result.page,publicBefore);}
});

test('最后选角的首条公开历史写盘失败，角色／发牌／回执整体回滚，原请求可安全重试',async t=>{
  const f=await fixture(t),v0=await f.a.rooms.getView(f.code,users[0]);
  await f.a.rooms.action(f.code,users[0],f.roleCommand(v0));
  const command=f.roleCommand(await f.a.rooms.getView(f.code,users[1])),before=await f.snapshot();
  f.a.storage.adapter.db.exec("CREATE TRIGGER stop_opening_history BEFORE INSERT ON game_records WHEN NEW.key LIKE 'hyakki-events:%' BEGIN SELECT RAISE(ABORT,'test history disk failure'); END");
  await assert.rejects(f.a.rooms.action(f.code,users[1],command),/test history disk failure/);
  assert.deepEqual(await f.snapshot(),before);
  assert.equal((await f.a.storage.scan('hyakki-events')).length,0);assert.equal((await f.a.storage.scan('hyakki-event-meta')).length,0);
  f.a.storage.adapter.db.exec('DROP TRIGGER stop_opening_history');
  await f.a.rooms.action(f.code,users[1],command);
  const complete=await f.snapshot();assert.equal(complete.game.opening.status,'completed');
  const events=createHyakkiEventStore({storage:f.a.storage,now:f.now});
  const page=(await events.readPage({matchId:complete.matchId})).page;
  assert.equal(page.headSequence,1);assert.equal(page.groups.length,1);
  const beforeRetry=await f.a.storage.scan('hyakki-event-meta');
  await f.b.rooms.action(f.code,users[1],command);
  assert.deepEqual(await f.a.storage.scan('hyakki-event-meta'),beforeRetry);
});
