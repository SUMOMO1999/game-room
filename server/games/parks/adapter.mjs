/** Server assembly: private authoritative state never enters a room envelope. */
import * as core from '../../../app/games/parks/engine.mjs';
import * as views from '../../../app/games/parks/view.mjs';
import { CONTENT_VERSION, VOLUNTEER_PROJECTS } from '../../../app/games/parks/content/catalog.mjs';
import { DEFAULT_PARKS_CONFIGURATION } from '../../../app/games/parks/configuration.mjs';
import { problem } from '../adapter-contract.mjs';

const gameType='parks', clone=structuredClone;
const object=value=>value && typeof value==='object' && !Array.isArray(value);
const normalized=value=>Array.isArray(value)?value.map(normalized):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalized(value[key])])):value;
const canonical=value=>JSON.stringify(normalized(value));
const exact=(value,fields)=>object(value) && Object.keys(value).length===fields.length && fields.every(field=>Object.hasOwn(value,field));
const scoreKeys=['parks','photos','photoRanking','passion','fallBonus','firstPlayer'];
const playerKeys=['score','parkCount','breakdown','photoRank','soloRank','rankThreshold','difficulty'];
const ranges={standard:{min:2,max:5},teddy:{min:2,max:2},solo:{min:1,max:1}};
const projectIds=new Set(VOLUNTEER_PROJECTS.map(project=>project.id));
const actionResult=result=>result.ok?result:{...result,code:result.errorCode ?? result.code};
const intent=action=>Object.fromEntries(Object.entries(action).filter(([key])=>!['requestId','expectedRevision'].includes(key)));
const configProblem=value=>core.configurationProblem(value);
function configuration(room) { return core.normalizeConfiguration(room.parksConfig); }
function configurationIssue(room,action) {
  if (room.phase!=='waiting') return problem(409,'ROOM_LOCKED','开局前才能调整公园玩法。');
  if (!exact(action.parksConfig,['mode','camping','volunteerCount','passionChoice']) || configProblem(action.parksConfig)) return problem(400,'INVALID_CONFIG','请完整选择公园玩法。');
  return null;
}
function clock(game) {
  const window=game?.decisionWindow;
  if (game?.status!=='playing' || !window?.responsibleSeatId || window.status!=='open') return null;
  return {clockVersion:4,kind:game.stage==='move'?'turn':'decision',id:window.id,deadlineAt:window.deadlineAt,
    remainingMs:window.remainingMs,paused:window.paused,label:game.stage==='move'?'徒步行动':'当前选择'};
}
function roomProblem(room,hasRoles) {
  if (!hasRoles || room.gameType!==gameType || configProblem(room.parksConfig)
    || !Object.hasOwn(room,'turnClock') || !Array.isArray(room.players) || !Array.isArray(room.spectators)) return '公园房间设置无效。';
  if (room.phase==='waiting') return room.game!==null || room.turnClock!==null
    || ['matchId','matchStartedAt','matchEndedAt','matchParticipants'].some(key=>Object.hasOwn(room,key)) ? '等待房间不能保存已开局材料。' : null;
  const issue=core.stateProblem(room.game); if (issue) return issue;
  if (canonical(room.parksConfig)!==canonical(room.game.configuration) || room.game.matchId!==room.matchId
    || core.configurationProblem(room.game.configuration,room.game.players.length)) return '公园模式与冻结对局不一致。';
  const gameIds=room.game.players.map(player=>player.id), remaining=gameIds.filter(id=>room.players.some(player=>player.id===id));
  if (!Array.isArray(room.matchParticipants) || canonical(room.matchParticipants.map(player=>player.playerId))!==canonical(gameIds)
    || canonical(room.players.map(player=>player.id))!==canonical(['playing','paused'].includes(room.phase)?gameIds:remaining)
    || room.spectators.some(player=>gameIds.includes(player.id))) return '公园参与名单不能替换或重排。';
  if (room.matchParticipants.some(player=>!exact(player,['playerId','name',...(Object.hasOwn(player,'userKey')?['userKey']:[])])
    || typeof player.name!=='string' || !player.name.trim() || [...player.name].length>16 || /\p{Cc}/u.test(player.name)
    || Object.hasOwn(player,'userKey') && !/^[a-f0-9]{64}$/.test(player.userKey)
    || room.players.some(member=>member.id===player.playerId && (member.name!==player.name || member.userKey!==player.userKey)))
    || new Set(room.matchParticipants.filter(player=>player.userKey).map(player=>player.userKey)).size!==room.matchParticipants.filter(player=>player.userKey).length) return '公园席位归属不一致。';
  const terminal=['finished','aborted'].includes(room.phase);
  if (terminal ? room.game.status!=='finished' || room.turnClock!==null || room.matchEndedAt!==room.game.result.settledAt
    || room.game.result.aborted!==(room.phase==='aborted') : room.game.status!=='playing' || Object.hasOwn(room,'matchEndedAt')
      || room.game.decisionWindow.paused!==(room.phase==='paused')) return '公园阶段与保存材料不一致。';
  const expected=terminal?null:clock(room.game);
  const saved=expected?{version:4,...Object.fromEntries(Object.entries(expected).filter(([key])=>key!=='clockVersion')),matchId:room.matchId}:null;
  if (canonical(saved)!==canonical(room.turnClock)) return '公园决策时钟与窗口不一致。';
  return null;
}
function historyPlayerProblem(status,player) {
  if (player.remainingPoints!==null || playerKeys.some(key=>!Object.hasOwn(player,key))) return true;
  if (status==='aborted') return player.outcome!=='unscored' || playerKeys.some(key=>player[key]!==null);
  if (!Number.isSafeInteger(player.score) || player.score<0 || !Number.isSafeInteger(player.parkCount) || player.parkCount<0
    || !exact(player.breakdown,scoreKeys) || scoreKeys.some(key=>!Number.isSafeInteger(player.breakdown[key]) || player.breakdown[key]<0)
    || Object.values(player.breakdown).reduce((sum,value)=>sum+value,0)!==player.score
    || player.photoRank!==null && (!Number.isSafeInteger(player.photoRank) || player.photoRank<1 || player.photoRank>5)) return true;
  if (player.outcome==='completed') {
    const threshold=[50,45,40,35,30].find(value=>player.score>=value) ?? null;
    return player.rankThreshold!==threshold || player.soloRank!==({30:'Dayhiker',35:'Trekker',40:'Explorer',45:'Adventurer',50:'Trailblazer'}[threshold] ?? null)
      || !Number.isSafeInteger(player.difficulty) || player.difficulty<0 || player.difficulty>4;
  }
  return !['win','draw','loss'].includes(player.outcome) || ['soloRank','rankThreshold','difficulty'].some(key=>player[key]!==null);
}
export function createParksAdapter() {
  return Object.freeze({gameType,minPlayers:1,maxPlayers:5,allowsSolo:true,ruleVersions:[core.RULE_VERSION],usesActionIntents:true,
    actionTypes:Object.keys(core.actionFields),configurationFields:['parksConfig'],historySchemaVersion:4,
    historySummaryFields:['parksSummary'],historyPlayerFields:playerKeys,historyPlayerOutcomes:['win','draw','loss','unscored','completed'],
    maxSnapshotBytes:512*1024,businessCasAttempts:16,
    participantLimits:room=>({waiting:{min:1,max:ranges[configuration(room).mode].max},playing:{...ranges[configuration(room).mode]}}),
    roomDefaults:()=>({parksConfig:{...DEFAULT_PARKS_CONFIGURATION},turnClock:null}),
    configurationSupportProblem:configurationIssue,
    configure(room,action) { const issue=configurationIssue(room,action); return issue?{problem:issue}:{updates:{parksConfig:configuration({parksConfig:action.parksConfig})}}; },
    roomView:room=>({parksConfig:clone(room.parksConfig)}),
    gameOptions:(room,options)=>({...options,configuration:configuration(room)}),createGame:core.createGame,stateProblem:core.stateProblem,
    privateView:(game,id,context)=>views.privateView(game,id,context),spectatorView:(game,context)=>views.spectatorView(game,context),
    actionFields:type=>core.actionFields[type]?.filter(key=>key!=='type') ?? null,
    validateAction(action) { if (!Object.hasOwn(core.actionFields,action.type)) return null; const issue=core.validateActionShape(intent(action)); return issue?problem(400,'INVALID_ACTION',issue):null; },
    applyGameAction:(game,id,action,context)=>actionResult(core.applyGameAction(game,id,intent(action),context)),
    nextSystemStep:core.nextSystemStep,applySystemStep:core.applySystemStep,
    describeSystemStep:({afterGame})=>afterGame.lastPublicEvents?.at(-1)?.label ?? null,
    gameClock:clock,turnTimeoutMs:()=>0,supportsTimeout:game=>core.stateProblem(game)===null,
    applyTimeout:(game,_id,context)=>core.applyTimeout(game,{now:context.now,windowId:game.decisionWindow.id}),
    describeTimeout:()=> '选择时间已到，材料已保留；请当前责任人继续。',
    onPhaseChanged(game,phase,now) { return phase==='paused'?core.pauseGame(game,{now,cause:'vote'}):game.decisionWindow.paused?core.resumeGame(game,{now}):{ok:true,state:game}; },
    commonActionProblem(room,id,action) { return action.type==='resume' && room.game?.decisionWindow?.pauseCause==='timeout'
      && room.game.decisionWindow.responsibleSeatId!==id?problem(403,'RESPONSIBLE_SEAT_REQUIRED','请当前负责选择的朋友继续。'):null; },
    lifecycleTransition(game,{reason,now}) { const result=core.abortGame(game,{reason,now}); return {...result,roomPhase:'aborted',terminal:true,status:'aborted'}; },
    gameEndedAt:game=>game.result.settledAt,gameStatusForRoomPhase:phase=>['finished','aborted'].includes(phase)?'finished':'playing',
    snapshotSchema:()=>15,snapshotProblem:room=>room.schemaVersion!==15 || room.gameType!==gameType,
    roomStateProblem:roomProblem,playersChanged(room) { if (room.phase==='waiting') for(const player of room.players) player.ready=false; },
    playerSummary:(view,id)=>{const player=view?.players?.find(player=>player.id===id);return player?{score:player.score ?? null}:{};},
    playerResult(result,id) {const row=result?.scores?.find(row=>row.playerId===id);return {outcome:!row?'unscored':result.mode==='solo'?'completed':result.winnerIds.includes(id)?result.tie?'draw':'win':'loss',remainingPoints:null,
      ...Object.fromEntries(playerKeys.map(key=>[key,row?.[key] ?? null]))};},
    describeAction:({player,afterGame})=>`${player.name}完成${afterGame.lastPublicEvents?.at(-1)?.label ?? '公园行动'}。`,
    historySummary:(game)=>({parksSummary:{mode:game.configuration.mode,configuration:clone(game.configuration),contentVersion:CONTENT_VERSION,scoreBasis:'parks-2e-total-v1',projectIds:clone(game.projects)}}),
    historyPlayerProblem,
    historyOutcomeProblem:(wins,draws,count)=>count===1?wins!==0 || draws!==0:!(wins===1 && draws===0 || wins===0 && draws>=2),
    historySummaryProblem(summary) {
      const value=summary.parksSummary;
      if (!exact(value,['mode','configuration','contentVersion','scoreBasis','projectIds']) || configProblem(value.configuration)
        || value.mode!==value.configuration.mode || core.configurationProblem(value.configuration,summary.players.length)
        || value.contentVersion!==CONTENT_VERSION || value.scoreBasis!=='parks-2e-total-v1'
        || !Array.isArray(value.projectIds) || value.projectIds.length!==value.configuration.volunteerCount
        || new Set(value.projectIds).size!==value.projectIds.length || value.projectIds.some(id=>!projectIds.has(id))) return true;
      return summary.status==='completed' && summary.players.some(player=>value.mode==='solo'?player.outcome!=='completed' || player.difficulty!==value.projectIds.length:player.outcome==='completed');
    },
  });
}
