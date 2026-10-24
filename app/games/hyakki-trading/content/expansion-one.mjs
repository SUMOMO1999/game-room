import {CARDS as baseCards} from './definitions.mjs';
import {EXPANSION_DATA} from './expansion-one-data.mjs';

export const EXPANSION_PACK_ID='six-trades-v1';
export const LEGACY_EXPANSION_CONTENT_VERSION='yousei-content-v3';
export const EXPANSION_CONTENT_VERSION='yousei-content-v4';
export const CONFIGURABLE_RULE_VERSION='yousei-digital-v3';
export const isExpansionContentVersion=value=>[LEGACY_EXPANSION_CONTENT_VERSION,EXPANSION_CONTENT_VERSION].includes(value);
export const inspectionCardCount=configuration=>configuration?.contentVersion===LEGACY_EXPANSION_CONTENT_VERSION?2:3;
export const BASE_PACK_ID='base';
const freeze=value=>{
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
  return value;
};
const baseByCode=new Map(baseCards.map(card=>[card.sourceCode,card]));
export const GOODS=freeze(EXPANSION_DATA.goods);
export const CATEGORIES=freeze(EXPANSION_DATA.categories);
const legacyRoles=freeze(EXPANSION_DATA.roles);
export const ROLES=freeze(legacyRoles.map(role=>role.sourceCode==='R15'?{...role,
  summary:'每回合第一次摸牌前，可付1两看牌堆顶3张：选1张决定留或弃，未选的两张弃掉。',compactText:'首次摸牌3选1',
  details:['仍只花原本摸牌的1行动。牌不够3张时，只能正常摸牌。','未选的两张进入公开弃牌区；所选牌仍由自己决定留或弃。','本回合只用1次；选弃后继续摸牌，照常再花行动。']}
  :role.sourceCode==='R12'?{...role,details:['普通开局20两，额外银两为本局收市金额减20后乘15%，四舍五入；60两收市时开局26两。','只在开局获得，不是每回合收入。']}:role));
const newOrder={sourceCode:'XG21',name:'新六货大单',category:'goods',original:false,
  copiesByPlayerCount:{2:3,3:3,4:3,5:3,6:3},recipe:{type:'fixed',goods:{mechanism:1,silk:1,pearl:1,herb:1,painting:1,timber:1},count:6},
  buySilver:10,sellSilver:18,summary:'花1行动，机关、锦缎、灵珠、灵植、书画、木材各1件，整组买入或卖出。',compactText:'新六货各1',
  details:['六种新货物各1件，不能用同类或原货物替代。','买入付10两，卖出得18两；临时格费另算。','2～6人新局均配3张；旧内容版牌库不追加。'],costText:'1行动',artPath:null};
export const CARDS=freeze([...EXPANSION_DATA.cards,newOrder].map(row=>{
  const base=baseByCode.get(row.sourceCode);
  const {copies:oldCopies,...face}=base??{};
  if(row.original&&!base)throw new Error(`原版定义缺失：${row.sourceCode}`);
  return {...face,...row,id:base?.id??`yousei.${row.sourceCode.toLowerCase()}`,
    ...(row.category==='goods'?{goods:row.recipe.type==='fixed'?row.recipe.goods:{},actionIncrement:1,timing:'own-use'}:{}),
    ...(!row.original&&row.category!=='goods'?{actionIncrement:row.category==='tool'?0:1,timing:'own-use'}:{})};
}));
const legacyCards=freeze(CARDS.filter(card=>card.sourceCode!=='XG21'));
const cardsById=new Map(CARDS.map(card=>[card.id,card]));
const rolesById=new Map(ROLES.map(role=>[role.id,role]));
const profiles=new Map();
export function cardsForExpansion(version=EXPANSION_CONTENT_VERSION){
  if(!isExpansionContentVersion(version))throw new RangeError('扩展材料版本不符。');
  return version===LEGACY_EXPANSION_CONTENT_VERSION?legacyCards:CARDS;
}
export function validPlayerCount(count){return Number.isSafeInteger(count)&&count>=2&&count<=6;}
export function expansionProfile(playerCount,version=EXPANSION_CONTENT_VERSION){
  if(!validPlayerCount(playerCount))throw new RangeError('商人参赛人数须为2～6人。');
  const cards=cardsForExpansion(version),key=version+':'+playerCount;
  if(!profiles.has(key)){
    const copiesByCode=Object.fromEntries(cards.map(card=>[card.sourceCode,card.copiesByPlayerCount[playerCount]]));
    const deckSize=Object.values(copiesByCode).reduce((sum,count)=>sum+count,0);
    profiles.set(key,freeze({packId:EXPANSION_PACK_ID,contentVersion:version,playerCount,
      deckSize,goodsPerTypeRecommended:3*playerCount,stallBoards:playerCount+3,copiesByCode}));
  }
  return profiles.get(key);
}
export function getExpansionCard(id){
  const card=cardsById.get(id);
  if(!card)throw new RangeError('未知的六行百业牌面。');
  return card;
}
export function getRole(id,configuration=null){
  const version=configuration?.contentVersion??EXPANSION_CONTENT_VERSION;
  if(!isExpansionContentVersion(version))throw new RangeError('扩展角色版本不符。');
  const role=version===LEGACY_EXPANSION_CONTENT_VERSION?legacyRoles.find(r=>r.id===id):rolesById.get(id);
  if(!role)throw new RangeError('未知的六行百业角色。');
  if(role.sourceCode==='R12'&&version===EXPANSION_CONTENT_VERSION){
    const target=configuration?.closingTarget??60;
    if(!Number.isSafeInteger(target)||target<30||target>200||target%10)throw new RangeError('收市金额无效。');
    const initialSilver=20+Math.round((target-20)*.15);
    return {...role,initialSilver,compactText:`开局${initialSilver}两`,summary:`本局${target}两收市，你的开局银两为${initialSilver}两，其他玩家通常为20两。`};
  }
  return role;
}
export function expansionDefinitionForCopy(copyId,playerCount,version=EXPANSION_CONTENT_VERSION){
  const profile=expansionProfile(playerCount,version);
  if(typeof copyId!=='string')return null;
  const match=/^(yousei\.[a-z0-9-]+)#(\d{2})$/u.exec(copyId);
  const card=match&&cardsById.get(match[1]),copy=match?Number(match[2]):0;
  return card&&copy>0&&copy<=profile.copiesByCode[card.sourceCode]?card.id:null;
}
export function createExpansionDeck(playerCount,version=EXPANSION_CONTENT_VERSION){
  const profile=expansionProfile(playerCount,version);
  return freeze(cardsForExpansion(version).flatMap(card=>Array.from({length:profile.copiesByCode[card.sourceCode]},(_,index)=>({
    id:`${card.id}#${String(index+1).padStart(2,'0')}`,definitionId:card.id,
  }))));
}

/** A complete physical partition, before dealing or after collecting all zones.
 * The caller owns the zones; this contract does not hide missing held cards. */
export function expansionPartitionProblem(copyIds,playerCount,version=EXPANSION_CONTENT_VERSION){
  const profile=expansionProfile(playerCount,version);
  if(!Array.isArray(copyIds)||copyIds.length!==profile.deckSize)return '本局牌实体总数不符。';
  const seen=new Set();
  for(const id of copyIds){
    if(!expansionDefinitionForCopy(id,playerCount,version))return '本局出现未知牌或超出人数配比的副本。';
    if(seen.has(id))return '本局出现重复牌实体。';
    seen.add(id);
  }
  return null;
}
