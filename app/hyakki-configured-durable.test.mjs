import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {EncryptedStore,SQLiteAdapter,identityKey} from '../server/storage.mjs';
import {createDurableRoomStore} from '../server/durable-rooms.mjs';
import {createConfiguredHyakkiAdapter} from '../server/games/hyakki-trading/configured-adapter.mjs';
import {createHyakkiTransitionPreparers} from '../server/games/hyakki-trading/adapter.mjs';
import {createHyakkiEventStore} from '../server/games/hyakki-trading/event-store.mjs';
import {createGameRegistry,defaultGameRegistry} from './game-registry.mjs';
import {backupStore,verifyBackup,restoreStore} from '../server/backup.mjs';
import {historyPacketProblem} from './games/hyakki-trading/room-controller.mjs';

const users=Array.from({length:6},(_,i)=>identityKey('urn:merchant-configured',`member-${i}`));
const registry=()=>createGameRegistry(defaultGameRegistry.knownTypes().map(type=>type==='hyakki-trading'?createConfiguredHyakkiAdapter():defaultGameRegistry.gameAdapter(type)),{creationTypes:['hyakki-trading']});
async function fixture(t,n=2,packId='six-trades-v1'){
  const dir=mkdtempSync(join(tmpdir(),'merchant-configured-')),path=join(dir,'game.sqlite'),key=randomBytes(32),now=()=>10000;
  const storage=new EncryptedStore(new SQLiteAdapter(path,{now}),key,now);let draws=0;
  const rooms=createDurableRoomStore({storage,now,pollIntervalMs:0,gameRegistry:registry(),transitionPreparers:createHyakkiTransitionPreparers(storage,{now}),
    serverRandomInt:max=>{draws++;return max===11&&draws<24?0:max-1;}});await rooms.ready;
  const disconnect=[];
  let closed=false;const close=async()=>{if(!closed){for(const stop of disconnect)await stop();await rooms.close();storage.close();closed=true;}};
  t.after(async()=>{await close();rmSync(dir,{recursive:true,force:true});});
  const first=await rooms.createRoom(users[0],'首家',randomUUID(),'hyakki-trading'),code=first.roomCode;
  for(let i=1;i<n;i++)await rooms.joinRoom(code,users[i],`成员${i}`,randomUUID());
  for(let i=0;i<n;i++)disconnect.push(await rooms.subscribe(code,users[i],()=>{}));
  const command=async(user,type,extra={})=>{
    const v=await rooms.getView(code,user),p=v.game?.pending;
    return rooms.action(code,user,{type,requestId:randomUUID(),expectedRevision:v.revision,
      ...(!['configure','ready','start','pause','resume','leave','reset','confirm-role'].includes(type)?{matchId:v.matchId,turnId:v.game.turnId,
        ...(p?{effectId:p.id,decisionId:p.decisionId}:{})}:{}),...extra});
  };
  await command(users[0],'configure',{hyakkiConfig:{actionLimit:2,packId,closingTarget:30}});
  for(let i=0;i<n;i++)await command(users[i],'ready',{ready:true});
  await command(users[0],'start');
  if(packId==='six-trades-v1'){
    const selected=await Promise.all(users.slice(0,n).map(u=>rooms.getView(code,u)));
    await Promise.all(selected.map((v,i)=>command(users[i],'confirm-role',{openingId:v.matchId,candidateId:v.game.opening.self.candidateId,
      roleId:v.game.opening.self.candidates[0]})));
  }
  const snapshot=async()=>{const v=await rooms.getView(code,users[0]);return (await storage.read('rooms',v.roomId)).value.snapshot;};
  return {dir,path,key,now,storage,rooms,code,command,snapshot,close};
}
for(const n of [2,6])test(`${n}人真实房间：统一选角直达首回合，最后行动的账房私弃完成才换人并原子记组4`,async t=>{
  const f=await fixture(t,n),initial=await f.snapshot();
  assert.equal(initial.game.version,3);assert.equal(initial.game.kind,undefined);assert.equal(initial.game.stage,'draw');
  assert.equal(initial.game.players[0].roleId,'yousei.role.r11');
  const card=initial.game.players[0].hand.find(id=>id.startsWith('yousei.g01#'));assert.ok(card);
  const events=createHyakkiEventStore({storage:f.storage,now:f.now});
  assert.equal((await events.readPage({matchId:initial.matchId})).page.headSequence,1);
  await f.command(users[0],'peek');await f.command(users[0],'keep-peek');await f.command(users[0],'buy',{cardId:card});
  const pending=await f.snapshot();assert.equal(pending.game.pending.code,'R11');assert.equal(pending.game.turnPlayerId,initial.game.turnPlayerId);
  assert.equal(pending.game.actionsUsed,2);assert.equal(pending.game.players[0].silver,17);
  const privateV=await f.rooms.getView(f.code,users[0]),other=await f.rooms.getView(f.code,users[1]);
  assert.ok(privateV.game.pending.choice.options.length);assert.equal(other.game.pending.choice.options,undefined);
  const page=(await events.readPage({matchId:initial.matchId})).page;
  assert.equal(page.headSequence,4);assert.equal(historyPacketProblem(page,privateV),null);
  await f.command(users[0],'choose-effect',{selection:privateV.game.pending.choice.defaultSelection});
  const after=await f.snapshot();assert.equal(after.game.turnPlayerId,after.game.players[1].id);assert.equal(after.game.publicEventSequence,5);
  const last=(await events.readPage({matchId:initial.matchId,after:4})).page;
  assert.equal(last.groups.length,1);assert.equal(historyPacketProblem(last,await f.rooms.getView(f.code,users[1]),4),null);
});
test('实际普通回合待私弃经18scope备份／独立新路径／新进程恢复，原义务与费用保持',async t=>{
  const f=await fixture(t),initial=await f.snapshot(),card=initial.game.players[0].hand.find(id=>id.startsWith('yousei.g01#'));
  await f.command(users[0],'peek');await f.command(users[0],'keep-peek');await f.command(users[0],'buy',{cardId:card});
  const saved=await f.snapshot(),artifact=join(f.dir,'backup','game.sqlite'),recovery=join(f.dir,'recovered','game.sqlite');
  await backupStore({sourcePath:f.path,destinationPath:artifact,key:f.key,now:f.now,gameRegistry:registry()});
  assert.equal(verifyBackup({sourcePath:artifact,key:f.key,gameRegistry:registry()}).manifest.scopes.length,18);
  restoreStore({sourcePath:artifact,destinationPath:recovery,key:f.key,offline:true,gameRegistry:registry()});
  await f.close();
  const handoff=join(f.dir,'handoff.json');writeFileSync(handoff,JSON.stringify({path:recovery,key:f.key.toString('hex'),code:f.code,user:users[0],users:users.slice(0,2),roomId:saved.roomId}),{mode:0o600});
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
    import {EncryptedStore,SQLiteAdapter} from ${JSON.stringify(new URL('../server/storage.mjs',import.meta.url).href)};
    import {createDurableRoomStore} from ${JSON.stringify(new URL('../server/durable-rooms.mjs',import.meta.url).href)};
    import {createConfiguredHyakkiAdapter} from ${JSON.stringify(new URL('../server/games/hyakki-trading/configured-adapter.mjs',import.meta.url).href)};
    import {createHyakkiTransitionPreparers} from ${JSON.stringify(new URL('../server/games/hyakki-trading/adapter.mjs',import.meta.url).href)};
    import {createGameRegistry,defaultGameRegistry} from ${JSON.stringify(new URL('./game-registry.mjs',import.meta.url).href)};
    const x=JSON.parse(readFileSync(process.argv[1],'utf8')),now=()=>10000;
    const storage=new EncryptedStore(new SQLiteAdapter(x.path,{now}),Buffer.from(x.key,'hex'),now);
    const before=(await storage.read('rooms',x.roomId)).value.snapshot.game;
    const gameRegistry=createGameRegistry(defaultGameRegistry.knownTypes().map(t=>t==='hyakki-trading'?createConfiguredHyakkiAdapter():defaultGameRegistry.gameAdapter(t)),{creationTypes:['hyakki-trading']});
    const rooms=createDurableRoomStore({storage,now,gameRegistry,pollIntervalMs:0,transitionPreparers:createHyakkiTransitionPreparers(storage,{now})});await rooms.ready;
    const stops=[];for(const user of x.users)stops.push(await rooms.subscribe(x.code,user,()=>{}));
    const view=await rooms.getView(x.code,x.user);
    await rooms.action(x.code,x.user,{type:'choose-effect',requestId:randomUUID(),expectedRevision:view.revision,matchId:view.matchId,turnId:view.game.turnId,
      effectId:view.game.pending.id,decisionId:view.game.pending.decisionId,selection:view.game.pending.choice.defaultSelection});
    const after=(await storage.read('rooms',view.roomId)).value.snapshot.game;
    process.stdout.write(JSON.stringify({before,view,after}));for(const stop of stops)await stop();await rooms.close();storage.close();
  `,handoff],{encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);const restored=JSON.parse(child.stdout);
  assert.deepEqual(restored.before,saved.game);assert.equal(restored.view.game.pending.code,'R11');
  assert.equal(restored.view.game.pending.choice.actorId,saved.game.turnPlayerId);
  assert.equal(restored.after.turnPlayerId,saved.game.players[1].id);assert.equal(restored.after.players[0].silver,17);
});

for(let n=2;n<=6;n++)test(`${n}人取消扩展后真实开局仍为原六货及按人数牌量，可调金额冻结并记录组4`,async t=>{
  const f=await fixture(t,n,'base'),state=await f.snapshot(),owner=state.game.turnIndex;
  assert.equal(state.game.version,3);assert.equal(state.game.contentVersion,'yousei-content-v2');assert.equal(state.game.configuration.closingTarget,30);
  assert.equal(state.game.deck.length,110+34*(n-2)-5*n);assert.equal(Object.keys(state.game.bankGoods).length,6);
  assert.equal(state.game.players.some(p=>'roleId' in p),false);assert.equal(state.game.stage,'draw');
  const card=state.game.players[owner].hand.find(id=>id.startsWith('yousei.g'));
  await f.command(users[owner],'peek');await f.command(users[owner],'keep-peek');await f.command(users[owner],'buy',{cardId:card});
  const after=await f.snapshot();assert.equal(after.game.publicEventSequence,4);
  const page=(await createHyakkiEventStore({storage:f.storage,now:f.now}).readPage({matchId:state.matchId})).page;
  assert.equal(historyPacketProblem(page,await f.rooms.getView(f.code,users[owner])),null);
  const event=page.groups.at(-1).events.find(e=>e.type==='trade-bought');assert.equal(event.price.roleAdjustment,0);assert.equal(event.price.buyTax,0);
  assert.equal(event.silver,event.price.goodsPrice+event.price.temporaryFee);
});
