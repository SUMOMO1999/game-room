// A versioned material boundary, never a global widening of legacy GOODS/cards.
import {CARDS,GOODS,ROLES,getExpansionCard,expansionProfile,expansionDefinitionForCopy,createExpansionDeck,
  EXPANSION_CONTENT_VERSION,CONFIGURABLE_RULE_VERSION} from '../content/expansion-one.mjs';
export {CARDS,GOODS,ROLES};
export const CONTENT_VERSION=EXPANSION_CONTENT_VERSION;
export const PLAYER_COUNT_CONTENT_VERSION=EXPANSION_CONTENT_VERSION;
export const DIGITAL_RULE_VERSION='yousei-digital-v1';
export const MULTIPLAYER_RULE_VERSION=CONFIGURABLE_RULE_VERSION;
export const RULE_VERSIONS=Object.freeze([CONFIGURABLE_RULE_VERSION]);
export const getCard=id=>{
  const card=getExpansionCard(id);
  return card.category==='monitored_character'&&!card.original?{...card,cancelableByJinyiwei:true}:card;
};
export const definitionIdForCopy=(id,profile=expansionProfile(6))=>expansionDefinitionForCopy(id,profile.playerCount);
export function materialProfile(version=EXPANSION_CONTENT_VERSION,n=6){
  if(version!==EXPANSION_CONTENT_VERSION)throw new RangeError('扩展材料版本不符。');
  return expansionProfile(n);
}
export const materialProfileFor=state=>materialProfile(state.contentVersion,state.players.length);
export const createDeck=({contentVersion=EXPANSION_CONTENT_VERSION,playerCount=2}={})=>{
  materialProfile(contentVersion,playerCount);return createExpansionDeck(playerCount);
};
