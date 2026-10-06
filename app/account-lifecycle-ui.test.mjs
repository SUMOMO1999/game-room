import * as entryPath from './entry-path.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as rules from './rules.mjs';
import * as presentation from './game-presentation.mjs';
import * as lobbyModel from './lobby-model.mjs';
import * as gameRouting from './game-routing.mjs';
import * as rummiFeedback from './rummikub-feedback.mjs';
import * as rummiAssist from './rummikub-assist.mjs';
import * as rackLayout from './rack-layout.mjs';
import * as tableLayout from './table-layout.mjs';
import * as viewport from './game-viewport.mjs';
import { createGameAudio } from './game-audio.mjs';

const USER='a'.repeat(64),OTHER='b'.repeat(64),CODE='123456';
const AUTH={mode:'mock',loginReady:true,authenticated:true,userKey:USER,csrf:'synthetic-csrf',
  reauthReady:true,reauthHref:'https://agora.sumomoli.com/#account',profile:{nickname:'原朋友'},
  recentRooms:[{roomCode:CODE,playerId:'self',name:'原朋友',phase:'playing',expiresAt:Date.now()+100000}]};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const settle=async()=>{for(let index=0;index<12;index++) await new Promise(resolve=>setImmediate(resolve));};
function clock() {
  let now=0,serial=0;const pending=new Map();
  return {setTimeout(callback,delay){const id=++serial;pending.set(id,{at:now+delay,callback});return id;},
    clearTimeout(id){pending.delete(id);},tick(ms){now+=ms;
      for(const [id,item] of [...pending].sort((a,b)=>a[1].at-b[1].at)) if(item.at<=now && pending.has(id)) {pending.delete(id);item.callback();}},
    pending};
}
function storage() {
  const values=new Map();return {get length(){return values.size;},key:index=>[...values.keys()][index],
    getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),values};
}

// A deliberately small DOM runs the actual account, room client and page modules.
// Geometry/animation frames are not simulated; these tests cover private rendering and fetch lifetimes.
function dom(html) {
  const nodes=new Map();let document;
  class Node extends EventTarget {
    constructor(tag='div'){super();this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes={};this.dataset={};this.hidden=false;this.disabled=false;this.value='';this.open=false;this._text='';this._class='';this.style={setProperty(){}};
      this.classList={contains:name=>this._class.split(/\s+/).includes(name),toggle:(name,force)=>{
        const set=new Set(this._class.split(/\s+/).filter(Boolean)),enabled=force??!set.has(name);enabled?set.add(name):set.delete(name);this._class=[...set].join(' ');return enabled;
      },add:(...names)=>names.forEach(name=>this.classList.toggle(name,true)),remove:(...names)=>names.forEach(name=>this.classList.toggle(name,false))};}
    set id(value){this.attributes.id=value;nodes.set(value,this);}get id(){return this.attributes.id;}
    set className(value){this._class=value;}get className(){return this._class;}
    set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
    set innerHTML(value){this._text='';this.children=[];parse(value,this);}get innerHTML(){return this.textContent;}
    setAttribute(name,value){value=String(value);this.attributes[name]=value;if(name==='id')this.id=value;if(name==='class')this.className=value;if(name==='hidden')this.hidden=true;
      if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;}
    getAttribute(name){return this.attributes[name]??null;}removeAttribute(name){delete this.attributes[name];if(name==='hidden')this.hidden=false;}
    append(...values){for(const value of values){const node=typeof value==='string'?Object.assign(new Node('span'),{textContent:value}):value;node.parentNode=this;this.children.push(node);}}
    appendChild(node){this.append(node);return node;}replaceChildren(...values){this._text='';this.children=[];this.append(...values);}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);}
    matches(selector){if(selector.startsWith('#'))return this.id===selector.slice(1);
      const classes=[...selector.matchAll(/\.([\w-]+)/g)].map(match=>match[1]);if(classes.some(name=>!this.classList.contains(name)))return false;
      const tag=selector.match(/^[\w-]+/)?.[0];if(tag && this.tagName!==tag.toUpperCase())return false;
      for(const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g))if(!Object.hasOwn(this.attributes,match[1]) || match[2]!==undefined && this.attributes[match[1]]!==match[2])return false;
      return Boolean(tag || classes.length || selector.includes('['));}
    querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
    querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
    closest(selector){return this.matches(selector)?this:this.parentNode?.closest(selector)??null;}
    showModal(){this.open=true;}close(){this.open=false;}focus(){}blur(){}
    get clientWidth(){return 560;}get clientHeight(){return 140;}
    getBoundingClientRect(){return {left:0,top:0,right:560,bottom:140,width:560,height:140};}
  }
  function parse(source,parent) {
    const stack=[parent],voids=new Set(['META','LINK','INPUT','IMG','BR','HR']);
    for(const token of String(source).match(/<[^>]*>|[^<]+/g)??[]) {
      if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
      if(token.startsWith('<!'))continue;
      if(token.startsWith('<')){const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;const node=new Node(tag);
        for(const match of token.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))if(match[1]!==tag)node.setAttribute(match[1],match[2]??match[3]??match[4]??'');
        stack.at(-1).append(node);if(!voids.has(node.tagName) && !token.endsWith('/>'))stack.push(node);
      }else stack.at(-1)._text+=token;
    }
  }
  document=new EventTarget();document.hidden=false;document.documentElement=new Node('html');parse(html,document.documentElement);
  document.body=document.documentElement.querySelector('body');document.getElementById=id=>nodes.get(id)??null;
  document.createElement=tag=>new Node(tag);document.querySelector=selector=>document.documentElement.querySelector(selector);
  document.querySelectorAll=selector=>document.documentElement.querySelectorAll(selector);
  return document;
}
async function moduleIn(context,file,extra='') {
  Object.assign(context, entryPath);
  const source=await readFile(new URL(file,import.meta.url),'utf8');
  const names=[...source.matchAll(/^export (?:async )?(?:function|class|const)\s+(\w+)/gm)].map(match=>match[1]);
  const code=source.replace(/^import[\s\S]*?;\s*/gm,'').replace(/^export /gm,'');
  return vm.runInContext(`(()=>{${code}\n${extra}\nreturn {${names.join(',')}};})()`,context,{filename:file});
}
function roomView(user=USER) {
  const practice=rules.createPracticeState(),self=user===USER?'self':'other';
  return {roomCode:CODE,roomId:'synthetic-room',selfId:self,hostId:self,revision:1,matchId:'synthetic-match',phase:'playing',pause:null,
    players:[{id:self,name:user===USER?'原朋友':'新朋友',connected:true,ready:true},{id:'friend',name:'伙伴',connected:true,ready:true}],
    game:{rack:practice.rack,board:practice.board,opened:true,round:2,revision:1,status:'playing',turnPlayerId:self,ruleVersion:'friends-v2',copies:2,jokerCount:2,poolCount:69,
      players:[{id:self,rackCount:14},{id:'friend',rackCount:14}]}};
}
async function fixture(t,{page='room',query='',state=AUTH,history}={}) {
  const document=dom(await readFile(new URL(page==='room'?'room.html':'index.html',import.meta.url),'utf8'));
  if(page==='lobby') document.getElementById('create-game').value='rummikub';
  const window=new EventTarget(),timers=clock(),sessionStorage=storage(),localStorage=storage();
  const location={hostname:'127.0.0.1',search:page==='room'?`?code=${CODE}${query}`:query,href:`http://127.0.0.1/${page==='room'?`room.html?code=${CODE}`:''}${query}`,
    replace(url){this.replaced=url;},assign(url){this.assigned=url;}};
  const calls=[],streams=[],watchers=[];let nextState=state,stateResponse=null,roomResponse=null,entryResponse=null;
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(options.method==='POST' && (url==='/api/rooms' || /\/api\/rooms\/\d{6}\/join$/.test(url)) && entryResponse) return entryResponse().then(response=>response.clone());
    if(url==='/api/state')return stateResponse?stateResponse().then(response=>response.clone()):json(nextState);
    if(url.startsWith('/api/history'))return history?history().then(response=>response.clone()):json({items:[],stats:{},retentionDays:180});
    if(/\/events(?:\?preview=1)?$/.test(url)) {
      let controller;const body=new ReadableStream({start(value){controller=value;}});
      const record={signal:options.signal,controller};streams.push(record);
      options.signal?.addEventListener('abort',()=>{try{controller.close();}catch{}});
      return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
    }
    if(url.includes('/chat'))return json({roomId:'synthetic-room',messages:[],hasOlder:false});
    if(url===`/api/rooms/${CODE}`)return roomResponse?roomResponse.promise.then(response=>response.clone()):json({view:roomView(nextState.userKey)});
    if(url==='/auth/logout')return json({ok:true});
    throw new Error(`Unexpected synthetic request: ${url}`);
  };
  Object.assign(window,{innerWidth:844,innerHeight:390,visualViewport:null,setInterval:()=>0,clearInterval(){}});
  const context=vm.createContext({document,window,location,navigator:{},sessionStorage,localStorage,fetch,URL,URLSearchParams,Response,ReadableStream,TextDecoder,
    AbortController,DOMException,Event,EventTarget,structuredClone,performance,crypto,innerWidth:844,innerHeight:390,
    setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,queueMicrotask,requestAnimationFrame:()=>0,cancelAnimationFrame(){},
    getComputedStyle:()=>({paddingLeft:'8',paddingRight:'8',paddingTop:'8',paddingBottom:'8'}),
    ...rules,...presentation,...lobbyModel,...gameRouting,...rummiFeedback,...rummiAssist,...rackLayout,...tableLayout,...viewport,createGameAudio});
  const account=await moduleIn(context,'account-client.mjs');Object.assign(context,account);
  context.watchAccountLifecycle=(options)=>{const watcher=account.watchAccountLifecycle(options);watchers.push(watcher);return watcher;};
  Object.assign(context,await moduleIn(context,'room-client.mjs'));
  Object.assign(context,await moduleIn(context,'room-chat.mjs'));
  Object.assign(context,await moduleIn(context,'rummikub-preview-client.mjs'));
  let pageAPI;
  if(page==='room') {
    context.expose=(value)=>{pageAPI=value;};
    await moduleIn(context,'app.mjs','expose({draft:()=>structuredClone(draft),client:()=>roomClient,move:(id)=>moveTiles([id],"new"),rackOrder:()=>[...rackOrder]});');
  }else await moduleIn(context,'lobby.mjs');
  t.after(()=>watchers.forEach(watcher=>watcher.stop()));await settle();
  return {account,document,window,timers,sessionStorage,calls,streams,pageAPI,location,
    setState(value){nextState=value;stateResponse=null;},deferState(value){stateResponse=()=>value.promise;},
    deferRoom(value){roomResponse=value;},
    deferEntry(value){entryResponse=()=>value.promise;},
    get(id){return document.getElementById(id);}};
}

test('periodic checks keep the same private draft, account epoch and SSE connection',async t=>{
  const f=await fixture(t),epoch=f.account.accountGeneration(),client=f.pageAPI.client();
  const id=f.pageAPI.draft().rack[0].id;f.pageAPI.move(id);const draft=f.pageAPI.draft();
  assert.equal(f.streams.length,1);assert.ok(f.get('rack').children.length);
  for(let index=0;index<3;index++){f.timers.tick(15000);await settle();assert.deepEqual(f.pageAPI.draft(),draft);assert.equal(f.pageAPI.client(),client);}
  assert.equal(f.account.accountGeneration(),epoch);assert.equal(f.streams.length,1);
  assert.equal(f.calls.filter(call=>call.url==='/api/state').length,4);
});

test('actual invited Rummikub page reports an account conflict once while keeping current identity, seat and revision',async t=>{
  const f=await fixture(t,{query:'&login=account'}),before=f.pageAPI.client().view;
  assert.equal(f.account.accountState().userKey,USER);assert.equal(before.selfId,'self');assert.equal(before.revision,1);
  assert.equal(f.get('toast').hidden,false);assert.match(f.get('toast').textContent,/当前棋牌账号与原席位保持/);
  f.timers.tick(5000);await settle();assert.equal(f.get('toast').hidden,true);f.get('toast').textContent='already notified';
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();
  assert.equal(f.get('toast').textContent,'already notified');assert.equal(f.get('toast').hidden,true);
  const after=f.pageAPI.client().view;assert.equal(after.selfId,before.selfId);assert.equal(after.revision,before.revision);
  assert.equal(f.account.accountState().userKey,USER);assert.ok(!f.location.replaced);
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,0);
});

test('transport EOF keeps the actual desktop game and draft, then reconnects after two seconds without changing identity',async t=>{
  const f=await fixture(t),epoch=f.account.accountGeneration(),client=f.pageAPI.client();
  f.pageAPI.move(f.pageAPI.draft().rack[0].id);const draft=f.pageAPI.draft();
  assert.equal(f.document.hidden,false);assert.equal(f.get('room-play').hidden,false);
  const reads=f.calls.filter(call=>call.url==='/api/state').length;
  f.streams[0].controller.close();await settle();
  assert.equal(f.account.accountGeneration(),epoch);assert.equal(f.pageAPI.client(),client);
  assert.equal(f.get('room-play').hidden,false);assert.ok(f.get('rack').children.length);assert.ok(f.get('board').children.length);
  assert.match(f.get('connection-label').textContent,/重连中/);assert.deepEqual(f.pageAPI.draft(),draft);
  f.timers.tick(1999);await settle();assert.equal(f.streams.length,1);
  f.timers.tick(1);await settle();assert.equal(f.streams.length,2);
  assert.equal(f.account.accountGeneration(),epoch);assert.equal(f.pageAPI.client(),client);
  assert.equal(f.get('room-play').hidden,false);assert.deepEqual(f.pageAPI.draft(),draft);
  assert.match(f.get('connection-label').textContent,/已连接/);
  assert.equal(f.calls.filter(call=>call.url==='/api/state').length,reads);
  assert.ok(!f.calls.some(call=>call.url.endsWith('/actions')&&(call.options.method??'GET')!=='GET'));
});

test('background immediately removes private DOM and flow; return waits for fresh state before restoring same-match draft',async t=>{
  const f=await fixture(t);f.pageAPI.move(f.pageAPI.draft().rack[0].id);const draft=f.pageAPI.draft();
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.get('rack').children.length,0);assert.equal(f.get('board').children.length,0);assert.equal(f.get('room-play').hidden,true);
  assert.equal(f.streams[0].signal.aborted,true);assert.equal(f.sessionStorage.getItem('game-room.private-draft-owner.v1'),USER);
  const reads=f.calls.length;f.timers.tick(90000);await settle();assert.equal(f.calls.length,reads);
  const pending=deferred();f.deferState(pending);f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await settle();
  assert.equal(f.get('rack').children.length,0);assert.equal(f.streams.length,1);
  pending.resolve(json(AUTH));await settle();assert.deepEqual(f.pageAPI.draft(),draft);assert.equal(f.streams.length,2);
  assert.equal(f.sessionStorage.getItem('game-room.private-draft-owner.v1'),null);
});

test('503 closes private DOM and stream, preserves local draft, and only a fresh same-identity check restores it',async t=>{
  const f=await fixture(t);f.pageAPI.move(f.pageAPI.draft().rack[0].id);const draft=f.pageAPI.draft();
  f.deferState({promise:Promise.resolve(json({message:'synthetic unavailable'},503))});f.timers.tick(15000);await settle();
  assert.equal(f.get('rack').children.length,0);assert.equal(f.pageAPI.client(),null);assert.equal(f.streams[0].signal.aborted,true);
  assert.equal(f.account.accountState().failureStatus,503);assert.ok([...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
  f.setState(AUTH);f.timers.tick(15000);await settle();assert.deepEqual(f.pageAPI.draft(),draft);assert.equal(f.streams.length,2);
});

test('401 discards private view but never automatically logs in, leaves a room, logs out again or replays a write',async t=>{
  const f=await fixture(t);f.pageAPI.move(f.pageAPI.draft().rack[0].id);
  f.deferState({promise:Promise.resolve(json({message:'synthetic revoked'},401))});f.timers.tick(15000);await settle();
  assert.equal(f.get('rack').children.length,0);assert.equal(f.get('room-account-recover').hidden,false);
  assert.equal(f.get('room-account-reauth').href,'https://agora.sumomoli.com/#account');
  assert.match(f.get('room-account-recover').href,/returnTo=%2Froom\.html%3Fcode%3D123456/);
  assert.ok(![...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
  assert.equal(f.location.replaced,undefined);assert.ok(f.calls.every(call=>(call.options.method??'GET')==='GET'));
  f.setState({...AUTH,authenticated:false});f.timers.tick(15000);await settle();
  assert.equal(f.location.replaced,undefined);assert.equal(f.get('room-account-reauth').hidden,false);
});

test('a different freshly verified account cannot display the old cards or restore its old draft',async t=>{
  const f=await fixture(t);f.pageAPI.move(f.pageAPI.draft().rack[0].id);const old=f.pageAPI.client();
  f.setState({...AUTH,userKey:OTHER,csrf:'other-csrf',profile:{nickname:'新朋友'}});f.timers.tick(15000);await settle();
  assert.equal(old.stopped,true);assert.equal(f.account.accountState().userKey,OTHER);
  assert.equal(f.pageAPI.draft().board.length,roomView(OTHER).game.board.length);
  assert.equal(f.get('room-players').textContent.includes('原朋友'),false);
  assert.ok(![...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
});

test('a hung state response has a ten-second limit and cannot revive the private UI after timeout',async t=>{
  const f=await fixture(t),pending=deferred();f.deferState(pending);f.timers.tick(15000);await settle();
  assert.ok(f.get('rack').children.length);f.timers.tick(10000);await settle();assert.equal(f.get('rack').children.length,0);
  assert.equal(f.account.accountState().failureStatus,503);pending.resolve(json(AUTH));await settle();
  assert.equal(f.get('rack').children.length,0);assert.equal(f.account.accountState().authenticated,false);
});

test('restoring a lobby hides profiles, rooms and a delayed history response until the new identity is verified',async t=>{
  const oldHistory=deferred();const f=await fixture(t,{page:'lobby',history:()=>oldHistory.promise});
  assert.equal(f.get('create-name').value,'原朋友');assert.ok(f.get('recent-list').children.length);
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.get('create-name').value,'');assert.equal(f.get('recent-list').children.length,0);assert.equal(f.get('history-section').hidden,true);
  oldHistory.resolve(json({items:[{matchId:'old-match',roomCode:CODE,endedAt:Date.now(),status:'finished',self:{outcome:'win'},players:[]}],stats:{wins:1}}));await settle();
  assert.equal(f.get('history-list').children.length,0);
  const pending=deferred();f.deferState(pending);f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();
  assert.equal(f.get('recent-list').children.length,0);assert.equal(f.get('lobby-forms').hidden,true);
  pending.resolve(json({...AUTH,userKey:OTHER,csrf:'other-csrf',profile:{nickname:'新朋友'},recentRooms:[]}));await settle();
  assert.equal(f.get('create-name').value,'新朋友',JSON.stringify({state:f.account.accountState(),heading:f.get('account-heading').textContent,description:f.get('account-description').textContent}));assert.equal(f.get('recent-list').children.length,0);
});

test('callback verification failure preserves the invitation and shows explicit central recovery with no automatic redirect',async t=>{
  const f=await fixture(t,{query:'&login=verify',state:{...AUTH,authenticated:false}});
  assert.equal(f.get('room-account-reauth').hidden,false);assert.match(f.get('room-account-recover').href,/%3Fcode%3D123456$/);
  assert.equal(f.location.replaced,undefined);assert.match(f.get('waiting-hint').textContent,/重新登录|核验|重新验证/);
});

test('only the explicitly configured central account destination can become a reauthentication link',async t=>{
  for(const href of ['https://evil.example/','https://agora.sumomoli.com/auth/reauth','https://agora.sumomoli.com/?token=secret','https://user:password@agora.sumomoli.com/#account']) {
    const f=await fixture(t,{state:{...AUTH,authenticated:false,reauthHref:href}});
    assert.equal(f.account.reauthenticationHref(),null);assert.equal(f.get('room-account-reauth').hidden,true);
  }
});

test('a state check already pending before background cannot unhide the old identity on focus/pageshow',async t=>{
  const f=await fixture(t),old=deferred();f.deferState(old);f.timers.tick(15000);await settle();
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));assert.equal(f.get('rack').children.length,0);
  f.setState({...AUTH,userKey:OTHER,csrf:'other-csrf',profile:{nickname:'新朋友'}});
  f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));f.window.dispatchEvent(new Event('pageshow'));await settle();
  assert.equal(f.get('rack').children.length,0);old.resolve(json(AUTH));await settle();
  assert.equal(f.account.accountState().userKey,OTHER);assert.equal(f.get('room-players').textContent.includes('原朋友'),false);
  assert.equal(f.streams.length,2);
});

test('a delayed private room read ignores its abort signal but still cannot repaint after background',async t=>{
  const f=await fixture(t),pending=deferred();f.deferRoom(pending);const client=f.pageAPI.client();
  const reading=client.refresh();await settle();f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.get('rack').children.length,0);pending.resolve(json({view:{...roomView(),revision:99}}));
  await assert.rejects(reading,error=>error.name==='AbortError');assert.equal(f.get('rack').children.length,0);assert.equal(client.stopped,true);
});

test('the lobby preserves invitation login destination and exposes explicit central recovery without a login loop',async t=>{
  const f=await fixture(t,{page:'lobby',query:'?room=123456&login=verify',state:{...AUTH,authenticated:false}});
  assert.equal(f.get('account-login').hidden,false);assert.equal(f.get('account-reauth').hidden,false);
  assert.equal(f.get('account-reauth').href,'https://agora.sumomoli.com/#account');
  assert.equal(f.get('account-login').href,'/auth/login?returnTo=%2F%3Froom%3D123456');
  assert.equal(f.get('lobby-forms').hidden,true);assert.equal(f.location.replaced,undefined);
});

test('stable lobby soft checks do not reload history; returning and explicit refresh each read it only once',async t=>{
  const f=await fixture(t,{page:'lobby'}),historyReads=()=>f.calls.filter(call=>call.url.startsWith('/api/history')).length;
  assert.equal(historyReads(),1);
  for(let index=0;index<3;index++){f.timers.tick(15000);await settle();}
  assert.equal(historyReads(),1);assert.equal(f.calls.filter(call=>call.url==='/api/state').length,4);
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();
  assert.equal(historyReads(),2);f.get('history-refresh').dispatchEvent(new Event('click'));await settle();assert.equal(historyReads(),3);
});

test('create and join buttons recover after a 503 without replaying the write or replacing its request id',async t=>{
  for(const join of [false,true]) {
    const f=await fixture(t,{page:'lobby'}),form=f.get(join?'join-form':'create-form'),button=form.querySelector('button[type=submit]');
    if(join) {f.get('join-code').value=CODE;f.get('join-role').value='player';}
    f.deferEntry({promise:Promise.resolve(json({error:'synthetic unavailable'},503))});
    form.dispatchEvent(new Event('submit'));await settle();
    const requestId=form.requestId,fingerprint=form.requestFingerprint;
    assert.ok(requestId);assert.equal(f.account.accountState().failureStatus,503);assert.equal(button.disabled,false);
    f.setState(AUTH);f.timers.tick(15000);await settle();
    assert.equal(f.account.accountState().authenticated,true);assert.equal(f.get('lobby-forms').hidden,false);assert.equal(button.disabled,false);
    assert.equal(form.requestId,requestId);assert.equal(form.requestFingerprint,fingerprint);
    assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
  }
});

test('background cancels old lobby submission and its late 401 cannot clear or unlock a newer submission',async t=>{
  const f=await fixture(t,{page:'lobby'}),form=f.get('create-form'),button=form.querySelector('button[type=submit]'),old=deferred(),current=deferred();
  f.deferEntry(old);form.dispatchEvent(new Event('submit'));await settle();
  const originalId=form.requestId,oldRequest=f.calls.find(call=>call.options.method==='POST');
  assert.equal(button.disabled,true);
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(oldRequest.options.signal.aborted,true);assert.equal(button.disabled,false);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await settle();
  assert.equal(f.account.accountState().authenticated,true);assert.equal(button.disabled,false);
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1,'fresh restoration performs only reads');
  f.deferEntry(current);form.dispatchEvent(new Event('submit'));await settle();
  assert.equal(button.disabled,true);assert.equal(form.requestId,originalId);
  old.resolve(json({error:'synthetic retired 401'},401));await settle();
  assert.equal(f.account.accountState().authenticated,true);assert.equal(f.account.accountState().failureStatus,null);
  assert.equal(button.disabled,true,'retired finally must not unlock a newer submission');assert.equal(form.requestId,originalId);
  current.resolve(json({error:'synthetic explicit limit'},429));await settle();
  assert.equal(button.disabled,false);assert.equal(form.requestId,originalId);
  assert.deepEqual(f.calls.filter(call=>call.options.method==='POST').map(call=>JSON.parse(call.options.body).requestId),[originalId,originalId]);
});

test('a retired lobby history failure cannot replace fresh state or hide the restored page',async t=>{
  const old=deferred();let reads=0;
  const f=await fixture(t,{page:'lobby',history:()=>++reads===1?old.promise:Promise.resolve(json({items:[],stats:{},retentionDays:180}))});
  const retired=f.calls.find(call=>call.url.startsWith('/api/history'));
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(retired.options.signal.aborted,true);
  f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();
  assert.equal(f.account.accountState().authenticated,true);assert.equal(f.get('lobby-forms').hidden,false);
  old.resolve(json({error:'synthetic old unavailable'},503));await settle();
  assert.equal(f.account.accountState().authenticated,true);assert.equal(f.account.accountState().failureStatus,null);
  assert.equal(f.get('lobby-forms').hidden,false);assert.equal(reads,2);
});

test('a confirmed room entry stays busy until navigation leaves and cannot submit a second request',async t=>{
  for(const join of [false,true]) {
    const f=await fixture(t,{page:'lobby'}),form=f.get(join?'join-form':'create-form'),button=form.querySelector('button[type=submit]');
    if(join) {f.get('join-code').value=CODE;f.get('join-role').value='player';}
    f.deferEntry({promise:Promise.resolve(json({roomCode:CODE,view:roomView()},201))});
    form.dispatchEvent(new Event('submit'));await settle();
    assert.equal(f.location.href,`./room.html?code=${CODE}`);assert.equal(button.disabled,true);
    form.dispatchEvent(new Event('submit'));await settle();
    assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
    const returned=new Event('pageshow');Object.defineProperty(returned,'persisted',{value:true});
    f.window.dispatchEvent(returned);await settle();
    assert.equal(button.disabled,false,'returning via bfcache releases the retired navigation');
  }
});

test('a synchronous navigation failure releases the entry button and preserves the confirmed request id for retry',async t=>{
  const f=await fixture(t,{page:'lobby'}),form=f.get('create-form'),button=form.querySelector('button[type=submit]');
  f.deferEntry({promise:Promise.resolve(json({roomCode:CODE,view:roomView()},201))});
  Object.defineProperty(f.location,'href',{configurable:true,get:()=>'',set(){throw new Error('synthetic navigation unavailable');}});
  form.dispatchEvent(new Event('submit'));await settle();
  const requestId=form.requestId;assert.ok(requestId);assert.equal(button.disabled,false);
  assert.match(f.get('lobby-notice').textContent,/synthetic navigation unavailable/);
  Object.defineProperty(f.location,'href',{configurable:true,writable:true,value:''});
  form.dispatchEvent(new Event('submit'));await settle();
  const writes=f.calls.filter(call=>call.options.method==='POST');
  assert.equal(writes.length,2);assert.deepEqual(writes.map(call=>JSON.parse(call.options.body).requestId),[requestId,requestId]);
  assert.equal(f.location.href,`./room.html?code=${CODE}`);assert.equal(button.disabled,true);
});

test('visible desktop focus freshly checks identity without hiding the table or dropping an uncommitted draft',async t=>{
  const f=await fixture(t),client=f.pageAPI.client(),epoch=f.account.accountGeneration();
  f.pageAPI.move(f.pageAPI.draft().rack[0].id);const draft=f.pageAPI.draft(),pending=deferred();f.deferState(pending);
  const reads=f.calls.filter(call=>call.url==='/api/state').length;
  f.window.dispatchEvent(new Event('blur'));f.window.dispatchEvent(new Event('focus'));await settle();
  assert.equal(f.document.hidden,false);assert.equal(f.get('room-play').hidden,false);assert.ok(f.get('rack').children.length);
  assert.equal(f.pageAPI.client(),client);assert.equal(f.account.accountGeneration(),epoch);assert.deepEqual(f.pageAPI.draft(),draft);
  assert.equal(f.streams.length,1);assert.equal(f.streams[0].signal.aborted,false);
  assert.equal(f.calls.filter(call=>call.url==='/api/state').length,reads+1);
  pending.resolve(json(AUTH));await settle();
  assert.equal(f.pageAPI.client(),client);assert.deepEqual(f.pageAPI.draft(),draft);assert.equal(f.account.accountGeneration(),epoch);
  assert.equal(f.streams.length,1);assert.equal(f.get('room-play').hidden,false);
});

test('many visible focus events during one check queue at most one soft followup and never rebuild the private stream',async t=>{
  const f=await fixture(t),client=f.pageAPI.client(),pending=deferred();f.pageAPI.move(f.pageAPI.draft().rack[0].id);
  const draft=f.pageAPI.draft();f.deferState(pending);f.window.dispatchEvent(new Event('focus'));await settle();
  for(let index=0;index<8;index++)f.window.dispatchEvent(new Event('focus'));
  await settle();assert.equal(f.calls.filter(call=>call.url==='/api/state').length,2);assert.equal(f.get('room-play').hidden,false);
  pending.resolve(json(AUTH));await settle();
  assert.equal(f.calls.filter(call=>call.url==='/api/state').length,3);assert.equal(f.pageAPI.client(),client);
  assert.deepEqual(f.pageAPI.draft(),draft);assert.equal(f.streams.length,1);assert.equal(f.streams[0].signal.aborted,false);
});

test('pageshow upgrades a pending soft focus check to one concealed fresh restoration and later focus cannot downgrade it',async t=>{
  const f=await fixture(t),old=f.pageAPI.client(),pending=deferred();f.pageAPI.move(f.pageAPI.draft().rack[0].id);
  const draft=f.pageAPI.draft();f.deferState(pending);f.window.dispatchEvent(new Event('focus'));await settle();
  f.window.dispatchEvent(new Event('pageshow'));f.window.dispatchEvent(new Event('focus'));await settle();
  assert.equal(f.get('room-play').hidden,true);assert.equal(f.get('rack').children.length,0);assert.equal(old.stopped,true);
  assert.equal(f.calls.filter(call=>call.url==='/api/state').length,2);f.setState(AUTH);
  pending.resolve(json(AUTH));await settle();
  assert.equal(f.calls.filter(call=>call.url==='/api/state').length,3);assert.equal(f.streams.length,2);
  assert.equal(f.get('room-play').hidden,false);assert.deepEqual(f.pageAPI.draft(),draft);
});

test('pagehide remains a private suspension even while document.hidden is false; focus waits for a fresh restoration',async t=>{
  const f=await fixture(t);f.pageAPI.move(f.pageAPI.draft().rack[0].id);const draft=f.pageAPI.draft(),pending=deferred();
  f.window.dispatchEvent(new Event('pagehide'));assert.equal(f.document.hidden,false);assert.equal(f.get('room-play').hidden,true);
  assert.equal(f.get('rack').children.length,0);assert.equal(f.streams[0].signal.aborted,true);
  const reads=f.calls.length;f.timers.tick(90000);await settle();assert.equal(f.calls.length,reads);
  f.deferState(pending);f.window.dispatchEvent(new Event('focus'));await settle();assert.equal(f.get('room-play').hidden,true);
  pending.resolve(json(AUTH));await settle();assert.equal(f.streams.length,2);assert.deepEqual(f.pageAPI.draft(),draft);
});

test('a visible focus 401 still closes private output, discards the old draft and never replays an action',async t=>{
  const f=await fixture(t),pending=deferred();f.pageAPI.move(f.pageAPI.draft().rack[0].id);f.deferState(pending);
  f.window.dispatchEvent(new Event('focus'));await settle();assert.equal(f.get('room-play').hidden,false);
  pending.resolve(json({message:'synthetic revoked'},401));await settle();
  assert.equal(f.get('rack').children.length,0);assert.equal(f.get('board').children.length,0);assert.equal(f.pageAPI.client(),null);
  assert.equal(f.streams[0].signal.aborted,true);assert.equal(f.account.accountState().failureStatus,401);
  assert.ok(![...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
  assert.equal(f.location.replaced,undefined);assert.ok(f.calls.every(call=>(call.options.method??'GET')==='GET'));
});

test('a visible focus identity503 still hides private output; only a new same-identity check restores the legal draft',async t=>{
  const f=await fixture(t),pending=deferred();f.pageAPI.move(f.pageAPI.draft().rack[0].id);const draft=f.pageAPI.draft();f.deferState(pending);
  f.window.dispatchEvent(new Event('focus'));await settle();pending.resolve(json({message:'synthetic unavailable'},503));await settle();
  assert.equal(f.get('rack').children.length,0);assert.equal(f.pageAPI.client(),null);assert.equal(f.streams[0].signal.aborted,true);
  assert.equal(f.account.accountState().failureStatus,503);assert.ok([...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
  const recovery=deferred();f.deferState(recovery);f.window.dispatchEvent(new Event('focus'));await settle();
  assert.equal(f.get('rack').children.length,0);recovery.resolve(json(AUTH));await settle();
  assert.equal(f.streams.length,2);assert.deepEqual(f.pageAPI.draft(),draft);assert.equal(f.get('room-play').hidden,false);
});

test('an unanswered visible focus check reaches the same ten-second limit and its late success cannot repaint private cards',async t=>{
  const f=await fixture(t),pending=deferred();f.deferState(pending);f.window.dispatchEvent(new Event('focus'));await settle();
  f.timers.tick(9999);await settle();assert.equal(f.get('room-play').hidden,false);assert.ok(f.get('rack').children.length);
  f.timers.tick(1);await settle();assert.equal(f.get('rack').children.length,0);assert.equal(f.account.accountState().failureStatus,503);
  pending.resolve(json(AUTH));await settle();assert.equal(f.get('rack').children.length,0);assert.equal(f.account.accountState().authenticated,false);
});

test('a different account returned by a visible focus check cannot retain old cards, stream, draft or nickname',async t=>{
  const f=await fixture(t),pending=deferred(),old=f.pageAPI.client();f.pageAPI.move(f.pageAPI.draft().rack[0].id);f.deferState(pending);
  f.window.dispatchEvent(new Event('focus'));await settle();
  const next={...AUTH,userKey:OTHER,csrf:'other-csrf',profile:{nickname:'新朋友'}};f.setState(next);
  pending.resolve(json(next));await settle();
  assert.equal(old.stopped,true);assert.equal(f.streams[0].signal.aborted,true);assert.equal(f.account.accountState().userKey,OTHER);
  assert.equal(f.get('room-players').textContent.includes('原朋友'),false);
  assert.equal(f.pageAPI.draft().board.length,roomView(OTHER).game.board.length);
  assert.ok(![...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
});
