import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHyakkiHttpFixture} from './test-support/hyakki-http-fixture.mjs';
import {chooseConfiguredPracticeAction} from './games/hyakki-trading/configured/practice-runtime.mjs';
import {hyakkiCommand} from './games/hyakki-trading/presentation.mjs';
import {historyPacketProblem} from './games/hyakki-trading/room-controller.mjs';
import {buildBattleReport,discardProvenance} from './games/hyakki-trading/battle-report-model.mjs';
for(const n of [2,4,6])test(`${n}人默认装配：实际HTTP／SQLite／SSE由选角打到结算，公开战况连续且重开保留配置`,{timeout:240000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'merchant-full-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=await createHyakkiHttpFixture(t,{storagePath:join(dir,'game.sqlite')}),users=[];
  for(let i=0;i<n;i++)users.push(await f.login(`full-${n}-${i}`));
  const created=await f.request('/api/rooms',users[0],{name:'首家',gameType:'hyakki-trading',requestId:randomUUID()});assert.equal(created.status,201,created.text);const code=created.body.roomCode;
  for(let i=1;i<n;i++)assert.equal((await f.request(`/api/rooms/${code}/join`,users[i],{name:`成员${i}`,requestId:randomUUID()})).status,201);
  const streams=await Promise.all(users.map(u=>f.listen(code,u)));
  let waiting=await f.view(code,users[0]);assert.equal(waiting.hyakkiConfig.packId,'six-trades-v1');assert.equal(waiting.hyakkiConfig.goodsPerType,3*n);
  await f.action(code,users[0],'configure',{hyakkiConfig:{actionLimit:5,closingTarget:30}});
  for(const u of users)await f.action(code,u,'ready',{ready:true});await f.action(code,users[0],'start');
  const initial=await Promise.all(users.map(u=>f.view(code,u)));
  const post=async(i,view,command)=>{const body={type:command.type,...hyakkiCommand(view.game,command.type,command),expectedRevision:view.revision,requestId:randomUUID()};
    const result=await f.request(`/api/rooms/${code}/actions`,users[i],body);assert.equal(result.status,200,JSON.stringify({body,result:result.body}));return result.body.view;};
  await Promise.all(initial.map((v,i)=>post(i,v,chooseConfiguredPracticeAction(v.game,v.selfId))));
  let view=await f.view(code,users[0]),steps=0;assert.equal(view.game.stage,'draw');assert.equal(view.game.deckCount,183+45*(n-2)-5*n);
  while(view.game.status==='playing'&&steps++<1600){
    // A complete match spans elapsed play time; do not batch every HTTP read
    // into one frozen rate-limit window or disable the production limiter.
    f.advance(1000);
    await f.runtime.rooms.sweep();
    view=await f.view(code,users[0]);
    const actorId=view.game.pending?.actorId??view.game.turnPlayerId,index=initial.findIndex(v=>v.selfId===actorId),own=index===0?view:await f.view(code,users[index]);
    const command=chooseConfiguredPracticeAction(own.game,actorId,{now:own.serverTime});assert.ok(command,`no action ${own.game.stage}`);
    await post(index,own,command);view=await f.view(code,users[0]);
    if(steps%25===0)for(const [i,stream] of streams.entries()){
      const received=await stream.wait(p=>p.event==='view'&&p.data.revision===view.revision);
      assert.equal(received.data.game.players.filter(p=>p.hand).length,1);assert.equal(received.data.game.players.find(p=>p.hand).id,initial[i].selfId);
    }
  }
  assert.equal(view.game.status,'finished',`steps ${steps}`);assert.equal(view.game.configuration.closingTarget,30);
  const groups=[];let after=0;
  do{const page=await f.request(`/api/hyakki/matches/${view.matchId}/events?after=${after}&limit=50&roomCode=${code}`,users[0]);assert.equal(page.status,200,page.text);assert.equal(historyPacketProblem(page.body,view,after),null);groups.push(...page.body.groups);after=page.body.nextAfter;if(!page.body.hasMore)break;}while(after<10000);
  assert.equal(groups.length,view.game.publicEventSequence);assert.ok(groups.at(-1).events.some(e=>e.type==='match-ended'));
  const report=buildBattleReport(groups,{game:view.game,players:view.matchPlayers??view.players});assert.deepEqual(report.issues,[]);assert.equal(report.opening.length,1);assert.ok(report.turns.every(turn=>turn.complete));
  assert.equal(discardProvenance(groups,view.game.discard).length,view.game.discard.length);
  const rematch=await f.request(`/api/rooms/${code}/actions`,users[0],{type:'rematch',requestId:randomUUID(),expectedRevision:view.revision});assert.equal(rematch.status,200,rematch.text);waiting=await f.view(code,users[0]);assert.equal(waiting.phase,'waiting');assert.equal(waiting.hyakkiConfig.packId,'six-trades-v1');assert.equal(waiting.hyakkiConfig.closingTarget,30);
});
