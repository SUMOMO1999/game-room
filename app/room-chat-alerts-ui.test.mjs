import * as entryPath from './entry-path.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import {gameViewport} from './game-viewport.mjs';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
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
    constructor(tag='div'){super();this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes={};this.dataset={};this.hidden=false;this.disabled=false;this.value='';this.open=false;this._text='';this._class='';this.style={values:new Map(),setProperty(name,value){this.values.set(name,value);},getPropertyValue(name){return this.values.get(name)??'';}};
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
    matches(selector){if(selector.includes(','))return selector.split(',').some(item=>this.matches(item.trim()));if(selector.startsWith('#'))return this.id===selector.slice(1);
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
const ROOM='synthetic-room',SELF='self',USER='a'.repeat(64),NOW=Date.now();
const msg=(n,fields={})=>({messageId:`m-${n}`,chatSequence:n,playerId:'other',name:'伙伴',text:`新消息 ${n}`,sentAt:NOW,expiresAt:NOW+86400000,...fields});
const packet=messages=>({roomId:ROOM,messages,oldestSequence:1,latestSequence:messages.at(-1)?.chatSequence||0,hasMore:false});
async function fixture(t,{savedMuted=false,visualViewport=null}={}) {
  const document=dom(await readFile(new URL('room.html',import.meta.url),'utf8')),timers=clock(),localStorage=storage(),window=new EventTarget(),cues=[];
  if(savedMuted)localStorage.setItem('game-room:chat-alerts:v1',JSON.stringify({version:1,muted:true}));
  Object.assign(window,{innerWidth:844,innerHeight:390,localStorage,setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,setInterval:()=>0,visualViewport});
  const context=vm.createContext({document,window,structuredClone,DOMException,TextEncoder,crypto,queueMicrotask,gameViewport,accountGeneration:()=>1,setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout});
  const {mountRoomChat}=await moduleIn(context,'room-chat.mjs');
  const chat=mountRoomChat({documentRef:document,windowRef:window,storage:localStorage,onCue:kind=>cues.push(kind)});
  const client={async chatHistory(){return packet([msg(1,{text:'原来的历史'})]);},async sendChat(body){return{roomId:ROOM,message:msg(100,{playerId:SELF,requestId:body.requestId,text:body.text})};}};
  chat.attach(client,{roomId:ROOM,roomCode:'123456',selfId:SELF},{mode:'mock',authenticated:true,userKey:USER});chat.connection('online');await settle();
  chat.receive(packet([msg(1,{text:'原来的历史'})]));await settle();
  t.after(()=>chat.clear());
  return {document,window,timers,cues,chat,client,localStorage,get:id=>document.getElementById(id),newMessage(n,fields={}){chat.receive(packet([msg(n,fields)]));}};
}

test('closed chat receives a safe visible live preview, a distinctive cue and prominent retained unread count',async t=>{
  const f=await fixture(t);assert.equal(f.get('room-chat-notice').hidden,true);assert.equal(f.cues.length,0);
  f.newMessage(2,{name:'<img src=x onerror=bad>',text:'<script>private literal</script> 来玩'});
  assert.equal(f.get('room-chat-notice').hidden,false);assert.equal(f.get('room-chat').hidden,true);assert.equal(f.get('chat-unread').textContent,'1');assert.equal(f.get('chat-toggle').classList.contains('has-unread'),true);
  const open=f.get('room-chat-notice').querySelector('.chat-notice-open');assert.match(open.textContent,/<img.*<script>/);assert.equal(open.querySelector('img'),null);assert.equal(open.querySelector('script'),null);assert.deepEqual(f.cues,['chat']);
  f.newMessage(2);assert.equal(f.cues.length,1);assert.equal(f.get('chat-unread').textContent,'1');
});
test('preview expires or is dismissed without losing unread; opening the preview reads the latest conversation',async t=>{
  const f=await fixture(t);f.newMessage(2);f.timers.tick(5500);assert.equal(f.get('room-chat-notice').hidden,true);assert.equal(f.get('room-chat-notice').textContent,'×');assert.equal(f.get('chat-unread').textContent,'1');
  f.newMessage(3);f.get('room-chat-notice').querySelector('.chat-notice-close').dispatchEvent(new Event('click'));assert.equal(f.get('room-chat-notice').hidden,true);assert.equal(f.get('chat-unread').textContent,'2');
  f.newMessage(4);f.get('room-chat-notice').querySelector('.chat-notice-open').dispatchEvent(new Event('click'));assert.equal(f.get('room-chat').hidden,false);assert.equal(f.get('chat-unread').hidden,true);assert.equal(f.get('room-chat-notice').hidden,true);
  f.newMessage(5);assert.equal(f.cues.length,3);assert.equal(f.get('room-chat-notice').hidden,true);
});
test('history recovery and unsolicited own messages never show an incoming preview or play chat sounds; new foreign messages still do',async t=>{
  const f=await fixture(t);f.chat.connection('offline');f.chat.receive(packet([msg(2)]));assert.equal(f.cues.length,0);
  f.chat.connection('online');await settle();f.chat.receive(packet([msg(3)]));assert.equal(f.cues.length,0);assert.equal(f.get('room-chat-notice').hidden,true);
  f.newMessage(4,{playerId:SELF});assert.equal(f.cues.length,0);f.newMessage(5);assert.deepEqual(f.cues,['chat']);
});
test('device do-not-disturb suppresses previews and sounds while preserving unread, survives reload and permits explicit re-enable',async t=>{
  const f=await fixture(t,{savedMuted:true});f.newMessage(2);assert.equal(f.cues.length,0);assert.equal(f.get('chat-unread').textContent,'1');assert.equal(f.get('room-chat-notice').hidden,true);
  f.get('chat-alerts-toggle').dispatchEvent(new Event('click'));assert.deepEqual(JSON.parse(f.localStorage.getItem('game-room:chat-alerts:v1')),{version:1,muted:false});f.newMessage(3);assert.equal(f.cues.length,1);
  f.get('chat-alerts-toggle').dispatchEvent(new Event('click'));assert.equal(f.get('room-chat-notice').hidden,true);assert.equal(f.get('room-chat-notice').textContent,'×');f.newMessage(4);assert.equal(f.cues.length,1);assert.equal(f.get('chat-unread').textContent,'3');
});
test('background, pagehide, 401 and 503 synchronously erase live preview text and fence late messages',async t=>{
  for(const kind of ['background','pagehide','401','503']) {
    const f=await fixture(t);f.newMessage(2,{text:`private ${kind}`});assert.equal(f.get('room-chat-notice').hidden,false);
    if(kind==='background'){f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));}
    else if(kind==='pagehide')f.window.dispatchEvent(new Event('pagehide'));
    else f.chat.clear({preserveDraft:kind==='503'});
    assert.equal(f.get('room-chat-notice').hidden,true);assert.equal(f.get('room-chat-notice').textContent,'×');f.newMessage(3,{text:'late private'});assert.equal(f.cues.length,1);assert.equal(f.get('room-chat-notice').textContent,'×');
  }
});
test('long and multiline messages have a bounded plain preview and a clear full-message entry',async t=>{
  const f=await fixture(t);f.newMessage(2,{text:'长'.repeat(200)+'\n下一行'});const text=f.get('room-chat-notice').querySelector('.chat-notice-text').textContent;
  assert.equal([...text].length,73);assert.equal(text.includes('\n'),false);assert.match(text,/…$/);assert.match(f.get('room-chat-notice').querySelector('.chat-notice-open').getAttribute('aria-label'),/打开房间聊天/);
});
test('own live SSE and POST show one quiet confirmation after acknowledgement without an incoming cue or unread',async t=>{
  const f=await fixture(t,{savedMuted:true}),reply=deferred(),sent=[];
  f.client.sendChat=body=>{sent.push(body);return reply.promise;};
  f.chat.model.setDraft('<script>自己的中文</script>');const sending=f.chat.model.send();
  const own=f.get('room-chat-own-notice');assert.equal(own.hidden,true);assert.equal(f.chat.model.snapshot().messages.length,1);
  const ack=msg(2,{playerId:SELF,requestId:sent[0].requestId,text:sent[0].text});f.chat.receive(packet([ack]));
  assert.equal(own.hidden,false);assert.equal(own.querySelector('.chat-notice-name').textContent,'我 · 已发送');
  assert.equal(own.querySelector('script'),null);assert.match(own.textContent,/<script>自己的中文<\/script>/);
  assert.equal(f.get('room-chat-notice').hidden,true);assert.equal(f.get('chat-unread').hidden,true);assert.deepEqual(f.cues,[]);
  reply.resolve({roomId:ROOM,message:ack});await sending;assert.equal(f.chat.model.snapshot().messages.length,2);
  f.timers.tick(5000);assert.equal(own.hidden,false);f.timers.tick(500);assert.equal(own.hidden,true);assert.equal(own.textContent,'×');
});
test('own full bubble stays in the open conversation; closing reveals its table confirmation without covering composer controls',async t=>{
  const f=await fixture(t);f.get('chat-toggle').dispatchEvent(new Event('click'));
  f.client.sendChat=async body=>({roomId:ROOM,message:msg(2,{playerId:SELF,requestId:body.requestId,text:body.text})});
  f.chat.model.setDraft('这一句是我发的');await f.chat.model.send();
  const own=f.get('room-chat-own-notice');assert.equal(own.hidden,true);assert.equal(f.get('room-chat').hidden,false);
  const mine=f.get('chat-messages').querySelector('.mine');assert.match(mine.textContent,/我.*这一句是我发的/);
  f.get('chat-close').dispatchEvent(new Event('click'));assert.equal(own.hidden,false);assert.deepEqual(f.cues,[]);assert.equal(f.chat.model.snapshot().unread,0);
  own.querySelector('.chat-notice-open').dispatchEvent(new Event('click'));assert.equal(own.hidden,true);assert.equal(own.textContent,'×');assert.equal(f.get('room-chat').hidden,false);
});
test('send failures and reconnect history never show an own table bubble; background and identity changes erase its text',async t=>{
  const f=await fixture(t);f.client.sendChat=async()=>{throw new TypeError('未确认');};
  f.chat.model.setDraft('失败消息');await f.chat.model.send();const pending=f.chat.model.snapshot().outbox[0];
  assert.equal(f.get('room-chat-own-notice').hidden,true);
  f.chat.connection('offline');f.chat.connection('online');await settle();
  f.chat.receive(packet([msg(2,{playerId:SELF,requestId:pending.requestId,text:pending.text})]));
  assert.equal(f.get('room-chat-own-notice').hidden,true);assert.deepEqual(f.cues,[]);
  f.client.sendChat=async body=>({roomId:ROOM,message:msg(3,{playerId:SELF,requestId:body.requestId,text:body.text})});
  f.chat.model.setDraft('自己的临时私有文本');await f.chat.model.send();assert.equal(f.get('room-chat-own-notice').hidden,false);
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.get('room-chat-own-notice').textContent,'×');assert.equal(f.get('room-chat-own-notice').hidden,true);
  f.document.hidden=false;f.chat.attach(f.client,{roomId:ROOM,roomCode:'123456',selfId:SELF},{mode:'mock',authenticated:true,userKey:USER});f.chat.connection('online');await settle();
  f.client.sendChat=async body=>({roomId:ROOM,message:msg(2,{playerId:SELF,requestId:body.requestId,text:body.text})});
  f.chat.model.setDraft('另一条临时文本');await f.chat.model.send();assert.equal(f.get('room-chat-own-notice').hidden,false);
  f.chat.clear();assert.equal(f.get('room-chat-own-notice').textContent,'×');assert.equal(f.get('room-chat-own-notice').hidden,true);
});
function key(fields) { const event=new Event('keydown',{cancelable:true});for(const [name,value] of Object.entries(fields))Object.defineProperty(event,name,{value});return event; }
function inputEvent(fields) { const event=new Event('input');for(const [name,value] of Object.entries(fields))Object.defineProperty(event,name,{value});return event; }
test('Chinese composition keeps visible text through incoming updates and cannot submit by Enter, 229 or form until it ends',async t=>{
  const f=await fixture(t),input=f.get('chat-input'),sends=[];f.get('chat-toggle').dispatchEvent(new Event('click'));
  f.client.sendChat=async body=>{sends.push(body);return{roomId:ROOM,message:msg(3,{playerId:SELF,requestId:body.requestId,text:body.text})};};
  input.dispatchEvent(new Event('compositionstart'));input.value='正在选中文词语';
  f.newMessage(2);assert.equal(input.value,'正在选中文词语');assert.equal(f.get('chat-send').disabled,true);
  input.dispatchEvent(key({key:'Enter',ctrlKey:true}));f.get('chat-form').dispatchEvent(new Event('submit',{cancelable:true}));
  input.dispatchEvent(key({key:'Escape'}));assert.equal(f.get('room-chat').hidden,false);assert.equal(sends.length,0);
  input.dispatchEvent(new Event('compositionend'));assert.equal(f.chat.model.snapshot().draft,'正在选中文词语');assert.equal(f.get('chat-send').disabled,false);
  input.dispatchEvent(key({key:'Enter',ctrlKey:true,keyCode:229}));input.dispatchEvent(key({key:'Enter',ctrlKey:true,isComposing:true}));
  input.dispatchEvent(key({key:'Enter'}));assert.equal(sends.length,0);
  input.dispatchEvent(key({key:'Enter',ctrlKey:true}));await settle();assert.equal(sends.length,1);assert.equal(sends[0].text,'正在选中文词语');
});
test('clearing identity during composition erases textarea text rather than preserving an unfinished private candidate',async t=>{
  const f=await fixture(t),input=f.get('chat-input');input.dispatchEvent(new Event('compositionstart'));input.value='原账号未完成的文字';
  f.chat.clear({preserveDraft:true});assert.equal(input.value,'');assert.equal(input.disabled,true);
  input.value='迟到的原账号组词';input.dispatchEvent(new Event('compositionend'));assert.equal(f.chat.model.snapshot().draft,'');assert.equal(input.value,'');
});
test('a late composition end from the previous room cannot overwrite the newly bound room draft',async t=>{
  const f=await fixture(t),input=f.get('chat-input');input.dispatchEvent(new Event('compositionstart'));input.value='旧房间组词';
  f.chat.attach(f.client,{roomId:ROOM,roomCode:'123456',selfId:SELF},{mode:'mock',authenticated:true,userKey:'b'.repeat(64)});
  f.chat.model.setDraft('新账号草稿');input.value='旧房间最后组词';input.dispatchEvent(new Event('compositionend'));
  assert.equal(input.value,'新账号草稿');assert.equal(f.chat.model.snapshot().draft,'新账号草稿');
});
test('late composed input, end and final WebKit input cannot cross identity or a same-seat rebind; fresh edits and composition recover',async t=>{
  for(const mode of ['new-account','clear-rebind'])for(const inputType of ['insertFromComposition','insertText']) {
    const f=await fixture(t),input=f.get('chat-input');f.chat.model.setDraft('已经记录的旧草稿');
    input.dispatchEvent(new Event('compositionstart'));input.value='尚未记录的旧组词';
    if(mode==='clear-rebind')f.chat.clear({preserveDraft:true});
    f.chat.attach(f.client,{roomId:ROOM,roomCode:'123456',selfId:SELF},{mode:'mock',authenticated:true,userKey:mode==='new-account'?'b'.repeat(64):USER});
    assert.equal(f.chat.model.snapshot().draft,mode==='new-account'?'':'已经记录的旧草稿');
    const current='新草稿 e\u0301';f.chat.model.setDraft(current);input.value='迟到的旧账号输入';input.dispatchEvent(inputEvent({isComposing:true,inputType:'insertCompositionText'}));
    assert.equal(f.chat.model.snapshot().draft,current);assert.equal(input.value,current);
    input.dispatchEvent(new Event('compositionend'));input.value='旧输入法最终文本';input.dispatchEvent(inputEvent({isComposing:false,inputType}));
    assert.equal(f.chat.model.snapshot().draft,current);assert.equal(input.value,current);
    // A programmatic refocus/render must not retire the fence for an old tail.
    input.dispatchEvent(new Event('focus'));input.value='再次迟到的旧文本';input.dispatchEvent(inputEvent({isComposing:false,inputType:'insertText'}));
    assert.equal(input.value,current);assert.equal(f.chat.model.snapshot().draft,current);
    if(mode==='new-account')input.dispatchEvent(key({key:'a'}));else input.dispatchEvent(new Event('pointerdown'));
    input.value='重新普通编辑';input.dispatchEvent(inputEvent({isComposing:false,inputType:'insertText'}));assert.equal(f.chat.model.snapshot().draft,'重新普通编辑');
    input.dispatchEvent(new Event('compositionstart'));const raw='新组词 は\u3099 e\u0301';input.value=raw;input.dispatchEvent(inputEvent({isComposing:true,inputType:'insertCompositionText'}));
    input.dispatchEvent(new Event('compositionend'));assert.equal(input.value,raw);assert.equal(f.chat.model.snapshot().draft,raw);
  }
});
test('the send button and counter use the server NFC character limit while a 500-character composed draft remains untouched',async t=>{
  const f=await fixture(t),input=f.get('chat-input'),raw='か\u3099'.repeat(500);input.dispatchEvent(new Event('compositionstart'));
  input.value=raw;input.dispatchEvent(inputEvent({isComposing:true,inputType:'insertCompositionText'}));input.dispatchEvent(new Event('compositionend'));
  assert.equal(input.value,raw);assert.equal(f.chat.model.snapshot().draft,raw);assert.equal(f.get('chat-send').disabled,false);assert.equal(f.get('chat-counter').textContent,'500/500');
  input.value='か\u3099'.repeat(501);input.dispatchEvent(inputEvent({isComposing:false,inputType:'insertText'}));
  assert.equal(input.value,'か\u3099'.repeat(501));assert.equal(f.get('chat-send').disabled,true);assert.match(f.get('chat-counter').textContent,/^501\/500/);
});
test('composition cancelled by blur preserves the candidate as a draft and permits a later deliberate submit',async t=>{
  const f=await fixture(t),input=f.get('chat-input'),sends=[];
  f.client.sendChat=async body=>{sends.push(body);return{roomId:ROOM,message:msg(2,{playerId:SELF,requestId:body.requestId,text:body.text})};};
  input.dispatchEvent(new Event('compositionstart'));input.value='离开输入法的草稿';input.dispatchEvent(new Event('blur'));
  assert.equal(f.chat.model.snapshot().draft,'离开输入法的草稿');assert.equal(f.get('chat-send').disabled,false);assert.equal(sends.length,0);
  f.get('chat-form').dispatchEvent(new Event('submit',{cancelable:true}));await settle();assert.equal(sends.length,1);assert.equal(sends[0].text,'离开输入法的草稿');
});
function visualFrame(fields={}) {
  return Object.assign(new EventTarget(),{width:844,height:390,scale:1,offsetTop:0,offsetLeft:0,...fields});
}
test('chat returns to the real normal-scale canvas origin after keyboard or orientation leaves a stale WebKit offset',async t=>{
  const visual=visualFrame({offsetTop:240,offsetLeft:20}),f=await fixture(t,{visualViewport:visual}),style=f.get('room-chat').style;
  assert.equal(style.getPropertyValue('--chat-viewport-top'),'0px');assert.equal(style.getPropertyValue('--chat-viewport-left'),'0px');
  Object.assign(visual,{width:390,height:844,offsetTop:195});f.window.dispatchEvent(new Event('pageshow'));
  assert.equal(style.getPropertyValue('--chat-viewport-width'),'844px');assert.equal(style.getPropertyValue('--chat-viewport-height'),'390px');
  assert.equal(style.getPropertyValue('--chat-viewport-top'),'0px');
  visual.dispatchEvent(new Event('scroll'));assert.equal(style.getPropertyValue('--chat-viewport-top'),'0px');
});
test('chat preserves genuine keyboard and zoom geometry but clears keyboard offsets as soon as editing ends',async t=>{
  const visual=visualFrame({height:180,offsetTop:190,offsetLeft:8}),f=await fixture(t,{visualViewport:visual}),style=f.get('room-chat').style;
  f.document.activeElement=f.get('chat-input');f.document.dispatchEvent(new Event('focusin'));
  assert.equal(style.getPropertyValue('--chat-viewport-height'),'180px');assert.equal(style.getPropertyValue('--chat-viewport-top'),'190px');
  assert.equal(style.getPropertyValue('--chat-viewport-left'),'8px');
  f.document.activeElement=null;f.document.dispatchEvent(new Event('focusout'));await settle();
  assert.equal(style.getPropertyValue('--chat-viewport-top'),'0px');assert.equal(style.getPropertyValue('--chat-viewport-left'),'0px');
  Object.assign(visual,{scale:2,width:422,height:195,offsetTop:90,offsetLeft:211});visual.dispatchEvent(new Event('resize'));
  assert.equal(style.getPropertyValue('--chat-viewport-top'),'90px');assert.equal(style.getPropertyValue('--chat-viewport-left'),'211px');
  assert.equal(style.getPropertyValue('--chat-viewport-width'),'422px');assert.equal(style.getPropertyValue('--chat-viewport-height'),'195px');
});
test('compact composer states follow actual visual height across tiny landscape keyboard, offsets, portrait and restoration',async t=>{
  const visual=visualFrame(),f=await fixture(t,{visualViewport:visual}),panel=f.get('room-chat'),input=f.get('chat-input');
  f.document.activeElement=input;input.value='输入仍完整可见';input.dispatchEvent(new Event('input'));
  for(const height of [180,150,128]) {
    Object.assign(visual,{height,offsetTop:56});visual.dispatchEvent(new Event('resize'));
    assert.equal(panel.classList.contains('chat-compact'),true);assert.equal(panel.classList.contains('chat-compressed'),true);assert.equal(panel.classList.contains('chat-keyboard'),true);
    assert.equal(panel.style.getPropertyValue('--chat-viewport-height'),`${height}px`);assert.equal(panel.style.getPropertyValue('--chat-viewport-top'),'56px');
    assert.equal(input.value,'输入仍完整可见');assert.equal(f.get('chat-send').disabled,false);
  }
  f.window.innerWidth=390;f.window.innerHeight=844;Object.assign(visual,{width:390,height:480,offsetTop:40});visual.dispatchEvent(new Event('resize'));
  assert.equal(panel.classList.contains('chat-compact'),false);assert.equal(panel.classList.contains('chat-keyboard'),true);assert.equal(panel.style.getPropertyValue('--chat-viewport-top'),'40px');
  f.document.activeElement=null;Object.assign(visual,{width:390,height:844,offsetTop:112});f.document.dispatchEvent(new Event('focusout'));await settle();
  assert.equal(panel.classList.contains('chat-keyboard'),false);assert.equal(panel.style.getPropertyValue('--chat-viewport-top'),'0px');assert.equal(input.value,'输入仍完整可见');
});
test('dense short chat keeps pending retry controls and IME while compressing, then restores its normal layout when pending clears',async t=>{
  const visual=visualFrame({height:420}),f=await fixture(t,{visualViewport:visual}),panel=f.get('room-chat'),input=f.get('chat-input');
  f.client.sendChat=async()=>{throw new Error('发送结果尚未确认，可重试。');};
  f.chat.model.setDraft('尚未确认的原正文');await f.chat.model.send();
  const pending=structuredClone(f.chat.model.snapshot().outbox[0]);
  assert.equal(panel.classList.contains('chat-has-outbox'),true);assert.equal(panel.classList.contains('chat-compact'),true);
  assert.match(f.get('chat-outbox').textContent,/尚未确认的原正文.*重试确认.*移除/);
  input.dispatchEvent(new Event('compositionstart'));input.value='输入法仍在组词';
  for(const height of [420,380,360,220,180,150,128]){
    Object.assign(visual,{height});visual.dispatchEvent(new Event('resize'));
    assert.equal(panel.classList.contains('chat-compact'),true);
    assert.equal(panel.classList.contains('chat-compressed'),height<280);
    assert.deepEqual(f.chat.model.snapshot().outbox[0],pending,'viewport changes keep the exact unknown send and request id');
    assert.equal(input.value,'输入法仍在组词');assert.equal(f.get('chat-send').disabled,true,'composition still controls sending');
    assert.match(f.get('chat-outbox').textContent,/重试确认.*移除/);
  }
  Object.assign(visual,{height:420});visual.dispatchEvent(new Event('resize'));f.chat.model.discard(pending.requestId);
  assert.equal(panel.classList.contains('chat-has-outbox'),false);assert.equal(panel.classList.contains('chat-compact'),false);
  assert.equal(panel.classList.contains('chat-compressed'),false);assert.equal(input.value,'输入法仍在组词');
  input.dispatchEvent(new Event('compositionend'));assert.equal(f.chat.model.snapshot().draft,'输入法仍在组词');assert.equal(f.get('chat-send').disabled,false);
});
test('notice anchors follow visible header and turn-heading bounds, ignore hidden room content and stay hidden in a tiny editing frame',async t=>{
  const visual=visualFrame(),f=await fixture(t,{visualViewport:visual}),header=f.document.querySelector('.site-header'),heading=f.document.querySelector('.game-heading');
  header.getBoundingClientRect=()=>({top:6,bottom:42,width:844,height:36});
  heading.getBoundingClientRect=()=>({top:44,bottom:74,width:844,height:30});
  f.client.sendChat=async body=>({roomId:ROOM,message:msg(2,{playerId:SELF,requestId:body.requestId,text:body.text})});
  f.chat.model.setDraft('本次确认');await f.chat.model.send();const own=f.get('room-chat-own-notice');
  assert.equal(own.style.getPropertyValue('--chat-notice-top'),'46px');assert.equal(own.hidden,false);
  f.get('room-play').hidden=false;visual.dispatchEvent(new Event('resize'));
  assert.equal(own.style.getPropertyValue('--chat-notice-top'),'78px');
  f.newMessage(3);assert.equal(f.get('room-chat-notice').style.getPropertyValue('--chat-notice-top'),'78px');
  f.document.activeElement=f.get('chat-input');Object.assign(visual,{height:128,offsetTop:56});visual.dispatchEvent(new Event('resize'));
  assert.equal(own.hidden,true);assert.equal(f.get('room-chat-notice').hidden,true);assert.match(own.textContent,/本次确认/);
  f.document.activeElement=null;Object.assign(visual,{height:390,offsetTop:0});visual.dispatchEvent(new Event('resize'));
  assert.equal(own.hidden,false);assert.equal(f.get('room-chat-notice').hidden,false);
  f.timers.tick(5500);assert.equal(own.textContent,'×');assert.equal(own.hidden,true);
});

test('declared notice anchors survive a display-contents header and ignore hidden or empty anchors',async t=>{
  const f=await fixture(t),header=f.document.querySelector('.site-header');
  header.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:0,width:0,height:0});
  const anchor=f.document.createElement('div');anchor.setAttribute('data-chat-notice-anchor','');
  anchor.getBoundingClientRect=()=>({left:550,top:6,right:835,bottom:50,width:285,height:44});header.append(anchor);
  const empty=f.document.createElement('div');empty.setAttribute('data-chat-notice-anchor','');
  empty.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:500,width:0,height:0});header.append(empty);
  const hidden=f.document.createElement('section');hidden.hidden=true;
  const hiddenAnchor=f.document.createElement('div');hiddenAnchor.setAttribute('data-chat-notice-anchor','');
  hiddenAnchor.getBoundingClientRect=()=>({left:0,top:0,right:800,bottom:600,width:800,height:600});hidden.append(hiddenAnchor);f.document.body.append(hidden);
  f.newMessage(2);
  const incoming=f.get('room-chat-notice');assert.equal(incoming.hidden,false);
  assert.equal(incoming.style.getPropertyValue('--chat-notice-top'),'54px');
  f.client.sendChat=async body=>({roomId:ROOM,message:msg(3,{playerId:SELF,requestId:body.requestId,text:body.text})});
  f.chat.model.setDraft('自己的提醒也避开操作栏');await f.chat.model.send();
  const own=f.get('room-chat-own-notice');assert.equal(own.hidden,false);
  assert.equal(own.style.getPropertyValue('--chat-notice-top'),'54px');
  anchor.getBoundingClientRect=()=>({left:300,top:2,right:560,bottom:46,width:260,height:44});
  f.window.dispatchEvent(new Event('resize'));
  assert.equal(incoming.style.getPropertyValue('--chat-notice-top'),'50px');
  assert.equal(own.style.getPropertyValue('--chat-notice-top'),'50px');
});

test('declared play surfaces dismiss both temporary bubbles without losing unread messages or the composing draft',async t=>{
  const f=await fixture(t);let messageSequence=1;
  for(const label of ['棋盘','选机','回合操作']) {
    const surface=f.document.createElement('section');surface.setAttribute('data-chat-dismiss-notices','');
    const target=f.document.createElement('button');surface.append(target);f.document.body.append(surface);
    f.newMessage(++messageSequence,{text:`${label}之前朋友发来的消息`});
    f.client.sendChat=async body=>({roomId:ROOM,message:msg(++messageSequence,{playerId:SELF,requestId:body.requestId,text:body.text})});
    f.chat.model.setDraft('刚确认发送的消息');await f.chat.model.send();
    f.chat.model.setDraft(`${label}时仍保留的草稿`);
    const before=f.chat.model.snapshot();
    assert.equal(f.get('room-chat-notice').hidden,false);assert.equal(f.get('room-chat-own-notice').hidden,false);
    const pointer=new Event('pointerdown');Object.defineProperty(pointer,'target',{value:target});f.document.dispatchEvent(pointer);
    assert.equal(f.get('room-chat-notice').hidden,true);assert.equal(f.get('room-chat-own-notice').hidden,true);
    assert.equal(f.get('room-chat-notice').textContent,'×');assert.equal(f.get('room-chat-own-notice').textContent,'×');
    assert.equal(f.chat.model.snapshot().unread,before.unread);assert.equal(f.chat.model.snapshot().draft,before.draft);
    assert.deepEqual(f.chat.model.snapshot().messages,before.messages);assert.equal(f.get('chat-input').value,before.draft);
  }
  assert.equal(f.get('chat-unread').textContent,'3');assert.deepEqual(f.cues,['chat','chat','chat']);
});
