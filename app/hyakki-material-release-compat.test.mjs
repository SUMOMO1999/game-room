import test from 'node:test';
import assert from 'node:assert/strict';
import {CURRENT_DATA_COMPATIBILITY as current,validateDataCompatibility,compareReleaseCompatibility} from '../scripts/release-compatibility.mjs';
const old=structuredClone(current);delete old.hyakkiMaterials;
const manifest=(id,data)=>({format:1,project:'game-room',releaseId:id.repeat(20),containsSecrets:false,containsUserData:false,dataCompatibility:data});
test('old absent material capability stays v1-v3 and forbids bare c468 rollback after v4 writes',()=>{
 assert.deepEqual(validateDataCompatibility(old).hyakkiMaterials,{read:[1,2,3],write:[1,2,3]});
 assert.deepEqual(compareReleaseCompatibility(manifest('a',current),manifest('b',old)),{forwardCompatible:true,rollbackCompatible:false,initial:false,priorLegacy:false});
 assert.deepEqual(compareReleaseCompatibility(manifest('b',old),manifest('a',current)),{forwardCompatible:false,rollbackCompatible:true,initial:false,priorLegacy:false});
 assert.deepEqual(compareReleaseCompatibility(manifest('a',current),manifest('c',current)),{forwardCompatible:true,rollbackCompatible:true,initial:false,priorLegacy:false});
});
test('unknown versions, aliases, duplicates and unreadable own writes fail closed',()=>{
 for(const capability of [{read:[1,2,3,4,5],write:[4]},{read:[1,2,3],write:[4]},{read:[1,2,3,4],write:['4']},{read:[1,2,3,4],write:[4,4]},{read:[1,2,3,4],write:[4],extra:true}]){
  assert.throws(()=>validateDataCompatibility({...current,hyakkiMaterials:capability}),/DATA_COMPATIBILITY_INVALID/);
 }
});
