import {openingProblem,openingView} from './opening.mjs';
import {EXPANSION_CONTENT_VERSION,CONFIGURABLE_RULE_VERSION,expansionDefinitionForCopy} from './content/expansion-one.mjs';

const copy=value=>structuredClone(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const openingGame=game=>game?.kind==='hyakki-opening-game';
export const wrapOpeningGame=opening=>({kind:'hyakki-opening-game',version:3,gameType:'hyakki-trading',ruleVersion:CONFIGURABLE_RULE_VERSION,
  contentVersion:EXPANSION_CONTENT_VERSION,matchId:opening.openingId,status:'playing',result:null,
  stage:opening.status==='completed'?'initialized':'role-selection',players:opening.configuration.participantIds.map(id=>({id})),opening});
export function openingGameProblem(game){
  if(!exact(game,['kind','version','gameType','ruleVersion','contentVersion','matchId','status','result','stage','players','opening'])
    ||!openingGame(game)||game.version!==3||game.gameType!=='hyakki-trading'||game.ruleVersion!==CONFIGURABLE_RULE_VERSION
    ||game.contentVersion!==EXPANSION_CONTENT_VERSION||game.status!=='playing'||game.result!==null)return '扩展开局外壳无效。';
  const issue=openingProblem(game.opening);if(issue)return issue;
  if(game.matchId!==game.opening.openingId||game.stage!==(game.opening.status==='completed'?'initialized':'role-selection')
    ||!same(game.players,game.opening.configuration.participantIds.map(id=>({id}))))return '扩展开局归属无效。';
  return null;
}
export function openingGameView(game,viewerId,{now}={}){
  const issue=openingGameProblem(game);if(issue)throw new TypeError(issue);
  const view=openingView(game.opening,viewerId,{now});
  const players=game.opening.status==='completed'?game.opening.deal.players.map(p=>({id:p.id,roleId:p.roleId,silver:p.silver,
    goods:copy(p.goods),stallCount:p.stallCount,temporaryOccupied:p.temporaryOccupied,tools:[],handCount:5,
    ...(p.id===viewerId?{hand:p.hand.map(cardId=>({cardId,definitionId:expansionDefinitionForCopy(cardId,game.players.length)}))}:{})}))
    :game.players.map(p=>({id:p.id}));
  return {kind:game.kind,version:3,ruleVersion:game.ruleVersion,contentVersion:game.contentVersion,matchId:game.matchId,
    status:game.status,stage:game.stage,players,opening:view};
}
export function openingGameClock(game){
  if(!openingGame(game)||game.opening.status!=='selecting')return null;
  const c=game.opening.clock;
  return {clockVersion:4,kind:'opening',id:game.matchId,deadlineAt:c.deadlineAt,remainingMs:c.remainingMs,paused:c.paused,label:'选择角色'};
}
