import {CARDS as baseCards} from './definitions.mjs';
import {EXPANSION_DATA} from './expansion-one-data.mjs';

export const EXPANSION_PACK_ID='six-trades-v1';
export const EXPANSION_CONTENT_VERSION='yousei-content-v3';
export const CONFIGURABLE_RULE_VERSION='yousei-digital-v3';
export const BASE_PACK_ID='base';
const freeze=value=>{
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
  return value;
};
const baseByCode=new Map(baseCards.map(card=>[card.sourceCode,card]));
export const GOODS=freeze(EXPANSION_DATA.goods);
export const CATEGORIES=freeze(EXPANSION_DATA.categories);
export const ROLES=freeze(EXPANSION_DATA.roles);
export const CARDS=freeze(EXPANSION_DATA.cards.map(row=>{
  const base=baseByCode.get(row.sourceCode);
  const {copies:oldCopies,...face}=base??{};
  if(row.original&&!base)throw new Error(`原版定义缺失：${row.sourceCode}`);
  return {...face,...row,id:base?.id??`yousei.${row.sourceCode.toLowerCase()}`,
    ...(row.category==='goods'?{goods:row.recipe.type==='fixed'?row.recipe.goods:{},actionIncrement:1,timing:'own-use'}:{}),
    ...(!row.original&&row.category!=='goods'?{actionIncrement:row.category==='tool'?0:1,timing:'own-use'}:{})};
}));
const cardsById=new Map(CARDS.map(card=>[card.id,card]));
const rolesById=new Map(ROLES.map(role=>[role.id,role]));
const profiles=new Map();
export function validPlayerCount(count){return Number.isSafeInteger(count)&&count>=2&&count<=6;}
export function expansionProfile(playerCount){
  if(!validPlayerCount(playerCount))throw new RangeError('商人参赛人数须为2～6人。');
  if(!profiles.has(playerCount)){
    const copiesByCode=Object.fromEntries(CARDS.map(card=>[card.sourceCode,card.copiesByPlayerCount[playerCount]]));
    const deckSize=Object.values(copiesByCode).reduce((sum,count)=>sum+count,0);
    profiles.set(playerCount,freeze({packId:EXPANSION_PACK_ID,contentVersion:EXPANSION_CONTENT_VERSION,playerCount,
      deckSize,goodsPerTypeRecommended:3*playerCount,stallBoards:playerCount+3,copiesByCode}));
  }
  return profiles.get(playerCount);
}
export function getExpansionCard(id){
  const card=cardsById.get(id);
  if(!card)throw new RangeError('未知的六行百业牌面。');
  return card;
}
export function getRole(id){
  const role=rolesById.get(id);
  if(!role)throw new RangeError('未知的六行百业角色。');
  return role;
}
export function expansionDefinitionForCopy(copyId,playerCount){
  const profile=expansionProfile(playerCount);
  if(typeof copyId!=='string')return null;
  const match=/^(yousei\.[a-z0-9-]+)#(\d{2})$/u.exec(copyId);
  const card=match&&cardsById.get(match[1]),copy=match?Number(match[2]):0;
  return card&&copy>0&&copy<=profile.copiesByCode[card.sourceCode]?card.id:null;
}
export function createExpansionDeck(playerCount){
  const profile=expansionProfile(playerCount);
  return freeze(CARDS.flatMap(card=>Array.from({length:profile.copiesByCode[card.sourceCode]},(_,index)=>({
    id:`${card.id}#${String(index+1).padStart(2,'0')}`,definitionId:card.id,
  }))));
}

/** A complete physical partition, before dealing or after collecting all zones.
 * The caller owns the zones; this contract does not hide missing held cards. */
export function expansionPartitionProblem(copyIds,playerCount){
  const profile=expansionProfile(playerCount);
  if(!Array.isArray(copyIds)||copyIds.length!==profile.deckSize)return '本局牌实体总数不符。';
  const seen=new Set();
  for(const id of copyIds){
    if(!expansionDefinitionForCopy(id,playerCount))return '本局出现未知牌或超出人数配比的副本。';
    if(seen.has(id))return '本局出现重复牌实体。';
    seen.add(id);
  }
  return null;
}
