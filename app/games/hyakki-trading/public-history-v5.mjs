import {GOODS} from './content/expansion-one.mjs';
import {EXPANSION_TWO_CONTENT_VERSION,composeTradeRoutes,getPublicOrder} from './content/expansion-two.mjs';
import {encodeExpansionPublicMetadata,decodeExpansionPublicMetadata} from './expansion-public-history.mjs';
import {configuredEventProblem} from './public-history-v4.mjs';
import {orderEventProblem} from './configured/order-actions.mjs';
import {materialForConfiguration} from './opening-configuration.mjs';
import {refinedEventPremium,WORKSHOP_OWNER} from './configured/refining.mjs';
import {isExchangeEvent,exchangeEventProblem,EXCHANGE_KEEPER} from './configured/exchange-market.mjs';

export const PUBLIC_ORDER_HISTORY_VERSION=5;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const hex=id=>typeof id==='string'&&/^[a-f0-9]{32}$/u.test(id);
const need=(condition,message='公单公开战况格式无效。')=>{if(!condition)throw new RangeError(message);};
const orderEvents=new Set(['order-delivered','order-replaced','order-compass-opened']);
const sameBoard=(a,b)=>a.length===b.length&&a.every((slot,i)=>slot.id===b[i].id&&slot.generation===b[i].generation&&slot.position===b[i].position);
export function history5Material(context){
  const {contentVersion,participantIds:ids,modules}=context;
  need(contentVersion===EXPANSION_TWO_CONTENT_VERSION&&Array.isArray(ids)&&ids.every(hex)&&new Set(ids).size===ids.length);
  const profile=composeTradeRoutes(ids.length,modules);
  need(Object.values(profile.modules).some(Boolean));
  const definitions=profile.cards;
  return {ids,profile,definitions,cards:definitions.map(card=>card.id),roles:profile.roles.map(role=>role.id),format:'trade-routes-public-v1'};
}
export const encodeHistory5Metadata=(value,context)=>encodeExpansionPublicMetadata(value,context,history5Material);
export const decodeHistory5Metadata=(value,context)=>decodeExpansionPublicMetadata(value,context,history5Material);

export function history5GroupProblem(group,context,{wire=false}={}){
  try{
    const {profile,ids}=history5Material(context);
    const fields=['schemaVersion','roomId','matchId','sequence','committedAt','events','contentVersion','participantIds','modules','metadata','orders'];
    need(exact(group,[...fields,...(wire?[]:['kind','commitId','mode','fingerprint'])])&&group.schemaVersion===PUBLIC_ORDER_HISTORY_VERSION
      &&hex(group.roomId)&&hex(group.matchId)&&integer(group.sequence,1)&&integer(group.committedAt)
      &&group.contentVersion===profile.contentVersion&&Array.isArray(group.participantIds)&&group.participantIds.length===ids.length
      &&ids.every((id,i)=>id===group.participantIds[i])&&exact(group.modules,Object.keys(profile.modules))
      &&Object.keys(profile.modules).every(key=>profile.modules[key]===group.modules[key])
      &&Array.isArray(group.events)&&group.events.length>0&&group.events.length<=64
      &&new TextEncoder().encode(JSON.stringify(group)).length<=32768);
    const metadata=decodeHistory5Metadata(group.metadata,context);
    need((group.sequence===1)===(metadata.anchor.kind==='opening'));
    need(group.sequence===1?group.events.length===1&&group.events[0]?.type==='match-started'
      :!group.events.some(event=>event?.type==='match-started'));
    const boardSize=profile.modules.orders?3:0;
    need(Array.isArray(group.orders)&&group.orders.length===boardSize&&new Set(group.orders.map(slot=>slot?.id)).size===boardSize);
    for(const [position,slot] of group.orders.entries()){
      need(exact(slot,['id','position','generation'])&&slot.position===position&&integer(slot.generation,1));
      getPublicOrder(slot.id);
      if(group.sequence===1)need(slot.generation===1);
    }
    for(const event of group.events){
      if(isExchangeEvent(event?.type)){need(!exchangeEventProblem(event,ids,profile));continue;}
      if(!orderEvents.has(event?.type)){
        need(!configuredEventProblem(event,{cards:profile.cards,goods:GOODS,ids,profile,roles:profile.roles,expansion:true}));
        continue;
      }
      need(profile.modules.orders&&!orderEventProblem(event,ids,profile.modules));
      const slot=group.orders[event.position];
      if(event.type==='order-compass-opened')need(slot.generation===event.generation||slot.generation===event.generation+1);
      else need(slot.generation===event.generation&&slot.id===event.replacementId);
    }
    if(!wire)need(group.kind==='group'&&/^[A-Za-z0-9_-]{1,128}$/u.test(group.commitId??'')
      &&['normal','capacity','resume','terminal'].includes(group.mode)&&/^[a-f0-9]{64}$/u.test(group.fingerprint??''));
    return null;
  }catch(error){if(error instanceof RangeError||error instanceof TypeError)return '公单公开战况格式无效。';throw error;}
}
export function history5ContinuityProblem(previous,next){
  if(!previous)return next.sequence===1?null:'公单战况缺少前序。';
  const board=structuredClone(previous.orders);
  for(const event of next.events){
    if(!orderEvents.has(event.type))continue;
    const slot=board[event.position];
    if(event.type==='order-compass-opened'){
      if(slot.generation!==event.generation)return '罗盘公开位置已改变。';
    }else{
      if(slot.id!==event.orderId||slot.generation+1!==event.generation)return '公单战况代际不连续。';
      board[event.position]={id:event.replacementId,position:event.position,generation:event.generation};
    }
  }
  return sameBoard(board,next.orders)?null:'公单公开位置变化缺少对应事件。';
}
export function history5RoleProblem(group,roster,context){
  try{
    const {ids,roles,profile}=history5Material(context),metadata=decodeHistory5Metadata(group.metadata,context);
    need(Array.isArray(roster)&&roster.length===ids.length&&new Set(roster.map(r=>r.seatId)).size===ids.length
      &&new Set(roster.map(r=>r.roleId)).size===ids.length&&roster.every(r=>ids.includes(r.seatId)&&roles.includes(r.roleId)));
    const roleOf=new Map(roster.map(r=>[r.seatId,r.roleId]));
    const authorized=source=>source?.kind!=='role'||roleOf.get(source.actorSeatId)===source.roleId;
    need(authorized(metadata.source)&&metadata.discard.added.every(entry=>authorized(entry.source)));
    for(const event of group.events){
      if(Object.hasOwn(event,'roleId'))need(roleOf.get(event.actorSeatId)===event.roleId);
      if(event.type==='offer-edited')need(roleOf.get(event.actorSeatId)===EXCHANGE_KEEPER);
      if(event.type==='offer-posted'&&event.offer.source==='broker')need(group.events.some(source=>source.type==='character-played'
        &&source.actorSeatId===event.actorSeatId&&source.cardId==='yousei.e2c03'));
      if(event.type==='offer-accepted'){
        const feeFor=id=>roleOf.get(id)==='yousei.role.e2r06'?1:2;
        need((!event.makerFee||event.makerFee===feeFor(event.makerSeatId))
          &&(!event.takerFee||event.takerFee===feeFor(event.actorSeatId)));
      }
      if(event.type==='stock-refined'){
        const count=event.goods.reduce((sum,good)=>sum+good.count,0);
        need(count===1||event.source==='artisan'||roleOf.get(event.actorSeatId)===WORKSHOP_OWNER);
        if(event.source==='artisan')need(group.events.some(source=>source.type==='character-played'
          &&source.actorSeatId===event.actorSeatId&&source.cardId==='yousei.e2c02'));
      }
      if(event.type==='order-replaced'&&event.source!=='compass')need((event.source==='scout')===(roleOf.get(event.actorSeatId)==='yousei.role.e2r02'));
      if(event.type==='order-delivered'){
        const order=getPublicOrder(event.orderId),bonus=order.kind==='bulk'&&roleOf.get(event.actorSeatId)==='yousei.role.e2r01'?2:0;
        const premium=refinedEventPremium(event,profile.modules);
        need(premium!==null&&event.silver===order.silver+bonus+premium);
        if(event.source==='broker')need(group.events.some(source=>source.type==='character-played'
          &&source.actorSeatId===event.actorSeatId&&source.cardId==='yousei.e2c01'));
      }
    }
    return null;
  }catch(error){if(error instanceof RangeError||error instanceof TypeError)return '公单战况角色来源无效。';throw error;}
}
export function history5PacketProblem(packet,room,after=0){
  try{
    const {game}=room;
    const participantIds=game.players.map(player=>player.id),context={contentVersion:game.contentVersion,participantIds,modules:game.configuration.modules};
    const frozen=materialForConfiguration(game.configuration);
    need(frozen.contentVersion===game.contentVersion&&game.configuration.ruleVersion===game.ruleVersion
      &&frozen.playerCount===participantIds.length&&participantIds.every((id,index)=>id===game.configuration.participantIds[index]));
    history5Material(context);
    const roster=game.players.map(player=>({seatId:player.id,roleId:player.roleId}));
    need(exact(packet,['roomId','matchId','groups','nextAfter','headSequence','hasMore'])
      &&packet.roomId===room.roomId&&packet.matchId===room.matchId&&integer(after)
      &&integer(packet.headSequence,after)&&integer(packet.nextAfter,after)&&packet.nextAfter<=packet.headSequence
      &&packet.hasMore===(packet.nextAfter<packet.headSequence)&&Array.isArray(packet.groups)&&packet.groups.length<=50
      &&new TextEncoder().encode(JSON.stringify(packet)).length<=256*1024);
    let previous=null,sequence=after;
    for(const group of packet.groups){
      sequence++;
      need(!history5GroupProblem(group,context,{wire:true})&&!history5RoleProblem(group,roster,context)
        &&group.roomId===room.roomId&&group.matchId===room.matchId&&group.sequence===sequence&&sequence<=packet.headSequence);
      if(group.sequence===1){
        const first=decodeHistory5Metadata(group.metadata,context).rolesRevealed;
        need(roster.every(role=>first.some(entry=>entry.seatId===role.seatId&&entry.roleId===role.roleId)));
      }
      if(previous)need(group.committedAt>=previous.committedAt&&!history5ContinuityProblem(previous,group));
      previous=group;
    }
    need(sequence===packet.nextAfter&&(!packet.hasMore||packet.groups.length>0));
    return null;
  }catch(error){if(error instanceof RangeError||error instanceof TypeError)return '公单公开战况页面无效。';throw error;}
}
