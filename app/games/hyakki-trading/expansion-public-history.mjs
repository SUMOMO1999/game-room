import {CARDS,GOODS,ROLES,EXPANSION_CONTENT_VERSION,expansionProfile} from './content/expansion-one.mjs';

// Compact public metadata for configured group4 matches.
// Positional references name PUBLIC definitions and frozen seats, never copies,
// hidden hands, candidates, draw order or random state. Old group1/2/3 readers
// and their original bounds stay unchanged.
export const EXPANSION_HISTORY_FORMAT='six-trades-public-v1';
const cards=CARDS.map(c=>c.id),goods=GOODS.map(g=>g.id),roles=ROLES.map(r=>r.id);
const reasons=['used','draw-discarded','replaced','payment','response','auction-unsold','removed','unknown'];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&!Object.is(v,-0)&&v>=min&&v<=max;
const demand=(condition,message='扩展公开记录格式无效。')=>{if(!condition)throw new RangeError(message);};
const tuple=(v,length)=>Array.isArray(v)&&v.length===length;
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
function material(context){
  demand(exact(context,['contentVersion','participantIds'])&&context.contentVersion===EXPANSION_CONTENT_VERSION,'扩展公开记录内容版本无效。');
  const ids=context.participantIds;
  demand(Array.isArray(ids)&&ids.every(id=>typeof id==='string'&&/^[a-f0-9]{32}$/u.test(id))&&new Set(ids).size===ids.length,'公开记录参赛席位无效。');
  return {ids,profile:expansionProfile(ids.length)};
}
const face=id=>cards.includes(id);
const tool=id=>CARDS.find(c=>c.id===id)?.category==='tool';
function sourceProblem(value,ids){
  return value!==null&&!(exact(value,['kind','definitionId'])&&value.kind==='card'&&face(value.definitionId))
    &&!(exact(value,['kind','roleId','actorSeatId'])&&value.kind==='role'&&roles.includes(value.roleId)&&ids.includes(value.actorSeatId));
}
function boundedFaces(values,profile){
  if(!Array.isArray(values)||values.length>profile.deckSize)return false;
  const counts=new Map();
  for(const id of values){
    const card=CARDS.find(c=>c.id===id);if(!card)return false;
    const n=(counts.get(id)??0)+1;counts.set(id,n);if(n>profile.copiesByCode[card.sourceCode])return false;
  }
  return true;
}
export function expansionPublicMetadataProblem(value,context){
  try{
    const {ids,profile}=material(context),max=profile.deckSize;
    demand(exact(value,['anchor','source','rolesRevealed','changes','discard']));
    const a=value.anchor,opening=exact(a,['kind'])&&a.kind==='opening';
    demand(opening||exact(a,['kind','id','number','round','ownerSeatId'])&&a.kind==='turn'
      &&integer(a.number,1)&&a.id===`turn-${a.number}`&&a.round===Math.ceil(a.number/ids.length)&&ids.includes(a.ownerSeatId));
    demand(!sourceProblem(value.source,ids));
    const revealed=value.rolesRevealed;
    demand(Array.isArray(revealed)&&revealed.length===(opening?ids.length:0)
      &&new Set(revealed.map(p=>p?.seatId)).size===revealed.length&&new Set(revealed.map(p=>p?.roleId)).size===revealed.length
      &&revealed.every(p=>exact(p,['seatId','roleId'])&&ids.includes(p.seatId)&&roles.includes(p.roleId)),
      '角色必须在统一公开门后一次完整公开。');
    demand(Array.isArray(value.changes)&&value.changes.length<=ids.length
      &&new Set(value.changes.map(p=>p?.seatId)).size===value.changes.length);
    for(const c of value.changes){
      demand(exact(c,['seatId','silver','goods','handCount','toolsAdded','toolsRemoved'])&&ids.includes(c.seatId)
        &&integer(c.silver,-Number.MAX_SAFE_INTEGER)&&integer(c.handCount,-max,max)
        &&Array.isArray(c.goods)&&c.goods.length<=12&&new Set(c.goods.map(g=>g?.id)).size===c.goods.length
        &&c.goods.every(g=>exact(g,['id','delta'])&&goods.includes(g.id)&&integer(g.delta,-20,20)&&g.delta!==0)
        &&[c.toolsAdded,c.toolsRemoved].every(list=>Array.isArray(list)&&list.length<=3&&list.every(tool))
        &&(c.silver||c.handCount||c.goods.length||c.toolsAdded.length||c.toolsRemoved.length));
    }
    const d=value.discard;
    demand(exact(d,['beforeCount','afterCount','removed','added'])&&integer(d.beforeCount,0,max)&&integer(d.afterCount,0,max)
      &&Array.isArray(d.removed)&&Array.isArray(d.added)&&d.removed.length<=max&&d.added.length<=max
      &&d.beforeCount-d.removed.length+d.added.length===d.afterCount
      &&new Set(d.removed.map(r=>r?.index)).size===d.removed.length&&new Set(d.added.map(r=>r?.index)).size===d.added.length
      &&d.removed.every(r=>exact(r,['index','definitionId'])&&integer(r.index,0,d.beforeCount-1)&&face(r.definitionId))
      &&d.added.every(r=>exact(r,['index','definitionId','actorSeatId','reason','source'])&&integer(r.index,0,d.afterCount-1)
        &&face(r.definitionId)&&(r.actorSeatId===null||ids.includes(r.actorSeatId))&&reasons.includes(r.reason)&&!sourceProblem(r.source,ids))
      &&boundedFaces(d.removed.map(r=>r.definitionId),profile)&&boundedFaces(d.added.map(r=>r.definitionId),profile));
    if(opening)demand(value.source===null&&d.beforeCount===0&&d.afterCount===0,'统一公开前不能伪造经营回合或弃牌。');
    return null;
  }catch(error){if(error instanceof RangeError)return error.message;throw error;}
}
function sourceTuple(value,ids){return value===null?[]:value.kind==='card'?[1,cards.indexOf(value.definitionId)]:[2,roles.indexOf(value.roleId),ids.indexOf(value.actorSeatId)];}
function sourceValue(value,ids){
  demand(Array.isArray(value));if(!value.length)return null;
  if(tuple(value,2)&&value[0]===1){demand(integer(value[1],0,cards.length-1));return {kind:'card',definitionId:cards[value[1]]};}
  demand(tuple(value,3)&&value[0]===2&&integer(value[1],0,roles.length-1)&&integer(value[2],0,ids.length-1));
  return {kind:'role',roleId:roles[value[1]],actorSeatId:ids[value[2]]};
}
export function encodeExpansionPublicMetadata(value,context){
  const issue=expansionPublicMetadataProblem(value,context);demand(!issue,issue);
  const {ids}=material(context),a=value.anchor,d=value.discard;
  return {format:EXPANSION_HISTORY_FORMAT,data:[a.kind==='opening'?[0]:[1,a.number,a.round,ids.indexOf(a.ownerSeatId)],
    sourceTuple(value.source,ids),value.rolesRevealed.map(p=>[ids.indexOf(p.seatId),roles.indexOf(p.roleId)]),
    value.changes.map(c=>[ids.indexOf(c.seatId),c.silver,c.goods.map(g=>[goods.indexOf(g.id),g.delta]),c.handCount,
      c.toolsAdded.map(id=>cards.indexOf(id)),c.toolsRemoved.map(id=>cards.indexOf(id))]),
    [d.beforeCount,d.afterCount,d.removed.map(r=>[r.index,cards.indexOf(r.definitionId)]),
      d.added.map(r=>[r.index,cards.indexOf(r.definitionId),r.actorSeatId===null?-1:ids.indexOf(r.actorSeatId),reasons.indexOf(r.reason),sourceTuple(r.source,ids)])]]};
}
export function decodeExpansionPublicMetadata(value,context){
  const {ids,profile}=material(context);
  demand(exact(value,['format','data'])&&value.format===EXPANSION_HISTORY_FORMAT&&tuple(value.data,5)&&bytes(value)<=32*1024);
  const [a,s,revealed,changes,d]=value.data;
  demand(tuple(a,1)&&a[0]===0||tuple(a,4)&&a[0]===1&&integer(a[1],1)&&integer(a[2],1)&&integer(a[3],0,ids.length-1));
  demand(Array.isArray(revealed)&&revealed.length<=ids.length&&revealed.every(p=>tuple(p,2)&&integer(p[0],0,ids.length-1)&&integer(p[1],0,roles.length-1)));
  demand(Array.isArray(changes)&&changes.length<=ids.length&&changes.every(c=>tuple(c,6)&&integer(c[0],0,ids.length-1)
    &&integer(c[1],-Number.MAX_SAFE_INTEGER)&&integer(c[3],-profile.deckSize,profile.deckSize)&&Array.isArray(c[2])&&c[2].length<=12
    &&c[2].every(g=>tuple(g,2)&&integer(g[0],0,goods.length-1)&&integer(g[1],-20,20))
    &&[c[4],c[5]].every(list=>Array.isArray(list)&&list.length<=3&&list.every(i=>integer(i,0,cards.length-1)))));
  demand(tuple(d,4)&&integer(d[0],0,profile.deckSize)&&integer(d[1],0,profile.deckSize)
    &&Array.isArray(d[2])&&d[2].length<=profile.deckSize&&d[2].every(r=>tuple(r,2)&&integer(r[0],0,d[0]-1)&&integer(r[1],0,cards.length-1))
    &&Array.isArray(d[3])&&d[3].length<=profile.deckSize&&d[3].every(r=>tuple(r,5)&&integer(r[0],0,d[1]-1)&&integer(r[1],0,cards.length-1)
      &&integer(r[2],-1,ids.length-1)&&integer(r[3],0,reasons.length-1)));
  const result={anchor:a[0]===0?{kind:'opening'}:{kind:'turn',id:`turn-${a[1]}`,number:a[1],round:a[2],ownerSeatId:ids[a[3]]},
    source:sourceValue(s,ids),rolesRevealed:revealed.map(p=>({seatId:ids[p[0]],roleId:roles[p[1]]})),
    changes:changes.map(c=>({seatId:ids[c[0]],silver:c[1],goods:c[2].map(g=>({id:goods[g[0]],delta:g[1]})),handCount:c[3],
      toolsAdded:c[4].map(i=>cards[i]),toolsRemoved:c[5].map(i=>cards[i])})),
    discard:{beforeCount:d[0],afterCount:d[1],removed:d[2].map(r=>({index:r[0],definitionId:cards[r[1]]})),
      added:d[3].map(r=>({index:r[0],definitionId:cards[r[1]],actorSeatId:r[2]===-1?null:ids[r[2]],reason:reasons[r[3]],source:sourceValue(r[4],ids)}))}};
  const issue=expansionPublicMetadataProblem(result,context);demand(!issue,issue);return result;
}
