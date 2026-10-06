import * as entryPath from './entry-path.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as rules from './rules.mjs';
import * as presentation from './game-presentation.mjs';
import * as lobbyModel from './lobby-model.mjs';
import * as gameRouting from './game-routing.mjs';
import * as rummiFeedback from './rummikub-feedback.mjs';
import * as rummiAssist from './rummikub-assist.mjs';
import * as rackLayout from './rack-layout.mjs';
const tableLayout=await import(jokerRegressionSource('table-layout.mjs'));
import * as viewport from './game-viewport.mjs';
import { createGameAudio } from './game-audio.mjs';
import { createRoomStore } from './rooms.mjs';
import { createRoomPreview } from '../server/room-preview.mjs';
import * as armyBoard from './army-board.mjs';
import * as armyPresentation from './army-presentation.mjs';
import * as armyPractice from './army-practice-engine.mjs';

const USER='a'.repeat(64),OTHER='b'.repeat(64),CODE='123456';
// Reproduce an installed release without changing the maintained application.
// The page, table geometry and CSS use the optional frozen-source override.
function jokerRegressionSource(file) {
  const root=process.env.GAME_ROOM_UI_TEST_SOURCE_ROOT??process.env.GAME_ROOM_JOKER_TEST_SOURCE_ROOT;
  return root?new URL(file,pathToFileURL(root.replace(/\/$/,'')+'/')):new URL(file,import.meta.url);
}
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
// Frames normally stay dormant. Drag-specific tests explicitly advance one frame
// to exercise the actual page geometry and pointer handlers without a browser.
function dom(html) {
  const nodes=new Map();let document;
  class Node extends EventTarget {
    constructor(tag='div'){super();this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes={};this.dataset={};this.hidden=false;this.disabled=false;this.value='';this.open=false;this._text='';this._class='';this.style={setProperty(name,value){this[name]=String(value);}};this.capturedPointers=new Set();
      Object.defineProperty(this.attributes,Symbol.iterator,{value:function*(){for(const [name,value]of Object.entries(this))yield {name,value};}});
      this.classList={contains:name=>this._class.split(/\s+/).includes(name),toggle:(name,force)=>{
        const set=new Set(this._class.split(/\s+/).filter(Boolean)),enabled=force??!set.has(name);enabled?set.add(name):set.delete(name);this._class=[...set].join(' ');return enabled;
      },add:(...names)=>names.forEach(name=>this.classList.toggle(name,true)),remove:(...names)=>names.forEach(name=>this.classList.toggle(name,false))};}
    set id(value){this.attributes.id=value;nodes.set(value,this);}get id(){return this.attributes.id;}
    set className(value){this._class=value;}get className(){return this._class;}
    set textContent(value){this._text=String(value);for(const child of this.children)child.parentNode=null;this.children=[];}get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
    set innerHTML(value){this._text='';for(const child of this.children)child.parentNode=null;this.children=[];parse(value,this);}get innerHTML(){return this.textContent;}
    setAttribute(name,value){value=String(value);this.attributes[name]=value;if(name==='id')this.id=value;if(name==='class')this.className=value;if(name==='hidden')this.hidden=true;if(name==='disabled')this.disabled=true;
      if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;}
    getAttribute(name){return this.attributes[name]??null;}removeAttribute(name){delete this.attributes[name];if(name==='hidden')this.hidden=false;
      if(name.startsWith('data-'))delete this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())];}
    append(...values){for(const value of values){const node=typeof value==='string'?Object.assign(new Node('span'),{textContent:value}):value;node.parentNode=this;this.children.push(node);}}
    appendChild(node){this.append(node);return node;}replaceChildren(...values){this.textContent='';this.append(...values);}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}
    get isConnected(){return this===document.documentElement || Boolean(this.parentNode?.isConnected);}
    setPointerCapture(id){this.capturedPointers.add(id);}hasPointerCapture(id){return this.capturedPointers.has(id);}releasePointerCapture(id){this.capturedPointers.delete(id);}
    cloneNode(deep=false){const copy=new Node(this.tagName);for(const [name,value]of Object.entries(this.attributes))copy.setAttribute(name,value);copy.className=this.className;copy._text=this._text;
      Object.assign(copy.style,this.style);if(deep)for(const child of this.children)copy.append(child.cloneNode(true));return copy;}
    matches(selector){if(selector.includes(','))return selector.split(',').some(part=>this.matches(part.trim()));if(selector==='*')return true;if(selector.startsWith('#'))return this.id===selector.slice(1);
      const classes=[...selector.matchAll(/\.([\w-]+)/g)].map(match=>match[1]);if(classes.some(name=>!this.classList.contains(name)))return false;
      const tag=selector.match(/^[\w-]+/)?.[0];if(tag && this.tagName!==tag.toUpperCase())return false;
      for(const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g))if(!Object.hasOwn(this.attributes,match[1]) || match[2]!==undefined && this.attributes[match[1]]!==match[2])return false;
      return Boolean(tag || classes.length || selector.includes('['));}
    querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
    querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
    closest(selector){return this.matches(selector)?this:this.parentNode?.closest(selector)??null;}
    showModal(){this.open=true;}close(){this.open=false;}focus(){document.activeElement=this;}blur(){if(document.activeElement===this)document.activeElement=document.body;}
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
  // Imported helpers derive their mount from the module URL in a real browser.
  // A VM must provide that same URL instead of accidentally using this test's
  // local file: URL, which would silently turn mounted-entry checks into root.
  Object.assign(context, {
    entryBase:(url=context.__entryModuleUrl)=>entryPath.entryBase(url),
    gamePath:(path='/',url=context.__entryModuleUrl)=>entryPath.gamePath(path,url),
    entryStorageKey:(key,url=context.__entryModuleUrl)=>entryPath.entryStorageKey(key,url),
  });
  const source=await readFile(file==='app.mjs'?jokerRegressionSource(file):new URL(file,import.meta.url),'utf8');
  const names=[...source.matchAll(/^export (?:async )?(?:function|class|const)\s+(\w+)/gm)].map(match=>match[1]);
  const code=source.replace(/^import[\s\S]*?;\s*/gm,'').replace(/^export /gm,'');
  return vm.runInContext(`(async()=>{${code}\n${extra}\nreturn {${names.join(',')}};})()`,context,{filename:file});
}
function roomView(user=USER) {
  const practice=rules.createPracticeState(),self=user===USER?'self':'other';
  return {roomCode:CODE,roomId:'synthetic-room',selfId:self,hostId:self,revision:1,matchId:'synthetic-match',phase:'playing',pause:null,
    players:[{id:self,name:user===USER?'原朋友':'新朋友',connected:true,ready:true},{id:'friend',name:'伙伴',connected:true,ready:true}],
    game:{rack:practice.rack,board:practice.board,opened:true,round:2,revision:1,status:'playing',turnPlayerId:self,ruleVersion:'friends-v2',copies:2,jokerCount:2,poolCount:69,
      players:[{id:self,rackCount:14},{id:'friend',rackCount:14}]}};
}
async function fixture(t,{page='room',query='',state=AUTH,history,initialView,initialPreview,seedSession,practiceGame,audioContext,geometry=false,mount='/',origin='http://127.0.0.1'}={}) {
  const document=dom(await readFile(new URL(page==='lobby'?'index.html':`${page}.html`,import.meta.url),'utf8'));
  if(page==='lobby') document.getElementById('create-game').value='rummikub';
  const window=new EventTarget(),timers=clock(),sessionStorage=storage(),localStorage=storage();
  const location={hostname:'127.0.0.1',search:['room','army'].includes(page)?`?code=${CODE}${query}`:query,href:`${origin}${mount}${['room','army'].includes(page)?`${page}.html?code=${CODE}`:page==='lobby'?'':`${page}.html`}${query}`,
    replace(url){this.replaced=url;},assign(url){this.assigned=url;}};
  const calls=[],streams=[],watchers=[],audioCalls=[],frames=new Map();let frameId=0,nextState=state,stateResponse=null,roomResponse=null,nextView=initialView??roomView(state.userKey),actionResponse=null;
  for(const [key,value] of seedSession??[])sessionStorage.setItem(key,value);
  if(practiceGame)localStorage.setItem(armyPractice.PRACTICE_STORAGE_KEY,armyPractice.encodePractice(practiceGame,'audio-practice'));
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(mount==='/game/' && url.startsWith('/game/')) url=url.slice('/game'.length);
    if(url==='/api/state')return stateResponse?stateResponse().then(response=>response.clone()):json(nextState);
    if(url.startsWith('/api/history'))return history?history().then(response=>response.clone()):json({items:[],stats:{},retentionDays:180});
    if(/\/events(?:\?preview=1)?$/.test(url)) {
      let controller;const body=new ReadableStream({start(value){controller=value;}});
      const record={signal:options.signal,controller};streams.push(record);
      options.signal?.addEventListener('abort',()=>{try{controller.close();}catch{}});
      return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
    }
    if(url.endsWith('/actions'))return actionResponse?actionResponse(options):json({view:nextView});
    if(url.endsWith('/preview'))return json({ok:true,minIntervalMs:1000,nextAllowedAt:0});
    if(url.includes('/chat'))return json({roomId:'synthetic-room',messages:[],hasOlder:false});
    if(url===`/api/rooms/${CODE}`)return roomResponse?roomResponse.promise.then(response=>response.clone()):json({view:nextView});
    if(url==='/auth/logout')return json({ok:true});
    throw new Error(`Unexpected synthetic request: ${url}`);
  };
  document.defaultView=window;window.navigator={userActivation:{isActive:true}};
  Object.assign(window,{innerWidth:844,innerHeight:390,visualViewport:null,setInterval:()=>0,clearInterval(){}});
  const context=vm.createContext({document,window,location,navigator:{},sessionStorage,localStorage,fetch,URL,URLSearchParams,Response,ReadableStream,TextDecoder,TextEncoder,
    __entryModuleUrl:`${origin}${mount}entry-path.mjs`,
    AbortController,DOMException,Event,EventTarget,structuredClone,performance,crypto,innerWidth:844,innerHeight:390,
    setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,setInterval:()=>0,clearInterval(){},queueMicrotask,requestAnimationFrame:callback=>{if(!geometry)return 0;const id=++frameId;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id),
    getComputedStyle:()=>({paddingLeft:'8',paddingRight:'8',paddingTop:'8',paddingBottom:'8'}),
    ...rules,...presentation,...lobbyModel,...gameRouting,...rummiFeedback,...rummiAssist,...rackLayout,...tableLayout,...viewport,...armyBoard,...armyPresentation,...armyPractice,
    paginateInspector:presentation.inspectorPages,
    createPracticeSession:options=>armyPractice.createPracticeSession({...options,setTimer:timers.setTimeout,clearTimer:timers.clearTimeout,withLock:callback=>Promise.resolve().then(callback),randomInt:max=>max-1}),
    createGameAudio(options) {const audio=createGameAudio({...options,storage:localStorage,document,window,AudioContext:audioContext,setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout});return {...audio,play(kind,fields){audioCalls.push(kind);return audio.play(kind,fields);}};}});
  const account=await moduleIn(context,'account-client.mjs');Object.assign(context,account);
  context.watchAccountLifecycle=(options)=>{const watcher=account.watchAccountLifecycle(options);watchers.push(watcher);return watcher;};
  Object.assign(context,await moduleIn(context,'room-client.mjs'));
  Object.assign(context,await moduleIn(context,'room-chat.mjs'));
  Object.assign(context,await moduleIn(context,'rummikub-preview-client.mjs'));
  let pageAPI;
  if(page==='room' || page==='practice') {
    context.expose=(value)=>{pageAPI=value;};
    await moduleIn(context,'app.mjs','expose({draft:()=>structuredClone(draft),client:()=>roomClient,busy:()=>busy,move:(ids,zone="new",before=null,point=null)=>moveTiles(Array.isArray(ids)?ids:[ids],zone,before,point),rackPositions:()=>structuredClone(rackPositions),rackBasis:()=>structuredClone(rackBasis),rackLayout:()=>structuredClone(rackLayout),rackOrder:()=>[...rackOrder],view:()=>structuredClone(roomView),committed:()=>structuredClone(committed),canAct,captureBoardPositions,captureCommittedBoardPositions,tablePoints:()=>structuredClone(tablePositions),tableFit:()=>structuredClone(tableLayout),remote:()=>structuredClone(remotePreview),feedback:()=>structuredClone(turnFeedbackState),newIds:()=>[...newSinceOwnTurn],groups:()=>structuredClone(playableRackGroups),sortMode:()=>sortMode,select:(id)=>selection.add(id),selected:()=>[...selection],drag:()=>drag,setDrag:(value)=>{drag=value;},sort:arrangePlayableRack,render,clear:clearRoomPrivate,action:roomAction});');
  }else if(page==='army' || page==='army-practice') {
    context.expose=value=>{pageAPI=value;};
    await moduleIn(context,page==='army'?'army-room.mjs':'army-practice.mjs',page==='army'
      ?'expose({view:()=>structuredClone(view),selected:()=>selected,click:clickCell,client:()=>client,action});'
      :'expose({view:()=>structuredClone(view),selected:()=>selected,click:clickCell,suspend:()=>session.suspend()});');
    if(page==='army-practice')t.after(()=>pageAPI.suspend());
  }else await moduleIn(context,'lobby.mjs');
  t.after(()=>watchers.forEach(watcher=>watcher.stop()));await settle();
  if(['room','army'].includes(page) && streams.length){streams.at(-1).controller.enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify({view:nextView})}\n\n`));await settle();
    if(page==='room' && nextView.game){streams.at(-1).controller.enqueue(new TextEncoder().encode(`event: preview\ndata: ${JSON.stringify(initialPreview??clearPreviewPacket(nextView))}\n\n`));await settle();}}
  return {account,document,window,timers,sessionStorage,calls,streams,pageAPI,location,audioCalls,
    frame(){const batch=[...frames];frames.clear();for(const [,callback]of batch)callback();},
    setView(value){nextView=structuredClone(value);},setAction(handler){actionResponse=handler;},
    receive(value){nextView=structuredClone(value);pageAPI.client().receive(value);},
    async event(type,value){streams.at(-1).controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`));await settle();},
    setState(value){nextState=value;stateResponse=null;},deferState(value){stateResponse=()=>value.promise;},
    deferRoom(value){roomResponse=value;},
    get(id){return document.getElementById(id);}};
}

const LOOKUP=new Map(rules.createDeck({copies:3,jokerCount:3}).map(tile=>[tile.id,tile]));
const tiles=ids=>ids.map(id=>structuredClone(LOOKUP.get(id)));
function tableView({board=[['red-4-a','red-5-a','red-6-a']],rack=['red-7-a','red-9-a','black-13-a'],turn='self',revision=1,ruleVersion='friends-v2',copies=2,jokerCount=2,...fields}={}) {
  const view=roomView();Object.assign(view,{gameType:'rummikub',minPlayers:2,maxPlayers:7,...fields});
  view.game={...view.game,board:board.map(tiles),rack:tiles(rack),turnPlayerId:turn,revision,round:revision,ruleVersion,copies,jokerCount,
    players:[{id:'self',name:'原朋友',rackCount:rack.length},{id:'friend',name:'伙伴',rackCount:10}]};
  view.revision=revision;return view;
}
const plain=value=>JSON.parse(JSON.stringify(value));
const tileNode=(f,id)=>f.document.querySelector(`[data-tile="${id}"]`);
function twistView({board=[['blue-1-a','blue-2-a','blue-3-a']],rack=['black-2-a','joker-double-1','black-5-a','blue-4-a','joker-color-change-1','red-6-a','red-7-a','joker-mirror-1','red-7-b','joker-normal-1','orange-13-a'],jokerConfig={normal:1,mirror:1,colorChange:1,double:1}}={}) {
  const copies=3,jokerCount=Object.values(jokerConfig).reduce((sum,n)=>sum+n,0),deck=rules.createDeck({copies,jokerConfig}),lookup=new Map(deck.map(tile=>[tile.id,tile]));
  const make=names=>names.map(id=>{assert.ok(lookup.has(id),id);return structuredClone(lookup.get(id));});
  const view=tableView();view.jokerConfig=structuredClone(jokerConfig);
  Object.assign(view.game,{ruleVersion:'friends-v3',copies,deckCopies:copies,jokerCount,jokerConfig:structuredClone(jokerConfig),tileCount:deck.length,deckSize:deck.length,
    rack:make(rack),board:board.map(make),poolCount:deck.length-rack.length-board.flat().length-10});
  view.game.players[0].rackCount=rack.length;return view;
}

test('actual v3 colour/number controls sort legal physical combinations and preserve four typed joker resources without writes',async t=>{
  const view=twistView(),f=await fixture(t,{initialView:view}),before=plain(f.pageAPI.committed());
  assert.deepEqual(before.jokerConfig,view.game.jokerConfig);
  assert.equal(before.rack.length+before.pool.length+before.board.flat().length,160);
  assert.equal(rules.stateProblem(before,true,{copies:3,jokerConfig:view.game.jokerConfig}),null);
  const ruleOptions={copies:3,jokerCount:4,maxJokers:4,jokerConfig:view.game.jokerConfig,ruleVersion:'friends-v3'};
  for(const control of ['sort-color','sort-number']) {
    f.get(control).dispatchEvent(new Event('click'));await settle();
    const groups=plain(f.pageAPI.groups()),order=plain(f.pageAPI.rackOrder());
    assert.ok(groups.length>0);assert.ok(groups.every(group=>rules.validateMeld(group,ruleOptions).valid));
    assert.equal(new Set(groups.flat().map(tile=>tile.id)).size,groups.flat().length);
    assert.deepEqual(order.toSorted(),view.game.rack.map(tile=>tile.id).toSorted());
    for(const [type,label]of [['normal','传统百搭'],['mirror','镜像百搭'],['color-change','变色百搭'],['double','双重百搭']]) {
      const node=tileNode(f,`joker-${type}-1`);assert.ok(node);assert.equal(node.dataset.jokerType,type);assert.match(node.getAttribute('aria-label'),new RegExp(label));
      assert.ok(node.querySelector('img.joker-art'));
    }
    assert.deepEqual(plain(f.pageAPI.committed()),before);
  }
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});

test('actual v3 local draft refresh reconstructs canonical types and fixed config while retaining mirror physical order',async t=>{
  const view=twistView(),f=await fixture(t,{initialView:view});
  f.get('sort-color').dispatchEvent(new Event('click'));await settle();
  f.pageAPI.move(['red-7-a','joker-mirror-1','red-7-b']);
  const draft=plain(f.pageAPI.draft()),seedSession=[...f.sessionStorage.values];
  assert.deepEqual(draft.board.at(-1).map(tile=>tile.id),['red-7-a','joker-mirror-1','red-7-b']);
  const fresh=await fixture(t,{initialView:view,seedSession});
  assert.deepEqual(plain(fresh.pageAPI.draft()),draft);
  assert.deepEqual(plain(fresh.pageAPI.committed().jokerConfig),view.game.jokerConfig);
  assert.equal(fresh.pageAPI.draft().board.at(-1)[1].jokerType,'mirror');
  assert.equal(tileNode(fresh,'joker-mirror-1').dataset.jokerType,'mirror');
  assert.equal(rules.evaluateDraft(plain(fresh.pageAPI.committed()),plain(fresh.pageAPI.draft()),{copies:3,jokerConfig:view.game.jokerConfig}).valid,true);
  assert.equal(fresh.pageAPI.canAct(),true);assert.equal(fresh.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});

test('actual v3 retains ordinary duplicate-pivot automatic splitting with the configured full deck',async t=>{
  const view=twistView({board:[['red-4-a','red-5-a','red-6-a','red-7-a','red-8-a']],rack:['red-6-b','black-13-a']}),f=await fixture(t,{initialView:view});
  f.pageAPI.move('red-6-b','0');const draft=plain(f.pageAPI.draft());
  assert.deepEqual(draft.board.map(group=>group.map(tile=>tile.id)),[['red-4-a','red-5-a','red-6-a'],['red-6-b','red-7-a','red-8-a']]);
  assert.equal(rules.evaluateDraft(plain(f.pageAPI.committed()),draft,{copies:3,jokerConfig:view.game.jokerConfig}).valid,true);
  assert.equal(f.get('commit').disabled,false);assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});

test('actual hand tiles drop at arbitrary xy while another player acts; private placement never changes the hand or public preview',async t=>{
  const view=tableView({turn:'friend'}),f=await fixture(t,{initialView:view,geometry:true});f.frame();
  const before=plain(f.pageAPI.draft()),committed=plain(f.pageAPI.committed()),order=plain(f.pageAPI.rackOrder());
  f.pageAPI.move('red-9-a','rack',null,{rackX:402.75,rackY:66.5,grabX:0,grabY:0,anchorId:'red-9-a'});f.frame();
  const tile=f.pageAPI.rackLayout().rects.find(rect=>rect.id==='red-9-a');
  assert.ok(Math.abs(tile.x-402.75)<1e-6);assert.ok(Math.abs(tile.y-66.5)<1e-6);
  assert.deepEqual(plain(f.pageAPI.rackOrder()),order);assert.deepEqual(plain(f.pageAPI.draft()),before);
  assert.deepEqual(plain(f.pageAPI.committed()),committed);assert.equal(f.pageAPI.sortMode(),'manual');
  const saved=JSON.parse([...f.sessionStorage.values.values()].find(value=>value.includes('rackPositions')));
  assert.deepEqual(saved.rackPositions,plain(f.pageAPI.rackPositions()));
  f.timers.tick(1000);await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/actions') || call.url.endsWith('/preview')).length,0);
});
test('actual hand placement refreshes from this identity and match only; one-click sorting clears manual positions',async t=>{
  const view=tableView(),f=await fixture(t,{initialView:view,geometry:true});f.frame();
  f.pageAPI.move('red-7-a','rack',null,{rackX:66,rackY:45,grabX:0,grabY:0});f.frame();
  const remembered=plain(f.pageAPI.rackPositions()),seedSession=[...f.sessionStorage.values];
  const restored=await fixture(t,{initialView:view,seedSession,geometry:true});restored.frame();
  assert.deepEqual(plain(restored.pageAPI.rackPositions()),remembered);
  const other=await fixture(t,{initialView:tableView({matchId:'another-match'}),seedSession,geometry:true});other.frame();
  assert.deepEqual(plain(other.pageAPI.rackPositions()),{});
  for(const control of ['sort-color','sort-number']) {
    restored.get(control).dispatchEvent(new Event('click'));restored.frame();
    assert.deepEqual(plain(restored.pageAPI.rackPositions()),{});assert.equal(restored.pageAPI.rackLayout().manual,false);
    assert.deepEqual(plain(restored.pageAPI.rackOrder()).toSorted(),view.game.rack.map(tile=>tile.id).toSorted());
  }
});
test('actual hand geometry rotation preserves normalized free placement and never scrolls or drops tile IDs',async t=>{
  const f=await fixture(t,{initialView:tableView({turn:'friend'}),geometry:true});f.frame();
  f.pageAPI.move('red-9-a','rack',null,{rackX:480,rackY:57,grabX:0,grabY:0});f.frame();
  const positions=plain(f.pageAPI.rackPositions());let width=280,height=180;
  Object.defineProperties(f.get('rack'),{clientWidth:{get:()=>width},clientHeight:{get:()=>height}});
  for(const dimensions of [[280,180],[900,135],[280,180]]) {
    [width,height]=dimensions;f.window.dispatchEvent(new Event('resize'));f.frame();
    assert.deepEqual(plain(f.pageAPI.rackPositions()),positions);
    const layout=f.pageAPI.rackLayout();assert.equal(layout.rects.length,3);
    for(const rect of layout.rects){assert.ok(rect.x>=0 && rect.y>=0);assert.ok(rect.x+rect.width<=layout.width+1e-6);assert.ok(rect.y+rect.height<=layout.height+1e-6);}
  }
});
test('actual new draw and unsubmitted returned tile find free spaces without rearranging remembered hand tiles',async t=>{
  const original=tableView(),f=await fixture(t,{initialView:original,geometry:true});f.frame();
  f.pageAPI.move('red-9-a','rack',null,{rackX:470,rackY:62,grabX:0,grabY:0});f.frame();
  const before=plain(f.pageAPI.rackPositions());
  const drawn=tableView({rack:['red-7-a','red-9-a','black-13-a','blue-2-a'],revision:2});f.receive(drawn);f.frame();
  for(const id of original.game.rack.map(tile=>tile.id))assert.deepEqual(plain(f.pageAPI.rackPositions()[id]),before[id]);
  assert.ok(f.pageAPI.rackPositions()['blue-2-a']);
  f.pageAPI.move('red-7-a','0');f.frame();assert.equal(f.pageAPI.rackPositions()['red-7-a'],undefined);
  const retained=plain(f.pageAPI.rackPositions());f.pageAPI.move('red-7-a','rack');f.frame();
  assert.ok(f.pageAPI.rackPositions()['red-7-a']);
  for(const [id,point]of Object.entries(retained))assert.deepEqual(plain(f.pageAPI.rackPositions()[id]),point);
  assert.deepEqual(f.pageAPI.draft().rack.map(tile=>tile.id).toSorted(),drawn.game.rack.map(tile=>tile.id).toSorted());
});
test('actual pointer group drop keeps spatial spacing and a cancelled drag never commits new private positions',async t=>{
  const f=await fixture(t,{initialView:tableView({turn:'friend'}),geometry:true});f.frame();
  f.pageAPI.select('red-7-a');f.pageAPI.select('red-9-a');f.pageAPI.render();f.frame();
  const layout=f.pageAPI.rackLayout(),a=layout.rects[0],b=layout.rects[1],tile=tileNode(f,'red-9-a');
  tile.getBoundingClientRect=()=>({left:b.x+8,top:b.y+8,width:b.width,height:b.height,right:b.x+8+b.width,bottom:b.y+8+b.height});
  f.document.elementFromPoint=()=>f.get('rack');
  pointer(f,'pointerdown',tile,{x:b.x+11,y:b.y+11});pointer(f,'pointermove',tile,{x:390,y:75});
  const before=plain(f.pageAPI.rackPositions());pointer(f,'pointercancel',tile);f.frame();assert.deepEqual(plain(f.pageAPI.rackPositions()),before);
  const again=tileNode(f,'red-9-a');again.getBoundingClientRect=tile.getBoundingClientRect;
  pointer(f,'pointerdown',again,{x:b.x+11,y:b.y+11});pointer(f,'pointermove',again,{x:390,y:75});pointer(f,'pointerup',again,{x:390,y:75});f.frame();
  const next=f.pageAPI.rackLayout(),nextA=next.rects.find(rect=>rect.id===a.id),nextB=next.rects.find(rect=>rect.id===b.id);
  assert.ok(Math.abs(nextB.x-nextA.x-(b.x-a.x))<1e-6);assert.ok(Math.abs(nextB.y-nextA.y-(b.y-a.y))<1e-6);
  assert.equal(f.pageAPI.selected().length,0);assert.equal(f.document.querySelectorAll('.drag-ghost').length,0);
});
test('actual private hand positions are erased on 401, explicit logout and a switch to spectator',async t=>{
  for(const cause of ['401','logout','spectator']) {
    const f=await fixture(t,{initialView:tableView(),geometry:true});f.frame();
    f.pageAPI.move('red-7-a','rack',null,{rackX:120,rackY:50,grabX:0,grabY:0});f.frame();assert.ok(Object.keys(f.pageAPI.rackPositions()).length);
    if(cause==='spectator')f.receive(watcherView());
    else if(cause==='logout'){await f.account.logoutAccount();await settle();}
    else{f.deferState({promise:Promise.resolve(json({error:'SESSION_EXPIRED'},401))});f.timers.tick(15000);await settle();}
    assert.deepEqual(plain(f.pageAPI.rackPositions()),{});assert.equal(f.get('rack').children.length,0);
    assert.ok(![...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
  }
});

async function lateBusinessWrite(t,status) {
  const original=tableView(),f=await fixture(t,{initialView:original}),old=deferred(),current=deferred(),oldClient=f.pageAPI.client();let writes=0;
  f.setAction(()=>writes++===0?old.promise:current.promise);
  const oldWrite=f.pageAPI.action('draw');await settle();assert.equal(f.pageAPI.busy(),true);
  const replacement=roomView(OTHER);replacement.gameType='rummikub';
  f.setView(replacement);f.setState({...AUTH,userKey:OTHER,csrf:'different-csrf',profile:{nickname:'新朋友'}});
  f.timers.tick(15000);await settle();
  assert.equal(oldClient.stopped,true);assert.notEqual(f.pageAPI.client(),oldClient);assert.equal(f.pageAPI.canAct(),true);
  const newWrite=f.pageAPI.action('draw');await settle();assert.equal(f.pageAPI.busy(),true);assert.equal(f.pageAPI.canAct(),false);
  const before=plain(f.pageAPI.draft()),cues=[...f.audioCalls],toast=f.get('toast').textContent;
  old.resolve(status===200?json({view:original}):json({message:'旧账号操作失败，不应出现'},status));
  assert.equal(await oldWrite,false);await settle();
  assert.equal(f.pageAPI.busy(),true,'old finally cannot unlock the new pending write');
  assert.equal(f.pageAPI.canAct(),false);assert.deepEqual(plain(f.pageAPI.draft()),before);
  assert.deepEqual(f.audioCalls,cues);assert.equal(f.get('toast').textContent,toast);
  assert.equal(f.account.accountState().userKey,OTHER);assert.equal(f.account.accountState().verification,'verified');
  assert.equal(writes,2,'no business write may be replayed');
  const finished=structuredClone(replacement);finished.revision++;finished.game.revision++;finished.game.round++;finished.game.turnPlayerId='friend';
  finished.game.rack.push(structuredClone(LOOKUP.get('red-4-a')));finished.game.players[0].rackCount++;
  current.resolve(json({view:finished}));assert.equal(await newWrite,true);await settle();
  assert.equal(f.pageAPI.busy(),false);assert.equal(f.pageAPI.view().selfId,'other');
  assert.equal(f.audioCalls.filter(cue=>cue==='draw').length,cues.filter(cue=>cue==='draw').length+1);
}
test('actual old accepted write arriving after account replacement cannot clear a new write busy state or speak',async t=>lateBusinessWrite(t,200));
test('actual old failed write arriving after account replacement cannot toast, invalidate the new account or clear its pending write',async t=>lateBusinessWrite(t,503));

test('real page retains friend-new badges and sustained own-turn styling through metadata, sorting and until own completion',async t=>{
  const first=tableView(),f=await fixture(t,{initialView:first});
  const ownPassed=tableView({board:[['red-4-a','red-5-a','red-6-a','red-7-a']],rack:['red-9-a','black-13-a'],turn:'friend',revision:2});
  f.receive(ownPassed);assert.deepEqual(plain(f.pageAPI.newIds()),[]);
  const friendPassed=tableView({board:[['red-4-a','red-5-a','red-6-a','red-7-a','red-8-a']],rack:['red-9-a','black-13-a'],revision:3});
  f.receive(friendPassed);
  assert.deepEqual(plain(f.pageAPI.newIds()),['red-8-a']);
  assert.ok(tileNode(f,'red-8-a').classList.contains('tile-new-since-turn'));
  assert.match(f.get('turn-banner').textContent,/轮到你了.*朋友新出了 1/);
  assert.equal(f.document.body.classList.contains('rummi-own-turn'),true);
  f.timers.tick(9000);f.pageAPI.sort('color');
  assert.equal(tileNode(f,'red-8-a').classList.contains('tile-new-since-turn'),true);
  assert.equal(f.document.body.classList.contains('rummi-own-turn'),true);
  const boardNode=f.get('board').children[0],drag={active:false,type:'tile',ids:['red-9-a'],element:tileNode(f,'red-9-a')};
  f.pageAPI.select('red-9-a');f.pageAPI.setDrag(drag);
  const meta={...friendPassed,revision:4,players:friendPassed.players.map(p=>({...p,connected:false}))};
  f.receive(meta);
  assert.equal(f.get('board').children[0],boardNode);assert.equal(f.pageAPI.drag(),drag);
  assert.deepEqual(plain(f.pageAPI.selected()),['red-9-a']);assert.deepEqual(plain(f.pageAPI.newIds()),['red-8-a']);
  const done=tableView({board:[['red-4-a','red-5-a','red-6-a','red-7-a','red-8-a','red-9-a']],rack:['black-13-a'],turn:'friend',revision:4});
  done.revision=5;f.receive(done);
  assert.deepEqual(plain(f.pageAPI.newIds()),[]);assert.equal(f.document.body.classList.contains('rummi-own-turn'),false);
});

test('same-match refresh and 503 preserve new badges while verified identity change erases them and old private draft',async t=>{
  const first=tableView({turn:'friend'}),f=await fixture(t,{initialView:first});
  const second=tableView({board:[['red-4-a','red-5-a','red-6-a','red-7-b']],revision:2});f.receive(second);
  assert.deepEqual(plain(f.pageAPI.newIds()),['red-7-b']);
  const seed=[...f.sessionStorage.values],fresh=await fixture(t,{initialView:second,seedSession:seed});
  assert.deepEqual(plain(fresh.pageAPI.newIds()),['red-7-b']);
  assert.match(fresh.get('turn-banner').textContent,/朋友新出了 1/);assert.deepEqual(fresh.audioCalls,[]);
  f.deferState({promise:Promise.resolve(json({message:'unavailable'},503))});f.timers.tick(15000);await settle();
  assert.equal(f.get('board').children.length,0);assert.equal(f.get('turn-banner').textContent,'');
  assert.deepEqual(plain(f.pageAPI.newIds()),[]);
  f.setState(AUTH);f.timers.tick(15000);await settle();
  assert.deepEqual(plain(f.pageAPI.newIds()),['red-7-b']);assert.ok(tileNode(f,'red-7-b').classList.contains('tile-new-since-turn'));
  const next=roomView(OTHER);next.gameType='rummikub';f.setView(next);
  f.setState({...AUTH,userKey:OTHER,profile:{nickname:'新朋友'},csrf:'other-csrf'});f.timers.tick(15000);await settle();
  assert.deepEqual(plain(f.pageAPI.newIds()),[]);assert.equal(f.get('board').querySelectorAll('.tile-new-since-turn').length,0);
  assert.ok(![...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
});

test('unknown completed full cycle never calls your formerly owned played card a friend-new card',async t=>{
  const f=await fixture(t,{initialView:tableView()});
  const saved=[...f.sessionStorage.values];
  const recovered=tableView({board:[['red-4-a','red-5-a','red-6-a','red-7-a','red-8-a']],rack:['red-9-a','black-13-a'],revision:3});
  const restored=await fixture(t,{initialView:recovered,seedSession:saved});
  assert.deepEqual(plain(restored.pageAPI.newIds()),['red-8-a']);
  assert.equal(tileNode(restored,'red-7-a').classList.contains('tile-new-since-turn'),false);
  assert.equal(tileNode(restored,'red-8-a').classList.contains('tile-new-since-turn'),true);
  assert.match(restored.get('turn-banner').textContent,/恢复后新增 1 张牌/);
  assert.doesNotMatch(restored.get('turn-banner').textContent,/朋友新出了/);
  assert.match(tileNode(restored,'red-8-a').getAttribute('aria-label'),/恢复后新增的牌/);
  assert.doesNotMatch(tileNode(restored,'red-8-a').getAttribute('title'),/朋友新出的牌/);
  assert.deepEqual(restored.audioCalls,[]);
});

test('actual sort buttons place complete disjoint own-hand melds first, and manual rack movement clears the visual suggestion',async t=>{
  const rack=['black-13-a','red-6-b','red-4-b','blue-10-a','red-5-b','black-10-a','orange-10-a','blue-1-a'];
  const f=await fixture(t,{initialView:tableView({rack})});
  f.get('sort-color').dispatchEvent(new Event('click'));
  const groups=plain(f.pageAPI.groups()),order=plain(f.pageAPI.rackOrder());
  assert.equal(groups.length,2);const grouped=groups.flat().map(tile=>tile.id);
  assert.deepEqual(order.slice(0,grouped.length),grouped);assert.equal(new Set(grouped).size,6);
  assert.ok(groups.every(group=>rules.validateMeld(group).valid));
  assert.equal(f.get('rack').querySelectorAll('.tile-playable').length,6);
  f.pageAPI.move('black-13-a','rack',grouped[0]);
  assert.equal(f.pageAPI.sortMode(),'manual');assert.equal(f.pageAPI.groups().length,0);
  assert.equal(f.get('rack').querySelectorAll('.tile-playable').length,0);
  assert.equal(f.get('rack').children[0].dataset.tile,'black-13-a');
  assert.equal(f.get('sort-color').classList.contains('active'),false);
  assert.doesNotMatch(f.get('selection-hint').textContent,/组已成组合/);
});

test('real duplicate-six drop splits 45678 into 456 and 678, is undoable, and does not save to server before confirmation',async t=>{
  const f=await fixture(t,{initialView:tableView({board:[['red-4-a','red-5-a','red-6-a','red-7-a','red-8-a']],rack:['red-6-b','black-13-a']})});
  f.pageAPI.move('red-6-b','0','red-7-a');
  const draft=plain(f.pageAPI.draft());assert.deepEqual(draft.board.map(group=>group.map(tile=>tile.value)),[[4,5,6],[6,7,8]]);
  const ids=draft.board.flat().map(tile=>tile.id);assert.equal(new Set(ids).size,6);
  assert.equal(f.get('commit').disabled,false);assert.match(f.get('toast').textContent,/自动拆成 2 组合法组合/);
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,0);
  f.get('undo').dispatchEvent(new Event('click'));
  assert.deepEqual(plain(f.pageAPI.draft().board).map(group=>group.map(tile=>tile.value)),[[4,5,6,7,8]]);
  assert.ok(f.pageAPI.draft().rack.some(tile=>tile.id==='red-6-b'));
});

test('duplicate split honors three physical copies and old v1 joker locks at the actual page entry point',async t=>{
  const three=await fixture(t,{initialView:tableView({board:[['red-4-a','red-5-a','red-6-a','red-7-a','red-8-a']],rack:['red-6-c','black-13-a'],copies:3,jokerCount:3})});
  three.pageAPI.move('red-6-c','0','red-6-a');
  assert.deepEqual(plain(three.pageAPI.draft().board).map(group=>group.map(tile=>tile.value)),[[4,5,6],[6,7,8]]);
  assert.equal(three.get('commit').disabled,false);assert.equal(three.pageAPI.draft().pool.length+three.pageAPI.draft().rack.length+three.pageAPI.draft().board.flat().length,159);
  const old=await fixture(t,{initialView:tableView({board:[['red-4-a','red-5-a','red-6-a','red-7-a','red-8-a'],['blue-10-a','joker-a','blue-12-a']],rack:['red-6-b','blue-11-a','black-13-a'],ruleVersion:'friends-v1'})});
  const before=plain(old.pageAPI.draft());old.pageAPI.move('joker-a','0');
  assert.deepEqual(plain(old.pageAPI.draft()),before);assert.match(old.get('toast').textContent,/旧规则.*鬼牌组合/);
  old.pageAPI.move('blue-11-a','1');assert.deepEqual(plain(old.pageAPI.draft()),before);assert.match(old.get('toast').textContent,/不能拆分或接牌/);
  old.pageAPI.move('red-6-b','0');
  assert.deepEqual(plain(old.pageAPI.draft().board).slice(0,2).map(group=>group.map(tile=>tile.value)),[[4,5,6],[6,7,8]]);
  assert.equal(old.get('rule-version').dataset.ruleVersion,'friends-v1');
  assert.ok(old.pageAPI.draft().board.some(group=>group.some(tile=>tile.joker)));
});

test('actual page chooses win, loss and draw exactly once and never replays the result on recovery or metadata',async t=>{
  for(const outcome of ['win','loss','draw-result']) {
    const f=await fixture(t,{initialView:tableView({turn:'friend'})});
    const done=tableView({turn:'friend',revision:2,phase:'finished'});
    done.game.status='finished';done.game.result={tie:outcome==='draw-result',winnerIds:outcome==='loss'?['friend']:['self'],reason:'blocked',scores:[]};
    f.receive(done);f.receive(done);f.receive({...done,revision:3});
    assert.equal(f.audioCalls.filter(cue=>cue===outcome).length,1);
    assert.equal(f.audioCalls.filter(cue=>['win','loss','draw-result'].includes(cue)).length,1);
    const restored=await fixture(t,{initialView:done});assert.deepEqual(restored.audioCalls,[]);
  }
});

test('actual SSE closed-chat bubble speaks once, keeps unread on timeout, and is erased immediately on account failure',async t=>{
  const f=await fixture(t,{initialView:tableView()});
  await f.event('chat',{roomId:'synthetic-room',messages:[]});
  const packet={roomId:'synthetic-room',messages:[{messageId:'message-1',chatSequence:1,playerId:'friend',name:'伙伴',text:'好牌！',sentAt:Date.now(),expiresAt:Date.now()+86400000}]};
  await f.event('chat',packet);await f.event('chat',packet);
  assert.equal(f.get('room-chat-notice').hidden,false);assert.match(f.get('room-chat-notice').textContent,/伙伴.*好牌/);
  assert.equal(f.audioCalls.filter(kind=>kind==='chat').length,1);
  f.timers.tick(6000);assert.equal(f.get('room-chat-notice').hidden,true);assert.equal(f.get('chat-unread').textContent,'1');
  await f.event('chat',{roomId:'synthetic-room',messages:[{...packet.messages[0],messageId:'message-2',chatSequence:2,text:'轮到你了'}]});
  assert.equal(f.get('room-chat-notice').hidden,false);
  f.deferState({promise:Promise.resolve(json({message:'revoked'},401))});f.timers.tick(15000);await settle();
  assert.equal(f.get('room-chat-notice').hidden,true);assert.doesNotMatch(f.get('room-chat-notice').textContent,/伙伴|轮到你了|好牌/);
  assert.equal(f.get('board').children.length,0);assert.equal(f.get('rack').children.length,0);
});

function watcherView(phase='playing') {
  const view=tableView({turn:'friend',phase});view.selfRole='spectator';view.selfId='self';view.hostId='friend';
  view.players=[{id:'friend',name:'伙伴',ready:true,connected:true},{id:'player-2',name:'另一位伙伴',ready:true,connected:true}];
  view.spectators=[{id:'self',name:'原朋友',connected:true}];view.spectatorCapacity=8;
  delete view.game.rack;delete view.game.opened;delete view.game.playerId;
  view.game.players=[{id:'friend',name:'伙伴',rackCount:14},{id:'player-2',name:'另一位伙伴',rackCount:14}];
  if(phase==='waiting')view.game=null;return view;
}
test('actual viewer projection has no rack or opening identity and cannot submit or expose private-hand DOM',async t=>{
  const viewer=watcherView(),f=await fixture(t,{initialView:viewer});
  assert.equal(f.pageAPI.view().selfRole,'spectator');assert.equal(f.document.body.classList.contains('rummi-spectator'),true);
  assert.equal(f.pageAPI.canAct(),false);assert.equal(f.get('rack').children.length,0);
  assert.equal(f.pageAPI.draft().rack.length,0);assert.equal(f.pageAPI.committed().rack.length,0);
  assert.equal(f.get('draw').hidden,true);assert.equal(f.get('commit').hidden,true);assert.equal(f.get('ready-button').hidden,true);
  assert.match(f.get('feedback-text').textContent,/观战/);
  f.get('commit').dispatchEvent(new Event('click'));f.get('draw').dispatchEvent(new Event('click'));
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  const css=await readFile(new URL('styles.css',import.meta.url),'utf8');
  assert.ok(/rummi-spectator[^{}]*\.rack-section[^{}]*\{[^}]*display:\s*none/s.test(css),'spectator CSS must remove private rack region');
  assert.ok(/rummi-spectator[^{}]*\.turn-actions[^{}]*\{[^}]*display:\s*none/s.test(css),'spectator CSS must remove player action row');
});

test('same account changing from player to spectator clears prior rack draft and its saved private cache',async t=>{
  const f=await fixture(t,{initialView:tableView()});f.pageAPI.move('red-7-a','0');
  assert.ok([...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
  const waiting={...f.pageAPI.view(),revision:2,phase:'waiting',game:null,matchId:null};f.receive(waiting);
  const viewer=watcherView('waiting');viewer.revision=3;f.receive(viewer);
  assert.equal(f.pageAPI.canAct(),false);assert.equal(f.get('rack').children.length,0);
  assert.equal(f.pageAPI.draft().rack.length,0);assert.equal(f.pageAPI.selected().length,0);
  assert.ok(![...f.sessionStorage.values.keys()].some(key=>key.startsWith(`game-room.private-draft.${USER}.`)));
});

test('actual 401 clears visible spectator identities as well as the board and rack for players and viewers',async t=>{
  for(const role of ['player','spectator']) {
    const view=role==='player'?tableView():watcherView('playing');
    view.spectators=[{id:role==='spectator'?view.selfId:'observer',name:'验收观众丙',connected:true}];view.spectatorCapacity=8;
    const f=await fixture(t,{initialView:view});
    assert.equal(f.get('spectator-list').hidden,false);assert.match(f.get('spectator-list').textContent,/观战 1\/8：验收观众丙/);
    f.deferState({promise:Promise.resolve(json({error:'SESSION_EXPIRED'},401))});f.timers.tick(15000);await settle();
    assert.equal(f.account.accountState().verification,'anonymous');assert.equal(f.account.accountState().authenticated,false);assert.equal(f.pageAPI.view(),null);
    assert.equal(f.get('spectator-list').hidden,true);assert.equal(f.get('spectator-list').textContent,'');
    assert.doesNotMatch(f.document.body.textContent,/验收观众丙/);
    assert.equal(f.get('board').children.length,0);assert.equal(f.get('rack').children.length,0);
    assert.equal(f.get('room-account-recover').hidden,false);assert.match(f.get('room-account-recover').getAttribute('href') || f.get('room-account-recover').href,/room\.html.*123456/);
  }
});

function previewPacket(view,{sequence=1,board=[['red-4-a','red-5-a','red-6-a','red-7-b']],...extra}={}) {
  return {version:1,roomCode:CODE,roomId:view.roomId,matchId:view.matchId,gameRevision:view.game.revision,
    turnPlayerId:view.game.turnPlayerId,ownerId:view.game.turnPlayerId,ownerName:'伙伴',previewId:'test-preview',sequence,
    expiresAt:Date.now()+25000,preview:{board:board.map(tiles),positions:board.map(()=>({x:.1,y:.1})),valid:true,validationMessage:''},...extra};
}
function pointer(f,type,target,{id=71,x=32,y=44}={}) {
  const event=new Event(type,{cancelable:true});
  Object.defineProperties(event,{target:{value:target},isPrimary:{value:true},button:{value:0},pointerId:{value:id},clientX:{value:x},clientY:{value:y}});
  f.document.dispatchEvent(event);
}
const clearPreviewPacket=view=>previewPacket(view,{ownerId:null,previewId:null,sequence:0,expiresAt:null,preview:null,clearReason:'expired'});
function transferFocus(f,previous,next) {
  f.document.activeElement=f.document.body;
  const out=new Event('focusout');Object.defineProperty(out,'target',{value:previous});f.document.dispatchEvent(out);
  if(next) {
    next.focus();const incoming=new Event('focusin');Object.defineProperty(incoming,'target',{value:next});f.document.dispatchEvent(incoming);
  }
}

test('actual sort/tile button focusout after group pointerdown preserves capture and completes free placement',async t=>{
  for(const focusSource of ['sort','tile']) {
    const f=await fixture(t,{initialView:tableView(),geometry:true});
    Object.defineProperties(f.get('board'),{clientWidth:{get:()=>1052},clientHeight:{get:()=>330}});
    if(focusSource==='sort')f.get('sort-color').dispatchEvent(new Event('click'));
    f.frame();
    const canvas=f.get('board').querySelector('.table-canvas'),group=canvas.querySelector('.meld'),handle=group.querySelector('[data-group]');
    canvas.getBoundingClientRect=()=>({left:184,top:116,right:1220,bottom:430,width:1036,height:314});
    group.getBoundingClientRect=()=>({left:184,top:116,right:306,bottom:188,width:122,height:72});
    f.document.elementFromPoint=()=>canvas;
    const previous=focusSource==='sort'?f.get('sort-color'):tileNode(f,'red-9-a');previous.focus();
    const draft=plain(f.pageAPI.draft()),committed=plain(f.pageAPI.committed()),oldPositions=plain(f.pageAPI.captureBoardPositions());
    pointer(f,'pointerdown',handle,{x:205,y:125});const captured=f.pageAPI.drag();
    assert.equal(handle.hasPointerCapture(71),true);
    transferFocus(f,previous,handle);
    assert.equal(f.pageAPI.drag(),captured,focusSource+' focusout must not cancel the new drag');
    pointer(f,'pointermove',handle,{x:600,y:300});assert.equal(f.pageAPI.drag().active,true);
    pointer(f,'pointerup',handle,{x:600,y:300});f.frame();
    const moved=f.get('board').querySelector('.meld');
    assert.equal(moved.style.left,'395px');assert.equal(moved.style.top,'175px');
    assert.notDeepEqual(plain(f.pageAPI.captureBoardPositions()),oldPositions);
    assert.deepEqual(plain(f.pageAPI.draft()),draft);assert.deepEqual(plain(f.pageAPI.committed()),committed);
    assert.equal(f.pageAPI.drag(),null);assert.equal(handle.hasPointerCapture(71),false);assert.equal(f.document.querySelectorAll('.group-drag-ghost').length,0);
    assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  }
});

test('actual sort/tile button focusout after rack pointerdown preserves capture and completes private free hand placement',async t=>{
  for(const focusSource of ['sort','tile']) {
    const f=await fixture(t,{initialView:tableView({turn:'friend'}),geometry:true});
    if(focusSource==='sort')f.get('sort-color').dispatchEvent(new Event('click'));
    f.frame();
    const before=plain(f.pageAPI.rackOrder()),dragged=tileNode(f,before.at(-1)),first=tileNode(f,before[0]);
    const previous=focusSource==='sort'?f.get('sort-color'):first;previous.focus();
    f.document.elementFromPoint=()=>first;
    const draft=plain(f.pageAPI.draft()),committed=plain(f.pageAPI.committed());
    pointer(f,'pointerdown',dragged,{x:240,y:55});const captured=f.pageAPI.drag();
    assert.equal(dragged.hasPointerCapture(71),true);transferFocus(f,previous,dragged);
    assert.equal(f.pageAPI.drag(),captured,focusSource+' focusout must not cancel the new rack drag');
    pointer(f,'pointermove',dragged,{x:8,y:10});assert.equal(f.pageAPI.drag().active,true);
    pointer(f,'pointerup',dragged,{x:8,y:10});f.frame();
    assert.deepEqual(plain(f.pageAPI.rackOrder()),before);assert.equal(f.pageAPI.rackPositions()[before.at(-1)].x,0);
    assert.deepEqual(plain(f.pageAPI.draft()),draft);assert.deepEqual(plain(f.pageAPI.committed()),committed);
    assert.equal(f.pageAPI.drag(),null);assert.equal(dragged.hasPointerCapture(71),false);assert.equal(f.document.querySelectorAll('.drag-ghost').length,0);
    assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  }
});

test('actual input, textarea and contenteditable focusout retain software-keyboard viewport recovery',async t=>{
  for(const tag of ['input','textarea','div']) {
    const f=await fixture(t,{initialView:tableView(),geometry:true});f.frame();
    const editor=f.document.createElement(tag);if(tag==='div')editor.setAttribute('contenteditable','true');f.document.body.append(editor);editor.focus();
    f.window.innerHeight=720;f.window.visualViewport={width:844,height:250,offsetTop:90,offsetLeft:0,scale:1};
    const editing=new Event('focusin');Object.defineProperty(editing,'target',{value:editor});f.document.dispatchEvent(editing);
    assert.equal(f.document.documentElement.style['--game-viewport-top'],'90px');
    const handle=f.get('board').querySelector('[data-group]');pointer(f,'pointerdown',handle);
    assert.equal(handle.hasPointerCapture(71),true);transferFocus(f,editor,null);
    assert.equal(f.pageAPI.drag(),null);assert.equal(handle.hasPointerCapture(71),false);
    assert.equal(f.document.documentElement.style['--game-viewport-top'],'0px');
    assert.equal(f.document.documentElement.style['--game-viewport-height'],'250px','visual height remains valid while the closing keyboard is still visible');
    assert.ok([120,350,750].every(delay=>[...f.timers.pending.values()].some(timer=>timer.at===delay)),'delayed keyboard recovery remains scheduled');
    f.window.visualViewport.height=720;f.window.visualViewport.offsetTop=0;
    f.timers.tick(750);f.frame();
    assert.equal(f.document.documentElement.style['--game-viewport-height'],'720px');
  }
});

test('fixed canvas CSS removes sidebar margin overflow and prevents focus scrolling without changing inner chat/dialog scrolling',async()=>{
  const css=await readFile(new URL('styles.css',import.meta.url),'utf8');
  for(const selector of ['.game-screen .shell {','.game-screen .shell > main {','.game-screen .shell:not(.lobby-shell) #room-play {']) {
    const at=css.indexOf(selector);assert.ok(at>=0,selector);const rule=css.slice(at,css.indexOf('}',at));
    assert.match(rule,/overflow:\s*hidden;\s*overflow:\s*clip;/,selector+' must not be a programmatically scrollable play region');
  }
  const sidebar=css.match(/\.game-screen\.in-game \.room-players \{([^}]+)\}/)[1];
  assert.match(sidebar,/height:\s*auto;/);assert.match(sidebar,/min-height:\s*0;/);assert.match(sidebar,/margin:\s*0;/);assert.match(sidebar,/padding:\s*24px 0 26px;/);
  const compact=[...css.matchAll(/\.game-screen\.in-game \.room-players \{([^}]+)\}/g)][1][1];
  assert.match(compact,/padding-top:\s*21px;/);assert.doesNotMatch(compact,/margin-top:/);
  assert.match(css,/\.chat-messages\s*\{[^}]*overflow:\s*auto/);
  assert.match(css,/\.room-activity-list\s*\{[^}]*overflow-y:\s*auto/);
});

test('actual canvas fallback keeps structural scroll at zero through arrange, tile focus and rotation without clearing captures or inner scroll',async t=>{
  const f=await fixture(t,{initialView:tableView(),geometry:true});f.frame();
  const main=f.document.querySelector('main'),shell=f.document.querySelector('.shell'),play=f.get('room-play');
  const heading=f.document.querySelector('.game-heading'),banner=f.get('turn-banner');
  // Controlled geometry models the observed hidden-main focus offset. CSS
  // layout itself is verified in the real browser, not simulated by this DOM.
  const top=()=>f.window.innerHeight<=500?33:44;
  main.getBoundingClientRect=()=>({top:top(),bottom:f.window.innerHeight-8,left:12,right:f.window.innerWidth-12});
  for(const node of [heading,banner])node.getBoundingClientRect=()=>({top:top()-main.scrollTop,bottom:top()+24-main.scrollTop,left:124,right:f.window.innerWidth-12});
  function staleScroll() {for(const node of [shell,main,play]) {node.scrollTop=24;node.scrollLeft=12;}}
  function visibleAtOrigin() {
    for(const node of [shell,main,play]) {assert.equal(node.scrollTop,0);assert.equal(node.scrollLeft,0);}
    for(const node of [heading,banner]) {const rect=node.getBoundingClientRect(),bounds=main.getBoundingClientRect();assert.ok(rect.top>=bounds.top && rect.bottom<=bounds.bottom);}
  }
  const list=f.get('chat-messages'),activity=f.get('room-activity-list');list.scrollTop=91;activity.scrollTop=55;
  staleScroll();f.get('board-arrange').dispatchEvent(new Event('click'));
  transferFocus(f,f.get('sort-color'),f.get('board-arrange'));f.frame();visibleAtOrigin();
  staleScroll();const tile=tileNode(f,'red-9-a');transferFocus(f,f.get('board-arrange'),tile);f.frame();visibleAtOrigin();
  const handle=f.get('board').querySelector('[data-group]');pointer(f,'pointerdown',handle);const captured=f.pageAPI.drag();
  staleScroll();transferFocus(f,tile,handle);assert.equal(f.pageAPI.drag(),captured);assert.equal(handle.hasPointerCapture(71),true);visibleAtOrigin();
  staleScroll();main.dispatchEvent(new Event('scroll'));visibleAtOrigin();assert.equal(f.pageAPI.drag(),captured);
  pointer(f,'pointercancel',handle);
  for(const [width,height]of [[390,844],[844,390],[1280,720],[390,844]]) {
    f.window.innerWidth=width;f.window.innerHeight=height;staleScroll();f.window.dispatchEvent(new Event('orientationchange'));f.frame();visibleAtOrigin();
    f.timers.tick(750);f.frame();visibleAtOrigin();
  }
  assert.equal(list.scrollTop,91);assert.equal(activity.scrollTop,55);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});

test('actual own preview echo and redundant empty packets preserve a captured group handle and all table/rack DOM',async t=>{
  const original=tableView(),f=await fixture(t,{initialView:original,geometry:true});f.frame();
  f.pageAPI.select('red-9-a');f.pageAPI.render();f.frame();
  const board=f.get('board').querySelector('.table-canvas'),handle=board.querySelector('[data-group]'),rackTile=tileNode(f,'red-9-a');
  f.document.elementFromPoint=()=>f.get('board');
  pointer(f,'pointerdown',handle);pointer(f,'pointermove',handle,{x:180,y:90});
  const active=f.pageAPI.drag(),draft=plain(f.pageAPI.draft()),committed=plain(f.pageAPI.committed()),selected=plain(f.pageAPI.selected()),saved=[...f.sessionStorage.values],cues=[...f.audioCalls];
  assert.equal(active.type,'group');assert.equal(active.active,true);assert.equal(handle.hasPointerCapture(71),true);
  await f.event('preview',previewPacket(original));
  await f.event('preview',previewPacket(original,{preview:null}));
  await f.event('preview',clearPreviewPacket(original));f.pageAPI.client().resetPreview();f.frame();
  assert.equal(f.get('board').querySelector('.table-canvas'),board);
  assert.equal(f.get('board').querySelector('[data-group]'),handle);assert.equal(tileNode(f,'red-9-a'),rackTile);
  assert.equal(f.pageAPI.drag(),active);assert.equal(handle.isConnected,true);assert.equal(handle.hasPointerCapture(71),true);
  assert.deepEqual(plain(f.pageAPI.draft()),draft);assert.deepEqual(plain(f.pageAPI.committed()),committed);assert.deepEqual(plain(f.pageAPI.selected()),selected);
  assert.deepEqual([...f.sessionStorage.values],saved);assert.deepEqual(f.audioCalls,cues);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  pointer(f,'pointercancel',handle);assert.equal(f.pageAPI.drag(),null);assert.equal(handle.hasPointerCapture(71),false);
});

test('actual opponent preview refresh fits the latest public table while preserving a live rack drag through pointerup',async t=>{
  const original=tableView({turn:'friend'}),f=await fixture(t,{initialView:original,geometry:true});f.frame();
  f.pageAPI.select('red-9-a');f.pageAPI.render();f.frame();
  const rackTile=tileNode(f,'red-9-a'),firstTile=tileNode(f,'red-7-a'),beforeOrder=plain(f.pageAPI.rackOrder());
  f.document.elementFromPoint=()=>firstTile;
  pointer(f,'pointerdown',rackTile);pointer(f,'pointermove',rackTile,{x:8,y:10});
  const active=f.pageAPI.drag(),draft=plain(f.pageAPI.draft()),committed=plain(f.pageAPI.committed()),saved=[...f.sessionStorage.values];
  assert.equal(active.active,true);assert.equal(rackTile.classList.contains('dragging'),true);assert.equal(rackTile.hasPointerCapture(71),true);
  await f.event('preview',previewPacket(original));f.frame();
  await f.event('preview',previewPacket(original,{sequence:2,board:[['red-4-a','red-5-a','red-6-a','red-7-b','red-8-b']]}));f.frame();
  assert.equal(f.get('board').querySelectorAll('[data-preview-tile]').length,5);assert.equal(f.pageAPI.remote().sequence,2);
  assert.match(f.get('board').querySelector('.table-canvas').style.transform,/^scale\(/);
  assert.ok(f.get('board').querySelector('.meld').style.left?.endsWith('px'),'the new preview is positioned during the rack drag');
  assert.equal(tileNode(f,'red-9-a'),rackTile);assert.equal(tileNode(f,'red-7-a'),firstTile);assert.equal(rackTile.isConnected,true);
  assert.equal(f.pageAPI.drag(),active);assert.equal(rackTile.hasPointerCapture(71),true);assert.deepEqual(plain(f.pageAPI.selected()),['red-9-a']);
  assert.deepEqual(plain(f.pageAPI.draft()),draft);assert.deepEqual(plain(f.pageAPI.committed()),committed);assert.deepEqual(plain(f.pageAPI.rackOrder()),beforeOrder);assert.deepEqual([...f.sessionStorage.values],saved);
  pointer(f,'pointerup',rackTile,{x:8,y:10});f.frame();
  assert.equal(f.pageAPI.drag(),null);assert.equal(rackTile.hasPointerCapture(71),false);
  assert.deepEqual(plain(f.pageAPI.rackOrder()),beforeOrder);assert.equal(f.pageAPI.rackPositions()['red-9-a'].x,0);assert.equal(f.pageAPI.selected().length,0);
  assert.deepEqual(plain(f.pageAPI.draft()),draft);assert.deepEqual(plain(f.pageAPI.committed()),committed);
  assert.equal(f.get('board').querySelectorAll('[data-preview-tile]').length,5);assert.equal(f.pageAPI.remote().sequence,2);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});

test('actual preview expiry returns the public table without cancelling rack capture, and redundant clears leave it alone',async t=>{
  const original=tableView({turn:'friend'}),f=await fixture(t,{initialView:original,geometry:true});f.frame();
  await f.event('preview',previewPacket(original));f.frame();
  f.pageAPI.select('red-9-a');f.pageAPI.render();f.frame();
  const rackTile=tileNode(f,'red-9-a');f.document.elementFromPoint=()=>f.get('rack');
  pointer(f,'pointerdown',rackTile);pointer(f,'pointermove',rackTile,{x:90,y:80});
  const active=f.pageAPI.drag(),draft=plain(f.pageAPI.draft()),saved=[...f.sessionStorage.values];
  await f.event('preview',clearPreviewPacket(original));f.frame();
  const formalCanvas=f.get('board').querySelector('.table-canvas');
  assert.equal(f.pageAPI.remote(),null);assert.equal(f.get('preview-status').hidden,true);assert.equal(f.get('board').classList.contains('board-live-preview'),false);
  assert.equal(f.get('board').querySelectorAll('[data-preview-tile]').length,0);assert.equal(f.get('board').querySelectorAll('[data-tile]').length,3);
  assert.equal(tileNode(f,'red-9-a'),rackTile);assert.equal(f.pageAPI.drag(),active);assert.equal(rackTile.hasPointerCapture(71),true);
  await f.event('preview',clearPreviewPacket(original));f.pageAPI.client().resetPreview();f.frame();
  assert.equal(f.get('board').querySelector('.table-canvas'),formalCanvas);assert.equal(tileNode(f,'red-9-a'),rackTile);
  assert.deepEqual(plain(f.pageAPI.draft()),draft);assert.deepEqual([...f.sessionStorage.values],saved);assert.deepEqual(plain(f.pageAPI.selected()),['red-9-a']);
  pointer(f,'pointercancel',rackTile);f.frame();
  assert.equal(f.pageAPI.drag(),null);assert.equal(rackTile.hasPointerCapture(71),false);assert.equal(rackTile.classList.contains('dragging'),false);
  assert.equal(f.get('board').querySelectorAll('[data-tile]').length,3);assert.deepEqual(plain(f.pageAPI.selected()),['red-9-a']);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});

test('actual safe preview changes only the visible public board and never the viewer rack, draft or committed state',async t=>{
  const original=tableView({turn:'friend'}),f=await fixture(t,{initialView:original});
  const committed=plain(f.pageAPI.committed()),draft=plain(f.pageAPI.draft()),ownRack=plain(f.pageAPI.rackOrder());
  const packet=previewPacket(original);await f.event('preview',packet);
  assert.equal(f.get('board').classList.contains('board-live-preview'),true);
  assert.equal(f.get('board').querySelectorAll('[data-preview-tile]').length,4);
  assert.equal(f.get('board').querySelectorAll('[data-tile]').length,0);
  assert.ok(f.get('board').querySelectorAll('[data-preview-tile]').every(tile=>tile.disabled));
  assert.deepEqual(plain(f.pageAPI.committed()),committed);assert.deepEqual(plain(f.pageAPI.draft()),draft);assert.deepEqual(plain(f.pageAPI.rackOrder()),ownRack);
  assert.match(f.get('preview-status').textContent,/伙伴.*整理.*未确认/);
  const wrong=previewPacket(original,{sequence:2,matchId:'old-match'});await f.event('preview',wrong);
  assert.equal(f.get('board').querySelectorAll('[data-preview-tile]').length,4);
  const next=tableView({turn:'self',revision:2});f.receive(next);
  assert.equal(f.pageAPI.remote(),null);assert.equal(f.get('board').classList.contains('board-live-preview'),false);
  assert.equal(f.get('board').querySelectorAll('[data-tile]').length,3);assert.equal(f.get('preview-status').hidden,true);
  await f.event('preview',packet);assert.equal(f.pageAPI.remote(),null);
});

test('confirmed submit atomically includes current board positions with the authoritative board and rack IDs',async t=>{
  const f=await fixture(t,{initialView:tableView({board:[['red-4-a','red-5-a','red-6-a','red-7-a','red-8-a']],rack:['red-6-b','black-13-a']})});
  f.pageAPI.move('red-6-b','0');const draft=plain(f.pageAPI.draft()),positions=plain(f.pageAPI.captureBoardPositions());
  let body;f.setAction(options=>{body=JSON.parse(options.body);return json({view:{...f.pageAPI.view(),revision:2}});});
  f.get('commit').dispatchEvent(new Event('click'));await settle();
  assert.equal(body.type,'submit');assert.deepEqual(body.boardIds,draft.board.map(group=>group.map(tile=>tile.id)));
  assert.deepEqual(body.rackIds,draft.rack.map(tile=>tile.id));assert.deepEqual(body.boardPositions,positions);
  assert.equal(body.boardPositions.length,2);
  assert.ok(body.boardPositions.every(point=>point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1));
});

function desktopBoard(f) {
  Object.defineProperties(f.get('board'),{clientWidth:{get:()=>1052},clientHeight:{get:()=>330}});f.frame();
}
function placeDesktopGroup(f,index,x,y) {
  const canvas=f.get('board').querySelector('.table-canvas'),group=canvas.querySelectorAll('.meld')[index],handle=group.querySelector('[data-group]');
  const left=184+parseFloat(group.style.left || '0'),top=116+parseFloat(group.style.top || '0'),width=Math.max(80,42*group.querySelectorAll('[data-tile]').length-4);
  canvas.getBoundingClientRect=()=>({left:184,top:116,right:1220,bottom:430,width:1036,height:314});
  group.getBoundingClientRect=()=>({left,top,right:left+width,bottom:top+72,width,height:72});
  f.document.elementFromPoint=()=>canvas;
  pointer(f,'pointerdown',handle,{x:left+21,y:top+9});pointer(f,'pointermove',handle,{x,y});pointer(f,'pointerup',handle,{x,y});f.frame();
}
function endedTurnView(original,body) {
  const view=structuredClone(original);view.revision++;view.game.revision++;view.game.round++;view.game.turnPlayerId='friend';
  view.game.boardPositions=structuredClone(body.boardPositions);
  if(body.type==='draw') {view.game.rack.push(structuredClone(LOOKUP.get('red-10-a')));view.game.players[0].rackCount++;view.game.poolCount--;}
  return view;
}

test('actual free group placement is atomically saved with draw or pass, without submitting draft cards',async t=>{
  for(const type of ['draw','pass']) {
    const original=tableView();if(type==='pass')original.game.poolCount=0;
    const f=await fixture(t,{initialView:original,geometry:true});desktopBoard(f);
    placeDesktopGroup(f,0,600,300);
    const expected=plain(f.pageAPI.captureBoardPositions()),formalBoard=plain(f.pageAPI.committed().board);
    assert.deepEqual(expected,[{x:.0395,y:.0175}]);
    let sent;f.setAction(options=>{sent=JSON.parse(options.body);return json({view:endedTurnView(original,sent)});});
    f.get('draw').dispatchEvent(new Event('click'));await settle();f.frame();
    assert.equal(sent.type,type);assert.deepEqual(sent.boardPositions,expected);
    assert.equal(Object.hasOwn(sent,'boardIds'),false);assert.equal(Object.hasOwn(sent,'rackIds'),false);
    assert.deepEqual(plain(f.pageAPI.committed().board),formalBoard);assert.deepEqual(plain(f.pageAPI.draft().board),formalBoard);
    assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),expected);assert.equal(f.get('board').querySelector('.meld').style.left,'395px');
    assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,1);
  }
});

test('actual automatic table arrangement is retained by drawing instead of restoring the earlier formal geometry',async t=>{
  const original=tableView({board:[['red-4-a','red-5-a','red-6-a'],['blue-4-a','blue-5-a','blue-6-a']]});
  original.game.boardPositions=[{x:.06,y:.01},{x:.02,y:.008}];
  const f=await fixture(t,{initialView:original,geometry:true});desktopBoard(f);
  f.get('board-arrange').dispatchEvent(new Event('click'));
  const arranged=plain(f.pageAPI.captureBoardPositions());assert.notDeepEqual(arranged,original.game.boardPositions);
  let sent;f.setAction(options=>{sent=JSON.parse(options.body);return json({view:endedTurnView(original,sent)});});
  f.get('draw').dispatchEvent(new Event('click'));await settle();f.frame();
  assert.equal(sent.type,'draw');assert.deepEqual(sent.boardPositions,arranged);assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),arranged);
  assert.deepEqual(plain(f.pageAPI.draft().board),original.game.board);
});

test('actual drawing discards unconfirmed card edits and uses old geometry only for changed original groups',async t=>{
  const original=tableView({board:[['red-4-a','red-5-a','red-6-a'],['blue-4-a','blue-5-a','blue-6-a']],rack:['red-7-a','black-13-a']});
  original.game.boardPositions=[{x:.003,y:.004},{x:.04,y:.008}];
  const f=await fixture(t,{initialView:original,geometry:true});desktopBoard(f);
  placeDesktopGroup(f,0,600,300);placeDesktopGroup(f,1,900,300);
  f.pageAPI.move('red-7-a','0');f.frame();
  assert.deepEqual(plain(f.pageAPI.draft().board[0]).map(tile=>tile.id),['red-4-a','red-5-a','red-6-a','red-7-a']);
  assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),[{x:.0395,y:.019},{x:.0695,y:.0175}]);
  let sent;f.setAction(options=>{sent=JSON.parse(options.body);return json({view:endedTurnView(original,sent)});});
  f.get('draw').dispatchEvent(new Event('click'));await settle();f.frame();
  assert.equal(sent.type,'draw');assert.deepEqual(sent.boardPositions,[{x:.003,y:.004},{x:.0695,y:.0175}]);
  assert.equal(Object.hasOwn(sent,'boardIds'),false);assert.equal(Object.hasOwn(sent,'rackIds'),false);
  assert.deepEqual(plain(f.pageAPI.committed().board),original.game.board);assert.deepEqual(plain(f.pageAPI.draft().board),original.game.board);
  assert.ok(f.pageAPI.draft().rack.some(tile=>tile.id==='red-7-a'));assert.ok(f.pageAPI.draft().rack.some(tile=>tile.id==='red-10-a'));
  assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),sent.boardPositions);
});

test('actual layout-carrying draw with an unknown acknowledgement reads the authoritative result and never replays the write',async t=>{
  const original=tableView(),f=await fixture(t,{initialView:original,geometry:true});desktopBoard(f);placeDesktopGroup(f,0,600,300);
  const expected=plain(f.pageAPI.captureBoardPositions());let sent;
  f.setAction(options=>{sent=JSON.parse(options.body);f.setView(endedTurnView(original,sent));throw new TypeError('synthetic missing acknowledgement');});
  const readsBefore=f.calls.filter(call=>call.url===`/api/rooms/${CODE}`).length;
  f.get('draw').dispatchEvent(new Event('click'));await settle();f.frame();
  assert.deepEqual(sent.boardPositions,expected);assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,1);
  assert.equal(f.calls.filter(call=>call.url===`/api/rooms/${CODE}`).length,readsBefore+1);
  assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),expected);assert.equal(f.pageAPI.view().game.turnPlayerId,'friend');
  assert.ok(f.pageAPI.draft().rack.some(tile=>tile.id==='red-10-a'));assert.equal(f.pageAPI.busy(),false);
});

function audioHardware(pending) {
  const contexts=[],parameter=()=>({setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},cancelScheduledValues(){},setTargetAtTime(){}});
  class AudioContext {
    constructor(){this.state='suspended';this.currentTime=0;this.destination={};this.oscillators=[];contexts.push(this);}
    createGain(){return {gain:parameter(),connect(){},disconnect(){}};}
    createOscillator(){const oscillator={frequency:parameter(),connect(){},disconnect(){},start(){},stop(){},onended:null};this.oscillators.push(oscillator);return oscillator;}
    async resume(){if(pending)await pending.promise;this.state='running';this.onstatechange?.();}
    async suspend(){this.state='suspended';this.onstatechange?.();}
    async close(){this.state='closed';this.onstatechange?.();}
  }
  return {AudioContext,contexts};
}
function trustedDocumentEvent(f,type,target) {
  const event=new Event(type);Object.defineProperty(event,'isTrusted',{value:true});
  if(target)Object.defineProperty(event,'target',{value:target});
  f.document.dispatchEvent(event);
}
test('actual first trusted action enables previously suspended sound and schedules its local placement without an extra toggle',async t=>{
  const pending=deferred(),hardware=audioHardware(pending),f=await fixture(t,{initialView:tableView(),audioContext:hardware.AudioContext});
  assert.equal(f.get('sound-toggle').textContent,'点按启声');
  trustedDocumentEvent(f,'pointerdown');f.pageAPI.move('red-7-a','0');
  assert.equal(hardware.contexts.length,1);assert.equal(hardware.contexts[0].oscillators.length,0);
  pending.resolve();await settle();
  assert.equal(f.get('sound-toggle').textContent,'声音开');
  assert.equal(hardware.contexts[0].oscillators.length,2);
});

test('actual sound switch preserves restore intent captured before unlock instead of muting the now-ready context',async t=>{
  const hardware=audioHardware(),f=await fixture(t,{initialView:tableView(),audioContext:hardware.AudioContext});
  assert.equal(f.get('sound-toggle').textContent,'点按启声');
  trustedDocumentEvent(f,'pointerdown',f.get('sound-toggle'));await settle();
  assert.equal(f.get('sound-toggle').textContent,'声音开');
  f.get('sound-toggle').dispatchEvent(new Event('click'));await settle();
  assert.equal(f.get('sound-toggle').textContent,'声音开');
  assert.equal(f.get('sound-toggle').getAttribute('aria-pressed'),'true');
});

test('actual fourteen-tile private hand remains separately visible after landscape to portrait to landscape rotation',async t=>{
  const rack=[...LOOKUP.values()].filter(tile=>!tile.joker).slice(0,14).map(tile=>tile.id);
  const f=await fixture(t,{initialView:tableView({rack,turn:'friend'}),geometry:true});f.frame();
  f.pageAPI.move(rack[0],'rack',null,{rackX:535,rackY:55,grabX:0,grabY:0});f.frame();
  const original=plain(f.pageAPI.rackLayout()),basis=plain(f.pageAPI.rackBasis());
  const overlap=(a,b)=>Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)+1e-6
    &&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y)+1e-6;
  let width=390,height=187;Object.defineProperties(f.get('rack'),{clientWidth:{get:()=>width},clientHeight:{get:()=>height}});
  for(const dimensions of [[390,187],[600,125],[390,187]]) {
    [width,height]=dimensions;f.window.dispatchEvent(new Event('resize'));f.frame();
    const current=plain(f.pageAPI.rackLayout());assert.deepEqual(plain(f.pageAPI.rackBasis()),basis);
    for(let i=0;i<rack.length;i++)for(let j=i+1;j<rack.length;j++)
      assert.equal(overlap(current.rects[i],current.rects[j]),overlap(original.rects[i],original.rects[j]));
  }
  const saved=JSON.parse([...f.sessionStorage.values.values()].find(value=>value.includes('rackBasis')));
  assert.deepEqual(saved.rackBasis,basis);
});

test('actual normal and double joker middle drops split the long run at intent and undo restores the exact unsplit hand/table',async t=>{
  const numbers=Array.from({length:8},(_,i)=>`red-${i+1}-a`);
  for(const jokerId of ['joker-normal-1','joker-double-1']) {
    const f=await fixture(t,{initialView:twistView({board:[numbers],rack:[jokerId,'black-13-a']})});
    const before=plain(f.pageAPI.draft());f.pageAPI.move(jokerId,'0','red-5-a');
    const after=plain(f.pageAPI.draft());
    assert.deepEqual(after.board.map(group=>group.map(tile=>tile.id)),[[...numbers.slice(0,4),jokerId],numbers.slice(4)]);
    assert.equal(rules.evaluateDraft(plain(f.pageAPI.committed()),after,{copies:3,jokerConfig:f.pageAPI.view().game.jokerConfig}).valid,true);
    assert.equal(f.get('commit').disabled,false);assert.equal(after.board.flat().filter(tile=>tile.id===jokerId).length,1);
    assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
    f.get('undo').dispatchEvent(new Event('click'));assert.deepEqual(plain(f.pageAPI.draft()),before);
  }
});
test('actual missing-number joker drops keep the whole run intact instead of adding needless splits',async t=>{
  for(const [jokerId,numbers,beforeId]of [
    ['joker-normal-1',[1,2,3,4,6,7,8],'red-6-a'],
    ['joker-double-1',[1,2,3,4,7,8],'red-7-a'],
  ]) {
    const numericIds=numbers.map(n=>`red-${n}-a`);
    const f=await fixture(t,{initialView:twistView({board:[],rack:[...numericIds,jokerId,'black-13-a']})});
    f.pageAPI.move(numericIds,'new');f.pageAPI.move(jokerId,'0',beforeId);const draft=plain(f.pageAPI.draft());
    assert.equal(draft.board.length,1);assert.equal(draft.board[0][4].id,jokerId);assert.equal(f.get('commit').disabled,false);
  }
});
test('actual pointer drop into a public run passes the real target insertion rather than treating the ghost as an endpoint',async t=>{
  const numbers=Array.from({length:8},(_,i)=>`red-${i+1}-a`),jokerId='joker-normal-1';
  const f=await fixture(t,{initialView:twistView({board:[numbers],rack:[jokerId,'black-13-a']}),geometry:true});f.frame();
  const tile=tileNode(f,jokerId),target=tileNode(f,'red-5-a');
  f.document.elementFromPoint=()=>target;
  pointer(f,'pointerdown',tile,{x:120,y:320});pointer(f,'pointermove',tile,{x:310,y:95});pointer(f,'pointerup',tile,{x:310,y:95});
  const draft=plain(f.pageAPI.draft());assert.deepEqual(draft.board.map(group=>group.map(tile=>tile.id)),[[...numbers.slice(0,4),jokerId],numbers.slice(4)]);
  assert.equal(f.get('commit').disabled,false);assert.equal(f.pageAPI.drag(),null);assert.equal(f.document.querySelectorAll('.drag-ghost').length,0);
});

test('actual player and spectator bootstrap an existing public preview silently; only a later placement schedules audible notes',async t=>{
  for(const role of ['player','spectator']) {
    const original=role==='player'?tableView({turn:'friend'}):watcherView(),hardware=audioHardware();
    const f=await fixture(t,{initialView:original,initialPreview:previewPacket(original),audioContext:hardware.AudioContext});
    assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,0);
    trustedDocumentEvent(f,'pointerdown');await settle();assert.equal(hardware.contexts[0].oscillators.length,0);
    await f.event('preview',previewPacket(original,{sequence:2,board:[['red-4-a','red-5-a','red-6-a','red-7-b','red-8-b']]}));
    assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);assert.equal(hardware.contexts[0].oscillators.length,2);
    if(role==='spectator')assert.equal(f.get('rack').children.length,0);
  }
});

test('actual empty initial public snapshot followed by the first new tile sounds for a player and spectator without changing private state',async t=>{
  for(const role of ['player','spectator']) {
    const original=role==='player'?tableView({turn:'friend'}):watcherView(),hardware=audioHardware();
    const f=await fixture(t,{initialView:original,audioContext:hardware.AudioContext}),draft=plain(f.pageAPI.draft()),committed=plain(f.pageAPI.committed());
    const checks=f.calls.filter(call=>call.url==='/api/state').length;trustedDocumentEvent(f,'pointerdown');await settle();
    await f.event('preview',previewPacket(original));
    assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);assert.equal(hardware.contexts[0].oscillators.length,2);
    assert.deepEqual(plain(f.pageAPI.draft()),draft);assert.deepEqual(plain(f.pageAPI.committed()),committed);
    assert.equal(f.calls.filter(call=>call.url==='/api/state').length,checks);
    assert.ok(!f.calls.some(call=>call.url.endsWith('/actions') || call.url.endsWith('/preview')));
  }
});

test('actual transport reconnect silently seeds the same unfinished preview, then sounds only a subsequent new public tile',async t=>{
  const original=tableView({turn:'friend'}),f=await fixture(t,{initialView:original});
  await f.event('preview',previewPacket(original));assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
  f.streams.at(-1).controller.close();await settle();f.timers.tick(2000);await settle();
  await f.event('view',{view:original});await f.event('preview',previewPacket(original,{sequence:2}));
  assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
  await f.event('preview',previewPacket(original,{sequence:3,board:[['red-4-a','red-5-a','red-6-a','red-7-b','red-8-b']]}));
  assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,2);assert.equal(f.streams.length,2);
});

test('actual own placement plays locally once; own public echo and authoritative commit cannot play it a second time',async t=>{
  const original=tableView(),f=await fixture(t,{initialView:original});
  f.pageAPI.move('red-7-a','0');assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
  await f.event('preview',previewPacket(original,{board:[['red-4-a','red-5-a','red-6-a','red-7-a']]}));
  const submitted=tableView({turn:'friend',revision:2,board:[['red-4-a','red-5-a','red-6-a','red-7-a']],rack:['red-9-a','black-13-a']});
  await f.event('view',{view:submitted});assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
});

test('actual coordinates, regrouping, duplicate packets and preview undo stay quiet; submitting a heard opponent placement does not sound twice',async t=>{
  const original=tableView({turn:'friend'}),f=await fixture(t,{initialView:original});
  await f.event('preview',previewPacket(original));assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
  const moved=previewPacket(original,{sequence:2});moved.preview.positions=[{x:.5,y:.8}];await f.event('preview',moved);
  await f.event('preview',previewPacket(original,{sequence:3,board:[['red-4-a'],['red-5-a','red-6-a','red-7-b']]}));
  await f.event('preview',clearPreviewPacket(original));await f.event('preview',previewPacket(original,{sequence:4}));
  assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1,'expired snapshot must not replay an old sound');
  const committed=tableView({turn:'self',revision:2,board:[['red-4-a','red-5-a','red-6-a','red-7-b']]});
  await f.event('view',{view:committed});assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
});

test('actual authoritative opponent commit without a preview provides the public placement cue, but recovery never replays it',async t=>{
  const original=tableView({turn:'friend'}),f=await fixture(t,{initialView:original});
  const committed=tableView({turn:'self',revision:2,board:[['red-4-a','red-5-a','red-6-a','red-7-b']]});
  await f.event('view',{view:committed});assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
  await f.event('view',{view:{...committed,revision:3}});assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
  const restored=await fixture(t,{initialView:committed,initialPreview:clearPreviewPacket(committed)});
  assert.deepEqual(restored.audioCalls,[]);
});

test('actual locked audio never queues remote placement history; after a trusted tap only the next new public card sounds',async t=>{
  const original=tableView({turn:'friend'}),hardware=audioHardware(),f=await fixture(t,{initialView:original,audioContext:hardware.AudioContext});
  await f.event('preview',previewPacket(original));assert.equal(hardware.contexts.length,0);assert.equal(f.get('sound-toggle').textContent,'点按启声');
  trustedDocumentEvent(f,'pointerdown');await settle();assert.equal(hardware.contexts[0].oscillators.length,0);
  await f.event('preview',previewPacket(original,{sequence:2,board:[['red-4-a','red-5-a','red-6-a','red-7-b','red-8-b']]}));
  assert.equal(hardware.contexts[0].oscillators.length,2);
});

test('actual multi-selected mirror drop gives all three legal groups distinct positions and count, preserves another free group and is accepted atomically by the real RoomStore',async t=>{
  const store=createRoomStore({now:()=>10000,turnTimeoutMs:1800000,gameOptions:{firstTurnIndex:0,randomInt:max=>max-1}});
  t.after(()=>store.close());store.createTrustedRoom(USER,'原朋友',{code:CODE,roomId:'c'.repeat(32),gameType:'rummikub'});
  store.joinTrustedRoom(CODE,OTHER,'伙伴');let sequence=0;
  const act=(index,type,extra={})=>store.trustedAction(CODE,[USER,OTHER][index],{type,requestId:`mirror-three-${++sequence}`,
    expectedRevision:store.getTrustedView(CODE,[USER,OTHER][index]).revision,...extra});
  act(0,'configure',{jokerConfig:{normal:1,mirror:1,colorChange:1,double:1}});
  act(0,'ready',{ready:true});act(1,'ready',{ready:true});act(0,'start');
  const snapshot=store.exportSnapshot(CODE),game=snapshot.game,deck=rules.createDeck({copies:game.copies,jokerConfig:game.jokerConfig});
  const lookup=new Map(deck.map(tile=>[tile.id,tile])),make=ids=>ids.map(id=>structuredClone(lookup.get(id)));
  const numbers=[1,2,3,4,5,6,7].map(n=>`red-${n}-a`),other=['blue-10-a','blue-11-a','blue-12-a'];
  game.board=[make(numbers),make(other)];game.boardPositions=[{x:.005,y:.005},{x:.08,y:.02}];
  game.players[0].rack=make(['joker-mirror-1','red-4-b','black-13-a']);game.players[1].rack=make(['black-1-a','black-2-a']);
  game.players.forEach(player=>{player.opened=true;});
  const used=new Set([...game.board.flat(),...game.players.flatMap(player=>player.rack)].map(tile=>tile.id));game.pool=deck.filter(tile=>!used.has(tile.id));
  store.importSnapshot(snapshot);const committedSnapshot=store.exportSnapshot(CODE);
  const f=await fixture(t,{initialView:store.getTrustedView(CODE,USER),geometry:true});
  assert.ok(f.get('board').querySelector('.table-canvas'),JSON.stringify({state:f.account.accountState(),hint:f.get('waiting-hint').textContent,view:f.pageAPI.view()}));desktopBoard(f);
  const before=plain(f.pageAPI.draft()),oldPositions=plain(f.pageAPI.captureBoardPositions());
  f.pageAPI.select('joker-mirror-1');f.pageAPI.select('red-4-b');f.pageAPI.render();f.frame();
  const dragged=tileNode(f,'joker-mirror-1'),target=tileNode(f,'red-5-a');f.document.elementFromPoint=()=>target;
  pointer(f,'pointerdown',dragged,{x:120,y:320});pointer(f,'pointermove',dragged,{x:310,y:95});pointer(f,'pointerup',dragged,{x:310,y:95});f.frame();
  const after=plain(f.pageAPI.draft()),positions=plain(f.pageAPI.captureBoardPositions());
  assert.deepEqual(after.board.map(group=>group.map(tile=>tile.id)),[
    numbers.slice(0,3),['red-4-a','joker-mirror-1','red-4-b'],numbers.slice(4),other]);
  assert.equal(after.board.flat().filter(tile=>tile.id==='joker-mirror-1').length,1);
  assert.deepEqual(positions,[oldPositions[0],{x:Number((oldPositions[0].x+.016).toFixed(4)),y:oldPositions[0].y},
    {x:Number((oldPositions[0].x+.032).toFixed(4)),y:oldPositions[0].y},oldPositions[1]]);
  assert.equal(new Set(positions.slice(0,3).map(point=>`${point.x}:${point.y}`)).size,3);
  assert.match(f.get('toast').textContent,/自动拆成 3 组合法组合/);assert.equal(f.get('commit').disabled,false);
  assert.deepEqual(store.exportSnapshot(CODE),committedSnapshot);assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  f.get('undo').dispatchEvent(new Event('click'));f.frame();assert.deepEqual(plain(f.pageAPI.draft()),before);
  assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),oldPositions);
  f.pageAPI.move(['joker-mirror-1','red-4-b'],'0','red-5-a');f.frame();
  let sent;f.setAction(options=>{sent=JSON.parse(options.body);return json({view:store.trustedAction(CODE,USER,sent)});});
  f.get('commit').dispatchEvent(new Event('click'));await settle();f.frame();
  assert.equal(sent.type,'submit');assert.equal(sent.boardPositions.length,4);assert.deepEqual(sent.boardPositions,positions);
  const saved=store.exportSnapshot(CODE);assert.deepEqual(saved.game.board.map(group=>group.map(tile=>tile.id)),after.board.map(group=>group.map(tile=>tile.id)));
  assert.deepEqual(saved.game.boardPositions,positions);assert.equal(saved.game.players[0].rack.length,1);assert.equal(saved.game.revision,game.revision+1);
  assert.equal(new Set([...saved.game.board.flat(),...saved.game.pool,...saved.game.players.flatMap(player=>player.rack)].map(tile=>tile.id)).size,108);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,1);
});

test('actual intentional undo is silent but re-dropping the same hand tile sounds again; its later formal commit remains silent',async t=>{
  for(const role of ['player','spectator']) {
    const original=role==='player'?tableView({turn:'friend'}):watcherView(),f=await fixture(t,{initialView:original});
    await f.event('preview',previewPacket(original));assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
    if(role==='player')await f.event('preview',clearPreviewPacket(original));
    await f.event('preview',{...clearPreviewPacket(original),clearReason:'cleared'});
    assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
    await f.event('preview',previewPacket(original,{sequence:2}));assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,2);
    const committed=structuredClone(original);committed.revision++;committed.game.revision++;committed.game.round++;
    committed.game.board=tiles(['red-4-a','red-5-a','red-6-a','red-7-b']).map(tile=>[tile]);
    committed.game.turnPlayerId=role==='player'?'self':'player-2';await f.event('view',{view:committed});
    assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,2);
  }
});

test('actual coalesced authoritative turns sound unseen opponent cards while deduplicating a local public placement and a later draw',async t=>{
  for(const withOpponentCard of [false,true]) {
    const original=tableView(),f=await fixture(t,{initialView:original});
    f.pageAPI.move('red-7-a','0');assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
    const submitted=tableView({turn:'self',revision:3,board:[['red-4-a','red-5-a','red-6-a','red-7-a',...(withOpponentCard?['red-8-b']:[])]],rack:['red-9-a','black-13-a']});
    await f.event('view',{view:submitted});
    assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,withOpponentCard?2:1);
    await f.event('view',{view:submitted});assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,withOpponentCard?2:1);
  }
});

test('actual restored local public draft can commit without replaying its placement, but the next unseen opponent placement sounds',async t=>{
  const original=tableView(),seed=await fixture(t,{initialView:original});seed.pageAPI.move('red-7-a','0');
  const restored=await fixture(t,{initialView:original,seedSession:[...seed.sessionStorage.values]});
  assert.equal(restored.pageAPI.draft().board.flat().some(tile=>tile.id==='red-7-a'),true);
  assert.equal(restored.audioCalls.filter(kind=>kind==='placement').length,0);
  const submitted=tableView({turn:'friend',revision:2,board:[['red-4-a','red-5-a','red-6-a','red-7-a']],rack:['red-9-a','black-13-a']});
  restored.setAction(()=>json({view:submitted}));restored.get('commit').dispatchEvent(new Event('click'));await settle();
  assert.equal(restored.audioCalls.filter(kind=>kind==='placement').length,0);
  await restored.event('view',{view:tableView({turn:'self',revision:3,board:[['red-4-a','red-5-a','red-6-a','red-7-a','red-8-b']],rack:['red-9-a','black-13-a']})});
  assert.equal(restored.audioCalls.filter(kind=>kind==='placement').length,1);
});

test('actual actor disconnection or identity failure clears quietly and does not replay restored public draft cards to players or spectators',async t=>{
  for(const role of ['player','spectator'])for(const clearReason of ['disconnected','identity-failed']) {
    const original=role==='player'?tableView({turn:'friend'}):watcherView(),f=await fixture(t,{initialView:original});
    await f.event('preview',previewPacket(original));assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
    await f.event('preview',{...clearPreviewPacket(original),clearReason});
    await f.event('preview',previewPacket(original,{sequence:2}));assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,1);
    await f.event('preview',previewPacket(original,{sequence:3,board:[['red-4-a','red-5-a','red-6-a','red-7-b','red-8-b']]}));
    assert.equal(f.audioCalls.filter(kind=>kind==='placement').length,2);
  }
});

function openingRoomFixture({version='friends-v4',rack=['red-13-a','joker-mirror-1','red-13-b','black-13-a'],board=[]}={}) {
  const store=createRoomStore({now:()=>10000,turnTimeoutMs:1800000,gameOptions:{firstTurnIndex:0,randomInt:max=>max-1,ruleVersion:version}});
  store.createTrustedRoom(USER,'原朋友',{code:CODE,roomId:'c'.repeat(32)});store.joinTrustedRoom(CODE,OTHER,'伙伴');
  let seq=0;
  const act=(index,type,extra={})=>store.trustedAction(CODE,[USER,OTHER][index],{type,requestId:`score-ui-${++seq}`,
    expectedRevision:store.getTrustedView(CODE,[USER,OTHER][index]).revision,...extra});
  const jokerConfig={normal:1,mirror:1,colorChange:1,double:1};act(0,'configure',{jokerConfig});
  act(0,'ready',{ready:true});act(1,'ready',{ready:true});act(0,'start');
  const saved=store.exportSnapshot(CODE),game=saved.game,deck=rules.createDeck({copies:2,jokerConfig});
  const lookup=new Map(deck.map(tile=>[tile.id,tile])),make=ids=>ids.map(id=>structuredClone(lookup.get(id)));
  game.board=board.map(make);game.boardPositions=null;game.players[0].rack=make(rack);game.players[0].opened=false;
  game.players[1].rack=make(['black-1-b','black-2-b']);game.players[1].opened=true;
  const used=new Set([...game.board.flat(),...game.players.flatMap(player=>player.rack)].map(tile=>tile.id));game.pool=deck.filter(tile=>!used.has(tile.id));
  store.importSnapshot(saved);
  return {store,act,view:()=>store.getTrustedView(CODE,USER)};
}

test('actual new v4 opening shows mirror 13 as 39, submits through the real RoomStore and restores the normal opened hint',async t=>{
  const real=openingRoomFixture();t.after(()=>real.store.close());
  const f=await fixture(t,{initialView:real.view()});f.pageAPI.move(['red-13-a','joker-mirror-1','red-13-b']);
  assert.equal(f.get('opening-label').textContent,'开局 39 / 30 点');assert.match(f.get('table-note').textContent,/点数已达标.*镜像计对应数字/);
  assert.match(f.get('feedback-text').textContent,/累计 39.*达到 30/);assert.equal(f.get('commit').disabled,false);
  assert.match(f.get('twist-rule').textContent,/朋友计分.*靠中心.*双重/);
  const before=real.store.exportSnapshot(CODE);let posts=0;
  f.setAction(options=>{posts++;return json(real.store.trustedAction(CODE,USER,JSON.parse(options.body)));});
  f.get('commit').dispatchEvent(new Event('click'));await settle();
  assert.equal(posts,1);assert.equal(real.view().game.opened,true);assert.deepEqual(real.store.exportSnapshot(CODE).game.pool,before.game.pool);
  assert.equal(f.get('opening-label').textContent,'已开局 · 可以重组');assert.equal(f.get('table-note').textContent,'桌面可以重组；已提交的牌不能收回手牌。');
});

test('actual legacy v3 opening stays 26 with a four-point shortfall and mirror zero across restore, preview and rejected authority submission',async t=>{
  const real=openingRoomFixture({version:'friends-v3'});t.after(()=>real.store.close());
  const f=await fixture(t,{initialView:real.view()});f.pageAPI.move(['red-13-a','joker-mirror-1','red-13-b']);
  assert.equal(f.get('opening-label').textContent,'开局 26 / 30 点');assert.match(f.get('table-note').textContent,/还差 4 点.*镜像自身计 0/);
  assert.match(f.get('feedback-text').textContent,/累计 26.*还差 4/);assert.equal(f.get('commit').disabled,true);
  assert.match(f.get('twist-rule').textContent,/旧计分.*0分/);
  const fresh=await fixture(t,{initialView:real.view(),query:'',seedSession:[...f.sessionStorage.values]});
  assert.equal(fresh.get('opening-label').textContent,'开局 26 / 30 点');assert.equal(fresh.get('commit').disabled,true);
  const publisher=createRoomPreview({now:()=>10000});t.after(()=>publisher.close());const view=real.view();
  const prepared=publisher.prepare(view,{previewId:'score_ui_legacy_1',sequence:1,matchId:view.matchId,gameRevision:view.game.revision,
    boardIds:f.pageAPI.draft().board.map(group=>group.map(tile=>tile.id)),positions:[{x:.1,y:.1}]},'isolated-session');
  assert.equal(prepared.preview.valid,false);assert.match(prepared.preview.validationMessage,/26/);
  const before=real.store.exportSnapshot(CODE).game;
  assert.throws(()=>real.act(0,'submit',{boardIds:[['red-13-a','joker-mirror-1','red-13-b']],rackIds:['black-13-a']}),/26/);
  assert.deepEqual(real.store.exportSnapshot(CODE).game,before);
});

test('actual own multiple-group opening progresses to exactly 30 and ordinary three 13s still show 39 with matching authority',async t=>{
  const real=openingRoomFixture({rack:['red-9-a','joker-mirror-1','red-9-b','red-1-a','blue-1-a','black-1-a','black-13-a']});
  t.after(()=>real.store.close());const f=await fixture(t,{initialView:real.view()});
  f.pageAPI.move(['red-9-a','joker-mirror-1','red-9-b']);assert.match(f.get('table-note').textContent,/27.*还差 3/);assert.equal(f.get('commit').disabled,true);
  f.pageAPI.move(['red-1-a','blue-1-a','black-1-a']);assert.equal(f.get('opening-label').textContent,'开局 30 / 30 点');assert.equal(f.get('commit').disabled,false);
  const draft=f.pageAPI.draft();real.act(0,'submit',{boardIds:draft.board.map(group=>group.map(tile=>tile.id)),rackIds:draft.rack.map(tile=>tile.id)});
  assert.equal(real.view().game.opened,true);
  const plainRoom=openingRoomFixture({rack:['red-13-a','blue-13-a','black-13-a','orange-2-a']});t.after(()=>plainRoom.store.close());
  const ordinary=await fixture(t,{initialView:plainRoom.view()});ordinary.pageAPI.move(['red-13-a','blue-13-a','black-13-a']);
  assert.equal(ordinary.get('opening-label').textContent,'开局 39 / 30 点');assert.equal(ordinary.get('commit').disabled,false);
  const ordinaryDraft=ordinary.pageAPI.draft();plainRoom.act(0,'submit',{boardIds:ordinaryDraft.board.map(group=>group.map(tile=>tile.id)),rackIds:ordinaryDraft.rack.map(tile=>tile.id)});
  assert.equal(plainRoom.view().game.opened,true);
});

test('actual first opening never counts or borrows a 33-point public run and retains the real incomplete-opening restriction',async t=>{
  const board=[['blue-10-a','blue-11-a','blue-12-a']],rack=['red-9-a','joker-mirror-1','red-9-b','black-13-a'];
  const real=openingRoomFixture({board,rack});t.after(()=>real.store.close());const f=await fixture(t,{initialView:real.view()});
  f.pageAPI.move(['red-9-a','joker-mirror-1','red-9-b']);
  assert.equal(f.get('opening-label').textContent,'开局 27 / 30 点');assert.match(f.get('table-note').textContent,/还差 3/);assert.equal(f.get('commit').disabled,true);
  const before=f.pageAPI.draft();f.pageAPI.move(['blue-10-a'],'1');assert.deepEqual(f.pageAPI.draft(),before);
  assert.throws(()=>real.act(0,'submit',{boardIds:[...board,['red-9-a','joker-mirror-1','red-9-b']],rackIds:['black-13-a']}),/27/);
  assert.equal(real.view().game.opened,false);assert.deepEqual(real.view().game.board.map(group=>group.map(tile=>tile.id)),board);
});

test('actual automatic hand sorting lays complete playable combinations together with a visible tile-wide gap and leaves private free moves off the wire',async t=>{
  const original=tableView({rack:['red-1-a','red-2-a','red-3-a','blue-7-a','blue-8-a','blue-9-a','black-10-a','red-10-a','orange-10-a','black-13-a']});
  const f=await fixture(t,{initialView:original,geometry:true});f.pageAPI.sort('color');f.frame();
  const layout=plain(f.pageAPI.rackLayout()),groups=plain(f.pageAPI.groups());assert.ok(groups.length>=2);assert.equal(layout.rects.length,original.game.rack.length);
  let end=0;for(const group of groups) {
    const points=layout.rects.slice(end,end+group.length);assert.equal(new Set(points.map(point=>point.row)).size,1);
    end+=group.length;
    if(end<layout.rects.length && layout.rects[end].row===layout.rects[end-1].row)
      assert.ok(Math.abs(layout.rects[end].x-layout.rects[end-1].x-layout.tileWidth*2)<1e-7);
  }
  const committed=plain(f.pageAPI.committed());f.pageAPI.move('black-13-a','rack',null,{rackX:400,rackY:70,grabX:0,grabY:0});f.frame();
  const privatePoints=plain(f.pageAPI.rackPositions());assert.ok(Object.keys(privatePoints).length);assert.deepEqual(plain(f.pageAPI.committed()),committed);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions') || call.url.endsWith('/preview')).length,0);
  f.pageAPI.render();f.frame();assert.deepEqual(plain(f.pageAPI.rackPositions()),privatePoints);
});

test('actual wide table automatic arrangement centers the complete groups, leaves one tile between groups and persists that geometry without new cards',async t=>{
  const original=tableView({board:[['red-1-a','red-2-a','red-3-a'],['blue-7-a','blue-8-a','blue-9-a'],['black-10-a','red-10-a','orange-10-a']]});
  const f=await fixture(t,{initialView:original,geometry:true});desktopBoard(f);f.get('board-arrange').dispatchEvent(new Event('click'));f.frame();
  const positions=plain(f.pageAPI.captureBoardPositions());assert.equal(positions.length,3);
  assert.ok(positions[0].x>0,'automatic desktop groups should be centered, not flush against the edge');
  for(let i=1;i<positions.length;i++)if(positions[i].y===positions[i-1].y)assert.ok(Math.abs(10000*(positions[i].x-positions[i-1].x)-160)<=1);
  let sent;f.setAction(options=>{sent=JSON.parse(options.body);return json({view:endedTurnView(original,sent)});});
  f.get('draw').dispatchEvent(new Event('click'));await settle();f.frame();
  assert.deepEqual(sent.boardPositions,positions);assert.equal(Object.hasOwn(sent,'boardIds'),false);assert.deepEqual(plain(f.pageAPI.committed().board),original.game.board);
});

function clickTarget(f,node){assert.ok(node);const event=new Event('click');Object.defineProperty(event,'target',{value:node});f.document.dispatchEvent(event);}
const cueCount=(f,name)=>f.audioCalls.filter(cue=>cue===name).length;

test('actual private selections, hand sorting and manual placement sound locally without sending private actions',async t=>{
  const hardware=audioHardware(),f=await fixture(t,{initialView:tableView({turn:'friend'}),audioContext:hardware.AudioContext});
  trustedDocumentEvent(f,'pointerdown');await settle();clickTarget(f,tileNode(f,'red-9-a'));assert.equal(cueCount(f,'select'),1);assert.equal(hardware.contexts[0].oscillators.length,1);
  f.get('sort-color').dispatchEvent(new Event('click'));assert.equal(cueCount(f,'sort'),1);
  f.pageAPI.move('red-9-a','rack',null,{rackX:200,rackY:20,grabX:0,grabY:0,anchorId:'red-9-a'});assert.equal(cueCount(f,'placement'),1);
  const count=f.audioCalls.length;f.pageAPI.move('red-7-a','0');assert.equal(f.audioCalls.length,count,'not-your-turn public move must not sound successful');
  assert.equal(f.calls.filter(call=>/\/(actions|preview)$/.test(call.url) && call.options.method==='POST').length,0);
});

test('actual split and merge controls choose distinct sounds, undo and restore work, and rejected splits remain quiet',async t=>{
  const board=[['red-1-a','red-2-a','red-3-a','red-4-a','red-5-a','red-6-a']],f=await fixture(t,{initialView:tableView({board})});
  f.get('undo').dispatchEvent(new Event('click'));assert.deepEqual(f.audioCalls,[]);
  clickTarget(f,f.document.querySelector('[data-split="0"]'));clickTarget(f,f.document.querySelector('[data-cut="3"]'));assert.equal(cueCount(f,'split'),1);
  assert.equal(f.pageAPI.draft().board.length,2);f.pageAPI.move(['red-1-a','red-2-a','red-3-a'],'1','red-4-a');assert.equal(cueCount(f,'merge'),1);assert.equal(f.pageAPI.draft().board.length,1);
  f.get('undo').dispatchEvent(new Event('click'));assert.equal(cueCount(f,'undo'),1);assert.equal(f.pageAPI.draft().board.length,2);
  f.get('restore').dispatchEvent(new Event('click'));assert.equal(cueCount(f,'restore'),1);assert.deepEqual(plain(f.pageAPI.draft().board),board.map(tiles));
  const locked=await fixture(t,{initialView:{...tableView({board}),game:{...tableView({board}).game,opened:false}}});
  clickTarget(locked,locked.document.querySelector('[data-split="0"]'));
  clickTarget(locked,locked.document.querySelector('[data-cut="3"]'));
  assert.equal(cueCount(locked,'split'),0);assert.equal(locked.pageAPI.draft().board.length,1);
});

function waitingAudioRoom(gameType='rummikub'){
  const store=createRoomStore({now:()=>10000,turnTimeoutMs:1800000,gameOptions:{firstTurnIndex:0,randomInt:max=>max-1}});
  store.createTrustedRoom(USER,'原朋友',{code:CODE,roomId:'e'.repeat(32),gameType});store.joinTrustedRoom(CODE,OTHER,'伙伴');let serial=0;
  const act=(index,type,extra={})=>store.trustedAction(CODE,[USER,OTHER][index],{type,requestId:`audio-${++serial}`,expectedRevision:store.getTrustedView(CODE,[USER,OTHER][index]).revision,...extra});
  return {store,act,view:()=>store.getTrustedView(CODE,USER)};
}
function bindRealActions(f,real){f.setAction(options=>{try{const body=JSON.parse(options.body);return json(real.act(0,body.type,body));}catch(error){return json({message:error.message},error.status||409);}});}

test('actual room ready, authoritative start, pause and resume emit distinct cues only after acceptance and never replay on bootstrap',async t=>{
  for(const page of ['room','army']){
    const real=waitingAudioRoom(page==='army'?'army-flip':'rummikub');t.after(()=>real.store.close());const f=await fixture(t,{page,initialView:real.view()});bindRealActions(f,real);
    f.get('start-room').dispatchEvent(new Event('click'));await settle();assert.equal(cueCount(f,'start'),0);assert.equal(cueCount(f,'invalid'),1);
    f.get('ready-button').dispatchEvent(new Event('click'));await settle();assert.equal(cueCount(f,'ready'),1);
    real.act(1,'ready',{ready:true});await f.event('view',{view:real.view()});f.get('start-room').dispatchEvent(new Event('click'));await settle();assert.equal(cueCount(f,'start'),1);
    f.get('pause-room').dispatchEvent(new Event('click'));await settle();assert.equal(cueCount(f,'pause'),0);
    real.act(1,'pause',{agree:true});await f.event('view',{view:real.view()});assert.equal(cueCount(f,'pause'),1);
    f.get('resume-room-menu').dispatchEvent(new Event('click'));await settle();assert.equal(cueCount(f,'resume'),1);
    const resumed=real.view();await f.event('view',{view:resumed});assert.equal(cueCount(f,'resume'),1);
    const fresh=await fixture(t,{page,initialView:resumed});assert.deepEqual(fresh.audioCalls,[]);
  }
});

function armyAudioPosition(game){
  const deck=new Map(game.board.flatMap(({piece})=>piece?[piece]:[]).map(piece=>[piece.id,piece]));
  const placements={r11c1:'red-flag-1',r0c1:'black-flag-1',r2c0:'red-company-1',r3c0:'black-platoon-1',r4c0:'black-company-1',r3c1:'black-engineer-1'},used=new Set(Object.values(placements));
  game.board=armyBoard.BOARD_CELLS.map(({cellId})=>({cellId,piece:placements[cellId]?{...deck.get(placements[cellId]),revealed:cellId!=='r3c1'}:null}));
  game.captured=[...deck.values()].filter(piece=>!used.has(piece.id)).map(piece=>({...piece,revealed:true}));
  game.players[0].side='red';game.players[1].side='black';game.players[0].lastFlipSide='red';game.players[1].lastFlipSide='black';
  game.turnIndex=0;game.round=51;game.revision=51;game.lastAction={type:'decline-draw',playerId:game.players[1].id};return game;
}

test('actual army room flips, walks, collides and selects use separate sounds from real authoritative actions',async t=>{
  for(const [action,cue]of [[{type:'flip',cellId:'r3c1'},'flip'],[{type:'move',from:'r2c0',to:'r2c1'},'move'],[{type:'move',from:'r2c0',to:'r3c0'},'collision']]){
    const real=waitingAudioRoom('army-flip');t.after(()=>real.store.close());real.act(0,'ready',{ready:true});real.act(1,'ready',{ready:true});real.act(0,'start');
    const saved=real.store.exportSnapshot(CODE);armyAudioPosition(saved.game);saved.turnClock.round=saved.game.round;saved.turnClock.playerId=saved.game.players[0].id;real.store.importSnapshot(saved);
    const f=await fixture(t,{page:'army',initialView:real.view()});bindRealActions(f,real);
    if(action.type==='move'){await f.pageAPI.click(action.from);assert.equal(cueCount(f,'select'),1);await f.pageAPI.click(action.from);assert.equal(cueCount(f,'undo'),1);await f.pageAPI.click(action.from);}
    await f.pageAPI.click(action.to||action.cellId);await settle();assert.equal(cueCount(f,cue),1);assert.equal(f.pageAPI.view().game.lastAction.type,action.type);
    const count=f.audioCalls.length;await f.pageAPI.click('r3c1');await settle();assert.equal(f.audioCalls.length,count,'off-turn click cannot produce a successful action sound');
  }
});

test('actual army practice uses real saved state, classifies moves and collisions, restarts audibly, and restores silently',async t=>{
  for(const [action,cue]of [[{type:'flip',cellId:'r3c1'},'flip'],[{type:'move',from:'r2c0',to:'r2c1'},'move'],[{type:'move',from:'r2c0',to:'r3c0'},'collision']]){
    const game=armyAudioPosition(armyPractice.createPracticeGame({ruleVersion:'army-flip-v3',firstTurnIndex:0,randomInt:max=>max-1}));
    assert.equal(armyPractice.practiceProblem(game),null);const f=await fixture(t,{page:'army-practice',practiceGame:game});assert.deepEqual(f.audioCalls,[]);
    if(action.type==='move'){await f.pageAPI.click(action.from);assert.equal(cueCount(f,'select'),1);f.get('army-cancel').dispatchEvent(new Event('click'));assert.equal(cueCount(f,'undo'),1);await f.pageAPI.click(action.from);}
    await f.pageAPI.click(action.to||action.cellId);await settle();assert.equal(cueCount(f,cue),1);assert.equal(f.pageAPI.view().game.lastAction.type,action.type);
    f.get('confirm-restart').dispatchEvent(new Event('click'));await settle();assert.equal(cueCount(f,'start'),1);
  }
});

test('all four actual game pages bind compact auditions to current volume and honest muted or zero status without changing enable semantics',async t=>{
  for(const page of ['room','practice','army','army-practice']){
    let real,game;
    if(page==='army'){real=waitingAudioRoom('army-flip');t.after(()=>real.store.close());}
    if(page==='army-practice')game=armyPractice.createPracticeGame({ruleVersion:'army-flip-v3',firstTurnIndex:0,randomInt:max=>max-1});
    const hardware=audioHardware(),f=await fixture(t,{page,initialView:real?.view(),practiceGame:game,audioContext:hardware.AudioContext});
    const control=f.get('sound-preview-kind'),button=f.get('sound-preview'),status=f.get('sound-preview-status');assert.ok(control && button && status);assert.equal(status.tagName,'SPAN');
    assert.equal(control.parentNode,f.get('sound-volume').parentNode);assert.equal(status.textContent,'45%');
    control.value=page.startsWith('army')?'collision':'sort';button.dispatchEvent(new Event('click'));await settle();assert.match(status.textContent,/试听：.*45%/);assert.ok(hardware.contexts[0].oscillators.length>0);
    f.get('sound-volume').value='0';f.get('sound-volume').dispatchEvent(new Event('input'));button.dispatchEvent(new Event('click'));await settle();assert.equal(status.textContent,'音量 0');
    f.get('sound-volume').value='65';f.get('sound-volume').dispatchEvent(new Event('input'));assert.equal(status.textContent,'65%');
    f.get('sound-toggle').dispatchEvent(new Event('click'));button.dispatchEvent(new Event('click'));await settle();assert.equal(status.textContent,'音效关');
  }
});


function projectionBoardView() {
  const board=[['red','a'],['blue','a'],['orange','a'],['black','a'],['red','b'],['blue','b'],['orange','b']].map(([color,copy])=>Array.from({length:7},(_,i)=>`${color}-${i+1}-${copy}`));
  const view=tableView({board,rack:['red-8-a','black-13-a'],copies:3,jokerCount:3});
  const layout=tableLayout.fitGroupsToViewport(board.map((group,i)=>({id:String(i),length:group.length})),{width:1266,height:500});
  view.game.boardPositions=layout.positions.map(p=>({x:p.logicalX/10000,y:p.logicalY/10000}));return view;
}
function sizedProjectionBoard(f) {
  let width=358,height=600;
  Object.defineProperties(f.get('board'),{clientWidth:{get:()=>width+16},clientHeight:{get:()=>height+16}});
  const apply=()=>{f.window.dispatchEvent(new Event('resize'));f.frame();const canvas=f.get('board').querySelector('.table-canvas');canvas.getBoundingClientRect=()=>({left:8,top:8,right:8+width,bottom:8+height,width,height});return canvas;};
  return {apply,size(w,h){width=w;height=h;return apply();}};
}

test('actual saved centered table changes only its projection through repeated rotation, refresh and layout-carrying draw',async t=>{
  const original=projectionBoardView(),f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f);board.apply();
  const expected=original.game.boardPositions;
  assert.ok(f.pageAPI.tableFit().adaptiveReflow || f.pageAPI.tableFit().displayOffsetX<0);assert.ok(f.pageAPI.tableFit().scale>.57);
  assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),expected);
  for(const [width,height]of[[1266,500],[358,600],[701,128],[358,600],[1266,500],[358,600]]) {
    board.size(width,height);assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),expected);
  }
  const seedSession=[...f.sessionStorage.values],fresh=await fixture(t,{initialView:original,seedSession,geometry:true});sizedProjectionBoard(fresh).apply();
  assert.deepEqual(plain(fresh.pageAPI.captureBoardPositions()),expected);
  let sent;fresh.setAction(options=>{sent=JSON.parse(options.body);return json({view:endedTurnView(original,sent)});});
  fresh.get('draw').dispatchEvent(new Event('click'));await settle();fresh.frame();
  assert.deepEqual(sent.boardPositions,expected);assert.deepEqual(plain(fresh.pageAPI.captureBoardPositions()),expected);
  assert.deepEqual(plain(fresh.pageAPI.committed().board),original.game.board);
});

test('actual projected whole-group pointer drop subtracts the display offset before shared position persistence and undo',async t=>{
  const original=projectionBoardView(),f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f),canvas=board.apply();
  const fit=plain(f.pageAPI.tableFit()),point=fit.positions[0],group=canvas.querySelectorAll('.meld')[0],handle=group.querySelector('[data-group]');
  group.getBoundingClientRect=()=>({left:8+point.x,top:8+point.y,right:8+point.x+point.width,bottom:8+point.y+point.height,width:point.width,height:point.height});
  f.document.elementFromPoint=()=>canvas;
  const display=tableLayout.boardLayoutPositions(fit,{display:true}),placed=tableLayout.placeGroup({width:point.width,height:point.height},{x:80,y:400},fit.positions.slice(1),{width:358,height:600,gap:38*fit.scale});
  pointer(f,'pointerdown',handle,{x:8+point.x+21,y:8+point.y+9});pointer(f,'pointermove',handle,{x:8+80+21,y:8+400+9});pointer(f,'pointerup',handle,{x:8+80+21,y:8+400+9});f.frame();
  const captured=plain(f.pageAPI.captureBoardPositions());
  assert.ok(Math.abs(captured[0].x-(placed.x-(fit.displayOffsetX||0))/fit.scale/10000)<1e-12);
  assert.ok(Math.abs(captured[0].y-(placed.y-(fit.displayOffsetY||0))/fit.scale/10000)<1e-12);
  assert.deepEqual(captured.slice(1),fit.positions.slice(1).map(p=>({x:display[p.id].x/10000,y:display[p.id].y/10000})));
  assert.deepEqual(plain(f.pageAPI.draft().board),original.game.board);
  f.get('undo').dispatchEvent(new Event('click'));f.frame();assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),original.game.boardPositions);
});

test('actual projected new-target and empty-canvas tile drops retain logical anchors, physical IDs and private hand isolation',async t=>{
  for(const kind of ['target','canvas']) {
    const original=projectionBoardView(),f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f),canvas=board.apply(),fit=plain(f.pageAPI.tableFit());
    const display=tableLayout.boardLayoutPositions(fit,{display:true});
    let expected;
    if(kind==='target') {expected={x:fit.newTarget.logicalX,y:fit.newTarget.logicalY};f.pageAPI.move('red-8-a','new');}
    else {f.document.elementFromPoint=()=>canvas;const tile=tileNode(f,'red-8-a');pointer(f,'pointerdown',tile,{x:120,y:320});pointer(f,'pointermove',tile,{x:8+320,y:8+300});pointer(f,'pointerup',tile,{x:8+320,y:8+300});expected={x:(320-(fit.displayOffsetX||0))/fit.scale-19,y:(300-(fit.displayOffsetY||0))/fit.scale-27};}
    f.frame();const captured=plain(f.pageAPI.captureBoardPositions());
    assert.ok(Math.abs(captured.at(-1).x-expected.x/10000)<1e-12);
    assert.ok(Math.abs(captured.at(-1).y-expected.y/10000)<1e-12);
    assert.deepEqual(captured.slice(0,7),fit.positions.map(p=>({x:display[p.id].x/10000,y:display[p.id].y/10000})));
    assert.deepEqual(plain(f.pageAPI.draft().board.at(-1)).map(tile=>tile.id),['red-8-a']);
    assert.deepEqual(plain(f.pageAPI.draft().rack).map(tile=>tile.id),['black-13-a']);
    assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  }
});

function publicPriorityHardware(){
  const hardware=audioHardware(),make=hardware.AudioContext.prototype.createOscillator;
  hardware.AudioContext.prototype.createOscillator=function(){
    const source=make.call(this),stop=source.stop,disconnect=source.disconnect;
    source.stops=[];source.disconnected=false;
    source.stop=function(at){this.stops.push(at);return stop.call(this,at);};
    source.disconnect=function(){this.disconnected=true;return disconnect.call(this);};return source;
  };return hardware;
}
function assertPublicSurvivesPriority(hardware,publicVoices){
  const sources=hardware.contexts[0].oscillators;
  assert.ok(sources.length>publicVoices,'the same update also schedules a priority cue');
  assert.ok(sources.slice(0,publicVoices).every(source=>!source.disconnected && source.stops.length===1),'the public action retains its scheduled finite playback');
  assert.ok(sources.filter(source=>!source.disconnected).length<=12);
}

test('actual formal public fallback survives its same-view own-turn or result cue without preview replay',async t=>{
  for(const priority of ['turn','win']){
    const original=tableView({turn:'friend'}),hardware=publicPriorityHardware(),f=await fixture(t,{initialView:original,audioContext:hardware.AudioContext});
    trustedDocumentEvent(f,'pointerdown');await settle();assert.deepEqual(f.audioCalls,[]);
    const next=structuredClone(original);next.revision++;next.game.revision++;next.game.round++;next.game.board[0].push(...tiles(['red-7-b']));next.game.turnPlayerId='self';
    if(priority==='win'){next.phase='finished';next.game.status='finished';next.game.result={winnerIds:['self'],tie:false};}
    await f.event('view',{view:next});assert.deepEqual(f.audioCalls,['placement',priority]);assertPublicSurvivesPriority(hardware,2);
    const count=hardware.contexts[0].oscillators.length;await f.event('view',{view:next});assert.deepEqual(f.audioCalls,['placement',priority]);assert.equal(hardware.contexts[0].oscillators.length,count);
    const fresh=await fixture(t,{initialView:next,audioContext:publicPriorityHardware().AudioContext});assert.deepEqual(fresh.audioCalls,[]);
  }
});

function armyPriorityFinishPosition(game){
  const all=new Map([...game.board.flatMap(({piece})=>piece?[piece]:[]),...game.captured].map(piece=>[piece.id,piece]));
  const placements={r11c1:'red-flag-1',r0c1:'black-flag-1',r2c0:'black-commander-1',r3c0:'red-company-1'},used=new Set(Object.values(placements));
  game.board=armyBoard.BOARD_CELLS.map(({cellId})=>({cellId,piece:placements[cellId]?{...all.get(placements[cellId]),revealed:true}:null}));
  game.captured=[...all.values()].filter(piece=>!used.has(piece.id)).map(piece=>({...piece,revealed:true}));
  game.players[0].side='red';game.players[1].side='black';game.players[0].lastFlipSide='red';game.players[1].lastFlipSide='black';
  game.turnIndex=1;game.round=51;game.revision=51;game.lastAction={type:'decline-draw',playerId:game.players[0].id};return game;
}
function startedArmyPriorityRoom(t,position=armyAudioPosition){
  const real=waitingAudioRoom('army-flip');t.after(()=>real.store.close());real.act(0,'ready',{ready:true});real.act(1,'ready',{ready:true});real.act(0,'start');
  const saved=real.store.exportSnapshot(CODE);position(saved.game);saved.game.turnIndex=1;saved.turnClock.round=saved.game.round;saved.turnClock.playerId=saved.game.players[1].id;real.store.importSnapshot(saved);return real;
}

test('actual authoritative army friend flip, walk and collision remain audible before the same-view own turn',async t=>{
  for(const [action,cue,voices]of [[{type:'flip',cellId:'r3c1'},'flip',2],[{type:'move',from:'r4c0',to:'r4c1'},'move',1],[{type:'move',from:'r3c0',to:'r2c0'},'collision',3]]){
    const real=startedArmyPriorityRoom(t),hardware=publicPriorityHardware(),f=await fixture(t,{page:'army',initialView:real.view(),audioContext:hardware.AudioContext});
    trustedDocumentEvent(f,'pointerdown');await settle();assert.deepEqual(f.audioCalls,[]);real.act(1,action.type,action);
    const next=real.view();assert.equal(next.game.turnPlayerId,next.selfId);await f.event('view',{view:next});assert.deepEqual(f.audioCalls,[cue,'turn']);assertPublicSurvivesPriority(hardware,voices);
    await f.event('view',{view:next});assert.deepEqual(f.audioCalls,[cue,'turn']);const presence=structuredClone(next);presence.revision++;await f.event('view',{view:presence});assert.deepEqual(f.audioCalls,[cue,'turn']);
    const fresh=await fixture(t,{page:'army',initialView:next});assert.deepEqual(fresh.audioCalls,[]);
  }
});

test('actual authoritative army last capture survives its same-view loss notification without replaying after finish',async t=>{
  const real=startedArmyPriorityRoom(t,armyPriorityFinishPosition),hardware=publicPriorityHardware(),f=await fixture(t,{page:'army',initialView:real.view(),audioContext:hardware.AudioContext});
  trustedDocumentEvent(f,'pointerdown');await settle();real.act(1,'move',{from:'r2c0',to:'r3c0'});const next=real.view();assert.equal(next.phase,'finished');assert.equal(next.game.lastAction.outcome,'capture');
  await f.event('view',{view:next});assert.deepEqual(f.audioCalls,['collision','loss']);assertPublicSurvivesPriority(hardware,3);
  await f.event('view',{view:next});assert.deepEqual(f.audioCalls,['collision','loss']);const fresh=await fixture(t,{page:'army',initialView:next});assert.deepEqual(fresh.audioCalls,[]);
});

test('actual practice bot action survives its same-view own-turn or loss cue and saved-state bootstrap stays silent',async t=>{
  for(const finish of [false,true]){
    const game=(finish?armyPriorityFinishPosition:armyAudioPosition)(armyPractice.createPracticeGame({ruleVersion:'army-flip-v3',firstTurnIndex:0,randomInt:max=>max-1}));game.turnIndex=1;
    assert.equal(armyPractice.practiceProblem(game),null);const hardware=publicPriorityHardware(),f=await fixture(t,{page:'army-practice',practiceGame:game,audioContext:hardware.AudioContext});assert.deepEqual(f.audioCalls,[]);
    trustedDocumentEvent(f,'pointerdown');await settle();f.timers.tick(650);await settle();const next=f.pageAPI.view(),actionCue=createGameAudio({AudioContext:null}).armyCue(next.game.lastAction);
    assert.ok(actionCue);assert.equal(next.phase,finish?'finished':'playing');assert.deepEqual(f.audioCalls,[actionCue,finish?'loss':'turn']);assertPublicSurvivesPriority(hardware,actionCue==='collision'?3:actionCue==='move'?1:2);
    f.timers.tick(650);await settle();assert.equal(f.audioCalls.length,2,'the completed bot action cannot replay on later timer ticks');
  }
});

const JOKER_ASSET_SHA='4fb13b99c15c2a4675588e6c841c02ed098845e7d3619c86f907ef7a361626d5';
const JOKER_TYPES=['normal','mirror','color-change','double'];
async function jokerAssetServer(t,mount) {
  const png=await readFile(new URL('assets/joker-mark.png',import.meta.url));
  const css=await readFile(jokerRegressionSource('styles.css'));
  assert.equal(createHash('sha256').update(png).digest('hex'),JOKER_ASSET_SHA);
  const server=createServer((request,response)=>{
    if(request.url===`${mount}assets/joker-mark.png`) {
      response.writeHead(200,{'Content-Type':'image/png'});response.end(png);
    } else if(request.url===`${mount}styles.css`) {
      response.writeHead(200,{'Content-Type':'text/css'});response.end(css);
    } else {response.writeHead(404);response.end('outside this game entry');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {origin:`http://127.0.0.1:${server.address().port}`,mount};
}
async function loadedJokerAsset(src,base,{origin,mount},description) {
  const url=new URL(src,base);assert.equal(url.origin,origin,description);
  // Fetch the real bytes before checking the path: a root-only image URL must
  // fail at the mounted server, even if the generated HTML looks reasonable.
  const response=await fetch(url);assert.equal(response.status,200,`${description}: ${url.pathname}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get('content-type'),'image/png',description);
  assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]),description);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),JOKER_ASSET_SHA,description);
  assert.equal(url.pathname,`${mount}assets/joker-mark.png`,description);
}
async function loadedRenderedJokers(container,types,f,entry,description) {
  assert.equal(container.querySelectorAll('img.joker-art').length,types.length,description);
  for(const type of types) {
    const tile=container.matches(`[data-joker-type="${type}"]`)?container:container.querySelector(`[data-joker-type="${type}"]`);
    assert.ok(tile,`${description}: ${type} tile`);
    const image=tile.querySelector('img.joker-art');assert.ok(image,`${description}: ${type} image`);
    await loadedJokerAsset(image.getAttribute('src'),f.location.href,entry,`${description}: ${type}`);
  }
}
function jokerResourceView() {
  const view=twistView({jokerConfig:{normal:2,mirror:2,colorChange:2,double:2},
    rack:JOKER_TYPES.map(type=>`joker-${type}-1`),
    board:[['blue-8-a','joker-normal-2','blue-10-a'],['red-7-a','joker-mirror-2','red-7-b'],
      ['blue-4-a','joker-color-change-2','red-6-a'],['black-1-a','joker-double-2','black-4-a']]});
  view.game.turnPlayerId='friend';
  for(const group of view.game.board)assert.equal(rules.validateMeld(group,{copies:3,jokerConfig:view.jokerConfig,ruleVersion:'friends-v3'}).valid,true);
  return view;
}
for(const mount of ['/','/game/']) {
  test(`joker rendered asset loads at ${mount} for four types in rack, board, inspectors, live preview and real drag clones`,async t=>{
    const entry=await jokerAssetServer(t,mount),view=jokerResourceView();
    const f=await fixture(t,{initialView:view,mount,origin:entry.origin,geometry:true});f.frame();
    await loadedRenderedJokers(f.get('rack'),JOKER_TYPES,f,entry,'private rack');
    await loadedRenderedJokers(f.get('board'),JOKER_TYPES,f,entry,'committed public table');
    f.get('rack-inspect').dispatchEvent(new Event('click'));
    await settle();
    assert.equal(f.get('tile-inspector').open,true);
    await loadedRenderedJokers(f.get('inspector-tiles'),JOKER_TYPES,f,entry,'rack inspector');
    f.get('inspector-close').dispatchEvent(new Event('click'));
    f.get('board-view').dispatchEvent(new Event('click'));
    for(const type of JOKER_TYPES) {
      await loadedRenderedJokers(f.get('inspector-tiles'),[type],f,entry,`table inspector ${type}`);
      if(type!==JOKER_TYPES.at(-1))f.get('inspector-next').dispatchEvent(new Event('click'));
    }
    f.get('inspector-close').dispatchEvent(new Event('click'));
    f.document.elementFromPoint=()=>f.get('rack');
    for(const type of JOKER_TYPES) {
      const tile=f.get('rack').querySelector(`[data-tile="joker-${type}-1"]`);
      pointer(f,'pointerdown',tile);pointer(f,'pointermove',tile,{x:60,y:80});
      const ghost=f.document.querySelector('.drag-ghost');assert.ok(ghost,`real ${type} drag clone`);
      assert.equal(ghost.getAttribute('inert'),'','a single-tile drag copy cannot enter the keyboard focus order');
      await loadedRenderedJokers(ghost,[type],f,entry,`real ${type} drag clone`);
      pointer(f,'pointercancel',tile);assert.equal(f.document.querySelector('.drag-ghost'),null);
    }
    await f.event('preview',previewPacket(view,{preview:{board:structuredClone(view.game.board),
      positions:view.game.board.map((_,index)=>({x:.1+(index%2)*.4,y:.1+Math.floor(index/2)*.4})),valid:true,validationMessage:''}}));
    f.frame();assert.ok(f.pageAPI.remote(),'the opponent preview is actually displayed');
    await loadedRenderedJokers(f.get('board'),JOKER_TYPES,f,entry,'live public preview');
    assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
    const ownView=structuredClone(view);ownView.game.turnPlayerId=ownView.selfId;
    const own=await fixture(t,{initialView:ownView,mount,origin:entry.origin,geometry:true});own.frame();
    own.document.elementFromPoint=()=>own.get('rack');
    const handles=own.get('board').querySelectorAll('[data-group]');assert.equal(handles.length,JOKER_TYPES.length);
    for(const [index,type]of JOKER_TYPES.entries()) {
      const handle=handles[index];pointer(own,'pointerdown',handle);pointer(own,'pointermove',handle,{x:180,y:90});
      assert.equal(own.pageAPI.drag().type,'group');assert.equal(own.pageAPI.drag().active,true);
      const ghost=own.document.querySelector('.group-drag-ghost');assert.ok(ghost,`real ${type} group drag clone`);
      assert.equal(ghost.getAttribute('inert'),'','a group drag copy cannot enter the keyboard focus order');
      const images=ghost.querySelectorAll('img.joker-art');assert.equal(images.length,1,`real ${type} group drag image`);
      await loadedJokerAsset(images[0].getAttribute('src'),own.location.href,entry,`real ${type} group drag clone`);
      pointer(own,'pointercancel',handle);assert.equal(own.document.querySelector('.group-drag-ghost'),null);
    }
    assert.equal(own.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  });
  test(`joker CSS background asset loads at ${mount} for mirror and double silhouettes`,async t=>{
    const entry=await jokerAssetServer(t,mount),cssUrl=`${entry.origin}${mount}styles.css`;
    const response=await fetch(cssUrl);assert.equal(response.status,200);const css=await response.text();
    for(const type of ['mirror','double']) {
      const rule=css.match(new RegExp(`\\.tile\\[data-joker-type="${type}"\\] \\.joker-face::before \\{([^}]+)\\}`));
      assert.ok(rule,`${type} silhouette rule`);const src=rule[1].match(/url\(['"]?([^'"\)]+)['"]?\)/)?.[1];
      assert.ok(src,`${type} silhouette uses its existing illustration`);
      await loadedJokerAsset(src,cssUrl,entry,`${type} CSS background`);
    }
  });
}

for(const [kind,value]of [...['red','blue','orange','black'].map(color=>['number',color]),...JOKER_TYPES.map(type=>['joker',type])]) {
  test(`actual group drag presentation retains ${kind} ${value} while stripping interaction metadata and cancels cleanly`,async t=>{
    const view=kind==='number'?tableView({board:[[`${value}-4-a`,`${value}-5-a`,`${value}-6-a`]],rack:['black-13-a']}):jokerResourceView();
    view.game.turnPlayerId=view.selfId;
    if(kind==='joker')view.game.board=[view.game.board[JOKER_TYPES.indexOf(value)]];
    const f=await fixture(t,{initialView:view,geometry:true});f.frame();
    const canvas=f.get('board').querySelector('.table-canvas'),group=canvas.querySelector('.meld'),handle=group.querySelector('[data-group]');
    group.setAttribute('id',`source-group-${kind}-${value}`);handle.setAttribute('id',`source-handle-${kind}-${value}`);
    const originals=group.querySelectorAll('.tile');assert.equal(originals.length,3);
    // A future data attribute must not silently become an exception. The two
    // approved attributes belong to tile presentation, not to other nodes.
    originals[0].setAttribute('data-unapproved-context','synthetic-interaction');
    handle.setAttribute('data-color','synthetic-nontile-display');
    const originalAttributes=originals.map(tile=>({...tile.attributes}));
    const draft=plain(f.pageAPI.draft()),committed=plain(f.pageAPI.committed()),rackNodes=[...f.get('rack').children],boardNodes=[...canvas.children];
    const layout=plain(f.pageAPI.captureBoardPositions()),rackPositions=plain(f.pageAPI.rackPositions()),stored=[...f.sessionStorage.values];
    f.document.elementFromPoint=()=>f.get('rack');
    pointer(f,'pointerdown',handle);assert.equal(handle.hasPointerCapture(71),true);
    pointer(f,'pointermove',handle,{x:180,y:90});assert.equal(f.pageAPI.drag().type,'group');assert.equal(f.pageAPI.drag().active,true);
    const ghost=f.document.querySelector('.group-drag-ghost');assert.ok(ghost);
    const copies=ghost.querySelectorAll('.tile');assert.equal(copies.length,originals.length);
    for(const [index,copy]of copies.entries()) {
      assert.equal(copy.getAttribute('data-color'),originals[index].getAttribute('data-color'),`${kind} ${value}: numeric/joker colour CSS hook`);
      assert.equal(copy.dataset.color,originals[index].dataset.color);
      assert.equal(copy.getAttribute('data-joker-type'),originals[index].getAttribute('data-joker-type'),`${kind} ${value}: type silhouette CSS hook`);
      assert.equal(copy.dataset.jokerType,originals[index].dataset.jokerType);
      assert.equal(copy.classList.contains('tile'),true);
      assert.equal(copy.getAttribute('data-tile'),null);assert.equal(copy.dataset.tile,undefined);
    }
    if(kind==='number')assert.ok(copies.every(tile=>tile.matches(`.tile[data-color="${value}"]`)));
    else assert.equal(ghost.querySelectorAll(`.tile[data-joker-type="${value}"]`).length,1);
    for(const node of [ghost,...ghost.querySelectorAll('*')]) {
      assert.equal(node.getAttribute('id'),null);
      for(const [name]of Object.entries(node.attributes))if(name.startsWith('data-'))assert.ok(node.matches('.tile') && ['data-color','data-joker-type'].includes(name),`interactive attribute ${name} must not survive`);
      for(const name of Object.keys(node.dataset))assert.ok(node.matches('.tile') && ['color','jokerType'].includes(name),`stale dataset ${name} must not survive`);
    }
    assert.equal(ghost.getAttribute('inert'),'');assert.equal(ghost.getAttribute('aria-hidden'),'true');
    assert.equal(ghost.querySelector('.split-group'),null);assert.equal(ghost.querySelector('[data-group]'),null);
    assert.equal(group.classList.contains('group-dragging'),true);
    pointer(f,'pointercancel',handle);
    assert.equal(f.document.querySelector('.group-drag-ghost'),null);assert.equal(f.pageAPI.drag(),null);
    assert.equal(handle.hasPointerCapture(71),false);assert.equal(group.classList.contains('group-dragging'),false);
    assert.deepEqual([...f.get('rack').children],rackNodes);assert.deepEqual([...canvas.children],boardNodes);
    assert.deepEqual(originals.map(tile=>({...tile.attributes})),originalAttributes);
    assert.equal(group.id,`source-group-${kind}-${value}`);assert.equal(handle.id,`source-handle-${kind}-${value}`);
    assert.deepEqual(plain(f.pageAPI.draft()),draft);assert.deepEqual(plain(f.pageAPI.committed()),committed);
    assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),layout);assert.deepEqual(plain(f.pageAPI.rackPositions()),rackPositions);
    assert.deepEqual([...f.sessionStorage.values],stored);assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  });
}


const SIX_FREE_GROUPS=[['red-10-a','red-11-a','red-12-a'],['blue-10-a','blue-11-a','blue-12-a'],['orange-10-a','orange-11-a','orange-12-a'],['black-1-a','black-2-a','black-3-a','black-4-a'],['red-1-a','red-2-a','red-3-a','red-4-a','red-5-a'],['blue-5-a','blue-6-a','blue-7-a']];
const closeSixPositions=()=>[100,222,344,100,264,470].map((x,i)=>({x:x/10000,y:(i<3?20:92)/10000}));
function assertFreeTableSpacing(f) {
  const fit=plain(f.pageAPI.tableFit()),rects=[...fit.positions,fit.newTarget];
  for(let i=0;i<rects.length;i++)for(const other of rects.slice(i+1))assert.equal(tableLayout.rectanglesIntersect(rects[i],other,38*fit.scale),false,'every free table group reserves one displayed tile of clearance');
  for(const rect of rects)assert.ok(rect.x>=-1e-7 && rect.y>=-1e-7 && rect.x+rect.width<=f.get('board').clientWidth-16+1e-7 && rect.y+rect.height<=f.get('board').clientHeight-16+1e-7,'all public groups and the new target stay inside one screen');
}
function actualFreeGroupDrag(f,index,point,target,cancel=false) {
  const fit=plain(f.pageAPI.tableFit()),source=fit.positions[index],canvas=f.get('board').querySelector('.table-canvas'),group=canvas.querySelectorAll('.meld')[index],handle=group.querySelector('[data-group]');
  group.getBoundingClientRect=()=>({left:8+source.x,top:8+source.y,right:8+source.x+source.width,bottom:8+source.y+source.height,width:source.width,height:source.height});
  f.document.elementFromPoint=()=>target??canvas;
  pointer(f,'pointerdown',handle,{x:8+source.x+5,y:8+source.y+5});pointer(f,'pointermove',handle,{x:point.x+13,y:point.y+13});
  if(cancel)pointer(f,'pointercancel',handle);else pointer(f,'pointerup',handle,{x:point.x+13,y:point.y+13});f.frame();
  return handle;
}
test('actual free table six saved mixed groups reserve spacing on restore, rotation, cancelled and whole-group free drops',async t=>{
  const original=tableView({board:SIX_FREE_GROUPS});original.game.boardPositions=closeSixPositions();
  const f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f);board.apply();
  assertFreeTableSpacing(f);const before=plain(f.pageAPI.draft()),positions=plain(f.pageAPI.captureBoardPositions()),saved=[...f.sessionStorage.values];
  const handle=actualFreeGroupDrag(f,2,{x:4,y:4},null,true);
  assert.deepEqual(plain(f.pageAPI.draft()),before);assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),positions);assert.deepEqual([...f.sessionStorage.values],saved);
  assert.equal(handle.hasPointerCapture(71),false);assert.equal(f.document.querySelector('.group-drag-ghost'),null);assert.equal(f.document.querySelector('.group-drop-preview'),null);
  for(const [width,height]of [[844,170],[358,600],[1280,500],[358,600]]) {board.size(width,height);assertFreeTableSpacing(f);assert.deepEqual(plain(f.pageAPI.draft()),before);}
  assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),positions,'returning to the same portrait viewport never creeps the repaired coordinates');
  actualFreeGroupDrag(f,2,{x:4,y:4});assertFreeTableSpacing(f);assert.deepEqual(plain(f.pageAPI.draft()),before);
  f.get('undo').dispatchEvent(new Event('click'));f.frame();assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),positions);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});
test('actual free table saved neighbors stay apart after growth and a real empty-canvas hand drop, then commit and reload the same geometry',async t=>{
  const store=createRoomStore({now:()=>10000,turnTimeoutMs:1800000,gameOptions:{firstTurnIndex:0,randomInt:max=>max-1}});t.after(()=>store.close());
  store.createTrustedRoom(USER,'原朋友',{code:CODE,roomId:'d'.repeat(32),gameType:'rummikub'});store.joinTrustedRoom(CODE,OTHER,'伙伴');let serial=0;
  const act=(user,type,extra={})=>store.trustedAction(CODE,user,{type,requestId:`free-spacing-${++serial}`,expectedRevision:store.getTrustedView(CODE,user).revision,...extra});
  act(USER,'ready',{ready:true});act(OTHER,'ready',{ready:true});act(USER,'start');
  const snapshot=store.exportSnapshot(CODE),game=snapshot.game,deck=rules.createDeck({copies:game.copies,jokerConfig:game.jokerConfig}),lookup=new Map(deck.map(tile=>[tile.id,tile]));
  const make=ids=>ids.map(id=>structuredClone(lookup.get(id)));game.board=SIX_FREE_GROUPS.map(make);
  game.boardPositions=[100,260,420,100,302,546].map((x,i)=>({x:x/10000,y:(i<3?20:130)/10000}));
  game.players[0].rack=make(['red-13-a','black-5-a','black-10-b','blue-10-b','orange-10-b','black-13-a']);game.players[1].rack=make(['black-12-b']);game.players.forEach(player=>{player.opened=true;});
  const used=new Set([...game.board.flat(),...game.players.flatMap(player=>player.rack)].map(tile=>tile.id));game.pool=deck.filter(tile=>!used.has(tile.id));store.importSnapshot(snapshot);
  const original=store.getTrustedView(CODE,USER),f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f);board.apply();assertFreeTableSpacing(f);
  const committed=plain(f.pageAPI.committed()),snapshotBefore=store.exportSnapshot(CODE);
  f.pageAPI.move('red-13-a','0');f.frame();assertFreeTableSpacing(f);f.pageAPI.move('black-5-a','3');f.frame();assertFreeTableSpacing(f);
  for(const id of ['black-10-b','blue-10-b','orange-10-b'])f.pageAPI.select(id);f.pageAPI.render();f.frame();
  const dragged=tileNode(f,'black-10-b'),canvas=board.apply(),fit=plain(f.pageAPI.tableFit()),neighbor=fit.positions[1];f.document.elementFromPoint=()=>canvas;
  pointer(f,'pointerdown',dragged,{x:120,y:320});pointer(f,'pointermove',dragged,{x:8+neighbor.x+neighbor.width+4,y:8+neighbor.y+27*fit.scale});pointer(f,'pointerup',dragged,{x:8+neighbor.x+neighbor.width+4,y:8+neighbor.y+27*fit.scale});f.frame();assertFreeTableSpacing(f);
  const current=plain(f.pageAPI.draft()),expected=plain(f.pageAPI.captureBoardPositions());assert.equal(current.board.length,7);assert.equal(current.rack.length,1);
  assert.deepEqual(current.board.at(-1).map(tile=>tile.id).toSorted(),['black-10-b','blue-10-b','orange-10-b'].toSorted());assert.deepEqual(plain(f.pageAPI.committed()),committed);assert.deepEqual(store.exportSnapshot(CODE),snapshotBefore);
  let sent;f.setAction(options=>{sent=JSON.parse(options.body);return json({view:store.trustedAction(CODE,USER,sent)});});f.get('commit').dispatchEvent(new Event('click'));await settle();f.frame();
  assert.equal(sent.type,'submit');assert.deepEqual(sent.boardPositions,expected);assert.deepEqual(sent.boardIds,current.board.map(group=>group.map(tile=>tile.id)));assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,1);
  const retained=store.exportSnapshot(CODE);assert.deepEqual(retained.game.boardPositions,expected);assert.equal(new Set([...retained.game.board.flat(),...retained.game.pool,...retained.game.players.flatMap(player=>player.rack)].map(tile=>tile.id)).size,deck.length);
  const fresh=await fixture(t,{initialView:store.getTrustedView(CODE,USER),geometry:true}),freshBoard=sizedProjectionBoard(fresh);freshBoard.apply();assertFreeTableSpacing(fresh);
  assert.deepEqual(plain(fresh.pageAPI.captureBoardPositions()),expected);assert.deepEqual(plain(fresh.pageAPI.draft().board),current.board);
  for(const [width,height]of [[844,170],[358,600],[1280,500],[358,600]]) {freshBoard.size(width,height);assertFreeTableSpacing(fresh);}
  assert.deepEqual(plain(fresh.pageAPI.captureBoardPositions()),expected);
});
test('actual free table collision clearance never turns an explicit group-on-group drop into movement and undo restores both groups',async t=>{
  const original=tableView({board:[['red-1-a','red-2-a','red-3-a'],['red-4-a','red-5-a','red-6-a'],['blue-1-a','blue-2-a','blue-3-a']]});original.game.boardPositions=[{x:.01,y:.002},{x:.0226,y:.002},{x:.0348,y:.002}];
  const f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f);board.apply();assertFreeTableSpacing(f);const before=plain(f.pageAPI.draft()),positions=plain(f.pageAPI.captureBoardPositions());
  const target=tileNode(f,'red-4-a');actualFreeGroupDrag(f,0,{x:240,y:30},target);
  assert.equal(f.pageAPI.draft().board.length,2);assert.deepEqual(plain(f.pageAPI.draft().board[0]).map(tile=>tile.id),['red-1-a','red-2-a','red-3-a','red-4-a','red-5-a','red-6-a']);assertFreeTableSpacing(f);
  f.get('undo').dispatchEvent(new Event('click'));f.frame();assert.deepEqual(plain(f.pageAPI.draft()),before);assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),positions);assertFreeTableSpacing(f);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);assert.equal(f.document.querySelector('.group-drag-ghost'),null);
});

test('actual free table near-limit saved points encode within the old coordinate contract and still recover clear visible groups',async t=>{
  const original=tableView({board:SIX_FREE_GROUPS});original.game.boardPositions=SIX_FREE_GROUPS.map((_,i)=>({x:.999-i*.0001,y:.999-i*.0001}));
  const before=structuredClone(original),f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f);board.apply();assertFreeTableSpacing(f);
  const encoded=plain(f.pageAPI.captureBoardPositions());assert.equal(encoded.length,6);assert.ok(encoded.every(point=>point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1));
  assert.deepEqual(original,before);assert.deepEqual(plain(f.pageAPI.draft().board),original.game.board);
  const restored=structuredClone(original);restored.game.boardPositions=encoded;
  const fresh=await fixture(t,{initialView:restored,geometry:true}),freshBoard=sizedProjectionBoard(fresh);freshBoard.apply();assertFreeTableSpacing(fresh);
  for(const [width,height]of [[844,170],[1280,500],[358,600]]) {freshBoard.size(width,height);assertFreeTableSpacing(fresh);}
  assert.ok(plain(fresh.pageAPI.captureBoardPositions()).every(point=>point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1));
  assert.deepEqual(plain(fresh.pageAPI.draft().board),original.game.board);assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);assert.equal(fresh.calls.filter(call=>call.url.endsWith('/actions')).length,0);
});

test('actual free table safe 110px row spacing remains exact through repeated viewport capture encode and fresh-device recovery',async t=>{
  const original=tableView({board:[['red-1-a','red-2-a','red-3-a'],['blue-1-a','blue-2-a','blue-3-a'],['orange-1-a','orange-2-a','orange-3-a'],['black-1-a','black-2-a','black-3-a']]});
  original.game.boardPositions=[{x:.01,y:0},{x:.026,y:0},{x:.01,y:.011},{x:.026,y:.011}];const expected=structuredClone(original.game.boardPositions),before=structuredClone(original);
  let recovered=structuredClone(original);
  for(let cycle=0;cycle<4;cycle++) {
    const f=await fixture(t,{initialView:recovered,geometry:true}),board=sizedProjectionBoard(f);
    for(const [width,height]of [[358,600],[190,60],[844,170],[1280,500],[358,600]]) {
      board.size(width,height);assertFreeTableSpacing(f);
      assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),expected,'safe coordinates stay exact even below the former .7 fixed-header breakpoint');
      assert.deepEqual(plain(f.pageAPI.draft().board),original.game.board);
    }
    recovered=structuredClone(original);recovered.game.boardPositions=plain(f.pageAPI.captureBoardPositions());
    assert.equal(f.calls.filter(call=>call.url.endsWith('/actions')).length,0);
  }
  assert.deepEqual(original,before);assert.deepEqual(recovered.game.boardPositions,expected);
});

const ROTATION_GROUPS=[['red-1-a','red-2-a','red-3-a'],['red-4-a','red-5-a','red-6-a'],['red-7-a','red-8-a','red-9-a'],
  ...[['blue',1],['blue',5],['blue',9],['black',1],['black',5],['black',9],['orange',1],['orange',5]].map(([color,start])=>Array.from({length:4},(_,i)=>`${color}-${start+i}-a`))];
function orientationView() {
  const view=tableView({board:ROTATION_GROUPS,rack:['red-10-a','black-13-b']});
  const first=tableLayout.fitGroupsToViewport(ROTATION_GROUPS.map((g,i)=>({id:String(i),length:g.length})),{width:358,height:600});
  view.game.boardPositions=first.positions.map(p=>({x:p.logicalX/10000,y:p.logicalY/10000}));return view;
}
const displayEncoded=fit=>fit.positions.map(p=>({x:p.logicalX/10000,y:p.logicalY/10000}));

test('actual orientation reflow enlarges forty-one public tiles after portrait landscape portrait while capture and private free placement never publish a layout edit',async t=>{
  const original=orientationView(),f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f);board.apply();
  const positions=structuredClone(original.game.boardPositions),points=plain(f.pageAPI.tablePoints()),before=plain(f.pageAPI.draft());
  for(const [width,height]of [[358,600],[701,128],[358,600],[701,128],[358,600]]) {
    board.size(width,height);const fit=plain(f.pageAPI.tableFit());assert.equal(fit.adaptiveReflow,true);
    assert.ok(fit.scale>=(width===358?.85:.6),'every returned view remains readable instead of a tiny saved-thumbnail');assertFreeTableSpacing(f);
    assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),positions);assert.deepEqual(plain(f.pageAPI.captureCommittedBoardPositions()),positions);
    assert.deepEqual(plain(f.pageAPI.tablePoints()),points);assert.deepEqual(plain(f.pageAPI.draft()),before);
  }
  f.pageAPI.move('black-13-b','rack',null,{rackX:240,rackY:30,grabX:0,grabY:0});f.frame();
  assert.deepEqual(plain(f.pageAPI.tablePoints()),points);assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),positions);assert.deepEqual(plain(f.pageAPI.draft()),before);
  f.timers.tick(1000);await settle();assert.equal(f.calls.filter(c=>c.url.endsWith('/actions')).length,0);
  assert.ok(f.calls.filter(c=>c.url.endsWith('/preview')).every(c=>!JSON.parse(c.options.body).boardIds),'view projection and private edits never become a changed public preview');
});

test('actual orientation reflow native whole-group movement materializes displayed anchors only after pointerup and undo restores the shared portrait arrangement',async t=>{
  const original=orientationView(),f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f);board.size(701,128);
  const before=plain(f.pageAPI.draft()),positions=plain(f.pageAPI.captureBoardPositions()),points=plain(f.pageAPI.tablePoints()),saved=[...f.sessionStorage.values];
  const handle=actualFreeGroupDrag(f,2,{x:40,y:70},null,true);
  assert.deepEqual(plain(f.pageAPI.tablePoints()),points);assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),positions);assert.deepEqual([...f.sessionStorage.values],saved);
  assert.equal(handle.hasPointerCapture(71),false);assert.equal(f.document.querySelector('.group-drag-ghost'),null);
  const fit=plain(f.pageAPI.tableFit()),expected=displayEncoded(fit);assert.equal(fit.adaptiveReflow,true);
  actualFreeGroupDrag(f,2,{x:40,y:70});const captured=plain(f.pageAPI.captureBoardPositions());
  assert.notDeepEqual(captured,positions);assert.deepEqual(captured.filter((_,i)=>i!==2),expected.filter((_,i)=>i!==2));
  assert.deepEqual(plain(f.pageAPI.draft()),before);assertFreeTableSpacing(f);assert.equal(f.calls.filter(c=>c.url.endsWith('/actions')).length,0);
  f.get('undo').dispatchEvent(new Event('click'));f.frame();assert.deepEqual(plain(f.pageAPI.tablePoints()),points);assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),positions);assertFreeTableSpacing(f);
});

test('actual orientation reflow explicit group merge keeps physical group order and undo while a submit persists the materialized display layout for fresh devices',async t=>{
  const store=createRoomStore({now:()=>10000,turnTimeoutMs:1800000,gameOptions:{firstTurnIndex:0,randomInt:max=>max-1}});t.after(()=>store.close());
  store.createTrustedRoom(USER,'原朋友',{code:CODE,roomId:'e'.repeat(32),gameType:'rummikub'});store.joinTrustedRoom(CODE,OTHER,'伙伴');let serial=0;
  const act=(user,type,extra={})=>store.trustedAction(CODE,user,{type,requestId:`rotation-${++serial}`,expectedRevision:store.getTrustedView(CODE,user).revision,...extra});
  act(USER,'ready',{ready:true});act(OTHER,'ready',{ready:true});act(USER,'start');
  const snapshot=store.exportSnapshot(CODE),game=snapshot.game,deck=rules.createDeck({copies:game.copies,jokerConfig:game.jokerConfig}),lookup=new Map(deck.map(t=>[t.id,t]));
  const make=ids=>ids.map(id=>structuredClone(lookup.get(id)));game.board=ROTATION_GROUPS.map(make);game.boardPositions=orientationView().game.boardPositions;
  game.players[0].rack=make(['red-10-a','black-13-b']);game.players[1].rack=make(['black-12-b']);game.players.forEach(p=>{p.opened=true;});
  const used=new Set([...game.board.flat(),...game.players.flatMap(p=>p.rack)].map(t=>t.id));game.pool=deck.filter(t=>!used.has(t.id));store.importSnapshot(snapshot);
  const original=store.getTrustedView(CODE,USER),beforeStore=store.exportSnapshot(CODE),f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f);board.size(701,128);
  actualFreeGroupDrag(f,0,{x:240,y:20},tileNode(f,'red-4-a'));
  assert.equal(f.pageAPI.draft().board.length,10);assert.deepEqual(plain(f.pageAPI.draft().board[0]).map(t=>t.id),['red-1-a','red-2-a','red-3-a','red-4-a','red-5-a','red-6-a']);
  assert.deepEqual(plain(f.pageAPI.draft().board.slice(1)),original.game.board.slice(2));assertFreeTableSpacing(f);
  f.get('undo').dispatchEvent(new Event('click'));f.frame();assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),original.game.boardPositions);
  f.pageAPI.move('red-10-a','2');f.frame();assertFreeTableSpacing(f);const draft=plain(f.pageAPI.draft()),expected=plain(f.pageAPI.captureBoardPositions());
  assert.deepEqual(store.exportSnapshot(CODE),beforeStore);let sent;
  f.setAction(options=>{sent=JSON.parse(options.body);return json({view:store.trustedAction(CODE,USER,sent)});});f.get('commit').dispatchEvent(new Event('click'));await settle();f.frame();
  assert.equal(sent.type,'submit');assert.deepEqual(sent.boardPositions,expected);assert.deepEqual(sent.boardIds,draft.board.map(g=>g.map(t=>t.id)));assert.deepEqual(store.exportSnapshot(CODE).game.boardPositions,expected);
  const fresh=await fixture(t,{initialView:store.getTrustedView(CODE,USER),geometry:true}),freshBoard=sizedProjectionBoard(fresh);
  for(const [width,height]of [[358,600],[701,128],[358,600]]) {freshBoard.size(width,height);assertFreeTableSpacing(fresh);assert.deepEqual(plain(fresh.pageAPI.captureBoardPositions()),expected);assert.deepEqual(plain(fresh.pageAPI.draft().board),draft.board);}
  const retained=store.exportSnapshot(CODE);assert.equal(new Set([...retained.game.board.flat(),...retained.game.pool,...retained.game.players.flatMap(p=>p.rack)].map(t=>t.id)).size,deck.length);
});

test('actual orientation reflow explicit organize captures a fixed shared layout through resize for submit and layout-only draw',async t=>{
  const original=orientationView(),f=await fixture(t,{initialView:original,geometry:true}),board=sizedProjectionBoard(f);board.size(701,128);
  f.get('board-arrange').dispatchEvent(new Event('click'));f.frame();const arranged=plain(f.pageAPI.captureBoardPositions()),points=plain(f.pageAPI.tablePoints());assert.notDeepEqual(arranged,original.game.boardPositions);
  for(const [width,height]of [[358,600],[1280,500],[701,128],[358,600]]) {
    board.size(width,height);assertFreeTableSpacing(f);assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),arranged);assert.deepEqual(plain(f.pageAPI.captureCommittedBoardPositions()),arranged);assert.deepEqual(plain(f.pageAPI.tablePoints()),points);
  }
  let sent;f.setAction(options=>{sent=JSON.parse(options.body);return json({view:endedTurnView(original,sent)});});f.get('draw').dispatchEvent(new Event('click'));await settle();f.frame();
  assert.equal(sent.type,'draw');assert.deepEqual(sent.boardPositions,arranged);assert.deepEqual(plain(f.pageAPI.captureBoardPositions()),arranged);assert.deepEqual(plain(f.pageAPI.draft().board),original.game.board);
});
