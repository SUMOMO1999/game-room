import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGameRegistry,defaultGameRegistry} from './game-registry.mjs';
import {createHyakkiOpeningContractAdapter} from '../server/games/hyakki-trading/opening-contract-adapter.mjs';
import {createHyakkiHttpFixture} from './test-support/hyakki-http-fixture.mjs';
import {historyPacketProblem} from './games/hyakki-trading/room-controller.mjs';
import {decodeHistory4Metadata} from './games/hyakki-trading/public-history-v4.mjs';
import {publicAssetPaths} from '../server/public-assets.mjs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

for(const n of [2,6])test(`${n}人真实HTTP／SQLite／SSE：私有选角到统一公开，战况权限与重试`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'merchant-opening-http-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const gameRegistry=createGameRegistry(defaultGameRegistry.knownTypes().map(type=>type==='hyakki-trading'
    ?createHyakkiOpeningContractAdapter():defaultGameRegistry.gameAdapter(type)),{creationTypes:['hyakki-trading']});
  const f=await createHyakkiHttpFixture(t,{gameRegistry,storagePath:join(directory,'room.sqlite')}),members=[];
  for(let i=0;i<n+2;i++)members.push(await f.login(`opening-${i}`));
  const players=members.slice(0,n),observer=members[n],outsider=members[n+1];
  const created=await f.request('/api/rooms',players[0],{name:'房主',gameType:'hyakki-trading',requestId:randomUUID()});
  assert.equal(created.status,201,created.text);const code=created.body.roomCode;
  for(let i=1;i<=n;i++)assert.equal((await f.request(`/api/rooms/${code}/join`,members[i],{name:`成员${i}`,requestId:randomUUID(),
    ...(i===n?{role:'spectator'}:{})})).status,201);
  const streams=await Promise.all([...players,observer].map(member=>f.listen(code,member)));
  for(const member of players)await f.action(code,member,'ready',{ready:true});
  const started=await f.action(code,players[0],'start'),path=`/api/hyakki/matches/${started.view.matchId}/events`;
  const packets=await Promise.all(streams.map(s=>s.wait(p=>p.event==='view'&&p.data.game?.stage==='role-selection')));
  for(let i=0;i<n;i++){
    const own=packets[i].data.game.opening.self.candidates;
    assert.equal(own.length,3);
    for(let j=0;j<=n;j++)if(j!==i)for(const id of own)assert.equal(JSON.stringify(packets[j].data).includes(id),false);
  }
  assert.equal(packets[n].data.game.opening.self,undefined);
  assert.equal((await f.runtime.storage.scan('hyakki-events')).length,0);
  assert.equal((await f.request(path,players[0])).status,404);
  const commands=packets.slice(0,n).map(p=>({type:'confirm-role',requestId:randomUUID(),expectedRevision:p.data.revision,
    openingId:p.data.matchId,candidateId:p.data.game.opening.self.candidateId,roleId:p.data.game.opening.self.candidates[0]}));
  assert.equal((await f.request(`/api/rooms/${code}/actions`,observer,commands[0])).status,403);
  assert.equal((await f.request(`/api/rooms/${code}/actions`,players[1],commands[0])).status,409);
  const results=await Promise.all(players.map((member,i)=>f.request(`/api/rooms/${code}/actions`,member,commands[i])));
  assert.deepEqual(results.map(r=>r.status),Array(n).fill(200),results.map(r=>r.text).join('\n'));
  const publicViews=await Promise.all(streams.map(s=>s.wait(p=>p.event==='view'&&p.data.game?.stage==='initialized')));
  for(let i=0;i<=n;i++){
    const v=publicViews[i].data,privateHands=v.game.players.filter(p=>Object.hasOwn(p,'hand'));
    assert.equal(privateHands.length,i===n?0:1);
    if(i<n){assert.equal(privateHands[0].id,v.selfId);assert.equal(privateHands[0].hand.length,5);}
    assert.equal(v.game.players.length,n);assert.ok(v.game.players.every(p=>p.roleId));
    for(const forbidden of ['candidates','unusedRoles','remainingRoles','"deck"','userKey'])assert.equal(JSON.stringify(v).includes(forbidden),false);
  }
  const page=await f.request(`${path}?roomCode=${code}`,observer);assert.equal(page.status,200,page.text);
  assert.equal(page.body.groups.length,1);assert.equal(historyPacketProblem(page.body,publicViews[n].data),null);
  const facts=decodeHistory4Metadata(page.body.groups[0].metadata,{contentVersion:publicViews[0].data.game.contentVersion,
    participantIds:publicViews[0].data.game.players.map(p=>p.id)});
  assert.equal(facts.rolesRevealed.length,n);assert.ok(facts.changes.every(c=>c.handCount===5));
  for(const forbidden of ['fingerprint','userKey','"hand"','"deck"','candidates','commitId','#01'])assert.equal(page.text.includes(forbidden),false);
  assert.equal((await f.request(`${path}?roomCode=${code}`,outsider)).status,403);
  assert.equal((await f.request(path,observer)).status,403);
  assert.equal((await f.request(path)).status,401);
  const before=await f.runtime.storage.scan('hyakki-event-meta');
  assert.equal((await f.request(`/api/rooms/${code}/actions`,players[0],commands[0])).status,200);
  assert.equal((await f.runtime.storage.scan('hyakki-events')).length,1);
  assert.deepEqual(await f.runtime.storage.scan('hyakki-event-meta'),before);
  const saved=(await f.runtime.storage.read('rooms',started.view.roomId)).value.snapshot;
  assert.equal(saved.game.opening.deal.deck.length,183+45*(n-2)-5*n);
});

test('正式商人页面静态依赖闭包完整，练习所需纯规则显式公开，服务端／适配器／测试不公开',async()=>{
  const allowed=new Set(publicAssetPaths()),visited=new Set(),queue=['games/hyakki-trading/room-controller.mjs','games/hyakki-trading/practice-page.mjs'];
  while(queue.length){
    const file=queue.pop();if(visited.has(file))continue;visited.add(file);assert.ok(allowed.has(file),file);
    const source=await readFile(new URL(file,import.meta.url),'utf8');
    for(const m of source.matchAll(/^\s*(?:import\s+(?:[^;'"]+?\sfrom\s*)?|export\s*\{[^}]*\}\sfrom\s*)['"]([^'"]+)['"]/gmu)){
      assert.ok(m[1].startsWith('.'),`${file}: ${m[1]}`);
      const resolved=fileURLToPath(new URL(m[1],new URL(file,import.meta.url)));
      queue.push(resolved.slice(fileURLToPath(new URL('./',import.meta.url)).length));
    }
  }
  for(const internal of ['hyakki-opening-durable.test.mjs',
    'test-support/hyakki-http-fixture.mjs','../server/games/hyakki-trading/opening-contract-adapter.mjs'])assert.equal(allowed.has(internal),false,internal);
});
