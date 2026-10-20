import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRoomVoiceControls } from './platform/room-voice-controls.mjs';
import { drawingTestDOM } from './test-support/drawing-page-dom.mjs';

function fixture({joined=true,compact=false}={}) {
  const doc=drawingTestDOM('<body><div id="voice"></div><div id="voice-header"></div><div id="voice-microphone"></div><div id="voice-status"></div></body>'),win=new EventTarget(),root=doc.getElementById('voice');
  const calls={press:0,releaseHold:0,open:[],join:0,leave:0,destroy:0,listen:0},changes=[];
  let update,state={supported:true,joined,joining:false,speaking:false,mode:'off',mic:'granted',message:'',playbackBlocked:false,peers:[]};
  const voice={state:()=>state,press(){calls.press++;state={...state,mode:'hold',speaking:true};update(state);return Promise.resolve(true);},
    releaseHold(){calls.releaseHold++;if(state.mode==='hold'){state={...state,mode:'off',speaking:false};update(state);}},
    setOpen(value){calls.open.push(value);state={...state,mode:value?'open':'off',speaking:value};update(state);return Promise.resolve(value);},
    join(){calls.join++;state={...state,joined:true,mode:'off',speaking:false};update(state);return Promise.resolve(true);},
    leave(){calls.leave++;state={...state,joined:false,joining:false,mode:'off',speaking:false};update(state);},
    resumeAudio(){calls.listen++;return Promise.resolve(true);},destroy(){calls.destroy++;}};
  const controls=mountRoomVoiceControls({root,transport:{},document:doc,window:win,compact:compact?{joinRoot:doc.getElementById('voice-header'),microphoneRoot:doc.getElementById('voice-microphone'),statusRoot:doc.getElementById('voice-status')}:null,onState:s=>changes.push(s),createVoice:options=>{update=options.onChange;return voice;}});
  const query=name=>doc.querySelector('.room-voice-'+name),fire=(target,name,fields={})=>{
    const event=new Event(name,{cancelable:true});Object.assign(event,fields);target.dispatchEvent(event);return event;
  };
  return {controls,voice,doc,win,root,calls,changes,query,fire,change(value){state={...state,...value};update(state);}};
}

test('two fixed speaking labels and control nodes survive pending permission, speech, roster and connection changes',()=>{
  const f=fixture(),held=f.query('talk'),open=f.query('open'),panel=f.controls.element,join=f.query('join');
  try{for(const state of [{mic:'requesting',mode:'hold'},{speaking:true,mic:'granted'},{mode:'open'},{mode:'off',speaking:false},
      {peers:[{playerId:'p2',speaking:true,muted:false}]}]){
    f.change(state);f.controls.setMembers([{id:'p2',name:'很长很长的朋友名字'}]);
    assert.equal(f.query('talk'),held);assert.equal(f.query('open'),open);assert.equal(f.query('join'),join);
    assert.equal(held.textContent,'按住');assert.equal(open.textContent,'一直说');assert.equal(panel.hidden,false);
  }
  }finally{f.controls.destroy();}
});

test('split voice presentation joins listen-only in the header and uses one stable microphone toggle without a hold control',()=>{
 const f=fixture({joined:false,compact:true}),join=f.query('join'),mic=f.query('open');try{
  assert.equal(f.query('talk'),null);assert.equal(join.parentElement,f.doc.getElementById('voice-header'));assert.equal(mic.parentElement,f.doc.getElementById('voice-microphone'));
  assert.equal(mic.disabled,true);f.fire(join,'click');assert.equal(f.calls.join,1);assert.equal(f.voice.state().mode,'off');assert.deepEqual(f.calls.open,[]);
  f.fire(mic,'click');assert.equal(mic.getAttribute('aria-pressed'),'true');assert.equal(f.voice.state().mode,'open');
  for(const state of [{mic:'requesting'},{speaking:true,mic:'granted'},{playbackBlocked:true},{captureInterrupted:true},{audioRecovering:true}]){
   f.change(state);assert.equal(f.query('join'),join);assert.equal(f.query('open'),mic);assert.equal(f.query('talk'),null);assert.equal(mic.disabled,false);
  }
  f.fire(f.win,'blur');f.doc.hidden=true;f.fire(f.doc,'visibilitychange');assert.equal(f.voice.state().mode,'open');assert.equal(f.calls.leave,0);
  f.fire(mic,'click');assert.equal(f.voice.state().mode,'off');assert.deepEqual(f.calls.open,[true,false]);assert.equal(f.calls.press,0);
 }finally{f.controls.destroy();}
});

test('split header recovers interrupted listening without starting speech and destroy cleans all separately mounted nodes',()=>{
 const f=fixture({compact:true}),join=f.query('join'),mic=f.query('open');
 f.change({playbackBlocked:true});assert.equal(join.textContent,'恢复语音');f.fire(join,'click');assert.equal(f.calls.listen,1);assert.deepEqual(f.calls.open,[]);
 f.change({playbackBlocked:false,systemInterrupted:true});assert.equal(join.textContent,'恢复语音');assert.match(f.query('status').textContent,/系统正在占用/);
 f.controls.setAvailable(false);assert.equal(join.disabled,true);assert.equal(mic.disabled,true);assert.equal(f.calls.leave,1);
 f.controls.destroy();f.controls.destroy();for(const id of ['voice','voice-header','voice-microphone','voice-status'])assert.equal(f.doc.getElementById(id).children.length,0);
 f.fire(mic,'click');f.fire(join,'click');assert.deepEqual(f.calls.open,[]);assert.equal(f.calls.join,0);assert.equal(f.calls.destroy,1);
});

test('joining is explicit and listen-only; a disabled hold cannot turn a late join into speaking',()=>{
  const f=fixture({joined:false});try{assert(f.query('talk').disabled&&f.query('open').disabled);
    f.fire(f.query('talk'),'pointerdown',{button:0,pointerId:1});f.fire(f.query('talk'),'pointerup',{pointerId:1});
    assert.equal(f.calls.press,0);f.fire(f.query('join'),'click');assert.equal(f.calls.join,1);assert.equal(f.voice.state().mode,'off');
    assert.equal(f.calls.press,0);assert.deepEqual(f.calls.open,[]);assert.equal(f.query('talk').disabled,false);
  }finally{f.controls.destroy();}
});

test('hold releases only its own pointer; canvas pointers and lost capture from another finger are ignored',()=>{
  const f=fixture();try{f.fire(f.query('talk'),'pointerdown',{button:0,pointerId:7});assert.equal(f.calls.press,1);
    f.fire(f.win,'pointerup',{pointerId:8});f.fire(f.query('talk'),'lostpointercapture',{pointerId:8});assert.equal(f.calls.releaseHold,0);
    f.fire(f.win,'pointerup',{pointerId:7});assert.equal(f.calls.releaseHold,1);assert.equal(f.voice.state().mode,'off');
    f.fire(f.query('talk'),'lostpointercapture',{pointerId:7});assert.equal(f.calls.releaseHold,1);
  }finally{f.controls.destroy();}
});

test('switching a live hold to open ignores the old pointer and button blur, while a second click stops open',()=>{
  const f=fixture();try{f.fire(f.query('talk'),'pointerdown',{button:0,pointerId:3});
    f.fire(f.query('open'),'click');assert.equal(f.voice.state().mode,'open');assert.equal(f.query('open').getAttribute('aria-pressed'),'true');
    assert.equal(f.query('talk').disabled,true);f.fire(f.query('talk'),'pointerup',{pointerId:3});f.fire(f.win,'pointerup',{pointerId:3});
    f.fire(f.query('talk'),'blur');assert.equal(f.voice.state().mode,'open');assert.equal(f.calls.press,1);
    f.fire(f.query('open'),'blur');f.fire(f.win,'click');assert.equal(f.voice.state().mode,'open');
    f.fire(f.query('open'),'click');assert.equal(f.voice.state().mode,'off');assert.deepEqual(f.calls.open,[true,false]);
  }finally{f.controls.destroy();}
});

test('open remains cancellable while requesting permission and stale held events cannot reopen it',()=>{
  const f=fixture();try{f.change({mode:'open',mic:'requesting',speaking:false});
    assert.equal(f.query('open').disabled,false);assert.equal(f.query('open').getAttribute('aria-pressed'),'true');
    f.fire(f.query('open'),'click');assert.deepEqual(f.calls.open,[false]);assert.equal(f.query('open').getAttribute('aria-pressed'),'false');
    f.fire(f.query('talk'),'pointerup',{pointerId:1});assert.equal(f.calls.press,0);assert.equal(f.voice.state().mode,'off');
  }finally{f.controls.destroy();}
});

test('keyboard hold ignores repeat/unrelated keyup and mode switching does not let an old key stop open',()=>{
  const f=fixture();try{f.fire(f.query('talk'),'keydown',{key:' ',repeat:false});f.fire(f.query('talk'),'keydown',{key:' ',repeat:true});
    assert.equal(f.calls.press,1);f.fire(f.query('talk'),'keyup',{key:'Enter'});assert.equal(f.voice.state().mode,'hold');
    f.fire(f.query('open'),'click');f.fire(f.query('talk'),'keyup',{key:' '});assert.equal(f.voice.state().mode,'open');
    f.fire(f.query('talk'),'keydown',{key:'Enter',repeat:false});assert.equal(f.calls.press,1);
    f.fire(f.query('open'),'click');f.fire(f.query('talk'),'keydown',{key:'Enter',repeat:false});f.fire(f.query('talk'),'keyup',{key:'Enter'});
    assert.equal(f.calls.press,2);assert.equal(f.voice.state().mode,'off');
  }finally{f.controls.destroy();}
});

test('temporary unavailability leaves once per true-to-false transition, keeps occupancy and disables all speaking',()=>{
  const f=fixture(),children=[...f.controls.element.children];try{f.fire(f.query('open'),'click');f.controls.setAvailable(false);
    assert.equal(f.calls.leave,1);assert.equal(f.voice.state().mode,'off');assert.equal(f.controls.element.hidden,false);
    assert.equal(f.controls.element.getAttribute('aria-disabled'),'true');assert.deepEqual(f.controls.element.children,children);
    for(const mode of ['talk','open','join'])assert.equal(f.query(mode).disabled,true);
    f.controls.setAvailable(false);f.controls.setMembers([]);assert.equal(f.calls.leave,1);
    f.fire(f.query('open'),'click');f.fire(f.query('join'),'click');assert.deepEqual(f.calls.open,[true]);assert.equal(f.calls.join,0);
    f.controls.setAvailable(true);assert.equal(f.query('join').disabled,false);assert.equal(f.query('open').disabled,true);
    f.fire(f.query('join'),'click');assert.equal(f.calls.join,1);assert.equal(f.voice.state().mode,'off');
    f.controls.setAvailable(false);assert.equal(f.calls.leave,2);
  }finally{f.controls.destroy();}
});

test('background clears pointer ownership without switching off continuous speech or leaving the room',()=>{
  const f=fixture();try{f.fire(f.query('talk'),'pointerdown',{button:0,pointerId:1});f.doc.hidden=true;f.fire(f.doc,'visibilitychange');
    f.doc.hidden=false;f.fire(f.query('talk'),'pointerdown',{button:0,pointerId:2});assert.equal(f.calls.press,2);
    f.fire(f.query('open'),'click');f.fire(f.win,'blur');f.doc.hidden=true;f.fire(f.doc,'visibilitychange');
    assert.equal(f.voice.state().mode,'open');assert.equal(f.calls.leave,0);assert.deepEqual(f.calls.open,[true]);
    f.fire(f.win,'pointerup',{pointerId:2});assert.equal(f.voice.state().mode,'open');
  }finally{f.controls.destroy();}
});

test('destroy removes owned controls/listeners so stale input cannot start another audio intent',()=>{
  const f=fixture(),held=f.query('talk'),open=f.query('open');f.controls.destroy();f.controls.destroy();
  assert.equal(f.calls.destroy,1);assert.equal(f.root.children.length,0);
  f.fire(held,'pointerdown',{button:0,pointerId:1});f.fire(open,'click');f.fire(f.win,'pointerup',{pointerId:1});
  assert.equal(f.calls.press,0);assert.deepEqual(f.calls.open,[]);assert.equal(f.calls.releaseHold,0);
});

test('playback recovery keeps its fixed button, exposes blocked listening and never toggles the microphone',()=>{
  const f=fixture(),listen=f.query('listen');try{f.change({playbackBlocked:true,playbackRecovering:true});assert.equal(listen.hidden,false);assert.equal(listen.disabled,true);assert.equal(listen.getAttribute('aria-busy'),'true');
    f.change({playbackRecovering:false});assert.equal(f.query('listen'),listen);assert.equal(listen.disabled,false);f.fire(listen,'click');assert.equal(f.calls.listen,1);assert.deepEqual(f.calls.open,[]);assert.equal(f.calls.press,0);assert.equal(f.calls.leave,0);
  }finally{f.controls.destroy();}
});


test('system capture interruption uses the existing recovery control and never claims an open microphone is speaking',()=>{
  const f=fixture(),listen=f.query('listen'),held=f.query('talk'),open=f.query('open');try{
    f.change({mode:'open',speaking:false,captureInterrupted:true});
    assert.equal(listen.hidden,false);assert.equal(listen.textContent,'恢复语音');
    assert.match(f.query('status').textContent,/麦克风已中断/);assert.doesNotMatch(f.query('status').textContent,/已开启/);
    assert.equal(open.getAttribute('aria-pressed'),'true');assert.equal(f.query('talk'),held);assert.equal(f.query('open'),open);
    f.change({audioRecovering:true});assert.equal(listen.disabled,true);assert.match(f.query('status').textContent,/正在恢复/);
    f.change({audioRecovering:false,systemInterrupted:true});assert.match(f.query('status').textContent,/系统正在占用/);
    f.fire(listen,'click');assert.equal(f.calls.listen,1);assert.equal(f.calls.leave,0);assert.deepEqual(f.calls.open,[]);
  }finally{f.controls.destroy();}
});


test('the original join slot always exposes voice recovery while joined, including undetected silence, without moving nodes',()=>{
 const f=fixture(),join=f.query('join'),panel=f.controls.element,children=[...panel.children];try{
  assert.equal(join.textContent,'恢复语音');assert.equal(join.disabled,false);assert.equal(f.query('listen').hidden,true);
  f.fire(join,'click');assert.equal(f.calls.listen,1);assert.equal(f.calls.join,0);assert.equal(f.calls.leave,0);
  f.change({mode:'open',speaking:true});assert.equal(f.query('join'),join);f.fire(join,'click');assert.equal(f.calls.listen,2);assert.deepEqual(f.calls.open,[]);
  assert.deepEqual([...panel.children],children);f.change({audioRecovering:true});assert.equal(join.disabled,true);
  f.change({joined:false,audioRecovering:false});assert.equal(join.textContent,'加入语音');assert.equal(f.query('join'),join);
 }finally{f.controls.destroy();}
});
