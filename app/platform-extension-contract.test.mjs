import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameRegistry,gameAdapter} from './game-registry.mjs';
import {createDurableRoomStore} from '../server/durable-rooms.mjs';
import {EncryptedStore,SQLiteAdapter} from '../server/storage.mjs';
import {createMatchHistory} from '../server/match-history.mjs';
import {requireAdapter,participantLimits,problem} from '../server/games/adapter-contract.mjs';

// Third minimal implementation exercises optional policies without importing
// PARKS or copying either existing game's rule/score implementation.
function minimalAdapter() {
  const validConfig=value=>value && Object.keys(value).length===2 && typeof value.solo==='boolean' && Number.isSafeInteger(value.steps) && value.steps>=0 && value.steps<=25;
  const stateProblem=state=>!state || state.ruleVersion!=='minimal-v1' || !['playing','finished'].includes(state.status)
    || !Array.isArray(state.players) || !Number.isSafeInteger(state.revision) || state.revision<0 ? 'minimal invalid state':null;
  const nextSystemStep=state=>state.status==='playing' && state.stage==='auto'?{id:`${state.matchId}:${state.revision}`,matchId:state.matchId,revision:state.revision}:null;
  return requireAdapter({...gameAdapter(),gameType:'minimal',minPlayers:1,maxPlayers:3,allowsSolo:true,ruleVersions:['minimal-v1'],usesActionIntents:true,
    actionTypes:['finish'],configurationFields:['minimalConfig'],historySummaryFields:['minimalSummary'],historyPlayerFields:[],historyPlayerOutcomes:['completed','unscored'],historySchemaVersion:4,
    matchSummary:undefined,gameClock:undefined,onPhaseChanged:undefined,lifecycleTransition:undefined,
    roomDefaults:()=>({minimalConfig:{solo:true,steps:3}}),participantLimits:room=>({waiting:{min:1,max:room.minimalConfig.solo?1:3},playing:{min:room.minimalConfig.solo?1:2,max:room.minimalConfig.solo?1:3}}),
    configurationSupportProblem:(room,action)=>room.phase==='waiting' && validConfig(action.minimalConfig)?null:problem(400,'INVALID_CONFIG','minimal config'),
    configure:(_room,action)=>({updates:{minimalConfig:structuredClone(action.minimalConfig)}}),roomView:room=>({minimalConfig:structuredClone(room.minimalConfig)}),
    gameOptions:(room,context)=>({...context,configuration:room.minimalConfig}),
    createGame:(players,options)=>({ruleVersion:'minimal-v1',players,matchId:options.matchId,configuration:options.configuration,revision:0,status:'playing',stage:options.configuration.steps?'auto':'human',result:null,round:1,turnIndex:0,reveals:[]}),
    stateProblem,privateView:(state,id)=>({status:state.status,revision:state.revision,players:state.players,stage:state.stage,result:state.result,privateMarker:id}),spectatorView:state=>({status:state.status,revision:state.revision,players:state.players,stage:state.stage}),
    actionFields:type=>type==='finish'?[]:null,validateAction:()=>null,
    applyGameAction:(state,id,_action,{now})=>({ok:true,state:{...structuredClone(state),status:'finished',result:{reason:'complete',settledAt:now,aborted:false,winnerIds:[id],scores:[],tie:false}}}),
    nextSystemStep,applySystemStep(state,step,context){assert.deepEqual(step,nextSystemStep(state));const next=structuredClone(state);next.reveals.push(context.serverRandomInt(100));next.revision++;if(next.revision===next.configuration.steps)next.stage='human';return {ok:true,state:next};},
    describeSystemStep:()=>null,playerSummary:()=>({}),playerResult:result=>({remainingPoints:null,outcome:result?'completed':'unscored'}),describeAction:()=>null,
    supportsTimeout:()=>false,snapshotSchema:()=>4,snapshotProblem:()=>false,roomStateProblem:()=>null,playersChanged:()=>{},gameEndedAt:game=>game.result.settledAt,
    historySummary:()=>({minimalSummary:{version:1}}),historySummaryProblem:summary=>summary.minimalSummary?.version!==1,
    historyPlayerProblem:(status,player)=>player.remainingPoints!==null || player.outcome!==(status==='completed'?'completed':'unscored'),historyOutcomeProblem:(wins,draws)=>wins!==0 || draws!==0,
  });
}
const user='1'.repeat(64),other='2'.repeat(64);
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'game-minimal-contract-')),path=join(directory,'test.sqlite'),key=randomBytes(32),opened=[];
  const adapter=minimalAdapter(),registry=createGameRegistry([adapter,gameAdapter()]);let randomCalls=0;
  const now=()=>1000;
  const open=()=>{const storage=new EncryptedStore(new SQLiteAdapter(path,{now}),key,now),rooms=createDurableRoomStore({storage,gameRegistry:registry,pollIntervalMs:0,serverRandomInt:()=>++randomCalls,now});opened.push({storage,rooms});return {storage,rooms};};
  t.after(async()=>{for(const item of opened){await item.rooms.close();item.storage.close();}await rm(directory,{recursive:true,force:true});});
  return {open,registry,adapter,randomCalls:()=>randomCalls};
}
async function act(rooms,code,type,extra={}) {const view=await rooms.getView(code,user);return rooms.action(code,user,{type,requestId:`${type}-${view.revision}`,expectedRevision:view.revision,...extra});}
test('third adapter solo limits/configuration creation and private SSE run real saved system steps across SQLite restart',async t=>{
  const f=await fixture(t),first=f.open();await first.rooms.ready;
  const created=await first.rooms.createRoom(user,'玩家','minimal-create','minimal',{minimalConfig:{solo:true,steps:3}});
  assert.deepEqual(created.view.participantLimits,{waiting:{min:1,max:1},playing:{min:1,max:1}});
  await assert.rejects(first.rooms.joinRoom(created.roomCode,other,'朋友','join'),error=>error.code==='ROOM_FULL');
  await act(first.rooms,created.roomCode,'ready',{ready:true});const views=[];const stop=await first.rooms.subscribe(created.roomCode,user,view=>views.push(view));
  const started=await act(first.rooms,created.roomCode,'start');assert.equal(started.view.game.stage,'human');assert.equal(started.view.game.revision,3);assert.equal(f.randomCalls(),3);
  assert.ok(views.some(view=>view.game?.revision===3));assert.ok(views.every(view=>!JSON.stringify(view).includes('userKey')));await stop();await first.rooms.close();
  const restarted=f.open();await restarted.rooms.ready;const restored=await restarted.rooms.getView(created.roomCode,user);assert.equal(restored.game.revision,3);assert.equal(f.randomCalls(),3);
  const history=createMatchHistory({storage:restarted.storage,gameRegistry:f.registry,now:()=>1000});restarted.rooms.setHistory(history);
  await act(restarted.rooms,created.roomCode,'finish');const results=await history.get(user);assert.equal(results.items.length,1);assert.equal(results.items[0].self.outcome,'completed');assert.deepEqual(results.items[0].minimalSummary,{version:1});
});
test('a saved but unknown system commit reconciles its cursor and owning receipt without replaying the reveal',async t=>{
  const f=await fixture(t),{rooms,storage}=f.open();await rooms.ready;
  const created=await rooms.createRoom(user,'玩家','unknown-create','minimal');await act(rooms,created.roomCode,'ready',{ready:true});
  const before=await rooms.getView(created.roomCode,user),start={type:'start',requestId:'unknown-start',expectedRevision:before.revision};
  const replace=storage.replaceCAS.bind(storage);let thrown=false;
  storage.replaceCAS=async(...args)=>{const result=await replace(...args);const record=(await storage.read('rooms',created.view.roomId))?.value;
    if(result && !thrown && record?.snapshot.game?.revision===1){thrown=true;throw new Error('saved result unknown');}return result;};
  await assert.rejects(rooms.action(created.roomCode,user,start),/unknown/);assert.equal(f.randomCalls(),1);
  const uncertain=await rooms.getView(created.roomCode,user);assert.equal(uncertain.game.revision,1);assert.equal(uncertain.actionReceipts.find(receipt=>receipt.requestId===start.requestId).status,'committed');
  const recovered=await rooms.action(created.roomCode,user,start);assert.equal(recovered.view.game.revision,3);assert.equal(f.randomCalls(),3);
  const snapshot=(await storage.read('rooms',created.view.roomId)).value.snapshot;assert.deepEqual(snapshot.game.reveals,[1,2,3]);
  await rooms.action(created.roomCode,user,start);assert.equal(f.randomCalls(),3);
});
test('omitted initial configuration preserves historical Rummikub create fingerprint and pending marker recovery',async t=>{
  const f=await fixture(t),{rooms,storage}=f.open();await rooms.ready;
  const created=await rooms.createRoom(user,'原房主','old-create');
  const key=createHash('sha256').update(`${user}\0create\0old-create`).digest('hex'),stored=await storage.read('room-requests',key);
  const expected=createHash('sha256').update(JSON.stringify({name:'原房主'})).digest('hex');assert.equal(stored.value.fingerprint,expected);
  const snapshot=(await storage.read('rooms',created.view.roomId)).value.snapshot;
  assert.equal(await storage.replaceCAS('room-requests',key,stored.version,{...stored.value,status:'pending',snapshot},stored.expiresAt),true);
  const recovered=await rooms.createRoom(user,'原房主','old-create');assert.equal(recovered.roomCode,created.roomCode);assert.equal(recovered.playerId,created.playerId);
  assert.equal((await storage.read('room-requests',key)).value.fingerprint,expected);assert.equal((await storage.scan('rooms')).length,1);
});
test('configuration is judged before profile/invitation writes and cannot shrink below waiting participants',async t=>{
  const f=await fixture(t),{rooms,storage}=f.open();await rooms.ready;
  await assert.rejects(rooms.createRoom(user,'玩家','bad','minimal',{minimalConfig:{solo:true,steps:-1}}),error=>error.code==='INVALID_CONFIG');
  for(const scope of ['game-profiles','room-invites','room-requests'])assert.equal((await storage.scan(scope)).length,0);
  const created=await rooms.createRoom(user,'玩家','good','minimal',{minimalConfig:{solo:false,steps:0}});await rooms.joinRoom(created.roomCode,other,'朋友','good-join');
  const before=await rooms.getView(created.roomCode,user);await assert.rejects(act(rooms,created.roomCode,'configure',{minimalConfig:{solo:true,steps:0}}),error=>error.code==='CONFIG_PARTICIPANTS');
  const after=await rooms.getView(created.roomCode,user);assert.deepEqual(after.minimalConfig,before.minimalConfig);assert.equal(after.revision,before.revision);
  assert.throws(()=>participantLimits({...before,minimalConfig:{solo:true}}, {...f.adapter,allowsSolo:false}));
});
