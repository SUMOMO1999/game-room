import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrawAndGuessAdapter } from '../server/games/draw-and-guess/adapter.mjs';
import { snapshotHasRoles, snapshotAuthorityBindingProblem, snapshotFormatProblem } from '../server/room-snapshot-compat.mjs';
import { CURRENT_DATA_COMPATIBILITY, compareReleaseCompatibility } from '../scripts/release-compatibility.mjs';

test('drawing settings use schema19, old schema10/17/18 stay readable, other games cannot use it',()=>{
  const adapter=createDrawAndGuessAdapter();assert.equal(adapter.snapshotSchema(),19);
  for(const schemaVersion of [10,17,18,19]) {
    const snapshot={schemaVersion,gameType:'draw-and-guess',game:null,drawConfig:{},turnClock:null,spectators:[],roomId:'room',code:'123456'};
    assert.equal(snapshotHasRoles(snapshot),true);assert.equal(adapter.snapshotProblem(snapshot),false);
    assert.equal(Boolean(snapshotFormatProblem(snapshot,adapter)),false);
    assert.equal(snapshotAuthorityBindingProblem(snapshot,{roomId:'room',code:'123456'}),false);
    assert.equal(snapshotAuthorityBindingProblem(snapshot,{roomId:'different',code:'123456'}),true);
  }
  for(const gameType of ['rummikub','army-flip','flying-chess','poker414-2','hyakki-trading','parks'])
    assert.equal(Boolean(snapshotFormatProblem({schemaVersion:17,gameType,spectators:[],turnClock:null},{gameType,snapshotProblem:()=>false})),true);
});

test('published schema18 baseline can upgrade, but cannot roll back configurable candidate writes',()=>{
  const manifest=dataCompatibility=>({format:1,project:'game-room',releaseId:'a'.repeat(20),containsSecrets:false,containsUserData:false,dataCompatibility});
  const prior=structuredClone(CURRENT_DATA_COMPATIBILITY);
  prior.roomSnapshots.read=prior.roomSnapshots.read.filter(v=>v!==19);
  prior.roomSnapshots.write=prior.roomSnapshots.write.filter(v=>v!==19);
  assert.deepEqual(compareReleaseCompatibility(manifest(CURRENT_DATA_COMPATIBILITY),manifest(prior)),
    {forwardCompatible:true,rollbackCompatible:false,initial:false,priorLegacy:false});
  assert.equal(compareReleaseCompatibility(manifest(prior),manifest(CURRENT_DATA_COMPATIBILITY)).forwardCompatible,false);
  assert.deepEqual(CURRENT_DATA_COMPATIBILITY.backupScopes,prior.backupScopes);
});
