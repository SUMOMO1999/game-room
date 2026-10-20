import {openingGame,wrapOpeningGame as wrap,openingGameProblem,openingGameView as projection,openingGameClock as clock} from '../../../app/games/hyakki-trading/opening-game.mjs';
export {openingGameProblem} from '../../../app/games/hyakki-trading/opening-game.mjs';
import {randomInt} from 'node:crypto';
import {createHyakkiAdapter} from './adapter.mjs';
import {problem} from '../adapter-contract.mjs';
import {createOpening,openingProblem,openingView,openingCommandProblem,applyOpeningAction,expireOpening,cancelExpiredOpening,setOpeningManualPause} from '../../../app/games/hyakki-trading/opening.mjs';
import {waitingConfiguration,updateWaitingConfiguration} from '../../../app/games/hyakki-trading/opening-configuration.mjs';
import {EXPANSION_PACK_ID,EXPANSION_CONTENT_VERSION,CONFIGURABLE_RULE_VERSION,expansionDefinitionForCopy} from '../../../app/games/hyakki-trading/content/expansion-one.mjs';

// Phase-1 contract adapter, deliberately absent from the application registry.
// It exercises REAL room permissions, CAS, receipts, clocks and persistence.
// An initialized opening is not a playable full expansion; ordinary gameplay
// and the public event writer remain a separate gate before registration.
const copy=value=>structuredClone(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const count=room=>Math.max(2,room.players.length);
function changed(result){return result.ok?{...result,state:wrap(result.state),
  ...(result.state.status==='cancelled'?{cancelUnstartedMatch:true,roomPhase:'waiting'}:{})}:result;}
function domainAction(action){return Object.fromEntries(Object.entries(action).filter(([key])=>!['requestId','expectedRevision'].includes(key)));}
function actionProblem(action){
  const keys=action?.type==='confirm-role'?['type','requestId','expectedRevision','openingId','candidateId','roleId']
    :action?.type==='cancel-opening'?['type','requestId','expectedRevision','openingId']:null;
  if(!keys||!exact(action,keys)||!/^[A-Za-z0-9_-]{1,128}$/u.test(action.requestId??'')
    ||!Number.isSafeInteger(action.expectedRevision)||action.expectedRevision<0||!/^[a-f0-9]{32}$/u.test(action.openingId??'')
    ||action.type==='confirm-role'&&(typeof action.candidateId!=='string'||typeof action.roleId!=='string'))return problem(400,'INVALID_OPENING_ACTION','请选择本次开局的本人候选。');
  return null;
}
export function createHyakkiOpeningContractAdapter({initializeGame}={}){
  const legacy=createHyakkiAdapter(),types=['confirm-role','cancel-opening'];
  const completed=(result,context)=>{
    const wrapped=changed(result);
    return result.ok&&result.state.status==='completed'&&initializeGame
      ?{...wrapped,state:initializeGame(result.state,context)}:wrapped;
  };
  return Object.freeze({...legacy,ruleVersions:Object.freeze([...legacy.ruleVersions,CONFIGURABLE_RULE_VERSION]),
    actionTypes:Object.freeze([...legacy.actionTypes,...types]),concurrentActionTypes:Object.freeze(['confirm-role']),
    pausedActionTypes:Object.freeze(['cancel-opening']),businessCasAttempts:8,
    actionFields:type=>types.includes(type)?type==='confirm-role'?['openingId','candidateId','roleId']:['openingId']:legacy.actionFields(type),
    validateAction:action=>types.includes(action?.type)?actionProblem(action):legacy.validateAction(action),
    roomDefaults:()=>({turnClock:null,hyakkiConfig:waitingConfiguration({},{playerCount:2,newRoom:true})}),
    gameOptions:(room,options)=>room.hyakkiConfig.packId===EXPANSION_PACK_ID
      ?{openingId:options.matchId,hostId:room.hostId,configuration:room.hyakkiConfig,now:options.now,randomInt:options.serverRandomInt??randomInt}
      :legacy.gameOptions(room,options),
    createGame:(players,options)=>options.configuration?.packId===EXPANSION_PACK_ID
      ?wrap(createOpening(players.map(p=>p.id),options)):legacy.createGame(players,options),
    configure(room,action){
      if(!Object.hasOwn(room.hyakkiConfig,'packId'))return legacy.configure(room,action);
      try{
        const config=updateWaitingConfiguration(room.hyakkiConfig,action.hyakkiConfig,count(room)).configuration;
        if(config.packId!==EXPANSION_PACK_ID)return {problem:problem(409,'CONTRACT_ONLY','此内部验证适配器只运行扩展开局，原版沿原适配器。')};
        return {updates:{hyakkiConfig:config}};
      }catch(error){if(error instanceof RangeError)return {problem:problem(400,'INVALID_CONFIG',error.message)};throw error;}
    },
    playersChanged(room){if(!Object.hasOwn(room.hyakkiConfig,'packId'))return legacy.playersChanged(room);if(room.phase==='waiting'){
      room.hyakkiConfig=updateWaitingConfiguration(room.hyakkiConfig,{},count(room)).configuration;
      for(const p of room.players)p.ready=false;
    }},
    applyGameAction(game,actorId,action,context){
      if(!openingGame(game))return legacy.applyGameAction(game,actorId,action,context);
      const issue=actionProblem(action);if(issue)return {ok:false,code:issue.code,error:issue.message};
      // Host transfer is room-owned. It never redistributes candidates or time.
      const opening={...game.opening,hostId:context.hostId??game.opening.hostId};
      return completed(applyOpeningAction(opening,actorId,domainAction(action),{now:context.now,randomInt:context.serverRandomInt??randomInt}),context);
    },
    actionConcurrencyProblem(room,actorId,action,{now}){
      if(!openingGame(room.game)||room.game.opening.status!=='selecting'||action.type!=='confirm-role')return problem(409,'STALE_OPENING','这次选角已经结束。');
      const invalid=actionProblem(action);if(invalid)return invalid;
      const issue=openingCommandProblem(room.game.opening,actorId,domainAction(action),{now});
      return issue?problem(409,issue.code,issue.error):null;
    },
    privateView:(game,id,context)=>openingGame(game)?projection(game,id,context):legacy.privateView(game,id,context),
    spectatorView:(game,context)=>openingGame(game)?projection(game,null,context):legacy.spectatorView(game,context),
    stateProblem:game=>openingGame(game)?openingGameProblem(game):legacy.stateProblem(game),
    roomView:room=>Object.hasOwn(room.hyakkiConfig,'packId')
      ?{hyakkiConfig:copy(room.hyakkiConfig),exitPolicy:room.game?.opening.status==='selecting'?'cancel-opening':'cancel'}:legacy.roomView(room),
    playerSummary:(view,id)=>({handCount:view?.players.find(p=>p.id===id)?.handCount??0}),
    gameClock:game=>openingGame(game)?clock(game):legacy.gameClock(game),
    supportsTimeout:game=>openingGame(game)?openingGameProblem(game)===null&&clock(game)!==null:legacy.supportsTimeout(game),
    applyTimeout:(game,actor,context)=>openingGame(game)?completed(expireOpening(game.opening,{now:context.now,randomInt:context.serverRandomInt??randomInt}),context):legacy.applyTimeout(game,actor,context),
    describeTimeout:game=>openingGame(game)?'选角时间已到，未确认席位采用原候选的第一位。':legacy.describeTimeout(game),
    describeAction:context=>types.includes(context.action.type)
      ?context.action.type==='confirm-role'?'已确认角色。':'开局已取消，请重新准备。':legacy.describeAction(context),
    commonActionProblem:(room,id,action,context)=>openingGame(room.game)?null:legacy.commonActionProblem(room,id,action,context),
    onPhaseChanged(game,phase,now,context){return openingGame(game)?changed(setOpeningManualPause(game.opening,phase==='paused',{now})):legacy.onPhaseChanged(game,phase,now,context);},
    presenceBlocksActions:game=>!openingGame(game),
    lifecycleTransition(game,context){
      if(!openingGame(game))return legacy.lifecycleTransition(game,context);
      if(['presence','disconnected','server-recovery'].includes(context.reason))return {ok:true,state:game,changed:false};
      if(context.reason==='voluntary-leave')return changed(applyOpeningAction(game.opening,context.playerId,{type:'leave-opening',openingId:game.matchId},{now:context.now}));
      if(context.reason==='room-expired')return changed(cancelExpiredOpening(game.opening,{now:context.now}));
      return {ok:false,code:'OPENING_CONTRACT_ONLY',error:'开局以外的完整生命周期尚未装配。'};
    },
    unstartedCancellationProblem(before,after,{action,playerId,reason,room}){
      return openingGameProblem(before)||openingGameProblem(after)||before.opening.status!=='selecting'||after.opening.status!=='cancelled'
        ||before.matchId!==after.matchId||after.opening.deal!==null||after.opening.cancelledBy!==playerId
        ||(action?.type==='cancel-opening'?room.hostId!==playerId||after.opening.cancellationReason!=='host-cancelled'
          :reason==='room-expired'?playerId!==null||after.opening.cancellationReason!=='room-expired'
            :reason!=='voluntary-leave'||after.opening.cancellationReason!=='player-left');
    },
    actionDeadline(room,action){return !openingGame(room.game)?legacy.actionDeadline(room,action):room.game.opening.status==='selecting'
      &&['confirm-role','pause','resume'].includes(action.type)?room.game.opening.clock.deadlineAt:null;},
    roomRetentionDeadline:game=>openingGame(game)?null:legacy.roomRetentionDeadline(game),
    snapshotSchema:room=>Object.hasOwn(room.hyakkiConfig,'packId')?22:legacy.snapshotSchema(room),
    snapshotProblem:data=>data?.schemaVersion===22?data.gameType!=='hyakki-trading'||!Object.hasOwn(data,'turnClock')
      ||!Object.hasOwn(data.hyakkiConfig??{},'packId')||Buffer.byteLength(JSON.stringify(data),'utf8')>256*1024:legacy.snapshotProblem(data),
    roomStateProblem(room,hasRoles){
      if(!Object.hasOwn(room.hyakkiConfig??{},'packId'))return legacy.roomStateProblem(room,hasRoles);
      try{
        if(!hasRoles||!same(waitingConfiguration(room.hyakkiConfig,{playerCount:room.game?.players.length??count(room)}),room.hyakkiConfig))return '扩展房间设置无效。';
        if(!room.game)return room.phase==='waiting'&&room.turnClock===null?null:'等待房间状态无效。';
        const game=room.game,issue=openingGameProblem(game);if(issue)return issue;
        if(!['playing','paused'].includes(room.phase)||room.matchId!==game.matchId||room.matchStartedAt!==game.opening.createdAt
          ||game.opening.clock.paused!==(room.phase==='paused')||room.matchParticipants?.length!==game.players.length
          ||room.matchParticipants.some((p,i)=>!exact(p,['playerId','name','userKey'])||p.playerId!==game.players[i].id
            ||!/^[a-f0-9]{64}$/u.test(p.userKey??'')||typeof p.name!=='string'||!p.name.length)
          ||new Set(room.matchParticipants.map(p=>p.userKey)).size!==game.players.length
          ||room.players.some(p=>{const frozen=room.matchParticipants.find(f=>f.playerId===p.id);return !frozen||p.userKey!==frozen.userKey||p.name!==frozen.name;})
          ||room.players.some(p=>!game.players.some(g=>g.id===p.id))
          ||!same(game.opening.configuration.participantIds,room.players.map(p=>p.id)))return '开局参赛者或阶段不一致。';
        if(!same(waitingConfiguration(Object.fromEntries(Object.keys(room.hyakkiConfig).map(key=>[key,game.opening.configuration[key]])),{playerCount:game.players.length}),room.hyakkiConfig))return '开局配置必须冻结。';
        const c=clock(game),expected=c?{version:4,kind:c.kind,id:c.id,deadlineAt:c.deadlineAt,remainingMs:c.remainingMs,paused:c.paused,label:c.label,matchId:room.matchId}:null;
        return same(expected,room.turnClock)?null:'开局时钟不一致。';
      }catch(error){if(error instanceof RangeError)return error.message;throw error;}
    },
  });
}
