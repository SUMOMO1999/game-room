import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomPreview } from '../server/room-preview.mjs';
import { createDeck } from './rules.mjs';

const card=(id,value,color='red')=>({id,value,color});
function fixture({observers=1,...options}={}) {
  let time=100000;const service=createRoomPreview({now:()=>time,sweepMs:0,...options});
  const view={roomId:'1'.repeat(32),roomCode:'123456',matchId:'2'.repeat(32),gameType:'rummikub',phase:'playing',selfId:'a',revision:9,
    players:[{id:'a',name:'服务器昵称'},{id:'b',name:'同名朋友'}],game:{status:'playing',ruleVersion:'friends-v2',revision:5,turnPlayerId:'a',opened:true,jokerCount:2,
      board:[[card('red-6-a',6),card('red-7-a',7),card('red-8-a',8)]],rack:[card('red-9-a',9),card('blue-13-a',13,'blue')]}};
  const subscriptions=[];
  for(let index=0;index<observers;index++) subscriptions.push(service.subscribe({...view,selfId:'b'},`observer-${index}`,()=>{}));
  const body={previewId:'source-1234567890',sequence:1,matchId:view.matchId,gameRevision:5,boardIds:[['red-6-a','red-7-a','red-8-a','red-9-a']],positions:[{x:.2,y:.3}]};
  const post=(value=body,live=view)=>{const permit=service.reserve(view.roomCode),prepared=service.prepare(view,value,'owner-session');return service.commit(prepared,live,permit);};
  return {service,view,body,post,subscriptions,advance(ms=6000){time+=ms;},time:()=>time};
}

test('preview exposes only tiles placed on the public table and never mutates a private view or revisions',()=>{
  const f=fixture(),original=structuredClone(f.view),ack=f.post();
  assert.equal(ack.accepted,true);assert.equal(ack.observerCount,1);assert.equal(ack.minIntervalMs,1667);
  const packet=f.service.packet({...f.view,selfId:'b'});
  assert.equal(packet.preview.valid,true);assert.equal(packet.ownerName,'服务器昵称');
  assert.deepEqual(packet.preview.board.flat().map(tile=>tile.id),['red-6-a','red-7-a','red-8-a','red-9-a']);
  assert.ok(!JSON.stringify(packet).includes('blue-13-a'));assert.ok(!JSON.stringify(packet).includes('owner-session'));
  assert.deepEqual(f.view,original);assert.equal(packet.gameRevision,5);
  assert.equal(f.service.packet(f.view,{forStream:true}).preview,null);
});

test('hidden opponent tiles, fabricated tile fields, duplicate and lost public tiles are rejected',()=>{
  for(const change of [
    {boardIds:[['red-6-a','red-7-a','red-8-a','other-hand-secret']]},
    {boardIds:[['red-6-a','red-7-a','red-8-a','red-9-a','red-9-a']]},
    {boardIds:[['red-6-a','red-7-a','red-9-a']]},
    {rackIds:['blue-13-a']}, {ownerName:'冒充昵称'},
    {positions:[{x:0,y:0,z:'private'}]}, {positions:[{x:NaN,y:0}]}]) {
    const f=fixture();assert.throws(()=>f.post({...f.body,...change}));
    assert.equal(f.service.packet(f.view).preview,null);
  }
});

test('temporarily incomplete or out-of-order groups stay visible with a clear invalid flag',()=>{
  const f=fixture();f.post({...f.body,boardIds:[['red-6-a','red-7-a'],['red-9-a','red-8-a']],positions:[{x:0,y:0},{x:.5,y:.5}]});
  const packet=f.service.packet({...f.view,selfId:'b'});assert.equal(packet.preview.valid,false);assert.match(packet.preview.validationMessage,/至少|连续/);
  assert.deepEqual(packet.preview.board[0].map(tile=>tile.value),[6,7]);
});

test('old first-opening and locked-joker rules are not downgraded by temporary previews',()=>{
  const f=fixture();f.view.game.opened=false;f.post();assert.equal(f.service.packet(f.view).preview.valid,false);
  const g=fixture();g.view.game.ruleVersion='friends-v1';g.view.game.board[0][1]={id:'joker-a',value:1,color:'red',joker:true};
  g.body.boardIds=[['red-6-a','joker-a','red-8-a','red-9-a']];g.post();
  assert.equal(g.service.packet(g.view).preview.valid,false);assert.match(g.service.packet(g.view).preview.validationMessage,/旧版.*鬼牌/);
});

test('late checks cannot publish after a turn, match, pause or seat change',()=>{
  for(const edit of [view=>view.game.revision++,view=>view.game.turnPlayerId='b',view=>view.phase='paused',view=>view.matchId='3'.repeat(32),view=>view.selfId='b']) {
    const f=fixture(),permit=f.service.reserve(f.view.roomCode),prepared=f.service.prepare(f.view,f.body,'owner-session'),live=structuredClone(f.view);edit(live);
    assert.throws(()=>f.service.commit(prepared,live,permit),error=>error.code==='PREVIEW_STALE');
    assert.equal(f.service.packet(f.view).preview,null);
  }
});

test('sequence fences concurrent devices, repeated packets and retired sources',()=>{
  const f=fixture();f.post();f.advance();
  assert.throws(()=>f.post(),error=>error.code==='PREVIEW_SEQUENCE');f.advance();
  assert.throws(()=>f.post({...f.body,previewId:'source-different-device'}),error=>error.code==='PREVIEW_SOURCE_BUSY');f.advance();
  const clear={previewId:f.body.previewId,sequence:2,matchId:f.body.matchId,gameRevision:5,clear:true};f.post(clear);f.advance();
  assert.equal(f.service.packet(f.view).preview,null);
  assert.throws(()=>f.post({...f.body,sequence:3}),error=>error.code==='PREVIEW_SEQUENCE');f.advance();
  f.post({...f.body,previewId:'source-next-arrangement'});assert.ok(f.service.packet(f.view).preview);
});

test('expiry and identity failure discard ephemeral public tiles without changing the game',()=>{
  for(const method of ['ttl','identity']) {
    const f=fixture();f.post();
    if(method==='ttl') {f.advance(30001);f.service.sweep();} else f.service.clearSession('owner-session');
    const packet=f.service.packet(f.view);assert.equal(packet.preview,null);assert.equal(packet.clearReason,method==='ttl'?'expired':'identity-failed');
    assert.equal(f.view.game.revision,5);assert.equal(f.view.game.rack.length,2);
  }
});

test('last owner connection closing clears preview while a second same-session connection keeps it',()=>{
  const f=fixture(),off=f.service.subscribe(f.view,'owner-session',()=>{}),off2=f.service.subscribe(f.view,'owner-session',()=>{});f.post();
  off();assert.ok(f.service.packet(f.view).preview);off2();assert.equal(f.service.packet(f.view).preview,null);
  assert.equal(f.service.packet(f.view).clearReason,'disconnected');
});

test('a disconnected author cannot publish after its second identity check waits',()=>{
  const f=fixture(),off=f.service.subscribe(f.view,'owner-session',()=>{}),permit=f.service.reserve(f.view.roomCode),prepared=f.service.prepare(f.view,f.body,'owner-session');
  off();assert.throws(()=>f.service.commit(prepared,f.view,permit),error=>error.code==='PREVIEW_DISCONNECTED');
});

test('observer capacity counts actual other-player connections, not player count or author echoes',()=>{
  const f=fixture({observers:6});f.service.subscribe(f.view,'owner-session',()=>{});f.service.subscribe(f.view,'owner-other-device',()=>{});
  const ack=f.post();assert.equal(ack.observerCount,6);assert.equal(ack.minIntervalMs,4445);
  assert.ok((2+ack.observerCount)/(ack.minIntervalMs/1000)<=1.8);
  assert.throws(()=>f.post({...f.body,sequence:2}),error=>error.status===429 && error.nextAllowedAt>=f.time()+4445);
});

test('cross-room preview checks have one global conservative budget, reads included',()=>{
  const f=fixture({observers:0}),permit=f.service.reserve(f.view.roomCode);assert.equal(permit.cost,2);
  assert.throws(()=>f.service.reserve('654321'),error=>error.status===429);f.advance(1112);
  f.service.reserve('654321',{read:true});
  assert.throws(()=>f.service.reserve(f.view.roomCode),error=>error.status===429);
});

test('army and unknown rule versions cannot use the Rummikub preview channel',()=>{
  for(const change of [{gameType:'army-flip'},{game:{ruleVersion:'friends-future'}}]) {
    const f=fixture(),view={...f.view,...change};assert.throws(()=>f.service.prepare(view,f.body,'owner-session'),error=>error.code==='PREVIEW_UNSUPPORTED');
  }
});

test('v3 preview preserves public ghost type and shares the authoritative whole-draft validation',()=>{
  const f=fixture();f.view.game.ruleVersion='friends-v3';f.view.game.jokerConfig={normal:2,mirror:1,colorChange:1,double:1};f.view.game.jokerCount=5;
  f.view.game.rack=[{id:'joker-normal-1',color:'red',value:1,joker:true,jokerType:'normal'},card('blue-13-a',13,'blue')];
  f.body.boardIds=[['red-6-a','red-7-a','red-8-a','joker-normal-1']];f.post();
  const packet=f.service.packet({...f.view,selfId:'b'});assert.equal(packet.preview.valid,true);assert.equal(packet.preview.board[0][3].jokerType,'normal');
  assert.ok(!JSON.stringify(packet).includes('blue-13-a'));assert.ok(!JSON.stringify(packet).includes('joker-mirror-1'));
});

test('expired-source tombstones survive a long disconnect so delayed writes cannot revive an old public arrangement',()=>{
  const f=fixture({observers:0});f.post();f.advance(60001);f.service.sweep();
  assert.equal(f.service.packet(f.view).preview,null);
  assert.throws(()=>f.post({...f.body,sequence:2}),error=>error.code==='PREVIEW_SEQUENCE');
});

test('simultaneous source claims remain bound to the device that commits first after E3 waits',()=>{
  const f=fixture(),firstPermit=f.service.reserve(f.view.roomCode),first=f.service.prepare(f.view,{...f.body,sequence:2},'device-one');f.advance();
  const secondPermit=f.service.reserve(f.view.roomCode),second=f.service.prepare(f.view,f.body,'device-two');
  f.service.commit(second,f.view,secondPermit);
  assert.throws(()=>f.service.commit(first,f.view,firstPermit),error=>error.code==='PREVIEW_SEQUENCE');assert.equal(f.service.packet(f.view).sequence,1);
});

test('a late older room notification cannot rewind the preview fence or erase current source tombstones',()=>{
  const f=fixture();f.post();const old={...structuredClone(f.view),revision:8,phase:'waiting',game:null};
  f.service.observe(old);assert.ok(f.service.packet(f.view).preview);assert.equal(f.service.packet(old).preview,null);
  f.advance();assert.throws(()=>f.post(),error=>error.code==='PREVIEW_SEQUENCE');
});

test('three decks plus 24 configured ghosts fit the bounded preview without silently imposing the old 159-card ceiling',()=>{
  const f=fixture(),jokerConfig={normal:6,mirror:6,colorChange:6,double:6},deck=createDeck({copies:3,jokerCount:24,jokerConfig});
  const groups=new Map();for(const card of deck.filter(card=>!card.joker)) {const key=card.color+'-'+card.id.split('-').at(-1);if(!groups.has(key)) groups.set(key,[]);groups.get(key).push(card);}
  f.view.game={...f.view.game,ruleVersion:'friends-v3',copies:3,jokerCount:24,jokerConfig,board:[...groups.values()],rack:deck.filter(card=>card.joker)};
  const boardIds=[...f.view.game.board.map(group=>group.map(card=>card.id)),f.view.game.rack.map(card=>card.id)];
  f.post({...f.body,boardIds,positions:undefined});const packet=f.service.packet({...f.view,selfId:'b'});
  assert.equal(packet.preview.board.flat().length,180);assert.equal(packet.preview.valid,false);assert.ok(packet.preview.board.flat().some(card=>card.jokerType==='double'));
});
