import test from 'node:test';
import assert from 'node:assert/strict';
import {createConfiguredBase,baseGameProblem,baseAction,baseTimeout} from './base.mjs';
const ids=['1'.repeat(32),'2'.repeat(32)];
const create=target=>createConfiguredBase(ids,{configuration:{packId:'base',closingTarget:target},matchId:'a'.repeat(32),now:1000,randomInt:m=>m-1});
const act=(game,type)=>{const r=baseAction(game,game.turnPlayerId,{type,matchId:game.matchId,turnId:game.turnId,
  ...(game.pending?{effectId:game.pending.id,decisionId:`${game.pending.id}:peek`}:{})},{now:game.committedAt+1,randomInt:m=>m-1});assert.equal(r.ok,true,r.error);return r.state;};
test('原版新局也按冻结30两触发收市，默认60两保留；客户端正文不能覆盖目标',()=>{
  for(const target of [30,60,200]){
    let game=create(target);game.players[0].silver=target-1;game=act(act(game,'peek'),'keep-peek');game=act(game,'end-turn');
    assert.equal(game.closing.triggerPlayerId,ids[0]);assert.equal(game.players[0].silver,target);assert.equal(baseGameProblem(game),null);
    const changed=structuredClone(game);changed.configuration.closingTarget=31;assert.ok(baseGameProblem(changed));
  }
});
test('自动用完行动与主动超时也沿同一冻结金额，不能回退到60',()=>{
  let game=create(30);game.players[0].silver=30;
  const r=baseTimeout(game,ids[0],{now:game.timing.active.deadlineAt,randomInt:m=>m-1});
  assert.equal(r.ok,true,r.error);assert.equal(r.state.closing.triggerPlayerId,ids[0]);assert.equal(r.state.configuration.closingTarget,30);
});
