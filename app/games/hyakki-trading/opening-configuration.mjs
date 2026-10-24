import {playerCountProfile} from './content/player-count-profile.mjs';
import {PLAYER_COUNT_CONTENT_VERSION} from './content/definitions.mjs';
import {BASE_PACK_ID,EXPANSION_PACK_ID,EXPANSION_CONTENT_VERSION,CONFIGURABLE_RULE_VERSION,expansionProfile,validPlayerCount,isExpansionContentVersion} from './content/expansion-one.mjs';

const fields=new Set(['packId','actionLimit','goodsPerType','goodsSupplyMode','closingTarget']);
const own=(value,key)=>Object.hasOwn(value,key);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const validTarget=value=>integer(value,30,200)&&value%10===0;
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function requireValue(condition,message){if(!condition)throw new RangeError(message);}

/** New-room defaults are separate from old saved-room defaults. */
export function waitingConfiguration(raw,{playerCount,newRoom=false}={}){
  requireValue(validPlayerCount(playerCount),'商人参赛人数须为2～6人。');
  requireValue(record(raw)&&Object.keys(raw).every(key=>fields.has(key)),'准备室配置含未知字段。');
  const packId=own(raw,'packId')?raw.packId:newRoom?EXPANSION_PACK_ID:BASE_PACK_ID;
  requireValue([BASE_PACK_ID,EXPANSION_PACK_ID].includes(packId),'不支持的商人扩展包。');
  const actionLimit=own(raw,'actionLimit')?raw.actionLimit:5;
  const goodsSupplyMode=own(raw,'goodsSupplyMode')?raw.goodsSupplyMode:own(raw,'goodsPerType')?'custom':'recommended';
  const closingTarget=own(raw,'closingTarget')?raw.closingTarget:60;
  requireValue(integer(actionLimit,1,10),'每回合行动上限须为1～10步。');
  requireValue(['recommended','custom'].includes(goodsSupplyMode),'公共货物模式无效。');
  requireValue(validTarget(closingTarget),'收市金额须为30～200两，每10两一档。');
  if(own(raw,'goodsPerType'))requireValue(integer(raw.goodsPerType,4,20),'每种公共货物须为4～20件。');
  const goodsPerType=goodsSupplyMode==='recommended'?3*playerCount:raw.goodsPerType;
  requireValue(integer(goodsPerType,4,20),'手选公共货物须明确填写4～20件。');
  return Object.freeze({packId,actionLimit,goodsSupplyMode,goodsPerType,closingTarget});
}
export function updateWaitingConfiguration(previous,patch,playerCount){
  requireValue(record(patch)&&Object.keys(patch).every(key=>fields.has(key)),'准备室配置含未知字段。');
  const before=waitingConfiguration(previous,{playerCount});
  const mode=own(patch,'goodsSupplyMode')?patch.goodsSupplyMode:own(patch,'goodsPerType')?'custom':before.goodsSupplyMode;
  const configuration=waitingConfiguration({...before,...patch,goodsSupplyMode:mode},{playerCount});
  const priorDisplayed={...before,...(own(previous,'goodsPerType')?{goodsPerType:previous.goodsPerType}:{})};
  return Object.freeze({configuration,changed:Object.keys(configuration).some(key=>configuration[key]!==priorDisplayed[key])});
}
export function freezeMatchConfiguration(raw,participantIds){
  requireValue(Array.isArray(participantIds)&&validPlayerCount(participantIds.length)
    &&participantIds.every(id=>typeof id==='string'&&/^[a-f0-9]{32}$/u.test(id))
    &&new Set(participantIds).size===participantIds.length,'开局须冻结2～6个不同参赛席位。');
  const playerCount=participantIds.length,configuration=waitingConfiguration(raw,{playerCount});
  return Object.freeze({...configuration,playerCount,participantIds:Object.freeze([...participantIds]),
    ruleVersion:CONFIGURABLE_RULE_VERSION,
    contentVersion:configuration.packId===EXPANSION_PACK_ID?EXPANSION_CONTENT_VERSION:PLAYER_COUNT_CONTENT_VERSION});
}
export function materialForConfiguration(configuration){
  requireValue(record(configuration),'开局配置无效。');
  const matchFields=new Set([...fields,'playerCount','participantIds','ruleVersion','contentVersion']);
  requireValue(Object.keys(configuration).length===matchFields.size&&Object.keys(configuration).every(key=>matchFields.has(key)),'开局配置含未知或缺失字段。');
  requireValue(configuration.ruleVersion===CONFIGURABLE_RULE_VERSION,'开局规则版本无效。');
  const current=freezeMatchConfiguration(configurationForWaiting(configuration),configuration.participantIds);
  requireValue(configuration.packId!==EXPANSION_PACK_ID||isExpansionContentVersion(configuration.contentVersion),'开局内容版本无效。');
  // Validate an existing frozen edition; reading a save must not upgrade it.
  const expected=configuration.packId===EXPANSION_PACK_ID?{...current,contentVersion:configuration.contentVersion}:current;
  requireValue(Object.keys(expected).every(key=>key==='participantIds'
    ?expected[key].every((id,index)=>id===configuration[key]?.[index])
    :expected[key]===configuration[key]),'开局配置与冻结参赛人不一致。');
  return configuration.packId===EXPANSION_PACK_ID?expansionProfile(configuration.playerCount,configuration.contentVersion):playerCountProfile(configuration.playerCount);
}
function configurationForWaiting(configuration){return Object.fromEntries([...fields].map(key=>[key,configuration[key]]));}
