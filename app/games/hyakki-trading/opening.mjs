import {ROLES,GOODS,EXPANSION_PACK_ID,getRole,createExpansionDeck,expansionPartitionProblem} from './content/expansion-one.mjs';
import {freezeMatchConfiguration,materialForConfiguration} from './opening-configuration.mjs';
import {shuffled} from './model.mjs';

export const ROLE_SELECTION_MS=60_000;
const stamp=value=>Number.isSafeInteger(value)&&value>=0&&Number.isSafeInteger(value+ROLE_SELECTION_MS);
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const sameKeys=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const fields=['schema','kind','openingId','configuration','hostId','firstPlayerId','status','createdAt','updatedAt','revision',
  'candidates','remainingRoles','choices','clock','deal','cancelledBy','cancellationReason'];
class OpeningError extends Error {constructor(message,code){super(message);this.code=code;}}
const requireValue=(condition,message,code='INVALID_OPENING')=>{if(!condition)throw new OpeningError(message,code);};
const copy=value=>structuredClone(value);
const candidateId=(state,id)=>`${state.openingId}.${id}`;

export function openingProblem(state){
  try{
    requireValue(sameKeys(state,fields)&&state.schema===1&&state.kind==='hyakki-opening','开局状态格式无效。');
    requireValue(typeof state.openingId==='string'&&/^[a-f0-9]{32}$/u.test(state.openingId),'开局标识无效。');
    const profile=materialForConfiguration(state.configuration),ids=state.configuration.participantIds;
    requireValue(state.configuration.packId===EXPANSION_PACK_ID,'原版不进入扩展选角。');
    requireValue(ids.includes(state.hostId)&&ids.includes(state.firstPlayerId),'开局席位归属无效。');
    requireValue(['selecting','completed','cancelled'].includes(state.status)&&Number.isSafeInteger(state.revision)&&state.revision>=0,'开局阶段无效。');
    requireValue(stamp(state.createdAt)&&stamp(state.updatedAt)&&state.updatedAt>=state.createdAt,'开局时间无效。');
    requireValue(sameKeys(state.candidates,ids)&&sameKeys(state.choices,ids),'角色候选与参赛席位不一致。');
    const dealt=[];
    for(const id of ids){
      const candidates=state.candidates[id];
      requireValue(Array.isArray(candidates)&&candidates.length===3,'每位参赛者须有三个固定候选。');
      for(const role of candidates){getRole(role);dealt.push(role);}
      requireValue(state.choices[id]===null||candidates.includes(state.choices[id]),'已选角色不在本人候选内。');
    }
    requireValue(Array.isArray(state.remainingRoles),'未分发角色池无效。');
    const all=[...dealt,...state.remainingRoles];
    requireValue(all.length===24&&new Set(all).size===24&&all.every(id=>ROLES.some(role=>role.id===id)),'角色池重复或缺失。');
    const clock=state.clock;
    requireValue(sameKeys(clock,['paused','remainingMs','deadlineAt'])&&typeof clock.paused==='boolean'
      &&Number.isSafeInteger(clock.remainingMs)&&clock.remainingMs>=0&&clock.remainingMs<=ROLE_SELECTION_MS,'选角时钟无效。');
    if(state.status==='selecting'){
      requireValue(state.deal===null&&state.cancelledBy===null&&state.cancellationReason===null,'选角期间不能提前发钱发牌。');
      requireValue(clock.remainingMs>0&&(clock.paused?clock.deadlineAt===null:stamp(clock.deadlineAt)&&clock.deadlineAt>state.updatedAt),'选角截止时间无效。');
      requireValue(ids.some(id=>state.choices[id]===null),'全部确认后须完成一次统一公开。');
    }else{
      requireValue(!clock.paused&&clock.remainingMs===0&&clock.deadlineAt===null,'结束后的选角时钟须关闭。');
      if(state.status==='cancelled')requireValue(state.deal===null&&(state.cancellationReason==='room-expired'?state.cancelledBy===null
        :state.cancellationReason==='host-cancelled'?state.cancelledBy===state.hostId
          :state.cancellationReason==='player-left'&&ids.includes(state.cancelledBy)),'取消开局状态无效。');
      else{
        requireValue(ids.every(id=>state.choices[id]!==null)&&state.cancelledBy===null&&state.cancellationReason===null,'角色尚未全部确定。');
        const deal=state.deal;
        requireValue(sameKeys(deal,['matchId','configuration','firstPlayerId','createdAt','deck','players','bankGoods','availableStalls','unusedRoles'])
          &&deal.matchId===state.openingId&&deal.createdAt===state.updatedAt&&deal.firstPlayerId===state.firstPlayerId
          &&sameKeys(deal.configuration,Object.keys(state.configuration))
          &&Object.keys(state.configuration).every(key=>key==='participantIds'
            ?Array.isArray(deal.configuration[key])&&deal.configuration[key].length===ids.length&&ids.every((id,index)=>id===deal.configuration[key][index])
            :deal.configuration[key]===state.configuration[key]),'统一发牌数据无效。');
        requireValue(Array.isArray(deal.players)&&deal.players.length===ids.length&&Array.isArray(deal.deck),'发牌参赛人无效。');
        const allCards=[...deal.deck];
        for(let i=0;i<ids.length;i++){
          const p=deal.players[i],role=getRole(state.choices[ids[i]],state.configuration);
          requireValue(sameKeys(p,['id','roleId','hand','tools','goods','silver','stallCount','temporaryOccupied'])
            &&p.id===ids[i]&&p.roleId===role.id&&p.silver===role.initialSilver&&p.stallCount===0&&p.temporaryOccupied===false
            &&Array.isArray(p.tools)&&p.tools.length===0&&Array.isArray(p.hand)&&p.hand.length===5,'初始角色、银两或手牌无效。');
          requireValue(sameKeys(p.goods,GOODS.map(g=>g.id))&&Object.values(p.goods).every(n=>n===0),'初始库存无效。');
          allCards.push(...p.hand);
        }
        requireValue(!expansionPartitionProblem(allCards,ids.length,state.configuration.contentVersion),'发牌后牌实体不守恒。');
        requireValue(sameKeys(deal.bankGoods,GOODS.map(g=>g.id))&&Object.values(deal.bankGoods).every(n=>n===state.configuration.goodsPerType)
          &&deal.availableStalls===profile.stallBoards,'初始公共材料无效。');
        const selected=Object.values(state.choices);
        requireValue(Array.isArray(deal.unusedRoles)&&deal.unusedRoles.length===24-ids.length&&new Set([...selected,...deal.unusedRoles]).size===24
          &&deal.unusedRoles.every(id=>all.includes(id)&&!selected.includes(id)),'未选角色不能混入主牌。');
      }
    }
    return null;
  }catch(error){if(error instanceof OpeningError||error instanceof RangeError)return error.message;throw error;}
}

export function createOpening(participantIds,{openingId,hostId,now,randomInt,configuration}={}){
  const config=freezeMatchConfiguration(configuration,participantIds);
  requireValue(config.packId===EXPANSION_PACK_ID,'原版不进入扩展选角。');
  requireValue(typeof openingId==='string'&&/^[a-f0-9]{32}$/u.test(openingId)&&participantIds.includes(hostId)&&stamp(now),'开局输入无效。');
  requireValue(typeof randomInt==='function','缺少权威随机源。');
  const order=shuffled(ROLES.map(role=>role.id),randomInt);
  const first=shuffled(participantIds,randomInt)[0],candidates={};
  participantIds.forEach(id=>{candidates[id]=order.splice(0,3);});
  const state={schema:1,kind:'hyakki-opening',openingId,configuration:config,hostId,firstPlayerId:first,status:'selecting',
    createdAt:now,updatedAt:now,revision:0,candidates,remainingRoles:order,choices:Object.fromEntries(participantIds.map(id=>[id,null])),
    clock:{paused:false,remainingMs:ROLE_SELECTION_MS,deadlineAt:now+ROLE_SELECTION_MS},deal:null,cancelledBy:null,cancellationReason:null};
  const issue=openingProblem(state);requireValue(!issue,issue);return state;
}
function finish(state,{now,randomInt}){
  requireValue(typeof randomInt==='function','缺少权威随机源。');
  const profile=materialForConfiguration(state.configuration),deck=shuffled(createExpansionDeck(profile.playerCount,profile.contentVersion).map(card=>card.id),randomInt);
  const selected=Object.values(state.choices);
  const players=state.configuration.participantIds.map(id=>({id,roleId:state.choices[id],hand:deck.splice(0,5),tools:[],
    goods:Object.fromEntries(GOODS.map(g=>[g.id,0])),silver:getRole(state.choices[id],state.configuration).initialSilver,stallCount:0,temporaryOccupied:false}));
  state.status='completed';state.clock={paused:false,remainingMs:0,deadlineAt:null};
  state.deal={matchId:state.openingId,configuration:copy(state.configuration),firstPlayerId:state.firstPlayerId,createdAt:now,deck,players,
    bankGoods:Object.fromEntries(GOODS.map(g=>[g.id,state.configuration.goodsPerType])),availableStalls:profile.stallBoards,
    unusedRoles:ROLES.map(role=>role.id).filter(id=>!selected.includes(id))};
}
function transition(original,now,mutate){
  const issue=openingProblem(original);if(issue)return {ok:false,code:'INVALID_OPENING',error:issue};
  if(!stamp(now)||now<original.updatedAt)return {ok:false,code:'INVALID_TIME',error:'服务器时间无效。'};
  try{
    const state=copy(original),changed=mutate(state);
    if(changed===false)return {ok:true,state:original,changed:false};
    state.updatedAt=now;state.revision++;
    const nextIssue=openingProblem(state);requireValue(!nextIssue,nextIssue);
    return {ok:true,state,changed:true};
  }catch(error){if(error instanceof OpeningError)return {ok:false,code:error.code,error:error.message};throw error;}
}
function validateCommand(state,actorId,action,now){
  const ids=state.configuration.participantIds;
  requireValue(ids.includes(actorId),'不是本次开局的参赛席位。','WRONG_ACTOR');
  requireValue(record(action)&&action.openingId===state.openingId,'开局已改变。','STALE_OPENING');
  requireValue(state.status==='selecting','本次开局已经结束。','OPENING_CLOSED');
  if(action.type==='confirm-role'){
    requireValue(!state.clock.paused,'本次开局已手动暂停。','OPENING_PAUSED');
    requireValue(now<state.clock.deadlineAt,'选角期限已到。','OPENING_EXPIRED');
    requireValue(sameKeys(action,['type','openingId','candidateId','roleId'])&&action.candidateId===candidateId(state,actorId),'候选归属或输入无效。','STALE_CANDIDATE');
    requireValue(state.candidates[actorId].includes(action.roleId),'只能选择自己的角色候选。','INVALID_ROLE');
    if(state.choices[actorId]===action.roleId)return false;
    requireValue(state.choices[actorId]===null,'已经确认的角色不能改选。','ROLE_LOCKED');
  }else{
    requireValue(sameKeys(action,['type','openingId'])&&['cancel-opening','leave-opening'].includes(action.type),'开局操作无效。','INVALID_ACTION');
    requireValue(action.type!=='cancel-opening'||actorId===state.hostId,'只有房主能取消整次开局。','WRONG_ACTOR');
  }
  return true;
}
/** Pure admission check: no candidate mutation, deck shuffle or random call. */
export function openingCommandProblem(state,actorId,action,{now}={}){
  const issue=openingProblem(state);if(issue)return {code:'INVALID_OPENING',error:issue};
  if(!stamp(now)||now<state.updatedAt)return {code:'INVALID_TIME',error:'服务器时间无效。'};
  try{validateCommand(state,actorId,action,now);return null;}
  catch(error){if(error instanceof OpeningError)return {code:error.code,error:error.message};throw error;}
}
export function applyOpeningAction(original,actorId,action,{now,randomInt}={}){
  return transition(original,now,state=>{
    if(!validateCommand(state,actorId,action,now))return false;
    const ids=state.configuration.participantIds;
    if(action.type==='confirm-role'){
      state.choices[actorId]=action.roleId;
      if(ids.every(id=>state.choices[id]!==null))finish(state,{now,randomInt});
    }else{
      state.status='cancelled';state.cancelledBy=actorId;state.cancellationReason=action.type==='cancel-opening'?'host-cancelled':'player-left';
      state.clock={paused:false,remainingMs:0,deadlineAt:null};
    }
  });
}
export function expireOpening(original,{now,randomInt}={}){
  return transition(original,now,state=>{
    if(state.status!=='selecting'||state.clock.paused||now<state.clock.deadlineAt)return false;
    for(const id of state.configuration.participantIds)state.choices[id]??=state.candidates[id][0];
    finish(state,{now,randomInt});
  });
}
/** Trusted room retention expiry only. This cannot cancel a dealt game. */
export function cancelExpiredOpening(original,{now}={}){
  return transition(original,now,state=>{
    requireValue(state.status==='selecting','本次开局已经结束。','OPENING_CLOSED');
    state.status='cancelled';state.cancelledBy=null;state.cancellationReason='room-expired';
    state.clock={paused:false,remainingMs:0,deadlineAt:null};
  });
}
/** Called by the trusted room owner after its existing manual pause consensus.
 * Connection/presence updates do not call this function and cannot reset time. */
export function setOpeningManualPause(original,paused,{now}={}){
  return transition(original,now,state=>{
    requireValue(typeof paused==='boolean','手动暂停状态无效。');
    requireValue(state.status==='selecting','本次开局已经结束。','OPENING_CLOSED');
    if(paused===state.clock.paused)return false;
    if(paused){
      requireValue(now<state.clock.deadlineAt,'选角期限已到。','OPENING_EXPIRED');
      state.clock.remainingMs=state.clock.deadlineAt-now;state.clock.deadlineAt=null;
    }else state.clock.deadlineAt=now+state.clock.remainingMs;
    state.clock.paused=paused;
  });
}
export function openingView(state,viewerId=null,{now=state.updatedAt}={}){
  const issue=openingProblem(state);requireValue(!issue,issue);
  requireValue(stamp(now)&&now>=state.updatedAt,'服务器时间无效。');
  const ids=state.configuration.participantIds,completed=state.status==='completed';
  const view={openingId:state.openingId,status:state.status,revision:state.revision,
    configuration:copy(state.configuration),firstPlayerId:state.firstPlayerId,confirmed:ids.map(id=>({id,confirmed:state.choices[id]!==null})),
    clock:{paused:state.clock.paused,remainingMs:state.clock.paused?state.clock.remainingMs:state.clock.deadlineAt===null?0:Math.max(0,state.clock.deadlineAt-now)}};
  if(completed)view.roles=ids.map(id=>({playerId:id,roleId:state.choices[id]}));
  else if(state.status==='selecting'&&ids.includes(viewerId))view.self={candidateId:candidateId(state,viewerId),
    candidates:[...state.candidates[viewerId]],confirmedRoleId:state.choices[viewerId]};
  return view;
}
