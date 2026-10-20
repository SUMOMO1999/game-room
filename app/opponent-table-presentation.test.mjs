import test from 'node:test';import assert from 'node:assert/strict';
import {opponentTableEvent} from './games/hyakki-trading/game-ui-model.mjs';
const room=(seq,type='draw-peeked',cardId)=>({selfId:'a',selfRole:'player',phase:'playing',game:{matchId:'m',turnId:'t',turnPlayerId:'b',publicEventSequence:seq,lastPublicEvents:[{type,actorSeatId:'b',...(cardId?{cardId}:{})}]}});
test('opponent public card stays readable through idle and non-card updates without replaying the event',()=>{
  assert.equal(opponentTableEvent(null,room(1)),null);
  const previous=room(1),next=room(2,'character-played','yousei.c03'),shown=opponentTableEvent(previous,next);
  assert.equal(shown.event.cardId,'yousei.c03');
  assert.equal(opponentTableEvent(next,next,shown),shown);
  const decision=room(3,'choice-resolved');assert.equal(opponentTableEvent(next,decision,shown),shown);
  assert.equal(opponentTableEvent(next,{...next,game:{...next.game,turnId:'next',turnPlayerId:'a'}},shown),null);
  assert.equal(opponentTableEvent(next,{...next,selfId:'new'},shown),null);
});
test('private draws and kept cards remain backs; only public discard reveals a face',()=>{
  for(const type of ['draw-peeked','draw-kept'])assert.equal(opponentTableEvent(room(1),room(2,type,'yousei.c03')).event.cardId,undefined);
  assert.equal(opponentTableEvent(room(1),room(2,'draw-discarded','yousei.c03')).event.cardId,'yousei.c03');
});
