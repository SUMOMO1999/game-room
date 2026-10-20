/** Version dispatcher for one shared local-save/clock/queue implementation. */
import {legacyPracticeRuntime as legacy,PRACTICE_SELF,PRACTICE_BOTS,decodeHyakkiPractice,encodeHyakkiPractice,
  PRACTICE_SAVE_MAX_BYTES,PRACTICE_JOURNAL_MAX_BYTES} from '../practice-legacy.mjs';
import {randomStream} from '../practice-session.mjs';
import {createOpening,applyOpeningAction,expireOpening} from '../opening.mjs';
import {openingGame,wrapOpeningGame,openingGameProblem,openingGameView,openingGameClock} from '../opening-game.mjs';
import {waitingConfiguration,materialForConfiguration} from '../opening-configuration.mjs';
import {EXPANSION_PACK_ID} from '../content/expansion-one.mjs';
import * as rules from './rules.mjs';
import {privateView} from './view.mjs';
import {createConfiguredBase,isConfiguredBase,baseToLegacy,baseAction,baseTimeout,basePrivateView,baseGameProblem} from './base.mjs';
import {projectConfiguredHistory} from './history.mjs';
import {encodeHistory4Metadata,history4GroupProblem,history4RoleProblem} from '../public-history-v4.mjs';
import {chooseHyakkiPracticeAction} from './practice-bot.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const stamp=n=>Number.isSafeInteger(n)&&n>=0&&n<Number.MAX_SAFE_INTEGER-2000000;
const hex=id=>typeof id==='string'&&/^[a-f0-9]{32}$/u.test(id);
const bytes=v=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v)).byteLength;
const fault=(code,message)=>Object.assign(new Error(message),{code});
const configured=g=>g?.version===3;
const idsOf=g=>g.players.map(p=>p.id);
const configOf=g=>g.configuration??g.opening.configuration;
const gameIssue=g=>openingGame(g)?openingGameProblem(g):isConfiguredBase(g)?baseGameProblem(g):rules.gameProblem(g);
const pendingActor=g=>openingGame(g)?g.players.find(p=>p.id!==PRACTICE_SELF&&!g.opening.choices[p.id])?.id??PRACTICE_SELF
  :isConfiguredBase(g)?legacy.actor(baseToLegacy(g)):rules.currentDecision(g)?.actorId??g.turnPlayerId;
const clockOf=g=>!configured(g)?legacy.clock(g):openingGame(g)?{...openingGameClock(g),actorId:pendingActor(g)}
  :isConfiguredBase(g)?legacy.clock(baseToLegacy(g)):g.timing.decision??g.timing.active;
const decisionOf=g=>!configured(g)?legacy.currentDecision(g):openingGame(g)?{actorId:pendingActor(g),id:g.matchId}
  :isConfiguredBase(g)?legacy.currentDecision(baseToLegacy(g)):rules.currentDecision(g);
function viewOf(g,id){
  if(!configured(g))return legacy.privateView(g,id);
  if(openingGame(g))return {...openingGameView(g,id),gameType:'hyakki-trading',viewerId:id,configuration:structuredClone(g.opening.configuration),clock:openingGameClock(g)};
  return isConfiguredBase(g)?basePrivateView(g,id):privateView(g,id);
}
function opened(result){return result.ok?{...result,state:result.state.status==='completed'?rules.fromOpening(result.state):wrapOpeningGame(result.state)}:result;}
function apply(g,id,action,ctx){
  if(!configured(g))return legacy.applyGameAction(g,id,action,ctx);
  if(openingGame(g))return opened(applyOpeningAction(g.opening,id,Object.fromEntries(Object.entries(action).filter(([key])=>!['expectedRevision','requestId'].includes(key))),ctx));
  return (isConfiguredBase(g)?baseAction:rules.applyGameAction)(g,id,action,ctx);
}
function timeout(g,id,ctx){return !configured(g)?legacy.applyTimeout(g,id,ctx):openingGame(g)?opened(expireOpening(g.opening,ctx)):(isConfiguredBase(g)?baseTimeout:rules.applyTimeout)(g,id,ctx);}
function room(g){return {game:g,roomId:g.matchId,matchId:g.matchId,matchStartedAt:0,
  matchParticipants:idsOf(g).map(playerId=>({playerId,userKey:playerId.repeat(2)}))};}
function group(before,after){
  if(openingGame(after))return null;
  const projection=projectConfiguredHistory(before?room(before):null,room(after));
  if(!projection)return null;
  const context={contentVersion:after.contentVersion,participantIds:idsOf(after)};
  const value={schemaVersion:4,roomId:after.matchId,matchId:after.matchId,sequence:projection.sequence,committedAt:projection.committedAt,
    events:structuredClone(projection.events),...context,metadata:encodeHistory4Metadata(projection.metadata,context)};
  const issue=history4GroupProblem(value,context,{wire:true});if(issue)throw new TypeError(issue);return value;
}
function fresh(options){
  if(options.packId===undefined&&options.closingTarget===undefined)return legacy.fresh(options);
  const {playerCount=2,actionLimit=5,goodsPerType,goodsSupplyMode,packId=EXPANSION_PACK_ID,closingTarget=60,requestId,seed}=options;
  const configuration=waitingConfiguration({packId,actionLimit,closingTarget,...(goodsPerType===undefined?{}:{goodsPerType}),
    ...(goodsSupplyMode===undefined?{}:{goodsSupplyMode})},{playerCount,newRoom:true});
  const ids=[PRACTICE_SELF,...PRACTICE_BOTS.slice(0,playerCount-1)],matchId=requestId();if(!hex(matchId))throw fault('PRACTICE_ID_INVALID','练习编号无效。');
  const initial=seed??(globalThis.crypto.getRandomValues(new Uint32Array(1))[0]||1);
  if(!Number.isInteger(initial)||initial<1||initial>0xffffffff)throw fault('PRACTICE_RANDOM_INVALID','练习随机种子无效。');
  const random=randomStream(initial),game=packId===EXPANSION_PACK_ID?wrapOpeningGame(createOpening(ids,{openingId:matchId,hostId:PRACTICE_SELF,now:0,configuration,randomInt:random.randomInt}))
    :createConfiguredBase(ids,{configuration,matchId,now:0,firstPlayerId:ids[random.randomInt(playerCount)],randomInt:random.randomInt});
  const first=group(null,game);
  return {version:3,kind:'hyakki-local-practice',matchId,logicalNow:0,rngState:random.state,game,configuration,
    journal:{schema:2,matchId,groups:first?[first]:[]}};
}
function savedProblem(saved){
  if(!exact(saved,['version','kind','matchId','logicalNow','rngState','game','configuration','journal'])||saved.version!==3||saved.kind!=='hyakki-local-practice'
    ||!hex(saved.matchId)||!stamp(saved.logicalNow)||!Number.isInteger(saved.rngState)||saved.rngState<1||saved.rngState>0xffffffff)return '扩展练习存档格式无效。';
  const g=saved.game,issue=gameIssue(g);if(issue)return issue;
  const config=configOf(g);try{materialForConfiguration(config);if(!same(waitingConfiguration(saved.configuration,{playerCount:idsOf(g).length}),saved.configuration))return '练习设置无效。';}catch{return '冻结设置无效。';}
  if(g.matchId!==saved.matchId||!same(idsOf(g),[PRACTICE_SELF,...PRACTICE_BOTS.slice(0,g.players.length-1)])
    ||!Object.keys(saved.configuration).every(k=>same(saved.configuration[k],config[k]))
    ||(openingGame(g)?g.opening.createdAt!==0||g.opening.updatedAt>saved.logicalNow||g.opening.status!=='selecting'
      :g.lifecycle.startedAt!==0||g.committedAt>saved.logicalNow||g.lifecycle.manual||g.lifecycle.absence||g.lifecycle.capacity||!['playing','finished'].includes(g.status)))return '练习归属或计时无效。';
  const j=saved.journal;if(!exact(j,['schema','matchId','groups'])||j.schema!==2||j.matchId!==g.matchId||!Array.isArray(j.groups)||j.groups.length>100000)return '练习战况无效。';
  const context={contentVersion:g.contentVersion,participantIds:idsOf(g)},roles=g.players.map(p=>({seatId:p.id,roleId:p.roleId}));
  let previous=0;for(const [index,item] of j.groups.entries()){
    if(history4GroupProblem(item,context,{wire:true})||history4RoleProblem(item,roles,context)||item.roomId!==g.matchId||item.matchId!==g.matchId||item.sequence!==index+1
      ||item.committedAt<previous||item.committedAt>saved.logicalNow)return '练习公开记录不连续。';previous=item.committedAt;
  }
  if(j.groups.length!==(openingGame(g)?0:g.publicEventSequence))return '练习战况与进度不一致。';return null;
}
function decode(raw){try{
  if(typeof raw!=='string'||bytes(raw)>PRACTICE_SAVE_MAX_BYTES)return null;const saved=JSON.parse(raw);
  if(saved?.version!==3)return decodeHyakkiPractice(raw);
  return savedProblem(saved)||bytes(saved.journal)>PRACTICE_JOURNAL_MAX_BYTES?null:saved;
}catch{return null;}}
function encode(saved){if(saved?.version!==3)return encodeHyakkiPractice(saved);const issue=savedProblem(saved);if(issue)throw fault('PRACTICE_SAVE_INVALID',issue);
  const text=JSON.stringify(saved);if(bytes(saved.journal)>PRACTICE_JOURNAL_MAX_BYTES||bytes(text)>PRACTICE_SAVE_MAX_BYTES)throw fault('PRACTICE_SAVE_CAPACITY','完整战况达到本机保存上限；本页保留全部进度，关闭后只能恢复此前成功保存的进度。');return text;}
const fields={peek:['inspect?'],buy:['cardId','materials?'],sell:['cardId','materials?'],'use-role':['params?'],
  'confirm-role':['openingId','candidateId','roleId']};
function validFields(type,value){const keys=Object.hasOwn(fields,type)?fields[type]:null;if(!keys)return legacy.validFields(type,value);
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k)||keys.includes(k+'?'))&&keys.filter(k=>!k.endsWith('?')).every(k=>Object.hasOwn(value,k));}
function choose(view,id,options){if(view?.kind==='hyakki-opening-game')return view.opening.self&&!view.opening.self.confirmedRoleId?
  {type:'confirm-role',openingId:view.matchId,candidateId:view.opening.self.candidateId,roleId:view.opening.self.candidates[0]}:null;
  return view.version!==3?legacy.chooseAction(view,id,options):isConfiguredBase(view)?legacy.chooseAction({...view,version:2,ruleVersion:'yousei-digital-v2'},id,options):chooseHyakkiPracticeAction(view,id,options);}
export const configuredPracticeRuntime={...legacy,fresh,decode,encode,validFields,chooseAction:choose,currentDecision:decisionOf,clock:clockOf,actor:pendingActor,privateView:viewOf,
  applyGameAction:apply,applyTimeout:timeout,restartFields:[...legacy.restartFields,'packId','closingTarget'],
  context:(g,decision)=>openingGame(g)?{openingId:g.matchId}:legacy.context(g,decision),
  transition(saved,g,rngState,logicalNow){if(saved.version!==3)return legacy.transition(saved,g,rngState,logicalNow);
    const next=group(saved.game,g);return {...saved,game:g,rngState,logicalNow,journal:{...saved.journal,groups:[...saved.journal.groups,...(next?[next]:[])]}};},
  history(saved,{after,limit}){if(saved.version!==3)return legacy.history(saved,{after,limit});const groups=[];let size=1024;
    for(const item of saved.journal.groups.filter(g=>g.sequence>after).slice(0,limit)){if(size+bytes(item)>256*1024)break;groups.push(structuredClone(item));size+=bytes(item);}
    const headSequence=openingGame(saved.game)?0:saved.game.publicEventSequence,nextAfter=groups.at(-1)?.sequence??Math.min(after,headSequence);
    return {roomId:saved.matchId,matchId:saved.matchId,groups,nextAfter,headSequence,hasMore:nextAfter<headSequence};},
};
export const decodeConfiguredPractice=decode,encodeConfiguredPractice=encode,chooseConfiguredPracticeAction=choose;
