// A versioned material boundary, never a global widening of legacy GOODS/cards.
import {CARDS,GOODS,ROLES,getRole as expansionRole,unrestrictedRoleExchange as expansionRoleExchange,getExpansionCard,expansionProfile,expansionDefinitionForCopy,createExpansionDeck,
  EXPANSION_CONTENT_VERSION,CONFIGURABLE_RULE_VERSION,isExpansionContentVersion} from '../content/expansion-one.mjs';
import {EXPANSION_TWO_CONTENT_VERSION,EXPANSION_TWO_BASE_CONTENT_VERSION,TRADE_ROUTES_CARDS,TRADE_ROUTES_ROLES,composeTradeRoutes} from '../content/expansion-two.mjs';
export {isExpansionContentVersion};
export {CARDS,GOODS,ROLES};
export const CONTENT_VERSION=EXPANSION_CONTENT_VERSION;
export const PLAYER_COUNT_CONTENT_VERSION=EXPANSION_CONTENT_VERSION;
export const DIGITAL_RULE_VERSION='yousei-digital-v1';
export const MULTIPLAYER_RULE_VERSION=CONFIGURABLE_RULE_VERSION;
export const RULE_VERSIONS=Object.freeze([CONFIGURABLE_RULE_VERSION]);
export const getCard=id=>{
  const card=TRADE_ROUTES_CARDS.find(face=>face.id===id)??getExpansionCard(id);
  return card.category==='monitored_character'&&!card.original?{...card,cancelableByJinyiwei:true}:card;
};
export function definitionIdForCopy(id,profile=expansionProfile(6)){
  if(profile.contentVersion!==EXPANSION_TWO_CONTENT_VERSION)return expansionDefinitionForCopy(id,profile.playerCount,profile.contentVersion);
  const copy=tradeRoutesCopy(id);
  if(!copy)return expansionDefinitionForCopy(id,profile.playerCount,EXPANSION_TWO_BASE_CONTENT_VERSION);
  const face=TRADE_ROUTES_CARDS.find(card=>card.id===copy[1]);
  return face&&Number(copy[2])>=1&&Number(copy[2])<=profile.copiesByCode[face.sourceCode]?face.id:null;
}
const tradeRoutesCopy=id=>typeof id==='string'?/^(yousei\.e2[a-z0-9]+)#(\d{2})$/u.exec(id):null;
// A face lookup may see either edition. Admission of copies uses the frozen match.
export function configuredDefinitionId(id){
  const copy=tradeRoutesCopy(id);
  if(!copy)return definitionIdForCopy(id);
  const face=TRADE_ROUTES_CARDS.find(card=>card.id===copy[1]);
  return face&&Number(copy[2])>=1&&Number(copy[2])<=face.copiesByPlayerCount[6]?face.id:null;
}
export function getRole(id,configuration){
  if(configuration==null)return TRADE_ROUTES_ROLES.find(role=>role.id===id)??expansionRole(id);
  if(configuration?.contentVersion!==EXPANSION_TWO_CONTENT_VERSION)return expansionRole(id,configuration);
  return TRADE_ROUTES_ROLES.find(role=>role.id===id)??expansionRole(id,{...configuration,contentVersion:EXPANSION_TWO_BASE_CONTENT_VERSION});
}
export const unrestrictedRoleExchange=configuration=>configuration?.contentVersion===EXPANSION_TWO_CONTENT_VERSION||expansionRoleExchange(configuration);
export function materialProfile(version=EXPANSION_CONTENT_VERSION,n=6){
  if(!isExpansionContentVersion(version))throw new RangeError('扩展材料版本不符。');
  return expansionProfile(n,version);
}
export const materialProfileFor=state=>state.contentVersion===EXPANSION_TWO_CONTENT_VERSION
  ?composeTradeRoutes(state.players.length,state.configuration.modules)
  :materialProfile(state.contentVersion,state.players.length);
export const createDeck=({contentVersion=EXPANSION_CONTENT_VERSION,playerCount=2}={})=>{
  materialProfile(contentVersion,playerCount);return createExpansionDeck(playerCount,contentVersion);
};
