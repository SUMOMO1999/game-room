import {CARDS as BASE_CARDS,GOODS as BASE_GOODS,PLAYER_COUNT_CONTENT_VERSION,materialProfile} from './content/definitions.mjs';
import {GOODS as EXPANSION_GOODS,ROLES,EXPANSION_CONTENT_VERSION,LEGACY_EXPANSION_CONTENT_VERSION,cardsForExpansion,isExpansionContentVersion,CONFIGURABLE_RULE_VERSION,expansionProfile} from './content/expansion-one.mjs';
import {publicBattleMetadataProblem} from './battle-public-metadata.mjs';
import {encodeExpansionPublicMetadata,decodeExpansionPublicMetadata} from './expansion-public-history.mjs';
import {materialForConfiguration} from './opening-configuration.mjs';

// Group4 is scoped to configurable rule v3. It never changes the vocabulary or
// material bounds of group1/2/3. Both server persistence and the new packet
// reader use this closed public contract; no arbitrary game objects are encoded.
export const PUBLIC_HISTORY_VERSION=4;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fields=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const hex=id=>typeof id==='string'&&/^[a-f0-9]{32}$/u.test(id);
const demand=(yes,message='新版公开战况格式无效。')=>{if(!yes)throw new RangeError(message);};
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const catalogs=new Map([[PLAYER_COUNT_CONTENT_VERSION,{cards:BASE_CARDS,goods:BASE_GOODS}],
  ...[LEGACY_EXPANSION_CONTENT_VERSION,EXPANSION_CONTENT_VERSION].map(version=>[version,{cards:cardsForExpansion(version),goods:EXPANSION_GOODS}])]);
export function history4Material(context){
  demand(exact(context,['contentVersion','participantIds'])&&catalogs.has(context.contentVersion));
  const ids=context.participantIds;
  demand(Array.isArray(ids)&&ids.length>=2&&ids.length<=6&&ids.every(hex)&&new Set(ids).size===ids.length);
  const profile=isExpansionContentVersion(context.contentVersion)?expansionProfile(ids.length,context.contentVersion):materialProfile(context.contentVersion,ids.length);
  return {...catalogs.get(context.contentVersion),profile,ids};
}
export function encodeHistory4Metadata(metadata,context){
  const {profile,ids}=history4Material(context);
  if(isExpansionContentVersion(profile.contentVersion))return encodeExpansionPublicMetadata(metadata,context);
  const issue=publicBattleMetadataProblem(metadata,ids,profile);
  demand(!issue&&metadata.turn.round===Math.ceil(metadata.turn.number/ids.length),issue);
  return {format:'base-public-v1',data:structuredClone(metadata)};
}
export function decodeHistory4Metadata(encoded,context){
  const {profile,ids}=history4Material(context);
  if(isExpansionContentVersion(profile.contentVersion))return decodeExpansionPublicMetadata(encoded,context);
  demand(exact(encoded,['format','data'])&&encoded.format==='base-public-v1'&&size(encoded)<=32768);
  const issue=publicBattleMetadataProblem(encoded.data,ids,profile);
  demand(!issue&&encoded.data.turn.round===Math.ceil(encoded.data.turn.number/ids.length),issue);
  return structuredClone(encoded.data);
}
const reasons=new Set(['capacity','disconnected','server-recovery','voluntary-leave','normal-close','absence-expired','room-expired','cancelled']);
const vocabulary=Object.freeze({
  'match-started':[[],[]], 'draw-peeked':[['actorSeatId'],[]], 'draw-kept':[['actorSeatId'],[]],
  'draw-discarded':[['actorSeatId','cardId'],[]], 'draw-finished':[['actorSeatId'],[]],
  'trade-bought':[['actorSeatId','cardId','goods','silver','price'],[]],
  'trade-sold':[['actorSeatId','cardId','goods','silver','price'],[]],
  'stall-expanded':[['actorSeatId','silver','count'],[]],
  'character-played':[['actorSeatId','cardId'],['targetSeatId']],
  'tool-installed':[['actorSeatId','cardId'],[]], 'tool-activated':[['actorSeatId','cardId'],['targetSeatId']],
  'response-played':[['actorSeatId','cardId'],[]], 'response-declined':[['actorSeatId'],[]],
  'choice-resolved':[['actorSeatId'],['targetSeatId','count']],
  'cards-revealed':[['actorSeatId','cardIds'],[]], 'search-revealed':[['actorSeatId','cardIds'],[]],
  'auction-revealed':[['actorSeatId'],['cardIds','goods']],
  'bid-raised':[['actorSeatId','silver'],[]], 'bid-passed':[['actorSeatId'],[]],
  'auction-settled':[['actorSeatId','targetSeatId','silver'],['cardIds','goods']],
  'turn-ended':[['actorSeatId'],[]], paused:[[],[]], resumed:[[],[]], suspended:[['reason'],[]],
  'pending-closed':[['reason'],[]], 'match-ended':[['reason','winnerSeatId'],[]],
  'role-used':[['actorSeatId','roleId'],['targetSeatId','silver','count']],
  'role-triggered':[['actorSeatId','roleId'],['targetSeatId','silver','count']],
});
export function history4EventProblem(event,context){
  try{
    const {cards,goods,ids,profile}=history4Material(context),shape=Object.hasOwn(vocabulary,event?.type)?vocabulary[event.type]:null;
    demand(shape&&fields(event,['type',...shape[0],...shape[1]])&&shape[0].every(k=>Object.hasOwn(event,k)));
    const definitions=new Map(cards.map(c=>[c.id,c])),knownGoods=new Set(goods.map(g=>g.id));
    for(const [key,value] of Object.entries(event)){
      if(key.endsWith('SeatId'))demand(key==='winnerSeatId'&&value===null||ids.includes(value));
      if(key==='cardId')demand(definitions.has(value));
      if(key==='cardIds')demand(Array.isArray(value)&&value.length<=profile.deckSize&&value.every(id=>definitions.has(id)));
      if(key==='roleId')demand(isExpansionContentVersion(profile.contentVersion)&&ROLES.some(r=>r.id===value));
      if(key==='goods')demand(Array.isArray(value)&&value.length<=goods.length&&new Set(value.map(g=>g?.id)).size===value.length
        &&value.every(g=>exact(g,['id','count'])&&knownGoods.has(g.id)&&integer(g.count,1,20)));
      if(key==='silver')demand(integer(value));
      if(key==='count')demand(integer(value,0,profile.deckSize));
      if(key==='reason')demand(reasons.has(value));
    }
    if(['auction-revealed','auction-settled'].includes(event.type)){
      demand(Object.hasOwn(event,'cardIds')!==Object.hasOwn(event,'goods'));
      demand(event.cardIds?event.cardIds.length===3:event.goods.reduce((sum,g)=>sum+g.count,0)===2);
    }
    if(['trade-bought','trade-sold'].includes(event.type)){
      const buying=event.type==='trade-bought',card=definitions.get(event.cardId),p=event.price;
      const printed=buying?card?.buySilver:card?.sellSilver;
      demand(card?.category==='goods'&&exact(p,['printed','bookLayers','roleAdjustment','goodsPrice','buyTax','temporaryFee'])
        &&p.printed===printed&&integer(p.bookLayers)&&integer(2*p.bookLayers)
        &&integer(p.roleAdjustment,buying?-1:0,buying?0:3)&&integer(p.goodsPrice)
        &&[0,1].includes(p.buyTax)&&[0,2].includes(p.temporaryFee));
      demand(isExpansionContentVersion(profile.contentVersion)||p.roleAdjustment===0&&p.buyTax===0);
      demand(p.goodsPrice===(buying?Math.max(0,printed-2*p.bookLayers):printed+2*p.bookLayers)+p.roleAdjustment);
      demand(event.silver===(buying?p.goodsPrice+p.buyTax+p.temporaryFee:p.goodsPrice)
        &&(buying||p.buyTax===0&&p.temporaryFee===0)&&integer(event.silver));
      const count=event.goods.reduce((sum,g)=>sum+g.count,0);
      demand(count===(card.recipe?.count??Object.values(card.goods).reduce((sum,n)=>sum+n,0)));
    }
    return null;
  }catch(error){if(error instanceof RangeError)return error.message;throw error;}
}
export function history4GroupProblem(group,context,{wire=false}={}){
  try{
    history4Material(context);
    const {participantIds:ids,contentVersion}=context;
    const required=['schemaVersion','roomId','matchId','sequence','committedAt','events','contentVersion','participantIds','metadata'];
    const persisted=['kind','commitId','mode','fingerprint'];
    demand(exact(group,[...required,...(wire?[]:persisted)])&&group.schemaVersion===4
      &&hex(group.roomId)&&hex(group.matchId)&&integer(group.sequence,1)&&integer(group.committedAt)
      &&group.contentVersion===contentVersion&&Array.isArray(group.participantIds)
      &&group.participantIds.length===ids.length&&ids.every((id,i)=>id===group.participantIds[i])
      &&Array.isArray(group.events)&&group.events.length>0&&group.events.length<=64&&size(group)<=32768);
    for(const event of group.events)demand(!history4EventProblem(event,context));
    const metadata=decodeHistory4Metadata(group.metadata,context);
    if(isExpansionContentVersion(contentVersion))demand((group.sequence===1)===(metadata.anchor.kind==='opening'));
    if(group.sequence===1)demand(group.events.length===1&&group.events[0].type==='match-started');
    else demand(!group.events.some(e=>e.type==='match-started'));
    if(!wire)demand(group.kind==='group'&&/^[A-Za-z0-9_-]{1,128}$/u.test(group.commitId??'')
      &&['normal','capacity','resume','terminal'].includes(group.mode)&&/^[a-f0-9]{64}$/u.test(group.fingerprint??''));
    return null;
  }catch(error){if(error instanceof RangeError)return error.message;throw error;}
}
/** A valid role definition is not authority to attribute it to any seat. */
export function history4RoleProblem(group,roster,context){
  if(!isExpansionContentVersion(context.contentVersion))return null;
  try{
    const metadata=decodeHistory4Metadata(group.metadata,context),ids=context.participantIds;
    demand(Array.isArray(roster)&&roster.length===ids.length&&new Set(roster.map(r=>r.seatId)).size===ids.length
      &&new Set(roster.map(r=>r.roleId)).size===ids.length&&roster.every(r=>ids.includes(r.seatId)&&ROLES.some(role=>role.id===r.roleId)));
    const roleOf=new Map(roster.map(r=>[r.seatId,r.roleId]));
    const authorized=source=>source?.kind!=='role'||roleOf.get(source.actorSeatId)===source.roleId;
    demand(authorized(metadata.source)&&metadata.discard.added.every(p=>authorized(p.source))
      &&group.events.every(e=>!Object.hasOwn(e,'roleId')||roleOf.get(e.actorSeatId)===e.roleId));
    return null;
  }catch(error){if(error instanceof RangeError||error instanceof TypeError)return '角色来源与已公开角色不一致。';throw error;}
}
/** The captured room, not a page payload, supplies material and seat authority. */
export function history4PacketProblem(packet,room,after=0){
  try{
    const game=room.game,configuration=game.configuration??game.opening?.configuration;
    demand(game.ruleVersion===CONFIGURABLE_RULE_VERSION&&materialForConfiguration(configuration)
      &&game.ruleVersion===configuration.ruleVersion&&game.contentVersion===configuration.contentVersion);
    const ids=game.players.map(p=>p.id),context={contentVersion:game.contentVersion,participantIds:ids};
    demand(ids.length===configuration.playerCount&&ids.every((id,i)=>id===configuration.participantIds[i]));
    demand(exact(packet,['roomId','matchId','groups','nextAfter','headSequence','hasMore'])
      &&packet.roomId===room.roomId&&packet.matchId===room.matchId&&integer(after)
      &&integer(packet.headSequence)&&integer(packet.nextAfter,after,packet.headSequence)&&after<=packet.headSequence
      &&packet.hasMore===(packet.nextAfter<packet.headSequence)&&Array.isArray(packet.groups)
      &&packet.groups.length<=50&&size(packet)<=256*1024);
    let previous=after,at=0;
    for(const group of packet.groups){
      demand(!history4GroupProblem(group,context,{wire:true})&&group.roomId===room.roomId&&group.matchId===room.matchId
        &&group.sequence===previous+1&&group.sequence<=packet.headSequence&&group.committedAt>=at);
      demand(!history4RoleProblem(group,game.players.map(p=>({seatId:p.id,roleId:p.roleId})),context));
      if(group.sequence===1&&isExpansionContentVersion(game.contentVersion)){
        const roles=decodeHistory4Metadata(group.metadata,context).rolesRevealed;
        demand(game.players.every(p=>roles.some(r=>r.seatId===p.id&&r.roleId===p.roleId)));
      }
      previous=group.sequence;at=group.committedAt;
    }
    demand(packet.nextAfter===previous&&(!packet.hasMore||packet.groups.length>0));return null;
  }catch(error){if(error instanceof RangeError||error instanceof TypeError)return '公开战况内容或版本无效。';throw error;}
}
export {CONFIGURABLE_RULE_VERSION};
