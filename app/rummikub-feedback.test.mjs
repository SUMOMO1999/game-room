import test from 'node:test';
import assert from 'node:assert/strict';
import {updateTurnFeedback,turnFeedbackMessage} from './rummikub-feedback.mjs';
function view(ids,turn='friend',revision=1,fields={}) {
  return {roomId:'room-a',selfId:'me',matchId:'match-a',phase:'playing',gameType:'rummikub',
    players:[{id:'friend',name:'朋友'}],game:{revision,turnPlayerId:turn,board:[ids.map(id=>({id}))]},...fields};
}
test('friends additions persist for the whole interval and through your next turn; own completion clears them',()=>{
  const a=view(['old']),initial=updateTurnFeedback(null,a);
  const b=view(['old','friend-a'],'third',2),first=updateTurnFeedback(initial,b);
  const c=view(['old','friend-a','friend-b'],'me',3),second=updateTurnFeedback(first,c);
  assert.deepEqual(second.newIds,['friend-a','friend-b']);assert.equal(turnFeedbackMessage(c,2),'轮到你了 · 朋友新出了 2 张牌');
  const metadata={...c,revision:100};assert.deepEqual(updateTurnFeedback(second,metadata),second);
  const ownCompleted=view(['old','friend-a','friend-b','own'],'friend',4);
  assert.deepEqual(updateTurnFeedback(second,ownCompleted).newIds,[]);
});
test('refresh with newer game restores additions using the same identity and match; forged or unrelated save establishes a baseline',()=>{
  const saved=updateTurnFeedback(null,view(['old'],'friend',1));
  assert.deepEqual(updateTurnFeedback(saved,view(['old','new'],'me',3)).newIds,['new']);
  for(const change of [{roomId:'other'},{selfId:'other'},{matchId:'other'},{baselineIds:['missing']},{baselineIds:['old','old']},{gameRevision:100}]) {
    assert.deepEqual(updateTurnFeedback({...saved,...change},view(['old','new'],'me',3)).newIds,[]);
  }
});
test('rearranging already public tiles creates no fictitious new cards, and a new match never inherits badges',()=>{
  const saved=updateTurnFeedback(null,view(['a','b'],'friend',1));
  assert.deepEqual(updateTurnFeedback(saved,view(['b','a'],'me',2)).newIds,[]);
  assert.deepEqual(updateTurnFeedback(saved,view(['c'],'me',0,{matchId:'match-b'})).newIds,[]);
  assert.equal(updateTurnFeedback(saved,view(['a'],'friend',2,{gameType:'army-flip'})),null);
});
