import * as entryPath from './entry-path.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import {gameViewport} from './game-viewport.mjs';
import * as board from './army-board.mjs';
import * as army from './army-presentation.mjs';
import * as presentation from './game-presentation.mjs';
import * as routing from './game-routing.mjs';
import * as lobbyModel from './lobby-model.mjs';
import { createGameAudio } from './game-audio.mjs';
const USER='a'.repeat(64),OTHER='b'.repeat(64),CODE='123456';
const AUTH={mode:'mock',loginReady:true,authenticated:true,userKey:USER,csrf:'synthetic-csrf',
  reauthReady:true,reauthHref:'https://agora.sumomoli.com/#account',profile:{nickname:'原朋友'},
  recentRooms:[{roomCode:CODE,gameType:'army-flip',playerId:'self',name:'原朋友',phase:'playing',expiresAt:Date.now()+100000}]};
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
    showModal(){this.open=true;this.setAttribute('open','');}close(){this.open=false;this.removeAttribute('open');}focus(){}blur(){}
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
  const self=user===USER?'self':'other';
  return {gameType:'army-flip',minPlayers:2,maxPlayers:2,roomCode:CODE,roomId:'synthetic-army',selfId:self,hostId:self,revision:1,matchId:'synthetic-match',phase:'playing',pause:null,expiresAt:Date.now()+100000,activity:[],
    players:[{id:self,name:user===USER?'原朋友':'新朋友',ready:true,connected:true},{id:'friend',name:'伙伴',ready:true,connected:true}],
    game:{version:1,gameType:'army-flip',ruleVersion:'army-flip-v1',assignment:'two-flips',players:[{id:self,name:'原朋友',side:'red',lastFlipSide:'red'},{id:'friend',name:'伙伴',side:'black',lastFlipSide:'black'}],
      board:board.BOARD_CELLS.map(cell=>({cellId:cell.cellId,piece:cell.cellId==='r0c0'?{hidden:false,id:'synthetic-known',side:'red',kind:'engineer',label:'工兵'}:cell.cellId==='r1c0'||cell.terrain==='camp'?null:{hidden:true}})),
      turnPlayerId:self,round:5,revision:4,status:'playing',winnerId:null,result:null,drawOfferByPlayerId:null,lastAction:null,legalFlips:['r0c1'],legalMoves:[{from:'r0c0',to:'r1c0'}],capturedPieces:[]}};
}
async function fixture(t,{state=AUTH,query=''}={}) {
  const document=dom(await readFile(new URL('army.html',import.meta.url),'utf8'));
  const window=new EventTarget(),timers=clock(),sessionStorage=storage(),localStorage=storage();
  const location={hostname:'127.0.0.1',search:`?code=${CODE}${query}`,href:`http://127.0.0.1/army.html?code=${CODE}${query}`,replace(url){this.replaced=url;}};
  let nextState=state,stateResponse=null,roomResponse=null,nextView=roomView(state.userKey),actionResponse=null;
  const calls=[],streams=[],watchers=[];
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url==='/api/state')return stateResponse?stateResponse().then(response=>response.clone()):json(nextState);
    if(url.endsWith('/events')) {
      let controller;const body=new ReadableStream({start(value){controller=value;}});
      const record={signal:options.signal,controller};streams.push(record);options.signal?.addEventListener('abort',()=>{try{controller.close();}catch{}});
      return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
    }
    if(url.includes('/chat'))return json({roomId:'synthetic-army',messages:[],hasOlder:false});
    if(url===`/api/rooms/${CODE}`)return roomResponse?roomResponse.promise.then(response=>response.clone()):json({view:nextView});
    if(url.endsWith('/actions'))return actionResponse?actionResponse(options):json({view:nextView});
    if(url==='/auth/logout')return json({ok:true});
    throw new Error(`Unexpected synthetic request: ${url}`);
  };
  Object.assign(window,{innerWidth:844,innerHeight:390,visualViewport:null,setInterval:()=>0,clearInterval(){}});
  const context=vm.createContext({document,window,location,navigator:{},sessionStorage,localStorage,fetch,URL,URLSearchParams,Response,ReadableStream,TextDecoder,AbortController,DOMException,Event,EventTarget,structuredClone,performance,crypto,
    setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,queueMicrotask,requestAnimationFrame:()=>0,
    ...board,...army,...presentation,...routing,...lobbyModel,gameViewport,createGameAudio});
  const account=await moduleIn(context,'account-client.mjs');Object.assign(context,account);
  context.watchAccountLifecycle=options=>{const watcher=account.watchAccountLifecycle(options);watchers.push(watcher);return watcher;};
  Object.assign(context,await moduleIn(context,'room-client.mjs'));
  Object.assign(context,await moduleIn(context,'room-chat.mjs'));
  let pageAPI;context.expose=value=>{pageAPI=value;};
  await moduleIn(context,'army-room.mjs','expose({client:()=>client,view:()=>view,selected:()=>selected,click:clickCell,action,clear:clearPrivate});');
  t.after(()=>{watchers.forEach(watcher=>watcher.stop());pageAPI.client()?.stop();});await settle();
  return {account,document,window,timers,sessionStorage,calls,streams,pageAPI,location,get:id=>document.getElementById(id),
    setState(value){nextState=value;stateResponse=null;roomResponse=null;nextView=roomView(value.userKey);},deferState(value){stateResponse=()=>value.promise;},deferRoom(value){roomResponse=value;},
    setAction(value){actionResponse=value;},setView(value){nextView=value;},
    push(value){streams.at(-1).controller.enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify({view:value})}\n\n`));},
    cell:id=>document.getElementById('army-cells').querySelector(`[data-cell-id="${id}"]`)};
}

test('actual invited army page reports an account conflict once without changing current identity, seat or game revision',async t=>{
  const f=await fixture(t,{query:'&login=account'}),before=f.pageAPI.view();
  assert.equal(f.account.accountState().userKey,USER);assert.equal(before.selfId,'self');assert.equal(before.game.revision,4);
  assert.equal(f.get('toast').hidden,false);assert.match(f.get('toast').textContent,/当前棋牌账号与原席位保持/);
  f.timers.tick(5000);await settle();assert.equal(f.get('toast').hidden,true);f.get('toast').textContent='already notified';
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();
  assert.equal(f.get('toast').textContent,'already notified');assert.equal(f.get('toast').hidden,true);
  const after=f.pageAPI.view();assert.equal(after.selfId,before.selfId);assert.equal(after.game.revision,before.game.revision);
  assert.equal(f.account.accountState().userKey,USER);assert.ok(!f.location.replaced);
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,0);
});

test('army selection only highlights server-supplied legal targets and a second click submits one authoritative move',async t=>{
  const f=await fixture(t);assert.equal(f.get('army-cells').children.length,60,JSON.stringify({state:f.account.accountState(),wait:f.get('waiting-hint').textContent,calls:f.calls.map(c=>c.url)}));
  f.pageAPI.click('r0c0');assert.equal(f.pageAPI.selected(),'r0c0');assert.equal(f.cell('r1c0').classList.contains('target'),true);
  assert.equal(f.cell('r0c1').classList.contains('target'),false);
  f.pageAPI.click('r1c0');await settle();
  const writes=f.calls.filter(call=>call.url.endsWith('/actions'));assert.equal(writes.length,1);
  const body=JSON.parse(writes[0].options.body);assert.equal(body.type,'move');assert.equal(body.from,'r0c0');assert.equal(body.to,'r1c0');assert.equal(body.expectedRevision,1);
});
test('unknown dark pieces render no identity or label; forbidden dark cells submit no action',async t=>{
  const f=await fixture(t);const dark=f.cell('r0c2');assert.equal(dark.textContent,'');assert.match(dark.getAttribute('aria-label'),/未翻暗子/);assert.equal(dark.getAttribute('aria-label').includes('synthetic-known'),false);
  f.pageAPI.click('r0c2');await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  f.pageAPI.click('r0c1');await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,1);assert.equal(JSON.parse(f.calls.at(-1).options.body).type,'flip');
});
test('periodic successful identity checks preserve selection, original client and single SSE',async t=>{
  const f=await fixture(t),client=f.pageAPI.client(),epoch=f.account.accountGeneration();f.pageAPI.click('r0c0');
  for(let i=0;i<3;i++){f.timers.tick(15000);await settle();assert.equal(f.pageAPI.selected(),'r0c0');assert.equal(f.pageAPI.client(),client);}
  assert.equal(f.streams.length,1);assert.equal(f.account.accountGeneration(),epoch);
});
test('presence or pause-vote metadata preserves selection; a newer game revision removes stale targets',async t=>{
  const f=await fixture(t);f.pageAPI.click('r0c0');const updated=roomView();updated.revision=2;updated.players[1].connected=false;updated.pause={type:'pause',agreedIds:['friend'],requiredIds:['self','friend']};f.push(updated);await settle();
  assert.equal(f.pageAPI.selected(),'r0c0');assert.equal(f.cell('r1c0').classList.contains('target'),true);
  updated.revision=3;updated.game.revision=5;updated.game.turnPlayerId='friend';updated.game.legalMoves=[];updated.game.legalFlips=[];f.push(updated);await settle();assert.equal(f.pageAPI.selected(),null);assert.equal(f.cell('r1c0').classList.contains('target'),false);
});
test('background immediately clears complete board and stops SSE; focus waits for fresh identity before stable seat recovery',async t=>{
  const f=await fixture(t);f.pageAPI.click('r0c0');f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.get('army-cells').children.length,0);assert.equal(f.get('army-lines').children.length,0);assert.equal(f.get('room-players').children.length,0);assert.equal(f.pageAPI.client(),null);assert.equal(f.streams[0].signal.aborted,true);
  const pending=deferred();f.deferState(pending);f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();assert.equal(f.get('army-cells').children.length,0);
  pending.resolve(json(AUTH));await settle();assert.equal(f.get('army-cells').children.length,60);assert.equal(f.pageAPI.view().selfId,'self');assert.equal(f.pageAPI.view().matchId,'synthetic-match');assert.equal(f.pageAPI.selected(),null);
});
test('pagehide clears private content and pageshow verifies before recovering',async t=>{
  const f=await fixture(t);f.window.dispatchEvent(new Event('pagehide'));assert.equal(f.get('army-cells').children.length,0);
  const pending=deferred();f.deferState(pending);f.window.dispatchEvent(new Event('pageshow'));await settle();assert.equal(f.get('army-cells').children.length,0);pending.resolve(json(AUTH));await settle();assert.equal(f.get('army-cells').children.length,60);
});
test('401 hides board and restores the army invitation with explicit central recovery, without automatic login or room write',async t=>{
  const f=await fixture(t);f.deferState({promise:Promise.resolve(json({message:'revoked'},401))});f.timers.tick(15000);await settle();
  assert.equal(f.get('army-cells').children.length,0);assert.equal(f.pageAPI.client(),null);assert.equal(f.get('room-account-reauth').href,'https://agora.sumomoli.com/#account');
  assert.match(f.get('room-account-recover').href,/army\.html%3Fcode%3D123456/);assert.equal(f.location.replaced,undefined);assert.ok(f.calls.every(call=>(call.options.method??'GET')==='GET'));
});
test('503 pauses without business writes and fresh same-account verification restores original match',async t=>{
  const f=await fixture(t);f.deferState({promise:Promise.resolve(json({message:'unavailable'},503))});f.timers.tick(15000);await settle();assert.equal(f.get('army-cells').children.length,0);assert.match(f.get('waiting-hint').textContent,/原席位.*服务器/);
  f.setState(AUTH);f.timers.tick(15000);await settle();assert.equal(f.pageAPI.view().selfId,'self');assert.equal(f.pageAPI.view().matchId,'synthetic-match');assert.equal(f.get('army-cells').children.length,60);assert.ok(f.calls.every(call=>(call.options.method??'GET')==='GET'));
});
test('a delayed private read cannot repaint after background or identity replacement',async t=>{
  const f=await fixture(t),pending=deferred();f.deferRoom(pending);const reading=f.pageAPI.client().refresh();await settle();f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  pending.resolve(json({view:{...roomView(),revision:99}}));await assert.rejects(reading,error=>error.name==='AbortError');assert.equal(f.get('army-cells').children.length,0);
  f.setState({...AUTH,userKey:OTHER,csrf:'other'});f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();assert.equal(f.get('room-players').textContent.includes('原朋友'),false);
});
test('move response lost or unavailable is never automatically replayed or optimistically applied',async t=>{
  const f=await fixture(t);let writes=0;f.setAction(()=>{writes++;throw new TypeError('connection lost');});const before=structuredClone(f.pageAPI.view().game.board);
  f.pageAPI.click('r0c0');f.pageAPI.click('r1c0');await settle();assert.equal(writes,1);assert.deepEqual(f.pageAPI.view().game.board,before);assert.equal(f.calls.filter(call=>call.url===`/api/rooms/${CODE}`).length,2);
});
test('resign is separate from room exit and requires an explicit second confirmation even outside own turn',async t=>{
  const f=await fixture(t);const offTurn=roomView();offTurn.game.turnPlayerId='friend';offTurn.game.legalFlips=[];offTurn.game.legalMoves=[];offTurn.revision=2;f.push(offTurn);await settle();
  f.get('army-resign').dispatchEvent(new Event('click'));assert.equal(f.get('army-resign-dialog').open,true);assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  f.get('army-resign-confirm').dispatchEvent(new Event('click'));await settle();const body=JSON.parse(f.calls.find(call=>call.url.endsWith('/actions')).options.body);assert.equal(body.type,'resign');
});
test('proposed draw may be sent off turn; only the opposite player sees acceptance controls',async t=>{
  const f=await fixture(t);const next=roomView();next.game.turnPlayerId='friend';next.revision=2;f.push(next);await settle();assert.equal(f.get('army-offer-draw').disabled,false);
  f.get('army-offer-draw').dispatchEvent(new Event('click'));await settle();assert.equal(JSON.parse(f.calls.find(call=>call.url.endsWith('/actions')).options.body).type,'offer-draw');
  next.revision=3;next.game.drawOfferByPlayerId='self';f.push(next);await settle();assert.equal(f.get('army-accept-draw').hidden,true);
  next.revision=4;next.game.drawOfferByPlayerId='friend';f.push(next);await settle();assert.equal(f.get('army-accept-draw').hidden,false);
});
test('army viewport rules reserve one fixed non-scrolling board and preserve accessible whole-cell hit areas',async()=>{
  const css=await readFile(new URL('army.css',import.meta.url),'utf8');assert.match(css,/body\.army-screen[^}]*height:var\(--army-viewport-height\)[^}]*overflow:hidden/);
  assert.match(css,/\.army-board\s*\{[^}]*aspect-ratio:12\/5/);assert.match(css,/\.army-cell\s*\{[^}]*width:7\.65%[^}]*height:18\.6%[^}]*touch-action:manipulation/);
  const html=await readFile(new URL('army.html',import.meta.url),'utf8');assert.match(html,/class="army-screen"/);assert.equal(html.includes('app.mjs'),false);assert.match(html,/army-resign-confirm/);assert.match(html,/viewport-fit=cover/);
});

function transportRoomView() {
  const view=roomView();view.game.version=2;view.game.ruleVersion='army-flip-v2';
  view.game.flagTokens=[{side:'black',carrierId:null,cellId:'r0c0'}];
  view.game.legalPickups=[{cellId:'r0c0',flagSide:'black'}];
  return view;
}
test('actual v2 room renders four side bases, public ground and carried flags without exposing hidden identities',async t=>{
  const f=await fixture(t),next=transportRoomView();next.revision=2;next.game.revision=5;
  next.game.flagTokens.push({side:'red',carrierId:'synthetic-known',cellId:null});f.push(next);await settle();
  assert.equal(f.get('army-cells').children.length,60);
  assert.equal(f.get('army-cells').querySelectorAll('.army-base-label').length,4);
  for(const id of ['r11c1','r11c3'])assert.match(f.cell(id).getAttribute('aria-label'),/红方基地/);
  for(const id of ['r0c1','r0c3'])assert.match(f.cell(id).getAttribute('aria-label'),/黑方基地/);
  assert.match(f.cell('r0c0').textContent,/携红旗.*黑旗·拾/);assert.equal(f.cell('r0c0').classList.contains('pickup-ready'),true);
  assert.match(f.cell('r0c0').getAttribute('aria-label'),/地上有黑方军旗.*携带红方军旗.*可点按拾起黑方军旗/);
  assert.equal(f.cell('r0c2').getAttribute('aria-label').includes('synthetic-known'),false);
  assert.match(f.get('army-feedback').textContent,/敌旗须运回己方基地/);
});
test('actual room pickup submits exact server permission once and only the confirmed view changes its flag marker',async t=>{
  const f=await fixture(t),next=transportRoomView();next.revision=2;next.game.revision=5;f.push(next);await settle();
  const pending=deferred();f.setAction(()=>pending.promise);
  f.pageAPI.click('r0c0');await settle();
  const writes=f.calls.filter(call=>call.url.endsWith('/actions'));assert.equal(writes.length,1);
  const body=JSON.parse(writes[0].options.body);assert.equal(body.type,'pickup');assert.equal(body.cellId,'r0c0');assert.equal(body.flagSide,'black');assert.equal(body.expectedRevision,2);
  assert.match(f.cell('r0c0').textContent,/黑旗/);assert.equal(f.cell('r0c0').querySelector('.army-flag-mark.carried'),null);
  const confirmed=structuredClone(next);confirmed.revision=3;confirmed.game.revision=6;confirmed.game.turnPlayerId='friend';confirmed.game.legalPickups=[];
  confirmed.game.flagTokens=[{side:'black',carrierId:'synthetic-known',cellId:null}];confirmed.game.lastAction={type:'pickup',playerId:'self',cellId:'r0c0',flagSide:'black',flagEvents:[{type:'pickup',side:'black',cellId:null,carrierId:'synthetic-known'}]};
  pending.resolve(json({view:confirmed}));await settle();
  assert.match(f.cell('r0c0').textContent,/携黑旗/);assert.equal(f.cell('r0c0').querySelector('.army-flag-mark.ground'),null);
  assert.match(f.get('army-feedback').textContent,/拾起军旗.*携带黑方军旗.*等朋友行动/);
  f.pageAPI.click('r0c0');await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,1);
});
test('actual room same-station flags wait for an explicit side choice and never silently choose the first flag',async t=>{
  const f=await fixture(t),next=transportRoomView();next.revision=2;next.game.revision=5;next.game.flagTokens.push({side:'red',carrierId:null,cellId:'r0c0'});next.game.legalPickups.push({cellId:'r0c0',flagSide:'red'});f.push(next);await settle();
  f.pageAPI.click('r0c0');await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  const dialog=f.document.querySelector('.army-pickup-dialog');assert.equal(dialog.open,true);assert.equal(dialog.querySelectorAll('[data-pickup-side]').length,2);
  dialog.querySelector('[data-pickup-side="red"]').dispatchEvent(new Event('click'));await settle();
  const writes=f.calls.filter(call=>call.url.endsWith('/actions'));assert.equal(writes.length,1);assert.equal(JSON.parse(writes[0].options.body).flagSide,'red');assert.equal(f.document.querySelector('.army-pickup-dialog'),null);
});
test('an open public flag choice is removed on identity failure and its detached button cannot write afterwards',async t=>{
  const f=await fixture(t),next=transportRoomView();next.revision=2;next.game.revision=5;next.game.flagTokens.push({side:'red',carrierId:null,cellId:'r0c0'});next.game.legalPickups.push({cellId:'r0c0',flagSide:'red'});f.push(next);await settle();f.pageAPI.click('r0c0');
  const button=f.document.querySelector('[data-pickup-side="red"]');assert.ok(button);
  f.deferState({promise:Promise.resolve(json({message:'revoked'},401))});f.timers.tick(15000);await settle();assert.equal(f.document.querySelector('.army-pickup-dialog'),null);
  button.dispatchEvent(new Event('click'));await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});
test('actual selected v2 dark target sends move rather than flip and displays authoritative friendly reveal',async t=>{
  const f=await fixture(t),next=transportRoomView();next.revision=2;next.game.revision=5;next.game.flagTokens=[];next.game.legalPickups=[];
  next.game.legalMoves.push({from:'r0c0',to:'r0c1'});f.push(next);await settle();f.pageAPI.click('r0c0');assert.equal(f.cell('r0c1').classList.contains('target'),true);
  const confirmed=structuredClone(next);confirmed.revision=3;confirmed.game.revision=6;confirmed.game.turnPlayerId='friend';confirmed.game.legalMoves=[];confirmed.game.legalFlips=[];
  confirmed.game.board.find(item=>item.cellId==='r0c1').piece={hidden:false,id:'friendly-public',side:'red',kind:'platoon',label:'排长'};
  confirmed.game.lastAction={type:'move',playerId:'self',from:'r0c0',to:'r0c1',outcome:'friendly-reveal',flagEvents:[]};f.setAction(()=>json({view:confirmed}));
  f.pageAPI.click('r0c1');await settle();
  const writes=f.calls.filter(call=>call.url.endsWith('/actions'));assert.equal(writes.length,1);assert.equal(JSON.parse(writes[0].options.body).type,'move');
  assert.match(f.cell('r0c0').textContent,/工兵/);assert.match(f.cell('r0c1').textContent,/排长/);assert.match(f.get('army-feedback').textContent,/同阵营暗子.*原地停留/);
});
test('actual rules preserve old v1 victory text and update an open dialog only when the authoritative match changes to v2',async t=>{
  const f=await fixture(t);f.get('show-rules').dispatchEvent(new Event('click'));
  assert.match(f.get('rules-title').textContent,/吃旗规则 v1/);assert.match(f.get('army-rule-page').textContent,/击败对方军旗/);assert.equal(f.get('army-cells').querySelectorAll('.army-base-label').length,0);
  const next=transportRoomView();next.matchId='new-v2-match';next.revision=2;next.game.revision=1;f.push(next);await settle();
  assert.match(f.get('rules-title').textContent,/运旗规则 v2/);assert.match(f.get('army-rule-page').textContent,/拿到旗不会立即获胜/);assert.equal(f.get('army-rules-page').textContent,'1/4');
});
test('actual v2 room keeps a returned home flag in play and declares victory only for a delivered enemy flag result',async t=>{
  const f=await fixture(t),base=transportRoomView();base.revision=2;base.game.revision=5;f.push(base);await settle();
  const returned=structuredClone(base);returned.revision=3;returned.game.revision=6;returned.game.legalPickups=[];
  returned.game.flagTokens=[{side:'red',carrierId:null,cellId:'r11c1'}];returned.game.lastAction={type:'move',playerId:'self',from:'r10c1',to:'r11c1',outcome:'move',flagEvents:[{type:'returned',side:'red',cellId:'r11c1',carrierId:null}]};f.push(returned);await settle();
  assert.equal(f.get('room-result').hidden,true);assert.match(f.get('army-feedback').textContent,/红方军旗已归位/);assert.equal(f.get('army-feedback').textContent.includes('获胜'),false);
  const won=structuredClone(returned);won.revision=4;won.game.revision=7;won.phase='finished';won.game.status='finished';won.game.winnerId='self';won.game.result={reason:'flag-delivered',winnerIds:['self'],tie:false};won.game.lastAction={type:'move',playerId:'self',from:'r10c3',to:'r11c3',outcome:'move',flagEvents:[{type:'delivered',side:'black',cellId:'r11c3',carrierId:'synthetic-known'}]};f.push(won);await settle();
  assert.equal(f.get('room-result').hidden,false);assert.match(f.get('result-title').textContent,/原朋友 赢了/);assert.match(f.get('result-reason').textContent,/敌方军旗已运回己方基地.*获胜/);
});
test('v2 spectator flags stay public and readonly, then all flag and base DOM disappears on identity failure',async t=>{
  const f=await fixture(t),next=transportRoomView();next.revision=2;next.selfRole='spectator';next.players=next.players.filter(player=>player.id!=='self');next.spectators=[{id:'self',name:'原朋友',connected:true}];next.game.legalMoves=[];next.game.legalFlips=[];next.game.legalPickups=[];next.game.flagTokens.push({side:'red',carrierId:'synthetic-known',cellId:null});f.push(next);await settle();
  assert.match(f.cell('r0c0').textContent,/携红旗.*黑旗/);assert.equal(f.cell('r0c0').classList.contains('pickup-ready'),false);assert.equal(f.cell('r0c0').disabled,true);
  f.pageAPI.click('r0c0');await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  f.deferState({promise:Promise.resolve(json({message:'revoked'},401))});f.timers.tick(15000);await settle();
  assert.equal(f.get('army-cells').children.length,0);assert.equal(f.get('army-cells').querySelectorAll('.army-flag-mark').length,0);assert.equal(f.get('army-cells').querySelectorAll('.army-base-label').length,0);
});

async function practiceFixture({snapshot,mounted=false,locks}={}) {
  const document=dom(await readFile(new URL('army-practice.html',import.meta.url),'utf8'));
  const window=new EventTarget(),timers=clock(),localStorage=storage();
  Object.assign(window,{innerWidth:390,innerHeight:844,visualViewport:null,scrollX:0,scrollY:0,scrollTo(){}});
  let changed,resumeCount=0,actionResponse=null,pageAPI,active=false,sessionOptions;
  let current=snapshot || {matchId:'synthetic-practice-v2',baseline:true,storageAvailable:true,game:transportRoomView().game};
  const actions=[],session={suspend(){active=false;},async resume(){active=true;resumeCount++;changed(current);},async restart(){},async act(action){if(!active)return {ok:false,error:'返回练习后再走棋。'};actions.push(action);return actionResponse?actionResponse(action):{ok:true};}};
  const context=vm.createContext({document,window,navigator:{locks},localStorage,innerWidth:390,innerHeight:844,Event,EventTarget,structuredClone,performance,crypto,
    setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,requestAnimationFrame:()=>0,
    ...board,...army,gameViewport,createGameAudio,PRACTICE_SELF:'self',PRACTICE_STORAGE_KEY:'practice-v3-key',PRACTICE_V2_STORAGE_KEY:'practice-v2-key',PRACTICE_LEGACY_STORAGE_KEY:'practice-v1-key',
    createPracticeSession:async options=>{sessionOptions=options;changed=options.onChange;return session;},expose:value=>{pageAPI=value;}});
  const moduleUrl=mounted?'https://agora.sumomoli.com/game/entry-path.mjs':'https://game.sumomoli.com/entry-path.mjs';
  Object.assign(context, {entryBase:()=>entryPath.entryBase(moduleUrl),entryStorageKey:key=>entryPath.entryStorageKey(key,moduleUrl)});
  const source=(await readFile(new URL('army-practice.mjs',import.meta.url),'utf8')).replace(/^import[\s\S]*?;\s*/gm,'');
  await vm.runInContext(`(async()=>{${source}\nexpose({click:clickCell,view:()=>view,selected:()=>selected});})()`,context,{filename:'army-practice.mjs'});
  return {document,window,actions,pageAPI,get:id=>document.getElementById(id),cell:id=>document.getElementById('army-cells').children.find(node=>node.dataset.cellId===id),
    resumeCount:()=>resumeCount,sessionOptions,localStorage,setAction(handler){actionResponse=handler;},push(next){current=next;changed(next);}};
}

test('actual mounted army practice isolates versioned save keys, lock and storage events while direct old keys remain compatible',async()=>{
  const lockCalls=[];
  const direct=await practiceFixture(),mounted=await practiceFixture({mounted:true,locks:{request:async(name,options,callback)=>{lockCalls.push({name,options});return callback();}}});
  assert.equal(direct.sessionOptions.storage,direct.localStorage);assert.equal(direct.sessionOptions.withLock,undefined);
  direct.sessionOptions.storage.setItem('practice-v1-key','existing direct save');
  mounted.localStorage.setItem('practice-v1-key','existing old root record');
  mounted.sessionOptions.storage.setItem('practice-v3-key','new mounted save');
  assert.equal(mounted.localStorage.getItem('agora-game:practice-v3-key'),'new mounted save');
  assert.equal(mounted.sessionOptions.storage.getItem('practice-v1-key'),null);
  assert.equal(mounted.localStorage.getItem('practice-v1-key'),'existing old root record');
  await mounted.sessionOptions.withLock(()=>true);
  assert.equal(lockCalls[0].name,'agora-game:practice-v1-key');assert.equal(lockCalls[0].options.mode,'exclusive');
  const before=mounted.resumeCount();
  const foreign=new Event('storage');Object.defineProperty(foreign,'key',{value:'practice-v3-key'});mounted.window.dispatchEvent(foreign);assert.equal(mounted.resumeCount(),before);
  for(const key of ['practice-v1-key','practice-v2-key','practice-v3-key']){
    const event=new Event('storage');Object.defineProperty(event,'key',{value:'agora-game:'+key});mounted.window.dispatchEvent(event);
  }
  assert.equal(mounted.resumeCount(),before+3);assert.equal(direct.localStorage.getItem('practice-v1-key'),'existing direct save');
});
test('actual single-player v2 page uses the same exact pickup API and public flag markers without optimistic changes',async()=>{
  const f=await practiceFixture();assert.equal(f.get('army-cells').children.length,60);assert.match(f.cell('r0c0').textContent,/黑旗·拾/);
  assert.match(f.cell('r11c1').getAttribute('aria-label'),/红方基地/);const pending=deferred();f.setAction(()=>pending.promise);
  const clicking=f.pageAPI.click('r0c0');await settle();assert.deepEqual(JSON.parse(JSON.stringify(f.actions)),[{type:'pickup',cellId:'r0c0',flagSide:'black'}]);assert.equal(f.cell('r0c0').querySelector('.army-flag-mark.carried'),null);
  const next={matchId:'synthetic-practice-v2',baseline:false,storageAvailable:true,game:transportRoomView().game};next.game.revision=5;next.game.turnPlayerId='friend';next.game.legalPickups=[];
  next.game.flagTokens=[{side:'black',carrierId:'synthetic-known',cellId:null}];next.game.lastAction={type:'pickup',playerId:'self',cellId:'r0c0',flagSide:'black',flagEvents:[{type:'pickup',side:'black',carrierId:'synthetic-known',cellId:null}]};
  f.push(next);pending.resolve({ok:true});await clicking;assert.match(f.cell('r0c0').textContent,/携黑旗/);assert.match(f.get('army-feedback').textContent,/携带黑方军旗/);
});
test('actual practice resumes its suspended controller before submitting the chosen same-station flag side',async()=>{
  const snapshot={matchId:'two-flags-practice',baseline:true,storageAvailable:true,game:transportRoomView().game};snapshot.game.flagTokens.push({side:'red',carrierId:null,cellId:'r0c0'});snapshot.game.legalPickups.push({cellId:'r0c0',flagSide:'red'});
  const f=await practiceFixture({snapshot}),before=f.resumeCount();await f.pageAPI.click('r0c0');assert.equal(f.actions.length,0);const dialog=f.document.querySelector('.army-pickup-dialog');assert.equal(dialog.open,true);
  dialog.querySelector('[data-pickup-side="red"]').dispatchEvent(new Event('click'));await settle();assert.equal(f.resumeCount(),before+1);assert.deepEqual(JSON.parse(JSON.stringify(f.actions)),[{type:'pickup',cellId:'r0c0',flagSide:'red'}]);assert.equal(f.document.querySelector('.army-pickup-dialog'),null);
});
test('actual practice rules preserve a restored v1 game and show transport pages only for a v2 snapshot',async()=>{
  const old={matchId:'saved-practice-v1',baseline:true,storageAvailable:true,game:roomView().game};
  const f=await practiceFixture({snapshot:old});f.get('show-rules').dispatchEvent(new Event('click'));assert.match(f.get('rules-title').textContent,/吃旗规则 v1/);assert.match(f.get('army-rule-page').textContent,/击败对方军旗/);assert.equal(f.get('army-cells').querySelectorAll('.army-base-label').length,0);
  f.get('close-rules').dispatchEvent(new Event('click'));f.push({matchId:'new-practice-v2',baseline:true,storageAvailable:true,game:transportRoomView().game});f.get('show-rules').dispatchEvent(new Event('click'));
  assert.match(f.get('rules-title').textContent,/运旗规则 v2/);assert.match(f.get('army-rule-page').textContent,/拿到旗不会立即获胜/);assert.equal(f.get('army-rules-page').textContent,'1/4');
});
test('actual practice page listens to both save generations while ignoring unrelated storage events',async()=>{
  const f=await practiceFixture(),start=f.resumeCount();
  for(const key of ['practice-v1-key','practice-v2-key','unrelated-key']) {const event=new Event('storage');Object.defineProperty(event,'key',{value:key});f.window.dispatchEvent(event);await settle();}
  assert.equal(f.resumeCount(),start+2);
});

test('both army entry documents declare the same dark root and safe-area status bar contract',async()=>{
  for(const file of ['army.html','army-practice.html']) {
    const document=dom(await readFile(new URL(file,import.meta.url),'utf8'));
    assert.equal(document.querySelector('html').classList.contains('army-root'),true,file);
    assert.equal(document.querySelector('meta[name="theme-color"]').getAttribute('content'),'#143b30',file);
    assert.equal(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').getAttribute('content'),'black-translucent',file);
    assert.equal(document.querySelector('meta[name="apple-mobile-web-app-capable"]').getAttribute('content'),'yes',file);
    assert.match(document.querySelector('meta[name="viewport"]').getAttribute('content'),/viewport-fit=cover/,file);
    const styles=document.querySelectorAll('link[rel="stylesheet"]').map(node=>node.getAttribute('href'));
    assert.ok(styles.indexOf('./army.css')>styles.indexOf('./styles.css'),file);
    assert.equal(document.querySelector('link[rel="manifest"]').getAttribute('href'),'./manifest.webmanifest',file);
  }
});

test('army root paint has a non-has fallback and rotation retains four safe insets without a legacy minimum height',async()=>{
  // Asset contracts protect the canvas/status-bar fix. CSS-engine geometry and
  // actual iPhone standalone status-bar behavior are separate browser/device QA.
  const css=await readFile(new URL('army.css',import.meta.url),'utf8');
  assert.match(css,/html\.army-root\s*\{[^}]*height:100%[^}]*width:100%[^}]*background:#143b30[^}]*overflow:hidden; overflow:clip/);
  assert.equal(/html\.army-root[^\{]*:has/.test(css),false,'unsupported :has cannot invalidate the explicit root rule');
  const shell=css.match(/\.army-screen \.shell\s*\{([^}]+)\}/)?.[1];
  assert.ok(shell);assert.match(shell,/height:100%; min-height:0/);
  assert.match(shell,/padding:max\(6px,env\(safe-area-inset-top\)\) max\(12px,env\(safe-area-inset-right\)\) max\(6px,env\(safe-area-inset-bottom\)\) max\(12px,env\(safe-area-inset-left\)\)/);
  const short=css.match(/@media \(max-height:500px\)\s*\{\s*\.army-screen \.shell\s*\{([^}]+)\}/)?.[1];
  assert.ok(short);assert.match(short,/padding-top:max\(3px,env\(safe-area-inset-top\)\)/);
  assert.match(short,/padding-bottom:max\(4px,env\(safe-area-inset-bottom\)\)/);
  assert.match(css,/\.army-screen \.shell:not\(\.lobby-shell\) > main \{ overflow:hidden; overflow:clip; \}/);
  assert.equal(/html(?:\s*,\s*body)?\s*\{[^}]*background:#143b30/.test(css),false,'dark root paint stays scoped to army documents');
});

test('army chat assets provide readable normal, hover, unread and disabled colour pairs instead of inheriting the pale shared button',async()=>{
  const css=await readFile(new URL('army.css',import.meta.url),'utf8');
  const rule=selector=>{
    const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const body=css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`))?.[1];assert.ok(body,selector);
    return Object.fromEntries(body.split(';').map(part=>part.trim().split(':')).filter(parts=>parts.length===2).map(([key,value])=>[key.trim(),value.trim()]));
  };
  const normal=rule('.army-screen .chat-toggle'),hover=rule('.army-screen .chat-toggle:not(:disabled):hover,.army-screen .chat-toggle[aria-expanded="true"]');
  const unread=rule('.army-screen .chat-unread'),disabled=rule('.army-screen .chat-toggle:disabled');
  const luminance=hex=>{
    assert.match(hex,/^#[0-9a-f]{6}$/i);
    const channels=[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
    return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
  };
  const contrast=(foreground,background)=>{const levels=[luminance(foreground),luminance(background)].sort((a,b)=>b-a);return(levels[0]+.05)/(levels[1]+.05);};
  for(const [name,pair] of [['normal',normal],['hover',{...normal,...hover}],['unread',unread],['disabled',disabled]]) {
    assert.ok(contrast(pair.color,pair.background)>=4.5,`${name} text must remain readable at its small font size`);
  }
  assert.equal(disabled.opacity,'1','shared button:disabled opacity must not wash out the checked pair');
  assert.notEqual(normal.background,'#edf0e5','the common lobby/chat background is deliberately overridden only in army');
});

test('actual army fixed canvas pins focus/resize offsets while preserving selection and inner chat/activity scroll',async t=>{
  const f=await fixture(t);f.pageAPI.click('r0c0');
  const selected=f.pageAPI.selected(),main=f.document.querySelector('main'),shell=f.document.querySelector('.shell'),play=f.get('room-play');
  const list=f.get('chat-messages'),activity=f.get('room-activity-list');list.scrollTop=90;activity.scrollTop=45;
  for(const node of [main,shell,play]) {node.scrollTop=24;node.scrollLeft=12;}
  const focus=new Event('focusin');Object.defineProperty(focus,'target',{value:f.get('army-cells').children[0]});f.document.dispatchEvent(focus);
  for(const node of [main,shell,play]) {assert.equal(node.scrollTop,0);assert.equal(node.scrollLeft,0);}
  main.scrollTop=21;main.dispatchEvent(new Event('scroll'));assert.equal(main.scrollTop,0);
  for(const [width,height]of [[390,844],[844,390],[1280,720]]) {
    f.window.innerWidth=width;f.window.innerHeight=height;main.scrollTop=21;f.window.dispatchEvent(new Event('resize'));assert.equal(main.scrollTop,0);
  }
  assert.equal(f.pageAPI.selected(),selected);assert.equal(list.scrollTop,90);assert.equal(activity.scrollTop,45);
  const css=await readFile(new URL('army.css',import.meta.url),'utf8');
  assert.match(css,/\.army-screen \.shell:not\(\.lobby-shell\) > main \{ overflow:hidden; overflow:clip; \}/);
  assert.match(css,/\.army-screen \.shell:not\(\.lobby-shell\) \.room-players \{ display:grid; margin:0; \}/);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});

test('the last remaining host can rematch an interrupted one-person room before a replacement friend joins',async t=>{
  const f=await fixture(t),interrupted=roomView();interrupted.players=interrupted.players.filter(p=>p.id==='self');interrupted.phase='aborted';interrupted.revision=2;interrupted.game.result={aborted:true};f.push(interrupted);await settle();
  assert.equal(f.get('rematch').hidden,false);assert.equal(f.get('rematch').disabled,false);
  const waiting={...interrupted,phase:'waiting',revision:3,game:null};f.setAction(()=>json({view:waiting}));f.get('rematch').dispatchEvent(new Event('click'));await settle();
  assert.equal(f.pageAPI.view().phase,'waiting');assert.equal(f.get('room-waiting').hidden,false);assert.equal(f.get('start-room').disabled,true);assert.equal(f.get('army-cells').children.length,0);
  waiting.revision=4;waiting.players=[{id:'self',name:'原朋友',ready:true,connected:true},{id:'replacement',name:'新伙伴',ready:true,connected:true}];f.push(waiting);await settle();assert.equal(f.get('start-room').disabled,false);
});

test('a winner leaving a completed room does not turn the historical result into a draw',async t=>{
  const f=await fixture(t),finished=roomView();finished.phase='finished';finished.revision=2;finished.game.revision=5;finished.game.status='finished';finished.game.winnerId='friend';finished.game.result={reason:'resigned',winnerIds:['friend'],tie:false};finished.game.players[1].name='获胜伙伴';finished.players=finished.players.filter(p=>p.id==='self');f.push(finished);await settle();
  assert.equal(f.get('result-title').textContent,'获胜伙伴 赢了这一局。');assert.match(f.get('result-reason').textContent,/认输/);assert.equal(f.get('rematch').disabled,false);
});
test('server-authoritative wrong game routes before reading an unrelated game shape and clears the army view',async t=>{
  const f=await fixture(t);f.push({...roomView(),revision:2,gameType:'rummikub',game:{rack:[],board:[]}});await settle();assert.equal(f.location.replaced,'./room.html?code=123456');assert.equal(f.get('army-cells').children.length,0);assert.equal(f.streams[0].signal.aborted,true);
});
function spectatorView(phase='playing') {
  const view=roomView();view.selfRole='spectator';view.hostId='friend';
  view.players=[{id:'friend',name:'红方朋友',ready:true,connected:true},{id:'friend-2',name:'黑方朋友',ready:true,connected:true}];
  view.spectators=[{id:'self',name:'原朋友',connected:true}];view.spectatorCapacity=8;
  view.game.players=[{id:'friend',name:'红方朋友',side:'red'},{id:'friend-2',name:'黑方朋友',side:'black'}];
  view.game.turnPlayerId='friend';view.game.legalMoves=[];view.game.legalFlips=[];view.game.drawOfferByPlayerId='friend';
  view.phase=phase;if(phase==='waiting'){view.game=null;view.matchId=null;}
  return view;
}

test('army spectators get a complete public board without flip, move, ready, draw, resign or player-room actions',async t=>{
  const f=await fixture(t);f.pageAPI.click('r0c0');assert.equal(f.pageAPI.selected(),'r0c0');
  const observer=spectatorView();observer.revision=2;f.push(observer);await settle();
  assert.equal(f.pageAPI.selected(),null);assert.equal(f.get('army-cells').children.length,60);
  assert.ok(f.get('army-cells').children.every(cell=>cell.disabled));
  assert.equal(f.cell('r0c2').textContent,'');assert.match(f.cell('r0c2').getAttribute('aria-label'),/未翻暗子/);
  assert.equal(f.get('army-turn').textContent,'观战中');assert.match(f.get('army-feedback').textContent,/观战中/);
  for(const id of ['ready-button','start-room','rematch','pause-room','resume-room-menu','resume-room','take-host','host-transfer-controls','army-offer-draw','army-resign','army-draw-offer'])assert.equal(f.get(id).hidden,true,id);
  for(const type of ['flip','move','resign','offer-draw','accept-draw','decline-draw','ready','start','pause','resume','transferHost','rematch','set-role'])assert.equal(await f.pageAPI.action(type,{cellId:'r0c1',role:'player'}),false,type);
  f.pageAPI.click('r0c1');f.get('army-resign').dispatchEvent(new Event('click'));await settle();
  assert.equal(f.get('army-resign-dialog').open,false);assert.equal(f.calls.filter(call=>call.options.method==='POST').length,0);
  assert.match(f.get('army-spectator-note').textContent,/观战 1\/8.*原朋友/);
});

test('army spectator exit clearly leaves only watching and sends one common leave action',async t=>{
  const f=await fixture(t);const observer=spectatorView();observer.revision=2;f.push(observer);await settle();
  f.get('leave-room').dispatchEvent(new Event('click'));assert.equal(f.get('leave-room-dialog').open,true);
  assert.match(f.get('leave-room-explanation').textContent,/只结束你的观战.*不影响/);
  assert.doesNotMatch(f.get('leave-room-explanation').textContent,/会中止|释放席位/);
  f.setAction(()=>json({left:true,destroyed:false}));f.get('confirm-leave-room').dispatchEvent(new Event('click'));await settle();
  const actions=f.calls.filter(call=>call.url.endsWith('/actions'));assert.equal(actions.length,1);
  assert.equal(JSON.parse(actions[0].options.body).type,'leave');assert.equal(f.location.href,'./');
});

test('waiting army spectator may request a free player seat while a full table disables that option',async t=>{
  const f=await fixture(t);const waiting=spectatorView('waiting');waiting.revision=2;f.push(waiting);await settle();
  assert.equal(f.get('army-switch-role').hidden,false);assert.equal(f.get('army-switch-role').textContent,'入座下棋');
  assert.equal(f.get('army-switch-role').disabled,true);
  waiting.players.pop();waiting.revision=3;f.setView(waiting);f.push(waiting);await settle();
  assert.equal(f.get('army-switch-role').disabled,false);
  const seated={...waiting,revision:4,selfRole:'player',spectators:[],players:[...waiting.players,{id:'self',name:'原朋友',ready:false,connected:true}]};
  f.setAction(options=>{const body=JSON.parse(options.body);assert.equal(body.type,'set-role');assert.equal(body.role,'player');return json({view:seated});});
  f.get('army-switch-role').dispatchEvent(new Event('click'));await settle();
  assert.equal(f.pageAPI.view().selfId,'self');assert.equal(f.pageAPI.view().selfRole,'player');
  assert.equal(f.get('ready-button').hidden,false);assert.equal(f.get('army-switch-role').textContent,'改为观战');
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,1);
});

test('spectator background and identity failures erase spectator names and recover the same observer membership',async t=>{
  const f=await fixture(t);const observer=spectatorView();observer.revision=2;f.setView(observer);f.push(observer);await settle();
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.get('army-cells').children.length,0);assert.equal(f.get('army-spectator-note').textContent,'');
  f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await settle();
  assert.equal(f.pageAPI.view().selfId,'self');assert.equal(f.pageAPI.view().selfRole,'spectator');
  assert.ok(f.get('army-cells').children.every(cell=>cell.disabled));
  f.deferState({promise:Promise.resolve(json({message:'revoked'},401))});f.timers.tick(15000);await settle();
  assert.equal(f.get('army-cells').children.length,0);assert.equal(f.get('army-spectator-note').textContent,'');
  assert.ok(f.calls.every(call=>(call.options.method??'GET')==='GET'));
});
