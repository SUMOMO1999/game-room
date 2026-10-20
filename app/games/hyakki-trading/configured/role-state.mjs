import {newTradeUsage,tradeUsageProblem} from '../trade-contract.mjs';
export const newTurnUsage=(turnId='turn-1')=>({...newTradeUsage(),turnId,monitorUsed:false,roleUsed:false,toolFeeUsed:false,firstPeekOffered:false});
export const economicUsage=usage=>Object.fromEntries(Object.keys(newTradeUsage()).map(k=>[k,usage[k]]));
export function turnUsageProblem(value,turnId){
  return !value||Object.keys(value).length!==Object.keys(newTurnUsage()).length||tradeUsageProblem(economicUsage(value))
    ||value.turnId!==turnId||['monitorUsed','roleUsed','toolFeeUsed','firstPeekOffered'].some(k=>typeof value[k]!=='boolean')?'回合角色记录无效。':null;
}
export const newRoleState=roleId=>({compensationAvailable:roleId==='yousei.role.r21'});
export const roleStateProblem=(value,roleId)=>!value||Object.keys(value).length!==1||typeof value.compensationAvailable!=='boolean'
  ||roleId!=='yousei.role.r21'&&value.compensationAvailable?'角色保护记录无效。':null;
