import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readRuntimeSource as readFile} from './test-support/runtime-source.mjs';
import {drawingTestDOM} from './test-support/drawing-page-dom.mjs';
import * as roomClock from './platform/room-clock.mjs';
import * as roomSession from './platform/room-session.mjs';
import * as roomAudio from './platform/room-audio-controls.mjs';
import * as roomViewport from './platform/room-viewport.mjs';
import * as roomSettings from './platform/room-settings.mjs';
import * as presentation from './platform/room-presentation.mjs';
import * as entryPath from './entry-path.mjs';
import * as routing from './game-routing.mjs';
import * as lobby from './lobby-model.mjs';
import * as gameViewport from './game-viewport.mjs';
import * as canvas from './games/draw-and-guess/canvas-view.mjs';
import * as matcher from './games/draw-and-guess/matcher.mjs';
import * as practiceNavigation from './platform/practice-navigation.mjs';
import * as actionIntent from './platform/room-action-intent.mjs';
import {createGameAudio} from './game-audio.mjs';

const USER='a'.repeat(64),OTHER='b'.repeat(64),CODE='123456';
const auth=(user=USER)=>({mode:'mock',authenticated:true,loginReady:true,drawingEnabled:true,userKey:user,csrf:'synthetic-csrf',profile:{nickname:'虚构成员'},recentRooms:[]});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const storage=()=>{const values=new Map();return {get length(){return values.size;},key:i=>[...values.keys()][i],getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),values};};
const settle=async()=>{for(let index=0;index<16;index++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function loadModule(context,file) {
  const source=await readFile(new URL(file,import.meta.url),'utf8'),names=[...source.matchAll(/^export (?:async )?(?:function|class|const)\s+(\w+)/gm)].map(match=>match[1]);
  // Only the independent PWA installation module is replaced. Auth, bootstrap,
  // RoomClient, chat, session, private rendering and canvas code are executed.
  const code=source.replace(/^import[\s\S]*?;\s*/gm,'').replace(/^export /gm,'').replace("import('../../app-shell.mjs')","Promise.resolve()");
  return vm.runInContext(`(()=>{${code}\nreturn {${names.join(',')}};})()`,context,{filename:file});
}
async function fixture(t,{missingId=null,playing=false}={}) {
  const document=drawingTestDOM('<head></head><body><main id="drawing-root"></main></body>',{missingId}),window=new EventTarget(),sessionStorage=storage(),localStorage=storage();
  const location={hostname:'127.0.0.1',search:`?code=${CODE}`,href:`http://127.0.0.1/drawing.html?code=${CODE}`,replace(url){this.replaced=url;},reload(){this.reloaded=true;}};
  Object.assign(window,{location,sessionStorage,localStorage,navigator:{},innerWidth:1024,innerHeight:768,visualViewport:null,setInterval:()=>0,clearInterval(){},setTimeout,clearTimeout});document.defaultView=window;
  let nextState=auth(),status=200,actionGate=null;const calls=[],streams=[],watchers=[],receipts=[],actions=[];
  const room=()=>({gameType:'draw-and-guess',roomId:'synthetic-room',roomCode:CODE,selfId:'self',selfRole:'player',hostId:'self',revision:1,matchId:playing?'synthetic-match':null,phase:playing?'playing':'waiting',pause:null,spectators:[],actionReceipts:structuredClone(receipts),drawConfig:{rounds:2,drawingSeconds:120,contentSelection:{packId:'dg-base',version:1,categoryIds:['daily'],difficulties:['easy']}},players:[{id:'self',name:'虚构成员',ready:true},{id:'friend',name:'虚构伙伴',ready:true}],game:playing?{matchId:'synthetic-match',turnId:'dg-turn-1',stage:'drawing',status:'playing',turnPlayerId:'friend',revision:1,settings:{rounds:2,drawingSeconds:120},round:1,totalTurns:4,turnNumber:1,players:[{id:'self',score:0},{id:'friend',score:0}],guessedPlayerIds:[],canGuess:true}:null});
  const fetch=async(url,options={})=>{calls.push(url);if(url==='/api/state')return json(nextState,status);if(url===`/api/rooms/${CODE}`)return json({view:room()});if(url.endsWith('/actions')){const body=JSON.parse(options.body);actions.push(body);if(actionGate)await actionGate.promise;receipts.push({requestId:body.requestId,status:'committed',guessResult:{correct:false,points:0}});return json({view:room()});}if(url.endsWith('/canvas'))return json({bootId:'synthetic-boot',canvasId:playing?'synthetic-canvas':null,roomId:'synthetic-room',matchId:playing?'synthetic-match':null,turnId:playing?'dg-turn-1':null,stage:playing?'drawing':'waiting',deadline:null,paused:false,sequence:0,clearGeneration:0,leaseGeneration:0,strokes:[],pointCount:0});if(url.includes('/chat'))return json({roomId:'synthetic-room',messages:[],hasOlder:false});if(url.endsWith('/events')){let controller;const body=new ReadableStream({start(value){controller=value;value.enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify(room())}\n\n`));}});streams.push(controller);options.signal?.addEventListener('abort',()=>{try{controller.close();}catch{}});return new Response(body,{headers:{'Content-Type':'text/event-stream'}});}throw new Error(`Unexpected synthetic request ${url}`);};
  const context=vm.createContext({document,window,location,navigator:{},sessionStorage,localStorage,fetch,URL,URLSearchParams,Response,ReadableStream,TextDecoder,TextEncoder,AbortController,DOMException,Event,EventTarget,structuredClone,performance,crypto,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},queueMicrotask,createGameAudio,...roomClock,...roomSession,...roomAudio,...roomViewport,...roomSettings,...presentation,...entryPath,...routing,...lobby,...gameViewport,...canvas,...matcher,...practiceNavigation,...actionIntent});
  const account=await loadModule(context,'account-client.mjs');Object.assign(context,account);context.watchAccountLifecycle=options=>{const watcher=account.watchAccountLifecycle(options);watchers.push(watcher);return watcher;};
  Object.assign(context,await loadModule(context,'room-client.mjs'));Object.assign(context,await loadModule(context,'room-chat.mjs'));
  const pageModule=await loadModule(context,'games/draw-and-guess/game-page.mjs'),ui=await pageModule.bootDrawingRoom({document,window});await settle();
  t.after(()=>{watchers.forEach(watcher=>watcher.stop());window.dispatchEvent(new Event('pagehide'));try{ui.destroy();}catch{}});
  return {ui,document,window,sessionStorage,calls,account,pageModule,actions,
    holdGuess(){actionGate=deferred();return actionGate;},
    foreignReceipt(){receipts.push({requestId:'another-device',status:'committed',guessResult:{correct:false,points:0}});streams.at(-1).enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify(room())}\n\n`));},
    async revalidate(value,responseStatus=200){nextState=value;status=responseStatus;await watchers[0].refresh();await settle();}};
}
test('real account → boot → shared chat → room/canvas → SSE reaches a usable waiting page',async t=>{
  const f=await fixture(t);assert.equal(f.document.getElementById('drawing-gate').hidden,true);assert.equal(f.document.getElementById('drawing-waiting').hidden,false);assert.equal(f.document.getElementById('chat-legacy-note').hidden,true);assert.equal(f.document.getElementById('chat-toggle').hidden,false);assert.ok(f.calls.includes(`/api/rooms/${CODE}/canvas`));assert.ok(f.calls.includes(`/api/rooms/${CODE}/events`));assert.equal(f.document.getElementById('drawing-ready').disabled,false);
});
test('waiting room code and invitation do not depend on the compact connection label and clear when access is concealed',async t=>{
  const f=await fixture(t),code=f.document.getElementById('drawing-room-code'),copy=f.document.getElementById('drawing-waiting-copy');
  assert.equal(code.hidden,false);assert.equal(code.textContent,'房间 '+CODE);assert.equal(copy.disabled,false);
  let invitation;f.window.navigator.clipboard={async writeText(value){invitation=value;}};
  copy.dispatchEvent(new Event('click'));await settle();
  assert.equal(invitation,`http://127.0.0.1/?room=${CODE}`);assert.equal(f.actions.length,0);
  await f.revalidate({error:'expired'},401);
  assert.equal(code.hidden,true);assert.equal(code.textContent,'');assert.equal(copy.disabled,true);
  await f.revalidate(auth());assert.equal(code.hidden,false);assert.equal(code.textContent,'房间 '+CODE);
});
test('missing required shared-chat DOM cannot leave an infinite loader or private nodes',async t=>{
  const f=await fixture(t,{missingId:'chat-legacy-note'});assert.match(f.document.getElementById('drawing-root').textContent,/房间暂时无法恢复/);assert.match(f.document.getElementById('drawing-root').textContent,/重新载入.*返回大厅/);assert.equal(f.document.getElementById('drawing-guess-input'),null);assert.equal(f.calls.some(url=>url.includes('/canvas')),false);
});
test('503 preserves same-owner guess text; 401 and identity switch clear standard drafts without resurrecting them',async t=>{
  const f=await fixture(t,{playing:true}),input=f.document.getElementById('drawing-guess-input');input.value='纸船';input.dispatchEvent(new Event('input'));
  const prefix=`game-room.private-draft.${USER}.`;assert.equal([...f.sessionStorage.values.keys()].filter(key=>key.startsWith(prefix)).length,1);
  await f.revalidate({error:'temporary'},503);assert.equal(f.document.getElementById('drawing-guess-input').value,'');assert.equal([...f.sessionStorage.values.values()].includes('纸船'),true);
  await f.revalidate(auth());assert.equal(f.document.getElementById('drawing-guess-input').value,'纸船');
  for(const id of ['drawing-roster-full','drawing-results','drawing-config-content','drawing-pack','drawing-aliases'])f.document.getElementById(id).textContent='旧房间私有内容';
  await f.revalidate({error:'expired'},401);assert.equal([...f.sessionStorage.values.keys()].some(key=>key.startsWith(prefix)),false);assert.equal(f.document.getElementById('drawing-guess-input').value,'');
  for(const id of ['drawing-roster-full','drawing-results','drawing-config-content','drawing-pack','drawing-aliases'])assert.equal(f.document.getElementById(id).textContent,'');
  await f.revalidate(auth());assert.equal(f.document.getElementById('drawing-guess-input').value,'');
  input.value='雨伞';input.dispatchEvent(new Event('input'));await f.revalidate(auth(OTHER));assert.equal([...f.sessionStorage.values.keys()].some(key=>key.startsWith(prefix)),false);assert.equal(f.document.getElementById('drawing-guess-input').value,'');
});
test('real guess intent ignores another-device receipt and owning response preserves later input edits',async t=>{
  const f=await fixture(t,{playing:true}),gate=f.holdGuess(),input=f.document.getElementById('drawing-guess-input');
  input.value='纸船';input.dispatchEvent(new Event('input'));f.document.getElementById('drawing-guess-form').dispatchEvent(new Event('submit',{cancelable:true}));await settle();
  assert.equal(f.actions.length,1);assert.equal(f.actions[0].matchId,'synthetic-match');assert.equal(f.actions[0].turnId,'dg-turn-1');assert.equal(f.actions[0].text,'纸船');
  f.foreignReceipt();await settle();assert.equal(input.value,'纸船');
  input.value='雨伞';input.dispatchEvent(new Event('input'));gate.resolve();await settle();
  assert.equal(input.value,'雨伞');assert.match(f.document.getElementById('drawing-guess-feedback').textContent,/还没猜对/);assert.equal(f.actions.length,1);
});
test('member scores remain in the shared settings at 844×390 and open one modal at a time',async t=>{
  const f=await fixture(t);f.window.innerWidth=844;f.window.innerHeight=390;f.window.dispatchEvent(new Event('resize'));
  const member=f.document.getElementById('drawing-roster-open'),settings=f.document.getElementById('drawing-settings-dialog'),roster=f.document.getElementById('drawing-roster-dialog');
  assert.equal(settings.contains(member),true);assert.equal(member.closest('.drawing-footer'),null);assert.equal(member.hidden,false);
  f.document.getElementById('drawing-settings').dispatchEvent(new Event('click'));assert.equal(settings.open,true);
  member.dispatchEvent(new Event('click'));assert.equal(settings.open,false);assert.equal(roster.open,true);assert.equal(f.document.querySelectorAll('dialog[open]').length,1);assert.match(f.document.getElementById('drawing-roster-full').textContent,/虚构成员.*虚构伙伴/);
  const css=await readFile(new URL('games/draw-and-guess/styles.css',import.meta.url),'utf8');assert.match(css,/\.drawing-page button\{min-height:44px;min-width:44px/);assert.doesNotMatch(css,/\.drawing-footer button\{/);
  const lowLandscape=css.match(/@media \(orientation:landscape\) and \(max-height:500px\)\{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(lowLandscape);assert.match(lowLandscape,/\.drawing-players\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.doesNotMatch(lowLandscape,/\.drawing-players\{[^}]*display:none/u);
  assert.match(css,/@media \(orientation:landscape\) and \(max-height:320px\)\{\.drawing-players\{display:none\}\}/u);
  assert.ok(f.document.getElementById('drawing-hint').parentElement.classList.contains('drawing-stage-bar'));
  assert.ok(f.document.getElementById('drawing-paint-status').parentElement.classList.contains('drawing-sidebar'));
  assert.equal(f.document.getElementById('drawing-canvas-slot').parentElement.children.length,1);
  assert.doesNotMatch(css,/\.drawing-paint-status\{display:none\}/u);
});
