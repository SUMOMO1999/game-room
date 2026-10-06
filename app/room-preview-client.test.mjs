import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from './room-client.mjs';
const CODE='123456';
const view=(extra={})=>({roomCode:CODE,roomId:'1'.repeat(32),matchId:'2'.repeat(32),selfId:'b',gameType:'rummikub',phase:'playing',revision:10,
  game:{revision:4,turnPlayerId:'a'},...extra});
const preview=(extra={})=>({version:1,roomCode:CODE,roomId:'1'.repeat(32),matchId:'2'.repeat(32),gameRevision:4,turnPlayerId:'a',ownerId:'a',ownerName:'牌友',
  previewId:'source-1234567890',sequence:1,updatedAt:Date.now(),expiresAt:Date.now()+30000,
  preview:{board:[[{id:'red-9',color:'red',value:9}]],positions:[{x:0,y:0}],valid:false,validationMessage:'整理中'},...extra});
function fixture(t) {
  const packets=[],client=new RoomClient(CODE,{playerId:'b',token:'private-seat-token'}, {onView(){},onError(){},onConnection(){},onPreview:packet=>packets.push(packet)});
  client.receive(view());t.after(()=>client.stop());packets.length=0;return {client,packets};
}
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('client accepts only the current match, revision, turn and monotonic preview sequence',t=>{
  const {client,packets}=fixture(t);client.receivePreview(preview());
  assert.equal(packets.at(-1).preview.board[0][0].value,9);const count=packets.length;
  for(const extra of [{roomId:'x'},{roomCode:'999999'},{matchId:'x'},{gameRevision:3},{turnPlayerId:'b'},{ownerId:'b'},
    {sequence:0},{sequence:1},{expiresAt:Date.now()-1}]) client.receivePreview(preview(extra));
  assert.equal(packets.length,count);
  client.receivePreview(preview({sequence:2}));assert.equal(packets.at(-1).sequence,2);
});

test('committed turn or phase changes clear read-only preview without mutating the private view',t=>{
  const {client,packets}=fixture(t);client.receivePreview(preview());const original=structuredClone(client.view);
  client.receive(view({revision:11,game:{revision:5,turnPlayerId:'b'}}));assert.equal(packets.at(-1),null);assert.equal(client.previewPacket,null);
  assert.deepEqual(original,view());client.receivePreview(preview());assert.equal(client.previewPacket,null);
});

test('a lost preview POST response reconciles by GET and never replays the write',async t=>{
  const {client}=fixture(t),calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});if(calls.length===1) throw new TypeError('response lost');return response(preview());});
  await assert.rejects(client.sendPreview({previewId:'source-1234567890',sequence:1,matchId:'2'.repeat(32),gameRevision:4,boardIds:[['red-9']]}),/整理预览结果未确认/);
  assert.equal(calls.length,2);assert.equal(calls[0].options.method,'POST');assert.equal(calls[1].options.method,'GET');
  assert.equal(calls[0].url,`/api/rooms/${CODE}/preview`);assert.equal(calls[1].url,calls[0].url);assert.equal(client.previewPacket.sequence,1);
});

test('preview 429 passes scheduling metadata without triggering auth failure or write retries',async t=>{
  const {client}=fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return response({error:'合并中',code:'PREVIEW_RATE_LIMIT',minIntervalMs:4445,nextAllowedAt:123456,retryAfter:5},429);});
  await assert.rejects(client.sendPreview({}),error=>error.status===429 && error.minIntervalMs===4445 && error.nextAllowedAt===123456);
  assert.equal(calls,1);assert.equal(client.stopped,false);
});

test('preview subscriptions are opt-in and parsed safely alongside committed SSE views',async t=>{
  const {client,packets}=fixture(t),messages=`event: view\ndata: ${JSON.stringify(view())}\n\nevent: preview\ndata: ${JSON.stringify(preview())}\n\nevent: closed\ndata: {"status":404}\n\n`;
  t.mock.method(globalThis,'fetch',async(url)=>{assert.equal(url,`/api/rooms/${CODE}/events?preview=1`);return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(messages));controller.close();}}));});
  await assert.rejects(client.readStream(new AbortController()),error=>error.status===404);
  assert.ok(packets.some(packet=>packet?.preview));assert.equal(packets.at(-1),null);assert.equal(client.view.game.revision,4);
});

test('expiry clears a preview, and stopped clients reject late preview replies',async t=>{
  const {client,packets}=fixture(t);client.receivePreview(preview({expiresAt:Date.now()+15}));
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(packets.at(-1),null);
  client.stop();const count=packets.length;client.receivePreview(preview({sequence:2}));assert.equal(packets.length,count);
});

test('SSE connection capacity is a 429 and cannot create a reconnect loop or invalidate an account',async t=>{
  const errors=[],connections=[],client=new RoomClient(CODE,{playerId:'b',token:'token'},{onView(){},onError:error=>errors.push(error),onConnection:state=>connections.push(state),onPreview(){}});t.after(()=>client.stop());
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: closed\ndata: {"status":429,"error":"请关闭重复页面"}\n\n'));controller.close();}})));
  client.connect();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(errors[0].status,429);assert.equal(client.retryTimer,null);assert.equal(client.stopped,false);assert.equal(connections.at(-1),'offline');
});
