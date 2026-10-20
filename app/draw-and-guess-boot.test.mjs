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
import { initializeGameAppearance, mountGameAppearancePicker } from './platform/game-appearance.mjs';
import { GAME_THEMES, initializeGameTheme } from './platform/game-theme.mjs';
import * as presentation from './platform/room-presentation.mjs';
import * as entryPath from './entry-path.mjs';
import * as routing from './game-routing.mjs';
import * as lobby from './lobby-model.mjs';
import * as gameViewport from './game-viewport.mjs';
import * as canvas from './games/draw-and-guess/canvas-view.mjs';
import * as paperCamera from './games/draw-and-guess/paper-camera.mjs';
import {createDrawingPracticeSession} from './games/draw-and-guess/practice-engine.mjs';
import * as matcher from './games/draw-and-guess/matcher.mjs';
import * as practiceNavigation from './platform/practice-navigation.mjs';
import * as actionIntent from './platform/room-action-intent.mjs';
import * as drawingExperience from './games/draw-and-guess/experience-ui.mjs';
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
async function fixture(t,{missingId=null,playing=false,earlyAppearance=false,drawer=false}={}) {
  const document=drawingTestDOM('<head><meta name="theme-color" content="#173a31"></head><body><main id="drawing-root"></main></body>',{missingId}),window=new EventTarget(),sessionStorage=storage(),localStorage=storage();
  const location={hostname:'127.0.0.1',search:`?code=${CODE}`,href:`http://127.0.0.1/drawing.html?code=${CODE}`,replace(url){this.replaced=url;},reload(){this.reloaded=true;}};
  Object.assign(window,{location,sessionStorage,localStorage,navigator:{},innerWidth:1024,innerHeight:768,visualViewport:null,setInterval:()=>0,clearInterval(){},setTimeout,clearTimeout});document.defaultView=window;
  // The HTML's early bootstrap can run before the game factory mounts the
  // original settings. Exercise that order with the actual controller.
  const appearanceController=earlyAppearance?initializeGameAppearance(document,{scope:'draw-and-guess'}):null;
  let nextState=auth(),status=200,actionGate=null,leaveGate=null,nextRoom=null;const calls=[],streams=[],watchers=[],receipts=[],actions=[];
  const room=()=>nextRoom??({gameType:'draw-and-guess',roomId:'synthetic-room',roomCode:CODE,selfId:'self',selfRole:'player',hostId:'self',revision:1,matchId:playing?'synthetic-match':null,phase:playing?'playing':'waiting',pause:null,spectators:[],actionReceipts:structuredClone(receipts),drawConfig:{rounds:2,drawingSeconds:120,contentSelection:{packId:'dg-base',version:1,categoryIds:['daily'],difficulties:['easy']}},players:[{id:'self',name:'虚构成员',ready:true},{id:'friend',name:'虚构伙伴',ready:true}],game:playing?{matchId:'synthetic-match',turnId:'dg-turn-1',stage:'drawing',status:'playing',turnPlayerId:drawer?'self':'friend',revision:1,settings:{rounds:2,drawingSeconds:120},round:1,totalTurns:4,turnNumber:1,players:[{id:'self',score:0},{id:'friend',score:0}],guessedPlayerIds:[],canGuess:!drawer}:null});
  const fetch=async(url,options={})=>{calls.push(url);if(url==='/api/state')return json(nextState,status);if(url===`/api/rooms/${CODE}`)return json({view:room()});if(url.endsWith('/actions')){const body=JSON.parse(options.body);actions.push(body);if(body.type==='leave')return leaveGate?await leaveGate.promise:json({left:true});if(actionGate)await actionGate.promise;receipts.push({requestId:body.requestId,status:'committed',guessResult:{correct:false,points:0}});return json({view:room()});}if(url.endsWith('/canvas'))return json({bootId:'synthetic-boot',canvasId:playing?'synthetic-canvas':null,roomId:'synthetic-room',matchId:playing?'synthetic-match':null,turnId:playing?'dg-turn-1':null,stage:playing?'drawing':'waiting',deadline:null,paused:false,sequence:0,clearGeneration:0,leaseGeneration:0,strokes:[],pointCount:0});if(url.includes('/chat'))return json({roomId:'synthetic-room',messages:[],hasOlder:false});if(url.endsWith('/events')){let controller;const body=new ReadableStream({start(value){controller=value;value.enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify(room())}\n\n`));}});streams.push(controller);options.signal?.addEventListener('abort',()=>{try{controller.close();}catch{}});return new Response(body,{headers:{'Content-Type':'text/event-stream'}});}throw new Error(`Unexpected synthetic request ${url}`);};
  const context=vm.createContext({document,window,location,navigator:{},sessionStorage,localStorage,fetch,URL,URLSearchParams,Response,ReadableStream,TextDecoder,TextEncoder,AbortController,DOMException,Event,EventTarget,structuredClone,performance,crypto,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},queueMicrotask,createGameAudio,mountGameAppearancePicker,...roomClock,...roomSession,...roomAudio,...roomViewport,...roomSettings,...presentation,...entryPath,...routing,...lobby,...gameViewport,...canvas,...paperCamera,...matcher,...practiceNavigation,...actionIntent,...drawingExperience});
  const account=await loadModule(context,'account-client.mjs');Object.assign(context,account);context.watchAccountLifecycle=options=>{const watcher=account.watchAccountLifecycle(options);watchers.push(watcher);return watcher;};
  Object.assign(context,await loadModule(context,'room-client.mjs'));Object.assign(context,await loadModule(context,'room-chat.mjs'));
  const pageModule=await loadModule(context,'games/draw-and-guess/game-page.mjs'),ui=await pageModule.bootDrawingRoom({document,window});await settle();
  t.after(()=>{watchers.forEach(watcher=>watcher.stop());window.dispatchEvent(new Event('pagehide'));try{ui.destroy();}catch{}});
  if(!missingId){
    const appearance=document.getElementById('appearance-dialog');
    assert.equal(appearance?.parentNode,document.body,'The real shared menu mounts outside the game root');
    assert.equal(appearance.getAttribute('aria-labelledby'),'appearance-title');
    const styles=appearance.querySelectorAll('[name="appearance-style"]');
    assert.deepEqual(styles.map(node=>node.value),['paper','glass','soft']);
    assert.equal(styles.filter(node=>node.checked).length,1);
    assert.equal(appearance.querySelectorAll('[name="appearance-palette"]').length,6);
    assert.equal(appearance.querySelectorAll('[name="appearance-background"]').length,8);
  }
  return {ui,document,window,sessionStorage,localStorage,appearanceController,calls,account,pageModule,actions,
    roomView:()=>structuredClone(room()),setRoomView(next){nextRoom=structuredClone(next);},
    pushView(next){streams.at(-1).enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify(next)}\n\n`));},
    holdGuess(){actionGate=deferred();return actionGate;},
    holdLeave(){leaveGate=deferred();return leaveGate;},
    foreignReceipt(){receipts.push({requestId:'another-device',status:'committed',guessResult:{correct:false,points:0}});streams.at(-1).enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify(room())}\n\n`));},
    async revalidate(value,responseStatus=200){nextState=value;status=responseStatus;await watchers[0].refresh();await settle();}};
}
test('real account → boot → shared chat → room/canvas → SSE reaches a usable waiting page',async t=>{
  const f=await fixture(t);assert.equal(f.document.getElementById('drawing-gate').hidden,true);assert.equal(f.document.getElementById('drawing-waiting').hidden,false);assert.equal(f.document.getElementById('chat-legacy-note').hidden,true);assert.equal(f.document.getElementById('chat-toggle').hidden,false);assert.ok(f.calls.includes(`/api/rooms/${CODE}/canvas`));assert.ok(f.calls.includes(`/api/rooms/${CODE}/events`));assert.equal(f.document.getElementById('drawing-ready').disabled,false);
});
test('the real shared appearance menu changes local presentation without replacing the private draft or losing expanded controls',async t=>{
  const f=await fixture(t,{playing:true}),doc=f.document,input=doc.getElementById('drawing-guess-input');
  input.value='纸船';input.dispatchEvent(new Event('input'));
  const settingsButton=doc.getElementById('drawing-settings'),settings=doc.getElementById('drawing-settings-dialog'),menu=doc.getElementById('appearance-dialog');
  settingsButton.dispatchEvent(new Event('click'));assert.equal(settings.open,true);
  settings.querySelector('[data-open-appearance]').dispatchEvent(new Event('click'));
  assert.equal(settings.open,false);assert.equal(menu.open,true);
  const glass=menu.querySelectorAll('[name="appearance-style"]').find(node=>node.value==='glass');
  glass.dispatchEvent(new Event('change'));
  assert.equal(doc.documentElement.dataset.gameAppearance,'glass');assert.equal(doc.getElementById('appearance-backgrounds').hidden,false);
  const custom=menu.querySelector('.appearance-custom-colors'),palette=menu.querySelector('[name="appearance-palette"]');
  custom.open=true;palette.focus();palette.dispatchEvent(new Event('change'));
  assert.equal(menu.querySelector('.appearance-custom-colors'),custom);assert.equal(custom.open,true);assert.equal(doc.activeElement,palette);assert.equal(palette.checked,true);
  assert.equal(doc.getElementById('drawing-guess-input'),input);assert.equal(input.value,'纸船');assert.equal(f.actions.length,0);
  menu.querySelector('[data-close-appearance]').dispatchEvent(new Event('click'));
  assert.equal(menu.open,false);assert.equal(doc.activeElement,settingsButton);
});
test('early appearance bootstrap keeps all six original themes usable and restores the edited material after every legacy choice',async t=>{
  const f=await fixture(t,{playing:true,earlyAppearance:true}),doc=f.document,controller=f.appearanceController;
  const settings=doc.getElementById('drawing-settings-dialog'),section=settings.querySelector('[data-theme-picker]');
  const entry=settings.querySelector('[data-open-appearance]'),cards=section.querySelectorAll('[data-theme-choice]');
  assert.equal(section.hidden,false);assert.deepEqual(cards.map(card=>card.dataset.themeChoice),GAME_THEMES.map(theme=>theme.id));
  assert(cards.every(card=>!card.hidden&&!card.disabled));assert.equal(entry.parentNode,section.parentNode);assert.equal(entry.nextSibling,section);
  const input=doc.getElementById('drawing-guess-input');input.value='纸船';input.dispatchEvent(new Event('input'));
  doc.getElementById('drawing-settings').dispatchEvent(new Event('click'));entry.dispatchEvent(new Event('click'));
  const menu=doc.getElementById('appearance-dialog'),glass=menu.querySelectorAll('[name="appearance-style"]').find(node=>node.value==='glass');
  glass.dispatchEvent(new Event('change'));
  const preset=menu.querySelector('#appearance-preset');preset.value='builtin-glass-reading';preset.dispatchEvent(new Event('change'));
  const accent=menu.querySelector('#appearance-accent');accent.value='#123456';accent.dispatchEvent(new Event('input'));
  menu.querySelectorAll('[name="appearance-background"]').find(node=>node.value==='6').dispatchEvent(new Event('change'));
  const edited=controller.state();assert.equal(edited.activeStyle,'glass');assert.equal(edited.sets.glass.tokens.accent,'#123456');
  assert.equal(edited.sets.glass.tokens.background,6);assert.equal(edited.presetIds.glass,'builtin-glass-reading');
  const assertNewSelection=()=>{
    assert.equal(doc.documentElement.dataset.gameAppearance,'glass');assert(cards.every(card=>card.getAttribute('aria-pressed')==='false'));
    assert.match(section.querySelector('.theme-note').textContent,/当前外观.*保留/);
    assert.equal(menu.querySelector('#appearance-current').textContent.includes('玻璃'),true);
  };
  assertNewSelection();
  // A legacy owner may refresh independently. Its earlier picker subscriber
  // must not overwrite the mutually exclusive appearance selection or tint.
  const legacy=initializeGameTheme(doc),tint=doc.querySelector('meta[name="theme-color"]')?.getAttribute('content');
  legacy.set('midnight');assertNewSelection();
  assert.equal(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content'),tint);
  for(const theme of GAME_THEMES){
    menu.querySelector('[data-close-appearance]').dispatchEvent(new Event('click'));
    doc.getElementById('drawing-settings').dispatchEvent(new Event('click'));
    const card=cards.find(node=>node.dataset.themeChoice===theme.id);
    // This minimal EventTarget DOM has no ancestor propagation. Deliver the
    // real document capture handler before the real legacy button handler.
    const click=new Event('click',{bubbles:true});Object.defineProperty(click,'target',{value:card});doc.dispatchEvent(click);card.dispatchEvent(click);
    assert.equal(controller.state().activeStyle,null);assert.deepEqual(controller.state().sets,edited.sets);assert.deepEqual(controller.state().presetIds,edited.presetIds);
    assert.equal(legacy.current(),theme.id);assert.equal(f.localStorage.getItem('game-room.theme.v1'),theme.id);
    assert.equal(doc.documentElement.dataset.gameAppearance,undefined);
    assert.equal(cards.filter(node=>node.getAttribute('aria-pressed')==='true').length,1);assert.equal(card.getAttribute('aria-pressed'),'true');
    assert.equal(section.querySelector('.theme-note').textContent,`当前：${theme.name}。只记住这台设备的选择，不影响其他玩家。`);
    entry.dispatchEvent(new Event('click'));glass.dispatchEvent(new Event('change'));
    assert.deepEqual(controller.state(),edited);assertNewSelection();
    assert.equal(doc.getElementById('drawing-guess-input'),input);assert.equal(input.value,'纸船');assert.equal(f.actions.length,0);
  }
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
test('real drawing exit maps its owning request to busy, preserves the retry identity and clears after an acknowledged leave',async t=>{
  const f=await fixture(t,{playing:true}),doc=f.document,confirm=doc.getElementById('drawing-leave-confirm'),dialog=doc.getElementById('drawing-leave-dialog');
  doc.getElementById('drawing-exit').dispatchEvent(new Event('click'));assert.equal(dialog.open,true);assert.equal(confirm.getAttribute('aria-busy'),null);
  const first=f.holdLeave();confirm.dispatchEvent(new Event('click'));
  assert.equal(confirm.getAttribute('aria-busy'),'true');assert.equal(f.actions.length,1);assert.equal(f.actions[0].type,'leave');
  confirm.dispatchEvent(new Event('click'));assert.equal(f.actions.length,1,'the existing exit owner deduplicates a pending confirmation');
  first.resolve(json({error:'退出结果暂未确认'},500));await settle();
  assert.equal(confirm.getAttribute('aria-busy'),null);assert.equal(dialog.open,true);assert.match(doc.getElementById('drawing-leave-status').textContent,/退出结果暂未确认/);
  const second=f.holdLeave();confirm.dispatchEvent(new Event('click'));assert.equal(confirm.getAttribute('aria-busy'),'true');
  assert.equal(f.actions.length,2);assert.equal(f.actions[1].requestId,f.actions[0].requestId,'busy paint does not replace the original retry identity');
  second.resolve(json({left:true}));await settle();
  assert.equal(confirm.getAttribute('aria-busy'),null);assert.equal(dialog.open,false);assert.equal(f.window.location.href,'./');
});
test('real drawing leave busy is cleared on identity conceal or destroy and late responses cannot restore it',async t=>{
  for(const end of ['conceal','destroy']){
    const f=await fixture(t,{playing:true}),doc=f.document,waiting=f.holdLeave(),confirm=doc.getElementById('drawing-leave-confirm');
    doc.getElementById('drawing-exit').dispatchEvent(new Event('click'));confirm.dispatchEvent(new Event('click'));
    assert.equal(confirm.getAttribute('aria-busy'),'true');assert.equal(f.actions.length,1);
    if(end==='conceal')await f.revalidate({error:'expired'},401);else f.ui.destroy();
    assert.equal(confirm.getAttribute('aria-busy'),null);const status=doc.getElementById('drawing-leave-status').textContent;
    waiting.resolve(json({error:'原身份迟到退出失败'},503));await settle();
    assert.equal(confirm.getAttribute('aria-busy'),null);assert.equal(doc.getElementById('drawing-leave-status').textContent,status);assert.equal(f.actions.length,1);
  }
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
  assert.equal(f.document.getElementById('drawing-recovery').hidden,true,'an ordinary in-flight guess must not flash the unknown-result recovery panel');
  input.value='雨伞';input.dispatchEvent(new Event('input'));gate.resolve();await settle();
  assert.equal(input.value,'雨伞');assert.match(f.document.getElementById('drawing-guess-feedback').textContent,/还没猜对/);assert.equal(f.actions.length,1);
});
test('member scores remain in the shared settings at 844×390 and open one modal at a time',async t=>{
  const f=await fixture(t);f.window.innerWidth=844;f.window.innerHeight=390;f.window.dispatchEvent(new Event('resize'));
  const member=f.document.getElementById('drawing-roster-open'),settings=f.document.getElementById('drawing-settings-dialog'),roster=f.document.getElementById('drawing-roster-dialog');
  assert.equal(settings.contains(member),true);assert.equal(member.closest('.drawing-footer'),null);assert.equal(member.hidden,false);
  f.document.getElementById('drawing-settings').dispatchEvent(new Event('click'));assert.equal(settings.open,true);
  member.dispatchEvent(new Event('click'));assert.equal(settings.open,false);assert.equal(roster.open,true);assert.equal(f.document.querySelectorAll('dialog[open]').length,1);assert.match(f.document.getElementById('drawing-roster-full').textContent,/虚构成员.*虚构伙伴/);
  // The public roster is persistent beside/before the canvas, with the full
  // accessible member/mute dialog retained in settings on every viewport.
  const strip=f.document.getElementById('drawing-players');
  assert.equal(strip.parentElement.classList.contains('drawing-page'),true);
  assert.equal(strip.querySelectorAll('.drawing-player').length,2);
  assert.equal(f.document.getElementById('drawing-skip').parentElement.classList.contains('drawing-stage-bar'),true);
  // User moved the microphone and drawing controls into one stable bottom bar.
  assert.equal(f.document.getElementById('drawing-tools').parentElement.classList.contains('drawing-bottom-bar'),true);

});

function pointer(target,type,fields={}) {
  const event=new Event(type,{cancelable:true});
  for(const [key,value] of Object.entries({button:0,pointerId:1,clientX:60,clientY:80,isPrimary:true,...fields}))Object.defineProperty(event,key,{value});
  target.dispatchEvent(event);return event;
}
function escape(document){const event=new Event('keydown');Object.defineProperty(event,'key',{value:'Escape'});document.dispatchEvent(event);}
async function practiceFixture(t,{slowAcquire=false,slowRead=false,legacyRead=false,isolateReadView=false}={}) {
  let accountUser=USER;
  const document=drawingTestDOM('<head><meta name="theme-color" content="#173a31"></head><body><main id="drawing-root"></main></body>'),window=new EventTarget(),sessionStorage=storage(),localStorage=storage();
  const location={hostname:'127.0.0.1',search:'',href:'http://127.0.0.1/drawing-practice.html',replace(url){this.replaced=url;}};
  Object.assign(window,{location,sessionStorage,localStorage,navigator:{},innerWidth:390,innerHeight:844,visualViewport:null,setInterval:()=>0,clearInterval(){},setTimeout,clearTimeout});document.defaultView=window;
  const context=vm.createContext({document,window,location,navigator:{},sessionStorage,localStorage,fetch:async()=>json(auth(accountUser)),URL,URLSearchParams,Response,ReadableStream,TextDecoder,TextEncoder,AbortController,DOMException,Event,EventTarget,structuredClone,performance,crypto,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},queueMicrotask,createGameAudio,mountGameAppearancePicker,...roomClock,...roomSession,...roomAudio,...roomViewport,...roomSettings,...presentation,...entryPath,...routing,...lobby,...gameViewport,...canvas,...paperCamera,...matcher,...practiceNavigation,...actionIntent,...drawingExperience});
  Object.assign(context,await loadModule(context,'account-client.mjs'));
  const pageModule=await loadModule(context,'games/draw-and-guess/game-page.mjs');
  // The real local canvas engine, not a fake lease or ink collector, owns every
  // read/acquire/append. Only the optional transport delay is synthetic.
  const session=createDrawingPracticeSession({storage:localStorage}),calls=[],gate=deferred(),readGate=deferred();let ui,readViewUpdates=0;
  ui=pageModule.createDrawingGamePage({mode:'practice',document,window,canvasRequest:async(type,input)=>{
    calls.push(type);if(type==='read'&&slowRead)await readGate.promise;if(type==='acquire'&&slowAcquire)await gate.promise;
    let response=await session.request(type,input);
    if(type==='read'&&legacyRead){response=structuredClone(response);delete response.geometry;}
    if(type!=='read'||!isolateReadView){if(type==='read')readViewUpdates++;ui?.applyView(session.view(),{baseline:true});}
    return response;
  }});
  ui.applyView(session.view(),{baseline:true});await settle();
  t.after(()=>{ui.destroy();session.destroy();});
  return {ui,document,window,session,calls,resumeAcquire:()=>gate.resolve(),resumeRead:()=>readGate.resolve(),readViewUpdates:()=>readViewUpdates,async setAccount(user){accountUser=user;await context.loadAccount();}};
}
test('the real practice page draws and persists the first stroke directly, including ink preview during delayed writer acquisition',async t=>{
  const f=await practiceFixture(t,{slowAcquire:true}),doc=f.document,paper=doc.getElementById('drawing-canvas');
  assert.equal(doc.getElementById('drawing-acquire'),null);assert.equal(f.calls.includes('acquire'),false,'mounting does not take the writer lease');
  assert.equal(f.ui.paint.state().canAcquire,true);
  pointer(paper,'pointerdown');pointer(paper,'pointermove',{clientX:180,clientY:160});pointer(paper,'pointerup',{clientX:180,clientY:160});
  assert.equal(f.calls.filter(type=>type==='acquire').length,1);assert.equal(f.ui.paint.state().pending,1);assert.equal(f.ui.paint.state().busy,true);
  assert.equal(doc.getElementById('drawing-empty').hidden,true,'the first line has an immediate bounded local preview');
  assert.equal(f.calls.includes('append'),false,'unverified ink cannot be submitted before writer acquisition');
  f.resumeAcquire();await settle();await new Promise(resolve=>setTimeout(resolve,410));await settle();
  const saved=await f.session.request('read');
  assert.equal(saved.strokes.length,1);assert.equal(saved.strokes[0].points.length,2);assert.equal(saved.pointCount,2);
  assert.deepEqual(saved.strokes[0].points,[[.1,.2],[.3,.4]]);
  assert.equal(f.ui.paint.state().pending,0);assert.equal(f.ui.paint.state().pointCount,2);assert.equal(f.calls.filter(type=>type==='append').length,1);
});
test('the mounted page keeps a held pen through orientation recovery and delayed viewport fits',async t=>{
  const f=await practiceFixture(t),paper=f.document.getElementById('drawing-canvas');
  await f.ui.paint.acquire();
  pointer(paper,'pointerdown',{clientX:60,clientY:80});pointer(paper,'pointermove',{clientX:180,clientY:160});
  Object.assign(f.window,{innerWidth:844,innerHeight:390});
  paper.getBoundingClientRect=()=>({left:0,top:0,width:300,height:200});
  f.window.dispatchEvent(new Event('orientationchange'));
  await new Promise(resolve=>setTimeout(resolve,370));await settle();
  pointer(paper,'pointermove',{clientX:120,clientY:140});pointer(paper,'pointerup',{clientX:120,clientY:140});
  await new Promise(resolve=>setTimeout(resolve,410));await settle();
  const saved=await f.session.request('read');
  assert.equal(saved.strokes.length,1);
  assert.deepEqual(saved.strokes[0].points.at(-1),[.4,.7]);
  assert.equal(f.ui.paint.state().pending,0);
});
// The user explicitly removed the obsolete zoom controls. Retain the useful
// role, turn, privacy, geometry and focus checks that used to share that path.
test('fixed paper has no obsolete zoom controls and resizing never takes the writer',async t=>{
  const f=await practiceFixture(t),doc=f.document,paper=doc.getElementById('drawing-canvas');
  const logical={width:paper.width,height:paper.height};
  for(const id of ['drawing-zoom','drawing-pan','drawing-fit'])assert.equal(doc.getElementById(id),null);
  f.window.innerWidth=390;f.window.innerHeight=844;f.window.dispatchEvent(new Event('resize'));await settle();
  assert.equal(paper.width,logical.width);assert.equal(paper.height,logical.height);
  assert.equal(f.calls.includes('acquire'),false);assert.equal(f.calls.includes('append'),false);
});
test('focus closes configuration with first Escape, then exits with second; conceal clears private paint',async t=>{
  const f=await fixture(t,{playing:true,drawer:true}),doc=f.document,root=doc.getElementById('drawing-root');
  doc.getElementById('drawing-focus').dispatchEvent(new Event('click'));
  doc.getElementById('drawing-tools-toggle').dispatchEvent(new Event('click'));escape(doc);
  assert.equal(doc.getElementById('drawing-tool-panel').hidden,true);assert.equal(root.classList.contains('drawing-focus'),true);
  escape(doc);assert.equal(root.classList.contains('drawing-focus'),false);
  doc.getElementById('drawing-focus').dispatchEvent(new Event('click'));await f.revalidate({error:'expired'},401);
  assert.equal(root.classList.contains('drawing-focus'),false);assert.equal(f.ui.paint.state().pending,0);
  assert.equal(f.ui.paint.state().pointCount,0);assert.equal(f.ui.paint.state().canAcquire,false);assert.equal(doc.getElementById('drawing-gate').hidden,false);
});
for(const transition of ['reveal','guesser'])test(`same-question score update preserves paint; ${transition} revokes drawing without hiding people`,async t=>{
  const f=await fixture(t,{playing:true,drawer:true}),doc=f.document;
  const score=f.roomView();score.revision=2;score.game.revision=2;score.game.players[1].score=10;
  f.pushView(score);await settle();assert.equal(doc.getElementById('drawing-tools').hidden,false);
  const next=structuredClone(score);next.revision=3;next.game.revision=3;
  if(transition==='reveal'){next.game.stage='reveal';next.game.word={answer:'纸船',aliases:[]};next.game.turnResult={drawerScore:0,guesses:[]};}
  else{next.game.turnPlayerId='friend';next.game.canGuess=true;}
  f.ui.applyView(next);
  assert.equal(doc.getElementById('drawing-tools').hidden,true);assert.equal(f.ui.paint.state().canAcquire,false);
  assert.equal(doc.getElementById('drawing-guess-form').hidden,transition==='reveal');
  assert.equal(doc.getElementById('drawing-players').querySelectorAll('.drawing-player').length,2);
});
for(const change of ['turn','match'])test(`new ${change} discards unconfirmed ink and retains the fixed paper`,async t=>{
  const f=await fixture(t,{playing:true,drawer:true}),doc=f.document,paper=doc.getElementById('drawing-canvas');
  const before={width:paper.width,height:paper.height};const next=f.roomView();next.revision=2;next.game.revision=2;
  if(change==='turn'){next.game.turnId='dg-turn-2';next.game.turnNumber=2;}else{next.matchId='synthetic-next-match';next.game.matchId=next.matchId;}
  f.ui.applyView(next);await settle();assert.equal(f.ui.paint.state().pending,0);
  assert.equal(doc.getElementById('drawing-tools').hidden,false);assert.equal(paper.width,before.width);assert.equal(paper.height,before.height);
});
test('account identity change resets focus and configuration without a removed camera dependency',async t=>{
  const f=await practiceFixture(t),doc=f.document;await f.setAccount(USER);f.ui.applyView(f.session.view(),{baseline:true});
  doc.getElementById('drawing-focus').dispatchEvent(new Event('click'));await f.setAccount(OTHER);f.ui.applyView(f.session.view(),{baseline:true});
  assert.equal(doc.getElementById('drawing-tool-panel').hidden,true);assert.equal(f.ui.paint.state().pending,0);
});

for(const legacy of [false,true])test(`authoritative ${legacy?'legacy missing':'new 16:9'} geometry resolves after viewport recovery timers and immediately owns the panel aspect`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await practiceFixture(t,{slowRead:true,legacyRead:legacy,isolateReadView:true}),root=f.document.getElementById('drawing-root'),paper=f.document.getElementById('drawing-canvas');
  assert.equal(f.calls.filter(type=>type==='read').length,1);
  assert.equal(root.style.getPropertyValue('--drawing-paper-aspect'),'1024 / 768');
  assert.equal(paper.height,768,'the pending initial read still uses the safe 4:3 fallback');
  // Let every real viewport recovery callback (0/100/350ms) run while the
  // authoritative read remains gated. No sleep or subsequent fit masks it.
  f.window.dispatchEvent(new Event('pageshow'));t.mock.timers.tick(400);await settle();
  assert.equal(root.style.getPropertyValue('--drawing-paper-aspect'),'1024 / 768');
  assert.equal(f.readViewUpdates(),0);assert.equal(f.calls.filter(type=>type==='read').length,1);
  f.resumeRead();await settle();
  assert.equal(f.readViewUpdates(),0,'the request fixture did not call ui.applyView when the read completed');
  assert.equal(paper.width,1024);assert.equal(paper.height,legacy?768:576);
  assert.equal(root.style.getPropertyValue('--drawing-paper-aspect'),legacy?'1024 / 768':'1024 / 576');
  assert.equal(f.calls.includes('acquire'),false);assert.equal(f.calls.includes('append'),false);
});
