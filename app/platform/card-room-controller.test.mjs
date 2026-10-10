import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardRoomController } from './card-room-controller.mjs';
import { parksCommand } from '../games/parks/game-ui-model.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let count=0;count<8;count++)await Promise.resolve();};
function room(extra={}) {return {roomCode:'123456',roomId:'room-a',selfId:'seat-a',selfRole:'player',gameType:'parks',phase:'playing',revision:1,
  matchId:'match-a',game:{matchId:'match-a',revision:1,window:{id:'window-a'},opportunities:[]},...extra};}
function fixture({policy,first=room(),initialState}={}) {
  let epoch=1,state=initialState ?? {verification:'verified',authenticated:true,mode:'unified',userKey:'account-a'},accountChanged,life;
  const document={hidden:false},listeners=new Map(),calls={views:[],conceals:[],feedback:[],failures:[],audio:[],chat:[],forgets:[],routes:[],api:[]},clients=[];
  const window={location:{replace:value=>calls.routes.push(value)},addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:name=>listeners.delete(name)};
  let apiResponse=()=>Promise.resolve({view:first});
  class Client {
    constructor(code,membership,callbacks) {this.membership=membership;this.callbacks=callbacks;this.accountEpoch=epoch;this.actions=[];this.requests=[];this.pending=null;this.storage=true;this.actionImpl=async()=>this.view;this.retryImpl=async()=>{};this.requestImpl=async()=>({items:[]});clients.push(this);}
    receive(value) {this.view=value;this.callbacks.onView(value);}
    connect() {this.connected=(this.connected ?? 0)+1;this.callbacks.onConnection('online');}
    stop() {this.stopped=(this.stopped ?? 0)+1;}
    pendingAction() {return this.pending;}
    actionStorageReady() {return this.storage;}
    epoch() {return this.accountEpoch;}
    async action(type,fields) {this.actions.push({type,fields});return this.actionImpl(type,fields);}
    async retryAction() {this.retries=(this.retries ?? 0)+1;return this.retryImpl();}
    async refresh() {this.refreshes=(this.refreshes ?? 0)+1;return this.refreshImpl?.();}
    async request(path,options,requestEpoch) {this.requests.push({path,options,requestEpoch});return this.requestImpl(path,options);}
  }
  const ui={applyView:(value,options)=>calls.views.push({value:structuredClone(value),options:{...options}}),conceal:value=>calls.conceals.push(value),feedback:value=>calls.feedback.push(value),leaveFailure:value=>calls.failures.push(value),destroy:()=>{calls.destroyed=true;},audio:{play:value=>calls.audio.push(value)}};
  const chat={clear:value=>calls.chat.push(['clear',value]),connection:value=>calls.chat.push(['connection',value]),receive:value=>calls.chat.push(['receive',value]),attach:(...values)=>calls.chat.push(['attach',...values])};
  const controller=createCardRoomController({policy:policy ?? {gameType:'parks',businessTypes:['finish-window'],command:parksCommand,cues:()=>['placement']},roomCode:'123456',document,window,ui,chat,RoomClient:Client,
    api:(...args)=>{calls.api.push(args);return apiResponse();},accountState:()=>state,accountGeneration:()=>epoch,onAccountChange:callback=>{accountChanged=callback;return()=>{accountChanged=null;};},loadAccount:async()=>state,
    watchAccountLifecycle:callbacks=>{life={...callbacks,refresh:async()=>{callbacks.onVerified(state);await flush();},stop:()=>{life.stopped=true;}};return life;},
    loginHref:value=>`login:${value}`,reauthenticationHref:()=>'/reauth',logoutAccount:async()=>{},forgetMembership:(...values)=>calls.forgets.push(values),roomHref:(code,type)=>`${type}:${code}`});
  return {controller,clients,calls,document,listeners,client:()=>clients.at(-1),life:()=>life,state:()=>state,
    setState(value,{changeEpoch=true}={}) {state=value;if(changeEpoch)epoch++;accountChanged?.(state);},setApi:callback=>{apiResponse=callback;},
    async start(){await controller.start();await flush();}};
}
test('boot binds the verified identity and routes another game before attaching its private data',async()=>{
  const f=fixture();await f.start();assert.equal(f.clients.length,1);assert.equal(f.client().membership.userKey,'account-a');assert.equal(f.calls.views.length,2);
  const wrong=fixture({first:room({gameType:'other-game'})});await wrong.start();assert.deepEqual(wrong.calls.routes,['other-game:123456']);assert.equal(wrong.clients.length,0);assert.equal(wrong.calls.chat.some(call=>call[0]==='attach'),false);
  const unverified=fixture({initialState:{verification:'verified',authenticated:false,mode:'unified'}});await unverified.start();assert.equal(unverified.clients.length,0);assert.match(unverified.calls.conceals.at(-1).message,/重新登录/);
});
test('an account change aborts an in-flight bootstrap and never attaches its late private response',async()=>{
  const f=fixture(),request=deferred();f.setApi(()=>request.promise);await f.controller.start();await flush();assert.equal(f.calls.api.length,1);
  const signal=f.calls.api[0][1].signal;f.setState({verification:'verified',authenticated:false,mode:'unified'});assert.equal(signal.aborted,true);
  request.resolve({view:room({privateSecret:'former-account'})});await flush();assert.equal(f.clients.length,0);assert.equal(f.calls.views.length,0);
});
test('business commands retain match/window fences, reject stale projections and do not write unknown actions',async()=>{
  const f=fixture();await f.start();await f.controller.act('finish-window',{matchId:'match-a',windowId:'window-a',opportunityId:null});
  assert.deepEqual(f.client().actions[0],{type:'finish-window',fields:{type:'finish-window',matchId:'match-a',windowId:'window-a',opportunityId:null}});
  await assert.rejects(f.controller.act('finish-window',{windowId:'retired'}),/过期/);await assert.rejects(f.controller.act('finish-window',{matchId:'retired'}),/过期/);
  await assert.rejects(f.controller.act('finish-window',{opportunityId:'already-used'}),/处理完毕/);await assert.rejects(f.controller.act('server-step'),/未知/);assert.equal(f.client().actions.length,1);
});
test('one slow action blocks duplicate business writes, then releases only its current page',async()=>{
  const f=fixture();await f.start();const client=f.client(),request=deferred();client.actionImpl=()=>request.promise;
  const action=f.controller.act('finish-window');assert.equal(f.calls.views.at(-1).options.pending,true);
  await assert.rejects(f.controller.act('finish-window'),/等待/);assert.equal(client.requests.length,0);assert.equal(client.actions.length,1);
  request.resolve(client.view);await action;assert.equal(f.calls.views.at(-1).options.pending,false);
  client.actionImpl=async()=>client.view;await f.controller.act('ready',{ready:true});assert.deepEqual(client.actions.at(-1),{type:'ready',fields:{ready:true}});
});
test('an unknown outcome keeps the pending original intent; only explicit retry or refresh can resolve it',async()=>{
  const f=fixture();await f.start();const client=f.client(),original={requestId:'same-request',expectedRevision:1,type:'finish-window'};
  client.actionImpl=async()=>{client.pending=original;throw new Error('unknown transport result');};await assert.rejects(f.controller.act('finish-window'),/unknown/);
  await assert.rejects(f.controller.act('ready',{ready:true}),/尚未确认/);assert.equal(client.actions.length,1);
  client.retryImpl=async()=>{assert.equal(client.pending,original);client.pending=null;};await f.controller.retry();assert.equal(client.retries,1);assert.equal(f.calls.views.at(-1).options.pending,false);
  await f.controller.refresh();assert.equal(client.refreshes,1);
});
test('lost local intent storage permits reading but no new business writes',async()=>{
  const f=fixture();await f.start();f.client().storage=false;f.client().receive(room());assert.equal(f.calls.views.at(-1).options.canAct,false);
  await assert.rejects(f.controller.act('finish-window'),/保存操作记录/);assert.equal(f.client().actions.length,0);await f.controller.refresh();assert.equal(f.client().refreshes,1);
});
test('conceal and a successor identity fence late private action replies and retired finally blocks',async()=>{
  const f=fixture();await f.start();const old=f.client(),request=deferred();old.actionImpl=()=>request.promise;const action=f.controller.act('finish-window');
  f.setState({verification:'verified',authenticated:false,mode:'unified'});assert.ok(old.stopped);const concealed=f.calls.views.length;
  old.callbacks.onView(room({revision:2}));old.callbacks.onChat({text:'retired secret'});assert.equal(f.calls.views.length,concealed);
  f.setState({verification:'verified',authenticated:true,mode:'unified',userKey:'account-b'});f.setApi(async()=>({view:room({roomId:'room-b',selfId:'seat-b'})}));await f.controller.recover();await flush();
  const next=f.client();assert.notEqual(next,old);const nextRequest=deferred();next.actionImpl=()=>nextRequest.promise;const nextAction=f.controller.act('finish-window');
  request.resolve({privateSecret:'old-account'});await assert.rejects(action,error=>error.name==='AbortError');assert.equal(f.calls.views.at(-1).options.pending,true);
  nextRequest.resolve(next.view);await nextAction;assert.equal(f.calls.views.at(-1).options.pending,false);
});
test('hidden, failed verification and disconnected pages cannot dispatch new commands',async()=>{
  const f=fixture();await f.start();const original=f.client();f.document.hidden=true;await assert.rejects(f.controller.act('finish-window'),/等待/);f.document.hidden=false;
  f.client().callbacks.onConnection('offline');await assert.rejects(f.controller.act('finish-window'),/等待/);f.client().callbacks.onConnection('online');
  f.setState({verification:'unavailable',authenticated:true,mode:'unified',userKey:'account-a'},{changeEpoch:false});await assert.rejects(f.controller.act('finish-window'),/等待/);assert.equal(original.actions.length,0);assert.ok(original.stopped);
});
test('connection loss disables projected action permission and reconnect restores only a writable current page',async()=>{
  const f=fixture();await f.start();const client=f.client();assert.equal(f.calls.views.at(-1).options.canAct,true);
  client.callbacks.onConnection('offline');assert.equal(f.calls.views.at(-1).options.canAct,false);
  client.callbacks.onConnection('online');assert.equal(f.calls.views.at(-1).options.canAct,true);
  client.storage=false;client.callbacks.onConnection('offline');client.callbacks.onConnection('online');assert.equal(f.calls.views.at(-1).options.canAct,false);
  f.controller.destroy();const views=f.calls.views.length;client.callbacks.onConnection('online');assert.equal(f.calls.views.length,views);
});
test('explicit leave is independently acknowledged while a game reply is in flight and retires its late result',async()=>{
  const f=fixture();await f.start();const client=f.client(),game=deferred(),leaving=deferred();client.actionImpl=()=>game.promise;client.requestImpl=()=>leaving.promise;
  const action=f.controller.act('finish-window'),left=f.controller.leave();assert.equal(client.actions.length,1);assert.equal(client.requests.length,1);
  assert.equal(client.requests[0].options.body.type,'leave');await assert.rejects(f.controller.act('ready',{ready:true}),/等待/);assert.equal(await f.controller.leave(),false);assert.equal(client.requests.length,1);
  leaving.resolve({left:true});assert.equal(await left,true);const views=f.calls.views.length;
  game.resolve({privateSecret:'retired game reply'});await assert.rejects(action,error=>error.name==='AbortError');assert.equal(f.calls.views.length,views);assert.deepEqual(f.calls.routes,['./']);
});
test('unknown business intent cannot trap explicit departure or keep-seat return, and neither path replays it',async()=>{
  for(const keepSeat of [false,true]) {
    const f=fixture();await f.start();const client=f.client(),original={requestId:'unknown-game-request',expectedRevision:1,type:'finish-window'};
    client.pending=original;client.requestImpl=async()=>({left:true});client.callbacks.onConnection('offline');assert.equal(await f.controller.leave({keepSeat}),true);
    assert.equal(client.pending,original);assert.equal(client.actions.length,0);assert.equal(client.requests.length,keepSeat?0:1);assert.deepEqual(f.calls.routes,['./']);
    assert.equal(f.calls.forgets.length,keepSeat?0:1);assert.equal(keepSeat?f.calls.destroyed:Boolean(client.stopped),true);
  }
});
test('history replies are bounded and cannot reveal a prior match, concealed page or superseded request',async()=>{
  const f=fixture();await f.start();const client=f.client(),a=deferred(),b=deferred();let index=0;client.requestImpl=()=>++index===1?a.promise:b.promise;
  const first=f.controller.history({limit:999}),second=f.controller.history({limit:-10});assert.equal(client.requests[0].path,'/api/history?limit=30');assert.equal(client.requests[1].path,'/api/history?limit=1');
  a.resolve({items:['older']});assert.equal(await first,null);b.resolve({items:['latest']});assert.deepEqual(await second,{items:['latest']});
  const c=deferred();client.requestImpl=()=>c.promise;const third=f.controller.history();client.receive(room({matchId:'new-match',game:{matchId:'new-match',window:{id:'new-window'}}}));c.resolve({items:['old-match']});assert.equal(await third,null);
  const d=deferred();client.requestImpl=()=>d.promise;const fourth=f.controller.history();f.life().onSuspend();d.resolve({items:['private']});assert.equal(await fourth,null);
});
test('a retired history authentication failure cannot conceal a recovered successor account',async()=>{
  const f=fixture();await f.start();const old=f.client(),request=deferred();old.requestImpl=()=>request.promise;const history=f.controller.history();
  f.setState({verification:'verified',authenticated:false,mode:'unified'});f.setState({verification:'verified',authenticated:true,mode:'unified',userKey:'account-b'});
  f.setApi(async()=>({view:room({roomId:'room-b',selfId:'seat-b'})}));await f.controller.recover();await flush();const count=f.calls.conceals.length;
  request.reject(Object.assign(new Error('retired login'),{status:401}));assert.equal(await history,null);assert.equal(f.calls.conceals.length,count);assert.equal(f.calls.views.at(-1).value.roomId,'room-b');
});
test('unexpected room/seat scope drift conceals without displaying or reusing its private view',async()=>{
  const f=fixture();await f.start();const client=f.client(),count=f.calls.views.length;client.receive(room({roomId:'replacement-room',privateSecret:'other-room'}));
  assert.equal(f.calls.views.length,count);assert.ok(client.stopped);assert.match(f.calls.conceals.at(-1).message,/已关闭/);await assert.rejects(f.controller.act('finish-window'),/等待/);
});
test('reconnect baselines are silent and cues only follow accepted current-view changes',async()=>{
  const f=fixture();await f.start();const client=f.client();assert.deepEqual(f.calls.audio,[]);client.receive(room({revision:2}));assert.deepEqual(f.calls.audio,['placement']);
  client.callbacks.onConnection('offline');client.receive(room({revision:3}));assert.deepEqual(f.calls.audio,['placement']);client.callbacks.onConnection('online');client.receive(room({revision:4}));assert.deepEqual(f.calls.audio,['placement','placement']);
});
test('explicit leave requires an acknowledged result and preserves the exact unknown request for retry',async()=>{
  const f=fixture();await f.start();const client=f.client();let count=0;client.requestImpl=async()=>{if(++count===1)throw new Error('unknown leave');return {left:true};};
  assert.equal(await f.controller.leave(),false);assert.equal(f.calls.forgets.length,0);assert.equal(await f.controller.leave(),true);
  assert.deepEqual(client.requests[0].options.body,client.requests[1].options.body);assert.equal(client.requests[0].options.body.type,'leave');assert.deepEqual(f.calls.forgets,[['123456','seat-a']]);assert.deepEqual(f.calls.routes,['./']);
});
test('destroy retires callbacks, late results, lifecycle watchers and pagehide subscription',async()=>{
  const f=fixture();await f.start();const client=f.client(),request=deferred();client.actionImpl=()=>request.promise;const action=f.controller.act('finish-window');f.controller.destroy();
  const count=f.calls.views.length;client.callbacks.onView(room({revision:8}));client.callbacks.onConnection('online');request.resolve({privateSecret:'destroyed'});await assert.rejects(action,error=>error.name==='AbortError');
  assert.equal(f.calls.views.length,count);assert.ok(f.calls.destroyed);assert.equal(f.life().stopped,true);assert.equal(f.listeners.size,0);await f.controller.recover();assert.equal(f.clients.length,1);
});
test('a third minimal policy reuses page lifecycle with different command fields and cue semantics',async()=>{
  const f=fixture({first:room({gameType:'minimal-policy',game:{counter:4}}),policy:{gameType:'minimal-policy',businessTypes:['increment'],
    command:(game,type,fields)=>{if(fields.counter!==game.counter)throw new Error('counter retired');return {delta:1,counter:game.counter};},cues:(_a,b)=>b.counter===5?['custom-counter']:[]}});
  await f.start();await f.controller.act('increment',{counter:4});assert.deepEqual(f.client().actions[0],{type:'increment',fields:{delta:1,counter:4}});
  await assert.rejects(f.controller.act('increment',{counter:3}),/retired/);f.client().receive(room({gameType:'minimal-policy',revision:2,game:{counter:5}}));assert.deepEqual(f.calls.audio,['custom-counter']);f.controller.destroy();
});
