import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomVoice } from './platform/room-voice.mjs';

function deferred() { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function localTrack() {
  const changes=[];let enabled=true;
  const mediaStreamTrack=new EventTarget();mediaStreamTrack.readyState='live';mediaStreamTrack.muted=false;
  Object.defineProperty(mediaStreamTrack,'enabled',{get(){return enabled;},set(value){enabled=value;changes.push(value);}});
  return {mediaStreamTrack,changes,stops:0,muted:false,mute(){this.muted=true;mediaStreamTrack.enabled=false;return Promise.resolve(this);},stop(){this.stops++;mediaStreamTrack.enabled=false;mediaStreamTrack.readyState='ended';},
    interrupt(value){mediaStreamTrack.muted=value;mediaStreamTrack.dispatchEvent(new Event(value?'mute':'unmute'));},
    end(){mediaStreamTrack.readyState='ended';mediaStreamTrack.dispatchEvent(new Event('ended'));}};
}
function fixture({acquire=null,publish=null,connect=null,joinResult=null,playback={},audioSession=null}={}) {
  let now=0,serial=0,creates=0,subscription;const timers=new Map(),rooms=[],tracks=[],events=[],published=[],unpublished=[],signals=[],left=[],audios=[];
  const win=new EventTarget(),doc=new EventTarget();doc.hidden=false;
  win.RTCPeerConnection=function(){};win.navigator={mediaDevices:{getUserMedia(){}},audioSession};
  win.setTimeout=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:now+ms,interval:0});return id;};
  win.setInterval=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:now+ms,interval:ms});return id;};
  win.clearTimeout=win.clearInterval=id=>timers.delete(id);
  doc.body={append(){}};doc.createElement=()=>{const audio=Object.assign(new EventTarget(),{paused:true,ended:false,error:null,muted:false,plays:0,srcObject:null,removed:false,
    async play(){this.plays++;if(playback.pending)await playback.pending.promise;if(playback.fail)throw Error('autoplay blocked');this.paused=false;this.dispatchEvent(new Event('playing'));},
    pause(){this.paused=true;this.dispatchEvent(new Event('pause'));},remove(){this.removed=true;}});if(playback.clock)Object.defineProperty(audio,'currentTime',{get:()=>playback.frozen?0:now/1000});audios.push(audio);return audio;};
  class Room {
    constructor(){this.handlers=new Map();this.remoteParticipants=new Map();this.canPlaybackAudio=true;this.disconnected=0;this.startAudioCalls=0;rooms.push(this);
      this.audioContext=Object.assign(new EventTarget(),{state:'running',resumes:0,async resume(){this.resumes++;if(playback.contextPending)await playback.contextPending.promise;if(playback.contextFail)throw Error('context blocked');this.state='running';this.dispatchEvent(new Event('statechange'));}});
      if(playback.clock)Object.defineProperty(this.audioContext,'currentTime',{get:()=>playback.contextFrozen?0:now/1000});
      this.localParticipant={publishData:(bytes,options)=>{signals.push({value:bytes[0],options});return Promise.resolve();},
        publishTrack:async(track,options)=>{published.push({track,options,enabledAtPublish:track.mediaStreamTrack.enabled});if(publish)await publish(track,this);},
        unpublishTrack:async track=>{unpublished.push({track,room:this});}};}
    on(name,fn){this.handlers.set(name,fn);return this;}removeAllListeners(){this.handlers.clear();}
    emit(name,...args){this.handlers.get(name)?.(...args);}async connect(){if(connect)await connect(this);}
    async disconnect(){this.disconnected++;}async startAudio(){this.startAudioCalls++;}
  }
  const sdk={Room,RoomEvent:Object.fromEntries(['ParticipantConnected','ParticipantDisconnected','TrackSubscribed','TrackUnsubscribed','DataReceived','Disconnected','Reconnecting','AudioPlaybackStatusChanged'].map(name=>[name,name])),
    Track:{Kind:{Audio:'audio'},Source:{Microphone:'microphone'}},AudioPresets:{speech:{preset:'speech'}},
    async createLocalAudioTrack(){creates++;const track=acquire?await acquire(creates):localTrack();tracks.push(track);return track;}};
  const transport={async join(){return joinResult?await joinResult():{id:'voice-'+rooms.length,url:'wss://voice.test',token:'synthetic'};},async leave(value){left.push(value);},subscribe(fn){subscription=fn;return()=>{subscription=null;};}};
  const voice=createRoomVoice({sdk,transport,window:win,document:doc,onChange:value=>events.push(value)});
  return {voice,win,doc,rooms,tracks,events,published,unpublished,signals,left,timers,sdk,audios,playback,creates:()=>creates,
    async remote(playerId='p2'){const room=rooms.at(-1),participant={identity:'remote-'+playerId,metadata:JSON.stringify({playerId})};room.remoteParticipants.set(participant.identity,participant);room.emit('ParticipantConnected');const remote={kind:'audio',attach(audio){this.attaches=(this.attaches??0)+1;this.audio=audio;audio.srcObject={live:true};if(playback.thawOnReattach&&this.attaches>1)playback.frozen=false;},detach(){return[this.audio];}};room.emit('TrackSubscribed',remote,{},participant);await settle();return{remote,audio:remote.audio,participant};},
    closed(){subscription?.({kind:'closed',target:voice.state().joined?'voice-'+rooms.length:null});},
    advance(ms){const end=now+ms;for(;;){const entry=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;const[id,t]=entry;now=t.at;if(t.interval)t.at+=t.interval;else timers.delete(id);t.fn();}now=end;},
    hide(){doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));}};
}

test('joining is listen-only and speaking before/while joining never enables a late microphone',async()=>{
  const connected=deferred(),f=fixture({connect:()=>connected.promise});
  try{assert.equal(await f.voice.press(),false);const joining=f.voice.join();await settle();assert.equal(f.voice.state().joining,true);
    assert.equal(await f.voice.setOpen(true),false);f.voice.release();connected.resolve();await joining;
    assert.equal(f.voice.state().joined,true);assert.equal(f.voice.state().mode,'off');assert.equal(f.creates(),0);assert.equal(f.published.length,0);
  }finally{f.voice.destroy();}
});

test('hold publishes disabled, stops on release, and retains its existing thirty-second limit',async()=>{
  const f=fixture();try{await f.voice.join();assert.equal(await f.voice.press(),true);assert.equal(f.published[0].enabledAtPublish,false);
    assert.equal(f.voice.state().mode,'hold');assert.equal(f.tracks[0].mediaStreamTrack.enabled,true);
    f.advance(30000);assert.equal(f.voice.state().speaking,false);assert.equal(f.voice.state().mode,'off');assert.equal(f.tracks[0].mediaStreamTrack.enabled,false);
    assert.match(f.voice.state().message,/30秒/);assert.equal(f.timers.size,0);assert.equal(f.signals.at(-1).value,0);
    await f.voice.press();f.voice.releaseHold();assert.equal(f.voice.state().mode,'off');assert.equal(f.creates(),1);
  }finally{f.voice.destroy();}
});

test('open microphone survives canvas pointer events and exceeds thirty seconds until explicitly stopped',async()=>{
  const f=fixture();try{await f.voice.join();assert.equal(await f.voice.setOpen(true),true);
    for(const name of ['pointerup','pointercancel','click'])f.win.dispatchEvent(new Event(name));
    f.advance(61000);assert.equal(f.voice.state().mode,'open');assert.equal(f.voice.state().speaking,true);assert.equal(f.tracks[0].mediaStreamTrack.enabled,true);
    assert(f.signals.length>70);assert(f.signals.every(s=>s.value===1&&s.options.topic==='room-ptt-v1'&&s.options.reliable===false));
    assert.equal(await f.voice.press(),false);f.voice.releaseHold();assert.equal(f.voice.state().mode,'open');
    await f.voice.setOpen(false);assert.equal(f.voice.state().speaking,false);assert.equal(f.voice.state().mode,'off');assert.equal(f.timers.size,0);
  }finally{f.voice.destroy();}
});

test('hold-to-open while permission is pending shares one microphone and old release cannot cancel open',async()=>{
  const permission=deferred(),track=localTrack(),f=fixture({acquire:()=>permission.promise});
  try{await f.voice.join();const held=f.voice.press();assert.equal(f.voice.state().mode,'hold');
    const opened=f.voice.setOpen(true);f.voice.releaseHold();assert.equal(f.voice.state().mode,'open');assert.equal(f.creates(),1);
    permission.resolve(track);assert.equal(await held,false);assert.equal(await opened,true);
    assert.equal(f.published.length,1);assert.equal(track.changes.filter(Boolean).length,1);assert.equal(f.timers.size,1);
    await f.voice.setOpen(false);assert.equal(track.mediaStreamTrack.enabled,false);
  }finally{f.voice.destroy();}
});

for(const start of ['hold','open'])for(const stop of ['release','blur','hidden','disconnect','closed','leave','destroy']){
  test(`${start}: ${stop} invalidates a pending permission and emits off without any late audio`,async()=>{
    const permission=deferred(),track=localTrack(),f=fixture({acquire:()=>permission.promise});
    try{await f.voice.join();const pending=start==='hold'?f.voice.press():f.voice.setOpen(true);assert.equal(f.voice.state().mic,'requesting');
      if(stop==='release')f.voice.release();else if(stop==='blur')f.win.dispatchEvent(new Event('blur'));else if(stop==='hidden')f.hide();
      else if(stop==='disconnect')f.rooms[0].emit('Disconnected');else if(stop==='closed')f.closed();else if(stop==='leave')f.voice.leave();else f.voice.destroy();
      assert.equal(f.voice.state().mode,'off');permission.resolve(track);assert.equal(await pending,false);
      assert.equal(track.mediaStreamTrack.enabled,false);assert.equal(track.changes.includes(true),false);assert.equal(f.timers.size,0);
      assert.equal(f.events.at(-1).mode,'off');
      if(stop==='blur'||stop==='hidden'){assert.equal(f.voice.state().joined,true);assert.equal(f.left.length,0);}
    }finally{f.voice.destroy();}
  });
}

for(const stop of ['release','blur','leave','hidden'])test(`a late publish after ${stop} remains disabled`,async()=>{
  const published=deferred(),f=fixture({publish:()=>published.promise});
  try{await f.voice.join();const pending=f.voice.setOpen(true);await settle();assert.equal(f.published.length,1);assert.equal(f.published[0].enabledAtPublish,false);
    if(stop==='release')await f.voice.setOpen(false);else if(stop==='blur')f.win.dispatchEvent(new Event('blur'));else if(stop==='leave')f.voice.leave();else f.hide();
    published.resolve();assert.equal(await pending,false);assert.equal(f.tracks[0].mediaStreamTrack.enabled,false);assert.equal(f.tracks[0].changes.includes(true),false);
    assert.equal(f.voice.state().mode,'off');assert.equal(f.timers.size,0);
  }finally{f.voice.destroy();}
});

test('permission denial and publishing failure stop intent and keep listening available; a retry creates one fresh track',async()=>{
  for(const kind of ['permission','publish']){
    let attempts=0;const first=localTrack(),f=fixture({acquire:async()=>{if(kind==='permission'&&attempts++===0)throw Object.assign(Error('denied'),{name:'NotAllowedError'});return attempts++===0?first:localTrack();},
      publish:async()=>{if(kind==='publish'&&attempts===1)throw Error('publish failed');}});
    try{await f.voice.join();assert.equal(await f.voice.setOpen(true),false);assert.equal(f.voice.state().joined,true);assert.equal(f.voice.state().mode,'off');assert.equal(f.voice.state().speaking,false);
      assert.equal(f.voice.state().mic,kind==='permission'?'denied':'prompt');assert.equal(f.timers.size,0);
      if(kind==='publish')assert(first.stops>0);
      assert.equal(await f.voice.setOpen(true),true);assert.equal(f.creates(),2);assert.equal(f.voice.state().speaking,true);
    }finally{f.voice.destroy();}
  }
});

test('an old connection/publish completion cannot mute, clear or enable a new connection track',async()=>{
  const oldPublish=deferred(),newPermission=deferred(),oldTrack=localTrack(),newTrack=localTrack();
  const f=fixture({acquire:count=>count===1?oldTrack:newPermission.promise,publish:(_,room)=>room===f.rooms[0]?oldPublish.promise:Promise.resolve()});
  try{await f.voice.join();const old=f.voice.setOpen(true);await settle();f.voice.leave();await f.voice.join();const fresh=f.voice.setOpen(true);
    oldPublish.resolve();assert.equal(await old,false);newPermission.resolve(newTrack);assert.equal(await fresh,true);
    assert.equal(oldTrack.mediaStreamTrack.enabled,false);assert.equal(newTrack.mediaStreamTrack.enabled,true);assert.equal(f.voice.state().mode,'open');assert.equal(f.creates(),2);
  }finally{f.voice.destroy();}
});

// The user now requires established continuous speech/listening to survive PC
// window switching and backgrounding. Pending permission remains fail-closed.
test('active open keeps its microphone and listening connection through blur/hidden and return',async()=>{
  const f=fixture();try{await f.voice.join();await f.voice.setOpen(true);const room=f.rooms[0],track=f.tracks[0];
    f.win.dispatchEvent(new Event('blur'));f.hide();f.advance(61000);
    assert.equal(f.voice.state().joined,true);assert.equal(f.voice.state().mode,'open');assert.equal(f.voice.state().speaking,true);
    assert.equal(track.mediaStreamTrack.enabled,true);assert.equal(room.disconnected,0);assert.equal(f.left.length,0);assert.equal(f.creates(),1);
    f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));f.win.dispatchEvent(new Event('focus'));
    await settle();assert.equal(f.voice.state().speaking,true);assert.equal(f.timers.size,1);
    await f.voice.setOpen(false);assert.equal(track.mediaStreamTrack.enabled,false);
  }finally{f.voice.destroy();}
});

test('background stops a held gesture but retains listening without reviving speech on return',async()=>{
  for(const event of ['blur','hidden']){const f=fixture();try{await f.voice.join();await f.voice.press();
    if(event==='blur')f.win.dispatchEvent(new Event('blur'));else f.hide();
    assert.equal(f.voice.state().joined,true);assert.equal(f.voice.state().mode,'off');assert.equal(f.voice.state().speaking,false);
    assert.equal(f.tracks[0].mediaStreamTrack.enabled,false);assert.equal(f.rooms[0].disconnected,0);assert.equal(f.left.length,0);assert.equal(f.timers.size,0);
    f.doc.hidden=false;f.win.dispatchEvent(new Event('focus'));assert.equal(f.voice.state().speaking,false);
  }finally{f.voice.destroy();}}
});

test('listen-only background retains its room and cannot start a new hidden microphone',async()=>{
  const f=fixture();try{await f.voice.join();f.win.dispatchEvent(new Event('blur'));f.hide();
    assert.equal(f.voice.state().joined,true);assert.equal(await f.voice.setOpen(true),false);assert.equal(await f.voice.press(),false);
    assert.equal(f.creates(),0);assert.equal(f.left.length,0);assert.equal(f.rooms[0].disconnected,0);
  }finally{f.voice.destroy();}
});

test('page exit/disconnect/revocation force-stops open and cannot revive on a new join',async()=>{
  for(const stop of ['pagehide','disconnect','closed','leave']){
    const f=fixture();try{await f.voice.join();await f.voice.setOpen(true);
      if(stop==='pagehide')f.win.dispatchEvent(new Event(stop));else if(stop==='disconnect')f.rooms[0].emit('Reconnecting');else if(stop==='closed')f.closed();else f.voice.leave();
      assert.equal(f.tracks[0].mediaStreamTrack.enabled,false);assert.equal(f.voice.state().mode,'off');assert.equal(f.timers.size,0);
      f.doc.hidden=false;f.win.dispatchEvent(new Event('focus'));if(!f.voice.state().joined)await f.voice.join();
      assert.equal(f.voice.state().speaking,false);assert.equal(f.voice.state().mode,'off');
    }finally{f.voice.destroy();}
  }
});

test('an ended active microphone clears speech and the next gesture creates a fresh track in the same room',async()=>{
  const f=fixture();try{await f.voice.join();await f.voice.setOpen(true);const old=f.tracks[0],room=f.rooms[0];old.end();await settle();
    assert.equal(f.voice.state().joined,true);assert.equal(f.voice.state().speaking,false);assert.equal(f.voice.state().mode,'off');assert.equal(f.voice.state().mic,'prompt');
    assert.equal(old.mediaStreamTrack.enabled,false);assert.equal(old.muted,true);assert.equal(f.signals.at(-1).value,0);assert.equal(f.timers.size,0);assert.deepEqual(f.unpublished,[{track:old,room}]);
    assert.equal(await f.voice.setOpen(true),true);assert.equal(f.creates(),2);assert.equal(f.rooms.length,1);assert.equal(f.tracks[1].mediaStreamTrack.enabled,true);
    old.end();assert.equal(f.voice.state().speaking,true);assert.equal(f.tracks[1].mediaStreamTrack.enabled,true);
  }finally{f.voice.destroy();}
});

test('old-session ended notifications cannot silence or unpublish a replacement connection',async()=>{
  const f=fixture();try{await f.voice.join();await f.voice.setOpen(true);const old=f.tracks[0];f.voice.leave();await f.voice.join();await f.voice.setOpen(true);
    old.end();assert.equal(f.voice.state().mode,'open');assert.equal(f.voice.state().speaking,true);assert.equal(f.tracks[1].mediaStreamTrack.enabled,true);assert.equal(f.unpublished.length,0);
  }finally{f.voice.destroy();}
});

test('a microphone ending during publish never enables late audio and permits a fresh gesture',async()=>{
  const publishing=deferred(),f=fixture({publish:(_,room)=>f.rooms[0]===room&&f.published.length===1?publishing.promise:Promise.resolve()});
  try{await f.voice.join();const pending=f.voice.setOpen(true);await settle();const old=f.tracks[0];old.end();publishing.resolve();assert.equal(await pending,false);
    assert.equal(old.changes.includes(true),false);assert.equal(f.voice.state().mode,'off');assert.equal(await f.voice.press(),true);assert.equal(f.creates(),2);
  }finally{f.voice.destroy();}
});

test('remote status protocol and per-person mute stay compatible while continuous mode is active',async()=>{
  const f=fixture();try{await f.voice.join();const room=f.rooms[0];
    room.remoteParticipants.set('peer',{identity:'peer',metadata:JSON.stringify({playerId:'p2'})});room.emit('ParticipantConnected');
    await f.voice.setOpen(true);room.emit('DataReceived',new Uint8Array([1]),{identity:'peer'},null,'room-ptt-v1');
    assert.equal(f.voice.state().peers[0].speaking,true);f.voice.mute('p2',true);assert.equal(f.voice.state().peers[0].muted,true);
    f.advance(2200);assert.equal(f.voice.state().peers[0].speaking,false);assert.equal(f.voice.state().speaking,true);
    assert.throws(()=>f.voice.setOpen('yes'),/boolean/);
  }finally{f.voice.destroy();}
});

test('a paused existing remote output recovers without replacing its room, microphone or audio element',async()=>{
  const f=fixture();try{await f.voice.join();const {audio}=await f.remote();await f.voice.setOpen(true);const room=f.voice.room,track=f.tracks[0],context=room.audioContext,plays=audio.plays;
    audio.pause();await settle();assert.equal(audio.paused,false);assert.equal(audio.plays,plays+1);assert.equal(f.voice.state().playbackBlocked,false);
    assert.equal(f.voice.room,room);assert.equal(room.audioContext,context);assert.equal(room.startAudioCalls,1);assert.equal(f.creates(),1);assert.equal(track.mediaStreamTrack.enabled,true);assert.equal(f.audios.length,1);
  }finally{f.voice.destroy();}
});

test('returning checks actual HTML output even while the SDK still says playback is enabled',async()=>{
  const f=fixture();try{await f.voice.join();const {audio}=await f.remote(),room=f.voice.room;f.hide();audio.pause();await settle();
    assert.equal(room.canPlaybackAudio,true);assert.equal(audio.paused,true);assert.equal(f.voice.state().playbackBlocked,true);assert.equal(f.voice.state().joined,true);
    f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));f.win.dispatchEvent(new Event('focus'));await settle();
    assert.equal(audio.paused,false);assert.equal(f.voice.state().playbackBlocked,false);assert.equal(f.voice.room,room);assert.equal(f.rooms.length,1);assert.equal(f.creates(),0);
  }finally{f.voice.destroy();}
});

test('an interrupted existing receive context resumes once without changing continuous speech',async()=>{
  const f=fixture();try{await f.voice.join();const {audio}=await f.remote();await f.voice.setOpen(true);const context=f.voice.room.audioContext;
    context.state='interrupted';context.dispatchEvent(new Event('statechange'));await settle();
    assert.equal(context.state,'running');assert.equal(context.resumes,1);assert.equal(audio.paused,false);assert.equal(f.voice.state().mode,'open');assert.equal(f.voice.state().speaking,true);assert.equal(f.creates(),1);
  }finally{f.voice.destroy();}
});

test('denied output recovery stays connected and exposes a manual retry without repeated automatic attempts',async()=>{
  const f=fixture();try{await f.voice.join();const {audio}=await f.remote();f.playback.fail=true;audio.pause();await settle();const plays=audio.plays;
    assert.equal(f.voice.state().joined,true);assert.equal(f.voice.state().playbackBlocked,true);assert.equal(f.voice.state().playbackRecovering,false);
    audio.dispatchEvent(new Event('error'));await settle();assert.equal(audio.plays,plays);
    f.playback.fail=false;assert.equal(await f.voice.resumePlayback(),true);assert.equal(audio.paused,false);assert.equal(f.voice.state().playbackBlocked,false);assert.equal(f.rooms.length,1);assert.equal(f.creates(),0);
  }finally{f.voice.destroy();}
});

test('receive recovery never unmutes or restarts a deliberately muted peer element',async()=>{
  const f=fixture();try{await f.voice.join();const first=await f.remote('p2'),second=await f.remote('p3');f.voice.mute('p2',true);const plays=first.audio.plays;
    first.audio.pause();second.audio.pause();await settle();assert.equal(first.audio.muted,true);assert.equal(first.audio.paused,true);assert.equal(first.audio.plays,plays);assert.equal(second.audio.paused,false);
    assert.equal(await f.voice.resumePlayback(),true);assert.equal(first.audio.muted,true);assert.equal(first.audio.plays,plays);assert.equal(f.voice.room.startAudioCalls,1);
  }finally{f.voice.destroy();}
});

test('a hanging receive resume times out, while a retired completion cannot change a later room',async()=>{
  const pending=deferred(),f=fixture();try{await f.voice.join();const {audio}=await f.remote();f.playback.pending=pending;audio.pause();assert.equal(f.voice.state().playbackRecovering,true);
    f.advance(1000);assert.equal(f.voice.state().playbackRecovering,false);assert.equal(f.voice.state().playbackBlocked,true);
    f.voice.leave();f.playback.pending=null;await f.voice.join();const room=f.voice.room;pending.resolve();await settle();assert.equal(f.voice.room,room);assert.equal(f.voice.state().playbackBlocked,false);assert.equal(audio.srcObject,null);assert.equal(audio.removed,true);assert.equal(f.creates(),0);
  }finally{f.voice.destroy();}
});

test('manual listening recovery resumes an existing denied context even before any remote track arrives',async()=>{
  const f=fixture();try{await f.voice.join();const room=f.voice.room;room.canPlaybackAudio=false;room.audioContext.state='suspended';
    assert.equal(await f.voice.resumePlayback(),true);assert.equal(room.audioContext.state,'running');assert.equal(f.voice.state().playbackBlocked,false);assert.equal(f.voice.room,room);assert.equal(room.startAudioCalls,1);assert.equal(f.creates(),0);
  }finally{f.voice.destroy();}
});

test('explicitly unmuting a paused peer restores that existing output without creating a microphone',async()=>{
  const f=fixture();try{await f.voice.join();const {audio}=await f.remote();f.voice.mute('p2',true);audio.pause();await settle();assert.equal(audio.paused,true);const room=f.voice.room;
    f.voice.mute('p2',false);await settle();assert.equal(audio.muted,false);assert.equal(audio.paused,false);assert.equal(f.voice.room,room);assert.equal(f.creates(),0);
  }finally{f.voice.destroy();}
});

test('foreground gets one existing-output recovery after an unfocused interruption was rejected',async()=>{
  const f=fixture();try{await f.voice.join();const {audio}=await f.remote();await f.voice.setOpen(true);const room=f.voice.room,track=f.tracks[0],context=room.audioContext;
    f.win.dispatchEvent(new Event('blur'));f.playback.fail=true;audio.pause();await settle();const interruptedPlays=audio.plays;
    assert.equal(audio.paused,true);assert.equal(f.voice.state().playbackBlocked,true);
    f.playback.fail=false;f.win.dispatchEvent(new Event('focus'));await settle();
    assert.equal(audio.plays,interruptedPlays+1);assert.equal(audio.paused,false);assert.equal(f.voice.state().playbackBlocked,false);
    f.win.dispatchEvent(new Event('pageshow'));f.win.dispatchEvent(new Event('focus'));await settle();assert.equal(audio.plays,interruptedPlays+1);
    assert.equal(f.voice.room,room);assert.equal(room.audioContext,context);assert.equal(room.startAudioCalls,1);assert.equal(f.creates(),1);assert.equal(track.mediaStreamTrack.enabled,true);assert.equal(f.voice.state().mode,'open');
  }finally{f.voice.destroy();}
});

test('a failed foreground retry is not repeated by duplicate return events or ordinary output errors',async()=>{
  const f=fixture();try{await f.voice.join();const {audio}=await f.remote();f.win.dispatchEvent(new Event('blur'));f.playback.fail=true;audio.pause();await settle();
    const interruptedPlays=audio.plays;f.win.dispatchEvent(new Event('focus'));await settle();assert.equal(audio.plays,interruptedPlays+1);
    f.win.dispatchEvent(new Event('focus'));f.win.dispatchEvent(new Event('pageshow'));audio.dispatchEvent(new Event('error'));await settle();assert.equal(audio.plays,interruptedPlays+1);
    assert.equal(f.voice.state().playbackBlocked,true);assert.equal(f.voice.state().joined,true);assert.equal(f.voice.state().playbackRecovering,false);
    f.playback.fail=false;f.win.dispatchEvent(new Event('focus'));await settle();assert.equal(audio.plays,interruptedPlays+1);
    f.win.dispatchEvent(new Event('blur'));f.win.dispatchEvent(new Event('focus'));await settle();assert.equal(audio.plays,interruptedPlays+2);assert.equal(audio.paused,false);assert.equal(f.rooms.length,1);assert.equal(f.creates(),0);
  }finally{f.voice.destroy();}
});


async function finishRecovery(f,promise){for(let i=0;i<8;i++){await settle();f.advance(180);}await settle();return promise;}

test('raw mute stops actual open speech while retaining established intent; same-track unmute alone can resume it',async()=>{
 const f=fixture();try{await f.voice.join();await f.voice.setOpen(true);const raw=f.tracks[0],room=f.voice.room;
  raw.interrupt(true);assert.equal(f.voice.state().mode,'open');assert.equal(f.voice.state().speaking,false);assert.equal(f.voice.state().captureInterrupted,true);
  assert.equal(raw.mediaStreamTrack.enabled,false);assert.equal(f.signals.at(-1).value,0);assert.equal(f.timers.size,0);
  f.win.dispatchEvent(new Event('blur'));f.hide();f.advance(60000);assert.equal(f.voice.state().mode,'open');assert.equal(f.creates(),1);assert.equal(f.voice.room,room);
  raw.interrupt(false);assert.equal(f.voice.state().speaking,true);assert.equal(raw.mediaStreamTrack.enabled,true);assert.equal(f.creates(),1);
 }finally{f.voice.destroy();}
});

test('raw mute ends a hold and neither unmute nor focus revives the released gesture',async()=>{
 const f=fixture();try{await f.voice.join();await f.voice.press();f.tracks[0].interrupt(true);
  assert.equal(f.voice.state().mode,'off');assert.equal(f.voice.state().speaking,false);assert.equal(f.timers.size,0);
  f.tracks[0].interrupt(false);f.win.dispatchEvent(new Event('focus'));await settle();
  assert.equal(f.tracks[0].mediaStreamTrack.enabled,false);assert.equal(f.voice.state().speaking,false);assert.equal(f.creates(),1);
 }finally{f.voice.destroy();}
});

test('raw unmute during or after first pending publish cannot create established open intent',async()=>{
 const pending=deferred(),f=fixture({publish:()=>pending.promise});try{await f.voice.join();const started=f.voice.setOpen(true);await settle();
  const raw=f.tracks[0];raw.interrupt(true);raw.interrupt(false);pending.resolve();assert.equal(await started,false);
  assert.equal(f.voice.state().mode,'off');assert.equal(raw.changes.includes(true),false);
 }finally{f.voice.destroy();}
});

test('audio-session interruption never loops capture or auto-resumes a held gesture',async()=>{
 const session=Object.assign(new EventTarget(),{state:'active'}),f=fixture({audioSession:session});try{
  await f.voice.join();await f.voice.setOpen(true);session.state='interrupted';session.dispatchEvent(new Event('statechange'));
  assert.equal(f.voice.state().systemInterrupted,true);assert.equal(f.voice.state().speaking,false);assert.equal(f.voice.state().mode,'open');
  for(let i=0;i<4;i++){assert.equal(await f.voice.resumeAudio(),false);f.win.dispatchEvent(new Event('focus'));}
  assert.equal(f.creates(),1);assert.equal(f.voice.room.startAudioCalls,1);
  session.state='active';session.dispatchEvent(new Event('statechange'));await settle();assert.equal(f.voice.state().speaking,true);assert.equal(f.creates(),1);
  await f.voice.setOpen(false);await f.voice.press();session.state='interrupted';session.dispatchEvent(new Event('statechange'));
  session.state='active';session.dispatchEvent(new Event('statechange'));await settle();assert.equal(f.voice.state().mode,'off');assert.equal(f.voice.state().speaking,false);
 }finally{f.voice.destroy();}
});

test('explicit voice recovery replaces a stuck raw microphone disabled within its existing room and preserves muted peers',async()=>{
 const f=fixture({playback:{clock:true}});try{await f.voice.join();const silent=await f.remote('p2'),audible=await f.remote('p3');f.voice.mute('p2',true);
  await f.voice.setOpen(true);const room=f.voice.room,old=f.tracks[0];old.interrupt(true);
  const recovering=f.voice.resumeAudio(),same=f.voice.resumeAudio();assert.equal(recovering,same);assert.equal(f.creates(),2);
  assert.equal(await finishRecovery(f,recovering),true);
  assert.equal(f.voice.room,room);assert.equal(f.rooms.length,1);assert.equal(f.voice.state().mode,'open');assert.equal(f.voice.state().speaking,true);
  assert.equal(old.mediaStreamTrack.enabled,false);assert(old.stops>0);assert.equal(f.published[1].enabledAtPublish,false);assert.equal(f.tracks[1].mediaStreamTrack.enabled,true);
  assert.equal(f.unpublished[0].track,old);assert.equal(silent.audio.muted,true);assert.equal(audible.audio.muted,false);assert.equal(room.startAudioCalls,1);
  old.interrupt(false);old.end();assert.equal(f.tracks[1].mediaStreamTrack.enabled,true);
 }finally{f.voice.destroy();}
});

for(const stop of ['off','blur','hidden','pagehide','disconnect','new-room'])test(`explicit capture repair cannot late-enable after ${stop}`,async()=>{
 const permission=deferred(),replacement=localTrack(),f=fixture({acquire:n=>n===1?localTrack():permission.promise});try{
  await f.voice.join();await f.voice.setOpen(true);f.tracks[0].interrupt(true);const repairing=f.voice.resumeAudio();await settle();assert.equal(f.creates(),2);
  if(stop==='off')await f.voice.setOpen(false);else if(stop==='blur')f.win.dispatchEvent(new Event('blur'));else if(stop==='hidden')f.hide();
  else if(stop==='pagehide')f.win.dispatchEvent(new Event('pagehide'));else if(stop==='disconnect')f.rooms[0].emit('Disconnected');
  else{f.voice.leave();await f.voice.join();}
  permission.resolve(replacement);assert.equal(await finishRecovery(f,repairing),false);assert.equal(replacement.changes.includes(true),false);assert(replacement.stops>0);
  assert.equal(f.published.length,1);assert.equal(f.voice.state().speaking,false);
 }finally{f.voice.destroy();}
});

test('explicit recovery refuses frozen output clocks despite SDK enabled/play success, and makes only one local reattachment',async()=>{
 const f=fixture({playback:{clock:true,frozen:true,contextFrozen:true}});try{await f.voice.join();const {remote}=await f.remote();
  assert.equal(f.voice.room.canPlaybackAudio,true);assert.equal(await finishRecovery(f,f.voice.resumeAudio()),false);
  assert.equal(remote.attaches,2);assert.equal(f.voice.state().playbackBlocked,true);assert.equal(f.creates(),0);
  const attaches=remote.attaches;f.advance(10000);await settle();assert.equal(remote.attaches,attaches);
 }finally{f.voice.destroy();}
});

test('same remote-track reattachment can repair a frozen HTML output without replacing its element, room or peer mute',async()=>{
 const f=fixture({playback:{clock:true,frozen:true,thawOnReattach:true}});try{await f.voice.join();const {remote,audio}=await f.remote(),room=f.voice.room;
  assert.equal(await finishRecovery(f,f.voice.resumeAudio()),true);assert.equal(remote.attaches,2);assert.equal(f.audios.length,1);assert.equal(f.audios[0],audio);
  assert.equal(f.voice.room,room);assert.equal(room.startAudioCalls,1);assert.equal(f.voice.state().playbackBlocked,false);assert.equal(f.creates(),0);
 }finally{f.voice.destroy();}
});

test('listen-only recovery and a stopped open intent never request a microphone',async()=>{
 const f=fixture({playback:{clock:true}});try{await f.voice.join();await f.remote();assert.equal(await finishRecovery(f,f.voice.resumeAudio()),true);assert.equal(f.creates(),0);
  await f.voice.setOpen(true);f.tracks[0].interrupt(true);await f.voice.setOpen(false);assert.equal(await finishRecovery(f,f.voice.resumeAudio()),true);assert.equal(f.creates(),1);assert.equal(f.tracks[0].mediaStreamTrack.enabled,false);
 }finally{f.voice.destroy();}
});


test('an explicit repair upgrades an already pending output retry to clock verification',async()=>{
 const pending=deferred(),f=fixture({playback:{clock:true,frozen:true,contextFrozen:true}});try{await f.voice.join();await f.remote();
  f.playback.pending=pending;f.audios[0].pause();assert.equal(f.voice.state().playbackRecovering,true);
  const recovery=f.voice.resumeAudio();pending.resolve();assert.equal(await finishRecovery(f,recovery),false);assert.equal(f.voice.state().playbackBlocked,true);
 }finally{f.voice.destroy();}
});

test('a late SDK playback helper cannot override an individually muted peer',async()=>{
 const f=fixture();try{await f.voice.join();const {audio}=await f.remote('p2');f.voice.mute('p2',true);
  audio.muted=false;audio.dispatchEvent(new Event('volumechange'));assert.equal(audio.muted,true);
  f.voice.mute('p2',false);assert.equal(audio.muted,false);
 }finally{f.voice.destroy();}
});

test('repair publication completion after an audio-session interruption cannot resume open speech',async()=>{
 const session=Object.assign(new EventTarget(),{state:'active'}),publishing=deferred(),f=fixture({audioSession:session,publish:(_,r)=>f.published.length===2?publishing.promise:Promise.resolve()});
 try{await f.voice.join();await f.voice.setOpen(true);f.tracks[0].interrupt(true);const repaired=f.voice.resumeAudio();await settle();
  assert.equal(f.published.length,2);session.state='interrupted';session.dispatchEvent(new Event('statechange'));
  session.state='active';session.dispatchEvent(new Event('statechange'));publishing.resolve();assert.equal(await finishRecovery(f,repaired),false);
  assert.equal(f.tracks[1].changes.includes(true),false);assert.equal(f.voice.state().speaking,false);
 }finally{f.voice.destroy();}
});


test('starting either speaking mode during a known system interruption never requests capture',async()=>{
 const session=Object.assign(new EventTarget(),{state:'interrupted'}),f=fixture({audioSession:session});try{await f.voice.join();
  for(let i=0;i<3;i++){assert.equal(await f.voice.press(),false);assert.equal(await f.voice.setOpen(true),false);}
  assert.equal(f.creates(),0);assert.equal(f.voice.state().mode,'off');assert.equal(f.voice.state().speaking,false);
 }finally{f.voice.destroy();}
});


test('ending a reported system interruption checks real output clocks before clearing the recovery action',async()=>{
 const session=Object.assign(new EventTarget(),{state:'active'}),f=fixture({audioSession:session,playback:{clock:true,frozen:true,contextFrozen:true}});
 try{await f.voice.join();await f.remote();session.state='interrupted';session.dispatchEvent(new Event('statechange'));
  session.state='active';session.dispatchEvent(new Event('statechange'));await settle();f.advance(180);await settle();
  assert.equal(f.voice.state().systemInterrupted,false);assert.equal(f.voice.state().playbackBlocked,true);assert.equal(f.creates(),0);
 }finally{f.voice.destroy();}
});


test('explicit open recovery refreshes capture even if silence produced no raw/session interruption event',async()=>{
 const f=fixture({playback:{clock:true}});try{await f.voice.join();await f.remote();await f.voice.setOpen(true);const room=f.voice.room,old=f.tracks[0];
  assert.equal(old.mediaStreamTrack.readyState,'live');assert.equal(old.mediaStreamTrack.muted,false);assert.equal(f.voice.state().captureInterrupted,false);
  assert.equal(await finishRecovery(f,f.voice.resumeAudio()),true);assert.equal(f.creates(),2);assert.equal(old.mediaStreamTrack.readyState,'ended');
  assert.equal(f.voice.room,room);assert.equal(f.published[1].enabledAtPublish,false);assert.equal(f.tracks[1].mediaStreamTrack.enabled,true);
 }finally{f.voice.destroy();}
});

test('old raw ended during replacement permission cannot cancel its established open gesture',async()=>{
 const permission=deferred(),f=fixture({acquire:n=>n===1?localTrack():permission.promise});try{await f.voice.join();await f.voice.setOpen(true);
  const old=f.tracks[0],repair=f.voice.resumeAudio();old.end();assert.equal(f.voice.state().mode,'open');assert.equal(f.voice.state().speaking,false);
  permission.resolve(localTrack());assert.equal(await finishRecovery(f,repair),true);assert.equal(f.voice.state().speaking,true);assert.equal(f.creates(),2);
 }finally{f.voice.destroy();}
});

for(const stop of ['off','blur','hidden','pagehide','disconnect'])test(`replacement publication after ${stop} cannot enable late audio or falsely report active speech`,async()=>{
 const published=deferred(),f=fixture({publish:()=>f.published.length===2?published.promise:Promise.resolve()});try{await f.voice.join();await f.voice.setOpen(true);const repair=f.voice.resumeAudio();await settle();
  assert.equal(f.published.length,2);const replacement=f.tracks[1];
  if(stop==='off')await f.voice.setOpen(false);else if(stop==='blur')f.win.dispatchEvent(new Event('blur'));else if(stop==='hidden')f.hide();else if(stop==='pagehide')f.win.dispatchEvent(new Event('pagehide'));else f.rooms[0].emit('Disconnected');
  published.resolve();assert.equal(await finishRecovery(f,repair),false);assert.equal(replacement.changes.includes(true),false);assert.equal(f.voice.state().speaking,false);assert(replacement.stops>0);
  if(stop==='blur'||stop==='hidden'){assert.equal(f.voice.state().mode,'open');assert.equal(f.voice.state().captureInterrupted,true);}
 }finally{f.voice.destroy();}
});

test('SDK detaching before unsubscribe still removes only its exact owned output node',async()=>{
 const f=fixture();try{await f.voice.join();const first=await f.remote('p2'),second=await f.remote('p3');
  first.remote.detach=()=>[];first.audio.srcObject=null;f.voice.room.emit('TrackUnsubscribed',first.remote);
  assert.equal(first.audio.removed,true);assert.equal(second.audio.removed,false);assert(second.audio.srcObject);assert.equal(f.voice.state().peers.length,2);
 }finally{f.voice.destroy();}
});


for(const gate of ['capture','mute','unpublish','publish'])test(`explicit repair ${gate} has an eight-second deadline and late work never enables audio`,async()=>{
 const pending=deferred(),replacement=localTrack(),f=fixture({acquire:n=>n===1?localTrack():gate==='capture'?pending.promise:replacement,publish:()=>gate==='publish'&&f.published.length===2?pending.promise:Promise.resolve()});
 try{await f.voice.join();await f.voice.setOpen(true);const old=f.tracks[0];
  if(gate==='mute')old.mute=()=>pending.promise;
  if(gate==='unpublish')f.voice.room.localParticipant.unpublishTrack=async track=>{f.unpublished.push({track,room:f.voice.room});if(track===old)await pending.promise;};
  const repaired=f.voice.resumeAudio();await settle();f.advance(8000);await settle();assert.equal(await repaired,false);
  assert.equal(f.voice.state().audioRecovering,false);assert.equal(f.voice.state().playbackRecovering,false);assert.equal(f.voice.state().speaking,false);
  assert.equal(f.voice.state().mode,'open');assert.equal(f.voice.state().captureInterrupted,true);assert.equal(f.voice.state().mic,'prompt');
  const repeat=f.voice.resumeAudio();assert.equal(await finishRecovery(f,repeat),false);assert.equal(f.creates(),2,'pending capture remains single-flight');
  pending.resolve(gate==='capture'?replacement:undefined);await settle();assert.equal(replacement.changes.includes(true),false);assert(replacement.stops>0);
  assert.equal(f.voice.state().speaking,false);assert.equal(f.voice.state().audioRecovering,false);
 }finally{f.voice.destroy();}
});

test('stopping open cancels a hung repair immediately without waiting for its deadline',async()=>{
 const pending=deferred(),replacement=localTrack(),f=fixture({acquire:n=>n===1?localTrack():pending.promise});try{await f.voice.join();await f.voice.setOpen(true);
  const repaired=f.voice.resumeAudio();await settle();await f.voice.setOpen(false);assert.equal(await repaired,false);assert.equal(f.voice.state().audioRecovering,false);assert.equal(f.voice.state().playbackRecovering,false);assert.equal(f.voice.state().mic,'prompt');
  pending.resolve(replacement);await settle();assert.equal(replacement.changes.includes(true),false);assert(replacement.stops>0);assert.equal(f.voice.state().mode,'off');
 }finally{f.voice.destroy();}
});

test('listen-only system interruption clears capture warning without acquiring a microphone',async()=>{
 const session=Object.assign(new EventTarget(),{state:'active'}),f=fixture({audioSession:session});try{await f.voice.join();session.state='interrupted';session.dispatchEvent(new Event('statechange'));
  assert.equal(f.voice.state().captureInterrupted,false);session.state='active';session.dispatchEvent(new Event('statechange'));
  assert.equal(await finishRecovery(f,f.voice.resumeAudio()),true);assert.equal(f.voice.state().captureInterrupted,false);assert.equal(f.creates(),0);
 }finally{f.voice.destroy();}
});
