// Configurable original-content matches reuse the existing six-goods engine.
// The v3 envelope owns frozen configuration; the old engine sees no new fields.
import * as legacy from '../rules.mjs';
import {privateView,spectatorView} from '../view.mjs';
import {freezeMatchConfiguration,materialForConfiguration} from '../opening-configuration.mjs';
import {CONFIGURABLE_RULE_VERSION,BASE_PACK_ID} from '../content/expansion-one.mjs';
import {MULTIPLAYER_RULE_VERSION} from '../content/definitions.mjs';
export const isConfiguredBase=game=>game?.version===3&&game.ruleVersion===CONFIGURABLE_RULE_VERSION&&game.configuration?.packId===BASE_PACK_ID;
export function baseToLegacy(game){
  const {configuration,...state}=structuredClone(game);return {...state,version:2,ruleVersion:MULTIPLAYER_RULE_VERSION};
}
export const wrapBase=(game,configuration)=>({...game,version:3,ruleVersion:CONFIGURABLE_RULE_VERSION,configuration:structuredClone(configuration)});
export function baseGameProblem(game){
  try{
    if(!isConfiguredBase(game))return '原版可调局格式无效。';
    const c=game.configuration,profile=materialForConfiguration(c);
    if(profile.contentVersion!==game.contentVersion||c.actionLimit!==game.actionLimit||c.goodsPerType!==game.goodsPerType
      ||c.participantIds.length!==game.players.length||c.participantIds.some((id,i)=>id!==game.players[i].id))return '原版可调局配置不符。';
    return legacy.gameProblem(baseToLegacy(game));
  }catch{return '原版可调局保存无效。';}
}
export function createConfiguredBase(ids,{configuration,...options}){
  const frozen=freezeMatchConfiguration(configuration,ids);
  if(frozen.packId!==BASE_PACK_ID)throw new RangeError('原版配置需要原版包。');
  const game=legacy.createGame(ids,{...options,actionLimit:frozen.actionLimit,goodsPerType:frozen.goodsPerType,contentVersion:frozen.contentVersion});
  return wrapBase(game,frozen);
}
export function baseAction(game,actor,action,context){
  const issue=baseGameProblem(game);if(issue)return {ok:false,code:'INVALID_GAME_STATE',error:issue};
  const result=legacy.applyGameAction(baseToLegacy(game),actor,action,{...context,closingTarget:game.configuration.closingTarget});
  return result.ok?{...result,state:wrapBase(result.state,game.configuration)}:result;
}
export function baseTimeout(game,actor,context){
  const issue=baseGameProblem(game);if(issue)return {ok:false,code:'INVALID_GAME_STATE',error:issue};
  const result=legacy.applyTimeout(baseToLegacy(game),actor, {...context,closingTarget:game.configuration.closingTarget});
  return result.ok?{...result,state:wrapBase(result.state,game.configuration)}:result;
}
export const basePrivateView=(game,id)=>wrapBase(privateView(baseToLegacy(game),id),game.configuration);
export const baseSpectatorView=game=>wrapBase(spectatorView(baseToLegacy(game)),game.configuration);
