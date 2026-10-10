import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, advanceGame, applyAction, projectGame } from './rules.mjs';
import { toPoker414View } from './presentation.mjs';
import { poker414MotionPlan } from './motion-ui.mjs';
import { choosePoker414BotAction } from './practice-bot.mjs';

const members=['a','b','c'];
function view(game,selfId='a',selfRole='player') {
  return toPoker414View({roomId:'room',roomCode:'123456',gameType:'poker414-2',matchId:game.matchId,revision:game.revision,selfId,selfRole,hostId:'a',phase:game.status==='finished'?'finished':'playing',players:members.map(id=>({id,name:id,ready:true,connected:true})),spectators:[],game:projectGame(game,{playerId:selfId,role:selfRole})});
}
function fresh(){return createGame({players:members,matchId:'motion-test',random:()=>.999,now:0,dealBatchSize:18,dealIntervalMs:250});}
function dealt(){return advanceGame(fresh(),{now:1500}).state;}
function play(game,ids,type='play',at=1600){
  const actor=type==='play'?game.turnPlayerId:game.players.find(player=>player.id!==game.target.ownerId&&player.hand.filter(id=>ids.includes(id)).length===ids.length).id;
  const result=applyAction(game,{type,playerId:actor,matchId:game.matchId,roundId:game.roundId,targetId:game.target?.id??null,...(type==='play'?{cardIds:ids}:{windowId:game.responseWindow.id})},{now:at});
  assert.equal(result.ok,true,result.error);return result.state;
}
test('accepted deal batches animate only newly revealed own cards',()=>{
  const before=fresh(),after=advanceGame(before,{now:250}).state,plan=poker414MotionPlan(view(before),view(after));
  assert.equal(plan.kind,'deal');assert.deepEqual(plan.ids,after.players.find(player=>player.id==='a').hand);
  assert.equal(poker414MotionPlan(view(before,'a','spectator'),view(after,'a','spectator')),null);
  assert.equal(poker414MotionPlan(view(after),view(after)),null);
});
test('own accepted play is linked to its hand entities and public group',()=>{
  const game=dealt(),actor=game.turnPlayerId,id=game.players.find(player=>player.id===actor).hand[0],after=play(game,[id]);
  const plan=poker414MotionPlan(view(game,actor),view(after,actor));
  assert.deepEqual(plan,{kind:'play',ownerId:actor,ids:[id],own:true});
  const other=members.find(id=>id!==actor);assert.equal(poker414MotionPlan(view(game,other),view(after,other)).own,false);
});
test('bomb and rocket are locally distinguished by the accepted public pattern',()=>{
  const game=dealt(),actor=game.players.find(player=>player.id===game.turnPlayerId);
  for(const ids of [actor.hand.filter(id=>id.includes('-4-')).slice(0,3),actor.hand.filter(id=>id.includes('-4-')).slice(0,2).concat(actor.hand.find(id=>id.includes('-14-')))]){
    const after=play(game,ids),plan=poker414MotionPlan(view(game,actor.id),view(after,actor.id));
    assert.equal(plan.kind,ids.some(id=>id.includes('-14-'))?'rocket':'bomb');
  }
});
test('response additions come from the new owner; the old cards do not fly again',()=>{
  let game=dealt(),actor=game.players.find(player=>player.id===game.turnPlayerId);
  const rank=actor.hand.map(id=>id.match(/-(\d+)-\d$/)?.[1]).find(rank=>Number(rank)<=15&&game.players.some(player=>player.id!==actor.id&&player.hand.filter(id=>id.includes(`-${rank}-`)).length>=2));
  game=play(game,[actor.hand.find(id=>id.includes(`-${rank}-`))]);
  const responder=game.players.find(player=>player.id!==game.target.ownerId&&player.hand.filter(id=>id.includes(`-${rank}-`)).length>=2),ids=responder.hand.filter(id=>id.includes(`-${rank}-`)).slice(0,2);
  const after=play(game,ids,'fork',1700),plan=poker414MotionPlan(view(game,responder.id),view(after,responder.id));
  assert.equal(plan.kind,'fork');assert.deepEqual(new Set(plan.ids),new Set(ids));assert.equal(plan.own,true);
});
test('role, match, disconnect, paused practice and sequence gaps are baselines',()=>{
  const before=view(fresh()),after=view(advanceGame(fresh(),{now:250}).state);
  for(const changed of [{...after,selfId:'b'},{...after,selfRole:'spectator'},{...after,matchId:'different'},{...after,connection:'offline'},{...after,clockPaused:true},{...after,eventSeq:after.eventSeq+1}])assert.equal(poker414MotionPlan(before,changed),null);
});
test('the winning accepted play still arrives at the public pile in the finished projection',()=>{
  let game=dealt(),now=1600,pair=null;
  for(let index=0;index<100&&!pair;index++){
    if(game.responseWindow){now=Math.max(now,game.responseWindow.deadlineAt);game=advanceGame(game,{now}).state;}
    const actor=game.turnPlayerId,action=choosePoker414BotAction(projectGame(game,{role:'player',playerId:actor}),actor,{now});
    const result=applyAction(game,action,{now:now++});assert.equal(result.ok,true,result.error);
    if(result.state.status==='finished')pair={before:game,after:result.state,actor};game=result.state;
  }
  assert.ok(pair);const plan=poker414MotionPlan(view(pair.before,pair.actor),view(pair.after,pair.actor));
  assert.ok(plan);assert.equal(plan.own,true);assert.deepEqual(plan.ids,pair.before.players.find(player=>player.id===pair.actor).hand);
});
